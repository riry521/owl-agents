import { createUlid, utcNow, type WriteLane } from "@owl/db";
import { validationError } from "./errors";
import { LibrarianScheduler, localDayKey, parseLibrarianTime, type LibrarianSchedulerClock } from "./librarian-scheduler.js";
import {
  DEFAULT_NIGHTLY_TEST_TIME,
  NIGHTLY_TEST_SETTINGS_KEY,
  classifyNightlyRun,
  newNightlyFailures,
  nightlyBacklogEntries,
  nightlyError,
  type NightlyExecution,
  type NightlyRunSummary,
  type NightlyTestExecutor,
  type TestFailure,
} from "./nightly-tests.js";
import { ownerLanguage } from "./owner-language";
import { registerNightlyTestBacklogInTransaction } from "./review-backlog.js";
import { saveSetting, storedSettingJson, type SettingSaveSpec } from "./settings-store";
import type { CoreDatabase } from "./types";

const NIGHTLY_TEST_SETTING: SettingSaveSpec<{ time: string }, { time: string }> = {
  key: NIGHTLY_TEST_SETTINGS_KEY,
  validate: (value) => value,
  event: { type: "settings.nightly_tests_updated", idempotencyPrefix: "settings-nightly-tests" },
};

/** The Core members the nightly runner uses; Core passes its DB, write lane and test executor. */
export interface NightlyTestRunnerHost {
  readonly db: CoreDatabase;
  readonly writeLane: Pick<WriteLane, "write">;
  readonly executor: NightlyTestExecutor;
  readonly clock?: LibrarianSchedulerClock;
}

export class NightlyTestRunner {
  private readonly scheduler: LibrarianScheduler;
  private readonly abort = new AbortController();
  private running: Promise<NightlyRunSummary[]> | null = null;
  private scheduledDay: string | null = null;

  public constructor(private readonly host: NightlyTestRunnerHost) {
    this.scheduler = new LibrarianScheduler({
      run: async () => {
        // A time change after today's run must not run the tests a second time the same day.
        const day = localDayKey(host.clock?.now() ?? new Date());
        if (this.scheduledDay === day) return;
        this.scheduledDay = day;
        await this.run();
      },
      clock: host.clock,
    });
  }

  public start(): void {
    this.scheduler.start([this.readTime()]);
  }

  /** Aborts a running test command, then stops the scheduler. */
  public stop(): Promise<void> {
    this.abort.abort();
    return this.scheduler.stop();
  }

  private readTime(): string {
    const json = storedSettingJson(this.host.db, NIGHTLY_TEST_SETTINGS_KEY);
    try {
      const time: unknown = json !== undefined ? (JSON.parse(json) as { time?: unknown }).time : undefined;
      if (typeof time === "string" && parseLibrarianTime(time) !== null) return time;
    } catch {
      // fall through to the default
    }
    return DEFAULT_NIGHTLY_TEST_TIME;
  }

  public async getSettings(): Promise<{ time: string; next_run_at: string | null }> {
    return { time: this.readTime(), next_run_at: this.scheduler.nextRunAt()?.toISOString() ?? null };
  }

  public async updateSettings(input: { time: string }): Promise<{ time: string; next_run_at: string | null }> {
    if (typeof input?.time !== "string" || parseLibrarianTime(input.time) === null) {
      throw validationError("time must be HH:MM", { field: "time" }, { code: "nightly.time_invalid", values: { field: "time" } });
    }
    const time = input.time;
    await saveSetting(this.host.writeLane, NIGHTLY_TEST_SETTING, { time });
    this.scheduler.reschedule([time]);
    return this.getSettings();
  }

  /** Runs every Project's nightly test command once and backlogs the failures that were not in the previous run. */
  public run(): Promise<NightlyRunSummary[]> {
    this.running ??= this.runOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runOnce(): Promise<NightlyRunSummary[]> {
    const projects = this.host.db.all<{ id: string; name: string; canonical_path: string; base_branch: string; nightly_test_argv_json: string }>(
      "SELECT id, name, canonical_path, base_branch, nightly_test_argv_json FROM projects WHERE nightly_test_argv_json IS NOT NULL ORDER BY name, id",
    );
    const summaries: NightlyRunSummary[] = [];
    for (const row of projects) {
      if (this.abort.signal.aborted) break;
      try {
        const argv: unknown = JSON.parse(row.nightly_test_argv_json);
        const startedAt = utcNow();
        let execution: NightlyExecution;
        if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== "string")) {
          execution = nightlyError("nightly_test_command is not a non-empty array of strings");
        } else {
          try {
            execution = await this.host.executor(
              { id: row.id, name: row.name, canonical_path: row.canonical_path, base_branch: row.base_branch, argv: argv as string[] },
              this.abort.signal,
            );
          } catch (error) {
            execution = nightlyError(error instanceof Error ? error.message : String(error));
          }
        }
        if (this.abort.signal.aborted) break;
        summaries.push(await this.record(row, startedAt, execution));
      } catch (error) {
        // Why not stop: one Project's recording failure must not block the others; its result is absent from the summary, and the error is logged.
        console.warn(`[owl-core] Nightly test run failed for Project ${row.id}`, error);
      }
    }
    return summaries;
  }

  private async record(project: { id: string; name: string }, startedAt: string, execution: NightlyExecution): Promise<NightlyRunSummary> {
    const runId = createUlid();
    const status = classifyNightlyRun(execution);
    const error = status === "error"
      ? execution.error ?? (execution.exit_code === null ? "The test command did not finish" : `The test command exited with code ${execution.exit_code} without reporting a failed test`)
      : null;
    const result = await this.host.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        const previous = transaction.get<{ failures_json: string }>(
          "SELECT failures_json FROM nightly_test_runs WHERE project_id = ? AND status IN ('passed', 'failed') ORDER BY rowid DESC LIMIT 1",
          project.id,
        );
        const previousFailures = previous ? JSON.parse(previous.failures_json) as TestFailure[] : [];
        const failures = status === "failed" ? execution.failures : [];
        const added = newNightlyFailures(failures, previousFailures);
        const ids = registerNightlyTestBacklogInTransaction(transaction, project.id, nightlyBacklogEntries(added, ownerLanguage(transaction)), now);
        transaction.run(
          `INSERT INTO nightly_test_runs
             (id, project_id, status, base_commit, started_at, finished_at, exit_code, timed_out, failures_json,
              new_failure_count, backlog_item_ids_json, error, output_tail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          runId, project.id, status, execution.base_commit, startedAt, now, execution.exit_code, execution.timed_out ? 1 : 0,
          JSON.stringify(failures), added.length, JSON.stringify(ids), error, execution.output_tail,
        );
        return { project_id: project.id, run_id: runId, status, failure_count: failures.length, new_failure_count: added.length, backlog_item_ids: ids };
      },
      event: {
        idempotencyKey: `nightly-tests:${runId}`,
        type: "system.alert",
        payload: {
          kind: "nightly_tests_completed",
          schema_version: "1.0.0",
          project_id: project.id,
          run_id: runId,
          status,
          error,
          message: `Nightly tests (${project.name}): ${status}${error ? ` - ${error}` : ""}`,
        },
      },
      outbox: [{ provider: "websocket" }],
    });
    return result.state;
  }
}
