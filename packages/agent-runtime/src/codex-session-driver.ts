// CodexSessionDriver: manages a long-running `codex app-server` child
// process and normalizes its newline-delimited JSON-RPC protocol into the
// provider-neutral ProviderSession contract.

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  ProviderSession,
  ProviderSessionRequest,
  SessionEvent,
  TokenUsage,
} from "./types.js";
import { classifyProviderFailure, formatProviderError } from "./provider-error.js";
import { agentUserInstructionEnv, buildAgentPermissionArgs, buildCodexCustomProviderArgs, ProviderResumeUnsupportedError } from "@owl/shared";

const STDERR_RING_BUFFER_BYTES = 8 * 1024;
const DEFAULT_STOP_GRACE_MS = 5000;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_METHOD_NOT_FOUND = -32601;

/**
 * Approval requests the app-server may send (codex-cli 0.155.1 ServerRequest).
 * The Advisor runs with `approval_policy="never"` and `danger-full-access`,
 * and Owl's PreToolUse hook is the sole policy gate, so these should not
 * arrive; if one does, it is accepted with the decision value that method's
 * response schema defines so the turn never blocks on an unanswered request.
 */
const APPROVAL_ACCEPT_DECISIONS: Readonly<Record<string, string>> = {
  "item/commandExecution/requestApproval": "accept",
  "item/fileChange/requestApproval": "accept",
  execCommandApproval: "approved",
  applyPatchApproval: "approved",
};

let cachedClientVersion: string | null = null;

/** Owl's agent-runtime package version for the app-server `initialize` clientInfo. */
function owlClientVersion(): string {
  if (cachedClientVersion !== null) return cachedClientVersion;
  let version = "dev";
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    if (isRecord(manifest) && typeof manifest.version === "string" && manifest.version.length > 0) {
      version = manifest.version;
    }
  } catch {
    // Bundled or relocated builds have no package.json next to dist; "dev" is
    // an accepted clientInfo version.
  }
  cachedClientVersion = version;
  return version;
}

class CodexRpcError extends Error {
  public readonly code: number | null;

  public constructor(message: string, code: number | null) {
    super(message);
    this.name = "CodexRpcError";
    this.code = code;
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      try { child.kill(signal); } catch { /* already gone */ }
    }
  }
}

interface JsonRpcError {
  readonly code?: number;
  readonly message?: string;
  readonly data?: unknown;
}

interface JsonRpcResponse {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface PendingRpcRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
}

interface CodexThread {
  readonly id?: unknown;
}

interface CodexTurn {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly items?: unknown;
  readonly error?: unknown;
}

/** agentMessage.phase of the app-server protocol; null = the provider did not say (legacy models). */
type CodexMessagePhase = "commentary" | "final_answer";

interface CodexAgentMessage {
  readonly itemId: string;
  /** Settled by item/completed or turn.items; until then the streamed deltas. */
  text: string;
  phase: CodexMessagePhase | null;
  settled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function formatError(value: unknown): string {
  return formatProviderError("codex", value);
}

function codexErrorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (isRecord(value) && typeof value.message === "string") return value.message;
  return "codex turn failed";
}

function codexTurnFailure(value: unknown, turnId: string): Extract<SessionEvent, { type: "turn.failed" }> {
  const message = codexErrorMessage(value);
  const errorInfo = isRecord(value) && isRecord(value.codexErrorInfo) ? value.codexErrorInfo : null;
  const errorCode = errorInfo?.kind ?? errorInfo?.type ?? errorInfo?.code;
  const status = isRecord(value) && typeof value.status === "number" && Number.isInteger(value.status)
    ? value.status
    : undefined;
  const classification = classifyProviderFailure("codex", {
    exit_code: 0,
    signal: null,
    kind: "harness_error",
    ...(status !== undefined ? { harness_status: status } : {}),
    ...(typeof errorCode === "string" ? { harness_code: errorCode } : {}),
    error: message,
    rate_limit_evidence: [{ kind: "event", event: value }, { kind: "text", text: message }],
  });
  return {
    type: "turn.failed",
    turn_id: turnId,
    error: classification.message,
    ...(classification.rate_limit !== undefined ? { rate_limit: classification.rate_limit } : {}),
  };
}

