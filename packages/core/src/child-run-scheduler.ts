import { createUlid } from "../../db/dist/index.js";
import {
  CHILD_RUN_EFFORTS,
  CHILD_RUN_LIMITS,
  CHILD_RUN_PROVIDERS,
  tokenUsageOf,
  usageJson,
  type ChildDispatchRequest,
  type ChildDispatchResponse,
  type ChildRunBlockedReason,
  type ChildRunFailureKind,
  type ChildRunListFilter,
  type ChildRunRecord,
  type ChildRunSettings,
  type ChildRunSummary,
  type ChildWaitItem,
  type ChildWaitRequest,
  type ChildWaitResponse,
  type ExecutorResult,
  type ExecutorTask,
  type ExecutorTaskContext,
  type TokenUsage,
} from "@owl/shared";
import { HumanReadableError, validationError } from "./errors.js";
import { normalizeWritePaths, runExecutorProcess, writeScopesOverlap, type ExecutorRunObserver, type ExecutorRuntime } from "./executor.js";
import type { ProviderPauseController } from "./provider-pause-controller.js";
import { readProcessIdentity } from "./process-identity.js";
import type { CoreDatabase, CoreWriteLaneTransaction } from "./types.js";

export interface ChildRunParentContext {
  readonly agent_run_id: string;
  readonly work_id: string;
  readonly task_id: string;
  readonly project_id?: string;
  readonly harness: "claude" | "codex";
  readonly workspace_dir: string;
  readonly worktree: string | null;
  readonly task: ExecutorTaskContext;
  readonly process_skills_dir?: string;
  readonly process_skills_source?: "setting" | "claude" | "codex";
}

export interface ChildRunScheduler {
  registerParent(context: ChildRunParentContext): void;
  /** Stops every unfinished child and returns all of the parent's child runs once the processes have ended. */
  releaseParent(parentAgentRunId: string, reason: "parent_ended" | "parent_cancelled"): Promise<readonly ChildRunRecord[]>;
  dispatch(parentAgentRunId: string, request: ChildDispatchRequest, requestKey: string): Promise<ChildDispatchResponse>;
  wait(parentAgentRunId: string, request: ChildWaitRequest, signal: AbortSignal): Promise<ChildWaitResponse>;
  list(filter: ChildRunListFilter): ChildRunRecord[];
  /** Re-evaluates the queue (after a dispatch, a child ending, a provider resuming or a settings change). */
  pump(): void;
  stop(): Promise<void>;
}

export interface ChildRunSchedulerOptions {
  readonly db: CoreDatabase;
  readonly writeLane: ReturnType<CoreDatabase["createWriteLane"]>;
  readonly now?: () => Date;
  readonly executorRuntime: () => Promise<ExecutorRuntime> | ExecutorRuntime;
  readonly providerPauseController?: ProviderPauseController;
  readonly settings: () => ChildRunSettings;
  /** Called whenever a child or the parent's wait/dispatch shows life, so the Worker is not flagged stale. */
  readonly onParentActivity: (parentAgentRunId: string) => void;
}

interface ChildRow {
  id: string; work_id: string; task_id: string; parent_agent_run_id: string; seq: number; title: string;
  instruction: string; write_paths_json: string; workspace_dir: string; provider: "claude" | "codex"; model: string;
  effort: ChildRunRecord["effort"]; timeout_ms: number; max_attempts: number; attempt: number; rate_limit_requeues: number;
  status: ChildRunRecord["status"]; blocked_reason: ChildRunBlockedReason | null; current_agent_run_id: string | null;
  summary_json: string | null; report_text: string | null; failure_kind: ChildRunFailureKind | null;
  failure_reason: string | null; created_at: string; started_at: string | null; finished_at: string | null; updated_at: string;
}

const ACTIVE_PARENT_STATUSES = ["launch_pending", "spawned", "running"];
const RETRYABLE: readonly ChildRunFailureKind[] = ["idle_timeout", "exit_code", "no_final_report", "spawn_error"];
const OUTPUT_TOUCH_INTERVAL_MS = 5_000;
const RELEASE_WAIT_MS = 35_000;
const TERMINAL = ["completed", "failed", "cancelled"];

function childError(code: string, message: string): HumanReadableError {
  return new HumanReadableError({ code, message, remediation: "Check the request and the current child run state, then try again." });
}

