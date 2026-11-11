import type { AutoWorkGithubList, AutoWorkSignal, EffectiveAutoWorkConfig, GhRunner } from "@owl/shared";
import { invalidStateTransition } from "../../errors.js";
import type { LibrarianSchedulerClock } from "../../librarian-scheduler.js";
import { spawnTestCommand } from "../../nightly-tests.js";
import type { CoreDatabase } from "../../types.js";
import { PeriodicRunner } from "../periodic-runner.js";
import type { AutoWorkEventRecord, AutoWorkStore, GithubItemInput, GithubLedgerItem } from "../store.js";
import type { AutoWorkFinishedHandler, AutoWorkReceiveResult, AutoWorkService, AutoWorkTriggerSource } from "../service.js";
import { isRecord } from "@owl/shared/small-helpers";

/** An Issue or PR from GitHub, reduced to what automatic Work creation reads. */
export interface GithubIssue {
  readonly id: string;
  readonly number: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly title: string;
  readonly body: string;
  readonly user: { readonly login: string | null; readonly type: string | null };
  readonly labels: readonly string[];
  readonly is_pull_request: boolean;
  readonly html_url: string;
}

export interface GithubComment {
  readonly id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly body: string;
  readonly user: { readonly login: string | null; readonly type: string | null };
  readonly issue_number: number;
  readonly html_url: string;
}

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const idText = (value: unknown): string | null => (typeof value === "number" || typeof value === "string") && String(value) !== "" ? String(value) : null;

/** The author is the `user` object of the item; the top level of an item has no `login`. */
function projectUser(raw: Record<string, unknown>): { login: string | null; type: string | null } {
  const user = isRecord(raw.user) ? raw.user : {};
  return { login: text(user.login), type: text(user.type) };
}

/** null when the item lacks what the ledger needs; the caller then treats the whole response as unreadable. */
export function projectIssue(raw: unknown, maxDetailChars: number): GithubIssue | null {
  if (!isRecord(raw)) return null;
  const id = idText(raw.id);
  const createdAt = text(raw.created_at);
  const updatedAt = text(raw.updated_at);
  if (id === null || createdAt === null || updatedAt === null || typeof raw.number !== "number") return null;
  const labels = Array.isArray(raw.labels) ? raw.labels.flatMap((label) => {
    const name = typeof label === "string" ? label : isRecord(label) ? label.name : null;
    return typeof name === "string" ? [name] : [];
  }) : [];
  return {
    id, number: raw.number, created_at: createdAt, updated_at: updatedAt,
    title: typeof raw.title === "string" ? raw.title : "",
    body: (typeof raw.body === "string" ? raw.body : "").slice(0, maxDetailChars),
    user: projectUser(raw), labels, is_pull_request: raw.pull_request != null,
    html_url: typeof raw.html_url === "string" ? raw.html_url : "",
  };
}

export function projectComment(raw: unknown, maxDetailChars: number): GithubComment | null {
  if (!isRecord(raw)) return null;
  const id = idText(raw.id);
  const createdAt = text(raw.created_at);
  const updatedAt = text(raw.updated_at);
  const issueNumber = typeof raw.issue_url === "string" ? Number(/\/issues\/(\d+)$/u.exec(raw.issue_url)?.[1]) : Number.NaN;
  if (id === null || createdAt === null || updatedAt === null || !Number.isInteger(issueNumber) || issueNumber < 1) return null;
  return {
    id, created_at: createdAt, updated_at: updatedAt,
    body: (typeof raw.body === "string" ? raw.body : "").slice(0, maxDetailChars),
    user: projectUser(raw), issue_number: issueNumber,
    html_url: typeof raw.html_url === "string" ? raw.html_url : "",
  };
}

/**
 * Runs the real `gh`. gh signs in with its own settings, so only PATH and HOME are passed on and Owl holds no token.
 * `owlRoot` is the working directory: gh is never run inside a Project's repository.
 */
export function createGhRunner(owlRoot: string, environment: NodeJS.ProcessEnv = process.env): GhRunner {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME"]) {
    const value = environment[key];
    if (value !== undefined) env[key] = value;
  }
  return async (args, options) => {
    const result = await spawnTestCommand(["gh", ...args], owlRoot, env, options.timeoutMs, options.outputLimitBytes, undefined, undefined, options.stdin);
    return {
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr || result.error || "",
      timed_out: result.timed_out,
      stdout_truncated: result.stdout_truncated === true,
    };
  };
}

const ghOptions = (config: EffectiveAutoWorkConfig, stdin?: string) => ({
  timeoutMs: config.github.timeout_seconds * 1000,
  outputLimitBytes: config.github.output_limit_bytes,
  ...(stdin === undefined ? {} : { stdin }),
});

