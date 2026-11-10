import { API_PREFIX, type ApiMethod, type RouteDefinition } from "./http-route-table.js";
import { optionalCoreFeature, requireAdapterFeature, requireCoreFeature } from "./core-feature.js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Socket } from "node:net";

import { buildFileDestinationCandidates, isDefaultAvailable, parseFileDestinationPut, type FileDestinationProviderView } from "./advisor-file-destination-settings.js";
import { ApiError, type ApiErrorCode, errorBody, humanUnexpectedMessage, newReferenceId } from "./errors.js";
import { MEMORY_GET_OPERATIONS, MEMORY_OPERATIONS, memoryContext, runMemoryOperation } from "./http-memory.js";
import { AdvisorFolderError } from "./advisor-folders.js";
import { renderOwnerFolder, sendOwnerFile, sendOwnerFolder } from "./owner-files-http.js";
import { listHostDirectories } from "./fs-directories.js";
import { createUlid, isUlid } from "./ids.js";
import { resolveDataDir, type ContractManifest } from "./contracts.js";
import { configuredApiToken } from "./config.js";
import { externalError } from "./core.js";
import { MODEL_PRESET_NAME_MAX_LENGTH, MODEL_SETTING_EFFORTS, MODEL_SETTING_ROLES } from "../../../packages/shared/dist/default-role-models.js";
import { AUTO_WORK_SOURCES, AUTO_WORK_VERDICTS } from "../../../packages/shared/dist/auto-work.js";
import { validatePrerequisiteWorkIds } from "../../../packages/shared/dist/work-prerequisite.js";
import { KnowledgeBase, type KnowledgeSearchResult } from "../../../packages/core/dist/knowledge-base.js";
import { RuleStore } from "../../../packages/core/dist/rule-store.js";
import { MAX_MESSAGE_ATTACHMENTS, MAX_UPLOAD_BYTES } from "../../../packages/core/dist/upload-limits.js";
import type { WebAttachmentFile, WebAttachmentResult, WebAttachmentTarget } from "../../../packages/core/dist/core.js";
import { assertValidPage, PageRejectedError } from "../../../packages/core/dist/memory/page-format.js";
import { validateKnowledgeAutomationSettings } from "../../../packages/shared/dist/knowledge-automation.js";
import { validatePlanUsageSettings } from "../../../packages/shared/dist/plan-usage-settings.js";
import { validateDependencySummarySettings } from "../../../packages/shared/dist/dependency-summary-settings.js";
import type { DependencySummarySettings } from "../../../packages/shared/dist/dependency-summary-settings.js";
import { defaultChannelName, normalizeChannelName, validateAdvisorWindowSettings } from "../../../packages/shared/dist/advisor-window-settings.js";
import type { AdvisorWindowSettings } from "../../../packages/shared/dist/advisor-window-settings.js";
import { GENERAL_WINDOW_KEY, type AdvisorWindowChannel, type AdvisorWindowSummary } from "../../../packages/shared/dist/advisor-windows.js";
import { isChannelAdminError, type ChannelAdmin } from "../../../packages/plugin-sdk/dist/shared/channel-admin.js";
import { validateVerificationPolicyPatch } from "../../../packages/shared/dist/verification-policy-settings.js";
import type { VerificationPolicySettings } from "../../../packages/shared/dist/verification-policy-settings.js";
import { validateReviewLimitSettings } from "../../../packages/shared/dist/review-limit-settings.js";
import type { ReviewLimitSettings } from "../../../packages/shared/dist/review-limit-settings.js";
import { REMAKE_LIMIT_SETTINGS_KEYS, validateRemakeLimitSettings } from "../../../packages/shared/dist/remake-limit-settings.js";
import { validateAutoRecoverySettings, type AutoRecoverySettings } from "../../../packages/shared/dist/auto-recovery-settings.js";
import { validateFixerEscalationSettings } from "../../../packages/shared/dist/fixer-escalation-settings.js";
import type { FixerEscalationSettings } from "../../../packages/shared/dist/fixer-escalation-settings.js";
import type { RemakeLimitSettings } from "../../../packages/shared/dist/remake-limit-settings.js";
import { validateReviewRoutingSettings } from "../../../packages/shared/dist/review-routing-settings.js";
import type { ReviewRoutingSettings } from "../../../packages/shared/dist/review-routing-settings.js";
import type { PlanUsageSettings, PlanUsageView } from "../../../packages/shared/dist/plan-usage-settings.js";
import { SettingsValidationError } from "../../../packages/shared/dist/settings-validation.js";
import { isOwnerLanguage, type OwnerLanguage } from "../../../packages/shared/dist/owner-language.js";
import { SUBAGENT_USAGE_BATCH_MAX, type HookRequestUsage } from "../../../packages/shared/dist/token-relay.js";
import { ADVISOR_CURATION_ACTION_TYPES, ADVISOR_WORKSPACE_API_PATH, ADVISOR_WORKSPACE_FINISH_API_PATH, advisorAlternativeActions, advisorCurationKind, matchAdvisorBlockedApi, builtinProviderHarness, designDocumentPath, isRuleRole, RULE_ROLES } from "../../../packages/shared/dist/index.js";
import type { AdvisorBlockedApi } from "../../../packages/shared/dist/advisor-api-policy.js";
import type { GuardTokenAgent } from "../../../packages/shared/dist/guard-token.js";
import { DESIGN_MOCK_FILE_PATTERN } from "../../../packages/shared/dist/design-documents.js";
import { GUARD_SHELL_COMMAND_KEYS, GUARD_SHELL_TOOL_NAMES } from "../../../packages/shared/dist/guard-inputs.js";
import { RESEARCH_CAPTURE_ROLES } from "../../../packages/shared/dist/permission-args.js";
import { extractWebResearchCapture } from "../../../packages/shared/dist/web-research.js";
import { CHILD_RUN_EFFORTS, CHILD_RUN_LIMITS, CHILD_RUN_PROVIDERS } from "../../../packages/shared/dist/child-runs.js";
import type { ChildDispatchRequest, ChildDispatchResponse, ChildRunEffort, ChildRunListFilter, ChildRunProvider, ChildRunRecord, ChildRunSettings, ChildWaitRequest, ChildWaitResponse } from "../../../packages/shared/dist/child-runs.js";
import { parseTokenUsagePeriod } from "../../../packages/shared/dist/token-usage-report.js";
import type { TokenUsagePeriod, TokenUsageReport } from "../../../packages/shared/dist/token-usage-report.js";
import type { CoreEvent, CorePort, CreateProjectInput, DeleteProjectInput, InboundMessageInput, IntegrationConfigPatch, IntegrationProvider, JsonObject, PostMessageInput, Project, WorkInstructionInput, BacklogStatus, RoleModelSettingInput, ProcessSkillsSettingsInput, RuntimeConfig, UpdateProjectInput, VerificationCommand, WorkConversation, WorkAssurance, WorkDesignMockList } from "./types.js";
import { browseProjectFolders, initializeExistingProjectFolder, initializeNewProjectFolder, inspectProjectFolder } from "./project-registration.js";



export const MAX_BODY_BYTES = 1024 * 1024;

export const MAX_ADVISOR_PERSONA_LENGTH = 8_000;

/** Namespace in idempotency_keys, kept apart from Core's own keys (decisions, ...). */
export const HTTP_IDEMPOTENCY_KEY_PREFIX = "http-idempotency:";

export const MAX_IDEMPOTENCY_ENTRIES = 10000;
export const STATIC_PREFIX = "/owl/";
export const UI_SESSION_COOKIE = "owl_ui_session";

export const UI_SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

export const UI_SESSION_SECRET = randomBytes(32);


