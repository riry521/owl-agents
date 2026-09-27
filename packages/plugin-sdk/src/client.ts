import type { OwlEvent, PluginConfig } from "./types";
import { asOwlLanguage, type OwlLanguage } from "./shared/language";
import type { ConnectorDecisionMessageRef, ConnectorStateStore } from "./shared/state-store";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

type WebSocketLike = {
  on(event: string, handler: (...args: any[]) => void): void;
  send(data: string): void;
  close(): void;
};

type WebSocketFrame = {
  readonly kind?: string;
  readonly cursor?: string;
  readonly type?: string;
  readonly sequence?: number;
  readonly event_id?: string;
  readonly payload?: Record<string, unknown>;
  readonly work_id?: string | null;
  readonly task_id?: string | null;
  readonly agent_run_id?: string | null;
  readonly created_at?: string;
  readonly error?: { code?: string; message?: string };
};

type WebSocketConstructor = new (url: string, options?: { headers?: Record<string, string> }) => WebSocketLike;

type EventPage = {
  readonly events: OwlEvent[];
  readonly cursor: string | null;
  readonly has_more?: boolean;
};

export type CorePage<T> = {
  readonly data: T;
  readonly cursor: string | null;
  readonly has_more: boolean;
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
function ulid(): string {
  const timestamp = Date.now();
  let time = "";
  let value = timestamp;
  for (let index = 0; index < 10; index += 1) {
    time = CROCKFORD[value % 32] + time;
    value = Math.floor(value / 32);
  }
  const random = randomBytes(16);
  let entropy = "";
  let bitBuffer = 0;
  let bitCount = 0;
  for (const byte of random) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5 && entropy.length < 16) {
      bitCount -= 5;
      entropy += CROCKFORD[(bitBuffer >>> bitCount) & 31];
    }
  }
  while (entropy.length < 16) entropy += "0";
  return time + entropy;
}

export function newRequestId(): string {
  return ulid();
}

export function commandEnvelope(payload: Record<string, unknown>, idempotencyPrefix = "plugin"): Record<string, unknown> {
  const requestId = newRequestId();
  return { request_id: requestId, idempotency_key: `${idempotencyPrefix}:${requestId}`, expected_version: 0, payload };
}

/**
 * Like commandEnvelope, but with a caller-chosen idempotency key and expected
 * version instead of a fresh request_id and version 0. Retrying the same
 * logical command (e.g. clicking the same Decision button twice) with the
 * same idempotencyKey replays Core's first response instead of racing a
 * second write against the first.
 */
export function commandEnvelopeFor(options: {
  readonly payload: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
}): Record<string, unknown> {
  return {
    request_id: newRequestId(),
    idempotency_key: options.idempotencyKey,
    expected_version: options.expectedVersion,
    payload: options.payload,
  };
}

const LANGUAGE_CACHE_MS = 60_000;
const MAX_DECISION_MESSAGES = 500;

/** Thrown by CoreClient.request/requestRaw for a non-2xx Core response, carrying the parsed error code and HTTP status so callers can branch on them instead of parsing the message text. */
export class CoreRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(`Core request failed (${status}): ${code} ${message}`);
    this.name = "CoreRequestError";
    this.status = status;
    this.code = code;
  }
}

export class CoreClient extends EventEmitter {
  private readonly apiBase: string;
  private readonly wsUrl: string | undefined;
  private readonly apiToken: string | undefined;
  private ws: WebSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private pollingInFlight = false;
  private pollingInitialSyncPending = false;
  private eventCursor = 0;
  private closed = false;
  private languageCache: { readonly value: OwlLanguage; readonly at: number } | null = null;
  private readonly stateStore: ConnectorStateStore | undefined;
  private readonly decisions = new Map<string, ConnectorDecisionMessageRef>();
  private stateLoaded: Promise<void> | null = null;
  /** The cursor the server last confirmed as caught-up ("ready"); where a replay_gap error resumes live from. */
  private lastReadyCursor: number | null = null;
  /** Chains event handler invocations so they run one at a time, in order, regardless of how fast frames arrive. */
  private processingChain: Promise<void> = Promise.resolve();

  constructor(config: PluginConfig) {
    super();
    this.apiBase = config.core_api_base.replace(/\/$/, "");
    this.wsUrl = config.core_ws_url;
    this.apiToken = config.api_token;
    this.stateStore = config.state_store;
  }

