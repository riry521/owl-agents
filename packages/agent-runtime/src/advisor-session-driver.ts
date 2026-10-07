// AdvisorSessionDriver: manages a long-running `claude -p --input-format
// stream-json --output-format stream-json` child process for the persistent
// Advisor session provider driver.
//
// Responsibilities:
//   - spawn the child process and surface its session.ready event
//   - encode outgoing turns as stream-json lines on stdin
//   - decode incoming stream-json lines on stdout into provider-neutral
//     SessionEvent values
//   - keep a bounded ring buffer of stderr for diagnostics
//   - expose stop() that owns SIGTERM -> grace -> SIGKILL for its own pid only
//
// This driver only understands the Claude CLI wire format. Codex support is
// a separate harness that will live in its own driver behind the same
// ProviderSession contract.

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  ProviderSession,
  ProviderSessionRequest,
  SessionEvent,
  TokenUsage,
} from "./types.js";
import { readClaudeCompactionSummaries, waitForCompactionSummary } from "./compaction-summary.js";
import { classifyProviderFailure, formatProviderError } from "./provider-error.js";
import { claudeRateLimitEvidence } from "./rate-limit.js";
import { buildAgentPermissionArgs, extractWebResearchCapture, reapProcessGroup, type WebResearchTool } from "@owl/shared";

const STDERR_RING_BUFFER_BYTES = 8 * 1024;
const DEFAULT_STOP_GRACE_MS = 5000;
const MAX_PENDING_WEB_TOOLS = 64;

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    // A detached group may already have exited. Fall back to the direct child
    // so stop() still works on platforms without negative-PID process groups.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      try { child.kill(signal); } catch { /* already gone */ }
    }
  }
}

interface ClaudeStreamMessageContentPart {
  readonly type?: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly tool_use_id?: string;
  readonly content?: unknown;
  readonly is_error?: unknown;
}

interface ClaudeStreamMessage {
  readonly role?: string;
  readonly content?: readonly ClaudeStreamMessageContentPart[];
}

interface ClaudeStreamUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

interface ClaudeCompactMetadata {
  readonly trigger?: string;
  readonly pre_tokens?: number;
}

