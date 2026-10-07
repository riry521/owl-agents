import { createHash } from "node:crypto";
import { ACCEPTANCE_DEFECT_EVENT } from "../../shared/dist/acceptance-defect.js";
import { EXTERNAL_BLOCKER_EVENT } from "../../shared/dist/external-blocker.js";
import type { DesignBlockedReport } from "../../shared/dist/design-blocked.js";
import { DEFAULT_PROGRESS_GUARD_SETTINGS } from "../../shared/dist/progress-guard-settings.js";
import { DEFAULT_REVIEW_LIMIT_SETTINGS, type ReviewLimitSettings } from "../../shared/dist/review-limit-settings.js";
import type { ReductionResult, TaskRow, TaskState } from "./types";

/** agent-runtime が provider 失敗に付ける error_key の接頭辞（provider-error.ts, runner.ts の "provider_failed:"）。Core 側で参照する唯一の場所 */
export const PROVIDER_FAILED_ERROR_PREFIX = "provider_failed:";
/** transient 再試行の遅延と上限。上限は遅延表の長さと同じ 1 か所で決める */
export const TRANSIENT_RETRY_DELAYS_MS = [30_000, 120_000, 300_000] as const;
export const TRANSIENT_RETRY_LIMIT = TRANSIENT_RETRY_DELAYS_MS.length;

/** 判断の種類。Task の次の扱いで分ける（state の別名ではない）。 */
export type AttemptAction = "retry" | "fix" | "review" | "replan" | "wait" | "owner_decision" | "fail" | "complete";

/** 判断の理由。閉じた集合。 */
export type AttemptReason =
  | "transient_failure" | "transient_budget_exhausted" | "rate_limited"
  | "deterministic_failure" | "deterministic_threshold" | "retry_not_allowed"
  | "crash" | "crash_threshold" | "reviewer_crash" | "reviewer_crash_threshold" | "reviewer_output_invalid"
  | "verification_failed" | "verification_exhausted"
  | "review_fix_required" | "review_replan_required" | "review_budget_reached" | "review_budget_exceeded"
  | "lineage_budget_exhausted" | "base_sync_lineage_budget_exhausted"
  | "design_escalated_to_lead" | "lead_rejections_exhausted" | "design_blocked"
  | "worker_replan_requested" | "worker_question" | "acceptance_defect"
  | "external_blocker" | "external_blocker_limit"
  | "integration_conflict" | "integration_commit_failed" | "work_sync_conflict"
  | "process_wait" | "dependency_failed" | "dependency_restored" | "dependency_incomplete"
  | "replanned" | "owner_answer" | "owner_to_manager" | "owner_rerun_review"
  | "no_progress_limit" | "prerequisite_unreachable" | "manager_cannot_continue" | "core_cannot_continue" | "blocked_by_decision"
  | "verified_without_review" | "review_passed";

export interface AttemptDecision {
  readonly action: AttemptAction;
  readonly reason: AttemptReason;
  readonly from: TaskState;
  readonly to: TaskState;
}

/**
 * 遷移結果と reason から action を導く。判断ではない遷移（verifying / running / paused / cancelled への遷移）は null。
 * owner_rerun_review は review、owner_to_manager は replan に固定する（後者は manager_trigger が false のまま failed になる）。
 */
export function attemptAction(next: TaskState, managerTrigger: boolean, reason: AttemptReason): AttemptAction | null {
  if (reason === "owner_rerun_review") return "review";
  if (reason === "owner_to_manager") return "replan";
  switch (next) {
    case "ready": return "retry";
    case "review_fix_waiting": return "fix";
    case "failed": return managerTrigger ? "replan" : "fail";
    case "waiting": return "wait";
    case "judgement_waiting": return "owner_decision";
    case "completed": return "complete";
    default: return null;
  }
}

/** rows 6-10: 同じ error_key の失敗がこの回数に達したら再試行しない。 */
export const DETERMINISTIC_SAME_ERROR_LIMIT = 2;
/** rows 6-10: 失敗の合計がこの回数に達したら再試行しない。 */
export const DETERMINISTIC_FAILURE_LIMIT = 3;
/** row 29: Reviewer 自身の失敗がこの回数に達したら Manager へ。 */
export const REVIEWER_FAILURE_LIMIT = 3;

