import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { OwnerLanguage } from "@owl/shared";

import { KnowledgeBase } from "./knowledge-base.js";
import {
  resolveKnowledgeFilename,
  slugifyKnowledgeContentName,
  slugifyKnowledgeNameOrContent,
  slugifyKnowledgeName,
  slugifyKnowledgeNameOrNull,
} from "./knowledge-naming.js";

export { slugifyKnowledgeName } from "./knowledge-naming.js";

export interface SessionSummary {
  title: string;
  facts: string[];
  decisions: string[];
  open_threads: string[];
  related_work_ids: string[];
  tags: string[];
}

export const POLICY_KEYWORDS: readonly string[] = [
  "rule",
  "rules",
  "policy",
  "policies",
  "guideline",
  "guidelines",
  "prohibited",
  "forbidden",
  "must",
  "shall",
  "always",
  "never",
  "ルール",
  "方針",
  "ポリシー",
  "規則",
  "規定",
  "決まり",
  "禁止",
  "必須",
  "原則",
  "ガイドライン",
];

const SESSION_FOLDER = join("advisor", "sessions");
const NOTES_FOLDER = join("advisor", "notes");

/**
 * Create a filesystem-safe, Unicode-preserving slug for a knowledge filename.
 * Japanese letters and numbers are retained through Unicode property escapes.
 */
export function slugify(value: string): string {
  return slugifyKnowledgeName(value, "untitled", Number.MAX_SAFE_INTEGER);
}

export class MemorySaver {
  private readonly knowledge: KnowledgeBase;
  private readonly language: () => OwnerLanguage;

  /** `language` picks the headings of the notes it writes (the Owner reads them). */
  public constructor(knowledge: KnowledgeBase, language: () => OwnerLanguage = () => "ja") {
    this.knowledge = knowledge;
    this.language = language;
  }

  public async saveSessionSummary(sessionId: string, summary: SessionSummary): Promise<string> {
    return this.saveSessionFile(summary, sessionId, "session_end", {
      key: "session_id",
      value: sessionId,
      match: { trigger: "session_end" },
    });
  }

  public async saveManualSnapshot(summary: SessionSummary): Promise<string> {
    const sourceId = randomUUID();
    return this.saveSessionFile(summary, undefined, "manual_save", {
      key: "source_id",
      value: sourceId,
      match: { trigger: "manual_save" },
    }, sourceId);
  }

  /**
   * Persists a compaction summary observed from the provider CLI (Claude
   * `compact_boundary` / Codex `thread/compacted`) to `advisor/sessions/`,
   * per the persistent Advisor-session contract. Unlike
   * saveSessionSummary this does not structure the text (facts/decisions):
   * the CLI's own natural-language summary is stored as-is, and structuring
   * is left to the Librarian so no extra LLM call is introduced here.
   *
   * When `payload.summary` is null (the summary body could not be captured,
   * e.g. neither the PreCompact hook nor transcript parsing worked), the
   * file still gets written with `captured: false` and the transcript path
   * so the gap is visible rather than silently dropped
   * (Silent Fallback Prohibition).
   */
  public async saveCompactionSummary(
    sessionId: string,
    payload: {
      conversationId: string;
      cause: "auto" | "manual";
      preTokens: number | null;
      summary: string | null;
      provider: string;
      model: string;
      index: number;
      transcriptPath: string | null;
    },
  ): Promise<{ path: string; captured: boolean }> {
    const created = currentDate();
    const captured = payload.summary !== null && payload.summary.trim().length > 0;
    const title = `Advisor compaction #${payload.index}`;
    const baseName = slugifyKnowledgeContentName(payload.summary?.trim() ?? "", "session");

    const frontmatterLines = [
      "---",
      `tags: ${formatYamlList(["advisor-session", "compaction"])}`,
      `created: ${created}`,
      `aliases: ${formatYamlList([title])}`,
      `session_id: ${formatYamlScalar(sessionId)}`,
      `compaction_index: ${payload.index}`,
      `conversation_id: ${formatYamlScalar(payload.conversationId)}`,
      "trigger: compaction",
      "compaction:",
      `  index: ${payload.index}`,
      `  provider: ${formatYamlScalar(payload.provider)}`,
      `  model: ${formatYamlScalar(payload.model)}`,
      `  cause: ${payload.cause}`,
      `  pre_tokens: ${payload.preTokens ?? "null"}`,
      `  captured: ${captured}`,
      "---",
    ];
    const frontmatter = frontmatterLines.join("\n");

    const body = captured
      ? `# ${title} — ${created}\n\n${(payload.summary as string).trim()}\n`
      : `# ${title} — ${created}\n\n${MEMORY_TEXT[this.language()].noSummary}\n\ntranscript_path: ${
          payload.transcriptPath ?? "(unknown)"
        }\n`;

    const content = `${frontmatter}\n\n${body}`;
    const path = await this.writeKnowledgeFile(SESSION_FOLDER, baseName, content, {
      key: "session_id",
      value: sessionId,
      match: { trigger: "compaction", compaction_index: String(payload.index) },
    });
    return { path, captured };
  }

