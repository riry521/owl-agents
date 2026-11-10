import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, rename, unlink, writeFile } from "node:fs/promises";
import { createUlid, utcNow } from "../../db/dist/index.js";
import { validationError } from "./errors";
import { taskDependencyIds } from "./task-context.js";
import type { CoreDatabase, GitGateway } from "./types";

const MAX_CAPTURED_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_CAPTURED_ARTIFACT_FILE_BYTES = 10 * 1024 * 1024;

const WORKTREE_SNAPSHOT_MAX_ENTRIES = 100_000;
const WORKTREE_SNAPSHOT_MAX_KEPT_BYTES = 64 * 1024 * 1024;

export interface WorktreeEntry {
  hash: string;
  lines: number;
  binary: boolean;
  text?: string;
}

/** Whether `candidate` resolves to `base` itself or a path underneath it. */
function inside(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function mimeForPath(path: string): string {
  const extension = path.toLowerCase().split(".").pop();
  const types: Record<string, string> = {
    ts: "text/typescript", tsx: "text/tsx", js: "text/javascript", jsx: "text/jsx",
    json: "application/json", md: "text/markdown", txt: "text/plain", css: "text/css",
    html: "text/html", yaml: "text/yaml", yml: "text/yaml", png: "image/png", jpg: "image/jpeg",
  };
  return types[extension ?? ""] ?? "application/octet-stream";
}

export interface ArtifactCaptureDeps {
  readonly db: CoreDatabase;
  readonly writeLane: ReturnType<CoreDatabase["createWriteLane"]>;
  readonly git: GitGateway;
  readonly dataDir: string;
  readonly projectIdOf: (workId: string) => { project_id?: string };
}

/** Copies dependency artifacts into a worktree, records a Task's artifacts and snapshots worktrees. Split out of WorkflowEngine; behaviour is unchanged. */
export class ArtifactCapture {
  public constructor(private readonly deps: ArtifactCaptureDeps) {}

  /**
   * A Work without a Project has no shared git history to carry a
   * dependency's output into a dependent Task's isolated worktree, so a
   * dependent Task otherwise starts from an empty folder. Copy the latest
   * code/generated artifacts of this Task's completed direct dependencies
   * into its worktree, at the same relative path they were captured at.
   */
  public async materializeDependencyArtifacts(workId: string, taskId: string, worktreePath: string): Promise<void> {
    const work = this.deps.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId);
    if (work?.project_id) return;
    const dependsOn = taskDependencyIds(this.deps.db, taskId);
    if (dependsOn.length === 0) return;
    const taskPlaceholders = dependsOn.map(() => "?").join(",");
    const completed = this.deps.db.all<{ id: string }>(
      `SELECT id FROM tasks WHERE id IN (${taskPlaceholders}) AND status = 'completed'`,
      ...dependsOn,
    );
    if (completed.length === 0) return;
    const artifactPlaceholders = completed.map(() => "?").join(",");
    const artifacts = this.deps.db.all<{ path: string; storage_path: string; sha256: string; task_id: string }>(
      `SELECT a.path, a.storage_path, a.sha256, a.task_id
         FROM artifacts a
        WHERE a.task_id IN (${artifactPlaceholders}) AND a.kind IN ('code', 'generated')
          AND a.version_no = (
            SELECT MAX(version_no) FROM artifacts WHERE work_id = a.work_id AND task_id = a.task_id AND path = a.path
          )
        ORDER BY a.created_at ASC, a.id ASC`,
      ...completed.map((dependency) => dependency.id),
    );
    if (artifacts.length === 0) return;
    const root = resolve(worktreePath);
    for (const artifact of artifacts) {
      const destination = resolve(root, artifact.path);
      if (destination === root || !inside(root, destination)) continue;
      const contents = await readFile(artifact.storage_path).catch((error: NodeJS.ErrnoException) => {
        console.warn(`[owl-core] Task ${taskId}: dependency artifact ${artifact.path} from Task ${artifact.task_id} could not be read, so it is not copied into the worktree:`, error);
        return null;
      });
      if (!contents) continue;
      const existing = await lstat(destination).catch(() => null); // Why not log: an unreadable destination fails at the write below.
      if (existing?.isFile()) {
        const existingContents = await readFile(destination);
        if (createHash("sha256").update(existingContents).digest("hex") === artifact.sha256) continue;
        console.warn(`[owl-core] Task ${taskId}: the dependency artifact ${artifact.path} from Task ${artifact.task_id} overwrote a different copy already in the worktree.`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, contents);
    }
  }

  public async captureArtifacts(workId: string, taskId: string, agentRunId: string, worktreePath: string | null): Promise<void> {
    if (!worktreePath) return;
    const root = resolve(worktreePath);
    const files: Array<{ path: string; sha256: string; bytes: number; mime: string; contents: Buffer; storage_path: string }> = [];
    let capturedBytes = 0;
    const capture = async (absolute: string): Promise<void> => {
      const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") console.warn(`[owl-core] Task ${taskId}: artifact ${absolute} could not be inspected and is not recorded:`, error);
        return null;
      });
      if (!info?.isFile()) return;
      if (info.size > MAX_CAPTURED_ARTIFACT_FILE_BYTES || capturedBytes + info.size > MAX_CAPTURED_ARTIFACT_BYTES) {
        console.warn(`[owl-core] Task ${taskId}: artifact ${absolute} (${info.size} bytes) exceeds the capture size limit and is not recorded.`);
        return;
      }
      const contents = await readFile(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") console.warn(`[owl-core] Task ${taskId}: artifact ${absolute} could not be read and is not recorded:`, error);
        return null;
      });
      if (!contents) return;
      const relPath = relative(root, absolute).split("\\").join("/");
      const sha256 = createHash("sha256").update(contents).digest("hex");
      const storagePath = join(this.deps.dataDir, "artifacts", workId, taskId, sha256);
      files.push({
        path: relPath,
        sha256,
        bytes: contents.byteLength,
        mime: mimeForPath(relPath),
        contents,
        storage_path: storagePath,
      });
      capturedBytes += contents.byteLength;
    };
    const visit = async (directory: string): Promise<void> => {
      if (files.length >= 2000) return;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= 2000 || entry.name === ".git" || entry.name === "node_modules") continue;
        const absolute = resolve(directory, entry.name);
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) await visit(absolute);
        else await capture(absolute);
      }
    };
    // In a Git Task worktree the artifacts are the files this Task changed,
    // not the whole checkout it started from. A non-Git isolated workspace
    // holds only what the Task produced, so it is captured as a whole.
    const changed = await this.deps.git.changedPaths?.({ work_id: workId, task_id: taskId, worktree_path: root }) ?? null;
    if (changed === null) {
      await visit(root);
    } else {
      for (const path of changed) {
        if (files.length >= 2000) break;
        const absolute = resolve(root, path);
        if (absolute.startsWith(`${root}/`)) await capture(absolute);
      }
    }
    if (files.length === 0) return;

    // A Task worktree is removed after a successful review/merge. Archive
    // content-addressed bytes before recording the metadata so the artifact
    // row never points at a path that is about to disappear. The hash makes a
    // repeated capture safe; a mismatching pre-existing target is refused.
    const createdArchives: string[] = [];
    for (const file of files) {
      await mkdir(dirname(file.storage_path), { recursive: true, mode: 0o700 });
      const temporary = `${file.storage_path}.${createUlid()}.tmp`;
      try {
        await writeFile(temporary, file.contents, { flag: "wx", mode: 0o600 });
        await rename(temporary, file.storage_path);
        createdArchives.push(file.storage_path);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        const existing = await lstat(file.storage_path).catch(() => null);
        if (!existing?.isFile()) throw error;
        const existingContents = await readFile(file.storage_path);
        if (createHash("sha256").update(existingContents).digest("hex") !== file.sha256) {
          throw validationError("A durable artifact path already contains different content.", { storage_path: file.storage_path });
        }
      }
    }
    const now = utcNow();
    try {
      await this.deps.writeLane.write({
        mutateState: (transaction) => {
          let inserted = 0;
          for (const file of files) {
            // Scoped by work_id and path/sha256 only (not task_id): a file a
            // dependency's artifacts already cover, and that
            // materializeDependencyArtifacts copied into this Task's
            // worktree unchanged, is not this Task's own artifact.
            const exists = transaction.get<{ id: string }>(
              "SELECT id FROM artifacts WHERE work_id = ? AND path = ? AND sha256 = ? LIMIT 1",
              workId,
              file.path,
              file.sha256,
            );
            if (exists) continue;
            const version = transaction.get<{ version_no: number }>(
              "SELECT COALESCE(MAX(version_no), 0) AS version_no FROM artifacts WHERE work_id = ? AND task_id = ? AND path = ?",
              workId,
              taskId,
              file.path,
            );
            transaction.run(
              `INSERT INTO artifacts
                 (id, work_id, task_id, path, kind, deliverable, sha256, bytes, mime, commit_ref, source_event_id, version_no, created_at, storage_path)
               VALUES (?, ?, ?, ?, 'generated', 1, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
              createUlid(),
              workId,
              taskId,
              file.path,
              file.sha256,
              file.bytes,
              file.mime,
              Number(version?.version_no ?? 0) + 1,
              now,
              file.storage_path,
            );
            inserted += 1;
          }
          return { work_id: workId, task_id: taskId, artifact_count: inserted };
        },
        event: {
          // One capture per Worker run: a fix round that leaves the files as
          // they were captures the same contents again.
          idempotencyKey: `artifacts-captured:${taskId}:${agentRunId}`,
          type: "artifact.created",
          workId,
          taskId,
          payload: { work_id: workId, task_id: taskId, artifact_count: files.length, paths: files.map((file) => file.path) },
        },
        outbox: [{ provider: "websocket" }],
      });
    } catch (error) {
      await Promise.all(createdArchives.map((path) => unlink(path).catch(() => undefined)));
      throw error;
    }
  }

  /**
   * Snapshot of every entry under a Project-less Task worktree (symlinks and node_modules included, only the top-level .git
   * skipped), independent of artifact capture limits. Contents are kept for small text files so edits can be counted by line.
   */
  public async snapshotWorktree(root: string): Promise<Map<string, WorktreeEntry>> {
    const entries = new Map<string, WorktreeEntry>();
    let keptBytes = 0;
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (directory === root && entry.name === ".git") continue;
        const absolute = resolve(directory, entry.name);
        const info = await lstat(absolute);
        const path = relative(root, absolute).split("\\").join("/");
        if (info.isDirectory()) {
          await visit(absolute);
          continue;
        }
        if (entries.size >= WORKTREE_SNAPSHOT_MAX_ENTRIES) throw new Error(`more than ${WORKTREE_SNAPSHOT_MAX_ENTRIES} entries`);
        if (info.isSymbolicLink()) {
          entries.set(path, { hash: `link:${await readlink(absolute)}`, lines: 0, binary: true });
        } else if (info.isFile()) {
          const contents = await readFile(absolute);
          const binary = contents.includes(0);
          const text = binary ? "" : contents.toString("utf8");
          const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
          const keep = !binary && keptBytes + contents.byteLength <= WORKTREE_SNAPSHOT_MAX_KEPT_BYTES;
          if (keep) keptBytes += contents.byteLength;
          entries.set(path, { hash: createHash("sha256").update(contents).digest("hex"), lines, binary, ...(keep ? { text } : {}) });
        } else {
          entries.set(path, { hash: `special:${info.mode}`, lines: 0, binary: true });
        }
      }
    };
    await visit(root);
    return entries;
  }
}
