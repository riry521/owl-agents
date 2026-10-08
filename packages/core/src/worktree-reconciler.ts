import { lstat, rm, rmdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { WriteLane } from "../../db/dist/index.js";
import { isTerminalTaskState, reduceTaskInTransaction } from "./state-reducer.js";
import { saveProjectlessWorkOutputs } from "./outputs-store.js";
import { safeSegment, WorkspaceLayout } from "./workspace-layout.js";
import type { CoreDatabase, CoreWriteLaneTransaction, GitGateway, GitOperationResult, WorktreeCleanupResult, WorkspaceEntry } from "./types";

const ACTIVE_AGENT_RUN_STATUSES_SQL = "'launch_pending','spawned','running','cancel_requested'";
/** Startup can meet an unbounded number of leftovers; bound the worktree
 * removals awaited during one `Core.start()` so a very dirty install still
 * starts promptly. Anything past this is left for the next reconcile pass. */
const MAX_STARTUP_REMOVALS = 200;

export interface WorktreeReconcilerDeps {
  readonly db: CoreDatabase;
  readonly writeLane: WriteLane;
  readonly git: GitGateway;
  /** Root directory holding the legacy `.owl-workspaces`; required to save a Project-less Work's outputs. */
  readonly owlRoot: string;
  /** Root directory holding `outputs/`; required to save a Project-less Work's outputs. */
  readonly dataDir: string;
  /** Resolves Work/Task/integration workspace paths. Defaults to the legacy `<owlRoot>/.owl-workspaces` layout. */
  readonly layout?: WorkspaceLayout;
}

function layoutOf(deps: WorktreeReconcilerDeps): WorkspaceLayout {
  return deps.layout ?? WorkspaceLayout.legacyOnly(deps.owlRoot);
}

export interface WorktreeReconcileScope {
  /** Reconcile only this Work's Task/integration worktrees; omit to scan the whole `.owl-workspaces` tree (startup). */
  readonly work_id?: string;
  /** Short label for logging; not persisted. */
  readonly reason: string;
}

export interface WorktreeReconcileResult {
  readonly discarded: readonly string[];
  readonly skipped: readonly string[];
  readonly failures?: readonly WorktreeReconcileFailure[];
}

export interface WorktreeReconcileFailure {
  readonly work_id: string;
  readonly path: string;
  readonly message: string;
}

/** Prepare every disk/Git resource while the Work rows are still available. */
export async function cleanupWorkForDeletion(
  deps: WorktreeReconcilerDeps,
  workId: string,
): Promise<WorktreeCleanupResult> {
  const work = deps.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId);
  if (!work) return { ok: false, message: `Work ${workId} was not found.`, details: { work_id: workId, stage: "work_lookup" } };
  const workDir = layoutOf(deps).workDir(workId);
  if (work.project_id !== null) {
    try { return await deps.git.deleteWorkWorkspaces({ work_id: workId }); }
    catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        details: { path: workDir, stage: "git_workspace_cleanup" },
      };
    }
  }
  try {
    const saved = await saveProjectlessWorkOutputs(deps, workId);
    return saved
      ? { ok: true, message: "Project-less Work outputs were saved and the workspace was removed." }
      : { ok: false, message: "Project-less Work outputs could not be saved and verified.", details: { path: workDir, stage: "projectless_output_save" } };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      details: { path: workDir, stage: "projectless_output_save" },
    };
  }
}

interface CandidateTask {
  readonly id: string;
  readonly work_id: string;
  readonly type: string;
  readonly worktree_path: string;
  readonly worker_generation: number;
}

/**
 * Run one Git removal, turning a thrown error (for example a Project directory
 * that no longer exists) into a failed result, so a single broken Project
 * cannot stop the reconcile of every other worktree.
 */
async function gitResult(path: string, operation: () => Promise<GitOperationResult>): Promise<GitOperationResult> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, exit_code: 1, recorded: false, worktree_path: path, message };
  }
}

function activeRunCount(reader: Pick<CoreDatabase, "get">, taskId: string): number {
  return reader.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM agent_runs WHERE task_id = ? AND status IN (${ACTIVE_AGENT_RUN_STATUSES_SQL})`,
    taskId,
  )?.count ?? 0;
}

function activeRunCountForWork(reader: Pick<CoreDatabase, "get">, workId: string): number {
  return reader.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM agent_runs WHERE work_id = ? AND status IN (${ACTIVE_AGENT_RUN_STATUSES_SQL})`,
    workId,
  )?.count ?? 0;
}

