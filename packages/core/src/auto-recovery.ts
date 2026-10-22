import {
  AUTO_RECOVERY_SETTINGS_KEY,
  DEFAULT_AUTO_RECOVERY_SETTINGS,
  readAutoRecoverySettings,
} from "../../shared/dist/auto-recovery-settings.js";
import { cancelWorkOption, option, type DecisionBrief } from "./decision-brief";
import { finalAutoContinueLimit } from "./final-continue-limit";
import { FALLBACK_BACKOFF_MINUTES } from "./provider-pause-controller";
import type { OwnerLanguage, SettingsReader } from "./owner-language";
import { appendEventInTransaction } from "./state-reducer";
import { lineageRootOf, type LineageReader } from "./task-lineage";
import type { CoreWriteLaneTransaction, JsonObject } from "./types";

export type AutoRecoveryKind =
  | "integration_conflict" | "final_incomplete" | "output_format" | "budget_exhausted"
  | "plan_quality_rejected" | "provider_transient" | "criteria_too_strict" | "partial_repeated";

/** A Work id (kind "work") or a lineage root Task id (kind "task"). */
export interface AutoRecoveryTarget {
  readonly kind: "work" | "task";
  readonly id: string;
}

export const AUTO_RECOVERY_EVENT = "recovery.started";

export interface AutoRecoveryStored {
  readonly limit: number;
  readonly warnings: readonly string[];
  /** false when no auto_recovery value is stored. */
  readonly stored: boolean;
}

const warned = new Set<string>();

/** The stored auto_recovery setting; a missing value is the default, an invalid one falls back to it with a warning. */
export function autoRecoverySettings(reader: SettingsReader): AutoRecoveryStored {
  try {
    const row = reader.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", AUTO_RECOVERY_SETTINGS_KEY);
    if (!row) return { limit: DEFAULT_AUTO_RECOVERY_SETTINGS.limit, warnings: [], stored: false };
    const { settings, warnings } = readAutoRecoverySettings(JSON.parse(row.value_json) as unknown);
    for (const message of warnings) {
      if (!warned.has(message)) {
        warned.add(message);
        console.warn(`[owl-core] auto_recovery: ${message}`);
      }
    }
    return { limit: settings.limit, warnings, stored: true };
  } catch (error) {
    console.warn("[owl-core] Could not read auto_recovery; using defaults", error);
    return { limit: DEFAULT_AUTO_RECOVERY_SETTINGS.limit, warnings: [], stored: false };
  }
}

/** Recoveries allowed per reason. The older final_auto_continue_limit applies to final_incomplete only while auto_recovery is not stored. */
export function autoRecoveryLimit(reader: SettingsReader, kind?: AutoRecoveryKind): number {
  const stored = autoRecoverySettings(reader);
  if (!stored.stored && kind === "final_incomplete") return finalAutoContinueLimit(reader);
  return stored.limit;
}

/** Sequence after which recoveries are counted: the latest Owner answer that unblocked the target or Work reopen, else 0. */
function countingStart(reader: LineageReader, target: AutoRecoveryTarget): number {
  const workId = target.kind === "work"
    ? target.id
    : reader.get<{ work_id: string }>("SELECT work_id FROM tasks WHERE id = ?", target.id)?.work_id;
  if (!workId) return 0;
  const row = reader.get<{ boundary: number | null }>(
    `SELECT MAX(events.sequence) AS boundary FROM events
      WHERE events.work_id = ?
        AND (events.type = 'work.reopened'
          OR (events.type = 'decision.resolved'
              AND EXISTS (
                SELECT 1 FROM decisions
                 WHERE decisions.id = json_extract(events.payload_json, '$.decision_id')
                   AND (decisions.scope = 'work'
                     OR EXISTS (SELECT 1 FROM json_each(decisions.blocked_task_ids_json) blocked
                                  JOIN tasks ON tasks.id = blocked.value
                                 WHERE COALESCE(tasks.lineage_root_task_id, tasks.id) = ?)))))`,
    workId,
    target.id,
  );
  return row?.boundary ?? 0;
}

const STARTED_ROWS = `SELECT payload_json, created_at, sequence FROM events
  WHERE type = '${AUTO_RECOVERY_EVENT}' AND json_extract(payload_json, '$.kind') = ?
    AND json_extract(payload_json, '$.target_kind') = ? AND json_extract(payload_json, '$.target_id') = ?
    AND sequence > ?`;

/** Counted recoveries of this kind for the target since the last Owner answer or reopen. Read from events every time, so a restart keeps the count. */
export function autoRecoveryUsed(reader: LineageReader, kind: AutoRecoveryKind, target: AutoRecoveryTarget): number {
  const row = reader.get<{ used: number }>(
    `SELECT COUNT(*) AS used FROM (${STARTED_ROWS}) WHERE json_extract(payload_json, '$.counted') = 1`,
    kind, target.kind, target.id, countingStart(reader, target),
  );
  return row?.used ?? 0;
}