export const SYSTEM_RULE_TEXT_JA: Readonly<Record<string, string>> = {
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


export const RULE_RESULT_TEXT_JA: Readonly<Record<string, string>> = {
  "The command could not be parsed safely, so execution was denied.": "コマンドを安全に解析できないため実行を拒否しました。",
  "The command could not be determined because of environment variables or other indirection.": "環境変数などで実行コマンドを特定できないため拒否しました。",
  "The deletion target could not be parsed safely.": "削除対象を安全に解析できないため拒否しました。",
  "The path could not be parsed safely.": "パスを安全に解析できないため拒否しました。",
  "The write target path could not be parsed safely.": "書き込み先のパスを安全に解析できないため拒否しました。",
  "The read target path could not be parsed safely.": "読み取り対象のパスを安全に解析できないため拒否しました。",
};


export function ownerRuleMessage(id: string, message: string, language: OwnerLanguage): string {
  if (language === "en") return message;
  if (SYSTEM_RULE_TEXT_JA[id]) return SYSTEM_RULE_TEXT_JA[id];
  if (RULE_RESULT_TEXT_JA[message]) return RULE_RESULT_TEXT_JA[message];
  if (message.startsWith("Blocked command: ")) return `禁止コマンド: ${message.slice("Blocked command: ".length)}`;
  const path = /^Blocked path \((read|write|both)\): (.*)$/u.exec(message);
  return path ? `禁止パス(${path[1]}): ${path[2]}` : message;
}


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


export interface StoredCommandResponse {
  readonly bodyHash: string;
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly workId?: string;
  readonly expiresAt: number;
}


export interface InFlightCommand {
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


export interface SkillCommandResult {
  readonly data: JsonObject;
  readonly version: number;
}


export type WorkCommandMeta = { request_id: string; idempotency_key: string; expected_version: number };



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


export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);


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
    throw new ApiError(403, "forbidden", "別サイトからの状態変更requestは受け付けません。Owl Web UIから操作してください。");
  }
  if (!isRequestOriginAllowed(request, context)) {
    throw new ApiError(403, "forbidden", "許可されていないOriginからの状態変更requestは受け付けません。Owl Web UIから操作してください。");
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


export const DEFAULT_JSON_COMPRESSION_MIN_BYTES = 1024;

export const responseContexts = new WeakMap<ServerResponse, { request: IncomingMessage; compressionMinBytes: number }>();


export function acceptsGzip(header: string | undefined): boolean {
  const qualities = new Map<string, number>();
  for (const part of (header ?? "").split(",")) {
    const [token, ...params] = part.trim().toLowerCase().split(";").map((item) => item.trim());
    const q = params.find((item) => item.startsWith("q="));
    qualities.set(token, q === undefined ? 1 : Number(q.slice(2)));
  }
  return (qualities.get("gzip") ?? qualities.get("*") ?? 0) > 0;
}


export function etagMatches(header: string | undefined, etag: string): boolean {
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


export function createUiSessionValue(): string {
  const expiresAt = Math.floor(Date.now() / 1000) + UI_SESSION_MAX_AGE_SECONDS;
  const payload = `${expiresAt}.${randomBytes(16).toString("hex")}`;
  const signature = createHmac("sha256", UI_SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}


export function hasValidUiSession(request: IncomingMessage): boolean {
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


export async function readRequestBody(request: IncomingMessage): Promise<unknown> {
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


export async function readRawBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const contentLength = headerValue(request, "content-length");
  if (contentLength !== undefined && (!/^\d+$/u.test(contentLength) || Number(contentLength) > limit)) {
    throw new ApiError(413, "upload_too_large", "リクエスト本文が許可されたuploadサイズを超えています。", { max_bytes: limit });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new ApiError(413, "upload_too_large", "リクエスト本文が許可されたuploadサイズを超えています。", { max_bytes: limit });
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
    throw new ApiError(400, "validation_error", `${label}の項目が契約と一致しません。必須項目と余分な項目を確認してください。`, { missing, extra });
  }
}


export function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}


export function validatedSettings<T>(validate: (value: unknown) => T, value: unknown, status: 400 | 422 = 400): T {
  try {
    return validate(value);
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      throw new ApiError(status, "validation_error", error.message, { field: error.field });
    }
    throw error;
  }
}


export function stringField(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new ApiError(400, "validation_error", `${label}が不正です。${min}〜${max}文字で指定してください。`);
  }
  return value;
}


/** Flat frontmatter fields for POST /knowledge: strings (≤2,000 chars) or string arrays (≤50 items, ≤200 chars each). */
export function knowledgeMetadataField(value: unknown): Record<string, string | string[]> {
  if (!isObject(value)) throw new ApiError(400, "validation_error", "metadataはオブジェクトで指定してください。");
  // No prototype: "__proto__" is a valid key and must be stored like any other.
  const result: Record<string, string | string[]> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][\w-]*$/u.test(key)) throw new ApiError(400, "validation_error", `metadataのキー ${key} が不正です。英数字・_・-で、英字か_から始めてください。`);
    if (key === "tags" || key === "created") throw new ApiError(400, "validation_error", `metadataに ${key} は含められません。`);
    if (typeof item === "string") {
      if (item.length > 2000) throw new ApiError(400, "validation_error", `metadata.${key}は2,000文字以内で指定してください。`);
    } else if (Array.isArray(item)) {
      if (item.length > 50 || item.some((entry) => typeof entry !== "string" || entry.length > 200)) {
        throw new ApiError(400, "validation_error", `metadata.${key}は200文字以内の文字列を50個までの配列で指定してください。`);
      }
    } else {
      throw new ApiError(400, "validation_error", `metadata.${key}は文字列か文字列の配列で指定してください。`);
    }
    result[key] = item;
  }
  if (typeof result.id === "string" ? !isUlid(result.id) : "id" in result) {
    throw new ApiError(400, "validation_error", "metadata.idはULIDで指定してください。");
  }
  return result;
}


export function nullableUlid(value: unknown, label: string): string | null {
  if (value !== null && !isUlid(value)) {
    throw new ApiError(400, "validation_error", `${label}が不正です。26文字の大文字ULIDまたはnullを指定してください。`);
  }
  return value;
}


export function commandEnvelope(value: unknown): { request_id: string; idempotency_key: string; expected_version: number; payload: JsonObject } {
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


export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}


export function bodyHash(value: unknown): string {
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


export async function invalidateWorkCommandCache(context: RequestContext, workId: string, preserveKey: string): Promise<void> {
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
  const lane = idempotencyLane(context);
  if (!lane) return;
  const rows = (context.db as { all<T>(sql: string, ...parameters: string[]): T[] }).all<{ key: string }>(
    "SELECT key FROM idempotency_keys WHERE key LIKE ?",
    `${HTTP_IDEMPOTENCY_KEY_PREFIX}${API_PREFIX}/works/%`,
  );
  const stale = rows.map((row) => row.key).filter((key) => key !== HTTP_IDEMPOTENCY_KEY_PREFIX + preserveKey && belongsToWork(key.slice(HTTP_IDEMPOTENCY_KEY_PREFIX.length)));
  await lane.transact((transaction) => { for (const key of stale) transaction.run("DELETE FROM idempotency_keys WHERE key = ?", key); });
}


export interface IdempotencyLane {
  transact<T>(mutate: (transaction: { run(sql: string, ...parameters: (string | number)[]): unknown }) => T): Promise<T>;
}


/** The write lane of the Core DB, or null when this server has no DB (idempotency then stays in memory only). */
export function idempotencyLane(context: RequestContext): IdempotencyLane | null {
  const db = context.db as { createWriteLane?: () => IdempotencyLane; get?: unknown; all?: unknown } | null;
  return typeof db?.createWriteLane === "function" && typeof db.get === "function" && typeof db.all === "function" ? db.createWriteLane() : null;
}


export async function loadPersistedCommand(context: RequestContext, lane: IdempotencyLane, key: string): Promise<StoredCommandResponse | undefined> {
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


export function runCommandUnlocked(
  context: RequestContext,
  routeKey: string,
  command: { request_id: string; idempotency_key: string; expected_version: number; payload: JsonObject },
  status: number,
  operation: () => Promise<{ data: JsonObject; version: number; request_id?: string }>,
  workId?: string,
): Promise<Record<string, unknown>> {
  const key = `${routeKey}:${command.idempotency_key}`;
  const hash = bodyHash(command);
  const conflict = () => new ApiError(409, "idempotency_conflict", "同じidempotency_keyに異なる内容が指定されています。新しいkeyで再試行してください。");
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
    throw new ApiError(400, "invalid_query", "limitが不正です。1〜200の整数を指定してください。");
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new ApiError(400, "invalid_query", "limitが不正です。1〜200の整数を指定してください。");
  }
  return parsed;
}


export function parseViewLimit(value: string | null, defaultValue: number | undefined, max: number | undefined): number {
  if (value === null || value === "") {
    if (defaultValue === undefined) throw new ApiError(400, "invalid_query", "limitを指定してください。");
    return defaultValue;
  }
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1 || (max !== undefined && parsed > max)) {
    throw new ApiError(400, "invalid_query", `limitが不正です。1${max === undefined ? "以上" : `〜${max}`}の整数を指定してください。`);
  }
  return parsed;
}


export function maskSecret(secret: string): string {
  return secret.length > 4 ? "*".repeat(secret.length - 4) + secret.slice(-4) : secret ? "****" : "";
}


