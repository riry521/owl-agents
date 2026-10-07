import { providerReportedError, reportInvalid } from "./errors.js";
import {
  PROVIDER_CONTRACT_VERSION,
  type AdapterId,
  type CanonicalActivity,
  type CanonicalLine,
  type CanonicalReport,
  type ReportResult,
} from "./types.js";

export interface NormalizationOptions {
  readonly now?: () => string;
}

export interface NormalizedProviderOutput {
  readonly lines: CanonicalLine[];
  readonly report: CanonicalReport;
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isReportResult(value: unknown): value is ReportResult {
  return value === "success" || value === "failed" || value === "partial";
}

function parseStrictJsonObject(text: string, adapter: AdapterId, reasonCode: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.includes("```") || !trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw reportInvalid(adapter, reasonCode);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (cause) {
    throw reportInvalid(adapter, reasonCode, cause);
  }
  if (!isRecord(parsed)) {
    throw reportInvalid(adapter, reasonCode);
  }
  return parsed;
}

function stringField(payload: Record<string, unknown>, key: string, adapter: AdapterId): string {
  if (!Object.prototype.hasOwnProperty.call(payload, key)) {
    throw reportInvalid(adapter, `report_field_missing:${key}`);
  }
  const value = payload[key];
  if (typeof value !== "string") {
    throw reportInvalid(adapter, `report_field_not_string:${key}`);
  }
  return value;
}

function requiredObjectArray(
  payload: Record<string, unknown>,
  key: string,
  adapter: AdapterId,
): unknown[] {
  if (!Object.prototype.hasOwnProperty.call(payload, key)) {
    throw reportInvalid(adapter, `report_field_missing:${key}`);
  }
  const value = payload[key];
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw reportInvalid(adapter, `report_field_not_object_array:${key}`);
  }
  return value;
}

function requiredStringArray(
  payload: Record<string, unknown>,
  key: string,
  adapter: AdapterId,
): string[] {
  if (!Object.prototype.hasOwnProperty.call(payload, key)) {
    throw reportInvalid(adapter, `report_field_missing:${key}`);
  }
  const value = payload[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw reportInvalid(adapter, `report_field_not_string_array:${key}`);
  }
  return value;
}

