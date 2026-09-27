/**
 * Core-owned human-readable error.
 *
 * This is a separate class from `@owl/shared`'s two-field
 * (`code`/`remediation`) error: Core adds the third public field `details`.
 * The classes are therefore not ABI-identical and `instanceof` does not cross
 * the package boundary. Callers classify both errors by their string `code`.
 */
export class HumanReadableError extends Error {
  public readonly name = "HumanReadableError";
  public readonly code: string;
  public readonly remediation: string;
  public readonly details: Record<string, unknown>;

  public constructor(options: {
    code: string;
    message: string;
    remediation: string;
    details?: Record<string, unknown>;
  }) {
    super(options.message);
    this.code = options.code;
    this.remediation = options.remediation;
    this.details = options.details ?? {};
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public toUserMessage(): string {
    return `${this.message} ${this.remediation}`;
  }
}

export function invalidStateTransition(message: string, details: Record<string, unknown>): HumanReadableError {
  return new HumanReadableError({
    code: "invalid_state_transition",
    message,
    remediation: "Refresh the current resource and submit an action allowed by its current state.",
    details,
  });
}

export function notFound(resource: string, id: string): HumanReadableError {
  return new HumanReadableError({
    code: `${resource}_not_found`,
    message: `${resource} ${id} was not found.`,
    remediation: "Verify the identifier and refresh the resource list.",
    details: { resource, id },
  });
}

export function validationError(message: string, details: Record<string, unknown> = {}): HumanReadableError {
  return new HumanReadableError({
    code: "validation_error",
    message,
    remediation: "Correct the highlighted fields and submit the request again.",
    details,
  });
}

export function versionConflict(expected: number, actual: number): HumanReadableError {
  return new HumanReadableError({
    code: "version_conflict",
    message: "The resource changed before this command was committed.",
    remediation: "Refresh the resource and retry with its current version.",
    details: { expected, actual },
  });
}

export function idempotencyConflict(key: string): HumanReadableError {
  return new HumanReadableError({
    code: "idempotency_conflict",
    message: `The idempotency key ${key} was already used with a different request body.`,
    remediation: "Use a new idempotency key for the changed request.",
    details: { idempotency_key: key },
  });
}

export function projectPathConflict(canonicalPath: string): HumanReadableError {
  return new HumanReadableError({
    code: "project_path_conflict",
    message: `A Project already exists at canonical_path ${canonicalPath}.`,
    remediation: "Use the existing Project or choose a different canonical_path.",
    details: { canonical_path: canonicalPath },
  });
}

export function dependencyUnavailable(message: string, details: Record<string, unknown> = {}): HumanReadableError {
  return new HumanReadableError({
    code: "dependency_unavailable",
    message,
    remediation: "Configure the required dependency and retry.",
    details,
  });
}
