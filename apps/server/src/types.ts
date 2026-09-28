import type { OwnerLanguage } from "../../../packages/shared/dist/owner-language.js";
import type { GuardTokenIssuer } from "../../../packages/shared/dist/guard-token.js";
export type JsonObject = Record<string, unknown>;

export type WorkState =
  | "memo"
  | "ready"
  | "running"
  | "paused"
  | "judgement_waiting"
  | "completed"
  | "cancelled"
  | (string & {});

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

export interface WorkSummary {
  id: string;
  display_number: number | null;
  title: string;
  state: WorkState;
  state_version: number;
  updated_at: string;
  archived_at: string | null;
  project_id: string | null;
}

export interface WorkProgress {
  total_tasks: number;
  completed_tasks: number;
  percent: number;
}

export interface WorkDetail extends WorkSummary {
  owner_id: string;
  summary: string;
  size: "small" | "normal" | "large";
  plan_revision: number;
  progress: WorkProgress;
}

/** Whether a Work's branches hold content outside its Project base branch. */
export interface WorkBranchStatus {
  work_id: string;
  unmerged_changes: "present" | "absent" | "unknown";
}

export interface WorkDesignSummary {
  task_id: string;
  title: string;
  updated_at: string;
  size_bytes: number;
}

export interface WorkDesignDetail {
  task_id: string;
  title: string;
  markdown: string;
  updated_at: string;
}

export interface WorkDesignList {
  designs: WorkDesignSummary[];
}

export interface TaskSummary {
  id: string;
  work_id: string;
  title: string;
  status: TaskState;
  type: string;
  state_version: number;
  updated_at: string;
}

export interface TaskDetail extends TaskSummary {
  parent_task_id: string | null;
  acceptance: string;
  review_round: number;
  failure_count: number;
  worker_generation: number;
}

export interface Report {
  id: string;
  agent_run_id: string;
  schema_version: string;
  result: "success" | "failed" | "partial";
  payload: JsonObject;
  created_at: string;
}

export interface Decision {
  id: string;
  work_id: string;
  scope: "task" | "work";
  status: "open" | "resolved" | "cancelled";
  reason: string;
  options: JsonObject[];
  recommended: string | null;
  allow_free_text: boolean;
  blocked_task_ids: string[];
  state_version: number;
}

export interface AgentRun {
  id: string;
  work_id: string | null;
  task_id: string | null;
  role: string;
  provider: string;
  model: string;
  status: string;
  pid: number | null;
  started_at: string | null;
  ended_at: string | null;
  last_output_at: string | null;
  parent_agent_id: string | null;
  phase: "plan" | "executing" | "verdict" | null;
  subtask_count: number | null;
  label: string | null;
  origin: "spawned" | "observed" | null;
}

export interface VerificationCommand {
  command_id: string;
  argv: string[];
  cwd: string;
  env_allowlist: string[];
  timeout_seconds: number;
  stdout_limit: number;
  stderr_limit: number;
  expected_exit_codes: number[];
  executor: "core" | "reviewer";
}

export interface Project {
  id: string;
  name: string;
  canonical_path: string;
  base_branch: string;
  auto_push: boolean;
  allowed_roots: string[];
  verification_plan: VerificationCommand[];
}

export interface CreateProjectInput {
  name: string;
  canonical_path: string;
  base_branch: string;
  allowed_roots: string[];
  verification_plan: VerificationCommand[];
}

export interface UpdateProjectInput {
  name?: string;
  canonical_path?: string;
  base_branch?: string;
  auto_push?: boolean;
}

export interface DeleteProjectInput {
  confirmed_work_count: number;
}

export type ProjectBlocker = "running_works" | "active_agents";

export interface ProjectDeletionImpact {
  project_id: string;
  work_count: number;
  running_work_count: number;
  active_agent_count: number;
  backlog_item_count: number;
  running_works: Array<{
    id: string;
    display_number: number | null;
    title: string;
    state: "running" | "paused" | "judgement_waiting";
  }>;
  blockers: ProjectBlocker[];
  deletable: boolean;
}

export interface DeleteProjectResult {
  project_id: string;
  deleted: true;
  detached_work_count: number;
  detached_backlog_item_count: number;
  detached_works: Array<{
    work_id: string;
    previous_display_number: number | null;
    display_number: number | null;
  }>;
}

export type ActorRole = "advisor" | "manager" | "designer" | "lead_designer" | "worker" | "reviewer" | "librarian" | "curator";
export type ModelEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface RoleModelSetting {
  role: ActorRole;
  provider: string;
  model: string;
  effort: ModelEffort;
  catalog_version: string;
}

