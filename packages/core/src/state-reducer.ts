import { createHash } from "node:crypto";
import { createUlid, utcNow } from "../../db/dist/index.js";
import { usageJson } from "@owl/shared";
import { HumanReadableError, invalidStateTransition, notFound, validationError, versionConflict } from "./errors";
import {
  DECISION_CANCEL_OPTION_KEY,
  assertDecisionBrief,
  coreTaskDecisionBrief,
  coreWorkDecisionBrief,
  type DecisionBrief,
} from "./decision-brief";
import { ownerLanguage } from "./owner-language";
import { findDependencyCycle, type ReplanPlan } from "./replan-plan";
import type {
  CoreWriteLaneTransaction,
  CreateWorkPayload,
  DetachedWork,
  FailureClass,
  JsonObject,
  ReductionResult,
  TaskPlanItem,
  TaskReducerCommand,
  TaskRow,
  TaskState,
  WorkReducerCommand,
  WorkRow,
  WorkState,
} from "./types";

/**
 * The Work and Task transition tables are represented as data as well as
 * executable branches below. Keeping the rows next to the reducer makes the
 * implementation/report mapping auditable and prevents a handler from
 * inventing a second transition table.
 */
export const WORK_TRANSITION_TABLE = [
  { row: 1, current: "memo", guard: "title/summary/owner/project valid", event: "work.ready", next: "ready" },
  { row: 2, current: "memo", guard: "owner explicitly starts", event: "work.started", next: "running" },
  { row: 3, current: "ready", guard: "start idempotency not processed", event: "work.started", next: "running" },
  { row: 4, current: "running", guard: "unfinished task or agent", event: "work.paused", next: "paused" },
  { row: 5, current: "paused", guard: "natural agent exit and reconciled", event: "work.resumed", next: "running" },
  { row: 6, current: "running", guard: "open decision blocks work", event: "decision.opened", next: "judgement_waiting" },
  { row: 7, current: "judgement_waiting", guard: "winner answer committed by CAS", event: "decision.resolved", next: "running" },
  { row: 8, current: "running", guard: "all tasks complete and manager verdict complete", event: "work.completed", next: "completed" },
  { row: 9, current: "running", guard: "owner cancel or manager failure owner choice", event: "work.cancelled", next: "cancelled" },
  { row: 10, current: "paused", guard: "owner cancel", event: "work.cancelled", next: "cancelled" },
  { row: 11, current: "completed", guard: "valid small reopen", event: "work.reopened", next: "running" },
  { row: 12, current: "cancelled", guard: "reopen is prohibited", event: "work.reopen_rejected", next: "cancelled" },
  { row: 13, current: "any non-terminal", guard: "core cannot safely reconcile", event: "system.alert", next: "judgement_waiting" },
  { row: 14, current: "judgement_waiting", guard: "owner cancel", event: "work.cancelled", next: "cancelled" },
  { row: 15, current: "memo", guard: "owner cancel", event: "work.cancelled", next: "cancelled" },
  { row: 16, current: "ready", guard: "owner cancel", event: "work.cancelled", next: "cancelled" },
] as const;

export const TASK_TRANSITION_TABLE = [
  { row: 1, current: "waiting", guard: "all dependencies completed", event: "task.ready", next: "ready" },
  { row: 2, current: "ready", guard: "capacity and launch lease", event: "task.started", next: "running" },
  { row: 3, current: "ready", guard: "work paused/cancelled", event: "work.paused/work.cancelled", next: "paused/cancelled" },
  { row: 4, current: "running", guard: "valid success report", event: "agent.exited", next: "verifying" },
  { row: 5, current: "running", guard: "transient and retry_no <= 3", event: "task.failure.classified", next: "ready" },
  { row: 6, current: "running", guard: "deterministic below same/total thresholds", event: "task.failure.classified", next: "ready" },
  { row: 7, current: "running", guard: "deterministic at same/total threshold", event: "task.failed", next: "failed" },
  { row: 8, current: "running", guard: "deterministic retry_allowed=false", event: "task.failed -> decision.opened", next: "judgement_waiting" },
  { row: 9, current: "running", guard: "crash below deterministic threshold", event: "agent.crashed", next: "ready" },
  { row: 10, current: "running", guard: "crash at deterministic threshold", event: "agent.crashed -> task.failed", next: "failed" },
  { row: 11, current: "verifying", guard: "verification pass, no review", event: "verification.completed", next: "completed" },
  { row: 12, current: "verifying", guard: "verification pass, review required", event: "verification.completed", next: "verifying" },
  { row: 13, current: "verifying", guard: "verification fail and review_round < 2", event: "verification.completed", next: "review_fix_waiting" },
  { row: 14, current: "verifying", guard: "verification fail and review_round >= 2", event: "verification.completed -> task.failed", next: "failed" },
  { row: 15, current: "verifying", guard: "review pass and merge exit 0", event: "review.passed -> git.merge.result", next: "completed" },
  { row: 16, current: "verifying", guard: "review pass and merge exit != 0", event: "review.passed -> git.merge.aborted -> task.conflict", next: "failed" },
  { row: 17, current: "verifying", guard: "review fix_required and review_round < 2", event: "review.failed", next: "review_fix_waiting" },
  { row: 18, current: "verifying", guard: "review fix_required and review_round >= 2", event: "review.failed", next: "failed" },
  { row: 19, current: "review_fix_waiting", guard: "replacement lease", event: "task.started", next: "running" },
  { row: 20, current: "failed", guard: "manager replan accepted and every dependency completed; failure counters, reviewer failures and review_round reset", event: "task.replanned", next: "ready" },
  { row: "20b", current: "failed", guard: "manager replan accepted but a dependency is not completed; same resets as row 20", event: "task.replanned", next: "waiting" },
  { row: 21, current: "failed", guard: "manager cannot continue and owner decision open", event: "decision.opened", next: "judgement_waiting" },
  { row: 22, current: "judgement_waiting", guard: "decision winner targets task and every dependency completed", event: "decision.resolved", next: "ready" },
  { row: "22b", current: "judgement_waiting", guard: "decision winner targets task but a dependency is not completed", event: "decision.resolved", next: "waiting" },
  { row: 23, current: "waiting/ready/review_fix_waiting/failed", guard: "owner pause", event: "work.paused", next: "paused" },
  { row: 24, current: "running/verifying", guard: "owner pause; running/verifying keep their state; nothing recorded in paused_from", event: "work.paused", next: "running/verifying" },
  { row: 25, current: "paused", guard: "work resumed", event: "work.resumed", next: "paused_from" },
  { row: 26, current: "any non-terminal", guard: "owner cancel", event: "work.cancelled", next: "cancelled" },
  { row: 27, current: "waiting", guard: "a dependency permanently failed; failed_by_dependency_task_id records it", event: "task.dependency_failed", next: "failed" },
  { row: 28, current: "verifying", guard: "review replan_required (explicit, any review_round)", event: "review.failed", next: "failed" },
  { row: 29, current: "verifying", guard: "Reviewer agent failed; reviewer_failure_count below REVIEWER_FAILURE_LIMIT (else failed + manager trigger)", event: "agent.crashed", next: "review_fix_waiting/failed" },
  { row: 30, current: "failed/judgement_waiting", guard: "manager replan registered replacement Tasks", event: "task.superseded", next: "cancelled" },
  { row: 31, current: "failed", guard: "failed_by_dependency_task_id set and no dependency is failed or cancelled any more; marker cleared", event: "task.dependency_restored", next: "waiting" },
  { row: 32, current: "running", guard: "Worker asked the Manager a question or requested replanning", event: "task.replan_requested", next: "failed" },
  { row: 33, current: "completed/failed/cancelled", guard: "no agent run is active on the worktree", event: "task.worktree.discarded", next: "same status" },
  { row: 34, current: "running", guard: "provider returned rate_limited", event: "task.rate_limited", next: "ready" },
  { row: 35, current: "ready/review_fix_waiting", guard: "Task worktree conflicts with the Work branch before launch; merge aborted", event: "task.conflict", next: "failed" },
] as const;

/**
 * The one definition of "this Task has finished for good". A superseded
 * (cancelled) Task left the plan without failing the Work, so it counts as
 * terminal. Core's final-check trigger and WorkflowEngine's Work completion
 * both use this predicate; two different sets made a Work with a superseded
 * Task run the final check forever without ever completing.
 */
export const TASK_TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>(["completed", "failed", "cancelled"]);

export function isTerminalTaskState(status: string): boolean {
  return TASK_TERMINAL_STATES.has(status as TaskState);
}

/**
 * Task row 29: how many times the Reviewer itself may fail (provider or
 * contract error, not a finding) before the Task fails for Manager replanning.
 * Counted in tasks.reviewer_failure_count, which Worker starts and successes
 * never reset.
 */
export const REVIEWER_FAILURE_LIMIT = 3;

export interface AgentRunRecordInput {
  readonly id?: string;
  readonly work_id: string;
  readonly task_id: string;
  readonly role?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string | null;
  readonly invocation_id?: string;
  readonly design_tier?: "standard" | "lead" | null;
}

function objectPayload(command: { payload?: JsonObject }): JsonObject {
  return command.payload ?? {};
}

function requiredBoolean(payload: JsonObject, key: string): boolean {
  const value = payload[key];
  if (typeof value !== "boolean") {
    throw validationError(`Reducer guard ${key} must be an explicit boolean.`, { field: key });
  }
  return value;
}

function requiredString(payload: JsonObject, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw validationError(`Reducer field ${key} must be a non-empty string.`, { field: key });
  }
  return value;
}

function requiredNumber(payload: JsonObject, key: string): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw validationError(`Reducer field ${key} must be a non-negative integer.`, { field: key });
  }
  return value;
}

function optionalBoolean(payload: JsonObject, key: string, defaultValue: boolean): boolean {
  const value = payload[key];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    throw validationError(`Reducer guard ${key} must be a boolean when supplied.`, { field: key });
  }
  return value;
}

function assertVersion(current: number, expected: number | undefined): void {
  if (expected !== undefined && current !== expected) {
    throw versionConflict(expected, current);
  }
}

function reject(row: { id: string; state?: string; status?: string }, event: string, reason: string): never {
  throw invalidStateTransition(reason, {
    id: row.id,
    current_state: row.state ?? row.status,
    event,
  });
}

function workResult(
  previous: WorkRow,
  next: WorkRow,
  sideEffects: readonly string[] = [],
  managerTrigger = false,
  decisionId?: string,
): ReductionResult<WorkRow> {
  return {
    previous,
    next,
    accepted: true,
    changed: previous.state !== next.state || previous.state_version !== next.state_version,
    manager_trigger: managerTrigger,
    decision_id: decisionId,
    side_effects: sideEffects,
  };
}

/**
 * Task rows 15-16: a finished Task and the serialized Core Git merge of
 * it into the Work branch (after review.passed, or at verification.completed
 * for a Task without review). A conflict fails the Task for Manager replanning.
 */
function integratedTaskResult(row: TaskRow, payload: JsonObject, now: string, sideEffects: readonly string[]): ReductionResult<TaskRow> {
  const mergeExitCode = requiredNumber(payload, "merge_exit_code");
  if (mergeExitCode === 0) {
    const worktreeState = payload.worktree_state === "retained" ? "retained" : "merged";
    return taskResult(
      row,
      { ...withTaskVersion(resetReviewerFailureCounter(resetFailureCounters(row)), "completed", now), worktree_state: worktreeState },
      [...sideEffects, "git_merge_recorded", worktreeState === "retained" ? "worktree_retained" : "worktree_removal_recorded"],
    );
  }
  const taskBranch = requiredString(payload, "task_branch");
  const workBranch = requiredString(payload, "work_branch");
  if (payload.failure_kind === "commit_failure") {
    const errorKey = `git_commit_failure:${taskBranch}:${workBranch}`;
    const next = {
      ...withTaskVersion(row, "failed", now),
      failure_count: row.failure_count + 1,
      same_error_count: row.last_error_key === errorKey ? row.same_error_count + 1 : 1,
      last_error_key: normalizeErrorKey(errorKey),
      last_failure_class: "deterministic" as FailureClass,
      last_error_generation: row.worker_generation,
      worktree_state: "active",
    };
    return taskResult(row, next, ["git_commit_failed", "manager_trigger_required"], true);
  }
  const errorKey = `git_conflict:${taskBranch}:${workBranch}`;
  const next = {
    ...withTaskVersion(row, "failed", now),
    failure_count: row.failure_count + 1,
    same_error_count: row.last_error_key === errorKey ? row.same_error_count + 1 : 1,
    last_error_key: normalizeErrorKey(errorKey),
    last_failure_class: "deterministic" as FailureClass,
    last_error_generation: row.worker_generation,
    worktree_state: "conflict_retained",
  };
  return taskResult(row, next, ["git_merge_aborted", "manager_trigger_required"], true);
}

