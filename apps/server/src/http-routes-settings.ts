import { requireAdapterFeature, requireCoreFeature } from "./core-feature.js";
import { ApiError, type ApiErrorCode } from "./errors.js";
import { SettingsRouteMessages as RS } from "./messages/routes-settings.js";
import { AdvisorFolderError } from "./advisor-folders.js";
import {
  parseFileDestinationPut,
  buildFileDestinationCandidates,
  isDefaultAvailable,
  type FileDestinationProviderView,
} from "./advisor-file-destination-settings.js";
import {
  advisorWindowFeature,
  assertSameOriginWrite,
  childRunCall,
  childRunFeature,
  commandEnvelope,
  decodeRouteValue,
  exactKeys,
  inviteOwnerToChannel,
  isObject,
  knowledgeStorageErrorCode,
  knowledgeStorageFeature,
  pathId,
  readRequestBody,
  requestOwnerLanguage,
  requireChannelAdmin,
  requireOwner,
  runCommand,
  sendJson,
  slackOwnerUserId,
  stringField,
  windowChannelError,
  type ApiRoute,
  type RequestContext,
  requestId,
  CHANNEL_PROVIDERS,
} from "./http-common.js";
import { validateKnowledgeAutomationSettings } from "@owl/shared/knowledge-automation";
import { validatePlanUsageSettings } from "@owl/shared/plan-usage-settings";
import { validateDependencySummarySettings } from "@owl/shared/dependency-summary-settings";
import { validateAdvisorWindowSettings } from "@owl/shared/advisor-window-settings";
import { validateVerificationPolicyPatch } from "@owl/shared/verification-policy-settings";
import { validateReviewLimitSettings } from "@owl/shared/review-limit-settings";
import { REMAKE_LIMIT_SETTINGS_KEYS, validateRemakeLimitSettings } from "@owl/shared/remake-limit-settings";
import { validateAutoRecoverySettings } from "@owl/shared/auto-recovery-settings";
import { validateFixerEscalationSettings } from "@owl/shared/fixer-escalation-settings";
import { validateReviewRoutingSettings } from "@owl/shared/review-routing-settings";
import { isOwnerLanguage } from "@owl/shared/owner-language";
import type { ChildRunSettings } from "@owl/shared/child-runs";
import type { CorePort, IntegrationProvider, JsonObject, ProcessSkillsSettingsInput, IntegrationConfigPatch, RoleModelSettingInput } from "./types.js";
import { isUlid } from "./ids.js";
import { parseChannelIds } from "./integration-store.js";
import { MODEL_PRESET_NAME_MAX_LENGTH, MODEL_SETTING_EFFORTS, MODEL_SETTING_ROLES } from "@owl/shared/default-role-models";
import { settingsReason } from "@owl/core/dist/settings-store.js";
import { SettingsValidationError } from "@owl/shared/settings-validation";

const MAX_ADVISOR_PERSONA_LENGTH = 8_000;

function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

function validatedSettings<T>(validate: (value: unknown) => T, value: unknown, status: 400 | 422 = 400): T {
  try {
    return validate(value);
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      throw new ApiError(status, "validation_error", error.message, { field: error.field, reason: settingsReason(error) });
    }
    throw error;
  }
}

function maskSecret(secret: string): string {
  return secret.length > 4 ? "*".repeat(secret.length - 4) + secret.slice(-4) : secret ? "****" : "";
}

