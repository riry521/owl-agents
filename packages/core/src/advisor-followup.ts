import { createHash } from "node:crypto";

import { ADVISOR_FOLLOWUP_TURN_TEXT, externalJsonBlock, redactProviderOutput } from "@owl/shared";
import {
  ADVISOR_CALL_API_ACTION_TYPE,
  ADVISOR_SEND_FILE_ACTION_TYPE,
  advisorCurationKind,
  isAdvisorWorkOperationType,
  parseAdvisorCallApiRequestShape,
} from "../../shared/dist/advisor-response.js";

import { advisorWorkId, parseAdvisorWorkOperationPayload } from "./advisor-work-payload.js";
import type { CoreDatabase } from "./types.js";

export type AdvisorActionFailureStatus = "failed" | "unknown" | "held";

export interface AdvisorActionFailure {
  /** Position in the turn's action list; -1 when the owl-actions block itself was broken. */
  readonly index: number;
  /** One of the 14 action types, or "owl-actions" when the block could not be read. */
  readonly type: string;
  readonly status: AdvisorActionFailureStatus;
  readonly code: string;
  /** The notice shown to the Owner: secrets masked, at most 300 characters. */
  readonly message: string;
  /** Whether the follow-up may re-emit it once. Always false for unknown and held. */
  readonly retryable: boolean;
  /** Whether the original action needed the Owner's approval. */
  readonly approval: boolean;
  /** Matching key (advisorActionTarget); null when it cannot be decided. */
  readonly target: string | null;
  /** Only for kinds that may need approval; null when the compared fields cannot be read. */
  readonly fingerprint?: string | null;
  /** Strings, numbers, booleans and null only. Never a call_api body. */
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AdvisorActionLike {
  readonly type: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** Same implementation for the call_api request_hash and the fingerprint, so key order never matters. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value: unknown): string => createHash("sha256").update(stableJson(value), "utf8").digest("hex");

// Codes a result may carry that mean "the action may or may not have run" whatever the kind.
const UNKNOWN_CODES: ReadonlySet<string> = new Set(["result_unknown", "upload_unknown"]);

const WORK_OPERATION_STATE_CODES = ["invalid_state_transition"];

// Per type: coded errors that retrying cannot fix. A coded error not listed is retryable (Owl refused it before writing).
const NOT_RETRYABLE_CODES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  create_work: new Set(["window_project_mismatch", "start_failed"]),
  send_work_instruction: new Set(["work_cancelled", ...WORK_OPERATION_STATE_CODES]),
  update_work: new Set(WORK_OPERATION_STATE_CODES),
  pause_work: new Set(WORK_OPERATION_STATE_CODES),
  resume_work: new Set(WORK_OPERATION_STATE_CODES),
  cancel_work: new Set(WORK_OPERATION_STATE_CODES),
  delete_work: new Set(WORK_OPERATION_STATE_CODES),
  move_work_to_project: new Set(["window_project_mismatch", "work_project_already_set", "work_has_active_agents", ...WORK_OPERATION_STATE_CODES]),
  call_api: new Set(["blocked", "unavailable"]),
  send_file: new Set(["symlink_escape", "secret", "too_large", "unreadable", "no_folder", "unsupported_channel", "upload_rejected"]),
  handoff_to_window: new Set(["no_project", "same_window"]),
});

const WORK_OPERATION_TYPES: ReadonlySet<string> = new Set([
  "send_work_instruction", "update_work", "pause_work", "resume_work", "cancel_work", "delete_work", "move_work_to_project",
]);

/** Kinds that need the Owner's approval before they are emitted (send_work_instruction only with reopen). */
export function advisorActionNeedsApproval(action: AdvisorActionLike): boolean {
  if (action.type === "send_work_instruction") return action.payload?.reopen === true;
  return action.type === "cancel_work" || action.type === "delete_work" || action.type === "update_work"
    || action.type === "move_work_to_project" || action.type === ADVISOR_CALL_API_ACTION_TYPE;
}

/**
 * Decides status and retryable for one failure. `code` is null for an exception without an Owl code.
 * `approval` is the caller's advisorActionNeedsApproval of the original action.
 */
