/**
 * Helpers, constants and row types that Core, ManagerOrchestrator and AdvisorActions share.
 * They live here so the two classes need not import core.ts (which imports them).
 */
import type { AgentRunResult, CoreWriteLaneTransaction, JsonObject, TaskRow, WorkDetail } from "./types";
import { planContextFields } from "./context-builder.js";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createUlid, utcNow } from "@owl/db";
import { type FinalManagerVerdict } from "./final-verdict";
import { type OwnerLanguage } from "./owner-language";
import { HumanReadableError, validationError } from "./errors";
import { readTaskGoalShortfalls, type FinalCriterionRef, type SettledFinalVerdict } from "./goal-shortfalls";
import { stableJson, type AdvisorActionFailure } from "./advisor-followup.js";
import { processIdentityMatches, readProcessIdentity } from "./process-identity.js";
import { formatRuntimeFailure } from "./error-display.js";
import { type FileDestinationChannel, type FileDestinationRefusal, type FileDestinationResult, type FileDestinationSource } from "./advisor-file-destination.js";
import { type AdvisorWorkOperationType } from "@owl/shared/advisor-response";
import { readStoredAcceptanceCriteria } from "@owl/shared";
import { isRecord, firstLine } from "@owl/shared/small-helpers";
export { isRecord, firstLine };

export function advisorWorkKeyForType(type: AdvisorWorkOperationType): string {
  switch (type) {
    case "send_work_instruction": return "instruction";
    case "update_work": return "update";
    case "pause_work": return "pause";
    case "resume_work": return "resume";
    case "cancel_work": return "cancel";
    case "delete_work": return "delete";
    case "move_work_to_project": return "project";
  }
}

export function advisorWorkTypeForKey(key: string): AdvisorWorkOperationType | null {
  switch (key) {
    case "instruction": return "send_work_instruction";
    case "update": return "update_work";
    case "pause": return "pause_work";
    case "resume": return "resume_work";
    case "cancel": return "cancel_work";
    case "delete": return "delete_work";
    case "project": return "move_work_to_project";
    default: return null;
  }
}

export interface WorkDbRow {
  id: string;
  display_number: number | null;
  title: string;
  state: WorkDetail["state"];
  state_version: number;
  updated_at: string;
  archived_at: string | null;
  owner_id: string;
  project_id: string | null;
  summary: string;
  size: WorkDetail["size"];
  design_mode: "auto" | "lead";
  plan_revision: number;
}

export const AGENT_STOP_WAIT_MS = 10_000;
/** The tick resends a forced stop after this many agentStopWaitMs, and opens a Decision after twice that. */
export const OWNER_STOP_CONFIRM_FACTOR = 3;
export type StoppableRun = { id: string; role: string; pid: number | null; process_start_time: string | null; process_cmdline_sha256: string | null };

/** Thrown inside the Manager start write when the Owner paused the Work first. */
export const MANAGER_PAUSED_AT_START = new Error("The Work was paused before the Manager run was recorded.");

/** What a Web reply with send_file shows: where the files go and how each one fared. */
export interface AdvisorFileDeliveryMetadata {
  readonly kind: "advisor_file_delivery";
  readonly destination: (FileDestinationChannel & { readonly source: FileDestinationSource }) | null;
  readonly refusal: FileDestinationRefusal | null;
  readonly files: readonly {
    readonly index: number;
    readonly name: string;
    readonly size: number | null;
    readonly status: "pending" | "sent" | "failed" | "unknown" | "rejected";
    readonly code?: string;
    readonly message?: string;
  }[];
  readonly notice?: string;
}

export type AdvisorFileDeliveryPlan = Pick<AdvisorFileDeliveryMetadata, "destination" | "refusal" | "files">;

export type WebFileDestination = { result: FileDestinationResult; platform: string; channel: string };

