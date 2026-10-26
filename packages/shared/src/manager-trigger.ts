/** Values of the trigger fields below, listed at runtime so the Owner-facing text check can tell Owl's names from the Owner's; the field types are derived from them. */
export const TASK_INTEGRATION_FAILURE_KINDS = ["merge_conflict", "commit_failure"] as const;
export const OWNER_REPLAN_KINDS = ["decision", "reopen", "instruction", "work_update", "auto_conflict", "auto_final"] as const;
export const OWNER_REQUEST_SITUATIONS = ["failed_tasks", "base_merge_conflict", "final_incomplete", "integration_verification", "other"] as const;

/** Why a Task needs the Manager; one field per fact. Text fields are upstream sentences (exception, Reviewer, Worker) kept whole. */
export type TaskReplanTrigger =
  | { kind: "launch_conflict"; task_id: string; merge_conflict_files: string[] }
  | { kind: "verification_error"; task_id: string; message: string }
  | { kind: "failure_threshold"; task_id: string; error_key: string | null; reason: string | null; question: string | null }
  | { kind: "verification_exhausted"; task_id: string }
  | { kind: "reviewer_error"; task_id: string; message: string }
  | { kind: "design_document_missing"; task_id: string }
  | { kind: "review_budget_exhausted"; task_id: string; attempts: number; limit: number }
  | { kind: "reviewer_replan_requested"; task_id: string; summary: string | null }
  | { kind: "review_exhausted"; task_id: string }
  | { kind: "budget_exhausted"; task_id: string; require_different_approach: true }
  | { kind: "partial_repeated"; task_id: string }
  | { kind: "external_blocker"; task_id: string; cause: string }
  | {
    kind: "task_integration_failed";
    task_id: string;
    after: "verification" | "review";
    failure_kind: (typeof TASK_INTEGRATION_FAILURE_KINDS)[number];
    work_branch: string;
    merge_conflict_files: string[];
    message: string | null;
  };

/** Why the Manager is called. Core writes no sentence of it; the Manager's instructions explain each kind. */
export type ManagerTrigger =
  | { kind: "initial_plan" }
  | { kind: "task_failed"; tasks: TaskReplanTrigger[] }
  | { kind: "queued_failed_tasks" }
  | { kind: "work_verification_failed"; core_tests_failed: boolean }
  | {
    kind: "owner_request";
    owner_replan_kind: (typeof OWNER_REPLAN_KINDS)[number];
    automatic: boolean;
    situation: (typeof OWNER_REQUEST_SITUATIONS)[number];
  }
  | { kind: "design_completed"; design_task_ids: string[] }
  | { kind: "final_check" };

/** A Worker's question to the Manager, kept whole. */
export interface WorkerQuestion {
  readonly task_id: string;
  readonly question: string;
}

/** A merge conflict between the Work branch and the Project base branch. */
export interface BaseMergeConflict {
  readonly base_branch: string | null;
  readonly files: string[];
  readonly automatic: boolean;
}

/** Runtime lists of the kinds above, so the Owner-facing text check can tell Owl's names from the Owner's. Each list is checked both ways against its type. */
export const TASK_REPLAN_TRIGGER_KINDS = [
  "launch_conflict", "verification_error", "failure_threshold", "verification_exhausted", "reviewer_error",
  "design_document_missing", "review_budget_exhausted", "reviewer_replan_requested", "review_exhausted",
  "budget_exhausted", "partial_repeated", "external_blocker", "task_integration_failed",
] as const satisfies readonly TaskReplanTrigger["kind"][];
export const MANAGER_TRIGGER_KINDS = [
  "initial_plan", "task_failed", "queued_failed_tasks", "work_verification_failed", "owner_request", "design_completed", "final_check",
] as const satisfies readonly ManagerTrigger["kind"][];
/** previous_output_feedback kinds of a rejected or repaired plan. */
export const PLAN_FEEDBACK_KINDS = ["plan_rejected", "fields_missing", "quality_rejected", "quality_repair"] as const;
export type PlanFeedbackKind = (typeof PLAN_FEEDBACK_KINDS)[number];

type EveryKindListed<Kind, Listed> = [Exclude<Kind, Listed>] extends [never] ? true : never;
export const TRIGGER_KIND_LISTS_COMPLETE: [
  EveryKindListed<TaskReplanTrigger["kind"], (typeof TASK_REPLAN_TRIGGER_KINDS)[number]>,
  EveryKindListed<ManagerTrigger["kind"], (typeof MANAGER_TRIGGER_KINDS)[number]>,
] = [true, true];
