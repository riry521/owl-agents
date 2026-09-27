import { validateProviderLock } from "./lock.js";
import {
  normalizeProviderStdout,
  serializeCanonicalJsonl,
} from "./normalize.js";
import { transientRetryDecision } from "./retry.js";
import {
  classifyProcessFailure,
  loadFailureSignatureTable,
  providerReportedErrorOutcome,
  type FailureObservation,
} from "./signatures.js";
import { maskSecrets, spawnProvider } from "./spawn.js";
import {
  type AdapterId,
  type AdapterOutcome,
  type CanonicalLine,
  type CanonicalReport,
  type HealthExecutionResult,
  type ProviderExecutionResult,
  type ResolvedProvider,
} from "./types.js";
import { buildHealthArgv, buildWorkArgv } from "./argv.js";
import { ProviderError } from "./errors.js";

export interface ProviderExecutionBaseRequest {
  readonly adapter: AdapterId;
  readonly lockPath: string;
  readonly allowedExecutableRoot: string;
  readonly cwd: string;
  readonly role?: "manager" | "worker" | "reviewer" | "advisor";
  readonly env: Readonly<Record<string, string>>;
  readonly logPath?: string;
  readonly secrets?: readonly string[];
  readonly onIdleAlert?: (alert: import("./types.js").IdleAlert) => void;
  readonly cancellation?: import("./spawn.js").CancellationSignal;
}

export interface ProviderWorkRequest extends ProviderExecutionBaseRequest {
  readonly mode: "work";
  readonly model: string;
  readonly prompt: string;
  readonly invocationId: string;
  readonly signaturesPath: string;
  readonly attempt?: number;
}

export interface ProviderHealthRequest extends ProviderExecutionBaseRequest {
  readonly mode: "health";
  readonly expectedVersion?: string;
}

export type ProviderExecutionRequest = ProviderWorkRequest | ProviderHealthRequest;

export async function executeResolvedProvider(
  provider: ResolvedProvider,
  request: Omit<ProviderWorkRequest, "adapter" | "lockPath" | "allowedExecutableRoot">,
): Promise<ProviderExecutionResult> {
  const role = request.role ?? "worker";
  const argv = buildWorkArgv(provider, request.model, request.prompt, { role, owlRoot: request.env.OWL_ROOT ?? process.env.OWL_ROOT ?? process.cwd() });
  const processResult = await spawnProvider({
    adapter: provider.adapter,
    argv,
    cwd: request.cwd,
    env: {
      ...request.env,
      OWL_AGENT_ROLE: role,
      OWL_AGENT_RUN_ID: request.invocationId,
      OWL_AGENT_CWD: request.cwd,
    },
    logPath: request.logPath,
    secrets: request.secrets,
    onIdleAlert: request.onIdleAlert,
    cancellation: request.cancellation,
  });
  let canonicalLines: CanonicalLine[] = [];
  let report: CanonicalReport | null = null;
  let outcome: AdapterOutcome;
  try {
    const normalized = normalizeProviderStdout(
      provider.adapter,
      processResult.rawStdout,
      request.invocationId,
    );
    canonicalLines = normalized.lines;
    report = normalized.report;
    const table = loadFailureSignatureTable(request.signaturesPath, provider.adapter);
    const observation: FailureObservation = {
      adapter: provider.adapter,
      adapterVersion: provider.adapterVersion,
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      stderr: processResult.rawStderr,
      reportStatus: "valid",
      report,
    };
    outcome = classifyProcessFailure(table, observation);
  } catch (error) {
    if (!(error instanceof ProviderError)) {
      throw error;
    }
    const table = loadFailureSignatureTable(request.signaturesPath, provider.adapter);
    const observation: FailureObservation = {
      adapter: provider.adapter,
      adapterVersion: provider.adapterVersion,
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      stderr: processResult.rawStderr,
      reportStatus: "invalid",
      report: null,
    };
    outcome = error.errorKey === "provider_reported_error"
      ? providerReportedErrorOutcome(observation)
      : error.errorKey === "report_invalid"
        ? classifyProcessFailure(table, observation)
        : (() => { throw error; })();
  }
  return {
    adapter: provider.adapter,
    argv: argv.map((argument) => maskSecrets(argument, request.secrets ?? [])),
    process: {
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
    },
    canonicalLines,
    canonicalStdout:
      canonicalLines.length === 0
        ? ""
        : maskSecrets(serializeCanonicalJsonl(canonicalLines), request.secrets ?? []),
    report,
    outcome,
    retry: transientRetryDecision(outcome, request.attempt ?? 0),
  };
}

export async function executeProvider(
  request: ProviderExecutionRequest,
): Promise<ProviderExecutionResult | HealthExecutionResult> {
  const provider = validateProviderLock(request.lockPath, request.adapter, {
    allowedExecutableRoot: request.allowedExecutableRoot,
    expectedVersion: request.mode === "health" ? request.expectedVersion : undefined,
  });
  if (request.mode === "health") {
    const argv = buildHealthArgv(provider);
    const process = await spawnProvider({
      adapter: provider.adapter,
      argv,
      cwd: request.cwd,
      env: request.env,
      logPath: request.logPath,
      secrets: request.secrets,
      onIdleAlert: request.onIdleAlert,
      cancellation: request.cancellation,
    });
    if (process.signal !== null || process.exitCode !== 0) {
      throw new ProviderError(
        "spawn_failed",
        "The provider health check process did not exit successfully.",
        {
          adapter: provider.adapter,
          reasonCode: "health_process_failed",
          retryAllowed: false,
        },
      );
    }
    const observedVersion = process.rawStdout.trim();
    if (observedVersion.length === 0 || !observedVersion.includes(provider.adapterVersion)) {
      throw new ProviderError(
        "provider_version_mismatch",
        "The provider health check returned a version different from the locked version. Update provider-lock.json after review.",
        {
          adapter: provider.adapter,
          reasonCode: "health_version_mismatch",
          retryAllowed: false,
        },
      );
    }
    return {
      adapter: provider.adapter,
      argv,
      process: {
        exitCode: process.exitCode,
        signal: process.signal,
        stdout: process.stdout,
        stderr: process.stderr,
      },
      observedVersion,
    };
  }
  return executeResolvedProvider(provider, request);
}
