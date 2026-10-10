import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveDataDir, serverPackageRoot } from "./contracts.js";
import { ApiError, humanUnexpectedMessage } from "./errors.js";
import { createUlid, isUlid, utcNow } from "./ids.js";
import type {
  AgentRun,
  AgentRunner,
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
  IntegrationConfig,
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
import type { GuardTokenAgent } from "../../../packages/shared/dist/guard-token.js";
import type { WebResearchCapture } from "../../../packages/shared/dist/web-research.js";
import type { ChildDispatchRequest, ChildDispatchResponse, ChildRunListFilter, ChildRunRecord, ChildRunSettings, ChildWaitRequest, ChildWaitResponse } from "../../../packages/shared/dist/child-runs.js";

import { IntegrationStore } from "./integration-store.js";
import { AppSettingsStore, type CustomProviderConfig } from "./app-settings-store.js";
import { AdvisorFolderError, advisorFolderDefaults, ensureAdvisorSharedDir, isGitIgnoredDirectory, normalizeAdvisorFolder } from "./advisor-folders.js";
import type { WorkSummaryRevision } from "../../../packages/core/dist/work-summary-history.js";
import { detectProcessSkillsPack } from "../../../packages/core/dist/process-skills-pack.js";
import { defaultOwlRoot as defaultCoreOwlRoot, resolveWorkspacesRoot } from "../../../packages/core/dist/workspace-layout.js";
import { buildAgentEnv } from "./agent-env.js";
import { customProviderApiKeyEnvNames } from "./agent-runner.js";
import { providerSelection } from "./provider-selection.js";
import {
  DEFAULT_KNOWLEDGE_AUTOMATION_SETTINGS,
  KnowledgeAutomationValidationError,
  validateKnowledgeAutomationSettings,
} from "../../../packages/shared/dist/knowledge-automation.js";
import type { KnowledgeAutomationSettings, KnowledgeAutomationSnapshot } from "../../../packages/shared/dist/knowledge-automation.js";
import {
  DEFAULT_OWNER_LANGUAGE,
  ownerLanguageFromLocale,
  type OwnerLanguage,
} from "../../../packages/shared/dist/owner-language.js";
import { builtinProviderHarness, CODEX_BUILTIN_MODELS, CODEX_PROVIDER_API_KEY_ENV, CODEX_PROVIDER_BASE_URL_ENV, DEFAULT_HARNESS_MODELS, DEFAULT_ROLE_MODELS, PROCESS_SKILLS_INSTALL_COMMANDS } from "../../../packages/shared/dist/index.js";
import { codexKnownModels, mergeOfficialModels } from "./model-catalog.js";
import { detectProviders, type BuiltinHarnessInfo, type BuiltinProviderInfo } from "./provider-detection.js";

function coreText(language: OwnerLanguage, ja: string, en: string): string {
  return language === "ja" ? ja : en;
}

interface StoredWork {
  id: string;
  display_number: number | null;
  title: string;
  state: WorkState;
  state_version: number;
  updated_at: string;
  archived_at: string | null;
  owner_id: string;
  project_id: string | null;
  summary: string;
  size: "small" | "normal" | "large";
  plan_revision: number;
  conversation_id: string | null;
  tasks: string[];
}

interface StoredTask extends TaskDetail {
  report: Report | null;
}

function page<T>(items: T[], limit: number, cursor: string | null): Page<T> {
  const offset = cursor === null ? 0 : Number.parseInt(cursor, 10);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ApiError(400, "invalid_query", "一覧のcursorが不正です。位置を確認して再試行してください。");
  }
  const data = items.slice(offset, offset + limit);
  const next = offset + data.length;
  return {
    data,
    cursor: next < items.length ? String(next) : null,
    has_more: next < items.length,
  };
}

function matchesFilter(value: string | null, expected: string): boolean {
  return value === null || value === expected;
}

const DEFAULT_MODEL_SETTINGS: readonly RoleModelSetting[] = Object.entries(DEFAULT_ROLE_MODELS).map(([role, setting]) => ({
  role: role as RoleModelSetting["role"],
  provider: setting.provider === "openai" ? "Codex" : "Anthropic",
  model: setting.model,
  effort: setting.effort,
  catalog_version: "1.0.0",
}));

function cloneModelPreset(preset: ModelPreset): ModelPreset {
  return { ...preset, roles: preset.roles.map((role) => ({ ...role })) };
}

function modelPresetCommandResult(response: ExternalCommandResponse): CommandResult<{ preset: ModelPreset; presets: ModelPreset[] }> {
  const data = response.data as { preset: ModelPreset; presets: readonly ModelPreset[] };
  return { data: { preset: cloneModelPreset(data.preset), presets: data.presets.map(cloneModelPreset) }, version: response.version };
}

function validateMemoryPresetName(value: unknown, presets: ModelPreset[], excludedId?: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length < 1 || name.length > 60 || presets.some((preset) => preset.id !== excludedId && preset.name.toLowerCase() === name.toLowerCase())) {
    throw new ApiError(400, "validation_error", "Model preset name must be unique and contain 1 to 60 characters.", { field: "name" });
  }
  return name;
}

function validateMemoryPresetRoles(input: RoleModelSettingInput[], previous: RoleModelSetting[]): RoleModelSetting[] {
  const expected = new Set(DEFAULT_MODEL_SETTINGS.map((role) => role.role));
  if (!Array.isArray(input) || input.length !== expected.size || new Set(input.map((role) => role.role)).size !== expected.size) {
    throw new ApiError(400, "validation_error", "Model preset roles must contain all eight roles exactly once.", { field: "roles" });
  }
  return input.map((role) => {
    if (!expected.has(role.role) || typeof role.provider !== "string" || !role.provider.trim() || typeof role.model !== "string" || !role.model.trim() || !["low", "medium", "high", "xhigh", "max"].includes(role.effort)) {
      throw new ApiError(400, "validation_error", "Model preset roles contain an invalid setting.", { field: "roles" });
    }
    if (builtinProviderHarness(role.provider.trim().toLowerCase()) === "codex" && !CODEX_BUILTIN_MODELS.includes(role.model.trim() as typeof CODEX_BUILTIN_MODELS[number])) {
      throw new ApiError(400, "validation_error", `Model ${role.model} is not available for ${role.provider}.`, { field: "roles" });
    }
    return { ...role, provider: role.provider.trim().toLowerCase(), catalog_version: previous.find((entry) => entry.role === role.role)?.catalog_version ?? "1.0.0" };
  });
}

const BUILTIN_HARNESSES: readonly BuiltinHarnessInfo[] = [
  { id: "claude", binaryName: "claude" },
  { id: "codex", binaryName: "codex" },
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
];

const BUILTIN_PROVIDER_EXTRAS: Readonly<Record<string, { defaultModel?: string }>> = {
  "anthropic": { defaultModel: DEFAULT_HARNESS_MODELS.claude },
  "openai": { defaultModel: DEFAULT_HARNESS_MODELS.codex },
};

function validateProcessSkillsSettings(input: ProcessSkillsSettingsInput): void {
  if (typeof input?.enabled !== "boolean" || (input.path !== null && typeof input.path !== "string")) {
    throw new ApiError(400, "validation_error", "Process skills settings must contain a boolean enabled value and a nullable path.", { field: "process_skills" });
  }
  if (input.path === null) return;
  if (input.path.length === 0 || !isAbsolute(input.path)) {
    throw new ApiError(400, "validation_error", "The process skills path must be an absolute path.", { field: "path" });
  }
  const detected = detectProcessSkillsPack({
    env: process.env,
    settings: { enabled: true, path: input.path },
    homedir: homedir(),
  });
  if (!detected || detected.source !== "setting") {
    throw new ApiError(400, "validation_error", "The process skills path must contain the required skill files.", { field: "path" });
  }
}

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

function detectProcessSkillsSettings(
  settings: ProcessSkillsSettingsInput,
  installCommands: ProcessSkillsInstallCommand[] = processSkillsInstallCommands(detectBuiltinProviders()),
): ProcessSkillsSettingsSnapshot {
  return {
    ...settings,
    detected: detectProcessSkillsPack({ env: process.env, settings, homedir: homedir() }),
    install_commands: installCommands,
  };
}

function validateKnowledgeAutomationSettingsInput(value: unknown): KnowledgeAutomationSettings {
  try {
    return validateKnowledgeAutomationSettings(value);
  } catch (error) {
    if (error instanceof KnowledgeAutomationValidationError) {
      throw new ApiError(400, "validation_error", error.message, { field: error.field });
    }
    throw error;
  }
}

function knowledgeAutomationSnapshot(settings: KnowledgeAutomationSettings): KnowledgeAutomationSnapshot {
  let timeZone = "local";
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    // Keep the design's fallback when the runtime cannot resolve the host zone.
  }
  return {
    ...settings,
    librarian_times: [...settings.librarian_times],
    next_librarian_run_at: null,
    next_skill_curation_run_at: null,
    next_rule_curation_run_at: null,
    time_zone: timeZone,
  };
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

export class MemoryCore implements CorePort {
  readonly ready = true;
  readonly advisorSessions: AdvisorSessionsPort = {
    getActiveSession: () => null,
  };
  private readonly works = new Map<string, StoredWork>();
  private readonly tasks = new Map<string, StoredTask>();
  private readonly decisions = new Map<string, Decision>();
  private readonly agents = new Map<string, AgentRun>();
  private readonly listeners = new Set<CoreEventListener>();
  private readonly eventLog: CoreEvent[] = [];
  private sequence = 0;
  private shuttingDown = false;
  private readonly projects = new Map<string, Project>();
  private readonly conversationMessages = new Map<string, Message[]>();
  private readonly uploads = new Map<string, { owner_id: string; input: InboundUploadRegisterInput; content?: Buffer; sha256?: string; mime?: string; status: "registered" | "receiving" | "stored" | "quarantined" }>();
  // MemoryCore (standalone mode) has no conversation registry of its own; any conversationId is
  // accepted lazily. The DB-backed Core in packages/core enforces FK existence and web-account resolution.
  private hybridMode = false;
  private language: OwnerLanguage = DEFAULT_OWNER_LANGUAGE;
  private processSkillsSettings: ProcessSkillsSettingsInput = { enabled: true, path: null };
  private knowledgeAutomationSettings: KnowledgeAutomationSettings = {
    ...DEFAULT_KNOWLEDGE_AUTOMATION_SETTINGS,
    librarian_times: [...DEFAULT_KNOWLEDGE_AUTOMATION_SETTINGS.librarian_times],
  };
  private advisorPersona = "";
  private advisorSharedDir = "";
  private advisorScreenshotDir = "";
  private modelSettings: { version: number; roles: RoleModelSetting[] } = {
    version: 0,
    roles: DEFAULT_MODEL_SETTINGS.map((role) => ({ ...role })),
  };
  private modelPresets: { version: number; presets: ModelPreset[] } = { version: 0, presets: [] };

  constructor(private readonly options: CreateCoreOptions) {}