export interface RoleModelSettingInput {
  role: ActorRole;
  provider: string;
  model: string;
  effort: ModelEffort;
}

export interface ModelPreset {
  id: string;
  name: string;
  roles: RoleModelSetting[];
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  source: string;
  body: string;
  attachment_ids: string[];
  created_at: string;
}

export interface PostMessageInput {
  body: string;
  attachment_ids: string[];
}

export interface InboundMessageInput {
  provider: "slack" | "discord";
  account_id: string;
  external_message_id: string;
  user_id: string;
  channel_id: string;
  thread_id: string | null;
  received_at: string;
  text: string;
  conversation_hint: {
    work_id: string | null;
    dm_ref: string;
    thread_ref: string | null;
  };
  attachment_ids: string[];
}

export interface AdvisorOrigin {
  channel: string;
  channel_id?: string;
  ref?: string;
}

export interface InboundMessageResult extends JsonObject {
  request_id: string;
  ack_id: string;
  message_id: string;
  event_id: string | null;
  deduplicated: boolean;
  status: "accepted" | "duplicate";
  conversation_id: string;
  advisor_run_id: string | null;
}

export interface InboundUploadRegisterInput {
  provider: "slack" | "discord" | "web";
  account_id: string;
  external_attachment_id: string;
  filename: string;
  declared_mime: string | null;
  declared_bytes: number;
  sha256: string | null;
  work_id: string | null;
  conversation_id: string | null;
  conversation_hint: {
    work_id: string | null;
    dm_ref: string;
    thread_ref: string | null;
  } | null;
}

export interface InboundUploadTicket extends JsonObject {
  upload_id: string;
  put_path: string;
  expires_at: string;
  max_bytes: number;
  conversation_id: string;
}

export interface InboundUploadContentResult extends JsonObject {
  upload_id: string;
  bytes: number;
  sha256: string;
  status: "receiving";
}

export interface InboundUploadCompleteInput {
  bytes: number;
  sha256: string;
  mime: string;
}

export interface InboundUploadCompleteResult extends JsonObject {
  upload_id: string;
  artifact_id: string;
  status: "stored" | "quarantined";
  sha256: string;
  bytes: number;
  mime: string;
}

export interface AdvisorSessionSummary {
  id: string;
  status: string;
  provider_session_id: string | null;
  model: string | null;
  effort: string | null;
  resumed_count: number;
  compaction_count: number;
  last_compaction_at: string | null;
  started_at: string | null;
}

export interface AdvisorSessionsPort {
  getActiveSession(ownerId: string): AdvisorSessionSummary | null | Promise<AdvisorSessionSummary | null>;
}

export interface Page<T> {
  data: readonly T[];
  cursor: string | null;
  has_more: boolean;
}

export interface CoreEvent {
  kind: "event";
  event_id: string;
  sequence: number;
  cursor: string;
  type: string;
  schema_version: "1.0.0";
  work_id?: string | null;
  task_id?: string | null;
  agent_run_id?: string | null;
  created_at?: string;
  payload: JsonObject;
}

export type CoreEventListener = (event: CoreEvent) => void;

/**
 * Process-local control signals (not durable events). They never carry a
 * sequence, are never sent to WebSocket/SDK subscribers, and exist so the
 * server can start/stop connectors when integration settings change.
 */
export interface CoreControlSignal {
  type: "integration.saved" | "integration.deleted";
  provider: "slack" | "discord";
}

export type CoreControlListener = (signal: CoreControlSignal) => void;

export interface WorkCreateInput {
  title: string;
  summary: string;
  size: "small" | "normal" | "large";
  project_id: string | null;
}

export interface CommandMeta {
  request_id: string;
  idempotency_key: string;
  expected_version: number;
}

export interface CommandResult<T extends JsonObject> {
  data: T;
  version: number;
  request_id?: string;
}

export type IntegrationProvider = "slack" | "discord";

export interface IntegrationConfig {
  bot_token: string;
  app_token?: string;
  signing_secret?: string;
  /** Legacy channel setting. A comma/newline-separated list applies to both roles. */
  channel_id?: string;
  /** Channels that receive user messages and Advisor replies (comma/newline separated). */
  conversation_channel_id?: string;
  /** Channels that receive task, decision, and system notifications (comma/newline separated). */
  notification_channel_id?: string;
  /** Canonical connector_accounts.id. Generated once during setup if omitted. */
  account_id?: string;
}

