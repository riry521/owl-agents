/** A Task held in `waiting` until conditions outside its Work hold (stored in tasks.prerequisite_json). */
export type PrerequisiteCondition =
  | { kind: "task"; task_id: string; description: string }
  | { kind: "work"; work_id: string; description: string }
  | { kind: "base_branch"; paths: string[]; description: string }
  | { kind: "owner"; description: string }
  /** A long process a Worker started and reported as pending; released when its done file appears or it exits. */
  | { kind: "process"; pid: number | null; done_path: string | null; log_path: string; description: string };

export type PrerequisiteSource = "manager" | "worker";

export interface PrerequisiteSpec {
  reason: string;
  source: PrerequisiteSource;
  /** All must hold (AND); one `owner` condition means only an explicit Owner resume releases the wait. */
  conditions: PrerequisiteCondition[];
  /** Base branch commit when the wait began; recorded only with a base_branch condition. */
  base_head: string | null;
  deadline_at: string;
  replan_question: string | null;
}

/** The Manager's `wait_for` on a retried Task in a replan; target is a Task id, a Work id or "#<number>", or "". */
export interface PlanWaitFor {
  reason: string;
  conditions: { kind: Exclude<PrerequisiteCondition["kind"], "process">; target: string; paths: string[]; description: string }[];
}

/** Kinds the Manager may use in wait_for (a Worker's process wait is not one of them). */
export const PREREQUISITE_KINDS = ["task", "work", "base_branch", "owner"] as const;
/** Kinds a stored spec may hold. */
export const PREREQUISITE_CONDITION_KINDS = [...PREREQUISITE_KINDS, "process"] as const;
/** The event that holds a Task in waiting for a process its Worker started. */
export const PROCESS_WAIT_EVENT = "task.process_wait_started" as const;
/** Input-contract bounds (shape limits, not operational settings). */
export const PREREQUISITE_LIMITS = { conditions: 10, text: 2000, paths: 50 } as const;

export class PrerequisiteValidationError extends Error {
  public constructor(message: string, public readonly field: string) {
    super(message);
    this.name = "PrerequisiteValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > PREREQUISITE_LIMITS.text) {
    throw new PrerequisiteValidationError(`${field} must be a string of ${allowEmpty ? 0 : 1} to ${PREREQUISITE_LIMITS.text} characters.`, field);
  }
  return value;
}

function checkPaths(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > PREREQUISITE_LIMITS.paths) {
    throw new PrerequisiteValidationError(`${field} must be an array of at most ${PREREQUISITE_LIMITS.paths} paths.`, field);
  }
  return value.map((path, index) => {
    const name = `${field}[${index}]`;
    if (typeof path !== "string" || path.length === 0 || path.length > PREREQUISITE_LIMITS.text) {
      throw new PrerequisiteValidationError(`${name} must be a non-empty path string.`, name);
    }
    if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes("..")) {
      throw new PrerequisiteValidationError(`${name} must be a repository-relative path without "..".`, name);
    }
    return path;
  });
}

function conditionList(value: unknown, field: string, kinds: readonly string[] = PREREQUISITE_KINDS): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > PREREQUISITE_LIMITS.conditions) {
    throw new PrerequisiteValidationError(`${field} must have 1 to ${PREREQUISITE_LIMITS.conditions} conditions.`, field);
  }
  return value.map((item, index) => {
    if (!isRecord(item)) throw new PrerequisiteValidationError(`${field}[${index}] must be an object.`, `${field}[${index}]`);
    if (typeof item.kind !== "string" || !kinds.includes(item.kind)) {
      throw new PrerequisiteValidationError(`${field}[${index}].kind must be one of ${kinds.join(", ")}.`, `${field}[${index}].kind`);
    }
    return item;
  });
}