export function parseBacklogLimit(value: string | null): number {
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


export function parseBacklogOffset(value: string | null): number {
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


export function parseArchived(value: string | null): "exclude" | "include" | "only" {
  if (value === null || value === "exclude" || value === "include" || value === "only") {
    return value ?? "exclude";
  }
  throw new ApiError(400, "invalid_query", "archivedが不正です。exclude、include、onlyのいずれかを指定してください。");
}


export function nullableQuery(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}


export function parseBoolean(value: string | null, defaultValue: boolean): boolean {
  if (value === null || value === "") {
    return defaultValue;
  }
  if (value !== "true" && value !== "false") {
    throw new ApiError(400, "invalid_query", "boolean queryが不正です。trueまたはfalseを指定してください。");
  }
  return value === "true";
}


export function pathId(value: string, label: string): string {
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


export function advisorBlockedError(row: AdvisorBlockedApi, method: string, pathname: string): ApiError {
  const alternatives = advisorAlternativeActions(row);
  return new ApiError(403, "advisor_action_required", `${row.reason} Use ${alternatives.join(" or ")} instead.`, {
    method,
    path: pathname,
    alternative_actions: alternatives,
  });
}


export function requireOwner(request: IncomingMessage): string {
  if (!isOwnerRequestAuthorized(request) && !advisorAuthorizedRequests.has(request)) {
    if (configuredApiToken() && !isLoopback(request)) {
      throw new ApiError(401, "unauthorized", "外部接続には正しいAuthorization: Bearer <OWL_API_TOKEN>が必要です。local cookieは外部経路では使用できません。");
    }
    throw new ApiError(401, "unauthorized", "外部接続にはservice tokenが必要です。Bearer tokenを指定してください。");
  }
  return process.env.OWL_OWNER_ID?.trim() || "owner:default";
}


export function requireRuleProposalOwner(request: IncomingMessage): string {
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
export function requireGuard(request: IncomingMessage, guardTokens: GuardTokenVerifier | null): GuardTokenAgent | null {
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


export function advisorSessionDatabase(value: unknown): AdvisorSessionReadDatabase | null {
  if (!isObject(value) || typeof value.get !== "function") return null;
  return value as unknown as AdvisorSessionReadDatabase;
}


/**
 * The Advisor window a session request addresses: the window of `conversationId`
 * when given, else the window named by `windowKey` (GENERAL_WINDOW_KEY or a Project id).
 * Null when neither is given, or the conversation belongs to no window, so the
 * caller falls back to the general window; "missing" when the named window does not exist yet.
 */
export function resolveAdvisorSessionWindow(
  database: AdvisorSessionReadDatabase | null,
  ownerId: string,
  conversationId: string | null,
  windowKey: string | null,
): { readonly window_id: string } | "missing" | null {
  if (!database) return null;
  if (conversationId) {
    const row = database.get<{ advisor_window_id: string | null }>("SELECT advisor_window_id FROM conversations WHERE id = ?", conversationId);
    if (row?.advisor_window_id) return { window_id: row.advisor_window_id };
  }
  if (!windowKey) return null;
  const window = windowKey === GENERAL_WINDOW_KEY
    ? database.get<{ id: string }>("SELECT id FROM advisor_windows WHERE owner_id = ? AND scope = 'general'", ownerId)
    : database.get<{ id: string }>("SELECT id FROM advisor_windows WHERE owner_id = ? AND scope = 'project' AND project_id = ?", ownerId, windowKey);
  return window ? { window_id: window.id } : "missing";
}


export function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", `http://${headerValue(request, "host") ?? "localhost"}`);
}


export function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}


export async function serveStatic(request: IncomingMessage, response: ServerResponse, webOut: string, pathname: string): Promise<boolean> {
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
    throw new ApiError(400, "validation_error", "sizeが不正です。small、normal、largeのいずれかを指定してください。");
  }
  const designMode = payload.design_mode ?? "auto";
  if (designMode !== "auto" && designMode !== "lead") {
    throw new ApiError(400, "validation_error", "design_modeはautoまたはleadを指定してください。");
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
    throw new ApiError(400, "validation_error", (error as Error).message, { field: "prerequisite_work_ids" });
  }
}


export function validateStartPayload(payload: JsonObject): "normal" | "small" {
  exactKeys(payload, ["mode"], "StartWork payload");
  if (payload.mode !== "normal" && payload.mode !== "small") {
    throw new ApiError(400, "validation_error", "modeが不正です。normalまたはsmallを指定してください。");
  }
  return payload.mode;
}


export function validatePausePayload(payload: JsonObject): string {
  exactKeys(payload, ["reason"], "PauseWork payload");
  return stringField(payload.reason, "reason", 0, 1000);
}


/** ReopenWork payload: `reason` is optional, but when present must be a non-blank string. */
export function validateReopenPayload(payload: JsonObject): string {
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


export function validateWorkInstructionPayload(payload: JsonObject): WorkInstructionInput {
  const extra = Object.keys(payload).filter((key) => key !== "body" && key !== "attachment_ids" && key !== "reopen");
  if (extra.length > 0) {
    throw new ApiError(400, "validation_error", "Work指示のpayloadの項目が契約と一致しません。余分な項目を除いてください。", { missing: [], extra });
  }
  const { body, attachment_ids: attachmentIds } = validateMessageContent(payload.body, payload.attachment_ids ?? []);
  if (payload.reopen !== undefined && typeof payload.reopen !== "boolean") {
    throw new ApiError(400, "validation_error", "reopenが不正です。trueまたはfalseを指定してください。");
  }
  return { body, attachment_ids: attachmentIds, ...(payload.reopen === undefined ? {} : { reopen: payload.reopen }) };
}


export function validateUpdateWorkPayload(payload: JsonObject): { title?: string; summary?: string } {
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


export function validateEmptyPayload(payload: JsonObject): void {
  exactKeys(payload, [], "Empty payload");
}


export function stringArrayField(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ApiError(400, "validation_error", `${label}が不正です。文字列の配列を指定してください。`);
  }
  return value as string[];
}


export function validateExplicitMemoryPayload(value: unknown): { text: string; tags: string[]; project_id: string | null } {
  if (!isObject(value)) {
    throw new ApiError(400, "validation_error", "Explicit memoryはJSON objectで指定してください。項目を確認して再試行してください。");
  }
  const allowed = new Set(["text", "tags", "project_id"]);
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
    project_id: value.project_id === undefined || value.project_id === null ? null : stringField(value.project_id, "project_id", 1, 100),
  };
}


export function validateCancelPayload(payload: JsonObject): { reason: string; force: boolean } {
  exactKeys(payload, ["reason", "force"], "CancelWork payload");
  const reason = stringField(payload.reason, "reason", 1, 1000);
  if (typeof payload.force !== "boolean") {
    throw new ApiError(400, "validation_error", "forceが不正です。booleanを指定してください。");
  }
  return { reason, force: payload.force };
}


export const ANSWER_SOURCES = ["web", "slack", "discord"] as const;

export type AnswerSource = (typeof ANSWER_SOURCES)[number];


export function validateAnswerPayload(payload: JsonObject): { answer: string; option_key: string | null; source: AnswerSource; source_message_id: string | null } {
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
    "channel_id",
    "conversation_channel_id",
    "notification_channel_id",
    "account_id",
    "owner_user_id",
  ]);
  const extra = Object.keys(payload).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new ApiError(400, "validation_error", "Integration設定に未対応の項目があります。", { extra });
  }

  const result: IntegrationConfigPatch = {};
  const stringFields: Array<keyof IntegrationConfigPatch> = [
    "bot_token",
    "app_token",
    "channel_id",
    "conversation_channel_id",
    "notification_channel_id",
    "account_id",
    "owner_user_id",
  ];
  for (const field of stringFields) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    if (typeof payload[field] !== "string") {
      throw new ApiError(400, "validation_error", `${field}は文字列で指定してください。`, { field });
    }
    const value = (payload[field] as string).trim();
    if (field === "owner_user_id") {
      if (provider !== "slack" || value.length > 64 || /\s/u.test(value)) {
        throw new ApiError(400, "validation_error", "owner_user_idが不正です。Slackのみ、空白を含まない64文字以内で指定してください（空文字で未設定に戻します）。", { field });
      }
      result[field] = value;
      continue;
    }
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


export const MODEL_SETTING_ROLE_SET: ReadonlySet<string> = new Set(MODEL_SETTING_ROLES);


