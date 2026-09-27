import type { CoreDatabase, CoreWriteLaneTransaction } from "./types";

const KEY_PREFIX = "paused-reviewer-wait:";
const NEVER_EXPIRES = "9999-12-31T23:59:59.999Z";

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
    `INSERT OR REPLACE INTO idempotency_keys
       (key, request_hash, response_json, status_code, created_at, expires_at)
     VALUES (?, ?, ?, 202, ?, ?)`,
    `${KEY_PREFIX}${taskId}`,
    "0".repeat(64),
    JSON.stringify({ task_id: taskId, provider }),
    recordedAt,
    NEVER_EXPIRES,
  );
}

export function clearPausedReviewerWait(transaction: CoreWriteLaneTransaction, taskId: string): void {
  transaction.run("DELETE FROM idempotency_keys WHERE key = ?", `${KEY_PREFIX}${taskId}`);
}

export function readPausedReviewerWait(db: Pick<CoreDatabase, "get">, taskId: string): PausedReviewerWait | undefined {
  const row = db.get<{ response_json: string }>(
    "SELECT response_json FROM idempotency_keys WHERE key = ?",
    `${KEY_PREFIX}${taskId}`,
  );
  if (!row) return undefined;
  try {
    const value: unknown = JSON.parse(row.response_json);
    if (
      value && typeof value === "object" && !Array.isArray(value) &&
      (value as Record<string, unknown>).task_id === taskId &&
      typeof (value as Record<string, unknown>).provider === "string" &&
      (value as Record<string, unknown>).provider !== ""
    ) {
      return value as PausedReviewerWait;
    }
  } catch {
    // An invalid marker must not hide a real Reviewer crash.
  }
  return undefined;
}
