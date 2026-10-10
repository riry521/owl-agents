import { CLAUDE_HAIKU_5_5_MODEL, CLAUDE_SONNET_5_5_MODEL, CODEX_GPT_6_LUNA_MODEL, DEFAULT_HARNESS_MODELS } from "./harness-models.js";

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
  relay_tokens_min: 1_000,
  relay_tokens_max: 1_000_000,
  report_threshold_max: 10_000_000,
  max_relays_max: 20,
  relay_models_max: 10,
  research_turns_min: 2,
  research_turns_max: 100,
  research_answer_chars_min: 200,
  research_answer_chars_max: 8_000,
  handoff_memo_max_chars: 6_000,
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
  /** Times Owl restarted this child from a handoff memo (token relay); separate from attempt. */
  readonly relay_count: number;
}

export interface ChildRunModelChoice { readonly provider: ChildRunProvider; readonly model: string }
export interface ChildRunHarnessDefault extends ChildRunModelChoice { readonly effort: ChildRunEffort | null }
export interface TokenRelaySettings {
  /** Children whose prompt size Owl watches. Claude only: Owl reads Claude's stream-json usage and Claude hooks. */
  readonly models: readonly { readonly provider: "claude"; readonly model: string }[];
  readonly handoff_tokens: number;
  readonly kill_tokens: number;
  /** Restarts allowed before the child is returned to its Worker. */
  readonly max_relays: number;
  /** Default threshold when counting large requests. */
  readonly report_threshold_tokens: number;
}
export interface ResearchSubagentChoice { readonly model: string; readonly max_turns: number }
export interface ResearchSubagentSettings {
  readonly claude: ResearchSubagentChoice;
  readonly codex: ResearchSubagentChoice;
  readonly answer_max_chars: number;
}
/** Prompt-size limits the Executor enforces on one relay-watched child segment. */
export interface ExecutorRelayConfig { readonly handoff_tokens: number; readonly kill_tokens: number }
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
  readonly token_relay: TokenRelaySettings;
  readonly research_subagent: ResearchSubagentSettings;
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
    { provider: "claude", model: CLAUDE_SONNET_5_5_MODEL },
    { provider: "codex", model: "gpt-5.6-luna" },
    { provider: "claude", model: CLAUDE_HAIKU_5_5_MODEL },
  ],
  allowed_efforts: ["low", "medium", "high"],
  timeout_minutes: 60,
  max_timeout_minutes: 180,
  max_attempts: 2,
  token_relay: {
    models: [{ provider: "claude", model: CLAUDE_HAIKU_5_5_MODEL }],
    handoff_tokens: 70_000,
    kill_tokens: 95_000,
    max_relays: 5,
    report_threshold_tokens: 100_000,
  },
  research_subagent: {
    // 12 turns: Haiku spends one extra turn loading WebSearch through ToolSearch.
    claude: { model: CLAUDE_HAIKU_5_5_MODEL, max_turns: 12 },
    codex: { model: CODEX_GPT_6_LUNA_MODEL, max_turns: 12 },
    answer_max_chars: 1500,
  },
};

/** First broken token-relay invariant (ranges, handoff below kill), or null when the settings are usable. */
export function tokenRelaySettingsProblem(settings: TokenRelaySettings): { field: string; message: string } | null {
  const limits = CHILD_RUN_LIMITS;
  const isInteger = (value: unknown, minimum: number, maximum: number): boolean =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
  for (const field of ["handoff_tokens", "kill_tokens"] as const) {
    if (!isInteger(settings[field], limits.relay_tokens_min, limits.relay_tokens_max)) {
      return { field: `token_relay.${field}`, message: `The handoff limit must be an integer from ${limits.relay_tokens_min} to ${limits.relay_tokens_max}.` };
    }
  }
  if (settings.handoff_tokens >= settings.kill_tokens) {
    return { field: "token_relay.handoff_tokens", message: "The handoff limit must be lower than the stop limit." };
  }
  if (!isInteger(settings.max_relays, 0, limits.max_relays_max)) {
    return { field: "token_relay.max_relays", message: `Relay restarts must be an integer from 0 to ${limits.max_relays_max}.` };
  }
  if (!isInteger(settings.report_threshold_tokens, limits.relay_tokens_min, limits.report_threshold_max)) {
    return { field: "token_relay.report_threshold_tokens", message: `The request report threshold must be an integer from ${limits.relay_tokens_min} to ${limits.report_threshold_max}.` };
  }
  if (!Array.isArray(settings.models) || settings.models.length > limits.relay_models_max) {
    return { field: "token_relay.models", message: `Token relay models must contain 0 to ${limits.relay_models_max} provider/model objects.` };
  }
  if (settings.models.some((choice) => choice?.provider !== "claude")) {
    return { field: "token_relay.models", message: "Token relay supports only Claude children." };
  }
  return null;
}

/** Relay limits for a child of this provider/model, or null when Owl does not watch its prompt size. */
export function relayConfigFor(settings: ChildRunSettings, provider: ChildRunProvider, model: string): ExecutorRelayConfig | null {
  const relay = settings.token_relay;
  if (!relay.models.some((choice) => choice.provider === provider && choice.model === model)) return null;
  return { handoff_tokens: relay.handoff_tokens, kill_tokens: relay.kill_tokens };
}

export type DelegationMismatchKind = "delegation_missing" | "unknown_child" | "unreported_child" | "unfinished_child" | "missing_reason";
export interface WorkerDelegationReport {
  readonly split: string;
  readonly children: readonly { readonly child_id: string; readonly assignment: string; readonly outcome: "used" | "fixed_by_worker" | "redone" | "discarded" }[];
  readonly kept: readonly { readonly work: string; readonly reason: string }[];
}