/** Write the Manager's reply to Owner instruction messages; call inside the transaction that settles the replan marker. */
export function insertInstructionReply(
  transaction: CoreWriteLaneTransaction,
  messageIds: readonly string[],
  outcome: InstructionOutcome,
  planRevision: number | null,
  body: string,
): void {
  if (messageIds.length === 0) return;
  const origin = transaction.get<{ conversation_id: string; account_id: string }>(
    "SELECT conversation_id, account_id FROM messages WHERE id = ?",
    messageIds[0],
  );
  if (!origin) return;
  const now = utcNow();
  const metadata: InstructionReplyMetadata = { kind: "instruction_reply", in_reply_to: messageIds, outcome, plan_revision: planRevision };
  transaction.run(
    `INSERT INTO messages
       (id, conversation_id, provider, account_id, source_message_id, body,
        attachment_ids_json, received_at, created_at, metadata_json)
     VALUES (?, ?, 'web', ?, ?, ?, '[]', ?, ?, ?)`,
    createUlid(), origin.conversation_id, origin.account_id, `manager:${createUlid()}`, body, now, now, JSON.stringify(metadata),
  );
}

export function parseMessageMetadata(json: string | null | undefined): MessageMetadata | null {
  if (json == null) return null;
  try {
    const value = JSON.parse(json) as unknown;
    if (isRecord(value) && value.kind === "instruction_reply" && Array.isArray(value.in_reply_to)) return value as unknown as MessageMetadata;
    if (isRecord(value) && value.kind === "advisor_file_delivery" && Array.isArray(value.files)) return value as unknown as MessageMetadata;
  } catch {
    // The CHECK constraint rejects invalid JSON; anything else is treated as no metadata.
  }
  return null;
}

/** Rolls back a tick-failure alert whose Work left `running` before the write. */
export class WorkNotRunningAbort extends Error {
  public state: string | undefined;
  public constructor() {
    super("The Work is no longer running.");
    this.name = "WorkNotRunningAbort";
  }
}

/**
 * True only when the recorded process is confirmed gone: the PID no longer
 * exists, or it now runs a different process (PID reuse). A live PID whose
 * identity cannot be read or was never recorded stays "not gone".
 */
export function isRecordedProcessGone(
  run: { process_start_time: string | null; process_cmdline_sha256: string | null },
  pid: number,
): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  const observed = readProcessIdentity(pid);
  if (
    observed.process_start_time === null || observed.process_cmdline_sha256 === null
    || run.process_start_time === null || run.process_cmdline_sha256 === null
  ) return false;
  return !processIdentityMatches(run, observed);
}

export function parseStringArray(text: string, field: string, id: string, resource = "Decision"): string[] {
  const parsed = parseArray(text, field, id, resource);
  if (!parsed.every((value): value is string => typeof value === "string")) {
    throw validationError(`Stored ${resource} field ${field} contains a non-string value.`, { id, field }, { code: "stored.field_not_string_array", values: { resource, field } });
  }
  return parsed;
}

export function parseStoredJsonObject(text: string, field: string, id: string): JsonObject {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw validationError(`Stored ${field} ${id} is not an object.`, { field, id }, { code: "stored.not_object", values: { field, id } });
  }
  return parsed as JsonObject;
}

export function addManagerRules(request: unknown, rulesText: string | null, skillsText: string | null, knowledgeText: string | null): unknown {
  if (!isRecord(request)) return request;
  const enriched: JsonObject = { ...request };
  enriched.context = {
    ...(isRecord(request.context) ? request.context : {}),
    rules: rulesText,
    skills: skillsText,
    knowledge: knowledgeText,
  };
  return enriched;
}

export function extractManagerWorkRules(value: unknown): string[] | null {
  if (!isRecord(value)) return null;
  const candidates: unknown[] = [value.work_rules];
  if (isRecord(value.report)) candidates.push(value.report.work_rules);
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const rules = candidate.filter((rule): rule is string => typeof rule === "string");
    if (rules.length === candidate.length) return rules;
  }
  return null;
}