export function validateVerificationCommand(value: unknown, index: number): VerificationCommand {
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


export function validateCreateProjectPayload(payload: JsonObject): CreateProjectInput {
  exactKeys(payload, ["name", "canonical_path", "base_branch", "allowed_roots", "verification_plan"], "CreateProject payload", ["post_merge_command", "post_merge_install_command", "required_test_command", "test_run", "test_policy"]);
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
  const input: CreateProjectInput = { name, canonical_path, base_branch, allowed_roots: payload.allowed_roots as string[], verification_plan };
  if (Object.prototype.hasOwnProperty.call(payload, "post_merge_command")) {
    input.post_merge_command = payload.post_merge_command === null ? null : worktreeCommandField(payload.post_merge_command, "post_merge_command");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "post_merge_install_command")) {
    input.post_merge_install_command = payload.post_merge_install_command === null ? null : worktreeCommandField(payload.post_merge_install_command, "post_merge_install_command");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "required_test_command")) {
    input.required_test_command = payload.required_test_command === null ? null : worktreeCommandField(payload.required_test_command, "required_test_command");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "test_run")) input.test_run = testRunField(payload.test_run);
  if (Object.prototype.hasOwnProperty.call(payload, "test_policy")) input.test_policy = testPolicyField(payload.test_policy);
  return input;
}


export function validateProjectFolderRequest(value: unknown): string {
  if (!isObject(value)) throw new ApiError(400, "validation_error", "フォルダ情報が正しくありません。");
  exactKeys(value, ["path"], "Project folder request");
  return stringField(value.path, "path", 1, 4096);
}


export function validateProjectSetupPayload(payload: JsonObject): { mode: "existing" | "new" | "initialize_existing"; name: string; path: string } {
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


export async function assertProjectPathNotRegistered(core: CorePort, canonicalPath: string, excludeProjectId?: string): Promise<void> {
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


export function validateProjectUpdatePayload(payload: JsonObject): UpdateProjectInput {
  const allowed = ["name", "canonical_path", "auto_push", "advisor_window_enabled", "commit_language", "worktree_setup_command", "worktree_refresh_command", "post_merge_command", "post_merge_install_command", "required_test_command", "test_run", "test_policy", "report_check_commands", "screen_paths", "verification_plan"];
  const extra = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new ApiError(400, "validation_error", "UpdateProject payloadの項目が契約と一致しません。必須項目と余分な項目を確認してください。", { missing: [], extra });
  }
  if (!allowed.some((key) => Object.prototype.hasOwnProperty.call(payload, key))) {
    throw new ApiError(400, "validation_error", "変更する項目（name、canonical_path、auto_push、worktree_setup_command、worktree_refresh_command、post_merge_command、required_test_command、verification_planのいずれか）を1つ以上指定してください。");
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
  if (Object.prototype.hasOwnProperty.call(payload, "advisor_window_enabled")) {
    if (typeof payload.advisor_window_enabled !== "boolean") throw new ApiError(400, "validation_error", "Advisorの窓を使うかはtrueかfalseで指定してください。");
    input.advisor_window_enabled = payload.advisor_window_enabled;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "commit_language")) {
    if (payload.commit_language !== null && payload.commit_language !== "ja" && payload.commit_language !== "en") throw new ApiError(400, "validation_error", "コミットメッセージの言語はja、en、nullのいずれかで指定してください。");
    input.commit_language = payload.commit_language;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "worktree_setup_command")) {
    input.worktree_setup_command = worktreeCommandField(payload.worktree_setup_command, "worktree_setup_command");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "worktree_refresh_command")) {
    input.worktree_refresh_command = worktreeCommandField(payload.worktree_refresh_command, "worktree_refresh_command");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "post_merge_command")) {
    input.post_merge_command = payload.post_merge_command === null ? null : worktreeCommandField(payload.post_merge_command, "post_merge_command");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "post_merge_install_command")) {
    input.post_merge_install_command = payload.post_merge_install_command === null ? null : worktreeCommandField(payload.post_merge_install_command, "post_merge_install_command");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "required_test_command")) {
    input.required_test_command = payload.required_test_command === null ? null : worktreeCommandField(payload.required_test_command, "required_test_command");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "test_run")) input.test_run = testRunField(payload.test_run);
  if (Object.prototype.hasOwnProperty.call(payload, "test_policy")) input.test_policy = testPolicyField(payload.test_policy);
  if (Object.prototype.hasOwnProperty.call(payload, "report_check_commands")) input.report_check_commands = reportCheckCommandsField(payload.report_check_commands);
  if (Object.prototype.hasOwnProperty.call(payload, "screen_paths")) input.screen_paths = screenPathsField(payload.screen_paths);
  if (Object.prototype.hasOwnProperty.call(payload, "verification_plan")) {
    if (!Array.isArray(payload.verification_plan)) {
      throw new ApiError(400, "validation_error", "verification_planが不正です。配列を指定してください。");
    }
    input.verification_plan =payload.verification_plan.map((item, index) => validateVerificationCommand(item, index));
  }
  return input;
}


/** Shape only; Core validates the settings themselves. */
export function testRunField(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "validation_error", "test_runはオブジェクトかnullで指定してください。", { field: "test_run" });
  return value as Record<string, unknown>;
}


/** Shape only; Core validates the policy itself. */
export function testPolicyField(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "validation_error", "test_policyはオブジェクトかnullで指定してください。", { field: "test_policy" });
  return value as Record<string, unknown>;
}


/** Shape only; Core validates each command string. */
export function reportCheckCommandsField(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new ApiError(400, "validation_error", "report_check_commandsはコマンド文字列の配列かnullで指定してください。", { field: "report_check_commands" });
  return [...value];
}


