import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Socket } from "node:net";

import { ApiError, type ApiErrorCode, errorBody, humanUnexpectedMessage, newReferenceId } from "./errors.js";
import { AdvisorFolderError } from "./advisor-folders.js";
import { listHostDirectories } from "./fs-directories.js";
import { createUlid, isUlid } from "./ids.js";
import { resolveDataDir, type ContractManifest } from "./contracts.js";
import { configuredApiToken } from "./config.js";
import { KnowledgeBase } from "../../../packages/core/dist/knowledge-base.js";
import { RuleStore } from "../../../packages/core/dist/rule-store.js";
import { KnowledgeAutomationValidationError, validateKnowledgeAutomationSettings } from "../../../packages/shared/dist/knowledge-automation.js";
import { isOwnerLanguage, type OwnerLanguage } from "../../../packages/shared/dist/owner-language.js";
import { ADVISOR_CURATION_ACTION_TYPES, advisorCurationKind, builtinProviderHarness, designDocumentPath, isRuleRole, RULE_ROLES } from "../../../packages/shared/dist/index.js";
import type { GuardTokenAgent } from "../../../packages/shared/dist/guard-token.js";
import { RESEARCH_CAPTURE_ROLES } from "../../../packages/shared/dist/permission-args.js";
import { extractWebResearchCapture } from "../../../packages/shared/dist/web-research.js";
import type { CoreEvent, CorePort, CreateProjectInput, DeleteProjectInput, InboundMessageInput, IntegrationConfigPatch, IntegrationProvider, JsonObject, PostMessageInput, Project, WorkInstructionInput, BacklogStatus, RoleModelSettingInput, ExecutorSettingsConfig, ProcessSkillsSettingsInput, RuntimeConfig, UpdateProjectInput, VerificationCommand, WorkConversation } from "./types.js";
import type { KnowledgeAutomationSettings } from "../../../packages/shared/dist/knowledge-automation.js";
import { browseProjectFolders, initializeExistingProjectFolder, initializeNewProjectFolder, inspectProjectFolder } from "./project-registration.js";

declare module "./types.js" {
  interface CorePort {
    listLearningJobs?(status?: string): unknown[];
    retryLearningJob?(jobId: string): Promise<void>;
    listRuleProposals?(status?: string): unknown[];
    createRuleProposalFromNote?(payload: JsonObject): Promise<unknown>;
    approveRuleProposal?(proposalId: string): Promise<unknown>;
    rejectRuleProposal?(proposalId: string): Promise<unknown>;
    migrateLegacyKnowledge?(input: { dry_run: boolean }): Promise<unknown>;
  }
}

const API_PREFIX = "/api/v1";
const STATIC_PREFIX = "/owl/";
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = 50 * 1024 * 1024;
const MAX_ADVISOR_PERSONA_LENGTH = 8_000;
const MAX_WEBSOCKET_MESSAGE_BYTES = 1024 * 1024;
/** Events sent per page while replaying missed history for a WebSocket `resume`. */
const WS_REPLAY_PAGE_SIZE = 500;
const MAX_IDEMPOTENCY_ENTRIES = 10000;
const UI_SESSION_COOKIE = "owl_ui_session";
const UI_SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
const UI_SESSION_SECRET = randomBytes(32);

const SYSTEM_RULE_TEXT_JA: Readonly<Record<string, string>> = {
  "block-git-force-push": "git push --force と git push -f は禁止されています。",
  "block-rm-root": "ルートまたはホームを含むディレクトリを rm -rf で削除する操作は禁止されています。",
  "block-rm-home": "ルートまたはホームを含むディレクトリを rm -rf で削除する操作は禁止されています。",
  "block-rm-home-env": "ルートまたはホームを含むディレクトリを rm -rf で削除する操作は禁止されています。",
  "block-sudo-rm": "sudo rm は禁止されています。",
  "block-git-reset-hard": "git reset --hard は禁止されています。",
  "block-git-clean-fdx": "git clean -fdx は禁止されています。",
  "block-env-files": ".env ファイルの読み取りは禁止されています。",
  "block-secrets-json": "secrets.json の読み取りは禁止されています。",
  "block-ssh-secrets": "~/.ssh 以下の読み取りは禁止されています。",
  "block-aws-secrets": "~/.aws 以下の読み取りは禁止されています。",
  "block-gh-secrets": "~/.config/gh 以下の読み取りは禁止されています。",
  "block-sqlite-file-writes": "data 内の SQLite ファイルへの直接書き込みや削除は禁止されています。",
  no_force_push: "強制pushは禁止。--force-with-lease を使う",
  no_rm_root: "ルートディレクトリの削除は禁止",
  no_rm_home: "ホームディレクトリの削除は禁止",
  no_sudo: "sudo rmは禁止",
  verify_before_done: "完了報告の前に、自分で動作確認をすること",
  no_secrets_in_code: "APIキー・パスワード・トークンをソースコードに直接書かないこと",
};

const RULE_RESULT_TEXT_JA: Readonly<Record<string, string>> = {
  "The command could not be parsed safely, so execution was denied.": "コマンドを安全に解析できないため実行を拒否しました。",
  "The command could not be determined because of environment variables or other indirection.": "環境変数などで実行コマンドを特定できないため拒否しました。",
  "The deletion target could not be parsed safely.": "削除対象を安全に解析できないため拒否しました。",
  "The path could not be parsed safely.": "パスを安全に解析できないため拒否しました。",
  "The write target path could not be parsed safely.": "書き込み先のパスを安全に解析できないため拒否しました。",
  "The read target path could not be parsed safely.": "読み取り対象のパスを安全に解析できないため拒否しました。",
};

function ownerRuleMessage(id: string, message: string, language: OwnerLanguage): string {
  if (language === "en") return message;
  if (SYSTEM_RULE_TEXT_JA[id]) return SYSTEM_RULE_TEXT_JA[id];
  if (RULE_RESULT_TEXT_JA[message]) return RULE_RESULT_TEXT_JA[message];
  if (message.startsWith("Blocked command: ")) return `禁止コマンド: ${message.slice("Blocked command: ".length)}`;
  const path = /^Blocked path \((read|write|both)\): (.*)$/u.exec(message);
  return path ? `禁止パス(${path[1]}): ${path[2]}` : message;
}

async function requestOwnerLanguage(core: CorePort): Promise<OwnerLanguage> {
  if (typeof core.getLanguage !== "function") return "ja";
  try {
    return await core.getLanguage();
  } catch {
    return "ja";
  }
}

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
  readonly ruleStore?: RuleStore;
  /** Verifies the per-process tokens agent permission hooks send to the guard endpoint. */
  readonly guardTokens?: GuardTokenVerifier;
}

export interface GuardTokenVerifier {
  verify(token: string): GuardTokenAgent | null;
}

export interface OwlHttpServer {
  readonly server: Server;
  readonly runtimeConfig: RuntimeConfig;
  listen(): Promise<void>;
  close(): Promise<void>;
}

interface StoredCommandResponse {
  readonly bodyHash: string;
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly workId?: string;
}

interface InFlightCommand {
  readonly bodyHash: string;
  readonly promise: Promise<Record<string, unknown>>;
  readonly workId?: string;
}

interface RequestContext {
  readonly core: CorePort;
  readonly db: unknown;
  readonly webOut: string;
  readonly bind: string;
  readonly port: number;
  readonly contract: ContractManifest;
  readonly dataDir: string;
  readonly idempotency: Map<string, StoredCommandResponse>;
  readonly inFlight: Map<string, InFlightCommand>;
  readonly workLocks: Map<string, Promise<void>>;
  readonly websocketSockets: Set<Socket>;
  shuttingDown: boolean;
  readonly knowledge: KnowledgeBase;
  readonly ruleStore: RuleStore;
  readonly guardTokens: GuardTokenVerifier | null;
}

interface SessionSummaryPayload {
  title: string;
  facts: string[];
  decisions: string[];
  open_threads: string[];
  related_work_ids: string[];
  tags: string[];
}

interface MemorySaverApi {
  saveManualSnapshot(summary: SessionSummaryPayload): Promise<string>;
  saveExplicitMemory(text: string, tags?: string[]): Promise<string>;
}

interface FeatureCorePort extends CorePort {
  readonly memorySaver: MemorySaverApi;
  listLearningJobs(status?: string): unknown[];
  retryLearningJob(jobId: string): Promise<void>;
}

interface SkillCommandResult {
  readonly data: JsonObject;
  readonly version: number;
}

interface SkillApiPort {
  getSkillActivity(days: number): unknown;
  listSkills(filter: { query?: string; state?: string; scope?: string; trial?: boolean }): unknown[];
  getSkill(name: string): Promise<JsonObject>;
  readSkillFile(name: string, path: string): Promise<string>;
  listSkillRevisions(name: string): unknown[];
  getSkillRevision(name: string, revisionId: string): JsonObject;
  restoreSkill(name: string, revisionId: string): Promise<SkillCommandResult>;
  updateSkill(name: string, patch: { state?: string; scope?: string }): Promise<SkillCommandResult>;
  listSkillProposals(status?: string): unknown[];
  approveSkillProposal(proposalId: string): Promise<SkillCommandResult>;
  rejectSkillProposal(proposalId: string): Promise<SkillCommandResult>;
  getSkillSettings(): JsonObject;
  setSkillSettings(value: unknown): Promise<SkillCommandResult>;
}

interface RuleProposalApiPort {
  listRuleProposals(status?: string): unknown[];
  createRuleProposalFromNote(payload: JsonObject): Promise<unknown>;
  approveRuleProposal(proposalId: string): Promise<unknown>;
  rejectRuleProposal(proposalId: string): Promise<unknown>;
}

interface KnowledgeMigrationApiPort {
  migrateLegacyKnowledge(input: { dry_run: boolean }): Promise<unknown>;
}

interface KnowledgeRetagApiPort {
  retagKnowledgeNotes(input: { dry_run: boolean; force?: boolean }): Promise<unknown>;
}

interface KnowledgeStorageApiPort {
  activeKnowledgeDir(): string;
  getKnowledgeStorage(): { custom: boolean; state: string };
  hasKnowledgeStorageEverBeenAvailable(): boolean;
  checkKnowledgeStorage(): Promise<{ custom: boolean; state: string }>;
  moveKnowledgeStorage(input: { path: string; mode?: "move" | "relink" }): Promise<unknown>;
  withKnowledgeAccess<T>(kind: "read" | "write", fn: () => Promise<T>): Promise<T>;
}

interface WorkConversationApiPort {
  getWorkConversation(workId: string, opts: { limit: number }): Promise<WorkConversation>;
}

interface CurationApiPort {
  runCuration(input: JsonObject): Promise<{ id: string; status: string; summary: string; error: string | null; report: unknown }>;
  listCurationRuns(query: JsonObject): { items: readonly unknown[]; next_cursor: string | null };
  getCurationRun(id: string): unknown;
}

interface BacklogApiPort {
  listBacklogItems(filter: { status?: string; project_id?: string; work_id?: string; issued_work_id?: string; limit: number; offset: number }): { items: unknown[]; next_offset: number | null };
  dismissBacklogItems(request: JsonObject): Promise<SkillCommandResult>;
  issueBacklogWork(request: JsonObject): Promise<SkillCommandResult>;
  linkBacklogItems(workId: string, request: JsonObject): Promise<SkillCommandResult>;
}