const ERROR_MAX_CHARS = 200;
const failureText = (result: { stderr: string; timed_out: boolean; exit_code: number | null }): string =>
  (result.timed_out ? "timed_out" : result.stderr.trim() || `exit_code:${result.exit_code}`).slice(0, ERROR_MAX_CHARS);

/** The only place that writes to GitHub: the body goes through stdin, so no shell or argument length is involved. Returns the URL gh prints. */
export async function commentOnIssue(gh: GhRunner, config: EffectiveAutoWorkConfig, repo: string, issueNumber: number, body: string): Promise<string | null> {
  const result = await gh(["issue", "comment", String(issueNumber), "--repo", repo, "--body-file", "-"], ghOptions(config, body));
  if (result.exit_code !== 0 || result.timed_out) throw new Error(`gh issue comment failed: ${failureText(result)}`);
  return result.stdout.trim().split(/\s+/u).find((word) => /^https?:\/\//u.test(word)) ?? null;
}

const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/gu, (whole, key: string) => (Object.hasOwn(values, key) ? values[key]! : whole));

const isoSeconds = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/u, "Z");

export interface GithubTriggerDeps {
  readonly db: CoreDatabase;
  readonly store: AutoWorkStore;
  readonly gh: GhRunner;
  readonly clock?: LibrarianSchedulerClock;
  readonly config: (projectId: string) => EffectiveAutoWorkConfig | null;
  readonly language: () => "ja" | "en";
  /** The Owner is told that GitHub could not be read (kind auto_work_github_failed). */
  readonly alert: (detail: string) => void;
  readonly logger?: Pick<Console, "warn">;
}

interface PollContext {
  readonly projectId: string;
  readonly repo: string;
  readonly config: EffectiveAutoWorkConfig;
  /** Issues read in this poll, so several comments on one Issue read it once. */
  readonly issues: Map<number, GithubIssue>;
}

/** Reads a Project's GitHub Issues and comments with gh, and turns the ones that qualify into signals (design 3.4). */
export class GithubTrigger implements AutoWorkTriggerSource {
  public readonly source = "github" as const;
  private sink: ((signal: AutoWorkSignal) => Promise<AutoWorkReceiveResult>) | null = null;
  private readonly runners = new Map<string, PeriodicRunner>();
  private readonly polling = new Map<string, Promise<AutoWorkEventRecord[]>>();
  /** `@me` for the Projects being polled; kept only while the poll runs. */
  private readonly logins = new Map<string, string>();
  private readonly lastAlertAt = new Map<string, number>();

  public constructor(private readonly deps: GithubTriggerDeps) {}

  /** Hands the service what only this trigger knows: who `@me` is, how to tell GitHub, and the manual run. */
  public attachTo(service: AutoWorkService): void {
    service.registerTrigger(this);
    service.registerGithubLogin((projectId) => this.logins.get(projectId) ?? null);
    service.registerRunNow("github", async (projectId) => (await this.poll(projectId, true)).map((event) => ({ verdict: event.verdict, event_id: event.id, work_id: event.work_id })));
    service.registerWorkCreated((context) => this.tellCreated(context));
    service.registerWorkFinished((event, state) => this.tellFinished(event, state));
  }

  public start(sink: (signal: AutoWorkSignal) => Promise<AutoWorkReceiveResult>, config: EffectiveAutoWorkConfig, projectId: string): void {
    this.sink = sink;
    const runner = new PeriodicRunner({
      run: () => this.poll(projectId, false),
      intervalMs: config.github.poll_minutes * 60_000,
      clock: this.deps.clock,
      logger: this.deps.logger,
    });
    this.runners.set(projectId, runner);
    runner.start();
  }

  public reconfigure(config: EffectiveAutoWorkConfig, projectId: string): void {
    this.runners.get(projectId)?.reschedule(config.github.poll_minutes * 60_000);
  }

  public async stop(): Promise<void> {
    const runners = [...this.runners.values()];
    this.runners.clear();
    await Promise.allSettled(runners.map((runner) => runner.stop()));
  }

  /**
   * One poll of one Project. A poll already running is joined, not repeated. The scheduled poll does nothing for a Project
   * that is off or has no repository; a manual one says so.
   */
  public poll(projectId: string, manual: boolean): Promise<AutoWorkEventRecord[]> {
    const running = this.polling.get(projectId);
    if (running) return running;
    const task = this.pollOnce(projectId, manual).finally(() => { this.polling.delete(projectId); this.logins.delete(projectId); });
    this.polling.set(projectId, task);
    return task;
  }