/** Shape only; Core validates each pattern. */
export function screenPathsField(value: unknown): { include: string[]; exclude?: string[] } | null {
  if (value === null) return null;
  const isStrings = (item: unknown): item is string[] => Array.isArray(item) && item.every((entry) => typeof entry === "string");
  const record = (typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  if (Object.keys(record).length === 0 || Object.keys(record).some((key) => key !== "include" && key !== "exclude") || !isStrings(record.include) || (record.exclude !== undefined && !isStrings(record.exclude))) {
    throw new ApiError(400, "validation_error", "screen_pathsは{include, exclude}（文字列の配列）かnullで指定してください。", { field: "screen_paths" });
  }
  return record.exclude === undefined ? { include: [...record.include] } : { include: [...record.include], exclude: [...record.exclude] };
}


export function worktreeCommandField(value: unknown, field: string): string[] {
  const nonEmptyArgs = field === "post_merge_command" || field === "post_merge_install_command" || field === "required_test_command";
  const valid = Array.isArray(value)
    && value.length <= 64
    && value.every((arg) => typeof arg === "string" && arg.length <= 4096 && !arg.includes("\0"))
    && (value.length === 0 || (value[0] as string).trim().length > 0)
    && (!nonEmptyArgs || value.every((arg) => (arg as string).length > 0));
  if (!valid) throw new ApiError(400, "validation_error", "コマンドは文字列の配列（先頭がコマンド名、空配列で未設定）で指定してください。", { field });
  return [...(value as string[])];
}


export function validateDeleteProjectPayload(payload: JsonObject): DeleteProjectInput {
  exactKeys(payload, ["confirmed_work_count"], "DeleteProject payload");
  if (!Number.isSafeInteger(payload.confirmed_work_count) || Number(payload.confirmed_work_count) < 0) {
    throw new ApiError(400, "validation_error", "confirmed_work_countが不正です。0以上の整数を指定してください。");
  }
  return { confirmed_work_count: Number(payload.confirmed_work_count) };
}


export async function requireRegisteredProject(core: CorePort, projectId: string): Promise<Project> {
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


export function projectCreatePayload(name: string, repository: { canonical_path: string; base_branch: string }): CreateProjectInput {
  return {
    name,
    canonical_path: repository.canonical_path,
    base_branch: repository.base_branch,
    allowed_roots: [repository.canonical_path],
    verification_plan: [],
  };
}


export function validatePostMessagePayload(payload: JsonObject): PostMessageInput {
  exactKeys(payload, ["body", "attachment_ids"], "PostMessage payload");
  return validateMessageContent(payload.body, payload.attachment_ids);
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
    throw new ApiError(400, "validation_error", `attachment_idsは重複しない最大${MAX_MESSAGE_ATTACHMENTS}件のULID配列で指定してください。`);
  }
  const blank = body.trim().length === 0;
  if (blank && attachmentValue.length === 0) {
    throw new ApiError(400, "validation_error", "本文を入力するか、ファイルを添付してください。");
  }
  return { body: blank ? "" : body, attachment_ids: attachmentValue as string[] };
}


export function validateInboundMessage(value: unknown): InboundMessageInput {
  if (!isObject(value)) throw new ApiError(400, "validation_error", "Inbound messageはJSON objectで指定してください。");
  exactKeys(value, ["provider", "account_id", "external_message_id", "user_id", "channel_id", "thread_id", "received_at", "text", "conversation_hint", "attachment_ids"], "InboundMessage", ["status_reply"]);
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
  if (!Array.isArray(value.attachment_ids) || value.attachment_ids.length > MAX_MESSAGE_ATTACHMENTS || !value.attachment_ids.every((id) => isUlid(id))) {
    throw new ApiError(400, "validation_error", `attachment_idsは最大${MAX_MESSAGE_ATTACHMENTS}件のULID配列で指定してください。`);
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
    ...(value.status_reply === undefined ? {} : { status_reply: stringField(value.status_reply, "status_reply", 1, 100000) }),
  };
}


export function validateUploadRegister(value: unknown): import("./types.js").InboundUploadRegisterInput {
  if (!isObject(value)) throw new ApiError(400, "validation_error", "UploadRegisterはJSON objectで指定してください。");
  exactKeys(value, ["provider", "account_id", "external_attachment_id", "filename", "declared_mime", "declared_bytes", "sha256", "work_id", "conversation_id", "conversation_hint"], "UploadRegister");
  if (value.provider !== "slack" && value.provider !== "discord" && value.provider !== "web") throw new ApiError(400, "validation_error", "providerが不正です。");
  const filename = stringField(value.filename, "filename", 1, 255);
  if (/[\\/\0\x00-\x1f\x7f]/u.test(filename) || filename === "." || filename === "..") throw new ApiError(400, "validation_error", "filenameにpath separatorまたはcontrol characterは指定できません。");
  if (!Number.isSafeInteger(value.declared_bytes) || Number(value.declared_bytes) < 0 || Number(value.declared_bytes) > MAX_UPLOAD_BYTES) throw new ApiError(413, "upload_too_large", "declared_bytesが許可されたuploadサイズを超えています。");
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


export function validateUploadComplete(value: JsonObject): { bytes: number; sha256: string; mime: string } {
  exactKeys(value, ["bytes", "sha256", "mime"], "CompleteUpload payload");
  if (!Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0) throw new ApiError(400, "validation_error", "bytesが不正です。");
  const sha256 = stringField(value.sha256, "sha256", 64, 64);
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new ApiError(400, "validation_error", "sha256が不正です。");
  return { bytes: Number(value.bytes), sha256, mime: stringField(value.mime, "mime", 1, 255) };
}


export function validateIngestConversationPayload(payload: JsonObject): { conversation_id: string } {
  exactKeys(payload, ["conversation_id"], "Knowledge ingestion payload");
  return { conversation_id: pathId(stringField(payload.conversation_id, "conversation_id", 1, 128), "conversation_id") };
}


export function validateRoleModelSettingInput(value: unknown, index: number): RoleModelSettingInput {
  if (!isObject(value)) {
    throw new ApiError(400, "validation_error", `roles[${index}]はJSON objectで指定してください。`);
  }
  exactKeys(value, ["role", "provider", "model", "effort"], `roles[${index}]`);
  if (typeof value.role !== "string" || !MODEL_SETTING_ROLE_SET.has(value.role)) {
    throw new ApiError(400, "validation_error", `roles[${index}].roleが不正です。advisor、manager、designer、lead_designer、worker、fixer、reviewer、librarian、curatorのいずれかを指定してください。`);
  }
  const provider = stringField(value.provider, `roles[${index}].provider`, 1, 200);
  const model = stringField(value.model, `roles[${index}].model`, 1, 200);
  if (typeof value.effort !== "string" || !MODEL_SETTING_EFFORTS.includes(value.effort)) {
    throw new ApiError(400, "validation_error", `roles[${index}].effortが不正です。low、medium、high、xhigh、maxのいずれかを指定してください。`);
  }
  return { role: value.role as RoleModelSettingInput["role"], provider, model, effort: value.effort as RoleModelSettingInput["effort"] };
}


export function validateUpdateModelSettingsPayload(payload: JsonObject): { roles: RoleModelSettingInput[] } {
  exactKeys(payload, ["roles"], "UpdateModelSettings payload");
  if (!Array.isArray(payload.roles) || payload.roles.length !== MODEL_SETTING_ROLE_SET.size) {
    throw new ApiError(400, "validation_error", `rolesが不正です。${MODEL_SETTING_ROLE_SET.size}つのroleすべてを指定してください。`);
  }
  const roles = payload.roles.map((item, index) => validateRoleModelSettingInput(item, index));
  const seenRoles = new Set(roles.map((role) => role.role));
  if (seenRoles.size !== roles.length) {
    throw new ApiError(400, "validation_error", "rolesに重複したroleが含まれています。各roleは1件ずつ指定してください。");
  }
  for (const role of MODEL_SETTING_ROLE_SET) {
    if (!seenRoles.has(role as RoleModelSettingInput["role"])) {
      throw new ApiError(400, "validation_error", `rolesに${role}が含まれていません。${MODEL_SETTING_ROLE_SET.size}つのroleすべてを指定してください。`);
    }
  }
  return { roles };
}


export function validateModelPresetName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length < 1 || name.length > MODEL_PRESET_NAME_MAX_LENGTH) throw new ApiError(400, "validation_error", `name must contain 1 to ${MODEL_PRESET_NAME_MAX_LENGTH} characters.`, { field: "name" });
  return name;
}


export function validateCreateModelPresetPayload(payload: JsonObject): { name: string; roles: RoleModelSettingInput[] } {
  exactKeys(payload, ["name", "roles"], "CreateModelPreset payload");
  return { name: validateModelPresetName(payload.name), roles: validateUpdateModelSettingsPayload({ roles: payload.roles }).roles };
}


export function validateUpdateModelPresetPayload(payload: JsonObject): { name?: string; roles?: RoleModelSettingInput[] } {
  const keys = Object.keys(payload);
  if (keys.length === 0 || keys.some((key) => key !== "name" && key !== "roles")) {
    throw new ApiError(400, "validation_error", "Provide name or roles to update a model preset.");
  }
  return {
    ...(Object.hasOwn(payload, "name") ? { name: validateModelPresetName(payload.name) } : {}),
    ...(Object.hasOwn(payload, "roles") ? { roles: validateUpdateModelSettingsPayload({ roles: payload.roles }).roles } : {}),
  };
}


export function errorStatusForUnknownRoute(): ApiError {
  return new ApiError(404, "not_found", "指定されたAPI endpointが見つかりません。pathとHTTP methodを確認してください。");
}


export type ViewData = JsonObject;


/** The request list of a subagent usage upload: 1 to SUBAGENT_USAGE_BATCH_MAX entries of ids and non-negative counts. */
export function hookRequestUsages(value: unknown): HookRequestUsage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SUBAGENT_USAGE_BATCH_MAX) {
    throw new ApiError(400, "validation_error", `requestsは1〜${SUBAGENT_USAGE_BATCH_MAX}件の配列で指定してください。`);
  }
  const count = (item: JsonObject, key: string): number => {
    const number = item[key];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
      throw new ApiError(400, "validation_error", `requests.${key}は0以上の整数で指定してください。`);
    }
    return number;
  };
  return value.map((item: unknown) => {
    if (!isObject(item)) throw new ApiError(400, "validation_error", "requestsの要素はオブジェクトで指定してください。");
    exactKeys(item, ["message_id", "model", "input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens", "created_at"], "requests item");
    const created_at = stringField(item.created_at, "requests.created_at", 1, 200);
    if (!Number.isFinite(Date.parse(created_at)) || !/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(created_at)) {
      throw new ApiError(400, "validation_error", "requests.created_atはISO 8601の日時で指定してください。");
    }
    return {
      message_id: stringField(item.message_id, "requests.message_id", 1, 200),
      model: stringField(item.model, "requests.model", 1, 200),
      input_tokens: count(item, "input_tokens"),
      cache_read_tokens: count(item, "cache_read_tokens"),
      cache_write_tokens: count(item, "cache_write_tokens"),
      output_tokens: count(item, "output_tokens"),
      created_at,
    };
  });
}


