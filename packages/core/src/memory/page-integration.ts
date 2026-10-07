import { PAGE_LIMITS, parsePage, SOURCE_LABEL, validatePage, type ParsedPage } from "./page-format.js";
import type { PageRow } from "./memory-types.js";

/** One librarian integration run (design §3.7) and the migration line classifier (§3.9): requests, and checks of the model output. */

export interface MemoryLibrarianSetting { readonly provider: string; readonly model: string; readonly effort: string }

export interface PageIntegrationRequest {
  readonly run_id: string;
  readonly reason: "owl_new" | "over_budget" | "template_invalid" | "create_from_misc" | "migration";
  readonly page: { path: string; title: string; scope: "project" | "common"; project_id: string | null; body: string; tokens: number };
  readonly new_lines: readonly { section: string; text: string; work_label: string | null }[];
  readonly siblings: readonly { title: string; summary: string }[];
  /** Paths of pages that link to this page (a split names the links that move). */
  readonly referrers?: readonly { path: string; heading: string }[];
  readonly rules: string;
  readonly model: MemoryLibrarianSetting;
  readonly max_output_tokens: number;
}
export type PageIntegrationResult =
  | { readonly ok: true; readonly output: unknown; readonly usage?: { input_tokens: number; output_tokens: number } }
  | { readonly ok: false; readonly error: string };
export type IntegrateFn = (request: PageIntegrationRequest) => Promise<PageIntegrationResult>;

export const INTEGRATION_OPS = ["rewrite", "split", "merge_into", "create_from_misc", "noop"] as const;
export interface IntegrationOutput {
  readonly op: typeof INTEGRATION_OPS[number];
  readonly pages: readonly { path: string; title: string; summary: string; body: string }[];
  readonly history_line: string;
  readonly star_changes: readonly string[];
  /** Split only: referrer paths whose links to the split page move to the new page. */
  readonly link_updates?: readonly string[];
  readonly reason: string;
}

export const INTEGRATION_RULES = [
  "Keep the template: sections 概要・決まりごと・落とし穴・手順・関連ページ・更新履歴, in this order, headings unchanged.",
  "Fold every `<!-- owl:new … -->` line into the right section and remove the mark. Merge duplicates; keep one line per fact.",
  "概要 ≤ 8 facts (≤ 60 chars each), 決まりごと ≤ 12, 落とし穴 ≤ 15, 手順 ≤ 3, 関連ページ ≤ 8, 更新履歴 ≤ 8 lines.",
  "Cite sources as (W812) or, for a conversation, (会話2026-10-04-1), keeping them as written, with at most 2 sources per line. Never write ULIDs, API keys or tokens.",
  "Mark ★ only lines that meant a repeated failure, an Owner instruction or a certain job failure; at most 3 per page.",
  "history_line is one line `YYYY-MM-DD W番号 …`; when lines were merged away write `n 行統合` with the exact count.",
  "When you split a page, put `[[title]]` of the other page in each page's 関連ページ.",
  "When you split a page, list in link_updates the `referrers` whose links were about the topic that moved to the new page; otherwise link_updates is empty.",
  "The whole page must stay within 3,000 tokens. Output the body from `## 概要` on.",
].join("\n");

const NEW_MARK = new RegExp(`<!--\\s*owl:new\\s+(\\S+)(?:\\s+(${SOURCE_LABEL}))?[^>]*-->`, "u");

/** The lines of a page still carrying an `owl:new` mark, read per section from the parsed page. */
export function newLinesOf(text: string): { section: string; text: string; work_label: string | null }[] {
  const new_lines: { section: string; text: string; work_label: string | null }[] = [];
  for (const section of parsePage(text).sections) {
    for (const line of section.lines) {
      const mark = NEW_MARK.exec(line);
      if (mark) new_lines.push({ section: section.heading, text: line.replace(NEW_MARK, "").trim(), work_label: mark[2] ?? null });
    }
  }
  return new_lines;
}

