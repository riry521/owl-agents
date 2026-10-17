import { isDeepStrictEqual } from "node:util";
import { OPENCODE_RETRY_WAIT_LIMIT_MS, normalizeOpencodeToolCall, opencodePermissionRules, type AgentPermissionRole } from "@owl/shared";
import { OpencodeHttpError, type OpencodeClient, type OpencodeEvent } from "./opencode-client";
import type { OpencodePermissionResponder } from "./opencode-permission";

/** How long an interrupt may wait for serve's answer before the run goes on to stop serve. */
const INTERRUPT_TIMEOUT_MS = 5_000;

export interface OpencodeTurnError {
  readonly type: string;
  readonly message: string;
  readonly status?: number;
  /** retry-after from the error's response, as the server sent it. */
  readonly retry_after?: string | number;
  /** Epoch ms of the retry opencode scheduled when Owl stopped waiting for it. */
  readonly retry_at?: number;
}

export interface OpencodeTurnInput {
  readonly client: OpencodeClient;
  /** The session's event stream, already subscribed by the caller and shared by its turns. */
  readonly events: AsyncIterator<OpencodeEvent>;
  readonly responder: OpencodePermissionResponder;
  readonly role: AgentPermissionRole;
  readonly sessionId: string;
  readonly projectId: string;
  readonly text: string;
  readonly onDelta?: (delta: string) => void;
  /** Called with each stdout line as it is recorded. */
  readonly onRecord?: (line: string) => void;
  /** Called for every event of this session, including text deltas. */
  readonly onActivity?: (event: OpencodeEvent) => void;
  /** Abort sends an interrupt and ends the turn with `opencode_aborted`. */
  readonly signal?: AbortSignal;
  /** No event of this session for this long ends the turn with `opencode_idle_timeout`; 0 or unset means no limit. */
  readonly idleMs?: number;
  /** Longest wait for a scheduled rate-limit retry. Defaults to OPENCODE_RETRY_WAIT_LIMIT_MS. */
  readonly retryWaitLimitMs?: number;
  readonly now?: () => number;
}