/** Validates the Manager's wait_for. Throws PrerequisiteValidationError. */
export function validateWaitFor(value: unknown): PlanWaitFor {
  if (!isRecord(value)) throw new PrerequisiteValidationError("wait_for must be an object.", "wait_for");
  const reason = text(value.reason, "wait_for.reason");
  const conditions = conditionList(value.conditions, "wait_for.conditions").map((item, index) => {
    const field = `wait_for.conditions[${index}]`;
    const kind = item.kind as Exclude<PrerequisiteCondition["kind"], "process">;
    const needsTarget = kind === "task" || kind === "work";
    const target = text(item.target, `${field}.target`, !needsTarget);
    if (!needsTarget && target !== "") throw new PrerequisiteValidationError(`${field}.target must be empty for kind ${kind}.`, `${field}.target`);
    const paths = kind === "base_branch" ? checkPaths(item.paths, `${field}.paths`) : [];
    if (kind !== "base_branch" && !(Array.isArray(item.paths) && item.paths.length === 0)) {
      throw new PrerequisiteValidationError(`${field}.paths must be [] for kind ${kind}.`, `${field}.paths`);
    }
    return { kind, target, paths, description: text(item.description, `${field}.description`) };
  });
  return { reason, conditions };
}

/** Validates a stored/resolved PrerequisiteSpec. Throws PrerequisiteValidationError. */
export function validatePrerequisiteSpec(value: unknown): PrerequisiteSpec {
  if (!isRecord(value)) throw new PrerequisiteValidationError("prerequisite must be an object.", "prerequisite");
  if (value.source !== "manager" && value.source !== "worker") {
    throw new PrerequisiteValidationError('prerequisite.source must be "manager" or "worker".', "source");
  }
  const source: PrerequisiteSource = value.source;
  const conditions = conditionList(value.conditions, "conditions", PREREQUISITE_CONDITION_KINDS).map((item, index): PrerequisiteCondition => {
    const field = `conditions[${index}]`;
    // A process condition belongs to a Worker's wait and nothing else does.
    if ((item.kind === "process") !== (source === "worker")) {
      throw new PrerequisiteValidationError(`${field}.kind ${String(item.kind)} does not fit source ${source}.`, `${field}.kind`);
    }
    const description = text(item.description, `${field}.description`);
    switch (item.kind) {
      case "process": return validatePendingProcess(item);
      case "task": return { kind: "task", task_id: text(item.task_id, `${field}.task_id`), description };
      case "work": return { kind: "work", work_id: text(item.work_id, `${field}.work_id`), description };
      case "base_branch": return { kind: "base_branch", paths: checkPaths(item.paths, `${field}.paths`), description };
      default: return { kind: "owner", description };
    }
  });
  const nullableText = (key: "base_head" | "replan_question"): string | null =>
    value[key] === null ? null : text(value[key], key);
  return {
    reason: text(value.reason, "reason"),
    source,
    conditions,
    base_head: nullableText("base_head"),
    deadline_at: text(value.deadline_at, "deadline_at"),
    replan_question: nullableText("replan_question"),
  };
}

/** Validates a Worker's pending_process (paths relative to its worktree) as a process condition. */
export function validatePendingProcess(value: unknown): Extract<PrerequisiteCondition, { kind: "process" }> {
  if (!isRecord(value)) throw new PrerequisiteValidationError("pending_process must be an object.", "pending_process");
  const pid = value.pid ?? null;
  if (pid !== null && (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)) {
    throw new PrerequisiteValidationError("pending_process.pid must be a positive integer or null.", "pending_process.pid");
  }
  const [logPath] = checkPaths([value.log_path], "pending_process.log_path");
  const [donePath = null] = value.done_path == null ? [] : checkPaths([value.done_path], "pending_process.done_path");
  if (donePath === null && pid === null) {
    throw new PrerequisiteValidationError("pending_process needs a done_path or a pid to be released.", "pending_process");
  }
  return { kind: "process", pid, done_path: donePath, log_path: logPath, description: text(value.description, "pending_process.description") };
}
