import type { ApiMethod, RouteDefinition } from "./http-route-table.js";
import { requireAdapterFeature, requireCoreFeature } from "./core-feature.js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import type { Socket } from "node:net";
import { ApiError, errorBody, newReferenceId } from "./errors.js";
import { HttpCommonMessages as HC } from "./messages/http-common.js";
import { createUlid, isUlid } from "./ids.js";
import { parseChannelIds } from "./integration-store.js";
import type { ContractManifest } from "./contracts.js";
import { configuredApiToken } from "./config.js";
import { validatePrerequisiteWorkIds } from "@owl/shared/work-prerequisite";
import { KnowledgeBase } from "@owl/core/dist/knowledge-base.js";
import { prerequisiteIdsReason } from "@owl/core/dist/work-prerequisites.js";
import { RuleStore } from "@owl/core/dist/rule-store.js";
import { MAX_MESSAGE_ATTACHMENTS, MAX_UPLOAD_BYTES } from "@owl/core/dist/upload-limits.js";
import { normalizeChannelName, type AdvisorWindowSettings } from "@owl/shared/advisor-window-settings";
import { isChannelAdminError, type ChannelAdmin } from "@owl/plugin-sdk/shared";
import type { OwnerLanguage } from "@owl/shared/owner-language";
import type { GuardTokenAgent } from "@owl/shared/guard-token";
import type { CorePort, JsonObject, PostMessageInput, WorkInstructionInput } from "./types.js";
import type { WebAttachmentTarget } from "@owl/core/dist/core.js";



const MAX_BODY_BYTES = 1024 * 1024;

/** Namespace in idempotency_keys, kept apart from Core's own keys (decisions, ...). */
export const HTTP_IDEMPOTENCY_KEY_PREFIX = "http-idempotency:";

const MAX_IDEMPOTENCY_ENTRIES = 10000;
export const UI_SESSION_COOKIE = "owl_ui_session";

export const UI_SESSION_SECRET = randomBytes(32);


export async function requestOwnerLanguage(core: CorePort): Promise<OwnerLanguage> {
  if (typeof core.getLanguage !== "function") return "ja";
  try {
    return await core.getLanguage();
  } catch {
    return "ja";
  }
}


export interface ChannelAdminSource {
  channelAdmin(provider: "slack" | "discord"): ChannelAdmin | null;
}


export interface ScreenViewLimits {
  readonly boardWorks?: number;
  readonly linkableWorks?: number;
  readonly max?: number;
}


export interface GuardTokenVerifier {
  verify(token: string): GuardTokenAgent | null;
}


interface StoredCommandResponse {
  readonly bodyHash: string;
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly workId?: string;
  readonly expiresAt: number;
}


interface InFlightCommand {
  readonly bodyHash: string;
  readonly promise: Promise<Record<string, unknown>>;
  readonly workId?: string;
}


export interface RequestContext {
  readonly core: CorePort;
  readonly db: unknown;
  readonly webOut: string;
  readonly bind: string;
  readonly port: number;
  readonly contract: ContractManifest;
  readonly dataDir: string;
  readonly idempotency: Map<string, StoredCommandResponse>;
  readonly idempotencyTtlMs: number;
  readonly screenViewLimits: ScreenViewLimits;
  readonly inFlight: Map<string, InFlightCommand>;
  readonly workLocks: Map<string, Promise<void>>;
  readonly websocketSockets: Set<Socket>;
  shuttingDown: boolean;
  readonly knowledge: KnowledgeBase;
  readonly ruleStore: RuleStore;
  readonly guardTokens: GuardTokenVerifier | null;
  readonly channelAdmins: ChannelAdminSource | null;
}



export interface AdvisorSessionReadDatabase {
  get<T extends object>(sql: string, ...parameters: (string | number | bigint | Buffer | null)[]): T | undefined;
}


export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


export function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}


export function isLoopback(request: IncomingMessage): boolean {
  // Tailscale Serve proxies tailnet devices through loopback, so they count as local.
  // Funnel reaches the public internet, so its requests never do.
  if (request.headers["tailscale-funnel-request"] !== undefined) return false;
  const address = request.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}


export function isAllowedOrigin(origin: string | undefined, context: Pick<RequestContext, "bind" | "port">): boolean {
  // Browsers send Origin on WebSocket handshakes and state-changing requests, so a missing
  // Origin means a non-browser client (such as the CLI); leave those to requireOwner()'s
  // loopback/token check.
  if (origin === undefined) return true;

  const allowedOrigins = new Set([
    `http://127.0.0.1:${context.port}`,
    `http://localhost:${context.port}`,
  ]);
  if (context.bind !== "0.0.0.0") {
    allowedOrigins.add(`http://${context.bind}:${context.port}`);
  }
  const publicHost = process.env.OWL_PUBLIC_HOST?.trim();
  if (publicHost) {
    allowedOrigins.add(`http://${publicHost}:${context.port}`);
    // Tailscale Serve/Funnel terminates TLS on 443 for the configured host.
    allowedOrigins.add(`https://${publicHost}`);
  }
  if (allowedOrigins.has(origin)) return true;
  // "null" (sandboxed iframe, file://) and malformed values never match.
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (publicHost) {
    // A configured public host pins the tailnet origin; other *.ts.net hosts
    // (including attacker-controlled Funnel nodes) are not trusted.
    return false;
  }
  // Legacy fallback when OWL_PUBLIC_HOST is not configured: accept HTTPS origins
  // on a Tailscale MagicDNS name. Configure OWL_PUBLIC_HOST to narrow this.
  return parsed.protocol === "https:" && parsed.hostname.endsWith(".ts.net") && (parsed.port === "" || parsed.port === "443");
}