function taskResult(
  previous: TaskRow,
  next: TaskRow,
  sideEffects: readonly string[] = [],
  managerTrigger = false,
  decisionId?: string,
): ReductionResult<TaskRow> {
  return {
    previous,
    next,
    accepted: true,
    changed:
      previous.status !== next.status ||
      previous.state_version !== next.state_version ||
      previous.failure_count !== next.failure_count ||
      previous.same_error_count !== next.same_error_count ||
      previous.review_round !== next.review_round ||
      previous.reviewer_failure_count !== next.reviewer_failure_count ||
      previous.retry_no !== next.retry_no ||
      previous.next_attempt_at !== next.next_attempt_at ||
      previous.worktree_path !== next.worktree_path ||
      previous.worktree_state !== next.worktree_state ||
      previous.failed_by_dependency_task_id !== next.failed_by_dependency_task_id,
    manager_trigger: managerTrigger,
    decision_id: decisionId,
    side_effects: sideEffects,
  };
}

function withWorkVersion(row: WorkRow, state: WorkState, now: string): WorkRow {
  const next: WorkRow = { ...row, state, state_version: row.state_version + 1, updated_at: now };
  if (state === "completed") {
    next.completed_at = now;
  } else if (state === "cancelled") {
    next.cancelled_at = now;
  }
  return next;
}

function withTaskVersion(row: TaskRow, status: TaskState, now: string): TaskRow {
  return { ...row, status, state_version: row.state_version + 1, updated_at: now };
}

function resetFailureCounters(row: TaskRow): TaskRow {
  return {
    ...row,
    failure_count: 0,
    same_error_count: 0,
    last_error_key: null,
    last_error_generation: null,
    retry_no: 0,
    next_attempt_at: null,
  };
}

/**
 * Clears the Reviewer failure budget (Task row 29). Deliberately not part of
 * resetFailureCounters: that one runs on every Worker success, and folding the
 * Reviewer budget into it let a failing Reviewer loop forever.
 */
function resetReviewerFailureCounter(row: TaskRow): TaskRow {
  return { ...row, reviewer_failure_count: 0 };
}

function resetSameErrorCounter(row: TaskRow): TaskRow {
  return {
    ...row,
    same_error_count: 0,
    last_error_key: null,
    last_error_generation: null,
  };
}

function normalizeErrorKey(key: string): string {
  if (key.length === 64) return key;
  return createHash("sha256").update(key).digest("hex");
}

function deterministicCounters(row: TaskRow, errorKey: string): { same: number; total: number } {
  return {
    same: row.last_error_key === errorKey && row.last_error_generation === row.worker_generation ? row.same_error_count + 1 : 1,
    total: row.failure_count + 1,
  };
}

/** Pure Work state transition reducer. No caller may update `works.state` directly. */
export function reduceWork(row: WorkRow, command: WorkReducerCommand): ReductionResult<WorkRow> {
  assertVersion(row.state_version, command.expected_version);
  const payload = objectPayload(command);
  const now = typeof payload.now === "string" ? payload.now : utcNow();
  const event = command.event;

  // Work row 1: memo -> ready.
  if (row.state === "memo" && event === "work.ready") {
    if (!requiredBoolean(payload, "valid")) {
      reject(row, event, "The Work is not valid enough to leave memo state.");
    }
    return workResult(row, withWorkVersion(row, "ready", now));
  }

  // Work row 2: explicit owner start from memo.
  if (row.state === "memo" && event === "work.started") {
    if (!requiredBoolean(payload, "explicit_start")) {
      reject(row, event, "Starting a memo Work requires an explicit owner action.");
    }
    return workResult(row, withWorkVersion(row, "running", now));
  }

  // Work row 3: ready start with idempotency already checked by Core.
  if (row.state === "ready" && event === "work.started") {
    if (requiredBoolean(payload, "idempotency_processed")) {
      reject(row, event, "The start idempotency key has already been processed.");
    }
    return workResult(row, withWorkVersion(row, "running", now));
  }

  // Work row 4: pause only while work is active.
  if (row.state === "running" && event === "work.paused") {
    if (!requiredBoolean(payload, "has_active_task_or_agent")) {
      reject(row, event, "A running Work can be paused only while a Task or Agent is active.");
    }
    return workResult(row, withWorkVersion(row, "paused", now));
  }

  // Work row 5: normal resume, with the unsafe-reconcile branch below.
  if (row.state === "paused" && event === "work.resumed") {
    const reconciled = requiredBoolean(payload, "reconciled");
    if (!reconciled) {
      return workResult(row, withWorkVersion(row, "judgement_waiting", now), ["core_decision_required"]);
    }
    return workResult(row, withWorkVersion(row, "running", now));
  }

  // Work row 6: a blocking Decision moves the Work to judgement_waiting.
  if (row.state === "running" && event === "decision.opened") {
    if (!requiredBoolean(payload, "blocks_work")) {
      reject(row, event, "The Decision does not identify this Work as blocked.");
    }
    return workResult(row, withWorkVersion(row, "judgement_waiting", now));
  }

  // Work row 7: only the CAS winner may resume a judgement-waiting Work.
  if (row.state === "judgement_waiting" && event === "decision.resolved") {
    if (!requiredBoolean(payload, "winner_commit")) {
      reject(row, event, "Only the Decision winner can resume a Work.");
    }
    return workResult(row, withWorkVersion(row, "running", now));
  }

  // Work row 8: completion requires both Task and Manager verdict.
  if (row.state === "running" && event === "work.completed") {
    if (!requiredBoolean(payload, "all_tasks_completed") || payload.manager_final_verdict !== "complete") {
      reject(row, event, "The Work is not complete because Task completion or the Manager verdict is missing.");
    }
    return workResult(row, withWorkVersion(row, "completed", now));
  }

  // Work rows 9-10 and 14-16: owner cancellation from memo, ready,
  // running, paused, or judgement_waiting (otherwise a blocked Work could only
  // be escaped by answering its Decision, and a never-started Work could
  // never be withdrawn).
  if (
    (row.state === "memo" || row.state === "ready" || row.state === "running" || row.state === "paused" || row.state === "judgement_waiting") &&
    event === "work.cancelled"
  ) {
    const ownerCancel = requiredBoolean(payload, "owner_cancel");
    const managerChoice = requiredBoolean(payload, "manager_unable_owner_choice");
    if (!ownerCancel && !managerChoice) {
      reject(row, event, "Cancelling a Work requires an owner action or the recorded Manager-failure choice.");
    }
    if ((row.state === "memo" || row.state === "ready") && !ownerCancel) {
      reject(row, event, "A Work that has not started can be cancelled only by its owner.");
    }
    return workResult(row, withWorkVersion(row, "cancelled", now));
  }

  // Work row 11: only a valid reopen can leave completed.
  if (row.state === "completed" && event === "work.reopened") {
    if (!requiredBoolean(payload, "valid_reopen")) {
      reject(row, event, "Only a valid reopen can reopen a completed Work.");
    }
    // A reopened Work is no longer completed, so clear its completion timestamp here.
    return workResult(row, { ...withWorkVersion(row, "running", now), completed_at: null });
  }

  // Work row 12: cancelled Work can never be reopened in place.
  if (row.state === "cancelled" && event === "work.reopen_rejected") {
    reject(row, event, "A cancelled Work cannot be reopened; create a new Work instead.");
  }

  // Work row 13: unreconcilable non-terminal state is judgement_waiting.
  if (event === "system.alert" && row.state !== "completed" && row.state !== "cancelled") {
    if (!requiredBoolean(payload, "safe_reconcile_failed")) {
      reject(row, event, "system.alert is reserved for an unsafe reconcile result.");
    }
    return workResult(row, withWorkVersion(row, "judgement_waiting", now), ["core_decision_required"]);
  }

  reject(row, event, "The Work event is not allowed by the current state or guard.");
}

