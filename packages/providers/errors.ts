import type { AdapterId, FailureClass } from "./types.js";

export type ProviderErrorKey =
  | "provider_version_mismatch"
  | "provider_reported_error"
  | "report_invalid"
  | "spawn_failed"
  | "output_too_large"
  | "utf8_decode_failed"
  | "phase_not_enabled";

export class ProviderError extends Error {
  public readonly errorKey: ProviderErrorKey;
  public readonly failureClass: FailureClass;
  public readonly retryAllowed: boolean;
  public readonly adapter: AdapterId | null;
  public readonly reasonCode: string;

  public constructor(
    errorKey: ProviderErrorKey,
    message: string,
    options: {
      adapter?: AdapterId | null;
      failureClass?: FailureClass;
      retryAllowed?: boolean;
      reasonCode?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.errorKey = errorKey;
    this.failureClass = options.failureClass ?? "deterministic";
    this.retryAllowed = options.retryAllowed ?? false;
    this.adapter = options.adapter ?? null;
    this.reasonCode = options.reasonCode ?? errorKey;
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: options.cause,
        writable: false,
      });
    }
  }
}
export function providerVersionMismatch(
  reasonCode: string,
  adapter: AdapterId | null = null,
): ProviderError {
  return new ProviderError(
    "provider_version_mismatch",
    "The selected provider executable is not an approved locked version. Update provider-lock.json and run the provider check again.",
    {
      adapter,
      reasonCode,
      retryAllowed: false,
    },
  );
}

export function reportInvalid(
  adapter: AdapterId,
  reasonCode: string,
  cause?: unknown,
): ProviderError {
  return new ProviderError(
    "report_invalid",
    "The provider returned a report that does not match the required JSON protocol. Review the provider output and adapter version.",
    {
      adapter,
      reasonCode,
      retryAllowed: false,
      cause,
    },
  );
}

export function providerReportedError(
  adapter: AdapterId,
  reasonCode: string,
  cause?: unknown,
): ProviderError {
  return new ProviderError(
    "provider_reported_error",
    "The provider reported an error while processing the request. Check provider authentication, model access, endpoint configuration, and provider status.",
    {
      adapter,
      reasonCode,
      retryAllowed: false,
      cause,
    },
  );
}

export function spawnFailed(
  adapter: AdapterId,
  reasonCode: string,
  cause?: unknown,
): ProviderError {
  return new ProviderError(
    "spawn_failed",
    "The provider process could not be started. Check the locked executable and runtime permissions, then try again.",
    {
      adapter,
      reasonCode,
      retryAllowed: false,
      cause,
    },
  );
}

export function outputTooLarge(
  adapter: AdapterId,
  stream: "stdout" | "stderr",
): ProviderError {
  return new ProviderError(
    "output_too_large",
    `The provider ${stream} exceeded the 4 MiB safety limit. Reduce the provider output before retrying.`,
    {
      adapter,
      reasonCode: `${stream}_cap_exceeded`,
      retryAllowed: false,
    },
  );
}

export function utf8DecodeFailed(
  adapter: AdapterId,
  stream: "stdout" | "stderr",
  cause?: unknown,
): ProviderError {
  return new ProviderError(
    "utf8_decode_failed",
    `The provider ${stream} was not valid UTF-8. Check the locked provider version and locale configuration.`,
    {
      adapter,
      reasonCode: `${stream}_utf8_invalid`,
      retryAllowed: false,
      cause,
    },
  );
}

export function phaseNotEnabled(adapter: string): ProviderError {
  return new ProviderError(
    "phase_not_enabled",
    "The requested provider adapter is not enabled in the MVP. Select an enabled provider adapter.",
    {
      reasonCode: `adapter_not_enabled:${adapter}`,
      retryAllowed: false,
    },
  );
}
