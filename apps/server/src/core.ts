import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Core } from "../../../packages/core/dist/core.js";
import { resolveDataDir, serverPackageRoot } from "./contracts.js";
import { ApiError, humanUnexpectedMessage } from "./errors.js";
import { isUlid } from "./ids.js";
import type {
  AgentRun,
  CommandMeta,
  CommandResult,
  CoreControlListener,
  CoreControlSignal,
  CoreEvent,
  CoreEventListener,
  CorePort,
  CreateCoreOptions,
  CreateProjectInput,
  DeleteProjectInput,
  DeleteProjectResult,
  Decision,
  JsonObject,
  Message,
  Page,
  PostMessageInput,
  WorkInstructionInput,
  WorkInstructionResult,
  InboundMessageInput,
  InboundMessageResult,
  AdvisorOrigin,
  InboundUploadCompleteInput,
  InboundUploadCompleteResult,
  InboundUploadContentResult,
  InboundUploadRegisterInput,
  InboundUploadTicket,
  Project,
  ProjectDeletionImpact,
  Report,
  RoleModelSetting,
  RoleModelSettingInput,
  ModelPreset,
  TaskDetail,
  TaskSummary,
  UpdateProjectInput,
  WorkState,
  WorkCreateInput,
  IntegrationConfigPatch,
  IntegrationProvider,
  IntegrationStatus,
  IntegrationTestResult,
  WorkBranchStatus,
  WorkDesignDetail,
  WorkConversation,
  WorkAssurance,
  WorkDesignList,
  WorkDetail,
  WorkProgress,
  WorkSummary,
  DetectedProvider,
  ProviderConfigRecord,
  ProcessSkillsInstallCommand,
  ProcessSkillsSettingsInput,
  ProcessSkillsSettingsSnapshot,
  ProviderPauseView,
  SaveProviderInput,
  AdvisorSessionsPort,
} from "./types.js";
import { configuredDesignSkill } from "./config.js";
import type { SessionActivity } from "../../../packages/shared/dist/index.js";
import type { GuardTokenAgent } from "../../../packages/shared/dist/guard-token.js";
import type { WebResearchCapture } from "../../../packages/shared/dist/web-research.js";
import type { ChildDispatchRequest, ChildDispatchResponse, ChildRunListFilter, ChildRunRecord, ChildRunSettings, ChildWaitRequest, ChildWaitResponse } from "../../../packages/shared/dist/child-runs.js";

import { IntegrationStore, parseChannelIds } from "./integration-store.js";
import { AppSettingsStore, type CustomProviderConfig } from "./app-settings-store.js";
import { AdvisorFolderError, advisorFolderDefaults, ensureAdvisorSharedDir, isGitIgnoredDirectory, normalizeAdvisorFolder } from "./advisor-folders.js";
import type { WebAttachmentFile, WebAttachmentResult, WebAttachmentTarget } from "../../../packages/core/dist/core.js";
import { defaultOwlRoot as defaultCoreOwlRoot, resolveWorkspacesRoot } from "../../../packages/core/dist/workspace-layout.js";
import { buildAgentEnv } from "./agent-env.js";
import { customProviderApiKeyEnvNames } from "./agent-runner.js";
import { providerSelection } from "./provider-selection.js";
import type { KnowledgeAutomationSettings, KnowledgeAutomationSnapshot } from "../../../packages/shared/dist/knowledge-automation.js";
import {
  DEFAULT_OWNER_LANGUAGE,
  ownerLanguageFromLocale,
  type OwnerLanguage,
} from "../../../packages/shared/dist/owner-language.js";
import { builtinProviderHarness, type ModelHarness, CODEX_PROVIDER_API_KEY_ENV, CODEX_PROVIDER_BASE_URL_ENV, OPENCODE_API_KEY_ENV_ENV, OPENCODE_BASE_URL_ENV, PROCESS_SKILLS_INSTALL_COMMANDS } from "../../../packages/shared/dist/index.js";
import { codexKnownModels, mergeOfficialModels, opencodeKnownModels } from "./model-catalog.js";
import { detectProviders, type BuiltinHarnessInfo, type BuiltinProviderInfo } from "./provider-detection.js";

function coreText(language: OwnerLanguage, ja: string, en: string): string {
  return language === "ja" ? ja : en;
}

function cloneModelPreset(preset: ModelPreset): ModelPreset {
  return { ...preset, roles: preset.roles.map((role) => ({ ...role })) };
}

function modelPresetCommandResult(response: ExternalCommandResponse): CommandResult<{ preset: ModelPreset; presets: ModelPreset[] }> {
  const data = response.data as { preset: ModelPreset; presets: readonly ModelPreset[] };
  return { data: { preset: cloneModelPreset(data.preset), presets: data.presets.map(cloneModelPreset) }, version: response.version };
}

const BUILTIN_HARNESSES: readonly BuiltinHarnessInfo[] = [
  { id: "claude", binaryName: "claude" },
  { id: "codex", binaryName: "codex" },
  { id: "opencode", binaryName: "opencode" },
];

const BUILTIN_PROVIDER_PRESETS: readonly BuiltinProviderInfo[] = [
  {
    id: "anthropic",
    displayName: "Anthropic",
    harnessId: "claude",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    harnessId: "codex",
  },
  {
    id: "opencode",
    displayName: "opencode",
    harnessId: "opencode",
  },
];

/** Reports which provider harnesses are usable on this system. */
export type ProviderAvailabilityDetector = () => readonly { harnessId: string; available: boolean }[];

let builtinProviderAvailability: ReturnType<ProviderAvailabilityDetector> | null = null;

/** Built-in provider availability, detected once per process so requests do not repeat the CLI lookup. */
const detectBuiltinProviders: ProviderAvailabilityDetector = () => {
  builtinProviderAvailability ??= detectProviders(BUILTIN_PROVIDER_PRESETS, BUILTIN_HARNESSES, {});
  return builtinProviderAvailability;
};

/** Install commands for whichever harness CLIs Owl can find; both when neither is available. */
function processSkillsInstallCommands(detected: readonly { harnessId: string; available: boolean }[]): ProcessSkillsInstallCommand[] {
  const availableHarnesses = detected.filter((provider) => provider.available).map((provider) => provider.harnessId);
  const harnesses = availableHarnesses.length > 0 ? availableHarnesses : ["claude", "codex"];
  return harnesses
    .filter((harness): harness is "claude" | "codex" => harness === "claude" || harness === "codex")
    .map((harness) => ({ harness, command: PROCESS_SKILLS_INSTALL_COMMANDS[harness] }));
}

function builtinProviderToRecord(provider: BuiltinProviderInfo): ProviderConfigRecord {
  return {
    id: provider.id,
    displayName: provider.displayName,
    harnessId: provider.harnessId,
    apiKeySource: provider.apiKeySource,
    isBuiltin: true,
  };
}

/** Wires the persisted knowledge_dir setting into Core's knowledge location. */
export function knowledgeStorageOptions(appSettings: AppSettingsStore): { read(): string; write(value: string): void } {
  return { read: () => appSettings.getKnowledgeDir(), write: (value) => { appSettings.setKnowledgeDir(value); } };
}

interface ExternalCoreModule {
  createCore?: (options: CreateCoreOptions) => unknown;
}

interface ExternalCommandResponse {
  request_id?: string;
  data: JsonObject;
  version: number;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validWorkProgress(value: unknown): WorkProgress | null {
  if (!isRecord(value)) return null;
  const { total_tasks, completed_tasks, percent } = value;
  if (
    !Number.isSafeInteger(total_tasks) || Number(total_tasks) < 0 ||
    !Number.isSafeInteger(completed_tasks) || Number(completed_tasks) < 0 || Number(completed_tasks) > Number(total_tasks) ||
    !Number.isSafeInteger(percent) || Number(percent) < 0 || Number(percent) > 100
  ) return null;
  const expectedPercent = Number(total_tasks) === 0 ? 0 : Math.round((Number(completed_tasks) / Number(total_tasks)) * 100);
  if (Number(percent) !== expectedPercent) return null;
  return {
    total_tasks: Number(total_tasks),
    completed_tasks: Number(completed_tasks),
    percent: Number(percent),
  };
}

function workDetailCoreError(workId: string, field: string, reason: string): ApiError {
  return new ApiError(
    500,
    "server_error",
    "Work詳細を取得できませんでした。保存されたWork情報を確認してください。",
    { operation: "getWork", work_id: workId, field, reason },
  );
}

function externalWorkProgress(core: Core, workId: string): WorkProgress {
  let total_tasks = 0;
  let completed_tasks = 0;
  let cursor: string | null = null;
  const seenCursors = new Set<string>();

  try {
    while (true) {
      const page = core.listTasks(workId, { limit: 200, cursor });
      if (
        !isRecord(page) || !Array.isArray(page.data) || typeof page.has_more !== "boolean" ||
        (page.cursor !== null && typeof page.cursor !== "string")
      ) throw workDetailCoreError(workId, "progress", "Core returned a malformed task page.");

      for (const task of page.data) {
        if (!isRecord(task) || typeof task.status !== "string") {
          throw workDetailCoreError(workId, "progress", "Core returned a Task without a status.");
        }
        total_tasks += 1;
        if (!Number.isSafeInteger(total_tasks)) {
          throw workDetailCoreError(workId, "progress", "The Work has too many Tasks to count safely.");
        }
        if (task.status === "completed") completed_tasks += 1;
      }

      if (!page.has_more) {
        if (page.cursor !== null) {
          throw workDetailCoreError(workId, "progress", "Core returned a cursor after the final task page.");
        }
        return {
          total_tasks,
          completed_tasks,
          percent: total_tasks === 0 ? 0 : Math.round((completed_tasks / total_tasks) * 100),
        };
      }

      const nextCursor = page.cursor;
      if (
        typeof nextCursor !== "string" || nextCursor.length === 0 || seenCursors.has(nextCursor) ||
        page.data.length === 0
      ) {
        throw workDetailCoreError(workId, "progress", "Core returned a non-advancing task cursor.");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw workDetailCoreError(workId, "progress", "Core could not enumerate the Work's Tasks.");
  }
}

function externalWorkDetail(response: unknown, workId: string, computedProgress: WorkProgress): WorkDetail {
  const envelope = isRecord(response) ? response : null;
  const data = envelope && isRecord(envelope.data) ? envelope.data : null;
  if (!data) {
    throw workDetailCoreError(workId, "data", "Core returned no Work detail object.");
  }
  if (typeof data.id === "string" && data.id.length > 0 && data.id !== workId) {
    throw new ApiError(
      500,
      "server_error",
      "Work詳細を取得できませんでした。Coreが要求したWorkとは異なるIDを返しました。",
      { operation: "getWork", work_id: workId, returned_work_id: data.id },
    );
  }

  const versionOrNull = (value: unknown): number | null =>
    Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
  const timestampOrNull = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
    if (!match) return null;
    const [, rawYear, rawMonth, rawDay] = match;
    const year = Number(rawYear);
    const month = Number(rawMonth);
    const day = Number(rawDay);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
    return Number.isFinite(Date.parse(value)) ? value : null;
  };
  const requireString = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.length === 0) {
      throw workDetailCoreError(workId, field, "Core returned a missing or invalid required string.");
    }
    return value;
  };
  const stateVersion = versionOrNull(data.state_version) ?? versionOrNull(envelope?.version);
  const id = requireString(data.id, "id");
  const title = requireString(data.title, "title");
  const state = requireString(data.state, "state");
  const ownerId = requireString(data.owner_id, "owner_id");
  const summary = typeof data.summary === "string" ? data.summary : null;
  const updatedAt = timestampOrNull(data.updated_at);
  const archivedAt = data.archived_at === null ? null : timestampOrNull(data.archived_at);
  const displayNumber = displayNumberOrNull(data.display_number);
  const planRevision = versionOrNull(data.plan_revision);
  const size = data.size === "small" || data.size === "normal" || data.size === "large" ? data.size : null;
  const projectId = data.project_id === null || isUlid(data.project_id) ? data.project_id : undefined;