interface AdvisorSessionReadDatabase {
  get<T extends object>(sql: string, ...parameters: (string | number | bigint | Buffer | null)[]): T | undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function isLoopback(request: IncomingMessage): boolean {
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
function assertSameOriginWrite(request: IncomingMessage, context: Pick<RequestContext, "bind" | "port">): void {
  const method = (request.method ?? "GET").toUpperCase();
  if (SAFE_METHODS.has(method)) return;
  if (headerValue(request, "sec-fetch-site")?.toLowerCase() === "cross-site") {
    throw new ApiError(403, "forbidden", "別サイトからの状態変更requestは受け付けません。Owl Web UIから操作してください。");
  }
  if (!isRequestOriginAllowed(request, context)) {
    throw new ApiError(403, "forbidden", "許可されていないOriginからの状態変更requestは受け付けません。Owl Web UIから操作してください。");
  }
}

/** Shared Origin gate for state-changing HTTP requests and WebSocket upgrades. */
function isRequestOriginAllowed(request: IncomingMessage, context: Pick<RequestContext, "bind" | "port">): boolean {
  // port 0 means "ephemeral" (tests); compare against the port actually bound.
  const port = context.port === 0 ? (request.socket.localPort ?? context.port) : context.port;
  return isAllowedOrigin(headerValue(request, "origin"), { bind: context.bind, port });
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const mediaType = value.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

function requestId(request: IncomingMessage, body?: unknown): string {
  const header = headerValue(request, "x-request-id");
  if (header && header.length <= 128) {
    return header;
  }
  if (isObject(body) && typeof body.request_id === "string" && body.request_id.length <= 128 && body.request_id.length > 0) {
    return body.request_id;
  }
  return createUlid();
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string | readonly string[]> = {},
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(text);
}

function createUiSessionValue(): string {
  const expiresAt = Math.floor(Date.now() / 1000) + UI_SESSION_MAX_AGE_SECONDS;
  const payload = `${expiresAt}.${randomBytes(16).toString("hex")}`;
  const signature = createHmac("sha256", UI_SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
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

function logException(referenceId: string, context: string, error: unknown): void {
  const raw = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[${referenceId}] ${context}: ${raw}`);
}

async function sendApiError(response: ServerResponse, requestIdValue: string, error: unknown, context: string, core: CorePort): Promise<void> {
  const language = await requestOwnerLanguage(core);
  const storageCode = knowledgeStorageErrorCode(error);
  if (storageCode === "knowledge_storage_unavailable" || storageCode === "knowledge_storage_moving") {
    const storageError = new ApiError(
      storageCode === "knowledge_storage_unavailable" ? 503 : 409,
      "dependency_unavailable",
      error instanceof Error ? error.message : "The knowledge storage is unavailable.",
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
  const unexpected = new ApiError(500, "server_error", humanUnexpectedMessage(language), { ref_id: referenceId });
  sendJson(response, unexpected.status, errorBody(requestIdValue, unexpected, language));
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  // JSON bodies must be declared as JSON. text/plain, form-urlencoded and
  // multipart are CORS-safelisted and can be sent cross-site without preflight.
  if (!isJsonContentType(headerValue(request, "content-type"))) {
    throw new ApiError(415, "unsupported_media_type", "リクエスト本文はContent-Type: application/jsonで送信してください。");
  }
  const contentLength = headerValue(request, "content-length");
  if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    throw new ApiError(400, "validation_error", "リクエスト本文のサイズが上限を超えています。入力を短くして再試行してください。");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new ApiError(400, "validation_error", "リクエスト本文のサイズが上限を超えています。入力を短くして再試行してください。");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) {
    throw new ApiError(400, "validation_error", "リクエスト本文が空です。契約どおりのJSONを送信してください。");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ApiError(400, "validation_error", "リクエスト本文をJSONとして解釈できません。JSON形式を確認して再試行してください。", {}, { cause: error });
  }
}

async function readRawBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const contentLength = headerValue(request, "content-length");
  if (contentLength !== undefined && (!/^\d+$/u.test(contentLength) || Number(contentLength) > limit)) {
    throw new ApiError(413, "upload_too_large", "リクエスト本文が許可されたuploadサイズを超えています。");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new ApiError(413, "upload_too_large", "リクエスト本文が許可されたuploadサイズを超えています。");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function exactKeys(value: JsonObject, required: readonly string[], label: string, optional: readonly string[] = []): void {
  const acceptedSet = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const extra = actual.filter((key) => !acceptedSet.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new ApiError(400, "validation_error", `${label}の項目が契約と一致しません。必須項目と余分な項目を確認してください。`, { missing, extra });
  }
}

function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

function validatedKnowledgeAutomationSettings(value: unknown): KnowledgeAutomationSettings {
  try {
    return validateKnowledgeAutomationSettings(value);
  } catch (error) {
    if (error instanceof KnowledgeAutomationValidationError) {
      throw new ApiError(400, "validation_error", error.message, { field: error.field });
    }
    throw error;
  }
}

function stringField(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new ApiError(400, "validation_error", `${label}が不正です。${min}〜${max}文字で指定してください。`);
  }
  return value;
}

function nullableUlid(value: unknown, label: string): string | null {
  if (value !== null && !isUlid(value)) {
    throw new ApiError(400, "validation_error", `${label}が不正です。26文字の大文字ULIDまたはnullを指定してください。`);
  }
  return value;
}

function commandEnvelope(value: unknown): { request_id: string; idempotency_key: string; expected_version: number; payload: JsonObject } {
  if (!isObject(value)) {
    throw new ApiError(400, "validation_error", "リクエスト本文はJSON objectで指定してください。項目を確認して再試行してください。");
  }
  exactKeys(value, ["request_id", "idempotency_key", "expected_version", "payload"], "command envelope");
  const request_id = stringField(value.request_id, "request_id", 1, 128);
  const idempotency_key = stringField(value.idempotency_key, "idempotency_key", 1, 128);
  if (!Number.isInteger(value.expected_version) || Number(value.expected_version) < 0) {
    throw new ApiError(400, "validation_error", "expected_versionが不正です。0以上の整数を指定してください。");
  }
  if (!isObject(value.payload)) {
    throw new ApiError(400, "validation_error", "payloadが不正です。JSON objectを指定してください。");
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

async function withWorkLock<T>(context: RequestContext, workId: string, operation: () => Promise<T>): Promise<T> {
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

function invalidateWorkCommandCache(context: RequestContext, workId: string, preserveKey: string): void {
  const belongsToWork = (key: string): boolean => {
    const prefix = `${API_PREFIX}/works/`;
    if (!key.startsWith(prefix)) return false;
    const tail = key.slice(prefix.length);
    const separator = tail.search(/[/:]/);
    if (separator < 0) return false;
    try {
      return decodeURIComponent(tail.slice(0, separator)) === workId;
    } catch {
      return false;
    }
  };
  for (const key of context.idempotency.keys()) {
    if (key !== preserveKey && (context.idempotency.get(key)?.workId === workId || belongsToWork(key))) context.idempotency.delete(key);
  }
  for (const key of context.inFlight.keys()) {
    if (key !== preserveKey && (context.inFlight.get(key)?.workId === workId || belongsToWork(key))) context.inFlight.delete(key);
  }
}

function runCommand(
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

function decisionWorkId(context: RequestContext, decisionId: string): string | undefined {
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
  const saved = context.idempotency.get(key);
  if (saved) {
    if (saved.bodyHash !== hash) {
      throw new ApiError(409, "idempotency_conflict", "同じidempotency_keyに異なる内容が指定されています。新しいkeyで再試行してください。");
    }
    return Promise.resolve(saved.body);
  }
  const active = context.inFlight.get(key);
  if (active) {
    if (active.bodyHash !== hash) {
      throw new ApiError(409, "idempotency_conflict", "同じidempotency_keyに異なる内容が指定されています。新しいkeyで再試行してください。");
    }
    return active.promise;
  }
  const pending = operation().then(({ data, version, request_id }) => {
    const response = { request_id: request_id ?? command.request_id, data, version };
    context.idempotency.set(key, { bodyHash: hash, status, body: response, ...(workId === undefined ? {} : { workId }) });
    if (context.idempotency.size > MAX_IDEMPOTENCY_ENTRIES) {
      const keys = Array.from(context.idempotency.keys());
      for (let i = 0; i < keys.length / 2; i++) {
        context.idempotency.delete(keys[i]);
      }
    }
    return response;
  });
  context.inFlight.set(key, { bodyHash: hash, promise: pending, ...(workId === undefined ? {} : { workId }) });
  void pending.finally(() => {
    if (context.inFlight.get(key)?.promise === pending) context.inFlight.delete(key);
  }).catch(() => undefined);
  return pending;
}

function parseLimit(value: string | null, defaultValue: number): number {
  if (value === null || value === "") {
    return defaultValue;
  }
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, "invalid_query", "limitが不正です。1〜200の整数を指定してください。");
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new ApiError(400, "invalid_query", "limitが不正です。1〜200の整数を指定してください。");
  }
  return parsed;
}

function parseBacklogLimit(value: string | null): number {
  if (value === null || value === "") return 500;
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, "validation_error", "limitが不正です。1〜500の整数を指定してください。");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new ApiError(400, "validation_error", "limitが不正です。1〜500の整数を指定してください。");
  }
  return parsed;
}

function parseBacklogOffset(value: string | null): number {
  if (value === null || value === "") return 0;
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, "validation_error", "offsetが不正です。0以上の整数を指定してください。");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiError(400, "validation_error", "offsetが不正です。0以上の整数を指定してください。");
  }
  return parsed;
}

function parseArchived(value: string | null): "exclude" | "include" | "only" {
  if (value === null || value === "exclude" || value === "include" || value === "only") {
    return value ?? "exclude";
  }
  throw new ApiError(400, "invalid_query", "archivedが不正です。exclude、include、onlyのいずれかを指定してください。");
}

function nullableQuery(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}

function parseBoolean(value: string | null, defaultValue: boolean): boolean {
  if (value === null || value === "") {
    return defaultValue;
  }
  if (value !== "true" && value !== "false") {
    throw new ApiError(400, "invalid_query", "boolean queryが不正です。trueまたはfalseを指定してください。");
  }
  return value === "true";
}

function pathId(value: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch (error) {
    throw new ApiError(400, "validation_error", `${label}を解釈できません。IDを確認して再試行してください。`, {}, { cause: error });
  }
  if (!isUlid(decoded)) {
    throw new ApiError(400, "validation_error", `${label}が不正です。26文字の大文字ULIDを指定してください。`);
  }
  return decoded;
}

function requireOwner(request: IncomingMessage): string {
  if (!isOwnerRequestAuthorized(request)) {
    if (configuredApiToken() && !isLoopback(request)) {
      throw new ApiError(401, "unauthorized", "外部接続には正しいAuthorization: Bearer <OWL_API_TOKEN>が必要です。local cookieは外部経路では使用できません。");
    }
    throw new ApiError(401, "unauthorized", "外部接続にはservice tokenが必要です。Bearer tokenを指定してください。");
  }
  return process.env.OWL_OWNER_ID?.trim() || "owner:default";
}

function requireRuleProposalOwner(request: IncomingMessage): string {
  try {
    return requireOwner(request);
  } catch (error) {
    if (error instanceof ApiError && error.code === "unauthorized") {
      throw new ApiError(403, "forbidden", "Only the Owner can access rule proposals.");
    }
    throw error;
  }
}

/**
 * Agent guard tokens are accepted only on loopback and only for the guard and
 * research capture endpoints. Returns the agent the token belongs to, or null when the owner
 * made the request. A bearer token that is neither a live guard token nor the
 * API token is refused, so a revoked token never falls back to owner access.
 */
function requireGuard(request: IncomingMessage, guardTokens: GuardTokenVerifier | null): GuardTokenAgent | null {
  const authorization = headerValue(request, "authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (bearer.length > 0) {
    const agent = guardTokens && isLoopback(request) ? guardTokens.verify(bearer) : null;
    if (agent) return agent;
    if (bearer !== configuredApiToken()) {
      throw new ApiError(401, "unauthorized", "guard tokenが無効か失効しています。Agentを再実行してください。");
    }
  }
  requireOwner(request);
  return null;
}

function advisorSessionDatabase(value: unknown): AdvisorSessionReadDatabase | null {
  if (!isObject(value) || typeof value.get !== "function") return null;
  return value as unknown as AdvisorSessionReadDatabase;
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", `http://${headerValue(request, "host") ?? "localhost"}`);
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
    throw new ApiError(405, "validation_error", "静的配信はGETで取得してください。HTTP methodを確認してください。");
  }
  const suffix = pathname.slice(STATIC_PREFIX.length);
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(suffix || "index.html");
  } catch (error) {
    throw new ApiError(400, "validation_error", "静的ファイルのpathを解釈できません。URLを確認して再試行してください。", {}, { cause: error });
  }
  const candidate = resolve(webOut, relativePath || "index.html");
  const relativeCandidate = relative(webOut, candidate);
  if (relativeCandidate === ".." || relativeCandidate.startsWith("../") || relativeCandidate.includes("\\")) {
    throw new ApiError(404, "not_found", "指定された静的ファイルが見つかりません。URLを確認してください。");
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
      throw new ApiError(404, "not_found", "指定された静的ファイルが見つかりません。URLを確認してください。", {}, { cause: error });
    }
    throw error;
  }
}

function validateCreateWorkPayload(payload: JsonObject): {
  title: string;
  summary: string;
  size: "small" | "normal" | "large";
  project_id: string | null;
  design_mode?: "auto" | "lead";
} {
  exactKeys({ ...payload, design_mode: payload.design_mode ?? "auto" }, ["title", "summary", "size", "project_id", "design_mode"], "CreateWork payload");
  const title = stringField(payload.title, "title", 1, 500);
  const summary = stringField(payload.summary, "summary", 0, 20000);
  if (payload.size !== "small" && payload.size !== "normal" && payload.size !== "large") {
    throw new ApiError(400, "validation_error", "sizeが不正です。small、normal、largeのいずれかを指定してください。");
  }
  const designMode = payload.design_mode ?? "auto";
  if (designMode !== "auto" && designMode !== "lead") {
    throw new ApiError(400, "validation_error", "design_modeはautoまたはleadを指定してください。");
  }
  return { title, summary, size: payload.size, project_id: nullableUlid(payload.project_id, "project_id"), ...(payload.design_mode === undefined ? {} : { design_mode: designMode }) };
}

function validateStartPayload(payload: JsonObject): "normal" | "small" {
  exactKeys(payload, ["mode"], "StartWork payload");
  if (payload.mode !== "normal" && payload.mode !== "small") {
    throw new ApiError(400, "validation_error", "modeが不正です。normalまたはsmallを指定してください。");
  }
  return payload.mode;
}

function validatePausePayload(payload: JsonObject): string {
  exactKeys(payload, ["reason"], "PauseWork payload");
  return stringField(payload.reason, "reason", 0, 1000);
}

/** ReopenWork payload: `reason` is optional, but when present must be a non-blank string. */
function validateReopenPayload(payload: JsonObject): string {
  const extra = Object.keys(payload).filter((key) => key !== "reason");
  if (extra.length > 0) {
    throw new ApiError(400, "validation_error", "ReopenWork payloadの項目が契約と一致しません。余分な項目を除いてください。", { missing: [], extra });
  }
  if (payload.reason === undefined) return "";
  const reason = stringField(payload.reason, "reason", 1, 1000);
  if (reason.trim().length === 0) {
    throw new ApiError(400, "validation_error", "reasonが不正です。1〜1000文字で指定してください。");
  }
  return reason;
}

function validateWorkInstructionPayload(payload: JsonObject): WorkInstructionInput {
  const extra = Object.keys(payload).filter((key) => key !== "body" && key !== "attachment_ids" && key !== "reopen");
  if (extra.length > 0) {
    throw new ApiError(400, "validation_error", "Work指示のpayloadの項目が契約と一致しません。余分な項目を除いてください。", { missing: [], extra });
  }
  const body = stringField(payload.body, "body", 1, 100000);
  if (body.trim().length === 0) {
    throw new ApiError(400, "validation_error", "bodyが不正です。空白以外の文字を含めてください。");
  }
  const attachmentIds = payload.attachment_ids ?? [];
  if (!Array.isArray(attachmentIds) || !attachmentIds.every((item) => typeof item === "string")) {
    throw new ApiError(400, "validation_error", "attachment_idsが不正です。文字列の配列を指定してください。");
  }
  if (payload.reopen !== undefined && typeof payload.reopen !== "boolean") {
    throw new ApiError(400, "validation_error", "reopenが不正です。trueまたはfalseを指定してください。");
  }
  return { body, attachment_ids: attachmentIds as string[], ...(payload.reopen === undefined ? {} : { reopen: payload.reopen }) };
}

function validateUpdateWorkPayload(payload: JsonObject): { title?: string; summary?: string } {
  const hasTitle = Object.hasOwn(payload, "title");
  const hasSummary = Object.hasOwn(payload, "summary");
  if (!hasTitle && !hasSummary) throw new ApiError(400, "validation_error", "titleまたはsummaryを指定してください。");
  const title = hasTitle ? stringField(payload.title, "title", 1, 500) : undefined;
  if (title !== undefined && title.trim().length === 0) {
    throw new ApiError(400, "validation_error", "titleは空白以外の文字を含めてください。");
  }
  const summary = hasSummary ? stringField(payload.summary, "summary", 0, 20000) : undefined;
  return {
    ...(title === undefined ? {} : { title: title.trim() }),
    ...(summary === undefined ? {} : { summary: summary.trim() }),
  };
}

function validateEmptyPayload(payload: JsonObject): void {
  exactKeys(payload, [], "Empty payload");
}

function stringArrayField(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ApiError(400, "validation_error", `${label}が不正です。文字列の配列を指定してください。`);
  }
  return value as string[];
}

function validateSessionSummaryPayload(value: unknown): SessionSummaryPayload {
  if (!isObject(value)) {
    throw new ApiError(400, "validation_error", "SessionSummaryはJSON objectで指定してください。項目を確認して再試行してください。");
  }
  exactKeys(value, ["title", "facts", "decisions", "open_threads", "related_work_ids", "tags"], "SessionSummary");
  return {
    title: stringField(value.title, "title", 0, 10000),
    facts: stringArrayField(value.facts, "facts"),
    decisions: stringArrayField(value.decisions, "decisions"),
    open_threads: stringArrayField(value.open_threads, "open_threads"),
    related_work_ids: stringArrayField(value.related_work_ids, "related_work_ids"),
    tags: stringArrayField(value.tags, "tags"),
  };
}

function validateExplicitMemoryPayload(value: unknown): { text: string; tags: string[] } {
  if (!isObject(value)) {
    throw new ApiError(400, "validation_error", "Explicit memoryはJSON objectで指定してください。項目を確認して再試行してください。");
  }
  const allowed = new Set(["text", "tags"]);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (!Object.prototype.hasOwnProperty.call(value, "text") || extra.length > 0) {
    throw new ApiError(400, "validation_error", "Explicit memoryの項目が契約と一致しません。textを指定し、余分な項目を除いてください。", {
      missing: Object.prototype.hasOwnProperty.call(value, "text") ? [] : ["text"],
      extra,
    });
  }
  return {
    text: stringField(value.text, "text", 1, 500000),
    tags: value.tags === undefined ? [] : stringArrayField(value.tags, "tags"),
  };
}

function validateCancelPayload(payload: JsonObject): { reason: string; force: boolean } {
  exactKeys(payload, ["reason", "force"], "CancelWork payload");
  const reason = stringField(payload.reason, "reason", 1, 1000);
  if (typeof payload.force !== "boolean") {
    throw new ApiError(400, "validation_error", "forceが不正です。booleanを指定してください。");
  }
  return { reason, force: payload.force };
}

const ANSWER_SOURCES = ["web", "slack", "discord"] as const;
type AnswerSource = (typeof ANSWER_SOURCES)[number];

function validateAnswerPayload(payload: JsonObject): { answer: string; option_key: string | null; source: AnswerSource; source_message_id: string | null } {
  exactKeys(payload, ["answer", "option_key", "source", "source_message_id"], "AnswerDecision payload");
  const answer = stringField(payload.answer, "answer", 1, 10000);
  const option_key = payload.option_key === null ? null : stringField(payload.option_key, "option_key", 1, 10000);
  if (typeof payload.source !== "string" || !ANSWER_SOURCES.includes(payload.source as AnswerSource)) {
    throw new ApiError(400, "validation_error", "sourceはweb, slack, discordのいずれかで指定してください。", { field: "source" });
  }
  const source = payload.source as AnswerSource;
  const source_message_id = payload.source_message_id === null ? null : stringField(payload.source_message_id, "source_message_id", 0, 10000);
  return { answer, option_key, source, source_message_id };
}

export function validateIntegrationPayload(
  payload: JsonObject,
  provider: IntegrationProvider,
  existingConfigured: boolean,
): IntegrationConfigPatch {
  const allowed = new Set([
    "bot_token",
    "app_token",
    "signing_secret",
    "channel_id",
    "conversation_channel_id",
    "notification_channel_id",
    "account_id",
  ]);
  const extra = Object.keys(payload).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new ApiError(400, "validation_error", "Integration設定に未対応の項目があります。", { extra });
  }

  const result: IntegrationConfigPatch = {};
  const stringFields: Array<keyof IntegrationConfigPatch> = [
    "bot_token",
    "app_token",
    "signing_secret",
    "channel_id",
    "conversation_channel_id",
    "notification_channel_id",
    "account_id",
  ];
  for (const field of stringFields) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    if (typeof payload[field] !== "string") {
      throw new ApiError(400, "validation_error", `${field}は文字列で指定してください。`, { field });
    }
    const value = (payload[field] as string).trim();
    const max = field === "account_id" ? 26 : 4096;
    if (value.length === 0 || value.length > max) {
      throw new ApiError(400, "validation_error", `${field}が不正です。1〜${max}文字で指定してください。`, { field });
    }
    result[field] = value;
  }

  if (result.account_id !== undefined && !isUlid(result.account_id)) {
    throw new ApiError(400, "validation_error", "account_idはcanonical ULIDで指定してください。", { field: "account_id" });
  }
  if (!existingConfigured) {
    if (!result.bot_token) {
      throw new ApiError(400, "validation_error", "bot_tokenは必須です。Slack/DiscordのBot Tokenを入力してください。", { field: "bot_token" });
    }
    if (provider === "slack" && !result.app_token) {
      throw new ApiError(400, "validation_error", "Slack連携にはapp_token（Socket Mode用）も必要です。", { field: "app_token" });
    }
    if (!result.channel_id && !result.conversation_channel_id && !result.notification_channel_id) {
      throw new ApiError(400, "validation_error", "会話用または通知用のチャンネルIDが必要です。", { field: "conversation_channel_id" });
    }
  }
  return result;
}

const MODEL_SETTING_ROLES = new Set(["advisor", "manager", "designer", "lead_designer", "worker", "reviewer", "librarian", "curator"]);
const MODEL_SETTING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function validateVerificationCommand(value: unknown, index: number): VerificationCommand {
  if (!isObject(value)) {
    throw new ApiError(400, "validation_error", `verification_plan[${index}]はJSON objectで指定してください。`);
  }
  exactKeys(value, ["command_id", "argv", "cwd", "env_allowlist", "timeout_seconds", "stdout_limit", "stderr_limit", "expected_exit_codes", "executor"], `verification_plan[${index}]`);
  const command_id = stringField(value.command_id, `verification_plan[${index}].command_id`, 1, 200);
  if (!Array.isArray(value.argv) || value.argv.length < 1 || !value.argv.every((item) => typeof item === "string")) {
    throw new ApiError(400, "validation_error", `verification_plan[${index}].argvが不正です。文字列の配列(1件以上)を指定してください。`);
  }
  const cwd = stringField(value.cwd, `verification_plan[${index}].cwd`, 1, 4096);
  if (!Array.isArray(value.env_allowlist) || !value.env_allowlist.every((item) => typeof item === "string")) {
    throw new ApiError(400, "validation_error", `verification_plan[${index}].env_allowlistが不正です。文字列の配列を指定してください。`);
  }
  if (!Number.isInteger(value.timeout_seconds) || Number(value.timeout_seconds) <= 0) {
    throw new ApiError(400, "validation_error", `verification_plan[${index}].timeout_secondsが不正です。正の整数を指定してください。`);
  }
  if (!Number.isInteger(value.stdout_limit) || Number(value.stdout_limit) <= 0) {
    throw new ApiError(400, "validation_error", `verification_plan[${index}].stdout_limitが不正です。正の整数を指定してください。`);
  }
  if (!Number.isInteger(value.stderr_limit) || Number(value.stderr_limit) <= 0) {
    throw new ApiError(400, "validation_error", `verification_plan[${index}].stderr_limitが不正です。正の整数を指定してください。`);
  }
  if (!Array.isArray(value.expected_exit_codes) || value.expected_exit_codes.length < 1 || !value.expected_exit_codes.every((item) => Number.isInteger(item))) {
    throw new ApiError(400, "validation_error", `verification_plan[${index}].expected_exit_codesが不正です。整数の配列(1件以上)を指定してください。`);
  }
  if (value.executor !== "core" && value.executor !== "reviewer") {
    throw new ApiError(400, "validation_error", `verification_plan[${index}].executorが不正です。coreまたはreviewerを指定してください。`);
  }
  return {
    command_id,
    argv: value.argv as string[],
    cwd,
    env_allowlist: value.env_allowlist as string[],
    timeout_seconds: Number(value.timeout_seconds),
    stdout_limit: Number(value.stdout_limit),
    stderr_limit: Number(value.stderr_limit),
    expected_exit_codes: value.expected_exit_codes as number[],
    executor: value.executor,
  };
}

function validateCreateProjectPayload(payload: JsonObject): CreateProjectInput {
  exactKeys(payload, ["name", "canonical_path", "base_branch", "allowed_roots", "verification_plan"], "CreateProject payload");
  const name = stringField(payload.name, "name", 1, 500);
  const canonical_path = stringField(payload.canonical_path, "canonical_path", 1, 4096);
  const base_branch = stringField(payload.base_branch, "base_branch", 1, 500);
  if (!Array.isArray(payload.allowed_roots) || payload.allowed_roots.length < 1 || !payload.allowed_roots.every((item) => typeof item === "string")) {
    throw new ApiError(400, "validation_error", "allowed_rootsが不正です。文字列の配列(1件以上)を指定してください。");
  }
  if (!Array.isArray(payload.verification_plan)) {
    throw new ApiError(400, "validation_error", "verification_planが不正です。配列を指定してください。");
  }
  const verification_plan = payload.verification_plan.map((item, index) => validateVerificationCommand(item, index));
  return { name, canonical_path, base_branch, allowed_roots: payload.allowed_roots as string[], verification_plan };
}

function validateProjectFolderRequest(value: unknown): string {
  if (!isObject(value)) throw new ApiError(400, "validation_error", "フォルダ情報が正しくありません。");
  exactKeys(value, ["path"], "Project folder request");
  return stringField(value.path, "path", 1, 4096);
}

function validateProjectSetupPayload(payload: JsonObject): { mode: "existing" | "new" | "initialize_existing"; name: string; path: string } {
  exactKeys(payload, ["mode", "name", "path"], "Project setup payload");
  if (payload.mode !== "existing" && payload.mode !== "new" && payload.mode !== "initialize_existing") {
    throw new ApiError(400, "validation_error", "Projectの登録方法を選択してください。");
  }
  const name = stringField(payload.name, "name", 1, 200).trim();
  if (!name) throw new ApiError(400, "validation_error", "Project name must not be empty.");
  if (payload.mode === "new" && (name === "." || name === ".." || /[\\/]/u.test(name))) {
    throw new ApiError(400, "validation_error", "新しいフォルダ名にスラッシュは使えません。");
  }
  return {
    mode: payload.mode,
    name,
    path: stringField(payload.path, "path", 1, 4096),
  };
}

async function assertProjectPathNotRegistered(core: CorePort, canonicalPath: string, excludeProjectId?: string): Promise<void> {
  let cursor: string | null = null;
  do {
    const page = await core.listProjects({ limit: 200, cursor });
    const conflict = page.data.find((project) => project.id !== excludeProjectId && resolve(project.canonical_path) === resolve(canonicalPath));
    if (conflict) {
      throw new ApiError(excludeProjectId ? 400 : 409, excludeProjectId ? "validation_error" : "project_path_conflict", "このフォルダはすでに登録されています。Project一覧から既存の登録を利用してください。", { canonical_path: canonicalPath, project_id: conflict.id });
    }
    cursor = page.cursor;
    if (!page.has_more) return;
  } while (cursor !== null);
}

