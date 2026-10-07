import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { OwnerLanguage } from "@owl/shared";

import { KnowledgeBase } from "./knowledge-base.js";
import type { PageRouter } from "./memory/page-router.js";
import type { KnowledgeLocation } from "./knowledge-location.js";
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

/** "〜しない" (a verb ending in ない) / "〜に気をつける" read as a pitfall; any other explicit memory is a decision. */
const PITFALL_FORM = /(?:ない|に気をつける)(?:こと)?[。.!！]*$/u;

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
  public constructor(
    knowledge: KnowledgeBase,
    language: () => OwnerLanguage = () => "ja",
    private readonly gate?: Pick<KnowledgeLocation, "withWrite">,
    /** With `pages` set explicit memories go to theme pages through the router. */
    private readonly pages?: { readonly router: Pick<PageRouter, "route">;
      /** The Project of the Advisor conversation in progress, if it has one. */
      readonly conversationProject?: () => string | null;
    },
  ) {
    this.knowledge = knowledge;
    this.language = language;
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
   * per the persistent Advisor-session contract. This does not structure the text (facts/decisions):
   * the CLI's own natural-language summary is stored as-is, and structuring
   * is left to the Librarian so no extra LLM call is introduced here.
   *
   * When `payload.summary` is null or blank (the provider kept no summary
   * text), no file is written and `captured: false` is returned with a null
   * path; the advisor_compactions row records the gap.
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
  ): Promise<{ path: string | null; captured: boolean }> {
    const summary = payload.summary?.trim() ?? "";
    if (summary.length === 0) return { path: null, captured: false };
    const created = currentDate();
    const title = `Advisor compaction #${payload.index}`;
    const baseName = slugifyKnowledgeContentName(summary, "session");

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
      "  captured: true",
      "---",
    ];
    const frontmatter = frontmatterLines.join("\n");

    const body = `# ${title} — ${created}\n\n${summary}\n`;

    const content = `${frontmatter}\n\n${body}`;
    const path = await this.writeKnowledgeFile(SESSION_FOLDER, baseName, content, {
      key: "session_id",
      value: sessionId,
      match: { trigger: "compaction", compaction_index: String(payload.index) },
    });
    return { path, captured: true };
  }

  /** `projectId` (else the conversation's Project) is the scope; with neither the memory goes to common/. */
  public async saveExplicitMemory(text: string, tags: string[] = [], projectId: string | null = null): Promise<string> {
    if (this.pages) {
      const result = await this.pages.router.route({
        kind: PITFALL_FORM.test(text.trim()) ? "pitfall" : "decision", text, project_id: projectId ?? this.pages.conversationProject?.() ?? null,
        source: { work_number: null, work_id: null, actor: "advisor" },
      });
      if (result.status === "deferred") {
        throw Object.assign(new Error("The knowledge storage is unavailable."), { code: "storage_unavailable" });
      }
      if (result.status === "rejected") throw new Error(`explicit_memory_rejected: ${result.reason ?? ""}`);
      return result.page ?? "";
    }
    const created = currentDate();
    const excerpt = firstLine(text).slice(0, 20);
    const summary = text.trim().replace(/\s+/gu, " ").slice(0, 200) || "Explicit memory";
    const baseName = slugifyKnowledgeNameOrContent(excerpt, text, "memory");
    const aliases = excerpt ? [excerpt] : ["Explicit memory"];
    const frontmatter = buildFrontmatter({
      tags,
      created,
      aliases,
      source: "explicit_memory",
      sessionId: "",
      type: "lesson",
      status: "active",
      summary,
    });
    const content = `${frontmatter}\n${text}${text.endsWith("\n") ? "" : "\n"}`;

    return this.writeKnowledgeFile(NOTES_FOLDER, baseName, content);
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
    if (!this.gate) return this.writeKnowledgeFileUnlocked(folder, baseName, content, source);
    return this.gate.withWrite(() => this.writeKnowledgeFileUnlocked(folder, baseName, content, source));
  }

  private async writeKnowledgeFileUnlocked(
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
  type?: string;
  status?: string;
  summary?: string;
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
  if (options.type !== undefined) {
    lines.push(`type: ${formatYamlScalar(options.type)}`);
  }
  if (options.status !== undefined) {
    lines.push(`status: ${formatYamlScalar(options.status)}`);
  }
  if (options.summary !== undefined) {
    lines.push(`summary: ${formatYamlScalar(options.summary)}`);
  }

  lines.push("---");
  return lines.join("\n");
}

const MEMORY_TEXT: Record<OwnerLanguage, { decisions: string; facts: string; openThreads: string }> = {
  ja: { decisions: "決定事項", facts: "分かったこと", openThreads: "未解決" },
  en: { decisions: "Decisions", facts: "Findings", openThreads: "Open questions" },
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