const cut = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value);
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Builds the short report the parent sees from a child's final report (or its failure). */
export function summarizeChildReport(
  report: string,
  outcome: { success: boolean; failure_kind: ChildRunFailureKind | null; failure_reason: string | null },
  attempts: number,
  durationSeconds: number,
): ChildRunSummary {
  const limits = CHILD_RUN_LIMITS;
  const blocks = [...report.matchAll(/```owl-child-report[ \t]*\r?\n([\s\S]*?)```/gu)];
  let parsed: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(blocks.at(-1)?.[1] ?? "");
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch { /* fall back below */ }
  const strings = (value: unknown): string[] | null =>
    Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : null;
  const checks = Array.isArray(parsed?.checks) ? parsed.checks : null;
  const structured = parsed !== null
    && (parsed.result === "succeeded" || parsed.result === "partial" || parsed.result === "failed")
    && typeof parsed.summary === "string"
    && strings(parsed.changed_files) !== null
    && strings(parsed.remaining_issues) !== null
    && checks !== null
    && checks.every((check) => check && typeof check === "object" && typeof check.command === "string" && typeof check.passed === "boolean");
  const failure = outcome.success || outcome.failure_kind === null
    ? null
    : { kind: outcome.failure_kind, reason: cut(outcome.failure_reason ?? "", limits.failure_reason_max_chars) };
  const files = structured ? strings(parsed!.changed_files)!.map((file) => cut(file, 200)) : [];
  const summary = {
    result: structured ? parsed!.result as ChildRunSummary["result"] : outcome.success ? "succeeded" as const : "failed" as const,
    summary: cut(structured ? parsed!.summary as string : report.trim() || (failure?.reason ?? ""), limits.summary_max_chars),
    changed_files: files.length > limits.changed_files_max
      ? [...files.slice(0, limits.changed_files_max - 1), `…(+${files.length - limits.changed_files_max + 1} more)`]
      : files,
    checks: structured
      ? (checks as { command: string; passed: boolean }[]).slice(0, limits.checks_max).map((check) => ({ command: cut(check.command, 200), passed: check.passed }))
      : [],
    remaining_issues: structured ? strings(parsed!.remaining_issues)!.slice(0, limits.remaining_issues_max).map((issue) => cut(issue, 300)) : [],
    failure,
    attempts,
    duration_seconds: durationSeconds,
    report_format: structured ? "structured" as const : "fallback" as const,
  };
  while (bytes(summary) > limits.child_summary_max_bytes) {
    if (summary.summary.length > 0) summary.summary = summary.summary.slice(0, Math.floor(summary.summary.length / 2));
    else if (summary.remaining_issues.length > 0) summary.remaining_issues = summary.remaining_issues.slice(0, -1);
    else if (summary.changed_files.length > 0) summary.changed_files = summary.changed_files.slice(0, -1);
    else if (summary.checks.length > 0) summary.checks = summary.checks.slice(0, -1);
    else break;
  }
  return summary;
}

function toRecord(row: ChildRow): ChildRunRecord {
  const terminal = TERMINAL.includes(row.status);
  const summary: ChildRunSummary | null = row.summary_json
    ? JSON.parse(row.summary_json) as ChildRunSummary
    : terminal
      ? summarizeChildReport("", { success: false, failure_kind: row.failure_kind, failure_reason: row.failure_reason }, row.attempt,
        row.started_at && row.finished_at ? Math.max(0, Math.round((Date.parse(row.finished_at) - Date.parse(row.started_at)) / 1000)) : 0)
      : null;
  const { write_paths_json, summary_json, workspace_dir, rate_limit_requeues, ...rest } = row;
  void summary_json; void workspace_dir; void rate_limit_requeues;
  return { ...rest, write_paths: JSON.parse(write_paths_json) as string[], summary };
}

/** Validates the Worker's write_paths: workspace-relative, no `..`, no wildcards (except a lone `*`). */
function cleanWritePaths(paths: readonly string[]): string[] {
  const cleaned = paths.map((path) => {
    const value = path.trim().replaceAll("\\", "/");
    const parts = value.split("/").filter((part) => part.length > 0 && part !== ".");
    if (
      value.length === 0 || value.startsWith("/") || /^[A-Za-z]:/u.test(value) || parts.length === 0 ||
      parts.includes("..") || (value !== "*" && /[*?[\]{}]/u.test(value))
    ) throw childError("write_paths_invalid", `write_paths entry "${path}" must be a workspace-relative file or directory without "..", wildcards or absolute paths.`);
    return parts.join("/");
  });
  return [...new Set(cleaned)];
}

