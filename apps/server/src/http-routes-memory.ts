import { ApiError } from "./errors.js";
import { isUlid } from "./ids.js";
import { optionalCoreFeature, requireAdapterFeature, requireCoreFeature } from "./core-feature.js";
import { API_PREFIX } from "./http-route-table.js";
import {
  CURATION_KIND_VALUES,
  CURATION_STATUS_VALUES,
  commandEnvelope,
  curationEnumQuery,
  decodeRouteValue,
  headerValue,
  isKnowledgeStorageApiError,
  isObject,
  knowledgeMetadataField,
  nullableQuery,
  pathId,
  readRequestBody,
  rejectedPage,
  requireGuard,
  requireOwner,
  runCommand,
  sendApiError,
  sendJson,
  stringField,
  validateExplicitMemoryPayload,
  validateIngestConversationPayload,
  withKnowledgeStorageAccess,
  type ApiRoute,
  type RequestContext,
} from "./http-common.js";
import { MEMORY_GET_OPERATIONS, MEMORY_OPERATIONS, memoryContext, runMemoryOperation } from "./http-memory.js";
import { validateMemoryPagesIntegratePayload } from "./http-memory-integrate.js";
import type { JsonObject } from "./types.js";

/** memory 操作 10 行。パスは MEMORY_OPERATIONS、メソッドは MEMORY_GET_OPERATIONS で決まる。 */
const memoryOperationRoutes = (): ApiRoute[] => [...MEMORY_OPERATIONS].map((memoryOp): ApiRoute => ({
  method: MEMORY_GET_OPERATIONS.has(memoryOp) ? "GET" : "POST",
  path: `${API_PREFIX}/memory/${memoryOp}`,
  async handle(route) {
    const { context, request, response } = route;
    const agent = memoryOp === "reindex" ? (requireOwner(request), null) : requireGuard(request, context.guardTokens);
    const body = MEMORY_GET_OPERATIONS.has(memoryOp) ? undefined : await readRequestBody(request);
    const ctx = memoryContext(agent, (name) => headerValue(request, name));
    sendJson(response, 200, (await runMemoryOperation(context.core, memoryOp, body, ctx)) as Record<string, unknown>);
  },
}));

const curationFeature = (core: RequestContext["core"]) => requireAdapterFeature(
  core, ["runCuration", "startCurationInBackground", "listCurationRuns", "getCurationRun"],
  { code: "core_not_ready", message: "The loaded Core does not support the curation run API." });