/** Partial update accepted by the settings API and IntegrationStore. */
export type IntegrationConfigPatch = Partial<IntegrationConfig>;

export interface IntegrationStatus extends JsonObject {
  provider: IntegrationProvider;
  configured: boolean;
  conversation_channel_id: string | null;
  notification_channel_id: string | null;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
}

export interface IntegrationTestResult {
  provider: IntegrationProvider;
  ok: boolean;
  detail: string;
  tested_at: string;
}

export interface ExecutorSettingsConfig {
  provider: string;
  model: string;
  effort?: string;
  timeout_ms: number;
}

export interface ProcessSkillsDetectedPack {
  skills_dir: string;
  version: string | null;
  source: "setting" | "claude" | "codex";
}

export interface ProcessSkillsSettingsInput {
  enabled: boolean;
  path: string | null;
}

export interface ProcessSkillsInstallCommand {
  harness: "claude" | "codex";
  command: string;
}

export interface ProcessSkillsSettingsSnapshot extends ProcessSkillsSettingsInput {
  detected: ProcessSkillsDetectedPack | null;
  install_commands: ProcessSkillsInstallCommand[];
}

export interface ProviderConfigRecord {
  id: string;
  displayName: string;
  harnessId: string;
  backendUrl?: string;
  apiKeySource?: string;
  isBuiltin: boolean;
}

export interface DetectedProvider {
  id: string;
  displayName: string;
  harnessId: string;
  available: boolean;
  detail: string | null;
  isBuiltin: boolean;
  backendUrl?: string;
  apiKeySource?: string;
  apiKeyConfigured?: boolean;
  apiKeyLast4?: string;
}

