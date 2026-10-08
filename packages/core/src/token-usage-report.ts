import { tokenUsagePeriodRange } from "../../shared/dist/token-usage-report.js";
import type { TokenUsageHarness, TokenUsageMetrics, TokenUsagePeriod, TokenUsageTaskTotals, TokenUsageReport, TokenUsageRole, TokenUsageTotals } from "../../shared/dist/token-usage-report.js";
import { storedTokenUsage } from "../../shared/dist/token-usage.js";
import { createUlid } from "../../db/dist/index.js";
import type { CoreDatabase, CoreWriteLaneTransaction } from "./types.js";

const TOKEN_KEYS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] as const;
const MAX_SAFE_TOKEN = 9007199254740991;

export interface TokenUsageReportInput {
  readonly period: TokenUsagePeriod;
  readonly top: number;
  readonly now: Date;
  readonly harnessOf: (provider: string) => "claude" | "codex" | undefined;
}

interface RunAggregate {
  readonly work_id: string;
  readonly title: string | null;
  readonly display_number: number | null;
  readonly project_id: string | null;
  readonly state: string | null;
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly date: string;
  readonly runs: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
}

type RunRow = Omit<RunAggregate, "runs" | "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens"> & { readonly usage_json: string };

interface TaskRunRow {
  readonly id: string;
  readonly task_id: string;
  readonly role: string;
  readonly provider: string;
  readonly usage_json: string;
  readonly at: string;
  readonly work_id: string;
  readonly title: string;
  readonly status: string;
  readonly first_review_id: string | null;
  readonly first_verdict: string | null;
  readonly first_review_at: string | null;
}

const HAS_USAGE = `CASE WHEN json_valid(agent_runs.usage_json) THEN CASE WHEN (
  ${TOKEN_KEYS.map((key) => `json_type(agent_runs.usage_json, '$.${key}') = 'integer' AND json_extract(agent_runs.usage_json, '$.${key}') BETWEEN 0 AND ${MAX_SAFE_TOKEN}`).join(" OR ")}
) THEN 1 ELSE 0 END ELSE 0 END`;

interface TaskRoleRow {
  readonly task_id: string;
  readonly work_id: string;
  readonly title: string;
  readonly status: string;
  readonly role: string;
  readonly first_verdict: string | null;
  readonly runs: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly uncached_input_tokens: number;
  readonly tokens_after_first_review: number;
}

/** Metrics for a group: uncached comes from every run of the group, review figures from its Task rows. */
function metricsOf(uncached: number, runs: number, taskRows: readonly TaskRoleRow[]): TokenUsageMetrics {
  const tasks = new Map<string, TaskRoleRow>();
  let after = 0;
  for (const row of taskRows) {
    tasks.set(row.task_id, row);
    after += row.tokens_after_first_review;
  }
  const reviewed = [...tasks.values()].filter((task) => task.first_verdict !== null);
  const completed = [...tasks.values()].filter((task) => task.status === "completed").length;
  return {
    uncached_input_tokens: uncached,
    tokens_after_first_review: after,
    first_review_pass_rate: reviewed.length === 0 ? null : reviewed.filter((task) => task.first_verdict === "pass").length / reviewed.length,
    completed_tasks: completed,
    uncached_input_tokens_per_completed_task: completed === 0 ? null : uncached / completed,
    runs_per_completed_task: completed === 0 ? null : runs / completed,
  };
}

function emptyTotals(): TokenUsageTotals {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0, runs: 0 };
}

