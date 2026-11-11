import { ApiError } from "./errors.js";
import { WorksRouteMessages as M } from "./messages/routes-works.js";
import { isUlid } from "./ids.js";
import { requireAdapterFeature, requireCoreFeature } from "./core-feature.js";
import { DESIGN_MOCK_FILE_PATTERN } from "@owl/shared/design-documents";
import type { JsonObject } from "./types.js";
import {
  advisorRequestAgent,
  advisorWindowProject,
  commandEnvelope,
  decisionWorkId,
  exactKeys,
  nullableQuery,
  parseBacklogLimit,
  parseBacklogOffset,
  parseBoolean,
  parseLimit,
  parseViewLimit,
  pathId,
  prerequisiteWorkIds,
  readRequestBody,
  requireOwner,
  runCommand,
  sendJson,
  stringField,
  validateCancelPayload,
  validateCreateWorkPayload,
  validateEmptyPayload,
  validateStartPayload,
  validateWorkInstructionPayload,
  windowScopeMismatch,
  workMarkdownCall,
  type ApiRoute,
  type RouteRequest,
  handleAttachmentUpload,
  HTTP_IDEMPOTENCY_KEY_PREFIX,
  type RequestContext,
  isObject,
  requestId,
  idempotencyLane,
  validateBacklogItemIds,
} from "./http-common.js";
import { API_PREFIX } from "./http-route-table.js";
import type { ServerResponse } from "node:http";

async function invalidateWorkCommandCache(context: RequestContext, workId: string, preserveKey: string): Promise<void> {
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

function parseArchived(value: string | null): "exclude" | "include" | "only" {
  if (value === null || value === "exclude" || value === "include" || value === "only") {
    return value ?? "exclude";
  }
  throw new ApiError(400, "invalid_query", M.archivedInvalid());
}

function validatePausePayload(payload: JsonObject): string {
  exactKeys(payload, ["reason"], "PauseWork payload");
  return stringField(payload.reason, "reason", 0, 1000);
}

/** ReopenWork payload: `reason` is optional, but when present must be a non-blank string. */
function validateReopenPayload(payload: JsonObject): string {
  const extra = Object.keys(payload).filter((key) => key !== "reason");
  if (extra.length > 0) {
    throw new ApiError(400, "validation_error", M.reopenPayloadMismatch(), { missing: [], extra });
  }
  if (payload.reason === undefined) return "";
  const reason = stringField(payload.reason, "reason", 1, 1000);
  if (reason.trim().length === 0) {
    throw new ApiError(400, "validation_error", M.reasonInvalid());
  }
  return reason;
}

const ANSWER_SOURCES = ["web", "slack", "discord"] as const;

type AnswerSource = (typeof ANSWER_SOURCES)[number];

function validateAnswerPayload(payload: JsonObject): { answer: string; option_key: string | null; source: AnswerSource; source_message_id: string | null } {
  exactKeys(payload, ["answer", "option_key", "source", "source_message_id"], "AnswerDecision payload");
  const answer = stringField(payload.answer, "answer", 1, 10000);
  const option_key = payload.option_key === null ? null : stringField(payload.option_key, "option_key", 1, 10000);
  if (typeof payload.source !== "string" || !ANSWER_SOURCES.includes(payload.source as AnswerSource)) {
    throw new ApiError(400, "validation_error", M.sourceInvalid(), { field: "source" });
  }
  const source = payload.source as AnswerSource;
  const source_message_id = payload.source_message_id === null ? null : stringField(payload.source_message_id, "source_message_id", 0, 10000);
  return { answer, option_key, source, source_message_id };
}

const PREREQUISITE_ERROR_STATUS: Readonly<Record<string, number>> = { task_not_found: 404, invalid_state_transition: 409 };

/** Core reports a refused resume with a domain code; give it its HTTP status. */
async function prerequisiteCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "";
    const status = Object.hasOwn(PREREQUISITE_ERROR_STATUS, code) ? PREREQUISITE_ERROR_STATUS[code] : undefined;
    if (status === undefined || error instanceof ApiError) throw error;
    // The text is relayed from the thrown Core error, so it is not a fixed sentence and stays a plain string.
    throw new ApiError(status, code as ApiError["code"], error instanceof Error ? error.message : code, isObject((error as { details?: unknown }).details) ? (error as { details: Record<string, unknown> }).details : {}, { cause: error });
  }
}

/** The mock is agent-written HTML: sandbox it into an opaque origin even when opened directly. */
const DESIGN_MOCK_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
};

