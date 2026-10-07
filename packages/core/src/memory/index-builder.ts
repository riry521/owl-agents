import { createHash } from "node:crypto";

import { generateUlid } from "@owl/shared";

import type { MemoryIndex } from "./memory-index.js";
import type { MemoryNoteRow, PageRow } from "./memory-types.js";
import {
  bodySha256, estimatePageTokens, INDEX_SECTIONS, PAGE_LIMITS, parsePage, renderPage, validatePage,
  type FrontmatterValue,
} from "./page-format.js";

/** Builds the Project/common index pages and Home.md (design §2.2, §4.4, §7.2). */

export interface PageWriterPort {
  read(path: string): Promise<string | null>;
  write(path: string, text: string, options: { expected_body_sha256: string | null; create_only?: boolean }): Promise<{ path: string; written: boolean; reason?: "conflict" | "storage_unavailable" }>;
}
export interface ProjectLookup { get(projectId: string): { id: string; name: string } | null }

export interface IndexMaterials {
  readonly scope: { kind: "project"; project_id: string; project_name: string } | { kind: "common" };
  readonly overview: string | null;
  readonly themes: readonly { title: string; link?: string; summary: string; updated: string; integrated_hash: string | null }[];
  readonly must_read: readonly { text: string; page: string; link?: string; owner: boolean; latest_work: number | null }[];
  readonly common_themes: readonly { title: string; link?: string; summary: string; integrated_hash: string | null }[];
  readonly existing: { id: string; source_hash: string | null } | null;
}
export type IndexScope = { kind: "project"; project_id: string } | { kind: "common" };
export interface IndexBuildResult {
  readonly path: string;
  readonly text: string;
  readonly source_hash: string;
  readonly tokens: number;
  readonly collapsed: readonly string[];
  readonly changed: boolean;
}

