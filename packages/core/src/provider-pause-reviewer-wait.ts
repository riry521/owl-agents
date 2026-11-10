import type { CoreDatabase, CoreWriteLaneTransaction } from "./types";

export interface PausedReviewerWait {
  readonly task_id: string;
  readonly provider: string;
}

export function recordPausedReviewerWait(
  transaction: CoreWriteLaneTransaction,
  taskId: string,
  provider: string,
  recordedAt: string,
): void {
  transaction.run(
    `INSERT INTO paused_reviewer_waits (task_id, provider, recorded_at) VALUES (?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET provider = excluded.provider, recorded_at = excluded.recorded_at`,
    taskId,
    provider,
    recordedAt,
  );
}

export function clearPausedReviewerWait(transaction: CoreWriteLaneTransaction, taskId: string): void {
  transaction.run("DELETE FROM paused_reviewer_waits WHERE task_id = ?", taskId);
}

export function readPausedReviewerWait(db: Pick<CoreDatabase, "get">, taskId: string): PausedReviewerWait | undefined {
  return db.get<PausedReviewerWait>("SELECT task_id, provider FROM paused_reviewer_waits WHERE task_id = ?", taskId);
}
