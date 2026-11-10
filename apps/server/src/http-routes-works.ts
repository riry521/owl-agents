import { ApiError } from "./errors.js";
import { isUlid } from "./ids.js";
import { requireAdapterFeature, requireCoreFeature } from "./core-feature.js";
import { DESIGN_MOCK_FILE_PATTERN } from "../../../packages/shared/dist/design-documents.js";
import type { JsonObject } from "./types.js";
import {
  advisorRequestAgent,
  advisorWindowProject,
  commandEnvelope,
  decisionWorkId,
  exactKeys,
  invalidateWorkCommandCache,
  nullableQuery,
  parseArchived,
  parseBacklogLimit,
  parseBacklogOffset,
  parseBoolean,
  parseConversationLimit,
  parseLimit,
  parseViewLimit,
  pathId,
  prerequisiteCall,
  prerequisiteWorkIds,
  readRequestBody,
  requireOwner,
  runCommand,
  sendDesignMock,
  sendJson,
  stringField,
  validateAnswerPayload,
  validateCancelPayload,
  validateCreateWorkPayload,
  validateEmptyPayload,
  validateLinkBacklogItemsPayload,
  validatePausePayload,
  validateReopenPayload,
  validateStartPayload,
  validateWorkInstructionPayload,
  windowScopeMismatch,
  workMarkdownCall,
  type ApiRoute,
  type RouteRequest,
} from "./http-common.js";
import { handleAttachmentUpload } from "./http-routes-advisor.js";

const designMockFeature = (core: unknown) => requireCoreFeature(core,
  ["saveDesignMock", "deleteDesignMock", "listWorkDesignMocks", "readWorkDesignMock"],
  { code: "dependency_unavailable", message: "The loaded Core does not support design mocks." });

const backlogFeature = (core: unknown) => requireAdapterFeature(core,
  ["listBacklogItems", "dismissBacklogItems", "deleteBacklogItems", "issueBacklogWork", "linkBacklogItems"],
  { code: "core_not_ready", message: "The loaded Core does not support the Review Backlog API." });

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
      { code: "dependency_unavailable", message: "The loaded Core does not support Work prerequisites." });
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
        { code: "dependency_unavailable", message: "The loaded Core does not support the Work detail API." }).getWorkView(workId, {
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
      const notFound = () => new ApiError(404, "design_mock_not_found", "指定されたdesign mockが見つかりません。");
      let name: string;
      try {
        name = decodeURIComponent(route.params.name!);
      } catch (error) {
        throw new ApiError(404, "design_mock_not_found", notFound().message, {}, { cause: error });
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
        { code: "dependency_unavailable", message: "The loaded Core does not support reading Work Markdown." }).readWorkMarkdown(workId, url.searchParams.get("path") ?? ""));
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
        { code: "dependency_unavailable", message: "The loaded Core does not support work conversations." })
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
        { code: "dependency_unavailable", message: "The loaded Core does not support work assurance." })
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
        { code: "dependency_unavailable", message: "The loaded Core does not support work core activity." }).getWorkCoreActivity(workId);
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
        throw new ApiError(400, "validation_error", "limitが不正です。正の整数を指定してください。");
      }
      const data = requireCoreFeature(context.core, ["listWorkSummaryRevisions"],
        { code: "dependency_unavailable", message: "The loaded Core does not support work summary history." })
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
      if (data === null) throw new ApiError(404, "design_document_not_found", "指定されたTaskのdesign documentが見つかりません。");
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
      if (!isUlid(projectId)) throw new ApiError(400, "validation_error", "project_idはULIDで指定してください。", { field: "project_id" });
      const routeKey = "work.project.move";
      const result = await runCommand(context, routeKey, command, 200, async () => {
        const moved = await requireAdapterFeature(context.core, ["moveWorkToProject"],
          { code: "dependency_unavailable", message: "The loaded Core does not support moving a Work into a Project." })
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
        { code: "dependency_unavailable", message: "The loaded Core does not support resuming a prerequisite wait." });
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
        throw new ApiError(400, "invalid_query", "statusが不正です。open、resolved、cancelledのいずれかを指定してください。");
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
        { code: "dependency_unavailable", message: "The loaded Core does not support the Decision detail API." }).getDecisionView(decisionId);
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
      if (archived === "include") throw new ApiError(400, "invalid_query", "archivedはexcludeかonlyを指定してください。");
      const { boardWorks, max } = context.screenViewLimits;
      const data = requireAdapterFeature(context.core, ["getBoardView"],
        { code: "dependency_unavailable", message: "The loaded Core does not support the Board API." }).getBoardView({
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
