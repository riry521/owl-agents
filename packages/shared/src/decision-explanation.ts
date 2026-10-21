import type { JsonObject } from "./index.js";
import { validateRoleOutput, type RoleSchema } from "./role-schema.js";

/** work: the criteria are fine, the work is lacking / criteria: the criteria cannot be met inside the Task / external: the cause is outside the Task. */
export const DECISION_CAUSE_KINDS = ["work", "criteria", "external"] as const;
export type DecisionCauseKind = (typeof DECISION_CAUSE_KINDS)[number];
export const DECISION_EXPLANATION_KINDS = ["partial_limit"] as const;
export type DecisionExplanationKind = (typeof DECISION_EXPLANATION_KINDS)[number];

/** The Work's request fixes these: 1-3 options and a reason of 1-2 sentences. */
export const DECISION_FIX_OPTIONS_MIN = 1;
export const DECISION_FIX_OPTIONS_MAX = 3;
export const DECISION_SUMMARY_MAX_SENTENCES = 2;
export const DECISION_FIX_OPTION_PREFIX = "fix_";

/** What the model returns (before Core adds keys and the "before" texts). */
export interface DecisionExplanationReport {
  readonly summary: string;
  readonly cause_kind: DecisionCauseKind;
  readonly options: readonly {
    readonly label: string;
    readonly description: string;
    readonly instruction: string;
    readonly criteria_rewrites: readonly { readonly criterion_id: string; readonly after: string; readonly check: string }[];
  }[];
  /** 0-based index into options. */
  readonly recommended_option: number;
}

export const DECISION_EXPLANATION_SCHEMA: RoleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "cause_kind", "options", "recommended_option"],
  properties: {
    summary: { type: "string", minLength: 1, description: "why the Task stopped, in one or two sentences, without internal terms" },
    cause_kind: { type: "string", enum: [...DECISION_CAUSE_KINDS], description: "work, criteria or external" },
    options: {
      type: "array",
      minItems: DECISION_FIX_OPTIONS_MIN,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "description", "instruction", "criteria_rewrites"],
        properties: {
          label: { type: "string", minLength: 1, description: "short option name" },
          description: { type: "string", minLength: 1, description: "what happens when the Owner picks it" },
          instruction: { type: "string", minLength: 1, description: "what the Manager should do when the Owner picks it" },
          criteria_rewrites: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["criterion_id", "after", "check"],
              properties: {
                criterion_id: { type: "string", minLength: 1, description: "id of the acceptance criterion to reword" },
                after: { type: "string", minLength: 1, description: "the reworded criterion" },
                check: { type: "string", minLength: 1, description: "how to check the reworded criterion inside the Task" },
              },
            },
            description: "reworded criteria; [] unless the option rewrites criteria",
          },
        },
      },
      description: "ways to fix the stop",
    },
    recommended_option: { type: "integer", minimum: 0, description: "0-based index of the recommended option" },
  },
};

