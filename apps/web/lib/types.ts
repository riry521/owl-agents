/**
 * Wire-contract types for the Owl API v1 and its state tables.
 *
 * Rules:
 *  - DTO field sets match the API contract exactly (no extra fields).
 *  - WorkState lists known values and accepts future Work values so clients can render them safely.
 *  - AgentRun.status is `string` on the wire; the server fixes the value set to the
 *    agent_runs.status CHECK, so it is narrowed to that set here.
 *
 * Types under "UI aggregate views" are NOT wire DTOs; they are the shapes the
 * mock api-client returns to screens so the client can be swapped for real
 * fetches later without touching components.
 */

import type { BacklogStatus, IntegrationProvider, IntegrationTestResult, WorkProgress, TaskPrerequisite, ProviderPauseView, RuntimeConfig, IntegrationStatus, WorkState, FileDestinationProvider, ProjectBlocker, ProjectRunningWork, DetachedWork, ProjectDeletionImpact, DeleteProjectResult, WorkPrerequisite, InstructionReplyMetadata, AdvisorFileDeliveryMetadata, MessageMetadata, MessageAttachment, Message, InstructionStatus, WorkConversationMessage, WorkConversation, RoleModelSettingInput, Report, WorkAssurance, VerificationCommand, UpdateProjectInput } from "../../../packages/shared/dist/api-views.js";
export type { BacklogStatus, IntegrationProvider, IntegrationTestResult, WorkProgress, TaskPrerequisite, ProviderPauseView, RuntimeConfig, IntegrationStatus, WorkState, FileDestinationProvider, ProjectBlocker, ProjectRunningWork, DetachedWork, ProjectDeletionImpact, DeleteProjectResult, WorkPrerequisite, InstructionReplyMetadata, AdvisorFileDeliveryMetadata, MessageMetadata, MessageAttachment, Message, InstructionStatus, WorkConversationMessage, WorkConversation, RoleModelSettingInput, Report, WorkAssurance, VerificationCommand, UpdateProjectInput };
import type { TaskStateValue, WorkStateValue } from "../../../packages/shared/dist/index.js";
import type { AdvisorWindowChannel } from "../../../packages/shared/dist/advisor-windows.js";
import type { AutoRecoverySettings } from "../../../packages/shared/dist/auto-recovery-settings.js";
import type { AutoWorkEnabledFrom, AutoWorkRuleOrigin, AutoWorkSource, AutoWorkVerdict } from "../../../packages/shared/dist/auto-work.js";
import type { ChildRunEffort, ChildRunHarnessChoice, ChildRunListFilter, ChildRunProvider, ChildRunRecord, ChildRunSettings, ChildRunStatus, ChildRunSummary } from "../../../packages/shared/dist/child-runs.js";
import type { DecisionCriterionRewrite } from "../../../packages/shared/dist/decision-explanation.js";
import type { FixerEscalationSettings } from "../../../packages/shared/dist/fixer-escalation-settings.js";
import type { PlanUsageHarness, PlanUsageOrigin, PlanUsageSnapshot, PlanUsageStatus, PlanUsageWindow, PlanUsageWindowKind } from "../../../packages/shared/dist/plan-usage.js";
import type { PlanUsageHarnessView, PlanUsageSettings, PlanUsageView } from "../../../packages/shared/dist/plan-usage-settings.js";
import type { ProcessSkillsInstallCommand } from "../../../packages/shared/dist/process-skills.js";
import type { TokenUsageHarness, TokenUsageMetrics, TokenUsagePeriod, TokenUsageReport, TokenUsageRole, TokenUsageTaskTotals, TokenUsageWorkTotals } from "../../../packages/shared/dist/token-usage-report.js";
export type { AdvisorWindowChannel, AutoRecoverySettings, AutoWorkEnabledFrom, AutoWorkRuleOrigin, AutoWorkSource, AutoWorkVerdict, ChildRunEffort, ChildRunHarnessChoice, ChildRunListFilter, ChildRunProvider, ChildRunRecord, ChildRunSettings, ChildRunStatus, ChildRunSummary, DecisionCriterionRewrite, FixerEscalationSettings, PlanUsageHarness, PlanUsageHarnessView, PlanUsageOrigin, PlanUsageSettings, PlanUsageSnapshot, PlanUsageStatus, PlanUsageView, PlanUsageWindow, PlanUsageWindowKind, ProcessSkillsInstallCommand, TokenUsageHarness, TokenUsageMetrics, TokenUsagePeriod, TokenUsageReport, TokenUsageRole, TokenUsageTaskTotals, TokenUsageWorkTotals };

/** The web copy carries the resolved-rule fields (origin, overridden_fields) that the shared rule type does not have. */
export interface AutoWorkRule {
  id: string;
  source: AutoWorkSource;
  kinds: string[];
  min_occurrences: number;
  window_minutes: number;
  action: 'draft' | 'start';
  size: 'small' | 'normal' | 'large' | null;
  disabled: boolean;
  origin: AutoWorkRuleOrigin;
  overridden_fields: string[];
}

/** Mutable on purpose: the settings screen passes it to remake-limits.mjs, whose JSDoc type RemakeLimits is not readonly. */
export interface RemakeLimitSettings {
  lineage_review_attempts: number;
  lineage_worker_runs: number;
  lead_review_rejections: number;
  verification_paths: string[];
  checked_task_types: string[];
}