export const PREREQUISITE_ERROR_STATUS: Readonly<Record<string, number>> = { task_not_found: 404, invalid_state_transition: 409 };


/** Core reports a refused resume with a domain code; give it its HTTP status. */
export async function prerequisiteCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "";
    const status = Object.hasOwn(PREREQUISITE_ERROR_STATUS, code) ? PREREQUISITE_ERROR_STATUS[code] : undefined;
    if (status === undefined || error instanceof ApiError) throw error;
    throw new ApiError(status, code as ApiError["code"], error instanceof Error ? error.message : code, isObject((error as { details?: unknown }).details) ? (error as { details: Record<string, unknown> }).details : {}, { cause: error });
  }
}


export const WORK_MARKDOWN_ERROR_STATUS: Readonly<Record<string, number>> = {
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


/** Core reports design mock failures with a domain code; give them their HTTP status. */
export async function designMockCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const code = isObject(error) && typeof error.code === "string" ? error.code : "";
    const message = error instanceof Error ? error.message : code;
    const details = isObject((error as { details?: unknown }).details) ? (error as { details: Record<string, unknown> }).details : {};
    if (code === "design_mock_scope_denied") throw new ApiError(403, "agent_scope_denied", message, details, { cause: error });
    if (code === "design_mock_write_failed") throw new ApiError(500, "design_mock_write_failed", message, details, { cause: error });
    if (code === "validation_error") throw new ApiError(400, "validation_error", message, details, { cause: error });
    throw error;
  }
}


/** Only a Designer's guard token may save or delete mocks; Core then checks the run belongs to a screen design Task. */
export function requireDesignMockAgent(request: IncomingMessage, context: RequestContext): GuardTokenAgent {
  const denied = () => new ApiError(403, "agent_scope_denied", "design mockの保存と削除はDesignerのguard tokenでのみ呼び出せます。");
  let agent: GuardTokenAgent | null;
  try {
    agent = requireGuard(request, context.guardTokens);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw new ApiError(403, "agent_scope_denied", denied().message, {}, { cause: error });
    throw error;
  }
  if (!agent || agent.role !== "designer") throw denied();
  return agent;
}


/** The mock is agent-written HTML: sandbox it into an opaque origin even when opened directly. */
export const DESIGN_MOCK_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
};


export function sendDesignMock(response: ServerResponse, html: string): void {
  response.writeHead(200, { ...DESIGN_MOCK_HEADERS, "content-length": Buffer.byteLength(html, "utf8") });
  response.end(html, "utf8");
}


export function designMockPayload(payload: JsonObject, keys: readonly string[]): { name: string; html: string } {
  exactKeys(payload, keys, "design mock payload");
  const { name, html } = payload;
  if (typeof name !== "string" || !DESIGN_MOCK_FILE_PATTERN.test(name)) {
    throw new ApiError(400, "validation_error", "nameが不正です。小文字の英数字とハイフンで、拡張子は.htmlにしてください。");
  }
  if (keys.includes("html") && (typeof html !== "string" || html.length === 0)) {
    throw new ApiError(400, "validation_error", "htmlは1文字以上の文字列で指定してください。");
  }
  return { name, html: typeof html === "string" ? html : "" };
}


/** Legacy executor provider names mapped to child-run harnesses. */
export const HARNESS_PROVIDER_ALIASES: Readonly<Record<string, ChildRunProvider>> = { anthropic: "claude", openai: "codex" };


export const CHILD_RUN_ERROR_STATUS: Readonly<Record<string, number>> = {
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


/** Only a Worker's guard token may dispatch or wait; Core then checks the run is an active Worker. */
export function requireChildRunAgent(request: IncomingMessage, context: RequestContext): GuardTokenAgent {
  let agent: GuardTokenAgent | null;
  try {
    agent = requireGuard(request, context.guardTokens);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw new ApiError(403, "agent_scope_denied", "dispatch/waitはWorkerのguard tokenでのみ呼び出せます。", {}, { cause: error });
    }
    throw error;
  }
  if (!agent) throw new ApiError(403, "agent_scope_denied", "dispatch/waitはWorkerのguard tokenでのみ呼び出せます。");
  return agent;
}


export function optionalField<T extends string>(value: unknown, label: string, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ApiError(400, "validation_error", `${label}が不正です。${allowed.join("、")}のいずれかを指定してください。`);
  }
  return value as T;
}


export function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ApiError(400, "validation_error", `${label}が不正です。${min}〜${max}の整数を指定してください。`);
  }
  return value as number;
}


export function dispatchRequest(payload: JsonObject): ChildDispatchRequest {
  exactKeys(payload, ["title", "instruction", "write_paths"], "dispatch payload", ["timeout_minutes"]);
  const writePaths = payload.write_paths;
  if (!Array.isArray(writePaths) || writePaths.length < 1 || writePaths.length > CHILD_RUN_LIMITS.write_paths_max) {
    throw new ApiError(400, "validation_error", `write_pathsが不正です。1〜${CHILD_RUN_LIMITS.write_paths_max}件の配列を指定してください。`);
  }
  return {
    title: stringField(payload.title, "title", 1, CHILD_RUN_LIMITS.title_max_chars),
    instruction: stringField(payload.instruction, "instruction", 1, CHILD_RUN_LIMITS.instruction_max_chars),
    write_paths: writePaths.map((path) => stringField(path, "write_paths[]", 1, 300)),
    ...(payload.timeout_minutes === undefined ? {} : { timeout_minutes: boundedInteger(payload.timeout_minutes, "timeout_minutes", 5, 1440) }),
  };
}


export function waitRequest(payload: JsonObject): ChildWaitRequest {
  exactKeys(payload, ["child_ids"], "wait payload", ["return_when", "timeout_seconds"]);
  const ids = payload.child_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > CHILD_RUN_LIMITS.wait_max_ids) {
    throw new ApiError(400, "validation_error", `child_idsが不正です。1〜${CHILD_RUN_LIMITS.wait_max_ids}件の配列を指定してください。`);
  }
  return {
    child_ids: ids.map((id) => stringField(id, "child_ids[]", 1, 64)),
    ...(payload.return_when === undefined ? {} : { return_when: optionalField(payload.return_when, "return_when", ["all", "any"] as const) }),
    ...(payload.timeout_seconds === undefined ? {} : { timeout_seconds: boundedInteger(payload.timeout_seconds, "timeout_seconds", 0, CHILD_RUN_LIMITS.wait_max_seconds) }),
  };
}


export const ADVISOR_DELIVERY_ERROR_STATUS: Readonly<Record<string, number>> = { validation_error: 400, not_found: 404 };


/** Core refuses a bad report with a domain code; give it its HTTP status. */
export async function advisorDeliveryCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "";
    const status = Object.hasOwn(ADVISOR_DELIVERY_ERROR_STATUS, code) ? ADVISOR_DELIVERY_ERROR_STATUS[code] : undefined;
    if (status === undefined || error instanceof ApiError) throw error;
    throw new ApiError(status, code as ApiError["code"], error instanceof Error ? error.message : code, {}, { cause: error });
  }
}


export function parseTokenUsageTop(value: string | null): number {
  if (value === null) return 10;
  const parsed = Number(value);
  if (!/^\d+$/u.test(value) || parsed < 1 || parsed > 50) {
    throw new ApiError(400, "validation_error", "topは1〜50の整数を指定してください。", { field: "top" });
  }
  return parsed;
}


export function parseConversationLimit(value: string | null): number {
  if (value === null || value === "") return 100;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || parsed < 1 || parsed > 500) {
    throw new ApiError(400, "validation_error", "limitが不正です。1〜500の整数を指定してください。");
  }
  return parsed;
}


/** A page that does not fit the four templates: 422 with the validatePage errors; nothing was written. */
export function rejectedPage(error: unknown): ApiError | null {
  return error instanceof PageRejectedError
    ? new ApiError(422, "validation_error", "ナレッジのページがテンプレート（theme / project-index / work-log / clipping）に合いません。", { errors: error.errors })
    : null;
}


export const advisorWindowFeature = (core: CorePort) => requireCoreFeature(core, [
  "listAdvisorWindows", "listAdvisorChannelBindings", "ensureAdvisorWindow", "getAdvisorChannelBinding", "findAdvisorChannelOwner",
  "bindAdvisorChannel", "updateAdvisorChannelName", "getAdvisorWindowSettings", "setAdvisorWindowSettings", "setAdvisorWindowOrder", "markAdvisorWindowRead",
], { code: "dependency_unavailable", message: "The loaded Core does not support Advisor windows." });