/** evaluate が読む Task の値。TaskRow をそのまま渡せる。 */
export type AttemptTaskSnapshot = Readonly<Pick<TaskRow,
  | "status" | "type" | "worker_generation"
  | "failure_count" | "same_error_count" | "last_error_key" | "last_error_generation"
  | "reviewer_failure_count" | "review_round" | "lead_designer_start_round" | "design_escalated"
  | "total_review_attempts" | "base_sync_only" | "base_sync_review_attempts" | "lead_review_rejections"
  | "design_stop_json"
>>;

/** row 18d / 18e: 同じ系譜の他の Task の回数。 */
export interface AttemptLineageObservation {
  readonly otherReviewAttempts: number;
  readonly otherBaseSyncReviewAttempts: number;
  readonly generations: number;
  readonly otherLeadRejections?: number;
}

/** row 18d / 18e のしきい値（remake_limits）。 */
export interface AttemptLineageLimits {
  readonly reviewAttempts: number;
  readonly baseSyncReviewAttempts: number;
  /** undefined なら row 18e を飛ばす。 */
  readonly leadReviewRejections?: number;
}

export interface AttemptPolicyConfig {
  readonly transientRetryLimit: number;
  readonly deterministicSameErrorLimit: number;
  readonly deterministicFailureLimit: number;
  readonly reviewerFailureLimit: number;
  readonly reviewLimits: ReviewLimitSettings;
  /** null なら row 18d と 18e を飛ばす。 */
  readonly lineageLimits: AttemptLineageLimits | null;
  readonly noProgressLimit: number;
  readonly externalBlockerLimit: number;
}

export const DEFAULT_ATTEMPT_POLICY_CONFIG: AttemptPolicyConfig = {
  transientRetryLimit: TRANSIENT_RETRY_LIMIT,
  deterministicSameErrorLimit: DETERMINISTIC_SAME_ERROR_LIMIT,
  deterministicFailureLimit: DETERMINISTIC_FAILURE_LIMIT,
  reviewerFailureLimit: REVIEWER_FAILURE_LIMIT,
  reviewLimits: DEFAULT_REVIEW_LIMIT_SETTINGS,
  lineageLimits: null,
  noProgressLimit: DEFAULT_PROGRESS_GUARD_SETTINGS.no_progress_limit,
  externalBlockerLimit: DEFAULT_PROGRESS_GUARD_SETTINGS.external_blocker_limit,
};

/** design_stop_json の中身（at を除く）。 */
export interface DesignStop {
  readonly trigger: "lead_review_rejections" | "designer";
  readonly rejections: number | null;
  readonly limit: number | null;
}

/** rows 15/16 と row 11（merge あり）: Core Git の統合結果。 */
export type IntegrationMerge =
  | { readonly outcome: "merged"; readonly worktreeRetained: boolean }
  | { readonly outcome: "commit_failure" | "conflict"; readonly taskBranch: string; readonly workBranch: string };

export type AttemptTaskObservation =
  | { readonly kind: "transient_failure"; readonly task: AttemptTaskSnapshot; readonly retryNo: number; readonly nextAttemptAt: string | null }
  | { readonly kind: "deterministic_failure"; readonly task: AttemptTaskSnapshot; readonly errorKey: string; readonly retryAllowed: boolean; readonly escalatedFromTransient: boolean }
  | { readonly kind: "worker_crash"; readonly task: AttemptTaskSnapshot; readonly errorKey: string }
  | { readonly kind: "reviewer_crash"; readonly task: AttemptTaskSnapshot }
  | { readonly kind: "verification_failed"; readonly task: AttemptTaskSnapshot }
  | {
      readonly kind: "review_failed";
      readonly task: AttemptTaskSnapshot;
      readonly verdict: "fix_required" | "replan_required";
      /** lineage_reset_json.review_attempts（Owner の最後の回答時点の total_review_attempts）。 */
      readonly reviewAttemptsBase: number | undefined;
      readonly lineage: AttemptLineageObservation | null;
    }
  | {
      readonly kind: "design_stop";
      readonly task: AttemptTaskSnapshot;
      readonly stop: DesignStop | null;
      readonly source: "designer" | "core";
      readonly report: DesignBlockedReport | null;
    }
  | {
      readonly kind: "integration";
      readonly task: AttemptTaskSnapshot;
      readonly merge: IntegrationMerge;
      readonly successReason: "review_passed" | "verified_without_review";
      readonly successSideEffects: readonly string[];
      /** review.passed（rows 15/16）だけ true。 */
      readonly countReview: boolean;
    }
  | { readonly kind: "work_sync_conflict"; readonly task: AttemptTaskSnapshot; readonly taskBranch: string; readonly workBranch: string }
  | { readonly kind: "acceptance_defect"; readonly task: AttemptTaskSnapshot; readonly source: string }
  /** earlierReports: external blocker reports recorded earlier in the same lineage (this run excluded). */
  | { readonly kind: "external_blocker"; readonly task: AttemptTaskSnapshot; readonly earlierReports: number };

