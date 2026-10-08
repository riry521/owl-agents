import { CHILD_RUN_LIMITS } from "./child-runs.js";

/** Env var naming the per-segment state file the relay hook reads. */
export const RELAY_STATE_FILE_ENV = "OWL_RELAY_STATE_FILE";
/** Most request rows one subagent usage upload may carry, so the body stays under the 1 MiB HTTP limit. */
export const SUBAGENT_USAGE_BATCH_MAX = 500;

/** Token counts of one model request, deduplicated by message id. */
export interface RequestTokenUsage {
  readonly message_id: string;
  readonly model: string;
  /** True for a subagent's request (a line with parent_tool_use_id, or a subagent transcript). */
  readonly subagent: boolean;
  readonly input_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly output_tokens: number;
  /** input + cache read + cache write: the size of the prompt this request sent. */
  readonly prompt_tokens: number;
  readonly created_at: string;
}

/** One request as the SubagentStop hook uploads it; the server derives subagent and prompt_tokens. */
export type HookRequestUsage = Omit<RequestTokenUsage, "subagent" | "prompt_tokens">;

/** The handoff memo a relay-watched child ends its reply with. */
export interface HandoffMemo {
  readonly summary: string;
  readonly done: readonly string[];
  readonly remaining: readonly string[];
  readonly next_steps: readonly string[];
  readonly changed_files: readonly string[];
  readonly notes: string;
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;

/** Prompt size of one request: uncached input plus cache reads and cache writes. */
export function promptTokensOf(usage: unknown): number {
  const fields = record(usage);
  return count(fields.input_tokens) + count(fields.cache_read_input_tokens) + count(fields.cache_creation_input_tokens);
}

/**
 * Turns Claude assistant lines (stream-json or transcript JSONL) into one
 * entry per request. One message id spans several lines that repeat its
 * usage, so `onRequest` fires on the first line of an id (the prompt side is
 * already final there) and `onFlush` with the id's last usage once a later id
 * arrives or `flush()` is called. Result lines carry cumulative usage and are
 * ignored.
 */
export class RequestUsageTracker {
  private readonly pending = new Map<string, RequestTokenUsage>();
  private readonly flushed = new Set<string>();
  public constructor(
    private readonly handlers: { onRequest?(usage: RequestTokenUsage): void; onFlush?(usage: RequestTokenUsage): void } = {},
    private readonly fallbackModel = "",
  ) {}
  public accept(event: Record<string, unknown>): void {
    if (event.type !== "assistant") return;
    const message = record(event.message);
    const id = message.id;
    if (typeof id !== "string" || id.length === 0 || this.flushed.has(id) || !message.usage) return;
    const usage = record(message.usage);
    const timestamp = typeof event.timestamp === "string" && !Number.isNaN(Date.parse(event.timestamp)) ? event.timestamp : null;
    const entry: RequestTokenUsage = {
      message_id: id,
      model: typeof message.model === "string" && message.model ? message.model : this.fallbackModel,
      subagent: typeof event.parent_tool_use_id === "string" && event.parent_tool_use_id.length > 0,
      input_tokens: count(usage.input_tokens),
      cache_read_tokens: count(usage.cache_read_input_tokens),
      cache_write_tokens: count(usage.cache_creation_input_tokens),
      output_tokens: count(usage.output_tokens),
      prompt_tokens: promptTokensOf(usage),
      created_at: this.pending.get(id)?.created_at ?? timestamp ?? new Date().toISOString(),
    };
    if (this.pending.has(id)) { this.pending.set(id, entry); return; }
    this.flush();
    this.pending.set(id, entry);
    this.handlers.onRequest?.(entry);
  }
  public flush(): void {
    for (const [id, entry] of this.pending) {
      this.flushed.add(id);
      this.handlers.onFlush?.(entry);
    }
    this.pending.clear();
  }
}

const HANDOFF_SUMMARY_MAX_CHARS = 1_200;
const HANDOFF_NOTES_MAX_CHARS = 1_500;
const HANDOFF_ITEM_MAX_CHARS = 300;
const cut = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value);

/** The last owl-child-handoff block in `text`, bounded to the memo size limit; null when there is none or it is malformed. */
export function parseHandoffMemo(text: string): HandoffMemo | null {
  const blocks = [...text.matchAll(/```owl-child-handoff[ \t]*\r?\n([\s\S]*?)```/gu)];
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(blocks.at(-1)?.[1] ?? "");
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const strings = (value: unknown): string[] | null =>
    Array.isArray(value) && value.every((item) => typeof item === "string") ? value.map((item: string) => cut(item, HANDOFF_ITEM_MAX_CHARS)) : null;
  const done = strings(parsed.done);
  const remaining = strings(parsed.remaining);
  const nextSteps = strings(parsed.next_steps);
  const changedFiles = strings(parsed.changed_files);
  const notes = parsed.notes === undefined ? "" : parsed.notes;
  if (typeof parsed.summary !== "string" || typeof notes !== "string" || !done || !remaining || !nextSteps || !changedFiles) return null;
  const memo = {
    summary: cut(parsed.summary, HANDOFF_SUMMARY_MAX_CHARS),
    done,
    remaining,
    next_steps: nextSteps,
    changed_files: changedFiles,
    notes: cut(notes, HANDOFF_NOTES_MAX_CHARS),
  };
  // Drop the least essential content first: finished steps, then notes, then the tail of each remaining list.
  const lists = [memo.done, memo.changed_files, memo.remaining, memo.next_steps];
  while (JSON.stringify(memo).length > CHILD_RUN_LIMITS.handoff_memo_max_chars) {
    if (memo.done.length > 0) memo.done.pop();
    else if (memo.notes.length > 0) memo.notes = memo.notes.slice(0, Math.floor(memo.notes.length / 2));
    else {
      const list = lists.find((items) => items.length > 0);
      if (list) list.pop();
      else memo.summary = memo.summary.slice(0, Math.floor(memo.summary.length / 2));
    }
  }
  return memo;
}