export interface OpencodeTurnResult {
  /** Text of the last assistant message of the turn. */
  readonly text: string;
  readonly error: OpencodeTurnError | null;
  /** The turn's assistant messages, oldest first, as opencode returned them. */
  readonly messages: readonly unknown[];
  readonly userMessageId: string | null;
  /** stdout JSON lines; text deltas and reasoning are left out. */
  readonly records: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The retry-after value anywhere in the error's response (headers or body), without keeping the rest of it. */
function retryAfterOf(value: unknown, depth = 0): string | number | undefined {
  if (!isRecord(value) || depth > 4) return undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (key.toLowerCase().replace(/_/gu, "-") === "retry-after" && (typeof nested === "string" || typeof nested === "number")) return nested;
  }
  for (const nested of Object.values(value)) {
    const found = retryAfterOf(nested, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function toError(value: unknown): OpencodeTurnError {
  const record = isRecord(value) ? value : {};
  const retryAfter = retryAfterOf(record.response);
  return {
    type: typeof record.type === "string" ? record.type : "unknown",
    message: typeof record.message === "string" ? record.message : "",
    ...(typeof record.status === "number" && Number.isInteger(record.status) ? { status: record.status } : {}),
    ...(retryAfter !== undefined ? { retry_after: retryAfter } : {}),
  };
}

/** `at` of session.retry.scheduled as epoch ms; the value may be a number or a date string. */
function retryAtMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? null : parsed;
}

/** Checks the session before sending, sends one prompt and follows its events until the execution ends. */
export async function runOpencodeTurn(input: OpencodeTurnInput): Promise<OpencodeTurnResult> {
  const { client, responder, sessionId } = input;
  const records: string[] = [];
  const now = input.now ?? Date.now;
  const retryWaitLimitMs = input.retryWaitLimitMs ?? OPENCODE_RETRY_WAIT_LIMIT_MS;
  const record = (line: string): void => {
    records.push(line);
    input.onRecord?.(line);
  };
  const failed = (error: OpencodeTurnError, userMessageId: string | null = null): OpencodeTurnResult => ({ text: "", error, messages: [], userMessageId, records });

  const session = await client.request<{ data: { permissions?: unknown } }>("GET", `/api/session/${sessionId}`, undefined, input.signal);
  if (!isDeepStrictEqual(session.data.permissions, opencodePermissionRules(input.role))) {
    return failed({ type: "opencode_permissions_changed", message: "The session's permissions differ from Owl's rules; nothing was sent." });
  }
  const saved = await client.request<{ data: unknown[] }>("GET", "/api/permission/saved", undefined, input.signal);
  if (saved.data.some((item) => isRecord(item) && item.projectID === input.projectId)) {
    return failed({
      type: "opencode_saved_permissions",
      message: "opencode holds saved permissions for this project, which would override Owl's rules. Remove them in opencode or with DELETE /api/permission/saved/{id}.",
    });
  }

  const interrupt = async (): Promise<void> => {
    // Bounded on its own: the turn's signal is usually already aborted when an interrupt is sent.
    await client.request("POST", `/api/session/${sessionId}/interrupt`, undefined, AbortSignal.timeout(INTERRUPT_TIMEOUT_MS)).catch(() => undefined);
  };
  let userMessageId: string;
  try {
    const sent = await client.request<{ data: { id: string } }>("POST", `/api/session/${sessionId}/prompt`, { text: input.text }, input.signal);
    userMessageId = sent.data.id;
  } catch (error) {
    if (error instanceof OpencodeHttpError && error.status === 404) return failed({ type: "opencode_session_not_found", message: error.body });
    if (error instanceof OpencodeHttpError && error.status === 409) return failed({ type: "opencode_session_busy", message: error.body });
    // A stop during the send may land after serve started the execution.
    if (input.signal?.aborted) await interrupt();
    throw error;
  }

  let abandon!: (error: OpencodeTurnError) => void;
  const abandoned = new Promise<{ abandoned: OpencodeTurnError }>((resolve) => {
    abandon = (error) => resolve({ abandoned: error });
  });
  const pending: Promise<void>[] = [];
  let modelError: OpencodeTurnError | null = null;
  let replyFailure: OpencodeTurnError | null = null;
  // The idle limit counts from the last event; a scheduled retry pushes it out to the retry time.
  let idleDeadline = Number.POSITIVE_INFINITY;
  const armIdle = (until = now()): void => {
    if (input.idleMs && input.idleMs > 0) idleDeadline = until + input.idleMs;
  };

  const handleEvent = async (event: OpencodeEvent): Promise<"continue" | "done" | OpencodeTurnError> => {
    const { data, type } = event;
    if (data.sessionID !== sessionId) return "continue";
    armIdle();
    input.onActivity?.(event);
    if (type !== "session.text.delta" && !type.startsWith("session.reasoning.")) record(JSON.stringify({ type: "opencode.event", event }));
    const callId = typeof data.id === "string" ? data.id : "";
    if (type.startsWith("session.form.")) return { type: "opencode_unsupported_request", message: `opencode asked for input (${type}), which Owl cannot answer.` };
    switch (type) {
      case "session.text.delta":
        if (typeof data.delta === "string") input.onDelta?.(data.delta);
        return "continue";
      case "session.tool.input.started":
        if (typeof data.name === "string") responder.noteTool(callId, { name: data.name });
        return "continue";
      case "session.tool.called":
        if (isRecord(data.input)) responder.noteTool(callId, { input: data.input });
        return "continue";
      case "permission.asked":
        pending.push(responder.handleAsked(data, input.signal).catch((error: unknown) => {
          replyFailure = { type: "opencode_permission_reply_failed", message: error instanceof Error ? error.message : String(error) };
          abandon(replyFailure);
        }));
        return "continue";
      case "permission.replied":
        // Real opencode names the request `requestID`; `id` is the event's own id field and is absent here. Reading
        // `id` made every reply Owl itself sent look foreign, and a fallback to `id` would only hide a rename.
        return responder.wasSent(String(data.requestID)) ? "continue" : { type: "opencode_unexpected_permission_reply", message: "opencode reported a permission reply Owl did not send." };
      case "session.tool.success": {
        const name = responder.toolName(callId);
        if (name === undefined) return { type: "opencode_permission_bypass", message: "A tool succeeded whose name Owl never saw, so its permission cannot be checked." };
        if (normalizeOpencodeToolCall(name, {}, "").hooked && !responder.wasAnsweredOnce(callId)) {
          return { type: "opencode_permission_bypass", message: `The ${name} tool ran without a once reply from Owl.` };
        }
        return "continue";
      }
      case "session.retry.scheduled": {
        const error = toError(data.error);
        const at = retryAtMs(data.at);
        if (at === null) return "continue";
        // Only this wait limit and the wall timeout stop retries; attempt is in the recorded event and never counted.
        if ((error.type === "provider.rate-limit" || error.status === 429) && at - now() > retryWaitLimitMs) {
          return { ...error, retry_at: at };
        }
        armIdle(at);
        return "continue";
      }
      case "session.step.failed":
        modelError = toError(data.error);
        return "continue";
      case "session.execution.failed":
        modelError = toError(data.error);
        return "done";
      case "session.execution.succeeded":
      case "session.execution.interrupted":
        return "done";
      default:
        return "continue";
    }
  };

  const onAbort = (): void => abandon({ type: "opencode_aborted", message: "Owl stopped the turn." });
  if (input.signal?.aborted) onAbort();
  else input.signal?.addEventListener("abort", onAbort, { once: true });
  armIdle();
  try {
    return await followTurn();
  } catch (error) {
    // A request cut short by a stop still interrupts the execution before the caller stops serve.
    if (input.signal?.aborted) await interrupt();
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
  }

  async function followTurn(): Promise<OpencodeTurnResult> {
    while (true) {
      let idleTimer: NodeJS.Timeout | undefined;
      const idle = new Promise<{ abandoned: OpencodeTurnError }>((resolve) => {
        if (idleDeadline === Number.POSITIVE_INFINITY) return;
        idleTimer = setTimeout(() => resolve({ abandoned: { type: "opencode_idle_timeout", message: "opencode sent no event within the idle limit." } }), Math.max(0, idleDeadline - now()));
      });
      // A stream that fails is a stream that ended: serve died or the connection broke.
      const nextEvent = input.events.next().catch(() => ({ done: true as const, value: undefined }));
      const next = await Promise.race([nextEvent, abandoned, idle]).finally(() => clearTimeout(idleTimer));
      if ("abandoned" in next) {
        await interrupt();
        return failed(next.abandoned, userMessageId);
      }
      if (next.done) {
        await interrupt();
        return failed({ type: "opencode_events_closed", message: "The opencode event stream ended before the turn did." }, userMessageId);
      }
      const outcome = await handleEvent(next.value);
      if (outcome === "done") break;
      if (outcome !== "continue") {
        await interrupt();
        return failed(outcome, userMessageId);
      }
    }
    // Replies still in flight when the execution ended; a stop or a failed reply ends the wait.
    const settled = await Promise.race([Promise.all(pending), abandoned]);
    if ("abandoned" in settled) {
      await interrupt();
      return failed(settled.abandoned, userMessageId);
    }
    if (replyFailure) {
      await interrupt();
      return failed(replyFailure, userMessageId);
    }

    // The list is newest first; read pages until this turn's user message or the end of the list.
    const listed: { id: string; type: string; content?: unknown }[] = [];
    let cursor: string | undefined;
    for (;;) {
      const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
      const page = await client.request<{ data: { id: string; type: string; content?: unknown }[]; cursor?: { next?: string } }>("GET", `/api/session/${sessionId}/message${query}`, undefined, input.signal);
      const newest = page.data.findIndex((message) => message.id === userMessageId);
      listed.push(...(newest < 0 ? page.data : page.data.slice(0, newest)));
      cursor = page.cursor?.next;
      if (newest >= 0 || page.data.length === 0 || !cursor) break;
    }
    const messages = listed.filter((message) => message.type === "assistant").reverse();
    const last = messages.at(-1);
    const text = Array.isArray(last?.content)
      ? last.content.filter((part): part is { type: string; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
      : "";
    return { text, error: modelError, messages, userMessageId, records };
  }
}
