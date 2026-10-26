import { isGoalCriterion, isNonBlankReason, readStoredAcceptanceCriteria, type GoalShortfall, type StoredAcceptanceCriterion, type WorkGoalRecord } from "../../shared/dist/acceptance-criteria.js";
import { workSummaryListItems } from "../../shared/dist/work-summary.js";
import { validationError } from "./errors";
import type { FinalManagerVerdict } from "./final-verdict";
import type { LineageReader } from "./task-lineage";
import type { CoreWriteLaneTransaction } from "./types";

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);

/** The ids of the goal criteria among a Task's stored criteria. */
export const goalCriterionIds = (criteria: readonly StoredAcceptanceCriterion[]): string[] =>
  criteria.filter(isGoalCriterion).map((criterion) => criterion.id);

/** The goal shortfalls a Worker report states: its goal_unmet items whose id is a goal criterion of the Task. */
export function goalShortfallsFromReport(report: unknown, criteria: readonly StoredAcceptanceCriterion[]): GoalShortfall[] {
  const verification = isObj(report) && isObj(report.verification) ? report.verification : {};
  const acceptance = Array.isArray(verification.acceptance) ? verification.acceptance : [];
  const goals = new Map(criteria.filter(isGoalCriterion).map((criterion) => [criterion.id, criterion]));
  const shortfalls: GoalShortfall[] = [];
  for (const item of acceptance) {
    if (!isObj(item) || item.status !== "goal_unmet" || typeof item.criterion_id !== "string") continue;
    const criterion = goals.get(item.criterion_id);
    if (criterion && isNonBlankReason(item.shortfall_reason)) {
      shortfalls.push({ criterion_id: criterion.id, text: criterion.text, reason: item.shortfall_reason.trim(), source: "worker" });
    }
  }
  return shortfalls;
}

/** The sum of two lists: an entry of `added` replaces the one with the same criterion and source; nothing is removed. */
export function addGoalShortfalls(existing: readonly GoalShortfall[], added: readonly GoalShortfall[]): GoalShortfall[] {
  const same = (a: GoalShortfall, b: GoalShortfall): boolean => a.criterion_id === b.criterion_id && a.source === b.source;
  return [...existing.filter((entry) => !added.some((next) => same(entry, next))), ...added];
}

/** Reads tasks.goal_shortfalls_json; NULL, damaged JSON and malformed entries read as no record. */
export function readTaskGoalShortfalls(json: string | null | undefined): GoalShortfall[] {
  if (typeof json !== "string" || json === "") return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is GoalShortfall => isObj(entry) && typeof entry.criterion_id === "string" && typeof entry.text === "string" &&
      isNonBlankReason(entry.reason) && (entry.source === "worker" || entry.source === "reviewer"));
  } catch {
    console.warn("[owl-core] tasks.goal_shortfalls_json is not valid JSON; reading it as empty");
    return [];
  }
}

/** A Worker success replaces the column with this run's shortfalls (NULL when none), so a goal met by a later attempt is not kept as unmet. */
export function replaceTaskGoalShortfalls(transaction: CoreWriteLaneTransaction, taskId: string, shortfalls: readonly GoalShortfall[]): void {
  const blank = shortfalls.find((entry) => !isNonBlankReason(entry.reason));
  if (blank) throw new Error(`A goal shortfall needs a reason: ${blank.criterion_id}`);
  transaction.run("UPDATE tasks SET goal_shortfalls_json = ? WHERE id = ?", shortfalls.length === 0 ? null : JSON.stringify(shortfalls), taskId);
}

/** Adds to what is stored (for the Reviewer), and refuses a record without a reason. */
export function recordTaskGoalShortfalls(transaction: CoreWriteLaneTransaction, taskId: string, added: readonly GoalShortfall[]): void {
  if (added.length === 0) return;
  const blank = added.find((entry) => !isNonBlankReason(entry.reason));
  if (blank) throw new Error(`A goal shortfall needs a reason: ${blank.criterion_id}`);
  const row = transaction.get<{ goal_shortfalls_json: string | null }>("SELECT goal_shortfalls_json FROM tasks WHERE id = ?", taskId);
  const merged = addGoalShortfalls(readTaskGoalShortfalls(row?.goal_shortfalls_json), added);
  transaction.run("UPDATE tasks SET goal_shortfalls_json = ? WHERE id = ?", JSON.stringify(merged), taskId);
}

/** A condition of the Work the final check can point at; Core builds it from stored data on every final check. */
export interface FinalCriterionRef {
  /** work:A<k> (Acceptance line), work:G<k> (Goals line) or task:<task_id>:<ACk>. */
  readonly ref: string;
  readonly requirement: "required" | "goal";
  readonly text: string;
  readonly task_id: string | null;
  readonly criterion_id: string | null;
}

