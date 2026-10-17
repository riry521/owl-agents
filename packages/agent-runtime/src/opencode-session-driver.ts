import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPENCODE_EXECUTABLE_ENV,
  OPENCODE_MIN_SUPPORTED_VERSION,
  OPENCODE_STARTUP_TIMEOUT_MS,
  isSupportedOpencodeVersion,
  opencodeConfigContent,
  opencodePermissionRules,
  externalJsonBlock,
  opencodeServeEnv,
  owlMcpServers,
  splitOpencodeModel,
} from "@owl/shared";
import { providerFailed } from "./errors";
import { startOpencodeServer, type OpencodeEvent, type OpencodeServer } from "./opencode-client";
import { harnessError, precheck, readExecutableVersion, startFailure, waitForConnection } from "./opencode-execute";
import { OpencodePermissionResponder } from "./opencode-permission";
import { opencodeFailureDetail, opencodeMessagesContextTokens, opencodeMessagesUsage } from "./opencode-result";
import { runOpencodeTurn, type OpencodeTurnError } from "./opencode-turn";
import { resolveOwlDataDir } from "./output-log";
import { classifyProviderFailure, type ProviderFailureCause } from "./provider-error";
import type { ProviderSession, ProviderSessionRequest, SessionEvent } from "./types";

const STOP_GRACE_MS = 5_000;
/** How long the interrupt sent by stop() may wait for serve's answer. */
const INTERRUPT_TIMEOUT_MS = 5_000;
const SYSTEM_PROMPT_FILE = "advisor-system-prompt.md";

export interface OpencodeSessionDeps {
  readonly reapGraceMs?: number;
  /** No event for this long ends a turn; unset or 0 means no limit (an Advisor turn may wait on the owner's tools). */
  readonly idleMs?: number;
  readonly startupTimeoutMs?: number;
  readonly eventStallMs?: number;
  readonly retryWaitLimitMs?: number;
  readonly hookTimeoutMs?: number;
  readonly toolLookupWaitMs?: number;
}

type TurnFailed = Extract<SessionEvent, { type: "turn.failed" }>;

/** The turn's error as the classifier reads it (design 2.5), with Owl's own stops kept apart from model errors. */
function turnFailure(error: OpencodeTurnError, turnId: string): TurnFailed {
  const own = error.type.startsWith("opencode_");
  const cause: ProviderFailureCause = error.type === "opencode_idle_timeout"
    ? { exit_code: null, signal: null, kind: "timeout", timeout_kind: "idle", error: error.message }
    : own
      ? { exit_code: null, signal: null, kind: "harness_error", error_code: error.type, error: error.message, harness_transient: false }
      : { exit_code: 0, signal: null, kind: "harness_error", ...opencodeFailureDetail({ ...error }) };
  const classification = classifyProviderFailure("opencode", cause);
  return { type: "turn.failed", turn_id: turnId, error: classification.message, ...(classification.rate_limit !== undefined ? { rate_limit: classification.rate_limit } : {}) };
}

/**
 * ProviderSession on one private `opencode serve` that lives as long as the session (design 2.4, 3.2, 4.5).
 * Construct via OpencodeSessionDriver.create().
 */
export class OpencodeSessionDriver implements ProviderSession {
  private readonly queue: SessionEvent[] = [];
  private readonly waiters: Array<(value: IteratorResult<SessionEvent>) => void> = [];
  private closed = false;
  private stopping = false;
  private turn: { readonly id: string; readonly done: Promise<void>; readonly abort: AbortController } | null = null;
  private contextTokens: number | null = null;
  private exitedFlag = false;
  private exitDetail: string | null = null;
  /** Events the standing reader took off the stream; a turn reads them through this buffer. */
  private readonly buffered: OpencodeEvent[] = [];
  private readonly eventWaiters: Array<(value: IteratorResult<OpencodeEvent>) => void> = [];
  private streamEnded = false;
  private readonly turnEvents: AsyncIterator<OpencodeEvent>;
  private readonly responder: OpencodePermissionResponder;

  private constructor(
    private readonly server: OpencodeServer,
    private readonly eventsAbort: AbortController,
    iterator: AsyncIterator<OpencodeEvent>,
    private readonly version: string,
    private readonly sessionId: string,
    private readonly projectId: string,
    private readonly runDir: string,
    private readonly request: ProviderSessionRequest,
    private readonly owlRoot: string,
    private readonly deps: OpencodeSessionDeps,
  ) {
    this.turnEvents = {
      next: () => {
        const event = this.buffered.shift();
        if (event) return Promise.resolve({ value: event, done: false });
        if (this.streamEnded) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<OpencodeEvent>>((resolve) => this.eventWaiters.push(resolve));
      },
    };
    void this.readEvents(iterator);
    this.responder = new OpencodePermissionResponder({ client: server.client, owlRoot, cwd: request.cwd, env: request.env, hookTimeoutMs: deps.hookTimeoutMs, toolLookupWaitMs: deps.toolLookupWaitMs });
    this.push({ type: "session.ready", provider_session_id: sessionId, pid: server.pid });
    void server.exited.then((exit) => {
      this.finish(`opencode serve exited (code ${exit.exit_code ?? "none"}, signal ${exit.signal ?? "none"})`, exit.exit_code, exit.signal, exit.stderr_tail);
    });
  }

