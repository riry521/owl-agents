import { createHash } from "node:crypto";

import { DEFAULT_RESEARCH_SOURCE_LINKS, DEFAULT_RESEARCH_SOURCE_LINKS_MAX, DEFAULT_RESEARCH_EXISTING_TAGS_MAX, DEFAULT_RESEARCH_TAGS_MAX, DEFAULT_RESEARCH_TAGS_MIN, generateUlid, type OwnerLanguage, type WebResearchCapture } from "@owl/shared";

import { filterResearchLinks, classifyResearchTarget, normalizeResearchQuery, normalizeResearchUrl, redactResearchText } from "./research-filter.js";
import { slugifyKnowledgeName } from "./knowledge-naming.js";
import type { KnowledgeBase } from "./knowledge-base.js";
import type { KnowledgeLocation } from "./knowledge-location.js";

export type ResearchAttributionRole = "advisor" | "manager" | "designer" | "worker" | "reviewer";

export interface ResearchAttribution {
  readonly role: ResearchAttributionRole;
  readonly work_id?: string | null;
  readonly work_title?: string | null;
  readonly task_id?: string | null;
  readonly agent_run_id?: string | null;
  readonly conversation_id?: string | null;
}

export type ResearchSkipReason =
  | "disabled" | "unsupported_tool" | "tool_error" | "http_error" | "redirect"
  | "invalid_url" | "credential_url" | "private_host" | "auth_page"
  | "empty_content" | "secret_heavy" | "queue_full" | "storage_unavailable";

export type ResearchRecordResult =
  | { readonly status: "saved"; readonly path: string; readonly created: boolean }
  | { readonly status: "skipped"; readonly reason: ResearchSkipReason }
  | { readonly status: "failed"; readonly error: string };

export interface ResearchRecorderOptions {
  readonly knowledge: KnowledgeBase;
  readonly isEnabled: () => boolean;
  readonly language: () => OwnerLanguage;
  readonly now?: () => Date;
  readonly maxQueue?: number;
  /** How many of the top search-result links a WebSearch clipping lists under 出典. */
  readonly sourceLinkLimit?: () => { readonly limit: number; readonly max: number };
  /** Asks the model for content tags; any failure just means no tags. */
  readonly tagger?: (request: { title: string; summary: string; points: readonly string[]; existing_tags: readonly string[]; min: number; max: number }) => Promise<unknown>;
  /** How many content tags a clipping gets; defaults to the shared range. */
  /** How many existing tags the tagger is shown (most used first, then by name); defaults to the shared limit. */
  readonly existingTagsLimit?: () => number | undefined;
  readonly tagRange?: () => { readonly min: number; readonly max: number };
  /** When set, nothing is recorded while the storage is unavailable and writes hold a write lease. */
  readonly gate?: Pick<KnowledgeLocation, "isAvailable" | "withWrite">;
  /** Called when a note could not be saved, so the owner can be told; its own failure is only logged. */
  readonly onFailure?: (error: unknown, attribution: ResearchAttribution) => void;
}

interface PreparedResearch {
  readonly filename: string;
  readonly researchKey: string;
  readonly url: string;
  readonly query: string;
  readonly title: string;
  readonly prompt: string;
  readonly content: string;
  readonly links: readonly { readonly title: string; readonly url: string }[];
  readonly points: readonly string[];
  readonly summary: string;
  readonly researchedAt: string;
  readonly attribution: ResearchAttribution;
  readonly tool: WebResearchCapture["tool"];
}

const MIN_CONTENT_CHARS = 40;
const MAX_KEY_POINTS = 5;
const CLIPPING_TITLE_CHARS = 80;
const CLIPPING_SUMMARY_CHARS = 120;

export class ResearchRecorder {
  private readonly maxQueue: number;
  private pending = 0;
  private tail: Promise<void> = Promise.resolve();

  public constructor(private readonly options: ResearchRecorderOptions) {
    const maxQueue = options.maxQueue ?? 50;
    this.maxQueue = Number.isFinite(maxQueue) ? Math.max(0, Math.floor(maxQueue)) : 50;
  }

