import type { RemakeLimitSettings } from "../../shared/dist/remake-limit-settings.js";
import { EXTERNAL_BLOCKER_EVENT } from "../../shared/dist/external-blocker.js";
import { HumanReadableError } from "./errors";
import { classifyRemakeUnit, nonFunctionalStreak, type MeasuredFile, type RemakeUnit, type RemakeUnitClass } from "./remake-gate";
import type { ChangedFile, CoreSqlValue, CoreWriteLaneTransaction } from "./types";
import { createUlid, utcNow } from "../../db/dist/index.js";

export interface LineageReader {
  get<T extends object>(sql: string, ...parameters: CoreSqlValue[]): T | undefined;
  all<T extends object>(sql: string, ...parameters: CoreSqlValue[]): T[];
}

/** Internal safety cap on one measurement row; not a behaviour setting. */
const MEASUREMENT_FILE_CAP = 5000;
const HISTORY_LINES = 10;

export interface LineageHistoryLine {
  readonly title: string;
  readonly generation: number;
  readonly review_attempts: number;
  readonly worker_runs: number;
  /** Of the totals above: generations / verdicts / launches made while the Task was marked base-sync-only. */
  readonly base_sync_generations: number;
  readonly base_sync_review_attempts: number;
  readonly base_sync_worker_runs: number;
  readonly kind: RemakeUnitClass | "unmeasured";
}

export interface LineageUsage {
  readonly root_task_id: string;
  readonly generations: number;
  /** generations without the base-sync-only ones. */
  readonly main_generations: number;
  /** Main work only: base-sync-only verdicts and launches are counted below. */
  readonly review_attempts: number;
  readonly worker_runs: number;
  readonly base_sync_generations: number;
  readonly base_sync_review_attempts: number;
  readonly base_sync_worker_runs: number;
  readonly non_functional_streak: number;
  readonly last_streak_paths: readonly string[];
  readonly history: readonly LineageHistoryLine[];
}

/** The lineage root of a Task (itself when lineage_root_task_id is NULL). */
export function lineageRootOf(reader: LineageReader, taskId: string): string {
  const row = reader.get<{ lineage_root_task_id: string | null }>("SELECT lineage_root_task_id FROM tasks WHERE id = ?", taskId);
  return row?.lineage_root_task_id ?? taskId;
}

export interface LineageReset {
  readonly at: string;
  readonly review_attempts: number;
  readonly base_sync_review_attempts: number;
  readonly lineage_generation: number;
  readonly base_sync_generations: number;
  /** Absent in snapshots taken before lead_review_rejections existed (read as 0). */
  readonly lead_review_rejections?: number;
}

/** A broken JSON or a missing key means "never restarted" (the limits stay in force). */
export function parseLineageReset(json: string | null | undefined): LineageReset | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    const numbers = ["review_attempts", "base_sync_review_attempts", "lineage_generation", "base_sync_generations"];
    if (typeof value.at !== "string" || numbers.some((key) => typeof value[key] !== "number")) return null;
    return value as unknown as LineageReset;
  } catch (error) {
    console.warn("[owl-core] Ignoring unreadable lineage_reset_json:", error);
    return null;
  }
}

const CHAIN_COLUMNS = "id, work_id, created_at, lineage_root_task_id, replaces_task_ids_json, lineage_reset_json";

interface ChainRow {
  readonly id: string;
  readonly work_id: string;
  readonly created_at: string;
  readonly lineage_root_task_id: string | null;
  readonly replaces_task_ids_json: string;
  readonly lineage_reset_json: string | null;
}

/**
 * taskId itself and the ancestors reached through replaces (same Work, same
 * lineage root), oldest first. Siblings and unrelated cancelled Tasks of the
 * same root are not ancestors. A Task whose budget was restarted is included
 * but its own ancestors are not followed.
 */