export interface NoProgressGateObservation {
  readonly kind: "no_progress_gate";
  readonly noProgressCount: number;
}

export type AttemptObservation = AttemptTaskObservation | NoProgressGateObservation;

/** evaluate が書き換える TaskRow の列（新しい値）。書かない列はキーごと持たない（undefined を入れると行の値を消すため）。 */
export type AttemptRowPatch = Readonly<Partial<Pick<TaskRow,
  | "failure_count" | "same_error_count" | "last_error_key" | "last_error_generation" | "last_failure_class"
  | "retry_no" | "next_attempt_at" | "reviewer_failure_count"
  | "review_round" | "lead_designer_start_round" | "design_escalated"
  | "total_review_attempts" | "base_sync_review_attempts" | "lead_review_rejections"
  | "paused_from" | "worktree_state"
>>>;

// Why not extra fields on AttemptDecision itself: task.attempt_decided spreads ...result.decision into its payload,
// so extra fields there would change the event. A reducer copies only the 4 AttemptDecision fields.
export interface AttemptPolicyDecision extends AttemptDecision {
  readonly managerTrigger: boolean;
  readonly sideEffects: readonly string[];
  readonly patch: AttemptRowPatch;
  /** あれば reducer が design_stop_json に { ...designStop, at } を書く。 */
  readonly designStop?: DesignStop;
  readonly reviewBudget?: NonNullable<ReductionResult<TaskRow>["review_budget"]>;
  readonly lineageBudget?: NonNullable<ReductionResult<TaskRow>["lineage_budget"]>;
  readonly designBlock?: NonNullable<ReductionResult<TaskRow>["design_block"]>;
}

export type AttemptTaskEvaluation =
  | { readonly outcome: "decision"; readonly decision: AttemptPolicyDecision }
  | { readonly outcome: "reject"; readonly message: string };

export type AttemptGateEvaluation =
  | { readonly outcome: "continue" }
  | { readonly outcome: "stop"; readonly reason: "no_progress_limit" };

/** resetFailureCounters と同じ列・同じ値。 */
export const FAILURE_COUNTER_RESET: AttemptRowPatch = {
  failure_count: 0,
  same_error_count: 0,
  last_error_key: null,
  last_error_generation: null,
  retry_no: 0,
  next_attempt_at: null,
};

export function normalizeErrorKey(key: string): string {
  if (key.length === 64) return key;
  return createHash("sha256").update(key).digest("hex");
}

// Why not compare against normalizeErrorKey(errorKey): last_error_key holds the hash, so comparing it with the raw key
// makes same_error_count almost always 1 unless the key is 64 chars. Copied as is: fixing it would change retry counts.
export function deterministicCounters(task: AttemptTaskSnapshot, errorKey: string): { same: number; total: number } {
  return {
    same: task.last_error_key === errorKey && task.last_error_generation === task.worker_generation ? task.same_error_count + 1 : 1,
    total: task.failure_count + 1,
  };
}

// Why not reuse deterministicCounters: integration and work-sync failures never looked at last_error_generation.
export function mergeFailureCounters(task: AttemptTaskSnapshot, errorKey: string): { same: number; total: number } {
  return {
    same: task.last_error_key === errorKey ? task.same_error_count + 1 : 1,
    total: task.failure_count + 1,
  };
}

