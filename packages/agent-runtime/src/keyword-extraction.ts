import {
  extractRoleOutputObject,
  objectSchema,
  providerSchema,
  renderRolePrompt,
  validateRoleOutput,
  type RoleSchema,
} from "./role-contract";
import type { OwnerLanguage } from "@owl/shared";
import type { ProviderResponse } from "./types";

export interface KeywordExtractionRequest {
  readonly items: ReadonlyArray<{ id: string; title: string; summary: string; claims: readonly string[]; current_tags: readonly string[] }>;
  readonly language?: OwnerLanguage;
  readonly invocation_id?: string;
}
export type KeywordExtractionRunResult =
  | { readonly ok: true; readonly items: Array<{ id: string; keywords: string[] }> }
  | { readonly ok: false; readonly error: string };

export const KEYWORD_OUTPUT_SCHEMA: RoleSchema = objectSchema({
  items: {
    type: "array",
    items: objectSchema({
      id: { type: "string", minLength: 1, description: "the input item id" },
      keywords: {
        type: "array",
        items: { type: "string", minLength: 1 },
        description: "3-5 short noun keywords (topic words, product/tool names); no sentences, particles, verb endings or hiragana",
      },
    }),
    description: "one entry for every input item",
  },
});

export function buildKeywordPrompt(request: KeywordExtractionRequest): string {
  return renderRolePrompt({
    role: "You are Owl's Librarian. Choose search keywords for knowledge notes.",
    instructions: [
      "For every item return 3 to 5 short keywords that name its topics (nouns, product or tool names).",
      "A keyword is a word, never a sentence fragment: no particles, no verb endings, no punctuation, no spaces; Japanese keywords use kanji or katakana only.",
      "Return every input id exactly once.",
    ],
    output: KEYWORD_OUTPUT_SCHEMA,
    outputRules: [],
    language: request.language ?? "en",
    inputs: [{ name: "Items", value: request.items }],
  });
}

export function parseKeywordResponse(
  response: Pick<ProviderResponse, "adapter" | "stdout" | "format">,
): { readonly items: Array<{ id: string; keywords: string[] }> } | { readonly error: string } {
  try {
    const value = extractRoleOutputObject(response, "keywords_stdout_not_single_json_object");
    const problem = validateRoleOutput(KEYWORD_OUTPUT_SCHEMA, value);
    if (problem) return { error: `keywords_output_schema:${problem}` };
    return { items: (value as { items: Array<{ id: string; keywords: string[] }> }).items };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "keywords_output_invalid" };
  }
}

export function keywordProviderSchema(): Readonly<Record<string, unknown>> {
  return providerSchema(KEYWORD_OUTPUT_SCHEMA);
}
