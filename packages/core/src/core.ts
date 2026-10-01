import { createHash } from "node:crypto";
import { createHash as createFileHash } from "node:crypto";
import { constants, existsSync, mkdirSync, statSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createUlid, utcNow } from "../../db/dist/index.js";
import { DecisionService, type OpenDecisionPayload } from "./decision";
import { managerReplanFailureBrief, RESOLVE_CONFLICT_OPTION_KEY } from "./decision-brief";
import { isFinalLesson, isFinalMissingItem, lessonBlockKey, normalizeLesson, parseLessonBlocks, splitLessonBlocks, type FinalManagerVerdict } from "./final-verdict";
import { DEFAULT_OWNER_LANGUAGE, OWNER_LANGUAGE_SETTINGS_KEY, ownerLanguage, storedOwnerLanguage, type OwnerLanguage } from "./owner-language";
import { EventDispatcher } from "./event-dispatcher";
import { HumanReadableError, dependencyUnavailable, idempotencyConflict, invalidStateTransition, notFound, projectDeletionImpactChanged, projectHasRunningWorks, projectNotFound, providerPauseNotFound, projectPathConflict, validationError, versionConflict, workCancelled, workReopenRequired } from "./errors";
import {
  appendEventInTransaction,
  createWorkInTransaction,
  detachProjectWorksInTransaction,
  ensureOwner,
  isDecisionCancelAnswer,
  isTerminalTaskState,
  managerTriggerKey,
  REPLAN_PLAN_STALE,
  REPLAN_WORK_NOT_RUNNING,
  reduceTaskInTransaction,
  reduceWorkInTransaction,
  restoreCascadedDependentsInTransaction,
  setWorkArchivedInTransaction,
  taskDependenciesCompletedInTransaction,
} from "./state-reducer";
import { WorkDriver } from "./work-driver";
import { WorkflowEngine } from "./workflow-engine";
import { isPlanRejection, validatePlan, validateReplan, type ReplanPlan, type ReplanSnapshot } from "./replan-plan";
import { KnowledgeBase } from "./knowledge-base";
import { KnowledgeNotes } from "./knowledge-notes.js";
import { migrateLegacyKnowledge as runLegacyKnowledgeMigration } from "./knowledge-migration.js";
import { retagKnowledge, type KeywordExtractionItem, type KeywordExtractionResult } from "./knowledge-retag.js";
import { DEFAULT_KNOWLEDGE_LIMITS, KnowledgeRetriever, normalizeKnowledgeLimits, type KnowledgeLimits } from "./knowledge-retrieval.js";
import { ruleKeyFingerprint } from "./learning-fingerprint.js";
import { LearningJobs, LearningPipeline, type LearningJobStatus } from "./learning-pipeline.js";
import { RuleLoadError, RuleStore, parseWorkRules, type RuleReloadResult, type RuleRole } from "./rule-store";
import type { RuleCurationResult } from "./rule-curation.js";
import { RuleProposals, type RuleProposalCreateResult, type RuleProposalStatus } from "./rule-proposals.js";
import { RuleWriter } from "./rule-writer.js";
import { detectSkillReads, SkillBox, type SkillSettings, type SkillState } from "./skill-box";
import { isValidSkillScope, validateSkillFilePath, validateSkillName } from "./skill-files";
import { SKILL_CURATOR_DEBOUNCE_MS, SkillCurator, type SkillCurationResult } from "./skill-curator";
import { AdvisorSessionManager } from "./advisor-session.js";
import { AdvisorSessionRuntime, type AdvisorSettingsSnapshot } from "./advisor-runtime.js";
import { MemorySaver } from "./memory-saver.js";
import { slugifyKnowledgeContentName } from "./knowledge-naming.js";
import { Librarian } from "./librarian.js";
import { LibrarianScheduler } from "./librarian-scheduler.js";
import {
  CurationRunStore,
  type CurationActor,
  type CurationKind,
  type CurationListQuery,
  type CurationRunSummaryView,
  type CurationRunView,
  type CurationTrigger,
} from "./curation-runs.js";
import { summarizeCurationReport } from "./curation-summary.js";
import {
  DEFAULT_KNOWLEDGE_AUTOMATION_SETTINGS,
  KNOWLEDGE_AUTOMATION_SETTINGS_KEY,
  KnowledgeAutomationValidationError,
  readKnowledgeAutomationSettings as parseKnowledgeAutomationSettings,
  validateKnowledgeAutomationSettings,
  type KnowledgeAutomationSettings,
  type KnowledgeAutomationSnapshot,
} from "@owl/shared";
import { EXECUTOR_CONFIG_SETTINGS_KEY, HYBRID_MODE_SETTINGS_KEY } from "./types";
import { GitWorktreeGateway } from "./git-gateway.js";
import { WorkspaceLayout } from "./workspace-layout.js";
import { WorkspaceTooling } from "./workspace-tooling.js";
import { AgentWorkspacePreparer, withWorkspacePreparation, worktreeHarnesses } from "./agent-workspace-preparer.js";
import { redactCredentials } from "./git-push.js";
import { recoverOrphanedState } from "./startup-recovery.js";
import { cleanupWorkForDeletion, reconcileWorktrees, type WorktreeReconcileFailure } from "./worktree-reconciler.js";
import { processIdentityMatches, readProcessIdentity } from "./process-identity.js";
import { formatRuntimeFailure } from "./error-display.js";
import { ADVISOR_TEXT } from "./advisor-text.js";
import { ownerGuidance } from "./owner-guidance.js";
import { failedTaskBrief } from "./task-context.js";
import { detectProcessSkillsPack, type DetectedProcessSkillsPack } from "./process-skills-pack.js";
import { ResearchRecorder, type ResearchAttributionRole } from "./research-recorder.js";
import { RESEARCH_CAPTURE_ROLES } from "../../shared/dist/permission-args.js";
import {
  BACKLOG_STATUSES,
  applyAdvisorBacklogInTransaction,
  detachWorkBacklogOnDeleteInTransaction,
  dismissBacklogItemsInTransaction,
  issueBacklogWorkInTransaction,
  linkBacklogItemsToWorkInTransaction,
  listBacklogItems,
  listInProgressBacklogItemsOfWork,
  releaseWorkBacklogInTransaction,
  type BacklogListFilter,
  type BacklogListResult,
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
  CODEX_BUILTIN_MODELS,
  DEFAULT_AGENT_WALL_TIMEOUT_MS,
  DEFAULT_HARNESS_MODELS,
  DEFAULT_ROLE_MODELS,
  PROJECT_LOCKING_WORK_STATES,
  designDocumentPath,
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
} from "@owl/shared";
import { buildAdvisorProjectCatalogInstruction } from "./advisor-project-context";
import { createProviderPauseStore, type ProviderPauseRow, type ProviderPauseStore } from "./provider-pause-store";
import { createProviderPauseController, type ProviderPauseController, type ProviderPauseEvent } from "./provider-pause-controller";
// Imported from the agent-runtime "types" submodule (not the package barrel) for the
// same reason advisor-runtime.ts does: the barrel re-exports core-contract.d.ts, which
// imports back from "../../core/dist/types.js" and trips TS5055 mid-compile.
import type { AdvisorSuggestedAction, ExecutorConfig, ProcessSkillsInstallCommand, ProviderClient } from "@owl/shared";
import type {
  AgentListQuery,
  AgentRun,
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
  WorkState,
  TaskSummary,
  UpdateModelSettingsPayload,
  UpdateModelPresetPayload,
  VerificationCommand,
  WorkDetail,
  WorkProgress,
  WorkListQuery,
  WorkSummary,
  AdvisorRunRequest,
  AdvisorRunResult,
  WorkflowSnapshot,
  GitGateway,
  GitPushFailure,
  GitPushResult,
  GitWorkMergeResult,
} from "./types";

type PushAlertKind = "work_push_failed" | "work_push_blocked_by_hook" | "work_push_skipped_no_upstream";

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

/** Merge formatted lesson blocks by their text and optional rule scope. */
export function mergeLessonBlocks(existingBody: string | null, newBlocks: readonly string[]): { body: string; added: number } {
  const blocks: string[] = [];
  const keys = new Set<string>();
  for (const block of splitLessonBlocks(existingBody ?? "")) {
    const key = lessonBlockKey(block);
    if (keys.has(key)) continue;
    keys.add(key);
    blocks.push(block);
  }
  let added = 0;
  for (const block of newBlocks.flatMap(splitLessonBlocks)) {
    const key = lessonBlockKey(block);
    if (keys.has(key)) continue;
    keys.add(key);
    blocks.push(block);
    added += 1;
  }
  return { body: blocks.join("\n"), added };
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
  parent_task_id: string | null;
  acceptance: string;
  review_round: number;
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
}