/**
 * Candidate Task worktrees: a Task whose worktree is still `active` or
 * `conflict_retained` and is either itself cancelled (a superseded Task, or
 * an ordinary cancel) or terminal while its Work has finished (cancelled or
 * completed). A non-terminal Task, or one whose Work is still running or
 * paused, is never a candidate.
 */
function candidateTasks(db: CoreDatabase, workId: string | undefined): readonly CandidateTask[] {
  return db.all<CandidateTask>(
    `SELECT tasks.id AS id, tasks.work_id AS work_id, tasks.type AS type, tasks.worktree_path AS worktree_path, tasks.worker_generation AS worker_generation
       FROM tasks
       JOIN works ON works.id = tasks.work_id
      WHERE tasks.worktree_path IS NOT NULL
        AND tasks.worktree_state IN ('active', 'conflict_retained')
        AND (
          tasks.status = 'cancelled'
          OR (works.state IN ('cancelled', 'completed') AND tasks.status IN ('completed', 'failed', 'cancelled'))
        )
        AND NOT (
          works.state = 'completed'
          AND works.project_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM events
             WHERE events.work_id = works.id AND events.type = 'work.completed'
               AND json_extract(events.payload_json, '$.merge') IS NOT NULL
          )
        )
        AND (? IS NULL OR tasks.work_id = ?)
      ORDER BY tasks.created_at ASC, tasks.id ASC`,
    workId ?? null,
    workId ?? null,
  );
}

function isCompletedMergedProjectWork(db: Pick<CoreDatabase, "get">, workId: string): boolean {
  const row = db.get<{ state: string; project_id: string | null; has_merge: number }>(
    `SELECT works.state AS state, works.project_id AS project_id,
            EXISTS (SELECT 1 FROM events
                     WHERE events.work_id = works.id AND events.type = 'work.completed'
                       AND json_extract(events.payload_json, '$.merge') IS NOT NULL) AS has_merge
       FROM works WHERE works.id = ?`,
    workId,
  );
  return row?.state === "completed" && row.project_id !== null && row.has_merge === 1;
}

/**
 * Merged Works that may still hold leftovers: their branches were not deleted
 * yet, or `entries` still lists one of their workspaces.
 */
function completedMergedProjectWorkIds(db: CoreDatabase, entries: readonly WorkspaceEntry[] = []): readonly string[] {
  const listedWorkIds = new Set(entries.map((entry) => entry.work_id));
  return db.all<{ id: string; branches_deleted: number }>(
    `SELECT works.id AS id,
            EXISTS (SELECT 1 FROM events
                     WHERE events.work_id = works.id AND events.type = 'work.branches_deleted') AS branches_deleted
       FROM works
      WHERE works.state = 'completed' AND works.project_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM events
                     WHERE events.work_id = works.id AND events.type = 'work.completed'
                       AND json_extract(events.payload_json, '$.merge') IS NOT NULL)`,
  ).filter((row) => row.branches_deleted !== 1 || listedWorkIds.has(safeSegment(row.id))).map((row) => row.id);
}

/** Record `task.worktree.discarded` for a Task whose worktree was already removed on disk. */
async function recordDiscarded(
  deps: WorktreeReconcilerDeps,
  workId: string,
  taskId: string,
  workerGeneration: number,
  worktreePath: string,
): Promise<void> {
  try {
    await deps.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        if (activeRunCount(transaction, taskId) > 0) {
          // An agent run started between the pre-check and this transaction.
          // The worktree is already gone (removed below), but the Task keeps
          // its previous worktree_state; the next reconcile pass will not
          // pick it up as a candidate any more, so this is a rare, harmless
          // audit gap rather than a correctness problem.
          throw new Error(`Task ${taskId} gained an active agent run while its worktree was being discarded.`);
        }
        return reduceTaskInTransaction(transaction, taskId, {
          event: "task.worktree.discarded",
          payload: { no_active_run: true, ...(isCompletedMergedProjectWork(transaction, workId) ? { merged_work_completed: true } : {}) },
        });
      },
      event: {
        idempotencyKey: `worktree-discarded:${taskId}:${workerGeneration}`,
        type: "task.worktree.discarded",
        workId,
        taskId,
        payload: { task_id: taskId, worktree_path: worktreePath },
      },
      outbox: [{ provider: "websocket" }],
    });
  } catch (error) {
    console.warn(`[owl-core] Worktree reconcile removed Task ${taskId}'s worktree but could not record it; it will be retried`, error);
  }
}

