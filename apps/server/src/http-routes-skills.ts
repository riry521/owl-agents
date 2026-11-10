import { requireAdapterFeature, requireCoreFeature } from "./core-feature.js";
import { ApiError } from "./errors.js";
import { isUlid } from "./ids.js";
import { isRuleRole, RULE_ROLES } from "../../../packages/shared/dist/index.js";
import type { JsonObject } from "./types.js";
import { isAbsolute } from "node:path";
import {
  commandEnvelope, decodeRouteValue, exactKeys, isObject, nullableQuery, ownerRuleMessage, parseBoolean, readRequestBody,
  requestOwnerLanguage, requireOwner, requireRuleProposalOwner, ruleProposalApiError, ruleProposalCommandResult, runCommand,
  sendJson, stringField, validateEmptyPayload,
  type ApiRoute, type RouteRequest,
} from "./http-common.js";

// requireSkillApi と同じ 13 個を調べる（503 になる条件を変えない）。
const skills = (route: RouteRequest) => requireAdapterFeature(route.context.core, [
  "getSkillActivity", "listSkills", "getSkill", "readSkillFile", "listSkillRevisions", "getSkillRevision", "restoreSkill",
  "updateSkill", "listSkillProposals", "approveSkillProposal", "rejectSkillProposal", "getSkillSettings", "setSkillSettings",
], { code: "core_not_ready", message: "The loaded Core does not support the Skill Box API." });

const ruleProposalApi = (route: RouteRequest) => requireCoreFeature(route.context.core,
  ["listRuleProposals", "approveRuleProposal", "rejectRuleProposal"],
  { code: "core_not_ready", message: "The loaded Core does not support the rule proposal API." });

// adapter の updateSkill / approveSkillProposal / rejectSkillProposal は data を unknown で返す。実体は Core の JsonObject。
const skillCommandResult = (updated: { data: unknown; version: number }): { data: JsonObject; version: number } =>
  ({ data: updated.data as JsonObject, version: updated.version });

type ProposalAction = "approve" | "reject";

async function handleRuleProposalAction(route: RouteRequest, action: ProposalAction): Promise<void> {
  const { context, request, response, pathname } = route;
  requireRuleProposalOwner(request);
  const proposalId = decodeRouteValue(route.params.id!, "proposal_id");
  if (!isUlid(proposalId)) throw new ApiError(400, "validation_error", "proposal_id must be a ULID.", { field: "proposal_id" });
  const command = commandEnvelope(await readRequestBody(request));
  validateEmptyPayload(command.payload);
  const api = ruleProposalApi(route);
  const result = await runCommand(context, pathname, command, 200, async () => {
    try {
      const updated = action === "approve"
        ? await api.approveRuleProposal(proposalId)
        : await api.rejectRuleProposal(proposalId);
      return ruleProposalCommandResult(updated);
    } catch (error) {
      throw ruleProposalApiError(error);
    }
  });
  sendJson(response, 200, result);
}

async function handleSkillProposalAction(route: RouteRequest, action: ProposalAction): Promise<void> {
  const { context, request, response, pathname } = route;
  requireOwner(request);
  const proposalId = decodeRouteValue(route.params.proposal_id!, "proposal_id");
  const command = commandEnvelope(await readRequestBody(request));
  validateEmptyPayload(command.payload);
  const result = await runCommand(context, pathname, command, 200, async () => {
    const updated = action === "approve"
      ? await skills(route).approveSkillProposal(proposalId)
      : await skills(route).rejectSkillProposal(proposalId);
    return skillCommandResult(updated);
  });
  sendJson(response, 200, result);
}

