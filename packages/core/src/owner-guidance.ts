import { compareText } from "./context-canonical";
import type { JsonObject } from "./types";

interface GuidanceReader {
  all<T extends object>(sql: string, ...parameters: string[]): T[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}


/**
 * Owner answers to this Work's Decisions, newest first. Agents receive them
 * so an answer such as "retry after checking the worktree" actually reaches
 * the Manager and Worker instead of only resuming the state machine.
 */
export function ownerGuidance(db: GuidanceReader, workId: string, taskId?: string): JsonObject[] {
  const rows = db.all<{ reason: string; scope: string; blocked_task_ids_json: string; answer_json: string; received_at: string }>(
    `SELECT decisions.reason, decisions.scope, decisions.blocked_task_ids_json,
            decision_answers.answer_json, decision_answers.received_at
       FROM decision_answers JOIN decisions ON decisions.id = decision_answers.decision_id
      WHERE decisions.work_id = ?
      ORDER BY decision_answers.received_at DESC, decision_answers.decision_id DESC LIMIT 10`,
    workId,
  );
  const guidance: JsonObject[] = [];
  for (const row of rows) {
    let answer: unknown;
    let blocked: unknown;
    try {
      answer = JSON.parse(row.answer_json);
      blocked = JSON.parse(row.blocked_task_ids_json);
    } catch {
      continue;
    }
    const blockedIds = Array.isArray(blocked) ? blocked.filter((id): id is string => typeof id === "string") : [];
    if (taskId !== undefined && row.scope === "task" && !blockedIds.includes(taskId)) continue;
    const text = isRecord(answer) && typeof answer.answer === "string" ? answer.answer.trim() : "";
    const optionKey = isRecord(answer) && typeof answer.option_key === "string" ? answer.option_key : null;
    if (text.length === 0 && optionKey === null) continue;
    guidance.push({ decision_reason: row.reason, answer: text, option_key: optionKey, answered_at: row.received_at });
  }
  if (taskId !== undefined) {
    // An Owner's resume message for a prerequisite wait is guidance in the same shape.
    const resumes = db.all<{ payload_json: string; created_at: string }>(
      "SELECT payload_json, created_at FROM events WHERE type = 'task.prerequisite_resumed' AND task_id = ? ORDER BY sequence DESC LIMIT 5",
      taskId,
    );
    for (const resume of resumes) {
      let payload: unknown;
      try {
        payload = JSON.parse(resume.payload_json);
      } catch {
        continue;
      }
      const message = isRecord(payload) && typeof payload.message === "string" ? payload.message.trim() : "";
      if (message.length === 0) continue;
      guidance.push({ decision_reason: "prerequisite_resumed: the Owner resumed the prerequisite wait", answer: message, option_key: null, answered_at: resume.created_at });
    }
    guidance.sort((a, b) => compareText(String(b.answered_at), String(a.answered_at)));
  }
  return guidance.slice(0, 5);
}
