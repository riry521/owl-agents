// API response shapes that the server returns and the web reads with the same fields.
// They live here so a field added on one side fails the other side's typecheck.

import type { JsonObject, ModelEffort, WorkStateValue } from "./index.js";

export type BacklogStatus = "open" | "in_progress" | "done" | "dismissed";

export type IntegrationProvider = "slack" | "discord";

export interface IntegrationTestResult {
  provider: IntegrationProvider;
  ok: boolean;
  detail: string;
  tested_at: string;
}

export interface WorkProgress {
  total_tasks: number;
  completed_tasks: number;
  percent: number;
}

export interface TaskPrerequisite {
  reason: string;
  source: "manager" | "worker";
  conditions: { kind: string; target: string | null; description: string }[];
  deadline_at: string;
  since: string | null;
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

export interface RuntimeConfig {
  base_path: "/owl/";
  api_base: "/api/v1";
  ws_url: string;
  schema_version: "1.0.0";
}

/** Known Work states plus future values returned by newer servers. */
export type WorkState = WorkStateValue | (string & {});

export type FileDestinationProvider = "slack" | "discord";

export type ProjectBlocker = "running_works" | "active_agents";

export interface ProjectRunningWork {
  id: string;
  display_number: number | null;
  title: string;
  state: "running" | "paused" | "judgement_waiting";
}

export interface DetachedWork {
  work_id: string;
  previous_display_number: number | null;
  display_number: number | null;
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

/** DELETE /api/v1/projects/:id response data. */
export interface DeleteProjectResult {
  project_id: string;
  deleted: true;
  detached_work_count: number;
  detached_backlog_item_count: number;
  detached_works: DetachedWork[];
}

/** A prerequisite Work as shown to the Owner; state is null once the Work was deleted. */
export interface WorkPrerequisite {
  work_id: string;
  project_id: string | null;
  project_name: string | null;
  display_number: number | null;
  title: string;
  state: WorkState | null;
  deleted: boolean;
  satisfied: boolean;
}

export interface InstructionReplyMetadata {
  kind: "instruction_reply";
  in_reply_to: string[];
  outcome: "tasks_changed" | "no_change" | "decision_opened";
  plan_revision: number | null;
}

/** Message.metadata of a Web Advisor reply that asked Core to send files. */
export interface AdvisorFileDeliveryMetadata {
  kind: "advisor_file_delivery";
  destination: {
    provider: FileDestinationProvider;
    channel_id: string;
    display_name: string;
    source: "window_binding" | "default_destination";
  } | null;
  refusal: "preferred_provider_unset" | "default_destination_unset" | "default_provider_not_configured" | "default_channel_unavailable" | null;
  files: {
    index: number;
    name: string;
    size: number | null;
    status: "pending" | "sent" | "failed" | "unknown" | "rejected";
    code?: string;
    message?: string;
  }[];
  notice?: string;
}

export type MessageMetadata = InstructionReplyMetadata | AdvisorFileDeliveryMetadata;

export interface MessageAttachment {
  id: string;
  filename: string;
  mime: string;
  bytes: number;
  status: "stored" | "quarantined";
}

export interface Message {
  id: string;
  conversation_id: string;
  source: "slack" | "discord" | "web" | "advisor" | "manager" | (string & {});
  body: string;
  attachment_ids: string[];
  /** Present only when the message has attachments. Never carries a file path. */
  attachments?: MessageAttachment[];
  created_at: string;
  metadata?: MessageMetadata | null;
}

export interface InstructionStatus {
  status: "queued" | "processing" | "answered";
  outcome: InstructionReplyMetadata["outcome"] | null;
  reply_message_id: string | null;
}

export interface WorkConversationMessage extends Message {
  received_at: string;
  instruction: InstructionStatus | null;
  in_reply_to: string[];
}

export interface WorkConversation {
  work_id: string;
  conversation_id: string | null;
  truncated: boolean;
  messages: WorkConversationMessage[];
}

/** PUT /api/v1/settings/models payload row. */
export interface RoleModelSettingInput {
  // Core's ActorRole (which has lead_designer and fixer). The ActorRole in ./index.ts is the narrower rule-role set.
  role: "advisor" | "manager" | "designer" | "lead_designer" | "worker" | "fixer" | "reviewer" | "librarian" | "curator";
  provider: string;
  model: string;
  effort: ModelEffort;
}

export interface Report {
  id: string;
  agent_run_id: string;
  schema_version: string;
  result: "success" | "failed" | "partial";
  /** `payload:object` on the wire. In practice a ReportEnvelope. */
  payload: Record<string, unknown>;
  created_at: string;
}

export interface WorkAssurance {
  work_id: string;
  reviews: {
    task_id: string;
    required: boolean;
    base: string;
    skip_reason: string | null;
    forced_reasons: { code: string; detail: string }[];
  }[];
  integration_verification: Record<string, unknown> | null;
  plan_quality_warnings: Record<string, unknown>[];
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

/** PATCH /api/v1/projects/:id payload. */
export interface UpdateProjectInput {
  name?: string;
  canonical_path?: string;
  base_branch?: string;
  auto_push?: boolean;
  advisor_window_enabled?: boolean;
  commit_language?: "ja" | "en" | null;
  worktree_setup_command?: string[];
  worktree_refresh_command?: string[];
  post_merge_command?: string[] | null;
  post_merge_install_command?: string[] | null;
  required_test_command?: string[] | null;
  /** null = automatic, { mode: 'whole', whole_argv } = this command, { mode: 'off' } = no tests. */
  test_run?: Record<string, unknown> | null;
  test_policy?: Record<string, unknown> | null;
  report_check_commands?: string[] | null;
  screen_paths?: { include: string[]; exclude?: string[] } | null;
  verification_plan?: VerificationCommand[];
}

/** Extends JsonObject because the server returns it as an open object in lists. */
export interface IntegrationStatus extends JsonObject {
  provider: IntegrationProvider;
  configured: boolean;
  conversation_channel_id: string | null;
  notification_channel_id: string | null;
  owner_user_id: string | null;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
}