export const knowledgeStorageFeature = (core: CorePort) => requireCoreFeature(core, [
  "activeKnowledgeDir", "getKnowledgeStorage", "hasKnowledgeStorageEverBeenAvailable", "checkKnowledgeStorage", "moveKnowledgeStorage", "withKnowledgeAccess",
], { code: "dependency_unavailable", message: "The loaded Core does not support knowledge storage access." });

/** The Project an Advisor's window is dedicated to; null when the caller is not an Advisor or its window is not a Project window. */
export function advisorWindowProject(core: CorePort, advisor: GuardTokenAgent | null) {
  if (!advisor) return null;
  const port = requireCoreFeature(core, ["windowProjectForSession", "backlogItemProjects"],
    { code: "dependency_unavailable", message: "The loaded Core does not support Advisor window scopes." });
  const projectId = port.windowProjectForSession(advisor.agent_run_id);
  return projectId === null ? null : { port, projectId };
}

export function windowScopeMismatch(windowProjectId: string, requestedProjectId: string | null): ApiError {
  return new ApiError(403, "window_scope_mismatch", "このAdvisorの窓は別のプロジェクトの専属です。そのプロジェクトの窓に引き継いでください。", {
    window_project_id: windowProjectId,
    requested_project_id: requestedProjectId,
  });
}


export type ChannelProvider = "slack" | "discord";

export const CHANNEL_PROVIDERS: readonly ChannelProvider[] = ["slack", "discord"];

export type ChannelOperation = "create" | "rename" | "describe" | "invite";


export function channelProvider(value: string | undefined): ChannelProvider {
  const provider = CHANNEL_PROVIDERS.find((candidate) => candidate === value);
  if (!provider) throw new ApiError(400, "validation_error", "providerはslackまたはdiscordで指定してください。", { field: "provider" });
  return provider;
}


export async function integrationOf(context: RequestContext, provider: ChannelProvider): Promise<{ configured: boolean; channelIds: Set<string> }> {
  const status = (await context.core.getIntegrations()).find((integration) => integration.provider === provider);
  const ids = [status?.conversation_channel_id, status?.notification_channel_id]
    .flatMap((value) => (value ?? "").split(/[\s,]+/u))
    .filter((id) => id.length > 0);
  return { configured: status?.configured ?? false, channelIds: new Set(ids) };
}


/** Per-provider candidates for the Web send_file destination; names come from Slack/Discord when the Connector runs. */
export async function fileDestinationProviders(context: RequestContext): Promise<FileDestinationProviderView[]> {
  const statuses = await context.core.getIntegrations();
  const windows = await advisorWindowFeature(context.core).listAdvisorWindows();
  const names = new Map<string, string>();
  const integrations = [];
  for (const provider of CHANNEL_PROVIDERS) {
    const status = statuses.find((entry) => entry.provider === provider);
    const admin = context.channelAdmins?.channelAdmin(provider) ?? null;
    const conversationChannelIds = (status?.conversation_channel_id ?? "").split(/[\s,]+/u).filter((id) => id.length > 0);
    for (const id of conversationChannelIds) {
      const info = admin ? await admin.describeChannel(id).catch(() => null) : null;
      if (info?.name) names.set(`${provider}:${id}`, info.name);
    }
    integrations.push({ provider, configured: status?.configured ?? false, running: admin !== null, conversationChannelIds });
  }
  return buildFileDestinationCandidates(integrations, windows, names);
}


export async function fileDestinationData(context: RequestContext, providers: FileDestinationProviderView[]): Promise<JsonObject> {
  const settings = await context.core.getAdvisorFileDestinationSettings();
  return {
    preferred_provider: settings.preferredProvider,
    default_destination: settings.defaultDestination
      ? { ...settings.defaultDestination, available: isDefaultAvailable(settings, providers) }
      : null,
    providers: providers as unknown as JsonObject[],
  };
}


export async function requireChannelAdmin(context: RequestContext, provider: ChannelProvider): Promise<ChannelAdmin> {
  const admin = context.channelAdmins?.channelAdmin(provider) ?? null;
  if (admin) return admin;
  const { configured } = await integrationOf(context, provider);
  throw new ApiError(503, "integration_not_running", `${provider}連携が動いていません。設定画面で連携を確認してください。`, { provider, configured });
}


