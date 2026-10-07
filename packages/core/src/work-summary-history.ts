import { createUlid, utcNow } from "../../db/dist/index.js";
import { notFound, validationError } from "./errors";
import { appendEventInTransaction, updateWorkFieldsInTransaction } from "./state-reducer";
import type { CoreDatabase, CoreWriteLaneTransaction, JsonObject } from "./types";

const WORK_TITLE_MAX_LENGTH = 500;
const WORK_SUMMARY_MAX_LENGTH = 20_000;
const TRIGGER_TEXT_MAX_LENGTH = 20_000;

export type WorkSummaryField = "title" | "summary";
export type WorkSummaryTriggerKind = "owner_edit" | "instruction" | "reopen" | "decision" | "auto_conflict";

/** Owner replan kinds whose Manager answer may rewrite the Work title/summary. */
export const MANAGER_SUMMARY_UPDATE_KINDS: ReadonlySet<string> =
  new Set(["instruction", "reopen", "decision", "auto_conflict"]);

export interface ManagerWorkSummaryUpdate {
  readonly title: string | null;
  readonly summary: string | null;
}

interface TitleSummary {
  readonly title: string;
  readonly summary: string;
}

export interface WorkSummaryRevision {
  readonly id: string;
  readonly work_id: string;
  readonly actor: "owner" | "manager";
  readonly agent_run_id: string | null;
  readonly trigger: { readonly kind: WorkSummaryTriggerKind; readonly message_ids: readonly string[]; readonly text: string | null };
  readonly changed_fields: readonly WorkSummaryField[];
  readonly before: TitleSummary;
  readonly after: TitleSummary;
  readonly created_at: string;
}

export interface WorkSummaryHistory {
  readonly work_id: string;
  readonly truncated: boolean;
  /** Newest first. */
  readonly revisions: readonly WorkSummaryRevision[];
}

/**
 * The title/summary a Manager replan report asks for, or null when it asks for none.
 * Re-checks the runner's validation (a fake runner can bypass it).
 */
export function managerWorkSummaryUpdate(report: JsonObject): ManagerWorkSummaryUpdate | null {
  const read = (field: "updated_title" | "updated_summary", max: number, blankOk: boolean): string | null => {
    const value = report[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || (!blankOk && value.trim().length < 1) || value.length > max) {
      throw validationError(`The Manager's ${field} must be a string of 1 to ${max} characters, or null.`, { field });
    }
    return value;
  };
  const title = read("updated_title", WORK_TITLE_MAX_LENGTH, false);
  const summary = read("updated_summary", WORK_SUMMARY_MAX_LENGTH, false);
  return title === null && summary === null ? null : { title, summary };
}