function normalizeReport(
  payload: Record<string, unknown>,
  adapter: AdapterId,
  invocationId: string,
): CanonicalReport {
  if (payload.kind !== "report") {
    throw reportInvalid(adapter, "report_kind_invalid");
  }
  if (typeof payload.invocation_id !== "string" || payload.invocation_id.length === 0) {
    throw reportInvalid(adapter, "report_invocation_id_invalid");
  }
  if (!isReportResult(payload.result)) {
    throw reportInvalid(adapter, "report_result_missing_or_invalid");
  }
  if (payload.schema_version !== PROVIDER_CONTRACT_VERSION) {
    throw reportInvalid(adapter, "report_schema_version_invalid");
  }
  const changes = requiredObjectArray(payload, "changes", adapter);
  const verification = payload.verification;
  if (!Object.prototype.hasOwnProperty.call(payload, "verification") || !isRecord(verification)) {
    throw reportInvalid(adapter, "report_verification_invalid");
  }
  const remainingIssues = requiredStringArray(payload, "remaining_issues", adapter);
  if (typeof payload.needs_replanning !== "boolean") {
    throw reportInvalid(adapter, "report_needs_replanning_invalid");
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "question_for_manager") || (payload.question_for_manager !== null && typeof payload.question_for_manager !== "string")) {
    throw reportInvalid(adapter, "report_question_invalid");
  }
  const workDone = stringField(payload, "work_done", adapter);
  const nextAction = stringField(payload, "next_action", adapter);

  const normalized: CanonicalReport = {
    kind: "report",
    invocation_id: payload.invocation_id,
    schema_version: PROVIDER_CONTRACT_VERSION,
    result: payload.result,
    work_done: workDone,
    changes: [...changes],
    verification: { ...verification },
    remaining_issues: [...remainingIssues],
    next_action: nextAction,
    needs_replanning: payload.needs_replanning,
    question_for_manager: payload.question_for_manager,
  };

  for (const [key, value] of Object.entries(payload)) {
    if (
      key !== "kind" &&
      key !== "invocation_id" &&
      key !== "schema_version" &&
      key !== "result" &&
      key !== "work_done" &&
      key !== "changes" &&
      key !== "verification" &&
      key !== "remaining_issues" &&
      key !== "next_action" &&
      key !== "needs_replanning" &&
      key !== "question_for_manager"
    ) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function activityFromCodexEvent(
  event: Record<string, unknown>,
  now: () => string,
): CanonicalActivity {
  const text =
    typeof event.text === "string"
      ? event.text
      : typeof event.message === "string"
        ? event.message
        : JSON.stringify(event);
  return {
    kind: "activity",
    text: text ?? "",
    at: typeof event.at === "string" ? event.at : now(),
  };
}

function normalizeClaude(
  rawStdout: string,
  invocationId: string,
): NormalizedProviderOutput {
  const envelope = parseStrictJsonObject(
    stripAnsi(rawStdout),
    "claude-cli/v1",
    "claude_stdout_not_single_json_object",
  );
  if (envelope.type === "error" || envelope.is_error === true) {
    throw providerReportedError("claude-cli/v1", "claude_provider_reported_error", envelope.error ?? envelope);
  }
  if (envelope.type !== "result" || typeof envelope.result !== "string") {
    throw reportInvalid("claude-cli/v1", "claude_result_payload_invalid");
  }
  const payload = parseStrictJsonObject(envelope.result, "claude-cli/v1", "claude_result_not_single_json_object");
  const report = normalizeReport(payload, "claude-cli/v1", invocationId);
  return { lines: [report], report };
}

function normalizeCodex(
  rawStdout: string,
  invocationId: string,
  options: NormalizationOptions,
): NormalizedProviderOutput {
  const now = options.now ?? (() => new Date().toISOString());
  const lines: CanonicalLine[] = [];
  let report: CanonicalReport | null = null;
  let lastReportCandidate: string | null = null;
  const rawLines = stripAnsi(rawStdout).split(/\r?\n/);
  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (cause) {
      throw reportInvalid("codex-cli/v1", "codex_jsonl_line_invalid", cause);
    }
    if (!isRecord(parsed)) {
      throw reportInvalid("codex-cli/v1", "codex_jsonl_event_not_object");
    }
    if (parsed.type === "error" || parsed.type === "turn.failed") {
      throw providerReportedError("codex-cli/v1", "codex_provider_reported_error", parsed.error ?? parsed);
    }
    if (parsed.type === "final_report") {
      if (report !== null) {
        throw reportInvalid("codex-cli/v1", "codex_final_report_multiple");
      }
      let payload: Record<string, unknown>;
      if (parsed.report !== undefined) {
        if (!isRecord(parsed.report)) {
          throw reportInvalid("codex-cli/v1", "codex_final_report_payload_invalid");
        }
        payload = parsed.report;
      } else if (parsed.payload !== undefined) {
        if (!isRecord(parsed.payload)) {
          throw reportInvalid("codex-cli/v1", "codex_final_report_payload_invalid");
        }
        payload = parsed.payload;
      } else {
        payload = { ...parsed };
        delete payload.type;
      }
      report = normalizeReport(payload, "codex-cli/v1", invocationId);
      continue;
    }
    if (parsed.kind === "report") {
      if (report !== null) {
        throw reportInvalid("codex-cli/v1", "codex_final_report_multiple");
      }
      report = normalizeReport(parsed, "codex-cli/v1", invocationId);
      continue;
    }
    if (parsed.type === "item.completed" && isRecord(parsed.item)) {
      const item = parsed.item;
      if (item.type === "agent_message") {
        if (typeof item.text === "string") lastReportCandidate = item.text;
        else if (Array.isArray(item.content)) {
          const text = item.content
            .filter((part): part is Record<string, unknown> => isRecord(part))
            .map((part) => typeof part.text === "string" ? part.text : "")
            .filter((part) => part.length > 0)
            .join("\n");
          if (text.length > 0) lastReportCandidate = text;
        }
      }
      lines.push(activityFromCodexEvent(parsed, now));
      continue;
    }
    if (parsed.type === "message") {
      if (typeof parsed.message === "string") lastReportCandidate = parsed.message;
      else if (isRecord(parsed.message)) lastReportCandidate = JSON.stringify(parsed.message);
    }
    lines.push(activityFromCodexEvent(parsed, now));
  }
  if (report === null && lastReportCandidate !== null) {
    const payload = parseStrictJsonObject(lastReportCandidate, "codex-cli/v1", "codex_agent_message_not_single_json_object");
    report = normalizeReport(payload, "codex-cli/v1", invocationId);
  }
  if (report === null) {
    throw reportInvalid("codex-cli/v1", "codex_final_report_missing");
  }
  lines.push(report);
  return { lines, report };
}

export function normalizeProviderStdout(
  adapter: AdapterId,
  rawStdout: string,
  invocationId: string,
  options: NormalizationOptions = {},
): NormalizedProviderOutput {
  if (invocationId.length === 0) {
    throw reportInvalid(adapter, "invocation_id_empty");
  }
  if (adapter === "claude-cli/v1") {
    return normalizeClaude(rawStdout, invocationId);
  }
  if (adapter === "codex-cli/v1") {
    return normalizeCodex(rawStdout, invocationId, options);
  }
  throw reportInvalid(adapter, "adapter_not_supported");
}

export function serializeCanonicalJsonl(lines: readonly CanonicalLine[]): string {
  if (lines.filter((line) => line.kind === "report").length !== 1) {
    throw new Error("Canonical output must contain exactly one report line.");
  }
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}
