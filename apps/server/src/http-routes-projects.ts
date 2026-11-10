import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { requireAdapterFeature, requireCoreFeature } from "./core-feature.js";
import { ApiError } from "./errors.js";
import {
  advisorRequestAgent, advisorWindowProject, assertProjectPathNotRegistered, commandEnvelope, exactKeys, isObject, nullableQuery,
  parseAutoWorkEventsQuery, parseBacklogListQuery, parseLimit, parseViewLimit, pathId, projectCreatePayload, provisionWindowChannels,
  readRequestBody, requireOwner, requireRegisteredProject, runCommand, sendJson, stringField, validateBacklogProjectId,
  validateCreateProjectPayload, validateDeleteProjectPayload, validateDismissBacklogPayload, validateEmptyPayload,
  validateIssueBacklogWorkPayload, validateProjectFolderRequest, validateProjectSetupPayload, validateProjectUpdatePayload,
  validateUpdateAutoWorkSettingsPayload, windowScopeMismatch,
  type ApiRoute,
} from "./http-common.js";
import { browseProjectFolders, initializeExistingProjectFolder, initializeNewProjectFolder, inspectProjectFolder } from "./project-registration.js";
import type { JsonObject, UpdateProjectInput } from "./types.js";

function validateOptionalFolderPath(value: string | null): string | undefined {
  if (value === null) return undefined;
  return stringField(value, "path", 1, 4096);
}

const AUTO_WORK_KEYS = ["getAutoWorkSettings", "updateAutoWorkSettings", "listAutoWorkEvents", "getAutoWorkEvent", "runAutoWorkNow"] as const;
const AUTO_WORK_UNAVAILABLE = { code: "core_not_ready", message: "The loaded Core does not support the automatic Work API." } as const;
const BACKLOG_KEYS = ["listBacklogItems", "dismissBacklogItems", "deleteBacklogItems", "issueBacklogWork", "linkBacklogItems"] as const;
const BACKLOG_UNAVAILABLE = { code: "core_not_ready", message: "The loaded Core does not support the Review Backlog API." } as const;
const autoWorkFeature = (core: unknown) => requireAdapterFeature(core, AUTO_WORK_KEYS, AUTO_WORK_UNAVAILABLE);
const backlogFeature = (core: unknown) => requireAdapterFeature(core, BACKLOG_KEYS, BACKLOG_UNAVAILABLE);

