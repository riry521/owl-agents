import { clearOwnerReplanProcessing, deleteOwnerReplan, flagManagerTrigger, listQueuedReplanTasks, readManagerTrigger, readOwnerReplan, setManagerTriggerStatus, setOwnerReplanStatus, writeOwnerReplan, type ReplanMarkerStatus } from "./replan-queue-store.js";
import { LIVE_AGENT_RUN_STATUSES, setAgentRunStatus } from "./agent-run-state.js";
import { createHash } from "node:crypto";
import { AdvisorActions } from "./advisor-actions.js";
import { serenaConfigPath, unregisterSerenaProject } from "./serena-registry.js";
import { createHash as createFileHash } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createUlid, utcNow } from "../../db/dist/index.js";
import { insertProviderError, listProviderErrors } from "./provider-error-store.js";
import type { StoredProviderError } from "./types.js";
import { DecisionService, type OpenDecisionPayload } from "./decision";
import { DesignMockStore, type DesignMockSummary } from "./design-mocks";
import { OwnerFilesReader, type OwnerFileOpened, type OwnerFileRoot } from "./owner-files.js";
import { DEFAULT_WORK_MARKDOWN_LIMITS, WorkMarkdownReader, type WorkMarkdownDocument } from "./work-markdown.js";
import { DECISION_CANCEL_OPTION_KEY, managerReplanFailureBrief, prerequisiteExpiredBrief, RESOLVE_CONFLICT_OPTION_KEY, type ReplanFailureCause } from "./decision-brief";
import { evaluatePrerequisite, type PrerequisiteFacts } from "./prerequisite-monitor";
import {
  evaluateWorkPrerequisitesInTransaction,
  hasOpenWorkPrerequisiteDecision,
  replaceWorkPrerequisitesInTransaction,
  settleWorkPrerequisiteWaitInTransaction,
  snapshotDeletedPrerequisiteInTransaction,
  waitingWorkIds,
  workPrerequisiteViews,
} from "./work-prerequisites";
import type { WorkPrerequisiteView } from "../../shared/dist/work-prerequisite.js";
import type { AcceptanceDefect } from "../../shared/dist/acceptance-defect.js";
import type { DecisionAnswerRoute, DecisionCriterionRewrite } from "../../shared/dist/decision-explanation.js";
import { isFinalLesson, isFinalMissingItem, normalizeLesson, parseLessonBlocks, type FinalManagerVerdict } from "./final-verdict";
import { outputResubmitLimit } from "./report-resubmit";
import { DEFAULT_OWNER_LANGUAGE, OWNER_LANGUAGE_SETTINGS_KEY, ownerLanguage, storedOwnerLanguage, type OwnerLanguage, type SettingsReader } from "./owner-language";
import { EventDispatcher } from "./event-dispatcher";
import { HumanReadableError, dependencyUnavailable, idempotencyConflict, invalidStateTransition, notFound, projectDeletionImpactChanged, projectHasRunningWorks, projectNotFound, providerPauseNotFound, projectPathConflict, validationError, versionConflict, workCancelled, workProjectAlreadySet, workReopenRequired } from "./errors";
import {
  appendEventInTransaction,
  createWorkInTransaction,
  detachProjectWorksInTransaction,
  ensureOwner,
  isDecisionCancelAnswer,
  isTerminalTaskState,
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
import { saveProjectlessWorkOutputs } from "./outputs-store.js";
import { isDesignHanded, markDesignsHanded } from "./design-handoff-store";
import { attachWorkToProjectInTransaction } from "./state-reducer";
import {
  activeAutoRecoveries, criteriaRelaxationsOfWork, autoRecoveryForManager, autoRecoveryLimit, autoRecoverySummary, autoRecoveryUsed, immediateDecisionReason,
  recordAutoRecoveryInTransaction, startAutoRecoveryInTransaction, transientRecoveryPendingUntil,
  transientRecoveryResumeAt, withAutoRecoveryTried,
} from "./auto-recovery";
import { fixPendingTaskIds } from "./fix-pending-tasks.js";
import { finalCriteriaIndex, goalShortfallsOfWork, readTaskGoalShortfalls, recordFinalGoalShortfalls, settleFinalVerdict, type FinalCriterionRef, type SettledFinalVerdict } from "./goal-shortfalls";
import { detectNewRepositories, type NewRepositoryCandidate } from "./new-repository-detection.js";
import { clearPausedReviewerWait } from "./provider-pause-reviewer-wait.js";
import { assertAgentRunNotStopped, isAgentRunStopped } from "./agent-run-stop.js";
import { WorkflowEngine, resolveRoleModel, mergeConflictPaths, type HookSubagentInput } from "./workflow-engine";
import { isPlanRejection, validatePlan, validateReplan, type PlannedApproach, type PlanRejection, type ReplanAction, type ReplanPlan, type ReplanSnapshot } from "./replan-plan";
import type { PlanWaitFor, PrerequisiteCondition, PrerequisiteSpec } from "../../shared/dist/prerequisite.js";
import { isPidAlive, isProcessGroupAlive, signalProcessGroup } from "../../shared/dist/process-group.js";
import { KnowledgeBase } from "./knowledge-base";
import { archiveLegacyKnowledge } from "./memory/knowledge-archive.js";
import { ChildEmbedder, loadEmbedderConfig } from "./memory/embedder.js";
import { MemoryService, type MemoryReindexOutput } from "./memory/memory-service.js";
import { advisorKey, DEFAULT_MEMORY_READ_LIMITS, MemoryReadLedger, type MemoryReadLimits, type RoleReadLimit } from "./memory/memory-read-ledger.js";
import type { KnowledgeSearchResult } from "./knowledge-base";
import { KnowledgeLocation, type KnowledgeMoveMode, type KnowledgeMoveResult, type KnowledgeStorageStatus } from "./knowledge-location";
import { KnowledgeNotes } from "./knowledge-notes.js";
import { createClaudeUsageSource } from "./plan-usage/claude-source.js";
import { createCodexSessionLogSource } from "./plan-usage/codex-source.js";
import { GitProjectSourceReader, INVESTIGATION_MARKER, ProjectOverviewService, collectFacts, thinMetrics, thinReasons, type ProjectInvestigationInput, type ProjectInvestigationResult, type ProjectOverviewInput, type ProjectSourceReader } from "./project-overview-note.js";
import { IndexInjector } from "./memory/index-injector.js";
import { ResearchRecall } from "./memory/research-recall.js";
import { PageRouter, writePage } from "./memory/page-router.js";
import { assertValidPage, MATERIALS_DIR } from "./memory/page-format.js";
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
import { RulePairJudge, type RuleJudgmentRunner } from "./rule-judge.js";
import { RuleProposals,type RuleProposalStatus, type RuleProposalTidyResult } from "./rule-proposals.js";
import { RuleWriter } from "./rule-writer.js";
import { DEFAULT_SKILL_FEEDBACK_WEIGHTS, detectSkillReads, SkillBox, type SkillSettings, type SkillState } from "./skill-box";
import { isValidSkillScope, validateSkillFilePath, validateSkillName } from "./skill-files";
import { SKILL_CURATOR_DEBOUNCE_MS, SkillCurator, type SkillCurationResult } from "./skill-curator";
import { AdvisorSessionManager } from "./advisor-session.js";
import {
  advisorActionFingerprint, advisorActionNeedsApproval, advisorActionTarget, buildAdvisorActionFailure, loadFollowupRetries,
  loadSourceFailures, nextTurnOf, planFollowupActions, stableJson, type AdvisorActionFailure, type AdvisorFailureDetails, type FollowupCandidate,
} from "./advisor-followup.js";
import { advisorWorkId, parseAdvisorWorkOperationPayload } from "./advisor-work-payload.js";
import { AdvisorSessionNotFoundError, AdvisorSessionRuntime, type AdvisorSettingsSnapshot } from "./advisor-runtime.js";
import { routeExplicitMemory } from "./memory/explicit-memory.js";
import { slugifyKnowledgeNameOrNull } from "./knowledge-naming.js";
import { autoWorkDbToggle, type AutoWorkSettingsValue, type AutoWorkSignal, type SessionActivity } from "@owl/shared";
import { AutoWorkConfigLoader } from "./auto-work/config.js";
import { AutoWorkService } from "./auto-work/service.js";
import { AutoWorkStore } from "./auto-work/store.js";
import { ScheduledCheckTrigger } from "./auto-work/triggers/scheduled-check.js";
import {
  AUTO_WORK_LIST_LIMIT, AUTO_WORK_RULES_DIR, buildAutoWorkSettingsData, toAutoWorkEventDetailView, toAutoWorkEventView,
  type AutoWorkEventFilter,
} from "./auto-work/views.js";
import { FailureWatchTrigger, readFailureNotice, spawnAutoWorkCommand } from "./auto-work/triggers/failure-notice.js";
import { createGhRunner, GithubTrigger } from "./auto-work/triggers/github.js";
import { LibrarianScheduler, localDayKey, parseLibrarianTime } from "./librarian-scheduler.js";
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
import { buildCurationNotice, curationNoticeWrite, curationReportFailure, summarizeCurationReport, type CurationNotice, type CurationNoticeEntry } from "./curation-summary.js";
import { reviewLimits } from "./review-limits.js";
import { dependencySummarySettings } from "./dependency-summary-settings.js";
import { advisorWindowSettings } from "./advisor-window-settings.js";
import {
  ensureGeneralWindowInTransaction,
  ensureWebAccount,
  ensureProjectWindowInTransaction,
  findAdvisorWindow,
  latestReply,
  listAdvisorWindows,
  replyPosition,
  type AdvisorWindowRef,
} from "./advisor-windows.js";
import {
  type AdvisorWindowSettings,
} from "../../shared/dist/advisor-window-settings.js";
import { GENERAL_WINDOW_KEY, type AdvisorWindowChannel, type AdvisorWindowSummary } from "../../shared/dist/advisor-windows.js";
import {
  type DependencySummarySettings,
} from "../../shared/dist/dependency-summary-settings.js";
import {
  VerificationPolicySettingsValidationError,
  VERIFICATION_POLICY_SETTINGS_KEY,
  validateVerificationPolicyPatch,
  readVerificationPolicySettings,
  type VerificationPolicyPatch,
  type VerificationPolicySettings,
} from "../../shared/dist/verification-policy-settings.js";
import { remakeLimits } from "./remake-limits.js";
import { fixerEscalation } from "./fixer-escalation.js";
import { autoRecoverySettings, openCriteriaStatuses } from "./auto-recovery.js";
import { appendRuleSection, RULE_SECTION_HEADING, toJsonResults, type CriterionCheckResult } from "./criterion-checks";
import {
  type FixerEscalationSettings,
} from "../../shared/dist/fixer-escalation-settings.js";
import {
  type AutoRecoverySettings,
} from "../../shared/dist/auto-recovery-settings.js";
import { progressGuard } from "./progress-guard.js";
import { DecisionAnswerTriage, answerTriageTarget } from "./decision-answer-triage";
import { DecisionExplainer, toDecisionExplanation } from "./decision-explainer";
import { FinalReporter, readFinalReport } from "./final-report";
import { metricsRuleCandidates, proposeFromMetrics } from "./learning-metrics.js";
import { learningMetrics } from "./learning-metrics-settings.js";
import {
  type ProgressGuardSettings,
} from "../../shared/dist/progress-guard-settings.js";
import { evaluateRemakeGate } from "./remake-gate.js";
import { lineagePartialReportPayloads, lineageRootOf, lineageUsage, restartLineageBudgetInTransaction } from "./task-lineage.js";
import { remakeLimitBrief, type RemakeLimitReason } from "./decision-brief.js";
import {
  type RemakeLimitSettings,
} from "../../shared/dist/remake-limit-settings.js";
import { reviewRouting, workVerification } from "./assurance-settings.js";
import { evaluateCriteriaRelaxation, evaluatePlanQuality, formatPlanQualityReason, planQualityOutcome, repairableWarnings, type PlanQualityOutcome, type PlanQualityWarning, type PreviousOutputFeedback } from "./plan-quality.js";
import { planQualitySettings } from "./plan-quality-settings.js";
import { projectInvestigationOutputSettings } from "./project-investigation-settings.js";
import {
  type PlanQualitySettings,
} from "../../shared/dist/plan-quality-settings.js";
import {
  type ReviewRoutingSettings,
} from "../../shared/dist/review-routing-settings.js";
import { reviewMetrics, type ReviewMetrics } from "./review-metrics.js";
import {
  type ReviewLimitSettings,
} from "../../shared/dist/review-limit-settings.js";
import { PlanUsageService } from "./plan-usage/service.js";
import { PlanUsageStore } from "./plan-usage/store.js";
import {
  DEFAULT_PLAN_USAGE_SETTINGS,
  PLAN_USAGE_SETTINGS_KEY,
  readPlanUsageSettings,
  validatePlanUsageSettings,
  type PlanUsageSettings,
  type PlanUsageView,
} from "../../shared/dist/plan-usage-settings.js";
import type { PlanUsageSnapshot, PlanUsageSource } from "../../shared/dist/plan-usage.js";
import {
  DEFAULT_KNOWLEDGE_AUTOMATION_SETTINGS,
  KNOWLEDGE_AUTOMATION_SETTINGS_KEY,
  OPENCODE_HARNESS_GAPS,
  readKnowledgeAutomationSettings as parseKnowledgeAutomationSettings,
  validateKnowledgeAutomationSettings,
  type KnowledgeAutomationSettings,
  type KnowledgeAutomationSnapshot,
} from "@owl/shared";
import { CHILD_RUN_SETTINGS_KEY, HYBRID_MODE_SETTINGS_KEY } from "./types";
import {
  DEFAULT_OWNER_ID,
  readSetting,
  saveSetting,
  storedSettingJson,
  storedSettingRow,
  upsertSetting,
  type SettingSaveSpec,
  type SettingSpec,
} from "./settings-store";
import { ADVISOR_WINDOW_SETTING } from "./advisor-window-settings.js";
import { REVIEW_LIMIT_SETTING } from "./review-limits.js";
import { DEPENDENCY_SUMMARY_SETTING } from "./dependency-summary-settings.js";
import { PROGRESS_GUARD_SETTING } from "./progress-guard.js";
import { REMAKE_LIMIT_SETTING } from "./remake-limits.js";
import { FIXER_ESCALATION_SETTING } from "./fixer-escalation.js";
import { AUTO_RECOVERY_SAVE } from "./auto-recovery.js";
import { PLAN_QUALITY_SETTING } from "./plan-quality-settings.js";
import { REVIEW_ROUTING_SETTING } from "./assurance-settings.js";
import type { AdvisorWorkspacePreparation, CriterionCheck, RuleApplicability } from "./types";
import { CoreActivityRegistry } from "./core-activity.js";
import { GitWorktreeGateway } from "./git-gateway.js";
import { clearWorkGitTemplates } from "./work-git-template.js";
import { defaultOwlRoot, safeSegment, WorkspaceLayout } from "./workspace-layout.js";
import { parseVerificationMarker, WorkspaceProcessSweeper, type SweepRunInfo, type WorkspaceActivity } from "./workspace-process-sweeper.js";
import { WorkspaceTooling, runCommand } from "./workspace-tooling.js";
import { DEFAULT_POST_MERGE_DEPENDENCY_FILES, DEFAULT_POST_MERGE_INSTALL_RULES, POST_MERGE_COMMAND_TIMEOUT_MS, PostMergeCommandQueue, postMergeResultEvent, redactArgv, type PostMergeInstallRule, type PostMergeRunOutcome, type ResolvedPostMergeCommand } from "./post-merge-command.js";
import { AgentWorkspacePreparer, withWorkspacePreparation, worktreeHarnesses } from "./agent-workspace-preparer.js";
import { redactCredentials } from "./git-push.js";
import { recoverOrphanedState } from "./startup-recovery.js";
import { COMPLETED_PROJECT_WORKS_SQL } from "./completed-project-works-query.js";
import { cleanupWorkForDeletion, reconcileWorktrees, recordedWorktreeBlock, type WorktreeReconcileFailure } from "./worktree-reconciler.js";
import { processIdentityMatches, readProcessIdentity } from "./process-identity.js";
import { formatRuntimeFailure } from "./error-display.js";
import { ADVISOR_TEXT, workRef } from "./advisor-text.js";
import { MAX_MESSAGE_ATTACHMENTS, MAX_UPLOAD_BYTES } from "./upload-limits.js";
import { assertMessageAttachmentsInTransaction, messageAttachmentViews, resolveMessageAttachments, type MessageAttachmentView } from "./message-attachments.js";
import { INSTRUCTION_REPLY_TEXT, type ReplanSummary } from "./instruction-reply-text.js";
import { ownerGuidance } from "./owner-guidance.js";
import { failedTaskBrief, pendingAcceptanceDefect, pendingExternalBlocker } from "./task-context.js";
import { resolveAdvisorFileDestination, type FileDestinationChannel, type FileDestinationRefusal, type FileDestinationResult, type FileDestinationSource } from "./advisor-file-destination.js";
import { DEFAULT_ADVISOR_SEND_FILE_MAX_BYTES, formatSendFileSize, prepareAdvisorSendFile, sendFileNotice, type AdvisorOutboundFile, type AdvisorSendFileSettings } from "./advisor-send-file.js";
import { planContextFields } from "./context-builder.js";
import { detectProcessSkillsPack, type DetectedProcessSkillsPack } from "./process-skills-pack.js";
import { ResearchRecorder, type ResearchAttributionRole } from "./research-recorder.js";
import { buildTokenUsageReport, countRequestsOverThreshold, type RequestThresholdCount } from "./token-usage-report.js";
import type { TokenUsagePeriod, TokenUsageReport } from "../../shared/dist/token-usage-report.js";
import { RESEARCH_CAPTURE_ROLES } from "../../shared/dist/permission-args.js";
import {
  ADVISOR_CALL_API_ACTION_TYPE,
  ADVISOR_SEND_FILE_ACTION_TYPE,
  ADVISOR_WINDOW_ACTION_TYPES,
  validateWindowHandoffPayload,
  ADVISOR_WORK_OPERATION_ACTION_TYPES,
  parseAdvisorCallApiPayload,
parseAdvisorCallApiRequestShape,
  redactProviderOutput,
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
validatePrerequisiteWorkIds,
  advisorCurationKind,
  builtinProviderHarness,
  type ModelHarness,
  CHILD_RUN_EFFORTS,
  CHILD_RUN_PROVIDERS,
  splitOpencodeModel,
  CODEX_BUILTIN_MODELS,
  DEFAULT_CHILD_RUN_SETTINGS,
  CHILD_RUN_LIMITS,
  tokenRelaySettingsProblem,
  DEFAULT_HARNESS_MODELS,
  DEFAULT_ROLE_MODELS,
  MODEL_SETTING_ROLES,
  MODEL_SETTING_EFFORTS,
  MODEL_PRESET_NAME_MAX_LENGTH,
  PROJECT_LOCKING_WORK_STATES,
  designDocumentPath,
  taskReportPath,
  isRuleRole,
  PROCESS_SKILLS_INSTALL_COMMANDS,
  PROCESS_SKILLS_PROMPT_FILES,
  PROCESS_SKILLS_SETTINGS_KEY,
  usageJson,
  workSummaryInstruction,
  workSummaryLabel,
  WORK_SUMMARY_SECTIONS,
  type ProcessSkillsSettings,
  type GuardTokenAgent,
  type WebResearchCapture,
  type ChildDispatchRequest,
  type ChildDispatchResponse,
  type ChildRunEffort,
  type ChildRunHarnessChoice,
  type ChildRunListFilter,
  type ChildRunProvider,
  type ChildRunRecord,
  type ChildRunSettings,
  type ChildWaitRequest,
  type ChildWaitResponse,
} from "@owl/shared";
import { createProviderPauseStore, type ProviderPauseRow, type ProviderPauseStore } from "./provider-pause-store";
import { createProviderPauseController, rethrowUnlessRateLimited, type ProviderPauseController, type ProviderPauseEvent } from "./provider-pause-controller";
import { coreTestRunBrief, workTestRunner } from "./core-test-run";
import { TEST_SETUP_MANUAL_TRIGGER, TestSetupService } from "./test-setup-service.js";
import { QUARANTINE_FIX_TASK_PREFIX } from "./test-quarantine";
import { UI_CHANGE_LEVELS, type BaseMergeConflict, type ManagerTrigger, type WorkerQuestion } from "@owl/shared";
import { stripFullTestCriteria, isFullTestCriterion, acceptanceCriteriaProblems, isManagerCriterion, parseTaskNecessity, readStoredAcceptanceCriteria, readStoredTaskPlanContext, renderAcceptanceCriteria, renderTaskNecessity, type AcceptanceCriterion, type CriteriaRelaxation, type StoredAcceptanceCriterion, type TaskPlanContext, resolveInstanceId, type AdvisorSuggestedAction, type ProcessSkillsInstallCommand, type ProviderClient } from "@owl/shared";
import { MEMORY_LIBRARIAN_BATCH_SETTINGS_KEY, MEMORY_RECALL_LIMIT_SETTINGS_KEY, MEMORY_RECALL_MIN_SIMILARITY_SETTINGS_KEY, readMemoryLibrarianBatch, readMemoryRecallLimit, readMemoryRecallMinSimilarity, type MemoryLibrarianBatch } from "@owl/shared";
import { EXTERNAL_DATA_POLICY, externalJsonBlock, MEMORY_ARCHIVE_SETTINGS_KEY, readMemoryArchive, REVIEW_RERUN_OPTION_KEY, TEST_SETUP_APPROVE_OPTION_KEY, TEST_SETUP_RETRY_OPTION_KEY } from "@owl/shared";
import { approveOutsideInstalls } from "./test-environment";
import { runArgvOf, validateTestRunSettings } from "../../shared/dist/test-run-settings.js";
import { readTestPolicy, validateTestPolicy } from "../../shared/dist/test-policy.js";
import { verificationPolicySettings } from "./task-verification-policy.js";
import { resolveTestRun } from "./test-detection.js";
import { explicitTestRunDigest, readStoredTestSetup, testSetupView } from "./test-setup.js";
import { testSetupSettings } from "./test-setup-settings.js";
import { resolveCloneRoot } from "./clone-root";
import { cloneBaseline, cloneUses } from "./clone-check.js";
import { classifyInstallCommand, execInstallQuery, outsideWriteTargets, resolveInstallTarget, TestSetupRunRegistry, type InstallQuery, type TestSetupRunEntry } from "./test-setup-install-guard.js";
import { GUARD_PATH_KEYS, GUARD_SHELL_COMMAND_KEYS, GUARD_SHELL_TOOL_NAMES, READ_ONLY_TOOL_NAMES } from "../../shared/dist/guard-inputs.js";
import { canonicalizePath } from "./command-analysis.js";
import { matchesGlobWithDots } from "./glob.js";
import { designsScreens, type UiChange } from "../../shared/dist/design-documents.js";
import { screenCreationTargets, screenDesignRequiredMessage, type FsView, type ScreenPathCheck } from "./screen-path-guard.js";
import { matchDeniedCommand, reviewerDeniedCommands, REVIEWER_TEST_COMMAND_DENIED_MESSAGE, type ReviewerTestCommandCheck } from "./reviewer-test-guard.js";
import { createChildRunScheduler, type ChildRunScheduler } from "./child-run-scheduler.js";
import { TRANSIENT_RETRY_LIMIT } from "./attempt-policy.js";
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
  WorkflowSnapshot,
  GitGateway,
  WorktreeCleanupResult,
  GitPushFailure,
  GitPushResult,
  GitWorkMergeResult,
  WorkBranchVerification,
} from "./types";
import { Core, INITIAL_PLAN_MAX_ATTEMPTS, delay, INITIAL_PLAN_RETRY_DELAY_MS, WorkDbRow, StoppableRun, isRecordedProcessGone, AGENT_STOP_WAIT_MS, OWNER_STOP_CONFIRM_FACTOR, isRecord, WorkNotRunningAbort, parseStringArray, managerTaskView, storedVerificationSpec, mergeConflictFiles, insertInstructionReply, firstLine, humanizeUnexpected, parseStoredJsonObject, FinalManagerOutcome, FINAL_MANAGER_MAX_ATTEMPTS, finalManagerErrorResult, extractManagerRequestIds, MANAGER_PAUSED_AT_START, addManagerRules, sideEffectFailureFields, SIDE_EFFECT_FAILURE_PREFIX, isRateLimitedAgentRunResult, extractManagerWorkRules } from "./core.js";

