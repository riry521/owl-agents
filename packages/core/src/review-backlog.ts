import { createHash } from "node:crypto";
import { createUlid } from "../../db/dist/index.js";
import { HumanReadableError, invalidStateTransition, notFound, validationError } from "./errors";
import { createWorkInTransaction } from "./state-reducer";
import type {
  CommandRequest,
  CoreDatabase,
  CoreWriteLaneTransaction,
  JsonObject,
} from "./types";

export type BacklogStatus = "open" | "done" | "dismissed";
export const BACKLOG_STATUSES: readonly BacklogStatus[] = ["open", "done", "dismissed"];
export const BACKLOG_LIST_LIMIT = 500;
export const BACKLOG_ITEM_IDS_MAX = 100;

export interface BacklogListFilter {
  readonly project_id?: string;
  readonly status?: BacklogStatus;
  readonly work_id?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface BacklogListResult extends JsonObject {
  readonly items: BacklogItem[];
  readonly next_offset: number | null;
}

export interface BacklogItem extends JsonObject {
  readonly id: string;
  readonly work_id: string;
  readonly work_title: string;
  readonly work_display_number: number | null;
  readonly task_id: string;
  readonly task_title: string;
  readonly project_id: string | null;
  readonly project_name: string | null;
  readonly review_id: string;
  readonly review_round: number;
  readonly file: string;
  readonly line: number;
  readonly problem: string;
  readonly reason: string;
  readonly suggestion: string;
  readonly status: BacklogStatus;
  readonly issued_work_id: string | null;
  readonly issued_work_title: string | null;
  readonly issued_work_display_number: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface DismissBacklogItemsPayload extends JsonObject {
  readonly item_ids: string[];
}

export interface DismissBacklogItemsData extends JsonObject {
  readonly items: BacklogItem[];
}

export interface IssueBacklogWorkPayload extends JsonObject {
  readonly item_ids: string[];
  readonly title: string;
  readonly summary: string;
  readonly size: "small" | "normal" | "large";
}

export interface IssueBacklogWorkData extends JsonObject {
  readonly work_id: string;
  readonly display_number: number | null;
  readonly state: "memo";
  readonly state_version: number;
  readonly project_id: string | null;
  readonly item_ids: string[];
}

type BacklogReader = Pick<CoreDatabase, "get" | "all">;

interface TaskReviewContext {
  readonly type: string;
  readonly worktree_path: string | null;
  readonly work_id: string;
  readonly project_id: string | null;
}

interface ReviewRow {
  readonly id: string;
  readonly round: number;
  readonly findings_json: string;
}

interface BacklogStateRow {
  readonly id: string;
  readonly status: BacklogStatus;
  readonly project_id: string | null;
}

const BACKLOG_ITEMS_SELECT = `
  SELECT b.id, b.work_id, w.title AS work_title, w.display_number AS work_display_number,
         b.task_id, t.title AS task_title, b.project_id, p.name AS project_name,
         b.review_id, b.review_round, b.file, b.line, b.problem, b.reason, b.suggestion,
         b.status, b.issued_work_id, iw.title AS issued_work_title, iw.display_number AS issued_work_display_number,
         b.created_at, b.updated_at
    FROM backlog_items b
    JOIN works w ON w.id = b.work_id
    JOIN tasks t ON t.id = b.task_id
    LEFT JOIN projects p ON p.id = b.project_id
    LEFT JOIN works iw ON iw.id = b.issued_work_id`;

export function normalizeBacklogFile(file: unknown, worktreePath: string | null): string {
  if (typeof file !== "string") return "";
  let normalized = file.trim().replace(/\\/gu, "/");
  if (worktreePath !== null) {
    const root = worktreePath.trim().replace(/\\/gu, "/").replace(/\/+$/u, "");
    if (normalized.startsWith(`${root}/`)) normalized = normalized.slice(root.length + 1);
  }
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

export function normalizeBacklogProblem(problem: string): string {
  return problem.normalize("NFKC").toLowerCase().replace(/\s+/gu, "").replace(/[.,!?。、]+$/u, "");
}

export function backlogDedupeKey(normalizedFile: string, problem: string): string {
  return createHash("sha256").update(`${normalizedFile}\u0000${normalizeBacklogProblem(problem)}`, "utf8").digest("hex");
}

export function registerReviewBacklogInTransaction(tx: CoreWriteLaneTransaction, taskId: string, now: string): number {
  const context = tx.get<TaskReviewContext>(
    `SELECT tasks.type, tasks.worktree_path, tasks.work_id, works.project_id
       FROM tasks JOIN works ON works.id = tasks.work_id
      WHERE tasks.id = ?`,
    taskId,
  );
  if (!context) return 0;

  const reviews = tx.all<ReviewRow>("SELECT id, round, findings_json FROM reviews WHERE task_id = ? ORDER BY round DESC", taskId);
  let inserted = 0;
  for (const review of reviews) {
    let findings: unknown;
    try {
      findings = JSON.parse(review.findings_json) as unknown;
    } catch (error) {
      console.warn(`[owl-core] Skipping malformed review findings for review ${review.id}.`, error);
      continue;
    }
    if (!Array.isArray(findings)) {
      console.warn(`[owl-core] Skipping malformed review findings for review ${review.id}.`);
      continue;
    }
    for (const value of findings) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const finding = value as Record<string, unknown>;
      if (finding.severity !== "minor" || typeof finding.problem !== "string" || finding.problem.trim().length === 0) continue;
      const file = normalizeBacklogFile(finding.file, context.worktree_path);
      const problem = finding.problem.trim();
      const line = Number.isInteger(finding.line) && (finding.line as number) >= 0 ? finding.line as number : 0;
      const reason = typeof finding.reason === "string" ? finding.reason.trim() : "";
      const suggestion = typeof finding.fix === "string" ? finding.fix.trim() : "";
      const result = tx.run(
        `INSERT INTO backlog_items
           (id, work_id, task_id, project_id, review_id, review_round, file, line, problem, reason, suggestion,
            status, issued_work_id, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, ?)
         ON CONFLICT (task_id, dedupe_key) DO NOTHING`,
        createUlid(), context.work_id, taskId, context.project_id, review.id, review.round,
        file, line, problem, reason, suggestion, backlogDedupeKey(file, problem), now, now,
      );
      inserted += result.changes;
    }
  }
  return inserted;
}

export function listBacklogItems(db: BacklogReader, filter: BacklogListFilter = {}): BacklogListResult {
  const limit = filter.limit ?? BACKLOG_LIST_LIMIT;
  const offset = filter.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > BACKLOG_LIST_LIMIT) {
    throw validationError(`Backlog list limit must be an integer between 1 and ${BACKLOG_LIST_LIMIT}.`, { limit });
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw validationError("Backlog list offset must be a non-negative integer.", { offset });
  }
  const status = filter.status ?? null;
  const projectId = filter.project_id ?? null;
  const workId = filter.work_id ?? null;
  const rows = db.all<BacklogItem>(
    `${BACKLOG_ITEMS_SELECT}
     WHERE (? IS NULL OR b.status = ?)
       AND (? IS NULL OR b.project_id = ?)
       AND (? IS NULL OR b.work_id = ?)
     ORDER BY b.created_at DESC, b.id DESC
     LIMIT ? OFFSET ?`,
    status, status, projectId, projectId, workId, workId, limit + 1, offset,
  );
  const hasMore = rows.length > limit;
  return {
    items: hasMore ? rows.slice(0, limit) : rows,
    next_offset: hasMore ? offset + limit : null,
  };
}

export function dismissBacklogItemsInTransaction(
  tx: CoreWriteLaneTransaction,
  itemIds: readonly string[],
  now: string,
): BacklogItem[] {
  const ids = validateItemIds(itemIds);
  const rows = readBacklogStates(tx, ids);
  assertFoundAndOpen(rows, ids);
  const result = tx.run(
    `UPDATE backlog_items SET status = 'dismissed', updated_at = ?
      WHERE id IN (${placeholders(ids.length)}) AND status = 'open'`,
    now,
    ...ids,
  );
  if (result.changes !== ids.length) {
    throw invalidStateTransition("Some backlog items changed before they could be dismissed.", { item_ids: ids });
  }
  return readBacklogItemsByIds(tx, ids);
}

export function issueBacklogWorkInTransaction(
  tx: CoreWriteLaneTransaction,
  payload: IssueBacklogWorkPayload,
  now: string,
  ownerId = "owner:default",
): IssueBacklogWorkData {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw validationError("Backlog Work details are invalid.", { field: "item_ids" });
  }
  const ids = validateItemIds(payload.item_ids);
  const rows = readBacklogStates(tx, ids);
  assertFoundAndOpen(rows, ids);
  const projectIds = [...new Set(rows.map((row) => row.project_id))];
  if (projectIds.length !== 1) {
    throw validationError("Backlog items must belong to the same Project to issue a Work.", {
      field: "item_ids",
      project_ids: projectIds,
    });
  }
  if (typeof payload.title !== "string" || payload.title.trim().length < 1 || payload.title.length > 500) {
    throw validationError("Work title must contain between 1 and 500 characters.", { field: "title" });
  }
  if (typeof payload.summary !== "string" || payload.summary.length > 20000) {
    throw validationError("Work summary cannot exceed 20,000 characters.", { field: "summary" });
  }
  const work = createWorkInTransaction(tx, {
    title: payload.title,
    summary: payload.summary,
    size: payload.size,
    project_id: projectIds[0],
  }, ownerId);
  const update = tx.run(
    `UPDATE backlog_items SET status = 'done', issued_work_id = ?, updated_at = ?
      WHERE id IN (${placeholders(ids.length)}) AND status = 'open'`,
    work.id,
    now,
    ...ids,
  );
  if (update.changes !== ids.length) {
    throw invalidStateTransition("Some backlog items changed before a Work could be issued.", { item_ids: ids });
  }
  return {
    work_id: work.id,
    display_number: work.display_number,
    state: "memo",
    state_version: work.state_version,
    project_id: work.project_id,
    item_ids: ids,
  };
}

function validateItemIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > BACKLOG_ITEM_IDS_MAX || value.some((id) => typeof id !== "string") || new Set(value).size !== value.length) {
    throw validationError("Backlog item IDs must be a non-empty list of unique strings (up to 100).", { field: "item_ids" });
  }
  return [...value] as string[];
}

function readBacklogStates(tx: CoreWriteLaneTransaction, ids: readonly string[]): BacklogStateRow[] {
  return tx.all<BacklogStateRow>(
    `SELECT id, status, project_id FROM backlog_items WHERE id IN (${placeholders(ids.length)})`,
    ...ids,
  );
}

function assertFoundAndOpen(rows: readonly BacklogStateRow[], ids: readonly string[]): void {
  const found = new Set(rows.map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new HumanReadableError({
      code: "backlog_item_not_found",
      message: "Backlog items were not found.",
      remediation: "Refresh the backlog list and select existing items.",
      details: { item_ids: missing },
    });
  }
  const notOpen = rows.filter((row) => row.status !== "open");
  if (notOpen.length > 0) {
    throw invalidStateTransition("Only open backlog items can be changed.", {
      item_ids: notOpen.map((row) => row.id),
      statuses: notOpen.map((row) => ({ item_id: row.id, status: row.status })),
    });
  }
}

function readBacklogItemsByIds(db: BacklogReader, ids: readonly string[]): BacklogItem[] {
  return db.all<BacklogItem>(
    `${BACKLOG_ITEMS_SELECT}
     WHERE b.id IN (${placeholders(ids.length)})
     ORDER BY b.created_at DESC, b.id DESC`,
    ...ids,
  );
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
