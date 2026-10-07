import type { TokenUsage } from "./index.js";

/**
 * Token usage of one-shot agent CLI runs. Core and agent-runtime both read
 * it from the provider's stdout, so the parsing lives here once.
 * Nothing in this module throws: usage the provider did not report, or
 * reported in an unknown shape, is null and never fails a run.
 */

const TOKEN_USAGE_KEYS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Codex reports cached tokens inside input_tokens; normalize to the Claude shape where input_tokens excludes cache reads. */
export function uncachedInputTokens(input: unknown, cached: unknown): number | undefined {
  const count = tokenCount(input);
  const read = tokenCount(cached);
  return count === undefined || read === undefined ? count : Math.max(0, count - read);
}

/** Marker usageJson writes on normalized usage; rows stored before it carry the provider's raw input_tokens. */
export const NORMALIZED_USAGE_KEY = "input_excludes_cache";

/**
 * Read boundary for stored agent_runs.usage_json: the four counts in the normalized shape
 * (input_tokens without cache reads), or null when the row holds no usable count.
 * Codex rows saved before the marker existed keep the raw input_tokens that include cache reads.
 */
export function storedTokenUsage(harness: string | undefined, usageJsonText: string | null): Required<TokenUsage> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(usageJsonText ?? "null");
  } catch {
    return null;
  }
  const usage = tokenUsageOf(parsed);
  if (usage === null) return null;
  const read = usage.cache_read_tokens ?? 0;
  const raw = usage.input_tokens ?? 0;
  const legacyCodex = harness === "codex" && !(isRecord(parsed) && Object.hasOwn(parsed, NORMALIZED_USAGE_KEY));
  return {
    input_tokens: legacyCodex ? Math.max(0, raw - read) : raw,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_tokens: read,
    cache_write_tokens: usage.cache_write_tokens ?? 0,
  };
}

/** Keep only non-negative integer counts of the TokenUsage keys; null when none is left. */
export function tokenUsageOf(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  const usage: Record<string, number> = {};
  for (const key of TOKEN_USAGE_KEYS) {
    const count = tokenCount(value[key]);
    if (count !== undefined) usage[key] = count;
  }
  return Object.keys(usage).length > 0 ? usage as TokenUsage : null;
}

/**
 * Usage of one finished `claude -p --output-format json` (the result
 * wrapper's `usage`) or `codex exec --json` (the last `turn.completed`
 * event's `usage`) process.
 */
export function cliTokenUsage(cli: "claude" | "codex", stdout: string): TokenUsage | null {
  try {
    if (cli === "claude") {
      const wrapper: unknown = JSON.parse(stdout);
      if (!isRecord(wrapper) || !isRecord(wrapper.usage)) return null;
      return tokenUsageOf({
        input_tokens: wrapper.usage.input_tokens,
        output_tokens: wrapper.usage.output_tokens,
        cache_read_tokens: wrapper.usage.cache_read_input_tokens,
        cache_write_tokens: wrapper.usage.cache_creation_input_tokens,
      });
    }
    let usage: Record<string, unknown> | null = null;
    for (const line of stdout.split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (isRecord(event) && event.type === "turn.completed" && isRecord(event.usage)) usage = event.usage;
    }
    if (usage === null) return null;
    return tokenUsageOf({
      input_tokens: uncachedInputTokens(usage.input_tokens, usage.cached_input_tokens),
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cached_input_tokens,
      cache_write_tokens: usage.cache_write_input_tokens,
    });
  } catch {
    return null;
  }
}

/** Sum two usages key by key; null only when both are null. */
export function addTokenUsage(a: TokenUsage | null | undefined, b: TokenUsage | null | undefined): TokenUsage | null {
  const left = tokenUsageOf(a);
  const right = tokenUsageOf(b);
  if (left === null || right === null) return left ?? right;
  const sum: Record<string, number> = {};
  for (const key of TOKEN_USAGE_KEYS) {
    if (left[key] !== undefined || right[key] !== undefined) sum[key] = (left[key] ?? 0) + (right[key] ?? 0);
  }
  return sum as TokenUsage;
}

/** The agent_runs.usage_json value: a JSON object, or null when there is no usage. */
export function usageJson(usage: unknown): string | null {
  const normalized = tokenUsageOf(usage);
  return normalized === null ? null : JSON.stringify({ ...normalized, [NORMALIZED_USAGE_KEY]: 1 });
}
