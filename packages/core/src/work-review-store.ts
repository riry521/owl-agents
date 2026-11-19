import type { CoreDatabase, CoreWriteLaneTransaction, JsonObject } from "./types";
import type { WorkReviewFinding } from "./work-review-material";

/** Where the whole-Work review's writes go: the same write lane the other stores use. */
export interface WorkReviewWriteLane {
  write(request: {
    mutateState: (transaction: CoreWriteLaneTransaction) => void;
    event: { idempotencyKey: string; type: string; workId: string; payload: JsonObject };
    outbox: readonly { provider: string }[];
  }): Promise<unknown>;
}

export interface StoredWorkReview {
  readonly agent_run_id: string;
  readonly round: number;
  readonly work_commit: string;
  readonly base_commit: string | null;
  readonly status: "passed" | "gaps" | "error";
  readonly routed_to: "manager" | "final_manager";
  readonly summary: string;
  readonly findings: readonly WorkReviewFinding[];
  readonly message: string | null;
}

export const WORK_REVIEW_SCHEMA_VERSION = "1.0.0";

type Reader = Pick<CoreDatabase, "get">;

const COMPLETED = "work.review_completed";

/** The completed-review count since the Owner's last decision; a new decision starts the count again. */
export function reviewsSinceDecision(db: Reader, workId: string): number {
  return db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events
      WHERE work_id = ? AND type = '${COMPLETED}'
        AND sequence > COALESCE((SELECT MAX(sequence) FROM events WHERE work_id = ? AND type = 'decision.resolved'), 0)`,
    workId,
    workId,
  )?.n ?? 0;
}

function toStored(row: { payload_json: string } | undefined): StoredWorkReview | null {
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload_json) as Partial<StoredWorkReview>;
    if (typeof payload.agent_run_id !== "string" || typeof payload.work_commit !== "string") return null;
    return {
      agent_run_id: payload.agent_run_id,
      round: typeof payload.round === "number" ? payload.round : 1,
      work_commit: payload.work_commit,
      base_commit: typeof payload.base_commit === "string" ? payload.base_commit : null,
      status: payload.status === "gaps" || payload.status === "error" ? payload.status : "passed",
      routed_to: payload.routed_to === "manager" ? "manager" : "final_manager",
      summary: typeof payload.summary === "string" ? payload.summary : "",
      findings: Array.isArray(payload.findings) ? payload.findings : [],
      message: typeof payload.message === "string" ? payload.message : null,
    };
  } catch {
    return null;
  }
}

/** The latest review recorded for this Work commit; decides whether the review runs again. */
export function reviewForCommit(db: Reader, workId: string, commit: string): StoredWorkReview | null {
  return toStored(db.get<{ payload_json: string }>(
    `SELECT payload_json FROM events
      WHERE work_id = ? AND type = '${COMPLETED}' AND json_extract(payload_json, '$.work_commit') = ?
      ORDER BY sequence DESC LIMIT 1`,
    workId,
    commit,
  ));
}

/** The review one agent run recorded; the Manager's replan reads its findings from here, so a retry sees the same content. */
export function reviewByRun(db: Reader, workId: string, agentRunId: string): StoredWorkReview | null {
  return toStored(db.get<{ payload_json: string }>(
    `SELECT payload_json FROM events
      WHERE work_id = ? AND type = '${COMPLETED}' AND idempotency_key = ?`,
    workId,
    `work-review-completed:${agentRunId}`,
  ));
}

/** The latest review that produced a result (an error has no findings), for the next round's previous_findings. */
export function previousReview(db: Reader, workId: string): StoredWorkReview | null {
  return toStored(db.get<{ payload_json: string }>(
    `SELECT payload_json FROM events
      WHERE work_id = ? AND type = '${COMPLETED}' AND json_extract(payload_json, '$.status') <> 'error'
      ORDER BY sequence DESC LIMIT 1`,
    workId,
  ));
}

export function isReviewHanded(db: Reader, workId: string, agentRunId: string): boolean {
  return db.get(
    "SELECT 1 FROM events WHERE work_id = ? AND type = 'work.review_handed' AND idempotency_key = ?",
    workId,
    `work-review-handed:${agentRunId}`,
  ) !== undefined;
}

export async function markReviewHanded(lane: WorkReviewWriteLane, workId: string, agentRunId: string): Promise<void> {
  await lane.write({
    mutateState: () => undefined,
    event: {
      idempotencyKey: `work-review-handed:${agentRunId}`,
      type: "work.review_handed",
      workId,
      payload: { schema_version: WORK_REVIEW_SCHEMA_VERSION, agent_run_id: agentRunId },
    },
    outbox: [],
  });
}

export async function recordReviewStarted(
  lane: WorkReviewWriteLane,
  workId: string,
  started: { agent_run_id: string; round: number; work_commit: string },
  mutateState: (transaction: CoreWriteLaneTransaction) => void = () => undefined,
): Promise<void> {
  await lane.write({
    mutateState,
    event: {
      idempotencyKey: `work-review-started:${started.agent_run_id}`,
      type: "work.review_started",
      workId,
      payload: { schema_version: WORK_REVIEW_SCHEMA_VERSION, ...started },
    },
    outbox: [],
  });
}

export async function recordReviewCompleted(
  lane: WorkReviewWriteLane,
  workId: string,
  review: StoredWorkReview,
  mutateState: (transaction: CoreWriteLaneTransaction) => void = () => undefined,
): Promise<void> {
  await lane.write({
    mutateState,
    event: {
      idempotencyKey: `work-review-completed:${review.agent_run_id}`,
      type: COMPLETED,
      workId,
      payload: { schema_version: WORK_REVIEW_SCHEMA_VERSION, ...review, findings: [...review.findings] } as unknown as JsonObject,
    },
    outbox: [],
  });
}
