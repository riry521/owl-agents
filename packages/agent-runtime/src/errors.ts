export type AgentRuntimeErrorCode =
  | "report_invalid"
  | "provider_failed"
  | "provider_config_invalid"
  | "provider_unknown"
  | "manager_plan_invalid"
  | "review_invalid"
  | "output_format_invalid";

export class AgentRuntimeError extends Error {
  public readonly code: AgentRuntimeErrorCode;
  public readonly reason: string;

  public constructor(
    code: AgentRuntimeErrorCode,
    message: string,
    reason: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "AgentRuntimeError";
    this.code = code;
    this.reason = reason;
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: cause,
        writable: false,
      });
    }
  }
}

export function reportInvalid(reason: string, cause?: unknown): AgentRuntimeError {
  return new AgentRuntimeError(
    "report_invalid",
    "The provider report does not match the required Owl report contract. Review the provider output and adapter version.",
    reason,
    cause,
  );
}

export function providerFailed(reason: string, cause?: unknown): AgentRuntimeError {
  return new AgentRuntimeError(
    "provider_failed",
    "The configured provider could not complete the request. Check the locked executable, credentials, and provider logs before retrying.",
    reason,
    cause,
  );
}

export function providerConfigInvalid(reason: string): AgentRuntimeError {
  return new AgentRuntimeError(
    "provider_config_invalid",
    "The provider configuration is incomplete or unsafe. Supply an absolute executable, model, working directory, and allowed environment.",
    reason,
  );
}

export function managerPlanInvalid(reason: string, cause?: unknown): AgentRuntimeError {
  return new AgentRuntimeError(
    "manager_plan_invalid",
    "The Manager returned a plan that does not match the required TaskDetail contract.",
    reason,
    cause,
  );
}

export function reviewInvalid(reason: string, cause?: unknown): AgentRuntimeError {
  return new AgentRuntimeError(
    "review_invalid",
    "The Reviewer returned a result that does not match the required review contract.",
    reason,
    cause,
  );
}
