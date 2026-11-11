import { configuredApiToken } from "./config.js";
import { requireAdapterFeature, requireCoreFeature } from "./core-feature.js";
import { ApiError } from "./errors.js";
import { SystemRouteMessages as M } from "./messages/routes-system.js";
import { listHostDirectories } from "./fs-directories.js";
import {
  UI_SESSION_COOKIE,
  commandEnvelope,
  decodeRouteValue,
  exactKeys,
  isLoopback,
  parseBoolean,
  parseLimit,
  readRequestBody,
  requireOwner,
  runCommand,
  sendJson,
  workMarkdownCall,
  type ApiRoute,
  type RouteRequest,
  UI_SESSION_SECRET,
  requestId,
} from "./http-common.js";
import { API_PREFIX } from "./http-route-table.js";
import { renderOwnerFolder, sendOwnerFile, sendOwnerFolder } from "./owner-files-http.js";
import type { JsonObject } from "./types.js";
import { parseTokenUsagePeriod } from "@owl/shared/token-usage-report";
import { createHmac, randomBytes } from "node:crypto";

const UI_SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

function createUiSessionValue(): string {
  const expiresAt = Math.floor(Date.now() / 1000) + UI_SESSION_MAX_AGE_SECONDS;
  const payload = `${expiresAt}.${randomBytes(16).toString("hex")}`;
  const signature = createHmac("sha256", UI_SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function parseTokenUsageTop(value: string | null): number {
  if (value === null) return 10;
  const parsed = Number(value);
  if (!/^\d+$/u.test(value) || parsed < 1 || parsed > 50) {
    throw new ApiError(400, "validation_error", M.topInvalid(), { field: "top" });
  }
  return parsed;
}


/** Routes that sit before OWNER_FILE_ROUTES in the original routeApi (rows 2, 3, 4, 6, 7). */
export const SYSTEM_ENTRY_ROUTES: readonly ApiRoute[] = [
  {
    method: "GET",
    path: "/api/v1/health",
    async handle(route: RouteRequest): Promise<void> {
      const { context, request, response } = route;
      if (!isLoopback(request)) {
        throw new ApiError(403, "forbidden", M.healthLoopbackOnly());
      }
      if (!context.core.ready || context.shuttingDown) {
        throw new ApiError(503, "core_not_ready", M.coreNotReady());
      }
      sendJson(response, 200, { status: "ok", schema_version: context.contract.contract_version, core_time: new Date().toISOString() });
    },
  },
  {
    method: "GET",
    path: "/api/v1/runtime-config.json",
    async handle(route: RouteRequest): Promise<void> {
      const { context, request, response } = route;
      if (!isLoopback(request)) {
        throw new ApiError(403, "forbidden", M.runtimeConfigLocalOnly());
      }
      if (!context.core.ready || context.shuttingDown) {
        throw new ApiError(503, "core_not_ready", M.coreNotReady());
      }
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
    },
  },
  {
    method: "GET",
    path: "/api/v1/system/status",
    async handle(route: RouteRequest): Promise<void> {
      const { context, request, response, url } = route;
      requireOwner(request);
      parseBoolean(url.searchParams.get("verbose"), false);
      // data_dir lets connectors store inbound files next to the server's data.
      sendJson(response, 200, { ...(context.core.status() as unknown as Record<string, unknown>), data_dir: context.dataDir });
    },
  },
  {
    method: "GET",
    path: "/api/v1/token-usage",
    async handle(route: RouteRequest): Promise<void> {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const period = parseTokenUsagePeriod(url.searchParams.get("period") ?? "7d");
      if (!period) throw new ApiError(400, "validation_error", M.periodInvalid(), { field: "period" });
      const data = requireCoreFeature(context.core, ["getTokenUsageReport"],
        { code: "dependency_unavailable", message: M.tokenUsageUnsupported() }).getTokenUsageReport({
        period,
        top: parseTokenUsageTop(url.searchParams.get("top")),
      });
      sendJson(response, 200, { request_id: requestIdValue, data });
    },
  },
  {
    method: "GET",
    path: "/api/v1/token-usage/requests",
    async handle(route: RouteRequest): Promise<void> {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const threshold = url.searchParams.get("threshold_tokens");
      if (threshold !== null && !/^[1-9][0-9]*$/u.test(threshold)) {
        throw new ApiError(400, "validation_error", M.thresholdTokensInvalid(), { field: "threshold_tokens" });
      }
      const models = url.searchParams.getAll("model").filter((model) => model.length > 0);
      const workId = url.searchParams.get("work_id");
      const data = requireCoreFeature(context.core, ["countLargeModelRequests"],
        { code: "dependency_unavailable", message: M.requestCountsUnsupported() }).countLargeModelRequests({
        ...(threshold !== null ? { threshold_tokens: Number(threshold) } : {}),
        ...(models.length > 0 ? { models } : {}),
        ...(workId ? { work_id: workId } : {}),
      });
      sendJson(response, 200, { request_id: requestIdValue, data });
    },
  },
];

/** `rest` is the part after /owner-files/ (empty when absent), as the original ownerFilesMatch[1] ?? "". */
async function handleOwnerFiles(route: RouteRequest, rest: string): Promise<void> {
  const { context, request, response, url, rawPathname, method } = route;
  const requestIdValue = route.requestId;
  requireOwner(request);
  const files = requireCoreFeature(context.core, ["listOwnerFileRoots", "openOwnerFile"],
    { code: "dependency_unavailable", message: M.ownerFilesUnsupported() });
  if (rest === "roots") {
    const roots = await files.listOwnerFileRoots();
    sendJson(response, 200, { request_id: requestIdValue, data: { roots } });
    return;
  }
  const parts = rest.split("/");
  const key = decodeRouteValue(parts[0]!, "root");
  const trailingSlash = parts.length > 1 && parts[parts.length - 1] === "";
  const segments = parts.slice(1, trailingSlash ? -1 : undefined).map((part) => decodeRouteValue(part, "path"));
  const opened = await workMarkdownCall(() => files.openOwnerFile(key, segments));
  if (opened.kind === "file") {
    sendOwnerFile(request, response, opened);
    return;
  }
  // Relative links in the listing only resolve against a URL that ends in "/".
  if (!trailingSlash) {
    response.writeHead(308, { location: `${rawPathname}/${url.search}`, "cache-control": "no-store" });
    response.end();
    return;
  }
  sendOwnerFolder(response, renderOwnerFolder([key, ...segments].join("/") + "/", opened.entries), method === "HEAD");
}

/** Matched against rawPathname. The roots rows come before the {path*} rows (rows 13-18). */
export const OWNER_FILE_ROUTES: readonly ApiRoute[] = [
  { method: "GET", path: "/api/v1/owner-files", raw: true, handle: (route) => handleOwnerFiles(route, "") },
  { method: "HEAD", path: "/api/v1/owner-files", raw: true, handle: (route) => handleOwnerFiles(route, "") },
  { method: "GET", path: "/api/v1/owner-files/roots", raw: true, handle: (route) => handleOwnerFiles(route, "roots") },
  { method: "HEAD", path: "/api/v1/owner-files/roots", raw: true, handle: (route) => handleOwnerFiles(route, "roots") },
  { method: "GET", path: "/api/v1/owner-files/{path*}", raw: true, handle: (route) => handleOwnerFiles(route, route.params.path ?? "") },
  { method: "HEAD", path: "/api/v1/owner-files/{path*}", raw: true, handle: (route) => handleOwnerFiles(route, route.params.path ?? "") },
];

export const SYSTEM_ROUTES: readonly ApiRoute[] = [
  {
    method: "GET",
    path: "/api/v1/tokens/view",
    async handle(route: RouteRequest): Promise<void> {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const period = parseTokenUsagePeriod(url.searchParams.get("period") ?? "7d");
      if (!period) throw new ApiError(400, "validation_error", M.periodInvalid(), { field: "period" });
      const data = await requireAdapterFeature(context.core, ["getTokensView"],
        { code: "dependency_unavailable", message: M.tokensViewUnsupported() }).getTokensView({
        period,
        top: parseTokenUsageTop(url.searchParams.get("top")),
      });
      sendJson(response, 200, { request_id: requestIdValue, data, version: 1 });
    },
  },
  {
    method: "GET",
    path: "/api/v1/plan-usage",
    async handle(route: RouteRequest): Promise<void> {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const data = await requireCoreFeature(context.core, PLAN_USAGE_KEYS, PLAN_USAGE_UNAVAILABLE).getPlanUsage();
      sendJson(response, 200, { request_id: requestIdValue, data });
    },
  },
  {
    method: "POST",
    path: "/api/v1/plan-usage/refresh",
    async handle(route: RouteRequest): Promise<void> {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const command = commandEnvelope(await readRequestBody(request));
      exactKeys(command.payload, [], "Plan usage refresh payload");
      const api = requireCoreFeature(context.core, PLAN_USAGE_KEYS, PLAN_USAGE_UNAVAILABLE);
      const result = await runCommand(context, pathname, command, 200, async () => ({
        data: await api.refreshPlanUsage() as unknown as JsonObject,
        version: 0,
      }));
      sendJson(response, 200, result);
    },
  },
  {
    method: "GET",
    path: "/api/v1/metrics/review",
    async handle(route: RouteRequest): Promise<void> {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const data = await requireCoreFeature(context.core, ["getReviewMetrics"],
        { code: "dependency_unavailable", message: M.reviewMetricsUnsupported() }).getReviewMetrics();
      sendJson(response, 200, { request_id: requestIdValue, data, version: 0 });
    },
  },
  {
    method: "GET",
    path: "/api/v1/fs/directories",
    async handle(route: RouteRequest): Promise<void> {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const showHidden = url.searchParams.get("show_hidden") ?? "0";
      if (showHidden !== "0" && showHidden !== "1") {
        throw new ApiError(422, "validation_error", M.showHiddenInvalid());
      }
      sendJson(response, 200, { request_id: requestIdValue,
        data: await listHostDirectories(url.searchParams.get("path") ?? undefined, showHidden === "1", context.dataDir), version: 0 });
    },
  },
  {
    method: "GET",
    path: "/api/v1/events",
    async handle(route: RouteRequest): Promise<void> {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const afterValue = url.searchParams.get("after");
      if (afterValue !== null && !/^\d+$/.test(afterValue)) {
        throw new ApiError(400, "invalid_query", M.afterInvalid());
      }
      const afterCursor = afterValue === null ? 0 : Number(afterValue);
      if (!Number.isSafeInteger(afterCursor)) {
        throw new ApiError(400, "invalid_query", M.afterTooLarge());
      }
      const limit = parseLimit(url.searchParams.get("limit"), 50);
      const order = url.searchParams.get("order") ?? "asc";
      if (order !== "asc" && order !== "desc") {
        throw new ApiError(400, "invalid_query", M.orderInvalid());
      }
      const beforeValue = url.searchParams.get("before");
      if (order === "desc") {
        // Newest-first page (Activity Log). `before` is an exclusive sequence
        // cursor: pass the previous page's cursor to read older events.
        if (afterValue !== null) {
          throw new ApiError(400, "invalid_query", M.afterWithDesc());
        }
        if (beforeValue !== null && !/^\d+$/.test(beforeValue)) {
          throw new ApiError(400, "invalid_query", M.beforeInvalid());
        }
        const before = beforeValue === null ? null : Number(beforeValue);
        if (before !== null && !Number.isSafeInteger(before)) {
          throw new ApiError(400, "invalid_query", M.beforeTooLarge());
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
        throw new ApiError(400, "invalid_query", M.beforeNeedsDesc());
      }
      const events = context.core.eventsAfter(afterCursor, limit);
      const nextCursor = events.length > 0 ? events[events.length - 1].cursor : String(afterCursor);
      sendJson(response, 200, { request_id: requestIdValue, data: { events, cursor: nextCursor, has_more: events.length === limit } });
    },
  },
];

// The original requirePlanUsageApi checked all four plan-usage methods for both routes.
const PLAN_USAGE_KEYS = ["getPlanUsage", "refreshPlanUsage", "getPlanUsageSettings", "setPlanUsageSettings"] as const;
const PLAN_USAGE_UNAVAILABLE = { code: "dependency_unavailable", message: M.planUsageUnsupported() } as const;