/** Pure Task state transition reducer implementing every Task row. */
export function reduceTask(row: TaskRow, command: TaskReducerCommand): ReductionResult<TaskRow> {
  assertVersion(row.state_version, command.expected_version);
  const payload = objectPayload(command);
  const now = typeof payload.now === "string" ? payload.now : utcNow();
  const event = command.event;

  // Task row 1.
  if (row.status === "waiting" && event === "task.ready") {
    if (!requiredBoolean(payload, "dependencies_completed")) {
      reject(row, event, "The Task still has an incomplete dependency.");
    }
    return taskResult(row, withTaskVersion(row, "ready", now));
  }

  // Task row 27 (cascade): a waiting Task fails once a dependency of
  // it is permanently failed. WorkflowEngine.cascadeFailure() walks
  // task_dependencies and dispatches this event transitively so a `waiting`
  // Task never stalls forever behind a permanently failed dependency (see
  // checkTerminalTasks in core.ts).
  // The failed dependency is recorded in failed_by_dependency_task_id: it is
  // the only durable mark that tells a cascaded failure from a root failure.
  if (row.status === "waiting" && event === "task.dependency_failed") {
    const failedDependencyTaskId = requiredString(payload, "failed_dependency_task_id");
    const next: TaskRow = {
      ...withTaskVersion(row, "failed", now),
      last_failure_class: "deterministic",
      paused_from: null,
      failed_by_dependency_task_id: failedDependencyTaskId,
    };
    return taskResult(row, next, ["dependency_failure_cascaded"]);
  }

  // Task row 31: a Task failed only because a dependency failed returns to
  // waiting once that dependency is replanned or superseded.
  if (row.status === "failed" && event === "task.dependency_restored") {
    requiredString(payload, "restored_dependency_task_id");
    return taskResult(row, {
      ...withTaskVersion(resetReviewerFailureCounter(resetFailureCounters(row)), "waiting", now),
      paused_from: null,
      failed_by_dependency_task_id: null,
    });
  }

  // Task row 30: the Manager replaced this Task with new Tasks, so it leaves
  // the plan without counting as a Work failure.
  if ((row.status === "failed" || row.status === "judgement_waiting") && event === "task.superseded") {
    requiredString(payload, "reason");
    return taskResult(row, { ...withTaskVersion(row, "cancelled", now), paused_from: null, failed_by_dependency_task_id: null }, ["task_superseded"]);
  }

  // Task rows 2 and 19.
  if ((row.status === "ready" || row.status === "review_fix_waiting") && event === "task.started") {
    if (!requiredBoolean(payload, "capacity_acquired") || !requiredBoolean(payload, "launch_lease_acquired")) {
      reject(row, event, "The Task cannot start without both capacity and a launch lease.");
    }
    const next = {
      ...withTaskVersion(resetSameErrorCounter(row), "running", now),
      worker_generation: row.worker_generation + 1,
      worktree_path: typeof payload.worktree_path === "string" ? payload.worktree_path : row.worktree_path,
      worktree_state: typeof payload.worktree_path === "string" ? "active" : row.worktree_state,
      next_attempt_at: null,
    };
    return taskResult(row, next, ["agent_run_required"]);
  }

  // Task row 35: the Task worktree could not catch up with the Work branch
  // before its next attempt. Like a conflict at integration (row 16), only
  // this Task fails, for Manager replanning; its worktree stays as it was.
  if ((row.status === "ready" || row.status === "review_fix_waiting") && event === "task.conflict") {
    const errorKey = `git_conflict:${requiredString(payload, "task_branch")}:${requiredString(payload, "work_branch")}`;
    const next = {
      ...withTaskVersion(row, "failed", now),
      failure_count: row.failure_count + 1,
      same_error_count: row.last_error_key === errorKey ? row.same_error_count + 1 : 1,
      last_error_key: normalizeErrorKey(errorKey),
      last_failure_class: "deterministic" as FailureClass,
      last_error_generation: row.worker_generation,
      next_attempt_at: null,
    };
    return taskResult(row, next, ["git_merge_aborted", "manager_trigger_required"], true);
  }

  // Task row 3: ready Task follows Work pause/cancel.
  if (row.status === "ready" && (event === "work.paused" || event === "work.cancelled")) {
    if (event === "work.paused" && !requiredBoolean(payload, "work_paused")) {
      reject(row, event, "A ready Task may be paused only after Work pause is committed.");
    }
    if (event === "work.cancelled" && !requiredBoolean(payload, "owner_cancel")) {
      reject(row, event, "A ready Task may be cancelled only after Work cancellation is committed.");
    }
    const target: TaskState = event === "work.paused" ? "paused" : "cancelled";
    const next = { ...withTaskVersion(row, target, now), paused_from: (event === "work.paused" ? "ready" : null) as TaskState | null };
    return taskResult(row, next, [event === "work.paused" ? "spawn_suppressed" : "cancel_requested"]);
  }

  // Task row 4: a valid success report enters verification.
  if (row.status === "running" && event === "agent.exited") {
    if (payload.outcome !== "success" || !requiredBoolean(payload, "report_valid")) {
      reject(row, event, "Only a valid successful report may enter verification.");
    }
    return taskResult(row, withTaskVersion(resetFailureCounters(row), "verifying", now), ["report_saved"]);
  }

  // Task row 5: transient retry is independent of deterministic failure counters.
  if (row.status === "running" && event === "task.failure.classified" && payload.failure_class === "transient") {
    const retryNo = requiredNumber(payload, "retry_no");
    if (!Number.isInteger(retryNo) || retryNo < 1) {
      reject(row, event, "The transient retry number must be a positive integer.");
    }
    if (retryNo > 3) {
      reject(row, event, "The transient retry budget is exhausted.");
    }
    const nextAttemptAt = payload.next_attempt_at === null || typeof payload.next_attempt_at === "string"
      ? payload.next_attempt_at ?? null
      : null;
    return taskResult(row, withTaskVersion({ ...row, retry_no: retryNo, next_attempt_at: nextAttemptAt }, "ready", now), ["transient_retry_scheduled"]);
  }

  // A provider quota pause is scheduling state, not a Task failure. Keep the
  // retry and deterministic failure counters unchanged and retain its worktree.
  if (row.status === "running" && event === "task.rate_limited") {
    requiredString(payload, "provider");
    return taskResult(row, withTaskVersion({ ...row, next_attempt_at: null }, "ready", now), ["provider_pause_scheduled"]);
  }

  // Task rows 6-8: deterministic failure classification and Manager/Decision split.
  if (row.status === "running" && event === "task.failure.classified" && payload.failure_class === "deterministic") {
    const errorKey = requiredString(payload, "error_key");
    const counters = deterministicCounters(row, errorKey);
    const retryAllowed = requiredBoolean(payload, "retry_allowed");
    const nextBase: TaskRow = {
      ...row,
      failure_count: counters.total,
      same_error_count: counters.same,
      last_error_key: normalizeErrorKey(errorKey),
      last_failure_class: "deterministic",
      last_error_generation: row.worker_generation,
      next_attempt_at: null,
      updated_at: now,
    };
    if (!retryAllowed) {
      return taskResult(
        row,
        withTaskVersion({ ...nextBase, paused_from: null }, "judgement_waiting", now),
        ["core_decision_required"],
        false,
      );
    }
    if (counters.same < 2 && counters.total < 3) {
      return taskResult(row, withTaskVersion(nextBase, "ready", now), ["deterministic_retry_scheduled"]);
    }
    return taskResult(row, withTaskVersion(nextBase, "failed", now), ["manager_trigger_required"], true);
  }

  // Task row 32: the Worker finished but asked the Manager a question or
  // requested replanning. The Task leaves running first so the Manager
  // replan (task.replanned: failed -> ready) can apply its revision.
  if (row.status === "running" && event === "task.replan_requested") {
    requiredString(payload, "reason");
    return taskResult(
      row,
      { ...withTaskVersion(row, "failed", now), last_failure_class: "deterministic", next_attempt_at: null },
      ["manager_trigger_required"],
      true,
    );
  }

  // Task rows 9-10: a crash without a report follows deterministic counters.
  if (row.status === "running" && event === "agent.crashed") {
    if (requiredBoolean(payload, "report_present")) {
      reject(row, event, "agent.crashed must not carry a successful report.");
    }
    const errorKey = requiredString(payload, "error_key");
    const counters = deterministicCounters(row, errorKey);
    const nextBase: TaskRow = {
      ...row,
      failure_count: counters.total,
      same_error_count: counters.same,
      last_error_key: normalizeErrorKey(errorKey),
      last_failure_class: "deterministic",
      last_error_generation: row.worker_generation,
      next_attempt_at: null,
      updated_at: now,
    };
    if (counters.same >= 2 || counters.total >= 3) {
      return taskResult(row, withTaskVersion(nextBase, "failed", now), ["manager_trigger_required"], true);
    }
    return taskResult(row, withTaskVersion(nextBase, "ready", now), ["deterministic_retry_scheduled"]);
  }

  // Task row 29: a Reviewer owns a running AgentRun while the Task remains
  // in verifying. If the Reviewer itself fails (provider or contract error,
  // or its process disappears during shutdown/restart), put the Task back
  // through the normal Worker/review path instead of leaving it permanently
  // in verifying. The budget is reviewer_failure_count, not the Worker
  // counters: task.started and a successful agent.exited reset those, so they
  // could never stop a Reviewer that fails every time. failure_count,
  // same_error_count and last_error_key keep describing Worker failures only;
  // error_key stays in the event payload for the log.
  if (row.status === "verifying" && event === "agent.crashed" && payload.role === "reviewer") {
    requiredString(payload, "error_key");
    const reviewerFailures = row.reviewer_failure_count + 1;
    const nextBase: TaskRow = {
      ...row,
      reviewer_failure_count: reviewerFailures,
      last_failure_class: "deterministic",
      next_attempt_at: null,
      updated_at: now,
    };
    if (reviewerFailures >= REVIEWER_FAILURE_LIMIT) {
      return taskResult(row, withTaskVersion(nextBase, "failed", now), ["manager_trigger_required"], true);
    }
    return taskResult(row, withTaskVersion(nextBase, "review_fix_waiting", now), ["replacement_worker_reserved"]);
  }

  // Task rows 11-14: verification pass/fail and independent review counter.
  if (row.status === "verifying" && event === "verification.completed") {
    const outcome = payload.outcome;
    if (outcome === "pass") {
      if (requiredBoolean(payload, "review_required")) {
        return taskResult(row, withTaskVersion(row, "verifying", now), ["reviewer_reserved"]);
      }
      // A Task without review is merged into the Work branch right here.
      if (payload.merge_exit_code !== undefined) return integratedTaskResult(row, payload, now, ["dependencies_unlock"]);
      return taskResult(row, withTaskVersion(resetReviewerFailureCounter(resetFailureCounters(row)), "completed", now), ["dependencies_unlock"]);
    }
    if (outcome !== "fail") {
      throw validationError("Verification outcome must be pass or fail.", { field: "outcome" });
    }
    if (row.review_round < 2) {
      const next = { ...withTaskVersion(row, "review_fix_waiting", now), review_round: row.review_round + 1 };
      return taskResult(row, next, ["replacement_worker_reserved"]);
    }
    return taskResult(row, withTaskVersion(row, "failed", now), ["manager_trigger_required"], true);
  }

  // Task rows 15-16: reviewer pass plus serialized Core Git result.
  if (row.status === "verifying" && event === "review.passed") {
    return integratedTaskResult(row, payload, now, []);
  }

  // Task rows 17-18, plus row 28.
  if (row.status === "verifying" && event === "review.failed") {
    if (payload.verdict !== "fix_required" && payload.verdict !== "replan_required") {
      reject(row, event, "review.failed must contain the fix_required or replan_required verdict.");
    }
    // Task row 28: an explicit Reviewer replan_required always
    // escalates straight to Manager replanning, regardless of review_round.
    // The Reviewer decided the Task itself needs a new plan, not another
    // fix-and-retry pass, so it does not consume a review_round slot.
    if (payload.verdict === "replan_required") {
      return taskResult(row, withTaskVersion(row, "failed", now), ["manager_trigger_required"], true);
    }
    const leadStart = row.lead_designer_start_round ?? null;
    if (row.type === "design" && leadStart === null && row.review_round === 1) {
      const next = {
        ...withTaskVersion(row, "review_fix_waiting", now),
        review_round: 2,
        lead_designer_start_round: 2,
      };
      return taskResult(row, next, ["replacement_worker_reserved"]);
    }
    const lastRetryRound = row.type === "design" && leadStart !== null ? leadStart : 1;
    if (row.review_round <= lastRetryRound) {
      const next = { ...withTaskVersion(row, "review_fix_waiting", now), review_round: row.review_round + 1 };
      return taskResult(row, next, ["replacement_worker_reserved"]);
    }
    return taskResult(row, withTaskVersion(row, "failed", now), ["manager_trigger_required"], true);
  }

  // Task rows 20/20b: replan uses a base-plan CAS. A retried Task
  // whose dependency is not completed yet (the Manager retried a Task and its
  // dependency together) waits for it instead of starting early.
  if (row.status === "failed" && event === "task.replanned") {
    const basePlanVersion = requiredNumber(payload, "base_plan_version");
    const currentPlanVersion = requiredNumber(payload, "current_plan_version");
    if (basePlanVersion !== currentPlanVersion) {
      throw versionConflict(basePlanVersion, currentPlanVersion);
    }
    const target: TaskState = requiredBoolean(payload, "dependencies_completed") ? "ready" : "waiting";
    // The replanned Task gets its fix/review budget back. reviews.round is
    // a per-Task sequence (see WorkflowEngine.recordReview), so resetting
    // review_round here cannot collide with the earlier review rows.
    return taskResult(
      row,
      {
        ...withTaskVersion(resetReviewerFailureCounter(resetFailureCounters(row)), target, now),
        review_round: 0,
        lead_designer_start_round: row.type === "design" && row.lead_designer_start_round != null ? 0 : null,
        failed_by_dependency_task_id: null,
      },
      ["plan_revision_incremented"],
    );
  }

  // Task row 21: Manager-originated inability opens a Core Decision.
  if (row.status === "failed" && event === "decision.opened") {
    if (payload.issuer !== "manager") {
      reject(row, event, "A failed Task Decision must originate from the Manager.");
    }
    return taskResult(row, withTaskVersion(row, "judgement_waiting", now), ["decision_opened"]);
  }

  // Decision service entry point for a running Task that must be blocked now.
  if (row.status === "running" && event === "decision.opened") {
    if (!requiredBoolean(payload, "blocks_task")) {
      reject(row, event, "A running Task Decision must explicitly identify the blocked Task.");
    }
    return taskResult(row, withTaskVersion(row, "judgement_waiting", now), ["decision_opened"]);
  }

  // Task rows 22/22b: only the CAS winner resumes the blocked Task. A
  // Task whose dependency is not completed returns to waiting instead of
  // rejecting the whole answer: an answer to a Decision that also blocks
  // a cascaded Task must not fail and leave the Decision open.
  if (row.status === "judgement_waiting" && event === "decision.resolved") {
    if (!requiredBoolean(payload, "winner_commit")) {
      reject(row, event, "Only the Decision winner can resume a blocked Task.");
    }
    const target: TaskState = requiredBoolean(payload, "dependencies_completed") ? "ready" : "waiting";
    return taskResult(
      row,
      { ...withTaskVersion(resetReviewerFailureCounter(row), target, now), failed_by_dependency_task_id: null },
      ["blocked_task_resumed"],
    );
  }

  // Task row 23: paused_from is the only legal restore target.
  if (
    (row.status === "waiting" || row.status === "ready" || row.status === "review_fix_waiting" || row.status === "failed") &&
    event === "work.paused"
  ) {
    if (!requiredBoolean(payload, "work_paused")) {
      reject(row, event, "A Task pause requires the committed Work pause.");
    }
    const next = { ...withTaskVersion(row, "paused", now), paused_from: row.status };
    return taskResult(row, next, ["spawn_suppressed"]);
  }

  // Task row 24: running/verifying state is kept while Core drains work.
  // Nothing is recorded in paused_from: the Task never becomes `paused`, so row 25
  // never restores it, and the tasks CHECK only admits waiting/ready/review_fix_waiting/failed.
  // The event is still appended as an audit entry.
  if ((row.status === "running" || row.status === "verifying") && event === "work.paused") {
    if (!requiredBoolean(payload, "work_paused")) {
      reject(row, event, "The Task may stay active during pause only after Work pause is committed.");
    }
    return taskResult(row, withTaskVersion(row, row.status, now), ["launches_queued"]);
  }

  // Task row 25: paused restores paused_from, with dependency re-evaluation.
  if (row.status === "paused" && event === "work.resumed") {
    const pausedFrom = row.paused_from;
    if (pausedFrom === null || pausedFrom === undefined) {
      reject(row, event, "A paused Task is missing its paused_from state.");
    }
    const dependenciesCompleted = requiredBoolean(payload, "dependencies_completed");
    const restored: TaskState =
      pausedFrom === "ready" && !dependenciesCompleted
        ? "waiting"
        : pausedFrom === "waiting" && dependenciesCompleted
          ? "ready"
          : pausedFrom;
    if (restored === "paused" || restored === "cancelled") {
      reject(row, event, "The paused_from value is not resumable.");
    }
    return taskResult(row, { ...withTaskVersion(row, restored, now), paused_from: null });
  }

  // Task row 26: cancellation is terminal and never deletes a worktree.
  if (row.status !== "completed" && row.status !== "cancelled" && event === "work.cancelled") {
    if (!requiredBoolean(payload, "owner_cancel")) {
      reject(row, event, "Task cancellation requires the committed owner cancel action.");
    }
    return taskResult(row, { ...withTaskVersion(row, "cancelled", now), paused_from: null, failed_by_dependency_task_id: null }, ["cancel_requested"]);
  }

  // Task row 33: worktree cleanup after the Task is terminal, or after its
  // Work completed with a recorded merge. The caller (the worktree
  // reconciler) confirms no agent run still touches the worktree, and sets
  // merged_work_completed only after reading the Work's completion and merge
  // record in the same transaction; status and every other field are
  // unchanged, only worktree_state moves to 'discarded'. Reaching this for a
  // non-terminal Task of any other Work is rejected below as an invalid
  // transition.
  const mergedWorkCompleted = payload.merged_work_completed === true;
  if ((isTerminalTaskState(row.status) || mergedWorkCompleted) && event === "task.worktree.discarded") {
    if (!requiredBoolean(payload, "no_active_run")) {
      reject(row, event, "A Task's worktree can be discarded only while no agent run is active on it.");
    }
    return taskResult(row, { ...withTaskVersion(row, row.status, now), worktree_state: "discarded" }, ["worktree_discarded"]);
  }

  // Canonical task.completed is accepted only for a valid Core verification commit.
  if (row.status === "verifying" && event === "task.completed") {
    if (!requiredBoolean(payload, "verification_committed")) {
      reject(row, event, "task.completed requires a committed verification result.");
    }
    return taskResult(row, withTaskVersion(resetReviewerFailureCounter(resetFailureCounters(row)), "completed", now), ["dependencies_unlock"]);
  }

  reject(row, event, "The Task event is not allowed by the current state or guard.");
}