/** Maps a connector's ChannelAdminError to the API error of design section 14; anything else passes through. */
export function channelAdminApiError(error: unknown, provider: ChannelProvider, operation: ChannelOperation): unknown {
  if (!isChannelAdminError(error)) return error;
  const providerCode = error.provider_code;
  switch (error.code) {
    case "permission_missing":
      return new ApiError(422, "integration_permission_missing", error.message, { provider, operation, needed: [...error.needed] });
    case "name_taken":
      return new ApiError(409, "channel_name_taken", error.message, { provider });
    case "invalid_name":
      return new ApiError(422, "validation_error", error.message, { field: "name", provider, ...(providerCode ? { provider_code: providerCode } : {}) });
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


/**
 * Creates and binds a channel for each running provider that has none yet. Failures never undo the window's ON;
 * they are returned per provider so the screen can show the reason.
 */
export async function provisionWindowChannels(context: RequestContext, ownerId: string, key: string): Promise<JsonObject> {
  const results: JsonObject = {};
  try {
    const api = advisorWindowFeature(context.core);
    const window = await api.ensureAdvisorWindow(ownerId, key);
    if (!window) return results;
    const settings = await api.getAdvisorWindowSettings();
    for (const provider of CHANNEL_PROVIDERS) {
      const admin = context.channelAdmins?.channelAdmin(provider) ?? null;
      if (!admin) continue;
      const existing = await api.getAdvisorChannelBinding(window.window_id, provider);
      if (existing) {
        results[provider] = { status: "already_bound", channel_id: existing.channel_id, display_name: existing.display_name };
        continue;
      }
      try {
        const name = channelNameFromPayload(defaultChannelName(projectNameOf(context, key), key, settings), settings);
        const info = await channelCall(provider, "create", () => admin.createChannel(name));
        await api.bindAdvisorChannel(window.window_id, provider, info.channel_id, info.name);
        const result: JsonObject = { status: "bound", channel_id: info.channel_id, display_name: info.name, invite: "not_applicable" };
        results[provider] = result;
        if (provider !== "slack") continue;
        const ownerUserId = (await context.core.getIntegrations()).find((integration) => integration.provider === provider)?.owner_user_id ?? null;
        if (!ownerUserId) {
          result.invite = "skipped_no_owner_user_id";
          continue;
        }
        try {
          await channelCall(provider, "invite", () => admin.inviteUsers(info.channel_id, [ownerUserId]));
          result.invite = "invited";
        } catch (error) {
          result.invite = "failed";
          result.invite_error = windowChannelError(error);
        }
      } catch (error) {
        results[provider] = { status: "failed", error: windowChannelError(error) };
      }
    }
  } catch (error) {
    results.error = windowChannelError(error);
  }
  return results;
}


export async function slackOwnerUserId(context: RequestContext): Promise<string> {
  const ownerUserId = (await context.core.getIntegrations()).find((integration) => integration.provider === "slack")?.owner_user_id ?? "";
  if (!ownerUserId) throw new ApiError(422, "owner_user_id_missing", "オーナーIDが未設定です。設定画面でSlackのオーナーIDを保存してから、もう一度招待してください。", { provider: "slack" });
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
  if (typeof value !== "string") throw new ApiError(422, "validation_error", "nameを文字列で指定してください。", { field: "name" });
  const name = normalizeChannelName(value, settings);
  if (name.length === 0) throw new ApiError(422, "validation_error", "nameに使える文字がありません。別の名前を指定してください。", { field: "name" });
  return name;
}


export function channelBindingBody(binding: AdvisorWindowChannel): JsonObject {
  return { provider: binding.provider, channel_id: binding.channel_id, display_name: binding.display_name };
}


export function knowledgeStorageErrorCode(error: unknown): string | null {
  return isObject(error) && typeof error.code === "string" ? error.code : null;
}


export function isKnowledgeStorageApiError(error: unknown): boolean {
  const code = knowledgeStorageErrorCode(error);
  return code === "knowledge_storage_unavailable" || code === "knowledge_storage_moving";
}


export async function withKnowledgeStorageAccess<T>(core: CorePort, kind: "read" | "write", operation: () => Promise<T>): Promise<T> {
  const api = knowledgeStorageFeature(core);
  if (kind === "write" && api.getKnowledgeStorage().state === "moving") {
    throw Object.assign(new Error("The knowledge storage is being moved."), { code: "knowledge_storage_moving", details: {} });
  }
  try {
    return await api.withKnowledgeAccess(kind, operation);
  } catch (error) {
    if (knowledgeStorageErrorCode(error) === "knowledge_storage_unavailable") throw error;
    const code = knowledgeStorageErrorCode(error);
    if (code && ["ENOENT", "EIO", "ENXIO", "ENODEV", "ESTALE", "ETIMEDOUT", "EACCES", "EPERM", "EROFS"].includes(code)) {
      const status = await api.checkKnowledgeStorage().catch((checkError) => {
        // Status is only used to refine the error; the original error is rethrown below.
        console.error("Knowledge storage re-check failed", checkError);
        return null;
      });
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


export async function dispatchPendingCoreEvents(core: CorePort): Promise<void> {
  const wrapped = core as CorePort & { core?: unknown };
  const target = (isObject(wrapped.core) ? wrapped.core : core) as unknown as JsonObject;
  const dispatcher = isObject(target.dispatcher) ? target.dispatcher : null;
  if (dispatcher && typeof dispatcher.replayPending === "function") {
    await dispatcher.replayPending.call(dispatcher);
  }
}


export function ruleProposalCommandResult(value: unknown): { data: JsonObject; version: number } {
  if (!isObject(value)) throw new ApiError(503, "core_not_ready", "Rule proposal command returned an invalid result.");
  if (isObject(value.data) && typeof value.version === "number") {
    return { data: value.data, version: value.version };
  }
  return { data: value, version: 0 };
}


export function ruleProposalApiError(error: unknown): unknown {
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


export const CURATION_KIND_VALUES = ["librarian", "skill_curation", "rule_curation"];

export const CURATION_STATUS_VALUES = ["running", "succeeded", "failed"];


/**
 * Every action type the /advisor/actions endpoint accepts. The curation types
 * come from the shared list, and both the allowlist below and the dispatch
 * branch use `Set.has`, which — unlike indexing a plain object — can never
 * match an inherited Object.prototype member such as "constructor".
 */
export const ADVISOR_ACTION_TYPES: ReadonlySet<string> = new Set([
  "create_work",
  "start_work",
  "pause_work",
  "reopen_work",
  "cancel_work",
  "delete_work",
  "send_work_instruction",
  "update_work",
  "resume_work",
  "answer_decision",
  "send_file",
  ...ADVISOR_CURATION_ACTION_TYPES,
]);


export function curationEnumQuery(value: string | null, allowed: string[], name: string): string | undefined {
  if (value === null || value === "") return undefined;
  if (!allowed.includes(value)) {
    throw new ApiError(400, "validation_error", `${name}が不正です。${allowed.join("、")}のいずれかを指定してください。`);
  }
  return value;
}


export function parseAutoWorkEventsQuery(url: URL): JsonObject {
  const oneOf = (name: string, allowed: readonly string[]) => {
    const value = url.searchParams.get(name);
    if (value === null) return {};
    if (!allowed.includes(value)) throw new ApiError(400, "validation_error", `${name}が不正です。${allowed.join("、")}のいずれかを指定してください。`, { field: name });
    return { [name]: value };
  };
  const id = (name: string) => {
    const value = url.searchParams.get(name);
    return value === null ? {} : { [name]: pathId(value, name) };
  };
  const limit = url.searchParams.get("limit");
  return {
    ...id("project_id"), ...oneOf("source", AUTO_WORK_SOURCES), ...oneOf("verdict", AUTO_WORK_VERDICTS), ...id("work_id"),
    ...(limit === null || limit === "" ? {} : { limit: parseBacklogLimit(limit) }),
    offset: parseBacklogOffset(url.searchParams.get("offset")),
  };
}


export function validateUpdateAutoWorkSettingsPayload(payload: JsonObject): JsonObject {
  exactKeys(payload, [], "UpdateAutoWorkSettings payload", ["enabled", "projects"]);
  const toggle = (value: unknown, field: string) => {
    if (value !== null && typeof value !== "boolean") throw new ApiError(400, "validation_error", `${field}はtrue、false、nullのいずれかで指定してください。`, { field });
    return value;
  };
  const result: JsonObject = {};
  if (payload.enabled !== undefined) result.enabled = toggle(payload.enabled, "enabled") as boolean | null;
  if (payload.projects !== undefined) {
    if (!isObject(payload.projects)) throw new ApiError(400, "validation_error", "projectsはJSON objectで指定してください。", { field: "projects" });
    const projects: JsonObject = {};
    for (const [projectId, change] of Object.entries(payload.projects)) {
      pathId(projectId, "projects");
      if (!isObject(change)) throw new ApiError(400, "validation_error", "projectsの値はJSON objectで指定してください。", { field: "projects" });
      exactKeys(change, ["enabled"], "projects entry");
      projects[projectId] = { enabled: toggle(change.enabled, "projects.enabled") as boolean | null };
    }
    result.projects = projects;
  }
  return result;
}


export function validateBacklogProjectId(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (!isUlid(value)) throw new ApiError(400, "validation_error", "project_idはULIDで指定してください。", { field: "project_id" });
  return value;
}


export function validateBacklogStatus(value: string | null): BacklogStatus | undefined {
  if (value === null) return undefined;
  if (value !== "open" && value !== "in_progress" && value !== "done" && value !== "dismissed") {
    throw new ApiError(400, "validation_error", "statusはopen、in_progress、done、dismissedのいずれかで指定してください。", { field: "status" });
  }
  return value;
}


export interface BacklogListQuery {
  status?: BacklogStatus;
  project_id?: string;
  work_id?: string;
  issued_work_id?: string;
  limit: number;
  offset: number;
}


export function parseBacklogListQuery(url: URL): BacklogListQuery {
  const projectId = validateBacklogProjectId(url.searchParams.get("project_id"));
  const status = validateBacklogStatus(url.searchParams.get("status"));
  const workIdValue = url.searchParams.get("work_id");
  const issuedWorkIdValue = url.searchParams.get("issued_work_id");
  return {
    ...(projectId === undefined ? {} : { project_id: projectId }),
    ...(status === undefined ? {} : { status }),
    ...(workIdValue === null ? {} : { work_id: pathId(workIdValue, "work_id") }),
    ...(issuedWorkIdValue === null ? {} : { issued_work_id: pathId(issuedWorkIdValue, "issued_work_id") }),
    limit: parseBacklogLimit(url.searchParams.get("limit")),
    offset: parseBacklogOffset(url.searchParams.get("offset")),
  };
}


export function validateBacklogItemIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100 || !value.every(isUlid) || new Set(value).size !== value.length) {
    throw new ApiError(400, "validation_error", "item_idsは重複のない1〜100件のULID配列で指定してください。", { field: "item_ids" });
  }
  return value as string[];
}


export function validateDismissBacklogPayload(payload: JsonObject): { item_ids: string[] } {
  exactKeys(payload, ["item_ids"], "DismissBacklogItems payload");
  return { item_ids: validateBacklogItemIds(payload.item_ids) };
}


export function validateLinkBacklogItemsPayload(payload: JsonObject): { item_ids: string[] } {
  exactKeys(payload, ["item_ids"], "LinkBacklogItems payload");
  return { item_ids: validateBacklogItemIds(payload.item_ids) };
}


export function validateIssueBacklogWorkPayload(payload: JsonObject): { item_ids: string[]; title: string; summary: string; size: "small" | "normal" | "large" } {
  exactKeys(payload, ["item_ids", "title", "summary", "size"], "IssueBacklogWork payload");
  const item_ids = validateBacklogItemIds(payload.item_ids);
  const title = stringField(payload.title, "title", 1, 500);
  const summary = stringField(payload.summary, "summary", 0, 20000);
  if (payload.size !== "small" && payload.size !== "normal" && payload.size !== "large") {
    throw new ApiError(400, "validation_error", "sizeはsmall、normal、largeのいずれかで指定してください。", { field: "size" });
  }
  return { item_ids, title, summary, size: payload.size };
}


export function decodeRouteValue(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    throw new ApiError(400, "validation_error", `${label} cannot be decoded.`, {}, { cause: error });
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
const CHILD_RUN_UNAVAILABLE = { code: "dependency_unavailable", message: "The loaded Core does not support child runs." } as const;
/** 5個すべてを確かめる。1個でも無ければ 503。 */
export const childRunFeature = (core: CorePort) => requireAdapterFeature(core, CHILD_RUN_KEYS, CHILD_RUN_UNAVAILABLE);
