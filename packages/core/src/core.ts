import { createHash } from "node:crypto";
import { createHash as createFileHash } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createUlid, utcNow } from "../../db/dist/index.js";
import { DecisionService, type OpenDecisionPayload } from "./decision";
import { DECISION_CANCEL_OPTION_KEY, managerReplanFailureBrief, prerequisiteExpiredBrief, RESOLVE_CONFLICT_OPTION_KEY } from "./decision-brief";
import { evaluatePrerequisite, type PrerequisiteFacts } from "./prerequisite-monitor";
import { isFinalLesson, isFinalMissingItem, normalizeLesson, parseLessonBlocks, type FinalManagerVerdict } from "./final-verdict";
import { outputResubmitLimit } from "./report-resubmit";
import { DEFAULT_OWNER_LANGUAGE, OWNER_LANGUAGE_SETTINGS_KEY, ownerLanguage, storedOwnerLanguage, type OwnerLanguage, type SettingsReader } from "./owner-language";
import { finalAutoContinueLimit } from "./final-continue-limit";
import { EventDispatcher } from "./event-dispatcher";
import { HumanReadableError, dependencyUnavailable, idempotencyConflict, invalidStateTransition, notFound, projectDeletionImpactChanged, projectHasRunningWorks, projectNotFound, providerPauseNotFound, projectPathConflict, validationError, versionConflict, workCancelled, workReopenRequired } from "./errors";
import {
  appendEventInTransaction,
  createWorkInTransaction,
  detachProjectWorksInTransaction,
  ensureOwner,
  isDecisionCancelAnswer,
  isTerminalTaskState,
  designCompletedKey,
  managerTriggerKey,
  REPLAN_PLAN_STALE,
  REPLAN_WORK_NOT_RUNNING,
  openRemakeLimitDecisionInTransaction,
  stopTaskForNoProgressInTransaction,
  reduceTaskInTransaction,
  reduceWorkInTransaction,
  resolveDecisionInTransaction,
  restoreCascadedDependentsInTransaction,
  setWorkArchivedInTransaction,
  updateWorkFieldsInTransaction,
  taskDependenciesCompletedInTransaction,
} from "./state-reducer";
import {
  applyManagerWorkSummaryUpdateInTransaction,
  listWorkSummaryRevisions,
  managerWorkSummaryUpdate,
  recordOwnerWorkSummaryRevisionInTransaction,
  type ManagerWorkSummaryUpdate,
  type WorkSummaryHistory,
} from "./work-summary-history";
import { getWorkAssurance, type WorkAssurance } from "./work-assurance";
import { WorkDriver } from "./work-driver";
import { WorkflowEngine } from "./workflow-engine";
import { isPlanRejection, validatePlan, validateReplan, type PlanRejection, type ReplanAction, type ReplanPlan, type ReplanSnapshot } from "./replan-plan";
import type { PlanWaitFor, PrerequisiteCondition, PrerequisiteSpec } from "../../shared/dist/prerequisite.js";
import { isProcessGroupAlive } from "../../shared/dist/process-group.js";
import { KnowledgeBase } from "./knowledge-base";
import { archiveLegacyKnowledge } from "./memory/knowledge-archive.js";
import { ChildEmbedder, loadEmbedderConfig } from "./memory/embedder.js";
import { MemoryService, type MemoryExpandOutput, type MemoryHealth, type MemoryRecallOutput, type MemoryReindexOutput, type MemorySearchOutput, type PageReadOutput, type PageSearchOutput } from "./memory/memory-service.js";
import { advisorKey, DEFAULT_MEMORY_READ_LIMITS, MemoryReadLedger, type MemoryReadLimits, type RoleReadLimit } from "./memory/memory-read-ledger.js";
import type { MemorySearchInput } from "./memory/memory-search.js";
import type { MemoryNoteType, MemoryRequestContext } from "./memory/memory-types.js";
import type { KnowledgeSearchResult } from "./knowledge-base";
import { KnowledgeLocation, type KnowledgeMoveMode, type KnowledgeMoveResult, type KnowledgeStorageStatus } from "./knowledge-location";
import { KnowledgeNotes } from "./knowledge-notes.js";
import { createClaudeUsageSource } from "./plan-usage/claude-source.js";
import { createCodexSessionLogSource } from "./plan-usage/codex-source.js";
import { retagKnowledge, type KeywordExtractionItem, type KeywordExtractionResult } from "./knowledge-retag.js";
import { GitProjectSourceReader, INVESTIGATION_MARKER, ProjectOverviewService, collectFacts, thinMetrics, thinReasons, type ProjectInvestigationInput, type ProjectInvestigationResult, type ProjectOverviewInput, type ProjectSourceReader } from "./project-overview-note.js";
import { normalizeKnowledgeLimits, renderProjectOverview } from "./knowledge-retrieval.js";
import { IndexInjector } from "./memory/index-injector.js";
import { ResearchRecall } from "./memory/research-recall.js";
import { PageRouter, writePage } from "./memory/page-router.js";
import { assertValidPage } from "./memory/page-format.js";
import { PageLibrarian, type PagePendingStats, type PageRunMode, type ProposeOperationsFn } from "./memory/page-librarian.js";
import { IndexBuilder } from "./memory/index-builder.js";
import { bodySha256 } from "./memory/page-format.js";
import { ConversationLogWriter } from "./memory/conversation-log-writer.js";
import { WorkLogWriter } from "./memory/work-log-writer.js";
import { searchQuery } from "./memory/memory-injector.js";
import { ruleKeyFingerprint } from "./learning-fingerprint.js";
import { LearningJobs, LearningPipeline, type LearningJobStatus } from "./learning-pipeline.js";
import { RuleLoadError, RuleStore, parseWorkRules, type RuleReloadResult, type RuleRole } from "./rule-store";
import type { RuleCurationResult } from "./rule-curation.js";
import { RuleProposals, type RuleProposalCreateResult, type RuleProposalStatus } from "./rule-proposals.js";
import { RuleWriter } from "./rule-writer.js";
import { DEFAULT_SKILL_FEEDBACK_WEIGHTS, detectSkillReads, SkillBox, type SkillSettings, type SkillState } from "./skill-box";
import { isValidSkillScope, validateSkillFilePath, validateSkillName } from "./skill-files";
import { SKILL_CURATOR_DEBOUNCE_MS, SkillCurator, type SkillCurationResult } from "./skill-curator";
import { AdvisorSessionManager } from "./advisor-session.js";
import { AdvisorSessionRuntime, type AdvisorSettingsSnapshot } from "./advisor-runtime.js";
import { MemorySaver } from "./memory-saver.js";
import { slugifyKnowledgeContentName } from "./knowledge-naming.js";
import { LibrarianScheduler, parseLibrarianTime } from "./librarian-scheduler.js";
import {
  DEFAULT_NIGHTLY_TEST_TIME,
  NIGHTLY_TEST_SETTINGS_KEY,
  NIGHTLY_TEST_TIMEOUT_MS,
  classifyNightlyRun,
  createNightlyTestExecutor,
  newNightlyFailures,
  nightlyBacklogEntries,
  nightlyError,
  type NightlyExecution,
  type NightlyRunSummary,
  type NightlyTestExecutor,
  type TestFailure,
} from "./nightly-tests.js";
import {
  CurationRunStore,
  type CurationActor,
  type CurationKind,
  type CurationListQuery,
  type CurationRunSummaryView,
  type CurationRunView,
  type CurationTrigger,
} from "./curation-runs.js";
import { curationCompletionMessage, curationReportFailure, summarizeCurationReport } from "./curation-summary.js";
import { reviewLimits } from "./review-limits.js";
import { dependencySummarySettings } from "./dependency-summary-settings.js";
import {
  DependencySummarySettingsValidationError,
  DEPENDENCY_SUMMARY_SETTINGS_KEY,
  validateDependencySummarySettings,
  type DependencySummarySettings,
} from "../../shared/dist/dependency-summary-settings.js";
import { remakeLimits } from "./remake-limits.js";
import { progressGuard } from "./progress-guard.js";
import { metricsRuleCandidates, proposeFromMetrics } from "./learning-metrics.js";
import { learningMetrics } from "./learning-metrics-settings.js";
import {
  PROGRESS_GUARD_SETTINGS_KEY,
  ProgressGuardSettingsValidationError,
  validateProgressGuardSettings,
  type ProgressGuardSettings,
} from "../../shared/dist/progress-guard-settings.js";
import { evaluateRemakeGate } from "./remake-gate.js";
import { lineageUsage } from "./task-lineage.js";
import { remakeLimitBrief, type RemakeLimitReason } from "./decision-brief.js";
import {
  RemakeLimitSettingsValidationError,
  REMAKE_LIMIT_SETTINGS_KEY,
  validateRemakeLimitSettings,
  type RemakeLimitSettings,
} from "../../shared/dist/remake-limit-settings.js";
import { reviewRouting, workVerification } from "./assurance-settings.js";
import { evaluatePlanQuality, formatPlanQualityReason, planQualityOutcome, type PlanQualityOutcome, type PlanQualityWarning, type PreviousOutputFeedback } from "./plan-quality.js";
import { planQualitySettings } from "./plan-quality-settings.js";
import { projectInvestigationOutputSettings } from "./project-investigation-settings.js";
import {
  PlanQualitySettingsValidationError,
  PLAN_QUALITY_SETTINGS_KEY,
  validatePlanQualitySettings,
  type PlanQualitySettings,
} from "../../shared/dist/plan-quality-settings.js";
import {
  ReviewRoutingSettingsValidationError,
  REVIEW_ROUTING_SETTINGS_KEY,
  validateReviewRoutingSettings,
  type ReviewRoutingSettings,
} from "../../shared/dist/review-routing-settings.js";
import { reviewMetrics, type ReviewMetrics } from "./review-metrics.js";
import {
  ReviewLimitSettingsValidationError,
  REVIEW_LIMIT_SETTINGS_KEY,
  validateReviewLimitSettings,
  type ReviewLimitSettings,
} from "../../shared/dist/review-limit-settings.js";
import { PlanUsageService } from "./plan-usage/service.js";
import { PlanUsageStore } from "./plan-usage/store.js";
import {
  DEFAULT_PLAN_USAGE_SETTINGS,
  PLAN_USAGE_SETTINGS_KEY,
  PlanUsageSettingsValidationError,
  readPlanUsageSettings,
  validatePlanUsageSettings,
  type PlanUsageSettings,
  type PlanUsageView,
} from "../../shared/dist/plan-usage-settings.js";
import type { PlanUsageSnapshot, PlanUsageSource } from "../../shared/dist/plan-usage.js";
import {
  DEFAULT_KNOWLEDGE_AUTOMATION_SETTINGS,
  KNOWLEDGE_AUTOMATION_SETTINGS_KEY,
  KnowledgeAutomationValidationError,
  readKnowledgeAutomationSettings as parseKnowledgeAutomationSettings,
  validateKnowledgeAutomationSettings,
  type KnowledgeAutomationSettings,
  type KnowledgeAutomationSnapshot,
} from "@owl/shared";
import { CHILD_RUN_SETTINGS_KEY, HYBRID_MODE_SETTINGS_KEY } from "./types";
import { CoreActivityRegistry } from "./core-activity.js";
import { GitWorktreeGateway } from "./git-gateway.js";
import { defaultOwlRoot, safeSegment, WorkspaceLayout } from "./workspace-layout.js";
import { parseVerificationMarker, WorkspaceProcessSweeper, type SweepRunInfo, type WorkspaceActivity } from "./workspace-process-sweeper.js";
import { WorkspaceTooling, runCommand } from "./workspace-tooling.js";
import { DEFAULT_POST_MERGE_DEPENDENCY_FILES, POST_MERGE_COMMAND_TIMEOUT_MS, PostMergeCommandQueue, postMergeResultEvent, redactArgv, type PostMergeRunOutcome, type ResolvedPostMergeCommand } from "./post-merge-command.js";
import { AgentWorkspacePreparer, withWorkspacePreparation, worktreeHarnesses } from "./agent-workspace-preparer.js";
import { redactCredentials } from "./git-push.js";
import { recoverOrphanedState } from "./startup-recovery.js";
import { cleanupWorkForDeletion, reconcileWorktrees, type WorktreeReconcileFailure } from "./worktree-reconciler.js";
import { processIdentityMatches, readProcessIdentity } from "./process-identity.js";
import { formatRuntimeFailure } from "./error-display.js";
import { ADVISOR_TEXT, workRef } from "./advisor-text.js";
import { INSTRUCTION_REPLY_TEXT, type ReplanSummary } from "./instruction-reply-text.js";
import { ownerGuidance } from "./owner-guidance.js";
import { failedTaskBrief, pendingAcceptanceDefect, pendingExternalBlocker } from "./task-context.js";
import { planContextFields } from "./context-builder.js";
import { detectProcessSkillsPack, type DetectedProcessSkillsPack } from "./process-skills-pack.js";
import { ResearchRecorder, type ResearchAttributionRole } from "./research-recorder.js";
import { buildTokenUsageReport } from "./token-usage-report.js";
import type { TokenUsagePeriod, TokenUsageReport } from "../../shared/dist/token-usage-report.js";
import { RESEARCH_CAPTURE_ROLES } from "../../shared/dist/permission-args.js";
import {
  ADVISOR_WORK_OPERATION_ACTION_TYPES,
  isAdvisorWorkOperationType,
  type AdvisorWorkOperationType,
} from "../../shared/dist/advisor-response.js";
import {
  BACKLOG_STATUSES,
  applyAdvisorBacklogInTransaction,
  detachWorkBacklogOnDeleteInTransaction,
  deleteBacklogItemsInTransaction,
  dismissBacklogItemsInTransaction,
  issueBacklogWorkInTransaction,
  linkBacklogItemsToWorkInTransaction,
  listBacklogItems,
  listInProgressBacklogItemsOfWork,
  registerNightlyTestBacklogInTransaction,
  releaseWorkBacklogInTransaction,
  type BacklogListFilter,
  type BacklogListResult,
  type DeleteBacklogItemsData,
  type DismissBacklogItemsData,
  type DismissBacklogItemsPayload,
  type IssueBacklogWorkData,
  type IssueBacklogWorkPayload,
  type LinkBacklogItemsData,
  type LinkBacklogItemsPayload,
} from "./review-backlog.js";

import {
  ADVISOR_CURATION_ACTION_TYPES,
  ADVISOR_CURATION_INSTRUCTION,
  addAdvisorReplyTargetInstruction,
  advisorCurationKind,
  builtinProviderHarness,
  CHILD_RUN_EFFORTS,
  CHILD_RUN_PROVIDERS,
  CODEX_BUILTIN_MODELS,
  DEFAULT_CHILD_RUN_SETTINGS,
  DEFAULT_HARNESS_MODELS,
  DEFAULT_ROLE_MODELS,
  PROJECT_LOCKING_WORK_STATES,
  designDocumentPath,
  taskReportPath,
  isRuleRole,
  parseSlackAdvisorResponse,
  PROCESS_SKILLS_INSTALL_COMMANDS,
  PROCESS_SKILLS_PROMPT_FILES,
  PROCESS_SKILLS_SETTINGS_KEY,
  usageJson,
  workSummaryInstruction,
  type ProcessSkillsSettings,
  type GuardTokenAgent,
  type WebResearchCapture,
  type ChildDispatchRequest,
  type ChildDispatchResponse,
  type ChildRunListFilter,
  type ChildRunRecord,
  type ChildRunSettings,
  type ChildWaitRequest,
  type ChildWaitResponse,
} from "@owl/shared";
import { buildAdvisorProjectCatalogInstruction } from "./advisor-project-context";
import { buildAdvisorWorkCatalogInstruction } from "./advisor-work-context";
import { createProviderPauseStore, type ProviderPauseRow, type ProviderPauseStore } from "./provider-pause-store";
import { createProviderPauseController, rethrowUnlessRateLimited, type ProviderPauseController, type ProviderPauseEvent } from "./provider-pause-controller";
// Imported from the agent-runtime "types" submodule (not the package barrel) for the
// same reason advisor-runtime.ts does: the barrel re-exports core-contract.d.ts, which
// imports back from "../../core/dist/types.js" and trips TS5055 mid-compile.
import { coreTestRunBrief } from "./core-test-run";
import { QUARANTINE_FIX_TASK_PREFIX } from "./test-quarantine";
import type { BaseMergeConflict, ManagerTrigger, WorkerQuestion } from "@owl/shared";
import { acceptanceCriteriaProblems, formatAdvisorMalformed, parseTaskNecessity, readStoredAcceptanceCriteria, renderAcceptanceCriteria, renderTaskNecessity, type AcceptanceCriterion, type TaskPlanContext, resolveInstanceId, type AdvisorSuggestedAction, type ProcessSkillsInstallCommand, type ProviderClient } from "@owl/shared";
import { MEMORY_FOLDER_KINDS_SETTINGS_KEY, MEMORY_LIBRARIAN_BATCH_SETTINGS_KEY, MEMORY_LIBRARIAN_SETTINGS_KEY, MEMORY_MODE_SETTINGS_KEY, MEMORY_RECALL_LIMIT_SETTINGS_KEY, MEMORY_RECALL_MIN_SIMILARITY_SETTINGS_KEY, MemorySettingsValidationError, readMemoryFolderKinds, readMemoryLibrarian, readMemoryLibrarianBatch, readMemoryMode, readMemoryRecallLimit, readMemoryRecallMinSimilarity, validateMemoryFolderKinds, validateMemoryLibrarian, type MemoryFolderKinds, type MemoryLibrarian, type MemoryLibrarianBatch, type MemoryMode } from "@owl/shared";
import { MEMORY_ARCHIVE_SETTINGS_KEY, readMemoryArchive, REVIEW_RERUN_OPTION_KEY } from "@owl/shared";
import { validateTestRunSettings } from "../../shared/dist/test-run-settings.js";
import { readTestPolicy, validateTestPolicy } from "../../shared/dist/test-policy.js";
import { resolveTestRun } from "./test-detection.js";
import { matchDeniedCommand, reviewerDeniedCommands, REVIEWER_TEST_COMMAND_DENIED_MESSAGE, type ReviewerTestCommandCheck } from "./reviewer-test-guard.js";
import { createChildRunScheduler, type ChildRunScheduler } from "./child-run-scheduler.js";
import { defaultExecutorRuntime } from "./executor.js";
import type {
  AgentListQuery,
  AgentRun,
  AgentsViewActivity,
  AgentsViewData,
  BacklogViewData,
  BoardViewData,
  DecisionViewData,
  LinkableWorksData,
  TokensViewData,
  WorkViewData,
  AgentRunResult,
  CancelAgentPayload,
  CanonicalEventFrame,
  CommandRequest,
  CommandResponse,
  ConversationHint,
  CoreDatabase,
  CoreOptions,
  CoreStatus,
  CoreWriteLaneTransaction,
  CreateProjectPayload,
  DeleteProjectPayload,
  DeleteProjectResult,
  CreateModelPresetPayload,
  CreateWorkData,
  CreateWorkPayload,
  Decision,
  DecisionListQuery,
  EventHandler,
  JsonObject,
  ListResponse,
  Message,
  MessageListQuery,
  ModelPreset,
  PauseWorkPayload,
  PostMessagePayload,
  InboundMessagePayload,
  InboundUploadCompletePayload,
  InboundUploadCompleteResult,
  InboundUploadContentResult,
  InboundUploadBytes,
  InboundUploadRegisterPayload,
  InboundUploadTicket,
  Project,
  TestRunStatus,
  ProjectDeletionImpact,
  ProjectListQuery,
  ProjectRunningWork,
  UpdateProjectPayload,
  RoleModelSetting,
  RoleModelSettingInput,
  ProcessSkillsSettingsSnapshot,
  StartWorkPayload,
  TaskDetail,
  TaskListQuery,
  TaskPlanItem,
  TaskRow,
  TaskState,
  UpdateWorkData,
  UpdateWorkPayload,
  WorkState,
  ResumeWorkOrRetryData,
  ResumeWorkOrRetryPayload,
  TaskPrerequisiteView,
  TaskSummary,
  UpdateModelSettingsPayload,
  UpdateModelPresetPayload,
  VerificationCommand,
  WorkAdvisorBacklog,
  WorkDetail,
  WorkProgress,
  WorkListQuery,
  WorkRow,
  WorkSummary,
  AdvisorRunRequest,
  AdvisorRunResult,
  WorkflowSnapshot,
  GitGateway,
  WorktreeCleanupResult,
  GitPushFailure,
  GitPushResult,
  GitWorkMergeResult,
  WorkBranchVerification,
} from "./types";

const KNOWLEDGE_READ_METHODS = new Set<PropertyKey>(["resolveFilename", "search", "list", "get"]);
const KNOWLEDGE_WRITE_METHODS = new Set<PropertyKey>([
  "ensureDirectories", "create", "upsert", "update", "remove", "upsertBySource",
]);

type PushAlertKind = "work_push_failed" | "work_push_blocked_by_hook" | "work_push_skipped_no_upstream";

function advisorWorkKeyForType(type: AdvisorWorkOperationType): string {
  switch (type) {
    case "send_work_instruction": return "instruction";
    case "update_work": return "update";
    case "pause_work": return "pause";
    case "resume_work": return "resume";
    case "cancel_work": return "cancel";
    case "delete_work": return "delete";
  }
}

function advisorWorkTypeForKey(key: string): AdvisorWorkOperationType | null {
  switch (key) {
    case "instruction": return "send_work_instruction";
    case "update": return "update_work";
    case "pause": return "pause_work";
    case "resume": return "resume_work";
    case "cancel": return "cancel_work";
    case "delete": return "delete_work";
    default: return null;
  }
}

function pushAlertText(
  language: OwnerLanguage,
  kind: PushAlertKind,
  detail: { readonly base_branch: string; readonly remote: string | null; readonly remote_branch: string | null; readonly push_failure: GitPushFailure | null; readonly hook_side: "local" | "remote" | null },
): { readonly message: string; readonly remediation: string } {
  const base = detail.base_branch;
  const target = `${detail.remote ?? "remote"}/${detail.remote_branch ?? "branch"}`;
  if (language === "ja") {
    if (kind === "work_push_skipped_no_upstream") return {
      message: `ベースブランチ ${base} に上流ブランチが設定されていないため、自動pushをスキップしました。`,
      remediation: `git branch --set-upstream-to=<remote>/<branch> ${base} で上流を設定するか、Projectの自動pushをオフにしてください。`,
    };
    if (kind === "work_push_blocked_by_hook") return detail.hook_side === "remote" ? {
      message: `リモート側のフックがベースブランチ ${base} の ${target} へのpushを拒否しました。`,
      remediation: "リモートのルールを確認し、該当コミットを直してから手動でpushしてください。",
    } : {
      message: `pushフックがベースブランチ ${base} の ${target} へのpushを拒否しました。`,
      remediation: "非公開の語が含まれていないか確認し、該当コミットを直してから手動でpushしてください。詳細はターミナルで git push を実行すると表示されます。",
    };
    if (detail.push_failure === "non_fast_forward") return {
      message: `ベースブランチ ${base} を ${target} にpushできませんでした。リモートに手元にないコミットがあり、fast-forwardできません。`,
      remediation: "リモートの変更を取り込んでから手動でpushしてください。force pushは使わないでください。",
    };
    if (detail.push_failure === "network") return {
      message: `ベースブランチ ${base} を ${target} にpushできませんでした。ネットワークまたはリモートに接続できません。`,
      remediation: "接続を確認して手動でpushしてください。次のWork完了時にも自動でpushを試みます。",
    };
    if (detail.push_failure === "auth") return {
      message: `ベースブランチ ${base} を ${target} にpushできませんでした。リモートの認証に失敗しました。`,
      remediation: "Gitの認証情報（SSH鍵や資格情報ヘルパー）を確認してから手動でpushしてください。",
    };
    return { message: `ベースブランチ ${base} の自動pushに失敗しました。`, remediation: "Owlのログを確認し、必要なら手動でpushしてください。" };
  }
  if (kind === "work_push_skipped_no_upstream") return {
    message: `Skipped automatic push: base branch ${base} has no upstream branch.`,
    remediation: `Set one with git branch --set-upstream-to=<remote>/<branch> ${base}, or turn off automatic push for this Project.`,
  };
  if (kind === "work_push_blocked_by_hook") return detail.hook_side === "remote" ? {
    message: `A remote hook rejected pushing base branch ${base} to ${target}.`,
    remediation: "Check the remote's rules, fix the commits, then push manually.",
  } : {
    message: `A push hook rejected pushing base branch ${base} to ${target}.`,
    remediation: "Check for private words, fix the commits, then push manually. Run git push in a terminal to see the details.",
  };
  if (detail.push_failure === "non_fast_forward") return {
    message: `Could not push base branch ${base} to ${target}: the remote has commits that are not here, so it cannot fast-forward.`,
    remediation: "Integrate the remote changes, then push manually. Do not force push.",
  };
  if (detail.push_failure === "network") return {
    message: `Could not push base branch ${base} to ${target}: the remote could not be reached.`,
    remediation: "Check the connection and push manually. Owl will try again when the next Work completes.",
  };
  if (detail.push_failure === "auth") return {
    message: `Could not push base branch ${base} to ${target}: authentication with the remote failed.`,
    remediation: "Check your Git credentials (SSH key or credential helper), then push manually.",
  };
  return { message: `Automatic push of base branch ${base} failed.`, remediation: "Check the Owl log and push manually if needed." };
}

// No provider CLI detection lives in this package, so every harness's install command is always shown.
const PROCESS_SKILLS_INSTALL_COMMAND_LIST: readonly ProcessSkillsInstallCommand[] = (["claude", "codex"] as const).map(
  (harness) => ({ harness, command: PROCESS_SKILLS_INSTALL_COMMANDS[harness] }),
);

interface WorktreeReconcileOutcome {
  readonly verified: boolean;
  readonly failures: readonly WorktreeReconcileFailure[];
  readonly error_message?: string;
}

export interface ProviderPauseView {
  readonly provider: string;
  readonly label: string;
  readonly state: "paused" | "probing";
  readonly paused_at: string;
  readonly resume_at: string;
  readonly resume_source: "reported" | "backoff";
  readonly reported_resets_at: string | null;
  readonly backoff_step: number;
  readonly last_error: string | null;
  readonly last_role: string | null;
}

function toProviderPauseView(row: ProviderPauseRow): ProviderPauseView | null {
  if (row.state === "active" || row.resume_at === null) return null;
  return {
    provider: row.provider,
    label: row.provider === "anthropic" ? "Claude" : row.provider === "openai" ? "Codex" : row.provider,
    state: row.state,
    paused_at: row.paused_at!,
    resume_at: row.resume_at,
    resume_source: row.resume_source!,
    reported_resets_at: row.reported_resets_at,
    backoff_step: row.backoff_step,
    last_error: row.last_error,
    last_role: row.last_role,
  };
}

interface StoredIdempotencyRow {
  request_hash: string;
  response_json: string;
}

interface CommandMutation<D extends JsonObject> {
  readonly data: D;
  readonly version: number;
}

interface WorkDbRow {
  id: string;
  display_number: number | null;
  title: string;
  state: WorkDetail["state"];
  state_version: number;
  updated_at: string;
  archived_at: string | null;
  owner_id: string;
  project_id: string | null;
  summary: string;
  size: WorkDetail["size"];
  design_mode: "auto" | "lead";
  plan_revision: number;
}

interface WorkDetailDbRow extends WorkDbRow {
  total_tasks: number;
  completed_tasks: number;
  conversation_id: string | null;
  advisor_backlog_json: string | null;
}

interface TaskDbRow {
  id: string;
  work_id: string;
  title: string;
  status: TaskState;
  type: string;
  state_version: number;
  updated_at: string;
  created_at: string;
  depends_on_json: string;
  prerequisite_json: string | null;
  prerequisite_since: string | null;
  stop_reason: string | null;
  parent_task_id: string | null;
  acceptance: string;
  review_round: number;
  total_review_attempts: number;
  failure_count: number;
  worker_generation: number;
}

interface DecisionDbRow {
  id: string;
  work_id: string;
  scope: "task" | "work";
  status: "open" | "resolved" | "cancelled";
  blocked_task_ids_json: string;
  reason: string;
  question: string;
  current_state: string;
  tried: string;
  options_json: string;
  recommended: string | null;
  allow_free_text: number;
  state_version: number;
  design_block_json?: string | null;
}

interface AgentDbRow {
  id: string;
  work_id: string | null;
  task_id: string | null;
  role: string;
  design_tier: "standard" | "lead" | null;
  provider: string;
  model: string;
  effort: string | null;
  status: string;
  outcome: string | null;
  pid: number | null;
  started_at: string | null;
  ended_at: string | null;
  last_output_at: string | null;
  parent_agent_id: string | null;
  phase: string | null;
  subtask_count: number | null;
  label: string | null;
  origin: string | null;
}

interface ProjectDbRow {
  id: string;
  name: string;
  canonical_path: string;
  base_branch: string;
  auto_push: number;
  allowed_roots_json: string;
  verification_plan_json: string;
  worktree_prepare_argv_json: string;
  worktree_refresh_argv_json: string;
  post_merge_argv_json: string | null;
  post_merge_install_argv_json: string | null;
  required_test_argv_json: string | null;
  test_run_json: string | null;
  test_run_detected_json: string | null;
  test_policy_json: string | null;
}

interface MessageDbRow {
  id: string;
  conversation_id: string;
  provider: string;
  source_message_id: string | null;
  body: string;
  attachment_ids_json: string;
  created_at: string;
  received_at?: string;
  metadata_json?: string | null;
}

interface StoredModelSettingsValue extends JsonObject {
  readonly schema_version: string;
  readonly version: number;
  readonly roles: readonly RoleModelSetting[];
}

interface StoredModelPresetsValue extends JsonObject {
  readonly schema_version: string;
  readonly version: number;
  readonly presets: readonly ModelPreset[];
}

/** The public Core implementation consumed by REST/WS and agent-runtime. */
export class Core {
  private readonly db: CoreDatabase;
  private readonly writeLane;
  private readonly coreActivity: CoreActivityRegistry;
  private readonly providerPauseStore: ProviderPauseStore;
  private readonly providerPauseController: ProviderPauseController;
  private readonly childRuns: ChildRunScheduler;
  private readonly options: CoreOptions;
  private readonly git: GitGateway;
  private readonly workflow: WorkflowEngine;
  private readonly dispatcher: EventDispatcher;
  private readonly workDriver: WorkDriver;
  private readonly decisions: DecisionService;
  private readonly subscribers = new Set<EventHandler>();
  /**
   * Works with a Manager replan in progress. Owner answers that should drive
   * a replan are persisted (ownerReplanKey) so they survive a restart.
   */
  private readonly replansInFlight = new Set<string>();
  /** Last gate-failure message already reported per Work, so a persisting failure is announced once. */
  private readonly loopGateFailures = new Map<string, string>();
  /** When each prerequisite wait was last evaluated (memory only, so a restart evaluates at once). */
  private readonly prerequisiteCheckedAt = new Map<string, number>();
  /** Works whose waiting Tasks must be evaluated on the next tick regardless of the interval. */
  private readonly prerequisiteRecheck = new Set<string>();
  /** Wake keys already sent, so a finished source does not wake its waiters on every tick. */
  private readonly prerequisiteWoken = new Set<string>();
  private readonly logger: Pick<Console, "warn"> = { warn: (message) => console.warn(message) };
  private readonly owlRoot: string;
  private readonly postMergeCommands: PostMergeCommandQueue;
  private readonly postMergeInstallDefault: readonly string[];
  private readonly postMergeDependencyFiles: readonly string[];
  private readonly postMergeOwlRootDefault: readonly string[];
  private readonly dataDir: string;
  private readonly workspaceLayout: WorkspaceLayout;
  private readonly knownModels: KnownModels;
  public readonly knowledge: KnowledgeBase;
  private readonly knowledgeLocation: KnowledgeLocation;
  private readonly knowledgeNotes: KnowledgeNotes;
  private readonly projectOverviews: ProjectOverviewService;
  /** The page-index injector; every injection site goes through it. */
  private readonly memoryInjector: IndexInjector;

  /** Records that an Advisor session was shown this index/page version (T7's MCP calls it);  */
  public noteMemoryShown(sessionId: string, path: string): void { this.memoryInjector.noteShown(sessionId, path); }
  // memory (stage ①-1)
  private readonly memory: MemoryService;
  private readonly projectReader: ProjectSourceReader;
  private readonly overviewRuns = new Set<Promise<unknown>>();
  private readonly worktreeReconciles = new Set<Promise<unknown>>();
  private investigationTail: Promise<unknown> = Promise.resolve();
  private investigationPending = 0;
  private readonly investigationQueued = new Map<string, "queued" | "running">();
  private readonly investigationFailures = new Map<string, { until: number; count: number }>();
  public readonly ruleStore: RuleStore;
  public readonly skillBox: SkillBox;
  private processSkillsPack: DetectedProcessSkillsPack | null = null;
  private processSkillsMissingLogged = false;
  public readonly skillCurator: SkillCurator;
  public readonly advisorSessions: AdvisorSessionManager;
  public readonly memorySaver: MemorySaver;
  private readonly pageRouter: PageRouter;
  private readonly pageLibrarian: PageLibrarian;
  private readonly librarianScheduler: LibrarianScheduler;
  private readonly nightlyScheduler: LibrarianScheduler;
  private readonly nightlyExecutor: NightlyTestExecutor;
  private readonly nightlyAbort = new AbortController();
  private nightlyRun: Promise<NightlyRunSummary[]> | null = null;
  private nightlyScheduledDay: string | null = null;
  private readonly curationRuns: CurationRunStore;
  private readonly planUsageService: PlanUsageService;
  private readonly activeCurations = new Map<CurationKind, Promise<unknown>>();
  /** Kinds whose background start is between the running-check and the curation_runs insert. */
  private readonly pendingCurationKeys = new Map<string, Promise<CurationRunView>>();
  private readonly researchRecorder: ResearchRecorder;
  private readonly learningJobs: LearningJobs;
  private readonly ruleProposals: RuleProposals;
  private readonly learningPipeline: LearningPipeline;
  private readonly learningPipelineDebounceMs: number;
  private readonly advisorRuntime: AdvisorSessionRuntime | null;
  private advisorKeepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastAdvisorResidentError: string | null = null;
  /** Consecutive failed keep-alive bring-ups, and the earliest time the next unforced one may run. */
  private advisorResidentFailures = 0;
  private advisorResidentRetryAt = 0;
  private advisorResidentSession: { id: string; upAt: number } | null = null;
  private skillTimer: ReturnType<typeof setInterval> | null = null;
  private workspaceSweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly workspaceSweeper: WorkspaceProcessSweeper;
  private learningTimer: ReturnType<typeof setInterval> | null = null;
  private learningTask: Promise<void> = Promise.resolve();
  private skillReconcilePromise: Promise<void> = Promise.resolve();
  private started = false;
  /** Set when pages could not be opened (archive or first scan failed): pages reads and saves stay off in this Core. */
  private pagesFault: string | null = null;
  /** The last rule reload failure the Owner was told about; null when rules are healthy. */
  private rulesFailureSignature: string | null = null;

  public constructor(options: CoreOptions) {
    if (!options.db || !options.agentRunner || typeof options.version !== "string" || options.version.length === 0) {
      throw validationError("Core requires db, agentRunner, and a non-empty version.", { fields: ["db", "agentRunner", "version"] });
    }
    this.options = options;
    // LearningPipeline and SkillCurator share the same initial debounce.
    this.learningPipelineDebounceMs = Number.isSafeInteger(options.skillCuratorDebounceMs)
      && (options.skillCuratorDebounceMs ?? -1) >= 0
      ? options.skillCuratorDebounceMs as number
      : SKILL_CURATOR_DEBOUNCE_MS;
    this.knownModels = options.knownModels ?? defaultKnownModels;
    this.db = options.db;
    this.writeLane = options.db.createWriteLane();
    this.coreActivity = new CoreActivityRegistry({
      write: (event) => this.writeLane.write({
        mutateState: () => undefined,
        event: { id: createUlid(), idempotencyKey: event.idempotencyKey, type: event.type, workId: event.workId, payload: event.payload as JsonObject },
        outbox: [{ provider: "websocket" }],
      }).then(() => undefined),
    });
    this.providerPauseStore = createProviderPauseStore(options.db, options.now);
    this.providerPauseController = createProviderPauseController({
      store: this.providerPauseStore,
      now: options.now,
      emitEvent: (event) => this.emitProviderPauseEvent(event),
      onResume: async (provider) => {
        this.workflow.resumeProvider(provider);
        this.childRuns.pump();
        await this.advisorRuntime?.resumeProvider(provider);
        for (const work of this.db.all<{ id: string }>("SELECT id FROM works WHERE state = 'running'")) {
          this.workDriver.wake(work.id);
        }
      },
    });
    this.childRuns = createChildRunScheduler({
      db: options.db,
      executorRuntime: () => options.executorRuntime?.() ?? defaultExecutorRuntime(),
      providerPauseController: this.providerPauseController,
      settings: () => this.getChildRunSettings(),
      onParentActivity: (agentRunId) => {
        void this.writeLane.transact((tx) => {
          const now = utcNow();
          tx.run(
            `UPDATE agent_runs SET last_output_at = ?, updated_at = ?
              WHERE id = ? AND role = 'worker' AND status IN ('launch_pending','spawned','running')`,
            now, now, agentRunId,
          );
          return agentRunId;
        }).catch((error) => console.error(`[owl-core] Failed to update Worker activity ${agentRunId}`, error));
      },
    });
    this.decisions = new DecisionService(options.db);
    this.owlRoot = options.owlRoot ?? defaultOwlRoot();
    this.dataDir = options.dataDir ?? join(this.owlRoot, "data");
    this.postMergeOwlRootDefault = options.postMergeCommand?.owlRootDefault ?? ["pnpm", "build"];
    this.postMergeInstallDefault = options.postMergeCommand?.installDefault ?? ["pnpm", "install"];
    this.postMergeDependencyFiles = options.postMergeCommand?.dependencyFiles ?? DEFAULT_POST_MERGE_DEPENDENCY_FILES;
    this.postMergeCommands = new PostMergeCommandQueue({
      run: runCommand,
      timeoutMs: options.postMergeCommand?.timeoutMs ?? POST_MERGE_COMMAND_TIMEOUT_MS,
      resolve: (projectId) => this.resolvePostMergeCommand(projectId),
      record: (outcome) => this.recordPostMergeOutcome(outcome),
      log: (message, error) => console.warn(`[owl-core] ${message}`, error),
    });
    this.workspaceLayout = new WorkspaceLayout(options.workspacesRoot ?? resolve(this.owlRoot, ".owl-workspaces"), resolve(this.owlRoot, ".owl-workspaces"));
    this.git = options.git ?? new GitWorktreeGateway(options.db, this.owlRoot, undefined, this.dataDir, this.workspaceLayout);
    this.knowledgeLocation = new KnowledgeLocation({
      owlRoot: this.owlRoot,
      dataDir: this.dataDir,
      persistence: options.knowledgeStorage,
      now: options.now,
      onAvailable: () => this.onKnowledgeStorageAvailable(),
      // memory (stage ①-1)
      onUnavailable: () => this.memory?.onStorageUnavailable(),
      onSwitched: () => { this.knowledgeNotes.resetCache(); void Promise.resolve().then(() => this.memory?.onStorageSwitched()).catch((error) => console.warn("[owl-core] memory index could not follow the storage switch", error)); },
    });
    const knowledgeBase = new KnowledgeBase(this.owlRoot, {
      rootDir: () => this.knowledgeLocation.activeDir(),
      requireRoot: () => this.knowledgeLocation.hasEverBeenAvailable(),
      searcher: (query, tags) => this.memory?.searchKnowledgeCompat(query, tags) ?? Promise.resolve(null),
      pageGuard: (content) => assertValidPage(content),
    });
    this.knowledge = new Proxy(knowledgeBase, {
      get: (target, property, receiver) => {
        const member = Reflect.get(target, property, receiver);
        const lease = KNOWLEDGE_READ_METHODS.has(property)
          ? "read"
          : KNOWLEDGE_WRITE_METHODS.has(property) ? "write" : null;
        if (!lease || typeof member !== "function") return member;
        return (...args: unknown[]) => {
          const operation = () => Reflect.apply(member, target, args) as Promise<unknown>;
          if (lease === "read") return this.knowledgeLocation.withRead(operation);
          // memory (stage ①-1): a successful write is reflected in the index shortly after
          return this.knowledgeLocation.withWrite(operation).then((value) => { this.memory?.notifyChanged(); return value; });
        };
      },
    });
    this.workspaceSweeper = new WorkspaceProcessSweeper({
      listWorkspaces: () => this.git.listWorkspaces(),
      activity: () => this.workspaceActivity(),
      instanceId: resolveInstanceId(this.dataDir),
      runs: (ids) => this.sweepRunInfo(ids),
    });
    if (this.git instanceof GitWorktreeGateway) {
      this.git.onBeforeWorktreeRemoval(async (path) => { await this.workspaceSweeper.sweep({ path }); });
      this.git.onCoreActivity(this.coreActivity.report);
    }
    this.researchRecorder = new ResearchRecorder({
      knowledge: this.knowledge,
      gate: this.knowledgeLocation,
      isEnabled: () => this.readKnowledgeAutomationSettings().research_autosave,
      sourceLinkLimit: () => {
        const settings = this.readKnowledgeAutomationSettings();
        return { limit: settings.research_source_links ?? 0, max: settings.research_source_links_max ?? 0 };
      },
      existingTagsLimit: () => this.readKnowledgeAutomationSettings().research_existing_tags_max,
      tagRange: () => {
        const { research_tags_min: min, research_tags_max: max } = this.readKnowledgeAutomationSettings();
        return { min: min ?? 0, max: max ?? 0 };
      },
      tagger: (request) => {
        const runner = this.options.agentRunner as { runClippingTags?: (request: unknown) => Promise<unknown> };
        if (typeof runner.runClippingTags !== "function") return Promise.resolve({ ok: false });
        return runner.runClippingTags({ ...request, model: this.memorySettings().memory_librarian, language: ownerLanguage(this.db) });
      },
      language: () => ownerLanguage(this.db),
      onFailure: (error, attribution) => this.recordBackgroundFailure("research_record_failed", error, {
        work_id: attribution.work_id, task_id: attribution.task_id,
        agent_run_id: attribution.agent_run_id, conversation_id: attribution.conversation_id,
      }),
    });
    this.knowledgeNotes = new KnowledgeNotes(this.knowledge, { now: options.now });
    this.projectReader = options.projectSourceReader ?? new GitProjectSourceReader();
    const pageStore = {
      knowledgeDir: () => this.knowledgeLocation.activeDir(),
      withWrite: <T>(fn: () => Promise<T>) => this.knowledgeLocation.withWrite(fn),
      onChanged: (paths: readonly string[]) => this.memory.notifyChanged(paths),
    };
    this.pageRouter = new PageRouter({
      ...pageStore,
      projectName: (projectId) => this.db.get<{ name: string }>("SELECT name FROM projects WHERE id = ?", projectId)?.name ?? null,
      now: options.now ? () => new Date(options.now!()) : undefined,
    });
    const routePage = this.pageRouter.route.bind(this.pageRouter);
    this.pageRouter.route = (input) => {
      if (this.pagesFault) throw new Error(`pages_unavailable: ${this.pagesFault}`);
      return routePage(input);
    };
    this.projectOverviews = this.createOverviewService(this.knowledgeNotes, (fn) => this.knowledgeLocation.withWrite(fn), true);
    // memory (stage ①-1)
    const embedderConfig = loadEmbedderConfig(this.dataDir);
    const memoryReadLedger = new MemoryReadLedger({ limits: () => this.memoryReadLimits() });
    this.memory = new MemoryService({
      dataDir: this.dataDir,
      dormantDays: () => this.memoryDormantDays(),
      sourceWorksUpdated: (projectId, numbers) => this.sourceWorksUpdated(projectId, numbers),
      integrationFailed: () => this.pageLibrarian.integrationFailed(),
      ledger: memoryReadLedger,
      onAdvisorPageShown: (sessionId, path) => this.noteMemoryShown(sessionId, path),
      embedder: new ChildEmbedder(embedderConfig),
      weights: embedderConfig.weights,
      profile: embedderConfig.profile,
      now: options.now ? () => new Date(options.now!()) : undefined,
      storage: {
        isAvailable: () => this.knowledgeLocation.isAvailable(),
        activeDir: () => this.knowledgeLocation.activeDir(),
        withRead: (operation) => this.knowledgeLocation.withRead(operation),
        withWrite: (operation) => this.knowledgeLocation.withWrite(operation),
        status: () => {
          const status = this.knowledgeLocation.status();
          return { available: status.state !== "unavailable", dir: status.path, since: status.state === "unavailable" ? status.checked_at : null };
        },
      },
      logger: { warn: (message, error) => console.warn(`[owl-core] ${message}`, error), info: (message) => console.info(`[owl-core] ${message}`) },
    });
    const indexInjector = new IndexInjector({
      index: this.memory.index,
      isAvailable: () => this.knowledgeLocation.isAvailable(),
      now: options.now ? () => new Date(options.now!()) : undefined,
      logger: { warn: (message, error) => console.warn(`[owl-core] ${message}`, error) },
      resetReads: (sessionId) => memoryReadLedger.reset(advisorKey(sessionId)),
      recall: new ResearchRecall({
        search: this.memory.searcher,
        index: this.memory.index,
        settings: () => this.memoryRecallSettings(),
        logger: { warn: (message, error) => console.warn(`[owl-core] ${message}`, error) },
      }),
    });
    this.memoryInjector = indexInjector;
    this.ruleStore = new RuleStore(this.owlRoot);
    this.skillBox = new SkillBox({
      db: this.db,
      owlRoot: this.owlRoot,
      now: options.now,
      onProposalsInserted: () => this.skillCurator.schedule(),
      onFeedbackRecorded: () => this.skillCurator.evaluateLifecycle(),
    });
    this.skillCurator = new SkillCurator({
      db: this.db,
      skillBox: this.skillBox,
      agentRunner: options.agentRunner,
      getTypesafeApiKey: options.getTypesafeApiKey,
      getModelConfig: () => resolveRoleModelFromDb(this.db, "curator"),
      composeKnowledge: (proposals) => this.memoryInjector.compose({ role: "curator", query: proposals.map((p) => JSON.stringify(p.payload)), project_id: proposals[0]?.project_id ?? null }),
      typeSafeJudge: options.skillCuratorTypeSafeJudge,
      now: options.now,
      debounce_ms: options.skillCuratorDebounceMs,
    });
    this.advisorSessions = new AdvisorSessionManager(this.db);
    const sessionProject = (conversationId: string): string | null => this.db.get<{ project_id: string | null }>(
      `SELECT work.project_id FROM conversations AS conversation JOIN works AS work ON work.id = conversation.work_id WHERE conversation.id = ?`,
      conversationId,
    )?.project_id ?? null;
    const conversationProject = (): string | null => this.db.get<{ project_id: string | null }>(
      `SELECT work.project_id FROM advisor_sessions AS session
         JOIN conversations AS conversation ON conversation.id = session.conversation_id
         JOIN works AS work ON work.id = conversation.work_id
        WHERE session.status IN ('starting','running','ending','suspended')
        ORDER BY session.created_at DESC LIMIT 1`,
    )?.project_id ?? null;
    this.memorySaver = new MemorySaver(this.knowledge, () => ownerLanguage(this.db), this.knowledgeLocation, {
      router: this.pageRouter,
      conversationProject,
    });
    const conversationLogs = new ConversationLogWriter({
      ...pageStore, router: this.pageRouter, project: (input) => sessionProject(input.conversationId),
      now: options.now ? () => new Date(options.now!()) : undefined,
    });
    const providerClient = options.providerClient as ProviderClient | undefined;
    if (providerClient?.createSession) {
      this.advisorRuntime = new AdvisorSessionRuntime({
        db: this.db,
        sessionManager: this.advisorSessions,
        memorySaver: this.memorySaver,
        conversationLog: { writer: conversationLogs },
        providerClient,
        owlRoot: this.owlRoot,
        git: this.git,
        getAdvisorSettings: () => this.getAdvisorSettingsSnapshot(),
        memoryInjector: this.memoryInjector,
        isProviderPaused: (provider) => this.providerPauseController.isPaused(provider),
        onProviderRateLimited: (provider, rateLimit) => this.providerPauseController.recordRateLimit({
          provider,
          resets_at: rateLimit.resets_at,
          role: "advisor",
          last_error_key: "rate_limited",
        }),
        onProviderSucceeded: async (provider, runStartedAt) => {
          await this.providerPauseController.noteProviderSucceeded(provider, runStartedAt);
        },
        resolveAttachmentPaths: (messageId) => this.resolveAttachmentPaths(messageId),
        onReply: (conversationId, reply, turnId, origin, suggestedActions, actionsMalformed) =>
          this.persistAdvisorReply(conversationId, reply, turnId, origin, suggestedActions, actionsMalformed),
        onError: (conversationId, errorMessage, turnId, origin) =>
          this.persistAdvisorError(conversationId, errorMessage, turnId, origin),
        onWebResearchFailed: (error, context) => {
          const conversation = this.db.get<{ work_id: string | null }>(
            "SELECT work_id FROM conversations WHERE id = ?", context.conversation_id,
          );
          this.recordBackgroundFailure("advisor_web_research_failed", new Error(error), {
            conversation_id: context.conversation_id, work_id: conversation?.work_id ?? null,
          });
        },
        onWebResearch: (capture, context) => {
          const conversation = this.db.get<{ work_id: string | null; work_title: string | null }>(
            `SELECT conversations.work_id, works.title AS work_title
               FROM conversations LEFT JOIN works ON works.id = conversations.work_id
              WHERE conversations.id = ?`,
            context.conversation_id,
          );
          void this.researchRecorder.record(capture, {
            role: "advisor",
            conversation_id: context.conversation_id,
            ...(conversation?.work_id ? { work_id: conversation.work_id, work_title: conversation.work_title } : {}),
          });
        },
      });
    } else {
      this.advisorRuntime = null;
    }
    this.pageLibrarian = this.createPageLibrarian();
    this.nightlyExecutor = options.nightlyTests?.executor ?? createNightlyTestExecutor({
      workspaceRoot: this.workspaceLayout.root,
      timeoutMs: options.nightlyTests?.timeoutMs ?? NIGHTLY_TEST_TIMEOUT_MS,
    });
    this.nightlyScheduler = new LibrarianScheduler({
      run: async () => {
        // A time change after today's run must not run the tests a second time the same day.
        const day = localDayKey(options.nightlyTests?.clock?.now() ?? new Date());
        if (this.nightlyScheduledDay === day) return;
        this.nightlyScheduledDay = day;
        await this.runNightlyTests();
      },
      clock: options.nightlyTests?.clock,
    });
    this.librarianScheduler = new LibrarianScheduler({
      run: async () => {
        if (!this.knowledgeLocation.isAvailable()) {
          console.warn("[owl-core] Skipping the scheduled Librarian run: the knowledge storage is unavailable");
          return null;
        }
        return this.runCuration({ kind: "librarian", trigger: "scheduled", actor: "system" });
      },
    });
    this.curationRuns = new CurationRunStore(this.db);
    const usageSources: { readonly claude?: PlanUsageSource | null; readonly codex?: PlanUsageSource | null } =
      options.planUsageSources === "default"
        ? { claude: createClaudeUsageSource(), codex: createCodexSessionLogSource() }
        : options.planUsageSources ?? {};
    this.planUsageService = new PlanUsageService({
      store: new PlanUsageStore(this.db),
      claude: usageSources.claude ?? null,
      codex: usageSources.codex ?? null,
      readSettings: () => this.readPlanUsageSettings(),
      now: () => new Date(options.now?.() ?? utcNow()),
    });
    this.learningJobs = new LearningJobs({ db: this.db, writeLane: this.writeLane, now: options.now });
    this.ruleProposals = new RuleProposals({
      db: this.db,
      writeLane: this.writeLane,
      ruleStore: this.ruleStore,
      ruleWriter: new RuleWriter(this.ruleStore, join(this.owlRoot, "rules")),
      notes: this.knowledgeNotes,
      now: options.now,
    });
    this.learningPipeline = new LearningPipeline({
      db: this.db,
      writeLane: this.writeLane,
      skillBox: this.skillBox,
      ruleProposals: this.ruleProposals,
      pages: {
        router: this.pageRouter,
        workLog: new WorkLogWriter({ ...pageStore, db: this.db }),
      },
      gate: this.knowledgeLocation,
      now: options.now,
      debounce_ms: this.learningPipelineDebounceMs,
    });
    const workspacePreparer = options.workspaceTooling
      ? new AgentWorkspacePreparer({
        db: this.db,
        writeLane: this.writeLane,
        tooling: new WorkspaceTooling({
          env: options.workspaceTooling.env,
          harnesses: () => worktreeHarnesses(this.db),
          home: options.workspaceTooling.home,
        }),
        emitAlert: (payload) => this.emitRulesAlert(payload),
        language: () => ownerLanguage(this.db),
      })
      : null;
    this.workflow = new WorkflowEngine({
      db: options.db,
      agentRunner: workspacePreparer ? withWorkspacePreparation(options.agentRunner, workspacePreparer) : options.agentRunner,
      onWorktreeCreated: workspacePreparer ? (worktreePath) => workspacePreparer.markCreated(worktreePath) : undefined,
      git: this.git,
      maxParallel: options.max_parallel,
      globalMaxParallel: options.dispatcher?.global_max_parallel,
      onTaskSettled: (workId) => this.onTaskSettled(workId),
      onTaskPipelineSettled: (workId, taskId) => {
        // sweep() never rejects and logs its own failures.
        void this.workspaceSweeper.sweep({ workId: safeSegment(workId), path: this.workspaceLayout.taskPath(workId, taskId) });
      },
      owlRoot: this.owlRoot,
      dataDir: this.dataDir,
      workspaceRoot: this.workspaceLayout.root,
      testCommandRunner: options.testCommandRunner,
      coreActivity: this.coreActivity.report,
      ruleStore: this.ruleStore,
      skillBox: this.skillBox,
      memoryInjector: this.memoryInjector,
      getProcessSkillsPack: () => this.processSkillsPack,
      staleCheckIntervalMs: options.dispatcher?.stale_check_interval_ms,
      providerPauseController: this.providerPauseController,
      childRuns: this.childRuns,
      onManagerReplanNeeded: (input) =>
        this.triggerManagerReplan(
          input.work_id,
          input.failed_task_ids,
          { kind: "task_failed", tasks: [input.trigger] },
          input.trigger.kind === "failure_threshold" && input.trigger.question !== null ? [{ task_id: input.trigger.task_id, question: input.trigger.question }] : [],
        ),
    });
    options.agentRunner.setProcessObserver?.((invocationId, processEvent) => {
      const pid = processEvent.pid;
      if (processEvent.type === "exited") {
        return this.writeLane.transact((transaction) => {
          const now = utcNow();
          transaction.run(
            `UPDATE agent_runs
                SET pid = NULL, process_start_time = NULL, process_cmdline_sha256 = NULL, updated_at = ?
              WHERE id = ? AND pid = ?
                AND status IN ('launch_pending','spawned','running','cancel_requested')`,
            now,
            invocationId,
            pid,
          );
        }).catch((error) => {
          console.error(`[owl-core] Failed to clear exited Agent process ${invocationId} (pid ${pid})`, error);
        });
      }
      const identity = readProcessIdentity(pid);
      return this.writeLane.write({
        mutateState: (transaction) => {
          const now = utcNow();
          transaction.run(
            `UPDATE agent_runs
                SET pid = ?, process_start_time = ?, process_cmdline_sha256 = ?,
                    status = CASE WHEN status IN ('launch_pending','spawned') THEN 'running' ELSE status END,
                    started_at = COALESCE(started_at, ?), last_output_at = COALESCE(last_output_at, ?), updated_at = ?
              WHERE id = ? AND status NOT IN ('completed','failed','spawn_failed','cancelled')`,
            pid,
            identity.process_start_time,
            identity.process_cmdline_sha256,
            now,
            now,
            now,
            invocationId,
          );
          return { invocation_id: invocationId, pid };
        },
        event: {
          idempotencyKey: `agent-started:${invocationId}:${pid}`,
          type: "agent.started",
          agentRunId: invocationId,
          payload: {
            agent_run_id: invocationId,
            pid,
            process_start_time: identity.process_start_time,
            process_cmdline_sha256: identity.process_cmdline_sha256,
          },
        },
        outbox: [{ provider: "websocket" }],
      }).then(() => undefined).catch((error) => console.error(`[owl-core] Failed to persist spawned Agent ${invocationId}`, error));
    });
    options.agentRunner.setPromptObserver?.((invocationId, { fingerprint, mode }) => {
      void this.writeLane.transact((transaction) => {
        transaction.run(
          `UPDATE agent_runs SET prompt_header_hash = ?, prompt_project_hash = ?, prompt_task_hash = ?,
             prompt_dynamic_hash = ?, prompt_mode = ? WHERE id = ?`,
          fingerprint.header, fingerprint.project, fingerprint.task, fingerprint.dynamic, mode, invocationId,
        );
      }).catch((error) => {
        console.error(`[owl-core] Failed to record the prompt fingerprint of ${invocationId}`, error);
      });
    });
    options.agentRunner.setOutputObserver?.((invocationId) => {
      void this.writeLane.transact((transaction) => {
        const now = utcNow();
        transaction.run(
          `UPDATE agent_runs SET last_output_at = ?, updated_at = ?
             WHERE id = ? AND status IN ('launch_pending','spawned','running')`,
          now,
          now,
          invocationId,
        );
        return { invocation_id: invocationId };
      }).catch((error) => console.error(`[owl-core] Failed to persist Agent output activity ${invocationId}`, error));
    });
    options.agentRunner.setOutputResubmitLimit?.(() => outputResubmitLimit(options.db));
    (options.agentRunner as typeof options.agentRunner & {
      setPlanUsageObserver?: (observer: (observation: PlanUsageSnapshot) => void) => void;
    }).setPlanUsageObserver?.((observation) => this.planUsageService.observe(observation));
    this.dispatcher = new EventDispatcher({
      db: options.db,
      onEvent: async (event) => {
        for (const subscriber of this.subscribers) {
          await subscriber(event);
        }
      },
    });
    this.workDriver = new WorkDriver({
      tick: async (workId) => this.tick(workId),
      getState: (workId) => {
        const state = this.db.get<Pick<WorkDbRow, "state">>("SELECT state FROM works WHERE id = ?", workId)?.state;
        // A Work waiting for a Decision is driven while an Owner request waits for the Manager.
        return state === "judgement_waiting" && this.hasQueuedOwnerReplan(workId) ? "running" : state;
      },
      onTickError: (workId, error) => this.recordTickFailure(workId, error),
      tickIntervalMs: options.dispatcher?.tick_interval_ms,
      maxConcurrent: options.dispatcher?.work_concurrency,
    });
  }

  public async recordSkillReads(input: {
    readonly agent_run_id: string;
    readonly tool_name: string;
    readonly tool_input: Readonly<Record<string, unknown>>;
    readonly cwd: string;
    readonly normalized_segments?: readonly (readonly string[])[];
  }): Promise<void> {
    const names = detectSkillReads({ owlRoot: this.owlRoot, ...input });
    if (names.length > 0) await this.skillBox.recordRead(input.agent_run_id, names);
  }

  /** Whether a Reviewer's shell command runs the Project's tests; a denial is recorded as reviewer.test_command_denied. */
  public async checkReviewerTestCommand(input: { readonly agent_run_id: string; readonly command: string }): Promise<ReviewerTestCommandCheck> {
    const row = this.db.get<{ task_id: string; work_id: string; worktree_path: string | null; project_id: string | null; canonical_path: string | null; test_run_json: string | null; test_run_detected_json: string | null; test_policy_json: string | null }>(
      `SELECT tasks.id AS task_id, tasks.work_id, tasks.worktree_path, projects.id AS project_id, projects.canonical_path,
              projects.test_run_json, projects.test_run_detected_json, projects.test_policy_json
         FROM agent_runs JOIN tasks ON tasks.id = agent_runs.task_id
         JOIN works ON works.id = tasks.work_id JOIN projects ON projects.id = works.project_id
        WHERE agent_runs.id = ? AND agent_runs.role = 'reviewer'`,
      input.agent_run_id,
    );
    if (!row || row.project_id === null || row.canonical_path === null) return { denied: false };
    const resolved = resolveTestRun({
      explicit_json: row.test_run_json,
      detected_json: row.test_run_detected_json,
      root: row.worktree_path ?? row.canonical_path,
      now: utcNow(),
      warn: (message) => console.warn(`[owl-core] ${message}`),
    });
    const matched = matchDeniedCommand(input.command, reviewerDeniedCommands(resolved.enabled ? resolved.settings : null, readTestPolicy(row.test_policy_json)));
    if (matched === null) return { denied: false };
    const matchedText = matched.join(" ");
    await this.writeLane.write({
      mutateState: () => ({}),
      event: {
        idempotencyKey: `reviewer-test-command-denied:${input.agent_run_id}:${createUlid()}`,
        type: "reviewer.test_command_denied",
        workId: row.work_id,
        taskId: row.task_id,
        payload: { schema_version: "1.0.0", agent_run_id: input.agent_run_id, task_id: row.task_id, command: input.command.slice(0, 500), matched: matchedText },
      },
      outbox: [{ provider: "websocket" }],
    });
    return { denied: true, matched: matchedText, message: REVIEWER_TEST_COMMAND_DENIED_MESSAGE };
  }

  public listSkills(filter: { query?: string; state?: string; scope?: string; trial?: boolean } = {}) {
    if (filter.state !== undefined && !isSkillState(filter.state)) {
      throw validationError("Skill state must be active, stale, or archived.", { field: "state" });
    }
    if (filter.scope !== undefined && !isValidSkillScope(filter.scope)) {
      throw validationError("Skill scope must be global or project:<id>.", { field: "scope" });
    }
    if (filter.query !== undefined && filter.query.length > 300) {
      throw validationError("Skill query must contain no more than 300 characters.", { field: "q" });
    }
    return this.skillBox.listSkillsForApi({
      ...(filter.query === undefined ? {} : { query: filter.query }),
      ...(filter.state === undefined ? {} : { state: filter.state }),
      ...(filter.scope === undefined ? {} : { scope: filter.scope }),
      ...(filter.trial === undefined ? {} : { trial: filter.trial }),
    });
  }

  public async getSkill(name: string) {
    this.assertSkillName(name);
    const skill = this.skillBox.getSkill(name);
    if (!skill) throw notFound("skill", name);
    const recent_uses = this.skillBox.listRecentUsages(name);
    try {
      const content = await this.skillBox.readSkillFiles(name);
      return {
        skill,
        ...content,
        file_sizes: skillFileSizes(content.files),
        recent_uses,
      };
    } catch (error) {
      const reason = isNodeMissingFileError(error)
        ? "skill_directory_missing"
        : isCodedError(error) || !(error instanceof Error) ? "skill_directory_unreadable" : error.message;
      return { skill: { ...skill, broken_reason: skill.broken_reason ?? reason }, body: "", files: {}, file_sizes: {}, recent_uses };
    }
  }

  public async readSkillFile(name: string, path: string): Promise<string> {
    this.assertSkillName(name);
    const validPath = validateSkillFilePath(path);
    if (!validPath.ok) throw validationError(validPath.reason, { field: "path" });
    if (!this.skillBox.getSkill(name)) throw notFound("skill", name);
    try {
      return await this.skillBox.readFile(name, path);
    } catch (error) {
      if (isNodeMissingFileError(error) || (isRecord(error) && error.code === "EISDIR")) throw notFound("skill_file", `${name}/${path}`);
      if (error instanceof Error && /symlink|symbolic[_ ]link/u.test(error.message)) {
        throw validationError(error.message, { field: "path" });
      }
      throw error;
    }
  }

  public listSkillRevisions(name: string) {
    this.assertSkillName(name);
    if (!this.skillBox.getSkill(name)) throw notFound("skill", name);
    return this.skillBox.listRevisions(name).map(({ snapshot_json: snapshot, ...revision }) => ({
      ...revision,
      has_snapshot: snapshot !== null,
    }));
  }

  public getSkillRevision(name: string, revisionId: string) {
    this.assertSkillName(name);
    if (!this.skillBox.getSkill(name)) throw notFound("skill", name);
    const revision = this.skillBox.getRevision(revisionId);
    if (!revision || revision.skill_name !== name) throw notFound("skill_revision", revisionId);
    const { snapshot_json: snapshot, ...metadata } = revision;
    return {
      ...metadata,
      source_work_title: metadata.source_work_id === null
        ? null
        : this.db.get<{ title: string | null }>("SELECT title FROM works WHERE id = ?", metadata.source_work_id)?.title ?? null,
      has_snapshot: snapshot !== null,
      files: snapshot === null ? null : parseSkillFilesSnapshot(snapshot),
    };
  }

  public async restoreSkill(name: string, revisionId: string): Promise<{ revision_id: string; revision: number }> {
    this.assertSkillName(name);
    if (typeof revisionId !== "string" || revisionId.length === 0) {
      throw validationError("revision_id must be a non-empty string.", { field: "revision_id" });
    }
    if (!this.skillBox.getSkill(name)) throw notFound("skill", name);
    const revision = this.skillBox.getRevision(revisionId);
    if (!revision || revision.skill_name !== name) {
      throw notFound("skill_revision", revisionId);
    }
    if (revision.snapshot_json === null) {
      throw validationError("This revision has no stored content and cannot be restored.", { field: "revision_id" });
    }
    try {
      return await this.skillBox.restore(name, revisionId, "user");
    } catch (error) {
      throw skillValidationError(error);
    }
  }

  public async updateSkill(name: string, patch: { state?: string; scope?: string }) {
    this.assertSkillName(name);
    if (Object.keys(patch).length === 0) throw validationError("At least one skill field must be updated.");
    if (patch.state !== undefined && !isSkillState(patch.state)) {
      throw validationError("Skill state must be active, stale, or archived.", { field: "state" });
    }
    if (patch.scope !== undefined && !isValidSkillScope(patch.scope)) {
      throw validationError("Skill scope must be global or project:<id>.", { field: "scope" });
    }
    if (!this.skillBox.getSkill(name)) throw notFound("skill", name);
    try {
      // Scope changes rewrite SKILL.md and can fail on its contents, so they run before the state change.
      if (patch.scope !== undefined) await this.skillBox.setScope(name, patch.scope, "user", "Updated by the Owner through the API.");
      if (patch.state !== undefined) await this.skillBox.setState(name, patch.state as SkillState, "user", "Updated by the Owner through the API.");
    } catch (error) {
      throw skillValidationError(error);
    }
    return this.skillBox.getSkill(name)!;
  }

  public listSkillProposals(status?: string) {
    if (status !== undefined && !isSkillProposalStatus(status)) {
      throw validationError("Skill proposal status is invalid.", { field: "status" });
    }
    return this.skillBox.listProposals(status as "pending" | "awaiting_approval" | "applied" | "rejected" | undefined);
  }

  public listRuleProposals(status?: string) {
    if (status !== undefined && !isSkillProposalStatus(status)) {
      throw validationError("Rule proposal status is invalid.", { field: "status" });
    }
    return this.ruleProposals.list(status as RuleProposalStatus | undefined);
  }

  private failPages(reason: string): void {
    this.started = false;
    this.pagesFault = reason;
    this.memory.markUnavailable(reason);
  }

  /** The first time pages mode opens a vault, the old knowledge moves to the archive (see knowledge-archive.ts); later starts see the pages marker and do nothing. */
  private async archiveLegacyKnowledgeOnFirstOpen(): Promise<void> {
    if (!this.knowledgeLocation.isAvailable()) return;
    try {
      const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", MEMORY_ARCHIVE_SETTINGS_KEY);
      const archive = readMemoryArchive(row ? (JSON.parse(row.value_json) as unknown) : undefined);
      const result = await this.knowledgeLocation.withWrite(() => archiveLegacyKnowledge({ root: this.knowledgeLocation.activeDir(), archive, now: this.options.now ? () => new Date(this.options.now!()) : undefined }));
      if (result.run_dir) console.log(`[owl-core] Legacy knowledge archived: ${result.archived} files -> ${result.run_dir}`);
    } catch (error) {
      // Not published: pages indexing, search and saving stay off until the archive is finished, which the next start resumes.
      this.failPages((error as Error).message);
      throw new HumanReadableError({
        code: "knowledge_archive_failed",
        message: `Legacy knowledge could not be archived: ${(error as Error).message}`,
        remediation: "Fix the cause (archive folder permissions or space) and start Owl again; the archive resumes where it stopped and no file is lost.",
        details: { cause: (error as Error).message },
      });
    }
  }

  // memory (stage ①-1): entry points used by the HTTP/MCP layer and injection
  public memorySearch(input: MemorySearchInput, ctx: MemoryRequestContext): Promise<MemorySearchOutput> {
    return this.memory.search(input, ctx);
  }

  public memoryExpand(input: { note: string; include_body?: boolean; max_bytes?: number }, ctx: MemoryRequestContext): Promise<MemoryExpandOutput> {
    return this.memory.expand(input, ctx);
  }

  public memoryRecall(input: { topic?: string; types?: MemoryNoteType[]; limit?: number; explain?: boolean }, ctx: MemoryRequestContext): Promise<MemoryRecallOutput> {
    return this.memory.recall(input, ctx);
  }

  // memory (pages): the index/page/search tools.
  public memoryMode(): MemoryMode {
    return this.memorySettings().mode;
  }

  public memoryIndexRead(input: { project_id?: string | null }, ctx: MemoryRequestContext): Promise<PageReadOutput> {
    return this.memory.readIndex(input, ctx);
  }

  public memoryPage(input: { page: string; sections?: readonly string[] }, ctx: MemoryRequestContext): Promise<PageReadOutput> {
    return this.memory.page(input, ctx);
  }

  public memoryPageSearch(input: { query: string; include_work_log?: boolean }, ctx: MemoryRequestContext): Promise<PageSearchOutput> {
    return this.memory.searchPages(input, ctx);
  }

  public memoryHealth(): Promise<MemoryHealth> {
    return this.memory.health();
  }

  public memoryReindex(input: { mode: "diff" | "full"; embed?: boolean }): Promise<MemoryReindexOutput> {
    return this.memory.reindex(input);
  }

  public searchKnowledgeCompat(query: string, tags: readonly string[]): Promise<KnowledgeSearchResult[] | null> {
    return this.memory.searchKnowledgeCompat(query, tags);
  }

  public notifyKnowledgeChanged(paths?: readonly string[]): void {
    this.memory.notifyChanged(paths);
  }

  public getKnowledgeStorage(): KnowledgeStorageStatus {
    return this.knowledgeLocation.status();
  }

  public hasKnowledgeStorageEverBeenAvailable(): boolean {
    return this.knowledgeLocation.hasEverBeenAvailable();
  }

  public checkKnowledgeStorage(): Promise<KnowledgeStorageStatus> {
    return this.knowledgeLocation.check();
  }

  public activeKnowledgeDir(): string {
    return this.knowledgeLocation.activeDir();
  }

  public withKnowledgeAccess<T>(kind: "read" | "write", fn: () => Promise<T>): Promise<T> {
    return kind === "read" ? this.knowledgeLocation.withRead(fn) : this.knowledgeLocation.withWrite(fn);
  }

  /** Switches where knowledge is stored, without a restart; Core and HTTP read the location on every call. */
  public async moveKnowledgeStorage(input: { path: string; mode?: KnowledgeMoveMode }): Promise<KnowledgeMoveResult> {
    if (!input || typeof input.path !== "string") throw validationError("path must be a string.", { field: "path" });
    const mode = input.mode ?? "move";
    if (mode !== "move" && mode !== "relink") throw validationError("mode must be move or relink.", { field: "mode" });
    if (this.retagRunning || this.activeCurations.has("librarian")) {
      throw new HumanReadableError({
        code: "knowledge_storage_busy",
        message: "A Librarian run or a retag is running.",
        remediation: "Move the knowledge storage after it finishes.",
      });
    }
    const result = await this.knowledgeLocation.move({ path: input.path, mode });
    await this.knowledge.ensureDirectories().catch((error: unknown) => console.warn("[owl-core] Could not prepare the knowledge folders", error));
    return result;
  }

  /** Logs a swallowed background failure and records a system.alert (on the Work when known) so the Owner can see it. Never throws. */
  private recordBackgroundFailure(
    kind: string,
    error: unknown,
    scope: { work_id?: string | null; task_id?: string | null; agent_run_id?: string | null; conversation_id?: string | null },
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error && error.cause !== undefined ? String(error.cause) : null;
    console.warn(`[owl-core] ${kind}: ${message}${cause ? ` (cause: ${cause})` : ""}`, error);
    const eventId = createUlid();
    void this.writeLane.write({
      mutateState: () => null,
      event: {
        id: eventId,
        idempotencyKey: `${kind}:${eventId}`,
        type: "system.alert",
        ...(scope.work_id ? { workId: scope.work_id } : {}),
        ...(scope.task_id ? { taskId: scope.task_id } : {}),
        payload: { kind, schema_version: "1.0.0", message, cause, ...scope } as JsonObject,
      },
      outbox: [{ provider: "websocket" }],
    }).catch((writeError: unknown) => console.warn(`[owl-core] Could not record ${kind}`, writeError));
  }

  /** Storage came back: prepare the folders and resume the learning jobs that waited. */
  private async onKnowledgeStorageAvailable(): Promise<void> {
    await this.knowledge.ensureDirectories();
    this.knowledgeNotes.resetCache();
    // Memory setup failing must not stop startup or the learning run; the Owner is told instead.
    await this.memory.onStorageAvailable().catch((error: unknown) => this.recordBackgroundFailure("memory_storage_init_failed", error, {})); // memory (stage ①-1)
    this.scheduleLearningRun("knowledge-storage");
  }

  /**
   * Rebuild note tags from AI-extracted keywords. `extract` defaults to the agent runner's
   * `runKeywordExtraction`; it is required when the runner has none.
   */
  private retagRunning = false;

  public async retagKnowledgeNotes(input: {
    /** Absolute path of the knowledge directory to retag (any name). Defaults to this Core's current knowledge directory. Backups always go to <dataDir>/backups. */
    knowledge_dir?: string;
    dry_run: boolean;
    /** Retag every note, including those already marked as keyword-tagged. */
    force?: boolean;
    extract?: (items: KeywordExtractionItem[]) => Promise<KeywordExtractionResult>;
  }) {
    if (!input || typeof input.dry_run !== "boolean") {
      throw validationError("dry_run must be a boolean.", { field: "dry_run" });
    }
    if (input.force !== undefined && typeof input.force !== "boolean") {
      throw validationError("force must be a boolean.", { field: "force" });
    }
    const knowledgeDir = input.knowledge_dir ?? this.knowledgeLocation.path;
    if (typeof knowledgeDir !== "string" || !isAbsolute(knowledgeDir)) {
      throw validationError("knowledge_dir must be an absolute path.", { field: "knowledge_dir" });
    }
    const current = input.knowledge_dir === undefined || resolve(knowledgeDir) === resolve(this.knowledgeLocation.path);
    const knowledge = current ? this.knowledge : new KnowledgeBase(this.owlRoot, { rootDir: () => knowledgeDir });
    const notes = current ? this.knowledgeNotes : new KnowledgeNotes(knowledge);
    const runner = this.options.agentRunner as {
      runKeywordExtraction?: (request: { items: KeywordExtractionItem[]; language: string }) => Promise<KeywordExtractionResult>;
    };
    const language = ownerLanguage(this.db);
    const extract = input.extract
      ?? (runner.runKeywordExtraction ? (items: KeywordExtractionItem[]) => runner.runKeywordExtraction!({ items, language }) : null);
    if (!extract) throw new Error("dependency_unavailable: keyword_extraction_unavailable");
    if (this.retagRunning || this.activeCurations.has("librarian")) throw new Error("retag_in_progress");
    this.retagRunning = true;
    try {
      const run = () => retagKnowledge({
        knowledge,
        notes,
        backupRoot: join(this.dataDir, "backups"),
        extract,
        dry_run: input.dry_run,
        force: input.force,
      });
      return await (current ? this.knowledgeLocation.withWrite(run) : run());
    } finally {
      this.retagRunning = false;
    }
  }

  public async approveRuleProposal(proposalId: string) {
    return this.knowledgeLocation.withWrite(() => this.ruleProposals.approve(proposalId));
  }

  public async rejectRuleProposal(proposalId: string) {
    return this.ruleProposals.reject(proposalId);
  }

  public async createRuleProposalFromNote(input: {
    note_id: string;
    claim_fingerprint: string;
    level: "system" | "role";
    role?: RuleRole;
    text?: string;
  }): Promise<RuleProposalCreateResult> {
    if (!input || typeof input.note_id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(input.note_id)) {
      throw validationError("note_id must be a ULID.", { field: "note_id" });
    }
    if (typeof input.claim_fingerprint !== "string" || !/^[a-f0-9]{16}$/u.test(input.claim_fingerprint)) {
      throw validationError("claim_fingerprint must be a 16 character fingerprint.", { field: "claim_fingerprint" });
    }
    if (input.level !== "system" && input.level !== "role") {
      throw validationError("Rule proposal level must be system or role.", { field: "level" });
    }
    if ((input.level === "role" && !isRuleRole(input.role)) || (input.level === "system" && input.role !== undefined)) {
      throw validationError("Rule proposal role does not match its level.", { field: "role" });
    }
    if (input.text !== undefined && typeof input.text !== "string") {
      throw validationError("text must be a string.", { field: "text" });
    }
    const note = await this.knowledgeLocation.withRead(() => this.knowledgeNotes.get(input.note_id));
    if (!note) throw notFound("note", input.note_id);
    const claim = note.claims.find((item) => item.fingerprint === input.claim_fingerprint);
    if (!claim) throw notFound("note_claim", input.claim_fingerprint);
    const text = input.text === undefined ? claim.text : input.text.trim();
    const role = input.level === "role" ? input.role! : null;
    return this.ruleProposals.create({
      origin: "note",
      source: { kind: "note", ref: `${note.id}:${claim.fingerprint}` },
      input_fingerprint: ruleKeyFingerprint(text, input.level, role),
      level: input.level,
      ...(role === null ? {} : { role }),
      text,
      rationale: note.summary,
      applies_to: note.title,
      project_id: note.project_ids[0] ?? null,
      note_id: note.id,
    });
  }

  public listLearningJobs(status?: string) {
    if (status !== undefined && !["pending", "running", "done", "failed"].includes(status)) {
      throw validationError("Learning job status is invalid.", { field: "status" });
    }
    return this.learningJobs.list(status as LearningJobStatus | undefined);
  }

  public async retryLearningJob(jobId: string): Promise<void> {
    try {
      await this.learningPipeline.retryJob(jobId);
    } catch (error) {
      if (error instanceof Error && error.message === "learning_job_not_found") throw notFound("learning job", jobId);
      throw error;
    }
    this.scheduleLearningRun(`retry ${jobId}`);
  }

  public getSkillActivity(days: number) {
    const now = this.options.now?.() ?? new Date().toISOString();
    const since = new Date(Date.parse(now) - days * 24 * 60 * 60 * 1000).toISOString();
    // Lifecycle state changes and scope changes are not content revisions, so they count in neither total.
    // A rollback is either a content rollback or the archive of a skill whose trial failed.
    const revisions = this.db.get<{ created: number | null; revised: number | null; rolled_back: number | null }>(
      `SELECT
         SUM(CASE WHEN action = 'create' THEN 1 ELSE 0 END) AS created,
         SUM(CASE WHEN action IN ('update', 'merge', 'restore', 'external_edit') THEN 1 ELSE 0 END) AS revised,
         SUM(CASE WHEN action = 'rollback' THEN 1 ELSE 0 END) AS rolled_back
       FROM skill_revisions WHERE created_at >= ?`,
      since,
    );
    const rejected = this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM skill_proposals WHERE status = 'rejected' AND updated_at >= ?",
      since,
    );
    return {
      days,
      created: Number(revisions?.created ?? 0),
      revised: Number(revisions?.revised ?? 0),
      rejected: Number(rejected?.count ?? 0),
      rolled_back: Number(revisions?.rolled_back ?? 0),
    };
  }

  public async approveSkillProposal(proposalId: string): Promise<SkillProposalCommandResult> {
    const proposal = this.db.get<{ status: string }>("SELECT status FROM skill_proposals WHERE id = ?", proposalId);
    if (!proposal) throw notFound("skill_proposal", proposalId);
    if (proposal.status !== "awaiting_approval") {
      throw invalidStateTransition("Only proposals awaiting approval can be approved.", { proposal_id: proposalId, status: proposal.status });
    }
    try {
      await this.skillCurator.approveProposal(proposalId);
    } catch (error) {
      throw skillProposalCommandError(error, proposalId);
    }
    return this.skillProposalCommandResult(proposalId);
  }

  public curateSkills(): Promise<SkillCurationResult> {
    return this.skillCurator.curate();
  }

  public curateRules(): RuleCurationResult {
    return this.ruleProposals.curate();
  }

  public async rejectSkillProposal(proposalId: string): Promise<SkillProposalCommandResult> {
    const proposal = this.db.get<{ status: string }>("SELECT status FROM skill_proposals WHERE id = ?", proposalId);
    if (!proposal) throw notFound("skill_proposal", proposalId);
    if (proposal.status !== "awaiting_approval") {
      throw invalidStateTransition("Only proposals awaiting approval can be rejected.", { proposal_id: proposalId, status: proposal.status });
    }
    try {
      await this.skillCurator.rejectProposal(proposalId);
    } catch (error) {
      throw skillProposalCommandError(error, proposalId);
    }
    return this.skillProposalCommandResult(proposalId);
  }

  private skillProposalCommandResult(proposalId: string): SkillProposalCommandResult {
    const row = this.db.get<{ status: SkillProposalCommandResult["status"]; applied_revision_id: string | null }>(
      "SELECT status, applied_revision_id FROM skill_proposals WHERE id = ?",
      proposalId,
    );
    if (!row) throw notFound("skill_proposal", proposalId);
    return { proposal_id: proposalId, status: row.status, applied_revision_id: row.applied_revision_id };
  }

  public getSkillSettings(): SkillSettings {
    return this.skillBox.getSettings();
  }

  public async setSkillSettings(value: unknown): Promise<SkillSettings> {
    const settings = validateSkillSettings(value);
    return this.skillBox.setSettings(isRecord(value) && value.feedback_weights === undefined
      ? { ...settings, feedback_weights: this.skillBox.getSettings().feedback_weights }
      : settings);
  }

  private assertSkillName(name: string): void {
    if (!validateSkillName(name)) throw validationError("Skill name is invalid.", { field: "name" });
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.db.migrate) {
      this.db.migrate();
    }
    await this.migrateAppSettingsExecutorConfig();
    await this.curationRuns.recoverInterrupted();
    this.refreshProcessSkillsPack();
    try {
      await this.warnUnknownSavedModels();
    } catch (error) {
      console.warn("[owl-core] Could not check saved models against known model lists", error);
    }
    this.started = true;
    await this.checkWorkspacesRootInsideRepository();
    await this.knowledgeLocation.initialize();
    if (this.knowledgeLocation.isAvailable()) await this.knowledge.ensureDirectories();
    // An overview scheduled before start (createProject) writes into knowledge/; the archive moves files away, so let those writes finish first.
    await this.projectOverviews.idle();
    await this.archiveLegacyKnowledgeOnFirstOpen();
    await this.memory.start(); // memory (stage ①-1)
    try {
      await this.memory.whenScanned();
    } catch (error) {
      this.failPages((error as Error).message);
      throw error;
    }
    await this.ruleStore.ensureDirectories();
    try {
      await this.ruleStore.load();
    } catch (error) {
      // No earlier valid rule set exists at startup, so a partial one would
      // silently drop rules: refuse to start and name every broken file.
      this.started = false;
      if (error instanceof RuleLoadError) {
        throw new HumanReadableError({
          code: "rules_invalid",
          message: `Rule files are invalid: ${error.failures.map((failure) => `${failure.path}${failure.line === null ? "" : `:${failure.line}`} (${failure.reason})`).join("; ")}`,
          remediation: "Fix or move the listed files under rules/ and start Owl again.",
          details: { failures: error.failures },
        });
      }
      throw error;
    }
    await this.ruleStore.startWatching((result) => this.onRulesReloaded(result));
    const recovery = await recoverOrphanedState(this.db, this.git);
    if (recovery.orphanedAgents > 0 || recovery.requeuedTasks > 0) {
      console.log(`[owl-core] Recovery: ${recovery.orphanedAgents} orphaned agents marked failed, ${recovery.requeuedTasks} tasks requeued`);
    }
    if (recovery.integratedVerifyingTasks > 0) {
      console.log(`[owl-core] Recovery: ${recovery.integratedVerifyingTasks} verifying tasks were already merged and are now completed`);
    }
    if (recovery.repairedWorktrees > 0) {
      console.log(`[owl-core] Recovery: ${recovery.repairedWorktrees} completed task worktrees repaired`);
    }
    if (recovery.staleWorks.length > 0) {
      // Running stale Works are re-registered with the driver below; its tick
      // replays any Manager replan that was queued but never ran.
      console.log(`[owl-core] Recovery: ${recovery.staleWorks.length} works with no active agents/tasks: ${recovery.staleWorks.join(", ")}`);
    }
    if (recovery.requeuedReplanMarkers > 0) {
      console.log(`[owl-core] Recovery: ${recovery.requeuedReplanMarkers} replan markers requeued`);
    }
    const advisorRecovery = await this.advisorSessions.recoverOnStartup();
    if (advisorRecovery > 0) {
      console.log(`[owl-core] Recovery: ${advisorRecovery} advisor sessions ended after core restart`);
    }
    if (this.advisorRuntime) await this.advisorRuntime.recoverTurns();
    if (this.advisorRuntime) void this.advisorRuntime.sweepWorkspaces();
    void this.keepAdvisorResident();
    const startupWorktrees = await this.runWorktreeReconcile(undefined, "startup");
    // Only Works whose merge into the base was recorded, and whose branches
    // were not deleted yet, are cleaned up.
    const completedProjectWorks = this.db.all<{ id: string }>(
      `SELECT works.id AS id FROM works
        WHERE works.state = 'completed' AND works.project_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM events WHERE events.work_id = works.id AND events.type = 'work.completed'
                        AND json_extract(events.payload_json, '$.merge') IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM events WHERE events.work_id = works.id AND events.type = 'work.branches_deleted')`,
    );
    for (const work of completedProjectWorks) {
      await this.deleteMergedWorkBranches(work.id, this.worktreeCleanupFailure(work.id, startupWorktrees));
    }
    this.recoverPostMergeCommands();
    this.advisorKeepAliveTimer = setInterval(() => {
      void this.keepAdvisorResident();
    }, 60_000);
    this.advisorKeepAliveTimer.unref();
    this.workspaceSweepTimer = setInterval(() => {
      // sweep() never rejects and logs its own failures.
      void this.workspaceSweeper.sweep();
    }, WORKSPACE_SWEEP_INTERVAL_MS);
    this.workspaceSweepTimer.unref();
    this.skillTimer = setInterval(() => {
      this.refreshProcessSkillsPack();
      this.scheduleSkillReconciliation();
    }, 300_000);
    this.skillTimer.unref();
    this.learningTimer = setInterval(() => {
      this.processLearningPending("tick");
    }, 300_000);
    this.learningTimer.unref();
    this.skillCurator.start();
    this.scheduleSkillReconciliation();
    await this.dispatcher.start();
    await this.announceCoreDecisions();
    await this.announceDecisionCancellations();
    this.workflow.start();
    this.workflow.startStaleDetection();
    this.processLearningPending("startup");
    const runningWorks = this.db.all<{ id: string; state: string }>("SELECT id, state FROM works WHERE state IN ('running', 'judgement_waiting')")
      .filter((work) => work.state === "running" || this.hasQueuedOwnerReplan(work.id));
    this.workDriver.start(runningWorks.map((work) => work.id));
    this.providerPauseController.start();
    for (const provider of recovery.reviewerProvidersToResume) this.workflow.resumeProvider(provider);
    this.retryWorkAfterRoleChange();
    this.librarianScheduler.start(this.readKnowledgeAutomationSettings().librarian_times);
    this.nightlyScheduler.start([this.readNightlyTestTime()]);
    this.planUsageService.start();
  }

  /**
   * Runs one curation and records it in curation_runs. Runs of the same kind
   * are serialized; each request keeps its own record.
   */
  public async runCuration(input: {
    kind: CurationKind;
    trigger: CurationTrigger;
    actor: CurationActor;
    actor_ref?: string | null;
    request_key?: string | null;
    /** Page integration instead of the legacy Librarian; recorded under kind `librarian`. */
    pages?: { mode: PageRunMode; paths?: readonly string[] };
  }, onStarted?: (run: CurationRunView) => void): Promise<CurationRunView> {
    if (input.kind === "librarian") this.knowledgeLocation.assertAvailable();
    const key = input.request_key ?? null;
    if (key) {
      const pending = this.pendingCurationKeys.get(key);
      if (pending) return pending;
      const existing = this.curationRuns.findByRequestKey(key);
      if (existing) return existing;
    }
    const previous = this.activeCurations.get(input.kind);
    const promise: Promise<CurationRunView> = (previous ?? Promise.resolve()).then(() => this.executeCuration(input, onStarted));
    // The tail never rejects: it only orders later runs and is awaited on stop.
    const tail: Promise<unknown> = promise.then(() => undefined, () => undefined).then(() => {
      if (this.activeCurations.get(input.kind) === tail) this.activeCurations.delete(input.kind);
      if (key && this.pendingCurationKeys.get(key) === promise) this.pendingCurationKeys.delete(key);
    });
    this.activeCurations.set(input.kind, tail);
    if (key) this.pendingCurationKeys.set(key, promise);
    return promise;
  }

  /**
   * Starts an Advisor-requested curation without waiting for it. The running row exists when this
   * returns; a request for a kind that is already running gets that run back instead of a new one.
   * The completion alert is raised here (alertScheduledCurationFailure only covers scheduled runs),
   * so each run yields exactly one.
   */
  public async startCurationInBackground(input: {
    kind: CurationKind;
    trigger: CurationTrigger;
    actor: CurationActor;
    actor_ref?: string | null;
    request_key?: string | null;
  }): Promise<{ run: CurationRunView; started: boolean }> {
    if (input.kind === "librarian") this.knowledgeLocation.assertAvailable();
    const existing = input.request_key ? this.curationRuns.findByRequestKey(input.request_key) : null;
    if (existing) return { run: existing, started: false };
    if (this.activeCurations.has(input.kind)) {
      // activeCurations is set synchronously by runCuration, so it also covers a run whose row is still being inserted.
      let running = this.curationRuns.findRunning(input.kind);
      while (!running && this.activeCurations.has(input.kind)) {
        await new Promise((resolve) => setImmediate(resolve));
        running = this.curationRuns.findRunning(input.kind);
      }
      const run = running ?? this.curationRuns.list({ kind: input.kind, limit: 1 }).items[0];
      return { run: this.curationRuns.get(run!.id)!, started: false };
    }
    const row = new Promise<CurationRunView>((resolve, reject) => {
      // runCuration tracks the promise in activeCurations, so core.stop() waits for it; the rejection handler keeps it from going unhandled.
      void this.runCuration(input, resolve).then(
        (done) => this.recordBackgroundFailure("curation_run_finished", new Error(curationCompletionMessage(input.kind, done)), {}),
        (error: unknown) => {
          reject(error);
          this.recordBackgroundFailure("curation_run_failed", error, {});
        },
      );
    });
    return { run: await row, started: true };
  }

  private async executeCuration(input: {
    kind: CurationKind;
    trigger: CurationTrigger;
    actor: CurationActor;
    actor_ref?: string | null;
    request_key?: string | null;
    pages?: { mode: PageRunMode; paths?: readonly string[] };
  }, onStarted?: (run: CurationRunView) => void): Promise<CurationRunView> {
    const run = await this.curationRuns.start(input);
    onStarted?.(run);
    try {
      if (input.kind === "librarian" && this.retagRunning && !input.pages) throw new Error("A knowledge retag is running. Try again after it finishes.");
      const report = input.pages
        ? await this.executePageIntegration(run.id, input.pages.mode, input.pages.paths)
        : await this.executeCurationReport(input.kind, run.id, input.trigger);
      const language = ownerLanguage(this.db);
      const summarized = { ...summarizeCurationReport(input.kind, report, run.id, language), report };
      const failure = curationReportFailure(input.kind, report, language);
      if (!failure) return await this.curationRuns.finish(run.id, summarized);
      const failed = await this.curationRuns.fail(run.id, failure, summarized);
      this.alertScheduledCurationFailure(input, run.id, failure);
      return failed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[owl-core] curation run failed", { kind: input.kind, run_id: run.id, message });
      this.alertScheduledCurationFailure(input, run.id, message);
      return this.curationRuns.fail(run.id, message);
    }
  }

  /** Advisor-requested runs are reported by the advisor's own notice (t.curationFailed); only unattended runs need an alert. */
  private alertScheduledCurationFailure(input: { kind: CurationKind; trigger: CurationTrigger }, runId: string, reason: string): void {
    if (input.trigger === "scheduled") this.recordBackgroundFailure("curation_run_failed", new Error(`${input.kind} run ${runId}: ${reason}`), {});
  }

  /** How much the librarian still has to read: pending conversation logs, clippings without 使いどころ, and the age of the oldest of them. */
  public async memoryPendingStats(): Promise<PagePendingStats> {
    return this.pageLibrarian.pendingStats();
  }

  private async executePageIntegration(runId: string, mode: PageRunMode, paths?: readonly string[]): Promise<unknown> {
    if (this.retagRunning) return { run_id: runId, mode, pages: [], skipped: "retag_running" };
    return this.pageLibrarian.run({ run_id: runId, mode, paths });
  }

  /**
   * Runs the page librarian (nightly or manual) and records the run.
   * A run is recorded as skipped when a retag or another Librarian run is in progress; the nightly run
   * queues behind the Librarian it follows instead.
   */
  public async integrateMemoryPages(input: { mode: PageRunMode; paths?: readonly string[]; trigger: CurationTrigger; actor: CurationActor; actor_ref?: string | null }): Promise<CurationRunView> {
    this.knowledgeLocation.assertAvailable();
    const busy = this.retagRunning ? "retag_running" : input.mode !== "nightly" && this.activeCurations.has("librarian") ? "librarian_running" : null;
    if (busy) {
      const run = await this.curationRuns.start({ kind: "librarian", trigger: input.trigger, actor: input.actor, actor_ref: input.actor_ref });
      const report = { run_id: run.id, mode: input.mode, pages: [], skipped: busy };
      return this.curationRuns.finish(run.id, { ...summarizeCurationReport("librarian", report, run.id, ownerLanguage(this.db)), report });
    }
    return this.runCuration({ kind: "librarian", trigger: input.trigger, actor: input.actor, actor_ref: input.actor_ref, pages: { mode: input.mode, paths: input.paths } });
  }

  private createPageLibrarian(): PageLibrarian {
    const runner = this.options.agentRunner as { runLibrarianOperations?: (request: unknown) => Promise<unknown> };
    let backupBeforeWrite: ((rel: string) => Promise<void>) | null = null;
    const writer = {
      // Only a missing page is "no page"; EACCES / I/O errors must not look like a free slot to create over.
      read: async (path: string) => readFile(join(this.knowledgeLocation.activeDir(), path), "utf8").catch(rethrowUnlessMissing),
      write: async (path: string, text: string, options: { expected_body_sha256: string | null; create_only?: boolean }) => {
        const full = join(this.knowledgeLocation.activeDir(), path);
        const current = await readFile(full, "utf8").catch(rethrowUnlessMissing);
        if (options.create_only ? current !== null : (current === null ? options.expected_body_sha256 !== null : bodySha256(current) !== options.expected_body_sha256)) return { path, written: false, reason: "conflict" as const };
        await backupBeforeWrite?.(path);
        await mkdir(dirname(full), { recursive: true });
        await writePage(full, text);
        return { path, written: true };
      },
    };
    const builder = new IndexBuilder({
      index: this.memory.index,
      writer,
      projects: { get: (id) => this.db.get<{ id: string; name: string }>("SELECT id, name FROM projects WHERE id = ?", id) ?? null },
      now: this.options.now ? () => new Date(this.options.now!()) : undefined,
    });
    return new PageLibrarian({
      vault: {
        isAvailable: () => this.knowledgeLocation.isAvailable(),
        activeDir: () => this.knowledgeLocation.activeDir(),
        withWrite: (fn) => this.knowledgeLocation.withWrite(fn),
      },
      dataDir: this.dataDir,
      index: {
        refresh: () => this.memory.index.refreshChanged(),
        listPages: (query) => this.memory.index.listPages(query),
      },
      propose: runner.runLibrarianOperations
        ? (request) => runner.runLibrarianOperations!(request) as ReturnType<ProposeOperationsFn>
        : async () => ({ ok: false as const, error: "librarian_operations_unavailable" }),
      router: this.pageRouter,
      dormantCandidates: () => this.memory.dormantCandidates(),
      workExists: (number) => this.db.get("SELECT 1 AS found FROM works WHERE display_number = ? LIMIT 1", number) !== undefined,
      conversationExists: (name) => this.memory.index.resolvePageRef(name) !== null,
      pathMissing: (projectId, path) => this.repoPathMissing(projectId, path),
      model: () => this.memorySettings().memory_librarian,
      batch: () => this.memorySettings().memory_librarian_batch,
      rebuildIndexes: async (scopes, backup) => {
        backupBeforeWrite = backup;
        try { return await builder.rebuildAll(scopes); } finally { backupBeforeWrite = null; }
      },
      onChanged: (paths) => this.memory.notifyChanged(paths),
      now: this.options.now ? () => new Date(this.options.now!()) : undefined,
      logger: { warn: (message, error) => console.warn(`[owl-core] ${message}`, error) },
    });
  }

  /** Runs the curation behind one kind; the Librarian also records where its merged notes went. */
  private async executeCurationReport(kind: CurationKind, runId: string, trigger: CurationTrigger): Promise<unknown> {
    if (kind === "librarian") {
      // Takes in new lines and conversation logs, merges duplicates, retires, links and puts stale pages to sleep.
      return this.executePageIntegration(runId, trigger === "scheduled" ? "nightly" : "manual");
    }
    if (kind === "skill_curation") return this.curateSkills();
    if (kind === "rule_curation") return this.curateRules();
    throw new Error("curation_kind_not_implemented");
  }

  public listCurationRuns(query: CurationListQuery): { items: CurationRunSummaryView[]; next_cursor: string | null } {
    return this.curationRuns.list(query);
  }

  public getCurationRun(id: string): CurationRunView | null {
    return this.curationRuns.get(id);
  }

  private scheduleSkillReconciliation(): void {
    this.skillReconcilePromise = this.skillCurator.tick().catch((error) => {
      console.error("[owl-core] Skill curation tick failed", error);
    });
  }

  private trackLearningTask(task: Promise<void>, source: string): void {
    const handled = task.catch((error) => console.error(`[owl-core] Learning pipeline ${source} failed`, error));
    this.learningTask = Promise.all([this.learningTask, handled]).then(() => undefined);
  }

  /** `pages` is for the live vault only; an alternate-directory service keeps writing the fixed note. */
  private createOverviewService(notes: KnowledgeNotes, withWrite: <T>(fn: () => Promise<T>) => Promise<T>, pages = false): ProjectOverviewService {
    return new ProjectOverviewService({
      pages: pages ? { router: this.pageRouter } : undefined,
      notes,
      withWrite,
      getProject: (id) => this.db.get<ProjectOverviewInput>(
        "SELECT id, name, canonical_path, base_branch, verification_plan_json FROM projects WHERE id = ?",
        id,
      ) ?? null,
      reader: this.projectReader,
      investigate: this.investigationRunner() ? (input) => this.runProjectInvestigation(input) : undefined,
      onInvestigated: (id, valid) => { if (valid) this.recordInvestigationSuccess(id); else this.recordInvestigationFailure(id); },
      now: this.options.now,
      log: (message, error) => console.error(`[owl-core] ${message}`, error),
    });
  }

  /** The runner's read-only investigation, found by structural cast; undefined when the runner has none. */
  private investigationRunner(): ((request: Record<string, unknown>) => Promise<ProjectInvestigationResult>) | undefined {
    const runner = this.options.agentRunner as { runProjectInvestigation?: (request: Record<string, unknown>) => Promise<ProjectInvestigationResult> };
    return typeof runner.runProjectInvestigation === "function" ? runner.runProjectInvestigation.bind(this.options.agentRunner) : undefined;
  }

  private investigationTimeoutMs(): number {
    const value = Number(process.env.OWL_PROJECT_INVESTIGATION_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? Math.min(1_800_000, Math.max(120_000, value)) : 600_000;
  }

  private clockMs(): number {
    return Date.parse(this.options.now?.() ?? new Date().toISOString());
  }

  /** Runs one read-only investigation. Automatic ones are refused during a cooldown or while another runs; manual ones queue. */
  private async runProjectInvestigation(input: ProjectInvestigationInput): Promise<ProjectInvestigationResult> {
    const manual = input.reason === "manual";
    const id = input.project.id;
    const model = resolveRoleModelFromDb(this.db, "librarian");
    if (!manual) {
      const failure = this.investigationFailures.get(id);
      if (failure && failure.until > this.clockMs()) return { ok: false, error: "cooldown" };
      if (this.investigationPending > 0) return { ok: false, error: "busy" };
      if (model && this.providerPauseController.isPaused(model.provider)) return { ok: false, error: "provider_paused" };
    }
    this.investigationPending += 1;
    const run = this.investigationTail.then(async (): Promise<ProjectInvestigationResult> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const start = this.investigationRunner();
        if (!start) return { ok: false, error: "project_investigation_unavailable" };
        // Safety net: a runner that never settles must not hold the slot (timeout plus 60 seconds).
        const override = Number(process.env.OWL_PROJECT_INVESTIGATION_SAFETY_MS);
        const safetyMs = Number.isFinite(override) && override > 0 ? override : this.investigationTimeoutMs() + 60_000;
        const stuck = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), safetyMs); });
        const result = await Promise.race([start({
          project: { id, name: input.project.name, base_branch: input.project.base_branch, commit: input.commit },
          repo_path: input.project.canonical_path,
          known_facts: input.known_facts,
          recent_works: [],
          provider: model?.provider,
          model: model?.model,
          effort: model?.effort,
          timeout_ms: this.investigationTimeoutMs(),
          output_settings: projectInvestigationOutputSettings(this.db),
        }), stuck]);
        // An ok result is judged by the service (onInvestigated): an unusable one still counts as a failure.
        if (!result.ok) this.recordInvestigationFailure(id);
        return result;
      } catch (error) {
        this.recordInvestigationFailure(id);
        return { ok: false, error: `provider_failed:${error instanceof Error ? error.message : String(error)}`.slice(0, 200) };
      } finally {
        clearTimeout(timer);
        this.investigationPending -= 1;
      }
    });
    this.investigationTail = run;
    return run;
  }

  /** A success also holds automatic runs back for 6 hours, across dates. */
  private recordInvestigationSuccess(projectId: string): void {
    this.investigationFailures.set(projectId, { count: 0, until: this.clockMs() + 6 * 3_600_000 });
  }

  /** Cooldown: 6 hours after a failure, 24 hours from the second consecutive failure. */
  private recordInvestigationFailure(projectId: string): void {
    const count = (this.investigationFailures.get(projectId)?.count ?? 0) + 1;
    this.investigationFailures.set(projectId, { count, until: this.clockMs() + (count >= 2 ? 24 : 6) * 3_600_000 });
  }

  public async investigateProjectOverview(input: { project_id: string; dry_run?: boolean; knowledge_dir?: string }) {
    if (!input || typeof input.project_id !== "string" || !input.project_id) {
      throw validationError("project_id must be a non-empty string.", { field: "project_id" });
    }
    if (input.dry_run !== undefined && typeof input.dry_run !== "boolean") {
      throw validationError("dry_run must be a boolean.", { field: "dry_run" });
    }
    if (input.knowledge_dir !== undefined && (typeof input.knowledge_dir !== "string" || !isAbsolute(input.knowledge_dir))) {
      throw validationError("knowledge_dir must be an absolute path.", { field: "knowledge_dir" });
    }
    const project = this.db.get<ProjectOverviewInput>("SELECT id, name, canonical_path, base_branch, verification_plan_json FROM projects WHERE id = ?", input.project_id);
    if (!project) throw new HumanReadableError({ code: "not_found", message: `project ${input.project_id} was not found.`, remediation: "Verify the project id.", details: { resource: "project", id: input.project_id } });
    const knowledgeDir = input.knowledge_dir ?? this.knowledgeLocation.path;
    const current = input.knowledge_dir === undefined || resolve(knowledgeDir) === resolve(this.knowledgeLocation.path);
    const notes = current ? this.knowledgeNotes : new KnowledgeNotes(new KnowledgeBase(this.owlRoot, { rootDir: () => knowledgeDir }));
    const model = resolveRoleModelFromDb(this.db, "librarian");
    const paused = Boolean(model && this.providerPauseController.isPaused(model.provider));
    const runnerAvailable = this.investigationRunner() !== undefined;
    if (input.dry_run === true) {
      const facts = await collectFacts(project, this.projectReader, project.base_branch);
      const thin = facts.files.length ? thinReasons(facts) : [];
      let overviewUnreadable = false;
      const existing = await notes.getProjectOverview(project.id).catch((error) => {
        // Without the overview the done marker is invisible; do not report an automatic re-investigation (loop prevention).
        overviewUnreadable = true;
        console.warn("[owl-core] project overview could not be read for the investigation plan", project.id, error);
        return null;
      });
      const done = existing?.claims.map((c) => c.text.match(INVESTIGATION_MARKER)).find(Boolean);
      const unavailable = !runnerAvailable ? "runner_unavailable" : paused ? "provider_paused" : !facts.files.length ? "repo_missing" : null;
      const reason = !done && !overviewUnreadable && thin.length ? `thin:${thin.join(",")}` : null;
      return {
        dry_run: true as const,
        plan: {
          project_id: project.id,
          would_investigate: unavailable === null,
          available: unavailable === null,
          unavailable_reason: unavailable,
          automatic: { would_trigger: reason !== null, reason },
          metrics: thinMetrics(facts),
          existing_investigation: done ? { date: done[1], commit: done[2] } : null,
          model: { provider: model?.provider ?? null, model: model?.model ?? null, effort: model?.effort ?? null },
          timeout_ms: this.investigationTimeoutMs(),
          knowledge_dir: knowledgeDir,
        },
      };
    }
    if (!runnerAvailable) throw dependencyUnavailable("project_investigation_unavailable", { reason: "project_investigation_unavailable" });
    if (paused) throw dependencyUnavailable("provider_paused", { reason: "provider_paused", provider: model?.provider });
    const known = this.investigationQueued.get(project.id);
    if (known) return { dry_run: false as const, state: known };
    const state = this.investigationPending > 0 ? "queued" as const : "running" as const;
    this.investigationQueued.set(project.id, state);
    const service = current ? this.projectOverviews : this.createOverviewService(notes, (fn) => fn());
    const run: Promise<unknown> = service.reinvestigate(project.id).then(() => undefined, (error) => console.error("[owl-core] Project overview investigation failed", error))
      .finally(() => { this.investigationQueued.delete(project.id); this.overviewRuns.delete(run); });
    this.overviewRuns.add(run);
    return { dry_run: false as const, state };
  }

  private scheduleProjectOverviewForWork(workId: string, projectId: string | null, merge: JsonObject | undefined): void {
    if (projectId === null) return;
    try {
      const title = this.db.get<{ title: string }>("SELECT title FROM works WHERE id = ?", workId)?.title ?? workId;
      const old = merge?.old_base_commit;
      const next = merge?.new_base_commit;
      this.projectOverviews.schedule(projectId, {
        kind: "work_completed",
        work_id: workId,
        title,
        merge: typeof old === "string" && typeof next === "string" ? { old_base_commit: old, new_base_commit: next } : null,
      });
    } catch (error) {
      console.error("[owl-core] Project overview schedule failed", error);
    }
  }

  private processLearningPending(source: string): void {
    this.trackLearningTask(this.learningPipeline.processPending(), source);
  }

  private scheduleLearningRun(source: string): void {
    this.trackLearningTask(this.learningPipeline.requestRun(), source);
  }

  private readProcessSkillsSettings(): ProcessSkillsSettings {
    const row = this.db.get<{ value_json: string }>(
      "SELECT value_json FROM settings WHERE key = ?",
      PROCESS_SKILLS_SETTINGS_KEY,
    );
    if (!row) return { enabled: true, path: null };
    try {
      const value: unknown = JSON.parse(row.value_json);
      if (!isRecord(value)) return { enabled: true, path: null };
      return {
        enabled: typeof value.enabled === "boolean" ? value.enabled : true,
        path: typeof value.path === "string" ? value.path : null,
      };
    } catch {
      // Why not log: an unparseable setting is treated as "not configured" (the default), which is the expected fallback.
      return { enabled: true, path: null };
    }
  }

  private detectProcessSkills(settings: ProcessSkillsSettings): DetectedProcessSkillsPack | null {
    const detection = this.options.processSkillsDetection;
    return detectProcessSkillsPack({
      env: detection?.env ?? process.env,
      settings,
      homedir: detection?.homedir ?? homedir(),
      ...(detection?.fs ? { fs: detection.fs } : {}),
    });
  }

  private refreshProcessSkillsPack(): void {
    const settings = this.readProcessSkillsSettings();
    try {
      this.processSkillsPack = this.detectProcessSkills(settings);
    } catch (error) {
      this.processSkillsPack = null;
      console.warn("[owl-core] Process skills detection failed", error);
    }
    if (settings.enabled && this.processSkillsPack === null && !this.processSkillsMissingLogged) {
      this.processSkillsMissingLogged = true;
      console.info("[owl-core] No process skills pack detected");
    }
  }

  private processSkillsRequestContext(): JsonObject {
    return this.processSkillsPack
      ? { process_skills_dir: this.processSkillsPack.skills_dir, process_skills_source: this.processSkillsPack.source }
      : {};
  }

  /**
   * A rule reload after startup. A failed reload keeps the previous rule set
   * (the guard keeps judging with it) and tells the Owner once per distinct
   * failure; the first successful reload after a failure says it recovered.
   * Ordinary successful reloads are only logged.
   */
  private async onRulesReloaded(result: RuleReloadResult): Promise<void> {
    const language = ownerLanguage(this.db);
    if (result.ok) {
      console.log(`[owl-core] Rules reloaded (generation ${result.generation})`);
      if (this.rulesFailureSignature === null) return;
      this.rulesFailureSignature = null;
      await this.emitRulesAlert({
        kind: "rules_reloaded",
        schema_version: "1.0.0",
        message: language === "en"
          ? `The rule files were fixed and reloaded (generation ${result.generation}).`
          : `ルールファイルが修復され、再読み込みしました（generation ${result.generation}）。`,
        generation: result.generation,
      });
      return;
    }
    const failures = result.error.failures;
    const signature = failures.map((failure) => `${failure.path}:${failure.line ?? ""}:${failure.reason}`).sort().join("\n");
    if (signature === this.rulesFailureSignature) return;
    this.rulesFailureSignature = signature;
    const status = this.ruleStore.status;
    const list = failures.map((failure) => `- ${failure.path}${failure.line === null ? "" : `:${failure.line}`}: ${failure.reason}`).join("\n");
    console.error(`[owl-core] Rule reload failed; keeping generation ${status.generation}\n${list}`);
    await this.emitRulesAlert({
      kind: "rules_load_failed",
      schema_version: "1.0.0",
      message: language === "en"
        ? `Reloading the rule files failed. Owl keeps using the last valid rules (generation ${status.generation}, loaded ${status.loaded_at ?? "never"}).\n${list}`
        : `ルールファイルの再読み込みに失敗しました。直前の正常なルール（generation ${status.generation}, ${status.loaded_at ?? "未読み込み"}）を使い続けます。\n${list}`,
      remediation: language === "en"
        ? "Fix the listed files under rules/. Saving them reloads the rules automatically."
        : "rules/ 配下の該当ファイルを修正してください。保存すれば自動で再読み込みします。",
      files: failures.map((failure) => ({ ...failure })),
      kept_generation: status.generation,
    });
  }

  /**
   * Record that a deleted Work's design documents stayed on disk. The Work
   * row is gone, so the alert is global and names the directory to remove.
   */
  private async recordOrphanedDesignDocuments(workId: string, error: unknown): Promise<void> {
    try {
      await this.writeLane.write({
        mutateState: () => ({}),
        event: {
          idempotencyKey: `design-documents-orphaned:${workId}`,
          type: "system.alert",
          payload: {
            kind: "design_documents_orphaned",
            schema_version: "1.0.0",
            work_id: workId,
            path: designDocumentPath(this.dataDir, workId),
            message: `The deleted Work's design documents could not be removed: ${error instanceof Error ? error.message : String(error)}`,
          },
        },
        outbox: [{ provider: "websocket" }],
      });
    } catch (alertError) {
      console.error("[owl-core] Could not record the orphaned design documents alert", alertError);
    }
  }

  /**
   * When the workspaces root sits inside a repository, tools that walk up
   * from a Task/Work worktree's cwd (serena's project.yml search, Claude
   * Code's ancestor CLAUDE.md loading) resolve to that repository instead of
   * the worktree itself. Checked once at startup and skipped for the legacy
   * layout, which is deliberately nested inside Owl's own repository.
   */
  private async checkWorkspacesRootInsideRepository(): Promise<void> {
    try {
      const root = this.workspaceLayout.root;
      if (root === this.workspaceLayout.legacyRoot) return;
      const markers = [".git", join(".serena", "project.yml"), "CLAUDE.md", "AGENTS.md"];
      const found: string[] = [];
      let dir = dirname(root);
      while (true) {
        for (const marker of markers) {
          const candidate = join(dir, marker);
          if (existsSync(candidate)) found.push(candidate);
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      if (found.length === 0) return;
      const language = ownerLanguage(this.db);
      console.warn(`[owl-core] The workspaces root (${root}) is inside a repository: ${found.join(", ")}`);
      const message = language === "en"
        ? `The Owl workspaces directory (${root}) is inside a repository. Files found: ${found.join(", ")}. Tools that search upward from a Task/Work worktree (such as serena or Claude Code's CLAUDE.md loading) may resolve to that repository instead of the worktree.`
        : `Owl のワークスペースディレクトリ（${root}）がリポジトリの中にあります。見つかったファイル: ${found.join(", ")}。Task/Work のワークツリーから上位ディレクトリを探索するツール（serena や Claude Code の CLAUDE.md 読み込みなど）が、そのワークツリーではなくこのリポジトリを参照してしまう可能性があります。`;
      const remediation = language === "en"
        ? "Set OWL_WORKSPACES_DIR to a directory outside of any repository."
        : "OWL_WORKSPACES_DIR に、どのリポジトリにも含まれないディレクトリを設定してください。";
      await this.emitRulesAlert({
        kind: "workspaces_root_inside_repository",
        schema_version: "1.0.0",
        path: root,
        found,
        message,
        remediation,
      });
    } catch (error) {
      console.error("[owl-core] Could not check whether the workspaces root is inside a repository", error);
    }
  }

  private async emitRulesAlert(payload: JsonObject): Promise<void> {
    try {
      await this.writeLane.write({
        mutateState: () => ({}),
        event: {
          idempotencyKey: `rules-alert:${createUlid()}`,
          type: "system.alert",
          payload,
        },
        outbox: [{ provider: "websocket" }],
      });
    } catch (error) {
      console.error("[owl-core] Could not record rules alert", error);
    }
  }

  public async stop(options: { force?: boolean } = {}): Promise<void> {
    this.planUsageService.stop();
    this.postMergeCommands.stop();
    this.providerPauseController.stop();
    await this.childRuns.stop();
    if (!this.started) {
      await Promise.allSettled([...this.worktreeReconciles]);
      this.nightlyAbort.abort();
      await this.nightlyScheduler.stop();
      await this.librarianScheduler.stop();
      await this.memory.stop(); // memory (stage ①-1)
      await this.knowledgeLocation.stop();
      this.skillCurator.stop();
      await Promise.allSettled([...this.activeCurations.values()]);
      await this.learningTask;
      await this.projectOverviews.idle();
      await Promise.allSettled([...this.overviewRuns]);
      await this.researchRecorder.idle();
      return;
    }
    this.started = false;
    this.nightlyAbort.abort();
    await this.nightlyScheduler.stop();
    await this.librarianScheduler.stop();
    await this.memory.stop(); // memory (stage ①-1)
    await this.knowledgeLocation.stop();
    // Stopping the Curator releases a curation that is waiting on its provider.
    this.skillCurator.stop();
    await Promise.allSettled([...this.activeCurations.values()]);
    if (this.advisorKeepAliveTimer !== null) {
      clearInterval(this.advisorKeepAliveTimer);
      this.advisorKeepAliveTimer = null;
    }
    if (this.workspaceSweepTimer !== null) {
      clearInterval(this.workspaceSweepTimer);
      this.workspaceSweepTimer = null;
    }
    if (this.skillTimer !== null) {
      clearInterval(this.skillTimer);
      this.skillTimer = null;
    }
    if (this.learningTimer !== null) {
      clearInterval(this.learningTimer);
      this.learningTimer = null;
    }
    await this.skillReconcilePromise;
    this.ruleStore.stopWatching();
    // Shutdown ends the Owl system, not the Work itself. Stop scheduling,
    // terminate every Owl-owned Agent process group, and leave durable active
    // rows for startup recovery instead of waiting for provider calls to finish.
    this.workDriver.stopScheduling();
    this.workflow.stopImmediately();
    this.terminateActiveAgentProcessesImmediately();
    this.advisorRuntime?.stopImmediately();
    await this.workflow.stop();
    // Ticks already in flight must finish before the DB closes; stopScheduling only stops new ones.
    await this.workDriver.stop();
    await Promise.allSettled([...this.worktreeReconciles]);
    await this.learningTask;
    await this.projectOverviews.idle();
    await Promise.allSettled([...this.overviewRuns]);
    await this.dispatcher.stop();
    // These lanes contain only serialized SQLite mutations. Drain them so
    // already-queued state changes commit before the database connection closes.
    await this.writeLane.drain();
    await this.researchRecorder.idle();
  }

  private async emitProviderPauseEvent(event: ProviderPauseEvent): Promise<void> {
    if (!this.db.get("SELECT id FROM events WHERE idempotency_key = ?", event.idempotency_key)) {
      await this.writeLane.write({
        mutateState: () => null,
        event: {
          idempotencyKey: event.idempotency_key,
          type: event.type,
          payload: event.payload,
        },
        outbox: [{ provider: "websocket" }],
      });
    }
    await this.dispatcher.replayPending();
  }

  private terminateActiveAgentProcessesImmediately(): void {
    const activeAgents = this.db.all<{
      id: string;
      pid: number | null;
      process_start_time: string | null;
      process_cmdline_sha256: string | null;
    }>(
      `SELECT id, pid, process_start_time, process_cmdline_sha256
         FROM agent_runs
        WHERE status IN ('launch_pending','spawned','running','cancel_requested')`,
    );
    for (const agent of activeAgents) {
      if (agent.pid && processIdentityMatches(
        { process_start_time: agent.process_start_time, process_cmdline_sha256: agent.process_cmdline_sha256 },
        readProcessIdentity(agent.pid),
      )) {
        signalProcessGroup(agent.pid, "SIGKILL");
      }
      if (this.options.agentRunner.cancelAgent) {
        try {
          void this.options.agentRunner.cancelAgent(agent.id, true).catch((error) =>
            console.error(`[owl-core] Failed to terminate Agent ${agent.id} during shutdown`, error));
        } catch (error) {
          console.error(`[owl-core] Failed to terminate Agent ${agent.id} during shutdown`, error);
        }
      }
    }
  }

  public status(): CoreStatus {
    const running = this.started;
    return {
      services: [
        { name: "owl-core", state: running ? "running" : "stopped", pid: running ? process.pid : null },
        { name: "workflow-engine", state: running ? "running" : "stopped", pid: null },
        { name: "event-dispatcher", state: this.dispatcher.isStarted() ? "running" : "stopped", pid: null },
      ],
      mvp_scope: "core+workflow+event-dispatcher",
      version: this.options.version,
    };
  }

  public getTokenUsageReport(input: { readonly period: TokenUsagePeriod; readonly top: number }): TokenUsageReport {
    return buildTokenUsageReport(this.db, {
      ...input,
      now: new Date(this.options.now?.() ?? utcNow()),
      harnessOf: (provider) => this.options.getProviderHarness?.(provider) ?? builtinProviderHarness(provider) ?? undefined,
    });
  }

  public subscribe(handler: EventHandler): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /** Return canonical event frames after an exclusive sequence/id cursor. */
  public listEventsAfter(cursor: string | number | null = null, limit?: number): readonly CanonicalEventFrame[] {
    return this.dispatcher.listEventsAfter(cursor, limit);
  }

  public async createWork(
    request: CommandRequest<CreateWorkPayload>,
  ): Promise<CommandResponse<CreateWorkData>> {
    return this.runCommand(request, {
      type: "system.alert",
      payload: { kind: "work_created", schema_version: "1.0.0" },
    }, (transaction) => {
      const row = createWorkInTransaction(transaction, request.payload);
      applyAdvisorBacklogInTransaction(
        transaction,
        row,
        request.payload.backlog_item_ids ?? [],
        request.payload.dismiss_backlog_item_ids ?? [],
        utcNow(),
      );
      return {
        data: { work_id: row.id, state: row.state as "memo" | "ready", state_version: row.state_version },
        version: row.state_version,
      };
    });
  }

  public listBacklogItems(filter: BacklogListFilter = {}): BacklogListResult {
    if (filter.status !== undefined && !BACKLOG_STATUSES.includes(filter.status)) {
      throw validationError("Backlog status is invalid.", { field: "status" });
    }
    if (filter.work_id !== undefined && !this.db.get("SELECT id FROM works WHERE id = ?", filter.work_id)) {
      throw notFound("work", filter.work_id);
    }
    if (filter.issued_work_id !== undefined && !this.db.get("SELECT id FROM works WHERE id = ?", filter.issued_work_id)) {
      throw notFound("work", filter.issued_work_id);
    }
    return listBacklogItems(this.db, filter);
  }

  public async dismissBacklogItems(
    request: CommandRequest<DismissBacklogItemsPayload>,
  ): Promise<CommandResponse<DismissBacklogItemsData>> {
    return this.runCommand(request, {
      type: "system.alert",
      resourceKey: "backlog",
      payload: { kind: "backlog_items_dismissed", schema_version: "1.0.0" },
    }, (transaction) => ({
      data: { items: dismissBacklogItemsInTransaction(transaction, request.payload.item_ids, utcNow()) },
      version: 0,
    }));
  }

  public async deleteBacklogItems(
    request: CommandRequest<DismissBacklogItemsPayload>,
  ): Promise<CommandResponse<DeleteBacklogItemsData>> {
    return this.runCommand(request, {
      type: "system.alert",
      resourceKey: "backlog",
      payload: { kind: "backlog_items_deleted", schema_version: "1.0.0" },
    }, (transaction) => ({
      data: { deleted: deleteBacklogItemsInTransaction(transaction, request.payload.item_ids) },
      version: 0,
    }));
  }

  public async issueBacklogWork(
    request: CommandRequest<IssueBacklogWorkPayload>,
  ): Promise<CommandResponse<IssueBacklogWorkData>> {
    return this.runCommand(request, {
      type: "system.alert",
      resourceKey: "backlog",
      payload: { kind: "backlog_work_issued", schema_version: "1.0.0" },
    }, (transaction) => {
      const data = issueBacklogWorkInTransaction(transaction, request.payload, utcNow());
      return { data, version: data.state_version };
    });
  }

  public async linkBacklogItems(
    workId: string,
    request: CommandRequest<LinkBacklogItemsPayload>,
  ): Promise<CommandResponse<LinkBacklogItemsData>> {
    return this.runCommand(request, {
      type: "system.alert",
      workId,
      resourceKey: "backlog",
      payload: { kind: "backlog_items_linked", schema_version: "1.0.0", work_id: workId },
    }, (transaction) => ({
      data: linkBacklogItemsToWorkInTransaction(transaction, workId, request.payload.item_ids, utcNow()),
      version: 0,
    }));
  }

  public listWorks(query: WorkListQuery = {}): ListResponse<WorkSummary> {
    const limit = boundLimit(query.limit ?? 50);
    const archived = query.archived ?? "exclude";
    const rows = this.db.all<WorkDbRow>(
      `SELECT id, display_number, title, state, state_version, updated_at, archived_at, project_id
         FROM works
        WHERE (? IS NULL OR state = ?)
          AND (? = 'include' OR (? = 'only' AND archived_at IS NOT NULL) OR (? = 'exclude' AND archived_at IS NULL))
          AND (? IS NULL OR id > ?)
        ORDER BY id ASC LIMIT ?`,
      query.state ?? null,
      query.state ?? null,
      archived,
      archived,
      archived,
      query.cursor ?? null,
      query.cursor ?? null,
      limit + 1,
    );
    return listResponse(query.request_id, rows.slice(0, limit).map(toWorkSummary), rows.length > limit, limit);
  }

  public getWork(workId: string, query: { request_id?: string; include?: string | null } = {}): CommandResponse<WorkDetail> {
    const row = this.db.get<WorkDetailDbRow>(
      `SELECT id, display_number, title, state, state_version, updated_at, archived_at, owner_id, project_id,
              summary, size, design_mode, plan_revision, advisor_backlog_json,
              -- A Task the Manager's replan retired no longer counts toward progress,
              -- even in a cancelled Work; Tasks the Owner's cancel stopped still do.
              (SELECT COUNT(*) FROM tasks WHERE work_id = works.id
                 AND superseded_at IS NULL
                 AND (status <> 'cancelled' OR works.state = 'cancelled')) AS total_tasks,
              (SELECT COUNT(*) FROM tasks WHERE work_id = works.id AND status = 'completed') AS completed_tasks,
              (SELECT id FROM conversations WHERE work_id = works.id AND channel = 'web'
                 AND is_active = 1 AND archived_at IS NULL) AS conversation_id
         FROM works
        WHERE id = ?`,
      workId,
    );
    if (!row) {
      throw notFound("work", workId);
    }
    return {
      request_id: query.request_id ?? createUlid(),
      data: toWorkDetail(row),
      version: row.state_version,
    };
  }

  public async getWorkDesigns(workId: string): Promise<{ designs: Array<{ task_id: string; title: string; updated_at: string; size_bytes: number }> }> {
    if (!this.db.get<{ id: string }>("SELECT id FROM works WHERE id = ?", workId)) throw notFound("work", workId);
    const tasks = this.db.all<{ id: string; title: string }>(
      "SELECT id, title FROM tasks WHERE work_id = ? AND type = 'design' ORDER BY created_at ASC, id ASC",
      workId,
    );
    const designs: Array<{ task_id: string; title: string; updated_at: string; size_bytes: number }> = [];
    for (const task of tasks) {
      const path = designDocumentPath(this.dataDir, workId, task.id);
      // Why not log: a missing design file (ENOENT) is expected; other errors only hide a row in this display list.
      const details = await lstat(path).catch(() => null);
      if (!details?.isFile()) continue;
      designs.push({ task_id: task.id, title: task.title, updated_at: details.mtime.toISOString(), size_bytes: details.size });
    }
    return { designs };
  }

  public async getWorkDesign(workId: string, taskId: string): Promise<{ task_id: string; title: string; markdown: string; updated_at: string } | null> {
    if (!this.db.get<{ id: string }>("SELECT id FROM works WHERE id = ?", workId)) throw notFound("work", workId);
    const task = this.db.get<{ id: string; title: string }>(
      "SELECT id, title FROM tasks WHERE work_id = ? AND id = ? AND type = 'design'",
      workId,
      taskId,
    );
    if (!task) return null;
    const path = designDocumentPath(this.dataDir, workId, task.id);
    // Why not log: a missing design file (ENOENT) is expected; this only drives a display lookup.
    const details = await lstat(path).catch(() => null);
    if (!details?.isFile()) return null;
    return { task_id: task.id, title: task.title, markdown: await readFile(path, "utf8"), updated_at: details.mtime.toISOString() };
  }

  /**
   * Whether the Work's branches hold content outside the Project base.
   * Read from refs outside the repository lane; "unknown" when that fails.
   */
  public async getWorkBranchStatus(workId: string): Promise<{ work_id: string; unmerged_changes: "present" | "absent" | "unknown" }> {
    const work = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId);
    if (!work) throw notFound("work", workId);
    if (work.project_id === null) return { work_id: workId, unmerged_changes: "absent" };
    try {
      const unmerged = await this.git.workHasUnmergedChanges({ work_id: workId });
      return { work_id: workId, unmerged_changes: unmerged ? "present" : "absent" };
    } catch (error) {
      console.warn(`[owl-core] Could not read the branch status of Work ${workId}`, error);
      return { work_id: workId, unmerged_changes: "unknown" };
    }
  }

  public async startWork(
    workId: string,
    request: CommandRequest<StartWorkPayload>,
  ): Promise<CommandResponse<{ work_id: string; state: "running"; started: boolean }>> {
    const response: CommandResponse<{ work_id: string; state: "running"; started: boolean }> = await this.runCommand(request, {
      type: "work.started",
      workId,
      payload: { work_id: workId, mode: request.payload.mode },
    }, (transaction) => {
      const result = reduceWorkInTransaction(transaction, workId, {
        event: "work.started",
        expected_version: request.expected_version,
        payload: { ...request.payload, explicit_start: true, idempotency_processed: false },
      });
      return { data: { work_id: workId, state: "running" as const, started: result.previous.state !== "running" }, version: result.next.state_version };
    });
    this.workDriver.register(workId);
    return response;
  }

  public async pauseWork(
    workId: string,
    request: CommandRequest<PauseWorkPayload>,
  ): Promise<CommandResponse<{ work_id: string; state: "paused"; signal: "pause_requested" }>> {
    const response: CommandResponse<{ work_id: string; state: "paused"; signal: "pause_requested" }> = await this.runCommand(request, {
      type: "work.paused",
      workId,
      payload: { work_id: workId, reason: request.payload.reason },
    }, (transaction) => {
      const activeTask = transaction.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM tasks WHERE work_id = ? AND status NOT IN ('completed', 'cancelled')`,
        workId,
      );
      const activeAgent = transaction.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM agent_runs WHERE work_id = ? AND status IN ('launch_pending', 'spawned', 'running', 'cancel_requested')`,
        workId,
      );
      const result = reduceWorkInTransaction(transaction, workId, {
        event: "work.paused",
        expected_version: request.expected_version,
        payload: { has_active_task_or_agent: Number(activeTask?.count ?? 0) > 0 || Number(activeAgent?.count ?? 0) > 0 },
      });
      // A judgement_waiting Task stays blocked on its Decision; it has no
      // paused_from state and nothing to suppress.
      const tasks = transaction.all<{ id: string }>(
        `SELECT id FROM tasks WHERE work_id = ? AND status NOT IN ('completed', 'cancelled', 'judgement_waiting')`,
        workId,
      );
      for (const task of tasks) {
        reduceTaskInTransaction(transaction, task.id, {
          event: "work.paused",
          payload: { work_paused: true },
        });
      }
      return { data: { work_id: workId, state: "paused", signal: "pause_requested" }, version: result.next.state_version };
    });
    this.workDriver.unregister(workId);
    return response;
  }

  public async resumeWork(
    workId: string,
    request: CommandRequest<JsonObject>,
  ): Promise<CommandResponse<{ work_id: string; state: "running" }>> {
    const response: CommandResponse<{ work_id: string; state: "running" }> = await this.runCommand(request, {
      type: "work.resumed",
      workId,
      payload: { work_id: workId },
    }, (transaction) => {
      const result = reduceWorkInTransaction(transaction, workId, {
        event: "work.resumed",
        expected_version: request.expected_version,
        payload: { reconciled: true },
      });
      const pausedTasks = transaction.all<{ id: string }>(
        "SELECT id FROM tasks WHERE work_id = ? AND status = 'paused'",
        workId,
      );
      for (const task of pausedTasks) {
        reduceTaskInTransaction(transaction, task.id, {
          event: "work.resumed",
          payload: { dependencies_completed: taskDependenciesCompletedInTransaction(transaction, task.id) },
        });
      }
      // A cascaded Task restored to failed whose dependency recovered while
      // the Work was paused goes back to waiting now (Task row 31).
      restoreCascadedDependentsInTransaction(transaction, workId);
      return { data: { work_id: workId, state: "running" }, version: result.next.state_version };
    });
    this.workDriver.register(workId);
    return response;
  }

  public async resumeWorkOrRetryDecision(
    workId: string,
    request: CommandRequest<ResumeWorkOrRetryPayload>,
  ): Promise<CommandResponse<ResumeWorkOrRetryData>> {
    const event = { type: "work.resume_or_retry", workId };
    const { scopedKey, requestHash } = this.commandScope(request, event);
    const cached = this.db.get<StoredIdempotencyRow>(
      "SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?",
      scopedKey,
    );
    if (cached) {
      if (cached.request_hash !== requestHash) throw idempotencyConflict(scopedKey);
      return parseCommandResponse<ResumeWorkOrRetryData>(cached.response_json, scopedKey);
    }

    const work = this.db.get<{ state: WorkState; state_version: number }>(
      "SELECT state, state_version FROM works WHERE id = ?",
      workId,
    );
    if (!work) throw notFound("work", workId);

    if (work.state === "paused") {
      const response = await this.resumeWork(workId, {
        request_id: request.request_id,
        idempotency_key: request.idempotency_key,
        expected_version: request.expected_version,
        payload: {},
      });
      return this.runConditionalWorkCommand(request, event, () => ({
        data: { work_id: workId, state: response.data.state, resumed_by: "resume", decision_id: null },
        version: response.version,
        events: [],
      }));
    }

    if (work.state === "judgement_waiting" || work.state === "running") {
      // A running Work keeps going while one Task waits on its own Decision, so only task-scoped ones are answerable here.
      const decisions = this.db.all<{ id: string; options_json: string; state_version: number }>(
        `SELECT id, options_json, state_version FROM decisions
          WHERE work_id = ? AND status = 'open' AND (? = 'judgement_waiting' OR scope = 'task')
          ORDER BY id ASC`,
        workId,
        work.state,
      );
      let retryDecision: { id: string; state_version: number; label: string | null } | null = null;
      for (const decision of decisions) {
        try {
          const options = JSON.parse(decision.options_json) as unknown;
          if (!Array.isArray(options)) continue;
          const option = options.find((candidate) => isRecord(candidate) && candidate.key === "retry");
          if (option && isRecord(option)) {
            retryDecision = {
              id: decision.id,
              state_version: decision.state_version,
              label: typeof option.label === "string" ? option.label : null,
            };
            break;
          }
        } catch {
          // Ignore malformed Decisions and inspect the next open one.
        }
      }
      if (retryDecision) {
        if (request.expected_version !== work.state_version) {
          throw versionConflict(request.expected_version, work.state_version);
        }
        await this.answerDecision(retryDecision.id, {
          request_id: request.request_id,
          idempotency_key: request.idempotency_key,
          expected_version: retryDecision.state_version,
          payload: {
            // The body is the Owner's instruction; the answer stays the "retry" option so routing to the Manager is kept.
            answer: request.payload.body ?? retryDecision.label ?? "retry",
            option_key: "retry",
            ...(request.payload.body === undefined ? {} : { option_note: true }),
            source: "advisor",
            source_message_id: null,
          },
        });
        const resumed = this.db.get<{ state: "running" | "judgement_waiting"; state_version: number }>(
          "SELECT state, state_version FROM works WHERE id = ?",
          workId,
        );
        if (!resumed) throw notFound("work", workId);
        return this.runConditionalWorkCommand(request, event, () => ({
          data: { work_id: workId, state: resumed.state, resumed_by: "retry_decision", decision_id: retryDecision.id },
          version: resumed.state_version,
          events: [],
        }));
      }
    }

    throw invalidStateTransition(
      "Only a paused Work, or a Work stopped by an error with a retry option, can be resumed.",
      { work_id: workId, state: work.state, reason: "not_resumable" },
    );
  }

  public async cancelWork(
    workId: string,
    request: CommandRequest<{ reason: string; force?: boolean } & JsonObject>,
  ): Promise<CommandResponse<{ work_id: string; state: "cancelled"; cancel_requested: boolean; worktree_cleanup: WorktreeCleanupResult }>> {
    if (request.payload.reason.length < 1 || request.payload.reason.length > 1000) {
      throw validationError("Cancel reason must contain between 1 and 1,000 characters.", { field: "reason" });
    }
    const closedLaunchRunIds: string[] = [];
    const cancelledDecisionIds: string[] = [];
    const response: CommandResponse<{ work_id: string; state: "cancelled"; cancel_requested: boolean }> = await this.runCommand(request, {
      type: "work.cancelled",
      workId,
      payload: { work_id: workId, reason: request.payload.reason },
    }, (transaction) => {
      // Runs the reducer closes directly (launch_pending, no pid) are still
      // signalled below: the runner may be spawning them right now.
      for (const run of transaction.all<{ id: string }>(
        "SELECT id FROM agent_runs WHERE work_id = ? AND status = 'launch_pending' AND pid IS NULL AND role <> 'executor'",
        workId,
      )) {
        closedLaunchRunIds.push(run.id);
      }
      const result = reduceWorkInTransaction(transaction, workId, {
        event: "work.cancelled",
        expected_version: request.expected_version,
        payload: { owner_cancel: true, manager_unable_owner_choice: false, reason: request.payload.reason },
      });
      if (result.cancelled_decision_ids) cancelledDecisionIds.push(...result.cancelled_decision_ids);
      const tasks = transaction.all<{ id: string }>(
        `SELECT id FROM tasks WHERE work_id = ? AND status NOT IN ('completed', 'cancelled')`,
        workId,
      );
      for (const task of tasks) {
        reduceTaskInTransaction(transaction, task.id, {
          event: "work.cancelled",
          payload: { owner_cancel: true },
        });
      }
      releaseWorkBacklogInTransaction(transaction, workId, utcNow());
      return { data: { work_id: workId, state: "cancelled", cancel_requested: true }, version: result.next.state_version };
    });
    await this.announceDecisionCancellations(cancelledDecisionIds);
    this.workDriver.unregister(workId);
    const unstopped = await this.stopWorkAgents(workId, closedLaunchRunIds, request.payload.force === true);
    if (unstopped.length > 0) return { ...response, data: { ...response.data, worktree_cleanup: agentStopFailure(unstopped) } };
    const project = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId);
    // The row and records stay; only the workspace and Work branches go. A failure is reported, not thrown.
    const worktreeCleanup = await this.purgeWorkWorkspace(workId, project?.project_id ?? null);
    return { ...response, data: { ...response.data, worktree_cleanup: worktreeCleanup } };
  }

  /**
   * Signal every active Agent of the Work, then wait up to `agentStopWaitMs`
   * for the runs to leave their active status. Returns the ids of runs whose
   * process is still alive after the wait; callers must not remove the
   * workspace under them.
   *
   * Why not remove anyway: nothing downstream sweeps survivors, so the Agent
   * would keep writing into a vanished worktree. Why not count every DB-active
   * run: a run left `running` by a crash has no process, and would make cancel
   * and delete fail forever. Only a run whose process is not confirmed gone
   * counts as unstopped; an unreadable identity is not evidence of death.
   */
  private async stopWorkAgents(workId: string, closedLaunchRunIds: readonly string[], force: boolean): Promise<string[]> {
    const activeRuns = this.db.all<{ id: string; role: string; pid: number | null; process_start_time: string | null; process_cmdline_sha256: string | null }>(
      `SELECT id, role, pid, process_start_time, process_cmdline_sha256 FROM agent_runs
        WHERE work_id = ?
          AND (status IN ('cancel_requested','running','spawned','launch_pending')
               OR id IN (SELECT value FROM json_each(?)))`,
      workId,
      JSON.stringify(closedLaunchRunIds),
    );
    for (const run of activeRuns) {
      try {
        // Child runs and observed subagents are not AgentRunner
        // processes; stop them through their recorded process identity.
        if (run.role === "executor") signalRecordedProcess(run, force ? "SIGKILL" : "SIGTERM");
        else if (this.options.agentRunner.cancelAgent) await this.options.agentRunner.cancelAgent(run.id, force);
        else if (run.pid && processIdentityMatches(
          { process_start_time: run.process_start_time, process_cmdline_sha256: run.process_cmdline_sha256 },
          readProcessIdentity(run.pid),
        )) {
          signalProcessGroup(run.pid, force ? "SIGKILL" : "SIGTERM");
        }
      } catch (error) {
        console.error(`[owl-core] Failed to signal cancelled Agent ${run.id}`, error);
      }
    }
    const deadline = Date.now() + (this.options.agentStopWaitMs ?? AGENT_STOP_WAIT_MS);
    while (Date.now() < deadline) {
      const active = this.db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM agent_runs WHERE work_id = ? AND status IN (${ACTIVE_AGENT_RUN_STATUSES_SQL})`,
        workId,
      )?.count ?? 0;
      if (active === 0) return [];
      await new Promise((resolveWait) => setTimeout(resolveWait, AGENT_STOP_POLL_MS));
    }
    return this.db.all<{ id: string; pid: number | null; process_start_time: string | null; process_cmdline_sha256: string | null }>(
      `SELECT id, pid, process_start_time, process_cmdline_sha256 FROM agent_runs
        WHERE work_id = ? AND status IN (${ACTIVE_AGENT_RUN_STATUSES_SQL})`,
      workId,
    ).filter((run) => run.pid !== null && !isRecordedProcessGone(run, run.pid)).map((run) => run.id);
  }

  private async purgeWorkWorkspace(workId: string, projectId: string | null): Promise<WorktreeCleanupResult> {
    const cleanup = await cleanupWorkForDeletion({
      db: this.db,
      writeLane: this.writeLane,
      git: this.git,
      owlRoot: this.owlRoot,
      dataDir: this.dataDir,
    }, workId);
    if (!cleanup.ok || projectId === null || !this.git.deleteWorkBranches) return cleanup;
    try { return await this.git.deleteWorkBranches({ work_id: workId, project_id: projectId }); }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error), details: { stage: "branch_delete" } }; }
  }

  public async archiveWork(
    workId: string,
    request: CommandRequest<JsonObject>,
  ): Promise<CommandResponse<{ work_id: string; archived_at: string | null }>> {
    const response = await this.runConditionalWorkCommand(request, { type: "work.archived", workId }, (transaction) => {
      const now = utcNow();
      const result = setWorkArchivedInTransaction(transaction, workId, request.expected_version, true, now);
      return {
        data: { work_id: workId, archived_at: result.archived_at },
        version: result.state_version,
        events: result.changed ? [{ type: "work.archived", payload: { work_id: workId, archived_at: result.archived_at }, createdAt: now }] : [],
      };
    });
    // sweep() never rejects and logs its own failures; archiving must not wait on it.
    void this.workspaceSweeper.sweep({ workId: safeSegment(workId) });
    return response;
  }

  public async unarchiveWork(
    workId: string,
    request: CommandRequest<JsonObject>,
  ): Promise<CommandResponse<{ work_id: string; archived_at: null }>> {
    return this.runConditionalWorkCommand(request, { type: "work.unarchived", workId }, (transaction) => {
      const now = utcNow();
      const result = setWorkArchivedInTransaction(transaction, workId, request.expected_version, false, now);
      return {
        data: { work_id: workId, archived_at: null },
        version: result.state_version,
        events: result.changed ? [{ type: "work.unarchived", payload: { work_id: workId, archived_at: null }, createdAt: now }] : [],
      };
    });
  }

  public async deleteWork(
    workId: string,
    request: CommandRequest<JsonObject>,
  ): Promise<CommandResponse<{ work_id: string; deleted: true }>> {
    if (!isUlidLike(workId)) throw validationError("Work id must be a canonical ULID.", { work_id: workId });
    const scopedKey = ["work.delete", workId, "-", "-", "-", request.idempotency_key].join(":");
    const work = this.db.get<{ state: string; archived_at: string | null; state_version: number; project_id: string | null }>(
      "SELECT state, archived_at, state_version, project_id FROM works WHERE id = ?",
      workId,
    );
    assertWorkDeletable(workId, work, request.expected_version);
    const projectId = work?.project_id ?? null;
    assertNoOpenDecisions(this.db, workId);
    await this.stopWorkAdvisorSessions(workId);
    const unstopped = await this.stopWorkAgents(workId, [], true);
    if (unstopped.length > 0) throw worktreeCleanupError(workId, agentStopFailure(unstopped));

    const cleanup = await cleanupWorkForDeletion({
      db: this.db,
      writeLane: this.writeLane,
      git: this.git,
      owlRoot: this.owlRoot,
      dataDir: this.dataDir,
    }, workId);
    if (!cleanup.ok && cleanup.details?.stage === "work_lookup") throw notFound("work", workId);
    if (!cleanup.ok) throw worktreeCleanupError(workId, cleanup);

    let artifactFiles: string[] = [];
    let outputDirs: string[] = [];
    try {
      const response = await this.writeLane.transact((transaction) => {
        const current = transaction.get<{ state: string; archived_at: string | null; state_version: number }>(
          "SELECT state, archived_at, state_version FROM works WHERE id = ?",
          workId,
        );
        assertWorkDeletable(workId, current, request.expected_version);
        assertNoOpenDecisions(transaction, workId);

        const taskIds = transaction.all<{ id: string }>("SELECT id FROM tasks WHERE work_id = ?", workId).map((row) => row.id);
        const runIds = transaction.all<{ id: string }>("SELECT id FROM agent_runs WHERE work_id = ?", workId).map((row) => row.id);
        const decisionIds = transaction.all<{ id: string }>("SELECT id FROM decisions WHERE work_id = ?", workId).map((row) => row.id);
        const taskJson = JSON.stringify(taskIds);
        const runJson = JSON.stringify(runIds);
        const decisionJson = JSON.stringify(decisionIds);
        const convIds = transaction.all<{ id: string }>("SELECT id FROM conversations WHERE work_id = ?", workId).map((row) => row.id);
        const convJson = JSON.stringify(convIds);
        const eventIds = transaction.all<{ id: string }>(
          `SELECT id FROM events
            WHERE work_id = ?
               OR (work_id IS NULL AND (task_id IN (SELECT value FROM json_each(?)) OR agent_run_id IN (SELECT value FROM json_each(?))))`,
          workId,
          taskJson,
          runJson,
        ).map((row) => row.id);
        const eventJson = JSON.stringify(eventIds);
        const reportIds = transaction.all<{ id: string }>(
          `SELECT id FROM reports
            WHERE agent_run_id IN (SELECT value FROM json_each(?))
               OR id IN (SELECT report_id FROM agent_runs WHERE report_id IS NOT NULL AND work_id = ?)`,
          runJson,
          workId,
        ).map((row) => row.id);
        const reportJson = JSON.stringify(reportIds);

        for (const related of transaction.all<{ id: string; related_work_ids_json: string }>(
          "SELECT id, related_work_ids_json FROM works WHERE id <> ?",
          workId,
        )) {
          const ids = JSON.parse(related.related_work_ids_json) as unknown;
          if (!Array.isArray(ids) || !ids.includes(workId)) continue;
          transaction.run(
            "UPDATE works SET related_work_ids_json = ? WHERE id = ?",
            JSON.stringify(ids.filter((id) => id !== workId)),
            related.id,
          );
        }
        for (const id of [workId, ...taskIds, ...runIds, ...decisionIds, ...reportIds, ...eventIds, ...convIds]) {
          transaction.run(
            "DELETE FROM idempotency_keys WHERE key <> ? AND (instr(key, ?) > 0 OR instr(response_json, ?) > 0)",
            scopedKey,
            id,
            id,
          );
        }

        const now = utcNow();
        const uploads = transaction.all<{ id: string; artifact_id: string | null; shared_copy_path: string | null }>(
          `SELECT id, artifact_id, shared_copy_path FROM inbound_uploads
            WHERE work_id = ? OR (work_id IS NULL AND conversation_id IN (SELECT value FROM json_each(?)))`,
          workId,
          convJson,
        );
        const uploadJson = JSON.stringify(uploads.map((upload) => upload.id));
        // Another Work's artifacts are never ours, even when an upload or task points at them.
        const artifacts = transaction.all<{ id: string; path: string }>(
          `SELECT id, path FROM artifacts
            WHERE work_id = ?
               OR (work_id IS NULL AND (task_id IN (SELECT value FROM json_each(?)) OR source_event_id IN (SELECT value FROM json_each(?))
                   OR id IN (SELECT value FROM json_each(?))))`,
          workId,
          taskJson,
          eventJson,
          JSON.stringify(uploads.map((upload) => upload.artifact_id).filter((id) => id !== null)),
        );
        const artifactJson = JSON.stringify(artifacts.map((artifact) => artifact.id));
        // Delete a file only if its real path is inside data/, outside knowledge/, and no other row still uses it.
        // Paths are compared by real path, so "./x", symlinks and the like cannot hide a shared file.
        const dataRoot = realPathOrResolve(this.dataDir) + sep;
        const knowledgeRoot = realPathOrResolve(join(this.owlRoot, "knowledge")) + sep;
        const real = (path: string) => realPathOrResolve(resolve(this.owlRoot, path));
        const inUse = new Set<string>([
          ...transaction.all<{ path: string }>("SELECT path FROM artifacts WHERE id NOT IN (SELECT value FROM json_each(?))", artifactJson).map((row) => real(row.path)),
          ...transaction.all<{ path: string }>(
            "SELECT shared_copy_path AS path FROM inbound_uploads WHERE shared_copy_path IS NOT NULL AND id NOT IN (SELECT value FROM json_each(?))",
            uploadJson,
          ).map((row) => real(row.path)),
        ]);
        const outputFiles: string[] = [];
        const walk = (dir: string): void => {
          let entries;
          try { entries = readdirSync(dir, { withFileTypes: true }); } catch (error) {
            // A missing output directory is expected; anything else leaves files behind while the Work delete still succeeds.
            if (!isNodeMissingFileError(error)) console.warn(`[owl-core] Could not list the output directory ${dir} while deleting Work ${workId}`, error);
            return;
          }
          for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); outputDirs.push(full); }
            else outputFiles.push(full);
          }
        };
        outputDirs = [];
        walk(join(this.dataDir, "outputs", workId));
        outputDirs.push(join(this.dataDir, "outputs", workId));
        artifactFiles = [...new Set([
          ...artifacts.map((artifact) => real(artifact.path)),
          ...uploads.filter((upload) => upload.artifact_id === null).map((upload) => real(join(this.dataDir, "uploads", ".tmp", `${upload.id}.part`))),
          ...uploads.flatMap((upload) => (upload.shared_copy_path ? [real(upload.shared_copy_path)] : [])),
          ...outputFiles.map(real),
        ])].filter((file) => file.startsWith(dataRoot) && !file.startsWith(knowledgeRoot) && !inUse.has(file) && isRegularFile(file));
        const messageJson = JSON.stringify(
          transaction.all<{ id: string }>(
            "SELECT id FROM messages WHERE conversation_id IN (SELECT value FROM json_each(?))",
            convJson,
          ).map((row) => row.id),
        );
        transaction.run("DELETE FROM inbound_receipts WHERE message_id IN (SELECT value FROM json_each(?))", messageJson);
        transaction.run("UPDATE inbound_receipts SET event_id = NULL WHERE event_id IN (SELECT value FROM json_each(?))", eventJson);
        transaction.run("DELETE FROM advisor_turns WHERE conversation_id IN (SELECT value FROM json_each(?))", convJson);
        transaction.run("DELETE FROM advisor_compactions WHERE conversation_id IN (SELECT value FROM json_each(?))", convJson);
        transaction.run("DELETE FROM advisor_sessions WHERE conversation_id IN (SELECT value FROM json_each(?))", convJson);
        transaction.run("DELETE FROM conversation_summaries WHERE conversation_id IN (SELECT value FROM json_each(?))", convJson);
        transaction.run(
          "DELETE FROM inbound_uploads WHERE id IN (SELECT value FROM json_each(?))",
          uploadJson,
        );
        transaction.run("DELETE FROM messages WHERE conversation_id IN (SELECT value FROM json_each(?))", convJson);
        transaction.run("DELETE FROM conversations WHERE id IN (SELECT value FROM json_each(?))", convJson);
        transaction.run("DELETE FROM artifacts WHERE id IN (SELECT value FROM json_each(?))", artifactJson);
        transaction.run("DELETE FROM learning_jobs WHERE work_id = ?", workId);
        transaction.run(
          "DELETE FROM skill_usages WHERE work_id = ? OR (work_id IS NULL AND agent_run_id IN (SELECT value FROM json_each(?)))",
          workId,
          runJson,
        );
        for (const table of ["skill_revisions", "skill_proposals"]) {
          transaction.run(`UPDATE ${table} SET source_work_id = NULL WHERE source_work_id = ?`, workId);
          transaction.run(`UPDATE ${table} SET source_agent_run_id = NULL WHERE source_agent_run_id IN (SELECT value FROM json_each(?))`, runJson);
        }
        // Drop references to this Work / its runs inside JSON text, keeping the rest of the body.
        const goneIds = new Set<string>([workId, ...runIds]);
        // Only values under reference keys change; reason, files, meta and other bodies stay as they are.
        const refKey = /^(source_|related_)?(work|agent_run)_ids?$/;
        const scrub = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(scrub);
          if (value === null || typeof value !== "object") return value;
          return Object.fromEntries(Object.entries(value).map(([key, item]) => {
            if (refKey.test(key)) {
              if (typeof item === "string" && goneIds.has(item)) return [key, null];
              if (Array.isArray(item)) return [key, item.filter((id) => !(typeof id === "string" && goneIds.has(id)))];
            }
            return [key, scrub(item)];
          }));
        };
        for (const table of ["skill_proposals", "skills", "skill_revisions", "rule_proposals", "curation_runs"]) {
          const columns = transaction.all<{ name: string; type: string }>(`PRAGMA table_info(${table})`)
            .filter((column) => column.type.toUpperCase() === "TEXT" && !column.name.endsWith("_id")).map((column) => column.name);
          for (const column of columns) {
            for (const id of goneIds) {
              for (const row of transaction.all<{ rowid: number; value: string }>(`SELECT rowid, ${column} AS value FROM ${table} WHERE instr(${column}, ?) > 0`, id)) {
                let parsed: unknown;
                // Why not log: every TEXT column is scanned, so values that are not JSON are expected and have nothing to scrub.
                try { parsed = JSON.parse(row.value); } catch { continue; }
                if (parsed === null || typeof parsed !== "object") continue;
                transaction.run(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`, JSON.stringify(scrub(parsed)), row.rowid);
              }
            }
          }
        }
        transaction.run("UPDATE provider_pauses SET last_work_id = NULL WHERE last_work_id = ?", workId);
        transaction.run("UPDATE provider_pauses SET last_task_id = NULL WHERE last_task_id IN (SELECT value FROM json_each(?))", taskJson);
        transaction.run("DELETE FROM rule_proposal_sources WHERE source_kind = 'work' AND source_ref = ?", workId);
        for (const proposal of transaction.all<{ id: string; source_work_ids_json: string }>(
          "SELECT id, source_work_ids_json FROM rule_proposals WHERE instr(source_work_ids_json, ?) > 0",
          workId,
        )) {
          const ids = JSON.parse(proposal.source_work_ids_json) as unknown;
          if (!Array.isArray(ids)) continue;
          transaction.run("UPDATE rule_proposals SET source_work_ids_json = ? WHERE id = ?", JSON.stringify(ids.filter((id) => id !== workId)), proposal.id);
        }
        transaction.run("UPDATE secret_audit SET agent_run_id = NULL WHERE agent_run_id IN (SELECT value FROM json_each(?))", runJson);

        // Break reference cycles among this Work's own rows only.
        transaction.run("UPDATE agent_runs SET parent_agent_id = NULL, retry_of_run_id = NULL, report_id = NULL WHERE work_id = ?", workId);
        transaction.run("UPDATE tasks SET parent_task_id = NULL, lineage_root_task_id = NULL WHERE work_id = ?", workId);
        transaction.run("DELETE FROM task_change_measurements WHERE work_id = ?", workId);
        transaction.run(
          `DELETE FROM task_dependencies
            WHERE task_id IN (SELECT value FROM json_each(?)) OR depends_on_task_id IN (SELECT value FROM json_each(?))`,
          taskJson,
          taskJson,
        );
        detachWorkBacklogOnDeleteInTransaction(transaction, workId, now);
        transaction.run("DELETE FROM backlog_items WHERE work_id = ?", workId);
        transaction.run("DELETE FROM reviews WHERE task_id IN (SELECT value FROM json_each(?))", taskJson);
        transaction.run("DELETE FROM decision_answers WHERE decision_id IN (SELECT value FROM json_each(?))", decisionJson);
        transaction.run(
          `DELETE FROM agent_activity
            WHERE work_id = ?
               OR (work_id IS NULL AND (task_id IN (SELECT value FROM json_each(?))
                   OR agent_run_id IN (SELECT value FROM json_each(?))
                   OR source_event_id IN (SELECT value FROM json_each(?))))`,
          workId,
          taskJson,
          runJson,
          eventJson,
        );
        transaction.run("DELETE FROM outbox_deliveries WHERE event_id IN (SELECT value FROM json_each(?))", eventJson);
        transaction.run("DELETE FROM reports WHERE id IN (SELECT value FROM json_each(?))", reportJson);
        transaction.run("DELETE FROM events WHERE id IN (SELECT value FROM json_each(?))", eventJson);
        transaction.run("DELETE FROM agent_runs WHERE work_id = ?", workId);
        transaction.run("DELETE FROM tasks WHERE work_id = ?", workId);
        transaction.run("DELETE FROM decisions WHERE work_id = ?", workId);
        transaction.run("DELETE FROM work_summary_revisions WHERE work_id = ?", workId);
        transaction.run("DELETE FROM works WHERE id = ?", workId);

        const response: CommandResponse<{ work_id: string; deleted: true }> = {
          request_id: request.request_id,
          data: { work_id: workId, deleted: true },
          version: current?.state_version ?? 0,
        };
        // No idempotency row: its key and response carry the Work id, and a delete leaves no trace.
        return response;
      });
      this.workDriver.unregister(workId);
      for (const file of artifactFiles) {
        await rm(file, { recursive: true, force: true }).catch((error) => console.warn(`[owl-core] Deleted Work ${workId}, but ${file} could not be removed`, error));
      }
      // Output directories go only when empty: files another Work still uses stay.
      for (const dir of outputDirs) await rmdir(dir).catch(() => undefined);
      try {
        await rm(designDocumentPath(this.dataDir, workId), { recursive: true, force: true });
      } catch (error) {
        console.warn(`[owl-core] Deleted Work ${workId}, but its design documents could not be removed`, error);
        await this.recordOrphanedDesignDocuments(workId, error);
      }
      try {
        await rm(taskReportPath(this.dataDir, workId), { recursive: true, force: true });
      } catch (error) {
        console.warn(`[owl-core] Deleted Work ${workId}, but its task reports could not be removed`, error);
      }
      if (projectId !== null && this.git.deleteWorkBranches) {
        // Branches go only after the delete committed; a failure leaves them
        // behind and is reported without undoing the delete.
        try {
          const branches = await this.git.deleteWorkBranches({ work_id: workId, project_id: projectId });
          if (!branches.ok) console.warn(`[owl-core] Deleted Work ${workId}, but its branches could not be deleted: ${branches.message}`);
        } catch (error) {
          console.warn(`[owl-core] Deleted Work ${workId}, but its branches could not be deleted`, error);
        }
      }
      if (this.git.sweepAdvisorWorkspaces) {
        try { await this.git.sweepAdvisorWorkspaces(); }
        catch (error) { console.warn(`[owl-core] Advisor workspace sweep failed after deleting Work ${workId}`, error); }
      }
      return response;
    } catch (error) {
      if (error instanceof ReplayCommand) return error.response as CommandResponse<{ work_id: string; deleted: true }>;
      throw humanizeUnexpected(error, "work.delete");
    }
  }

  private async stopWorkAdvisorSessions(workId: string): Promise<void> {
    const sessions = this.db.all<{ id: string }>(
      `SELECT advisor_sessions.id AS id
         FROM advisor_sessions
         JOIN conversations ON conversations.id = advisor_sessions.conversation_id
        WHERE conversations.work_id = ? AND advisor_sessions.status <> 'ended'`,
      workId,
    );
    for (const session of sessions) {
      if (!this.advisorRuntime) {
        throw dependencyUnavailable("The Advisor session runtime is unavailable; stop its session before deleting this Work.", { session_id: session.id });
      }
      try {
        await this.advisorRuntime.stopSession(session.id, "cleared");
      } catch (error) {
        throw dependencyUnavailable("An Advisor session could not be stopped before deleting this Work.", {
          session_id: session.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const activeTurns = this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM advisor_turns
        WHERE conversation_id IN (SELECT id FROM conversations WHERE work_id = ?)
          AND status IN ('queued', 'running')`,
      workId,
    )?.count ?? 0;
    if (activeTurns > 0) {
      throw dependencyUnavailable("Advisor turns are still queued or running for this Work.", { work_id: workId, active_turns: activeTurns });
    }
  }

  public async reopenWork(
    workId: string,
    request: CommandRequest<{ reason?: string } & JsonObject>,
  ): Promise<CommandResponse<{ work_id: string; state: "running" }>> {
    const reason = request.payload.reason ?? "";
    const response = await this.runConditionalWorkCommand(request, { type: "work.reopened", workId }, (transaction) => {
      const current = transaction.get<{ state: WorkState; archived_at: string | null }>(
        "SELECT state, archived_at FROM works WHERE id = ?",
        workId,
      );
      if (!current) throw notFound("work", workId);
      const now = utcNow();
      const events: { type: string; payload: JsonObject; createdAt: string }[] = [];
      if (current.state === "completed" && current.archived_at !== null) {
        setWorkArchivedInTransaction(transaction, workId, request.expected_version, false, now);
        events.push({ type: "work.unarchived", payload: { work_id: workId, archived_at: null }, createdAt: now });
      }
      const result = reduceWorkInTransaction(transaction, workId, {
        event: "work.reopened",
        expected_version: request.expected_version,
        payload: { valid_reopen: true, now },
      });
      // Every Task is already completed, so the next tick would only re-run
      // the final review. Hand the Owner's reason to the Manager instead so it
      // can add the Tasks the reopen asks for.
      queueOwnerReplanInTransaction(transaction, workId, {
        kind: "reopen",
        answer: reason.trim() || "The Owner reopened the completed Work without giving a reason.",
        ...(reason.trim() ? { requests: [{ kind: "reopen" as const, text: reason, message_ids: [] }] } : {}),
      });
      events.push({ type: "work.reopened", payload: { work_id: workId, reason }, createdAt: now });
      return { data: { work_id: workId, state: "running" as const }, version: result.next.state_version, events };
    });
    this.workDriver.register(workId);
    return response;
  }

  public async updateWork(
    workId: string,
    request: CommandRequest<UpdateWorkPayload>,
  ): Promise<CommandResponse<UpdateWorkData>> {
    const { title, summary } = request.payload;
    if (title === undefined && summary === undefined) {
      throw validationError("Specify a new title or summary.", { field: "title" });
    }
    if (title !== undefined && (typeof title !== "string" || title.trim().length < 1 || title.length > 500)) {
      throw validationError("Work title must contain between 1 and 500 characters.", { field: "title" });
    }
    if (summary !== undefined && (typeof summary !== "string" || summary.length > 20000)) {
      throw validationError("Work summary cannot exceed 20,000 characters.", { field: "summary" });
    }

    const response = await this.runConditionalWorkCommand(request, { type: "work.updated", workId }, (transaction) => {
      const now = utcNow();
      const result = updateWorkFieldsInTransaction(transaction, workId, request.expected_version, { title, summary }, now);
      recordOwnerWorkSummaryRevisionInTransaction(transaction, { work_id: workId, before: result.before, after: result.after, changed_fields: result.changed_fields, now });
      const replanQueued = result.changed_fields.length > 0 &&
        (result.before.state === "running" || result.before.state === "paused" || result.before.state === "judgement_waiting");
      if (replanQueued) {
        mergeOwnerReplanInTransaction(transaction, workId, {
          kind: "work_update",
          answer: workUpdateReplanAnswer(result.before, result.after, result.changed_fields),
          requests: [{ kind: "work_update", changed_fields: result.changed_fields, previous_title: result.before.title, previous_summary: result.before.summary }],
        });
      }
      return {
        data: {
          work_id: workId,
          title: result.after.title,
          summary: result.after.summary,
          state: result.before.state,
          changed_fields: result.changed_fields,
          replan_queued: replanQueued,
        },
        version: result.before.state_version,
        events: result.changed_fields.length > 0
          ? [{ type: "work.updated", payload: { work_id: workId, changed_fields: result.changed_fields, title: result.after.title }, createdAt: now }]
          : [],
      };
    });
    if (response.data.replan_queued && (response.data.state === "running" || response.data.state === "judgement_waiting")) this.workDriver.wake(workId);
    return response;
  }

  public async postWorkInstruction(
    workId: string,
    request: CommandRequest<{ body: string; attachment_ids?: string[]; reopen?: boolean }>,
  ): Promise<CommandResponse<{ work_id: string; conversation_id: string; message_id: string; status: "queued" }>> {
    const body = request.payload.body;
    if (typeof body !== "string" || body.trim().length < 1 || body.length > 100000) {
      throw validationError("Instruction body must contain between 1 and 100,000 characters.", { field: "body" });
    }
    const attachmentIds = request.payload.attachment_ids ?? [];
    if (!Array.isArray(attachmentIds) || !attachmentIds.every((item): item is string => typeof item === "string")) {
      throw validationError("Instruction attachment_ids must be an array of strings.", { field: "attachment_ids" });
    }
    const reopen = request.payload.reopen === true;
    let reopened = false;
    const response = await this.runConditionalWorkCommand(request, { type: "message.posted", workId }, (transaction) => {
      const work = transaction.get<{ state: WorkState; archived_at: string | null; owner_id: string }>(
        "SELECT state, archived_at, owner_id FROM works WHERE id = ?",
        workId,
      );
      if (!work) throw notFound("work", workId);
      if (work.state === "memo" || work.state === "ready") {
        throw invalidStateTransition("Start the Work before sending an instruction.", { work_id: workId, state: work.state });
      }
      if (work.state === "cancelled") throw workCancelled(workId);
      if (work.state === "completed" && !reopen) throw workReopenRequired(workId);
      const now = utcNow();
      const events: { type: string; payload: JsonObject; createdAt: string }[] = [];
      let version = 0;
      if (work.state === "completed") {
        if (work.archived_at !== null) {
          setWorkArchivedInTransaction(transaction, workId, request.expected_version, false, now);
          events.push({ type: "work.unarchived", payload: { work_id: workId, archived_at: null }, createdAt: now });
        }
        const result = reduceWorkInTransaction(transaction, workId, {
          event: "work.reopened",
          expected_version: request.expected_version,
          payload: { valid_reopen: true, now },
        });
        version = result.next.state_version;
        events.push({ type: "work.reopened", payload: { work_id: workId, reason: body }, createdAt: now });
        reopened = true;
      }
      ensureOwner(transaction, work.owner_id, now);
      let conversation = transaction.get<{ id: string }>(
        `SELECT id FROM conversations
          WHERE work_id = ? AND channel = 'web' AND is_active = 1 AND archived_at IS NULL`,
        workId,
      );
      if (!conversation) {
        conversation = { id: createUlid() };
        transaction.run(
          `INSERT INTO conversations (id, owner_id, work_id, channel, is_active, created_at, updated_at)
           VALUES (?, ?, ?, 'web', 1, ?, ?)`,
          conversation.id, work.owner_id, workId, now, now,
        );
      }
      let account = transaction.get<{ id: string }>(
        "SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'",
        work.owner_id,
      );
      if (!account) {
        account = { id: createUlid() };
        transaction.run(
          `INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at)
           VALUES (?, ?, 'web', ?, ?)`,
          account.id, work.owner_id, work.owner_id === DEFAULT_OWNER_ID ? "web-default" : `web-${work.owner_id}`, now,
        );
      }
      const messageId = createUlid();
      transaction.run(
        `INSERT INTO messages
           (id, conversation_id, provider, account_id, source_message_id, body,
            attachment_ids_json, received_at, created_at)
         VALUES (?, ?, 'web', ?, ?, ?, ?, ?, ?)`,
        messageId,
        conversation.id,
        account.id,
        `api:${conversation.id}:${request.idempotency_key}`,
        body,
        JSON.stringify(attachmentIds),
        now,
        now,
      );
      mergeOwnerReplanInTransaction(transaction, workId, { kind: "instruction", answer: body, message_ids: [messageId] });
      if (work.state === "judgement_waiting") {
        // The instruction restarts the Work through the Manager's replan, so it answers the Decisions that held the Work.
        const open = transaction.all<{ id: string; state_version: number }>(
          "SELECT id, state_version FROM decisions WHERE work_id = ? AND status = 'open' ORDER BY scope = 'work', id",
          workId,
        );
        for (const decision of open) {
          resolveDecisionInTransaction(transaction, {
            decision_id: decision.id,
            expected_version: decision.state_version,
            answerer_id: work.owner_id,
            answer: body,
            option_key: null,
            source: "web",
            source_message_id: messageId,
            to_manager: true,
            by_instruction: true,
          });
          events.push({ type: "decision.resolved", payload: { decision_id: decision.id, answer: body }, createdAt: now });
        }
      }
      events.push({ type: "message.posted", payload: { kind: "message_posted", schema_version: "1.0.0" }, createdAt: now });
      return {
        data: { work_id: workId, conversation_id: conversation.id, message_id: messageId, status: "queued" as const },
        version,
        events,
      };
    });
    if (reopened) this.workDriver.register(workId);
    else this.workDriver.wake(workId);
    return response;
  }

  public async cancelAgent(
    agentRunId: string,
    request: CommandRequest<CancelAgentPayload>,
  ): Promise<CommandResponse<{ agent_run_id: string; status: "cancel_requested" | "cancelled" }>> {
    if (request.payload.reason.length < 1 || request.payload.reason.length > 1000) {
      throw validationError("Cancel reason must contain between 1 and 1,000 characters.", { field: "reason" });
    }
    const force = request.payload.force === true;
    const response = await this.runCommand(request, {
      type: "agent.cancelled",
      agentRunId,
      payload: { agent_run_id: agentRunId, reason: request.payload.reason, force },
    }, (transaction) => {
      const row = transaction.get<{ id: string; status: string; task_id: string | null; role: string }>(
        `SELECT id, status, task_id, role FROM agent_runs WHERE id = ?`,
        agentRunId,
      );
      if (!row) {
        throw notFound("agent_run", agentRunId);
      }
      if (row.status === "completed" || row.status === "failed" || row.status === "spawn_failed" || row.status === "cancelled") {
        throw invalidStateTransition(`Agent run is already terminal (status=${row.status}).`, { status: row.status });
      }
      const status: "cancel_requested" | "cancelled" = force ? "cancelled" : "cancel_requested";
      const now = utcNow();
      transaction.run(
        `UPDATE agent_runs SET status = ?, ended_at = CASE WHEN ? THEN ? ELSE ended_at END, updated_at = ? WHERE id = ?`,
        status,
        force ? 1 : 0,
        now,
        now,
        agentRunId,
      );
      // Releasing an AgentRun without reconciling its Task would leave a
      // running/verifying Task with no driver eligible to make progress.
      // Reuse the deterministic crash path, but keep the AgentRun's final
      // status as cancelled so a late provider result is ignored.
      // Cancelling an executor stops only that subprocess: its Worker keeps
      // driving the Task and sees the executor as failed.
      if (row.task_id && row.role !== "executor") {
        const task = transaction.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", row.task_id);
        if (task?.status === "running" || (row.role === "reviewer" && task?.status === "verifying")) {
          reduceTaskInTransaction(transaction, row.task_id, {
            event: "agent.crashed",
            payload: {
              role: row.role,
              report_present: false,
              error_key: "owner_cancelled_agent",
            },
          });
          transaction.run(
            "UPDATE agent_runs SET status = ?, ended_at = CASE WHEN ? THEN ? ELSE ended_at END, updated_at = ? WHERE id = ?",
            status,
            force ? 1 : 0,
            now,
            now,
            agentRunId,
          );
        }
      }
      return { data: { agent_run_id: agentRunId, status }, version: 0 };
    });
    const active = this.db.get<{ role: string; pid: number | null; process_start_time: string | null; process_cmdline_sha256: string | null }>(
      "SELECT role, pid, process_start_time, process_cmdline_sha256 FROM agent_runs WHERE id = ? AND status IN ('cancel_requested','cancelled')",
      agentRunId,
    );
    // Subagents of a cancelled run have nobody left to report to.
    const children = this.db.all<{ pid: number | null; process_start_time: string | null; process_cmdline_sha256: string | null }>(
      "SELECT pid, process_start_time, process_cmdline_sha256 FROM agent_runs WHERE parent_agent_id = ? AND role = 'executor' AND status IN ('launch_pending','spawned','running','cancel_requested')",
      agentRunId,
    );
    for (const child of children) signalRecordedProcess(child, force ? "SIGKILL" : "SIGTERM");
    try {
      if (active?.role === "executor") {
        signalRecordedProcess(active, force ? "SIGKILL" : "SIGTERM");
      } else if (this.options.agentRunner.cancelAgent) {
        await this.options.agentRunner.cancelAgent(agentRunId, force);
      } else if (active?.pid && processIdentityMatches(
        { process_start_time: active.process_start_time, process_cmdline_sha256: active.process_cmdline_sha256 },
        readProcessIdentity(active.pid),
      )) {
        signalProcessGroup(active.pid, force ? "SIGKILL" : "SIGTERM");
      }
    } catch (error) {
      await this.writeLane.write({
        mutateState: (transaction) => {
          const now = utcNow();
          transaction.run("UPDATE agent_runs SET updated_at = ? WHERE id = ?", now, agentRunId);
          return { agent_run_id: agentRunId, signal_error: error instanceof Error ? error.message : String(error) };
        },
        event: {
          idempotencyKey: `agent-cancel-signal-failed:${agentRunId}`,
          type: "system.alert",
          agentRunId,
          payload: {
            kind: "agent_cancel_signal_failed",
            agent_run_id: agentRunId,
            message: ownerLanguage(this.db) === "en"
              ? "The Agent cancellation was recorded, but its process could not be signalled and may still be running."
              : "Agentの停止は記録しましたが、プロセスへ停止シグナルを送れませんでした。まだ動いている可能性があります。",
          },
        },
        outbox: [{ provider: "websocket" }],
      });
      throw dependencyUnavailable("The Agent cancellation request was committed, but signaling the provider failed.", { agent_run_id: agentRunId });
    }
    return response;
  }

  public listTasks(workId: string, query: TaskListQuery = {}): ListResponse<TaskSummary> {
    const limit = boundLimit(query.limit ?? 50);
    const rows = this.db.all<TaskDbRow>(
      `SELECT id, work_id, title, status, type, state_version, updated_at, created_at,
              (SELECT json_group_array(depends_on_task_id) FROM task_dependencies WHERE task_id = tasks.id) AS depends_on_json,
              prerequisite_json, prerequisite_since,
              CASE WHEN status = 'judgement_waiting' THEN (
                SELECT reason FROM decisions
                 WHERE status = 'open' AND EXISTS (SELECT 1 FROM json_each(blocked_task_ids_json) WHERE value = tasks.id)
                 ORDER BY created_at DESC LIMIT 1) END AS stop_reason
         FROM tasks
        WHERE work_id = ? AND (? IS NULL OR status = ?)
          AND superseded_at IS NULL
          AND (? IS NULL OR id > ?)
        ORDER BY id ASC LIMIT ?`,
      workId,
      query.status ?? null,
      query.status ?? null,
      query.cursor ?? null,
      query.cursor ?? null,
      limit + 1,
    );
    return listResponse(query.request_id, rows.slice(0, limit).map(toTaskSummary), rows.length > limit, limit);
  }

  public getTask(taskId: string, query: { request_id?: string; include_report?: boolean } = {}): CommandResponse<TaskDetail & { report?: JsonObject | null }> {
    const row = this.db.get<TaskDbRow>(
      `SELECT id, work_id, title, status, type, state_version, updated_at, created_at,
              (SELECT json_group_array(depends_on_task_id) FROM task_dependencies WHERE task_id = tasks.id) AS depends_on_json,
              prerequisite_json, prerequisite_since,
              CASE WHEN status = 'judgement_waiting' THEN (
                SELECT reason FROM decisions
                 WHERE status = 'open' AND EXISTS (SELECT 1 FROM json_each(blocked_task_ids_json) WHERE value = tasks.id)
                 ORDER BY created_at DESC LIMIT 1) END AS stop_reason,
              parent_task_id, acceptance, review_round, total_review_attempts, failure_count, worker_generation
         FROM tasks WHERE id = ?`,
      taskId,
    );
    if (!row) {
      throw notFound("task", taskId);
    }
    const task = toTaskDetail(row);
    const report = query.include_report === true
      ? this.db.get<{ id: string; agent_run_id: string; schema_version: string; result: string; payload_json: string; created_at: string }>(
        `SELECT reports.id, reports.agent_run_id, reports.schema_version, reports.result,
                reports.payload_json, reports.created_at
           FROM reports JOIN agent_runs ON agent_runs.id = reports.agent_run_id
          WHERE agent_runs.task_id = ? ORDER BY reports.created_at DESC LIMIT 1`,
        taskId,
      )
      : undefined;
    const reportPayload = report ? {
      id: report.id,
      agent_run_id: report.agent_run_id,
      schema_version: report.schema_version,
      result: report.result,
      payload: parseStoredJsonObject(report.payload_json, "report", report.id),
      created_at: report.created_at,
    } : null;
    return {
      request_id: query.request_id ?? createUlid(),
      data: { ...task, report: reportPayload },
      version: row.state_version,
    };
  }

  public listDecisions(query: DecisionListQuery = {}): ListResponse<Decision> {
    const limit = boundLimit(query.limit ?? 50);
    const rows = this.db.all<DecisionDbRow>(
      `SELECT id, work_id, scope, status, blocked_task_ids_json, reason, question, current_state, tried,
              options_json, recommended, allow_free_text, state_version, design_block_json
         FROM decisions
        WHERE (? IS NULL OR status = ?)
          AND (? IS NULL OR id > ?)
        ORDER BY id ASC LIMIT ?`,
      query.status ?? null,
      query.status ?? null,
      query.cursor ?? null,
      query.cursor ?? null,
      limit + 1,
    );
    return listResponse(query.request_id, rows.slice(0, limit).map(toDecision), rows.length > limit, limit);
  }

  /**
   * Work detail screen data in one read: the Work, its live Tasks, runs, child runs, the newest report per Task,
   * all of its decisions (every status), and the conversation and assurance (null when they cannot be read).
   */
  public getWorkView(workId: string, query: { conversation_limit?: number } = {}): WorkViewData {
    const work = this.getWork(workId).data;
    const tasks = this.db.all<TaskDbRow>(
      `SELECT id, work_id, title, status, type, state_version, updated_at, created_at,
              (SELECT json_group_array(depends_on_task_id) FROM task_dependencies WHERE task_id = tasks.id) AS depends_on_json,
              prerequisite_json, prerequisite_since,
              CASE WHEN status = 'judgement_waiting' THEN (
                SELECT reason FROM decisions
                 WHERE status = 'open' AND EXISTS (SELECT 1 FROM json_each(blocked_task_ids_json) WHERE value = tasks.id)
                 ORDER BY created_at DESC LIMIT 1) END AS stop_reason
         FROM tasks WHERE work_id = ? AND superseded_at IS NULL ORDER BY id ASC`,
      workId,
    ).map(toTaskSummary);
    const runs = this.db.all<AgentDbRow>(
      `SELECT id, work_id, task_id, role, design_tier, provider, model, effort, status, outcome, pid, started_at, ended_at, last_output_at, parent_agent_id, phase, subtask_count, label, origin
         FROM agent_runs WHERE work_id = ? ORDER BY id ASC`,
      workId,
    ).map(toAgentRun);
    const taskIds = new Set(tasks.map((task) => task.id));
    const reportRows = this.db.all<{ id: string; agent_run_id: string; schema_version: string; result: string; payload_json: string; created_at: string; task_id: string }>(
      `SELECT reports.id, reports.agent_run_id, reports.schema_version, reports.result,
              reports.payload_json, reports.created_at, agent_runs.task_id
         FROM reports JOIN agent_runs ON agent_runs.id = reports.agent_run_id
        WHERE agent_runs.work_id = ? AND agent_runs.task_id IS NOT NULL
        ORDER BY reports.created_at DESC, reports.id DESC`,
      workId,
    );
    const newest = new Map<string, (typeof reportRows)[number]>();
    for (const row of reportRows) if (taskIds.has(row.task_id) && !newest.has(row.task_id)) newest.set(row.task_id, row);
    const reports = [...newest.values()].map((row) => ({
      id: row.id,
      agent_run_id: row.agent_run_id,
      schema_version: row.schema_version,
      result: row.result,
      payload: parseStoredJsonObject(row.payload_json, "report", row.id),
      created_at: row.created_at,
      task_id: row.task_id,
    }));
    const decisions = this.db.all<DecisionDbRow>(
      `SELECT ${DECISION_COLUMNS} FROM decisions WHERE work_id = ? ORDER BY id ASC`,
      workId,
    ).map(toDecision);
    const optional = <T>(read: () => T): T | null => {
      try { return read(); } catch (error) {
        console.warn(`[owl-core] Work view section could not be read for Work ${workId}`, error);
        return null;
      }
    };
    return {
      work,
      tasks,
      runs,
      child_runs: this.childRuns.list({ work_id: workId }),
      reports,
      decisions,
      conversation: optional(() => this.getWorkConversation(workId, { limit: query.conversation_limit ?? DEFAULT_WORK_VIEW_CONVERSATION_LIMIT })) as unknown as WorkViewData["conversation"],
      assurance: optional(() => this.getWorkAssurance(workId)) as unknown as WorkViewData["assurance"],
    };
  }

  /**
   * Board / Archive screen data in one read. `limit` caps the Works of one page; `next_cursor` (opaque) continues
   * after the last returned Work, or is null when nothing is left. Open decisions come with the first page of the
   * Board only; the Archive has none.
   */
  public getBoardView(query: { archived: "exclude" | "only"; limit: number; cursor?: string | null }): BoardViewData {
    const limit = positiveLimit(query.limit);
    const columns = "id, display_number, title, state, state_version, updated_at, archived_at, project_id";
    const cursor = decodeViewCursor(query.cursor, query.archived === "only" ? 2 : 1);
    const rows = query.archived === "only"
      ? this.db.all<WorkDbRow>(
        `SELECT ${columns} FROM works
          WHERE archived_at IS NOT NULL AND (? IS NULL OR archived_at < ? OR (archived_at = ? AND id < ?))
          ORDER BY archived_at DESC, id DESC LIMIT ?`,
        cursor?.[0] ?? null, cursor?.[0] ?? null, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1,
      )
      : this.db.all<WorkDbRow>(
        `SELECT ${columns} FROM works WHERE archived_at IS NULL AND (? IS NULL OR id > ?) ORDER BY id ASC LIMIT ?`,
        cursor?.[0] ?? null, cursor?.[0] ?? null, limit + 1,
      );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const open_decisions = query.archived === "exclude" && !cursor
      ? this.db.all<DecisionDbRow>(`SELECT ${DECISION_COLUMNS} FROM decisions WHERE status = 'open' ORDER BY id ASC`).map(toDecision)
      : [];
    return {
      works: page.map(toWorkSummary),
      open_decisions,
      projects: this.listAllProjects(),
      next_cursor: rows.length > limit && last ? encodeViewCursor(query.archived === "only" ? [last.archived_at ?? "", last.id] : [last.id]) : null,
    };
  }

  /**
   * Works a Backlog item can be linked to: the Project's (or Project-less) Works without cancelled ones, unfinished
   * first, newest update first. Archived Works are included. `next_cursor` continues after the last returned Work.
   */
  public listLinkableWorks(projectId: string | null, query: { limit: number; cursor?: string | null }): LinkableWorksData {
    const limit = positiveLimit(query.limit);
    const cursor = decodeViewCursor(query.cursor, 3);
    const rows = this.db.all<WorkDbRow & { done_rank: number }>(
      `SELECT * FROM (
         SELECT id, display_number, title, state, state_version, updated_at, archived_at, project_id,
                CASE WHEN state = 'completed' THEN 1 ELSE 0 END AS done_rank
           FROM works
          WHERE ((? IS NULL AND project_id IS NULL) OR project_id = ?) AND state != 'cancelled')
        WHERE (? IS NULL OR done_rank > ? OR (done_rank = ? AND (updated_at < ? OR (updated_at = ? AND id < ?))))
        ORDER BY done_rank ASC, updated_at DESC, id DESC LIMIT ?`,
      projectId, projectId,
      cursor?.[0] ?? null, Number(cursor?.[0] ?? 0), Number(cursor?.[0] ?? 0), cursor?.[1] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      works: page.map(toWorkSummary),
      next_cursor: rows.length > limit && last ? encodeViewCursor([String(last.done_rank), last.updated_at, last.id]) : null,
    };
  }

  /** Backlog screen data in one read: the filtered items and the Projects. */
  public getBacklogListView(filter: BacklogListFilter = {}): BacklogViewData {
    const { items, next_offset } = this.listBacklogItems(filter);
    return { items, next_offset, projects: this.listAllProjects() };
  }

  /** Tokens screen data in one read: the usage report, plan usage and its settings, and the Projects. */
  public async getTokensView(input: { readonly period: TokenUsagePeriod; readonly top: number }): Promise<TokensViewData> {
    return {
      report: this.getTokenUsageReport(input),
      plan_usage: await this.getPlanUsage(),
      plan_usage_settings: await this.getPlanUsageSettings(),
      projects: this.listAllProjects(),
    };
  }

  /** Decision screen data in one read: the decision, its Work and every Task it blocks (superseded ones included). */
  public getDecisionView(decisionId: string): DecisionViewData {
    const row = this.db.get<DecisionDbRow>(`SELECT ${DECISION_COLUMNS} FROM decisions WHERE id = ?`, decisionId);
    if (!row) throw notFound("decision", decisionId);
    const decision = toDecision(row);
    const blocked_tasks = decision.blocked_task_ids.flatMap((taskId) => {
      try { return [this.getTask(taskId).data]; } catch (error) {
        // Only a Task that no longer exists is dropped; other failures must not silently shrink the Owner's list.
        if (isCodedError(error) && error.code === "task_not_found") return [];
        throw error;
      }
    });
    return { decision, work: this.getWork(decision.work_id).data, blocked_tasks };
  }

  public async answerDecision(
    decisionId: string,
    request: CommandRequest<{ answer: string; option_key: string | null; source_message_id: string | null } & JsonObject>,
  ): Promise<CommandResponse<{ decision_id: string; status: "resolved"; winner: boolean; resumed_task_ids: readonly string[] }>> {
    const designStop = this.designStopBelongsToManager(decisionId, request.payload.option_key);
    const toManager = this.retryBelongsToManager(decisionId, request.payload.option_key) || designStop;
    // Read before resolving: the stored question and options are what the Manager needs to understand the answer.
    const replanText = designStop ? this.designStopReplanAnswer(decisionId, request.payload.option_key, request.payload.answer) : request.payload.answer;
    const response = await this.decisions.resolve({
      ...request,
      payload: { ...request.payload, decision_id: decisionId, ...(toManager ? { to_manager: true } : {}), ...(request.payload.option_key === REVIEW_RERUN_OPTION_KEY ? { rerun_review: true } : {}) },
    });
    await this.dispatcher.replayPending();
    if (request.payload.option_key === REVIEW_RERUN_OPTION_KEY) this.workflow.rerunPendingReviews();
    await this.handlePolicyDecisionResolved(decisionId, request.payload.option_key);
    const resumedWork = this.db.get<{ work_id: string; state: WorkState; state_version: number; scope: string; issuer_role: "core" | "advisor" | "manager" }>(
      `SELECT decisions.work_id, works.state, works.state_version, decisions.scope, decisions.issuer_role
         FROM decisions JOIN works ON works.id = decisions.work_id
        WHERE decisions.id = ?`,
      decisionId,
    );
    if (
      resumedWork &&
      response.data.winner &&
      isDecisionCancelAnswer(resumedWork, request.payload.option_key) &&
      resumedWork.state !== "completed" &&
      resumedWork.state !== "cancelled"
    ) {
      // The "cancel" option ends the Work instead of resuming it.
      await this.cancelWork(resumedWork.work_id, {
        request_id: request.request_id,
        idempotency_key: `decision-cancel:${decisionId}`,
        expected_version: resumedWork.state_version,
        payload: { reason: `Owner chose to cancel the Work in Decision ${decisionId}.` },
      });
      return response;
    }
    if (resumedWork?.state === "running") {
      // A Work-scope halt on failed Tasks, on an incomplete final verdict, or
      // on a Manager replan that could not be made (issuer_role "manager")
      // would recur on the next tick unchanged. Hand the owner's answer to
      // the Manager as a replan instead. A failed final check or base merge
      // just resumes, so the next tick reruns the check and merge.
      const terminal = resumedWork.scope === "work" && resumedWork.issuer_role !== "advisor" && response.data.winner
        ? this.checkTerminalTasks(resumedWork.work_id)
        : null;
      // Judge by the alert this Decision was opened for, not whatever alert
      // came last. A merge conflict the Owner hands to the Manager is a replan.
      const sourceAlert = this.decisionSourceAlert(decisionId);
      const resolvingConflict = sourceAlert?.kind === "work_merge_failed" &&
        sourceAlert.merge_kind === "conflict" &&
        request.payload.option_key === RESOLVE_CONFLICT_OPTION_KEY;
      const retryingWorkMerge = sourceAlert?.kind === "work_merge_failed" && !resolvingConflict;
      if (
        !retryingWorkMerge &&
        ((toManager && response.data.resumed_task_ids.length > 0) ||
          (terminal !== null &&
            terminal.allTerminal &&
            (terminal.anyFailed ||
              resumedWork.issuer_role === "manager" ||
              resolvingConflict ||
              sourceAlert?.kind === "final_manager_incomplete" ||
              sourceAlert?.kind === WORK_INTEGRATION_ALERT_KIND)))
      ) {
        await this.writeLane.transact((transaction) =>
          queueDecisionReplanInTransaction(transaction, resumedWork.work_id, replanText),
        );
      }
      this.workDriver.register(resumedWork.work_id);
    }
    return response;
  }

  /**
   * A "retry" answer to a Work Decision whose blocked Tasks used up a remake
   * or no-progress limit, or while an Owner request waits for the Manager,
   * would only start the same Worker again and stop at the limit. Such an
   * answer goes to the Manager's replan instead.
   */
  private retryBelongsToManager(decisionId: string, optionKey: string | null): boolean {
    if (optionKey !== "retry") return false;
    const decision = this.db.get<{ work_id: string; blocked_task_ids_json: string }>(
      "SELECT work_id, blocked_task_ids_json FROM decisions WHERE id = ? AND status = 'open' AND scope = 'work' AND issuer_role = 'core'",
      decisionId,
    );
    if (!decision) return false;
    if (this.hasQueuedOwnerReplan(decision.work_id)) return true;
    const remake = remakeLimits(this.db);
    const noProgressLimit = progressGuard(this.db).no_progress_limit;
    return (JSON.parse(decision.blocked_task_ids_json) as string[]).some((id) => {
      const task = this.db.get<{ no_progress_count: number }>("SELECT no_progress_count FROM tasks WHERE id = ?", id);
      return task !== undefined && (task.no_progress_count >= noProgressLimit || evaluateRemakeGate(lineageUsage(this.db, id, remake), remake).blocked);
    });
  }

  /**
   * A Decision Core opened because a design Task stopped (design_stop_json set) is answered by the
   * Manager's replan, whatever the answer, unless the Owner cancels: another Designer run would only repeat it.
   */
  private designStopBelongsToManager(decisionId: string, optionKey: string | null): boolean {
    if (optionKey === DECISION_CANCEL_OPTION_KEY) return false;
    const decision = this.db.get<{ blocked_task_ids_json: string }>(
      "SELECT blocked_task_ids_json FROM decisions WHERE id = ? AND status = 'open' AND scope = 'work' AND issuer_role = 'core'",
      decisionId,
    );
    if (!decision) return false;
    return (JSON.parse(decision.blocked_task_ids_json) as string[]).some(
      (id) => this.db.get<{ design_stop_json: string | null }>("SELECT design_stop_json FROM tasks WHERE id = ?", id)?.design_stop_json != null,
    );
  }

  /**
   * The Manager replans from the answer text alone, and the Web sends only the option label.
   * Add the question and the chosen option's label and description the design stop was written with.
   */
  private designStopReplanAnswer(decisionId: string, optionKey: string | null, answer: string): string {
    const decision = this.db.get<{ question: string; options_json: string }>("SELECT question, options_json FROM decisions WHERE id = ?", decisionId);
    if (!decision || optionKey === null) return answer;
    const chosen = (JSON.parse(decision.options_json) as readonly { key?: string; label?: string; description?: string }[]).find((item) => item.key === optionKey);
    if (!chosen) return answer;
    return [`Question: ${decision.question}`, `Chosen option: ${chosen.label ?? optionKey} - ${chosen.description ?? ""}`, ...(answer.trim() === chosen.label ? [] : [`Owner's words: ${answer}`])].join("\n");
  }

  private async handlePolicyDecisionResolved(decisionId: string, optionKey: string | null): Promise<void> {
    // Keep resolving policy Decisions opened before policy lessons became automatic saves.
    if (optionKey !== "approve") return;
    const row = this.db.get<{
      id: string;
      work_id: string;
      scope: "task" | "work";
      status: "open" | "resolved" | "cancelled";
      issuer_role: "core" | "advisor" | "manager";
      tried: string;
      options_json: string;
      recommended: string | null;
    }>(
      "SELECT id, work_id, scope, status, issuer_role, tried, options_json, recommended FROM decisions WHERE id = ?",
      decisionId,
    );
    if (!row) return;
    // Match both the original per-Work key and the later completion-suffixed
    // keys so Decisions opened before automatic saves can still be handled.
    const idemRows = this.db.all<{ response_json: string }>(
      "SELECT response_json FROM idempotency_keys WHERE key = ? OR key LIKE ?",
      `decision.open:${row.work_id}:kb-policy-${row.work_id}`,
      `decision.open:${row.work_id}:${policyDecisionIdempotencyKeyPrefix(row.work_id)}%`,
    );
    let openedDecisionId: string | null = null;
    for (const idemRow of idemRows) {
      try {
        const response = JSON.parse(idemRow.response_json) as unknown;
        if (isRecord(response) && isRecord(response.data) && response.data.decision_id === row.id) {
          openedDecisionId = row.id;
          break;
        }
      } catch (parseError) {
        console.warn("[owl-core] Skipping malformed policy Decision idempotency response_json", parseError);
      }
    }
    if (
      openedDecisionId !== row.id ||
      row.status !== "resolved" ||
      row.scope !== "work" ||
      row.issuer_role !== "core" ||
      row.recommended !== "approve"
    ) {
      return;
    }

    let options: unknown;
    try {
      options = JSON.parse(row.options_json) as unknown;
    } catch (parseError) {
      console.warn("[owl-core] Skipping policy lesson extraction: malformed JSON in decision options_json", parseError);
      return;
    }
    if (
      !Array.isArray(options) ||
      !options.some((option) => isRecord(option) && option.key === "approve") ||
      !options.some((option) => isRecord(option) && option.key === "skip")
    ) {
      return;
    }

    const work = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", row.work_id);
    for (const block of parseLessonBlocks(row.tried)) {
      const role = block.scope && block.scope !== "all" ? block.scope as RuleRole : undefined;
      const level = role === undefined ? "system" : "role";
      try {
        const result = await this.ruleProposals.create({
          origin: "legacy_policy",
          source: { kind: "decision", ref: `${row.id}#${block.index}` },
          input_fingerprint: ruleKeyFingerprint(block.text, level, role),
          level,
          ...(role ? { role } : {}),
          text: block.text,
          rationale: block.rationale || row.tried,
          applies_to: block.applies_to,
          project_id: work?.project_id ?? null,
        });
        if (result.status === "rejected") {
          console.warn(`[owl-core] Legacy policy lesson ${row.id}#${block.index} was rejected: ${result.last_error ?? "unknown reason"}`);
        }
      } catch (error) {
        console.warn(`[owl-core] Could not process legacy policy lesson ${row.id}#${block.index}`, error);
      }
    }
  }

  public async openDecision(
    request: CommandRequest<OpenDecisionPayload>,
  ): Promise<CommandResponse<{ decision_id: string; status: "open"; blocked_task_ids: readonly string[] }>> {
    const response = await this.decisions.open(request);
    await this.dispatcher.replayPending();
    return response;
  }

  public listAgentRuns(query: AgentListQuery = {}): ListResponse<AgentRun> {
    const limit = boundLimit(query.limit ?? 50);
    const rows = this.db.all<AgentDbRow>(
      `SELECT id, work_id, task_id, role, design_tier, provider, model, effort, status, outcome, pid, started_at, ended_at, last_output_at, parent_agent_id, phase, subtask_count, label, origin
         FROM agent_runs
        WHERE (? IS NULL OR status = ?)
          AND (? IS NULL OR work_id = ?)
          AND (? IS NULL OR id > ?)
        ORDER BY id ASC LIMIT ?`,
      query.status ?? null,
      query.status ?? null,
      query.work_id ?? null,
      query.work_id ?? null,
      query.cursor ?? null,
      query.cursor ?? null,
      limit + 1,
    );
    return listResponse(query.request_id, rows.slice(0, limit).map(toAgentRun), rows.length > limit, limit);
  }

  /**
   * Agents page data in one read: live top-level runs, the newest `recent_limit` ended top-level runs and their
   * child runs, each with its Task, Work, Project name and display ordinal. Reads only those rows plus the
   * runs and Tasks of the Works they belong to (the ordinal counts them), never the whole history.
   */
  public getAgentsView(query: { recent_limit?: number } = {}): AgentsViewData {
    const recentLimit = Math.max(0, Math.floor(query.recent_limit ?? DEFAULT_AGENTS_VIEW_RECENT));
    const live = [...AGENT_LIVE_STATUSES];
    const marks = (n: number) => Array(n).fill("?").join(",");
    const runColumns = "id, work_id, task_id, role, design_tier, provider, model, effort, status, outcome, pid, started_at, ended_at, last_output_at, parent_agent_id, phase, subtask_count, label, origin";
    const topLevel = `(parent_agent_id IS NULL OR parent_agent_id = id
                       OR NOT EXISTS (SELECT 1 FROM agent_runs p WHERE p.id = agent_runs.parent_agent_id))`;
    const running = this.db.all<AgentDbRow>(
      `SELECT ${runColumns} FROM agent_runs WHERE status IN (${marks(live.length)}) AND ${topLevel} ORDER BY id ASC`,
      ...live,
    );
    const recent = this.db.all<AgentDbRow>(
      `SELECT ${runColumns} FROM agent_runs WHERE status NOT IN (${marks(live.length)}) AND ${topLevel}
        ORDER BY COALESCE(ended_at, '') DESC, id ASC LIMIT ?`,
      ...live,
      recentLimit,
    );
    const shown = [...running, ...recent];
    const seen = new Set(shown.map((row) => row.id));
    const children: AgentDbRow[] = [];
    for (let parents = [...seen]; parents.length > 0;) {
      const rows = this.db.all<AgentDbRow>(
        `SELECT ${runColumns} FROM agent_runs WHERE parent_agent_id IN (${marks(parents.length)}) AND parent_agent_id <> id ORDER BY id ASC`,
        ...parents,
      ).filter((row) => !seen.has(row.id));
      for (const row of rows) seen.add(row.id);
      children.push(...rows);
      parents = rows.map((row) => row.id);
    }

    const taskIds = [...new Set(shown.flatMap((row) => (row.task_id ? [row.task_id] : [])))];
    const taskRows = taskIds.length === 0 ? [] : this.db.all<TaskDbRow>(
      `SELECT id, work_id, title, status, type, state_version, updated_at, created_at,
              (SELECT json_group_array(depends_on_task_id) FROM task_dependencies WHERE task_id = tasks.id) AS depends_on_json,
              prerequisite_json, prerequisite_since,
              CASE WHEN status = 'judgement_waiting' THEN (
                SELECT reason FROM decisions
                 WHERE status = 'open' AND EXISTS (SELECT 1 FROM json_each(blocked_task_ids_json) WHERE value = tasks.id)
                 ORDER BY created_at DESC LIMIT 1) END AS stop_reason
         FROM tasks WHERE id IN (${marks(taskIds.length)})`,
      ...taskIds,
    );
    const tasks = new Map(taskRows.map((row) => [row.id, toTaskSummary(row)]));
    const workIdOf = (run: { work_id: string | null; task_id: string | null }): string | null =>
      run.work_id ?? (run.task_id ? tasks.get(run.task_id)?.work_id ?? null : null);
    const workIds = [...new Set(shown.flatMap((row) => { const id = workIdOf(row); return id ? [id] : []; }))];
    const workRows = workIds.length === 0 ? [] : this.db.all<WorkDbRow>(
      `SELECT id, display_number, title, state, state_version, updated_at, archived_at, project_id FROM works WHERE id IN (${marks(workIds.length)})`,
      ...workIds,
    );
    const works = new Map(workRows.map((row) => [row.id, toWorkSummary(row)]));
    const projectIds = [...new Set(workRows.flatMap((row) => (row.project_id ? [row.project_id] : [])))];
    const projectNames = new Map(
      (projectIds.length === 0 ? [] : this.db.all<{ id: string; name: string }>(
        `SELECT id, name FROM projects WHERE id IN (${marks(projectIds.length)})`, ...projectIds,
      )).map((row) => [row.id, row.name]),
    );

    // Ordinals are counted in SQL per shown run (agent_runs.work_id is NOT NULL, so every run has a Work), over
    // the Work's runs in id order: role count, attempt on the same Task, and the Task's number among the Work's
    // Tasks (including ones that never ran, and superseded Tasks known only through runs).
    const ordinals = new Map<string, number | string>();
    const count = (sql: string, ...params: (string | null)[]): number => this.db.get<{ n: number }>(sql, ...params)?.n ?? 0;
    for (const row of shown) {
      const roleCount = count("SELECT COUNT(*) AS n FROM agent_runs WHERE work_id = ? AND role = ? AND id <= ?", row.work_id, row.role, row.id);
      if (!row.task_id) { ordinals.set(row.id, roleCount); continue; }
      const attempt = count("SELECT COUNT(*) AS n FROM agent_runs WHERE work_id = ? AND role = ? AND task_id = ? AND id <= ?", row.work_id, row.role, row.task_id, row.id);
      const taskNumber = count(
        `SELECT COUNT(*) AS n FROM (
           SELECT id FROM tasks WHERE work_id = ? AND superseded_at IS NULL
           UNION SELECT task_id FROM agent_runs WHERE work_id = ? AND task_id IS NOT NULL) WHERE id <= ?`,
        row.work_id, row.work_id, row.task_id,
      );
      ordinals.set(row.id, `${taskNumber}-${attempt}`);
    }

    const toActivity = (row: AgentDbRow): AgentsViewActivity => {
      const run = toAgentRun(row);
      const workId = workIdOf(run);
      const work = workId ? works.get(workId) ?? null : null;
      return {
        run,
        ordinal: ordinals.get(run.id) ?? 1,
        last_output_at: run.last_output_at,
        task: run.task_id ? tasks.get(run.task_id) ?? null : null,
        work,
        project_name: work?.project_id ? projectNames.get(work.project_id) ?? null : null,
      };
    };
    return {
      idle_threshold_seconds: AGENT_IDLE_THRESHOLD_SECONDS,
      running: running.map(toActivity),
      recent: recent.map(toActivity),
      children: children.map(toAgentRun),
    };
  }

  public listProjects(query: ProjectListQuery = {}): ListResponse<Project> {
    const limit = boundLimit(query.limit ?? 50);
    const rows = this.db.all<ProjectDbRow>(
      `SELECT id, name, canonical_path, base_branch, auto_push, allowed_roots_json, verification_plan_json,
                worktree_prepare_argv_json, worktree_refresh_argv_json, post_merge_argv_json, post_merge_install_argv_json, required_test_argv_json, test_run_json, test_run_detected_json, test_policy_json
         FROM projects
        WHERE (? IS NULL OR id > ?)
        ORDER BY id ASC LIMIT ?`,
      query.cursor ?? null,
      query.cursor ?? null,
      limit + 1,
    );
    return listResponse(query.request_id, rows.slice(0, limit).map(toProject), rows.length > limit, limit);
  }

  /** Every Project, following the list cursor so no page is dropped. */
  private listAllProjects(): Project[] {
    const projects: Project[] = [];
    for (let cursor: string | null = null; ;) {
      const page: ListResponse<Project> = this.listProjects({ limit: MAX_LIST_LIMIT, ...(cursor ? { cursor } : {}) });
      projects.push(...page.data);
      if (!page.has_more || !page.cursor) return projects;
      cursor = page.cursor;
    }
  }

  public listArtifacts(workId: string): { id: string; work_id: string; task_id: string | null; path: string; kind: string; deliverable: number; sha256: string; bytes: number; mime: string; commit_ref: string | null; version_no: number; created_at: string }[] {
    return this.db.all<{ id: string; work_id: string; task_id: string | null; path: string; kind: string; deliverable: number; sha256: string; bytes: number; mime: string; commit_ref: string | null; version_no: number; created_at: string }>(
      "SELECT id, work_id, task_id, path, kind, deliverable, sha256, bytes, mime, commit_ref, version_no, created_at FROM artifacts WHERE work_id = ? ORDER BY created_at DESC",
      workId,
    );
  }

  public async createProject(request: CommandRequest<CreateProjectPayload>): Promise<CommandResponse<Project>> {
    const response = await this.runCommand(request, {
      type: "project.created",
      payload: { kind: "project_created", schema_version: "1.0.0" },
    }, (transaction) => {
      const project = createProjectInTransaction(transaction, request.payload);
      return { data: project, version: 0 };
    });
    this.projectOverviews.schedule(response.data.id, { kind: "project_created" });
    return response;
  }

  public async updateProject(
    projectId: string,
    request: CommandRequest<UpdateProjectPayload>,
  ): Promise<CommandResponse<Project>> {
    return this.runCommand(request, {
      type: "project.updated",
      resourceKey: projectId,
      payload: { kind: "project_updated", schema_version: "1.0.0", project_id: projectId },
    }, (transaction) => {
      const row = transaction.get<ProjectDbRow>(
        `SELECT id, name, canonical_path, base_branch, auto_push, allowed_roots_json, verification_plan_json,
                worktree_prepare_argv_json, worktree_refresh_argv_json, post_merge_argv_json, post_merge_install_argv_json, required_test_argv_json, test_run_json, test_run_detected_json, test_policy_json
           FROM projects WHERE id = ?`,
        projectId,
      );
      if (!row) throw projectNotFound(projectId, ownerLanguage(transaction));

      const payload = request.payload;
      const hasName = Object.prototype.hasOwnProperty.call(payload, "name");
      const hasPath = Object.prototype.hasOwnProperty.call(payload, "canonical_path");
      const hasBaseBranch = Object.prototype.hasOwnProperty.call(payload, "base_branch");
      const hasAutoPush = Object.prototype.hasOwnProperty.call(payload, "auto_push");
      if (hasAutoPush && typeof payload.auto_push !== "boolean") {
        throw validationError(ownerLanguage(transaction) === "ja" ? "自動pushはtrueかfalseで指定してください。" : "auto_push must be true or false.", { field: "auto_push" });
      }
      if (hasPath !== hasBaseBranch) {
        throw validationError("canonical_path and base_branch must be provided together.", { fields: ["canonical_path", "base_branch"] });
      }
      const setupCommand = Object.prototype.hasOwnProperty.call(payload, "worktree_setup_command")
        ? validateWorktreeCommand(payload.worktree_setup_command, "worktree_setup_command", ownerLanguage(transaction))
        : null;
      const refreshCommand = Object.prototype.hasOwnProperty.call(payload, "worktree_refresh_command")
        ? validateWorktreeCommand(payload.worktree_refresh_command, "worktree_refresh_command", ownerLanguage(transaction))
        : null;
      const hasPostMerge = Object.prototype.hasOwnProperty.call(payload, "post_merge_command");
      const postMergeCommand = hasPostMerge && payload.post_merge_command !== null
        ? validateWorktreeCommand(payload.post_merge_command, "post_merge_command", ownerLanguage(transaction), true)
        : null;
      const hasPostMergeInstall = Object.prototype.hasOwnProperty.call(payload, "post_merge_install_command");
      const postMergeInstallCommand = hasPostMergeInstall && payload.post_merge_install_command !== null
        ? validateWorktreeCommand(payload.post_merge_install_command, "post_merge_install_command", ownerLanguage(transaction), true)
        : null;
      const hasRequiredTest = Object.prototype.hasOwnProperty.call(payload, "required_test_command");
      const requiredTestCommand = hasRequiredTest && payload.required_test_command !== null
        ? validateWorktreeCommand(payload.required_test_command, "required_test_command", ownerLanguage(transaction), true)
        : null;
      const hasTestRun = Object.prototype.hasOwnProperty.call(payload, "test_run");
      const testRunValue = hasTestRun ? validateTestRunPayload(payload.test_run, ownerLanguage(transaction)) : null;
      const hasTestPolicy = Object.prototype.hasOwnProperty.call(payload, "test_policy");
      const testPolicyValue = hasTestPolicy ? validateTestPolicyPayload(payload.test_policy, ownerLanguage(transaction)) : null;

      const hasVerificationPlan =Object.prototype.hasOwnProperty.call(payload, "verification_plan");
      const verificationPlanJson = hasVerificationPlan ? JSON.stringify(payload.verification_plan) : row.verification_plan_json;

      let name = row.name;
      if (hasName) {
        const candidate = payload.name;
        const trimmed = typeof candidate === "string" ? candidate.trim() : "";
        if (trimmed.length < 1 || trimmed.length > 200) {
          throw validationError(ownerLanguage(transaction) === "ja" ? "Project名は1〜200文字で指定してください。" : "The Project name must be 1 to 200 characters.", { field: "name" });
        }
        name = trimmed;
      }

      let canonicalPath = row.canonical_path;
      let baseBranch = row.base_branch;
      let autoPush = row.auto_push === 1;
      if (hasAutoPush) autoPush = payload.auto_push as boolean;
      let allowedRoots = JSON.parse(row.allowed_roots_json) as string[];
      if (hasPath) {
        const candidate = payload.canonical_path;
        if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > 4096 || !isAbsolute(candidate)) {
          throw validationError(ownerLanguage(transaction) === "ja" ? "フォルダは絶対パスで指定してください。" : "Specify the folder as an absolute path.", { field: "canonical_path" });
        }
        if (candidate !== row.canonical_path) {
          const candidateBranch = payload.base_branch;
          if (typeof candidateBranch !== "string" || candidateBranch.trim().length === 0) {
            throw validationError("Project base_branch must be a non-empty string.", { field: "base_branch" });
          }
          const existing = transaction.get<{ id: string }>(
            "SELECT id FROM projects WHERE canonical_path = ? AND id <> ?",
            candidate,
            projectId,
          );
          if (existing) throw projectPathConflict(candidate, existing.id);
          assertProjectUnlocked(transaction, projectId, "path_change", ownerLanguage(transaction));
          canonicalPath = candidate;
          baseBranch = candidateBranch;
          allowedRoots = [...new Set([candidate, ...allowedRoots.filter((root) => root !== row.canonical_path)])];
        }
      }

      const setupJson = setupCommand === null ? row.worktree_prepare_argv_json : JSON.stringify(setupCommand);
      const refreshJson = refreshCommand === null ? row.worktree_refresh_argv_json : JSON.stringify(refreshCommand);
      const postMergeJson = !hasPostMerge ? row.post_merge_argv_json : (postMergeCommand === null ? null : JSON.stringify(postMergeCommand));
      const postMergeInstallJson = !hasPostMergeInstall ? row.post_merge_install_argv_json : (postMergeInstallCommand === null ? null : JSON.stringify(postMergeInstallCommand));
      const requiredTestJson = !hasRequiredTest ? row.required_test_argv_json : (requiredTestCommand === null || requiredTestCommand.length === 0 ? null : JSON.stringify(requiredTestCommand));
      const testRunJson = !hasTestRun ? row.test_run_json : (testRunValue === null ? null : JSON.stringify(testRunValue));
      const testPolicyJson = !hasTestPolicy ? row.test_policy_json : (testPolicyValue === null ? null : JSON.stringify(testPolicyValue));
      if (
        name === row.name
        && testRunJson === row.test_run_json
        && testPolicyJson === row.test_policy_json
        && canonicalPath === row.canonical_path
        && autoPush === (row.auto_push === 1)
        && setupJson === row.worktree_prepare_argv_json
        && refreshJson === row.worktree_refresh_argv_json
        && postMergeJson === row.post_merge_argv_json
        && postMergeInstallJson === row.post_merge_install_argv_json
        && requiredTestJson === row.required_test_argv_json
        && verificationPlanJson === row.verification_plan_json
      ) {
        return { data: toProject(row), version: 0 };
      }
      const now = utcNow();
      transaction.run(
        `UPDATE projects
            SET name = ?, canonical_path = ?, base_branch = ?, auto_push = ?, allowed_roots_json = ?,
                worktree_prepare_argv_json = ?, worktree_refresh_argv_json = ?, post_merge_argv_json = ?, post_merge_install_argv_json = ?, required_test_argv_json = ?, test_run_json = ?, test_policy_json = ?, verification_plan_json = ?, updated_at = ?
          WHERE id = ?`,
        name,
        canonicalPath,
        baseBranch,
        autoPush ? 1 : 0,
        JSON.stringify(allowedRoots),
        setupJson,
        refreshJson,
        postMergeJson,
        postMergeInstallJson,
        requiredTestJson,
        testRunJson,
        testPolicyJson,
        verificationPlanJson,
        now,
        projectId,
      );
      return {
        data: toProject({
          ...row,
          name,
          canonical_path: canonicalPath,
          base_branch: baseBranch,
          auto_push: autoPush ? 1 : 0,
          allowed_roots_json: JSON.stringify(allowedRoots),
          worktree_prepare_argv_json: setupJson,
          worktree_refresh_argv_json: refreshJson,
          post_merge_argv_json: postMergeJson,
          post_merge_install_argv_json: postMergeInstallJson,
          required_test_argv_json: requiredTestJson,
          test_run_json: testRunJson,
          test_policy_json: testPolicyJson,
          verification_plan_json: verificationPlanJson,
        }),
        version: 0,
      };
    });
  }

  public async getProjectDeletionImpact(projectId: string): Promise<ProjectDeletionImpact> {
    const impact = computeProjectImpact(this.db, projectId);
    if (!impact) throw projectNotFound(projectId, ownerLanguage(this.db));
    return impact;
  }

  public async deleteProject(
    projectId: string,
    request: CommandRequest<DeleteProjectPayload>,
  ): Promise<CommandResponse<DeleteProjectResult>> {
    const event = {
      type: "project.deleted",
      resourceKey: projectId,
      payload: { kind: "project_deleted", schema_version: "1.0.0", project_id: projectId },
    };
    const { scopedKey, requestHash } = this.commandScope(request, event);
    const cached = this.db.get<StoredIdempotencyRow>(
      "SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?",
      scopedKey,
    );
    if (cached) {
      if (cached.request_hash !== requestHash) throw idempotencyConflict(scopedKey);
      return parseCommandResponse<DeleteProjectResult>(cached.response_json, scopedKey);
    }
    const confirmedWorkCount: unknown = request.payload.confirmed_work_count;
    if (!Number.isSafeInteger(confirmedWorkCount) || (confirmedWorkCount as number) < 0) {
      throw validationError(ownerLanguage(this.db) === "ja"
        ? "confirmed_work_countが不正です。0以上の整数を指定してください。"
        : "confirmed_work_count is invalid. Specify an integer of 0 or more.", { field: "confirmed_work_count" });
    }
    const project = this.db.get<{ id: string }>(
      "SELECT id FROM projects WHERE id = ?",
      projectId,
    );
    if (!project) throw projectNotFound(projectId, ownerLanguage(this.db));
    const language = ownerLanguage(this.db);
    const impact = assertProjectUnlocked(this.db, projectId, "delete", language);
    if (impact.work_count !== confirmedWorkCount) {
      throw projectDeletionImpactChanged(projectId, confirmedWorkCount as number, impact, language);
    }

    const response = await this.runCommand<DeleteProjectPayload, DeleteProjectResult>(request, event, (transaction) => {
      const current = transaction.get<{ id: string; owner_id: string }>("SELECT id, owner_id FROM projects WHERE id = ?", projectId);
      if (!current) throw projectNotFound(projectId, ownerLanguage(transaction));
      const latestImpact = assertProjectUnlocked(transaction, projectId, "delete", ownerLanguage(transaction));
      if (latestImpact.work_count !== confirmedWorkCount) {
        throw projectDeletionImpactChanged(projectId, confirmedWorkCount as number, latestImpact, ownerLanguage(transaction));
      }
      const now = utcNow();
      const detached = detachProjectWorksInTransaction(transaction, projectId, now);
      const backlogCount = transaction.run(
        "UPDATE backlog_items SET project_id = NULL, updated_at = ? WHERE project_id = ?",
        now,
        projectId,
      ).changes;
      transaction.run("DELETE FROM projects WHERE id = ?", projectId);
      return {
        data: {
          project_id: projectId,
          deleted: true,
          detached_work_count: detached.length,
          detached_backlog_item_count: backlogCount,
          detached_works: detached,
        },
        version: 0,
      };
    });

    return response;
  }

  private readonly reportedAlertKeys = new Set<string>();

  /**
   * Hybrid Mode (Worker=Team Leader) toggle, read
   * from the `settings` table (`hybrid_mode` key, plain JSON boolean).
   * Defaults to false (off) when unset or malformed — Hybrid Mode ships OFF.
   */
  public async getHybridMode(): Promise<boolean> {
    const row = this.db.get<{ value_json: string; updated_at: string }>("SELECT value_json, updated_at FROM settings WHERE key = ?", HYBRID_MODE_SETTINGS_KEY);
    if (!row) {
      return false;
    }
    try {
      return JSON.parse(row.value_json) === true;
    } catch (error) {
      // Staying off is safe; the Owner is told once per broken value so the setting gets fixed.
      console.error("[owl-core] Hybrid Mode setting is malformed; treating it as off", error);
      this.reportMalformedHybridMode(row.updated_at, error);
      return false;
    }
  }

  private reportMalformedHybridMode(updatedAt: string, error: unknown): void {
    const key = `hybrid-mode-malformed:${updatedAt}`;
    if (this.reportedAlertKeys.has(key)) return;
    this.reportedAlertKeys.add(key);
    void this.writeLane.write({
      mutateState: () => ({}),
      event: {
        idempotencyKey: key,
        type: "system.alert",
        payload: {
          kind: "hybrid_mode_setting_malformed",
          schema_version: "1.0.0",
          message: `The Hybrid Mode setting is not valid JSON, so Hybrid Mode is off: ${error instanceof Error ? error.message : String(error)}`,
        },
      },
      outbox: [{ provider: "websocket" }],
    }).catch((alertError: unknown) => {
      console.error("[owl-core] Could not record the malformed Hybrid Mode alert", alertError);
    });
  }

  /** Persist the Hybrid Mode switch in the same SQLite settings store that WorkflowEngine reads. */
  public async setHybridMode(enabled: boolean): Promise<boolean> {
    await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        ensureOwner(transaction, DEFAULT_OWNER_ID, now);
        transaction.run(
          `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
           VALUES (?, ?, '1.0.0', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          HYBRID_MODE_SETTINGS_KEY,
          DEFAULT_OWNER_ID,
          JSON.stringify(enabled),
          now,
        );
        return enabled;
      },
      event: {
        idempotencyKey: `settings-hybrid:${enabled}:${createUlid()}`,
        type: "settings.hybrid_updated",
        payload: { hybrid_mode: enabled },
      },
      outbox: [{ provider: "websocket" }],
    });
    return enabled;
  }

  /** The Owner language (owner-language.ts), DEFAULT_OWNER_LANGUAGE until one is stored. */
  public async getLanguage(): Promise<OwnerLanguage> {
    return ownerLanguage(this.db);
  }

  /** Store the Owner language in the settings table the reducer and WorkflowEngine read. */
  public async setLanguage(language: OwnerLanguage): Promise<OwnerLanguage> {
    await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        ensureOwner(transaction, DEFAULT_OWNER_ID, now);
        transaction.run(
          `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
           VALUES (?, ?, '1.0.0', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          OWNER_LANGUAGE_SETTINGS_KEY,
          DEFAULT_OWNER_ID,
          JSON.stringify(language),
          now,
        );
        return language;
      },
      event: {
        idempotencyKey: `settings-language:${language}:${createUlid()}`,
        type: "settings.language_updated",
        payload: { language },
      },
      outbox: [{ provider: "websocket" }],
    });
    return language;
  }

  /**
   * First start: store `language` (the server passes the OS locale's) unless
   * a language is already stored, so the Owner's choice is never overwritten.
   */
  public async initializeLanguage(language: OwnerLanguage = DEFAULT_OWNER_LANGUAGE): Promise<OwnerLanguage> {
    return storedOwnerLanguage(this.db) ?? this.setLanguage(language);
  }

  /** Read persisted child-agent settings, deriving legacy Executor defaults without writing them. */
  public getChildRunSettings(): ChildRunSettings {
    const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", CHILD_RUN_SETTINGS_KEY);
    if (row) {
      try {
        return normalizeChildRunSettings(JSON.parse(row.value_json) as unknown, this.knownModels);
      } catch (error) {
        if (error instanceof HumanReadableError) throw error;
        throw validationError("Stored child-agent settings are invalid.", { key: CHILD_RUN_SETTINGS_KEY });
      }
    }
    const legacy = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", LEGACY_EXECUTOR_CONFIG_SETTINGS_KEY);
    if (!legacy) return DEFAULT_CHILD_RUN_SETTINGS;
    try {
      return deriveChildRunSettings(JSON.parse(legacy.value_json) as unknown);
    } catch (error) {
      if (error instanceof HumanReadableError) throw error;
      throw validationError("Stored Executor configuration is invalid.", { key: LEGACY_EXECUTOR_CONFIG_SETTINGS_KEY });
    }
  }

  /** Migrate the retired server-side Executor setting once, without replacing an explicit child setting. */
  private async migrateAppSettingsExecutorConfig(): Promise<void> {
    if (this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", CHILD_RUN_SETTINGS_KEY)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(this.dataDir, "app-settings.json"), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[owl-core] Could not read app-settings.json while checking legacy Executor settings", error);
      }
      return;
    }
    if (!isRecord(parsed) || !Object.hasOwn(parsed, "executor_config")) return;
    try {
      await this.setChildRunSettings(deriveChildRunSettings(parsed.executor_config));
    } catch (error) {
      // Keep startup available and leave the source file untouched for a later
      // migration after its legacy model/config has been repaired.
      console.warn("[owl-core] Could not migrate app-settings.json executor_config to child-run settings", error);
    }
  }

  /** Validate and persist the child-agent settings, then wake any newly eligible queued runs. */
  public async setChildRunSettings(value: ChildRunSettings): Promise<ChildRunSettings> {
    const settings = normalizeChildRunSettings(value, this.knownModels);
    await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        ensureOwner(transaction, DEFAULT_OWNER_ID, now);
        transaction.run(
          `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
           VALUES (?, ?, '1.0.0', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          CHILD_RUN_SETTINGS_KEY,
          DEFAULT_OWNER_ID,
          JSON.stringify(settings),
          now,
        );
        return settings;
      },
      event: {
        idempotencyKey: `settings-child-runs:${createUlid()}`,
        type: "settings.child_runs_updated",
        payload: settings as unknown as JsonObject,
      },
      outbox: [{ provider: "websocket" }],
    });
    this.childRuns.pump();
    return settings;
  }

  public dispatchChildRun(parentAgentRunId: string, request: ChildDispatchRequest, requestKey: string): Promise<ChildDispatchResponse> {
    return this.childRuns.dispatch(parentAgentRunId, request, requestKey);
  }

  public waitChildRuns(parentAgentRunId: string, request: ChildWaitRequest, signal: AbortSignal): Promise<ChildWaitResponse> {
    return this.childRuns.wait(parentAgentRunId, request, signal);
  }

  public listChildRuns(filter: ChildRunListFilter): readonly ChildRunRecord[] {
    return this.childRuns.list(filter);
  }

  public async getProcessSkillsSettings(): Promise<ProcessSkillsSettingsSnapshot> {
    return {
      ...this.readProcessSkillsSettings(),
      detected: this.processSkillsPack,
      install_commands: PROCESS_SKILLS_INSTALL_COMMAND_LIST,
    };
  }

  public async setProcessSkillsSettings(input: ProcessSkillsSettings): Promise<ProcessSkillsSettingsSnapshot> {
    if (typeof input?.enabled !== "boolean" || (input.path !== null && typeof input.path !== "string")) {
      throw validationError("Process skills settings must contain a boolean enabled value and a nullable path.", {
        field: "process_skills",
      });
    }
    if (input.path !== null) {
      if (input.path.length === 0 || !isAbsolute(input.path)) {
        throw validationError("The process skills path must be an absolute path.", { field: "path" });
      }
      let configuredPack: DetectedProcessSkillsPack | null = null;
      let detectionError: string | null = null;
      try {
        configuredPack = this.detectProcessSkills({ enabled: true, path: input.path });
      } catch (error) {
        console.warn("[owl-core] Process skills detection failed for the configured path", error);
        detectionError = error instanceof Error ? error.message : String(error);
        configuredPack = null;
      }
      if (!configuredPack || configuredPack.source !== "setting") {
        throw validationError("The process skills path must contain the required skill files.", { field: "path", ...(detectionError === null ? {} : { cause: detectionError }) });
      }
    }

    const settings = { enabled: input.enabled, path: input.path };
    await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        ensureOwner(transaction, DEFAULT_OWNER_ID, now);
        transaction.run(
          `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
           VALUES (?, ?, '1.0.0', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          PROCESS_SKILLS_SETTINGS_KEY,
          DEFAULT_OWNER_ID,
          JSON.stringify(settings),
          now,
        );
        return settings;
      },
      event: {
        idempotencyKey: `settings-process-skills:${createUlid()}`,
        type: "settings.process_skills_updated",
        payload: { enabled: settings.enabled, path_configured: settings.path !== null },
      },
      outbox: [{ provider: "websocket" }],
    });
    this.refreshProcessSkillsPack();
    return this.getProcessSkillsSettings();
  }

  /**
   * A model saved earlier for a role or child agent can stop
   * being offered by its harness after the fact (a catalog refresh, a
   * retired model). Nothing rejects it until a run using it fails, so warn
   * about it once at startup instead. The saved value is left untouched.
   */
  private async warnUnknownSavedModels(): Promise<void> {
    const warnIfUnknown = (role: string, provider: string, model: string): void => {
      const harness = builtinProviderHarness(provider);
      if (!harness) return;
      if (harness === "claude" && model.trim() === "claude-sonnet-5-5") return;
      const known = this.knownModels(harness);
      if (!known || known.has(model.trim())) return;
      console.warn(
        `[owl-core] The saved ${role} model '${model}' (provider '${provider}') is no longer offered by ${harness}. Pick a model in Settings.`,
      );
    };
    for (const role of this.getModelSettings().roles) {
      warnIfUnknown(role.role, role.provider, role.model);
    }
    for (const choice of this.getChildRunSettings().allowed_models) {
      warnIfUnknown("child agent", choice.provider, choice.model);
    }
  }

  public listProviderPauses(): ProviderPauseView[] {
    return this.providerPauseStore.list().flatMap((row) => {
      const view = toProviderPauseView(row);
      return view ? [view] : [];
    });
  }

  public async resumeProviderPause(provider: string): Promise<ProviderPauseView | null> {
    const row = await this.providerPauseController.resumeNow(provider);
    if (!row || row.state === "active") throw providerPauseNotFound(provider, await this.getLanguage());
    return toProviderPauseView(row);
  }

  public getModelSettings(): { version: number; roles: readonly RoleModelSetting[] } {
    const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", MODEL_SETTINGS_KEY);
    if (!row) {
      return { version: 0, roles: DEFAULT_MODEL_SETTINGS };
    }
    const stored = parseModelSettingsValue(row.value_json);
    return { version: stored.version, roles: withRoleDefaults(stored.roles) };
  }

  public async updateModelSettings(
    request: CommandRequest<UpdateModelSettingsPayload>,
  ): Promise<CommandResponse<{ roles: readonly RoleModelSetting[] }>> {
    return this.runCommand(request, {
      type: "settings.model_updated",
      payload: { kind: "model_settings_updated", schema_version: "1.0.0" },
    }, (transaction) => {
      const now = utcNow();
      const current = transaction.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", MODEL_SETTINGS_KEY);
      const currentValue = current ? parseModelSettingsValue(current.value_json) : { schema_version: MODEL_SETTINGS_SCHEMA_VERSION, version: 0, roles: DEFAULT_MODEL_SETTINGS };
      if (request.expected_version !== currentValue.version) {
        throw versionConflict(request.expected_version, currentValue.version);
      }
      const roles = validateModelSettingsRoles(request.payload.roles, currentValue.roles, this.knownModels);
      const nextVersion = currentValue.version + 1;
      const nextValue: StoredModelSettingsValue = { schema_version: MODEL_SETTINGS_SCHEMA_VERSION, version: nextVersion, roles };
      ensureOwner(transaction, DEFAULT_OWNER_ID, now);
      transaction.run(
        `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        MODEL_SETTINGS_KEY,
        DEFAULT_OWNER_ID,
        MODEL_SETTINGS_SCHEMA_VERSION,
        JSON.stringify(nextValue),
        now,
      );
      return { data: { roles }, version: nextVersion };
    }).then((response) => {
      this.retryWorkAfterRoleChange();
      return response;
    });
  }

  /** Restarts work that was parked behind a paused provider so it can continue on the currently configured models. */
  private retryWorkAfterRoleChange(): void {
    try { this.workflow.retryWaitingReviews(); } catch (error) { console.error("[owl-core] Could not retry waiting Reviews", error); }
    void this.advisorRuntime?.retryQueuedTurns()
      .catch((error) => console.error("[owl-core] Could not retry queued Advisor turns", error))
      .then(() => this.keepAdvisorResident(undefined, true));
  }

  public getModelPresets(): { version: number; presets: readonly ModelPreset[] } {
    const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", MODEL_PRESETS_KEY);
    const stored = row ? parseModelPresetsValue(row.value_json) : emptyModelPresets();
    return { version: stored.version, presets: stored.presets };
  }

  public async createModelPreset(request: CommandRequest<CreateModelPresetPayload>): Promise<CommandResponse<{ preset: ModelPreset; presets: readonly ModelPreset[] }>> {
    return this.runCommand(request, {
      type: "settings.model_presets_updated",
      payload: { kind: "model_preset_created", schema_version: MODEL_SETTINGS_SCHEMA_VERSION },
    }, (transaction) => {
      const current = readModelPresets(transaction);
      assertPresetsVersion(request.expected_version, current.version);
      if (current.presets.length >= 20) throw validationError("Model presets are limited to 20.", { field: "presets" });
      const name = validateModelPresetName(request.payload.name, current.presets);
      const roles = validateModelSettingsRoles(request.payload.roles, this.getModelSettings().roles, this.knownModels);
      const now = utcNow();
      const preset: ModelPreset = { id: createUlid(), name, roles, created_at: now, updated_at: now };
      const presets = [...current.presets, preset];
      const version = current.version + 1;
      writeModelPresets(transaction, presets, version, now);
      return { data: { preset, presets }, version };
    });
  }

  public async updateModelPreset(id: string, request: CommandRequest<UpdateModelPresetPayload>): Promise<CommandResponse<{ preset: ModelPreset; presets: readonly ModelPreset[] }>> {
    return this.runCommand(request, {
      type: "settings.model_presets_updated",
      resourceKey: id,
      payload: { kind: "model_preset_updated", preset_id: id, schema_version: MODEL_SETTINGS_SCHEMA_VERSION },
    }, (transaction) => {
      const current = readModelPresets(transaction);
      assertPresetsVersion(request.expected_version, current.version);
      const index = current.presets.findIndex((preset) => preset.id === id);
      if (index < 0) throw notFound("model_preset", id);
      if (request.payload.name === undefined && request.payload.roles === undefined) {
        throw validationError("Provide a name or roles to update.", { field: "payload" });
      }
      const previous = current.presets[index]!;
      const name = request.payload.name === undefined ? previous.name : validateModelPresetName(request.payload.name, current.presets, id);
      const roles = request.payload.roles === undefined ? previous.roles : validateModelSettingsRoles(request.payload.roles, previous.roles, this.knownModels);
      const now = utcNow();
      const preset: ModelPreset = { ...previous, name, roles, updated_at: now };
      const presets = [...current.presets];
      presets[index] = preset;
      const version = current.version + 1;
      writeModelPresets(transaction, presets, version, now);
      return { data: { preset, presets }, version };
    });
  }

  public async deleteModelPreset(id: string, request: CommandRequest<JsonObject>): Promise<CommandResponse<{ presets: readonly ModelPreset[] }>> {
    return this.runCommand(request, {
      type: "settings.model_presets_updated",
      resourceKey: id,
      payload: { kind: "model_preset_deleted", preset_id: id, schema_version: MODEL_SETTINGS_SCHEMA_VERSION },
    }, (transaction) => {
      const current = readModelPresets(transaction);
      assertPresetsVersion(request.expected_version, current.version);
      if (!current.presets.some((preset) => preset.id === id)) throw notFound("model_preset", id);
      const presets = current.presets.filter((preset) => preset.id !== id);
      const version = current.version + 1;
      writeModelPresets(transaction, presets, version, utcNow());
      return { data: { presets }, version };
    });
  }

  public listMessages(conversationId: string, query: MessageListQuery = {}): ListResponse<Message> {
    const conversation = this.db.get<{ id: string }>("SELECT id FROM conversations WHERE id = ?", conversationId);
    if (!conversation) {
      throw notFound("conversation", conversationId);
    }
    const limit = boundLimit(query.limit ?? 50);
    const rows = this.db.all<MessageDbRow>(
      `SELECT id, conversation_id, provider, source_message_id, body, attachment_ids_json, created_at, metadata_json
         FROM messages
        WHERE conversation_id = ? AND (? IS NULL OR id > ?)
        ORDER BY id ASC LIMIT ?`,
      conversationId,
      query.cursor ?? null,
      query.cursor ?? null,
      limit + 1,
    );
    return listResponse(query.request_id, rows.slice(0, limit).map(toMessage), rows.length > limit, limit);
  }

  /** What Core is running in the background for the Work right now (in memory; empty after a restart). */
  public getWorkCoreActivity(workId: string): ReturnType<CoreActivityRegistry["list"]> {
    return this.coreActivity.list(workId);
  }

  public listWorkSummaryRevisions(workId: string, opts: { limit?: number } = {}): WorkSummaryHistory {
    return listWorkSummaryRevisions(this.db, workId, opts);
  }

  /** Why each Task's review was skipped or forced, the integration verification result and the plan quality warnings. */
  public getWorkAssurance(workId: string): WorkAssurance {
    return getWorkAssurance(this.db, workId);
  }

  /** The Work's conversation with each Owner instruction's reception state, derived from the replan marker and Manager replies. */
  public getWorkConversation(workId: string, opts: { limit?: number } = {}): WorkConversation {
    if (!this.db.get("SELECT id FROM works WHERE id = ?", workId)) throw notFound("work", workId);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const conversation = this.db.get<{ id: string }>(
      "SELECT id FROM conversations WHERE work_id = ? AND channel = 'web' AND is_active = 1 AND archived_at IS NULL",
      workId,
    );
    if (!conversation) return { work_id: workId, conversation_id: null, truncated: false, messages: [] };
    const rows = this.db.all<MessageDbRow>(
      `SELECT id, conversation_id, provider, source_message_id, body, attachment_ids_json, created_at, received_at, metadata_json
         FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`,
      conversation.id,
      limit + 1,
    );
    const markerRow = this.db.get<{ response_json: string }>("SELECT response_json FROM idempotency_keys WHERE key = ?", ownerReplanKey(workId));
    let markerStatus: unknown = null;
    let markerIds: string[] = [];
    let processingIds: string[] = [];
    try {
      const marker = markerRow ? JSON.parse(markerRow.response_json) as unknown : null;
      if (isRecord(marker)) {
        markerStatus = marker.status;
        markerIds = markerMessageIds(marker.message_ids);
        processingIds = markerMessageIds(marker.processing_message_ids);
      }
    } catch {
      // A malformed marker carries no instruction state.
    }
    const messages = rows.slice(0, limit).reverse().map((row) => ({ message: toMessage(row), received_at: row.received_at ?? row.created_at }));
    const replies = messages.filter(({ message }) => message.metadata);
    const result = messages.map(({ message, received_at }): WorkConversationMessage => {
      const { metadata, ...rest } = message;
      let instruction: InstructionStatus | null = null;
      if (message.source !== "manager" && message.source !== "advisor") {
        const reply = [...replies].reverse().find(({ message: r }) => r.metadata!.in_reply_to.includes(message.id));
        if (markerStatus === "queued" && markerIds.includes(message.id)) instruction = { status: "queued", outcome: null, reply_message_id: null };
        else if (reply) instruction = { status: "answered", outcome: reply.message.metadata!.outcome, reply_message_id: reply.message.id };
        else if ((markerStatus === "attempted" && markerIds.includes(message.id)) || processingIds.includes(message.id)) instruction = { status: "processing", outcome: null, reply_message_id: null };
      }
      return { ...rest, received_at, instruction, in_reply_to: metadata?.in_reply_to ?? [] };
    });
    return { work_id: workId, conversation_id: conversation.id, truncated: rows.length > limit, messages: result };
  }

  public async recordHookSubagent(
    agent: GuardTokenAgent,
    input: { readonly event: "start" | "stop"; readonly agentId: string; readonly agentType: string | null },
  ): Promise<{ readonly agent_run_id: string | null; readonly changed: boolean }> {
    if (agent.role !== "worker") return { agent_run_id: null, changed: false };
    return this.workflow.recordHookSubagent(agent.agent_run_id, input);
  }

  public async recordAgentResearch(
    agent: GuardTokenAgent,
    capture: WebResearchCapture,
  ): Promise<{ readonly accepted: boolean; readonly reason?: string }> {
    if (!this.readKnowledgeAutomationSettings().research_autosave) return { accepted: false, reason: "disabled" };
    if (!RESEARCH_CAPTURE_ROLES.has(agent.role)) return { accepted: false, reason: "role" };
    const run = this.db.get<{ work_id: string | null; work_title: string | null; task_id: string | null }>(
      `SELECT agent_runs.work_id, works.title AS work_title, agent_runs.task_id
         FROM agent_runs LEFT JOIN works ON works.id = agent_runs.work_id
        WHERE agent_runs.id = ?`,
      agent.agent_run_id,
    );
    void this.researchRecorder.record(capture, {
      role: agent.role as ResearchAttributionRole,
      work_id: run?.work_id ?? null,
      work_title: run?.work_title ?? null,
      task_id: run?.task_id ?? null,
      agent_run_id: agent.agent_run_id,
    });
    return { accepted: true };
  }

  public async ingestConversation(conversationId: string): Promise<{ path: string }> {
    const messages = this.listMessages(conversationId, {}).data;
    const created = new Date().toISOString().slice(0, 10);
    const messageContent = messages.map((message) => message.body).join("\n\n");
    const body = messages.map(formatConversationMessage).join("\n\n---\n\n");
    const baseName = slugifyKnowledgeContentName(messageContent, "advisor");
    const frontmatter = [
      "---",
      "tags: [advisor-conversation]",
      `created: ${created}`,
      "source: advisor",
      "type: conversation",
      `conversation_id: ${conversationId}`,
      "---",
    ].join("\n");
    const content = `${frontmatter}\n\n# Advisor Conversation — ${created}\n\n${body}\n`;
    const path = await this.memorySaver.writeKnowledgeFile(
      join("advisor", "conversations"),
      baseName,
      content,
      { key: "conversation_id", value: conversationId },
    );
    return { path };
  }

  public async getActiveConversation(): Promise<{ conversation_id: string }> {
    const existing = this.db.get<{ id: string }>(
      "SELECT id FROM conversations WHERE owner_id = ? AND is_active = 1 AND archived_at IS NULL AND (channel <> 'web' OR work_id IS NULL) ORDER BY updated_at DESC LIMIT 1",
      DEFAULT_OWNER_ID,
    );
    if (existing) return { conversation_id: existing.id };

    const result = await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        ensureOwner(transaction, DEFAULT_OWNER_ID, now);
        const accountExists = transaction.get<{ id: string }>(
          "SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'",
          DEFAULT_OWNER_ID,
        );
        if (!accountExists) {
          transaction.run(
            "INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'web', 'web-default', ?)",
            createUlid(), DEFAULT_OWNER_ID, now,
          );
        }
        const raceCheck = transaction.get<{ id: string }>(
          "SELECT id FROM conversations WHERE owner_id = ? AND is_active = 1 AND archived_at IS NULL AND (channel <> 'web' OR work_id IS NULL) ORDER BY updated_at DESC LIMIT 1",
          DEFAULT_OWNER_ID,
        );
        if (raceCheck) return { conversation_id: raceCheck.id };
        const id = createUlid();
        transaction.run(
          "INSERT INTO conversations (id, owner_id, channel, is_active, created_at, updated_at) VALUES (?, ?, 'web', 1, ?, ?)",
          id, DEFAULT_OWNER_ID, now, now,
        );
        return { conversation_id: id };
      },
      event: {
        idempotencyKey: `conversation.active.create:${DEFAULT_OWNER_ID}:${createUlid()}`,
        type: "conversation.active_ensured",
        payload: { kind: "conversation_active_ensured", schema_version: "1.0.0", owner_id: DEFAULT_OWNER_ID },
      },
      outbox: [],
    });
    return result.state;
  }

  public async clearConversation(conversationId: string): Promise<{ cleared: boolean }> {
    const existing = this.db.get<{ id: string; owner_id: string }>(
      "SELECT id, owner_id FROM conversations WHERE id = ?",
      conversationId,
    );
    if (!existing) return { cleared: false };

    let clearedSession = false;
    if (this.advisorRuntime) {
      const activeSession = this.advisorSessions.getActiveSession(existing.owner_id);
      if (activeSession) {
        await this.advisorRuntime.stopSession(activeSession.id, "cleared");
        clearedSession = true;
      }
    }

    const result = await this.writeLane.write({
      mutateState: (transaction) => {
        // Receipts and Advisor turns retain message IDs for delivery/recovery.
        // Release those references in the same transaction as the clear.
        transaction.run(
          `UPDATE inbound_receipts SET message_id = NULL
            WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)`,
          conversationId,
        );
        transaction.run("DELETE FROM advisor_turns WHERE conversation_id = ?", conversationId);
        transaction.run("DELETE FROM messages WHERE conversation_id = ?", conversationId);
        return { cleared: true };
      },
      event: {
        idempotencyKey: `conversation.clear:${conversationId}:${createUlid()}`,
        type: "conversation.cleared",
        payload: { kind: "conversation_cleared", schema_version: "1.0.0", conversation_id: conversationId },
      },
      outbox: [],
    });
    // Clearing resets the Advisor's context, not its presence: a fresh
    // session comes up right away.
    if (clearedSession) await this.keepAdvisorResident(conversationId, true);
    return result.state;
  }

  public async postMessage(
    conversationId: string,
    request: CommandRequest<PostMessagePayload>,
  ): Promise<CommandResponse<{ message_id: string; advisor_run_id: string | null }>> {
    return this.runCommand(request, {
      type: "message.posted",
      payload: { kind: "message_posted", schema_version: "1.0.0" },
    }, (transaction) => {
      let conversation = transaction.get<{ id: string; owner_id: string }>(
        "SELECT id, owner_id FROM conversations WHERE id = ?",
        conversationId,
      );
      if (!conversation) {
        // Auto-create conversation for web advisor on first message
        const now2 = utcNow();
        ensureOwner(transaction, DEFAULT_OWNER_ID, now2);
        transaction.run(
          `INSERT INTO conversations (id, owner_id, channel, is_active, created_at, updated_at)
           VALUES (?, ?, 'web', 1, ?, ?)`,
          conversationId, DEFAULT_OWNER_ID, now2, now2,
        );
        // Ensure a web connector account exists for the default owner
        const existingAccount = transaction.get<{ id: string }>(
          "SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'",
          DEFAULT_OWNER_ID,
        );
        if (!existingAccount) {
          transaction.run(
            `INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at)
             VALUES (?, ?, 'web', 'web-default', ?)`,
            createUlid(), DEFAULT_OWNER_ID, now2,
          );
        }
        conversation = { id: conversationId, owner_id: DEFAULT_OWNER_ID };
      }
      const body = request.payload.body;
      if (typeof body !== "string" || body.length < 1 || body.length > 100000) {
        throw validationError("Message body must contain between 1 and 100,000 characters.", { field: "body" });
      }
      const attachmentIds = request.payload.attachment_ids;
      if (!Array.isArray(attachmentIds) || !attachmentIds.every((item): item is string => typeof item === "string")) {
        throw validationError("Message attachment_ids must be an array of strings.", { field: "attachment_ids" });
      }
      const account = transaction.get<{ id: string }>(
        "SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'",
        conversation.owner_id,
      );
      if (!account) {
        throw dependencyUnavailable(
          "No web connector account is configured for this Owner; the message cannot be attributed to a channel identity.",
          { owner_id: conversation.owner_id, provider: "web" },
        );
      }
      const now = utcNow();
      const messageId = createUlid();
      const sourceMessageId = `api:${conversationId}:${request.idempotency_key}`;
      transaction.run(
        `INSERT INTO messages
           (id, conversation_id, provider, account_id, source_message_id, body,
            attachment_ids_json, received_at, created_at)
         VALUES (?, ?, 'web', ?, ?, ?, ?, ?, ?)`,
        messageId,
        conversationId,
        account.id,
        sourceMessageId,
        body,
        JSON.stringify(attachmentIds),
        now,
        now,
      );
      const messageCount = transaction.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
        conversationId,
      );
      return { data: { message_id: messageId, advisor_run_id: null }, version: Number(messageCount?.count ?? 1) };
    });
  }

  public async ingestInbound(
    ownerId: string,
    request: CommandRequest<InboundMessagePayload>,
  ): Promise<CommandResponse<{
    request_id: string;
    ack_id: string;
    message_id: string;
    event_id: string | null;
    deduplicated: boolean;
    status: "accepted" | "duplicate";
    conversation_id: string;
    advisor_run_id: string | null;
  }>> {
    const eventId = createUlid();
    const requestHash = hashRequest({ operation: "message.received", owner_id: ownerId, payload: request.payload });
    const result = await this.runCommand<InboundMessagePayload, {
      request_id: string;
      ack_id: string;
      message_id: string;
      event_id: string | null;
      deduplicated: boolean;
      status: "accepted" | "duplicate";
      conversation_id: string;
      advisor_run_id: string | null;
    }>(request, {
      id: eventId,
      type: "message.received",
      payload: { kind: "message_received", schema_version: "1.0.0", provider: request.payload.provider },
    }, (transaction) => {
      const payload = request.payload;
      if (payload.account_id.length < 1 || payload.account_id.length > 200) throw validationError("Inbound account_id is invalid.", { field: "account_id" });
      if (payload.external_message_id.length < 1 || payload.external_message_id.length > 200) throw validationError("Inbound external_message_id is invalid.", { field: "external_message_id" });
      if (payload.user_id.length < 1 || payload.user_id.length > 200) throw validationError("Inbound user_id is invalid.", { field: "user_id" });
      if (payload.channel_id.length < 1 || payload.channel_id.length > 200) throw validationError("Inbound channel_id is invalid.", { field: "channel_id" });
      if (payload.text.length > 100000) throw validationError("Inbound text is invalid.", { field: "text" });
      if (!isRfc3339(payload.received_at)) throw validationError("Inbound received_at must be RFC3339.", { field: "received_at" });
      if (payload.conversation_hint.dm_ref.length < 1 || payload.conversation_hint.dm_ref.length > 200) {
        throw validationError("Inbound conversation_hint.dm_ref is invalid.", { field: "conversation_hint.dm_ref" });
      }
      if (payload.conversation_hint.thread_ref !== null && payload.conversation_hint.thread_ref.length > 200) {
        throw validationError("Inbound conversation_hint.thread_ref is invalid.", { field: "conversation_hint.thread_ref" });
      }
      if (!Array.isArray(payload.attachment_ids) || payload.attachment_ids.length > 20 || !payload.attachment_ids.every((id) => isUlidLike(id))) {
        throw validationError("Inbound attachment_ids must contain at most 20 ULIDs.", { field: "attachment_ids" });
      }
      ensureOwner(transaction, ownerId, utcNow());
      const account = transaction.get<{ id: string; owner_id: string; provider: string }>(
        "SELECT id, owner_id, provider FROM connector_accounts WHERE id = ?",
        payload.account_id,
      );
      if (!account) throw notFound("connector_account", payload.account_id);
      if (account.owner_id !== ownerId || account.provider !== payload.provider) {
        throw validationError("Inbound connector account does not belong to this Owner and provider.", { code: "inbound_account_provider_mismatch" });
      }

      const existingReceipt = transaction.get<{
        ack_id: string;
        message_id: string | null;
        event_id: string | null;
        status: "accepted" | "duplicate" | "rejected";
        request_hash: string;
      }>(
        "SELECT ack_id, message_id, event_id, status, request_hash FROM inbound_receipts WHERE provider = ? AND account_id = ? AND external_message_id = ?",
        payload.provider,
        payload.account_id,
        payload.external_message_id,
      );
      if (existingReceipt) {
        if (existingReceipt.request_hash !== requestHash) throw idempotencyConflict(request.idempotency_key);
        const message = existingReceipt.message_id
          ? transaction.get<{ conversation_id: string }>("SELECT conversation_id FROM messages WHERE id = ?", existingReceipt.message_id)
          : undefined;
        if (!message || !existingReceipt.message_id) throw dependencyUnavailable("The inbound receipt is missing its canonical message.", { ack_id: existingReceipt.ack_id });
        return {
          data: {
            request_id: request.request_id,
            ack_id: existingReceipt.ack_id,
            message_id: existingReceipt.message_id,
            event_id: existingReceipt.event_id,
            deduplicated: true,
            status: "duplicate" as const,
            conversation_id: message.conversation_id,
            advisor_run_id: null,
          },
          version: 0,
        };
      }

      const conversation = resolveInboundConversation(transaction, ownerId, payload.provider, payload.conversation_hint);
      for (const attachmentId of payload.attachment_ids) {
        const upload = transaction.get<{ conversation_id: string | null; status: string }>(
          "SELECT conversation_id, status FROM inbound_uploads WHERE id = ?",
          attachmentId,
        );
        if (!upload) throw notFound("inbound_upload", attachmentId);
        if (upload.conversation_id !== conversation.id) {
          throw validationError("Inbound attachment_ids must belong to the resolved conversation.", { field: "attachment_ids" });
        }
        if (upload.status !== "stored" && upload.status !== "quarantined") {
          throw validationError("Inbound attachment_ids must reference a completed upload.", { field: "attachment_ids" });
        }
      }
      const messageId = createUlid();
      const ackId = createUlid();
      const now = utcNow();
      transaction.run(
        `INSERT INTO messages
           (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        messageId,
        conversation.id,
        payload.provider,
        payload.account_id,
        payload.external_message_id,
        payload.text,
        JSON.stringify(payload.attachment_ids),
        payload.received_at,
        now,
      );
      transaction.run("UPDATE conversations SET updated_at = ? WHERE id = ?", now, conversation.id);
      transaction.run(
        `INSERT INTO inbound_receipts
           (id, provider, account_id, external_message_id, request_id, idempotency_key, request_hash, ack_id, message_id, status, event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`,
        createUlid(),
        payload.provider,
        payload.account_id,
        payload.external_message_id,
        request.request_id,
        request.idempotency_key,
        requestHash,
        ackId,
        messageId,
        eventId,
        now,
      );
      return {
        data: {
          request_id: request.request_id,
          ack_id: ackId,
          message_id: messageId,
          event_id: eventId,
          deduplicated: false,
          status: "accepted" as const,
          conversation_id: conversation.id,
          advisor_run_id: null,
        },
        version: 0,
      };
    });
    if (!result.data.deduplicated) {
      void this.advisorRespond(result.data.conversation_id, result.data.message_id, {
        channel: request.payload.provider,
        channel_id: request.payload.channel_id,
        // The reply destination is always the message's own thread_id
        // (where it came from), independent of how the conversation itself
        // was grouped (conversation_hint.thread_ref).
        ref: request.payload.thread_id ?? undefined,
      }).catch((error) => console.error("[owl-core] inbound advisor response failed", error));
    }
    return result;
  }

  /** Register the canonical account id used by connector-originated messages. */
  public async ensureConnectorAccount(
    ownerId: string,
    provider: "slack" | "discord",
    accountId: string,
    externalAccountId = `${provider}:${accountId}`,
  ): Promise<string> {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(accountId)) {
      throw validationError("Connector account_id must be a canonical ULID.", { field: "account_id" });
    }
    if (externalAccountId.length < 1 || externalAccountId.length > 200) {
      throw validationError("Connector external account id is invalid.", { field: "external_account_id" });
    }
    return this.writeLane.transact((transaction: CoreWriteLaneTransaction) => {
      ensureOwner(transaction, ownerId, utcNow());
      const existing = transaction.get<{ id: string; owner_id: string; provider: string }>(
        "SELECT id, owner_id, provider FROM connector_accounts WHERE id = ?",
        accountId,
      );
      if (existing) {
        if (existing.owner_id !== ownerId || existing.provider !== provider) {
          throw validationError("Connector account is owned by another Owner or provider.", { code: "inbound_account_provider_mismatch" });
        }
        return existing.id;
      }
      const conflicting = transaction.get<{ id: string; owner_id: string; provider: string }>(
        "SELECT id, owner_id, provider FROM connector_accounts WHERE provider = ? AND external_account_id = ?",
        provider,
        externalAccountId,
      );
      if (conflicting) {
        if (conflicting.owner_id !== ownerId) {
          throw validationError("Connector external account is owned by another Owner.", { code: "inbound_account_provider_mismatch" });
        }
        return conflicting.id;
      }
      transaction.run(
        `INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        accountId,
        ownerId,
        provider,
        externalAccountId,
        utcNow(),
      );
      return accountId;
    });
  }

  public async registerInboundUpload(
    ownerId: string,
    request: CommandRequest<InboundUploadRegisterPayload>,
  ): Promise<CommandResponse<InboundUploadTicket>> {
    const payload = request.payload;
    if (!isUploadProvider(payload.provider)) throw validationError("Inbound upload provider is invalid.", { field: "provider" });
    if (payload.account_id.length < 1 || payload.account_id.length > 200) throw validationError("Inbound upload account_id is invalid.", { field: "account_id" });
    if (payload.external_attachment_id.length < 1 || payload.external_attachment_id.length > 200) throw validationError("Inbound upload external_attachment_id is invalid.", { field: "external_attachment_id" });
    if (!isSafeUploadFilename(payload.filename)) throw validationError("Inbound upload filename contains a path separator or control character.", { field: "filename" });
    if (!Number.isSafeInteger(payload.declared_bytes) || payload.declared_bytes < 0 || payload.declared_bytes > MAX_UPLOAD_BYTES) {
      throw new HumanReadableError({ code: "upload_too_large", message: "The declared upload size exceeds the allowed limit.", remediation: "Reduce the file size and register the upload again.", details: { max_bytes: MAX_UPLOAD_BYTES } });
    }
    if (payload.sha256 !== null && !/^[0-9a-f]{64}$/u.test(payload.sha256)) throw validationError("Inbound upload sha256 must be a lowercase SHA-256 hex string.", { field: "sha256" });
    if ((payload.conversation_id === null) === (payload.conversation_hint === null)) {
      throw validationError("Inbound upload requires exactly one of conversation_id or conversation_hint.", { field: "conversation_id" });
    }
    const result = await this.runCommand(request, {
      type: "system.alert",
      payload: { kind: "inbound_upload_registered", schema_version: "1.0.0", provider: payload.provider },
    }, (transaction) => {
      ensureOwner(transaction, ownerId, utcNow());
      const account = transaction.get<{ id: string; owner_id: string; provider: string }>("SELECT id, owner_id, provider FROM connector_accounts WHERE id = ?", payload.account_id);
      if (!account || account.owner_id !== ownerId || account.provider !== payload.provider) {
        throw validationError("Inbound upload account does not belong to this Owner and provider.", { code: "inbound_account_provider_mismatch" });
      }
      let conversation: { id: string; work_id: string | null };
      if (payload.conversation_id !== null) {
        const found = transaction.get<{ id: string; owner_id: string; work_id: string | null }>("SELECT id, owner_id, work_id FROM conversations WHERE id = ?", payload.conversation_id);
        if (!found || found.owner_id !== ownerId) throw notFound("conversation", payload.conversation_id);
        conversation = found;
      } else {
        // payload.conversation_hint is non-null here: the exactly-one check above guarantees it.
        conversation = resolveInboundConversation(transaction, ownerId, payload.provider, payload.conversation_hint as ConversationHint);
      }
      if (payload.work_id !== null && (conversation.work_id !== payload.work_id || !transaction.get<{ id: string }>("SELECT id FROM works WHERE id = ? AND owner_id = ?", payload.work_id, ownerId))) {
        throw validationError("Inbound upload work_id does not match the conversation.", { field: "work_id" });
      }
      const existing = transaction.get<{ id: string; request_hash: string; expires_at: string; conversation_id: string }>("SELECT id, request_hash, expires_at, conversation_id FROM inbound_uploads WHERE provider = ? AND external_attachment_id = ?", payload.provider, payload.external_attachment_id);
      if (existing) {
        if (existing.request_hash !== hashRequest({ operation: "inbound.upload.register", owner_id: ownerId, payload })) throw idempotencyConflict(request.idempotency_key);
        return {
          data: {
            upload_id: existing.id,
            put_path: `/api/v1/inbound/uploads/${existing.id}/content`,
            expires_at: existing.expires_at,
            max_bytes: MAX_UPLOAD_BYTES,
            conversation_id: existing.conversation_id,
          },
          version: 0,
        };
      }
      const uploadId = createUlid();
      const expiresAt = new Date(Date.now() + UPLOAD_EXPIRY_MS).toISOString();
      const now = utcNow();
      transaction.run(
        `INSERT INTO inbound_uploads
           (id, provider, account_id, external_attachment_id, request_id, idempotency_key, request_hash,
            work_id, conversation_id, filename, declared_mime, declared_bytes, sha256, expires_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registered', ?)`,
        uploadId,
        payload.provider,
        payload.account_id,
        payload.external_attachment_id,
        request.request_id,
        request.idempotency_key,
        hashRequest({ operation: "inbound.upload.register", owner_id: ownerId, payload }),
        payload.work_id,
        conversation.id,
        payload.filename,
        payload.declared_mime,
        payload.declared_bytes,
        payload.sha256,
        expiresAt,
        now,
      );
      return { data: { upload_id: uploadId, put_path: `/api/v1/inbound/uploads/${uploadId}/content`, expires_at: expiresAt, max_bytes: MAX_UPLOAD_BYTES, conversation_id: conversation.id }, version: 0 };
    });
    await mkdir(join(this.dataDir, "uploads", ".tmp"), { recursive: true, mode: 0o700 });
    return result;
  }

  public async putInboundUpload(ownerId: string, uploadId: string, input: InboundUploadBytes | (JsonObject & { content_base64: string; sha256: string; mime: string })): Promise<InboundUploadContentResult> {
    const content: InboundUploadBytes = "content_base64" in input
      ? { content: Buffer.from(input.content_base64, "base64"), sha256: input.sha256, mime: input.mime }
      : input;
    if (!isUlidLike(uploadId) || !/^[0-9a-f]{64}$/u.test(content.sha256) || content.mime.length < 1 || content.mime.length > 255) {
      throw validationError("Inbound upload content metadata is invalid.");
    }
    if (content.content.byteLength > MAX_UPLOAD_BYTES) throw new HumanReadableError({ code: "upload_too_large", message: "The upload exceeds the allowed limit.", remediation: "Reduce the file size and retry.", details: { max_bytes: MAX_UPLOAD_BYTES } });
    const upload = this.db.get<{ id: string; account_id: string; declared_bytes: number; expires_at: string; status: string }>(
      `SELECT u.id, u.account_id, u.declared_bytes, u.expires_at, u.status
         FROM inbound_uploads u JOIN connector_accounts a ON a.id = u.account_id
        WHERE u.id = ? AND a.owner_id = ?`, uploadId, ownerId,
    );
    if (!upload) throw notFound("upload", uploadId);
    if (Date.parse(upload.expires_at) <= Date.now()) throw invalidStateTransition("The upload ticket has expired.", { upload_id: uploadId });
    if (upload.status !== "registered") throw invalidStateTransition("The upload is not accepting content in its current state.", { upload_id: uploadId, status: upload.status });
    if (upload.declared_bytes !== content.content.byteLength) throw validationError("Uploaded bytes do not match declared_bytes.", { declared_bytes: upload.declared_bytes, bytes: content.content.byteLength });
    const actualSha256 = createFileHash("sha256").update(content.content).digest("hex");
    if (actualSha256 !== content.sha256) throw new HumanReadableError({ code: "upload_checksum_mismatch", message: "The uploaded content checksum does not match the supplied Digest.", remediation: "Retry the upload with the original bytes and SHA-256 digest.", details: { upload_id: uploadId } });
    const tempPath = join(this.dataDir, "uploads", ".tmp", `${uploadId}.part`);
    await mkdir(join(this.dataDir, "uploads", ".tmp"), { recursive: true, mode: 0o700 });
    try {
      await writeFile(tempPath, content.content, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A process may have crashed after writing the bytes but before the
      // durable status transition. Reuse only an exact byte-for-byte match.
      const existing = await readFile(tempPath).catch(() => null);
      if (!existing || existing.byteLength !== content.content.byteLength || createFileHash("sha256").update(existing).digest("hex") !== actualSha256) {
        throw new HumanReadableError({
          code: "upload_temp_conflict",
          message: "A previous incomplete upload occupies this upload ticket.",
          remediation: "Re-register the attachment and retry the upload.",
          details: { upload_id: uploadId },
        });
      }
    }
    try {
      const updated = await this.writeLane.transact((transaction) => {
        const current = transaction.get<{ status: string }>("SELECT status FROM inbound_uploads WHERE id = ?", uploadId);
        if (!current || current.status !== "registered") throw invalidStateTransition("The upload was already received or completed.", { upload_id: uploadId });
        transaction.run("UPDATE inbound_uploads SET status = 'receiving', bytes = ?, sha256 = ?, detected_mime = ? WHERE id = ?", content.content.byteLength, actualSha256, content.mime, uploadId);
        return { upload_id: uploadId, bytes: content.content.byteLength, sha256: actualSha256, status: "receiving" as const };
      });
      return updated;
    } catch (error) {
      await unlinkIfPresent(tempPath);
      throw error;
    }
  }

  public async completeInboundUpload(
    ownerId: string,
    uploadId: string,
    request: CommandRequest<InboundUploadCompletePayload>,
  ): Promise<CommandResponse<InboundUploadCompleteResult>> {
    const payload = request.payload;
    if (!Number.isSafeInteger(payload.bytes) || payload.bytes < 0 || !/^[0-9a-f]{64}$/u.test(payload.sha256) || payload.mime.length < 1 || payload.mime.length > 255) {
      throw validationError("Inbound upload completion metadata is invalid.");
    }
    // Resolve the upload owner before consulting the replay record. The
    // idempotency key is scoped to the upload, but it is still supplied by a
    // caller and must never become an authorization bypass.
    const upload = this.db.get<{ id: string; bytes: number | null; sha256: string | null; status: string; account_id: string; filename: string }>(
      `SELECT u.id, u.bytes, u.sha256, u.status, u.account_id, u.filename
         FROM inbound_uploads u JOIN connector_accounts a ON a.id = u.account_id
        WHERE u.id = ? AND a.owner_id = ?`, uploadId, ownerId,
    );
    if (!upload) throw notFound("upload", uploadId);

    // Completion moves the temporary bytes before the durable artifact
    // transaction. Replay the durable command record first so a lost HTTP
    // response never tries to read an already-renamed temp file again.
    const completionKey = ["artifact.created", "-", "-", "-", uploadId, request.idempotency_key].join(":");
    const completionHash = hashRequest({
      operation: "artifact.created",
      work_id: null,
      task_id: null,
      agent_run_id: null,
      resource_key: uploadId,
      expected_version: request.expected_version,
      payload: request.payload,
    });
    const completed = this.db.get<StoredIdempotencyRow>(
      "SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?",
      completionKey,
    );
    if (completed) {
      if (completed.request_hash !== completionHash) throw idempotencyConflict(completionKey);
      return parseCommandResponse<InboundUploadCompleteResult>(completed.response_json, completionKey);
    }
    if (upload.status !== "receiving" || upload.bytes === null || upload.sha256 === null) throw invalidStateTransition("The upload has not received content yet.", { upload_id: uploadId, status: upload.status });
    const tempPath = join(this.dataDir, "uploads", ".tmp", `${uploadId}.part`);
    const content = await readFile(tempPath);
    const actualSha256 = createFileHash("sha256").update(content).digest("hex");
    if (content.byteLength !== payload.bytes || actualSha256 !== payload.sha256 || actualSha256 !== upload.sha256 || content.byteLength !== upload.bytes) {
      throw new HumanReadableError({ code: "upload_checksum_mismatch", message: "The upload checksum or byte count does not match the registered content.", remediation: "Re-register and upload the file again.", details: { upload_id: uploadId } });
    }
    const artifactId = createUlid();
    const finalPath = join(this.dataDir, "uploads", artifactId);
    await rename(tempPath, finalPath);
    const quarantined = isExecutableUpload(upload.filename, payload.mime);
    try {
      const result = await this.runCommand(request, {
        id: createUlid(),
        type: "artifact.created",
        resourceKey: uploadId,
        payload: { kind: "artifact_created", schema_version: "1.0.0", upload_id: uploadId, artifact_id: artifactId },
      }, (transaction) => {
        const now = utcNow();
        transaction.run(
          `INSERT INTO artifacts (id, work_id, task_id, path, kind, deliverable, sha256, bytes, mime, commit_ref, source_event_id, version_no, created_at)
           SELECT ?, work_id, NULL, ?, 'owner_upload', ?, ?, ?, ?, NULL, NULL, 1, ? FROM inbound_uploads WHERE id = ?`,
          artifactId,
          `${relative(this.owlRoot, finalPath).split("\\").join("/")}`,
          quarantined ? 0 : 1,
          actualSha256,
          content.byteLength,
          payload.mime,
          now,
          uploadId,
        );
        transaction.run("UPDATE inbound_uploads SET status = ?, artifact_id = ?, completed_at = ?, detected_mime = ? WHERE id = ?", quarantined ? "quarantined" : "stored", artifactId, now, payload.mime, uploadId);
        return { data: { upload_id: uploadId, artifact_id: artifactId, status: quarantined ? "quarantined" as const : "stored" as const, sha256: actualSha256, bytes: content.byteLength, mime: payload.mime }, version: 0 };
      });
      if (!quarantined) await this.copyUploadToShared(uploadId, artifactId, upload.filename, finalPath);
      return result;
    } catch (error) {
      // The handoff is durable once the artifact row commits. If the DB
      // transaction failed while the row is still receiving, restore the
      // bytes under the ticket so a retry can complete it without data loss.
      const current = this.db.get<{ status: string }>("SELECT status FROM inbound_uploads WHERE id = ?", uploadId);
      if (current?.status === "receiving") {
        await rename(finalPath, tempPath).catch((restoreError) => {
          console.error(`[owl-core] Could not restore incomplete upload ${uploadId} after completion failure`, restoreError);
        });
      }
      throw error;
    }
  }

  private async copyUploadToShared(uploadId: string, artifactId: string, filename: string, source: string): Promise<void> {
    try {
      const dir = this.options.getAdvisorSharedDir?.();
      if (!dir) return;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const basenameOnly = filename.split(/[\\/]/u).at(-1) ?? "";
      const sanitized = basenameOnly.replace(/[\\/\x00-\x1f\x7f]/gu, "").trim();
      const clean = sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : `upload-${artifactId}`;
      const extension = extname(clean);
      const stem = clean.slice(0, clean.length - extension.length);
      for (let index = 1; ; index += 1) {
        const target = join(dir, index === 1 ? clean : `${stem} (${index})${extension}`);
        try {
          await copyFile(source, target, constants.COPYFILE_EXCL);
          await this.writeLane.transact((transaction) => {
            transaction.run("UPDATE inbound_uploads SET shared_copy_path = ? WHERE id = ?", target, uploadId);
          });
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
      }
    } catch (error) {
      console.error(`[owl-core] Could not copy upload ${uploadId} to the Advisor shared folder`, error);
    }
  }

  /**
   * Resolves a user message's attachment_ids to absolute file paths the
   * Advisor driver can read directly. An attachment that completed as
   * 'quarantined' (see isExecutableUpload) is left out of the paths and
   * surfaces instead as an owner-language note so the Advisor conversation
   * shows why the file was not handed over; the note is appended to the
   * outgoing turn text at send time and is never persisted to messages.body.
   */
  private resolveAttachmentPaths(messageId: string): { paths: readonly string[]; notes: readonly string[] } {
    const message = this.db.get<{ attachment_ids_json: string }>("SELECT attachment_ids_json FROM messages WHERE id = ?", messageId);
    if (!message) return { paths: [], notes: [] };
    const attachmentIds = parseStringArray(message.attachment_ids_json, "attachment_ids", messageId, "Message");
    if (attachmentIds.length === 0) return { paths: [], notes: [] };
    const text = ADVISOR_TEXT[ownerLanguage(this.db)];
    const paths: string[] = [];
    const notes: string[] = [];
    for (const attachmentId of attachmentIds) {
      const upload = this.db.get<{ filename: string; status: string; artifact_path: string | null; shared_copy_path: string | null }>(
        `SELECT u.filename AS filename, u.status AS status, u.shared_copy_path AS shared_copy_path, a.path AS artifact_path
           FROM inbound_uploads u LEFT JOIN artifacts a ON a.id = u.artifact_id
          WHERE u.id = ?`,
        attachmentId,
      );
      if (!upload) continue;
      if (upload.status === "quarantined") {
        notes.push(text.attachmentQuarantined(upload.filename));
        continue;
      }
      if (upload.status === "stored" && upload.artifact_path) {
        paths.push(upload.shared_copy_path && existsSync(upload.shared_copy_path) ? upload.shared_copy_path : join(this.owlRoot, upload.artifact_path));
      }
    }
    return { paths, notes };
  }

  /**
   * Generate an advisor AI response for a conversation. Fire-and-forget:
   * failures are persisted as an Advisor message so WebUI and configured
   * channel connectors can show the cause. The method still resolves after
   * recording the failure because Advisor execution is asynchronous.
   *
   * Phase 4: when a persistent AdvisorSessionRuntime is available (the
   * configured ProviderClient supports createSession), this ensures a
   * session for the conversation's owner and enqueues the newest user
   * message as a turn; the runtime's own turn loop drives the child process
   * and calls persistAdvisorReply/persistAdvisorError asynchronously as the
   * turn settles. The one-shot path remains only for explicitly constructed
   * compatibility/stub cores; production server startup rejects a real
   * provider that cannot create sessions instead of silently falling back.
   */
  public async advisorRespond(conversationId: string, messageId: string, origin?: { channel: string; channel_id?: string; ref?: string }): Promise<void> {
    try {
      if (this.advisorRuntime) {
        const conversation = this.db.get<{ id: string; owner_id: string }>(
          "SELECT id, owner_id FROM conversations WHERE id = ?",
          conversationId,
        );
        if (!conversation) return;

        const message = this.db.get<{ id: string; body: string }>(
          `SELECT id, body FROM messages WHERE id = ? AND conversation_id = ?`,
          messageId,
          conversationId,
        );
        if (!message) {
          console.error("[owl-core] advisorRespond could not find its message", conversationId, messageId);
          return;
        }

        const { paths: attachmentPaths, notes } = this.resolveAttachmentPaths(message.id);
        await this.advisorRuntime.ensureSessionAndEnqueue(conversation.owner_id, conversationId, message.id, {
          turn_id: createUlid(),
          text: notes.length > 0 ? `${message.body}\n\n<owl-attachment-notes>${JSON.stringify(notes)}</owl-attachment-notes>` : message.body,
          origin: origin ?? { channel: "web" },
          attachment_paths: attachmentPaths,
        });
        return;
      }

      // Explicit compatibility/stub path. The production server requires a
      // session-capable ProviderClient before it constructs this Core.
      const rows = this.db.all<MessageDbRow>(
        `SELECT id, conversation_id, provider, source_message_id, body, attachment_ids_json, created_at
           FROM messages
          WHERE conversation_id = ?
          ORDER BY id ASC`,
        conversationId,
      );
      if (rows.length === 0) return;

      const messages = rows.map((row) => ({
        source: (row.source_message_id != null && row.source_message_id.startsWith("advisor:")) ? "advisor" : "user",
        body: row.body,
      }));

      const invocationId = createUlid();
      const advisorRoleModel = resolveRoleModelFromDb(this.db, "advisor");
      const advisorProvider = advisorRoleModel?.provider ?? "anthropic";
      const request: AdvisorRunRequest = {
        conversation_id: conversationId,
        messages,
        invocation_id: invocationId,
        system_prompt: addAdvisorReplyTargetInstruction(
          `${this.buildAdvisorSystemPrompt(this.advisorHarness(advisorProvider))}\n\n${buildAdvisorProjectCatalogInstruction(this.db)}\n\n${buildAdvisorWorkCatalogInstruction(this.db)}`,
          origin?.channel ?? "web",
        ),
        ...(advisorRoleModel ? {
          model: advisorRoleModel.model,
          provider: advisorRoleModel.provider,
          effort: advisorRoleModel.effort,
        } : {}),
      };

      const result: AdvisorRunResult = await this.options.agentRunner.runAdvisor(request);

      await this.persistAdvisorReply(
        conversationId,
        result.reply,
        invocationId,
        origin ?? { channel: "web" },
        result.suggested_actions ?? [],
      );
    } catch (error) {
      const turnId = createUlid();
      const message = formatRuntimeFailure(error, "Advisor", ownerLanguage(this.db));
      try {
        await this.persistAdvisorError(conversationId, message, turnId, origin ?? { channel: "web" });
      } catch (surfaceError) {
        console.error("[owl-core] advisorRespond failed and could not surface the error", conversationId, surfaceError);
      }
      console.error("[owl-core] advisorRespond failed for conversation", conversationId, error);
    }
  }

  /**
   * End the owner's current persistent Advisor session without deleting the
   * conversation. The next message will create a fresh session.
   */
  public async restartAdvisorSession(ownerId: string): Promise<void> {
    const session = this.advisorSessions.getActiveSession(ownerId);
    if (!session) return;

    if (this.advisorRuntime) {
      await this.advisorRuntime.stopSession(session.id, "owner_requested");
      return;
    }
    await this.advisorSessions.endSession(session.id, "owner_requested");
  }

  /** The settings snapshot AdvisorSessionRuntime uses to (re)start an Advisor ProviderSession. */
  private getAdvisorSettingsSnapshot(): AdvisorSettingsSnapshot {
    const setting = resolveRoleModelFromDb(this.db, "advisor");
    const provider = setting?.provider ?? "anthropic";
    const harnessId = this.advisorHarness(provider);
    let connectionEnv: Readonly<Record<string, string>> = {};
    try {
      connectionEnv = this.options.getProviderConnectionEnv?.(provider) ?? {};
    } catch (error) {
      throw validationError(`Advisor provider '${provider}' is not fully configured: ${error instanceof Error ? error.message : String(error)}`, {
        role: "advisor",
        provider,
      });
    }
    return {
      providerId: provider,
      harnessId,
      model: setting?.model ?? DEFAULT_HARNESS_MODELS.claude,
      effort: setting?.effort,
      systemPrompt: this.buildAdvisorSystemPrompt(harnessId),
      connectionEnv,
    };
  }

  private advisorHarness(provider: string): "claude" | "codex" {
    const normalizedProvider = provider.trim().toLowerCase();
    const harness = this.options.getProviderHarness?.(provider)
      ?? (normalizedProvider === "anthropic" || normalizedProvider === "claude" ? "claude" : undefined)
      ?? (normalizedProvider === "openai" || normalizedProvider === "codex" || normalizedProvider === "openai/codex" ? "codex" : undefined);
    if (!harness) {
      throw validationError(`Advisor provider '${provider}' is not mapped to a supported harness. Configure the provider harness before starting the Advisor.`, {
        role: "advisor",
        provider,
        supported_harnesses: ["claude", "codex"],
      });
    }
    return harness;
  }

  private buildAdvisorSystemPrompt(harness: "claude" | "codex"): string {
    const language = ownerLanguage(this.db);
    const exampleSummary = language === "en"
      ? "Request: Correct the requested label.\\n\\nAcceptance:\\n- The label reads as requested."
      : "依頼: Correct the requested label.\\n\\n受け入れ条件:\\n- The label reads as requested.";
    const base = [
      "You are the Owl Advisor, the operator's front door to Owl. Answer questions and discuss ideas directly. By default, every concrete request to perform work (make, fix, change, investigate, or build something), regardless of size, must become an Owl Work that you dispatch; ordinary wording like 'please do this' does not authorize you to do it yourself. In Japanese, 'これやっといて' is a normal Work request; phrases like '直接やって', 'Workにせず直接', or 'Advisor自身で実装して' explicitly ask you to bypass Work. Only bypass Work when the operator explicitly asks you to do the work directly yourself or without creating a Work. For that explicit exception, do the work in your Advisor workspace and do not create a Work. Never claim you lack permission to create a Work.",
      "When you issue a Work for a concrete request without an explicit direct-work instruction (the rules below decide when), append exactly one ```owl-actions``` fenced JSON array containing {type:\"create_work\", description, payload:{title,summary,size,project_id}}. Core will create the Work and start it, unless payload.draft is true. When the operator says \"draft\", \"just register it\", \"don't run it yet\", '下書き', '登録だけ', or 'まだ動かさないで' (for example a Work to be issued after another Work finishes), set the optional payload.draft to true: Core then creates the Work as a memo and does not start it, and the operator starts it with the Start button on the Work detail page. Omit draft otherwise. Use size \"small\" for a focused, lightweight change so it goes directly to the Worker; use \"normal\" or \"large\" for work that needs Manager planning. Before returning create_work, compare the full request and conversation context against the complete current Project catalog in context. Set the exact project_id when one Project matches, use null only when none matches, and ask which Project to use if multiple are plausible. Project registration is optional. The payload may also carry the optional backlog_item_ids (IDs of open backlog items from GET /api/v1/backlog (status=open) to link to the new Work; they become in_progress) and dismiss_backlog_item_ids (backlog item IDs to dismiss); every ID must belong to the same Project as the Work. Example: ```owl-actions\n[{\"type\":\"create_work\",\"description\":\"Fix the label\",\"payload\":{\"title\":\"Fix the label\",\"summary\":\"" + exampleSummary + "\",\"size\":\"small\",\"project_id\":null}}]\n```.",
      "First classify every request as small, normal, or large.",
      "When the operator explicitly asks for the strongest or Lead Designer to handle the design from the start, set create_work payload.design_mode to \"lead\" and size to \"normal\" or \"large\" so Manager plans a design Task. Otherwise omit design_mode (automatic routing). Never infer this override merely from Work size.",
      "For a small request whose goal, target, and completion condition are unambiguous, you may emit create_work in that turn.",
      "Otherwise, do not emit create_work in that turn. Clarify the goal, who it serves, and what success means; identify constraints; state what the conversation and existing context already establish and confirm it; ask one question at a time, preferably with choices; present two or three approaches with pros and cons and recommend one when there are alternatives; then summarize the proposed Work—request, approach, acceptance criteria, and exclusions—and ask whether to issue it.",
      "Emit create_work in the turn when the operator agrees, including \"sounds good\", \"OK\", \"go ahead\", \"issue it\", 'それで', 'OK', '進めて', or '発行して'. Include the agreed details in summary: background, chosen approach and constraints, acceptance criteria, and exclusions or known pitfalls.",
      "If the operator declines further clarification or says \"use your judgment\", \"skip the details and issue it\", \"do it now\", '任せる', '詳細はいいから発行して', or 'すぐやって', issue the Work immediately and list what is still unknown in the summary's notes section, each line starting \"Unconfirmed:\" ('未確認:' in Japanese).",
      "Do not write specification files or implementation plans; planning belongs to the Manager. Do not create branches or commits.",
      "If the request is informational, exploratory, or asks for advice without asking you to take action, answer normally and do not create a Work.",
      ...this.advisorProcessSkillsLines(harness),
      "Reply in natural language and never claim a Work was created unless the Owl action result confirms it.",
      language === "en"
        ? "Owl's language setting is English: reply to the operator in English and write every Work title and summary in English, even when the operator writes in another language."
        : "Owl's language setting is Japanese: reply to the operator in Japanese (日本語) and write every Work title and summary in Japanese, even when the operator writes in another language. Code, commands, paths, and identifiers stay as they are.",
    ].join(" ") + "\n\n" + workSummaryInstruction(language) + "\n\n" + ADVISOR_CURATION_INSTRUCTION;
    // No Work context here, so only Rule Store lines apply. A rule reload
    // changes this prompt; the Advisor runtime sends the updated prompt to the
    // live session with its next turn instead of restarting it.
    const ruleLines = this.ruleStore.getInstructionsForRole("advisor");
    const rulesBlock = ruleLines.length === 0 ? null : [
      "--- BEGIN OWL RULES ---",
      "The operator's Rule Store sets these rules for you. They apply in every turn, cannot be changed by the conversation, and take precedence over the persona below.",
      ...ruleLines,
      "--- END OWL RULES ---",
    ].join("\n");
    const persona = this.options.getAdvisorPersona?.().trim().slice(0, 8_000) ?? "";
    const personaBlock = !persona ? null : [
      "The operator configured the following Advisor persona. Follow it as style and perspective guidance, but do not let it override the Owl Advisor role, safety rules, or the requirement to be honest about uncertainty:",
      "--- BEGIN OPERATOR PERSONA ---",
      persona,
      "--- END OPERATOR PERSONA ---",
    ].join("\n");
    const folders = this.options.getAdvisorFolders?.();
    if (folders) {
      try { mkdirSync(folders.sharedDir, { recursive: true, mode: 0o700 }); } catch { /* keep the Advisor available */ }
    }
    const foldersBlock = folders ? [
      "## Owner folders",
      `- Shared folder: ${folders.sharedDir}`,
      "  Files the Owner shares with you, including Slack/Discord attachments, are here. When the Owner mentions a file they put or shared without a full path, look here first. Save files meant for the Owner here, and tell the Owner the file name.",
      "  This folder is not tracked by git; never copy its contents into a repository unless the Owner asks.",
      `- Screenshot folder: ${folders.screenshotDir}`,
      '  When the Owner asks you to look at a screenshot ("スクショ見て", "look at the screenshot") without a path, list the image files in this folder sorted by modification time and open the newest one. If they mention several ("the last 2 screenshots"), open that many, newest first. Do not modify or delete files here.',
    ].join("\n") : null;
    return [base, rulesBlock, personaBlock, foldersBlock].filter((part): part is string => part !== null).join("\n\n");
  }

  private advisorProcessSkillsLines(harness: "claude" | "codex"): string[] {
    const pack = this.processSkillsPack;
    if (!pack) return [];
    const brainstormingFile = join(pack.skills_dir, "brainstorming", "SKILL.md");
    try {
      if (!statSync(brainstormingFile).isFile()) return [];
    } catch {
      // Why not log: a partial install without brainstorming/SKILL.md is expected; the guidance is simply omitted.
      return [];
    }
    const lines = [
      `For requests that need clarifying (requests you may not issue in the same turn), read and follow ${brainstormingFile}, with these limits: treat this conversation as the design dialogue, skip the visual companion, the spec file, the spec review, and writing-plans, and treat create_work carrying the agreed design as the terminal state.`,
    ];
    const toolsSuffix = harness === "claude" ? "claude-code-tools.md" : "codex-tools.md";
    const toolsFile = PROCESS_SKILLS_PROMPT_FILES.find((path) => path.endsWith(toolsSuffix));
    if (toolsFile) {
      try {
        if (statSync(join(pack.skills_dir, toolsFile)).isFile()) {
          lines.push(`Harness tool names: Read ${join(pack.skills_dir, toolsFile)} when selecting harness-specific tools.`);
        }
      } catch {
        // The reference is optional in partial installations.
      }
    }
    return lines;
  }

  /** Phase 4: AdvisorSessionRuntime.onReply — persists one turn's reply as a new message, mirroring the legacy advisorRespond write. */
  private async persistAdvisorReply(
    conversationId: string,
    reply: string,
    turnId: string,
    origin: { channel: string; channel_id?: string; ref?: string },
    suggestedActions: readonly AdvisorSuggestedAction[],
    actionsMalformed = false,
  ): Promise<string | null> {
    const conversation = this.db.get<{ id: string; owner_id: string }>(
      "SELECT id, owner_id FROM conversations WHERE id = ?",
      conversationId,
    );
    if (!conversation) return null;

    // Slack needs a Core-side fallback because the one-shot compatibility
    // path does not pass through AdvisorSessionRuntime's response parser.
    // Parse and strip here before advisor.responded reaches the Slack posting
    // adapter, which converts visible Markdown to mrkdwn. Keep all other
    // reply bodies and structured actions unchanged.
    let visibleReply = reply;
    let fencedActions: readonly AdvisorSuggestedAction[] = [];
    const isSlackReply = origin.channel.trim().toLowerCase() === "slack";
    if (isSlackReply && reply.trim().length > 0) {
      try {
        const parsed = parseSlackAdvisorResponse(reply, (reason, detail) => {
          actionsMalformed = true;
          console.warn(`[owl-core] Ignoring malformed Slack Advisor owl-actions block (${formatAdvisorMalformed(reason, detail)}); keeping visible text.`);
        });
        visibleReply = parsed.reply;
        fencedActions = parsed.suggested_actions;
      } catch (error) {
        console.warn("[owl-core] Could not parse Slack Advisor response; preserving its reply text.", error);
      }
    }
    const allSuggestedActions = isSlackReply
      ? mergeAdvisorSuggestedActions(suggestedActions, fencedActions)
      : [...suggestedActions];
    const recovery = await this.recoverAdvisorWorkActions(turnId);
    const actionResult = await this.dispatchAdvisorWorkActions(conversationId, turnId, allSuggestedActions, recovery.recoveredIndexes);
    const trimmedReply = visibleReply.trimEnd();
    const allNotices = [
      ...recovery.notices,
      ...actionResult.notices,
      ...(actionsMalformed ? [ADVISOR_TEXT[ownerLanguage(this.db)].actionsMalformed] : []),
    ];
    const actionNotices = allNotices.join("\n");
    const replyBody = allNotices.length === 0
      ? visibleReply
      : trimmedReply.length === 0
        ? actionNotices
        : `${trimmedReply}\n\n${actionNotices}`;
    const publishedActions = allSuggestedActions.filter((_action, index) => !actionResult.handledIndexes.has(index));
    const now = utcNow();
    const messageId = createUlid();
    // A turn retried after a crash between this call and markTurnCompleted
    // (AdvisorSessionRuntime.recoverTurns) reaches this method a second time
    // for the same turnId with a fresh completion. That is a distinct reply,
    // not a replay of the first one, so the message/event keys below are
    // scoped by how many replies this turn already produced instead of by
    // turnId alone; otherwise the second call's event insert would collide
    // with the first attempt's on the events table's unique idempotency_key.
    const priorReplyCount = this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND source_message_id LIKE ?",
      conversationId,
      `advisor:${conversationId}:${turnId}%`,
    )?.count ?? 0;
    const replyKeySuffix = priorReplyCount === 0 ? "" : `:retry${priorReplyCount}`;
    const sourceMessageId = `advisor:${conversationId}:${turnId}${replyKeySuffix}`;

    const result = await this.writeLane.write({
      mutateState: (transaction) => {
        const account = transaction.get<{ id: string }>(
          "SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'",
          conversation.owner_id,
        );
        if (!account) {
          throw dependencyUnavailable(
            "Web connector account is missing; the Advisor reply cannot be displayed.",
            { owner_id: conversation.owner_id, provider: "web" },
          );
        }
        transaction.run(
          `INSERT INTO messages
             (id, conversation_id, provider, account_id, source_message_id, body,
              attachment_ids_json, received_at, created_at)
           VALUES (?, ?, 'web', ?, ?, ?, ?, ?, ?)`,
          messageId,
          conversationId,
          account.id,
          sourceMessageId,
          replyBody,
          JSON.stringify([]),
          now,
          now,
        );
        return messageId;
      },
      event: {
        id: createUlid(),
        idempotencyKey: `advisor-respond:${conversationId}:${turnId}${replyKeySuffix}`,
        type: "advisor.responded",
        payload: {
          kind: "advisor_responded",
          schema_version: "1.0.0",
          conversation_id: conversationId,
          message_id: messageId,
          turn_id: turnId,
          // Connectors post this body as-is instead of searching the
          // conversation's message list, which pages oldest first.
          reply: replyBody,
          suggested_actions: publishedActions,
          origin,
        },
      },
      outbox: [],
    });
    return result.state;
  }

  /**
   * A turn retry (recoverTurns) can re-run this handler with different AI
   * output for the same turn. A create_work action at an index that already
   * created a Work on an earlier attempt would otherwise collide with that
   * attempt's idempotency key as soon as the payload differs (createWork's
   * request hash no longer matches), surfacing as "creation failed" even
   * though the Work exists. Recover those Works here first: start any that
   * an earlier attempt created but never started, and mark their index as
   * handled so the main loop below does not try to create them again.
   */
  private async recoverAdvisorWorkActions(turnId: string): Promise<{ notices: string[]; recoveredIndexes: Set<number> }> {
    const notices: string[] = [];
    const recoveredIndexes = new Set<number>();
    const t = ADVISOR_TEXT[ownerLanguage(this.db)];
    const rows = this.db.all<{ key: string; response_json: string }>(
      "SELECT key, response_json FROM idempotency_keys WHERE key LIKE ?",
      `%:advisor-work:${turnId}:%`,
    );
    for (const row of rows) {
      // Work commands scope their key as <event>:<work>:-:-:-:advisor-work:turn:index:op.
      const parts = row.key.split(":");
      if (parts.length !== 9 || parts[5] !== "advisor-work" || parts[6] !== turnId) continue;
      const index = Number.parseInt(parts[7], 10);
      if (!Number.isInteger(index) || index < 0) continue;
      let response: unknown;
      try {
        response = JSON.parse(row.response_json);
      } catch (parseError) {
        console.warn("[owl-core] Skipping malformed advisor-work idempotency response_json", parseError);
        continue;
      }
      if (!isRecord(response) || !isRecord(response.data) || typeof response.data.work_id !== "string") continue;
      const workId = response.data.work_id;

      if (parts[8] !== "create") {
        const actionType = advisorWorkTypeForKey(parts[8]!);
        if (!actionType) continue;
        const work = this.db.get<{ title: string; display_number: number | null }>(
          "SELECT title, display_number FROM works WHERE id = ?",
          workId,
        );
        if (!work) continue;
        recoveredIndexes.add(index);
        notices.push(t.workActionAlreadyApplied(actionType, workRef(ownerLanguage(this.db), work.title, work.display_number, workId)));
        continue;
      }

      const work = this.db.get<{ title: string; size: "small" | "normal" | "large"; state: WorkState; state_version: number }>(
        "SELECT title, size, state, state_version FROM works WHERE id = ?",
        workId,
      );
      if (!work) continue;
      recoveredIndexes.add(index);
      if (work.state !== "memo" && work.state !== "ready") {
        // Already started (or further along) by an earlier attempt; nothing to recover.
        continue;
      }
      try {
        await this.startWork(workId, {
          request_id: turnId,
          idempotency_key: `advisor-work:${turnId}:${index}:start`,
          expected_version: work.state_version,
          payload: { mode: work.size === "small" ? "small" : "normal" },
        });
        notices.push(t.createdRecovered(work.title, workId));
      } catch (error) {
        const detail = error instanceof Error ? error.message.slice(0, 300) : t.unknownCause;
        notices.push(t.createdNotStarted(work.title, workId, detail));
      }
    }
    return { notices, recoveredIndexes };
  }

  /**
   * The Advisor process has no direct write access to Owl's database/API.
   * Explicit Work actions in its response are therefore executed here by
   * Core, where normal validation, idempotency, and workflow dispatch apply.
   */
  private async dispatchAdvisorWorkActions(
    conversationId: string,
    turnId: string,
    actions: readonly AdvisorSuggestedAction[],
    recoveredIndexes: ReadonlySet<number> = new Set(),
  ): Promise<{ notices: string[]; handledIndexes: Set<number> }> {
    const notices: string[] = [];
    const handledIndexes = new Set<number>();
    const curatedKinds = new Set<CurationKind>();
    const t = ADVISOR_TEXT[ownerLanguage(this.db)];
    const inheritedProject = this.db.get<{ project_id: string | null }>(
      `SELECT work.project_id
         FROM conversations AS conversation
         LEFT JOIN works AS work ON work.id = conversation.work_id
        WHERE conversation.id = ?`,
      conversationId,
    )?.project_id ?? null;

    for (const [index, action] of actions.entries()) {
      // The action list is untrusted input: a Set membership test keeps
      // inherited keys ("toString", "constructor", …) out of the curation
      // path entirely, and advisorCurationKind only reads own properties.
      if (ADVISOR_CURATION_ACTION_TYPES.has(action.type)) {
        const kind = advisorCurationKind(action.type);
        if (kind === null) continue;
        handledIndexes.add(index);
        // A reply that repeats a tidy-up must not run the same curation twice.
        if (curatedKinds.has(kind)) continue;
        curatedKinds.add(kind);
        try {
          const { run, started } = await this.startCurationInBackground({
            kind,
            trigger: "advisor_action",
            actor: "advisor",
            actor_ref: turnId,
            request_key: `advisor-curation:${turnId}:${index}`,
          });
          notices.push(t.curationStarted(kind, run.id, !started));
        } catch (error) {
          notices.push(t.curationFailed(kind, error instanceof Error ? error.message.slice(0, 300) : t.unknownCause));
        }
        continue;
      }
      if (ADVISOR_WORK_OPERATION_ACTION_TYPES.has(action.type)) {
        if (!isAdvisorWorkOperationType(action.type)) continue;
        handledIndexes.add(index);
        if (recoveredIndexes.has(index)) continue;
        notices.push(await this.runAdvisorWorkOperation(turnId, index, action, action.type, t));
        continue;
      }
      if (action.type !== "create_work") continue;
      handledIndexes.add(index);
      if (recoveredIndexes.has(index)) {
        // recoverAdvisorWorkActions already created (and, if needed, started)
        // this index's Work on an earlier attempt; do not create a second one
        // even if this attempt's AI output describes it differently.
        continue;
      }
      const payload = action.payload;
      const title = payload?.title;
      const summary = payload?.summary;
      const size = payload?.size;
      const designMode = payload?.design_mode ?? "auto";
      const draft = payload !== null && typeof payload === "object" && "draft" in payload ? payload.draft : false;
      if (
        typeof draft !== "boolean" ||
        typeof title !== "string" || title.trim().length === 0 || title.length > 500 ||
        typeof summary !== "string" || summary.trim().length === 0 || summary.length > 20_000 ||
        (size !== "small" && size !== "normal" && size !== "large") ||
        (designMode !== "auto" && designMode !== "lead")
      ) {
        notices.push(t.createIncomplete);
        continue;
      }
      const requestedProjectId = payload?.project_id;
      if (requestedProjectId !== undefined && requestedProjectId !== null && typeof requestedProjectId !== "string") {
        notices.push(t.createBadProject);
        continue;
      }
      const projectId = typeof requestedProjectId === "string" ? requestedProjectId : inheritedProject;
      const backlogItemIds: unknown = payload?.backlog_item_ids === undefined ? [] : payload.backlog_item_ids;
      const dismissItemIds: unknown = payload?.dismiss_backlog_item_ids === undefined ? [] : payload.dismiss_backlog_item_ids;
      const isIdList = (value: unknown): value is string[] =>
        Array.isArray(value) && value.every((id) => typeof id === "string");
      if (!isIdList(backlogItemIds) || !isIdList(dismissItemIds)) {
        notices.push(t.createFailed("backlog_item_ids and dismiss_backlog_item_ids must be arrays of strings."));
        continue;
      }
      const createKey = `advisor-work:${turnId}:${index}:create`;
      let createdWorkId: string | null = null;
      try {
        const created = await this.createWork({
          request_id: turnId,
          idempotency_key: createKey,
          expected_version: 0,
          payload: {
            title: title.trim(),
            summary: summary.trim(),
            size,
            project_id: projectId,
            ...(designMode === "lead" ? { design_mode: "lead" as const } : {}),
            ...(backlogItemIds.length > 0 ? { backlog_item_ids: backlogItemIds } : {}),
            ...(dismissItemIds.length > 0 ? { dismiss_backlog_item_ids: dismissItemIds } : {}),
          },
        });
        createdWorkId = created.data.work_id;
        if (draft) {
          notices.push(t.createdDraft(title.trim(), createdWorkId));
          continue;
        }
        await this.startWork(createdWorkId, {
          request_id: turnId,
          idempotency_key: `advisor-work:${turnId}:${index}:start`,
          expected_version: created.version,
          payload: { mode: size === "small" ? "small" : "normal" },
        });
        notices.push(t.created(title.trim(), size === "small" ? "Worker" : "Manager", createdWorkId));
      } catch (error) {
        const detail = error instanceof Error ? error.message.slice(0, 300) : t.unknownCause;
        notices.push(createdWorkId
          ? t.createdNotStarted(title.trim(), createdWorkId, detail)
          : t.createFailed(detail));
      }
    }
    return { notices, handledIndexes };
  }

  private async runAdvisorWorkOperation(
    turnId: string,
    index: number,
    action: AdvisorSuggestedAction,
    type: AdvisorWorkOperationType,
    t: (typeof ADVISOR_TEXT)[OwnerLanguage],
  ): Promise<string> {
    const payload = action.payload;
    const rawWorkId = payload?.work_id;
    if (typeof rawWorkId !== "string" || rawWorkId.trim().length < 1 || rawWorkId.trim().length > 128) {
      return t.workActionIncomplete(type);
    }
    const workId = rawWorkId.trim();
    let body: string | undefined;
    let reopen = false;
    let title: string | undefined;
    let summary: string | undefined;
    let pauseReason = "Advisor requested pause.";
    let cancelReason: string | undefined;
    let resumeBody: string | undefined;

    if (type === "send_work_instruction") {
      const rawBody = payload?.body;
      const requestedReopen = payload?.reopen;
      if (typeof rawBody !== "string" || rawBody.trim().length < 1 || rawBody.length > 100_000 || (requestedReopen !== undefined && typeof requestedReopen !== "boolean")) {
        return t.workActionIncomplete(type);
      }
      body = rawBody.trim();
      reopen = requestedReopen === true;
    } else if (type === "update_work") {
      const rawTitle = payload?.title;
      const rawSummary = payload?.summary;
      if (
        (rawTitle === undefined && rawSummary === undefined) ||
        (rawTitle !== undefined && (typeof rawTitle !== "string" || rawTitle.trim().length < 1 || rawTitle.length > 500)) ||
        (rawSummary !== undefined && (typeof rawSummary !== "string" || rawSummary.trim().length < 1 || rawSummary.length > 20_000))
      ) {
        return t.workActionIncomplete(type);
      }
      title = typeof rawTitle === "string" ? rawTitle.trim() : undefined;
      summary = typeof rawSummary === "string" ? rawSummary.trim() : undefined;
    } else if (type === "pause_work") {
      const reason = payload?.reason;
      if (reason !== undefined && (typeof reason !== "string" || reason.length > 1_000)) return t.workActionIncomplete(type);
      if (typeof reason === "string") pauseReason = reason.trim();
    } else if (type === "resume_work") {
      const rawBody = payload?.body;
      if (rawBody !== undefined && (typeof rawBody !== "string" || rawBody.trim().length < 1 || rawBody.length > 10_000)) return t.workActionIncomplete(type);
      resumeBody = typeof rawBody === "string" ? rawBody.trim() : undefined;
    } else if (type === "cancel_work") {
      const reason = payload?.reason;
      if (typeof reason !== "string" || reason.trim().length < 1 || reason.trim().length > 1_000) return t.workActionIncomplete(type);
      cancelReason = reason.trim();
    }

    const language = ownerLanguage(this.db);
    const work = this.db.get<{ title: string; display_number: number | null; state: WorkState; state_version: number }>(
      "SELECT title, display_number, state, state_version FROM works WHERE id = ?",
      workId,
    );
    if (!work) return t.workNotFound(workId);
    const ref = workRef(language, work.title, work.display_number, workId);
    const request = {
      request_id: turnId,
      idempotency_key: `advisor-work:${turnId}:${index}:${advisorWorkKeyForType(type)}`,
      expected_version: work.state_version,
    };

    try {
      switch (type) {
        case "send_work_instruction": {
          await this.postWorkInstruction(workId, { ...request, payload: { body: body!, reopen } });
          return work.state === "completed" ? t.instructionSentReopened(ref) : t.instructionSent(ref);
        }
        case "update_work": {
          const result = await this.updateWork(workId, {
            ...request,
            payload: { ...(title === undefined ? {} : { title }), ...(summary === undefined ? {} : { summary }) },
          });
          return result.data.changed_fields.length === 0
            ? t.workUnchanged(ref)
            : t.workUpdated(ref, result.data.changed_fields, result.data.replan_queued);
        }
        case "pause_work":
          await this.pauseWork(workId, { ...request, payload: { reason: pauseReason } });
          return t.workPaused(ref);
        case "resume_work": {
          const result = await this.resumeWorkOrRetryDecision(workId, { ...request, payload: { source: "advisor", ...(resumeBody === undefined ? {} : { body: resumeBody }) } });
          return result.data.resumed_by === "resume" ? t.workResumed(ref) : t.workRetried(ref);
        }
        case "cancel_work":
          await this.cancelWork(workId, { ...request, payload: { reason: cancelReason!, force: false } });
          return t.workCancelledNotice(ref);
        case "delete_work":
          await this.deleteWork(workId, { ...request, payload: {} });
          return t.workDeletedNotice(ref);
      }
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
      const currentState = this.db.get<{ state: WorkState }>("SELECT state FROM works WHERE id = ?", workId)?.state ?? work.state;
      if (code === "work_not_found") return t.workNotFound(workId);
      if (type === "send_work_instruction") {
        if (code === "work_cancelled") return t.instructionCancelled(ref);
        if (code === "work_reopen_required") return t.instructionReopenRequired(ref);
        if (code === "invalid_state_transition" && (currentState === "memo" || currentState === "ready")) {
          return t.instructionNotStarted(ref);
        }
      }
      if (code === "invalid_state_transition") return t.notAllowedInState(type, ref, currentState);
      if (code === "version_conflict") return t.workActionConflict(ref);
      if (code === "idempotency_conflict") return t.workActionAlreadyApplied(type, ref);
      const detail = error instanceof Error ? error.message.slice(0, 300) : t.unknownCause;
      return t.workActionFailed(type, ref, detail);
    }
  }

  /** Phase 4: AdvisorSessionRuntime.onError — persist the failure as a visible Advisor message. */
  private async persistAdvisorError(
    conversationId: string,
    errorMessage: string,
    turnId: string,
    origin: { channel: string; channel_id?: string; ref?: string },
  ): Promise<void> {
    const conversation = this.db.get<{ id: string; owner_id: string }>(
      "SELECT id, owner_id FROM conversations WHERE id = ?",
      conversationId,
    );
    if (!conversation) return;

    const now = utcNow();
    const messageId = createUlid();
    const sourceMessageId = `advisor:error:${turnId}`;
    const language = ownerLanguage(this.db);
    const body = `${ADVISOR_TEXT[language].replyFailed}\n${formatRuntimeFailure(errorMessage, "Advisor", language)}`;

    await this.writeLane.write({
      mutateState: (transaction) => {
        const account = transaction.get<{ id: string }>(
          "SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'",
          conversation.owner_id,
        );
        if (!account) {
          throw dependencyUnavailable(
            "Web connector account is missing; the Advisor error cannot be displayed.",
            { owner_id: conversation.owner_id, provider: "web" },
          );
        }
        transaction.run(
          `INSERT OR IGNORE INTO messages
             (id, conversation_id, provider, account_id, source_message_id, body,
              attachment_ids_json, received_at, created_at)
           VALUES (?, ?, 'web', ?, ?, ?, ?, ?, ?)`,
          messageId,
          conversationId,
          account.id,
          sourceMessageId,
          body,
          JSON.stringify([]),
          now,
          now,
        );
      },
      event: {
        id: createUlid(),
        idempotencyKey: `advisor-error:${conversationId}:${turnId}`,
        type: "advisor.responded",
        payload: {
          kind: "advisor_error",
          schema_version: "1.0.0",
          conversation_id: conversationId,
          message_id: messageId,
          turn_id: turnId,
          reply: body,
          origin,
        },
      },
      outbox: [],
    });
  }

  /**
   * Keeps the owner-wide Advisor session resident: brings it up when no
   * provider process is alive (first start, exit, crash) and moves it onto
   * changed settings. It is anchored to the current session's conversation,
   * else to `conversationId`, else to the newest active conversation; with
   * none, the Web conversation is created the way the Web view creates it.
   * Never throws: a paused, unconfigured, or failing provider is retried on
   * the next tick, backing off exponentially (1m up to 30m) while bring-ups
   * keep failing or the fresh process keeps dying; `force` (a settings change
   * or a clear) skips and resets that backoff.
   */
  private async keepAdvisorResident(conversationId?: string, force = false): Promise<void> {
    if (!this.advisorRuntime || !this.started) return;
    if (force) {
      this.advisorResidentFailures = 0;
      this.advisorResidentRetryAt = 0;
    } else if (Date.now() < this.advisorResidentRetryAt) {
      return;
    }
    const currentSessionId = (): string | null =>
      this.db.get<{ id: string }>(
        `SELECT id FROM advisor_sessions WHERE status IN ('starting', 'running', 'ending', 'suspended')
          ORDER BY created_at DESC LIMIT 1`,
      )?.id ?? null;
    const before = currentSessionId();
    let failed = false;
    try {
      const anchor = this.db.get<{ owner_id: string; conversation_id: string }>(
        `SELECT conversation.owner_id AS owner_id, conversation.id AS conversation_id
           FROM advisor_sessions AS session
           JOIN conversations AS conversation ON conversation.id = session.conversation_id
          WHERE session.status IN ('starting', 'running', 'ending', 'suspended')
          ORDER BY session.created_at DESC LIMIT 1`,
      ) ?? (conversationId ? null : this.db.get<{ owner_id: string; conversation_id: string }>(
        `SELECT conversation.owner_id AS owner_id, conversation.id AS conversation_id
           FROM advisor_sessions AS session
           JOIN conversations AS conversation ON conversation.id = session.conversation_id
          WHERE session.status = 'ended'
          ORDER BY session.ended_at DESC LIMIT 1`,
      )) ?? this.db.get<{ owner_id: string; conversation_id: string }>(
        `SELECT owner_id, id AS conversation_id FROM conversations
          WHERE ${conversationId ? "id = ?" : "is_active = 1 AND archived_at IS NULL AND (channel <> 'web' OR work_id IS NULL)"}
          ORDER BY updated_at DESC LIMIT 1`,
        ...(conversationId ? [conversationId] : []),
      ) ?? { owner_id: DEFAULT_OWNER_ID, conversation_id: (await this.getActiveConversation()).conversation_id };
      await this.advisorRuntime.ensureResident(anchor.owner_id, anchor.conversation_id);
      this.lastAdvisorResidentError = null;
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastAdvisorResidentError) {
        this.lastAdvisorResidentError = message;
        console.error("[owl-core] Could not keep the Advisor session resident", error);
      }
    }
    const now = Date.now();
    const after = currentSessionId();
    const resident = this.advisorResidentSession;
    // A session this loop brought up that is already replaced within minutes
    // counts as a failed bring-up, like a spawn error does.
    if (!failed && !force && resident !== null && before === resident.id && after !== before && now - resident.upAt < 5 * 60_000) {
      failed = true;
    }
    if (after !== null && after !== resident?.id) this.advisorResidentSession = { id: after, upAt: now };
    if (failed && !force) {
      this.advisorResidentFailures += 1;
      this.advisorResidentRetryAt = now + Math.min(30, 2 ** (this.advisorResidentFailures - 1)) * 60_000;
    } else if (!failed) {
      this.advisorResidentFailures = 0;
    }
  }

  /** Work, Task and liveness of the given agent runs, for the leftover-process sweep. */
  private sweepRunInfo(ids: readonly string[]): ReadonlyMap<string, SweepRunInfo> {
    const info = new Map<string, SweepRunInfo>();
    for (const id of ids) {
      const verification = parseVerificationMarker(id);
      if (verification !== null) {
        // Verification commands belong to a Task or Work; its activity keeps them alive while it runs.
        const owner = "taskId" in verification
          ? this.db.get<{ work_id: string; task_id: string }>("SELECT work_id, id AS task_id FROM tasks WHERE id = ?", verification.taskId)
          : this.db.get<{ work_id: string; task_id: null }>("SELECT id AS work_id, NULL AS task_id FROM works WHERE id = ?", verification.workId);
        if (owner) info.set(id, { work_id: owner.work_id, task_id: owner.task_id, active: false });
        continue;
      }
      if (this.advisorRuntime?.isSessionLive(id)) {
        info.set(id, { work_id: null, task_id: null, active: true });
        continue;
      }
      if (this.db.get<{ id: string }>("SELECT id FROM advisor_sessions WHERE id = ?", id)) {
        info.set(id, { work_id: null, task_id: null, active: false });
      }
    }
    for (let from = 0; from < ids.length; from += 400) {
      const chunk = ids.slice(from, from + 400);
      const rows = this.db.all<{ id: string; work_id: string; task_id: string | null; status: string }>(
        `SELECT id, work_id, task_id, status FROM agent_runs WHERE id IN (${chunk.map(() => "?").join(",")})`,
        ...chunk,
      );
      for (const row of rows) {
        info.set(row.id, { work_id: row.work_id, task_id: row.task_id, active: ["launch_pending", "spawned", "running", "cancel_requested"].includes(row.status) });
      }
    }
    return info;
  }

  /** Workspace directories an agent run or an in-progress verification still uses. */
  private workspaceActivity(): WorkspaceActivity {
    const works = new Set<string>();
    const tasks = new Set<string>();
    const mark = (workId: string, taskId: string | null): void => {
      works.add(safeSegment(workId));
      if (taskId !== null) tasks.add(`${safeSegment(workId)}/${safeSegment(taskId)}`);
    };
    for (const run of this.db.all<{ work_id: string; task_id: string | null }>(
      `SELECT work_id, task_id FROM agent_runs WHERE status IN (${ACTIVE_AGENT_RUN_STATUSES_SQL})`,
    )) mark(run.work_id, run.task_id);
    for (const task of this.db.all<{ work_id: string; task_id: string }>("SELECT work_id, id AS task_id FROM tasks WHERE status = 'verifying'")) {
      mark(task.work_id, task.task_id);
    }
    // A Task waiting for a process its Worker started: the process still works in the worktree.
    for (const task of this.db.all<{ work_id: string; task_id: string }>(
      "SELECT work_id, id AS task_id FROM tasks WHERE status IN ('waiting', 'paused') AND json_extract(prerequisite_json, '$.source') = 'worker'",
    )) mark(task.work_id, task.task_id);
    for (const pipeline of this.workflow.activePipelineTasks()) mark(pipeline.workId, pipeline.taskId);
    if (this.git instanceof GitWorktreeGateway) {
      for (const workId of this.git.verifyingWorkIds()) mark(workId, null);
    }
    return { works, tasks };
  }

  /** A Task pipeline settled: schedule its Work again right away. */
  private onTaskSettled(workId: string): void {
    if (!this.started) return;
    this.workDriver.wake(workId);
    const work = this.db.get<{ state: string }>("SELECT state FROM works WHERE id = ?", workId);
    if (work?.state === "cancelled") this.trackWorktreeReconcile(workId, "task_settled_after_cancel");
  }

  /** Fire-and-forget reconcile that stop() still waits for, so teardown cannot race its disk writes. */
  private trackWorktreeReconcile(workId: string, reason: string): void {
    const run = this.runWorktreeReconcile(workId, reason).then(
      () => undefined,
      (error) => { console.error(`[owl-core] Worktree reconcile failed for Work ${workId} (${reason})`, error); },
    );
    this.worktreeReconciles.add(run);
    void run.finally(() => this.worktreeReconciles.delete(run));
  }

  /**
   * Remove worktrees a Task or Work no longer needs (superseded/cancelled
   * Tasks, a finished Work's integration worktree). Never throws: a failure
   * here must not block the caller, since the next reconcile pass retries it.
   */
  private async runWorktreeReconcile(
    workId: string | undefined,
    reason: string,
  ): Promise<WorktreeReconcileOutcome> {
    const failures: WorktreeReconcileFailure[] = [];
    // Leftover processes in the workspaces are stopped before their worktrees go away.
    await this.workspaceSweeper.sweep(workId === undefined ? {} : { workId: safeSegment(workId) });
    try {
      const result = await reconcileWorktrees(
        { db: this.db, writeLane: this.writeLane, git: this.git, owlRoot: this.owlRoot, dataDir: this.dataDir, layout: this.workspaceLayout },
        { work_id: workId, reason },
      );
      failures.push(...(result.failures ?? []));
      for (const entry of await this.git.listWorkspaces()) {
        if (this.db.get("SELECT 1 FROM works WHERE id = ?", entry.work_id) === undefined) continue; // another Owl instance's Work
        if (!failures.some((failure) => failure.work_id === entry.work_id)) {
          failures.push({
            work_id: entry.work_id,
            path: entry.path,
            message: `Worktree ${entry.path} is still on disk after reconciliation.`,
          });
        }
      }
      if (workId !== undefined && failures.some((failure) => failure.work_id === workId)) {
        console.warn(`[owl-core] Worktree reconcile left worktrees for Work ${workId}; merged branch cleanup will be retried later.`);
      }
      return { verified: true, failures };
    } catch (error) {
      console.error(`[owl-core] Worktree reconcile failed${workId ? ` for Work ${workId}` : ""} (${reason})`, error);
      return { verified: false, failures, error_message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Why a merged Work's branch cleanup must be skipped after reconciliation, or undefined when it may proceed. */
  private worktreeCleanupFailure(workId: string, worktrees: WorktreeReconcileOutcome): string | undefined {
    const branch = `owl/work/${workId}/work`;
    const failure = worktrees.failures.find((item) => item.work_id === workId);
    if (!worktrees.verified) {
      const path = failure?.path ?? this.workspaceLayout.workDir(workId);
      const cause = failure?.message ?? worktrees.error_message ?? "Git worktree cleanup could not be verified.";
      return `Could not verify removal of worktree ${path} before deleting branch ${branch}: ${cause}`;
    }
    if (failure) return `Could not remove worktree ${failure.path} before deleting branch ${branch}: ${failure.message}`;
    return undefined;
  }

  public async tick(workId: string): Promise<WorkflowSnapshot> {
    if (!this.started) return this.workflow.snapshot(workId);
    const taskCount = this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE work_id = ?", workId);
    if (Number(taskCount?.count ?? 0) === 0) {
      try {
        const work = this.db.get<{ size: WorkDbRow["size"] }>("SELECT size FROM works WHERE id = ?", workId);
        if (work?.size === "small") {
          await this.runDirectWorkerTask(workId);
        } else {
          await this.runInitialManagerPlan(workId, "normal");
        }
      } catch (error) {
        if (!this.started) return this.workflow.snapshot(workId);
        await this.recordTickFailure(workId, error);
        return this.workflow.snapshot(workId);
      }
      if (!this.started) return this.workflow.snapshot(workId);
    }
    await this.checkPrerequisites(workId);
    if (!this.started) return this.workflow.snapshot(workId);
    try {
      await this.workflow.tick(workId);
    } catch (error) {
      if (!this.started) return this.workflow.snapshot(workId);
      throw humanizeUnexpected(error, "workflow.tick");
    }
    if (!this.started) return this.workflow.snapshot(workId);
    this.wakePrerequisiteWaiters(workId, false);
    // A failed Task whose Manager replan never ran (Core stopped, restart,
    // Agent cancellation, a concurrent replan) still has a queued trigger.
    // Replay it once before the Work can be judged.
    const workState = this.db.get<Pick<WorkDbRow, "state">>("SELECT state FROM works WHERE id = ?", workId)?.state;
    // A failed Task can trigger a Manager replan asynchronously while this
    // tick is settling. Do not fall through to the all-terminal check below:
    // it would see the pre-replan failed Tasks and stop the Work before the
    // Manager has a chance to apply its plan. The periodic WorkDriver tick
    // will re-evaluate the Work after the in-flight replan settles.
    if (workState === "running" && this.replansInFlight.has(workId)) {
      return this.workflow.snapshot(workId);
    }
    const queuedReplans = workState !== "running" || this.replansInFlight.has(workId) ? [] : this.queuedReplanTasks(workId);
    if (queuedReplans.length > 0) {
      await this.triggerManagerReplan(
        workId,
        queuedReplans.map((task) => task.id),
        { kind: "queued_failed_tasks" },
        queuedReplans.flatMap((task) => (task.question === null ? [] : [{ task_id: task.id, question: task.question }])),
      );
      if (this.started) await this.announceCoreDecisions(workId);
      if (this.started) await this.dispatcher.replayPending();
      return this.workflow.snapshot(workId);
    }
    const newDesigns = workState === "running" && !this.hasQueuedOwnerReplan(workId) ? this.newlyCompletedDesignTasks(workId) : [];
    if (newDesigns.length > 0) {
      await this.triggerManagerReplan(workId, [], { kind: "design_completed", design_task_ids: newDesigns });
      if (this.started) await this.announceCoreDecisions(workId);
      return this.workflow.snapshot(workId);
    }
    const terminalCheck = this.checkTerminalTasks(workId);
    // An Owner request reaches the Manager even while Tasks are still
    // running or blocked; the Manager decides what happens to them.
    if (terminalCheck.allTerminal || this.hasQueuedOwnerReplan(workId)) {
      const work = this.db.get<Pick<WorkDbRow, "state">>("SELECT state FROM works WHERE id = ?", workId);
      if (!work) {
        throw notFound("work", workId);
      }
      const ownerReplan = (work.state === "running" || work.state === "judgement_waiting") && !this.replansInFlight.has(workId)
        ? await this.consumeOwnerReplan(workId)
        : null;
      if (ownerReplan !== null) {
        // Root failures only: a Task that failed because its dependency
        // failed is neither retried nor replaced by the Manager; it returns
        // to waiting once the dependency is retried or replaced (row 31).
        const failedIds = this.db.all<{ id: string }>(
          `SELECT id FROM tasks
            WHERE work_id = ? AND status = 'failed' AND failed_by_dependency_task_id IS NULL
            ORDER BY created_at ASC, id ASC`,
          workId,
        ).map((task) => task.id);
        // After an incomplete final check the Manager gets the verdict's
        // summary and missing items, not only the Owner's answer.
        const latestAlert = (ownerReplan.kind === "decision" || ownerReplan.kind === "auto_conflict" || ownerReplan.kind === "auto_final") && failedIds.length === 0 ? this.latestSystemAlert(workId) : null;
        const finalVerdict = incompleteFinalVerdict(latestAlert);
        const baseConflict = baseMergeConflict(latestAlert);
        const integrationReplan = ownerReplan.kind === "decision" && failedIds.length === 0 ? integrationVerificationReplan(latestAlert) : null;
        const trigger: ManagerTrigger = {
          kind: "owner_request",
          owner_replan_kind: ownerReplan.kind,
          automatic: ownerReplan.kind === "auto_conflict" || ownerReplan.kind === "auto_final",
          situation: integrationReplan !== null ? "integration_verification"
            : failedIds.length > 0 ? "failed_tasks"
              : baseConflict !== null ? "base_merge_conflict"
                : finalVerdict !== null ? "final_incomplete"
                  : "other",
        };
        await this.triggerManagerReplan(workId, failedIds, trigger, [], finalVerdict, ownerReplan, integrationReplan, baseConflict);
        if (this.started) await this.announceCoreDecisions(workId);
        return this.workflow.snapshot(workId);
      }
      if (work.state === "running" && terminalCheck.allTerminal) {
        if (terminalCheck.anyFailed) {
          await this.recordTickFailure(workId, new Error("One or more tasks failed. Manual intervention required."));
        } else {
          // All Tasks completed: the Final Manager reviews every Task report
          // and gives a verdict before Core commits Work completion. A
          // Manager call that throws (provider failure, unparsable output)
          // degrades to the same judgement_waiting path as a tick failure
          // instead of crashing the driver loop.
          try {
            // The Project's checks run again on the Work branch with every
            // Task merged: Tasks that pass alone can still fail together.
            const integration = await this.runWorkIntegrationVerification(workId);
            if (!this.started) return this.workflow.snapshot(workId);
            if (integration.kind === "routed") {
              await this.announceCoreDecisions(workId);
              return this.workflow.snapshot(workId);
            }
            const finalOutcome = await this.runFinalManager(workId, integration.verification);
            if (!this.started || finalOutcome === null) return this.workflow.snapshot(workId);
            const { verdict, agent_run_id: agentRunId } = finalOutcome;
            if (verdict.verdict === "complete") {
              // An instruction that arrived during the final check goes to the Manager first.
              const pendingReplan = this.db.get<{ key: string }>(
                "SELECT key FROM idempotency_keys WHERE key = ? AND json_extract(response_json, '$.status') = 'queued'",
                ownerReplanKey(workId),
              );
              if (pendingReplan) return this.workflow.snapshot(workId);
              const workProject = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId);
              let mergeRecord: JsonObject | undefined;
              if (workProject?.project_id !== null && workProject?.project_id !== undefined) {
                let merge: GitWorkMergeResult;
                const expected = this.db.get<{ state_version: number }>("SELECT state_version FROM works WHERE id = ?", workId);
                try {
                  const verified = integration.verification;
                  merge = await this.git.mergeWorkIntoBase({
                    work_id: workId,
                    expected_state_version: expected?.state_version,
                    ...(verified.status === "passed" && verified.work_commit !== null ? { verified_commit: verified.work_commit } : {}),
                  });
                } catch (error) {
                  await this.recordWorkMergeFailed(workId, null, error);
                  return this.workflow.snapshot(workId);
                }
                // A pause or cancel during the merge left the base unchanged;
                // the Work's new state decides what happens next.
                if (merge.kind === "interrupted") return this.workflow.snapshot(workId);
                if (merge.kind !== "merged") {
                  let autoAttempts = 0;
                  if (merge.kind === "conflict") {
                    const auto = await this.tryAutoResolveMergeConflict(workId, merge);
                    if (auto.handled) return this.workflow.snapshot(workId);
                    autoAttempts = auto.attempts;
                  }
                  await this.recordWorkMergeFailed(workId, merge, undefined, autoAttempts);
                  return this.workflow.snapshot(workId);
                }
                if (merge.verification_skipped !== undefined) {
                  await this.writeLane.write({
                    mutateState: () => ({}),
                    event: {
                      idempotencyKey: `work-merge-verification-skipped:${workId}:${createUlid()}`,
                      type: "work.merge_verification_skipped",
                      workId,
                      payload: { schema_version: "1.0.0", work_id: workId, verified_commit: merge.verification_skipped.verified_commit, merge_commit: merge.merge_commit, tree: merge.verification_skipped.tree },
                    },
                    outbox: [{ provider: "websocket" }],
                  });
                }
                this.wakePrerequisiteWaiters(workId, true);
                mergeRecord = {
                  base_branch: merge.base_branch,
                  work_branch: merge.work_branch,
                  old_base_commit: merge.old_base_commit,
                  new_base_commit: merge.new_base_commit,
                  merge_commit: merge.merge_commit,
                  verification_commands_run: [...merge.verification_commands_run],
                };
              }
              const completed = await this.workflow.completeWorkIfReady(workId, "complete", mergeRecord, {
                agent_run_id: agentRunId,
                project_id: workProject?.project_id ?? null,
                lessons: verdict.lessons.map(normalizeLesson),
              }, verdict.unaddressed_backlog_items.map((entry) => entry.item_id));
              if (completed) {
                await this.proposeRulesFromMetrics(workId);
                if (verdict.lessons.length > 0) {
                  this.scheduleLearningRun(`Work ${workId}`);
                }
                this.scheduleProjectOverviewForWork(workId, workProject?.project_id ?? null, mergeRecord);
                const worktrees = await this.runWorktreeReconcile(workId, "work_completed");
                if (workProject?.project_id !== null && workProject?.project_id !== undefined) {
                  await this.deleteMergedWorkBranches(workId, this.worktreeCleanupFailure(workId, worktrees));
                  if (mergeRecord !== undefined) await this.pushCompletedWork(workId, workProject.project_id);
                  if (mergeRecord !== undefined) this.schedulePostMergeCommand(workId, workProject.project_id, mergeRecord);
                }
              }
            } else {
              await this.recordFinalManagerIncomplete(workId, verdict);
              await this.enqueueWorkLearnings(workId, agentRunId, verdict);
            }
          } catch (error) {
            if (!this.started) return this.workflow.snapshot(workId);
            // A final check that could not run is not an "incomplete"
            // verdict: its Decision offers to run the check again.
            if (isCodedError(error) && error.code === "final_manager_failed") {
              await this.recordFinalManagerFailed(workId, error);
            } else {
              await this.recordTickFailure(workId, error);
            }
          }
        }
      }
    }
    this.wakePrerequisiteWaiters(workId, false);
    if (this.started) await this.announceCoreDecisions(workId);
    if (this.started) await this.dispatcher.replayPending();
    return this.workflow.snapshot(workId);
  }

  /**
   * Decisions opened inside a reducer transaction (ensureCoreDecision) have
   * no decision.opened event of their own, so connectors never announced
   * them. Emit one per open Core Decision, keyed by the Decision id.
   */
  private async announceCoreDecisions(workId?: string): Promise<void> {
    const rows = this.db.all<{
      id: string; work_id: string; scope: string; blocked_task_ids_json: string; reason: string; question: string;
      tried: string; current_state: string; options_json: string; recommended: string | null; allow_free_text: number;
    }>(
      `SELECT id, work_id, scope, blocked_task_ids_json, reason, question, tried, current_state, options_json,
              recommended, allow_free_text
         FROM decisions
        WHERE status = 'open' AND issuer_role = 'core' AND (? IS NULL OR work_id = ?)
          AND NOT EXISTS (SELECT 1 FROM events WHERE events.idempotency_key = 'decision-opened:core:' || decisions.id)
          AND NOT EXISTS (
            SELECT 1 FROM events
             WHERE events.type = 'decision.opened' AND events.work_id = decisions.work_id
               AND json_extract(events.payload_json, '$.decision_id') = decisions.id
          )`,
      workId ?? null,
      workId ?? null,
    );
    for (const row of rows) {
      try {
        await this.writeLane.write({
          mutateState: () => null,
          event: {
            idempotencyKey: `decision-opened:core:${row.id}`,
            type: "decision.opened",
            workId: row.work_id,
            payload: {
              decision_id: row.id,
              work_id: row.work_id,
              scope: row.scope,
              blocked_task_ids: JSON.parse(row.blocked_task_ids_json) as JsonObject[],
              reason: row.reason,
              question: row.question,
              tried: row.tried,
              current_state: row.current_state,
              options: JSON.parse(row.options_json) as JsonObject[],
              recommended: row.recommended,
              allow_free_text: row.allow_free_text === 1,
              issuer_role: "core",
              language: ownerLanguage(this.db),
            },
          },
          outbox: [{ provider: "websocket" }],
        });
      } catch (error) {
        console.error(`[owl-core] Failed to announce Decision ${row.id}`, error);
      }
    }
  }

  /**
   * Announce Decisions that closed as a side effect of something else
   * (a cancelled Work, a superseded Task) rather than through
   * DecisionService.resolve. `decisionIds` limits the sweep to Decisions a
   * caller just cancelled; omitted, it re-checks every cancelled Decision
   * (startup backfill), matching announceCoreDecisions's own pattern.
   */
  private async announceDecisionCancellations(decisionIds?: readonly string[]): Promise<void> {
    if (decisionIds !== undefined && decisionIds.length === 0) return;
    const idFilter = decisionIds !== undefined ? `AND decisions.id IN (${decisionIds.map(() => "?").join(",")})` : "";
    const rows = this.db.all<{ id: string; work_id: string; work_state: string }>(
      `SELECT decisions.id AS id, decisions.work_id AS work_id, works.state AS work_state
         FROM decisions JOIN works ON works.id = decisions.work_id
        WHERE decisions.status = 'cancelled' ${idFilter}
          AND NOT EXISTS (SELECT 1 FROM events WHERE events.idempotency_key = 'decision-cancelled:' || decisions.id)`,
      ...(decisionIds ?? []),
    );
    for (const row of rows) {
      try {
        await this.writeLane.write({
          mutateState: () => null,
          event: {
            idempotencyKey: `decision-cancelled:${row.id}`,
            type: "decision.cancelled",
            workId: row.work_id,
            payload: {
              decision_id: row.id,
              work_id: row.work_id,
              // A Decision closes this way either because its Work was
              // cancelled outright, or because the Task it was blocking was
              // superseded by a Manager replan while the Work kept running.
              reason: row.work_state === "cancelled" ? "work_cancelled" : "task_superseded",
            },
          },
          outbox: [{ provider: "websocket" }],
        });
      } catch (error) {
        console.error(`[owl-core] Failed to announce cancelled Decision ${row.id}`, error);
      }
    }
  }

  public workflowEngine(): WorkflowEngine {
    return this.workflow;
  }

  public gitGateway(): GitGateway {
    return this.git;
  }

  private checkTerminalTasks(workId: string): { allTerminal: boolean; anyFailed: boolean } {
    const tasks = this.db.all<{ status: TaskState; manager_task_id: string | null }>("SELECT status, manager_task_id FROM tasks WHERE work_id = ?", workId);
    if (tasks.length === 0) return { allTerminal: false, anyFailed: false };
    // A superseded (cancelled) Task left the plan without failing the Work.
    const allTerminal = tasks.every((task) => isTerminalTaskState(task.status));
    // A quarantine fix Task that could not fix its test does not stop the Work.
    const anyFailed = tasks.some((task) => task.status === "failed" && !task.manager_task_id?.startsWith(QUARANTINE_FIX_TASK_PREFIX));
    return { allTerminal, anyFailed };
  }

  private async recordTickFailure(workId: string, error: unknown): Promise<void> {
    // A Work that is no longer running (paused, cancelled, completed, or
    // already waiting on a Decision) is not driven by Core, so a failure of
    // an in-flight tick is neither an alert nor a reason to halt it. The
    // state is checked here and again inside the write, where a Work that
    // left `running` meanwhile rolls the alert event back.
    const ignore = (state: string | undefined): void => {
      console.warn(`[owl-core] Ignoring tick failure for Work ${workId} in state ${state ?? "missing"}`, error);
    };
    const currentState = this.db.get<Pick<WorkDbRow, "state">>("SELECT state FROM works WHERE id = ?", workId)?.state;
    if (currentState !== "running") {
      ignore(currentState);
      return;
    }
    const language = ownerLanguage(this.db);
    const failureMessage = formatRuntimeFailure(error, "Workflow", language);
    const alertPayload: JsonObject = {
      kind: "workflow_tick_failed",
      safe_reconcile_failed: true,
      driver_stopped: true,
      message: language === "en"
        ? `Core stopped driving the Work. ${failureMessage}`
        : `CoreはWorkの自動駆動を停止しました。${failureMessage}`,
      remediation: language === "en"
        ? "Check the Core log, resolve any Decision if needed, then resume the Work."
        : "Coreログを確認し、必要ならDecisionを解決してからWorkを再開してください。",
      failure: failureMessage,
    };
    const notRunning = new WorkNotRunningAbort();
    try {
      await this.writeLane.write({
        mutateState: (transaction) => {
          const work = transaction.get<Pick<WorkDbRow, "state" | "state_version">>(
            "SELECT state, state_version FROM works WHERE id = ?",
            workId,
          );
          if (!work) {
            throw notFound("work", workId);
          }
          if (work.state !== "running") {
            notRunning.state = work.state;
            throw notRunning;
          }
          reduceWorkInTransaction(transaction, workId, {
            event: "system.alert",
            expected_version: work.state_version,
            payload: alertPayload,
          });
          return { work_id: workId, state: work.state };
        },
        event: {
          id: createUlid(),
          idempotencyKey: `work-driver-alert:${workId}:${createUlid()}`,
          type: "system.alert",
          workId,
          payload: alertPayload,
        },
        outbox: [{ provider: "websocket" }],
      });
    } catch (writeError) {
      if (writeError === notRunning) {
        ignore(notRunning.state);
        return;
      }
      throw writeError;
    }
    console.error(`[owl-core] workflow driver halted for Work ${workId} after tick failure`, error);
    await this.announceCoreDecisions(workId);
    await this.dispatcher.replayPending();
  }

  /** Turns low first-review pass rates into rule proposals; the Owner approves them. A failure only logs. */
  private async proposeRulesFromMetrics(workId: string): Promise<void> {
    try {
      const settings = learningMetrics(this.db);
      const candidates = metricsRuleCandidates(this.db, settings);
      if (candidates.length === 0) return;
      const work = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId);
      await proposeFromMetrics(this.ruleProposals, candidates, {
        project_id: work?.project_id ?? null,
        language: ownerLanguage(this.db),
        max_ids: settings.rationale_max_ids,
      });
    } catch (error) {
      // Why not stop: only the rule proposal is lost; the Work result is unaffected, so a logged warning is enough.
      console.warn(`[owl-core] Could not propose rules from metrics for Work ${workId}`, error);
    }
  }

  private async enqueueWorkLearnings(workId: string, agentRunId: string | null, verdict: FinalManagerVerdict): Promise<void> {
    const lessons = verdict.lessons.map(normalizeLesson);
    if (lessons.length === 0) return;
    const work = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId);
    await this.learningJobs.enqueue(workId, agentRunId, work?.project_id ?? null, lessons);
    this.scheduleLearningRun(`Work ${workId}`);
  }

  /**
   * Run the Project verification plan on the Work branch after every Task was
   * merged into it. A pass (or nothing to run) lets the Final Manager go ahead;
   * a failure never does: the Manager gets a replan first, and once
   * max_manager_repairs replans did not fix it the Owner is asked.
   */
  private async runWorkIntegrationVerification(
    workId: string,
  ): Promise<{ readonly kind: "proceed"; readonly verification: WorkBranchVerification } | { readonly kind: "routed" }> {
    const settings = workVerification(this.db);
    const skipped = (reason: "disabled" | "no_project"): { readonly kind: "proceed"; readonly verification: WorkBranchVerification } =>
      ({ kind: "proceed", verification: { status: "not_applicable", reason, work_commit: null, commands: [], failed_command_id: null, message: null } });
    if (!settings.enabled) return skipped("disabled");
    const hasProject = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId)?.project_id != null;
    if (this.git.verifyWorkBranch === undefined && !hasProject) return skipped("no_project");
    const sequence = (this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'work.integration_verification_completed'",
      workId,
    )?.n ?? 0) + 1;
    const startedAt = Date.now();
    // A Work with a Project must never skip the check just because the gateway cannot run it.
    const verification: WorkBranchVerification = this.git.verifyWorkBranch
      ? await this.git.verifyWorkBranch({ work_id: workId })
      : { status: "error", reason: "prepare_failed", work_commit: null, commands: [], failed_command_id: null, message: "The Git gateway cannot verify the Work branch." };
    if (!this.started) return { kind: "routed" };
    // Core's own test run goes after the Project's commands pass: a failing command is fixed first.
    const commandsFailing = verification.status === "failed" || verification.status === "error";
    const coreTests = commandsFailing ? null : await this.workflow.runWorkCoreTests(workId);
    if (!this.started) return { kind: "routed" };
    const coreFailed = coreTests !== null && (coreTests.outcome.status === "failed" || coreTests.outcome.status === "error");
    const failing = commandsFailing || coreFailed;
    let routedTo: "final_manager" | "manager" | "owner" = "final_manager";
    if (failing) {
      const repairs = this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM events
          WHERE work_id = ? AND type = 'work.integration_verification_completed'
            AND json_extract(payload_json, '$.routed_to') = 'manager'
            AND sequence > COALESCE((SELECT MAX(sequence) FROM events WHERE work_id = ? AND type = 'decision.resolved'), 0)`,
        workId,
        workId,
      )?.n ?? 0;
      routedTo = repairs < settings.max_manager_repairs ? "manager" : "owner";
    }
    const detail: JsonObject = {
      work_commit: verification.work_commit,
      status: verification.status,
      reason: verification.reason,
      commands: verification.commands.map((command) => ({
        command_id: command.command_id,
        argv: [...command.argv],
        passed: command.passed,
        exit_code: command.exit_code,
        timed_out: command.timed_out,
        duration_ms: command.duration_ms,
        stdout_tail: command.stdout_tail,
        stderr_tail: command.stderr_tail,
      })),
      failed_command_id: verification.failed_command_id,
      message: coreFailed && coreTests !== null
        ? coreTests.outcome.status === "error"
          ? coreTests.outcome.error
          : `Core test run failed: ${coreTests.outcome.in_scope.length} test(s) in ${coreTests.outcome.failed_files.length} file(s)`
        : verification.message,
      // Names and message summaries only; the raw output stays in test_run_files.
      ...(coreTests !== null ? { core_tests: coreTestRunBrief(coreTests.outcome, coreTests.settings) as unknown as JsonObject } : {}),
    };
    const completed: JsonObject = { work_id: workId, ...detail, duration_ms: Date.now() - startedAt, routed_to: routedTo };
    await this.writeLane.write({
      mutateState: () => undefined,
      event: {
        id: createUlid(),
        idempotencyKey: `work-integration-verification:${workId}:${verification.work_commit ?? "none"}:${sequence}`,
        type: "work.integration_verification_completed",
        workId,
        payload: completed,
      },
      outbox: [{ provider: "websocket" }],
    });
    if (routedTo === "final_manager") return { kind: "proceed", verification };
    if (routedTo === "manager") {
      await this.triggerManagerReplan(
        workId,
        [],
        { kind: "work_verification_failed", core_tests_failed: coreFailed },
        [],
        null,
        null,
        detail,
      );
      if (this.started) await this.dispatcher.replayPending();
      return { kind: "routed" };
    }
    await this.recordWorkIntegrationVerificationFailed(workId, detail);
    return { kind: "routed" };
  }

  /** The integrated Work branch kept failing the Project verification: halt at judgement_waiting for the Owner. */
  private async recordWorkIntegrationVerificationFailed(workId: string, detail: JsonObject): Promise<void> {
    const english = ownerLanguage(this.db) === "en";
    const failed = Array.isArray(detail.commands)
      ? (detail.commands as JsonObject[]).find((command) => command.command_id === detail.failed_command_id)
      : undefined;
    const tail = failed ? [failed.stdout_tail, failed.stderr_tail].filter((part) => typeof part === "string" && part.length > 0).join("\n").slice(-4_000) : "";
    const alertPayload: JsonObject = {
      kind: WORK_INTEGRATION_ALERT_KIND,
      safe_reconcile_failed: true,
      driver_stopped: true,
      message: english
        ? `The Work branch failed the Project verification after every Task was merged: ${String(detail.message ?? detail.failed_command_id ?? "")}`
        : `全タスクを統合したWorkブランチがProjectの検証に失敗しました: ${String(detail.message ?? detail.failed_command_id ?? "")}`,
      remediation: english
        ? "Let the Manager add Tasks that fix the failing check, or cancel the Work."
        : "Managerに失敗した検査を直すタスクを追加させるか、Workを中止してください。",
      failed_command_id: typeof detail.failed_command_id === "string" ? detail.failed_command_id : null,
      command: failed && Array.isArray(failed.argv) ? failed.argv : [],
      output_tail: tail,
      work_verification: detail,
    };
    await this.writeLane.write({
      mutateState: (transaction) => {
        const work = transaction.get<Pick<WorkDbRow, "state" | "state_version">>("SELECT state, state_version FROM works WHERE id = ?", workId);
        if (!work) throw notFound("work", workId);
        if (work.state === "running") {
          reduceWorkInTransaction(transaction, workId, { event: "system.alert", expected_version: work.state_version, payload: alertPayload });
        }
        return { work_id: workId, state: work.state };
      },
      event: {
        id: createUlid(),
        idempotencyKey: `work-integration-verification-failed:${workId}:${createUlid()}`,
        type: "system.alert",
        workId,
        payload: alertPayload,
      },
      outbox: [{ provider: "websocket" }],
    });
    await this.announceCoreDecisions(workId);
    await this.dispatcher.replayPending();
  }

  /** The Final Manager judged the Work incomplete: halt the driver at judgement_waiting for owner review. */
  private async recordFinalManagerIncomplete(workId: string, verdict: FinalManagerVerdict): Promise<void> {
    console.error(`[owl-core] final Manager verdict is incomplete for Work ${workId}`, verdict);
    if (await this.tryAutoContinueIncompleteFinal(workId, verdict)) return;
    const english = ownerLanguage(this.db) === "en";
    const alertPayload: JsonObject = {
      kind: "final_manager_incomplete",
      // system.alert is the durable owner-review transition. An incomplete
      // final verdict is a safe, explicit halt, but it still needs that
      // transition rather than leaving the Work running with no driver.
      safe_reconcile_failed: true,
      driver_stopped: true,
      message: english
        ? `The final check judged the Work incomplete: ${verdict.summary}`
        : `最終チェックで未完了と判定されました: ${verdict.summary}`,
      remediation: english
        ? "Review what is missing, plan the additional Tasks, then resume the Work."
        : "足りない点を確認し、必要な追加タスクを計画してからWorkを再開してください。",
      summary: verdict.summary,
      missing: verdict.missing as unknown as JsonObject[],
      lessons: verdict.lessons as unknown as JsonObject[],
    };
    await this.writeLane.write({
      mutateState: (transaction) => {
        const work = transaction.get<Pick<WorkDbRow, "state" | "state_version">>(
          "SELECT state, state_version FROM works WHERE id = ?",
          workId,
        );
        if (!work) {
          throw notFound("work", workId);
        }
        if (work.state === "running") {
          reduceWorkInTransaction(transaction, workId, {
            event: "system.alert",
            expected_version: work.state_version,
            payload: alertPayload,
          });
        }
        return { work_id: workId, state: work.state };
      },
      event: {
        id: createUlid(),
        idempotencyKey: `final-manager-incomplete:${workId}:${createUlid()}`,
        type: "system.alert",
        workId,
        payload: alertPayload,
      },
      outbox: [{ provider: "websocket" }],
    });
    await this.announceCoreDecisions(workId);
    await this.dispatcher.replayPending();
  }

  /**
   * An incomplete final verdict whose every missing item names a fix goes to
   * the Manager without asking the Owner: the same Owner replan a Decision
   * answer queues, carrying the verdict as final_verdict. At most
   * finalAutoContinueLimit rounds per Work, counted from the alerts recorded
   * here. Returns true when the replan was queued.
   */
  private async tryAutoContinueIncompleteFinal(workId: string, verdict: FinalManagerVerdict): Promise<boolean> {
    if (verdict.missing.length === 0 || verdict.missing.some((item) => typeof item.fix !== "string" || item.fix.trim().length === 0)) return false;
    const limit = finalAutoContinueLimit(this.db);
    const countRounds = (reader: SettingsReader): number =>
      Number(reader.get<{ total: number }>(
        `SELECT COUNT(*) AS total FROM events
          WHERE work_id = ? AND type = 'system.alert'
            AND json_extract(payload_json, '$.kind') = 'final_manager_incomplete' AND json_extract(payload_json, '$.auto_continue') = 1`,
        workId,
      )?.total ?? 0);
    const rounds = countRounds(this.db);
    if (rounds >= limit) return false;
    const round = rounds + 1;
    const english = ownerLanguage(this.db) === "en";
    const payload: JsonObject = {
      kind: "final_manager_incomplete",
      auto_continue: 1,
      round,
      max_rounds: limit,
      message: english
        ? `The final check judged the Work incomplete: ${verdict.summary} The Manager is adding Tasks automatically (round ${round} of ${limit}).`
        : `最終チェックで未完了と判定されました: ${verdict.summary} Managerが追加タスクを自動で計画します(${round}/${limit}回目)。`,
      summary: verdict.summary,
      missing: verdict.missing as unknown as JsonObject[],
      lessons: verdict.lessons as unknown as JsonObject[],
    };
    const skipped = new Error("auto continue skipped");
    try {
      await this.writeLane.write({
        mutateState: (transaction) => {
          const work = transaction.get<Pick<WorkDbRow, "state">>("SELECT state FROM works WHERE id = ?", workId);
          const openDecision = transaction.get<{ id: string }>("SELECT id FROM decisions WHERE work_id = ? AND status = 'open' LIMIT 1", workId);
          const pendingReplan = transaction.get<{ key: string }>(
            "SELECT key FROM idempotency_keys WHERE key = ? AND json_extract(response_json, '$.status') = 'queued'",
            ownerReplanKey(workId),
          );
          if (work?.state !== "running" || openDecision || pendingReplan || countRounds(transaction) !== round) throw skipped;
          mergeOwnerReplanInTransaction(transaction, workId, { kind: "auto_final", answer: "Add the Tasks the final check's missing items need." });
          return null;
        },
        event: {
          id: createUlid(),
          idempotencyKey: `final-manager-auto-continue:${workId}:${round}`,
          type: "system.alert",
          workId,
          payload,
        },
        outbox: [{ provider: "websocket" }],
      });
    } catch (error) {
      if (error === skipped) return true;
      if (isRecord(error) && error.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
      console.error(`[owl-core] automatic continuation after an incomplete final check failed for Work ${workId}`, error);
      return false;
    }
    this.workDriver.register(workId);
    await this.dispatcher.replayPending();
    return true;
  }

  /** The final check itself failed (no usable answer): halt at judgement_waiting and offer to run it again. */
  private async recordFinalManagerFailed(workId: string, error: unknown): Promise<void> {
    console.error(`[owl-core] final Manager check failed for Work ${workId}`, error);
    const english = ownerLanguage(this.db) === "en";
    const cause = error instanceof Error && error.message.length > 0 ? error.message : String(error);
    const alertPayload: JsonObject = {
      kind: "final_manager_failed",
      safe_reconcile_failed: true,
      driver_stopped: true,
      message: english
        ? `The final check could not be completed: ${cause}`
        : `最終チェックを完了できませんでした: ${cause}`,
      remediation: english
        ? "Retry to run the final check again, or cancel."
        : "もう一度最終チェックを実行するか、Workを中止してください。",
      failure: cause,
      ...sideEffectFailureFields(isRecord(error) && isRecord(error.details) ? error.details.error_key : null),
    };
    await this.writeLane.write({
      mutateState: (transaction) => {
        const work = transaction.get<Pick<WorkDbRow, "state" | "state_version">>(
          "SELECT state, state_version FROM works WHERE id = ?",
          workId,
        );
        if (!work) {
          throw notFound("work", workId);
        }
        if (work.state === "running") {
          reduceWorkInTransaction(transaction, workId, {
            event: "system.alert",
            expected_version: work.state_version,
            payload: alertPayload,
          });
        }
        return { work_id: workId, state: work.state };
      },
      event: {
        id: createUlid(),
        idempotencyKey: `final-manager-failed:${workId}:${createUlid()}`,
        type: "system.alert",
        workId,
        payload: alertPayload,
      },
      outbox: [{ provider: "websocket" }],
    });
    await this.announceCoreDecisions(workId);
    await this.dispatcher.replayPending();
  }

  /**
   * A Work merge that conflicted is first handed to the Manager without
   * asking the Owner: the same Owner replan the `resolve_conflict` answer
   * queues, so the next tick adds the conflict-resolution Task. Only
   * MAX_AUTO_CONFLICT_RESOLUTIONS rounds run per Work, counted from the
   * alerts recorded here. `handled` means nothing more is to be recorded
   * (the replan was queued, or the Work is no longer in a state to act on).
   * Otherwise the caller opens the usual Decision, carrying `attempts`.
   */
  private async tryAutoResolveMergeConflict(
    workId: string,
    merge: Extract<GitWorkMergeResult, { readonly kind: "conflict" }>,
  ): Promise<{ readonly handled: true } | { readonly handled: false; readonly attempts: number }> {
    // The limit counts rounds since the Work was last reopened; the total over
    // the Work's life keeps each round's idempotency key unique.
    const countRounds = (reader: { get<T extends object>(sql: string, ...parameters: (string | number)[]): T | undefined }): { current: number; total: number } => {
      const row = reader.get<{ current: number; total: number }>(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(sequence > COALESCE((SELECT MAX(sequence) FROM events WHERE work_id = ? AND type = 'work.reopened'), 0)), 0) AS current
           FROM events
          WHERE work_id = ? AND type = 'system.alert' AND json_extract(payload_json, '$.kind') = ?`,
        workId,
        workId,
        AUTO_CONFLICT_ALERT_KIND,
      );
      return { current: Number(row?.current ?? 0), total: Number(row?.total ?? 0) };
    };
    const before = countRounds(this.db);
    const rounds = before.current;
    if (rounds >= MAX_AUTO_CONFLICT_RESOLUTIONS) return { handled: false, attempts: rounds };
    const round = rounds + 1;
    const lifeRound = before.total + 1;
    const english = ownerLanguage(this.db) === "en";
    const files = [...merge.conflicting_files];
    const listed = files.length > 0 ? files.join(", ") : english ? "not recorded" : "記録なし";
    const payload: JsonObject = {
      kind: AUTO_CONFLICT_ALERT_KIND,
      merge_kind: "conflict",
      round,
      max_rounds: MAX_AUTO_CONFLICT_RESOLUTIONS,
      conflicting_files: files,
      message: english
        ? `Merging the Work into the Project base branch conflicted. The Manager is resolving it automatically (round ${round} of ${MAX_AUTO_CONFLICT_RESOLUTIONS}). Conflicting files: ${listed}`
        : `Workのベースブランチへの統合でコンフリクトが発生しました。Managerが自動で解消します(${round}/${MAX_AUTO_CONFLICT_RESOLUTIONS}回目)。コンフリクトしたファイル: ${listed}`,
    };
    if (merge.base_branch !== null) payload.base_branch = merge.base_branch;
    const skipped = new Error("auto conflict resolution skipped");
    try {
      await this.writeLane.write({
        mutateState: (transaction) => {
          const work = transaction.get<Pick<WorkDbRow, "state">>("SELECT state FROM works WHERE id = ?", workId);
          const openDecision = transaction.get<{ id: string }>(
            "SELECT id FROM decisions WHERE work_id = ? AND status = 'open' LIMIT 1",
            workId,
          );
          const pendingReplan = transaction.get<{ key: string }>(
            "SELECT key FROM idempotency_keys WHERE key = ? AND json_extract(response_json, '$.status') = 'queued'",
            ownerReplanKey(workId),
          );
          // The alert row is inserted before this callback, so it counts as `round`.
          // Paused, cancelled, awaiting an Owner answer, or already being
          // resolved by an earlier trigger for this same failure: do nothing.
          if (work?.state !== "running" || openDecision || pendingReplan || countRounds(transaction).total !== lifeRound) throw skipped;
          mergeOwnerReplanInTransaction(transaction, workId, { kind: "auto_conflict", answer: "Resolve the merge conflict automatically." });
          return null;
        },
        event: {
          id: createUlid(),
          idempotencyKey: `work-merge-auto-resolve:${workId}:${lifeRound}`,
          type: "system.alert",
          workId,
          payload,
        },
        outbox: [{ provider: "websocket" }],
      });
    } catch (error) {
      if (error === skipped) return { handled: true };
      // A concurrent trigger for the same round already recorded it.
      if (isRecord(error) && error.code === "SQLITE_CONSTRAINT_UNIQUE") return { handled: true };
      console.error(`[owl-core] automatic merge conflict resolution failed for Work ${workId}`, error);
      return { handled: false, attempts: rounds };
    }
    this.workDriver.register(workId);
    await this.dispatcher.replayPending();
    return { handled: true };
  }

  /** A Project merge must succeed before a complete final verdict can complete its Work. */
  private async recordWorkMergeFailed(
    workId: string,
    merge: Exclude<GitWorkMergeResult, { readonly kind: "merged" }> | null,
    thrown?: unknown,
    autoResolveAttempts = 0,
  ): Promise<void> {
    const english = ownerLanguage(this.db) === "en";
    const mergeKind = merge?.kind ?? "error";
    const cause = merge?.message ?? (thrown instanceof Error && thrown.message.length > 0 ? thrown.message : String(thrown));
    const alertPayload: JsonObject = {
      kind: "work_merge_failed",
      merge_kind: mergeKind,
      merge_message: cause,
      safe_reconcile_failed: true,
      driver_stopped: true,
      message: english
        ? `Work changes could not be merged into the Project base branch: ${cause}`
        : `Workの変更をProjectのベースブランチに統合できませんでした: ${cause}`,
      remediation: english
        ? "Resolve the reported merge or verification issue, then retry, or cancel the Work."
        : "報告されたマージまたは検証の問題を解決して再試行するか、Workを中止してください。",
    };
    if (merge !== null && merge.base_branch !== null) alertPayload.base_branch = merge.base_branch;
    if (merge?.kind === "error" && merge.dirty_files && merge.dirty_files.length > 0) {
      alertPayload.dirty_files = [...merge.dirty_files];
      if (merge.worktree_path) alertPayload.integration_worktree = merge.worktree_path;
    }
    if (merge?.kind === "conflict") {
      alertPayload.conflicting_files = [...merge.conflicting_files];
      if (autoResolveAttempts > 0) alertPayload.auto_resolve_attempts = autoResolveAttempts;
    }
    if (merge?.kind === "verification_failed") {
      alertPayload.command_id = merge.command_id;
      alertPayload.command = [...merge.command];
      alertPayload.output_tail = merge.output_tail;
    }
    if (merge?.kind === "base_moved") {
      alertPayload.expected_base_commit = merge.expected_base_commit;
      alertPayload.actual_base_commit = merge.actual_base_commit;
    }

    await this.writeLane.write({
      mutateState: (transaction) => {
        const work = transaction.get<Pick<WorkDbRow, "state" | "state_version">>(
          "SELECT state, state_version FROM works WHERE id = ?",
          workId,
        );
        if (!work) throw notFound("work", workId);
        if (work.state === "running") {
          reduceWorkInTransaction(transaction, workId, {
            event: "system.alert",
            expected_version: work.state_version,
            payload: alertPayload,
          });
        }
        return { work_id: workId, state: work.state };
      },
      event: {
        id: createUlid(),
        idempotencyKey: `work-merge-failed:${workId}:${createUlid()}`,
        type: "system.alert",
        workId,
        payload: alertPayload,
      },
      outbox: [{ provider: "websocket" }],
    });
    await this.announceCoreDecisions(workId);
    await this.dispatcher.replayPending();
  }

  /** Effective command from the DB at call time: stored value, else the owlRoot default (NULL only), else none. */
  private resolvePostMergeCommand(projectId: string): ResolvedPostMergeCommand | null {
    const row = this.db.get<{ canonical_path: string; post_merge_argv_json: string | null; post_merge_install_argv_json: string | null }>(
      "SELECT canonical_path, post_merge_argv_json, post_merge_install_argv_json FROM projects WHERE id = ?", projectId,
    );
    if (!row) return null;
    const stored = row.post_merge_argv_json === null ? null : parseStringArray(row.post_merge_argv_json, "post_merge_command", projectId, "Project");
    const isDefault = stored === null && realPathOrResolve(row.canonical_path) === realPathOrResolve(this.owlRoot);
    const argv = stored ?? (isDefault ? this.postMergeOwlRootDefault : []);
    const installStored = row.post_merge_install_argv_json === null ? null : parseStringArray(row.post_merge_install_argv_json, "post_merge_install_command", projectId, "Project");
    return argv.length === 0 ? null : {
      argv, cwd: row.canonical_path, default_command: isDefault,
      install_argv: installStored ?? this.postMergeInstallDefault, dependency_files: this.postMergeDependencyFiles,
    };
  }

  private schedulePostMergeCommand(workId: string, projectId: string, mergeRecord: JsonObject): void {
    try {
      const base = mergeRecord.base_branch;
      const commit = mergeRecord.new_base_commit;
      if (!this.started || typeof base !== "string" || typeof commit !== "string") return;
      const command = this.resolvePostMergeCommand(projectId);
      if (command === null) return;
      const merge = { base_branch: base, old_base_commit: typeof mergeRecord.old_base_commit === "string" ? mergeRecord.old_base_commit : null, new_base_commit: commit, merge_commit: typeof mergeRecord.merge_commit === "string" ? mergeRecord.merge_commit : null };
      console.info(`[owl-core] Post-merge command for Work ${workId} queued: ${redactArgv(command.argv).join(" ")}`);
      void this.recordPostMergeQueued(workId, projectId, command, merge)
        .finally(() => this.postMergeCommands.enqueue({ project_id: projectId, work_id: workId, merge }));
    } catch (error) {
      console.warn(`[owl-core] Could not queue the post-merge command for Work ${workId}`, error);
    }
  }

  private async recordPostMergeQueued(workId: string, projectId: string, command: ResolvedPostMergeCommand, merge: { base_branch: string; old_base_commit: string | null; new_base_commit: string; merge_commit: string | null }): Promise<void> {
    try {
      const idempotencyKey = `work-post-merge-queued:${projectId}:${merge.new_base_commit}`;
      if (this.db.get("SELECT id FROM events WHERE idempotency_key = ?", idempotencyKey)) return;
      await this.writeLane.write({
        mutateState: () => null,
        event: {
          id: createUlid(), idempotencyKey, type: "work.post_merge_command_queued", workId,
          payload: { work_id: workId, project_id: projectId, argv: redactArgv(command.argv), cwd: command.cwd, default_command: command.default_command, ...merge },
        },
        outbox: [{ provider: "websocket" }],
      });
    } catch (error) {
      console.warn(`[owl-core] Could not record the queued post-merge command for Work ${workId}`, error);
    }
  }

  private async recordPostMergeOutcome(outcome: PostMergeRunOutcome): Promise<void> {
    const workId = outcome.job.work_id;
    try {
      const { type, idempotencyKey, payload } = postMergeResultEvent(outcome, ownerLanguage(this.db));
      const stderrTail = String(payload.stderr_tail ?? "").trim();
      const stdoutTail = String(payload.stdout_tail ?? "").trim();
      const tail = [stderrTail && `stderr:\n${stderrTail}`, stdoutTail && `stdout:\n${stdoutTail}`].filter(Boolean).join("\n");
      console.info(type === "system.alert"
        ? `[owl-core] Post-merge command for Work ${workId} failed. stage=${String(payload.stage)} exit_code=${String(payload.exit_code)} timed_out=${String(payload.timed_out)}${tail ? `\n${tail}` : ""}`
        : `[owl-core] Post-merge command for Work ${workId} succeeded.`);
      if (!this.started || this.db.get("SELECT id FROM events WHERE idempotency_key = ?", idempotencyKey)) return;
      await this.writeLane.write({
        mutateState: () => null,
        event: { id: createUlid(), idempotencyKey, type, workId, payload: payload as JsonObject },
        outbox: [{ provider: "websocket" }],
      });
    } catch (error) {
      console.warn(`[owl-core] Could not record the post-merge command result for Work ${workId}`, error);
    }
  }

  /** Re-queues the newest queued merge per project that has no recorded result (stopped while waiting or running). */
  private recoverPostMergeCommands(): void {
    const seen = new Set<string>();
    for (const row of this.db.all<{ work_id: string; payload_json: string }>(
      "SELECT work_id, payload_json FROM events WHERE type = 'work.post_merge_command_queued' ORDER BY sequence DESC LIMIT 500",
    )) {
      try {
        const p = JSON.parse(row.payload_json) as { project_id: string; base_branch: string; old_base_commit?: string | null; new_base_commit: string; merge_commit: string | null };
        if (seen.has(p.project_id)) continue;
        seen.add(p.project_id);
        const done = this.db.get(
          "SELECT id FROM events WHERE idempotency_key IN (?, ?)",
          `work-post-merge-succeeded:${p.project_id}:${p.new_base_commit}`, `work-post-merge-failed:${p.project_id}:${p.new_base_commit}`,
        );
        if (!done) this.postMergeCommands.enqueue({ project_id: p.project_id, work_id: row.work_id, merge: { base_branch: p.base_branch, old_base_commit: p.old_base_commit ?? null, new_base_commit: p.new_base_commit, merge_commit: p.merge_commit } });
      } catch (error) {
        console.warn("[owl-core] Could not recover a queued post-merge command", error);
      }
    }
  }

  private async pushCompletedWork(workId: string, projectId: string): Promise<void> {
    const pushBaseBranch = this.git.pushBaseBranch;
    if (!pushBaseBranch || !this.started) return;
    try {
      const project = this.db.get<{ auto_push: number; base_branch: string }>("SELECT auto_push, base_branch FROM projects WHERE id = ?", projectId);
      if (!project || project.auto_push !== 1) return;
      let result: GitPushResult;
      try {
        result = await pushBaseBranch.call(this.git, { work_id: workId });
      } catch (error) {
        const detail = redactCredentials(error instanceof Error ? error.message : String(error)).slice(-2_000);
        let baseCommit: string | null = null;
        const completed = this.db.get<{ payload_json: string }>(
          "SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.completed' ORDER BY sequence DESC LIMIT 1",
          workId,
        );
        try {
          const payload = completed ? JSON.parse(completed.payload_json) as { merge?: { new_base_commit?: string; merge_commit?: string | null } } : null;
          baseCommit = payload?.merge?.new_base_commit ?? payload?.merge?.merge_commit ?? null;
        } catch { /* The alert can still be recorded without the merge commit. */ }
        result = {
          ok: false, exit_code: 1, recorded: false, kind: "failed", failure: "unknown", hook_side: null,
          remote: null, base_branch: project.base_branch, remote_ref: null, base_commit: baseCommit,
          stderr_tail: detail, message: "Git push operation threw an exception.",
        };
      }

      if (result.kind === "skipped_disabled") {
        console.info(`[owl-core] Auto push for Work ${workId} was skipped: automatic push is disabled.`);
        return;
      }
      console.warn(`[owl-core] Auto push for Work ${workId} ${result.kind === "failed" ? `failed (${result.failure})` : result.kind}.`);

      if (result.kind === "pushed") {
        try {
          const idempotencyKey = `work-pushed:${workId}:${result.new_remote_commit}`;
          if (this.db.get("SELECT id FROM events WHERE idempotency_key = ?", idempotencyKey)) return;
          await this.writeLane.write({
            mutateState: () => null,
            event: {
              id: createUlid(), idempotencyKey, type: "work.pushed", workId,
              payload: {
                work_id: workId, project_id: projectId, remote: result.remote, base_branch: result.base_branch,
                remote_branch: result.remote_ref.slice("refs/heads/".length), remote_ref: result.remote_ref,
                previous_tracking_commit: result.previous_tracking_commit, new_remote_commit: result.new_remote_commit,
                up_to_date: result.up_to_date, hook_warnings: [...result.hook_warnings],
              },
            },
            outbox: [{ provider: "websocket" }],
          });
        } catch (error) {
          console.warn(`[owl-core] Could not record auto-push success for Work ${workId}`, error);
        }
        return;
      }

      const kind = result.kind === "skipped_no_upstream"
        ? "work_push_skipped_no_upstream"
        : result.failure === "hook_rejected"
          ? "work_push_blocked_by_hook"
          : "work_push_failed";
      const failure = result.kind === "failed" ? result.failure : null;
      const hookSide = result.kind === "failed" && result.failure === "hook_rejected" ? result.hook_side ?? "local" : null;
      const baseBranch = result.kind === "skipped_no_upstream" ? result.base_branch : result.base_branch ?? project.base_branch;
      const remote = result.kind === "failed" ? result.remote : null;
      const remoteRef = result.kind === "failed" ? result.remote_ref : null;
      const baseCommit = result.base_commit;
      const stderrTail = result.kind === "failed" ? result.stderr_tail : "";
      const detail = {
        base_branch: baseBranch,
        remote,
        remote_branch: remoteRef?.startsWith("refs/heads/") ? remoteRef.slice("refs/heads/".length) : null,
        push_failure: failure,
        hook_side: hookSide,
      };
      const text = pushAlertText(ownerLanguage(this.db), kind, detail);
      const resultMessage = redactCredentials(result.message);
      const stderrMessage = stderrTail ? redactCredentials(stderrTail).slice(-500) : "";
      const message = [text.message, resultMessage, stderrMessage].filter(Boolean).join("\n\n");
      const idempotencyKey = `work-push-alert:${workId}:${baseCommit ?? "no-base-commit"}:${kind}:${failure ?? hookSide ?? "-"}`;
      try {
        if (this.db.get("SELECT id FROM events WHERE idempotency_key = ?", idempotencyKey)) return;
        await this.writeLane.write({
          mutateState: () => null,
          event: {
            id: createUlid(), idempotencyKey, type: "system.alert", workId,
            payload: {
              kind, message, remediation: text.remediation, base_branch: baseBranch, remote,
              remote_branch: detail.remote_branch,
              ...(failure && failure !== "hook_rejected" ? { push_failure: failure } : {}),
              ...(hookSide ? { hook_side: hookSide } : {}),
              ...(result.kind === "failed" ? { stderr_tail: redactCredentials(result.stderr_tail) } : {}),
            },
          },
          outbox: [{ provider: "websocket" }],
        });
      } catch (error) {
        console.warn(`[owl-core] Could not record auto-push alert for Work ${workId}`, error);
      }
    } catch (error) {
      console.warn(`[owl-core] Could not process auto push for Work ${workId}`, error);
    }
  }

  /** Branch cleanup happens after reconciliation removes all worktrees; it cannot undo completion. */
  private async deleteMergedWorkBranches(workId: string, skippedReason?: string): Promise<void> {
    try {
      if (skippedReason !== undefined) throw new Error(skippedReason);
      const result = await this.git.deleteMergedWorkBranches({ work_id: workId });
      if (!result.ok) throw new Error(result.message);
      if (Object.keys(result.deleted_branches).length === 0) return;
      await this.writeLane.write({
        mutateState: () => null,
        event: {
          id: createUlid(),
          idempotencyKey: `work-branches-deleted:${workId}`,
          type: "work.branches_deleted",
          workId,
          payload: { work_id: workId, deleted_branches: { ...result.deleted_branches } },
        },
        outbox: [{ provider: "websocket" }],
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      const message = skippedReason === undefined
        ? `Could not delete branch owl/work/${workId}/work after merge: ${cause}`
        : skippedReason;
      console.warn(`[owl-core] Could not delete merged branches for Work ${workId}: ${cause}`);
      try {
        const idempotencyKey = `work-merge-branch-cleanup-failed:${workId}`;
        if (this.db.get("SELECT id FROM events WHERE idempotency_key = ?", idempotencyKey)) return;
        await this.writeLane.write({
          mutateState: () => null,
          event: {
            id: createUlid(),
            idempotencyKey,
            type: "system.alert",
            workId,
            payload: { kind: "work_merge_branch_cleanup_failed", message },
          },
          outbox: [{ provider: "websocket" }],
        });
      } catch (recordError) {
        console.warn(`[owl-core] Could not record branch cleanup failure for Work ${workId}`, recordError);
      }
    }
  }

  private async runInitialManagerPlan(workId: string, mode: StartWorkPayload["mode"]): Promise<void> {
    if (!this.started) return;
    const work = this.managerWorkContext(workId);
    // A plan that breaks a rule the schema cannot express (duplicate ids,
    // unknown dependencies, cycles) is rejected before any write and handed
    // back to the Manager once with the reasons; a second bad plan escalates
    // to the Owner through recordTickFailure with those reasons.
    // Quality repairs are counted apart from structural rejections: each one
    // buys one more attempt.
    let feedback: PreviousOutputFeedback | null = null;
    let qualityRepairs = 0;
    const quality = planQualitySettings(this.db);
    for (let planAttempt = 1; planAttempt <= PLAN_MAX_ATTEMPTS + qualityRepairs; planAttempt += 1) {
      const invoked = await this.invokeInitialManagerPlan(workId, mode, work, feedback);
      if (invoked === null || !this.started) return;
      const { result, runId } = invoked;
      if (result.failure_class === "rate_limited") return;
      const report = requireManagerReport(result, "manager plan");
      const items = managerTasksToPlanItems(report.tasks, workId, { allowEmpty: false });
      const managerEvent = report.event;
      if (managerEvent !== "work.planned" && managerEvent !== "task.replanned") {
        throw validationError("The Manager plan must return work.planned or task.replanned.", { work_id: workId, event: managerEvent });
      }
      const plan = validatePlan(items);
      if (isPlanRejection(plan)) {
        feedback = { kind: "plan_rejected", errors: plan.errors, warnings: [] };
        if (planAttempt < PLAN_MAX_ATTEMPTS + qualityRepairs) {
          console.warn(`[owl-core] Manager plan for Work ${workId} was rejected (${plan.errors.join("; ")}); asking for a corrected plan.`);
          continue;
        }
        throw validationError(`The Manager plan was rejected twice: ${plan.errors.join(" ")}`, { work_id: workId });
      }
      const found = quality.enabled ? evaluatePlanQuality(items, quality) : [];
      // Missing fields are a format error: the Manager fixes the fields only, without redoing the plan or using a quality repair.
      const formatWarnings = found.filter((warning) => warning.code === "criterion_field_missing");
      if (formatWarnings.length > 0) {
        feedback = { kind: "fields_missing", errors: [], warnings: formatWarnings };
        if (planAttempt < PLAN_MAX_ATTEMPTS + qualityRepairs) continue;
        throw validationError(`The Manager plan kept missing fields.\n${formatPlanQualityReason(formatWarnings)}`, { work_id: workId, codes: ["criterion_field_missing"] });
      }
      const warnings = found;
      if (warnings.length > 0) {
        const outcome = planQualityOutcome(warnings, qualityRepairs, quality);
        await this.recordPlanQualityWarned(workId, "plan", planAttempt, runId, warnings, outcome);
        if (outcome === "rejected") {
          const blocking = warnings.filter((warning) => quality.blocking_codes.includes(warning.code));
          feedback = { kind: "quality_rejected", errors: [], warnings: blocking };
          if (planAttempt < PLAN_MAX_ATTEMPTS + qualityRepairs) continue;
          throw validationError(`The Manager plan was rejected by blocking plan quality checks (${blocking.map((warning) => warning.code).join(", ")}).\n${formatPlanQualityReason(blocking)}`, { work_id: workId, codes: blocking.map((warning) => warning.code) });
        }
        if (outcome === "repair_requested") {
          qualityRepairs += 1;
          feedback = { kind: "quality_repair", errors: [], warnings };
          continue;
        }
      }
      await this.workflow.registerPlan(workId, items, managerEvent);
      if (this.started) await this.dispatcher.replayPending();
      return;
    }
  }

  /** Records the plan quality warnings of one Manager answer; the plan itself is never rejected for them. */
  private async recordPlanQualityWarned(
    workId: string,
    phase: "plan" | "replan",
    attempt: number,
    managerAgentRunId: string,
    warnings: readonly PlanQualityWarning[],
    outcome: PlanQualityOutcome,
  ): Promise<void> {
    await this.writeLane.write({
      mutateState: () => undefined,
      event: {
        idempotencyKey: `plan-quality:${workId}:${managerAgentRunId}`,
        type: "work.plan_quality_warned",
        workId,
        payload: { work_id: workId, phase, attempt, manager_agent_run_id: managerAgentRunId, warnings: warnings.map((warning) => ({ ...warning })), outcome },
      },
      outbox: [{ provider: "websocket" }],
    });
  }

  /**
   * One initial-plan request, with a bounded retry for transient provider
   * errors and retryable invalid output. Returns null when Core stopped.
   */
  private async invokeInitialManagerPlan(
    workId: string,
    mode: StartWorkPayload["mode"],
    work: JsonObject,
    feedback: PreviousOutputFeedback | null,
  ): Promise<{ result: AgentRunResult; runId: string } | null> {
    let result: AgentRunResult | null = null;
    let runId = "";
    for (let attempt = 1; attempt <= INITIAL_PLAN_MAX_ATTEMPTS; attempt += 1) {
      runId = createUlid();
      const raw = await this.invokeManagerPlan(
        {
          invocation_id: runId,
          work_id: workId,
          task_id: null,
          attempt,
          context: {
            mode: "plan",
            start_mode: mode,
            work,
            design_documents: [],
            trigger: { kind: "initial_plan" },
            ...this.processSkillsRequestContext(),
            ...(feedback === null ? {} : { previous_output_feedback: feedback as unknown as JsonObject }),
          },
        },
        "manager.plan",
      );
      if (!this.started) return null;
      if (raw === null) return null;
      result = requireAgentRunResult(raw, "manager plan");
      // A transient provider error (rate limit, network, timeout) or a
      // retryable invalid plan gets a bounded retry before the Work is
      // escalated to the Owner through recordTickFailure.
      const retryable = result.outcome !== "success" && result.failure_class !== "rate_limited" &&
        (result.failure_class === "transient" || result.retry_allowed === true);
      if (!retryable || attempt === INITIAL_PLAN_MAX_ATTEMPTS) break;
      console.warn(`[owl-core] Manager plan attempt ${attempt} for Work ${workId} failed (${result.error_key ?? result.outcome}); retrying.`);
      await delay(this.options.dispatcher?.manager_retry_delay_ms ?? INITIAL_PLAN_RETRY_DELAY_MS);
      if (!this.started) return null;
    }
    return result === null ? null : { result, runId };
  }

  private async runDirectWorkerTask(workId: string): Promise<void> {
    if (!this.started) return;
    const work = this.db.get<Pick<WorkDbRow, "title" | "summary">>(
      "SELECT title, summary FROM works WHERE id = ?",
      workId,
    );
    if (!work) throw notFound("work", workId);
    const acceptance = work.summary.trim() || `Complete the requested change described by the Work title: ${work.title}`;
    await this.workflow.registerPlan(workId, [{
      id: "direct-worker",
      title: work.title,
      type: "code",
      acceptance,
      context: "This lightweight Work is assigned directly to the Worker. Treat the Work title and summary as the owner's request, and keep the change focused.",
      depends_on: [],
    }], "work.planned");
    if (this.started) await this.dispatcher.replayPending();
  }

  /**
   * Item 2: invoke the Manager in "replan" mode for one or more problem
   * Tasks and apply the result. Any failure to obtain and apply a usable
   * replan degrades to auto-opening an Owner Decision (item 4) instead of
   * leaving the Task stuck in `failed` forever. A replan that cannot run or
   * apply because the Work left `running` or Core is stopping is requeued
   * instead (M1): the trigger markers go back to their previous status and a
   * consumed Owner replan request is persisted again, so the first tick after
   * resume or restart asks the Manager again.
   */
  public async triggerManagerReplan(
    workId: string,
    failedTaskIds: readonly string[],
    trigger: ManagerTrigger,
    workerQuestions: readonly WorkerQuestion[] = [],
    finalVerdict: JsonObject | null = null,
    ownerReplan: OwnerReplanRequest | null = null,
    workVerification: JsonObject | null = null,
    baseConflict: BaseMergeConflict | null = null,
  ): Promise<void> {
    // Not started, or another replan for this Work is running: the failed
    // Tasks keep their queued trigger and the next tick replays them.
    if (!this.started || this.replansInFlight.has(workId)) {
      await this.requeueManagerReplan(workId, new Map(), ownerReplan);
      return;
    }
    // A Worker that finishes while the Work is paused (or after it left
    // `running` for any other reason) must not start a Manager replan. The
    // `manager-trigger:<taskId>` marker is left `queued`, so the first tick
    // after resume replays it through queuedReplanTasks.
    if (!this.isWorkRunning(workId) && !(ownerReplan !== null && this.isWorkWaitingForDecision(workId))) {
      await this.requeueManagerReplan(workId, new Map(), ownerReplan);
      return;
    }
    // A Task that is waiting on a prerequisite is not replanned: a late
    // callback for it must not call the Manager.
    if (failedTaskIds.length > 0) {
      failedTaskIds = failedTaskIds.filter(
        (id) => this.db.get<{ prerequisite_json: string | null }>("SELECT prerequisite_json FROM tasks WHERE id = ?", id)?.prerequisite_json == null,
      );
      if (failedTaskIds.length === 0) return;
    }
    this.replansInFlight.add(workId);
    try {
      // An Owner-initiated replan bypasses the remake gate. When any Task is
      // blocked the Work is judgement_waiting and the Manager is not called;
      // the unblocked Tasks keep their queued trigger for after the answer.
      // The Decision a gate opens is announced right away: this path can run
      // from a Worker callback, after which no tick comes for a halted Work.
      if (ownerReplan === null) {
        let gated: boolean;
        try {
          gated = (await this.applyRemakeGate(workId, failedTaskIds)).length > 0 || (await this.applyNoProgressGate(workId, failedTaskIds)).length > 0;
        } catch (error) {
          await this.reportLoopGateFailure(workId, error);
          return;
        }
        this.loopGateFailures.delete(workId);
        if (gated) {
          if (this.started) await this.announceCoreDecisions(workId);
          return;
        }
      }
      const previousMarkers = await this.markReplanAttempted(failedTaskIds);
      const outcome = await this.runManagerReplan(workId, failedTaskIds, trigger, workerQuestions, finalVerdict, ownerReplan, workVerification, baseConflict);
      if (outcome === "requeue") await this.requeueManagerReplan(workId, previousMarkers, ownerReplan);
      else if (trigger.kind === "design_completed") await this.markDesignsHandedToManager(trigger.design_task_ids);
    } finally {
      this.replansInFlight.delete(workId);
    }
  }

  /**
   * Completed design Tasks the Manager has not seen yet, once no design Task
   * is left unfinished. A design Task that already has dependents belongs to
   * a plan made with it (an older Work) and is never handed over.
   */
  private newlyCompletedDesignTasks(workId: string): string[] {
    const designs = this.db.all<{ id: string; status: string }>(
      "SELECT id, status FROM tasks WHERE work_id = ? AND type = 'design' ORDER BY created_at ASC, id ASC",
      workId,
    );
    if (designs.some((design) => design.status !== "completed" && design.status !== "cancelled")) return [];
    return designs
      .filter((design) => design.status === "completed")
      .filter((design) => this.db.get("SELECT 1 FROM idempotency_keys WHERE key = ?", designCompletedKey(design.id)) === undefined)
      .filter((design) => this.db.get("SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE d.depends_on_task_id = ? AND t.type <> 'design'", design.id) === undefined)
      .map((design) => design.id);
  }

  /** Persist that these design Tasks went to the Manager, so no later tick or restart sends them again. */
  private async markDesignsHandedToManager(taskIds: readonly string[]): Promise<void> {
    await this.writeLane.transact((transaction) => {
      this.insertDesignHandedMarkers(transaction, taskIds);
      return null;
    });
  }

  /** The marker write itself, so a replan can store it in the same transaction that adds its Tasks. */
  private insertDesignHandedMarkers(transaction: CoreWriteLaneTransaction, taskIds: readonly string[]): void {
    const now = utcNow();
    for (const taskId of taskIds) {
      transaction.run(
        `INSERT OR IGNORE INTO idempotency_keys (key, request_hash, response_json, status_code, created_at, expires_at)
         VALUES (?, ?, ?, 200, ?, ?)`,
        designCompletedKey(taskId),
        "0".repeat(64),
        JSON.stringify({ task_id: taskId }),
        now,
        "9999-12-31T23:59:59.999Z",
      );
    }
  }

  /** True only when the trigger row is readable JSON marked question_only; a missing or unreadable row goes through the gate. */
  private isQuestionOnlyTrigger(taskId: string): boolean {
    const row = this.db.get<{ response_json: string }>("SELECT response_json FROM idempotency_keys WHERE key = ?", managerTriggerKey(taskId));
    if (!row) return false;
    try {
      return (JSON.parse(row.response_json) as { question_only?: unknown } | null)?.question_only === true;
    } catch {
      return false;
    }
  }

  /**
   * Stop remaking Tasks whose lineage used up a remake limit (a question-only result is not a remake and skips this gate): no new Task is
   * created, the Work waits for the Owner. Returns the blocked Task ids. A
   * failure of the gate itself throws: the caller skips the replan (fail-closed).
   */
  private async applyRemakeGate(workId: string, failedTaskIds: readonly string[]): Promise<string[]> {
    const settings = remakeLimits(this.db);
    const blocked: { id: string; title: string; reason: RemakeLimitReason; usage: ReturnType<typeof lineageUsage> }[] = [];
    for (const id of failedTaskIds) {
      const row = this.db.get<{ title: string; status: string; failed_by_dependency_task_id: string | null }>(
        "SELECT title, status, failed_by_dependency_task_id FROM tasks WHERE id = ? AND work_id = ?",
        id,
        workId,
      );
      if (!row || row.status !== "failed" || row.failed_by_dependency_task_id !== null) continue;
      if (pendingAcceptanceDefect(this.db, id) || pendingExternalBlocker(this.db, id)) continue;
      // A Worker's question is answered by the Manager, not remade; repeats are stopped by the no-progress gate.
      if (this.isQuestionOnlyTrigger(id)) continue;
      const usage = lineageUsage(this.db, id, settings);
      const verdict = evaluateRemakeGate(usage, settings);
      if (verdict.blocked) blocked.push({ id, title: row.title, reason: verdict.reason, usage });
    }
    if (blocked.length === 0) return [];
    const language = ownerLanguage(this.db);
    await this.writeLane.transact((transaction) => {
      const now = utcNow();
      for (const item of blocked) {
        transaction.run(
          "UPDATE idempotency_keys SET response_json = CASE WHEN json_valid(response_json) THEN json_set(response_json, '$.status', 'attempted') ELSE response_json END WHERE key = ?",
          managerTriggerKey(item.id),
        );
        const brief = remakeLimitBrief({ taskTitle: item.title, reason: item.reason, usage: item.usage, settings }, language);
        openRemakeLimitDecisionInTransaction(transaction, { workId, blockedTaskIds: [item.id], brief, now });
      }
      return null;
    });
    return blocked.map((item) => item.id);
  }

  /**
   * Stop asking the Manager to replan Tasks whose consecutive no-progress
   * results reached the limit: the Work waits for the Owner. Returns the
   * blocked Task ids. A failure of the gate itself throws: the caller skips
   * the replan (fail-closed).
   */
  private async applyNoProgressGate(workId: string, failedTaskIds: readonly string[]): Promise<string[]> {
    return await this.writeLane.transact((transaction) => {
      const now = utcNow();
      const stopped: string[] = [];
      for (const id of failedTaskIds) {
        const row = transaction.get<{ status: string; failed_by_dependency_task_id: string | null }>(
          "SELECT status, failed_by_dependency_task_id FROM tasks WHERE id = ? AND work_id = ?",
          id,
          workId,
        );
        if (!row || row.status !== "failed" || row.failed_by_dependency_task_id !== null) continue;
        if (pendingAcceptanceDefect(transaction, id) || pendingExternalBlocker(transaction, id)) continue;
        if (!stopTaskForNoProgressInTransaction(transaction, { taskId: id, gate: "manager", now })) continue;
        transaction.run(
          "UPDATE idempotency_keys SET response_json = json_set(response_json, '$.status', 'attempted') WHERE key = ?",
          managerTriggerKey(id),
        );
        stopped.push(id);
      }
      return stopped;
      });
  }

  /**
   * A loop-prevention gate that cannot run must not let the replan through:
   * log it and tell the Owner once per distinct failure. The trigger markers
   * stay queued, so the next tick evaluates the gate again.
   */
  private async reportLoopGateFailure(workId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[owl-core] loop-prevention gate failed; the replan is skipped until the next tick", error);
    if (this.loopGateFailures.get(workId) === message) return;
    this.loopGateFailures.set(workId, message);
    try {
      await this.writeLane.transact((transaction) => {
        appendEventInTransaction(transaction, {
          type: "work.loop_gate_failed",
          idempotencyKey: `work-loop-gate-failed:${workId}:${createUlid()}`,
          workId,
          taskId: null,
          payload: { message, cause: error instanceof Error && error.cause !== undefined ? String(error.cause) : null },
          now: utcNow(),
        });
        return null;
      });
    } catch (recordError) {
      this.loopGateFailures.delete(workId);
      console.warn("[owl-core] could not record the loop-prevention gate failure", recordError);
    }
  }

  /**
   * Evaluate the Work's prerequisite waits (at most every
   * progress_guard.prerequisite_check_interval_seconds per Task, or at once
   * after wakePrerequisiteWaiters). Satisfied waits are released (after the
   * optional base sync); unreachable, expired or conflicting ones open an
   * Owner Decision. A failure here never blocks the tick.
   */
  private async checkPrerequisites(workId: string): Promise<void> {
    try {
      if (this.db.get<Pick<WorkDbRow, "state">>("SELECT state FROM works WHERE id = ?", workId)?.state !== "running") return;
      const rows = this.db.all<{ id: string; title: string; prerequisite_json: string; prerequisite_since: string | null }>(
        "SELECT id, title, prerequisite_json, prerequisite_since FROM tasks WHERE work_id = ? AND status = 'waiting' AND prerequisite_json IS NOT NULL",
        workId,
      );
      const forced = this.prerequisiteRecheck.delete(workId);
      if (rows.length === 0) return;
      const nowMs = Date.now();
      const intervalMs = progressGuard(this.db).prerequisite_check_interval_seconds * 1000;
      const due = rows.filter((row) => forced || nowMs - (this.prerequisiteCheckedAt.get(row.id) ?? Number.NEGATIVE_INFINITY) >= intervalMs);
      if (due.length === 0) return;
      const specs = due.map((row) => ({ row, spec: JSON.parse(row.prerequisite_json) as PrerequisiteSpec }));
      const paths = [...new Set(specs.flatMap(({ spec }) => spec.conditions.flatMap((condition) => (condition.kind === "base_branch" ? condition.paths : []))))];
      let base: { head: string; missing_paths: readonly string[] } | null = null;
      if (specs.some(({ spec }) => spec.conditions.some((condition) => condition.kind === "base_branch"))) {
        const facts = await this.git.baseBranchFacts?.({ work_id: workId, paths });
        if (facts?.ok) base = { head: facts.head, missing_paths: facts.missing_paths };
        else console.warn(`[owl-core] prerequisite: base branch unreadable for Work ${workId}: ${facts?.message ?? "no git gateway"}`);
      }
      const facts: PrerequisiteFacts = {
        taskStatus: (id) => this.db.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", id)?.status,
        workState: (id) => this.db.get<{ state: string }>("SELECT state FROM works WHERE id = ?", id)?.state,
        baseBranch: () => base,
        processAlive: (pid) => isProcessGroupAlive(pid) || processExists(pid),
        taskFileExists: (taskId, path) => {
          const root = this.workspaceLayout.taskPath(workId, taskId);
          const file = resolve(root, path);
          return !relative(root, file).startsWith("..") && existsSync(file);
        },
      };
      for (const { row, spec } of specs) {
        if (!this.started) return;
        this.prerequisiteCheckedAt.set(row.id, nowMs);
        const outcome = evaluatePrerequisite(spec, facts, new Date(nowMs).toISOString(), row.id);
        if (outcome.verdict === "satisfied") await this.releasePrerequisite(workId, row, spec, base?.head ?? null);
        else if (outcome.verdict !== "pending") await this.expirePrerequisite(workId, row, spec, outcome.verdict === "expired" ? "deadline" : "unreachable", outcome.detail);
      }
      if (this.started) await this.announceCoreDecisions(workId);
    } catch (error) {
      // Why not stop: a failure must not halt the tick. Waiting Tasks then stay waiting (not released or expired) and a corrupt prerequisite_json warns every tick until fixed.
      console.warn(`[owl-core] prerequisite check failed for Work ${workId}`, error);
    }
  }

  /** Merge the base branch into the Work branch when the wait asked for work/base_branch and progress_guard allows it. Returns a sync_conflict detail, or null to go on. */
  private async syncBaseForPrerequisite(workId: string, spec: PrerequisiteSpec): Promise<{ conflict: string } | { failed: string } | null> {
    if (!progressGuard(this.db).prerequisite_sync_base) return null;
    if (!spec.conditions.some((condition) => condition.kind === "work" || condition.kind === "base_branch")) return null;
    if (this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId)?.project_id == null) return null;
    const merged = await this.git.mergeBaseIntoWorkBranch?.({ work_id: workId });
    if (merged === undefined || merged.ok) return null;
    return merged.conflict ? { conflict: merged.message } : { failed: merged.message };
  }

  private async releasePrerequisite(
    workId: string,
    row: { id: string; title: string; prerequisite_since: string | null },
    spec: PrerequisiteSpec,
    baseHead: string | null,
  ): Promise<void> {
    const sync = await this.syncBaseForPrerequisite(workId, spec);
    if (sync !== null && "conflict" in sync) {
      await this.expirePrerequisite(workId, row, spec, "sync_conflict", sync.conflict);
      return;
    }
    if (sync !== null) {
      // Not a conflict: try again at the next evaluation; the deadline still ends the wait.
      console.warn(`[owl-core] prerequisite: base sync failed for Task ${row.id}: ${sync.failed}`);
      return;
    }
    const since = row.prerequisite_since ?? "";
    await this.writeLane.write({
      mutateState: (transaction) => {
        reduceTaskInTransaction(transaction, row.id, { event: "task.prerequisite_satisfied", payload: {} });
        return null;
      },
      event: {
        idempotencyKey: `prerequisite-satisfied:${row.id}:${since}`,
        type: "task.prerequisite_satisfied",
        workId,
        taskId: row.id,
        payload: {
          task_id: row.id,
          conditions: spec.conditions as unknown as JsonObject[],
          base_head_after: baseHead,
          waited_seconds: Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000)),
        },
      },
      outbox: [{ provider: "websocket" }],
    });
    this.workDriver.wake(workId);
  }

  private async expirePrerequisite(
    workId: string,
    row: { id: string; title: string; prerequisite_since: string | null },
    spec: PrerequisiteSpec,
    kind: "deadline" | "unreachable" | "sync_conflict",
    detail: string,
  ): Promise<void> {
    await this.writeLane.write({
      mutateState: (transaction) => {
        const brief = prerequisiteExpiredBrief(
          { taskTitle: row.title, kind, detail, reason: spec.reason, conditions: spec.conditions.map((condition) => condition.description) },
          ownerLanguage(transaction),
        );
        openRemakeLimitDecisionInTransaction(transaction, { workId, blockedTaskIds: [row.id], brief, now: utcNow() });
        return null;
      },
      event: {
        idempotencyKey: `prerequisite-expired:${row.id}:${row.prerequisite_since ?? ""}`,
        type: "task.prerequisite_expired",
        workId,
        taskId: row.id,
        payload: { task_id: row.id, kind, detail },
      },
      outbox: [{ provider: "websocket" }],
    });
  }

  /**
   * A Task or Work finished (or the base branch moved because a Work was
   * merged): schedule an immediate evaluation of the Works whose waiting
   * Tasks named it, instead of waiting for the interval.
   */
  private wakePrerequisiteWaiters(sourceWorkId: string, merged: boolean): void {
    try {
      const waiters = this.db.all<{ id: string; work_id: string; prerequisite_json: string }>(
        "SELECT id, work_id, prerequisite_json FROM tasks WHERE status = 'waiting' AND prerequisite_json IS NOT NULL AND work_id <> ?",
        sourceWorkId,
      );
      if (waiters.length === 0) return;
      const source = this.db.get<{ state: string; project_id: string | null }>("SELECT state, project_id FROM works WHERE id = ?", sourceWorkId);
      for (const waiter of waiters) {
        const spec = JSON.parse(waiter.prerequisite_json) as PrerequisiteSpec;
        const hits = spec.conditions.filter((condition) => {
          if (condition.kind === "task") {
            return this.db.get<{ work_id: string; status: string }>("SELECT work_id, status FROM tasks WHERE id = ?", condition.task_id)?.status === "completed"
              && this.db.get<{ work_id: string }>("SELECT work_id FROM tasks WHERE id = ?", condition.task_id)?.work_id === sourceWorkId;
          }
          if (condition.kind === "work") return condition.work_id === sourceWorkId && source?.state === "completed";
          if (condition.kind === "base_branch") {
            return merged && source?.project_id != null
              && this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", waiter.work_id)?.project_id === source.project_id;
          }
          return false;
        });
        if (hits.length === 0) continue;
        const hitIds = hits.map((condition) => (condition.kind === "task" ? condition.task_id : condition.kind === "work" ? condition.work_id : "base")).join(",");
        const key = merged ? `${waiter.id}:merge:${Date.now()}` : `${waiter.id}:${spec.deadline_at}:${sourceWorkId}:${source?.state}:${hitIds}`;
        if (this.prerequisiteWoken.has(key)) continue;
        this.prerequisiteWoken.add(key);
        this.prerequisiteRecheck.add(waiter.work_id);
        this.workDriver.wake(waiter.work_id);
      }
    } catch (error) {
      console.warn("[owl-core] prerequisite wake failed", error);
    }
  }

  /**
   * The Owner releases a Task from its prerequisite wait: the mark is
   * cleared, no_progress_count returns to 0 and the message reaches the next
   * Worker as owner guidance. A Task that waits on no prerequisite is a 409.
   */
  public async resumePrerequisiteWait(
    taskId: string,
    input: { readonly message: string | null; readonly idempotencyKey: string; readonly actor: string },
  ): Promise<CommandResponse<{ task_id: string; work_id: string; resumed: true }>> {
    const task = this.db.get<{ work_id: string; prerequisite_json: string | null }>("SELECT work_id, prerequisite_json FROM tasks WHERE id = ?", taskId);
    if (!task) throw notFound("task", taskId);
    const workId = task.work_id;
    const message = input.message === null || input.message.trim().length === 0 ? null : input.message.trim();
    if (task.prerequisite_json !== null) {
      // Same wait, first resume: bring the base in before the Worker runs again.
      const sync = await this.syncBaseForPrerequisite(workId, JSON.parse(task.prerequisite_json) as PrerequisiteSpec);
      if (sync !== null) {
        const row = this.db.get<{ title: string; prerequisite_since: string | null }>("SELECT title, prerequisite_since FROM tasks WHERE id = ?", taskId);
        if ("conflict" in sync && row) {
          await this.expirePrerequisite(workId, { id: taskId, ...row }, JSON.parse(task.prerequisite_json) as PrerequisiteSpec, "sync_conflict", sync.conflict);
        }
        throw invalidStateTransition("The base branch could not be merged into the Work branch, so the prerequisite wait was kept.", {
          task_id: taskId,
          work_id: workId,
          reason: "conflict" in sync ? "sync_conflict" : "sync_failed",
          detail: "conflict" in sync ? sync.conflict : sync.failed,
        });
      }
    }
    const response = await this.runCommand(
      { request_id: createUlid(), idempotency_key: input.idempotencyKey, expected_version: 0, payload: { message, actor: input.actor } },
      { type: "task.prerequisite_resumed", workId, taskId, payload: { task_id: taskId, message, actor: input.actor } },
      (transaction) => {
        const row = transaction.get<{ status: string; paused_from: string | null; prerequisite_json: string | null }>(
          "SELECT status, paused_from, prerequisite_json FROM tasks WHERE id = ?",
          taskId,
        );
        const workState = transaction.get<{ state: string }>("SELECT state FROM works WHERE id = ?", workId)?.state;
        if (row?.prerequisite_json == null || (workState !== "running" && workState !== "paused")) {
          throw invalidStateTransition("The Task is not waiting on a prerequisite, or its Work is not running or paused.", {
            task_id: taskId,
            work_id: workId,
            task_status: row?.status ?? null,
            work_state: workState ?? null,
          });
        }
        const result = reduceTaskInTransaction(transaction, taskId, { event: "task.prerequisite_resumed", payload: {} });
        return { data: { task_id: taskId, work_id: workId, resumed: true as const }, version: result.next.state_version };
      },
    );
    this.workDriver.wake(workId);
    return response;
  }

  private isWorkRunning(workId: string): boolean {
    return this.db.get<Pick<WorkDbRow, "state">>("SELECT state FROM works WHERE id = ?", workId)?.state === "running";
  }

  /** An Owner request may reach the Manager while the Work waits for a Decision. */
  private isWorkWaitingForDecision(workId: string): boolean {
    return this.db.get<Pick<WorkDbRow, "state">>("SELECT state FROM works WHERE id = ?", workId)?.state === "judgement_waiting";
  }

  // A pause followed by a resume while a Manager replan call is outstanding
  // leaves the Work `running` again by the time the call returns, which a
  // plain running check cannot tell apart from "never interrupted". Requiring
  // the state_version to still match the value captured before the call
  // catches that case too (M1): any transition at all during the call,
  // including a pause immediately undone by a resume, discards the answer.
  private isReplanStillCurrent(workId: string, expectedVersion: number, ownerReplan = false): boolean {
    const work = this.db.get<Pick<WorkDbRow, "state" | "state_version">>(
      "SELECT state, state_version FROM works WHERE id = ?",
      workId,
    );
    return (work?.state === "running" || (ownerReplan && work?.state === "judgement_waiting")) && work.state_version === expectedVersion;
  }

  /** Mark the triggers attempted and return each marker's previous status. */
  private async markReplanAttempted(taskIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (taskIds.length === 0) return new Map();
    return this.writeLane.transact((transaction) => {
      const previous = new Map<string, string>();
      for (const taskId of taskIds) {
        const row = transaction.get<{ status: string | null }>(
          "SELECT json_extract(response_json, '$.status') AS status FROM idempotency_keys WHERE key = ?",
          managerTriggerKey(taskId),
        );
        if (typeof row?.status === "string") previous.set(taskId, row.status);
        transaction.run(
          `UPDATE idempotency_keys
              SET response_json = json_set(response_json, '$.status', 'attempted')
            WHERE key = ?`,
          managerTriggerKey(taskId),
        );
      }
      return previous;
    });
  }

  /**
   * Undo what starting a replan consumed, so a later tick runs it again:
   * each trigger marker still `attempted` gets its previous status back, and
   * a consumed Owner replan request is persisted again (never over a newer
   * one). Best effort: during shutdown the database may already be closing.
   */
  private async requeueManagerReplan(
    workId: string,
    previousMarkers: ReadonlyMap<string, string>,
    ownerReplan: OwnerReplanRequest | null,
  ): Promise<void> {
    if (previousMarkers.size === 0 && ownerReplan === null) return;
    try {
      await this.writeLane.transact((transaction) => {
        for (const [taskId, status] of previousMarkers) {
          transaction.run(
            `UPDATE idempotency_keys
                SET response_json = json_set(response_json, '$.status', ?)
              WHERE key = ? AND json_extract(response_json, '$.status') = 'attempted'`,
            status,
            managerTriggerKey(taskId),
          );
        }
        if (ownerReplan !== null) requeueOwnerReplanInTransaction(transaction, workId);
        return null;
      });
    } catch (error) {
      console.error(`[owl-core] failed to requeue the Manager replan for Work ${workId}`, error);
    }
  }

  /** Root-failed Tasks whose Manager trigger is still queued and no open Decision covers them. */
  private queuedReplanTasks(workId: string): { id: string; question: string | null }[] {
    return this.db.all<{ id: string; question: string | null }>(
      `SELECT tasks.id AS id, json_extract(trigger_key.response_json, '$.question') AS question
         FROM tasks
         JOIN idempotency_keys AS trigger_key ON trigger_key.key = 'manager-trigger:' || tasks.id
        WHERE tasks.work_id = ? AND tasks.status = 'failed'
          AND json_extract(trigger_key.response_json, '$.status') = 'queued'
          AND tasks.failed_by_dependency_task_id IS NULL
          AND COALESCE(tasks.manager_task_id, '') NOT LIKE ? || '%'
          AND NOT EXISTS (
            SELECT 1 FROM decisions
             WHERE decisions.work_id = tasks.work_id AND decisions.status = 'open'
               AND (decisions.scope = 'work'
                    OR EXISTS (SELECT 1 FROM json_each(decisions.blocked_task_ids_json) WHERE value = tasks.id))
          )
        ORDER BY tasks.created_at ASC, tasks.id ASC`,
      workId,
      QUARANTINE_FIX_TASK_PREFIX,
    );
  }

  private hasQueuedOwnerReplan(workId: string): boolean {
    return this.db.get(
      "SELECT 1 FROM idempotency_keys WHERE key = ? AND json_extract(response_json, '$.status') = 'queued'",
      ownerReplanKey(workId),
    ) !== undefined;
  }

  /**
   * Take the persisted Owner replan request for a Work, if any. The marker is
   * moved to `attempted` rather than deleted, so a crash before the Manager
   * finishes acting on it leaves it recoverable: startup recovery moves any
   * still-`attempted` marker back to `queued` for the next tick to retry.
   */
  private async consumeOwnerReplan(workId: string): Promise<OwnerReplanRequest | null> {
    return this.writeLane.transact((transaction) => {
      foldProcessingOwnerReplanInTransaction(transaction, workId);
      const row = transaction.get<{ response_json: string }>(
        "SELECT response_json FROM idempotency_keys WHERE key = ? AND json_extract(response_json, '$.status') = 'queued'",
        ownerReplanKey(workId),
      );
      if (!row) return null;
      transaction.run(
        `UPDATE idempotency_keys SET response_json = json_set(response_json, '$.status', 'attempted') WHERE key = ?`,
        ownerReplanKey(workId),
      );
      try {
        const value = JSON.parse(row.response_json) as unknown;
        if (isRecord(value) && typeof value.answer === "string") {
          return {
            kind: value.kind === "reopen" || value.kind === "instruction" || value.kind === "work_update" || value.kind === "auto_conflict" || value.kind === "auto_final" ? value.kind : "decision",
            answer: value.answer,
            message_ids: markerMessageIds(value.message_ids),
            requests: ownerRequestsOf(value),
          };
        }
      } catch (error) {
        // A malformed request is dropped; the normal terminal handling applies.
        console.warn(`[owl-core] Dropping a malformed Owner replan request for Work ${workId} (key ${ownerReplanKey(workId)})`, error);
      }
      return null;
    });
  }

  /**
   * The one place a Manager replan request is built. `attempt` 2 carries the
   * previous answer's problems in `previous_output_feedback`; `trigger` stays the original one.
   */
  private buildReplanRequest(
    workId: string,
    failedTaskIds: readonly string[],
    trigger: ManagerTrigger,
    workerQuestions: readonly WorkerQuestion[],
    attempt: number,
    finalVerdict: JsonObject | null,
    ownerReplanKind: string | null = null,
    workVerification: JsonObject | null = null,
    feedback: PreviousOutputFeedback | null = null,
    ownerRequests: readonly OwnerRequestInput[] = [],
    baseConflict: BaseMergeConflict | null = null,
  ): JsonObject {
    const work = this.managerWorkContext(workId);
    const failedRows =
      failedTaskIds.length > 0
        ? this.db.all<TaskRow>(
            `SELECT * FROM tasks WHERE id IN (${failedTaskIds.map(() => "?").join(",")}) ORDER BY created_at ASC, id ASC`,
            ...failedTaskIds,
          )
        : [];
    return {
      invocation_id: createUlid(),
      work_id: workId,
      task_id: null,
      attempt,
      trigger: trigger as unknown as JsonObject,
      mode: "replan",
      context: {
        mode: "replan",
        owner_replan_kind: ownerReplanKind,
        work,
        ...this.processSkillsRequestContext(),
        failed_task_ids: [...failedTaskIds],
        // The root failed Tasks as the Manager reads every Task (no hashes,
        // worktree paths or leases), and per Task why it failed.
        tasks: failedRows.map((task) => managerTaskView(task, this.taskDependencyIds(task.id))),
        failed_tasks: failedRows.flatMap((task) => {
          const brief = failedTaskBrief(this.db, task.id);
          return brief === null ? [] : [{ ...brief, ...storedVerificationSpec(task) }];
        }),
        // The whole current plan, so the Manager can tell which ids already
        // exist and which Tasks already completed.
        current_plan: this.planOverview(workId),
        design_documents: this.completedDesignDocuments(workId),
        trigger: trigger as unknown as JsonObject,
        worker_questions: workerQuestions as unknown as JsonObject[],
        owner_requests: ownerRequests as unknown as JsonObject[],
        base_merge_conflict: baseConflict as unknown as JsonObject | null,
        final_verdict: finalVerdict,
        work_verification: workVerification,
        previous_output_feedback: feedback as unknown as JsonObject | null,
      },
    };
  }

  private completedDesignDocuments(workId: string): JsonObject[] {
    return this.db.all<{ id: string; title: string }>(
      "SELECT id, title FROM tasks WHERE work_id = ? AND type = 'design' AND status = 'completed' ORDER BY created_at ASC, id ASC",
      workId,
    ).map((task) => ({
      task_id: task.id,
      title: task.title,
      path: designDocumentPath(this.dataDir, workId, task.id),
    }));
  }

  /** The Work's Tasks and dependency edges, read once per Manager replan answer. */
  private replanSnapshot(workId: string): ReplanSnapshot {
    const tasks = this.db.all<{ id: string; manager_task_id: string | null; status: string; failed_by_dependency_task_id: string | null }>(
      "SELECT id, manager_task_id, status, failed_by_dependency_task_id FROM tasks WHERE work_id = ? ORDER BY created_at ASC, id ASC",
      workId,
    );
    const edges = this.db.all<{ task_id: string; depends_on_task_id: string }>(
      `SELECT task_id, depends_on_task_id FROM task_dependencies
        WHERE task_id IN (SELECT id FROM tasks WHERE work_id = ?)`,
      workId,
    );
    return {
      tasks: tasks.map((task) => ({
        id: task.id,
        manager_task_id: task.manager_task_id,
        status: task.status,
        failed_by_dependency: task.failed_by_dependency_task_id !== null,
      })),
      edges,
      plan_revision: this.db.get<{ plan_revision: number }>("SELECT plan_revision FROM works WHERE id = ?", workId)?.plan_revision ?? 0,
    };
  }

  /**
   * Ask the Manager for a replan and apply it. The answer is validated
   * against a snapshot of the Work before anything is written; a rejected
   * answer gets one repair attempt with the reasons, then an Owner Decision
   * with them. A failure while applying a valid plan also becomes a Decision
   * carrying the real cause, never a tick error.
   *
   * Returns "requeue" when nothing was applied because the Work is no longer
   * running, its plan or a root Task changed during the Manager call, or
   * Core is stopping; the caller then restores the triggers (M1).
   */
  private async runManagerReplan(
    workId: string,
    failedTaskIds: readonly string[],
    trigger: ManagerTrigger,
    workerQuestions: readonly WorkerQuestion[] = [],
    finalVerdict: JsonObject | null = null,
    ownerReplan: OwnerReplanRequest | null = null,
    workVerification: JsonObject | null = null,
    baseConflict: BaseMergeConflict | null = null,
  ): Promise<"done" | "requeue"> {
    if (!this.started) return "requeue";
    // Defensive: the Manager only ever sees root failures (callers already pass only those).
    failedTaskIds = failedTaskIds.filter((taskId) => !this.isCascadedFailure(taskId));
    const messageIds = ownerReplan?.message_ids ?? [];
    const language = ownerLanguage(this.db);
    const fail = async (detail: string): Promise<void> => {
      await this.openManagerReplanFailureDecision(
        workId,
        failedTaskIds,
        detail,
        ownerReplan !== null
          ? ownerReplan.kind === "auto_conflict" || ownerReplan.kind === "auto_final" ? undefined : ownerReplan.answer
          : workerQuestions.length > 0 ? workerQuestions.map((entry) => entry.question).join("\n") : undefined,
        finalVerdict,
        ownerReplan?.kind === "auto_conflict" ? mergeConflictFiles(this.latestSystemAlert(workId)) : undefined,
      );
      if (messageIds.length === 0) return;
      await this.writeLane.write({
        mutateState: (transaction) => {
          insertInstructionReply(transaction, messageIds, "decision_opened", null, INSTRUCTION_REPLY_TEXT[language].decisionOpened(firstLine(detail)));
        },
        event: { idempotencyKey: `instruction-reply:${createUlid()}`, type: "message.posted", workId, payload: { kind: "message_posted", schema_version: "1.0.0" } },
          outbox: [{ provider: "websocket" }],
      });
    };
    let plan: ReplanPlan | null = null;
    let prerequisites: ReadonlyMap<string, PrerequisiteSpec> = new Map();
    let planSnapshot: ReplanSnapshot | null = null;
    let rejection: readonly string[] = [];
    let feedback: PreviousOutputFeedback | null = null;
    // Set where a quality check, not the validator, produced the rejection.
    let qualityFeedback: PreviousOutputFeedback | null = null;
    let qualityRepairs = 0;
    const quality = planQualitySettings(this.db);
    let summaryUpdate: ManagerWorkSummaryUpdate | null = null;
    let summaryBase = { title: "", summary: "" };
    let managerRunId = "";
    for (let attempt = 1; attempt <= REPLAN_MAX_ATTEMPTS + qualityRepairs && plan === null; attempt += 1) {
      const workBeforeCall = this.db.get<Pick<WorkDbRow, "state" | "state_version">>(
        "SELECT state, state_version FROM works WHERE id = ?",
        workId,
      );
      if (workBeforeCall?.state !== "running" && !(ownerReplan !== null && workBeforeCall?.state === "judgement_waiting")) return "requeue";
      const snapshot = this.replanSnapshot(workId);
      const request = this.buildReplanRequest(workId, failedTaskIds, trigger, workerQuestions, attempt, finalVerdict, ownerReplan?.kind ?? null, workVerification, feedback, ownerReplan?.requests ?? [], baseConflict);
      let result: AgentRunResult;
      try {
        const raw = await this.invokeManagerPlan(request, "manager.replan");
        // M1: the call takes minutes; a pause, cancel or Decision in the
        // meantime means this answer must not be acted on now, even if the
        // Work is running again by the time this returns.
        if (!this.started || !this.isReplanStillCurrent(workId, workBeforeCall.state_version, ownerReplan !== null)) return "requeue";
        if (raw === null) return "requeue";
        result = requireAgentRunResult(raw, "manager replan");
      } catch (error) {
        if (!this.started || !this.isReplanStillCurrent(workId, workBeforeCall.state_version, ownerReplan !== null)) return "requeue";
        await fail(humanizeUnexpected(error, "manager.replan").message);
        return "done";
      }
      if (result.failure_class === "rate_limited") return "requeue";
      if (result.outcome !== "success") {
        await fail(result.message ?? `Manager replan did not succeed (outcome=${result.outcome}).`);
        return "done";
      }
      let report: JsonObject;
      try {
        report = requireManagerReport(result, "manager replan");
      } catch (error) {
        await fail(humanizeUnexpected(error, "manager.replan").message);
        return "done";
      }
      if (report.event !== "task.replanned") {
        await fail("The Manager replan result did not return a task.replanned event.");
        return "done";
      }
      let items: readonly TaskPlanItem[];
      try {
        items = managerTasksToPlanItems(report.tasks, workId, { allowEmpty: true });
      } catch (error) {
        await fail(humanizeUnexpected(error, "manager.replan").message);
        return "done";
      }
      let update: ManagerWorkSummaryUpdate | null;
      try {
        update = managerWorkSummaryUpdate(report);
      } catch (error) {
        await fail(humanizeUnexpected(error, "manager.replan").message);
        return "done";
      }
      const acceptanceRevisionRequired = new Map<string, string>();
      for (const id of failedTaskIds) {
        if (!pendingAcceptanceDefect(this.db, id)) continue;
        const current = this.db.get<{ acceptance: string }>("SELECT acceptance FROM tasks WHERE id = ?", id);
        if (current) acceptanceRevisionRequired.set(id, current.acceptance);
      }
      let taskActions: readonly ReplanAction[];
      try {
        taskActions = managerTaskActions(report.task_actions);
      } catch (error) {
        await fail(humanizeUnexpected(error, "manager.replan").message);
        return "done";
      }
      let validated: ReplanPlan | PlanRejection = validateReplan(items, snapshot, failedTaskIds, { actions: taskActions, allowOpen: ownerReplan !== null, acceptanceRevisionRequired });
      let resolvedWaits: ReadonlyMap<string, PrerequisiteSpec> = new Map();
      if (!isPlanRejection(validated) && validated.waits.size > 0) {
        const resolved = await this.resolvePrerequisiteWaits(workId, validated.waits);
        if ("errors" in resolved) validated = { errors: resolved.errors };
        else resolvedWaits = resolved.specs;
      }
      if (!isPlanRejection(validated)) {
        const found = quality.enabled ? evaluatePlanQuality(items, quality) : [];
        // Missing fields are a format error: rejected with a fields-only reason, not counted as a quality repair.
        const formatWarnings = found.filter((warning) => warning.code === "criterion_field_missing");
        const warnings = formatWarnings.length > 0 ? [] : found;
        const outcome = warnings.length > 0 ? planQualityOutcome(warnings, qualityRepairs, quality) : null;
        if (outcome !== null) await this.recordPlanQualityWarned(workId, "replan", attempt, String(request.invocation_id), warnings, outcome);
        if (formatWarnings.length > 0) {
          validated = { errors: [formatPlanQualityReason(formatWarnings)] };
          qualityFeedback = { kind: "fields_missing", errors: [], warnings: formatWarnings };
        } else if (outcome === "rejected") {
          const blocking = warnings.filter((warning) => quality.blocking_codes.includes(warning.code));
          validated = { errors: [formatPlanQualityReason(blocking)] };
          qualityFeedback = { kind: "quality_rejected", errors: [], warnings: blocking };
        } else if (outcome === "repair_requested") {
          qualityRepairs += 1;
          feedback = { kind: "quality_repair", errors: [], warnings };
          continue;
        } else {
        plan = validated;
        prerequisites = resolvedWaits;
        planSnapshot = snapshot;
        summaryUpdate = update;
        const shown = (request.context as JsonObject).work as JsonObject;
        summaryBase = { title: String(shown.title), summary: String(shown.summary ?? "") };
        managerRunId = String(request.invocation_id);
        break;
      }
        }
      rejection = validated.errors;
      feedback = qualityFeedback ?? { kind: "plan_rejected", errors: rejection, warnings: [] };
      qualityFeedback = null;
      console.warn(`[owl-core] Manager replan attempt ${attempt} for Work ${workId} was rejected: ${rejection.join(" ")}`);
    }
    if (plan === null || planSnapshot === null) {
      await fail(`The Manager's replan was rejected twice. ${rejection.join(" ")}`);
      return "done";
    }
    // An empty plan with no root failure writes nothing: the next tick sees
    // every Task terminal and runs the final check.
    if (plan.newItems.length === 0 && plan.reopenIds.length === 0 && plan.supersessions.size === 0 && (plan.actions?.size ?? 0) === 0) {
      if (ownerReplan !== null) {
        await this.writeLane.write({
          mutateState: (transaction) => {
            transaction.run(
              `DELETE FROM idempotency_keys
                WHERE key = ? AND json_extract(response_json, '$.status') = 'attempted'`,
              ownerReplanKey(workId),
            );
            applyManagerWorkSummaryUpdateInTransaction(transaction, { work_id: workId, update: summaryUpdate, owner_replan: ownerReplan, agent_run_id: managerRunId, base: summaryBase });
            insertInstructionReply(transaction, messageIds, "no_change", null, INSTRUCTION_REPLY_TEXT[language].noChange);
          },
          event: { idempotencyKey: `instruction-reply:${createUlid()}`, type: "message.posted", workId, payload: { kind: "message_posted", schema_version: "1.0.0" } },
          outbox: [{ provider: "websocket" }],
        });
      }
      await this.dispatcher.replayPending();
      return "done";
    }
    // M2: one WriteLane transaction applies the whole plan after re-checking
    // the Work state, the plan revision and every root Task's status.
    const guard = {
      base_plan_revision: planSnapshot.plan_revision ?? 0,
      root_statuses: new Map(planSnapshot.tasks.map((task) => [task.id, task.status])),
      owner_replan: ownerReplan !== null,
    };
    try {
      const applied = await this.workflow.applyReplan(
        workId,
        plan,
        guard,
        `Manager replan: ${trigger.kind}`,
        ownerReplan !== null ? ownerReplanKey(workId) : undefined,
        {
          prerequisites,
          afterApply: (transaction, result) => {
            if (trigger.kind === "design_completed") this.insertDesignHandedMarkers(transaction, trigger.design_task_ids);
            applyManagerWorkSummaryUpdateInTransaction(transaction, { work_id: workId, update: summaryUpdate, owner_replan: ownerReplan, agent_run_id: managerRunId, base: summaryBase });
            const revision = transaction.get<{ plan_revision: number }>("SELECT plan_revision FROM works WHERE id = ?", workId)?.plan_revision ?? 0;
            const title = (taskId: string): string => transaction.get<{ title: string }>("SELECT title FROM tasks WHERE id = ?", taskId)?.title ?? taskId;
            const summary: ReplanSummary = {
              planRevision: revision,
              added: result.registered.map((task) => task.title),
              redone: result.reopened.map(title),
              replaced: Object.entries(result.replacements).map(([oldId, newIds]) => `${title(oldId)} → ${newIds.map(title).join(", ")}`),
            };
            insertInstructionReply(transaction, messageIds, "tasks_changed", revision, INSTRUCTION_REPLY_TEXT[language].tasksChanged(summary));
          },
        },
      );
      await this.announceDecisionCancellations(applied.cancelled_decision_ids);
      await this.signalStoppedTaskRuns(applied.stopped_task_ids);
      this.trackWorktreeReconcile(workId, "replan_applied");
    } catch (error) {
      if (!this.started) return "requeue";
      const code = error instanceof HumanReadableError ? error.code : null;
      if (code === REPLAN_WORK_NOT_RUNNING || code === REPLAN_PLAN_STALE) {
        // Nothing was written. The Work paused, was cancelled or waits on a
        // Decision (requeued until it runs again), or the plan the Manager
        // answered no longer matches the Work (asked again against the
        // current state by the next tick). Only Tasks still failed with a
        // queued trigger and no open Decision are replayed, so this is bounded.
        console.warn(`[owl-core] Manager replan for Work ${workId} was not applied and is requeued: ${error instanceof Error ? error.message : String(error)}`);
        return "requeue";
      }
      await fail(`The Manager's replan could not be applied: ${humanizeUnexpected(error, "manager.replan").message}`);
      return "done";
    }
    await this.dispatcher.replayPending();
    return "done";
  }

  /** Stop the Agents still working on Tasks a replan cancelled, replaced or completed (their runs are already cancel_requested). */
  private async signalStoppedTaskRuns(taskIds: readonly string[]): Promise<void> {
    if (taskIds.length === 0) return;
    const runs = this.db.all<{ id: string; role: string; pid: number | null; process_start_time: string | null; process_cmdline_sha256: string | null }>(
      `SELECT id, role, pid, process_start_time, process_cmdline_sha256 FROM agent_runs
        WHERE status = 'cancel_requested' AND task_id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(taskIds),
    );
    for (const run of runs) {
      try {
        if (run.role === "executor") signalRecordedProcess(run, "SIGTERM");
        else if (this.options.agentRunner.cancelAgent) await this.options.agentRunner.cancelAgent(run.id, false);
        else if (run.pid && processIdentityMatches(
          { process_start_time: run.process_start_time, process_cmdline_sha256: run.process_cmdline_sha256 },
          readProcessIdentity(run.pid),
        )) {
          signalProcessGroup(run.pid, "SIGTERM");
        }
      } catch (error) {
        console.error(`[owl-core] Failed to signal Agent ${run.id} of a stopped Task`, error);
      }
    }
  }

  /**
   * Resolve each retried Task's wait_for against the database and git:
   * "#<number>" to a work id, base_head from the Project's base branch,
   * deadline_at from progress_guard. Problems come back as rejection lines
   * for the Manager's repair attempt.
   */
  private async resolvePrerequisiteWaits(
    workId: string,
    waits: ReadonlyMap<string, PlanWaitFor>,
  ): Promise<{ readonly specs: ReadonlyMap<string, PrerequisiteSpec> } | { readonly errors: readonly string[] }> {
    const errors: string[] = [];
    const specs = new Map<string, PrerequisiteSpec>();
    const hasProject = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId)?.project_id != null;
    const deadline = new Date(Date.now() + progressGuard(this.db).prerequisite_max_wait_hours * 3_600_000).toISOString();
    for (const [taskId, wait] of waits) {
      const name = this.db.get<{ title: string }>("SELECT title FROM tasks WHERE id = ?", taskId)?.title ?? taskId;
      const conditions: PrerequisiteCondition[] = [];
      for (const [index, condition] of wait.conditions.entries()) {
        const field = "Task " + name + " wait_for.conditions[" + index + "]";
        if (condition.kind === "task") {
          const target = this.db.get<{ work_id: string; status: string }>("SELECT work_id, status FROM tasks WHERE id = ?", condition.target);
          if (!target) errors.push(field + ": Task " + condition.target + " does not exist.");
          else if (target.work_id === workId) errors.push(field + ": Task " + condition.target + " is in this Work; use depends_on instead of wait_for.");
          else if (target.status === "cancelled") errors.push(field + ": Task " + condition.target + " is cancelled and can never complete.");
          else conditions.push({ kind: "task", task_id: condition.target, description: condition.description });
        } else if (condition.kind === "work") {
          const number = /^#(\d+)$/u.exec(condition.target);
          const target = number
            ? this.db.get<{ id: string; state: string }>("SELECT id, state FROM works WHERE display_number = ?", Number(number[1]))
            : this.db.get<{ id: string; state: string }>("SELECT id, state FROM works WHERE id = ?", condition.target);
          if (!target) errors.push(field + ": Work " + condition.target + " does not exist.");
          else if (target.id === workId) errors.push(field + ": a Work cannot wait for itself.");
          else if (target.state === "cancelled") errors.push(field + ": Work " + condition.target + " is cancelled and can never complete.");
          else conditions.push({ kind: "work", work_id: target.id, description: condition.description });
        } else if (condition.kind === "base_branch") {
          if (!hasProject) errors.push(field + ": this Work has no Project, so there is no base branch to wait for.");
          else conditions.push({ kind: "base_branch", paths: [...condition.paths], description: condition.description });
        } else {
          conditions.push({ kind: "owner", description: condition.description });
        }
      }
      let baseHead: string | null = null;
      if (conditions.some((condition) => condition.kind === "base_branch")) {
        const facts = await this.git.baseBranchFacts?.({ work_id: workId, paths: [] });
        if (facts?.ok) baseHead = facts.head;
        else errors.push("Task " + name + " wait_for: the base branch could not be read (" + (facts?.message ?? "no git gateway") + ").");
      }
      specs.set(taskId, { reason: wait.reason, source: "manager", conditions, base_head: baseHead, deadline_at: deadline, replan_question: null });
    }
    return errors.length > 0 ? { errors } : { specs };
  }

  /**
   * Auto-open a Decision for the Owner when a Manager replan fails, cannot
   * be applied, or leaves a Task unresolved. issuer_role is "manager"
   * because the Decision represents "the Manager could not resolve this",
   * matching the failed -> judgement_waiting guard text ("manager cannot
   * continue and owner decision open"). retry_allowed=false Task failures
   * (auth revoked, provider mismatch, ...) already auto-open their own
   * Decision inside the reducer transaction via ensureCoreDecision and
   * never reach this method.
   */
  private async openManagerReplanFailureDecision(
    workId: string,
    failedTaskIds: readonly string[],
    detail: string,
    question?: string,
    finalVerdict: JsonObject | null = null,
    autoConflictFiles?: readonly string[],
  ): Promise<void> {
    // Only root failures are blocked: a cascaded Task stays failed and
    // returns to waiting by itself once the answer resumes its dependency
    // Blocking it would make every non-cancel answer fail.
    const eligibleTaskIds = failedTaskIds.filter((taskId) => {
      const row = this.db.get<{ status: string; failed_by_dependency_task_id: string | null }>(
        "SELECT status, failed_by_dependency_task_id FROM tasks WHERE id = ?",
        taskId,
      );
      return row?.status === "failed" && row.failed_by_dependency_task_id === null;
    });
    const scope: "task" | "work" = eligibleTaskIds.length > 0 ? "task" : "work";
    try {
      await this.decisions.open({
        request_id: createUlid(),
        idempotency_key: `manager-replan-failed:${createUlid()}`,
        expected_version: 0,
        payload: {
          work_id: workId,
          scope,
          blocked_task_ids: eligibleTaskIds,
          ...managerReplanFailureBrief(scope, detail, ownerLanguage(this.db), question, finalVerdict?.missing, autoConflictFiles),
          allow_free_text: true,
          issuer_role: "manager",
        },
      });
    } catch (error) {
      console.error(`[owl-core] failed to open Owner Decision after Manager replan failure for Work ${workId}`, error);
      return;
    }
    await this.dispatcher.replayPending();
  }

  /**
   * The Final Manager reviews every completed Task's report and returns a
   * verdict. A malformed answer or a retryable provider failure gets one
   * more attempt; when no attempt succeeds this throws final_manager_failed
   * (a failed check, never an "incomplete" verdict). Returns null when Core
   * stopped mid-call.
   */
  private async runFinalManager(workId: string, workBranchVerification: WorkBranchVerification): Promise<{ readonly verdict: FinalManagerVerdict; readonly agent_run_id: string } | null> {
    const work = this.managerWorkContext(workId);
    const tasks = this.db.all<TaskRow>("SELECT * FROM tasks WHERE work_id = ? ORDER BY created_at ASC, id ASC", workId);
    const managerTasks = tasks.map((task) => managerTaskView(task, this.taskDependencyIds(task.id)));
    const reports: JsonObject[] = [];
    for (const task of tasks) {
      if (task.status !== "completed") continue;
      const row = this.db.get<{ payload_json: string }>(
        `SELECT reports.payload_json
           FROM reports JOIN agent_runs ON agent_runs.id = reports.agent_run_id
          WHERE agent_runs.task_id = ?
          ORDER BY reports.created_at DESC LIMIT 1`,
        task.id,
      );
      if (!row) {
        // The Manager judges from the reports it has; a lost report row must
        // not turn every tick into a failure.
        console.error(`[owl-core] completed Task ${task.id} of Work ${workId} has no stored Worker report; the final check runs without it`);
        continue;
      }
      const report = parseStoredJsonObject(row.payload_json, "report", task.id);
      // Legacy Core routing fields are not part of the Worker report that a
      // later Manager should summarize.
      const { verdict: _verdict, retry_subtasks: _retrySubtasks, ...workerReport } = report;
      reports.push({ task_id: task.id, ...workerReport });
    }
    // Outputs stay out of the final check; the Manager needs only what passed.
    const workVerificationContext: JsonObject = {
      status: workBranchVerification.status,
      reason: workBranchVerification.reason,
      work_commit: workBranchVerification.work_commit,
      commands: workBranchVerification.commands.map((command) => ({ command_id: command.command_id, passed: command.passed, exit_code: command.exit_code })),
      failed_command_id: workBranchVerification.failed_command_id,
    };
    let failure: AgentRunResult | null = null;
    for (let attempt = 1; attempt <= FINAL_MANAGER_MAX_ATTEMPTS; attempt += 1) {
      // The shipped agent-runtime exposes `finalize` on its role-level
      // Manager request. Keep the Core context mode alongside that request.
      const roleRequest = {
        invocation_id: createUlid(),
        work_id: workId,
        task_id: null,
        attempt,
        work,
        tasks: managerTasks,
        reports,
        notes: [],
        trigger: { kind: "final_check" } as const,
        mode: "finalize" as const,
        memory_mode: "pages" as const,
        context: { mode: "finalize", trigger: { kind: "final_check" }, work_id: workId, tasks: managerTasks, reports, work_verification: workVerificationContext, design_documents: this.completedDesignDocuments(workId), backlog_items: listInProgressBacklogItemsOfWork(this.db, workId).map(({ id, file, line, problem, suggestion }) => ({ id, file, line, problem, suggestion })), ...this.processSkillsRequestContext() },
      };
      const outcome = await this.attemptFinalManager(workId, roleRequest);
      if (outcome === null) return null;
      if ("verdict" in outcome) return outcome;
      failure = outcome.failure;
      const retryable = failure.failure_class === "transient" || failure.retry_allowed === true;
      if (!retryable || attempt === FINAL_MANAGER_MAX_ATTEMPTS) break;
      console.warn(`[owl-core] Final Manager attempt ${attempt} for Work ${workId} failed (${failure.error_key ?? failure.outcome}); retrying.`);
      await delay(this.options.dispatcher?.manager_retry_delay_ms ?? INITIAL_PLAN_RETRY_DELAY_MS);
      if (!this.started) return null;
    }
    const cause = failure?.message && failure.message.length > 0 ? failure.message : `outcome=${failure?.outcome ?? "failed"}`;
    throw new HumanReadableError({
      code: "final_manager_failed",
      message: cause,
      remediation: "Retry the final check, or cancel the Work.",
      details: { work_id: workId, error_key: failure?.error_key ?? null },
    });
  }

  /** One Final Manager call: a verdict, a failure result, or null when Core stopped. */
  private async attemptFinalManager(
    workId: string,
    request: JsonObject,
  ): Promise<{ readonly verdict: FinalManagerVerdict; readonly agent_run_id: string } | { readonly failure: AgentRunResult } | null> {
    let raw: unknown;
    try {
      raw = await this.invokeManagerPlan(request, "manager.finalize");
    } catch (error) {
      if (!this.started) return null;
      // The role-shaped runner path throws its runtime error unchanged.
      return { failure: finalManagerErrorResult(error, ownerLanguage(this.db)) };
    }
    if (!this.started) return null;
    if (raw === null) return null;
    try {
      const result = normalizeManagerResult(raw, "finalize");
      if (result.failure_class === "rate_limited") return null;
      const agentRunId = typeof request.invocation_id === "string" ? request.invocation_id : "";
      this.recordSkillFeedback(agentRunId, result.skill_feedback);
      if (result.outcome !== "success") return { failure: result };
      const report = requireManagerReport(result, "manager finalization");
      return { verdict: requireManagerVerdict(report.verdict, workId), agent_run_id: agentRunId };
    } catch (error) {
      return { failure: finalManagerErrorResult(error, ownerLanguage(this.db)) };
    }
  }

  private recordSkillFeedback(agentRunId: string, feedback: AgentRunResult["skill_feedback"]): void {
    if (!feedback) return;
    try {
      void this.skillBox.recordFeedback(agentRunId, feedback).catch((error) => {
        console.warn(`[owl-core] Could not record Manager skill feedback for Agent run ${agentRunId}`, error);
      });
    } catch (error) {
      console.warn(`[owl-core] Could not record Manager skill feedback for Agent run ${agentRunId}`, error);
    }
  }

  private taskDependencyIds(taskId: string): string[] {
    return this.db.all<{ depends_on_task_id: string }>(
      "SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id ASC",
      taskId,
    ).map((dependency) => dependency.depends_on_task_id);
  }

  /**
   * The system.alert a Core Decision was opened for: the Work's latest alert
   * written no later than the Decision itself. null for other Decisions.
   */
  private decisionSourceAlert(decisionId: string): JsonObject | null {
    const row = this.db.get<{ payload_json: string }>(
      `SELECT events.payload_json AS payload_json
         FROM decisions JOIN events ON events.work_id = decisions.work_id
        WHERE decisions.id = ? AND decisions.issuer_role = 'core' AND decisions.scope = 'work'
          AND events.type = 'system.alert' AND events.created_at <= decisions.created_at
        ORDER BY events.sequence DESC LIMIT 1`,
      decisionId,
    );
    if (!row) return null;
    try {
      const payload = JSON.parse(row.payload_json) as unknown;
      return isRecord(payload) ? (payload as JsonObject) : null;
    } catch {
      // Why not log: this runs on every context build, and an unreadable payload reads the same as none; the event row stays for inspection.
      return null;
    }
  }

  /** Latest system.alert payload of the Work (what halted it last), or null. */
  private latestSystemAlert(workId: string): JsonObject | null {
    const row = this.db.get<{ payload_json: string }>(
      `SELECT payload_json FROM events
        WHERE work_id = ? AND type = 'system.alert'
        ORDER BY sequence DESC LIMIT 1`,
      workId,
    );
    if (!row) return null;
    try {
      const payload = JSON.parse(row.payload_json) as unknown;
      return isRecord(payload) ? (payload as JsonObject) : null;
    } catch {
      // Why not log: this runs on every context build, and an unreadable payload reads the same as none; the event row stays for inspection.
      return null;
    }
  }

  private managerWorkContext(workId: string): JsonObject {
    const work = this.db.get<Omit<WorkDbRow, "display_number"> & { advisor_backlog_json: string | null }>(
      `SELECT id, title, state, state_version, updated_at, archived_at, owner_id, project_id,
              summary, size, design_mode, plan_revision, advisor_backlog_json
         FROM works WHERE id = ?`,
      workId,
    );
    if (!work) {
      throw notFound("work", workId);
    }
    return {
      advisor_backlog: work.advisor_backlog_json === null ? null : (JSON.parse(work.advisor_backlog_json) as JsonObject),
      id: work.id,
      work_id: work.id,
      title: work.title,
      summary: work.summary,
      owner_id: work.owner_id,
      project_id: work.project_id,
      size: work.size,
      design_mode: work.design_mode,
      state: work.state,
      plan_revision: work.plan_revision,
      owner_guidance: ownerGuidance(this.db, workId),
    };
  }

  /** True when the Task failed only because a dependency failed (Task row 27). */
  private isCascadedFailure(taskId: string): boolean {
    const row = this.db.get<{ failed_by_dependency_task_id: string | null }>(
      "SELECT failed_by_dependency_task_id FROM tasks WHERE id = ?",
      taskId,
    );
    return row !== undefined && row.failed_by_dependency_task_id !== null;
  }

  /**
   * Compact view of every Task in the Work, keyed by the ids a Manager plan
   * may reference. failed_by_dependency marks a failure that is only the
   * consequence of a failed dependency.
   */
  private planOverview(workId: string): JsonObject[] {
    const rows = this.db.all<TaskRow>(
      "SELECT * FROM tasks WHERE work_id = ? ORDER BY created_at ASC, id ASC",
      workId,
    );
    return rows.map((row) => ({
      id: row.id,
      manager_task_id: row.manager_task_id,
      title: row.title,
      status: row.status,
      failed_by_dependency: row.failed_by_dependency_task_id !== null,
      ...storedVerificationSpec(row),
      depends_on: this.db.all<{ depends_on_task_id: string }>(
        "SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id ASC",
        row.id,
      ).map((dependency) => dependency.depends_on_task_id),
    }));
  }

  /** The role's Rule Store lines plus the Work's rules, one per line; null when there are none. */
  private composeRulesForRole(role: RuleRole, workId: string): string | null {
    const row = this.db.get<{ rules_json: string | null }>(
      "SELECT rules_json FROM works WHERE id = ?",
      workId,
    );
    const lines = this.ruleStore.getInstructionsForRole(role, parseWorkRules(row?.rules_json, workId));
    return lines.length === 0 ? null : lines.join("\n");
  }

  /** Read at every call. `memory_mode` is always `pages`: a `legacy` value saved by an older build is read as `pages`. */
  private memorySettings(): { mode: MemoryMode; folder_kinds: MemoryFolderKinds; memory_librarian: MemoryLibrarian; memory_librarian_batch: MemoryLibrarianBatch } {
    const read = (key: string): unknown => {
      try {
        const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", key);
        return row ? (JSON.parse(row.value_json) as unknown) : undefined;
      } catch (error) {
        console.warn(`[owl-core] Could not read ${key}; using defaults`, error);
        return undefined;
      }
    };
    return {
      mode: readMemoryMode(read(MEMORY_MODE_SETTINGS_KEY)),
      folder_kinds: readMemoryFolderKinds(read(MEMORY_FOLDER_KINDS_SETTINGS_KEY), (message) => console.warn(`[owl-core] ${message}`)),
      memory_librarian: readMemoryLibrarian(read(MEMORY_LIBRARIAN_SETTINGS_KEY), (message) => console.warn(`[owl-core] ${message}`)),
      memory_librarian_batch: readMemoryLibrarianBatch(read(MEMORY_LIBRARIAN_BATCH_SETTINGS_KEY), (message) => console.warn(`[owl-core] ${message}`)),
    };
  }

  /** Read at every recall: `memory_recall_limit` (1–3) and `memory_recall_min_similarity` (0–1); invalid values give the defaults. */
  private memoryRecallSettings(): { limit: number; min_similarity: number } {
    const read = (key: string): unknown => {
      try {
        const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", key);
        return row ? (JSON.parse(row.value_json) as unknown) : undefined;
      } catch (error) {
        console.warn(`[owl-core] Could not read ${key}; using defaults`, error);
        return undefined;
      }
    };
    const warn = (message: string): void => console.warn(`[owl-core] ${message}`);
    return {
      limit: readMemoryRecallLimit(read(MEMORY_RECALL_LIMIT_SETTINGS_KEY), warn),
      min_similarity: readMemoryRecallMinSimilarity(read(MEMORY_RECALL_MIN_SIMILARITY_SETTINGS_KEY), warn),
    };
  }

  /** Newest `updated_at` day (`YYYY-MM-DD`) among the Works numbered `numbers` (a project's own, or any project's when `projectId` is null); null when none exist. */
  private sourceWorksUpdated(projectId: string | null, numbers: readonly number[]): string | null {
    if (numbers.length === 0) return null;
    const marks = numbers.map(() => "?").join(", ");
    const row = projectId
      ? this.db.get<{ day: string | null }>(`SELECT MAX(substr(updated_at, 1, 10)) AS day FROM works WHERE project_id = ? AND display_number IN (${marks})`, projectId, ...numbers)
      : this.db.get<{ day: string | null }>(`SELECT MAX(substr(updated_at, 1, 10)) AS day FROM works WHERE display_number IN (${marks})`, ...numbers);
    return row?.day ?? null;
  }

  /** Whether a repository path is gone from the Project's configured repository ("unavailable" when it cannot be told). */
  private repoPathMissing(projectId: string | null, path: string): "missing" | "exists" | "unavailable" {
    const repo = projectId ? this.db.get<{ canonical_path: string | null }>("SELECT canonical_path FROM projects WHERE id = ?", projectId)?.canonical_path : null;
    if (!repo || isAbsolute(path) || path.split(/[\\/]/u).includes("..") || !existsSync(repo)) return "unavailable";
    return existsSync(join(repo, path)) ? "exists" : "missing";
  }

  /** `memory_dormant_days` setting; a missing or non-positive value gives the 90-day default. */
  private memoryDormantDays(): number | undefined {
    try {
      const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", "memory_dormant_days");
      const days = row ? Number(JSON.parse(row.value_json)) : NaN;
      return Number.isFinite(days) && days > 0 ? days : undefined;
    } catch (error) {
      console.warn("[owl-core] Could not read memory_dormant_days; using the default", error);
      return undefined;
    }
  }

  /** `memory_read_limits` merged over the defaults per role; anything malformed falls back to them. */
  private memoryReadLimits(): MemoryReadLimits {
    try {
      const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", "memory_read_limits");
      const stored = row ? (JSON.parse(row.value_json) as Record<string, Partial<RoleReadLimit>>) : {};
      const merged = { ...DEFAULT_MEMORY_READ_LIMITS } as Record<string, RoleReadLimit>;
      for (const [role, base] of Object.entries(DEFAULT_MEMORY_READ_LIMITS)) {
        const entry = stored?.[role];
        if (entry && typeof entry === "object") {
          const pick = (key: keyof RoleReadLimit): number => (Number.isInteger(entry[key]) && (entry[key] as number) >= 0 ? (entry[key] as number) : base[key]);
          merged[role] = { pages: pick("pages"), page_tokens: pick("page_tokens"), searches: pick("searches"), clippings: pick("clippings") };
        }
      }
      return merged as unknown as MemoryReadLimits;
    } catch (error) {
      console.warn("[owl-core] Could not read memory_read_limits; using defaults", error);
      return DEFAULT_MEMORY_READ_LIMITS;
    }
  }

  public async getMemorySettings(): Promise<{ mode: MemoryMode; folder_kinds: MemoryFolderKinds; memory_librarian: MemoryLibrarian }> {
    return this.memorySettings();
  }

  /** Owner-only. Model for the migration LLM calls; read again at every migration request. */
  public async setMemoryLibrarian(input: unknown): Promise<{ mode: MemoryMode; folder_kinds: MemoryFolderKinds; memory_librarian: MemoryLibrarian }> {
    let normalized: MemoryLibrarian;
    try {
      normalized = validateMemoryLibrarian(input);
    } catch (error) {
      if (error instanceof MemorySettingsValidationError) throw validationError(error.message, { field: "memory_librarian" });
      throw error;
    }
    await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        ensureOwner(transaction, DEFAULT_OWNER_ID, now);
        transaction.run(
          `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
           VALUES (?, ?, '1.0.0', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          MEMORY_LIBRARIAN_SETTINGS_KEY,
          DEFAULT_OWNER_ID,
          JSON.stringify(normalized),
          now,
        );
        return normalized;
      },
      event: {
        idempotencyKey: `settings-memory-librarian:${createUlid()}`,
        type: "settings.memory_librarian_updated",
        payload: { provider: normalized.provider, model: normalized.model, effort: normalized.effort },
      },
      outbox: [{ provider: "websocket" }],
    });
    return this.memorySettings();
  }

  /** Owner-only. `memory_mode` is not written here. */
  public async setMemoryFolderKinds(input: unknown): Promise<{ mode: MemoryMode; folder_kinds: MemoryFolderKinds; memory_librarian: MemoryLibrarian }> {
    let normalized: MemoryFolderKinds;
    try {
      normalized = validateMemoryFolderKinds(input);
    } catch (error) {
      if (error instanceof MemorySettingsValidationError) throw validationError(error.message, { field: "folder_kinds" });
      throw error;
    }
    await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        ensureOwner(transaction, DEFAULT_OWNER_ID, now);
        transaction.run(
          `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
           VALUES (?, ?, '1.0.0', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          MEMORY_FOLDER_KINDS_SETTINGS_KEY,
          DEFAULT_OWNER_ID,
          JSON.stringify(normalized),
          now,
        );
        return normalized;
      },
      event: {
        idempotencyKey: `settings-memory-folder-kinds:${createUlid()}`,
        type: "settings.memory_folder_kinds_updated",
        payload: { rules: normalized.rules.length },
      },
      outbox: [{ provider: "websocket" }],
    });
    this.memory.notifyChanged();
    return this.memorySettings();
  }

  private readKnowledgeAutomationSettings(): KnowledgeAutomationSettings {
    try {
      const row = this.db.get<{ value_json: string }>(
        "SELECT value_json FROM settings WHERE key = ?",
        KNOWLEDGE_AUTOMATION_SETTINGS_KEY,
      );
      if (!row) return DEFAULT_KNOWLEDGE_AUTOMATION_SETTINGS;
      return parseKnowledgeAutomationSettings(JSON.parse(row.value_json) as unknown, (message) => {
        console.warn(`[owl-core] ${message}`);
      });
    } catch (error) {
      console.warn("[owl-core] Could not read knowledge automation settings; using defaults", error);
      return DEFAULT_KNOWLEDGE_AUTOMATION_SETTINGS;
    }
  }

  private readPlanUsageSettings(): PlanUsageSettings {
    try {
      const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", PLAN_USAGE_SETTINGS_KEY);
      if (!row) return DEFAULT_PLAN_USAGE_SETTINGS;
      return readPlanUsageSettings(JSON.parse(row.value_json) as unknown, (message) => {
        console.warn(`[owl-core] ${message}`);
      });
    } catch (error) {
      console.warn("[owl-core] Could not read plan usage settings; using defaults.", error);
      return DEFAULT_PLAN_USAGE_SETTINGS;
    }
  }

  public async getPlanUsageSettings(): Promise<PlanUsageSettings> {
    return this.readPlanUsageSettings();
  }

  public async setPlanUsageSettings(input: PlanUsageSettings): Promise<PlanUsageSettings> {
    let normalized: PlanUsageSettings;
    try {
      normalized = validatePlanUsageSettings(input);
    } catch (error) {
      if (error instanceof PlanUsageSettingsValidationError) {
        throw validationError(error.message, { field: error.field });
      }
      throw error;
    }
    await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        ensureOwner(transaction, DEFAULT_OWNER_ID, now);
        transaction.run(
          `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
           VALUES (?, ?, '1.0.0', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          PLAN_USAGE_SETTINGS_KEY,
          DEFAULT_OWNER_ID,
          JSON.stringify(normalized),
          now,
        );
        return normalized;
      },
      event: {
        idempotencyKey: `settings-plan-usage:${createUlid()}`,
        type: "settings.plan_usage_updated",
        payload: normalized,
      },
      outbox: [{ provider: "websocket" }],
    });
    this.planUsageService.reschedule();
    return this.readPlanUsageSettings();
  }

  public async getReviewMetrics(): Promise<ReviewMetrics> {
    return reviewMetrics(this.db);
  }

  public async getReviewLimitSettings(): Promise<ReviewLimitSettings> {
    return reviewLimits(this.db);
  }

  public async setReviewLimitSettings(input: ReviewLimitSettings): Promise<ReviewLimitSettings> {
    let normalized: ReviewLimitSettings;
    try {
      normalized = validateReviewLimitSettings(input);
    } catch (error) {
      if (error instanceof ReviewLimitSettingsValidationError) {
        throw validationError(error.message, { field: error.field });
      }
      throw error;
    }
    await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        ensureOwner(transaction, DEFAULT_OWNER_ID, now);
        transaction.run(
          `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
           VALUES (?, ?, '1.0.0', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          REVIEW_LIMIT_SETTINGS_KEY,
          DEFAULT_OWNER_ID,
          JSON.stringify(normalized),
          now,
        );
        return normalized;
      },
      event: {
        idempotencyKey: `settings-review-limits:${createUlid()}`,
        type: "settings.review_limits_updated",
        payload: normalized,
      },
      outbox: [{ provider: "websocket" }],
    });
    return reviewLimits(this.db);
  }

  public async getDependencySummarySettings(): Promise<DependencySummarySettings> {
    return dependencySummarySettings(this.db);
  }

  public async setDependencySummarySettings(input: DependencySummarySettings): Promise<DependencySummarySettings> {
    let normalized: DependencySummarySettings;
    try {
      normalized = validateDependencySummarySettings(input);
    } catch (error) {
      if (error instanceof DependencySummarySettingsValidationError) {
        throw validationError(error.message, { field: error.field });
      }
      throw error;
    }
    await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        ensureOwner(transaction, DEFAULT_OWNER_ID, now);
        transaction.run(
          `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
           VALUES (?, ?, '1.0.0', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          DEPENDENCY_SUMMARY_SETTINGS_KEY,
          DEFAULT_OWNER_ID,
          JSON.stringify(normalized),
          now,
        );
        return normalized;
      },
      event: {
        idempotencyKey: `settings-dependency-summary:${createUlid()}`,
        type: "settings.dependency_summary_updated",
        payload: normalized,
      },
      outbox: [{ provider: "websocket" }],
    });
    return dependencySummarySettings(this.db);
  }

  public async getProgressGuardSettings(): Promise<ProgressGuardSettings> {
    return progressGuard(this.db);
  }

  public async setProgressGuardSettings(input: ProgressGuardSettings): Promise<ProgressGuardSettings> {
    let normalized: ProgressGuardSettings;
    try {
      normalized = validateProgressGuardSettings(input);
    } catch (error) {
      if (error instanceof ProgressGuardSettingsValidationError) {
        throw validationError(error.message, { field: error.field });
      }
      throw error;
    }
    await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        ensureOwner(transaction, DEFAULT_OWNER_ID, now);
        transaction.run(
          `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
           VALUES (?, ?, '1.0.0', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          PROGRESS_GUARD_SETTINGS_KEY,
          DEFAULT_OWNER_ID,
          JSON.stringify(normalized),
          now,
        );
        return normalized;
      },
      event: {
        idempotencyKey: `settings-progress-guard:${createUlid()}`,
        type: "settings.progress_guard_updated",
        payload: normalized as unknown as JsonObject,
      },
      outbox: [{ provider: "websocket" }],
    });
    return progressGuard(this.db);
  }

  public async getRemakeLimitSettings(): Promise<RemakeLimitSettings> {
    return remakeLimits(this.db);
  }

  public async setRemakeLimitSettings(input: RemakeLimitSettings): Promise<RemakeLimitSettings> {
    let normalized: RemakeLimitSettings;
    try {
      normalized = validateRemakeLimitSettings(input);
    } catch (error) {
      if (error instanceof RemakeLimitSettingsValidationError) {
        throw validationError(error.message, { field: error.field });
      }
      throw error;
    }
    await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        ensureOwner(transaction, DEFAULT_OWNER_ID, now);
        transaction.run(
          `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
           VALUES (?, ?, '1.0.0', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          REMAKE_LIMIT_SETTINGS_KEY,
          DEFAULT_OWNER_ID,
          JSON.stringify(normalized),
          now,
        );
        return normalized;
      },
      event: {
        idempotencyKey: `settings-remake-limits:${createUlid()}`,
        type: "settings.remake_limits_updated",
        payload: normalized as unknown as JsonObject,
      },
      outbox: [{ provider: "websocket" }],
    });
    return remakeLimits(this.db);
  }

  public async getPlanQualitySettings(): Promise<PlanQualitySettings> {
    return planQualitySettings(this.db);
  }

  public async setPlanQualitySettings(input: PlanQualitySettings): Promise<PlanQualitySettings> {
    let normalized: PlanQualitySettings;
    try {
      normalized = validatePlanQualitySettings(input);
    } catch (error) {
      if (error instanceof PlanQualitySettingsValidationError) {
        throw validationError(error.message, { field: error.field });
      }
      throw error;
    }
    await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        ensureOwner(transaction, DEFAULT_OWNER_ID, now);
        transaction.run(
          `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
           VALUES (?, ?, '1.0.0', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          PLAN_QUALITY_SETTINGS_KEY,
          DEFAULT_OWNER_ID,
          JSON.stringify(normalized),
          now,
        );
        return normalized;
      },
      event: {
        idempotencyKey: `settings-plan-quality:${createUlid()}`,
        type: "settings.plan_quality_updated",
        payload: normalized,
      },
      outbox: [{ provider: "websocket" }],
    });
    return planQualitySettings(this.db);
  }

  public async getReviewRoutingSettings(): Promise<ReviewRoutingSettings> {
    return reviewRouting(this.db);
  }

  public async setReviewRoutingSettings(input: ReviewRoutingSettings): Promise<ReviewRoutingSettings> {
    let normalized: ReviewRoutingSettings;
    try {
      normalized = validateReviewRoutingSettings(input);
    } catch (error) {
      if (error instanceof ReviewRoutingSettingsValidationError) {
        throw validationError(error.message, { field: error.field });
      }
      throw error;
    }
    await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        ensureOwner(transaction, DEFAULT_OWNER_ID, now);
        transaction.run(
          `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
           VALUES (?, ?, '1.0.0', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          REVIEW_ROUTING_SETTINGS_KEY,
          DEFAULT_OWNER_ID,
          JSON.stringify(normalized),
          now,
        );
        return normalized;
      },
      event: {
        idempotencyKey: `settings-review-routing:${createUlid()}`,
        type: "settings.review_routing_updated",
        payload: normalized as unknown as JsonObject,
      },
      outbox: [{ provider: "websocket" }],
    });
    return reviewRouting(this.db);
  }

  public async getPlanUsage(): Promise<PlanUsageView> {
    return this.planUsageService.view();
  }

  public async refreshPlanUsage(): Promise<PlanUsageView> {
    return this.planUsageService.refresh();
  }

  public async getKnowledgeAutomationSettings(): Promise<KnowledgeAutomationSnapshot> {
    const settings = this.readKnowledgeAutomationSettings();
    let timeZone = "local";
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
    } catch {
      // Some runtimes do not expose an IANA time zone.
    }
    return {
      ...settings,
      next_librarian_run_at: this.librarianScheduler.nextRunAt()?.toISOString() ?? null,
      time_zone: timeZone,
    };
  }

  public async setKnowledgeAutomationSettings(input: KnowledgeAutomationSettings): Promise<KnowledgeAutomationSnapshot> {
    let normalized: KnowledgeAutomationSettings;
    try {
      normalized = validateKnowledgeAutomationSettings(input);
    } catch (error) {
      if (error instanceof KnowledgeAutomationValidationError) {
        throw validationError(error.message, { field: error.field });
      }
      throw error;
    }

    await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        ensureOwner(transaction, DEFAULT_OWNER_ID, now);
        transaction.run(
          `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
           VALUES (?, ?, '1.0.0', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          KNOWLEDGE_AUTOMATION_SETTINGS_KEY,
          DEFAULT_OWNER_ID,
          JSON.stringify(normalized),
          now,
        );
        return normalized;
      },
      event: {
        idempotencyKey: `settings-knowledge-automation:${createUlid()}`,
        type: "settings.knowledge_automation_updated",
        payload: {
          librarian_times: [...normalized.librarian_times],
          research_autosave: normalized.research_autosave,
          research_source_links: normalized.research_source_links,
            research_source_links_max: normalized.research_source_links_max,
        },
      },
      outbox: [{ provider: "websocket" }],
    });
    this.librarianScheduler.reschedule(normalized.librarian_times);
    return this.getKnowledgeAutomationSettings();
  }

  private readNightlyTestTime(): string {
    const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", NIGHTLY_TEST_SETTINGS_KEY);
    try {
      const time: unknown = row ? (JSON.parse(row.value_json) as { time?: unknown }).time : undefined;
      if (typeof time === "string" && parseLibrarianTime(time) !== null) return time;
    } catch {
      // fall through to the default
    }
    return DEFAULT_NIGHTLY_TEST_TIME;
  }

  public async getNightlyTestSettings(): Promise<{ time: string; next_run_at: string | null }> {
    return { time: this.readNightlyTestTime(), next_run_at: this.nightlyScheduler.nextRunAt()?.toISOString() ?? null };
  }

  public async updateNightlyTestSettings(input: { time: string }): Promise<{ time: string; next_run_at: string | null }> {
    if (typeof input?.time !== "string" || parseLibrarianTime(input.time) === null) {
      throw validationError("time must be HH:MM", { field: "time" });
    }
    const time = input.time;
    await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        ensureOwner(transaction, DEFAULT_OWNER_ID, now);
        transaction.run(
          `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
           VALUES (?, ?, '1.0.0', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          NIGHTLY_TEST_SETTINGS_KEY,
          DEFAULT_OWNER_ID,
          JSON.stringify({ time }),
          now,
        );
      },
      event: { idempotencyKey: `settings-nightly-tests:${createUlid()}`, type: "settings.nightly_tests_updated", payload: { time } },
      outbox: [{ provider: "websocket" }],
    });
    this.nightlyScheduler.reschedule([time]);
    return this.getNightlyTestSettings();
  }

  /** Runs every Project's nightly test command once and backlogs the failures that were not in the previous run. */
  public runNightlyTests(): Promise<NightlyRunSummary[]> {
    this.nightlyRun ??= this.runNightlyTestsOnce().finally(() => {
      this.nightlyRun = null;
    });
    return this.nightlyRun;
  }

  private async runNightlyTestsOnce(): Promise<NightlyRunSummary[]> {
    const projects = this.db.all<{ id: string; name: string; canonical_path: string; base_branch: string; nightly_test_argv_json: string }>(
      "SELECT id, name, canonical_path, base_branch, nightly_test_argv_json FROM projects WHERE nightly_test_argv_json IS NOT NULL ORDER BY name, id",
    );
    const summaries: NightlyRunSummary[] = [];
    for (const row of projects) {
      if (this.nightlyAbort.signal.aborted) break;
      try {
        const argv: unknown = JSON.parse(row.nightly_test_argv_json);
        const startedAt = utcNow();
        let execution: NightlyExecution;
        if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== "string")) {
          execution = nightlyError("nightly_test_command is not a non-empty array of strings");
        } else {
          try {
            execution = await this.nightlyExecutor(
              { id: row.id, name: row.name, canonical_path: row.canonical_path, base_branch: row.base_branch, argv: argv as string[] },
              this.nightlyAbort.signal,
            );
          } catch (error) {
            execution = nightlyError(error instanceof Error ? error.message : String(error));
          }
        }
        if (this.nightlyAbort.signal.aborted) break;
        summaries.push(await this.recordNightlyRun(row, startedAt, execution));
      } catch (error) {
        // Why not stop: one Project's recording failure must not block the others; its result is absent from the summary, and the error is logged.
        console.warn(`[owl-core] Nightly test run failed for Project ${row.id}`, error);
      }
    }
    return summaries;
  }

  private async recordNightlyRun(project: { id: string; name: string }, startedAt: string, execution: NightlyExecution): Promise<NightlyRunSummary> {
    const runId = createUlid();
    const status = classifyNightlyRun(execution);
    const error = status === "error"
      ? execution.error ?? (execution.exit_code === null ? "The test command did not finish" : `The test command exited with code ${execution.exit_code} without reporting a failed test`)
      : null;
    const result = await this.writeLane.write({
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

  private async composeKnowledgeForWork(workId: string): Promise<string | null> {
    try {
      const work = this.db.get<{ title: string; summary: string; project_id: string | null; project_name: string | null }>(
        "SELECT w.title, w.summary, w.project_id, p.name AS project_name FROM works w LEFT JOIN projects p ON p.id = w.project_id WHERE w.id = ?",
        workId,
      );
      if (!work) return null;
      return await this.memoryInjector.compose({
        role: "manager",
        query: searchQuery("manager", { work_title: work.title, work_summary: work.summary, project_name: work.project_name }),
        recall_query: `${work.title}\n${work.summary}`,
        project_id: work.project_id,
      });
    } catch (error) {
      console.warn(`[owl-core] Could not compose knowledge for Work ${workId}`, error);
      return null;
    }
  }

  private async invokeManagerPlan(request: unknown, operation: string): Promise<unknown> {
    if (!this.started) return null;
    const { workId, taskId } = extractManagerRequestIds(request, operation);
    const requestInvocationId = isRecord(request) && typeof request.invocation_id === "string" && request.invocation_id.length > 0
      ? request.invocation_id
      : createUlid();
    const agentRunId = requestInvocationId;
    const managerRoleModel = resolveRoleModelFromDb(this.db, "manager");
    const managerProvider = managerRoleModel?.provider ?? "anthropic";
    if (this.providerPauseController.isPaused(managerProvider)) return null;
    // Resolved before the run is recorded: invalid Work rules fail the call
    // without leaving a running Manager row behind.
    const managerRules = this.composeRulesForRole("manager", workId);
    const managerSkills = this.workflow.composeSkillsForWork(workId);
    const managerKnowledge = await this.composeKnowledgeForWork(workId);
    await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        const now = utcNow();
        transaction.run(
          `INSERT INTO agent_runs
             (id, work_id, task_id, role, provider, model, effort, status, started_at, created_at, updated_at)
           VALUES (?, ?, ?, 'manager', ?, ?, ?, 'running', ?, ?, ?)`,
          agentRunId,
          workId,
          taskId,
          managerRoleModel?.provider ?? "anthropic",
          managerRoleModel?.model ?? DEFAULT_HARNESS_MODELS.claude,
          managerRoleModel?.effort ?? null,
          now,
          now,
          now,
        );
        return { agent_run_id: agentRunId };
      },
      event: {
        idempotencyKey: `manager-started:${agentRunId}`,
        type: "manager.started",
        workId,
        taskId,
        agentRunId,
        payload: { work_id: workId, task_id: taskId, agent_run_id: agentRunId, operation },
      },
      outbox: [{ provider: "websocket" }],
    });
    if (!this.started) return null;
    const managerProjectId = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId)?.project_id;
    const requestWithRules = {
      ...(addManagerRules(request, managerRules, managerSkills, managerKnowledge) as Record<string, unknown>),
      language: ownerLanguage(this.db),
      ...(managerProjectId ? { project_id: managerProjectId } : {}),
    };
    const enrichedRequest = managerRoleModel
      ? {
          ...requestWithRules,
          model: managerRoleModel.model,
          provider: managerRoleModel.provider,
          effort: managerRoleModel.effort,
        }
      : requestWithRules;
    let result: unknown;
    try {
      const runner = this.options.agentRunner.runManagerPlan as unknown as (input: unknown) => Promise<unknown>;
      // A thrown rate limit takes the same pause path as a returned one.
      result = await runner.call(this.options.agentRunner, enrichedRequest).catch(rethrowUnlessRateLimited);
    } catch (error) {
      if (!this.started) return null;
      await this.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) => {
          const now = utcNow();
          transaction.run(
            `UPDATE agent_runs SET status = 'failed', ended_at = ?, updated_at = ? WHERE id = ?`,
            now,
            now,
            agentRunId,
          );
          return { agent_run_id: agentRunId };
        },
        event: {
          idempotencyKey: `manager-failed:${agentRunId}`,
          type: "manager.failed",
          workId,
          taskId,
          agentRunId,
          payload: {
            work_id: workId,
            task_id: taskId,
            agent_run_id: agentRunId,
            operation,
            reason: formatRuntimeFailure(error, "Manager", ownerLanguage(this.db)),
            ...(isRecord(error) && error.outcome === "failed_after_side_effect" ? sideEffectFailureFields(SIDE_EFFECT_FAILURE_PREFIX) : {}),
          },
        },
        outbox: [{ provider: "websocket" }],
      });
      throw humanizeUnexpected(error, operation);
    }
    if (!this.started) return result;
    if (isRateLimitedAgentRunResult(result)) {
      const pause = await this.providerPauseController.recordRateLimit({
        provider: managerProvider,
        resets_at: result.rate_limit?.resets_at ?? null,
        role: "manager",
        work_id: workId,
        task_id: taskId,
        last_error_key: result.error_key ?? "rate_limited",
        last_error: result.message ?? null,
      });
      const usageJsonValue = isRecord(result) ? usageJson(result.usage) : null;
      const payload = {
        work_id: workId,
        task_id: taskId,
        agent_run_id: agentRunId,
        operation,
        provider: pause.provider,
        resume_at: pause.resume_at,
      };
      await this.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) => {
          const now = utcNow();
          transaction.run(
            "UPDATE agent_runs SET status = 'exited', ended_at = ?, updated_at = ?, usage_json = COALESCE(?, usage_json) WHERE id = ?",
            now, now, usageJsonValue, agentRunId,
          );
          return { agent_run_id: agentRunId, status: "exited" };
        },
        event: {
          idempotencyKey: `manager-rate-limited:${agentRunId}`,
          type: "manager.rate_limited",
          workId,
          taskId,
          agentRunId,
          payload,
        },
        outbox: [{ provider: "websocket" }],
      });
      return result;
    }
    if (isRecord(result) && result.outcome === "success") {
      const run = this.db.get<{ provider: string; started_at: string | null; created_at: string }>(
        "SELECT provider, started_at, created_at FROM agent_runs WHERE id = ?", agentRunId,
      );
      if (run) await this.providerPauseController.noteProviderSucceeded(run.provider, run.started_at ?? run.created_at);
    }
    if (operation !== "manager.finalize") {
      const feedback = isRecord(result) ? result.skill_feedback as AgentRunResult["skill_feedback"] | undefined : undefined;
      this.recordSkillFeedback(agentRunId, feedback ?? null);
    }
    // The tokens this Manager call spent, stored with its final status.
    const usage = isRecord(result) ? usageJson(result.usage) : null;
    if (isRecord(result) && typeof result.outcome === "string" && result.outcome !== "success") {
      const failure = typeof result.message === "string" && result.message.length > 0 ? result.message : `outcome=${result.outcome}`;
      await this.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) => {
          const now = utcNow();
          transaction.run(
            `UPDATE agent_runs SET status = 'failed', ended_at = ?, updated_at = ?, usage_json = COALESCE(?, usage_json) WHERE id = ?`,
            now,
            now,
            usage,
            agentRunId,
          );
          return { agent_run_id: agentRunId };
        },
        event: {
          idempotencyKey: `manager-failed:${agentRunId}`,
          type: "manager.failed",
          workId,
          taskId,
          agentRunId,
          payload: { work_id: workId, task_id: taskId, agent_run_id: agentRunId, operation, reason: failure, ...sideEffectFailureFields(result.error_key) },
        },
        outbox: [{ provider: "websocket" }],
      });
      return result;
    }
    const workRules = extractManagerWorkRules(result);
    await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        const now = utcNow();
        transaction.run(
          `UPDATE agent_runs SET status = 'completed', outcome = 'success', ended_at = ?, updated_at = ?, usage_json = COALESCE(?, usage_json) WHERE id = ?`,
          now,
          now,
          usage,
          agentRunId,
        );
        if (workRules !== null) {
          transaction.run(
            `UPDATE works SET rules_json = ?, updated_at = ? WHERE id = ?`,
            JSON.stringify({ schema_version: "1.0.0", rules: workRules }),
            now,
            workId,
          );
        }
        return { agent_run_id: agentRunId };
      },
      event: {
        idempotencyKey: `manager-completed:${agentRunId}`,
        type: "manager.completed",
        workId,
        taskId,
        agentRunId,
        payload: { work_id: workId, task_id: taskId, agent_run_id: agentRunId, operation },
      },
      outbox: [{ provider: "websocket" }],
    });
    return result;
  }

  private commandScope<P extends JsonObject>(
    request: CommandRequest<P>,
    event: { type: string; workId?: string; taskId?: string; agentRunId?: string; resourceKey?: string },
  ): { scopedKey: string; requestHash: string } {
    const scopedKey = [
      event.type,
      event.workId ?? "-",
      event.taskId ?? "-",
      event.agentRunId ?? "-",
      event.resourceKey ?? "-",
      request.idempotency_key,
    ].join(":");
    const requestHash = hashRequest({
      operation: event.type,
      work_id: event.workId ?? null,
      task_id: event.taskId ?? null,
      agent_run_id: event.agentRunId ?? null,
      resource_key: event.resourceKey ?? null,
      expected_version: request.expected_version,
      payload: request.payload,
    });
    return { scopedKey, requestHash };
  }

  private async runCommand<P extends JsonObject, D extends JsonObject>(
    request: CommandRequest<P>,
    event: { id?: string; type: string; workId?: string; taskId?: string; agentRunId?: string; resourceKey?: string; payload: JsonObject },
    mutation: (transaction: CoreWriteLaneTransaction) => CommandMutation<D>,
  ): Promise<CommandResponse<D>> {
    const { scopedKey, requestHash } = this.commandScope(request, event);
    const cached = this.db.get<StoredIdempotencyRow>(
      "SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?",
      scopedKey,
    );
    if (cached) {
      if (cached.request_hash !== requestHash) {
        throw idempotencyConflict(scopedKey);
      }
      return parseCommandResponse<D>(cached.response_json, scopedKey);
    }
    try {
      const result = await this.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) => {
          const existing = transaction.get<StoredIdempotencyRow>(
            "SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?",
            scopedKey,
          );
          if (existing) {
            if (existing.request_hash !== requestHash) {
              throw idempotencyConflict(scopedKey);
            }
            throw new ReplayCommand(parseCommandResponse<D>(existing.response_json, scopedKey));
          }
          const mutationResult = mutation(transaction);
          const response: CommandResponse<D> = {
            request_id: request.request_id,
            data: mutationResult.data,
            version: mutationResult.version,
          };
          const now = utcNow();
          transaction.run(
            `INSERT INTO idempotency_keys
               (key, request_hash, response_json, status_code, created_at, expires_at)
             VALUES (?, ?, ?, 200, ?, ?)`,
            scopedKey,
            requestHash,
            JSON.stringify(response),
            now,
            new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          );
          return response;
        },
        event: {
          id: event.id ?? createUlid(),
          idempotencyKey: `command-event:${scopedKey}`,
          type: event.type,
          workId: event.workId ?? null,
          taskId: event.taskId ?? null,
          agentRunId: event.agentRunId ?? null,
          payload: event.payload,
        },
        outbox: [{ provider: "websocket" }],
      });
      const response = result.state;
      await this.dispatcher.replayPending();
      return response;
    } catch (error) {
      if (error instanceof ReplayCommand) {
        return error.response as CommandResponse<D>;
      }
      throw humanizeUnexpected(error, event.type);
    }
  }

  private async runConditionalWorkCommand<P extends JsonObject, D extends JsonObject>(
    request: CommandRequest<P>,
    event: { readonly type: string; readonly workId: string },
    mutation: (transaction: CoreWriteLaneTransaction) => {
      readonly data: D;
      readonly version: number;
      readonly events: readonly { readonly type: string; readonly payload: JsonObject; readonly createdAt: string }[];
    },
  ): Promise<CommandResponse<D>> {
    const scopedKey = [event.type, event.workId, "-", "-", "-", request.idempotency_key].join(":");
    const requestHash = hashRequest({
      operation: event.type,
      work_id: event.workId,
      task_id: null,
      agent_run_id: null,
      resource_key: null,
      expected_version: request.expected_version,
      payload: request.payload,
    });
    const cached = this.db.get<StoredIdempotencyRow>(
      "SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?",
      scopedKey,
    );
    if (cached) {
      if (cached.request_hash !== requestHash) throw idempotencyConflict(scopedKey);
      return parseCommandResponse<D>(cached.response_json, scopedKey);
    }

    try {
      const result = await this.writeLane.transact((transaction) => {
        const existing = transaction.get<StoredIdempotencyRow>(
          "SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?",
          scopedKey,
        );
        if (existing) {
          if (existing.request_hash !== requestHash) throw idempotencyConflict(scopedKey);
          throw new ReplayCommand(parseCommandResponse<D>(existing.response_json, scopedKey));
        }
        const changed = mutation(transaction);
        const response: CommandResponse<D> = {
          request_id: request.request_id,
          data: changed.data,
          version: changed.version,
        };
        changed.events.forEach((queuedEvent, index) => appendEventInTransaction(transaction, {
          type: queuedEvent.type,
          idempotencyKey: `command-event:${scopedKey}${index === 0 ? "" : `:${index}`}`,
          workId: event.workId,
          taskId: null,
          payload: queuedEvent.payload,
          now: queuedEvent.createdAt,
        }));
        const now = utcNow();
        transaction.run(
          `INSERT INTO idempotency_keys
             (key, request_hash, response_json, status_code, created_at, expires_at)
           VALUES (?, ?, ?, 200, ?, ?)`,
          scopedKey,
          requestHash,
          JSON.stringify(response),
          now,
          new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        );
        return { response, emittedEvents: changed.events.length > 0 };
      });
      if (result.emittedEvents) await this.dispatcher.replayPending();
      return result.response;
    } catch (error) {
      if (error instanceof ReplayCommand) return error.response as CommandResponse<D>;
      throw humanizeUnexpected(error, event.type);
    }
  }
}

export function createCore(options: CoreOptions): Core {
  return new Core(options);
}

function toWorkSummary(row: Omit<WorkDbRow, "owner_id" | "summary" | "size" | "plan_revision">): WorkSummary {
  return { id: row.id, display_number: row.display_number, title: row.title, state: row.state, state_version: row.state_version, updated_at: row.updated_at, archived_at: row.archived_at, project_id: row.project_id };
}

function toWorkDetail(row: WorkDetailDbRow): WorkDetail {
  const total_tasks = row.total_tasks;
  const completed_tasks = row.completed_tasks;
  const progress: WorkProgress = {
    total_tasks,
    completed_tasks,
    percent: total_tasks === 0 ? 0 : Math.round((completed_tasks / total_tasks) * 100),
  };
  return {
    ...toWorkSummary(row),
    owner_id: row.owner_id,
    summary: row.summary,
    size: row.size,
    design_mode: row.design_mode,
    plan_revision: row.plan_revision,
    progress,
    conversation_id: row.conversation_id,
    advisor_backlog: parseAdvisorBacklog(row.advisor_backlog_json),
  };
}

/** works.advisor_backlog_json as {linked, dismissed}; null when absent, unparsable or shaped differently. */
function parseAdvisorBacklog(json: string | null): WorkAdvisorBacklog | null {
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const validList = (list: unknown): boolean =>
    Array.isArray(list) &&
    list.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.id === "string" &&
        typeof entry.problem === "string" &&
        (entry.file === null || typeof entry.file === "string") &&
        (entry.line === null || Number.isInteger(entry.line)),
    );
  if (!isRecord(value) || !validList(value.linked) || !validList(value.dismissed)) return null;
  return value as WorkAdvisorBacklog;
}

function toTaskSummary(row: TaskDbRow): TaskSummary {
  return { id: row.id, work_id: row.work_id, title: row.title, status: row.status, type: row.type, state_version: row.state_version, updated_at: row.updated_at, created_at: row.created_at, depends_on: JSON.parse(row.depends_on_json) as string[], prerequisite: toPrerequisiteView(row), stop_reason: row.stop_reason };
}

function processTarget(condition: PrerequisiteSpec["conditions"][number]): string | null | undefined {
  if (condition.kind !== "process") return undefined;
  return condition.done_path ?? (condition.pid === null ? null : String(condition.pid));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function toPrerequisiteView(row: Pick<TaskDbRow, "prerequisite_json" | "prerequisite_since">): TaskPrerequisiteView | null {
  if (row.prerequisite_json === null) return null;
  const spec = JSON.parse(row.prerequisite_json) as PrerequisiteSpec;
  return {
    reason: spec.reason,
    source: spec.source,
    conditions: spec.conditions.map((condition) => ({
      kind: condition.kind,
      target: processTarget(condition) ?? (condition.kind === "task" ? condition.task_id : condition.kind === "work" ? condition.work_id : null),
      description: condition.description,
    })),
    deadline_at: spec.deadline_at,
    since: row.prerequisite_since,
  };
}

function toTaskDetail(row: TaskDbRow): TaskDetail {
  return {
    ...toTaskSummary(row),
    parent_task_id: row.parent_task_id,
    acceptance: row.acceptance,
    review_round: row.review_round,
    total_review_attempts: row.total_review_attempts,
    failure_count: row.failure_count,
    worker_generation: row.worker_generation,
  };
}

function toDecision(row: DecisionDbRow): Decision {
  const blocked = parseStringArray(row.blocked_task_ids_json, "blocked_task_ids", row.id, "Decision");
  const options = parseArray(row.options_json, "options", row.id, "Decision");
  return {
    id: row.id,
    work_id: row.work_id,
    scope: row.scope,
    status: row.status,
    reason: row.reason,
    question: row.question,
    current_state: row.current_state,
    tried: row.tried,
    options: options as Decision["options"],
    recommended: row.recommended,
    allow_free_text: row.allow_free_text === 1,
    blocked_task_ids: blocked,
    state_version: row.state_version,
    design_block: row.design_block_json ? (JSON.parse(row.design_block_json) as Decision["design_block"]) : null,
  };
}

function toAgentRun(row: AgentDbRow): AgentRun {
  return {
    id: row.id,
    work_id: row.work_id,
    task_id: row.task_id,
    role: row.role === "designer" && row.design_tier === "lead" ? "lead_designer" : row.role,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    status: row.status,
    outcome: row.outcome,
    pid: row.pid,
    started_at: row.started_at,
    ended_at: row.ended_at,
    last_output_at: row.last_output_at,
    parent_agent_id: row.parent_agent_id,
    phase: row.phase,
    subtask_count: row.subtask_count,
    label: row.label,
    origin: row.origin,
  };
}

/** What Core's test check does for this Project: explicit test_run first, else the saved or fresh detection (never written here). */
function projectTestRunStatus(row: Pick<ProjectDbRow, "canonical_path" | "test_run_json" | "test_run_detected_json">): TestRunStatus {
  const resolved = resolveTestRun({
    explicit_json: row.test_run_json,
    detected_json: row.test_run_detected_json,
    root: row.canonical_path,
    now: new Date().toISOString(),
  });
  const settings = resolved.enabled ? resolved.settings : null;
  const command = settings === null ? null : settings.mode === "whole" ? settings.whole_argv : settings.file_argv;
  return { enabled: resolved.enabled, reason: resolved.enabled ? null : resolved.reason, command, source: resolved.source };
}

function toProject(row: ProjectDbRow): Project {
  return {
    id: row.id,
    name: row.name,
    canonical_path: row.canonical_path,
    base_branch: row.base_branch,
    auto_push: row.auto_push === 1,
    worktree_setup_command: parseStringArray(row.worktree_prepare_argv_json, "worktree_setup_command", row.id, "Project"),
    worktree_refresh_command: parseStringArray(row.worktree_refresh_argv_json, "worktree_refresh_command", row.id, "Project"),
    post_merge_command: row.post_merge_argv_json === null ? null : parseStringArray(row.post_merge_argv_json, "post_merge_command", row.id, "Project"),
    post_merge_install_command: row.post_merge_install_argv_json === null ? null : parseStringArray(row.post_merge_install_argv_json, "post_merge_install_command", row.id, "Project"),
    required_test_command: row.required_test_argv_json === null ? null : parseStringArray(row.required_test_argv_json, "required_test_command", row.id, "Project"),
    test_run: row.test_run_json === null ? null : parseStoredJsonObject(row.test_run_json, "test_run", row.id),
    test_run_status: projectTestRunStatus(row),
    test_policy: readTestPolicy(row.test_policy_json),
    allowed_roots: parseStringArray(row.allowed_roots_json, "allowed_roots", row.id, "Project"),
    verification_plan: parseArray(row.verification_plan_json, "verification_plan", row.id, "Project") as unknown as readonly VerificationCommand[],
  };
}

const PROJECT_LOCKING_WORK_STATES_SQL = PROJECT_LOCKING_WORK_STATES.map(() => "?").join(", ");
const WORKSPACE_SWEEP_INTERVAL_MS = 10 * 60_000;
const AGENT_STOP_WAIT_MS = 10_000;
const AGENT_STOP_POLL_MS = 100;
const ACTIVE_AGENT_RUN_STATUSES_SQL = "'launch_pending', 'spawned', 'running', 'cancel_requested'";
const AGENT_LIVE_STATUSES = ["launch_pending", "spawned", "running", "cancel_requested"] as const;
/** Ended top-level runs the Agents page shows when the caller does not say. */
export const DEFAULT_AGENTS_VIEW_RECENT = 8;
/** Conversation messages the Work detail view returns when the caller does not say (same as the web client's request). */
export const DEFAULT_WORK_VIEW_CONVERSATION_LIMIT = 100;
const DECISION_COLUMNS = "id, work_id, scope, status, blocked_task_ids_json, reason, question, current_state, tried, options_json, recommended, allow_free_text, state_version, design_block_json";
const AGENT_IDLE_THRESHOLD_SECONDS = 1800;

function computeProjectImpact(
  reader: Pick<CoreDatabase, "get" | "all">,
  projectId: string,
): ProjectDeletionImpact | undefined {
  if (!reader.get<{ id: string }>("SELECT id FROM projects WHERE id = ?", projectId)) return undefined;
  const workCount = reader.get<{ count: number }>("SELECT COUNT(*) AS count FROM works WHERE project_id = ?", projectId)?.count ?? 0;
  const runningWorkCount = reader.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM works WHERE project_id = ? AND state IN (${PROJECT_LOCKING_WORK_STATES_SQL})`,
    projectId,
    ...PROJECT_LOCKING_WORK_STATES,
  )?.count ?? 0;
  const runningWorks = reader.all<ProjectRunningWork>(
    `SELECT id, display_number, title, state FROM works
      WHERE project_id = ? AND state IN (${PROJECT_LOCKING_WORK_STATES_SQL})
      ORDER BY display_number IS NULL, display_number, created_at, id LIMIT 20`,
    projectId,
    ...PROJECT_LOCKING_WORK_STATES,
  );
  const activeAgentCount = reader.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM agent_runs
       JOIN works ON works.id = agent_runs.work_id
      WHERE works.project_id = ? AND agent_runs.status IN (${ACTIVE_AGENT_RUN_STATUSES_SQL})`,
    projectId,
  )?.count ?? 0;
  const backlogItemCount = reader.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM backlog_items WHERE project_id = ?",
    projectId,
  )?.count ?? 0;
  const blockers: Array<ProjectDeletionImpact["blockers"][number]> = [];
  if (runningWorkCount > 0) blockers.push("running_works");
  if (activeAgentCount > 0) blockers.push("active_agents");
  return {
    project_id: projectId,
    work_count: workCount,
    running_work_count: runningWorkCount,
    active_agent_count: activeAgentCount,
    backlog_item_count: backlogItemCount,
    running_works: runningWorks,
    blockers,
    deletable: blockers.length === 0,
  };
}

function assertProjectUnlocked(
  reader: Pick<CoreDatabase, "get" | "all">,
  projectId: string,
  operation: "delete" | "path_change",
  language: OwnerLanguage,
): ProjectDeletionImpact {
  const impact = computeProjectImpact(reader, projectId);
  if (!impact) throw projectNotFound(projectId, language);
  if (impact.blockers.length > 0) throw projectHasRunningWorks(projectId, operation, impact, language);
  return impact;
}

type InstructionOutcome = "tasks_changed" | "no_change" | "decision_opened";

interface MessageMetadata {
  readonly kind: "instruction_reply";
  readonly in_reply_to: readonly string[];
  readonly outcome: InstructionOutcome;
  readonly plan_revision: number | null;
}

export interface InstructionStatus {
  readonly status: "queued" | "processing" | "answered";
  readonly outcome: InstructionOutcome | null;
  readonly reply_message_id: string | null;
}

export interface WorkConversationMessage extends Message {
  readonly received_at: string;
  readonly instruction: InstructionStatus | null;
  readonly in_reply_to: readonly string[];
}

export interface WorkConversation {
  readonly work_id: string;
  readonly conversation_id: string | null;
  readonly truncated: boolean;
  readonly messages: readonly WorkConversationMessage[];
}

/** Write the Manager's reply to Owner instruction messages; call inside the transaction that settles the replan marker. */
function insertInstructionReply(
  transaction: CoreWriteLaneTransaction,
  messageIds: readonly string[],
  outcome: InstructionOutcome,
  planRevision: number | null,
  body: string,
): void {
  if (messageIds.length === 0) return;
  const origin = transaction.get<{ conversation_id: string; account_id: string }>(
    "SELECT conversation_id, account_id FROM messages WHERE id = ?",
    messageIds[0],
  );
  if (!origin) return;
  const now = utcNow();
  const metadata: MessageMetadata = { kind: "instruction_reply", in_reply_to: messageIds, outcome, plan_revision: planRevision };
  transaction.run(
    `INSERT INTO messages
       (id, conversation_id, provider, account_id, source_message_id, body,
        attachment_ids_json, received_at, created_at, metadata_json)
     VALUES (?, ?, 'web', ?, ?, ?, '[]', ?, ?, ?)`,
    createUlid(), origin.conversation_id, origin.account_id, `manager:${createUlid()}`, body, now, now, JSON.stringify(metadata),
  );
}

function parseMessageMetadata(json: string | null | undefined): MessageMetadata | null {
  if (json == null) return null;
  try {
    const value = JSON.parse(json) as unknown;
    if (isRecord(value) && value.kind === "instruction_reply" && Array.isArray(value.in_reply_to)) return value as unknown as MessageMetadata;
  } catch {
    // The CHECK constraint rejects invalid JSON; anything else is treated as no metadata.
  }
  return null;
}

function toMessage(row: MessageDbRow): Message & { metadata?: MessageMetadata | null } {
  const sourceId = row.source_message_id ?? "";
  const message = {
    id: row.id,
    conversation_id: row.conversation_id,
    source: sourceId.startsWith("manager:") ? "manager" : sourceId.startsWith("advisor:") ? "advisor" : row.provider,
    body: row.body,
    attachment_ids: parseStringArray(row.attachment_ids_json, "attachment_ids", row.id, "Message"),
    created_at: row.created_at,
  };
  const metadata = parseMessageMetadata(row.metadata_json);
  return metadata ? { ...message, metadata } : message;
}

function formatConversationMessage(message: Message): string {
  const timestamp = new Date(message.created_at);
  const time = Number.isNaN(timestamp.getTime()) ? message.created_at : timestamp.toISOString().slice(11, 16);
  const role = message.source === "advisor" ? "Advisor" : message.source === "manager" ? "Manager" : "You";
  return `[${time}] ${role}:\n${message.body}`;
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/u, 1)[0].trim();
}

/** Rolls back a tick-failure alert whose Work left `running` before the write. */
class WorkNotRunningAbort extends Error {
  public state: string | undefined;
  public constructor() {
    super("The Work is no longer running.");
    this.name = "WorkNotRunningAbort";
  }
}

const DEFAULT_OWNER_ID = "owner:default";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const UPLOAD_EXPIRY_MS = 60 * 60 * 1000;
const MODEL_SETTINGS_KEY = "model_settings";
const MODEL_PRESETS_KEY = "model_presets";
const KNOWLEDGE_SETTINGS_KEY = "knowledge";
const LEGACY_EXECUTOR_CONFIG_SETTINGS_KEY = "executor_config";

function resolveRoleModelFromDb(db: CoreDatabase, role: string): { model: string; provider: string; effort?: string } | undefined {
  const row = db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", MODEL_SETTINGS_KEY);
  if (!row) {
    const fallback = DEFAULT_MODEL_SETTINGS.find((r) => r.role === role)
      ?? (role === "librarian" ? DEFAULT_MODEL_SETTINGS.find((r) => r.role === "advisor") : undefined);
    return fallback
      ? { model: fallback.model, provider: fallback.provider.trim().toLowerCase(), effort: fallback.effort }
      : undefined;
  }
  let parsed: { roles?: unknown };
  try {
    parsed = JSON.parse(row.value_json) as { roles?: unknown };
  } catch (error) {
    throw validationError("Stored model settings are not valid JSON.", {
      key: MODEL_SETTINGS_KEY,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.roles)) {
    throw validationError("Stored model settings must contain a roles array.", { key: MODEL_SETTINGS_KEY });
  }
  const roles = parsed.roles as unknown[];
  const findRole = (candidateRole: string): { model?: unknown; provider?: unknown; effort?: unknown } | undefined => {
    const found = roles.find((candidate: unknown) => (
      typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ) && (candidate as { role?: unknown }).role === candidateRole);
    return found && typeof found === "object" && !Array.isArray(found)
      ? found as { model?: unknown; provider?: unknown; effort?: unknown }
      : undefined;
  };
  const found = findRole(role)
    ?? (role === "librarian" ? findRole("advisor") : undefined)
    ?? DEFAULT_MODEL_SETTINGS.find((entry) => entry.role === role);
  if (!found || typeof found.model !== "string" || found.model.trim().length === 0 || typeof found.provider !== "string" || found.provider.trim().length === 0) {
    throw validationError(`Stored model settings are missing a valid ${role} provider/model.`, { key: MODEL_SETTINGS_KEY, role });
  }
  if (found.effort !== undefined && (typeof found.effort !== "string" || !["low", "medium", "high", "xhigh", "max"].includes(found.effort))) {
    throw validationError(`Stored model settings contain an invalid ${role} effort.`, { key: MODEL_SETTINGS_KEY, role });
  }
  return { model: found.model, provider: found.provider.trim().toLowerCase(), effort: found.effort as string | undefined };
}

const MODEL_SETTINGS_SCHEMA_VERSION = "1.0.0";

function emptyModelPresets(): StoredModelPresetsValue {
  return { schema_version: MODEL_SETTINGS_SCHEMA_VERSION, version: 0, presets: [] };
}

function parseModelPresetsValue(text: string): StoredModelPresetsValue {
  const parsed = parseStoredJsonObject(text, "settings", MODEL_PRESETS_KEY);
  if (!Number.isInteger(parsed.version) || Number(parsed.version) < 0 || !Array.isArray(parsed.presets)) {
    throw validationError("Stored model presets are not shaped as expected.", { key: MODEL_PRESETS_KEY });
  }
  // Skip entries that are not shaped like a preset so one bad entry cannot block the rest.
  // Their models are deliberately not checked: a stored preset may name a model that is gone.
  const presets = parsed.presets.filter((entry): entry is ModelPreset =>
    isRecord(entry) && typeof entry.id === "string" && typeof entry.name === "string" && Array.isArray(entry.roles));
  return { schema_version: MODEL_SETTINGS_SCHEMA_VERSION, version: Number(parsed.version), presets };
}

function readModelPresets(transaction: CoreWriteLaneTransaction): StoredModelPresetsValue {
  const row = transaction.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", MODEL_PRESETS_KEY);
  return row ? parseModelPresetsValue(row.value_json) : emptyModelPresets();
}

function writeModelPresets(transaction: CoreWriteLaneTransaction, presets: readonly ModelPreset[], version: number, now: string): void {
  ensureOwner(transaction, DEFAULT_OWNER_ID, now);
  transaction.run(
    `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    MODEL_PRESETS_KEY, DEFAULT_OWNER_ID, MODEL_SETTINGS_SCHEMA_VERSION,
    JSON.stringify({ schema_version: MODEL_SETTINGS_SCHEMA_VERSION, version, presets }), now,
  );
}

function assertPresetsVersion(expected: number, actual: number): void {
  if (expected !== actual) throw versionConflict(expected, actual);
}

function validateModelPresetName(value: unknown, presets: readonly ModelPreset[], excludedId?: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length < 1 || name.length > 60) throw validationError("Model preset name must contain 1 to 60 characters.", { field: "name" });
  if (presets.some((preset) => preset.id !== excludedId && preset.name.toLowerCase() === name.toLowerCase())) {
    throw validationError("A model preset with this name already exists.", { field: "name" });
  }
  return name;
}
// Model ids are checked against the harness model lists (CoreOptions.knownModels), which are
// not versioned, so every role setting carries the same catalog_version.
const DEFAULT_CATALOG_VERSION = "1.0.0";
const MODEL_SETTING_ROLES: readonly RoleModelSetting["role"][] = ["advisor", "manager", "designer", "lead_designer", "worker", "reviewer", "librarian", "curator"];
const MODEL_SETTING_EFFORTS = new Set<RoleModelSetting["effort"]>(["low", "medium", "high", "xhigh", "max"]);
const DEFAULT_MODEL_SETTINGS: readonly RoleModelSetting[] = Object.entries(DEFAULT_ROLE_MODELS).map(([role, setting]) => ({
  role: role as RoleModelSetting["role"],
  ...setting,
  catalog_version: DEFAULT_CATALOG_VERSION,
}));

function withRoleDefaults(roles: readonly RoleModelSetting[]): readonly RoleModelSetting[] {
  const advisor = roles.find((role) => role.role === "advisor");
  const withLibrarian = !roles.some((role) => role.role === "librarian") && advisor
    ? [...roles, { ...advisor, role: "librarian" as const }]
    : roles;
  const existing = new Set(withLibrarian.map((role) => role.role));
  return [...withLibrarian, ...DEFAULT_MODEL_SETTINGS.filter((role) => !existing.has(role.role))];
}

function parseModelSettingsValue(text: string): StoredModelSettingsValue {
  const parsed = parseStoredJsonObject(text, "settings", MODEL_SETTINGS_KEY);
  const version = parsed.version;
  const roles = parsed.roles;
  if (!Number.isInteger(version) || (version as number) < 0 || !Array.isArray(roles)) {
    throw validationError("Stored model settings are not shaped as expected.", { key: MODEL_SETTINGS_KEY });
  }
  return {
    schema_version: typeof parsed.schema_version === "string" ? parsed.schema_version : MODEL_SETTINGS_SCHEMA_VERSION,
    version: version as number,
    roles: roles as readonly RoleModelSetting[],
  };
}

function validateModelSettingsRoles(
  value: unknown,
  previousRoles: readonly RoleModelSetting[],
  knownModels: KnownModels,
): readonly RoleModelSetting[] {
  if (!Array.isArray(value) || value.length !== MODEL_SETTING_ROLES.length) {
    throw validationError(`Model settings roles must contain exactly the ${MODEL_SETTING_ROLES.length} canonical roles.`, { field: "roles" });
  }
  const previousByRole = new Map(previousRoles.map((entry) => [entry.role, entry]));
  const seenRoles = new Set<string>();
  return value.map((candidate, index): RoleModelSetting => {
    if (!isRecord(candidate)) {
      throw validationError("Model settings role entries must be objects.", { field: "roles", index });
    }
    const role = candidate.role;
    if (typeof role !== "string" || !MODEL_SETTING_ROLES.includes(role as RoleModelSetting["role"])) {
      throw validationError("Model settings role must be one of advisor, manager, designer, lead_designer, worker, reviewer, librarian, curator.", { field: "roles", index });
    }
    if (seenRoles.has(role)) {
      throw validationError(`Model settings role ${role} is duplicated.`, { field: "roles", role });
    }
    seenRoles.add(role);
    const provider = typeof candidate.provider === "string" ? candidate.provider.trim().toLowerCase() : candidate.provider;
    const model = candidate.model;
    const effort = candidate.effort;
    if (typeof provider !== "string" || provider.trim().length === 0) {
      throw validationError("Model settings provider must be a non-empty string.", { field: "roles", role });
    }
    if (typeof model !== "string" || model.trim().length === 0) {
      throw validationError("Model settings model must be a non-empty string.", { field: "roles", role });
    }
    if (typeof effort !== "string" || !MODEL_SETTING_EFFORTS.has(effort as RoleModelSetting["effort"])) {
      throw validationError("Model settings effort must be low, medium, high, xhigh, or max.", { field: "roles", role });
    }
    assertKnownModel(knownModels, provider, model, { field: "roles", role });
    return {
      role: role as RoleModelSetting["role"],
      provider,
      model,
      effort: effort as RoleModelSetting["effort"],
      catalog_version: previousByRole.get(role as RoleModelSetting["role"])?.catalog_version ?? DEFAULT_CATALOG_VERSION,
    };
  });
}

type KnownModels = (harness: "claude" | "codex") => ReadonlySet<string> | undefined;

const CODEX_BUILTIN_MODEL_SET: ReadonlySet<string> = new Set(CODEX_BUILTIN_MODELS);

function defaultKnownModels(harness: "claude" | "codex"): ReadonlySet<string> | undefined {
  return harness === "codex" ? CODEX_BUILTIN_MODEL_SET : undefined;
}

/**
 * Reject a model a built-in provider's harness does not accept. Custom
 * providers and harnesses without a known model list are not checked.
 */
function assertKnownModel(knownModels: KnownModels, provider: string, model: string, details: JsonObject): void {
  const harness = builtinProviderHarness(provider);
  if (!harness) return;
  const known = knownModels(harness);
  if (harness === "claude" && model.trim() === "claude-sonnet-5-5") return;
  if (!known || known.has(model.trim())) return;
  const list = [...known].join(", ");
  throw validationError(`Model ${model} is not available for ${provider}. Known models: ${list}.`, {
    ...details,
    provider,
    model,
    known_models: [...known],
  });
}

function validateVerificationPlan(value: unknown): readonly VerificationCommand[] {
  if (!Array.isArray(value)) {
    throw validationError("Project verification_plan must be an array.", { field: "verification_plan" });
  }
  return value.map((candidate, index): VerificationCommand => {
    if (!isRecord(candidate)) {
      throw validationError("Project verification_plan entries must be objects.", { field: "verification_plan", index });
    }
    const commandId = candidate.command_id;
    const argv = candidate.argv;
    const cwd = candidate.cwd;
    const envAllowlist = candidate.env_allowlist;
    const timeoutSeconds = candidate.timeout_seconds;
    const stdoutLimit = candidate.stdout_limit;
    const stderrLimit = candidate.stderr_limit;
    const expectedExitCodes = candidate.expected_exit_codes;
    const executor = candidate.executor;
    if (
      typeof commandId !== "string" || commandId.length === 0 ||
      !Array.isArray(argv) || !argv.every((item) => typeof item === "string") ||
      typeof cwd !== "string" || cwd.length === 0 ||
      !Array.isArray(envAllowlist) || !envAllowlist.every((item) => typeof item === "string") ||
      !Number.isInteger(timeoutSeconds) || (timeoutSeconds as number) < 0 ||
      !Number.isInteger(stdoutLimit) || (stdoutLimit as number) < 0 ||
      !Number.isInteger(stderrLimit) || (stderrLimit as number) < 0 ||
      !Array.isArray(expectedExitCodes) || !expectedExitCodes.every((item) => Number.isInteger(item)) ||
      (executor !== "core" && executor !== "reviewer")
    ) {
      throw validationError("Project verification_plan entry does not match the VerificationCommand contract.", { field: "verification_plan", index });
    }
    return {
      command_id: commandId,
      argv: argv as readonly string[],
      cwd,
      env_allowlist: envAllowlist as readonly string[],
      timeout_seconds: timeoutSeconds as number,
      stdout_limit: stdoutLimit as number,
      stderr_limit: stderrLimit as number,
      expected_exit_codes: expectedExitCodes as readonly number[],
      executor,
    };
  });
}

/**
 * Resolves (or creates) the conversation a connector's message or upload
 * belongs to, from a ConversationHint. Shared by ingestInbound and
 * registerInboundUpload so an attachment can be uploaded before the
 * message that references it exists, while still landing in the same
 * conversation the message will resolve to.
 *
 * conversation_hint.thread_ref is the sole grouping signal: connectors that
 * want messages kept apart by thread set it explicitly, and a connector
 * that groups by channel leaves it null even when the message itself came
 * from inside a thread. thread_id is reply-target metadata only, not a
 * conversation-grouping fallback.
 */
function resolveInboundConversation(
  transaction: CoreWriteLaneTransaction,
  ownerId: string,
  provider: string,
  hint: ConversationHint,
): { id: string; work_id: string | null } {
  const threadRef = hint.thread_ref;
  const dmRef = hint.dm_ref;
  let conversation = transaction.get<{ id: string; work_id: string | null }>(
    `SELECT id, work_id FROM conversations
      WHERE owner_id = ? AND channel = ?
        AND ((thread_ref = ?) OR (thread_ref IS NULL AND ? IS NULL))
        AND ((dm_ref = ?) OR (dm_ref IS NULL AND ? IS NULL))
        AND archived_at IS NULL
        AND (channel <> 'web' OR work_id IS NULL)
      ORDER BY updated_at DESC LIMIT 1`,
    ownerId,
    provider,
    threadRef,
    threadRef,
    dmRef,
    dmRef,
  );
  if (!conversation) {
    if (hint.work_id !== null) {
      const work = transaction.get<{ id: string; owner_id: string }>("SELECT id, owner_id FROM works WHERE id = ?", hint.work_id);
      if (!work || work.owner_id !== ownerId) throw notFound("work", hint.work_id);
    }
    const conversationId = createUlid();
    const now = utcNow();
    transaction.run(
      `INSERT INTO conversations
         (id, owner_id, work_id, channel, thread_ref, dm_ref, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      conversationId,
      ownerId,
      hint.work_id,
      provider,
      threadRef,
      dmRef,
      now,
      now,
    );
    conversation = { id: conversationId, work_id: hint.work_id };
  }
  return conversation;
}

function createProjectInTransaction(transaction: CoreWriteLaneTransaction, payload: CreateProjectPayload): Project {
  const name = payload.name;
  if (typeof name !== "string" || name.trim().length < 1 || name.length > 200) {
    throw validationError("Project name must contain between 1 and 200 characters.", { field: "name" });
  }
  const canonicalPath = payload.canonical_path;
  if (typeof canonicalPath !== "string" || canonicalPath.trim().length < 1) {
    throw validationError("Project canonical_path must be a non-empty string.", { field: "canonical_path" });
  }
  const baseBranch = payload.base_branch;
  if (typeof baseBranch !== "string" || baseBranch.trim().length < 1) {
    throw validationError("Project base_branch must be a non-empty string.", { field: "base_branch" });
  }
  const allowedRoots = payload.allowed_roots;
  if (!Array.isArray(allowedRoots) || !allowedRoots.every((root) => typeof root === "string" && root.length > 0)) {
    throw validationError("Project allowed_roots must be an array of non-empty strings.", { field: "allowed_roots" });
  }
  const verificationPlan = validateVerificationPlan(payload.verification_plan);
  const postMergeCommand = Object.prototype.hasOwnProperty.call(payload, "post_merge_command") && payload.post_merge_command !== null
    ? validateWorktreeCommand(payload.post_merge_command, "post_merge_command", ownerLanguage(transaction), true)
    : null;
  const postMergeInstallCommand = Object.prototype.hasOwnProperty.call(payload, "post_merge_install_command") && payload.post_merge_install_command !== null
    ? validateWorktreeCommand(payload.post_merge_install_command, "post_merge_install_command", ownerLanguage(transaction), true)
    : null;
  const requiredTestCommand = Object.prototype.hasOwnProperty.call(payload, "required_test_command") && payload.required_test_command !== null
    ? validateWorktreeCommand(payload.required_test_command, "required_test_command", ownerLanguage(transaction), true)
    : [];
  const testRun = Object.prototype.hasOwnProperty.call(payload, "test_run") ? validateTestRunPayload(payload.test_run, ownerLanguage(transaction)) : null;
  const testPolicy = Object.prototype.hasOwnProperty.call(payload, "test_policy") ? validateTestPolicyPayload(payload.test_policy, ownerLanguage(transaction)) : null;
  const existing = transaction.get<{ id: string }>("SELECT id FROM projects WHERE canonical_path = ?", canonicalPath);
  if (existing) {
    throw projectPathConflict(canonicalPath);
  }
  const now = utcNow();
  ensureOwner(transaction, DEFAULT_OWNER_ID, now);
  const id = createUlid();
  transaction.run(
    `INSERT INTO projects
       (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
        verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    DEFAULT_OWNER_ID,
    name,
    canonicalPath,
    baseBranch,
    JSON.stringify(allowedRoots),
    JSON.stringify(verificationPlan),
    JSON.stringify([]),
    now,
    now,
  );
  if (postMergeCommand !== null) transaction.run("UPDATE projects SET post_merge_argv_json = ? WHERE id = ?", JSON.stringify(postMergeCommand), id);
  if (postMergeInstallCommand !== null) transaction.run("UPDATE projects SET post_merge_install_argv_json = ? WHERE id = ?", JSON.stringify(postMergeInstallCommand), id);
  if (requiredTestCommand.length > 0) transaction.run("UPDATE projects SET required_test_argv_json = ? WHERE id = ?", JSON.stringify(requiredTestCommand), id);
  if (testRun !== null) transaction.run("UPDATE projects SET test_run_json = ? WHERE id = ?", JSON.stringify(testRun), id);
  if (testPolicy !== null) transaction.run("UPDATE projects SET test_policy_json = ? WHERE id = ?", JSON.stringify(testPolicy), id);
  return {
    id,
    name,
    canonical_path: canonicalPath,
    base_branch: baseBranch,
    auto_push: false,
    worktree_setup_command: [],
    worktree_refresh_command: [],
    post_merge_command: postMergeCommand,
    post_merge_install_command: postMergeInstallCommand,
    required_test_command: requiredTestCommand.length > 0 ? requiredTestCommand : null,
    test_run: testRun,
    test_run_status: projectTestRunStatus({
      canonical_path: canonicalPath,
      test_run_json: testRun === null ? null : JSON.stringify(testRun),
      test_run_detected_json: null,
    }),
    test_policy: readTestPolicy(testPolicy === null ? null : JSON.stringify(testPolicy)),
    allowed_roots: allowedRoots as readonly string[],
    verification_plan: verificationPlan,
  };
}

function listResponse<T extends JsonObject>(requestId: string | undefined, rows: readonly T[], hasMore: boolean, limit: number): ListResponse<T> {
  const data = rows.slice(0, limit);
  return { request_id: requestId ?? createUlid(), data, cursor: hasMore && data.length > 0 ? String(data[data.length - 1].id) : null, has_more: hasMore };
}

function positiveLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw validationError("View limit must be a positive integer.", { limit });
  }
  return limit;
}

function encodeViewCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

function decodeViewCursor(cursor: string | null | undefined, size: number): readonly string[] | null {
  if (cursor === null || cursor === undefined || cursor === "") return null;
  try {
    const parts: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parts) && parts.length === size && parts.every((part) => typeof part === "string")) return parts as string[];
  } catch { /* falls through to the validation error */ }
  throw validationError("The cursor is invalid.", { field: "cursor" });
}

const MAX_LIST_LIMIT = 200;

function boundLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw validationError("List limit must be an integer between 1 and 200.", { limit });
  }
  return limit;
}

function hashRequest(payload: JsonObject): string {
  return createHash("sha256").update(stableJson(payload), "utf8").digest("hex");
}

function realPathOrResolve(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function isRegularFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function assertWorkDeletable(
  workId: string,
  work: { readonly state: string; readonly archived_at: string | null; readonly state_version: number } | undefined,
  expectedVersion: number,
): asserts work is { readonly state: string; readonly archived_at: string | null; readonly state_version: number } {
  if (!work) throw notFound("work", workId);
  if (work.state !== "completed" && work.state !== "cancelled") {
    throw invalidStateTransition("Only completed or cancelled Works can be deleted.", { work_id: workId, state: work.state });
  }
  if (work.state_version !== expectedVersion) throw versionConflict(expectedVersion, work.state_version);
}

function assertNoOpenDecisions(transaction: Pick<CoreDatabase, "get">, workId: string): void {
  const openDecisions = transaction.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM decisions WHERE work_id = ? AND status = 'open'",
    workId,
  )?.count ?? 0;
  if (openDecisions > 0) {
    throw new HumanReadableError({
      code: "work_has_open_decisions",
      message: "Resolve open Decisions before deleting this Work.",
      remediation: "Resolve or cancel the open Decisions, then retry the delete command.",
      details: { work_id: workId, open_decisions: openDecisions },
    });
  }
}

/**
 * True only when the recorded process is confirmed gone: the PID no longer
 * exists, or it now runs a different process (PID reuse). A live PID whose
 * identity cannot be read or was never recorded stays "not gone".
 */
function isRecordedProcessGone(
  run: { process_start_time: string | null; process_cmdline_sha256: string | null },
  pid: number,
): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  const observed = readProcessIdentity(pid);
  if (
    observed.process_start_time === null || observed.process_cmdline_sha256 === null
    || run.process_start_time === null || run.process_cmdline_sha256 === null
  ) return false;
  return !processIdentityMatches(run, observed);
}

function agentStopFailure(runIds: readonly string[]): WorktreeCleanupResult {
  return {
    ok: false,
    message: `Agent runs did not stop in time: ${runIds.join(", ")}`,
    details: { stage: "agent_stop", agent_run_ids: runIds },
  };
}

function worktreeCleanupError(workId: string, cleanup: { readonly message: string; readonly details?: Record<string, unknown> }): HumanReadableError {
  const path = typeof cleanup.details?.path === "string" ? ` (${cleanup.details.path})` : "";
  const message = `Work ${workId} workspace cleanup failed${path}: ${cleanup.message}`;
  return new HumanReadableError({
    code: "worktree_cleanup_failed",
    message,
    remediation: "Fix the reported cause, then retry.",
    details: { work_id: workId, ...(cleanup.details ?? {}) },
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isUlidLike(value: unknown): value is string {
  return typeof value === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(value);
}

function isRfc3339(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && /T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value);
}

function isUploadProvider(value: string): value is "slack" | "discord" | "web" {
  return value === "slack" || value === "discord" || value === "web";
}

function isSafeUploadFilename(value: string): boolean {
  return value.length >= 1 && value.length <= 255 && !/[\\/\0\x00-\x1f\x7f]/u.test(value) && value !== "." && value !== "..";
}

function isExecutableUpload(filename: string, mime: string): boolean {
  return /(?:^|\.)(?:exe|dll|bat|cmd|com|scr|sh|bash|zsh)$/iu.test(filename)
    || /(?:x-executable|x-dosexec|x-sh|x-shellscript)/iu.test(mime);
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function parseCommandResponse<D extends JsonObject>(text: string, key: string): CommandResponse<D> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HumanReadableError({
        code: "idempotency_record_invalid",
        message: "The stored idempotency response is not an object.",
        remediation: "Inspect the database integrity before reusing this idempotency key.",
        details: { key },
      });
    }
    return parsed as CommandResponse<D>;
  } catch (error) {
    throw new HumanReadableError({
      code: "idempotency_record_invalid",
      message: "The stored idempotency response could not be read.",
      remediation: "Inspect the database integrity before reusing this idempotency key.",
      details: { key, cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

function parseArray(text: string, field: string, id: string, resource = "Decision"): unknown[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw validationError(`Stored ${resource} field ${field} is not an array.`, { id, field });
  }
  return parsed;
}

const WORKTREE_COMMAND_MAX_ARGS = 64;
const WORKTREE_COMMAND_MAX_ARG_LENGTH = 4096;

function validateWorktreeCommand(value: unknown, field: string, language: "ja" | "en", nonEmptyArgs = false): string[] {
  const valid = Array.isArray(value)
    && value.length <= WORKTREE_COMMAND_MAX_ARGS
    && value.every((arg) => typeof arg === "string" && arg.length <= WORKTREE_COMMAND_MAX_ARG_LENGTH && !arg.includes("\0"))
    && (value.length === 0 || (value[0] as string).trim().length > 0)
    && (!nonEmptyArgs || value.every((arg) => (arg as string).length > 0));
  if (!valid) {
    throw validationError(
      language === "ja"
        ? "コマンドは文字列の配列（先頭がコマンド名、空配列で未設定）で指定してください。"
        : "Specify the command as an array of strings (command name first; an empty array clears it).",
      { field },
    );
  }
  return value as string[];
}

/** A Project's test_run payload: null clears it; an object must pass validateTestRunSettings and its argv keys the command check. */
function validateTestRunPayload(value: unknown, language: "ja" | "en"): JsonObject | null {
  if (value === null) return null;
  const errors = validateTestRunSettings(value);
  if (errors.length > 0) {
    throw validationError(
      language === "ja" ? `テスト実行の設定が不正です: ${errors.join(", ")}` : `Invalid test_run settings: ${errors.join(", ")}`,
      { field: "test_run", errors },
    );
  }
  const settings = value as JsonObject;
  for (const key of ["file_argv", "prepare_argv", "whole_argv"]) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) validateWorktreeCommand(settings[key], `test_run.${key}`, language, true);
  }
  return settings;
}

/** A Project's test_policy payload: null clears it; an object must pass validateTestPolicy. */
function validateTestPolicyPayload(value: unknown, language: "ja" | "en"): JsonObject | null {
  if (value === null) return null;
  const errors = validateTestPolicy(value);
  if (errors.length > 0) {
    throw validationError(
      language === "ja" ? `テスト方針の設定が不正です: ${errors.join(", ")}` : `Invalid test_policy settings: ${errors.join(", ")}`,
      { field: "test_policy", errors },
    );
  }
  return value as JsonObject;
}

function parseStringArray(text: string, field: string, id: string, resource = "Decision"): string[] {
  const parsed = parseArray(text, field, id, resource);
  if (!parsed.every((value): value is string => typeof value === "string")) {
    throw validationError(`Stored ${resource} field ${field} contains a non-string value.`, { id, field });
  }
  return parsed;
}

function parseStoredJsonObject(text: string, field: string, id: string): JsonObject {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw validationError(`Stored ${field} ${id} is not an object.`, { field, id });
  }
  return parsed as JsonObject;
}

function addManagerRules(request: unknown, rulesText: string | null, skillsText: string | null, knowledgeText: string | null): unknown {
  if (!isRecord(request)) return request;
  const enriched: JsonObject = { ...request };
  enriched.context = {
    ...(isRecord(request.context) ? request.context : {}),
    rules: rulesText,
    skills: skillsText,
    knowledge: knowledgeText,
  };
  return enriched;
}

function extractManagerWorkRules(value: unknown): string[] | null {
  if (!isRecord(value)) return null;
  const candidates: unknown[] = [value.work_rules];
  if (isRecord(value.report)) candidates.push(value.report.work_rules);
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const rules = candidate.filter((rule): rule is string => typeof rule === "string");
    if (rules.length === candidate.length) return rules;
  }
  return null;
}

function extractManagerRequestIds(request: unknown, operation: string): { workId: string; taskId: string | null } {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw validationError(`The ${operation} request is not a valid object.`, { operation });
  }
  const record = request as Record<string, unknown>;
  const workId = record.work_id;
  if (typeof workId !== "string" || workId.length === 0) {
    throw validationError(`The ${operation} request is missing work_id.`, { operation });
  }
  const taskIdRaw = record.task_id;
  if (taskIdRaw !== null && typeof taskIdRaw !== "undefined" && typeof taskIdRaw !== "string") {
    throw validationError(`The ${operation} request has an invalid task_id.`, { operation });
  }
  const taskId = typeof taskIdRaw === "string" ? taskIdRaw : null;
  return { workId, taskId };
}

function humanizeUnexpected(error: unknown, operation: string): HumanReadableError {
  if (isCodedError(error)) {
    return error as HumanReadableError;
  }
  // Raw exception text belongs in the runtime log; the public surface remains actionable.
  console.error(`[owl-core] ${operation} failed`, error);
  return new HumanReadableError({
    code: "core_write_failed",
    message: formatRuntimeFailure(error, operation),
    remediation: "Inspect the Core log, correct the reported cause, and retry the command.",
    details: { operation },
  });
}

const LEGACY_EXECUTOR_PROVIDERS: Readonly<Record<string, "claude" | "codex">> = {
  claude: "claude",
  anthropic: "claude",
  codex: "codex",
  openai: "codex",
};
const CHILD_RUN_EFFORT_SET: ReadonlySet<string> = new Set(CHILD_RUN_EFFORTS);

function normalizeLegacyExecutorConfig(value: unknown): {
  readonly provider: "claude" | "codex";
  readonly model: string;
  readonly effort?: ChildRunSettings["default_effort"] & string;
  readonly timeout_ms: number;
} {
  if (!isRecord(value)) {
    throw validationError("Executor configuration must be an object.", { field: "executor_config" });
  }
  const provider = value.provider;
  const model = value.model;
  const effort = value.effort;
  const timeoutMs = value.timeout_ms;
  if (
    typeof provider !== "string" ||
    !LEGACY_EXECUTOR_PROVIDERS[provider.trim().toLowerCase()] ||
    typeof model !== "string" ||
    model.trim().length === 0 ||
    (effort !== undefined && effort !== null && (typeof effort !== "string" || (effort.length > 0 && !CHILD_RUN_EFFORT_SET.has(effort)))) ||
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0
  ) {
    throw validationError("Executor configuration is invalid.", { field: "executor_config" });
  }
  return {
    provider: LEGACY_EXECUTOR_PROVIDERS[provider.trim().toLowerCase()],
    model: model.trim(),
    ...(typeof effort === "string" && effort.length > 0 ? { effort: effort as NonNullable<ChildRunSettings["default_effort"]> } : {}),
    timeout_ms: timeoutMs,
  };
}

function deriveChildRunSettings(value: unknown): ChildRunSettings {
  const legacy = normalizeLegacyExecutorConfig(value);
  const modelChoices = [
    { provider: legacy.provider, model: legacy.model },
    ...DEFAULT_CHILD_RUN_SETTINGS.allowed_models,
  ].filter((choice, index, all) => all.findIndex((candidate) => candidate.provider === choice.provider && candidate.model === choice.model) === index);
  const efforts = [...new Set([
    "low", "medium", "high", ...(legacy.effort ? [legacy.effort] : []),
  ])] as NonNullable<ChildRunSettings["default_effort"]>[];
  const timeout = legacy.timeout_ms > 0
    ? Math.max(5, Math.min(180, Math.ceil(legacy.timeout_ms / 60_000)))
    : 60;
  return {
    ...DEFAULT_CHILD_RUN_SETTINGS,
    default_provider: legacy.provider,
    default_model: legacy.model,
    default_effort: legacy.effort ?? "medium",
    allowed_models: modelChoices,
    allowed_efforts: efforts,
    timeout_minutes: timeout,
  };
}

function childProvider(value: unknown, field: string): ChildRunSettings["default_provider"] {
  const provider = typeof value === "string" ? LEGACY_EXECUTOR_PROVIDERS[value.trim().toLowerCase()] : undefined;
  if (!provider) throw validationError("Child-agent provider must be claude or codex.", { field });
  return provider;
}

function normalizeChildRunSettings(value: unknown, knownModels: KnownModels): ChildRunSettings {
  if (!isRecord(value)) throw validationError("Child-agent settings must be an object.", { field: "child_run_settings" });
  const isLegacyShape = !["allowed_models", "allowed_efforts", "defaults_by_parent_harness"].some((field) => Object.hasOwn(value, field));
  const legacyDefaultChoice = isLegacyShape && typeof value.default_model === "string" && value.default_model.trim().length > 0
    ? { provider: childProvider(value.default_provider, "default_provider"), model: value.default_model.trim() }
    : null;
  const legacyAllowedModels = legacyDefaultChoice
    ? [...DEFAULT_CHILD_RUN_SETTINGS.allowed_models, legacyDefaultChoice]
      .filter((choice, index, all) => all.findIndex((candidate) => candidate.provider === choice.provider && candidate.model === choice.model) === index)
    : DEFAULT_CHILD_RUN_SETTINGS.allowed_models;
  const legacyEffort = value.default_effort;
  const legacyAllowedEfforts = isLegacyShape && typeof legacyEffort === "string" && CHILD_RUN_EFFORT_SET.has(legacyEffort)
    ? [...new Set([...DEFAULT_CHILD_RUN_SETTINGS.allowed_efforts, legacyEffort])]
    : DEFAULT_CHILD_RUN_SETTINGS.allowed_efforts;
  const hasParentDefaults = value.defaults_by_parent_harness !== undefined;
  if (hasParentDefaults && !isRecord(value.defaults_by_parent_harness)) {
    throw validationError("Per-parent-harness child defaults must be an object.", { field: "defaults_by_parent_harness" });
  }
  const settings = {
    ...DEFAULT_CHILD_RUN_SETTINGS,
    ...value,
    ...(isLegacyShape ? { allowed_models: legacyAllowedModels, allowed_efforts: legacyAllowedEfforts } : {}),
  };
  const defaultProvider = childProvider(settings.default_provider, "default_provider");
  if (typeof settings.default_model !== "string" || settings.default_model.trim().length === 0) {
    throw validationError("The default child-agent model must be a non-empty string.", { field: "default_model" });
  }
  const rawModels = settings.allowed_models;
  if (!Array.isArray(rawModels) || rawModels.length < 1 || rawModels.length > 20) {
    throw validationError("Allowed child-agent models must contain 1 to 20 choices.", { field: "allowed_models" });
  }
  const allowedModels: { provider: ChildRunSettings["default_provider"]; model: string }[] = [];
  rawModels.forEach((choice, index) => {
    if (!isRecord(choice)) throw validationError("Allowed child-agent models must be provider/model objects.", { field: "allowed_models", index });
    const provider = childProvider(choice.provider, "allowed_models");
    if (typeof choice.model !== "string" || choice.model.trim().length === 0) {
      throw validationError("Allowed child-agent model names must be non-empty strings.", { field: "allowed_models", index });
    }
    const model = choice.model.trim();
    if (allowedModels.some((candidate) => candidate.provider === provider && candidate.model === model)) {
      throw validationError("Allowed child-agent models cannot contain duplicates.", { field: "allowed_models", index });
    }
    assertKnownModel(knownModels, provider, model, { field: "allowed_models", index });
    allowedModels.push({ provider, model });
  });
  const defaultModel = settings.default_model.trim();
  if (!allowedModels.some((choice) => choice.provider === defaultProvider && choice.model === defaultModel)) {
    throw validationError("The default child-agent model must be in the allowed list.", { field: "default_model" });
  }
  const rawEfforts = settings.allowed_efforts;
  if (!Array.isArray(rawEfforts) || rawEfforts.length < 1 || rawEfforts.length > 5) {
    throw validationError("Allowed child-agent efforts must contain 1 to 5 choices.", { field: "allowed_efforts" });
  }
  const allowedEfforts = rawEfforts.map((effort, index) => {
    if (typeof effort !== "string" || !CHILD_RUN_EFFORT_SET.has(effort)) {
      throw validationError("Allowed child-agent efforts must be low, medium, high, xhigh, or max.", { field: "allowed_efforts", index });
    }
    if (rawEfforts.indexOf(effort) !== index) {
      throw validationError("Allowed child-agent efforts cannot contain duplicates.", { field: "allowed_efforts", index });
    }
    return effort as NonNullable<ChildRunSettings["default_effort"]>;
  });
  if (!hasParentDefaults) {
    for (const effort of ["low", "medium"] as const) {
      if (!allowedEfforts.includes(effort)) allowedEfforts.push(effort);
    }
  }
  const defaultEffort = settings.default_effort;
  if (defaultEffort !== null && (typeof defaultEffort !== "string" || !CHILD_RUN_EFFORT_SET.has(defaultEffort))) {
    throw validationError("The default child-agent effort must be null or a supported effort.", { field: "default_effort" });
  }
  if (defaultEffort !== null && !allowedEfforts.includes(defaultEffort as NonNullable<ChildRunSettings["default_effort"]>)) {
    throw validationError("The default child-agent effort must be in the allowed list.", { field: "default_effort" });
  }
  const rawDefaults = hasParentDefaults ? value.defaults_by_parent_harness as JsonObject : {};
  const defaultsByParentHarness = Object.fromEntries(CHILD_RUN_PROVIDERS.map((harness) => {
    const standard = DEFAULT_CHILD_RUN_SETTINGS.defaults_by_parent_harness[harness];
    const isExplicit = Object.hasOwn(rawDefaults, harness);
    const raw = isExplicit ? rawDefaults[harness] : standard;
    if (!isRecord(raw)) throw validationError("Each parent harness must have a provider, model and effort default.", { field: "defaults_by_parent_harness", harness });
    let provider = childProvider(raw.provider, "defaults_by_parent_harness");
    if (typeof raw.model !== "string" || raw.model.trim().length === 0) {
      throw validationError("A parent-harness default model must be a non-empty string.", { field: "defaults_by_parent_harness", harness });
    }
    let model = raw.model.trim();
    if (!allowedModels.some((choice) => choice.provider === provider && choice.model === model)) {
      if (isExplicit || provider !== standard.provider || model !== standard.model) {
        throw validationError("Parent-harness provider/model defaults must be in the allowed list.", { field: "defaults_by_parent_harness", harness });
      }
      const replacement = allowedModels.find((choice) => choice.provider === provider) ?? allowedModels[0];
      provider = replacement.provider;
      model = replacement.model;
    }
    let effort = raw.effort;
    if (effort !== null && (typeof effort !== "string" || !CHILD_RUN_EFFORT_SET.has(effort))) {
      throw validationError("A parent-harness default effort must be null or a supported effort.", { field: "defaults_by_parent_harness", harness });
    }
    if (effort !== null && !allowedEfforts.includes(effort as NonNullable<ChildRunSettings["default_effort"]>)) {
      if (isExplicit || effort !== standard.effort) {
        throw validationError("Parent-harness default efforts must be in the allowed list.", { field: "defaults_by_parent_harness", harness });
      }
      effort = allowedEfforts.includes(settings.default_effort as NonNullable<ChildRunSettings["default_effort"]>)
        ? settings.default_effort
        : allowedEfforts[0];
    }
    return [harness, { provider, model, effort: effort as ChildRunSettings["default_effort"] }];
  })) as ChildRunSettings["defaults_by_parent_harness"];
  const integer = (field: string, minimum: number, maximum: number): number => {
    const item = (settings as JsonObject)[field];
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < minimum || item > maximum) {
      throw validationError(`${field} must be an integer from ${minimum} to ${maximum}.`, { field });
    }
    return item;
  };
  const maxTimeout = integer("max_timeout_minutes", 5, 1440);
  const timeout = integer("timeout_minutes", 5, maxTimeout);
  const attempts = integer("max_attempts", 1, 3);
  return {
    default_provider: defaultProvider,
    default_model: defaultModel,
    default_effort: defaultEffort as ChildRunSettings["default_effort"],
    defaults_by_parent_harness: defaultsByParentHarness,
    allowed_models: allowedModels,
    allowed_efforts: allowedEfforts,
    timeout_minutes: timeout,
    max_timeout_minutes: maxTimeout,
    max_attempts: attempts,
  };
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isRateLimitedAgentRunResult(value: unknown): value is AgentRunResult {
  return isRecord(value) && value.failure_class === "rate_limited";
}

function skillFileSizes(files: Record<string, string>): Record<string, number> {
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, Buffer.byteLength(content, "utf8")]));
}

function isSkillState(value: string): value is SkillState {
  return value === "active" || value === "stale" || value === "archived";
}

function isSkillProposalStatus(value: string): value is "pending" | "awaiting_approval" | "applied" | "rejected" {
  return value === "pending" || value === "awaiting_approval" || value === "applied" || value === "rejected";
}

function validateSkillSettings(value: unknown): SkillSettings {
  const fields = ["mode", "confidence_threshold", "stale_days", "archived_days", "max_items", "max_characters"] as const;
  if (!isRecord(value)) throw validationError("Skill settings must be an object.", { field: "settings" });
  const missing = fields.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  const extra = Object.keys(value).filter((field) => field !== "feedback_weights" && !fields.includes(field as typeof fields[number]));
  if (missing.length > 0 || extra.length > 0) {
    throw validationError("Skill settings fields do not match the supported settings.", { missing, extra });
  }
  if (value.mode !== "autonomous" && value.mode !== "conservative") {
    throw validationError("Skill settings mode must be autonomous or conservative.", { field: "mode" });
  }
  if (typeof value.confidence_threshold !== "number" || !Number.isFinite(value.confidence_threshold) || value.confidence_threshold < 0 || value.confidence_threshold > 1) {
    throw validationError("confidence_threshold must be between 0 and 1.", { field: "confidence_threshold" });
  }
  for (const field of ["stale_days", "archived_days"] as const) {
    if (!Number.isSafeInteger(value[field]) || Number(value[field]) < 1 || Number(value[field]) > 3650) {
      throw validationError(`${field} must be an integer between 1 and 3650.`, { field });
    }
  }
  if (!Number.isSafeInteger(value.max_items) || Number(value.max_items) < 1 || Number(value.max_items) > 1000) {
    throw validationError("max_items must be an integer between 1 and 1000.", { field: "max_items" });
  }
  if (!Number.isSafeInteger(value.max_characters) || Number(value.max_characters) < 1 || Number(value.max_characters) > 1_000_000) {
    throw validationError("max_characters must be an integer between 1 and 1000000.", { field: "max_characters" });
  }
  const weights = value.feedback_weights === undefined ? DEFAULT_SKILL_FEEDBACK_WEIGHTS : value.feedback_weights;
  if (!isRecord(weights) || Object.keys(weights).some((key) => !Object.hasOwn(DEFAULT_SKILL_FEEDBACK_WEIGHTS, key))
    || Object.keys(DEFAULT_SKILL_FEEDBACK_WEIGHTS).some((key) => typeof weights[key] !== "number" || !(weights[key] as number >= 0) || !Number.isFinite(weights[key]))) {
    throw validationError("feedback_weights must hold a non-negative number for major_finding, replan and owner_correction.", { field: "feedback_weights" });
  }
  return {
    feedback_weights: weights as unknown as SkillSettings["feedback_weights"],
    mode: value.mode,
    confidence_threshold: value.confidence_threshold,
    stale_days: Number(value.stale_days),
    archived_days: Number(value.archived_days),
    max_items: Number(value.max_items),
    max_characters: Number(value.max_characters),
  };
}

function parseSkillFilesSnapshot(value: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw validationError("Stored skill revision content is invalid.", { field: "snapshot_json" });
  }
  if (!isRecord(parsed) || !Object.values(parsed).every((content) => typeof content === "string")) {
    throw validationError("Stored skill revision content is invalid.", { field: "snapshot_json" });
  }
  return parsed as Record<string, string>;
}

function isNodeMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/** `.catch` handler: a missing file is `null`; any other read failure propagates. */
function rethrowUnlessMissing(error: unknown): null {
  if (isNodeMissingFileError(error)) return null;
  throw error;
}

interface SkillProposalCommandResult {
  readonly proposal_id: string;
  readonly status: "awaiting_approval" | "applied" | "rejected";
  readonly applied_revision_id: string | null;
}

function skillProposalCommandError(error: unknown, proposalId: string): unknown {
  if (error instanceof Error && !isCodedError(error)) {
    const message = error.message;
    if (/^(skill_changed_since_proposal|skill_name_taken|skill_proposal_not_awaiting_approval|curator_archive_)/u.test(message)) {
      return invalidStateTransition(message, { proposal_id: proposalId });
    }
    if (message === "curator_unavailable" || message === "curator_stopped") {
      return dependencyUnavailable(message, { proposal_id: proposalId });
    }
  }
  return skillValidationError(error);
}

function skillValidationError(error: unknown): unknown {
  if (isRecord(error) && typeof error.code === "string") return error;
  if (!(error instanceof Error)) return error;
  const message = error.message;
  if (/^(invalid_|skill_file_contains_|skill_size_|skill_metadata_|skill_revision_invalid|skill_proposal_decision_invalid|File path |Absolute paths |Empty and traversal path segments|Files must be |Skill files must be)/u.test(message)) {
    return validationError(message);
  }
  return error;
}

function mergeAdvisorSuggestedActions(
  ...groups: readonly (readonly AdvisorSuggestedAction[])[]
): AdvisorSuggestedAction[] {
  const seen = new Set<string>();
  const merged: AdvisorSuggestedAction[] = [];
  for (const action of groups.flat()) {
    const fingerprint = JSON.stringify(action);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    merged.push(action);
  }
  return merged;
}

function isCodedError(value: unknown): value is { readonly code: string } {
  return isRecord(value) && typeof value.code === "string";
}

/** Signal a recorded process only while its pid still identifies that process. */
function signalRecordedProcess(
  run: { pid: number | null; process_start_time: string | null; process_cmdline_sha256: string | null },
  signal: NodeJS.Signals,
): void {
  if (!run.pid) return;
  const expected = { process_start_time: run.process_start_time, process_cmdline_sha256: run.process_cmdline_sha256 };
  if (processIdentityMatches(expected, readProcessIdentity(run.pid))) signalProcessGroup(run.pid, signal);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    try { process.kill(pid, signal); } catch { /* the process already exited */ }
  }
}

/** Initial Manager plan: 1 attempt plus 2 retries for transient/retryable failures. */
const INITIAL_PLAN_MAX_ATTEMPTS = 3;
/** A rejected plan or replan is handed back to the Manager once before the Owner is asked. */
const PLAN_MAX_ATTEMPTS = 2;
const REPLAN_MAX_ATTEMPTS = 2;
const INITIAL_PLAN_RETRY_DELAY_MS = 5_000;
/** Final Manager check: 1 attempt plus 1 retry for transient/retryable failures. */
const FINAL_MANAGER_MAX_ATTEMPTS = 2;

/** Runtime error codes for an agent answer that broke its role contract (agent-runtime errors.ts). */
const AGENT_CONTRACT_ERROR_CODES = new Set(["report_invalid", "manager_plan_invalid", "review_invalid"]);

const SIDE_EFFECT_FAILURE_PREFIX = "side_effect_failure:";

/** Marks a failure record that followed an external side effect: it keeps that class and is never retried. */
function sideEffectFailureFields(errorKey: unknown): JsonObject {
  return typeof errorKey === "string" && errorKey.startsWith(SIDE_EFFECT_FAILURE_PREFIX)
    ? { outcome: "failed_after_side_effect", retry_allowed: false }
    : {};
}

/**
 * Turn an error thrown by a Final Manager attempt into a failed result.
 * A malformed answer is retried like on the Core-shaped runner path; a
 * provider failure arrives here without agent-runtime's classification, so
 * it is treated as transient (one bounded retry). Anything else (setup,
 * Core validation) is deterministic.
 */
function finalManagerErrorResult(error: unknown, language: OwnerLanguage): AgentRunResult {
  const code = isCodedError(error) ? error.code : null;
  const reason = isRecord(error) && typeof error.reason === "string" ? error.reason : null;
  const contract = code !== null && AGENT_CONTRACT_ERROR_CODES.has(code);
  // agent-runtime marks an error thrown after an external side effect; it must never be retried.
  const afterSideEffect = isRecord(error) && error.outcome === "failed_after_side_effect";
  const transient = code === "provider_failed" && !afterSideEffect;
  const baseKey = code === null ? "final_manager_error" : reason === null ? code : `${code}:${reason}`;
  return {
    outcome: "failed",
    report_valid: false,
    skill_feedback: null,
    failure_class: transient ? "transient" : "deterministic",
    error_key: afterSideEffect ? `${SIDE_EFFECT_FAILURE_PREFIX}${baseKey}` : baseKey,
    retry_allowed: contract && !afterSideEffect,
    message: formatRuntimeFailure(error, "Manager", language),
  };
}

/**
 * The Task fields a Manager reads: identity, plan fields, status and the
 * counters it can reason about. Internals (error hashes, worktree paths,
 * leases, versions) stay in Core.
 */
/** The required_sections / required_tests stored for the Task, so a replan can keep or change them. */
function storedVerificationSpec(task: TaskRow): JsonObject {
  try {
    const parsed: unknown = task.verification_spec_json ? JSON.parse(task.verification_spec_json) : {};
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
  } catch (error) {
    // A corrupt spec drops required_sections / required_tests on replan, so make that visible.
    console.warn(`[owl-core] Task ${task.id} has an unreadable verification_spec_json; replanning without its stored verification conditions`, error);
    return {};
  }
}

function managerTaskView(task: TaskRow, dependsOn: readonly string[]): JsonObject {
  return {
    id: task.id,
    manager_task_id: task.manager_task_id,
    title: task.title,
    type: task.type,
    status: task.status,
    acceptance_criteria: readStoredAcceptanceCriteria(task.acceptance_criteria_json, task.acceptance) as unknown as JsonObject[],
    ...planContextFields(task),
    ...storedVerificationSpec(task),
    depends_on: [...dependsOn],
    review_round: task.review_round,
    failure_count: task.failure_count,
  };
}

const WORK_INTEGRATION_ALERT_KIND = "work_integration_verification_failed";

/**
 * The work_verification context for a replan after the Owner answered a Decision opened because
 * the integrated Work branch failed the Project verification; null for any other alert.
 */
function integrationVerificationReplan(alert: JsonObject | null): JsonObject | null {
  if (alert === null || alert.kind !== WORK_INTEGRATION_ALERT_KIND) return null;
  return isRecord(alert.work_verification) ? (alert.work_verification as JsonObject) : null;
}

/**
 * The final check's summary and missing items when the Work's latest
 * halt was an incomplete final verdict, in the shape the Manager replan
 * input carries as context.final_verdict; otherwise null.
 */
function incompleteFinalVerdict(alert: JsonObject | null): JsonObject | null {
  if (alert === null || alert.kind !== "final_manager_incomplete") return null;
  const missing = Array.isArray(alert.missing) ? alert.missing.filter(isFinalMissingItem) : [];
  return {
    summary: typeof alert.summary === "string" ? alert.summary : "",
    missing: missing.map((item) => ({ item: item.item, reason: item.reason, fix: item.fix })),
  };
}

/**
 * The conflict between the Work branch and the Project base, after the
 * Owner asked for it to be resolved or Core started it automatically;
 * null for any other alert.
 */
function baseMergeConflict(alert: JsonObject | null): BaseMergeConflict | null {
  const automatic = alert?.kind === AUTO_CONFLICT_ALERT_KIND;
  if (alert === null || (!automatic && (alert.kind !== "work_merge_failed" || alert.merge_kind !== "conflict"))) return null;
  return {
    base_branch: typeof alert.base_branch === "string" && alert.base_branch.length > 0 ? alert.base_branch : null,
    files: mergeConflictFiles(alert),
    automatic,
  };
}

function mergeConflictFiles(alert: JsonObject | null): string[] {
  return Array.isArray(alert?.conflicting_files)
    ? alert.conflicting_files.filter((path): path is string => typeof path === "string" && path.length > 0)
    : [];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

function policyDecisionIdempotencyKeyPrefix(workId: string): string {
  return `kb-policy-${workId}:`;
}

/** system.alert kind recorded each time a merge conflict is handed to the Manager without a Decision. */
const AUTO_CONFLICT_ALERT_KIND = "work_merge_conflict_auto_resolve";
/** Automatic conflict resolution rounds per Work before the Owner is asked. */
const MAX_AUTO_CONFLICT_RESOLUTIONS = 2;

interface OwnerReplanRequest {
  readonly kind: "decision" | "reopen" | "instruction" | "work_update" | "auto_conflict" | "auto_final";
  readonly answer: string;
  /** Owner instruction messages this request answers; the Manager's reply links back to them. */
  readonly message_ids?: readonly string[];
  /** What the Manager reads: one entry per Owner request, the Owner's text whole. Absent on a request built from an older marker. */
  readonly requests?: readonly OwnerRequestInput[];
}

/** One Owner request as the Manager sees it. `text` is the Owner's words, never joined with another request or with Core text. */
type OwnerRequestInput =
  | { readonly kind: "decision" | "reopen" | "instruction"; readonly text: string; readonly message_ids: readonly string[] }
  | { readonly kind: "work_update"; readonly changed_fields: readonly ("title" | "summary")[]; readonly previous_title: string | null; readonly previous_summary: string | null };

/**
 * The requests a marker (or a request built from one) carries. An older
 * marker has only `answer`: it is read as one request, never split. The
 * automatic kinds are Core's own doing and are not Owner requests.
 */
function ownerRequestsOf(value: { readonly requests?: unknown; readonly kind?: unknown; readonly answer?: unknown; readonly message_ids?: unknown }): OwnerRequestInput[] {
  if (Array.isArray(value.requests)) return value.requests.filter(isRecord) as unknown as OwnerRequestInput[];
  if (typeof value.answer !== "string" || value.kind === "auto_conflict" || value.kind === "auto_final") return [];
  if (value.kind === "work_update") return [{ kind: "work_update", changed_fields: [], previous_title: null, previous_summary: null }];
  const kind = value.kind === "reopen" || value.kind === "instruction" ? value.kind : "decision";
  return [{ kind, text: value.answer, message_ids: markerMessageIds(value.message_ids) }];
}

function markerMessageIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function workUpdateReplanAnswer(
  before: Pick<WorkRow, "title" | "summary">,
  after: Pick<WorkRow, "title" | "summary">,
  changedFields: readonly ("title" | "summary")[],
): string {
  const lines: string[] = [];
  if (changedFields.includes("title")) lines.push(`The Owner renamed the Work from "${before.title}" to "${after.title}".`);
  if (changedFields.includes("summary")) lines.push(`The Owner rewrote the Work summary. New summary:\n${after.summary}`);
  return lines.join("\n");
}

/** Durable per-Work request for the next tick to hand an Owner answer to the Manager. */
function ownerReplanKey(workId: string): string {
  return `owner-replan:${workId}`;
}

function queueOwnerReplanInTransaction(
  transaction: CoreWriteLaneTransaction,
  workId: string,
  request: OwnerReplanRequest,
  options: { readonly replace?: boolean; readonly processing_message_ids?: readonly string[]; readonly processing?: { readonly kind: OwnerReplanRequest["kind"]; readonly answer: string; readonly requests: readonly OwnerRequestInput[] } } = {},
): void {
  const now = utcNow();
  transaction.run(
    `INSERT OR ${options.replace === false ? "IGNORE" : "REPLACE"} INTO idempotency_keys
       (key, request_hash, response_json, status_code, created_at, expires_at)
     VALUES (?, ?, ?, 202, ?, ?)`,
    ownerReplanKey(workId),
    "0".repeat(64),
    JSON.stringify({ work_id: workId, status: "queued", kind: request.kind, answer: request.answer, requests: ownerRequestsOf(request), ...(request.message_ids?.length ? { message_ids: request.message_ids } : {}), ...(options.processing_message_ids?.length ? { processing_message_ids: options.processing_message_ids } : {}), ...(options.processing ? { processing_kind: options.processing.kind, processing_answer: options.processing.answer, processing_requests: options.processing.requests } : {}) }),
    now,
    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  );
}

/** Hand a Decision answer to the Manager as a replan at the next tick. */
function queueDecisionReplanInTransaction(transaction: CoreWriteLaneTransaction, workId: string, answer: string): void {
  mergeOwnerReplanInTransaction(transaction, workId, { kind: "decision", answer });
}

/** Queue a request, combining it with one that is still queued so neither is lost. */
function mergeOwnerReplanInTransaction(
  transaction: CoreWriteLaneTransaction,
  workId: string,
  request: OwnerReplanRequest,
): void {
  const pending = transaction.get<{ response_json: string }>(
    "SELECT response_json FROM idempotency_keys WHERE key = ?",
    ownerReplanKey(workId),
  );
  let merged = request;
  let processing: string[] = [];
  let processingRequest: { kind: OwnerReplanRequest["kind"]; answer: string; requests: OwnerRequestInput[] } | undefined;
  try {
    const value = pending ? JSON.parse(pending.response_json) as unknown : null;
    // An instruction the Manager is handling keeps its id beside the new queued one.
    if (isRecord(value)) processing = markerMessageIds(value.status === "attempted" ? value.message_ids : value.processing_message_ids);
    // Keep the body of the request being handled so a requeue can restore it.
    if (isRecord(value) && value.status === "attempted" && typeof value.answer === "string") processingRequest = { kind: value.kind as OwnerReplanRequest["kind"], answer: value.answer, requests: ownerRequestsOf(value) };
    else if (isRecord(value) && typeof value.processing_answer === "string") processingRequest = { kind: value.processing_kind as OwnerReplanRequest["kind"], answer: value.processing_answer, requests: ownerRequestsOf({ requests: value.processing_requests, kind: value.processing_kind, answer: value.processing_answer, message_ids: value.processing_message_ids }) };
    if (isRecord(value) && value.status === "queued" && typeof value.answer === "string" && value.answer.length > 0) {
      merged = {
        kind: value.kind === "instruction" || request.kind === "instruction"
          ? "instruction"
          : value.kind === "work_update" || request.kind === "work_update"
            ? "work_update"
            : request.kind,
        answer: `${value.answer}\n\n${request.answer}`,
        message_ids: [...new Set([...markerMessageIds(value.message_ids), ...(request.message_ids ?? [])])],
        requests: [...ownerRequestsOf(value), ...ownerRequestsOf(request)],
      };
    }
  } catch (error) {
    // A malformed pending request is replaced.
    console.warn(`[owl-core] Replacing a malformed pending Owner replan request for Work ${workId}`, error);
  }
  queueOwnerReplanInTransaction(transaction, workId, merged, { processing_message_ids: processing, processing: processingRequest });
}

/**
 * A queued marker may still carry the request being handled when the process
 * stopped: fold it into the queued one unless the Manager already answered it.
 */
function foldProcessingOwnerReplanInTransaction(transaction: CoreWriteLaneTransaction, workId: string): void {
  const row = transaction.get<{ response_json: string }>("SELECT response_json FROM idempotency_keys WHERE key = ?", ownerReplanKey(workId));
  let value: unknown = null;
  try {
    value = row ? JSON.parse(row.response_json) as unknown : null;
  } catch (error) {
    // Why not an Owner event: this runs inside a write-lane transaction, which cannot append events; the marker is left untouched so nothing is lost, and the log names the Work.
    console.error(`[owl-core] Owner replan marker of Work ${workId} is not valid JSON; leaving it as is`, error);
    return;
  }
  if (!isRecord(value) || value.status !== "queued" || typeof value.processing_answer !== "string") return;
  const ids = markerMessageIds(value.processing_message_ids);
  const answered = ids.length > 0 && ids.every((id) => transaction.get(
    "SELECT 1 FROM messages, json_each(json_extract(messages.metadata_json, '$.in_reply_to')) WHERE json_each.value = ? LIMIT 1",
    id,
  ));
  if (answered) {
    transaction.run(
      "UPDATE idempotency_keys SET response_json = json_remove(response_json, '$.processing_answer', '$.processing_kind', '$.processing_message_ids', '$.processing_requests') WHERE key = ?",
      ownerReplanKey(workId),
    );
  } else {
    requeueOwnerReplanInTransaction(transaction, workId);
  }
}

/** Undo `consumeOwnerReplan`: move an `attempted` marker back to `queued`. */
function requeueOwnerReplanInTransaction(transaction: CoreWriteLaneTransaction, workId: string): void {
  const row = transaction.get<{ response_json: string }>("SELECT response_json FROM idempotency_keys WHERE key = ?", ownerReplanKey(workId));
  let value: unknown = null;
  try {
    value = row ? JSON.parse(row.response_json) as unknown : null;
  } catch (error) {
    // Why not an Owner event: this runs inside a write-lane transaction, which cannot append events; the marker is left untouched so nothing is lost, and the log names the Work.
    console.error(`[owl-core] Owner replan marker of Work ${workId} is not valid JSON; leaving it as is`, error);
    return;
  }
  if (!isRecord(value)) return;
  if (value.status === "attempted") {
    transaction.run(
      `UPDATE idempotency_keys SET response_json = json_set(response_json, '$.status', 'queued') WHERE key = ?`,
      ownerReplanKey(workId),
    );
  } else if (value.status === "queued" && typeof value.processing_answer === "string" && typeof value.answer === "string") {
    // A newer request replaced the one being handled: process both together.
    const kind = (k: unknown) => (k === "instruction" || k === "work_update" ? k : null);
    queueOwnerReplanInTransaction(transaction, workId, {
      kind: kind(value.processing_kind) === "instruction" || kind(value.kind) === "instruction" ? "instruction"
        : kind(value.processing_kind) === "work_update" || kind(value.kind) === "work_update" ? "work_update"
          : value.kind as OwnerReplanRequest["kind"],
      answer: `${value.processing_answer}\n\n${value.answer}`,
      message_ids: [...new Set([...markerMessageIds(value.processing_message_ids), ...markerMessageIds(value.message_ids)])],
      requests: [
        ...ownerRequestsOf({ requests: value.processing_requests, kind: value.processing_kind, answer: value.processing_answer, message_ids: value.processing_message_ids }),
        ...ownerRequestsOf(value),
      ],
    });
  }
}

function requireAgentRunResult(value: unknown, operation: string): AgentRunResult {
  if (!isRecord(value) || (value.outcome !== "success" && value.outcome !== "failed" && value.outcome !== "partial")) {
    throw validationError(`The ${operation} result does not match the AgentRunner contract.`, { operation });
  }
  return value as unknown as AgentRunResult;
}

function normalizeManagerResult(value: unknown, mode: "finalize"): AgentRunResult {
  if (isRecord(value) && (value.outcome === "success" || value.outcome === "failed" || value.outcome === "partial")) {
    return value as unknown as AgentRunResult;
  }
  if (
    mode === "finalize" &&
    isRecord(value) &&
    Array.isArray(value.tasks) &&
    Object.prototype.hasOwnProperty.call(value, "event") &&
    Object.prototype.hasOwnProperty.call(value, "verdict")
  ) {
    return {
      outcome: "success",
      report_valid: true,
      report: { tasks: value.tasks, event: value.event, verdict: value.verdict },
      skill_feedback: (value.skill_feedback as AgentRunResult["skill_feedback"] | undefined) ?? null,
    };
  }
  throw validationError("The final Manager result does not match its declared runtime contract.", { mode });
}

function requireManagerReport(result: AgentRunResult, operation: string): JsonObject {
  if (result.outcome !== "success") {
    throw validationError(
      result.message
        ? `${operation} failed: ${result.message}`
        : `The ${operation} did not succeed.`,
      {
      outcome: result.outcome,
      error_key: result.error_key ?? null,
      },
    );
  }
  if (result.report_valid !== true || !result.report || typeof result.report !== "object" || Array.isArray(result.report)) {
    throw validationError(`The ${operation} must include a valid report object.`, { operation });
  }
  return result.report;
}

function requireManagerVerdict(value: unknown, workId: string): FinalManagerVerdict {
  if (!isRecord(value) || (value.verdict !== "complete" && value.verdict !== "incomplete")) {
    throw validationError("The final Manager verdict is invalid.", { work_id: workId });
  }
  if (
    typeof value.summary !== "string" ||
    !Array.isArray(value.missing) ||
    !value.missing.every(isFinalMissingItem) ||
    !Array.isArray(value.lessons) ||
    !value.lessons.every(isFinalLesson)
  ) {
    throw validationError("The final Manager verdict fields are invalid.", { work_id: workId });
  }
  return {
    verdict: value.verdict,
    summary: value.summary,
    missing: value.missing,
    unaddressed_backlog_items: (Array.isArray(value.unaddressed_backlog_items) ? value.unaddressed_backlog_items : []).flatMap(
      (entry: unknown) => isRecord(entry) && typeof entry.item_id === "string" && typeof entry.reason === "string" ? [{ item_id: entry.item_id, reason: entry.reason }] : [],
    ),
    lessons: value.lessons,
  };
}

/** Parse the Manager's open-Task actions (cancel / complete); absent means none. */
function managerTaskActions(value: unknown): readonly ReplanAction[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw validationError("The Manager task_actions must be an array.", {});
  return value.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.task_id !== "string" || entry.task_id.length === 0 ||
      (entry.action !== "cancel" && entry.action !== "complete") ||
      typeof entry.reason !== "string"
    ) {
      throw validationError("The Manager task_actions entry is invalid.", { index });
    }
    return { task_id: entry.task_id, action: entry.action, reason: entry.reason };
  });
}

function managerTasksToPlanItems(
  value: unknown,
  workId: string,
  { allowEmpty }: { readonly allowEmpty: boolean },
): readonly TaskPlanItem[] {
  if (!Array.isArray(value)) {
    throw validationError("The Manager plan tasks must be an array.", { work_id: workId });
  }
  if (value.length === 0 && !allowEmpty) {
    throw validationError("The Manager plan must contain at least one Task.", { work_id: workId });
  }
  const allowedTypes = new Set(["research", "design", "code", "config", "doc", "test"]);
  const allowedPriorities = new Set(["low", "normal", "high", "critical"]);
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw validationError("The Manager plan contains a non-object Task.", { work_id: workId, index });
    }
    const id = nonEmptyString(candidate.id, "id", index);
    const candidateWorkId = candidate.work_id;
    if (candidateWorkId !== undefined && candidateWorkId !== "" && candidateWorkId !== workId) {
      throw validationError("The Manager plan contains a Task for another Work.", { work_id: workId, task_id: id });
    }
    const type = nonEmptyString(candidate.type, "type", index);
    if (!allowedTypes.has(type)) {
      throw validationError("The Manager plan contains an unsupported Task type.", { work_id: workId, task_id: id, type });
    }
    const dependencies = candidate.depends_on;
    if (!Array.isArray(dependencies) || dependencies.some((dependency) => typeof dependency !== "string" || dependency.length === 0)) {
      throw validationError("The Manager plan Task dependencies are invalid.", { work_id: workId, task_id: id });
    }
    const context = candidate.context;
    if (context !== undefined && typeof context !== "string") {
      throw validationError("The Manager plan Task context must be a string.", { work_id: workId, task_id: id });
    }
    const notes = candidate.notes;
    if (notes !== undefined && typeof notes !== "string") {
      throw validationError("The Manager plan Task notes must be a string.", { work_id: workId, task_id: id });
    }
    const review = candidate.review;
    if (review !== undefined && typeof review !== "boolean") {
      throw validationError("The Manager plan Task review field must be a boolean.", { work_id: workId, task_id: id });
    }
    const specLists = (["required_sections", "required_tests"] as const).map((field) => {
      const list = candidate[field];
      if (list === undefined) return undefined;
      if (!Array.isArray(list) || list.length > 20 || list.some((entry) => typeof entry !== "string" || entry.length < 1 || entry.length > 200)) {
        throw validationError(`The Manager plan Task ${field} must be at most 20 strings of 1 to 200 characters.`, { work_id: workId, task_id: id });
      }
      return list as string[];
    });
    const parentTaskId = candidate.parent_task_id;
    if (parentTaskId !== undefined && parentTaskId !== null && typeof parentTaskId !== "string") {
      throw validationError("The Manager plan parent Task id is invalid.", { work_id: workId, task_id: id });
    }
    const priority = candidate.priority;
    if (priority !== undefined && (typeof priority !== "string" || !allowedPriorities.has(priority))) {
      throw validationError("The Manager plan Task priority is invalid.", { work_id: workId, task_id: id });
    }
    const managerTaskId = candidate.manager_task_id;
    if (managerTaskId !== undefined && (typeof managerTaskId !== "string" || managerTaskId.trim().length === 0)) {
      throw validationError("The Manager plan manager_task_id is invalid.", { work_id: workId, task_id: id });
    }
    const replaces = candidate.replaces;
    if (!Array.isArray(replaces) || replaces.some((replaced) => typeof replaced !== "string" || replaced.trim().length === 0)) {
      throw validationError("The Manager plan Task replaces must be an array of Task ids.", { work_id: workId, task_id: id });
    }
    const necessity = parseTaskNecessity(candidate.necessity);
    // Structured criteria are kept as written; plan quality checks their fields. Only a Task that comes without any is read from its free-text acceptance.
    const criteria = Array.isArray(candidate.acceptance_criteria) ? candidate.acceptance_criteria as AcceptanceCriterion[] : undefined;
    const item: TaskPlanItem = {
      id,
      title: nonEmptyString(candidate.title, "title", index),
      type,
      acceptance: criteria !== undefined && acceptanceCriteriaProblems(criteria).length === 0 ? renderAcceptanceCriteria(criteria) : nonEmptyString(candidate.acceptance, "acceptance", index),
      ...(criteria === undefined ? {} : { acceptance_criteria: criteria }),
      ...(review === undefined ? {} : { review }),
      ...(specLists[0] === undefined ? {} : { required_sections: specLists[0] }),
      ...(specLists[1] === undefined ? {} : { required_tests: specLists[1] }),
      depends_on: dependencies,
      necessity,
      ...(context === undefined && notes === undefined && necessity === null
        ? {}
        : { plan_context: { context: context === undefined || context === "" ? null : context, notes: notes === undefined || notes === "" ? null : notes, necessity } satisfies TaskPlanContext, context: [context, typeof notes === "string" && notes.length > 0 ? `Manager notes:\n${notes}` : undefined, necessity === null ? undefined : renderTaskNecessity(necessity)].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n\n") }),
      ...(parentTaskId === undefined ? {} : { parent_task_id: parentTaskId }),
      ...(priority === undefined ? {} : { priority: priority as TaskPlanItem["priority"] }),
      ...(managerTaskId === undefined ? {} : { manager_task_id: managerTaskId }),
      replaces: replaces as string[],
      // Shape-checked by validateReplan (validateWaitFor); here it only travels with the item.
      ...(candidate.wait_for === undefined || candidate.wait_for === null ? {} : { wait_for: candidate.wait_for as unknown as PlanWaitFor }),
      ...(candidate.base_sync_only === undefined || candidate.base_sync_only === null ? {} : { base_sync_only: baseSyncOnly(candidate.base_sync_only, index) }),
    };
    return item;
  });
}

function baseSyncOnly(value: unknown, index: number): boolean {
  if (typeof value !== "boolean") throw validationError("The Manager plan Task base_sync_only must be a boolean or null.", { field: "base_sync_only", index });
  return value;
}

function nonEmptyString(value: unknown, field: string, index: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`The Manager plan Task ${field} must be a non-empty string.`, { field, index });
  }
  return value;
}

class ReplayCommand extends Error {
  public constructor(public readonly response: CommandResponse) {
    super("idempotent command replay");
    this.name = "ReplayCommand";
  }
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