/** Mutable on purpose: token-usage-table.ts sums into it when grouping by project. */
export interface TokenUsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  runs: number;
}

// Types with the same name and a mutually assignable shape on both sides come from @owl/shared/api-views.
// The names that @owl/server's types.ts also defines but with a different shape stay defined here;
// each one has a comment above it naming the fields or members that differ.
// The web bundle must not import the server package (it pulls in Node-only code).

// ---- common scalars ---------------------------------------------------------

/** string(pattern ^[0-9A-HJKMNP-TV-Z]{26}$). The shared ULID is a validator for the server; the web only needs the wire type. */
export type ULID = string;
/** string(format date-time) */
export type RFC3339 = string;

// ---- states ------------------------------------------------------------------

/** Known Task states plus future values returned by newer servers. Not the shared TaskState enum, for the same reason as WorkState. */
// Differs from the server's TaskState in: the web accepts future values (TaskStateValue | (string & {})); the server uses the exact TaskStateValue.
export type TaskState = TaskStateValue | (string & {});

/** agent_runs.status CHECK. */
export type AgentRunStatus =
  | 'launch_pending'
  | 'spawned'
  | 'running'
  | 'exited'
  | 'completed'
  | 'failed'
  | 'spawn_failed'
  | 'cancel_requested'
  | 'cancelled';

/** agent_runs.outcome CHECK: what a completed run's valid result said. */
export type AgentRunOutcome = 'success' | 'redo' | 'replan' | 'question' | 'partial' | 'not_achieved';

// ---- DTOs ---------------------------------------------------------------------

// Differs from the server's WorkSummary in: display_number, project_id, prerequisite_wait and waiting_on, which are optional here and required on the server (the web builds partial WorkSummary values for list rows).
export interface WorkSummary {
  id: ULID;
  display_number?: number | null;
  title: string;
  state: WorkState;
  state_version: number;
  updated_at: RFC3339;
  archived_at: RFC3339 | null;
  project_id?: ULID | null;
  prerequisite_wait?: boolean;
  waiting_on?: WorkPrerequisite[];
}

export interface WorkAdvisorBacklogEntry {
  id: ULID;
  file: string | null;
  line: number | null;
  problem: string;
}

/** Backlog items the Advisor linked to, or dismissed for, a Work at create_work. */
export interface WorkAdvisorBacklog {
  linked: WorkAdvisorBacklogEntry[];
  dismissed: WorkAdvisorBacklogEntry[];
}

/** The final report written when the Work completed, in three sections. */
export interface WorkFinalReport {
  summary: string;
  test_results: string;
  issues: string;
  created_at: RFC3339;
}

// Differs from the server's WorkDetail in: design_mode and advisor_backlog (web only); final_report (WorkFinalReport here, an inline object on the server); title, state, updated_at, owner_id, summary, size, plan_revision and progress are nullable here and non-null on the server; conversation_id, prerequisites, can_move_to_project, display_number, prerequisite_wait and waiting_on are optional here and required on the server. The web omits them for a Work that has not loaded yet.
export interface WorkDetail extends Omit<WorkSummary, 'title' | 'state' | 'updated_at'> {
  title: string | null;
  state: WorkState | null;
  updated_at: RFC3339 | null;
  owner_id: string | null;
  project_id: ULID | null;
  summary: string | null;
  size: 'small' | 'normal' | 'large' | null;
  design_mode: 'auto' | 'lead' | null;
  plan_revision: number | null;
  progress: WorkProgress | null;
  conversation_id?: ULID | null;
  advisor_backlog?: WorkAdvisorBacklog | null;
  prerequisites?: WorkPrerequisite[];
  can_move_to_project?: boolean;
  final_report?: WorkFinalReport | null;
}

export interface WorkListOptions {
  archived?: 'exclude' | 'include' | 'only';
}

export interface ArchiveWorkResult {
  work_id: ULID;
  archived_at: RFC3339;
}

export interface UnarchiveWorkResult {
  work_id: ULID;
  archived_at: null;
}

export interface MoveWorkToProjectResult {
  work_id: ULID;
  project_id: ULID;
  display_number: number;
  previous_display_number: number | null;
  state: string;
}

export interface DeleteWorkResult {
  work_id: ULID;
  deleted: true;
}

// Differs from the server's TaskSummary in: created_at and depends_on (web only) and status (TaskState here, a fixed union without 'ready' on the server; the web accepts unknown future values).
// Why: task-stages.mjs orders the stage view by depends_on and work-detail-safety.mjs normalizes created_at/depends_on
// from the Work detail payload; status stays TaskState so a state the server adds later still renders.
export interface TaskSummary {
  id: ULID;
  work_id: ULID;
  title: string;
  status: TaskState;
  type: string;
  state_version: number;
  updated_at: RFC3339;
  created_at: RFC3339;
  depends_on: ULID[];
  /** Set while the Task waits on a prerequisite. */
  prerequisite?: TaskPrerequisite | null;
  /** For a judgement_waiting Task: why Core stopped it (for example the no-progress limit). */
  stop_reason?: string | null;
  /** Set once the Task moved from the Worker to the Fixer; `rejections` is the review rejection count at that point. */
  fixer_escalation?: { rejections: number } | null;
}