export function validateIntegrationPayload(
  payload: JsonObject,
  provider: IntegrationProvider,
  existingConfigured: boolean,
): IntegrationConfigPatch {
  const allowed = new Set([
    "bot_token",
    "app_token",
    "channel_id",
    "conversation_channel_id",
    "notification_channel_id",
    "account_id",
    "owner_user_id",
  ]);
  const extra = Object.keys(payload).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new ApiError(400, "validation_error", RS.integrationExtra(), { extra });
  }

  const result: IntegrationConfigPatch = {};
  const stringFields: Array<keyof IntegrationConfigPatch> = [
    "bot_token",
    "app_token",
    "channel_id",
    "conversation_channel_id",
    "notification_channel_id",
    "account_id",
    "owner_user_id",
  ];
  for (const field of stringFields) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    if (typeof payload[field] !== "string") {
      throw new ApiError(400, "validation_error", RS.fieldNotString({ field }), { field });
    }
    const value = (payload[field] as string).trim();
    if (field === "owner_user_id") {
      if (provider !== "slack" || value.length > 64 || /\s/u.test(value)) {
        throw new ApiError(400, "validation_error", RS.ownerUserId(), { field });
      }
      result[field] = value;
      continue;
    }
    const max = field === "account_id" ? 26 : 4096;
    if (value.length === 0 || value.length > max) {
      throw new ApiError(400, "validation_error", RS.fieldLength({ field, max }), { field });
    }
    result[field] = value;
  }

  if (result.account_id !== undefined && !isUlid(result.account_id)) {
    throw new ApiError(400, "validation_error", RS.accountId(), { field: "account_id" });
  }
  if (!existingConfigured) {
    if (!result.bot_token) {
      throw new ApiError(400, "validation_error", RS.botToken(), { field: "bot_token" });
    }
    if (provider === "slack" && !result.app_token) {
      throw new ApiError(400, "validation_error", RS.appToken(), { field: "app_token" });
    }
    if (!result.channel_id && !result.conversation_channel_id && !result.notification_channel_id) {
      throw new ApiError(400, "validation_error", RS.channelId(), { field: "conversation_channel_id" });
    }
  }
  return result;
}

const MODEL_SETTING_ROLE_SET: ReadonlySet<string> = new Set(MODEL_SETTING_ROLES);

function validateRoleModelSettingInput(value: unknown, index: number): RoleModelSettingInput {
  if (!isObject(value)) {
    throw new ApiError(400, "validation_error", RS.roleNotObject({ index }));
  }
  exactKeys(value, ["role", "provider", "model", "effort"], `roles[${index}]`);
  if (typeof value.role !== "string" || !MODEL_SETTING_ROLE_SET.has(value.role)) {
    throw new ApiError(400, "validation_error", RS.roleInvalid({ index }));
  }
  const provider = stringField(value.provider, `roles[${index}].provider`, 1, 200);
  const model = stringField(value.model, `roles[${index}].model`, 1, 200);
  if (typeof value.effort !== "string" || !MODEL_SETTING_EFFORTS.includes(value.effort)) {
    throw new ApiError(400, "validation_error", RS.effortInvalid({ index }));
  }
  return { role: value.role as RoleModelSettingInput["role"], provider, model, effort: value.effort as RoleModelSettingInput["effort"] };
}

function validateUpdateModelSettingsPayload(payload: JsonObject): { roles: RoleModelSettingInput[] } {
  exactKeys(payload, ["roles"], "UpdateModelSettings payload");
  if (!Array.isArray(payload.roles) || payload.roles.length !== MODEL_SETTING_ROLE_SET.size) {
    throw new ApiError(400, "validation_error", RS.rolesCount({ count: MODEL_SETTING_ROLE_SET.size }));
  }
  const roles = payload.roles.map((item, index) => validateRoleModelSettingInput(item, index));
  const seenRoles = new Set(roles.map((role) => role.role));
  if (seenRoles.size !== roles.length) {
    throw new ApiError(400, "validation_error", RS.rolesDuplicate());
  }
  for (const role of MODEL_SETTING_ROLE_SET) {
    if (!seenRoles.has(role as RoleModelSettingInput["role"])) {
      throw new ApiError(400, "validation_error", RS.roleMissing({ role, count: MODEL_SETTING_ROLE_SET.size }));
    }
  }
  return { roles };
}

function validateModelPresetName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length < 1 || name.length > MODEL_PRESET_NAME_MAX_LENGTH) throw new ApiError(400, "validation_error", RS.presetName({ max: MODEL_PRESET_NAME_MAX_LENGTH }), { field: "name" });
  return name;
}

function validateCreateModelPresetPayload(payload: JsonObject): { name: string; roles: RoleModelSettingInput[] } {
  exactKeys(payload, ["name", "roles"], "CreateModelPreset payload");
  return { name: validateModelPresetName(payload.name), roles: validateUpdateModelSettingsPayload({ roles: payload.roles }).roles };
}

