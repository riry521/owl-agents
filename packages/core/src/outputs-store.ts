import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { CoreDatabase } from "./types";
import { safeSegment } from "./git-gateway.js";

export interface OutputsStoreDeps {
  readonly db: CoreDatabase;
  readonly owlRoot: string;
  readonly dataDir: string;
}

/** Sentinel owner for a file that was already in the outputs folder before this pass. */
const BASELINE_OWNER = Symbol("outputs-baseline");
type Owner = string | typeof BASELINE_OWNER;

interface WinningFile {
  readonly source: string;
  readonly owner: Owner;
  readonly sha256: string;
  readonly bytes: number;
}

interface ConflictFile {
  readonly relPath: string;
  readonly source: string;
  readonly sha256: string;
  readonly bytes: number;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Every regular file under `root`, as a `/`-joined path relative to it. Skips `.git` and symlinks. */
async function listFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`File collection root is not a plain directory: ${root}`);
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const absolute = resolve(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) { await visit(absolute); continue; }
      if (info.isFile()) results.push(relative(root, absolute).split("\\").join("/"));
    }
  };
  await visit(root);
  return results;
}

async function fileDigest(path: string): Promise<{ sha256: string; bytes: number }> {
  const contents = await readFile(path);
  return { sha256: createHash("sha256").update(contents).digest("hex"), bytes: contents.byteLength };
}

/** Direct `depends_on_task_id` edges for every Task of this Work. */
function loadDependsOn(db: CoreDatabase, workId: string): Map<string, string[]> {
  const rows = db.all<{ task_id: string; depends_on_task_id: string }>(
    `SELECT td.task_id AS task_id, td.depends_on_task_id AS depends_on_task_id
       FROM task_dependencies td
       JOIN tasks t ON t.id = td.task_id
      WHERE t.work_id = ?`,
    workId,
  );
  const graph = new Map<string, string[]>();
  for (const row of rows) {
    const list = graph.get(row.task_id) ?? [];
    list.push(row.depends_on_task_id);
    graph.set(row.task_id, list);
  }
  return graph;
}

