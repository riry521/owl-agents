import { createUlid, utcNow } from "../../db/dist/index.js";
import type { CoreDatabase } from "./types";

export type CurationKind = "librarian" | "skill_curation" | "rule_curation";
export type CurationTrigger = "manual_api" | "advisor_action" | "scheduled";
export type CurationActor = "owner" | "advisor" | "system";
export type CurationRunStatus = "running" | "succeeded" | "failed";
export const CURATION_KINDS: readonly CurationKind[] = ["librarian", "skill_curation", "rule_curation"];
export const CURATION_RUN_STATUSES: readonly CurationRunStatus[] = ["running", "succeeded", "failed"];

export interface CurationRunSummaryView {
  id: string;
  kind: CurationKind;
  trigger: CurationTrigger;
  actor: CurationActor;
  actor_ref: string | null;
  status: CurationRunStatus;
  summary: string;
  counts: Record<string, number>;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface CurationRunView extends CurationRunSummaryView {
  report: unknown | null;
}

export interface CurationStartInput {
  kind: CurationKind;
  trigger: CurationTrigger;
  actor: CurationActor;
  actor_ref?: string | null;
  request_key?: string | null;
  now?: string;
}

export interface CurationFinishInput {
  summary: string;
  counts: Record<string, number>;
  report: unknown;
}

export interface CurationListQuery {
  kind?: CurationKind;
  status?: CurationRunStatus;
  limit: number;
  cursor?: string;
}

interface CurationRunRow {
  id: string;
  kind: CurationKind;
  trigger: CurationTrigger;
  actor: CurationActor;
  actor_ref: string | null;
  status: CurationRunStatus;
  summary: string;
  counts_json: string;
  report_json: string | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}

const COLUMNS = "id, kind, trigger, actor, actor_ref, status, summary, counts_json, report_json, error, started_at, ended_at";

function toSummary(row: CurationRunRow): CurationRunSummaryView {
  return {
    id: row.id,
    kind: row.kind,
    trigger: row.trigger,
    actor: row.actor,
    actor_ref: row.actor_ref,
    status: row.status,
    summary: row.summary,
    counts: JSON.parse(row.counts_json) as Record<string, number>,
    error: row.error,
    started_at: row.started_at,
    ended_at: row.ended_at,
  };
}

function toView(row: CurationRunRow): CurationRunView {
  return { ...toSummary(row), report: row.report_json === null ? null : JSON.parse(row.report_json) };
}

/** Persistent record of curation runs. The kind is only a label; the store has no per-kind logic. */
export class CurationRunStore {
  public constructor(private readonly db: CoreDatabase) {}

  public async start(input: CurationStartInput): Promise<CurationRunView> {
    const id = createUlid();
    await this.db.createWriteLane().transact((tx) => {
      tx.run(
        `INSERT INTO curation_runs (id, kind, trigger, actor, actor_ref, request_key, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
        id, input.kind, input.trigger, input.actor, input.actor_ref ?? null, input.request_key ?? null, input.now ?? utcNow(),
      );
    });
    return this.require(id);
  }

  public finish(id: string, result: CurationFinishInput): Promise<CurationRunView> {
    return this.settle(id, "succeeded", result.summary, result.counts, JSON.stringify(result.report ?? null), null);
  }

  public fail(id: string, error: string, partial: { summary?: string; counts?: Record<string, number>; report?: unknown } = {}): Promise<CurationRunView> {
    const report = partial.report === undefined ? null : JSON.stringify(partial.report);
    return this.settle(id, "failed", partial.summary ?? "", partial.counts ?? {}, report, error.slice(0, 500));
  }

  /** Writes an already finished run in one call. */
  public async record(input: CurationStartInput & CurationFinishInput & { status: "succeeded" | "failed"; error?: string }): Promise<CurationRunView> {
    const run = await this.start(input);
    return input.status === "succeeded"
      ? this.finish(run.id, input)
      : this.fail(run.id, input.error ?? "failed", { summary: input.summary, counts: input.counts, report: input.report });
  }

  public list(query: CurationListQuery): { items: CurationRunSummaryView[]; next_cursor: string | null } {
    const where: string[] = [];
    const params: string[] = [];
    if (query.kind) { where.push("kind = ?"); params.push(query.kind); }
    if (query.status) { where.push("status = ?"); params.push(query.status); }
    if (query.cursor) { where.push("id < ?"); params.push(query.cursor); }
    const limit = Math.floor(query.limit);
    const rows = this.db.all<CurationRunRow>(
      `SELECT ${COLUMNS} FROM curation_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${limit + 1}`,
      ...params,
    );
    const page = rows.slice(0, limit);
    return { items: page.map(toSummary), next_cursor: rows.length > limit ? page[page.length - 1]!.id : null };
  }

  public get(id: string): CurationRunView | null {
    const row = this.db.get<CurationRunRow>(`SELECT ${COLUMNS} FROM curation_runs WHERE id = ?`, id);
    return row ? toView(row) : null;
  }

  public findByRequestKey(key: string): CurationRunView | null {
    const row = this.db.get<CurationRunRow>(`SELECT ${COLUMNS} FROM curation_runs WHERE request_key = ?`, key);
    return row ? toView(row) : null;
  }

  public findRunning(kind: string): CurationRunView | null {
    const row = this.db.get<CurationRunRow>(`SELECT ${COLUMNS} FROM curation_runs WHERE kind = ? AND status = 'running' ORDER BY id DESC LIMIT 1`, kind);
    return row ? toView(row) : null;
  }

  /** Marks runs left `running` by a previous process as failed. */
  public recoverInterrupted(now: string = utcNow()): Promise<number> {
    return this.db.createWriteLane().transact((tx) =>
      Number(tx.run(
        "UPDATE curation_runs SET status = 'failed', error = 'interrupted_by_restart', ended_at = ? WHERE status = 'running'",
        now,
      ).changes),
    );
  }

  private async settle(
    id: string,
    status: "succeeded" | "failed",
    summary: string,
    counts: Record<string, number>,
    reportJson: string | null,
    error: string | null,
  ): Promise<CurationRunView> {
    await this.db.createWriteLane().transact((tx) => {
      tx.run(
        `UPDATE curation_runs SET status = ?, summary = ?, counts_json = ?, report_json = ?, error = ?, ended_at = ?
         WHERE id = ? AND status = 'running'`,
        status, summary, JSON.stringify(counts), reportJson, error, utcNow(), id,
      );
    });
    return this.require(id);
  }

  private require(id: string): CurationRunView {
    const run = this.get(id);
    if (!run) throw new Error(`curation run not found: ${id}`);
    return run;
  }
}