export function lineageChainIds(reader: LineageReader, taskId: string): string[] {
  const start = reader.get<ChainRow>(`SELECT ${CHAIN_COLUMNS} FROM tasks WHERE id = ?`, taskId);
  if (!start) return [taskId];
  const root = start.lineage_root_task_id ?? start.id;
  const chain = new Map<string, ChainRow>();
  const visit = (row: ChainRow): void => {
    if (chain.has(row.id)) return;
    chain.set(row.id, row);
    if (parseLineageReset(row.lineage_reset_json)) return;
    let ids: unknown;
    try {
      ids = JSON.parse(row.replaces_task_ids_json || "[]");
    } catch (error) {
      // Why not an Owner event: this is a synchronous read helper with no event writer; stopping at the unreadable ancestor only under-counts attempts, and the log names the Task.
      console.error(`[owl-core] Task ${row.id} has unreadable replaces_task_ids_json; the lineage chain stops here`, error);
      return;
    }
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      const parent = typeof id === "string" ? reader.get<ChainRow>(`SELECT ${CHAIN_COLUMNS} FROM tasks WHERE id = ?`, id) : undefined;
      if (parent && parent.work_id === start.work_id && (parent.lineage_root_task_id ?? parent.id) === root) visit(parent);
    }
  };
  visit(start);
  return [...chain.values()]
    .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1))
    .map((row) => row.id);
}

/** Generations of the chain; counted from 1 again after an Owner restart. */
function chainGenerations(rows: readonly { lineage_generation: number; lineage_reset_json: string | null }[]): number {
  const bases = rows.map((row) => parseLineageReset(row.lineage_reset_json)).filter((reset): reset is LineageReset => reset !== null).map((reset) => reset.lineage_generation - 1);
  const base = bases.length > 0 ? Math.min(...bases) : 0;
  return Math.max(1, Math.max(1, ...rows.map((row) => row.lineage_generation)) - base);
}

export function lineageGenerationCount(reader: LineageReader, taskId: string): number {
  const members = lineageChainIds(reader, taskId);
  return chainGenerations(
    reader.all<{ lineage_generation: number; lineage_reset_json: string | null }>(
      `SELECT lineage_generation, lineage_reset_json FROM tasks WHERE id IN (${members.map(() => "?").join(",")})`,
      ...members,
    ),
  );
}

/** The Owner answered a Decision that blocked the Task: usage counts from here (call inside the decision.resolved transaction). */
export function restartLineageBudgetInTransaction(transaction: CoreWriteLaneTransaction, taskId: string, now: string): void {
  const row = transaction.get<{ total_review_attempts: number; base_sync_review_attempts: number | null; lineage_generation: number; base_sync_generations: number | null; lead_review_rejections: number | null }>(
    "SELECT total_review_attempts, base_sync_review_attempts, lineage_generation, base_sync_generations, lead_review_rejections FROM tasks WHERE id = ?",
    taskId,
  );
  if (!row) return;
  const reset: LineageReset = {
    at: now,
    review_attempts: row.total_review_attempts,
    base_sync_review_attempts: row.base_sync_review_attempts ?? 0,
    lineage_generation: row.lineage_generation,
    base_sync_generations: row.base_sync_generations ?? 0,
    lead_review_rejections: row.lead_review_rejections ?? 0,
  };
  transaction.run("UPDATE tasks SET lineage_reset_json = ? WHERE id = ?", JSON.stringify(reset), taskId);
}

/** Lead-stage rejections still counted over the chains of taskIds (each chain member once). */
export function outstandingLeadRejections(reader: LineageReader, taskIds: readonly string[]): number {
  const members = [...new Set(taskIds.flatMap((id) => lineageChainIds(reader, id)))];
  if (members.length === 0) return 0;
  const rows = reader.all<{ lead_review_rejections: number | null; lineage_reset_json: string | null }>(
    `SELECT lead_review_rejections, lineage_reset_json FROM tasks WHERE id IN (${members.map(() => "?").join(",")})`,
    ...members,
  );
  return Math.max(0, rows.reduce((total, row) => total + (row.lead_review_rejections ?? 0) - (parseLineageReset(row.lineage_reset_json)?.lead_review_rejections ?? 0), 0));
}

/**
 * Set lineage columns for Tasks a replan just created from `replaces`.
 * Must run in the same transaction as the Task creation, before the
 * predecessors are superseded.
 */
