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

// ---- common scalars ---------------------------------------------------------

/** string(pattern ^[0-9A-HJKMNP-TV-Z]{26}$) */
export type ULID = string;
/** string(format date-time) */
export type RFC3339 = string;

// ---- states ------------------------------------------------------------------

/** Known Work states plus future values returned by newer servers. */
export type WorkState =
  | 'memo'
  | 'ready'
  | 'running'
  | 'paused'
  | 'judgement_waiting'
  | 'completed'
  | 'cancelled'
  | (string & {});

/** Task states: every value that appears in the Task transition table. */
export type TaskState =
  | 'waiting'
  | 'ready'
  | 'running'
  | 'verifying'
  | 'review_fix_waiting'
  | 'failed'
  | 'judgement_waiting'
  | 'completed'
  | 'paused'
  | 'cancelled';

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

export interface WorkSummary {
  id: ULID;
  display_number?: number | null;
  title: string;
  state: WorkState;
  state_version: number;
  updated_at: RFC3339;
  archived_at: RFC3339 | null;
  project_id?: ULID | null;
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
}

export interface WorkProgress {
  total_tasks: number;
  completed_tasks: number;
  percent: number;
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

export interface DeleteWorkResult {
  work_id: ULID;
  deleted: true;
}

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
}

export interface TaskPrerequisite {
  reason: string;
  source: "manager" | "worker";
  conditions: { kind: string; target: string | null; description: string }[];
  deadline_at: RFC3339;
  since: RFC3339 | null;
}

export interface TaskDetail extends TaskSummary {
  parent_task_id: ULID | null;
  acceptance: string;
  review_round: number;
  total_review_attempts: number;
  failure_count: number;
  worker_generation: number;
}

export interface Report {
  id: ULID;
  agent_run_id: ULID;
  schema_version: string;
  result: 'success' | 'failed' | 'partial';
  /** `payload:object` on the wire. In practice a ReportEnvelope. */
  payload: Record<string, unknown>;
  created_at: RFC3339;
}

/** Review backlog item lifecycle state. */
export type BacklogStatus = 'open' | 'in_progress' | 'done' | 'dismissed';

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
export interface LinkBacklogItemsResult {
  work_id: ULID;
  status: 'in_progress' | 'done';
  items: BacklogItem[];
}

/** POST /api/v1/backlog/issue-work data. */
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
}

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
}

/** GET/PUT /api/v1/settings/models role-model row. */
export interface RoleModelSetting {
  role: string;
  provider: string;
  model: string;
  effort: string;
  catalog_version: string;
}