  public record(capture: WebResearchCapture, attribution: ResearchAttribution): Promise<ResearchRecordResult> {
    try {
      if (!this.options.isEnabled()) return Promise.resolve({ status: "skipped", reason: "disabled" });
      if (this.options.gate && !this.options.gate.isAvailable()) return Promise.resolve({ status: "skipped", reason: "storage_unavailable" });
      if (this.pending >= this.maxQueue) return Promise.resolve({ status: "skipped", reason: "queue_full" });
      if (!capture || (capture.tool !== "WebFetch" && capture.tool !== "WebSearch")) {
        return Promise.resolve({ status: "skipped", reason: "unsupported_tool" });
      }
      if (capture.is_error) return Promise.resolve({ status: "skipped", reason: "tool_error" });
      if (typeof capture.http_status === "number" && (capture.http_status < 200 || capture.http_status >= 300)) {
        return Promise.resolve({ status: "skipped", reason: "http_error" });
      }
      if (typeof capture.content === "string" && capture.content.includes("REDIRECT DETECTED")) {
        return Promise.resolve({ status: "skipped", reason: "redirect" });
      }

      const target = classifyResearchTarget(capture);
      if (!target.ok) return Promise.resolve({ status: "skipped", reason: target.reason });

      const rawContent = typeof capture.content === "string" ? capture.content : "";
      const rawQuery = typeof capture.query === "string" ? capture.query.trim().replace(/\s+/gu, " ") : "";
      const rawPrompt = typeof capture.prompt === "string" ? capture.prompt : "";
      const rawTitle = typeof capture.title === "string" ? capture.title : "";
      const contentResult = redactResearchText(rawContent);
      const promptResult = redactResearchText(rawPrompt);
      const titleResult = redactResearchText(rawTitle);
      const queryResult = redactResearchText(rawQuery);
      const safeLinks = capture.tool === "WebSearch" ? filterResearchLinks(capture.links ?? []) : [];
      const contentChars = Array.from(rawContent).length;
      if (contentResult.redactions > 5 || (contentChars > 0 && contentResult.redacted_chars > contentChars * 0.2)) {
        return Promise.resolve({ status: "skipped", reason: "secret_heavy" });
      }

      const content = contentResult.text;
      if (capture.tool === "WebFetch" && countNonWhitespace(content) < MIN_CONTENT_CHARS) {
        return Promise.resolve({ status: "skipped", reason: "empty_content" });
      }
      const researchedAt = (this.options.now?.() ?? new Date()).toISOString();
      const prepared = capture.tool === "WebFetch"
        ? this.prepareWebFetch(target.research_key, target.normalized_url ?? "", {
          content, prompt: promptResult.text, title: titleResult.text, researchedAt, attribution,
        })
        : this.prepareWebSearch(target.research_key, safeLinks, content, {
          query: queryResult.text, title: titleResult.text, researchedAt, attribution,
        });
      if (prepared.points.length === 0) return Promise.resolve({ status: "skipped", reason: "empty_content" });

      this.pending += 1;
      const task = this.tail.then(() => this.save(prepared));
      const result = task.then(
        (value) => { this.pending -= 1; return value; },
        (error: unknown) => { this.pending -= 1; return this.writeFailure(error, attribution); },
      );
      this.tail = result.then(() => undefined, () => undefined);
      return result;
    } catch (error) {
      this.reportFailure("record_failed", error, attribution);
      return Promise.resolve({ status: "failed", error: "record_failed" });
    }
  }

  public idle(): Promise<void> {
    return this.tail;
  }

  private prepareWebFetch(
    researchKey: string,
    normalizedUrl: string,
    input: { content: string; prompt: string; title: string; researchedAt: string; attribution: ResearchAttribution },
  ): PreparedResearch {
    const safeUrl = redactResearchText(normalizedUrl).text;
    const fallback = (() => { const parsed = new URL(normalizedUrl); return `${parsed.hostname}${parsed.pathname}`; })();
    const title = truncate(normalizeWhitespace(input.title || redactResearchText(fallback).text), 200);
    const safeTitle = truncate(normalizeWhitespace(input.title), 200);
    const points = extractResearchKeyPoints(input.content);
    if (points.length === 0 && safeTitle) points.push(safeTitle);
    const summary = points[0] ?? truncate(normalizeWhitespace(input.content), 200);
    return {
      filename: researchFilename(normalizedUrl, researchKey),
      researchKey: redactResearchText(researchKey).text,
      url: safeUrl,
      query: "",
      title,
      prompt: normalizeWhitespace(input.prompt),
      content: input.content,
      links: [],
      points,
      summary: truncate(summary, 200),
      researchedAt: input.researchedAt,
      attribution: input.attribution,
      tool: "WebFetch",
    };
  }