export interface AutoRecoveryAttempt {
  readonly attempt_no: number;
  readonly limit: number;
  readonly counted: boolean;
  readonly action: string;
  readonly previous_failure: JsonObject | null;
  readonly source_event_id: string;
  readonly resume_at: string | null;
  readonly created_at: string;
  readonly sequence: number;
}

/** Every record (counted or not) of this kind for the target since the last Owner answer or reopen, oldest first. */
export function autoRecoveryAttempts(reader: LineageReader, kind: AutoRecoveryKind, target: AutoRecoveryTarget): AutoRecoveryAttempt[] {
  return reader
    .all<{ payload_json: string; created_at: string; sequence: number }>(`${STARTED_ROWS} ORDER BY sequence ASC`, kind, target.kind, target.id, countingStart(reader, target))
    .map((row) => {
      const p = JSON.parse(row.payload_json) as Record<string, unknown>;
      return {
        attempt_no: Number(p.attempt_no),
        limit: Number(p.limit),
        counted: p.counted === true,
        action: String(p.action),
        previous_failure: (p.previous_failure ?? null) as JsonObject | null,
        source_event_id: String(p.source_event_id),
        resume_at: typeof p.resume_at === "string" ? p.resume_at : null,
        created_at: row.created_at,
        sequence: row.sequence,
      };
    });
}

export interface RecordAutoRecoveryInput {
  readonly kind: AutoRecoveryKind;
  readonly target: AutoRecoveryTarget;
  readonly workId: string;
  readonly action: string;
  readonly sourceEventId: string;
  readonly previousFailure?: JsonObject | null;
  /** false only for a 429 wait, which is recorded for the screen but not counted. */
  readonly counted?: boolean;
  /** The time to resume; a function gets the attempt number the record will have. */
  readonly resumeAt?: string | null | ((attemptNo: number) => string);
  readonly now?: string;
}

export interface AutoRecoveryStart {
  readonly attempt_no: number;
  readonly limit: number;
  readonly resume_at: string | null;
}

/** Writes recovery.started once per failure and returns its attempt number and limit; a second write for the same failure returns the first one's numbers. */
export function recordAutoRecoveryInTransaction(
  transaction: CoreWriteLaneTransaction,
  input: RecordAutoRecoveryInput,
): AutoRecoveryStart {
  const idempotencyKey = autoRecoveryKey(input);
  const existing = transaction.get<{ payload_json: string }>("SELECT payload_json FROM events WHERE idempotency_key = ?", idempotencyKey);
  if (existing) {
    const p = JSON.parse(existing.payload_json) as { attempt_no: number; limit: number; resume_at?: string | null };
    return { attempt_no: p.attempt_no, limit: p.limit, resume_at: p.resume_at ?? null };
  }
  const limit = autoRecoveryLimit(transaction, input.kind);
  const attemptNo = autoRecoveryUsed(transaction, input.kind, input.target) + 1;
  const resumeAt = typeof input.resumeAt === "function" ? input.resumeAt(attemptNo) : input.resumeAt ?? null;
  appendEventInTransaction(transaction, {
    type: AUTO_RECOVERY_EVENT,
    idempotencyKey,
    workId: input.workId,
    taskId: input.target.kind === "task" ? input.target.id : null,
    payload: {
      schema_version: 1,
      kind: input.kind,
      target_kind: input.target.kind,
      target_id: input.target.id,
      attempt_no: attemptNo,
      limit,
      counted: input.counted ?? true,
      action: input.action,
      previous_failure: input.previousFailure ?? null,
      source_event_id: input.sourceEventId,
      resume_at: resumeAt,
    },
    ...(input.now ? { now: input.now } : {}),
  });
  return { attempt_no: attemptNo, limit, resume_at: resumeAt };
}

function autoRecoveryKey(input: RecordAutoRecoveryInput): string {
  return `auto-recovery:${input.kind}:${input.target.id}:${input.sourceEventId}`;
}

/**
 * recordAutoRecoveryInTransaction when a count below the limit remains, else null. A repeat for a failure that
 * already has its record returns that record, so a replay after a crash never turns the last recovery into a Decision.
 */
export function startAutoRecoveryInTransaction(
  transaction: CoreWriteLaneTransaction,
  input: RecordAutoRecoveryInput,
): AutoRecoveryStart | null {
  const recorded = transaction.get<{ one: number }>("SELECT 1 AS one FROM events WHERE idempotency_key = ?", autoRecoveryKey(input));
  if (!recorded && (input.counted ?? true) && autoRecoveryUsed(transaction, input.kind, input.target) >= autoRecoveryLimit(transaction, input.kind)) return null;
  return recordAutoRecoveryInTransaction(transaction, input);
}

