import { cliTokenUsage, UNVERIFIABLE_STATUS } from "@owl/shared";
import { providerFailed, reportInvalid } from "./errors";
import { claudeRateLimitEvidence, codexRateLimitEvidence, type RateLimitResetInput } from "./rate-limit";
import {
  LEGACY_REPORT_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  type LegacyReportEnvelope,
  type LegacyReportVerification,
  type RemainingIssue,
  type ReportEnvelope,
  type ReportVerificationV2,
  type VerificationStatus,
  type ReportResult,
  type TokenUsage,
  type WorkerDelegation,
} from "./types";

const REPORT_ENVELOPE_FIELDS = new Set([
  "kind",
  "schema_version",
  "invocation_id",
  "result",
  "work_done",
  "delegation",
  "changes",
  "verification",
  "remaining_issues",
  "next_action",
  "needs_replanning",
  "question_for_manager",
  "pending_process",
  "design_blocked",
  "external_blocker",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseObject(text: string, reason: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw reportInvalid(reason);
  }
  try {
    // Role prompts require one JSON object with no prose or markdown around
    // it. Extracting an object from mixed output would silently discard a
    // harness error or warning and could make a failed invocation look
    // successful.
    const value: unknown = JSON.parse(trimmed);
    if (!isRecord(value)) {
      throw reportInvalid(`${reason}:object_required`);
    }
    return value;
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AgentRuntimeError") {
      throw cause;
    }
    throw reportInvalid(reason, cause);
  }
}

export function parseSingleJsonObject(text: string, reason = "stdout_not_single_json_object"):
  Record<string, unknown> {
  return parseObject(text, reason);
}

function isReportResult(value: unknown): value is ReportResult {
  return value === "success" || value === "failed" || value === "partial";
}

function required(payload: Record<string, unknown>, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(payload, key)) {
    throw reportInvalid(`report_field_missing:${key}`);
  }
  return payload[key];
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = required(payload, key);
  if (typeof value !== "string") {
    throw reportInvalid(`report_field_not_string:${key}`);
  }
  return value;
}

function objectArrayField(
  payload: Record<string, unknown>,
  key: string,
): readonly Record<string, unknown>[] {
  const value = required(payload, key);
  if (
    !Array.isArray(value) ||
    value.some((item) => !isRecord(item))
  ) {
    throw reportInvalid(`report_field_not_object_array:${key}`);
  }
  return value as readonly Record<string, unknown>[];
}

function hasStringFields(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => typeof value[key] === "string");
}

/** remaining_issues: one {issue, impact, next_step} object per unresolved issue. */
function remainingIssuesField(payload: Record<string, unknown>): readonly RemainingIssue[] {
  const value = required(payload, "remaining_issues");
  if (!Array.isArray(value) || value.some((item) => !isRecord(item) || !hasStringFields(item, ["issue", "impact", "next_step"]))) {
    throw reportInvalid("report_remaining_issues_invalid");
  }
  return value as readonly RemainingIssue[];
}

const VERIFICATION_STATUSES: readonly string[] = ["passed", "failed", "blocked"];
const VERIFICATION_FIELDS = ["status", "method", "acceptance", "checks", "integration_check"];

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isStatus(value: unknown): value is VerificationStatus {
  return typeof value === "string" && VERIFICATION_STATUSES.includes(value);
}

