import type { OwlDatabase, WriteLane, WriteLaneTransaction } from "../../db/dist/index.js";
import type { AcceptanceCriterion, AgentFailureClass, AgentProcessEvent, CuratorCandidate, CuratorProposal, CuratorRequest, CuratorRunResult, OwnerLanguage, ProcessSkillsInstallCommand, PromptObserver, ProcessSkillsSettings, RateLimitInfo, SkillFeedback, TaskNecessity, TaskPlanContext, TestPolicy, TokenUsage } from "@owl/shared";
import type { AttemptDecision } from "./attempt-policy";
import type { ExecutorRuntime } from "./executor.js";
import type { KnowledgeStoragePersistence } from "./knowledge-location.js";
import type { DetectedProcessSkillsPack, ProcessSkillsFileSystem } from "./process-skills-pack.js";
import type { NormalizedLesson } from "./final-verdict.js";
import type { DesignBlockedReport } from "../../shared/dist/design-blocked.js";
import type { PlanWaitFor } from "../../shared/dist/prerequisite.js";
import type { PlanUsageSource } from "../../shared/dist/plan-usage.js";

export type JsonObject = Record<string, unknown>;

/** Final Manager lessons and their source metadata passed to the durable learning queue. */
export interface WorkLearningInput {
  readonly agent_run_id: string | null;
  readonly project_id: string | null;
  readonly lessons: readonly NormalizedLesson[];
}

export type AgentKind = "decision" | "task" | "executor";

export type WorkState =
  | "memo"
  | "ready"
  | "running"
  | "paused"
  | "judgement_waiting"
  | "completed"
  | "cancelled"
  | (string & {});

export const WorkState = {
  Memo: "memo",
  Ready: "ready",
  Running: "running",
  Paused: "paused",
  JudgementWaiting: "judgement_waiting",
  Completed: "completed",
  Cancelled: "cancelled",
} as const satisfies Record<string, WorkState>;

export type TaskState =
  | "waiting"
  | "ready"
  | "running"
  | "paused"
  | "verifying"
  | "review_fix_waiting"
  | "failed"
  | "judgement_waiting"
  | "completed"
  | "cancelled";

export const TaskState = {
  Waiting: "waiting",
  Ready: "ready",
  Running: "running",
  Paused: "paused",
  Verifying: "verifying",
  ReviewFixWaiting: "review_fix_waiting",
  Failed: "failed",
  JudgementWaiting: "judgement_waiting",
  Completed: "completed",
  Cancelled: "cancelled",
} as const satisfies Record<string, TaskState>;

/**
 * Settings table key for the Hybrid Mode (Worker=Team Leader) toggle.
 * Shared by Core.getHybridMode() and WorkflowEngine so both read/write the
 * same `settings` row; value_json is the plain JSON boolean "true"/"false".
 */
export const HYBRID_MODE_SETTINGS_KEY = "hybrid_mode";
/** Legacy Executor setting key, retained for migration to child-run settings. */
export const EXECUTOR_CONFIG_SETTINGS_KEY = "executor_config";
/** Settings table key for child-run dispatch defaults and allowlists. */
export const CHILD_RUN_SETTINGS_KEY = "child_run_settings";

export type CoreSqlValue = string | number | bigint | Buffer | null;

/** The structural surface implemented by @owl/db's built OwlDatabase. */
export interface CoreDatabase {
  createWriteLane(): WriteLane;
  get<T extends object>(sql: string, ...parameters: CoreSqlValue[]): T | undefined;
  all<T extends object>(sql: string, ...parameters: CoreSqlValue[]): T[];
  migrate?: (migrationsDirectory?: string) => unknown;
  close?: () => void;
}

export type OwlDb = OwlDatabase;
export type CoreWriteLaneTransaction = WriteLaneTransaction;

export interface AgentRunRequest {
  readonly invocation_id: string;
  readonly work_id: string;
  readonly task_id: string | null;
  /** The Work's Project; omitted when the Work has none. Becomes OWL_PROJECT_ID of the agent's owl-memory server. */
  readonly project_id?: string;
  readonly attempt: number;
  readonly context: JsonObject;
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: string;
  /** The Owner language for the human-readable values of the output. */
  readonly language?: OwnerLanguage;
}

export interface ManagerPlanRequest extends AgentRunRequest {
  readonly task_id: null;
  readonly context: JsonObject;
}

export interface WorkerRunRequest extends AgentRunRequest {
  readonly task_id: string;
}

export interface ReviewerRunRequest extends AgentRunRequest {
  readonly task_id: string;
  readonly review_round: number;
}

export interface AdvisorRunRequest {
  readonly conversation_id: string;
  readonly messages: readonly { source: string; body: string }[];
  readonly invocation_id: string;
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: string;
  readonly system_prompt?: string;
}

export interface AdvisorRunResult {
  readonly reply: string;
  readonly suggested_actions?: readonly {
    type: string;
    description: string;
    payload?: JsonObject;
  }[];
}

/**
 * Turn contract for the persistent Advisor session runtime
 * (persistent Advisor session contract). Replaces
 * AdvisorRunRequest's "reload every message" shape: a turn carries only the
 * one new user message (plus attachments) that needs a reply, because
 * conversation history now lives in the provider CLI's own session/transcript
 * instead of being re-sent on every call.
 *
 * AdvisorRunRequest / AdvisorRunResult / AgentRunner.runAdvisor are kept
 * as-is; this type is additive and does not yet replace them.
 */
export interface AdvisorTurnRequest {
  readonly turn_id: string;
  readonly text: string;
  readonly attachment_paths?: readonly string[];
  readonly origin: {
    readonly channel: string;
    readonly ref?: string;
    readonly channel_id?: string;
  };
}

export type AgentOutcome = "success" | "failed" | "partial";
export type FailureClass = "transient" | "deterministic";

export interface AgentRunResult {
  readonly outcome: AgentOutcome;
  readonly failure_class?: AgentFailureClass;
  readonly rate_limit?: RateLimitInfo | null;
  readonly error_key?: string;
  readonly retry_allowed?: boolean;
  readonly exit_code?: number | null;
  readonly signal?: string | null;
  readonly report_valid?: boolean;
  readonly adapter_version?: string;
  readonly report?: JsonObject | null;
  readonly message?: string;
  readonly skill_feedback: SkillFeedback | null;
  /** Tokens the provider reported for this run; absent or null when it reported none. */
  readonly usage?: TokenUsage | null;
  /** Claude session to resume when only the report must be produced again. */
  readonly provider_session_id?: string;
}

/** Public runtime contract owned by @owl/core and implemented by agent-runtime. */
export interface AgentRunner {
  runManagerPlan(request: ManagerPlanRequest): Promise<AgentRunResult>;
  runDesigner(request: WorkerRunRequest): Promise<AgentRunResult>;
  runWorker(request: WorkerRunRequest): Promise<AgentRunResult>;
  runReviewer(request: ReviewerRunRequest): Promise<AgentRunResult>;
  runAdvisor(request: AdvisorRunRequest): Promise<AdvisorRunResult>;
  runCurator?(request: CuratorRequest): Promise<CuratorRunResult>;
  cancelAgent?(invocationId: string, force?: boolean): Promise<void>;
  setProcessObserver?(observer: (invocationId: string, event: AgentProcessEvent) => void | Promise<void>): void;
  setOutputObserver?(observer: (invocationId: string) => void): void;
  setOutputResubmitLimit?(read: () => number): void;
  setPromptObserver?(observer: PromptObserver | undefined): void;
}