  private prepareWebSearch(
    researchKey: string,
    safeLinks: readonly { readonly title: string; readonly url: string }[],
    rawContent: string,
    input: { query: string; title: string; researchedAt: string; attribution: ResearchAttribution },
  ): PreparedResearch {
    const validatedLinks = safeLinks.slice(0, this.sourceLinks().max).flatMap((link) => {
      const verdict = classifyResearchTarget({
        tool: "WebFetch", url: link.url, query: null, prompt: null, title: link.title,
        content: "", links: [], http_status: null, is_error: false,
      });
      if (!verdict.ok || !verdict.normalized_url) return [];
      const normalizedUrl = normalizeResearchUrl(verdict.normalized_url);
      if (!normalizedUrl) return [];
      return [{
        title: truncate(normalizeWhitespace(redactResearchText(link.title).text), 200),
        url: redactResearchText(normalizedUrl).text,
      }];
    });
    const excerpts = safeSearchExcerpts(rawContent, input.query, validatedLinks);
    const links = validatedLinks.filter((link) => !excerpts.excludedLinkUrls.has(link.url));
    const content = excerpts.content;
    const points = extractResearchKeyPoints(content);
    const hasSafeEvidence = content.length > 0 || links.length > 0;
    const safeTitle = truncate(normalizeWhitespace(
      excerpts.authPageDetected && !hasSafeEvidence ? "" : input.title || (hasSafeEvidence ? input.query || links[0]?.title || "" : ""),
    ), 200);
    if (points.length === 0 && safeTitle) points.push(safeTitle);
    const title = truncate(normalizeWhitespace(input.title || input.query || links[0]?.title || "Search results"), 200);

    return {
      filename: researchFilename(null, researchKey),
      researchKey: redactResearchText(researchKey).text,
      url: "",
      query: input.query,
      title,
      prompt: "",
      content,
      links,
      points,
      summary: truncate(points[0] ?? "", 200),
      researchedAt: input.researchedAt,
      attribution: input.attribution,
      tool: "WebSearch",
    };
  }

  private save(prepared: PreparedResearch): Promise<ResearchRecordResult> {
    const gate = this.options.gate;
    if (!gate) return this.saveUnlocked(prepared);
    return gate.withWrite(() => this.saveUnlocked(prepared)).catch((error: unknown): ResearchRecordResult => {
      this.reportFailure("record_failed", error, prepared.attribution);
      return { status: "failed", error: "record_failed" };
    });
  }