function persistWorkRow(transaction: CoreWriteLaneTransaction, row: WorkRow): void {
  const result = transaction.run(
    `UPDATE works
       SET state = ?, state_version = ?, updated_at = ?, completed_at = ?, cancelled_at = ?
     WHERE id = ? AND state_version = ?`,
    row.state,
    row.state_version,
    row.updated_at,
    row.completed_at ?? null,
    row.cancelled_at ?? null,
    row.id,
    row.state_version - 1,
  );
  if (result.changes !== 1) {
    throw new HumanReadableError({
      code: "version_conflict",
      message: "The Work changed while its state transition was being committed.",
      remediation: "Refresh the Work and retry the command with its current version.",
      details: { work_id: row.id },
    });
  }
}

function persistTaskRow(transaction: CoreWriteLaneTransaction, row: TaskRow): void {
  const result = transaction.run(
    `UPDATE tasks
       SET status = ?, state_version = ?, failure_count = ?, same_error_count = ?,
           last_error_key = ?, last_error_generation = ?, review_round = ?, lead_designer_start_round = ?, reviewer_failure_count = ?,
           worker_generation = ?, worktree_path = ?, worktree_state = ?,
           last_failure_class = ?, paused_from = ?, retry_no = ?, next_attempt_at = ?,
           failed_by_dependency_task_id = ?, updated_at = ?
     WHERE id = ? AND state_version = ?`,
    row.status,
    row.state_version,
    row.failure_count,
    row.same_error_count,
    row.last_error_key ?? null,
    row.last_error_generation ?? null,
    row.review_round,
    row.lead_designer_start_round ?? null,
    row.reviewer_failure_count,
    row.worker_generation,
    row.worktree_path ?? null,
    row.worktree_state ?? null,
    row.last_failure_class ?? null,
    row.paused_from ?? null,
    row.retry_no,
    row.next_attempt_at ?? null,
    row.failed_by_dependency_task_id ?? null,
    row.updated_at,
    row.id,
    row.state_version - 1,
  );
  if (result.changes !== 1) {
    throw new HumanReadableError({
      code: "version_conflict",
      message: "The Task changed while its state transition was being committed.",
      remediation: "Refresh the Task and retry the command with its current version.",
      details: { task_id: row.id },
    });
  }
}

export function ensureOwner(transaction: CoreWriteLaneTransaction, ownerId: string, now: string): void {
  transaction.run(
    `INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    ownerId,
    ownerId,
    now,
    now,
  );
}

/** Durable per-Task marker that a failed Task still needs a Manager replan. */
export function managerTriggerKey(taskId: string): string {
  return `manager-trigger:${taskId}`;
}

/**
 * Move a Task's worktree_state out of `active` once its worktree is known to
 * be gone (removed, merged, or deliberately kept for recovery). This is
 * bookkeeping, not a Task status transition, so it never touches status or
 * the transition table; a Task whose worktree_state already moved on is left
 * alone. Returns whether the row actually changed.
 */
export function repairWorktreeStateInTransaction(
  transaction: CoreWriteLaneTransaction,
  taskId: string,
  next: "merged" | "retained",
  now: string,
): boolean {
  const result = transaction.run(
    `UPDATE tasks SET worktree_state = ?, updated_at = ? WHERE id = ? AND worktree_state = 'active'`,
    next,
    now,
    taskId,
  );
  return result.changes === 1;
}

export { DECISION_CANCEL_OPTION_KEY };

/** True when an answer to a non-Advisor Decision asks Core to cancel the Work. */
export function isDecisionCancelAnswer(
  decision: Pick<DecisionRow, "issuer_role">,
  optionKey: string | null,
): boolean {
  return optionKey === DECISION_CANCEL_OPTION_KEY && decision.issuer_role !== "advisor";
}

function ensureManagerTrigger(
  transaction: CoreWriteLaneTransaction,
  task: TaskRow,
  event: string,
  payload: JsonObject,
  now: string,
): void {
  const triggerKey = managerTriggerKey(task.id);
  // Every new failure re-queues the trigger (a replanned Task that fails
  // again needs another replan). Core marks it attempted when it invokes the
  // Manager, and its tick replays any trigger that is still queued. The
  // Worker's question travels with the trigger, so whichever path runs the
  // replan (the Worker's own request, a tick replay, a restart) passes it on.
  const question =
    typeof payload.question === "string" && payload.question.trim().length > 0 ? payload.question : null;
  transaction.run(
    `INSERT OR REPLACE INTO idempotency_keys
       (key, request_hash, response_json, status_code, created_at, expires_at)
     VALUES (?, ?, ?, 202, ?, ?)`,
    triggerKey,
    "0".repeat(64),
    JSON.stringify({ task_id: task.id, event, status: "queued", question }),
    now,
    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  );
}

/**
 * Open the Decision Core raises on its own (Work halt, or a Task failure it
 * must not retry). "cancel" cancels the Work; any other answer, including
 * free text, resumes it (see Core.answerDecision).
 */
function ensureCoreDecision(
  transaction: CoreWriteLaneTransaction,
  workId: string,
  blockedTaskIds: readonly string[],
  brief: DecisionBrief,
  now: string,
): string {
  const existing = transaction.get<{ id: string; blocked_task_ids_json: string }>(
    `SELECT id, blocked_task_ids_json FROM decisions
      WHERE work_id = ? AND status = 'open' AND reason = ?
      ORDER BY created_at ASC LIMIT 1`,
    workId,
    brief.reason,
  );
  if (existing) {
    // A second Task halted for the same reason joins the open Decision,
    // so answering it resumes every Task it stands for. The caller has already
    // moved the Task to judgement_waiting (row 8), and the Decision keeps its
    // scope. state_version is not bumped: the question did not change, and an
    // answer being composed against it must still win the CAS.
    const stored = JSON.parse(existing.blocked_task_ids_json) as unknown;
    const current = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
    const union = [...current, ...blockedTaskIds.filter((id) => !current.includes(id))];
    if (union.length > current.length) {
      transaction.run("UPDATE decisions SET blocked_task_ids_json = ? WHERE id = ?", JSON.stringify(union), existing.id);
    }
    return existing.id;
  }
  assertDecisionBrief({ ...brief, allow_free_text: true });
  const id = createUlid();
  transaction.run(
    `INSERT INTO decisions
       (id, work_id, scope, status, blocked_task_ids_json, reason, question, tried,
        current_state, options_json, recommended, allow_free_text, issuer_role,
        state_version, created_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, 1, 'core', 0, ?)`,
    id,
    workId,
    blockedTaskIds.length > 0 ? "task" : "work",
    JSON.stringify(blockedTaskIds),
    brief.reason,
    brief.question,
    brief.tried,
    brief.current_state,
    JSON.stringify(brief.options),
    brief.recommended,
    now,
  );
  return id;
}

/** Apply a Work reducer command inside the WriteLane transaction. */
export function reduceWorkInTransaction(
  transaction: CoreWriteLaneTransaction,
  workId: string,
  command: WorkReducerCommand,
): ReductionResult<WorkRow> {
  const row = transaction.get<WorkRow>("SELECT * FROM works WHERE id = ?", workId);
  if (!row) {
    throw new HumanReadableError({
      code: "work_not_found",
      message: `Work ${workId} was not found.`,
      remediation: "Verify the Work identifier and refresh the list.",
      details: { work_id: workId },
    });
  }
  let result = reduceWork(row, command);
  if (result.changed) {
    persistWorkRow(transaction, result.next);
  }
  if (result.side_effects.includes("core_decision_required")) {
    ensureCoreDecision(transaction, row.id, [], coreWorkDecisionBrief(objectPayload(command), ownerLanguage(transaction)), result.next.updated_at);
  }
  if (command.event === "work.cancelled") {
    // A cancelled Work can no longer act on an answer, so its open
    // Decisions are closed instead of staying answerable forever.
    const cancelledDecisions = transaction.all<{ id: string }>(
      `SELECT id FROM decisions WHERE work_id = ? AND status = 'open'`,
      row.id,
    );
    if (cancelledDecisions.length > 0) {
      result = { ...result, cancelled_decision_ids: cancelledDecisions.map((decision) => decision.id) };
    }
    transaction.run(
      `UPDATE decisions
          SET status = 'cancelled', resolved_at = ?, state_version = state_version + 1
        WHERE work_id = ? AND status = 'open'`,
      result.next.updated_at,
      row.id,
    );
    // A Worker run still launch_pending with no pid has no process to wait
    // for, so it is closed as cancelled here instead of staying
    // cancel_requested until a restart. Core still signals it by id after the
    // commit, in case the runner is spawning it right now. Executor runs are
    // closed by their own finish handler.
    transaction.run(
      `UPDATE agent_runs
          SET status = CASE WHEN status = 'launch_pending' AND pid IS NULL AND role <> 'executor' THEN 'cancelled' ELSE 'cancel_requested' END,
              ended_at = CASE WHEN status = 'launch_pending' AND pid IS NULL AND role <> 'executor' THEN COALESCE(ended_at, ?) ELSE ended_at END,
              updated_at = ?
        WHERE work_id = ? AND status IN ('launch_pending', 'spawned', 'running')`,
      result.next.updated_at,
      result.next.updated_at,
      row.id,
    );
  }
  return result;
}

/** Archive metadata is independent of Work state and state_version. */
export function setWorkArchivedInTransaction(
  transaction: CoreWriteLaneTransaction,
  workId: string,
  expectedVersion: number | undefined,
  archived: boolean,
  now: string,
): { archived_at: string | null; changed: boolean; state_version: number } {
  const row = transaction.get<WorkRow>("SELECT * FROM works WHERE id = ?", workId);
  if (!row) throw notFound("work", workId);
  assertVersion(row.state_version, expectedVersion);
  if (row.state !== "completed" && row.state !== "cancelled") {
    throw invalidStateTransition("Only completed or cancelled Works can be archived or unarchived.", {
      work_id: workId,
      state: row.state,
    });
  }

  if (archived === (row.archived_at !== null)) {
    return { archived_at: row.archived_at, changed: false, state_version: row.state_version };
  }

  if (archived) {
    const activeAgents = transaction.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM agent_runs
        WHERE work_id = ? AND status IN ('launch_pending', 'spawned', 'running', 'cancel_requested')`,
      workId,
    );
    if (Number(activeAgents?.count ?? 0) > 0) {
      throw new HumanReadableError({
        code: "work_has_active_agents",
        message: "Stop active Agents before archiving this Work.",
        remediation: "Wait for the Agents to stop, then retry the archive command.",
        details: { work_id: workId },
      });
    }
    const openDecisions = transaction.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM decisions WHERE work_id = ? AND status = 'open'",
      workId,
    );
    if (Number(openDecisions?.count ?? 0) > 0) {
      throw new HumanReadableError({
        code: "work_has_open_decisions",
        message: "Resolve open Decisions before archiving this Work.",
        remediation: "Resolve or cancel the open Decisions, then retry the archive command.",
        details: { work_id: workId },
      });
    }
  }

  const archivedAt = archived ? now : null;
  const update = transaction.run(
    "UPDATE works SET archived_at = ?, updated_at = ? WHERE id = ? AND state_version = ? AND archived_at IS ?",
    archivedAt,
    now,
    workId,
    row.state_version,
    row.archived_at,
  );
  if (update.changes !== 1) {
    const current = transaction.get<Pick<WorkRow, "state_version">>("SELECT state_version FROM works WHERE id = ?", workId);
    throw versionConflict(expectedVersion ?? row.state_version, current?.state_version ?? row.state_version);
  }
  return { archived_at: archivedAt, changed: true, state_version: row.state_version };
}