function decide(
  task: AttemptTaskSnapshot,
  to: TaskState,
  reason: AttemptReason,
  sideEffects: readonly string[],
  managerTrigger: boolean,
  patch: AttemptRowPatch,
  extra: Partial<Pick<AttemptPolicyDecision, "designStop" | "reviewBudget" | "lineageBudget" | "designBlock">> = {},
): AttemptTaskEvaluation {
  const action = attemptAction(to, managerTrigger, reason);
  if (action === null) throw new Error(`Attempt policy produced a non-decision transition to ${to} (${reason}).`);
  return {
    outcome: "decision",
    decision: { action, reason, from: task.status, to, managerTrigger, sideEffects: [...sideEffects], patch, ...extra },
  };
}

function failureBase(task: AttemptTaskSnapshot, errorKey: string, counters: { same: number; total: number }): AttemptRowPatch {
  return {
    failure_count: counters.total,
    same_error_count: counters.same,
    last_error_key: normalizeErrorKey(errorKey),
    last_failure_class: "deterministic",
    last_error_generation: task.worker_generation,
  };
}

function evaluateReviewFailed(o: Extract<AttemptTaskObservation, { kind: "review_failed" }>, c: AttemptPolicyConfig): AttemptTaskEvaluation {
  const task = o.task;
  const totalAttempts = task.total_review_attempts + 1;
  const attempts = totalAttempts - (o.reviewAttemptsBase ?? 0);
  const limit = c.reviewLimits.total_review_attempts;
  const planRounds = c.reviewLimits.plan_review_rounds;
  const baseSync = task.base_sync_only === 1;
  const baseSyncAttempts = (task.base_sync_review_attempts ?? 0) + (baseSync ? 1 : 0);
  // Why not lead_designer_start_round != null: design_mode=lead sets it to 0 at creation, and replans reset it to 0, so it cannot tell "began at Lead" from "escalated".
  const lead = task.type === "design" && task.design_escalated === 1;
  // Every outcome carries these three columns: the counts are recorded whatever the verdict leads to.
  const counted = {
    total_review_attempts: totalAttempts,
    base_sync_review_attempts: baseSyncAttempts,
    lead_review_rejections: (task.lead_review_rejections ?? 0) + (lead ? 1 : 0),
  };
  const fix = ["replacement_worker_reserved"];
  const trigger = ["manager_trigger_required"];
  const owner = ["core_decision_required"];

  // Why not fill undefined limits with ??: a partial lineage (tests/remake/limits.test.mjs) compares against undefined and never stops, and that must stay.
  if (o.lineage && c.lineageLimits) {
    const mainAttempts = o.lineage.otherReviewAttempts + totalAttempts - baseSyncAttempts;
    if (mainAttempts >= c.lineageLimits.reviewAttempts) {
      return decide(task, "judgement_waiting", "lineage_budget_exhausted", owner, false, { ...counted, paused_from: null }, {
        lineageBudget: { reason: "lineage_review_attempts", attempts: mainAttempts, limit: c.lineageLimits.reviewAttempts, generations: o.lineage.generations },
      });
    }
    if (baseSync) {
      const lineageBaseSync = o.lineage.otherBaseSyncReviewAttempts + baseSyncAttempts;
      if (lineageBaseSync >= c.lineageLimits.baseSyncReviewAttempts) {
        return decide(task, "judgement_waiting", "base_sync_lineage_budget_exhausted", owner, false, { ...counted, paused_from: null }, {
          lineageBudget: { reason: "base_sync_lineage_review_attempts", attempts: lineageBaseSync, limit: c.lineageLimits.baseSyncReviewAttempts, generations: o.lineage.generations },
        });
      }
    }
  }
  const leadLimit = c.lineageLimits?.leadReviewRejections;
  if (lead && leadLimit !== undefined) {
    const rejections = (o.lineage?.otherLeadRejections ?? 0) + (task.lead_review_rejections ?? 0) + 1;
    if (rejections >= leadLimit) {
      return decide(task, "review_fix_waiting", "lead_rejections_exhausted", fix, false, counted, {
        designStop: { trigger: "lead_review_rejections", rejections, limit: leadLimit },
      });
    }
  }
  if (attempts > limit) {
    return decide(task, "judgement_waiting", "review_budget_exceeded", owner, false, { ...counted, paused_from: null }, { reviewBudget: { attempts, limit } });
  }
  if (attempts === limit) {
    return decide(task, "failed", "review_budget_reached", trigger, true, counted, { reviewBudget: { attempts, limit } });
  }
  if (o.verdict === "replan_required") return decide(task, "failed", "review_replan_required", trigger, true, counted);
  const leadStart = task.lead_designer_start_round ?? null;
  if (task.type === "design" && leadStart === null && task.review_round === planRounds - 1) {
    return decide(task, "review_fix_waiting", "design_escalated_to_lead", fix, false, {
      ...counted, review_round: planRounds, lead_designer_start_round: planRounds, design_escalated: 1,
    });
  }
  const lastRetryRound = task.type === "design" && leadStart !== null ? leadStart : planRounds - 1;
  if (task.review_round <= lastRetryRound) {
    return decide(task, "review_fix_waiting", "review_fix_required", fix, false, { ...counted, review_round: task.review_round + 1 });
  }
  return decide(task, "failed", "review_fix_required", trigger, true, counted);
}

