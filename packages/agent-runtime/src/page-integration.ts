import {
  extractRoleOutputObject,
  objectSchema,
  renderRolePrompt,
  validateRoleOutput,
  type RoleSchema,
} from "./role-contract";
import { externalJsonBlock, type OwnerLanguage } from "@owl/shared";
import { AgentRuntimeError } from "./errors";
import type { ProviderResponse } from "./types";

export interface LibrarianModelSetting { readonly provider: string; readonly model: string; readonly effort: string }
export interface ClippingTagsRequest {
  readonly title: string;
  readonly summary: string;
  readonly points: readonly string[];
  readonly existing_tags: readonly string[];
  readonly min: number;
  readonly max: number;
  readonly model: LibrarianModelSetting;
  readonly language?: OwnerLanguage;
}
export type LibrarianRunResult =
  | { readonly ok: true; readonly output: unknown; readonly usage?: { readonly input_tokens: number; readonly output_tokens: number } }
  | { readonly ok: false; readonly error: string };

function parseWith(schema: RoleSchema, reason: string, label: string, response: Pick<ProviderResponse, "adapter" | "stdout" | "format">): { readonly output: unknown } | { readonly error: string } {
  try {
    const value = extractRoleOutputObject(response, reason, { allowCodeFence: true });
    const problem = validateRoleOutput(schema, value);
    return problem ? { error: `${label}_output_schema:${problem}` } : { output: value };
  } catch (error) {
    // AgentRuntimeError.message is a generic contract text; its `reason` says what was wrong.
    const reasonText = error instanceof AgentRuntimeError ? `${error.reason}: ${error.message}` : error instanceof Error ? error.message : `${label}_output_invalid`;
    return { error: `${reasonText} (stdout tail: ${response.stdout.slice(-400)})` };
  }
}

/** Structural copy of Core's `LibrarianOpsRequest`. */
export interface LibrarianOperationsRequest {
  readonly run_id: string;
  readonly pages: readonly unknown[];
  readonly dormant_candidates: readonly string[];
  readonly conversations?: readonly unknown[];
  readonly clippings?: readonly unknown[];
  readonly rules: string;
  readonly model: LibrarianModelSetting;
  readonly max_output_tokens: number;
  readonly language?: OwnerLanguage;
}

/** The model names operations only; the operation shapes are checked by Core's applier, so the items are free-form objects here. */
export const LIBRARIAN_OPERATIONS_OUTPUT_SCHEMA: RoleSchema = {
  type: "object",
  properties: {
    operations: { type: "array", items: { type: "object" }, description: "the operations to apply, in order; [] when nothing needs doing" },
    note: { type: "string", description: "optional short remark" },
  },
  required: ["operations"],
  additionalProperties: false,
};

export function buildLibrarianOperationsPrompt(request: LibrarianOperationsRequest): string {
  return renderRolePrompt({
    role: "You are Owl's Librarian. Tidy the theme pages of the long-term memory by operations.",
    instructions: [
      "Take in new lines, merge duplicates, retire contradicted or stale lines with evidence, link related pages and name pages to put to sleep. Do nothing when nothing needs doing.",
      request.rules,
      `Keep the output within ${request.max_output_tokens} tokens.`,
    ],
    output: LIBRARIAN_OPERATIONS_OUTPUT_SCHEMA,
    outputRules: [],
    language: request.language ?? "ja",
    inputs: [
      { name: "Pages", value: externalJsonBlock("owl-pages", request.pages) },
      { name: "Dormant candidates", value: request.dormant_candidates },
      { name: "Conversations", value: externalJsonBlock("owl-conversations", request.conversations ?? []) },
      { name: "Clippings", value: externalJsonBlock("owl-clippings", request.clippings ?? []) },
    ],
  });
}

export const parseLibrarianOperationsResponse = (response: Pick<ProviderResponse, "adapter" | "stdout" | "format">) =>
  parseWith(LIBRARIAN_OPERATIONS_OUTPUT_SCHEMA, "librarian_operations_stdout_not_single_json_object", "librarian_operations", response);

export const CLIPPING_TAGS_OUTPUT_SCHEMA: RoleSchema = objectSchema({
  tags: { type: "array", items: { type: "string", minLength: 1 }, description: "tags describing the content of the article" },
});

export function buildClippingTagsPrompt(request: ClippingTagsRequest): string {
  return renderRolePrompt({
    role: "You are Owl's Librarian. Tag a web clipping by its content.",
    instructions: [
      `Return ${request.min} to ${request.max} tags that describe what the article is about (topics, technologies, subjects).`,
      "Write each tag in lowercase English letters, digits and hyphens only (for example `date-library`).",
      "Reuse a tag from Existing tags when it means the same thing; add a new tag only when none fits.",
      "Do not use tags that name the kind of page, such as research, web-search or web-fetch.",
    ],
    output: CLIPPING_TAGS_OUTPUT_SCHEMA,
    outputRules: [],
    language: request.language ?? "ja",
    inputs: [
      { name: "Existing tags", value: request.existing_tags },
      { name: "Clipping", value: externalJsonBlock("owl-clipping", { title: request.title, summary: request.summary, points: request.points }) },
    ],
  });
}

export const parseClippingTagsResponse = (response: Pick<ProviderResponse, "adapter" | "stdout" | "format">) =>
  parseWith(CLIPPING_TAGS_OUTPUT_SCHEMA, "clipping_tags_stdout_not_single_json_object", "clipping_tags", response);

export interface RuleJudgmentsRequest {
  readonly model: LibrarianModelSetting;
  readonly language?: OwnerLanguage;
  readonly run_id?: string;
  readonly pairs: ReadonlyArray<{ readonly pair_id: string; readonly left: string; readonly right: string }>;
}

/** Only "a JSON object" is required here: Core's op-shape normalisation absorbs deviations in the judgments, so a strict schema would only turn recoverable answers into failures. */
export const RULE_JUDGMENTS_OUTPUT_SCHEMA: RoleSchema = {
  type: "object",
  properties: {
    judgments: {
      type: "array",
      items: { type: "object" },
      description: "one entry per pair: { pair_id, relation: same | conflict | different, reason? (short) }",
    },
  },
};

export function buildRuleJudgmentsPrompt(request: RuleJudgmentsRequest): string {
  return renderRolePrompt({
    role: "You are Owl's Librarian. Judge how pairs of rule statements relate in meaning.",
    instructions: [
      "For each pair, answer with relation `same` (they ask for the same thing, only worded differently), `conflict` (they cannot both be followed) or `different` (unrelated, or compatible but distinct).",
      "Answer every pair and copy its pair_id exactly. Add a short reason when the relation is `same` or `conflict`.",
    ],
    output: RULE_JUDGMENTS_OUTPUT_SCHEMA,
    outputRules: [],
    language: request.language ?? "ja",
    inputs: [{ name: "Pairs", value: request.pairs }],
  });
}

export const parseRuleJudgmentsResponse = (response: Pick<ProviderResponse, "adapter" | "stdout" | "format">) =>
  parseWith(RULE_JUDGMENTS_OUTPUT_SCHEMA, "rule_judgments_stdout_not_single_json_object", "rule_judgments", response);