  private async saveUnlocked(prepared: PreparedResearch): Promise<ResearchRecordResult> {
    try {
      const relPath = `research/${prepared.filename}`;
      const body = this.renderBody(prepared);
      const tags = await this.contentTags(prepared);
      try {
        await this.options.knowledge.get(relPath);
        await this.update(relPath, prepared, body, tags);
        return { status: "saved", path: relPath, created: false };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          await this.options.knowledge.create({
            folder: "research", filename: prepared.filename, tags, body,
            metadata: this.metadata(prepared, prepared.researchedAt),
          });
          return { status: "saved", path: relPath, created: true };
        } catch (createError) {
          if (!(createError instanceof Error) || !createError.message.startsWith("already_exists")) throw createError;
          await this.update(relPath, prepared, body, tags);
          return { status: "saved", path: relPath, created: false };
        }
      }
    } catch (error) {
      return this.writeFailure(error, prepared.attribution);
    }
  }

  /** Keeps a valid existing `id`; a note written before the clipping format gets one now. */
  private async update(relPath: string, prepared: PreparedResearch, body: string, tags: string[]): Promise<void> {
    const hasId = await this.options.knowledge.frontmatterId(relPath);
    const metadata = { ...this.metadata(prepared), ...(hasId ? {} : { id: generateUlid() }) };
    await this.options.knowledge.update(relPath, { tags, body, metadata });
  }

  private metadata(prepared: PreparedResearch, firstResearchedAt?: string): Record<string, string> {
    return {
      // The page-format `clipping` keys; `id` is set once, on create.
      type: "clipping",
      ...(firstResearchedAt ? { id: generateUlid() } : {}),
      ...(prepared.tool === "WebFetch" ? { source_url: prepared.url } : { source_ref: `web-search: ${prepared.query}` }),
      retrieved_at: prepared.researchedAt,
      retrieved_by: "research-recorder",
      kind: "research",
      research_key: prepared.researchKey,
      url: prepared.url,
      query: prepared.tool === "WebSearch" ? prepared.query : "",
      title: truncate(prepared.title, CLIPPING_TITLE_CHARS),
      summary: truncate(prepared.summary, CLIPPING_SUMMARY_CHARS),
      researched_at: prepared.researchedAt,
      ...(firstResearchedAt ? { first_researched_at: firstResearchedAt } : {}),
      agent_role: prepared.attribution.role,
      work_id: safeMetadataText(prepared.attribution.work_id),
      work_title: prepared.attribution.work_title
        ? redactResearchText(prepared.attribution.work_title.replace(/[\r\n]+/gu, " ")).text
        : "",
      task_id: safeMetadataText(prepared.attribution.task_id),
      conversation_id: safeMetadataText(prepared.attribution.conversation_id),
      status: "active",
    };
  }

  /** Content tags from the model, normalized here; never throws, so a model failure cannot lose the clipping. */
  private async contentTags(prepared: PreparedResearch): Promise<string[]> {
    const tagger = this.options.tagger;
    if (!tagger) return [];
    try {
      const { min, max } = this.options.tagRange?.() ?? { min: DEFAULT_RESEARCH_TAGS_MIN, max: DEFAULT_RESEARCH_TAGS_MAX };
      const limit = this.options.existingTagsLimit?.() ?? DEFAULT_RESEARCH_EXISTING_TAGS_MAX;
      const counts = new Map<string, number>();
      for (const entry of await this.options.knowledge.list()) for (const tag of new Set(entry.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      const existing = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, Math.max(0, limit)).map(([tag]) => tag).sort();
      const result = await tagger({
        title: prepared.title, summary: prepared.summary, points: prepared.points, existing_tags: existing, min, max,
      }) as { ok?: boolean; output?: { tags?: unknown } } | null;
      return result?.ok === true ? normalizeClippingTags(result.output?.tags, max) : [];
    } catch (error) {
      console.warn("[owl-core] Research tagging failed; saving the note without tags.", error);
      return [];
    }
  }

  /** The clipping page body (design §2.4): 出典, 要点, 関係する Project with the top search-result links listed under 出典. */
  private sourceLinks(): { readonly limit: number; readonly max: number } {
    return this.options.sourceLinkLimit?.() ?? { limit: DEFAULT_RESEARCH_SOURCE_LINKS, max: DEFAULT_RESEARCH_SOURCE_LINKS_MAX };
  }

  private renderBody(prepared: PreparedResearch): string {
    const isEnglish = this.options.language() === "en";
    const labels = isEnglish
      ? { url: "URL", query: "Query", prompt: "Purpose", fetched: "Researched on", work: "Work", role: "Agent role", none: "Not associated" }
      : { url: "URL", query: "検索語", prompt: "目的", fetched: "調査日", work: "Work", role: "調査ロール", none: "（なし）" };
    const source = prepared.tool === "WebFetch"
      ? [`- ${labels.url}: ${prepared.url}`, ...(prepared.prompt ? [`- ${labels.prompt}: ${truncate(prepared.prompt, 300)}`] : [])]
      : [`- ${labels.query}: ${prepared.query}`];
    if (prepared.tool === "WebSearch") {
      const { limit, max } = this.sourceLinks();
      for (const link of prepared.links.slice(0, Math.min(limit, max))) source.push(`- [${link.title.replaceAll("]", "\\]")}](${link.url})`);
    }
    source.push(`- ${labels.fetched}: ${prepared.researchedAt}（${labels.role}: ${prepared.attribution.role}）`);
    const workId = prepared.attribution.work_id ? safeBodyText(prepared.attribution.work_id) : "";
    const workTitle = prepared.attribution.work_title ? safeBodyText(prepared.attribution.work_title) : "";
    const work = [workId, workTitle].filter(Boolean).join(" — ");
    const lines = [`# ${prepared.title}`, "", "## 出典", ...source, "", "## 要点", ...prepared.points.map((point) => `- ${point}`), "", "## 関係する Project", `- ${work ? `${labels.work}: ${work}` : labels.none}`];
    return lines.join("\n");
  }

  private writeFailure(error: unknown, attribution: ResearchAttribution): ResearchRecordResult {
    this.reportFailure("write_failed", error, attribution);
    return { status: "failed", error: "write_failed" };
  }

  private reportFailure(code: string, error: unknown, attribution: ResearchAttribution): void {
    // Reporting must never turn a failed save into a rejected promise: callers fire and forget.
    try { console.warn(`[research] failed to save research note: ${code}`, error); } catch { /* ignore */ }
    try { this.options.onFailure?.(error, attribution); } catch (hookError) {
      try { console.warn("[research] failure notice could not be recorded", hookError); } catch { /* ignore */ }
    }
  }
}

/** Lowercase alphanumerics and hyphens only; empty results and duplicates are dropped and at most `max` remain. */
const RETIRED_CLIPPING_TAGS = new Set(["research", "web-search", "web-fetch"]);

export function normalizeClippingTags(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const tag = item.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
    if (tag && !RETIRED_CLIPPING_TAGS.has(tag) && !tags.includes(tag)) tags.push(tag);
  }
  return tags.slice(0, Math.max(0, max));
}