export function judgeAdvisorFailure(
  type: string,
  code: string | null,
  approval = false,
): { status: "failed" | "unknown"; code: string; retryable: boolean; approval: boolean } {
  if (code === null || UNKNOWN_CODES.has(code)) {
    return { status: "unknown", code: code ?? "result_unknown", retryable: false, approval };
  }
  const notRetryable = Object.hasOwn(NOT_RETRYABLE_CODES, type) && NOT_RETRYABLE_CODES[type]!.has(code);
  return { status: "failed", code, retryable: !notRetryable, approval };
}

/** Matching keys of an action (7.2). send_file gives the written path and, once checked, the real path. */
export function advisorActionTarget(action: AdvisorActionLike, prepared?: { readonly path: string }): string[] {
  const payload = action.payload;
  if (action.type === "create_work") {
    const title = payload?.title;
    return typeof title === "string" && title.trim() !== "" ? [title.trim()] : [];
  }
  if (WORK_OPERATION_TYPES.has(action.type)) {
    const workId = advisorWorkId(payload);
    return workId === null ? [] : [workId];
  }
  if (action.type === ADVISOR_CALL_API_ACTION_TYPE) {
    const shape = parseAdvisorCallApiRequestShape(payload);
    return shape.ok ? [`${shape.value.method} ${shape.value.path}`] : [];
  }
  if (action.type === ADVISOR_SEND_FILE_ACTION_TYPE) {
    const path = payload?.path;
    const keys = typeof path === "string" ? [path] : [];
    if (prepared && !keys.includes(prepared.path)) keys.push(prepared.path);
    return keys;
  }
  if (action.type === "handoff_to_window") {
    const projectId = payload?.project_id;
    if (projectId === null) return ["general"];
    return typeof projectId === "string" && projectId.trim() !== "" ? [projectId.trim()] : [];
  }
  return advisorCurationKind(action.type) !== null ? [action.type] : [];
}

// send_work_instruction has a fingerprint with or without reopen, so adding or dropping reopen is a change.
const FINGERPRINTED_WORK_TYPES: ReadonlySet<string> = new Set([
  "cancel_work", "delete_work", "update_work", "move_work_to_project", "send_work_instruction",
]);

/**
 * What the Owner approved, as a sha256: undefined for kinds that need no approval, null when the compared
 * fields cannot be read the way execution reads them.
 */
export function advisorActionFingerprint(action: AdvisorActionLike): string | null | undefined {
  if (action.type === ADVISOR_CALL_API_ACTION_TYPE) {
    const shape = parseAdvisorCallApiRequestShape(action.payload);
    if (!shape.ok) return null;
    const { method, path, body } = shape.value;
    let compared: Record<string, unknown> | null = null;
    if (body !== undefined) {
      // Core replaces these before sending, so the Advisor's values never reach the API.
      const { expected_version: _version, ...rest } = body;
      if (Object.hasOwn(rest, "payload")) {
        const { request_id: _requestId, idempotency_key: _key, ...withoutIds } = rest;
        compared = withoutIds;
      } else {
        compared = rest;
      }
    }
    return sha256({ method, path, body: compared });
  }
  if (!FINGERPRINTED_WORK_TYPES.has(action.type) || !isAdvisorWorkOperationType(action.type)) return undefined;
  const parsed = parseAdvisorWorkOperationPayload(action.type, action.payload);
  if (!parsed.ok) return null;
  const v = parsed.value;
  switch (action.type) {
    case "cancel_work": return sha256({ work_id: v.workId, reason: v.cancelReason });
    case "delete_work": return sha256({ work_id: v.workId });
    case "update_work": return sha256({ work_id: v.workId, ...(v.title === undefined ? {} : { title: v.title }), ...(v.summary === undefined ? {} : { summary: v.summary }) });
    case "move_work_to_project": return sha256({ work_id: v.workId, project_id: v.projectId });
    default: return sha256({ work_id: v.workId, body: v.body, reopen: v.reopen });
  }
}

export type AdvisorFailureDetails = Record<string, string | number | boolean | null | undefined>;

/**
 * Builds the failure record of one action. `code` is the Owl or Core code, null for an exception without one;
 * `forceUnknown` marks a result that may have run although the server answered (a call_api 5xx).
 * With no `action`, only the type is known (a call_api recovered from its started record): its fingerprint stays null.
 */