const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);


/**
 * CSRF guard for state-changing API requests. The API authorizes loopback
 * requests without a token when OWL_API_TOKEN is unset, so a browser page on
 * any site could otherwise drive it with no-cors "simple" requests.
 * Non-browser clients (CLI, connectors, SDK) send neither Origin nor
 * Sec-Fetch-Site and are unaffected.
 */
export function assertSameOriginWrite(request: IncomingMessage, context: Pick<RequestContext, "bind" | "port">): void {
  const method = (request.method ?? "GET").toUpperCase();
  if (SAFE_METHODS.has(method)) return;
  if (headerValue(request, "sec-fetch-site")?.toLowerCase() === "cross-site") {
    throw new ApiError(403, "forbidden", HC.originCross());
  }
  if (!isRequestOriginAllowed(request, context)) {
    throw new ApiError(403, "forbidden", HC.originDenied());
  }
}


/** Shared Origin gate for state-changing HTTP requests and WebSocket upgrades. */
export function isRequestOriginAllowed(request: IncomingMessage, context: Pick<RequestContext, "bind" | "port">): boolean {
  // port 0 means "ephemeral" (tests); compare against the port actually bound.
  const port = context.port === 0 ? (request.socket.localPort ?? context.port) : context.port;
  return isAllowedOrigin(headerValue(request, "origin"), { bind: context.bind, port });
}


export function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const mediaType = value.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}


export function requestId(request: IncomingMessage, body?: unknown): string {
  const header = headerValue(request, "x-request-id");
  if (header && header.length <= 128) {
    return header;
  }
  if (isObject(body) && typeof body.request_id === "string" && body.request_id.length <= 128 && body.request_id.length > 0) {
    return body.request_id;
  }
  return createUlid();
}

export const responseContexts = new WeakMap<ServerResponse, { request: IncomingMessage; compressionMinBytes: number }>();


function acceptsGzip(header: string | undefined): boolean {
  const qualities = new Map<string, number>();
  for (const part of (header ?? "").split(",")) {
    const [token, ...params] = part.trim().toLowerCase().split(";").map((item) => item.trim());
    const q = params.find((item) => item.startsWith("q="));
    qualities.set(token, q === undefined ? 1 : Number(q.slice(2)));
  }
  return (qualities.get("gzip") ?? qualities.get("*") ?? 0) > 0;
}


function etagMatches(header: string | undefined, etag: string): boolean {
  const bare = (value: string): string => value.replace(/^W\//u, "");
  return (header ?? "").split(",").some((part) => {
    const value = part.trim();
    return value === "*" || bare(value) === bare(etag);
  });
}


export function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string | readonly string[]> = {},
): void {
  const text = JSON.stringify(body);
  const context = responseContexts.get(response);
  const headers: Record<string, string | number | readonly string[]> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  };
  if (context !== undefined && context.request.method === "GET" && status === 200) {
    const { request_id: _requestId, ...rest } = body;
    // Envelope responses (with `data`) hash data + version; flat bodies (e.g. system status, whose `version` is an app version) are all treated as data.
    const stable = "data" in body ? { data: body.data, version: body.version } : { data: rest };
    const etag = `W/"${createHash("sha1").update(JSON.stringify(stable)).digest("base64url")}"`;
    if (etagMatches(context.request.headers["if-none-match"], etag)) {
      response.writeHead(304, { etag, "cache-control": "no-store", vary: "accept-encoding" });
      response.end();
      return;
    }
    headers.etag = etag;
    headers.vary = "accept-encoding";
    if (Buffer.byteLength(text) >= context.compressionMinBytes && acceptsGzip([context.request.headers["accept-encoding"]].flat().join(","))) {
      const compressed = gzipSync(text);
      response.writeHead(200, { ...headers, "content-encoding": "gzip", "content-length": compressed.byteLength });
      response.end(compressed);
      return;
    }
  }
  response.writeHead(status, { ...headers, "content-length": Buffer.byteLength(text) });
  response.end(text);
}