function sendDesignMock(response: ServerResponse, html: string): void {
  response.writeHead(200, { ...DESIGN_MOCK_HEADERS, "content-length": Buffer.byteLength(html, "utf8") });
  response.end(html, "utf8");
}

function parseConversationLimit(value: string | null): number {
  if (value === null || value === "") return 100;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || parsed < 1 || parsed > 500) {
    throw new ApiError(400, "validation_error", M.limitInvalid500());
  }
  return parsed;
}

function validateLinkBacklogItemsPayload(payload: JsonObject): { item_ids: string[] } {
  exactKeys(payload, ["item_ids"], "LinkBacklogItems payload");
  return { item_ids: validateBacklogItemIds(payload.item_ids) };
}


const designMockFeature = (core: unknown) => requireCoreFeature(core,
  ["saveDesignMock", "deleteDesignMock", "listWorkDesignMocks", "readWorkDesignMock"],
  { code: "dependency_unavailable", message: M.designMocksUnsupported() });

const backlogFeature = (core: unknown) => requireAdapterFeature(core,
  ["listBacklogItems", "dismissBacklogItems", "deleteBacklogItems", "issueBacklogWork", "linkBacklogItems"],
  { code: "core_not_ready", message: M.backlogUnsupported() });

const WORK_ACTIONS = ["start", "pause", "resume", "cancel", "reopen", "archive", "unarchive"] as const;
type WorkAction = (typeof WORK_ACTIONS)[number];

/** Work の操作（start / pause / resume / cancel / reopen / archive / unarchive）の共有処理。 */
async function handleWorkAction(route: RouteRequest, action: WorkAction): Promise<void> {
  const { context, request, response, pathname } = route;
  requireOwner(request);
  const workId = pathId(route.params.work_id, "work_id");
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
}

const workActionRoute = (action: WorkAction): ApiRoute => ({
  method: "POST",
  path: `/api/v1/works/{work_id}/${action}`,
  handle: (route) => handleWorkAction(route, action),
});

/** PUT prerequisites と POST prerequisites/release の共有処理。 */
async function handleWorkPrerequisites(route: RouteRequest, release: boolean): Promise<void> {
  const { context, request, response } = route;
  requireOwner(request);
  const workId = pathId(route.params.work_id, "work_id");
  const command = commandEnvelope(await readRequestBody(request));
  const routeKey = release ? "work.prerequisites.release" : "work.prerequisites.replace";
  if (release) exactKeys(command.payload, [], "Work prerequisite release payload");
  else exactKeys(command.payload, ["prerequisite_work_ids"], "Work prerequisites payload");
  const ids = release ? [] : prerequisiteWorkIds(command.payload.prerequisite_work_ids);
  const result = await runCommand(context, routeKey, command, 200, async () => {
    const api = requireAdapterFeature(context.core, ["replaceWorkPrerequisites", "releaseWorkPrerequisiteWait"],
      { code: "dependency_unavailable", message: M.prerequisitesUnsupported() });
    const done = release ? await api.releaseWorkPrerequisiteWait(workId, command) : await api.replaceWorkPrerequisites(workId, { prerequisite_work_ids: ids }, command);
    await invalidateWorkCommandCache(context, workId, `${routeKey}:${command.idempotency_key}`);
    return { data: done.data, version: done.version };
  }, workId);
  sendJson(response, 200, result);
}