/**
 * Remove the Work's directory once its Task and integration worktrees are
 * gone. Uses rmdir, which only ever removes an empty directory; ENOENT
 * (already gone) and ENOTEMPTY (something still lives there) are both
 * expected outcomes, not failures. Never touches the `advisor` directory
 * under a workspaces root, which this path does not resolve to.
 */
async function removeWorkDirectoryIfEmpty(layout: WorkspaceLayout, workId: string): Promise<void> {
  const path = layout.workDir(workId);
  try {
    await rmdir(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") {
      console.warn(`[owl-core] Worktree reconcile could not remove the empty Work directory for ${workId}`, error);
    }
  }
}

/** Discard one candidate Task's worktree. Returns false (skip) without touching anything if an agent run is active. */
async function discardCandidate(deps: WorktreeReconcilerDeps, task: CandidateTask): Promise<boolean> {
  if (activeRunCount(deps.db, task.id) > 0) return false;
  const result = await gitResult(task.worktree_path, () => deps.git.discardTaskWorktree({
    work_id: task.work_id,
    task_id: task.id,
    worktree_path: task.worktree_path,
    discard_changes: task.type === "design",
  }));
  if (!result.ok) {
    console.warn(`[owl-core] Worktree reconcile could not discard Task ${task.id}'s worktree: ${result.message}`);
    return false;
  }
  await recordDiscarded(deps, task.work_id, task.id, task.worker_generation, task.worktree_path);
  return true;
}

/**
 * Force-remove every workspace of a Work whose merge into the base branch is
 * recorded: Task worktrees whatever their state, the `__work__` integration
 * worktree, then `.owl-workspaces/<workId>` itself. Nothing is committed first;
 * the branches keep the merged content. A Task with an active agent run is
 * left in place and reported as a failure.
 */