/** Update Work display fields without changing the state transition version. */
export function updateWorkFieldsInTransaction(
  transaction: CoreWriteLaneTransaction,
  workId: string,
  expectedVersion: number | undefined,
  fields: { readonly title?: string; readonly summary?: string },
  now: string,
): {
  before: WorkRow;
  after: { title: string; summary: string };
  changed_fields: ("title" | "summary")[];
} {
  const row = transaction.get<WorkRow>("SELECT * FROM works WHERE id = ?", workId);
  if (!row) throw notFound("work", workId);
  assertVersion(row.state_version, expectedVersion);
  if (row.state === "completed" || row.state === "cancelled") {
    throw invalidStateTransition("Completed or cancelled Works cannot be edited.", { work_id: workId, state: row.state });
  }

  const title = fields.title ?? row.title;
  const summary = fields.summary ?? row.summary;
  const changedFields: ("title" | "summary")[] = [];
  if (fields.title !== undefined && title !== row.title) changedFields.push("title");
  if (fields.summary !== undefined && summary !== row.summary) changedFields.push("summary");
  if (changedFields.length === 0) return { before: row, after: { title, summary }, changed_fields: changedFields };

  const result = transaction.run(
    `UPDATE works SET title = ?, summary = ?, updated_at = ?
      WHERE id = ? AND state_version = ?`,
    title,
    summary,
    now,
    workId,
    row.state_version,
  );
  if (result.changes !== 1) {
    const current = transaction.get<Pick<WorkRow, "state_version">>("SELECT state_version FROM works WHERE id = ?", workId);
    throw versionConflict(expectedVersion ?? row.state_version, current?.state_version ?? row.state_version);
  }
  return { before: row, after: { title, summary }, changed_fields: changedFields };
}

/** Apply a Task reducer command inside the WriteLane transaction. */
export function reduceTaskInTransaction(
  transaction: CoreWriteLaneTransaction,
  taskId: string,
  command: TaskReducerCommand,
): ReductionResult<TaskRow> {
  const row = transaction.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId);
  if (!row) {
    throw new HumanReadableError({
      code: "task_not_found",
      message: `Task ${taskId} was not found.`,
      remediation: "Verify the Task identifier and refresh the list.",
      details: { task_id: taskId },
    });
  }
  let result = reduceTask(row, command);
  if (result.changed) {
    persistTaskRow(transaction, result.next);
  }
  const payload = objectPayload(command);
  if (result.side_effects.includes("agent_run_required")) {
    const role = requiredString(payload, "role");
    const provider = requiredString(payload, "provider");
    const model = requiredString(payload, "model");
    const invocationId = requiredString(payload, "invocation_id");
    insertAgentRun(transaction, {
      id: typeof payload.agent_run_id === "string" ? payload.agent_run_id : undefined,
      work_id: row.work_id,
      task_id: row.id,
      role,
      provider,
      model,
      effort: typeof payload.effort === "string" ? payload.effort : null,
      invocation_id: invocationId,
      design_tier: row.type === "design" ? (row.lead_designer_start_round == null ? "standard" : "lead") : null,
    },
    result.next.updated_at);
  }
  const agentRunId = typeof payload.agent_run_id === "string" ? payload.agent_run_id : null;
  if (
    agentRunId &&
    (command.event === "agent.exited" ||
      command.event === "task.failure.classified" ||
      command.event === "agent.crashed" ||
      command.event === "task.replan_requested" ||
      command.event === "task.rate_limited")
  ) {
    // The run ends `completed` with an outcome whenever it produced a valid
    // result, even if that result sends the Task back (replan, question, redo,
    // partial, not achieved). Only a run that could not produce a result ends
    // `failed`.
    const runOutcome = runOutcomeFromPayload(payload.run_outcome);
    let status: string;
    let outcome: string | null = null;
    if (command.event === "agent.exited") {
      status = "completed";
      outcome = runOutcome ?? "success";
    } else if (command.event === "task.replan_requested") {
      status = "completed";
      outcome = runOutcome ?? "replan";
    } else if (command.event === "task.rate_limited") {
      status = "exited";
    } else if (command.event === "task.failure.classified" && runOutcome !== null) {
      status = "completed";
      outcome = runOutcome;
    } else {
      status = "failed";
    }
    const reportValue = payload.report;
    const hasReport = !!reportValue && typeof reportValue === "object" && !Array.isArray(reportValue);
    const reportId = hasReport ? insertReport(transaction, agentRunId, reportValue, result.next.updated_at) : null;
    const update = transaction.run(
      `UPDATE agent_runs SET status = ?, outcome = ?, report_id = ?, ended_at = ?, updated_at = ?, usage_json = COALESCE(?, usage_json) WHERE id = ?`,
      status,
      outcome,
      reportId,
      result.next.updated_at,
      result.next.updated_at,
      usageJson(payload.usage),
      agentRunId,
    );
    if (update.changes !== 1) {
      throw new HumanReadableError({
        code: "agent_run_not_found",
        message: `Agent run ${agentRunId} was not found while recording its result.`,
        remediation: "Refresh Agent runs and retry the result handling step.",
        details: { agent_run_id: agentRunId, task_id: row.id },
      });
    }
  }
  if (result.side_effects.includes("task_superseded")) {
    // A Decision that only blocked the superseded Task has nothing left to decide.
    const supersededDecisionFilter = `
        WHERE work_id = ? AND status = 'open' AND scope = 'task'
          AND EXISTS (SELECT 1 FROM json_each(decisions.blocked_task_ids_json) WHERE value = ?)
          AND NOT EXISTS (
            SELECT 1 FROM json_each(decisions.blocked_task_ids_json) AS blocked
              JOIN tasks ON tasks.id = blocked.value
             WHERE blocked.value <> ? AND tasks.status NOT IN ('completed', 'cancelled')
          )`;
    const cancelledDecisions = transaction.all<{ id: string }>(
      `SELECT id FROM decisions${supersededDecisionFilter}`,
      row.work_id,
      row.id,
      row.id,
    );
    if (cancelledDecisions.length > 0) {
      result = { ...result, cancelled_decision_ids: cancelledDecisions.map((decision) => decision.id) };
    }
    transaction.run(
      `UPDATE decisions
          SET status = 'cancelled', resolved_at = ?, state_version = state_version + 1${supersededDecisionFilter}`,
      result.next.updated_at,
      row.work_id,
      row.id,
      row.id,
    );
  }
  if (result.manager_trigger) {
    ensureManagerTrigger(transaction, row, command.event, payload, result.next.updated_at);
  }
  if (row.status !== "failed" && result.next.status === "failed") {
    // Central cascade hook: whichever path fails a Task, its waiting
    // dependents fail in the same transaction instead of stalling forever.
    cascadeDependencyFailureInTransaction(transaction, row.work_id, row.id, result.next.updated_at);
  }
  if (result.side_effects.includes("core_decision_required")) {
    ensureCoreDecision(transaction, row.work_id, [row.id], coreTaskDecisionBrief(row.title, payload, ownerLanguage(transaction)), result.next.updated_at);
  }
  return result;
}

/**
 * Append one more event (with its websocket delivery) inside a transaction
 * whose canonical event the WriteLane already wrote. Used where one commit
 * changes several Tasks and each change must be visible in that Task's own
 * event history (cascade, restore, supersession).
 */
export function appendEventInTransaction(
  transaction: CoreWriteLaneTransaction,
  event: {
    readonly type: string;
    readonly idempotencyKey: string;
    readonly workId: string;
    readonly taskId: string | null;
    readonly payload: JsonObject;
    readonly now?: string;
  },
): string {
  const sequence = transaction.get<{ next_sequence: number }>(
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM events",
  );
  const eventId = createUlid();
  transaction.run(
    `INSERT INTO events
       (id, sequence, idempotency_key, type, work_id, task_id, agent_run_id,
        payload_json, status, attempt_no, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'pending', 0, ?)`,
    eventId,
    sequence?.next_sequence ?? 1,
    event.idempotencyKey,
    event.type,
    event.workId,
    event.taskId,
    JSON.stringify(event.payload),
    event.now ?? utcNow(),
  );
  transaction.run(
    `INSERT INTO outbox_deliveries
       (id, event_id, provider, provider_message_key, status, attempt_no)
     VALUES (?, ?, 'websocket', ?, 'pending', 0)`,
    createUlid(),
    eventId,
    `${eventId}:websocket`,
  );
  return eventId;
}

/**
 * Cascade a permanent Task failure to every Task that depends on it (Task
 * row 27). Only `waiting` Tasks are affected: a ready/running/verifying
 * Task keeps going until Core observes its own outcome. Each cascaded Task
 * gets its own `task.dependency_failed` event so the Work event log records
 * which failure propagated where, and reduceTaskInTransaction re-enters this
 * hook for the newly failed dependent, which covers transitive chains.
 */
export function cascadeDependencyFailureInTransaction(
  transaction: CoreWriteLaneTransaction,
  workId: string,
  failedTaskId: string,
  now: string = utcNow(),
): readonly string[] {
  const dependents = transaction.all<{ id: string; state_version: number }>(
    `SELECT tasks.id AS id, tasks.state_version AS state_version
       FROM task_dependencies AS edge
       JOIN tasks ON tasks.id = edge.task_id
      WHERE edge.depends_on_task_id = ? AND tasks.status = 'waiting'
      ORDER BY tasks.created_at ASC, tasks.id ASC`,
    failedTaskId,
  );
  const cascaded: string[] = [];
  for (const dependent of dependents) {
    const current = transaction.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", dependent.id);
    if (current?.status !== "waiting") continue;
    appendEventInTransaction(transaction, {
      type: "task.dependency_failed",
      // state_version makes the key unique when a restored dependent fails again.
      idempotencyKey: `task-dependency-failed:${dependent.id}:${failedTaskId}:${dependent.state_version}`,
      workId,
      taskId: dependent.id,
      payload: {
        task_id: dependent.id,
        failed_dependency_task_id: failedTaskId,
        reason: "dependency_failed",
      },
      now,
    });
    reduceTaskInTransaction(transaction, dependent.id, {
      event: "task.dependency_failed",
      payload: { failed_dependency_task_id: failedTaskId, reason: "dependency_failed", now },
    });
    cascaded.push(dependent.id);
  }
  return cascaded;
}

