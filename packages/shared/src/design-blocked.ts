import { validateRoleOutput, type RoleSchema } from "./role-schema.js";

/** wrong_premise: premise is wrong / policy_conflict: conflicts with policy / ambiguous_criteria: criteria are ambiguous / simple_defect: plain defect. */
export const DESIGN_BLOCK_CAUSE_KINDS = ["wrong_premise", "policy_conflict", "ambiguous_criteria", "simple_defect"] as const;
export type DesignBlockCauseKind = (typeof DESIGN_BLOCK_CAUSE_KINDS)[number];

export interface DesignBlockedReport {
  readonly cause_kind: DesignBlockCauseKind;
  readonly cause: string;
  readonly repeated_findings: readonly { readonly summary: string; readonly times: number }[];
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly description: string }[];
  /** 0-based index into options. */
  readonly recommended_option: number | null;
}

export const DESIGN_BLOCKED_SCHEMA: RoleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cause_kind", "cause", "repeated_findings", "question", "options", "recommended_option"],
  properties: {
    cause_kind: { type: "string", enum: [...DESIGN_BLOCK_CAUSE_KINDS], description: "why the design cannot pass: wrong_premise, policy_conflict, ambiguous_criteria or simple_defect" },
    cause: { type: "string", minLength: 1, description: "the cause in one or two sentences" },
    repeated_findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "times"],
        properties: {
          summary: { type: "string", minLength: 1, description: "the point the Reviewer keeps raising" },
          times: { type: "integer", minimum: 1, description: "how many verdicts raised it" },
        },
      },
      description: "Reviewer points that came back in more than one verdict; [] if none",
    },
    question: { type: "string", minLength: 1, description: "the one thing the Owner must decide" },
    options: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "description"],
        properties: {
          label: { type: "string", minLength: 1, description: "short option name" },
          description: { type: "string", minLength: 1, description: "what happens when the Owner picks it" },
        },
      },
      description: "the choices for the Owner",
    },
    recommended_option: { type: ["integer", "null"], minimum: 0, description: "0-based index of the recommended option, or null" },
  },
};

/** Valid report or null. Checks the schema and recommended_option < options.length. Never throws. */
export function readDesignBlocked(value: unknown): DesignBlockedReport | null {
  try {
    if (validateRoleOutput(DESIGN_BLOCKED_SCHEMA, value) !== null) return null;
    const report = value as DesignBlockedReport;
    if (report.recommended_option !== null && report.recommended_option >= report.options.length) return null;
    return report;
  } catch {
    return null;
  }
}