export interface WorkCheckout {
  readonly path: string;
  /** HEAD of the Work branch. */
  readonly commit: string;
  /** merge-base of HEAD and the Project base branch. */
  readonly base_commit: string;
  /** The Project's canonical repository path. */
  readonly repo: string;
}

export interface GitOperationRequest {
  readonly work_id: string;
  readonly task_id: string | null;
  /** The isolated Task worktree to commit/integrate, when the operation targets a Task. */
  readonly worktree_path?: string | null;
  readonly task_branch?: string | null;
  readonly work_branch?: string | null;
  /**
   * Discard the Task's changes instead of preserving them on its branch: the
   * Task branch is reset to where it forked from the Work (design Tasks).
   */
  readonly discard_changes?: boolean;
}

export interface GitOperationResult {
  readonly ok: boolean;
  readonly exit_code: number;
  readonly recorded: boolean;
  readonly message: string;
  readonly worktree_path?: string | null;
  /** `work_sync_conflict`: the Task worktree conflicts with the Work branch; the merge was aborted. */
  readonly failure_kind?: "commit_failure" | "work_sync_conflict";
  /** prepareWorktree: true when this call created the worktree rather than reusing one. */
  readonly created?: boolean;
  readonly stderr_tail?: string;
}

/** Outcome of integrating one Task branch into its Work branch. */
export interface GitIntegrationResult extends GitOperationResult {
  /** The Task branch is now part of the Work branch. */
  readonly merged: boolean;
  /** A failed merge left no merge in progress in the integration worktree. */
  readonly aborted: boolean;
  readonly abort_message: string | null;
  /** The Task worktree was removed after a successful merge. */
  readonly worktree_removed: boolean;
  readonly removal_message: string | null;
}

export interface TaskWorktreeDiscardResult {
  readonly ok: boolean;
  readonly message: string;
  readonly changed_paths: readonly string[];
}

/** Outcome of verifying and merging a Work branch into its Project base branch. */
export type GitWorkMergeResult =
  | {
      readonly kind: "merged";
      readonly ok: true;
      readonly exit_code: 0;
      readonly recorded: boolean;
      readonly message: string;
      readonly worktree_path: string;
      readonly base_branch: string;
      readonly work_branch: string;
      readonly old_base_commit: string;
      readonly new_base_commit: string;
      /** null when the Work was already part of the base and nothing was merged. */
      readonly merge_commit: string | null;
      /** command_id of each verification command that ran; empty when the plan had none. */
      readonly verification_commands_run: readonly string[];
      /** Set when the plan was not run because the squash tree equals the already-verified tree. */
      readonly verification_skipped?: { readonly verified_commit: string; readonly tree: string };
    }
  | {
      readonly kind: "conflict";
      readonly ok: false;
      readonly exit_code: number;
      readonly recorded: boolean;
      readonly message: string;
      readonly worktree_path: string;
      readonly base_branch: string;
      readonly work_branch: string;
      readonly conflicting_files: readonly string[];
      readonly aborted: boolean;
      readonly abort_message: string | null;
    }
  | {
      readonly kind: "verification_failed";
      readonly ok: false;
      readonly exit_code: number;
      readonly recorded: boolean;
      readonly message: string;
      readonly worktree_path: string;
      readonly base_branch: string;
      readonly work_branch: string;
      readonly command_id: string;
      readonly command: readonly string[];
      readonly stdout_tail: string;
      readonly stderr_tail: string;
      readonly output_tail: string;
      readonly timed_out: boolean;
    }
  | {
      readonly kind: "base_moved";
      readonly ok: false;
      readonly exit_code: number;
      readonly recorded: boolean;
      readonly message: string;
      readonly worktree_path: string;
      readonly base_branch: string;
      readonly work_branch: string;
      readonly expected_base_commit: string;
      readonly actual_base_commit: string | null;
    }
  | {
      /** The Work was paused, cancelled or changed state before the base was advanced. */
      readonly kind: "interrupted";
      readonly ok: false;
      readonly exit_code: number;
      readonly recorded: boolean;
      readonly message: string;
      readonly worktree_path: string;
      readonly base_branch: string;
      readonly work_branch: string;
    }
  | {
      readonly kind: "error";
      readonly ok: false;
      readonly exit_code: number;
      readonly recorded: boolean;
      readonly message: string;
      readonly worktree_path: string | null;
      readonly base_branch: string | null;
      readonly work_branch: string | null;
      /** Paths with uncommitted changes in the integration worktree, when that is why the merge stopped. */
      readonly dirty_files?: readonly string[];
    };

export type GitPushFailure = "non_fast_forward" | "hook_rejected" | "network" | "auth" | "unknown";

export interface GitPushRequest {
  readonly work_id: string;
}

interface GitPushResultBase {
  readonly ok: boolean;
  readonly exit_code: number;
  readonly recorded: boolean;
  readonly message: string;
}

export type GitPushResult =
  | (GitPushResultBase & {
      readonly kind: "pushed";
      readonly remote: string;
      readonly base_branch: string;
      readonly remote_ref: string;
      readonly previous_tracking_commit: string | null;
      readonly new_remote_commit: string;
      readonly up_to_date: boolean;
      readonly hook_warnings: readonly string[];
    })
  | (GitPushResultBase & { readonly kind: "skipped_disabled" })
  | (GitPushResultBase & {
      readonly kind: "skipped_no_upstream";
      readonly base_branch: string;
      readonly base_commit: string | null;
    })
  | (GitPushResultBase & {
      readonly kind: "failed";
      readonly failure: GitPushFailure;
      readonly hook_side: "local" | "remote" | null;
      readonly remote: string | null;
      readonly base_branch: string | null;
      readonly remote_ref: string | null;
      readonly base_commit: string | null;
      readonly stderr_tail: string;
    });

/** Branches deleted after a completed Work was merged, as branch name -> commit SHA. */
export interface GitBranchCleanupResult extends GitOperationResult {
  readonly deleted_branches: Readonly<Record<string, string>>;
}

export interface AdvisorWorkspaceRequest {
  readonly conversation_id: string;
}

export interface AdvisorWorkspaceInspectionRequest {
  readonly conversation_id: string;
  readonly workspace_path: string;
}

export interface AdvisorWorkspaceInspection {
  readonly ok: boolean;
  readonly dirty: boolean;
  readonly message: string;
}

/** Outcome of one Advisor workspace sweep. */
export interface AdvisorWorkspaceSweepResult {
  /** Absolute paths of `.owl-workspaces/advisor` entries removed this pass. */
  readonly removed_workspaces: readonly string[];
  /** `owl/advisor/*` branches deleted this pass, across every repository checked. */
  readonly removed_branches: readonly string[];
}

/** One Task or Work integration directory found under `.owl-workspaces`. */
export interface WorkspaceEntry {
  readonly work_id: string;
  /** null for a Work's integration worktree (`__work__`) or another non-Task directory. */
  readonly task_id: string | null;
  readonly path: string;
}

