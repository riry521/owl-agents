import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { workReviewFilePath } from "@owl/shared";
import { DEFAULT_DEPENDENCY_SUMMARY_SETTINGS } from "@owl/shared/dependency-summary-settings";
import { clip } from "@owl/shared/small-helpers";
import type { JsonObject } from "./types";
import type { StoredWorkReview } from "./work-review-store";

export interface WorkReviewTaskEntry {
  readonly task_id: string;
  readonly title: string;
  readonly type: string;
  readonly focus: boolean;
  readonly depends_on: readonly string[];
  readonly work_done: string;
  readonly changed_files: readonly string[];
  readonly remaining_issues: readonly string[];
  readonly report_path: string | null;
}
export interface WorkReviewFinding {
  readonly kind: "missing_link" | "mismatch";
  readonly from_task_id: string;
  readonly to_task_id: string | null;
  readonly file: string;
  readonly line: number | null;
  readonly problem: string;
  readonly fix: string;
  readonly evidence: string;
}
export interface WorkReviewMaterial {
  readonly tasks: readonly WorkReviewTaskEntry[];
  readonly previous_findings: readonly WorkReviewFinding[];
}

/** Sizes that start at `start` and halve down to `last`: the shrink schedule of every stage. */
function* halving(start: number, last: number): Generator<number> {
  for (let n = start; n >= last; n = Math.floor(n / 2)) {
    yield n;
    if (n === 0) return;
  }
}

function fits(value: unknown, limit: number): boolean {
  return JSON.stringify(value).length <= limit;
}

/** The last candidate does not fit: return it anyway, so the length stays bounded by the skeleton, and say so. */
function giveUp<T>(what: string, candidate: T, limit: number): T {
  console.error(`[owl-core] The ${what} limit (${limit}) is smaller than its skeleton (${JSON.stringify(candidate).length}); returning the skeleton`);
  return candidate;
}

function linkFinding(finding: WorkReviewFinding): JsonObject {
  const { kind, from_task_id, to_task_id, file, line } = finding;
  return { kind, from_task_id, to_task_id, file, line };
}

function textFinding(finding: WorkReviewFinding, c: number): JsonObject {
  return { ...linkFinding(finding), problem: clip(finding.problem, c), fix: clip(finding.fix, c), evidence: clip(finding.evidence, c) };
}

/** Files changed by two or more Tasks come first (where the links between Tasks show), each group in path order. */
function sharedFirst(tasks: readonly WorkReviewTaskEntry[]): (files: readonly string[]) => string[] {
  const owners = new Map<string, number>();
  for (const task of tasks) for (const file of new Set(task.changed_files)) owners.set(file, (owners.get(file) ?? 0) + 1);
  const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return (files) => {
    const shared = files.filter((file) => (owners.get(file) ?? 0) > 1).sort(byPath);
    const rest = files.filter((file) => (owners.get(file) ?? 0) <= 1).sort(byPath);
    return [...shared, ...rest];
  };
}

