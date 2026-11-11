import { requireAdapterFeature, requireCoreFeature } from "./core-feature.js";
import { ApiError } from "./errors.js";
import { SkillsRouteMessages as M } from "./messages/routes-skills.js";
import { isUlid } from "./ids.js";
import { isRuleRole, RULE_ROLES } from "@owl/shared";
import type { JsonObject } from "./types.js";
import { isAbsolute } from "node:path";
import {
  commandEnvelope,
  decodeRouteValue,
  exactKeys,
  isObject,
  nullableQuery,
  parseBoolean,
  readRequestBody,
  requestOwnerLanguage,
  requireOwner,
  runCommand,
  sendJson,
  stringField,
  validateEmptyPayload,
  type ApiRoute,
  type RouteRequest,
  requestId,
} from "./http-common.js";
import type { IncomingMessage } from "node:http";
import type { OwnerLanguage } from "@owl/shared/owner-language";

const SYSTEM_RULE_TEXT_JA: Readonly<Record<string, string>> = {
  "block-git-force-push": "git push --force と git push -f は禁止されています。",
  "block-rm-root": "ルートまたはホームを含むディレクトリを rm -rf で削除する操作は禁止されています。",
  "block-rm-home": "ルートまたはホームを含むディレクトリを rm -rf で削除する操作は禁止されています。",
  "block-rm-home-env": "ルートまたはホームを含むディレクトリを rm -rf で削除する操作は禁止されています。",
  "block-sudo-rm": "sudo rm は禁止されています。",
  "block-git-reset-hard": "git reset --hard は禁止されています。",
  "block-git-clean-fdx": "git clean -fdx は禁止されています。",
  "block-env-files": ".env ファイルの読み取りは禁止されています。",
  "block-secrets-json": "secrets.json の読み取りは禁止されています。",
  "block-ssh-secrets": "~/.ssh 以下の読み取りは禁止されています。",
  "block-aws-secrets": "~/.aws 以下の読み取りは禁止されています。",
  "block-gh-secrets": "~/.config/gh 以下の読み取りは禁止されています。",
  "block-sqlite-file-writes": "data 内の SQLite ファイルへの直接書き込みや削除は禁止されています。",
  no_force_push: "強制pushは禁止。--force-with-lease を使う",
  no_rm_root: "ルートディレクトリの削除は禁止",
  no_rm_home: "ホームディレクトリの削除は禁止",
  no_sudo: "sudo rmは禁止",
  verify_before_done: "完了報告の前に、自分で動作確認をすること",
  no_secrets_in_code: "APIキー・パスワード・トークンをソースコードに直接書かないこと",
};

const RULE_RESULT_TEXT_JA: Readonly<Record<string, string>> = {
  "The command could not be parsed safely, so execution was denied.": "コマンドを安全に解析できないため実行を拒否しました。",
  "The command could not be determined because of environment variables or other indirection.": "環境変数などで実行コマンドを特定できないため拒否しました。",
  "The deletion target could not be parsed safely.": "削除対象を安全に解析できないため拒否しました。",
  "The path could not be parsed safely.": "パスを安全に解析できないため拒否しました。",
  "The write target path could not be parsed safely.": "書き込み先のパスを安全に解析できないため拒否しました。",
  "The read target path could not be parsed safely.": "読み取り対象のパスを安全に解析できないため拒否しました。",
};

function ownerRuleMessage(id: string, message: string, language: OwnerLanguage): string {
  if (language === "en") return message;
  if (SYSTEM_RULE_TEXT_JA[id]) return SYSTEM_RULE_TEXT_JA[id];
  if (RULE_RESULT_TEXT_JA[message]) return RULE_RESULT_TEXT_JA[message];
  if (message.startsWith("Blocked command: ")) return `禁止コマンド: ${message.slice("Blocked command: ".length)}`;
  const path = /^Blocked path \((read|write|both)\): (.*)$/u.exec(message);
  return path ? `禁止パス(${path[1]}): ${path[2]}` : message;
}

function requireRuleProposalOwner(request: IncomingMessage): string {
  try {
    return requireOwner(request);
  } catch (error) {
    if (error instanceof ApiError && error.code === "unauthorized") {
      throw new ApiError(403, "forbidden", M.ownerOnly());
    }
    throw error;
  }
}