export const MEMORY_ROUTES: readonly ApiRoute[] = [
  {
    method: "GET",
    path: `${API_PREFIX}/memory/pages/pending`,
    async handle(route) {
      const { context, request, response, pathname, method } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      try {
        const data = await requireCoreFeature(context.core, ["memoryPendingStats"],
          { code: "core_not_ready", message: "The loaded Core does not report the librarian backlog." }).memoryPendingStats();
        sendJson(response, 200, { request_id: requestIdValue, data });
      } catch (error) {
        await sendApiError(response, requestIdValue, error, `${method} ${pathname}`, context.core);
      }
    },
  },
  {
    method: "POST",
    path: `${API_PREFIX}/memory/pages/integrate`,
    async handle(route) {
      const { context, request, response, pathname, method } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      try {
        const { paths } = validateMemoryPagesIntegratePayload(await readRequestBody(request));
        const data = await requireCoreFeature(context.core, ["integrateMemoryPages"],
          { code: "core_not_ready", message: "The loaded Core does not support page integration." })
          .integrateMemoryPages({ mode: "manual", paths, trigger: "manual_api", actor: "owner" });
        sendJson(response, 200, { request_id: requestIdValue, data });
      } catch (error) {
        await sendApiError(response, requestIdValue, error, `${method} ${pathname}`, context.core);
      }
    },
  },
  ...memoryOperationRoutes(),
  {
    method: "POST",
    path: `${API_PREFIX}/knowledge/ingest`,
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const command = commandEnvelope(await readRequestBody(request));
      const payload = validateIngestConversationPayload(command.payload);
      const result = await runCommand(context, pathname, command, 201, async () => {
        const data = await context.core.ingestConversation(payload.conversation_id);
        return { data: data as unknown as JsonObject, version: 0 };
      });
      sendJson(response, 201, result);
    },
  },
  {
    method: "POST",
    path: `${API_PREFIX}/memory/save-explicit`,
    async handle(route) {
      const { context, request, response, pathname, method } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      try {
        const payload = validateExplicitMemoryPayload(await readRequestBody(request));
        const path = await requireCoreFeature(context.core, ["rememberExplicit"],
          { code: "dependency_unavailable", message: "The loaded Core does not support memory saving." })
          .rememberExplicit(payload.text, payload.project_id);
        optionalCoreFeature(context.core, ["searchKnowledgeCompat", "notifyKnowledgeChanged"])?.notifyKnowledgeChanged();
        sendJson(response, 200, { path });
      } catch (error) {
        if (isObject(error) && error.code === "storage_unavailable") {
          error = new ApiError(503, "storage_unavailable", "The knowledge storage is unavailable.");
        }
        await sendApiError(response, requestIdValue, error, `${method} ${pathname}`, context.core);
      }
    },
  },
  {
    method: "POST",
    path: `${API_PREFIX}/librarian/run`,
    async handle(route) {
      const { context, request, response, pathname, method } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      try {
        const run = await curationFeature(context.core).runCuration({
          kind: "librarian",
          trigger: "manual_api",
          actor: "owner",
          actor_ref: requestIdValue,
        }) as { id: string; status: string; summary: unknown; report: unknown; error?: string | null };
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
    },
  },
  {
    method: "GET",
    path: `${API_PREFIX}/curation-runs`,
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const limit = url.searchParams.get("limit");
      if (limit !== null && limit !== "" && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) {
        throw new ApiError(400, "validation_error", "limitが不正です。1〜100の整数を指定してください。");
      }
      const cursor = nullableQuery(url.searchParams.get("cursor"));
      if (cursor !== null && cursor !== undefined && !isUlid(cursor)) {
        throw new ApiError(400, "validation_error", "cursorが不正です。26文字の大文字ULIDを指定してください。");
      }
      const data = curationFeature(context.core).listCurationRuns({
        ...(curationEnumQuery(url.searchParams.get("kind"), CURATION_KIND_VALUES, "kind") ? { kind: url.searchParams.get("kind")! } : {}),
        ...(curationEnumQuery(url.searchParams.get("status"), CURATION_STATUS_VALUES, "status") ? { status: url.searchParams.get("status")! } : {}),
        limit: limit ? Number(limit) : 20,
        ...(cursor ? { cursor } : {}),
      });
      sendJson(response, 200, { request_id: requestIdValue, data });
    },
  },
  {
    method: "GET",
    path: `${API_PREFIX}/curation-runs/{id}`,
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const id = pathId(route.params.id!, "curation_run_id");
      const run = curationFeature(context.core).getCurationRun(id);
      if (!run) throw new ApiError(404, "not_found", "整理実行記録が見つかりません。IDを確認してください。");
      sendJson(response, 200, { request_id: requestIdValue, data: run });
    },
  },
  {
    method: "GET",
    path: `${API_PREFIX}/knowledge`,
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const query = nullableQuery(url.searchParams.get("q"));
      const folder = nullableQuery(url.searchParams.get("folder"));
      const tagsParam = nullableQuery(url.searchParams.get("tags"));
      const tags = tagsParam ? tagsParam.split(",").map((t) => t.trim()) : [];
      const results = await withKnowledgeStorageAccess(context.core, "read", () => query
        ? context.knowledge.search(query, tags)
        : context.knowledge.list(folder ?? undefined));
      sendJson(response, 200, { request_id: requestIdValue, data: results });
    },
  },
  {
    method: "GET",
    path: `${API_PREFIX}/knowledge/{path+}`,
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const entryPath = decodeRouteValue(route.params.path!, "knowledge path");
      try {
        const entry = await withKnowledgeStorageAccess(context.core, "read", () => context.knowledge.get(entryPath));
        sendJson(response, 200, { request_id: requestIdValue, data: entry });
      } catch (error) {
        if (isKnowledgeStorageApiError(error)) throw error;
        throw new ApiError(404, "not_found", "指定されたナレッジエントリが見つかりません。");
      }
    },
  },
  {
    method: "POST",
    path: `${API_PREFIX}/knowledge`,
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
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
      const metadata = body.metadata === undefined ? undefined : knowledgeMetadataField(body.metadata);
      try {
        const entry = await withKnowledgeStorageAccess(context.core, "write", () => context.knowledge.create({ folder, filename, tags, body: entryBody, ...(metadata ? { metadata } : {}) }));
        optionalCoreFeature(context.core, ["searchKnowledgeCompat", "notifyKnowledgeChanged"])?.notifyKnowledgeChanged();
        sendJson(response, 201, { request_id: requestIdValue, data: entry });
      } catch (e) {
        if (isKnowledgeStorageApiError(e)) throw e;
        const rejected = rejectedPage(e);
        if (rejected) throw rejected;
        if (e instanceof Error && e.message.startsWith("already_exists")) {
          throw new ApiError(409, "version_conflict", "同名のナレッジエントリが既に存在します。");
        }
        if (e instanceof Error && e.message.startsWith("invalid_folder")) {
          throw new ApiError(400, "validation_error", "folderはglobal、projects、worksなどの有効なフォルダで始めてください。policiesは移行済みの読み取り専用です。");
        }
        throw e;
      }
    },
  },
  {
    method: "PUT",
    path: `${API_PREFIX}/knowledge/{path+}`,
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const entryPath = decodeRouteValue(route.params.path!, "knowledge path");
      if (entryPath.startsWith("policies/")) {
        throw new ApiError(400, "validation_error", "policiesは移行済みの読み取り専用のため、書き込みできません。");
      }
      const body = await readRequestBody(request);
      if (!isObject(body)) throw new ApiError(400, "validation_error", "リクエストボディが不正です。");
      const update: { tags?: string[]; body?: string } = {};
      if (body.tags !== undefined) {
        if (!Array.isArray(body.tags)) throw new ApiError(400, "validation_error", "tagsは文字列の配列で指定してください。");
        update.tags = (body.tags as unknown[]).filter((t): t is string => typeof t === "string");
      }
      if (body.body !== undefined) {
        if (typeof body.body !== "string") throw new ApiError(400, "validation_error", "bodyは文字列で指定してください。");
        update.body = body.body;
      }
      try {
        const entry = await withKnowledgeStorageAccess(context.core, "write", () => context.knowledge.update(entryPath, update));
        optionalCoreFeature(context.core, ["searchKnowledgeCompat", "notifyKnowledgeChanged"])?.notifyKnowledgeChanged();
        sendJson(response, 200, { request_id: requestIdValue, data: entry });
      } catch (error) {
        if (isKnowledgeStorageApiError(error)) throw error;
        const rejected = rejectedPage(error);
        if (rejected) throw rejected;
        throw new ApiError(404, "not_found", "指定されたナレッジエントリが見つかりません。");
      }
    },
  },
  {
    method: "DELETE",
    path: `${API_PREFIX}/knowledge/{path+}`,
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const entryPath = decodeRouteValue(route.params.path!, "knowledge path");
      if (entryPath.startsWith("policies/")) {
        throw new ApiError(400, "validation_error", "policiesは移行済みの読み取り専用のため、書き込みできません。");
      }
      try {
        await withKnowledgeStorageAccess(context.core, "write", () => context.knowledge.remove(entryPath));
        optionalCoreFeature(context.core, ["searchKnowledgeCompat", "notifyKnowledgeChanged"])?.notifyKnowledgeChanged();
        sendJson(response, 200, { request_id: requestIdValue, deleted: true });
      } catch (error) {
        if (isKnowledgeStorageApiError(error)) throw error;
        throw new ApiError(404, "not_found", "指定されたナレッジエントリが見つかりません。");
      }
    },
  },
];
