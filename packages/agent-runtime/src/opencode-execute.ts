import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GUARD_TOKEN_FILE_ENV,
  OPENCODE_API_KEY_ENV_ENV,
  OPENCODE_EXECUTABLE_ENV,
  OPENCODE_MIN_SUPPORTED_VERSION,
  OPENCODE_STARTUP_TIMEOUT_MS,
  isSupportedOpencodeVersion,
  opencodeConfigContent,
  opencodePermissionRules,
  opencodeServeEnv,
  owlMcpServers,
  splitOpencodeModel,
} from "@owl/shared";
import { providerFailed } from "./errors";
import { OpencodeHttpError, OpencodeStartError, startOpencodeServer, type OpencodeClient, type OpencodeEvent, type OpencodeServer } from "./opencode-client";
import { OpencodePermissionResponder } from "./opencode-permission";
import type { OpencodeResultError } from "./opencode-result";
import { runOpencodeTurn, type OpencodeTurnError } from "./opencode-turn";
import { resolveOwlDataDir } from "./output-log";
import type { ProviderExecutionRequest, ProviderResponse } from "./types";

/** Same cap as the CLI providers' captured output. */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
/** Time serve gets to exit after its stdin closes, before its process group is killed. */
const STOP_GRACE_MS = 5_000;
/** How long to wait for serve's exit once the event stream ended, to tell a dead serve from a silent one. */
const SERVE_EXIT_WAIT_MS = 1_000;

export interface OpencodeExecuteDeps {
  /** The runner's base env; `request.env` is laid over it. */
  readonly env: Readonly<Record<string, string>>;
  /** Token file of this run's guard token; reaches the hook and the MCP servers as OWL_GUARD_TOKEN_FILE. */
  readonly guardTokenFile?: string;
  readonly timeouts: { readonly wallMs: number; readonly idleMs: number };
  readonly reapGraceMs?: number;
  readonly startupTimeoutMs?: number;
  readonly eventStallMs?: number;
  readonly retryWaitLimitMs?: number;
  readonly hookTimeoutMs?: number;
  readonly toolLookupWaitMs?: number;
}

/** Builds the outcome once serve is gone, so a failure can carry serve's stderr tail. */
type Finish = (serveStderr: string) => ProviderResponse;

interface ModelEntry {
  readonly providerID: string;
  readonly modelID: string;
  readonly enabled?: boolean;
  readonly variants?: readonly { readonly id: string }[];
}

interface SessionBody {
  readonly id: string;
  readonly projectID: string;
  readonly model?: { readonly providerID?: string; readonly id?: string; readonly variant?: string };
  readonly location?: { readonly directory?: string };
}

/** A failure Owl itself found: kind harness_error with a code, never retried. */
export function harnessError(code: string, message: string, extra: { stdout?: string; stderr?: string } = {}): Error {
  return providerFailed("provider_reported_error", { exit_code: null, signal: null, code, error: message, harness_transient: false, ...extra });
}

/** Runs `<executable> --version` before anything is started. */
export function readExecutableVersion(executable: string, env: Readonly<Record<string, string>>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, ["--version"], { env: { ...env }, timeout: OPENCODE_STARTUP_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) reject(providerFailed("spawn_call_failed", { exit_code: null, signal: null, error: `opencode --version failed: ${error.message}` }));
      else resolve(stdout.trim());
    });
  });
}

export function startFailure(error: unknown): Error {
  if (error instanceof OpencodeStartError) {
    if (error.code === "opencode_start_failed") return providerFailed("spawn_call_failed", { exit_code: null, signal: null, error: error.message });
    return harnessError(error.code, error.message);
  }
  return providerFailed("spawn_call_failed", error);
}

const throwing = (error: Error): Finish => () => {
  throw error;
};

/**
 * Runs one role call on opencode: starts a private `opencode serve`, checks login and model, sends the
 * prompt as one turn of an opencode session and returns the turn as provider-json lines (design 4.4).
 */