  if (!isUlid(id) || id !== workId) {
    throw workDetailCoreError(workId, "id", "Core returned a missing or invalid Work ID.");
  }
  if (stateVersion === null) throw workDetailCoreError(workId, "state_version", "Core returned no valid version.");
  if (updatedAt === null) throw workDetailCoreError(workId, "updated_at", "Core returned a missing or invalid timestamp.");
  if (archivedAt === null && data.archived_at !== null) throw workDetailCoreError(workId, "archived_at", "Core returned a missing or invalid archive timestamp.");
  if (projectId === undefined) throw workDetailCoreError(workId, "project_id", "Core returned an invalid project ID.");
  if (summary === null) throw workDetailCoreError(workId, "summary", "Core returned no summary.");
  if (size === null) throw workDetailCoreError(workId, "size", "Core returned an unsupported Work size.");
  if (planRevision === null) throw workDetailCoreError(workId, "plan_revision", "Core returned no valid plan revision.");

  return {
    id,
    title,
    state,
    state_version: stateVersion,
    updated_at: updatedAt,
    archived_at: archivedAt,
    display_number: displayNumber,
    owner_id: ownerId,
    project_id: projectId,
    summary,
    size,
    plan_revision: planRevision,
    progress: computedProgress,
    conversation_id: data.conversation_id === null || isUlid(data.conversation_id) ? data.conversation_id : null,
    prerequisite_wait: data.prerequisite_wait === true,
    waiting_on: Array.isArray(data.waiting_on) ? data.waiting_on : [],
    prerequisites: Array.isArray(data.prerequisites) ? data.prerequisites : [],
    can_move_to_project: data.can_move_to_project === true,
    final_report: finalReportOrNull(data.final_report),
  };
}

function finalReportOrNull(value: unknown): WorkDetail["final_report"] {
  if (value === null || typeof value !== "object") return null;
  const { summary, test_results, issues, created_at } = value as Record<string, unknown>;
  return typeof summary === "string" && typeof test_results === "string" && typeof issues === "string" && typeof created_at === "string"
    ? { summary, test_results, issues, created_at }
    : null;
}

function displayNumberOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

export function externalError(error: unknown, operation: string): ApiError {
  if (error instanceof ApiError) return error;
  if (isRecord(error) && typeof error.code === "string") {
    const code = error.code;
    const allowedCodes = new Set([
      "validation_error",
      "invalid_state_transition",
      "work_not_archived",
      "work_has_active_agents",
      "work_has_open_decisions",
      "work_reopen_required",
      "work_cancelled",
      "version_conflict",
      "idempotency_conflict",
      "work_not_found",
      "backlog_item_not_found",
      "task_not_found",
      "decision_not_found",
      "decision_already_resolved",
      "project_not_found",
      "work_project_already_set",
      "prerequisite_work_not_found",
      "prerequisite_cycle",
      "provider_pause_not_found",
      "write_paths_invalid",
      "timeout_out_of_range",
      "parent_not_active",
      "too_many_children",
      "child_not_found",
      "project_has_running_works",
      "project_deletion_impact_changed",
      "model_preset_not_found",
      "project_path_conflict",
      "conversation_not_found",
      "connector_account_not_found",
      "inbound_account_provider_mismatch",
      "agent_run_not_found",
      "dependency_unavailable",
      "worktree_cleanup_failed",
      "skill_not_found",
      "skill_file_not_found",
      "skill_revision_not_found",
      "skill_proposal_not_found",
      "upload_too_large",
      "upload_checksum_mismatch",
      "upload_quota_exceeded",
    ]);
    const publicCode = allowedCodes.has(code) ? code as ApiError["code"] : "server_error";
    const status = publicCode === "validation_error" || ["write_paths_invalid", "timeout_out_of_range"].includes(publicCode) ? 400
      : publicCode === "upload_too_large" || publicCode === "upload_quota_exceeded" ? 413
      : publicCode === "dependency_unavailable" || publicCode === "worktree_cleanup_failed" ? 503
        : publicCode === "parent_not_active" || publicCode === "too_many_children" ? 409
          : publicCode.endsWith("_not_found") ? 404
          : publicCode === "server_error" ? 500
            : 409;
    const message = typeof error.message === "string" ? error.message : humanUnexpectedMessage();
    const remediation = typeof error.remediation === "string" ? " " + error.remediation : "";
    const details = isRecord(error.details) ? error.details : { operation };
    return new ApiError(status, publicCode, message + remediation, details, { cause: error });
  }
  return new ApiError(500, "server_error", humanUnexpectedMessage(), { operation }, { cause: error });
}

function skillApiUnavailable(operation: string): ApiError {
  return new ApiError(503, "core_not_ready", `The loaded Core does not support ${operation.toLowerCase()}.`);
}

export class ExternalCoreAdapter implements CorePort {
  readonly ready = true;
  readonly advisorSessions: AdvisorSessionsPort;
  private readonly eventLog: CoreEvent[] = [];
  private readonly listeners = new Set<CoreEventListener>();
  private readonly controlListeners = new Set<CoreControlListener>();
  private readonly unsubscribeExternal: () => void;
  private readonly integrationStore: IntegrationStore;
  private readonly appSettings: AppSettingsStore;
  private readonly detectProviderAvailability: ProviderAvailabilityDetector;
  private processSkillsInstallCommandList: ProcessSkillsInstallCommand[] | null = null;
  readonly ruleStore: unknown;

  constructor(
    private readonly core: Core,
    private readonly db: unknown,
    owlRoot: string,
    private readonly dataDir: string,
    appSettings?: AppSettingsStore,
    options: { detectProviderAvailability?: ProviderAvailabilityDetector; integrationStore?: IntegrationStore } = {},
  ) {
    this.detectProviderAvailability = options.detectProviderAvailability ?? detectBuiltinProviders;
    this.advisorSessions = core.advisorSessions ?? { getActiveSession: () => null };
    this.integrationStore = options.integrationStore ?? new IntegrationStore(owlRoot, dataDir);
    this.appSettings = appSettings ?? new AppSettingsStore(owlRoot, dataDir);
    this.ruleStore = core.ruleStore;
    this.unsubscribeExternal = core.subscribe((event) => {
      this.eventLog.push(event);
      if (this.eventLog.length > 10000) this.eventLog.splice(0, this.eventLog.length - 10000);
      for (const listener of this.listeners) listener(event);
    });
  }

  get version(): string {
    return this.core.status().version;
  }

  status(): { services: readonly { name: string; state: string; pid: number | null }[]; mvp_scope: string; version: string } {
    return this.core.status();
  }

  async listWorks(query: { state: string | null; archived: "exclude" | "include" | "only"; limit: number; cursor: string | null }): Promise<Page<WorkSummary>> {
    try {
      const result = this.core.listWorks(query);
      return { ...result, data: result.data.map((work) => ({
        ...work,
        display_number: displayNumberOrNull(work.display_number),
        project_id: typeof work.project_id === "string" ? work.project_id : null,
        prerequisite_wait: work.prerequisite_wait === true,
        waiting_on: Array.isArray(work.waiting_on) ? work.waiting_on : [],
      })) };
    } catch (error) {
      throw externalError(error, "listWorks");
    }
  }

  async createWork(input: WorkCreateInput, command: CommandMeta): Promise<CommandResult<{ work_id: string; state: "memo" | "ready"; state_version: number }>> {
    try {
      const response = await this.core.createWork({ ...command, payload: input as never });
      const { version: _version, ...data } = response.data as JsonObject;
      return { data: data as { work_id: string; state: "memo" | "ready"; state_version: number }, version: response.version };
    } catch (error) {
      throw externalError(error, "createWork");
    }
  }

  async getWork(workId: string): Promise<WorkDetail> {
    try {
      const response = this.core.getWork(workId);
      const data = isRecord(response) && isRecord(response.data) ? response.data : null;
      const computedProgress = validWorkProgress(data?.progress) ?? externalWorkProgress(this.core, workId);
      return externalWorkDetail(response, workId, computedProgress);
    } catch (error) {
      throw externalError(error, "getWork");
    }
  }

  async getWorkBranchStatus(workId: string): Promise<WorkBranchStatus> {
    try {
      this.core.getWork(workId);
    } catch (error) {
      throw externalError(error, "getWorkBranchStatus");
    }
    if (!this.core.getWorkBranchStatus) return { work_id: workId, unmerged_changes: "unknown" };
    try {
      const status = await this.core.getWorkBranchStatus(workId);
      return { work_id: workId, unmerged_changes: status.unmerged_changes };
    } catch {
      return { work_id: workId, unmerged_changes: "unknown" };
    }
  }

  async getWorkDesigns(workId: string): Promise<WorkDesignList> {
    try {
      await this.core.getWork(workId);
      if (!this.core.getWorkDesigns) return { designs: [] };
      return await this.core.getWorkDesigns(workId);
    } catch (error) {
      throw externalError(error, "getWorkDesigns");
    }
  }