  public async saveExplicitMemory(text: string, tags: string[] = []): Promise<string> {
    const created = currentDate();
    const excerpt = firstLine(text).slice(0, 20);
    const baseName = slugifyKnowledgeNameOrContent(excerpt, text, "memory");
    const aliases = excerpt ? [excerpt] : ["Explicit memory"];
    const frontmatter = buildFrontmatter({
      tags,
      created,
      aliases,
      source: "explicit_memory",
      sessionId: "",
    });
    const content = `${frontmatter}\n${text}${text.endsWith("\n") ? "" : "\n"}`;

    return this.writeKnowledgeFile(NOTES_FOLDER, baseName, content);
  }

  public buildExtractionPrompt(): string {
    const shape = JSON.stringify({
      session_summary: {
        title: "<short descriptive title>",
        facts: ["<important fact>"],
        decisions: ["<decision made>"],
        open_threads: ["<unresolved topic or next step>"],
        related_work_ids: ["<related work id, if known>"],
        tags: ["<useful tag>"],
      },
    }, null, 2);

    return [
      "Extract a concise session summary from the conversation.",
      "Return exactly one JSON object with a session_summary property; do not use markdown fences or add any other text.",
      "The session_summary must contain exactly these fields: title (string), facts (string[]), decisions (string[]), open_threads (string[]), related_work_ids (string[]), and tags (string[]).",
      "Use an empty array when a category has no entries. Preserve policy, rule, prohibition, and decision-related details in decisions.",
      "Expected shape:",
      shape,
    ].join("\n\n");
  }

  public parseExtractionResponse(stdout: string): SessionSummary | null {
    const payload = parseJsonObject(stdout);
    if (payload === null) return null;

    const candidate = isRecord(payload.session_summary) ? payload.session_summary : payload;
    return parseSessionSummary(candidate);
  }

  public hasPolicyContent(summary: SessionSummary): boolean {
    const text = [
      summary.title,
      ...summary.facts,
      ...summary.decisions,
      ...summary.open_threads,
      ...summary.related_work_ids,
      ...summary.tags,
    ].join("\n").toLocaleLowerCase();

    return POLICY_KEYWORDS.some((keyword) => text.includes(keyword.toLocaleLowerCase()));
  }

  private async saveSessionFile(
    summary: SessionSummary,
    sessionId: string | undefined,
    trigger: string,
    source: { key: string; value: string; match?: Record<string, string> },
    sourceId?: string,
  ): Promise<string> {
    const created = currentDate();
    const title = summary.title.trim();
    const titleSlug = slugifyKnowledgeNameOrNull(title);
    let fallbackTitle: string | undefined;
    for (const item of [...summary.facts, ...summary.decisions, ...summary.open_threads]) {
      const candidate = item.trim();
      const candidateSlug = slugifyKnowledgeNameOrNull(candidate);
      if (candidateSlug) {
        fallbackTitle = candidate;
        break;
      }
    }
    const fallbackText = [summary.title, ...summary.facts, ...summary.decisions, ...summary.open_threads].join("\n");
    const baseName = slugifyKnowledgeNameOrContent(title, fallbackText, "session");
    const displayTitle = titleSlug ? title : fallbackTitle ?? baseName;
    const frontmatter = buildFrontmatter({
      tags: summary.tags,
      created,
      aliases: [displayTitle],
      sessionId,
      trigger,
      sourceId,
      relatedWorkIds: summary.related_work_ids,
    });
    const content = `${frontmatter}\n${buildSummaryBody(summary, displayTitle, this.language())}`;

    return this.writeKnowledgeFile(SESSION_FOLDER, baseName, content, source);
  }