function validateUpdateModelPresetPayload(payload: JsonObject): { name?: string; roles?: RoleModelSettingInput[] } {
  const keys = Object.keys(payload);
  if (keys.length === 0 || keys.some((key) => key !== "name" && key !== "roles")) {
    throw new ApiError(400, "validation_error", RS.presetUpdateEmpty());
  }
  return {
    ...(Object.hasOwn(payload, "name") ? { name: validateModelPresetName(payload.name) } : {}),
    ...(Object.hasOwn(payload, "roles") ? { roles: validateUpdateModelSettingsPayload({ roles: payload.roles }).roles } : {}),
  };
}

/** Per-provider candidates for the Web send_file destination; names come from Slack/Discord when the Connector runs. */
async function fileDestinationProviders(context: RequestContext): Promise<FileDestinationProviderView[]> {
  const statuses = await context.core.getIntegrations();
  const windows = await advisorWindowFeature(context.core).listAdvisorWindows();
  const names = new Map<string, string>();
  const integrations = [];
  for (const provider of CHANNEL_PROVIDERS) {
    const status = statuses.find((entry) => entry.provider === provider);
    const admin = context.channelAdmins?.channelAdmin(provider) ?? null;
    const conversationChannelIds = parseChannelIds(status?.conversation_channel_id ?? undefined);
    for (const id of conversationChannelIds) {
      const info = admin ? await admin.describeChannel(id).catch(() => null) : null;
      if (info?.name) names.set(`${provider}:${id}`, info.name);
    }
    integrations.push({ provider, configured: status?.configured ?? false, running: admin !== null, conversationChannelIds });
  }
  return buildFileDestinationCandidates(integrations, windows, names);
}

async function fileDestinationData(context: RequestContext, providers: FileDestinationProviderView[]): Promise<JsonObject> {
  const settings = await context.core.getAdvisorFileDestinationSettings();
  return {
    preferred_provider: settings.preferredProvider,
    default_destination: settings.defaultDestination
      ? { ...settings.defaultDestination, available: isDefaultAvailable(settings, providers) }
      : null,
    providers: providers as unknown as JsonObject[],
  };
}


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
const VERIFICATION_POLICY_UNAVAILABLE = { code: "dependency_unavailable", message: RS.noVerificationPolicy() } as const;

