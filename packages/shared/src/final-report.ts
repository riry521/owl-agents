import type { JsonObject } from "./index.js";
import type { RoleSchema } from "./role-schema.js";

/** The model's answer for the final report of a completed Work: three sections, each a few short lines. */
export const FINAL_REPORT_SCHEMA: RoleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "test_results", "issues"],
  properties: {
    summary: { type: "string", minLength: 1, description: "a brief report: what was done and what changed as a result" },
    test_results: { type: "string", minLength: 1, description: "the result of each acceptance criterion and of the tests, and how each was checked" },
    issues: { type: "string", minLength: 1, description: "the goals that were not met with the reason for each, and the issues that remain" },
  },
};

/** The three sections of a final report. */
export interface FinalReportSections {
  readonly summary: string;
  readonly test_results: string;
  readonly issues: string;
}

/** What a final report check receives on stdin. */
export interface FinalReportCheckInput extends FinalReportSections {
  readonly language: "ja" | "en";
}

/** The runner request and result; Core and agent-runtime both import them from here. */
export interface FinalReportRequest {
  readonly invocation_id?: string;
  readonly language: "ja" | "en";
  readonly work: { readonly title: string; readonly summary: string };
  readonly final_verdict_summary: string;
  readonly tasks: readonly JsonObject[];
  readonly goal_shortfalls: readonly JsonObject[];
  readonly rules: string | null;
  /** Set only when asking for a rewrite after a check found problems. */
  readonly revision: { readonly report: FinalReportSections; readonly problems: readonly string[] } | null;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly timeout_ms: number;
}
export type FinalReportRunResult =
  | { readonly ok: true; readonly report: FinalReportSections }
  | { readonly ok: false; readonly error: string };

/** The problems of a check's answer: null when the text is fine; throws when the answer is neither `{ok:true}` nor `{ok:false, problems}`. */
export function readFinalReportCheckOutput(value: unknown): readonly string[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("final report check output must be an object");
  const { ok, problems } = value as { ok?: unknown; problems?: unknown };
  if (ok === true) return null;
  if (ok !== false || !Array.isArray(problems) || problems.length === 0 || !problems.every((p) => typeof p === "string" && p.length > 0)) {
    throw new Error("final report check output must be {ok:true} or {ok:false, problems:[non-empty strings]}");
  }
  return problems.slice(0, 10) as string[];
}