  /**
   * Write a knowledge file using the collision-safe, atomic-name pattern used
   * by the memory-saving flows. Advisor conversation ingestion reuses this
   * path for its own folder and frontmatter format.
   */
  public async writeKnowledgeFile(
    folder: string,
    baseName: string,
    content: string,
    source?: { key: string; value: string; kind?: string; match?: Record<string, string> },
  ): Promise<string> {
    const directory = join(this.knowledge.knowledgeDir, folder);
    await mkdir(directory, { recursive: true });

    const slug = slugifyKnowledgeName(baseName);
    for (;;) {
      const { filename, existing } = await resolveKnowledgeFilename(directory, slug, source);
      const absolutePath = join(directory, filename);
      if (!existing) {
        try {
          await writeFile(absolutePath, content, { encoding: "utf8", flag: "wx" });
          return join(folder, filename);
        } catch (error: unknown) {
          if (isNodeError(error) && error.code === "EEXIST") continue;
          throw error;
        }
      }

      const tmpPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await writeFile(tmpPath, content, { encoding: "utf8", flag: "wx" });
      await rename(tmpPath, absolutePath);
      return join(folder, filename);
    }
  }
}

interface FrontmatterOptions {
  tags: readonly string[];
  created: string;
  aliases: readonly string[];
  sessionId?: string;
  trigger?: string;
  sourceId?: string;
  relatedWorkIds?: readonly string[];
  source?: string;
}

function buildFrontmatter(options: FrontmatterOptions): string {
  const lines = [
    "---",
    `tags: ${formatYamlList(options.tags)}`,
    `created: ${options.created}`,
    `aliases: ${formatYamlList(options.aliases)}`,
  ];

  if (options.sessionId !== undefined) {
    lines.push(`session_id: ${formatYamlScalar(options.sessionId)}`);
  }
  if (options.trigger !== undefined) {
    lines.push(`trigger: ${formatYamlScalar(options.trigger)}`);
  }
  if (options.sourceId !== undefined) {
    lines.push(`source_id: ${formatYamlScalar(options.sourceId)}`);
  }
  if (options.relatedWorkIds !== undefined) {
    lines.push(`related_work_ids: ${formatYamlList(options.relatedWorkIds)}`);
  }
  if (options.source !== undefined) {
    lines.push(`source: ${formatYamlScalar(options.source)}`);
  }

  lines.push("---");
  return lines.join("\n");
}

const MEMORY_TEXT: Record<OwnerLanguage, { decisions: string; facts: string; openThreads: string; noSummary: string }> = {
  ja: { decisions: "決定事項", facts: "分かったこと", openThreads: "未解決", noSummary: "要約を取得できませんでした。" },
  en: { decisions: "Decisions", facts: "Findings", openThreads: "Open questions", noSummary: "The summary could not be captured." },
};

function buildSummaryBody(summary: SessionSummary, title: string, language: OwnerLanguage): string {
  const t = MEMORY_TEXT[language];
  const sections = [`# ${title}`];
  appendSection(sections, t.decisions, summary.decisions);
  appendSection(sections, t.facts, summary.facts);
  appendSection(sections, t.openThreads, summary.open_threads);
  return `${sections.join("\n\n")}\n`;
}

function appendSection(sections: string[], heading: string, items: readonly string[]): void {
  if (items.length === 0) return;
  sections.push(`## ${heading}`, items.map((item) => `- ${item}`).join("\n"));
}

function formatYamlList(values: readonly string[]): string {
  return `[${values.map((value) => formatYamlScalar(value)).join(", ")}]`;
}

function formatYamlScalar(value: string): string {
  const normalized = value.replace(/[\r\n]+/gu, " ");
  if (/^[\p{L}\p{N}_./:@+-]+$/u.test(normalized)) return normalized;
  return JSON.stringify(normalized);
}

function currentDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/u, 1)[0].trim();
}

function parseJsonObject(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;

  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/iu);
  const candidate = fenced?.[1].trim() ?? extractJsonObject(trimmed);
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) return null;

  try {
    const parsed: unknown = JSON.parse(candidate);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractJsonObject(value: string): string {
  if (value.startsWith("{") && value.endsWith("}")) return value;
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) return value;
  return value.slice(firstBrace, lastBrace + 1);
}

function parseSessionSummary(value: Record<string, unknown>): SessionSummary | null {
  if (typeof value.title !== "string") return null;
  const facts = stringArray(value.facts);
  const decisions = stringArray(value.decisions);
  const openThreads = stringArray(value.open_threads);
  const relatedWorkIds = stringArray(value.related_work_ids);
  const tags = stringArray(value.tags);
  if (facts === null || decisions === null || openThreads === null || relatedWorkIds === null || tags === null) {
    return null;
  }

  return {
    title: value.title,
    facts,
    decisions,
    open_threads: openThreads,
    related_work_ids: relatedWorkIds,
    tags,
  };
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return value.slice() as string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
