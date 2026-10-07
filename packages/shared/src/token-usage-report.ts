export type TokenUsagePeriod = "today" | "7d" | "30d";
export const TOKEN_USAGE_PERIODS: readonly TokenUsagePeriod[] = ["today", "7d", "30d"];
export type TokenUsageHarness = "claude" | "codex" | "other";
export type TokenUsageRole = "advisor" | "manager" | "designer" | "worker" | "reviewer" | "executor";

export interface TokenUsageTotals {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly total_tokens: number;
  readonly runs: number;
}

/** Cost metrics per Work / role; uncached input = input_tokens + cache_write_tokens (everything not served from the cache). */
export interface TokenUsageMetrics {
  readonly uncached_input_tokens: number;
  readonly tokens_after_first_review: number;
  /** Share of Tasks with a review whose first review passed; null when no Task was reviewed. */
  readonly first_review_pass_rate: number | null;
  readonly completed_tasks: number;
  readonly uncached_input_tokens_per_completed_task: number | null;
  /** Runs of the group divided by its completed Tasks; null when none completed. */
  readonly runs_per_completed_task: number | null;
}

export interface TokenUsageTaskTotals {
  readonly task_id: string;
  readonly work_id: string;
  readonly title: string;
  readonly status: string;
  readonly first_review_verdict: string | null;
  /** 1 when the first review passed, 0 when it did not, null when the Task has no review. */
  readonly first_review_pass_rate: 0 | 1 | null;
  readonly uncached_input_tokens: number;
  readonly tokens_after_first_review: number;
  readonly totals: TokenUsageTotals;
}

export interface TokenUsageWorkTotals {
  readonly work_id: string;
  readonly title: string | null;
  readonly display_number: number | null;
  readonly project_id: string | null;
  readonly state: string | null;
  readonly totals: TokenUsageTotals;
  readonly metrics: TokenUsageMetrics;
}

export interface TokenUsageReport {
  readonly period: TokenUsagePeriod;
  readonly since: string;
  readonly until: string;
  readonly time_zone: string;
  readonly totals: TokenUsageTotals;
  readonly runs_without_usage: number;
  readonly daily: readonly { readonly date: string; readonly totals: TokenUsageTotals }[];
  readonly by_work: readonly TokenUsageWorkTotals[];
  readonly by_task: readonly TokenUsageTaskTotals[];
  readonly by_harness: readonly { readonly harness: TokenUsageHarness; readonly totals: TokenUsageTotals }[];
  readonly by_role: readonly { readonly role: TokenUsageRole; readonly totals: TokenUsageTotals; readonly metrics: TokenUsageMetrics }[];
  readonly by_model: readonly { readonly provider: string; readonly model: string; readonly harness: TokenUsageHarness; readonly totals: TokenUsageTotals }[];
  readonly top_works: readonly TokenUsageWorkTotals[];
}

/** [since, until); 7d and 30d include today and earlier local calendar dates. */
export function tokenUsagePeriodRange(period: TokenUsagePeriod, now: Date): { since: Date; until: Date; dates: string[] } {
  const days = period === "today" ? 1 : period === "7d" ? 7 : period === "30d" ? 30 : 0;
  if (days === 0 || Number.isNaN(now.getTime())) throw new RangeError("Invalid token usage period or time.");
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1);
  const dates = Array.from({ length: days }, (_, index) => localDate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)));
  return { since: start, until: now, dates };
}

export function parseTokenUsagePeriod(value: string | null): TokenUsagePeriod | null {
  return value !== null && TOKEN_USAGE_PERIODS.includes(value as TokenUsagePeriod) ? value as TokenUsagePeriod : null;
}

function localDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