export async function executeOpencode(request: ProviderExecutionRequest, deps: OpencodeExecuteDeps): Promise<ProviderResponse> {
  const model = splitOpencodeModel(request.model);
  if (!model) throw harnessError("opencode_model_invalid", `opencode model must be providerID/modelID: ${request.model}`);
  const cwd = request.cwd;
  const env: Record<string, string> = {
    ...deps.env,
    ...request.env,
    ...(deps.guardTokenFile ? { [GUARD_TOKEN_FILE_ENV]: deps.guardTokenFile } : {}),
  };
  const executable = request.env[OPENCODE_EXECUTABLE_ENV] ?? deps.env[OPENCODE_EXECUTABLE_ENV] ?? "opencode";
  const version = await readExecutableVersion(executable, env);
  if (!isSupportedOpencodeVersion(version)) {
    throw harnessError("opencode_version_unsupported", `opencode ${version} is older than ${OPENCODE_MIN_SUPPORTED_VERSION}.`);
  }

  const owlRoot = env.OWL_ROOT ?? process.env.OWL_ROOT ?? process.cwd();
  const dataDir = resolveOwlDataDir(env);
  const runDir = dataDir === null ? mkdtempSync(join(tmpdir(), "owl-opencode-")) : join(dataDir, "opencode-runs", request.invocation_id);

  const lines: string[] = [];
  const notes: string[] = [];
  let bytes = 0;
  let stopReason: "wall" | "too_large" | null = null;
  const control = new AbortController();
  const stopRun = (reason: "wall" | "too_large"): void => {
    stopReason ??= reason;
    control.abort();
  };
  const signal = request.signal ? AbortSignal.any([request.signal, control.signal]) : control.signal;
  const emit = (line: string): void => {
    lines.push(line);
    bytes += Buffer.byteLength(line) + 1;
    try { request.on_stdout_line?.(line); } catch { /* telemetry must not break provider I/O */ }
    if (bytes > MAX_CAPTURE_BYTES) stopRun("too_large");
  };
  const stdout = (): string => lines.map((line) => `${line}\n`).join("");
  const resultLine = (sessionId: string, userMessageId: string | null, messages: readonly unknown[], error: OpencodeResultError | null): string =>
    JSON.stringify({ type: "opencode.result", session_id: sessionId, version, user_message_id: userMessageId, messages, error });
  const response = (sessionId: string | undefined, exitCode: number, serveStderr: string): ProviderResponse => {
    if (stopReason === "too_large") throw providerFailed("provider_output_too_large", { stdout: stdout(), stderr: serveStderr });
    return {
    adapter: request.adapter,
    stdout: stdout(),
    stderr: `${notes.map((note) => `${note}\n`).join("")}${serveStderr}`,
    exit_code: exitCode,
    signal: null,
    ...(server ? { pid: server.pid } : {}),
    ...(sessionId ? { provider_session_id: sessionId } : {}),
    format: "provider-json",
    };
  };
  /** The failure Owl caused by stopping the run (size cap, wall limit, caller abort), if it did. */
  const stoppedBy = (): Finish | null => {
    const cause = (serveStderr: string, extra: object = {}): object => ({ exit_code: null, signal: null, stdout: stdout(), stderr: serveStderr, ...extra });
    if (stopReason === "too_large") return (stderr) => { throw providerFailed("provider_output_too_large", cause(stderr)); };
    if (stopReason === "wall") return (stderr) => { throw providerFailed("provider_timeout", cause(`${stderr}\nprovider_timeout`, { timeout_kind: "wall" })); };
    if (request.signal?.aborted) return (stderr) => { throw providerFailed("provider_cancelled", cause(stderr)); };
    return null;
  };
  const failedResult = (sessionId: string | undefined, userMessageId: string | null, error: OpencodeResultError): Finish => (stderr) => {
    emit(resultLine(sessionId ?? "", userMessageId, [], error));
    return response(sessionId, 1, stderr);
  };

  let server: OpencodeServer | null = null;
  let wallTimer: NodeJS.Timeout | undefined;
  const eventsAbort = new AbortController();
  let finish: Finish | null = null;
  let failure: unknown = null;
  try {
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const configContent = opencodeConfigContent({
      cwd,
      model: request.model,
      env,
      permissions: opencodePermissionRules(request.role),
      mcpServers: owlMcpServers({ owlRoot, role: request.role, env }),
    });
    const serveEnv = opencodeServeEnv({ env, password: randomBytes(24).toString("base64url"), runDir, configContent });
    if (deps.timeouts.wallMs > 0) {
      wallTimer = setTimeout(() => stopRun("wall"), deps.timeouts.wallMs);
      wallTimer.unref();
    }
    try {
      server = await startOpencodeServer({ executable, cwd, env: serveEnv, startupTimeoutMs: deps.startupTimeoutMs, eventStallMs: deps.eventStallMs });
    } catch (error) {
      throw startFailure(error);
    }
    const running = server;
    const { client } = running;
    request.on_spawn?.(running.pid);

    // A stop ends the event stream too, so the wait for the first event cannot outlive it.
    signal.addEventListener("abort", () => eventsAbort.abort(), { once: true });
    const iterator: AsyncIterator<OpencodeEvent> = client.events(eventsAbort.signal)[Symbol.asyncIterator]();
    await waitForConnection(iterator, deps.startupTimeoutMs ?? OPENCODE_STARTUP_TIMEOUT_MS);
    const stopped = stoppedBy();
    if (stopped) {
      finish = stopped;
    } else {
      const checked = await precheck(client, model, env, request.effort, signal);
      if (checked.error) {
        finish = failedResult(undefined, null, checked.error);
      } else {
        if (!checked.variant) {
          notes.push(checked.skippedEffort
            ? `opencode: effort "${checked.skippedEffort}" is not a variant of ${request.model}; none was used.`
            : "opencode: no effort was given; no variant was passed.");
        }
        const desired = { providerID: model.providerID, id: model.modelID, ...(checked.variant ? { variant: checked.variant } : {}) };
        const session = await openSession(client, request, desired, signal);
        const responder = new OpencodePermissionResponder({ client, owlRoot, cwd, env, hookTimeoutMs: deps.hookTimeoutMs, toolLookupWaitMs: deps.toolLookupWaitMs });
        const turn = await runOpencodeTurn({
          client,
          events: iterator,
          responder,
          role: request.role,
          sessionId: session.id,
          projectId: session.projectID,
          text: request.prompt,
          onRecord: emit,
          onActivity: () => { try { request.on_output?.(); } catch { /* telemetry must not break provider I/O */ } },
          signal,
          idleMs: deps.timeouts.idleMs,
          retryWaitLimitMs: deps.retryWaitLimitMs,
        });
        finish = await outcomeOf(turn, session.id);
      }
    }

    async function outcomeOf(turn: Awaited<ReturnType<typeof runOpencodeTurn>>, sessionId: string): Promise<Finish> {
      const error = turn.error;
      if (error === null) {
        return (stderr) => {
          emit(resultLine(sessionId, turn.userMessageId, turn.messages, null));
          return response(sessionId, 0, stderr);
        };
      }
      const special = await specialFailure(error, running, stdout, stoppedBy);
      if (special) return special;
      const resultError: OpencodeResultError = {
        type: error.type,
        message: error.message,
        ...(error.status !== undefined ? { status: error.status } : {}),
        ...(error.retry_after !== undefined ? { retry_after: error.retry_after } : {}),
        ...(error.retry_at !== undefined ? { retry_at: error.retry_at } : {}),
      };
      return (stderr) => {
        emit(resultLine(sessionId, turn.userMessageId, turn.messages, resultError));
        return response(sessionId, 1, stderr);
      };
    }
  } catch (error) {
    // A request cut short by our own stop (wall limit, caller abort) is that stop, not a serve fault.
    failure = error;
    if (signal.aborted) finish = stoppedBy();
  } finally {
    if (wallTimer !== undefined) clearTimeout(wallTimer);
    eventsAbort.abort();
  }
  // Stdin closes, the process group is reaped and the run directory goes on every ending.
  let serveStderr = "";
  try {
    if (server) {
      await server.stop(deps.reapGraceMs ?? STOP_GRACE_MS);
      serveStderr = (await server.exited).stderr_tail;
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
  if (finish === null) throw failure;
  return finish(serveStderr);
}

/** Failures that end the run without a model error in the result: Owl's own stops, a silent or dead serve, and harness-level faults. */
async function specialFailure(error: OpencodeTurnError, server: OpencodeServer, stdout: () => string, stoppedBy: () => Finish | null): Promise<Finish | null> {
  if (error.type === "opencode_aborted") return stoppedBy() ?? throwing(harnessError("opencode_unexpected_interrupt", error.message));
  if (error.type === "opencode_idle_timeout") {
    return (stderr) => { throw providerFailed("provider_timeout", { exit_code: null, signal: null, timeout_kind: "idle", stdout: stdout(), stderr: `${stderr}\nprovider_timeout` }); };
  }
  if (error.type === "opencode_events_closed") {
    const exit = await Promise.race([server.exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), SERVE_EXIT_WAIT_MS).unref())]);
    return (stderr) => {
      throw providerFailed(`provider_exit:${exit?.exit_code ?? "signal"}`, {
        exit_code: exit?.exit_code ?? null,
        signal: exit?.signal ?? null,
        error: exit ? "opencode serve exited during the turn." : "opencode sent nothing, not even a heartbeat, so it was treated as stopped.",
        stdout: stdout(),
        stderr,
      });
    };
  }
  // `aborted` here means something other than Owl interrupted the turn.
  if (error.type === "aborted") return throwing(harnessError("opencode_unexpected_interrupt", error.message));
  if (error.type.startsWith("opencode_")) return throwing(harnessError(error.type, error.message));
  return null;
}