function hasValidUiSession(request: IncomingMessage): boolean {
  const cookieHeader = headerValue(request, "cookie");
  if (!cookieHeader) return false;
  const cookie = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${UI_SESSION_COOKIE}=`));
  const value = cookie?.slice(`${UI_SESSION_COOKIE}=`.length);
  if (!value) return false;
  const [expiresText, nonce, signature] = value.split(".");
  if (!expiresText || !nonce || !signature || !/^\d+$/.test(expiresText)) return false;
  if (Number(expiresText) <= Math.floor(Date.now() / 1000)) return false;
  const payload = `${expiresText}.${nonce}`;
  const expected = createHmac("sha256", UI_SESSION_SECRET).update(payload).digest("base64url");
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}


/**
 * Owner authentication policy. A UI session/CSRF value is deliberately a
 * loopback convenience only; a request arriving from another machine must
 * present the configured Bearer token even when it also carries a cookie.
 */
export function isOwnerRequestAuthorized(
  request: Pick<IncomingMessage, "headers" | "socket">,
  configuredToken = configuredApiToken(),
  uiSessionValid = hasValidUiSession(request as IncomingMessage),
): boolean {
  const authorization = headerValue(request as IncomingMessage, "authorization");
  const csrf = headerValue(request as IncomingMessage, "x-csrf-token");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : undefined;
  const loopback = isLoopback(request as IncomingMessage);
  if (!configuredToken) return loopback;
  if (!loopback) return bearer === configuredToken;
  return bearer === configuredToken || csrf === configuredToken || uiSessionValid;
}


export function logException(referenceId: string, context: string, error: unknown): void {
  const raw = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[${referenceId}] ${context}: ${raw}`);
}


export async function sendApiError(response: ServerResponse, requestIdValue: string, error: unknown, context: string, core: CorePort): Promise<void> {
  const language = await requestOwnerLanguage(core);
  const storageCode = knowledgeStorageErrorCode(error);
  if (storageCode === "knowledge_storage_unavailable" || storageCode === "knowledge_storage_moving") {
    const storageError = new ApiError(
      storageCode === "knowledge_storage_unavailable" ? 503 : 409,
      "dependency_unavailable",
      error instanceof Error ? error.message : HC.knowledgeStorageUnavailable(),
      isObject(error) && isObject(error.details) ? error.details : {},
    );
    const body = errorBody(requestIdValue, storageError, language);
    body.error.code = storageCode;
    sendJson(response, storageError.status, body);
    return;
  }
  if (error instanceof ApiError) {
    sendJson(response, error.status, errorBody(requestIdValue, error, language));
    return;
  }
  const referenceId = newReferenceId();
  logException(referenceId, context, error);
  const unexpected = new ApiError(500, "server_error", HC.unexpected(), { ref_id: referenceId });
  sendJson(response, unexpected.status, errorBody(requestIdValue, unexpected, language));
}


export async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  // JSON bodies must be declared as JSON. text/plain, form-urlencoded and
  // multipart are CORS-safelisted and can be sent cross-site without preflight.
  if (!isJsonContentType(headerValue(request, "content-type"))) {
    throw new ApiError(415, "unsupported_media_type", HC.contentType());
  }
  const contentLength = headerValue(request, "content-length");
  if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    throw new ApiError(400, "validation_error", HC.bodyTooLarge());
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new ApiError(400, "validation_error", HC.bodyTooLarge());
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) {
    throw new ApiError(400, "validation_error", HC.bodyEmpty());
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ApiError(400, "validation_error", HC.bodyNotJson(), {}, { cause: error });
  }
}


export async function readRawBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const contentLength = headerValue(request, "content-length");
  if (contentLength !== undefined && (!/^\d+$/u.test(contentLength) || Number(contentLength) > limit)) {
    throw new ApiError(413, "upload_too_large", HC.uploadTooLarge(), { max_bytes: limit });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new ApiError(413, "upload_too_large", HC.uploadTooLarge(), { max_bytes: limit });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}


export function exactKeys(value: JsonObject, required: readonly string[], label: string, optional: readonly string[] = []): void {
  const acceptedSet = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const extra = actual.filter((key) => !acceptedSet.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new ApiError(400, "validation_error", HC.keysMismatch({ label }), { missing, extra });
  }
}


export function stringField(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new ApiError(400, "validation_error", HC.stringLength({ label, min, max }));
  }
  return value;
}


export function nullableUlid(value: unknown, label: string): string | null {
  if (value !== null && !isUlid(value)) {
    throw new ApiError(400, "validation_error", HC.ulidOrNull({ label }));
  }
  return value;
}


export function commandEnvelope(value: unknown): { request_id: string; idempotency_key: string; expected_version: number; payload: JsonObject } {
  if (!isObject(value)) {
    throw new ApiError(400, "validation_error", HC.bodyNotObject());
  }
  exactKeys(value, ["request_id", "idempotency_key", "expected_version", "payload"], "command envelope");
  const request_id = stringField(value.request_id, "request_id", 1, 128);
  const idempotency_key = stringField(value.idempotency_key, "idempotency_key", 1, 128);
  if (!Number.isInteger(value.expected_version) || Number(value.expected_version) < 0) {
    throw new ApiError(400, "validation_error", HC.expectedVersion());
  }
  if (!isObject(value.payload)) {
    throw new ApiError(400, "validation_error", HC.payloadNotObject());
  }
  return { request_id, idempotency_key, expected_version: Number(value.expected_version), payload: value.payload };
}


