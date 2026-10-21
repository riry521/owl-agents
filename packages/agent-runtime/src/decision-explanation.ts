import {
  DECISION_EXPLANATION_SCHEMA,
  DECISION_FIX_OPTIONS_MAX,
  DECISION_FIX_OPTIONS_MIN,
  readDecisionExplanation,
  type DecisionExplanationReport,
  type DecisionExplanationRequest,
} from "@owl/shared";
import { OutputFormatError } from "./output-resubmit";
import { extractRoleOutputObject, providerSchema, renderRolePrompt } from "./role-contract";
import type { ProviderResponse } from "./types";

export function buildDecisionExplanationPrompt(request: DecisionExplanationRequest): string {
  return renderRolePrompt({
    role: "You are Owl's Manager. A Task stopped and the Owner has to decide what happens next. You explain why it stopped and propose ways to fix it.",
    instructions: [
      "The reader is the Owner, who does not know Owl's internal words.",
      "summary: one or two sentences saying what happened and what is missing.",
      "Never write these words in any value: partial or \"partial report\" (say \"did not finish\" or \"stopped halfway\" instead); a criterion number such as AC1 (quote the criterion's content briefly or reword it); a Task or Work id, a 26-character alphanumeric id, or an internal state name such as judgement_waiting.",
      `Also never write these words (this Decision's forbidden_terms): ${JSON.stringify(request.forbidden_terms)}.`,
      "cause_kind: work = the criteria are valid and the Task's work is lacking or wrong; criteria = the acceptance criteria themselves cannot be met inside the Task, cannot be measured as written, or conflict with the Project rules; external = the cause is outside the Task (environment, another Work, an outside service, permissions).",
      `options: ${DECISION_FIX_OPTIONS_MIN} to ${DECISION_FIX_OPTIONS_MAX} ways to fix the stop. Do not include "retry as is" or "cancel": Core always adds them.`,
      "instruction: what the Manager should do when the Owner picks the option, written so the Manager can carry it out as is.",
      "When the cause is the criteria, give criteria_rewrites: for each criterion to reword, its criterion_id, the reworded text in after, and in check how to verify it by something the Task itself can run. Otherwise criteria_rewrites is [].",
      "recommended_option: choose exactly one option as the recommendation, by its 0-based index in options.",
      "Use the Task's reports, the verification record and the Project rules in the inputs as evidence.",
    ],
    output: DECISION_EXPLANATION_SCHEMA,
    outputRules: ["Output exactly one JSON object at the end."],
    language: request.language,
    inputs: [
      { name: "Task", value: request.task },
      { name: "Reports", value: request.reports },
      { name: "Verification", value: request.verification },
      { name: "Project rules", value: request.rules },
    ],
  });
}

export function decisionExplanationProviderSchema(): Readonly<Record<string, unknown>> {
  return providerSchema(DECISION_EXPLANATION_SCHEMA);
}

/** Throws OutputFormatError with the problem so the runner can ask the model again. */
export function parseDecisionExplanationResponse(
  response: Pick<ProviderResponse, "adapter" | "stdout" | "format">,
  request: DecisionExplanationRequest,
): DecisionExplanationReport {
  let value: Record<string, unknown>;
  try {
    value = extractRoleOutputObject(response, "decision_explanation_stdout_not_single_json_object", { allowCodeFence: true });
  } catch (error) {
    throw new OutputFormatError(error instanceof Error ? error.message : "decision_explanation_output_invalid");
  }
  const checked = readDecisionExplanation(value, {
    criterion_ids: request.task.acceptance_criteria.map((criterion) => criterion.id),
    forbidden_terms: request.forbidden_terms,
  });
  if (!checked.ok) throw new OutputFormatError(checked.problem);
  return checked.value;
}
