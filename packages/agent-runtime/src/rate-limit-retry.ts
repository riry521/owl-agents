import { providerFailed } from "./errors";
import { providerFailureCause, type ProviderFailureCause } from "./provider-error";
import { harnessFailureDetail, unwrapCliResult } from "./protocol";
import type { ProviderResponse } from "./types";

/**
 * The failure a provider response carries, as the cause `classifyProviderFailure` reads, or
 * null when the run succeeded or only its answer is wrong (a format problem is not a provider failure).
 */
export function providerResponseFailure(response: ProviderResponse): ProviderFailureCause | null {
  if (response.signal !== null || response.exit_code !== 0) {
    return {
      exit_code: response.exit_code,
      signal: response.signal,
      ...(harnessFailureDetail(response.adapter, response.stdout) ?? {}),
      stdout: response.stdout,
      stderr: response.stderr,
      kind: "exit",
    };
  }
  if ((response.format ?? "provider-json") !== "provider-json") return null;
  try {
    unwrapCliResult(response.adapter, response.stdout);
  } catch (error) {
    return providerFailureCause(error);
  }
  return null;
}

/** Waits `ms`, rejecting with a cancelled provider failure when `signal` aborts. */
export function waitForRateLimitRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = (): Error => providerFailed("provider_cancelled", { exit_code: null, signal: null });
    if (signal.aborted) return reject(cancelled());
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