export function insertWorkSummaryRevisionInTransaction(
  transaction: CoreWriteLaneTransaction,
  input: {
    readonly work_id: string;
    readonly actor: "owner" | "manager";
    readonly agent_run_id: string | null;
    readonly trigger_kind: WorkSummaryTriggerKind;
    readonly trigger_message_ids: readonly string[];
    readonly trigger_text: string | null;
    readonly changed_fields: readonly WorkSummaryField[];
    readonly before: TitleSummary;
    readonly after: TitleSummary;
    readonly now: string;
  },
): string {
  const id = createUlid();
  const text = input.trigger_text !== null && input.trigger_text.length > TRIGGER_TEXT_MAX_LENGTH
    ? `${input.trigger_text.slice(0, TRIGGER_TEXT_MAX_LENGTH - 1)}…`
    : input.trigger_text;
  transaction.run(
    `INSERT INTO work_summary_revisions
       (id, work_id, actor, agent_run_id, trigger_kind, trigger_message_ids_json, trigger_text,
        changed_fields_json, title_before, title_after, summary_before, summary_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.work_id,
    input.actor,
    input.agent_run_id,
    input.trigger_kind,
    JSON.stringify(input.trigger_message_ids),
    text,
    JSON.stringify(input.changed_fields),
    input.before.title,
    input.after.title,
    input.before.summary,
    input.after.summary,
    input.now,
  );
  return id;
}

/** Record an Owner's updateWork (nothing when no field changed). */
export function recordOwnerWorkSummaryRevisionInTransaction(
  transaction: CoreWriteLaneTransaction,
  input: {
    readonly work_id: string;
    readonly before: TitleSummary;
    readonly after: TitleSummary;
    readonly changed_fields: readonly WorkSummaryField[];
    readonly now: string;
  },
): void {
  if (input.changed_fields.length === 0) return;
  insertWorkSummaryRevisionInTransaction(transaction, {
    ...input,
    actor: "owner",
    agent_run_id: null,
    trigger_kind: "owner_edit",
    trigger_message_ids: [],
    trigger_text: null,
  });
}

/**
 * Apply a Manager replan's title/summary inside the transaction that applies the plan.
 * Returns the changed fields, or null when nothing was written.
 */
export function applyManagerWorkSummaryUpdateInTransaction(
  transaction: CoreWriteLaneTransaction,
  input: {
    readonly work_id: string;
    readonly update: ManagerWorkSummaryUpdate | null;
    readonly owner_replan: { readonly kind: string; readonly answer: string; readonly message_ids?: readonly string[] } | null;
    readonly agent_run_id: string;
    /** The title/summary the Manager was shown. */
    readonly base: TitleSummary;
  },
): { readonly revision_id: string; readonly changed_fields: readonly WorkSummaryField[] } | null {
  const { update, owner_replan: ownerReplan, work_id: workId } = input;
  if (update === null || (update.title === null && update.summary === null)) return null;
  const skip = (why: string): null => {
    console.warn(`[owl-core] ignored the Manager's Work title/summary update for Work ${workId}: ${why}`);
    return null;
  };
  if (ownerReplan === null || !MANAGER_SUMMARY_UPDATE_KINDS.has(ownerReplan.kind)) {
    return skip(`replan was not started by an Owner request (${ownerReplan?.kind ?? "none"})`);
  }
  const row = transaction.get<{ state: string; title: string; summary: string }>(
    "SELECT state, title, summary FROM works WHERE id = ?",
    workId,
  );
  if (!row || row.state === "completed" || row.state === "cancelled") return skip("the Work is no longer editable");
  if (row.title !== input.base.title || row.summary !== input.base.summary) {
    return skip("the Owner changed the Work while the Manager was running; the Owner's version wins");
  }
  const now = utcNow();
  const result = updateWorkFieldsInTransaction(
    transaction,
    workId,
    undefined,
    { title: update.title ?? undefined, summary: update.summary ?? undefined },
    now,
  );
  if (result.changed_fields.length === 0) return null;
  const revisionId = insertWorkSummaryRevisionInTransaction(transaction, {
    work_id: workId,
    actor: "manager",
    agent_run_id: input.agent_run_id,
    trigger_kind: ownerReplan.kind as WorkSummaryTriggerKind,
    trigger_message_ids: ownerReplan.message_ids ?? [],
    trigger_text: ownerReplan.answer,
    changed_fields: result.changed_fields,
    before: { title: row.title, summary: row.summary },
    after: result.after,
    now,
  });
  appendEventInTransaction(transaction, {
    type: "work.updated",
    idempotencyKey: `work-summary-revision:${revisionId}`,
    workId,
    taskId: null,
    payload: { work_id: workId, changed_fields: result.changed_fields, title: result.after.title, actor: "manager", revision_id: revisionId },
    now,
  });
  return { revision_id: revisionId, changed_fields: result.changed_fields };
}

interface RevisionRow {
  id: string;
  work_id: string;
  actor: "owner" | "manager";
  agent_run_id: string | null;
  trigger_kind: WorkSummaryTriggerKind;
  trigger_message_ids_json: string;
  trigger_text: string | null;
  changed_fields_json: string;
  title_before: string;
  title_after: string;
  summary_before: string;
  summary_after: string;
  created_at: string;
}

/** Newest first; limit is clamped to 1..200 (default 50). Throws work_not_found. */
export function listWorkSummaryRevisions(db: CoreDatabase, workId: string, opts: { readonly limit?: number } = {}): WorkSummaryHistory {
  if (!db.get("SELECT id FROM works WHERE id = ?", workId)) throw notFound("work", workId);
  const limit = Math.min(200, Math.max(1, Math.trunc(opts.limit ?? 50)));
  const rows = db.all<RevisionRow>(
    "SELECT * FROM work_summary_revisions WHERE work_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    workId,
    limit + 1,
  );
  return {
    work_id: workId,
    truncated: rows.length > limit,
    revisions: rows.slice(0, limit).map((row) => ({
      id: row.id,
      work_id: row.work_id,
      actor: row.actor,
      agent_run_id: row.agent_run_id,
      trigger: { kind: row.trigger_kind, message_ids: JSON.parse(row.trigger_message_ids_json) as string[], text: row.trigger_text },
      changed_fields: JSON.parse(row.changed_fields_json) as WorkSummaryField[],
      before: { title: row.title_before, summary: row.summary_before },
      after: { title: row.title_after, summary: row.summary_after },
      created_at: row.created_at,
    })),
  };
}
