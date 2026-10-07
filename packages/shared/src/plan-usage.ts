/**
 * Plan usage (subscription rate-limit windows) shared by Core and
 * agent-runtime. Pure types only; nothing here performs I/O.
 */

export type PlanUsageHarness = "claude" | "codex";

/** Window kinds the UI translates; anything else is "other" with a raw label. */
export type PlanUsageWindowKind =
  | "five_hour"
  | "weekly"
  | "weekly_opus"
  | "weekly_sonnet"
  | "weekly_oauth_apps"
  | "other";

/** Limit state reported by a Claude rate_limit_event; null when not reported. */
export type PlanUsageWindowState = "normal" | "warning" | "limited";

export interface PlanUsageWindow {
  /** Source key, for example "five_hour", "seven_day_opus", "primary". */
  readonly id: string;
  readonly kind: PlanUsageWindowKind;
  /** 0..100, one decimal; null when the source did not report it. */
  readonly used_percent: number | null;
  /** UTC ISO-8601; null when unknown. */
  readonly resets_at: string | null;
  readonly window_minutes: number | null;
  readonly state: PlanUsageWindowState | null;
  /** Raw source key for kind "other"; null otherwise. */
  readonly label: string | null;
}

export type PlanUsageOrigin =
  | "claude_usage_api"
  | "claude_rate_limit_event"
  | "codex_live"
  | "codex_session_log";

export interface PlanUsageSnapshot {
  readonly harness: PlanUsageHarness;
  readonly origin: PlanUsageOrigin;
  readonly windows: readonly PlanUsageWindow[];
  /** Plan name such as "max" or "plus"; null when unknown. Never a credential. */
  readonly plan_type: string | null;
  /** UTC ISO-8601 time the values describe. */
  readonly observed_at: string;
}

export type PlanUsageStatus =
  | "ok"
  | "disabled"
  | "not_configured"
  | "not_logged_in"
  | "expired"
  | "unauthorized"
  | "rate_limited"
  | "unavailable"
  | "unrecognized"
  | "error"
  | "not_installed"
  | "no_data";

export interface PlanUsageFetchResult {
  readonly status: PlanUsageStatus;
  /** Present only when status is "ok". */
  readonly snapshot: PlanUsageSnapshot | null;
  /** Short machine-readable reason such as "http_401"; never contains secrets. */
  readonly detail: string | null;
}

/** One polled source. fetch() never throws and never returns a credential. */
export interface PlanUsageSource {
  readonly harness: PlanUsageHarness;
  readonly origin: PlanUsageOrigin;
  fetch(signal: AbortSignal): Promise<PlanUsageFetchResult>;
}

/** Receives snapshots observed live in agent output. Must not throw. */
export type PlanUsageSink = (observation: PlanUsageSnapshot) => void;