  async getWorkConversation(workId: string, opts: { limit: number }): Promise<WorkConversation> {
    try {
      await this.core.getWork(workId);
      if (!this.core.getWorkConversation) throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support work conversations.");
      return (await this.core.getWorkConversation(workId, opts)) as unknown as WorkConversation;
    } catch (error) {
      throw externalError(error, "getWorkConversation");
    }
  }

  getWorkView(workId: string, query: { conversation_limit?: number }): JsonObject {
    try {
      if (!this.core.getWorkView) throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support the Work detail API.");
      return this.core.getWorkView(workId, query);
    } catch (error) {
      throw externalError(error, "getWorkView");
    }
  }

  getDecisionView(decisionId: string): JsonObject {
    try {
      if (!this.core.getDecisionView) throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support the Decision detail API.");
      return this.core.getDecisionView(decisionId);
    } catch (error) {
      throw externalError(error, "getDecisionView");
    }
  }

  getBoardView(query: { archived: "exclude" | "only"; limit: number; cursor?: string | null }): JsonObject {
    try {
      if (!this.core.getBoardView) throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support the Board API.");
      return this.core.getBoardView(query);
    } catch (error) {
      throw externalError(error, "getBoardView");
    }
  }

  listLinkableWorks(projectId: string | null, query: { limit: number; cursor?: string | null }): JsonObject {
    try {
      if (!this.core.listLinkableWorks) throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support the linkable Works API.");
      return this.core.listLinkableWorks(projectId, query);
    } catch (error) {
      throw externalError(error, "listLinkableWorks");
    }
  }

  getBacklogListView(filter: { status?: string; project_id?: string; work_id?: string; issued_work_id?: string; limit?: number; offset?: number }): JsonObject {
    try {
      if (!this.core.getBacklogListView) throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support the Backlog screen API.");
      return this.core.getBacklogListView(filter as never);
    } catch (error) {
      throw externalError(error, "getBacklogListView");
    }
  }

  async getTokensView(input: { period: "today" | "7d" | "30d"; top: number }): Promise<JsonObject> {
    try {
      if (!this.core.getTokensView) throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support the Tokens screen API.");
      return await this.core.getTokensView(input);
    } catch (error) {
      throw externalError(error, "getTokensView");
    }
  }

  async getWorkAssurance(workId: string): Promise<WorkAssurance> {
    try {
      await this.core.getWork(workId);
      if (!this.core.getWorkAssurance) throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support work assurance.");
      return (await this.core.getWorkAssurance(workId)) as WorkAssurance;
    } catch (error) {
      throw externalError(error, "getWorkAssurance");
    }
  }

  async getWorkDesign(workId: string, taskId: string): Promise<WorkDesignDetail | null> {
    try {
      await this.core.getWork(workId);
      if (!this.core.getWorkDesign) return null;
      return await this.core.getWorkDesign(workId, taskId);
    } catch (error) {
      throw externalError(error, "getWorkDesign");
    }
  }

  async startWork(workId: string, mode: "normal" | "small", command: CommandMeta): Promise<CommandResult<{ work_id: string; state: "running" | "ready" | "judgement_waiting"; started: boolean; waiting_for_prerequisites: boolean }>> {
    try {
      const response = await this.core.startWork(workId, { ...command, payload: { mode } });
      const { version: _version, ...data } = response.data as JsonObject;
      return { data: data as { work_id: string; state: "running" | "ready" | "judgement_waiting"; started: boolean; waiting_for_prerequisites: boolean }, version: response.version };
    } catch (error) {
      throw externalError(error, "startWork");
    }
  }

  async replaceWorkPrerequisites(workId: string, input: { prerequisite_work_ids: string[] }, command: CommandMeta): Promise<CommandResult<JsonObject>> {
    try {
      if (!this.core.replaceWorkPrerequisites) throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support Work prerequisites.");
      const response = await this.core.replaceWorkPrerequisites(workId, { ...command, payload: input });
      const { version: _version, ...data } = response.data as JsonObject;
      return { data, version: response.version };
    } catch (error) {
      throw externalError(error, "replaceWorkPrerequisites");
    }
  }

  async releaseWorkPrerequisiteWait(workId: string, command: CommandMeta): Promise<CommandResult<JsonObject>> {
    try {
      if (!this.core.releaseWorkPrerequisiteWait) throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support Work prerequisites.");
      const response = await this.core.releaseWorkPrerequisiteWait(workId, { ...command, payload: {} });
      const { version: _version, ...data } = response.data as JsonObject;
      return { data, version: response.version };
    } catch (error) {
      throw externalError(error, "releaseWorkPrerequisiteWait");
    }
  }

  async moveWorkToProject(workId: string, input: { project_id: string }, command: CommandMeta): Promise<CommandResult<JsonObject>> {
    try {
      if (!this.core.moveWorkToProject) throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support moving a Work into a Project.");
      const response = await this.core.moveWorkToProject(workId, { ...command, payload: input });
      const { version: _version, ...data } = response.data as JsonObject;
      return { data, version: response.version };
    } catch (error) {
      throw externalError(error, "moveWorkToProject");
    }
  }

  async pauseWork(workId: string, reason: string, command: CommandMeta): Promise<CommandResult<{ work_id: string; state: "paused"; signal: "pause_requested" }>> {
    try {
      const response = await this.core.pauseWork(workId, { ...command, payload: { reason } });
      const { version: _version, ...data } = response.data as JsonObject;
      return { data: data as { work_id: string; state: "paused"; signal: "pause_requested" }, version: response.version };
    } catch (error) {
      throw externalError(error, "pauseWork");
    }
  }

  async resumeWork(workId: string, command: CommandMeta): Promise<CommandResult<{ work_id: string; state: "running" }>> {
    try {
      const response = await this.core.resumeWork(workId, { ...command, payload: {} });
      const { version: _version, ...data } = response.data as JsonObject;
      return { data: data as { work_id: string; state: "running" }, version: response.version };
    } catch (error) {
      throw externalError(error, "resumeWork");
    }
  }

  async resumeWorkOrRetryDecision(workId: string, command: CommandMeta, body?: string): Promise<CommandResult<{
    work_id: string;
    state: "running" | "judgement_waiting";
    resumed_by: "resume" | "retry_decision";
    decision_id: string | null;
  }>> {
    try {
      const response = await this.core.resumeWorkOrRetryDecision(workId, { ...command, payload: { source: "advisor", ...(body === undefined ? {} : { body }) } });
      const { version: _version, ...data } = response.data as JsonObject;
      return {
        data: data as unknown as {
          work_id: string;
          state: "running" | "judgement_waiting";
          resumed_by: "resume" | "retry_decision";
          decision_id: string | null;
        },
        version: response.version,
      };
    } catch (error) {
      throw externalError(error, "resumeWorkOrRetryDecision");
    }
  }

  async cancelWork(workId: string, reason: string, force: boolean, command: CommandMeta): Promise<CommandResult<{ work_id: string; state: "cancelled"; cancel_requested: boolean; worktree_cleanup?: { ok: boolean; message: string; details?: JsonObject } }>> {
    try {
      const response = await this.core.cancelWork(workId, { ...command, payload: { reason, force } });
      const { version: _version, ...data } = response.data as JsonObject;
      return { data: data as { work_id: string; state: "cancelled"; cancel_requested: boolean; worktree_cleanup?: { ok: boolean; message: string; details?: JsonObject } }, version: response.version };
    } catch (error) {
      throw externalError(error, "cancelWork");
    }
  }

  async reopenWork(workId: string, reason: string, command: CommandMeta): Promise<CommandResult<{ work_id: string; state: "running" }>> {
    try {
      const response = await this.core.reopenWork(workId, { ...command, payload: { reason } });
      const { version: _version, ...data } = response.data as JsonObject;
      return { data: data as { work_id: string; state: "running" }, version: response.version };
    } catch (error) {
      throw externalError(error, "reopenWork");
    }
  }

  async postWorkInstruction(workId: string, input: WorkInstructionInput, command: CommandMeta): Promise<CommandResult<WorkInstructionResult>> {
    try {
      const response = await this.core.postWorkInstruction(workId, { ...command, payload: input });
      const { version: _version, ...data } = response.data as JsonObject;
      return { data: data as unknown as WorkInstructionResult, version: response.version };
    } catch (error) {
      throw externalError(error, "postWorkInstruction");
    }
  }

  async updateWork(workId: string, input: { title?: string; summary?: string }, command: CommandMeta): Promise<CommandResult<{
    work_id: string;
    title: string;
    summary: string;
    state: WorkState;
    changed_fields: readonly ("title" | "summary")[];
    replan_queued: boolean;
  }>> {
    try {
      const response = await this.core.updateWork(workId, { ...command, payload: input });
      const { version: _version, ...data } = response.data as JsonObject;
      return {
        data: data as unknown as {
          work_id: string;
          title: string;
          summary: string;
          state: WorkState;
          changed_fields: readonly ("title" | "summary")[];
          replan_queued: boolean;
        },
        version: response.version,
      };
    } catch (error) {
      throw externalError(error, "updateWork");
    }
  }

  async archiveWork(workId: string, command: CommandMeta): Promise<CommandResult<{ work_id: string; archived_at: string | null }>> {
    try {
      const response = await this.core.archiveWork(workId, { ...command, payload: {} });
      const { version: _version, ...data } = response.data as JsonObject;
      return { request_id: response.request_id, data: data as { work_id: string; archived_at: string | null }, version: response.version };
    } catch (error) {
      throw externalError(error, "archiveWork");
    }
  }

  async unarchiveWork(workId: string, command: CommandMeta): Promise<CommandResult<{ work_id: string; archived_at: null }>> {
    try {
      const response = await this.core.unarchiveWork(workId, { ...command, payload: {} });
      const { version: _version, ...data } = response.data as JsonObject;
      return { request_id: response.request_id, data: data as { work_id: string; archived_at: null }, version: response.version };
    } catch (error) {
      throw externalError(error, "unarchiveWork");
    }
  }

  async deleteWork(workId: string, command: CommandMeta): Promise<CommandResult<{ work_id: string; deleted: true }>> {
    try {
      const response = await this.core.deleteWork(workId, { ...command, payload: {} });
      const { version: _version, ...data } = response.data as JsonObject;
      return { request_id: response.request_id, data: data as { work_id: string; deleted: true }, version: response.version };
    } catch (error) {
      throw externalError(error, "deleteWork");
    }
  }

  async listTasks(workId: string, query: { status: string | null; limit: number; cursor: string | null }): Promise<Page<TaskSummary>> {
    try {
      // The durable Core returns an empty page for an unknown work_id. Match
      // the REST contract by surfacing work_not_found.
      this.core.getWork(workId);
      return this.core.listTasks(workId, query as never) as unknown as Page<TaskSummary>;
    } catch (error) {
      throw externalError(error, "listTasks");
    }
  }