/** Backward-compatible overload while Core callers move to the shared write lane. */
export function createChildRunScheduler(options: Omit<ChildRunSchedulerOptions, "writeLane">): ChildRunScheduler;
export function createChildRunScheduler(options: ChildRunSchedulerOptions): ChildRunScheduler;
export function createChildRunScheduler(options: ChildRunSchedulerOptions | Omit<ChildRunSchedulerOptions, "writeLane">): ChildRunScheduler {
  const { db } = options;
  const writeLane = "writeLane" in options ? options.writeLane : db.createWriteLane();
  const timestamp = (): string => (options.now?.() ?? new Date()).toISOString();
  const parents = new Map<string, ChildRunParentContext>();
  const controllers = new Map<string, AbortController>();
  const abortKinds = new Map<string, ChildRunFailureKind>();
  const runs = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  let cancelTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let pumpChain: Promise<void> = Promise.resolve();

  function readSettings(): ChildRunSettings {
    const settings = options.settings();
    const isProvider = (value: unknown): value is ChildRunSettings["default_provider"] =>
      typeof value === "string" && (CHILD_RUN_PROVIDERS as readonly string[]).includes(value);
    const isEffort = (value: unknown): value is NonNullable<ChildRunSettings["default_effort"]> =>
      typeof value === "string" && (CHILD_RUN_EFFORTS as readonly string[]).includes(value);
    const models = settings?.allowed_models;
    const efforts = settings?.allowed_efforts;
    const defaults = settings?.defaults_by_parent_harness;
    if (
      !Array.isArray(models) || models.length === 0 || models.length > 20 || models.some((item) =>
        !item || !isProvider(item.provider) || typeof item.model !== "string" || item.model.length === 0 || item.model !== item.model.trim(),
      ) || !isProvider(settings.default_provider) || typeof settings.default_model !== "string" ||
      !models.some((item) => item.provider === settings.default_provider && item.model === settings.default_model) ||
      !Array.isArray(efforts) || efforts.length < 1 || efforts.length > 5 || efforts.some((effort) => !isEffort(effort)) ||
      (settings.default_effort !== null && (!isEffort(settings.default_effort) || !efforts.includes(settings.default_effort))) ||
      !defaults || !(CHILD_RUN_PROVIDERS as readonly string[]).every((harness) => {
        const choice = defaults[harness as keyof typeof defaults];
        return choice && isProvider(choice.provider) && typeof choice.model === "string" &&
          models.some((item) => item.provider === choice.provider && item.model === choice.model) &&
          (choice.effort === null || (isEffort(choice.effort) && efforts.includes(choice.effort)));
      }) ||
      !Number.isSafeInteger(settings.timeout_minutes) || settings.timeout_minutes < 5 ||
      !Number.isSafeInteger(settings.max_timeout_minutes) || settings.max_timeout_minutes < settings.timeout_minutes || settings.max_timeout_minutes > 1440 ||
      !Number.isSafeInteger(settings.max_attempts) || settings.max_attempts < 1 || settings.max_attempts > 3
    ) {
      throw childError("child_run_settings_invalid", "Child run settings contain invalid defaults, limits or allowlists.");
    }
    return settings;
  }

  const notify = (): void => { for (const listener of [...listeners]) listener(); };
  const row = (id: string): ChildRow | undefined => db.get<ChildRow>("SELECT * FROM child_runs WHERE id = ?", id);

  const finishedEvent = (r: ChildRow, status: string, kind: ChildRunFailureKind | null, result: string | null) => ({
    idempotencyKey: `child-run-finished:${r.id}`,
    type: "child_run.finished",
    workId: r.work_id,
    taskId: r.task_id,
    payload: { child_run_id: r.id, parent_agent_run_id: r.parent_agent_run_id, status, result, failure_kind: kind, attempts: r.attempt },
  });

  /** Ends a child for good: terminal status, summary and the finished event. */
  async function settle(
    r: ChildRow,
    status: "completed" | "failed" | "cancelled",
    outcome: { success: boolean; failure_kind: ChildRunFailureKind | null; failure_reason: string | null; report: string },
  ): Promise<void> {
    const now = timestamp();
    const startedAt = r.started_at ?? now;
    const summary = summarizeChildReport(outcome.report, outcome, r.attempt, Math.max(0, Math.round((Date.parse(now) - Date.parse(startedAt)) / 1000)));
    await writeLane.write({
      mutateState: (tx) => tx.run(
        `UPDATE child_runs SET status = ?, blocked_reason = NULL, finished_at = ?, updated_at = ?, summary_json = ?, report_text = ?,
                failure_kind = ?, failure_reason = ?
          WHERE id = ? AND status IN ('queued', 'running')`,
        status, now, now, JSON.stringify(summary), outcome.report.length > 0 ? outcome.report : null,
        outcome.failure_kind, outcome.failure_reason === null ? null : cut(outcome.failure_reason, CHILD_RUN_LIMITS.failure_reason_max_chars), r.id,
      ).changes,
      event: finishedEvent(r, status, outcome.failure_kind, summary.result),
      outbox: [{ provider: "websocket" }],
    });
    notify();
  }

  const cancelQueued = async (r: ChildRow, kind: ChildRunFailureKind): Promise<void> =>
    settle(r, "cancelled", { success: false, failure_kind: kind, failure_reason: kind === "parent_ended" ? "The Worker finished before this child ran." : "The Worker was cancelled.", report: "" });

  /** Records one attempt as an AgentRun (role executor, child of the Worker run). */
  async function track(r: ChildRow, parent: ChildRunParentContext, controller: AbortController): Promise<ExecutorRunObserver & { agent_run_id: string }> {
    const runId = createUlid();
    const previous = r.attempt > 1
      ? db.get<{ id: string }>("SELECT id FROM agent_runs WHERE child_run_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", r.id)?.id ?? null
      : null;
    await writeLane.write({
      mutateState: (tx: CoreWriteLaneTransaction) => {
        const now = timestamp();
        tx.run(
          `INSERT INTO agent_runs
             (id, work_id, task_id, parent_agent_id, role, origin, provider, model, effort, status, label, child_run_id,
              retry_of_run_id, started_at, last_output_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'executor', 'spawned', ?, ?, ?, 'launch_pending', ?, ?, ?, ?, ?, ?, ?)`,
          runId, r.work_id, r.task_id, r.parent_agent_run_id, r.provider, r.model, r.effort, r.title, r.id, previous, now, now, now, now,
        );
        tx.run("UPDATE child_runs SET current_agent_run_id = ?, updated_at = ? WHERE id = ?", runId, now, r.id);
        tx.run("UPDATE agent_runs SET last_output_at = ?, updated_at = ? WHERE id = ?", now, now, r.parent_agent_run_id);
        return runId;
      },
      event: {
        idempotencyKey: `executor-started:${runId}`,
        type: "executor.started",
        workId: r.work_id,
        taskId: r.task_id,
        agentRunId: runId,
        payload: { agent_run_id: runId, parent_agent_run_id: parent.agent_run_id, child_run_id: r.id, subtask_id: r.id, label: r.title, attempt: r.attempt },
      },
      outbox: [{ provider: "websocket" }],
    });
    let lastTouch = 0;
    return {
      agent_run_id: runId,
      signal: controller.signal,
      ...(r.attempt > 1 && r.failure_kind ? { retry: { failure_kind: r.failure_kind, failure_reason: r.failure_reason ?? "" } } : {}),
      onSpawn: (pid) => {
        const identity = readProcessIdentity(pid);
        void writeLane.transact((tx) => {
          const now = timestamp();
          tx.run(
            `UPDATE agent_runs SET pid = ?, process_start_time = ?, process_cmdline_sha256 = ?,
                    status = CASE WHEN status IN ('launch_pending','spawned') THEN 'running' ELSE status END, updated_at = ?
              WHERE id = ? AND status IN ('launch_pending','spawned','running','cancel_requested')`,
            pid, identity.process_start_time, identity.process_cmdline_sha256, now, runId,
          );
          return runId;
        }).catch((error) => console.error(`[owl-core] Failed to persist child pid for ${runId}`, error));
      },
      onOutput: () => {
        const nowMs = Date.now();
        if (nowMs - lastTouch < OUTPUT_TOUCH_INTERVAL_MS) return;
        lastTouch = nowMs;
        options.onParentActivity(r.parent_agent_run_id);
        void writeLane.transact((tx) => {
          const now = timestamp();
          tx.run("UPDATE agent_runs SET last_output_at = ?, updated_at = ? WHERE id = ? AND status IN ('launch_pending','spawned','running','cancel_requested')", now, now, runId);
          return runId;
        }).catch((error) => console.error(`[owl-core] Failed to persist child output activity ${runId}`, error));
      },
    };
  }

  /** Closes the attempt's AgentRun; resolves true when it had been cancelled. */
  async function finishAgentRun(r: ChildRow, runId: string, result: ExecutorResult, usage: TokenUsage | null): Promise<boolean> {
    const normalized = tokenUsageOf(usage);
    const written = await writeLane.write({
      mutateState: (tx: CoreWriteLaneTransaction) => {
        const now = timestamp();
        const current = tx.get<{ status: string }>("SELECT status FROM agent_runs WHERE id = ?", runId);
        const cancelled = current?.status === "cancel_requested" || current?.status === "cancelled";
        const status = cancelled ? "cancelled" : result.success ? "completed" : "failed";
        tx.run(
          `UPDATE agent_runs SET status = ?, outcome = ?, pid = NULL, ended_at = COALESCE(ended_at, ?), updated_at = ?,
                  usage_json = COALESCE(?, usage_json)
            WHERE id = ? AND status IN ('launch_pending','spawned','running','cancel_requested')`,
          status, status === "completed" ? "success" : null, now, now, usageJson(usage), runId,
        );
        return { cancelled };
      },
      event: {
        idempotencyKey: `executor-finished:${runId}`,
        type: result.success ? "executor.completed" : "executor.failed",
        workId: r.work_id,
        taskId: r.task_id,
        agentRunId: runId,
        payload: {
          agent_run_id: runId, parent_agent_run_id: r.parent_agent_run_id, child_run_id: r.id, subtask_id: r.id,
          success: result.success, exit_code: result.exit_code, duration_ms: result.duration_ms,
          ...(normalized ? { usage: { ...normalized } } : {}),
        },
      },
      outbox: [{ provider: "websocket" }],
    });
    if (!written.state.cancelled && result.success) {
      await options.providerPauseController?.noteProviderSucceeded(r.provider, r.created_at);
    }
    return written.state.cancelled;
  }

  async function requeue(r: ChildRow, patch: { attempt: number; requeues: number; kind: ChildRunFailureKind | null; reason: string | null; blocked: ChildRunBlockedReason | null }): Promise<void> {
    const now = timestamp();
    await writeLane.transact((tx) => {
      tx.run(
        `UPDATE child_runs SET status = 'queued', blocked_reason = ?, attempt = ?, rate_limit_requeues = ?,
                failure_kind = COALESCE(?, failure_kind), failure_reason = COALESCE(?, failure_reason), updated_at = ?
          WHERE id = ? AND status = 'running'`,
        patch.blocked, patch.attempt, patch.requeues, patch.kind, patch.reason === null ? null : cut(patch.reason, CHILD_RUN_LIMITS.failure_reason_max_chars), now, r.id,
      );
      return r.id;
    });
  }

  async function handleAttemptFailure(r: ChildRow, kind: ChildRunFailureKind, reason: string, report: string): Promise<void> {
    if (RETRYABLE.includes(kind) && r.attempt < r.max_attempts) {
      await requeue(r, { attempt: r.attempt, requeues: r.rate_limit_requeues, kind, reason, blocked: null });
    } else {
      await settle(r, "failed", { success: false, failure_kind: kind, failure_reason: reason, report });
    }
  }

  async function runChild(r: ChildRow, controller: AbortController): Promise<void> {
    const parent = parents.get(r.parent_agent_run_id);
    let observer: (ExecutorRunObserver & { agent_run_id: string }) | undefined;
    try {
      if (!parent) {
        await settle(r, "cancelled", { success: false, failure_kind: "parent_ended", failure_reason: "The Worker is no longer running.", report: "" });
        return;
      }
      const sink: { usage: TokenUsage | null } = { usage: null };
      observer = await track(r, parent, controller);
      const task: ExecutorTask = {
        subtask_id: r.id,
        work_id: parent.work_id,
        task_id: parent.task_id,
        ...(parent.project_id ? { project_id: parent.project_id } : {}),
        instruction: r.instruction,
        workspace_dir: r.workspace_dir,
        task: parent.task,
        write_paths: JSON.parse(r.write_paths_json) as string[],
        worktree: parent.worktree,
        ...(parent.process_skills_dir ? { process_skills_dir: parent.process_skills_dir } : {}),
        ...(parent.process_skills_source ? { process_skills_source: parent.process_skills_source } : {}),
      };
      const result = await runExecutorProcess(
        task,
        { provider: r.provider, model: r.model, ...(r.effort ? { effort: r.effort } : {}), timeout_ms: r.timeout_ms },
        observer, sink, await options.executorRuntime(),
      );
      const cancelled = (await finishAgentRun(r, observer.agent_run_id, result, sink.usage)) || controller.signal.aborted;
      const kind = result.failure_kind ?? "spawn_error";
      if (cancelled) {
        await settle(r, "cancelled", { success: false, failure_kind: abortKinds.get(r.id) ?? "cancelled", failure_reason: "The child run was cancelled.", report: result.output });
      } else if (result.success) {
        await settle(r, "completed", { success: true, failure_kind: null, failure_reason: null, report: result.output });
      } else if (result.rate_limit && r.rate_limit_requeues < CHILD_RUN_LIMITS.rate_limit_requeue_max) {
        await options.providerPauseController?.recordRateLimit({
          provider: r.provider, resets_at: result.rate_limit.resets_at, role: "executor", work_id: r.work_id, task_id: r.task_id,
        });
        await requeue(r, { attempt: r.attempt - 1, requeues: r.rate_limit_requeues + 1, kind: null, reason: null, blocked: "provider_paused" });
      } else if (result.rate_limit) {
        await settle(r, "failed", { success: false, failure_kind: "rate_limited", failure_reason: result.output, report: result.output });
      } else {
        await handleAttemptFailure(r, kind, result.output, result.output);
      }
    } catch (error) {
      console.error(`[owl-core] Child run ${r.id} failed unexpectedly`, error);
      const reason = error instanceof Error ? error.message : String(error);
      const cancelled = observer
        ? await finishAgentRun(r, observer.agent_run_id, {
          subtask_id: r.id, success: false, output: reason, exit_code: -1, duration_ms: 0, failure_kind: "spawn_error",
        }, null)
        : false;
      if (cancelled || controller.signal.aborted) {
        await settle(r, "cancelled", { success: false, failure_kind: abortKinds.get(r.id) ?? "cancelled", failure_reason: "The child run was cancelled.", report: "" })
          .catch((settleError) => console.error(`[owl-core] Could not close child run ${r.id}`, settleError));
        return;
      }
      await handleAttemptFailure(r, "spawn_error", reason, "")
        .catch((settleError) => console.error(`[owl-core] Could not close child run ${r.id}`, settleError));
    } finally {
      controllers.delete(r.id);
      abortKinds.delete(r.id);
      runs.delete(r.id);
      if (controllers.size === 0 && cancelTimer) { clearInterval(cancelTimer); cancelTimer = undefined; }
      notify();
      pump();
    }
  }

  /** A Task cancellation marks child AgentRuns cancel_requested; stop their processes. */
  function watchCancellations(): void {
    if (cancelTimer) return;
    cancelTimer = setInterval(() => {
      for (const { child_run_id } of db.all<{ child_run_id: string }>(
        "SELECT child_run_id FROM agent_runs WHERE child_run_id IS NOT NULL AND status = 'cancel_requested'",
      )) controllers.get(child_run_id)?.abort();
    }, 1000);
    cancelTimer.unref();
  }

  async function pumpOnce(): Promise<void> {
    if (stopped) return;
    const settings = readSettings();
    const running = db.all<ChildRow>("SELECT * FROM child_runs WHERE status = 'running'");
    const scopeOf = (r: ChildRow): readonly string[] => normalizeWritePaths({ write_paths: JSON.parse(r.write_paths_json) as string[] });
    const ahead: ChildRow[] = [];
    for (const r of db.all<ChildRow>("SELECT * FROM child_runs WHERE status = 'queued' ORDER BY created_at, seq")) {
      const scope = scopeOf(r);
      const sameDir = (other: ChildRow): boolean => other.workspace_dir === r.workspace_dir && writeScopesOverlap(scope, scopeOf(other));
      const blocked: ChildRunBlockedReason | null =
        options.providerPauseController?.isPaused(r.provider) ? "provider_paused"
        : running.some(sameDir) || ahead.some(sameDir) ? "write_scope"
        : null;
      if (blocked) {
        if (blocked !== r.blocked_reason) {
          await writeLane.transact((tx) => tx.run("UPDATE child_runs SET blocked_reason = ?, updated_at = ? WHERE id = ? AND status = 'queued'", blocked, timestamp(), r.id));
        }
        ahead.push(r);
        continue;
      }
      const now = timestamp();
      await writeLane.transact((tx) => tx.run(
        "UPDATE child_runs SET status = 'running', blocked_reason = NULL, attempt = attempt + 1, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'queued'",
        now, now, r.id,
      ));
      const started = row(r.id)!;
      running.push(started);
      const controller = new AbortController();
      controllers.set(r.id, controller);
      watchCancellations();
      runs.set(r.id, runChild(started, controller));
    }
    notify();
  }

  function pump(): void {
    pumpChain = pumpChain.then(pumpOnce).catch((error) => console.error("[owl-core] Child run scheduling failed", error));
  }

  const checkParent = (parentId: string): ChildRunParentContext => {
    const parent = parents.get(parentId);
    const agent = db.get<{ role: string; status: string }>("SELECT role, status FROM agent_runs WHERE id = ?", parentId);
    const task = parent ? db.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", parent.task_id) : undefined;
    if (!parent || agent?.role !== "worker" || !ACTIVE_PARENT_STATUSES.includes(agent.status) || task?.status !== "running") {
      throw childError("parent_not_active", "The Worker is not running, so it cannot dispatch or wait for child agents.");
    }
    options.onParentActivity(parentId);
    return parent;
  };

  const response = (r: ChildRow): ChildDispatchResponse => ({
    child_id: r.id,
    status: r.status === "running" ? "running" : "queued",
    blocked_reason: r.blocked_reason,
    provider: r.provider,
    model: r.model,
    effort: r.effort,
    timeout_minutes: Math.round(r.timeout_ms / 60_000),
    max_attempts: r.max_attempts,
  });

  function resolveChoice(request: ChildDispatchRequest, parent: ChildRunParentContext, settings: ChildRunSettings): { provider: "claude" | "codex"; model: string; effort: ChildRunRecord["effort"] } {
    const allowed = settings.allowed_models;
    if (request.provider !== undefined && !(CHILD_RUN_PROVIDERS as readonly string[]).includes(request.provider)) {
      throw childError("model_not_allowed", `Provider ${request.provider} is not in the allowed list.`);
    }
    const parentDefault = settings.defaults_by_parent_harness[parent.harness];
    const choice = {
      provider: request.provider ?? parentDefault.provider,
      model: request.model ?? parentDefault.model,
      effort: request.effort ?? parentDefault.effort,
    };
    if (!allowed.some((item) => item.provider === choice.provider && item.model === choice.model)) {
      throw childError("model_not_allowed", `The provider/model ${request.provider ?? "(default)"}/${request.model ?? "(default)"} is not in the allowed list.`);
    }
    if (choice.effort !== null && (!(CHILD_RUN_EFFORTS as readonly string[]).includes(choice.effort) || !settings.allowed_efforts.includes(choice.effort))) {
      throw childError("effort_not_allowed", `Effort ${request.effort} is not in the allowed list.`);
    }
    return choice;
  }

  return {
    registerParent(context) { parents.set(context.agent_run_id, context); },

    pump,

    list(filter) {
      return db.all<ChildRow>(
        `SELECT * FROM child_runs WHERE (? IS NULL OR work_id = ?) AND (? IS NULL OR task_id = ?) AND (? IS NULL OR parent_agent_run_id = ?)
          ORDER BY created_at, seq`,
        filter.work_id ?? null, filter.work_id ?? null, filter.task_id ?? null, filter.task_id ?? null,
        filter.parent_agent_run_id ?? null, filter.parent_agent_run_id ?? null,
      ).map(toRecord);
    },

    async dispatch(parentId, request, requestKey) {
      const parent = checkParent(parentId);
      if (typeof requestKey !== "string" || requestKey.trim().length === 0) throw validationError("A non-empty request key is required.");
      const existing = db.get<ChildRow>("SELECT * FROM child_runs WHERE parent_agent_run_id = ? AND request_key = ?", parentId, requestKey);
      if (existing) return response(existing);
      const limits = CHILD_RUN_LIMITS;
      if (
        typeof request.title !== "string" || request.title.trim().length === 0 || request.title.length > limits.title_max_chars ||
        typeof request.instruction !== "string" || request.instruction.trim().length === 0 || request.instruction.length > limits.instruction_max_chars ||
        !Array.isArray(request.write_paths) || request.write_paths.length === 0 || request.write_paths.length > limits.write_paths_max ||
        request.write_paths.some((path) => typeof path !== "string")
      ) throw validationError("title, instruction and write_paths are required and must be within their size limits.");
      const settings = readSettings();
      const { provider, model, effort } = resolveChoice(request, parent, settings);
      const timeoutMinutes = request.timeout_minutes ?? settings.timeout_minutes;
      if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 5 || timeoutMinutes > settings.max_timeout_minutes) {
        throw childError("timeout_out_of_range", `timeout_minutes must be an integer from 5 to ${settings.max_timeout_minutes}.`);
      }
      const writePaths = cleanWritePaths(request.write_paths);
      const id = createUlid();
      await writeLane.write({
        mutateState: (tx) => {
          const count = tx.get<{ n: number; max_seq: number }>("SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS max_seq FROM child_runs WHERE parent_agent_run_id = ?", parentId)!;
          if (count.n >= limits.max_children_per_parent) {
            throw childError("too_many_children", `A Worker can dispatch at most ${limits.max_children_per_parent} child agents.`);
          }
          const now = timestamp();
          tx.run(
            `INSERT INTO child_runs (id, work_id, task_id, parent_agent_run_id, seq, request_key, title, instruction, write_paths_json, workspace_dir,
                                     provider, model, effort, timeout_ms, max_attempts, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
            id, parent.work_id, parent.task_id, parentId, count.max_seq + 1, requestKey, request.title.trim(), request.instruction,
            JSON.stringify(writePaths), parent.workspace_dir, provider, model, effort, timeoutMinutes * 60_000, settings.max_attempts, now, now,
          );
        },
        event: {
          idempotencyKey: `child-run-dispatched:${id}`,
          type: "child_run.dispatched",
          workId: parent.work_id,
          taskId: parent.task_id,
          payload: { child_run_id: id, parent_agent_run_id: parentId, title: request.title.trim(), provider, model, effort, write_paths: writePaths, status: "queued", blocked_reason: null },
        },
        outbox: [{ provider: "websocket" }],
      });
      pump();
      await pumpChain;
      return response(row(id)!);
    },

    async wait(parentId, request, signal) {
      checkParent(parentId);
      if (
        !Array.isArray(request.child_ids) || request.child_ids.length === 0 || request.child_ids.length > CHILD_RUN_LIMITS.wait_max_ids ||
        request.child_ids.some((id) => typeof id !== "string" || id.trim().length === 0)
      ) throw validationError(`child_ids must contain between 1 and ${CHILD_RUN_LIMITS.wait_max_ids} child IDs.`);
      if (request.return_when !== undefined && request.return_when !== "all" && request.return_when !== "any") {
        throw validationError("return_when must be 'all' or 'any'.");
      }
      const requestedTimeout = request.timeout_seconds ?? CHILD_RUN_LIMITS.wait_max_seconds;
      if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 0) {
        throw validationError("timeout_seconds must be a non-negative integer.");
      }
      const ids = [...new Set(request.child_ids)];
      const read = (): ChildRow[] => ids.map((id) => {
        const found = row(id);
        if (!found || found.parent_agent_run_id !== parentId) throw childError("child_not_found", `Child ${id} was not found for this Worker.`);
        return found;
      });
      read();
      const timeoutMs = Math.min(requestedTimeout, CHILD_RUN_LIMITS.wait_max_seconds) * 1000;
      const deadline = Date.now() + timeoutMs;
      const satisfied = (rows: ChildRow[]): boolean => request.return_when === "any"
        ? rows.some((r) => TERMINAL.includes(r.status))
        : rows.every((r) => TERMINAL.includes(r.status));
      let rows = read();
      while (!satisfied(rows) && !signal.aborted && Date.now() < deadline) {
        options.onParentActivity(parentId);
        await new Promise<void>((resolve) => {
          const done = (): void => { clearTimeout(timer); listeners.delete(done); signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, Math.min(deadline - Date.now(), 1000));
          listeners.add(done);
          signal.addEventListener("abort", done, { once: true });
        });
        rows = read();
      }
      const children: ChildWaitItem[] = rows.map((r) => {
        const record = toRecord(r);
        return { child_id: r.id, title: r.title, status: r.status, blocked_reason: r.blocked_reason, attempt: r.attempt, summary: record.summary, summary_omitted: false };
      });
      const done = satisfied(rows);
      let truncated = false;
      const responseBytes = (): number => bytes({ done, truncated, children });
      for (let i = children.length - 1; i >= 0 && responseBytes() > CHILD_RUN_LIMITS.wait_response_max_bytes; i--) {
        if (children[i].summary === null) continue;
        children[i] = { ...children[i], summary: null, summary_omitted: true };
        truncated = true;
      }
      return { done, truncated, children };
    },

    async releaseParent(parentId, reason) {
      const kind: ChildRunFailureKind = reason === "parent_ended" ? "parent_ended" : "cancelled";
      parents.delete(parentId);
      for (const r of db.all<ChildRow>("SELECT * FROM child_runs WHERE parent_agent_run_id = ? AND status = 'queued'", parentId)) await cancelQueued(r, kind);
      const active = db.all<{ id: string }>("SELECT id FROM child_runs WHERE parent_agent_run_id = ? AND status = 'running'", parentId).map((r) => r.id);
      for (const id of active) { abortKinds.set(id, kind); controllers.get(id)?.abort(); }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(active.map((id) => runs.get(id))),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, RELEASE_WAIT_MS); timer.unref(); }),
      ]);
      clearTimeout(timer);
      return this.list({ parent_agent_run_id: parentId });
    },

    async stop() {
      stopped = true;
      for (const [id, controller] of controllers) { abortKinds.set(id, "cancelled"); controller.abort(); }
      await pumpChain;
      await Promise.all([...runs.values()]);
      if (cancelTimer) { clearInterval(cancelTimer); cancelTimer = undefined; }
    },
  };
}