export function assignReplacementLineageInTransaction(
  transaction: CoreWriteLaneTransaction,
  workId: string,
  predecessorsByNewTaskId: ReadonlyMap<string, readonly string[]>,
  /** An Owner-initiated replan starts a new lineage: usage counts from 0. */
  restartLineage = false,
): void {
  for (const [newTaskId, predecessorIds] of predecessorsByNewTaskId) {
    const ids = [...new Set(predecessorIds)].sort();
    const predecessors = ids.map((id) => {
      const row = transaction.get<{ id: string; created_at: string; lineage_root_task_id: string | null; lineage_generation: number; lead_designer_start_round: number | null; design_escalated: number }>(
        "SELECT id, created_at, lineage_root_task_id, lineage_generation, lead_designer_start_round, design_escalated FROM tasks WHERE id = ? AND work_id = ?",
        id,
        workId,
      );
      if (!row) {
        throw new HumanReadableError({
          code: "replan_lineage_predecessor_missing",
          message: `Task ${id} replaced by ${newTaskId} was not found in Work ${workId}.`,
          remediation: "Refresh the Work and ask the Manager to replan again.",
          details: { work_id: workId, task_id: id },
        });
      }
      return { ...row, root: row.lineage_root_task_id ?? row.id };
    });
    if (predecessors.length === 0) continue;
    // A replacement design Task of an escalated one starts at the Lead tier, or the Lead-stage stop would never apply to it.
    const escalated = predecessors.some((predecessor) => predecessor.design_escalated === 1);
    const promote = (): void => {
      if (escalated) transaction.run("UPDATE tasks SET lead_designer_start_round = COALESCE(lead_designer_start_round, 0), design_escalated = 1 WHERE id = ? AND type = 'design'", newTaskId);
    };
    if (restartLineage) {
      // Only Lead-stage rejections are carried over; an Owner answer to a Decision resets them via the snapshot.
      const carried = outstandingLeadRejections(transaction, ids);
      transaction.run("UPDATE tasks SET replaces_task_ids_json = ?, lead_review_rejections = ? WHERE id = ?", JSON.stringify(ids), carried, newTaskId);
      if (carried > 0) promote();
      continue;
    }
    promote();
    const roots = [...new Set(predecessors.map((predecessor) => predecessor.root))];
    const rootRows = roots.map((id) => transaction.get<{ id: string; created_at: string }>("SELECT id, created_at FROM tasks WHERE id = ?", id)!);
    rootRows.sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1));
    const root = rootRows[0]!.id;
    for (const other of roots.filter((id) => id !== root)) {
      transaction.run(
        "UPDATE tasks SET lineage_root_task_id = ? WHERE work_id = ? AND (lineage_root_task_id = ? OR id = ?) AND id <> ?",
        root,
        workId,
        other,
        other,
        root,
      );
    }
    transaction.run(
      "UPDATE tasks SET lineage_root_task_id = ?, lineage_generation = ?, replaces_task_ids_json = ? WHERE id = ?",
      root,
      Math.max(...predecessors.map((predecessor) => predecessor.lineage_generation)) + 1,
      JSON.stringify(ids),
      newTaskId,
    );
  }
}

/**
 * Verdicts over the ancestors of taskId (taskId excluded), split into main
 * work and base-sync-only, minus what taskId itself had before an Owner
 * restart (so the value can be negative).
 */
export function lineageReviewAttemptsExcluding(reader: LineageReader, taskId: string): { main: number; base_sync: number; lead: number } {
  const members = lineageChainIds(reader, taskId).filter((id) => id !== taskId);
  const own = reader.get<{ lineage_reset_json: string | null }>("SELECT lineage_reset_json FROM tasks WHERE id = ?", taskId);
  const ownReset = parseLineageReset(own?.lineage_reset_json);
  let main = ownReset ? ownReset.base_sync_review_attempts - ownReset.review_attempts : 0;
  let baseSync = ownReset ? 0 - ownReset.base_sync_review_attempts : 0;
  let lead = ownReset ? 0 - (ownReset.lead_review_rejections ?? 0) : 0;
  if (members.length > 0) {
    const rows = reader.all<{ total_review_attempts: number; base_sync_review_attempts: number | null; lead_review_rejections: number | null; lineage_reset_json: string | null }>(
      `SELECT total_review_attempts, base_sync_review_attempts, lead_review_rejections, lineage_reset_json FROM tasks WHERE id IN (${members.map(() => "?").join(",")})`,
      ...members,
    );
    for (const row of rows) {
      const reset = parseLineageReset(row.lineage_reset_json);
      const bs = (row.base_sync_review_attempts ?? 0) - (reset?.base_sync_review_attempts ?? 0);
      main += row.total_review_attempts - (reset?.review_attempts ?? 0) - bs;
      baseSync += bs;
      lead += (row.lead_review_rejections ?? 0) - (reset?.lead_review_rejections ?? 0);
    }
  }
  return { main, base_sync: baseSync, lead };
}

