import { OUTPUT_RESUBMIT_LIMIT_SETTINGS_KEY, isReportFormatInvalidErrorKey, REPORT_RESUBMIT_OPTION_KEY } from "@owl/shared";
import type { SettingsReader } from "./owner-language";

export const REPORT_RESUBMIT_LIMIT_KEY = "report_resubmit_limit";
export const DEFAULT_REPORT_RESUBMIT_LIMIT = 2;
export const MAX_REPORT_RESUBMIT_LIMIT = 10;

function storedLimit(reader: SettingsReader, key: string): number | null {
  try {
    const row = reader.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", key);
    if (!row) return null;
    const value = JSON.parse(row.value_json) as unknown;
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_REPORT_RESUBMIT_LIMIT ? value : null;
  } catch {
    return null;
  }
}

/**
 * Automatic output-only resubmissions per run, for every role: output_resubmit_limit, else the older
 * report_resubmit_limit, else the default. A missing or invalid value (integer 0..10) falls through.
 */
export function outputResubmitLimit(reader: SettingsReader): number {
  return storedLimit(reader, OUTPUT_RESUBMIT_LIMIT_SETTINGS_KEY) ?? storedLimit(reader, REPORT_RESUBMIT_LIMIT_KEY) ?? DEFAULT_REPORT_RESUBMIT_LIMIT;
}

/** Kept for the Worker report context (report_resubmit_limit); it reads the same value as outputResubmitLimit. */
export const reportResubmitLimit = outputResubmitLimit;

interface ResubmitReader extends SettingsReader {
  all<T extends object>(sql: string, ...parameters: string[]): T[];
}

function parseObject(json: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(json) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The Claude session to resume when the Owner answered the latest
 * report-format Decision with "resubmit only the report", or Core started that
 * recovery itself. Valid for one run after that answer or recovery and only while the Task still has the same worktree.
 */
export function pendingReportResubmit(db: ResubmitReader, taskId: string, agentRunId: string, worktreePath: string | null): string | null {
  const failure = db.get<{ payload_json: string; created_at: string }>(
    "SELECT payload_json, created_at FROM events WHERE task_id = ? AND type = 'task.failure.classified' ORDER BY sequence DESC LIMIT 1",
    taskId,
  );
  const payload = failure ? parseObject(failure.payload_json) : null;
  if (!failure || !payload || !isReportFormatInvalidErrorKey(payload.error_key)) return null;
  if (typeof payload.provider_session_id !== "string" || payload.provider_session_id.length === 0) return null;
  if (worktreePath === null || payload.worktree_path !== worktreePath) return null;
  // Core's own recovery (kind output_format, action report_resubmit) is a signal like the Owner's answer; it names the failed run it answers.
  const automatic = db.get<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'recovery.started' AND json_extract(payload_json, '$.kind') = 'output_format'
        AND json_extract(payload_json, '$.action') = 'report_resubmit' AND json_extract(payload_json, '$.source_event_id') = ? LIMIT 1`,
    taskId,
    String(payload.agent_run_id),
  );
  let since = failure.created_at;
  if (!automatic) {
    const answers = db.all<{ answer_json: string; received_at: string }>(
      `SELECT decision_answers.answer_json, decision_answers.received_at
         FROM decision_answers JOIN decisions ON decisions.id = decision_answers.decision_id
        WHERE EXISTS (SELECT 1 FROM json_each(decisions.blocked_task_ids_json) WHERE value = ?)
        ORDER BY decision_answers.received_at DESC LIMIT 1`,
      taskId,
    );
    const answer = answers[0];
    if (!answer || answer.received_at <= failure.created_at) return null;
    if (parseObject(answer.answer_json)?.option_key !== REPORT_RESUBMIT_OPTION_KEY) return null;
    since = answer.received_at;
  }
  const later = db.get<{ id: string }>(
    "SELECT id FROM agent_runs WHERE task_id = ? AND role IN ('worker','designer') AND id <> ? AND created_at > ? LIMIT 1",
    taskId,
    agentRunId,
    since,
  );
  return later ? null : payload.provider_session_id;
}