export interface WorktreeCleanupResult {
  readonly ok: boolean;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/** Public Git boundary for Worker Tasks and persistent Advisor workspaces. */
export interface WorkBranchVerification {
  readonly status: "passed" | "failed" | "error" | "not_applicable";
  readonly reason: "no_project" | "empty_plan" | "verification_failed" | "prepare_failed" | "disabled" | null;
  readonly work_commit: string | null;
  readonly commands: ReadonlyArray<{
    readonly command_id: string;
    readonly argv: readonly string[];
    readonly passed: boolean;
    readonly exit_code: number | null;
    readonly timed_out: boolean;
    readonly duration_ms: number;
    readonly stdout_tail: string;
    readonly stderr_tail: string;
  }>;
  readonly failed_command_id: string | null;
  readonly message: string | null;
}

export interface GitGateway {
  prepareWorktree(request: GitOperationRequest): Promise<GitOperationResult>;
  /** The Project's base branch head and which of `paths` are missing from it (prerequisite waits). */
  baseBranchFacts?(request: { readonly work_id: string; readonly paths: readonly string[] }): Promise<
    { readonly ok: true; readonly head: string; readonly missing_paths: readonly string[] } | { readonly ok: false; readonly message: string }
  >;
  /** Merge the Project's base branch into the Work branch (fast-forward or merge commit); a conflict is aborted. */
  mergeBaseIntoWorkBranch?(request: { readonly work_id: string }): Promise<
    { readonly ok: true; readonly merged: boolean; readonly head: string } | { readonly ok: false; readonly conflict: boolean; readonly message: string }
  >;
  /** Prepare or reuse a persistent, conversation-scoped Advisor worktree. */
  prepareAdvisorWorkspace?(request: AdvisorWorkspaceRequest): Promise<GitOperationResult>;
  /** Inspect a conversation's Advisor worktree without changing it. */
  inspectAdvisorWorkspace?(request: AdvisorWorkspaceInspectionRequest): Promise<AdvisorWorkspaceInspection>;
  /**
   * Reclaim `.owl-workspaces/advisor` entries and `owl/advisor/*` branches no
   * live Advisor session (any status but `ended`) still uses: a clean,
   * fully-merged worktree is removed with its branch; a dirty or unmerged one
   * is kept and warned about; an empty stray directory is removed; a
   * non-empty one is kept and warned about. Also deletes merged, worktree-less
   * `owl/advisor/*` branches in Owl's own repository and every registered Git
   * Project's repository.
   */
  sweepAdvisorWorkspaces?(): Promise<AdvisorWorkspaceSweepResult>;
  /**
   * Commit the Task worktree and merge the Task branch into the Work branch.
   * A successful merge also removes the Task worktree; a failed merge is
   * aborted. Both happen before any other Git operation on the repository.
   */
  integrateTask(request: GitOperationRequest): Promise<GitIntegrationResult>;
  /**
   * Merge the Work branch onto the latest Project base (base as first
   * parent), verify it, then advance the base while the Work is still
   * running at expected_state_version.
   */
  mergeWorkIntoBase(request: { readonly work_id: string; readonly expected_state_version?: number; readonly verified_commit?: string }): Promise<GitWorkMergeResult>;
  /**
   * Run the Project's verification plan on the Work branch as it stands after
   * every Task was merged into it (before the Final Manager and the base merge).
   */
  verifyWorkBranch?(request: { readonly work_id: string }): Promise<WorkBranchVerification>;
  /**
   * Runs fn with the integration worktree reset to the Work branch HEAD and puts it back
   * afterwards. null when there is no Project or the checkout could not be prepared.
   */
  withWorkCheckout?<T>(request: { readonly work_id: string }, fn: (checkout: WorkCheckout) => Promise<T>): Promise<T | null>;
  /** `git diff --name-only from..to` in the canonical repo (renames as old and new path); null when Git cannot tell. */
  diffPaths?(request: { readonly work_id: string; readonly from: string; readonly to: string }): Promise<readonly string[] | null>;
  /** merge-base of the Task worktree HEAD and the Project base branch; null when unknown. */
  projectBaseCommit?(request: GitOperationRequest): Promise<string | null>;
  /** Push the Project base branch to its configured upstream without force; Git failures are returned. */
  pushBaseBranch?(request: GitPushRequest): Promise<GitPushResult>;
  /** Abort an interrupted Work merge in its integration worktree, if present. */
  abortIntegrationMerge(request: { readonly work_id: string }): Promise<GitOperationResult>;
  /** Delete a merged Work's branch and every Task branch of the Work. */
  deleteMergedWorkBranches(request: { readonly work_id: string }): Promise<GitBranchCleanupResult>;
  /** Whether this Work or one of its Task branches has content outside the Project base branch. */
  workHasUnmergedChanges(request: { readonly work_id: string }): Promise<boolean>;
  /**
   * Whether the Task branch's commits are already all reachable from the
   * Work branch, without changing anything. null when there is no Project,
   * no Task, or either branch does not exist, so the caller falls back to
   * its normal merge path.
   */
  taskBranchMerged?(request: GitOperationRequest): Promise<boolean | null>;
  removeWorktree(request: GitOperationRequest): Promise<GitOperationResult>;
  /**
   * Remove a completed design Task's worktree and delete its branch without
   * merging it: a design Task never contributes commits to the Work.
   */
  removeTaskWorktreeAndBranch(request: GitOperationRequest): Promise<GitOperationResult>;
  /**
   * Paths (relative to the Task worktree) the Task added or modified since it
   * branched from the Work, committed or not. null when the worktree is not a
   * Project worktree, so the caller captures the whole isolated workspace.
   */
  changedPaths?(request: GitOperationRequest): Promise<readonly string[] | null>;
  /** Like changedPaths, limited to files the Task added; null when unknown. */
  addedPaths?(request: GitOperationRequest): Promise<readonly string[] | null>;
  /** Like changedPaths, limited to tracked files the Task deleted; [] when unknown. */
  deletedPaths?(request: GitOperationRequest): Promise<readonly string[] | null>;
  /**
   * Per-file added/deleted line counts of everything the Task changed since it
   * branched from the Work (committed or not, untracked files included); null
   * when the worktree is not a Project worktree or Git cannot tell.
   */
  diffStats?(request: GitOperationRequest): Promise<readonly ChangedFile[] | null>;
  /**
   * Reset a design Task's worktree and branch to where it forked from the
   * Work, removing untracked files, and return every path that was changed
   * (committed or not).
   */
  discardTaskWorktreeChanges(request: GitOperationRequest): Promise<TaskWorktreeDiscardResult>;
  /**
   * Commit any uncommitted changes to the Task branch (the branch itself is
   * never deleted), then remove the Task worktree. With `discard_changes`
   * the Task branch is reset to its fork point instead of committed to. ok
   * when nothing existed to remove. A Project-less Task keeps its isolated
   * workspace instead.
   */
  discardTaskWorktree(request: GitOperationRequest): Promise<GitOperationResult>;
  /** Remove a worktree belonging to a merged Work without preserving its contents. */
  discardMergedWorktree(request: GitOperationRequest): Promise<GitOperationResult>;
  /** Remove a Work's integration worktree (`__work__`); the Work branch is kept. */
  removeIntegrationWorktree(request: { readonly work_id: string }): Promise<GitOperationResult>;
  /** Remove a merged Work's integration worktree without preserving its contents. */
  removeMergedIntegrationWorktree(request: { readonly work_id: string }): Promise<GitOperationResult>;
  /** Every Task/integration directory under `.owl-workspaces`, read directly from the filesystem. */
  listWorkspaces(): Promise<readonly WorkspaceEntry[]>;
  /** Save changes, reject ignored contents, then remove this Work's worktrees. */
  deleteWorkWorkspaces(request: { readonly work_id: string }): Promise<WorktreeCleanupResult>;
  /** Delete the Task and Work branches of a Work whose row was already deleted. */
  deleteWorkBranches?(request: { readonly work_id: string; readonly project_id: string }): Promise<WorktreeCleanupResult>;
}

/** MVP Git implementation: records intent and performs no Git side effect. */
export class NoopGitGateway implements GitGateway {
  private readonly operations: Array<{ operation: string; request: GitOperationRequest }> = [];

