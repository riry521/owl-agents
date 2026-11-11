import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { requireAdapterFeature, requireCoreFeature } from "./core-feature.js";
import { ApiError } from "./errors.js";
import { ProjectsRouteMessages as M } from "./messages/routes-projects.js";
import {
  advisorRequestAgent,
  advisorWindowProject,
  commandEnvelope,
  exactKeys,
  isObject,
  nullableQuery,
  parseLimit,
  parseViewLimit,
  pathId,
  readRequestBody,
  requireOwner,
  runCommand,
  sendJson,
  stringField,
  validateEmptyPayload,
  windowScopeMismatch,
  type ApiRoute,
  type RequestContext,
  requestId,
  parseBacklogLimit,
  parseBacklogOffset,
  advisorWindowFeature,
  CHANNEL_PROVIDERS,
  channelCall,
  windowChannelError,
  projectNameOf,
  channelNameFromPayload,
  validateBacklogItemIds,
} from "./http-common.js";
import { browseProjectFolders, initializeExistingProjectFolder, initializeNewProjectFolder, inspectProjectFolder } from "./project-registration.js";
import type { JsonObject, UpdateProjectInput, CorePort, CreateProjectInput, DeleteProjectInput, Project, BacklogStatus, VerificationCommand } from "./types.js";
import { isUlid } from "./ids.js";
import { AUTO_WORK_SOURCES, AUTO_WORK_VERDICTS } from "@owl/shared/auto-work";
import { defaultChannelName } from "@owl/shared/advisor-window-settings";