function evaluateIntegration(o: Extract<AttemptTaskObservation, { kind: "integration" }>): AttemptTaskEvaluation {
  const task = o.task;
  // A passed review counts whether or not the merge succeeds.
  const reviewCount: AttemptRowPatch = o.countReview
    ? { total_review_attempts: task.total_review_attempts + 1, base_sync_review_attempts: (task.base_sync_review_attempts ?? 0) + (task.base_sync_only === 1 ? 1 : 0) }
    : {};
  const merge = o.merge;
  if (merge.outcome === "merged") {
    return decide(
      task, "completed", o.successReason,
      [...o.successSideEffects, "git_merge_recorded", merge.worktreeRetained ? "worktree_retained" : "worktree_removal_recorded"],
      false,
      { ...FAILURE_COUNTER_RESET, reviewer_failure_count: 0, worktree_state: merge.worktreeRetained ? "retained" : "merged", ...reviewCount },
    );
  }
  if (merge.outcome === "commit_failure") {
    const errorKey = `git_commit_failure:${merge.taskBranch}:${merge.workBranch}`;
    return decide(task, "failed", "integration_commit_failed", ["git_commit_failed", "manager_trigger_required"], true, {
      ...failureBase(task, errorKey, mergeFailureCounters(task, errorKey)), worktree_state: "active", ...reviewCount,
    });
  }
  const errorKey = `git_conflict:${merge.taskBranch}:${merge.workBranch}`;
  return decide(task, "failed", "integration_conflict", ["git_merge_aborted", "manager_trigger_required"], true, {
    ...failureBase(task, errorKey, mergeFailureCounters(task, errorKey)), worktree_state: "conflict_retained", ...reviewCount,
  });
}