// Differs from the server's TaskDetail in: created_at and depends_on (web only) and status (TaskState here, a fixed union without 'ready' on the server; the web accepts unknown future values).
// Why: task-stages.mjs orders the stage view by depends_on and work-detail-safety.mjs normalizes created_at/depends_on
// from the Work detail payload; status stays TaskState so a state the server adds later still renders.
export interface TaskDetail extends TaskSummary {
  parent_task_id: ULID | null;
  acceptance: string;
  review_round: number;
  total_review_attempts: number;
  failure_count: number;
  worker_generation: number;
}

/** GET /api/v1/backlog row and command result item. */
export interface BacklogItem {
  id: ULID;
  work_id: ULID;
  work_title: string;
  work_display_number: number | null;
  task_id: ULID;
  task_title: string;
  project_id: ULID | null;
  project_name: string | null;
  review_id: ULID;
  review_round: number;
  file: string;
  line: number;
  problem: string;
  reason: string;
  suggestion: string;
  status: BacklogStatus;
  issued_work_id: ULID | null;
  issued_work_title: string | null;
  issued_work_display_number: number | null;
  created_at: RFC3339;
  updated_at: RFC3339;
}

/** POST /api/v1/backlog/issue-work payload. */
export interface IssueBacklogWorkInput {
  item_ids: ULID[];
  title: string;
  summary: string;
  size: 'small' | 'normal' | 'large';
}

/** POST /api/v1/works/{id}/backlog/link data. */
// Differs from the server's LinkBacklogItemsResult in: items (BacklogItem[] here, JsonObject & { id; status }[] on the server).
// Why: core fills items with readBacklogItemsByIds, the same row view as GET /api/v1/backlog, so the web types
// each item as the BacklogItem it shows in BacklogView. The server only passes core's result through and checks
// id/status, so its looser JsonObject element is enough there; narrowing it would not change what the server reads.
export interface LinkBacklogItemsResult {
  work_id: ULID;
  status: 'in_progress' | 'done';
  items: BacklogItem[];
}

/** POST /api/v1/backlog/issue-work data. */
// Differs from the server's IssueBacklogWorkResult in: status and items (server only); the web does not read them.
export interface IssueBacklogWorkResult {
  work_id: ULID;
  display_number: number | null;
  state: 'memo';
  state_version: number;
  project_id: ULID | null;
  item_ids: ULID[];
}

/**
 * Decision.options is `array<object>` with no element schema.
 * The answer endpoint takes `option_key:string|null` and `recommended` is a
 * string, so each option is interpreted as { key, label, description? } and
 * `recommended` is interpreted as an option key.
 */
/** One choice of a Decision; description says what choosing it does. */
export interface DecisionOption {
  key: string;
  label: string;
  description?: string;
  instruction?: string;
  criteria_rewrites?: DecisionCriterionRewrite[];
}


export interface DecisionExplanation {
  kind: string;
  status: 'pending' | 'ready' | 'failed';
  summary: string | null;
  cause_kind: 'work' | 'criteria' | 'external' | null;
  /** Absent on rows written before next_steps existed. */
  next_steps?: string | null;
  option_notes?: { key: string; note: string }[];
}

// Differs from the server's Decision in: question, current_state, tried and explanation (web only) and options (DecisionOption[] here, JsonObject[] on the server).
// Why: DecisionView, BoardView, WorkPreviewPanel and WorkDetailView render the Decision template (question,
// current_state, tried) and the plain explanation, and draw one button per option from its key/label/description.
// The server code only stores and forwards these values without reading them, so its type lists just the fields it
// checks and keeps options as raw JSON objects.
export interface Decision {
  id: ULID;
  work_id: ULID;
  scope: 'task' | 'work';
  status: 'open' | 'resolved' | 'cancelled';
  /** The Decision template: why it stopped, what to decide, and the facts around it. */
  reason: string;
  question: string;
  current_state: string;
  tried: string;
  options: DecisionOption[];
  recommended: string | null;
  allow_free_text: boolean;
  blocked_task_ids: ULID[];
  state_version: number;
  explanation?: DecisionExplanation | null;
}

/** GET/PUT /api/v1/settings/models role-model row. */
// Differs from the server's RoleModelSetting in: role and effort (string here, ActorRole and ModelEffort on the server). The web keeps plain strings so a role or effort added on the server still renders.
export interface RoleModelSetting {
  role: string;
  provider: string;
  model: string;
  effort: string;
  catalog_version: string;
}

// Differs from the server's ModelPreset in: roles, because it holds the web RoleModelSetting (role and effort are string here, ActorRole and ModelEffort on the server).
export interface ModelPreset {
  id: string;
  name: string;
  roles: RoleModelSetting[];
  created_at: string;
  updated_at: string;
}

export interface CreateModelPresetInput {
  name: string;
  roles: RoleModelSettingInput[];
}

export interface UpdateModelPresetInput {
  name?: string;
  roles?: RoleModelSettingInput[];
}



export interface ProviderInfo {
  id: string;
  displayName: string;
  harnessId: string;
  available: boolean;
  detail: string | null;
  isBuiltin?: boolean;
  backendUrl?: string;
  apiKeySource?: string;
  apiKeyConfigured?: boolean;
  apiKeyLast4?: string;
}