  async getTask(taskId: string, includeReport: boolean): Promise<{ data: TaskDetail; report: Report | null; version: number }> {
    try {
      const response = this.core.getTask(taskId, { include_report: includeReport });
      const { report: reportValue, ...task } = response.data;
      return { data: task as unknown as TaskDetail, report: isRecord(reportValue) ? reportValue as unknown as Report : null, version: response.version };
    } catch (error) {
      throw externalError(error, "getTask");
    }
  }

  async listDecisions(query: { status: "open" | "resolved" | "cancelled"; limit: number; cursor: string | null }): Promise<Page<Decision>> {
    try {
      return this.core.listDecisions(query) as unknown as Page<Decision>;
    } catch (error) {
      throw externalError(error, "listDecisions");
    }
  }

  async answerDecision(decisionId: string, input: { answer: string; option_key: string | null; source: "web" | "slack" | "discord" | "advisor"; source_message_id: string | null }, command: CommandMeta): Promise<CommandResult<{ decision_id: string; status: "resolved"; winner: boolean; resumed_task_ids: string[] }>> {
    try {
      const response = await this.core.answerDecision(decisionId, { ...command, payload: input });
      const { version: _version, ...data } = response.data as { version?: unknown; decision_id: string; status: "resolved"; winner: boolean; resumed_task_ids: readonly string[] };
      return { data: { ...data, resumed_task_ids: [...data.resumed_task_ids] }, version: response.version };
    } catch (error) {
      throw externalError(error, "answerDecision");
    }
  }

  async listAgents(query: { status: string | null; work_id: string | null; limit: number; cursor: string | null }): Promise<Page<AgentRun>> {
    try {
      return this.core.listAgentRuns(query) as unknown as Page<AgentRun>;
    } catch (error) {
      throw externalError(error, "listAgentRuns");
    }
  }

  async cancelAgent(agentRunId: string, reason: string, force: boolean, command: CommandMeta): Promise<CommandResult<{ agent_run_id: string; status: "cancel_requested" | "cancelled" }>> {
    try {
      const response = await this.core.cancelAgent(agentRunId, { ...command, payload: { reason, force } });
      const { version: _version, ...data } = response.data as JsonObject;
      return { data: data as { agent_run_id: string; status: "cancel_requested" | "cancelled" }, version: response.version };
    } catch (error) {
      throw externalError(error, "cancelAgent");
    }
  }

  async listProjects(query: { limit: number; cursor: string | null }): Promise<Page<Project>> {
    try {
      return this.core.listProjects(query) as unknown as Page<Project>;
    } catch (error) {
      throw externalError(error, "listProjects");
    }
  }

  listArtifacts(workId: string): Array<{ id: string; work_id: string; task_id: string | null; path: string; kind: string; created_at: string }> {
    try {
      return this.core.listArtifacts(workId);
    } catch (error) {
      throw externalError(error, "listArtifacts");
    }
  }

  async createProject(input: CreateProjectInput, command: CommandMeta): Promise<{ data: Project; version: number }> {
    try {
      const response = await this.core.createProject({ ...command, payload: input as never });
      const { version: _version, ...data } = response.data as JsonObject;
      return { data: data as unknown as Project, version: response.version };
    } catch (error) {
      throw externalError(error, "createProject");
    }
  }

  async updateProject(projectId: string, input: UpdateProjectInput, command: CommandMeta): Promise<{ data: Project; version: number }> {
    try {
      if (!this.core.updateProject) throw new ApiError(503, "core_not_ready", "The loaded Core does not support updateProject.");
      const response = await this.core.updateProject(projectId, { ...command, payload: input as never });
      const { version: _version, ...data } = response.data as JsonObject;
      return { data: data as unknown as Project, version: response.version };
    } catch (error) {
      throw externalError(error, "updateProject");
    }
  }

  async getProjectDeletionImpact(projectId: string): Promise<ProjectDeletionImpact> {
    try {
      if (!this.core.getProjectDeletionImpact) throw new ApiError(503, "core_not_ready", "The loaded Core does not support getProjectDeletionImpact.");
      return (await this.core.getProjectDeletionImpact(projectId)) as unknown as ProjectDeletionImpact;
    } catch (error) {
      throw externalError(error, "getProjectDeletionImpact");
    }
  }

  async deleteProject(projectId: string, input: DeleteProjectInput, command: CommandMeta): Promise<{ data: DeleteProjectResult; version: number }> {
    try {
      if (!this.core.deleteProject) throw new ApiError(503, "core_not_ready", "The loaded Core does not support deleteProject.");
      const response = await this.core.deleteProject(projectId, { ...command, payload: input as never });
      const { version: _version, ...data } = response.data as JsonObject;
      return { data: data as unknown as DeleteProjectResult, version: response.version };
    } catch (error) {
      throw externalError(error, "deleteProject");
    }
  }

  async getModelSettings(): Promise<{ version: number; roles: RoleModelSetting[] }> {
    try {
      const result = this.core.getModelSettings();
      return { version: result.version, roles: [...result.roles] };
    } catch (error) {
      throw externalError(error, "getModelSettings");
    }
  }

  async updateModelSettings(input: { roles: RoleModelSettingInput[] }, command: CommandMeta): Promise<CommandResult<{ roles: RoleModelSetting[] }>> {
    try {
      const response = await this.core.updateModelSettings({ ...command, payload: input as never });
      const { version: _version, ...data } = response.data as { version?: unknown; roles: readonly RoleModelSetting[] };
      return { data: { roles: [...data.roles] }, version: response.version };
    } catch (error) {
      throw externalError(error, "updateModelSettings");
    }
  }

  async getModelPresets(): Promise<{ version: number; presets: ModelPreset[] }> {
    try {
      const result = this.core.getModelPresets();
      return { version: result.version, presets: (result.presets as unknown as readonly ModelPreset[]).map(cloneModelPreset) };
    } catch (error) {
      throw externalError(error, "getModelPresets");
    }
  }

  async createModelPreset(input: { name: string; roles: RoleModelSettingInput[] }, command: CommandMeta): Promise<CommandResult<{ preset: ModelPreset; presets: ModelPreset[] }>> {
    try {
      const response = await this.core.createModelPreset({ ...command, payload: input as never });
      return modelPresetCommandResult(response);
    } catch (error) {
      throw externalError(error, "createModelPreset");
    }
  }

  async updateModelPreset(id: string, input: { name?: string; roles?: RoleModelSettingInput[] }, command: CommandMeta): Promise<CommandResult<{ preset: ModelPreset; presets: ModelPreset[] }>> {
    try {
      const response = await this.core.updateModelPreset(id, { ...command, payload: input as never });
      return modelPresetCommandResult(response);
    } catch (error) {
      throw externalError(error, "updateModelPreset");
    }
  }

  async deleteModelPreset(id: string, command: CommandMeta): Promise<CommandResult<{ presets: ModelPreset[] }>> {
    try {
      const response = await this.core.deleteModelPreset(id, { ...command, payload: {} });
      const data = response.data as unknown as { presets: readonly ModelPreset[] };
      return { data: { presets: data.presets.map(cloneModelPreset) }, version: response.version };
    } catch (error) {
      throw externalError(error, "deleteModelPreset");
    }
  }

  async listMessages(conversationId: string, query: { limit: number; cursor: string | null }): Promise<Page<Message>> {
    try {
      return this.core.listMessages(conversationId, query) as unknown as Page<Message>;
    } catch (error) {
      throw externalError(error, "listMessages");
    }
  }

  async ingestConversation(conversationId: string): Promise<{ path: string }> {
    try {
      return await this.core.ingestConversation(conversationId);
    } catch (error) {
      throw externalError(error, "ingestConversation");
    }
  }

  async postMessage(conversationId: string, input: PostMessageInput, command: CommandMeta): Promise<CommandResult<{ message_id: string; advisor_run_id: string | null }>> {
    try {
      const response = await this.core.postMessage(conversationId, { ...command, payload: input as never });
      const { version: _version, ...data } = response.data as JsonObject;
      return { data: data as { message_id: string; advisor_run_id: string | null }, version: response.version };
    } catch (error) {
      throw externalError(error, "postMessage");
    }
  }

  async ingestInbound(ownerId: string, input: InboundMessageInput, command: CommandMeta): Promise<CommandResult<InboundMessageResult>> {
    try {
      const response = await this.core.ingestInbound(ownerId, { ...command, payload: input as never });
      const { version: _version, ...data } = response.data as JsonObject;
      return { data: data as InboundMessageResult, version: response.version };
    } catch (error) {
      throw externalError(error, "ingestInbound");
    }
  }

  async ensureConnectorAccount(ownerId: string, provider: "slack" | "discord", accountId: string): Promise<string> {
    try {
      if (typeof this.core.ensureConnectorAccount !== "function") throw new ApiError(503, "dependency_unavailable", "Core does not support connector account registration.");
      return await this.core.ensureConnectorAccount(ownerId, provider, accountId);
    } catch (error) {
      throw externalError(error, "ensureConnectorAccount");
    }
  }

  async registerInboundUpload(ownerId: string, input: InboundUploadRegisterInput, command: CommandMeta): Promise<CommandResult<InboundUploadTicket>> {
    try {
      const response = await this.core.registerInboundUpload(ownerId, { ...command, payload: input as never });
      return { data: response.data as unknown as InboundUploadTicket, version: response.version };
    } catch (error) {
      throw externalError(error, "registerInboundUpload");
    }
  }

  async putInboundUpload(ownerId: string, uploadId: string, input: { content: Buffer; sha256: string; mime: string }): Promise<InboundUploadContentResult> {
    try {
      const response = await this.core.putInboundUpload(ownerId, uploadId, { sha256: input.sha256, mime: input.mime, content_base64: input.content.toString("base64") });
      return response as InboundUploadContentResult;
    } catch (error) {
      throw externalError(error, "putInboundUpload");
    }
  }

  async completeInboundUpload(ownerId: string, uploadId: string, input: InboundUploadCompleteInput, command: CommandMeta): Promise<CommandResult<InboundUploadCompleteResult>> {
    try {
      const response = await this.core.completeInboundUpload(ownerId, uploadId, { ...command, payload: input as never });
      return { data: response.data as unknown as InboundUploadCompleteResult, version: response.version };
    } catch (error) {
      throw externalError(error, "completeInboundUpload");
    }
  }