  private now(): Date {
    return this.deps.clock?.now() ?? new Date();
  }

  private async pollOnce(projectId: string, manual: boolean): Promise<AutoWorkEventRecord[]> {
    const config = this.deps.config(projectId);
    const repo = config?.github.repo ?? null;
    if (!config || repo === null || !config.enabled.effective || !config.global_enabled.effective) {
      if (manual) throw invalidStateTransition("This Project has no GitHub repository to read.", { project_id: projectId, reason: "github_not_configured" });
      return [];
    }
    const context: PollContext = { projectId, repo, config, issues: new Map() };
    // A repository changed in the settings is a new start: the old time and ledger belong to the old repository.
    const stale = (["issues", "comments"] as const).some((list) => {
      const cursor = this.deps.store.getCursor(projectId, list);
      return cursor !== null && cursor.repo !== repo;
    });
    if (stale) await this.deps.store.resetGithub(projectId);

    const login = await this.resolveLogin(config);
    if (login === null) return [];
    this.logins.set(projectId, login);

    // The two lists do not depend on each other: one stopping does not stop the other.
    await this.fetchList(context, "issues");
    await this.fetchList(context, "comments");
    const margin = config.github.since_margin_seconds * 1000;
    const oldestNextFrom = Math.min(...(["issues", "comments"] as const).map((list) => Date.parse(this.deps.store.getCursor(projectId, list)?.since ?? "") - margin));
    if (Number.isFinite(oldestNextFrom)) await this.deps.store.deleteProcessedBefore(projectId, isoSeconds(new Date(oldestNextFrom)));

    const eventIds = [...await this.processPending(context, "issue"), ...await this.processPending(context, "comment")];
    return eventIds.flatMap((id) => this.deps.store.getEvent(id) ?? []);
  }

  /** `@me`. When it cannot be resolved the whole poll stops: nobody is allowed rather than anybody. */
  private async resolveLogin(config: EffectiveAutoWorkConfig): Promise<string | null> {
    const result = await this.runGh(["api", "user"], config);
    if (result === null) return null;
    try {
      const login = (JSON.parse(result.stdout) as { login?: unknown }).login;
      if (typeof login === "string" && login !== "") return login;
    } catch { /* falls through to the alert */ }
    this.alert("gh api user returned no login", config);
    return null;
  }

  /** gh's answer, or null after the Owner was told that it failed. */
  private async runGh(args: readonly string[], config: EffectiveAutoWorkConfig) {
    let result: Awaited<ReturnType<GhRunner>>;
    try {
      result = await this.deps.gh(args, ghOptions(config));
    } catch (error) {
      this.alert(`gh could not be run: ${error instanceof Error ? error.message : String(error)}`.slice(0, ERROR_MAX_CHARS), config);
      return null;
    }
    if (result.exit_code !== 0 || result.timed_out) {
      this.alert(`gh failed. Check gh auth login. ${failureText(result)}`, config);
      return null;
    }
    return result;
  }

  private alert(detail: string, config: EffectiveAutoWorkConfig): void {
    const cooldownMs = config.limits.alert_cooldown_minutes * 60_000;
    const at = this.now().getTime();
    const last = this.lastAlertAt.get(detail);
    if (last !== undefined && at - last < cooldownMs) return;
    this.lastAlertAt.set(detail, at);
    this.deps.alert(detail);
  }