interface MessageDbRow {
  id: string;
  conversation_id: string;
  provider: string;
  source_message_id: string | null;
  body: string;
  attachment_ids_json: string;
  created_at: string;
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
  private readonly providerPauseStore: ProviderPauseStore;
  private readonly providerPauseController: ProviderPauseController;
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
  private readonly logger: Pick<Console, "warn"> = { warn: (message) => console.warn(message) };
  private readonly owlRoot: string;
  private readonly dataDir: string;
  private readonly workspaceLayout: WorkspaceLayout;
  private readonly knownModels: KnownModels;
  public readonly knowledge: KnowledgeBase;
  private readonly knowledgeNotes: KnowledgeNotes;
  private readonly knowledgeRetriever: KnowledgeRetriever;
  public readonly ruleStore: RuleStore;
  public readonly skillBox: SkillBox;
  private processSkillsPack: DetectedProcessSkillsPack | null = null;
  private processSkillsMissingLogged = false;
  public readonly skillCurator: SkillCurator;
  public readonly advisorSessions: AdvisorSessionManager;
  public readonly memorySaver: MemorySaver;
  public readonly librarian: Librarian;
  private readonly librarianScheduler: LibrarianScheduler;
  private readonly curationRuns: CurationRunStore;
  private readonly activeCurations = new Map<CurationKind, Promise<unknown>>();
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
  private learningTimer: ReturnType<typeof setInterval> | null = null;
  private learningTask: Promise<void> = Promise.resolve();
  private skillReconcilePromise: Promise<void> = Promise.resolve();
  private started = false;
  /** The last rule reload failure the Owner was told about; null when rules are healthy. */
  private rulesFailureSignature: string | null = null;

