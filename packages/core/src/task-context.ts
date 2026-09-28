import type { CoreDatabase, JsonObject, TaskRow } from "./types";
import { designDocumentPath } from "@owl/shared";

/**
 * What Core tells an agent about a Task beyond the Task itself. One module
 * so the Worker hand-off (WorkflowEngine) and the Manager replan (Core) read
 * the same facts the same way. Everything here is readable context: internal
 * hashes (tasks.last_error_key), counters and paths stay in Core.
 */

type ContextReader = Pick<CoreDatabase, "get" | "all">;

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseObject(json: string): JsonObject | null {
  try {
    const value = JSON.parse(json) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Whether a Task's plan requires an independent Reviewer pass before it can complete. */
export function isTaskReviewRequired(task: Pick<TaskRow, "type" | "review_override">): boolean {
  if (task.review_override === "true") return true;
  if (task.review_override === "false") return false;
  return task.type === "code" || task.type === "config";
}

/** Ids of the Tasks this Task depends on, in a stable order. */
export function taskDependencyIds(db: ContextReader, taskId: string): string[] {
  return db.all<{ depends_on_task_id: string }>(
    "SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id ASC",
    taskId,
  ).map((row) => row.depends_on_task_id);
}

/**
 * The TaskDetail a Worker or Reviewer reads: plan fields, status and the
 * Task's real dependencies. Internals (error hashes, worktree paths, leases,
 * cascade markers) are not part of it.
 */
export function roleTaskView(row: TaskRow, dependsOn: readonly string[]): JsonObject {
  return {
    id: row.id,
    work_id: row.work_id,
    title: row.title,
    type: row.type,
    status: row.status,
    state_version: row.state_version,
    updated_at: row.updated_at,
    parent_task_id: row.parent_task_id,
    acceptance: row.acceptance,
    context: row.context,
    review_round: row.review_round,
    failure_count: row.failure_count,
    worker_generation: row.worker_generation,
    ...(row.review_override === null ? {} : { review: row.review_override === "true" }),
    depends_on: [...dependsOn],
  };
}

/**
 * The Task fields a Reviewer needs to judge the Worker's report: the plan
 * (title/acceptance/context), the review state, and real dependencies.
 * Internal bookkeeping (status, state_version, timestamps, failure/generation
 * counters) is Core's own and is left out.
 */
export function reviewerTaskView(row: TaskRow, dependsOn: readonly string[]): JsonObject {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    acceptance: row.acceptance,
    context: row.context,
    review_round: row.review_round,
    depends_on: [...dependsOn],
    ...(row.review_override === null ? {} : { review: row.review_override === "true" }),
  };
}

/** The latest Worker report stored for a Task, or null. */
function latestTaskReport(db: ContextReader, taskId: string): JsonObject | null {
  const row = db.get<{ payload_json: string }>(
    `SELECT reports.payload_json
       FROM reports JOIN agent_runs ON agent_runs.id = reports.agent_run_id
      WHERE agent_runs.task_id = ?
      ORDER BY reports.created_at DESC LIMIT 1`,
    taskId,
  );
  return row ? parseObject(row.payload_json) : null;
}

function agentRunReport(db: ContextReader, agentRunId: string): JsonObject | null {
  const row = db.get<{ payload_json: string }>(
    "SELECT payload_json FROM reports WHERE agent_run_id = ? LIMIT 1",
    agentRunId,
  );
  return row ? parseObject(row.payload_json) : null;
}

/** The three report fields another agent builds on; a missing field is ""/[]. */
function reportSummary(report: JsonObject): JsonObject {
  return {
    work_done: typeof report.work_done === "string" ? report.work_done : "",
    changes: Array.isArray(report.changes) ? report.changes.filter(isRecord) : [],
    remaining_issues: Array.isArray(report.remaining_issues) ? report.remaining_issues : [],
  };
}

/** Hybrid verdict fields are Core routing instructions, not part of a report another agent reads. */
function workerReportOnly(report: JsonObject): JsonObject {
  const { verdict: _verdict, retry_subtasks: _retrySubtasks, ...rest } = report;
  return rest;
}

export interface DependencyContext {
  readonly depends_on: string[];
  /** Per completed dependency: what it did, what it changed, what it left open. */
  readonly dependency_reports: JsonObject[];
  /** Recorded code/generated artifact paths of the completed dependencies. */
  readonly artifact_paths: string[];
}

/** The results of the Tasks a Task depends on. */
export function dependencyContext(db: ContextReader, taskId: string, dataDir: string): DependencyContext {
  const dependsOn = taskDependencyIds(db, taskId);
  if (dependsOn.length === 0) return { depends_on: [], dependency_reports: [], artifact_paths: [] };
  const placeholders = dependsOn.map(() => "?").join(",");
  const completed = db.all<{ id: string; work_id: string; manager_task_id: string | null; title: string; type: string }>(
    `SELECT id, work_id, manager_task_id, title, type FROM tasks
      WHERE id IN (${placeholders}) AND status = 'completed'
      ORDER BY created_at ASC, id ASC`,
    ...dependsOn,
  );
  const dependencyReports: JsonObject[] = [];
  for (const dependency of completed) {
    const report = latestTaskReport(db, dependency.id);
    dependencyReports.push({
      task_id: dependency.id,
      manager_task_id: dependency.manager_task_id,
      title: dependency.title,
      ...reportSummary(report ?? {}),
      design_document_path: dependency.type === "design" ? designDocumentPath(dataDir, dependency.work_id, dependency.id) : null,
    });
  }
  const artifactPaths: string[] = [];
  if (completed.length > 0) {
    const rows = db.all<{ path: string }>(
      `SELECT path FROM artifacts
        WHERE task_id IN (${completed.map(() => "?").join(",")}) AND kind IN ('code', 'generated')
        ORDER BY created_at ASC, id ASC`,
      ...completed.map((dependency) => dependency.id),
    );
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.path)) continue;
      seen.add(row.path);
      artifactPaths.push(row.path);
    }
  }
  return { depends_on: dependsOn, dependency_reports: dependencyReports, artifact_paths: artifactPaths };
}