/** The `dependencies_completed` guard of Task rows 1, 20, 22 and 25: every dependency of the Task is completed. */
export function taskDependenciesCompletedInTransaction(transaction: CoreWriteLaneTransaction, taskId: string): boolean {
  const dependencies = transaction.all<{ status: string }>(
    `SELECT dependency.status AS status
       FROM task_dependencies AS edge
       JOIN tasks AS dependency ON dependency.id = edge.depends_on_task_id
      WHERE edge.task_id = ?`,
    taskId,
  );
  return dependencies.every((dependency) => dependency.status === "completed");
}

/**
 * Task row 31: return cascade-failed Tasks to waiting once none of their
 * dependencies is failed or cancelled any more. The candidates are found by
 * the durable failed_by_dependency_task_id marker, never by the Task's latest
 * event (a pause or resume event after the cascade used to hide it).
 * Iterates to a fixpoint so transitive cascades (T1 -> T2 -> T3) are restored
 * together. Called at the end of every transaction that can take a dependency
 * out of failed: replan, supersede, Decision answer and Work resume.
 */
export function restoreCascadedDependentsInTransaction(transaction: CoreWriteLaneTransaction, workId: string): readonly string[] {
  const restored: string[] = [];
  for (;;) {
    const candidates = transaction.all<{ id: string; dependency_id: string; state_version: number }>(
      `SELECT tasks.id AS id, tasks.failed_by_dependency_task_id AS dependency_id, tasks.state_version AS state_version
         FROM tasks
        WHERE tasks.work_id = ? AND tasks.status = 'failed'
          AND tasks.failed_by_dependency_task_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM task_dependencies AS edge
              JOIN tasks AS dependency ON dependency.id = edge.depends_on_task_id
             WHERE edge.task_id = tasks.id AND dependency.status IN ('failed', 'cancelled')
          )
        ORDER BY tasks.created_at ASC, tasks.id ASC`,
      workId,
    );
    if (candidates.length === 0) return restored;
    for (const candidate of candidates) {
      // The Task's own history records the restore (the counterpart of its
      // task.dependency_failed event); the fix context of a later attempt
      // starts after it (task-context.ts).
      appendEventInTransaction(transaction, {
        type: "task.dependency_restored",
        idempotencyKey: `task-dependency-restored:${candidate.id}:${candidate.dependency_id}:${candidate.state_version}`,
        workId,
        taskId: candidate.id,
        payload: { task_id: candidate.id, restored_dependency_task_id: candidate.dependency_id },
      });
      reduceTaskInTransaction(transaction, candidate.id, {
        event: "task.dependency_restored",
        payload: { restored_dependency_task_id: candidate.dependency_id },
      });
      restored.push(candidate.id);
    }
  }
}

const REPORT_RESULT_VALUES = new Set(["success", "failed", "partial"]);

const AGENT_RUN_OUTCOMES: ReadonlySet<string> = new Set(["success", "redo", "replan", "question", "partial", "not_achieved"]);

function runOutcomeFromPayload(value: unknown): string | null {
  return typeof value === "string" && AGENT_RUN_OUTCOMES.has(value) ? value : null;
}

function insertReport(
  transaction: CoreWriteLaneTransaction,
  agentRunId: string,
  value: unknown,
  now: string,
): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError("A valid report must be a JSON object.", { agent_run_id: agentRunId });
  }
  const record = value as JsonObject;
  const reportResult = record.result;
  if (typeof reportResult !== "string" || !REPORT_RESULT_VALUES.has(reportResult)) {
    throw validationError("A valid report must have result success, failed, or partial.", {
      agent_run_id: agentRunId,
    });
  }
  const payloadJson = JSON.stringify(value);
  const reportId = createUlid();
  const rawResponseSha256 = createHash("sha256").update(payloadJson).digest("hex");
  transaction.run(
    `INSERT INTO reports
       (id, agent_run_id, schema_version, result, payload_json,
        raw_response_sha256, raw_response_bytes, created_at)
     VALUES (?, ?, '1.0.0', ?, ?, ?, ?, ?)`,
    reportId,
    agentRunId,
    reportResult,
    payloadJson,
    rawResponseSha256,
    Buffer.byteLength(payloadJson, "utf8"),
    now,
  );
  return reportId;
}

function insertAgentRun(
  transaction: CoreWriteLaneTransaction,
  input: AgentRunRecordInput,
  now: string,
): string {
  const id = input.id ?? createUlid();
  transaction.run(
    `INSERT INTO agent_runs
       (id, work_id, task_id, role, provider, model, effort, design_tier, status,
        fencing_token, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'launch_pending', ?, ?, ?)`,
    id,
    input.work_id,
    input.task_id,
    input.role ?? "worker",
    input.provider ?? "unknown",
    input.model ?? "unknown",
    input.effort ?? null,
    input.design_tier ?? null,
    input.invocation_id ?? id,
    now,
    now,
  );
  return id;
}

const WORK_NEXT_DISPLAY_NUMBER_SETTINGS_KEY = "work_next_display_number";

