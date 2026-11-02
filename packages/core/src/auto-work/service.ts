import {
  AUTO_WORK_SUMMARY_MAX_CHARS,
  type ActorRole, type AutoWorkJudgment, type AutoWorkJudgmentRequest, type AutoWorkJudgmentRunResult, type AutoWorkSignal,
  type AutoWorkSource, type AutoWorkVerdict, type EffectiveAutoWorkConfig, type EffectiveAutoWorkRule,
} from "@owl/shared";
import { createUlid } from "../../../db/dist/index.js";
import { invalidStateTransition } from "../errors.js";
import type { LibrarianSchedulerClock } from "../librarian-scheduler.js";
import { linkBacklogItemsToWorkInTransaction } from "../review-backlog.js";
import { createWorkInTransaction } from "../state-reducer.js";
import type { CommandRequest, CommandResponse, CoreDatabase, CoreWriteLaneTransaction, StartWorkPayload } from "../types.js";
import { AutoWorkJudge } from "./judge.js";
import { evaluateStageOne, type StageOneFacts, type StageOneResult } from "./stage-one.js";
import { insertEventRow, updateEventRow, type AutoWorkEventInput, type AutoWorkEventRecord, type AutoWorkStore } from "./store.js";

export type AutoWorkAlertKind = "auto_work_created" | "auto_work_judge_failed" | "auto_work_start_failed" | "auto_work_github_failed";

export interface AutoWorkServiceDeps {
  readonly db: CoreDatabase;
  readonly store: AutoWorkStore;
  readonly clock?: LibrarianSchedulerClock;
  /** The Project's settings after layering; null while no configuration has been read. */
  readonly config: (projectId: string) => EffectiveAutoWorkConfig | null;
  readonly runner: () => { readonly runAutoWorkJudgment?: (request: AutoWorkJudgmentRequest) => Promise<AutoWorkJudgmentRunResult> };
  readonly roleModel: (role: ActorRole) => { readonly model: string; readonly provider: string; readonly effort: string };
  readonly language: () => "ja" | "en";
  /** The head of the Project's overview note, or null when there is none. */
  readonly projectOverview?: (projectId: string) => Promise<string | null>;
  readonly startWork: (workId: string, request: CommandRequest<StartWorkPayload>) => Promise<CommandResponse<{ work_id: string }>>;
  readonly logger?: Pick<Console, "warn">;
}

interface AutoWorkAlertContext {
  readonly kind: AutoWorkAlertKind;
  readonly signal: AutoWorkSignal;
  readonly dedupeKey: string;
  readonly eventId: string;
  readonly workId: string | null;
  readonly detail: string;
  readonly displayNumber?: number | null;
  readonly ruleId?: string;
  readonly action?: string;
}

export interface AutoWorkReceiveResult {
  readonly verdict: AutoWorkVerdict;
  readonly event_id: string;
  readonly work_id: string | null;
}

/**
 * A part that turns something into signals (design 3.1). The service calls it once per Project, so `projectId` is added to the
 * design's `start`/`reconfigure`: a configuration belongs to one Project and the part could not tell whose it is.
 */
export interface AutoWorkTriggerSource {
  readonly source: AutoWorkSource;
  start(sink: (signal: AutoWorkSignal) => Promise<AutoWorkReceiveResult>, config: EffectiveAutoWorkConfig, projectId: string): void;
  reconfigure(config: EffectiveAutoWorkConfig, projectId: string): void;
  stop(): Promise<void>;
}

/** Returns what the run recorded, so the caller can show exactly those events. */
export type AutoWorkRunNowHandler = (projectId: string) => Promise<readonly AutoWorkReceiveResult[]>;
/** The GitHub login that `@me` stands for; null when it could not be resolved. */
export type AutoWorkGithubLoginResolver = (projectId: string) => string | null;
/** Tells the source that finished Work; the PR it found is kept on the event. Throws when the source could not be told. */
export type AutoWorkFinishedHandler = (event: AutoWorkEventRecord, state: string) => Promise<{ readonly github_pr_url?: string | null } | void>;
/** Tells the source that a Work was made from its item; returns where it said so (the comment URL), or null. */
export type AutoWorkCreatedHandler = (context: {
  readonly signal: AutoWorkSignal; readonly work_id: string; readonly display_number: number | null; readonly title: string; readonly started: boolean;
}) => Promise<string | null>;