function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}


function bodyHash(value: unknown): string {
  if (isObject(value)) {
    const { request_id: _requestId, ...idempotentBody } = value;
    return createHash("sha256").update(stableJson(idempotentBody), "utf8").digest("hex");
  }
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}


export async function withWorkLock<T>(context: RequestContext, workId: string, operation: () => Promise<T>): Promise<T> {
  const previous = context.workLocks.get(workId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  context.workLocks.set(workId, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (context.workLocks.get(workId) === queued) context.workLocks.delete(workId);
  }
}


interface IdempotencyLane {
  transact<T>(mutate: (transaction: { run(sql: string, ...parameters: (string | number)[]): unknown }) => T): Promise<T>;
}


/** The write lane of the Core DB, or null when this server has no DB (idempotency then stays in memory only). */
export function idempotencyLane(context: RequestContext): IdempotencyLane | null {
  const db = context.db as { createWriteLane?: () => IdempotencyLane; get?: unknown; all?: unknown } | null;
  return typeof db?.createWriteLane === "function" && typeof db.get === "function" && typeof db.all === "function" ? db.createWriteLane() : null;
}


async function loadPersistedCommand(context: RequestContext, lane: IdempotencyLane, key: string): Promise<StoredCommandResponse | undefined> {
  await lane.transact((transaction) => transaction.run("DELETE FROM idempotency_keys WHERE key LIKE ? AND expires_at <= ?", `${HTTP_IDEMPOTENCY_KEY_PREFIX}%`, new Date().toISOString()));
  const row = (context.db as AdvisorSessionReadDatabase).get<{ request_hash: string; response_json: string; status_code: number; expires_at: string }>(
    "SELECT request_hash, response_json, status_code, expires_at FROM idempotency_keys WHERE key = ?",
    HTTP_IDEMPOTENCY_KEY_PREFIX + key,
  );
  if (!row) return undefined;
  return { bodyHash: row.request_hash, status: row.status_code, body: JSON.parse(row.response_json) as Record<string, unknown>, expiresAt: Date.parse(row.expires_at) };
}


export function runCommand(
  context: RequestContext,
  routeKey: string,
  command: { request_id: string; idempotency_key: string; expected_version: number; payload: JsonObject },
  status: number,
  operation: () => Promise<{ data: JsonObject; version: number; request_id?: string }>,
  workId?: string,
): Promise<Record<string, unknown>> {
  const key = `${routeKey}:${command.idempotency_key}`;
  const scopedWorkId = workId ?? context.idempotency.get(key)?.workId ?? context.inFlight.get(key)?.workId;
  const run = (): Promise<Record<string, unknown>> => runCommandUnlocked(context, routeKey, command, status, operation, scopedWorkId);
  return scopedWorkId === undefined ? run() : withWorkLock(context, scopedWorkId, run);
}


export function decisionWorkId(context: RequestContext, decisionId: string): string | undefined {
  const db = context.db as AdvisorSessionReadDatabase | null;
  return db?.get<{ work_id: string }>("SELECT work_id FROM decisions WHERE id = ?", decisionId)?.work_id;
}


function runCommandUnlocked(
  context: RequestContext,
  routeKey: string,
  command: { request_id: string; idempotency_key: string; expected_version: number; payload: JsonObject },
  status: number,
  operation: () => Promise<{ data: JsonObject; version: number; request_id?: string }>,
  workId?: string,
): Promise<Record<string, unknown>> {
  const key = `${routeKey}:${command.idempotency_key}`;
  const hash = bodyHash(command);
  const conflict = () => new ApiError(409, "idempotency_conflict", HC.idempotencyConflict());
  const saved = context.idempotency.get(key);
  if (saved && saved.expiresAt > Date.now()) {
    if (saved.bodyHash !== hash) throw conflict();
    return Promise.resolve(saved.body);
  }
  context.idempotency.delete(key);
  const active = context.inFlight.get(key);
  if (active) {
    if (active.bodyHash !== hash) throw conflict();
    return active.promise;
  }
  const lane = idempotencyLane(context);
  const pending = (async () => {
    const persisted = lane ? await loadPersistedCommand(context, lane, key) : undefined;
    if (persisted) {
      if (persisted.bodyHash !== hash) throw conflict();
      context.idempotency.set(key, { ...persisted, ...(workId === undefined ? {} : { workId }) });
      return persisted.body;
    }
    const { data, version, request_id } = await operation();
    const response = { request_id: request_id ?? command.request_id, data, version };
    const now = Date.now();
    const stored: StoredCommandResponse = { bodyHash: hash, status, body: response, expiresAt: now + context.idempotencyTtlMs, ...(workId === undefined ? {} : { workId }) };
    context.idempotency.set(key, stored);
    if (context.idempotency.size > MAX_IDEMPOTENCY_ENTRIES) {
      const keys = Array.from(context.idempotency.keys());
      for (let i = 0; i < keys.length / 2; i++) {
        context.idempotency.delete(keys[i]);
      }
    }
    if (lane) {
      await lane.transact((transaction) => transaction.run(
        "INSERT OR REPLACE INTO idempotency_keys (key, request_hash, response_json, status_code, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        HTTP_IDEMPOTENCY_KEY_PREFIX + key, hash, JSON.stringify(response), status, new Date(now).toISOString(), new Date(stored.expiresAt).toISOString(),
      ));
    }
    return response;
  })();
  context.inFlight.set(key, { bodyHash: hash, promise: pending, ...(workId === undefined ? {} : { workId }) });
  void pending.finally(() => {
    if (context.inFlight.get(key)?.promise === pending) context.inFlight.delete(key);
  }).catch(() => undefined);
  return pending;
}


export function parseLimit(value: string | null, defaultValue: number): number {
  if (value === null || value === "") {
    return defaultValue;
  }
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, "invalid_query", HC.limit1to200());
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new ApiError(400, "invalid_query", HC.limit1to200());
  }
  return parsed;
}


