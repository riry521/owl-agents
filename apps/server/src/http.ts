export { isAllowedOrigin, isOwnerRequestAuthorized } from "./http-common.js";
export { validateIntegrationPayload } from "./http-routes-settings.js";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { ApiError, errorBody, newReferenceId } from "./errors.js";
import { CommonMessages } from "./messages/common.js";
import { HttpMessages } from "./messages/http.js";
import { isUlid } from "./ids.js";
import { resolveDataDir, type ContractManifest } from "./contracts.js";
import { configuredApiToken } from "./config.js";
import { KnowledgeBase } from "@owl/core/dist/knowledge-base.js";
import { RuleStore } from "@owl/core/dist/rule-store.js";
import { assertValidPage } from "@owl/core/dist/memory/page-format.js";
import type { OwnerLanguage } from "@owl/shared/owner-language";
import { matchAdvisorBlockedApi, advisorAlternativeActions } from "@owl/shared";
import type { CoreEvent, CorePort, RuntimeConfig } from "./types.js";
import {
  advisorAuthorizedRequests,
  advisorRequestAgent,
  assertSameOriginWrite,
  bearerOf,
  headerValue,
  isLoopback,
  isObject,
  isRequestOriginAllowed,
  knowledgeStorageFeature,
  logException,
  requestId,
  requestOwnerLanguage,
  requestUrl,
  requireOwner,
  responseContexts,
  sendApiError,
  type ChannelAdminSource,
  type GuardTokenVerifier,
  type RequestContext,
  type ScreenViewLimits,
} from "./http-common.js";
import { dispatchApiRoute } from "./http-routes.js";
import { API_PREFIX, WEBSOCKET_PATH, type ApiMethod } from "./http-route-table.js";
import { optionalCoreFeature } from "./core-feature.js";
import { readFile, stat, realpath } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import type { AdvisorBlockedApi } from "@owl/shared/advisor-api-policy";

const STATIC_PREFIX = "/owl/";

const DEFAULT_JSON_COMPRESSION_MIN_BYTES = 1024;

function advisorBlockedError(row: AdvisorBlockedApi, method: string, pathname: string): ApiError {
  const alternatives = advisorAlternativeActions(row);
  return new ApiError(403, "advisor_action_required", HttpMessages.advisorActionRequired({ reason: row.reason, alternatives: alternatives.join(" or ") }), {
    method,
    path: pathname,
    alternative_actions: alternatives,
  });
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function serveStatic(request: IncomingMessage, response: ServerResponse, webOut: string, pathname: string): Promise<boolean> {
  if (!pathname.startsWith(STATIC_PREFIX)) {
    return false;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new ApiError(405, "validation_error", HttpMessages.staticMethodNotAllowed());
  }
  const suffix = pathname.slice(STATIC_PREFIX.length);
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(suffix || "index.html");
  } catch (error) {
    throw new ApiError(400, "validation_error", HttpMessages.staticPathInvalid(), {}, { cause: error });
  }
  const candidate = resolve(webOut, relativePath || "index.html");
  const relativeCandidate = relative(webOut, candidate);
  if (relativeCandidate === ".." || relativeCandidate.startsWith("../") || relativeCandidate.includes("\\")) {
    throw new ApiError(404, "not_found", HttpMessages.staticNotFound());
  }
  let resolvedCandidate = candidate;
  try {
    let fileStat = await stat(resolvedCandidate).catch(() => null);
    if (!fileStat?.isFile() && !basename(relativePath).includes(".")) {
      const htmlCandidate = resolvedCandidate + ".html";
      fileStat = await stat(htmlCandidate).catch(() => null);
      if (fileStat?.isFile()) resolvedCandidate = htmlCandidate;
    }
    if (!fileStat?.isFile()) {
      throw new Error("not a file");
    }
    const exportRoot = await realpath(webOut);
    const actualPath = await realpath(resolvedCandidate);
    const actualRelative = relative(exportRoot, actualPath);
    if (actualRelative === ".." || actualRelative.startsWith("../") || actualRelative.includes("\\")) {
      throw new Error("static_path_escape");
    }
    const data = await readFile(actualPath);
    response.writeHead(200, {
      "content-type": contentType(resolvedCandidate),
      "content-length": data.length,
      "cache-control": "no-cache",
    });
    if (request.method === "HEAD") {
      response.end();
    } else {
      response.end(data);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as Error).message === "not a file") {
      throw new ApiError(404, "not_found", HttpMessages.staticNotFound(), {}, { cause: error });
    }
    throw error;
  }
}