/** PUT /api/v1/settings/models payload row. */
export interface RoleModelSettingInput {
  role: 'advisor' | 'manager' | 'designer' | 'lead_designer' | 'worker' | 'reviewer' | 'librarian' | 'curator';
  provider: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

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

export type IntegrationProvider = 'slack' | 'discord';

export interface IntegrationStatus {
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

export interface ExecutorConfig {
  provider: string;
  model: string;
  effort?: string;
  timeout_ms: number;
}

export interface ChildRunSettings {
  default_provider: ChildRunProvider;
  default_model: string;
  default_effort: ChildRunEffort | null;
  defaults_by_parent_harness: Record<ChildRunProvider, {
    provider: ChildRunProvider;
    model: string;
    effort: ChildRunEffort | null;
  }>;
  allowed_models: { provider: ChildRunProvider; model: string }[];
  allowed_efforts: ChildRunEffort[];
  timeout_minutes: number;
  max_timeout_minutes: number;
  max_attempts: number;
  token_relay: {
    models: { provider: 'claude'; model: string }[];
    handoff_tokens: number;
    kill_tokens: number;
    max_relays: number;
    report_threshold_tokens: number;
  };
  research_subagent: {
    claude: { model: string; max_turns: number };
    codex: { model: string; max_turns: number };
    answer_max_chars: number;
  };
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

export interface ProviderPauseView {
  provider: string;
  label: string;
  state: 'paused' | 'probing';
  paused_at: string;
  resume_at: string;
  resume_source: 'reported' | 'backoff';
  reported_resets_at: string | null;
  backoff_step: number;
  last_error: string | null;
  last_role: string | null;
}

export interface SaveProviderPayload {
  id?: string;
  displayName: string;
  harnessId: string;
  backendUrl?: string;
  apiKeySource?: string;
}

/** Whether Core's test check runs for a Project (source: explicit = Owner's test_run, detected = automatic). */
export interface TestRunStatus {
  enabled: boolean;
  reason: string | null;
  command: string[] | null;
  source: 'explicit' | 'detected';
}

/** GET/POST /api/v1/projects. */
export interface Project {
  id: string;
  name: string;
  canonical_path: string;
  auto_push?: boolean;
  worktree_setup_command?: string[];
  worktree_refresh_command?: string[];
  post_merge_command?: string[] | null;
  effective_post_merge_command?: string[];
  post_merge_install_command?: string[] | null;
  test_run_status?: TestRunStatus;
  base_branch: string;
  allowed_roots: string[];
  verification_plan: unknown[];
}

/** PATCH /api/v1/projects/:id payload. */
export interface UpdateProjectInput {
  name?: string;
  canonical_path?: string;
  auto_push?: boolean;
  worktree_setup_command?: string[];
  worktree_refresh_command?: string[];
  post_merge_command?: string[] | null;
  post_merge_install_command?: string[] | null;
}

export type ProjectBlocker = 'running_works' | 'active_agents';

export interface ProjectRunningWork {
  id: string;
  display_number: number | null;
  title: string;
  state: 'running' | 'paused' | 'judgement_waiting';
}

/** GET /api/v1/projects/:id/deletion-impact response data. */
export interface ProjectDeletionImpact {
  project_id: string;
  work_count: number;
  running_work_count: number;
  active_agent_count: number;
  backlog_item_count: number;
  running_works: ProjectRunningWork[];
  blockers: ProjectBlocker[];
  deletable: boolean;
}

export interface DetachedWork {
  work_id: string;
  previous_display_number: number | null;
  display_number: number | null;
}

/** DELETE /api/v1/projects/:id response data. */
export interface DeleteProjectResult {
  project_id: string;
  deleted: true;
  detached_work_count: number;
  detached_backlog_item_count: number;
  detached_works: DetachedWork[];
}

/** POST /api/v1/projects payload. */
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

export interface Message {
  id: ULID;
  conversation_id: ULID;
  source: 'slack' | 'discord' | 'web' | 'advisor' | 'manager' | (string & {});
  body: string;
  attachment_ids: ULID[];
  created_at: RFC3339;
  metadata?: {
    kind: 'instruction_reply';
    in_reply_to: ULID[];
    outcome: 'tasks_changed' | 'no_change' | 'decision_opened';
    plan_revision: number | null;
  } | null;
}

export interface InstructionStatus {
  status: 'queued' | 'processing' | 'answered';
  outcome: 'tasks_changed' | 'no_change' | 'decision_opened' | null;
  reply_message_id: ULID | null;
}

export interface WorkConversationMessage extends Message {
  received_at: string;
  instruction: InstructionStatus | null;
  in_reply_to: ULID[];
}

export interface WorkConversation {
  work_id: ULID;
  conversation_id: ULID | null;
  truncated: boolean;
  messages: WorkConversationMessage[];
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

export interface WorkAssurance {
  work_id: ULID;
  reviews: { task_id: ULID; required: boolean; base: string; skip_reason: string | null; forced_reasons: { code: string; detail: string }[] }[];
  integration_verification: Record<string, unknown> | null;
  plan_quality_warnings: Record<string, unknown>[];
}

export type AdvisorSessionStatus = 'starting' | 'running' | 'ending' | 'suspended' | 'none';

export interface AdvisorSessionInfo {
  status: AdvisorSessionStatus;
  provider_session_id?: string | null;
  model?: string | null;
  effort?: string | null;
  compaction_count?: number;
  last_compaction_at?: RFC3339 | null;
  queued_turns?: number;
  running_turns?: number;
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

/** GET/PUT /api/v1/settings/remake-limits. */
export interface RemakeLimitSettings {
  lineage_review_attempts: number;
  lineage_worker_runs: number;
  non_functional_remakes: number;
  base_sync_lineage_review_attempts: number;
  base_sync_lineage_worker_runs: number;
  lead_review_rejections: number;
  verification_paths: string[];
  checked_task_types: string[];
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

export type ChildRunProvider = 'claude' | 'codex';
export type ChildRunEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ChildRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | (string & {});

export interface ChildRunSummary {
  result: 'succeeded' | 'partial' | 'failed';
  summary: string;
  changed_files: string[];
  checks: Array<{ command: string; passed: boolean }>;
  remaining_issues: string[];
  failure: { kind: string; reason: string } | null;
  attempts: number;
  duration_seconds: number;
  report_format: 'structured' | 'fallback';
}

/** Durable child execution record returned by GET /api/v1/child-runs. */
export interface ChildRunRecord {
  id: ULID;
  work_id: ULID;
  task_id: ULID;
  parent_agent_run_id: ULID;
  seq: number;
  title: string;
  instruction: string;
  write_paths: string[];
  provider: ChildRunProvider;
  model: string;
  effort: ChildRunEffort | null;
  timeout_ms: number;
  max_attempts: number;
  attempt: number;
  status: ChildRunStatus;
  blocked_reason: string | null;
  current_agent_run_id: ULID | null;
  summary: ChildRunSummary | null;
  report_text: string | null;
  failure_kind: string | null;
  failure_reason: string | null;
  created_at: RFC3339;
  started_at: RFC3339 | null;
  finished_at: RFC3339 | null;
  updated_at: RFC3339;
}

export interface ChildRunListFilter {
  work_id?: ULID;
  task_id?: ULID;
  parent_agent_run_id?: ULID;
}

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

/** GET /api/v1/runtime-config.json. */
export interface RuntimeConfig {
  base_path: '/owl/';
  api_base: '/api/v1';
  ws_url: string;
  schema_version: '1.0.0';
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

export interface RuleProposalCreateResult {
  proposal_id: ULID;
  status: RuleProposalStatus;
  already_recorded: boolean;
  merged_into?: ULID;
  last_error?: string;
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

export interface ProcessSkillsInstallCommand {
  harness: 'claude' | 'codex';
  command: string;
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

// ---- Usage reporting ------------------------------------------------------

export type TokenUsagePeriod = 'today' | '7d' | '30d';
export type TokenUsageHarness = 'claude' | 'codex' | 'other';
export type TokenUsageRole = 'advisor' | 'manager' | 'designer' | 'worker' | 'reviewer' | 'executor';

export interface TokenUsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  runs: number;
}

export interface TokenUsageMetrics {
  uncached_input_tokens: number;
  tokens_after_first_review: number;
  first_review_pass_rate: number | null;
  completed_tasks: number;
  uncached_input_tokens_per_completed_task: number | null;
  runs_per_completed_task: number | null;
}

export interface TokenUsageTaskTotals {
  task_id: string;
  work_id: string;
  title: string;
  status: string;
  first_review_verdict: string | null;
  first_review_pass_rate: 0 | 1 | null;
  uncached_input_tokens: number;
  tokens_after_first_review: number;
  totals: TokenUsageTotals;
}

export interface TokenUsageWorkTotals {
  work_id: string;
  title: string | null;
  display_number: number | null;
  project_id: string | null;
  state: string | null;
  totals: TokenUsageTotals;
  metrics: TokenUsageMetrics;
}

export interface TokenUsageReport {
  period: TokenUsagePeriod;
  since: string;
  until: string;
  time_zone: string;
  totals: TokenUsageTotals;
  runs_without_usage: number;
  daily: { date: string; totals: TokenUsageTotals }[];
  by_work: TokenUsageWorkTotals[];
  by_task: TokenUsageTaskTotals[];
  by_harness: { harness: TokenUsageHarness; totals: TokenUsageTotals }[];
  by_role: { role: TokenUsageRole; totals: TokenUsageTotals; metrics: TokenUsageMetrics }[];
  by_model: { provider: string; model: string; harness: TokenUsageHarness; totals: TokenUsageTotals }[];
  top_works: TokenUsageWorkTotals[];
}

export interface PlanUsageSettings {
  claude_usage_api_enabled: boolean;
  poll_interval_minutes: number;
}

export type PlanUsageHarness = 'claude' | 'codex';
export type PlanUsageWindowKind = 'five_hour' | 'weekly' | 'weekly_opus' | 'weekly_sonnet' | 'weekly_oauth_apps' | 'other';
export type PlanUsageOrigin = 'claude_usage_api' | 'claude_rate_limit_event' | 'codex_live' | 'codex_session_log';
export type PlanUsageStatus =
  | 'ok' | 'disabled' | 'not_configured' | 'not_logged_in' | 'expired' | 'unauthorized'
  | 'rate_limited' | 'unavailable' | 'unrecognized' | 'error' | 'not_installed' | 'no_data';

export interface PlanUsageWindow {
  id: string;
  kind: PlanUsageWindowKind;
  used_percent: number | null;
  resets_at: string | null;
  window_minutes: number | null;
  state: 'normal' | 'warning' | 'limited' | null;
  label: string | null;
}

export interface PlanUsageSnapshot {
  harness: PlanUsageHarness;
  origin: PlanUsageOrigin;
  windows: PlanUsageWindow[];
  plan_type: string | null;
  observed_at: string;
}

export interface PlanUsageHarnessView {
  harness: PlanUsageHarness;
  status: PlanUsageStatus;
  detail: string | null;
  display: PlanUsageSnapshot | null;
  display_origin: PlanUsageOrigin | null;
  fallback: boolean;
  stale: boolean;
  checked_at: string | null;
  next_check_at: string | null;
}

export interface PlanUsageView {
  generated_at: string;
  settings: PlanUsageSettings;
  claude: PlanUsageHarnessView;
  codex: PlanUsageHarnessView;
}

// ---- Skill Box UI aggregate views ------------------------------------------

/** Skill list screen filter, mirrored from the GET /skills query parameters. */
export interface SkillListFilter {
  q?: string;
  state?: SkillState;
  scope?: string;
  trial?: boolean;
}