export const WORK_ENTRY_ROUTES: readonly ApiRoute[] = [
  {
    method: "GET",
    path: "/api/v1/works",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const result = await context.core.listWorks({
        state: nullableQuery(url.searchParams.get("state")),
        archived: parseArchived(url.searchParams.get("archived")),
        limit: parseLimit(url.searchParams.get("limit"), 50),
        cursor: nullableQuery(url.searchParams.get("cursor")),
      });
      sendJson(response, 200, { ...result, request_id: requestIdValue });
    },
  },
  {
    method: "POST",
    path: "/api/v1/works",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const advisorAgent = advisorRequestAgent(request, context.guardTokens);
      const body = await readRequestBody(request);
      const command = commandEnvelope(body);
      // A Project window's Advisor can only create Works in its own Project; an unset project_id means that Project.
      const windowProject = advisorWindowProject(context.core, advisorAgent);
      if (windowProject) {
        const requested = command.payload.project_id;
        if (requested !== undefined && requested !== null && requested !== windowProject.projectId) {
          throw windowScopeMismatch(windowProject.projectId, typeof requested === "string" ? requested : null);
        }
        command.payload = { ...command.payload, project_id: windowProject.projectId };
      }
      const payload = validateCreateWorkPayload(command.payload);
      const result = await runCommand(context, pathname, command, 201, async () => context.core.createWork(payload, command));
      sendJson(response, 201, result);
    },
  },
  {
    method: "GET",
    path: "/api/v1/works/{work_id}/view",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const workId = pathId(route.params.work_id, "work_id");
      const limit = url.searchParams.get("conversation_limit");
      const data = requireAdapterFeature(context.core, ["getWorkView"],
        { code: "dependency_unavailable", message: M.workDetailUnsupported() }).getWorkView(workId, {
        conversation_limit: limit === null || limit === "" ? undefined : parseConversationLimit(limit),
      });
      sendJson(response, 200, { request_id: requestIdValue, data, version: (data.work as { state_version: number }).state_version });
    },
  },
  {
    method: "GET",
    path: "/api/v1/works/{work_id}/designs",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const workId = pathId(route.params.work_id, "work_id");
      const data = await context.core.getWorkDesigns(workId);
      sendJson(response, 200, { request_id: requestIdValue, data });
    },
  },
  {
    method: "GET",
    path: "/api/v1/works/{work_id}/design-mocks",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const workId = pathId(route.params.work_id, "work_id");
      const data = await designMockFeature(context.core).listWorkDesignMocks(workId);
      sendJson(response, 200, { request_id: requestIdValue, data: data as unknown as JsonObject });
    },
  },
  {
    method: "GET",
    path: "/api/v1/works/{work_id}/design-mocks/{task_id}/{name}",
    async handle(route) {
      const { context, request, response } = route;
      requireOwner(request);
      const workId = pathId(route.params.work_id, "work_id");
      const taskId = pathId(route.params.task_id, "task_id");
      const notFoundMessage = M.designMockNotFound();
      const notFound = () => new ApiError(404, "design_mock_not_found", notFoundMessage);
      let name: string;
      try {
        name = decodeURIComponent(route.params.name!);
      } catch (error) {
        throw new ApiError(404, "design_mock_not_found", notFoundMessage, {}, { cause: error });
      }
      if (!DESIGN_MOCK_FILE_PATTERN.test(name)) throw notFound();
      const html = await designMockFeature(context.core).readWorkDesignMock(workId, taskId, name);
      if (html === null) throw notFound();
      sendDesignMock(response, html);
    },
  },
];

