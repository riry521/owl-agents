import { createHash } from "node:crypto";

import type { OwnerLanguage, WebResearchCapture } from "@owl/shared";

import { filterResearchLinks, classifyResearchTarget, normalizeResearchQuery, normalizeResearchUrl, redactResearchText } from "./research-filter.js";
import { slugifyKnowledgeName } from "./knowledge-naming.js";
import type { KnowledgeBase } from "./knowledge-base.js";

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
  | "empty_content" | "secret_heavy" | "queue_full";

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
        () => { this.pending -= 1; return this.writeFailure(); },
      );
      this.tail = result.then(() => undefined, () => undefined);
      return result;
    } catch {
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
    const validatedLinks = safeLinks.slice(0, 10).flatMap((link) => {
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

  private async save(prepared: PreparedResearch): Promise<ResearchRecordResult> {
    try {
      const relPath = `research/${prepared.filename}`;
      const updateMetadata = this.metadata(prepared);
      const body = this.renderBody(prepared);
      try {
        await this.options.knowledge.get(relPath);
        await this.options.knowledge.update(relPath, { tags: this.tags(prepared), body, metadata: updateMetadata });
        return { status: "saved", path: relPath, created: false };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          await this.options.knowledge.create({
            folder: "research", filename: prepared.filename, tags: this.tags(prepared), body,
            metadata: this.metadata(prepared, prepared.researchedAt),
          });
          return { status: "saved", path: relPath, created: true };
        } catch (createError) {
          if (!(createError instanceof Error) || !createError.message.startsWith("already_exists")) throw createError;
          await this.options.knowledge.update(relPath, { tags: this.tags(prepared), body, metadata: updateMetadata });
          return { status: "saved", path: relPath, created: false };
        }
      }
    } catch {
      return this.writeFailure();
    }
  }

  private metadata(prepared: PreparedResearch, firstResearchedAt?: string): Record<string, string> {
    return {
      kind: "research",
      research_key: prepared.researchKey,
      url: prepared.url || '""',
      query: prepared.tool === "WebSearch" ? JSON.stringify(prepared.query) : '""',
      title: JSON.stringify(prepared.title),
      summary: JSON.stringify(prepared.summary),
      researched_at: prepared.researchedAt,
      ...(firstResearchedAt ? { first_researched_at: firstResearchedAt } : {}),
      agent_role: prepared.attribution.role,
      work_id: safeMetadataText(prepared.attribution.work_id),
      work_title: JSON.stringify(prepared.attribution.work_title
        ? redactResearchText(prepared.attribution.work_title.replace(/[\r\n]+/gu, " ")).text
        : ""),
      task_id: safeMetadataText(prepared.attribution.task_id),
      conversation_id: safeMetadataText(prepared.attribution.conversation_id),
      status: "active",
    };
  }

  private tags(prepared: PreparedResearch): string[] {
    return ["research", prepared.tool === "WebFetch" ? "web-fetch" : "web-search"];
  }

  private renderBody(prepared: PreparedResearch): string {
    const isEnglish = this.options.language() === "en";
    const labels = isEnglish
      ? { url: "URL", query: "Query", prompt: "Purpose", fetched: "Researched on", work: "Work", role: "Agent role", points: "Key points", excerpt: "Excerpt", results: "Search results", omitted: "… (truncated)" }
      : { url: "URL", query: "検索語", prompt: "目的", fetched: "調査日", work: "Work", role: "調査ロール", points: "要点", excerpt: "本文（抜粋）", results: "検索結果", omitted: "…（以下省略）" };
    const lines = [`# ${prepared.title}`, ""];
    if (prepared.tool === "WebFetch") {
      lines.push(`- ${labels.url}: ${prepared.url}`);
      if (prepared.prompt) lines.push(`- ${labels.prompt}: ${truncate(prepared.prompt, 300)}`);
    } else {
      lines.push(`- ${labels.query}: ${prepared.query}`);
    }
    const workId = prepared.attribution.work_id ? safeBodyText(prepared.attribution.work_id) : "";
    const workTitle = prepared.attribution.work_title ? safeBodyText(prepared.attribution.work_title) : "";
    const work = [workId, workTitle].filter(Boolean).join(" — ") || (isEnglish ? "Not associated" : "紐づくWorkなし");
    lines.push(`- ${labels.work}: ${work}`, `- ${labels.role}: ${prepared.attribution.role}`, `- ${labels.fetched}: ${prepared.researchedAt}`, "", `## ${labels.points}`);
    for (const point of prepared.points) lines.push(`- ${point}`);
    if (prepared.tool === "WebFetch" && prepared.content.trim()) {
      lines.push("", `## ${labels.excerpt}`, truncateWithSuffix(prepared.content.trim(), 8_000, labels.omitted));
    }
    if (prepared.tool === "WebSearch") {
      if (prepared.links.length > 0) {
        lines.push("", `## ${labels.results}`);
        for (const link of prepared.links) lines.push(`- [${link.title.replaceAll("]", "\\]")}](${link.url})`);
      }
      if (prepared.content.trim()) lines.push("", `## ${labels.excerpt}`, truncateWithSuffix(prepared.content.trim(), 8_000, labels.omitted));
    }
    return lines.join("\n");
  }

  private writeFailure(): ResearchRecordResult {
    try { console.warn("[research] failed to save research note: write_failed"); } catch { /* warnings must not reject recording */ }
    return { status: "failed", error: "write_failed" };
  }
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
  return value ? redactResearchText(value.replace(/[\r\n]+/gu, " ")).text : '""';
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