  /** Loads persisted cursor/decisions state once, before the first subscribeEvents call does anything else. */
  private async loadState(): Promise<void> {
    if (!this.stateStore) return;
    if (!this.stateLoaded) {
      this.stateLoaded = (async () => {
        const state = await this.stateStore!.load();
        if (!state) return;
        this.eventCursor = state.cursor;
        this.decisions.clear();
        for (const [decisionId, ref] of Object.entries(state.decisions)) {
          this.decisions.set(decisionId, ref);
        }
      })();
    }
    await this.stateLoaded;
  }

  private async persistState(): Promise<void> {
    if (!this.stateStore) return;
    const decisions: Record<string, ConnectorDecisionMessageRef> = {};
    for (const [decisionId, ref] of this.decisions) decisions[decisionId] = ref;
    try {
      await this.stateStore.save({ schema_version: 1, cursor: this.eventCursor, decisions });
    } catch (error) {
      console.error("[plugin-sdk] Failed to persist connector state:", error);
    }
  }

  /** The chat message (if any) that announced this Decision, so a resolved/cancelled event can edit it instead of posting anew. */
  decisionMessage(decisionId: string): ConnectorDecisionMessageRef | null {
    return this.decisions.get(decisionId) ?? null;
  }

  listDecisionMessages(): ReadonlyMap<string, ConnectorDecisionMessageRef> {
    return this.decisions;
  }

  async rememberDecisionMessage(decisionId: string, ref: ConnectorDecisionMessageRef): Promise<void> {
    this.decisions.set(decisionId, ref);
    while (this.decisions.size > MAX_DECISION_MESSAGES) {
      const oldest = this.decisions.keys().next().value;
      if (oldest === undefined) break;
      this.decisions.delete(oldest);
    }
    await this.persistState();
  }

  async forgetDecisionMessage(decisionId: string): Promise<void> {
    if (this.decisions.delete(decisionId)) await this.persistState();
  }

