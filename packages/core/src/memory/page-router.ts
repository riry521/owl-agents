import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createUlid } from "../../../db/dist/index.js";
import { fingerprint } from "../learning-fingerprint.js";
import { slugifyKnowledgeName } from "../knowledge-naming.js";
import {
  assertValidPage, emptyThemePage, estimatePageTokens, findSecretPatterns, INDEX_SECTIONS, SOURCE_LABEL, parsePage, renderPage, themeTitleKey, uniqueFilename,
  PageRejectedError, type ParsedPage,
} from "./page-format.js";

export type RouteSection = "概要" | "決まりごと" | "落とし穴" | "手順";

export interface RouteInput {
  readonly kind: "pitfall" | "decision" | "fact" | "procedure";
  /** One line of body text (a reason may be included). */
  readonly text: string;
  /** The steps for kind=procedure. */
  readonly procedure?: string;
  /** Title of the theme page the writer chose; empty means unspecified. */
  readonly theme?: string;
  readonly project_id: string | null;
  readonly cross_project?: boolean;
  readonly source: { readonly work_number: number | null; readonly work_id: string | null; readonly actor: string; /** Source label used when there is no Work number (e.g. 会話2026-10-04-1). */ readonly label?: string };
}

export interface RouteResult {
  readonly status: "appended" | "duplicate" | "skill_proposal" | "rejected" | "deferred";
  readonly page?: string;
  readonly section?: RouteSection;
  readonly reason?: string;
}

export interface PageRouterOptions {
  readonly knowledgeDir: () => string;
  readonly withWrite: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Project name used for the folder slug and the index title. */
  readonly projectName?: (projectId: string) => string | null;
  readonly now?: () => Date;
  /** Called with the vault-relative paths that were written. */
  readonly onChanged?: (paths: readonly string[]) => void;
}

export const STORAGE_UNAVAILABLE_CODE = "knowledge_storage_unavailable";
export const OTHER_NOTES_TITLE = "その他の注意";
export const PROJECT_OVERVIEW_TITLE = "プロジェクトの構成";
const OTHER_NOTES_SUMMARY = "まだテーマに分かれていない注意";
const PROJECT_OVERVIEW_SUMMARY = "フォルダ構成とビルド・テストのコマンド";
const OVERVIEW_PROCEDURE = "構成と主要コマンド";
const OWL_MARK = /\s*<!-- owl:new[^>]*-->/gu;
const INDEX_FILE = "_index.md";
const MAX_PROCEDURE_STEPS = 5;
const MAX_ARCHIVE_HOPS = 5;
const PLACEHOLDERS = new Set(["（なし）", "- （なし）"]);
const SECTION_OF: Readonly<Record<RouteInput["kind"], RouteSection>> = { pitfall: "落とし穴", decision: "決まりごと", fact: "概要", procedure: "手順" };
const LINE = new RegExp(`^(\\s*- )(.*?)(?:（(${SOURCE_LABEL}(?:, ${SOURCE_LABEL})*)）)?(\\s*<!-- owl:new[^>]*-->)?\\s*$`, "u");
const PROCEDURE_HEADING = /^### (.*?)(?:\s*<!-- owl:new[^>]*-->)?\s*$/u;

export function isStorageUnavailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === STORAGE_UNAVAILABLE_CODE;
}

interface Scope { readonly folder: string; readonly projectId: string | null }
interface ThemeFile { readonly path: string; readonly name: string; readonly page: ParsedPage }

