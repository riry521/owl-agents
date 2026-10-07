import { CHECK_WEIGHTS, type CheckWeight } from "./task-necessity.js";

/** Protocol identifier shared by the Manager prompt, the parser and Core: the k-th criterion of a Task is "AC<k>". */
export const ACCEPTANCE_CRITERION_ID_PREFIX = "AC";

/** work_check: confirms the work is right (a test added for it is not kept); spec_test: asks for a test that pins the specification. */
export const CRITERION_KINDS = ["work_check", "spec_test"] as const;
export type CriterionKind = (typeof CRITERION_KINDS)[number];

/** One acceptance criterion as the Manager writes it: one field per fact. */
export interface AcceptanceCriterion {
  readonly id: string;
  /** What must be true. */
  readonly text: string;
  /** How to check it inside the Task. */
  readonly check: string;
  /** The part of the request it serves. */
  readonly serves: string;
  /** What goes wrong for the request without it. */
  readonly if_omitted: string;
  readonly check_weight: CheckWeight;
  /** Why no lighter check is enough; required when check_weight is heavy. */
  readonly weight_reason: string;
  /** Required in Manager output; criteria stored before it existed have none and read as work_check. */
  readonly kind?: CriterionKind;
}

/** A stored criterion; a Task planned with a free-text acceptance reads as one legacy criterion with unknown weight. */
export interface StoredAcceptanceCriterion extends Omit<AcceptanceCriterion, "check_weight"> {
  readonly check_weight: CheckWeight | null;
  readonly legacy?: true;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const TEXT_FIELDS = ["text", "check", "serves", "if_omitted"] as const;
const KEYS: readonly string[] = ["id", ...TEXT_FIELDS, "check_weight", "weight_reason", "kind"];

/** The fields that are missing or out of range, as "acceptance_criteria[k].field" paths; [] when the value is a valid criteria array. kind may be absent (stored criteria) unless requireKind. */
export function acceptanceCriteriaProblems(value: unknown, requireKind = false): string[] {
  if (!Array.isArray(value) || value.length === 0) return ["acceptance_criteria"];
  const problems: string[] = [];
  value.forEach((entry: unknown, index) => {
    const at = `acceptance_criteria[${index + 1}]`;
    if (!isRecord(entry)) {
      problems.push(at);
      return;
    }
    if (entry.id !== `${ACCEPTANCE_CRITERION_ID_PREFIX}${index + 1}`) problems.push(`${at}.id`);
    for (const field of TEXT_FIELDS) {
      const text = entry[field];
      if (typeof text !== "string" || text.trim() === "") problems.push(`${at}.${field}`);
    }
    if (!(CHECK_WEIGHTS as readonly unknown[]).includes(entry.check_weight)) problems.push(`${at}.check_weight`);
    if ((requireKind || entry.kind !== undefined) && !(CRITERION_KINDS as readonly unknown[]).includes(entry.kind)) problems.push(`${at}.kind`);
    if (typeof entry.weight_reason !== "string" || (entry.check_weight === "heavy" && entry.weight_reason.trim() === "")) problems.push(`${at}.weight_reason`);
    for (const key of Object.keys(entry)) if (!KEYS.includes(key)) problems.push(`${at}.${key}`);
  });
  return problems;
}

/** Validation message for the Manager output contract, or null. */
export function validateAcceptanceCriteria(value: unknown): string | null {
  const problems = acceptanceCriteriaProblems(value, true);
  return problems.length === 0 ? null : `acceptance_criteria:${problems.join(",")}`;
}

/** True only when a criterion asks for a spec test; criteria without kind and an empty list do not. */
export function requestsSpecTest(criteria: readonly { readonly kind?: CriterionKind }[]): boolean {
  return criteria.some((criterion) => criterion.kind === "spec_test");
}

/** The display text kept in tasks.acceptance; Core never reads it back. */
export function renderAcceptanceCriteria(criteria: readonly AcceptanceCriterion[]): string {
  return criteria.map((c) => `(${c.id.slice(ACCEPTANCE_CRITERION_ID_PREFIX.length)}) ${c.text}\n  check: ${c.check}`).join("\n");
}

/** Reads a stored Task's criteria: the JSON column when it holds a valid array, otherwise the free-text acceptance as one legacy criterion. The text is never split. */
export function readStoredAcceptanceCriteria(json: string | null | undefined, acceptanceText: string): StoredAcceptanceCriterion[] {
  if (typeof json === "string" && json !== "") {
    try {
      const parsed: unknown = JSON.parse(json);
      if (acceptanceCriteriaProblems(parsed).length === 0) return parsed as StoredAcceptanceCriterion[];
    } catch {
      // A damaged column reads like a Task without one.
    }
  }
  return [{ id: `${ACCEPTANCE_CRITERION_ID_PREFIX}1`, text: acceptanceText, check: "", serves: "", if_omitted: "", check_weight: null, weight_reason: "", legacy: true }];
}