  private readonly summaryRevisions = new Map<string, WorkSummaryRevision[]>();

  getWorkCoreActivity(workId: string): { work_id: string; activities: readonly never[] } {
    return { work_id: workId, activities: [] };
  }

  listWorkSummaryRevisions(workId: string): { work_id: string; truncated: false; revisions: readonly WorkSummaryRevision[] } {
    return { work_id: workId, truncated: false, revisions: this.summaryRevisions.get(workId) ?? [] };
  }

  /** Applies a Manager's rewrite of a Work summary and records the revision, like the real Core's replan path. */
  applyManagerWorkSummary(
    workId: string,
    summary: string,
    trigger: { kind: WorkSummaryRevision["trigger"]["kind"]; message_ids?: readonly string[]; text: string | null },
    agentRunId: string | null = null,
  ): void {
    const work = this.requireWork(workId);
    const before = { title: work.title, summary: work.summary };
    work.summary = summary;
    work.updated_at = utcNow();
    const revision: WorkSummaryRevision = {
      id: createUlid(),
      work_id: workId,
      actor: "manager",
      agent_run_id: agentRunId,
      trigger: { kind: trigger.kind, message_ids: trigger.message_ids ?? [], text: trigger.text },
      changed_fields: ["summary"],
      before,
      after: { title: work.title, summary },
      created_at: work.updated_at,
    };
    this.summaryRevisions.set(workId, [revision, ...(this.summaryRevisions.get(workId) ?? [])]);
    this.emit("work.updated", { work_id: workId, changed_fields: ["summary"], title: work.title });
  }

  get version(): string {
    return this.options.version;
  }

  status(): { services: readonly { name: string; state: string; pid: number | null }[]; mvp_scope: string; version: string } {
    return {
      services: [{ name: "owl-core", state: this.shuttingDown ? "stopping" : "running", pid: process.pid }],
      mvp_scope: "owl-core+rest+ws+static-web",
      version: this.version,
    };
  }

  async listWorks(query: { state: string | null; archived: "exclude" | "include" | "only"; limit: number; cursor: string | null }): Promise<Page<WorkSummary>> {
    const items = [...this.works.values()]
      .filter((work) => matchesFilter(query.state, work.state))
      .filter((work) => query.archived === "include" || (query.archived === "only" ? work.archived_at !== null : work.archived_at === null))
      .map((work) => this.toWorkSummary(work));
    return page(items, query.limit, query.cursor);
  }

  async createWork(input: WorkCreateInput, _command: CommandMeta): Promise<CommandResult<{
    work_id: string;
    state: "memo" | "ready";
    state_version: number;
  }>> {
    this.assertWritable();
    if (input.project_id !== null) {
      throw new ApiError(404, "project_not_found", "指定されたProjectが見つかりません。Projectを登録してから再試行してください。");
    }
    const id = createUlid();
    const now = utcNow();
    const work: StoredWork = {
      id,
      display_number: null,
      title: input.title,
      state: "memo",
      state_version: 0,
      updated_at: now,
      archived_at: null,
      owner_id: "owner:default",
      project_id: input.project_id,
      summary: input.summary,
      size: input.size,
      plan_revision: 0,
      conversation_id: null,
      tasks: [],
    };
    this.works.set(id, work);
    this.emit("work.ready", { work_id: id, state: work.state });
    return { data: { work_id: id, state: "memo", state_version: work.state_version }, version: work.state_version };
  }

  async getWork(workId: string): Promise<WorkDetail> {
    return this.toWorkDetail(this.requireWork(workId));
  }

  async getWorkBranchStatus(workId: string): Promise<WorkBranchStatus> {
    const work = this.requireWork(workId);
    return { work_id: workId, unmerged_changes: work.project_id === null ? "absent" : "unknown" };
  }

  async getWorkDesigns(workId: string): Promise<WorkDesignList> {
    this.requireWork(workId);
    return { designs: [] };
  }

  async getWorkConversation(workId: string, opts: { limit: number }): Promise<WorkConversation> {
    const conversationId = this.requireWork(workId).conversation_id;
    const all = conversationId ? this.conversationMessages.get(conversationId) ?? [] : [];
    const messages = all.slice(-opts.limit).map((m) => ({ ...m, received_at: m.created_at, instruction: null, in_reply_to: m.metadata?.in_reply_to ?? [] }));
    return { work_id: workId, conversation_id: conversationId ?? null, truncated: all.length > opts.limit, messages };
  }

  async getWorkDesign(workId: string, _taskId: string): Promise<WorkDesignDetail | null> {
    this.requireWork(workId);
    return null;
  }

  async startWork(workId: string, mode: "normal" | "small", command: CommandMeta): Promise<CommandResult<{
    work_id: string;
    state: "running";
    started: boolean;
  }>> {
    this.assertWritable();
    const work = this.requireWork(workId);
    this.assertVersion(work.state_version, command.expected_version);
    if (work.state !== "memo" && work.state !== "ready") {
      throw new ApiError(409, "invalid_state_transition", "このWorkは開始できない状態です。現在の状態を確認してから再試行してください。", { state: work.state });
    }
    const runner = this.options.agentRunner as Partial<AgentRunner>;
    if (typeof runner.start !== "function") {
      throw new ApiError(503, "dependency_unavailable", "Agent実行基盤の公開APIが利用できません。agent-runtimeのdistを確認してください。");
    }
    await runner.start(workId, mode);
    work.state = "running";
    work.state_version += 1;
    work.updated_at = utcNow();
    this.emit("work.started", { work_id: workId, state: work.state });
    return { data: { work_id: workId, state: "running", started: true }, version: work.state_version };
  }

  async pauseWork(workId: string, _reason: string, command: CommandMeta): Promise<CommandResult<{
    work_id: string;
    state: "paused";
    signal: "pause_requested";
  }>> {
    this.assertWritable();
    const work = this.requireWork(workId);
    this.assertVersion(work.state_version, command.expected_version);
    if (work.state !== "running") {
      throw new ApiError(409, "invalid_state_transition", "実行中のWorkだけ一時停止できます。現在の状態を確認してください。", { state: work.state });
    }
    work.state = "paused";
    work.state_version += 1;
    work.updated_at = utcNow();
    this.emit("work.paused", { work_id: workId, state: work.state });
    return { data: { work_id: workId, state: "paused", signal: "pause_requested" }, version: work.state_version };
  }

  async resumeWork(workId: string, command: CommandMeta): Promise<CommandResult<{
    work_id: string;
    state: "running";
  }>> {
    this.assertWritable();
    const work = this.requireWork(workId);
    this.assertVersion(work.state_version, command.expected_version);
    if (work.state !== "paused") {
      throw new ApiError(409, "invalid_state_transition", "一時停止中のWorkだけ再開できます。現在の状態を確認してください。", { state: work.state });
    }
    work.state = "running";
    work.state_version += 1;
    work.updated_at = utcNow();
    this.emit("work.resumed", { work_id: workId, state: work.state });
    return { data: { work_id: workId, state: "running" }, version: work.state_version };
  }

  async resumeWorkOrRetryDecision(workId: string, command: CommandMeta, body?: string): Promise<CommandResult<{
    work_id: string;
    state: "running" | "judgement_waiting";
    resumed_by: "resume" | "retry_decision";
    decision_id: string | null;
  }>> {
    if (this.requireWork(workId).state !== "paused") {
      throw new ApiError(409, "invalid_state_transition", "一時停止中のWorkだけ再開できます。現在の状態を確認してください。", { reason: "not_resumable" });
    }
    const response = await this.resumeWork(workId, command);
    return {
      data: { work_id: workId, state: response.data.state, resumed_by: "resume", decision_id: null },
      version: response.version,
    };
  }

  async cancelWork(workId: string, _reason: string, _force: boolean, command: CommandMeta): Promise<CommandResult<{
    work_id: string;
    state: "cancelled";
    cancel_requested: boolean;
  }>> {
    this.assertWritable();
    const work = this.requireWork(workId);
    this.assertVersion(work.state_version, command.expected_version);
    if (work.state === "completed" || work.state === "cancelled") {
      throw new ApiError(409, "invalid_state_transition", "完了済みのWorkは中止できません。現在の状態を確認してください。", { state: work.state });
    }
    work.state = "cancelled";
    work.state_version += 1;
    work.updated_at = utcNow();
    this.emit("work.cancelled", { work_id: workId, state: work.state });
    return { data: { work_id: workId, state: "cancelled", cancel_requested: true }, version: work.state_version };
  }

  async reopenWork(workId: string, _reason: string, command: CommandMeta): Promise<CommandResult<{
    work_id: string;
    state: "running";
  }>> {
    this.assertWritable();
    const work = this.requireWork(workId);
    this.assertVersion(work.state_version, command.expected_version);
    if (work.state !== "completed") {
      throw new ApiError(409, "invalid_state_transition", "完了状態のWorkだけ再開できます。", { state: work.state });
    }
    work.state = "running";
    work.state_version += 1;
    work.updated_at = utcNow();
    this.emit("work.reopened", { work_id: workId, state: work.state });
    return { data: { work_id: workId, state: "running" }, version: work.state_version };
  }

  async postWorkInstruction(workId: string, input: WorkInstructionInput, command: CommandMeta): Promise<CommandResult<WorkInstructionResult>> {
    this.assertWritable();
    const work = this.requireWork(workId);
    if (work.state === "memo" || work.state === "ready") {
      throw new ApiError(409, "invalid_state_transition", "Workを開始してから指示を送ってください。", { state: work.state });
    }
    if (work.state === "cancelled") throw new ApiError(409, "work_cancelled", "このWorkはキャンセルされているため指示を送れません。", { state: work.state });
    if (work.state === "completed") {
      if (input.reopen !== true) throw new ApiError(409, "work_reopen_required", "このWorkは完了しています。指示を送るには再開してください。", { state: work.state });
      await this.reopenWork(workId, input.body, command);
    }
    const conversationId = work.conversation_id ?? createUlid();
    work.conversation_id = conversationId;
    const posted = await this.postMessage(conversationId, { body: input.body, attachment_ids: input.attachment_ids ?? [] }, command);
    return { data: { work_id: workId, conversation_id: conversationId, message_id: posted.data.message_id, status: "queued" }, version: posted.version };
  }

  async updateWork(workId: string, input: { title?: string; summary?: string }, command: CommandMeta): Promise<CommandResult<{
    work_id: string;
    title: string;
    summary: string;
    state: WorkState;
    changed_fields: readonly ("title" | "summary")[];
    replan_queued: boolean;
  }>> {
    this.assertWritable();
    const work = this.requireWork(workId);
    this.assertVersion(work.state_version, command.expected_version);
    if (work.state === "completed" || work.state === "cancelled") {
      throw new ApiError(409, "invalid_state_transition", "完了またはキャンセル済みのWorkは編集できません。", { state: work.state });
    }
    const changed_fields: ("title" | "summary")[] = [];
    if (input.title !== undefined && input.title !== work.title) {
      work.title = input.title;
      changed_fields.push("title");
    }
    if (input.summary !== undefined && input.summary !== work.summary) {
      work.summary = input.summary;
      changed_fields.push("summary");
    }
    if (changed_fields.length > 0) {
      work.updated_at = utcNow();
      this.emit("work.updated", { work_id: workId, changed_fields, title: work.title });
    }
    return {
      data: { work_id: workId, title: work.title, summary: work.summary, state: work.state, changed_fields, replan_queued: false },
      version: work.state_version,
    };
  }