interface ClaudeStreamLine {
  readonly type?: string;
  readonly subtype?: string;
  readonly session_id?: string;
  /** Non-null on frames emitted by a subagent rather than the main agent. */
  readonly parent_tool_use_id?: string | null;
  readonly message?: ClaudeStreamMessage;
  readonly tool_use_result?: unknown;
  readonly result?: unknown;
  readonly is_error?: unknown;
  readonly api_error_status?: unknown;
  readonly error?: unknown;
  readonly usage?: ClaudeStreamUsage;
  readonly compact_metadata?: ClaudeCompactMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatClaudeApiError(error: unknown): string {
  const record = isRecord(error) ? error : null;
  const status = typeof record?.status === "number" && Number.isInteger(record.status) ? record.status : null;
  const message = typeof record?.message === "string" ? record.message : "";
  const formatted = typeof record?.formatted === "string" ? record.formatted : "";
  return formatProviderError("claude", error, {
    status,
    stderr: `${message}\n${formatted}${record?.isNetworkDown === true ? "\nnetwork" : ""}`,
  });
}

/**
 * Informational stream-json event kinds that carry nothing the Advisor turn
 * needs. `tool_progress` is emitted every ~30s while a long tool runs
 * (Claude CLI 2.1.281); treating it as a protocol failure would kill the
 * session mid-turn.
 */
const IGNORED_STREAM_EVENT_TYPES: ReadonlySet<string> = new Set([
  "user",
  "tool",
  "tool_progress",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_start",
  "message_delta",
  "message_stop",
]);

/**
 * Unknown event kinds already reported once by this process. Stream-event
 * kinds are a versioned harness surface: a new informational kind must not
 * end a live session, but it is logged so a protocol change stays visible.
 */
const warnedUnknownStreamEventTypes = new Set<string>();

function warnUnknownStreamEventType(type: string): void {
  const safeType = type.slice(0, 80);
  if (warnedUnknownStreamEventTypes.has(safeType)) return;
  warnedUnknownStreamEventTypes.add(safeType);
  console.warn(`[advisor-session-driver] Ignoring unknown Claude stream-json event type "${safeType}".`);
}

/**
 * Claude reports API failures (network, auth, rate limit) as a `result` with
 * `subtype: "success"` and `is_error: true`, the error text in `result` and
 * the HTTP status (when known) in `api_error_status`.
 */
function resultErrorDetail(record: ClaudeStreamLine): unknown {
  if (record.error !== undefined && record.error !== null) {
    return record.error;
  }
  const status = typeof record.api_error_status === "number" && Number.isInteger(record.api_error_status)
    ? record.api_error_status
    : undefined;
  const message = typeof record.result === "string" && record.result.length > 0
    ? record.result
    : "advisor turn reported an error";
  return status === undefined ? { message } : { status, message };
}

function classifiedClaudeTurnFailure(record: ClaudeStreamLine, turnId: string, lastRateLimitEvent: unknown): SessionEvent {
  const detail = resultErrorDetail(record);
  const detailRecord = isRecord(detail) ? detail : null;
  const message = typeof record.result === "string" && record.result.length > 0
    ? record.result
    : typeof detailRecord?.message === "string"
      ? detailRecord.message
      : typeof detail === "string" ? detail : "advisor turn reported an error";
  const status = typeof record.api_error_status === "number" && Number.isInteger(record.api_error_status)
    ? record.api_error_status
    : typeof detailRecord?.status === "number" && Number.isInteger(detailRecord.status)
      ? detailRecord.status
      : undefined;
  const code = typeof detailRecord?.type === "string" ? detailRecord.type : undefined;
  const classification = classifyProviderFailure("claude", {
    exit_code: 0,
    signal: null,
    kind: "harness_error",
    ...(status !== undefined ? { harness_status: status } : {}),
    ...(code !== undefined ? { harness_code: code } : {}),
    error: message,
    rate_limit_evidence: [
      ...(lastRateLimitEvent !== null ? [{ kind: "event" as const, event: lastRateLimitEvent }] : []),
      ...claudeRateLimitEvidence(record as unknown as Record<string, unknown>),
      { kind: "text", text: message },
    ],
  });
  return {
    type: "turn.failed",
    turn_id: turnId,
    error: classification.message,
    ...(classification.rate_limit !== undefined ? { rate_limit: classification.rate_limit } : {}),
  };
}

export function buildStartArgv(
  request: ProviderSessionRequest,
  executablePath: string,
  freshSessionId: string,
): string[] {
  const argv: string[] = [
    executablePath,
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    ...buildAgentPermissionArgs("advisor", "claude", {
      owlRoot: request.env.OWL_ROOT ?? process.env.OWL_ROOT ?? process.cwd(),
      env: request.env,
      cwd: request.cwd,
    }),
  ];
  argv.push("--session-id", freshSessionId);
  argv.push("--model", request.model);
  if (request.effort) {
    argv.push("--effort", request.effort);
  }
  argv.push("--append-system-prompt", request.system_prompt);
  return argv;
}

/**
 * Provider-neutral wrapper around one persistent `claude -p` child process.
 * Construct via AdvisorSessionDriver.create(); do not call the constructor
 * directly. The create() call returns after spawn, and the first send() causes
 * Claude to emit the init/ready frame for stream-json sessions.
 */
export class AdvisorSessionDriver implements ProviderSession {
  private readonly child: ChildProcess;
  private readonly eventQueue: SessionEvent[] = [];
  private readonly eventResolvers: Array<(value: IteratorResult<SessionEvent>) => void> = [];
  private done = false;
  private exitHandled = false;
  private childClosed = false;
  /** The group reap started when the child exited; later stop() calls wait on it instead of signalling a pid that may have been reused. */
  private groupReap: Promise<void> | null = null;
  private readonly stderrBuffer: string[] = [];
  private stderrBufferBytes = 0;
  private _providerSessionId: string;
  private _pid = 0;
  /**
   * The Owl turn in flight. While `unsolicitedActive` is set it is a turn
   * that was sent but has not started yet: Claude handles stdin messages one
   * at a time, so it begins only after the unsolicited turn's `result`.
   */
  private currentTurnId: string | null = null;
  private turnTextParts: string[] = [];
  /** True while a turn Claude started on its own (no Owl turn) is streaming. */
  private unsolicitedActive = false;
  private unsolicitedTextParts: string[] = [];
  private stopRequested = false;
  private _exitDetail: string | null = null;
  private readonly pendingWebTools = new Map<string, { readonly name: WebResearchTool; readonly input: unknown }>();
  private lastRateLimitEvent: unknown = null;
  private startupError: string | null = null;
  private turnSent = false;

