import { loadFixContext } from "./context-builder.js";
import type { ContextReader } from "./context-builder.js";

/** Return non-terminal Tasks whose next attempt must continue in its isolated folder. */
export function fixPendingTaskIds(reader: ContextReader, workId: string): string[] {
  return reader.all<{ id: string; status: string; paused_from: string | null; worktree_path: string | null }>(
    "SELECT id, status, paused_from, worktree_path FROM tasks WHERE work_id = ? ORDER BY created_at, id",
    workId,
  ).filter((task) => {
    const status = task.status === "paused" ? task.paused_from : task.status;
    if (!task.worktree_path || status === "completed" || status === "cancelled") return false;
    return status === "review_fix_waiting" || loadFixContext(reader, task.id) !== null;
  }).map((task) => task.id);
}