export async function waitForConnection(iterator: AsyncIterator<OpencodeEvent>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const connected = (async (): Promise<boolean> => {
    while (true) {
      const next = await iterator.next();
      if (next.done) return false;
      if (next.value.type === "server.connected") return true;
    }
  })();
  const ok = await Promise.race([connected, timeout]).finally(() => clearTimeout(timer));
  if (!ok) throw providerFailed("spawn_call_failed", { exit_code: null, signal: null, error: "opencode serve did not open its event stream." });
}

interface Precheck {
  readonly error?: OpencodeResultError;
  readonly variant?: string;
  readonly skippedEffort?: string;
}

/** Login and model checks before anything is sent (design 4.4 item 4). */
export async function precheck(client: OpencodeClient, model: { providerID: string; modelID: string }, env: Readonly<Record<string, string>>, effort: string | undefined, signal: AbortSignal): Promise<Precheck> {
  // An API key supplied by Owl replaces the login; a changed base URL alone does not.
  if (!env[OPENCODE_API_KEY_ENV_ENV]) {
    const providers = await client.request<{ data: { id: string; integrationID?: string }[] }>("GET", "/api/provider", undefined, signal);
    const integrationId = providers.data.find((provider) => provider.id === model.providerID)?.integrationID;
    if (integrationId !== undefined) {
      const integrations = await client.request<{ data: { id: string; connections?: unknown[] }[] }>("GET", "/api/integration", undefined, signal);
      const integration = integrations.data.find((item) => item.id === integrationId);
      if (!integration?.connections?.length) {
        return { error: { type: "provider.auth", status: 401, message: `opencode has no login for ${model.providerID}. Run \`opencode auth\` to sign in, then retry.` } };
      }
    }
  }
  const models = await client.request<{ data: ModelEntry[] }>("GET", "/api/model", undefined, signal);
  const entry = models.data.find((item) => item.providerID === model.providerID && item.modelID === model.modelID && item.enabled === true);
  if (!entry) {
    return { error: { type: "model.not-found", status: 404, message: `opencode has no enabled model ${model.providerID}/${model.modelID}.` } };
  }
  if (effort === undefined) return {};
  return entry.variants?.some((variant) => variant.id === effort) ? { variant: effort } : { skippedEffort: effort };
}

