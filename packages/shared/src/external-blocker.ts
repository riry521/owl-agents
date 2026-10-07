import { validateRoleOutput, type RoleSchema } from "./role-schema.js";

export const EXTERNAL_BLOCKER_EVENT = "task.external_blocker_reported" as const;
/** pre_existing: a problem already on the base branch / environment: a gap in the Project environment this Task must not set up. */
export const EXTERNAL_BLOCKER_KINDS = ["pre_existing", "environment"] as const;
export type ExternalBlockerKind = (typeof EXTERNAL_BLOCKER_KINDS)[number];

export interface ExternalBlocker {
  readonly kind: ExternalBlockerKind;
  readonly summary: string;
  readonly evidence: string;
  readonly suggested_fix: string;
}

export const EXTERNAL_BLOCKER_SCHEMA: RoleSchema = {
  type: ["object", "null"],
  example: null,
  additionalProperties: false,
  required: ["kind", "summary", "evidence", "suggested_fix"],
  properties: {
    kind: { type: "string", enum: [...EXTERNAL_BLOCKER_KINDS], description: "pre_existing: the problem is already on the base branch; environment: the Project environment lacks something this Task must not set up" },
    summary: { type: "string", minLength: 1, description: "what blocks the criterion, in one sentence" },
    evidence: { type: "string", minLength: 1, description: "why the problem does not come from this Task's changes (commands run and output excerpts, file:line)" },
    suggested_fix: { type: "string", minLength: 1, description: "what a separate Task should fix" },
  },
  description: "set only with result \"partial\" when a problem outside this Task blocks a criterion; null otherwise",
};

/** Valid blocker or null. Never throws. */
export function readExternalBlocker(value: unknown): ExternalBlocker | null {
  try {
    return validateRoleOutput(EXTERNAL_BLOCKER_SCHEMA, value) === null ? (value as ExternalBlocker) : null;
  } catch {
    return null;
  }
}

export type ExternalBlockerIgnored = "invalid_shape" | "not_partial" | "with_pending_process" | "design_task";

/** The blocker Core may act on, or why it is ignored (ignored is null when the report simply has none). */
export function reportedExternalBlocker(
  report: Readonly<Record<string, unknown>> | undefined,
  taskType: string | undefined,
): { readonly blocker: ExternalBlocker | null; readonly ignored: ExternalBlockerIgnored | null } {
  const raw = report?.external_blocker;
  if (raw === undefined || raw === null) return { blocker: null, ignored: null };
  const blocker = readExternalBlocker(raw);
  if (blocker === null) return { blocker: null, ignored: "invalid_shape" };
  if (taskType === "design") return { blocker: null, ignored: "design_task" };
  if (report?.result !== "partial") return { blocker: null, ignored: "not_partial" };
  if (report.pending_process !== undefined && report.pending_process !== null) return { blocker: null, ignored: "with_pending_process" };
  return { blocker, ignored: null };
}
