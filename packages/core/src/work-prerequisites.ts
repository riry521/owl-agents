import { utcNow } from "../../db/dist/index.js";
import { validatePrerequisiteWorkIds, type WorkPrerequisiteView } from "../../shared/dist/work-prerequisite.js";
import { DROP_MISSING_PREREQUISITES_OPTION_KEY, workPrerequisiteUnreachableBrief, type WorkPrerequisiteBriefItem } from "./decision-brief";
import { HumanReadableError, validationError } from "./errors";
import type { OwnerLanguage } from "./owner-language";
import { workConditionVerdict, type ConditionVerdict } from "./prerequisite-monitor";
import { appendEventInTransaction, ensureCoreDecision, reduceWorkInTransaction } from "./state-reducer";
import type { CoreSqlValue, CoreWriteLaneTransaction, WorkRow } from "./types";

/** What these functions read; both the database and a write-lane transaction fit. */
export interface WorkPrerequisiteReader {
  all<T extends object>(sql: string, ...parameters: CoreSqlValue[]): T[];
  get<T extends object>(sql: string, ...parameters: CoreSqlValue[]): T | undefined;
}

interface PrerequisiteRow {
  readonly view: WorkPrerequisiteView;
  readonly decision_id: string | null;
  readonly verdict: ConditionVerdict;
}

interface RawRow {
  work_id: string;
  prerequisite_work_id: string;
  decision_id: string | null;
  deleted_json: string | null;
  state: string | null;
  title: string | null;
  project_id: string | null;
  project_name: string | null;
  display_number: number | null;
}

interface DeletedSnapshot {
  deleted_at: string;
  state: string;
  title: string;
  project_id: string | null;
  project_name: string | null;
  display_number: number | null;
}

const marks = (count: number): string => Array.from({ length: count }, () => "?").join(", ");

/** A prerequisite's name in the Owner's language: "{Project name} Work #{N}". */
function displayName(view: Pick<WorkPrerequisiteView, "work_id" | "project_name" | "display_number">, language: OwnerLanguage): string {
  if (view.display_number === null) return `Work ${view.work_id}`;
  return `${view.project_name ?? (language === "ja" ? "Project なし" : "No Project")} Work #${view.display_number}`;
}

function loadRows(reader: WorkPrerequisiteReader, workIds: readonly string[]): Map<string, PrerequisiteRow[]> {
  const result = new Map<string, PrerequisiteRow[]>();
  if (workIds.length === 0) return result;
  const rows = reader.all<RawRow>(
    `SELECT wp.work_id, wp.prerequisite_work_id, wp.decision_id, wp.deleted_json,
            w.state, w.title, w.project_id, p.name AS project_name, w.display_number
       FROM work_prerequisites wp
       LEFT JOIN works w ON w.id = wp.prerequisite_work_id
       LEFT JOIN projects p ON p.id = w.project_id
      WHERE wp.work_id IN (${marks(workIds.length)})
      ORDER BY wp.work_id, wp.position`,
    ...workIds,
  );
  for (const row of rows) {
    const exists = row.state !== null;
    const snapshot = !exists && row.deleted_json !== null ? (JSON.parse(row.deleted_json) as DeletedSnapshot) : null;
    // A prerequisite deleted after it completed still counts as met; one deleted earlier never can be.
    const verdict = workConditionVerdict(exists ? row.state ?? undefined : snapshot?.state === "completed" ? "completed" : undefined);
    const view: WorkPrerequisiteView = {
      work_id: row.prerequisite_work_id,
      project_id: exists ? row.project_id : snapshot?.project_id ?? null,
      project_name: exists ? row.project_name : snapshot?.project_name ?? null,
      display_number: exists ? row.display_number : snapshot?.display_number ?? null,
      title: exists ? row.title ?? "" : snapshot?.title ?? "",
      state: exists ? row.state : null,
      deleted: !exists,
      satisfied: verdict === "satisfied",
    };
    const list = result.get(row.work_id) ?? [];
    list.push({ view, decision_id: row.decision_id, verdict });
    result.set(row.work_id, list);
  }
  return result;
}

/** The display data of the prerequisites of several Works, in one query. */
export function workPrerequisiteViews(reader: WorkPrerequisiteReader, workIds: readonly string[]): Map<string, WorkPrerequisiteView[]> {
  return new Map([...loadRows(reader, workIds)].map(([workId, rows]) => [workId, rows.map((row) => row.view)]));
}