/** verification (schema 1.1.0): per-criterion status and evidence, checks and the integration check. */
function verificationField(payload: Record<string, unknown>): ReportVerificationV2 {
  const value = required(payload, "verification");
  if (!isRecord(value) || !onlyKeys(value, VERIFICATION_FIELDS)) {
    throw reportInvalid("report_verification_invalid");
  }
  if (!isStatus(value.status)) throw reportInvalid("report_verification_status_invalid");
  if (!nonEmptyString(value.method)) throw reportInvalid("report_verification_method_invalid");
  const acceptance = value.acceptance;
  if (!Array.isArray(acceptance) || acceptance.length === 0) {
    throw reportInvalid("report_verification_acceptance_empty");
  }
  const ids = new Set<string>();
  for (const item of acceptance) {
    // unverifiable_reason is optional so reports without it stay valid.
    const keys = ["criterion_id", "criterion", "status", "evidence"];
    if (!isRecord(item) || !(onlyKeys(item, keys) || (onlyKeys(item, [...keys, "unverifiable_reason"]) &&
      (item.unverifiable_reason === null || typeof item.unverifiable_reason === "string"))) ||
      !nonEmptyString(item.criterion_id) || !nonEmptyString(item.criterion) ||
      !(isStatus(item.status) || item.status === UNVERIFIABLE_STATUS) || !nonEmptyString(item.evidence)) {
      throw reportInvalid("report_verification_acceptance_invalid");
    }
    if (ids.has(item.criterion_id)) throw reportInvalid("report_verification_criterion_id_duplicate");
    ids.add(item.criterion_id);
  }
  const checks = value.checks;
  if (!Array.isArray(checks) || checks.some((item) => !isRecord(item) || !onlyKeys(item, ["name", "status", "evidence"]) ||
    !nonEmptyString(item.name) || !isStatus(item.status) || !nonEmptyString(item.evidence))) {
    throw reportInvalid("report_verification_checks_invalid");
  }
  const integration = value.integration_check;
  if (integration !== null && (!isRecord(integration) || !(onlyKeys(integration, ["status", "evidence"]) || (onlyKeys(integration, ["status", "evidence", "required"]) && typeof integration.required === "boolean")) ||
    !isStatus(integration.status) || !nonEmptyString(integration.evidence))) {
    throw reportInvalid("report_verification_integration_invalid");
  }
  return value as unknown as ReportVerificationV2;
}

/** verification (schema 1.0.0): read-only, for reports already stored. */
function legacyVerificationField(payload: Record<string, unknown>): LegacyReportVerification {
  const value = required(payload, "verification");
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.passed !== "boolean" ||
    typeof value.method !== "string"
  ) {
    throw reportInvalid("report_verification_invalid");
  }
  return { passed: value.passed, method: value.method };
}

function delegationField(payload: Record<string, unknown>): WorkerDelegation {
  const value = required(payload, "delegation");
  if (
    !isRecord(value) ||
    ![3, 4].includes(Object.keys(value).length) ||
    (Object.keys(value).length === 4 && typeof value.own_subagents_used !== "boolean") ||
    typeof value.decomposition !== "string" || value.decomposition.trim().length === 0 ||
    !Array.isArray(value.delegated) ||
    value.delegated.some((item) => !isRecord(item) || !hasStringFields(item, ["child_id", "instruction", "provider", "model"]) ||
      Object.values(item).some((field) => (field as string).trim().length === 0)) ||
    !Array.isArray(value.retained) ||
    value.retained.some((item) => !isRecord(item) || !hasStringFields(item, ["part", "reason"]) ||
      Object.values(item).some((field) => (field as string).trim().length === 0))
  ) {
    throw reportInvalid("report_delegation_invalid");
  }
  return {
    decomposition: value.decomposition,
    delegated: value.delegated as WorkerDelegation["delegated"],
    retained: value.retained as WorkerDelegation["retained"],
    ...(typeof value.own_subagents_used === "boolean" ? { own_subagents_used: value.own_subagents_used } : {}),
  };
}

function withReportDefaults(
  payload: Record<string, unknown>,
  invocationId: string,
): Record<string, unknown> {
  if (payload.kind !== "report") {
    throw reportInvalid("report_kind_invalid");
  }
  if (typeof payload.invocation_id !== "string" || payload.invocation_id.length === 0) {
    throw reportInvalid("report_invocation_id_invalid");
  }
  // The prompt shows a placeholder ("<will be filled>") because the model
  // cannot know the id; the runtime's own invocation id is authoritative.
  return invocationId.length > 0 ? { ...payload, invocation_id: invocationId } : { ...payload };
}

/**
 * Validate every ReportEnvelope field; missing fields never receive defaults.
 * Only schema 1.1.0 is accepted: a legacy 1.0.0 report from a new agent run is
 * a contract failure. Stored reports go through readStoredReport instead.
 */
export function validateReportEnvelope(value: unknown): ReportEnvelope {
  return validateEnvelope(value, REPORT_SCHEMA_VERSION) as ReportEnvelope;
}