function validateVerificationCommand(value: unknown, index: number): VerificationCommand {
  if (!isObject(value)) {
    throw new ApiError(400, "validation_error", M.planItemNotObject({ index }));
  }
  exactKeys(value, ["command_id", "argv", "cwd", "env_allowlist", "timeout_seconds", "stdout_limit", "stderr_limit", "expected_exit_codes", "executor"], `verification_plan[${index}]`);
  const command_id = stringField(value.command_id, `verification_plan[${index}].command_id`, 1, 200);
  if (!Array.isArray(value.argv) || value.argv.length < 1 || !value.argv.every((item) => typeof item === "string")) {
    throw new ApiError(400, "validation_error", M.planArgvInvalid({ index }));
  }
  const cwd = stringField(value.cwd, `verification_plan[${index}].cwd`, 1, 4096);
  if (!Array.isArray(value.env_allowlist) || !value.env_allowlist.every((item) => typeof item === "string")) {
    throw new ApiError(400, "validation_error", M.planEnvInvalid({ index }));
  }
  if (!Number.isInteger(value.timeout_seconds) || Number(value.timeout_seconds) <= 0) {
    throw new ApiError(400, "validation_error", M.planTimeoutInvalid({ index }));
  }
  if (!Number.isInteger(value.stdout_limit) || Number(value.stdout_limit) <= 0) {
    throw new ApiError(400, "validation_error", M.planStdoutInvalid({ index }));
  }
  if (!Number.isInteger(value.stderr_limit) || Number(value.stderr_limit) <= 0) {
    throw new ApiError(400, "validation_error", M.planStderrInvalid({ index }));
  }
  if (!Array.isArray(value.expected_exit_codes) || value.expected_exit_codes.length < 1 || !value.expected_exit_codes.every((item) => Number.isInteger(item))) {
    throw new ApiError(400, "validation_error", M.planExitCodesInvalid({ index }));
  }
  if (value.executor !== "core" && value.executor !== "reviewer") {
    throw new ApiError(400, "validation_error", M.planExecutorInvalid({ index }));
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
  exactKeys(payload, ["name", "canonical_path", "base_branch", "allowed_roots", "verification_plan"], "CreateProject payload", ["post_merge_command", "post_merge_install_command", "required_test_command", "test_run", "test_policy"]);
  const name = stringField(payload.name, "name", 1, 500);
  const canonical_path = stringField(payload.canonical_path, "canonical_path", 1, 4096);
  const base_branch = stringField(payload.base_branch, "base_branch", 1, 500);
  if (!Array.isArray(payload.allowed_roots) || payload.allowed_roots.length < 1 || !payload.allowed_roots.every((item) => typeof item === "string")) {
    throw new ApiError(400, "validation_error", M.allowedRootsInvalid());
  }
  if (!Array.isArray(payload.verification_plan)) {
    throw new ApiError(400, "validation_error", M.planNotArray());
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

function validateProjectFolderRequest(value: unknown): string {
  if (!isObject(value)) throw new ApiError(400, "validation_error", M.folderInfoInvalid());
  exactKeys(value, ["path"], "Project folder request");
  return stringField(value.path, "path", 1, 4096);
}

function validateProjectSetupPayload(payload: JsonObject): { mode: "existing" | "new" | "initialize_existing"; name: string; path: string } {
  exactKeys(payload, ["mode", "name", "path"], "Project setup payload");
  if (payload.mode !== "existing" && payload.mode !== "new" && payload.mode !== "initialize_existing") {
    throw new ApiError(400, "validation_error", M.registrationModeRequired());
  }
  const name = stringField(payload.name, "name", 1, 200).trim();
  if (!name) throw new ApiError(400, "validation_error", M.projectNameEmpty());
  if (payload.mode === "new" && (name === "." || name === ".." || /[\\/]/u.test(name))) {
    throw new ApiError(400, "validation_error", M.newFolderNameSlash());
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
      throw new ApiError(excludeProjectId ? 400 : 409, excludeProjectId ? "validation_error" : "project_path_conflict", M.folderAlreadyRegistered(), { canonical_path: canonicalPath, project_id: conflict.id });
    }
    cursor = page.cursor;
    if (!page.has_more) return;
  } while (cursor !== null);
}

function validateProjectUpdatePayload(payload: JsonObject): UpdateProjectInput {
  const allowed = ["name", "canonical_path", "auto_push", "advisor_window_enabled", "commit_language", "worktree_setup_command", "worktree_refresh_command", "post_merge_command", "post_merge_install_command", "required_test_command", "test_run", "test_policy", "report_check_commands", "screen_paths", "verification_plan"];
  const extra = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new ApiError(400, "validation_error", M.updatePayloadMismatch(), { missing: [], extra });
  }
  if (!allowed.some((key) => Object.prototype.hasOwnProperty.call(payload, key))) {
    throw new ApiError(400, "validation_error", M.updateNoFields());
  }
  const input: UpdateProjectInput = {};
  if (Object.prototype.hasOwnProperty.call(payload, "name")) {
    if (typeof payload.name !== "string") throw new ApiError(400, "validation_error", M.projectNameLength());
    const name = payload.name.trim();
    if (name.length < 1 || name.length > 200) throw new ApiError(400, "validation_error", M.projectNameLength());
    input.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "canonical_path")) {
    const canonicalPath = stringField(payload.canonical_path, "canonical_path", 1, 4096);
    if (!isAbsolute(canonicalPath)) throw new ApiError(400, "validation_error", M.pathNotAbsolute());
    input.canonical_path = canonicalPath;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "auto_push")) {
    if (typeof payload.auto_push !== "boolean") throw new ApiError(400, "validation_error", M.autoPushBoolean());
    input.auto_push = payload.auto_push;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "advisor_window_enabled")) {
    if (typeof payload.advisor_window_enabled !== "boolean") throw new ApiError(400, "validation_error", M.advisorWindowBoolean());
    input.advisor_window_enabled = payload.advisor_window_enabled;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "commit_language")) {
    if (payload.commit_language !== null && payload.commit_language !== "ja" && payload.commit_language !== "en") throw new ApiError(400, "validation_error", M.commitLanguageInvalid());
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
      throw new ApiError(400, "validation_error", M.planNotArray());
    }
    input.verification_plan =payload.verification_plan.map((item, index) => validateVerificationCommand(item, index));
  }
  return input;
}

/** Shape only; Core validates the settings themselves. */
function testRunField(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "validation_error", M.testRunObject(), { field: "test_run" });
  return value as Record<string, unknown>;
}

/** Shape only; Core validates the policy itself. */
function testPolicyField(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "validation_error", M.testPolicyObject(), { field: "test_policy" });
  return value as Record<string, unknown>;
}

/** Shape only; Core validates each command string. */
function reportCheckCommandsField(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new ApiError(400, "validation_error", M.reportCheckCommands(), { field: "report_check_commands" });
  return [...value];
}