/** A goal unmet as listed for the Owner (Work view, work.completed, final check context). */
export interface WorkGoalShortfall {
  readonly task_id: string | null;
  readonly task_title: string | null;
  readonly criterion_id: string | null;
  readonly text: string;
  readonly reason: string;
  readonly source: "worker" | "reviewer" | "final_check";
  readonly resolution: { readonly evidence: string; readonly resolved_at: string } | null;
}

export type WorkGoalRecordInput = Omit<WorkGoalRecord, "recorded_at" | "resolution">;

export interface SettledFinalVerdict {
  readonly verdict: FinalManagerVerdict;
  readonly goal_items: readonly WorkGoalRecordInput[];
  readonly goals_met: FinalManagerVerdict["goals_met"];
}

interface IndexedTask {
  readonly id: string;
  readonly status: string;
  readonly acceptance: string;
  readonly acceptance_criteria_json: string | null;
}

/** Every condition of the Work: Acceptance lines are required, Goals lines are goals (a line in both sections is required), and each completed Task's criteria keep their stored requirement. */
export function finalCriteriaIndex(summary: string | null, tasks: readonly IndexedTask[]): FinalCriterionRef[] {
  const text = summary ?? "";
  const acceptance = workSummaryListItems(text, "acceptance");
  const index: FinalCriterionRef[] = acceptance.map((line, i) => ({ ref: `work:A${i + 1}`, requirement: "required", text: line, task_id: null, criterion_id: null }));
  workSummaryListItems(text, "goals").forEach((line, i) => {
    if (!acceptance.includes(line)) index.push({ ref: `work:G${i + 1}`, requirement: "goal", text: line, task_id: null, criterion_id: null });
  });
  for (const task of tasks) {
    if (task.status !== "completed") continue;
    for (const criterion of readStoredAcceptanceCriteria(task.acceptance_criteria_json, task.acceptance)) {
      index.push({ ref: `task:${task.id}:${criterion.id}`, requirement: isGoalCriterion(criterion) ? "goal" : "required", text: criterion.text, task_id: task.id, criterion_id: criterion.id });
    }
  }
  return index;
}

/**
 * Splits the Manager's missing items by the stored requirement of the ref they name: a goal item moves to goal_items,
 * anything else (no ref, unknown ref, required ref) stays required. A required item forces incomplete; only goal items
 * makes complete. The Manager's own wording never decides whether an item is a goal.
 */
export function settleFinalVerdict(verdict: FinalManagerVerdict, index: readonly FinalCriterionRef[]): SettledFinalVerdict {
  const byRef = new Map(index.map((entry) => [entry.ref, entry]));
  const required: FinalManagerVerdict["missing"][number][] = [];
  const goalItems: WorkGoalRecordInput[] = [];
  for (const item of verdict.missing) {
    const target = typeof item.criterion_ref === "string" ? byRef.get(item.criterion_ref) : undefined;
    if (typeof item.criterion_ref === "string" && target === undefined) console.warn(`[owl-core] The final check named a criterion_ref that is not in criteria_index (${item.criterion_ref}); counting the item as required`);
    if (target === undefined || target.requirement !== "goal") {
      required.push(item);
      continue;
    }
    if (!isNonBlankReason(item.reason)) throw validationError("The final Manager verdict missing reason is blank for a goal.", { criterion_ref: target.ref, final_check_retry: true });
    goalItems.push({ task_id: target.task_id, criterion_id: target.criterion_id, text: target.text, reason: item.reason.trim(), source: "final_check" });
  }
  let verdictValue = verdict.verdict;
  if (required.length > 0) verdictValue = "incomplete";
  else if (verdict.missing.length > 0) {
    if (verdict.verdict === "incomplete") console.warn("[owl-core] The final check listed only unmet goals as missing; completing the Work");
    verdictValue = "complete";
  }
  return { verdict: { ...verdict, verdict: verdictValue, missing: required }, goal_items: goalItems, goals_met: verdict.goals_met };
}

/** Reads works.goal_shortfalls_json; NULL, damaged JSON and malformed entries read as no record. */
export function readWorkGoalRecords(json: string | null | undefined): WorkGoalRecord[] {
  if (typeof json !== "string" || json === "") return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is WorkGoalRecord => isObj(entry) && typeof entry.text === "string" && isNonBlankReason(entry.reason) &&
      typeof entry.recorded_at === "string" && (entry.task_id === null || typeof entry.task_id === "string") && (entry.criterion_id === null || typeof entry.criterion_id === "string") &&
      (entry.resolution === null || (isObj(entry.resolution) && typeof entry.resolution.evidence === "string" && typeof entry.resolution.resolved_at === "string")));
  } catch {
    console.warn("[owl-core] works.goal_shortfalls_json is not valid JSON; reading it as empty");
    return [];
  }
}

