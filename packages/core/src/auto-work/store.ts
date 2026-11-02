import type { AutoWorkGithubList, AutoWorkSource, AutoWorkVerdict, GithubListCursor } from "@owl/shared";
import { createUlid, utcNow } from "../../../db/dist/index.js";
import type { CoreDatabase, CoreWriteLaneTransaction } from "../types";

export interface AutoWorkEventRecord {
  id: string;
  project_id: string;
  source: AutoWorkSource;
  kind: string;
  rule_id: string | null;
  dedupe_key: string;
  day_key: string;
  title: string;
  detail: string;
  verdict: AutoWorkVerdict;
  verdict_reason: string;
  judge: unknown | null;
  work_id: string | null;
  duplicate_of_work_id: string | null;
  duplicate_of_event_id: string | null;
  action: "draft" | "start" | null;
  action_error: string | null;
  backlog_item_ids: string[];
  github_repo: string | null;
  github_issue_number: number | null;
  github_is_pull_request: boolean | null;
  github_comment_id: string | null;
  github_updated_at: string | null;
  github_author: string | null;
  github_url: string | null;
  github_comment_url: string | null;
  github_pr_url: string | null;
  finished_notified_at: string | null;
  occurred_at: string;
  created_at: string;
  updated_at: string;
}

export type AutoWorkEventInput = Partial<Omit<AutoWorkEventRecord, "id" | "created_at" | "updated_at">>
  & Pick<AutoWorkEventRecord, "project_id" | "source" | "kind" | "dedupe_key" | "day_key" | "verdict" | "verdict_reason" | "occurred_at">;
/** Columns that may change after the row is written. */
export type AutoWorkEventPatch = Partial<Omit<AutoWorkEventRecord, "id" | "project_id" | "source" | "kind" | "dedupe_key" | "day_key" | "created_at" | "updated_at">>;

export interface AutoWorkEventQuery {
  project_id?: string;
  source?: AutoWorkSource;
  verdict?: AutoWorkVerdict;
  work_id?: string;
  limit: number;
  offset?: number;
}

type EventRow = Omit<AutoWorkEventRecord, "judge" | "backlog_item_ids" | "github_is_pull_request"> & {
  judge_json: string | null;
  backlog_item_ids_json: string;
  github_is_pull_request: number | null;
};

export type GithubItemType = "issue" | "comment";
export type GithubItemState = "pending" | "processed" | "failed";

export interface GithubLedgerItem {
  project_id: string;
  repo: string;
  item_type: GithubItemType;
  item_id: string;
  issue_number: number;
  updated_at: string;
  created_in_window: boolean;
  state: GithubItemState;
  payload: unknown | null;
  attempts: number;
  last_error: string | null;
  event_id: string | null;
  seen_at: string;
  processed_at: string | null;
}

/** An item read from GitHub, ready to be recorded. */
export interface GithubItemInput {
  item_type: GithubItemType;
  item_id: string;
  issue_number: number;
  updated_at: string;
  created_in_window: boolean;
  payload: unknown;
}

interface LedgerRow extends Omit<GithubLedgerItem, "created_in_window" | "payload"> {
  created_in_window: number;
  payload_json: string | null;
}

interface CursorRow extends GithubListCursor { list: AutoWorkGithubList; repo: string }

function toEvent(row: EventRow): AutoWorkEventRecord {
  const { judge_json, backlog_item_ids_json, github_is_pull_request, ...rest } = row;
  return {
    ...rest,
    judge: judge_json === null ? null : JSON.parse(judge_json),
    backlog_item_ids: JSON.parse(backlog_item_ids_json) as string[],
    github_is_pull_request: github_is_pull_request === null ? null : github_is_pull_request === 1,
  };
}

function toLedgerItem(row: LedgerRow): GithubLedgerItem {
  const { payload_json, created_in_window, ...rest } = row;
  return { ...rest, created_in_window: created_in_window === 1, payload: payload_json === null ? null : JSON.parse(payload_json) };
}

/** SQL value of an event field: the JSON columns are serialized and a boolean becomes 0/1. */
function eventColumn(field: string, value: unknown): [string, string | number | null] {
  if (field === "judge") return ["judge_json", value === null || value === undefined ? null : JSON.stringify(value)];
  if (field === "backlog_item_ids") return ["backlog_item_ids_json", JSON.stringify(value ?? [])];
  if (field === "github_is_pull_request") return [field, value === null || value === undefined ? null : value ? 1 : 0];
  return [field, (value ?? null) as string | number | null];
}