function validateProjectUpdatePayload(payload: JsonObject): UpdateProjectInput {
  const allowed = ["name", "canonical_path", "auto_push", "worktree_setup_command", "worktree_refresh_command"];
  const extra = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new ApiError(400, "validation_error", "UpdateProject payloadの項目が契約と一致しません。必須項目と余分な項目を確認してください。", { missing: [], extra });
  }
  if (!allowed.some((key) => Object.prototype.hasOwnProperty.call(payload, key))) {
    throw new ApiError(400, "validation_error", "変更する項目（name、canonical_path、auto_push、worktree_setup_command、worktree_refresh_commandのいずれか）を1つ以上指定してください。");
  }
  const input: UpdateProjectInput = {};
  if (Object.prototype.hasOwnProperty.call(payload, "name")) {
    if (typeof payload.name !== "string") throw new ApiError(400, "validation_error", "Project名は1〜200文字で指定してください。");
    const name = payload.name.trim();
    if (name.length < 1 || name.length > 200) throw new ApiError(400, "validation_error", "Project名は1〜200文字で指定してください。");
    input.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "canonical_path")) {
    const canonicalPath = stringField(payload.canonical_path, "canonical_path", 1, 4096);
    if (!isAbsolute(canonicalPath)) throw new ApiError(400, "validation_error", "フォルダは絶対パスで指定してください。");
    input.canonical_path = canonicalPath;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "auto_push")) {
    if (typeof payload.auto_push !== "boolean") throw new ApiError(400, "validation_error", "自動pushはtrueかfalseで指定してください。");
    input.auto_push = payload.auto_push;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "worktree_setup_command")) {
    input.worktree_setup_command = worktreeCommandField(payload.worktree_setup_command, "worktree_setup_command");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "worktree_refresh_command")) {
    input.worktree_refresh_command = worktreeCommandField(payload.worktree_refresh_command, "worktree_refresh_command");
  }
  return input;
}

function worktreeCommandField(value: unknown, field: string): string[] {
  const valid = Array.isArray(value)
    && value.length <= 64
    && value.every((arg) => typeof arg === "string" && arg.length <= 4096 && !arg.includes("\0"))
    && (value.length === 0 || (value[0] as string).trim().length > 0);
  if (!valid) throw new ApiError(400, "validation_error", "コマンドは文字列の配列（先頭がコマンド名、空配列で未設定）で指定してください。", { field });
  return [...(value as string[])];
}

function validateDeleteProjectPayload(payload: JsonObject): DeleteProjectInput {
  exactKeys(payload, ["confirmed_work_count"], "DeleteProject payload");
  if (!Number.isSafeInteger(payload.confirmed_work_count) || Number(payload.confirmed_work_count) < 0) {
    throw new ApiError(400, "validation_error", "confirmed_work_countが不正です。0以上の整数を指定してください。");
  }
  return { confirmed_work_count: Number(payload.confirmed_work_count) };
}

async function requireRegisteredProject(core: CorePort, projectId: string): Promise<Project> {
  let cursor: string | null = null;
  do {
    const page = await core.listProjects({ limit: 200, cursor });
    const project = page.data.find((item) => item.id === projectId);
    if (project) return project;
    cursor = page.cursor;
    if (!page.has_more) break;
  } while (cursor !== null);
  throw new ApiError(404, "project_not_found", "指定されたProjectが見つかりません。Project一覧を再読み込みしてください。", { resource: "project", id: projectId });
}

function projectCreatePayload(name: string, repository: { canonical_path: string; base_branch: string }): CreateProjectInput {
  return {
    name,
    canonical_path: repository.canonical_path,
    base_branch: repository.base_branch,
    allowed_roots: [repository.canonical_path],
    verification_plan: [],
  };
}

function validatePostMessagePayload(payload: JsonObject): PostMessageInput {
  exactKeys(payload, ["body", "attachment_ids"], "PostMessage payload");
  const body = stringField(payload.body, "body", 1, 100000);
  if (!Array.isArray(payload.attachment_ids) || !payload.attachment_ids.every((item) => typeof item === "string")) {
    throw new ApiError(400, "validation_error", "attachment_idsが不正です。文字列の配列を指定してください。");
  }
  return { body, attachment_ids: payload.attachment_ids as string[] };
}

function validateInboundMessage(value: unknown): InboundMessageInput {
  if (!isObject(value)) throw new ApiError(400, "validation_error", "Inbound messageはJSON objectで指定してください。");
  exactKeys(value, ["provider", "account_id", "external_message_id", "user_id", "channel_id", "thread_id", "received_at", "text", "conversation_hint", "attachment_ids"], "InboundMessage");
  if (value.provider !== "slack" && value.provider !== "discord") {
    throw new ApiError(400, "validation_error", "providerはslackまたはdiscordで指定してください。");
  }
  const account_id = stringField(value.account_id, "account_id", 1, 200);
  const external_message_id = stringField(value.external_message_id, "external_message_id", 1, 200);
  stringField(value.user_id, "user_id", 1, 200);
  stringField(value.channel_id, "channel_id", 1, 200);
  const thread_id = value.thread_id === null ? null : stringField(value.thread_id, "thread_id", 1, 200);
  const received_at = stringField(value.received_at, "received_at", 1, 80);
  if (!Number.isFinite(Date.parse(received_at)) || !/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(received_at)) {
    throw new ApiError(400, "validation_error", "received_atはRFC3339形式で指定してください。");
  }
  const text = stringField(value.text, "text", 0, 100000);
  if (!isObject(value.conversation_hint)) throw new ApiError(400, "validation_error", "conversation_hintが不正です。");
  exactKeys(value.conversation_hint, ["work_id", "dm_ref", "thread_ref"], "conversation_hint");
  const work_id = nullableUlid(value.conversation_hint.work_id, "conversation_hint.work_id");
  const dm_ref = stringField(value.conversation_hint.dm_ref, "conversation_hint.dm_ref", 1, 200);
  const thread_ref = value.conversation_hint.thread_ref === null ? null : stringField(value.conversation_hint.thread_ref, "conversation_hint.thread_ref", 1, 200);
  if (!Array.isArray(value.attachment_ids) || value.attachment_ids.length > 20 || !value.attachment_ids.every((id) => isUlid(id))) {
    throw new ApiError(400, "validation_error", "attachment_idsは最大20件のULID配列で指定してください。");
  }
  return {
    provider: value.provider,
    account_id,
    external_message_id,
    user_id: value.user_id as string,
    channel_id: value.channel_id as string,
    thread_id,
    received_at,
    text,
    conversation_hint: { work_id, dm_ref, thread_ref },
    attachment_ids: value.attachment_ids as string[],
  };
}

function validateUploadRegister(value: unknown): import("./types.js").InboundUploadRegisterInput {
  if (!isObject(value)) throw new ApiError(400, "validation_error", "UploadRegisterはJSON objectで指定してください。");
  exactKeys(value, ["provider", "account_id", "external_attachment_id", "filename", "declared_mime", "declared_bytes", "sha256", "work_id", "conversation_id", "conversation_hint"], "UploadRegister");
  if (value.provider !== "slack" && value.provider !== "discord" && value.provider !== "web") throw new ApiError(400, "validation_error", "providerが不正です。");
  const filename = stringField(value.filename, "filename", 1, 255);
  if (/[\\/\0\x00-\x1f\x7f]/u.test(filename) || filename === "." || filename === "..") throw new ApiError(400, "validation_error", "filenameにpath separatorまたはcontrol characterは指定できません。");
  if (!Number.isSafeInteger(value.declared_bytes) || Number(value.declared_bytes) < 0 || Number(value.declared_bytes) > MAX_UPLOAD_BODY_BYTES) throw new ApiError(413, "upload_too_large", "declared_bytesが許可されたuploadサイズを超えています。");
  const sha256 = value.sha256 === null ? null : stringField(value.sha256, "sha256", 64, 64);
  if (sha256 !== null && !/^[0-9a-f]{64}$/u.test(sha256)) throw new ApiError(400, "validation_error", "sha256はlowercase SHA-256 hexで指定してください。");
  const conversation_id = value.conversation_id === null ? null : pathId(stringField(value.conversation_id, "conversation_id", 1, 128), "conversation_id");
  let conversation_hint: { work_id: string | null; dm_ref: string; thread_ref: string | null } | null = null;
  if (value.conversation_hint !== null) {
    if (!isObject(value.conversation_hint)) throw new ApiError(400, "validation_error", "conversation_hintが不正です。");
    exactKeys(value.conversation_hint, ["work_id", "dm_ref", "thread_ref"], "conversation_hint");
    const work_id = nullableUlid(value.conversation_hint.work_id, "conversation_hint.work_id");
    const dm_ref = stringField(value.conversation_hint.dm_ref, "conversation_hint.dm_ref", 1, 200);
    const thread_ref = value.conversation_hint.thread_ref === null ? null : stringField(value.conversation_hint.thread_ref, "conversation_hint.thread_ref", 1, 200);
    conversation_hint = { work_id, dm_ref, thread_ref };
  }
  if ((conversation_id === null) === (conversation_hint === null)) {
    throw new ApiError(400, "validation_error", "conversation_idとconversation_hintはどちらか一方のみ指定してください。");
  }
  return {
    provider: value.provider,
    account_id: stringField(value.account_id, "account_id", 1, 200),
    external_attachment_id: stringField(value.external_attachment_id, "external_attachment_id", 1, 200),
    filename,
    declared_mime: value.declared_mime === null ? null : stringField(value.declared_mime, "declared_mime", 1, 255),
    declared_bytes: Number(value.declared_bytes),
    sha256,
    work_id: nullableUlid(value.work_id, "work_id"),
    conversation_id,
    conversation_hint,
  };
}

function validateUploadComplete(value: JsonObject): { bytes: number; sha256: string; mime: string } {
  exactKeys(value, ["bytes", "sha256", "mime"], "CompleteUpload payload");
  if (!Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0) throw new ApiError(400, "validation_error", "bytesが不正です。");
  const sha256 = stringField(value.sha256, "sha256", 64, 64);
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new ApiError(400, "validation_error", "sha256が不正です。");
  return { bytes: Number(value.bytes), sha256, mime: stringField(value.mime, "mime", 1, 255) };
}

function validateIngestConversationPayload(payload: JsonObject): { conversation_id: string } {
  exactKeys(payload, ["conversation_id"], "Knowledge ingestion payload");
  return { conversation_id: pathId(stringField(payload.conversation_id, "conversation_id", 1, 128), "conversation_id") };
}

function validateRoleModelSettingInput(value: unknown, index: number): RoleModelSettingInput {
  if (!isObject(value)) {
    throw new ApiError(400, "validation_error", `roles[${index}]はJSON objectで指定してください。`);
  }
  exactKeys(value, ["role", "provider", "model", "effort"], `roles[${index}]`);
  if (typeof value.role !== "string" || !MODEL_SETTING_ROLES.has(value.role)) {
    throw new ApiError(400, "validation_error", `roles[${index}].roleが不正です。advisor、manager、designer、lead_designer、worker、reviewer、librarian、curatorのいずれかを指定してください。`);
  }
  const provider = stringField(value.provider, `roles[${index}].provider`, 1, 200);
  const model = stringField(value.model, `roles[${index}].model`, 1, 200);
  if (typeof value.effort !== "string" || !MODEL_SETTING_EFFORTS.has(value.effort)) {
    throw new ApiError(400, "validation_error", `roles[${index}].effortが不正です。low、medium、high、xhigh、maxのいずれかを指定してください。`);
  }
  return { role: value.role as RoleModelSettingInput["role"], provider, model, effort: value.effort as RoleModelSettingInput["effort"] };
}

function validateUpdateModelSettingsPayload(payload: JsonObject): { roles: RoleModelSettingInput[] } {
  exactKeys(payload, ["roles"], "UpdateModelSettings payload");
  if (!Array.isArray(payload.roles) || payload.roles.length !== MODEL_SETTING_ROLES.size) {
    throw new ApiError(400, "validation_error", `rolesが不正です。${MODEL_SETTING_ROLES.size}つのroleすべてを指定してください。`);
  }
  const roles = payload.roles.map((item, index) => validateRoleModelSettingInput(item, index));
  const seenRoles = new Set(roles.map((role) => role.role));
  if (seenRoles.size !== roles.length) {
    throw new ApiError(400, "validation_error", "rolesに重複したroleが含まれています。各roleは1件ずつ指定してください。");
  }
  for (const role of MODEL_SETTING_ROLES) {
    if (!seenRoles.has(role as RoleModelSettingInput["role"])) {
      throw new ApiError(400, "validation_error", `rolesに${role}が含まれていません。${MODEL_SETTING_ROLES.size}つのroleすべてを指定してください。`);
    }
  }
  return { roles };
}

function validateModelPresetName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length < 1 || name.length > 60) throw new ApiError(400, "validation_error", "name must contain 1 to 60 characters.", { field: "name" });
  return name;
}

function validateCreateModelPresetPayload(payload: JsonObject): { name: string; roles: RoleModelSettingInput[] } {
  exactKeys(payload, ["name", "roles"], "CreateModelPreset payload");
  return { name: validateModelPresetName(payload.name), roles: validateUpdateModelSettingsPayload({ roles: payload.roles }).roles };
}

function validateUpdateModelPresetPayload(payload: JsonObject): { name?: string; roles?: RoleModelSettingInput[] } {
  const keys = Object.keys(payload);
  if (keys.length === 0 || keys.some((key) => key !== "name" && key !== "roles")) {
    throw new ApiError(400, "validation_error", "Provide name or roles to update a model preset.");
  }
  return {
    ...(Object.hasOwn(payload, "name") ? { name: validateModelPresetName(payload.name) } : {}),
    ...(Object.hasOwn(payload, "roles") ? { roles: validateUpdateModelSettingsPayload({ roles: payload.roles }).roles } : {}),
  };
}

function errorStatusForUnknownRoute(): ApiError {
  return new ApiError(404, "not_found", "指定されたAPI endpointが見つかりません。pathとHTTP methodを確認してください。");
}

function requireSkillApi(core: CorePort): SkillApiPort {
  const candidate = core as CorePort & Partial<SkillApiPort>;
  const methods: Array<keyof SkillApiPort> = [
    "getSkillActivity", "listSkills", "getSkill", "readSkillFile", "listSkillRevisions", "getSkillRevision", "restoreSkill",
    "updateSkill", "listSkillProposals", "approveSkillProposal", "rejectSkillProposal", "getSkillSettings", "setSkillSettings",
  ];
  if (methods.some((method) => typeof candidate[method] !== "function")) {
    throw new ApiError(503, "core_not_ready", "The loaded Core does not support the Skill Box API.");
  }
  return candidate as SkillApiPort;
}

function requireRuleProposalApi(core: CorePort): RuleProposalApiPort {
  const wrapped = core as CorePort & { core?: unknown };
  const candidate = isRuleProposalApiPort(core) ? core : isRuleProposalApiPort(wrapped.core) ? wrapped.core : null;
  if (!candidate) throw new ApiError(503, "core_not_ready", "The loaded Core does not support the rule proposal API.");
  return candidate;
}

function requireKnowledgeMigrationApi(core: CorePort): KnowledgeMigrationApiPort {
  const wrapped = core as CorePort & { core?: unknown };
  const candidate = isKnowledgeMigrationApiPort(core) ? core : isKnowledgeMigrationApiPort(wrapped.core) ? wrapped.core : null;
  if (!candidate) throw new ApiError(503, "core_not_ready", "The loaded Core does not support legacy knowledge migration.");
  return candidate;
}

function requireKnowledgeRetagApi(core: CorePort): KnowledgeRetagApiPort {
  const wrapped = core as CorePort & { core?: unknown };
  const has = (value: unknown): value is KnowledgeRetagApiPort => isObject(value) && typeof value.retagKnowledgeNotes === "function";
  const candidate = has(core) ? core : has(wrapped.core) ? wrapped.core : null;
  if (!candidate) throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support knowledge retagging.");
  return candidate;
}

function requireWorkConversationApi(core: CorePort): WorkConversationApiPort {
  const has = (value: unknown): value is WorkConversationApiPort => isObject(value) && typeof value.getWorkConversation === "function";
  const wrapped = core as CorePort & { core?: unknown };
  const candidate = has(core) ? core : has(wrapped.core) ? wrapped.core : null;
  if (!candidate) throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support work conversations.");
  return candidate;
}

function parseConversationLimit(value: string | null): number {
  if (value === null || value === "") return 100;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || parsed < 1 || parsed > 500) {
    throw new ApiError(400, "validation_error", "limitが不正です。1〜500の整数を指定してください。");
  }
  return parsed;
}

function requireKnowledgeStorageApi(core: CorePort): KnowledgeStorageApiPort {
  const has = (value: unknown): value is KnowledgeStorageApiPort => isObject(value)
    && typeof value.activeKnowledgeDir === "function"
    && typeof value.getKnowledgeStorage === "function"
    && typeof value.hasKnowledgeStorageEverBeenAvailable === "function"
    && typeof value.checkKnowledgeStorage === "function"
    && typeof value.moveKnowledgeStorage === "function"
    && typeof value.withKnowledgeAccess === "function";
  const wrapped = core as CorePort & { core?: unknown };
  const candidate = has(core) ? core : has(wrapped.core) ? wrapped.core : null;
  if (!candidate) throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support knowledge storage access.");
  return candidate;
}

function knowledgeStorageErrorCode(error: unknown): string | null {
  return isObject(error) && typeof error.code === "string" ? error.code : null;
}

function isKnowledgeStorageApiError(error: unknown): boolean {
  const code = knowledgeStorageErrorCode(error);
  return code === "knowledge_storage_unavailable" || code === "knowledge_storage_moving";
}

async function withKnowledgeStorageAccess<T>(core: CorePort, kind: "read" | "write", operation: () => Promise<T>): Promise<T> {
  const api = requireKnowledgeStorageApi(core);
  if (kind === "write" && api.getKnowledgeStorage().state === "moving") {
    throw Object.assign(new Error("The knowledge storage is being moved."), { code: "knowledge_storage_moving", details: {} });
  }
  try {
    return await api.withKnowledgeAccess(kind, operation);
  } catch (error) {
    if (knowledgeStorageErrorCode(error) === "knowledge_storage_unavailable") throw error;
    const code = knowledgeStorageErrorCode(error);
    if (code && ["ENOENT", "EIO", "ENXIO", "ENODEV", "ESTALE", "ETIMEDOUT", "EACCES", "EPERM", "EROFS"].includes(code)) {
      const status = await api.checkKnowledgeStorage().catch(() => null);
      if (status?.state === "unavailable") {
        try {
          api.activeKnowledgeDir();
        } catch (unavailable) {
          throw unavailable;
        }
      }
    }
    throw error;
  }
}

function validateKnowledgeRetagPayload(payload: JsonObject): { dry_run: boolean; force?: boolean } {
  const extra = Object.keys(payload).filter((key) => key !== "dry_run" && key !== "force");
  if (extra.length > 0) throw new ApiError(400, "validation_error", "Retag payload has unsupported fields.", { extra });
  if (typeof payload.dry_run !== "boolean") {
    throw new ApiError(400, "validation_error", "dry_run must be a boolean.", { field: "dry_run" });
  }
  if (payload.force !== undefined && typeof payload.force !== "boolean") {
    throw new ApiError(400, "validation_error", "force must be a boolean.", { field: "force" });
  }
  return payload.force === undefined ? { dry_run: payload.dry_run } : { dry_run: payload.dry_run, force: payload.force };
}

async function dispatchPendingCoreEvents(core: CorePort): Promise<void> {
  const wrapped = core as CorePort & { core?: unknown };
  const target = (isObject(wrapped.core) ? wrapped.core : core) as unknown as JsonObject;
  const dispatcher = isObject(target.dispatcher) ? target.dispatcher : null;
  if (dispatcher && typeof dispatcher.replayPending === "function") {
    await dispatcher.replayPending.call(dispatcher);
  }
}

function isRuleProposalApiPort(value: unknown): value is RuleProposalApiPort {
  if (!isObject(value)) return false;
  return typeof value.listRuleProposals === "function"
    && typeof value.createRuleProposalFromNote === "function"
    && typeof value.approveRuleProposal === "function"
    && typeof value.rejectRuleProposal === "function";
}

function isKnowledgeMigrationApiPort(value: unknown): value is KnowledgeMigrationApiPort {
  return isObject(value) && typeof value.migrateLegacyKnowledge === "function";
}

function validateLegacyKnowledgeMigrationPayload(payload: JsonObject): { dry_run: boolean } {
  exactKeys(payload, ["dry_run"], "legacy knowledge migration payload");
  if (typeof payload.dry_run !== "boolean") {
    throw new ApiError(400, "validation_error", "dry_run must be a boolean.", { field: "dry_run" });
  }
  return { dry_run: payload.dry_run };
}

