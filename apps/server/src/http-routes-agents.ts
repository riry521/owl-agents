import { isAbsolute } from "node:path";
import { designDocumentPath, isRuleRole } from "@owl/shared";
import { type ChildRunListFilter, CHILD_RUN_LIMITS, type ChildDispatchRequest, type ChildWaitRequest } from "@owl/shared/child-runs";
import { GUARD_SHELL_COMMAND_KEYS, GUARD_SHELL_TOOL_NAMES } from "@owl/shared/guard-inputs";
import { RESEARCH_CAPTURE_ROLES } from "@owl/shared/permission-args";
import { extractWebResearchCapture } from "@owl/shared/web-research";
import { optionalCoreFeature, requireCoreFeature } from "./core-feature.js";
import { ApiError } from "./errors.js";
import { AgentsRouteMessages as M } from "./messages/routes-agents.js";
import { isUlid } from "./ids.js";
import {
  childRunCall,
  childRunFeature,
  commandEnvelope,
  exactKeys,
  isObject,
  nullableQuery,
  parseLimit,
  pathId,
  readRequestBody,
  requireGuard,
  requireOwner,
  runCommand,
  sendJson,
  stringField,
  validateCancelPayload,
  type ApiRoute,
  type RequestContext,
  requestId,
} from "./http-common.js";
import type { IncomingMessage } from "node:http";
import { SUBAGENT_USAGE_BATCH_MAX, type HookRequestUsage } from "@owl/shared/token-relay";
import type { GuardTokenAgent } from "@owl/shared/guard-token";
import { DESIGN_MOCK_FILE_PATTERN } from "@owl/shared/design-documents";
import type { JsonObject } from "./types.js";

