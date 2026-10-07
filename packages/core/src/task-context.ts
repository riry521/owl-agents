import type { CoreDatabase, JsonObject, TaskRow } from "./types";
import { readStoredAcceptanceCriteria } from "../../shared/dist/acceptance-criteria.js";
import {
  ACCEPTANCE_DEFECT_EVENT,
  ACCEPTANCE_DEFECT_FAILURE_KIND,
  normalizeAcceptanceDefects,
  type AcceptanceDefect,
} from "../../shared/dist/acceptance-defect.js";
import { EXTERNAL_BLOCKER_EVENT, readExternalBlocker, type ExternalBlocker } from "../../shared/dist/external-blocker.js";

/**
 * What Core tells an agent about a Task beyond the Task itself. One module
 * so the Worker hand-off (WorkflowEngine) and the Manager replan (Core) read
 * the same facts the same way. Everything here is readable context: internal
 * hashes (tasks.last_error_key), counters and paths stay in Core.
 */

import {
  isRecord,
  latestTaskReport,
  parseObject,
  readFixContext,
  reportSummary,
  text,
  type ContextReader,
  type FixContext,
} from "./context-builder.js";

// The Role Input builders live in ContextBuilder; these are the existing import paths.
export { dependencyContext, loadFixContext, readDependencyReport, reviewerTaskView, roleTaskView, taskDependencyIds } from "./context-builder.js";
export type { DependencyContext, FixContext } from "./context-builder.js";

/** Whether a Task's plan requires an independent Reviewer pass before it can complete. */
export function isTaskReviewRequired(task: Pick<TaskRow, "type" | "review_override">): boolean {
  if (task.review_override === "true") return true;
  if (task.review_override === "false") return false;
  return task.type === "code" || task.type === "config";
}



function latestFailureEvent(db: ContextReader, taskId: string): { type: string; payload_json: string } | undefined {
  return db.get<{ type: string; payload_json: string }>(
    `SELECT type, payload_json FROM events
      WHERE task_id = ? AND type IN (
        'task.failure.classified', 'agent.crashed', 'verification.completed',
        'review.failed', 'review.passed', 'task.replan_requested', 'task.conflict', '${ACCEPTANCE_DEFECT_EVENT}', '${EXTERNAL_BLOCKER_EVENT}'
      )
      ORDER BY sequence DESC LIMIT 1`,
    taskId,
  );
}

/** True when the Task's latest failure is a criteria defect reported by the Worker or Reviewer. */
export function pendingAcceptanceDefect(db: ContextReader, taskId: string): boolean {
  return latestFailureEvent(db, taskId)?.type === ACCEPTANCE_DEFECT_EVENT;
}

/** True when the Task's latest failure is a Worker report of a problem outside the Task (pre_existing / environment). */
export function pendingExternalBlocker(db: ContextReader, taskId: string): boolean {
  return latestFailureEvent(db, taskId)?.type === EXTERNAL_BLOCKER_EVENT;
}

function acceptanceDefectsOf(payload: JsonObject): AcceptanceDefect[] {
  return normalizeAcceptanceDefects(payload.defects);
}

/**
 * The cause of a Task's latest failure, one field per fact. Every text field
 * is an upstream sentence (Worker, Reviewer, exception) kept whole in its own
 * field; Core adds no sentence of its own. A verification failure's content
 * is `verification_failure` of the same brief.
 */
export type TaskFailureInput =
  | { kind: "worker_failed"; role: "Worker" | "Designer"; reported_result: string | null; work_done: string | null; reason: string | null }
  | { kind: "worker_crashed"; role: "Worker" | "Designer"; reason: string | null }
  | { kind: "reviewer_failed"; reason: string | null }
  | { kind: "replan_requested"; role: "Worker" | "Designer"; reason: string | null; question: string | null }
  | { kind: typeof ACCEPTANCE_DEFECT_FAILURE_KIND; reason: string | null }
  | { kind: "external_blocker"; cause: ExternalBlocker["kind"] | null; summary: string | null; evidence: string | null; suggested_fix: string | null }
  | { kind: "verification_failed" }
  | { kind: "merge_conflict"; stage: "work_merge" | "work_sync"; merge_conflict_files: string[] }
  | { kind: "review_failed"; verdict: string; findings_count: number; summary: string | null }
  | { kind: "unknown"; reason: string | null };

function conflictFiles(payload: JsonObject): string[] {
  return Array.isArray(payload.merge_conflict_files)
    ? payload.merge_conflict_files.filter((file): file is string => typeof file === "string")
    : [];
}