/** When the attempt_no-th recovery of a temporary provider error resumes: 15, 30, then 60 minutes (the last step repeats). */
export function transientRecoveryResumeAt(attemptNo: number, now: number = Date.now()): string {
  return new Date(now + FALLBACK_BACKOFF_MINUTES[Math.min(attemptNo - 1, FALLBACK_BACKOFF_MINUTES.length - 1)] * 60_000).toISOString();
}

/** The latest resume time of a counted wait for this Work that has not passed yet, else null. */
export function transientRecoveryPendingUntil(reader: LineageReader, workId: string, now: number = Date.now()): string | null {
  const row = reader.get<{ resume_at: string | null }>(
    `SELECT json_extract(payload_json, '$.resume_at') AS resume_at FROM events
      WHERE type = '${AUTO_RECOVERY_EVENT}' AND json_extract(payload_json, '$.kind') = 'provider_transient'
        AND json_extract(payload_json, '$.target_kind') = 'work' AND json_extract(payload_json, '$.target_id') = ?
        AND json_extract(payload_json, '$.counted') = 1
      ORDER BY sequence DESC LIMIT 1`,
    workId,
  );
  return row?.resume_at != null && Date.parse(row.resume_at) > now ? row.resume_at : null;
}

const ALL_KINDS: readonly AutoRecoveryKind[] = [
  "integration_conflict", "final_incomplete", "output_format", "budget_exhausted",
  "plan_quality_rejected", "provider_transient", "criteria_too_strict", "partial_repeated",
];

/** Why Core opened the Decision at the first failure instead of trying to fix it. */
export type ImmediateDecisionReason =
  | "design_decision" | "irreversible_operation" | "uncommitted_changes" | "authentication_failed"
  | "harness_config" | "owner_criteria" | "recovery_disabled";

export interface ImmediateDecisionInput {
  /** The Designer reported design_blocked. */
  readonly designBlocked?: boolean;
  /** error_key of the failed Task. */
  readonly errorKey?: string | null;
  /** Payload of a system.alert (work_merge_failed). */
  readonly alert?: JsonObject | null;
}

const AUTHENTICATION_ERROR_KEY = /^provider_failed:harness_error:(?:401|403)$/u;
const CONFIG_ERROR_KEY = /^(?:provider_config_invalid|spawn_error)$/u;
const LEGACY_DIRTY_MESSAGE = /has uncommitted changes/u;

/** A merge into canonical_path that stopped on files the Owner has not committed. Checked before a conflict. */
function isUncommittedBaseChange(alert: JsonObject): boolean {
  if (alert.kind !== "work_merge_failed" || alert.merge_kind !== "error" || alert.integration_worktree !== undefined) return false;
  if (Array.isArray(alert.overlap_files)) return alert.overlap_files.length > 0;
  return typeof alert.merge_message === "string" && LEGACY_DIRTY_MESSAGE.test(alert.merge_message);
}

/** The reason to skip automatic recovery for this failure, or null when recovery may run. */
export function immediateDecisionReason(input: ImmediateDecisionInput): ImmediateDecisionReason | null {
  if (input.designBlocked) return "design_decision";
  if (input.alert && isUncommittedBaseChange(input.alert)) return "uncommitted_changes";
  if (input.errorKey) {
    if (AUTHENTICATION_ERROR_KEY.test(input.errorKey)) return "authentication_failed";
    if (CONFIG_ERROR_KEY.test(input.errorKey)) return "harness_config";
  }
  return null;
}

