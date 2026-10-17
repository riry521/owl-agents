import { normalizeOpencodeToolCall, tokenUsageOf } from "@owl/shared";
import type { HarnessFailureDetail } from "./protocol";
import type { RateLimitResetInput } from "./rate-limit";
import type { TokenUsage } from "./types";

/** The error opencode reported for the turn, as kept in the `opencode.result` stdout line. `retry_after` is lifted out of the response so headers never reach stdout. */
export interface OpencodeResultError {
  readonly type: string;
  readonly message: string;
  readonly status?: number;
  readonly retry_after?: string | number;
  /** Epoch ms of the retry opencode had scheduled when Owl gave up waiting. */
  readonly retry_at?: number;
}

export interface OpencodeResult {
  readonly session_id: string;
  readonly messages: readonly Record<string, unknown>[];
  readonly error: OpencodeResultError | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLine(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The last `opencode.result` line of the stdout; null when there is none. */
export function parseOpencodeResult(stdout: string): OpencodeResult | null {
  let found: Record<string, unknown> | null = null;
  for (const raw of stdout.split(/\r?\n/u)) {
    const line = parseLine(raw.trim());
    if (line?.type === "opencode.result") found = line;
  }
  if (found === null) return null;
  const error = isRecord(found.error) && typeof found.error.type === "string"
    ? {
      type: found.error.type,
      message: typeof found.error.message === "string" ? found.error.message : "",
      ...(typeof found.error.status === "number" && Number.isInteger(found.error.status) ? { status: found.error.status } : {}),
      ...(typeof found.error.retry_after === "string" || typeof found.error.retry_after === "number" ? { retry_after: found.error.retry_after } : {}),
      ...(typeof found.error.retry_at === "number" ? { retry_at: found.error.retry_at } : {}),
    }
    : null;
  return {
    session_id: typeof found.session_id === "string" ? found.session_id : "",
    messages: Array.isArray(found.messages) ? found.messages.filter(isRecord) : [],
    error,
  };
}

export function opencodeSessionId(stdout: string): string | undefined {
  const id = parseOpencodeResult(stdout)?.session_id;
  return id ? id : undefined;
}

export function messageText(message: Record<string, unknown> | undefined): string {
  return Array.isArray(message?.content)
    ? message.content.filter((part): part is { type: string; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
    : "";
}

/** Text of the turn's last assistant message, or null when the stdout holds no result line. */
export function unwrapOpencodeResult(stdout: string): string | null {
  const result = parseOpencodeResult(stdout);
  return result === null ? null : messageText(result.messages.at(-1));
}

function messageTokens(message: Record<string, unknown>): { input: number; output: number; reasoning: number; read: number; write: number } | null {
  if (!isRecord(message.tokens)) return null;
  const tokens = message.tokens;
  const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  return { input: count(tokens.input), output: count(tokens.output), reasoning: count(tokens.reasoning), read: count(cache.read), write: count(cache.write) };
}

/** Usage summed over the turn's assistant messages (design 2.3); null when none reports tokens. */
export function opencodeTokenUsage(stdout: string): TokenUsage | null {
  const result = parseOpencodeResult(stdout);
  return result === null ? null : opencodeMessagesUsage(result.messages);
}

/** Usage summed over assistant messages as `runOpencodeTurn` returns them. */
export function opencodeMessagesUsage(messages: readonly unknown[]): TokenUsage | null {
  let reported = false;
  let input = 0;
  let output = 0;
  let read = 0;
  let write = 0;
  for (const message of messages) {
    const tokens = isRecord(message) ? messageTokens(message) : null;
    if (tokens === null) continue;
    reported = true;
    input += tokens.input;
    output += tokens.output + tokens.reasoning;
    read += tokens.read;
    write += tokens.write;
  }
  return reported ? tokenUsageOf({ input_tokens: input, output_tokens: output, cache_read_tokens: read, cache_write_tokens: write }) : null;
}

/** Context size after the turn: input plus cache of the last assistant message. */
export function opencodeContextTokens(stdout: string): number | null {
  return opencodeMessagesContextTokens(parseOpencodeResult(stdout)?.messages ?? []);
}

export function opencodeMessagesContextTokens(messages: readonly unknown[]): number | null {
  const last = messages.at(-1);
  const tokens = isRecord(last) ? messageTokens(last) : null;
  return tokens === null ? null : tokens.input + tokens.read + tokens.write;
}

const NON_TRANSIENT_TYPES = new Set(["context-overflow", "payload-too-large"]);
const DEFAULT_STATUS_NON_TRANSIENT = new Set(["provider.invalid-request", "provider.content-filter", "provider.unsupported-operation", "provider.no-route", "provider.unknown"]);

/** Maps the turn's error to what the classifier reads (design 2.5). */
export function opencodeFailureDetail(error: OpencodeResultError): HarnessFailureDetail {
  const base = { harness_code: error.type, error: error.message };
  const status = error.status;
  const type = error.type;
  if (type === "provider.rate-limit") {
    const evidence: RateLimitResetInput[] = [];
    // The scheduled time goes first: within one kind the later evidence wins, and the server's retry-after is the better one.
    if (error.retry_at !== undefined) evidence.push({ kind: "retry_after", value: new Date(error.retry_at).toUTCString() });
    if (error.retry_after !== undefined) evidence.push({ kind: "retry_after", value: error.retry_after });
    return { ...base, harness_status: status ?? 429, ...(evidence.length > 0 ? { rate_limit_evidence: evidence } : {}) };
  }
  if (type === "provider.quota") return { ...base, harness_status: status ?? 429 };
  if (type === "provider.auth") return { ...base, harness_status: 401 };
  if (NON_TRANSIENT_TYPES.has(type)) return { ...base, harness_transient: false };
  if (DEFAULT_STATUS_NON_TRANSIENT.has(type)) return { ...base, harness_status: status ?? 400, harness_transient: false };
  if (type === "provider.timeout" || type === "provider.transport") return { ...base, harness_transient: true };
  if (type === "provider.internal" || type === "provider.invalid-output") return { ...base, ...(status !== undefined ? { harness_status: status } : {}) };
  if (type === "aborted") return { ...base, harness_transient: false };
  return { ...base, ...(status !== undefined ? { harness_status: status } : {}) };
}

/** Normalized names of the tools a stdout line starts calling (`Bash`, `mcp__server__tool`, ...). */
export function opencodeToolNames(event: Record<string, unknown>): string[] {
  if (event.type !== "opencode.event" || !isRecord(event.event)) return [];
  const inner = event.event;
  if (inner.type !== "session.tool.input.started" || !isRecord(inner.data) || typeof inner.data.name !== "string") return [];
  return [normalizeOpencodeToolCall(inner.data.name, {}, "").tool_name];
}
