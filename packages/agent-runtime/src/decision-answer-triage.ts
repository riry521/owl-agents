import { DECISION_ANSWER_TRIAGE_SCHEMA, type DecisionAnswerTriageReport, type DecisionAnswerTriageRequest } from "@owl/shared";
import { OutputFormatError } from "./output-resubmit";
import { extractRoleOutputObject, providerSchema, renderRolePrompt } from "./role-contract";
import type { ProviderResponse } from "./types";

export function buildDecisionAnswerTriagePrompt(request: DecisionAnswerTriageRequest): string {
  return renderRolePrompt({
    role: "You are Owl's Manager. The Owner answered a Decision with their own words. You decide whether the words change the plan or only help the Worker.",
    instructions: [
      "route manager: the words ask to change the goal, the scope, the way of working or the acceptance criteria; or what they ask for cannot be done together with the current criteria; or they ask to add, drop or split Tasks.",
      "route worker: the words only give information or advice for going on with the same Task and the same criteria (what was waited for has arrived, where a file is, a hint).",
      "When in doubt, choose manager.",
      "criteria_rewrites: for route manager, for each criterion the words change, give its criterion_id, the reworded criterion in after, and in check how to verify it by something the Task itself can run. When no criterion changes, and for route worker, criteria_rewrites is [].",
      "Write after and check in the language of the Task's criteria. Never use a criterion_id that Task.acceptance_criteria does not have.",
      "reason: one sentence on why you chose the route.",
    ],
    output: DECISION_ANSWER_TRIAGE_SCHEMA,
    outputRules: ["Output exactly one JSON object at the end."],
    language: request.language,
    inputs: [
      { name: "Decision", value: request.decision },
      { name: "Task", value: request.task },
      { name: "Owner's words", value: request.answer },
    ],
  });
}

export function decisionAnswerTriageProviderSchema(): Readonly<Record<string, unknown>> {
  return providerSchema(DECISION_ANSWER_TRIAGE_SCHEMA);
}

/** Reads one JSON object; throws OutputFormatError otherwise. The content checks are Core's (readDecisionAnswerTriage). */
export function parseDecisionAnswerTriageResponse(response: Pick<ProviderResponse, "adapter" | "stdout" | "format">): DecisionAnswerTriageReport {
  try {
    return extractRoleOutputObject(response, "decision_answer_triage_stdout_not_single_json_object", { allowCodeFence: true }) as unknown as DecisionAnswerTriageReport;
  } catch (error) {
    throw new OutputFormatError(error instanceof Error ? error.message : "decision_answer_triage_output_invalid");
  }
}
