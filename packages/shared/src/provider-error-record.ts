import type { AgentFailureClass } from "./rate-limit.js";

/** The provider's own error for one failed provider call, masked and bounded. */
export interface ProviderErrorRecord {
  /** "codex" | "claude" | "opencode"; the adapter name when the harness is unknown. */
  readonly harness: string;
  /** The error text the provider returned, masked and within PROVIDER_ERROR_RECORD_MAX_CHARS. */
  readonly message: string | null;
  /** Where message came from: the harness's error field or the end of stderr. */
  readonly message_source: "harness_error" | "stderr" | null;
  /** codexErrorInfo kind, harness_code or error_code. */
  readonly code: string | null;
  /** harness_status, or the httpStatusCode of codexErrorInfo. */
  readonly http_status: number | null;
  /** ProviderFailureKind: exit, harness_error, timeout, ... */
  readonly failure_kind: string | null;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly failure_class: AgentFailureClass;
  readonly error_key: string;
  /** Which failed provider call of the invocation this is, from 1. */
  readonly attempt: number;
  readonly recorded_at: string;
}

/** Safety bound on stored text, not a tunable: same kind of constant as OPENCODE_ORIGINAL_ERROR_MAX_CHARS. */
export const PROVIDER_ERROR_RECORD_MAX_CHARS = 2_000;
