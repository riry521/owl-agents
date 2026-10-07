import type { AdapterOutcome, RetryDecision } from "./types.js";

export const TRANSIENT_RETRY_DELAYS = [30, 120, 300] as const;

export function transientRetryDecision(
  outcome: AdapterOutcome,
  attempt: number,
): RetryDecision {
  const safeAttempt = Number.isInteger(attempt) && attempt >= 0 ? attempt : 0;
  const delaySeconds = TRANSIENT_RETRY_DELAYS[safeAttempt];
  const retry =
    outcome.failureClass === "transient" &&
    outcome.retryAllowed &&
    delaySeconds !== undefined;
  return {
    retry,
    delaySeconds: retry ? delaySeconds : null,
    counterDelta: 0,
    attempt: safeAttempt,
    maxRetries: 3,
  };
}
