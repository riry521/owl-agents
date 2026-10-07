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
  | { kind: "external_blocker"; task_id: string; cause: string }
  | {
    kind: "task_integration_failed";
    task_id: string;
    after: "verification" | "review";
    failure_kind: "merge_conflict" | "commit_failure";
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
    owner_replan_kind: "decision" | "reopen" | "instruction" | "work_update" | "auto_conflict" | "auto_final";
    automatic: boolean;
    situation: "failed_tasks" | "base_merge_conflict" | "final_incomplete" | "integration_verification" | "other";
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