function validateCreateRuleProposalPayload(payload: JsonObject): JsonObject {
  const allowed = new Set(["note_id", "claim_fingerprint", "level", "role", "text"]);
  const missing = ["note_id", "claim_fingerprint", "level"].filter((key) => !Object.prototype.hasOwnProperty.call(payload, key));
  const extra = Object.keys(payload).filter((key) => !allowed.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new ApiError(400, "validation_error", "Rule proposal payload fields do not match the supported fields.", { missing, extra });
  }
  const noteId = stringField(payload.note_id, "note_id", 26, 26);
  if (!isUlid(noteId)) throw new ApiError(400, "validation_error", "note_id must be a ULID.", { field: "note_id" });
  const claimFingerprint = stringField(payload.claim_fingerprint, "claim_fingerprint", 16, 16);
  if (!/^[a-f0-9]{16}$/u.test(claimFingerprint)) {
    throw new ApiError(400, "validation_error", "claim_fingerprint must be a 16 character fingerprint.", { field: "claim_fingerprint" });
  }
  if (payload.level !== "system" && payload.level !== "role") {
    throw new ApiError(400, "validation_error", "level must be system or role.", { field: "level" });
  }
  if ((payload.level === "system" && payload.role !== undefined) || (payload.level === "role" && !isRuleRole(payload.role))) {
    throw new ApiError(400, "validation_error", "role must match the selected proposal level.", { field: "role" });
  }
  if (payload.text !== undefined && (typeof payload.text !== "string" || payload.text.length > 300)) {
    throw new ApiError(400, "validation_error", "text must be a string no longer than 300 characters.", { field: "text" });
  }
  return {
    note_id: noteId,
    claim_fingerprint: claimFingerprint,
    level: payload.level,
    ...(payload.role === undefined ? {} : { role: payload.role }),
    ...(payload.text === undefined ? {} : { text: payload.text }),
  };
}

function ruleProposalCommandResult(value: unknown): { data: JsonObject; version: number } {
  if (!isObject(value)) throw new ApiError(503, "core_not_ready", "Rule proposal command returned an invalid result.");
  if (isObject(value.data) && typeof value.version === "number") {
    return { data: value.data, version: value.version };
  }
  return { data: value, version: 0 };
}

function ruleProposalApiError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (!isObject(error) || typeof error.code !== "string") return error;
  const code = error.code;
  if (code === "invalid_state_transition") {
    return new ApiError(409, code, error instanceof Error ? error.message : "The proposal is not in an actionable state.", isObject(error.details) ? error.details : {});
  }
  if (code === "rule_apply_failed") {
    return new ApiError(503, "dependency_unavailable", error instanceof Error ? error.message : "The rule proposal could not be applied.", {
      domain_code: code,
      ...(isObject(error.details) ? error.details : {}),
    });
  }
  if (code === "validation_error") {
    return new ApiError(400, code, error instanceof Error ? error.message : "The rule proposal request is invalid.", isObject(error.details) ? error.details : {});
  }
  if (code === "note_not_found" || code === "note_claim_not_found" || code === "rule_proposal_not_found") {
    return new ApiError(404, "not_found", error instanceof Error ? error.message : "The requested rule proposal resource was not found.", {
      domain_code: code,
      ...(isObject(error.details) ? error.details : {}),
    });
  }
  return error;
}

function requireCurationApi(core: CorePort): CurationApiPort {
  const candidate = core as CorePort & Partial<CurationApiPort>;
  const methods: Array<keyof CurationApiPort> = ["runCuration", "listCurationRuns", "getCurationRun"];
  if (methods.some((method) => typeof candidate[method] !== "function")) {
    throw new ApiError(503, "core_not_ready", "The loaded Core does not support the curation run API.");
  }
  return candidate as CurationApiPort;
}

const CURATION_KIND_VALUES = ["librarian", "skill_curation", "rule_curation"];
const CURATION_STATUS_VALUES = ["running", "succeeded", "failed"];

/**
 * Every action type the /advisor/actions endpoint accepts. The curation types
 * come from the shared list, and both the allowlist below and the dispatch
 * branch use `Set.has`, which — unlike indexing a plain object — can never
 * match an inherited Object.prototype member such as "constructor".
 */
const ADVISOR_ACTION_TYPES: ReadonlySet<string> = new Set([
  "create_work",
  "start_work",
  "pause_work",
  "reopen_work",
  "cancel_work",
  "send_work_instruction",
  "update_work",
  "resume_work",
  "answer_decision",
  "send_file",
  ...ADVISOR_CURATION_ACTION_TYPES,
]);

function curationEnumQuery(value: string | null, allowed: string[], name: string): string | undefined {
  if (value === null || value === "") return undefined;
  if (!allowed.includes(value)) {
    throw new ApiError(400, "validation_error", `${name}が不正です。${allowed.join("、")}のいずれかを指定してください。`);
  }
  return value;
}

function requireBacklogApi(core: CorePort): BacklogApiPort {
  const candidate = core as CorePort & Partial<BacklogApiPort>;
  const methods: Array<keyof BacklogApiPort> = ["listBacklogItems", "dismissBacklogItems", "issueBacklogWork", "linkBacklogItems"];
  if (methods.some((method) => typeof candidate[method] !== "function")) {
    throw new ApiError(503, "core_not_ready", "The loaded Core does not support the Review Backlog API.");
  }
  return candidate as BacklogApiPort;
}

function validateBacklogProjectId(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (!isUlid(value)) throw new ApiError(400, "validation_error", "project_idはULIDで指定してください。", { field: "project_id" });
  return value;
}

function validateBacklogStatus(value: string | null): BacklogStatus | undefined {
  if (value === null) return undefined;
  if (value !== "open" && value !== "in_progress" && value !== "done" && value !== "dismissed") {
    throw new ApiError(400, "validation_error", "statusはopen、in_progress、done、dismissedのいずれかで指定してください。", { field: "status" });
  }
  return value;
}

function validateBacklogItemIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100 || !value.every(isUlid) || new Set(value).size !== value.length) {
    throw new ApiError(400, "validation_error", "item_idsは重複のない1〜100件のULID配列で指定してください。", { field: "item_ids" });
  }
  return value as string[];
}

function validateDismissBacklogPayload(payload: JsonObject): { item_ids: string[] } {
  exactKeys(payload, ["item_ids"], "DismissBacklogItems payload");
  return { item_ids: validateBacklogItemIds(payload.item_ids) };
}

function validateLinkBacklogItemsPayload(payload: JsonObject): { item_ids: string[] } {
  exactKeys(payload, ["item_ids"], "LinkBacklogItems payload");
  return { item_ids: validateBacklogItemIds(payload.item_ids) };
}

function validateIssueBacklogWorkPayload(payload: JsonObject): { item_ids: string[]; title: string; summary: string; size: "small" | "normal" | "large" } {
  exactKeys(payload, ["item_ids", "title", "summary", "size"], "IssueBacklogWork payload");
  const item_ids = validateBacklogItemIds(payload.item_ids);
  const title = stringField(payload.title, "title", 1, 500);
  const summary = stringField(payload.summary, "summary", 0, 20000);
  if (payload.size !== "small" && payload.size !== "normal" && payload.size !== "large") {
    throw new ApiError(400, "validation_error", "sizeはsmall、normal、largeのいずれかで指定してください。", { field: "size" });
  }
  return { item_ids, title, summary, size: payload.size };
}

function decodeSkillRouteValue(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    throw new ApiError(400, "validation_error", `${label} cannot be decoded.`, {}, { cause: error });
  }
}