/**
 * What the latest attempt of a Task was told to fix. The latest of
 * Core verification and Reviewer verdict decides: a failed verification
 * gives verification_failure, a fix/replan review gives reviewer_findings,
 * never both, and a pass after either clears it. Each comes with the report
 * of the attempt it judged. Older rounds are not repeated. A Reviewer that
 * itself failed (review.failed without a review) produced no findings and
 * does not count.
 */
export interface FixContext {
  /** The report of the attempt this judged (null if it has none). */
  readonly previous_report: JsonObject | null;
  readonly reviewer_findings?: unknown[];
  readonly verification_failure?: JsonObject;
}

/**
 * L2: the sequence of the latest event that started a new line of attempts
 * for the Task: a Manager replan that retried it (Work-level task.replanned
 * listing it, or a per-Task one), a restore after a cascade failure
 * (task.dependency_restored), or the Owner's answer to a Decision that
 * blocked it (decision.resolved). These are mostly Work-scoped events
 * (task_id NULL), so a per-Task event query alone cannot see them. Verdicts
 * at or before it judged a plan the Task no longer follows. Shared by
 * loadFixContext and loadRetrySubtasks. 0 when there is none.
 */
function attemptLineBoundary(db: ContextReader, taskId: string): number {
  const row = db.get<{ boundary: number | null }>(
    `SELECT MAX(events.sequence) AS boundary
       FROM events
      WHERE events.work_id = (SELECT work_id FROM tasks WHERE id = ?)
        AND (
          (events.type = 'task.replanned'
           AND (events.task_id = ?
                OR EXISTS (SELECT 1 FROM json_each(events.payload_json, '$.task_ids') WHERE json_each.value = ?)))
          OR (events.type = 'task.dependency_restored' AND events.task_id = ?)
          OR (events.type = 'decision.resolved'
              AND EXISTS (
                SELECT 1 FROM decisions, json_each(decisions.blocked_task_ids_json)
                 WHERE decisions.id = json_extract(events.payload_json, '$.decision_id')
                   AND json_each.value = ?))
        )`,
    taskId,
    taskId,
    taskId,
    taskId,
    taskId,
  );
  return row?.boundary ?? 0;
}