/** Wording of the "tried automatically" section; kept apart from decision-brief.ts TEXT. */
export const AUTO_RECOVERY_TEXT: Readonly<Record<OwnerLanguage, {
  readonly triedHeading: string;
  readonly notTriedHeading: string;
  readonly tried: (count: number, limit: number) => string;
  readonly attempt: (no: number, action: string, result: string) => string;
  readonly notTried: (reason: string) => string;
  readonly summary: (count: number) => string;
  readonly reasons: Readonly<Record<ImmediateDecisionReason, string>>;
  readonly actions: Readonly<Record<string, string>>;
}>> = {
  ja: {
    triedHeading: "自動で試したこと",
    notTriedHeading: "自動では試していません",
    tried: (count, limit) => `自動で試したこと: ${count}回（上限 ${limit}回）。直りませんでした。`,
    attempt: (no, action, result) => `${no}回目: ${action}。結果: ${result}`,
    notTried: (reason) => `自動では試していません（理由: ${reason}）。`,
    summary: (count) => `自動で ${count} 回試しました。直りませんでした。`,
    reasons: {
      design_decision: "設計の判断", irreversible_operation: "費用がかかる、または元に戻せない操作", uncommitted_changes: "未コミットの変更",
      authentication_failed: "認証の失敗", harness_config: "Harness の設定の誤り", owner_criteria: "Owner が指定した受け入れ条件",
      recovery_disabled: "自動の復旧の回数が 0",
    },
    actions: {
      add_conflict_task: "両方の変更を残して衝突を直す Task を足しました",
      report_resubmit: "同じ session に報告だけを出し直させました",
      fresh_rerun: "新しい実行を始めました",
      replan_different_approach: "Manager に別のやり方で計画を立て直させました",
      repair_partial: "Manager に同じ途中報告の原因を調べさせ、Core が残りの条件を確かめました",
      relax_criteria: "Manager が作った受け入れ条件を、確かめ方を残したまま緩めさせました",
    },
  },
  en: {
    triedHeading: "Tried automatically",
    notTriedHeading: "Not tried automatically",
    tried: (count, limit) => `Tried automatically: ${count} ${count === 1 ? "time" : "times"} (limit ${limit}). Not fixed.`,
    attempt: (no, action, result) => `Attempt ${no}: ${action}. Result: ${result}`,
    notTried: (reason) => `Not tried automatically (reason: ${reason}).`,
    summary: (count) => `Tried automatically ${count} ${count === 1 ? "time" : "times"}. Not fixed.`,
    reasons: {
      design_decision: "a design decision", irreversible_operation: "a costly or irreversible operation", uncommitted_changes: "uncommitted changes",
      authentication_failed: "an authentication failure", harness_config: "a Harness configuration error", owner_criteria: "acceptance criteria the Owner set",
      recovery_disabled: "automatic recovery is set to 0",
    },
    actions: {
      add_conflict_task: "Added a Task that fixes the conflict and keeps both changes",
      report_resubmit: "Asked the same session to send only the report again",
      fresh_rerun: "Started a new run",
      replan_different_approach: "Asked the Manager to replan with a different approach",
      repair_partial: "Had the Manager look into the repeated partial report, and Core checked the open criteria",
      relax_criteria: "Had the Manager loosen the criteria it wrote, keeping how they are checked",
    },
  },
};

const LINE_MAX = 200;
const LINES_MAX = 10;

/** One line of at most LINE_MAX characters; the rest is cut and marked with "…". */
function oneLine(value: string): string {
  const line = value.replace(/\s+/gu, " ").trim().replace(/[。.]$/u, "");
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? value;
}

export interface AutoRecoveryScope {
  readonly workId: string;
  readonly taskIds: readonly string[];
}

/**
 * Put the "tried automatically" section first in brief.tried: the counted recoveries of the scope since
 * the last Owner answer, or the reason Core did not try. A brief with neither is returned as it is.
 */
export function withAutoRecoveryTried(
  reader: LineageReader,
  brief: DecisionBrief,
  scope: AutoRecoveryScope,
  language: OwnerLanguage,
  immediate: ImmediateDecisionReason | null = null,
): DecisionBrief {
  const t = AUTO_RECOVERY_TEXT[language];
  if (immediate) return { ...brief, tried: `${t.notTried(t.reasons[immediate])}\n${brief.tried}` };
  const records = countedRecords(reader, autoRecoveryTargets(reader, scope.workId, scope.taskIds)).map((entry) => entry.record);
  if (records.length === 0) return brief;
  const limit = records[records.length - 1].limit;
  const shown = records.slice(-Math.max(Math.min(limit, LINES_MAX), 1));
  // Attempt k ended in the failure that attempt k+1 started from; the last one ended in the failure behind this Decision.
  const resultOf = (next: AutoRecoveryAttempt | undefined): string => {
    const summary = next?.previous_failure?.summary;
    return typeof summary === "string" && summary.trim().length > 0 ? summary : firstLine(brief.reason);
  };
  const lines = shown.map((record, index) =>
    oneLine(t.attempt(index + 1, t.actions[record.action] ?? record.action, oneLine(resultOf(shown[index + 1])))));
  return { ...brief, tried: [t.tried(shown.length, limit), ...lines, brief.tried].join("\n") };
}

