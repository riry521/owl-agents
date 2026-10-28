import { FINAL_REPORT_SCHEMA, type FinalReportRequest, type FinalReportSections } from "@owl/shared";
import { OutputFormatError } from "./output-resubmit";
import { extractRoleOutputObject, providerSchema, renderRolePrompt } from "./role-contract";
import type { ProviderResponse } from "./types";

export function buildFinalReportPrompt(request: FinalReportRequest): string {
  return renderRolePrompt({
    role: "You are Owl's Manager. A Work has just been completed. You write its final report for the Owner.",
    instructions: [
      "The reader has no specialist knowledge: write so that a junior-high or high-school student can follow it.",
      "Avoid technical terms, identifiers and abbreviations; when you must use one, add a short explanation next to it.",
      "Keep every sentence short. Start with what changed and what got better for the people who use it.",
      "Write three sections, each a few short lines in plain sentences.",
      "summary is a brief report: what was done and what changed as a result.",
      "test_results gives the result of each acceptance criterion and of the tests: met or not, and how it was checked.",
      "issues lists the goals that were not met with the reason for each, and the issues that remain.",
      "Never leave a section empty: when issues has nothing to say (no unmet goal, no remaining issue), write a short \"none\" in the output language.",
      "Use the inputs as evidence only. Do not invent results that the inputs do not show.",
      "When Revision is given, keep what was fine and fix only the listed problems.",
    ],
    output: FINAL_REPORT_SCHEMA,
    outputRules: ["Output exactly one JSON object at the end."],
    language: request.language,
    inputs: [
      { name: "Work", value: request.work },
      { name: "Final verdict", value: request.final_verdict_summary },
      { name: "Tasks", value: request.tasks },
      { name: "Unmet goals", value: request.goal_shortfalls },
      { name: "Project rules", value: request.rules },
      ...(request.revision ? [{ name: "Revision", value: request.revision }] : []),
    ],
  });
}

export function finalReportProviderSchema(): Readonly<Record<string, unknown>> {
  return providerSchema(FINAL_REPORT_SCHEMA);
}

/** The sections of the answer; throws OutputFormatError when it is not one JSON object with three non-empty sections so the runner can ask the model again. */
export function parseFinalReportResponse(response: Pick<ProviderResponse, "adapter" | "stdout" | "format">): FinalReportSections {
  try {
    const answer = extractRoleOutputObject(response, "final_report_stdout_not_single_json_object", { allowCodeFence: true }) as Record<string, unknown>;
    const [summary, test_results, issues] = (["summary", "test_results", "issues"] as const).map((key) => {
      const value = answer[key];
      if (typeof value !== "string" || value.trim().length === 0) throw new Error(`final_report_${key}_missing`);
      return value.trim();
    });
    return { summary, test_results, issues };
  } catch (error) {
    throw new OutputFormatError(error instanceof Error ? error.message : "final_report_output_invalid");
  }
}