const COMMENT = "<!-- 自動生成。直すときはテーマページを直す -->";
const CONFIG_TITLE = "プロジェクトの構成";
const LIMITS = { overview_tokens: 150, must_read: 10, themes: 20, common_themes: 6 } as const;
const MAX_BODY_BYTES = 256 * 1024;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const clip = (text: string, max: number): string => { const chars = Array.from(text); return chars.length <= max ? text : chars.slice(0, max).join(""); };
const oneLine = (text: string): string => text.replace(/\s+/gu, " ").trim();
const plainLinks = (text: string): string => text.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/gu, (_m, name: string, label?: string) => label ?? name);
/** The link target is the real file name (a suffix may have been added on a name clash); the title stays the label. */
const linkOf = (row: { path: string }): string => (row.path.split("/").pop() ?? row.path).replace(/\.md$/u, "");
const wikiLink = (link: string | undefined, title: string): string => (link === undefined || link === title ? `[[${title}]]` : `[[${link}|${title}]]`);
const safeSlug = (name: string): string => name.normalize("NFKC").replace(/[\\/:*?"<>|\s]+/gu, "-").replace(/^[-.]+|[-.]+$/gu, "");
const clipTokens = (text: string, max: number): string => { let out = text; while (out !== "" && estimatePageTokens(out) > max) out = Array.from(out).slice(0, -1).join(""); return out; };

interface Level { summary: boolean; common: number; must: number; themes: number }
const LEVELS: readonly Level[] = [
  { summary: false, common: LIMITS.common_themes, must: LIMITS.must_read, themes: LIMITS.themes },
  { summary: true, common: LIMITS.common_themes, must: LIMITS.must_read, themes: LIMITS.themes },
  { summary: true, common: 3, must: LIMITS.must_read, themes: LIMITS.themes },
  { summary: true, common: 3, must: 6, themes: LIMITS.themes },
  { summary: true, common: 3, must: 6, themes: 15 },
];
const COLLAPSE_NAMES = ["summary", "common_themes", "must_read", "themes"] as const;

const none = (lines: readonly string[]): string[] => (lines.length > 0 ? [...lines] : ["（なし）"]);

export class IndexBuilder {
  constructor(private readonly options: {
    index: Pick<MemoryIndex, "listPages" | "getProjectIndex" | "readBody" | "refreshChanged">;
    writer: PageWriterPort;
    projects: ProjectLookup;
    now?: () => Date;
    newId?: () => string;
  }) {}

  /** Pure. Cuts in the §7.2 order until the body fits in 1,200 tokens. */
  public static compose(materials: IndexMaterials, now: Date, id: string): IndexBuildResult {
    const project = materials.scope.kind === "project" ? materials.scope : null;
    const title = project ? `${project.project_name} の目次` : "共通の目次";
    const overview = clipTokens(oneLine(materials.overview ?? (project ? "" : "Project をまたぐ決まりごと")), LIMITS.overview_tokens);
    const mustRead = materials.must_read
      .map((entry, order) => ({ entry, order }))
      .sort((a, b) => Number(b.entry.owner) - Number(a.entry.owner) || (b.entry.latest_work ?? -1) - (a.entry.latest_work ?? -1) || a.order - b.order)
      .map(({ entry }) => `- ${clip(oneLine(plainLinks(entry.text)), 45)} → ${wikiLink(entry.link, entry.page)}`);
    const themes = [...materials.themes].sort((a, b) => b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title));

    const sourceHash = sha256(JSON.stringify([
      project ? project.project_id : "common", title, overview, mustRead,
      themes.map((t) => [t.title, t.link ?? null, t.summary, t.integrated_hash]),
      materials.common_themes.map((t) => [t.title, t.link ?? null, t.summary, t.integrated_hash]),
    ]));

    const themeLine = (t: { title: string; link?: string; summary: string }, short: boolean): string => `- ${wikiLink(t.link, t.title)} — ${short ? clip(t.summary, 25) : t.summary}`;
    const render = (level: Level): { body: string; page: ReturnType<typeof parsePage>; omitted: number } => {
      const shown = themes.slice(0, level.themes);
      const omitted = themes.length - shown.length;
      const themeLines = shown.map((t) => themeLine(t, level.summary));
      if (omitted > 0) themeLines.push(`- ほか ${omitted} テーマ（index で全件）`);
      const sections = [
        overview === "" ? ["（なし）"] : [overview],
        none(mustRead.slice(0, level.must)),
        none(themeLines),
        none(materials.common_themes.slice(0, level.common).map((t) => themeLine(t, level.summary))),
      ];
      const page = {
        kind: "project-index" as const, frontmatter: {}, frontmatter_order: [], comment: COMMENT, title, preamble: [],
        sections: INDEX_SECTIONS.map((heading, i) => ({ heading, lines: sections[i] })),
      };
      return { body: renderPage(page), page, omitted };
    };

    let level = 0;
    let built = render(LEVELS[0]);
    while (estimatePageTokens(built.body) > PAGE_LIMITS.index_tokens && level < LEVELS.length - 1) { level += 1; built = render(LEVELS[level]); }
    // Still over after the four steps (long titles): keep dropping the oldest themes so the limit holds.
    for (let themeLimit = LEVELS[level].themes - 1; estimatePageTokens(built.body) > PAGE_LIMITS.index_tokens && themeLimit >= 0; themeLimit -= 1) {
      built = render({ ...LEVELS[level], themes: themeLimit });
    }
    const collapsed = new Set<string>();
    for (let step = 1; step <= level; step += 1) collapsed.add(COLLAPSE_NAMES[step - 1]);
    if (built.omitted > 0) collapsed.add("themes");

    const tokens = estimatePageTokens(built.body);
    const frontmatter: Record<string, FrontmatterValue> = {
      id, type: "project-index", scope: project ? "project" : "common",
      ...(project ? { project_id: project.project_id } : {}),
      title, generated_at: now.toISOString().replace(/\.\d+Z$/u, "Z"), source_hash: sourceHash, token_estimate: tokens,
    };
    const text = renderPage({ ...built.page, frontmatter, frontmatter_order: Object.keys(frontmatter) });
    const slug = project ? safeSlug(project.project_name) || project.project_id : "";
    return {
      path: project ? `projects/${slug}/_index.md` : "common/_index.md",
      text, source_hash: sourceHash, tokens, collapsed: [...collapsed],
      changed: materials.existing?.source_hash !== sourceHash,
    };
  }

  /** Home.md is a common project-index whose テーマ lines are the index links plus `extra` (kept links). `error` when it would not fit the template. */
  public static composeHome(indexes: readonly { title: string; path: string }[], extra: readonly string[], now: Date, id: string): { text: string } | { error: string } {
    const links = indexes.map((entry) => `- [[${entry.path.replace(/\.md$/u, "")}|${entry.title}]]`);
    const lines = [...links, ...extra.map((l) => (l.startsWith("- ") ? l : `- ${l}`))];
    const sections = [["保管庫の入口。各目次へのリンク"], ["（なし）"], none(lines), ["（なし）"]];
    const sourceHash = sha256(JSON.stringify(lines));
    const page = { kind: "project-index" as const, comment: COMMENT, title: "Home", preamble: [], sections: INDEX_SECTIONS.map((heading, i) => ({ heading, lines: sections[i] })) };
    const frontmatter: Record<string, FrontmatterValue> = { id, type: "project-index", scope: "common", title: "Home", generated_at: now.toISOString().replace(/\.\d+Z$/u, "Z"), source_hash: sourceHash, token_estimate: 0 };
    const render = (): string => renderPage({ ...page, frontmatter, frontmatter_order: Object.keys(frontmatter) });
    frontmatter.token_estimate = estimatePageTokens(render());
    const text = render();
    const checked = validatePage(parsePage(text), { writer: "owner" });
    // The line and token limits are warnings in validatePage, but a Home.md outside them is not a project-index.
    const errors = [...checked.errors, ...checked.warnings.filter((w) => w.code === "section_over_lines" || w.code === "over_budget")];
    return errors.length > 0 ? { error: `Home.md がテンプレートに収まらない: ${errors.map((e) => e.message).join(" / ")}` } : { text };
  }

  public async rebuild(scope: { kind: "project"; project_id: string } | { kind: "common" }): Promise<IndexBuildResult> {
    return (await this.rebuildOne(scope)).result;
  }

  /** Rebuilds the indexes (all scopes, or only `only`) and Home.md. A scope left out keeps its index file and is listed in Home.md as it is. */
  public async rebuildAll(only?: readonly IndexScope[]): Promise<readonly IndexBuildResult[]> {
    await this.options.index.refreshChanged();
    const projectIds = new Set<string>();
    for (const row of this.options.index.listPages({ types: ["theme", "project-index"], scope: "project" })) {
      if (row.project_id) projectIds.add(row.project_id);
    }
    const keyOf = (scope: IndexScope): string => (scope.kind === "common" ? "common" : scope.project_id);
    const wanted = only ? new Set(only.map(keyOf)) : null;
    const scopes: IndexScope[] = [{ kind: "common" }, ...[...projectIds].sort().map((project_id) => ({ kind: "project" as const, project_id }))];
    const entries: { title: string; path: string }[] = [];
    const built: IndexBuildResult[] = [];
    for (const scope of scopes) {
      if (wanted && !wanted.has(keyOf(scope))) {
        const row = this.options.index.getProjectIndex(scope.kind === "common" ? null : scope.project_id);
        if (row) entries.push({ title: row.title, path: row.path });
        continue;
      }
      const { result } = await this.rebuildOne(scope);
      built.push(result);
      entries.push({ title: String(parsePage(result.text).frontmatter.title), path: result.path });
    }

    const existing = await this.options.writer.read("Home.md");
    const known = new Set(entries.map((e) => e.path.replace(/\.md$/u, "")));
    const previous = existing === null ? null : parsePage(existing);
    const kept = (previous?.sections.find((s) => s.heading === INDEX_SECTIONS[2])?.lines ?? [])
      .filter((l) => /^\s*- /u.test(l) && l.trim() !== "- （なし）" && l.replace(/\[\[([^\]|#\n]+)(?:[|#][^\]\n]*)?\]\]/gu, (whole, target: string) => (known.has(target.trim()) ? "" : whole)).replace(/^\s*-\s*/u, "").trim() !== "");
    const id = typeof previous?.frontmatter.id === "string" && previous.frontmatter.id !== "" ? previous.frontmatter.id : (this.options.newId ?? generateUlid)();
    const composed = IndexBuilder.composeHome(entries, kept, (this.options.now ?? (() => new Date()))(), id);
    if ("error" in composed) throw new Error(composed.error);
    const text = composed.text;
    const sourceHash = String(parsePage(text).frontmatter.source_hash);
    const changed = previous === null || previous.frontmatter.source_hash !== sourceHash || validatePage(previous, { writer: "owner" }).errors.length > 0;
    if (changed) await this.options.writer.write("Home.md", text, { expected_body_sha256: existing === null ? null : bodySha256(existing) });
    return [...built, { path: "Home.md", text, source_hash: sourceHash, tokens: estimatePageTokens(text), collapsed: [], changed }];
  }

  private async rebuildOne(scope: { kind: "project"; project_id: string } | { kind: "common" }): Promise<{ result: IndexBuildResult }> {
    const { index, writer } = this.options;
    await index.refreshChanged();
    const projectId = scope.kind === "project" ? scope.project_id : null;
    const existingRow = index.getProjectIndex(projectId);
    const themeRows = index.listPages(scope.kind === "project"
      ? { types: ["theme"], scope: "project", project_id: scope.project_id, status: ["active"] }
      : { types: ["theme"], scope: "common", status: ["active"] });
    const commonRows = scope.kind === "project"
      ? index.listPages({ types: ["theme"], scope: "common", related_to_project: scope.project_id, status: ["active"] })
      : [];

    let overview: string | null = null;
    const mustRead: IndexMaterials["must_read"][number][] = [];
    for (const row of themeRows) {
      const sections = parsePage(await this.bodyOf(row)).sections;
      if (scope.kind === "project" && row.title === CONFIG_TITLE) {
        const lines = sections.find((s) => s.heading === "概要")?.lines.filter((l) => l.trim() !== "" && l.trim() !== "（なし）") ?? [];
        if (lines.length > 0) overview = lines.join(" ");
      }
      for (const section of sections.filter((s) => s.heading === "決まりごと" || s.heading === "落とし穴")) {
        for (const line of section.lines) {
          if (!line.startsWith("- ★ ")) continue;
          const text = line.slice("- ★ ".length).trim();
          const works = [...text.matchAll(/\bW(\d+)/gu)].map((m) => Number(m[1]));
          mustRead.push({ text, page: row.title, link: linkOf(row), owner: text.includes("Owner"), latest_work: works.length > 0 ? Math.max(...works) : null });
        }
      }
    }

    const projectName = projectId === null ? "" : this.options.projects.get(projectId)?.name ?? projectId;
    const materials: IndexMaterials = {
      scope: projectId === null ? { kind: "common" } : { kind: "project", project_id: projectId, project_name: projectName },
      overview,
      themes: themeRows.map((r) => ({ title: r.title, link: linkOf(r), summary: r.summary, updated: r.updated ?? "", integrated_hash: r.integrated_hash })),
      must_read: mustRead,
      common_themes: commonRows.map((r) => ({ title: r.title, link: linkOf(r), summary: r.summary, integrated_hash: r.integrated_hash })),
      existing: null,
    };
    const id = (await this.existingId(existingRow)) ?? (this.options.newId ?? generateUlid)();
    const composed = IndexBuilder.compose({ ...materials, existing: existingRow ? { id, source_hash: existingRow.source_hash } : null }, (this.options.now ?? (() => new Date()))(), id);
    // Keep the folder of an existing index (the slug may have been chosen before the project was renamed).
    const result = existingRow && projectId !== null ? { ...composed, path: existingRow.path } : composed;
    if (result.changed) await writer.write(result.path, result.text, { expected_body_sha256: existingRow ? existingRow.body_sha256 : null });
    return { result };
  }

  private async existingId(row: PageRow | null): Promise<string | null> {
    if (!row) return null;
    const id = parsePage((await this.options.writer.read(row.path)) ?? "").frontmatter.id;
    return typeof id === "string" && id !== "" ? id : null;
  }

  private async bodyOf(row: PageRow): Promise<string> {
    return (await this.options.index.readBody(row as unknown as MemoryNoteRow, MAX_BODY_BYTES)).body;
  }
}