/**
 * The Manager's command center (initial plan, replan, final check, Owner instructions and stops, prerequisite waits),
 * moved out of Core without changing behaviour. It reaches Core's services through `host`; the Core members it uses
 * are not `private` for that reason.
 */
export class ManagerOrchestrator {
  constructor(private readonly host: Core) {}

  /**
   * Works with a Manager replan in progress. Owner answers that should drive
   * a replan are persisted (owner_replan_requests) so they survive a restart.
   */
  readonly replansInFlight = new Set<string>();
  /** Last gate-failure message already reported per Work, so a persisting failure is announced once. */
  readonly loopGateFailures = new Map<string, string>();
  /** When each prerequisite wait was last evaluated (memory only, so a restart evaluates at once). */
  readonly prerequisiteCheckedAt = new Map<string, number>();
  /** Works whose waiting Tasks must be evaluated on the next tick regardless of the interval. */
  readonly prerequisiteRecheck = new Set<string>();
  /** Wake keys already sent, so a finished source does not wake its waiters on every tick. */
  readonly prerequisiteWoken = new Set<string>();

  /**
   * A Manager call that ended in a temporary provider error after its in-call retries: while a recovery is left,
   * records a counted wait (no Decision) and returns true so the caller requeues; false escalates as before.
   */
  async recoverManagerTransient(workId: string, result: AgentRunResult, runId: string): Promise<boolean> {
    if (result.outcome === "success" || result.failure_class !== "transient") return false;
    const errorKey = result.error_key ?? "provider_transient";
    if (errorKey.startsWith("provider_failed:timeout:")) return false;
    const started = await this.host.writeLane.transact((transaction: CoreWriteLaneTransaction) => startAutoRecoveryInTransaction(transaction, {
      kind: "provider_transient",
      target: { kind: "work", id: workId },
      workId,
      action: "wait_and_rerun",
      sourceEventId: runId,
      previousFailure: { summary: result.message ?? errorKey, error_key: errorKey, detail: result.message ?? null },
      resumeAt: transientRecoveryResumeAt,
    }));
    return started !== null;
  }

  /** The plan feedback of a quality rejection that was turned into an automatic retry and has not been answered by a plan yet. */
  pendingPlanFeedback(workId: string): PreviousOutputFeedback | null {
    const row = this.host.db.get<{ detail: string | null }>(
      `SELECT json_extract(payload_json, '$.previous_failure.detail') AS detail FROM events
        WHERE type = 'recovery.started' AND json_extract(payload_json, '$.kind') = 'plan_quality_rejected'
          AND json_extract(payload_json, '$.target_kind') = 'work' AND json_extract(payload_json, '$.target_id') = ?
          AND sequence > COALESCE((SELECT MAX(sequence) FROM events WHERE work_id = ? AND type IN ('work.planned', 'task.replanned')), 0)
        ORDER BY sequence DESC LIMIT 1`,
      workId,
      workId,
    );
    if (!row?.detail) return null;
    try {
      return JSON.parse(row.detail) as PreviousOutputFeedback;
    } catch {
      return null;
    }
  }

  /** A plan the quality check finally rejected: while a recovery is left, keeps the last feedback for the next Manager call instead of opening a Decision. */
  async recoverPlanQuality(workId: string, feedback: PreviousOutputFeedback | null, runId: string): Promise<boolean> {
    if (feedback === null) return false;
    const started = await this.host.writeLane.transact((transaction: CoreWriteLaneTransaction) => startAutoRecoveryInTransaction(transaction, {
      kind: "plan_quality_rejected",
      target: { kind: "work", id: workId },
      workId,
      action: "retry_plan",
      sourceEventId: runId,
      previousFailure: { summary: feedback.kind, error_key: feedback.kind, detail: JSON.stringify(feedback) },
    }));
    return started !== null;
  }