/** Read a report saved in the DB: schema 1.1.0, or a legacy 1.0.0 one (`verification.passed`). */
export function readStoredReport(value: unknown): ReportEnvelope | LegacyReportEnvelope {
  const version = isRecord(value) ? value.schema_version : undefined;
  return validateEnvelope(value, version === LEGACY_REPORT_SCHEMA_VERSION ? LEGACY_REPORT_SCHEMA_VERSION : REPORT_SCHEMA_VERSION);
}

function validateEnvelope(value: unknown, version: string): ReportEnvelope | LegacyReportEnvelope {
  if (!isRecord(value)) {
    throw reportInvalid("report_object_required");
  }
  for (const key of Object.keys(value)) {
    if (!REPORT_ENVELOPE_FIELDS.has(key)) {
      throw reportInvalid(`report_additional_property:${key}`);
    }
  }
  const kind = required(value, "kind");
  if (kind !== "report") {
    throw reportInvalid("report_kind_invalid");
  }
  const schemaVersion = required(value, "schema_version");
  if (schemaVersion !== version) {
    throw reportInvalid(schemaVersion === LEGACY_REPORT_SCHEMA_VERSION
      ? "report_schema_version_legacy"
      : "report_schema_version_invalid");
  }
  const invocationId = stringField(value, "invocation_id");
  if (invocationId.length === 0) {
    throw reportInvalid("report_invocation_id_empty");
  }
  const result = required(value, "result");
  if (!isReportResult(result)) {
    throw reportInvalid("report_result_missing_or_invalid");
  }
  const workDone = stringField(value, "work_done");
  const delegation = delegationField(value);
  const changes = objectArrayField(value, "changes");
  const verification = version === REPORT_SCHEMA_VERSION ? verificationField(value) : legacyVerificationField(value);
  const remainingIssues = remainingIssuesField(value);
  const nextAction = stringField(value, "next_action");
  const needsReplanning = required(value, "needs_replanning");
  if (typeof needsReplanning !== "boolean") {
    throw reportInvalid("report_needs_replanning_invalid");
  }
  const question = required(value, "question_for_manager");
  if (question !== null && typeof question !== "string") {
    throw reportInvalid("report_question_for_manager_invalid");
  }
  // Optional: a long process the Worker left running (Core validates its content).
  const pendingProcess = value.pending_process;
  if (pendingProcess !== undefined && pendingProcess !== null && !isRecord(pendingProcess)) {
    throw reportInvalid("report_pending_process_invalid");
  }
  const designBlocked = value.design_blocked;
  if (designBlocked !== undefined && designBlocked !== null && !isRecord(designBlocked)) {
    throw reportInvalid("report_design_blocked_invalid");
  }
  const externalBlocker = value.external_blocker;
  if (externalBlocker !== undefined && externalBlocker !== null && !isRecord(externalBlocker)) {
    throw reportInvalid("report_external_blocker_invalid");
  }
  return {
    kind: "report",
    schema_version: version,
    invocation_id: invocationId,
    result,
    work_done: workDone,
    delegation,
    changes,
    verification,
    remaining_issues: remainingIssues,
    next_action: nextAction,
    needs_replanning: needsReplanning,
    question_for_manager: question,
    ...(isRecord(pendingProcess) ? { pending_process: pendingProcess } : {}),
    ...(isRecord(designBlocked) ? { design_blocked: designBlocked } : {}),
    ...(isRecord(externalBlocker) ? { external_blocker: externalBlocker } : {}),
  } as ReportEnvelope | LegacyReportEnvelope;
}

/** Hybrid routing fields that travel beside a report (not part of the envelope). */
export interface HybridRouting {
  readonly verdict: "ok" | "retry";
  readonly retry_subtasks: readonly unknown[];
}

/**
 * Meaning checks a shape-valid report can still fail: a success claim that the
 * verification contradicts. blocked and failed are both rejected, for
 * different reasons; neither is ever treated as passed.
 */