  /** Where Claude keeps this session's transcript; the compaction summary is read from it. */
  private transcriptLocation: { readonly configDir: string; readonly cwd: string } | null = null;
  private compactionCount = 0;
  private pendingCompactions = 0;
  private endRequested = false;
  private readonly heldEvents: SessionEvent[] = [];

  private constructor(
    child: ChildProcess,
    providerSessionId: string,
    private readonly onUnsolicitedReply: ProviderSessionRequest["on_unsolicited_reply"],
    private readonly onStdoutLine: ProviderSessionRequest["on_stdout_line"],
    private readonly reapGraceMs?: number,
  ) {
    this.child = child;
    this._providerSessionId = providerSessionId;
    this._pid = child.pid ?? 0;
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

  /** True once the session can no longer accept turns (process exit or protocol failure). */
  public get exited(): boolean {
    return this.done;
  }

  /** Why the session became unusable (process exit or protocol failure); null while it is usable. */
  public get exit_detail(): string | null {
    return this._exitDetail;
  }

  /**
   * Spawns a Claude CLI advisor session. Claude emits its `system/init` frame only after it has
   * received the first stream-json user message, so waiting for `session.ready`
   * here would deadlock creation: the Core turn loop cannot send that first
   * message until createSession resolves. The driver queues the ready event and
   * the first turn response normally consumes it immediately after send().
   */
  public static async create(
    request: ProviderSessionRequest,
    executablePath: string,
    options: { readonly reapGraceMs?: number } = {},
  ): Promise<AdvisorSessionDriver> {
    const freshSessionId = randomUUID();
    const argv = buildStartArgv(request, executablePath, freshSessionId);
    const [executable, ...args] = argv;
    let child: ChildProcess;
    try {
      child = spawn(executable ?? "", args, {
        cwd: request.cwd,
        env: { ...request.env },
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      }) as unknown as ChildProcess;
    } catch (cause) {
      throw new Error(formatProviderError("claude", cause));
    }
    const driver = new AdvisorSessionDriver(child, freshSessionId, request.on_unsolicited_reply, request.on_stdout_line, options.reapGraceMs);
    driver.transcriptLocation = {
      configDir: request.env.CLAUDE_CONFIG_DIR || join(request.env.HOME || homedir(), ".claude"),
      cwd: request.cwd,
    };
    return driver;
  }

  public async send(turn: {
    turn_id: string;
    text: string;
    attachment_paths?: readonly string[];
  }): Promise<void> {
    if (this.done) {
      throw new Error(this.startupError ?? "advisor session process has already exited; cannot send a turn");
    }
    this.turnSent = true;
    this.pendingWebTools.clear();
    this.currentTurnId = turn.turn_id;
    this.turnTextParts = [];
    this.lastRateLimitEvent = null;
    const text =
      turn.attachment_paths && turn.attachment_paths.length > 0
        ? `${turn.text}\n\n<owl-attachments>${JSON.stringify(turn.attachment_paths)}</owl-attachments>`
        : turn.text;
    const payload = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
    };
    await this.writeLine(JSON.stringify(payload));
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
    // Keyed on the child having closed: a protocol failure marks the session
    // done before its SIGTERM has taken effect, and stop() must still reap it.
    if (this.childClosed) {
      await this.groupReap;
      return;
    }
    this.stopRequested = true;
    this.stderrBuffer.push(`\n[advisor-session-driver] stop requested: ${reason}\n`);
    signalProcessGroup(this.child, "SIGTERM");
    await new Promise<void>((resolve) => {
      if (this.childClosed) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        if (!this.childClosed) signalProcessGroup(this.child, "SIGKILL");
      }, graceMs);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  public terminateImmediately(): void {
    if (this.childClosed) return;
    this.stopRequested = true;
    this.stderrBuffer.push("\n[advisor-session-driver] immediate termination requested\n");
    signalProcessGroup(this.child, "SIGKILL");
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
      const events = this.decodeLine(line);
      for (const event of events) {
        this.pushEvent(event);
      }
    });
  }