export function parseViewLimit(value: string | null, defaultValue: number | undefined, max: number | undefined): number {
  if (value === null || value === "") {
    if (defaultValue === undefined) throw new ApiError(400, "invalid_query", HC.limitRequired());
    return defaultValue;
  }
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1 || (max !== undefined && parsed > max)) {
    throw new ApiError(400, "invalid_query", max === undefined ? HC.limitAtLeast1() : HC.limitUpTo({ max }));
  }
  return parsed;
}


export function parseBacklogLimit(value: string | null): number {
  if (value === null || value === "") return 500;
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, "validation_error", HC.limit1to500());
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new ApiError(400, "validation_error", HC.limit1to500());
  }
  return parsed;
}


export function parseBacklogOffset(value: string | null): number {
  if (value === null || value === "") return 0;
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, "validation_error", HC.offset());
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiError(400, "validation_error", HC.offset());
  }
  return parsed;
}


export function nullableQuery(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}


export function parseBoolean(value: string | null, defaultValue: boolean): boolean {
  if (value === null || value === "") {
    return defaultValue;
  }
  if (value !== "true" && value !== "false") {
    throw new ApiError(400, "invalid_query", HC.booleanQuery());
  }
  return value === "true";
}


export function pathId(value: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch (error) {
    throw new ApiError(400, "validation_error", HC.idUndecodable({ label }), {}, { cause: error });
  }
  if (!isUlid(decoded)) {
    throw new ApiError(400, "validation_error", HC.ulidUpper({ label }));
  }
  return decoded;
}


// 要求ごとの Advisor 資格情報の判定結果。WeakSet なので要求と一緒に消える
export const advisorAuthorizedRequests = new WeakSet<IncomingMessage>();


export function bearerOf(request: IncomingMessage): string {
  const authorization = headerValue(request, "authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
}


/** ループバックで live な role=advisor の guard token を示した要求なら、その agent。それ以外は null */
export function advisorRequestAgent(request: IncomingMessage, guardTokens: GuardTokenVerifier | null): GuardTokenAgent | null {
  const bearer = bearerOf(request);
  if (!bearer || !guardTokens || !isLoopback(request)) return null;
  const agent = guardTokens.verify(bearer);
  return agent?.role === "advisor" ? agent : null;
}


export function requireOwner(request: IncomingMessage): string {
  if (!isOwnerRequestAuthorized(request) && !advisorAuthorizedRequests.has(request)) {
    if (configuredApiToken() && !isLoopback(request)) {
      throw new ApiError(401, "unauthorized", HC.bearerRequired());
    }
    throw new ApiError(401, "unauthorized", HC.serviceTokenRequired());
  }
  return process.env.OWL_OWNER_ID?.trim() || "owner:default";
}


/**
 * Agent guard tokens are accepted only on loopback and only for the guard and
 * research capture endpoints. Returns the agent the token belongs to, or null when the owner
 * made the request. A bearer token that is neither a live guard token nor the
 * API token is refused, so a revoked token never falls back to owner access.
 */
export function requireGuard(request: IncomingMessage, guardTokens: GuardTokenVerifier | null): GuardTokenAgent | null {
  const authorization = headerValue(request, "authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (bearer.length > 0) {
    const agent = guardTokens && isLoopback(request) ? guardTokens.verify(bearer) : null;
    if (agent) return agent;
    if (bearer !== configuredApiToken()) {
      throw new ApiError(401, "unauthorized", HC.guardTokenInvalid());
    }
  }
  requireOwner(request);
  return null;
}


export function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", `http://${headerValue(request, "host") ?? "localhost"}`);
}


