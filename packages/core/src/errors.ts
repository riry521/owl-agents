import type { OwnerLanguage } from "./owner-language";
import type { ProjectDeletionImpact } from "./types";

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

export function projectPathConflict(canonicalPath: string, projectId?: string): HumanReadableError {
  const updatingProject = projectId !== undefined;
  return new HumanReadableError({
    code: updatingProject ? "validation_error" : "project_path_conflict",
    message: `A Project already exists at canonical_path ${canonicalPath}.`,
    remediation: updatingProject ? "Choose a different canonical_path." : "Use the existing Project or choose a different canonical_path.",
    details: { canonical_path: canonicalPath, ...(projectId === undefined ? {} : { project_id: projectId }) },
  });
}

export function projectNotFound(id: string, language: OwnerLanguage): HumanReadableError {
  return new HumanReadableError({
    code: "project_not_found",
    message: language === "ja" ? "指定されたProjectが見つかりません。" : "The Project was not found.",
    remediation: language === "ja" ? "Project一覧を再読み込みしてください。" : "Reload the Project list.",
    details: { resource: "project", id },
  });
}

export function projectHasRunningWorks(
  projectId: string,
  operation: "delete" | "path_change",
  impact: ProjectDeletionImpact,
  language: OwnerLanguage,
): HumanReadableError {
  const japanese = language === "ja";
  const deleting = operation === "delete";
  return new HumanReadableError({
    code: "project_has_running_works",
    message: japanese
      ? deleting
        ? "このProjectには実行中・一時停止中・判断待ちのWork、または動作中のAgentがあるため削除できません。"
        : "このProjectには実行中・一時停止中・判断待ちのWork、または動作中のAgentがあるため、フォルダを変更できません。"
      : deleting
        ? "This Project has running, paused, or judgement-waiting Works, or active Agents, so it cannot be deleted."
        : "This Project has running, paused, or judgement-waiting Works, or active Agents, so its folder cannot be changed.",
    remediation: japanese
      ? "該当するWorkを完了またはキャンセルしてから、もう一度お試しください。"
      : "Complete or cancel those Works, then try again.",
    details: { project_id: projectId, operation, impact },
  });
}

export function projectDeletionImpactChanged(
  projectId: string,
  confirmedWorkCount: number,
  impact: ProjectDeletionImpact,
  language: OwnerLanguage,
): HumanReadableError {
  const japanese = language === "ja";
  return new HumanReadableError({
    code: "project_deletion_impact_changed",
    message: japanese
      ? `確認後にこのProjectのWork数が変わりました（確認時 ${confirmedWorkCount}件、現在 ${impact.work_count}件）。`
      : `The number of Works in this Project changed after confirmation (confirmed ${confirmedWorkCount}, now ${impact.work_count}).`,
    remediation: japanese
      ? "最新の件数を確認してから、もう一度削除してください。"
      : "Review the latest count and delete again.",
    details: { project_id: projectId, confirmed_work_count: confirmedWorkCount, impact },
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