function errorStatusForUnknownRoute(): ApiError {
  return new ApiError(404, "not_found", HttpMessages.apiEndpointNotFound());
}




const MAX_WEBSOCKET_MESSAGE_BYTES = 1024 * 1024;

/** Events sent per page while replaying missed history for a WebSocket `resume`. */
const WS_REPLAY_PAGE_SIZE = 500;


/** Default retention of persisted HTTP idempotency rows; OwlHttpOptions.idempotencyTtlMs overrides it. */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Screen view page sizes used when neither env nor options.screenViewLimits sets them. */
export const DEFAULT_SCREEN_VIEW_LIMITS: Required<ScreenViewLimits> = { boardWorks: 200, linkableWorks: 200, max: 500 };


export interface OwlHttpOptions {
  readonly core: CorePort;
  readonly db?: unknown;
  readonly webOut: string;
  readonly bind: string;
  readonly port: number;
  readonly contract: ContractManifest;
  readonly owlRoot: string;
  /** Resolved data directory reported by GET /system/status (defaults to resolveDataDir(owlRoot)). */
  readonly dataDir?: string;
  /** How long a command response stays replayable by its Idempotency-Key (defaults to DEFAULT_IDEMPOTENCY_TTL_MS). */
  readonly idempotencyTtlMs?: number;
  /** JSON GET responses at least this many bytes are gzip-compressed when the client accepts it (defaults to DEFAULT_JSON_COMPRESSION_MIN_BYTES). */
  readonly jsonCompressionMinBytes?: number;
  /** Page sizes of the screen view lists, from configuration; without one the request must carry `limit`. `max` caps the `limit` query when set. */
  readonly screenViewLimits?: Partial<ScreenViewLimits>;
  readonly ruleStore?: RuleStore;
  /** Verifies the per-process tokens agent permission hooks send to the guard endpoint. */
  readonly guardTokens?: GuardTokenVerifier;
  /** Reaches the running Slack / Discord connectors' channel API; absent means no connector can be reached. */
  readonly channelAdmins?: ChannelAdminSource;
}


export interface OwlHttpServer {
  readonly server: Server;
  readonly runtimeConfig: RuntimeConfig;
  listen(): Promise<void>;
  close(): Promise<void>;
}


async function routeApi(context: RequestContext, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const method = (request.method ?? "GET") as ApiMethod;
  const pathname = url.pathname;
  const rawPathname = (request.url ?? "/").split("?", 1)[0] ?? "/";
  const requestIdValue = requestId(request);
  assertSameOriginWrite(request, context);

  const advisorAgent = advisorRequestAgent(request, context.guardTokens);
  if (advisorAgent) {
    const blocked = matchAdvisorBlockedApi(method, pathname);
    if (blocked) throw advisorBlockedError(blocked, method, pathname);
    advisorAuthorizedRequests.add(request);
  } else {
    // 失効した guard token が、OWL_API_TOKEN 未設定のループバックで Owner に落ちるのを防ぐ
    const bearer = bearerOf(request);
    if (bearer && /^[0-9a-f]{64}$/.test(bearer) && bearer !== configuredApiToken()
      && isLoopback(request) && context.guardTokens?.verify(bearer) === null) {
      throw new ApiError(401, "unauthorized", HttpMessages.guardTokenInvalid());
    }
  }

  if (!await dispatchApiRoute({ context, request, response, url, method, pathname, rawPathname, requestId: requestIdValue })) {
    throw errorStatusForUnknownRoute();
  }
}

function websocketAccept(key: string): string {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "utf8").digest("base64");
}


function websocketFrame(text: string, opcode = 0x1): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
  }
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}


interface ParsedWebSocketFrame {
  readonly opcode: number;
  readonly payload: Buffer;
}