export function validateCreateWorkPayload(payload: JsonObject): {
  title: string;
  summary: string;
  size: "small" | "normal" | "large";
  project_id: string | null;
  design_mode?: "auto" | "lead";
  prerequisite_work_ids?: string[];
} {
  exactKeys({ ...payload, design_mode: payload.design_mode ?? "auto" }, ["title", "summary", "size", "project_id", "design_mode"], "CreateWork payload", ["prerequisite_work_ids"]);
  const title = stringField(payload.title, "title", 1, 500);
  const summary = stringField(payload.summary, "summary", 0, 20000);
  if (payload.size !== "small" && payload.size !== "normal" && payload.size !== "large") {
    throw new ApiError(400, "validation_error", HC.size());
  }
  const designMode = payload.design_mode ?? "auto";
  if (designMode !== "auto" && designMode !== "lead") {
    throw new ApiError(400, "validation_error", HC.designMode());
  }
  return {
    title, summary, size: payload.size, project_id: nullableUlid(payload.project_id, "project_id"),
    ...(payload.design_mode === undefined ? {} : { design_mode: designMode }),
    ...(payload.prerequisite_work_ids === undefined ? {} : { prerequisite_work_ids: prerequisiteWorkIds(payload.prerequisite_work_ids) }),
  };
}


export function prerequisiteWorkIds(value: unknown): string[] {
  try {
    return validatePrerequisiteWorkIds(value);
  } catch (error) {
    throw new ApiError(400, "validation_error", (error as Error).message, { field: "prerequisite_work_ids", reason: prerequisiteIdsReason(error) });
  }
}


export function validateStartPayload(payload: JsonObject): "normal" | "small" {
  exactKeys(payload, ["mode"], "StartWork payload");
  if (payload.mode !== "normal" && payload.mode !== "small") {
    throw new ApiError(400, "validation_error", HC.mode());
  }
  return payload.mode;
}


export function validateWorkInstructionPayload(payload: JsonObject): WorkInstructionInput {
  const extra = Object.keys(payload).filter((key) => key !== "body" && key !== "attachment_ids" && key !== "reopen");
  if (extra.length > 0) {
    throw new ApiError(400, "validation_error", HC.instructionKeys(), { missing: [], extra });
  }
  const { body, attachment_ids: attachmentIds } = validateMessageContent(payload.body, payload.attachment_ids ?? []);
  if (payload.reopen !== undefined && typeof payload.reopen !== "boolean") {
    throw new ApiError(400, "validation_error", HC.reopen());
  }
  return { body, attachment_ids: attachmentIds, ...(payload.reopen === undefined ? {} : { reopen: payload.reopen }) };
}


export function validateEmptyPayload(payload: JsonObject): void {
  exactKeys(payload, [], "Empty payload");
}


export function validateCancelPayload(payload: JsonObject): { reason: string; force: boolean } {
  exactKeys(payload, ["reason", "force"], "CancelWork payload");
  const reason = stringField(payload.reason, "reason", 1, 1000);
  if (typeof payload.force !== "boolean") {
    throw new ApiError(400, "validation_error", HC.force());
  }
  return { reason, force: payload.force };
}


/** A message needs text or at least one attachment. Whitespace-only text sent with files is stored as "". */
export function validateMessageContent(bodyValue: unknown, attachmentValue: unknown): PostMessageInput {
  const body = stringField(bodyValue, "body", 0, 100000);
  if (
    !Array.isArray(attachmentValue)
    || !attachmentValue.every((item) => typeof item === "string" && isUlid(item))
    || attachmentValue.length > MAX_MESSAGE_ATTACHMENTS
    || new Set(attachmentValue).size !== attachmentValue.length
  ) {
    throw new ApiError(400, "validation_error", HC.attachmentIds({ max: MAX_MESSAGE_ATTACHMENTS }));
  }
  const blank = body.trim().length === 0;
  if (blank && attachmentValue.length === 0) {
    throw new ApiError(400, "validation_error", HC.bodyOrAttachment());
  }
  return { body: blank ? "" : body, attachment_ids: attachmentValue as string[] };
}


const WORK_MARKDOWN_ERROR_STATUS: Readonly<Record<string, number>> = {
  validation_error: 400,
  markdown_path_denied: 403,
  work_not_found: 404,
  markdown_not_found: 404,
  markdown_not_integrated: 404,
  markdown_too_large: 413,
  markdown_unreadable: 422,
  // The owner-files route reuses this table and workMarkdownCall for the same reason.
  owner_file_denied: 403,
  owner_file_not_found: 404,
};


/** The .core path skips externalError, so give Core's domain codes their HTTP status here. */
export async function workMarkdownCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "";
    const status = Object.hasOwn(WORK_MARKDOWN_ERROR_STATUS, code) ? WORK_MARKDOWN_ERROR_STATUS[code] : undefined;
    if (status === undefined || error instanceof ApiError) throw error;
    throw new ApiError(status, code as ApiError["code"], error instanceof Error ? error.message : code, isObject((error as { details?: unknown }).details) ? (error as { details: Record<string, unknown> }).details : {}, { cause: error });
  }
}




const CHILD_RUN_ERROR_STATUS: Readonly<Record<string, number>> = {
  validation_error: 400, write_paths_invalid: 400, timeout_out_of_range: 400,
  parent_not_active: 409, too_many_children: 409, child_not_found: 404,
};