const OPEN_WORK_STATES = ["memo", "ready", "running", "paused", "judgement_waiting"] as const;
/** How much of an open Work's summary the judgment sees. */
const SUMMARY_HEAD_CHARS = 300;
const ERROR_MAX_CHARS = 200;

/** How a source is named to people; the identifiers stay for code and history. */
const SOURCE_NAMES: Readonly<Record<AutoWorkSource, { readonly ja: string; readonly en: string }>> = {
  failure_notice: { ja: "失敗の知らせ", en: "failure notice" },
  scheduled_check: { ja: "定期の見回り", en: "scheduled check" },
  github: { ja: "GitHub", en: "GitHub" },
};

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

/** Receives signals from the three triggers, keeps the history, and creates Works. */
export class AutoWorkService {
  private readonly judge: AutoWorkJudge;
  private readonly runNowHandlers = new Map<string, AutoWorkRunNowHandler>();
  private finishedHandler: AutoWorkFinishedHandler | null = null;
  private createdHandler: AutoWorkCreatedHandler | null = null;
  private githubLogin: AutoWorkGithubLoginResolver | null = null;
  private readonly lastAlertAt = new Map<string, number>();
  private stopped = false;
  private started = false;
  private replaying: Promise<void> = Promise.resolve();
  private readonly triggers: AutoWorkTriggerSource[] = [];
  /** Which Projects each trigger has been started for; the next delivery to them is a reconfigure. */
  private readonly running = new Map<AutoWorkTriggerSource, Set<string>>();
  private readonly finishing = new Set<string>();

  public constructor(private readonly deps: AutoWorkServiceDeps) {
    this.judge = new AutoWorkJudge({ runner: deps.runner, roleModel: deps.roleModel });
  }

  /**
   * The whole life of the service: clean up what the last run left, hand the settings to the triggers, and stop them again in `stop`.
   * Startup work that can wait on the network (telling GitHub that a Work finished) does not hold Core back.
   */
  public async start(): Promise<void> {
    this.stopped = false;
    this.started = true;
    await this.markInterruptedJudgments();
    this.replaying = this.replayFinished();
    this.deliverConfig();
  }

