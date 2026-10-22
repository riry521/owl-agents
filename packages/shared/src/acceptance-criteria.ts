import { CHECK_WEIGHTS, type CheckWeight } from "./task-necessity.js";

/** Protocol identifier shared by the Manager prompt, the parser and Core: the k-th criterion of a Task is "AC<k>". */
export const ACCEPTANCE_CRITERION_ID_PREFIX = "AC";

/** work_check: confirms the work is right (a test added for it is not kept); spec_test: asks for a test that pins the specification. */
export const CRITERION_KINDS = ["work_check", "spec_test"] as const;
export type CriterionKind = (typeof CRITERION_KINDS)[number];

/** Who a criterion comes from: the Owner's own words (summary, instruction, Decision answer) or the Manager. */
export const CRITERION_ORIGIN_KINDS = ["owner", "manager"] as const;
export const CRITERION_ORIGIN_SOURCES = ["summary", "instruction", "decision_answer"] as const;
export const CRITERION_ORIGIN_QUOTE_MAX = 300;

export interface CriterionOrigin {
  readonly kind: (typeof CRITERION_ORIGIN_KINDS)[number];
  readonly source?: (typeof CRITERION_ORIGIN_SOURCES)[number] | null;
  /** A copy of the Owner's sentence the criterion comes from; required for kind owner. */
  readonly quote?: string;
}

/** The Manager's record of one criterion it loosened in an automatic replan; keeps names what is still checked. */
export interface CriteriaRelaxation {
  readonly criterion_id: string;
  readonly reason: string;
  readonly keeps: string;
}

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
  /** Absent on criteria stored before it existed; those read as owner and are never loosened. */
  readonly origin?: CriterionOrigin;
}

/** A stored criterion; a Task planned with a free-text acceptance reads as one legacy criterion with unknown weight. */
export interface StoredAcceptanceCriterion extends Omit<AcceptanceCriterion, "check_weight"> {
  readonly check_weight: CheckWeight | null;
  readonly legacy?: true;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const TEXT_FIELDS = ["text", "check", "serves", "if_omitted"] as const;
const KEYS: readonly string[] = ["id", ...TEXT_FIELDS, "check_weight", "weight_reason", "kind", "origin"];
const ORIGIN_KEYS: readonly string[] = ["kind", "source", "quote"];

function validOrigin(value: unknown): boolean {
  if (!isRecord(value) || !(CRITERION_ORIGIN_KINDS as readonly unknown[]).includes(value.kind)) return false;
  if (value.source !== undefined && value.source !== null && !(CRITERION_ORIGIN_SOURCES as readonly unknown[]).includes(value.source)) return false;
  if (value.quote !== undefined && (typeof value.quote !== "string" || [...value.quote].length > CRITERION_ORIGIN_QUOTE_MAX)) return false;
  return Object.keys(value).every((key) => ORIGIN_KEYS.includes(key));
}

/** Only a criterion the Manager added may be loosened; one with no origin is treated as the Owner's, because loosening it could undo what the Owner asked for. */
export const isManagerCriterion = (criterion: { readonly origin?: CriterionOrigin }): boolean => criterion.origin?.kind === "manager";

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
    if (entry.origin !== undefined && !validOrigin(entry.origin)) problems.push(`${at}.origin`);
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