/** What Core tells the agent for each kind of recovery; the Worker and Manager prompts point to this field. */
const AUTO_RECOVERY_INSTRUCTIONS: Readonly<Record<AutoRecoveryKind, string>> = {
  integration_conflict: "Core is retrying after an integration conflict. Add a Worker Task that resolves it so that both sides' changes stay; do not drop either side. Put in its acceptance criteria that both parents' changes remain and that the Project's check_commands pass. If both cannot stay, the Worker reports it in question_for_manager and the Manager asks the Owner.",
  final_incomplete: "Core is retrying after the final check judged the Work incomplete. Finish the missing points named in previous_failure.",
  output_format: "Core is retrying after your report did not match the required format. Your earlier work is still in the worktree: do not redo it, send only a correctly formed report.",
  budget_exhausted: "Core is retrying after the remake or review budget ran out. Use a different approach from the one in previous_failure; the same approach is rejected.",
  plan_quality_rejected: "Core is retrying after the plan failed the quality check. Fix the problems named in previous_failure.",
  provider_transient: "Core is retrying after a temporary provider error. Continue the Task; nothing in your work is wrong.",
  criteria_too_strict: "Core is retrying after an acceptance criterion was judged too strict. Follow relaxed_criteria; criteria the Owner set are not relaxed.",
  partial_repeated: "Core is retrying after the same partial report came twice. Use check_results and do not repeat the report; finish the open points or explain what blocks them.",
};

function autoRecoveryTargets(reader: LineageReader, workId: string | null, taskIds: readonly string[]): AutoRecoveryTarget[] {
  return [
    ...(workId === null ? [] : [{ kind: "work", id: workId } as const]),
    ...[...new Set(taskIds.map((id) => lineageRootOf(reader, id)))].map((id): AutoRecoveryTarget => ({ kind: "task", id })),
  ];
}

function countedRecords(reader: LineageReader, targets: readonly AutoRecoveryTarget[], kinds: readonly AutoRecoveryKind[] = ALL_KINDS) {
  return targets
    .flatMap((target) => kinds.flatMap((kind) => autoRecoveryAttempts(reader, kind, target).filter((record) => record.counted).map((record) => ({ kind, target, record }))))
    .sort((a, b) => a.record.sequence - b.record.sequence);
}

function failureField(failure: JsonObject | null, key: string): string | null {
  const value = failure?.[key];
  return typeof value === "string" ? value : null;
}

/** What Core tells the Worker when its own run of the Manager's checks found every open criterion satisfied. */
export const PARTIAL_CHECKS_PASSED_INSTRUCTION = "Core が残りの条件を確かめ、全部通りました。この結果を証拠にして success を報告してください。";

/** Attempt.auto_recovery for a Worker or Designer: the latest recovery of the Task's lineage, or null when it was never recovered. */
export function autoRecoveryForTask(reader: LineageReader, taskId: string): JsonObject | null {
  const latest = countedRecords(reader, autoRecoveryTargets(reader, null, [taskId])).at(-1);
  if (!latest) return null;
  const stepAfter = (kind: AutoRecoveryKind, id: string, sequence: number): Record<string, unknown> | null => {
    const step = reader.get<{ payload_json: string }>(
      `SELECT payload_json FROM events WHERE type = 'recovery.step' AND sequence > ?
         AND json_extract(payload_json, '$.kind') = ? AND json_extract(payload_json, '$.target_id') = ?
        ORDER BY sequence DESC LIMIT 1`,
      sequence, kind, id,
    );
    return step ? JSON.parse(step.payload_json) as Record<string, unknown> : null;
  };
  const list = (value: unknown): JsonObject[] => Array.isArray(value) ? value as JsonObject[] : [];
  // A partial_repeated repair that also loosened a criterion ends with a criteria_too_strict record; the Worker still hears it as the partial_repeated one.
  const partial = countedRecords(reader, autoRecoveryTargets(reader, null, [taskId]), ["partial_repeated"]).at(-1);
  const partialStep = partial ? stepAfter("partial_repeated", partial.target.id, partial.record.sequence) : null;
  if (partial && partialStep && (latest.kind === "partial_repeated" || (latest.kind === "criteria_too_strict" && latest.record.sequence > partial.record.sequence))) {
    const relaxedStep = latest.kind === "criteria_too_strict" ? stepAfter("criteria_too_strict", latest.target.id, latest.record.sequence) : null;
    return {
      kind: "partial_repeated",
      attempt_no: partial.record.attempt_no,
      limit: partial.record.limit,
      instruction: partialStep.all_passed === true ? PARTIAL_CHECKS_PASSED_INSTRUCTION : AUTO_RECOVERY_INSTRUCTIONS.partial_repeated,
      previous_failure: partial.record.previous_failure,
      check_results: list(partialStep.check_results),
      relaxed_criteria: list(relaxedStep?.relaxed_criteria),
    };
  }
  const stepPayload = stepAfter(latest.kind, latest.target.id, latest.record.sequence) ?? {};
  return {
    kind: latest.kind,
    attempt_no: latest.record.attempt_no,
    limit: latest.record.limit,
    instruction: AUTO_RECOVERY_INSTRUCTIONS[latest.kind],
    previous_failure: latest.record.previous_failure,
    check_results: list(stepPayload.check_results),
    relaxed_criteria: list(stepPayload.relaxed_criteria),
  };
}