  async request<T = unknown>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const body = await this.requestRaw(path, init);
    if (body && typeof body === "object" && "data" in body) {
      return (body as { data: T }).data;
    }
    return body as T;
  }

  /**
   * The Owner language connectors write in (GET /settings/language). Cached
   * for LANGUAGE_CACHE_MS so a change reaches chat within a minute without a
   * request per message; "ja" (or the last known value) when Core cannot say.
   */
  async language(): Promise<OwlLanguage> {
    const now = Date.now();
    if (this.languageCache && now - this.languageCache.at < LANGUAGE_CACHE_MS) return this.languageCache.value;
    let value: OwlLanguage;
    try {
      value = asOwlLanguage((await this.request<{ language?: unknown } | null>("/settings/language"))?.language);
    } catch {
      value = this.languageCache?.value ?? "ja";
    }
    this.languageCache = { value, at: now };
    return value;
  }

  /** Fetch a paginated Core response without discarding its cursor metadata. */
  async requestPage<T = unknown>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<CorePage<T>> {
    const body = await this.requestRaw(path, init);
    if (!body || typeof body !== "object" || !("data" in body)) {
      throw new Error("Core paginated response is missing data");
    }
    const page = body as { data: T; cursor?: unknown; has_more?: unknown };
    if (page.cursor !== null && typeof page.cursor !== "string") {
      throw new Error("Core paginated response returned an invalid cursor");
    }
    if (typeof page.has_more !== "boolean") {
      throw new Error("Core paginated response is missing has_more");
    }
    return {
      data: page.data,
      cursor: page.cursor ?? null,
      has_more: page.has_more,
    };
  }

  private async requestRaw(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<unknown> {
    const url = new URL(`${this.apiBase}${path}`);
    const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
    if (!transport) throw new Error(`Core API URL must use http or https (received ${url.protocol || "unknown"})`);
    // A Buffer body (e.g. inbound upload content) is written as-is; every
    // other body is JSON-encoded, as before. The caller supplies its own
    // Content-Type/Content-Length for a raw body via `headers`.
    const isRawBody = Buffer.isBuffer(init.body);
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const req = transport.request(url, {
        method: init.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
          ...(init.body !== undefined && !isRawBody ? { "Content-Type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            fail(new Error("Core response exceeded the 4 MiB safety limit"));
            res.destroy();
            return;
          }
          chunks.push(buffer);
        });
        res.on("end", () => {
          if (settled) return;
          const text = Buffer.concat(chunks).toString();
          let body: unknown;
          try { body = JSON.parse(text) as unknown; } catch (err) { fail(err); return; }
          if (res.statusCode === undefined || res.statusCode < 200 || res.statusCode >= 300) {
            const error = body && typeof body === "object" && "error" in body ? (body as { error?: { code?: string; message?: string } }).error : undefined;
            fail(new CoreRequestError(res.statusCode ?? 0, error?.code ?? "http_error", error?.message ?? "request rejected"));
            return;
          }
          settled = true;
          resolve(body);
        });
      });
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error("Core request timed out"));
      });
      req.on("error", fail);
      if (init.body !== undefined) req.write(isRawBody ? (init.body as Buffer) : JSON.stringify(init.body));
      req.end();
    });
  }

  async subscribeEvents(eventTypes: readonly string[], handler: (event: OwlEvent) => Promise<void>): Promise<void> {
    this.closed = false;
    await this.loadState();
    if (!this.wsUrl) {
      console.warn("[plugin-sdk] No WebSocket URL configured, falling back to polling");
      this.startPolling(handler, this.eventCursor === 0);
      return;
    }
    await this.connectWs(eventTypes, handler);
  }

  /** Runs handler(event) after any earlier queued event has settled, then advances and persists the cursor, then acks — in that order, regardless of whether the handler succeeded. */
  private enqueueEvent(event: OwlEvent, nextCursor: number, handler: (event: OwlEvent) => Promise<void>, onSettled: () => void): void {
    this.processingChain = this.processingChain
      .then(() => handler(event))
      .catch((error) => {
        console.error(`[plugin-sdk] Event handler failed for ${event.type} #${event.sequence}:`, error);
      })
      .then(async () => {
        if (Number.isSafeInteger(nextCursor) && nextCursor > this.eventCursor) {
          this.eventCursor = nextCursor;
          await this.persistState();
        }
        onSettled();
      });
  }

  private async connectWs(eventTypes: readonly string[], handler: (event: OwlEvent) => Promise<void>): Promise<void> {
    if (this.closed) return;
    try {
      const wsModule = await import("ws");
      const WebSocket = (wsModule.default ?? wsModule) as unknown as WebSocketConstructor;
      const ws = new WebSocket(this.wsUrl!, this.apiToken ? { headers: { Authorization: `Bearer ${this.apiToken}` } } : undefined);
      ws.on("open", () => {
        console.log("[plugin-sdk] WebSocket connected");
        // A reconnect (eventCursor > 0) sends resume first, so missed history
        // replays under the server's own catch-up window rather than racing
        // against live events that subscribe would otherwise start narrowing
        // to eventTypes immediately. Either order delivers every event once
        // the client's own eventTypes/sequence filtering below is applied.
        if (this.eventCursor > 0) {
          ws.send(JSON.stringify({ kind: "resume", request_id: newRequestId(), cursor: String(this.eventCursor) }));
        }
        ws.send(JSON.stringify({ kind: "subscribe", request_id: newRequestId(), work_ids: [], event_types: eventTypes }));
      });
      ws.on("message", (data: Buffer) => {
        const rawMessage = data.toString();
        try {
          const frame = JSON.parse(rawMessage) as WebSocketFrame;
          if (frame.kind === "error") {
            const code = frame.error?.code ?? "unknown";
            console.error(`[plugin-sdk] WebSocket protocol error: ${code} ${frame.error?.message ?? ""}`);
            if (code === "replay_gap") {
              // The server kept this connection open and already sent a fresh
              // "ready" cursor before this error. There is no way to recover
              // the events in the gap over this transport, so resume live
              // from that ready cursor instead of tearing the connection down
              // and falling back to polling (which would also have to accept
              // the same gap; staying on the WebSocket keeps events flowing
              // with no further downtime).
              if (this.lastReadyCursor !== null && this.lastReadyCursor > this.eventCursor) {
                this.eventCursor = this.lastReadyCursor;
                void this.persistState();
              }
              return;
            }
            try { ws.close(); } catch { /* close handler starts polling */ }
            // A WebSocket error can happen after subscribe/resume has already
            // established a cursor. Poll from that cursor so unhandled
            // events remain replayable; only a no-WebSocket startup performs
            // the history-discarding baseline below.
            this.startPolling(handler, false);
            return;
          }
          if (frame.kind === "ready") {
            if (typeof frame.cursor === "string" && /^\d+$/u.test(frame.cursor)) {
              this.lastReadyCursor = Number(frame.cursor);
              if (this.eventCursor === 0) {
                this.eventCursor = this.lastReadyCursor;
              } else if (this.lastReadyCursor < this.eventCursor) {
                // The server's own event log is behind our persisted cursor
                // (e.g. its database was recreated). There is nothing to
                // replay past what it now has, so drop back to its cursor
                // rather than waiting forever for events that no longer exist.
                console.warn(`[plugin-sdk] Server cursor ${this.lastReadyCursor} is behind the persisted cursor ${this.eventCursor}; resetting to the server's cursor.`);
                this.eventCursor = this.lastReadyCursor;
                void this.persistState();
              }
            }
            return;
          }
          if (frame.kind === "event" && typeof frame.type === "string" && (eventTypes.length === 0 || eventTypes.includes(frame.type))) {
            if (typeof frame.event_id !== "string" || typeof frame.sequence !== "number" || !frame.payload || typeof frame.payload !== "object") {
              throw new Error("WebSocket event frame is missing its canonical fields");
            }
            if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= this.eventCursor) return;
            const event = frame as OwlEvent;
            const nextCursor = typeof frame.cursor === "string" && /^\d+$/u.test(frame.cursor)
              ? Number(frame.cursor)
              : frame.sequence;
            this.enqueueEvent(event, nextCursor, handler, () => {
              try { ws.send(JSON.stringify({ kind: "ack", request_id: newRequestId(), cursor: String(this.eventCursor) })); } catch { /* connection already gone; a reconnect resumes from the persisted cursor */ }
            });
          }
        } catch (error) {
          console.error("[plugin-sdk] WebSocket message was malformed; event delivery switched to polling", error, {
            rawMessageLength: rawMessage.length,
          });
          try { ws.close(); } catch { /* close handler already schedules recovery */ }
          this.startPolling(handler, false);
        }
      });
      ws.on("close", () => {
        if (this.closed || this.pollingTimer) return;
        console.log("[plugin-sdk] WebSocket closed, reconnecting in 5s");
        this.reconnectTimer = setTimeout(() => void this.connectWs(eventTypes, handler), 5000);
      });
      ws.on("error", (err: Error) => {
        console.error("[plugin-sdk] WebSocket error:", err.message);
      });
      this.ws = ws;
    } catch (error: unknown) {
      // ws is optional; polling is the documented fallback for environments without WebSocket support.
      const code = error instanceof Error && "code" in error ? (error as { code: string }).code : "";
      if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
        console.warn("[plugin-sdk] ws module not available, falling back to polling");
        this.startPolling(handler, true);
      } else {
        throw error;
      }
    }
  }

  private startPolling(handler: (event: OwlEvent) => Promise<void>, discardExistingHistory: boolean): void {
    if (this.pollingTimer) return;
    this.pollingInitialSyncPending = discardExistingHistory && this.eventCursor === 0;
    const poll = async () => {
      if (this.closed || this.pollingInFlight) return;
      this.pollingInFlight = true;
      try {
        if (this.pollingInitialSyncPending) {
          await this.syncPollingCursor();
          this.pollingInitialSyncPending = false;
          return;
        }
        const page = await this.request<EventPage>(`/events?after=${this.eventCursor}&limit=50`);
        for (const event of page.events) {
          if (!Number.isSafeInteger(event.sequence) || event.sequence <= this.eventCursor) continue;
          try {
            await handler(event);
          } catch (handlerError) {
            console.error(`[plugin-sdk] Event handler failed for ${event.type} #${event.sequence}:`, handlerError);
          }
          if (event.sequence > this.eventCursor) {
            this.eventCursor = event.sequence;
            await this.persistState();
          }
        }
        if (page.cursor !== null && /^\d+$/u.test(page.cursor)) this.eventCursor = Math.max(this.eventCursor, Number(page.cursor));
      } catch (err) {
        console.error("[plugin-sdk] Poll error:", err);
      } finally {
        this.pollingInFlight = false;
      }
    };
    this.pollingTimer = setInterval(poll, 5000);
    void poll();
  }

  /**
   * Establish the initial polling baseline without delivering durable history.
   * The endpoint is paginated, so a single request is not enough to reach the
   * current cursor when the event log contains more than 50 records.
   */
  private async syncPollingCursor(): Promise<void> {
    for (;;) {
      const page = await this.request<EventPage>(`/events?after=${this.eventCursor}&limit=50`);
      const pageCursor = typeof page.cursor === "string" && /^\d+$/u.test(page.cursor)
        ? Number(page.cursor)
        : page.events.reduce((cursor, event) => Math.max(cursor, event.sequence), this.eventCursor);
      if (!Number.isSafeInteger(pageCursor) || pageCursor < this.eventCursor) {
        throw new Error("Core polling response returned an invalid cursor");
      }
      const advanced = pageCursor > this.eventCursor;
      this.eventCursor = pageCursor;
      if (!page.has_more || page.events.length === 0 || !advanced) return;
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ok */ }
      this.ws = null;
    }
  }
}