function taskFailure(db: ContextReader, taskId: string): TaskFailureInput {
  const row = latestFailureEvent(db, taskId);
  if (row === undefined) return { kind: "unknown", reason: null };
  const role = db.get<{ type: string }>("SELECT type FROM tasks WHERE id = ?", taskId)?.type === "design" ? "Designer" : "Worker";
  const payload = parseObject(row.payload_json) ?? {};
  const reason = text(payload.reason) ?? text(payload.message) ?? text(payload.error);
  switch (row.type) {
    case "task.failure.classified": {
      // A Worker that reported result failed/partial carries its report; its own words say more than the classification reason.
      const reported = isRecord(payload.report) ? payload.report : null;
      const result = reported === null ? null : text(reported.result);
      if (reported !== null && result !== null && result !== "success") {
        return { kind: "worker_failed", role, reported_result: result, work_done: text(reported.work_done), reason };
      }
      return { kind: "worker_failed", role, reported_result: null, work_done: null, reason };
    }
    case "agent.crashed":
      return payload.role === "reviewer" ? { kind: "reviewer_failed", reason } : { kind: "worker_crashed", role, reason };
    case "task.replan_requested":
      return { kind: "replan_requested", role, reason, question: text(payload.question) };
    case ACCEPTANCE_DEFECT_EVENT:
      return { kind: ACCEPTANCE_DEFECT_FAILURE_KIND, reason };
    case EXTERNAL_BLOCKER_EVENT: {
      const blocker = readExternalBlocker(payload.external_blocker);
      return { kind: "external_blocker", cause: blocker?.kind ?? null, summary: blocker?.summary ?? reason, evidence: blocker?.evidence ?? null, suggested_fix: blocker?.suggested_fix ?? null };
    }
    case "verification.completed":
      if (payload.outcome === "fail") return { kind: "verification_failed" };
      if (typeof payload.merge_exit_code === "number" && payload.merge_exit_code !== 0) {
        return { kind: "merge_conflict", stage: "work_merge", merge_conflict_files: conflictFiles(payload) };
      }
      break;
    case "review.passed":
      if (typeof payload.merge_exit_code === "number" && payload.merge_exit_code !== 0) {
        return { kind: "merge_conflict", stage: "work_merge", merge_conflict_files: conflictFiles(payload) };
      }
      break;
    case "task.conflict":
      return { kind: "merge_conflict", stage: "work_sync", merge_conflict_files: conflictFiles(payload) };
    case "review.failed": {
      if (!isRecord(payload.review)) return { kind: "reviewer_failed", reason: text(payload.error) };
      const review = payload.review;
      return {
        kind: "review_failed",
        verdict: text(review.verdict) ?? text(payload.verdict) ?? "fix_required",
        findings_count: Array.isArray(review.findings) ? review.findings.length : 0,
        summary: text(review.summary),
      };
    }
    default:
      break;
  }
  return { kind: "unknown", reason };
}

/**
 * What the Manager needs to retry or replace a root failed Task — its
 * plan fields, why it failed, its last report, and the fix context of its
 * latest attempt.
 */
export function failedTaskBrief(db: ContextReader, taskId: string): JsonObject | null {
  const task = db.get<{ id: string; manager_task_id: string | null; title: string; acceptance: string; acceptance_criteria_json: string | null }>(
    "SELECT id, manager_task_id, title, acceptance, acceptance_criteria_json FROM tasks WHERE id = ?",
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
  const latest = latestFailureEvent(db, taskId);
  const defectPayload = latest?.type === ACCEPTANCE_DEFECT_EVENT ? parseObject(latest.payload_json) : null;
  const eventVerification = latest?.type === "verification.completed" ? (parseObject(latest.payload_json)?.verification ?? null) : null;
  return {
    task_id: task.id,
    manager_task_id: task.manager_task_id,
    title: task.title,
    acceptance_criteria: readStoredAcceptanceCriteria(task.acceptance_criteria_json, task.acceptance) as unknown as JsonObject[],
    failure: taskFailure(db, taskId) as unknown as JsonObject,
    acceptance_defects: defectPayload === null ? [] : acceptanceDefectsOf(defectPayload),
    last_report: report === null ? null : reportSummary(report),
    reviewer_findings: fix?.reviewer_findings ?? [],
    // A damaged fix context still leaves the event's own verification record.
    verification_failure: fix?.verification_failure ?? eventVerification,
  };
}