/** context.auto_recovery for a Manager: the latest recovery of the Work or its failed Tasks, with every earlier failure of that kind. */
export function autoRecoveryForManager(reader: LineageReader, workId: string, taskIds: readonly string[]): JsonObject | null {
  const records = countedRecords(reader, autoRecoveryTargets(reader, workId, taskIds));
  const latest = records.at(-1);
  if (!latest) return null;
  return {
    kind: latest.kind,
    attempt_no: latest.record.attempt_no,
    limit: latest.record.limit,
    instruction: AUTO_RECOVERY_INSTRUCTIONS[latest.kind],
    previous_failures: records
      .filter((entry) => entry.kind === latest.kind && entry.target.id === latest.target.id)
      .map((entry) => ({
        attempt_no: entry.record.attempt_no,
        summary: failureField(entry.record.previous_failure, "summary"),
        error_key: failureField(entry.record.previous_failure, "error_key"),
      })),
  };
}

/** Option key of the answer that sends the Owner's words to the Manager to rewrite the criteria. */
export const REWRITE_CRITERIA_OPTION_KEY = "rewrite_criteria";

export interface CriteriaDecisionInput {
  readonly taskTitle: string;
  /** owner: the criteria are the Owner's (or have no origin) so Core did not loosen them; exhausted: the automatic loosening used up its limit. */
  readonly variant: "owner" | "exhausted";
  /** The criteria the Worker or Reviewer could not verify. */
  readonly defects: readonly { readonly criterion_id: string; readonly criterion: string; readonly reason: string }[];
  /** The Owner's own sentence behind each criterion, when the criterion has one. */
  readonly quotes?: Readonly<Record<string, string>>;
}

const CRITERIA_BRIEF_TEXT: Readonly<Record<OwnerLanguage, {
  readonly reason: (variant: CriteriaDecisionInput["variant"], title: string, ids: string) => string;
  readonly question: (title: string) => string;
  readonly currentState: string;
  readonly tried: (variant: CriteriaDecisionInput["variant"]) => string;
  readonly defect: (id: string, text: string, reason: string, quote: string | null) => string;
  readonly rewrite: { readonly label: string; readonly description: string };
  readonly retry: { readonly label: string; readonly description: string };
  readonly instruction: string;
}>> = {
  ja: {
    reason: (variant, title, ids) => variant === "owner"
      ? `Owner が指定した受け入れ条件 ${ids} を、Task「${title}」の中では確かめられません。`
      : `受け入れ条件 ${ids} を自動で緩めても、Task「${title}」の中では確かめられません。`,
    question: (title) => `Task「${title}」の受け入れ条件をどうしますか。`,
    currentState: "Task は止まっています。確かめられない条件が残っています。",
    tried: (variant) => variant === "owner"
      ? "条件は変えていません。Owner が指定した条件は、自動では変えません。"
      : "Manager が作った条件を緩める直しを繰り返しました。",
    defect: (id, text, reason, quote) => [`${id}: ${text}`, ...(quote ? [`  Owner の言葉: ${quote}`] : []), `  確かめられない理由: ${reason}`].join("\n"),
    rewrite: { label: "条件を書き直す（答えの文を Manager に渡します）", description: "下に書いた答えを Manager に渡し、Task の中で確かめられる条件に書き直させます。" },
    retry: { label: "このままもう一度試す", description: "条件を変えずに、同じ Task をもう一度実行します。" },
    instruction: "The Owner chose to rewrite the acceptance criteria that cannot be verified inside the Task. Rewrite each so it can be proven inside the Task and keeps what the Owner asked for; follow the Owner's words.",
  },
  en: {
    reason: (variant, title, ids) => variant === "owner"
      ? `Acceptance criteria ${ids} set by the Owner cannot be verified inside Task "${title}".`
      : `Acceptance criteria ${ids} still cannot be verified inside Task "${title}" after Core loosened them automatically.`,
    question: (title) => `What should happen to the acceptance criteria of Task "${title}"?`,
    currentState: "The Task is stopped. Some criteria still cannot be verified.",
    tried: (variant) => variant === "owner"
      ? "The criteria were not changed. Core never changes criteria the Owner set."
      : "The Manager was asked to loosen the criteria it wrote, repeatedly.",
    defect: (id, text, reason, quote) => [`${id}: ${text}`, ...(quote ? [`  Owner's words: ${quote}`] : []), `  Why it cannot be verified: ${reason}`].join("\n"),
    rewrite: { label: "Rewrite the criteria (your answer goes to the Manager)", description: "Sends your answer below to the Manager, who rewrites the criteria so they can be verified inside the Task." },
    retry: { label: "Try again as it is", description: "Runs the same Task again without changing its criteria." },
    instruction: "The Owner chose to rewrite the acceptance criteria that cannot be verified inside the Task. Rewrite each so it can be proven inside the Task and keeps what the Owner asked for; follow the Owner's words.",
  },
};