function readProjectlessNextNumber(transaction: CoreWriteLaneTransaction): number {
  const stored = transaction.get<{ value_json: string }>(
    "SELECT value_json FROM settings WHERE key = ?",
    WORK_NEXT_DISPLAY_NUMBER_SETTINGS_KEY,
  );
  let parsed: number;
  try {
    parsed = stored === undefined ? 1 : Number(JSON.parse(stored.value_json));
  } catch {
    parsed = 1;
  }
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function writeProjectlessNextNumber(
  transaction: CoreWriteLaneTransaction,
  ownerId: string,
  next: number,
  now: string,
): void {
  transaction.run(
    `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
     VALUES (?, ?, '1.0.0', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    WORK_NEXT_DISPLAY_NUMBER_SETTINGS_KEY,
    ownerId,
    JSON.stringify(next),
    now,
  );
}

/** Take the next Work number for a Project (or for Project-less Works); numbers are never reused. */
function allocateWorkDisplayNumber(
  transaction: CoreWriteLaneTransaction,
  projectId: string | null,
  ownerId: string,
  now: string,
): number {
  if (projectId !== null) {
    const next = transaction.get<{ next_work_number: number }>(
      "SELECT next_work_number FROM projects WHERE id = ?",
      projectId,
    )?.next_work_number ?? 1;
    transaction.run("UPDATE projects SET next_work_number = ? WHERE id = ?", next + 1, projectId);
    return next;
  }
  const next = readProjectlessNextNumber(transaction);
  writeProjectlessNextNumber(transaction, ownerId, next + 1, now);
  return next;
}

/** Move a Project's Works into the Project-less display-number group without violating its unique index. */
export function detachProjectWorksInTransaction(
  transaction: CoreWriteLaneTransaction,
  projectId: string,
  ownerId: string,
  now: string,
): DetachedWork[] {
  const rows = transaction.all<{ id: string; display_number: number | null }>(
    `SELECT id, display_number FROM works WHERE project_id = ?
      ORDER BY display_number IS NULL, display_number, created_at, id`,
    projectId,
  );
  if (rows.length === 0) return [];

  const counter = readProjectlessNextNumber(transaction);
  const maxRow = transaction.get<{ max: number | null }>(
    "SELECT MAX(display_number) AS max FROM works WHERE project_id IS NULL AND display_number IS NOT NULL",
  );
  let next = Math.max(counter, (maxRow?.max ?? 0) + 1);
  const detached: DetachedWork[] = [];
  for (const row of rows) {
    const displayNumber = row.display_number === null ? null : next++;
    if (displayNumber === null) {
      transaction.run("UPDATE works SET project_id = NULL, updated_at = ? WHERE id = ?", now, row.id);
    } else {
      transaction.run("UPDATE works SET project_id = NULL, display_number = ?, updated_at = ? WHERE id = ?", displayNumber, now, row.id);
    }
    detached.push({ work_id: row.id, previous_display_number: row.display_number, display_number: displayNumber });
  }
  if (detached.some((work) => work.previous_display_number !== null)) {
    writeProjectlessNextNumber(transaction, ownerId, next, now);
  }
  return detached;
}

export function createWorkInTransaction(
  transaction: CoreWriteLaneTransaction,
  payload: CreateWorkPayload,
  ownerId = "owner:default",
): WorkRow {
  if (payload.title.trim().length < 1 || payload.title.length > 500) {
    throw validationError("Work title must contain between 1 and 500 characters.", { field: "title" });
  }
  if (payload.summary.length > 20000) {
    throw validationError("Work summary cannot exceed 20,000 characters.", { field: "summary" });
  }
  if (!["small", "normal", "large"].includes(payload.size)) {
    throw validationError("Work size must be small, normal, or large.", { field: "size" });
  }
  if (payload.design_mode !== undefined && payload.design_mode !== "auto" && payload.design_mode !== "lead") {
    throw validationError("Work design_mode must be auto or lead.", { field: "design_mode" });
  }
  const now = utcNow();
  ensureOwner(transaction, ownerId, now);
  if (payload.project_id !== null) {
    const project = transaction.get<{ id: string }>("SELECT id FROM projects WHERE id = ?", payload.project_id);
    if (!project) {
      throw new HumanReadableError({
        code: "project_not_found",
        message: `Project ${payload.project_id} was not found.`,
        remediation: "Choose an existing Project or create it before creating the Work.",
        details: { project_id: payload.project_id },
      });
    }
  }
  const row: WorkRow = {
    id: createUlid(),
    display_number: allocateWorkDisplayNumber(transaction, payload.project_id, ownerId, now),
    owner_id: ownerId,
    project_id: payload.project_id,
    title: payload.title,
    summary: payload.summary,
    size: payload.size,
    design_mode: payload.design_mode ?? "auto",
    state: "memo",
    state_version: 0,
    plan_revision: 0,
    rules_json: JSON.stringify({ schema_version: "1.0.0", rules: [] }),
    related_work_ids_json: JSON.stringify([]),
    created_at: now,
    updated_at: now,
    completed_at: null,
    cancelled_at: null,
    archived_at: null,
  };
  transaction.run(
    `INSERT INTO works
       (id, display_number, owner_id, project_id, title, summary, size, design_mode, state, state_version,
        plan_revision, rules_json, related_work_ids_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.display_number,
    row.owner_id,
    row.project_id,
    row.title,
    row.summary,
    row.size,
    row.design_mode,
    row.state,
    row.state_version,
    row.plan_revision,
    row.rules_json,
    row.related_work_ids_json,
    row.created_at,
    row.updated_at,
  );
  return row;
}

function detectCycle(
  items: readonly TaskPlanItem[],
  localIds: readonly string[],
  externalIds: ReadonlySet<string> = new Set(),
): void {
  const ids = new Set(localIds);
  const edges = new Map<string, readonly string[]>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const localId = localIds[index];
    const dependencies = item.depends_on ?? [];
    for (const dependency of dependencies) {
      if (!ids.has(dependency) && !externalIds.has(dependency)) {
        throw validationError("A Task dependency must refer to a Task in the same plan.", {
          task_id: localId,
          depends_on_task_id: dependency,
        });
      }
    }
    edges.set(localId, dependencies);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw validationError("The Task plan contains a dependency cycle.", { task_id: id });
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    for (const dependency of edges.get(id) ?? []) {
      if (ids.has(dependency)) visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) {
    visit(id);
  }
}

/** tasks.review_override storage for a plan item's `review`: undefined keeps Core's default. */
function reviewOverrideFor(review: boolean | undefined): "true" | "false" | null {
  return review === undefined ? null : review ? "true" : "false";
}

export function createTaskPlanInTransaction(
  transaction: CoreWriteLaneTransaction,
  workId: string,
  items: readonly TaskPlanItem[],
): readonly TaskRow[] {
  const work = transaction.get<{ id: string; design_mode: "auto" | "lead" }>("SELECT id, design_mode FROM works WHERE id = ?", workId);
  if (!work) {
    throw new HumanReadableError({
      code: "work_not_found",
      message: `Work ${workId} was not found.`,
      remediation: "Create the Work before registering its Task plan.",
      details: { work_id: workId },
    });
  }
  const existingTasks = transaction.all<{ id: string; manager_task_id: string | null }>(
    "SELECT id, manager_task_id FROM tasks WHERE work_id = ?",
    workId,
  );
  const existingRefs = new Map<string, string>();
  for (const task of existingTasks) {
    existingRefs.set(task.id, task.id);
    if (task.manager_task_id !== null) existingRefs.set(task.manager_task_id, task.id);
  }
  const localIds = items.map((item, index) => item.manager_task_id ?? item.id ?? `item-${index}`);
  const localAliases = new Map<string, string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const canonicalId = localIds[index];
    const aliases = [canonicalId, item.id, item.manager_task_id].filter(
      (alias): alias is string => typeof alias === "string" && alias.length > 0,
    );
    for (const alias of aliases) {
      const previous = localAliases.get(alias);
      if (previous !== undefined && previous !== canonicalId) {
        throw validationError("Every Manager Task identifier must be unique and non-empty.", { field: "tasks", task_id: alias });
      }
      localAliases.set(alias, canonicalId);
    }
  }
  if (new Set(localIds).size !== localIds.length || localIds.some((id) => id.length === 0)) {
    throw validationError("Every Manager Task identifier must be unique and non-empty.", { field: "tasks" });
  }
  if ([...localAliases.keys()].some((alias) => existingRefs.has(alias))) {
    throw validationError("A new Task identifier conflicts with an existing Task in this Work.", { field: "tasks" });
  }
  const normalizedItems = items.map((item) => ({
    ...item,
    depends_on: (item.depends_on ?? []).map((dependency) => localAliases.get(dependency) ?? dependency),
    parent_task_id: item.parent_task_id === undefined || item.parent_task_id === null
      ? item.parent_task_id
      : localAliases.get(item.parent_task_id) ?? item.parent_task_id,
  }));
  detectCycle(normalizedItems, localIds, new Set(existingRefs.keys()));
  const now = utcNow();
  const rows: TaskRow[] = [];
  const idMap = new Map<string, string>();
  for (const localId of localIds) {
    idMap.set(localId, createUlid());
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = normalizedItems[index];
    if (item.title.trim().length < 1 || item.title.length > 500) {
      throw validationError("Task title must contain between 1 and 500 characters.", { field: "title" });
    }
    const localId = localIds[index];
    const id = idMap.get(localId)!;
    const row: TaskRow = {
      id,
      work_id: workId,
      parent_task_id: null,
      title: item.title,
      type: item.type,
      status: "waiting",
      review_override: reviewOverrideFor(item.review),
      priority: item.priority ?? "normal",
      context: item.context ?? "",
      acceptance: item.acceptance,
      state_version: 0,
      failure_count: 0,
      same_error_count: 0,
      last_error_key: null,
      last_error_generation: null,
      review_round: 0,
      lead_designer_start_round: item.type === "design" && work.design_mode === "lead" ? 0 : null,
      reviewer_failure_count: 0,
      worker_generation: 0,
      worktree_path: null,
      worktree_state: null,
      last_failure_class: null,
      manager_task_id: localId,
      retry_no: 0,
      next_attempt_at: null,
      paused_from: null,
      failed_by_dependency_task_id: null,
      created_at: now,
      updated_at: now,
    };
    transaction.run(
      `INSERT INTO tasks
         (id, work_id, parent_task_id, title, type, status, review_override, priority, context,
          acceptance, state_version, failure_count, same_error_count, last_error_key,
          last_error_generation, review_round, lead_designer_start_round, worker_generation, worktree_path,
          worktree_state, last_failure_class, paused_from, created_at, updated_at,
          manager_task_id, retry_no, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.work_id,
      row.parent_task_id,
      row.title,
      row.type,
      row.status,
      row.review_override,
      row.priority,
      row.context,
      row.acceptance,
      row.state_version,
      row.failure_count,
      row.same_error_count,
      row.last_error_key,
      row.last_error_generation,
      row.review_round,
      row.lead_designer_start_round,
      row.worker_generation,
      row.worktree_path,
      row.worktree_state,
      row.last_failure_class,
      row.paused_from,
      row.created_at,
      row.updated_at,
      row.manager_task_id,
      row.retry_no,
      row.next_attempt_at,
    );
    rows.push(row);
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = normalizedItems[index];
    const row = rows[index];
    const parentLocalId = item.parent_task_id ?? null;
    const parentId = parentLocalId === null ? null : idMap.get(parentLocalId) ?? existingRefs.get(parentLocalId);
    if (parentLocalId !== null && parentId === undefined) {
      throw validationError("A Task parent must refer to a Task in this Work.", { parent_task_id: parentLocalId });
    }
    transaction.run("UPDATE tasks SET parent_task_id = ? WHERE id = ?", parentId ?? null, row.id);
    row.parent_task_id = parentId ?? null;
    for (const dependency of item.depends_on ?? []) {
      const mappedDep = idMap.get(dependency) ?? existingRefs.get(dependency);
      if (!mappedDep) {
        throw validationError("A Task dependency must refer to a Task in this Work.", { depends_on_task_id: dependency });
      }
      transaction.run(
        "INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)",
        row.id,
        mappedDep,
      );
    }
  }
  return rows;
}

/** applyReplanInTransaction refused: the Work is no longer running (paused, cancelled, blocked on a Decision). Nothing was written. */
export const REPLAN_WORK_NOT_RUNNING = "replan_work_not_running";
/** applyReplanInTransaction refused: the plan or a root Task changed since the Manager was asked. Nothing was written. */
export const REPLAN_PLAN_STALE = "replan_plan_stale";

export interface ReplanApplyGuard {
  /** works.plan_revision of the snapshot the plan was validated against. */
  readonly base_plan_revision: number;
  /** Status of each root Task in that snapshot; a root Task without an entry must be `failed`. */
  readonly root_statuses: ReadonlyMap<string, string>;
}

export interface ReplanApplyResult {
  readonly registered: readonly TaskRow[];
  readonly reopened: readonly string[];
  /** Replaced root Task id -> the ids of the new Tasks replacing it. */
  readonly replacements: Readonly<Record<string, readonly string[]>>;
  /** Decisions closed because their only blocked Task was superseded by this replan. */
  readonly cancelled_decision_ids: readonly string[];
}

/**
 * Throw when the Work's dependency graph has an edge leaving the Work or a
 * cycle. Works on the WriteLane transaction (before commit) and on the
 * database (WorkflowEngine.validateDependencies).
 */
export function assertTaskDependencyGraph(reader: Pick<CoreWriteLaneTransaction, "all">, workId: string, cycleMessage = "The Work contains a dependency cycle."): void {
  const tasks = reader.all<{ id: string }>("SELECT id FROM tasks WHERE work_id = ?", workId);
  const dependencies = reader.all<{ task_id: string; depends_on_task_id: string }>(
    `SELECT task_id, depends_on_task_id
       FROM task_dependencies
      WHERE task_id IN (SELECT id FROM tasks WHERE work_id = ?)`,
    workId,
  );
  const edges = new Map<string, string[]>();
  for (const task of tasks) edges.set(task.id, []);
  for (const dependency of dependencies) {
    const list = edges.get(dependency.task_id);
    if (!list || !edges.has(dependency.depends_on_task_id)) {
      throw validationError("A dependency references a Task outside the Work.", dependency);
    }
    list.push(dependency.depends_on_task_id);
  }
  const cycle = findDependencyCycle(edges);
  if (cycle) throw validationError(cycleMessage, { task_id: cycle[0], cycle });
}

function replanAbort(code: string, message: string, details: Record<string, unknown>): HumanReadableError {
  return new HumanReadableError({
    code,
    message,
    remediation: "Nothing was applied. Core asks the Manager again once the Work is running.",
    details,
  });
}

/**
 * Apply a validated Manager replan (Task rows 20/20b, 30, 31) in ONE
 * transaction: register the new Tasks, replace the dependencies of retried
 * Tasks, retire replaced Tasks and re-point their dependents at their own
 * replacements, retry the retried Tasks with their revisions, restore
 * cascaded dependents, bump plan_revision once and check the resulting
 * dependency graph before commit. Any throw rolls every step back.
 *
 * The Manager call takes minutes, so the Work is re-checked here: a Work
 * that is no longer running (REPLAN_WORK_NOT_RUNNING) or whose plan or root
 * Tasks changed since the snapshot (REPLAN_PLAN_STALE) aborts with nothing
 * written.
 */
export function applyReplanInTransaction(
  transaction: CoreWriteLaneTransaction,
  workId: string,
  plan: ReplanPlan,
  guard: ReplanApplyGuard,
  reason: string,
): ReplanApplyResult {
  const work = transaction.get<{ state: string; plan_revision: number }>("SELECT state, plan_revision FROM works WHERE id = ?", workId);
  if (!work) {
    throw new HumanReadableError({
      code: "work_not_found",
      message: `Work ${workId} was not found.`,
      remediation: "Refresh the Work list.",
      details: { work_id: workId },
    });
  }
  if (work.state !== "running") {
    throw replanAbort(REPLAN_WORK_NOT_RUNNING, `The replan was not applied because Work ${workId} is ${work.state}, not running.`, {
      work_id: workId,
      state: work.state,
    });
  }
  if (work.plan_revision !== guard.base_plan_revision) {
    throw replanAbort(REPLAN_PLAN_STALE, `The replan was not applied because the Work plan changed while the Manager was working (revision ${guard.base_plan_revision} -> ${work.plan_revision}).`, {
      work_id: workId,
      expected: guard.base_plan_revision,
      actual: work.plan_revision,
    });
  }
  const rootIds = [...new Set([...plan.reopenIds, ...plan.supersessions.keys()])];
  for (const rootId of rootIds) {
    const row = transaction.get<{ status: string; work_id: string }>("SELECT status, work_id FROM tasks WHERE id = ?", rootId);
    const expected = guard.root_statuses.get(rootId) ?? "failed";
    if (!row || row.work_id !== workId || row.status !== expected) {
      throw replanAbort(REPLAN_PLAN_STALE, `The replan was not applied because Task ${rootId} is ${row?.status ?? "missing"}, not ${expected} as when the Manager was asked.`, {
        work_id: workId,
        task_id: rootId,
        expected,
        actual: row?.status ?? null,
      });
    }
  }
  const now = utcNow();

  const registered = plan.newItems.length > 0 ? createTaskPlanInTransaction(transaction, workId, plan.newItems) : [];
  const registeredByLocalId = new Map(registered.map((task) => [task.manager_task_id ?? task.id, task.id]));
  const registeredId = (localId: string): string => {
    const taskId = registeredByLocalId.get(localId);
    if (taskId === undefined) throw validationError("A Task of the replan was not registered.", { work_id: workId, task_id: localId });
    return taskId;
  };

  // L1: a retried Task's depends_on replaces its dependencies. Edges into a
  // replaced Task are re-pointed below like every other dependent's.
  for (const taskId of plan.reopenIds) {
    const dependsOn = plan.revisions.get(taskId)?.depends_on;
    if (dependsOn === undefined) continue;
    transaction.run("DELETE FROM task_dependencies WHERE task_id = ?", taskId);
    for (const dependency of dependsOn) {
      const dependencyId = "task_id" in dependency ? dependency.task_id : registeredId(dependency.new_task);
      const owner = transaction.get<{ work_id: string }>("SELECT work_id FROM tasks WHERE id = ?", dependencyId);
      if (owner?.work_id !== workId || dependencyId === taskId) {
        throw validationError("A retried Task's dependency must be another Task of this Work.", { task_id: taskId, depends_on_task_id: dependencyId });
      }
      transaction.run("INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)", taskId, dependencyId);
    }
  }

  // Row 30: retire each replaced Task; its dependents wait for its own replacements.
  const replacements: Record<string, string[]> = {};
  const cancelledDecisionIds: string[] = [];
  for (const [taskId, localIds] of plan.supersessions) {
    const replacementIds = localIds.map(registeredId);
    const superseded = reduceTaskInTransaction(transaction, taskId, { event: "task.superseded", payload: { reason } });
    if (superseded.cancelled_decision_ids) cancelledDecisionIds.push(...superseded.cancelled_decision_ids);
    const dependents = transaction.all<{ task_id: string }>("SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?", taskId);
    transaction.run("DELETE FROM task_dependencies WHERE depends_on_task_id = ?", taskId);
    for (const { task_id: dependentId } of dependents) {
      for (const replacementId of replacementIds) {
        if (replacementId === dependentId) continue;
        transaction.run("INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)", dependentId, replacementId);
      }
    }
    replacements[taskId] = replacementIds;
  }
  if (plan.supersessions.size > 0) {
    appendEventInTransaction(transaction, {
      type: "task.superseded",
      idempotencyKey: `tasks-superseded:${workId}:${guard.base_plan_revision}`,
      workId,
      taskId: null,
      payload: {
        work_id: workId,
        task_ids: Object.keys(replacements),
        replacement_task_ids: [...new Set(Object.values(replacements).flat())],
        replacements,
        reason,
      },
      now,
    });
  }

  // Rows 20/20b: retry, with the Manager's revised instructions.
  for (const taskId of plan.reopenIds) {
    reduceTaskInTransaction(transaction, taskId, {
      event: "task.replanned",
      payload: {
        base_plan_version: guard.base_plan_revision,
        current_plan_version: work.plan_revision,
        dependencies_completed: taskDependenciesCompletedInTransaction(transaction, taskId),
      },
    });
    const revision = plan.revisions.get(taskId);
    if (revision) {
      transaction.run(
        "UPDATE tasks SET title = ?, acceptance = ?, context = COALESCE(?, context), type = ?, review_override = ?, updated_at = ? WHERE id = ?",
        revision.title,
        revision.acceptance,
        revision.context ?? null,
        revision.type,
        reviewOverrideFor(revision.review),
        now,
        taskId,
      );
    }
  }

  restoreCascadedDependentsInTransaction(transaction, workId);
  transaction.run("UPDATE works SET plan_revision = plan_revision + 1, updated_at = ? WHERE id = ?", now, workId);
  assertTaskDependencyGraph(transaction, workId, "The replan creates a dependency cycle.");
  return { registered, reopened: [...plan.reopenIds], replacements, cancelled_decision_ids: cancelledDecisionIds };
}

export interface OpenDecisionInput {
  readonly id?: string;
  readonly work_id: string;
  readonly scope: "task" | "work";
  readonly blocked_task_ids: readonly string[];
  readonly reason: string;
  /** What the Owner is asked to decide (see decision-brief.ts). */
  readonly question: string;
  readonly tried: string;
  readonly current_state: string;
  /** `{key, label, description}`: description says what choosing it does. */
  readonly options: readonly JsonObject[];
  readonly recommended: string | null;
  readonly allow_free_text: boolean;
  readonly issuer_role: "core" | "advisor" | "manager";
  /**
   * Work-scope only: false opens an informational Decision that does not
   * move the Work (for example a post-completion policy confirmation, where
   * a completed Work cannot enter judgement_waiting). Defaults to true.
   */
  readonly blocks_work?: boolean;
}

export interface DecisionRow {
  id: string;
  work_id: string;
  scope: "task" | "work";
  status: "open" | "resolved" | "cancelled";
  blocked_task_ids_json: string;
  reason: string;
  question: string;
  tried: string;
  current_state: string;
  options_json: string;
  recommended: string | null;
  allow_free_text: number;
  issuer_role: "core" | "advisor" | "manager";
  state_version: number;
  created_at: string;
  resolved_at: string | null;
}

export function openDecisionInTransaction(
  transaction: CoreWriteLaneTransaction,
  input: OpenDecisionInput,
): DecisionRow {
  assertDecisionBrief(input);
  const work = transaction.get<{ id: string }>("SELECT id FROM works WHERE id = ?", input.work_id);
  if (!work) {
    throw new HumanReadableError({
      code: "work_not_found",
      message: `Work ${input.work_id} was not found.`,
      remediation: "Create the Work before opening a Decision.",
      details: { work_id: input.work_id },
    });
  }
  const now = utcNow();
  const id = input.id ?? createUlid();
  transaction.run(
    `INSERT INTO decisions
       (id, work_id, scope, status, blocked_task_ids_json, reason, question, tried,
        current_state, options_json, recommended, allow_free_text, issuer_role,
        state_version, created_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    id,
    input.work_id,
    input.scope,
    JSON.stringify(input.blocked_task_ids),
    input.reason,
    input.question,
    input.tried,
    input.current_state,
    JSON.stringify(input.options),
    input.recommended,
    input.allow_free_text ? 1 : 0,
    input.issuer_role,
    now,
  );
  if (input.scope === "work" && input.blocks_work === false) {
    if (input.blocked_task_ids.length > 0) {
      throw validationError("A non-blocking Decision cannot block Tasks.", { field: "blocked_task_ids" });
    }
  } else if (input.scope === "work") {
    reduceWorkInTransaction(transaction, input.work_id, {
      event: "decision.opened",
      payload: { blocks_work: true, reason: input.reason },
    });
  } else {
    for (const taskId of input.blocked_task_ids) {
      reduceTaskInTransaction(transaction, taskId, {
        event: "decision.opened",
        payload: { blocks_task: true, issuer: input.issuer_role, reason: input.reason },
      });
    }
  }
  return {
    id,
    work_id: input.work_id,
    scope: input.scope,
    status: "open",
    blocked_task_ids_json: JSON.stringify(input.blocked_task_ids),
    reason: input.reason,
    question: input.question,
    tried: input.tried,
    current_state: input.current_state,
    options_json: JSON.stringify(input.options),
    recommended: input.recommended,
    allow_free_text: input.allow_free_text ? 1 : 0,
    issuer_role: input.issuer_role,
    state_version: 0,
    created_at: now,
    resolved_at: null,
  };
}

export interface ResolveDecisionInput {
  readonly decision_id: string;
  readonly expected_version: number;
  readonly answerer_id: string;
  readonly answer: string;
  readonly option_key: string | null;
  readonly source: "web" | "slack" | "discord" | "advisor";
  readonly source_message_id: string | null;
}

export interface ResolveDecisionResult {
  readonly decision: DecisionRow;
  readonly resumed_task_ids: readonly string[];
}

export function resolveDecisionInTransaction(
  transaction: CoreWriteLaneTransaction,
  input: ResolveDecisionInput,
): ResolveDecisionResult {
  if (input.answer.length < 1 || input.answer.length > 10000) {
    throw validationError("Decision answer must contain between 1 and 10,000 characters.", { field: "answer" });
  }
  const decision = transaction.get<DecisionRow>("SELECT * FROM decisions WHERE id = ?", input.decision_id);
  if (!decision) {
    throw new HumanReadableError({
      code: "decision_not_found",
      message: `Decision ${input.decision_id} was not found.`,
      remediation: "Refresh the open Decision list and answer an available Decision.",
      details: { decision_id: input.decision_id },
    });
  }
  if (decision.status !== "open") {
    throw new HumanReadableError({
      code: "decision_already_resolved",
      message: "This Decision already has a committed answer.",
      remediation: "Use the existing Decision result; a second answer cannot change it.",
      details: { decision_id: decision.id, status: decision.status },
    });
  }
  if (decision.state_version !== input.expected_version) {
    throw versionConflict(input.expected_version, decision.state_version);
  }
  if (input.option_key === null && decision.allow_free_text !== 1) {
    throw validationError("This Decision does not allow a free-text answer; select one of the stored options.", {
      decision_id: decision.id,
      allow_free_text: false,
    });
  }
  if (input.option_key !== null) {
    let storedOptions: unknown;
    try {
      storedOptions = JSON.parse(decision.options_json) as unknown;
    } catch (error) {
      throw validationError("The stored Decision options value is invalid.", { decision_id: decision.id, cause: error instanceof Error ? error.message : "parse_error" });
    }
    if (!Array.isArray(storedOptions)) {
      throw validationError("The stored Decision options value is invalid.", { decision_id: decision.id });
    }
    const selected = storedOptions.find((option) =>
      typeof option === "object" && option !== null && !Array.isArray(option)
      && (option as Record<string, unknown>).key === input.option_key,
    ) as Record<string, unknown> | undefined;
    if (!selected) {
      throw validationError("The selected Decision option is not one of the stored options.", {
        decision_id: decision.id,
        option_key: input.option_key,
      });
    }
    if (typeof selected.label === "string" && input.answer !== selected.label) {
      throw validationError("The answer text must match the label of the selected option.", {
        decision_id: decision.id,
        option_key: input.option_key,
      });
    }
  }
  const now = utcNow();
  ensureOwner(transaction, input.answerer_id, now);
  const update = transaction.run(
    `UPDATE decisions
        SET status = 'resolved', state_version = state_version + 1, resolved_at = ?
      WHERE id = ? AND status = 'open' AND state_version = ?`,
    now,
    decision.id,
    input.expected_version,
  );
  if (update.changes !== 1) {
    throw new HumanReadableError({
      code: "decision_already_resolved",
      message: "Another answer won the Decision CAS race.",
      remediation: "Refresh the Decision and use its committed result.",
      details: { decision_id: decision.id },
    });
  }
  transaction.run(
    `INSERT INTO decision_answers
       (id, decision_id, answerer_id, answer_json, source, source_message_id, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    createUlid(),
    decision.id,
    input.answerer_id,
    JSON.stringify({ answer: input.answer, option_key: input.option_key }),
    input.source,
    input.source_message_id,
    now,
  );

  const blockedTaskIds = JSON.parse(decision.blocked_task_ids_json) as unknown;
  if (!Array.isArray(blockedTaskIds) || blockedTaskIds.some((id) => typeof id !== "string")) {
    throw validationError("The stored Decision blocked_task_ids value is invalid.", { decision_id: decision.id });
  }
  const resumedTaskIds: string[] = [];
  // A "cancel" answer ends the Work (Core.answerDecision cancels it right
  // after this commit), so nothing blocked by the Decision is resumed.
  const cancelAnswer = isDecisionCancelAnswer(decision, input.option_key);
  for (const taskId of cancelAnswer ? [] : blockedTaskIds) {
    const dependenciesCompleted = taskDependenciesCompletedInTransaction(transaction, taskId);
    const row = transaction.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId);
    if (!row) {
      throw new HumanReadableError({
        code: "task_not_found",
        message: `Blocked Task ${taskId} was not found while resolving the Decision.`,
        remediation: "Repair the Decision scope before retrying its answer.",
        details: { task_id: taskId, decision_id: decision.id },
      });
    }
    if (row.status === "judgement_waiting") {
      reduceTaskInTransaction(transaction, taskId, {
        event: "decision.resolved",
        payload: { winner_commit: true, dependencies_completed: dependenciesCompleted },
      });
      resumedTaskIds.push(taskId);
    }
  }
  if (!cancelAnswer) {
    // A Task this answer resumed may be the dependency a cascaded Task failed
    // on; that Task goes back to waiting in the same commit.
    restoreCascadedDependentsInTransaction(transaction, decision.work_id);
  }
  if (decision.scope === "work" && !cancelAnswer) {
    const work = transaction.get<WorkRow>("SELECT * FROM works WHERE id = ?", decision.work_id);
    if (!work) {
      throw new HumanReadableError({
        code: "work_not_found",
        message: `Work ${decision.work_id} was not found while resolving the Decision.`,
        remediation: "Repair the Decision scope before retrying its answer.",
        details: { work_id: decision.work_id, decision_id: decision.id },
      });
    }
    if (work.state === "judgement_waiting") {
      reduceWorkInTransaction(transaction, decision.work_id, {
        event: "decision.resolved",
        payload: { winner_commit: true },
      });
    }
  }
  return {
    decision: { ...decision, status: "resolved", state_version: decision.state_version + 1, resolved_at: now },
    resumed_task_ids: resumedTaskIds,
  };
}

export function resolveTaskState(row: TaskRow, dependenciesCompleted: boolean): TaskState {
  if (row.status !== "waiting") {
    return row.status;
  }
  return dependenciesCompleted ? "ready" : "waiting";
}