/** Core reports child-run failures with a domain code; give them their HTTP status. */
export async function childRunCall<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "";
    const status = Object.hasOwn(CHILD_RUN_ERROR_STATUS, code) ? CHILD_RUN_ERROR_STATUS[code] : undefined;
    if (status === undefined || error instanceof ApiError) throw error;
    throw new ApiError(status, code as ApiError["code"], error instanceof Error ? error.message : code, isObject((error as { details?: unknown }).details) ? (error as { details: Record<string, unknown> }).details : {}, { cause: error });
  }
}


export const advisorWindowFeature = (core: CorePort) => requireCoreFeature(core, [
  "listAdvisorWindows", "listAdvisorChannelBindings", "ensureAdvisorWindow", "getAdvisorChannelBinding", "findAdvisorChannelOwner",
  "bindAdvisorChannel", "updateAdvisorChannelName", "getAdvisorWindowSettings", "setAdvisorWindowSettings", "setAdvisorWindowOrder", "markAdvisorWindowRead",
], { code: "dependency_unavailable", message: HC.noAdvisorWindows() });

export const knowledgeStorageFeature = (core: CorePort) => requireCoreFeature(core, [
  "activeKnowledgeDir", "getKnowledgeStorage", "hasKnowledgeStorageEverBeenAvailable", "checkKnowledgeStorage", "moveKnowledgeStorage", "withKnowledgeAccess",
], { code: "dependency_unavailable", message: HC.noKnowledgeStorage() });

/** The Project an Advisor's window is dedicated to; null when the caller is not an Advisor or its window is not a Project window. */
export function advisorWindowProject(core: CorePort, advisor: GuardTokenAgent | null) {
  if (!advisor) return null;
  const port = requireCoreFeature(core, ["windowProjectForSession", "backlogItemProjects"],
    { code: "dependency_unavailable", message: HC.noAdvisorWindowScopes() });
  const projectId = port.windowProjectForSession(advisor.agent_run_id);
  return projectId === null ? null : { port, projectId };
}

export function windowScopeMismatch(windowProjectId: string, requestedProjectId: string | null): ApiError {
  return new ApiError(403, "window_scope_mismatch", HC.windowScope(), {
    window_project_id: windowProjectId,
    requested_project_id: requestedProjectId,
  });
}


export type ChannelProvider = "slack" | "discord";

export const CHANNEL_PROVIDERS: readonly ChannelProvider[] = ["slack", "discord"];

type ChannelOperation = "create" | "rename" | "describe" | "invite";


export async function integrationOf(context: RequestContext, provider: ChannelProvider): Promise<{ configured: boolean; channelIds: Set<string> }> {
  const status = (await context.core.getIntegrations()).find((integration) => integration.provider === provider);
  const ids = [status?.conversation_channel_id, status?.notification_channel_id]
    .flatMap((value) => parseChannelIds(value ?? undefined));
  return { configured: status?.configured ?? false, channelIds: new Set(ids) };
}


export async function requireChannelAdmin(context: RequestContext, provider: ChannelProvider): Promise<ChannelAdmin> {
  const admin = context.channelAdmins?.channelAdmin(provider) ?? null;
  if (admin) return admin;
  const { configured } = await integrationOf(context, provider);
  throw new ApiError(503, "integration_not_running", HC.channelNotRunning({ provider }), { provider, configured });
}


/** Maps a connector's ChannelAdminError to the API error of design section 14; anything else passes through. */
function channelAdminApiError(error: unknown, provider: ChannelProvider, operation: ChannelOperation): unknown {
  if (!isChannelAdminError(error)) return error;
  const providerCode = error.provider_code;
  switch (error.code) {
    case "permission_missing":
      return new ApiError(422, "integration_permission_missing", error.message, { provider, operation, needed: [...error.needed] });
    case "name_taken":
      return new ApiError(409, "channel_name_taken", error.message, { provider });
    case "invalid_name":
      return new ApiError(422, "validation_error", HC.channelNameInvalid({ provider }), { field: "name", provider, ...(providerCode ? { provider_code: providerCode } : {}), provider_message: error.message });
    case "not_found":
      return new ApiError(404, "channel_not_found", error.message, { provider });
    case "bot_not_in_channel":
      return new ApiError(422, "channel_bot_not_member", error.message, { provider, needed: [...error.needed] });
    case "not_authorized":
      return new ApiError(403, "integration_not_authorized", error.message, { provider });
    case "rate_limited":
      return new ApiError(429, "integration_rate_limited", error.message, { provider, retry_after_seconds: error.retry_after_seconds ?? null });
    default:
      return new ApiError(502, "integration_provider_error", error.message, { provider, provider_code: providerCode ?? null });
  }
}


export async function channelCall<T>(provider: ChannelProvider, operation: ChannelOperation, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw channelAdminApiError(error, provider, operation);
  }
}


export async function slackOwnerUserId(context: RequestContext): Promise<string> {
  const ownerUserId = (await context.core.getIntegrations()).find((integration) => integration.provider === "slack")?.owner_user_id ?? "";
  if (!ownerUserId) throw new ApiError(422, "owner_user_id_missing", HC.ownerIdMissing(), { provider: "slack" });
  return ownerUserId;
}