/** The Decision for a criteria defect Core does not fix by itself: an Owner (or origin-less) criterion, or the loosening limit used up. */
export function criteriaDecisionBrief(input: CriteriaDecisionInput, language: OwnerLanguage): DecisionBrief {
  const t = CRITERIA_BRIEF_TEXT[language];
  const ids = [...new Set(input.defects.map((defect) => defect.criterion_id).filter((id) => id !== ""))].join(", ") || "-";
  return {
    reason: t.reason(input.variant, input.taskTitle, ids),
    question: t.question(input.taskTitle),
    current_state: [t.currentState, ...input.defects.map((defect) => t.defect(defect.criterion_id || "-", defect.criterion, defect.reason, input.quotes?.[defect.criterion_id] ?? null))].join("\n"),
    tried: t.tried(input.variant),
    options: [
      { ...option(REWRITE_CRITERIA_OPTION_KEY, t.rewrite), instruction: t.instruction },
      option("retry", t.retry),
      cancelWorkOption(language),
    ],
    recommended: null,
  };
}

/** The one-line summary decision.opened carries, read from the start of a Decision's tried; null when there is none. */
export function autoRecoverySummary(tried: string, language: OwnerLanguage): string | null {
  const t = AUTO_RECOVERY_TEXT[language];
  const first = firstLine(tried).trim();
  if (first.startsWith(t.notTriedHeading)) return first;
  const counted = new RegExp(`^${t.triedHeading}: (\\d+)`, "u").exec(first);
  return counted ? t.summary(Number(counted[1])) : null;
}