export interface SaveProviderInput {
  displayName: string;
  harnessId: string;
  backendUrl?: string;
  apiKeySource?: string;
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

export interface AdvisorFoldersSnapshot {
  shared_dir: string;
  screenshot_dir: string;
  defaults: { shared_dir: string; screenshot_dir: string };
  custom: { shared_dir: boolean; screenshot_dir: boolean };
}

export interface CorePort {
  readonly version: string;
  readonly ready: boolean;
  status(): {
    services: readonly { name: string; state: string; pid: number | null }[];
    mvp_scope: string;
    version: string;
  };
  recordSkillReads?(input: {
    readonly agent_run_id: string;
    readonly tool_name: string;
    readonly tool_input: Readonly<Record<string, unknown>>;
    readonly cwd: string;
    readonly normalized_segments?: readonly (readonly string[])[];
  }): Promise<void>;
  listWorks(query: {
    state: string | null;
    archived: "exclude" | "include" | "only";
    limit: number;
    cursor: string | null;
  }): Promise<Page<WorkSummary>>;
  createWork(input: WorkCreateInput, command: CommandMeta): Promise<CommandResult<{
    work_id: string;
    state: "memo" | "ready";
    state_version: number;
  }>>;
  getWork(workId: string): Promise<WorkDetail>;
  getWorkBranchStatus(workId: string): Promise<WorkBranchStatus>;
  getWorkDesigns(workId: string): Promise<WorkDesignList>;
  getWorkDesign(workId: string, taskId: string): Promise<WorkDesignDetail | null>;
  startWork(workId: string, mode: "normal" | "small", command: CommandMeta): Promise<CommandResult<{
    work_id: string;
    state: "running";
    started: boolean;
  }>>;
  pauseWork(workId: string, reason: string, command: CommandMeta): Promise<CommandResult<{
    work_id: string;
    state: "paused";
    signal: "pause_requested";
  }>>;
  resumeWork(workId: string, command: CommandMeta): Promise<CommandResult<{
    work_id: string;
    state: "running";
  }>>;
  cancelWork(workId: string, reason: string, force: boolean, command: CommandMeta): Promise<CommandResult<{
    work_id: string;
    state: "cancelled";
    cancel_requested: boolean;
  }>>;
  reopenWork(workId: string, reason: string, command: CommandMeta): Promise<CommandResult<{
    work_id: string;
    state: "running";
  }>>;
  archiveWork(workId: string, command: CommandMeta): Promise<CommandResult<{ work_id: string; archived_at: string | null }>>;
  unarchiveWork(workId: string, command: CommandMeta): Promise<CommandResult<{ work_id: string; archived_at: null }>>;
  deleteWork(workId: string, command: CommandMeta): Promise<CommandResult<{ work_id: string; deleted: true }>>;
  listTasks(workId: string, query: {
    status: string | null;
    limit: number;
    cursor: string | null;
  }): Promise<Page<TaskSummary>>;
  getTask(taskId: string, includeReport: boolean): Promise<{
    data: TaskDetail;
    report: Report | null;
    version: number;
  }>;
  listDecisions(query: {
    status: "open" | "resolved" | "cancelled";
    limit: number;
    cursor: string | null;
  }): Promise<Page<Decision>>;
  answerDecision(decisionId: string, input: {
    answer: string;
    option_key: string | null;
    source: "web" | "slack" | "discord" | "advisor";
    source_message_id: string | null;
  }, command: CommandMeta): Promise<CommandResult<{
    decision_id: string;
    status: "resolved";
    winner: boolean;
    resumed_task_ids: string[];
  }>>;
  listAgents(query: {
    status: string | null;
    work_id: string | null;
    limit: number;
    cursor: string | null;
  }): Promise<Page<AgentRun>>;
  cancelAgent(agentRunId: string, reason: string, force: boolean, command: CommandMeta): Promise<CommandResult<{
    agent_run_id: string;
    status: "cancel_requested" | "cancelled";
  }>>;
  listProjects(query: { limit: number; cursor: string | null }): Promise<Page<Project>>;
  listArtifacts(workId: string): Array<{ id: string; work_id: string; task_id: string | null; path: string; kind: string; created_at: string }>;
  createProject(input: CreateProjectInput, command: CommandMeta): Promise<{ data: Project; version: number }>;
  updateProject(projectId: string, input: UpdateProjectInput, command: CommandMeta): Promise<{ data: Project; version: number }>;
  getProjectDeletionImpact(projectId: string): Promise<ProjectDeletionImpact>;
  deleteProject(projectId: string, input: DeleteProjectInput, command: CommandMeta): Promise<{ data: DeleteProjectResult; version: number }>;
  getModelSettings(): Promise<{ version: number; roles: RoleModelSetting[] }>;
  updateModelSettings(
    input: { roles: RoleModelSettingInput[] },
    command: CommandMeta,
  ): Promise<CommandResult<{ roles: RoleModelSetting[] }>>;
  getModelPresets(): Promise<{ version: number; presets: ModelPreset[] }>;
  createModelPreset(input: { name: string; roles: RoleModelSettingInput[] }, command: CommandMeta): Promise<CommandResult<{ preset: ModelPreset; presets: ModelPreset[] }>>;
  updateModelPreset(id: string, input: { name?: string; roles?: RoleModelSettingInput[] }, command: CommandMeta): Promise<CommandResult<{ preset: ModelPreset; presets: ModelPreset[] }>>;
  deleteModelPreset(id: string, command: CommandMeta): Promise<CommandResult<{ presets: ModelPreset[] }>>;
  listMessages(conversationId: string, query: { limit: number; cursor: string | null }): Promise<Page<Message>>;
  ingestConversation(conversationId: string): Promise<{ path: string }>;
  postMessage(
    conversationId: string,
    input: PostMessageInput,
    command: CommandMeta,
  ): Promise<CommandResult<{ message_id: string; advisor_run_id: string | null }>>;
  ingestInbound(
    ownerId: string,
    input: InboundMessageInput,
    command: CommandMeta,
  ): Promise<CommandResult<InboundMessageResult>>;
  ensureConnectorAccount(ownerId: string, provider: "slack" | "discord", accountId: string): Promise<string>;
  registerInboundUpload(ownerId: string, input: InboundUploadRegisterInput, command: CommandMeta): Promise<CommandResult<InboundUploadTicket>>;
  putInboundUpload(ownerId: string, uploadId: string, input: { content: Buffer; sha256: string; mime: string }): Promise<InboundUploadContentResult>;
  completeInboundUpload(ownerId: string, uploadId: string, input: InboundUploadCompleteInput, command: CommandMeta): Promise<CommandResult<InboundUploadCompleteResult>>;
  advisorRespond(conversationId: string, messageId: string, origin?: AdvisorOrigin): Promise<void>;
  readonly advisorSessions: AdvisorSessionsPort;
  restartAdvisorSession(ownerId: string): Promise<void>;
  getIntegrations(): Promise<IntegrationStatus[]>;
  saveIntegration(provider: IntegrationProvider, config: IntegrationConfigPatch, command: CommandMeta): Promise<{ data: IntegrationStatus; version: number }>;
  testIntegration(provider: IntegrationProvider): Promise<IntegrationTestResult>;
  deleteIntegration(provider: IntegrationProvider, command: CommandMeta): Promise<{ data: { provider: string }; version: number }>;
  getHybridMode(): Promise<boolean>;
  setHybridMode(enabled: boolean): Promise<boolean>;
  /** The Owner's language for agent output, Owl's own text and notifications. */
  getLanguage(): Promise<OwnerLanguage>;
  setLanguage(language: OwnerLanguage): Promise<OwnerLanguage>;
  getExecutorConfig(): Promise<ExecutorSettingsConfig>;
  setExecutorConfig(config: ExecutorSettingsConfig): Promise<ExecutorSettingsConfig>;
  getProcessSkillsSettings(): Promise<ProcessSkillsSettingsSnapshot>;
  setProcessSkillsSettings(input: ProcessSkillsSettingsInput): Promise<ProcessSkillsSettingsSnapshot>;
  getTypesafeApiKey(): Promise<string>;
  setTypesafeApiKey(key: string): Promise<string>;
  getAdvisorPersona(): Promise<string>;
  setAdvisorPersona(persona: string): Promise<string>;
  getAdvisorFolders(): Promise<AdvisorFoldersSnapshot>;
  setAdvisorFolders(sharedDir: string, screenshotDir: string): Promise<AdvisorFoldersSnapshot>;
  clearConversation(conversationId: string): Promise<{ cleared: boolean }>;
  getActiveConversation(): Promise<{ conversation_id: string }>;
  listProviders(): Promise<DetectedProvider[]>;
  listProviderPauses(): Promise<ProviderPauseView[]>;
  getProvider(id: string): Promise<ProviderConfigRecord | null>;
  saveProvider(id: string, input: SaveProviderInput): Promise<ProviderConfigRecord>;
  deleteProvider(id: string): Promise<{ deleted: boolean }>;
  testProvider(id: string): Promise<{ ok: boolean; detail: string }>;
  getProviderModels(): Promise<Record<string, string[]>>;
  setProviderModels(providerId: string, models: string[]): Promise<string[]>;
  subscribe(listener: CoreEventListener): () => void;
  eventsAfter(cursor: number, limit?: number): CoreEvent[];
  /** Newest-first page of events with sequence < before (null = from the newest event). */
  eventsBefore?(before: number | null, limit: number): CoreEvent[];
  /** Sequence of the oldest retained event, or null if there is no history yet. Lets the WebSocket resume handler check a replay gap without scanning the full history. */
  oldestEventSequence?(): number | null;
  /** Cursor of the newest event, or "0" if there is no history yet. Lets the WebSocket ready frame report the current cursor without scanning the full history. */
  latestEventCursor?(): string;
  subscribeControl?(listener: CoreControlListener): () => void;
  activeAgentCount(): number;
  shutdown(options: { force: boolean; timeoutMs: number }): Promise<void>;
}

export interface AgentRunner {
  readonly mode: "real" | "stub";
  activeCount(): number;
  start(workId: string, mode: "normal" | "small"): Promise<void>;
  stopAll(force: boolean): Promise<void>;
}

export interface CreateCoreOptions {
  db: unknown;
  agentRunner: unknown;
  git?: unknown;
  version: string;
  /** Root directory Workspaces are created under; forwarded to @owl/core for terminal-state cleanup. */
  owlRoot?: string;
  /** Durable runtime data directory; forwarded to @owl/core for uploads and artifacts. */
  dataDir?: string;
  /** Provider client for persistent Advisor sessions (agent-runtime's ProviderClient), forwarded to @owl/core. */
  providerClient?: unknown;
  getTypesafeApiKey?: () => string;
  getAdvisorPersona?: () => string;
  getAdvisorFolders?: () => { sharedDir: string; screenshotDir: string } | null;
  getAdvisorSharedDir?: () => string | null;
  getProviderHarness?: (providerId: string) => "claude" | "codex" | undefined;
  /** Environment and CLI paths for Hybrid Executor processes, forwarded to @owl/core. */
  executorRuntime?: () => Promise<{
    readonly owlRoot: string;
    readonly env: Readonly<Record<string, string>>;
    readonly executables: { readonly claude?: string; readonly codex?: string };
    readonly guardToken?: GuardTokenIssuer;
  }>;
}

export interface RuntimeConfig {
  base_path: "/owl/";
  api_base: "/api/v1";
  ws_url: string;
  schema_version: "1.0.0";
}