export function evaluate(observation: NoProgressGateObservation, config: AttemptPolicyConfig): AttemptGateEvaluation;
export function evaluate(observation: AttemptTaskObservation, config: AttemptPolicyConfig): AttemptTaskEvaluation;
export function evaluate(observation: AttemptObservation, c: AttemptPolicyConfig): AttemptTaskEvaluation | AttemptGateEvaluation {
  switch (observation.kind) {
    case "no_progress_gate":
      return observation.noProgressCount < c.noProgressLimit ? { outcome: "continue" } : { outcome: "stop", reason: "no_progress_limit" };
    case "transient_failure": {
      const o = observation;
      if (!Number.isInteger(o.retryNo) || o.retryNo < 1) return { outcome: "reject", message: "The transient retry number must be a positive integer." };
      if (o.retryNo > c.transientRetryLimit) return { outcome: "reject", message: "The transient retry budget is exhausted." };
      return decide(o.task, "ready", "transient_failure", ["transient_retry_scheduled"], false, { retry_no: o.retryNo, next_attempt_at: o.nextAttemptAt });
    }
    case "deterministic_failure": {
      const o = observation;
      const counters = deterministicCounters(o.task, o.errorKey);
      const base: AttemptRowPatch = { ...failureBase(o.task, o.errorKey, counters), next_attempt_at: null };
      if (!o.retryAllowed) return decide(o.task, "judgement_waiting", "retry_not_allowed", ["core_decision_required"], false, { ...base, paused_from: null });
      if (counters.same < c.deterministicSameErrorLimit && counters.total < c.deterministicFailureLimit) {
        return decide(o.task, "ready", o.escalatedFromTransient ? "transient_budget_exhausted" : "deterministic_failure", ["deterministic_retry_scheduled"], false, base);
      }
      return decide(o.task, "failed", "deterministic_threshold", ["manager_trigger_required"], true, base);
    }
    case "worker_crash": {
      const o = observation;
      const counters = deterministicCounters(o.task, o.errorKey);
      const base: AttemptRowPatch = { ...failureBase(o.task, o.errorKey, counters), next_attempt_at: null };
      if (counters.same >= c.deterministicSameErrorLimit || counters.total >= c.deterministicFailureLimit) {
        return decide(o.task, "failed", "crash_threshold", ["manager_trigger_required"], true, base);
      }
      return decide(o.task, "ready", "crash", ["deterministic_retry_scheduled"], false, base);
    }
    case "reviewer_crash": {
      const o = observation;
      const reviewerFailures = o.task.reviewer_failure_count + 1;
      const base: AttemptRowPatch = { reviewer_failure_count: reviewerFailures, last_failure_class: "deterministic", next_attempt_at: null };
      if (reviewerFailures >= c.reviewerFailureLimit) return decide(o.task, "failed", "reviewer_crash_threshold", ["manager_trigger_required"], true, base);
      return decide(o.task, "review_fix_waiting", "reviewer_crash", ["replacement_worker_reserved"], false, base);
    }
    case "verification_failed": {
      const o = observation;
      if (o.task.review_round < c.reviewLimits.plan_review_rounds) {
        return decide(o.task, "review_fix_waiting", "verification_failed", ["replacement_worker_reserved"], false, { review_round: o.task.review_round + 1 });
      }
      return decide(o.task, "failed", "verification_exhausted", ["manager_trigger_required"], true, {});
    }
    case "review_failed":
      return evaluateReviewFailed(observation, c);
    case "design_stop": {
      const o = observation;
      return decide(o.task, "judgement_waiting", "design_blocked", ["core_decision_required"], false, { paused_from: null }, {
        ...(o.task.design_stop_json == null ? { designStop: { trigger: "designer", rejections: null, limit: null } as DesignStop } : {}),
        designBlock: {
          trigger: o.stop?.trigger ?? "designer",
          rejections: o.stop?.rejections ?? null,
          limit: o.stop?.limit ?? null,
          source: o.source,
          report: o.report,
        },
      });
    }
    case "integration":
      return evaluateIntegration(observation);
    case "work_sync_conflict": {
      const o = observation;
      const errorKey = `git_conflict:${o.taskBranch}:${o.workBranch}`;
      return decide(o.task, "failed", "work_sync_conflict", ["git_merge_aborted", "manager_trigger_required"], true, {
        ...failureBase(o.task, errorKey, mergeFailureCounters(o.task, errorKey)), next_attempt_at: null,
      });
    }
    case "acceptance_defect": {
      const o = observation;
      if ((o.source === "worker" && o.task.status === "running") || (o.source === "reviewer" && o.task.status === "verifying")) {
        return decide(o.task, "failed", "acceptance_defect", ["manager_trigger_required"], true, { last_failure_class: "deterministic", next_attempt_at: null });
      }
      return { outcome: "reject", message: `${ACCEPTANCE_DEFECT_EVENT} from ${o.source} is not valid while the Task is ${o.task.status}.` };
    }
    case "external_blocker": {
      const o = observation;
      if (o.task.status !== "running") return { outcome: "reject", message: `${EXTERNAL_BLOCKER_EVENT} is not valid while the Task is ${o.task.status}.` };
      if (!Number.isInteger(o.earlierReports) || o.earlierReports < 0) return { outcome: "reject", message: "The earlier external blocker count must be a non-negative integer." };
      if (o.earlierReports + 1 <= c.externalBlockerLimit) {
        // Why not failureBase: an outside cause is not a Worker failure, so failure_count / same_error_count stay (as acceptance_defect).
        return decide(o.task, "failed", "external_blocker", ["manager_trigger_required"], true, { last_failure_class: "deterministic", next_attempt_at: null });
      }
      return decide(o.task, "judgement_waiting", "external_blocker_limit", ["core_decision_required"], false, { paused_from: null });
    }
    default: {
      const unexpected: never = observation;
      throw new Error(`Unknown attempt observation kind: ${String((unexpected as { kind?: unknown }).kind)}`);
    }
  }
}