export interface SaveProviderPayload {
  id?: string;
  displayName: string;
  harnessId: string;
  backendUrl?: string;
  apiKeySource?: string;
}

/** Whether Core's test check runs for a Project (source: explicit = Owner's test_run, setup = a setup an agent found and Core confirmed, detected = automatic). */
// Differs from the server's TestRunStatus in: source, which also has 'setup' here (a setup an agent found and Core confirmed); the server union is 'explicit' | 'detected'.
export interface TestRunStatus {
  enabled: boolean;
  reason: string | null;
  command: string[] | null;
  source: 'explicit' | 'setup' | 'detected';
}

/** What the Project screen shows of the saved test setup (the Project's own record). */
export interface TestSetupView {
  status: 'ready' | 'tests_failing' | 'no_tests' | 'no_language' | 'needs_approval' | 'unresolved';
  command: string[] | null;
  setup_commands: string[][];
  prepare_command: string[] | null;
  cwd: string;
  executables: Record<string, { path: string; version: string | null }>;
  sources: string[];
  confirmed_at: string | null;
  attempts: { by: 'agent' | 'core'; argv: string[]; exit_code: number | null; result: string; summary: string; at: string }[];
  outside_installs: { argv: string[]; reason: string; approved_at: string | null }[];
  missing: string[];
  trigger: string;
  investigated_at: string;
}

/** GET /api/v1/projects/:id/test-setup/investigation. */
export interface TestSetupInvestigationState {
  running: boolean;
  outcome: { saved: boolean; status: TestSetupView['status'] | null; reason: string | null } | null;
}

/** The Owner's test settings (TestRunSettings keys, all optional). */
export type TestRunInput = { mode?: 'per_file' | 'whole' | 'off'; whole_argv?: string[]; [key: string]: unknown };

export interface WindowChannelError { code: string; message: string; needed?: string[] }

/** One provider's outcome when a window is turned on. */
export interface WindowChannelResult {
  status: 'bound' | 'already_bound' | 'failed';
  invite?: 'invited' | 'not_applicable' | 'skipped_no_owner_user_id' | 'failed';
  invite_error?: WindowChannelError;
  error?: WindowChannelError;
}

/** GET/POST /api/v1/projects. */
// Differs from the server's Project in: window_channels, effective_post_merge_command and test_setup (web only); required_test_command (server only); verification_plan (unknown[] here, VerificationCommand[] on the server); test_run (TestRunInput here, Record<string, unknown> on the server); auto_push, worktree_setup_command, worktree_refresh_command, post_merge_command, post_merge_install_command are optional here and required on the server.
// Why: ProjectsView shows window_channels (added by the PATCH route when the Advisor window is turned on),
// effective_post_merge_command (badge) and test_setup (both built into core's project view), so the web needs them;
// the web never shows required_test_command. test_run is TestRunInput because project-management.ts turns it into the test-run form.
// The command fields and auto_push are optional because project-management.ts reads them with `?? []` / `=== true`
// and its tests build Projects with only id/name/canonical_path. verification_plan is unknown[] because the web never
// reads its elements.
export interface Project {
  id: string;
  name: string;
  canonical_path: string;
  auto_push?: boolean;
  advisor_window_enabled?: boolean;
  /** Present only in the PATCH response that turned the window on: per-provider channel results. */
  window_channels?: Partial<Record<'slack' | 'discord', WindowChannelResult>>;
  commit_language?: 'ja' | 'en' | null;
  worktree_setup_command?: string[];
  worktree_refresh_command?: string[];
  post_merge_command?: string[] | null;
  effective_post_merge_command?: string[];
  post_merge_install_command?: string[] | null;
  test_run?: TestRunInput | null;
  test_run_status?: TestRunStatus;
  test_setup?: TestSetupView | null;
  base_branch: string;
  allowed_roots: string[];
  verification_plan: unknown[];
}

/** POST /api/v1/projects payload. */
// Differs from the server's CreateProjectInput in: verification_plan (unknown[] here, VerificationCommand[] on the server) and post_merge_command, post_merge_install_command, required_test_command, test_run, test_policy (only the server accepts them; the create form does not use them).
export interface CreateProjectInput {
  name: string;
  canonical_path: string;
  base_branch: string;
  allowed_roots: string[];
  verification_plan: unknown[];
}

export type ProjectFolderInspection =
  | { kind: 'missing'; path: string }
  | { kind: 'not_directory'; path: string }
  | { kind: 'not_git'; canonical_path: string; initial_files: string[]; excluded_files: string[]; total_files: number; truncated: boolean }
  | { kind: 'git_ready'; canonical_path: string; base_branch: string; has_uncommitted_changes: boolean; uncommitted_file_count: number }
  | { kind: 'git_needs_initial_commit'; canonical_path: string; current_branch: string; initial_files: string[]; excluded_files: string[]; total_files: number; truncated: boolean };

export interface ProjectFolderBrowserResult {
  current_path: string;
  parent_path: string | null;
  folders: Array<{ name: string; path: string }>;
}

/** GET /api/v1/fs/directories, used by the folder-picker dialog. */
export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryShortcut {
  key: string;
  path: string;
  /** Display name for volume and cloud shortcuts. */
  name?: string;
  kind?: 'volume' | 'cloud';
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
  truncated: boolean;
  shortcuts: DirectoryShortcut[];
}