function threadIdFromResult(result: unknown): string | null {
  if (!isRecord(result) || !isRecord(result.thread)) {
    return null;
  }
  return getString((result.thread as CodexThread).id);
}

function turnIdFromResult(result: unknown): string | null {
  if (!isRecord(result) || !isRecord(result.turn)) {
    return null;
  }
  return getString((result.turn as CodexTurn).id);
}

/**
 * Records an agentMessage ThreadItem (from item/completed or turn.items) as
 * settled, keyed by its id. False when the item breaks the protocol: no id,
 * no text, or a phase outside MessagePhase.
 */
function settleAgentMessage(messages: Map<string, CodexAgentMessage>, item: Record<string, unknown>): boolean {
  const itemId = getString(item.id);
  if (!itemId || typeof item.text !== "string") return false;
  let phase: CodexMessagePhase | null;
  if (item.phase === null || item.phase === undefined) {
    phase = null;
  } else if (item.phase === "commentary" || item.phase === "final_answer") {
    phase = item.phase;
  } else {
    return false;
  }
  const message = messages.get(itemId) ?? { itemId, text: "", phase: null, settled: false };
  message.text = item.text;
  message.phase = phase;
  message.settled = true;
  messages.set(itemId, message);
  return true;
}

/**
 * The reply of a completed turn, chosen only by the protocol's phase (never
 * by the text): the final_answer items joined in arrival order; with phases
 * but no final_answer (commentary only), null; with no phase at all (legacy
 * models), the last agentMessage item alone. Commentary is never part of the
 * reply, and the items are never all concatenated.
 */
function codexTurnReply(messages: readonly CodexAgentMessage[]): string | null {
  const finalAnswers = messages.filter((message) => message.phase === "final_answer");
  if (finalAnswers.length > 0) {
    return finalAnswers.map((message) => message.text).join("\n\n");
  }
  if (messages.some((message) => message.phase !== null)) return null;
  return messages.at(-1)?.text ?? "";
}

/**
 * Provider-neutral wrapper around one persistent `codex app-server` child
 * process. Construct via CodexSessionDriver.create(); do not call the
 * constructor directly because it does not wait for thread/start or
 * thread/resume to complete.
 */