export interface LineageReviewHistoryEntry {
  readonly task_title: string;
  readonly round: number;
  readonly verdict: string;
  readonly findings: readonly Record<string, unknown>[];
}

/** Non-pass verdicts over the chain of taskId since each member's last Owner restart, oldest first (minor findings left out). */
export function lineageReviewHistory(reader: LineageReader, taskId: string): LineageReviewHistoryEntry[] {
  const members = lineageChainIds(reader, taskId);
  const rows = reader.all<{ title: string; round: number; verdict: string; findings_json: string }>(
    `SELECT t.title, r.round, r.verdict, r.findings_json FROM reviews r JOIN tasks t ON t.id = r.task_id
      WHERE r.task_id IN (${members.map(() => "?").join(",")}) AND r.verdict <> 'pass'
        AND r.created_at >= COALESCE(json_extract(t.lineage_reset_json, '$.at'), '')
      ORDER BY r.created_at ASC, r.id ASC`,
    ...members,
  );
  return rows.map((row) => {
    let findings: unknown;
    try {
      findings = JSON.parse(row.findings_json);
    } catch (error) {
      console.warn(`[owl-core] Ignoring unreadable findings_json of Task ${row.title}:`, error);
      findings = [];
    }
    return {
      task_title: row.title,
      round: row.round,
      verdict: row.verdict,
      findings: (Array.isArray(findings) ? findings : []).filter((finding): finding is Record<string, unknown> => typeof finding === "object" && finding !== null && (finding as { severity?: unknown }).severity !== "minor"),
    };
  });
}

interface MeasurementRow {
  readonly id: string;
  readonly task_id: string;
  readonly lineage_generation: number;
  readonly task_type: string;
  readonly measured: number;
  readonly base_sync_only: number;
  readonly files_json: string;
  readonly created_at: string;
}

const measuredFiles = (row: MeasurementRow): MeasuredFile[] => JSON.parse(row.files_json) as MeasuredFile[];

function mergeBaselines(parts: readonly (readonly MeasuredFile[])[]): MeasuredFile[] {
  const merged = new Map<string, string>();
  for (const part of parts) {
    for (const file of part) {
      const known = merged.get(file.path);
      merged.set(file.path, known === undefined || known === file.hash ? file.hash : "conflict");
    }
  }
  return [...merged].map(([path, hash]) => ({ path, hash }));
}

/** The lineage's change units, newest first, each with the baseline it is compared to. */
function lineageUnits(reader: LineageReader, members: readonly string[], cutoffs: ReadonlyMap<string, string>): RemakeUnit[] {
  if (members.length === 0) return [];
  const rows = reader.all<MeasurementRow>(
    `SELECT id, task_id, lineage_generation, task_type, measured, base_sync_only, files_json, created_at
       FROM task_change_measurements WHERE task_id IN (${members.map(() => "?").join(",")})
      ORDER BY created_at ASC, id ASC`,
    ...members,
  );
  const lastByUnit = new Map<string, MeasurementRow>();
  // A unit is represented by its latest verification; if that one could not be
  // measured the unit is neutral, an earlier measurement is not reused.
  for (const row of rows) lastByUnit.set(`${row.task_id}:${row.lineage_generation}`, row);
  const lastOf = (taskId: string, below: number): MeasurementRow | undefined =>
    [...lastByUnit.values()].filter((row) => row.task_id === taskId && row.lineage_generation < below).sort((a, b) => b.lineage_generation - a.lineage_generation)[0];
  const lastOfTask = (taskId: string): MeasurementRow | undefined => lastOf(taskId, Number.MAX_SAFE_INTEGER);
  // Units from before an Owner restart stay as comparison baselines but are not counted.
  const units = [...lastByUnit.values()].filter((row) => row.created_at >= (cutoffs.get(row.task_id) ?? "")).map((row) => {
    let baseline: MeasuredFile[] | null = [];
    const previous = lastOf(row.task_id, row.lineage_generation);
    if (previous) {
      baseline = previous.measured === 1 ? measuredFiles(previous) : null;
    } else {
      const replaced = reader.get<{ replaces_task_ids_json: string }>("SELECT replaces_task_ids_json FROM tasks WHERE id = ?", row.task_id);
      const ids = JSON.parse(replaced?.replaces_task_ids_json ?? "[]") as string[];
      const parts = ids.map((id) => lastOfTask(id)).filter((entry): entry is MeasurementRow => entry !== undefined);
      if (parts.some((part) => part.measured === 0)) baseline = null;
      else baseline = mergeBaselines(parts.map(measuredFiles));
    }
    return {
      created_at: row.created_at,
      id: row.id,
      unit: {
        task_id: row.task_id,
        generation: row.lineage_generation,
        task_type: row.task_type,
        measured: row.measured === 1,
        files: measuredFiles(row),
        baseline,
        base_sync_only: row.base_sync_only === 1,
      } satisfies RemakeUnit,
    };
  });
  units.sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1));
  return units.map((entry) => entry.unit);
}