function readFixContext(db: ContextReader, taskId: string, workerFindingsOnly: boolean): FixContext | null {
  const boundary = attemptLineBoundary(db, taskId);
  const event = db.get<{ type: string; agent_run_id: string | null; payload_json: string }>(
    `SELECT type, agent_run_id, payload_json FROM events
      WHERE task_id = ? AND sequence > ?
        AND (type IN ('verification.completed', 'review.passed')
             OR (type = 'review.failed' AND json_type(payload_json, '$.review') = 'object'))
      ORDER BY sequence DESC LIMIT 1`,
    taskId,
    boundary,
  );
  if (!event) return null;
  const payload = parseObject(event.payload_json);
  if (payload === null) return null;
  if (event.type === "verification.completed") {
    if (payload.outcome !== "fail") return null;
    const verification = isRecord(payload.verification) ? payload.verification : {};
    const agentRunId = typeof payload.agent_run_id === "string" ? payload.agent_run_id : event.agent_run_id;
    const report = agentRunId === null ? null : agentRunReport(db, agentRunId);
    return {
      previous_report: report === null ? null : workerReportOnly(report),
      verification_failure: {
        source: typeof verification.source === "string" ? verification.source : "unknown",
        commands: Array.isArray(verification.commands) ? verification.commands : [],
        error: typeof verification.error === "string" ? verification.error : null,
      },
    };
  }
  if (event.type !== "review.failed") return null;
  const reviewerRunId = typeof payload.agent_run_id === "string" ? payload.agent_run_id : event.agent_run_id;
  const row = reviewerRunId === null
    ? undefined
    : db.get<{ verdict: string; findings_json: string; verification_report_json: string }>(
        "SELECT verdict, findings_json, verification_report_json FROM reviews WHERE id = ? AND task_id = ?",
        reviewerRunId,
        taskId,
      );
  // A missing or invalid stored review is skipped (logged), never
  // reinterpreted: the Worker runs without fix context instead of failing
  // every attempt on the same row.
  const skip = (problem: string, details: JsonObject = {}): null => {
    console.warn(`[owl-core] Task ${taskId}: ${problem}; the Worker runs without fix context.`, { agent_run_id: reviewerRunId, ...details });
    return null;
  };
  if (!row) return skip("the stored Reviewer feedback is missing");
  let findings: unknown;
  let verificationReport: unknown;
  try {
    findings = JSON.parse(row.findings_json) as unknown;
    verificationReport = JSON.parse(row.verification_report_json) as unknown;
  } catch (error) {
    return skip("the stored Reviewer feedback is not valid JSON", { cause: error instanceof Error ? error.message : String(error) });
  }
  if (!Array.isArray(findings) || !isRecord(verificationReport)) {
    return skip("the stored Reviewer feedback has an invalid shape");
  }
  const previousReport = verificationReport.report;
  if (!isRecord(previousReport)) {
    return skip("the stored Reviewer feedback is missing the previous Worker report");
  }
  const reviewerFindings = workerFindingsOnly && row.verdict === "fix_required"
    ? findings.filter((finding) => !isRecord(finding) || finding.severity !== "minor")
    : findings;
  return { previous_report: previousReport, reviewer_findings: reviewerFindings };
}

export function loadFixContext(db: ContextReader, taskId: string): FixContext | null {
  return readFixContext(db, taskId, true);
}

/**
 * Hybrid Mode: when the Worker's latest verdict in the current line of
 * attempts was "retry", its still-failing subtasks for the next attempt.
 * Instructions from before the attempt-line boundary (a Manager replan, a
 * resolved Decision, a restored dependency) are never returned. Failures that
 * carry no Worker verdict (a transient failure, a crash) are skipped, so a
 * retry after them keeps the instructions.
 */