  /**
   * The one inspection loop of a Manager plan, used by the initial plan and the replan. It calls the Manager
   * (invoke), parses the answer, validates it (validate), runs the quality check and hands rejections back to the
   * Manager up to plan_rejection_attempts_max calls. When the calls are used up it tries recoverPlanQuality and
   * otherwise returns "rejected", so the caller opens a Decision. The callers differ only in invoke, parse, validate
   * and onRejected; the order of the checks is the same for both.
   */
  async inspectManagerPlan<V, P extends { items: readonly TaskPlanItem[] }>(opts: {
    workId: string;
    phase: "plan" | "replan";
    ownerReplan: OwnerReplanRequest | null;
    /** One Manager call. Null means the caller handled the result itself and the loop must stop. */
    invoke: (attempt: number, feedback: PreviousOutputFeedback | null) => Promise<{ report: JsonObject; runId: string } | null>;
    /** Throws a validation_error for a malformed answer (handed back to the Manager); any other error is returned as "fatal". */
    parse: (report: JsonObject) => P;
    /** { errors, feedback? } is a rejection; null stops the loop. */
    validate: (parsed: P, attempt: number) => Promise<{ value: V } | { errors: readonly string[]; feedback?: PreviousOutputFeedback } | null>;
    onRejected: (attempt: number, runId: string, feedback: PreviousOutputFeedback, errors: readonly string[]) => Promise<void>;
  }): Promise<
    | { kind: "accepted"; value: V; parsed: P; runId: string }
    | { kind: "stopped" }
    | { kind: "recovered" }
    | { kind: "fatal"; error: unknown }
    | { kind: "rejected"; errors: readonly string[]; attempts: number }
  > {
    const { workId } = opts;
    let feedback: PreviousOutputFeedback | null = this.pendingPlanFeedback(workId);
    let errors: readonly string[] = [];
    let lastRunId = "";
    const quality = planQualitySettings(this.host.db);
    const maxAttempts = progressGuard(this.host.db).plan_rejection_attempts_max;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const invoked = await opts.invoke(attempt, feedback);
      if (invoked === null) return { kind: "stopped" };
      const { report, runId } = invoked;
      lastRunId = runId;
      const reject = async (next: PreviousOutputFeedback, why: readonly string[]): Promise<void> => {
        feedback = next;
        errors = why;
        await opts.onRejected(attempt, runId, next, why);
      };
      let parsed: P;
      try {
        parsed = opts.parse(report);
      } catch (error) {
        const parseFeedback = planParseFeedback(error);
        if (parseFeedback === null) return { kind: "fatal", error };
        await reject(parseFeedback, parseFeedback.errors);
        continue;
      }
      const validated = await opts.validate(parsed, attempt);
      if (validated === null) return { kind: "stopped" };
      if ("errors" in validated) {
        await reject(validated.feedback ?? { kind: "plan_rejected", errors: validated.errors, warnings: [] }, validated.errors);
        continue;
      }
      const found = quality.enabled ? evaluatePlanQuality(parsed.items, quality, this.ownerQuoteTexts(workId, opts.ownerReplan), this.workSummaryText(workId)) : [];
      // Missing fields are a format error: rejected with a fields-only reason, not counted as a quality repair.
      const formatWarnings = found.filter((warning) => warning.code === "criterion_field_missing");
      const warnings = formatWarnings.length > 0 ? [] : found;
      const outcome = warnings.length > 0 ? planQualityOutcome(warnings, attempt >= maxAttempts, quality) : null;
      if (outcome !== null) await this.recordPlanQualityWarned(workId, opts.phase, attempt, runId, warnings, outcome);
      if (formatWarnings.length > 0) {
        await reject({ kind: "fields_missing", errors: [], warnings: formatWarnings }, [formatPlanQualityReason(formatWarnings)]);
      } else if (outcome === "rejected") {
        const blocking = warnings.filter((warning) => quality.blocking_codes.includes(warning.code));
        await reject({ kind: "quality_rejected", errors: [], warnings: blocking }, [formatPlanQualityReason(blocking)]);
      } else if (outcome === "repair_requested") {
        feedback = { kind: "quality_repair", errors: [], warnings: repairableWarnings(warnings, quality) };
      } else {
        return { kind: "accepted", value: validated.value, parsed, runId };
      }
    }
    if (feedback !== null && await this.recoverPlanQuality(workId, feedback, lastRunId)) return { kind: "recovered" };
    return { kind: "rejected", errors, attempts: maxAttempts };
  }

  async runInitialManagerPlan(workId: string, mode: StartWorkPayload["mode"]): Promise<void> {
    if (!this.host.started) return;
    const work = this.managerWorkContext(workId);
    let managerEvent = "";
    const outcome = await this.inspectManagerPlan<null, { items: readonly TaskPlanItem[]; fullRun: boolean; removedOwner: readonly JsonObject[] }>({
      workId,
      phase: "plan",
      ownerReplan: null,
      invoke: async (_attempt, feedback) => {
        const invoked = await this.invokeInitialManagerPlan(workId, mode, work, feedback);
        if (invoked === null || !this.host.started) return null;
        const { result, runId } = invoked;
        if (result.failure_class === "rate_limited") return null;
        if (await this.recoverManagerTransient(workId, result, runId)) return null;
        return { report: requireManagerReport(result, "manager plan"), runId };
      },
      parse: (report) => {
        managerEvent = String(report.event);
        return this.withoutFullTestCriteria(managerTasksToPlanItems(report.tasks, workId, { allowEmpty: false }), report);
      },
      validate: async (parsed) => {
        if (managerEvent !== "work.planned" && managerEvent !== "task.replanned") {
          throw validationError("The Manager plan must return work.planned or task.replanned.", { work_id: workId, event: managerEvent });
        }
        const plan = validatePlan(parsed.items);
        return isPlanRejection(plan) ? { errors: plan.errors } : { value: null };
      },
      onRejected: async (attempt, _runId, feedback, errors) => {
        console.warn(`[owl-core] Manager plan attempt ${attempt} for Work ${workId} was rejected (${feedback.kind}): ${errors.join("; ")}`);
      },
    });
    if (outcome.kind === "fatal") throw outcome.error;
    if (outcome.kind === "rejected") {
      await this.openManagerReplanFailureDecision(workId, [], `The Manager's plan was rejected ${outcome.attempts} times. ${outcome.errors.join(" ")}`, undefined, null, undefined, outcome.attempts);
      return;
    }
    if (outcome.kind !== "accepted") return;
    const { items, fullRun, removedOwner } = outcome.parsed;
    await this.host.workflow.registerPlan(workId, items, managerEvent as "work.planned" | "task.replanned");
    if (fullRun) await this.markFullTestRun(workId, removedOwner);
    if (this.host.started) await this.host.dispatcher.replayPending();
  }

  /**
   * Removes the criteria that ask for the whole test suite before the plan is validated and stored, so no Worker
   * is told to run it inside its time limit. The Work's final Core run does it instead (works.full_test_run_at_end).
   * The phrases come from DEFAULT_FULL_TEST_PATTERNS; the Manager's own work_full_test_run also sets the mark.
   */
  withoutFullTestCriteria(items: readonly TaskPlanItem[], report: JsonObject): { items: readonly TaskPlanItem[]; fullRun: boolean; removedOwner: readonly JsonObject[] } {
    let removed = 0;
    // Owner-written criteria are still removed; the event keeps which Task lost which sentence so the Owner can trace it.
    const removedOwner: JsonObject[] = [];
    const stripped = items.map((item) => {
      if (item.acceptance_criteria === undefined) return item;
      for (const criterion of item.acceptance_criteria) {
        if (criterion.origin?.kind === "owner" && isFullTestCriterion(criterion)) removedOwner.push({ task: item.id ?? item.title, text: criterion.text });
      }
      const result = stripFullTestCriteria(item.acceptance_criteria);
      removed += result.removed;
      return result.removed === 0 ? item : { ...item, acceptance_criteria: result.criteria, acceptance: result.acceptance };
    });
    return { items: stripped, fullRun: removed > 0 || report.work_full_test_run === true, removedOwner };
  }

  /** The Owner whole-suite criteria Core removed so far, read back from the marks written by markFullTestRun. */
  removedOwnerCriteriaOfWork(workId: string): JsonObject[] {
    return this.host.db
      .all<{ payload_json: string }>("SELECT payload_json FROM events WHERE type = 'work.full_test_run_marked' AND work_id = ? ORDER BY sequence ASC", workId)
      .flatMap((row) => {
        const removed = (JSON.parse(row.payload_json) as { removed_owner_criteria?: unknown }).removed_owner_criteria;
        return Array.isArray(removed) ? (removed as JsonObject[]) : [];
      });
  }

  async markFullTestRun(workId: string, removedOwner: readonly JsonObject[]): Promise<void> {
    await this.host.writeLane.write({
      mutateState: (transaction) => { transaction.run("UPDATE works SET full_test_run_at_end = 1 WHERE id = ?", workId); },
      event: { idempotencyKey: `full-test-run-marked:${workId}:${createUlid()}`, type: "work.full_test_run_marked", workId, payload: { work_id: workId, ...(removedOwner.length > 0 ? { removed_owner_criteria: [...removedOwner] } : {}) } },
      outbox: [],
    });
  }

  /** Keeps why a Manager replan was rejected; console.warn alone leaves no trace in the DB to trace a repeated rejection. */
  async recordReplanRejected(workId: string, attempt: number, managerAgentRunId: string, triggerKind: string, feedbackKind: string, errors: readonly string[]): Promise<void> {
    await this.host.writeLane.write({
      mutateState: () => undefined,
      event: {
        idempotencyKey: `replan-rejected:${workId}:${managerAgentRunId}`,
        type: "work.replan_rejected",
        workId,
        payload: { work_id: workId, attempt, manager_agent_run_id: managerAgentRunId, trigger_kind: triggerKind, feedback_kind: feedbackKind, errors: [...errors] },
      },
      outbox: [{ provider: "websocket" }],
    });
  }

  /** Records the plan quality warnings of one Manager answer; the plan itself is never rejected for them. */
  async recordPlanQualityWarned(
    workId: string,
    phase: "plan" | "replan",
    attempt: number,
    managerAgentRunId: string,
    warnings: readonly PlanQualityWarning[],
    outcome: PlanQualityOutcome,
  ): Promise<void> {
    await this.host.writeLane.write({
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
  async invokeInitialManagerPlan(
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
            ...this.host.processSkillsRequestContext(),
            ...(feedback === null ? {} : { previous_output_feedback: feedback as unknown as JsonObject }),
            auto_recovery: autoRecoveryForManager(this.host.db, workId, []),
          },
        },
        "manager.plan",
      );
      if (!this.host.started) return null;
      if (raw === null) return null;
      result = requireAgentRunResult(raw, "manager plan");
      // A transient provider error (rate limit, network, timeout) or a
      // retryable invalid plan gets a bounded retry before the Work is
      // escalated to the Owner through recordTickFailure.
      const retryable = result.outcome !== "success" && result.failure_class !== "rate_limited" &&
        (result.failure_class === "transient" || result.retry_allowed === true);
      if (!retryable || attempt === INITIAL_PLAN_MAX_ATTEMPTS) break;
      console.warn(`[owl-core] Manager plan attempt ${attempt} for Work ${workId} failed (${result.error_key ?? result.outcome}); retrying.`);
      await delay(this.host.options.dispatcher?.manager_retry_delay_ms ?? INITIAL_PLAN_RETRY_DELAY_MS);
      if (!this.host.started) return null;
    }
    return result === null ? null : { result, runId };
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
  async triggerManagerReplan(
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
    if (!this.host.started || this.replansInFlight.has(workId)) {
      await this.requeueManagerReplan(workId, new Map(), ownerReplan);
      return;
    }
    // Agents the Owner stopped may still run. The tick confirms the stop (and
    // escalates when it never comes) before any replan starts; this entry only
    // defers, so a Task pipeline cannot start a replan ahead of that check.
    if (this.ownerStopBlocked(workId)) {
      await this.requeueManagerReplan(workId, new Map(), ownerReplan);
      return;
    }
    // A Worker that finishes while the Work is paused (or after it left
    // `running` for any other reason) must not start a Manager replan. The
    // queued Manager trigger is left `queued`, so the first tick
    // after resume replays it through queuedReplanTasks.
    if (!this.isWorkRunning(workId) && !(ownerReplan !== null && this.isWorkWaitingForDecision(workId))) {
      await this.requeueManagerReplan(workId, new Map(), ownerReplan);
      return;
    }
    // A Task that is waiting on a prerequisite is not replanned: a late
    // callback for it must not call the Manager.
    if (failedTaskIds.length > 0) {
      failedTaskIds = failedTaskIds.filter(
        (id) => this.host.db.get<{ prerequisite_json: string | null }>("SELECT prerequisite_json FROM tasks WHERE id = ?", id)?.prerequisite_json == null,
      );
      if (failedTaskIds.length === 0) return;
      // A failure while an Owner request waits goes to the Manager with that
      // request: the tick's Owner replan takes every root failure, and the
      // failure's trigger stays queued until then.
      if (ownerReplan === null && this.hasQueuedOwnerReplan(workId)) return;
    }
    this.replansInFlight.add(workId);
    // Failed Tasks the budget stopped that this replan must plan differently; their lineage budget is restored when the plan is applied.
    let budgetIds: readonly string[] = [];
    try {
      // An Owner-initiated replan bypasses the remake gate. When any Task is
      // blocked the Work is judgement_waiting and the Manager is not called;
      // the unblocked Tasks keep their queued trigger for after the answer.
      // The Decision a gate opens is announced right away: this path can run
      // from a Worker callback, after which no tick comes for a halted Work.
      if (ownerReplan === null) {
        let gated: boolean;
        try {
          const remake = await this.applyRemakeGate(workId, failedTaskIds);
          budgetIds = remake.recovering;
          gated = remake.blocked.length > 0 || (await this.applyNoProgressGate(workId, failedTaskIds)).length > 0;
        } catch (error) {
          await this.reportLoopGateFailure(workId, error);
          return;
        }
        this.loopGateFailures.delete(workId);
        if (gated) {
          if (this.host.started) await this.host.announceCoreDecisions(workId);
          return;
        }
      }
      if (budgetIds.length > 0) trigger = withBudgetExhaustedTrigger(trigger, budgetIds);
      // Kind 8 repairs an automatic replan. An Owner's answer already decided the criteria, and the repair would demand
      // rule_applicability the answer has no use for and put the Owner's rewritten criteria back to the stored ones.
      const automaticReplan = ownerReplan === null || ownerReplan.kind === "auto_conflict" || ownerReplan.kind === "auto_final";
      const partialIds = automaticReplan ? failedTaskIds.filter((id) => this.isTriggerFlagged(id, "partial_recovery")) : [];
      if (partialIds.length > 0) trigger = withPartialRepeatedTrigger(trigger, partialIds);
      const previousMarkers = await this.markReplanAttempted(failedTaskIds);
      const outcome = await this.runManagerReplan(workId, failedTaskIds, trigger, workerQuestions, finalVerdict, ownerReplan, workVerification, baseConflict);
      if (outcome === "requeue") await this.requeueManagerReplan(workId, previousMarkers, ownerReplan);
      else if (trigger.kind === "design_completed") await this.markDesignsHandedToManager(trigger.design_task_ids);
    } finally {
      this.replansInFlight.delete(workId);
      // The launch hold is gone now; do not wait for the next interval to start the Tasks.
      if (ownerReplan?.kind === "instruction") this.host.workDriver.wake(workId);
    }
  }

  /**
   * Completed design Tasks the Manager has not seen yet, once no design Task
   * is left unfinished. A design Task that already has dependents belongs to
   * a plan made with it (an older Work) and is never handed over.
   */
  newlyCompletedDesignTasks(workId: string): string[] {
    const designs = this.host.db.all<{ id: string; status: string }>(
      "SELECT id, status FROM tasks WHERE work_id = ? AND type = 'design' ORDER BY created_at ASC, id ASC",
      workId,
    );
    if (designs.some((design) => design.status !== "completed" && design.status !== "cancelled")) return [];
    return designs
      .filter((design) => design.status === "completed")
      .filter((design) => !isDesignHanded(this.host.db, design.id))
      .filter((design) => this.host.db.get("SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE d.depends_on_task_id = ? AND t.type <> 'design'", design.id) === undefined)
      .map((design) => design.id);
  }

  /** Persist that these design Tasks went to the Manager, so no later tick or restart sends them again. */
  async markDesignsHandedToManager(taskIds: readonly string[]): Promise<void> {
    await this.host.writeLane.transact((transaction) => {
      this.insertDesignHandedMarkers(transaction, taskIds);
      return null;
    });
  }

  /** The marker write itself, so a replan can store it in the same transaction that adds its Tasks. */
  insertDesignHandedMarkers(transaction: CoreWriteLaneTransaction, taskIds: readonly string[]): void {
    markDesignsHanded(transaction, taskIds, utcNow());
  }

  /** True only when the Task's trigger row is marked question_only; a missing row goes through the gate. */
  isQuestionOnlyTrigger(taskId: string): boolean {
    return readManagerTrigger(this.host.db, taskId)?.question_only === true;
  }

  /**
   * Stop remaking Tasks whose lineage used up a remake limit (a question-only result is not a remake and skips this gate): no new Task is
   * created, the Work waits for the Owner. Returns the blocked Task ids. A
   * failure of the gate itself throws: the caller skips the replan (fail-closed).
   */
  async applyRemakeGate(workId: string, failedTaskIds: readonly string[]): Promise<{ blocked: string[]; recovering: string[] }> {
    const settings = remakeLimits(this.host.db);
    const blocked: { id: string; title: string; reason: RemakeLimitReason; usage: ReturnType<typeof lineageUsage> }[] = [];
    // Tasks a budget stopped that go to the Manager once more instead of the Owner; `recorded` ones already have their recovery.started.
    const recovering: { id: string; recorded: boolean; summary: string; reason: string }[] = [];
    for (const id of failedTaskIds) {
      if (this.isBudgetRecoveryTrigger(id)) {
        recovering.push({ id, recorded: true, summary: "", reason: "budget_exhausted" });
        continue;
      }
      // The same partial report twice: its recovery.started is already written and the Manager repairs it; a remake limit does not stop it.
      if (this.isTriggerFlagged(id, "partial_recovery")) continue;
      const row = this.host.db.get<{ title: string; status: string; failed_by_dependency_task_id: string | null }>(
        "SELECT title, status, failed_by_dependency_task_id FROM tasks WHERE id = ? AND work_id = ?",
        id,
        workId,
      );
      if (!row || row.status !== "failed" || row.failed_by_dependency_task_id !== null) continue;
      if (pendingAcceptanceDefect(this.host.db, id) || pendingExternalBlocker(this.host.db, id)) continue;
      // A Worker's question is answered by the Manager, not remade; repeats are stopped by the no-progress gate.
      if (this.isQuestionOnlyTrigger(id)) continue;
      const usage = lineageUsage(this.host.db, id, settings);
      const verdict = evaluateRemakeGate(usage, settings);
      if (!verdict.blocked) continue;
      const target = { kind: "task", id: lineageRootOf(this.host.db, id) } as const;
      if (autoRecoveryUsed(this.host.db, "budget_exhausted", target) < autoRecoveryLimit(this.host.db, "budget_exhausted")) {
        const summary = remakeLimitBrief({ taskTitle: row.title, reason: verdict.reason, usage, settings }, ownerLanguage(this.host.db)).reason;
        recovering.push({ id, recorded: false, summary, reason: verdict.reason });
      } else blocked.push({ id, title: row.title, reason: verdict.reason, usage });
    }
    const unrecorded = recovering.filter((item) => !item.recorded);
    const recoveringIds = recovering.map((item) => item.id);
    if (blocked.length === 0 && unrecorded.length === 0) return { blocked: [], recovering: recoveringIds };
    const language = ownerLanguage(this.host.db);
    await this.host.writeLane.transact((transaction) => {
      const now = utcNow();
      for (const item of unrecorded) {
        // The latest event of the Task names the failure this recovery answers, so a replay after a restart counts it once.
        const source = transaction.get<{ id: string }>("SELECT id FROM events WHERE task_id = ? ORDER BY sequence DESC LIMIT 1", item.id)?.id ?? item.id;
        recordAutoRecoveryInTransaction(transaction, {
          kind: "budget_exhausted",
          target: { kind: "task", id: lineageRootOf(transaction, item.id) },
          workId,
          action: "replan_different_approach",
          sourceEventId: source,
          previousFailure: { summary: item.summary, error_key: item.reason, detail: item.summary },
          now,
        });
        flagManagerTrigger(transaction, item.id, "budget_recovery", now);
      }
      for (const item of blocked) {
        setManagerTriggerStatus(transaction, item.id, "attempted", now);
        const brief = remakeLimitBrief({ taskTitle: item.title, reason: item.reason, usage: item.usage, settings }, language);
        openRemakeLimitDecisionInTransaction(transaction, { workId, blockedTaskIds: [item.id], brief, now });
      }
      return null;
    });
    return { blocked: blocked.map((item) => item.id), recovering: recoveringIds };
  }

  /** True when the Task's Manager trigger carries this flag (see flagManagerTrigger). */
  isTriggerFlagged(taskId: string, flag: "partial_recovery"): boolean {
    return readManagerTrigger(this.host.db, taskId)?.[flag] === true;
  }

  /** True when the Task's Manager trigger was marked as a budget_exhausted recovery (the replan must take a different approach). */
  isBudgetRecoveryTrigger(taskId: string): boolean {
    return readManagerTrigger(this.host.db, taskId)?.budget_recovery === true;
  }

  /**
   * Stop asking the Manager to replan Tasks whose consecutive no-progress
   * results reached the limit: the Work waits for the Owner. Returns the
   * blocked Task ids. A failure of the gate itself throws: the caller skips
   * the replan (fail-closed).
   */
  async applyNoProgressGate(workId: string, failedTaskIds: readonly string[]): Promise<string[]> {
    return await this.host.writeLane.transact((transaction) => {
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
        setManagerTriggerStatus(transaction, id, "attempted", now);
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
  async reportLoopGateFailure(workId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[owl-core] loop-prevention gate failed; the replan is skipped until the next tick", error);
    if (this.loopGateFailures.get(workId) === message) return;
    this.loopGateFailures.set(workId, message);
    try {
      await this.host.writeLane.transact((transaction) => {
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
  async checkPrerequisites(workId: string): Promise<void> {
    try {
      if (this.host.db.get<Pick<WorkDbRow, "state">>("SELECT state FROM works WHERE id = ?", workId)?.state !== "running") return;
      const rows = this.host.db.all<{ id: string; title: string; prerequisite_json: string; prerequisite_since: string | null }>(
        "SELECT id, title, prerequisite_json, prerequisite_since FROM tasks WHERE work_id = ? AND status = 'waiting' AND prerequisite_json IS NOT NULL",
        workId,
      );
      const forced = this.prerequisiteRecheck.delete(workId);
      if (rows.length === 0) return;
      const nowMs = Date.now();
      const intervalMs = progressGuard(this.host.db).prerequisite_check_interval_seconds * 1000;
      const due = rows.filter((row) => forced || nowMs - (this.prerequisiteCheckedAt.get(row.id) ?? Number.NEGATIVE_INFINITY) >= intervalMs);
      if (due.length === 0) return;
      const specs = due.map((row) => ({ row, spec: JSON.parse(row.prerequisite_json) as PrerequisiteSpec }));
      const paths = [...new Set(specs.flatMap(({ spec }) => spec.conditions.flatMap((condition) => (condition.kind === "base_branch" ? condition.paths : []))))];
      let base: { head: string; missing_paths: readonly string[] } | null = null;
      if (specs.some(({ spec }) => spec.conditions.some((condition) => condition.kind === "base_branch"))) {
        const facts = await this.host.git.baseBranchFacts?.({ work_id: workId, paths });
        if (facts?.ok) base = { head: facts.head, missing_paths: facts.missing_paths };
        else console.warn(`[owl-core] prerequisite: base branch unreadable for Work ${workId}: ${facts?.message ?? "no git gateway"}`);
      }
      const facts: PrerequisiteFacts = {
        taskStatus: (id) => this.host.db.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", id)?.status,
        workState: (id) => this.host.db.get<{ state: string }>("SELECT state FROM works WHERE id = ?", id)?.state,
        baseBranch: () => base,
        processAlive: (pid) => isProcessGroupAlive(pid) || isPidAlive(pid, { epermAlive: true }),
        taskFileExists: (taskId, path) => {
          const root = this.host.workspaceLayout.taskPath(workId, taskId);
          const file = resolve(root, path);
          return !relative(root, file).startsWith("..") && existsSync(file);
        },
      };
      for (const { row, spec } of specs) {
        if (!this.host.started) return;
        this.prerequisiteCheckedAt.set(row.id, nowMs);
        const outcome = evaluatePrerequisite(spec, facts, new Date(nowMs).toISOString(), row.id);
        if (outcome.verdict === "satisfied") await this.releasePrerequisite(workId, row, spec, base?.head ?? null);
        else if (outcome.verdict !== "pending") await this.expirePrerequisite(workId, row, spec, outcome.verdict === "expired" ? "deadline" : "unreachable", outcome.detail);
      }
      if (this.host.started) await this.host.announceCoreDecisions(workId);
    } catch (error) {
      // Why not stop: a failure must not halt the tick. Waiting Tasks then stay waiting (not released or expired) and a corrupt prerequisite_json warns every tick until fixed.
      console.warn(`[owl-core] prerequisite check failed for Work ${workId}`, error);
    }
  }

  /** Merge the base branch into the Work branch when the wait asked for work/base_branch and progress_guard allows it. Returns a sync_conflict detail, or null to go on. */
  async syncBaseForPrerequisite(workId: string, spec: PrerequisiteSpec): Promise<{ conflict: string } | { failed: string } | null> {
    if (!progressGuard(this.host.db).prerequisite_sync_base) return null;
    if (!spec.conditions.some((condition) => condition.kind === "work" || condition.kind === "base_branch")) return null;
    if (this.host.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId)?.project_id == null) return null;
    const merged = await this.host.git.mergeBaseIntoWorkBranch?.({ work_id: workId });
    if (merged === undefined || merged.ok) return null;
    return merged.conflict ? { conflict: merged.message } : { failed: merged.message };
  }

  async releasePrerequisite(
    workId: string,
    row: { id: string; title: string; prerequisite_since: string | null },
    spec: PrerequisiteSpec,
    baseHead: string | null,
  ): Promise<void> {
    const sync = await this.syncBaseForPrerequisite(workId, spec);
    if (sync !== null && "conflict" in sync) {
      // The first conflicts go to the Manager as a conflict-resolution Task; the wait stays and the release is tried again at the next evaluation.
      if (await this.deferPrerequisiteForConflict(workId, sync.conflict)) return;
      await this.expirePrerequisite(workId, row, spec, "sync_conflict", sync.conflict);
      return;
    }
    if (sync !== null) {
      // Not a conflict: try again at the next evaluation; the deadline still ends the wait.
      console.warn(`[owl-core] prerequisite: base sync failed for Task ${row.id}: ${sync.failed}`);
      return;
    }
    const since = row.prerequisite_since ?? "";
    await this.host.writeLane.write({
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
    this.host.workDriver.wake(workId);
  }

  /**
   * The base branch conflicted with the Work branch while a prerequisite was released. While a
   * conflict-resolution Task from an earlier round is still running the wait just goes on;
   * otherwise the conflict is handed to the Manager. False when the limit is used up.
   */
  async deferPrerequisiteForConflict(workId: string, message: string): Promise<boolean> {
    const inFlight = this.host.db.get<{ found: number }>(
      `SELECT 1 AS found FROM tasks
        WHERE work_id = ? AND status NOT IN ('completed', 'failed', 'cancelled') AND prerequisite_json IS NULL
          AND created_at > COALESCE((SELECT MAX(created_at) FROM events WHERE work_id = ? AND type = 'recovery.started'
                                      AND json_extract(payload_json, '$.kind') = 'integration_conflict'
                                      AND json_extract(payload_json, '$.target_kind') = 'work'), '9999')`,
      workId,
      workId,
    );
    if (inFlight) return true;
    const result = await this.host.tryAutoResolveMergeConflict(workId, { conflicting_files: mergeConflictPaths(message), base_branch: null, message });
    return result.handled;
  }

  async expirePrerequisite(
    workId: string,
    row: { id: string; title: string; prerequisite_since: string | null },
    spec: PrerequisiteSpec,
    kind: "deadline" | "unreachable" | "sync_conflict",
    detail: string,
  ): Promise<void> {
    await this.host.writeLane.write({
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
  wakePrerequisiteWaiters(sourceWorkId: string, merged: boolean): void {
    try {
      const waiters = this.host.db.all<{ id: string; work_id: string; prerequisite_json: string }>(
        "SELECT id, work_id, prerequisite_json FROM tasks WHERE status = 'waiting' AND prerequisite_json IS NOT NULL AND work_id <> ?",
        sourceWorkId,
      );
      if (waiters.length === 0) return;
      const source = this.host.db.get<{ state: string; project_id: string | null }>("SELECT state, project_id FROM works WHERE id = ?", sourceWorkId);
      for (const waiter of waiters) {
        const spec = JSON.parse(waiter.prerequisite_json) as PrerequisiteSpec;
        const hits = spec.conditions.filter((condition) => {
          if (condition.kind === "task") {
            return this.host.db.get<{ work_id: string; status: string }>("SELECT work_id, status FROM tasks WHERE id = ?", condition.task_id)?.status === "completed"
              && this.host.db.get<{ work_id: string }>("SELECT work_id FROM tasks WHERE id = ?", condition.task_id)?.work_id === sourceWorkId;
          }
          if (condition.kind === "work") return condition.work_id === sourceWorkId && source?.state === "completed";
          if (condition.kind === "base_branch") {
            return merged && source?.project_id != null
              && this.host.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", waiter.work_id)?.project_id === source.project_id;
          }
          return false;
        });
        if (hits.length === 0) continue;
        const hitIds = hits.map((condition) => (condition.kind === "task" ? condition.task_id : condition.kind === "work" ? condition.work_id : "base")).join(",");
        const key = merged ? `${waiter.id}:merge:${Date.now()}` : `${waiter.id}:${spec.deadline_at}:${sourceWorkId}:${source?.state}:${hitIds}`;
        // Why not remember merge keys: they embed Date.now(), so they never match again and would only grow the set.
        if (!merged) {
          if (this.prerequisiteWoken.has(key)) continue;
          this.prerequisiteWoken.add(key);
        }
        this.prerequisiteRecheck.add(waiter.work_id);
        this.host.workDriver.wake(waiter.work_id);
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
  async resumePrerequisiteWait(
    taskId: string,
    input: { readonly message: string | null; readonly idempotencyKey: string; readonly actor: string },
  ): Promise<CommandResponse<{ task_id: string; work_id: string; resumed: true }>> {
    const task = this.host.db.get<{ work_id: string; prerequisite_json: string | null }>("SELECT work_id, prerequisite_json FROM tasks WHERE id = ?", taskId);
    if (!task) throw notFound("task", taskId);
    const workId = task.work_id;
    const message = input.message === null || input.message.trim().length === 0 ? null : input.message.trim();
    if (task.prerequisite_json !== null) {
      // Same wait, first resume: bring the base in before the Worker runs again.
      const sync = await this.syncBaseForPrerequisite(workId, JSON.parse(task.prerequisite_json) as PrerequisiteSpec);
      if (sync !== null) {
        const row = this.host.db.get<{ title: string; prerequisite_since: string | null }>("SELECT title, prerequisite_since FROM tasks WHERE id = ?", taskId);
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
    const response = await this.host.runCommand(
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
    this.host.workDriver.wake(workId);
    return response;
  }

  isWorkRunning(workId: string): boolean {
    return this.host.db.get<Pick<WorkDbRow, "state">>("SELECT state FROM works WHERE id = ?", workId)?.state === "running";
  }

  /** An Owner request may reach the Manager while the Work waits for a Decision. */
  isWorkWaitingForDecision(workId: string): boolean {
    return this.host.db.get<Pick<WorkDbRow, "state">>("SELECT state FROM works WHERE id = ?", workId)?.state === "judgement_waiting";
  }

  // A pause followed by a resume while a Manager replan call is outstanding
  // leaves the Work `running` again by the time the call returns, which a
  // plain running check cannot tell apart from "never interrupted". Requiring
  // the state_version to still match the value captured before the call
  // catches that case too (M1): any transition at all during the call,
  // including a pause immediately undone by a resume, discards the answer.
  /** The Owner's own words for a Work: its summary, instruction messages and Decision answers (and the request being answered); an owner-origin criterion must quote one of them. */
  workSummaryText(workId: string): string | null {
    return this.host.db.get<{ summary: string | null }>("SELECT summary FROM works WHERE id = ?", workId)?.summary ?? null;
  }

  ownerQuoteTexts(workId: string, ownerReplan: OwnerReplanRequest | null): string[] {
    const texts: string[] = [];
    const summary = this.host.db.get<{ summary: string | null }>("SELECT summary FROM works WHERE id = ?", workId)?.summary;
    if (typeof summary === "string") texts.push(summary);
    for (const row of this.host.db.all<{ body: string }>(
      "SELECT m.body AS body FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.work_id = ?",
      workId,
    )) texts.push(row.body);
    const leaves = (value: unknown): void => {
      if (typeof value === "string") texts.push(value);
      else if (Array.isArray(value)) value.forEach(leaves);
      else if (typeof value === "object" && value !== null) Object.values(value).forEach(leaves);
    };
    for (const row of this.host.db.all<{ answer_json: string }>(
      "SELECT a.answer_json AS answer_json FROM decision_answers a JOIN decisions d ON d.id = a.decision_id WHERE d.work_id = ?",
      workId,
    )) {
      try {
        leaves(JSON.parse(row.answer_json));
      } catch {
        // A damaged answer cannot be quoted.
      }
    }
    if (ownerReplan !== null) {
      texts.push(ownerReplan.answer);
      for (const request of ownerReplan.requests ?? []) if ("text" in request) texts.push(request.text);
    }
    return texts;
  }

  isReplanStillCurrent(workId: string, expectedVersion: number, ownerReplan = false): boolean {
    const work = this.host.db.get<Pick<WorkDbRow, "state" | "state_version">>(
      "SELECT state, state_version FROM works WHERE id = ?",
      workId,
    );
    return (work?.state === "running" || (ownerReplan && work?.state === "judgement_waiting")) && work.state_version === expectedVersion;
  }

  /** Mark the triggers attempted and return each marker's previous status. */
  async markReplanAttempted(taskIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (taskIds.length === 0) return new Map();
    return this.host.writeLane.transact((transaction) => {
      const previous = new Map<string, string>();
      const now = utcNow();
      for (const taskId of taskIds) {
        const row = readManagerTrigger(transaction, taskId);
        if (row) previous.set(taskId, row.status);
        setManagerTriggerStatus(transaction, taskId, "attempted", now);
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
  async requeueManagerReplan(
    workId: string,
    previousMarkers: ReadonlyMap<string, string>,
    ownerReplan: OwnerReplanRequest | null,
  ): Promise<void> {
    if (previousMarkers.size === 0 && ownerReplan === null) return;
    try {
      await this.host.writeLane.transact((transaction) => {
        const now = utcNow();
        for (const [taskId, status] of previousMarkers) {
          setManagerTriggerStatus(transaction, taskId, status as ReplanMarkerStatus, now, "attempted");
        }
        if (ownerReplan !== null) requeueOwnerReplanInTransaction(transaction, workId);
        return null;
      });
    } catch (error) {
      console.error(`[owl-core] failed to requeue the Manager replan for Work ${workId}`, error);
    }
  }

  /** Root-failed Tasks whose Manager trigger is still queued and no open Decision covers them. */
  queuedReplanTasks(workId: string): { id: string; question: string | null }[] {
    return listQueuedReplanTasks(this.host.db, workId, QUARANTINE_FIX_TASK_PREFIX);
  }

  hasQueuedOwnerReplan(workId: string): boolean {
    return readOwnerReplan(this.host.db, workId)?.status === "queued";
  }

  ownerReplanMarkerText(workId: string): string | null {
    return JSON.stringify(readOwnerReplan(this.host.db, workId) ?? null);
  }

  /** True from an Owner instruction until its Manager replan applies; every Task launch of the Work waits meanwhile. */
  ownerInstructionPending(workId: string): boolean {
    const marker = readOwnerReplan(this.host.db, workId);
    if (marker === undefined || (marker.kind !== "instruction" && marker.processing_kind !== "instruction")) return false;
    return marker.status === "queued" || (marker.status === "attempted" && this.replansInFlight.has(workId));
  }

  /**
   * What the Owner stopped that may still run: Agent runs marked cancel_requested
   * whose process is alive, and Tasks that left running/verifying but whose
   * pipeline or verification command is still in this process (a completed
   * Worker leaves no run to look at).
   */
  ownerStopPending(workId: string): { runIds: string[]; taskIds: string[] } {
    const runIds = this.host.db.all<StoppableRun>(
      `SELECT id, role, pid, process_start_time, process_cmdline_sha256 FROM agent_runs
        WHERE work_id = ? AND status = 'cancel_requested'
          AND role <> 'advisor' AND hook_agent_id IS NULL AND (origin IS NULL OR origin <> 'observed')`,
      workId,
    ).filter((run) => run.pid === null || !isRecordedProcessGone(run, run.pid)).map((run) => run.id);
    const stoppedTasks = new Set(
      this.host.db.all<{ id: string }>("SELECT id FROM tasks WHERE work_id = ? AND status IN ('ready', 'waiting', 'paused')", workId).map((task) => task.id),
    );
    const taskIds = new Set(
      this.host.workflow.activePipelineTasks().filter((entry) => entry.workId === workId && stoppedTasks.has(entry.taskId)).map((entry) => entry.taskId),
    );
    for (const taskId of this.host.workflow.tasksWithVerification(stoppedTasks)) taskIds.add(taskId);
    return { runIds, taskIds: [...taskIds] };
  }

  ownerStopBlocked(workId: string): boolean {
    const pending = this.ownerStopPending(workId);
    return pending.runIds.length > 0 || pending.taskIds.length > 0;
  }

  /** Holds the replans of the tick while Agents the Owner stopped may still run; true when the tick must stop here. */
  async holdForOwnerStop(workId: string, workState: string | undefined): Promise<boolean> {
    // Once the stop Decision is open, the tick waits only while stopped Agents remain; when they have ended,
    // the Decision is closed and the Work goes on. The wait is not counted meanwhile, so no second Decision is raised.
    const stopDecision = workState === "judgement_waiting" ? this.ownerStopDecision(workId) : null;
    if (stopDecision) {
      // Why not keep waiting once nothing is left: the Decision asked about processes that have since ended, so "Resume" is answered for the Owner.
      if (this.ownerStopBlocked(workId)) return true;
      // Why not resumeWorkOrRetryDecision: it answers the first open Decision with a retry option, which may be another Decision the Owner must judge.
      const id = createUlid();
      await this.host.answerDecision(stopDecision.id, {
        request_id: id,
        idempotency_key: `owner-stop-cleared:${workId}:${id}`,
        expected_version: stopDecision.state_version,
        payload: { answer: stopDecision.retryLabel, option_key: "retry", source: "advisor", source_message_id: null },
      }).catch((error) => console.error(`[owner-stop] Failed to clear the Decision of Work ${workId}`, error));
      return true;
    }
    const pending = this.ownerStopPending(workId);
    if (pending.runIds.length === 0 && pending.taskIds.length === 0) {
      this.host.ownerStopWaits.delete(workId);
      return false;
    }
    const wait = this.host.ownerStopWaits.get(workId) ?? { since: Date.now(), resent: false };
    this.host.ownerStopWaits.set(workId, wait);
    const bound = (this.host.options.agentStopWaitMs ?? AGENT_STOP_WAIT_MS) * OWNER_STOP_CONFIRM_FACTOR;
    const waited = Date.now() - wait.since;
    if (!wait.resent && waited >= bound) {
      wait.resent = true;
      this.host.workflow.stopTaskVerification(new Set(pending.taskIds), "SIGKILL");
      await this.host.stopAgentRuns(pending.runIds, { force: true, waitMs: 0 });
    }
    // A Work already waiting on the Owner raises no second Decision; the alert follows once it runs again.
    if (waited >= 2 * bound && workState === "running") {
      await this.recordOwnerStopUnconfirmed(workId, pending);
      this.host.ownerStopWaits.delete(workId);
      if (this.host.started) await this.host.announceCoreDecisions(workId);
      if (this.host.started) await this.host.dispatcher.replayPending();
    }
    return true;
  }

  ownerStopDecision(workId: string): { id: string; state_version: number; retryLabel: string } | null {
    const decision = this.host.db.all<{ id: string; state_version: number; options_json: string }>(
      "SELECT id, state_version, options_json FROM decisions WHERE work_id = ? AND status = 'open' AND scope = 'work' AND issuer_role = 'core'",
      workId,
    ).find((row) => this.decisionSourceAlert(row.id)?.kind === "owner_stop_unconfirmed");
    if (!decision) return null;
    let options: unknown = null;
    try {
      options = JSON.parse(decision.options_json);
    } catch {
      // A malformed Decision gets no label; answerDecision then rejects it and the Owner answers it instead.
    }
    const retry = Array.isArray(options) ? options.find((option) => isRecord(option) && option.key === "retry") : undefined;
    return { id: decision.id, state_version: decision.state_version, retryLabel: isRecord(retry) && typeof retry.label === "string" ? retry.label : "retry" };
  }

  /** Halts a Work whose stopped Agents never ended, so the Owner decides; no replan has begun. */
  async recordOwnerStopUnconfirmed(workId: string, pending: { runIds: string[]; taskIds: string[] }): Promise<void> {
    const language = ownerLanguage(this.host.db);
    const alertPayload: JsonObject = {
      kind: "owner_stop_unconfirmed",
      safe_reconcile_failed: true,
      driver_stopped: true,
      run_ids: pending.runIds,
      task_ids: pending.taskIds,
      message: language === "en"
        ? "Agents the Owner stopped have not ended, even after a forced stop. Their Tasks are not started and no Manager replan has begun."
        : "Owner が止めた Agent が、強制終了の合図の後も終わりません。その Task の起動と Manager の再計画を止めています。",
      remediation: language === "en"
        ? "Check that the processes have ended, then choose Resume. Cancel the Work if it should not continue."
        : "プロセスが終わったことを確かめてから「再開する」を選んでください。続けないときは Work を中止してください。",
    };
    const notRunning = new WorkNotRunningAbort();
    try {
      await this.host.writeLane.write({
        mutateState: (transaction) => {
          const work = transaction.get<Pick<WorkDbRow, "state" | "state_version">>("SELECT state, state_version FROM works WHERE id = ?", workId);
          if (!work) throw notFound("work", workId);
          if (work.state !== "running") {
            notRunning.state = work.state;
            throw notRunning;
          }
          reduceWorkInTransaction(transaction, workId, { event: "system.alert", expected_version: work.state_version, payload: alertPayload });
          return { work_id: workId, state: work.state };
        },
        event: {
          id: createUlid(),
          idempotencyKey: `owner-stop-unconfirmed:${workId}:${createUlid()}`,
          type: "system.alert",
          workId,
          payload: alertPayload,
        },
        outbox: [{ provider: "websocket" }],
      });
    } catch (writeError) {
      if (writeError === notRunning) return;
      throw writeError;
    }
  }

  /**
   * Take the persisted Owner replan request for a Work, if any. The marker is
   * moved to `attempted` rather than deleted, so a crash before the Manager
   * finishes acting on it leaves it recoverable: startup recovery moves any
   * still-`attempted` marker back to `queued` for the next tick to retry.
   */
  async consumeOwnerReplan(workId: string): Promise<OwnerReplanRequest | null> {
    return this.host.writeLane.transact((transaction) => {
      foldProcessingOwnerReplanInTransaction(transaction, workId);
      const marker = readOwnerReplan(transaction, workId);
      if (marker?.status !== "queued") return null;
      setOwnerReplanStatus(transaction, workId, "attempted", utcNow());
      return {
        kind: marker.kind === "reopen" || marker.kind === "instruction" || marker.kind === "work_update" || marker.kind === "auto_conflict" || marker.kind === "auto_final" ? marker.kind : "decision",
        answer: marker.answer,
        message_ids: markerMessageIds(marker.message_ids),
        requests: ownerRequestsOf(marker),
      };
    });
  }

  /**
   * The one place a Manager replan request is built. `attempt` 2 carries the
   * previous answer's problems in `previous_output_feedback`; `trigger` stays the original one.
   */
  /** Adds the files the Owner sent with an instruction (found through its messages); an item without files gets no attachments key. */
  withAttachments(request: OwnerRequestInput): OwnerRequestInput | Record<string, unknown> {
    if (request.kind === "work_update" || request.message_ids.length === 0) return request;
    const ids = request.message_ids.flatMap((messageId) => {
      const row = this.host.db.get<{ attachment_ids_json: string }>("SELECT attachment_ids_json FROM messages WHERE id = ?", messageId);
      return row ? parseStringArray(row.attachment_ids_json, "attachment_ids", messageId, "Message") : [];
    });
    const attachments = resolveMessageAttachments(this.host.db, this.host.owlRoot, ids).map((attachment) => ({
      filename: attachment.filename,
      mime: attachment.mime,
      bytes: attachment.bytes,
      status: attachment.status,
      path: attachment.path,
    }));
    return attachments.length > 0 ? { ...request, attachments } : request;
  }

  buildReplanRequest(
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
        ? this.host.db.all<TaskRow>(
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
        ...this.host.processSkillsRequestContext(),
        failed_task_ids: [...failedTaskIds],
        // The root failed Tasks as the Manager reads every Task (no hashes,
        // worktree paths or leases), and per Task why it failed.
        tasks: failedRows.map((task) => managerTaskView(task, this.taskDependencyIds(task.id))),
        failed_tasks: failedRows.flatMap((task) => {
          const brief = failedTaskBrief(this.host.db, task.id);
          return brief === null ? [] : [{ ...brief, ...storedVerificationSpec(task) }];
        }),
        // The whole current plan, so the Manager can tell which ids already
        // exist and which Tasks already completed.
        current_plan: this.planOverview(workId),
        design_documents: this.completedDesignDocuments(workId),
        trigger: trigger as unknown as JsonObject,
        worker_questions: workerQuestions as unknown as JsonObject[],
        owner_requests: ownerRequests.map((request) => this.withAttachments(request)) as unknown as JsonObject[],
        removed_owner_criteria: this.removedOwnerCriteriaOfWork(workId),
        ...(ownerReplanKind === "instruction" ? { stopped_task_ids: this.stoppedTaskIds(workId) } : {}),
        base_merge_conflict: baseConflict as unknown as JsonObject | null,
        final_verdict: finalVerdict,
        work_verification: workVerification,
        previous_output_feedback: feedback as unknown as JsonObject | null,
        auto_recovery: autoRecoveryForManager(this.host.db, workId, failedTaskIds),
      },
    };
  }

  /**
   * A Task that conflicted with the Work branch (at launch or when it was
   * merged) is handed to the Manager with context.auto_recovery instead of
   * opening a Decision. Each conflicted lineage is one `recovery.started`
   * (integration_conflict). Returns the detail for the Decision once the
   * limit is used up, otherwise null.
   */
  async startTaskConflictRecovery(workId: string, trigger: ManagerTrigger): Promise<string | null> {
    if (trigger.kind !== "task_failed") return null;
    const english = ownerLanguage(this.host.db) === "en";
    for (const entry of trigger.tasks) {
      const conflict = entry.kind === "launch_conflict" || (entry.kind === "task_integration_failed" && entry.failure_kind === "merge_conflict");
      if (!conflict) continue;
      const root = lineageRootOf(this.host.db, entry.task_id);
      const target = { kind: "task", id: root } as const;
      const files = entry.merge_conflict_files;
      const listed = files.length > 0 ? files.join(", ") : english ? "not recorded" : "記録なし";
      const used = autoRecoveryUsed(this.host.db, "integration_conflict", target);
      const sourceEventId = `task-conflict:${entry.task_id}:${this.host.db.get<{ failure_count: number }>("SELECT failure_count FROM tasks WHERE id = ?", entry.task_id)?.failure_count ?? 0}`;
      if (used >= autoRecoveryLimit(this.host.db, "integration_conflict")) {
        // A repeat of a failure that already started a recovery is not a new one.
        if (this.host.db.get("SELECT 1 AS found FROM events WHERE idempotency_key = ?", `auto-recovery:integration_conflict:${root}:${sourceEventId}`)) continue;
        return english ? `A Task still conflicts with the Work branch after ${used} automatic attempts. Conflicting files: ${listed}` : `Taskが自動で${used}回直しても、Workのブランチとの衝突が残っています。衝突したファイル: ${listed}`;
      }
      await this.host.writeLane.transact((transaction) => {
        recordAutoRecoveryInTransaction(transaction, {
          kind: "integration_conflict",
          target,
          workId,
          action: "add_conflict_task",
          sourceEventId,
          previousFailure: { summary: `${english ? "Merge conflict in" : "統合の衝突:"} ${listed}`, error_key: "git_conflict", detail: JSON.stringify(entry).slice(0, 2000) },
        });
      });
    }
    return null;
  }

  completedDesignDocuments(workId: string): JsonObject[] {
    return this.host.db.all<{ id: string; title: string }>(
      "SELECT id, title FROM tasks WHERE work_id = ? AND type = 'design' AND status = 'completed' ORDER BY created_at ASC, id ASC",
      workId,
    ).map((task) => ({
      task_id: task.id,
      title: task.title,
      path: designDocumentPath(this.host.dataDir, workId, task.id),
    }));
  }

  /** The Work's Tasks and dependency edges, read once per Manager replan answer. */
  /** Ready Tasks an Owner instruction stopped: a task.interrupted newer than their last task.started. */
  stoppedTaskIds(workId: string): string[] {
    return this.host.db.all<{ id: string }>(
      `SELECT t.id FROM tasks t
        WHERE t.work_id = ? AND t.status = 'ready'
          AND EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.type = 'task.interrupted'
                        AND e.sequence > COALESCE((SELECT MAX(sequence) FROM events WHERE task_id = t.id AND type = 'task.started'), 0))
        ORDER BY t.created_at ASC, t.id ASC`,
      workId,
    ).map((row) => row.id);
  }

  replanSnapshot(workId: string): ReplanSnapshot {
    const tasks = this.host.db.all<{ id: string; manager_task_id: string | null; status: string; failed_by_dependency_task_id: string | null; type: string; ui_change: UiChange; assigned_designer: string | null }>(
      "SELECT id, manager_task_id, status, failed_by_dependency_task_id, type, ui_change, assigned_designer FROM tasks WHERE work_id = ? ORDER BY created_at ASC, id ASC",
      workId,
    );
    const edges = this.host.db.all<{ task_id: string; depends_on_task_id: string }>(
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
        type: task.type,
        ui_change: task.ui_change,
        assigned_designer: task.assigned_designer,
      })),
      edges,
      plan_revision: this.host.db.get<{ plan_revision: number }>("SELECT plan_revision FROM works WHERE id = ?", workId)?.plan_revision ?? 0,
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
  async runManagerReplan(
    workId: string,
    failedTaskIds: readonly string[],
    trigger: ManagerTrigger,
    workerQuestions: readonly WorkerQuestion[] = [],
    finalVerdict: JsonObject | null = null,
    ownerReplan: OwnerReplanRequest | null = null,
    workVerification: JsonObject | null = null,
    baseConflict: BaseMergeConflict | null = null,
  ): Promise<"done" | "requeue"> {
    if (!this.host.started) return "requeue";
    // Defensive: the Manager only ever sees root failures (callers already pass only those).
    failedTaskIds = failedTaskIds.filter((taskId) => !this.isCascadedFailure(taskId));
    const messageIds = ownerReplan?.message_ids ?? [];
    const language = ownerLanguage(this.host.db);
    const fail = async (detail: string, rejectedAttempts?: number): Promise<void> => {
      await this.openManagerReplanFailureDecision(
        workId,
        failedTaskIds,
        detail,
        ownerReplan !== null
          ? ownerReplan.kind === "auto_conflict" || ownerReplan.kind === "auto_final" ? undefined : ownerReplan.answer
          : workerQuestions.length > 0 ? workerQuestions.map((entry) => entry.question).join("\n") : undefined,
        finalVerdict,
        ownerReplan?.kind === "auto_conflict" ? mergeConflictFiles(this.latestSystemAlert(workId)) : undefined,
        rejectedAttempts,
      );
      if (messageIds.length === 0) return;
      await this.host.writeLane.write({
        mutateState: (transaction) => {
          insertInstructionReply(transaction, messageIds, "decision_opened", null, INSTRUCTION_REPLY_TEXT[language].decisionOpened(firstLine(detail)));
        },
        event: { idempotencyKey: `instruction-reply:${createUlid()}`, type: "message.posted", workId, payload: { kind: "message_posted", schema_version: "1.0.0" } },
          outbox: [{ provider: "websocket" }],
      });
    };
    const exhausted = await this.startTaskConflictRecovery(workId, trigger);
    if (exhausted !== null) {
      await fail(exhausted);
      return "done";
    }
    // What the latest Manager call saw; the accepted attempt is always the latest one.
    const current: { snapshot: ReplanSnapshot | null; request: JsonObject; report: JsonObject; stateVersion: number } = { snapshot: null, request: {}, report: {}, stateVersion: 0 };
    let exitValue: "done" | "requeue" = "done";
    type ReplanParsed = { items: readonly TaskPlanItem[]; fullRun: boolean; removedOwner: readonly JsonObject[]; taskActions: readonly ReplanAction[] };
    type ReplanAccepted = { plan: ReplanPlan; prerequisites: ReadonlyMap<string, PrerequisiteSpec>; update: ManagerWorkSummaryUpdate | null };
    const quality = planQualitySettings(this.host.db);
    const inspected = await this.inspectManagerPlan<ReplanAccepted, ReplanParsed>({
      workId,
      phase: "replan",
      ownerReplan,
      invoke: async (attempt, feedback) => {
        const workBeforeCall = this.host.db.get<Pick<WorkDbRow, "state" | "state_version">>(
          "SELECT state, state_version FROM works WHERE id = ?",
          workId,
        );
        if (workBeforeCall?.state !== "running" && !(ownerReplan !== null && workBeforeCall?.state === "judgement_waiting")) { exitValue = "requeue"; return null; }
        const markerBeforeCall = this.ownerReplanMarkerText(workId);
        const snapshot = this.replanSnapshot(workId);
        const request = this.buildReplanRequest(workId, failedTaskIds, trigger, workerQuestions, attempt, finalVerdict, ownerReplan?.kind ?? null, workVerification, feedback, ownerReplan?.requests ?? [], baseConflict);
        current.snapshot = snapshot;
        current.request = request;
        current.stateVersion = workBeforeCall.state_version;
        const runId = String(request.invocation_id);
        let result: AgentRunResult;
        try {
          const raw = await this.invokeManagerPlan(request, "manager.replan");
          // M1: the call takes minutes; a pause, cancel or Decision in the
          // meantime means this answer must not be acted on now, even if the
          // Work is running again by the time this returns.
          if (!this.host.started || !this.isReplanStillCurrent(workId, workBeforeCall.state_version, ownerReplan !== null)) { exitValue = "requeue"; return null; }
          // An instruction that arrived during the call stopped Tasks this plan knows nothing about.
          if (this.ownerReplanMarkerText(workId) !== markerBeforeCall) { exitValue = "requeue"; return null; }
          if (raw === null) { exitValue = "requeue"; return null; }
          result = requireAgentRunResult(raw, "manager replan");
        } catch (error) {
          if (!this.host.started || !this.isReplanStillCurrent(workId, workBeforeCall.state_version, ownerReplan !== null)) { exitValue = "requeue"; return null; }
          await fail(humanizeUnexpected(error, "manager.replan").message);
          return null;
        }
        if (result.failure_class === "rate_limited") { exitValue = "requeue"; return null; }
        if (result.outcome !== "success") {
          if (await this.recoverManagerTransient(workId, result, runId)) { exitValue = "requeue"; return null; }
          await fail(result.message ?? `Manager replan did not succeed (outcome=${result.outcome}).`);
          return null;
        }
        let report: JsonObject;
        try {
          report = requireManagerReport(result, "manager replan");
        } catch (error) {
          await fail(humanizeUnexpected(error, "manager.replan").message);
          return null;
        }
        if (report.event !== "task.replanned") {
          await fail("The Manager replan result did not return a task.replanned event.");
          return null;
        }
        current.report = report;
        return { report, runId };
      },
      parse: (report) => {
        const parsed = this.withoutFullTestCriteria(managerTasksToPlanItems(report.tasks, workId, { allowEmpty: true }), report);
        return { ...parsed, taskActions: managerTaskActions(report.task_actions) };
      },
      validate: async ({ items, taskActions }) => {
        const snapshot = current.snapshot as ReplanSnapshot;
        let update: ManagerWorkSummaryUpdate | null;
        try {
          update = managerWorkSummaryUpdate(current.report);
        } catch (error) {
          await fail(humanizeUnexpected(error, "manager.replan").message);
          return null;
        }
        const acceptanceRevisionRequired = new Map<string, string>();
        const acceptanceDefects = new Map<string, readonly AcceptanceDefect[]>();
        for (const id of failedTaskIds) {
          if (!pendingAcceptanceDefect(this.host.db, id)) continue;
          acceptanceDefects.set(id, (failedTaskBrief(this.host.db, id)?.acceptance_defects ?? []) as unknown as AcceptanceDefect[]);
          const row = this.host.db.get<{ acceptance: string }>("SELECT acceptance FROM tasks WHERE id = ?", id);
          if (row) acceptanceRevisionRequired.set(id, row.acceptance);
        }
        // The new criteria lost their whole-suite criteria and were renumbered above; the stored ones they are checked
        // against go through the same strip, or dropping an Owner's whole-suite criterion (and the ids it shifts) reads as
        // an automatic replan breaking the Owner's criteria.
        const storedWithoutFullTest = (json: string | null, acceptance: string): readonly StoredAcceptanceCriterion[] =>
          stripFullTestCriteria(readStoredAcceptanceCriteria(json, acceptance)).criteria;
        // A budget_exhausted Task must come back with a different approach: remember what it was planned with.
        const differentApproachRequired = new Map<string, PlannedApproach>();
        for (const id of budgetExhaustedTaskIds(trigger)) {
          const row = this.host.db.get<{ context: string | null; plan_context_json: string | null; acceptance: string; acceptance_criteria_json: string | null }>(
            "SELECT context, plan_context_json, acceptance, acceptance_criteria_json FROM tasks WHERE id = ?",
            id,
          );
          if (!row) continue;
          const planned = readStoredTaskPlanContext(row.plan_context_json, row.context);
          differentApproachRequired.set(id, {
            context: planned.context,
            notes: planned.manager_notes,
            criteria: storedWithoutFullTest(row.acceptance_criteria_json, row.acceptance).map((criterion) => ({ text: criterion.text, check: criterion.check })),
          });
        }
        const currentCriteria = new Map<string, readonly StoredAcceptanceCriterion[]>();
        for (const task of snapshot.tasks) {
          const row = this.host.db.get<{ acceptance: string; acceptance_criteria_json: string | null }>("SELECT acceptance, acceptance_criteria_json FROM tasks WHERE id = ?", task.id);
          if (row) currentCriteria.set(task.id, storedWithoutFullTest(row.acceptance_criteria_json, row.acceptance));
        }
        const readyIds = snapshot.tasks.filter((task) => task.status === "ready").map((task) => task.id);
        const revisable = ownerReplan?.kind === "instruction"
          ? new Map(this.host.db.all<{ id: string; type: string }>(`SELECT id, type FROM tasks WHERE id IN (${readyIds.map(() => "?").join(",")})`, ...readyIds).map((row) => [row.id, row.type] as const))
          : undefined;
        const automaticReplan = ownerReplan === null || ownerReplan.kind === "auto_conflict" || ownerReplan.kind === "auto_final";
        const validated = validateReplan(items, snapshot, failedTaskIds, { actions: taskActions, allowOpen: ownerReplan !== null, revisable, acceptanceRevisionRequired, acceptanceDefects, differentApproachRequired, currentCriteria, automatic: automaticReplan, qualitySettings: quality });
        if (isPlanRejection(validated)) return { errors: validated.errors };
        let prerequisites: ReadonlyMap<string, PrerequisiteSpec> = new Map();
        if (validated.waits.size > 0) {
          const resolved = await this.resolvePrerequisiteWaits(workId, validated.waits);
          if ("errors" in resolved) return { errors: resolved.errors };
          prerequisites = resolved.specs;
        }
        // partial_repeated: the Manager must say whether the rule applies; an empty rule_applicability is a missing field.
        const missingRules = partialRepeatedTaskIds(trigger).filter((id) => validated.revisions.has(id) && (validated.revisions.get(id)?.rule_applicability ?? []).length === 0);
        if (missingRules.length > 0) {
          const errors = missingRules.map((id) => `Task ${id}: auto_recovery.rule_applicability must not be empty for a partial_repeated recovery; judge, for each open criterion, whether the rule the Worker cited applies.`);
          return { errors, feedback: { kind: "fields_missing", errors, warnings: [] } };
        }
        return { value: { plan: validated, prerequisites, update } };
      },
      onRejected: async (attempt, runId, feedback, errors) => {
        console.warn(`[owl-core] Manager replan attempt ${attempt} for Work ${workId} was rejected: ${errors.join(" ")}`);
        await this.recordReplanRejected(workId, attempt, runId, trigger.kind, feedback.kind, errors);
      },
    });
    if (inspected.kind === "stopped") return exitValue;
    if (inspected.kind === "recovered") return "requeue";
    if (inspected.kind === "fatal") {
      await fail(humanizeUnexpected(inspected.error, "manager.replan").message);
      return "done";
    }
    if (inspected.kind === "rejected") {
      await fail(`The Manager's replan was rejected twice. ${inspected.errors.join(" ")}`, inspected.attempts);
      return "done";
    }
    let plan: ReplanPlan = inspected.value.plan;
    const prerequisites = inspected.value.prerequisites;
    const planSnapshot = current.snapshot as ReplanSnapshot;
    const summaryUpdate = inspected.value.update;
    const { fullRun, removedOwner } = inspected.parsed;
    const planWorkVersion = current.stateVersion;
    const shown = (current.request.context as JsonObject).work as JsonObject;
    const summaryBase = { title: String(shown.title), summary: String(shown.summary ?? "") };
    const managerRunId = inspected.runId;
    // Kind 8: before the plan is applied, Core runs the Manager's checks for a repeated partial report and settles the criteria.
    const repaired = await this.repairRepeatedPartial(workId, plan, trigger, managerRunId, quality, () => this.host.started && this.isReplanStillCurrent(workId, planWorkVersion, ownerReplan !== null));
    if (repaired === null) return "requeue";
    plan = repaired;
    // Before the empty-plan return: a replan with no Tasks can still ask for the whole suite at the end.
    if (fullRun) await this.markFullTestRun(workId, removedOwner);
    // An empty plan with no root failure writes nothing: the next tick sees
    // every Task terminal and runs the final check.
    if (plan.newItems.length === 0 && plan.reopenIds.length === 0 && plan.supersessions.size === 0 && (plan.actions?.size ?? 0) === 0 && (plan.reviseIds?.length ?? 0) === 0) {
      if (ownerReplan !== null) {
        await this.host.writeLane.write({
          mutateState: (transaction) => {
            deleteOwnerReplan(transaction, workId, "attempted");
            applyManagerWorkSummaryUpdateInTransaction(transaction, { work_id: workId, update: summaryUpdate, owner_replan: ownerReplan, agent_run_id: managerRunId, base: summaryBase });
            insertInstructionReply(transaction, messageIds, "no_change", null, INSTRUCTION_REPLY_TEXT[language].noChange);
          },
          event: { idempotencyKey: `instruction-reply:${createUlid()}`, type: "message.posted", workId, payload: { kind: "message_posted", schema_version: "1.0.0" } },
          outbox: [{ provider: "websocket" }],
        });
      }
      await this.host.dispatcher.replayPending();
      return "done";
    }
    // M2: one WriteLane transaction applies the whole plan after re-checking
    // the Work state, the plan revision and every root Task's status.
    const guard = {
      base_plan_revision: planSnapshot.plan_revision ?? 0,
      root_statuses: new Map([...planSnapshot.tasks.map((task) => [task.id, task.status] as const), ...(plan.reviseIds ?? []).map((id) => [id, "ready"] as const)]),
      owner_replan: ownerReplan !== null,
      manager_agent_run_id: managerRunId,
      partial_repeated_task_ids: partialRepeatedTaskIds(trigger),
    };
    try {
      const applied = await this.host.workflow.applyReplan(
        workId,
        plan,
        guard,
        `Manager replan: ${trigger.kind}`,
        ownerReplan !== null,
        {
          prerequisites,
          afterApply: (transaction, result) => {
            if (trigger.kind === "design_completed") this.insertDesignHandedMarkers(transaction, trigger.design_task_ids);
            // The budget is given back once, here; the auto-recovery count is not reset so the next exhaustion counts against the same limit.
            for (const id of budgetExhaustedTaskIds(trigger)) restartLineageBudgetInTransaction(transaction, id, utcNow());
            applyManagerWorkSummaryUpdateInTransaction(transaction, { work_id: workId, update: summaryUpdate, owner_replan: ownerReplan, agent_run_id: managerRunId, base: summaryBase });
            const revision = transaction.get<{ plan_revision: number }>("SELECT plan_revision FROM works WHERE id = ?", workId)?.plan_revision ?? 0;
            const title = (taskId: string): string => transaction.get<{ title: string }>("SELECT title FROM tasks WHERE id = ?", taskId)?.title ?? taskId;
            const summary: ReplanSummary = {
              planRevision: revision,
              added: result.registered.map((task) => task.title),
              redone: [...result.reopened, ...result.revised].map(title),
              replaced: Object.entries(result.replacements).map(([oldId, newIds]) => `${title(oldId)} → ${newIds.map(title).join(", ")}`),
            };
            insertInstructionReply(transaction, messageIds, "tasks_changed", revision, INSTRUCTION_REPLY_TEXT[language].tasksChanged(summary));
          },
        },
      );
      await this.host.announceDecisionCancellations(applied.cancelled_decision_ids);
      // An Owner-wait Decision the plan opened is announced once its explanation is written; no later tick is guaranteed on this path.
      if (this.host.started) await this.host.announceCoreDecisions(workId);
      await this.signalStoppedTaskRuns(applied.stopped_task_ids);
      this.host.trackWorktreeReconcile(workId, "replan_applied");
    } catch (error) {
      if (!this.host.started) return "requeue";
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
    await this.host.dispatcher.replayPending();
    return "done";
  }

  /**
   * Kind 8 (partial_repeated), after the Manager's plan is accepted and before it is applied, for each retried Task of the trigger:
   * (a) run the Manager's criterion_checks once each in the Task's last worktree; all passed: keep the stored criteria and have the Worker report with the results;
   * (b) otherwise loosen only Manager-made criteria that failed or were not allowed, within the criteria_too_strict limit;
   * (c) add the Manager's rule_applicability to the end of the notes.
   * Returns the plan to apply, or null when the Work changed while the checks ran (the replan is asked again).
   */
  async repairRepeatedPartial(
    workId: string,
    plan: ReplanPlan,
    trigger: ManagerTrigger,
    managerRunId: string,
    quality: PlanQualitySettings,
    isCurrent: () => boolean,
  ): Promise<ReplanPlan | null> {
    const ids = partialRepeatedTaskIds(trigger).filter((id) => plan.revisions.has(id));
    if (ids.length === 0) return plan;
    const revisions = new Map(plan.revisions);
    const steps: { id: string; payload: JsonObject; relax: boolean }[] = [];
    for (const id of ids) {
      const revision = revisions.get(id) as NonNullable<ReturnType<typeof revisions.get>>;
      const row = this.host.db.get<{ acceptance: string; acceptance_criteria_json: string | null; worktree_path: string | null; context: string | null; plan_context_json: string | null }>(
        "SELECT acceptance, acceptance_criteria_json, worktree_path, context, plan_context_json FROM tasks WHERE id = ?", id);
      if (!row) continue;
      const stored = readStoredAcceptanceCriteria(row.acceptance_criteria_json, row.acceptance);
      const last = lineagePartialReportPayloads(this.host.db, id, 1)[0];
      const open = (last ? openCriteriaStatuses({ report: last.report, verification: last.verification }) : null)?.open ?? new Map<string, string>();
      // (a) at most one check for each open criterion, in the Manager's order.
      const seen = new Set<string>();
      const checks = (revision.criterion_checks ?? []).filter((check) => open.has(check.criterion_id) && !seen.has(check.criterion_id) && seen.add(check.criterion_id));
      const eventWorktree = this.host.db.get<{ worktree_path: string | null }>(
        "SELECT json_extract(payload_json, '$.worktree_path') AS worktree_path FROM events WHERE task_id = ? AND type = 'task.failure.classified' ORDER BY sequence DESC LIMIT 1", id)?.worktree_path ?? null;
      const cwd = [row.worktree_path, eventWorktree].find((path): path is string => typeof path === "string" && path.length > 0 && existsSync(path)) ?? null;
      const results = await this.host.workflow.runManagerCriterionChecks(workId, id, checks, cwd);
      if (!isCurrent()) return null;
      const passedAll = open.size > 0 && [...open.keys()].every((criterionId) => results.some((result) => result.criterion_id === criterionId && result.status === "passed"));
      const statusOf = (criterionId: string): CriterionCheckResult["status"] | null => results.find((result) => result.criterion_id === criterionId)?.status ?? null;
      let next = revision;
      let relaxed: string[] = [];
      if (passedAll) {
        // The criteria were never too strict: the stored ones stay and the Worker reports with Core's results as the evidence.
        const legacy = stored.some((criterion) => criterion.legacy === true);
        next = { ...next, acceptance: row.acceptance, acceptance_criteria: legacy ? undefined : stored as unknown as NonNullable<typeof revision.acceptance_criteria>, criteria_relaxations: [] };
      } else {
        // (b) only a Manager-made criterion that failed or was not allowed may be loosened, and only while criteria_too_strict has a try left.
        const target = { kind: "task", id: lineageRootOf(this.host.db, id) } as const;
        const tryLeft = autoRecoveryUsed(this.host.db, "criteria_too_strict", target) < autoRecoveryLimit(this.host.db, "criteria_too_strict");
        const eligible = new Set(tryLeft
          ? stored.filter((criterion) => isManagerCriterion(criterion) && ["failed", "not_allowed"].includes(statusOf(criterion.id) ?? "")).map((criterion) => criterion.id)
          : []);
        const revisedCriteria = revision.acceptance_criteria ?? [];
        const kept = revisedCriteria.map((criterion) => {
          const before = stored.find((entry) => entry.id === criterion.id);
          const changed = before !== undefined && (before.text !== criterion.text || before.check !== criterion.check);
          return changed && !eligible.has(criterion.id) ? before as unknown as typeof criterion : criterion;
        });
        let relaxations = (revision.criteria_relaxations ?? []).filter((record) => eligible.has(record.criterion_id));
        if (evaluateCriteriaRelaxation(stored, kept, relaxations, quality).length > 0) {
          // The kind 7 check refuses the loosened wording: every criterion goes back to what is stored.
          relaxations = [];
          kept.forEach((_criterion, index) => {
            const before = stored.find((entry) => entry.id === kept[index].id);
            if (before !== undefined) kept[index] = before as unknown as typeof kept[number];
          });
        }
        relaxed = relaxations.map((record) => record.criterion_id).filter((criterionId) => {
          const before = stored.find((entry) => entry.id === criterionId);
          const after = kept.find((entry) => entry.id === criterionId);
          return before !== undefined && after !== undefined && (before.text !== after.text || before.check !== after.check);
        });
        next = revision.acceptance_criteria === undefined
          ? { ...next, criteria_relaxations: [] }
          : { ...next, acceptance_criteria: kept, acceptance: renderAcceptanceCriteria(kept), criteria_relaxations: relaxations.filter((record) => relaxed.includes(record.criterion_id)) };
      }
      // (c) the Manager's judgement of the rule goes to the end of the notes, which the Worker reads as manager_notes.
      const planned = readStoredTaskPlanContext(row.plan_context_json, row.context);
      const base = next.plan_context ?? { context: planned.context, notes: planned.manager_notes, necessity: planned.necessity };
      const notes = appendRuleSection(base.notes, next.rule_applicability ?? []);
      const display = next.context === undefined ? undefined : `${next.context.replace(/\s+$/u, "")}\n\n${notes.slice(notes.lastIndexOf(RULE_SECTION_HEADING))}`;
      next = { ...next, plan_context: { ...base, notes }, ...(display === undefined ? {} : { context: display }) };
      revisions.set(id, next);
      steps.push({
        id,
        relax: relaxed.length > 0,
        payload: {
          schema_version: 1, kind: "partial_repeated", target_kind: "task", target_id: lineageRootOf(this.host.db, id), step: "criterion_checks",
          check_results: toJsonResults(results), all_passed: passedAll, relaxed_criteria: relaxed,
        },
      });
    }
    await this.host.writeLane.transact((transaction) => {
      const now = utcNow();
      for (const step of steps) {
        appendEventInTransaction(transaction, {
          type: "recovery.step",
          idempotencyKey: `partial-repeated-step:${step.id}:${managerRunId}`,
          workId,
          taskId: step.id,
          payload: step.payload,
          now,
        });
        // A loosening is one more criteria_too_strict recovery, counted once per replan.
        if (step.relax) {
          recordAutoRecoveryInTransaction(transaction, {
            kind: "criteria_too_strict", target: { kind: "task", id: lineageRootOf(transaction, step.id) }, workId, action: "relax_criteria",
            sourceEventId: `partial-repeated:${managerRunId}:${step.id}`,
            previousFailure: { summary: "The same partial report came again; the Manager loosened a criterion that failed Core's check.", error_key: "partial_repeated" }, now,
          });
        }
      }
      return null;
    });
    return { ...plan, revisions };
  }

  /** Stop the Agents still working on Tasks a replan cancelled, replaced or completed (their runs are already cancel_requested). */
  async signalStoppedTaskRuns(taskIds: readonly string[]): Promise<void> {
    if (taskIds.length === 0) return;
    const runs = this.host.db.all<{ id: string; role: string; pid: number | null; process_start_time: string | null; process_cmdline_sha256: string | null }>(
      `SELECT id, role, pid, process_start_time, process_cmdline_sha256 FROM agent_runs
        WHERE status = 'cancel_requested' AND task_id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(taskIds),
    );
    for (const run of runs) {
      await this.host.signalAgentRun(run, false, (id) => `Failed to signal Agent ${id} of a stopped Task`);
    }
  }

  /**
   * Resolve each retried Task's wait_for against the database and git:
   * "#<number>" to a work id, base_head from the Project's base branch,
   * deadline_at from progress_guard. Problems come back as rejection lines
   * for the Manager's repair attempt.
   */
  async resolvePrerequisiteWaits(
    workId: string,
    waits: ReadonlyMap<string, PlanWaitFor>,
  ): Promise<{ readonly specs: ReadonlyMap<string, PrerequisiteSpec> } | { readonly errors: readonly string[] }> {
    const errors: string[] = [];
    const specs = new Map<string, PrerequisiteSpec>();
    const hasProject = this.host.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId)?.project_id != null;
    const deadline = new Date(Date.now() + progressGuard(this.host.db).prerequisite_max_wait_hours * 3_600_000).toISOString();
    for (const [taskId, wait] of waits) {
      const name = this.host.db.get<{ title: string }>("SELECT title FROM tasks WHERE id = ?", taskId)?.title ?? taskId;
      const conditions: PrerequisiteCondition[] = [];
      for (const [index, condition] of wait.conditions.entries()) {
        const field = "Task " + name + " wait_for.conditions[" + index + "]";
        if (condition.kind === "task") {
          const target = this.host.db.get<{ work_id: string; status: string }>("SELECT work_id, status FROM tasks WHERE id = ?", condition.target);
          if (!target) errors.push(field + ": Task " + condition.target + " does not exist.");
          else if (target.work_id === workId) errors.push(field + ": Task " + condition.target + " is in this Work; use depends_on instead of wait_for.");
          else if (target.status === "cancelled") errors.push(field + ": Task " + condition.target + " is cancelled and can never complete.");
          else conditions.push({ kind: "task", task_id: condition.target, description: condition.description });
        } else if (condition.kind === "work") {
          const number = /^#(\d+)$/u.exec(condition.target);
          const target = number
            ? this.host.db.get<{ id: string; state: string }>("SELECT id, state FROM works WHERE display_number = ?", Number(number[1]))
            : this.host.db.get<{ id: string; state: string }>("SELECT id, state FROM works WHERE id = ?", condition.target);
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
        const facts = await this.host.git.baseBranchFacts?.({ work_id: workId, paths: [] });
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
  /** The title and latest reported reason of a failed Task, for the Decision the Owner reads. */
  failedTaskCause(taskId: string): ReplanFailureCause["tasks"][number] {
    const title = this.host.db.get<{ title: string }>("SELECT title FROM tasks WHERE id = ?", taskId)?.title ?? taskId;
    const row = this.host.db.get<{ payload_json: string }>(
      `SELECT reports.payload_json FROM reports JOIN agent_runs ON agent_runs.id = reports.agent_run_id
        WHERE agent_runs.task_id = ? ORDER BY reports.created_at DESC LIMIT 1`,
      taskId,
    );
    const report = row ? parseStoredJsonObject(row.payload_json, "report", taskId) : null;
    const lines: string[] = [];
    const add = (value: unknown): void => {
      if (typeof value === "string" && value.trim().length > 0) lines.push(value.trim());
    };
    const blocker = report?.external_blocker;
    if (blocker !== null && typeof blocker === "object" && !Array.isArray(blocker)) add((blocker as JsonObject).summary);
    if (Array.isArray(report?.remaining_issues)) {
      for (const issue of report.remaining_issues) add(issue !== null && typeof issue === "object" ? (issue as JsonObject).issue : issue);
    }
    add(report?.question_for_manager);
    if (lines.length > 0) return { title, cause: lines.join(" ") };
    // No usable report: fall back to the Task's failure record (crash, classified failure, verification, conflict, review).
    const brief = failedTaskBrief(this.host.db, taskId);
    const failure = isRecord(brief?.failure) ? brief.failure : {};
    for (const key of ["summary", "reason", "question", "work_done"]) add(failure[key]);
    if (failure.kind === "acceptance_defect" && lines.length === 0 && Array.isArray(brief?.acceptance_defects)) {
      for (const defect of brief.acceptance_defects) add(isRecord(defect) ? defect.reason : undefined);
    }
    const conflictFiles = failure.kind === "merge_conflict" && Array.isArray(failure.merge_conflict_files)
      ? failure.merge_conflict_files.filter((file): file is string => typeof file === "string")
      : [];
    const failedChecks: string[] = [];
    const verification = failure.kind === "verification_failed" && isRecord(brief?.verification_failure) ? brief.verification_failure : null;
    if (verification !== null) {
      // Failed test names and check ids say which check failed; a check's detail is internal English and stays in the event.
      const tests = isRecord(verification.test_failures) && Array.isArray(verification.test_failures.failures) ? verification.test_failures.failures : [];
      for (const test of tests) {
        if (isRecord(test) && typeof test.name === "string") failedChecks.push(typeof test.file === "string" ? `${test.file}: ${test.name}` : test.name);
      }
      if (failedChecks.length === 0 && Array.isArray(verification.commands)) {
        for (const command of verification.commands) {
          if (!isRecord(command) || command.passed !== false || typeof command.command_id !== "string") continue;
          failedChecks.push(typeof command.file === "string" ? `${command.command_id} (${command.file})` : command.command_id);
        }
      }
    }
    return { title, cause: lines.length > 0 ? lines.join(" ") : null, failedChecks, conflictFiles };
  }

  async openManagerReplanFailureDecision(
    workId: string,
    failedTaskIds: readonly string[],
    detail: string,
    question?: string,
    finalVerdict: JsonObject | null = null,
    autoConflictFiles?: readonly string[],
    rejectedAttempts?: number,
  ): Promise<void> {
    // Only root failures are blocked: a cascaded Task stays failed and
    // returns to waiting by itself once the answer resumes its dependency
    // Blocking it would make every non-cancel answer fail.
    const eligibleTaskIds = failedTaskIds.filter((taskId) => {
      const row = this.host.db.get<{ status: string; failed_by_dependency_task_id: string | null }>(
        "SELECT status, failed_by_dependency_task_id FROM tasks WHERE id = ?",
        taskId,
      );
      return row?.status === "failed" && row.failed_by_dependency_task_id === null;
    });
    const scope: "task" | "work" = eligibleTaskIds.length > 0 ? "task" : "work";
    try {
      await this.host.decisions.open({
        request_id: createUlid(),
        idempotency_key: `manager-replan-failed:${createUlid()}`,
        expected_version: 0,
        payload: {
          work_id: workId,
          scope,
          blocked_task_ids: eligibleTaskIds,
          ...withAutoRecoveryTried(
            this.host.db,
            managerReplanFailureBrief(scope, detail, ownerLanguage(this.host.db), question, finalVerdict?.missing, autoConflictFiles, { tasks: eligibleTaskIds.map((taskId) => this.failedTaskCause(taskId)), rejectedAttempts }),
            { workId, taskIds: eligibleTaskIds },
            ownerLanguage(this.host.db),
          ),
          allow_free_text: true,
          issuer_role: "manager",
        },
      });
    } catch (error) {
      console.error(`[owl-core] failed to open Owner Decision after Manager replan failure for Work ${workId}`, error);
      return;
    }
    await this.host.announceCoreDecisions(workId);
    await this.host.dispatcher.replayPending();
  }

  /**
   * The Final Manager reviews every completed Task's report and returns a
   * verdict. A malformed answer or a retryable provider failure gets one
   * more attempt; when no attempt succeeds this throws final_manager_failed
   * (a failed check, never an "incomplete" verdict). Returns null when Core
   * stopped mid-call.
   */
  async runFinalManager(workId: string, workBranchVerification: WorkBranchVerification): Promise<FinalManagerOutcome | null> {
    const work = this.managerWorkContext(workId);
    const tasks = this.host.db.all<TaskRow>("SELECT * FROM tasks WHERE work_id = ? ORDER BY created_at ASC, id ASC", workId);
    const managerTasks = tasks.map((task) => managerTaskView(task, this.taskDependencyIds(task.id)));
    const criteriaIndex = finalCriteriaIndex(this.workSummaryText(workId), tasks.map((task) => ({ id: task.id, status: task.status, acceptance: task.acceptance, acceptance_criteria_json: task.acceptance_criteria_json ?? null })));
    const reports: JsonObject[] = [];
    for (const task of tasks) {
      if (task.status !== "completed") continue;
      const row = this.host.db.get<{ payload_json: string }>(
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
    let lastInvocationId = "";
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
        commit_language: this.host.db.get<{ commit_language: "ja" | "en" | null }>("SELECT projects.commit_language FROM works JOIN projects ON projects.id = works.project_id WHERE works.id = ?", workId)?.commit_language ?? null,
        context: { mode: "finalize", trigger: { kind: "final_check" }, work_id: workId, tasks: managerTasks, reports, work_verification: workVerificationContext, criteria_relaxations: criteriaRelaxationsOfWork(this.host.db, workId), removed_owner_criteria: this.removedOwnerCriteriaOfWork(workId), criteria_index: criteriaIndex as unknown as JsonObject[], goal_shortfalls: goalShortfallsOfWork(this.host.db, workId) as unknown as JsonObject[], design_documents: this.completedDesignDocuments(workId), backlog_items: listInProgressBacklogItemsOfWork(this.host.db, workId).map(({ id, file, line, problem, suggestion }) => ({ id, file, line, problem, suggestion })), ...this.host.processSkillsRequestContext() },
      };
      lastInvocationId = roleRequest.invocation_id;
      const outcome = await this.attemptFinalManager(workId, roleRequest, criteriaIndex);
      if (outcome === null) return null;
      if ("verdict" in outcome) return outcome;
      failure = outcome.failure;
      const retryable = failure.failure_class === "transient" || failure.retry_allowed === true;
      if (!retryable || attempt === FINAL_MANAGER_MAX_ATTEMPTS) break;
      console.warn(`[owl-core] Final Manager attempt ${attempt} for Work ${workId} failed (${failure.error_key ?? failure.outcome}); retrying.`);
      await delay(this.host.options.dispatcher?.manager_retry_delay_ms ?? INITIAL_PLAN_RETRY_DELAY_MS);
      if (!this.host.started) return null;
    }
    if (failure !== null && await this.recoverManagerTransient(workId, failure, lastInvocationId)) return null;
    const cause = failure?.message && failure.message.length > 0 ? failure.message : `outcome=${failure?.outcome ?? "failed"}`;
    throw new HumanReadableError({
      code: "final_manager_failed",
      message: cause,
      remediation: "Retry the final check, or cancel the Work.",
      details: { work_id: workId, error_key: failure?.error_key ?? null },
    });
  }

  /** One Final Manager call: a verdict, a failure result, or null when Core stopped. */
  async attemptFinalManager(
    workId: string,
    request: JsonObject,
    criteriaIndex: readonly FinalCriterionRef[],
  ): Promise<FinalManagerOutcome | { readonly failure: AgentRunResult } | null> {
    let raw: unknown;
    try {
      raw = await this.invokeManagerPlan(request, "manager.finalize");
    } catch (error) {
      if (!this.host.started) return null;
      // The role-shaped runner path throws its runtime error unchanged.
      return { failure: finalManagerErrorResult(error, ownerLanguage(this.host.db)) };
    }
    if (!this.host.started) return null;
    if (raw === null) return null;
    try {
      const result = normalizeManagerResult(raw, "finalize");
      if (result.failure_class === "rate_limited") return null;
      const agentRunId = typeof request.invocation_id === "string" ? request.invocation_id : "";
      this.recordSkillFeedback(agentRunId, result.skill_feedback);
      if (result.outcome !== "success") return { failure: result };
      const report = requireManagerReport(result, "manager finalization");
      const settled = settleFinalVerdict(requireManagerVerdict(report.verdict, workId), criteriaIndex);
      return { verdict: settled.verdict, settled, criteria_index: criteriaIndex, agent_run_id: agentRunId };
    } catch (error) {
      return { failure: finalManagerErrorResult(error, ownerLanguage(this.host.db)) };
    }
  }

  /** Stores the goals this final check found unmet or met before the verdict is acted on, so an incomplete round keeps them. */
  async recordFinalGoalShortfalls(workId: string, settled: SettledFinalVerdict, criteriaIndex: readonly FinalCriterionRef[]): Promise<void> {
    if (settled.goal_items.length === 0 && settled.goals_met.length === 0) return;
    const now = utcNow();
    await this.host.writeLane.write({
      mutateState: (transaction) => {
        recordFinalGoalShortfalls(transaction, workId, settled, criteriaIndex, now);
        return {};
      },
      event: {
        idempotencyKey: `work-goal-shortfalls-recorded:${workId}:${createUlid()}`,
        type: "work.goal_shortfalls_recorded",
        workId,
        payload: { schema_version: "1.0.0", work_id: workId, goal_items: settled.goal_items as unknown as JsonObject[], goals_met: settled.goals_met as unknown as JsonObject[] },
      },
      outbox: [],
    });
  }

  recordSkillFeedback(agentRunId: string, feedback: AgentRunResult["skill_feedback"]): void {
    if (!feedback) return;
    try {
      void this.host.skillBox.recordFeedback(agentRunId, feedback).catch((error) => {
        console.warn(`[owl-core] Could not record Manager skill feedback for Agent run ${agentRunId}`, error);
      });
    } catch (error) {
      console.warn(`[owl-core] Could not record Manager skill feedback for Agent run ${agentRunId}`, error);
    }
  }

  taskDependencyIds(taskId: string): string[] {
    return this.host.db.all<{ depends_on_task_id: string }>(
      "SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id ASC",
      taskId,
    ).map((dependency) => dependency.depends_on_task_id);
  }

  /**
   * The system.alert a Core Decision was opened for: the Work's latest alert
   * written no later than the Decision itself. null for other Decisions.
   */
  decisionSourceAlert(decisionId: string): JsonObject | null {
    const row = this.host.db.get<{ payload_json: string }>(
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
  latestSystemAlert(workId: string): JsonObject | null {
    const row = this.host.db.get<{ payload_json: string }>(
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

  managerWorkContext(workId: string): JsonObject {
    const work = this.host.db.get<Omit<WorkDbRow, "display_number"> & { advisor_backlog_json: string | null }>(
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
      owner_guidance: ownerGuidance(this.host.db, workId),
    };
  }

  /** True when the Task failed only because a dependency failed (dependency cascade). */
  isCascadedFailure(taskId: string): boolean {
    const row = this.host.db.get<{ failed_by_dependency_task_id: string | null }>(
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
  planOverview(workId: string): JsonObject[] {
    const rows = this.host.db.all<TaskRow>(
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
      depends_on: this.host.db.all<{ depends_on_task_id: string }>(
        "SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id ASC",
        row.id,
      ).map((dependency) => dependency.depends_on_task_id),
    }));
  }

  async invokeManagerPlan(request: unknown, operation: string): Promise<unknown> {
    if (!this.host.started) return null;
    const { workId, taskId } = extractManagerRequestIds(request, operation);
    const agentRunId = isRecord(request) && typeof request.invocation_id === "string" && request.invocation_id.length > 0
      ? request.invocation_id
      : createUlid();
    try {
      return await this.runManagerPlanRecorded(request, operation, workId, taskId, agentRunId);
    } catch (error) {
      if (error === MANAGER_PAUSED_AT_START) return null;
      if (!isAgentRunStopped(error)) throw error;
      await this.closeStoppedManagerRun(workId, taskId, agentRunId);
      return null;
    }
  }

  /** A Manager run the Owner stopped ends cancelled; its result is never applied. */
  async closeStoppedManagerRun(workId: string, taskId: string | null, agentRunId: string): Promise<void> {
    await this.host.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        const now = utcNow();
        setAgentRunStatus(transaction, agentRunId, "cancelled", { now, from: LIVE_AGENT_RUN_STATUSES, endedAt: "coalesce" });
        return { agent_run_id: agentRunId, result_ignored: true };
      },
      event: {
        idempotencyKey: `manager-result-ignored:${agentRunId}`,
        type: "agent.exited",
        workId,
        taskId,
        agentRunId,
        payload: { agent_run_id: agentRunId, outcome: "cancelled", result_ignored: true, reason: "manager_result_arrived_after_owner_pause" },
      },
      outbox: [{ provider: "websocket" }],
    });
  }

  async runManagerPlanRecorded(request: unknown, operation: string, workId: string, taskId: string | null, agentRunId: string): Promise<unknown> {
    const managerRoleModel = resolveRoleModel(this.host.db, "manager", { anyRoleDefault: true });
    const managerProvider = managerRoleModel?.provider ?? "anthropic";
    if (this.host.providerPauseController.isPaused(managerProvider)) return null;
    // A counted automatic wait after a temporary provider error: no Manager call before its resume time.
    if (transientRecoveryPendingUntil(this.host.db, workId) !== null) return null;
    // Resolved before the run is recorded: invalid Work rules fail the call
    // without leaving a running Manager row behind.
    const managerRules = this.host.composeRulesForRole("manager", workId);
    const managerSkills = this.host.workflow.composeSkillsForWork(workId);
    const managerKnowledge = await this.host.composeKnowledgeForWork(workId);
    await this.host.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        // An Owner pause that committed after the caller's check leaves no run behind.
        if (transaction.get<{ state: string }>("SELECT state FROM works WHERE id = ?", workId)?.state === "paused") throw MANAGER_PAUSED_AT_START;
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
    if (!this.host.started) return null;
    const managerProjectId = this.host.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId)?.project_id;
    const requestWithRules = {
      ...(addManagerRules(request, managerRules, managerSkills, managerKnowledge) as Record<string, unknown>),
      language: ownerLanguage(this.host.db),
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
      const runner = this.host.options.agentRunner.runManagerPlan as unknown as (input: unknown) => Promise<unknown>;
      // A thrown rate limit takes the same pause path as a returned one.
      result = await runner.call(this.host.options.agentRunner, enrichedRequest).catch(rethrowUnlessRateLimited);
    } catch (error) {
      if (!this.host.started) return null;
      await this.host.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) => {
          assertAgentRunNotStopped(transaction, agentRunId);
          const now = utcNow();
          setAgentRunStatus(transaction, agentRunId, "failed", { now });
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
            reason: formatRuntimeFailure(error, "Manager", ownerLanguage(this.host.db)),
            ...(isRecord(error) && error.outcome === "failed_after_side_effect" ? sideEffectFailureFields(SIDE_EFFECT_FAILURE_PREFIX) : {}),
          },
        },
        outbox: [{ provider: "websocket" }],
      });
      throw humanizeUnexpected(error, operation);
    }
    if (!this.host.started) return result;
    if (isRateLimitedAgentRunResult(result)) {
      const pause = await this.host.providerPauseController.recordRateLimit({
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
      await this.host.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) => {
          assertAgentRunNotStopped(transaction, agentRunId);
          const now = utcNow();
          setAgentRunStatus(transaction, agentRunId, "exited", { now, usageJson: usageJsonValue });
          // A 429 wait is shown with the other automatic recoveries but never counted.
          recordAutoRecoveryInTransaction(transaction, {
            kind: "provider_transient",
            target: { kind: "work", id: workId },
            workId,
            action: "wait_rate_limit",
            sourceEventId: agentRunId,
            previousFailure: { summary: result.message ?? "rate limited", error_key: result.error_key ?? "rate_limited", detail: null },
            counted: false,
            resumeAt: pause.resume_at,
          });
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
      const run = this.host.db.get<{ provider: string; started_at: string | null; created_at: string }>(
        "SELECT provider, started_at, created_at FROM agent_runs WHERE id = ?", agentRunId,
      );
      if (run) await this.host.providerPauseController.noteProviderSucceeded(run.provider, run.started_at ?? run.created_at);
    }
    if (operation !== "manager.finalize") {
      const feedback = isRecord(result) ? result.skill_feedback as AgentRunResult["skill_feedback"] | undefined : undefined;
      this.recordSkillFeedback(agentRunId, feedback ?? null);
    }
    // The tokens this Manager call spent, stored with its final status.
    const usage = isRecord(result) ? usageJson(result.usage) : null;
    if (isRecord(result) && typeof result.outcome === "string" && result.outcome !== "success") {
      const failure = typeof result.message === "string" && result.message.length > 0 ? result.message : `outcome=${result.outcome}`;
      await this.host.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) => {
          assertAgentRunNotStopped(transaction, agentRunId);
          const now = utcNow();
          setAgentRunStatus(transaction, agentRunId, "failed", { now, usageJson: usage });
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
    await this.host.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        assertAgentRunNotStopped(transaction, agentRunId);
        const now = utcNow();
        setAgentRunStatus(transaction, agentRunId, "completed", { now, outcome: "success", usageJson: usage });
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

}

export interface OwnerReplanRequest {
  readonly kind: "decision" | "reopen" | "instruction" | "work_update" | "auto_conflict" | "auto_final";
  readonly answer: string;
  /** Owner instruction messages this request answers; the Manager's reply links back to them. */
  readonly message_ids?: readonly string[];
  /** What the Manager reads: one entry per Owner request, the Owner's text whole. Absent on a request built from an older marker. */
  readonly requests?: readonly OwnerRequestInput[];
}

/** One Owner request as the Manager sees it. `text` is the Owner's words, never joined with another request or with Core text. */
export type OwnerRequestInput =
  | { readonly kind: "decision" | "reopen" | "instruction"; readonly text: string; readonly message_ids: readonly string[] }
  | { readonly kind: "work_update"; readonly changed_fields: readonly ("title" | "summary")[]; readonly previous_title: string | null; readonly previous_summary: string | null };

/**
 * The requests a marker (or a request built from one) carries. An older
 * marker has only `answer`: it is read as one request, never split. The
 * automatic kinds are Core's own doing and are not Owner requests.
 */
export function ownerRequestsOf(value: { readonly requests?: unknown; readonly kind?: unknown; readonly answer?: unknown; readonly message_ids?: unknown }): OwnerRequestInput[] {
  if (Array.isArray(value.requests)) return value.requests.filter(isRecord) as unknown as OwnerRequestInput[];
  if (typeof value.answer !== "string" || value.kind === "auto_conflict" || value.kind === "auto_final") return [];
  if (value.kind === "work_update") return [{ kind: "work_update", changed_fields: [], previous_title: null, previous_summary: null }];
  const kind = value.kind === "reopen" || value.kind === "instruction" ? value.kind : "decision";
  return [{ kind, text: value.answer, message_ids: markerMessageIds(value.message_ids) }];
}

export function markerMessageIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

export function workUpdateReplanAnswer(
  before: Pick<WorkRow, "title" | "summary">,
  after: Pick<WorkRow, "title" | "summary">,
  changedFields: readonly ("title" | "summary")[],
): string {
  const lines: string[] = [];
  if (changedFields.includes("title")) lines.push(`The Owner renamed the Work from "${before.title}" to "${after.title}".`);
  if (changedFields.includes("summary")) lines.push(`The Owner rewrote the Work summary. New summary:\n${after.summary}`);
  return lines.join("\n");
}

export function queueOwnerReplanInTransaction(
  transaction: CoreWriteLaneTransaction,
  workId: string,
  request: OwnerReplanRequest,
  options: { readonly replace?: boolean; readonly processing_message_ids?: readonly string[]; readonly processing?: { readonly kind: OwnerReplanRequest["kind"]; readonly answer: string; readonly requests: readonly OwnerRequestInput[] } } = {},
): void {
  writeOwnerReplan(
    transaction,
    workId,
    {
      kind: request.kind,
      answer: request.answer,
      requests: ownerRequestsOf(request),
      message_ids: request.message_ids ?? [],
      ...(options.processing ? { processing_kind: options.processing.kind, processing_answer: options.processing.answer, processing_requests: options.processing.requests } : {}),
      processing_message_ids: options.processing_message_ids ?? [],
    },
    options.replace === false ? "keep" : "replace",
    utcNow(),
  );
}

/** Join owner answers, skipping empty ones (an attachments-only instruction has answer ""). */
export function joinOwnerAnswers(...answers: readonly string[]): string {
  return answers.filter((text) => text.length > 0).join("\n\n");
}

/** Hand a Decision answer to the Manager as a replan at the next tick. */
export function queueDecisionReplanInTransaction(transaction: CoreWriteLaneTransaction, workId: string, answer: string): void {
  mergeOwnerReplanInTransaction(transaction, workId, { kind: "decision", answer });
}

/** Queue a request, combining it with one that is still queued so neither is lost. */
export function mergeOwnerReplanInTransaction(
  transaction: CoreWriteLaneTransaction,
  workId: string,
  request: OwnerReplanRequest,
): void {
  const value = readOwnerReplan(transaction, workId);
  let merged = request;
  let processing: string[] = [];
  let processingRequest: { kind: OwnerReplanRequest["kind"]; answer: string; requests: OwnerRequestInput[] } | undefined;
  // An instruction the Manager is handling keeps its id beside the new queued one.
  if (value) processing = markerMessageIds(value.status === "attempted" ? value.message_ids : value.processing_message_ids);
  // Keep the body of the request being handled so a requeue can restore it.
  if (value?.status === "attempted") processingRequest = { kind: value.kind as OwnerReplanRequest["kind"], answer: value.answer, requests: ownerRequestsOf(value) };
  else if (value && typeof value.processing_answer === "string") processingRequest = { kind: value.processing_kind as OwnerReplanRequest["kind"], answer: value.processing_answer, requests: ownerRequestsOf({ requests: value.processing_requests, kind: value.processing_kind, answer: value.processing_answer, message_ids: value.processing_message_ids }) };
  if (value?.status === "queued") {
    merged = {
      kind: value.kind === "instruction" || request.kind === "instruction"
        ? "instruction"
        : value.kind === "work_update" || request.kind === "work_update"
          ? "work_update"
          : request.kind,
      answer: joinOwnerAnswers(value.answer, request.answer),
      message_ids: [...new Set([...markerMessageIds(value.message_ids), ...(request.message_ids ?? [])])],
      requests: [...ownerRequestsOf(value), ...ownerRequestsOf(request)],
    };
  }
  queueOwnerReplanInTransaction(transaction, workId, merged, { processing_message_ids: processing, processing: processingRequest });
}

/**
 * A queued marker may still carry the request being handled when the process
 * stopped: fold it into the queued one unless the Manager already answered it.
 */
export function foldProcessingOwnerReplanInTransaction(transaction: CoreWriteLaneTransaction, workId: string): void {
  const value = readOwnerReplan(transaction, workId);
  if (value?.status !== "queued" || typeof value.processing_answer !== "string") return;
  const ids = markerMessageIds(value.processing_message_ids);
  const answered = ids.length > 0 && ids.every((id) => transaction.get(
    "SELECT 1 FROM messages, json_each(json_extract(messages.metadata_json, '$.in_reply_to')) WHERE json_each.value = ? LIMIT 1",
    id,
  ));
  if (answered) clearOwnerReplanProcessing(transaction, workId, utcNow());
  else requeueOwnerReplanInTransaction(transaction, workId);
}

/** Undo `consumeOwnerReplan`: move an `attempted` marker back to `queued`. */
export function requeueOwnerReplanInTransaction(transaction: CoreWriteLaneTransaction, workId: string): void {
  const value = readOwnerReplan(transaction, workId);
  if (value === undefined) return;
  if (value.status === "attempted") {
    setOwnerReplanStatus(transaction, workId, "queued", utcNow());
  } else if (typeof value.processing_answer === "string") {
    // A newer request replaced the one being handled: process both together.
    const kind = (k: unknown) => (k === "instruction" || k === "work_update" ? k : null);
    queueOwnerReplanInTransaction(transaction, workId, {
      kind: kind(value.processing_kind) === "instruction" || kind(value.kind) === "instruction" ? "instruction"
        : kind(value.processing_kind) === "work_update" || kind(value.kind) === "work_update" ? "work_update"
          : value.kind as OwnerReplanRequest["kind"],
      answer: joinOwnerAnswers(value.processing_answer, value.answer),
      message_ids: [...new Set([...markerMessageIds(value.processing_message_ids), ...markerMessageIds(value.message_ids)])],
      requests: [
        ...ownerRequestsOf({ requests: value.processing_requests, kind: value.processing_kind, answer: value.processing_answer, message_ids: value.processing_message_ids }),
        ...ownerRequestsOf(value),
      ],
    });
  }
}

export function requireAgentRunResult(value: unknown, operation: string): AgentRunResult {
  if (!isRecord(value) || (value.outcome !== "success" && value.outcome !== "failed" && value.outcome !== "partial")) {
    throw validationError(`The ${operation} result does not match the AgentRunner contract.`, { operation });
  }
  return value as unknown as AgentRunResult;
}

export function normalizeManagerResult(value: unknown, mode: "finalize"): AgentRunResult {
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

export function requireManagerReport(result: AgentRunResult, operation: string): JsonObject {
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

export function requireManagerVerdict(value: unknown, workId: string): FinalManagerVerdict {
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
    ...(typeof value.commit_subject === "string" ? { commit_subject: value.commit_subject } : {}),
    missing: value.missing,
    unaddressed_backlog_items: (Array.isArray(value.unaddressed_backlog_items) ? value.unaddressed_backlog_items : []).flatMap(
      (entry: unknown) => isRecord(entry) && typeof entry.item_id === "string" && typeof entry.reason === "string" ? [{ item_id: entry.item_id, reason: entry.reason }] : [],
    ),
    lessons: value.lessons,
    goals_met: (Array.isArray(value.goals_met) ? value.goals_met : []).flatMap(
      (entry: unknown) => isRecord(entry) && typeof entry.criterion_ref === "string" && typeof entry.evidence === "string" ? [{ criterion_ref: entry.criterion_ref, evidence: entry.evidence }] : [],
    ),
  };
}

/** Parse the Manager's open-Task actions (cancel / complete); absent means none. */
export function managerTaskActions(value: unknown): readonly ReplanAction[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw validationError("The Manager task_actions must be an array.", {});
  return value.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.task_id !== "string" || entry.task_id.length === 0 ||
      (entry.action !== "cancel" && entry.action !== "complete") ||
      typeof entry.reason !== "string"
    ) {
      throw validationError(`The Manager task_actions[${index}] needs task_id, action (cancel or complete) and reason.`, {});
    }
    return { task_id: entry.task_id, action: entry.action, reason: entry.reason };
  });
}

export function managerTasksToPlanItems(
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
    const assignedDesigner = parseAssignedDesigner(candidate.assigned_designer, type, index);
    const uiChange = parseUiChange(candidate.ui_change, index);
    const necessity = parseTaskNecessity(candidate.necessity);
    // Structured criteria are kept as written; plan quality checks their fields. Only a Task that comes without any is read from its free-text acceptance.
    const criteria = Array.isArray(candidate.acceptance_criteria) ? candidate.acceptance_criteria as AcceptanceCriterion[] : undefined;
    const relaxations = parseCriteriaRelaxations(candidate.auto_recovery, id, workId);
    const recovery = parsePartialRecovery(candidate.auto_recovery, id, workId);
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
      ...(assignedDesigner === null ? {} : { assigned_designer: assignedDesigner }),
      ui_change: uiChange,
      ...(relaxations.length === 0 && recovery.criterion_checks.length === 0 && recovery.rule_applicability.length === 0
        ? {}
        : { auto_recovery: { criteria_relaxations: relaxations, criterion_checks: recovery.criterion_checks, rule_applicability: recovery.rule_applicability } }),
    };
    return item;
  });
}

/** A format error the plan parser found, as fields_missing feedback naming the Task and the field so the Manager can fix it; any other error is not the Manager's to fix (null). */
export function planParseFeedback(error: unknown): PreviousOutputFeedback | null {
  if (!(error instanceof HumanReadableError) || error.code !== "validation_error") return null;
  const { task_id: taskId, index } = error.details;
  const where = typeof taskId === "string" ? `Task ${taskId}: ` : typeof index === "number" ? `Task at index ${index}: ` : "";
  return { kind: "fields_missing", errors: [`${where}${error.message}`], warnings: [] };
}

/** auto_recovery.criteria_relaxations as the Manager wrote them; absent or null reads as none. A missing reason or keeps reads as "" so evaluateCriteriaRelaxation can hand it back to the Manager instead of failing the replan. */
export function parseCriteriaRelaxations(value: unknown, taskId: string, workId: string): CriteriaRelaxation[] {
  if (value === undefined || value === null) return [];
  const list = isRecord(value) ? value.criteria_relaxations : undefined;
  if (list === undefined || list === null) return [];
  const text = (entry: unknown): entry is string => typeof entry === "string";
  if (!Array.isArray(list) || list.some((entry) => !isRecord(entry) || !text(entry.criterion_id))) {
    throw validationError("The Manager plan Task auto_recovery.criteria_relaxations must be a list of criterion_id, reason and keeps.", { work_id: workId, task_id: taskId });
  }
  return list.map((entry) => ({ criterion_id: String(entry.criterion_id), reason: text(entry.reason) ? entry.reason : "", keeps: text(entry.keeps) ? entry.keeps : "" }));
}

/** auto_recovery.criterion_checks and rule_applicability as the Manager wrote them (partial_repeated); absent or null reads as none. */
export function parsePartialRecovery(value: unknown, taskId: string, workId: string): { criterion_checks: CriterionCheck[]; rule_applicability: RuleApplicability[] } {
  const none = { criterion_checks: [], rule_applicability: [] };
  if (!isRecord(value)) return none;
  const checks = value.criterion_checks ?? [];
  const rules = value.rule_applicability ?? [];
  const text = (entry: unknown): entry is string => typeof entry === "string" && entry.trim().length > 0;
  if (!Array.isArray(checks) || checks.some((entry) => !isRecord(entry) || !text(entry.criterion_id) || !Array.isArray(entry.argv) || entry.argv.length === 0 || entry.argv.some((arg) => typeof arg !== "string"))) {
    throw validationError("The Manager plan Task auto_recovery.criterion_checks must be a list of criterion_id and argv (strings).", { work_id: workId, task_id: taskId });
  }
  if (!Array.isArray(rules) || rules.some((entry) => !isRecord(entry) || !text(entry.criterion_id) || !text(entry.rule) || typeof entry.applies !== "boolean" || !text(entry.reason))) {
    throw validationError("The Manager plan Task auto_recovery.rule_applicability must be a list of criterion_id, rule, applies and reason.", { work_id: workId, task_id: taskId });
  }
  return {
    criterion_checks: checks.map((entry) => ({ criterion_id: String(entry.criterion_id), argv: (entry.argv as unknown[]).map(String) })),
    rule_applicability: rules.map((entry) => ({ criterion_id: String(entry.criterion_id), rule: String(entry.rule), applies: entry.applies === true, reason: String(entry.reason) })),
  };
}

export function parseAssignedDesigner(value: unknown, type: string, index: number): "designer" | "lead_designer" | null {
  if (value !== undefined && value !== null && value !== "designer" && value !== "lead_designer") {
    throw validationError("The Manager plan Task assigned_designer must be designer, lead_designer or null.", { field: "assigned_designer", index });
  }
  return type === "design" && typeof value === "string" ? value : null;
}

export function parseUiChange(value: unknown, index: number): UiChange {
  if (value === undefined) return "none";
  if (typeof value !== "string" || !(UI_CHANGE_LEVELS as readonly string[]).includes(value)) {
    throw validationError("The Manager plan Task ui_change must be none, minor or major.", { field: "ui_change", index });
  }
  return value as UiChange;
}

export function baseSyncOnly(value: unknown, index: number): boolean {
  if (typeof value !== "boolean") throw validationError("The Manager plan Task base_sync_only must be a boolean or null.", { field: "base_sync_only", index });
  return value;
}

export function nonEmptyString(value: unknown, field: string, index: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`The Manager plan Task ${field} must be a non-empty string.`, { field, index });
  }
  return value;
}

export class ReplayCommand extends Error {
  public constructor(public readonly response: CommandResponse) {
    super("idempotent command replay");
    this.name = "ReplayCommand";
  }
}

/** Ids of the Tasks the trigger names as partial_repeated. */
export function partialRepeatedTaskIds(trigger: ManagerTrigger): string[] {
  if (trigger.kind !== "task_failed") return [];
  return trigger.tasks.flatMap((task) => (task.kind === "partial_repeated" ? [task.task_id] : []));
}

/** The trigger with a partial_repeated entry for each of these Tasks. */
export function withPartialRepeatedTrigger(trigger: ManagerTrigger, taskIds: readonly string[]): ManagerTrigger {
  const entries = taskIds.map((task_id) => ({ kind: "partial_repeated" as const, task_id }));
  if (trigger.kind !== "task_failed") return { kind: "task_failed", tasks: entries };
  return { kind: "task_failed", tasks: [...trigger.tasks.filter((task) => !taskIds.includes(task.task_id)), ...entries] };
}

/** Ids of the Tasks the trigger names as budget_exhausted. */
export function budgetExhaustedTaskIds(trigger: ManagerTrigger): string[] {
  if (trigger.kind !== "task_failed") return [];
  return trigger.tasks.flatMap((task) => (task.kind === "budget_exhausted" ? [task.task_id] : []));
}

/** The trigger with a budget_exhausted entry for each of these Tasks, so the Manager is told to plan a different approach. */
export function withBudgetExhaustedTrigger(trigger: ManagerTrigger, taskIds: readonly string[]): ManagerTrigger {
  const entries = taskIds.map((task_id) => ({ kind: "budget_exhausted" as const, task_id, require_different_approach: true as const }));
  if (trigger.kind !== "task_failed") return { kind: "task_failed", tasks: entries };
  return { kind: "task_failed", tasks: [...trigger.tasks.filter((task) => !taskIds.includes(task.task_id)), ...entries] };
}

