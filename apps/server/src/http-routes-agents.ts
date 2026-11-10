import { isAbsolute } from "node:path";

import { designDocumentPath, isRuleRole } from "../../../packages/shared/dist/index.js";
import type { ChildRunListFilter } from "../../../packages/shared/dist/child-runs.js";
import { GUARD_SHELL_COMMAND_KEYS, GUARD_SHELL_TOOL_NAMES } from "../../../packages/shared/dist/guard-inputs.js";
import { RESEARCH_CAPTURE_ROLES } from "../../../packages/shared/dist/permission-args.js";
import { extractWebResearchCapture } from "../../../packages/shared/dist/web-research.js";
import { optionalCoreFeature, requireCoreFeature } from "./core-feature.js";
import { ApiError } from "./errors.js";
import { isUlid } from "./ids.js";
import {
  childRunCall,
  childRunFeature,
  commandEnvelope,
  designMockCall,
  designMockPayload,
  dispatchRequest,
  exactKeys,
  hookRequestUsages,
  isObject,
  nullableQuery,
  parseLimit,
  pathId,
  readRequestBody,
  requireChildRunAgent,
  requireDesignMockAgent,
  requireGuard,
  requireOwner,
  runCommand,
  sendJson,
  stringField,
  validateCancelPayload,
  waitRequest,
  type ApiRoute,
} from "./http-common.js";

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
        throw new ApiError(400, "validation_error", "expected_versionは0で指定してください。");
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
        throw new ApiError(400, "validation_error", "expected_versionは0で指定してください。");
      }
      const { name, html } = designMockPayload(command.payload, ["name", "html"]);
      const data = await designMockCall(() => requireCoreFeature(context.core, ["saveDesignMock", "deleteDesignMock", "listWorkDesignMocks", "readWorkDesignMock"],
        { code: "dependency_unavailable", message: "The loaded Core does not support design mocks." }).saveDesignMock(agent.agent_run_id, name, html));
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
        throw new ApiError(400, "validation_error", "expected_versionは0で指定してください。");
      }
      const { name } = designMockPayload(command.payload, ["name"]);
      const data = await designMockCall(() => requireCoreFeature(context.core, ["saveDesignMock", "deleteDesignMock", "listWorkDesignMocks", "readWorkDesignMock"],
        { code: "dependency_unavailable", message: "The loaded Core does not support design mocks." }).deleteDesignMock(agent.agent_run_id, name));
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
        throw new ApiError(400, "validation_error", "expected_versionは0で指定してください。");
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
        throw new ApiError(400, "validation_error", "work_id、task_id、parent_agent_run_idのいずれかを指定してください。");
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
        throw new ApiError(400, "invalid_query", "work_idが不正です。26文字の大文字ULIDを指定してください。");
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
        throw new ApiError(400, "invalid_query", "recentが不正です。0〜200の整数を指定してください。");
      }
      const data = requireCoreFeature(context.core, ["getAgentsView"],
        { code: "dependency_unavailable", message: "The loaded Core does not support the Agents page API." }).getAgentsView({ recent_limit: recentLimit });
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
        throw new ApiError(400, "guard_unparseable", "roleが不正です。");
      }
      if (agent && agent.role !== role) {
        throw new ApiError(403, "agent_scope_denied", "guard tokenのroleと一致しないroleは照会できません。");
      }
      const toolName = stringField(command.payload.tool_name, "tool_name", 1, 256);
      const toolInput = command.payload.tool_input;
      if (!isObject(toolInput)) throw new ApiError(400, "guard_unparseable", "tool_inputはJSON objectで指定してください。");
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
      if (agent?.role === "reviewer" && GUARD_SHELL_TOOL_NAMES.has(toolName.toLowerCase())) {
        const shellCommand = GUARD_SHELL_COMMAND_KEYS.map((key) => toolInput[key]).find((value): value is string => typeof value === "string");
        if (shellCommand !== undefined) {
          const check = await requireCoreFeature(context.core, ["checkReviewerTestCommand"],
            { code: "dependency_unavailable", message: "The loaded Core does not check Reviewer test commands." })
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
        throw new ApiError(403, "agent_scope_denied", "research capture はAdvisorとWorkエージェントのguard tokenでのみ受け付けます。");
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
    },
  },

  {
    method: "POST",
    path: "/api/v1/subagents/hook-event",
    async handle(route) {
      const { context, request, response } = route;
      const agent = requireGuard(request, context.guardTokens);
      if (!agent || agent.role !== "worker") {
        throw new ApiError(403, "agent_scope_denied", "subagent hook-event はWorkerのguard tokenでのみ受け付けます。");
      }
      const command = commandEnvelope(await readRequestBody(request));
      if (command.expected_version !== 0) {
        throw new ApiError(400, "validation_error", "expected_versionは0で指定してください。");
      }
      exactKeys(command.payload, ["event", "agent_id"], "SubagentHookEvent payload", ["agent_type", "requests"]);
      const event = command.payload.event;
      if (event !== "start" && event !== "stop" && event !== "usage") {
        throw new ApiError(400, "validation_error", "eventはstart・stop・usageのいずれかで指定してください。");
      }
      const agentId = stringField(command.payload.agent_id, "agent_id", 1, 200);
      const agentType = command.payload.agent_type === undefined ? null : stringField(command.payload.agent_type, "agent_type", 1, 200);
      if (event !== "usage" && command.payload.requests !== undefined) {
        throw new ApiError(400, "validation_error", "requestsはeventがusageのときだけ指定できます。");
      }
      const result = await requireCoreFeature(context.core, ["recordHookSubagent"],
        { code: "dependency_unavailable", message: "The loaded Core does not record hook subagents." }).recordHookSubagent(agent, event === "usage"
        ? { event, agentId, agentType, requests: hookRequestUsages(command.payload.requests) }
        : { event, agentId, agentType });
      sendJson(response, 202, { request_id: command.request_id, data: { accepted: result.agent_run_id !== null } });
    },
  },
];