export function validateReportSemantics(report: ReportEnvelope, hybrid?: HybridRouting): void {
  const { verification } = report;
  if (report.result === "success") {
    if (verification.status !== "passed") throw reportInvalid(`report_semantics:success_with_verification_${verification.status}`);
    const unmet = verification.acceptance.find((item) => item.status !== "passed")
      ?? verification.checks.find((item) => item.status !== "passed");
    if (unmet) throw reportInvalid(`report_semantics:success_with_${unmet.status}_item`);
    if (report.needs_replanning) throw reportInvalid("report_semantics:success_with_needs_replanning");
    if (report.question_for_manager !== null) throw reportInvalid("report_semantics:success_with_question_for_manager");
  }
  // Without delegated children there is no integrated result to check.
  if (hybrid?.verdict === "ok" && report.delegation.delegated.length > 0 && verification.integration_check?.status !== "passed") {
    throw reportInvalid("report_semantics:hybrid_ok_without_passed_integration");
  }
  if (hybrid?.verdict === "retry" && hybrid.retry_subtasks.length === 0) {
    throw reportInvalid("report_semantics:hybrid_retry_without_subtasks");
  }
}

/**
 * Extract the raw report JSON object from provider stdout WITHOUT validating
 * it against the strict ReportEnvelope field allowlist. Normal report
 * parsing (normalizeClaudeStdout/consumeCanonicalJsonl) validates
 * immediately and is left untouched; this helper lets role schemas consume
 * their additional output fields (such as skill feedback) before the stored
 * ReportEnvelope is validated separately.
 */
export function extractReportPayload(
  adapter: string,
  rawStdout: string,
  invocationId: string,
  format: "provider-json" | "canonical-jsonl" | "plain-text" = "provider-json",
): Record<string, unknown> {
  if (format === "plain-text") {
    const payload = parseSingleJsonObject(rawStdout, "provider_result_not_single_json_object");
    return withReportDefaults(payload, invocationId);
  }
  if (format === "provider-json") {
    if (adapter === "codex" || adapter.startsWith("codex")) {
      const payload = parseSingleJsonObject(unwrapCodexCliResult(rawStdout), "codex_result_not_single_json_object");
      return withReportDefaults(payload, invocationId);
    }
    const payload = parseSingleJsonObject(
      unwrapClaudeCliResult(rawStdout),
      "claude_result_not_single_json_object",
    );
    return withReportDefaults(payload, invocationId);
  }
  let report: Record<string, unknown> | null = null;
  for (const rawLine of rawStdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (cause) {
      throw reportInvalid("canonical_jsonl_line_invalid", cause);
    }
    if (!isRecord(parsed)) {
      throw reportInvalid("canonical_jsonl_line_not_object");
    }
    if (parsed.kind === "log" || parsed.kind === "activity") {
      continue;
    }
    if (parsed.kind !== "report") {
      throw reportInvalid("canonical_jsonl_kind_invalid");
    }
    if (report !== null) {
      throw reportInvalid("canonical_jsonl_multiple_reports");
    }
    report = parsed;
  }
  if (report === null) {
    throw reportInvalid("canonical_jsonl_report_missing");
  }
  return report;
}

/** What a harness reported about its own failure, read from its structured output. */
export interface HarnessFailureDetail {
  readonly harness_status?: number;
  readonly harness_code?: string;
  readonly error?: string;
  readonly rate_limit_evidence?: readonly RateLimitResetInput[];
}

function claudeWrapperFailure(wrapper: Record<string, unknown>): HarnessFailureDetail | null {
  if (wrapper.type !== "error" && wrapper.is_error !== true) return null;
  const nested = isRecord(wrapper.error) ? wrapper.error : null;
  const status = wrapper.api_error_status;
  // Claude reports API failures as `subtype: "success"`, which names no error.
  const code = typeof nested?.type === "string"
    ? nested.type
    : typeof wrapper.subtype === "string" && wrapper.subtype !== "success" ? wrapper.subtype : undefined;
  const message = typeof wrapper.result === "string" && wrapper.result.length > 0
    ? wrapper.result
    : typeof nested?.message === "string"
      ? nested.message
      : typeof wrapper.error === "string"
      ? wrapper.error
      : undefined;
  const rateLimitEvidence = claudeRateLimitEvidence(wrapper);
  return {
    ...(typeof status === "number" && Number.isInteger(status) ? { harness_status: status } : {}),
    ...(code !== undefined ? { harness_code: code } : {}),
    ...(message !== undefined ? { error: message } : {}),
    ...(rateLimitEvidence.length > 0 ? { rate_limit_evidence: rateLimitEvidence } : {}),
  };
}

