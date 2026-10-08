import { createHash } from "node:crypto";
import { createUlid, utcNow } from "../../db/dist/index.js";
import { OUTPUT_FORMAT_INVALID_ERROR_KEY, readDesignBlocked, usageJson } from "@owl/shared";
import type { ReviewLimitSettings } from "../../shared/dist/review-limit-settings.js";
import { HumanReadableError, invalidStateTransition, notFound, validationError, versionConflict } from "./errors";
import {
  DECISION_CANCEL_OPTION_KEY,
  assertDecisionBrief,
  coreTaskDecisionBrief,
  coreWorkDecisionBrief,
  noProgressLimitBrief,
  designBlockedBrief,
  remakeLimitBrief,
  reviewBudgetReason,
  type DecisionBrief,
} from "./decision-brief";
import * as AttemptPolicy from "./attempt-policy";
import { attemptAction, type AttemptDecision, type AttemptReason } from "./attempt-policy";
import { ownerLanguage } from "./owner-language";
import { reviewLimits } from "./review-limits";
import { previousFixSpots, reviewFocusSettings, reviewSpots, type ReviewSpot } from "./review-focus";
import type { ReviewFocusSettings } from "../../shared/dist/review-focus-settings.js";
import { remakeLimits } from "./remake-limits";
import { progressGuard } from "./progress-guard";
import { assignReplacementLineageInTransaction, lineageExternalBlockerReports, lineageGenerationCount, lineageReviewAttemptsExcluding, lineageUsage, parseLineageReset, restartLineageBudgetInTransaction } from "./task-lineage";
import type { RemakeLimitSettings } from "../../shared/dist/remake-limit-settings.js";
import { findDependencyCycle, type ReplanPlan } from "./replan-plan";
import { PROCESS_WAIT_EVENT, validatePrerequisiteSpec, type PrerequisiteSpec } from "../../shared/dist/prerequisite.js";
import { ACCEPTANCE_DEFECT_EVENT, workerAcceptanceDefects } from "../../shared/dist/acceptance-defect.js";
import { EXTERNAL_BLOCKER_EVENT } from "../../shared/dist/external-blocker.js";
import type {
  CoreWriteLaneTransaction,
  CreateWorkPayload,
  DetachedWork,
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
  { row: 13, current: "verifying", guard: "verification fail and review_round < review_limits.plan_review_rounds", event: "verification.completed", next: "review_fix_waiting" },
  { row: 14, current: "verifying", guard: "verification fail and review_round >= review_limits.plan_review_rounds", event: "verification.completed -> task.failed", next: "failed" },
  { row: 15, current: "verifying", guard: "review pass and merge exit 0", event: "review.passed -> git.merge.result", next: "completed" },
  { row: 16, current: "verifying", guard: "review pass and merge exit != 0", event: "review.passed -> git.merge.aborted -> task.conflict", next: "failed" },
  { row: 17, current: "verifying", guard: "review fix_required and review_round < review_limits.plan_review_rounds", event: "review.failed", next: "review_fix_waiting" },
  { row: 18, current: "verifying", guard: "review fix_required and review_round >= review_limits.plan_review_rounds", event: "review.failed", next: "failed" },
  { row: 19, current: "review_fix_waiting", guard: "replacement lease", event: "task.started", next: "running" },
  { row: "18b", current: "verifying", guard: "review not passed and total_review_attempts reached review_limits.total_review_attempts", event: "review.failed", next: "failed" },
  { row: "18e", current: "verifying", guard: "design Task escalated from the standard Designer to Lead (not one that began at Lead under design_mode=lead) and lineage-wide lead rejections reached remake_limits.lead_review_rejections (only Owner answers to a Decision restart the count; Manager replans, replacements and Owner-initiated replans carry it over)", event: "review.failed", next: "review_fix_waiting (stop-report run, then judgement_waiting)" },
  { row: "32d", current: "running", guard: "design Task: the Designer reported design_blocked, or the stop-report run (design_stop_json set) ended; no remake", event: "task.design_blocked -> decision.opened", next: "judgement_waiting" },
  { row: "32e", current: "running", guard: "stop-report run (design_stop_json set) crashed, failed or was rate limited", event: "task.failure.classified | agent.crashed | task.rate_limited", next: "judgement_waiting" },
  { row: "32f", current: "ready | review_fix_waiting", guard: "design Task with design_stop_json set and its Designer provider paused", event: "task.design_blocked", next: "judgement_waiting" },
  { row: "18d", current: "verifying", guard: "review not passed and lineage-wide Reviewer verdicts reached remake_limits.lineage_review_attempts (base-sync-only generations are checked against remake_limits.base_sync_lineage_review_attempts instead)", event: "review.failed -> decision.opened", next: "judgement_waiting" },
  { row: "18c", current: "verifying", guard: "review not passed and total_review_attempts exceeded review_limits.total_review_attempts", event: "review.failed -> decision.opened", next: "judgement_waiting" },
  { row: 20, current: "failed", guard: "manager replan accepted and every dependency completed; failure counters, reviewer failures and review_round reset", event: "task.replanned", next: "ready" },
  { row: "20b", current: "failed", guard: "manager replan accepted but a dependency is not completed; same resets as row 20", event: "task.replanned", next: "waiting" },
  { row: "20c", current: "failed", guard: "manager replan accepted with payload.prerequisite (wait_for); same resets as row 20, no_progress_count kept; prerequisite_json and prerequisite_since recorded", event: "task.replanned", next: "waiting" },
  { row: 21, current: "failed", guard: "manager or core cannot continue and owner decision open", event: "decision.opened", next: "judgement_waiting" },
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
  { row: "32b", current: "running", guard: "Worker reported acceptance criteria it cannot prove inside the Task (source=worker); failure counters kept", event: "task.acceptance_defect_reported", next: "failed" },
  { row: "28b", current: "verifying", guard: "Reviewer reported acceptance criteria that cannot be proven inside the Task (source=reviewer); review_round, total_review_attempts and reviewer_failure_count kept", event: "task.acceptance_defect_reported", next: "failed" },
  { row: 33, current: "completed/failed/cancelled", guard: "no agent run is active on the worktree", event: "task.worktree.discarded", next: "same status" },
  { row: 34, current: "running", guard: "provider returned rate_limited", event: "task.rate_limited", next: "ready" },
  { row: 35, current: "ready/review_fix_waiting", guard: "Task worktree conflicts with the Work branch before launch; merge aborted", event: "task.conflict", next: "failed" },
  { row: 36, current: "ready/review_fix_waiting", guard: "Core stops a launch because no_progress_count reached progress_guard.no_progress_limit", event: "decision.opened", next: "judgement_waiting" },
  { row: "32c", current: "running", guard: "Worker reported pending_process within progress_guard.process_wait_max_count; prerequisite_json (source=worker, kind=process) and prerequisite_since recorded; failure counters and no_progress_count kept", event: "task.process_wait_started", next: "waiting" },
  { row: "32d", current: "running", guard: "Worker reported external_blocker; within progress_guard.external_blocker_limit over the lineage the Manager is triggered (failure counters and no_progress_count kept), past it the Owner decides", event: "task.external_blocker_reported", next: "failed/judgement_waiting" },
  { row: 37, current: "waiting", guard: "prerequisite set and Core found it expired, unreachable or in sync conflict; mark kept for the Decision brief", event: "decision.opened", next: "judgement_waiting" },
  { row: 38, current: "waiting", guard: "prerequisite set and every condition holds; mark cleared, no_progress_count kept", event: "task.prerequisite_satisfied", next: "waiting" },
  { row: 39, current: "waiting/paused(paused_from=waiting)", guard: "prerequisite set and the Owner resumed it; mark cleared, no_progress_count=0", event: "task.prerequisite_resumed", next: "same state" },
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
export { REVIEWER_FAILURE_LIMIT } from "./attempt-policy";

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
  /** The Task's base-sync-only mark (0/1) when this run was launched. */
  readonly base_sync_only?: number;
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
function integrationResult(
  row: TaskRow,
  payload: JsonObject,
  now: string,
  successSideEffects: readonly string[],
  successReason: "review_passed" | "verified_without_review",
  countReview: boolean,
): ReductionResult<TaskRow> {
  const merge = integrationMerge(payload);
  return applyAttemptEvaluation(row, "integration", now, AttemptPolicy.evaluate({
    kind: "integration", task: row, merge, successReason, successSideEffects, countReview,
  }, AttemptPolicy.DEFAULT_ATTEMPT_POLICY_CONFIG));
}

function integrationMerge(payload: JsonObject): AttemptPolicy.IntegrationMerge {
  if (requiredNumber(payload, "merge_exit_code") === 0) {
    return { outcome: "merged", worktreeRetained: payload.worktree_state === "retained" };
  }
  const taskBranch = requiredString(payload, "task_branch");
  const workBranch = requiredString(payload, "work_branch");
  return { outcome: payload.failure_kind === "commit_failure" ? "commit_failure" : "conflict", taskBranch, workBranch };
}

/** Adds the Attempt Policy decision to a transition that is a decision (not verifying / running / paused / cancelled). */
function decided(result: ReductionResult<TaskRow>, reason: AttemptReason): ReductionResult<TaskRow> {
  const action = attemptAction(result.next.status, result.manager_trigger, reason);
  if (action === null) return result;
  const decision: AttemptDecision = { action, reason, from: result.previous.status, to: result.next.status };
  return { ...result, decision };
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
      previous.total_review_attempts !== next.total_review_attempts ||
      (previous.lineage_generation ?? 1) !== (next.lineage_generation ?? 1) ||
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
  return { ...row, ...AttemptPolicy.FAILURE_COUNTER_RESET };
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

/**
 * Builds the evaluate() thresholds from reduceTask's options. Values are not
 * defaulted with `??`: tests/remake/limits.test.mjs passes a partial lineage and
 * relies on the undefined limit never triggering the base-sync stop.
 */
function attemptPolicyConfig(options: TaskReducerOptions): AttemptPolicy.AttemptPolicyConfig {
  return {
    ...AttemptPolicy.DEFAULT_ATTEMPT_POLICY_CONFIG,
    reviewLimits: options.reviewLimits ?? AttemptPolicy.DEFAULT_ATTEMPT_POLICY_CONFIG.reviewLimits,
    reviewFocus: options.reviewFocus ?? AttemptPolicy.DEFAULT_ATTEMPT_POLICY_CONFIG.reviewFocus,
    lineageLimits: options.lineage
      ? { reviewAttempts: options.lineage.limit, baseSyncReviewAttempts: options.lineage.baseSyncLimit, leadReviewRejections: options.lineage.leadRejectionLimit }
      : null,
    // Not defaulted by a missing lineage: only the external_blocker branch reads it, so the base-sync problem above cannot occur.
    externalBlockerLimit: options.externalBlocker?.limit ?? AttemptPolicy.DEFAULT_ATTEMPT_POLICY_CONFIG.externalBlockerLimit,
  };
}

/** options.lineage の回数の側。attemptPolicyConfig と同じ options.lineage から作るので、null になるときは両方 null。 */
function lineageObservation(options: TaskReducerOptions): AttemptPolicy.AttemptLineageObservation | null {
  return options.lineage
    ? {
      otherReviewAttempts: options.lineage.otherReviewAttempts,
      otherBaseSyncReviewAttempts: options.lineage.otherBaseSyncReviewAttempts,
      generations: options.lineage.generations,
      otherLeadRejections: options.lineage.otherLeadRejections,
    }
    : null;
}

function applyAttemptEvaluation(row: TaskRow, event: string, now: string, evaluation: AttemptPolicy.AttemptTaskEvaluation): ReductionResult<TaskRow> {
  if (evaluation.outcome === "reject") reject(row, event, evaluation.message);
  return applyAttemptDecision(row, evaluation.decision, now);
}

function applyAttemptDecision(row: TaskRow, decision: AttemptPolicy.AttemptPolicyDecision, now: string): ReductionResult<TaskRow> {
  const next: TaskRow = {
    ...withTaskVersion({ ...row, ...decision.patch }, decision.to, now),
    ...(decision.designStop ? { design_stop_json: JSON.stringify({ ...decision.designStop, at: now }) } : {}),
  };
  // Only the four AttemptDecision fields are recorded: task.attempt_decided spreads
  // ...result.decision into its payload, so patch/sideEffects would leak into the event.
  const recorded: AttemptDecision = { action: decision.action, reason: decision.reason, from: decision.from, to: decision.to };
  return {
    ...taskResult(row, next, decision.sideEffects, decision.managerTrigger),
    decision: recorded,
    ...(decision.reviewBudget ? { review_budget: decision.reviewBudget } : {}),
    ...(decision.lineageBudget ? { lineage_budget: decision.lineageBudget } : {}),
    ...(decision.designBlock ? { design_block: decision.designBlock } : {}),
    ...(decision.sameSpot ? { review_same_spot: decision.sameSpot } : {}),
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

export interface TaskReducerOptions {
    readonly reviewLimits?: ReviewLimitSettings;
    readonly reviewFocus?: ReviewFocusSettings;
    /** The fix_required reviews just before this one, newest first; read from the reviews table by reduceTaskInTransaction. */
    readonly fixHistory?: readonly (readonly ReviewSpot[])[];
    /** External blocker reports earlier in the lineage and the progress_guard limit; used only for EXTERNAL_BLOCKER_EVENT. */
    readonly externalBlocker?: { readonly earlierReports: number; readonly limit: number };
    /** total_review_attempts at the Owner's last answer (lineage_reset_json); rows 18b/18c count from there. */
    readonly reviewAttemptsBase?: number;
    readonly refundedBase?: number;
    /** Lineage budget inputs; without them row 18d is skipped. */
    readonly lineage?: {
      readonly otherReviewAttempts: number;
      readonly otherBaseSyncReviewAttempts: number;
      readonly limit: number;
      readonly baseSyncLimit: number;
      readonly generations: number;
      /** Lead-stage rejections over the other Tasks of the chain; without it (or the limit) row 18e is skipped. */
      readonly otherLeadRejections?: number;
      readonly leadRejectionLimit?: number;
    };
}

/** Pure Task state transition reducer implementing every Task row. */
export function reduceTask(
  row: TaskRow,
  command: TaskReducerCommand,
  options: TaskReducerOptions = {},
): ReductionResult<TaskRow> {
  const policy = attemptPolicyConfig(options);
  assertVersion(row.state_version, command.expected_version);
  const payload = objectPayload(command);
  const now = typeof payload.now === "string" ? payload.now : utcNow();
  const event = command.event;

  // Task row 1.
  if (row.status === "waiting" && event === "task.ready") {
    if (row.prerequisite_json != null) {
      reject(row, event, "The Task waits on a prerequisite; only its satisfaction or an Owner resume releases it.");
    }
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
    return decided(taskResult(row, next, ["dependency_failure_cascaded"]), "dependency_failed");
  }

  // Task row 31: a Task failed only because a dependency failed returns to
  // waiting once that dependency is replanned or superseded.
  if (row.status === "failed" && event === "task.dependency_restored") {
    requiredString(payload, "restored_dependency_task_id");
    return decided(taskResult(row, {
      ...withTaskVersion(resetReviewerFailureCounter(resetFailureCounters(row)), "waiting", now),
      paused_from: null,
      failed_by_dependency_task_id: null,
    }), "dependency_restored");
  }

  // Task row 30: the Manager replaced this Task with new Tasks, so it leaves
  // the plan without counting as a Work failure.
  // An Owner-initiated replan may also retire an open Task (stop_open): the
  // Manager chose to cancel or replace it while it waits, runs or is blocked.
  if (
    (row.status === "failed" || row.status === "judgement_waiting" ||
      (payload.stop_open === true && row.status !== "completed" && row.status !== "cancelled")) &&
    event === "task.superseded"
  ) {
    requiredString(payload, "reason");
    return taskResult(row, { ...withTaskVersion(row, "cancelled", now), paused_from: null, failed_by_dependency_task_id: null }, ["task_superseded"]);
  }

  // The Manager of an Owner-initiated replan treats an open Task as done.
  if (event === "task.manager_completed" && row.status !== "completed" && row.status !== "cancelled" && row.status !== "failed") {
    requiredString(payload, "reason");
    return taskResult(row, { ...withTaskVersion(resetReviewerFailureCounter(resetFailureCounters(row)), "completed", now), paused_from: null }, ["dependencies_unlock"]);
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
    const taskBranch = requiredString(payload, "task_branch");
    const workBranch = requiredString(payload, "work_branch");
    return applyAttemptEvaluation(row, event, now, AttemptPolicy.evaluate({ kind: "work_sync_conflict", task: row, taskBranch, workBranch }, policy));
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

  // Task row 32c: a Worker's long process holds the Task in waiting; nothing failed, so no counter moves.
  if (row.status === "running" && event === PROCESS_WAIT_EVENT) {
    validatePrerequisiteSpec(payload.prerequisite);
    return decided(taskResult(row, withTaskVersion(row, "waiting", now), ["report_saved"]), "process_wait");
  }

  // Task rows 32d/32e/32f: a design Task stops without a remake. The Designer reported design_blocked, or the
  // stop-report run (design_stop_json set) ended in any way: the Owner decides, never Manager or ready.
  if (
    row.type === "design" &&
    ((row.status === "running" && (event === "task.design_blocked" || (row.design_stop_json != null && (event === "task.failure.classified" || event === "agent.crashed" || event === "task.rate_limited")))) ||
      ((row.status === "ready" || row.status === "review_fix_waiting") && event === "task.design_blocked" && row.design_stop_json != null))
  ) {
    return applyAttemptEvaluation(row, event, now, AttemptPolicy.evaluate({
      kind: "design_stop",
      task: row,
      stop: parseDesignStop(row.design_stop_json),
      source: event === "task.design_blocked" && payload.source === "designer" ? "designer" : "core",
      report: event === "task.design_blocked" ? readDesignBlocked(payload.design_blocked) : null,
    }, policy));
  }

  // Task row 5: transient retry is independent of deterministic failure counters.
  if (row.status === "running" && event === "task.failure.classified" && payload.failure_class === "transient") {
    const retryNo = requiredNumber(payload, "retry_no");
    const nextAttemptAt = payload.next_attempt_at === null || typeof payload.next_attempt_at === "string"
      ? payload.next_attempt_at ?? null
      : null;
    return applyAttemptEvaluation(row, event, now, AttemptPolicy.evaluate({ kind: "transient_failure", task: row, retryNo, nextAttemptAt }, policy));
  }

  // A provider quota pause is scheduling state, not a Task failure. Keep the
  // retry and deterministic failure counters unchanged and retain its worktree.
  if (row.status === "running" && event === "task.rate_limited") {
    requiredString(payload, "provider");
    return decided(taskResult(row, withTaskVersion({ ...row, next_attempt_at: null }, "ready", now), ["provider_pause_scheduled"]), "rate_limited");
  }

  // Task rows 6-8: deterministic failure classification and Manager/Decision split.
  if (row.status === "running" && event === "task.failure.classified" && payload.failure_class === "deterministic") {
    const errorKey = requiredString(payload, "error_key");
    const retryAllowed = requiredBoolean(payload, "retry_allowed");
    const report = payload.report !== null && typeof payload.report === "object" && !Array.isArray(payload.report) ? payload.report as JsonObject : null;
    return applyAttemptEvaluation(row, event, now, AttemptPolicy.evaluate({
      kind: "deterministic_failure",
      task: row,
      errorKey,
      retryAllowed,
      escalatedFromTransient: payload.escalated_from === "transient",
      partialReport: report?.result === "partial"
        ? {
          pendingProcess: report.pending_process != null,
          externalBlocker: report.external_blocker != null,
          unverifiable: workerAcceptanceDefects(report).length > 0,
          needsReplanning: report.needs_replanning === true,
        }
        : null,
    }, policy));
  }

  // Task row 32: the Worker finished but asked the Manager a question or
  // requested replanning. The Task leaves running first so the Manager
  // replan (task.replanned: failed -> ready) can apply its revision.
  if (row.status === "running" && event === "task.replan_requested") {
    return decided(taskResult(
      row,
      { ...withTaskVersion(row, "failed", now), last_failure_class: "deterministic", next_attempt_at: null },
      ["manager_trigger_required"],
      true,
    ), typeof payload.question === "string" ? "worker_question" : "worker_replan_requested");
  }

  // Task rows 32b / 28b: the Worker or Reviewer found criteria that cannot be
  // proven inside the Task. Failure and review counters stay as they are; the
  // Manager must rewrite the criteria on the same Task.
  if (event === ACCEPTANCE_DEFECT_EVENT) {
    const source = requiredString(payload, "source");
    return applyAttemptEvaluation(row, event, now, AttemptPolicy.evaluate({ kind: "acceptance_defect", task: row, source }, policy));
  }

  // Task row 32d: the Worker reported a problem outside the Task. Failure counters stay; the lineage count and limit decide Manager or Owner.
  if (event === EXTERNAL_BLOCKER_EVENT) {
    return applyAttemptEvaluation(row, event, now, AttemptPolicy.evaluate({ kind: "external_blocker", task: row, earlierReports: options.externalBlocker?.earlierReports ?? 0 }, policy));
  }

  // Task rows 9-10: a crash without a report follows deterministic counters.
  if (row.status === "running" && event === "agent.crashed") {
    if (requiredBoolean(payload, "report_present")) {
      reject(row, event, "agent.crashed must not carry a successful report.");
    }
    const errorKey = requiredString(payload, "error_key");
    return applyAttemptEvaluation(row, event, now, AttemptPolicy.evaluate({ kind: "worker_crash", task: row, errorKey }, policy));
  }

  // A Reviewer whose verdict kept breaking the output format after the output-only resubmissions:
  // the Owner decides (run only the Reviewer again, or cancel); the Worker's work is not redone.
  if (row.status === "verifying" && event === "agent.crashed" && payload.role === "reviewer" && payload.error_key === OUTPUT_FORMAT_INVALID_ERROR_KEY) {
    return decided(taskResult(row, withTaskVersion(row, "judgement_waiting", now), ["core_decision_required"]), "reviewer_output_invalid");
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
    return applyAttemptEvaluation(row, event, now, AttemptPolicy.evaluate({ kind: "reviewer_crash", task: row }, policy));
  }

  // Task rows 11-14: verification pass/fail and independent review counter.
  if (row.status === "verifying" && event === "verification.completed") {
    const outcome = payload.outcome;
    if (outcome === "pass") {
      if (requiredBoolean(payload, "review_required")) {
        return taskResult(row, withTaskVersion(row, "verifying", now), ["reviewer_reserved"]);
      }
      // A Task without review is merged into the Work branch right here.
      if (payload.merge_exit_code !== undefined) return integrationResult(row, payload, now, ["dependencies_unlock"], "verified_without_review", false);
      return decided(taskResult(row, withTaskVersion(resetReviewerFailureCounter(resetFailureCounters(row)), "completed", now), ["dependencies_unlock"]), "verified_without_review");
    }
    if (outcome !== "fail") {
      throw validationError("Verification outcome must be pass or fail.", { field: "outcome" });
    }
    return applyAttemptEvaluation(row, event, now, AttemptPolicy.evaluate({ kind: "verification_failed", task: row }, policy));
  }

  // Task rows 15-16: reviewer pass plus serialized Core Git result.
  if (row.status === "verifying" && event === "review.passed") {
    return integrationResult(row, payload, now, [], "review_passed", true);
  }

  // Task rows 17-18, plus row 28.
  if (row.status === "verifying" && event === "review.failed") {
    if (payload.verdict !== "fix_required" && payload.verdict !== "replan_required") {
      reject(row, event, "review.failed must contain the fix_required or replan_required verdict.");
    }
    return applyAttemptEvaluation(row, event, now, AttemptPolicy.evaluate({
      kind: "review_failed",
      task: row,
      verdict: payload.verdict,
      reviewAttemptsBase: options.reviewAttemptsBase,
      refundedBase: options.refundedBase,
      lineage: lineageObservation(options),
      findings: options.fixHistory === undefined ? undefined : reviewSpots((payload.review as { findings?: unknown } | undefined)?.findings),
      fixHistory: options.fixHistory,
    }, policy));
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
    // Row 20c: a wait_for retry holds the Task in waiting whatever its dependencies.
    const target: TaskState = payload.prerequisite === undefined && requiredBoolean(payload, "dependencies_completed") ? "ready" : "waiting";
    // The replanned Task gets its fix/review budget back. reviews.round is
    // a per-Task sequence (see WorkflowEngine.recordReview), so resetting
    // review_round here cannot collide with the earlier review rows.
    return decided(taskResult(
      row,
      {
        ...withTaskVersion(resetReviewerFailureCounter(resetFailureCounters(row)), target, now),
        review_round: 0,
        lead_designer_start_round: row.type === "design" && row.lead_designer_start_round != null ? 0 : null,
        failed_by_dependency_task_id: null,
        lineage_generation: (row.lineage_generation ?? 1) + 1,
        review_attempts_refunded: AttemptPolicy.refundedAfterReplan(row, options.reviewAttemptsBase, policy.reviewFocus, options.refundedBase),
      },
      ["plan_revision_incremented"],
    ), target === "ready" ? "replanned" : payload.prerequisite !== undefined ? "process_wait" : "dependency_incomplete");
  }

  // Task row 21: Manager-originated inability opens a Core Decision.
  if (row.status === "failed" && event === "decision.opened") {
    if (payload.issuer !== "manager" && payload.issuer !== "core") {
      reject(row, event, "A failed Task Decision must originate from the Manager or Core.");
    }
    return decided(taskResult(row, withTaskVersion(row, "judgement_waiting", now), ["decision_opened"]), payload.issuer === "manager" ? "manager_cannot_continue" : "core_cannot_continue");
  }

  // Task row 36: Core stops a launchable Task that reached the no-progress limit.
  if ((row.status === "ready" || row.status === "review_fix_waiting") && event === "decision.opened") {
    if (payload.issuer !== "core") {
      reject(row, event, "A launchable Task can only be blocked by a Core Decision.");
    }
    return decided(taskResult(row, withTaskVersion(row, "judgement_waiting", now), ["decision_opened"]), "no_progress_limit");
  }

  // Task row 37: Core stops a prerequisite wait that can no longer end by itself.
  if (row.status === "waiting" && row.prerequisite_json != null && event === "decision.opened") {
    if (payload.issuer !== "core") {
      reject(row, event, "A prerequisite wait can only be blocked by a Core Decision.");
    }
    return decided(taskResult(row, withTaskVersion(row, "judgement_waiting", now), ["decision_opened"]), "prerequisite_unreachable");
  }

  // Task rows 38/39: the mark is cleared by reduceTaskInTransaction; the status stays.
  if (
    (event === "task.prerequisite_satisfied" && row.status === "waiting") ||
    (event === "task.prerequisite_resumed" && (row.status === "waiting" || (row.status === "paused" && row.paused_from === "waiting")))
  ) {
    if (row.prerequisite_json == null) {
      reject(row, event, "The Task does not wait on a prerequisite.");
    }
    return taskResult(row, withTaskVersion(row, row.status, now));
  }

  // Decision service entry point for a running Task that must be blocked now.
  if (row.status === "running" && event === "decision.opened") {
    if (!requiredBoolean(payload, "blocks_task")) {
      reject(row, event, "A running Task Decision must explicitly identify the blocked Task.");
    }
    return decided(taskResult(row, withTaskVersion(row, "judgement_waiting", now), ["decision_opened"]), "blocked_by_decision");
  }

  // Task rows 22/22b: only the CAS winner resumes the blocked Task. A
  // Task whose dependency is not completed returns to waiting instead of
  // rejecting the whole answer: an answer to a Decision that also blocks
  // a cascaded Task must not fail and leave the Decision open.
  if (row.status === "judgement_waiting" && event === "decision.resolved") {
    if (!requiredBoolean(payload, "winner_commit")) {
      reject(row, event, "Only the Decision winner can resume a blocked Task.");
    }
    // The Owner's answer goes to the Manager instead of a Worker: the Task
    // returns to failed and the Manager's replan decides what happens to it.
    if (payload.to_manager === true) {
      return decided(taskResult(row, { ...withTaskVersion(resetReviewerFailureCounter(row), "failed", now), failed_by_dependency_task_id: null, design_stop_json: null }, []), "owner_to_manager");
    }
    // "Run only the Reviewer again": back to verifying, where Core launches a Reviewer for the unchanged report.
    if (payload.rerun_review === true) {
      return decided(taskResult(row, { ...withTaskVersion(row, "verifying", now), design_stop_json: null }, []), "owner_rerun_review");
    }
    const target: TaskState = requiredBoolean(payload, "dependencies_completed") && ownerAnsweredRemainder(row.prerequisite_json) === null ? "ready" : "waiting";
    return decided(taskResult(
      row,
      { ...withTaskVersion(resetReviewerFailureCounter(row), target, now), failed_by_dependency_task_id: null, design_stop_json: null },
      ["blocked_task_resumed"],
    ), target === "ready" ? "owner_answer" : "dependency_incomplete");
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
        : pausedFrom === "waiting" && dependenciesCompleted && row.prerequisite_json == null
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

/** manager_task_id prefix of the Tasks Core adds to fix a quarantined test. */
export const QUARANTINE_FIX_TASK_PREFIX = "quarantine-fix:";

function persistTaskRow(transaction: CoreWriteLaneTransaction, row: TaskRow): void {
  const result = transaction.run(
    `UPDATE tasks
       SET status = ?, state_version = ?, failure_count = ?, same_error_count = ?,
           last_error_key = ?, last_error_generation = ?, review_round = ?, lead_designer_start_round = ?, reviewer_failure_count = ?, total_review_attempts = ?, base_sync_review_attempts = ?, lineage_generation = ?,
           worker_generation = ?, worktree_path = ?, worktree_state = ?,
           last_failure_class = ?, paused_from = ?, retry_no = ?, next_attempt_at = ?,
           failed_by_dependency_task_id = ?, lead_review_rejections = ?, design_stop_json = ?, design_escalated = ?, review_attempts_refunded = ?, updated_at = ?
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
    row.total_review_attempts,
    row.base_sync_review_attempts ?? 0,
    row.lineage_generation ?? 1,
    row.worker_generation,
    row.worktree_path ?? null,
    row.worktree_state ?? null,
    row.last_failure_class ?? null,
    row.paused_from ?? null,
    row.retry_no,
    row.next_attempt_at ?? null,
    row.failed_by_dependency_task_id ?? null,
    row.lead_review_rejections ?? 0,
    row.design_stop_json ?? null,
    row.design_escalated ?? 0,
    row.review_attempts_refunded ?? 0,
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

/** Durable per-Task marker that a completed design Task was already handed to the Manager (design_completed). */
export function designCompletedKey(taskId: string): string {
  return `design-completed:${taskId}`;
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
    JSON.stringify({
      task_id: task.id,
      event,
      status: "queued",
      question,
      // A Worker question that does not ask for a replan is not a remake.
      question_only: event === "task.replan_requested" && payload.needs_replanning !== true && question !== null,
    }),
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
  scope: "task" | "work" = blockedTaskIds.length > 0 ? "task" : "work",
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
        state_version, created_at, design_block_json)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, 1, 'core', 0, ?, ?)`,
    id,
    workId,
    scope,
    JSON.stringify(blockedTaskIds),
    brief.reason,
    brief.question,
    brief.tried,
    brief.current_state,
    JSON.stringify(brief.options),
    brief.recommended,
    now,
    brief.design_block ? JSON.stringify(brief.design_block) : null,
  );
  return id;
}

/**
 * Stop remaking: open a Core Decision (scope work) for the Tasks a remake limit
 * blocked and move the Work to judgement_waiting. Failed Tasks go to
 * judgement_waiting here (row 21); a Task the reducer already moved is skipped.
 * No new Task is created. Answering resumes the Tasks and the Work (rows 22, 7).
 */
export function openRemakeLimitDecisionInTransaction(
  transaction: CoreWriteLaneTransaction,
  input: { readonly workId: string; readonly blockedTaskIds: readonly string[]; readonly brief: DecisionBrief; readonly now: string },
): string {
  for (const taskId of input.blockedTaskIds) {
    const task = transaction.get<{ status: string; prerequisite_json: string | null }>("SELECT status, prerequisite_json FROM tasks WHERE id = ?", taskId);
    if (
      task?.status === "failed" || task?.status === "ready" || task?.status === "review_fix_waiting" ||
      (task?.status === "waiting" && task.prerequisite_json !== null)
    ) {
      reduceTaskInTransaction(transaction, taskId, {
        event: "decision.opened",
        payload: { blocks_task: true, issuer: "core", reason: input.brief.reason },
      });
    }
  }
  const decisionId = ensureCoreDecision(transaction, input.workId, input.blockedTaskIds, input.brief, input.now, "work");
  const work = transaction.get<{ state: string }>("SELECT state FROM works WHERE id = ?", input.workId);
  if (work?.state === "running") {
    reduceWorkInTransaction(transaction, input.workId, {
      event: "decision.opened",
      payload: { blocks_work: true, reason: input.brief.reason },
    });
  }
  return decisionId;
}

/**
 * Stop a Task whose no_progress_count reached progress_guard.no_progress_limit:
 * records task.no_progress_limited and opens the Owner Decision (Work goes to
 * judgement_waiting). Returns false, changing nothing, when the Task is under
 * the limit. `gate` names where Core stopped: before a Manager replan or a
 * Worker launch. The limit is read here, so a changed setting applies at once.
 */
export function stopTaskForNoProgressInTransaction(
  transaction: CoreWriteLaneTransaction,
  input: { readonly taskId: string; readonly gate: "manager" | "worker"; readonly now: string },
): boolean {
  const task = transaction.get<{ work_id: string; title: string; status: string; no_progress_count: number }>(
    "SELECT work_id, title, status, no_progress_count FROM tasks WHERE id = ?",
    input.taskId,
  );
  const limit = progressGuard(transaction).no_progress_limit;
  if (!task) return false;
  const gate = AttemptPolicy.evaluate(
    { kind: "no_progress_gate", noProgressCount: task.no_progress_count },
    { ...AttemptPolicy.DEFAULT_ATTEMPT_POLICY_CONFIG, noProgressLimit: limit },
  );
  if (gate.outcome === "continue") return false;
  const recent = transaction
    .all<{ payload_json: string }>(
      `SELECT payload_json FROM events
        WHERE task_id = ? AND type IN ('task.replan_requested', 'task.failure.classified', 'task.failed', 'review.failed', 'task.conflict', '${ACCEPTANCE_DEFECT_EVENT}')
        ORDER BY sequence DESC LIMIT ?`,
      input.taskId,
      limit,
    )
    .map((event) => {
      const payload = JSON.parse(event.payload_json) as JsonObject;
      const detail = payload.question ?? payload.reason ?? payload.error_key;
      return typeof detail === "string" ? detail : JSON.stringify(payload).slice(0, 300);
    });
  const brief = noProgressLimitBrief(
    { taskId: input.taskId, taskTitle: task.title, count: task.no_progress_count, limit, gate: input.gate, recent },
    ownerLanguage(transaction),
  );
  appendEventInTransaction(transaction, {
    type: "task.no_progress_limited",
    idempotencyKey: `task-no-progress-limited:${input.taskId}:${createUlid()}`,
    workId: task.work_id,
    taskId: input.taskId,
    payload: { task_id: input.taskId, count: task.no_progress_count, limit, gate: input.gate, reason: brief.reason, last_question: recent[0] ?? null },
    now: input.now,
  });
  openRemakeLimitDecisionInTransaction(transaction, { workId: task.work_id, blockedTaskIds: [input.taskId], brief, now: input.now });
  return true;
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
/** The wait left after an owner condition is answered; null when it had no owner condition or nothing else remains. */
function ownerAnsweredRemainder(json: string | null | undefined):PrerequisiteSpec | null {
  if (json == null) return null;
  const spec = JSON.parse(json) as PrerequisiteSpec;
  const rest = spec.conditions.filter((condition) => condition.kind !== "owner");
  return rest.length > 0 && rest.length < spec.conditions.length ? { ...spec, conditions: rest } : null;
}

/** Row 20c side effect: store the prerequisite, keep no_progress_count, announce the wait. */
function recordPrerequisiteWait(transaction: CoreWriteLaneTransaction, row: TaskRow, spec: PrerequisiteSpec, now: string): void {
  transaction.run("UPDATE tasks SET prerequisite_json = ?, prerequisite_since = ? WHERE id = ?", JSON.stringify(spec), now, row.id);
  const count = transaction.get<{ no_progress_count: number }>("SELECT no_progress_count FROM tasks WHERE id = ?", row.id)?.no_progress_count ?? 0;
  appendEventInTransaction(transaction, {
    type: "task.prerequisite_wait_started",
    idempotencyKey: `prerequisite-wait-started:${row.id}:${createUlid()}`,
    workId: row.work_id,
    taskId: row.id,
    payload: {
      task_id: row.id,
      reason: spec.reason,
      conditions: spec.conditions as unknown as JsonObject[],
      deadline_at: spec.deadline_at,
      no_progress_count: count,
      limit: progressGuard(transaction).no_progress_limit,
    },
    now,
  });
}

/** Null when the column is missing or broken (the caller then treats the stop as reported by the Designer). */
function parseDesignStop(json: string | null | undefined): AttemptPolicy.DesignStop | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    if (value.trigger !== "lead_review_rejections" && value.trigger !== "designer") return null;
    return {
      trigger: value.trigger,
      rejections: typeof value.rejections === "number" ? value.rejections : null,
      limit: typeof value.limit === "number" ? value.limit : null,
    };
  } catch {
    return null;
  }
}

function latestFindingProblems(findingsJson: string | undefined): string[] {
  try {
    const findings: unknown = JSON.parse(findingsJson ?? "[]");
    return (Array.isArray(findings) ? findings : []).flatMap((finding) => (typeof finding?.problem === "string" ? [finding.problem] : []));
  } catch {
    return [];
  }
}

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
  let lineage: NonNullable<NonNullable<Parameters<typeof reduceTask>[2]>["lineage"]> | undefined;
  if (command.event === "review.failed") {
    const other = lineageReviewAttemptsExcluding(transaction, row.id);
    const limits = remakeLimits(transaction);
    lineage = {
      otherReviewAttempts: other.main,
      otherBaseSyncReviewAttempts: other.base_sync,
      limit: limits.lineage_review_attempts,
      baseSyncLimit: limits.base_sync_lineage_review_attempts,
      generations: lineageGenerationCount(transaction, row.id),
      otherLeadRejections: other.lead,
      leadRejectionLimit: limits.lead_review_rejections,
    };
  }
  const reset = parseLineageReset(transaction.get<{ lineage_reset_json: string | null }>("SELECT lineage_reset_json FROM tasks WHERE id = ?", row.id)?.lineage_reset_json);
  const externalBlocker = command.event === EXTERNAL_BLOCKER_EVENT
    ? { earlierReports: lineageExternalBlockerReports(transaction, row.id, typeof objectPayload(command).agent_run_id === "string" ? String(objectPayload(command).agent_run_id) : null), limit: progressGuard(transaction).external_blocker_limit }
    : undefined;
  const reviewFocus = reviewFocusSettings(transaction);
  const fixHistory = command.event === "review.failed" && objectPayload(command).verdict === "fix_required"
    ? previousFixSpots(transaction, row.id, reviewFocus.same_spot_threshold - 1)
    : undefined;
  let result = reduceTask(row, command, { reviewLimits: reviewLimits(transaction), reviewFocus, fixHistory, lineage, externalBlocker, reviewAttemptsBase: reset?.review_attempts, refundedBase: reset?.review_attempts_refunded });
  if (row.manager_task_id?.startsWith(QUARANTINE_FIX_TASK_PREFIX) && result.side_effects.includes("core_decision_required")) {
    // A quarantine fix Task that cannot be fixed ends failed: no Decision, and the Work goes on.
    result = { ...taskResult(row, { ...result.next, status: "failed" }), changed: true };
  }
  if (result.changed) {
    persistTaskRow(transaction, result.next);
  }
  if (result.changed && result.decision !== undefined) {
    const decisionPayload = objectPayload(command);
    appendEventInTransaction(transaction, {
      type: "task.attempt_decided",
      idempotencyKey: `attempt-decided:${row.id}:${createUlid()}`,
      workId: row.work_id,
      taskId: row.id,
      outbox: false,
      now: result.next.updated_at,
      payload: {
        schema_version: "1.0.0",
        task_id: row.id,
        event: command.event,
        ...result.decision,
        side_effects: [...result.side_effects],
        manager_trigger: result.manager_trigger,
        ...(typeof decisionPayload.agent_run_id === "string" ? { agent_run_id: decisionPayload.agent_run_id } : {}),
        ...(typeof decisionPayload.error_key === "string" ? { error_key: decisionPayload.error_key } : {}),
        ...(typeof decisionPayload.next_attempt_at === "string" ? { next_attempt_at: decisionPayload.next_attempt_at } : {}),
        attempts: {
          review: result.next.total_review_attempts - (reset?.review_attempts ?? 0),
          reviewer_failures: result.next.reviewer_failure_count,
          failures: result.next.failure_count,
          same_error: result.next.same_error_count,
          retry_no: result.next.retry_no,
        },
        ...(result.review_same_spot ? { same_spot_findings: result.review_same_spot } : {}),
        ...(result.review_budget ? { budget: { review_budget: result.review_budget } } : result.lineage_budget ? { budget: { lineage_budget: result.lineage_budget } } : result.design_block ? { budget: { design_block: { trigger: result.design_block.trigger, rejections: result.design_block.rejections, limit: result.design_block.limit } } } : {}),
      },
    });
  }
  if (
    result.changed &&
    (command.event === "task.manager_completed" || (command.event === "task.superseded" && objectPayload(command).stop_open === true))
  ) {
    // The Task left the plan while an Agent may still work on it: close runs
    // that never started and mark the others cancel_requested; Core signals
    // them by id after the commit.
    transaction.run(
      `UPDATE agent_runs
          SET status = CASE WHEN status = 'launch_pending' AND pid IS NULL AND role <> 'executor' THEN 'cancelled' ELSE 'cancel_requested' END,
              ended_at = CASE WHEN status = 'launch_pending' AND pid IS NULL AND role <> 'executor' THEN COALESCE(ended_at, ?) ELSE ended_at END,
              updated_at = ?
        WHERE task_id = ? AND status IN ('launch_pending', 'spawned', 'running')`,
      result.next.updated_at,
      result.next.updated_at,
      row.id,
    );
  }
  if (row.status !== "cancelled" && result.next.status === "cancelled") {
    const childRunsTable = transaction.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'child_runs'");
    if (childRunsTable) {
      transaction.run(
        `UPDATE child_runs
            SET status = 'cancelled', blocked_reason = NULL, failure_kind = 'cancelled',
                failure_reason = 'Task was cancelled.', finished_at = ?, updated_at = ?
          WHERE task_id = ? AND status IN ('queued','running')`,
        result.next.updated_at,
        result.next.updated_at,
        taskId,
      );
    }
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
      base_sync_only: row.base_sync_only ?? 0,
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
      command.event === ACCEPTANCE_DEFECT_EVENT ||
      command.event === EXTERNAL_BLOCKER_EVENT ||
      command.event === "task.rate_limited" ||
      command.event === "task.design_blocked" ||
      command.event === PROCESS_WAIT_EVENT)
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
    } else if (command.event === "task.design_blocked") {
      status = "completed";
      outcome = runOutcome ?? "not_achieved";
    } else if (command.event === "task.replan_requested") {
      status = "completed";
      outcome = runOutcome ?? "replan";
    } else if (command.event === ACCEPTANCE_DEFECT_EVENT) {
      status = "completed";
      // A Reviewer run has no report here and ends like a replan_required review.
      outcome = payload.source === "reviewer" ? "replan" : "question";
    } else if (command.event === PROCESS_WAIT_EVENT || command.event === EXTERNAL_BLOCKER_EVENT) {
      status = "completed";
      outcome = "partial";
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
  if (
    (command.event === "task.replanned" || command.event === PROCESS_WAIT_EVENT) &&
    result.next.status === "waiting" &&
    payload.prerequisite !== undefined
  ) {
    recordPrerequisiteWait(transaction, row, validatePrerequisiteSpec(payload.prerequisite), result.next.updated_at);
  } else if (
    (command.event === "decision.resolved" && row.status === "judgement_waiting") ||
    command.event === "task.prerequisite_satisfied" ||
    command.event === "task.prerequisite_resumed"
  ) {
    // An answer settles only the owner condition; other unmet conditions keep waiting.
    const remainder = command.event === "decision.resolved" ? ownerAnsweredRemainder(row.prerequisite_json) : null;
    if (result.accepted && remainder !== null) transaction.run("UPDATE tasks SET prerequisite_json = ? WHERE id = ?", JSON.stringify(remainder), row.id);
    else if (result.accepted) transaction.run("UPDATE tasks SET prerequisite_json = NULL, prerequisite_since = NULL WHERE id = ?", row.id);
  }
  if (command.event === "task.prerequisite_resumed" && result.accepted) {
    transaction.run("UPDATE tasks SET no_progress_count = 0 WHERE id = ?", row.id);
  }
  if (result.manager_trigger) {
    ensureManagerTrigger(transaction, row, command.event, payload, result.next.updated_at);
    // A fresh failure that needs a Manager replan is one more result that
    // did not move the Task forward. A criteria defect is the exception: the
    // Task cannot move until the Manager rewrites its criteria.
    if (command.event !== ACCEPTANCE_DEFECT_EVENT && command.event !== EXTERNAL_BLOCKER_EVENT) transaction.run("UPDATE tasks SET no_progress_count = no_progress_count + 1 WHERE id = ?", row.id);
  } else if (
    (row.status !== "completed" && result.next.status === "completed") ||
    (command.event === "decision.resolved" && row.status === "judgement_waiting" && result.next.status !== "judgement_waiting")
  ) {
    // Success, or the Owner answering the Decision, starts the count over.
    transaction.run("UPDATE tasks SET no_progress_count = 0 WHERE id = ?", row.id);
  }
  if (command.event === "decision.resolved" && row.status === "judgement_waiting" && result.accepted && result.next.status !== "judgement_waiting") {
    // The Owner's answer also starts the lineage budget over.
    restartLineageBudgetInTransaction(transaction, row.id, result.next.updated_at);
  }
  if (row.status !== "failed" && result.next.status === "failed") {
    // Central cascade hook: whichever path fails a Task, its waiting
    // dependents fail in the same transaction instead of stalling forever.
    cascadeDependencyFailureInTransaction(transaction, row.work_id, row.id, result.next.updated_at);
  }
  if (result.accepted && result.next.status !== row.status) recheckWorkBlockedByTaskDecisionInTransaction(transaction, row.work_id);
  if (result.side_effects.includes("core_decision_required")) {
    const language = ownerLanguage(transaction);
    if (result.design_block) {
      const latest = transaction.get<{ findings_json: string }>("SELECT findings_json FROM reviews WHERE task_id = ? ORDER BY round DESC LIMIT 1", row.id);
      const brief = designBlockedBrief(
        { taskTitle: row.title, ...result.design_block, latestFindings: latestFindingProblems(latest?.findings_json) },
        language,
      );
      openRemakeLimitDecisionInTransaction(transaction, { workId: row.work_id, blockedTaskIds: [row.id], brief, now: result.next.updated_at });
      return result;
    }
    if (result.lineage_budget) {
      const settings = remakeLimits(transaction);
      const usage = lineageUsage(transaction, row.id, settings);
      const brief = remakeLimitBrief({ taskTitle: row.title, reason: result.lineage_budget.reason, usage, settings }, language);
      openRemakeLimitDecisionInTransaction(transaction, { workId: row.work_id, blockedTaskIds: [row.id], brief, now: result.next.updated_at });
      return result;
    }
    const brief = result.review_budget
      ? coreTaskDecisionBrief(row.title, { error_key: "review_budget_exhausted", reason: reviewBudgetReason(result.review_budget, language) }, language)
      : coreTaskDecisionBrief(row.title, payload, language);
    ensureCoreDecision(transaction, row.work_id, [row.id], brief, result.next.updated_at);
    blockWorkWhenNoTaskCanMoveInTransaction(transaction, row.work_id, brief.reason);
  }
  return result;
}

/**
 * Work row 6 for a Task-scope Decision: once no Task in the Work can move
 * (every one is done, waiting on the Decision or on a dependency), the Work
 * itself waits for judgement. A waiting Task with a prerequisite and a Task
 * failed on its own (Manager replan pending) still count as able to move.
 */
function workHasMovableTaskInTransaction(transaction: CoreWriteLaneTransaction, workId: string): boolean {
  const movable = transaction.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM tasks
      WHERE work_id = ? AND (
        status IN ('ready', 'running', 'verifying', 'review_fix_waiting', 'paused')
        OR (status = 'waiting' AND prerequisite_json IS NOT NULL)
        OR (status = 'failed' AND failed_by_dependency_task_id IS NULL))`,
    workId,
  );
  return Number(movable?.count ?? 0) > 0;
}

function blockWorkWhenNoTaskCanMoveInTransaction(transaction: CoreWriteLaneTransaction, workId: string, reason: string): void {
  const work = transaction.get<{ state: string }>("SELECT state FROM works WHERE id = ?", workId);
  if (work?.state !== "running" || workHasMovableTaskInTransaction(transaction, workId)) return;
  reduceWorkInTransaction(transaction, workId, { event: "decision.opened", payload: { blocks_work: true, reason } });
  appendWorkStateEvent(transaction, workId, "work.judgement_waiting_by_task_decision", { from: "running", to: "judgement_waiting", reason });
}

function appendWorkStateEvent(transaction: CoreWriteLaneTransaction, workId: string, type: string, payload: JsonObject): void {
  appendEventInTransaction(transaction, { type, idempotencyKey: `${type}:${workId}:${createUlid()}`, workId, taskId: null, payload });
}

/** A Decision opened while another Task could still move leaves the Work running; re-check once a Task stops being movable. */
function recheckWorkBlockedByTaskDecisionInTransaction(transaction: CoreWriteLaneTransaction, workId: string): void {
  const open = transaction.get<{ id: string }>("SELECT id FROM decisions WHERE work_id = ? AND status = 'open' AND scope = 'task' LIMIT 1", workId);
  if (open) blockWorkWhenNoTaskCanMoveInTransaction(transaction, workId, `task decision ${open.id} is open and no Task can move`);
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
    /** false: the event is not delivered to websocket. */
    readonly outbox?: false;
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
  if (event.outbox === false) return eventId;
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
        fencing_token, base_sync_only, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'launch_pending', ?, ?, ?, ?)`,
    id,
    input.work_id,
    input.task_id,
    input.role ?? "worker",
    input.provider ?? "unknown",
    input.model ?? "unknown",
    input.effort ?? null,
    input.design_tier ?? null,
    input.invocation_id ?? id,
    input.base_sync_only ?? 0,
    now,
    now,
  );
  return id;
}

/**
 * Smallest positive number unused by the group's Works (archived ones included). Derived from the rows
 * inside the write transaction instead of a counter, so freed numbers are reused with nothing to keep in sync.
 */
function smallestFreeDisplayNumber(transaction: CoreWriteLaneTransaction, projectId: string | null): number {
  const used = projectId === null
    ? transaction.all<{ display_number: number }>(
      "SELECT display_number FROM works WHERE project_id IS NULL AND display_number IS NOT NULL ORDER BY display_number",
    )
    : transaction.all<{ display_number: number }>(
      "SELECT display_number FROM works WHERE project_id = ? AND display_number IS NOT NULL ORDER BY display_number",
      projectId,
    );
  let candidate = 1;
  for (const { display_number } of used) {
    if (display_number > candidate) break;
    if (display_number === candidate) candidate++;
  }
  return candidate;
}

/** Move a Project's Works into the Project-less display-number group without violating its unique index. */
export function detachProjectWorksInTransaction(
  transaction: CoreWriteLaneTransaction,
  projectId: string,
  now: string,
): DetachedWork[] {
  const rows = transaction.all<{ id: string; display_number: number | null }>(
    `SELECT id, display_number FROM works WHERE project_id = ?
      ORDER BY display_number IS NULL, display_number, created_at, id`,
    projectId,
  );
  const detached: DetachedWork[] = [];
  for (const row of rows) {
    const displayNumber = row.display_number === null ? null : smallestFreeDisplayNumber(transaction, null);
    if (displayNumber === null) {
      transaction.run("UPDATE works SET project_id = NULL, updated_at = ? WHERE id = ?", now, row.id);
    } else {
      transaction.run("UPDATE works SET project_id = NULL, display_number = ?, updated_at = ? WHERE id = ?", displayNumber, now, row.id);
    }
    detached.push({ work_id: row.id, previous_display_number: row.display_number, display_number: displayNumber });
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
    display_number: smallestFreeDisplayNumber(transaction, payload.project_id),
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

/** tasks.verification_spec_json for a plan item: null when it names no section or test. */
function verificationSpecFor(item: Pick<TaskPlanItem, "required_sections" | "required_tests">): string | null {
  const names = (list: readonly string[] | undefined): string[] =>
    Array.isArray(list) ? list.filter((entry) => typeof entry === "string" && entry.length > 0) : [];
  const required_sections = names(item.required_sections);
  const required_tests = names(item.required_tests);
  return required_sections.length === 0 && required_tests.length === 0 ? null : JSON.stringify({ required_sections, required_tests });
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
      verification_spec_json: verificationSpecFor(item),
      review_decision: null,
      review_decision_json: null,
      priority: item.priority ?? "normal",
      context: item.context ?? "",
      acceptance: item.acceptance,
      acceptance_criteria_json: item.acceptance_criteria === undefined ? null : JSON.stringify(item.acceptance_criteria),
      plan_context_json: item.plan_context === undefined ? null : JSON.stringify(item.plan_context),
      state_version: 0,
      failure_count: 0,
      same_error_count: 0,
      last_error_key: null,
      last_error_generation: null,
      review_round: 0,
      lead_designer_start_round: item.type === "design" && work.design_mode === "lead" ? 0 : null,
      reviewer_failure_count: 0,
      total_review_attempts: 0,
      base_sync_only: item.base_sync_only === true ? 1 : 0,
      base_sync_generations: item.base_sync_only === true ? 1 : 0,
      base_sync_review_attempts: 0,
      lineage_root_task_id: null,
      lineage_generation: 1,
      replaces_task_ids_json: "[]",
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
          acceptance, acceptance_criteria_json, plan_context_json, state_version, failure_count, same_error_count, last_error_key,
          last_error_generation, review_round, lead_designer_start_round, worker_generation, worktree_path,
          worktree_state, last_failure_class, paused_from, created_at, updated_at,
          manager_task_id, retry_no, next_attempt_at, verification_spec_json, base_sync_only, base_sync_generations)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.acceptance_criteria_json ?? null,
      row.plan_context_json ?? null,
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
      row.verification_spec_json,
      row.base_sync_only ?? 0,
      row.base_sync_generations ?? 0,
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
  /** An Owner-initiated replan: it may also run while the Work waits for a Decision and may stop open Tasks. */
  readonly owner_replan?: boolean;
}

export interface ReplanApplyResult {
  readonly registered: readonly TaskRow[];
  readonly reopened: readonly string[];
  /** Replaced root Task id -> the ids of the new Tasks replacing it. */
  readonly replacements: Readonly<Record<string, readonly string[]>>;
  /** Decisions closed because their only blocked Task was superseded by this replan. */
  readonly cancelled_decision_ids: readonly string[];
  /** Tasks the replan cancelled, replaced or completed that may still have an Agent running. */
  readonly stopped_task_ids: readonly string[];
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
  /** Resolved wait_for of each retried Task (Core resolves targets and base_head before the write). */
  prerequisites: ReadonlyMap<string, PrerequisiteSpec> = new Map(),
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
  if (work.state !== "running" && !(guard.owner_replan === true && work.state === "judgement_waiting")) {
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
  const rootIds = [...new Set([...plan.reopenIds, ...plan.supersessions.keys(), ...(plan.actions ?? new Map()).keys()])];
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

  // Lineage: a Task created from `replaces` descends from the Tasks it replaced.
  if (plan.supersessions.size > 0) {
    const predecessors = new Map<string, string[]>();
    for (const [replacedId, localIds] of plan.supersessions) {
      for (const localId of localIds) {
        const newId = registeredId(localId);
        predecessors.set(newId, [...(predecessors.get(newId) ?? []), replacedId]);
      }
    }
    assignReplacementLineageInTransaction(transaction, workId, predecessors, guard.owner_replan === true);
  }

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
  const stoppedTaskIds: string[] = [];
  for (const [taskId, localIds] of plan.supersessions) {
    const replacementIds = localIds.map(registeredId);
    const superseded = reduceTaskInTransaction(transaction, taskId, { event: "task.superseded", payload: { reason, stop_open: guard.owner_replan === true } });
    if (superseded.cancelled_decision_ids) cancelledDecisionIds.push(...superseded.cancelled_decision_ids);
    transaction.run("UPDATE tasks SET superseded_at = ? WHERE id = ? AND status = 'cancelled'", now, taskId);
    stoppedTaskIds.push(taskId);
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
  const cancelledIds = [...(plan.actions ?? new Map()).values()].filter((action) => action.action === "cancel").map((action) => action.task_id);
  if (plan.supersessions.size > 0 || cancelledIds.length > 0) {
    appendEventInTransaction(transaction, {
      type: "task.superseded",
      idempotencyKey: `tasks-superseded:${workId}:${guard.base_plan_revision}`,
      workId,
      taskId: null,
      payload: {
        work_id: workId,
        task_ids: [...Object.keys(replacements), ...cancelledIds],
        replacement_task_ids: [...new Set(Object.values(replacements).flat())],
        replacements,
        reason,
        owner_replan: guard.owner_replan === true,
      },
      now,
    });
  }

  // The Manager cancels open Tasks or treats them as done. Dependents of a
  // completed Task are promoted by the next tick; the validated plan leaves
  // no staying Task waiting on a cancelled one.
  for (const action of (plan.actions ?? new Map()).values()) {
    const stopped = action.action === "cancel"
      ? reduceTaskInTransaction(transaction, action.task_id, { event: "task.superseded", payload: { reason: action.reason, stop_open: true } })
      : reduceTaskInTransaction(transaction, action.task_id, { event: "task.manager_completed", payload: { reason: action.reason } });
    if (stopped.cancelled_decision_ids) cancelledDecisionIds.push(...stopped.cancelled_decision_ids);
    if (action.action === "cancel") transaction.run("UPDATE tasks SET superseded_at = ? WHERE id = ? AND status = 'cancelled'", now, action.task_id);
    stoppedTaskIds.push(action.task_id);
  }

  // Rows 20/20b: retry, with the Manager's revised instructions.
  for (const taskId of plan.reopenIds) {
    reduceTaskInTransaction(transaction, taskId, {
      event: "task.replanned",
      payload: {
        base_plan_version: guard.base_plan_revision,
        current_plan_version: work.plan_revision,
        dependencies_completed: taskDependenciesCompletedInTransaction(transaction, taskId),
        ...(prerequisites.has(taskId) ? { prerequisite: prerequisites.get(taskId) as unknown as JsonObject } : {}),
      },
    });
    const revision = plan.revisions.get(taskId);
    if (revision) {
      transaction.run(
        "UPDATE tasks SET title = ?, acceptance = ?, acceptance_criteria_json = ?, context = COALESCE(?, context), plan_context_json = COALESCE(?, plan_context_json), type = ?, review_override = ?, verification_spec_json = CASE WHEN ? THEN ? ELSE verification_spec_json END, updated_at = ? WHERE id = ?",
        revision.title,
        revision.acceptance,
        revision.acceptance_criteria === undefined ? null : JSON.stringify(revision.acceptance_criteria),
        revision.context ?? null,
        revision.plan_context === undefined ? null : JSON.stringify(revision.plan_context),
        revision.type,
        reviewOverrideFor(revision.review),
        // The Manager restates the spec on a retry: [] clears it, absent keeps it.
        revision.required_sections !== undefined || revision.required_tests !== undefined ? 1 : 0,
        verificationSpecFor(revision),
        now,
        taskId,
      );
    }
    // The mark belongs to this generation only: restated on every retry, never carried over.
    const baseSyncMark = revision?.base_sync_only === true ? 1 : 0;
    transaction.run("UPDATE tasks SET base_sync_only = ?, base_sync_generations = base_sync_generations + ? WHERE id = ?", baseSyncMark, baseSyncMark, taskId);
  }

  restoreCascadedDependentsInTransaction(transaction, workId);
  transaction.run("UPDATE works SET plan_revision = plan_revision + 1, updated_at = ? WHERE id = ?", now, workId);
  assertTaskDependencyGraph(transaction, workId, "The replan creates a dependency cycle.");
  if (work.state === "judgement_waiting") cancelledDecisionIds.push(...resumeWorkAfterOwnerReplanInTransaction(transaction, workId, now));
  return { registered, reopened: [...plan.reopenIds], replacements, cancelled_decision_ids: cancelledDecisionIds, stopped_task_ids: stoppedTaskIds };
}

/**
 * An Owner-initiated replan ran while the Work waited for a Decision. Close
 * the open Decisions whose blocked Tasks are all finished now (the replan
 * cancelled, replaced or completed them), and let the Work run again when
 * no Decision is left. Returns the closed Decision ids.
 */
function resumeWorkAfterOwnerReplanInTransaction(transaction: CoreWriteLaneTransaction, workId: string, now: string): string[] {
  const closed: string[] = [];
  const open = transaction.all<{ id: string; blocked_task_ids_json: string }>(
    "SELECT id, blocked_task_ids_json FROM decisions WHERE work_id = ? AND status = 'open'",
    workId,
  );
  for (const decision of open) {
    const blocked = JSON.parse(decision.blocked_task_ids_json) as string[];
    if (blocked.length === 0) continue;
    const unfinished = blocked.some((taskId) => {
      const status = transaction.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", taskId)?.status;
      return status !== undefined && status !== "completed" && status !== "cancelled";
    });
    if (unfinished) continue;
    transaction.run(
      "UPDATE decisions SET status = 'cancelled', resolved_at = ?, state_version = state_version + 1 WHERE id = ?",
      now,
      decision.id,
    );
    closed.push(decision.id);
  }
  const stillOpen = transaction.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM decisions WHERE work_id = ? AND status = 'open' AND scope = 'work'",
    workId,
  );
  if (closed.length > 0 && Number(stillOpen?.count ?? 0) === 0) {
    reduceWorkInTransaction(transaction, workId, { event: "decision.resolved", payload: { winner_commit: true } });
  }
  return closed;
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
    blockWorkWhenNoTaskCanMoveInTransaction(transaction, input.work_id, input.reason);
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
  /** Hand the blocked Tasks to the Manager's replan instead of resuming their Workers. */
  readonly to_manager?: boolean;
  readonly rerun_review?: boolean;
  /** The answer is the Owner's instruction attached to the chosen option, so it need not equal the option label. */
  readonly option_note?: boolean;
  /** The Owner's instruction to a waiting Work answers the Decision, so a free-text answer is accepted even where the Decision offers only options. */
  readonly by_instruction?: boolean;
}

export interface ResolveDecisionResult {
  readonly decision: DecisionRow;
  readonly resumed_task_ids: readonly string[];
}

export function resolveDecisionInTransaction(
  transaction: CoreWriteLaneTransaction,
  input: ResolveDecisionInput,
): ResolveDecisionResult {
  const maxAnswerLength = input.by_instruction === true ? 100000 : 10000;
  if (input.answer.length < 1 || input.answer.length > maxAnswerLength) {
    throw validationError(`Decision answer must contain between 1 and ${maxAnswerLength.toLocaleString("en-US")} characters.`, { field: "answer" });
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
  if (input.option_key === null && decision.allow_free_text !== 1 && input.by_instruction !== true) {
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
    if (input.option_note !== true && typeof selected.label === "string" && input.answer !== selected.label) {
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
        payload: { winner_commit: true, dependencies_completed: dependenciesCompleted, ...(input.to_manager === true ? { to_manager: true } : {}), ...(input.rerun_review === true ? { rerun_review: true } : {}) },
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
    // The Work waits until its last open work-scope Decision is answered, as cancelWorkDecisions does.
    const stillOpen = transaction.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM decisions WHERE work_id = ? AND status = 'open' AND scope = 'work'",
      decision.work_id,
    );
    if (work.state === "judgement_waiting" && Number(stillOpen?.count ?? 0) === 0) {
      reduceWorkInTransaction(transaction, decision.work_id, {
        event: "decision.resolved",
        payload: { winner_commit: true },
      });
    }
  }
  if (decision.scope === "task" && !cancelAnswer && resumedTaskIds.length > 0) {
    // The Work waited only because no Task could move; back to running once one can.
    const work = transaction.get<WorkRow>("SELECT * FROM works WHERE id = ?", decision.work_id);
    const workDecisions = transaction.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM decisions WHERE work_id = ? AND status = 'open' AND scope = 'work'",
      decision.work_id,
    );
    if (work?.state === "judgement_waiting" && Number(workDecisions?.count ?? 0) === 0 && workHasMovableTaskInTransaction(transaction, decision.work_id)) {
      reduceWorkInTransaction(transaction, decision.work_id, { event: "decision.resolved", payload: { winner_commit: true } });
      appendWorkStateEvent(transaction, decision.work_id, "work.running_by_task_decision", { from: "judgement_waiting", to: "running", decision_id: decision.id });
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