  async uploadWebAttachment(
    ownerId: string,
    target: WebAttachmentTarget,
    file: WebAttachmentFile,
    command: { request_id: string; idempotency_key: string },
  ): Promise<WebAttachmentResult> {
    try {
      if (typeof this.core.uploadWebAttachment !== "function") throw new ApiError(503, "dependency_unavailable", "Core does not support Web attachments.");
      return await this.core.uploadWebAttachment(ownerId, target, file, command);
    } catch (error) {
      throw externalError(error, "uploadWebAttachment");
    }
  }

  async advisorRespond(conversationId: string, messageId: string, origin?: AdvisorOrigin): Promise<void> {
    if (typeof this.core.advisorRespond === "function") {
      try {
        await this.core.advisorRespond(conversationId, messageId, origin);
      } catch (error) {
        console.error("[owl-server] Advisor response failed (external):", error);
      }
    }
  }

  async restartAdvisorSession(ownerId: string, windowKey?: string): Promise<void> {
    if (typeof this.core.restartAdvisorSession !== "function") {
      throw new ApiError(503, "dependency_unavailable", "Persistent Advisor session restart is not available in the loaded Core.");
    }
    try {
      await this.core.restartAdvisorSession(ownerId, windowKey);
    } catch (error) {
      throw externalError(error, "restartAdvisorSession");
    }
  }

  async getAdvisorActivity(sessionId: string, conversationId: string | null): Promise<SessionActivity | null> {
    try {
      return this.core.getAdvisorActivity(sessionId, conversationId);
    } catch (error) {
      throw externalError(error, "getAdvisorActivity");
    }
  }

  async interruptAdvisorTurn(ownerId: string, windowKey?: string): Promise<{ status: "interrupting" | "not_running" | "unsupported"; turn_id: string | null }> {
    if (typeof this.core.interruptAdvisorTurn !== "function") {
      throw new ApiError(503, "dependency_unavailable", "Advisor turn interruption is not available in the loaded Core.");
    }
    try {
      return await this.core.interruptAdvisorTurn(ownerId, windowKey);
    } catch (error) {
      throw externalError(error, "interruptAdvisorTurn");
    }
  }

  async getHybridMode(): Promise<boolean> {
    try {
      return await this.core.getHybridMode();
    } catch (error) {
      throw externalError(error, "getHybridMode");
    }
  }

  async setHybridMode(enabled: boolean): Promise<boolean> {
    try {
      return await this.core.setHybridMode(enabled);
    } catch (error) {
      throw externalError(error, "setHybridMode");
    }
  }

  listSkills(filter: { query?: string; state?: string; scope?: string; trial?: boolean }): unknown[] {
    if (typeof this.core.listSkills !== "function") throw skillApiUnavailable("Skill listing");
    try {
      return [...this.core.listSkills(filter)];
    } catch (error) {
      throw externalError(error, "listSkills");
    }
  }

  getSkillActivity(days: number): unknown {
    if (typeof this.core.getSkillActivity !== "function") throw skillApiUnavailable("Skill activity");
    try {
      return this.core.getSkillActivity(days);
    } catch (error) {
      throw externalError(error, "getSkillActivity");
    }
  }

  async getSkill(name: string): Promise<unknown> {
    if (typeof this.core.getSkill !== "function") throw skillApiUnavailable("Skill details");
    try {
      return await this.core.getSkill(name);
    } catch (error) {
      throw externalError(error, "getSkill");
    }
  }

  async readSkillFile(name: string, path: string): Promise<string> {
    if (typeof this.core.readSkillFile !== "function") throw skillApiUnavailable("Skill files");
    try {
      return await this.core.readSkillFile(name, path);
    } catch (error) {
      throw externalError(error, "readSkillFile");
    }
  }

  listSkillRevisions(name: string): unknown[] {
    if (typeof this.core.listSkillRevisions !== "function") throw skillApiUnavailable("Skill revisions");
    try {
      return [...this.core.listSkillRevisions(name)];
    } catch (error) {
      throw externalError(error, "listSkillRevisions");
    }
  }

  getSkillRevision(name: string, revisionId: string): unknown {
    if (typeof this.core.getSkillRevision !== "function") throw skillApiUnavailable("Skill revisions");
    try {
      return this.core.getSkillRevision(name, revisionId);
    } catch (error) {
      throw externalError(error, "getSkillRevision");
    }
  }

  async restoreSkill(name: string, revisionId: string): Promise<{ data: { revision_id: string; revision: number }; version: number }> {
    if (typeof this.core.restoreSkill !== "function") throw skillApiUnavailable("Skill restore");
    try {
      return { data: await this.core.restoreSkill(name, revisionId), version: 0 };
    } catch (error) {
      throw externalError(error, "restoreSkill");
    }
  }

  async updateSkill(name: string, patch: { state?: string; scope?: string }): Promise<{ data: unknown; version: number }> {
    if (typeof this.core.updateSkill !== "function") throw skillApiUnavailable("Skill updates");
    try {
      return { data: await this.core.updateSkill(name, patch), version: 0 };
    } catch (error) {
      throw externalError(error, "updateSkill");
    }
  }

  listSkillProposals(status?: string): unknown[] {
    if (typeof this.core.listSkillProposals !== "function") throw skillApiUnavailable("Skill proposals");
    try {
      return [...this.core.listSkillProposals(status)];
    } catch (error) {
      throw externalError(error, "listSkillProposals");
    }
  }

  listLearningJobs(status?: string): unknown[] {
    if (typeof this.core.listLearningJobs !== "function") throw skillApiUnavailable("Learning jobs");
    try {
      return [...this.core.listLearningJobs(status)];
    } catch (error) {
      throw externalError(error, "listLearningJobs");
    }
  }

  async retryLearningJob(jobId: string): Promise<void> {
    if (typeof this.core.retryLearningJob !== "function") throw skillApiUnavailable("Learning job retry");
    try {
      await this.core.retryLearningJob(jobId);
    } catch (error) {
      throw externalError(error, "retryLearningJob");
    }
  }

  async approveSkillProposal(proposalId: string): Promise<{ data: unknown; version: number }> {
    if (typeof this.core.approveSkillProposal !== "function") throw skillApiUnavailable("Skill proposal approval");
    try {
      return { data: await this.core.approveSkillProposal(proposalId), version: 0 };
    } catch (error) {
      throw externalError(error, "approveSkillProposal");
    }
  }

  async rejectSkillProposal(proposalId: string): Promise<{ data: unknown; version: number }> {
    if (typeof this.core.rejectSkillProposal !== "function") throw skillApiUnavailable("Skill proposal rejection");
    try {
      return { data: await this.core.rejectSkillProposal(proposalId), version: 0 };
    } catch (error) {
      throw externalError(error, "rejectSkillProposal");
    }
  }

  runCuration(input: JsonObject): Promise<unknown> {
    if (typeof this.core.runCuration !== "function") throw skillApiUnavailable("Curation runs");
    return this.core.runCuration(input as never);
  }

  startCurationInBackground(input: JsonObject): Promise<unknown> {
    if (typeof this.core.startCurationInBackground !== "function") throw skillApiUnavailable("Curation runs");
    return this.core.startCurationInBackground(input as never);
  }

  listCurationRuns(query: JsonObject): { items: readonly unknown[]; next_cursor: string | null } {
    if (typeof this.core.listCurationRuns !== "function") throw skillApiUnavailable("Curation run listing");
    return this.core.listCurationRuns(query as never);
  }

  getCurationRun(id: string): unknown {
    if (typeof this.core.getCurationRun !== "function") throw skillApiUnavailable("Curation run lookup");
    return this.core.getCurationRun(id);
  }

  listBacklogItems(filter: { status?: string; project_id?: string; work_id?: string; limit?: number; offset?: number }): { items: unknown[]; next_offset: number | null } {
    if (typeof this.core.listBacklogItems !== "function") throw skillApiUnavailable("Review backlog listing");
    try {
      const result = this.core.listBacklogItems(filter as never);
      return { items: [...result.items], next_offset: result.next_offset };
    } catch (error) {
      throw externalError(error, "listBacklogItems");
    }
  }

  getAutoWorkSettings(): { version: number; data: JsonObject } {
    if (typeof this.core.getAutoWorkSettings !== "function") throw skillApiUnavailable("Automatic Work settings");
    try {
      return this.core.getAutoWorkSettings();
    } catch (error) {
      throw externalError(error, "getAutoWorkSettings");
    }
  }

  async updateAutoWorkSettings(request: JsonObject): Promise<{ data: JsonObject; version: number }> {
    if (typeof this.core.updateAutoWorkSettings !== "function") throw skillApiUnavailable("Automatic Work settings update");
    try {
      const response = await this.core.updateAutoWorkSettings(request as never);
      return { data: response.data, version: response.version };
    } catch (error) {
      throw externalError(error, "updateAutoWorkSettings");
    }
  }

  listAutoWorkEvents(filter: JsonObject): { items: unknown[]; next_offset: number | null } {
    if (typeof this.core.listAutoWorkEvents !== "function") throw skillApiUnavailable("Automatic Work history");
    try {
      const result = this.core.listAutoWorkEvents(filter);
      return { items: [...result.items], next_offset: result.next_offset };
    } catch (error) {
      throw externalError(error, "listAutoWorkEvents");
    }
  }

  getAutoWorkEvent(id: string): unknown {
    if (typeof this.core.getAutoWorkEvent !== "function") throw skillApiUnavailable("Automatic Work history lookup");
    try {
      return this.core.getAutoWorkEvent(id);
    } catch (error) {
      throw externalError(error, "getAutoWorkEvent");
    }
  }

  async runAutoWorkNow(projectId: string, what: string): Promise<unknown> {
    if (typeof this.core.runAutoWorkNow !== "function") throw skillApiUnavailable("Automatic Work run");
    try {
      return await this.core.runAutoWorkNow(projectId, what as never);
    } catch (error) {
      throw externalError(error, "runAutoWorkNow");
    }
  }

  async dismissBacklogItems(request: JsonObject): Promise<{ data: JsonObject; version: number }> {
    if (typeof this.core.dismissBacklogItems !== "function") throw skillApiUnavailable("Review backlog dismissal");
    try {
      const response = await this.core.dismissBacklogItems(request as never);
      return { data: response.data, version: response.version };
    } catch (error) {
      throw externalError(error, "dismissBacklogItems");
    }
  }

  async deleteBacklogItems(request: JsonObject): Promise<{ data: JsonObject; version: number }> {
    if (typeof this.core.deleteBacklogItems !== "function") throw skillApiUnavailable("Review backlog deletion");
    try {
      const response = await this.core.deleteBacklogItems(request as never);
      return { data: response.data, version: response.version };
    } catch (error) {
      throw externalError(error, "deleteBacklogItems");
    }
  }