function parseOneWebSocketFrame(buffer: Buffer): { frame: ParsedWebSocketFrame | null; rest: Buffer } {
  if (buffer.length < 2) return { frame: null, rest: buffer };
  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (!fin || !masked) {
    throw new Error("WebSocket frame must be final and masked");
  }
  if (length === 126) {
    if (buffer.length < offset + 2) return { frame: null, rest: buffer };
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return { frame: null, rest: buffer };
    const largeLength = buffer.readBigUInt64BE(offset);
    if (largeLength > BigInt(MAX_WEBSOCKET_MESSAGE_BYTES)) throw new Error("WebSocket message is too large");
    length = Number(largeLength);
    offset += 8;
  }
  if (length > MAX_WEBSOCKET_MESSAGE_BYTES) throw new Error("WebSocket message is too large");
  if (buffer.length < offset + 4 + length) return { frame: null, rest: buffer };
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] ^= mask[index % 4];
  }
  return { frame: { opcode, payload }, rest: buffer.subarray(offset + length) };
}


function wsFrameError(requestIdValue: string, code: string, message: string): Record<string, unknown> {
  return { kind: "error", request_id: requestIdValue, error: { code, message, details: {} } };
}


function validRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128;
}


class WebSocketConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;
  private subscribed = false;
  private workIds: string[] = [];
  private eventTypes: string[] = [];
  private readonly unsubscribe: () => void;

  constructor(private readonly socket: Socket, private readonly context: RequestContext, private readonly language: OwnerLanguage) {
    context.websocketSockets.add(socket);
    socket.setNoDelay(true);
    this.unsubscribe = context.core.subscribe((event) => this.sendEvent(event));
    socket.on("data", (data) => this.feed(Buffer.from(data)));
    socket.on("close", () => this.dispose());
    socket.on("error", (error) => {
      logException(newReferenceId(), "WebSocket connection", error);
      this.dispose();
    });
  }

  private text(ja: string, en: string): string {
    return this.language === "ja" ? ja : en;
  }

  feed(data: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, data]);
    try {
      while (this.buffer.length > 0) {
        const parsed = parseOneWebSocketFrame(this.buffer);
        if (!parsed.frame) {
          if (this.buffer.length > MAX_WEBSOCKET_MESSAGE_BYTES + 14) {
            this.send(wsFrameError("ws-frame", "validation_error", this.text("WebSocketメッセージが大きすぎます。", "WebSocket message is too large.")));
            this.close();
          }
          return;
        }
        this.buffer = parsed.rest;
        if (parsed.frame.opcode === 0x8) {
          this.close();
          return;
        }
        if (parsed.frame.opcode === 0x9) {
          this.socket.write(websocketFrame(parsed.frame.payload.toString("utf8"), 0xa));
          continue;
        }
        if (parsed.frame.opcode !== 0x1) {
          this.send(wsFrameError("ws-frame", "validation_error", this.text("WebSocketはJSON text frameだけを受け付けます。JSONを送信してください。", "WebSocket accepts JSON text frames only. Send JSON.")));
          continue;
        }
        this.onText(parsed.frame.payload.toString("utf8"));
      }
    } catch (error) {
      logException(newReferenceId(), "WebSocket frame parsing", error);
      this.send(wsFrameError("ws-frame", "validation_error", this.text("WebSocket frameを解釈できません。契約どおりのJSONを送信してください。", "Could not parse the WebSocket frame. Send JSON matching the contract.")));
    }
  }

  private onText(text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      logException(newReferenceId(), "WebSocket JSON parsing", error);
      this.send(wsFrameError("ws-frame", "validation_error", this.text("WebSocket messageをJSONとして解釈できません。JSON形式を確認してください。", "Could not parse the WebSocket message as JSON.")));
      return;
    }
    const requestIdCandidate = isObject(value) && validRequestId(value.request_id) ? value.request_id : "ws-frame";
    if (!isObject(value) || !validRequestId(value.request_id) || typeof value.kind !== "string") {
      this.send(wsFrameError(requestIdCandidate, "validation_error", this.text("WebSocket frameのkindとrequest_idを確認してください。", "Check the WebSocket frame kind and request_id.")));
      return;
    }
    const requestIdValue = value.request_id;
    if (value.kind === "subscribe") {
      const keys = Object.keys(value).sort().join(",");
      const workIds = value.work_ids;
      const eventTypes = value.event_types;
      if (keys !== "event_types,kind,request_id,work_ids" || !Array.isArray(workIds) || !Array.isArray(eventTypes) || !workIds.every(isUlid) || !eventTypes.every((eventType) => typeof eventType === "string")) {
        this.send(wsFrameError(requestIdValue, "validation_error", this.text("subscribe frameの項目または型が契約と一致しません。", "The subscribe frame fields or types do not match the contract.")));
        return;
      }
      this.workIds = workIds;
      this.eventTypes = eventTypes;
      this.subscribed = true;
      this.sendReady(requestIdValue);
      return;
    }
    if (value.kind === "resume" || value.kind === "ack") {
      if (Object.keys(value).sort().join(",") !== "cursor,kind,request_id" || typeof value.cursor !== "string" || !/^\d+$/.test(value.cursor)) {
        this.send(wsFrameError(requestIdValue, "validation_error", this.text("resume/ack frameのcursorを確認してください。", "Check the resume/ack frame cursor.")));
        return;
      }
      if (value.kind === "resume") {
        if (!this.subscribed) {
          this.subscribed = true;
          this.sendReady(requestIdValue);
        }
        const cursor = Number(value.cursor);
        const oldest = this.oldestEventSequence();
        if (oldest !== null && cursor < oldest - 1) {
          this.send(wsFrameError(requestIdValue, "replay_gap", this.text("再接続位置が保持期間の外です。REST snapshotを取得してから再接続してください。", "The resume cursor is outside the retention window. Fetch a REST snapshot and reconnect.")));
          return;
        }
        this.sendReplay(cursor);
      } else if (!this.subscribed) {
        this.sendReady(requestIdValue);
      }
      return;
    }
    this.send(wsFrameError(requestIdValue, "validation_error", this.text("WebSocket frameのkindが契約と一致しません。subscribe、resume、ackを指定してください。", "Invalid WebSocket frame kind. Use subscribe, resume, or ack.")));
  }

  private sendReady(requestIdValue: string): void {
    this.send({ kind: "ready", request_id: requestIdValue, protocol_version: "owl-ws-1", cursor: this.latestEventCursor() });
  }

  /** Oldest retained sequence, via the O(1) core method when available, else a full history scan. */
  private oldestEventSequence(): number | null {
    if (this.context.core.oldestEventSequence) return this.context.core.oldestEventSequence();
    return this.context.core.eventsAfter(0)[0]?.sequence ?? null;
  }

  /** Newest cursor, via the O(1) core method when available, else a full history scan. */
  private latestEventCursor(): string {
    if (this.context.core.latestEventCursor) return this.context.core.latestEventCursor();
    return this.context.core.eventsAfter(0).at(-1)?.cursor ?? "0";
  }

  /** Sends missed history after `cursor` in bounded pages so a large backlog is not built into one message burst. */
  private sendReplay(cursor: number): void {
    let after = cursor;
    for (;;) {
      const page = this.context.core.eventsAfter(after, WS_REPLAY_PAGE_SIZE);
      if (page.length === 0) return;
      for (const event of page) this.sendEvent(event);
      after = page[page.length - 1].sequence;
      if (page.length < WS_REPLAY_PAGE_SIZE) return;
    }
  }

  private sendEvent(event: CoreEvent): void {
    if (this.closed || (!this.subscribed && this.workIds.length === 0)) return;
    const eventWorkId = typeof event.work_id === "string"
      ? event.work_id
      : typeof event.payload.work_id === "string"
        ? event.payload.work_id
        : null;
    if (this.workIds.length > 0 && (eventWorkId === null || !this.workIds.includes(eventWorkId))) return;
    if (this.eventTypes.length > 0 && !this.eventTypes.includes(event.type)) return;
    this.send(event);
  }

  private send(value: object): void {
    if (!this.closed && !this.socket.destroyed) this.socket.write(websocketFrame(JSON.stringify(value)));
  }

  private dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.context.websocketSockets.delete(this.socket);
    this.unsubscribe();
  }

  private close(): void {
    if (this.closed) return;
    this.socket.write(websocketFrame("", 0x8));
    this.socket.end();
    this.dispose();
  }
}