/**
 * The failure a harness reported in its stdout, for a run that exited
 * non-zero. Only the harness's own error fields are read (the Claude result
 * wrapper, Codex `error` and `turn.failed` events); anything unreadable
 * yields null rather than a guess from the text.
 */
export function harnessFailureDetail(adapter: string, rawStdout: string): HarnessFailureDetail | null {
  if (adapter === "codex" || adapter.startsWith("codex")) {
    const message = codexFailureMessage(rawStdout);
    const evidence = codexRateLimitEvidence(rawStdout);
    return message === null ? null : {
      error: message,
      ...(evidence.length > 0 ? { rate_limit_evidence: evidence } : {}),
    };
  }
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(rawStdout.trim()) as unknown;
  } catch {
    return null;
  }
  return isRecord(wrapper) ? claudeWrapperFailure(wrapper) : null;
}

export function unwrapClaudeCliResult(rawStdout: string): string {
  const wrapper = parseSingleJsonObject(rawStdout, "claude_stdout_not_single_json_object");
  const failure = claudeWrapperFailure(wrapper);
  if (failure !== null) {
    throw providerFailed("provider_reported_error", {
      exit_code: 0,
      signal: null,
      ...failure,
      stdout: rawStdout,
    });
  }
  if (wrapper.type !== "result") {
    throw reportInvalid("claude_wrapper_type_invalid");
  }
  // With `--json-schema` the CLI delivers the validated answer as the
  // `structured_output` object; `result` then only carries assistant text.
  if (isRecord(wrapper.structured_output)) {
    return JSON.stringify(wrapper.structured_output);
  }
  if (typeof wrapper.result !== "string") {
    throw reportInvalid("claude_result_not_string");
  }
  return wrapper.result;
}

function codexErrorEventMessage(event: Record<string, unknown>): string {
  if (typeof event.message === "string") return event.message;
  if (isRecord(event.error) && typeof event.error.message === "string") return event.error.message;
  return "codex reported an error";
}

/** The last `error` or `turn.failed` message in a Codex event stream; lines that are not JSON are skipped. */
function codexFailureMessage(rawStdout: string): string | null {
  let message: string | null = null;
  for (const rawLine of rawStdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === "error") message = codexErrorEventMessage(event);
    else if (event.type === "turn.failed") {
      message = isRecord(event.error) && typeof event.error.message === "string" ? event.error.message : "codex turn failed";
    }
  }
  return message;
}

/**
 * Extract the final assistant message from Codex CLI's event JSONL stream.
 *
 * `{"type":"error"}` lines are not terminal: Codex emits them for transient
 * conditions it recovers from (e.g. "Reconnecting... waiting for network")
 * and the run may still finish with a final agent message. Only
 * `turn.failed`, or an error with no final agent message, fails the run; the
 * collected error messages are attached to the failure cause.
 */
export function unwrapCodexCliResult(rawStdout: string): string {
  let finalText: string | null = null;
  let turnFailed = false;
  const errors: string[] = [];
  for (const rawLine of rawStdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch (cause) {
      throw reportInvalid("codex_jsonl_line_invalid", cause);
    }
    if (!isRecord(event)) {
      throw reportInvalid("codex_jsonl_line_not_object");
    }
    if (event.type === "error") {
      errors.push(codexErrorEventMessage(event));
      continue;
    }
    if (event.type === "turn.failed") {
      turnFailed = true;
      if (isRecord(event.error) && typeof event.error.message === "string") {
        errors.push(event.error.message);
      }
      continue;
    }
    if (event.type !== "item.completed") continue;
    const item = isRecord(event.item) ? event.item : null;
    if (!item || item.type !== "agent_message") continue;
    if (typeof item.text === "string") {
      finalText = item.text;
      continue;
    }
    if (Array.isArray(item.content)) {
      const text = item.content
        .filter(isRecord)
        .map((part) => typeof part.text === "string" ? part.text : "")
        .filter((part) => part.length > 0)
        .join("\n");
      if (text.length > 0) finalText = text;
    }
  }
  const finalMissing = finalText === null || finalText.trim().length === 0;
  if (turnFailed || (finalMissing && errors.length > 0)) {
    const rateLimitEvidence = codexRateLimitEvidence(rawStdout);
    throw providerFailed("provider_reported_error", {
      exit_code: 0,
      signal: null,
      stdout: rawStdout,
      error: errors.length > 0 ? errors[errors.length - 1] : "codex turn failed",
      errors,
      ...(rateLimitEvidence.length > 0 ? { rate_limit_evidence: rateLimitEvidence } : {}),
    });
  }
  if (finalMissing || finalText === null) {
    throw reportInvalid("codex_final_agent_message_missing");
  }
  return finalText;
}