/** 今の requireSkillApi と同じく、13個すべてを確かめる。1個でも無ければ 503 core_not_ready。 */
const skillFeature = (core: CorePort) => requireAdapterFeature(core, [
  "getSkillActivity", "listSkills", "getSkill", "readSkillFile", "listSkillRevisions", "getSkillRevision", "restoreSkill",
  "updateSkill", "listSkillProposals", "approveSkillProposal", "rejectSkillProposal", "getSkillSettings", "setSkillSettings",
], { code: "core_not_ready", message: RS.noSkillBox() });

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
        { code: "dependency_unavailable", message: RS.noRemakeLimits() });
      const fixerEscalationApi = requireCoreFeature(context.core, ["getFixerEscalationSettings", "setFixerEscalationSettings"],
        { code: "dependency_unavailable", message: RS.noFixerEscalation() });
      const autoRecoveryApi = requireCoreFeature(context.core, ["getAutoRecoverySettings", "setAutoRecoverySettings"],
        { code: "dependency_unavailable", message: RS.noAutoRecovery() });
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
      { code: "dependency_unavailable", message: RS.noDependencySummary() }),
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
          throw new ApiError(400, "validation_error", error instanceof Error ? error.message : RS.verificationInvalid(), isObject(error.details) ? error.details : {});
        }
        if (isObject(error) && error.code === "verification_policy_storage_invalid") {
          throw new ApiError(409, "verification_policy_storage_invalid", error instanceof Error ? error.message : RS.verificationStorageInvalid(), isObject(error.details) ? error.details : {});
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
      { code: "dependency_unavailable", message: RS.noReviewLimits() }),
    get: (api) => api.getReviewLimitSettings(),
    set: (api, input) => api.setReviewLimitSettings(input),
  }),
  ...settingsRoutes({
    path: "/api/v1/settings/remake-limits",
    exactKeys: { keys: REMAKE_LIMIT_SETTINGS_KEYS, label: "Remake limits payload" },
    validate: validateRemakeLimitSettings,
    feature: (core) => requireCoreFeature(core, ["getRemakeLimitSettings", "setRemakeLimitSettings"],
      { code: "dependency_unavailable", message: RS.noRemakeLimits() }),
    get: (api) => api.getRemakeLimitSettings(),
    set: (api, input) => api.setRemakeLimitSettings(input),
  }),
  ...settingsRoutes({
    path: "/api/v1/settings/fixer-escalation",
    validate: validateFixerEscalationSettings,
    feature: (core) => requireCoreFeature(core, ["getFixerEscalationSettings", "setFixerEscalationSettings"],
      { code: "dependency_unavailable", message: RS.noFixerEscalation() }),
    get: (api) => api.getFixerEscalationSettings(),
    set: (api, input) => api.setFixerEscalationSettings(input),
  }),
  ...settingsRoutes({
    path: "/api/v1/settings/auto-recovery",
    validate: validateAutoRecoverySettings,
    feature: (core) => requireCoreFeature(core, ["getAutoRecoverySettings", "setAutoRecoverySettings"],
      { code: "dependency_unavailable", message: RS.noAutoRecovery() }),
    get: (api) => api.getAutoRecoverySettings(),
    set: (api, input) => api.setAutoRecoverySettings(input),
  }),
  ...settingsRoutes({
    path: "/api/v1/settings/review-routing",
    validate: validateReviewRoutingSettings,
    feature: (core) => requireCoreFeature(core, ["getReviewRoutingSettings", "setReviewRoutingSettings"],
      { code: "dependency_unavailable", message: RS.noReviewRouting() }),
    get: (api) => api.getReviewRoutingSettings(),
    set: (api, input) => api.setReviewRoutingSettings(input),
  }),
  ...settingsRoutes({
    path: "/api/v1/settings/plan-usage",
    exactKeys: { keys: ["claude_usage_api_enabled", "poll_interval_minutes"], label: "Plan usage settings payload" },
    validate: validatePlanUsageSettings,
    feature: (core) => requireCoreFeature(core, ["getPlanUsage", "refreshPlanUsage", "getPlanUsageSettings", "setPlanUsageSettings"],
      { code: "dependency_unavailable", message: RS.noPlanUsage() }),
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
        throw new ApiError(400, "validation_error", RS.processSkills());
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
        throw new ApiError(400, "validation_error", RS.hybridMode());
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
        throw new ApiError(400, "validation_error", RS.language());
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
        throw new ApiError(400, "validation_error", RS.typesafeKey());
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
        throw new ApiError(400, "validation_error", RS.foldersNotString());
      }
      const result = await runCommand(context, pathname, cmd, 200, async () => {
        try {
          const saved = await context.core.setAdvisorFolders(cmd.payload.shared_dir as string, cmd.payload.screenshot_dir as string);
          return { data: saved as unknown as JsonObject, version: 0 };
        } catch (error) {
          if (error instanceof AdvisorFolderError) {
            throw new ApiError(422, "validation_error", error.reason === "tracked"
              ? RS.folderTracked()
              : RS.folderNotAbsolute());
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
        throw new ApiError(400, "validation_error", RS.pathMode());
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
        throw new ApiError(400, "validation_error", RS.personaNotString(), { field: "advisor_persona" });
      }
      const advisorPersona = (cmd.payload.advisor_persona as string).trim();
      if (advisorPersona.length > MAX_ADVISOR_PERSONA_LENGTH) {
        throw new ApiError(400, "validation_error", RS.personaTooLong({ max: MAX_ADVISOR_PERSONA_LENGTH }), {
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
        throw new ApiError(404, "not_found", RS.providerNotFound({ providerId }));
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
        throw new ApiError(400, "validation_error", RS.modelsInvalid());
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
