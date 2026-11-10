import type { CoreDatabase, CoreWriteLaneTransaction } from "./types";

export function isDesignHanded(db: Pick<CoreDatabase, "get">, taskId: string): boolean {
  return db.get("SELECT 1 FROM design_handoffs WHERE task_id = ?", taskId) !== undefined;
}

export function markDesignsHanded(transaction: CoreWriteLaneTransaction, taskIds: readonly string[], now: string): void {
  for (const taskId of taskIds) {
    transaction.run("INSERT OR IGNORE INTO design_handoffs (task_id, handed_at) VALUES (?, ?)", taskId, now);
  }
}
