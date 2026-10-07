import { PROVIDER_FAILED_ERROR_PREFIX } from "./attempt-policy.js";

/** Reads rows; the part of the database the metrics need. */
export interface MetricsReader {
  all<T extends object>(sql: string): T[];
}

export interface ReviewMetrics {
  /** Tasks whose first (lowest-round) review passed / Tasks that were reviewed. */
  readonly first_review_pass_rate: { readonly numerator: number; readonly denominator: number; readonly value: number | null };
  readonly reviews_per_task: { readonly numerator: number; readonly denominator: number; readonly value: number | null };
  /** A round trip is a review that is not a pass; counts Tasks with two or more. */
  readonly two_plus_roundtrip_rate: { readonly numerator: number; readonly denominator: number; readonly value: number | null; readonly max_roundtrips: number | null };
  /** Tokens (input + output + cache read + cache write) of AgentRuns with recorded usage, per reviewed Task. */
  readonly tokens_per_task: {
    readonly worker: { readonly tasks: number; readonly sum: number | null; readonly mean: number | null };
    readonly all_agent_runs: { readonly tasks: number; readonly sum: number | null; readonly mean: number | null };
  };
  /** Tokens per Task over every Task with recorded usage, whether or not it was reviewed. */
  readonly tokens_per_task_any_review: {
    readonly worker: { readonly tasks: number; readonly sum: number | null; readonly mean: number | null };
    readonly all_agent_runs: { readonly tasks: number; readonly sum: number | null; readonly mean: number | null };
  };
  /** Core's review routing (tasks.review_decision) over Tasks whose result was verified. */
  readonly review_routing: {
    readonly decided: number;
    /** Tasks whose Reviewer was skipped (review_decision = not_required). */
    readonly skipped: number;
    /** Tasks Core raised from not required to required because of an objective condition (forced_reasons not empty, base not required), and the count per reason code. */
    readonly forced: { readonly tasks: number; readonly by_reason: Readonly<Record<string, number>> };
  };
  /** The counted verdicts (tasks.total_review_attempts) over every Task. */
  readonly total_review_attempts: { readonly tasks: number; readonly sum: number; readonly max: number };
  /** Worker results the completion gate turned back, by error_key. */
  readonly completion_gate_failures: { readonly total: number; readonly by_reason: Readonly<Record<string, number>> };
  /**
   * Retries counted from existing events, by cause. Each event is one retry.
   * semantic: task.failure.classified deterministic without escalated_from or a provider_failed: error_key (by_kind deterministic_failure),
   *   verification.completed outcome fail (verification_failed), review.failed with a review object (review_failed; a Reviewer crash writes none),
   *   task.replan_requested (replan_requested), task.acceptance_defect_reported (acceptance_defect).
   * infrastructure: task.failure.classified transient (transient), task.rate_limited (rate_limited), agent.crashed of a non-reviewer role (crash),
   *   agent.crashed of a reviewer (reviewer_crash), and deterministic classifications escalated from transient (escalated_from set, or, for events
   *   recorded before escalated_from existed, an error_key starting with PROVIDER_FAILED_ERROR_PREFIX) (transient_budget_exhausted).
   * integration: task.conflict (conflict), review.passed or verification.completed with merge_exit_code <> 0 (merge_failed).
   * per_completed_task: total / Tasks with status completed (null when none).
   */
  readonly retries: {
    readonly semantic: RetryCount;
    readonly infrastructure: RetryCount;
    readonly integration: RetryCount;
    readonly per_completed_task: { readonly semantic: number | null; readonly infrastructure: number | null };
  };
  /** verification.completed with outcome pass / all verification.completed. */
  readonly verification_pass_rate: Ratio;
  /** Tasks with a task.replanned event / Tasks with a task.started event. */
  readonly replan_rate: Ratio;
  /** retries.infrastructure.total / finished (ended_at set) AgentRuns of role worker, designer or reviewer. */
  readonly infrastructure_failure_rate: Ratio;
  /**
   * Milliseconds from a Task becoming runnable to its task.started, over each task.started that has an origin.
   * Origin: the latest of the last task.ready / task.attempt_decided (to ready or review_fix_waiting; the later of created_at and next_attempt_at)
   * and the last work.resumed, all with a smaller sequence than the task.started. A task.started without an origin is not counted.
   * Known limit: history from before Phase 2 has no task.attempt_decided, so a start after a retry is measured from the older task.ready and the delay is too large.
   */
  readonly scheduler_ready_delay_ms: { readonly launches: number; readonly mean: number | null; readonly max: number | null };
  /** task.attempt_decided counted by its action and reason. */
  readonly attempt_decisions: { readonly total: number; readonly by_action: Readonly<Record<string, number>>; readonly by_reason: Readonly<Record<string, number>> };
}