export function buildAdvisorActionFailure(input: {
  readonly index: number;
  readonly type: string;
  readonly action?: AdvisorActionLike;
  readonly code: string | null;
  readonly message: string;
  readonly details?: AdvisorFailureDetails;
  readonly forceUnknown?: boolean;
  readonly preparedPath?: string;
  readonly targetPayload?: Readonly<Record<string, unknown>>;
}): AdvisorActionFailure {
  const action: AdvisorActionLike = input.action ?? { type: input.type, payload: input.targetPayload };
  const approval = advisorActionNeedsApproval(action);
  const judged = judgeAdvisorFailure(input.type, input.forceUnknown ? null : input.code, approval);
  const fingerprint = input.action ? advisorActionFingerprint(action) : approval ? null : undefined;
  const details: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input.details ?? {})) if (value !== undefined) details[key] = typeof value === "string" ? redactProviderOutput(value) : value;
  return {
    index: input.index,
    type: input.type,
    status: judged.status,
    code: judged.code,
    message: redactProviderOutput(input.message).slice(0, 300),
    retryable: judged.retryable,
    approval,
    target: advisorActionTarget(action, input.preparedPath === undefined ? undefined : { path: input.preparedPath })[0] ?? null,
    ...(fingerprint === undefined ? {} : { fingerprint }),
    details,
  };
}

export interface FollowupCandidate {
  readonly type: string;
  readonly targets: readonly string[];
  readonly approval: boolean;
  readonly fingerprint?: string | null;
}

export type FollowupHoldReason =
  | "followupHeldChanged" | "followupHeldUnknown" | "followupHeldOther" | "followupHeldRecorded";

export type FollowupDecision =
  | { readonly action: "execute"; readonly sourceIndex: number }
  | { readonly action: "hold"; readonly reason: FollowupHoldReason };

// Codes that say the id or path itself was wrong, so fixing it legitimately changes the target.
const TARGET_FIXABLE_CODES: ReadonlySet<string> = new Set(["invalid_payload", "work_not_found", "not_found", "outside", "not_a_file"]);

/** The reconciliation table of 7.2: which follow-up actions retry which original failure. One decision per candidate, in order. */
export function planFollowupActions(
  sourceFailures: readonly AdvisorActionFailure[],
  candidates: readonly FollowupCandidate[],
  recorded: ReadonlySet<number> = new Set(),
): FollowupDecision[] {
  const used = new Set(recorded);
  const executed = new Set<string>();
  const hold = (reason: FollowupHoldReason): FollowupDecision => ({ action: "hold", reason });
  return candidates.map((candidate): FollowupDecision => {
    const first = candidate.targets[0];
    const execute = (sourceIndex: number): FollowupDecision => {
      if (first !== undefined) executed.add(JSON.stringify([candidate.type, first]));
      return { action: "execute", sourceIndex };
    };
    const sameTarget = sourceFailures.filter((f) => f.type === candidate.type && f.target !== null && candidate.targets.includes(f.target));
    if (sameTarget.some((f) => f.status === "unknown")) return hold("followupHeldUnknown");
    if (first !== undefined && executed.has(JSON.stringify([candidate.type, first]))) return hold("followupHeldOther");
    if (sameTarget.some((f) => recorded.has(f.index))) return hold("followupHeldRecorded");
    if (sameTarget.length > 0) {
      const picked = sameTarget.find((f) => !used.has(f.index));
      if (!picked) return hold("followupHeldOther");
      used.add(picked.index);
      if (candidate.approval || picked.approval) {
        const same = candidate.fingerprint != null && picked.fingerprint != null && candidate.fingerprint === picked.fingerprint;
        if (!same) return hold("followupHeldChanged");
      }
      return picked.retryable ? execute(picked.index) : hold("followupHeldOther");
    }
    if (candidate.approval) {
      return hold(sourceFailures.some((f) => f.type === candidate.type) ? "followupHeldChanged" : "followupHeldOther");
    }
    const fixable = sourceFailures.find((f) => f.type === candidate.type && !used.has(f.index) && f.retryable && TARGET_FIXABLE_CODES.has(f.code));
    if (fixable) {
      used.add(fixable.index);
      return execute(fixable.index);
    }
    const broken = sourceFailures.find((f) => f.type === "owl-actions");
    if (broken) return execute(broken.index);
    return hold("followupHeldOther");
  });
}

/** The follow-up turn's input: the source reply's notices, the failures as external data, then the instruction. */
export function buildFollowupTurnText(actionResults: string, failures: readonly AdvisorActionFailure[]): string {
  return [
    `<owl-action-results>\n${actionResults}\n</owl-action-results>`,
    externalJsonBlock("owl-action-failures", failures),
    ADVISOR_FOLLOWUP_TURN_TEXT,
  ].join("\n\n");
}