/** Shape only; Core validates each pattern. */
function screenPathsField(value: unknown): { include: string[]; exclude?: string[] } | null {
  if (value === null) return null;
  const isStrings = (item: unknown): item is string[] => Array.isArray(item) && item.every((entry) => typeof entry === "string");
  const record = (typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  if (Object.keys(record).length === 0 || Object.keys(record).some((key) => key !== "include" && key !== "exclude") || !isStrings(record.include) || (record.exclude !== undefined && !isStrings(record.exclude))) {
    throw new ApiError(400, "validation_error", M.screenPathsInvalid(), { field: "screen_paths" });
  }
  return record.exclude === undefined ? { include: [...record.include] } : { include: [...record.include], exclude: [...record.exclude] };
}

function worktreeCommandField(value: unknown, field: string): string[] {
  const nonEmptyArgs = field === "post_merge_command" || field === "post_merge_install_command" || field === "required_test_command";
  const valid = Array.isArray(value)
    && value.length <= 64
    && value.every((arg) => typeof arg === "string" && arg.length <= 4096 && !arg.includes("\0"))
    && (value.length === 0 || (value[0] as string).trim().length > 0)
    && (!nonEmptyArgs || value.every((arg) => (arg as string).length > 0));
  if (!valid) throw new ApiError(400, "validation_error", M.commandInvalid(), { field });
  return [...(value as string[])];
}

function validateDeleteProjectPayload(payload: JsonObject): DeleteProjectInput {
  exactKeys(payload, ["confirmed_work_count"], "DeleteProject payload");
  if (!Number.isSafeInteger(payload.confirmed_work_count) || Number(payload.confirmed_work_count) < 0) {
    throw new ApiError(400, "validation_error", M.confirmedWorkCountInvalid());
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
  throw new ApiError(404, "project_not_found", M.projectNotFound(), { resource: "project", id: projectId });
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

/**
 * Creates and binds a channel for each running provider that has none yet. Failures never undo the window's ON;
 * they are returned per provider so the screen can show the reason.
 */
async function provisionWindowChannels(context: RequestContext, ownerId: string, key: string): Promise<JsonObject> {
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

function parseAutoWorkEventsQuery(url: URL): JsonObject {
  const oneOf = (name: string, allowed: readonly string[]) => {
    const value = url.searchParams.get(name);
    if (value === null) return {};
    if (!allowed.includes(value)) throw new ApiError(400, "validation_error", M.oneOfInvalid({ name, allowedJa: allowed.join("、"), allowedEn: allowed.join(", ") }), { field: name });
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

function validateUpdateAutoWorkSettingsPayload(payload: JsonObject): JsonObject {
  exactKeys(payload, [], "UpdateAutoWorkSettings payload", ["enabled", "projects"]);
  const toggle = (value: unknown, field: string) => {
    if (value !== null && typeof value !== "boolean") throw new ApiError(400, "validation_error", M.triStateInvalid({ field }), { field });
    return value;
  };
  const result: JsonObject = {};
  if (payload.enabled !== undefined) result.enabled = toggle(payload.enabled, "enabled") as boolean | null;
  if (payload.projects !== undefined) {
    if (!isObject(payload.projects)) throw new ApiError(400, "validation_error", M.projectsObject(), { field: "projects" });
    const projects: JsonObject = {};
    for (const [projectId, change] of Object.entries(payload.projects)) {
      pathId(projectId, "projects");
      if (!isObject(change)) throw new ApiError(400, "validation_error", M.projectsValueObject(), { field: "projects" });
      exactKeys(change, ["enabled"], "projects entry");
      projects[projectId] = { enabled: toggle(change.enabled, "projects.enabled") as boolean | null };
    }
    result.projects = projects;
  }
  return result;
}

function validateBacklogProjectId(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (!isUlid(value)) throw new ApiError(400, "validation_error", M.projectIdNotUlid(), { field: "project_id" });
  return value;
}

function validateBacklogStatus(value: string | null): BacklogStatus | undefined {
  if (value === null) return undefined;
  if (value !== "open" && value !== "in_progress" && value !== "done" && value !== "dismissed") {
    throw new ApiError(400, "validation_error", M.backlogStatusInvalid(), { field: "status" });
  }
  return value;
}

interface BacklogListQuery {
  status?: BacklogStatus;
  project_id?: string;
  work_id?: string;
  issued_work_id?: string;
  limit: number;
  offset: number;
}

function parseBacklogListQuery(url: URL): BacklogListQuery {
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

function validateDismissBacklogPayload(payload: JsonObject): { item_ids: string[] } {
  exactKeys(payload, ["item_ids"], "DismissBacklogItems payload");
  return { item_ids: validateBacklogItemIds(payload.item_ids) };
}

function validateIssueBacklogWorkPayload(payload: JsonObject): { item_ids: string[]; title: string; summary: string; size: "small" | "normal" | "large" } {
  exactKeys(payload, ["item_ids", "title", "summary", "size"], "IssueBacklogWork payload");
  const item_ids = validateBacklogItemIds(payload.item_ids);
  const title = stringField(payload.title, "title", 1, 500);
  const summary = stringField(payload.summary, "summary", 0, 20000);
  if (payload.size !== "small" && payload.size !== "normal" && payload.size !== "large") {
    throw new ApiError(400, "validation_error", M.sizeInvalid(), { field: "size" });
  }
  return { item_ids, title, summary, size: payload.size };
}


function validateOptionalFolderPath(value: string | null): string | undefined {
  if (value === null) return undefined;
  return stringField(value, "path", 1, 4096);
}

const AUTO_WORK_KEYS = ["getAutoWorkSettings", "updateAutoWorkSettings", "listAutoWorkEvents", "getAutoWorkEvent", "runAutoWorkNow"] as const;
const AUTO_WORK_UNAVAILABLE = { code: "core_not_ready", message: M.autoWorkUnsupported() } as const;
const BACKLOG_KEYS = ["listBacklogItems", "dismissBacklogItems", "deleteBacklogItems", "issueBacklogWork", "linkBacklogItems"] as const;
const BACKLOG_UNAVAILABLE = { code: "core_not_ready", message: M.backlogUnsupported() } as const;
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
      const data = requireAdapterFeature(context.core, ["listLinkableWorks"], { code: "dependency_unavailable", message: M.linkableWorksUnsupported() }).listLinkableWorks(
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
      const data = requireAdapterFeature(context.core, ["getBacklogListView"], { code: "dependency_unavailable", message: M.backlogScreenUnsupported() }).getBacklogListView(parseBacklogListQuery(url));
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
        if (error instanceof ApiError) throw error;
        throw new ApiError(400, "validation_error", M.folderListFailed(), {}, { cause: error });
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
        throw new ApiError(400, "validation_error", M.folderCheckFailed(), {}, { cause: error });
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
          if (!isAbsolute(payload.path)) throw new ApiError(400, "validation_error", M.newProjectPathInvalid());
          const parentPath = await realpath(payload.path).catch(() => {
            throw new ApiError(400, "validation_error", M.saveFolderMissing());
          });
          const targetPath = join(parentPath, payload.name);
          await assertProjectPathNotRegistered(context.core, targetPath);
          repository = await initializeNewProjectFolder(targetPath);
        } else {
          const inspection = await inspectProjectFolder(payload.path);
          if (inspection.kind === "missing" || inspection.kind === "not_directory") {
            throw new ApiError(400, "validation_error", M.chosenFolderMissing());
          }
          await assertProjectPathNotRegistered(context.core, inspection.canonical_path);
          if (payload.mode === "existing") {
            if (inspection.kind !== "git_ready") {
              throw new ApiError(409, "validation_error", M.noHistoryRegisterLater(), { inspection });
            }
            repository = { canonical_path: inspection.canonical_path, base_branch: inspection.base_branch };
          } else {
            try {
              repository = await initializeExistingProjectFolder(payload.path);
            } catch (error) {
              if (error instanceof ApiError) throw error;
              throw new ApiError(400, "validation_error", M.gitPrepareFailed(), {}, { cause: error });
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
      const api = requireCoreFeature(context.core, ["investigateProjectOverview"], { code: "dependency_unavailable", message: M.overviewUnsupported() });
      await requireRegisteredProject(context.core, projectId);
      try {
        sendJson(response, 202, { request_id: requestIdValue, data: await api.investigateProjectOverview({ project_id: projectId }) });
      } catch (error) {
        if (isObject(error) && error.code === "dependency_unavailable" && !(error instanceof ApiError)) {
          throw new ApiError(503, "dependency_unavailable", error instanceof Error ? error.message : M.overviewUnavailable(), isObject(error.details) ? error.details : {});
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
      const api = requireCoreFeature(context.core, ["investigateTestSetup", "testSetupRunState"], { code: "dependency_unavailable", message: M.testSetupUnsupported() });
      await requireRegisteredProject(context.core, projectId);
      const result = api.investigateTestSetup({ project_id: projectId });
      if (!result.started) throw new ApiError(409, "test_setup_unavailable", M.testSetupNotStarted({ reason: result.reason }), { reason: result.reason });
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
      const api = requireCoreFeature(context.core, ["investigateTestSetup", "testSetupRunState"], { code: "dependency_unavailable", message: M.testSetupUnsupported() });
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
            throw new ApiError(400, "validation_error", M.folderCheckFailed(), {}, { cause: error });
          });
          if (inspection.kind === "missing" || inspection.kind === "not_directory") {
            throw new ApiError(400, "validation_error", M.chosenFolderMissing());
          }
          if (inspection.kind !== "git_ready") {
            throw new ApiError(400, "validation_error", M.noHistoryChangeLater(), { inspection });
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
      if (event === null || event === undefined) throw new ApiError(404, "not_found", M.autoWorkEventNotFound());
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
      if (!isObject(body)) throw new ApiError(400, "validation_error", M.bodyNotObject());
      exactKeys(body, ["what"], "auto-work run");
      if (body.what !== "github" && body.what !== "scheduled_check") {
        throw new ApiError(400, "validation_error", M.whatInvalid(), { field: "what" });
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
