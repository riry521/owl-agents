import { validateRoleOutput, type RoleSchema } from "./role-schema.js";

export const DECISION_ANSWER_TRIAGE_ROUTES = ["manager", "worker"] as const;
/** Error of a runner wrapper whose delegate cannot triage; Core decides by available() before it calls, so it never branches on this value. */
export const DECISION_ANSWER_TRIAGE_UNAVAILABLE = "decision_answer_triage_unavailable";

export const DECISION_ANSWER_TRIAGE_SCHEMA: RoleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["route", "reason", "criteria_rewrites"],
  properties: {
    route: { type: "string", enum: [...DECISION_ANSWER_TRIAGE_ROUTES], description: "manager = the words change the plan; worker = advice for the same plan" },
    reason: { type: "string", minLength: 1, description: "one sentence on why, for the log" },
    criteria_rewrites: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion_id", "after", "check"],
        properties: {
          criterion_id: { type: "string", minLength: 1, description: "id of the acceptance criterion the words change" },
          after: { type: "string", minLength: 1, description: "the reworded criterion" },
          check: { type: "string", minLength: 1, description: "how to check the reworded criterion inside the Task" },
        },
      },
      description: "reworded criteria; [] for worker and when no criterion changes",
    },
  },
};

export interface DecisionAnswerTriageReport {
  readonly route: (typeof DECISION_ANSWER_TRIAGE_ROUTES)[number];
  readonly reason: string;
  readonly criteria_rewrites: readonly { readonly criterion_id: string; readonly after: string; readonly check: string }[];
}

export interface DecisionAnswerTriageRequest {
  readonly invocation_id?: string;
  readonly language: "ja" | "en";
  readonly decision: {
    readonly reason: string;
    readonly question: string;
    readonly current_state: string;
    readonly options: readonly { readonly key: string; readonly label: string; readonly description: string }[];
    readonly chosen_option_key: string | null;
    readonly explanation_summary: string | null;
  };
  readonly task: { readonly title: string; readonly acceptance_criteria: readonly { readonly id: string; readonly text: string; readonly check: string }[] };
  readonly answer: string;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly timeout_ms: number;
}

export type DecisionAnswerTriageRunResult =
  | { readonly ok: true; readonly triage: unknown }
  | { readonly ok: false; readonly error: string };

/** Never throws: the schema, then the ids against the Task's criteria. */
export function readDecisionAnswerTriage(
  value: unknown,
  criterionIds: readonly string[],
): { readonly ok: true; readonly value: DecisionAnswerTriageReport } | { readonly ok: false; readonly problem: string } {
  const schemaProblem = validateRoleOutput(DECISION_ANSWER_TRIAGE_SCHEMA, value);
  if (schemaProblem !== null) return { ok: false, problem: schemaProblem };
  const report = value as DecisionAnswerTriageReport;
  if (report.route === "worker" && report.criteria_rewrites.length > 0) return { ok: false, problem: "criteria_rewrites must be [] for route worker" };
  const seen = new Set<string>();
  for (const rewrite of report.criteria_rewrites) {
    if (!criterionIds.includes(rewrite.criterion_id)) return { ok: false, problem: `criteria_rewrites: unknown criterion_id ${rewrite.criterion_id}` };
    if (seen.has(rewrite.criterion_id)) return { ok: false, problem: `criteria_rewrites: duplicate criterion_id ${rewrite.criterion_id}` };
    seen.add(rewrite.criterion_id);
  }
  return { ok: true, value: report };
}