export function loadRetrySubtasks(db: ContextReader, taskId: string): string[] {
  const boundary = attemptLineBoundary(db, taskId);
  const rows = db.all<{ type: string; payload_json: string }>(
    `SELECT type, payload_json FROM events
      WHERE task_id = ? AND sequence > ? AND type IN (
        'task.failure.classified', 'agent.crashed', 'agent.exited', 'task.replan_requested',
        'task.replanned', 'task.dependency_restored', 'verification.completed', 'review.failed', 'review.passed'
      )
      ORDER BY sequence DESC`,
    taskId,
    boundary,
  );
  for (const row of rows) {
    if (row.type === "agent.crashed") continue;
    const payload = row.type === "task.failure.classified" ? parseObject(row.payload_json) : null;
    if (payload?.failure_class === "transient") continue;
    if (payload === null || payload.error_key !== "hybrid_worker_retry_requested") return [];
    return Array.isArray(payload.retry_subtasks)
      ? payload.retry_subtasks.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
  }
  return [];
}

export type FailureKind =
  | "worker_failed"
  | "worker_crashed"
  | "verification_failed"
  | "review_failed"
  | "reviewer_failed"
  | "replan_requested"
  | "merge_conflict"
  | "unknown";

function verificationFailureDetail(verification: JsonObject): string {
  const error = text(verification.error);
  if (error !== null) return error;
  const commands = Array.isArray(verification.commands) ? verification.commands.filter(isRecord) : [];
  const failing = commands.filter((command) => command.passed !== true);
  if (failing.length > 0) {
    return failing.map((command) => {
      const id = text(command.command_id) ?? "command";
      const cause = text(command.error)
        ?? (command.timed_out === true ? "timed out" : typeof command.exit_code === "number" ? `exited with code ${command.exit_code}` : "failed");
      const stderr = typeof command.stderr === "string" ? command.stderr.trim().slice(-500) : "";
      return stderr.length > 0 ? `${id} ${cause}: ${stderr}` : `${id} ${cause}`;
    }).join("\n");
  }
  if (verification.source === "worker_report_only") return "The Worker's own verification did not pass (verification.passed=false in its report).";
  if (verification.source === "design_document") return "The Designer's own verification did not pass (verification.passed=false in its report).";
  return `Core verification failed (${text(verification.source) ?? "unknown source"}).`;
}

function mergeConflictDetail(payload: JsonObject): string {
  const files = Array.isArray(payload.merge_conflict_files)
    ? payload.merge_conflict_files.filter((file): file is string => typeof file === "string")
    : [];
  return `The Task's changes could not be merged into the Work branch (Git merge conflict${files.length > 0 ? ` in ${files.join(", ")}` : ""}).`;
}

function workSyncConflictDetail(payload: JsonObject): string {
  const files = Array.isArray(payload.merge_conflict_files)
    ? payload.merge_conflict_files.filter((file): file is string => typeof file === "string")
    : [];
  return `The Task's worktree could not be brought up to date with the Work branch (Git merge conflict${files.length > 0 ? ` in ${files.join(", ")}` : ""}).`;
}