/** The request list of a subagent usage upload: 1 to SUBAGENT_USAGE_BATCH_MAX entries of ids and non-negative counts. */
function hookRequestUsages(value: unknown): HookRequestUsage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SUBAGENT_USAGE_BATCH_MAX) {
    throw new ApiError(400, "validation_error", M.usageRequestsCount({ max: SUBAGENT_USAGE_BATCH_MAX }));
  }
  const count = (item: JsonObject, key: string): number => {
    const number = item[key];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
      throw new ApiError(400, "validation_error", M.usageCountInvalid({ key }));
    }
    return number;
  };
  return value.map((item: unknown) => {
    if (!isObject(item)) throw new ApiError(400, "validation_error", M.usageItemNotObject());
    exactKeys(item, ["message_id", "model", "input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens", "created_at"], "requests item");
    const created_at = stringField(item.created_at, "requests.created_at", 1, 200);
    if (!Number.isFinite(Date.parse(created_at)) || !/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(created_at)) {
      throw new ApiError(400, "validation_error", M.usageCreatedAt());
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

/** Core reports design mock failures with a domain code; give them their HTTP status. */
async function designMockCall<T>(operation: () => Promise<T>): Promise<T> {
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
function requireDesignMockAgent(request: IncomingMessage, context: RequestContext): GuardTokenAgent {
  const denied = () => new ApiError(403, "agent_scope_denied", M.designMockGuardOnly());
  let agent: GuardTokenAgent | null;
  try {
    agent = requireGuard(request, context.guardTokens);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw new ApiError(403, "agent_scope_denied", M.designMockGuardOnly(), {}, { cause: error });
    throw error;
  }
  if (!agent || agent.role !== "designer") throw denied();
  return agent;
}

function designMockPayload(payload: JsonObject, keys: readonly string[]): { name: string; html: string } {
  exactKeys(payload, keys, "design mock payload");
  const { name, html } = payload;
  if (typeof name !== "string" || !DESIGN_MOCK_FILE_PATTERN.test(name)) {
    throw new ApiError(400, "validation_error", M.mockNameInvalid());
  }
  if (keys.includes("html") && (typeof html !== "string" || html.length === 0)) {
    throw new ApiError(400, "validation_error", M.mockHtmlEmpty());
  }
  return { name, html: typeof html === "string" ? html : "" };
}

/** Only a Worker's guard token may dispatch or wait; Core then checks the run is an active Worker. */
function requireChildRunAgent(request: IncomingMessage, context: RequestContext): GuardTokenAgent {
  let agent: GuardTokenAgent | null;
  try {
    agent = requireGuard(request, context.guardTokens);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw new ApiError(403, "agent_scope_denied", M.childRunGuardOnly(), {}, { cause: error });
    }
    throw error;
  }
  if (!agent) throw new ApiError(403, "agent_scope_denied", M.childRunGuardOnly());
  return agent;
}

function optionalField<T extends string>(value: unknown, label: string, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ApiError(400, "validation_error", M.optionInvalid({ label, allowedJa: allowed.join("、"), allowedEn: allowed.join(", ") }));
  }
  return value as T;
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ApiError(400, "validation_error", M.integerRange({ label, min, max }));
  }
  return value as number;
}

function dispatchRequest(payload: JsonObject): ChildDispatchRequest {
  exactKeys(payload, ["title", "instruction", "write_paths"], "dispatch payload", ["timeout_minutes"]);
  const writePaths = payload.write_paths;
  if (!Array.isArray(writePaths) || writePaths.length < 1 || writePaths.length > CHILD_RUN_LIMITS.write_paths_max) {
    throw new ApiError(400, "validation_error", M.writePathsInvalid({ max: CHILD_RUN_LIMITS.write_paths_max }));
  }
  return {
    title: stringField(payload.title, "title", 1, CHILD_RUN_LIMITS.title_max_chars),
    instruction: stringField(payload.instruction, "instruction", 1, CHILD_RUN_LIMITS.instruction_max_chars),
    write_paths: writePaths.map((path) => stringField(path, "write_paths[]", 1, 300)),
    ...(payload.timeout_minutes === undefined ? {} : { timeout_minutes: boundedInteger(payload.timeout_minutes, "timeout_minutes", 5, 1440) }),
  };
}

function waitRequest(payload: JsonObject): ChildWaitRequest {
  exactKeys(payload, ["child_ids"], "wait payload", ["return_when", "timeout_seconds"]);
  const ids = payload.child_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > CHILD_RUN_LIMITS.wait_max_ids) {
    throw new ApiError(400, "validation_error", M.childIdsInvalid({ max: CHILD_RUN_LIMITS.wait_max_ids }));
  }
  return {
    child_ids: ids.map((id) => stringField(id, "child_ids[]", 1, 64)),
    ...(payload.return_when === undefined ? {} : { return_when: optionalField(payload.return_when, "return_when", ["all", "any"] as const) }),
    ...(payload.timeout_seconds === undefined ? {} : { timeout_seconds: boundedInteger(payload.timeout_seconds, "timeout_seconds", 0, CHILD_RUN_LIMITS.wait_max_seconds) }),
  };
}


