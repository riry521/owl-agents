import { requireAdapterFeature, requireCoreFeature } from "./core-feature.js";
import { ApiError, type ApiErrorCode } from "./errors.js";
import { AdvisorFolderError } from "./advisor-folders.js";
import { parseFileDestinationPut } from "./advisor-file-destination-settings.js";
import {
  HARNESS_PROVIDER_ALIASES,
  MAX_ADVISOR_PERSONA_LENGTH,
  advisorWindowFeature,
  assertSameOriginWrite,
  childRunCall,
  childRunFeature,
  commandEnvelope,
  decodeRouteValue,
  exactKeys,
  fileDestinationData,
  fileDestinationProviders,
  hostTimeZone,
  inviteOwnerToChannel,
  isObject,
  knowledgeStorageErrorCode,
  knowledgeStorageFeature,
  maskSecret,
  pathId,
  readRequestBody,
  requestOwnerLanguage,
  requireChannelAdmin,
  requireOwner,
  runCommand,
  sendJson,
  slackOwnerUserId,
  stringField,
  validateCreateModelPresetPayload,
  validateIntegrationPayload,
  validateUpdateModelPresetPayload,
  validateUpdateModelSettingsPayload,
  validatedSettings,
  windowChannelError,
  type ApiRoute,
} from "./http-common.js";
import { validateKnowledgeAutomationSettings } from "../../../packages/shared/dist/knowledge-automation.js";
import { validatePlanUsageSettings } from "../../../packages/shared/dist/plan-usage-settings.js";
import { validateDependencySummarySettings } from "../../../packages/shared/dist/dependency-summary-settings.js";
import { validateAdvisorWindowSettings } from "../../../packages/shared/dist/advisor-window-settings.js";
import { validateVerificationPolicyPatch } from "../../../packages/shared/dist/verification-policy-settings.js";
import { validateReviewLimitSettings } from "../../../packages/shared/dist/review-limit-settings.js";
import { REMAKE_LIMIT_SETTINGS_KEYS, validateRemakeLimitSettings } from "../../../packages/shared/dist/remake-limit-settings.js";
import { validateAutoRecoverySettings } from "../../../packages/shared/dist/auto-recovery-settings.js";
import { validateFixerEscalationSettings } from "../../../packages/shared/dist/fixer-escalation-settings.js";
import { validateReviewRoutingSettings } from "../../../packages/shared/dist/review-routing-settings.js";
import { isOwnerLanguage } from "../../../packages/shared/dist/owner-language.js";
import { CHILD_RUN_EFFORTS, CHILD_RUN_PROVIDERS } from "../../../packages/shared/dist/child-runs.js";
import type { ChildRunEffort, ChildRunProvider, ChildRunSettings } from "../../../packages/shared/dist/child-runs.js";
import type { CorePort, IntegrationProvider, JsonObject, ProcessSkillsSettingsInput } from "./types.js";

interface SettingsRouteSpec<Api, Input> {
  readonly path: string;
  /** 今の分岐が exactKeys を呼ぶ対だけに書く。書かない対では exactKeys を呼ばない。 */
  readonly exactKeys?: { readonly keys: readonly string[]; readonly label: string };
  readonly validate: (value: unknown) => Input;
  /** validatedSettings の第3引数。省くと 400。advisor-windows だけが 422 を渡す。 */
  readonly invalidStatus?: 400 | 422;
  /** requireCoreFeature を呼ぶ。キー・code・message は今の require 関数と同じものを渡す。 */
  readonly feature: (core: CorePort) => Api;
  readonly get: (api: Api) => unknown | Promise<unknown>;
  readonly set: (api: Api, input: Input) => Promise<unknown>;
}

/** 設定の GET/PUT の対。GET → PUT の2行を返す。 */
function settingsRoutes<Api, Input>(spec: SettingsRouteSpec<Api, Input>): [ApiRoute, ApiRoute] {
  return [
    {
      method: "GET",
      path: spec.path,
      async handle(route) {
        const { context, request, response } = route;
        const requestIdValue = route.requestId;
        requireOwner(request);
        const data = await spec.get(spec.feature(context.core));
        sendJson(response, 200, { request_id: requestIdValue, data, version: 0 });
      },
    },
    {
      method: "PUT",
      path: spec.path,
      async handle(route) {
        const { context, request, response, pathname } = route;
        requireOwner(request);
        const command = commandEnvelope(await readRequestBody(request));
        if (spec.exactKeys) exactKeys(command.payload, spec.exactKeys.keys, spec.exactKeys.label);
        const input = validatedSettings(spec.validate, command.payload, spec.invalidStatus);
        const api = spec.feature(context.core);
        const result = await runCommand(context, pathname, command, 200, async () => ({
          data: await spec.set(api, input) as unknown as JsonObject,
          version: 0,
        }));
        sendJson(response, 200, result);
      },
    },
  ];
}