async function routeApi(context: RequestContext, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const method = request.method ?? "GET";
  const pathname = url.pathname;
  const rawPathname = (request.url ?? "/").split("?", 1)[0] ?? "/";
  const requestIdValue = requestId(request);
  const featureCore = context.core as FeatureCorePort;
  assertSameOriginWrite(request, context);

  const rawSkillFileMatch = rawPathname.match(new RegExp(`^${API_PREFIX}/skills/([^/]+)/files/(.*)$`));
  if (rawSkillFileMatch && method === "GET") {
    requireOwner(request);
    const skills = requireSkillApi(context.core);
    const name = decodeSkillRouteValue(rawSkillFileMatch[1]!, "name");
    const filePath = decodeSkillRouteValue(rawSkillFileMatch[2]!, "path");
    const content = await skills.readSkillFile(name, filePath);
    sendJson(response, 200, { request_id: requestIdValue, data: { content } });
    return;
  }

  if (pathname === `${API_PREFIX}/health` && method === "GET") {
    if (!isLoopback(request)) {
      throw new ApiError(403, "forbidden", "healthはloopback接続だけに公開されています。localhostから接続してください。");
    }
    if (!context.core.ready || context.shuttingDown) {
      throw new ApiError(503, "core_not_ready", "Coreが起動準備中または停止処理中です。しばらく待って再試行してください。");
    }
    sendJson(response, 200, { status: "ok", schema_version: context.contract.contract_version, core_time: new Date().toISOString() });
    return;
  }

  if (pathname === `${API_PREFIX}/runtime-config.json` && method === "GET") {
    if (!isLoopback(request)) {
      throw new ApiError(403, "forbidden", "runtime configは同一端末から取得してください。localhostから接続してください。");
    }
    if (!context.core.ready || context.shuttingDown) {
      throw new ApiError(503, "core_not_ready", "Coreが起動準備中または停止処理中です。しばらく待って再試行してください。");
    }
    const wsHost = process.env.OWL_PUBLIC_HOST ?? (context.bind === "0.0.0.0" ? "127.0.0.1" : context.bind);
    sendJson(
      response,
      200,
      {
        base_path: "/owl/",
        api_base: "/api/v1",
        ws_url: `${API_PREFIX}/ws`,
        schema_version: context.contract.contract_version,
      },
      configuredApiToken() && isLoopback(request)
        ? { "set-cookie": [`${UI_SESSION_COOKIE}=${createUiSessionValue()}; Max-Age=${UI_SESSION_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Strict`] }
        : {},
    );
    return;
  }

  if (pathname === `${API_PREFIX}/system/status` && method === "GET") {
    requireOwner(request);
    parseBoolean(url.searchParams.get("verbose"), false);
    // data_dir lets connectors store inbound files next to the server's data.
    sendJson(response, 200, { ...(context.core.status() as unknown as Record<string, unknown>), data_dir: context.dataDir });
    return;
  }

  if (pathname === `${API_PREFIX}/works` && method === "GET") {
    requireOwner(request);
    const result = await context.core.listWorks({
      state: nullableQuery(url.searchParams.get("state")),
      archived: parseArchived(url.searchParams.get("archived")),
      limit: parseLimit(url.searchParams.get("limit"), 50),
      cursor: nullableQuery(url.searchParams.get("cursor")),
    });
    sendJson(response, 200, { ...result, request_id: requestIdValue });
    return;
  }

  if (pathname === `${API_PREFIX}/works` && method === "POST") {
    requireOwner(request);
    const body = await readRequestBody(request);
    const command = commandEnvelope(body);
    const payload = validateCreateWorkPayload(command.payload);
    const result = await runCommand(context, pathname, command, 201, async () => context.core.createWork(payload, command));
    sendJson(response, 201, result);
    return;
  }

  const workDesignsMatch = pathname.match(new RegExp(`^${API_PREFIX}/works/([^/]+)/designs$`));
  if (workDesignsMatch && method === "GET") {
    requireOwner(request);
    const workId = pathId(workDesignsMatch[1], "work_id");
    const data = await context.core.getWorkDesigns(workId);
    sendJson(response, 200, { request_id: requestIdValue, data });
    return;
  }

  const workConversationMatch = pathname.match(new RegExp(`^${API_PREFIX}/works/([^/]+)/conversation$`));
  if (workConversationMatch && method === "GET") {
    requireOwner(request);
    const workId = pathId(workConversationMatch[1]!, "work_id");
    const limit = parseConversationLimit(url.searchParams.get("limit"));
    const data = await requireWorkConversationApi(context.core).getWorkConversation(workId, { limit });
    sendJson(response, 200, { request_id: requestIdValue, data: data as unknown as JsonObject });
    return;
  }

  const workBacklogMatch = pathname.match(new RegExp(`^${API_PREFIX}/works/([^/]+)/backlog$`));
  if (workBacklogMatch && method === "GET") {
    requireOwner(request);
    const workId = pathId(workBacklogMatch[1]!, "work_id");
    const result = requireBacklogApi(context.core).listBacklogItems({
      work_id: workId,
      limit: parseBacklogLimit(url.searchParams.get("limit")),
      offset: parseBacklogOffset(url.searchParams.get("offset")),
    });
    sendJson(response, 200, { request_id: requestIdValue, data: result.items, next_offset: result.next_offset });
    return;
  }

  const workBacklogLinkMatch = pathname.match(new RegExp(`^${API_PREFIX}/works/([^/]+)/backlog/link$`));
  if (workBacklogLinkMatch && method === "POST") {
    requireOwner(request);
    const workId = pathId(workBacklogLinkMatch[1]!, "work_id");
    const command = commandEnvelope(await readRequestBody(request));
    const payload = validateLinkBacklogItemsPayload(command.payload);
    const result = await runCommand(context, pathname, command, 200, async () => {
      const linked = await requireBacklogApi(context.core).linkBacklogItems(workId, { ...command, payload });
      return { data: linked.data, version: linked.version };
    });
    sendJson(response, 200, result);
    return;
  }

  const workDesignMatch = pathname.match(new RegExp(`^${API_PREFIX}/works/([^/]+)/designs/([^/]+)$`));
  if (workDesignMatch && method === "GET") {
    requireOwner(request);
    const workId = pathId(workDesignMatch[1], "work_id");
    const taskId = pathId(workDesignMatch[2], "task_id");
    const data = await context.core.getWorkDesign(workId, taskId);
    if (data === null) throw new ApiError(404, "design_document_not_found", "指定されたTaskのdesign documentが見つかりません。");
    sendJson(response, 200, { request_id: requestIdValue, data });
    return;
  }

  const workMatch = pathname.match(new RegExp(`^${API_PREFIX}/works/([^/]+)$`));
  if (workMatch && method === "GET") {
    requireOwner(request);
    const workId = pathId(workMatch[1], "work_id");
    const data = await context.core.getWork(workId);
    sendJson(response, 200, { request_id: requestIdValue, data, version: data.state_version });
    return;
  }

  const workBranchStatusMatch = pathname.match(new RegExp(`^${API_PREFIX}/works/([^/]+)/branch-status$`));
  if (workBranchStatusMatch && method === "GET") {
    requireOwner(request);
    const workId = pathId(workBranchStatusMatch[1], "work_id");
    const data = await context.core.getWorkBranchStatus(workId);
    sendJson(response, 200, { request_id: requestIdValue, data });
    return;
  }

  const workDeleteMatch = pathname.match(new RegExp(`^${API_PREFIX}/works/([^/]+)$`));
  if (workDeleteMatch && method === "DELETE") {
    requireOwner(request);
    const workId = pathId(workDeleteMatch[1], "work_id");
    const command = commandEnvelope(await readRequestBody(request));
    validateEmptyPayload(command.payload);
    const commandKey = `${pathname}:${command.idempotency_key}`;
    const result = await runCommand(context, pathname, command, 200, async () => {
      const deleted = await context.core.deleteWork(workId, command);
      invalidateWorkCommandCache(context, workId, commandKey);
      return deleted;
    }, workId);
    sendJson(response, 200, result);
    return;
  }

  const workActionMatch = pathname.match(new RegExp(`^${API_PREFIX}/works/([^/]+)/(start|pause|resume|cancel|reopen|archive|unarchive)$`));
  if (workActionMatch && method === "POST") {
    requireOwner(request);
    const workId = pathId(workActionMatch[1], "work_id");
    const action = workActionMatch[2];
    const body = await readRequestBody(request);
    const command = commandEnvelope(body);
    let operation: () => Promise<{ data: JsonObject; version: number; request_id?: string }>;
    if (action === "archive") {
      validateEmptyPayload(command.payload);
      operation = async () => context.core.archiveWork(workId, command);
    } else if (action === "unarchive") {
      validateEmptyPayload(command.payload);
      operation = async () => context.core.unarchiveWork(workId, command);
    } else if (action === "start") {
      operation = async () => context.core.startWork(workId, validateStartPayload(command.payload), command);
    } else if (action === "pause") {
      operation = async () => context.core.pauseWork(workId, validatePausePayload(command.payload), command);
    } else if (action === "resume") {
      validateEmptyPayload(command.payload);
      operation = async () => context.core.resumeWork(workId, command);
    } else if (action === "reopen") {
      const reason = validateReopenPayload(command.payload);
      operation = async () => context.core.reopenWork(workId, reason, command);
    } else {
      const payload = validateCancelPayload(command.payload);
      operation = async () => context.core.cancelWork(workId, payload.reason, payload.force, command);
    }
    const result = await runCommand(context, pathname, command, 200, operation, workId);
    sendJson(response, 200, result);
    return;
  }

  const workMessageMatch = pathname.match(new RegExp(`^${API_PREFIX}/works/([^/]+)/messages$`));
  if (workMessageMatch && method === "POST") {
    requireOwner(request);
    const workId = pathId(workMessageMatch[1], "work_id");
    const body = await readRequestBody(request);
    const command = commandEnvelope(body);
    const payload = validateWorkInstructionPayload(command.payload);
    const result = await runCommand(context, pathname, command, 202, async () => context.core.postWorkInstruction(workId, payload, command), workId);
    sendJson(response, 202, result);
    return;
  }

  const taskListMatch = pathname.match(new RegExp(`^${API_PREFIX}/works/([^/]+)/tasks$`));
  if (taskListMatch && method === "GET") {
    requireOwner(request);
    const workId = pathId(taskListMatch[1], "work_id");
    const result = await context.core.listTasks(workId, {
      status: nullableQuery(url.searchParams.get("status")),
      limit: parseLimit(url.searchParams.get("limit"), 50),
      cursor: nullableQuery(url.searchParams.get("cursor")),
    });
    sendJson(response, 200, { ...result, request_id: requestIdValue });
    return;
  }

  const taskMatch = pathname.match(new RegExp(`^${API_PREFIX}/tasks/([^/]+)$`));
  if (taskMatch && method === "GET") {
    requireOwner(request);
    const taskId = pathId(taskMatch[1], "task_id");
    const result = await context.core.getTask(taskId, parseBoolean(url.searchParams.get("include_report"), false));
    sendJson(response, 200, { request_id: requestIdValue, data: result.data, report: result.report, version: result.version });
    return;
  }

  if (pathname === `${API_PREFIX}/decisions` && method === "GET") {
    requireOwner(request);
    const status = url.searchParams.get("status");
    if (status !== "open" && status !== "resolved" && status !== "cancelled") {
      throw new ApiError(400, "invalid_query", "statusが不正です。open、resolved、cancelledのいずれかを指定してください。");
    }
    const result = await context.core.listDecisions({
      status,
      limit: parseLimit(url.searchParams.get("limit"), 50),
      cursor: nullableQuery(url.searchParams.get("cursor")),
    });
    sendJson(response, 200, { ...result, request_id: requestIdValue });
    return;
  }

  const decisionMatch = pathname.match(new RegExp(`^${API_PREFIX}/decisions/([^/]+)/answer$`));
  if (decisionMatch && method === "POST") {
    requireOwner(request);
    const decisionId = pathId(decisionMatch[1], "decision_id");
    const command = commandEnvelope(await readRequestBody(request));
    const payload = validateAnswerPayload(command.payload);
    const result = await runCommand(context, pathname, command, 200, async () => context.core.answerDecision(decisionId, payload, command), decisionWorkId(context, decisionId));
    sendJson(response, 200, result);
    return;
  }

  if (pathname === `${API_PREFIX}/advisor/actions` && method === "POST") {
    requireOwner(request);
    const command = commandEnvelope(await readRequestBody(request));
    exactKeys(command.payload, ["invocation_id", "actions"], "AdvisorActions payload");
    if (!isUlid(command.payload.invocation_id)) throw new ApiError(400, "validation_error", "invocation_idはULIDで指定してください。");
    if (!Array.isArray(command.payload.actions)) throw new ApiError(400, "validation_error", "actionsは配列で指定してください。");
    const actions = command.payload.actions.map((value, index) => {
      if (!isObject(value)) throw new ApiError(400, "validation_error", `actions[${index}]はJSON objectで指定してください。`);
      // A curation action takes no input beyond an optional reason, so its
      // payload may be omitted or null; every other action still needs one.
      // `has` (not an object lookup) keeps inherited keys such as "constructor"
      // out of that decision.
      const curation = typeof value.type === "string" && ADVISOR_CURATION_ACTION_TYPES.has(value.type)
        ? advisorCurationKind(value.type)
        : null;
      exactKeys(
        value,
        curation === null
          ? ["action_id", "sequence", "type", "payload", "expected_version"]
          : ["action_id", "sequence", "type", "expected_version"],
        `actions[${index}]`,
        curation === null ? [] : ["payload"],
      );
      const action_id = stringField(value.action_id, `actions[${index}].action_id`, 1, 200);
      if (!Number.isSafeInteger(value.sequence)) throw new ApiError(400, "validation_error", `actions[${index}].sequenceが不正です。`);
      if (typeof value.type !== "string" || !ADVISOR_ACTION_TYPES.has(value.type)) {
        throw new ApiError(422, "action_rejected", `actions[${index}].typeは許可されたAdvisor actionではありません。`);
      }
      if (curation === null) {
        if (!isObject(value.payload)) throw new ApiError(400, "validation_error", `actions[${index}].payloadが不正です。`);
      } else {
        // Only an optional reason is accepted; anything else is a contract
        // mismatch rather than something to pass through to the curation.
        if (value.payload !== undefined && value.payload !== null && !isObject(value.payload)) {
          throw new ApiError(400, "validation_error", `actions[${index}].payloadが不正です。`);
        }
        exactKeys(isObject(value.payload) ? value.payload : {}, [], `actions[${index}].payload`, ["reason"]);
      }
      if (!Number.isInteger(value.expected_version) || Number(value.expected_version) < 0) {
        throw new ApiError(400, "validation_error", `actions[${index}].expected_versionが不正です。0以上の整数を指定してください。`);
      }
      return { action_id, sequence: Number(value.sequence), type: value.type, payload: isObject(value.payload) ? value.payload : {}, expected_version: Number(value.expected_version) };
    }).sort((left, right) => left.sequence - right.sequence);
    const seenActionIds = new Set<string>();
    if (actions.some((action) => seenActionIds.has(action.action_id) || (seenActionIds.add(action.action_id), false))) {
      throw new ApiError(409, "action_id_conflict", "同じAdvisor action batchに重複したaction_idがあります。");
    }
    const results: Array<{ action_id: string; status: "executed" | "rejected" | "not_run"; result: JsonObject | null; error_code: string | null }> = [];
    for (const action of actions) {
      try {
        const payload = action.payload;
        let data: JsonObject;
        const actionCommand = { request_id: command.request_id, idempotency_key: `${command.idempotency_key}:${action.action_id}`, expected_version: action.expected_version };
        if (action.type === "create_work") {
          const createPayload = {
            title: payload.title,
            summary: payload.summary ?? "",
            size: payload.size ?? "normal",
            project_id: payload.project_id ?? null,
            ...(payload.design_mode === undefined ? {} : { design_mode: payload.design_mode }),
          } as JsonObject;
          data = (await context.core.createWork(validateCreateWorkPayload(createPayload), actionCommand)).data as unknown as JsonObject;
        } else if (action.type === "start_work") {
          const workId = pathId(stringField(payload.work_id, "work_id", 1, 128), "work_id");
          const mode = payload.mode === undefined ? "normal" : validateStartPayload({ mode: payload.mode });
          data = (await withWorkLock(context, workId, async () => context.core.startWork(workId, mode, actionCommand))).data as unknown as JsonObject;
        } else if (action.type === "pause_work") {
          const workId = pathId(stringField(payload.work_id, "work_id", 1, 128), "work_id");
          data = (await withWorkLock(context, workId, async () => context.core.pauseWork(workId, typeof payload.reason === "string" ? payload.reason : "Advisor requested pause.", actionCommand))).data as unknown as JsonObject;
        } else if (action.type === "reopen_work") {
          const workId = pathId(stringField(payload.work_id, "work_id", 1, 128), "work_id");
          data = (await withWorkLock(context, workId, async () => context.core.reopenWork(workId, typeof payload.reason === "string" ? payload.reason : "Advisor requested reopen.", actionCommand))).data as unknown as JsonObject;
        } else if (action.type === "cancel_work") {
          const workId = pathId(stringField(payload.work_id, "work_id", 1, 128), "work_id");
          data = (await withWorkLock(context, workId, async () => context.core.cancelWork(workId, typeof payload.reason === "string" ? payload.reason : "Advisor requested cancellation.", payload.force === true, actionCommand))).data as unknown as JsonObject;
        } else if (action.type === "send_work_instruction") {
          exactKeys(payload, ["work_id", "body"], `actions[${action.action_id}].payload`, ["reopen"]);
          const workId = pathId(stringField(payload.work_id, "work_id", 1, 128), "work_id");
          const input = validateWorkInstructionPayload({ body: payload.body, ...(payload.reopen === undefined ? {} : { reopen: payload.reopen }) });
          data = (await withWorkLock(context, workId, async () => context.core.postWorkInstruction(workId, input, actionCommand))).data as unknown as JsonObject;
        } else if (action.type === "update_work") {
          exactKeys(payload, ["work_id"], `actions[${action.action_id}].payload`, ["title", "summary"]);
          const workId = pathId(stringField(payload.work_id, "work_id", 1, 128), "work_id");
          const input = validateUpdateWorkPayload(payload);
          data = (await withWorkLock(context, workId, async () => context.core.updateWork(workId, input, actionCommand))).data as unknown as JsonObject;
        } else if (action.type === "resume_work") {
          exactKeys(payload, ["work_id"], `actions[${action.action_id}].payload`);
          const workId = pathId(stringField(payload.work_id, "work_id", 1, 128), "work_id");
          data = (await withWorkLock(context, workId, async () => context.core.resumeWorkOrRetryDecision(workId, actionCommand))).data as unknown as JsonObject;
        } else if (action.type === "answer_decision") {
          const decisionId = pathId(stringField(payload.decision_id, "decision_id", 1, 128), "decision_id");
          const answer = stringField(payload.answer, "answer", 1, 10000);
          const option_key = payload.option_key === undefined || payload.option_key === null ? null : stringField(payload.option_key, "option_key", 1, 200);
          const decisionWork = decisionWorkId(context, decisionId);
          const operation = () => context.core.answerDecision(decisionId, { answer, option_key, source: "advisor", source_message_id: null }, actionCommand);
          data = (await (decisionWork === undefined ? operation() : withWorkLock(context, decisionWork, operation))).data as unknown as JsonObject;
        } else if (ADVISOR_CURATION_ACTION_TYPES.has(action.type)) {
          const kind = advisorCurationKind(action.type);
          if (kind === null) throw new ApiError(422, "action_rejected", `${action.type}は許可されたAdvisor actionではありません。`);
          const run = await requireCurationApi(context.core).runCuration({
            kind,
            trigger: "advisor_action",
            actor: "advisor",
            actor_ref: command.request_id,
            request_key: actionCommand.idempotency_key,
          });
          if (run.status === "failed") throw new ApiError(500, "curation_failed", run.error ?? "整理の実行に失敗しました。", { run_id: run.id });
          data = { run_id: run.id, status: run.status, summary: run.summary };
        } else {
          throw new ApiError(422, "action_rejected", "send_fileは配送先Connectorが設定されている場合だけ実行できます。");
        }
        results.push({ action_id: action.action_id, status: "executed", result: data, error_code: null });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        results.push({ action_id: action.action_id, status: "rejected", result: null, error_code: error.code });
      }
    }
    sendJson(response, 200, { request_id: command.request_id, data: { results }, version: command.expected_version });
    return;
  }

  if (pathname === `${API_PREFIX}/projects` && method === "GET") {
    requireOwner(request);
    const result = await context.core.listProjects({
      limit: parseLimit(url.searchParams.get("limit"), 50),
      cursor: nullableQuery(url.searchParams.get("cursor")),
    });
    sendJson(response, 200, { ...result, request_id: requestIdValue });
    return;
  }

  if (pathname === `${API_PREFIX}/projects/folders` && method === "GET") {
    requireOwner(request);
    const path = validateOptionalFolderPath(url.searchParams.get("path"));
    const browser = await browseProjectFolders(path).catch((error: unknown) => {
      throw new ApiError(400, "validation_error", error instanceof Error ? error.message : "フォルダを表示できませんでした。");
    });
    sendJson(response, 200, { request_id: requestIdValue, data: browser });
    return;
  }

  if (pathname === `${API_PREFIX}/projects/inspect` && method === "POST") {
    requireOwner(request);
    const path = validateProjectFolderRequest(await readRequestBody(request));
    const inspection = await inspectProjectFolder(path).catch((error: unknown) => {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, "validation_error", error instanceof Error ? error.message : "このフォルダを確認できませんでした。");
    });
    sendJson(response, 200, { request_id: requestIdValue, data: inspection });
    return;
  }

  if (pathname === `${API_PREFIX}/projects/setup` && method === "POST") {
    requireOwner(request);
    const body = await readRequestBody(request);
    const command = commandEnvelope(body);
    const payload = validateProjectSetupPayload(command.payload);
    const result = await runCommand(context, pathname, command, 201, async () => {
      let repository: { canonical_path: string; base_branch: string };
      if (payload.mode === "new") {
        if (!isAbsolute(payload.path)) throw new ApiError(400, "validation_error", "新しいプロジェクトの保存場所を確認してください。");
        const parentPath = await realpath(payload.path).catch(() => {
          throw new ApiError(400, "validation_error", "保存先のフォルダが見つかりません。");
        });
        const targetPath = join(parentPath, payload.name);
        await assertProjectPathNotRegistered(context.core, targetPath);
        repository = await initializeNewProjectFolder(targetPath);
      } else {
        const inspection = await inspectProjectFolder(payload.path);
        if (inspection.kind === "missing" || inspection.kind === "not_directory") {
          throw new ApiError(400, "validation_error", "選んだフォルダが見つかりません。場所を確認してください。");
        }
        await assertProjectPathNotRegistered(context.core, inspection.canonical_path);
        if (payload.mode === "existing") {
          if (inspection.kind !== "git_ready") {
            throw new ApiError(409, "validation_error", "このフォルダにはまだ作業履歴がありません。内容を確認してGitを準備するか、登録を後で行ってください。", { inspection });
          }
          repository = { canonical_path: inspection.canonical_path, base_branch: inspection.base_branch };
        } else {
          try {
            repository = await initializeExistingProjectFolder(payload.path);
          } catch (error) {
            throw new ApiError(400, "validation_error", error instanceof Error ? error.message : "このフォルダのGit準備に失敗しました。");
          }
        }
      }

      const created = await context.core.createProject(projectCreatePayload(payload.name, repository), command);
      return { data: created.data as unknown as JsonObject, version: created.version };
    });
    sendJson(response, 201, result);
    return;
  }

  if (pathname === `${API_PREFIX}/projects` && method === "POST") {
    requireOwner(request);
    const body = await readRequestBody(request);
    const command = commandEnvelope(body);
    const payload = validateCreateProjectPayload(command.payload);
    const result = await runCommand(context, pathname, command, 201, async () => {
      const created = await context.core.createProject(payload, command);
      return { data: created.data as unknown as JsonObject, version: created.version };
    });
    sendJson(response, 201, result);
    return;
  }

  const projectImpactMatch = pathname.match(new RegExp(`^${API_PREFIX}/projects/([^/]+)/deletion-impact$`));
  const projectMatch = pathname.match(new RegExp(`^${API_PREFIX}/projects/([^/]+)$`));
  if (projectImpactMatch && method === "GET") {
    requireOwner(request);
    const projectId = pathId(projectImpactMatch[1], "project_id");
    const impact = await context.core.getProjectDeletionImpact(projectId);
    sendJson(response, 200, { request_id: requestIdValue, data: impact });
    return;
  }

  if (projectMatch && method === "PATCH") {
    requireOwner(request);
    const projectId = pathId(projectMatch[1], "project_id");
    const command = commandEnvelope(await readRequestBody(request));
    const input = validateProjectUpdatePayload(command.payload);
    const result = await runCommand(context, pathname, command, 200, async () => {
      const current = await requireRegisteredProject(context.core, projectId);
      const update: UpdateProjectInput = {};
      if (input.name !== undefined) update.name = input.name;
      if (input.auto_push !== undefined) update.auto_push = input.auto_push;
      if (input.worktree_setup_command !== undefined) update.worktree_setup_command = input.worktree_setup_command;
      if (input.worktree_refresh_command !== undefined) update.worktree_refresh_command = input.worktree_refresh_command;
      if (input.canonical_path !== undefined && resolve(input.canonical_path) !== resolve(current.canonical_path)) {
        const inspection = await inspectProjectFolder(input.canonical_path).catch((error: unknown) => {
          if (error instanceof ApiError) throw error;
          throw new ApiError(400, "validation_error", error instanceof Error ? error.message : "このフォルダを確認できませんでした。");
        });
        if (inspection.kind === "missing" || inspection.kind === "not_directory") {
          throw new ApiError(400, "validation_error", "選んだフォルダが見つかりません。場所を確認してください。");
        }
        if (inspection.kind !== "git_ready") {
          throw new ApiError(400, "validation_error", "このフォルダにはまだ作業履歴がありません。先にProjectの追加画面でGitを準備してから、もう一度変更してください。", { inspection });
        }
        if (resolve(inspection.canonical_path) !== resolve(current.canonical_path)) {
          await assertProjectPathNotRegistered(context.core, inspection.canonical_path, projectId);
          update.canonical_path = inspection.canonical_path;
          update.base_branch = inspection.base_branch;
        }
      }
      const updated = await context.core.updateProject(projectId, update, command);
      return { data: updated.data as unknown as JsonObject, version: updated.version };
    });
    sendJson(response, 200, result);
    return;
  }

  if (projectMatch && method === "DELETE") {
    requireOwner(request);
    const projectId = pathId(projectMatch[1], "project_id");
    const command = commandEnvelope(await readRequestBody(request));
    const input = validateDeleteProjectPayload(command.payload);
    const result = await runCommand(context, pathname, command, 200, async () => {
      const deleted = await context.core.deleteProject(projectId, input, command);
      return { data: deleted.data as unknown as JsonObject, version: deleted.version };
    });
    sendJson(response, 200, result);
    return;
  }

  if (pathname === `${API_PREFIX}/settings/models` && method === "GET") {
    requireOwner(request);
    const { version, roles } = await context.core.getModelSettings();
    sendJson(response, 200, { request_id: requestIdValue, data: { roles }, version });
    return;
  }

  if (pathname === `${API_PREFIX}/settings/models` && method === "PUT") {
    requireOwner(request);
    const body = await readRequestBody(request);
    const command = commandEnvelope(body);
    const payload = validateUpdateModelSettingsPayload(command.payload);
    const result = await runCommand(context, pathname, command, 200, async () => context.core.updateModelSettings(payload, command));
    sendJson(response, 200, result);
    return;
  }

  if (pathname === `${API_PREFIX}/settings/model-presets` && method === "GET") {
    requireOwner(request);
    const { version, presets } = await context.core.getModelPresets();
    sendJson(response, 200, { request_id: requestIdValue, data: { presets }, version });
    return;
  }

  if (pathname === `${API_PREFIX}/settings/model-presets` && method === "POST") {
    requireOwner(request);
    const command = commandEnvelope(await readRequestBody(request));
    const payload = validateCreateModelPresetPayload(command.payload);
    const result = await runCommand(context, pathname, command, 201, async () => context.core.createModelPreset(payload, command));
    sendJson(response, 201, result);
    return;
  }

  const modelPresetMatch = pathname.match(new RegExp(`^${API_PREFIX}/settings/model-presets/([^/]+)$`));
  if (modelPresetMatch && method === "PUT") {
    requireOwner(request);
    const id = pathId(modelPresetMatch[1]!, "id");
    const command = commandEnvelope(await readRequestBody(request));
    const payload = validateUpdateModelPresetPayload(command.payload);
    const result = await runCommand(context, pathname, command, 200, async () => context.core.updateModelPreset(id, payload, command));
    sendJson(response, 200, result);
    return;
  }

  if (modelPresetMatch && method === "DELETE") {
    requireOwner(request);
    const id = pathId(modelPresetMatch[1]!, "id");
    const command = commandEnvelope(await readRequestBody(request));
    exactKeys(command.payload, [], "DeleteModelPreset payload");
    const result = await runCommand(context, pathname, command, 200, async () => context.core.deleteModelPreset(id, command));
    sendJson(response, 200, result);
    return;
  }

  if (pathname === `${API_PREFIX}/settings/process-skills` && method === "GET") {
    requireOwner(request);
    const settings = await context.core.getProcessSkillsSettings();
    sendJson(response, 200, { request_id: requestIdValue, data: settings, version: 0 });
    return;
  }

  if (pathname === `${API_PREFIX}/settings/knowledge-automation` && method === "GET") {
    requireOwner(request);
    const settings = await context.core.getKnowledgeAutomationSettings();
    sendJson(response, 200, {
      request_id: requestIdValue,
      data: { ...settings, time_zone: hostTimeZone() },
      version: 0,
    });
    return;
  }

  if (pathname === `${API_PREFIX}/settings/knowledge-automation` && method === "PUT") {
    requireOwner(request);
    const command = commandEnvelope(await readRequestBody(request));
    exactKeys(command.payload, ["librarian_times", "research_autosave"], "Knowledge automation settings payload");
    const input = validatedKnowledgeAutomationSettings(command.payload);
    const result = await runCommand(context, pathname, command, 200, async () => {
      const settings = await context.core.setKnowledgeAutomationSettings(input);
      return { data: { ...settings, time_zone: hostTimeZone() } as unknown as JsonObject, version: 0 };
    });
    sendJson(response, 200, result);
    return;
  }

  if (pathname === `${API_PREFIX}/settings/process-skills` && method === "PUT") {
    requireOwner(request);
    const command = commandEnvelope(await readRequestBody(request));
    const payload = command.payload;
    exactKeys(payload, ["enabled", "path"], "Process skills settings payload");
    if (typeof payload.enabled !== "boolean" || (payload.path !== null && typeof payload.path !== "string")) {
      throw new ApiError(400, "validation_error", "enabled must be a boolean and path must be a string or null.");
    }
    const input: ProcessSkillsSettingsInput = { enabled: payload.enabled, path: payload.path as string | null };
    const result = await runCommand(context, pathname, command, 200, async () => {
      const data = await context.core.setProcessSkillsSettings(input);
      return { data: data as unknown as JsonObject, version: 0 };
    });
    sendJson(response, 200, result);
    return;
  }

  if (pathname === `${API_PREFIX}/settings/integrations` && method === "GET") {
    requireOwner(request);
    const integrations = await context.core.getIntegrations();
    sendJson(response, 200, { request_id: requestIdValue, data: { integrations } });
    return;
  }

  const integrationProviderMatch = pathname.match(new RegExp(`^${API_PREFIX}/settings/integrations/(slack|discord)$`));

  if (integrationProviderMatch && method === "PUT") {
    requireOwner(request);
    const provider = integrationProviderMatch[1] as IntegrationProvider;
    const body = await readRequestBody(request);
    const command = commandEnvelope(body);
    const currentIntegration = (await context.core.getIntegrations()).find((integration) => integration.provider === provider);
    const config = validateIntegrationPayload(command.payload, provider, currentIntegration?.configured === true);
    const result = await runCommand(context, pathname, command, 200, async () => context.core.saveIntegration(provider, config, command));
    sendJson(response, 200, result);
    return;
  }

  if (integrationProviderMatch && method === "DELETE") {
    requireOwner(request);
    const provider = integrationProviderMatch[1] as IntegrationProvider;
    const body = await readRequestBody(request);
    const command = commandEnvelope(body);
    const result = await runCommand(context, pathname, command, 200, async () => context.core.deleteIntegration(provider, command));
    sendJson(response, 200, result);
    return;
  }

  const integrationTestMatch = pathname.match(new RegExp(`^${API_PREFIX}/settings/integrations/(slack|discord)/test$`));
  if (integrationTestMatch && method === "POST") {
    requireOwner(request);
    const provider = integrationTestMatch[1] as IntegrationProvider;
    const result = await context.core.testIntegration(provider);
    sendJson(response, 200, { request_id: requestIdValue, data: result });
    return;
  }


  // ---- Skill Box ------------------------------------------------------------

  const skills = () => requireSkillApi(context.core);

  if (pathname === `${API_PREFIX}/skill-activity` && method === "GET") {
    requireOwner(request);
    const rawDays = url.searchParams.get("days");
    const days = rawDays === null ? 7 : /^\d+$/u.test(rawDays) ? Number(rawDays) : NaN;
    if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
      throw new ApiError(400, "validation_error", "days must be an integer between 1 and 90.", { field: "days" });
    }
    sendJson(response, 200, { request_id: requestIdValue, data: skills().getSkillActivity(days) });
    return;
  }

  if (pathname === `${API_PREFIX}/skills` && method === "GET") {
    requireOwner(request);
    const rawTrial = url.searchParams.get("trial");
    const q = nullableQuery(url.searchParams.get("q"));
    const state = nullableQuery(url.searchParams.get("state"));
    const scope = nullableQuery(url.searchParams.get("scope"));
    const data = skills().listSkills({
      ...(q === null ? {} : { query: q }),
      ...(state === null ? {} : { state }),
      ...(scope === null ? {} : { scope }),
      ...(rawTrial === null || rawTrial === "" ? {} : { trial: parseBoolean(rawTrial, false) }),
    });
    sendJson(response, 200, { request_id: requestIdValue, data });
    return;
  }

  const skillRevisionDetailMatch = pathname.match(new RegExp(`^${API_PREFIX}/skills/([^/]+)/revisions/([^/]+)$`));
  if (skillRevisionDetailMatch && method === "GET") {
    requireOwner(request);
    const name = decodeSkillRouteValue(skillRevisionDetailMatch[1]!, "name");
    const revisionId = decodeSkillRouteValue(skillRevisionDetailMatch[2]!, "revision_id");
    if (!isUlid(revisionId)) throw new ApiError(400, "validation_error", "revision_id must be a ULID.", { field: "revision_id" });
    const data = skills().getSkillRevision(name, revisionId);
    sendJson(response, 200, { request_id: requestIdValue, data });
    return;
  }

  const skillRevisionListMatch = pathname.match(new RegExp(`^${API_PREFIX}/skills/([^/]+)/revisions$`));
  if (skillRevisionListMatch && method === "GET") {
    requireOwner(request);
    const name = decodeSkillRouteValue(skillRevisionListMatch[1]!, "name");
    const data = skills().listSkillRevisions(name);
    sendJson(response, 200, { request_id: requestIdValue, data });
    return;
  }

  const skillRestoreMatch = pathname.match(new RegExp(`^${API_PREFIX}/skills/([^/]+)/restore$`));
  if (skillRestoreMatch && method === "POST") {
    requireOwner(request);
    const name = decodeSkillRouteValue(skillRestoreMatch[1]!, "name");
    const command = commandEnvelope(await readRequestBody(request));
    exactKeys(command.payload, ["revision_id"], "Restore skill payload");
    const revisionId = stringField(command.payload.revision_id, "revision_id", 1, 128);
    if (!isUlid(revisionId)) throw new ApiError(400, "validation_error", "revision_id must be a ULID.", { field: "revision_id" });
    const result = await runCommand(context, pathname, command, 200, async () => {
      const restored = await skills().restoreSkill(name, revisionId);
      return { data: restored.data, version: restored.version };
    });
    sendJson(response, 200, result);
    return;
  }

  const skillDetailMatch = pathname.match(new RegExp(`^${API_PREFIX}/skills/([^/]+)$`));
  if (skillDetailMatch && method === "GET") {
    requireOwner(request);
    const name = decodeSkillRouteValue(skillDetailMatch[1]!, "name");
    const data = await skills().getSkill(name);
    sendJson(response, 200, { request_id: requestIdValue, data });
    return;
  }

  if (skillDetailMatch && method === "PATCH") {
    requireOwner(request);
    const name = decodeSkillRouteValue(skillDetailMatch[1]!, "name");
    const command = commandEnvelope(await readRequestBody(request));
    const keys = Object.keys(command.payload);
    const extra = keys.filter((key) => key !== "state" && key !== "scope");
    if (extra.length > 0 || keys.length === 0) {
      throw new ApiError(400, "validation_error", "Skill update must contain state, scope, or both.", { extra });
    }
    if (command.payload.state !== undefined && typeof command.payload.state !== "string") {
      throw new ApiError(400, "validation_error", "state must be a string.", { field: "state" });
    }
    if (command.payload.scope !== undefined && typeof command.payload.scope !== "string") {
      throw new ApiError(400, "validation_error", "scope must be a string.", { field: "scope" });
    }
    const patch = {
      ...(typeof command.payload.state === "string" ? { state: command.payload.state } : {}),
      ...(typeof command.payload.scope === "string" ? { scope: command.payload.scope } : {}),
    };
    const result = await runCommand(context, pathname, command, 200, async () => {
      const updated = await skills().updateSkill(name, patch);
      return { data: updated.data, version: updated.version };
    });
    sendJson(response, 200, result);
    return;
  }

  if (pathname === `${API_PREFIX}/skill-proposals` && method === "GET") {
    requireOwner(request);
    const statusValue = url.searchParams.get("status");
    const data = skills().listSkillProposals(statusValue === null ? undefined : statusValue);
    sendJson(response, 200, { request_id: requestIdValue, data });
    return;
  }

  if (pathname === `${API_PREFIX}/knowledge/migrate-legacy` && method === "POST") {
    requireOwner(request);
    const command = commandEnvelope(await readRequestBody(request));
    const payload = validateLegacyKnowledgeMigrationPayload(command.payload);
    const api = requireKnowledgeMigrationApi(context.core);
    const result = await runCommand(context, pathname, command, 200, async () => {
      const migrated = await api.migrateLegacyKnowledge(payload);
      if (!payload.dry_run) await dispatchPendingCoreEvents(context.core);
      return { data: migrated as JsonObject, version: command.expected_version };
    });
    sendJson(response, 200, result);
    return;
  }

  if (pathname === `${API_PREFIX}/knowledge/retag` && method === "POST") {
    requireOwner(request);
    const command = commandEnvelope(await readRequestBody(request));
    const payload = validateKnowledgeRetagPayload(command.payload);
    const api = requireKnowledgeRetagApi(context.core);
    const result = await runCommand(context, pathname, command, 200, async () => {
      try {
        return { data: (await api.retagKnowledgeNotes(payload)) as JsonObject, version: command.expected_version };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "retag_in_progress") throw new ApiError(409, "retag_in_progress", "ナレッジのタグ再生成はすでに実行中です。");
        if (message.startsWith("dependency_unavailable")) throw new ApiError(503, "dependency_unavailable", message);
        throw error;
      }
    });
    sendJson(response, 200, result);
    return;
  }

  if (pathname === `${API_PREFIX}/rule-proposals` && method === "GET") {
    requireRuleProposalOwner(request);
    const statusValue = url.searchParams.get("status");
    let data: unknown[];
    try {
      data = requireRuleProposalApi(context.core).listRuleProposals(statusValue === null ? undefined : statusValue);
    } catch (error) {
      throw ruleProposalApiError(error);
    }
    sendJson(response, 200, { request_id: requestIdValue, data });
    return;
  }

  if (pathname === `${API_PREFIX}/rule-proposals` && method === "POST") {
    requireRuleProposalOwner(request);
    const command = commandEnvelope(await readRequestBody(request));
    const payload = validateCreateRuleProposalPayload(command.payload);
    const api = requireRuleProposalApi(context.core);
    const result = await runCommand(context, pathname, command, 201, async () => {
      try {
        const created = await api.createRuleProposalFromNote(payload);
        await dispatchPendingCoreEvents(context.core);
        return ruleProposalCommandResult(created);
      } catch (error) {
        throw ruleProposalApiError(error);
      }
    });
    sendJson(response, 201, result);
    return;
  }

  const ruleProposalActionMatch = pathname.match(new RegExp(`^${API_PREFIX}/rule-proposals/([^/]+)/(approve|reject)$`));
  if (ruleProposalActionMatch && method === "POST") {
    requireRuleProposalOwner(request);
    const proposalId = decodeSkillRouteValue(ruleProposalActionMatch[1]!, "proposal_id");
    if (!isUlid(proposalId)) throw new ApiError(400, "validation_error", "proposal_id must be a ULID.", { field: "proposal_id" });
    const command = commandEnvelope(await readRequestBody(request));
    validateEmptyPayload(command.payload);
    const api = requireRuleProposalApi(context.core);
    const action = ruleProposalActionMatch[2];
    const result = await runCommand(context, pathname, command, 200, async () => {
      try {
        const updated = action === "approve"
          ? await api.approveRuleProposal(proposalId)
          : await api.rejectRuleProposal(proposalId);
        return ruleProposalCommandResult(updated);
      } catch (error) {
        throw ruleProposalApiError(error);
      }
    });
    sendJson(response, 200, result);
    return;
  }

  if (pathname === `${API_PREFIX}/learning-jobs` && method === "GET") {
    requireOwner(request);
    const statusValue = url.searchParams.get("status");
    const data = featureCore.listLearningJobs(statusValue === null ? undefined : statusValue);
    sendJson(response, 200, { request_id: requestIdValue, data });
    return;
  }

  const learningJobRetryMatch = pathname.match(new RegExp(`^${API_PREFIX}/learning-jobs/([^/]+)/retry$`));
  if (learningJobRetryMatch && method === "POST") {
    requireOwner(request);
    const jobId = decodeSkillRouteValue(learningJobRetryMatch[1]!, "job_id");
    if (!isUlid(jobId)) throw new ApiError(400, "validation_error", "job_id must be a ULID.", { field: "job_id" });
    await featureCore.retryLearningJob(jobId);
    sendJson(response, 200, { request_id: requestIdValue, data: { job_id: jobId } });
    return;
  }

  const skillProposalActionMatch = pathname.match(new RegExp(`^${API_PREFIX}/skill-proposals/([^/]+)/(approve|reject)$`));
  if (skillProposalActionMatch && method === "POST") {
    requireOwner(request);
    const proposalId = decodeSkillRouteValue(skillProposalActionMatch[1]!, "proposal_id");
    const command = commandEnvelope(await readRequestBody(request));
    validateEmptyPayload(command.payload);
    const action = skillProposalActionMatch[2];
    const result = await runCommand(context, pathname, command, 200, async () => {
      const updated = action === "approve"
        ? await skills().approveSkillProposal(proposalId)
        : await skills().rejectSkillProposal(proposalId);
      return { data: updated.data, version: updated.version };
    });
    sendJson(response, 200, result);
    return;
  }

  // ---- Review backlog ----
  if (pathname === `${API_PREFIX}/backlog` && method === "GET") {
    requireOwner(request);
    const projectId = validateBacklogProjectId(url.searchParams.get("project_id"));
    const status = validateBacklogStatus(url.searchParams.get("status"));
    const workIdValue = url.searchParams.get("work_id");
    const workId = workIdValue === null ? undefined : pathId(workIdValue, "work_id");
    const issuedWorkIdValue = url.searchParams.get("issued_work_id");
    const issuedWorkId = issuedWorkIdValue === null ? undefined : pathId(issuedWorkIdValue, "issued_work_id");
    const result = requireBacklogApi(context.core).listBacklogItems({
      ...(projectId === undefined ? {} : { project_id: projectId }),
      ...(status === undefined ? {} : { status }),
      ...(workId === undefined ? {} : { work_id: workId }),
      ...(issuedWorkId === undefined ? {} : { issued_work_id: issuedWorkId }),
      limit: parseBacklogLimit(url.searchParams.get("limit")),
      offset: parseBacklogOffset(url.searchParams.get("offset")),
    });
    sendJson(response, 200, { request_id: requestIdValue, data: result.items, next_offset: result.next_offset });
    return;
  }

  if (pathname === `${API_PREFIX}/backlog/dismiss` && method === "POST") {
    requireOwner(request);
    const command = commandEnvelope(await readRequestBody(request));
    const payload = validateDismissBacklogPayload(command.payload);
    const result = await runCommand(context, pathname, command, 200, async () => {
      const dismissed = await requireBacklogApi(context.core).dismissBacklogItems({ ...command, payload });
      return { data: dismissed.data, version: dismissed.version };
    });
    sendJson(response, 200, result);
    return;
  }

  if (pathname === `${API_PREFIX}/backlog/issue-work` && method === "POST") {
    requireOwner(request);
    const command = commandEnvelope(await readRequestBody(request));
    const payload = validateIssueBacklogWorkPayload(command.payload);
    const result = await runCommand(context, pathname, command, 201, async () => {
      const issued = await requireBacklogApi(context.core).issueBacklogWork({ ...command, payload });
      return { data: issued.data, version: issued.version };
    });
    sendJson(response, 201, result);
    return;
  }

  if (pathname === `${API_PREFIX}/settings/skills` && method === "GET") {
    requireOwner(request);
    sendJson(response, 200, { request_id: requestIdValue, data: skills().getSkillSettings() });
    return;
  }

  if (pathname === `${API_PREFIX}/settings/skills` && method === "PUT") {
    requireOwner(request);
    const command = commandEnvelope(await readRequestBody(request));
    const result = await runCommand(context, pathname, command, 200, async () => {
      const updated = await skills().setSkillSettings(command.payload);
      return { data: updated.data, version: updated.version };
    });
    sendJson(response, 200, result);
    return;
  }

  // ---- Hybrid Mode ----------------------------------------------------------

  if (pathname === `${API_PREFIX}/settings/hybrid` && method === "GET") {
    requireOwner(request);
    const enabled = await context.core.getHybridMode();
    sendJson(response, 200, { request_id: requestIdValue, data: { hybrid_mode: enabled } });
    return;
  }

  if (pathname === `${API_PREFIX}/settings/hybrid` && method === "PUT") {
    requireOwner(request);
    const body = await readRequestBody(request);
    const cmd = commandEnvelope(body);
    if (typeof cmd.payload.hybrid_mode !== "boolean") {
      throw new ApiError(400, "validation_error", "hybrid_modeが不正です。booleanを指定してください。");
    }
    const enabled = cmd.payload.hybrid_mode as boolean;
    const result = await runCommand(context, pathname, cmd, 200, async () => {
      const value = await context.core.setHybridMode(enabled);
      return { data: { hybrid_mode: value } as JsonObject, version: 0 };
    });
    sendJson(response, 200, result);
    return;
  }

  // ---- Owner language -------------------------------------------------------

  if (pathname === `${API_PREFIX}/settings/language` && method === "GET") {
    requireOwner(request);
    const language = await requestOwnerLanguage(context.core);
    sendJson(response, 200, { request_id: requestIdValue, data: { language } });
    return;
  }

  if (pathname === `${API_PREFIX}/settings/language` && method === "PUT") {
    requireOwner(request);
    const body = await readRequestBody(request);
    const cmd = commandEnvelope(body);
    const language = cmd.payload.language;
    if (!isOwnerLanguage(language)) {
      throw new ApiError(400, "validation_error", "languageが不正です。\"ja\"または\"en\"を指定してください。");
    }
    const result = await runCommand(context, pathname, cmd, 200, async () => {
      const value = await context.core.setLanguage(language);
      return { data: { language: value } as JsonObject, version: 0 };
    });
    sendJson(response, 200, result);
    return;
  }

  // ---- Executor Config ------------------------------------------------------

  if (pathname === `${API_PREFIX}/settings/executor` && method === "GET") {
    requireOwner(request);
    const config = await context.core.getExecutorConfig();
    sendJson(response, 200, { request_id: requestIdValue, data: config });
    return;
  }

  if (pathname === `${API_PREFIX}/settings/executor` && method === "PUT") {
    requireOwner(request);
    const body = await readRequestBody(request);
    const cmd = commandEnvelope(body);
    const p = cmd.payload;
    const provider = typeof p.provider === "string" && (p.provider as string).length > 0 ? p.provider as string : undefined;
    const model = typeof p.model === "string" && (p.model as string).length > 0 ? p.model as string : undefined;
    const effort = typeof p.effort === "string" ? p.effort as string : undefined;
    const timeout_ms = typeof p.timeout_ms === "number" && (p.timeout_ms as number) >= 0 ? p.timeout_ms as number : undefined;
    if (!provider || !model || timeout_ms === undefined || !Number.isSafeInteger(timeout_ms)) {
      throw new ApiError(400, "validation_error", "provider、model、timeout_msをすべて指定してください。");
    }
    if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(effort)) {
      throw new ApiError(400, "validation_error", "effortはlow、medium、high、xhigh、maxのいずれかを指定してください。");
    }
    const config: ExecutorSettingsConfig = { provider, model, effort, timeout_ms };
    const result = await runCommand(context, pathname, cmd, 200, async () => {
      const saved = await context.core.setExecutorConfig(config);
      return { data: saved as unknown as JsonObject, version: 0 };
    });
    sendJson(response, 200, result);
    return;
  }


  // ---- Typesafe API Key -------------------------------------------------------

  if (pathname === `${API_PREFIX}/settings/typesafe` && method === "GET") {
    requireOwner(request);
    const key = await context.core.getTypesafeApiKey();
    const masked = key.length > 4 ? "*".repeat(key.length - 4) + key.slice(-4) : key ? "****" : "";
    sendJson(response, 200, { request_id: requestIdValue, data: { typesafe_api_key: masked } });
    return;
  }

  if (pathname === `${API_PREFIX}/settings/typesafe` && method === "PUT") {
    requireOwner(request);
    const body = await readRequestBody(request);
    const cmd = commandEnvelope(body);
    if (typeof cmd.payload.typesafe_api_key !== "string") {
      throw new ApiError(400, "validation_error", "typesafe_api_keyが不正です。文字列を指定してください。");
    }
    const key = cmd.payload.typesafe_api_key as string;
    const result = await runCommand(context, pathname, cmd, 200, async () => {
      const saved = await context.core.setTypesafeApiKey(key);
      const masked = saved.length > 4 ? "*".repeat(saved.length - 4) + saved.slice(-4) : saved ? "****" : "";
      return { data: { typesafe_api_key: masked } as JsonObject, version: 0 };
    });
    sendJson(response, 200, result);
    return;
  }

  // ---- Advisor Persona ------------------------------------------------------

  if (pathname === `${API_PREFIX}/fs/directories` && method === "GET") {
    requireOwner(request);
    const showHidden = url.searchParams.get("show_hidden") ?? "0";
    if (showHidden !== "0" && showHidden !== "1") {
      throw new ApiError(422, "validation_error", "show_hiddenは0または1で指定してください。");
    }
    sendJson(response, 200, { request_id: requestIdValue,
      data: await listHostDirectories(url.searchParams.get("path") ?? undefined, showHidden === "1", context.dataDir), version: 0 });
    return;
  }

  if (pathname === `${API_PREFIX}/settings/advisor-folders` && method === "GET") {
    requireOwner(request);
    sendJson(response, 200, { request_id: requestIdValue, data: await context.core.getAdvisorFolders(), version: 0 });
    return;
  }

  if (pathname === `${API_PREFIX}/settings/advisor-folders` && method === "PUT") {
    requireOwner(request);
    const cmd = commandEnvelope(await readRequestBody(request));
    if (typeof cmd.payload.shared_dir !== "string" || typeof cmd.payload.screenshot_dir !== "string") {
      throw new ApiError(400, "validation_error", "shared_dirとscreenshot_dirは文字列で指定してください。");
    }
    const result = await runCommand(context, pathname, cmd, 200, async () => {
      try {
        const saved = await context.core.setAdvisorFolders(cmd.payload.shared_dir as string, cmd.payload.screenshot_dir as string);
        return { data: saved as unknown as JsonObject, version: 0 };
      } catch (error) {
        if (error instanceof AdvisorFolderError) {
          throw new ApiError(422, "validation_error", error.reason === "tracked"
            ? "共有フォルダはgitで追跡される場所には指定できません。.gitignoreで除外された場所かリポジトリの外を指定してください。"
            : "フォルダは絶対パスで指定してください。");
        }
        throw error;
      }
    });
    sendJson(response, 200, result);
    return;
  }

  if (pathname === `${API_PREFIX}/settings/knowledge-storage` && method === "GET") {
    requireOwner(request);
    const api = requireKnowledgeStorageApi(context.core);
    const status = url.searchParams.get("refresh") === "1" ? await api.checkKnowledgeStorage() : api.getKnowledgeStorage();
    sendJson(response, 200, { request_id: requestIdValue, data: status as unknown as JsonObject, version: 0 });
    return;
  }

  if (pathname === `${API_PREFIX}/settings/knowledge-storage` && method === "PUT") {
    requireOwner(request);
    const cmd = commandEnvelope(await readRequestBody(request));
    exactKeys(cmd.payload, ["path"], "payload", ["mode"]);
    const { path, mode } = cmd.payload;
    if (typeof path !== "string" || (mode !== undefined && mode !== "move" && mode !== "relink")) {
      throw new ApiError(400, "validation_error", "pathは文字列、modeはmoveまたはrelinkで指定してください。");
    }
    const api = requireKnowledgeStorageApi(context.core);
    const result = await runCommand(context, pathname, cmd, 200, async () => {
      try {
        return { data: await api.moveKnowledgeStorage({ path, mode }) as unknown as JsonObject, version: 0 };
      } catch (error) {
        const code = knowledgeStorageErrorCode(error);
        const status = code === "validation_error" || code === "knowledge_target_invalid" ? 422
          : code === "knowledge_storage_busy" ? 409 : code === "knowledge_move_failed" ? 500 : 0;
        if (status === 0 || !(error instanceof Error)) throw error;
        const details = (error as { details?: unknown }).details;
        throw new ApiError(status, code as ApiErrorCode, error.message, isObject(details) ? details : {});
      }
    });
    sendJson(response, 200, result);
    return;
  }

  if (pathname === `${API_PREFIX}/settings/advisor-persona` && method === "GET") {
    requireOwner(request);
    const advisor_persona = await context.core.getAdvisorPersona();
    sendJson(response, 200, { request_id: requestIdValue, data: { advisor_persona }, version: 0 });
    return;
  }

  if (pathname === `${API_PREFIX}/settings/advisor-persona` && method === "PUT") {
    requireOwner(request);
    const body = await readRequestBody(request);
    const cmd = commandEnvelope(body);
    if (typeof cmd.payload.advisor_persona !== "string") {
      throw new ApiError(400, "validation_error", "advisor_personaが不正です。文字列を指定してください。", { field: "advisor_persona" });
    }
    const advisorPersona = (cmd.payload.advisor_persona as string).trim();
    if (advisorPersona.length > MAX_ADVISOR_PERSONA_LENGTH) {
      throw new ApiError(400, "validation_error", `advisor_personaは${MAX_ADVISOR_PERSONA_LENGTH}文字以内で指定してください。`, {
        field: "advisor_persona",
        max_length: MAX_ADVISOR_PERSONA_LENGTH,
      });
    }
    const result = await runCommand(context, pathname, cmd, 200, async () => {
      const saved = await context.core.setAdvisorPersona(advisorPersona);
      return { data: { advisor_persona: saved } as JsonObject, version: 0 };
    });
    sendJson(response, 200, result);
    return;
  }

  // ---- Provider Management ---------------------------------------------------

  if (pathname === `${API_PREFIX}/providers/pauses` && method === "GET") {
    requireOwner(request);
    const pauses = await context.core.listProviderPauses();
    sendJson(response, 200, { request_id: requestIdValue, data: { pauses } });
    return;
  }

  const providerPauseResumeMatch = pathname.match(new RegExp(`^${API_PREFIX}/providers/pauses/([^/]+)/resume$`));
  if (providerPauseResumeMatch && method === "POST") {
    requireOwner(request);
    const provider = decodeURIComponent(providerPauseResumeMatch[1]);
    const pause = await context.core.resumeProviderPause(provider);
    sendJson(response, 200, { request_id: requestIdValue, data: { pause } });
    return;
  }

  if (pathname === `${API_PREFIX}/settings/providers` && method === "GET") {
    requireOwner(request);
    const providers = await context.core.listProviders();
    sendJson(response, 200, { request_id: requestIdValue, data: providers });
    return;
  }

  const providerIdMatch = pathname.match(new RegExp(`^${API_PREFIX}/settings/providers/([^/]+)$`));

  if (providerIdMatch && method === "GET") {
    requireOwner(request);
    const providerId = decodeURIComponent(providerIdMatch[1]);
    const provider = await context.core.getProvider(providerId);
    if (!provider) {
      throw new ApiError(404, "not_found", `指定されたプロバイダーが見つかりません: ${providerId}`);
    }
    sendJson(response, 200, { request_id: requestIdValue, data: provider });
    return;
  }

  if (pathname === `${API_PREFIX}/settings/providers` && method === "POST") {
    requireOwner(request);
    const body = await readRequestBody(request);
    const cmd = commandEnvelope(body);
    const p = cmd.payload;
    const id = stringField(p.id, "id", 1, 64);
    const displayName = stringField(p.displayName, "displayName", 1, 128);
    const harnessId = stringField(p.harnessId, "harnessId", 1, 32);
    const backendUrl = p.backendUrl === undefined ? undefined : stringField(p.backendUrl, "backendUrl", 1, 2_000);
    const apiKeySource = p.apiKeySource === undefined ? undefined : stringField(p.apiKeySource, "apiKeySource", 1, 256);
    const result = await runCommand(context, pathname, cmd, 201, async () => {
      const saved = await context.core.saveProvider(id, {
        displayName,
        harnessId,
        backendUrl,
        apiKeySource,
      });
      return { data: saved as unknown as JsonObject, version: 0 };
    });
    sendJson(response, 201, result);
    return;
  }

  if (providerIdMatch && method === "PUT") {
    requireOwner(request);
    const providerId = decodeURIComponent(providerIdMatch[1]);
    const body = await readRequestBody(request);
    const cmd = commandEnvelope(body);
    const p = cmd.payload;
    const result = await runCommand(context, pathname, cmd, 200, async () => {
      const saved = await context.core.saveProvider(providerId, {
        displayName: stringField(p.displayName, "displayName", 1, 128),
        harnessId: stringField(p.harnessId, "harnessId", 1, 32),
        backendUrl: p.backendUrl === undefined ? undefined : stringField(p.backendUrl, "backendUrl", 1, 2_000),
        apiKeySource: p.apiKeySource === undefined ? undefined : stringField(p.apiKeySource, "apiKeySource", 1, 256),
      });
      return { data: saved as unknown as JsonObject, version: 0 };
    });
    sendJson(response, 200, result);
    return;
  }

  if (providerIdMatch && method === "DELETE") {
    requireOwner(request);
    const providerId = decodeURIComponent(providerIdMatch[1]);
    const body = await readRequestBody(request);
    const cmd = commandEnvelope(body);
    const result = await runCommand(context, pathname, cmd, 200, async () => {
      const deleted = await context.core.deleteProvider(providerId);
      return { data: deleted as unknown as JsonObject, version: 0 };
    });
    sendJson(response, 200, result);
    return;
  }

  // ---- Provider Models (user-managed) ----------------------------------------

  if (pathname === `${API_PREFIX}/settings/provider-models` && method === "GET") {
    requireOwner(request);
    const models = await context.core.getProviderModels();
    sendJson(response, 200, { request_id: requestIdValue, data: models });
    return;
  }

  const providerModelsMatch = pathname.match(new RegExp(`^${API_PREFIX}/settings/provider-models/([^/]+)$`));
  if (providerModelsMatch && method === "PUT") {
    requireOwner(request);
    const providerId = decodeURIComponent(providerModelsMatch[1]);
    const body = await readRequestBody(request);
    const cmd = commandEnvelope(body);
    if (!Array.isArray(cmd.payload.models) || !cmd.payload.models.every((m: unknown): m is string => typeof m === "string")) {
      throw new ApiError(400, "validation_error", "modelsが不正です。文字列の配列を指定してください。");
    }
    const result = await runCommand(context, pathname, cmd, 200, async () => {
      const models = await context.core.setProviderModels(providerId, cmd.payload.models as string[]);
      return { data: { models } as unknown as JsonObject, version: 0 };
    });
    sendJson(response, 200, result);
    return;
  }

    const providerTestMatch = pathname.match(new RegExp(`^${API_PREFIX}/settings/providers/([^/]+)/test$`));
  if (providerTestMatch && method === "POST") {
    requireOwner(request);
    const providerId = decodeURIComponent(providerTestMatch[1]);
    const result = await context.core.testProvider(providerId);
    sendJson(response, 200, { request_id: requestIdValue, data: result });
    return;
  }

  // ---- Conversation Clear ---------------------------------------------------

  const conversationClearMatch = pathname.match(new RegExp(`^${API_PREFIX}/conversations/([^/]+)/clear$`));
  if (conversationClearMatch && method === "POST") {
    requireOwner(request);
    const conversationId = pathId(conversationClearMatch[1], "conversation_id");
    const body = await readRequestBody(request);
    const cmd = commandEnvelope(body);
    const result = await runCommand(context, pathname, cmd, 200, async () => {
      const cleared = await context.core.clearConversation(conversationId);
      return { data: cleared as unknown as JsonObject, version: 0 };
    });
    sendJson(response, 200, result);
    return;
  }

  if (pathname === `${API_PREFIX}/inbound/messages` && method === "POST") {
    const ownerId = requireOwner(request);
    const requestHeader = headerValue(request, "x-request-id");
    const idempotencyHeader = headerValue(request, "idempotency-key");
    if (!requestHeader || !idempotencyHeader) {
      throw new ApiError(400, "validation_error", "X-Request-IdとIdempotency-Key headerは必須です。");
    }
    const raw = await readRequestBody(request);
    if (!isObject(raw)) throw new ApiError(400, "validation_error", "Inbound messageはJSON objectで指定してください。");
    const payload = validateInboundMessage(raw);
    const command = { request_id: stringField(requestHeader, "X-Request-Id", 1, 128), idempotency_key: stringField(idempotencyHeader, "Idempotency-Key", 1, 128), expected_version: 0 };
    const result = await context.core.ingestInbound(ownerId, payload, command);
    const data = result.data;
    sendJson(response, 202, {
      request_id: data.request_id,
      ack_id: data.ack_id,
      message_id: data.message_id,
      event_id: data.event_id,
      deduplicated: data.deduplicated,
      status: data.status,
    });
    return;
  }

  if (pathname === `${API_PREFIX}/inbound/uploads` && method === "POST") {
    const ownerId = requireOwner(request);
    const payload = validateUploadRegister(await readRequestBody(request));
    const requestHeader = headerValue(request, "x-request-id") ?? requestIdValue;
    const idempotencyHeader = headerValue(request, "idempotency-key") ?? `${requestHeader}:upload-register`;
    const command = { request_id: stringField(requestHeader, "X-Request-Id", 1, 128), idempotency_key: stringField(idempotencyHeader, "Idempotency-Key", 1, 128), expected_version: 0 };
    const result = await context.core.registerInboundUpload(ownerId, payload, command);
    sendJson(response, 201, result.data);
    return;
  }

  const uploadContentMatch = pathname.match(new RegExp(`^${API_PREFIX}/inbound/uploads/([^/]+)/content$`));
  if (uploadContentMatch && method === "PUT") {
    const ownerId = requireOwner(request);
    const uploadId = pathId(uploadContentMatch[1], "upload_id");
    const contentTypeHeader = headerValue(request, "content-type");
    const contentLengthHeader = headerValue(request, "content-length");
    const digestHeader = headerValue(request, "digest");
    if (!contentTypeHeader || !contentLengthHeader || !digestHeader || !/^sha-256=/iu.test(digestHeader)) {
      throw new ApiError(400, "validation_error", "Content-Type、Content-Length、Digest: sha-256=<base64> headerは必須です。");
    }
    if (!/^\d+$/u.test(contentLengthHeader)) throw new ApiError(400, "validation_error", "Content-Lengthが不正です。");
    const content = await readRawBody(request, MAX_UPLOAD_BODY_BYTES);
    if (Number(contentLengthHeader) !== content.byteLength) throw new ApiError(400, "validation_error", "Content-Lengthと実際のupload bytesが一致しません。");
    const digestBase64 = digestHeader.slice(digestHeader.indexOf("=") + 1).trim();
    let suppliedDigest: Buffer;
    try {
      suppliedDigest = Buffer.from(digestBase64, "base64");
    } catch (error) {
      throw new ApiError(400, "validation_error", "Digest headerが不正です。", {}, { cause: error });
    }
    const actualDigest = createHash("sha256").update(content).digest();
    if (suppliedDigest.length !== actualDigest.length || !suppliedDigest.equals(actualDigest)) throw new ApiError(409, "upload_checksum_mismatch", "Digestとupload bytesが一致しません。");
    const result = await context.core.putInboundUpload(ownerId, uploadId, { content, sha256: actualDigest.toString("hex"), mime: contentTypeHeader });
    sendJson(response, 200, { data: result });
    return;
  }

  const uploadCompleteMatch = pathname.match(new RegExp(`^${API_PREFIX}/inbound/uploads/([^/]+)/complete$`));
  if (uploadCompleteMatch && method === "POST") {
    const ownerId = requireOwner(request);
    const uploadId = pathId(uploadCompleteMatch[1], "upload_id");
    const command = commandEnvelope(await readRequestBody(request));
    const payload = validateUploadComplete(command.payload);
    const result = await context.core.completeInboundUpload(ownerId, uploadId, payload, command);
    sendJson(response, 200, { data: result.data });
    return;
  }

  if (pathname === `${API_PREFIX}/messages` && method === "POST") {
    requireOwner(request);
    const raw = await readRequestBody(request) as JsonObject;
    const text = stringField(raw.text as string, "text", 1, 100000);
    const origin = isObject(raw.origin) ? raw.origin as { channel: string; ref?: string } : undefined;
    const source = typeof raw.source === "string" ? raw.source : "api";
    const { conversation_id: conversationId } = await context.core.getActiveConversation();
    const requestId = createUlid();
    const command = {
      request_id: requestId,
      idempotency_key: `plugin-message:${requestId}`,
      expected_version: 0,
      payload: { body: text, attachment_ids: [] } as unknown as JsonObject,
    };
    const result = await runCommand(context, pathname, command, 201, async () =>
      context.core.postMessage(conversationId, { body: text, attachment_ids: [] }, command),
    );
    const postedMessageId = (result as { data: { message_id: string } }).data.message_id;
    void context.core.advisorRespond(conversationId, postedMessageId, origin ?? { channel: source }).catch((error) => {
      console.error("[owl-server] Advisor response failed:", error);
    });
    sendJson(response, 201, result);
    return;
  }

  const messageListMatch = pathname.match(new RegExp(`^${API_PREFIX}/conversations/([^/]+)/messages$`));
  if (messageListMatch && method === "GET") {
    requireOwner(request);
    const conversationId = pathId(messageListMatch[1], "conversation_id");
    const result = await context.core.listMessages(conversationId, {
      limit: parseLimit(url.searchParams.get("limit"), 50),
      cursor: nullableQuery(url.searchParams.get("cursor")),
    });
    sendJson(response, 200, { ...result, request_id: requestIdValue });
    return;
  }

  if (messageListMatch && method === "POST") {
    requireOwner(request);
    const conversationId = pathId(messageListMatch[1], "conversation_id");
    const body = await readRequestBody(request);
    const command = commandEnvelope(body);
    const payload = validatePostMessagePayload(command.payload);
    const result = await runCommand(context, pathname, command, 201, async () => context.core.postMessage(conversationId, payload, command));
    const postedMessageId = (result as { data: { message_id: string } }).data.message_id;
    void context.core.advisorRespond(conversationId, postedMessageId, { channel: "web" }).catch((error) => {
      console.error("[owl-server] Advisor response failed:", error);
    });
    sendJson(response, 201, result);
    return;
  }

  if (pathname === `${API_PREFIX}/agents` && method === "GET") {
    requireOwner(request);
    const workIdValue = nullableQuery(url.searchParams.get("work_id"));
    if (workIdValue !== null && !isUlid(workIdValue)) {
      throw new ApiError(400, "invalid_query", "work_idが不正です。26文字の大文字ULIDを指定してください。");
    }
    const result = await context.core.listAgents({
      status: nullableQuery(url.searchParams.get("status")),
      work_id: workIdValue,
      limit: parseLimit(url.searchParams.get("limit"), 50),
      cursor: nullableQuery(url.searchParams.get("cursor")),
    });
    sendJson(response, 200, { ...result, request_id: requestIdValue });
    return;
  }

  const agentCancelMatch = pathname.match(new RegExp(`^${API_PREFIX}/agents/([^/]+)/cancel$`));
  if (agentCancelMatch && method === "POST") {
    requireOwner(request);
    const agentRunId = pathId(agentCancelMatch[1], "agent_run_id");
    const body = await readRequestBody(request);
    const command = commandEnvelope(body);
    const payload = validateCancelPayload(command.payload);
    const result = await runCommand(context, pathname, command, 200, async () => context.core.cancelAgent(agentRunId, payload.reason, payload.force, command));
    sendJson(response, 200, result);
    return;
  }

  // ---- Advisor sessions and memory routes ---------------------------------

  if (pathname === `${API_PREFIX}/knowledge/ingest` && method === "POST") {
    requireOwner(request);
    const command = commandEnvelope(await readRequestBody(request));
    const payload = validateIngestConversationPayload(command.payload);
    const result = await runCommand(context, pathname, command, 201, async () => {
      const data = await context.core.ingestConversation(payload.conversation_id);
      return { data: data as unknown as JsonObject, version: 0 };
    });
    sendJson(response, 201, result);
    return;
  }

  if (pathname === `${API_PREFIX}/advisor/conversation/active` && method === "GET") {
    requireOwner(request);
    const result = await context.core.getActiveConversation();
    sendJson(response, 200, { ...result, request_id: requestIdValue });
    return;
  }

  if (pathname === `${API_PREFIX}/advisor/session` && method === "GET") {
    const ownerId = requireOwner(request);
    try {
      const session = await featureCore.advisorSessions.getActiveSession(ownerId);
      if (!session) {
        sendJson(response, 200, { status: "none" });
        return;
      }

      const database = advisorSessionDatabase(context.db);
      const sessionRow = database?.get<{
        provider_session_id: string | null;
        provider_id: string | null;
        model: string | null;
        effort: string | null;
        created_at: string;
        resumed_count: number;
      }>(
        `SELECT provider_session_id, provider_id, model, effort, created_at, resumed_count
           FROM advisor_sessions
          WHERE id = ?`,
        session.id,
      );
      const compactionRow = database?.get<{ count: number; last_compaction_at: string | null }>(
        `SELECT COUNT(*) AS count, MAX(created_at) AS last_compaction_at
           FROM advisor_compactions
          WHERE session_id = ?`,
        session.id,
      );
      // The Web view is per conversation: with conversation_id, only that
      // conversation's turns count, so another interface's turn is not shown as thinking here.
      const turnConversationId = nullableQuery(requestUrl(request).searchParams.get("conversation_id"));
      const turnCount = (status: "queued" | "running") =>
        database?.get<{ count: number }>(
          `SELECT COUNT(*) AS count
             FROM advisor_turns
            WHERE session_id = ? AND status = ?${turnConversationId ? " AND conversation_id = ?" : ""}`,
          session.id,
          status,
          ...(turnConversationId ? [turnConversationId] : []),
        );
      const queuedRow = turnCount("queued");
      const runningRow = turnCount("running");

      // A session that has not recorded its provider yet runs on the Advisor role's configured one.
      const advisorRole = sessionRow?.provider_id?.trim()
        ? undefined
        : (await context.core.getModelSettings()).roles.find((role) => role.role === "advisor");
      const providerId = (sessionRow?.provider_id?.trim() || advisorRole?.provider?.trim() || "anthropic").toLowerCase();
      const pauseAliases = providerId === "anthropic" || providerId === "claude"
        ? ["anthropic", "claude"]
        : providerId === "openai" || providerId === "codex" || providerId === "openai/codex"
          ? ["openai", "codex", "openai/codex"]
          : [providerId];
      const pause = (await context.core.listProviderPauses()).find(
        (entry) => entry.state === "paused" && pauseAliases.includes(entry.provider.toLowerCase()),
      );

      sendJson(response, 200, {
        status: session.status,
        provider_session_id: sessionRow ? sessionRow.provider_session_id : session.provider_session_id ?? null,
        model: sessionRow ? sessionRow.model : session.model ?? null,
        effort: sessionRow ? sessionRow.effort : session.effort ?? null,
        compaction_count: Number(database ? compactionRow?.count ?? 0 : session.compaction_count ?? 0),
        last_compaction_at: database ? compactionRow?.last_compaction_at ?? null : session.last_compaction_at ?? null,
        queued_turns: Number(database ? queuedRow?.count ?? 0 : 0),
        running_turns: Number(database ? runningRow?.count ?? 0 : 0),
        provider_paused_until: pause?.resume_at ?? null,
        created_at: sessionRow ? sessionRow.created_at : session.started_at ?? null,
        resumed_count: Number(sessionRow ? sessionRow.resumed_count : session.resumed_count ?? 0),
      });
    } catch (error) {
      await sendApiError(response, requestIdValue, error, `${method} ${pathname}`, context.core);
    }
    return;
  }

  if (pathname === `${API_PREFIX}/advisor/session/restart` && method === "POST") {
    const ownerId = requireOwner(request);
    try {
      const session = await featureCore.advisorSessions.getActiveSession(ownerId);
      if (!session) {
        sendJson(response, 404, { error: "no active session" });
        return;
      }
      await context.core.restartAdvisorSession(ownerId);
      sendJson(response, 200, { restarted: true, ended_session_id: session.id });
    } catch (error) {
      await sendApiError(response, requestIdValue, error, `${method} ${pathname}`, context.core);
    }
    return;
  }

  if (pathname === `${API_PREFIX}/memory/save-manual` && method === "POST") {
    requireOwner(request);
    try {
      const summary = validateSessionSummaryPayload(await readRequestBody(request));
      const path = await featureCore.memorySaver.saveManualSnapshot(summary);
      sendJson(response, 200, { path });
    } catch (error) {
      await sendApiError(response, requestIdValue, error, `${method} ${pathname}`, context.core);
    }
    return;
  }

  if (pathname === `${API_PREFIX}/memory/save-explicit` && method === "POST") {
    requireOwner(request);
    try {
      const payload = validateExplicitMemoryPayload(await readRequestBody(request));
      const path = await featureCore.memorySaver.saveExplicitMemory(payload.text, payload.tags);
      sendJson(response, 200, { path });
    } catch (error) {
      await sendApiError(response, requestIdValue, error, `${method} ${pathname}`, context.core);
    }
    return;
  }

  if (pathname === `${API_PREFIX}/librarian/run` && method === "POST") {
    requireOwner(request);
    try {
      const run = await requireCurationApi(context.core).runCuration({
        kind: "librarian",
        trigger: "manual_api",
        actor: "owner",
        actor_ref: requestIdValue,
      });
      if (run.status === "failed") {
        throw new ApiError(500, "curation_failed", run.error ?? "Librarianの実行に失敗しました。", { run_id: run.id });
      }
      sendJson(response, 200, {
        request_id: requestIdValue,
        data: { run_id: run.id, status: run.status, summary: run.summary, report: run.report },
      });
    } catch (error) {
      await sendApiError(response, requestIdValue, error, `${method} ${pathname}`, context.core);
    }
    return;
  }

  if (pathname === `${API_PREFIX}/curation-runs` && method === "GET") {
    requireOwner(request);
    const limit = url.searchParams.get("limit");
    if (limit !== null && limit !== "" && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) {
      throw new ApiError(400, "validation_error", "limitが不正です。1〜100の整数を指定してください。");
    }
    const cursor = nullableQuery(url.searchParams.get("cursor"));
    if (cursor !== null && cursor !== undefined && !isUlid(cursor)) {
      throw new ApiError(400, "validation_error", "cursorが不正です。26文字の大文字ULIDを指定してください。");
    }
    const data = requireCurationApi(context.core).listCurationRuns({
      ...(curationEnumQuery(url.searchParams.get("kind"), CURATION_KIND_VALUES, "kind") ? { kind: url.searchParams.get("kind")! } : {}),
      ...(curationEnumQuery(url.searchParams.get("status"), CURATION_STATUS_VALUES, "status") ? { status: url.searchParams.get("status")! } : {}),
      limit: limit ? Number(limit) : 20,
      ...(cursor ? { cursor } : {}),
    });
    sendJson(response, 200, { request_id: requestIdValue, data });
    return;
  }

  const curationRunMatch = pathname.match(new RegExp(`^${API_PREFIX}/curation-runs/([^/]+)$`));
  if (curationRunMatch && method === "GET") {
    requireOwner(request);
    const id = pathId(curationRunMatch[1]!, "curation_run_id");
    const run = requireCurationApi(context.core).getCurationRun(id);
    if (!run) throw new ApiError(404, "not_found", "整理実行記録が見つかりません。IDを確認してください。");
    sendJson(response, 200, { request_id: requestIdValue, data: run });
    return;
  }



  // ---- Rule Store routes ---------------------------------------------------

  if (pathname === `${API_PREFIX}/rules` && method === "GET") {
    requireOwner(request);
    const ruleSet = context.ruleStore.rules;
    const language = await requestOwnerLanguage(context.core);
    sendJson(response, 200, {
      request_id: requestIdValue,
      data: {
        files: ruleSet.files.map((f) => ({ path: f.path, level: f.level, role: f.role ?? null, rule_count: f.rules.length })),
        block_rules: ruleSet.blockRules.map((r) => ({ id: r.id, level: r.level, role: r.role ?? null, pattern: r.pattern, message: ownerRuleMessage(r.id, r.message, language) })),
        block_paths: ruleSet.blockPaths.map((r) => ({ id: r.id, level: r.level, role: r.role ?? null, pattern: r.pattern, mode: r.mode, message: ownerRuleMessage(r.id, r.message, language) })),
        prompt_rules: ruleSet.promptRules.map((r) => ({ ...r, text: ownerRuleMessage(r.id, r.text, language) })),
        status: context.ruleStore.status,
      },
    });
    return;
  }

  if (pathname === `${API_PREFIX}/rules/check` && method === "POST") {
    requireOwner(request);
    const body = await readRequestBody(request);
    if (!isObject(body) || typeof body.command !== "string") {
      throw new ApiError(400, "validation_error", "commandフィールドが必要です。");
    }
    if (body.role !== undefined && !isRuleRole(body.role)) {
      throw new ApiError(400, "validation_error", `roleは ${RULE_ROLES.join(", ")} のいずれかで指定してください。`);
    }
    if (body.cwd !== undefined && (typeof body.cwd !== "string" || !isAbsolute(body.cwd))) {
      throw new ApiError(400, "validation_error", "cwdは絶対パスで指定してください。");
    }

    const result = context.ruleStore.checkCommand(
      body.command as string,
      (body.cwd as string | undefined) ?? process.cwd(),
      process.env.HOME,
      body.role as string | undefined,
    );
    const language = await requestOwnerLanguage(context.core);
    sendJson(response, 200, {
      request_id: requestIdValue,
      data: {
        blocked: result.blocked,
        rule: result.rule ? { id: result.rule.id, level: result.rule.level, role: result.rule.role ?? null, message: ownerRuleMessage(result.rule.id, result.rule.message, language) } : null,
      },
    });
    return;
  }

  if (pathname === `${API_PREFIX}/guard/check` && method === "POST") {
    const agent = requireGuard(request, context.guardTokens);
    const command = commandEnvelope(await readRequestBody(request));
    exactKeys(command.payload, ["role", "tool_name", "tool_input", "cwd"], "GuardCheck payload");
    const role = stringField(command.payload.role, "role", 1, 32);
    if (!isRuleRole(role)) {
      throw new ApiError(400, "guard_unparseable", "roleが不正です。");
    }
    if (agent && agent.role !== role) {
      throw new ApiError(403, "agent_scope_denied", "guard tokenのroleと一致しないroleは照会できません。");
    }
    const toolName = stringField(command.payload.tool_name, "tool_name", 1, 256);
    if (!isObject(command.payload.tool_input)) throw new ApiError(400, "guard_unparseable", "tool_inputはJSON objectで指定してください。");
    const cwd = stringField(command.payload.cwd, "cwd", 1, 4096);
    if (!isAbsolute(cwd)) throw new ApiError(400, "guard_unparseable", "cwdは絶対パスで指定してください。");
    const guardDatabase = isObject(context.db) && typeof context.db.get === "function"
      ? context.db as { get(sql: string, ...params: unknown[]): unknown }
      : null;
    const designerTask = agent?.role === "designer"
      ? guardDatabase?.get(
          `SELECT tasks.id, tasks.work_id, tasks.type
             FROM agent_runs JOIN tasks ON tasks.id = agent_runs.task_id
            WHERE agent_runs.id = ? AND agent_runs.role = 'designer'`,
          agent.agent_run_id,
        ) as { id?: unknown; work_id?: unknown; type?: unknown } | undefined
      : undefined;
    const designerWritePath = agent?.role === "designer"
      ? designerTask?.type === "design" && typeof designerTask.id === "string" && typeof designerTask.work_id === "string"
        ? designDocumentPath(context.dataDir, designerTask.work_id, designerTask.id)
        : null
      : undefined;
    const result = context.ruleStore.checkGuard({
      role,
      toolName,
      toolInput: command.payload.tool_input,
      cwd,
      home: process.env.HOME,
      ...(agent?.role === "designer" ? { designerWritePath } : {}),
    });
    sendJson(response, 200, {
      request_id: command.request_id,
      data: result,
      version: command.expected_version,
    });
    if (agent && result.allowed && context.core.recordSkillReads) {
      try {
        void context.core.recordSkillReads({
          agent_run_id: agent.agent_run_id,
          tool_name: toolName,
          tool_input: command.payload.tool_input,
          cwd,
          normalized_segments: result.normalized_segments,
        }).catch((error) => {
          console.warn(`[owl-server] Could not record skill reads for Agent run ${agent.agent_run_id}`, error);
        });
      } catch (error) {
        console.warn(`[owl-server] Could not record skill reads for Agent run ${agent.agent_run_id}`, error);
      }
    }
    return;
  }

  if (pathname === `${API_PREFIX}/research/capture` && method === "POST") {
    const agent = requireGuard(request, context.guardTokens);
    if (!agent || !RESEARCH_CAPTURE_ROLES.has(agent.role)) {
      throw new ApiError(403, "agent_scope_denied", "research capture はWorkエージェントのguard tokenでのみ受け付けます。");
    }
    const command = commandEnvelope(await readRequestBody(request));
    if (command.expected_version !== 0) {
      throw new ApiError(400, "validation_error", "expected_versionは0で指定してください。");
    }
    exactKeys(command.payload, ["tool_name", "tool_input", "tool_response"], "ResearchCapture payload", ["auth_form_detected"]);
    const authFormDetected = Object.prototype.hasOwnProperty.call(command.payload, "auth_form_detected");
    if (authFormDetected && command.payload.auth_form_detected !== true) {
      throw new ApiError(400, "validation_error", "auth_form_detectedはtrueで指定してください。");
    }
    const toolName = stringField(command.payload.tool_name, "tool_name", 1, 64);
    if (toolName !== "WebFetch" && toolName !== "WebSearch") {
      throw new ApiError(400, "validation_error", "tool_nameはWebFetchまたはWebSearchで指定してください。");
    }
    if (!isObject(command.payload.tool_input)) {
      throw new ApiError(400, "validation_error", "tool_inputはJSON objectで指定してください。");
    }
    const extractedCapture = extractWebResearchCapture(toolName, command.payload.tool_input, command.payload.tool_response);
    const capture = extractedCapture && authFormDetected
      ? { ...extractedCapture, auth_form_detected: true as const }
      : extractedCapture;
    const result = capture === null
      ? { accepted: false, reason: "unsupported" }
      : await context.core.recordAgentResearch(agent, capture);
    sendJson(response, 202, { request_id: command.request_id, data: result });
    return;
  }

  // ── Events (Activity Log) ──
  if (pathname === `${API_PREFIX}/events` && method === "GET") {
    requireOwner(request);
    const afterValue = url.searchParams.get("after");
    if (afterValue !== null && !/^\d+$/.test(afterValue)) {
      throw new ApiError(400, "invalid_query", "afterが不正です。0以上の整数カーソルを指定してください。");
    }
    const afterCursor = afterValue === null ? 0 : Number(afterValue);
    if (!Number.isSafeInteger(afterCursor)) {
      throw new ApiError(400, "invalid_query", "afterが大きすぎます。現在のイベントカーソルを使ってください。");
    }
    const limit = parseLimit(url.searchParams.get("limit"), 50);
    const order = url.searchParams.get("order") ?? "asc";
    if (order !== "asc" && order !== "desc") {
      throw new ApiError(400, "invalid_query", "orderが不正です。ascまたはdescを指定してください。");
    }
    const beforeValue = url.searchParams.get("before");
    if (order === "desc") {
      // Newest-first page (Activity Log). `before` is an exclusive sequence
      // cursor: pass the previous page's cursor to read older events.
      if (afterValue !== null) {
        throw new ApiError(400, "invalid_query", "order=descではafterを使えません。古いイベントはbeforeで取得してください。");
      }
      if (beforeValue !== null && !/^\d+$/.test(beforeValue)) {
        throw new ApiError(400, "invalid_query", "beforeが不正です。0以上の整数カーソルを指定してください。");
      }
      const before = beforeValue === null ? null : Number(beforeValue);
      if (before !== null && !Number.isSafeInteger(before)) {
        throw new ApiError(400, "invalid_query", "beforeが大きすぎます。直前のページのcursorを使ってください。");
      }
      const events = context.core.eventsBefore
        ? context.core.eventsBefore(before, limit)
        : context.core.eventsAfter(0).filter((event) => before === null || event.sequence < before).slice(-limit).reverse();
      const oldest = events[events.length - 1];
      const nextCursor = oldest ? oldest.cursor : before === null ? "0" : String(before);
      sendJson(response, 200, { request_id: requestIdValue, data: { events, cursor: nextCursor, has_more: events.length === limit } });
      return;
    }
    if (beforeValue !== null) {
      throw new ApiError(400, "invalid_query", "beforeはorder=descと一緒に指定してください。");
    }
    const events = context.core.eventsAfter(afterCursor, limit);
    const nextCursor = events.length > 0 ? events[events.length - 1].cursor : String(afterCursor);
    sendJson(response, 200, { request_id: requestIdValue, data: { events, cursor: nextCursor, has_more: events.length === limit } });
    return;
  }

  // ── Artifacts ──
  const artifactListMatch = pathname.match(new RegExp(`^${API_PREFIX}/works/([^/]+)/artifacts$`));
  if (artifactListMatch && method === "GET") {
    requireOwner(request);
    const wid = pathId(artifactListMatch[1], "work_id");
    const rows = context.core.listArtifacts(wid);
    sendJson(response, 200, { request_id: requestIdValue, data: rows });
    return;
  }

  // ---- Knowledge Base routes -----------------------------------------------

  if (pathname === `${API_PREFIX}/knowledge` && method === "GET") {
    requireOwner(request);
    const query = nullableQuery(url.searchParams.get("q"));
    const folder = nullableQuery(url.searchParams.get("folder"));
    const tagsParam = nullableQuery(url.searchParams.get("tags"));
    const tags = tagsParam ? tagsParam.split(",").map((t) => t.trim()) : [];
    const results = await withKnowledgeStorageAccess(context.core, "read", () => query
      ? context.knowledge.search(query, tags)
      : context.knowledge.list(folder ?? undefined));
    sendJson(response, 200, { request_id: requestIdValue, data: results });
    return;
  }

  const kbEntryMatch = pathname.match(new RegExp(`^${API_PREFIX}/knowledge/(.+)$`));
  if (kbEntryMatch && method === "GET") {
    requireOwner(request);
    const entryPath = decodeURIComponent(kbEntryMatch[1]);
    try {
      const entry = await withKnowledgeStorageAccess(context.core, "read", () => context.knowledge.get(entryPath));
      sendJson(response, 200, { request_id: requestIdValue, data: entry });
    } catch (error) {
      if (isKnowledgeStorageApiError(error)) throw error;
      throw new ApiError(404, "not_found", "指定されたナレッジエントリが見つかりません。");
    }
    return;
  }

  if (pathname === `${API_PREFIX}/knowledge` && method === "POST") {
    requireOwner(request);
    const body = await readRequestBody(request);
    if (!isObject(body)) throw new ApiError(400, "validation_error", "リクエストボディが不正です。");
    const folder = stringField(body.folder as string, "folder", 1, 200);
    if (folder.split("/")[0] === "policies") {
      throw new ApiError(400, "validation_error", "policiesは移行済みの読み取り専用のため、書き込みできません。");
    }
    const filename = stringField(body.filename as string, "filename", 1, 200);
    const entryBody = stringField(body.body as string, "body", 0, 500000);
    const tags = Array.isArray(body.tags) ? (body.tags as string[]).filter((t) => typeof t === "string") : [];
    try {
      const entry = await withKnowledgeStorageAccess(context.core, "write", () => context.knowledge.create({ folder, filename, tags, body: entryBody }));
      sendJson(response, 201, { request_id: requestIdValue, data: entry });
    } catch (e) {
      if (isKnowledgeStorageApiError(e)) throw e;
      if (e instanceof Error && e.message.startsWith("already_exists")) {
        throw new ApiError(409, "version_conflict", "同名のナレッジエントリが既に存在します。");
      }
      if (e instanceof Error && e.message.startsWith("invalid_folder")) {
        throw new ApiError(400, "validation_error", "folderはglobal、projects、worksなどの有効なフォルダで始めてください。policiesは移行済みの読み取り専用です。");
      }
      throw e;
    }
    return;
  }

  if (kbEntryMatch && method === "PUT") {
    requireOwner(request);
    const entryPath = decodeURIComponent(kbEntryMatch[1]);
    if (entryPath.startsWith("policies/")) {
      throw new ApiError(400, "validation_error", "policiesは移行済みの読み取り専用のため、書き込みできません。");
    }
    const body = await readRequestBody(request);
    if (!isObject(body)) throw new ApiError(400, "validation_error", "リクエストボディが不正です。");
    const update: { tags?: string[]; body?: string } = {};
    if (body.tags !== undefined) {
      update.tags = Array.isArray(body.tags) ? (body.tags as string[]).filter((t) => typeof t === "string") : [];
    }
    if (body.body !== undefined) {
      update.body = typeof body.body === "string" ? body.body : "";
    }
    try {
      const entry = await withKnowledgeStorageAccess(context.core, "write", () => context.knowledge.update(entryPath, update));
      sendJson(response, 200, { request_id: requestIdValue, data: entry });
    } catch (error) {
      if (isKnowledgeStorageApiError(error)) throw error;
      throw new ApiError(404, "not_found", "指定されたナレッジエントリが見つかりません。");
    }
    return;
  }

  if (kbEntryMatch && method === "DELETE") {
    requireOwner(request);
    const entryPath = decodeURIComponent(kbEntryMatch[1]);
    if (entryPath.startsWith("policies/")) {
      throw new ApiError(400, "validation_error", "policiesは移行済みの読み取り専用のため、書き込みできません。");
    }
    try {
      await withKnowledgeStorageAccess(context.core, "write", () => context.knowledge.remove(entryPath));
      sendJson(response, 200, { request_id: requestIdValue, deleted: true });
    } catch (error) {
      if (isKnowledgeStorageApiError(error)) throw error;
      throw new ApiError(404, "not_found", "指定されたナレッジエントリが見つかりません。");
    }
    return;
  }

  throw errorStatusForUnknownRoute();
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