export const AGENT_ROUTES: readonly ApiRoute[] = [
  // ---- Child runs ------------------------------------------------------------

  {
    method: "POST",
    path: "/api/v1/agent/child-runs",
    async handle(route) {
      const { context, request, response } = route;
      const agent = requireChildRunAgent(request, context);
      const command = commandEnvelope(await readRequestBody(request));
      if (command.expected_version !== 0) {
        throw new ApiError(400, "validation_error", M.expectedVersionZero());
      }
      const payload = dispatchRequest(command.payload);
      const data = await childRunCall(() => childRunFeature(context.core).dispatchChildRun(agent.agent_run_id, payload, command.idempotency_key));
      sendJson(response, 200, { request_id: command.request_id, data });
    },
  },

  {
    method: "POST",
    path: "/api/v1/agent/design-mocks",
    async handle(route) {
      const { context, request, response } = route;
      const agent = requireDesignMockAgent(request, context);
      const command = commandEnvelope(await readRequestBody(request));
      if (command.expected_version !== 0) {
        throw new ApiError(400, "validation_error", M.expectedVersionZero());
      }
      const { name, html } = designMockPayload(command.payload, ["name", "html"]);
      const data = await designMockCall(() => requireCoreFeature(context.core, ["saveDesignMock", "deleteDesignMock", "listWorkDesignMocks", "readWorkDesignMock"],
        { code: "dependency_unavailable", message: M.designMocksUnsupported() }).saveDesignMock(agent.agent_run_id, name, html));
      sendJson(response, 200, { request_id: command.request_id, data });
    },
  },

  {
    method: "POST",
    path: "/api/v1/agent/design-mocks/delete",
    async handle(route) {
      const { context, request, response } = route;
      const agent = requireDesignMockAgent(request, context);
      const command = commandEnvelope(await readRequestBody(request));
      if (command.expected_version !== 0) {
        throw new ApiError(400, "validation_error", M.expectedVersionZero());
      }
      const { name } = designMockPayload(command.payload, ["name"]);
      const data = await designMockCall(() => requireCoreFeature(context.core, ["saveDesignMock", "deleteDesignMock", "listWorkDesignMocks", "readWorkDesignMock"],
        { code: "dependency_unavailable", message: M.designMocksUnsupported() }).deleteDesignMock(agent.agent_run_id, name));
      sendJson(response, 200, { request_id: command.request_id, data });
    },
  },

  {
    method: "POST",
    path: "/api/v1/agent/child-runs/wait",
    async handle(route) {
      const { context, request, response } = route;
      const agent = requireChildRunAgent(request, context);
      const command = commandEnvelope(await readRequestBody(request));
      if (command.expected_version !== 0) {
        throw new ApiError(400, "validation_error", M.expectedVersionZero());
      }
      const payload = waitRequest(command.payload);
      const abort = new AbortController();
      response.once("close", () => { if (!response.writableFinished) abort.abort(); });
      const data = await childRunCall(() => childRunFeature(context.core).waitChildRuns(agent.agent_run_id, payload, abort.signal));
      sendJson(response, 200, { request_id: command.request_id, data });
    },
  },

  {
    method: "GET",
    path: "/api/v1/child-runs",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const filter: ChildRunListFilter = {
        ...(url.searchParams.get("work_id") ? { work_id: url.searchParams.get("work_id") as string } : {}),
        ...(url.searchParams.get("task_id") ? { task_id: url.searchParams.get("task_id") as string } : {}),
        ...(url.searchParams.get("parent_agent_run_id") ? { parent_agent_run_id: url.searchParams.get("parent_agent_run_id") as string } : {}),
      };
      if (Object.keys(filter).length === 0) {
        throw new ApiError(400, "validation_error", M.scopeIdRequired());
      }
      const data = await childRunCall(() => childRunFeature(context.core).listChildRuns(filter));
      sendJson(response, 200, { request_id: requestIdValue, data });
    },
  },

  {
    method: "GET",
    path: "/api/v1/agents",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const workIdValue = nullableQuery(url.searchParams.get("work_id"));
      if (workIdValue !== null && !isUlid(workIdValue)) {
        throw new ApiError(400, "invalid_query", M.workIdInvalid());
      }
      const result = await context.core.listAgents({
        status: nullableQuery(url.searchParams.get("status")),
        work_id: workIdValue,
        limit: parseLimit(url.searchParams.get("limit"), 50),
        cursor: nullableQuery(url.searchParams.get("cursor")),
      });
      sendJson(response, 200, { ...result, request_id: requestIdValue });
    },
  },

  {
    method: "GET",
    path: "/api/v1/agents/view",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const recent = url.searchParams.get("recent");
      const recentLimit = recent === null || recent === "" ? undefined : Number(recent);
      if (recentLimit !== undefined && (!/^\d+$/.test(recent as string) || recentLimit > 200)) {
        throw new ApiError(400, "invalid_query", M.recentInvalid());
      }
      const data = requireCoreFeature(context.core, ["getAgentsView"],
        { code: "dependency_unavailable", message: M.agentsPageUnsupported() }).getAgentsView({ recent_limit: recentLimit });
      sendJson(response, 200, { request_id: requestIdValue, data, version: 1 });
    },
  },

  {
    method: "POST",
    path: "/api/v1/agents/{agent_run_id}/cancel",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const agentRunId = pathId(route.params.agent_run_id, "agent_run_id");
      const body = await readRequestBody(request);
      const command = commandEnvelope(body);
      const payload = validateCancelPayload(command.payload);
      const result = await runCommand(context, pathname, command, 200, async () => context.core.cancelAgent(agentRunId, payload.reason, payload.force, command));
      sendJson(response, 200, result);
    },
  },

  {
    method: "POST",
    path: "/api/v1/guard/check",
    async handle(route) {
      const { context, request, response } = route;
      const agent = requireGuard(request, context.guardTokens);
      const command = commandEnvelope(await readRequestBody(request));
      exactKeys(command.payload, ["role", "tool_name", "tool_input", "cwd"], "GuardCheck payload");
      const role = stringField(command.payload.role, "role", 1, 32);
      if (!isRuleRole(role)) {
        throw new ApiError(400, "guard_unparseable", M.roleInvalid());
      }
      if (agent && agent.role !== role) {
        throw new ApiError(403, "agent_scope_denied", M.roleMismatch());
      }
      const toolName = stringField(command.payload.tool_name, "tool_name", 1, 256);
      const toolInput = command.payload.tool_input;
      if (!isObject(toolInput)) throw new ApiError(400, "guard_unparseable", M.toolInputObject());
      const cwd = stringField(command.payload.cwd, "cwd", 1, 4096);
      if (!isAbsolute(cwd)) throw new ApiError(400, "guard_unparseable", M.cwdNotAbsolute());
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
      if (agent?.role === "reviewer" && GUARD_SHELL_TOOL_NAMES.has(toolName.toLowerCase())) {
        const shellCommand = GUARD_SHELL_COMMAND_KEYS.map((key) => toolInput[key]).find((value): value is string => typeof value === "string");
        if (shellCommand !== undefined) {
          const check = await requireCoreFeature(context.core, ["checkReviewerTestCommand"],
            { code: "dependency_unavailable", message: M.reviewerTestUnsupported() })
            .checkReviewerTestCommand({ agent_run_id: agent.agent_run_id, command: shellCommand });
          if (check.denied) {
            sendJson(response, 200, {
              request_id: command.request_id,
              data: { allowed: false, rule_id: "reviewer-test-command", scope: "role", message: check.message },
              version: command.expected_version,
            });
            return;
          }
        }
      }
      type TestSetupGuard = NonNullable<ReturnType<typeof optionalCoreFeature<"checkTestSetupTool", "recordTestSetupInstalls">>>;
      let setupGuard: TestSetupGuard | null = null;
      let setupCheck: Awaited<ReturnType<TestSetupGuard["checkTestSetupTool"]>> | null = null;
      if (agent) {
        // Optional: a Core without the check (a fake in a test) leaves every agent's decision as it was.
        setupGuard = optionalCoreFeature(context.core, ["checkTestSetupTool"], ["recordTestSetupInstalls"]);
        setupCheck = setupGuard === null ? null : await setupGuard.checkTestSetupTool({ agent_run_id: agent.agent_run_id, tool_name: toolName, tool_input: toolInput, cwd });
        if (setupCheck?.denied) {
          sendJson(response, 200, {
            request_id: command.request_id,
            data: { allowed: false, rule_id: "test-setup-install", scope: "role", message: setupCheck.message },
            version: command.expected_version,
          });
          return;
        }
      }
      if (agent?.role === "worker") {
        const screenCheck = await optionalCoreFeature(context.core, ["checkScreenPathWrite"])?.checkScreenPathWrite({ agent_run_id: agent.agent_run_id, tool_name: toolName, tool_input: toolInput, cwd });
        if (screenCheck?.denied) {
          sendJson(response, 200, {
            request_id: command.request_id,
            data: { allowed: false, rule_id: "screen-design-required", scope: "role", message: screenCheck.message },
            version: command.expected_version,
          });
          return;
        }
      }
      const result = context.ruleStore.checkGuard({
        role,
        toolName,
        toolInput: toolInput,
        cwd,
        home: process.env.HOME,
        ...(agent?.role === "designer" ? { designerWritePath } : {}),
      });
      if (agent && result.allowed && setupCheck?.denied === false && setupCheck.installs !== undefined && setupCheck.installs.length > 0) {
        setupGuard?.recordTestSetupInstalls?.(agent.agent_run_id, setupCheck.installs);
      }
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
            tool_input: toolInput,
            cwd,
            normalized_segments: result.normalized_segments,
          }).catch((error) => {
            console.warn(`[owl-server] Could not record skill reads for Agent run ${agent.agent_run_id}`, error);
          });
        } catch (error) {
          console.warn(`[owl-server] Could not record skill reads for Agent run ${agent.agent_run_id}`, error);
        }
      }
    },
  },

  {
    method: "POST",
    path: "/api/v1/research/capture",
    async handle(route) {
      const { context, request, response } = route;
      const agent = requireGuard(request, context.guardTokens);
      if (!agent || !RESEARCH_CAPTURE_ROLES.has(agent.role)) {
        throw new ApiError(403, "agent_scope_denied", M.researchGuardOnly());
      }
      const command = commandEnvelope(await readRequestBody(request));
      if (command.expected_version !== 0) {
        throw new ApiError(400, "validation_error", M.expectedVersionZero());
      }
      exactKeys(command.payload, ["tool_name", "tool_input", "tool_response"], "ResearchCapture payload", ["auth_form_detected"]);
      const authFormDetected = Object.prototype.hasOwnProperty.call(command.payload, "auth_form_detected");
      if (authFormDetected && command.payload.auth_form_detected !== true) {
        throw new ApiError(400, "validation_error", M.authFormTrue());
      }
      const toolName = stringField(command.payload.tool_name, "tool_name", 1, 64);
      if (toolName !== "WebFetch" && toolName !== "WebSearch") {
        throw new ApiError(400, "validation_error", M.toolNameInvalid());
      }
      if (!isObject(command.payload.tool_input)) {
        throw new ApiError(400, "validation_error", M.toolInputObject());
      }
      const extractedCapture = extractWebResearchCapture(toolName, command.payload.tool_input, command.payload.tool_response);
      const capture = extractedCapture && authFormDetected
        ? { ...extractedCapture, auth_form_detected: true as const }
        : extractedCapture;
      const result = capture === null
        ? { accepted: false, reason: "unsupported" }
        : await context.core.recordAgentResearch(agent, capture);
      sendJson(response, 202, { request_id: command.request_id, data: result });
    },
  },

  {
    method: "POST",
    path: "/api/v1/subagents/hook-event",
    async handle(route) {
      const { context, request, response } = route;
      const agent = requireGuard(request, context.guardTokens);
      if (!agent || agent.role !== "worker") {
        throw new ApiError(403, "agent_scope_denied", M.hookEventGuardOnly());
      }
      const command = commandEnvelope(await readRequestBody(request));
      if (command.expected_version !== 0) {
        throw new ApiError(400, "validation_error", M.expectedVersionZero());
      }
      exactKeys(command.payload, ["event", "agent_id"], "SubagentHookEvent payload", ["agent_type", "requests"]);
      const event = command.payload.event;
      if (event !== "start" && event !== "stop" && event !== "usage") {
        throw new ApiError(400, "validation_error", M.hookEventInvalid());
      }
      const agentId = stringField(command.payload.agent_id, "agent_id", 1, 200);
      const agentType = command.payload.agent_type === undefined ? null : stringField(command.payload.agent_type, "agent_type", 1, 200);
      if (event !== "usage" && command.payload.requests !== undefined) {
        throw new ApiError(400, "validation_error", M.requestsOnlyUsage());
      }
      const result = await requireCoreFeature(context.core, ["recordHookSubagent"],
        { code: "dependency_unavailable", message: M.hookSubagentUnsupported() }).recordHookSubagent(agent, event === "usage"
        ? { event, agentId, agentType, requests: hookRequestUsages(command.payload.requests) }
        : { event, agentId, agentType });
      sendJson(response, 202, { request_id: command.request_id, data: { accepted: result.agent_run_id !== null } });
    },
  },
];