  /** A judgment still waiting on the model is abandoned, not awaited; its row stays `judging` until the next start. */
  public async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    const triggers = [...this.running.keys()];
    this.running.clear();
    await Promise.allSettled([this.replaying, ...triggers.map((trigger) => trigger.stop())]);
  }

  /** A trigger registered before `start` begins with it; one registered later begins at once. */
  public registerTrigger(trigger: AutoWorkTriggerSource): void {
    this.triggers.push(trigger);
    if (this.started) this.deliverConfig(trigger);
  }

  /** Gives the settings now in effect to every trigger; called when the files are re-read and when the database switches change. */
  public reconfigure(): void {
    if (this.started) this.deliverConfig();
  }

  /** Judgments that were running when Core last stopped can never finish; mark them so the history does not show them as running. */
  private async markInterruptedJudgments(): Promise<void> {
    const now = this.now().toISOString();
    await this.deps.db.createWriteLane().transact((tx) => {
      tx.run("UPDATE auto_work_events SET verdict = 'judge_failed', verdict_reason = 'interrupted', updated_at = ? WHERE verdict = 'judging'", now);
    });
  }

  private deliverConfig(only?: AutoWorkTriggerSource): void {
    const projects = this.deps.db.all<{ id: string }>("SELECT id FROM projects");
    for (const trigger of only ? [only] : this.triggers) {
      const started = this.running.get(trigger) ?? new Set<string>();
      for (const { id } of projects) {
        const config = this.deps.config(id);
        if (!config) continue;
        try {
          if (started.has(id)) trigger.reconfigure(config, id);
          else {
            trigger.start((signal) => this.receive(signal), config, id);
            started.add(id);
          }
        } catch (error) {
          this.deps.logger?.warn(`[owl-core] Could not give the settings to the ${trigger.source} trigger for Project ${id}`, error);
        }
      }
      this.running.set(trigger, started);
    }
  }

  /** Works that finished while Owl was off: tell their source once. Rows without a source to tell are left alone. */
  private async replayFinished(): Promise<void> {
    if (!this.finishedHandler) return;
    const rows = this.deps.db.all<{ work_id: string; state: string }>(
      `SELECT e.work_id, w.state FROM auto_work_events e JOIN works w ON w.id = e.work_id
       WHERE e.verdict = 'created' AND e.github_repo IS NOT NULL AND e.finished_notified_at IS NULL AND w.state IN ('completed', 'cancelled')`,
    );
    for (const row of rows) {
      if (this.stopped) return;
      try { await this.onWorkFinished(row.work_id, row.state); } catch (error) {
        this.deps.logger?.warn("[owl-core] Could not tell the automatic Work source that a Work finished", row.work_id, error);
      }
    }
  }

  public registerRunNow(what: string, handler: AutoWorkRunNowHandler): void {
    this.runNowHandlers.set(what, handler);
  }

  /** The GitHub trigger tells the service who `@me` is; without it, `@me` allows nobody. */
  public registerGithubLogin(resolver: AutoWorkGithubLoginResolver): void {
    this.githubLogin = resolver;
  }

  public registerWorkCreated(handler: AutoWorkCreatedHandler): void {
    this.createdHandler = handler;
  }

  public registerWorkFinished(handler: AutoWorkFinishedHandler): void {
    this.finishedHandler = handler;
  }

  /** Runs the registered handler for `what` once, regardless of its schedule. */
  public async runAutoWorkNow(what: string, projectId: string): Promise<readonly AutoWorkReceiveResult[]> {
    const handler = this.runNowHandlers.get(what);
    if (!handler) throw invalidStateTransition(`Automatic Work creation cannot run "${what}" now.`, { what });
    const config = typeof projectId === "string" && projectId !== "" ? this.deps.config(projectId) : null;
    if (!(config?.enabled.effective && config.global_enabled.effective)) throw invalidStateTransition("Automatic Work creation is off for this Project.", { what, project_id: projectId, reason: "auto_work_disabled" });
    return handler(projectId);
  }

  /**
   * Tells the source of a Work made from an Issue that it has finished, then marks the row so it is told once.
   * Without a handler the row is left unmarked, so a handler registered before the next start still gets it.
   */
  public async onWorkFinished(workId: string, state: string): Promise<void> {
    if (!this.finishedHandler || this.finishing.has(workId)) return;
    const event = this.deps.store.listEvents({ work_id: workId, verdict: "created", limit: 1 })[0];
    if (!event || event.github_repo === null || event.finished_notified_at !== null) return;
    this.finishing.add(workId);
    try {
      const told = await this.finishedHandler(event, state);
      await this.update(event.id, { finished_notified_at: this.now().toISOString(), ...(told?.github_pr_url ? { github_pr_url: told.github_pr_url } : {}) });
    } finally {
      this.finishing.delete(workId);
    }
  }

  public async receive(signal: AutoWorkSignal): Promise<AutoWorkReceiveResult> {
    const config = this.deps.config(signal.project_id);
    const detail = clip(signal.detail, config?.max_detail_chars ?? signal.detail.length);
    const base = this.eventInput(signal, detail);
    if (!config) {
      const id = await this.insert({ ...base, dedupe_key: "", day_key: "", verdict: "disabled", verdict_reason: "auto_work_not_configured" });
      return { verdict: "disabled", event_id: id, work_id: null };
    }

    const reservation = await this.deps.db.createWriteLane().transact((tx) => {
      const now = this.now();
      const stage = evaluateStageOne(signal, config, this.facts(tx, config), now);
      const nowText = now.toISOString();
      if (!stage.ok) {
        const skipped = this.skipInput(base, stage);
        const id = insertEventRow(tx, stage.verdict === "unauthorized" ? this.withoutExternalText(skipped) : skipped, nowText);
        return { stage, id };
      }
      const id = insertEventRow(tx, { ...base, rule_id: stage.rule.id, dedupe_key: stage.dedupe_key, day_key: stage.day_key, verdict: "judging", verdict_reason: "" }, nowText);
      return { stage, id };
    });
    const { stage, id } = reservation;
    if (!stage.ok) return { verdict: stage.verdict, event_id: id, work_id: null };

    const outcome = await this.judge.judge(await this.judgmentInput(signal, detail, config, stage.rule));
    if (this.stopped) return { verdict: "judging", event_id: id, work_id: null };
    if (!outcome.ok) return this.fail(id, signal, stage.dedupe_key, outcome.error);
    return this.finalize(id, signal, stage.dedupe_key, stage.rule, outcome.judgment);
  }

  private now(): Date {
    return this.deps.clock?.now() ?? new Date();
  }

  private async insert(input: AutoWorkEventInput): Promise<string> {
    return this.deps.db.createWriteLane().transact((tx) => insertEventRow(tx, input, this.now().toISOString()));
  }

  private eventInput(signal: AutoWorkSignal, detail: string): Omit<AutoWorkEventInput, "dedupe_key" | "day_key" | "verdict" | "verdict_reason"> {
    const github = signal.github;
    return {
      project_id: signal.project_id,
      source: signal.source,
      kind: signal.kind,
      title: signal.title,
      detail,
      backlog_item_ids: [...signal.backlog_item_ids],
      occurred_at: signal.occurred_at,
      ...(github ? {
        github_repo: github.repo,
        github_issue_number: github.issue_number,
        github_is_pull_request: github.is_pull_request,
        github_comment_id: github.comment_id,
        github_updated_at: github.updated_at,
        github_author: github.author,
        github_url: github.url,
      } : {}),
    };
  }

  /** The text of a person who is not allowed is not kept; who, where, which item and when it was updated stay (the GitHub trigger needs the last to not record the same update twice). */
  private withoutExternalText(input: AutoWorkEventInput): AutoWorkEventInput {
    return { ...input, title: "", detail: "" };
  }

  private skipInput(base: ReturnType<AutoWorkService["eventInput"]>, stage: Extract<StageOneResult, { ok: false }>): AutoWorkEventInput {
    return {
      ...base,
      rule_id: stage.rule?.id ?? null,
      dedupe_key: stage.dedupe_key,
      day_key: stage.day_key,
      verdict: stage.verdict,
      verdict_reason: stage.reason,
      duplicate_of_work_id: stage.duplicate_of_work_id ?? null,
      duplicate_of_event_id: stage.duplicate_of_event_id ?? null,
    };
  }

  private facts(tx: CoreWriteLaneTransaction, config: EffectiveAutoWorkConfig): StageOneFacts {
    const counted = "('judging', 'created')";
    return {
      activeDuplicate: (key) => {
        const row = tx.get<{ id: string; work_id: string | null }>(
          `SELECT e.id, e.work_id FROM auto_work_events e LEFT JOIN works w ON w.id = e.work_id
           WHERE e.dedupe_key = ? AND (e.verdict = 'judging'
             OR (e.verdict = 'created' AND w.id IS NOT NULL AND w.archived_at IS NULL AND w.state NOT IN ('completed', 'cancelled')))
           ORDER BY e.created_at DESC LIMIT 1`,
          key,
        );
        return row ? { event_id: row.id, work_id: row.work_id } : null;
      },
      lastCreated: (key) => tx.get<{ created_at: string; work_id: string | null }>(
        "SELECT created_at, work_id FROM auto_work_events WHERE dedupe_key = ? AND verdict = 'created' ORDER BY created_at DESC, id DESC LIMIT 1", key,
      ) ?? null,
      occurrencesSince: (key, since) => Number(tx.get<{ total: number }>(
        "SELECT COUNT(*) AS total FROM auto_work_events WHERE dedupe_key = ? AND created_at >= ? AND verdict NOT IN ('disabled', 'unauthorized', 'no_rule')", key, since,
      )?.total ?? 0),
      createdToday: (projectId, dayKey) => Number(tx.get<{ total: number }>(
        `SELECT COUNT(*) AS total FROM auto_work_events WHERE project_id = ? AND day_key = ? AND verdict IN ${counted}`, projectId, dayKey,
      )?.total ?? 0),
      createdTodayAll: (dayKey) => Number(tx.get<{ total: number }>(
        `SELECT COUNT(*) AS total FROM auto_work_events WHERE day_key = ? AND verdict IN ${counted}`, dayKey,
      )?.total ?? 0),
      allowedGithubUsers: (projectId) => {
        const users = new Set(config.github.allowed_users.filter((user) => user !== "@me").map((user) => user.toLowerCase()));
        const login = config.github.allowed_users.includes("@me") ? this.githubLogin?.(projectId) : null;
        if (login) users.add(login.toLowerCase());
        return users;
      },
    };
  }

  private async overviewHead(projectId: string, max: number): Promise<string | null> {
    try {
      const overview = await this.deps.projectOverview?.(projectId);
      return overview ? clip(overview, max) : null;
    } catch (error) {
      this.deps.logger?.warn("[owl-core] Could not read the Project overview for an automatic Work", error);
      return null;
    }
  }

  private async judgmentInput(signal: AutoWorkSignal, detail: string, config: EffectiveAutoWorkConfig, rule: EffectiveAutoWorkRule) {
    const db = this.deps.db;
    const overview = await this.overviewHead(signal.project_id, config.max_detail_chars);
    const project = db.get<{ name: string }>("SELECT name FROM projects WHERE id = ?", signal.project_id);
    const openWorks = db.all<{ id: string; display_number: number | null; title: string; summary: string; state: string; auto: number }>(
      `SELECT w.id, w.display_number, w.title, w.summary, w.state,
              EXISTS (SELECT 1 FROM auto_work_events e WHERE e.work_id = w.id AND e.verdict = 'created') AS auto
       FROM works w WHERE w.project_id = ? AND w.archived_at IS NULL AND w.state IN (${OPEN_WORK_STATES.map(() => "?").join(", ")})
       ORDER BY w.created_at DESC LIMIT ?`,
      signal.project_id, ...OPEN_WORK_STATES, config.candidate_limit,
    );
    const recent = db.all<{ work_id: string; title: string; created_at: string; state: string }>(
      `SELECT e.work_id, w.title, e.created_at, w.state FROM auto_work_events e JOIN works w ON w.id = e.work_id
       WHERE e.project_id = ? AND e.verdict = 'created' ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
      signal.project_id, config.candidate_limit,
    );
    return {
      judge_role: config.judge_role,
      invocation_id: createUlid(),
      language: this.deps.language(),
      timeout_ms: config.judge_timeout_seconds * 1000,
      project: { name: project?.name ?? signal.project_id, overview },
      rule: { id: rule.id, intent: rule.intent, action: rule.action, default_size: rule.size },
      signal: {
        source: signal.source, kind: signal.kind, title: signal.title, detail,
        occurred_at: signal.occurred_at, github_url: signal.github?.url ?? null,
      },
      open_works: openWorks.map((work) => ({
        work_id: work.id, display_number: work.display_number, title: work.title,
        summary_head: clip(work.summary, SUMMARY_HEAD_CHARS), state: work.state, auto_created: work.auto === 1,
      })),
      recent_auto_works: recent.map((work) => ({
        work_id: work.work_id, title: work.title, verdict: "created" as const, created_at: work.created_at, work_state: work.state,
      })),
    };
  }

  private async fail(eventId: string, signal: AutoWorkSignal, dedupeKey: string, error: string): Promise<AutoWorkReceiveResult> {
    const reason = clip(error, ERROR_MAX_CHARS);
    await this.update(eventId, { verdict: "judge_failed", verdict_reason: reason });
    await this.alert({ kind: "auto_work_judge_failed", signal, dedupeKey, eventId, workId: null, detail: reason });
    return { verdict: "judge_failed", event_id: eventId, work_id: null };
  }

  private async update(eventId: string, patch: Parameters<typeof updateEventRow>[2]): Promise<void> {
    await this.deps.db.createWriteLane().transact((tx) => updateEventRow(tx, eventId, patch, this.now().toISOString()));
  }

  private async finalize(
    eventId: string, signal: AutoWorkSignal, dedupeKey: string, rule: EffectiveAutoWorkRule, judgment: AutoWorkJudgment,
  ): Promise<AutoWorkReceiveResult> {
    const judge = { ...judgment };
    if (judgment.duplicate_of_work_id !== null) {
      await this.update(eventId, { verdict: "duplicate", verdict_reason: judgment.duplicate_reason ?? judgment.reason, duplicate_of_work_id: judgment.duplicate_of_work_id, judge });
      return { verdict: "duplicate", event_id: eventId, work_id: null };
    }
    if (!judgment.worth_fixing || judgment.work === null) {
      await this.update(eventId, { verdict: "not_worth", verdict_reason: judgment.reason, judge });
      return { verdict: "not_worth", event_id: eventId, work_id: null };
    }

    const work = judgment.work;
    const footer = this.footer(signal, rule);
    const summary = `${clip(work.summary, AUTO_WORK_SUMMARY_MAX_CHARS - footer.length)}${footer}`;
    let workId: string;
    let stateVersion: number;
    const alertEventId = createUlid();
    try {
      const written = await this.deps.db.createWriteLane().write({
        mutateState: (tx) => {
          const row = createWorkInTransaction(tx, { title: work.title, summary, size: work.size, project_id: signal.project_id });
          if (signal.backlog_item_ids.length > 0) linkBacklogItemsToWorkInTransaction(tx, row.id, signal.backlog_item_ids, this.now().toISOString());
          updateEventRow(tx, eventId, { verdict: "created", verdict_reason: judgment.reason, work_id: row.id, action: rule.action, judge }, this.now().toISOString());
          // The write lane stores the alert before this callback runs; the Work's id and number exist only now, so the same row is completed here.
          const payload = this.alertPayload({
            kind: "auto_work_created", signal, dedupeKey, eventId, workId: row.id, detail: work.title,
            displayNumber: row.display_number ?? null, ruleId: rule.id, action: rule.action,
          });
          tx.run("UPDATE events SET payload_json = ?, work_id = ? WHERE id = ?", JSON.stringify(payload), row.id, alertEventId);
          return { id: row.id, version: row.state_version };
        },
        event: {
          id: alertEventId,
          idempotencyKey: `auto-work-created:${eventId}`,
          type: "system.alert",
          payload: { kind: "auto_work_created", schema_version: "1.0.0", event_id: eventId, project_id: signal.project_id, work_id: null },
        },
        outbox: [{ provider: "websocket" }],
      });
      workId = written.state.id;
      stateVersion = written.state.version;
    } catch (error) {
      return this.fail(eventId, signal, dedupeKey, `create_failed:${error instanceof Error ? error.message : String(error)}`);
    }
    // The event row says `created` only once the Work exists, so a started Work is never missing from the history.
    if (rule.action === "start") await this.startCreated(eventId, signal, dedupeKey, workId, stateVersion, work.size);
    if (signal.github) await this.tellCreated(eventId, signal, dedupeKey, workId, work.title, rule.action === "start");
    return { verdict: "created", event_id: eventId, work_id: workId };
  }

  private async startCreated(eventId: string, signal: AutoWorkSignal, dedupeKey: string, workId: string, stateVersion: number, size: string): Promise<void> {
    try {
      await this.deps.startWork(workId, {
        request_id: createUlid(),
        idempotency_key: `auto-work-start:${eventId}`,
        expected_version: stateVersion,
        payload: { mode: size === "small" ? "small" : "normal" },
      });
    } catch (error) {
      const message = clip(error instanceof Error ? error.message : String(error), ERROR_MAX_CHARS);
      await this.update(eventId, { action_error: message });
      await this.alert({ kind: "auto_work_start_failed", signal, dedupeKey, eventId, workId, detail: message });
    }
  }

  /** A failed comment leaves the Work as it is: the reason goes to the event and the Owner is told once; it is not retried. */
  private async tellCreated(eventId: string, signal: AutoWorkSignal, dedupeKey: string, workId: string, title: string, started: boolean): Promise<void> {
    if (!this.createdHandler) return;
    try {
      const displayNumber = this.deps.db.get<{ display_number: number | null }>("SELECT display_number FROM works WHERE id = ?", workId)?.display_number ?? null;
      const url = await this.createdHandler({ signal, work_id: workId, display_number: displayNumber, title, started });
      if (url) await this.update(eventId, { github_comment_url: url });
    } catch (error) {
      const message = clip(error instanceof Error ? error.message : String(error), ERROR_MAX_CHARS);
      const current = this.deps.store.getEvent(eventId)?.action_error;
      await this.update(eventId, { action_error: current ? `${current}; ${message}` : message });
      await this.alert({ kind: "auto_work_github_failed", signal, dedupeKey, eventId, workId, detail: message });
    }
  }

  private footer(signal: AutoWorkSignal, rule: EffectiveAutoWorkRule): string {
    const ja = this.deps.language() === "ja";
    const source = SOURCE_NAMES[signal.source][ja ? "ja" : "en"];
    const lines = ja
      ? ["", "---", `自動作成: ${source} / ルール ${rule.id} / 起きた時刻 ${signal.occurred_at}`, `きっかけ: ${signal.title}`]
      : ["", "---", `Created automatically: ${source} / rule ${rule.id} / occurred at ${signal.occurred_at}`, `Trigger: ${signal.title}`];
    if (signal.github) lines.push(`GitHub: ${signal.github.url}`);
    return `\n${lines.join("\n")}\n`;
  }

  private alertPayload(context: AutoWorkAlertContext) {
    const { kind, signal, eventId, workId, detail } = context;
    const ja = this.deps.language() === "ja";
    const project = this.deps.db.get<{ name: string }>("SELECT name FROM projects WHERE id = ?", signal.project_id)?.name ?? signal.project_id;
    const number = context.displayNumber === null || context.displayNumber === undefined ? "" : `#${context.displayNumber} `;
    const how = context.action === "start" ? (ja ? "すぐ始める" : "started") : (ja ? "下書き" : "draft");
    const message = {
      auto_work_created: ja ? `自動で Work を作りました: ${number}${detail}（${how}）` : `Created a Work automatically: ${number}${detail} (${how})`,
      auto_work_judge_failed: ja ? `自動 Work の判定に失敗しました（${project} / ${signal.title}）: ${detail}` : `Judging an automatic Work failed (${project} / ${signal.title}): ${detail}`,
      auto_work_github_failed: ja ? `GitHub への知らせに失敗しました（${project} / ${signal.title}）: ${detail}` : `Could not tell GitHub (${project} / ${signal.title}): ${detail}`,
      auto_work_start_failed: ja ? `自動作成した Work を始められませんでした（${project} / ${signal.title}）: ${detail}` : `Could not start the automatic Work (${project} / ${signal.title}): ${detail}`,
    }[kind];
    return {
      kind, schema_version: "1.0.0", message, event_id: eventId, project_id: signal.project_id, work_id: workId,
      ...(kind === "auto_work_created" ? { display_number: context.displayNumber ?? null, source: signal.source, rule_id: context.ruleId ?? null, action: context.action ?? null } : {}),
    };
  }

  /** A failure alert is repeated at most once per `alert_cooldown_minutes` for the same kind and the same signal key; the history row is always written. */
  private async alert(context: AutoWorkAlertContext): Promise<void> {
    const { kind, signal, dedupeKey, eventId, workId } = context;
    const cooldownMs = (this.deps.config(signal.project_id)?.limits.alert_cooldown_minutes ?? 0) * 60_000;
    const at = this.now().getTime();
    const cooldownKey = `${kind}\0${dedupeKey}`;
    const last = this.lastAlertAt.get(cooldownKey);
    if (last !== undefined && at - last < cooldownMs) return;
    this.lastAlertAt.set(cooldownKey, at);
    try {
      await this.deps.db.createWriteLane().write({
        mutateState: () => null,
        event: {
          idempotencyKey: `${kind}:${eventId}`,
          type: "system.alert",
          ...(workId ? { workId } : {}),
          payload: this.alertPayload(context),
        },
        outbox: [{ provider: "websocket" }],
      });
    } catch (error) {
      this.deps.logger?.warn(`[owl-core] Could not record ${kind}`, error);
    }
  }
}