export interface ProjectSetupInput {
  mode: 'existing' | 'new' | 'initialize_existing';
  name: string;
  path: string;
}

export interface UploadedAttachment {
  attachment_id: ULID;
  filename: string;
  mime: string;
  bytes: number;
  sha256: string;
  status: 'stored' | 'quarantined';
}

export interface UploadLimits {
  max_bytes: number;
  max_files: number;
}

/** GET /works/{id}/assurance: recorded review routing, integration verification and plan warnings. */
export interface CoreActivity {
  activity_id: string;
  kind: 'integration_verification' | 'core_tests' | 'merge_verification' | 'git_lane_wait' | 'base_merge';
  command: string[] | null;
  started_at: RFC3339;
  last_output_at: RFC3339 | null;
}

export interface WorkCoreActivity {
  work_id: ULID;
  activities: CoreActivity[];
}

export type AdvisorSessionStatus = 'starting' | 'running' | 'ending' | 'suspended' | 'none';


/** One entry of GET /advisor/windows. */
export interface AdvisorWindow {
  key: string;
  scope: 'general' | 'project';
  project_id: string | null;
  name: string | null;
  window_id: string | null;
  conversation_id: string | null;
  session_status: 'running' | 'starting' | 'suspended' | 'none';
  channels: AdvisorWindowChannel[];
  last_message_at: string | null;
  has_unread: boolean;
}

/** One provider entry of GET /advisor/windows/:key/channels. */
export interface AdvisorWindowChannelState {
  provider: 'slack' | 'discord';
  configured: boolean;
  running: boolean;
  binding: { channel_id: string; display_name: string } | null;
  default_name: string | null;
  owner_user_id_set: boolean;
}

export interface AdvisorActivity {
  state: 'thinking' | 'tool' | 'subagent' | null;
  tool_name: string | null;
  background_count: number;
}

export interface AdvisorSessionInfo {
  status: AdvisorSessionStatus;
  provider_session_id?: string | null;
  model?: string | null;
  effort?: string | null;
  compaction_count?: number;
  last_compaction_at?: RFC3339 | null;
  queued_turns?: number;
  running_turns?: number;
  activity?: AdvisorActivity | null;
  provider_paused_until?: RFC3339 | null;
  created_at?: RFC3339 | null;
  resumed_count?: number;
}

/** GET/PUT /api/v1/settings/advisor-folders. */
export interface AdvisorFolders {
  shared_dir: string;
  screenshot_dir: string;
  defaults: { shared_dir: string; screenshot_dir: string };
  custom: { shared_dir: boolean; screenshot_dir: boolean };
}

/** GET/PUT /api/v1/settings/knowledge-storage. */
export interface KnowledgeStorageStatus {
  path: string;
  default_path: string;
  custom: boolean;
  state: 'available' | 'unavailable' | 'moving';
  reason: string | null;
  checked_at: string | null;
  move: { target: string; stage: string; files_total: number | null; files_done: number } | null;
}




/** GET/PUT /api/v1/settings/advisor-send-file-destination. */
export interface AdvisorSendFileDestination {
  preferred_provider: FileDestinationProvider | null;
  default_destination: { provider: FileDestinationProvider; channel_id: string; display_name: string; available: boolean } | null;
  providers: {
    provider: FileDestinationProvider;
    configured: boolean;
    running: boolean;
    candidates: { channel_id: string; display_name: string; kind: 'conversation' | 'window'; window_name?: string }[];
  }[];
}

export interface AdvisorSendFileDestinationInput {
  preferred_provider: FileDestinationProvider | null;
  default_destination: { provider: FileDestinationProvider; channel_id: string } | null;
}

export interface AdvisorFoldersInput {
  shared_dir: string;
  screenshot_dir: string;
}

/** Legacy Hybrid Worker phase retained for pre-child-run AgentRuns and events. */
export type HybridPhase = 'plan' | 'executing' | 'verdict';

/**
 * How a child agent run came to exist: `spawned` = Owl launched it under a
 * Worker; `observed` = found in an agent process tree. null for ordinary runs.
 */
export type AgentRunOrigin = 'spawned' | 'observed';





// Differs from the server's AgentRun in: effort and child_run_id (web only); status is AgentRunStatus | string on the web and string on the server; outcome is optional with AgentRunOutcome on the web and string | null on the server. The web keeps the wider/optional form so a new run status or a missing outcome still renders.
export interface AgentRun {
  id: ULID;
  /** The Work the run belongs to; null for runs outside any Work. */
  work_id: ULID | null;
  task_id: ULID | null;
  /** worker / reviewer / manager / … / executor (child runs). Open-ended on the wire. */
  role: string;
  provider: string;
  model: string;
  /** Reasoning effort the run was launched with; null when unset or unknown. */
  effort?: string | null;
  status: AgentRunStatus;
  /** Set when the run completed; null otherwise. */
  outcome?: AgentRunOutcome | null;
  pid: number | null;
  started_at: RFC3339 | null;
  ended_at: RFC3339 | null;
  /** When the run last produced output; null before its first output. */
  last_output_at: RFC3339 | null;
  /** For child (executor) runs: the AgentRun that launched it. */
  parent_agent_id: ULID | null;
  /** Durable child_runs record this AgentRun attempt belongs to. */
  child_run_id?: ULID | null;
  /** Legacy Worker phase, retained for older run records. */
  phase: HybridPhase | null;
  /** Legacy Worker runs only: planned subtask count from the old phase flow. */
  subtask_count: number | null;
  /** Child runs: e.g. "s1: Add the migration file" or "codex exec". */
  label: string | null;
  origin: AgentRunOrigin | null;
}