/** External blocker reports over the lineage of taskId since each Task's last Owner answer, not counting the run excludeAgentRunId. */
export function lineageExternalBlockerReports(reader: LineageReader, taskId: string, excludeAgentRunId: string | null): number {
  const members = lineageChainIds(reader, taskId);
  const placeholders = members.map(() => "?").join(",");
  return reader.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM events
      WHERE task_id IN (${placeholders}) AND type = ?
        AND (? IS NULL OR agent_run_id IS NULL OR agent_run_id <> ?)
        AND created_at >= COALESCE((SELECT json_extract(t.lineage_reset_json, '$.at') FROM tasks t WHERE t.id = events.task_id), '')`,
    ...members, EXTERNAL_BLOCKER_EVENT, excludeAgentRunId, excludeAgentRunId,
  )?.count ?? 0;
}

/** What the lineage of taskId has used so far (Reviewer verdicts, Worker runs, non-functional remakes). */
export function lineageUsage(reader: LineageReader, taskId: string, settings: RemakeLimitSettings): LineageUsage {
  const rootId = lineageRootOf(reader, taskId);
  const members = lineageChainIds(reader, taskId);
  const placeholders = members.map(() => "?").join(",");
  const tasks = reader.all<{ id: string; title: string; lineage_generation: number; total_review_attempts: number; base_sync_generations: number; base_sync_review_attempts: number; lineage_reset_json: string | null }>(
    `SELECT id, title, lineage_generation, total_review_attempts, base_sync_generations, base_sync_review_attempts, lineage_reset_json FROM tasks WHERE id IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
    ...members,
  );
  const runs = reader.all<{ task_id: string; base_sync_only: number; count: number }>(
    `SELECT task_id, base_sync_only, COUNT(*) AS count FROM agent_runs
      WHERE task_id IN (${placeholders}) AND role IN ('worker', 'designer') AND status IN ('completed', 'failed')
        AND (outcome IS NULL OR outcome <> 'question')
        AND NOT EXISTS (SELECT 1 FROM events WHERE events.agent_run_id = agent_runs.id AND events.type IN ('task.process_wait_started', '${EXTERNAL_BLOCKER_EVENT}'))
        AND agent_runs.created_at >= COALESCE((SELECT json_extract(t.lineage_reset_json, '$.at') FROM tasks t WHERE t.id = agent_runs.task_id), '')
      GROUP BY task_id, base_sync_only`,
    ...members,
  );
  const runsOf = (taskId: string, baseSync: number): number => runs.filter((row) => row.task_id === taskId && (row.base_sync_only === 1 ? 1 : 0) === baseSync).reduce((total, row) => total + row.count, 0);
  const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
  const resets = new Map(tasks.map((row) => [row.id, parseLineageReset(row.lineage_reset_json)] as const));
  const cutoffs = new Map([...resets].filter((entry): entry is [string, LineageReset] => entry[1] !== null).map(([id, reset]) => [id, reset.at] as const));
  const reviewsOf = (row: (typeof tasks)[number]): number => row.total_review_attempts - (resets.get(row.id)?.review_attempts ?? 0);
  const baseSyncReviewsOf = (row: (typeof tasks)[number]): number => (row.base_sync_review_attempts ?? 0) - (resets.get(row.id)?.base_sync_review_attempts ?? 0);
  const baseSyncGenerationsOf = (row: (typeof tasks)[number]): number => (row.base_sync_generations ?? 0) - (resets.get(row.id)?.base_sync_generations ?? 0);
  const units = lineageUnits(reader, members, cutoffs);
  const streak = nonFunctionalStreak(units, settings);
  const kindByTask = new Map<string, LineageHistoryLine["kind"]>();
  for (const unit of units) {
    if (!kindByTask.has(unit.task_id)) kindByTask.set(unit.task_id, unit.measured ? classifyRemakeUnit(unit, settings).kind : "unmeasured");
  }
  const history = tasks
    .map((row) => ({
      title: row.title,
      generation: row.lineage_generation,
      review_attempts: reviewsOf(row),
      worker_runs: runsOf(row.id, 0) + runsOf(row.id, 1),
      base_sync_generations: baseSyncGenerationsOf(row),
      base_sync_review_attempts: baseSyncReviewsOf(row),
      base_sync_worker_runs: runsOf(row.id, 1),
      kind: kindByTask.get(row.id) ?? ("unmeasured" as const),
    }))
    .reverse()
    .slice(0, HISTORY_LINES);
  const generations = chainGenerations(tasks);
  const baseSyncGenerations = sum(tasks.map(baseSyncGenerationsOf));
  const baseSyncReviews = sum(tasks.map(baseSyncReviewsOf));
  return {
    root_task_id: rootId,
    generations,
    main_generations: Math.max(0, generations - baseSyncGenerations),
    review_attempts: sum(tasks.map(reviewsOf)) - baseSyncReviews,
    worker_runs: sum(runs.filter((row) => row.base_sync_only !== 1).map((row) => row.count)),
    base_sync_generations: baseSyncGenerations,
    base_sync_review_attempts: baseSyncReviews,
    base_sync_worker_runs: sum(runs.filter((row) => row.base_sync_only === 1).map((row) => row.count)),
    non_functional_streak: streak.streak,
    last_streak_paths: streak.paths,
    history,
  };
}

