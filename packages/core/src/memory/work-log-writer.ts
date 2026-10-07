import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createUlid } from "../../../db/dist/index.js";
import { lessonFingerprint } from "../learning-fingerprint.js";
import { slugifyKnowledgeName } from "../knowledge-naming.js";
import type { NormalizedLesson } from "../final-verdict.js";
import type { LearningRoute } from "../learning-pipeline.js";
import type { CoreDatabase } from "../types.js";
import { WORK_LOG_SECTIONS, parsePage, renderPage, uniqueFilename, type ParsedPage } from "./page-format.js";
import { writePage } from "./page-router.js";

export interface WorkLogWriterOptions {
  readonly db: Pick<CoreDatabase, "get">;
  readonly knowledgeDir: () => string;
  readonly withWrite: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly onChanged?: (paths: readonly string[]) => void;
}

interface WorkRow {
  id: string; project_id: string | null; title: string; summary: string; state: string;
  display_number: number | null; completed_at: string | null; cancelled_at: string | null; updated_at: string;
}

const LESSON_LABELS: Readonly<Record<NormalizedLesson["kind"], string>> = {
  pitfall: "落とし穴", decision: "決まりごと", fact: "事実", procedure: "手順", rule_candidate: "ルール候補",
};
const MAX_SUMMARY_LINES = 5;
const MAX_LESSON_LINES = 12;
const MAX_LINE_CHARS = 200;

/** Builds the `type: work-log` page of a Work from the DB alone (no LLM). Writing it again overwrites the same file. */
export class WorkLogWriter {
  public constructor(private readonly options: WorkLogWriterOptions) {}

  /** Returns the vault-relative path, or null when the Work has no learning job (nothing was learned). */
  public write(workId: string, routes?: readonly LearningRoute[]): Promise<string | null> {
    return this.options.withWrite(() => this.writeLocked(workId, routes));
  }

  private async writeLocked(workId: string, current?: readonly LearningRoute[]): Promise<string | null> {
    const job = this.options.db.get<{ payload_json: string; result_json: string | null }>(
      "SELECT payload_json, result_json FROM learning_jobs WHERE work_id = ?", workId,
    );
    const work = this.options.db.get<WorkRow>(
      "SELECT id, project_id, title, summary, state, display_number, completed_at, cancelled_at, updated_at FROM works WHERE id = ?", workId,
    );
    if (!job || !work) return null;
    const lessons = (JSON.parse(job.payload_json) as { lessons?: NormalizedLesson[] }).lessons?.slice(0, MAX_LESSON_LINES) ?? [];
    if (lessons.length === 0) return null;
    const routes = new Map((current ?? routesOf(job.result_json)).map((route) => [route.fingerprint, route]));

    const outcome = work.state === "completed" ? "completed" : work.state === "cancelled" ? "cancelled" : "incomplete";
    const completedAt = work.completed_at ?? work.cancelled_at ?? work.updated_at;
    const number = work.display_number;
    const title = number === null ? work.title : `W${number} ${work.title}`;
    const prefix = number === null ? workId.slice(-8).toLowerCase() : `W${number}`;
    const root = this.options.knowledgeDir();
    const month = completedAt.slice(0, 7);
    const found = await findExisting(root, prefix, workId);
    const frontmatter: Record<string, string | number> = {
      id: found?.id ?? createUlid(), type: "work-log", work_id: workId, work_number: number ?? "",
      ...(work.project_id ? { project_id: work.project_id } : {}),
      title, outcome, completed_at: completedAt, created: found?.created || completedAt.slice(0, 10),
    };
    const done = [`結果: ${{ completed: "完了", cancelled: "中止", incomplete: "未完了" }[outcome]}`, ...summaryLines(work.summary)];
    const page: ParsedPage = {
      kind: "work-log", frontmatter, frontmatter_order: Object.keys(frontmatter), comment: null, title, preamble: [],
      sections: [
        { heading: WORK_LOG_SECTIONS[0], lines: done.slice(0, 6).map((line) => `- ${line}`) },
        { heading: WORK_LOG_SECTIONS[1], lines: lessons.map((lesson) => `- [${LESSON_LABELS[lesson.kind] ?? lesson.kind}] ${clip(lesson.lesson)}`) },
        { heading: WORK_LOG_SECTIONS[2], lines: lessons.map((lesson) => `- ${reflected(routes.get(lessonFingerprint(lesson))) }`) },
      ],
    };

    const dir = found ? found.dir : join("works", month);
    const name = found?.name ?? await newName(root, `${prefix}-${slugifyKnowledgeName(work.title, "work", 40)}.md`);
    await mkdir(join(root, dir), { recursive: true });
    await writePage(join(root, dir, name), renderPage(page));
    const path = `${dir}/${name}`;
    this.options.onChanged?.([path]);
    return path;
  }
}

function routesOf(json: string | null): LearningRoute[] {
  try {
    const routes = (JSON.parse(json ?? "{}") as { routes?: unknown }).routes;
    return Array.isArray(routes) ? routes.filter((route): route is LearningRoute => typeof route?.fingerprint === "string") : [];
  } catch (error) {
    console.warn("[owl-core] Could not parse the stored learning routes; treating them as empty.", error);
    return [];
  }
}

function reflected(route: LearningRoute | undefined): string {
  if (!route) return "反映なし: 未処理";
  if ((route.status === "appended" || route.status === "duplicate") && route.page) {
    return `[[${route.page.replace(/\.md$/u, "")}]] の ${route.section ?? ""} に 1 件`;
  }
  if (route.status === "skill_proposal" && route.ref) return `Skill 提案 ${route.ref}`;
  if (route.status === "rule_proposal" && route.ref) return `ルール提案 ${route.ref}`;
  return `反映なし: ${route.reason ?? route.status}`;
}

function clip(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
}

function summaryLines(summary: string): string[] {
  return summary.split(/\r?\n/u).map((line) => clip(line.replace(/^\s*(?:[-*]|\d+[.)])\s*/u, ""))).filter(Boolean).slice(0, MAX_SUMMARY_LINES);
}

/** The work-log file of this Work (matched by `work_id`), searched among `works/<month>/<prefix>-*.md`. */
async function findExisting(root: string, prefix: string, workId: string): Promise<{ dir: string; name: string; id: string; created: string } | null> {
  for (const month of await names(join(root, "works"), (entry) => entry.isDirectory())) {
    const dir = `works/${month}`;
    for (const name of await names(join(root, dir), (entry) => entry.isFile() && entry.name.startsWith(`${prefix}-`) && entry.name.endsWith(".md"))) {
      const page = parsePage(await readFile(join(root, dir, name), "utf8"));
      if (page.frontmatter.work_id === workId) {
        const { id, created } = page.frontmatter;
        return { dir, name, id: typeof id === "string" ? id : createUlid(), created: typeof created === "string" ? created : "" };
      }
    }
  }
  return null;
}

/** A file name no work-log in any month uses yet (names are unique across the vault). */
async function newName(root: string, wanted: string): Promise<string> {
  const used = new Set<string>();
  for (const month of await names(join(root, "works"), (entry) => entry.isDirectory())) {
    for (const name of await names(join(root, "works", month), (entry) => entry.isFile())) used.add(name);
  }
  return uniqueFilename(wanted, (candidate) => used.has(candidate));
}

async function names(path: string, keep: (entry: import("node:fs").Dirent) => boolean): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter(keep).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