function writeUpgradeError(socket: Socket, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  socket.write(`HTTP/1.1 ${status} Error\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
  socket.end();
}


async function handleUpgrade(context: RequestContext, request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
  const url = requestUrl(request);
  if (url.pathname !== WEBSOCKET_PATH) {
    socket.destroy();
    return;
  }
  const requestIdValue = requestId(request);
  try {
    requireOwner(request);
    if (!isRequestOriginAllowed(request, context)) {
      throw new ApiError(403, "forbidden", HttpMessages.websocketOriginForbidden());
    }
    const key = headerValue(request, "sec-websocket-key");
    if (!key) {
      throw new ApiError(400, "validation_error", HttpMessages.websocketKeyMissing());
    }
    const accept = websocketAccept(key);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const connection = new WebSocketConnection(socket, context, await requestOwnerLanguage(context.core));
    if (head.length > 0) connection.feed(head);
  } catch (error) {
    if (error instanceof ApiError) {
      writeUpgradeError(socket, error.status, errorBody(requestIdValue, error, await requestOwnerLanguage(context.core)));
      return;
    }
    const referenceId = newReferenceId();
    logException(referenceId, "WebSocket upgrade", error);
    const unexpected = new ApiError(500, "server_error", CommonMessages.unexpected(), { ref_id: referenceId });
    writeUpgradeError(socket, 500, errorBody(requestIdValue, unexpected, await requestOwnerLanguage(context.core)));
  }
}


export function createOwlHttpServer(options: OwlHttpOptions): OwlHttpServer {
  const context: RequestContext = {
    core: options.core,
    db: options.db ?? null,
    webOut: options.webOut,
    bind: options.bind,
    port: options.port,
    contract: options.contract,
    dataDir: options.dataDir ?? resolveDataDir(options.owlRoot),
    idempotency: new Map(),
    idempotencyTtlMs: options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
    screenViewLimits: { ...DEFAULT_SCREEN_VIEW_LIMITS, ...options.screenViewLimits },
    inFlight: new Map(),
    workLocks: new Map(),
    websocketSockets: new Set(),
    shuttingDown: false,
    knowledge: new KnowledgeBase(options.owlRoot, {
      rootDir: () => knowledgeStorageFeature(options.core).activeKnowledgeDir(),
      requireRoot: () => knowledgeStorageFeature(options.core).hasKnowledgeStorageEverBeenAvailable(),
      searcher: (query, tags) => optionalCoreFeature(options.core, ["searchKnowledgeCompat", "notifyKnowledgeChanged"])?.searchKnowledgeCompat(query, tags) ?? Promise.resolve(null),
      pageGuard: (content) => assertValidPage(content),
    }),
    ruleStore: options.ruleStore ?? new RuleStore(options.owlRoot),
    guardTokens: options.guardTokens ?? null,
    channelAdmins: options.channelAdmins ?? null,
  };
  const runtimeConfig: RuntimeConfig = {
    base_path: "/owl/",
    api_base: API_PREFIX,
    ws_url: `${API_PREFIX}/ws`,
    schema_version: "1.0.0",
  };
  const compressionMinBytes = options.jsonCompressionMinBytes ?? DEFAULT_JSON_COMPRESSION_MIN_BYTES;
  const server = createServer(async (request, response) => {
    const requestIdValue = requestId(request);
    try {
      const url = requestUrl(request);
      if ("/owl" === url.pathname) {
        response.writeHead(301, { Location: "/owl/" });
        response.end();
        return;
      }
      if (await serveStatic(request, response, context.webOut, url.pathname)) return;
      if (!url.pathname.startsWith(API_PREFIX)) throw errorStatusForUnknownRoute();
      responseContexts.set(response, { request, compressionMinBytes });
      await routeApi(context, request, response, url);
    } catch (error) {
      await sendApiError(response, requestIdValue, error, `${request.method ?? "GET"} ${request.url ?? "/"}`, context.core);
    }
  });
  server.on("upgrade", (request, socket, head) => handleUpgrade(context, request, socket as Socket, head));

  return {
    server,
    runtimeConfig,
    listen: () => new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolvePromise();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(options.port, options.bind);
    }),
    close: () => new Promise<void>((resolvePromise, reject) => {
      context.shuttingDown = true;
      for (const socket of context.websocketSockets) socket.destroy();
      server.close((error) => error ? reject(error) : resolvePromise());
      // server.close() stops accepting connections but waits for active HTTP
      // requests. A stalled upload/client can otherwise keep `owl stop` alive
      // past its timeout after the core has already shut down.
      server.closeAllConnections();
    }),
  };
}