/** One partial report as samePartialReport compares it; interrupted: a Reviewer rejection (or another result) came after it. */
export interface PartialReportSample {
  readonly report: unknown;
  readonly verification?: unknown;
  readonly interrupted?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** criterion_id → status of the criteria that did not pass; null when the sample cannot be compared. */
export function openCriteriaStatuses(sample: PartialReportSample): { open: Map<string, string>; verification: string } | null {
  if (!sample || sample.interrupted === true) return null;
  const report = asRecord(sample.report);
  if (!report || report.result !== "partial") return null;
  if (report.pending_process != null || report.external_blocker != null || report.needs_replanning === true) return null;
  const verification = asRecord(report.verification) ?? asRecord(sample.verification);
  if (!verification || typeof verification.status !== "string" || !Array.isArray(verification.acceptance)) return null;
  const open = new Map<string, string>();
  for (const entry of verification.acceptance) {
    const item = asRecord(entry);
    if (!item || typeof item.criterion_id !== "string" || typeof item.status !== "string") return null;
    if (item.status === "unverifiable") return null;
    if (item.status !== "passed") open.set(item.criterion_id, item.status);
  }
  // A partial that leaves nothing open has nothing for Core to check or the Manager to judge.
  if (open.size === 0) return null;
  return { open, verification: verification.status };
}

/**
 * true only for two consecutive plain partial reports that leave the same criteria open with the same
 * statuses and the same verification.status. A report with unverifiable, external_blocker, pending_process
 * or needs_replanning, or one a Reviewer rejection came after, is never compared.
 */
export function samePartialReport(a: PartialReportSample, b: PartialReportSample): boolean {
  const left = openCriteriaStatuses(a);
  const right = openCriteriaStatuses(b);
  if (!left || !right || left.verification !== right.verification || left.open.size !== right.open.size) return false;
  for (const [id, status] of left.open) if (right.open.get(id) !== status) return false;
  return true;
}

export interface ActiveAutoRecovery extends JsonObject {
  kind: AutoRecoveryKind;
  target_kind: "work" | "task";
  target_id: string;
  task_title: string | null;
  attempt_no: number;
  limit: number;
  counted: boolean;
  resume_at: string | null;
  started_at: string;
}

/**
 * Recoveries the Work screen shows as in progress: the newest recovery.started of each kind and target that no
 * success (work.completed, or a completed Task in the target's lineage) and no Decision has followed. A wait that is
 * not counted (429) drops out once its resume_at has passed.
 */
export function activeAutoRecoveries(reader: LineageReader, workId: string, now: number = Date.now()): ActiveAutoRecovery[] {
  const rows = reader.all<{ payload_json: string; created_at: string; sequence: number }>(
    `SELECT payload_json, created_at, sequence FROM events WHERE type = '${AUTO_RECOVERY_EVENT}' AND work_id = ? ORDER BY sequence ASC`,
    workId,
  );
  const newest = new Map<string, { p: Record<string, unknown>; created_at: string; sequence: number }>();
  for (const row of rows) {
    const p = JSON.parse(row.payload_json) as Record<string, unknown>;
    newest.set(`${String(p.kind)}:${String(p.target_kind)}:${String(p.target_id)}`, { p, created_at: row.created_at, sequence: row.sequence });
  }
  const active: ActiveAutoRecovery[] = [];
  for (const { p, created_at, sequence } of newest.values()) {
    const targetKind = p.target_kind === "task" ? "task" : "work";
    const targetId = String(p.target_id);
    const resumeAt = typeof p.resume_at === "string" ? p.resume_at : null;
    const counted = p.counted === true;
    if (!counted && resumeAt !== null && Date.parse(resumeAt) <= now) continue;
    const lineage = targetKind === "task"
      ? reader.all<{ id: string; status: string; updated_at: string }>("SELECT id, status, updated_at FROM tasks WHERE work_id = ? AND (id = ? OR lineage_root_task_id = ?)", workId, targetId, targetId)
      : [];
    const lineageIds = new Set(lineage.map((t) => t.id));
    // Core never writes a task.completed event, so a Task success is a completed Task row updated after the start.
    if (lineage.some((t) => t.status === "completed" && Date.parse(t.updated_at) >= Date.parse(created_at))) continue;
    const completed = reader.get<{ id: number }>("SELECT sequence AS id FROM events WHERE work_id = ? AND sequence > ? AND type = 'work.completed' LIMIT 1", workId, sequence);
    // Read the Decision row, not its decision.opened event: Core's own Decisions get that event only after the explanation is ready.
    const decisions = reader.all<{ scope: string; blocked_task_ids_json: string }>(
      "SELECT scope, blocked_task_ids_json FROM decisions WHERE work_id = ? AND created_at >= ?", workId, created_at);
    const finished = completed !== undefined || decisions.some((decision) => {
      if (targetKind === "work" || decision.scope === "work") return true;
      const blocked = JSON.parse(decision.blocked_task_ids_json) as unknown;
      return Array.isArray(blocked) && blocked.some((id) => lineageIds.has(String(id)));
    });
    if (finished) continue;
    active.push({
      kind: p.kind as AutoRecoveryKind,
      target_kind: targetKind,
      target_id: targetId,
      task_title: targetKind === "task" ? reader.get<{ title: string }>("SELECT title FROM tasks WHERE id = ?", targetId)?.title ?? null : null,
      attempt_no: Number(p.attempt_no),
      limit: Number(p.limit),
      counted,
      resume_at: resumeAt,
      started_at: created_at,
    });
  }
  return active;
}

/** Every criteria.relaxed record of the Work, oldest first, with the Task title. */
export function criteriaRelaxationsOfWork(reader: LineageReader, workId: string): JsonObject[] {
  return reader
    .all<{ payload_json: string; created_at: string }>(
      "SELECT payload_json, created_at FROM events WHERE type = 'criteria.relaxed' AND work_id = ? ORDER BY sequence ASC",
      workId,
    )
    .map((row) => {
      const p = JSON.parse(row.payload_json) as Record<string, unknown>;
      const taskId = String(p.task_id);
      const detail = (value: unknown): JsonObject => {
        const d = (value ?? {}) as Record<string, unknown>;
        return { text: String(d.text ?? ""), check: String(d.check ?? "") };
      };
      return {
        task_id: taskId,
        task_title: reader.get<{ title: string }>("SELECT title FROM tasks WHERE id = ?", taskId)?.title ?? null,
        criterion_id: String(p.criterion_id),
        original: detail(p.original),
        relaxed: detail(p.relaxed),
        reason: String(p.reason ?? ""),
        keeps: String(p.keeps ?? ""),
        at: row.created_at,
      };
    });
}

/** Counted recoveries per kind over the whole Work, for the completion report. */
export function autoRecoveryCountsOfWork(reader: LineageReader, workId: string): JsonObject {
  const counts: JsonObject = {};
  for (const row of reader.all<{ kind: string; used: number }>(
    `SELECT json_extract(payload_json, '$.kind') AS kind, COUNT(*) AS used FROM events
      WHERE type = '${AUTO_RECOVERY_EVENT}' AND work_id = ? AND json_extract(payload_json, '$.counted') = 1 GROUP BY kind`,
    workId,
  )) counts[row.kind] = row.used;
  return counts;
}