  /** One list: pages from `since - margin` on, recorded in the ledger. `since` moves only when the last page was read. */
  private async fetchList(context: PollContext, list: AutoWorkGithubList): Promise<void> {
    const { projectId, repo, config } = context;
    const { github } = config;
    const store = this.deps.store;
    const started = this.now();
    const cursor = store.getCursor(projectId, list) ?? {
      repo, since: isoSeconds(new Date(started.getTime() - github.initial_lookback_hours * 3_600_000)),
      last_polled_at: null, last_completed_at: null, last_error: null,
    };
    const fromTime = Date.parse(cursor.since) - github.since_margin_seconds * 1000;
    const from = isoSeconds(new Date(fromTime));
    const stop = async (error: string): Promise<void> => {
      await store.saveCursor(projectId, list, repo, { since: cursor.since, last_polled_at: started.toISOString(), last_completed_at: cursor.last_completed_at, last_error: error });
      this.alert(`GitHub ${list} of ${repo} could not be read: ${error}`, config);
    };
    const endpoint = list === "issues" ? `repos/${repo}/issues?state=all&since=${from}` : `repos/${repo}/issues/comments?since=${from}`;
    for (let page = 1; ; page += 1) {
      let result: Awaited<ReturnType<GhRunner>>;
      try {
        result = await this.deps.gh(["api", `${endpoint}&per_page=${github.per_page}&page=${page}`], ghOptions(config));
      } catch (error) {
        return stop(`gh_error:${error instanceof Error ? error.message : String(error)}`.slice(0, ERROR_MAX_CHARS));
      }
      if (result.exit_code !== 0 || result.timed_out) return stop(failureText(result));
      let raw: unknown;
      try {
        if (result.stdout_truncated) throw new Error("truncated");
        raw = JSON.parse(result.stdout);
      } catch {
        return stop("output_truncated");
      }
      const projected = Array.isArray(raw) ? raw.map((item) => (list === "issues" ? projectIssue(item, config.max_detail_chars) : projectComment(item, config.max_detail_chars))) : [null];
      if (projected.some((item) => item === null)) return stop("unexpected_response");
      const items = projected as (GithubIssue | GithubComment)[];
      await store.recordItems(projectId, repo, items.map((item): GithubItemInput => ({
        item_type: list === "issues" ? "issue" : "comment",
        item_id: item.id,
        issue_number: "number" in item ? item.number : item.issue_number,
        updated_at: item.updated_at,
        created_in_window: list === "issues" && Date.parse(item.created_at) >= fromTime,
        payload: item,
      })));
      if (items.length < github.per_page) break;
    }
    await store.saveCursor(projectId, list, repo, { since: isoSeconds(started), last_polled_at: started.toISOString(), last_completed_at: started.toISOString(), last_error: null });
  }

  /** Ledger rows that wait: each becomes a signal or is settled without one. A row that fails is counted and the next one goes on. */
  private async processPending(context: PollContext, type: "issue" | "comment"): Promise<string[]> {
    const { projectId, config } = context;
    const eventIds: string[] = [];
    for (const row of this.deps.store.listPendingItems(projectId, type, config.github.max_items_per_poll)) {
      try {
        const signal = type === "issue" ? this.issueSignal(context, row) : await this.commentSignal(context, row);
        const result = signal ? await this.requireSink()(signal) : null;
        await this.deps.store.markItemProcessed(projectId, type, row.item_id, result?.event_id ?? null);
        if (result) eventIds.push(result.event_id);
      } catch (error) {
        await this.deps.store.markItemAttemptFailed(projectId, type, row.item_id, (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MAX_CHARS), config.github.max_item_attempts);
      }
    }
    return eventIds;
  }

  private requireSink(): (signal: AutoWorkSignal) => Promise<AutoWorkReceiveResult> {
    if (!this.sink) throw new Error("the GitHub trigger has not been started");
    return this.sink;
  }

  private issueSignal(context: PollContext, row: GithubLedgerItem): AutoWorkSignal | null {
    const { projectId, repo, config } = context;
    const issue = row.payload as GithubIssue;
    if (!config.github.watch.includes("issues")) return null;
    const requireLabels = config.github.require_labels;
    const labelled = requireLabels.length > 0 && requireLabels.every((label) => issue.labels.includes(label));
    if (!row.created_in_window && !labelled) return null;
    const earlier = this.deps.db.all<{ verdict: string; github_updated_at: string | null }>(
      "SELECT verdict, github_updated_at FROM auto_work_events WHERE project_id = ? AND github_repo = ? AND github_issue_number = ? AND kind = 'issue_opened'",
      projectId, repo, issue.number,
    );
    // A refused Issue is looked at again only after it has been updated (a label was added).
    if (earlier.some((event) => event.verdict !== "unauthorized" || event.github_updated_at === null || Date.parse(event.github_updated_at) >= Date.parse(issue.updated_at))) return null;
    return this.signal(projectId, repo, "issue_opened", issue.title, issue.body, issue, null, issue.created_at, issue.html_url, issue.updated_at, issue.user);
  }

  private async commentSignal(context: PollContext, row: GithubLedgerItem): Promise<AutoWorkSignal | null> {
    const { projectId, repo, config } = context;
    const comment = row.payload as GithubComment;
    const mention = config.github.mention;
    if (mention === "" || !comment.body.includes(mention)) return null;
    const known = this.deps.db.get<{ id: string }>(
      "SELECT id FROM auto_work_events WHERE project_id = ? AND github_repo = ? AND github_comment_id = ? LIMIT 1", projectId, repo, comment.id,
    );
    if (known) return null;
    const issue = await this.readIssue(context, comment.issue_number);
    if (!config.github.watch.includes(issue.is_pull_request ? "pr_comments" : "issue_comments")) return null;
    const ja = this.deps.language() === "ja";
    const title = `${ja ? `#${issue.number} へのコメント` : `Comment on #${issue.number}`}: ${comment.body.slice(0, config.max_detail_chars > 0 ? 100 : 0)}`;
    const detail = [issue.title, issue.body.slice(0, Math.floor(config.max_detail_chars / 4)), "---", comment.body].join("\n");
    return this.signal(projectId, repo, issue.is_pull_request ? "pr_comment" : "issue_comment", title, detail, issue, comment.id, comment.created_at, comment.html_url, comment.updated_at, comment.user);
  }