export function buildIntegrationRequest(input: {
  run_id: string; reason: PageIntegrationRequest["reason"]; page: PageRow; text: string; siblings: readonly PageRow[]; model: MemoryLibrarianSetting; referrers?: readonly { path: string; heading: string }[];
}): PageIntegrationRequest {
  const parsed = parsePage(input.text);
  const start = input.text.search(/^## /mu);
  const body = input.text.slice(start >= 0 ? start : 0);
  const new_lines = newLinesOf(input.text);
  return {
    run_id: input.run_id,
    reason: input.reason,
    page: {
      path: input.page.path,
      title: input.page.title,
      scope: input.page.page_scope === "common" ? "common" : "project",
      project_id: input.page.project_id,
      body,
      tokens: input.page.token_estimate,
    },
    new_lines,
    siblings: input.siblings.filter((s) => s.path !== input.page.path).map((s) => ({ title: s.title, summary: s.summary })),
    ...(input.referrers ? { referrers: input.referrers } : {}),
    rules: INTEGRATION_RULES,
    model: input.model,
    max_output_tokens: PAGE_LIMITS.librarian_output_tokens,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

export function checkIntegrationOutput(
  raw: unknown,
  before: ParsedPage,
  options: { resolveLink: (t: string) => boolean },
): { ok: true; output: IntegrationOutput; pages: readonly ParsedPage[] } | { ok: false; errors: readonly string[] } {
  if (!isRecord(raw)) return { ok: false, errors: ["output_not_object"] };
  const errors: string[] = [];
  if (!(INTEGRATION_OPS as readonly unknown[]).includes(raw.op)) errors.push("invalid_op");
  if (!isStr(raw.history_line)) errors.push("history_line_missing");
  if (!isStr(raw.reason)) errors.push("reason_missing");
  if (!Array.isArray(raw.star_changes) || !raw.star_changes.every(isStr)) errors.push("star_changes_invalid");
  if (raw.link_updates !== undefined && (!Array.isArray(raw.link_updates) || !raw.link_updates.every(isStr))) errors.push("link_updates_invalid");
  if (raw.op !== "split" && Array.isArray(raw.link_updates) && raw.link_updates.length > 0) errors.push("link_updates_only_for_split");
  const rawPages = Array.isArray(raw.pages) ? raw.pages : null;
  if (!rawPages || !rawPages.every((p) => isRecord(p) && isStr(p.path) && isStr(p.title) && isStr(p.summary) && isStr(p.body))) errors.push("pages_invalid");
  if (errors.length > 0 || !rawPages) return { ok: false, errors };
  const output = raw as unknown as IntegrationOutput;
  if (output.op !== "noop" && output.pages.length === 0) return { ok: false, errors: ["pages_empty"] };

  const pages: ParsedPage[] = [];
  for (const p of output.pages) {
    const shaped = parsePage(`# ${p.title}\n\n${p.body.trim()}\n`);
    const frontmatter = { ...before.frontmatter, title: p.title, summary: p.summary };
    const page: ParsedPage = { ...before, frontmatter, title: p.title, preamble: [], sections: shaped.sections };
    const result = validatePage(page, { writer: "owl", require_integrated: true, resolveLink: options.resolveLink });
    for (const issue of result.errors) errors.push(`${p.path}:${issue.code}:${issue.message}`);
    for (const issue of result.warnings) if (issue.code === "unresolved_link") errors.push(`${p.path}:${issue.code}:${issue.message}`);
    pages.push(page);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, output, pages };
}

// --- Migration: classify old note lines into themes (design §3.9) ---

export interface MigrationClassifyRequest {
  readonly lines: readonly { id: string; text: string; source_path: string; project_ids: readonly string[] }[];
  readonly themes: readonly { title: string; scope: "project" | "common"; project_id: string | null }[];
  readonly model: MemoryLibrarianSetting;
}
export type MigrationClassifyResult = { ok: true; output: unknown } | { ok: false; error: string };
export interface LineAssignment {
  readonly id: string;
  readonly theme: string;
  readonly scope: "project" | "common";
  readonly kind: "pitfall" | "decision" | "fact";
  readonly cross_project: boolean;
}

export function checkClassifyOutput(
  raw: unknown,
  request: Pick<MigrationClassifyRequest, "lines" | "themes">,
): { ok: true; assignments: readonly LineAssignment[] } | { ok: false; errors: readonly string[] } {
  if (!isRecord(raw) || !Array.isArray(raw.assignments)) return { ok: false, errors: ["assignments_missing"] };
  const errors: string[] = [];
  const wanted = new Set(request.lines.map((l) => l.id));
  const seen = new Set<string>();
  const assignments: LineAssignment[] = [];
  raw.assignments.forEach((a, i) => {
    if (!isRecord(a) || !isStr(a.id) || !isStr(a.theme) || !isStr(a.scope) || !isStr(a.kind) || typeof a.cross_project !== "boolean") {
      errors.push(`assignment_${i}_invalid`);
      return;
    }
    if (!wanted.has(a.id)) errors.push(`unknown_id:${a.id}`);
    else if (seen.has(a.id)) errors.push(`duplicate_id:${a.id}`);
    seen.add(a.id);
    const theme = a.theme.trim();
    if (theme === "" || [...theme].length > 30) errors.push(`theme_invalid:${a.id}`);
    if (a.scope !== "project" && a.scope !== "common") errors.push(`scope_invalid:${a.id}`);
    if (a.kind !== "pitfall" && a.kind !== "decision" && a.kind !== "fact") errors.push(`kind_invalid:${a.id}`);
    assignments.push({ id: a.id, theme, scope: a.scope as LineAssignment["scope"], kind: a.kind as LineAssignment["kind"], cross_project: a.cross_project });
  });
  for (const id of wanted) if (!seen.has(id)) errors.push(`missing_id:${id}`);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, assignments };
}
