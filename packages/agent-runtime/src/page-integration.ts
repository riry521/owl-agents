import {
  extractRoleOutputObject,
  objectSchema,
  providerSchema,
  renderRolePrompt,
  validateRoleOutput,
  type RoleSchema,
} from "./role-contract";
import type { OwnerLanguage } from "@owl/shared";
import { AgentRuntimeError } from "./errors";
import type { ProviderResponse } from "./types";

/** Structural copies of Core's `PageIntegrationRequest` / `MigrationClassifyRequest` (the runner receives them as plain objects). */
export interface LibrarianModelSetting { readonly provider: string; readonly model: string; readonly effort: string }
export interface PageIntegrationRequest {
  readonly run_id: string;
  readonly reason: string;
  readonly page: { readonly path: string; readonly title: string; readonly scope: string; readonly project_id: string | null; readonly body: string; readonly tokens: number };
  readonly new_lines: ReadonlyArray<{ section: string; text: string; work_label: string | null }>;
  readonly siblings: ReadonlyArray<{ title: string; summary: string }>;
  readonly referrers?: readonly { path: string; heading: string }[];
  readonly rules: string;
  readonly model: LibrarianModelSetting;
  readonly max_output_tokens: number;
  readonly language?: OwnerLanguage;
}
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

export const PAGE_INTEGRATION_OUTPUT_SCHEMA: RoleSchema = objectSchema({
  op: { type: "string", enum: ["rewrite", "split", "merge_into", "create_from_misc", "noop"], description: "what was done to the page" },
  pages: {
    type: "array",
    items: objectSchema({
      path: { type: "string", minLength: 1, description: "vault-relative path of the output page" },
      title: { type: "string", minLength: 1, description: "page title, 30 characters or fewer" },
      summary: { type: "string", minLength: 1, description: "one-line description, 40 characters or fewer" },
      body: { type: "string", minLength: 1, description: "the body from the `## 概要` heading on, without frontmatter or the H1" },
    }),
    description: "the finished pages; empty only for noop",
  },
  history_line: { type: "string", description: "one 更新履歴 line; write `n 行統合` when n lines were merged away" },
  star_changes: { type: "array", items: { type: "string" }, description: "lines that gained or lost the ★ mark" },
  link_updates: { type: "array", items: { type: "string" }, description: "split only: `path`s from `referrers` whose links to the split page now belong to the new page; otherwise empty" },
  reason: { type: "string", description: "why this operation was chosen" },
});

export function buildPageIntegrationPrompt(request: PageIntegrationRequest): string {
  return renderRolePrompt({
    role: "You are Owl's Librarian. Integrate a theme page of the long-term memory.",
    instructions: [
      `Reason for this run: ${request.reason}. Rewrite the page body so it follows the rules below; keep every fact unless it is a duplicate.`,
      request.rules,
      `Keep the output within ${request.max_output_tokens} tokens.`,
    ],
    output: PAGE_INTEGRATION_OUTPUT_SCHEMA,
    outputRules: [],
    language: request.language ?? "ja",
    inputs: [
      { name: "Page", value: request.page },
      { name: "New lines", value: request.new_lines },
      { name: "Sibling pages", value: request.siblings },
      ...(request.referrers?.length ? [{ name: "Referrers", value: request.referrers }] : []),
    ],
  });
}

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
      { name: "Pages", value: request.pages },
      { name: "Dormant candidates", value: request.dormant_candidates },
      { name: "Conversations", value: request.conversations ?? [] },
      { name: "Clippings", value: request.clippings ?? [] },
    ],
  });
}

export const parseLibrarianOperationsResponse = (response: Pick<ProviderResponse, "adapter" | "stdout" | "format">) =>
  parseWith(LIBRARIAN_OPERATIONS_OUTPUT_SCHEMA, "librarian_operations_stdout_not_single_json_object", "librarian_operations", response);

export const parsePageIntegrationResponse = (response: Pick<ProviderResponse, "adapter" | "stdout" | "format">) =>
  parseWith(PAGE_INTEGRATION_OUTPUT_SCHEMA, "page_integration_stdout_not_single_json_object", "page_integration", response);

export const pageIntegrationProviderSchema = (): Readonly<Record<string, unknown>> => providerSchema(PAGE_INTEGRATION_OUTPUT_SCHEMA);

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
      { name: "Clipping", value: { title: request.title, summary: request.summary, points: request.points } },
    ],
  });
}

export const parseClippingTagsResponse = (response: Pick<ProviderResponse, "adapter" | "stdout" | "format">) =>
  parseWith(CLIPPING_TAGS_OUTPUT_SCHEMA, "clipping_tags_stdout_not_single_json_object", "clipping_tags", response);