  private async readIssue(context: PollContext, number: number): Promise<GithubIssue> {
    const cached = context.issues.get(number);
    if (cached) return cached;
    const result = await this.deps.gh(["api", `repos/${context.repo}/issues/${number}`], ghOptions(context.config));
    if (result.exit_code !== 0 || result.timed_out) throw new Error(`issue_read_failed:${failureText(result)}`);
    if (result.stdout_truncated) throw new Error("issue_read_failed:output_truncated");
    const issue = projectIssue(JSON.parse(result.stdout), context.config.max_detail_chars);
    if (!issue) throw new Error("issue_read_failed:unexpected_response");
    context.issues.set(number, issue);
    return issue;
  }

  private signal(
    projectId: string, repo: string, kind: string, title: string, detail: string, issue: GithubIssue, commentId: string | null,
    occurredAt: string, url: string, updatedAt: string, author: { login: string | null; type: string | null },
  ): AutoWorkSignal {
    return {
      source: "github", project_id: projectId, kind, title, detail,
      dedupe: { kind: "id", value: `${repo}#${issue.number}` },
      occurred_at: occurredAt, backlog_item_ids: [], failure: null,
      github: {
        repo, issue_number: issue.number, is_pull_request: issue.is_pull_request, comment_id: commentId,
        author: author.login ?? "", author_is_bot: author.type === "Bot", labels: issue.labels, url, updated_at: updatedAt,
      },
    };
  }

  private templateValues(config: EffectiveAutoWorkConfig, workId: string, number: number | null, title: string): Record<string, string> {
    return {
      work_number: number === null ? "" : String(number),
      work_title: title,
      owl_url: config.github.owl_url === null ? "" : `${config.github.owl_url.replace(/\/+$/u, "")}/work?id=${encodeURIComponent(workId)}`,
    };
  }

  /** 5.3: the Issue is told that a Work was made from it. */
  private async tellCreated(context: Parameters<Parameters<AutoWorkService["registerWorkCreated"]>[0]>[0]): Promise<string | null> {
    const github = context.signal.github;
    const config = this.deps.config(context.signal.project_id);
    if (!github || !config) return null;
    const ja = this.deps.language() === "ja";
    const state = context.started ? (ja ? "開始済み" : "started") : (ja ? "下書き" : "draft");
    const body = fill(config.github.comments.created, { ...this.templateValues(config, context.work_id, context.display_number, context.title), state });
    return commentOnIssue(this.deps.gh, config, github.repo, github.issue_number, body);
  }

  /** 5.4: a finished Work is reported on its Issue, with the PR if one exists for the Work's branch. */
  private tellFinished: AutoWorkFinishedHandler = async (event, state) => {
    const config = this.deps.config(event.project_id);
    if (!config || event.github_repo === null || event.github_issue_number === null || event.work_id === null) return;
    const work = this.deps.db.get<{ display_number: number | null; title: string }>("SELECT display_number, title FROM works WHERE id = ?", event.work_id);
    const values = this.templateValues(config, event.work_id, work?.display_number ?? null, work?.title ?? "");
    const comment = (template: string, extra: Record<string, string> = {}) =>
      commentOnIssue(this.deps.gh, config, event.github_repo!, event.github_issue_number!, fill(template, { ...values, ...extra }));
    if (state === "cancelled") {
      await comment(config.github.comments.cancelled);
      return;
    }
    const branch = `owl/work/${event.work_id}/work`;
    const found = await this.deps.gh(["pr", "list", "--repo", event.github_repo, "--head", branch, "--state", "all", "--json", "number,url", "--limit", "1"], ghOptions(config));
    if (found.exit_code !== 0 || found.timed_out || found.stdout_truncated) throw new Error(`gh pr list failed: ${failureText(found)}`);
    const prs = JSON.parse(found.stdout) as { url?: unknown }[];
    const prUrl = typeof prs[0]?.url === "string" ? prs[0].url : null;
    if (prUrl === null) {
      await comment(config.github.comments.completed_no_pr, { branch });
      return;
    }
    await comment(config.github.comments.completed, { pr_url: prUrl });
    return { github_pr_url: prUrl };
  };
}