  public async prepareWorktree(request: GitOperationRequest): Promise<GitOperationResult> {
    return this.record("prepareWorktree", request);
  }

  public async integrateTask(request: GitOperationRequest): Promise<GitIntegrationResult> {
    return {
      ...this.record("integrateTask", request),
      merged: true,
      aborted: false,
      abort_message: null,
      worktree_removed: true,
      removal_message: null,
    };
  }

  public async mergeWorkIntoBase(request: { readonly work_id: string; readonly expected_state_version?: number }): Promise<GitWorkMergeResult> {
    this.operations.push({ operation: "mergeWorkIntoBase", request: { work_id: request.work_id, task_id: null } });
    return {
      kind: "merged",
      ok: true,
      exit_code: 0,
      recorded: true,
      message: `MVP Git operation mergeWorkIntoBase was recorded for work ${request.work_id}; no Git side effect was requested.`,
      worktree_path: "",
      base_branch: "",
      work_branch: "",
      old_base_commit: "",
      new_base_commit: "",
      merge_commit: null,
      verification_commands_run: [],
    };
  }

  public async pushBaseBranch(request: GitPushRequest): Promise<GitPushResult> {
    const result = this.record("push_base_branch", { work_id: request.work_id, task_id: null });
    return { ...result, kind: "skipped_disabled" };
  }

  public async abortIntegrationMerge(request: { readonly work_id: string }): Promise<GitOperationResult> {
    return this.record("abortIntegrationMerge", { work_id: request.work_id, task_id: null });
  }

  public async deleteMergedWorkBranches(request: { readonly work_id: string }): Promise<GitBranchCleanupResult> {
    return { ...this.record("deleteMergedWorkBranches", { work_id: request.work_id, task_id: null }), deleted_branches: {} };
  }

  public async workHasUnmergedChanges(request: { readonly work_id: string }): Promise<boolean> {
    this.operations.push({ operation: "workHasUnmergedChanges", request: { work_id: request.work_id, task_id: null } });
    return false;
  }

  public async removeWorktree(request: GitOperationRequest): Promise<GitOperationResult> {
    return this.record("removeWorktree", request);
  }

  public async removeTaskWorktreeAndBranch(request: GitOperationRequest): Promise<GitOperationResult> {
    return this.record("removeTaskWorktreeAndBranch", request);
  }

  public async discardTaskWorktree(request: GitOperationRequest): Promise<GitOperationResult> {
    return this.record("discardTaskWorktree", request);
  }

  public async discardTaskWorktreeChanges(request: GitOperationRequest): Promise<TaskWorktreeDiscardResult> {
    this.operations.push({ operation: "discardTaskWorktreeChanges", request });
    return { ok: true, message: "Noop Git gateway has no task worktree changes.", changed_paths: [] };
  }

  public async discardMergedWorktree(request: GitOperationRequest): Promise<GitOperationResult> {
    return this.record("discardMergedWorktree", request);
  }

  public async removeIntegrationWorktree(request: { readonly work_id: string }): Promise<GitOperationResult> {
    return this.record("removeIntegrationWorktree", { work_id: request.work_id, task_id: null });
  }

  public async removeMergedIntegrationWorktree(request: { readonly work_id: string }): Promise<GitOperationResult> {
    return this.record("removeMergedIntegrationWorktree", { work_id: request.work_id, task_id: null });
  }

  public async listWorkspaces(): Promise<readonly WorkspaceEntry[]> {
    return [];
  }

  public async deleteWorkWorkspaces(request: { readonly work_id: string }): Promise<WorktreeCleanupResult> {
    this.operations.push({ operation: "deleteWorkWorkspaces", request: { work_id: request.work_id, task_id: null } });
    return { ok: true, message: "No Git worktrees were present in the Noop gateway." };
  }

  public recordedOperations(): readonly { operation: string; request: GitOperationRequest }[] {
    return this.operations.slice();
  }

