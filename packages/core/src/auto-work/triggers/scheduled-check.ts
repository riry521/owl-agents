import { createHash } from "node:crypto";

import type { AutoWorkSignal, EffectiveAutoWorkConfig } from "@owl/shared";
import { invalidStateTransition } from "../../errors.js";
import { LibrarianScheduler, localDayKey, type LibrarianSchedulerClock } from "../../librarian-scheduler.js";
import { testFailureKey } from "../../nightly-tests.js";
import type { CoreDatabase } from "../../types.js";
import { findAutoWorkRule } from "../config.js";
import type { AutoWorkReceiveResult, AutoWorkTriggerSource } from "../service.js";

const DAY_MS = 86_400_000;

export interface CheckItemContext {
  readonly db: CoreDatabase;
  readonly project: { readonly id: string; readonly name: string };
  readonly params: Readonly<Record<string, unknown>>;
  readonly now: string;
}

/** One thing a scheduled check looks at. It reads the database and never uses a model. */
export interface CheckItem {
  readonly name: string;
  run(context: CheckItemContext): AutoWorkSignal[];
}

// shared の sha256 は 1 つのデータの hash。ここは parts を NUL でつないでから hash するので別に持つ。
const sha256 = (parts: readonly string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex");

function signal(context: CheckItemContext, kind: string, title: string, detail: string, dedupeValue: string, backlogItemIds: readonly string[]): AutoWorkSignal {
  return {
    source: "scheduled_check", project_id: context.project.id, kind, title, detail,
    dedupe: { kind: "id", value: dedupeValue }, occurred_at: context.now, backlog_item_ids: backlogItemIds, github: null, failure: null,
  };
}

const parseArray = (json: string): unknown[] => {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/** The latest nightly run failed and some of the backlog items it made are still open. */
const nightlyTestFailed: CheckItem = {
  name: "nightly_test_failed",
  run(context) {
    const run = context.db.get<{ status: string; failures_json: string; backlog_item_ids_json: string }>(
      "SELECT status, failures_json, backlog_item_ids_json FROM nightly_test_runs WHERE project_id = ? ORDER BY finished_at DESC, id DESC LIMIT 1",
      context.project.id,
    );
    if (!run || run.status === "passed") return [];
    const ids = parseArray(run.backlog_item_ids_json).filter((id): id is string => typeof id === "string");
    const open = ids.length === 0 ? [] : context.db.all<{ id: string }>(
      `SELECT id FROM backlog_items WHERE status = 'open' AND id IN (${ids.map(() => "?").join(", ")}) ORDER BY created_at, id`, ...ids,
    ).map((row) => row.id);
    if (open.length === 0) return [];
    const failures = parseArray(run.failures_json).filter((failure): failure is { file: string; name: string } =>
      typeof failure === "object" && failure !== null && typeof (failure as { file?: unknown }).file === "string" && typeof (failure as { name?: unknown }).name === "string");
    const keys = failures.map(testFailureKey).sort();
    return [signal(
      context, "nightly_test_failed", `夜間テストの失敗 ${failures.length} 件`,
      failures.map((failure) => `${failure.file} ${failure.name}`.trim()).join("\n"), sha256(keys), open,
    )];
  },
};

const count = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);

/** Open backlog items have piled up and the oldest one has waited long enough. */
const backlogOpen: CheckItem = {
  name: "backlog_open",
  run(context) {
    const minItems = count(context.params.min_items);
    const minAgeDays = count(context.params.min_age_days);
    const maxItems = count(context.params.max_items);
    if (minItems === null || minAgeDays === null || maxItems === null || maxItems < 1) return [];
    const rows = context.db.all<{ id: string; file: string; created_at: string }>(
      "SELECT id, file, created_at FROM backlog_items WHERE project_id = ? AND status = 'open' ORDER BY created_at, id", context.project.id,
    );
    if (rows.length === 0 || rows.length < minItems) return [];
    if (Date.parse(context.now) - Date.parse(rows[0]!.created_at) < minAgeDays * DAY_MS) return [];
    const picked = rows.slice(0, maxItems);
    const perFile = new Map<string, number>();
    for (const row of picked) perFile.set(row.file, (perFile.get(row.file) ?? 0) + 1);
    return [signal(
      context, "backlog_open", `バックログ ${rows.length} 件が未着手`,
      [...perFile].map(([file, total]) => `${file}: ${total} 件`).join("\n"), sha256(picked.map((row) => row.id)), picked.map((row) => row.id),
    )];
  },
};

/** Names from the settings are looked up with `Map.get`, so keys such as `toString` find nothing. */
export const CHECK_ITEMS: ReadonlyMap<string, CheckItem> = new Map([nightlyTestFailed, backlogOpen].map((item) => [item.name, item]));

export interface ScheduledCheckDeps {
  readonly db: CoreDatabase;
  readonly clock?: LibrarianSchedulerClock;
  /** A dependency, not the `start` sink, so a manual run can return what the service decided. */
  readonly receive: (signal: AutoWorkSignal) => Promise<AutoWorkReceiveResult>;
  readonly logger?: Pick<Console, "warn">;
}

interface ProjectCheck {
  readonly scheduler: LibrarianScheduler;
  config: EffectiveAutoWorkConfig;
  /** The local day of the last scheduled check; a changed time on the same day must not check twice. */
  day: string | null;
}

/** One LibrarianScheduler per Project runs that Project's check items at its configured times (design 3.3). */
export class ScheduledCheckTrigger implements AutoWorkTriggerSource {
  public readonly source = "scheduled_check" as const;
  private readonly projects = new Map<string, ProjectCheck>();

  public constructor(private readonly deps: ScheduledCheckDeps) {}

  public start(_sink: unknown, config: EffectiveAutoWorkConfig, projectId: string): void {
    if (this.projects.has(projectId)) return this.reconfigure(config, projectId);
    const state: ProjectCheck = {
      config, day: null,
      scheduler: new LibrarianScheduler({
        run: async () => {
          const day = localDayKey(this.now());
          if (state.day === day || !(state.config.enabled.effective && state.config.global_enabled.effective)) return;
          state.day = day;
          await this.check(projectId, state.config);
        },
        clock: this.deps.clock,
        logger: this.deps.logger,
      }),
    };
    this.projects.set(projectId, state);
    state.scheduler.start(config.scheduled_check.times);
  }

  public reconfigure(config: EffectiveAutoWorkConfig, projectId: string): void {
    const state = this.projects.get(projectId);
    if (!state) return;
    state.config = config;
    state.scheduler.reschedule(config.scheduled_check.times);
  }

  public async stop(): Promise<void> {
    const states = [...this.projects.values()];
    this.projects.clear();
    await Promise.allSettled(states.map((state) => state.scheduler.stop()));
  }

  /** Checks once now, even when today's scheduled check has run. */
  public async runNow(projectId: string): Promise<AutoWorkReceiveResult[]> {
    const state = this.projects.get(projectId);
    if (!state) throw invalidStateTransition("The scheduled check is not set up for this Project.", { project_id: projectId });
    return this.check(projectId, state.config);
  }

  private now(): Date {
    return this.deps.clock?.now() ?? new Date();
  }

  private async check(projectId: string, config: EffectiveAutoWorkConfig): Promise<AutoWorkReceiveResult[]> {
    const project = this.deps.db.get<{ id: string; name: string }>("SELECT id, name FROM projects WHERE id = ?", projectId);
    if (!project) return [];
    const results: AutoWorkReceiveResult[] = [];
    for (const name of config.scheduled_check.items) {
      try {
        const item = CHECK_ITEMS.get(name);
        if (!item) {
          this.deps.logger?.warn(`[owl-core] Unknown scheduled check item "${name}" for Project ${projectId}`);
          continue;
        }
        const params = findAutoWorkRule(config.rules, "scheduled_check", item.name)?.params ?? {};
        for (const found of item.run({ db: this.deps.db, project, params, now: this.now().toISOString() })) results.push(await this.deps.receive(found));
      } catch (error) {
        this.deps.logger?.warn(`[owl-core] Scheduled check item "${name}" failed for Project ${projectId}`, error);
      }
    }
    return results;
  }
}