function ruleProposalCommandResult(value: unknown): { data: JsonObject; version: number } {
  if (!isObject(value)) throw new ApiError(503, "core_not_ready", M.invalidResult());
  if (isObject(value.data) && typeof value.version === "number") {
    return { data: value.data, version: value.version };
  }
  return { data: value, version: 0 };
}

// error.message is relayed when the thrown error has one, so it is not a fixed sentence and stays a plain string; the table rows are the fallback.
function ruleProposalApiError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (!isObject(error) || typeof error.code !== "string") return error;
  const code = error.code;
  if (code === "invalid_state_transition") {
    return new ApiError(409, code, error instanceof Error ? error.message : M.notActionable(), isObject(error.details) ? error.details : {});
  }
  if (code === "rule_apply_failed") {
    return new ApiError(503, "dependency_unavailable", error instanceof Error ? error.message : M.applyFailed(), {
      domain_code: code,
      ...(isObject(error.details) ? error.details : {}),
    });
  }
  if (code === "validation_error") {
    return new ApiError(400, code, error instanceof Error ? error.message : M.requestInvalid(), isObject(error.details) ? error.details : {});
  }
  if (code === "note_not_found" || code === "note_claim_not_found" || code === "rule_proposal_not_found") {
    return new ApiError(404, "not_found", error instanceof Error ? error.message : M.resourceNotFound(), {
      domain_code: code,
      ...(isObject(error.details) ? error.details : {}),
    });
  }
  return error;
}


// requireSkillApi と同じ 13 個を調べる（503 になる条件を変えない）。
const skills = (route: RouteRequest) => requireAdapterFeature(route.context.core, [
  "getSkillActivity", "listSkills", "getSkill", "readSkillFile", "listSkillRevisions", "getSkillRevision", "restoreSkill",
  "updateSkill", "listSkillProposals", "approveSkillProposal", "rejectSkillProposal", "getSkillSettings", "setSkillSettings",
], { code: "core_not_ready", message: M.skillBoxUnsupported() });

const ruleProposalApi = (route: RouteRequest) => requireCoreFeature(route.context.core,
  ["listRuleProposals", "approveRuleProposal", "rejectRuleProposal"],
  { code: "core_not_ready", message: M.ruleProposalUnsupported() });

// adapter の updateSkill / approveSkillProposal / rejectSkillProposal は data を unknown で返す。実体は Core の JsonObject。
const skillCommandResult = (updated: { data: unknown; version: number }): { data: JsonObject; version: number } =>
  ({ data: updated.data as JsonObject, version: updated.version });

type ProposalAction = "approve" | "reject";

async function handleRuleProposalAction(route: RouteRequest, action: ProposalAction): Promise<void> {
  const { context, request, response, pathname } = route;
  requireRuleProposalOwner(request);
  const proposalId = decodeRouteValue(route.params.id!, "proposal_id");
  if (!isUlid(proposalId)) throw new ApiError(400, "validation_error", M.idNotUlid({ field: "proposal_id" }), { field: "proposal_id" });
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
        throw new ApiError(400, "validation_error", M.daysInvalid(), { field: "days" });
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
      if (!isUlid(revisionId)) throw new ApiError(400, "validation_error", M.idNotUlid({ field: "revision_id" }), { field: "revision_id" });
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
      if (!isUlid(revisionId)) throw new ApiError(400, "validation_error", M.idNotUlid({ field: "revision_id" }), { field: "revision_id" });
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
        throw new ApiError(400, "validation_error", M.skillUpdateEmpty(), { extra });
      }
      if (command.payload.state !== undefined && typeof command.payload.state !== "string") {
        throw new ApiError(400, "validation_error", M.stateNotString(), { field: "state" });
      }
      if (command.payload.scope !== undefined && typeof command.payload.scope !== "string") {
        throw new ApiError(400, "validation_error", M.scopeNotString(), { field: "scope" });
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
      if (!isUlid(jobId)) throw new ApiError(400, "validation_error", M.idNotUlid({ field: "job_id" }), { field: "job_id" });
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
        throw new ApiError(400, "validation_error", M.commandRequired());
      }
      if (body.role !== undefined && !isRuleRole(body.role)) {
        throw new ApiError(400, "validation_error", M.roleInvalid({ roles: RULE_ROLES.join(", ") }));
      }
      if (body.cwd !== undefined && (typeof body.cwd !== "string" || !isAbsolute(body.cwd))) {
        throw new ApiError(400, "validation_error", M.cwdNotAbsolute());
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
