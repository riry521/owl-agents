import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createUlid } from "../../../db/dist/index.js";
import { redactResearchText } from "../research-filter.js";
import { conversationLogSections, parseConversationSummary, routeResultLine } from "./conversation-log.js";
import { renderPage, type ParsedPage } from "./page-format.js";
import { writePage, type PageRouter, type RouteResult } from "./page-router.js";

export interface ConversationLogWriterOptions {
  readonly knowledgeDir: () => string;
  readonly withWrite: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly router: Pick<PageRouter, "route">;
  /** The Project of the compacted conversation, if it has one. */
  readonly project?: (input: ConversationLogInput) => string | null;
  readonly now?: () => Date;
  readonly onChanged?: (paths: readonly string[]) => void;
}

export interface ConversationLogInput {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly cause: "owl" | "auto" | "manual";
  readonly summary: string | null;
  readonly transcriptPath: string | null;
  readonly provider: string;
  readonly model: string;
  readonly index: number;
}

export interface ConversationLogResult {
  /** Vault-relative path; null when there was no summary text to keep. */
  readonly path: string | null;
  readonly extraction: "program" | "pending";
  readonly routed: readonly RouteResult[];
}

/**
 * Keeps a compaction summary as a `type: conversation-log` page and, when the summary has the 4-field shape,
 * sends its decisions and learnings to the theme pages. No AI is called: the fields are cut out by fixed rules,
 * and any other summary is stored as-is for the nightly librarian (`extraction: pending`).
 */
export class ConversationLogWriter {
  private tail: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: ConversationLogWriterOptions) {}

  public write(input: ConversationLogInput): Promise<ConversationLogResult> {
    const run = this.tail.then(() => this.writeNow(input));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async writeNow(input: ConversationLogInput): Promise<ConversationLogResult> {
    const raw = redactResearchText(input.summary ?? "").text.trim();
    if (raw === "") return { path: null, extraction: "pending", routed: [] };
    const parsed = parseConversationSummary(raw);
    const today = (this.options.now?.() ?? new Date()).toISOString().slice(0, 10);
    const project = this.options.project?.(input) ?? null;
    const root = this.options.knowledgeDir();
    const dir = `conversations/${today.slice(0, 7)}`;
    const name = await this.options.withWrite(async () => {
      await mkdir(join(root, dir), { recursive: true });
      const used = new Set(await readdir(join(root, dir)));
      let n = 1;
      while (used.has(`${today}-${n}.md`)) n += 1;
      return `${today}-${n}.md`;
    });
    const label = name.replace(/\.md$/u, "");
    const title = `会話 ${label}`;

    const routed: RouteResult[] = [];
    for (const item of parsed?.items ?? []) {
      routed.push(await this.options.router.route({
        kind: item.kind, text: item.text, theme: "", project_id: project,
        source: { work_number: null, work_id: null, actor: "advisor", label: `会話${label}` },
      }));
    }
    const reflected = parsed ? (routed.length > 0 ? routed.map(routeResultLine) : ["- 反映なし: 項目なし"]) : [];
    const frontmatter: Record<string, string | number> = {
      id: createUlid(), type: "conversation-log", title, conversation_id: input.conversationId, session_id: input.sessionId,
      compaction_index: input.index, provider: input.provider, model: input.model, cause: input.cause, summary_source: "provider",
      extraction: parsed ? "program" : "pending",
      ...(project ? { project_id: project } : {}),
      ...(input.transcriptPath ? { transcript_path: input.transcriptPath } : {}),
      created: today,
    };
    const page: ParsedPage = {
      kind: "conversation-log", frontmatter, frontmatter_order: Object.keys(frontmatter), comment: null, title, preamble: [],
      sections: conversationLogSections({ parsed, raw, reflected }),
    };
    const path = `${dir}/${name}`;
    await this.options.withWrite(() => writePage(join(root, path), renderPage(page)));
    this.options.onChanged?.([path]);
    return { path, extraction: parsed ? "program" : "pending", routed };
  }
}