  /** The one place a session ends: serve exited, or its event stream broke while the session was in use. */
  private finish(detail: string, exitCode: number | null, signal: string | null, stderrTail: string): void {
    if (this.exitedFlag) return;
    this.exitedFlag = true;
    this.exitDetail = detail;
    this.eventsAbort.abort();
    rmSync(this.runDir, { recursive: true, force: true });
    this.push({ type: "session.exited", exit_code: exitCode, signal, stderr_tail: stderrTail });
    this.closed = true;
    for (const resolve of this.waiters.splice(0)) resolve({ value: undefined, done: true });
  }

  /** Reads the stream for the whole session, so a break is seen between turns too (design 4.5). */
  private async readEvents(iterator: AsyncIterator<OpencodeEvent>): Promise<void> {
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        const waiter = this.eventWaiters.shift();
        if (waiter) waiter({ value: next.value, done: false });
        else this.buffered.push(next.value);
      }
    } catch {
      // A failed stream is a stream that ended.
    }
    this.streamEnded = true;
    for (const resolve of this.eventWaiters.splice(0)) resolve({ value: undefined, done: true });
    if (this.stopping || this.exitedFlag) return;
    this.finish("opencode event stream closed", null, null, "");
    this.server.kill();
  }

  public get provider_session_id(): string {
    return this.sessionId;
  }

  public get pid(): number {
    return this.server.pid;
  }

  public get exited(): boolean {
    return this.exitedFlag;
  }

  public get exit_detail(): string | null {
    return this.exitDetail;
  }

  public static async create(request: ProviderSessionRequest, deps: OpencodeSessionDeps = {}): Promise<OpencodeSessionDriver> {
    const model = splitOpencodeModel(request.model);
    if (!model) throw harnessError("opencode_model_invalid", `opencode model must be providerID/modelID: ${request.model}`);
    const env = request.env;
    const executable = env[OPENCODE_EXECUTABLE_ENV] ?? "opencode";
    const version = await readExecutableVersion(executable, env);
    if (!isSupportedOpencodeVersion(version)) {
      throw harnessError("opencode_version_unsupported", `opencode ${version} is older than ${OPENCODE_MIN_SUPPORTED_VERSION}.`);
    }
    const owlRoot = env.OWL_ROOT ?? process.env.OWL_ROOT ?? process.cwd();
    const dataDir = resolveOwlDataDir(env);
    const runDir = dataDir === null ? mkdtempSync(join(tmpdir(), "owl-opencode-")) : join(dataDir, "opencode-runs", `advisor-${randomBytes(8).toString("hex")}`);
    let server: OpencodeServer | null = null;
    const eventsAbort = new AbortController();
    try {
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      // v2's prompt has no system field; an instructions file adds to the default prompt as the other harnesses' appended prompts do.
      const promptFile = join(runDir, SYSTEM_PROMPT_FILE);
      writeFileSync(promptFile, request.system_prompt, { mode: 0o600 });
      chmodSync(promptFile, 0o600);
      const configContent = opencodeConfigContent({
        cwd: request.cwd,
        model: request.model,
        env,
        permissions: opencodePermissionRules("advisor"),
        mcpServers: owlMcpServers({ owlRoot, role: "advisor", env }),
        extraInstructions: [promptFile],
      });
      const serveEnv = opencodeServeEnv({ env, password: randomBytes(24).toString("base64url"), runDir, configContent });
      try {
        server = await startOpencodeServer({ executable, cwd: request.cwd, env: serveEnv, startupTimeoutMs: deps.startupTimeoutMs, eventStallMs: deps.eventStallMs });
      } catch (error) {
        throw startFailure(error);
      }
      const { client } = server;
      const iterator = client.events(eventsAbort.signal)[Symbol.asyncIterator]();
      await waitForConnection(iterator, deps.startupTimeoutMs ?? OPENCODE_STARTUP_TIMEOUT_MS);
      const checked = await precheck(client, model, env, request.effort, eventsAbort.signal);
      if (checked.error) throw providerFailed("provider_reported_error", { exit_code: null, signal: null, ...opencodeFailureDetail(checked.error) });
      const created = await client.request<{ data: { id: string; projectID: string } }>("POST", "/api/session", {
        title: env.OWL_AGENT_RUN_ID ?? "advisor",
        agent: "build",
        model: { providerID: model.providerID, id: model.modelID, ...(checked.variant ? { variant: checked.variant } : {}) },
        location: { directory: request.cwd },
        permissions: opencodePermissionRules("advisor"),
      }, eventsAbort.signal);
      return new OpencodeSessionDriver(server, eventsAbort, iterator, version, created.data.id, created.data.projectID, runDir, request, owlRoot, deps);
    } catch (error) {
      eventsAbort.abort();
      await server?.stop(deps.reapGraceMs ?? STOP_GRACE_MS).catch(() => undefined);
      rmSync(runDir, { recursive: true, force: true });
      throw error;
    }
  }

  private push(event: SessionEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  public async send(turn: { turn_id: string; text: string; attachment_paths?: readonly string[] }): Promise<void> {
    if (this.exitedFlag || this.stopping) throw new Error("The opencode session is no longer running.");
    if (this.turn) throw new Error("The opencode session already has a turn in flight.");
    const abort = new AbortController();
    const text = turn.attachment_paths && turn.attachment_paths.length > 0 ? `${turn.text}\n\n${externalJsonBlock("owl-attachments", turn.attachment_paths)}` : turn.text;
    const done = this.runTurn(turn.turn_id, text, abort.signal).finally(() => { this.turn = null; });
    this.turn = { id: turn.turn_id, done, abort };
  }

  private async runTurn(turnId: string, text: string, signal: AbortSignal): Promise<void> {
    const record = (line: string): void => {
      try { this.request.on_stdout_line?.(line); } catch { /* telemetry must not break provider I/O */ }
    };
    try {
      const result = await runOpencodeTurn({
        client: this.server.client,
        events: this.turnEvents,
        responder: this.responder,
        role: "advisor",
        sessionId: this.sessionId,
        projectId: this.projectId,
        text,
        onRecord: record,
        onDelta: (delta) => this.push({ type: "turn.delta", turn_id: turnId, text: delta }),
        onActivity: (event) => {
          if (event.type !== "session.compaction.ended") return;
          const summary = event.data.summary;
          this.push({ type: "session.compacted", cause: "auto", pre_tokens: this.contextTokens, summary: typeof summary === "string" ? summary : null, transcript_path: null });
        },
        signal,
        idleMs: this.deps.idleMs,
        retryWaitLimitMs: this.deps.retryWaitLimitMs,
      });
      const { error } = result;
      record(JSON.stringify({
        type: "opencode.result",
        session_id: this.sessionId,
        version: this.version,
        user_message_id: result.userMessageId,
        messages: result.messages,
        error: error === null ? null : {
          type: error.type,
          message: error.message,
          ...(error.status !== undefined ? { status: error.status } : {}),
          ...(error.retry_after !== undefined ? { retry_after: error.retry_after } : {}),
          ...(error.retry_at !== undefined ? { retry_at: error.retry_at } : {}),
        },
      }));
      if (result.error) {
        this.push(turnFailure(result.error, turnId));
        return;
      }
      this.contextTokens = opencodeMessagesContextTokens(result.messages) ?? this.contextTokens;
      this.push({ type: "turn.completed", turn_id: turnId, reply: result.text, usage: opencodeMessagesUsage(result.messages) });
    } catch (error) {
      this.push({ type: "turn.failed", turn_id: turnId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  public events(): AsyncIterable<SessionEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const event = this.queue.shift();
          if (event) return Promise.resolve({ value: event, done: false });
          if (this.closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise<IteratorResult<SessionEvent>>((resolve) => this.waiters.push(resolve));
        },
      }),
    };
  }

  public async stop(_reason: string, graceMs?: number): Promise<void> {
    this.stopping = true;
    const running = this.turn;
    if (running) {
      // Aborting the turn sends the interrupt.
      running.abort.abort();
      await running.done;
    } else if (!this.exitedFlag) {
      await this.server.client.request("POST", `/api/session/${this.sessionId}/interrupt`, undefined, AbortSignal.timeout(INTERRUPT_TIMEOUT_MS)).catch(() => undefined);
    }
    this.eventsAbort.abort();
    await this.server.stop(graceMs ?? this.deps.reapGraceMs ?? STOP_GRACE_MS);
    await this.server.exited;
    rmSync(this.runDir, { recursive: true, force: true });
  }

  public terminateImmediately(): void {
    this.stopping = true;
    this.turn?.abort.abort();
    this.eventsAbort.abort();
    this.server.kill();
    rmSync(this.runDir, { recursive: true, force: true });
  }
}