export function extractResearchKeyPoints(content: string): string[] {
  const lines: string[] = [];
  let inCode = false;
  for (const line of content.split(/\r?\n/u)) {
    if (/^\s*```/u.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode || /^\s*#/u.test(line)) continue;
    lines.push(line);
  }

  const bullets: string[] = [];
  for (const line of lines) {
    const match = /^\s*(?:[-*+•]|\d+[.)])\s+(.+)$/u.exec(line);
    if (!match) continue;
    const point = normalizeWhitespace(match[1]);
    if (Array.from(point).length >= 15) bullets.push(truncate(point, 200));
    if (bullets.length >= MAX_KEY_POINTS) break;
  }
  if (bullets.length > 0) return bullets;

  return normalizeWhitespace(lines.join(" "))
    .split(/(?<=[。．！？!?])\s*|(?<=\.)\s+/u)
    .map(normalizeWhitespace)
    .filter((sentence) => Array.from(sentence).length >= 20)
    .slice(0, 3)
    .map((sentence) => truncate(sentence, 200));
}

function countNonWhitespace(value: string): number {
  return Array.from(value).filter((char) => !/\s/u.test(char)).length;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  const chars = Array.from(value);
  return chars.length <= maxLength ? value : `${chars.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
}

function truncateWithSuffix(value: string, maxLength: number, suffix: string): string {
  const chars = Array.from(value);
  if (chars.length <= maxLength) return value;
  const suffixChars = Array.from(suffix);
  return `${chars.slice(0, Math.max(0, maxLength - suffixChars.length)).join("")}${suffix}`;
}

function safeMetadataText(value: string | null | undefined): string {
  return value ? redactResearchText(value.replace(/[\r\n]+/gu, " ")).text : "";
}

function safeBodyText(value: string): string {
  return redactResearchText(value.replace(/[\r\n]+/gu, " ")).text;
}

function researchFilename(normalizedUrl: string | null, researchKey: string): string {
  const slug = normalizedUrl
    ? slugifyKnowledgeName(redactResearchText(`${new URL(normalizedUrl).hostname}${new URL(normalizedUrl).pathname}`).text, "page", 60)
    : `search-${slugifyKnowledgeName(normalizeResearchQuery(researchKey.slice("search:".length)), "query", 50)}`;
  const hash = createHash("sha256").update(researchKey).digest("hex").slice(0, 8);
  return `${slug}-${hash}.md`;
}

function safeSearchExcerpts(
  rawContent: string,
  query: string,
  links: readonly { readonly title: string; readonly url: string }[],
): { readonly content: string; readonly excludedLinkUrls: ReadonlySet<string>; readonly authPageDetected: boolean } {
  const safeParagraphs: string[] = [];
  const excludedLinkUrls = new Set<string>();
  let authPageDetected = false;
  for (const paragraph of rawContent.split(/\n\s*\n/u).map((value) => value.trim()).filter(Boolean)) {
    const urls = extractHttpUrls(paragraph);
    const titleLinks = links.filter((link) => link.title && paragraph.toLocaleLowerCase().includes(link.title.toLocaleLowerCase()));
    const candidates = urls.length > 0
      ? urls.map((url) => ({ url, linkedUrl: links.find((link) => normalizeResearchUrl(link.url) === normalizeResearchUrl(url))?.url }))
      : titleLinks.length > 0
        ? titleLinks.map((link) => ({ url: link.url, linkedUrl: link.url }))
        : [{ url: "https://search-result.invalid/", linkedUrl: undefined }];
    const queryVerdict = classifyResearchTarget({
      tool: "WebSearch", url: null, query, prompt: null, title: null, content: paragraph,
      links: [], http_status: null, is_error: false,
    });
    let safe = queryVerdict.ok;
    for (const candidate of candidates) {
      const verdict = classifyResearchTarget({
        tool: "WebFetch", url: candidate.url, query: null, prompt: null, title: "", content: paragraph,
        links: [], http_status: null, is_error: false,
      });
      if (!verdict.ok) {
        safe = false;
        if (verdict.reason === "auth_page") {
          authPageDetected = true;
          if (candidate.linkedUrl) excludedLinkUrls.add(candidate.linkedUrl);
        }
      }
    }
    if (safe) safeParagraphs.push(redactResearchText(paragraph).text);
  }
  return { content: safeParagraphs.filter(Boolean).join("\n\n"), excludedLinkUrls, authPageDetected };
}

function extractHttpUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"'`()\[\]{}]+/giu)]
    .map((match) => match[0].replace(/[.,!?;:]+$/u, ""))
    .filter(Boolean);
}