/** How the Worker checked its result (method is '' on reports from before the template). */
export interface ReportVerification {
  passed: boolean;
  method: string;
}

/** One unresolved issue: what, what it affects, what to do next ('' when unknown). */
export interface RemainingIssue {
  issue: string;
  impact: string;
  next_step: string;
}

/** ReportEnvelope — the shape of Report.payload. */
export interface ReportEnvelope {
  schema_version: '1.0.0';
  invocation_id: ULID;
  result: 'success' | 'failed' | 'partial' | 'unknown';
  work_done: string;
  changes: Array<Record<string, unknown>>;
  verification: ReportVerification;
  remaining_issues: RemainingIssue[];
  next_action: string;
  needs_replanning: boolean;
  question_for_manager: string | null;
}

/** POST /api/v1/decisions/{decision_id}/answer payload / response data. */
export interface DecisionAnswerPayload {
  answer: string;
  option_key: string | null;
  source: 'web' | 'slack' | 'discord';
  source_message_id: string | null;
}

export interface DecisionAnswerResult {
  decision_id: ULID;
  status: 'resolved';
  winner: boolean;
  resumed_task_ids: ULID[];
}

// ---- UI aggregate views (not wire DTOs) ------------------------------------

export interface BoardView {
  works: WorkSummary[];
  /** Open decisions, so needs-decision cards can show what is being asked. */
  open_decisions: Decision[];
  /** Projects the screen view returns with the Works (Board and Archive name Projects from these). */
  projects?: Project[];
}

export interface WorkDetailView {
  work: NormalizedWorkDetail;
  /** GET /works/{id}/tasks: leaves out Tasks a Manager replan retired. */
  tasks: TaskSummary[];
  runs: AgentRun[];
  child_runs: ChildRunRecord[];
  reports: Report[];
  decisions: Decision[];
  messages: Message[];
  /** GET /works/{id}/view auto_recovery: recoveries in progress and the acceptance criteria relaxed so far. */
  auto_recovery: AutoRecoveryView;
  /** GET /works/{id}/view goal_shortfalls: goals not met, with reasons; [] when none. */
  goal_shortfalls: GoalShortfallView[];
}

/** GET /works/{id}/view goal_shortfalls: a goal the Work did not meet, and why. */
export interface GoalShortfallView {
  task_id: string | null;
  task_title: string | null;
  criterion_id: string | null;
  text: string;
  reason: string;
  source: 'worker' | 'reviewer' | 'final_check';
  /** Set when a later final check showed the goal met; the row stays. */
  resolution: { evidence: string; resolved_at: string } | null;
}

export interface AutoRecoveryView {
  active: {
    kind: string;
    target_kind: 'work' | 'task';
    target_id: string;
    task_title: string | null;
    attempt_no: number;
    limit: number;
    counted: boolean;
    resume_at: string | null;
    started_at: string;
  }[];
  relaxations: {
    task_id: string;
    task_title: string | null;
    criterion_id: string;
    original: { text: string; check: string };
    relaxed: { text: string; check: string };
    reason: string;
    keeps: string;
    at: string;
  }[];
}

/** Stable, renderable Work shape created by work-detail-safety normalization. */
export interface NormalizedWorkDetail extends WorkSummary {
  owner_id: string;
  project_id: ULID | null;
  summary: string;
  size: 'small' | 'normal' | 'large';
  design_mode: 'auto' | 'lead';
  plan_revision: number;
  progress: WorkProgress;
  conversation_id: ULID | null;
  advisor_backlog: WorkAdvisorBacklog | null;
  prerequisites: WorkPrerequisite[];
  final_report: WorkFinalReport | null;
  prerequisite_wait: boolean;
}

export interface DecisionView {
  decision: Decision;
  work: WorkSummary;
  blocked_tasks: TaskSummary[];
}

/** A run plus the liveness information the Agents screen needs. */
export interface AgentActivity {
  run: AgentRun;
  /** Per-role ordinal within the Work, used for "Worker #7" style labels. */
  ordinal: number;
  last_output_at: RFC3339 | null;
  task: TaskSummary | null;
  work: WorkSummary | null;
  /** Name of the Work's Project, so equal Work numbers in different Projects stay distinct. */
  project_name?: string | null;
}

export interface AgentsView {
  /** agent.idle threshold (default 30 min, 1800 s). */
  idle_threshold_seconds: number;
  /** Top-level live runs (child runs are listed in `children`). */
  running: AgentActivity[];
  /** Top-level ended runs, newest first. */
  recent: AgentActivity[];
  /** Child runs (executors / observed subagents) of the runs above, any status. */
  children: AgentRun[];
}

// ---- Knowledge Base types ------------------------------------------------

export interface KnowledgeSearchResult {
  path: string;
  title: string;
  mtime: RFC3339;
  tags: string[];
  snippet: string;
}

export interface KnowledgeEntry {
  path: string;
  note_id?: ULID | null;
  title: string;
  tags: string[];
  created: string;
  mtime: RFC3339;
  body: string;
}