/** The readable cause of a Task's latest failure: kind plus human text, never a hash. */
function taskFailure(db: ContextReader, taskId: string): { kind: FailureKind; detail: string } {
  const row = db.get<{ type: string; payload_json: string }>(
    `SELECT type, payload_json FROM events
      WHERE task_id = ? AND type IN (
        'task.failure.classified', 'agent.crashed', 'verification.completed',
        'review.failed', 'review.passed', 'task.replan_requested', 'task.conflict'
      )
      ORDER BY sequence DESC LIMIT 1`,
    taskId,
  );
  if (row === undefined) return { kind: "unknown", detail: "No failure details were recorded." };
  const role = db.get<{ type: string }>("SELECT type FROM tasks WHERE id = ?", taskId)?.type === "design" ? "Designer" : "Worker";
  const payload = parseObject(row.payload_json) ?? {};
  const reason = text(payload.reason) ?? text(payload.message) ?? text(payload.error);
  switch (row.type) {
    case "task.failure.classified": {
      // A Worker that reported result failed/partial carries its report; its
      // own words say more than the generic classification reason.
      const reported = isRecord(payload.report) ? payload.report : null;
      const result = reported === null ? null : text(reported.result);
      if (reported !== null && result !== null && result !== "success") {
        const workDone = text(reported.work_done);
        return { kind: "worker_failed", detail: `The ${role} reported result "${result}"${workDone !== null ? `: ${workDone}` : "."}` };
      }
      return { kind: "worker_failed", detail: reason ?? `The ${role} reported a failure.` };
    }
    case "agent.crashed":
      return payload.role === "reviewer"
        ? { kind: "reviewer_failed", detail: reason ?? "The Reviewer process failed." }
        : { kind: "worker_crashed", detail: reason ?? `The ${role} process ended without a report.` };
    case "task.replan_requested": {
      const question = text(payload.question);
      const detail = reason ?? `The ${role} asked for replanning.`;
      return { kind: "replan_requested", detail: question !== null && !detail.includes(question) ? `${detail}\nQuestion: ${question}` : detail };
    }
    case "verification.completed":
      if (payload.outcome === "fail") {
        return { kind: "verification_failed", detail: verificationFailureDetail(isRecord(payload.verification) ? payload.verification : {}) };
      }
      if (typeof payload.merge_exit_code === "number" && payload.merge_exit_code !== 0) {
        return { kind: "merge_conflict", detail: mergeConflictDetail(payload) };
      }
      break;
    case "review.passed":
      if (typeof payload.merge_exit_code === "number" && payload.merge_exit_code !== 0) {
        return { kind: "merge_conflict", detail: mergeConflictDetail(payload) };
      }
      break;
    case "task.conflict":
      return { kind: "merge_conflict", detail: workSyncConflictDetail(payload) };
    case "review.failed": {
      if (!isRecord(payload.review)) {
        return { kind: "reviewer_failed", detail: text(payload.error) ?? "The Reviewer failed without a verdict." };
      }
      const review = payload.review;
      const verdict = text(review.verdict) ?? text(payload.verdict) ?? "fix_required";
      const count = Array.isArray(review.findings) ? review.findings.length : 0;
      const summary = text(review.summary);
      return {
        kind: "review_failed",
        detail: `Reviewer verdict ${verdict} with ${count} finding${count === 1 ? "" : "s"}${summary ? `: ${summary}` : "."}`,
      };
    }
    default:
      break;
  }
  return { kind: "unknown", detail: reason ?? "No failure details were recorded." };
}

/**
 * What the Manager needs to retry or replace a root failed Task — its
 * plan fields, why it failed, its last report, and the fix context of its
 * latest attempt.
 */
export function failedTaskBrief(db: ContextReader, taskId: string): JsonObject | null {
  const task = db.get<{ id: string; manager_task_id: string | null; title: string; acceptance: string }>(
    "SELECT id, manager_task_id, title, acceptance FROM tasks WHERE id = ?",
    taskId,
  );
  if (!task) return null;
  const report = latestTaskReport(db, taskId);
  let fix: FixContext | null = null;
  try {
    fix = readFixContext(db, taskId, false);
  } catch {
    // A damaged review row must not keep the Manager from replanning; the
    // failure detail still explains what happened.
    fix = null;
  }
  return {
    task_id: task.id,
    manager_task_id: task.manager_task_id,
    title: task.title,
    acceptance: task.acceptance,
    failure: taskFailure(db, taskId),
    last_report: report === null ? null : reportSummary(report),
    reviewer_findings: fix?.reviewer_findings ?? [],
    verification_failure: fix?.verification_failure ?? null,
  };
}