  async receiveAutoWorkNotice(request: JsonObject): Promise<{ data: JsonObject; version: number }> {
    if (typeof this.core.receiveAutoWorkNotice !== "function") throw skillApiUnavailable("Automatic Work creation");
    try {
      const response = await this.core.receiveAutoWorkNotice(request as never);
      return { data: response.data, version: response.version };
    } catch (error) {
      throw externalError(error, "receiveAutoWorkNotice");
    }
  }

  async issueBacklogWork(request: JsonObject): Promise<{ data: JsonObject; version: number }> {
    if (typeof this.core.issueBacklogWork !== "function") throw skillApiUnavailable("Review backlog Work issuance");
    try {
      const response = await this.core.issueBacklogWork(request as never);
      return { data: response.data, version: response.version };
    } catch (error) {
      throw externalError(error, "issueBacklogWork");
    }
  }

  async linkBacklogItems(workId: string, request: JsonObject): Promise<{ data: JsonObject; version: number }> {
    if (typeof this.core.linkBacklogItems !== "function") throw skillApiUnavailable("Review backlog linking");
    try {
      const response = await this.core.linkBacklogItems(workId, request as never);
      return { data: response.data, version: response.version };
    } catch (error) {
      throw externalError(error, "linkBacklogItems");
    }
  }

  getSkillSettings(): unknown {
    if (typeof this.core.getSkillSettings !== "function") throw skillApiUnavailable("Skill settings");
    try {
      return this.core.getSkillSettings();
    } catch (error) {
      throw externalError(error, "getSkillSettings");
    }
  }

  async setSkillSettings(value: unknown): Promise<{ data: unknown; version: number }> {
    if (typeof this.core.setSkillSettings !== "function") throw skillApiUnavailable("Skill settings");
    try {
      return { data: await this.core.setSkillSettings(value), version: 0 };
    } catch (error) {
      throw externalError(error, "setSkillSettings");
    }
  }

  async getLanguage(): Promise<OwnerLanguage> {
    try {
      return await this.core.getLanguage();
    } catch (error) {
      throw externalError(error, "getLanguage");
    }
  }

  async recordAgentResearch(
    agent: GuardTokenAgent,
    capture: WebResearchCapture,
  ): Promise<{ readonly accepted: boolean; readonly reason?: string }> {
    try {
      return await this.core.recordAgentResearch(agent, capture);
    } catch (error) {
      throw externalError(error, "recordAgentResearch");
    }
  }

  async recordSkillReads(input: Parameters<Core["recordSkillReads"]>[0]): Promise<void> {
    try {
      await this.core.recordSkillReads(input);
    } catch (error) {
      throw externalError(error, "recordSkillReads");
    }
  }

  async setLanguage(language: OwnerLanguage): Promise<OwnerLanguage> {
    if (typeof this.core.setLanguage !== "function") {
      throw new ApiError(503, "core_not_ready", "このCoreは言語設定に対応していません。Coreを更新してください。");
    }
    try {
      return await this.core.setLanguage(language);
    } catch (error) {
      throw externalError(error, "setLanguage");
    }
  }

  /** Install commands filtered by provider CLI availability, detected once per adapter. */
  private processSkillsInstallCommands(): ProcessSkillsInstallCommand[] {
    this.processSkillsInstallCommandList ??= processSkillsInstallCommands(this.detectProviderAvailability());
    return this.processSkillsInstallCommandList;
  }

  async getProcessSkillsSettings(): Promise<ProcessSkillsSettingsSnapshot> {
    let snapshot: ProcessSkillsSettingsSnapshot;
    try {
      snapshot = (await this.core.getProcessSkillsSettings()) as ProcessSkillsSettingsSnapshot;
    } catch (error) {
      throw externalError(error, "getProcessSkillsSettings");
    }
    return { ...snapshot, install_commands: this.processSkillsInstallCommands() };
  }

  async setProcessSkillsSettings(input: ProcessSkillsSettingsInput): Promise<ProcessSkillsSettingsSnapshot> {
    let snapshot: ProcessSkillsSettingsSnapshot;
    try {
      snapshot = (await this.core.setProcessSkillsSettings(input as never)) as ProcessSkillsSettingsSnapshot;
    } catch (error) {
      throw externalError(error, "setProcessSkillsSettings");
    }
    return { ...snapshot, install_commands: this.processSkillsInstallCommands() };
  }

  async getKnowledgeAutomationSettings(): Promise<KnowledgeAutomationSnapshot> {
    try {
      return await this.core.getKnowledgeAutomationSettings!();
    } catch (error) {
      throw externalError(error, "getKnowledgeAutomationSettings");
    }
  }

  async setKnowledgeAutomationSettings(input: KnowledgeAutomationSettings): Promise<KnowledgeAutomationSnapshot> {
    try {
      return await this.core.setKnowledgeAutomationSettings!(input);
    } catch (error) {
      throw externalError(error, "setKnowledgeAutomationSettings");
    }
  }

  async getTypesafeApiKey(): Promise<string> {
    return this.appSettings.getTypesafeApiKey();
  }

  async setTypesafeApiKey(key: string): Promise<string> {
    return this.appSettings.setTypesafeApiKey(key);
  }

  async getAdvisorPersona(): Promise<string> {
    return this.appSettings.getAdvisorPersona();
  }

  async setAdvisorPersona(persona: string): Promise<string> {
    const previous = this.appSettings.getAdvisorPersona();
    const saved = this.appSettings.setAdvisorPersona(persona);
    if (saved !== previous && typeof this.core.restartAdvisorSession === "function") {
      const ownerId = process.env.OWL_OWNER_ID?.trim() || "owner:default";
      try {
        await this.core.restartAdvisorSession(ownerId);
      } catch (error) {
        throw externalError(error, "restartAdvisorSession after persona update");
      }
    }
    return saved;
  }

  async getAdvisorFolders(): Promise<import("./types.js").AdvisorFoldersSnapshot> {
    const defaults = advisorFolderDefaults(this.dataDir);
    const shared = this.appSettings.getAdvisorSharedDir();
    const screenshot = this.appSettings.getAdvisorScreenshotDir();
    return {
      shared_dir: shared || defaults.sharedDir,
      screenshot_dir: screenshot || defaults.screenshotDir,
      defaults: { shared_dir: defaults.sharedDir, screenshot_dir: defaults.screenshotDir },
      custom: { shared_dir: !!shared, screenshot_dir: !!screenshot },
    };
  }

  async setAdvisorFolders(sharedDir: string, screenshotDir: string): Promise<import("./types.js").AdvisorFoldersSnapshot> {
    const previous = await this.getAdvisorFolders();
    const shared = normalizeAdvisorFolder(sharedDir);
    const screenshot = normalizeAdvisorFolder(screenshotDir);
    const defaults = advisorFolderDefaults(this.dataDir);
    const effectiveShared = shared || defaults.sharedDir;
    if (!isGitIgnoredDirectory(effectiveShared)) throw new AdvisorFolderError("tracked");
    ensureAdvisorSharedDir(effectiveShared);
    this.appSettings.setAdvisorFolders(shared, screenshot);
    const saved = await this.getAdvisorFolders();
    if ((saved.shared_dir !== previous.shared_dir || saved.screenshot_dir !== previous.screenshot_dir) && typeof this.core.restartAdvisorSession === "function") {
      const ownerId = process.env.OWL_OWNER_ID?.trim() || "owner:default";
      try { await this.core.restartAdvisorSession(ownerId); }
      catch (error) { throw externalError(error, "restartAdvisorSession after folder update"); }
    }
    return saved;
  }

  async getAdvisorFileDestinationSettings(): Promise<import("./app-settings-store.js").FileDestinationSettings> {
    return this.appSettings.getAdvisorFileDestinationSettings();
  }

  async setAdvisorFileDestinationSettings(input: import("./app-settings-store.js").FileDestinationSettings): Promise<import("./app-settings-store.js").FileDestinationSettings> {
    return this.appSettings.setAdvisorFileDestinationSettings(input);
  }

  async clearConversation(conversationId: string): Promise<{ cleared: boolean }> {
    try {
      return await this.core.clearConversation(conversationId);
    } catch (error) {
      throw externalError(error, "clearConversation");
    }
  }

  async getActiveConversation(): Promise<{ conversation_id: string }> {
    try {
      return await this.core.getActiveConversation();
    } catch (error) {
      throw externalError(error, "getActiveConversation");
    }
  }

  async listProviders(): Promise<DetectedProvider[]> {
    const customProviders = this.appSettings.getCustomProviders();
    return detectProviders(BUILTIN_PROVIDER_PRESETS, BUILTIN_HARNESSES, customProviders);
  }

  async dispatchChildRun(parentAgentRunId: string, request: ChildDispatchRequest, requestKey: string): Promise<ChildDispatchResponse> {
    if (typeof this.core.dispatchChildRun !== "function") throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support child runs.");
    try {
      return await this.core.dispatchChildRun(parentAgentRunId, request, requestKey);
    } catch (error) {
      throw externalError(error, "dispatchChildRun");
    }
  }

  async waitChildRuns(parentAgentRunId: string, request: ChildWaitRequest, signal: AbortSignal): Promise<ChildWaitResponse> {
    if (typeof this.core.waitChildRuns !== "function") throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support child runs.");
    try {
      return await this.core.waitChildRuns(parentAgentRunId, request, signal);
    } catch (error) {
      throw externalError(error, "waitChildRuns");
    }
  }

  listChildRuns(filter: ChildRunListFilter): readonly ChildRunRecord[] {
    if (typeof this.core.listChildRuns !== "function") throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support child runs.");
    try {
      return [...this.core.listChildRuns(filter)];
    } catch (error) {
      throw externalError(error, "listChildRuns");
    }
  }

  getChildRunSettings(): ChildRunSettings {
    if (typeof this.core.getChildRunSettings !== "function") throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support child-run settings.");
    try {
      return this.core.getChildRunSettings();
    } catch (error) {
      throw externalError(error, "getChildRunSettings");
    }
  }

  async setChildRunSettings(settings: ChildRunSettings): Promise<ChildRunSettings> {
    if (typeof this.core.setChildRunSettings !== "function") throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support child-run settings.");
    try {
      return await this.core.setChildRunSettings(settings);
    } catch (error) {
      throw externalError(error, "setChildRunSettings");
    }
  }

