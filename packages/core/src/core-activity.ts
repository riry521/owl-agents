import { createUlid } from "../../db/dist/index.js";

export type CoreActivityKind = "integration_verification" | "core_tests" | "merge_verification" | "git_lane_wait" | "base_merge";
export type CoreActivityOutcome = "passed" | "failed" | "error" | "done";

/** One running piece of Core's background work, as the API shows it. */
export interface CoreActivityView {
  readonly activity_id: string;
  readonly kind: CoreActivityKind;
  readonly command: readonly string[] | null;
  readonly started_at: string;
  readonly last_output_at: string | null;
}

export interface CoreActivityHandle {
  /** The command that runs now; call again whenever it changes. */
  command(argv: readonly string[] | null): void;
  /** The running command wrote to stdout or stderr. */
  output(): void;
  /** Resolves once the completed event is written; never rejects. */
  end(outcome: CoreActivityOutcome): Promise<void>;
}

/** How Git and the workflow report a start; Core supplies the real one. */
export type CoreActivityReporter = (workId: string, kind: CoreActivityKind, command?: readonly string[] | null) => CoreActivityHandle;

const IDLE_HANDLE: CoreActivityHandle = { command: () => undefined, output: () => undefined, end: () => Promise.resolve() };
export const NO_CORE_ACTIVITY: CoreActivityReporter = () => IDLE_HANDLE;

export interface CoreActivityEventSink {
  write(event: { readonly type: string; readonly workId: string; readonly idempotencyKey: string; readonly payload: Record<string, unknown> }): Promise<void>;
}

/**
 * In-memory registry of Core's running background work plus the start and end events.
 * Deliberately not rebuilt from events: after a restart nothing may look "still running".
 */
export class CoreActivityRegistry {
  private readonly running = new Map<string, CoreActivityView & { readonly work_id: string }>();

  public constructor(private readonly sink: CoreActivityEventSink, private readonly now: () => Date = () => new Date()) {}

  public readonly report: CoreActivityReporter = (workId, kind, command = null) => {
    const activityId = createUlid();
    const startedAt = this.now();
    const entry = { work_id: workId, activity_id: activityId, kind, command, started_at: startedAt.toISOString(), last_output_at: null as string | null };
    this.running.set(activityId, entry);
    const started = this.emit("started", workId, activityId, { kind, command, started_at: entry.started_at });
    let ended = false;
    const update = (change: { command?: readonly string[] | null; last_output_at?: string }): void => {
      const current = this.running.get(activityId);
      if (current) this.running.set(activityId, { ...current, ...change });
    };
    return {
      command: (argv) => update({ command: argv }),
      output: () => update({ last_output_at: this.now().toISOString() }),
      end: async (outcome) => {
        if (ended) return;
        ended = true;
        this.running.delete(activityId);
        await started;
        const completedAt = this.now();
        await this.emit("completed", workId, activityId, {
          kind,
          started_at: entry.started_at,
          completed_at: completedAt.toISOString(),
          duration_ms: completedAt.getTime() - startedAt.getTime(),
          outcome,
        });
      },
    };
  };

  public list(workId: string): { readonly work_id: string; readonly activities: readonly CoreActivityView[] } {
    const activities = [...this.running.values()]
      .filter((entry) => entry.work_id === workId)
      .map(({ activity_id, kind, command, started_at, last_output_at }) => ({ activity_id, kind, command, started_at, last_output_at }));
    return { work_id: workId, activities };
  }

  private async emit(phase: "started" | "completed", workId: string, activityId: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.sink.write({
        type: `work.core_activity_${phase}`,
        workId,
        idempotencyKey: `work-core-activity:${activityId}:${phase}`,
        payload: { work_id: workId, activity_id: activityId, ...payload },
      });
    } catch (error) {
      console.warn(`[owl-core] Could not record core activity ${phase} for ${workId}`, error);
    }
  }
}