/** Slack's already_in_channel means the Owner is already there, so it counts as success. */
export async function inviteOwnerToChannel(admin: ChannelAdmin, channelId: string, ownerUserId: string): Promise<"invited" | "already_in_channel"> {
  try {
    await channelCall("slack", "invite", () => admin.inviteUsers(channelId, [ownerUserId]));
    return "invited";
  } catch (error) {
    if (error instanceof ApiError && error.details.provider_code === "already_in_channel") return "already_in_channel";
    throw error;
  }
}


export function windowChannelError(error: unknown): JsonObject {
  if (error instanceof ApiError) {
    const needed = error.details.needed;
    return { code: error.code, message: error.message, ...(Array.isArray(needed) ? { needed: needed as string[] } : {}) };
  }
  return { code: "server_error", message: error instanceof Error ? error.message : String(error) };
}


export function projectNameOf(context: RequestContext, key: string): string {
  return (context.db as AdvisorSessionReadDatabase | null)?.get<{ name: string }>("SELECT name FROM projects WHERE id = ?", key)?.name ?? "";
}


export function channelNameFromPayload(value: unknown, settings: AdvisorWindowSettings): string {
  if (typeof value !== "string") throw new ApiError(422, "validation_error", HC.nameNotString(), { field: "name" });
  const name = normalizeChannelName(value, settings);
  if (name.length === 0) throw new ApiError(422, "validation_error", HC.nameEmpty(), { field: "name" });
  return name;
}


export function knowledgeStorageErrorCode(error: unknown): string | null {
  return isObject(error) && typeof error.code === "string" ? error.code : null;
}


export function validateBacklogItemIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100 || !value.every(isUlid) || new Set(value).size !== value.length) {
    throw new ApiError(400, "validation_error", HC.itemIds(), { field: "item_ids" });
  }
  return value as string[];
}


export function decodeRouteValue(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    throw new ApiError(400, "validation_error", HC.undecodable({ label }), {}, { cause: error });
  }
}

export interface RouteRequest {
  readonly context: RequestContext;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly method: ApiMethod;
  /** WHATWG で正規化したパス。 */
  readonly pathname: string;
  /** request.url の ? より前。 */
  readonly rawPathname: string;
  readonly requestId: string;
  /** 当たった文字列。decodeOnPathMatch の変数だけは decode 済み。 */
  readonly params: Readonly<Record<string, string>>;
}

export interface ApiRoute extends RouteDefinition {
  handle(route: RouteRequest): Promise<void>;
}

const CHILD_RUN_KEYS = ["dispatchChildRun", "waitChildRuns", "listChildRuns", "getChildRunSettings", "setChildRunSettings"] as const;
const CHILD_RUN_UNAVAILABLE = { code: "dependency_unavailable", message: HC.noChildRuns() } as const;
/** 5個すべてを確かめる。1個でも無ければ 503。 */
export const childRunFeature = (core: CorePort) => requireAdapterFeature(core, CHILD_RUN_KEYS, CHILD_RUN_UNAVAILABLE);

/** 添付のアップロード。conversations と works の2つのルートが使う。 */
export async function handleAttachmentUpload(route: RouteRequest, kind: "works" | "conversations"): Promise<void> {
  const { context, request, response } = route;
  const ownerId = requireOwner(request);
  const id = route.params[kind === "works" ? "work_id" : "conversation_id"] as string;
  const target: WebAttachmentTarget = kind === "works"
    ? { work_id: pathId(id, "work_id") }
    : { conversation_id: pathId(id, "conversation_id") };
  const filenameHeader = headerValue(request, "x-owl-filename");
  const requestHeader = headerValue(request, "x-request-id");
  const idempotencyHeader = headerValue(request, "idempotency-key");
  const contentLengthHeader = headerValue(request, "content-length");
  if (!filenameHeader || !requestHeader || !idempotencyHeader || !contentLengthHeader || !/^\d+$/u.test(contentLengthHeader)) {
    throw new ApiError(400, "validation_error", HC.uploadHeaders());
  }
  let filename: string;
  try {
    filename = decodeURIComponent(filenameHeader);
  } catch (error) {
    throw new ApiError(400, "validation_error", HC.filenameUndecodable(), { field: "filename" }, { cause: error });
  }
  const requestIdText = stringField(requestHeader, "X-Request-Id", 1, 128);
  const idempotencyKey = stringField(idempotencyHeader, "Idempotency-Key", 1, 128);
  const content = await readRawBody(request, MAX_UPLOAD_BYTES);
  if (Number(contentLengthHeader) !== content.byteLength) throw new ApiError(400, "validation_error", HC.contentLength());
  const mime = headerValue(request, "content-type")?.trim() || "application/octet-stream";
  const data = await requireAdapterFeature(context.core, ["uploadWebAttachment"], { code: "dependency_unavailable", message: HC.noWebAttachments() }).uploadWebAttachment(
    ownerId,
    target,
    { filename, mime, content },
    { request_id: requestIdText, idempotency_key: idempotencyKey },
  );
  sendJson(response, 201, { data });
  return;
}