function validateOptionalFolderPath(value: string | null): string | undefined {
  if (value === null) return undefined;
  return stringField(value, "path", 1, 4096);
}

function writeUpgradeError(socket: Socket, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  socket.write(`HTTP/1.1 ${status} Error\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
  socket.end();
}

async function handleUpgrade(context: RequestContext, request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
  const url = requestUrl(request);
  if (url.pathname !== `${API_PREFIX}/ws`) {
    socket.destroy();
    return;
  }
  const requestIdValue = requestId(request);
  try {
    requireOwner(request);
    if (!isRequestOriginAllowed(request, context)) {
      throw new ApiError(403, "forbidden", "このWebSocket接続元は許可されていません。Web UIから接続し直してください。");
    }
    const key = headerValue(request, "sec-websocket-key");
    if (!key) {
      throw new ApiError(400, "validation_error", "WebSocket handshakeのkeyがありません。標準のWebSocket clientから接続してください。");
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
    const unexpected = new ApiError(500, "server_error", humanUnexpectedMessage(), { ref_id: referenceId });
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
    inFlight: new Map(),
    workLocks: new Map(),
    websocketSockets: new Set(),
    shuttingDown: false,
    knowledge: new KnowledgeBase(options.owlRoot, {
      rootDir: () => requireKnowledgeStorageApi(options.core).activeKnowledgeDir(),
      requireRoot: () => requireKnowledgeStorageApi(options.core).hasKnowledgeStorageEverBeenAvailable(),
    }),
    ruleStore: options.ruleStore ?? new RuleStore(options.owlRoot),
    guardTokens: options.guardTokens ?? null,
  };
  const runtimeConfig: RuntimeConfig = {
    base_path: "/owl/",
    api_base: API_PREFIX,
    ws_url: `${API_PREFIX}/ws`,
    schema_version: "1.0.0",
  };
  const server = createServer(async (request, response) => {
    const requestIdValue = requestId(request);
    try {
      const url = requestUrl(request);
      if (url.pathname === "/owl") {
        response.writeHead(301, { Location: "/owl/" });
        response.end();
        return;
      }
      if (await serveStatic(request, response, context.webOut, url.pathname)) return;
      if (!url.pathname.startsWith(API_PREFIX)) throw errorStatusForUnknownRoute();
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