/** Where knowledge gets written: it picks a theme page and a section, and creates only the fallback pages. */
export class PageRouter {
  private tail: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: PageRouterOptions) {}

  /** Routes run one at a time, so appends to the same page never interleave. */
  public route(input: RouteInput): Promise<RouteResult> {
    return this.enqueue(() => this.routeNow(input));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** The overview lines (those starting with 【) now on the Project's プロジェクトの構成 page; [] when it does not exist. Throws while the storage is unavailable. */
  public readOverview(projectId: string): Promise<string[]> {
    return this.enqueue(() => this.options.withWrite(async () => {
      const root = this.options.knowledgeDir();
      const scope = await findProjectScope(root, projectId);
      const page = scope ? await readPage(join(root, scope.folder, `${PROJECT_OVERVIEW_TITLE}.md`)) : null;
      return (page?.sections ?? []).flatMap((section) => section.lines.map((line) => line.replace(/^\s*(?:- |\d+\. )/u, "").replace(OWL_MARK, "")).filter((line) => line.startsWith("【")));
    }));
  }

  /**
   * Replaces the 【…】 lines of the Project's プロジェクトの構成 page (all of them, 〔調査〕 lines included), keeping the other lines.
   * `procedure` goes in one numbered block under 手順. Returns false when nothing changed.
   */
  public writeOverview(input: { readonly project_id: string; readonly overview: readonly string[]; readonly procedure: readonly string[]; readonly pitfalls: readonly string[] }): Promise<boolean> {
    return this.enqueue(() => this.options.withWrite(async () => {
      const all = [...input.overview, ...input.procedure, ...input.pitfalls].map(oneLine);
      if (findSecretPatterns(all.join("\n")).length > 0) return false;
      const root = this.options.knowledgeDir();
      const scope = await this.scopeFor(root, { kind: "fact", text: "", project_id: input.project_id, source: { work_number: null, work_id: null, actor: "overview" } });
      const target = await this.pickPage(root, scope, PROJECT_OVERVIEW_TITLE);
      const mark = `<!-- owl:new ${this.today()} - -->`;
      const bullets = (texts: readonly string[]): string[] => texts.map((text) => `- ${oneLine(text)} ${mark}`);
      const dropBullets = (lines: readonly string[]): string[] => lines.filter((line) => !/^- 【/u.test(line));
      const plan: Array<[RouteSection, (lines: readonly string[]) => string[], string[]]> = [
        ["概要", dropBullets, bullets(input.overview)],
        ["手順", dropBlock, input.procedure.length ? [`### ${OVERVIEW_PROCEDURE} ${mark}`, ...input.procedure.map((text, index) => `${index + 1}. ${oneLine(text)}`)] : []],
        ["落とし穴", dropBullets, bullets(input.pitfalls)],
      ];
      const plain = (lines: readonly string[]): string => lines.filter((line) => !PLACEHOLDERS.has(line.trim())).map((line) => line.replace(OWL_MARK, "")).join("\n");
      let sections = target.page.sections;
      let changed = false;
      for (const [heading, strip, added] of plan) {
        const old = sections.find((section) => section.heading === heading)?.lines ?? [];
        const lines = [...strip(old).filter((line) => !PLACEHOLDERS.has(line.trim())), ...added];
        if (plain(lines) === plain(old)) continue;
        changed = true;
        sections = sections.some((section) => section.heading === heading)
          ? sections.map((section) => (section.heading === heading ? { ...section, lines } : section))
          : [...sections, { heading, lines }];
      }
      if (!changed) return false;
      const { page } = target;
      const frontmatter = "updated" in page.frontmatter ? { ...page.frontmatter, updated: this.today() } : page.frontmatter;
      try {
        await writePage(join(root, target.path), renderPage({ ...page, frontmatter, sections }));
      } catch (error) {
        if (error instanceof PageRejectedError) return false;
        throw error;
      }
      this.options.onChanged?.([target.path]);
      return true;
    }));
  }

  private async routeNow(input: RouteInput): Promise<RouteResult> {
    try {
      return await this.options.withWrite(() => this.routeLocked(input));
    } catch (error) {
      if (isStorageUnavailable(error)) return { status: "deferred", reason: "storage_unavailable" };
      if (error instanceof PageRejectedError) return { status: "rejected", reason: "template_invalid" };
      throw error;
    }
  }

  private async routeLocked(input: RouteInput): Promise<RouteResult> {
    const text = oneLine(input.text);
    if (!text) return { status: "rejected", reason: "empty_text" };
    if (findSecretPatterns(`${input.text}\n${input.procedure ?? ""}`).length > 0) return { status: "rejected", reason: "secret_pattern" };
    const section = SECTION_OF[input.kind];
    const isProcedure = input.kind === "procedure";
    const steps = isProcedure ? numberedSteps(input.procedure ?? "") : [];
    if (isProcedure && (steps.length === 0 || steps.length > MAX_PROCEDURE_STEPS)) {
      return { status: "skill_proposal", reason: steps.length === 0 ? "no_steps" : "too_many_steps" };
    }

    const root = this.options.knowledgeDir();
    const scope = await this.scopeFor(root, input);
    const target = await this.pickPage(root, scope, input.theme ?? "");
    const label = input.source.work_number === null ? input.source.label ?? null : `W${input.source.work_number}`;
    const lines = [...(target.page.sections.find((candidate) => candidate.heading === section)?.lines ?? [])];

    const existing = findLine(lines, isProcedure ? procedureHeading(text) : text, isProcedure);
    if (existing >= 0) {
      if (!isProcedure && addSource(lines, existing, label)) await this.save(root, target, section, lines);
      return { status: "duplicate", page: target.path, section };
    }

    const mark = `<!-- owl:new ${this.today()} ${label ?? "-"} -->`;
    const kept = lines.filter((line) => !PLACEHOLDERS.has(line.trim()));
    if (isProcedure) {
      if (kept.length > 0) kept.push("");
      kept.push(`### ${procedureHeading(text)} ${mark}`, ...steps);
    } else {
      kept.push(`- ${text}${label ? `（${label}）` : ""} ${mark}`);
    }
    await this.save(root, target, section, kept);
    return { status: "appended", page: target.path, section };
  }

  private today(): string {
    return (this.options.now?.() ?? new Date()).toISOString().slice(0, 10);
  }

  private async save(root: string, target: ThemeFile, heading: RouteSection, lines: readonly string[]): Promise<void> {
    const { page } = target;
    const sections = page.sections.some((section) => section.heading === heading)
      ? page.sections.map((section) => (section.heading === heading ? { ...section, lines } : section))
      : [...page.sections, { heading, lines }];
    const frontmatter = "updated" in page.frontmatter ? { ...page.frontmatter, updated: this.today() } : page.frontmatter;
    await writePage(join(root, target.path), renderPage({ ...page, frontmatter, sections }));
    this.options.onChanged?.([target.path]);
  }

  /** `common/` for cross-project knowledge, otherwise the Project's folder (created with its three files when missing). */
  private async scopeFor(root: string, input: RouteInput): Promise<Scope> {
    if (input.cross_project === true || !input.project_id) {
      const common = { folder: "common", projectId: null };
      await this.ensureTheme(root, common, OTHER_NOTES_TITLE, OTHER_NOTES_SUMMARY);
      return common;
    }
    const projectId = input.project_id;
    const found = await findProjectScope(root, projectId);
    if (found) return found;
    const folders = await listDirs(join(root, "projects"));
    const projectName = this.options.projectName?.(projectId) ?? null;
    const slug = uniqueFilename(slugifyKnowledgeName(projectName ?? "", `project-${projectId.slice(-8).toLowerCase()}`), (candidate) => folders.includes(candidate));
    const scope = { folder: `projects/${slug}`, projectId };
    await mkdir(join(root, scope.folder), { recursive: true });
    await createFile(join(root, scope.folder, INDEX_FILE), renderPage(this.emptyIndex(projectId, projectName ?? slug)));
    await this.ensureTheme(root, scope, PROJECT_OVERVIEW_TITLE, PROJECT_OVERVIEW_SUMMARY);
    await this.ensureTheme(root, scope, OTHER_NOTES_TITLE, OTHER_NOTES_SUMMARY);
    return scope;
  }

  private emptyIndex(projectId: string, name: string): ParsedPage {
    const title = `${name} の目次`;
    const frontmatter = {
      id: createUlid(), type: "project-index", scope: "project", project_id: projectId, title,
      generated_at: (this.options.now?.() ?? new Date()).toISOString().replace(/\.\d+Z$/u, "Z"),
      source_hash: createHash("sha256").update("").digest("hex"), token_estimate: 0,
    };
    const page: ParsedPage = {
      kind: "project-index", frontmatter, frontmatter_order: Object.keys(frontmatter),
      comment: "<!-- 自動生成。直すときはテーマページを直す -->", title, preamble: [],
      sections: INDEX_SECTIONS.map((heading) => ({ heading, lines: ["（なし）"] })),
    };
    return { ...page, frontmatter: { ...frontmatter, token_estimate: estimatePageTokens(renderPage(page)) } };
  }

  private async ensureTheme(root: string, scope: Scope, title: string, summary: string): Promise<void> {
    await mkdir(join(root, scope.folder), { recursive: true });
    const page = emptyThemePage({ id: createUlid(), title, summary, scope: scope.projectId ? "project" : "common", project_id: scope.projectId, today: this.today() });
    await createFile(join(root, scope.folder, `${title}.md`), renderPage(page));
  }

  /** The active page titled `theme`, following `merged_into` of archived pages; else the fallback page. */
  private async pickPage(root: string, scope: Scope, theme: string): Promise<ThemeFile> {
    const inScope = await listThemes(root, scope.folder);
    const named = (file: ThemeFile, key: string) => themeTitleKey(titleOf(file)) === key || themeTitleKey(file.name) === key;
    let key = themeTitleKey(theme);
    let archived: ThemeFile[] | null = null;
    for (let hop = 0; key && hop <= MAX_ARCHIVE_HOPS; hop += 1) {
      const active = inScope.find((file) => file.page.frontmatter.status !== "archived" && named(file, key));
      if (active) return active;
      archived ??= (await listThemes(root, "archive")).filter((file) => belongsTo(file.page, scope));
      const old = [...inScope, ...archived].find((file) => file.page.frontmatter.status === "archived" && named(file, key));
      const mergedInto = old?.page.frontmatter.merged_into;
      const merged = typeof mergedInto === "string" ? /^\[\[([^\]|]+)/u.exec(mergedInto)?.[1] : undefined;
      key = merged ? themeTitleKey(merged) : "";
    }
    const fallback = inScope.find((file) => file.name === OTHER_NOTES_TITLE && file.page.frontmatter.status !== "archived");
    if (fallback) return fallback;
    await this.ensureTheme(root, scope, OTHER_NOTES_TITLE, OTHER_NOTES_SUMMARY);
    const created = (await listThemes(root, scope.folder)).find((file) => file.name === OTHER_NOTES_TITLE);
    if (!created) throw new Error("fallback_page_missing");
    return created;
  }
}

async function findProjectScope(root: string, projectId: string): Promise<Scope | null> {
  for (const name of await listDirs(join(root, "projects"))) {
    const index = await readPage(join(root, "projects", name, INDEX_FILE));
    if (index?.frontmatter.project_id === projectId) return { folder: `projects/${name}`, projectId };
  }
  return null;
}

/** Drops the overview's `### ` block and its steps from a 手順 section. */
function dropBlock(lines: readonly string[]): string[] {
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const heading = PROCEDURE_HEADING.exec(line)?.[1];
    if (heading !== undefined) skipping = heading === OVERVIEW_PROCEDURE;
    if (!skipping) out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out;
}

function titleOf(file: ThemeFile): string {
  const title = file.page.frontmatter.title;
  return typeof title === "string" ? title : file.name;
}

function belongsTo(page: ParsedPage, scope: Scope): boolean {
  return scope.projectId ? page.frontmatter.project_id === scope.projectId : page.frontmatter.scope === "common";
}

function oneLine(text: string): string {
  return text.replace(/<!--|-->/gu, " ").replace(/\s+/gu, " ").trim();
}

function numberedSteps(procedure: string): string[] {
  return procedure.split(/\r?\n/u).map((line) => line.trim()).filter((line) => /^\d+[.)．、]/u.test(line));
}