/**
 * Token usage of one finished CLI process, or null when the provider did not
 * report it. Never throws: missing or malformed usage never fails a run.
 */
export function extractProviderUsage(response: { readonly adapter: string; readonly stdout: string; readonly format?: string }): TokenUsage | null {
  if ((response.format ?? "provider-json") !== "provider-json") return null;
  const codex = response.adapter === "codex" || response.adapter.startsWith("codex");
  return cliTokenUsage(codex ? "codex" : "claude", response.stdout);
}

/** stdout is one complete JSON object, never a line-scanned stream. */
/**
 * Option B wrapper unwrapping. The canonical location is
 * packages/providers/normalize.ts#normalizeClaude; because packages/providers
 * packaging (package.json and importer setup) is not complete, this remains
 * here for now.
 */
export function normalizeClaudeStdout(
  rawStdout: string,
  invocationId: string,
): ReportEnvelope {
  const payload = parseSingleJsonObject(
    unwrapClaudeCliResult(rawStdout),
    "claude_result_not_single_json_object",
  );
  return validateReportEnvelope(withReportDefaults(payload, invocationId));
}

/**
 * Consume canonical JSONL after an adapter has normalized provider output.
 * `kind:"log"` is an explicit, documented no-op; exactly one report remains
 * authoritative. Unknown kinds fail fast instead of becoming a fallback.
 */
export function consumeCanonicalJsonl(rawJsonl: string): ReportEnvelope {
  let report: ReportEnvelope | null = null;
  for (const rawLine of rawJsonl.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (cause) {
      throw reportInvalid("canonical_jsonl_line_invalid", cause);
    }
    if (!isRecord(parsed)) {
      throw reportInvalid("canonical_jsonl_line_not_object");
    }
    if (parsed.kind === "log") {
      continue;
    }
    if (parsed.kind === "activity") {
      continue;
    }
    if (parsed.kind !== "report") {
      throw reportInvalid("canonical_jsonl_kind_invalid");
    }
    if (report !== null) {
      throw reportInvalid("canonical_jsonl_multiple_reports");
    }
    report = validateReportEnvelope(parsed);
  }
  if (report === null) {
    throw reportInvalid("canonical_jsonl_report_missing");
  }
  return report;
}

export function normalizeProviderOutput(
  adapter: string,
  rawStdout: string,
  invocationId: string,
  format: "provider-json" | "canonical-jsonl" | "plain-text" = "provider-json",
): ReportEnvelope {
  if (format === "plain-text") {
    const payload = parseSingleJsonObject(rawStdout, "provider_result_not_single_json_object");
    return validateReportEnvelope(withReportDefaults(payload, invocationId));
  }
  if (format === "provider-json") {
    const text = adapter === "codex" || adapter.startsWith("codex")
      ? unwrapCodexCliResult(rawStdout)
      : unwrapClaudeCliResult(rawStdout);
    const payload = parseSingleJsonObject(text, "provider_result_not_single_json_object");
    return validateReportEnvelope(withReportDefaults(payload, invocationId));
  }
  return consumeCanonicalJsonl(rawStdout);
}

/**
 * True when the Claude CLI ended because no StructuredOutput attempt matched
 * the enforced schema. Every other exit (auth, config, turn/budget limits,
 * empty or non-JSON stdout, Codex) returns false and keeps its classification.
 */
export function isClaudeReportFormatFailure(adapter: string, rawStdout: string): boolean {
  if (adapter.startsWith("codex")) return false;
  // stream-json emits one event per line; the final result event decides.
  for (const line of rawStdout.split("\n").reverse()) {
    if (!line.trim()) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (isRecord(event) && event.type === "result") {
        return event.is_error === true && event.subtype === "error_max_structured_output_retries";
      }
    } catch {
      // not a JSON event line
    }
  }
  return false;
}