export class CodexSessionDriver implements ProviderSession {
  private readonly child: ChildProcess;
  private readonly eventQueue: SessionEvent[] = [];
  private readonly eventResolvers: Array<(value: IteratorResult<SessionEvent>) => void> = [];
  private readonly pendingRpcRequests = new Map<number, PendingRpcRequest>();
  private readonly localTurnIds = new Map<string, string>();
  private readonly tokenUsageByTurnId = new Map<string, TokenUsage>();
  private done = false;
  private exitHandled = false;
  private childClosed = false;
  private sessionExitEmitted = false;
  private readonly stderrBuffer: string[] = [];
  private stderrBufferBytes = 0;
  private _providerSessionId = "";
  private _pid = 0;
  private nextRequestId = 1;
  private currentTurnId: string | null = null;
  private currentCodexTurnId: string | null = null;
  // The current turn's agentMessage items by itemId, in arrival order.
  private turnAgentMessages = new Map<string, CodexAgentMessage>();
  private protocolError: string | null = null;
  private requestedEffort: string | undefined;
  private readyResolve: ((sessionId: string) => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readonly readyPromise: Promise<string>;

  private constructor(child: ChildProcess) {
    this.child = child;
    this._pid = child.pid ?? 0;
    this.readyPromise = new Promise<string>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // A failed initialize rejects this before anyone awaits it; create()
    // already reports that error, so it must not surface as unhandled.
    this.readyPromise.catch(() => undefined);
    this.attachStdout();
    this.attachStderr();
    this.attachExitHandlers();
  }

  public get provider_session_id(): string {
    return this._providerSessionId;
  }

  public get pid(): number {
    return this._pid;
  }

  /** True once the session can no longer accept turns (process exit, protocol failure or thread closed). */
  public get exited(): boolean {
    return this.done;
  }

  /**
   * Spawns (or resumes, when request.provider_session_id is set) a Codex
   * app-server session and resolves once the thread response has supplied its
   * provider session ID.
   */
  public static async create(
    request: ProviderSessionRequest,
    executablePath: string,
  ): Promise<CodexSessionDriver> {
    let child: ChildProcess;
    try {
      child = spawn(executablePath, [
        ...buildAgentPermissionArgs("advisor", "codex", {
          owlRoot: request.env.OWL_ROOT ?? process.env.OWL_ROOT ?? process.cwd(),
          env: request.env,
        }),
        ...buildCodexCustomProviderArgs(request.env),
        "app-server",
      ], {
        cwd: request.cwd,
        env: { ...request.env, ...agentUserInstructionEnv("codex", request.env) },
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      }) as unknown as ChildProcess;
    } catch (cause) {
      throw new Error(formatProviderError("codex", cause));
    }

    const driver = new CodexSessionDriver(child);
    driver.requestedEffort = request.effort;
    try {
      await driver.initialize(request);
      return driver;
    } catch (cause) {
      // A resume the app-server cannot apply stays recognisable so the
      // Advisor runtime can fall back to a fresh session.
      const error = cause instanceof ProviderResumeUnsupportedError ? cause : new Error(formatProviderError("codex", cause));
      driver.rejectReady(error);
      await driver.stop("initialization_failed", 100);
      throw error;
    }
  }

  public async send(turn: {
    turn_id: string;
    text: string;
    attachment_paths?: readonly string[];
  }): Promise<void> {
    if (this.protocolError !== null) {
      throw new Error(this.protocolError);
    }
    if (this.done) {
      throw new Error(this.protocolError ?? "codex advisor session process has already exited; cannot send a turn");
    }
    this.currentTurnId = turn.turn_id;
    this.currentCodexTurnId = null;
    this.turnAgentMessages = new Map();
    const text =
      turn.attachment_paths && turn.attachment_paths.length > 0
        ? `${turn.text}\n\n[Attachments]\n${turn.attachment_paths.join("\n")}`
        : turn.text;

    let result: unknown;
    try {
      result = await this.sendRpcRequest("turn/start", {
        threadId: this._providerSessionId,
        input: [{ type: "text", text }],
        ...(this.requestedEffort ? { effort: this.requestedEffort } : {}),
      });
    } catch (cause) {
      if (this.currentTurnId === turn.turn_id) {
        this.currentTurnId = null;
        this.currentCodexTurnId = null;
        this.turnAgentMessages = new Map();
      }
      throw cause;
    }

    const codexTurnId = turnIdFromResult(result);
    if (!codexTurnId) {
      if (this.currentTurnId === turn.turn_id) {
        this.currentTurnId = null;
        this.currentCodexTurnId = null;
        this.turnAgentMessages = new Map();
      }
      throw new Error(formatProviderError("codex", "invalid provider response"));
    }

    // A well-behaved app-server responds before turn notifications arrive.
    // Keep the fallback in localTurnIdForNotification() as well so an early
    // delta/completion cannot be lost if a server emits it first.
    if (this.currentTurnId === turn.turn_id) {
      this.currentCodexTurnId = codexTurnId;
      this.localTurnIds.set(codexTurnId, turn.turn_id);
    }
  }

  public events(): AsyncIterable<SessionEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
        return {
          next(): Promise<IteratorResult<SessionEvent>> {
            const queued = self.eventQueue.shift();
            if (queued !== undefined) {
              return Promise.resolve({ value: queued, done: false });
            }
            if (self.done) {
              return Promise.resolve({ value: undefined as unknown as SessionEvent, done: true });
            }
            return new Promise<IteratorResult<SessionEvent>>((resolve) => {
              self.eventResolvers.push(resolve);
            });
          },
        };
      },
    };
  }

  public async stop(reason: string, graceMs: number = DEFAULT_STOP_GRACE_MS): Promise<void> {
    // Keyed on the child actually having closed, not on exitHandled: a
    // protocol failure or thread/closed marks the session done while the
    // app-server process may still be alive, and stop() must still reap it.
    if (this.childClosed) {
      return;
    }
    this.appendStderr(`\n[codex-session-driver] stop requested: ${reason}\n`);
    signalProcessGroup(this.child, "SIGTERM");
    await new Promise<void>((resolve) => {
      if (this.childClosed) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signalProcessGroup(this.child, "SIGKILL");
      }, graceMs);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  public terminateImmediately(): void {
    if (this.childClosed) return;
    this.appendStderr("\n[codex-session-driver] immediate termination requested\n");
    signalProcessGroup(this.child, "SIGKILL");
  }

  private async initialize(request: ProviderSessionRequest): Promise<void> {
    // The app-server rejects every request with -32600 "Not initialized"
    // until the client has sent the `initialize` request and then the
    // `initialized` notification (verified against codex-cli 0.155.1).
    await this.sendRpcRequest("initialize", {
      clientInfo: { name: "owl", title: "Owl", version: owlClientVersion() },
    });
    await this.sendRpcNotification("initialized", {});

    const threadParams = {
      model: request.model,
      cwd: request.cwd,
      sandbox: "danger-full-access",
      developerInstructions: request.system_prompt,
    };
    let result: unknown;
    if (request.provider_session_id) {
      // codex-cli 0.155.1 ThreadResumeParams accepts `sandbox` and
      // `developerInstructions` as per-resume overrides. An app-server that
      // rejects them with invalid-params cannot apply the current system
      // prompt to the old thread; resuming without it would run a stale
      // prompt, so the caller starts a new session instead.
      try {
        result = await this.sendRpcRequest("thread/resume", {
          threadId: request.provider_session_id,
          ...threadParams,
        });
      } catch (cause) {
        if (cause instanceof CodexRpcError && cause.code === JSON_RPC_INVALID_PARAMS) {
          throw new ProviderResumeUnsupportedError("codex", cause.message);
        }
        throw cause;
      }
    } else {
      result = await this.sendRpcRequest("thread/start", threadParams);
    }
    const threadId = threadIdFromResult(result);
    if (!threadId) {
      throw new Error(formatProviderError("codex", "invalid provider response"));
    }
    this.pushEvent({ type: "session.ready", provider_session_id: threadId, pid: this._pid });
    await this.readyPromise;
  }

  private attachStdout(): void {
    if (!this.child.stdout) {
      return;
    }
    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line: string) => {
      if (line.trim().length === 0) {
        return;
      }
      this.decodeLine(line);
    });
  }

  private attachStderr(): void {
    if (!this.child.stderr) {
      return;
    }
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.appendStderr(chunk.toString("utf8"));
    });
  }

  private appendStderr(text: string): void {
    this.stderrBuffer.push(text);
    this.stderrBufferBytes += Buffer.byteLength(text, "utf8");
    while (this.stderrBufferBytes > STDERR_RING_BUFFER_BYTES && this.stderrBuffer.length > 0) {
      const removed = this.stderrBuffer.shift();
      if (removed !== undefined) {
        this.stderrBufferBytes -= Buffer.byteLength(removed, "utf8");
      }
    }
  }

  private attachExitHandlers(): void {
    this.child.on("error", (cause: Error) => {
      if (this.child.pid === undefined) {
        // Spawn failure: there is no process to wait for.
        this.childClosed = true;
      }
      this.handleExit(null, null, cause);
    });
    this.child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      this.childClosed = true;
      this.handleExit(code, signal, null);
    });
  }

  private handleExit(exitCode: number | null, signal: string | null, spawnError: Error | null): void {
    if (this.exitHandled) {
      return;
    }
    this.exitHandled = true;
    const stderrTail = this.stderrBuffer.join("").slice(-STDERR_RING_BUFFER_BYTES);
    const unexpected = spawnError !== null || exitCode !== 0 || signal !== null;
    const detail = unexpected
      ? formatProviderError("codex", spawnError ?? "process exited", {
          exitCode,
          signal,
          stderr: stderrTail,
        })
      : "CodexのAdvisorセッションプロセスが終了しました。";

    if (this.readyReject && this._providerSessionId === "") {
      this.readyReject(new Error(`CodexのAdvisorセッションを開始できませんでした。${detail}`));
    }
    this.readyResolve = null;
    this.readyReject = null;

    const exitError = new Error(`CodexのAdvisorセッションプロセスが終了しました。${detail}`);
    for (const pending of this.pendingRpcRequests.values()) {
      pending.reject(exitError);
    }
    this.pendingRpcRequests.clear();

    if (!this.sessionExitEmitted) {
      this.sessionExitEmitted = true;
      this.pushEvent({
        type: "session.exited",
        exit_code: exitCode,
        signal,
        stderr_tail: detail,
      });
    }

    if (this.currentTurnId) {
      this.pushEvent({
        type: "turn.failed",
        turn_id: this.currentTurnId,
        error: detail,
      });
      this.clearCurrentTurn();
    }

    this.done = true;
    this.finishEventResolvers();
  }

  private rejectReady(error: Error): void {
    if (this.readyReject) {
      this.readyReject(error);
      this.readyResolve = null;
      this.readyReject = null;
    }
  }

  private finishEventResolvers(): void {
    while (this.eventResolvers.length > 0) {
      const resolver = this.eventResolvers.shift();
      if (resolver) {
        resolver({ value: undefined as unknown as SessionEvent, done: true });
      }
    }
  }

  private pushEvent(event: SessionEvent): void {
    if (this.done && event.type !== "session.exited") {
      return;
    }
    if (event.type === "session.ready") {
      this._providerSessionId = event.provider_session_id;
      this._pid = event.pid;
      if (this.readyResolve) {
        this.readyResolve(event.provider_session_id);
        this.readyResolve = null;
        this.readyReject = null;
      }
    }
    const resolver = this.eventResolvers.shift();
    if (resolver) {
      resolver({ value: event, done: false });
    } else {
      this.eventQueue.push(event);
    }
  }

  private writeLine(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.child.stdin) {
        reject(new Error("codex advisor session process has no writable stdin"));
        return;
      }
      this.child.stdin.write(`${line}\n`, (error) => {
        if (error) {
          reject(new Error(formatProviderError("codex", error)));
        } else {
          resolve();
        }
      });
    });
  }

  private sendRpcRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.done) {
      return Promise.reject(new Error(formatProviderError("codex", "advisor session process has already exited")));
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<unknown>((resolve, reject) => {
      this.pendingRpcRequests.set(id, { method, resolve, reject });
      void this.writeLine(JSON.stringify(payload)).catch((cause: unknown) => {
        if (this.pendingRpcRequests.delete(id)) {
          reject(cause);
        }
      });
    });
  }

  /** Writes a JSON-RPC notification (no id, no response expected). */
  private sendRpcNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.done) {
      return Promise.reject(new Error(formatProviderError("codex", "advisor session process has already exited")));
    }
    return this.writeLine(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /**
   * Answers a server-initiated JSON-RPC request. The app-server waits for the
   * response, so every request gets one: approvals are accepted (see
   * APPROVAL_ACCEPT_DECISIONS) and anything else is declined as unsupported.
   */
  private handleServerRequest(id: string | number, method: string): void {
    if (this.done) {
      return;
    }
    const decision = APPROVAL_ACCEPT_DECISIONS[method];
    const response = decision !== undefined
      ? { jsonrpc: "2.0", id, result: { decision } }
      : {
          jsonrpc: "2.0",
          id,
          error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `${method.slice(0, 120)} is unsupported by owl` },
        };
    void this.writeLine(JSON.stringify(response)).catch((cause: unknown) => {
      this.appendStderr(`\n[codex-session-driver] could not answer server request ${method.slice(0, 120)}: ${String(cause)}\n`);
    });
  }

  private handleRpcResponse(record: JsonRpcResponse): void {
    if (typeof record.id !== "number" || !Number.isInteger(record.id)) {
      this.handleProtocolError();
      return;
    }
    const pending = this.pendingRpcRequests.get(record.id);
    if (!pending) {
      this.handleProtocolError();
      return;
    }
    this.pendingRpcRequests.delete(record.id);
    if (record.error !== undefined) {
      const error = isRecord(record.error) ? (record.error as JsonRpcError) : null;
      const code = typeof error?.code === "number" && Number.isInteger(error.code) ? error.code : null;
      pending.reject(new CodexRpcError(`Codexの${pending.method}に失敗しました。${formatError(record.error)}`, code));
      return;
    }
    pending.resolve(record.result);
  }

  private decodeLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.handleProtocolError();
      return;
    }
    if (!isRecord(parsed)) {
      this.handleProtocolError();
      return;
    }

    if ("id" in parsed && ("result" in parsed || "error" in parsed)) {
      this.handleRpcResponse(parsed as JsonRpcResponse);
      return;
    }

    if (typeof parsed.method !== "string") {
      this.handleProtocolError();
      return;
    }
    if ("id" in parsed) {
      // A message with both `id` and `method` is a server-initiated request.
      const id = parsed.id;
      if (typeof id !== "string" && !(typeof id === "number" && Number.isInteger(id))) {
        this.handleProtocolError();
        return;
      }
      this.handleServerRequest(id, parsed.method);
      return;
    }
    this.handleNotification(parsed.method, parsed.params);
  }

  private handleNotification(method: string, params: unknown): void {
    const requiresParams = method === "item/agentMessage/delta"
      || method === "item/completed"
      || method === "turn/completed"
      || method === "thread/tokenUsage/updated";
    if (requiresParams && !isRecord(params)) {
      this.handleProtocolError();
      return;
    }
    const paramsRecord = isRecord(params) ? params : null;
    const threadId = getString(paramsRecord?.threadId);
    if (threadId && this._providerSessionId && threadId !== this._providerSessionId) {
      return;
    }

    switch (method) {
      case "item/agentMessage/delta":
        this.handleAgentMessageDelta(params as Record<string, unknown>);
        return;
      case "item/completed":
        this.handleItemCompleted(params as Record<string, unknown>);
        return;
      case "turn/completed":
        this.handleTurnCompleted(params as Record<string, unknown>);
        return;
      case "thread/tokenUsage/updated":
        this.handleTokenUsageUpdated(params as Record<string, unknown>);
        return;
      case "thread/compacted":
        if (params !== undefined && !isRecord(params)) {
          this.handleProtocolError();
          return;
        }
        this.pushEvent({
          type: "session.compacted",
          cause: "auto",
          pre_tokens: null,
          summary: null,
          transcript_path: null,
        });
        return;
      case "thread/closed":
        this.handleThreadClosed();
        return;
      default:
        return;
    }
  }

  private handleAgentMessageDelta(params: Record<string, unknown>): void {
    const codexTurnId = getString(params.turnId);
    const itemId = getString(params.itemId);
    const delta = typeof params.delta === "string" ? params.delta : null;
    if (!codexTurnId || !itemId || delta === null) {
      this.handleProtocolError();
      return;
    }
    const localTurnId = this.localTurnIdForNotification(codexTurnId);
    if (!localTurnId) {
      this.handleProtocolError();
      return;
    }
    if (localTurnId === this.currentTurnId) {
      const message = this.turnAgentMessages.get(itemId)
        ?? { itemId, text: "", phase: null, settled: false };
      // Once item/completed or turn.items settled the text, a late delta is
      // already part of it.
      if (!message.settled) message.text += delta;
      this.turnAgentMessages.set(itemId, message);
    }
    // Streamed to the UI as it arrives; the phase is not known yet, so
    // commentary streams too. The reply is chosen at turn/completed.
    this.pushEvent({ type: "turn.delta", turn_id: localTurnId, text: delta });
  }

  private handleItemCompleted(params: Record<string, unknown>): void {
    if (!isRecord(params.item)) {
      this.handleProtocolError();
      return;
    }
    if (params.item.type !== "agentMessage") return;
    const codexTurnId = getString(params.turnId);
    if (!codexTurnId) {
      this.handleProtocolError();
      return;
    }
    const localTurnId = this.localTurnIdForNotification(codexTurnId);
    if (!localTurnId || localTurnId !== this.currentTurnId) return;
    if (!settleAgentMessage(this.turnAgentMessages, params.item)) {
      this.handleProtocolError();
    }
  }

  private handleTurnCompleted(params: Record<string, unknown>): void {
    if (!isRecord(params.turn)) {
      this.handleProtocolError();
      return;
    }
    const turn = params.turn as CodexTurn;
    const codexTurnId = getString(turn.id);
    const status = getString(turn.status);
    if (!codexTurnId || !status) {
      this.handleProtocolError();
      return;
    }
    const localTurnId = this.localTurnIdForNotification(codexTurnId);
    if (!localTurnId) {
      this.handleProtocolError();
      return;
    }

    if (status === "completed") {
      // turn/completed may carry an unloaded or summarized item list
      // (Turn.itemsView): the items it does carry settle their text, and the
      // agentMessage items streamed for this turn stay as they are. A turn
      // that is no longer the current one has only its items.
      const messages = this.currentTurnId === localTurnId
        ? this.turnAgentMessages
        : new Map<string, CodexAgentMessage>();
      const items = Array.isArray(turn.items) ? turn.items : [];
      for (const item of items) {
        if (!isRecord(item) || item.type !== "agentMessage") continue;
        if (!settleAgentMessage(messages, item)) {
          this.handleProtocolError();
          return;
        }
      }
      const reply = codexTurnReply([...messages.values()]);
      if (reply === null) {
        this.pushEvent({
          type: "turn.failed",
          turn_id: localTurnId,
          error: "CodexのAdvisorターンが最終回答（final_answer）を返さずに完了しました（commentaryのみ）。Provider/Harnessのバージョンとモデル設定を確認してください。",
        });
      } else if (reply.trim().length === 0) {
        this.pushEvent({
          type: "turn.failed",
          turn_id: localTurnId,
          error: formatProviderError("codex", "invalid provider response"),
        });
      } else {
        this.pushEvent({
          type: "turn.completed",
          turn_id: localTurnId,
          reply,
          usage: this.tokenUsageByTurnId.get(codexTurnId) ?? null,
        });
      }
    } else if (status === "failed") {
      this.pushEvent(codexTurnFailure(turn.error ?? "codex turn failed", localTurnId));
    } else {
      const safeStatus = status.slice(0, 80);
      this.pushEvent({
        type: "turn.failed",
        turn_id: localTurnId,
        error: `CodexのAdvisorターンが未対応の終了状態で終了しました（status=${safeStatus}）。Provider/Harnessのバージョンと出力契約を確認してください。`,
      });
    }

    this.tokenUsageByTurnId.delete(codexTurnId);
    this.localTurnIds.delete(codexTurnId);
    if (this.currentTurnId === localTurnId) {
      this.clearCurrentTurn();
    }
  }

  private handleTokenUsageUpdated(params: Record<string, unknown>): void {
    const codexTurnId = getString(params.turnId);
    if (!codexTurnId || !isRecord(params.tokenUsage) || !isRecord(params.tokenUsage.last)) {
      this.handleProtocolError();
      return;
    }
    const last = params.tokenUsage.last;
    const numericFields = [last.inputTokens, last.outputTokens, last.cachedInputTokens, last.cacheWriteInputTokens];
    if (numericFields.some((value) => value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0))) {
      this.handleProtocolError();
      return;
    }
    const usage: TokenUsage = {
      input_tokens: typeof last.inputTokens === "number" ? last.inputTokens : undefined,
      output_tokens: typeof last.outputTokens === "number" ? last.outputTokens : undefined,
      cache_read_tokens: typeof last.cachedInputTokens === "number" ? last.cachedInputTokens : undefined,
      cache_write_tokens: typeof last.cacheWriteInputTokens === "number" ? last.cacheWriteInputTokens : undefined,
    };
    this.tokenUsageByTurnId.set(codexTurnId, usage);
  }

  private handleProtocolError(): void {
    if (this.protocolError !== null) return;
    this.exitHandled = true;
    const message = formatProviderError("codex", "invalid provider protocol");
    this.protocolError = message;
    for (const pending of this.pendingRpcRequests.values()) {
      pending.reject(new Error(message));
    }
    this.pendingRpcRequests.clear();
    if (this.readyReject && this._providerSessionId === "") {
      this.readyReject(new Error(message));
      this.readyResolve = null;
      this.readyReject = null;
    }
    this.pushEvent({
      type: "session.exited",
      exit_code: null,
      signal: null,
      stderr_tail: message,
    });
    if (this.currentTurnId) {
      const turnId = this.currentTurnId;
      this.pushEvent({ type: "turn.failed", turn_id: turnId, error: message });
      this.clearCurrentTurn();
    }
    this.sessionExitEmitted = true;
    this.done = true;
    this.finishEventResolvers();
    signalProcessGroup(this.child, "SIGTERM");
  }

  private localTurnIdForNotification(codexTurnId: string): string | null {
    const mapped = this.localTurnIds.get(codexTurnId);
    if (mapped) {
      return mapped;
    }
    if (this.currentTurnId && (this.currentCodexTurnId === null || this.currentCodexTurnId === codexTurnId)) {
      return this.currentTurnId;
    }
    return null;
  }

  private handleThreadClosed(): void {
    if (this.sessionExitEmitted) {
      return;
    }
    this.exitHandled = true;
    this.sessionExitEmitted = true;
    const error = new Error("CodexのAdvisorセッションスレッドが閉じられました。");
    for (const pending of this.pendingRpcRequests.values()) {
      pending.reject(error);
    }
    this.pendingRpcRequests.clear();
    if (this.readyReject && this._providerSessionId === "") {
      this.readyReject(error);
      this.readyResolve = null;
      this.readyReject = null;
    }
    this.pushEvent({
      type: "session.exited",
      exit_code: null,
      signal: null,
      stderr_tail: "CodexのAdvisorセッションスレッドが閉じられました。",
    });
    if (this.currentTurnId) {
      this.pushEvent({
        type: "turn.failed",
        turn_id: this.currentTurnId,
        error: error.message,
      });
      this.clearCurrentTurn();
    }
    this.done = true;
    this.finishEventResolvers();
  }

  private clearCurrentTurn(): void {
    if (this.currentCodexTurnId) {
      this.localTurnIds.delete(this.currentCodexTurnId);
      this.tokenUsageByTurnId.delete(this.currentCodexTurnId);
    }
    this.currentTurnId = null;
    this.currentCodexTurnId = null;
    this.turnAgentMessages = new Map();
  }
}