export const WORK_ROUTES: readonly ApiRoute[] = [
  {
    method: "GET",
    path: "/api/v1/works/{work_id}/markdown",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const workId = pathId(route.params.work_id, "work_id");
      const data = await workMarkdownCall(() => requireCoreFeature(context.core, ["readWorkMarkdown"],
        { code: "dependency_unavailable", message: M.workMarkdownUnsupported() }).readWorkMarkdown(workId, url.searchParams.get("path") ?? ""));
      sendJson(response, 200, { request_id: requestIdValue, data: data as unknown as JsonObject });
    },
  },
  {
    method: "GET",
    path: "/api/v1/works/{work_id}/conversation",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const workId = pathId(route.params.work_id, "work_id");
      const limit = parseConversationLimit(url.searchParams.get("limit"));
      const data = await requireAdapterFeature(context.core, ["getWorkConversation"],
        { code: "dependency_unavailable", message: M.conversationUnsupported() })
        .getWorkConversation(workId, { limit });
      sendJson(response, 200, { request_id: requestIdValue, data: data as unknown as JsonObject });
    },
  },
  {
    method: "GET",
    path: "/api/v1/works/{work_id}/assurance",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const workId = pathId(route.params.work_id, "work_id");
      const data = await requireAdapterFeature(context.core, ["getWorkAssurance"],
        { code: "dependency_unavailable", message: M.assuranceUnsupported() })
        .getWorkAssurance(workId);
      sendJson(response, 200, { request_id: requestIdValue, data: data as unknown as JsonObject });
    },
  },
  {
    method: "GET",
    path: "/api/v1/works/{work_id}/core-activity",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const workId = pathId(route.params.work_id, "work_id");
      const data = requireCoreFeature(context.core, ["getWorkCoreActivity"],
        { code: "dependency_unavailable", message: M.coreActivityUnsupported() }).getWorkCoreActivity(workId);
      sendJson(response, 200, { request_id: requestIdValue, data: data as unknown as JsonObject });
    },
  },
  {
    method: "GET",
    path: "/api/v1/works/{work_id}/summary-revisions",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const workId = pathId(route.params.work_id, "work_id");
      const rawLimit = url.searchParams.get("limit");
      if (rawLimit !== null && !/^\d+$/.test(rawLimit)) {
        throw new ApiError(400, "validation_error", M.limitNotPositive());
      }
      const data = requireCoreFeature(context.core, ["listWorkSummaryRevisions"],
        { code: "dependency_unavailable", message: M.summaryHistoryUnsupported() })
        .listWorkSummaryRevisions(workId, rawLimit === null ? {} : { limit: Number(rawLimit) });
      sendJson(response, 200, { request_id: requestIdValue, data: data as unknown as JsonObject });
    },
  },
  {
    method: "GET",
    path: "/api/v1/works/{work_id}/backlog",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const workId = pathId(route.params.work_id, "work_id");
      const result = backlogFeature(context.core).listBacklogItems({
        work_id: workId,
        limit: parseBacklogLimit(url.searchParams.get("limit")),
        offset: parseBacklogOffset(url.searchParams.get("offset")),
      });
      sendJson(response, 200, { request_id: requestIdValue, data: result.items, next_offset: result.next_offset });
    },
  },
  {
    method: "POST",
    path: "/api/v1/works/{work_id}/backlog/link",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const workId = pathId(route.params.work_id, "work_id");
      const command = commandEnvelope(await readRequestBody(request));
      const payload = validateLinkBacklogItemsPayload(command.payload);
      const result = await runCommand(context, pathname, command, 200, async () => {
        const linked = await backlogFeature(context.core).linkBacklogItems(workId, { ...command, payload });
        return { data: linked.data, version: linked.version };
      });
      sendJson(response, 200, result);
    },
  },
  {
    method: "GET",
    path: "/api/v1/works/{work_id}/designs/{task_id}",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const workId = pathId(route.params.work_id, "work_id");
      const taskId = pathId(route.params.task_id, "task_id");
      const data = await context.core.getWorkDesign(workId, taskId);
      if (data === null) throw new ApiError(404, "design_document_not_found", M.designDocumentNotFound());
      sendJson(response, 200, { request_id: requestIdValue, data });
    },
  },
  {
    method: "GET",
    path: "/api/v1/works/{work_id}",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const workId = pathId(route.params.work_id, "work_id");
      const data = await context.core.getWork(workId);
      sendJson(response, 200, { request_id: requestIdValue, data, version: data.state_version });
    },
  },
  {
    method: "POST",
    path: "/api/v1/works/{work_id}/project",
    async handle(route) {
      const { context, request, response } = route;
      requireOwner(request);
      const workId = pathId(route.params.work_id, "work_id");
      const command = commandEnvelope(await readRequestBody(request));
      exactKeys(command.payload, ["project_id"], "Work Project move payload");
      const projectId = stringField(command.payload.project_id, "project_id", 26, 26);
      if (!isUlid(projectId)) throw new ApiError(400, "validation_error", M.projectIdNotUlid(), { field: "project_id" });
      const routeKey = "work.project.move";
      const result = await runCommand(context, routeKey, command, 200, async () => {
        const moved = await requireAdapterFeature(context.core, ["moveWorkToProject"],
          { code: "dependency_unavailable", message: M.moveProjectUnsupported() })
          .moveWorkToProject(workId, { project_id: projectId }, command);
        await invalidateWorkCommandCache(context, workId, `${routeKey}:${command.idempotency_key}`);
        return { data: moved.data, version: moved.version };
      }, workId);
      sendJson(response, 200, result);
    },
  },
  {
    method: "PUT",
    path: "/api/v1/works/{work_id}/prerequisites",
    handle: (route) => handleWorkPrerequisites(route, false),
  },
  {
    method: "POST",
    path: "/api/v1/works/{work_id}/prerequisites/release",
    handle: (route) => handleWorkPrerequisites(route, true),
  },
  {
    method: "GET",
    path: "/api/v1/works/{work_id}/branch-status",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const workId = pathId(route.params.work_id, "work_id");
      const data = await context.core.getWorkBranchStatus(workId);
      sendJson(response, 200, { request_id: requestIdValue, data });
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/works/{work_id}",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const workId = pathId(route.params.work_id, "work_id");
      const command = commandEnvelope(await readRequestBody(request));
      validateEmptyPayload(command.payload);
      const result = await runCommand(context, pathname, command, 200, () => context.core.deleteWork(workId, command), workId);
      // Why not keep this request's own key: its row carries the Work id, so a resent DELETE answers 404 instead of replaying.
      await invalidateWorkCommandCache(context, workId, "");
      sendJson(response, 200, result);
    },
  },
  ...WORK_ACTIONS.map(workActionRoute),
  {
    method: "POST",
    path: "/api/v1/works/{work_id}/messages",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const workId = pathId(route.params.work_id, "work_id");
      const body = await readRequestBody(request);
      const command = commandEnvelope(body);
      const payload = validateWorkInstructionPayload(command.payload);
      const result = await runCommand(context, pathname, command, 202, async () => context.core.postWorkInstruction(workId, payload, command), workId);
      sendJson(response, 202, result);
    },
  },
  {
    method: "GET",
    path: "/api/v1/works/{work_id}/tasks",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const workId = pathId(route.params.work_id, "work_id");
      const result = await context.core.listTasks(workId, {
        status: nullableQuery(url.searchParams.get("status")),
        limit: parseLimit(url.searchParams.get("limit"), 50),
        cursor: nullableQuery(url.searchParams.get("cursor")),
      });
      sendJson(response, 200, { ...result, request_id: requestIdValue });
    },
  },
  {
    method: "GET",
    path: "/api/v1/tasks/{task_id}",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const taskId = pathId(route.params.task_id, "task_id");
      const result = await context.core.getTask(taskId, parseBoolean(url.searchParams.get("include_report"), false));
      sendJson(response, 200, { request_id: requestIdValue, data: result.data, report: result.report, version: result.version });
    },
  },
  {
    method: "POST",
    path: "/api/v1/tasks/{task_id}/prerequisite/resume",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const taskId = pathId(route.params.task_id, "task_id");
      const command = commandEnvelope(await readRequestBody(request));
      exactKeys(command.payload, [], "prerequisite resume payload", ["message"]);
      const message = command.payload.message === undefined || command.payload.message === null ? null : stringField(command.payload.message, "message", 0, 4000);
      const api = requireCoreFeature(context.core, ["resumePrerequisiteWait"],
        { code: "dependency_unavailable", message: M.resumePrerequisiteUnsupported() });
      const result = await runCommand(context, pathname, command, 200, () =>
        prerequisiteCall(() => api.resumePrerequisiteWait(taskId, { message, idempotencyKey: command.idempotency_key, actor: "owner" })),
      );
      sendJson(response, 200, result);
    },
  },
  {
    method: "GET",
    path: "/api/v1/decisions",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const status = url.searchParams.get("status");
      if (status !== "open" && status !== "resolved" && status !== "cancelled") {
        throw new ApiError(400, "invalid_query", M.statusInvalid());
      }
      const result = await context.core.listDecisions({
        status,
        limit: parseLimit(url.searchParams.get("limit"), 50),
        cursor: nullableQuery(url.searchParams.get("cursor")),
      });
      sendJson(response, 200, { ...result, request_id: requestIdValue });
    },
  },
  {
    method: "GET",
    path: "/api/v1/decisions/{decision_id}/view",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const decisionId = pathId(route.params.decision_id, "decision_id");
      const data = requireAdapterFeature(context.core, ["getDecisionView"],
        { code: "dependency_unavailable", message: M.decisionDetailUnsupported() }).getDecisionView(decisionId);
      sendJson(response, 200, { request_id: requestIdValue, data, version: (data.decision as { state_version: number }).state_version });
    },
  },
  {
    method: "GET",
    path: "/api/v1/board/view",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const archived = parseArchived(url.searchParams.get("archived"));
      if (archived === "include") throw new ApiError(400, "invalid_query", M.archivedExcludeOrOnly());
      const { boardWorks, max } = context.screenViewLimits;
      const data = requireAdapterFeature(context.core, ["getBoardView"],
        { code: "dependency_unavailable", message: M.boardUnsupported() }).getBoardView({
        archived,
        limit: parseViewLimit(url.searchParams.get("limit"), boardWorks, max),
        cursor: nullableQuery(url.searchParams.get("cursor")),
      });
      sendJson(response, 200, { request_id: requestIdValue, data, version: 1 });
    },
  },
  {
    method: "POST",
    path: "/api/v1/decisions/{decision_id}/answer",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const decisionId = pathId(route.params.decision_id, "decision_id");
      const command = commandEnvelope(await readRequestBody(request));
      const payload = validateAnswerPayload(command.payload);
      const result = await runCommand(context, pathname, command, 200, async () => context.core.answerDecision(decisionId, payload, command), decisionWorkId(context, decisionId));
      sendJson(response, 200, result);
    },
  },
  {
    method: "POST",
    path: "/api/v1/works/{work_id}/attachments",
    handle: (route) => handleAttachmentUpload(route, "works"),
  },
  {
    method: "GET",
    path: "/api/v1/works/{work_id}/artifacts",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const wid = pathId(route.params.work_id, "work_id");
      const rows = context.core.listArtifacts(wid);
      sendJson(response, 200, { request_id: requestIdValue, data: rows });
    },
  },
];
