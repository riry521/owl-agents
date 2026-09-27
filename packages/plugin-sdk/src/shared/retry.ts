/**
 * Small bounded retry for outbound chat-platform posts (notifications).
 * Only transient failures (network errors, HTTP 5xx, rate limits) are
 * retried; permanent errors such as a missing channel or a revoked token fail
 * immediately so the caller can surface them.
 */
export interface RetryOptions {
  /** Total attempts including the first one. Default 3. */
  readonly attempts?: number;
  /** Delay before the second attempt; doubles each retry. Default 500ms. */
  readonly baseDelayMs?: number;
  readonly isTransient?: (error: unknown) => boolean;
  readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class RetryExhaustedError extends Error {
  readonly attempts: number;
  readonly cause: unknown;

  constructor(cause: unknown, attempts: number) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    this.cause = cause;
  }
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;

export async function retryTransient<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_ATTEMPTS));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const isTransient = options.isTransient ?? isTransientDeliveryError;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isTransient(error)) {
        throw new RetryExhaustedError(error, attempt);
      }
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}

const TRANSIENT_CODES = new Set([
  // Node / undici network failures
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  // @slack/web-api error codes
  "slack_webapi_request_error", "slack_webapi_rate_limited_error",
]);

/** Slack `ok: false` platform errors that are worth retrying. */
const TRANSIENT_PLATFORM_ERRORS = new Set([
  "internal_error", "fatal_error", "service_unavailable", "request_timeout", "ratelimited", "rate_limited",
]);

export function isTransientDeliveryError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  const status = typeof record.status === "number"
    ? record.status
    : typeof record.statusCode === "number" ? record.statusCode : null;
  if (status !== null) return status === 429 || status >= 500;
  if (typeof record.code === "string") {
    if (TRANSIENT_CODES.has(record.code)) return true;
    if (record.code === "slack_webapi_platform_error") {
      const data = record.data as Record<string, unknown> | undefined;
      return typeof data?.error === "string" && TRANSIENT_PLATFORM_ERRORS.has(data.error);
    }
  }
  if (record.cause && record.cause !== error && isTransientDeliveryError(record.cause)) return true;
  const message = typeof record.message === "string" ? record.message : "";
  return /timed? ?out|socket hang up|fetch failed|ECONNRESET|network/iu.test(message);
}