export type RuleProposalStatus = 'pending' | 'awaiting_approval' | 'applied' | 'rejected' | 'expired' | 'merged';
export type RuleProposalOrigin = 'lesson' | 'note' | 'legacy_policy' | 'metrics';
export type RuleProposalRole = 'advisor' | 'manager' | 'designer' | 'worker' | 'reviewer' | 'librarian' | 'curator';

export interface RuleProposal {
  id: ULID;
  fingerprint: string;
  origin: RuleProposalOrigin;
  level: 'system' | 'role';
  role: RuleProposalRole | null;
  text: string;
  rationale: string;
  applies_to: string;
  note_id: ULID | null;
  source_work_ids_json: string;
  source_work_ids: ULID[];
  source_count: number;
  project_id: ULID | null;
  status: RuleProposalStatus;
  decision: unknown;
  attempts: number;
  last_error: string | null;
  applied_rule_id: string | null;
  applied_path: string | null;
  created_at: RFC3339;
  updated_at: RFC3339;
}

export interface RuleProposalCommandResult {
  proposal_id: ULID;
  status: 'applied' | 'rejected';
  applied_rule_id: string | null;
  applied_path: string | null;
}


// ---- Skill Box types -------------------------------------------------------

/** skills.state CHECK. */
export type SkillState = 'active' | 'stale' | 'archived';
/** skill_revisions.actor CHECK. */
export type SkillActor = 'curator' | 'user';
/** skill_revisions.action CHECK. */
export type SkillAction =
  | 'create'
  | 'update'
  | 'merge'
  | 'state_change'
  | 'scope_change'
  | 'restore'
  | 'rollback'
  | 'external_edit';
/** skill_proposals.kind CHECK. */
export type SkillProposalKind = 'new' | 'update';
/** skill_proposals.status CHECK. */
export type SkillProposalStatus = 'pending' | 'awaiting_approval' | 'applied' | 'rejected';
/** SkillSettings.mode enum. */
export type SkillSettingsMode = 'autonomous' | 'conservative';

export interface SkillTrialProgress {
  evaluations: number;
  misleading: number;
}

export interface SkillOriginatingWork {
  id: ULID;
  title: string | null;
}

/** Bare skill row, as returned by GET /skills/{name} (nested under `skill`) and PATCH /skills/{name}. */
export interface SkillRecord {
  name: string;
  description: string;
  tags: string[];
  scope: string;
  project_id: string | null;
  state: SkillState;
  trial: 0 | 1;
  content_hash: string;
  current_revision: number;
  use_count: number;
  last_used_at: RFC3339 | null;
  state_changed_at: RFC3339;
  created_at: RFC3339;
  updated_at: RFC3339;
  /** Non-null when the skill's files could not be read from disk (missing/unreadable directory). */
  broken_reason: string | null;
}

/** GET /skills row: SkillRecord plus the feedback counts and trial/origin data the list screen needs. */
export interface SkillListItem extends SkillRecord {
  trial_progress: SkillTrialProgress | null;
  helpful_count: number;
  misleading_count: number;
  irrelevant_count: number;
  originating_work: SkillOriginatingWork | null;
  has_scripts: boolean;
}

/** One entry of GET /skills/{name} data's `recent_uses`: a past use of the skill and how it was judged. */
export interface SkillRecentUse {
  agent_run_id: ULID;
  role: string | null;
  verdict: 'helpful' | 'misleading' | 'irrelevant' | null;
  note: string | null;
  work_id: ULID | null;
  work_title: string | null;
  revision: number;
  used_at: RFC3339;
}

/** GET /skills/{name} data. `files` maps a relative path (e.g. "references/x.md") to its content. */
export interface SkillDetailData {
  skill: SkillRecord;
  body: string;
  files: Record<string, string>;
  /** UTF-8 byte size of each file in `files`, keyed the same way. */
  file_sizes: Record<string, number>;
  /** Up to 50 most recent uses, newest first. */
  recent_uses: SkillRecentUse[];
}

export interface SkillRevision {
  id: ULID;
  skill_name: string;
  revision: number;
  actor: SkillActor;
  action: SkillAction;
  content_hash: string;
  source_proposal_id: string | null;
  source_work_id: string | null;
  source_work_title: string | null;
  source_agent_run_id: string | null;
  reason: string;
  created_at: RFC3339;
  /** False for revisions whose file snapshot was pruned; such revisions cannot be restored. */
  has_snapshot: boolean;
  /** Present only on GET .../revisions/{revision_id} (the list endpoint omits it). */
  files?: Record<string, string> | null;
}

/** The Curator's judgement of a proposal (reusability/confidence score and its reasoning). */
export interface SkillProposalJudgement {
  reusability: number | null;
  confidence: number | null;
  reason: string | null;
  relation: string | null;
}

export interface SkillProposal {
  id: string;
  kind: SkillProposalKind;
  target_skill: string | null;
  /** The raw proposal from the Agent (e.g. summary, steps_or_diff, evidence, target); null when unreadable. */
  payload: Record<string, unknown> | null;
  source_work_id: string | null;
  source_agent_run_id: string | null;
  project_id: string | null;
  status: SkillProposalStatus;
  decision: Record<string, unknown> | null;
  judgement: SkillProposalJudgement;
  written_content: Record<string, string> | null;
  current_content: Record<string, string> | null;
  attempts: number;
  last_error: string | null;
  applied_revision_id: ULID | null;
  created_at: RFC3339;
  updated_at: RFC3339;
}