function procedureHeading(text: string): string {
  return Array.from(text).slice(0, 40).join("");
}

/** Index of the line whose normalized body equals `text`, or -1. */
function findLine(lines: readonly string[], text: string, heading: boolean): number {
  const wanted = fingerprint(text);
  return lines.findIndex((line) => {
    const body = heading ? PROCEDURE_HEADING.exec(line)?.[1] : LINE.exec(line)?.[2].replace(/^★\s*/u, "");
    return body !== undefined && fingerprint(body) === wanted;
  });
}

/** Adds the Work to the line's sources (two at most, newest kept). Returns whether the line changed. */
function addSource(lines: string[], index: number, label: string | null): boolean {
  const match = label ? LINE.exec(lines[index]) : null;
  if (!label || !match) return false;
  const sources = match[3] ? match[3].split(", ") : [];
  if (sources.includes(label)) return false;
  lines[index] = `${match[1]}${match[2]}（${[...sources, label].slice(-2).join(", ")}）${match[4] ?? ""}`;
  return true;
}

async function readPage(path: string): Promise<ParsedPage | null> {
  try {
    return parsePage(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function listDirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function listThemes(root: string, folder: string): Promise<ThemeFile[]> {
  let names: string[];
  try {
    names = (await readdir(join(root, folder), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== INDEX_FILE).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: ThemeFile[] = [];
  for (const name of names.sort()) {
    const path = `${folder}/${name}`;
    const page = await readPage(join(root, path));
    if (page?.kind === "theme") files.push({ path, name: name.slice(0, -3), page });
  }
  return files;
}

/** Create-only write; an existing file is left alone. */
async function createFile(path: string, content: string): Promise<void> {
  assertValidPage(content);
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** The page write: it must fit the four templates, else PageRejectedError and no file is touched. */
export async function writePage(path: string, content: string): Promise<void> {
  assertValidPage(content);
  await writeAtomic(path, content);
}

/** Temp file + rename, so a reader never sees half a page. */
export async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
  await rename(tmp, path);
}