/** Whether `fromTaskId` depends, directly or transitively, on `targetTaskId`. */
function dependsOnTransitively(graph: Map<string, string[]>, fromTaskId: string, targetTaskId: string): boolean {
  const seen = new Set<string>();
  const stack = [...(graph.get(fromTaskId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === targetTaskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(graph.get(current) ?? []));
  }
  return false;
}

/** `dir/name.<suffix>.ext` for a relative path, keeping the original extension. */
function withSuffix(relPath: string, suffix: string): string {
  const dir = dirname(relPath);
  const base = basename(relPath);
  const dotIndex = base.lastIndexOf(".");
  const stem = dotIndex > 0 ? base.slice(0, dotIndex) : base;
  const ext = dotIndex > 0 ? base.slice(dotIndex) : "";
  const named = `${stem}.${suffix}${ext}`;
  return dir === "." ? named : `${dir}/${named}`;
}

function taskShortId(taskId: string): string {
  return taskId.length > 8 ? taskId.slice(-8) : taskId;
}

/**
 * Claim `relPath` for `source` in `winners`, or resolve the clash: identical
 * content is a no-op, an allowed overwrite replaces the current winner, and
 * anything else is kept alongside as a conflict under `suffix` — the current
 * winner is never lost.
 */
function claimOrKeepAlongside(
  winners: Map<string, WinningFile>,
  conflicts: ConflictFile[],
  relPath: string,
  source: string,
  digest: { sha256: string; bytes: number },
  owner: Owner,
  allowOverwrite: boolean,
  suffix: string,
): void {
  const current = winners.get(relPath);
  if (!current) {
    winners.set(relPath, { source, owner, sha256: digest.sha256, bytes: digest.bytes });
    return;
  }
  if (current.sha256 === digest.sha256) return;
  if (allowOverwrite) {
    winners.set(relPath, { source, owner, sha256: digest.sha256, bytes: digest.bytes });
  } else {
    conflicts.push({ relPath: withSuffix(relPath, suffix), source, sha256: digest.sha256, bytes: digest.bytes });
  }
}

/**
 * Merge a Project-less Work's isolated Task workspaces into one human-browsable
 * outputs folder, then remove `.owl-workspaces/<workId>`. Nothing under the
 * workspace is discarded unsaved: completed Tasks' contents are merged first,
 * in the order the Tasks completed, and a Task overwrites a path only when it
 * depends (transitively) on whoever currently owns it there, or the content is
 * unchanged. Every other Task directory present (not completed — running,
 * failed, or cancelled), in the same completion-time order, and any leftover
 * directory that matches no Task of the Work at all, are then folded in the
 * same way but never overwrite anything: identical content is a no-op, and a
 * different version of a path already claimed is kept alongside it rather
 * than replacing it. Any existing outputs folder is the merge's starting
 * point, so a Work reopened and completed again keeps what an earlier pass
 * already saved.
 *
 * Every file is verified (size and sha256) against its source before the
 * result is swapped into place. Returns true once the workspace directory no
 * longer needs saving (nothing to do, or a save just completed); returns false
 * and leaves the workspace and any existing outputs folder untouched if the
 * save could not be completed, so a later reconcile pass retries it.
 */
export async function saveProjectlessWorkOutputs(deps: OutputsStoreDeps, workId: string): Promise<boolean> {
  if (safeSegment(workId) !== workId || workId === "." || workId === "..") return false;
  const workspaceDir = resolve(deps.owlRoot, ".owl-workspaces", safeSegment(workId));
  try {
    const workspaceRoot = resolve(deps.owlRoot, ".owl-workspaces");
    let rootInfo;
    try { rootInfo = await lstat(workspaceRoot); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(".owl-workspaces is not a plain directory.");
    let workspaceInfo;
    try { workspaceInfo = await lstat(workspaceDir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory()) throw new Error("The Work workspace is not a plain directory.");
  } catch (error) {
    console.warn(`[owl-core] Could not inspect workspace for Work ${workId}`, error);
    return false;
  }

  const outputsRoot = join(deps.dataDir, "outputs");
  const finalPath = join(outputsRoot, safeSegment(workId));
  const stagingPath = join(outputsRoot, `.${safeSegment(workId)}.staging-${randomUUID()}`);

  try {
    const allTasks = deps.db.all<{ id: string; status: string }>(
      "SELECT id, status FROM tasks WHERE work_id = ? ORDER BY updated_at ASC, id ASC",
      workId,
    );
    const completedTasks = allTasks.filter((task) => task.status === "completed");
    const otherTasks = allTasks.filter((task) => task.status !== "completed");
    const graph = loadDependsOn(deps.db, workId);
    const winners = new Map<string, WinningFile>();
    const conflicts: ConflictFile[] = [];

    if (await pathExists(finalPath)) {
      for (const relPath of await listFiles(finalPath)) {
        const source = join(finalPath, relPath);
        const digest = await fileDigest(source);
        winners.set(relPath, { source, owner: BASELINE_OWNER, sha256: digest.sha256, bytes: digest.bytes });
      }
    }

    for (const task of completedTasks) {
      const taskDir = join(workspaceDir, safeSegment(task.id));
      const files = await listFilesIfPresent(taskDir);
      for (const relPath of files) {
        const source = join(taskDir, relPath);
        const digest = await fileDigest(source);
        const current = winners.get(relPath);
        const allowOverwrite = current === undefined || current.owner === BASELINE_OWNER || dependsOnTransitively(graph, task.id, current.owner as string);
        claimOrKeepAlongside(winners, conflicts, relPath, source, digest, task.id, allowOverwrite, taskShortId(task.id));
      }
    }

    // A Task that never reached completed (still running, failed, or
    // cancelled) has no claim to overwrite anything; its files are still
    // saved, alongside whatever is already there, so nothing is lost.
    for (const task of otherTasks) {
      const taskDir = join(workspaceDir, safeSegment(task.id));
      const files = await listFilesIfPresent(taskDir);
      for (const relPath of files) {
        const source = join(taskDir, relPath);
        const digest = await fileDigest(source);
        claimOrKeepAlongside(winners, conflicts, relPath, source, digest, task.id, false, taskShortId(task.id));
      }
    }

    // A directory under the Work's workspace that matches no Task at all
    // (for example a leftover Manager or integration directory) is folded in
    // the same non-overwriting way rather than dropped.
    const knownDirNames = new Set(allTasks.map((task) => safeSegment(task.id)));
    const workspaceChildren = await readdir(workspaceDir, { withFileTypes: true });
    for (const child of workspaceChildren) {
      if (child.name === ".git" || knownDirNames.has(child.name)) continue;
      if (!child.isDirectory()) {
        const source = join(workspaceDir, child.name);
        const info = await lstat(source);
        if (info.isSymbolicLink() || !info.isFile()) continue;
        const digest = await fileDigest(source);
        claimOrKeepAlongside(winners, conflicts, child.name, source, digest, `root:${child.name}`, false, "workspace");
        continue;
      }
      const otherDir = join(workspaceDir, child.name);
      const files = await listFiles(otherDir);
      for (const relPath of files) {
        const source = join(otherDir, relPath);
        const digest = await fileDigest(source);
        claimOrKeepAlongside(winners, conflicts, relPath, source, digest, `dir:${child.name}`, false, safeSegment(child.name));
      }
    }

    await mkdir(stagingPath, { recursive: true });
    const copies = [
      ...[...winners.entries()].map(([relPath, entry]) => ({ relPath, ...entry })),
      ...conflicts,
    ];
    for (const copy of copies) {
      const destination = join(stagingPath, copy.relPath);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(copy.source, destination);
      const verified = await fileDigest(destination);
      if (verified.sha256 !== copy.sha256 || verified.bytes !== copy.bytes) {
        throw new Error(`Copied file ${copy.relPath} for Work ${workId} did not verify against its source.`);
      }
    }

    const backupPath = join(outputsRoot, `.${safeSegment(workId)}.previous-${randomUUID()}`);
    let hadExisting = false;
    try {
      await rename(finalPath, backupPath);
      hadExisting = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(stagingPath, finalPath);
    } catch (error) {
      if (hadExisting) await rename(backupPath, finalPath).catch(() => {});
      throw error;
    }
    if (hadExisting) await rm(backupPath, { recursive: true, force: true });

    await rm(workspaceDir, { recursive: true, force: true });
    return true;
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    console.warn(`[owl-core] Could not save outputs for Work ${workId}; its isolated workspaces are kept and will be retried`, error);
    return false;
  }
}

async function listFilesIfPresent(root: string): Promise<string[]> {
  try {
    return await listFiles(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