/** GET /skill-activity data: counts of Curator actions over the trailing window. */
export interface SkillActivity {
  days: number;
  created: number;
  revised: number;
  rejected: number;
  rolled_back: number;
}

/**
 * Outcome of approving/rejecting a proposal. "applied" is a normal approval;
 * an approve can also come back "rejected" (the Curator rejected it while
 * writing) or "awaiting_approval" (the written result touches scripts/ and
 * needs another approval pass).
 */
export interface SkillProposalCommandResult {
  proposal_id: string;
  status: SkillProposalStatus;
  applied_revision_id: string | null;
}

export interface SkillSettings {
  mode: SkillSettingsMode;
  confidence_threshold: number;
  stale_days: number;
  archived_days: number;
  max_items: number;
  max_characters: number;
}

export interface DetectedProcessSkillsPack {
  skills_dir: string;
  version: string | null;
  source: 'setting' | 'claude' | 'codex';
}


export interface ProcessSkillsSettingsData {
  enabled: boolean;
  /** Absolute path to a valid pack root or skills directory; null means automatic detection. */
  path: string | null;
  detected: DetectedProcessSkillsPack | null;
  /** Commands that install the missing pack, one per harness CLI Owl could find. Owl only shows these; it never runs them. */
  install_commands: ProcessSkillsInstallCommand[];
}

export interface KnowledgeAutomationSettingsInput {
  librarian_times: string[];
  research_autosave: boolean;
}

export interface KnowledgeAutomationSettingsData extends KnowledgeAutomationSettingsInput {
  next_librarian_run_at: string | null;
  next_skill_curation_run_at: string | null;
  next_rule_curation_run_at: string | null;
  time_zone: string;
}

// ---- Automatic Work creation ----------------------------------------------


export interface AutoWorkEnabled {
  effective: boolean;
  from: AutoWorkEnabledFrom;
}


export interface AutoWorkListState {
  since: string | null;
  last_polled_at: string | null;
  last_completed_at: string | null;
  last_error: string | null;
  pending_items: number;
  failed_items: number;
}

export interface AutoWorkProjectSettings {
  project_id: string;
  project_name: string | null;
  enabled: AutoWorkEnabled;
  config_file_present: boolean;
  scheduled_check: { times: string[]; items: string[]; next_run_at: string | null; last_run_at: string | null };
  watch: { logs: number; commands: number; last_error: string | null };
  github: {
    repo: string | null;
    poll_minutes: number;
    max_items_per_poll: number;
    since_margin_seconds: number;
    allowed_users: string[];
    require_labels: string[];
    mention: string | null;
    last_polled_at: string | null;
    last_error: string | null;
    lists: { issues: AutoWorkListState; comments: AutoWorkListState };
  };
  rules: AutoWorkRule[];
  today: { created: number; cap: number };
}

export interface AutoWorkSettings {
  enabled: AutoWorkEnabled;
  judge_role: string | null;
  limits: {
    max_works_per_day: number | null;
    max_works_per_day_all: number | null;
    day_start_time: string | null;
    cooldown_hours: number | null;
  };
  config_error: string | null;
  files: { defaults: string; local: string | null; projects_dir: string };
  today: { day_key: string | null; created_all: number; cap_all: number | null };
  projects: AutoWorkProjectSettings[];
}

export interface AutoWorkEventView {
  id: string;
  project_id: string;
  project_name: string | null;
  source: AutoWorkSource;
  kind: string;
  rule_id: string | null;
  title: string;
  verdict: AutoWorkVerdict;
  verdict_reason: string;
  work_id: string | null;
  work_display_number: number | null;
  work_title: string | null;
  work_state: string | null;
  duplicate_of_work_id: string | null;
  duplicate_of_work_display_number: number | null;
  duplicate_of_event_id: string | null;
  action: 'draft' | 'start' | null;
  action_error: string | null;
  github_repo: string | null;
  github_issue_number: number | null;
  github_author: string | null;
  github_url: string | null;
  github_comment_url: string | null;
  github_pr_url: string | null;
  occurred_at: string;
  created_at: string;
}

export interface AutoWorkEventDetail extends AutoWorkEventView {
  detail: string;
  judge_json: unknown | null;
  dedupe_key: string;
  day_key: string;
  github_updated_at: string | null;
}

export interface AutoWorkEventFilter {
  projectId?: string;
  source?: string;
  verdict?: string;
  offset?: number;
  limit?: number;
}

export interface AutoWorkRunResult {
  project_id: string;
  what: string;
  events: AutoWorkEventView[];
}

// ---- Usage reporting ------------------------------------------------------













// ---- Skill Box UI aggregate views ------------------------------------------

/** Skill list screen filter, mirrored from the GET /skills query parameters. */
export interface SkillListFilter {
  q?: string;
  state?: SkillState;
  scope?: string;
  trial?: boolean;
}

/** One row of an owner-invite result, shaped for display. */
export interface OwnerInviteLine {
  name: string | null;
  invite: 'invited' | 'already_in_channel' | 'failed';
  message?: string;
}