  private attachStderr(): void {
    if (!this.child.stderr) {
      return;
    }
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrBuffer.push(text);
      this.stderrBufferBytes += Buffer.byteLength(text, "utf8");
      while (this.stderrBufferBytes > STDERR_RING_BUFFER_BYTES && this.stderrBuffer.length > 0) {
        const removed = this.stderrBuffer.shift();
        if (removed !== undefined) {
          this.stderrBufferBytes -= Buffer.byteLength(removed, "utf8");
        }
      }
    });
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
      this.groupReap = reapProcessGroup(this.child.pid, { graceMs: this.reapGraceMs });
      this.handleExit(code, signal, null);
    });
  }

  private handleExit(exitCode: number | null, signal: string | null, spawnError: Error | null): void {
    this.pendingWebTools.clear();
    if (this.exitHandled) {
      return;
    }
    this.exitHandled = true;
    const stderrTail = this.stderrBuffer.join("").slice(-STDERR_RING_BUFFER_BYTES);
    const detail = spawnError !== null || exitCode !== 0 || signal !== null
      ? formatProviderError("claude", spawnError ?? "process exited", {
          exitCode,
          signal,
          stderr: stderrTail,
        })
      : "ClaudeのAdvisorセッションプロセスが終了しました。";

    if (this.currentTurnId === null) {
      this.startupError = detail;
    }
    this.unsolicitedActive = false;
    this.unsolicitedTextParts = [];
    this.markUnusable(detail, stderrTail);

    this.pushEvent({
      type: "session.exited",
      exit_code: exitCode,
      signal,
      stderr_tail: detail,
    });

    if (this.currentTurnId) {
      this.pushEvent({
        type: "turn.failed",
        turn_id: this.currentTurnId,
        error: detail,
      });
      this.currentTurnId = null;
      this.turnTextParts = [];
    }

    this.endStream();
  }

  /** The stream carries only the boundary; the summary text is in the transcript file. */
  private async emitCompaction(cause: "auto" | "manual", preTokens: number | null, index: number): Promise<void> {
    // Later events wait until the summary is read, so turn.completed cannot overtake it.
    this.pendingCompactions += 1;
    const location = this.transcriptLocation;
    let found: { summary: string | null; path: string | null } = { summary: null, path: null };
    try {
      if (location) {
        found = await waitForCompactionSummary(
          () => readClaudeCompactionSummaries(location.configDir, location.cwd, this._providerSessionId),
          index,
        );
      }
    } finally {
      this.deliverEvent({
        type: "session.compacted",
        cause,
        pre_tokens: preTokens,
        summary: found.summary,
        transcript_path: found.path,
      });
      this.pendingCompactions -= 1;
      if (this.pendingCompactions === 0) {
        for (const held of this.heldEvents.splice(0)) this.deliverEvent(held);
        if (this.endRequested) this.endStream();
      }
    }
  }

  private pushEvent(event: SessionEvent): void {
    if (this.pendingCompactions > 0) {
      this.heldEvents.push(event);
      return;
    }
    this.deliverEvent(event);
  }

  private deliverEvent(event: SessionEvent): void {
    if (event.type === "session.ready") {
      this._providerSessionId = event.provider_session_id;
      this._pid = event.pid;
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
        reject(new Error(formatProviderError("claude", "advisor session process has no writable stdin")));
        return;
      }
      this.child.stdin.write(`${line}\n`, (error) => {
        if (error) {
          reject(new Error(formatProviderError("claude", error)));
        } else {
          resolve();
        }
      });
    });
  }

  private mapUsage(usage: ClaudeStreamUsage | undefined): TokenUsage | null {
    if (!usage) {
      return null;
    }
    return {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_input_tokens,
      cache_write_tokens: usage.cache_creation_input_tokens,
    };
  }

  /**
   * Decodes one stdout line from `claude -p --output-format stream-json`
   * into zero or more provider-neutral SessionEvents. Malformed JSON and
   * known event kinds in an impossible state become an explicit provider
   * failure and terminate the session; informational frames and unknown
   * event kinds (logged once per kind) decode to no events. Mutates turn
   * accumulation state (currentTurnId/turnTextParts) as a side effect since
   * that state is intrinsic to reconstructing a full reply from streamed
   * deltas.
   */
  private decodeLine(line: string): SessionEvent[] {
    try { this.onStdoutLine?.(line); } catch { /* telemetry must not affect the session */ }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return this.protocolFailureEvents();
    }
    if (!isRecord(parsed)) {
      return this.protocolFailureEvents();
    }
    const record = parsed as ClaudeStreamLine;

    // Subagent output (for example a background task that keeps running after
    // the turn) is never part of an Owl turn and never a protocol failure.
    if (typeof record.parent_tool_use_id === "string") {
      return [];
    }

    if (record.type === "rate_limit_event") {
      this.lastRateLimitEvent = parsed;
      return [];
    }

    if (record.type === "system" && record.subtype === "init") {
      const sessionId = typeof record.session_id === "string" && record.session_id.length > 0
        ? record.session_id
        : this._providerSessionId;
      if (sessionId.length === 0) {
        return this.protocolFailureEvents();
      }
      return [{ type: "session.ready", provider_session_id: sessionId, pid: this._pid }];
    }

    if (record.type === "system" && (record.subtype === "compact_boundary" || record.subtype === "compaction")) {
      const trigger = record.compact_metadata?.trigger;
      const cause: "auto" | "manual" = trigger === "manual" ? "manual" : "auto";
      const preTokens =
        typeof record.compact_metadata?.pre_tokens === "number" ? record.compact_metadata.pre_tokens : null;
      this.compactionCount += 1;
      void this.emitCompaction(cause, preTokens, this.compactionCount).catch((error) => console.error("[advisor-session-driver] emitCompaction failed", error));
      return [];
    }

    if (record.subtype === "api_error" || record.type === "error") {
      const turnId = this.currentTurnId;
      if (this.unsolicitedActive) {
        // An API failure inside a turn Claude started on its own has no Owl
        // turn to fail; a pending Owl turn still runs after it.
        console.warn(`[advisor-session-driver] Dropped an unsolicited turn that failed: ${formatClaudeApiError(record.error)}`);
        this.endUnsolicitedTurn();
        return [];
      }
      if (!turnId && this.turnSent) {
        // Between turns the session is still usable; only a startup failure is fatal.
        console.warn(`[advisor-session-driver] Dropped an error frame received between turns: ${formatClaudeApiError(record.error)}`);
        return [];
      }
      if (!turnId) {
        this.startupError = formatClaudeApiError(record.error);
        this.markUnusable(this.startupError, this.stderrTail());
        this.exitHandled = true;
        this.pushEvent({
          type: "session.exited",
          exit_code: null,
          signal: null,
          stderr_tail: this.startupError,
        });
        this.endStream();
        if (!this.childClosed) signalProcessGroup(this.child, "SIGTERM");
        return [];
      }
      this.currentTurnId = null;
      this.turnTextParts = [];
      const failure = classifiedClaudeTurnFailure(record, turnId, this.lastRateLimitEvent);
      this.lastRateLimitEvent = null;
      return [failure];
    }

    if (record.type === "system") {
      // e.g. thinking_tokens counters: informational only, not surfaced yet.
      return [];
    }

    if (record.type === "user") {
      try {
        const turnId = this.currentTurnId;
        if (!turnId || this.unsolicitedActive) return [];
        const content = isRecord(record.message) ? record.message.content : undefined;
        if (!Array.isArray(content)) return [];

        const toolResults = content.filter((part) => isRecord(part) && part.type === "tool_result");
        const events: SessionEvent[] = [];
        for (const part of toolResults) {
          if (!isRecord(part) || typeof part.tool_use_id !== "string") continue;
          const pending = this.pendingWebTools.get(part.tool_use_id);
          if (!pending) continue;
          this.pendingWebTools.delete(part.tool_use_id);

          const resultContent = part.content;
          const contentText = typeof resultContent === "string"
            ? resultContent
            : Array.isArray(resultContent)
              ? resultContent
                  .filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
                  .map((item) => (item as { readonly text: string }).text)
                  .join("\n")
              : "";
          let extractionError: unknown;
          const capture = extractWebResearchCapture(
            pending.name,
            pending.input,
            toolResults.length === 1 ? record.tool_use_result : undefined,
            { isError: part.is_error === true, contentText, onError: (error) => { extractionError = error; } },
          );
          if (extractionError !== undefined) {
            const message = extractionError instanceof Error ? extractionError.message : String(extractionError);
            console.warn(`[advisor-session-driver] Could not read a web research result: ${message}`, extractionError);
            events.push({ type: "tool.web_research_failed", turn_id: turnId, error: message });
            continue;
          }
          if (capture !== null) {
            events.push({ type: "tool.web_research", turn_id: turnId, capture });
          }
        }
        return events;
      } catch (error) {
        // A malformed tool result must not stop the session, but the lost web research is reported.
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[advisor-session-driver] Could not read a web research result: ${message}`, error);
        const failedTurnId = this.currentTurnId;
        return failedTurnId ? [{ type: "tool.web_research_failed", turn_id: failedTurnId, error: message }] : [];
      }
    }

    if (record.type === "assistant") {
      const content = record.message?.content ?? [];
      if (this.currentTurnId === null || this.unsolicitedActive) {
        // No Owl turn is streaming: Claude started a turn on its own.
        this.unsolicitedActive = true;
        for (const part of content) {
          if (part && part.type === "text" && typeof part.text === "string") {
            this.unsolicitedTextParts.push(part.text);
          }
        }
        return [];
      }
      const events: SessionEvent[] = [];
      for (const part of content) {
        if (
          part &&
          part.type === "tool_use" &&
          (part.name === "WebFetch" || part.name === "WebSearch") &&
          typeof part.id === "string"
        ) {
          this.pendingWebTools.set(part.id, { name: part.name, input: part.input });
          if (this.pendingWebTools.size > MAX_PENDING_WEB_TOOLS) {
            const oldest = this.pendingWebTools.keys().next().value;
            if (oldest !== undefined) this.pendingWebTools.delete(oldest);
          }
        }
        if (part && part.type === "text" && typeof part.text === "string") {
          this.turnTextParts.push(part.text);
          if (this.currentTurnId) {
            events.push({ type: "turn.delta", turn_id: this.currentTurnId, text: part.text });
          }
        }
      }
      return events;
    }

    if (record.type === "result") {
      this.pendingWebTools.clear();
      const turnId = this.currentTurnId;
      if (turnId === null || this.unsolicitedActive) {
        this.finishUnsolicitedTurn(record);
        return [];
      }
      if (record.subtype === "success" && record.is_error === true) {
        // The error text in `result` must never be posted as the reply.
        this.currentTurnId = null;
        this.turnTextParts = [];
        const failure = classifiedClaudeTurnFailure(record, turnId, this.lastRateLimitEvent);
        this.lastRateLimitEvent = null;
        return [failure];
      }
      if (record.subtype === "success") {
        // `result` is the final assistant message; the streamed turn text
        // also contains interim messages (e.g. before a tool call), so it is
        // only a fallback for CLIs that omit `result`.
        const reply = typeof record.result === "string" && record.result.trim().length > 0
          ? record.result
          : this.turnTextParts.join("");
        const usage = this.mapUsage(record.usage);
        this.currentTurnId = null;
        this.turnTextParts = [];
        this.lastRateLimitEvent = null;
        if (reply.trim().length === 0) {
          return [{ type: "turn.failed", turn_id: turnId, error: formatProviderError("claude", "invalid provider response") }];
        }
        return [{ type: "turn.completed", turn_id: turnId, reply, usage }];
      }
      const errorText = formatProviderError(
        "claude",
        record.error ?? record.result ?? `advisor turn failed: subtype=${String(record.subtype)}`,
      );
      this.currentTurnId = null;
      this.turnTextParts = [];
      this.lastRateLimitEvent = null;
      return [{ type: "turn.failed", turn_id: turnId, error: errorText }];
    }

    if (typeof record.type !== "string" || record.type.length === 0) {
      return this.protocolFailureEvents();
    }
    if (!IGNORED_STREAM_EVENT_TYPES.has(record.type)) {
      warnUnknownStreamEventType(record.type);
    }
    return [];
  }

  private stderrTail(): string {
    return this.stderrBuffer.join("").slice(-STDERR_RING_BUFFER_BYTES);
  }

  /**
   * Records why the session can no longer accept turns and logs it once. An
   * exit the driver itself asked for (stop) is expected and not logged.
   */
  private markUnusable(detail: string, stderrTail: string): void {
    if (this._exitDetail !== null) return;
    const tail = stderrTail.trim();
    this._exitDetail = tail.length > 0 && !detail.includes(tail) ? `${detail}\nstderr tail:\n${tail}` : detail;
    if (!this.stopRequested) {
      console.error(`[advisor-session-driver] Claude advisor session is unusable: ${this._exitDetail}`);
    }
  }

  /** Ends the unsolicited turn; a pending Owl turn starts streaming after it. */
  private endUnsolicitedTurn(): string {
    const text = this.unsolicitedTextParts.join("");
    this.unsolicitedActive = false;
    this.unsolicitedTextParts = [];
    this.turnTextParts = [];
    this.lastRateLimitEvent = null;
    return text;
  }

  /** Handles the `result` of a turn Claude started on its own: a successful reply is handed to the owner callback, anything else is logged and dropped. */
  private finishUnsolicitedTurn(record: ClaudeStreamLine): void {
    const text = this.endUnsolicitedTurn();
    if (record.subtype !== "success" || record.is_error === true) {
      console.warn("[advisor-session-driver] Dropped an unsolicited turn that did not succeed.");
      return;
    }
    const reply = typeof record.result === "string" && record.result.trim().length > 0 ? record.result : text;
    if (reply.trim().length === 0) {
      console.warn("[advisor-session-driver] Dropped an unsolicited turn with no text.");
      return;
    }
    if (!this.onUnsolicitedReply) return;
    try {
      this.onUnsolicitedReply({ reply, usage: this.mapUsage(record.usage) });
    } catch (error) {
      console.warn("[advisor-session-driver] The unsolicited reply handler failed.", error);
    }
  }

  private protocolFailureEvents(): SessionEvent[] {
    const error = formatProviderError("claude", "invalid provider protocol");
    this.exitHandled = true;
    this.unsolicitedActive = false;
    this.unsolicitedTextParts = [];
    this.markUnusable(error, this.stderrTail());
    if (this.currentTurnId) {
      const turnId = this.currentTurnId;
      this.currentTurnId = null;
      this.turnTextParts = [];
      this.startupError = error;
      this.pushEvent({ type: "session.exited", exit_code: null, signal: null, stderr_tail: error });
      this.pushEvent({ type: "turn.failed", turn_id: turnId, error });
      this.endStream();
      if (!this.childClosed) signalProcessGroup(this.child, "SIGTERM");
      return [];
    }
    this.startupError = error;
    this.endStream();
    if (!this.childClosed) signalProcessGroup(this.child, "SIGTERM");
    return [];
  }

  /** Ends the event stream, but only after a pending compaction summary and the events held behind it are delivered. */
  private endStream(): void {
    if (this.pendingCompactions > 0) {
      this.endRequested = true;
      return;
    }
    this.done = true;
    this.finishEventResolvers();
  }

  private finishEventResolvers(): void {
    while (this.eventResolvers.length > 0) {
      const resolver = this.eventResolvers.shift();
      if (resolver) resolver({ value: undefined as unknown as SessionEvent, done: true });
    }
  }
}