type GoalKey = { readonly task_id: string | null; readonly criterion_id: string | null; readonly text: string };
const sameGoal = (a: GoalKey, b: GoalKey): boolean => a.task_id === b.task_id && (a.task_id === null ? a.text === b.text : a.criterion_id === b.criterion_id);

/**
 * Updates works.goal_shortfalls_json for one final check and returns whether it changed:
 * a new unmet goal is added (unless its Task already records that criterion), a repeated one gets the new reason and loses its resolution,
 * and a goal not named again is left alone. A recorded goal is resolved only by a goals_met entry that names a goal ref with evidence,
 * after a Task completed that was created later than the record, and that the same verdict does not list as missing.
 */
export function recordFinalGoalShortfalls(transaction: CoreWriteLaneTransaction, workId: string, settled: SettledFinalVerdict, index: readonly FinalCriterionRef[], now: string): boolean {
  const row = transaction.get<{ goal_shortfalls_json: string | null }>("SELECT goal_shortfalls_json FROM works WHERE id = ?", workId);
  const records = readWorkGoalRecords(row?.goal_shortfalls_json);
  const before = JSON.stringify(records);
  for (const item of settled.goal_items) {
    const i = records.findIndex((record) => sameGoal(record, item));
    if (i >= 0) {
      records[i] = { ...records[i]!, reason: item.reason, resolution: null };
      continue;
    }
    if (item.task_id !== null) {
      const task = transaction.get<{ goal_shortfalls_json: string | null }>("SELECT goal_shortfalls_json FROM tasks WHERE id = ?", item.task_id);
      if (readTaskGoalShortfalls(task?.goal_shortfalls_json).some((entry) => entry.criterion_id === item.criterion_id)) continue;
    }
    records.push({ ...item, recorded_at: now, resolution: null });
  }
  for (const met of settled.goals_met) {
    const target = index.find((entry) => entry.ref === met.criterion_ref && entry.requirement === "goal");
    const i = target === undefined ? -1 : records.findIndex((record) => record.resolution === null && sameGoal(record, target));
    const listedMissing = target !== undefined && settled.goal_items.some((item) => sameGoal(item, target));
    const later = i < 0 ? undefined : transaction.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM tasks WHERE work_id = ? AND status = 'completed' AND created_at > ?", workId, records[i]!.recorded_at);
    if (i < 0 || listedMissing || !isNonBlankReason(met.evidence) || (later?.n ?? 0) === 0) {
      console.warn(`[owl-core] Ignoring goals_met ${met.criterion_ref}: it does not meet the rules for resolving a recorded goal`);
      continue;
    }
    records[i] = { ...records[i]!, resolution: { evidence: met.evidence.trim(), resolved_at: now } };
  }
  if (JSON.stringify(records) === before) return false;
  transaction.run("UPDATE works SET goal_shortfalls_json = ? WHERE id = ?", records.length === 0 ? null : JSON.stringify(records), workId);
  return true;
}

/** Every goal the Work did not meet: completed Tasks' records in plan order, then the Work's own records by recorded_at. Always an array. */
export function goalShortfallsOfWork(reader: LineageReader, workId: string): WorkGoalShortfall[] {
  const tasks = reader.all<{ id: string; title: string; goal_shortfalls_json: string | null }>(
    "SELECT id, title, goal_shortfalls_json FROM tasks WHERE work_id = ? AND status = 'completed' ORDER BY created_at ASC, id ASC", workId);
  const titles = new Map(tasks.map((task) => [task.id, task.title]));
  const fromTasks = tasks.flatMap((task) => readTaskGoalShortfalls(task.goal_shortfalls_json).map((entry): WorkGoalShortfall => ({
    task_id: task.id, task_title: task.title, criterion_id: entry.criterion_id, text: entry.text, reason: entry.reason, source: entry.source, resolution: null,
  })));
  const row = reader.get<{ goal_shortfalls_json: string | null }>("SELECT goal_shortfalls_json FROM works WHERE id = ?", workId);
  const fromWork = readWorkGoalRecords(row?.goal_shortfalls_json)
    .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at))
    .map((record): WorkGoalShortfall => ({
      task_id: record.task_id, task_title: record.task_id === null ? null : titles.get(record.task_id) ?? null, criterion_id: record.criterion_id,
      text: record.text, reason: record.reason, source: record.source, resolution: record.resolution,
    }));
  return [...fromTasks, ...fromWork];
}