const VERIFICATION_POLICY_KEYS = ["getVerificationPolicySettings", "updateVerificationPolicySettings"] as const;
const VERIFICATION_POLICY_UNAVAILABLE = { code: "dependency_unavailable", message: "The loaded Core does not support verification policy settings." } as const;

/** 今の requireSkillApi と同じく、13個すべてを確かめる。1個でも無ければ 503 core_not_ready。 */
const skillFeature = (core: CorePort) => requireAdapterFeature(core, [
  "getSkillActivity", "listSkills", "getSkill", "readSkillFile", "listSkillRevisions", "getSkillRevision", "restoreSkill",
  "updateSkill", "listSkillProposals", "approveSkillProposal", "rejectSkillProposal", "getSkillSettings", "setSkillSettings",
], { code: "core_not_ready", message: "The loaded Core does not support the Skill Box API." });

export const SETTINGS_ROUTES: readonly ApiRoute[] = [
  {
    method: "GET",
    path: "/api/v1/settings/view",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      // Same Core calls and shaping as each settings GET route; secrets stay masked.
      const remakeLimits = requireCoreFeature(context.core, ["getRemakeLimitSettings", "setRemakeLimitSettings"],
        { code: "dependency_unavailable", message: "The loaded Core does not support remake limits." });
      const fixerEscalationApi = requireCoreFeature(context.core, ["getFixerEscalationSettings", "setFixerEscalationSettings"],
        { code: "dependency_unavailable", message: "The loaded Core does not support Fixer escalation." });
      const autoRecoveryApi = requireCoreFeature(context.core, ["getAutoRecoverySettings", "setAutoRecoverySettings"],
        { code: "dependency_unavailable", message: "The loaded Core does not support automatic recovery." });
      const childRuns = childRunFeature(context.core);
      const knowledgeStorage = knowledgeStorageFeature(context.core);
      const core = context.core;
      const [models, providers, hybrid_mode, language, knowledgeAutomation, advisor_persona, advisorFolders, integrations, typesafeKey, remake_limits, fixer_escalation, auto_recovery, child_runs] = await Promise.all([
        core.getModelSettings(),
        core.listProviders(),
        core.getHybridMode(),
        requestOwnerLanguage(core),
        core.getKnowledgeAutomationSettings(),
        core.getAdvisorPersona(),
        core.getAdvisorFolders(),
        core.getIntegrations(),
        core.getTypesafeApiKey(),
        remakeLimits.getRemakeLimitSettings(),
        fixerEscalationApi.getFixerEscalationSettings(),
        autoRecoveryApi.getAutoRecoverySettings(),
        childRunCall(() => childRuns.getChildRunSettings()),
      ]);
      const data = {
        models: { roles: models.roles },
        providers,
        hybrid: { hybrid_mode },
        child_runs,
        language: { language },
        remake_limits,
        fixer_escalation,
        auto_recovery,
        knowledge_automation: { ...knowledgeAutomation, time_zone: hostTimeZone() },
        advisor_persona: { advisor_persona },
        advisor_folders: advisorFolders,
        integrations: { integrations },
        system_status: { ...(core.status() as unknown as Record<string, unknown>), data_dir: context.dataDir },
        typesafe: { typesafe_api_key: maskSecret(typesafeKey) },
        knowledge_storage: knowledgeStorage.getKnowledgeStorage(),
      };
      sendJson(response, 200, { request_id: requestIdValue, data: data as unknown as JsonObject, version: 1 });
    },
  },
  {
    method: "GET",
    path: "/api/v1/settings/models",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const { version, roles } = await context.core.getModelSettings();
      sendJson(response, 200, { request_id: requestIdValue, data: { roles }, version });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/settings/models",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const body = await readRequestBody(request);
      const command = commandEnvelope(body);
      const payload = validateUpdateModelSettingsPayload(command.payload);
      const result = await runCommand(context, pathname, command, 200, async () => context.core.updateModelSettings(payload, command));
      sendJson(response, 200, result);
    },
  },
  {
    method: "GET",
    path: "/api/v1/settings/model-presets",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const { version, presets } = await context.core.getModelPresets();
      sendJson(response, 200, { request_id: requestIdValue, data: { presets }, version });
    },
  },
  {
    method: "POST",
    path: "/api/v1/settings/model-presets",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const command = commandEnvelope(await readRequestBody(request));
      const payload = validateCreateModelPresetPayload(command.payload);
      const result = await runCommand(context, pathname, command, 201, async () => context.core.createModelPreset(payload, command));
      sendJson(response, 201, result);
    },
  },
  {
    method: "PUT",
    path: "/api/v1/settings/model-presets/{id}",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const id = pathId(route.params.id!, "id");
      const command = commandEnvelope(await readRequestBody(request));
      const payload = validateUpdateModelPresetPayload(command.payload);
      const result = await runCommand(context, pathname, command, 200, async () => context.core.updateModelPreset(id, payload, command));
      sendJson(response, 200, result);
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/settings/model-presets/{id}",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const id = pathId(route.params.id!, "id");
      const command = commandEnvelope(await readRequestBody(request));
      exactKeys(command.payload, [], "DeleteModelPreset payload");
      const result = await runCommand(context, pathname, command, 200, async () => context.core.deleteModelPreset(id, command));
      sendJson(response, 200, result);
    },
  },
  {
    method: "GET",
    path: "/api/v1/settings/process-skills",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const settings = await context.core.getProcessSkillsSettings();
      sendJson(response, 200, { request_id: requestIdValue, data: settings, version: 0 });
    },
  },
  {
    method: "GET",
    path: "/api/v1/settings/knowledge-automation",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const settings = await context.core.getKnowledgeAutomationSettings();
      sendJson(response, 200, {
        request_id: requestIdValue,
        data: { ...settings, time_zone: hostTimeZone() },
        version: 0,
      });
    },
  },
  ...settingsRoutes({
    path: "/api/v1/settings/dependency-summary",
    exactKeys: { keys: ["max_chars"], label: "Dependency summary payload" },
    validate: validateDependencySummarySettings,
    feature: (core) => requireCoreFeature(core, ["getDependencySummarySettings", "setDependencySummarySettings"],
      { code: "dependency_unavailable", message: "The loaded Core does not support the dependency summary setting." }),
    get: (api) => api.getDependencySummarySettings(),
    set: (api, input) => api.setDependencySummarySettings(input),
  }),
  ...settingsRoutes({
    path: "/api/v1/settings/advisor-windows",
    validate: validateAdvisorWindowSettings,
    invalidStatus: 422,
    feature: advisorWindowFeature,
    get: (api) => api.getAdvisorWindowSettings(),
    set: (api, input) => api.setAdvisorWindowSettings(input),
  }),
  {
    method: "GET",
    path: "/api/v1/settings/verification-policy",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const data = await requireCoreFeature(context.core, VERIFICATION_POLICY_KEYS, VERIFICATION_POLICY_UNAVAILABLE).getVerificationPolicySettings();
      sendJson(response, 200, { request_id: requestIdValue, data, version: 0 });
    },
  },
  {
    method: "PATCH",
    path: "/api/v1/settings/verification-policy",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      assertSameOriginWrite(request, context);
      const patch = validatedSettings(validateVerificationPolicyPatch, await readRequestBody(request));
      try {
        const data = await requireCoreFeature(context.core, VERIFICATION_POLICY_KEYS, VERIFICATION_POLICY_UNAVAILABLE).updateVerificationPolicySettings(patch);
        sendJson(response, 200, { request_id: requestIdValue, data, version: 0 });
      } catch (error) {
        if (isObject(error) && error.code === "validation_error") {
          throw new ApiError(400, "validation_error", error instanceof Error ? error.message : "Invalid verification policy settings.", isObject(error.details) ? error.details : {});
        }
        if (isObject(error) && error.code === "verification_policy_storage_invalid") {
          throw new ApiError(409, "verification_policy_storage_invalid", error instanceof Error ? error.message : "保存済みの検証ポリシーが不正です。", isObject(error.details) ? error.details : {});
        }
        throw error;
      }
    },
  },
  ...settingsRoutes({
    path: "/api/v1/settings/review-limits",
    exactKeys: { keys: ["plan_review_rounds", "total_review_attempts"], label: "Review limits payload" },
    validate: validateReviewLimitSettings,
    feature: (core) => requireCoreFeature(core, ["getReviewLimitSettings", "setReviewLimitSettings"],
      { code: "dependency_unavailable", message: "The loaded Core does not support review limits." }),
    get: (api) => api.getReviewLimitSettings(),
    set: (api, input) => api.setReviewLimitSettings(input),
  }),
  ...settingsRoutes({
    path: "/api/v1/settings/remake-limits",
    exactKeys: { keys: REMAKE_LIMIT_SETTINGS_KEYS, label: "Remake limits payload" },
    validate: validateRemakeLimitSettings,
    feature: (core) => requireCoreFeature(core, ["getRemakeLimitSettings", "setRemakeLimitSettings"],
      { code: "dependency_unavailable", message: "The loaded Core does not support remake limits." }),
    get: (api) => api.getRemakeLimitSettings(),
    set: (api, input) => api.setRemakeLimitSettings(input),
  }),
  ...settingsRoutes({
    path: "/api/v1/settings/fixer-escalation",
    validate: validateFixerEscalationSettings,
    feature: (core) => requireCoreFeature(core, ["getFixerEscalationSettings", "setFixerEscalationSettings"],
      { code: "dependency_unavailable", message: "The loaded Core does not support Fixer escalation." }),
    get: (api) => api.getFixerEscalationSettings(),
    set: (api, input) => api.setFixerEscalationSettings(input),
  }),
  ...settingsRoutes({
    path: "/api/v1/settings/auto-recovery",
    validate: validateAutoRecoverySettings,
    feature: (core) => requireCoreFeature(core, ["getAutoRecoverySettings", "setAutoRecoverySettings"],
      { code: "dependency_unavailable", message: "The loaded Core does not support automatic recovery." }),
    get: (api) => api.getAutoRecoverySettings(),
    set: (api, input) => api.setAutoRecoverySettings(input),
  }),
  ...settingsRoutes({
    path: "/api/v1/settings/review-routing",
    validate: validateReviewRoutingSettings,
    feature: (core) => requireCoreFeature(core, ["getReviewRoutingSettings", "setReviewRoutingSettings"],
      { code: "dependency_unavailable", message: "The loaded Core does not support review routing settings." }),
    get: (api) => api.getReviewRoutingSettings(),
    set: (api, input) => api.setReviewRoutingSettings(input),
  }),
  ...settingsRoutes({
    path: "/api/v1/settings/plan-usage",
    exactKeys: { keys: ["claude_usage_api_enabled", "poll_interval_minutes"], label: "Plan usage settings payload" },
    validate: validatePlanUsageSettings,
    feature: (core) => requireCoreFeature(core, ["getPlanUsage", "refreshPlanUsage", "getPlanUsageSettings", "setPlanUsageSettings"],
      { code: "dependency_unavailable", message: "The loaded Core does not support plan usage." }),
    get: (api) => api.getPlanUsageSettings(),
    set: (api, input) => api.setPlanUsageSettings(input),
  }),
  {
    method: "PUT",
    path: "/api/v1/settings/knowledge-automation",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const command = commandEnvelope(await readRequestBody(request));
      exactKeys(command.payload, ["librarian_times", "research_autosave"], "Knowledge automation settings payload");
      const input = validatedSettings(validateKnowledgeAutomationSettings, command.payload);
      const result = await runCommand(context, pathname, command, 200, async () => {
        const settings = await context.core.setKnowledgeAutomationSettings(input);
        return { data: { ...settings, time_zone: hostTimeZone() } as unknown as JsonObject, version: 0 };
      });
      sendJson(response, 200, result);
    },
  },
  {
    method: "PUT",
    path: "/api/v1/settings/process-skills",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const command = commandEnvelope(await readRequestBody(request));
      const payload = command.payload;
      exactKeys(payload, ["enabled", "path"], "Process skills settings payload");
      if (typeof payload.enabled !== "boolean" || (payload.path !== null && typeof payload.path !== "string")) {
        throw new ApiError(400, "validation_error", "enabled must be a boolean and path must be a string or null.");
      }
      const input: ProcessSkillsSettingsInput = { enabled: payload.enabled, path: payload.path as string | null };
      const result = await runCommand(context, pathname, command, 200, async () => {
        const data = await context.core.setProcessSkillsSettings(input);
        return { data: data as unknown as JsonObject, version: 0 };
      });
      sendJson(response, 200, result);
    },
  },
  {
    method: "GET",
    path: "/api/v1/settings/integrations",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const integrations = await context.core.getIntegrations();
      sendJson(response, 200, { request_id: requestIdValue, data: { integrations } });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/settings/integrations/{provider}",
    values: { provider: ["slack", "discord"] },
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const provider = route.params.provider as IntegrationProvider;
      const body = await readRequestBody(request);
      const command = commandEnvelope(body);
      const currentIntegration = (await context.core.getIntegrations()).find((integration) => integration.provider === provider);
      const config = validateIntegrationPayload(command.payload, provider, currentIntegration?.configured === true);
      const result = await runCommand(context, pathname, command, 200, async () => context.core.saveIntegration(provider, config, command));
      sendJson(response, 200, result);
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/settings/integrations/{provider}",
    values: { provider: ["slack", "discord"] },
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const provider = route.params.provider as IntegrationProvider;
      const body = await readRequestBody(request);
      const command = commandEnvelope(body);
      const result = await runCommand(context, pathname, command, 200, async () => context.core.deleteIntegration(provider, command));
      sendJson(response, 200, result);
    },
  },
  {
    method: "POST",
    path: "/api/v1/settings/integrations/slack/invite-owner",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const command = commandEnvelope(await readRequestBody(request));
      const result = await runCommand(context, pathname, command, 200, async () => {
        const api = advisorWindowFeature(context.core);
        const ownerUserId = await slackOwnerUserId(context);
        const admin = await requireChannelAdmin(context, "slack");
        const results: JsonObject[] = [];
        for (const { window_id: windowId } of await api.listAdvisorChannelBindings("slack")) {
          const binding = await api.getAdvisorChannelBinding(windowId, "slack");
          if (!binding) continue;
          const owner = await api.findAdvisorChannelOwner("slack", binding.channel_id);
          const entry = { window_key: owner?.window_key ?? "", channel_id: binding.channel_id, display_name: binding.display_name };
          try {
            results.push({ ...entry, invite: await inviteOwnerToChannel(admin, binding.channel_id, ownerUserId) });
          } catch (error) {
            results.push({ ...entry, invite: "failed", error: windowChannelError(error) });
          }
        }
        return { data: { results }, version: 0 };
      });
      sendJson(response, 200, result);
    },
  },
  {
    method: "POST",
    path: "/api/v1/settings/integrations/{provider}/test",
    values: { provider: ["slack", "discord"] },
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const provider = route.params.provider as IntegrationProvider;
      const result = await context.core.testIntegration(provider);
      sendJson(response, 200, { request_id: requestIdValue, data: result });
    },
  },
  {
    method: "GET",
    path: "/api/v1/settings/skills",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      const skills = () => skillFeature(context.core);
      requireOwner(request);
      sendJson(response, 200, { request_id: requestIdValue, data: skills().getSkillSettings() });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/settings/skills",
    async handle(route) {
      const { context, request, response, pathname } = route;
      const skills = () => skillFeature(context.core);
      requireOwner(request);
      const command = commandEnvelope(await readRequestBody(request));
      const result = await runCommand(context, pathname, command, 200, async () => {
        const updated = await skills().setSkillSettings(command.payload);
        return { data: updated.data as JsonObject, version: updated.version };
      });
      sendJson(response, 200, result);
    },
  },
  // ---- Hybrid Mode ----------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/settings/hybrid",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const enabled = await context.core.getHybridMode();
      sendJson(response, 200, { request_id: requestIdValue, data: { hybrid_mode: enabled } });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/settings/hybrid",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const body = await readRequestBody(request);
      const cmd = commandEnvelope(body);
      if (typeof cmd.payload.hybrid_mode !== "boolean") {
        throw new ApiError(400, "validation_error", "hybrid_modeが不正です。booleanを指定してください。");
      }
      const enabled = cmd.payload.hybrid_mode as boolean;
      const result = await runCommand(context, pathname, cmd, 200, async () => {
        const value = await context.core.setHybridMode(enabled);
        return { data: { hybrid_mode: value } as JsonObject, version: 0 };
      });
      sendJson(response, 200, result);
    },
  },
  // ---- Owner language -------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/settings/language",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const language = await requestOwnerLanguage(context.core);
      sendJson(response, 200, { request_id: requestIdValue, data: { language } });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/settings/language",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const body = await readRequestBody(request);
      const cmd = commandEnvelope(body);
      const language = cmd.payload.language;
      if (!isOwnerLanguage(language)) {
        throw new ApiError(400, "validation_error", "languageが不正です。\"ja\"または\"en\"を指定してください。");
      }
      const result = await runCommand(context, pathname, cmd, 200, async () => {
        const value = await context.core.setLanguage(language);
        return { data: { language: value } as JsonObject, version: 0 };
      });
      sendJson(response, 200, result);
    },
  },
  // ---- Child runs ------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/settings/child-runs",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const data = await childRunCall(() => childRunFeature(context.core).getChildRunSettings());
      sendJson(response, 200, { request_id: requestIdValue, data });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/settings/child-runs",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const cmd = commandEnvelope(await readRequestBody(request));
      const result = await runCommand(context, pathname, cmd, 200, async () => {
        const saved = await childRunCall(() => childRunFeature(context.core).setChildRunSettings(cmd.payload as unknown as ChildRunSettings));
        return { data: saved as unknown as JsonObject, version: 0 };
      });
      sendJson(response, 200, result);
    },
  },
  // Legacy executor settings: the default child provider, model, effort and timeout.
  {
    method: "GET",
    path: "/api/v1/settings/executor",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const s = await childRunCall(() => childRunFeature(context.core).getChildRunSettings());
      sendJson(response, 200, { request_id: requestIdValue, data: { ...s, provider: s.executor_harness, model: s.executor_by_harness[s.executor_harness].model, effort: s.executor_by_harness[s.executor_harness].effort, timeout_ms: s.timeout_minutes * 60_000 } });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/settings/executor",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const cmd = commandEnvelope(await readRequestBody(request));
      const p = cmd.payload;
      if (p.executor_harness !== undefined || p.defaults_by_parent_harness !== undefined) {
        const result = await runCommand(context, pathname, cmd, 200, async () => {
          const saved = await childRunCall(() => childRunFeature(context.core).setChildRunSettings(p as unknown as ChildRunSettings));
          return { data: { ...saved, provider: saved.executor_harness, model: saved.executor_by_harness[saved.executor_harness].model, effort: saved.executor_by_harness[saved.executor_harness].effort, timeout_ms: saved.timeout_minutes * 60_000 } as unknown as JsonObject, version: 0 };
        });
        sendJson(response, 200, result);
        return;
      }
      if (typeof p.provider !== "string" || p.provider.length === 0 || typeof p.model !== "string" || p.model.length === 0 || !Number.isSafeInteger(p.timeout_ms) || (p.timeout_ms as number) < 0) {
        throw new ApiError(400, "validation_error", "provider、model、timeout_msをすべて指定してください。");
      }
      if (p.effort !== undefined && p.effort !== null && !(CHILD_RUN_EFFORTS as readonly string[]).includes(p.effort as string)) {
        throw new ApiError(400, "validation_error", "effortはlow、medium、high、xhigh、maxのいずれかを指定してください。");
      }
      const provider = (Object.hasOwn(HARNESS_PROVIDER_ALIASES, p.provider) ? HARNESS_PROVIDER_ALIASES[p.provider] : p.provider) as ChildRunProvider;
      if (!(CHILD_RUN_PROVIDERS as readonly string[]).includes(provider)) {
        throw new ApiError(400, "validation_error", `providerは${CHILD_RUN_PROVIDERS.join("、")}のいずれかで指定してください。`);
      }
      const model = p.model;
      const timeoutMs = p.timeout_ms as number;
      const result = await runCommand(context, pathname, cmd, 200, async () => {
        const api = childRunFeature(context.core);
        const s = await childRunCall(() => api.getChildRunSettings());
        const effort = p.effort === undefined ? s.executor_by_harness[provider].effort : p.effort as ChildRunEffort | null;
        const next: ChildRunSettings = {
          ...s,
          executor_harness: provider,
          executor_by_harness: { ...s.executor_by_harness, [provider]: { model, effort } },
          timeout_minutes: timeoutMs === 0 ? s.timeout_minutes : Math.ceil(timeoutMs / 60_000),
        };
        const saved = await childRunCall(() => api.setChildRunSettings(next));
        return { data: { ...saved, provider: saved.executor_harness, model: saved.executor_by_harness[saved.executor_harness].model, effort: saved.executor_by_harness[saved.executor_harness].effort, timeout_ms: saved.timeout_minutes * 60_000 } as unknown as JsonObject, version: 0 };
      });
      sendJson(response, 200, result);
    },
  },
  // ---- Typesafe API Key -------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/settings/typesafe",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const key = await context.core.getTypesafeApiKey();
      sendJson(response, 200, { request_id: requestIdValue, data: { typesafe_api_key: maskSecret(key) } });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/settings/typesafe",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const body = await readRequestBody(request);
      const cmd = commandEnvelope(body);
      if (typeof cmd.payload.typesafe_api_key !== "string") {
        throw new ApiError(400, "validation_error", "typesafe_api_keyが不正です。文字列を指定してください。");
      }
      const key = cmd.payload.typesafe_api_key as string;
      const result = await runCommand(context, pathname, cmd, 200, async () => {
        const saved = await context.core.setTypesafeApiKey(key);
        return { data: { typesafe_api_key: maskSecret(saved) } as JsonObject, version: 0 };
      });
      sendJson(response, 200, result);
    },
  },
  {
    method: "GET",
    path: "/api/v1/settings/advisor-folders",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      sendJson(response, 200, { request_id: requestIdValue, data: await context.core.getAdvisorFolders(), version: 0 });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/settings/advisor-folders",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const cmd = commandEnvelope(await readRequestBody(request));
      if (typeof cmd.payload.shared_dir !== "string" || typeof cmd.payload.screenshot_dir !== "string") {
        throw new ApiError(400, "validation_error", "shared_dirとscreenshot_dirは文字列で指定してください。");
      }
      const result = await runCommand(context, pathname, cmd, 200, async () => {
        try {
          const saved = await context.core.setAdvisorFolders(cmd.payload.shared_dir as string, cmd.payload.screenshot_dir as string);
          return { data: saved as unknown as JsonObject, version: 0 };
        } catch (error) {
          if (error instanceof AdvisorFolderError) {
            throw new ApiError(422, "validation_error", error.reason === "tracked"
              ? "共有フォルダはgitで追跡される場所には指定できません。.gitignoreで除外された場所かリポジトリの外を指定してください。"
              : "フォルダは絶対パスで指定してください。");
          }
          throw error;
        }
      });
      sendJson(response, 200, result);
    },
  },
  {
    method: "GET",
    path: "/api/v1/settings/advisor-send-file-destination",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const data = await fileDestinationData(context, await fileDestinationProviders(context));
      sendJson(response, 200, { request_id: requestIdValue, data, version: 0 });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/settings/advisor-send-file-destination",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const cmd = commandEnvelope(await readRequestBody(request));
      const result = await runCommand(context, pathname, cmd, 200, async () => {
        const providers = await fileDestinationProviders(context);
        await context.core.setAdvisorFileDestinationSettings(parseFileDestinationPut(cmd.payload, providers));
        return { data: await fileDestinationData(context, providers), version: 0 };
      });
      sendJson(response, 200, result);
    },
  },
  {
    method: "GET",
    path: "/api/v1/settings/knowledge-storage",
    async handle(route) {
      const { context, request, response, url } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const api = knowledgeStorageFeature(context.core);
      const status = url.searchParams.get("refresh") === "1" ? await api.checkKnowledgeStorage() : api.getKnowledgeStorage();
      sendJson(response, 200, { request_id: requestIdValue, data: status as unknown as JsonObject, version: 0 });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/settings/knowledge-storage",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const cmd = commandEnvelope(await readRequestBody(request));
      exactKeys(cmd.payload, ["path"], "payload", ["mode"]);
      const { path, mode } = cmd.payload;
      if (typeof path !== "string" || (mode !== undefined && mode !== "move" && mode !== "relink")) {
        throw new ApiError(400, "validation_error", "pathは文字列、modeはmoveまたはrelinkで指定してください。");
      }
      const api = knowledgeStorageFeature(context.core);
      const result = await runCommand(context, pathname, cmd, 200, async () => {
        try {
          return { data: await api.moveKnowledgeStorage({ path, mode }) as unknown as JsonObject, version: 0 };
        } catch (error) {
          const code = knowledgeStorageErrorCode(error);
          const status = code === "validation_error" || code === "knowledge_target_invalid" ? 422
            : code === "knowledge_storage_busy" ? 409 : code === "knowledge_move_failed" ? 500 : 0;
          if (status === 0 || !(error instanceof Error)) throw error;
          const details = (error as { details?: unknown }).details;
          throw new ApiError(status, code as ApiErrorCode, error.message, isObject(details) ? details : {});
        }
      });
      sendJson(response, 200, result);
    },
  },
  // ---- Advisor Persona ------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/settings/advisor-persona",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const advisor_persona = await context.core.getAdvisorPersona();
      sendJson(response, 200, { request_id: requestIdValue, data: { advisor_persona }, version: 0 });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/settings/advisor-persona",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const body = await readRequestBody(request);
      const cmd = commandEnvelope(body);
      if (typeof cmd.payload.advisor_persona !== "string") {
        throw new ApiError(400, "validation_error", "advisor_personaが不正です。文字列を指定してください。", { field: "advisor_persona" });
      }
      const advisorPersona = (cmd.payload.advisor_persona as string).trim();
      if (advisorPersona.length > MAX_ADVISOR_PERSONA_LENGTH) {
        throw new ApiError(400, "validation_error", `advisor_personaは${MAX_ADVISOR_PERSONA_LENGTH}文字以内で指定してください。`, {
          field: "advisor_persona",
          max_length: MAX_ADVISOR_PERSONA_LENGTH,
        });
      }
      const result = await runCommand(context, pathname, cmd, 200, async () => {
        const saved = await context.core.setAdvisorPersona(advisorPersona);
        return { data: { advisor_persona: saved } as JsonObject, version: 0 };
      });
      sendJson(response, 200, result);
    },
  },
  // ---- Provider Management ---------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/providers/pauses",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const pauses = await context.core.listProviderPauses();
      sendJson(response, 200, { request_id: requestIdValue, data: { pauses } });
    },
  },
  {
    method: "POST",
    path: "/api/v1/providers/pauses/{provider}/resume",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const provider = decodeRouteValue(route.params.provider!, "provider");
      const pause = await context.core.resumeProviderPause(provider);
      sendJson(response, 200, { request_id: requestIdValue, data: { pause } });
    },
  },
  {
    method: "GET",
    path: "/api/v1/settings/providers",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const providers = await context.core.listProviders();
      sendJson(response, 200, { request_id: requestIdValue, data: providers });
    },
  },
  {
    method: "GET",
    path: "/api/v1/settings/providers/{id}",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const providerId = decodeRouteValue(route.params.id!, "provider");
      const provider = await context.core.getProvider(providerId);
      if (!provider) {
        throw new ApiError(404, "not_found", `指定されたプロバイダーが見つかりません: ${providerId}`);
      }
      sendJson(response, 200, { request_id: requestIdValue, data: provider });
    },
  },
  {
    method: "POST",
    path: "/api/v1/settings/providers",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const body = await readRequestBody(request);
      const cmd = commandEnvelope(body);
      const p = cmd.payload;
      const id = stringField(p.id, "id", 1, 64);
      const displayName = stringField(p.displayName, "displayName", 1, 128);
      const harnessId = stringField(p.harnessId, "harnessId", 1, 32);
      const backendUrl = p.backendUrl === undefined ? undefined : stringField(p.backendUrl, "backendUrl", 1, 2_000);
      const apiKeySource = p.apiKeySource === undefined ? undefined : stringField(p.apiKeySource, "apiKeySource", 1, 256);
      const result = await runCommand(context, pathname, cmd, 201, async () => {
        const saved = await context.core.saveProvider(id, {
          displayName,
          harnessId,
          backendUrl,
          apiKeySource,
        });
        return { data: saved as unknown as JsonObject, version: 0 };
      });
      sendJson(response, 201, result);
    },
  },
  {
    method: "PUT",
    path: "/api/v1/settings/providers/{id}",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const providerId = decodeRouteValue(route.params.id!, "provider");
      const body = await readRequestBody(request);
      const cmd = commandEnvelope(body);
      const p = cmd.payload;
      const result = await runCommand(context, pathname, cmd, 200, async () => {
        const saved = await context.core.saveProvider(providerId, {
          displayName: stringField(p.displayName, "displayName", 1, 128),
          harnessId: stringField(p.harnessId, "harnessId", 1, 32),
          backendUrl: p.backendUrl === undefined ? undefined : stringField(p.backendUrl, "backendUrl", 1, 2_000),
          apiKeySource: p.apiKeySource === undefined ? undefined : stringField(p.apiKeySource, "apiKeySource", 1, 256),
        });
        return { data: saved as unknown as JsonObject, version: 0 };
      });
      sendJson(response, 200, result);
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/settings/providers/{id}",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const providerId = decodeRouteValue(route.params.id!, "provider");
      const body = await readRequestBody(request);
      const cmd = commandEnvelope(body);
      const result = await runCommand(context, pathname, cmd, 200, async () => {
        const deleted = await context.core.deleteProvider(providerId);
        return { data: deleted as unknown as JsonObject, version: 0 };
      });
      sendJson(response, 200, result);
    },
  },
  // ---- Provider Models (user-managed) ----------------------------------------
  {
    method: "GET",
    path: "/api/v1/settings/provider-models",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const models = await context.core.getProviderModels();
      sendJson(response, 200, { request_id: requestIdValue, data: models });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/settings/provider-models/{id}",
    async handle(route) {
      const { context, request, response, pathname } = route;
      requireOwner(request);
      const providerId = decodeRouteValue(route.params.id!, "provider");
      const body = await readRequestBody(request);
      const cmd = commandEnvelope(body);
      if (!Array.isArray(cmd.payload.models) || !cmd.payload.models.every((m: unknown): m is string => typeof m === "string")) {
        throw new ApiError(400, "validation_error", "modelsが不正です。文字列の配列を指定してください。");
      }
      const result = await runCommand(context, pathname, cmd, 200, async () => {
        const models = await context.core.setProviderModels(providerId, cmd.payload.models as string[]);
        return { data: { models } as unknown as JsonObject, version: 0 };
      });
      sendJson(response, 200, result);
    },
  },
  {
    method: "POST",
    path: "/api/v1/settings/providers/{id}/test",
    async handle(route) {
      const { context, request, response } = route;
      const requestIdValue = route.requestId;
      requireOwner(request);
      const providerId = decodeRouteValue(route.params.id!, "provider");
      const result = await context.core.testProvider(providerId);
      sendJson(response, 200, { request_id: requestIdValue, data: result });
    },
  },
];