/** The verdict of each prerequisite of a Work, in the order the Owner listed them. */
export function evaluateWorkPrerequisitesInTransaction(
  reader: WorkPrerequisiteReader,
  workId: string,
): Array<{ work_id: string; verdict: ConditionVerdict; decision_id: string | null }> {
  return (loadRows(reader, [workId]).get(workId) ?? []).map((row) => ({ work_id: row.view.work_id, verdict: row.verdict, decision_id: row.decision_id }));
}

/** A path W → … → W through stored edges when making `ids` the prerequisites of `workId`; null when there is none. */
export function findPrerequisiteCycle(reader: WorkPrerequisiteReader, workId: string, ids: readonly string[]): string[] | null {
  for (const start of ids) {
    const stack: Array<[string, string[]]> = [[start, [workId, start]]];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const [node, path] = stack.pop() as [string, string[]];
      if (node === workId) return path;
      if (visited.has(node)) continue;
      visited.add(node);
      for (const next of reader.all<{ prerequisite_work_id: string }>("SELECT prerequisite_work_id FROM work_prerequisites WHERE work_id = ?", node)) {
        stack.push([next.prerequisite_work_id, [...path, next.prerequisite_work_id]]);
      }
    }
  }
  return null;
}

/** Replace the prerequisites of a Work, refusing missing Works, itself and cycles. */
export function replaceWorkPrerequisitesInTransaction(
  transaction: CoreWriteLaneTransaction,
  workId: string,
  value: unknown,
  now: string = utcNow(),
): string[] {
  let ids: string[];
  try {
    ids = validatePrerequisiteWorkIds(value);
  } catch (error) {
    throw validationError((error as Error).message, { field: "prerequisite_work_ids" });
  }
  if (ids.includes(workId)) throw validationError("A Work cannot be its own prerequisite.", { field: "prerequisite_work_ids" });
  for (const id of ids) {
    if (!transaction.get("SELECT id FROM works WHERE id = ?", id)) {
      throw new HumanReadableError({
        code: "prerequisite_work_not_found",
        message: `Prerequisite Work ${id} was not found.`,
        remediation: "Check the Work ID on the Work screen or by search, then send the request again.",
        details: { work_id: id },
      });
    }
  }
  const cycle = findPrerequisiteCycle(transaction, workId, ids);
  if (cycle !== null) {
    const views = new Map<string, string>();
    for (const id of cycle) {
      const row = transaction.get<{ title: string; display_number: number | null; project_name: string | null }>(
        "SELECT w.title, w.display_number, p.name AS project_name FROM works w LEFT JOIN projects p ON p.id = w.project_id WHERE w.id = ?",
        id,
      );
      views.set(id, row ? displayName({ work_id: id, project_name: row.project_name, display_number: row.display_number }, "en") : `Work ${id}`);
    }
    throw new HumanReadableError({
      code: "prerequisite_cycle",
      message: `These prerequisites would make Works wait on each other: ${cycle.map((id) => views.get(id)).join(" → ")}.`,
      remediation: "Remove one of the prerequisites on the path.",
      details: { cycle },
    });
  }
  transaction.run("DELETE FROM work_prerequisites WHERE work_id = ?", workId);
  ids.forEach((id, position) => {
    transaction.run(
      "INSERT INTO work_prerequisites (work_id, prerequisite_work_id, position, created_at) VALUES (?, ?, ?, ?)",
      workId,
      id,
      position,
      now,
    );
  });
  return ids;
}