export const PROJECT_ROUTES: readonly ApiRoute[] = [
  {
    method: "GET",
    path: "/api/v1/backlog/linkable-works",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const { linkableWorks, max } = context.screenViewLimits;
      const data = requireAdapterFeature(context.core, ["listLinkableWorks"], { code: "dependency_unavailable", message: "The loaded Core does not support the linkable Works API." }).listLinkableWorks(
        validateBacklogProjectId(url.searchParams.get("project_id")) ?? null,
        { limit: parseViewLimit(url.searchParams.get("limit"), linkableWorks, max), cursor: nullableQuery(url.searchParams.get("cursor")) },
      );
      sendJson(response, 200, { request_id: requestIdValue, data, version: 1 });
    },
  },
  {
    method: "GET",
    path: "/api/v1/backlog/view",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const data = requireAdapterFeature(context.core, ["getBacklogListView"], { code: "dependency_unavailable", message: "The loaded Core does not support the Backlog screen API." }).getBacklogListView(parseBacklogListQuery(url));
      sendJson(response, 200, { request_id: requestIdValue, data, version: 1 });
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const result = await context.core.listProjects({
        limit: parseLimit(url.searchParams.get("limit"), 50),
        cursor: nullableQuery(url.searchParams.get("cursor")),
      });
      sendJson(response, 200, { ...result, request_id: requestIdValue });
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/folders",
    async handle(route) {
      const { request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const path = validateOptionalFolderPath(url.searchParams.get("path"));
      const browser = await browseProjectFolders(path).catch((error: unknown) => {
        throw new ApiError(400, "validation_error", error instanceof Error ? error.message : "フォルダを表示できませんでした。");
      });
      sendJson(response, 200, { request_id: requestIdValue, data: browser });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/inspect",
    async handle(route) {
      const { request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const path = validateProjectFolderRequest(await readRequestBody(request));
      const inspection = await inspectProjectFolder(path).catch((error: unknown) => {
        if (error instanceof ApiError) throw error;
        throw new ApiError(400, "validation_error", error instanceof Error ? error.message : "このフォルダを確認できませんでした。");
      });
      sendJson(response, 200, { request_id: requestIdValue, data: inspection });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/setup",
    async handle(route) {
      const { context, request, response, pathname } = route;
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
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const body = await readRequestBody(request);
      const command = commandEnvelope(body);
      const payload = validateCreateProjectPayload(command.payload);
      const result = await runCommand(context, pathname, command, 201, async () => {
        const created = await context.core.createProject(payload, command);
        return { data: created.data as unknown as JsonObject, version: created.version };
      });
      sendJson(response, 201, result);
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/{project_id}/deletion-impact",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const projectId = pathId(route.params.project_id!, "project_id");
      const impact = await context.core.getProjectDeletionImpact(projectId);
      sendJson(response, 200, { request_id: requestIdValue, data: impact });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/{project_id}/overview/investigate",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const projectId = pathId(route.params.project_id!, "project_id");
      const api = requireCoreFeature(context.core, ["investigateProjectOverview"], { code: "dependency_unavailable", message: "The loaded Core does not support project overview investigation." });
      await requireRegisteredProject(context.core, projectId);
      try {
        sendJson(response, 202, { request_id: requestIdValue, data: await api.investigateProjectOverview({ project_id: projectId }) });
      } catch (error) {
        if (isObject(error) && error.code === "dependency_unavailable" && !(error instanceof ApiError)) {
          throw new ApiError(503, "dependency_unavailable", error instanceof Error ? error.message : "Project overview investigation is unavailable.", isObject(error.details) ? error.details : {});
        }
        throw error;
      }
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/{project_id}/test-setup/investigate",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const projectId = pathId(route.params.project_id!, "project_id");
      const api = requireCoreFeature(context.core, ["investigateTestSetup", "testSetupRunState"], { code: "dependency_unavailable", message: "The loaded Core does not support test setup investigation." });
      await requireRegisteredProject(context.core, projectId);
      const result = api.investigateTestSetup({ project_id: projectId });
      if (!result.started) throw new ApiError(409, "test_setup_unavailable", `Test setup investigation did not start: ${result.reason}.`, { reason: result.reason });
      sendJson(response, 202, { request_id: requestIdValue, data: { project_id: projectId, trigger: result.trigger, accepted: true } });
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/{project_id}/test-setup/investigation",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const projectId = pathId(route.params.project_id!, "project_id");
      const api = requireCoreFeature(context.core, ["investigateTestSetup", "testSetupRunState"], { code: "dependency_unavailable", message: "The loaded Core does not support test setup investigation." });
      await requireRegisteredProject(context.core, projectId);
      const state = api.testSetupRunState({ project_id: projectId });
      sendJson(response, 200, { request_id: requestIdValue, data: { project_id: projectId, running: state?.running ?? false, outcome: state && !state.running ? state.outcome : null } });
    },
  },
  {
    method: "PATCH",
    path: "/api/v1/projects/{project_id}",
    async handle(route) {
      const { context, request, response, pathname } = route;
      const ownerId = requireOwner(request);
      const projectId = pathId(route.params.project_id!, "project_id");
      const command = commandEnvelope(await readRequestBody(request));
      const input = validateProjectUpdatePayload(command.payload);
      const result = await runCommand(context, pathname, command, 200, async () => {
        const current = await requireRegisteredProject(context.core, projectId);
        const update: UpdateProjectInput = {};
        if (input.name !== undefined) update.name = input.name;
        if (input.auto_push !== undefined) update.auto_push = input.auto_push;
        if (input.advisor_window_enabled !== undefined) update.advisor_window_enabled = input.advisor_window_enabled;
        if (input.commit_language !== undefined) update.commit_language = input.commit_language;
        if (input.worktree_setup_command !== undefined) update.worktree_setup_command = input.worktree_setup_command;
        if (input.worktree_refresh_command !== undefined) update.worktree_refresh_command = input.worktree_refresh_command;
        if (input.post_merge_command !== undefined) update.post_merge_command = input.post_merge_command;
        if (input.post_merge_install_command !== undefined) update.post_merge_install_command = input.post_merge_install_command;
        if (input.required_test_command !== undefined) update.required_test_command = input.required_test_command;
        if (input.test_run !== undefined) update.test_run = input.test_run;
        if (input.test_policy !== undefined) update.test_policy = input.test_policy;
        if (input.verification_plan !== undefined) update.verification_plan = input.verification_plan;
        if (input.screen_paths !== undefined) update.screen_paths = input.screen_paths;
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
        const data = updated.data as unknown as JsonObject;
        if (input.advisor_window_enabled === true) data.window_channels = await provisionWindowChannels(context, ownerId, projectId);
        return { data, version: updated.version };
      });
      sendJson(response, 200, result);
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/projects/{project_id}",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const projectId = pathId(route.params.project_id!, "project_id");
      const command = commandEnvelope(await readRequestBody(request));
      const input = validateDeleteProjectPayload(command.payload);
      const result = await runCommand(context, pathname, command, 200, async () => {
        const deleted = await context.core.deleteProject(projectId, input, command);
        return { data: deleted.data as unknown as JsonObject, version: deleted.version };
      });
      sendJson(response, 200, result);
    },
  },
  // ---- Automatic Work creation ----
  {
    method: "GET",
    path: "/api/v1/auto-work/settings",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const { version, data } = autoWorkFeature(context.core).getAutoWorkSettings();
      sendJson(response, 200, { request_id: requestIdValue, data, version });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/auto-work/settings",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const command = commandEnvelope(await readRequestBody(request));
      const payload = validateUpdateAutoWorkSettingsPayload(command.payload);
      const result = await runCommand(context, pathname, command, 200, async () => {
        const updated = await autoWorkFeature(context.core).updateAutoWorkSettings({ ...command, payload });
        return { data: updated.data, version: updated.version };
      });
      sendJson(response, 200, result);
    },
  },
  {
    method: "GET",
    path: "/api/v1/auto-work/events",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const result = autoWorkFeature(context.core).listAutoWorkEvents(parseAutoWorkEventsQuery(url));
      sendJson(response, 200, { request_id: requestIdValue, data: { items: result.items, next_offset: result.next_offset } });
    },
  },
  {
    method: "GET",
    path: "/api/v1/auto-work/events/{id}",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const event = autoWorkFeature(context.core).getAutoWorkEvent(pathId(route.params.id!, "event_id"));
      if (event === null || event === undefined) throw new ApiError(404, "not_found", "The automatic Work history entry was not found.");
      sendJson(response, 200, { request_id: requestIdValue, data: event as JsonObject });
    },
  },
  {
    method: "POST",
    path: "/api/v1/auto-work/projects/{id}/run",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const projectId = pathId(route.params.id!, "project_id");
      const body = await readRequestBody(request);
      if (!isObject(body)) throw new ApiError(400, "validation_error", "リクエスト本文はJSON objectで指定してください。");
      exactKeys(body, ["what"], "auto-work run");
      if (body.what !== "github" && body.what !== "scheduled_check") {
        throw new ApiError(400, "validation_error", "whatはgithubまたはscheduled_checkを指定してください。", { field: "what" });
      }
      try {
        const result = await autoWorkFeature(context.core).runAutoWorkNow(projectId, body.what);
        sendJson(response, 200, { request_id: requestIdValue, data: result as JsonObject });
      } catch (error) {
        // The design names this refusal invalid_state; Core's own name for it is shared with every other state refusal.
        if (error instanceof ApiError && error.code === "invalid_state_transition") throw new ApiError(409, "invalid_state", error.message, error.details, { cause: error });
        throw error;
      }
    },
  },
  // ---- Review backlog ----
  {
    method: "GET",
    path: "/api/v1/backlog",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const result = backlogFeature(context.core).listBacklogItems(parseBacklogListQuery(url));
      sendJson(response, 200, { request_id: requestIdValue, data: result.items, next_offset: result.next_offset });
    },
  },
  {
    method: "POST",
    path: "/api/v1/backlog/dismiss",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const command = commandEnvelope(await readRequestBody(request));
      const payload = validateDismissBacklogPayload(command.payload);
      const result = await runCommand(context, pathname, command, 200, async () => {
        const dismissed = await backlogFeature(context.core).dismissBacklogItems({ ...command, payload });
        return { data: dismissed.data, version: dismissed.version };
      });
      sendJson(response, 200, result);
    },
  },
  {
    method: "POST",
    path: "/api/v1/backlog/delete",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const command = commandEnvelope(await readRequestBody(request));
      const payload = validateDismissBacklogPayload(command.payload);
      const result = await runCommand(context, pathname, command, 200, async () => {
        const deleted = await backlogFeature(context.core).deleteBacklogItems({ ...command, payload });
        return { data: deleted.data, version: deleted.version };
      });
      sendJson(response, 200, result);
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/backlog/{item_id}",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const itemId = pathId(route.params.item_id!, "item_id");
      const command = commandEnvelope(await readRequestBody(request));
      validateEmptyPayload(command.payload);
      const result = await runCommand(context, pathname, command, 200, async () => {
        const deleted = await backlogFeature(context.core).deleteBacklogItems({ ...command, payload: { item_ids: [itemId] } });
        return { data: deleted.data, version: deleted.version };
      });
      sendJson(response, 200, result);
    },
  },
  {
    method: "POST",
    path: "/api/v1/auto-work/notices",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const command = commandEnvelope(await readRequestBody(request));
      const result = await runCommand(context, pathname, command, 201, async () => {
        const received = await requireAdapterFeature(context.core, ["receiveAutoWorkNotice"], AUTO_WORK_UNAVAILABLE).receiveAutoWorkNotice(command);
        return { data: received.data, version: received.version };
      });
      sendJson(response, 201, result);
    },
  },
  {
    method: "POST",
    path: "/api/v1/backlog/issue-work",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const command = commandEnvelope(await readRequestBody(request));
      const payload = validateIssueBacklogWorkPayload(command.payload);
      const advisorAgent = advisorRequestAgent(request, context.guardTokens);
      const windowProject = advisorWindowProject(context.core, advisorAgent);
      const foreign = windowProject?.port.backlogItemProjects(payload.item_ids).find((item) => item.project_id !== windowProject.projectId);
      if (windowProject && foreign) throw windowScopeMismatch(windowProject.projectId, foreign.project_id);
      const result = await runCommand(context, pathname, command, 201, async () => {
        const issued = await backlogFeature(context.core).issueBacklogWork({ ...command, payload });
        return { data: issued.data, version: issued.version };
      });
      sendJson(response, 201, result);
    },
  },
];
