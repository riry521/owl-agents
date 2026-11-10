import type { CoreDatabase, CoreWriteLaneTransaction } from "./types.js";

export type ReplanMarkerStatus = "queued" | "attempted";

export interface ManagerReplanTrigger {
  readonly task_id: string;
  readonly status: ReplanMarkerStatus;
  readonly question: string | null;
  readonly question_only: boolean;
  readonly budget_recovery: boolean;
  readonly partial_recovery: boolean;
}

/** Every new failure re-queues the trigger with the flags reset; created_at keeps the first value. */
export function queueManagerTrigger(
  tx: CoreWriteLaneTransaction,
  taskId: string,
  trigger: { question: string | null; question_only: boolean },
  now: string,
): void {
  tx.run(
    `INSERT INTO manager_replan_triggers (task_id, status, question, question_only, created_at, updated_at)
     VALUES (?, 'queued', ?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       status = 'queued', question = excluded.question, question_only = excluded.question_only,
       budget_recovery = 0, partial_recovery = 0, updated_at = excluded.updated_at`,
    taskId,
    trigger.question,
    trigger.question_only ? 1 : 0,
    now,
    now,
  );
}

export function readManagerTrigger(db: Pick<CoreDatabase, "get">, taskId: string): ManagerReplanTrigger | undefined {
  const row = db.get<{
    task_id: string;
    status: ReplanMarkerStatus;
    question: string | null;
    question_only: number;
    budget_recovery: number;
    partial_recovery: number;
  }>(
    "SELECT task_id, status, question, question_only, budget_recovery, partial_recovery FROM manager_replan_triggers WHERE task_id = ?",
    taskId,
  );
  if (!row) return undefined;
  return {
    task_id: row.task_id,
    status: row.status,
    question: row.question,
    question_only: row.question_only === 1,
    budget_recovery: row.budget_recovery === 1,
    partial_recovery: row.partial_recovery === 1,
  };
}

/** Flag the Task's trigger; a missing row stays missing. */
export function flagManagerTrigger(
  tx: CoreWriteLaneTransaction,
  taskId: string,
  flag: "budget_recovery" | "partial_recovery",
  now: string,
): void {
  const column = flag === "budget_recovery" ? "budget_recovery" : "partial_recovery";
  tx.run(`UPDATE manager_replan_triggers SET ${column} = 1, updated_at = ? WHERE task_id = ?`, now, taskId);
}

/** With onlyWhen, only a row whose current status equals it changes. */
export function setManagerTriggerStatus(
  tx: CoreWriteLaneTransaction,
  taskId: string,
  status: ReplanMarkerStatus,
  now: string,
  onlyWhen?: ReplanMarkerStatus,
): void {
  if (onlyWhen === undefined) {
    tx.run("UPDATE manager_replan_triggers SET status = ?, updated_at = ? WHERE task_id = ?", status, now, taskId);
  } else {
    tx.run(
      "UPDATE manager_replan_triggers SET status = ?, updated_at = ? WHERE task_id = ? AND status = ?",
      status,
      now,
      taskId,
      onlyWhen,
    );
  }
}

/** Root-failed Tasks whose Manager trigger is still queued and no open Decision covers them. */
export function listQueuedReplanTasks(
  db: Pick<CoreDatabase, "all">,
  workId: string,
  quarantinePrefix: string,
): { id: string; question: string | null }[] {
  return db.all<{ id: string; question: string | null }>(
    `SELECT tasks.id AS id, mt.question AS question
       FROM tasks
       JOIN manager_replan_triggers AS mt ON mt.task_id = tasks.id
      WHERE tasks.work_id = ? AND tasks.status = 'failed'
        AND mt.status = 'queued'
        AND tasks.failed_by_dependency_task_id IS NULL
        AND COALESCE(tasks.manager_task_id, '') NOT LIKE ? || '%'
        AND NOT EXISTS (
          SELECT 1 FROM decisions
           WHERE decisions.work_id = tasks.work_id AND decisions.status = 'open'
             AND (decisions.scope = 'work'
                  OR EXISTS (SELECT 1 FROM json_each(decisions.blocked_task_ids_json) WHERE value = tasks.id))
        )
      ORDER BY tasks.created_at ASC, tasks.id ASC`,
    workId,
    quarantinePrefix,
  );
}

/** Startup recovery: a crash leaves a root-failed Task's trigger attempted with no replan in flight. Returns the rows moved back. */
export function requeueStuckManagerTriggers(tx: CoreWriteLaneTransaction, now: string): number {
  return tx.run(
    `UPDATE manager_replan_triggers SET status = 'queued', updated_at = ?
      WHERE status = 'attempted'
        AND EXISTS (
          SELECT 1 FROM tasks
            JOIN works ON works.id = tasks.work_id
           WHERE tasks.id = manager_replan_triggers.task_id
             AND tasks.status = 'failed'
             AND tasks.failed_by_dependency_task_id IS NULL
             AND works.state = 'running'
        )`,
    now,
  ).changes;
}

