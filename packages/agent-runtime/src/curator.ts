import type { CuratorRequest, CuratorResultItem } from "@owl/shared";
import {
  extractRoleOutputObject,
  objectSchema,
  providerSchema,
  renderRolePrompt,
  validateRoleOutput,
  type RoleSchema,
} from "./role-contract";
import type { ProviderResponse } from "./types";

const JUDGEMENT_SCHEMA = objectSchema({
  reusable: { type: "number", minimum: 0, maximum: 2, description: "expected reusable score from zero to two" },
  work_specific: { type: "number", minimum: 0, maximum: 1, description: "probability that this is specific to one Work" },
  relation: { type: "string", enum: ["same", "extends", "different"], description: "relationship to the closest candidate skill" },
  confidence: { type: "number", minimum: 0, maximum: 1, description: "confidence in the judgement" },
});

const SKILL_SCHEMA = objectSchema({
  name: { type: "string", minLength: 2, description: "kebab-case skill name; use the existing name for updates" },
  description: { type: "string", minLength: 1, description: "one-line description of at most 300 characters" },
  tags: { type: "array", items: { type: "string", minLength: 1 }, description: "short tags" },
  files: {
    type: "array",
    items: objectSchema({
      path: { type: "string", minLength: 1, description: "SKILL.md or a permitted direct child file path" },
      content: { type: "string", description: "file content; SKILL.md contains only its Markdown body" },
    }),
    description: "complete files for the resulting skill",
  },
});

const CURATOR_RESULT_SCHEMA = objectSchema({
  proposal_id: { type: "string", minLength: 1, description: "the input proposal id" },
  decision: { type: "string", enum: ["create", "update", "merge", "reject"], description: "the proposed operation" },
  judgement: JUDGEMENT_SCHEMA,
  skill: { type: ["object", "null"], properties: SKILL_SCHEMA.properties, required: SKILL_SCHEMA.required, additionalProperties: false, description: "the resulting skill, or null for reject" },
  archive: { type: "array", items: { type: "string", minLength: 1 }, description: "skills made redundant by a merge" },
  reason: { type: "string", minLength: 1, description: "brief reason for this decision" },
});

export const CURATOR_OUTPUT_SCHEMA: RoleSchema = objectSchema({
  results: { type: "array", items: CURATOR_RESULT_SCHEMA, description: "one result for each proposal sent to the Curator" },
});

export function buildCuratorPrompt(request: CuratorRequest): string {
  return renderRolePrompt({
    role: "You are Owl's Curator. Turn durable, reusable work procedures into concise skills.",
    instructions: [
      "Process each proposal independently and return one result with the matching proposal_id.",
      request.with_judgement
        ? "Judge reuse value, Work specificity, relation, and confidence before writing."
        : "A prior judgement has already passed. Use the supplied proposals and candidate skills to write or reject each result.",
      "For an update, preserve the candidate skill name and return every file in the finished revision. For a merge, write the integrated result and list redundant skill names in archive.",
      "Each proposal lists candidate_skill_names. Compare that proposal only with those candidates; use the skill index for other names and descriptions.",
      "Do not include frontmatter in SKILL.md. Core writes the name, description, tags, and scope metadata.",
      "Use only SKILL.md or direct files under references/, scripts/, and templates/. Do not choose a scope.",
      "Do not invent evidence or imply a command was verified when it was not.",
    ],
    output: CURATOR_OUTPUT_SCHEMA,
    outputRules: [
      "A reject result has skill set to null. Every other result has a complete skill.files array containing SKILL.md.",
      "When with_judgement is false, judgement is required by the output shape but Core ignores it.",
    ],
    language: request.language ?? "en",
    inputs: [
      { name: "Proposals", value: request.proposals },
      { name: "Skill index", value: request.skill_index },
      { name: "Candidate skills", value: request.candidates },
      { name: "Recent skill usage", value: request.usages },
      { name: "Curator settings", value: { with_judgement: request.with_judgement } },
    ],
  });
}

export function parseCuratorOutput(value: unknown): { readonly results: CuratorResultItem[] } | { readonly error: string } {
  const problem = validateRoleOutput(CURATOR_OUTPUT_SCHEMA, value);
  if (problem) return { error: `curator_output_schema:${problem}` };
  return { results: (value as { results: CuratorResultItem[] }).results };
}

export function parseCuratorResponse(
  response: Pick<ProviderResponse, "adapter" | "stdout" | "format">,
): { readonly results: CuratorResultItem[] } | { readonly error: string } {
  try {
    return parseCuratorOutput(extractRoleOutputObject(response, "curator_stdout_not_single_json_object"));
  } catch (error) {
    return { error: error instanceof Error ? error.message : "curator_output_invalid" };
  }
}

export function curatorProviderSchema(): Readonly<Record<string, unknown>> {
  return providerSchema(CURATOR_OUTPUT_SCHEMA);
}