function addTotals(target: TokenUsageTotals, usage: Omit<TokenUsageTotals, "total_tokens" | "runs">, runs: number): TokenUsageTotals {
  const input_tokens = target.input_tokens + usage.input_tokens;
  const output_tokens = target.output_tokens + usage.output_tokens;
  const cache_read_tokens = target.cache_read_tokens + usage.cache_read_tokens;
  const cache_write_tokens = target.cache_write_tokens + usage.cache_write_tokens;
  return {
    input_tokens,
    output_tokens,
    cache_read_tokens,
    cache_write_tokens,
    total_tokens: input_tokens + output_tokens + cache_read_tokens + cache_write_tokens,
    runs: target.runs + runs,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildTokenUsageReport(
  db: Pick<CoreDatabase, "all" | "get">,
  input: TokenUsageReportInput,
): TokenUsageReport {
  if (!Number.isSafeInteger(input.top) || input.top < 1 || input.top > 50) throw new RangeError("Token usage top must be an integer from 1 to 50.");
  const { since, until, dates } = tokenUsagePeriodRange(input.period, input.now);
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();
  // Every run goes through the stored-usage read boundary (shared), so rows are summed as normalized values.
  const usageOf = (provider: string, usageJson: string) => storedTokenUsage(input.harnessOf(provider), usageJson);
  const runRows = db.all<RunRow>(
    `SELECT agent_runs.work_id, works.title, works.display_number, works.project_id, works.state,
            agent_runs.role, agent_runs.provider, agent_runs.model, agent_runs.usage_json,
            strftime('%Y-%m-%d', COALESCE(agent_runs.ended_at, agent_runs.updated_at), 'localtime') AS date
       FROM agent_runs JOIN works ON works.id = agent_runs.work_id
      WHERE agent_runs.usage_json IS NOT NULL
        AND COALESCE(agent_runs.ended_at, agent_runs.updated_at) >= ?
        AND COALESCE(agent_runs.ended_at, agent_runs.updated_at) < ?`,
    sinceIso,
    untilIso,
  );
  const groups = new Map<string, RunAggregate>();
  for (const { usage_json, ...run } of runRows) {
    const usage = usageOf(run.provider, usage_json);
    if (usage === null) continue;
    const key = JSON.stringify([run.work_id, run.role, run.provider, run.model, run.date]);
    const prior = groups.get(key);
    groups.set(key, {
      ...run,
      runs: (prior?.runs ?? 0) + 1,
      input_tokens: (prior?.input_tokens ?? 0) + usage.input_tokens,
      output_tokens: (prior?.output_tokens ?? 0) + usage.output_tokens,
      cache_read_tokens: (prior?.cache_read_tokens ?? 0) + usage.cache_read_tokens,
      cache_write_tokens: (prior?.cache_write_tokens ?? 0) + usage.cache_write_tokens,
    });
  }
  const rows = [...groups.values()];
  const taskRunRows = db.all<TaskRunRow>(
    `SELECT agent_runs.id, agent_runs.task_id, agent_runs.role, agent_runs.provider, agent_runs.usage_json,
            COALESCE(agent_runs.ended_at, agent_runs.updated_at) AS at,
            tasks.work_id, tasks.title, tasks.status, fr.id AS first_review_id, fr.verdict AS first_verdict, fr.created_at AS first_review_at
       FROM agent_runs JOIN tasks ON tasks.id = agent_runs.task_id
       LEFT JOIN reviews fr ON fr.id = (SELECT id FROM reviews WHERE task_id = agent_runs.task_id ORDER BY round LIMIT 1)
      WHERE agent_runs.usage_json IS NOT NULL
        AND COALESCE(agent_runs.ended_at, agent_runs.updated_at) >= ?
        AND COALESCE(agent_runs.ended_at, agent_runs.updated_at) < ?`,
    sinceIso,
    untilIso,
  );
  const taskGroups = new Map<string, TaskRoleRow>();
  for (const run of taskRunRows) {
    const usage = usageOf(run.provider, run.usage_json);
    if (usage === null) continue;
    const key = JSON.stringify([run.task_id, run.role]);
    const prior = taskGroups.get(key);
    const afterFirstReview = run.first_review_at !== null && run.id !== run.first_review_id && run.at > run.first_review_at;
    taskGroups.set(key, {
      task_id: run.task_id, work_id: run.work_id, title: run.title, status: run.status, role: run.role, first_verdict: run.first_verdict,
      runs: (prior?.runs ?? 0) + 1,
      input_tokens: (prior?.input_tokens ?? 0) + usage.input_tokens,
      output_tokens: (prior?.output_tokens ?? 0) + usage.output_tokens,
      cache_read_tokens: (prior?.cache_read_tokens ?? 0) + usage.cache_read_tokens,
      cache_write_tokens: (prior?.cache_write_tokens ?? 0) + usage.cache_write_tokens,
      uncached_input_tokens: (prior?.uncached_input_tokens ?? 0) + usage.input_tokens + usage.cache_write_tokens,
      tokens_after_first_review: (prior?.tokens_after_first_review ?? 0)
        + (afterFirstReview ? usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens : 0),
    });
  }
  const taskRows = [...taskGroups.values()];
  const missing = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM agent_runs
      WHERE status IN ('exited','completed','failed')
        AND (origin IS NULL OR origin <> 'observed')
        AND COALESCE(ended_at, updated_at) >= ? AND COALESCE(ended_at, updated_at) < ?
        AND (usage_json IS NULL OR (${HAS_USAGE}) = 0)`,
    sinceIso,
    untilIso,
  )?.n ?? 0;

  let totals = emptyTotals();
  const workTotals = new Map<string, { work: Omit<RunAggregate, "role" | "provider" | "model" | "date" | "runs" | "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens">; totals: TokenUsageTotals }>();
  const harnessTotals = new Map<TokenUsageHarness, TokenUsageTotals>();
  const roleTotals = new Map<TokenUsageRole, TokenUsageTotals>();
  const workUncached = new Map<string, number>();
  const roleUncached = new Map<string, number>();
  const modelTotals = new Map<string, { provider: string; model: string; harness: TokenUsageHarness; totals: TokenUsageTotals }>();
  const dailyTotals = new Map(dates.map((date) => [date, emptyTotals()]));

  for (const row of rows) {
    const harness = input.harnessOf(row.provider) ?? "other";
    const cache_read_tokens = row.cache_read_tokens;
    const usage = {
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_read_tokens,
      cache_write_tokens: row.cache_write_tokens,
    };
    const runs = row.runs;
    const uncached = row.input_tokens + row.cache_write_tokens;
    workUncached.set(row.work_id, (workUncached.get(row.work_id) ?? 0) + uncached);
    roleUncached.set(row.role, (roleUncached.get(row.role) ?? 0) + uncached);
    totals = addTotals(totals, usage, runs);

    const work = workTotals.get(row.work_id) ?? {
      work: { work_id: row.work_id, title: row.title, display_number: row.display_number, project_id: row.project_id, state: row.state },
      totals: emptyTotals(),
    };
    work.totals = addTotals(work.totals, usage, runs);
    workTotals.set(row.work_id, work);

    harnessTotals.set(harness, addTotals(harnessTotals.get(harness) ?? emptyTotals(), usage, runs));
    const role = row.role as TokenUsageRole;
    roleTotals.set(role, addTotals(roleTotals.get(role) ?? emptyTotals(), usage, runs));
    const modelKey = JSON.stringify([row.provider, row.model, harness]);
    const model = modelTotals.get(modelKey) ?? { provider: row.provider, model: row.model, harness, totals: emptyTotals() };
    model.totals = addTotals(model.totals, usage, runs);
    modelTotals.set(modelKey, model);

    const day = row.date;
    if (dailyTotals.has(day)) dailyTotals.set(day, addTotals(dailyTotals.get(day)!, usage, runs));
  }

  const byWork = [...workTotals.values()]
    .sort((a, b) => b.totals.total_tokens - a.totals.total_tokens || compareText(a.work.work_id, b.work.work_id))
    .map(({ work, totals: workUsage }) => ({
      ...work,
      totals: workUsage,
      metrics: metricsOf(workUncached.get(work.work_id) ?? 0, workUsage.runs, taskRows.filter((row) => row.work_id === work.work_id)),
    }));
  const taskTotals = new Map<string, TokenUsageTaskTotals>();
  for (const row of taskRows) {
    const prior = taskTotals.get(row.task_id);
    taskTotals.set(row.task_id, {
      task_id: row.task_id, work_id: row.work_id, title: row.title, status: row.status, first_review_verdict: row.first_verdict,
      first_review_pass_rate: row.first_verdict === null ? null : row.first_verdict === "pass" ? 1 : 0,
      uncached_input_tokens: (prior?.uncached_input_tokens ?? 0) + row.uncached_input_tokens,
      tokens_after_first_review: (prior?.tokens_after_first_review ?? 0) + row.tokens_after_first_review,
      totals: addTotals(prior?.totals ?? emptyTotals(), row, row.runs),
    });
  }
  const totalOrder = <T extends { totals: TokenUsageTotals }>(left: T, right: T) => right.totals.total_tokens - left.totals.total_tokens;
  return {
    period: input.period,
    since: sinceIso,
    until: untilIso,
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    totals,
    runs_without_usage: missing,
    daily: dates.map((date) => ({ date, totals: dailyTotals.get(date)! })),
    by_work: byWork,
    by_task: [...taskTotals.values()].sort((a, b) => b.totals.total_tokens - a.totals.total_tokens || compareText(a.task_id, b.task_id)),
    by_harness: [...harnessTotals].map(([harness, usage]) => ({ harness, totals: usage }))
      .sort((a, b) => totalOrder(a, b) || compareText(a.harness, b.harness)),
    by_role: [...roleTotals].map(([role, usage]) => ({
      role, totals: usage, metrics: metricsOf(roleUncached.get(role) ?? 0, usage.runs, taskRows.filter((row) => row.role === role)),
    }))
      .sort((a, b) => totalOrder(a, b) || compareText(a.role, b.role)),
    by_model: [...modelTotals.values()].sort((a, b) => totalOrder(a, b)
      || compareText(a.provider, b.provider) || compareText(a.model, b.model) || compareText(a.harness, b.harness)),
    top_works: byWork.slice(0, input.top),
  };
}

/** One model request to store in agent_run_requests. */
export interface AgentRunRequestRow {
  readonly agent_run_id: string;
  readonly work_id: string;
  readonly child_run_id: string | null;
  readonly provider: string;
  readonly model: string;
  readonly message_id: string;
  readonly subagent: boolean;
  readonly input_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly output_tokens: number;
  readonly created_at: string;
}

/** Inserts request rows, ignoring ones already stored for the same run and message id; returns how many were new. */
export function insertRequestUsageRows(tx: CoreWriteLaneTransaction, rows: readonly AgentRunRequestRow[]): number {
  let inserted = 0;
  for (const row of rows) {
    inserted += tx.run(
      `INSERT OR IGNORE INTO agent_run_requests
         (id, agent_run_id, work_id, child_run_id, provider, model, message_id, subagent, prompt_tokens,
          input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      createUlid(), row.agent_run_id, row.work_id, row.child_run_id, row.provider, row.model, row.message_id, row.subagent ? 1 : 0,
      // Derived here so every writer counts the prompt size the same way.
      row.input_tokens + row.cache_read_tokens + row.cache_write_tokens,
      row.input_tokens, row.cache_read_tokens, row.cache_write_tokens, row.output_tokens, row.created_at,
    ).changes;
  }
  return inserted;
}

export interface RequestThresholdCount {
  readonly threshold_tokens: number;
  readonly models: string[] | null;
  readonly total_requests: number;
  readonly over_threshold: number;
}

/**
 * Counts stored requests and those whose prompt is strictly larger than the threshold.
 * `models` matches a name exactly or as `<model>-…` (dated snapshot names); null counts every model.
 */
export function countRequestsOverThreshold(
  db: Pick<CoreDatabase, "get">,
  input: {
    readonly threshold_tokens: number; readonly models: readonly string[] | null;
    readonly work_id?: string; readonly since?: string; readonly until?: string;
  },
): RequestThresholdCount {
  const models = input.models === null ? null : [...new Set(input.models)];
  // substr rather than LIKE, so "_" and "%" in model names are not wildcards.
  const modelFilter = models === null ? "1 = 1"
    : models.length === 0 ? "1 = 0"
    : `(${models.map(() => "(model = ? OR substr(model, 1, length(?) + 1) = ? || '-')").join(" OR ")})`;
  const counts = db.get<{ total_requests: number; over_threshold: number }>(
    `SELECT COUNT(*) AS total_requests, COALESCE(SUM(CASE WHEN prompt_tokens > ? THEN 1 ELSE 0 END), 0) AS over_threshold
       FROM agent_run_requests
      WHERE ${modelFilter} AND (? IS NULL OR work_id = ?) AND (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)`,
    input.threshold_tokens, ...(models ?? []).flatMap((model) => [model, model, model]),
    input.work_id ?? null, input.work_id ?? null, input.since ?? null, input.since ?? null, input.until ?? null, input.until ?? null,
  )!;
  return { threshold_tokens: input.threshold_tokens, models, total_requests: counts.total_requests, over_threshold: counts.over_threshold };
}