  async listProviderPauses(): Promise<ProviderPauseView[]> {
    try {
      return this.core.listProviderPauses?.() ?? [];
    } catch (error) {
      throw externalError(error, "listProviderPauses");
    }
  }

  async resumeProviderPause(provider: string): Promise<ProviderPauseView | null> {
    try {
      if (!this.core.resumeProviderPause) throw new ApiError(404, "provider_pause_not_found", "プロバイダーの一時停止が見つかりません。 / The provider pause was not found.");
      return await this.core.resumeProviderPause(provider);
    } catch (error) {
      throw externalError(error, "resumeProviderPause");
    }
  }

  async getProvider(id: string): Promise<ProviderConfigRecord | null> {
    const builtin = BUILTIN_PROVIDER_PRESETS.find((provider) => provider.id === id);
    if (builtin) {
      return builtinProviderToRecord(builtin);
    }
    const customProviders = this.appSettings.getCustomProviders();
    if (!Object.hasOwn(customProviders, id)) return null;
    const custom = customProviders[id];
    return {
      id,
      displayName: custom.displayName,
      harnessId: custom.harnessId,
      backendUrl: custom.backendUrl,
      apiKeySource: custom.apiKeySource,
      isBuiltin: false,
    };
  }

  async saveProvider(id: string, input: SaveProviderInput): Promise<ProviderConfigRecord> {
    if (BUILTIN_PROVIDER_PRESETS.some((provider) => provider.id === id)) {
      throw new ApiError(409, "validation_error", "組み込みProviderは編集できません。別のIDでカスタムProviderとして登録してください。");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(id)) {
      throw new ApiError(400, "validation_error", "Provider IDは英数字、ハイフン、アンダースコアを使う64文字以内の値にしてください。");
    }
    if (input.displayName.trim().length === 0 || input.displayName.length > 128) {
      throw new ApiError(400, "validation_error", "displayNameは1〜128文字で指定してください。");
    }
    if (input.harnessId !== "claude" && input.harnessId !== "codex" && input.harnessId !== "opencode") {
      throw new ApiError(400, "validation_error", "harnessIdはclaude、codex、opencodeのいずれかを指定してください。");
    }
    // A custom provider always names its endpoint; without it the harness
    // would send the provider's key to the harness's own default service.
    if (input.backendUrl === undefined || input.backendUrl.trim().length === 0) {
      throw new ApiError(400, "validation_error", "backendUrlを指定してください。カスタムProviderには接続先のhttpまたはhttpsのURLが必要です。", { field: "backendUrl" });
    }
    try {
      const parsed = new URL(input.backendUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
    } catch {
      throw new ApiError(400, "validation_error", "backendUrlはhttpまたはhttpsのURLを指定してください。", { field: "backendUrl" });
    }
    if (input.apiKeySource !== undefined && !/^env:[A-Za-z_][A-Za-z0-9_]*$/u.test(input.apiKeySource)) {
      throw new ApiError(400, "validation_error", "apiKeySourceはenv:VARIABLE_NAME形式で指定してください。");
    }
    const saved = this.appSettings.saveCustomProvider(id, { ...input });
    return {
      id,
      displayName: saved.displayName,
      harnessId: saved.harnessId,
      backendUrl: saved.backendUrl,
      apiKeySource: saved.apiKeySource,
      isBuiltin: false,
    };
  }

  async deleteProvider(id: string): Promise<{ deleted: boolean }> {
    if (BUILTIN_PROVIDER_PRESETS.some((provider) => provider.id === id)) {
      throw new ApiError(409, "validation_error", "組み込みProviderは削除できません。");
    }
    return { deleted: this.appSettings.deleteCustomProvider(id) };
  }

  async testProvider(id: string): Promise<{ ok: boolean; detail: string }> {
    const provider = await this.getProvider(id);
    if (!provider) {
      throw new ApiError(404, "not_found", "指定されたProviderが見つかりません。IDを確認して再試行してください。");
    }
    if (!provider.isBuiltin && !provider.backendUrl) {
      return { ok: false, detail: coreText(await this.getLanguage(), "backendUrlが未設定です。Provider設定で接続先のURLを指定してください。", "backendUrl is missing. Set the destination URL in Provider settings.") };
    }
    const harness = BUILTIN_HARNESSES.find((candidate) => candidate.id === provider.harnessId);
    if (!harness?.binaryName) {
      return { ok: false, detail: coreText(await this.getLanguage(), "ハーネスにbinaryNameが設定されていません。", "The Harness has no binaryName configured.") };
    }
    try {
      const resolvedPath = execFileSync("which", [harness.binaryName], { encoding: "utf8" }).trim();
      return resolvedPath.length > 0
        ? { ok: true, detail: resolvedPath }
        : { ok: false, detail: coreText(await this.getLanguage(), `${harness.binaryName} の実行ファイルが見つかりません。`, `The ${harness.binaryName} executable was not found.`) };
    } catch {
      return { ok: false, detail: coreText(await this.getLanguage(), `${harness.binaryName} がインストールされていません。`, `${harness.binaryName} is not installed.`) };
    }
  }

  async getProviderModels(): Promise<Record<string, string[]>> {
    return mergeOfficialModels(this.appSettings.getProviderModels());
  }

  async setProviderModels(providerId: string, models: string[]): Promise<string[]> {
    return this.appSettings.setProviderModels(providerId, models);
  }

    async getIntegrations(): Promise<IntegrationStatus[]> {
    return this.integrationStore.list();
  }

  async saveIntegration(provider: IntegrationProvider, config: IntegrationConfigPatch, _command: CommandMeta): Promise<{ data: IntegrationStatus; version: number }> {
    const status = this.integrationStore.save_integration(provider, config);
    const stored = this.integrationStore.getConfig(provider);
    const ownerId = process.env.OWL_OWNER_ID?.trim() || "owner:default";
    if (!stored?.account_id) throw new ApiError(500, "server_error", "Connector account registration did not produce a canonical account id.");
    await this.ensureConnectorAccount(ownerId, provider, stored.account_id);
    this.emitControl({ type: "integration.saved", provider });
    return { data: status, version: 0 };
  }

  async testIntegration(provider: IntegrationProvider): Promise<IntegrationTestResult> {
    return this.integrationStore.test(provider, await this.getLanguage());
  }

  async deleteIntegration(provider: IntegrationProvider, _command: CommandMeta): Promise<{ data: { provider: string }; version: number }> {
    this.integrationStore.remove(provider);
    this.emitControl({ type: "integration.deleted", provider });
    return { data: { provider }, version: 0 };
  }

  /**
   * Integration changes are server-local settings, not durable Core events.
   * They used to be pushed into the event stream with sequence = last seen + 1,
   * which collided with the next durable event: SDK/WebSocket clients advanced
   * their cursor past it and silently dropped the real event. They now go only
   * to in-process control listeners (the connector manager).
   */
  private emitControl(signal: CoreControlSignal): void {
    for (const listener of this.controlListeners) {
      try {
        listener(signal);
      } catch (error) {
        console.error(`[owl-server] ${signal.type} listener failed`, error);
      }
    }
  }

  subscribeControl(listener: CoreControlListener): () => void {
    this.controlListeners.add(listener);
    return () => this.controlListeners.delete(listener);
  }

  subscribe(listener: CoreEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  eventsAfter(cursor: number, limit?: number): CoreEvent[] {
    if (this.core.listEventsAfter) {
      try {
        // The adapter API uses -1 to mean "from the beginning"; the durable Core uses 0.
        const externalCursor = cursor < 0 ? 0 : cursor;
        return [...this.core.listEventsAfter(externalCursor, limit)];
      } catch (error) {
        throw externalError(error, "listEventsAfter");
      }
    }
    return latestEvents(this.eventLog.filter((event) => event.sequence > cursor), limit);
  }

  /**
   * Newest-first page read from the durable Core. listEventsAfter is ascending
   * and filters internal lifecycle rows after its LIMIT, so read a bounded
   * window just below `before` and widen it until enough visible events exist.
   * Agent events carry their AgentRun's model and effort so the Activity Log
   * can label the agent instead of its provider.
   */
  eventsBefore(before: number | null, limit: number): CoreEvent[] {
    return this.readEventsBefore(before, limit).map((event) => this.withAgentRun(event));
  }

  private withAgentRun(event: CoreEvent): CoreEvent {
    const candidate = this.db as { get?: <T>(sql: string, ...params: unknown[]) => T | undefined } | null;
    if (!event.agent_run_id || !candidate || typeof candidate.get !== "function") return event;
    try {
      const row = candidate.get<{ model: string | null; effort: string | null }>("SELECT model, effort FROM agent_runs WHERE id = ?", event.agent_run_id);
      return row ? { ...event, agent_run: { model: row.model, effort: row.effort } } : event;
    } catch {
      return event;
    }
  }

  private readEventsBefore(before: number | null, limit: number): CoreEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new ApiError(400, "invalid_query", "イベント一覧のlimitが不正です。0以上の整数を指定してください。");
    }
    if (limit === 0) return [];
    if (!this.core.listEventsAfter) {
      const older = (before === null ? this.eventLog : this.eventLog.filter((event) => event.sequence < before)).filter(isActivityEvent);
      return newestFirst(older, limit);
    }
    const listEventsAfter = this.core.listEventsAfter.bind(this.core);
    const upper = before === null ? this.maxEventSequence() : before - 1;
    try {
      if (upper === null) {
        // Sequence bounds unavailable: fall back to a full ascending read.
        const all = listEventsAfter(0).filter((event) => (before === null || event.sequence < before) && isActivityEvent(event));
        return newestFirst([...all], limit);
      }
      if (upper <= 0) return [];
      let window = Math.max(limit * 2, 64);
      for (;;) {
        const start = Math.max(0, upper - window);
        const visible = listEventsAfter(start, upper - start).filter((event) => event.sequence <= upper && isActivityEvent(event));
        if (visible.length >= limit || start === 0) return newestFirst([...visible], limit);
        window *= 2;
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw externalError(error, "listEventsAfter");
    }
  }

  private maxEventSequence(): number | null {
    const candidate = this.db as { get?: <T>(sql: string, ...params: unknown[]) => T | undefined } | null;
    if (!candidate || typeof candidate.get !== "function") return null;
    try {
      const row = candidate.get<{ max_sequence: number | bigint | null }>("SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM events");
      const value = row?.max_sequence;
      return value === null || value === undefined ? 0 : Number(value);
    } catch (error) {
      throw externalError(error, "maxEventSequence");
    }
  }

  private minEventSequence(): number | null {
    const candidate = this.db as { get?: <T>(sql: string, ...params: unknown[]) => T | undefined } | null;
    if (!candidate || typeof candidate.get !== "function") return null;
    try {
      const row = candidate.get<{ min_sequence: number | bigint | null }>("SELECT MIN(sequence) AS min_sequence FROM events");
      const value = row?.min_sequence;
      return value === null || value === undefined ? null : Number(value);
    } catch (error) {
      throw externalError(error, "minEventSequence");
    }
  }

  oldestEventSequence(): number | null {
    const direct = this.minEventSequence();
    if (direct !== null) return direct;
    if (this.core.listEventsAfter) {
      try {
        return this.core.listEventsAfter(0, 1)[0]?.sequence ?? null;
      } catch (error) {
        throw externalError(error, "listEventsAfter");
      }
    }
    return this.eventLog[0]?.sequence ?? null;
  }

  latestEventCursor(): string {
    const direct = this.maxEventSequence();
    if (direct !== null) return String(direct);
    return this.eventsAfter(0).at(-1)?.cursor ?? "0";
  }

  activeAgentCount(): number {
    return 0;
  }

  forceTerminateProcesses(): void {
    this.core.terminateOwnedProcessesImmediately?.();
  }

  async shutdown(options: { force: boolean; timeoutMs: number }): Promise<void> {
    try {
      await this.core.stop({ force: options.force, timeoutMs: options.timeoutMs });
      this.unsubscribeExternal();
      const candidate = this.db as { close?: () => void } | null;
      if (candidate && typeof candidate.close === "function") candidate.close();
    } catch (error) {
      throw externalError(error, "shutdown");
    }
  }
}

/**
 * Whether the Activity Log shows the event. A system.alert without a message
 * is a bookkeeping record (Advisor turns, command audit rows), not something
 * the Owner has to act on; the Slack and Discord connectors skip it the same way.
 */
function isActivityEvent(event: CoreEvent): boolean {
  if (event.type !== "system.alert") return true;
  const message = event.payload.message;
  return typeof message === "string" && message.trim().length > 0;
}

function newestFirst<T>(ascending: T[], limit: number): T[] {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new ApiError(400, "invalid_query", "イベント一覧のlimitが不正です。0以上の整数を指定してください。");
  }
  return limit === 0 ? [] : ascending.slice(-limit).reverse();
}

