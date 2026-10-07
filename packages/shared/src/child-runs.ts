import { CLAUDE_SONNET_5_5_MODEL, DEFAULT_HARNESS_MODELS } from "./harness-models.js";

export const CHILD_RUN_PROVIDERS = ["claude", "codex"] as const;
export type ChildRunProvider = (typeof CHILD_RUN_PROVIDERS)[number];
export const CHILD_RUN_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ChildRunEffort = (typeof CHILD_RUN_EFFORTS)[number];
export type ChildRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ChildRunBlockedReason = "write_scope" | "provider_paused";
export type ChildRunFailureKind =
  | "timeout" | "idle_timeout" | "exit_code" | "no_final_report" | "reported_error" | "spawn_error"
  | "output_limit" | "rate_limited" | "cancelled" | "parent_ended" | "core_restart";

export const CHILD_RUN_LIMITS = {
  wait_max_seconds: 240,
  wait_max_ids: 16,
  max_children_per_parent: 20,
  title_max_chars: 120,
  instruction_max_chars: 20_000,
  write_paths_max: 50,
  summary_max_chars: 1200,
  changed_files_max: 40,
  checks_max: 8,
  remaining_issues_max: 5,
  failure_reason_max_chars: 600,
  child_summary_max_bytes: 3 * 1024,
  wait_response_max_bytes: 16 * 1024,
  rate_limit_requeue_max: 3,
} as const;

export interface ChildDispatchRequest {
  readonly title: string; readonly instruction: string; readonly write_paths: readonly string[];
  readonly provider?: ChildRunProvider; readonly model?: string; readonly effort?: ChildRunEffort;
  readonly timeout_minutes?: number;
}
export interface ChildDispatchResponse {
  readonly child_id: string; readonly status: "queued" | "running"; readonly blocked_reason: ChildRunBlockedReason | null;
  readonly provider: ChildRunProvider; readonly model: string; readonly effort: ChildRunEffort | null;
  readonly timeout_minutes: number; readonly max_attempts: number;
}
export interface ChildWaitRequest {
  readonly child_ids: readonly string[]; readonly return_when?: "all" | "any"; readonly timeout_seconds?: number;
}
export interface ChildRunSummary {
  readonly result: "succeeded" | "partial" | "failed";
  readonly summary: string;
  readonly changed_files: readonly string[];
  readonly checks: readonly { readonly command: string; readonly passed: boolean }[];
  readonly remaining_issues: readonly string[];
  readonly failure: { readonly kind: ChildRunFailureKind; readonly reason: string } | null;
  readonly attempts: number;
  readonly duration_seconds: number;
  readonly report_format: "structured" | "fallback";
}
export interface ChildWaitItem {
  readonly child_id: string; readonly title: string; readonly status: ChildRunStatus;
  readonly blocked_reason: ChildRunBlockedReason | null; readonly attempt: number;
  readonly summary: ChildRunSummary | null; readonly summary_omitted: boolean;
}
export interface ChildWaitResponse { readonly done: boolean; readonly truncated: boolean; readonly children: readonly ChildWaitItem[] }
export interface ChildRunListFilter { readonly work_id?: string; readonly task_id?: string; readonly parent_agent_run_id?: string }
export interface ChildRunRecord {
  readonly id: string; readonly work_id: string; readonly task_id: string; readonly parent_agent_run_id: string;
  readonly seq: number; readonly title: string; readonly instruction: string; readonly write_paths: readonly string[];
  readonly provider: ChildRunProvider; readonly model: string; readonly effort: ChildRunEffort | null;
  readonly timeout_ms: number; readonly max_attempts: number; readonly attempt: number;
  readonly status: ChildRunStatus; readonly blocked_reason: ChildRunBlockedReason | null;
  readonly current_agent_run_id: string | null; readonly summary: ChildRunSummary | null; readonly report_text: string | null;
  readonly failure_kind: ChildRunFailureKind | null; readonly failure_reason: string | null;
  readonly created_at: string; readonly started_at: string | null; readonly finished_at: string | null; readonly updated_at: string;
}

export interface ChildRunModelChoice { readonly provider: ChildRunProvider; readonly model: string }
export interface ChildRunHarnessDefault extends ChildRunModelChoice { readonly effort: ChildRunEffort | null }
export interface ChildRunSettings {
  readonly default_provider: ChildRunProvider;
  readonly default_model: string;
  readonly default_effort: ChildRunEffort | null;
  readonly defaults_by_parent_harness: Readonly<Record<ChildRunProvider, ChildRunHarnessDefault>>;
  readonly allowed_models: readonly ChildRunModelChoice[];
  readonly allowed_efforts: readonly ChildRunEffort[];
  readonly timeout_minutes: number;
  readonly max_timeout_minutes: number;
  readonly max_attempts: number;
}
export const DEFAULT_CHILD_RUN_SETTINGS: ChildRunSettings = {
  default_provider: "claude",
  default_model: DEFAULT_HARNESS_MODELS.claude,
  default_effort: "medium",
  defaults_by_parent_harness: {
    claude: { provider: "codex", model: "gpt-5.6-luna", effort: "medium" },
    codex: { provider: "claude", model: CLAUDE_SONNET_5_5_MODEL, effort: "medium" },
  },
  allowed_models: [
    { provider: "claude", model: DEFAULT_HARNESS_MODELS.claude },
    { provider: "claude", model: CLAUDE_SONNET_5_5_MODEL },
    { provider: "codex", model: "gpt-5.6-luna" },
  ],
  allowed_efforts: ["low", "medium", "high"],
  timeout_minutes: 60,
  max_timeout_minutes: 180,
  max_attempts: 2,
};

export type DelegationMismatchKind = "delegation_missing" | "unknown_child" | "unreported_child" | "unfinished_child" | "missing_reason";
export interface WorkerDelegationReport {
  readonly split: string;
  readonly children: readonly { readonly child_id: string; readonly assignment: string; readonly outcome: "used" | "fixed_by_worker" | "redone" | "discarded" }[];
  readonly kept: readonly { readonly work: string; readonly reason: string }[];
}