export function extractManagerRequestIds(request: unknown, operation: string): { workId: string; taskId: string | null } {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw validationError(`The ${operation} request is not a valid object.`, { operation }, { code: "request.not_object", values: { field: "request", operation } });
  }
  const record = request as Record<string, unknown>;
  const workId = record.work_id;
  if (typeof workId !== "string" || workId.length === 0) {
    throw validationError(`The ${operation} request is missing work_id.`, { operation }, { code: "request.work_id_missing", values: { field: "work_id", operation } });
  }
  const taskIdRaw = record.task_id;
  if (taskIdRaw !== null && typeof taskIdRaw !== "undefined" && typeof taskIdRaw !== "string") {
    throw validationError(`The ${operation} request has an invalid task_id.`, { operation }, { code: "request.task_id_invalid", values: { field: "task_id", operation } });
  }
  const taskId = typeof taskIdRaw === "string" ? taskIdRaw : null;
  return { workId, taskId };
}

export function humanizeUnexpected(error: unknown, operation: string): HumanReadableError {
  if (isCodedError(error)) {
    return error as HumanReadableError;
  }
  // Raw exception text belongs in the runtime log; the public surface remains actionable.
  console.error(`[owl-core] ${operation} failed`, error);
  return new HumanReadableError({
    code: "core_write_failed",
    message: formatRuntimeFailure(error, operation),
    remediation: "Inspect the Core log, correct the reported cause, and retry the command.",
    details: { operation },
  });
}

/** What one action returned: the Owner-facing notice, plus a failure record when it did not run. */
export interface AdvisorActionOutcome {
  readonly notice: string;
  readonly failure?: AdvisorActionFailure;
}

export function callApiHash(method: string, path: string, body: unknown): string {
  return createHash("sha256").update(stableJson({ method, path, body: body ?? null }), "utf8").digest("hex").slice(0, 16);
}

export function isRateLimitedAgentRunResult(value: unknown): value is AgentRunResult {
  return isRecord(value) && value.failure_class === "rate_limited";
}

/** Initial Manager plan: 1 attempt plus 2 retries for transient/retryable failures. */
export const INITIAL_PLAN_MAX_ATTEMPTS = 3;
export const INITIAL_PLAN_RETRY_DELAY_MS = 5_000;
/** Default size cap (JSON characters) of the report digests alone, not of the whole final check input; dispatcher.final_reports_max_chars overrides it. */
export const FINAL_REPORTS_MAX_CHARS = 120_000;
/** Final Manager check: 1 attempt plus 1 retry for transient/retryable failures. */
export const FINAL_MANAGER_MAX_ATTEMPTS = 2;

/** Runtime error codes for an agent answer that broke its role contract (agent-runtime errors.ts). */
const AGENT_CONTRACT_ERROR_CODES = new Set(["report_invalid", "manager_plan_invalid", "review_invalid"]);

export const SIDE_EFFECT_FAILURE_PREFIX = "side_effect_failure:";

/** Marks a failure record that followed an external side effect: it keeps that class and is never retried. */
export function sideEffectFailureFields(errorKey: unknown): JsonObject {
  return typeof errorKey === "string" && errorKey.startsWith(SIDE_EFFECT_FAILURE_PREFIX)
    ? { outcome: "failed_after_side_effect", retry_allowed: false }
    : {};
}

/**
 * Turn an error thrown by a Final Manager attempt into a failed result.
 * A malformed answer is retried like on the Core-shaped runner path; a
 * provider failure arrives here without agent-runtime's classification, so
 * it is treated as transient (one bounded retry). Anything else (setup,
 * Core validation) is deterministic.
 */
export interface FinalManagerOutcome {
  readonly verdict: FinalManagerVerdict;
  readonly settled: SettledFinalVerdict;
  readonly criteria_index: readonly FinalCriterionRef[];
  readonly agent_run_id: string;
}