  public constructor(options: CoreOptions) {
    if (!options.db || !options.agentRunner || typeof options.version !== "string" || options.version.length === 0) {
      throw validationError("Core requires db, agentRunner, and a non-empty version.", { fields: ["db", "agentRunner", "version"] });
    }
    this.options = options;
    // §9.2 uses the same initial debounce for LearningPipeline and SkillCurator.
    this.learningPipelineDebounceMs = Number.isSafeInteger(options.skillCuratorDebounceMs)
      && (options.skillCuratorDebounceMs ?? -1) >= 0
      ? options.skillCuratorDebounceMs as number
      : SKILL_CURATOR_DEBOUNCE_MS;
    this.knownModels = options.knownModels ?? defaultKnownModels;
    this.db = options.db;
    this.writeLane = options.db.createWriteLane();
    this.providerPauseStore = createProviderPauseStore(options.db, options.now);
    this.providerPauseController = createProviderPauseController({
      store: this.providerPauseStore,
      now: options.now,
      emitEvent: (event) => this.emitProviderPauseEvent(event),
      onResume: async (provider) => {
        this.workflow.resumeProvider(provider);
        await this.advisorRuntime?.resumeProvider(provider);
        for (const work of this.db.all<{ id: string }>("SELECT id FROM works WHERE state = 'running'")) {
          this.workDriver.wake(work.id);
        }
      },
    });
    this.decisions = new DecisionService(options.db);
    this.owlRoot = options.owlRoot ?? process.cwd();
    this.dataDir = options.dataDir ?? join(this.owlRoot, "data");
    this.workspaceLayout = new WorkspaceLayout(options.workspacesRoot ?? resolve(this.owlRoot, ".owl-workspaces"), resolve(this.owlRoot, ".owl-workspaces"));
    this.git = options.git ?? new GitWorktreeGateway(options.db, this.owlRoot, undefined, this.dataDir, this.workspaceLayout);
    this.knowledge = new KnowledgeBase(this.owlRoot);
    this.researchRecorder = new ResearchRecorder({
      knowledge: this.knowledge,
      isEnabled: () => this.readKnowledgeAutomationSettings().research_autosave,
      language: () => ownerLanguage(this.db),
    });
    this.knowledgeNotes = new KnowledgeNotes(this.knowledge, { now: options.now });
    this.knowledgeRetriever = new KnowledgeRetriever(this.knowledgeNotes, { now: options.now });
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
      typeSafeJudge: options.skillCuratorTypeSafeJudge,
      now: options.now,
      debounce_ms: options.skillCuratorDebounceMs,
    });
    this.advisorSessions = new AdvisorSessionManager(this.db);
    this.memorySaver = new MemorySaver(this.knowledge, () => ownerLanguage(this.db));
    const providerClient = options.providerClient as ProviderClient | undefined;
    if (providerClient?.createSession) {
      this.advisorRuntime = new AdvisorSessionRuntime({
        db: this.db,
        sessionManager: this.advisorSessions,
        memorySaver: this.memorySaver,
        providerClient,
        owlRoot: this.owlRoot,
        git: this.git,
        getAdvisorSettings: () => this.getAdvisorSettingsSnapshot(),
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
        onReply: (conversationId, reply, turnId, origin, suggestedActions) =>
          this.persistAdvisorReply(conversationId, reply, turnId, origin, suggestedActions),
        onError: (conversationId, errorMessage, turnId, origin) =>
          this.persistAdvisorError(conversationId, errorMessage, turnId, origin),
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
    this.librarian = new Librarian(this.knowledge, {
      getModelConfig: () => resolveRoleModelFromDb(this.db, "librarian"),
    });
    this.librarianScheduler = new LibrarianScheduler({
      run: () => this.runCuration({ kind: "librarian", trigger: "scheduled", actor: "system" }),
    });
    this.curationRuns = new CurationRunStore(this.db);
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
      notes: this.knowledgeNotes,
      ruleProposals: this.ruleProposals,
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
      owlRoot: this.owlRoot,
      dataDir: this.dataDir,
      ruleStore: this.ruleStore,
      skillBox: this.skillBox,
      knowledgeRetriever: this.knowledgeRetriever,
      getKnowledgeLimits: () => this.getKnowledgeLimits(),
      getProcessSkillsPack: () => this.processSkillsPack,
      executorRuntime: options.executorRuntime,
      staleCheckIntervalMs: options.dispatcher?.stale_check_interval_ms,
      providerPauseController: this.providerPauseController,
      onManagerReplanNeeded: (input) =>
        this.triggerManagerReplan(input.work_id, input.failed_task_ids, input.reason, input.question ?? undefined),
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
      getState: (workId) => this.db.get<Pick<WorkDbRow, "state">>("SELECT state FROM works WHERE id = ?", workId)?.state,
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

  public async migrateLegacyKnowledge(input: { dry_run: boolean }) {
    if (!input || typeof input.dry_run !== "boolean") {
      throw validationError("dry_run must be a boolean.", { field: "dry_run" });
    }
    return runLegacyKnowledgeMigration({
      knowledge: this.knowledge,
      notes: this.knowledgeNotes,
      ruleProposals: this.ruleProposals,
      dry_run: input.dry_run,
      language: ownerLanguage(this.db),
      now: this.options.now,
    });
  }

  /**
   * Rebuild note tags from AI-extracted keywords. `extract` defaults to the agent runner's
   * `runKeywordExtraction`; it is required when the runner has none.
   */
  private retagRunning = false;

  public async retagKnowledgeNotes(input: {
    /** Directory named "knowledge" whose files are retagged (backups go to <its parent>/data/backups). Defaults to this Core's knowledge directory. */
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
    const knowledgeDir = input.knowledge_dir ?? this.knowledge.knowledgeDir;
    if (typeof knowledgeDir !== "string" || !isAbsolute(knowledgeDir) || basename(knowledgeDir) !== "knowledge") {
      throw validationError("knowledge_dir must be an absolute path to a directory named knowledge.", { field: "knowledge_dir" });
    }
    const knowledge = new KnowledgeBase(dirname(knowledgeDir));
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
      return await retagKnowledge({
        knowledge,
        notes: new KnowledgeNotes(knowledge),
        backupRoot: join(dirname(knowledgeDir), "data", "backups"),
        extract,
        dry_run: input.dry_run,
        force: input.force,
      });
    } finally {
      this.retagRunning = false;
    }
  }

  public async approveRuleProposal(proposalId: string) {
    return this.ruleProposals.approve(proposalId);
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
    const note = await this.knowledgeNotes.get(input.note_id);
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
    return this.skillBox.setSettings(validateSkillSettings(value));
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
    await this.curationRuns.recoverInterrupted();
    this.refreshProcessSkillsPack();
    try {
      await this.warnUnknownSavedModels();
    } catch (error) {
      console.warn("[owl-core] Could not check saved models against known model lists", error);
    }
    this.started = true;
    await this.checkWorkspacesRootInsideRepository();
    await this.knowledge.ensureDirectories();
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
      console.log(`[owl-core] Recovery: ${advisorRecovery} advisor sessions suspended for resume after core restart`);
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
    this.advisorKeepAliveTimer = setInterval(() => {
      void this.keepAdvisorResident();
    }, 60_000);
    this.advisorKeepAliveTimer.unref();
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
    const runningWorks = this.db.all<{ id: string }>("SELECT id FROM works WHERE state = 'running'");
    this.workDriver.start(runningWorks.map((work) => work.id));
    this.providerPauseController.start();
    for (const provider of recovery.reviewerProvidersToResume) this.workflow.resumeProvider(provider);
    this.retryWorkAfterRoleChange();
    this.librarianScheduler.start(this.readKnowledgeAutomationSettings().librarian_times);
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
  }): Promise<CurationRunView> {
    const key = input.request_key ?? null;
    if (key) {
      const pending = this.pendingCurationKeys.get(key);
      if (pending) return pending;
      const existing = this.curationRuns.findByRequestKey(key);
      if (existing) return existing;
    }
    const previous = this.activeCurations.get(input.kind);
    const promise: Promise<CurationRunView> = (previous ?? Promise.resolve()).then(() => this.executeCuration(input));
    // The tail never rejects: it only orders later runs and is awaited on stop.
    const tail: Promise<unknown> = promise.then(() => undefined, () => undefined).then(() => {
      if (this.activeCurations.get(input.kind) === tail) this.activeCurations.delete(input.kind);
      if (key && this.pendingCurationKeys.get(key) === promise) this.pendingCurationKeys.delete(key);
    });
    this.activeCurations.set(input.kind, tail);
    if (key) this.pendingCurationKeys.set(key, promise);
    return promise;
  }

  private async executeCuration(input: {
    kind: CurationKind;
    trigger: CurationTrigger;
    actor: CurationActor;
    actor_ref?: string | null;
    request_key?: string | null;
  }): Promise<CurationRunView> {
    const run = await this.curationRuns.start(input);
    try {
      if (input.kind === "librarian" && this.retagRunning) throw new Error("A knowledge retag is running. Try again after it finishes.");
      const report = await this.executeCurationReport(input.kind, run.id);
      return await this.curationRuns.finish(run.id, { ...summarizeCurationReport(input.kind, report, run.id, ownerLanguage(this.db)), report });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[owl-core] curation run failed", { kind: input.kind, run_id: run.id, message });
      return this.curationRuns.fail(run.id, message);
    }
  }

  /** Runs the curation behind one kind; the Librarian also records where its merged notes went. */
  private async executeCurationReport(kind: CurationKind, runId: string): Promise<unknown> {
    if (kind === "librarian") return this.librarian.run({ runId });
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
    this.providerPauseController.stop();
    if (!this.started) {
      await this.librarianScheduler.stop();
      this.skillCurator.stop();
      await Promise.allSettled([...this.activeCurations.values()]);
      await this.learningTask;
      await this.researchRecorder.idle();
      return;
    }
    this.started = false;
    await this.librarianScheduler.stop();
    // Stopping the Curator releases a curation that is waiting on its provider.
    this.skillCurator.stop();
    await Promise.allSettled([...this.activeCurations.values()]);
    if (this.advisorKeepAliveTimer !== null) {
      clearInterval(this.advisorKeepAliveTimer);
      this.advisorKeepAliveTimer = null;
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
    await this.learningTask;
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
              summary, size, design_mode, plan_revision,
              -- In a Work that is still going, a cancelled Task was superseded by
              -- the Manager's replacements, so it no longer counts toward progress.
              (SELECT COUNT(*) FROM tasks WHERE work_id = works.id
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

  public async cancelWork(
    workId: string,
    request: CommandRequest<{ reason: string; force?: boolean } & JsonObject>,
  ): Promise<CommandResponse<{ work_id: string; state: "cancelled"; cancel_requested: boolean }>> {
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
        // Executors (Hybrid or observed subagents) are not AgentRunner
        // processes; stop them through their recorded process identity.
        if (run.role === "executor") signalRecordedProcess(run, request.payload.force === true ? "SIGKILL" : "SIGTERM");
        else if (this.options.agentRunner.cancelAgent) await this.options.agentRunner.cancelAgent(run.id, request.payload.force === true);
        else if (run.pid && processIdentityMatches(
          { process_start_time: run.process_start_time, process_cmdline_sha256: run.process_cmdline_sha256 },
          readProcessIdentity(run.pid),
        )) {
          signalProcessGroup(run.pid, request.payload.force === true ? "SIGKILL" : "SIGTERM");
        }
      } catch (error) {
        console.error(`[owl-core] Failed to signal cancelled Agent ${run.id}`, error);
      }
    }
    void this.runWorktreeReconcile(workId, "work_cancelled");
    return response;
  }

  public async archiveWork(
    workId: string,
    request: CommandRequest<JsonObject>,
  ): Promise<CommandResponse<{ work_id: string; archived_at: string | null }>> {
    return this.runConditionalWorkCommand(request, { type: "work.archived", workId }, (transaction) => {
      const now = utcNow();
      const result = setWorkArchivedInTransaction(transaction, workId, request.expected_version, true, now);
      return {
        data: { work_id: workId, archived_at: result.archived_at },
        version: result.state_version,
        events: result.changed ? [{ type: "work.archived", payload: { work_id: workId, archived_at: result.archived_at }, createdAt: now }] : [],
      };
    });
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
    const requestHash = hashRequest({
      operation: "work.delete",
      work_id: workId,
      task_id: null,
      agent_run_id: null,
      resource_key: null,
      expected_version: request.expected_version,
      payload: request.payload,
    });
    const cached = this.db.get<StoredIdempotencyRow>("SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?", scopedKey);
    if (cached) {
      if (cached.request_hash !== requestHash) throw idempotencyConflict(scopedKey);
      return parseCommandResponse<{ work_id: string; deleted: true }>(cached.response_json, scopedKey);
    }

    const work = this.db.get<{ state: string; archived_at: string | null; state_version: number; project_id: string | null }>(
      "SELECT state, archived_at, state_version, project_id FROM works WHERE id = ?",
      workId,
    );
    assertWorkDeletable(workId, work, request.expected_version);
    const projectId = work?.project_id ?? null;
    assertNoActiveAgentsOrOpenDecisions(this.db, workId);
    await this.stopWorkAdvisorSessions(workId);

    const cleanup = await cleanupWorkForDeletion({
      db: this.db,
      writeLane: this.writeLane,
      git: this.git,
      owlRoot: this.owlRoot,
      dataDir: this.dataDir,
    }, workId);
    if (!cleanup.ok && cleanup.details?.stage === "work_lookup") {
      const replay = this.db.get<StoredIdempotencyRow>("SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?", scopedKey);
      if (replay) {
        if (replay.request_hash !== requestHash) throw idempotencyConflict(scopedKey);
        return parseCommandResponse<{ work_id: string; deleted: true }>(replay.response_json, scopedKey);
      }
      throw notFound("work", workId);
    }
    if (!cleanup.ok) throw worktreeCleanupError(workId, cleanup);

    try {
      const response = await this.writeLane.transact((transaction) => {
        const replay = transaction.get<StoredIdempotencyRow>("SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?", scopedKey);
        if (replay) {
          if (replay.request_hash !== requestHash) throw idempotencyConflict(scopedKey);
          throw new ReplayCommand(parseCommandResponse<{ work_id: string; deleted: true }>(replay.response_json, scopedKey));
        }
        const current = transaction.get<{ state: string; archived_at: string | null; state_version: number }>(
          "SELECT state, archived_at, state_version FROM works WHERE id = ?",
          workId,
        );
        assertWorkDeletable(workId, current, request.expected_version);
        assertNoActiveAgentsOrOpenDecisions(transaction, workId);

        const taskIds = transaction.all<{ id: string }>("SELECT id FROM tasks WHERE work_id = ?", workId).map((row) => row.id);
        const runIds = transaction.all<{ id: string }>("SELECT id FROM agent_runs WHERE work_id = ?", workId).map((row) => row.id);
        const decisionIds = transaction.all<{ id: string }>("SELECT id FROM decisions WHERE work_id = ?", workId).map((row) => row.id);
        const taskJson = JSON.stringify(taskIds);
        const runJson = JSON.stringify(runIds);
        const decisionJson = JSON.stringify(decisionIds);
        const eventIds = transaction.all<{ id: string }>(
          `SELECT id FROM events
            WHERE work_id = ?
               OR task_id IN (SELECT value FROM json_each(?))
               OR agent_run_id IN (SELECT value FROM json_each(?))`,
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
        for (const id of [workId, ...taskIds, ...runIds, ...decisionIds, ...reportIds, ...eventIds]) {
          transaction.run(
            "DELETE FROM idempotency_keys WHERE key <> ? AND (instr(key, ?) > 0 OR instr(response_json, ?) > 0)",
            scopedKey,
            id,
            id,
          );
        }

        const now = utcNow();
        transaction.run(
          `UPDATE conversations
              SET work_id = NULL, archived_at = COALESCE(archived_at, ?), is_active = 0, updated_at = ?
            WHERE work_id = ?`,
          now,
          now,
          workId,
        );
        transaction.run("UPDATE inbound_uploads SET work_id = NULL WHERE work_id = ?", workId);
        transaction.run(
          `UPDATE artifacts SET work_id = NULL, task_id = NULL, source_event_id = NULL
            WHERE work_id = ? OR task_id IN (SELECT value FROM json_each(?)) OR source_event_id IN (SELECT value FROM json_each(?))`,
          workId,
          taskJson,
          eventJson,
        );
        transaction.run("UPDATE inbound_receipts SET event_id = NULL WHERE event_id IN (SELECT value FROM json_each(?))", eventJson);
        transaction.run("UPDATE secret_audit SET agent_run_id = NULL WHERE agent_run_id IN (SELECT value FROM json_each(?))", runJson);

        transaction.run("UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id IN (SELECT value FROM json_each(?))", taskJson);
        transaction.run(
          `UPDATE agent_runs
              SET parent_agent_id = NULL, retry_of_run_id = NULL, task_id = NULL, subtask_id = NULL, report_id = NULL
            WHERE parent_agent_id IN (SELECT value FROM json_each(?))
               OR retry_of_run_id IN (SELECT value FROM json_each(?))
               OR task_id IN (SELECT value FROM json_each(?))
               OR subtask_id IN (SELECT value FROM json_each(?))
               OR report_id IN (SELECT value FROM json_each(?))`,
          runJson,
          runJson,
          taskJson,
          taskJson,
          reportJson,
        );

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
               OR task_id IN (SELECT value FROM json_each(?))
               OR agent_run_id IN (SELECT value FROM json_each(?))
               OR source_event_id IN (SELECT value FROM json_each(?))`,
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
        transaction.run("DELETE FROM works WHERE id = ?", workId);

        const response: CommandResponse<{ work_id: string; deleted: true }> = {
          request_id: request.request_id,
          data: { work_id: workId, deleted: true },
          version: current?.state_version ?? 0,
        };
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
      });
      this.workDriver.unregister(workId);
      try {
        await rm(designDocumentPath(this.dataDir, workId), { recursive: true, force: true });
      } catch (error) {
        console.warn(`[owl-core] Deleted Work ${workId}, but its design documents could not be removed`, error);
        await this.recordOrphanedDesignDocuments(workId, error);
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
      });
      events.push({ type: "work.reopened", payload: { work_id: workId, reason }, createdAt: now });
      return { data: { work_id: workId, state: "running" as const }, version: result.next.state_version, events };
    });
    this.workDriver.register(workId);
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
      mergeOwnerReplanInTransaction(transaction, workId, { kind: "instruction", answer: body });
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
              (SELECT json_group_array(depends_on_task_id) FROM task_dependencies WHERE task_id = tasks.id) AS depends_on_json
         FROM tasks
        WHERE work_id = ? AND (? IS NULL OR status = ?)
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
              parent_task_id, acceptance, review_round, failure_count, worker_generation
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
      payload: parseJsonObject(report.payload_json, "report", report.id),
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
              options_json, recommended, allow_free_text, state_version
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

  public async answerDecision(
    decisionId: string,
    request: CommandRequest<{ answer: string; option_key: string | null; source_message_id: string | null } & JsonObject>,
  ): Promise<CommandResponse<{ decision_id: string; status: "resolved"; winner: boolean; resumed_task_ids: readonly string[] }>> {
    const response = await this.decisions.resolve({
      ...request,
      payload: { ...request.payload, decision_id: decisionId },
    });
    await this.dispatcher.replayPending();
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
        terminal !== null &&
        terminal.allTerminal &&
        (terminal.anyFailed ||
          resumedWork.issuer_role === "manager" ||
          resolvingConflict ||
          sourceAlert?.kind === "final_manager_incomplete")
      ) {
        await this.writeLane.transact((transaction) =>
          mergeOwnerReplanInTransaction(transaction, resumedWork.work_id, { kind: "decision", answer: request.payload.answer }),
        );
      }
      this.workDriver.register(resumedWork.work_id);
    }
    return response;
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
      `SELECT id, work_id, task_id, role, design_tier, provider, model, effort, status, pid, started_at, ended_at, last_output_at, parent_agent_id, phase, subtask_count, label, origin
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

  public listProjects(query: ProjectListQuery = {}): ListResponse<Project> {
    const limit = boundLimit(query.limit ?? 50);
    const rows = this.db.all<ProjectDbRow>(
      `SELECT id, name, canonical_path, base_branch, auto_push, allowed_roots_json, verification_plan_json,
                worktree_prepare_argv_json, worktree_refresh_argv_json
         FROM projects
        WHERE (? IS NULL OR id > ?)
        ORDER BY id ASC LIMIT ?`,
      query.cursor ?? null,
      query.cursor ?? null,
      limit + 1,
    );
    return listResponse(query.request_id, rows.slice(0, limit).map(toProject), rows.length > limit, limit);
  }

  public listArtifacts(workId: string): { id: string; work_id: string; task_id: string | null; path: string; kind: string; deliverable: number; sha256: string; bytes: number; mime: string; commit_ref: string | null; version_no: number; created_at: string }[] {
    return this.db.all<{ id: string; work_id: string; task_id: string | null; path: string; kind: string; deliverable: number; sha256: string; bytes: number; mime: string; commit_ref: string | null; version_no: number; created_at: string }>(
      "SELECT id, work_id, task_id, path, kind, deliverable, sha256, bytes, mime, commit_ref, version_no, created_at FROM artifacts WHERE work_id = ? ORDER BY created_at DESC",
      workId,
    );
  }

  public async createProject(request: CommandRequest<CreateProjectPayload>): Promise<CommandResponse<Project>> {
    return this.runCommand(request, {
      type: "project.created",
      payload: { kind: "project_created", schema_version: "1.0.0" },
    }, (transaction) => {
      const project = createProjectInTransaction(transaction, request.payload);
      return { data: project, version: 0 };
    });
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
                worktree_prepare_argv_json, worktree_refresh_argv_json
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
      if (
        name === row.name
        && canonicalPath === row.canonical_path
        && autoPush === (row.auto_push === 1)
        && setupJson === row.worktree_prepare_argv_json
        && refreshJson === row.worktree_refresh_argv_json
      ) {
        return { data: toProject(row), version: 0 };
      }
      const now = utcNow();
      transaction.run(
        `UPDATE projects
            SET name = ?, canonical_path = ?, base_branch = ?, auto_push = ?, allowed_roots_json = ?,
                worktree_prepare_argv_json = ?, worktree_refresh_argv_json = ?, updated_at = ?
          WHERE id = ?`,
        name,
        canonicalPath,
        baseBranch,
        autoPush ? 1 : 0,
        JSON.stringify(allowedRoots),
        setupJson,
        refreshJson,
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
      const detached = detachProjectWorksInTransaction(transaction, projectId, current.owner_id, now);
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

  /**
   * Hybrid Mode (Worker=Team Leader) toggle, read
   * from the `settings` table (`hybrid_mode` key, plain JSON boolean).
   * Defaults to false (off) when unset or malformed — Hybrid Mode ships OFF.
   */
  public async getHybridMode(): Promise<boolean> {
    const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", HYBRID_MODE_SETTINGS_KEY);
    if (!row) {
      return false;
    }
    try {
      return JSON.parse(row.value_json) === true;
    } catch {
      return false;
    }
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

  /** Read the Hybrid Mode Executor configuration from the durable settings store. */
  public async getExecutorConfig(): Promise<ExecutorConfig> {
    const row = this.db.get<{ value_json: string }>(
      "SELECT value_json FROM settings WHERE key = ?",
      EXECUTOR_CONFIG_SETTINGS_KEY,
    );
    if (!row) return defaultExecutorConfig();
    try {
      return normalizeExecutorConfig(JSON.parse(row.value_json) as unknown);
    } catch (error) {
      if (error instanceof HumanReadableError) throw error;
      throw validationError("Stored Executor configuration is invalid.", { key: EXECUTOR_CONFIG_SETTINGS_KEY });
    }
  }

  /** Persist a validated Hybrid Mode Executor configuration atomically. */
  public async setExecutorConfig(config: ExecutorConfig): Promise<ExecutorConfig> {
    const normalized = normalizeExecutorConfig(config);
    assertKnownModel(this.knownModels, normalized.provider, normalized.model, { field: "executor_config.model" });
    await this.writeLane.write({
      mutateState: (transaction) => {
        const now = utcNow();
        ensureOwner(transaction, DEFAULT_OWNER_ID, now);
        transaction.run(
          `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
           VALUES (?, ?, '1.0.0', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          EXECUTOR_CONFIG_SETTINGS_KEY,
          DEFAULT_OWNER_ID,
          JSON.stringify(normalized),
          now,
        );
        return normalized;
      },
      event: {
        idempotencyKey: `settings-executor:${createUlid()}`,
        type: "settings.executor_updated",
        payload: normalized as unknown as JsonObject,
      },
      outbox: [{ provider: "websocket" }],
    });
    return normalized;
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
      try {
        configuredPack = this.detectProcessSkills({ enabled: true, path: input.path });
      } catch {
        configuredPack = null;
      }
      if (!configuredPack || configuredPack.source !== "setting") {
        throw validationError("The process skills path must contain the required skill files.", { field: "path" });
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
   * A model saved earlier for a role, or for the Hybrid Executor, can stop
   * being offered by its harness after the fact (a catalog refresh, a
   * retired model). Nothing rejects it until a run using it fails, so warn
   * about it once at startup instead. The saved value is left untouched.
   */
  private async warnUnknownSavedModels(): Promise<void> {
    const warnIfUnknown = (role: string, provider: string, model: string): void => {
      const harness = builtinProviderHarness(provider);
      if (!harness) return;
      const known = this.knownModels(harness);
      if (!known || known.has(model.trim())) return;
      console.warn(
        `[owl-core] The saved ${role} model '${model}' (provider '${provider}') is no longer offered by ${harness}. Pick a model in Settings.`,
      );
    };
    for (const role of this.getModelSettings().roles) {
      warnIfUnknown(role.role, role.provider, role.model);
    }
    const executorConfig = await this.getExecutorConfig();
    warnIfUnknown("executor", executorConfig.provider, executorConfig.model);
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
      `SELECT id, conversation_id, provider, source_message_id, body, attachment_ids_json, created_at
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
          text: notes.length > 0 ? `${message.body}\n\n${notes.join("\n")}` : message.body,
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
          `${this.buildAdvisorSystemPrompt(this.advisorHarness(advisorProvider))}\n\n${buildAdvisorProjectCatalogInstruction(this.db)}`,
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
      "When you issue a Work for a concrete request without an explicit direct-work instruction (the rules below decide when), append exactly one ```owl-actions``` fenced JSON array containing {type:\"create_work\", description, payload:{title,summary,size,project_id}}. Core will create the Work and start it. Use size \"small\" for a focused, lightweight change so it goes directly to the Worker; use \"normal\" or \"large\" for work that needs Manager planning. Before returning create_work, compare the full request and conversation context against the complete current Project catalog in context. Set the exact project_id when one Project matches, use null only when none matches, and ask which Project to use if multiple are plausible. Project registration is optional. The payload may also carry the optional backlog_item_ids (IDs of open backlog items from GET /api/v1/backlog (status=open) to link to the new Work; they become in_progress) and dismiss_backlog_item_ids (backlog item IDs to dismiss); every ID must belong to the same Project as the Work. Example: ```owl-actions\n[{\"type\":\"create_work\",\"description\":\"Fix the label\",\"payload\":{\"title\":\"Fix the label\",\"summary\":\"" + exampleSummary + "\",\"size\":\"small\",\"project_id\":null}}]\n```.",
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
    // changes this prompt, which the Advisor runtime detects as drift and
    // restarts the session with it before the next turn.
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
        const parsed = parseSlackAdvisorResponse(reply, (reason) => {
          console.warn(`[owl-core] Ignoring malformed Slack Advisor owl-actions block (${reason}); keeping visible text.`);
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
    const allNotices = [...recovery.notices, ...actionResult.notices];
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
      `system.alert:-:-:-:-:advisor-work:${turnId}:%:create`,
    );
    for (const row of rows) {
      // createWork's scoped key: system.alert : - : - : - : - : advisor-work : turnId : index : create
      const parts = row.key.split(":");
      if (parts.length !== 9 || parts[5] !== "advisor-work" || parts[6] !== turnId || parts[8] !== "create") continue;
      const index = Number.parseInt(parts[7], 10);
      if (!Number.isInteger(index) || index < 0) continue;
      let response: unknown;
      try {
        response = JSON.parse(row.response_json);
      } catch (parseError) {
        console.warn("[owl-core] Skipping malformed advisor-work create idempotency response_json", parseError);
        continue;
      }
      if (!isRecord(response) || !isRecord(response.data) || typeof response.data.work_id !== "string") continue;
      const workId = response.data.work_id;
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
          const run = await this.runCuration({
            kind,
            trigger: "advisor_action",
            actor: "advisor",
            actor_ref: turnId,
            request_key: `advisor-curation:${turnId}:${index}`,
          });
          notices.push(run.status === "succeeded"
            ? t.curationSucceeded(run.summary)
            : t.curationFailed(kind, run.error ?? t.unknownCause));
        } catch (error) {
          notices.push(t.curationFailed(kind, error instanceof Error ? error.message.slice(0, 300) : t.unknownCause));
        }
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
      if (
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
      ) ?? this.db.get<{ owner_id: string; conversation_id: string }>(
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

  /** A Task pipeline settled: schedule its Work again right away. */
  private onTaskSettled(workId: string): void {
    if (!this.started) return;
    this.workDriver.wake(workId);
    const work = this.db.get<{ state: string }>("SELECT state FROM works WHERE id = ?", workId);
    if (work?.state === "cancelled") void this.runWorktreeReconcile(workId, "task_settled_after_cancel");
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
    try {
      const result = await reconcileWorktrees(
        { db: this.db, writeLane: this.writeLane, git: this.git, owlRoot: this.owlRoot, dataDir: this.dataDir, layout: this.workspaceLayout },
        { work_id: workId, reason },
      );
      failures.push(...(result.failures ?? []));
      for (const entry of await this.git.listWorkspaces()) {
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
    try {
      await this.workflow.tick(workId);
    } catch (error) {
      if (!this.started) return this.workflow.snapshot(workId);
      throw humanizeUnexpected(error, "workflow.tick");
    }
    if (!this.started) return this.workflow.snapshot(workId);
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
      const questions = [...new Set(queuedReplans.flatMap((task) => (task.question === null ? [] : [task.question])))];
      await this.triggerManagerReplan(
        workId,
        queuedReplans.map((task) => task.id),
        "These Tasks failed and no Manager replan ran for them yet. Retry or replace each of them.",
        questions.length > 0 ? questions.join("\n") : undefined,
      );
      if (this.started) await this.announceCoreDecisions(workId);
      if (this.started) await this.dispatcher.replayPending();
      return this.workflow.snapshot(workId);
    }
    const terminalCheck = this.checkTerminalTasks(workId);
    if (terminalCheck.allTerminal) {
      const work = this.db.get<Pick<WorkDbRow, "state">>("SELECT state FROM works WHERE id = ?", workId);
      if (!work) {
        throw notFound("work", workId);
      }
      const ownerReplan = work.state === "running" && !this.replansInFlight.has(workId)
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
        const latestAlert = ownerReplan.kind === "decision" && failedIds.length === 0 ? this.latestSystemAlert(workId) : null;
        const finalVerdict = incompleteFinalVerdict(latestAlert);
        const conflict = mergeConflictReason(latestAlert);
        const reason = ownerReplan.kind === "reopen"
          ? 'The Owner reopened the completed Work. Add the Tasks the Owner\'s request needs, or return {"tasks": []} if nothing is missing.'
          : ownerReplan.kind === "instruction"
            ? 'The Owner sent an instruction for the Work. Add the Tasks the Owner\'s instruction asks for, or return {"tasks": []} if nothing is missing.'
          : failedIds.length > 0
            ? "The Owner answered the Decision about failed Tasks. Retry or replace them following the Owner's answer."
            : conflict !== null
              ? conflict
              : finalVerdict !== null
              ? 'The Owner answered the Decision after the final review judged the Work incomplete. Add the Tasks still needed, or return {"tasks": []} if the Work is done.'
              : 'The Owner answered the Decision about the Work. Add the Tasks the Owner\'s answer asks for, or return {"tasks": []} if nothing is missing.';
        await this.triggerManagerReplan(workId, failedIds, reason, ownerReplan.answer, finalVerdict, ownerReplan);
        if (this.started) await this.announceCoreDecisions(workId);
        return this.workflow.snapshot(workId);
      }
      if (work.state === "running") {
        if (terminalCheck.anyFailed) {
          await this.recordTickFailure(workId, new Error("One or more tasks failed. Manual intervention required."));
        } else {
          // All Tasks completed: the Final Manager reviews every Task report
          // and gives a verdict before Core commits Work completion. A
          // Manager call that throws (provider failure, unparsable output)
          // degrades to the same judgement_waiting path as a tick failure
          // instead of crashing the driver loop.
          try {
            const finalOutcome = await this.runFinalManager(workId);
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
                  merge = await this.git.mergeWorkIntoBase({ work_id: workId, expected_state_version: expected?.state_version });
                } catch (error) {
                  await this.recordWorkMergeFailed(workId, null, error);
                  return this.workflow.snapshot(workId);
                }
                // A pause or cancel during the merge left the base unchanged;
                // the Work's new state decides what happens next.
                if (merge.kind === "interrupted") return this.workflow.snapshot(workId);
                if (merge.kind !== "merged") {
                  await this.recordWorkMergeFailed(workId, merge);
                  return this.workflow.snapshot(workId);
                }
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
                if (verdict.lessons.length > 0) {
                  this.scheduleLearningRun(`Work ${workId}`);
                }
                const worktrees = await this.runWorktreeReconcile(workId, "work_completed");
                if (workProject?.project_id !== null && workProject?.project_id !== undefined) {
                  await this.deleteMergedWorkBranches(workId, this.worktreeCleanupFailure(workId, worktrees));
                  if (mergeRecord !== undefined) await this.pushCompletedWork(workId, workProject.project_id);
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
    const tasks = this.db.all<{ status: TaskState }>("SELECT status FROM tasks WHERE work_id = ?", workId);
    if (tasks.length === 0) return { allTerminal: false, anyFailed: false };
    // A superseded (cancelled) Task left the plan without failing the Work.
    const allTerminal = tasks.every((task) => isTerminalTaskState(task.status));
    const anyFailed = tasks.some((task) => task.status === "failed");
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

  private async enqueueWorkLearnings(workId: string, agentRunId: string | null, verdict: FinalManagerVerdict): Promise<void> {
    const lessons = verdict.lessons.map(normalizeLesson);
    if (lessons.length === 0) return;
    const work = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId);
    await this.learningJobs.enqueue(workId, agentRunId, work?.project_id ?? null, lessons);
    this.scheduleLearningRun(`Work ${workId}`);
  }

  /** The Final Manager judged the Work incomplete: halt the driver at judgement_waiting for owner review. */
  private async recordFinalManagerIncomplete(workId: string, verdict: FinalManagerVerdict): Promise<void> {
    console.error(`[owl-core] final Manager verdict is incomplete for Work ${workId}`, verdict);
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

  /** A Project merge must succeed before a complete final verdict can complete its Work. */
  private async recordWorkMergeFailed(
    workId: string,
    merge: Exclude<GitWorkMergeResult, { readonly kind: "merged" }> | null,
    thrown?: unknown,
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
    if (merge?.kind === "conflict") alertPayload.conflicting_files = [...merge.conflicting_files];
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
    let rejection: readonly string[] | null = null;
    for (let planAttempt = 1; planAttempt <= PLAN_MAX_ATTEMPTS; planAttempt += 1) {
      const result = await this.invokeInitialManagerPlan(workId, mode, work, rejection);
      if (result === null || !this.started) return;
      if (result.failure_class === "rate_limited") return;
      const report = requireManagerReport(result, "manager plan");
      const items = managerTasksToPlanItems(report.tasks, workId, { allowEmpty: false });
      const managerEvent = report.event;
      if (managerEvent !== "work.planned" && managerEvent !== "task.replanned") {
        throw validationError("The Manager plan must return work.planned or task.replanned.", { work_id: workId, event: managerEvent });
      }
      const plan = validatePlan(items);
      if (isPlanRejection(plan)) {
        rejection = plan.errors;
        if (planAttempt < PLAN_MAX_ATTEMPTS) {
          console.warn(`[owl-core] Manager plan for Work ${workId} was rejected (${plan.errors.join("; ")}); asking for a corrected plan.`);
          continue;
        }
        throw validationError(`The Manager plan was rejected twice: ${plan.errors.join(" ")}`, { work_id: workId });
      }
      await this.workflow.registerPlan(workId, items, managerEvent);
      if (this.started) await this.dispatcher.replayPending();
      return;
    }
  }

  /**
   * One initial-plan request, with a bounded retry for transient provider
   * errors and retryable invalid output. Returns null when Core stopped.
   */
  private async invokeInitialManagerPlan(
    workId: string,
    mode: StartWorkPayload["mode"],
    work: JsonObject,
    rejection: readonly string[] | null,
  ): Promise<AgentRunResult | null> {
    let result: AgentRunResult | null = null;
    for (let attempt = 1; attempt <= INITIAL_PLAN_MAX_ATTEMPTS; attempt += 1) {
      const raw = await this.invokeManagerPlan(
        {
          invocation_id: createUlid(),
          work_id: workId,
          task_id: null,
          attempt,
          context: {
            mode: "plan",
            start_mode: mode,
            work,
            design_documents: [],
            ...this.processSkillsRequestContext(),
            ...(rejection === null ? {} : { reason: `Your previous plan was rejected: ${rejection.join(" ")}` }),
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
    return result;
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
    reason: string,
    question?: string,
    finalVerdict: JsonObject | null = null,
    ownerReplan: OwnerReplanRequest | null = null,
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
    if (!this.isWorkRunning(workId)) {
      await this.requeueManagerReplan(workId, new Map(), ownerReplan);
      return;
    }
    this.replansInFlight.add(workId);
    try {
      const previousMarkers = await this.markReplanAttempted(failedTaskIds);
      const outcome = await this.runManagerReplan(workId, failedTaskIds, reason, question, finalVerdict, ownerReplan);
      if (outcome === "requeue") await this.requeueManagerReplan(workId, previousMarkers, ownerReplan);
    } finally {
      this.replansInFlight.delete(workId);
    }
  }

  private isWorkRunning(workId: string): boolean {
    return this.db.get<Pick<WorkDbRow, "state">>("SELECT state FROM works WHERE id = ?", workId)?.state === "running";
  }

  // A pause followed by a resume while a Manager replan call is outstanding
  // leaves the Work `running` again by the time the call returns, which a
  // plain running check cannot tell apart from "never interrupted". Requiring
  // the state_version to still match the value captured before the call
  // catches that case too (M1): any transition at all during the call,
  // including a pause immediately undone by a resume, discards the answer.
  private isReplanStillCurrent(workId: string, expectedVersion: number): boolean {
    const work = this.db.get<Pick<WorkDbRow, "state" | "state_version">>(
      "SELECT state, state_version FROM works WHERE id = ?",
      workId,
    );
    return work?.state === "running" && work.state_version === expectedVersion;
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
          AND NOT EXISTS (
            SELECT 1 FROM decisions
             WHERE decisions.work_id = tasks.work_id AND decisions.status = 'open'
               AND (decisions.scope = 'work'
                    OR EXISTS (SELECT 1 FROM json_each(decisions.blocked_task_ids_json) WHERE value = tasks.id))
          )
        ORDER BY tasks.created_at ASC, tasks.id ASC`,
      workId,
    );
  }

  /**
   * Take the persisted Owner replan request for a Work, if any. The marker is
   * moved to `attempted` rather than deleted, so a crash before the Manager
   * finishes acting on it leaves it recoverable: startup recovery moves any
   * still-`attempted` marker back to `queued` for the next tick to retry.
   */
  private async consumeOwnerReplan(workId: string): Promise<OwnerReplanRequest | null> {
    return this.writeLane.transact((transaction) => {
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
          return { kind: value.kind === "reopen" || value.kind === "instruction" ? value.kind : "decision", answer: value.answer };
        }
      } catch {
        // A malformed request is dropped; the normal terminal handling applies.
      }
      return null;
    });
  }

  /**
   * The one place a Manager replan request is built. `attempt` 2 carries the
   * reasons the previous answer was rejected at the front of `reason`.
   */
  private buildReplanRequest(
    workId: string,
    failedTaskIds: readonly string[],
    reason: string,
    question: string | undefined,
    attempt: number,
    finalVerdict: JsonObject | null,
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
      reason,
      mode: "replan",
      context: {
        mode: "replan",
        work,
        ...this.processSkillsRequestContext(),
        failed_task_ids: [...failedTaskIds],
        // The root failed Tasks as the Manager reads every Task (no hashes,
        // worktree paths or leases), and per Task why it failed.
        tasks: failedRows.map((task) => managerTaskView(task, this.taskDependencyIds(task.id))),
        failed_tasks: failedRows
          .map((task) => failedTaskBrief(this.db, task.id))
          .filter((brief): brief is JsonObject => brief !== null),
        // The whole current plan, so the Manager can tell which ids already
        // exist and which Tasks already completed.
        current_plan: this.planOverview(workId),
        design_documents: this.completedDesignDocuments(workId),
        reason,
        question: question ?? null,
        final_verdict: finalVerdict,
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
    reason: string,
    question?: string,
    finalVerdict: JsonObject | null = null,
    ownerReplan: OwnerReplanRequest | null = null,
  ): Promise<"done" | "requeue"> {
    if (!this.started) return "requeue";
    // Defensive: the Manager only ever sees root failures (callers already pass only those).
    failedTaskIds = failedTaskIds.filter((taskId) => !this.isCascadedFailure(taskId));
    const fail = (detail: string): Promise<void> =>
      this.openManagerReplanFailureDecision(workId, failedTaskIds, reason, detail, question, finalVerdict);
    let plan: ReplanPlan | null = null;
    let planSnapshot: ReplanSnapshot | null = null;
    let rejection: readonly string[] = [];
    for (let attempt = 1; attempt <= REPLAN_MAX_ATTEMPTS && plan === null; attempt += 1) {
      const workBeforeCall = this.db.get<Pick<WorkDbRow, "state" | "state_version">>(
        "SELECT state, state_version FROM works WHERE id = ?",
        workId,
      );
      if (workBeforeCall?.state !== "running") return "requeue";
      const attemptReason = attempt === 1
        ? reason
        : `Your previous replan was rejected: ${rejection.join(" ")} ${reason}`;
      const snapshot = this.replanSnapshot(workId);
      const request = this.buildReplanRequest(workId, failedTaskIds, attemptReason, question, attempt, finalVerdict);
      let result: AgentRunResult;
      try {
        const raw = await this.invokeManagerPlan(request, "manager.replan");
        // M1: the call takes minutes; a pause, cancel or Decision in the
        // meantime means this answer must not be acted on now, even if the
        // Work is running again by the time this returns.
        if (!this.started || !this.isReplanStillCurrent(workId, workBeforeCall.state_version)) return "requeue";
        if (raw === null) return "requeue";
        result = requireAgentRunResult(raw, "manager replan");
      } catch (error) {
        if (!this.started || !this.isReplanStillCurrent(workId, workBeforeCall.state_version)) return "requeue";
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
      } catch {
        await fail("The Manager replan result did not include a valid report.");
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
      const validated = validateReplan(items, snapshot, failedTaskIds);
      if (!isPlanRejection(validated)) {
        plan = validated;
        planSnapshot = snapshot;
        break;
      }
      rejection = validated.errors;
      console.warn(`[owl-core] Manager replan attempt ${attempt} for Work ${workId} was rejected: ${rejection.join(" ")}`);
    }
    if (plan === null || planSnapshot === null) {
      await fail(`The Manager's replan was rejected twice. ${rejection.join(" ")}`);
      return "done";
    }
    // An empty plan with no root failure writes nothing: the next tick sees
    // every Task terminal and runs the final check.
    if (plan.newItems.length === 0 && plan.reopenIds.length === 0 && plan.supersessions.size === 0) {
      if (ownerReplan !== null) {
        await this.writeLane.transact((transaction) => {
          transaction.run(
            `DELETE FROM idempotency_keys
              WHERE key = ? AND json_extract(response_json, '$.status') = 'attempted'`,
            ownerReplanKey(workId),
          );
          return null;
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
    };
    try {
      const applied = await this.workflow.applyReplan(
        workId,
        plan,
        guard,
        `Manager replan: ${reason}`,
        ownerReplan !== null ? ownerReplanKey(workId) : undefined,
      );
      await this.announceDecisionCancellations(applied.cancelled_decision_ids);
      void this.runWorktreeReconcile(workId, "replan_applied");
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
    reason: string,
    detail: string,
    question?: string,
    finalVerdict: JsonObject | null = null,
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
          ...managerReplanFailureBrief(scope, reason, detail, ownerLanguage(this.db), question, finalVerdict?.missing),
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
  private async runFinalManager(workId: string): Promise<{ readonly verdict: FinalManagerVerdict; readonly agent_run_id: string } | null> {
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
      const report = parseJsonObject(row.payload_json, "report", task.id);
      // Hybrid verdict fields are Core routing instructions, not part of the
      // Worker report that a later Manager should summarize.
      const { verdict: _verdict, retry_subtasks: _retrySubtasks, ...workerReport } = report;
      reports.push({ task_id: task.id, ...workerReport });
    }
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
        reason: "All Tasks completed; request the Manager final verdict.",
        mode: "finalize" as const,
        context: { mode: "finalize", work_id: workId, tasks: managerTasks, reports, design_documents: this.completedDesignDocuments(workId), backlog_items: listInProgressBacklogItemsOfWork(this.db, workId).map(({ id, file, line, problem, suggestion }) => ({ id, file, line, problem, suggestion })), ...this.processSkillsRequestContext() },
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
      return null;
    }
  }

  private managerWorkContext(workId: string): JsonObject {
    const work = this.db.get<Omit<WorkDbRow, "display_number">>(
      `SELECT id, title, state, state_version, updated_at, archived_at, owner_id, project_id,
              summary, size, design_mode, plan_revision
         FROM works WHERE id = ?`,
      workId,
    );
    if (!work) {
      throw notFound("work", workId);
    }
    return {
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
    const rows = this.db.all<{ id: string; manager_task_id: string | null; title: string; status: string; failed_by_dependency_task_id: string | null }>(
      "SELECT id, manager_task_id, title, status, failed_by_dependency_task_id FROM tasks WHERE work_id = ? ORDER BY created_at ASC, id ASC",
      workId,
    );
    return rows.map((row) => ({
      id: row.id,
      manager_task_id: row.manager_task_id,
      title: row.title,
      status: row.status,
      failed_by_dependency: row.failed_by_dependency_task_id !== null,
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

  private getKnowledgeLimits(): KnowledgeLimits {
    try {
      const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", KNOWLEDGE_SETTINGS_KEY);
      return row ? normalizeKnowledgeLimits(JSON.parse(row.value_json) as unknown) : DEFAULT_KNOWLEDGE_LIMITS;
    } catch (error) {
      console.warn("[owl-core] Could not read knowledge settings; using defaults", error);
      return DEFAULT_KNOWLEDGE_LIMITS;
    }
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
        },
      },
      outbox: [{ provider: "websocket" }],
    });
    this.librarianScheduler.reschedule(normalized.librarian_times);
    return this.getKnowledgeAutomationSettings();
  }

  private async composeKnowledgeForWork(workId: string): Promise<string | null> {
    try {
      const work = this.db.get<{ title: string; project_id: string | null }>(
        "SELECT title, project_id FROM works WHERE id = ?",
        workId,
      );
      if (!work) return null;
      const result = await this.knowledgeRetriever.render({
        work_title: work.title,
        project_id: work.project_id,
      }, this.getKnowledgeLimits());
      return result?.text ?? null;
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
    const requestWithRules = {
      ...(addManagerRules(request, managerRules, managerSkills, managerKnowledge) as Record<string, unknown>),
      language: ownerLanguage(this.db),
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
      result = await runner.call(this.options.agentRunner, enrichedRequest);
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
          payload: { work_id: workId, task_id: taskId, agent_run_id: agentRunId, operation, reason: failure },
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
          `UPDATE agent_runs SET status = 'completed', ended_at = ?, updated_at = ?, usage_json = COALESCE(?, usage_json) WHERE id = ?`,
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
  };
}

function toTaskSummary(row: TaskDbRow): TaskSummary {
  return { id: row.id, work_id: row.work_id, title: row.title, status: row.status, type: row.type, state_version: row.state_version, updated_at: row.updated_at, created_at: row.created_at, depends_on: JSON.parse(row.depends_on_json) as string[] };
}

function toTaskDetail(row: TaskDbRow): TaskDetail {
  return {
    ...toTaskSummary(row),
    parent_task_id: row.parent_task_id,
    acceptance: row.acceptance,
    review_round: row.review_round,
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

function toProject(row: ProjectDbRow): Project {
  return {
    id: row.id,
    name: row.name,
    canonical_path: row.canonical_path,
    base_branch: row.base_branch,
    auto_push: row.auto_push === 1,
    worktree_setup_command: parseStringArray(row.worktree_prepare_argv_json, "worktree_setup_command", row.id, "Project"),
    worktree_refresh_command: parseStringArray(row.worktree_refresh_argv_json, "worktree_refresh_command", row.id, "Project"),
    allowed_roots: parseStringArray(row.allowed_roots_json, "allowed_roots", row.id, "Project"),
    verification_plan: parseArray(row.verification_plan_json, "verification_plan", row.id, "Project") as unknown as readonly VerificationCommand[],
  };
}

const PROJECT_LOCKING_WORK_STATES_SQL = PROJECT_LOCKING_WORK_STATES.map(() => "?").join(", ");
const ACTIVE_AGENT_RUN_STATUSES_SQL = "'launch_pending', 'spawned', 'running', 'cancel_requested'";

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

function toMessage(row: MessageDbRow): Message {
  const isAdvisor = row.source_message_id != null && row.source_message_id.startsWith("advisor:");
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    source: isAdvisor ? "advisor" : row.provider,
    body: row.body,
    attachment_ids: parseStringArray(row.attachment_ids_json, "attachment_ids", row.id, "Message"),
    created_at: row.created_at,
  };
}

function formatConversationMessage(message: Message): string {
  const timestamp = new Date(message.created_at);
  const time = Number.isNaN(timestamp.getTime()) ? message.created_at : timestamp.toISOString().slice(11, 16);
  const role = message.source === "advisor" ? "Advisor" : "You";
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
  const parsed = parseJsonObject(text, "settings", MODEL_PRESETS_KEY);
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
  const parsed = parseJsonObject(text, "settings", MODEL_SETTINGS_KEY);
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
  return {
    id,
    name,
    canonical_path: canonicalPath,
    base_branch: baseBranch,
    auto_push: false,
    worktree_setup_command: [],
    worktree_refresh_command: [],
    allowed_roots: allowedRoots as readonly string[],
    verification_plan: verificationPlan,
  };
}

function listResponse<T extends JsonObject>(requestId: string | undefined, rows: readonly T[], hasMore: boolean, limit: number): ListResponse<T> {
  const data = rows.slice(0, limit);
  return { request_id: requestId ?? createUlid(), data, cursor: hasMore && data.length > 0 ? String(data[data.length - 1].id) : null, has_more: hasMore };
}

function boundLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw validationError("List limit must be an integer between 1 and 200.", { limit });
  }
  return limit;
}

function hashRequest(payload: JsonObject): string {
  return createHash("sha256").update(stableJson(payload), "utf8").digest("hex");
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
  if (work.archived_at === null) {
    throw new HumanReadableError({
      code: "work_not_archived",
      message: "Archive this Work before deleting it.",
      remediation: "Archive the completed or cancelled Work, then retry the delete command.",
      details: { work_id: workId },
    });
  }
  if (work.state_version !== expectedVersion) throw versionConflict(expectedVersion, work.state_version);
}

function assertNoActiveAgentsOrOpenDecisions(transaction: Pick<CoreDatabase, "get">, workId: string): void {
  const activeAgents = transaction.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM agent_runs
      WHERE work_id = ? AND status IN ('launch_pending', 'spawned', 'running', 'cancel_requested')`,
    workId,
  )?.count ?? 0;
  if (activeAgents > 0) {
    throw new HumanReadableError({
      code: "work_has_active_agents",
      message: "Stop active Agents before deleting this Work.",
      remediation: "Wait for the Agents to stop, then retry the delete command.",
      details: { work_id: workId, active_agents: activeAgents },
    });
  }
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

function worktreeCleanupError(workId: string, cleanup: { readonly message: string; readonly details?: Record<string, unknown> }): HumanReadableError {
  const rawWorktrees = cleanup.details?.worktrees;
  const worktrees = Array.isArray(rawWorktrees) ? rawWorktrees : [];
  const ignoredSummary = worktrees.map((value) => {
    const item = value as { path?: unknown; ignored_count?: unknown; ignored_paths?: unknown };
    const paths = Array.isArray(item.ignored_paths) ? item.ignored_paths.slice(0, 10).join(", ") : "";
    return `${String(item.path ?? "(unknown path)")}: ${String(item.ignored_count ?? 0)} ignored entr${item.ignored_count === 1 ? "y" : "ies"}${paths ? ` (${paths})` : ""}`;
  });
  const message = ignoredSummary.length > 0
    ? `Ignored files or directories prevent deleting Work ${workId}: ${ignoredSummary.join("; ")}.`
    : `Work ${workId} workspace cleanup failed: ${cleanup.message}`;
  return new HumanReadableError({
    code: "worktree_cleanup_failed",
    message,
    remediation: "Review the reported paths, preserve anything you need, remove ignored contents that are safe to delete, and retry.",
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

function validateWorktreeCommand(value: unknown, field: string, language: "ja" | "en"): string[] {
  const valid = Array.isArray(value)
    && value.length <= WORKTREE_COMMAND_MAX_ARGS
    && value.every((arg) => typeof arg === "string" && arg.length <= WORKTREE_COMMAND_MAX_ARG_LENGTH && !arg.includes("\0"))
    && (value.length === 0 || (value[0] as string).trim().length > 0);
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

function parseStringArray(text: string, field: string, id: string, resource = "Decision"): string[] {
  const parsed = parseArray(text, field, id, resource);
  if (!parsed.every((value): value is string => typeof value === "string")) {
    throw validationError(`Stored ${resource} field ${field} contains a non-string value.`, { id, field });
  }
  return parsed;
}

function parseJsonObject(text: string, field: string, id: string): JsonObject {
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

const EXECUTOR_PROVIDERS: Readonly<Record<string, "claude" | "codex">> = {
  claude: "claude",
  anthropic: "claude",
  codex: "codex",
  openai: "codex",
};
const EXECUTOR_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function defaultExecutorConfig(): ExecutorConfig {
  return { provider: "claude", model: DEFAULT_HARNESS_MODELS.claude, effort: "high", timeout_ms: DEFAULT_AGENT_WALL_TIMEOUT_MS };
}

function normalizeExecutorConfig(value: unknown): ExecutorConfig {
  if (!isRecord(value)) {
    throw validationError("Executor configuration must be an object.", { field: "executor_config" });
  }
  const provider = value.provider;
  const model = value.model;
  const effort = value.effort;
  const timeoutMs = value.timeout_ms;
  if (
    typeof provider !== "string" ||
    !EXECUTOR_PROVIDERS[provider.trim().toLowerCase()] ||
    typeof model !== "string" ||
    model.trim().length === 0 ||
    (effort !== undefined && effort !== null && (typeof effort !== "string" || (effort.length > 0 && !EXECUTOR_EFFORTS.has(effort)))) ||
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0
  ) {
    throw validationError("Executor configuration is invalid.", { field: "executor_config" });
  }
  return {
    provider: EXECUTOR_PROVIDERS[provider.trim().toLowerCase()],
    model: model.trim(),
    ...(typeof effort === "string" && effort.length > 0 ? { effort } : {}),
    timeout_ms: timeoutMs,
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
  const extra = Object.keys(value).filter((field) => !fields.includes(field as typeof fields[number]));
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
  return {
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
  const transient = code === "provider_failed";
  return {
    outcome: "failed",
    report_valid: false,
    skill_feedback: null,
    failure_class: transient ? "transient" : "deterministic",
    error_key: code === null ? "final_manager_error" : reason === null ? code : `${code}:${reason}`,
    retry_allowed: contract,
    message: formatRuntimeFailure(error, "Manager", language),
  };
}

/**
 * The Task fields a Manager reads: identity, plan fields, status and the
 * counters it can reason about. Internals (error hashes, worktree paths,
 * leases, versions) stay in Core.
 */
function managerTaskView(task: TaskRow, dependsOn: readonly string[]): JsonObject {
  return {
    id: task.id,
    manager_task_id: task.manager_task_id,
    title: task.title,
    type: task.type,
    status: task.status,
    acceptance: task.acceptance,
    context: task.context,
    depends_on: [...dependsOn],
    review_round: task.review_round,
    failure_count: task.failure_count,
  };
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
 * Replan reason after the Owner asked the Manager to resolve a conflict
 * between the Work branch and the Project base; null for any other alert.
 */
function mergeConflictReason(alert: JsonObject | null): string | null {
  if (alert === null || alert.kind !== "work_merge_failed" || alert.merge_kind !== "conflict") return null;
  const files = Array.isArray(alert.conflicting_files)
    ? alert.conflicting_files.filter((path): path is string => typeof path === "string" && path.length > 0)
    : [];
  const base = typeof alert.base_branch === "string" && alert.base_branch.length > 0 ? alert.base_branch : "the Project base branch";
  return [
    `Merging the Work into ${base} conflicted, and the Owner asked you to resolve the conflict.`,
    `Add one Task that, in its worktree, merges the latest ${base} into the Work, resolves the conflicts, keeps the intent of both sides, and commits the result.`,
    files.length > 0 ? `Conflicting files: ${files.join(", ")}` : "The conflicting files were not recorded.",
  ].join("\n");
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

interface OwnerReplanRequest {
  readonly kind: "decision" | "reopen" | "instruction";
  readonly answer: string;
}

/** Durable per-Work request for the next tick to hand an Owner answer to the Manager. */
function ownerReplanKey(workId: string): string {
  return `owner-replan:${workId}`;
}

function queueOwnerReplanInTransaction(
  transaction: CoreWriteLaneTransaction,
  workId: string,
  request: OwnerReplanRequest,
  options: { readonly replace?: boolean } = {},
): void {
  const now = utcNow();
  transaction.run(
    `INSERT OR ${options.replace === false ? "IGNORE" : "REPLACE"} INTO idempotency_keys
       (key, request_hash, response_json, status_code, created_at, expires_at)
     VALUES (?, ?, ?, 202, ?, ?)`,
    ownerReplanKey(workId),
    "0".repeat(64),
    JSON.stringify({ work_id: workId, status: "queued", kind: request.kind, answer: request.answer }),
    now,
    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  );
}

/** Queue a request, combining it with one that is still queued so neither is lost. */
function mergeOwnerReplanInTransaction(
  transaction: CoreWriteLaneTransaction,
  workId: string,
  request: OwnerReplanRequest,
): void {
  const pending = transaction.get<{ response_json: string }>(
    "SELECT response_json FROM idempotency_keys WHERE key = ? AND json_extract(response_json, '$.status') = 'queued'",
    ownerReplanKey(workId),
  );
  let merged = request;
  try {
    const value = pending ? JSON.parse(pending.response_json) as unknown : null;
    if (isRecord(value) && typeof value.answer === "string" && value.answer.length > 0) {
      merged = {
        kind: value.kind === "instruction" || request.kind === "instruction" ? "instruction" : request.kind,
        answer: `${value.answer}\n\n${request.answer}`,
      };
    }
  } catch {
    // A malformed pending request is replaced.
  }
  queueOwnerReplanInTransaction(transaction, workId, merged);
}

/** Undo `consumeOwnerReplan`: move an `attempted` marker back to `queued`. */
function requeueOwnerReplanInTransaction(transaction: CoreWriteLaneTransaction, workId: string): void {
  transaction.run(
    `UPDATE idempotency_keys
        SET response_json = json_set(response_json, '$.status', 'queued')
      WHERE key = ? AND json_extract(response_json, '$.status') = 'attempted'`,
    ownerReplanKey(workId),
  );
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
    const item: TaskPlanItem = {
      id,
      title: nonEmptyString(candidate.title, "title", index),
      type,
      acceptance: nonEmptyString(candidate.acceptance, "acceptance", index),
      ...(review === undefined ? {} : { review }),
      depends_on: dependencies,
      ...(context === undefined && notes === undefined
        ? {}
        : { context: [context, typeof notes === "string" && notes.length > 0 ? `Manager notes:\n${notes}` : undefined].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n\n") }),
      ...(parentTaskId === undefined ? {} : { parent_task_id: parentTaskId }),
      ...(priority === undefined ? {} : { priority: priority as TaskPlanItem["priority"] }),
      ...(managerTaskId === undefined ? {} : { manager_task_id: managerTaskId }),
      replaces: replaces as string[],
    };
    return item;
  });
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