function latestEvents<T>(events: T[], limit?: number): T[] {
  if (limit === undefined) return events;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new ApiError(400, "invalid_query", "イベント一覧のlimitが不正です。0以上の整数を指定してください。");
  }
  return limit === 0 ? [] : events.slice(0, limit);
}

/**
 * The endpoint/key variables one custom provider's harness reads: Codex gets
 * its dedicated model provider variables, Claude the Anthropic ones. The key
 * is only set when its source variable holds a value.
 */
export function customProviderConnectionEnv(
  providerId: string,
  custom: CustomProviderConfig,
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  if (!custom.backendUrl) {
    throw new Error(`Custom provider '${providerId}' has no backend URL configured.`);
  }
  const useCodexVars = custom.harnessId === "codex";
  if (custom.harnessId === "opencode") {
    // opencode reads its endpoint from its own settings; the key stays in a variable of the configured name.
    const keyEnv = custom.apiKeySource?.startsWith("env:") ? custom.apiKeySource.slice("env:".length) : undefined;
    return {
      [OPENCODE_BASE_URL_ENV]: custom.backendUrl,
      ...(keyEnv ? { [OPENCODE_API_KEY_ENV_ENV]: keyEnv } : {}),
      ...(keyEnv && source[keyEnv] ? { [keyEnv]: source[keyEnv] } : {}),
    };
  }
  const env: Record<string, string> = {
    [useCodexVars ? CODEX_PROVIDER_BASE_URL_ENV : "ANTHROPIC_BASE_URL"]: custom.backendUrl,
  };
  const apiKeyEnv = custom.apiKeySource?.startsWith("env:") ? custom.apiKeySource.slice("env:".length) : undefined;
  const apiKey = apiKeyEnv ? source[apiKeyEnv] : undefined;
  if (apiKey) {
    env[useCodexVars ? CODEX_PROVIDER_API_KEY_ENV : "ANTHROPIC_API_KEY"] = apiKey;
  }
  return env;
}

export async function createConfiguredCore(options: CreateCoreOptions): Promise<CorePort> {
  const corePath = join(serverPackageRoot(), "../../packages/core/dist/index.js");
  try {
    await access(corePath);
  } catch (error) {
    throw new ApiError(
      503,
      "dependency_unavailable",
      "Core実行基盤がまだ利用できません。必要なdistをビルドしてから再実行してください。",
      { dependency: "packages/core/dist/index.js" },
      { cause: error },
    );
  }
  let loaded: ExternalCoreModule;
  try {
    loaded = (await import(pathToFileURL(corePath).href)) as ExternalCoreModule;
  } catch (error) {
    throw new ApiError(
      503,
      "dependency_unavailable",
      "Core実行基盤を読み込めませんでした。ビルド成果物と実行環境を確認してください。",
      { dependency: "packages/core/dist/index.js" },
      { cause: error },
    );
  }
  if (typeof loaded.createCore !== "function") {
    throw new ApiError(
      503,
      "dependency_unavailable",
      "Coreの公開APIが契約と一致しません。createCore({db, agentRunner, git, version})を確認してください。",
      { dependency: "packages/core/dist/index.js", export: "createCore" },
    );
  }
  const owlRoot = options.owlRoot ?? defaultCoreOwlRoot();
  const appSettings = new AppSettingsStore(owlRoot, options.dataDir);
  // One instance shared with the adapter: IntegrationStore keeps its config in memory, so a second one would not see saved changes.
  const integrationStore = new IntegrationStore(owlRoot, options.dataDir ?? resolveDataDir(owlRoot));
  // A built-in provider id never has a custom-settings entry; both callbacks
  // below use this to decide whether a provider needs any override at all.
  const isBuiltinProviderId = (normalized: string): boolean => builtinProviderHarness(normalized) !== null;
  const findCustomProvider = (providerId: string): CustomProviderConfig | undefined => {
    const normalized = providerId.trim().toLowerCase();
    return Object.entries(appSettings.getCustomProviders())
      .find(([id]) => id.trim().toLowerCase() === normalized)?.[1];
  };
  const enrichedOptions = {
    ...options,
    owlRoot,
    workspacesRoot: resolveWorkspacesRoot(process.env, homedir()),
    // Stub agents never read MCP servers or indexes, so the setup and rehearsal only run with real agents.
    ...(providerSelection(owlRoot).mode === "real"
      ? {
        workspaceTooling: {
          env: () => buildAgentEnv(process.env, { owlRoot, deny: customProviderApiKeyEnvNames(owlRoot) }),
          home: homedir(),
        },
      }
      : {}),
    ...(providerSelection(owlRoot).mode === "real" ? { postMergeCommand: { owlRootDefault: ["pnpm", "build"] } } : {}),
    ...(providerSelection(owlRoot).mode === "real" ? { planUsageSources: "default" as const } : {}),
    knowledgeStorage: knowledgeStorageOptions(appSettings),
    getTypesafeApiKey: () => appSettings.getTypesafeApiKey(),
    getAdvisorPersona: () => appSettings.getAdvisorPersona(),
    designSkill: configuredDesignSkill() ?? null,
    getAdvisorFolders: () => {
      const defaults = advisorFolderDefaults(options.dataDir ?? resolveDataDir(owlRoot));
      const sharedDir = appSettings.getAdvisorSharedDir() || defaults.sharedDir;
      try { ensureAdvisorSharedDir(sharedDir); } catch { /* prompt construction remains available */ }
      return { sharedDir, screenshotDir: appSettings.getAdvisorScreenshotDir() || defaults.screenshotDir };
    },
    getAdvisorSendFileSettings: () => appSettings.getAdvisorSendFileSettings(),
    getAdvisorFileDestinationSettings: () => ({
      ...appSettings.getAdvisorFileDestinationSettings(),
      integrations: integrationStore.list().flatMap((status) => status.provider === "slack" || status.provider === "discord"
        ? [{ provider: status.provider, configured: status.configured, conversationChannelIds: parseChannelIds(status.conversation_channel_id ?? undefined) }]
        : []),
    }),
    getAdvisorSharedDir: () => appSettings.getAdvisorSharedDir() || advisorFolderDefaults(options.dataDir ?? resolveDataDir(owlRoot)).sharedDir,
    knownModels: (harness: ModelHarness): ReadonlySet<string> | undefined =>
      harness === "codex" ? codexKnownModels() : harness === "opencode" ? opencodeKnownModels() : undefined,
    getProviderHarness: (providerId: string): ModelHarness | undefined => {
      const builtin = builtinProviderHarness(providerId.trim().toLowerCase());
      if (builtin) return builtin;
      const custom = findCustomProvider(providerId);
      return custom?.harnessId === "claude" || custom?.harnessId === "codex" || custom?.harnessId === "opencode" ? custom.harnessId : undefined;
    },
    // Same base-URL/API-key variables runner.ts's resolveOverrides sets for a
    // Worker/Manager/Reviewer run of this provider: read fresh so a Settings
    // change applies to the Advisor's next session, and empty for a built-in
    // provider, which always talks to its default endpoint.
    getProviderConnectionEnv: (providerId: string): Readonly<Record<string, string>> => {
      const normalized = providerId.trim().toLowerCase();
      if (isBuiltinProviderId(normalized)) return {};
      const custom = findCustomProvider(providerId);
      if (!custom) return {};
      return customProviderConnectionEnv(providerId, custom, process.env);
    },
  };
  let external: Core;
  try {
    external = loaded.createCore(enrichedOptions) as Core;
    if (!external || typeof external.start !== "function" || typeof external.stop !== "function" || typeof external.subscribe !== "function") {
      throw new Error("Core createCore returned an incompatible object");
    }
    // First start: store the language the OS locale implies (ja-JP -> "ja",
    // anything else -> "en"). A stored setting is never overwritten. This runs
    // before start() because start() spawns the resident Advisor session, whose
    // prompt embeds the language; storing it afterwards would make the first
    // turn look like a prompt change.
    await external.initializeLanguage?.(ownerLanguageFromLocale(Intl.DateTimeFormat().resolvedOptions().locale));
    await external.start();
  } catch (error) {
    throw externalError(error, "core startup");
  }
  return new ExternalCoreAdapter(
    external,
    options.db,
    owlRoot,
    options.dataDir ?? resolveDataDir(owlRoot),
    appSettings,
    { integrationStore },
  );
}
