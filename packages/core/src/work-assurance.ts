import { notFound } from "./errors";
import type { CoreDatabase, JsonObject } from "./types";
import { isRecord } from "@owl/shared/small-helpers";

export interface WorkAssuranceReview {
  readonly task_id: string;
  readonly required: boolean;
  readonly base: string;
  /** Why the Reviewer was skipped; null when the review is required. */
  readonly skip_reason: string | null;
  /** Why Core raised the review to required, as recorded by the routing. */
  readonly forced_reasons: readonly { readonly code: string; readonly detail: string }[];
}

export interface WorkAssuranceReviewerFix {
  readonly task_id: string;
  readonly agent_run_id: string;
  readonly review_round: number;
  readonly recorded_at: string;
  readonly restore_failed: boolean;
  readonly outcome: "applied" | "over_limit" | "tests_failed" | "not_allowed";
  readonly reason: string | null;
  readonly limits: { readonly max_changed_lines: number; readonly max_changed_files: number };
  readonly measured: { readonly changed_lines: number; readonly changed_files: number };
  readonly fixes: readonly { readonly file: string; readonly line_start: number; readonly line_end: number; readonly problem: string; readonly change: string }[];
  readonly tests: { readonly passed: boolean; readonly error_key: string | null } | null;
  readonly reverted: boolean;
}

export interface WorkAssurance {
  readonly work_id: string;
  readonly reviews: readonly WorkAssuranceReview[];
  /** The latest integration verification of the Work branch; null before one ran. */
  readonly integration_verification: JsonObject | null;
  readonly plan_quality_warnings: readonly JsonObject[];
  /** Reviewer in-place fixes recorded on review events, oldest first. */
  readonly reviewer_fixes: readonly WorkAssuranceReviewerFix[];
}

function parseObject(json: string): JsonObject | null {
  try {
    const value = JSON.parse(json) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

const FIX_OUTCOMES = ["applied", "over_limit", "tests_failed", "not_allowed"] as const;
const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function readReviewerFix(
  row: { type: string; task_id: string | null; agent_run_id: string | null; created_at: string; review_round: number | null },
  payload: JsonObject,
): WorkAssuranceReviewerFix | null {
  const fix = payload.reviewer_fix;
  if (!isRecord(fix) || !row.task_id) return null;
  const { limits, measured, tests, revert } = fix;
  const outcome = FIX_OUTCOMES.find((value) => value === fix.outcome);
  if (!outcome || !Array.isArray(fix.fixes)) return null;
  if (!isRecord(limits) || !isNum(limits.max_changed_lines) || !isNum(limits.max_changed_files)) return null;
  if (!isRecord(measured) || !isNum(measured.changed_lines) || !isNum(measured.changed_files)) return null;
  if (tests != null && (!isRecord(tests) || typeof tests.passed !== "boolean")) return null;
  const fixes = [];
  for (const item of fix.fixes) {
    if (!isRecord(item) || typeof item.file !== "string" || !isNum(item.line_start) || !isNum(item.line_end)
      || typeof item.problem !== "string" || typeof item.change !== "string") return null;
    fixes.push({ file: item.file, line_start: item.line_start, line_end: item.line_end, problem: item.problem, change: item.change });
  }
  return {
    task_id: row.task_id,
    agent_run_id: row.agent_run_id ?? "",
    review_round: row.review_round ?? 0,
    recorded_at: row.created_at,
    restore_failed: row.type === "review.fix_restore_failed",
    outcome,
    reason: typeof fix.reason === "string" ? fix.reason : null,
    limits: { max_changed_lines: limits.max_changed_lines, max_changed_files: limits.max_changed_files },
    measured: { changed_lines: measured.changed_lines, changed_files: measured.changed_files },
    fixes,
    tests: isRecord(tests) ? { passed: tests.passed === true, error_key: typeof tests.error_key === "string" ? tests.error_key : null } : null,
    reverted: revert != null,
  };
}

/** Reads the recorded review routing, integration verification and plan quality warnings of one Work. */
export function getWorkAssurance(db: CoreDatabase, workId: string): WorkAssurance {
  if (!db.get("SELECT id FROM works WHERE id = ?", workId)) throw notFound("work", workId);
  const reviews: WorkAssuranceReview[] = [];
  for (const row of db.all<{ id: string; review_decision_json: string }>(
    "SELECT id, review_decision_json FROM tasks WHERE work_id = ? AND review_decision_json IS NOT NULL ORDER BY id",
    workId,
  )) {
    const decision = parseObject(row.review_decision_json);
    if (!decision || typeof decision.required !== "boolean") continue;
    const forced = Array.isArray(decision.forced_reasons) ? decision.forced_reasons.filter(isRecord) : [];
    reviews.push({
      task_id: row.id,
      required: decision.required,
      base: typeof decision.base === "string" ? decision.base : "",
      skip_reason: typeof decision.skip_reason === "string" ? decision.skip_reason : null,
      forced_reasons: forced.map((reason) => ({ code: String(reason.code ?? ""), detail: String(reason.detail ?? "") })),
    });
  }
  const events = (type: string): JsonObject[] =>
    db.all<{ payload_json: string }>("SELECT payload_json FROM events WHERE work_id = ? AND type = ? ORDER BY sequence", workId, type)
      .map((row) => parseObject(row.payload_json))
      .filter((payload): payload is JsonObject => payload !== null);
  const verifications = events("work.integration_verification_completed");
  const reviewerFixes: WorkAssuranceReviewerFix[] = [];
  for (const row of db.all<{ type: string; task_id: string | null; agent_run_id: string | null; created_at: string; payload_json: string; review_round: number | null }>(
    `SELECT e.type, e.task_id, e.agent_run_id, e.created_at, e.payload_json, t.review_round
     FROM events e LEFT JOIN tasks t ON t.id = e.task_id
     WHERE e.work_id = ? AND e.type IN ('review.passed', 'review.failed', 'review.fix_restore_failed')
       AND json_valid(e.payload_json) AND json_type(e.payload_json, '$.reviewer_fix') = 'object'
     ORDER BY e.created_at, e.sequence`,
    workId,
  )) {
    const payload = parseObject(row.payload_json);
    const fix = payload ? readReviewerFix(row, payload) : null;
    if (fix) reviewerFixes.push(fix);
    else console.warn(`work-assurance: skipped a malformed reviewer_fix on ${row.type} (work ${workId})`);
  }
  return {
    work_id: workId,
    reviews,
    integration_verification: verifications.at(-1) ?? null,
    plan_quality_warnings: events("work.plan_quality_warned"),
    reviewer_fixes: reviewerFixes,
  };
}
