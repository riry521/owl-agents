import type { ProviderErrorRecord } from "@owl/shared";

import { harnessFailureDetail, type HarnessFailureDetail } from "./protocol";
import { classifyProviderFailure } from "./provider-error";
import type { RateLimitResetInput } from "./rate-limit";

function jsonLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Claude's stream-json stdout: the last `result` line is the failure, `rate_limit_event` lines are reset evidence. */
function claudeStreamDetail(stdout: string): HarnessFailureDetail | null {
  const events = stdout.split(/\r?\n/u).map(jsonLine).filter((event): event is Record<string, unknown> => event !== null);
  const result = events.filter((event) => event.type === "result").pop();
  const detail = result === undefined ? null : harnessFailureDetail("claude", JSON.stringify(result));
  const limits: RateLimitResetInput[] = events.filter((event) => event.type === "rate_limit_event").map((event) => ({ kind: "event", event }));
  return detail === null && limits.length === 0 ? null : { ...detail, rate_limit_evidence: [...limits, ...(detail?.rate_limit_evidence ?? [])] };
}

/**
 * The record for a failed Executor child. Its stderr may be empty while the
 * provider's error is only in structured stdout, so the harness's own error
 * fields are read from stdout; the rest of stdout (assistant text) is dropped.
 */
export function executorProviderError(
  provider: string,
  stdout: string,
  stderr: string,
  exitCode: number | null,
  signal: string | null,
  secrets: readonly string[] = [],
  now: Date = new Date(),
): ProviderErrorRecord {
  const detail = provider.startsWith("claude") ? claudeStreamDetail(stdout) : harnessFailureDetail(provider, stdout);
  return classifyProviderFailure(provider, { exit_code: exitCode, signal, kind: "exit", stderr, ...(detail ?? {}) }, "ja", now, secrets).provider_error;
}
