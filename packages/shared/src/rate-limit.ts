import type { FailureClass } from "./index.js";

/** Failure classes an agent run can report. Task rows still store only FailureClass. */
export type AgentFailureClass = FailureClass | "rate_limited";
export type RateLimitSource = "event" | "text" | "retry_after";

export interface RateLimitInfo {
  /** UTC ISO-8601. null when no reset time could be read (Core then backs off). */
  readonly resets_at: string | null;
  /** Evidence that produced resets_at; null when resets_at is null. */
  readonly source: RateLimitSource | null;
}
