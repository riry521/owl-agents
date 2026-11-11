import { ApiError } from "./errors.js";
import { RoutesMemoryMessages } from "./messages/routes-memory.js";
import { isUlid } from "./ids.js";
import { optionalCoreFeature, requireAdapterFeature, requireCoreFeature } from "./core-feature.js";
import { API_PREFIX } from "./http-route-table.js";
import {
  commandEnvelope,
  decodeRouteValue,
  headerValue,
  isObject,
  nullableQuery,
  pathId,
  readRequestBody,
  requireGuard,
  requireOwner,
  runCommand,
  sendApiError,
  sendJson,
  stringField,
  type ApiRoute,
  type RequestContext,
  requestId,
  exactKeys,
  knowledgeStorageFeature,
  knowledgeStorageErrorCode,
} from "./http-common.js";
import { MEMORY_GET_OPERATIONS, MEMORY_OPERATIONS, memoryContext, runMemoryOperation } from "./http-memory.js";
import { validateMemoryPagesIntegratePayload } from "./http-memory-integrate.js";
import type { JsonObject, CorePort } from "./types.js";
import { PageRejectedError } from "@owl/core/dist/memory/page-format.js";

/** Flat frontmatter fields for POST /knowledge: strings (≤2,000 chars) or string arrays (≤50 items, ≤200 chars each). */
function knowledgeMetadataField(value: unknown): Record<string, string | string[]> {
  if (!isObject(value)) throw new ApiError(400, "validation_error", RoutesMemoryMessages.metadataNotObject());
  // No prototype: "__proto__" is a valid key and must be stored like any other.
  const result: Record<string, string | string[]> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][\w-]*$/u.test(key)) throw new ApiError(400, "validation_error", RoutesMemoryMessages.metadataKeyInvalid({ key }));
    if (key === "tags" || key === "created") throw new ApiError(400, "validation_error", RoutesMemoryMessages.metadataKeyReserved({ key }));
    if (typeof item === "string") {
      if (item.length > 2000) throw new ApiError(400, "validation_error", RoutesMemoryMessages.metadataValueTooLong({ key }));
    } else if (Array.isArray(item)) {
      if (item.length > 50 || item.some((entry) => typeof entry !== "string" || entry.length > 200)) {
        throw new ApiError(400, "validation_error", RoutesMemoryMessages.metadataArrayInvalid({ key }));
      }
    } else {
      throw new ApiError(400, "validation_error", RoutesMemoryMessages.metadataValueType({ key }));
    }
    result[key] = item;
  }
  if (typeof result.id === "string" ? !isUlid(result.id) : "id" in result) {
    throw new ApiError(400, "validation_error", RoutesMemoryMessages.metadataIdNotUlid());
  }
  return result;
}

function stringArrayField(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ApiError(400, "validation_error", RoutesMemoryMessages.stringArrayInvalid({ label }));
  }
  return value as string[];
}