/** Creates the session, or checks and reuses the one the request names (design 2.4). */
async function openSession(client: OpencodeClient, request: ProviderExecutionRequest, desired: { providerID: string; id: string; variant?: string }, signal: AbortSignal): Promise<{ id: string; projectID: string }> {
  if (request.provider_session_id === undefined) {
    const created = await client.request<{ data: SessionBody }>("POST", "/api/session", {
      title: request.invocation_id,
      agent: "build",
      model: desired,
      location: { directory: request.cwd },
      permissions: opencodePermissionRules(request.role),
    }, signal);
    return { id: created.data.id, projectID: created.data.projectID };
  }
  const id = request.provider_session_id;
  let existing: { data: SessionBody };
  try {
    existing = await client.request<{ data: SessionBody }>("GET", `/api/session/${id}`, undefined, signal);
  } catch (error) {
    if (error instanceof OpencodeHttpError && error.status === 404) throw harnessError("opencode_session_not_found", `opencode has no session ${id}.`);
    throw error;
  }
  if (existing.data.location?.directory !== request.cwd) {
    throw harnessError("opencode_session_mismatch", `opencode session ${id} belongs to another directory than ${request.cwd}.`);
  }
  const current = existing.data.model;
  if (current?.providerID !== desired.providerID || current.id !== desired.id || current.variant !== desired.variant) {
    await client.request("POST", `/api/session/${id}/model`, { model: desired }, signal);
  }
  return { id, projectID: existing.data.projectID };
}