async function discardMergedWorkspaces(
  deps: WorktreeReconcilerDeps,
  workId: string,
  entries: readonly WorkspaceEntry[],
  discarded: string[],
  skipped: string[],
  failures: WorktreeReconcileFailure[],
): Promise<void> {
  const layout = layoutOf(deps);
  const workRoot = layout.workDir(workId);
  // `present` marks a workspace that is listed or still on disk; only a Task
  // still holding its worktree, or whose workspace is present, is relabelled
  // discarded, so a Task whose worktree was merged normally keeps that state.
  const workEntries: (WorkspaceEntry & { readonly present: boolean })[] = entries
    .filter((entry) => entry.work_id === safeSegment(workId))
    .map((entry) => ({ ...entry, present: true }));
  const listedTaskIds = new Set(workEntries.flatMap((entry) => entry.task_id === null ? [] : [entry.task_id]));
  for (const task of deps.db.all<{ id: string; worktree_path: string; worktree_state: string | null }>(
    "SELECT id, worktree_path, worktree_state FROM tasks WHERE work_id = ? AND worktree_path IS NOT NULL",
    workId,
  )) {
    if (listedTaskIds.has(task.id)) continue;
    const onDisk = await pathExists(task.worktree_path);
    if (onDisk || task.worktree_state === "active" || task.worktree_state === "conflict_retained") {
      workEntries.push({ work_id: safeSegment(workId), task_id: task.id, path: task.worktree_path, present: onDisk });
    }
  }
  if (!workEntries.some((entry) => basename(entry.path) === "__work__")) {
    workEntries.push({
      work_id: safeSegment(workId),
      task_id: null,
      path: resolve(workRoot, "__work__"),
      present: false,
    });
  }
  const previousFailureCount = failures.length;
  for (const entry of workEntries) {
    if (entry.task_id !== null && activeRunCount(deps.db, entry.task_id) > 0) {
      const message = `Task ${entry.task_id} has an active agent run in worktree ${entry.path}.`;
      skipped.push(entry.path);
      failures.push({ work_id: workId, path: entry.path, message });
      console.warn(`[owl-core] Worktree reconcile left merged Work workspace ${entry.path} in place: ${message}`);
      continue;
    }
    const result = await gitResult(entry.path, () => basename(entry.path) === "__work__"
      ? deps.git.removeMergedIntegrationWorktree({ work_id: workId })
      : deps.git.discardMergedWorktree({ work_id: workId, task_id: entry.task_id, worktree_path: entry.path }));
    if (!result.ok) {
      skipped.push(entry.path);
      failures.push({ work_id: workId, path: entry.path, message: result.message });
      console.warn(`[owl-core] Worktree reconcile could not discard merged Work workspace ${entry.path}: ${result.message}`);
      continue;
    }

    if (entry.task_id !== null) {
      const task = deps.db.get<{ id: string; worker_generation: number; worktree_state: string | null }>(
        "SELECT id, worker_generation, worktree_state FROM tasks WHERE id = ? AND work_id = ?",
        entry.task_id,
        workId,
      );
      const holdsWorktree = task?.worktree_state === "active" || task?.worktree_state === "conflict_retained";
      if (task && task.worktree_state !== "discarded" && (holdsWorktree || entry.present)) {
        await recordDiscarded(deps, workId, task.id, task.worker_generation, entry.path);
      }
      discarded.push(entry.task_id);
    } else if (basename(entry.path) !== "__work__") {
      discarded.push(entry.path);
    }
  }

  if (failures.length !== previousFailureCount) return;
  const refusal = !isCompletedMergedProjectWork(deps.db, workId)
    ? `Work ${workId} is no longer completed with a recorded merge.`
    : layout.rootOf(workRoot) === null || [".", "..", "advisor", "nightly", "test-baseline"].includes(basename(workRoot))
      ? `${workRoot} is not a Work directory under a workspaces root.`
      : null;
  if (refusal !== null) {
    skipped.push(workRoot);
    failures.push({ work_id: workId, path: workRoot, message: refusal });
    console.warn(`[owl-core] Worktree reconcile did not remove merged Work directory ${workRoot}: ${refusal}`);
    return;
  }
  try {
    await rm(workRoot, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    skipped.push(workRoot);
    failures.push({ work_id: workId, path: workRoot, message });
    console.warn(`[owl-core] Worktree reconcile could not remove merged Work directory ${workRoot}: ${message}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function reconcileResult(
  discarded: readonly string[],
  skipped: readonly string[],
  failures: readonly WorktreeReconcileFailure[],
): WorktreeReconcileResult {
  return failures.length > 0 ? { discarded, skipped, failures } : { discarded, skipped };
}

/**
 * Idempotently remove worktrees that no longer belong to any in-progress
 * work: a superseded/cancelled Task's own worktree, and a finished Work's
 * `__work__` integration worktree. Every removal commits uncommitted changes
 * to the Task branch first (see GitGateway.discardTaskWorktree), except for a
 * design Task, whose changes are discarded, and a completed Work whose merge
 * is recorded, whose workspaces are force-removed without committing (see
 * discardMergedWorkspaces); branches are never deleted here. Safe to call
 * repeatedly and from multiple call sites: a Task or Work not (yet) eligible
 * is left untouched and picked up later.
 */
export async function reconcileWorktrees(
  deps: WorktreeReconcilerDeps,
  scope: WorktreeReconcileScope,
): Promise<WorktreeReconcileResult> {
  const discarded: string[] = [];
  const skipped: string[] = [];
  const failures: WorktreeReconcileFailure[] = [];

  if (scope.work_id !== undefined && isCompletedMergedProjectWork(deps.db, scope.work_id)) {
    let entries: readonly WorkspaceEntry[];
    try {
      entries = await deps.git.listWorkspaces();
    } catch (error) {
      const path = layoutOf(deps).workDir(scope.work_id);
      const message = error instanceof Error ? error.message : String(error);
      return reconcileResult(discarded, [path], [{ work_id: scope.work_id, path, message }]);
    }
    await discardMergedWorkspaces(deps, scope.work_id, entries, discarded, skipped, failures);
    return reconcileResult(discarded, skipped, failures);
  }

  for (const task of candidateTasks(deps.db, scope.work_id)) {
    (await discardCandidate(deps, task) ? discarded : skipped).push(task.id);
  }

  if (scope.work_id !== undefined) {
    const work = deps.db.get<{ state: string; project_id: string | null }>(
      "SELECT state, project_id FROM works WHERE id = ?",
      scope.work_id,
    );
    if (work && (work.state === "cancelled" || work.state === "completed")) {
      if (work.project_id === null) {
        if (activeRunCountForWork(deps.db, scope.work_id) === 0) {
          await saveProjectlessWorkOutputs(deps, scope.work_id);
        }
      } else {
        const workId = scope.work_id;
        const removal = await gitResult(layoutOf(deps).workDir(workId), () => deps.git.removeIntegrationWorktree({ work_id: workId }));
        if (!removal.ok) {
          console.warn(`[owl-core] Worktree reconcile could not remove the integration worktree for Work ${scope.work_id}: ${removal.message}`);
        } else if (activeRunCountForWork(deps.db, scope.work_id) === 0) {
          await discardWorkLeftovers(deps, scope.work_id, discarded, skipped);
        }
      }
      await removeWorkDirectoryIfEmpty(layoutOf(deps), scope.work_id);
    }
    return reconcileResult(discarded, skipped, failures);
  }

  await reconcileStartupWorkspaces(deps, discarded, skipped, failures);
  return reconcileResult(discarded, skipped, failures);
}

/**
 * Remove whatever is still under a finished Work's directory once nothing is
 * running for it: a Manager workspace, or a Task directory the read-model no
 * longer tracks. Changes are committed to their branch before removal.
 */
async function discardWorkLeftovers(deps: WorktreeReconcilerDeps, workId: string, discarded: string[], skipped: string[]): Promise<void> {
  let entries: readonly WorkspaceEntry[];
  try {
    entries = (await deps.git.listWorkspaces()).filter((entry) => entry.work_id === safeSegment(workId) && basename(entry.path) !== "__work__");
  } catch (error) {
    console.warn(`[owl-core] Worktree reconcile could not list the workspaces of Work ${workId}`, error);
    return;
  }
  for (const entry of entries) {
    const result = await gitResult(entry.path, () => deps.git.discardTaskWorktree({ work_id: workId, task_id: entry.task_id, worktree_path: entry.path }));
    if (result.ok) {
      discarded.push(entry.path);
    } else {
      skipped.push(entry.path);
      console.warn(`[owl-core] Worktree reconcile could not discard ${entry.path}: ${result.message}`);
    }
  }
}

/**
 * Full filesystem scan (no Work scope): reclaim directories the read-model
 * above cannot see, because their Task row is missing, already marked
 * merged/discarded. Directories of a Work with no row here belong to another
 * Owl instance sharing the workspaces root and are left untouched.
 */
async function reconcileStartupWorkspaces(
  deps: WorktreeReconcilerDeps,
  discarded: string[],
  skipped: string[],
  failures: WorktreeReconcileFailure[],
): Promise<void> {
  let entries: readonly WorkspaceEntry[];
  try {
    entries = await deps.git.listWorkspaces();
  } catch (error) {
    console.warn("[owl-core] Worktree reconcile could not list the workspaces directories", error);
    const message = error instanceof Error ? error.message : String(error);
    for (const workId of completedMergedProjectWorkIds(deps.db)) {
      const path = layoutOf(deps).workDir(workId);
      skipped.push(path);
      failures.push({ work_id: workId, path, message });
    }
    return;
  }
  entries = entries.filter((entry) => deps.db.get("SELECT 1 FROM works WHERE id = ?", entry.work_id) !== undefined);

  // A Project-less Work left over from before a restart is saved and removed
  // as a whole, ahead of the per-entry loop below (which only ever discards
  // one Task's worktree at a time and never removes a Work's own directory).
  const mergedWorkIds = completedMergedProjectWorkIds(deps.db, entries);
  const workIds = new Set([...entries.map((entry) => entry.work_id), ...mergedWorkIds.map(safeSegment)]);
  const handledWorkIds = new Set<string>();
  for (const workId of mergedWorkIds) {
    await discardMergedWorkspaces(deps, workId, entries, discarded, skipped, failures);
    handledWorkIds.add(safeSegment(workId));
  }
  entries = entries.filter((entry) => !handledWorkIds.has(entry.work_id));

  for (const workId of workIds) {
    const work = deps.db.get<{ state: string; project_id: string | null }>("SELECT state, project_id FROM works WHERE id = ?", workId);
    if (!work || work.project_id !== null) continue;
    if (work.state !== "cancelled" && work.state !== "completed") continue;
    if (activeRunCountForWork(deps.db, workId) > 0) continue;
    const saved = await saveProjectlessWorkOutputs(deps, workId);
    (saved ? discarded : skipped).push(`${workId}:outputs`);
    if (saved) handledWorkIds.add(workId);
  }
  entries = entries.filter((entry) => !handledWorkIds.has(entry.work_id));

  let removals = 0;
  const budgetLeft = () => removals < MAX_STARTUP_REMOVALS;
  const stopWarning = () =>
    console.warn(`[owl-core] Worktree reconcile stopped after ${MAX_STARTUP_REMOVALS} removals at startup; the rest are retried on the next reconcile.`);

  for (const entry of entries) {
    if (basename(entry.path) === "__work__") {
      const work = deps.db.get<{ state: string }>("SELECT state FROM works WHERE id = ?", entry.work_id);
      if (!work || work.state !== "cancelled" && work.state !== "completed") continue;
      if (!budgetLeft()) { stopWarning(); break; }
      removals += 1;
      const removal = await gitResult(entry.path, () => deps.git.removeIntegrationWorktree({ work_id: entry.work_id }));
      (removal.ok ? discarded : skipped).push(`${entry.work_id}:__work__`);
      continue;
    }

    if (entry.task_id === null) {
      // A non-Task, non-integration directory (for example a leftover
      // Manager workspace) with no Task row to guard it. Only reclaimed
      // once nothing at all is active for its Work.
      if (activeRunCountForWork(deps.db, entry.work_id) > 0) { skipped.push(entry.path); continue; }
      if (!budgetLeft()) { stopWarning(); break; }
      removals += 1;
      const result = await gitResult(entry.path, () => deps.git.discardTaskWorktree({ work_id: entry.work_id, task_id: null, worktree_path: entry.path }));
      (result.ok ? discarded : skipped).push(entry.path);
      continue;
    }

    const task = deps.db.get<{ id: string; type: string; status: string; worktree_state: string | null; worker_generation: number }>(
      "SELECT id, type, status, worktree_state, worker_generation FROM tasks WHERE id = ?",
      entry.task_id,
    );
    const work = deps.db.get<{ state: string }>("SELECT state FROM works WHERE id = ?", entry.work_id);
    const orphaned = task === undefined;
    const leftoverAfterDiscard = task !== undefined && (task.worktree_state === "merged" || task.worktree_state === "discarded");
    const terminalIdle =
      task !== undefined &&
      isTerminalTaskState(task.status) &&
      (task.status === "cancelled" || (work !== undefined && (work.state === "cancelled" || work.state === "completed"))) &&
      activeRunCount(deps.db, task.id) === 0;
    if (!orphaned && !leftoverAfterDiscard && !terminalIdle) continue;

    if (!budgetLeft()) { stopWarning(); break; }
    removals += 1;
    const result = await gitResult(entry.path, () => deps.git.discardTaskWorktree({
      work_id: entry.work_id,
      task_id: entry.task_id,
      worktree_path: entry.path,
      discard_changes: task?.type === "design",
    }));
    if (!result.ok) {
      skipped.push(entry.task_id);
      console.warn(`[owl-core] Worktree reconcile could not discard ${entry.path}: ${result.message}`);
      continue;
    }
    if (task !== undefined && task.worktree_state !== "discarded") {
      await recordDiscarded(deps, entry.work_id, entry.task_id, task.worker_generation, entry.path);
    }
    discarded.push(entry.task_id);
  }

  // Once every leftover under each Work has been handled above (or already
  // removed as a whole for a Project-less Work), a terminal Work's own
  // directory is reclaimed too, if it is now empty.
  for (const workId of workIds) {
    const work = deps.db.get<{ state: string }>("SELECT state FROM works WHERE id = ?", workId);
    if (!work || (work.state !== "cancelled" && work.state !== "completed")) continue;
    await removeWorkDirectoryIfEmpty(layoutOf(deps), workId);
  }
}