/**
 * Insert an event inside a transaction the caller already holds, so a check and the row it reserves
 * stay in one step. `now` is passed in because the service runs on an injectable clock.
 */
export function insertEventRow(tx: CoreWriteLaneTransaction, input: AutoWorkEventInput, now: string): string {
  const id = createUlid();
  const row: Record<string, unknown> = { title: "", detail: "", backlog_item_ids: [], ...input };
  const columns: [string, string | number | null][] = [["id", id], ["created_at", now], ["updated_at", now]];
  for (const [field, value] of Object.entries(row)) {
    if (value !== undefined) columns.push(eventColumn(field, value));
  }
  tx.run(
    `INSERT INTO auto_work_events (${columns.map(([name]) => name).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ...columns.map(([, value]) => value),
  );
  return id;
}

export function updateEventRow(tx: CoreWriteLaneTransaction, id: string, patch: AutoWorkEventPatch, now: string): void {
  const columns = Object.entries(patch).filter(([, value]) => value !== undefined).map(([field, value]) => eventColumn(field, value));
  tx.run(
    `UPDATE auto_work_events SET ${[...columns.map(([name]) => `${name} = ?`), "updated_at = ?"].join(", ")} WHERE id = ?`,
    ...columns.map(([, value]) => value), now, id,
  );
}

/** Records of automatic Work creation: one event per signal, plus the GitHub fetch cursors and item ledger. */
export class AutoWorkStore {
  public constructor(private readonly db: CoreDatabase) {}

  public async insertEvent(input: AutoWorkEventInput): Promise<AutoWorkEventRecord> {
    const id = await this.db.createWriteLane().transact((tx) => insertEventRow(tx, input, utcNow()));
    return this.requireEvent(id);
  }

  public async updateEvent(id: string, patch: AutoWorkEventPatch): Promise<AutoWorkEventRecord> {
    await this.db.createWriteLane().transact((tx) => updateEventRow(tx, id, patch, utcNow()));
    return this.requireEvent(id);
  }

  public getEvent(id: string): AutoWorkEventRecord | null {
    const row = this.db.get<EventRow>("SELECT * FROM auto_work_events WHERE id = ?", id);
    return row ? toEvent(row) : null;
  }

  /** Newest first. */
  public listEvents(query: AutoWorkEventQuery): AutoWorkEventRecord[] {
    const where: string[] = [];
    const params: string[] = [];
    for (const field of ["project_id", "source", "verdict", "work_id"] as const) {
      const value = query[field];
      if (value !== undefined) { where.push(`${field} = ?`); params.push(value); }
    }
    const rows = this.db.all<EventRow>(
      `SELECT * FROM auto_work_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC LIMIT ${Math.floor(query.limit)} OFFSET ${Math.floor(query.offset ?? 0)}`,
      ...params,
    );
    return rows.map(toEvent);
  }

  public getCursor(projectId: string, list: AutoWorkGithubList): (GithubListCursor & { repo: string }) | null {
    const row = this.db.get<CursorRow>(
      "SELECT list, repo, since, last_polled_at, last_completed_at, last_error FROM auto_work_github_cursors WHERE project_id = ? AND list = ?",
      projectId, list,
    );
    if (!row) return null;
    return { repo: row.repo, since: row.since, last_polled_at: row.last_polled_at, last_completed_at: row.last_completed_at, last_error: row.last_error };
  }

  public async saveCursor(projectId: string, list: AutoWorkGithubList, repo: string, cursor: GithubListCursor): Promise<void> {
    await this.db.createWriteLane().transact((tx) => {
      tx.run(
        `INSERT INTO auto_work_github_cursors (project_id, list, repo, since, last_polled_at, last_completed_at, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, list) DO UPDATE SET repo = excluded.repo, since = excluded.since, last_polled_at = excluded.last_polled_at,
           last_completed_at = excluded.last_completed_at, last_error = excluded.last_error, updated_at = excluded.updated_at`,
        projectId, list, repo, cursor.since, cursor.last_polled_at, cursor.last_completed_at, cursor.last_error, utcNow(),
      );
    });
  }

  /** Forget a Project's cursors and ledger, e.g. after its repository changed. */
  public async resetGithub(projectId: string): Promise<void> {
    await this.db.createWriteLane().transact((tx) => {
      tx.run("DELETE FROM auto_work_github_cursors WHERE project_id = ?", projectId);
      tx.run("DELETE FROM auto_work_github_items WHERE project_id = ?", projectId);
    });
  }

  /**
   * Record one fetched page in one transaction. A new item is pending. A known item whose updated_at
   * is newer is pending again (a failed one starts its attempts over). An equal or older one is ignored.
   */
  public async recordItems(projectId: string, repo: string, items: readonly GithubItemInput[]): Promise<void> {
    const now = utcNow();
    await this.db.createWriteLane().transact((tx) => {
      for (const item of items) {
        tx.run(
          `INSERT INTO auto_work_github_items (project_id, repo, item_type, item_id, issue_number, updated_at, created_in_window, state, payload_json, seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
           ON CONFLICT (project_id, item_type, item_id) DO UPDATE SET
             repo = excluded.repo, issue_number = excluded.issue_number, updated_at = excluded.updated_at,
             payload_json = excluded.payload_json, state = 'pending', attempts = 0, last_error = NULL
           WHERE excluded.updated_at > auto_work_github_items.updated_at`,
          projectId, repo, item.item_type, item.item_id, item.issue_number, item.updated_at, item.created_in_window ? 1 : 0, JSON.stringify(item.payload), now,
        );
      }
    });
  }

  /** Pending items, oldest update first. */
  public listPendingItems(projectId: string, itemType: GithubItemType, limit: number): GithubLedgerItem[] {
    return this.db.all<LedgerRow>(
      `SELECT * FROM auto_work_github_items WHERE project_id = ? AND item_type = ? AND state = 'pending'
       ORDER BY updated_at, item_id LIMIT ${Math.floor(limit)}`,
      projectId, itemType,
    ).map(toLedgerItem);
  }

  public getItem(projectId: string, itemType: GithubItemType, itemId: string): GithubLedgerItem | null {
    const row = this.db.get<LedgerRow>(
      "SELECT * FROM auto_work_github_items WHERE project_id = ? AND item_type = ? AND item_id = ?",
      projectId, itemType, itemId,
    );
    return row ? toLedgerItem(row) : null;
  }

  /** Mark an item processed and drop its payload (text from outside people is not kept). */
  public async markItemProcessed(projectId: string, itemType: GithubItemType, itemId: string, eventId: string | null): Promise<void> {
    await this.db.createWriteLane().transact((tx) => {
      tx.run(
        `UPDATE auto_work_github_items SET state = 'processed', payload_json = NULL, event_id = ?, processed_at = ?, last_error = NULL
         WHERE project_id = ? AND item_type = ? AND item_id = ?`,
        eventId, utcNow(), projectId, itemType, itemId,
      );
    });
  }

  /** Count a failed attempt; the item becomes failed once it reaches maxAttempts. */
  public async markItemAttemptFailed(projectId: string, itemType: GithubItemType, itemId: string, error: string, maxAttempts: number): Promise<void> {
    await this.db.createWriteLane().transact((tx) => {
      tx.run(
        `UPDATE auto_work_github_items SET attempts = attempts + 1, last_error = ?,
           state = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE state END
         WHERE project_id = ? AND item_type = ? AND item_id = ?`,
        error, maxAttempts, projectId, itemType, itemId,
      );
    });
  }

  /** Delete processed items last updated before `before`; pending and failed ones stay. */
  public async deleteProcessedBefore(projectId: string, before: string): Promise<number> {
    return this.db.createWriteLane().transact((tx) =>
      Number(tx.run(
        "DELETE FROM auto_work_github_items WHERE project_id = ? AND state = 'processed' AND updated_at < ?",
        projectId, before,
      ).changes),
    );
  }

  public countItems(projectId: string, itemType: GithubItemType): Record<GithubItemState, number> {
    const counts: Record<GithubItemState, number> = { pending: 0, processed: 0, failed: 0 };
    const rows = this.db.all<{ state: GithubItemState; total: number }>(
      "SELECT state, COUNT(*) AS total FROM auto_work_github_items WHERE project_id = ? AND item_type = ? GROUP BY state",
      projectId, itemType,
    );
    for (const row of rows) counts[row.state] = row.total;
    return counts;
  }

  private requireEvent(id: string): AutoWorkEventRecord {
    const event = this.getEvent(id);
    if (!event) throw new Error(`auto work event not found: ${id}`);
    return event;
  }
}