export function finalManagerErrorResult(error: unknown, language: OwnerLanguage): AgentRunResult {
  const code = isCodedError(error) ? error.code : null;
  const reason = isRecord(error) && typeof error.reason === "string" ? error.reason : null;
  const contract = code !== null && AGENT_CONTRACT_ERROR_CODES.has(code);
  // agent-runtime marks an error thrown after an external side effect; it must never be retried.
  const afterSideEffect = isRecord(error) && error.outcome === "failed_after_side_effect";
  const transient = code === "provider_failed" && !afterSideEffect;
  const baseKey = code === null ? "final_manager_error" : reason === null ? code : `${code}:${reason}`;
  return {
    outcome: "failed",
    report_valid: false,
    skill_feedback: null,
    failure_class: transient ? "transient" : "deterministic",
    error_key: afterSideEffect ? `${SIDE_EFFECT_FAILURE_PREFIX}${baseKey}` : baseKey,
    // A blank reason on a goal is the Manager's slip: the final check runs again.
    retry_allowed: (contract || (isRecord(error) && isRecord(error.details) && error.details.final_check_retry === true)) && !afterSideEffect,
    message: formatRuntimeFailure(error, "Manager", language),
  };
}

/**
 * The Task fields a Manager reads: identity, plan fields, status and the
 * counters it can reason about. Internals (error hashes, worktree paths,
 * leases, versions) stay in Core.
 */
/** The required_sections / required_tests stored for the Task, so a replan can keep or change them. */
export function storedVerificationSpec(task: TaskRow): JsonObject {
  try {
    const parsed: unknown = task.verification_spec_json ? JSON.parse(task.verification_spec_json) : {};
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
  } catch (error) {
    // A corrupt spec drops required_sections / required_tests on replan, so make that visible.
    console.warn(`[owl-core] Task ${task.id} has an unreadable verification_spec_json; replanning without its stored verification conditions`, error);
    return {};
  }
}

export function managerTaskView(task: TaskRow, dependsOn: readonly string[]): JsonObject {
  return {
    id: task.id,
    manager_task_id: task.manager_task_id,
    title: task.title,
    type: task.type,
    status: task.status,
    acceptance_criteria: readStoredAcceptanceCriteria(task.acceptance_criteria_json, task.acceptance) as unknown as JsonObject[],
    goal_shortfalls: readTaskGoalShortfalls(task.goal_shortfalls_json as string | null | undefined) as unknown as JsonObject[],
    ...planContextFields(task),
    ...storedVerificationSpec(task),
    depends_on: [...dependsOn],
    review_round: task.review_round,
    failure_count: task.failure_count,
  };
}

export function mergeConflictFiles(alert: JsonObject | null): string[] {
  return Array.isArray(alert?.conflicting_files)
    ? alert.conflicting_files.filter((path): path is string => typeof path === "string" && path.length > 0)
    : [];
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

export type InstructionOutcome = "tasks_changed" | "no_change" | "decision_opened";

export interface InstructionReplyMetadata {
  readonly kind: "instruction_reply";
  readonly in_reply_to: readonly string[];
  readonly outcome: InstructionOutcome;
  readonly plan_revision: number | null;
}

export type MessageMetadata = InstructionReplyMetadata | AdvisorFileDeliveryMetadata;

export function parseArray(text: string, field: string, id: string, resource = "Decision"): unknown[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw validationError(`Stored ${resource} field ${field} is not an array.`, { id, field }, { code: "stored.field_not_array", values: { resource, field } });
  }
  return parsed;
}

export function isCodedError(value: unknown): value is { readonly code: string } {
  return isRecord(value) && typeof value.code === "string";
}

export interface CommandMutation<D extends JsonObject> {
  readonly data: D;
  readonly version: number;
}

export function realPathOrResolve(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}