/** Fit the material object, so JSON.stringify(result).length <= max(limit, skeleton): texts, then links only, then shorter lists, then fewer Tasks. */
export function fitWorkReviewMaterial(full: WorkReviewMaterial, limit: number, materialPath: string | null): JsonObject {
  const { tasks, previous_findings: previous } = full;
  const linkTask = (task: WorkReviewTaskEntry): JsonObject => ({
    task_id: task.task_id,
    type: task.type,
    depends_on: [...task.depends_on],
    changed_files: [...task.changed_files],
    report_path: task.report_path,
    ...(task.focus ? { focus: true } : {}),
  });
  const wrap = (trim: string, taskItems: JsonObject[], findingItems: JsonObject[], omittedTasks: number, omittedFindings: number): JsonObject => ({
    trim,
    material_path: materialPath,
    tasks: taskItems,
    previous_findings: findingItems,
    omitted_tasks: omittedTasks,
    omitted_previous_findings: omittedFindings,
  });

  for (const c of halving(DEFAULT_DEPENDENCY_SUMMARY_SETTINGS.max_chars, 1)) {
    const candidate = wrap(
      "texts",
      tasks.map((task) => ({
        ...linkTask(task),
        title: clip(task.title, c),
        work_done: clip(task.work_done, c),
        remaining_issues: task.remaining_issues.map((issue) => clip(issue, c)),
      })),
      previous.map((finding) => textFinding(finding, c)),
      0,
      0,
    );
    if (fits(candidate, limit)) return candidate;
  }
  const links = wrap("links_only", tasks.map(linkTask), previous.map(linkFinding), 0, 0);
  if (fits(links, limit)) return links;

  const order = sharedFirst(tasks);
  const longest = Math.max(0, ...tasks.map((task) => task.changed_files.length), previous.length);
  const withLists = (trim: string, taskList: readonly WorkReviewTaskEntry[], k: number, omittedTasks: number, findings: readonly WorkReviewFinding[], omittedFindings: number): JsonObject =>
    wrap(
      trim,
      taskList.map((task) => {
        const files = order(task.changed_files);
        const omitted = Math.max(0, files.length - k);
        return { ...linkTask(task), changed_files: files.slice(0, k), ...(omitted > 0 ? { omitted_changed_files: omitted } : {}) };
      }),
      findings.slice(0, k).map(linkFinding),
      omittedTasks,
      omittedFindings,
    );
  for (const k of halving(Math.floor(longest / 2), 0)) {
    const candidate = withLists("lists", tasks, k, 0, previous, Math.max(0, previous.length - k));
    if (fits(candidate, limit)) return candidate;
  }
  // focus Tasks first: after a fix round the links of the new Tasks matter most.
  const ranked = [...tasks.filter((task) => task.focus), ...tasks.filter((task) => !task.focus)];
  let last = withLists("tasks", ranked, 0, 0, [], previous.length);
  for (const m of halving(Math.floor(tasks.length / 2), 0)) {
    last = withLists("tasks", ranked.slice(0, m), 0, tasks.length - m, [], previous.length);
    if (fits(last, limit)) return last;
  }
  return giveUp("Work review material", last, limit);
}

/** Fit the findings returned to the Manager: texts, then links only, then fewer findings. */
export function fitWorkReviewFindings(
  review: { round: number; summary: string; findings: readonly WorkReviewFinding[] },
  limit: number,
  findingsPath: string | null,
): JsonObject {
  const { findings } = review;
  const wrap = (trim: string, items: JsonObject[], omitted: number, summary?: string): JsonObject => ({
    round: review.round,
    trim,
    findings_path: findingsPath,
    ...(summary === undefined ? {} : { summary }),
    findings: items,
    omitted_findings: omitted,
  });
  for (const c of halving(DEFAULT_DEPENDENCY_SUMMARY_SETTINGS.max_chars, 1)) {
    const candidate = wrap("texts", findings.map((finding) => textFinding(finding, c)), 0, clip(review.summary, c));
    if (fits(candidate, limit)) return candidate;
  }
  const links = wrap("links_only", findings.map(linkFinding), 0);
  if (fits(links, limit)) return links;
  let last = links;
  for (const k of halving(Math.floor(findings.length / 2), 0)) {
    last = wrap("lists", findings.slice(0, k).map(linkFinding), findings.length - k);
    if (fits(last, limit)) return last;
  }
  return giveUp("Work review findings", last, limit);
}

/** Writes like writeDependencyReport (temp file, then rename; 0o700 directory, 0o600 file); a failure is logged and gives null. */
export function writeWorkReviewFile(path: string, value: unknown): string | null {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(temp, path);
    return path;
  } catch (error) {
    console.warn(`[owl-core] Could not write the Work review file ${path}`, error);
    return null;
  }
}

/** Rewrites the full findings file from the event and returns the findings fitted to the limit. */
export function workReviewContext(dataDir: string, workId: string, review: StoredWorkReview, limit: number): JsonObject {
  const path = writeWorkReviewFile(
    workReviewFilePath(dataDir, workId, review.agent_run_id, "findings"),
    { agent_run_id: review.agent_run_id, round: review.round, summary: review.summary, findings: review.findings },
  );
  return fitWorkReviewFindings(review, limit, path);
}