  async archiveWork(workId: string, command: CommandMeta): Promise<CommandResult<{ work_id: string; archived_at: string | null }>> {
    this.assertWritable();
    const work = this.requireWork(workId);
    this.assertVersion(work.state_version, command.expected_version);
    if (work.state !== "completed" && work.state !== "cancelled") {
      throw new ApiError(409, "invalid_state_transition", "完了またはキャンセル済みのWorkだけ操作できます。", { state: work.state });
    }
    const taskIds = new Set(work.tasks);
    if ([...this.agents.values()].some((run) => run.task_id !== null && taskIds.has(run.task_id) && ["launch_pending", "spawned", "running", "cancel_requested"].includes(run.status))) {
      throw new ApiError(409, "work_has_active_agents", "稼働中のAgentが残っているため操作できません。", { work_id: workId });
    }
    if ([...this.decisions.values()].some((decision) => decision.work_id === workId && decision.status === "open")) {
      throw new ApiError(409, "work_has_open_decisions", "未解決のDecisionが残っているため操作できません。", { work_id: workId });
    }
    if (work.archived_at === null) {
      work.archived_at = utcNow();
      this.emit("work.archived", { work_id: workId, archived_at: work.archived_at });
    }
    return { request_id: command.request_id, data: { work_id: workId, archived_at: work.archived_at }, version: work.state_version };
  }

  async unarchiveWork(workId: string, command: CommandMeta): Promise<CommandResult<{ work_id: string; archived_at: null }>> {
    this.assertWritable();
    const work = this.requireWork(workId);
    this.assertVersion(work.state_version, command.expected_version);
    if (work.state !== "completed" && work.state !== "cancelled") {
      throw new ApiError(409, "invalid_state_transition", "完了またはキャンセル済みのWorkだけ操作できます。", { state: work.state });
    }
    if (work.archived_at !== null) {
      work.archived_at = null;
      this.emit("work.unarchived", { work_id: workId, archived_at: null });
    }
    return { request_id: command.request_id, data: { work_id: workId, archived_at: null }, version: work.state_version };
  }

  async deleteWork(workId: string, command: CommandMeta): Promise<CommandResult<{ work_id: string; deleted: true }>> {
    this.assertWritable();
    const work = this.requireWork(workId);
    this.assertVersion(work.state_version, command.expected_version);
    if (work.state !== "completed" && work.state !== "cancelled") {
      throw new ApiError(409, "invalid_state_transition", "完了またはキャンセル済みのWorkだけ操作できます。", { state: work.state });
    }
    const taskIds = new Set(work.tasks);
    if ([...this.agents.values()].some((run) => run.task_id !== null && taskIds.has(run.task_id) && ["launch_pending", "spawned", "running", "cancel_requested"].includes(run.status))) {
      throw new ApiError(409, "work_has_active_agents", "稼働中のAgentが残っているため削除できません。", { work_id: workId });
    }
    if ([...this.decisions.values()].some((decision) => decision.work_id === workId && decision.status === "open")) {
      throw new ApiError(409, "work_has_open_decisions", "未解決のDecisionが残っているため削除できません。", { work_id: workId });
    }
    for (const taskId of taskIds) this.tasks.delete(taskId);
    for (const [runId, run] of this.agents) if (run.task_id !== null && taskIds.has(run.task_id)) this.agents.delete(runId);
    for (const [decisionId, decision] of this.decisions) if (decision.work_id === workId) this.decisions.delete(decisionId);
    this.works.delete(workId);
    for (let i = this.eventLog.length - 1; i >= 0; i--) if (this.eventLog[i].work_id === workId) this.eventLog.splice(i, 1);
    return { request_id: command.request_id, data: { work_id: workId, deleted: true }, version: work.state_version };
  }

  async listTasks(workId: string, query: { status: string | null; limit: number; cursor: string | null }): Promise<Page<TaskSummary>> {
    const work = this.requireWork(workId);
    const items = work.tasks
      .map((taskId) => this.tasks.get(taskId))
      .filter((task): task is StoredTask => task !== undefined)
      .filter((task) => matchesFilter(query.status, task.status))
      .map((task) => this.toTaskSummary(task));
    return page(items, query.limit, query.cursor);
  }