/** Same field names as the old marker JSON; a NULL column is an absent field (old shape). */
export interface OwnerReplanMarker {
  readonly status: ReplanMarkerStatus;
  readonly kind: string;
  readonly answer: string;
  readonly requests?: readonly unknown[];
  readonly message_ids: readonly string[];
  readonly processing_kind?: string;
  readonly processing_answer?: string;
  readonly processing_requests?: readonly unknown[];
  readonly processing_message_ids: readonly string[];
}

export function readOwnerReplan(db: Pick<CoreDatabase, "get">, workId: string): OwnerReplanMarker | undefined {
  const row = db.get<{
    status: ReplanMarkerStatus;
    kind: string;
    answer: string;
    requests_json: string | null;
    message_ids_json: string;
    processing_kind: string | null;
    processing_answer: string | null;
    processing_requests_json: string | null;
    processing_message_ids_json: string;
  }>(
    `SELECT status, kind, answer, requests_json, message_ids_json, processing_kind, processing_answer,
            processing_requests_json, processing_message_ids_json
       FROM owner_replan_requests WHERE work_id = ?`,
    workId,
  );
  if (!row) return undefined;
  return {
    status: row.status,
    kind: row.kind,
    answer: row.answer,
    ...(row.requests_json !== null ? { requests: JSON.parse(row.requests_json) as unknown[] } : {}),
    message_ids: JSON.parse(row.message_ids_json) as string[],
    ...(row.processing_kind !== null ? { processing_kind: row.processing_kind } : {}),
    ...(row.processing_answer !== null ? { processing_answer: row.processing_answer } : {}),
    ...(row.processing_requests_json !== null ? { processing_requests: JSON.parse(row.processing_requests_json) as unknown[] } : {}),
    processing_message_ids: JSON.parse(row.processing_message_ids_json) as string[],
  };
}

/** Always writes status queued; "keep" leaves an existing row alone. created_at keeps the first value on replace. */
export function writeOwnerReplan(
  tx: CoreWriteLaneTransaction,
  workId: string,
  marker: Omit<OwnerReplanMarker, "status">,
  mode: "replace" | "keep",
  now: string,
): void {
  const json = (value: readonly unknown[] | undefined) => (value === undefined ? null : JSON.stringify(value));
  const conflict = mode === "keep"
    ? "DO NOTHING"
    : `DO UPDATE SET status = 'queued', kind = excluded.kind, answer = excluded.answer, requests_json = excluded.requests_json,
         message_ids_json = excluded.message_ids_json, processing_kind = excluded.processing_kind,
         processing_answer = excluded.processing_answer, processing_requests_json = excluded.processing_requests_json,
         processing_message_ids_json = excluded.processing_message_ids_json, updated_at = excluded.updated_at`;
  tx.run(
    `INSERT INTO owner_replan_requests
       (work_id, status, kind, answer, requests_json, message_ids_json, processing_kind, processing_answer,
        processing_requests_json, processing_message_ids_json, created_at, updated_at)
     VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(work_id) ${conflict}`,
    workId,
    marker.kind,
    marker.answer,
    json(marker.requests),
    JSON.stringify(marker.message_ids),
    marker.processing_kind ?? null,
    marker.processing_answer ?? null,
    json(marker.processing_requests),
    JSON.stringify(marker.processing_message_ids),
    now,
    now,
  );
}

export function setOwnerReplanStatus(tx: CoreWriteLaneTransaction, workId: string, status: ReplanMarkerStatus, now: string): void {
  tx.run("UPDATE owner_replan_requests SET status = ?, updated_at = ? WHERE work_id = ?", status, now, workId);
}

export function clearOwnerReplanProcessing(tx: CoreWriteLaneTransaction, workId: string, now: string): void {
  tx.run(
    `UPDATE owner_replan_requests
        SET processing_kind = NULL, processing_answer = NULL, processing_requests_json = NULL,
            processing_message_ids_json = '[]', updated_at = ?
      WHERE work_id = ?`,
    now,
    workId,
  );
}

/** With onlyWhen, only a row whose current status equals it is deleted. */
export function deleteOwnerReplan(tx: CoreWriteLaneTransaction, workId: string, onlyWhen?: ReplanMarkerStatus): void {
  if (onlyWhen === undefined) tx.run("DELETE FROM owner_replan_requests WHERE work_id = ?", workId);
  else tx.run("DELETE FROM owner_replan_requests WHERE work_id = ? AND status = ?", workId, onlyWhen);
}

/** Startup recovery: every attempted Owner request goes back to queued. Returns the rows moved back. */
export function requeueAttemptedOwnerReplans(tx: CoreWriteLaneTransaction, now: string): number {
  return tx.run("UPDATE owner_replan_requests SET status = 'queued', updated_at = ? WHERE status = 'attempted'", now).changes;
}