export const SKILL_FILE_ROUTES: readonly ApiRoute[] = [
  {
    method: "GET", path: "/api/v1/skills/{name}/files/{path*}", raw: true,
    async handle(route) {
      const { request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const api = skills(route);
      const name = decodeRouteValue(route.params.name!, "name");
      const filePath = decodeRouteValue(route.params.path!, "path");
      const content = await api.readSkillFile(name, filePath);
      sendJson(response, 200, { request_id: requestIdValue, data: { content } });
    },
  },
];

export const SKILL_ROUTES: readonly ApiRoute[] = [
  {
    method: "GET", path: "/api/v1/skill-activity",
    async handle(route) {
      const { request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const rawDays = url.searchParams.get("days");
      const days = rawDays === null ? 7 : /^\d+$/u.test(rawDays) ? Number(rawDays) : NaN;
      if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
        throw new ApiError(400, "validation_error", "days must be an integer between 1 and 90.", { field: "days" });
      }
      sendJson(response, 200, { request_id: requestIdValue, data: skills(route).getSkillActivity(days) });
    },
  },
  {
    method: "GET", path: "/api/v1/skills",
    async handle(route) {
      const { request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const rawTrial = url.searchParams.get("trial");
      const q = nullableQuery(url.searchParams.get("q"));
      const state = nullableQuery(url.searchParams.get("state"));
      const scope = nullableQuery(url.searchParams.get("scope"));
      const data = skills(route).listSkills({
        ...(q === null ? {} : { query: q }),
        ...(state === null ? {} : { state }),
        ...(scope === null ? {} : { scope }),
        ...(rawTrial === null || rawTrial === "" ? {} : { trial: parseBoolean(rawTrial, false) }),
      });
      sendJson(response, 200, { request_id: requestIdValue, data });
    },
  },
  {
    method: "GET", path: "/api/v1/skills/{name}/revisions/{revision_id}",
    async handle(route) {
      const { request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const name = decodeRouteValue(route.params.name!, "name");
      const revisionId = decodeRouteValue(route.params.revision_id!, "revision_id");
      if (!isUlid(revisionId)) throw new ApiError(400, "validation_error", "revision_id must be a ULID.", { field: "revision_id" });
      const data = skills(route).getSkillRevision(name, revisionId);
      sendJson(response, 200, { request_id: requestIdValue, data });
    },
  },
  {
    method: "GET", path: "/api/v1/skills/{name}/revisions",
    async handle(route) {
      const { request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const name = decodeRouteValue(route.params.name!, "name");
      const data = skills(route).listSkillRevisions(name);
      sendJson(response, 200, { request_id: requestIdValue, data });
    },
  },
  {
    method: "POST", path: "/api/v1/skills/{name}/restore",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const name = decodeRouteValue(route.params.name!, "name");
      const command = commandEnvelope(await readRequestBody(request));
      exactKeys(command.payload, ["revision_id"], "Restore skill payload");
      const revisionId = stringField(command.payload.revision_id, "revision_id", 1, 128);
      if (!isUlid(revisionId)) throw new ApiError(400, "validation_error", "revision_id must be a ULID.", { field: "revision_id" });
      const result = await runCommand(context, pathname, command, 200, async () => {
        const restored = await skills(route).restoreSkill(name, revisionId);
        return { data: restored.data, version: restored.version };
      });
      sendJson(response, 200, result);
    },
  },
  {
    method: "GET", path: "/api/v1/skills/{name}",
    async handle(route) {
      const { request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const name = decodeRouteValue(route.params.name!, "name");
      const data = await skills(route).getSkill(name);
      sendJson(response, 200, { request_id: requestIdValue, data });
    },
  },
  {
    method: "PATCH", path: "/api/v1/skills/{name}",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const name = decodeRouteValue(route.params.name!, "name");
      const command = commandEnvelope(await readRequestBody(request));
      const keys = Object.keys(command.payload);
      const extra = keys.filter((key) => key !== "state" && key !== "scope");
      if (extra.length > 0 || keys.length === 0) {
        throw new ApiError(400, "validation_error", "Skill update must contain state, scope, or both.", { extra });
      }
      if (command.payload.state !== undefined && typeof command.payload.state !== "string") {
        throw new ApiError(400, "validation_error", "state must be a string.", { field: "state" });
      }
      if (command.payload.scope !== undefined && typeof command.payload.scope !== "string") {
        throw new ApiError(400, "validation_error", "scope must be a string.", { field: "scope" });
      }
      const patch = {
        ...(typeof command.payload.state === "string" ? { state: command.payload.state } : {}),
        ...(typeof command.payload.scope === "string" ? { scope: command.payload.scope } : {}),
      };
      const result = await runCommand(context, pathname, command, 200, async () => {
        const updated = await skills(route).updateSkill(name, patch);
        return skillCommandResult(updated);
      });
      sendJson(response, 200, result);
    },
  },
  {
    method: "GET", path: "/api/v1/skill-proposals",
    async handle(route) {
      const { request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const statusValue = url.searchParams.get("status");
      const data = skills(route).listSkillProposals(statusValue === null ? undefined : statusValue);
      sendJson(response, 200, { request_id: requestIdValue, data });
    },
  },
  {
    method: "GET", path: "/api/v1/rule-proposals",
    async handle(route) {
      const { request, response, url } = route;
      const requestIdValue = route.requestId;
      requireRuleProposalOwner(request);
      const statusValue = url.searchParams.get("status");
      let data: unknown[];
      try {
        data = ruleProposalApi(route).listRuleProposals(statusValue === null ? undefined : statusValue);
      } catch (error) {
        throw ruleProposalApiError(error);
      }
      sendJson(response, 200, { request_id: requestIdValue, data });
    },
  },
  {
    method: "POST", path: "/api/v1/rule-proposals/{id}/approve",
    handle: (route) => handleRuleProposalAction(route, "approve"),
  },
  {
    method: "POST", path: "/api/v1/rule-proposals/{id}/reject",
    handle: (route) => handleRuleProposalAction(route, "reject"),
  },
  {
    method: "GET", path: "/api/v1/learning-jobs",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const statusValue = url.searchParams.get("status");
      const data = context.core.listLearningJobs(statusValue === null ? undefined : statusValue);
      sendJson(response, 200, { request_id: requestIdValue, data });
    },
  },
  {
    method: "POST", path: "/api/v1/learning-jobs/{id}/retry",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const jobId = decodeRouteValue(route.params.id!, "job_id");
      if (!isUlid(jobId)) throw new ApiError(400, "validation_error", "job_id must be a ULID.", { field: "job_id" });
      await context.core.retryLearningJob(jobId);
      sendJson(response, 200, { request_id: requestIdValue, data: { job_id: jobId } });
    },
  },
  {
    method: "POST", path: "/api/v1/skill-proposals/{proposal_id}/approve",
    handle: (route) => handleSkillProposalAction(route, "approve"),
  },
  {
    method: "POST", path: "/api/v1/skill-proposals/{proposal_id}/reject",
    handle: (route) => handleSkillProposalAction(route, "reject"),
  },
  {
    method: "GET", path: "/api/v1/rules",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const ruleSet = context.ruleStore.rules;
      const language = await requestOwnerLanguage(context.core);
      sendJson(response, 200, {
        request_id: requestIdValue,
        data: {
          files: ruleSet.files.map((f) => ({ path: f.path, level: f.level, role: f.role ?? null, project_id: f.project_id ?? null, rule_count: f.rules.length })),
          block_rules: ruleSet.blockRules.map((r) => ({ id: r.id, level: r.level, role: r.role ?? null, pattern: r.pattern, message: ownerRuleMessage(r.id, r.message, language) })),
          block_paths: ruleSet.blockPaths.map((r) => ({ id: r.id, level: r.level, role: r.role ?? null, pattern: r.pattern, mode: r.mode, message: ownerRuleMessage(r.id, r.message, language) })),
          prompt_rules: ruleSet.promptRules.map((r) => ({ ...r, project_id: r.project_id ?? null, text: ownerRuleMessage(r.id, r.text, language) })),
          status: context.ruleStore.status,
        },
      });
    },
  },
  {
    method: "POST", path: "/api/v1/rules/check",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const body = await readRequestBody(request);
      if (!isObject(body) || typeof body.command !== "string") {
        throw new ApiError(400, "validation_error", "commandフィールドが必要です。");
      }
      if (body.role !== undefined && !isRuleRole(body.role)) {
        throw new ApiError(400, "validation_error", `roleは ${RULE_ROLES.join(", ")} のいずれかで指定してください。`);
      }
      if (body.cwd !== undefined && (typeof body.cwd !== "string" || !isAbsolute(body.cwd))) {
        throw new ApiError(400, "validation_error", "cwdは絶対パスで指定してください。");
      }

      const result = context.ruleStore.checkCommand(
        body.command as string,
        (body.cwd as string | undefined) ?? process.cwd(),
        process.env.HOME,
        body.role as string | undefined,
      );
      const language = await requestOwnerLanguage(context.core);
      sendJson(response, 200, {
        request_id: requestIdValue,
        data: {
          blocked: result.blocked,
          rule: result.rule ? { id: result.rule.id, level: result.rule.level, role: result.rule.role ?? null, message: ownerRuleMessage(result.rule.id, result.rule.message, language) } : null,
        },
      });
    },
  },
];