function validateExplicitMemoryPayload(value: unknown): { text: string; tags: string[]; project_id: string | null } {
  if (!isObject(value)) {
    throw new ApiError(400, "validation_error", RoutesMemoryMessages.explicitNotObject());
  }
  const allowed = new Set(["text", "tags", "project_id"]);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (!Object.prototype.hasOwnProperty.call(value, "text") || extra.length > 0) {
    throw new ApiError(400, "validation_error", RoutesMemoryMessages.explicitFieldsMismatch(), {
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

function validateIngestConversationPayload(payload: JsonObject): { conversation_id: string } {
  exactKeys(payload, ["conversation_id"], "Knowledge ingestion payload");
  return { conversation_id: pathId(stringField(payload.conversation_id, "conversation_id", 1, 128), "conversation_id") };
}

/** A page that does not fit the four templates: 422 with the validatePage errors; nothing was written. */
function rejectedPage(error: unknown): ApiError | null {
  return error instanceof PageRejectedError
    ? new ApiError(422, "validation_error", RoutesMemoryMessages.pageTemplateMismatch(), { errors: error.errors })
    : null;
}

function isKnowledgeStorageApiError(error: unknown): boolean {
  const code = knowledgeStorageErrorCode(error);
  return code === "knowledge_storage_unavailable" || code === "knowledge_storage_moving";
}

async function withKnowledgeStorageAccess<T>(core: CorePort, kind: "read" | "write", operation: () => Promise<T>): Promise<T> {
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

const CURATION_KIND_VALUES = ["librarian", "skill_curation", "rule_curation"];

const CURATION_STATUS_VALUES = ["running", "succeeded", "failed"];

function curationEnumQuery(value: string | null, allowed: string[], name: string): string | undefined {
  if (value === null || value === "") return undefined;
  if (!allowed.includes(value)) {
    throw new ApiError(400, "validation_error", RoutesMemoryMessages.enumQueryInvalid({ name, allowed: allowed.join("、") }));
  }
  return value;
}


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
  { code: "core_not_ready", message: RoutesMemoryMessages.curationUnsupported() });

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
          { code: "core_not_ready", message: RoutesMemoryMessages.backlogUnsupported() }).memoryPendingStats();
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
          { code: "core_not_ready", message: RoutesMemoryMessages.integrationUnsupported() })
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
          { code: "dependency_unavailable", message: RoutesMemoryMessages.memorySavingUnsupported() })
          .rememberExplicit(payload.text, payload.project_id);
        optionalCoreFeature(context.core, ["searchKnowledgeCompat", "notifyKnowledgeChanged"])?.notifyKnowledgeChanged();
        sendJson(response, 200, { path });
      } catch (error) {
        if (isObject(error) && error.code === "storage_unavailable") {
          error = new ApiError(503, "storage_unavailable", RoutesMemoryMessages.storageUnavailable());
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
          throw new ApiError(500, "curation_failed", run.error ?? RoutesMemoryMessages.librarianFailed(), { run_id: run.id });
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
        throw new ApiError(400, "validation_error", RoutesMemoryMessages.limit100());
      }
      const cursor = nullableQuery(url.searchParams.get("cursor"));
      if (cursor !== null && cursor !== undefined && !isUlid(cursor)) {
        throw new ApiError(400, "validation_error", RoutesMemoryMessages.cursorInvalid());
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
      if (!run) throw new ApiError(404, "not_found", RoutesMemoryMessages.curationRunNotFound());
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
        throw new ApiError(404, "not_found", RoutesMemoryMessages.entryNotFound());
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
      if (!isObject(body)) throw new ApiError(400, "validation_error", RoutesMemoryMessages.bodyInvalid());
      const folder = stringField(body.folder as string, "folder", 1, 200);
      if (folder.split("/")[0] === "policies") {
        throw new ApiError(400, "validation_error", RoutesMemoryMessages.policiesReadOnly());
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
          throw new ApiError(409, "version_conflict", RoutesMemoryMessages.entryExists());
        }
        if (e instanceof Error && e.message.startsWith("invalid_folder")) {
          throw new ApiError(400, "validation_error", RoutesMemoryMessages.folderInvalid());
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
        throw new ApiError(400, "validation_error", RoutesMemoryMessages.policiesReadOnly());
      }
      const body = await readRequestBody(request);
      if (!isObject(body)) throw new ApiError(400, "validation_error", RoutesMemoryMessages.bodyInvalid());
      const update: { tags?: string[]; body?: string } = {};
      if (body.tags !== undefined) {
        if (!Array.isArray(body.tags)) throw new ApiError(400, "validation_error", RoutesMemoryMessages.tagsNotArray());
        update.tags = (body.tags as unknown[]).filter((t): t is string => typeof t === "string");
      }
      if (body.body !== undefined) {
        if (typeof body.body !== "string") throw new ApiError(400, "validation_error", RoutesMemoryMessages.bodyNotString());
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
        throw new ApiError(404, "not_found", RoutesMemoryMessages.entryNotFound());
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
        throw new ApiError(400, "validation_error", RoutesMemoryMessages.policiesReadOnly());
      }
      try {
        await withKnowledgeStorageAccess(context.core, "write", () => context.knowledge.remove(entryPath));
        optionalCoreFeature(context.core, ["searchKnowledgeCompat", "notifyKnowledgeChanged"])?.notifyKnowledgeChanged();
        sendJson(response, 200, { request_id: requestIdValue, deleted: true });
      } catch (error) {
        if (isKnowledgeStorageApiError(error)) throw error;
        throw new ApiError(404, "not_found", RoutesMemoryMessages.entryNotFound());
      }
    },
  },
];