interface RetryCount { readonly total: number; readonly by_kind: Readonly<Record<string, number>> }
interface Ratio { readonly numerator: number; readonly denominator: number; readonly value: number | null }

const sqlText = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Math.round((10000 * numerator) / denominator) / 10000 : null;

export function reviewMetrics(db: MetricsReader): ReviewMetrics {
  const one = <T extends object>(sql: string): T => db.all<T>(sql)[0] as T;
  const first = one<{ n: number | null; d: number }>(`
    WITH first AS (
      SELECT r.task_id, r.verdict FROM reviews r
      WHERE r.round = (SELECT MIN(round) FROM reviews WHERE task_id = r.task_id))
    SELECT SUM(verdict='pass') AS n, COUNT(*) AS d FROM first`);
  const per = one<{ n: number; d: number }>("SELECT COUNT(*) AS n, COUNT(DISTINCT task_id) AS d FROM reviews");
  const trips = one<{ n: number | null; d: number; mx: number | null }>(`
    WITH t AS (SELECT task_id, SUM(verdict<>'pass') AS rt FROM reviews GROUP BY task_id)
    SELECT SUM(rt>=2) AS n, COUNT(*) AS d, MAX(rt) AS mx FROM t`);
  const tokensSql = (taskFilter: string) => `
    WITH u AS (
      SELECT a.task_id, a.role,
        COALESCE(json_extract(a.usage_json,'$.input_tokens'),0)+COALESCE(json_extract(a.usage_json,'$.output_tokens'),0)
       +COALESCE(json_extract(a.usage_json,'$.cache_read_tokens'),0)+COALESCE(json_extract(a.usage_json,'$.cache_write_tokens'),0) AS total
      FROM agent_runs a WHERE a.usage_json IS NOT NULL${taskFilter}),
    w AS (SELECT task_id, SUM(total) tot FROM u WHERE role='worker' GROUP BY task_id),
    x AS (SELECT task_id, SUM(total) tot FROM u GROUP BY task_id)
    SELECT 'worker' AS scope, COUNT(*) AS tasks, SUM(tot) AS sum, ROUND(AVG(tot)) AS mean FROM w
    UNION ALL
    SELECT 'all_agent_runs', COUNT(*), SUM(tot), ROUND(AVG(tot)) FROM x`;
  type TokenRow = { scope: string; tasks: number; sum: number | null; mean: number | null };
  const tokenScopes = (rows: TokenRow[]) => {
    const scope = (name: string) => {
      const row = rows.find((item) => item.scope === name);
      return { tasks: row?.tasks ?? 0, sum: row?.sum ?? null, mean: row?.mean ?? null };
    };
    return { worker: scope("worker"), all_agent_runs: scope("all_agent_runs") };
  };
  const tokens = tokenScopes(db.all<TokenRow>(tokensSql(" AND a.task_id IN (SELECT task_id FROM reviews)")));
  const tokensAny = tokenScopes(db.all<TokenRow>(tokensSql(" AND a.task_id IS NOT NULL")));
  const routing = one<{ decided: number; skipped: number | null }>(
    "SELECT COUNT(*) AS decided, SUM(review_decision='not_required') AS skipped FROM tasks WHERE review_decision IS NOT NULL");
  // A forced Task is read from its passed verification events, not tasks.review_decision_json:
  // after a rejected review the re-verification overwrites that column with base sticky_required and no reasons.
  const forcedEvents = `
    FROM events e, json_each(e.payload_json,'$.review_routing.forced_reasons') f
    WHERE e.type = 'verification.completed' AND json_extract(e.payload_json,'$.outcome') = 'pass'
      AND json_extract(e.payload_json,'$.review_routing.base') IN ('override_false','type_default_not_required')
      AND json_extract(e.payload_json,'$.review_routing.required') = 1`;
  const forced = one<{ n: number }>(`SELECT COUNT(DISTINCT e.task_id) AS n ${forcedEvents}`);
  const forcedBy = db.all<{ code: string; n: number }>(`
    SELECT json_extract(f.value,'$.code') AS code, COUNT(DISTINCT e.task_id) AS n ${forcedEvents} GROUP BY code ORDER BY code`);
  const attempts = one<{ tasks: number; sum: number | null; max: number | null }>(
    "SELECT COUNT(*) AS tasks, SUM(total_review_attempts) AS sum, MAX(total_review_attempts) AS max FROM tasks");
  const gate = db.all<{ reason: string; n: number }>(`
    SELECT COALESCE(json_extract(payload_json,'$.error_key'),'worker_completion_gate_failed') AS reason, COUNT(*) AS n
    FROM events
    WHERE type IN ('task.failure.classified','task.replan_requested')
      AND json_type(payload_json,'$.gate_reasons') = 'array'
    GROUP BY reason ORDER BY reason`);
  const escalated = `(json_extract(payload_json,'$.escalated_from') IS NOT NULL
    OR substr(COALESCE(json_extract(payload_json,'$.error_key'),''),1,${PROVIDER_FAILED_ERROR_PREFIX.length}) = ${sqlText(PROVIDER_FAILED_ERROR_PREFIX)})`;
  const failureClass = (cls: string) => `type = 'task.failure.classified' AND json_extract(payload_json,'$.failure_class') = ${sqlText(cls)}`;
  const kinds = (parts: Record<string, string>): RetryCount => {
    const by_kind: Record<string, number> = {};
    for (const [kind, where] of Object.entries(parts)) {
      by_kind[kind] = one<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE task_id IS NOT NULL AND (${where})`).n;
    }
    return { total: Object.values(by_kind).reduce((sum, n) => sum + n, 0), by_kind };
  };
  const semantic = kinds({
    deterministic_failure: `${failureClass("deterministic")} AND NOT ${escalated}`,
    verification_failed: "type = 'verification.completed' AND json_extract(payload_json,'$.outcome') = 'fail'",
    review_failed: "type = 'review.failed' AND json_type(payload_json,'$.review') = 'object'",
    replan_requested: "type = 'task.replan_requested'",
    acceptance_defect: "type = 'task.acceptance_defect_reported'",
  });
  const infrastructure = kinds({
    transient: failureClass("transient"),
    rate_limited: "type = 'task.rate_limited'",
    crash: "type = 'agent.crashed' AND COALESCE(json_extract(payload_json,'$.role'),'') <> 'reviewer'",
    reviewer_crash: "type = 'agent.crashed' AND json_extract(payload_json,'$.role') = 'reviewer'",
    transient_budget_exhausted: `${failureClass("deterministic")} AND ${escalated}`,
  });
  const integration = kinds({
    conflict: "type = 'task.conflict'",
    merge_failed: "type IN ('review.passed','verification.completed') AND COALESCE(json_extract(payload_json,'$.merge_exit_code'),0) <> 0",
  });
  const completed = one<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status = 'completed'").n;
  const perCompleted = (total: number) => (completed > 0 ? Math.round((10000 * total) / completed) / 10000 : null);
  const verifications = one<{ n: number | null; d: number }>(
    "SELECT SUM(json_extract(payload_json,'$.outcome') = 'pass') AS n, COUNT(*) AS d FROM events WHERE type = 'verification.completed'");
  const replans = one<{ n: number; d: number }>(`
    SELECT COUNT(DISTINCT CASE WHEN type = 'task.replanned' THEN task_id END) AS n,
           COUNT(DISTINCT CASE WHEN type = 'task.started' THEN task_id END) AS d
    FROM events WHERE type IN ('task.replanned','task.started') AND task_id IS NOT NULL`);
  const finishedRuns = one<{ d: number }>(
    "SELECT COUNT(*) AS d FROM agent_runs WHERE role IN ('worker','designer','reviewer') AND ended_at IS NOT NULL").d;
  const candidate = `a.task_id = s.task_id AND a.sequence < s.sequence
    AND (a.type = 'task.ready' OR (a.type = 'task.attempt_decided' AND json_extract(a.payload_json,'$.to') IN ('ready','review_fix_waiting')))
    ORDER BY a.sequence DESC LIMIT 1`;
  const delays = db.all<{ at: string; ready_at: string | null; next_at: string | null; resumed_at: string | null }>(`
    SELECT s.created_at AS at,
      (SELECT a.created_at FROM events a WHERE ${candidate}) AS ready_at,
      (SELECT json_extract(a.payload_json,'$.next_attempt_at') FROM events a WHERE ${candidate}) AS next_at,
      (SELECT b.created_at FROM events b WHERE b.work_id = s.work_id AND b.type = 'work.resumed' AND b.sequence < s.sequence
       ORDER BY b.sequence DESC LIMIT 1) AS resumed_at
    FROM events s WHERE s.type = 'task.started' AND s.task_id IS NOT NULL`);
  const delayMs: number[] = [];
  for (const row of delays) {
    const origins = [row.ready_at, row.next_at, row.resumed_at].flatMap((value) => (value === null ? [] : [Date.parse(value)])).filter((value) => !Number.isNaN(value));
    if (origins.length > 0) delayMs.push(Math.max(0, Date.parse(row.at) - Math.max(...origins)));
  }
  const decisionBy = (key: string) => Object.fromEntries(db.all<{ k: string; n: number }>(`
    SELECT json_extract(payload_json,'$.${key}') AS k, COUNT(*) AS n FROM events WHERE type = 'task.attempt_decided' AND k IS NOT NULL GROUP BY k ORDER BY k`).map((row) => [row.k, row.n]));
  const decisionTotal = one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'task.attempt_decided'").n;
  const rate = (n: number, d: number): Ratio => ({ numerator: n, denominator: d, value: ratio(n, d) });
  return {
    first_review_pass_rate: { numerator: first.n ?? 0, denominator: first.d, value: ratio(first.n ?? 0, first.d) },
    reviews_per_task: { numerator: per.n, denominator: per.d, value: ratio(per.n, per.d) },
    two_plus_roundtrip_rate: { numerator: trips.n ?? 0, denominator: trips.d, value: ratio(trips.n ?? 0, trips.d), max_roundtrips: trips.mx },
    tokens_per_task: tokens,
    tokens_per_task_any_review: tokensAny,
    review_routing: {
      decided: routing.decided,
      skipped: routing.skipped ?? 0,
      forced: { tasks: forced.n, by_reason: Object.fromEntries(forcedBy.map((row) => [row.code, row.n])) },
    },
    total_review_attempts: { tasks: attempts.tasks, sum: attempts.sum ?? 0, max: attempts.max ?? 0 },
    completion_gate_failures: {
      total: gate.reduce((sum, row) => sum + row.n, 0),
      by_reason: Object.fromEntries(gate.map((row) => [row.reason, row.n])),
    },
    retries: {
      semantic,
      infrastructure,
      integration,
      per_completed_task: { semantic: perCompleted(semantic.total), infrastructure: perCompleted(infrastructure.total) },
    },
    verification_pass_rate: rate(verifications.n ?? 0, verifications.d),
    replan_rate: rate(replans.n, replans.d),
    infrastructure_failure_rate: rate(infrastructure.total, finishedRuns),
    scheduler_ready_delay_ms: {
      launches: delayMs.length,
      mean: delayMs.length > 0 ? Math.round(delayMs.reduce((sum, n) => sum + n, 0) / delayMs.length) : null,
      max: delayMs.length > 0 ? Math.max(...delayMs) : null,
    },
    attempt_decisions: { total: decisionTotal, by_action: decisionBy("action"), by_reason: decisionBy("reason") },
  };
}