/** Words an Owner does not know; each Decision adds its own ids as forbidden terms. */
export const DECISION_INTERNAL_TERM_PATTERNS: readonly RegExp[] = [
  /\bpartial\b/i,
  /\bAC\s?\d+\b/i,
  /\b[0-9A-HJKMNP-TV-Z]{26}\b/,
  /\b(?:judgement_waiting|partial_limit|owner_to_manager|core_decision_required)\b/,
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The matched words of text that an Owner should not see. */
export function findInternalTerms(text: string, forbiddenTerms: readonly string[]): string[] {
  const found: string[] = [];
  for (const pattern of DECISION_INTERNAL_TERM_PATTERNS) {
    const match = pattern.exec(text);
    if (match) found.push(match[0]);
  }
  for (const term of forbiddenTerms) {
    if (term === "") continue;
    const match = new RegExp(`(?<![\\w])${escapeRegExp(term)}(?![\\w])`, "u").exec(text);
    if (match) found.push(match[0]);
  }
  return found;
}

export interface DecisionExplanationCheckContext {
  readonly criterion_ids: readonly string[];
  readonly forbidden_terms: readonly string[];
}

function countSentences(text: string): number {
  return (text.match(/[。！？]|[.!?](?=\s|$)/gu) ?? []).length;
}

/** Never throws; problem says what to fix so the runner can ask the model again. */
export function readDecisionExplanation(
  value: unknown,
  context: DecisionExplanationCheckContext,
): { readonly ok: true; readonly value: DecisionExplanationReport } | { readonly ok: false; readonly problem: string } {
  try {
    const schemaProblem = validateRoleOutput(DECISION_EXPLANATION_SCHEMA, value);
    if (schemaProblem !== null) return { ok: false, problem: schemaProblem };
    const report = value as DecisionExplanationReport;
    // RoleSchema has no maxItems, so the upper bound is checked here.
    if (report.options.length > DECISION_FIX_OPTIONS_MAX) return { ok: false, problem: `options must have at most ${DECISION_FIX_OPTIONS_MAX} items` };
    if (report.recommended_option >=report.options.length) return { ok: false, problem: "recommended_option out of range" };
    if (countSentences(report.summary) > DECISION_SUMMARY_MAX_SENTENCES) {
      return { ok: false, problem: `summary must be at most ${DECISION_SUMMARY_MAX_SENTENCES} sentences` };
    }
    for (const option of report.options) {
      const ids = option.criteria_rewrites.map((rewrite) => rewrite.criterion_id);
      const unknown = ids.find((id) => !context.criterion_ids.includes(id));
      if (unknown !== undefined) return { ok: false, problem: `criterion_id ${unknown} is not a criterion of the Task` };
      if (new Set(ids).size !== ids.length) return { ok: false, problem: "criteria_rewrites repeats a criterion_id within one option" };
    }
    if (report.cause_kind === "criteria" && !report.options.some((option) => option.criteria_rewrites.length > 0)) {
      return { ok: false, problem: "cause_kind criteria needs an option with criteria_rewrites" };
    }
    const shown = [
      report.summary,
      ...report.options.flatMap((option) => [option.label, option.description, ...option.criteria_rewrites.flatMap((rewrite) => [rewrite.after, rewrite.check])]),
    ];
    for (const text of shown) {
      const terms = findInternalTerms(text, context.forbidden_terms);
      if (terms.length > 0) return { ok: false, problem: `Rephrase without the internal terms: ${terms.join(", ")}` };
    }
    return { ok: true, value: report };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : "invalid explanation" };
  }
}

export interface DecisionCriterionRewrite {
  /** Id of the Task criterion, for the Manager; never shown to the Owner. */
  readonly criterion_id: string;
  /** Original criterion text, copied from the Task by Core. */
  readonly before: string;
  readonly after: string;
  readonly check: string;
}

export interface DecisionFixOption {
  /** DECISION_FIX_OPTION_PREFIX + number, "fix_1" to "fix_3". */
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** Body of the instruction sent to the Manager. */
  readonly instruction: string;
  /** Empty unless the cause is the criteria. */
  readonly criteria_rewrites: readonly DecisionCriterionRewrite[];
}

export interface StoredDecisionExplanation {
  readonly kind: DecisionExplanationKind;
  readonly status: "pending" | "ready" | "failed";
  /** Only when status is ready. */
  readonly summary?: string;
  /** Only when status is ready. */
  readonly cause_kind?: DecisionCauseKind;
  /** Only when status is failed, e.g. "timeout". */
  readonly error?: string;
}

/** The runner request and result; Core and agent-runtime both import them from here. */
export interface DecisionExplanationRequest {
  readonly invocation_id?: string;
  readonly kind: DecisionExplanationKind;
  readonly language: "ja" | "en";
  readonly task: { readonly title: string; readonly acceptance_criteria: readonly { readonly id: string; readonly text: string; readonly check?: string }[] };
  readonly reports: readonly JsonObject[];
  readonly verification: JsonObject | null;
  readonly rules: string | null;
  readonly forbidden_terms: readonly string[];
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly timeout_ms: number;
}
export type DecisionExplanationRunResult =
  | { readonly ok: true; readonly explanation: DecisionExplanationReport }
  | { readonly ok: false; readonly error: string };