  async getTask(taskId: string, includeReport: boolean): Promise<{ data: TaskDetail; report: Report | null; version: number }> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new ApiError(404, "task_not_found", "指定されたTaskが見つかりません。IDを確認して再試行してください.");
    }
    return { data: this.toTaskDetail(task), report: includeReport ? task.report : null, version: task.state_version };
  }

  async listDecisions(query: { status: "open" | "resolved" | "cancelled"; limit: number; cursor: string | null }): Promise<Page<Decision>> {
    const items = [...this.decisions.values()].filter((decision) => decision.status === query.status);
    return page(items, query.limit, query.cursor);
  }

  async answerDecision(decisionId: string, _input: { answer: string; option_key: string | null; source: "web" | "slack" | "discord" | "advisor"; source_message_id: string | null }, command: CommandMeta): Promise<CommandResult<{
    decision_id: string;
    status: "resolved";
    winner: boolean;
    resumed_task_ids: string[];
  }>> {
    this.assertWritable();
    const decision = this.decisions.get(decisionId);
    if (!decision) {
      throw new ApiError(404, "decision_not_found", "指定されたDecisionが見つかりません。IDを確認して再試行してください。");
    }
    this.assertVersion(decision.state_version, command.expected_version);
    if (decision.status !== "open") {
      throw new ApiError(409, "decision_already_resolved", "この判断はすでに回答済みです。現在の回答を確認してください。");
    }
    if (_input.option_key === null && decision.allow_free_text !== true) {
      throw new ApiError(400, "validation_error", "このDecisionは自由記述の回答を許可していません。保存済みの選択肢を指定してください。", {
        decision_id: decision.id,
        allow_free_text: false,
      });
    }
    if (_input.option_key !== null) {
      const selected = decision.options.find((option) => option.key === _input.option_key);
      if (!selected) {
        throw new ApiError(400, "validation_error", "選択されたDecision optionが保存済みの選択肢にありません。", {
          decision_id: decision.id,
          option_key: _input.option_key,
        });
      }
      if (_input.answer !== selected.label) {
        throw new ApiError(400, "validation_error", "answerは選択したoptionのlabelと一致させてください。", {
          decision_id: decision.id,
          option_key: _input.option_key,
        });
      }
    }
    decision.status = "resolved";
    decision.state_version += 1;
    this.emit("decision.resolved", { decision_id: decisionId, status: decision.status });
    return { data: { decision_id: decisionId, status: "resolved", winner: true, resumed_task_ids: decision.blocked_task_ids }, version: decision.state_version };
  }

  async listAgents(query: { status: string | null; work_id: string | null; limit: number; cursor: string | null }): Promise<Page<AgentRun>> {
    const runs = [...this.agents.values()];
    const items = runs.filter((agent) => matchesFilter(query.status, agent.status));
    if (query.work_id !== null) {
      const work = this.works.get(query.work_id);
      if (!work) return page([], query.limit, query.cursor);

      const taskWorkIds = new Map<string, string>();
      for (const candidate of this.works.values()) {
        for (const taskId of candidate.tasks) taskWorkIds.set(taskId, candidate.id);
      }
      const runsById = new Map(runs.map((agent) => [agent.id, agent]));
      const workMembership = new Map<string, boolean>();
      const belongsToWork = (agent: AgentRun, ancestors = new Set<string>()): boolean => {
        const cached = workMembership.get(agent.id);
        if (cached !== undefined) return cached;
        if (ancestors.has(agent.id)) return false;

        if (agent.task_id !== null) {
          const taskWorkId = taskWorkIds.get(agent.task_id);
          if (taskWorkId !== undefined) {
            const belongs = taskWorkId === work.id;
            workMembership.set(agent.id, belongs);
            return belongs;
          }
        }

        ancestors.add(agent.id);
        const parent = agent.parent_agent_id === null ? undefined : runsById.get(agent.parent_agent_id);
        const belongs = parent !== undefined && belongsToWork(parent, ancestors);
        ancestors.delete(agent.id);
        workMembership.set(agent.id, belongs);
        return belongs;
      };

      return page(items.filter((agent) => belongsToWork(agent)), query.limit, query.cursor);
    }
    return page(items, query.limit, query.cursor);
  }

  async cancelAgent(agentRunId: string, _reason: string, force: boolean, command: CommandMeta): Promise<CommandResult<{
    agent_run_id: string;
    status: "cancel_requested" | "cancelled";
  }>> {
    this.assertWritable();
    const agent = this.agents.get(agentRunId);
    if (!agent) {
      throw new ApiError(404, "agent_run_not_found", "指定されたAgent Runが見つかりません。IDを確認して再試行してください。");
    }
    if (agent.status === "completed" || agent.status === "failed" || agent.status === "cancelled") {
      throw new ApiError(409, "invalid_state_transition", "終了済みのAgent Runは中止できません。現在の状態を確認してください。", { status: agent.status });
    }
    const status: "cancel_requested" | "cancelled" = force ? "cancelled" : "cancel_requested";
    agent.status = status;
    if (agent.pid !== null) {
      try {
        process.kill(agent.pid, force ? "SIGKILL" : "SIGTERM");
      } catch {
        // Best-effort: the process may already have exited.
      }
    }
    if (force) {
      agent.ended_at = utcNow();
    }
    this.emit("agent.cancelled", { agent_run_id: agentRunId, status });
    return { data: { agent_run_id: agentRunId, status }, version: command.expected_version };
  }

  async listProjects(query: { limit: number; cursor: string | null }): Promise<Page<Project>> {
    return page([...this.projects.values()], query.limit, query.cursor);
  }

  // TODO: Implement artifact persistence for standalone MemoryCore; production Core reads artifacts from the database.
  listArtifacts(_workId: string): Array<{ id: string; work_id: string; task_id: string | null; path: string; kind: string; created_at: string }> {
    return [];
  }

  async createProject(input: CreateProjectInput, _command: CommandMeta): Promise<{ data: Project; version: number }> {
    this.assertWritable();
    for (const existing of this.projects.values()) {
      if (existing.canonical_path === input.canonical_path) {
        throw new ApiError(409, "project_path_conflict", "指定されたcanonical_pathには既にProjectが存在します。既存のProjectを利用するか、別のパスを指定してください。", { canonical_path: input.canonical_path });
      }
    }
    const id = createUlid();
    const project: Project = {
      id,
      name: input.name,
      canonical_path: input.canonical_path,
      base_branch: input.base_branch,
      auto_push: false,
      worktree_setup_command: [],
      worktree_refresh_command: [],
      post_merge_command: input.post_merge_command ? [...input.post_merge_command] : null,
      post_merge_install_command: input.post_merge_install_command ? [...input.post_merge_install_command] : null,
      required_test_command: input.required_test_command?.length ? [...input.required_test_command] : null,
      test_run: input.test_run ?? null,
      allowed_roots: [...input.allowed_roots],
      verification_plan: input.verification_plan.map((command) => ({ ...command })),
    };
    this.projects.set(id, project);
    this.emit("project.created", { project_id: id });
    return { data: project, version: 0 };
  }

  async updateProject(projectId: string, input: UpdateProjectInput, _command: CommandMeta): Promise<{ data: Project; version: number }> {
    this.assertWritable();
    const project = this.projects.get(projectId);
    if (!project) throw new ApiError(404, "project_not_found", "指定されたProjectが見つかりません。Project一覧を再読み込みしてください。", { resource: "project", id: projectId });
    const name = input.name?.trim() ?? project.name;
    const canonicalPath = input.canonical_path ?? project.canonical_path;
    const autoPush = input.auto_push ?? project.auto_push;
    const setupCommand = input.worktree_setup_command ?? project.worktree_setup_command;
    const refreshCommand = input.worktree_refresh_command ?? project.worktree_refresh_command;
    const postMerge = input.post_merge_command !== undefined ? input.post_merge_command : project.post_merge_command;
    const postMergeInstall = input.post_merge_install_command !== undefined ? input.post_merge_install_command : project.post_merge_install_command;
    const requiredTest = input.required_test_command !== undefined ? input.required_test_command : project.required_test_command;
    const testRun = input.test_run !== undefined ? input.test_run : project.test_run;
    if (
      name === project.name
      && canonicalPath === project.canonical_path
      && autoPush === project.auto_push
      && JSON.stringify(setupCommand) === JSON.stringify(project.worktree_setup_command)
      && JSON.stringify(refreshCommand) === JSON.stringify(project.worktree_refresh_command)
      && JSON.stringify(postMerge) === JSON.stringify(project.post_merge_command)
      && JSON.stringify(postMergeInstall) === JSON.stringify(project.post_merge_install_command)
      && JSON.stringify(requiredTest) === JSON.stringify(project.required_test_command)
      && JSON.stringify(testRun) === JSON.stringify(project.test_run)
    ) return { data: project, version: 0 };
    for (const existing of this.projects.values()) {
      if (existing.id !== projectId && existing.canonical_path === canonicalPath) {
        throw new ApiError(400, "validation_error", "指定されたcanonical_pathには既にProjectが存在します。別のパスを指定してください。", { canonical_path: canonicalPath, project_id: existing.id });
      }
    }
    const allowedRoots = input.canonical_path === undefined
      ? project.allowed_roots
      : [...new Set([canonicalPath, ...project.allowed_roots.filter((path) => path !== project.canonical_path)])];
    const updated: Project = {
      ...project,
      name,
      canonical_path: canonicalPath,
      base_branch: input.canonical_path === undefined ? project.base_branch : input.base_branch ?? project.base_branch,
      auto_push: autoPush,
      worktree_setup_command: [...setupCommand],
      worktree_refresh_command: [...refreshCommand],
      post_merge_command: postMerge === null ? null : [...postMerge],
      post_merge_install_command: postMergeInstall === null ? null : [...postMergeInstall],
      required_test_command: requiredTest === null || requiredTest.length === 0 ? null : [...requiredTest],
      test_run: testRun,
      allowed_roots: allowedRoots,
    };
    this.projects.set(projectId, updated);
    this.emit("project.updated", { project_id: projectId });
    return { data: updated, version: 0 };
  }

  async getProjectDeletionImpact(projectId: string): Promise<ProjectDeletionImpact> {
    if (!this.projects.has(projectId)) throw new ApiError(404, "project_not_found", "指定されたProjectが見つかりません。Project一覧を再読み込みしてください。", { resource: "project", id: projectId });
    return {
      project_id: projectId,
      work_count: 0,
      running_work_count: 0,
      active_agent_count: 0,
      backlog_item_count: 0,
      running_works: [],
      blockers: [],
      deletable: true,
    };
  }

  async deleteProject(projectId: string, input: DeleteProjectInput, _command: CommandMeta): Promise<{ data: DeleteProjectResult; version: number }> {
    this.assertWritable();
    if (!this.projects.has(projectId)) throw new ApiError(404, "project_not_found", "指定されたProjectが見つかりません。Project一覧を再読み込みしてください。", { resource: "project", id: projectId });
    const impact = await this.getProjectDeletionImpact(projectId);
    if (input.confirmed_work_count !== impact.work_count) {
      throw new ApiError(409, "project_deletion_impact_changed", "確認後にこのProjectのWork数が変わりました。", { project_id: projectId, confirmed_work_count: input.confirmed_work_count, impact });
    }
    this.projects.delete(projectId);
    this.emit("project.deleted", { project_id: projectId });
    return { data: { project_id: projectId, deleted: true, detached_work_count: 0, detached_backlog_item_count: 0, detached_works: [] }, version: 0 };
  }

  async getModelSettings(): Promise<{ version: number; roles: RoleModelSetting[] }> {
    return { version: this.modelSettings.version, roles: this.modelSettings.roles.map((role) => ({ ...role })) };
  }

  async updateModelSettings(input: { roles: RoleModelSettingInput[] }, command: CommandMeta): Promise<CommandResult<{ roles: RoleModelSetting[] }>> {
    this.assertWritable();
    this.assertVersion(this.modelSettings.version, command.expected_version);
    const previousByRole = new Map(this.modelSettings.roles.map((role) => [role.role, role]));
    const roles = input.roles.map((role) => ({
      ...role,
      catalog_version: previousByRole.get(role.role)?.catalog_version ?? "1.0.0",
    }));
    this.modelSettings = { version: this.modelSettings.version + 1, roles };
    this.emit("settings.model_updated", {});
    return { data: { roles: roles.map((role) => ({ ...role })) }, version: this.modelSettings.version };
  }

  async getModelPresets(): Promise<{ version: number; presets: ModelPreset[] }> {
    return { version: this.modelPresets.version, presets: this.modelPresets.presets.map(cloneModelPreset) };
  }

  async createModelPreset(input: { name: string; roles: RoleModelSettingInput[] }, command: CommandMeta): Promise<CommandResult<{ preset: ModelPreset; presets: ModelPreset[] }>> {
    this.assertWritable();
    this.assertVersion(this.modelPresets.version, command.expected_version);
    if (this.modelPresets.presets.length >= 20) throw new ApiError(400, "validation_error", "Model presets are limited to 20.", { field: "presets" });
    const name = validateMemoryPresetName(input.name, this.modelPresets.presets);
    const roles = validateMemoryPresetRoles(input.roles, this.modelSettings.roles);
    const now = utcNow();
    const preset = { id: createUlid(), name, roles, created_at: now, updated_at: now };
    this.modelPresets.presets.push(preset);
    this.modelPresets.version += 1;
    this.emit("settings.model_presets_updated", {});
    return { data: { preset: cloneModelPreset(preset), presets: this.modelPresets.presets.map(cloneModelPreset) }, version: this.modelPresets.version };
  }

  async updateModelPreset(id: string, input: { name?: string; roles?: RoleModelSettingInput[] }, command: CommandMeta): Promise<CommandResult<{ preset: ModelPreset; presets: ModelPreset[] }>> {
    this.assertWritable();
    this.assertVersion(this.modelPresets.version, command.expected_version);
    const index = this.modelPresets.presets.findIndex((preset) => preset.id === id);
    if (index < 0) throw new ApiError(404, "model_preset_not_found", `Model preset ${id} was not found.`);
    if (input.name === undefined && input.roles === undefined) throw new ApiError(400, "validation_error", "Provide a name or roles to update.");
    const previous = this.modelPresets.presets[index]!;
    const name = input.name === undefined ? previous.name : validateMemoryPresetName(input.name, this.modelPresets.presets, id);
    const roles = input.roles === undefined ? previous.roles : validateMemoryPresetRoles(input.roles, previous.roles);
    const preset = { ...previous, name, roles, updated_at: utcNow() };
    this.modelPresets.presets[index] = preset;
    this.modelPresets.version += 1;
    this.emit("settings.model_presets_updated", {});
    return { data: { preset: cloneModelPreset(preset), presets: this.modelPresets.presets.map(cloneModelPreset) }, version: this.modelPresets.version };
  }

  async deleteModelPreset(id: string, command: CommandMeta): Promise<CommandResult<{ presets: ModelPreset[] }>> {
    this.assertWritable();
    this.assertVersion(this.modelPresets.version, command.expected_version);
    const index = this.modelPresets.presets.findIndex((preset) => preset.id === id);
    if (index < 0) throw new ApiError(404, "model_preset_not_found", `Model preset ${id} was not found.`);
    this.modelPresets.presets.splice(index, 1);
    this.modelPresets.version += 1;
    this.emit("settings.model_presets_updated", {});
    return { data: { presets: this.modelPresets.presets.map(cloneModelPreset) }, version: this.modelPresets.version };
  }

  async listMessages(conversationId: string, query: { limit: number; cursor: string | null }): Promise<Page<Message>> {
    const messages = this.conversationMessages.get(conversationId);
    if (!messages) {
      throw new ApiError(404, "conversation_not_found", "指定されたConversationが見つかりません。IDを確認して再試行してください。");
    }
    return page(messages, query.limit, query.cursor);
  }

  async ingestConversation(_conversationId: string): Promise<{ path: string }> {
    throw new ApiError(503, "dependency_unavailable", "スタンドアロンモードではKnowledge ingestionを利用できません。外部Coreモードで起動してください。");
  }

  async postMessage(conversationId: string, input: PostMessageInput, _command: CommandMeta): Promise<CommandResult<{ message_id: string; advisor_run_id: string | null }>> {
    this.assertWritable();
    const messages = this.conversationMessages.get(conversationId) ?? [];
    const message: Message = {
      id: createUlid(),
      conversation_id: conversationId,
      source: "web",
      body: input.body,
      attachment_ids: [...input.attachment_ids],
      created_at: utcNow(),
    };
    messages.push(message);
    this.conversationMessages.set(conversationId, messages);
    this.emit("message.posted", { conversation_id: conversationId, message_id: message.id });
    return { data: { message_id: message.id, advisor_run_id: null }, version: messages.length };
  }

  async ingestInbound(ownerId: string, input: InboundMessageInput, command: CommandMeta): Promise<CommandResult<InboundMessageResult>> {
    const conversationId = `${input.provider}:${input.conversation_hint.thread_ref ?? input.thread_id ?? input.channel_id}`;
    const result = await this.postMessage(conversationId, { body: input.text, attachment_ids: input.attachment_ids }, command);
    void this.advisorRespond(conversationId, result.data.message_id, {
      channel: input.provider,
      channel_id: input.channel_id,
      ref: input.conversation_hint.thread_ref ?? input.thread_id ?? undefined,
    });
    return {
      data: {
        request_id: command.request_id,
        ack_id: createUlid(),
        message_id: result.data.message_id,
        event_id: null,
        deduplicated: false,
        status: "accepted",
        conversation_id: conversationId,
        advisor_run_id: null,
      },
      version: result.version,
    };
  }

  async ensureConnectorAccount(_ownerId: string, _provider: "slack" | "discord", accountId: string): Promise<string> {
    return accountId;
  }

  async registerInboundUpload(ownerId: string, input: InboundUploadRegisterInput, _command: CommandMeta): Promise<CommandResult<InboundUploadTicket>> {
    const uploadId = createUlid();
    // MemoryCore has no real conversations table: a hint synthesizes the
    // same kind of id ingestInbound() would land the eventual message in
    // (see line ~500), so an upload registered ahead of its message still
    // groups with it once the message arrives.
    const conversationId = input.conversation_id
      ?? `${input.provider}:${input.conversation_hint?.thread_ref ?? input.conversation_hint?.dm_ref ?? uploadId}`;
    const ticket: InboundUploadTicket = { upload_id: uploadId, put_path: `/api/v1/inbound/uploads/${uploadId}/content`, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), max_bytes: 50 * 1024 * 1024, conversation_id: conversationId };
    this.uploads.set(uploadId, { owner_id: ownerId, input, status: "registered" });
    return { data: ticket, version: 0 };
  }

  async putInboundUpload(ownerId: string, uploadId: string, input: { content: Buffer; sha256: string; mime: string }): Promise<InboundUploadContentResult> {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.owner_id !== ownerId) throw new ApiError(404, "not_found", "指定されたuploadが見つかりません。");
    if (upload.input.declared_bytes !== input.content.byteLength) throw new ApiError(400, "validation_error", "uploaded bytesがdeclared_bytesと一致しません。");
    const digest = createHash("sha256").update(input.content).digest("hex");
    if (digest !== input.sha256) throw new ApiError(409, "upload_checksum_mismatch", "upload checksumが一致しません。");
    upload.content = input.content;
    upload.sha256 = digest;
    upload.mime = input.mime;
    upload.status = "receiving";
    return { upload_id: uploadId, bytes: input.content.byteLength, sha256: digest, status: "receiving" };
  }

  async completeInboundUpload(ownerId: string, uploadId: string, input: InboundUploadCompleteInput, _command: CommandMeta): Promise<CommandResult<InboundUploadCompleteResult>> {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.owner_id !== ownerId || !upload.content || upload.status !== "receiving") throw new ApiError(404, "not_found", "指定されたuploadが見つかりません。");
    if (upload.content.byteLength !== input.bytes || upload.sha256 !== input.sha256) throw new ApiError(409, "upload_checksum_mismatch", "upload checksumが一致しません。");
    const artifactId = createUlid();
    const status = /(?:x-executable|x-dosexec|x-shellscript)/iu.test(input.mime) ? "quarantined" : "stored";
    upload.status = status;
    return { data: { upload_id: uploadId, artifact_id: artifactId, status, sha256: input.sha256, bytes: input.bytes, mime: input.mime }, version: 0 };
  }

  async advisorRespond(conversationId: string, _messageId: string, origin?: AdvisorOrigin): Promise<void> {
    const messages = this.conversationMessages.get(conversationId) ?? [];
    if (messages.length === 0) return;
    const advisorReply: Message = {
      id: createUlid(),
      conversation_id: conversationId,
      source: "advisor",
      body: "This is a stub advisor response.",
      attachment_ids: [],
      created_at: utcNow(),
    };
    messages.push(advisorReply);
    this.conversationMessages.set(conversationId, messages);
    this.emit("advisor.responded", {
      conversation_id: conversationId,
      message_id: advisorReply.id,
      origin: origin ?? { channel: "web" },
    });
  }

  async restartAdvisorSession(_ownerId: string): Promise<void> {
    // Standalone mode has no persistent Advisor runtime or session ledger.
  }

  async getHybridMode(): Promise<boolean> {
    return this.hybridMode;
  }

  async setHybridMode(enabled: boolean): Promise<boolean> {
    this.hybridMode = enabled;
    return enabled;
  }

  async getLanguage(): Promise<OwnerLanguage> {
    return this.language;
  }

  async setLanguage(language: OwnerLanguage): Promise<OwnerLanguage> {
    this.language = language;
    return language;
  }

  async recordAgentResearch(
    _agent: GuardTokenAgent,
    _capture: WebResearchCapture,
  ): Promise<{ readonly accepted: boolean; readonly reason?: string }> {
    return { accepted: false, reason: "unavailable" };
  }

  async getProcessSkillsSettings(): Promise<ProcessSkillsSettingsSnapshot> {
    return detectProcessSkillsSettings(this.processSkillsSettings);
  }

  async setProcessSkillsSettings(input: ProcessSkillsSettingsInput): Promise<ProcessSkillsSettingsSnapshot> {
    validateProcessSkillsSettings(input);
    this.processSkillsSettings = { enabled: input.enabled, path: input.path };
    return detectProcessSkillsSettings(this.processSkillsSettings);
  }

  async getKnowledgeAutomationSettings(): Promise<KnowledgeAutomationSnapshot> {
    return knowledgeAutomationSnapshot(this.knowledgeAutomationSettings);
  }

  async setKnowledgeAutomationSettings(input: KnowledgeAutomationSettings): Promise<KnowledgeAutomationSnapshot> {
    this.knowledgeAutomationSettings = validateKnowledgeAutomationSettingsInput(input);
    return knowledgeAutomationSnapshot(this.knowledgeAutomationSettings);
  }

  async getTypesafeApiKey(): Promise<string> {
    return "";
  }

  async setTypesafeApiKey(key: string): Promise<string> {
    return key;
  }

  async getAdvisorPersona(): Promise<string> {
    return this.advisorPersona;
  }

  async setAdvisorPersona(persona: string): Promise<string> {
    this.advisorPersona = persona;
    return persona;
  }

  async getAdvisorFolders(): Promise<import("./types.js").AdvisorFoldersSnapshot> {
    const defaults = advisorFolderDefaults(this.options.dataDir ?? resolveDataDir(this.options.owlRoot ?? defaultCoreOwlRoot()));
    return { shared_dir: this.advisorSharedDir || defaults.sharedDir, screenshot_dir: this.advisorScreenshotDir || defaults.screenshotDir,
      defaults: { shared_dir: defaults.sharedDir, screenshot_dir: defaults.screenshotDir },
      custom: { shared_dir: !!this.advisorSharedDir, screenshot_dir: !!this.advisorScreenshotDir } };
  }

  async setAdvisorFolders(sharedDir: string, screenshotDir: string): Promise<import("./types.js").AdvisorFoldersSnapshot> {
    const shared = normalizeAdvisorFolder(sharedDir);
    const screenshot = normalizeAdvisorFolder(screenshotDir);
    const defaults = advisorFolderDefaults(this.options.dataDir ?? resolveDataDir(this.options.owlRoot ?? defaultCoreOwlRoot()));
    if (!isGitIgnoredDirectory(shared || defaults.sharedDir)) throw new AdvisorFolderError("tracked");
    ensureAdvisorSharedDir(shared || defaults.sharedDir);
    this.advisorSharedDir = shared;
    this.advisorScreenshotDir = screenshot;
    return this.getAdvisorFolders();
  }

  async clearConversation(conversationId: string): Promise<{ cleared: boolean }> {
    const existed = this.conversationMessages.has(conversationId);
    if (existed) {
      this.conversationMessages.set(conversationId, []);
    }
    return { cleared: existed };
  }

  private activeConversationId: string | null = null;

  async getActiveConversation(): Promise<{ conversation_id: string }> {
    if (!this.activeConversationId) {
      this.activeConversationId = createUlid();
    }
    return { conversation_id: this.activeConversationId };
  }

  async listProviders(): Promise<DetectedProvider[]> {
    return [];
  }

  async listProviderPauses(): Promise<ProviderPauseView[]> {
    return [];
  }

  async resumeProviderPause(provider: string): Promise<ProviderPauseView | null> {
    throw new ApiError(404, "provider_pause_not_found", `プロバイダーの一時停止が見つかりません。 / The provider pause was not found: ${provider}`);
  }

  async getProvider(_id: string): Promise<ProviderConfigRecord | null> {
    return null;
  }

  async saveProvider(id: string, input: SaveProviderInput): Promise<ProviderConfigRecord> {
    if (input.displayName.trim().length === 0) {
      throw new ApiError(400, "validation_error", "displayNameは空にできません。Provider名を指定してください。");
    }
    return { id, ...input, isBuiltin: false };
  }

  async deleteProvider(_id: string): Promise<{ deleted: boolean }> {
    return { deleted: false };
  }

  async testProvider(_id: string): Promise<{ ok: boolean; detail: string }> {
    return { ok: false, detail: coreText(this.language, "スタンドアロンモードでは接続テストを実行できません。外部コアモードで起動してください。", "Connection tests are unavailable in standalone mode. Start Owl in external Core mode.") };
  }

  async getProviderModels(): Promise<Record<string, string[]>> { return {}; }

  async setProviderModels(_providerId: string, models: string[]): Promise<string[]> { return [...models]; }

    async getIntegrations(): Promise<IntegrationStatus[]> {
    return [];
  }

  async saveIntegration(_provider: IntegrationProvider, _config: IntegrationConfigPatch, _command: CommandMeta): Promise<{ data: IntegrationStatus; version: number }> {
    throw new ApiError(503, "dependency_unavailable", "スタンドアロンモードでは連携設定を保存できません。外部コアモードで起動してください。");
  }

  async testIntegration(_provider: IntegrationProvider): Promise<IntegrationTestResult> {
    throw new ApiError(503, "dependency_unavailable", "スタンドアロンモードでは接続テストを実行できません。外部コアモードで起動してください。");
  }

  async deleteIntegration(_provider: IntegrationProvider, _command: CommandMeta): Promise<{ data: { provider: string }; version: number }> {
    throw new ApiError(503, "dependency_unavailable", "スタンドアロンモードでは連携設定を削除できません。外部コアモードで起動してください。");
  }

  subscribe(listener: CoreEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  eventsAfter(cursor: number, limit?: number): CoreEvent[] {
    return latestEvents(this.eventLog.filter((event) => event.sequence > cursor), limit);
  }

  eventsBefore(before: number | null, limit: number): CoreEvent[] {
    const older = (before === null ? this.eventLog : this.eventLog.filter((event) => event.sequence < before)).filter(isActivityEvent);
    return newestFirst(older, limit);
  }

  oldestEventSequence(): number | null {
    return this.eventLog[0]?.sequence ?? null;
  }

  latestEventCursor(): string {
    return this.eventLog.at(-1)?.cursor ?? "0";
  }

  activeAgentCount(): number {
    const runner = this.options.agentRunner as Partial<AgentRunner>;
    return typeof runner.activeCount === "function" ? runner.activeCount() : 0;
  }

  async shutdown(options: { force: boolean; timeoutMs: number }): Promise<void> {
    this.shuttingDown = true;
    const deadline = Date.now() + options.timeoutMs;
    while (!options.force && this.activeAgentCount() > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    if (!options.force && this.activeAgentCount() > 0) {
      throw new ApiError(409, "core_not_ready", "稼働中のAgentが終了するまで停止を待機しましたが、まだ残っています。--forceで再実行できます。");
    }
    const runner = this.options.agentRunner as Partial<AgentRunner>;
    if (typeof runner.stopAll === "function") {
      await runner.stopAll(options.force);
    }
    const candidate = this.options.db as { close?: () => void } | null;
    if (candidate && typeof candidate.close === "function") {
      candidate.close();
    }
  }

  private assertWritable(): void {
    if (this.shuttingDown) {
      throw new ApiError(503, "core_not_ready", "サーバーは停止処理中です。停止完了後に再試行してください。");
    }
  }

  private assertVersion(current: number, expected: number): void {
    if (current !== expected) {
      throw new ApiError(409, "version_conflict", "状態が更新されています。最新の状態を取得してから再試行してください。", { expected_version: expected, current_version: current });
    }
  }

  private requireWork(workId: string): StoredWork {
    const work = this.works.get(workId);
    if (!work) {
      throw new ApiError(404, "work_not_found", "指定されたWorkが見つかりません。IDを確認して再試行してください。");
    }
    return work;
  }

  private toWorkSummary(work: StoredWork): WorkSummary {
    const { id, display_number, title, state, state_version, updated_at, archived_at, project_id } = work;
    return { id, display_number, title, state, state_version, updated_at, archived_at, project_id };
  }

  private toWorkDetail(work: StoredWork): WorkDetail {
    const { tasks: taskIds, ...detail } = work;
    const taskStates = taskIds.map((taskId) => this.tasks.get(taskId)?.status);
    return { ...detail, progress: progressFromTaskStates(work.id, taskStates) };
  }

  private toTaskSummary(task: StoredTask): TaskSummary {
    const { id, work_id, title, status, type, state_version, updated_at } = task;
    return { id, work_id, title, status, type, state_version, updated_at };
  }

  private toTaskDetail(task: StoredTask): TaskDetail {
    const { report: _report, ...detail } = task;
    return detail;
  }

  private emit(type: string, payload: JsonObject): void {
    const event: CoreEvent = {
      kind: "event",
      event_id: createUlid(),
      sequence: ++this.sequence,
      cursor: String(this.sequence),
      type,
      schema_version: "1.0.0",
      payload,
    };
    this.eventLog.push(event);
    if (this.eventLog.length > 10000) this.eventLog.splice(0, this.eventLog.length - 10000);
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

/** Wires the persisted knowledge_dir setting into Core's knowledge location. */
export function knowledgeStorageOptions(appSettings: AppSettingsStore): { read(): string; write(value: string): void } {
  return { read: () => appSettings.getKnowledgeDir(), write: (value) => { appSettings.setKnowledgeDir(value); } };
}

export function createCore(options: CreateCoreOptions): CorePort {
  return new MemoryCore(options);
}

interface ExternalCoreModule {
  createCore?: (options: CreateCoreOptions) => unknown;
}

interface ExternalCommandResponse {
  request_id?: string;
  data: JsonObject;
  version: number;
}

interface ExternalCore {
  ruleStore?: unknown;
  recordAgentResearch?(agent: GuardTokenAgent, capture: WebResearchCapture): Promise<{ readonly accepted: boolean; readonly reason?: string }>;
  recordSkillReads?(input: {
    readonly agent_run_id: string;
    readonly tool_name: string;
    readonly tool_input: Readonly<Record<string, unknown>>;
    readonly cwd: string;
    readonly normalized_segments?: readonly (readonly string[])[];
  }): Promise<void>;
  advisorRespond?(conversationId: string, messageId: string, origin?: AdvisorOrigin): Promise<void>;
  advisorSessions?: AdvisorSessionsPort;
  restartAdvisorSession?(ownerId: string): Promise<void>;
  getHybridMode?(): Promise<boolean>;
  setHybridMode?(enabled: boolean): Promise<boolean>;
  getSkillActivity?(days: number): unknown;
  listSkills?(filter: { query?: string; state?: string; scope?: string; trial?: boolean }): readonly unknown[];
  getSkill?(name: string): Promise<unknown>;
  readSkillFile?(name: string, path: string): Promise<string>;
  listSkillRevisions?(name: string): readonly unknown[];
  getSkillRevision?(name: string, revisionId: string): unknown;
  restoreSkill?(name: string, revisionId: string): Promise<{ revision_id: string; revision: number }>;
  updateSkill?(name: string, patch: { state?: string; scope?: string }): Promise<unknown>;
  listSkillProposals?(status?: string): readonly unknown[];
  approveSkillProposal?(proposalId: string): Promise<unknown>;
  rejectSkillProposal?(proposalId: string): Promise<unknown>;
  listLearningJobs?(status?: string): readonly unknown[];
  retryLearningJob?(jobId: string): Promise<void>;
  runCuration?(input: JsonObject): Promise<unknown>;
  startCurationInBackground?(input: JsonObject): Promise<unknown>;
  retagKnowledgeNotes?(input: { dry_run: boolean; force?: boolean }): Promise<unknown>;
  listCurationRuns?(query: JsonObject): { items: readonly unknown[]; next_cursor: string | null };
  getCurationRun?(id: string): unknown;
  listBacklogItems?(filter: { status?: string; project_id?: string; work_id?: string; limit?: number; offset?: number }): { items: readonly unknown[]; next_offset: number | null };
  dismissBacklogItems?(request: JsonObject): Promise<ExternalCommandResponse>;
  deleteBacklogItems?(request: JsonObject): Promise<ExternalCommandResponse>;
  issueBacklogWork?(request: JsonObject): Promise<ExternalCommandResponse>;
  linkBacklogItems?(workId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  getSkillSettings?(): unknown;
  setSkillSettings?(value: unknown): Promise<unknown>;
  getLanguage?(): Promise<OwnerLanguage>;
  setLanguage?(language: OwnerLanguage): Promise<OwnerLanguage>;
  initializeLanguage?(language: OwnerLanguage): Promise<OwnerLanguage>;
  getProcessSkillsSettings?(): Promise<ProcessSkillsSettingsSnapshot>;
  setProcessSkillsSettings?(input: ProcessSkillsSettingsInput): Promise<ProcessSkillsSettingsSnapshot>;
  getKnowledgeAutomationSettings?(): Promise<KnowledgeAutomationSnapshot>;
  setKnowledgeAutomationSettings?(input: KnowledgeAutomationSettings): Promise<KnowledgeAutomationSnapshot>;
  listProviderPauses?(): ProviderPauseView[];
  resumeProviderPause?(provider: string): Promise<ProviderPauseView | null>;
  dispatchChildRun?(parentAgentRunId: string, request: ChildDispatchRequest, requestKey: string): Promise<ChildDispatchResponse>;
  waitChildRuns?(parentAgentRunId: string, request: ChildWaitRequest, signal: AbortSignal): Promise<ChildWaitResponse>;
  listChildRuns?(filter: ChildRunListFilter): readonly ChildRunRecord[];
  getChildRunSettings?(): ChildRunSettings;
  setChildRunSettings?(settings: ChildRunSettings): ChildRunSettings | Promise<ChildRunSettings>;
  start(): Promise<void>;
  stop(options?: { force?: boolean; timeoutMs?: number }): Promise<void>;
  status(): { services: readonly { name: string; state: string; pid: number | null }[]; mvp_scope: string; version: string };
  subscribe(handler: (event: CoreEvent) => void | Promise<void>): () => void;
  listEventsAfter?: (cursor?: string | number | null, limit?: number) => readonly CoreEvent[];
  createWork(request: JsonObject): Promise<ExternalCommandResponse>;
  listWorks(query: JsonObject): { data: readonly WorkSummary[]; cursor: string | null; has_more: boolean };
  getWork(workId: string, query?: JsonObject): ExternalCommandResponse;
  getWorkBranchStatus?(workId: string): Promise<WorkBranchStatus>;
  getWorkDesigns?(workId: string): Promise<WorkDesignList>;
  getWorkConversation?(workId: string, opts: { limit: number }): Promise<WorkConversation>;
  getWorkAssurance?(workId: string): WorkAssurance | Promise<WorkAssurance>;
  getWorkView?(workId: string, query: { conversation_limit?: number }): JsonObject;
  getDecisionView?(decisionId: string): JsonObject;
  getBoardView?(query: { archived: "exclude" | "only"; limit: number; cursor?: string | null }): JsonObject;
  listLinkableWorks?(projectId: string | null, query: { limit: number; cursor?: string | null }): JsonObject;
  getBacklogListView?(filter: { status?: string; project_id?: string; work_id?: string; issued_work_id?: string; limit?: number; offset?: number }): JsonObject;
  getTokensView?(input: { period: "today" | "7d" | "30d"; top: number }): Promise<JsonObject>;
  getWorkDesign?(workId: string, taskId: string): Promise<WorkDesignDetail | null>;
  startWork(workId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  pauseWork(workId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  resumeWork(workId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  resumeWorkOrRetryDecision(workId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  cancelWork(workId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  reopenWork(workId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  postWorkInstruction(workId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  updateWork(workId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  archiveWork(workId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  unarchiveWork(workId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  deleteWork(workId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  listTasks(workId: string, query?: JsonObject): { data: readonly TaskSummary[]; cursor: string | null; has_more: boolean };
  getTask(taskId: string, query?: JsonObject): ExternalCommandResponse;
  listDecisions(query?: JsonObject): { data: readonly Decision[]; cursor: string | null; has_more: boolean };
  answerDecision(decisionId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  listAgentRuns(query?: JsonObject): { data: readonly AgentRun[]; cursor: string | null; has_more: boolean };
  cancelAgent(agentRunId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  listArtifacts(workId: string): Array<{ id: string; work_id: string; task_id: string | null; path: string; kind: string; created_at: string }>;
  listProjects(query?: JsonObject): { data: readonly Project[]; cursor: string | null; has_more: boolean };
  createProject(request: JsonObject): Promise<ExternalCommandResponse>;
  updateProject?(projectId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  getProjectDeletionImpact?(projectId: string): ProjectDeletionImpact | Promise<ProjectDeletionImpact>;
  deleteProject?(projectId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  getModelSettings(): { version: number; roles: readonly RoleModelSetting[] };
  updateModelSettings(request: JsonObject): Promise<ExternalCommandResponse>;
  getModelPresets(): { version: number; presets: readonly ModelPreset[] };
  createModelPreset(request: JsonObject): Promise<ExternalCommandResponse>;
  updateModelPreset(id: string, request: JsonObject): Promise<ExternalCommandResponse>;
  deleteModelPreset(id: string, request: JsonObject): Promise<ExternalCommandResponse>;
  listMessages(conversationId: string, query?: JsonObject): { data: readonly Message[]; cursor: string | null; has_more: boolean };
  ingestConversation(conversationId: string): Promise<{ path: string }>;
  postMessage(conversationId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  ingestInbound(ownerId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  ensureConnectorAccount(ownerId: string, provider: "slack" | "discord", accountId: string): Promise<string>;
  registerInboundUpload(ownerId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  putInboundUpload(ownerId: string, uploadId: string, request: JsonObject): Promise<JsonObject>;
  completeInboundUpload(ownerId: string, uploadId: string, request: JsonObject): Promise<ExternalCommandResponse>;
  getActiveConversation(): Promise<{ conversation_id: string }>;
  clearConversation(conversationId: string): Promise<{ cleared: boolean }>;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function progressFromTaskStates(workId: string, states: readonly unknown[]): WorkProgress {
  if (states.some((state) => typeof state !== "string")) {
    throw workDetailCoreError(workId, "progress", "Work contains a Task reference that cannot be resolved.");
  }
  const total_tasks = states.length;
  const completed_tasks = states.filter((state) => state === "completed").length;
  return {
    total_tasks,
    completed_tasks,
    percent: total_tasks === 0 ? 0 : Math.round((completed_tasks / total_tasks) * 100),
  };
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

function externalWorkProgress(core: ExternalCore, workId: string): WorkProgress {
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
  };
}

function displayNumberOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function externalError(error: unknown, operation: string): ApiError {
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
      "provider_pause_not_found",
      "write_paths_invalid",
      "model_not_allowed",
      "effort_not_allowed",
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
    const status = publicCode === "validation_error" || ["write_paths_invalid", "model_not_allowed", "effort_not_allowed", "timeout_out_of_range"].includes(publicCode) ? 400
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
  private processSkillsSettings: ProcessSkillsSettingsInput = { enabled: true, path: null };
  private knowledgeAutomationSettings: KnowledgeAutomationSettings = {
    ...DEFAULT_KNOWLEDGE_AUTOMATION_SETTINGS,
    librarian_times: [...DEFAULT_KNOWLEDGE_AUTOMATION_SETTINGS.librarian_times],
  };
  private readonly detectProviderAvailability: ProviderAvailabilityDetector;
  private processSkillsInstallCommandList: ProcessSkillsInstallCommand[] | null = null;
  readonly ruleStore: unknown;

  constructor(
    private readonly core: ExternalCore,
    private readonly db: unknown,
    owlRoot: string,
    private readonly dataDir: string,
    appSettings?: AppSettingsStore,
    options: { detectProviderAvailability?: ProviderAvailabilityDetector } = {},
  ) {
    this.detectProviderAvailability = options.detectProviderAvailability ?? detectBuiltinProviders;
    this.advisorSessions = core.advisorSessions ?? { getActiveSession: () => null };
    this.integrationStore = new IntegrationStore(owlRoot, dataDir);
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
      })) };
    } catch (error) {
      throw externalError(error, "listWorks");
    }
  }

  async createWork(input: WorkCreateInput, command: CommandMeta): Promise<CommandResult<{ work_id: string; state: "memo" | "ready"; state_version: number }>> {
    try {
      const response = await this.core.createWork({ ...command, payload: input });
      const { version: _version, ...data } = response.data;
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
      return await this.core.getWorkConversation(workId, opts);
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
      return this.core.getBacklogListView(filter);
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
      return await this.core.getWorkAssurance(workId);
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

  async startWork(workId: string, mode: "normal" | "small", command: CommandMeta): Promise<CommandResult<{ work_id: string; state: "running"; started: boolean }>> {
    try {
      const response = await this.core.startWork(workId, { ...command, payload: { mode } });
      const { version: _version, ...data } = response.data;
      return { data: data as { work_id: string; state: "running"; started: boolean }, version: response.version };
    } catch (error) {
      throw externalError(error, "startWork");
    }
  }

  async pauseWork(workId: string, reason: string, command: CommandMeta): Promise<CommandResult<{ work_id: string; state: "paused"; signal: "pause_requested" }>> {
    try {
      const response = await this.core.pauseWork(workId, { ...command, payload: { reason } });
      const { version: _version, ...data } = response.data;
      return { data: data as { work_id: string; state: "paused"; signal: "pause_requested" }, version: response.version };
    } catch (error) {
      throw externalError(error, "pauseWork");
    }
  }

  async resumeWork(workId: string, command: CommandMeta): Promise<CommandResult<{ work_id: string; state: "running" }>> {
    try {
      const response = await this.core.resumeWork(workId, { ...command, payload: {} });
      const { version: _version, ...data } = response.data;
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
      const { version: _version, ...data } = response.data;
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
      const { version: _version, ...data } = response.data;
      return { data: data as { work_id: string; state: "cancelled"; cancel_requested: boolean; worktree_cleanup?: { ok: boolean; message: string; details?: JsonObject } }, version: response.version };
    } catch (error) {
      throw externalError(error, "cancelWork");
    }
  }

  async reopenWork(workId: string, reason: string, command: CommandMeta): Promise<CommandResult<{ work_id: string; state: "running" }>> {
    try {
      const response = await this.core.reopenWork(workId, { ...command, payload: { reason } });
      const { version: _version, ...data } = response.data;
      return { data: data as { work_id: string; state: "running" }, version: response.version };
    } catch (error) {
      throw externalError(error, "reopenWork");
    }
  }

  async postWorkInstruction(workId: string, input: WorkInstructionInput, command: CommandMeta): Promise<CommandResult<WorkInstructionResult>> {
    try {
      const response = await this.core.postWorkInstruction(workId, { ...command, payload: input });
      const { version: _version, ...data } = response.data;
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
      const { version: _version, ...data } = response.data;
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
      const { version: _version, ...data } = response.data;
      return { request_id: response.request_id, data: data as { work_id: string; archived_at: string | null }, version: response.version };
    } catch (error) {
      throw externalError(error, "archiveWork");
    }
  }

  async unarchiveWork(workId: string, command: CommandMeta): Promise<CommandResult<{ work_id: string; archived_at: null }>> {
    try {
      const response = await this.core.unarchiveWork(workId, { ...command, payload: {} });
      const { version: _version, ...data } = response.data;
      return { request_id: response.request_id, data: data as { work_id: string; archived_at: null }, version: response.version };
    } catch (error) {
      throw externalError(error, "unarchiveWork");
    }
  }

  async deleteWork(workId: string, command: CommandMeta): Promise<CommandResult<{ work_id: string; deleted: true }>> {
    try {
      const response = await this.core.deleteWork(workId, { ...command, payload: {} });
      const { version: _version, ...data } = response.data;
      return { request_id: response.request_id, data: data as { work_id: string; deleted: true }, version: response.version };
    } catch (error) {
      throw externalError(error, "deleteWork");
    }
  }

  async listTasks(workId: string, query: { status: string | null; limit: number; cursor: string | null }): Promise<Page<TaskSummary>> {
    try {
      // The durable Core returns an empty page for an unknown work_id. Match
      // the standalone Core and REST contract by surfacing work_not_found.
      this.core.getWork(workId);
      return this.core.listTasks(workId, query);
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
      return this.core.listDecisions(query);
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
      return this.core.listAgentRuns(query);
    } catch (error) {
      throw externalError(error, "listAgentRuns");
    }
  }

  async cancelAgent(agentRunId: string, reason: string, force: boolean, command: CommandMeta): Promise<CommandResult<{ agent_run_id: string; status: "cancel_requested" | "cancelled" }>> {
    try {
      const response = await this.core.cancelAgent(agentRunId, { ...command, payload: { reason, force } });
      const { version: _version, ...data } = response.data;
      return { data: data as { agent_run_id: string; status: "cancel_requested" | "cancelled" }, version: response.version };
    } catch (error) {
      throw externalError(error, "cancelAgent");
    }
  }

  async listProjects(query: { limit: number; cursor: string | null }): Promise<Page<Project>> {
    try {
      return this.core.listProjects(query);
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
      const response = await this.core.createProject({ ...command, payload: input });
      const { version: _version, ...data } = response.data;
      return { data: data as unknown as Project, version: response.version };
    } catch (error) {
      throw externalError(error, "createProject");
    }
  }

  async updateProject(projectId: string, input: UpdateProjectInput, command: CommandMeta): Promise<{ data: Project; version: number }> {
    try {
      if (!this.core.updateProject) throw new ApiError(503, "core_not_ready", "The loaded Core does not support updateProject.");
      const response = await this.core.updateProject(projectId, { ...command, payload: input });
      const { version: _version, ...data } = response.data;
      return { data: data as unknown as Project, version: response.version };
    } catch (error) {
      throw externalError(error, "updateProject");
    }
  }

  async getProjectDeletionImpact(projectId: string): Promise<ProjectDeletionImpact> {
    try {
      if (!this.core.getProjectDeletionImpact) throw new ApiError(503, "core_not_ready", "The loaded Core does not support getProjectDeletionImpact.");
      return await this.core.getProjectDeletionImpact(projectId);
    } catch (error) {
      throw externalError(error, "getProjectDeletionImpact");
    }
  }

  async deleteProject(projectId: string, input: DeleteProjectInput, command: CommandMeta): Promise<{ data: DeleteProjectResult; version: number }> {
    try {
      if (!this.core.deleteProject) throw new ApiError(503, "core_not_ready", "The loaded Core does not support deleteProject.");
      const response = await this.core.deleteProject(projectId, { ...command, payload: input });
      const { version: _version, ...data } = response.data;
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
      const response = await this.core.updateModelSettings({ ...command, payload: input });
      const { version: _version, ...data } = response.data as { version?: unknown; roles: readonly RoleModelSetting[] };
      return { data: { roles: [...data.roles] }, version: response.version };
    } catch (error) {
      throw externalError(error, "updateModelSettings");
    }
  }

  async getModelPresets(): Promise<{ version: number; presets: ModelPreset[] }> {
    try {
      const result = this.core.getModelPresets();
      return { version: result.version, presets: result.presets.map(cloneModelPreset) };
    } catch (error) {
      throw externalError(error, "getModelPresets");
    }
  }

  async createModelPreset(input: { name: string; roles: RoleModelSettingInput[] }, command: CommandMeta): Promise<CommandResult<{ preset: ModelPreset; presets: ModelPreset[] }>> {
    try {
      const response = await this.core.createModelPreset({ ...command, payload: input });
      return modelPresetCommandResult(response);
    } catch (error) {
      throw externalError(error, "createModelPreset");
    }
  }

  async updateModelPreset(id: string, input: { name?: string; roles?: RoleModelSettingInput[] }, command: CommandMeta): Promise<CommandResult<{ preset: ModelPreset; presets: ModelPreset[] }>> {
    try {
      const response = await this.core.updateModelPreset(id, { ...command, payload: input });
      return modelPresetCommandResult(response);
    } catch (error) {
      throw externalError(error, "updateModelPreset");
    }
  }

  async deleteModelPreset(id: string, command: CommandMeta): Promise<CommandResult<{ presets: ModelPreset[] }>> {
    try {
      const response = await this.core.deleteModelPreset(id, { ...command, payload: {} });
      const data = response.data as { presets: readonly ModelPreset[] };
      return { data: { presets: data.presets.map(cloneModelPreset) }, version: response.version };
    } catch (error) {
      throw externalError(error, "deleteModelPreset");
    }
  }

  async listMessages(conversationId: string, query: { limit: number; cursor: string | null }): Promise<Page<Message>> {
    try {
      return this.core.listMessages(conversationId, query);
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
      const response = await this.core.postMessage(conversationId, { ...command, payload: input });
      const { version: _version, ...data } = response.data;
      return { data: data as { message_id: string; advisor_run_id: string | null }, version: response.version };
    } catch (error) {
      throw externalError(error, "postMessage");
    }
  }

  async ingestInbound(ownerId: string, input: InboundMessageInput, command: CommandMeta): Promise<CommandResult<InboundMessageResult>> {
    try {
      const response = await this.core.ingestInbound(ownerId, { ...command, payload: input });
      const { version: _version, ...data } = response.data;
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
      const response = await this.core.registerInboundUpload(ownerId, { ...command, payload: input });
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
      const response = await this.core.completeInboundUpload(ownerId, uploadId, { ...command, payload: input });
      return { data: response.data as unknown as InboundUploadCompleteResult, version: response.version };
    } catch (error) {
      throw externalError(error, "completeInboundUpload");
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

  async restartAdvisorSession(ownerId: string): Promise<void> {
    if (typeof this.core.restartAdvisorSession !== "function") {
      throw new ApiError(503, "dependency_unavailable", "Persistent Advisor session restart is not available in the loaded Core.");
    }
    try {
      await this.core.restartAdvisorSession(ownerId);
    } catch (error) {
      throw externalError(error, "restartAdvisorSession");
    }
  }

  async getHybridMode(): Promise<boolean> {
    if (typeof this.core.getHybridMode === "function") {
      try {
        return await this.core.getHybridMode();
      } catch (error) {
        throw externalError(error, "getHybridMode");
      }
    }
    return this.appSettings.getHybridMode();
  }

  async setHybridMode(enabled: boolean): Promise<boolean> {
    if (typeof this.core.setHybridMode === "function") {
      try {
        return await this.core.setHybridMode(enabled);
      } catch (error) {
        throw externalError(error, "setHybridMode");
      }
    }
    return this.appSettings.setHybridMode(enabled);
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

  retagKnowledgeNotes(input: { dry_run: boolean; force?: boolean }): Promise<unknown> {
    if (typeof this.core.retagKnowledgeNotes !== "function") throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support knowledge retagging.");
    return this.core.retagKnowledgeNotes(input);
  }

  runCuration(input: JsonObject): Promise<unknown> {
    if (typeof this.core.runCuration !== "function") throw skillApiUnavailable("Curation runs");
    return this.core.runCuration(input);
  }

  startCurationInBackground(input: JsonObject): Promise<unknown> {
    if (typeof this.core.startCurationInBackground !== "function") throw skillApiUnavailable("Curation runs");
    return this.core.startCurationInBackground(input);
  }

  listCurationRuns(query: JsonObject): { items: readonly unknown[]; next_cursor: string | null } {
    if (typeof this.core.listCurationRuns !== "function") throw skillApiUnavailable("Curation run listing");
    return this.core.listCurationRuns(query);
  }

  getCurationRun(id: string): unknown {
    if (typeof this.core.getCurationRun !== "function") throw skillApiUnavailable("Curation run lookup");
    return this.core.getCurationRun(id);
  }

  listBacklogItems(filter: { status?: string; project_id?: string; work_id?: string; limit?: number; offset?: number }): { items: unknown[]; next_offset: number | null } {
    if (typeof this.core.listBacklogItems !== "function") throw skillApiUnavailable("Review backlog listing");
    try {
      const result = this.core.listBacklogItems(filter);
      return { items: [...result.items], next_offset: result.next_offset };
    } catch (error) {
      throw externalError(error, "listBacklogItems");
    }
  }

  async dismissBacklogItems(request: JsonObject): Promise<{ data: JsonObject; version: number }> {
    if (typeof this.core.dismissBacklogItems !== "function") throw skillApiUnavailable("Review backlog dismissal");
    try {
      const response = await this.core.dismissBacklogItems(request);
      return { data: response.data, version: response.version };
    } catch (error) {
      throw externalError(error, "dismissBacklogItems");
    }
  }

  async deleteBacklogItems(request: JsonObject): Promise<{ data: JsonObject; version: number }> {
    if (typeof this.core.deleteBacklogItems !== "function") throw skillApiUnavailable("Review backlog deletion");
    try {
      const response = await this.core.deleteBacklogItems(request);
      return { data: response.data, version: response.version };
    } catch (error) {
      throw externalError(error, "deleteBacklogItems");
    }
  }

  async issueBacklogWork(request: JsonObject): Promise<{ data: JsonObject; version: number }> {
    if (typeof this.core.issueBacklogWork !== "function") throw skillApiUnavailable("Review backlog Work issuance");
    try {
      const response = await this.core.issueBacklogWork(request);
      return { data: response.data, version: response.version };
    } catch (error) {
      throw externalError(error, "issueBacklogWork");
    }
  }

  async linkBacklogItems(workId: string, request: JsonObject): Promise<{ data: JsonObject; version: number }> {
    if (typeof this.core.linkBacklogItems !== "function") throw skillApiUnavailable("Review backlog linking");
    try {
      const response = await this.core.linkBacklogItems(workId, request);
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
    if (typeof this.core.getLanguage !== "function") return DEFAULT_OWNER_LANGUAGE;
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
    if (typeof this.core.recordAgentResearch !== "function") return { accepted: false, reason: "unavailable" };
    try {
      return await this.core.recordAgentResearch(agent, capture);
    } catch (error) {
      throw externalError(error, "recordAgentResearch");
    }
  }

  async recordSkillReads(input: Parameters<NonNullable<ExternalCore["recordSkillReads"]>>[0]): Promise<void> {
    if (typeof this.core.recordSkillReads !== "function") return;
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
    if (typeof this.core.getProcessSkillsSettings === "function") {
      let snapshot: ProcessSkillsSettingsSnapshot;
      try {
        snapshot = await this.core.getProcessSkillsSettings();
      } catch (error) {
        throw externalError(error, "getProcessSkillsSettings");
      }
      return { ...snapshot, install_commands: this.processSkillsInstallCommands() };
    }
    return detectProcessSkillsSettings(this.processSkillsSettings, this.processSkillsInstallCommands());
  }

  async setProcessSkillsSettings(input: ProcessSkillsSettingsInput): Promise<ProcessSkillsSettingsSnapshot> {
    if (typeof this.core.setProcessSkillsSettings === "function") {
      let snapshot: ProcessSkillsSettingsSnapshot;
      try {
        snapshot = await this.core.setProcessSkillsSettings(input);
      } catch (error) {
        throw externalError(error, "setProcessSkillsSettings");
      }
      return { ...snapshot, install_commands: this.processSkillsInstallCommands() };
    }
    validateProcessSkillsSettings(input);
    this.processSkillsSettings = { enabled: input.enabled, path: input.path };
    return detectProcessSkillsSettings(this.processSkillsSettings, this.processSkillsInstallCommands());
  }

  async getKnowledgeAutomationSettings(): Promise<KnowledgeAutomationSnapshot> {
    if (typeof this.core.getKnowledgeAutomationSettings === "function") {
      try {
        return await this.core.getKnowledgeAutomationSettings();
      } catch (error) {
        throw externalError(error, "getKnowledgeAutomationSettings");
      }
    }
    return knowledgeAutomationSnapshot(this.knowledgeAutomationSettings);
  }

  async setKnowledgeAutomationSettings(input: KnowledgeAutomationSettings): Promise<KnowledgeAutomationSnapshot> {
    if (typeof this.core.setKnowledgeAutomationSettings === "function") {
      try {
        return await this.core.setKnowledgeAutomationSettings(input);
      } catch (error) {
        throw externalError(error, "setKnowledgeAutomationSettings");
      }
    }
    this.knowledgeAutomationSettings = validateKnowledgeAutomationSettingsInput(input);
    return knowledgeAutomationSnapshot(this.knowledgeAutomationSettings);
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
    if (input.harnessId !== "claude" && input.harnessId !== "codex") {
      throw new ApiError(400, "validation_error", "harnessIdはclaudeまたはcodexを指定してください。");
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
        // The standalone adapter uses -1 to mean "from the beginning"; the durable Core uses 0.
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
  if (process.env.OWL_CORE_MODE === "standalone") {
    return createCore(options);
  }
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
  // A built-in provider id never has a custom-settings entry; both callbacks
  // below use this to decide whether a provider needs any override at all.
  const isBuiltinProviderId = (normalized: string): boolean =>
    normalized === "anthropic" || normalized === "claude"
    || normalized === "openai" || normalized === "codex" || normalized === "openai/codex";
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
    getAdvisorFolders: () => {
      const defaults = advisorFolderDefaults(options.dataDir ?? resolveDataDir(owlRoot));
      const sharedDir = appSettings.getAdvisorSharedDir() || defaults.sharedDir;
      try { ensureAdvisorSharedDir(sharedDir); } catch { /* prompt construction remains available */ }
      return { sharedDir, screenshotDir: appSettings.getAdvisorScreenshotDir() || defaults.screenshotDir };
    },
    getAdvisorSharedDir: () => appSettings.getAdvisorSharedDir() || advisorFolderDefaults(options.dataDir ?? resolveDataDir(owlRoot)).sharedDir,
    knownModels: (harness: "claude" | "codex"): ReadonlySet<string> | undefined =>
      harness === "codex" ? codexKnownModels() : undefined,
    getProviderHarness: (providerId: string): "claude" | "codex" | undefined => {
      const normalized = providerId.trim().toLowerCase();
      if (normalized === "anthropic" || normalized === "claude") return "claude";
      if (normalized === "openai" || normalized === "codex" || normalized === "openai/codex") return "codex";
      const custom = findCustomProvider(providerId);
      return custom?.harnessId === "claude" || custom?.harnessId === "codex" ? custom.harnessId : undefined;
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
  let external: ExternalCore;
  try {
    external = loaded.createCore(enrichedOptions) as ExternalCore;
    if (!external || typeof external.start !== "function" || typeof external.stop !== "function" || typeof external.subscribe !== "function") {
      throw new Error("Core createCore returned an incompatible object");
    }
    await external.start();
    // First start: store the language the OS locale implies (ja-JP -> "ja",
    // anything else -> "en"). A stored setting is never overwritten.
    await external.initializeLanguage?.(ownerLanguageFromLocale(Intl.DateTimeFormat().resolvedOptions().locale));
  } catch (error) {
    throw externalError(error, "core startup");
  }
  return new ExternalCoreAdapter(
    external,
    options.db,
    owlRoot,
    options.dataDir ?? resolveDataDir(owlRoot),
    appSettings,
  );
}