  private record(operation: string, request: GitOperationRequest): GitOperationResult {
    this.operations.push({ operation, request });
    return {
      ok: true,
      exit_code: 0,
      recorded: true,
      message: `MVP Git operation ${operation} was recorded for work ${request.work_id}; no Git side effect was requested.`,
    };
  }
}

export interface CoreOptions {
  readonly db: CoreDatabase;
  readonly agentRunner: AgentRunner;
  readonly git?: GitGateway;
  readonly version: string;
  /** Reads a project's tracked files for its overview note. Defaults to git. */
  readonly projectSourceReader?: import("./project-overview-note.js").ProjectSourceReader;
  /** Cap on active non-Executor agent runs per Work. Unlimited unless set. */
  readonly max_parallel?: number;
  readonly dispatcher?: CoreDispatcherOptions;
  /** Owl's own repository root, used to resolve `dataDir` and the legacy `<owlRoot>/.owl-workspaces` worktrees directory. Defaults to process.cwd() (a temporary directory under the Node test runner). */
  readonly owlRoot?: string;
  /** Durable runtime data directory. Defaults to `<owlRoot>/data`. */
  readonly dataDir?: string;
  /** Persists the Owner-chosen knowledge directory ("" = `<owlRoot>/knowledge`). Without it the location is fixed. */
  readonly knowledgeStorage?: KnowledgeStoragePersistence;
  /** Root directory for Work and Advisor worktrees. Defaults to `<owlRoot>/.owl-workspaces` for backward compatibility. */
  readonly workspacesRoot?: string;
  /** Replaces the process-starting runner of Core test runs (tests). */
  readonly testCommandRunner?: import("./test-runs.js").TestCommandRunner;
  /** How long cancelling or deleting a Work waits for its Agents to stop before removing the workspace. */
  readonly agentStopWaitMs?: number;
  /** Nightly test run. `executor` and `clock` let tests run without a real command or real time. */
  readonly nightlyTests?: {
    readonly executor?: import("./nightly-tests.js").NightlyTestExecutor;
    readonly clock?: import("./librarian-scheduler.js").LibrarianSchedulerClock;
    readonly timeoutMs?: number;
  };
  /**
   * Runs each Project's worktree setup and refresh commands before Worker,
   * Designer and Reviewer runs, and checks that their MCP servers start in the
   * worktree. `env` is the environment agents run with; `home` is where the
   * CLI configuration lives.
   */
  /** Runs a Project's post-merge command in its canonical checkout after a Work merges. */
  readonly postMergeCommand?: {
    /** Used when the Project at owlRoot has no setting (NULL). Unset: no default. */
    readonly owlRootDefault?: readonly string[];
    /** Install step run before the command when a dependency file changed, unless the Project sets its own. Default: pnpm install. */
    readonly installDefault?: readonly string[];
    /** Base names that count as dependency files. Default: package.json and common lockfiles. */
    readonly dependencyFiles?: readonly string[];
    readonly timeoutMs?: number;
  };
  readonly workspaceTooling?: {
    readonly env: () => NodeJS.ProcessEnv;
    readonly home: string;
  };
  /** Optional process skills detection inputs, primarily for isolated runtimes. */
  readonly processSkillsDetection?: {
    readonly env: NodeJS.ProcessEnv;
    readonly homedir: string;
    readonly fs?: ProcessSkillsFileSystem;
  };
  /**
   * Provider client for persistent Advisor sessions (agent-runtime's ProviderClient).
   * Kept as `unknown` here so this types module never imports agent-runtime; core.ts
   * casts it before constructing AdvisorSessionRuntime. Absent (or lacking
   * createSession) is not allowed for production persistent Advisor sessions.
   * Compatibility/stub callers may omit it and use the explicit one-shot
   * runner path, but the production server rejects this configuration rather
   * than silently switching modes.
   */
  readonly providerClient?: unknown;
  readonly getTypesafeApiKey?: () => string;
  readonly now?: () => string;
  /** Polling sources for subscription plan usage. Omitted sources remain unconfigured. */
  readonly planUsageSources?: "default" | { readonly claude?: PlanUsageSource | null; readonly codex?: PlanUsageSource | null };
  readonly skillCuratorDebounceMs?: number;
  readonly skillCuratorTypeSafeJudge?: (input: {
    readonly api_key: string;
    readonly proposal: CuratorProposal;
    readonly candidates: readonly CuratorCandidate[];
  }) => Promise<unknown>;
  /** Returns the operator-configured Advisor persona, or an empty string for the default. */
  readonly getAdvisorPersona?: () => string;
  readonly getAdvisorFolders?: () => { sharedDir: string; screenshotDir: string } | null;
  readonly getAdvisorSharedDir?: () => string | null;
  /** Resolves a configured provider id to its harness without guessing between harnesses. */
  readonly getProviderHarness?: (providerId: string) => "claude" | "codex" | undefined;
  /**
   * Environment overrides (base URL and API key variables) the Advisor's
   * provider process needs to reach a custom provider's endpoint. Empty for
   * a built-in provider. Settings are read fresh on every call, so a change
   * takes effect on the Advisor's next session. Throws when a custom
   * provider has no backend URL configured, the same policy Work runs use.
   */
  readonly getProviderConnectionEnv?: (providerId: string) => Readonly<Record<string, string>>;
  /** Environment and CLI paths for dispatched child runs, resolved on every dispatch. */
  readonly executorRuntime?: () => ExecutorRuntime | Promise<ExecutorRuntime>;
  /**
   * Model ids a built-in provider's harness accepts. Settings naming another
   * model are rejected. Undefined for a harness means its models are not
   * checked. Defaults to the built-in Codex list; Claude models are not checked.
   */
  readonly knownModels?: (harness: "claude" | "codex") => ReadonlySet<string> | undefined;
}

export interface ProcessSkillsSettingsSnapshot extends ProcessSkillsSettings {
  readonly detected: DetectedProcessSkillsPack | null;
  /** Commands that install the missing pack, one per harness CLI Owl could find. Owl only shows these; it never runs them. */
  readonly install_commands: readonly ProcessSkillsInstallCommand[];
}

export interface CoreDispatcherOptions {
  /** Background Work tick interval in milliseconds. */
  readonly tick_interval_ms?: number;
  /** Maximum number of Work ticks that may run concurrently. */
  readonly work_concurrency?: number;
  /** Cap on active agent runs (Executors excluded) across all Works. Unlimited unless set. */
  readonly global_max_parallel?: number;
  /** Delay before retrying a transient/retryable initial Manager plan failure. Defaults to 5000. */
  readonly manager_retry_delay_ms?: number;
  /** How often the dead/idle agent scan runs. Defaults to 60000. */
  readonly stale_check_interval_ms?: number;
}

export interface ServiceStatus {
  readonly name: string;
  readonly state: string;
  readonly pid: number | null;
}

export interface CoreStatus {
  readonly services: readonly ServiceStatus[];
  readonly mvp_scope: string;
  readonly version: string;
}

export interface CommandRequest<P extends JsonObject = JsonObject> {
  readonly request_id: string;
  readonly idempotency_key: string;
  readonly expected_version: number;
  readonly payload: P;
}

export interface CommandResponse<D extends JsonObject = JsonObject> {
  readonly request_id: string;
  readonly data: D;
  readonly version: number;
}

export interface ListResponse<T extends JsonObject = JsonObject> {
  readonly request_id: string;
  readonly data: readonly T[];
  readonly cursor: string | null;
  readonly has_more: boolean;
}

export interface ListQuery {
  readonly request_id?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface CreateWorkPayload extends JsonObject {
  readonly title: string;
  readonly summary: string;
  readonly size: "small" | "normal" | "large";
  readonly project_id: string | null;
  readonly design_mode?: "auto" | "lead";
  readonly backlog_item_ids?: string[];
  readonly dismiss_backlog_item_ids?: string[];
}

export interface CreateWorkData extends JsonObject {
  readonly work_id: string;
  readonly state: "memo" | "ready";
  readonly state_version: number;
}

export interface UpdateWorkPayload extends JsonObject {
  readonly title?: string;
  readonly summary?: string;
}

export interface UpdateWorkData extends JsonObject {
  readonly work_id: string;
  readonly title: string;
  readonly summary: string;
  readonly state: WorkState;
  readonly changed_fields: readonly ("title" | "summary")[];
  readonly replan_queued: boolean;
}

export interface ResumeWorkOrRetryPayload extends JsonObject {
  readonly source?: "web" | "slack" | "discord" | "advisor";
  readonly body?: string;
}

export interface ResumeWorkOrRetryData extends JsonObject {
  readonly work_id: string;
  readonly state: "running" | "judgement_waiting";
  readonly resumed_by: "resume" | "retry_decision";
  readonly decision_id: string | null;
}

export interface WorkSummary extends JsonObject {
  readonly id: string;
  readonly display_number: number | null;
  readonly title: string;
  readonly state: WorkState;
  readonly state_version: number;
  readonly updated_at: string;
  readonly archived_at: string | null;
  readonly project_id: string | null;
}

export interface WorkProgress extends JsonObject {
  readonly total_tasks: number;
  readonly completed_tasks: number;
  readonly percent: number;
}

export interface WorkAdvisorBacklogEntry extends JsonObject {
  readonly id: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly problem: string;
}

/** Backlog items the Advisor linked to, or dismissed for, a Work at create_work. */
export interface WorkAdvisorBacklog extends JsonObject {
  readonly linked: readonly WorkAdvisorBacklogEntry[];
  readonly dismissed: readonly WorkAdvisorBacklogEntry[];
}

export interface WorkDetail extends WorkSummary {
  readonly owner_id: string;
  readonly summary: string;
  readonly size: "small" | "normal" | "large";
  readonly design_mode: "auto" | "lead";
  readonly plan_revision: number;
  readonly progress: WorkProgress;
  readonly conversation_id: string | null;
  readonly advisor_backlog: WorkAdvisorBacklog | null;
}

export interface WorkListQuery extends ListQuery {
  readonly state?: WorkState | null;
  readonly archived?: "exclude" | "include" | "only";
}

export interface StartWorkPayload extends JsonObject {
  readonly mode: "normal" | "small";
}

export interface PauseWorkPayload extends JsonObject {
  readonly reason: string;
}

export interface CancelWorkPayload extends JsonObject {
  readonly reason: string;
  readonly force?: boolean;
}

export interface CancelAgentPayload extends JsonObject {
  readonly reason: string;
  readonly force?: boolean;
}

export interface TaskSummary extends JsonObject {
  readonly id: string;
  readonly work_id: string;
  readonly title: string;
  readonly status: TaskState;
  readonly type: string;
  readonly state_version: number;
  readonly updated_at: string;
  readonly created_at: string;
  readonly depends_on: readonly string[];
  /** Set while the Task waits on a prerequisite: why, what it waits for and until when. */
  readonly prerequisite: TaskPrerequisiteView | null;
  /** For a judgement_waiting Task: the reason of the open Decision that blocks it (for example the no-progress limit). */
  readonly stop_reason: string | null;
}

export interface TaskPrerequisiteView extends JsonObject {
  readonly reason: string;
  /** Who set the wait: the Manager (wait_for) or a Worker waiting for a process it started. */
  readonly source: "manager" | "worker";
  readonly conditions: readonly { readonly kind: string; readonly target: string | null; readonly description: string }[];
  readonly deadline_at: string;
  readonly since: string | null;
}

export interface TaskDetail extends TaskSummary {
  readonly parent_task_id: string | null;
  readonly acceptance: string;
  readonly review_round: number;
  readonly total_review_attempts: number;
  readonly failure_count: number;
  readonly worker_generation: number;
}

export interface TaskListQuery extends ListQuery {
  readonly status?: TaskState | null;
}

/** One choice of a Decision; description says what choosing it does. */
export interface DecisionOption extends JsonObject {
  readonly key: string;
  readonly label: string;
  readonly description: string;
}

export interface Decision extends JsonObject {
  readonly id: string;
  readonly work_id: string;
  readonly scope: "task" | "work";
  readonly status: "open" | "resolved" | "cancelled";
  /** The Decision template (decision-brief.ts): why, what is asked, and the facts around it. */
  readonly reason: string;
  readonly question: string;
  readonly current_state: string;
  readonly tried: string;
  readonly options: readonly DecisionOption[];
  readonly recommended: string | null;
  readonly allow_free_text: boolean;
  readonly blocked_task_ids: readonly string[];
  readonly state_version: number;
  /** Set when the Decision is a design stop with a Designer report: why the design cannot pass, as data. */
  readonly design_block: { readonly cause_kind: "wrong_premise" | "policy_conflict" | "ambiguous_criteria" | "simple_defect"; readonly repeated_findings: readonly { readonly summary: string; readonly times: number }[] } | null;
}

export interface DecisionListQuery extends ListQuery {
  readonly status?: "open" | "resolved" | "cancelled";
}

export interface AnswerDecisionPayload extends JsonObject {
  readonly answer: string;
  readonly option_key: string | null;
  readonly source_message_id: string | null;
}

export interface AnswerDecisionData extends JsonObject {
  readonly decision_id: string;
  readonly status: "resolved";
  readonly winner: boolean;
  readonly resumed_task_ids: readonly string[];
}

export interface AgentRun extends JsonObject {
  readonly id: string;
  readonly work_id: string | null;
  readonly task_id: string | null;
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  /** Reasoning effort the run was launched with; null when unset or unknown. */
  readonly effort: string | null;
  readonly status: string;
  /** Result of a completed run: success, redo, replan, question, partial or not_achieved; null otherwise. */
  readonly outcome: string | null;
  readonly pid: number | null;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  /** When the run last produced output; null before its first output. */
  readonly last_output_at: string | null;
  /** Executor runs: the Worker or observed parent that started the child. */
  readonly parent_agent_id: string | null;
  /** Child Executor runs: the durable child_runs record this attempt belongs to. */
  readonly child_run_id?: string | null;
  /** Legacy Hybrid phase metadata retained for existing run history. */
  readonly phase: string | null;
  /** Legacy Hybrid plan metadata retained for existing run history. */
  readonly subtask_count: number | null;
  /** Executor runs: the subtask or command it is working on. */
  readonly label: string | null;
  /** Executor runs: 'spawned' by Owl or 'observed' in another agent's process tree. */
  readonly origin: string | null;
}

export interface AgentsViewActivity {
  readonly run: AgentRun;
  readonly ordinal: number | string;
  readonly last_output_at: string | null;
  readonly task: TaskSummary | null;
  readonly work: WorkSummary | null;
  readonly project_name: string | null;
}

export interface AgentsViewData {
  readonly idle_threshold_seconds: number;
  readonly running: readonly AgentsViewActivity[];
  readonly recent: readonly AgentsViewActivity[];
  readonly children: readonly AgentRun[];
}

export interface WorkViewData extends JsonObject {
  readonly work: WorkDetail;
  readonly tasks: readonly TaskSummary[];
  readonly runs: readonly AgentRun[];
  readonly child_runs: readonly unknown[];
  readonly reports: readonly JsonObject[];
  readonly decisions: readonly Decision[];
  readonly conversation: JsonObject | null;
  readonly assurance: JsonObject | null;
}

export interface BoardViewData extends JsonObject {
  readonly works: readonly WorkSummary[];
  readonly open_decisions: readonly Decision[];
  readonly projects: readonly Project[];
  readonly next_cursor: string | null;
}

export interface LinkableWorksData extends JsonObject {
  readonly works: readonly WorkSummary[];
  readonly next_cursor: string | null;
}

export interface BacklogViewData extends JsonObject {
  readonly items: readonly unknown[];
  readonly next_offset: number | null;
  readonly projects: readonly Project[];
}

export interface TokensViewData extends JsonObject {
  readonly report: unknown;
  readonly plan_usage: unknown;
  readonly plan_usage_settings: unknown;
  readonly projects: readonly Project[];
}

export interface DecisionViewData extends JsonObject {
  readonly decision: Decision;
  readonly work: WorkDetail;
  readonly blocked_tasks: readonly TaskDetail[];
}

export interface AgentListQuery extends ListQuery {
  readonly status?: string | null;
  readonly work_id?: string | null;
}

export interface CanonicalEventFrame {
  readonly kind: "event";
  readonly event_id: string;
  readonly sequence: number;
  readonly cursor: string;
  readonly type: string;
  readonly schema_version: "1.0.0";
  readonly work_id: string | null;
  readonly task_id: string | null;
  readonly agent_run_id: string | null;
  readonly created_at: string;
  readonly payload: JsonObject;
}

export type EventHandler = (event: CanonicalEventFrame) => void | Promise<void>;

export interface WorkRow extends JsonObject {
  id: string;
  display_number: number | null;
  owner_id: string;
  project_id: string | null;
  title: string;
  summary: string;
  size: "small" | "normal" | "large";
  design_mode: "auto" | "lead";
  state: WorkState;
  state_version: number;
  plan_revision: number;
  rules_json: string;
  related_work_ids_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  archived_at: string | null;
}

export interface ChangedFile {
  path: string;
  added_lines: number;
  deleted_lines: number;
  binary: boolean;
  /** sha256 of the worktree file (or "deleted" / "special:<code>"); set by Core's change measurement. */
  content_hash?: string;
}

export interface TaskRow extends JsonObject {
  id: string;
  work_id: string;
  parent_task_id: string | null;
  title: string;
  type: string;
  status: TaskState;
  review_override: "true" | "false" | null;
  /** JSON {required_sections, required_tests} that the Core type policy checks; null when the Manager gave none. */
  verification_spec_json: string | null;
  /** Core's routing result (see review-routing.ts); null for Tasks routed before it existed. */
  review_decision: "required" | "not_required" | null;
  review_decision_json: string | null;
  priority: string;
  context: string;
  acceptance: string;
  acceptance_criteria_json?: string | null;
  plan_context_json?: string | null;
  state_version: number;
  failure_count: number;
  same_error_count: number;
  last_error_key: string | null;
  last_error_generation: number | null;
  review_round: number;
  lead_designer_start_round: number | null;
  /** 1 once a standard Designer Task was escalated to Lead (kept through replans and replacements); 0 for Tasks that began at Lead. */
  design_escalated?: number;
  /** Reviewer (not Worker) failures since the last replan, Decision, restore or completion. */
  reviewer_failure_count: number;
  /** Valid Reviewer verdicts across Manager replans; task.replanned keeps it. */
  total_review_attempts: number;
  /** Review attempts handed back by Manager replans (review_focus); the budget counts total_review_attempts minus this. */
  review_attempts_refunded?: number;
  /** 1 when the Task's current generation is marked base-sync-only (the Manager's mark, rewritten at each retry). Missing/0 = main work. */
  base_sync_only?: number;
  /** How many generations of this Task id were base-sync-only. */
  base_sync_generations?: number;
  /** The part of total_review_attempts made in base-sync-only generations. */
  base_sync_review_attempts?: number;
  /** Root of the remake lineage; null when the Task is its own root. */
  lineage_root_task_id: string | null;
  /** 1 for an original Task, +1 for each remake (replacement or same-id retry). */
  lineage_generation: number;
  /** JSON array of the Task ids this Task replaced. */
  replaces_task_ids_json: string;
  worker_generation: number;
  manager_task_id: string | null;
  retry_no: number;
  next_attempt_at: string | null;
  worktree_path: string | null;
  worktree_state: string | null;
  last_failure_class: FailureClass | null;
  paused_from: TaskState | null;
  /**
   * Task row 27: the dependency whose failure failed this Task. Set while the
   * Task is failed (or paused from failed) because of that cascade; null for
   * a root failure. Cleared whenever the Task leaves that failure. Core never hands such a Task to the
   * Manager or to a Decision: it returns to waiting on its own (row 31).
   */
  failed_by_dependency_task_id: string | null;
  /** Set while the Task waits on a prerequisite (a PrerequisiteSpec as JSON); null for an ordinary wait. */
  prerequisite_json?: string | null;
  prerequisite_since?: string | null;
  /** Reviewer rejections of Lead Designer output this Task received (lineage totals: task-lineage.ts). */
  lead_review_rejections?: number;
  /** Set once Core stopped remaking a design (or the Designer reported design_blocked); see migration 054. */
  design_stop_json?: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkReducerCommand {
  readonly event: string;
  readonly payload?: JsonObject;
  readonly expected_version?: number;
}

export interface TaskReducerCommand {
  readonly event: string;
  readonly payload?: JsonObject;
  readonly expected_version?: number;
}

export interface ReductionResult<S extends JsonObject> {
  readonly previous: S;
  readonly next: S;
  readonly accepted: boolean;
  readonly changed: boolean;
  readonly manager_trigger: boolean;
  readonly decision_id?: string;
  readonly side_effects: readonly string[];
  /** Why the Attempt Policy chose this transition; absent for transitions that are not a decision. */
  readonly decision?: AttemptDecision;
  /** Set when the Reviewer verdict used up the Task's total review attempts. */
  readonly review_budget?: { readonly attempts: number; readonly limit: number };
  /** Set when fix_required reviews kept pointing at the same spot; the findings that did. */
  readonly review_same_spot?: readonly { readonly file: string; readonly line: number | null; readonly problem: string }[];
  /** Set when the lineage-wide Reviewer verdict count reached remake_limits.lineage_review_attempts or base_sync_lineage_review_attempts. */
  readonly lineage_budget?: {
    readonly reason: "lineage_review_attempts" | "base_sync_lineage_review_attempts";
    readonly attempts: number;
    readonly limit: number;
    readonly generations: number;
  };
  /** Set when a design Task stops without a remake: the lead rejection limit was reached or the Designer reported design_blocked. */
  readonly design_block?: {
    readonly trigger: "lead_review_rejections" | "designer";
    readonly rejections: number | null;
    readonly limit: number | null;
    readonly source: "designer" | "core";
    readonly report: DesignBlockedReport | null;
  };
  /** Decisions the reducer closed as a side effect (not the decision this event itself resolved). */
  readonly cancelled_decision_ids?: readonly string[];
}

export interface TaskPlanItem {
  readonly id?: string;
  readonly title: string;
  readonly type: string;
  /** Display text rendered from acceptance_criteria; Core never reads criteria back from it. */
  readonly acceptance: string;
  readonly acceptance_criteria?: readonly AcceptanceCriterion[];
  readonly review?: boolean;
  readonly required_sections?: readonly string[];
  readonly required_tests?: readonly string[];
  readonly context?: string;
  readonly priority?: "low" | "normal" | "high" | "critical";
  readonly depends_on?: readonly string[];
  readonly parent_task_id?: string | null;
  readonly manager_task_id?: string;
  /** Manager replan only: ids of the failed Tasks this new Task replaces. */
  readonly replaces?: readonly string[];
  /** Manager replan only, on a retried Task: hold it in `waiting` until the conditions hold. */
  readonly wait_for?: PlanWaitFor | null;
  /** Manager replan only: this attempt only merges the base branch; counted apart from the main-work remake limits. */
  readonly base_sync_only?: boolean;
  /** Why this Task and each acceptance criterion are needed, and how heavy each check is. */
  readonly necessity?: TaskNecessity | null;
  /** The Manager's context, notes and necessity as written; `context` above is their display text. */
  readonly plan_context?: TaskPlanContext;
}

export interface WorkflowSnapshot {
  readonly work_id: string;
  readonly ready_task_ids: readonly string[];
  readonly running_task_ids: readonly string[];
  readonly completed_task_ids: readonly string[];
  readonly capacity: number;
}

export interface VerificationCommand extends JsonObject {
  readonly command_id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env_allowlist: readonly string[];
  readonly timeout_seconds: number;
  readonly stdout_limit: number;
  readonly stderr_limit: number;
  readonly expected_exit_codes: readonly number[];
  readonly executor: "core" | "reviewer";
}

/** Whether Core's test check runs for a Project, and why. source: explicit = the Owner's test_run, detected = Core's marker table. */
export interface TestRunStatus extends JsonObject {
  readonly enabled: boolean;
  /** null when enabled. */
  readonly reason: string | null;
  /** argv Core runs; null when disabled. */
  readonly command: readonly string[] | null;
  readonly source: "explicit" | "detected";
}

export interface Project extends JsonObject {
  readonly id: string;
  readonly name: string;
  readonly canonical_path: string;
  readonly base_branch: string;
  readonly auto_push: boolean;
  /** Command (argv, no shell) run in each newly created worktree before its first agent. Empty when unset. */
  readonly worktree_setup_command: readonly string[];
  /** Command (argv, no shell) run in the worktree before every agent launch. Empty when unset. */
  readonly worktree_refresh_command: readonly string[];
  /** Command (argv, no shell) run in canonical_path after a Work is merged. null uses the default; [] disables it. */
  readonly post_merge_command: readonly string[] | null;
  /** Command (argv, no shell) run in canonical_path before the post-merge command when dependencies changed. null uses the default; [] disables it. */
  readonly post_merge_install_command: readonly string[] | null;
  /** Command (argv, no shell) Core runs without a model before merging a Work into base. A failure blocks the merge. null disables it. */
  readonly required_test_command: readonly string[] | null;
  /** Test-run settings (TestRunSettings keys, all optional); null = Core does not run tests. */
  readonly test_run: JsonObject | null;
  readonly test_run_status: TestRunStatus;
  /** Test handling; DEFAULT_TEST_POLICY when unset. */
  readonly test_policy: TestPolicy;
  /** Shell command strings the Worker runs before reporting; [] = not set (Core falls back to test detection). */
  readonly report_check_commands: readonly string[];
  readonly allowed_roots: readonly string[];
  readonly verification_plan: readonly VerificationCommand[];
}

export interface CreateProjectPayload extends JsonObject {
  readonly name: string;
  readonly canonical_path: string;
  readonly base_branch: string;
  readonly allowed_roots: readonly string[];
  readonly verification_plan: readonly VerificationCommand[];
  readonly post_merge_command?: readonly string[] | null;
  readonly post_merge_install_command?: readonly string[] | null;
  readonly required_test_command?: readonly string[] | null;
  readonly test_run?: JsonObject | null;
  readonly test_policy?: JsonObject | null;
}

export interface UpdateProjectPayload extends JsonObject {
  readonly name?: string;
  readonly canonical_path?: string;
  readonly base_branch?: string;
  readonly auto_push?: boolean;
  readonly worktree_setup_command?: readonly string[];
  readonly worktree_refresh_command?: readonly string[];
  readonly post_merge_command?: readonly string[] | null;
  readonly post_merge_install_command?: readonly string[] | null;
  readonly required_test_command?: readonly string[] | null;
  readonly test_run?: JsonObject | null;
  readonly test_policy?: JsonObject | null;
  readonly report_check_commands?: readonly string[] | null;
  readonly verification_plan?: readonly VerificationCommand[];
}

export interface DeleteProjectPayload extends JsonObject {
  readonly confirmed_work_count: number;
}

export type ProjectBlocker = "running_works" | "active_agents";

export interface ProjectRunningWork extends JsonObject {
  readonly id: string;
  readonly display_number: number | null;
  readonly title: string;
  readonly state: "running" | "paused" | "judgement_waiting";
}

export interface ProjectDeletionImpact extends JsonObject {
  readonly project_id: string;
  readonly work_count: number;
  readonly running_work_count: number;
  readonly active_agent_count: number;
  readonly backlog_item_count: number;
  readonly running_works: readonly ProjectRunningWork[];
  readonly blockers: readonly ProjectBlocker[];
  readonly deletable: boolean;
}

export interface DetachedWork extends JsonObject {
  readonly work_id: string;
  readonly previous_display_number: number | null;
  readonly display_number: number | null;
}

export interface DeleteProjectResult extends JsonObject {
  readonly project_id: string;
  readonly deleted: true;
  readonly detached_work_count: number;
  readonly detached_backlog_item_count: number;
  readonly detached_works: readonly DetachedWork[];
}

export interface ProjectListQuery extends ListQuery {}

export type ActorRole = "advisor" | "manager" | "designer" | "lead_designer" | "worker" | "reviewer" | "librarian" | "curator";
export type ModelEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface RoleModelSetting extends JsonObject {
  readonly role: ActorRole;
  readonly provider: string;
  readonly model: string;
  readonly effort: ModelEffort;
  readonly catalog_version: string;
}

export interface RoleModelSettingInput extends JsonObject {
  readonly role: ActorRole;
  readonly provider: string;
  readonly model: string;
  readonly effort: ModelEffort;
}

export interface UpdateModelSettingsPayload extends JsonObject {
  readonly roles: readonly RoleModelSettingInput[];
}

export interface ModelPreset extends JsonObject {
  readonly id: string;
  readonly name: string;
  readonly roles: readonly RoleModelSetting[];
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateModelPresetPayload extends JsonObject {
  readonly name: string;
  readonly roles: readonly RoleModelSettingInput[];
}

export interface UpdateModelPresetPayload extends JsonObject {
  readonly name?: string;
  readonly roles?: readonly RoleModelSettingInput[];
}

export interface Message extends JsonObject {
  readonly id: string;
  readonly conversation_id: string;
  readonly source: string;
  readonly body: string;
  readonly attachment_ids: readonly string[];
  readonly created_at: string;
}

export interface MessageListQuery extends ListQuery {}

export interface PostMessagePayload extends JsonObject {
  readonly body: string;
  readonly attachment_ids: readonly string[];
}

/** Groups an inbound message or upload into a conversation: by dm_ref, and by thread_ref when the connector wants messages kept apart by thread. */
export interface ConversationHint {
  readonly work_id: string | null;
  readonly dm_ref: string;
  readonly thread_ref: string | null;
}

export interface InboundMessagePayload extends JsonObject {
  readonly provider: "slack" | "discord";
  /** Canonical connector_accounts.id, never the provider's external account id. */
  readonly account_id: string;
  readonly external_message_id: string;
  readonly user_id: string;
  readonly channel_id: string;
  readonly thread_id: string | null;
  readonly received_at: string;
  readonly text: string;
  readonly conversation_hint: ConversationHint;
  readonly attachment_ids: readonly string[];
}

/**
 * Exactly one of conversation_id/conversation_hint must be set: conversation_id
 * targets an existing conversation directly (e.g. a web upload attached to
 * the active conversation); conversation_hint resolves (or creates) one the
 * same way an inbound message would, so a connector can upload a file before
 * it has a conversation_id to attach it to.
 */
export interface InboundUploadRegisterPayload extends JsonObject {
  readonly provider: "slack" | "discord" | "web";
  readonly account_id: string;
  readonly external_attachment_id: string;
  readonly filename: string;
  readonly declared_mime: string | null;
  readonly declared_bytes: number;
  readonly sha256: string | null;
  readonly work_id: string | null;
  readonly conversation_id: string | null;
  readonly conversation_hint: ConversationHint | null;
}

export interface InboundUploadTicket extends JsonObject {
  readonly upload_id: string;
  readonly put_path: string;
  readonly expires_at: string;
  readonly max_bytes: number;
  readonly conversation_id: string;
}

export interface InboundUploadContentResult extends JsonObject {
  readonly upload_id: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly status: "receiving";
}

export interface InboundUploadCompletePayload extends JsonObject {
  readonly bytes: number;
  readonly sha256: string;
  readonly mime: string;
}

export interface InboundUploadCompleteResult extends JsonObject {
  readonly upload_id: string;
  readonly artifact_id: string;
  readonly status: "stored" | "quarantined";
  readonly sha256: string;
  readonly bytes: number;
  readonly mime: string;
}

export interface InboundUploadBytes {
  readonly content: Buffer;
  readonly sha256: string;
  readonly mime: string;
}
