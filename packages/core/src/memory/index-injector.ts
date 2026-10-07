import { kb, type MemoryInjectionInput } from "./memory-injector.js";
import type { MemoryIndex } from "./memory-index.js";
import { estimatePageTokens } from "./page-format.js";
import type { MemoryLogger } from "./memory-types.js";
import { renderRecall, type ResearchRecall } from "./research-recall.js";

/** Design §7.1. */
export const INDEX_TOKEN_LIMIT = 1200;
export const ADVISOR_START_TOKEN_LIMIT = 1600;
export const ADVISOR_PROJECT_LIST_TOKEN_LIMIT = 400;
export const ADVISOR_DIFF_TOKEN_LIMIT = 300;
const INDEX_BYTE_BUDGET = 4000;
const ADVISOR_START_BYTE_BUDGET = 5400;

/** Pseudo path under which a session remembers the Project index titles it was shown. */
const PROJECT_LIST = "(project-list)";
const OMITTED = "(上限超過のため省略 — MCP の index で取得)";
const GUIDE = "テーマページは owl-memory の page で開く（[[ページ名]] を渡す）。\n外部の資料は search で探す。Work の記録は普段は読まない。";
const ADVISOR_GUIDE = "Project の目次は owl-memory の index（project に名前を渡す）で開く。テーマページは page で開く（[[ページ名]] を渡す）。\n外部の資料は search で探す。Work の記録は普段は読まない。";
/** Sections dropped when the block is over its limit, first to last. 必読 is never dropped. */
const COLLAPSE_ORDER = ["Project 目次の一覧", "共通テーマ", "概要", "テーマ"];

export interface IndexInjectorOptions {
  readonly index: Pick<MemoryIndex, "db" | "getProjectIndex" | "listPages" | "status">;
  readonly isAvailable: () => boolean;
  readonly now?: () => Date;
  readonly logger?: MemoryLogger;
  /** Called at the start of every Advisor turn: the session's read budget is counted afresh. */
  readonly resetReads?: (sessionId: string) => void;
  /** Adds one line per strongly related research clipping after the index (design §8). */
  readonly recall?: ResearchRecall;
}

interface Section { readonly title: string; readonly lines: string[]; collapsed: boolean }
interface PageText { readonly path: string; readonly title: string; readonly page_type: string; readonly hash: string; readonly body: string; readonly updated: string }
/** What an Advisor session was last shown of one page: its version and the lines that matter for a diff. */
/** `deleted` is a tombstone: the path stays tracked so a re-creation shows up in the next diff. */
interface Shown { hash: string; title: string; type: string; lines: string[]; deleted?: boolean }

const COMMON_INDEX = "\0common-index";

