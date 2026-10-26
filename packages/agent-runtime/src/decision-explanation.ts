import {
  DECISION_EXPLANATION_SCHEMA,
  DECISION_FIX_OPTION_KINDS,
  DECISION_FIX_OPTIONS_MIN,
  type DecisionExplanationReport,
  type DecisionExplanationRequest,
} from "@owl/shared";
import { OutputFormatError } from "./output-resubmit";
import { extractRoleOutputObject, providerSchema, renderRolePrompt } from "./role-contract";
import type { ProviderResponse } from "./types";

export function buildDecisionExplanationPrompt(request: DecisionExplanationRequest): string {
  const allowsFix = DECISION_FIX_OPTION_KINDS.includes(request.kind);
  return renderRolePrompt({
    role: "You are Owl's Manager. Something stopped and the Owner has to decide what happens next. You explain why it stopped and what the Owner can do.",
    instructions: [
      "The reader is the Owner, who does not know Owl's internal words.",
      "Write plain sentences.",
      "summary: the neck, in the Owner's words: what keeps the work from going on. Say what is stuck, not how Owl works inside.",
      "next_steps: what the Owner can do now. Say that when none of the choices fits, a word in the answer field is enough and the Manager will follow it and fix things.",
      "Never ask the Owner to do the Manager's or a Worker's work: do not ask them to remake a Task, rewrite acceptance criteria, fix the plan or run commands. Offer choices; the Manager does the work after the Owner picks one.",
      "Never write an id: a Task, Work or Decision id, any 26-character id, or a criterion number such as AC1.",
      "Never write Owl's own internal terms: field or state names such as auto_recovery or plan_rejected, or \"partial\" (say \"did not finish\" or \"stopped halfway\" instead), not even in backticks. A name from the Owner's own project, such as a setting or file name, may be written when it is in `backticks`; a snake_case name outside backticks is refused.",
      `Also never write these words (this Decision's forbidden_terms): ${JSON.stringify(request.forbidden_terms)}.`,
      "option_notes: for every option in Decision.options, its key and what happens, from the Owner's side, when the Owner picks it. Do not add, drop or rename options, and write no note for your own fix_N options: their description says it.",
      "recommended_option_key: exactly one key. When Decision.recommended is set, use it.",
      "cause_kind: work = the criteria are valid and the Task's work is lacking or wrong; criteria = the acceptance criteria themselves cannot be met inside the Task, cannot be measured as written, or conflict with the Project rules; external = the cause is outside the Task (environment, another Work, an outside service, permissions).",
      ...(allowsFix
        ? [
            `options: every way to go on that makes sense in this situation, at least ${DECISION_FIX_OPTIONS_MIN}. Do not stop at "retry as is" and "cancel": Core always adds those. Write each label as a question to the Owner in the form "〜にしますか？" (in English, "Do you want to …?"), and in description say what happens, from the Owner's side, when they pick it. Show one recommendation: unless Decision.recommended is set, recommended_option_key is fix_1, fix_2, ..., the number of the option you recommend, never retry or cancel.`,
            "instruction: what the Manager should do when the Owner picks the option, written so the Manager can carry it out as is.",
            "When the cause is the criteria, give criteria_rewrites: for each criterion to reword, its criterion_id, the reworded text in after, and in check how to verify it by something the Task itself can run. Otherwise criteria_rewrites is [].",
          ]
        : ["options must be []. cause_kind may still be criteria; the Decision's own options already cover how to change the criteria."]),
      "When Revision is given, keep what was fine and fix only the listed problems.",
      "Use the inputs as evidence. Do not copy the Decision's texts as they are.",
    ],
    output: DECISION_EXPLANATION_SCHEMA,
    outputRules: ["Output exactly one JSON object at the end."],
    language: request.language,
    inputs: [
      { name: "Kind", value: request.kind },
      { name: "Decision", value: request.decision },
      { name: "Task", value: request.task },
      { name: "Reports", value: request.reports },
      { name: "Verification", value: request.verification },
      { name: "Project rules", value: request.rules },
      ...(request.revision ? [{ name: "Revision", value: request.revision }] : []),
    ],
  });
}

export function decisionExplanationProviderSchema(): Readonly<Record<string, unknown>> {
  return providerSchema(DECISION_EXPLANATION_SCHEMA);
}

/**
 * Reads the answer as one JSON object; throws OutputFormatError when it is not one so the runner can ask the model again.
 * The content checks are Core's, which asks again with the failed reasons as the revision and within the configured rewrite limit.
 */
export function parseDecisionExplanationResponse(response: Pick<ProviderResponse, "adapter" | "stdout" | "format">): DecisionExplanationReport {
  try {
    return extractRoleOutputObject(response, "decision_explanation_stdout_not_single_json_object", { allowCodeFence: true }) as unknown as DecisionExplanationReport;
  } catch (error) {
    throw new OutputFormatError(error instanceof Error ? error.message : "decision_explanation_output_invalid");
  }
}