/** The turn right after `sourceTurnId` in the same conversation; null when there is none or the source has no turn row. */
export function nextTurnOf(db: CoreDatabase, sourceTurnId: string): { status: string; retry_count: number } | null {
  const source = db.get<{ conversation_id: string; queued_at: string; rowid: number }>(
    "SELECT conversation_id, queued_at, rowid FROM advisor_turns WHERE id = ?",
    sourceTurnId,
  );
  if (!source) return null;
  return db.get<{ status: string; retry_count: number }>(
    `SELECT status, retry_count FROM advisor_turns
      WHERE conversation_id = ? AND (queued_at, rowid) > (?, ?)
      ORDER BY queued_at, rowid LIMIT 1`,
    source.conversation_id,
    source.queued_at,
    source.rowid,
  ) ?? null;
}

/**
 * Whether the turn after `sourceTurnId` in the same conversation has not built its input yet, so it will carry the
 * source's failures itself. A spontaneous reply has no turn row and is never received by a later turn (false).
 */
export function nextTurnReceives(db: CoreDatabase, sourceTurnId: string, maxTurnRetries: number): boolean {
  const next = nextTurnOf(db, sourceTurnId);
  if (!next) return false;
  return next.status === "queued" || (next.status === "interrupted" && next.retry_count < maxTurnRetries);
}

export interface ShouldInsertFollowupInput {
  /** The failures to hand over (the reply's, plus the delivery's at report time). */
  readonly failures: readonly AdvisorActionFailure[];
  readonly sourceIsFollowup: boolean;
  readonly followupExists: boolean;
  readonly nextTurnReceives: boolean;
  readonly sessionFound: boolean;
}

/** The "do not insert" table of 6.2, used at reply time and at delivery-report time. */
export function shouldInsertFollowup(input: ShouldInsertFollowupInput): boolean {
  return input.failures.some((f) => f.status === "failed" || f.status === "unknown")
    && !input.sourceIsFollowup
    && !input.followupExists
    && !input.nextTurnReceives
    && input.sessionFound;
}

const latestPayload = (db: CoreDatabase, type: string, turnId: string): Record<string, unknown> | null => {
  const row = db.get<{ payload_json: string }>(
    `SELECT payload_json FROM events
      WHERE type = ? AND json_extract(payload_json, '$.turn_id') = ?
        AND COALESCE(json_extract(payload_json, '$.kind'), '') <> 'advisor_error'
      ORDER BY rowid DESC LIMIT 1`,
    type,
    turnId,
  );
  return row ? (JSON.parse(row.payload_json) as Record<string, unknown>) : null;
};

const failuresOf = (payload: Record<string, unknown> | null): AdvisorActionFailure[] =>
  payload && Array.isArray(payload.action_failures) ? (payload.action_failures as AdvisorActionFailure[]) : [];

/** A turn's failures: its reply's, then the connector's delivery report's (delivery only when the next turn already took the reply's). */
export function loadSourceFailures(db: CoreDatabase, turnId: string): AdvisorActionFailure[] {
  const delivery = latestPayload(db, "advisor.delivery_reported", turnId);
  const core = delivery?.followup_scope === "delivery" ? [] : failuresOf(latestPayload(db, "advisor.responded", turnId));
  return [...core, ...failuresOf(delivery)];
}

/** The notices a turn's reply handed over, plus one line per failed file delivery the connector reported (6.3). */
export function loadSourceActionResults(db: CoreDatabase, turnId: string): string {
  const reply = latestPayload(db, "advisor.responded", turnId);
  const notices = typeof reply?.action_results === "string" ? reply.action_results : "";
  const delivery = failuresOf(latestPayload(db, "advisor.delivery_reported", turnId)).map((f) => f.message);
  return [notices, ...delivery].filter((part) => part !== "").join("\n");
}

/** Source indexes whose retry already started (7.5), read from advisor.followup_retry_started. */
export function loadFollowupRetries(db: CoreDatabase, sourceTurnId: string): Set<number> {
  const rows = db.all<{ source_index: number }>(
    `SELECT json_extract(payload_json, '$.source_index') AS source_index FROM events
      WHERE type = 'advisor.followup_retry_started' AND json_extract(payload_json, '$.source_turn_id') = ?`,
    sourceTurnId,
  );
  return new Set(rows.map((row) => row.source_index));
}