const tokens = estimatePageTokens;
const attr = (value: string): string => value.replace(/"/gu, "'");

/** Drops the generated-by comment and the H1 (the title is an attribute of the block), then splits at `## `. */
function sectionsOf(body: string): Section[] {
  const sections: Section[] = [{ title: "", lines: [], collapsed: false }];
  for (const line of body.replace(/\r\n?/gu, "\n").split("\n")) {
    if (/^\s*<!--.*-->\s*$/u.test(line) || /^# /u.test(line)) continue;
    const heading = /^## (.+?)\s*$/u.exec(line);
    if (heading) sections.push({ title: heading[1], lines: [], collapsed: false });
    else sections[sections.length - 1].lines.push(line);
  }
  return sections.map((s) => ({ ...s, lines: trimBlank(s.lines) })).filter((s) => s.title !== "" || s.lines.length > 0);
}

function trimBlank(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

const nameOf = (title: string): string => title.replace(/ の目次$/u, "");
const bodyLines = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter(Boolean);

/** Builds the page-index block every role input starts with when `memory_mode` is `pages` (design §5). */
export class IndexInjector {
  private readonly sessions = new Map<string, Map<string, Shown>>();
  /** Clipping ids already recalled to an Advisor session, so the same line is not repeated every turn. */
  private readonly recalled = new Map<string, Set<string>>();

  public constructor(private readonly options: IndexInjectorOptions) {}

  /** Forget what an Advisor session has seen: its next call injects the first-turn block again (compaction, resume). */
  public resetSession(sessionId: string): void { this.sessions.delete(sessionId); this.recalled.delete(sessionId); }

  /** Called when an Advisor session opens an index or page through MCP: that version is now what the session knows. */
  public noteShown(sessionId: string, path: string): void {
    const shown = this.sessions.get(sessionId);
    const page = this.page(path);
    if (shown && page) shown.set(path, this.shownOf(page));
  }

  /** Never throws: a failure is logged and gives null so the agent run goes on. */
  public async compose(input: MemoryInjectionInput): Promise<string | null> {
    try {
      if (input.role === "curator") return null;
      if (input.role === "advisor" && input.session_id) this.options.resetReads?.(input.session_id);
      const index = input.role === "advisor" ? this.advisor(input.session_id) : this.forProject(input.role, input.project_id);
      const recall = await this.recall(input);
      return index && recall ? `${index}\n\n${recall}` : index ?? recall;
    } catch (error) {
      this.options.logger?.warn("memory index injection failed", error);
      return null;
    }
  }

  private async recall(input: MemoryInjectionInput): Promise<string | null> {
    if (!this.options.recall || !input.recall_query || !["advisor", "manager", "designer"].includes(input.role)) return null;
    const seen = input.role === "advisor" && input.session_id ? (this.recalled.get(input.session_id) ?? this.recalled.set(input.session_id, new Set()).get(input.session_id)!) : null;
    const items = await this.options.recall.recall(input.recall_query, seen ? [...seen] : []);
    for (const item of items) seen?.add(item.id);
    return renderRecall(items);
  }

  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }

  private page(path: string): PageText | null {
    const row = this.options.index.db().prepare(
      "SELECT path, title, page_type, body, body_sha256, integrated_hash, source_hash, updated FROM notes WHERE path = ?",
    ).get(path) as { path: string; title: string; page_type: string; body: string; body_sha256: string; integrated_hash: string | null; source_hash: string | null; updated: string | null } | undefined;
    if (!row) return null;
    const hash = `${(row.page_type === "project-index" ? row.source_hash : row.integrated_hash) ?? ""}:${row.body_sha256}`;
    return { path: row.path, title: row.title, page_type: row.page_type, hash, body: row.body, updated: row.updated ?? "" };
  }

  private indexPage(projectId: string | null): PageText | null {
    const row = this.options.index.getProjectIndex(projectId);
    return row ? this.page(row.path) : null;
  }

  /** Header lines that depend on the storage state; null when there is nothing to read at all (design §14). */
  private storageNotice(now: string): { notice: string | null; empty: string | null } {
    const available = this.options.isAvailable();
    const count = (this.options.index.db().prepare("SELECT count(*) AS n FROM notes").get() as { n: number }).n;
    return {
      notice: available ? null : `保管庫未接続：${now} 時点の目次`,
      empty: !available && count === 0 ? "記憶は利用できません（保管庫未接続）" : null,
    };
  }

  private forProject(role: Exclude<MemoryInjectionInput["role"], "advisor" | "curator">, projectId: string | null): string | null {
    const own = projectId ? this.indexPage(projectId) : null;
    const page = own ?? this.indexPage(null);
    // The time comes from the stored index page, not the clock, so the same input gives the same prompt.
    const { notice, empty } = this.storageNotice(page?.updated ?? "");
    if (empty) return empty;
    if (!page) return null;
    const sections = sectionsOf(page.body);
    // Reviewer judges changes, not the project: the summary is left out (design §5.2).
    const kept = role === "reviewer" ? sections.filter((s) => s.title !== "概要") : sections;
    const scope = own ? "project" : "common";
    const head = `<owl-memory scope="${scope}"${own ? ` project="${attr(nameOf(page.title))}"` : ""}>`;
    return this.fit({ head, minHead: `<owl-memory scope="${scope}">`, notice, sections: kept, guide: GUIDE, limit: INDEX_TOKEN_LIMIT, budget: INDEX_BYTE_BUDGET });
  }

  /** Collapses sections in COLLAPSE_ORDER until the block fits `limit`; the size line comes after the closing tag. */
  private fit(block: { head: string; minHead: string; notice: string | null; sections: Section[]; guide: string; limit: number; budget: number }): string {
    const collapsed: string[] = [];
    const render = (): string => {
      const body = [
        ...(block.notice ? [block.notice] : []),
        block.head,
        ...block.sections.map((s) => `${s.title ? `## ${s.title}\n` : ""}${(s.collapsed ? [OMITTED] : s.lines).join("\n")}`.trimEnd()),
        `---\n${block.guide}`,
      ].join("\n\n");
      const sized = (n: number): string => `_memory injected: ${kb(n)} / ${kb(block.budget)} budget · collapsed: ${collapsed.join(", ") || "none"}_`;
      const text = `${body}\n</owl-memory>`;
      return `${text}\n${sized(Buffer.byteLength(`${text}\n${sized(0)}`, "utf8"))}`;
    };
    let text = render();
    for (const title of COLLAPSE_ORDER) {
      if (tokens(text) <= block.limit) break;
      const section = block.sections.find((s) => s.title === title && !s.collapsed && s.lines.length > 0);
      if (!section) continue;
      section.collapsed = true;
      collapsed.push(title);
      text = render();
    }
    // Still over (a large 必読 or unknown section): collapse what is left, largest first, so the limit always holds.
    const rest = block.sections.filter((s) => !s.collapsed && s.lines.length > 0).sort((a, b) => b.lines.join("\n").length - a.lines.join("\n").length);
    for (const section of rest) {
      if (tokens(text) <= block.limit) break;
      section.collapsed = true;
      collapsed.push(section.title || "(冒頭)");
      text = render();
    }
    if (tokens(text) <= block.limit) return text;
    // Long titles or very many headings can still overflow: fall back to a minimal block with no page text at all.
    const minimal = [...(block.notice ? [block.notice] : []), block.minHead, OMITTED, `---\n${block.guide}`].join("\n\n");
    const size = (n: number): string => `_memory injected: ${kb(n)} / ${kb(block.budget)} budget · collapsed: all_`;
    const base = `${minimal}\n</owl-memory>`;
    return `${base}\n${size(Buffer.byteLength(`${base}\n${size(0)}`, "utf8"))}`;
  }

  private shownOf(page: PageText): Shown {
    const isIndex = page.page_type === "project-index";
    const history = sectionsOf(page.body).find((s) => s.title === "更新履歴");
    return { hash: page.hash, title: page.title, type: page.page_type, lines: isIndex ? bodyLines(page.body) : bodyLines((history?.lines ?? []).join("\n")) };
  }

  private advisor(sessionId: string | undefined): string | null {
    const shown = sessionId ? this.sessions.get(sessionId) : undefined;
    return shown ? this.advisorDiff(shown) : this.advisorStart(sessionId);
  }

  private startShown(common: PageText | null, projects: readonly { title: string }[]): Map<string, Shown> {
    const shown = new Map<string, Shown>([[COMMON_INDEX, common ? this.shownOf(common) : { hash: "", title: "共通の目次", type: "project-index", lines: [], deleted: true }]]);
    shown.set(PROJECT_LIST, { hash: "", title: "Project 目次の一覧", type: PROJECT_LIST, lines: projects.map((p) => `- ${p.title}`) });
    return shown;
  }

  private advisorStart(sessionId: string | undefined): string | null {
    const now = this.now();
    const { notice, empty } = this.storageNotice(now);
    if (empty) return empty;
    const common = this.indexPage(null);
    const projects = this.options.index.listPages({ types: ["project-index"], scope: "project" });
    if (!common && projects.length === 0) {
      // Nothing to show yet, but track the session so a later index shows up as a diff.
      if (sessionId) this.sessions.set(sessionId, this.startShown(common, projects));
      return null;
    }
    const sections = common ? sectionsOf(common.body) : [];
    if (projects.length > 0) {
      const lines: string[] = [];
      for (const [i, row] of projects.entries()) {
        const next = [...lines, `- ${row.title}`];
        if (tokens(next.join("\n")) > ADVISOR_PROJECT_LIST_TOKEN_LIMIT) { lines.push(`- ほか ${projects.length - i} 件（index で全件）`); break; }
        lines.push(`- ${row.title}`);
      }
      sections.push({ title: "Project 目次の一覧", lines, collapsed: false });
    }
    if (sessionId) this.sessions.set(sessionId, this.startShown(common, projects));
    const head = `<owl-memory scope="advisor" generated="${now}">`;
    return this.fit({ head, minHead: head, notice, sections, guide: ADVISOR_GUIDE, limit: ADVISOR_START_TOKEN_LIMIT, budget: ADVISOR_START_BYTE_BUDGET });
  }

  /** §5.4: only what changed since the session last saw it; nothing at all when nothing changed. */
  private advisorDiff(shown: Map<string, Shown>): string | null {
    const changes: string[] = [];
    let updated = 0;
    for (const [path, old] of [...shown]) {
      if (path === PROJECT_LIST) {
        const lines = this.options.index.listPages({ types: ["project-index"], scope: "project" }).map((p) => `- ${p.title}`);
        const added = lines.filter((l) => !old.lines.includes(l));
        const removed = old.lines.filter((l) => !lines.includes(l));
        if (added.length + removed.length === 0) continue;
        shown.set(path, { ...old, lines });
        updated++;
        changes.push(`## ${old.title}`, ...added.map((l) => `+ ${l}`), ...removed.map((l) => `- ${l}`));
        continue;
      }
      const page = path === COMMON_INDEX ? this.indexPage(null) : this.page(path);
      if (!page) {
        if (old.deleted) continue;
        shown.set(path, { ...old, hash: "", lines: [], deleted: true });
        updated++;
        changes.push(`## ${old.type === "project-index" ? old.title : `[[${old.title}]]`}`, "（削除された）");
        continue;
      }
      if (page.hash === old.hash && !old.deleted) continue;
      const current = this.shownOf(page);
      shown.set(path, current);
      updated++;
      if (old.deleted) {
        changes.push(`## ${current.type === "project-index" ? current.title : `[[${current.title}]]`}`, "（作り直された）", ...current.lines.map((l) => `+ ${l}`));
        continue;
      }
      const before = new Set(old.lines);
      const after = new Set(current.lines);
      const lines = [
        ...current.lines.filter((l) => !before.has(l)).map((l) => `+ ${l}`),
        ...(current.type === "project-index" ? old.lines.filter((l) => !after.has(l)).map((l) => `- ${l}`) : []),
      ];
      changes.push(`## ${current.type === "project-index" ? current.title : `[[${current.title}]] の更新履歴`}`, ...(lines.length > 0 ? lines : ["（本文が更新された）"]));
    }
    if (updated === 0) return null;
    const open = `<owl-memory-diff generated="${this.now()}">`;
    const text = `${open}\n${changes.join("\n")}\n</owl-memory-diff>`;
    return tokens(text) <= ADVISOR_DIFF_TOKEN_LIMIT ? text : `${open}${updated} ページが更新された。page で開き直す</owl-memory-diff>`;
  }
}