/** Judge a ready Work: start it when every prerequisite is met, or open the Decision for ones that can never be. */
export function settleWorkPrerequisiteWaitInTransaction(
  transaction: CoreWriteLaneTransaction,
  workId: string,
  language: OwnerLanguage,
  now: string,
): "started" | "decision_opened" | "waiting" {
  const work = transaction.get<WorkRow>("SELECT * FROM works WHERE id = ?", workId);
  if (!work || work.state !== "ready") return "waiting";
  const rows = loadRows(transaction, [workId]).get(workId) ?? [];
  if (rows.every((row) => row.verdict === "satisfied")) {
    reduceWorkInTransaction(transaction, workId, { event: "work.started", payload: { explicit_start: true, idempotency_processed: false, now } });
    appendEventInTransaction(transaction, {
      type: "work.prerequisites_satisfied",
      idempotencyKey: `work-prerequisites-satisfied:${workId}:${now}`,
      workId,
      taskId: null,
      payload: { work_id: workId, prerequisite_work_ids: rows.map((row) => row.view.work_id) },
      now,
    });
    return "started";
  }
  const unreachable = rows.filter((row) => row.verdict === "unreachable" && row.decision_id === null);
  if (unreachable.length === 0) return "waiting";
  reduceWorkInTransaction(transaction, workId, { event: "decision.opened", payload: { prerequisite_unreachable: true, now } });
  const items: WorkPrerequisiteBriefItem[] = rows.map((row) => ({
    name: displayName(row.view, language),
    title: row.view.title,
    state: row.view.state,
    missing: row.verdict !== "unreachable" ? null : row.view.deleted ? "deleted" : "cancelled",
  }));
  const decisionId = ensureCoreDecision(transaction, workId, [], workPrerequisiteUnreachableBrief(items, language), now, "work");
  transaction.run(
    `UPDATE work_prerequisites SET decision_id = ? WHERE work_id = ? AND prerequisite_work_id IN (${marks(unreachable.length)})`,
    decisionId,
    workId,
    ...unreachable.map((row) => row.view.work_id),
  );
  return "decision_opened";
}

function isPrerequisiteOptions(optionsJson: string): boolean {
  try {
    const options = JSON.parse(optionsJson) as unknown;
    return Array.isArray(options) && options.some((option) => typeof option === "object" && option !== null && (option as { key?: unknown }).key === DROP_MISSING_PREREQUISITES_OPTION_KEY);
  } catch {
    return false;
  }
}

/**
 * The Owner answered a Decision other than "cancel": drop the prerequisites it asked about.
 * "not_prerequisite" for any other Decision; otherwise whether the rest are all met.
 */
export function resolveWorkPrerequisiteDecisionInTransaction(
  transaction: CoreWriteLaneTransaction,
  decision: { readonly id: string; readonly work_id: string; readonly options_json: string },
): "not_prerequisite" | "satisfied" | "pending" {
  if (!isPrerequisiteOptions(decision.options_json)) return "not_prerequisite";
  transaction.run("DELETE FROM work_prerequisites WHERE work_id = ? AND decision_id = ?", decision.work_id, decision.id);
  const rows = loadRows(transaction, [decision.work_id]).get(decision.work_id) ?? [];
  return rows.every((row) => row.verdict === "satisfied") ? "satisfied" : "pending";
}

/** Whether an open Work-scope Decision asks the Owner about a missing prerequisite. */
export function hasOpenWorkPrerequisiteDecision(reader: WorkPrerequisiteReader, workId: string): boolean {
  return reader
    .all<{ options_json: string }>("SELECT options_json FROM decisions WHERE work_id = ? AND status = 'open' AND scope = 'work'", workId)
    .some((row) => isPrerequisiteOptions(row.options_json));
}

/** Record what a Work was before it is deleted, on the rows of the Works waiting for it. */
export function snapshotDeletedPrerequisiteInTransaction(transaction: CoreWriteLaneTransaction, workId: string): void {
  const work = transaction.get<{ state: string; title: string; project_id: string | null; project_name: string | null; display_number: number | null }>(
    "SELECT w.state, w.title, w.project_id, p.name AS project_name, w.display_number FROM works w LEFT JOIN projects p ON p.id = w.project_id WHERE w.id = ?",
    workId,
  );
  if (!work) return;
  const snapshot: DeletedSnapshot = { deleted_at: utcNow(), ...work };
  transaction.run("UPDATE work_prerequisites SET deleted_json = ? WHERE prerequisite_work_id = ?", JSON.stringify(snapshot), workId);
}

/** The ready Works that wait on this Work, or on any Work when none is given. */
export function waitingWorkIds(reader: WorkPrerequisiteReader, prerequisiteWorkId?: string): string[] {
  return reader
    .all<{ work_id: string }>(
      `SELECT DISTINCT wp.work_id FROM work_prerequisites wp JOIN works w ON w.id = wp.work_id
        WHERE w.state = 'ready' AND (? IS NULL OR wp.prerequisite_work_id = ?) ORDER BY wp.work_id`,
      prerequisiteWorkId ?? null,
      prerequisiteWorkId ?? null,
    )
    .map((row) => row.work_id);
}
