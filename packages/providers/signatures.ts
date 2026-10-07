import { readFileSync } from "node:fs";
import { providerVersionMismatch } from "./errors.js";
import {
  PROVIDER_CONTRACT_VERSION,
  type AdapterId,
  type AdapterOutcome,
  type CanonicalReport,
  type FailureClass,
} from "./types.js";

export type SignatureExitCode = number | "*";
export type SignatureSignal = string | null | "*";

export interface FailureSignature {
  readonly priority: number;
  readonly exit_code: SignatureExitCode;
  readonly signal: SignatureSignal;
  readonly stderr_pattern: string;
  readonly failure_class: FailureClass;
  readonly error_key: string;
  readonly retry_allowed: boolean;
}

export interface FailureSignatureDocument {
  readonly schema_version: string;
  readonly adapter: AdapterId;
  readonly signatures: FailureSignature[];
}

export interface FailureObservation {
  readonly adapter: AdapterId;
  readonly adapterVersion: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly reportStatus: "valid" | "invalid" | "missing";
  readonly report: CanonicalReport | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readDocument(path: string): unknown {
  try {
    const bytes = readFileSync(path);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    throw providerVersionMismatch("signature_table_unreadable");
  }
}

function parseSignature(value: unknown, adapter: AdapterId): FailureSignature {
  if (!isRecord(value)) {
    throw providerVersionMismatch("signature_row_schema", adapter);
  }
  const exitCode = value.exit_code;
  const signal = value.signal;
  const failureClass = value.failure_class;
  if (
    typeof value.priority !== "number" ||
    !Number.isInteger(value.priority) ||
    (typeof exitCode !== "number" && exitCode !== "*") ||
    (typeof signal !== "string" && signal !== null) ||
    typeof value.stderr_pattern !== "string" ||
    (failureClass !== "success" &&
      failureClass !== "transient" &&
      failureClass !== "deterministic") ||
    typeof value.error_key !== "string" ||
    typeof value.retry_allowed !== "boolean"
  ) {
    throw providerVersionMismatch("signature_row_field_invalid", adapter);
  }
  try {
    if (value.stderr_pattern !== "*") {
      void new RegExp(value.stderr_pattern, "i");
    }
  } catch (cause) {
    throw providerVersionMismatch("signature_pattern_invalid", adapter);
  }
  return {
    priority: value.priority,
    exit_code: exitCode,
    signal: signal as SignatureSignal,
    stderr_pattern: value.stderr_pattern,
    failure_class: failureClass,
    error_key: value.error_key,
    retry_allowed: value.retry_allowed,
  };
}

export function loadFailureSignatureTable(
  path: string,
  adapter: AdapterId,
): FailureSignatureDocument {
  const parsed = readDocument(path);
  if (
    !isRecord(parsed) ||
    parsed.schema_version !== PROVIDER_CONTRACT_VERSION ||
    parsed.adapter !== adapter ||
    !Array.isArray(parsed.signatures) ||
    parsed.signatures.length === 0
  ) {
    throw providerVersionMismatch("signature_document_schema", adapter);
  }
  const signatures = parsed.signatures.map((signature) => parseSignature(signature, adapter));
  for (let index = 1; index < signatures.length; index += 1) {
    if (signatures[index].priority <= signatures[index - 1].priority) {
      throw providerVersionMismatch("signature_priority_not_strictly_increasing", adapter);
    }
  }
  return {
    schema_version: parsed.schema_version,
    adapter,
    signatures,
  };
}

function matches(
  signature: FailureSignature,
  observation: FailureObservation,
): boolean {
  const exitMatches =
    signature.exit_code === "*" || signature.exit_code === observation.exitCode;
  const signalMatches =
    signature.signal === "*" || signature.signal === observation.signal;
  const patternMatches =
    signature.stderr_pattern === "*" ||
    new RegExp(signature.stderr_pattern, "i").test(observation.stderr);
  return exitMatches && signalMatches && patternMatches;
}

function fromSignature(
  signature: FailureSignature,
  observation: FailureObservation,
): AdapterOutcome {
  const errorKey = signature.error_key.replace(
    "<exit_code>",
    observation.exitCode === null ? "null" : String(observation.exitCode),
  );
  const descriptor = observation.exitCode !== null
    ? `終了コード ${observation.exitCode}`
    : observation.signal !== null
      ? `シグナル ${observation.signal}`
      : "終了状態不明";
  const detail = /rate.limit|429|overloaded/iu.test(errorKey)
    ? "利用制限または過負荷"
    : /timeout|deadline/iu.test(errorKey)
      ? "タイムアウト"
      : /network|connection/iu.test(errorKey)
        ? "ネットワーク接続"
        : /auth|credential|permission/iu.test(errorKey)
          ? "認証または権限"
          : "実行またはHarness設定";
  return {
    outcome: signature.failure_class === "success" ? "success" : "failed",
    failureClass: signature.failure_class,
    errorKey,
    message: `${observation.adapter} provider failed: ${detail}（${errorKey}、${descriptor}）。Provider認証、実行ファイル、Harnessログを確認してください。`,
    retryAllowed: signature.retry_allowed,
    exitCode: observation.exitCode,
    signal: observation.signal,
    reportValid: observation.reportStatus === "valid",
    adapterVersion: observation.adapterVersion,
    counterDelta: 0,
  };
}

function reportInvalidOutcome(observation: FailureObservation): AdapterOutcome {
  const adapterPrefix = observation.adapter.split("-")[0];
  return {
    outcome: "failed",
    failureClass: "deterministic",
    errorKey: `${adapterPrefix}.report_invalid`,
    message: `${observation.adapter} returned output that does not match the required report protocol. Check the Harness output format and adapter version.`,
    retryAllowed: false,
    exitCode: observation.exitCode,
    signal: observation.signal,
    reportValid: false,
    adapterVersion: observation.adapterVersion,
    counterDelta: 0,
  };
}

export function providerReportedErrorOutcome(observation: FailureObservation): AdapterOutcome {
  const adapterPrefix = observation.adapter.split("-")[0];
  return {
    outcome: "failed",
    failureClass: "deterministic",
    errorKey: `${adapterPrefix}.provider_reported_error`,
    message: `${observation.adapter} reported an error while processing the request. Check authentication, model access, endpoint configuration, and provider status.`,
    retryAllowed: false,
    exitCode: observation.exitCode,
    signal: observation.signal,
    reportValid: false,
    adapterVersion: observation.adapterVersion,
    counterDelta: 0,
  };
}

function processFailureOutcome(observation: FailureObservation, table: FailureSignatureDocument): AdapterOutcome {
  const signature = table.signatures.find((candidate) => matches(candidate, observation));
  if (signature !== undefined && signature.failure_class !== "success") {
    return fromSignature(signature, observation);
  }
  const adapterPrefix = observation.adapter.split("-")[0];
  const descriptor = observation.signal !== null
    ? `signal ${observation.signal}`
    : `exit code ${observation.exitCode === null ? "unknown" : observation.exitCode}`;
  return {
    outcome: "failed",
    failureClass: "deterministic",
    errorKey: `${adapterPrefix}.process_failed`,
    message: `${observation.adapter} provider process failed with ${descriptor}. Check the Harness executable, credentials, and stderr log.`,
    retryAllowed: false,
    exitCode: observation.exitCode,
    signal: observation.signal,
    reportValid: false,
    adapterVersion: observation.adapterVersion,
    counterDelta: 0,
  };
}

export function classifyFailure(
  table: FailureSignatureDocument,
  observation: FailureObservation,
): AdapterOutcome {
  if (observation.exitCode !== 0 || observation.signal !== null) {
    return processFailureOutcome(observation, table);
  }
  const adapterPrefix = observation.adapter.split("-")[0];
  if (observation.reportStatus === "valid" && observation.report !== null) {
    if (observation.report.result === "failed") {
      const code = observation.report.error_code;
      return {
        outcome: "failed",
        failureClass: "deterministic",
        errorKey: `${adapterPrefix}.report_failed:${typeof code === "string" ? code : "unknown"}`,
        message: `The ${observation.adapter} provider returned a failed report${typeof code === "string" ? ` (${code})` : ""}. Review the provider report and remaining issues.`,
        retryAllowed: true,
        exitCode: observation.exitCode,
        signal: observation.signal,
        reportValid: true,
        adapterVersion: observation.adapterVersion,
        counterDelta: 0,
      };
    }

    if (observation.report.result === "partial") {
      return {
        outcome: "partial",
        failureClass: "deterministic",
        errorKey: `${adapterPrefix}.report_partial`,
        message: `The ${observation.adapter} provider returned a partial report. Review remaining issues before continuing.`,
        retryAllowed: false,
        exitCode: observation.exitCode,
        signal: observation.signal,
        reportValid: true,
        adapterVersion: observation.adapterVersion,
        counterDelta: 0,
      };
    }

    return {
      outcome: "success",
      failureClass: "success",
      errorKey: "ok",
      message: `${observation.adapter} provider completed successfully.`,
      retryAllowed: false,
      exitCode: observation.exitCode,
      signal: observation.signal,
      reportValid: true,
      adapterVersion: observation.adapterVersion,
      counterDelta: 0,
    };
  }

  const signature = table.signatures.find((candidate) => matches(candidate, observation));
  if (signature === undefined || signature.failure_class === "success") {
    return reportInvalidOutcome(observation);
  }
  return fromSignature(signature, observation);
}

export function classifyProcessFailure(
  table: FailureSignatureDocument,
  observation: FailureObservation,
): AdapterOutcome {
  return classifyFailure(table, observation);
}