/** Insert one task_change_measurements row (called in the verification.completed transaction). */
export function recordTaskChangeMeasurementInTransaction(
  transaction: CoreWriteLaneTransaction,
  input: {
    readonly workId: string;
    readonly taskId: string;
    readonly agentRunId: string | null;
    readonly changes: readonly ChangedFile[] | null;
    /** The changes list only what this generation touched; files an earlier generation of the same Task left alone are carried over. */
    readonly sinceGenerationStart?: boolean;
    readonly now?: string;
  },
): void {
  const task = transaction.get<{ lineage_generation: number; type: string; base_sync_only: number }>("SELECT lineage_generation, type, base_sync_only FROM tasks WHERE id = ?", input.taskId);
  if (!task) return;
  const usable =
    input.changes !== null &&
    input.changes.length <= MEASUREMENT_FILE_CAP &&
    input.changes.every((change) => typeof change.content_hash === "string");
  let files: MeasuredFile[] = usable ? input.changes!.map((change) => ({ path: change.path, hash: change.content_hash as string })) : [];
  if (usable && input.sinceGenerationStart) {
    const earlier = transaction.get<{ measured: number; files_json: string }>(
      "SELECT measured, files_json FROM task_change_measurements WHERE task_id = ? AND lineage_generation < ? ORDER BY lineage_generation DESC, created_at DESC, id DESC LIMIT 1",
      input.taskId,
      task.lineage_generation,
    );
    if (earlier?.measured === 1) {
      const merged = new Map((JSON.parse(earlier.files_json) as MeasuredFile[]).map((file) => [file.path, file.hash]));
      for (const file of files) merged.set(file.path, file.hash);
      files = [...merged].map(([path, hash]) => ({ path, hash }));
    }
  }
  transaction.run(
    `INSERT INTO task_change_measurements
       (id, work_id, task_id, agent_run_id, lineage_generation, task_type, measured, base_sync_only, files_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    createUlid(),
    input.workId,
    input.taskId,
    input.agentRunId,
    task.lineage_generation,
    task.type,
    usable ? 1 : 0,
    task.base_sync_only,
    JSON.stringify(files),
    input.now ?? utcNow(),
  );
}
