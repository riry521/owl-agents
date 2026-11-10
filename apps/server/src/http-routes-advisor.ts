import { createHash } from "node:crypto";

import { MAX_MESSAGE_ATTACHMENTS, MAX_UPLOAD_BYTES } from "../../../packages/core/dist/upload-limits.js";
import type { WebAttachmentTarget } from "../../../packages/core/dist/core.js";
import { GENERAL_WINDOW_KEY } from "../../../packages/shared/dist/advisor-windows.js";
import { defaultChannelName } from "../../../packages/shared/dist/advisor-window-settings.js";
import { ADVISOR_CURATION_ACTION_TYPES, ADVISOR_WORKSPACE_API_PATH, ADVISOR_WORKSPACE_FINISH_API_PATH, advisorCurationKind } from "../../../packages/shared/dist/index.js";

import { requireAdapterFeature, requireCoreFeature } from "./core-feature.js";
import { ApiError } from "./errors.js";
import { createUlid, isUlid } from "./ids.js";
import {
  ADVISOR_ACTION_TYPES, CHANNEL_PROVIDERS, advisorDeliveryCall, advisorSessionDatabase, advisorWindowFeature, channelBindingBody, channelCall,
  channelNameFromPayload, channelProvider, commandEnvelope, decisionWorkId, exactKeys, headerValue, integrationOf, inviteOwnerToChannel,
  isJsonContentType, isObject, nullableQuery, parseLimit, pathId, projectNameOf, readRawBody, readRequestBody, requestUrl, requireChannelAdmin,
  requireGuard, requireOwner, resolveAdvisorSessionWindow, runCommand, sendApiError, sendJson, slackOwnerUserId, stringField,
  validateAnswerPayload, validateCreateWorkPayload, validateInboundMessage, validatePostMessagePayload, validateStartPayload,
  validateUpdateWorkPayload, validateUploadComplete, validateUploadRegister, validateWorkInstructionPayload, withWorkLock,
  type ApiRoute, type RouteRequest,
} from "./http-common.js";
import type { JsonObject } from "./types.js";

async function advisorWorkspace(route: RouteRequest): Promise<void> {
  const { context, request, response, pathname } = route; const requestIdValue = route.requestId;
  // セッションは guard token の agent_run_id で決まるので、Advisor 本人以外は呼べない
  const agent = requireGuard(request, context.guardTokens);
  if (agent?.role !== "advisor") throw new ApiError(403, "forbidden", "Only a running Advisor session can prepare or finish its workspace.");
  const body = await readRequestBody(request);
  if (!isObject(body)) throw new ApiError(400, "validation_error", "リクエスト本文はJSON objectで指定してください。");
  exactKeys(body, [], "AdvisorWorkspace payload", ["project_id"]);
  const projectId = body.project_id === undefined || body.project_id === null ? null : stringField(body.project_id, "project_id", 1, 64);
  const api = requireCoreFeature(context.core, ["prepareAdvisorWorkspaceForSession", "finishAdvisorWorkspaceForSession"], { code: "dependency_unavailable", message: "The loaded Core does not support Advisor workspaces." });
  let data: unknown;
  try {
    const session = { session_id: agent.agent_run_id, project_id: projectId };
    data = pathname === ADVISOR_WORKSPACE_FINISH_API_PATH
      ? await api.finishAdvisorWorkspaceForSession(session)
      : await api.prepareAdvisorWorkspaceForSession(session);
  } catch (error) {
    if (error instanceof Error && error.name === "AdvisorSessionNotFoundError") throw new ApiError(404, "advisor_session_not_found", error.message);
    throw error;
  }
  const result = data as { ok: boolean; error_code: string | null; message: string };
  if (!result.ok) {
    if (result.error_code === "project_not_found" || result.error_code === "conversation_not_found") throw new ApiError(404, result.error_code, result.message);
    throw new ApiError(409, "advisor_workspace_unavailable", result.message, { error_code: result.error_code, message: result.message });
  }
  sendJson(response, 200, { request_id: requestIdValue, data, version: 0 });
  return;
}

async function advisorActions(route: RouteRequest): Promise<void> {
  const { context, request, response } = route;
  requireOwner(request);
  const command = commandEnvelope(await readRequestBody(request));
  exactKeys(command.payload, ["invocation_id", "actions"], "AdvisorActions payload");
  if (!isUlid(command.payload.invocation_id)) throw new ApiError(400, "validation_error", "invocation_idはULIDで指定してください。");
  if (!Array.isArray(command.payload.actions)) throw new ApiError(400, "validation_error", "actionsは配列で指定してください。");
  const actions = command.payload.actions.map((value, index) => {
    if (!isObject(value)) throw new ApiError(400, "validation_error", `actions[${index}]はJSON objectで指定してください。`);
    // A curation action takes no input beyond an optional reason, so its
    // payload may be omitted or null; every other action still needs one.
    // `has` (not an object lookup) keeps inherited keys such as "constructor"
    // out of that decision.
    const curation = typeof value.type === "string" && ADVISOR_CURATION_ACTION_TYPES.has(value.type)
      ? advisorCurationKind(value.type)
      : null;
    exactKeys(
      value,
      curation === null
        ? ["action_id", "sequence", "type", "payload", "expected_version"]
        : ["action_id", "sequence", "type", "expected_version"],
      `actions[${index}]`,
      curation === null ? [] : ["payload"],
    );
    const action_id = stringField(value.action_id, `actions[${index}].action_id`, 1, 200);
    if (!Number.isSafeInteger(value.sequence)) throw new ApiError(400, "validation_error", `actions[${index}].sequenceが不正です。`);
    if (typeof value.type !== "string" || !ADVISOR_ACTION_TYPES.has(value.type)) {
      throw new ApiError(422, "action_rejected", `actions[${index}].typeは許可されたAdvisor actionではありません。`);
    }
    if (curation === null) {
      if (!isObject(value.payload)) throw new ApiError(400, "validation_error", `actions[${index}].payloadが不正です。`);
    } else {
      // Only an optional reason is accepted; anything else is a contract
      // mismatch rather than something to pass through to the curation.
      if (value.payload !== undefined && value.payload !== null && !isObject(value.payload)) {
        throw new ApiError(400, "validation_error", `actions[${index}].payloadが不正です。`);
      }
      exactKeys(isObject(value.payload) ? value.payload : {}, [], `actions[${index}].payload`, ["reason"]);
    }
    if (!Number.isInteger(value.expected_version) || Number(value.expected_version) < 0) {
      throw new ApiError(400, "validation_error", `actions[${index}].expected_versionが不正です。0以上の整数を指定してください。`);
    }
    return { action_id, sequence: Number(value.sequence), type: value.type, payload: isObject(value.payload) ? value.payload : {}, expected_version: Number(value.expected_version) };
  }).sort((left, right) => left.sequence - right.sequence);
  const seenActionIds = new Set<string>();
  if (actions.some((action) => seenActionIds.has(action.action_id) || (seenActionIds.add(action.action_id), false))) {
    throw new ApiError(409, "action_id_conflict", "同じAdvisor action batchに重複したaction_idがあります。");
  }
  const results: Array<{ action_id: string; status: "executed" | "rejected" | "not_run"; result: JsonObject | null; error_code: string | null }> = [];
  for (const action of actions) {
    try {
      const payload = action.payload;
      let data: JsonObject;
      const actionCommand = { request_id: command.request_id, idempotency_key: `${command.idempotency_key}:${action.action_id}`, expected_version: action.expected_version };
      if (action.type === "create_work") {
        const createPayload = {
          title: payload.title,
          summary: payload.summary ?? "",
          size: payload.size ?? "normal",
          project_id: payload.project_id ?? null,
          ...(payload.design_mode === undefined ? {} : { design_mode: payload.design_mode }),
          ...(payload.prerequisite_work_ids === undefined ? {} : { prerequisite_work_ids: payload.prerequisite_work_ids }),
        } as JsonObject;
        data = (await context.core.createWork(validateCreateWorkPayload(createPayload), actionCommand)).data as unknown as JsonObject;
      } else if (action.type === "start_work") {
        const workId = pathId(stringField(payload.work_id, "work_id", 1, 128), "work_id");
        const mode = payload.mode === undefined ? "normal" : validateStartPayload({ mode: payload.mode });
        data = (await withWorkLock(context, workId, async () => context.core.startWork(workId, mode, actionCommand))).data as unknown as JsonObject;
      } else if (action.type === "pause_work") {
        const workId = pathId(stringField(payload.work_id, "work_id", 1, 128), "work_id");
        data = (await withWorkLock(context, workId, async () => context.core.pauseWork(workId, typeof payload.reason === "string" ? payload.reason : "Advisor requested pause.", actionCommand))).data as unknown as JsonObject;
      } else if (action.type === "reopen_work") {
        const workId = pathId(stringField(payload.work_id, "work_id", 1, 128), "work_id");
        data = (await withWorkLock(context, workId, async () => context.core.reopenWork(workId, typeof payload.reason === "string" ? payload.reason : "Advisor requested reopen.", actionCommand))).data as unknown as JsonObject;
      } else if (action.type === "cancel_work") {
        const workId = pathId(stringField(payload.work_id, "work_id", 1, 128), "work_id");
        data = (await withWorkLock(context, workId, async () => context.core.cancelWork(workId, typeof payload.reason === "string" ? payload.reason : "Advisor requested cancellation.", payload.force === true, actionCommand))).data as unknown as JsonObject;
      } else if (action.type === "delete_work") {
        const workId = pathId(stringField(payload.work_id, "work_id", 1, 128), "work_id");
        data = (await withWorkLock(context, workId, async () => {
          const current = await context.core.getWork(workId);
          return context.core.deleteWork(workId, { ...actionCommand, expected_version: current.state_version });
        })).data as unknown as JsonObject;
      } else if (action.type === "send_work_instruction") {
        exactKeys(payload, ["work_id", "body"], `actions[${action.action_id}].payload`, ["reopen"]);
        const workId = pathId(stringField(payload.work_id, "work_id", 1, 128), "work_id");
        const input = validateWorkInstructionPayload({ body: payload.body, ...(payload.reopen === undefined ? {} : { reopen: payload.reopen }) });
        data = (await withWorkLock(context, workId, async () => context.core.postWorkInstruction(workId, input, actionCommand))).data as unknown as JsonObject;
      } else if (action.type === "update_work") {
        exactKeys(payload, ["work_id"], `actions[${action.action_id}].payload`, ["title", "summary"]);
        const workId = pathId(stringField(payload.work_id, "work_id", 1, 128), "work_id");
        const input = validateUpdateWorkPayload(payload);
        data = (await withWorkLock(context, workId, async () => context.core.updateWork(workId, input, actionCommand))).data as unknown as JsonObject;
      } else if (action.type === "resume_work") {
        exactKeys(payload, ["work_id"], `actions[${action.action_id}].payload`, ["body"]);
        const workId = pathId(stringField(payload.work_id, "work_id", 1, 128), "work_id");
        const body = payload.body === undefined ? undefined : stringField(payload.body, "body", 1, 10000);
        data = (await withWorkLock(context, workId, async () => context.core.resumeWorkOrRetryDecision(workId, actionCommand, body))).data as unknown as JsonObject;
      } else if (action.type === "answer_decision") {
        const decisionId = pathId(stringField(payload.decision_id, "decision_id", 1, 128), "decision_id");
        const answer = stringField(payload.answer, "answer", 1, 10000);
        const option_key = payload.option_key === undefined || payload.option_key === null ? null : stringField(payload.option_key, "option_key", 1, 200);
        const decisionWork = decisionWorkId(context, decisionId);
        const operation = () => context.core.answerDecision(decisionId, { answer, option_key, source: "advisor", source_message_id: null }, actionCommand);
        data = (await (decisionWork === undefined ? operation() : withWorkLock(context, decisionWork, operation))).data as unknown as JsonObject;
      } else if (ADVISOR_CURATION_ACTION_TYPES.has(action.type)) {
        const kind = advisorCurationKind(action.type);
        if (kind === null) throw new ApiError(422, "action_rejected", `${action.type}は許可されたAdvisor actionではありません。`);
        const { run, started } = await requireAdapterFeature(context.core, ["runCuration", "startCurationInBackground", "listCurationRuns", "getCurationRun"], { code: "core_not_ready", message: "The loaded Core does not support the curation run API." }).startCurationInBackground({
          kind,
          trigger: "advisor_action",
          actor: "advisor",
          actor_ref: command.request_id,
          request_key: actionCommand.idempotency_key,
        }) as { run: { id: string; status: string; summary: string }; started: boolean };
        data = { run_id: run.id, status: run.status, started, summary: run.summary };
      } else {
        throw new ApiError(422, "action_rejected", "send_fileは配送先Connectorが設定されている場合だけ実行できます。");
      }
      results.push({ action_id: action.action_id, status: "executed", result: data, error_code: null });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      results.push({ action_id: action.action_id, status: "rejected", result: null, error_code: error.code });
    }
  }
  sendJson(response, 200, { request_id: command.request_id, data: { results }, version: command.expected_version });
  return;
}

async function conversationClear(route: RouteRequest): Promise<void> {
  const { context, request, response, pathname } = route;
  requireOwner(request);
  const conversationId = pathId(route.params.conversation_id as string, "conversation_id");
  const body = await readRequestBody(request);
  const cmd = commandEnvelope(body);
  const result = await runCommand(context, pathname, cmd, 200, async () => {
    const cleared = await context.core.clearConversation(conversationId);
    return { data: cleared as unknown as JsonObject, version: 0 };
  });
  sendJson(response, 200, result);
  return;
}

async function advisorDelivery(route: RouteRequest): Promise<void> {
  const { context, request, response } = route;
  const ownerId = requireOwner(request);
  const conversationId = pathId(route.params.conversation_id as string, "conversation_id");
  const command = commandEnvelope(await readRequestBody(request));
  const api = requireCoreFeature(context.core, ["reportAdvisorDelivery"], { code: "dependency_unavailable", message: "The loaded Core does not accept Advisor delivery reports." });
  const data = await advisorDeliveryCall(() => api.reportAdvisorDelivery(ownerId, conversationId, command.payload));
  sendJson(response, 200, { request_id: command.request_id, data, version: 0 });
  return;
}

async function inboundMessage(route: RouteRequest): Promise<void> {
  const { context, request, response } = route;
  const ownerId = requireOwner(request);
  const requestHeader = headerValue(request, "x-request-id");
  const idempotencyHeader = headerValue(request, "idempotency-key");
  if (!requestHeader || !idempotencyHeader) {
    throw new ApiError(400, "validation_error", "X-Request-IdとIdempotency-Key headerは必須です。");
  }
  const raw = await readRequestBody(request);
  if (!isObject(raw)) throw new ApiError(400, "validation_error", "Inbound messageはJSON objectで指定してください。");
  const payload = validateInboundMessage(raw);
  const command = { request_id: stringField(requestHeader, "X-Request-Id", 1, 128), idempotency_key: stringField(idempotencyHeader, "Idempotency-Key", 1, 128), expected_version: 0 };
  const result = await context.core.ingestInbound(ownerId, payload, command);
  const data = result.data;
  sendJson(response, 202, {
    request_id: data.request_id,
    ack_id: data.ack_id,
    message_id: data.message_id,
    event_id: data.event_id,
    deduplicated: data.deduplicated,
    status: data.status,
  });
  return;
}

async function inboundUploadRegister(route: RouteRequest): Promise<void> {
  const { context, request, response } = route;
  const ownerId = requireOwner(request);
  const payload = validateUploadRegister(await readRequestBody(request));
  const requestHeader = headerValue(request, "x-request-id") ?? route.requestId;
  const idempotencyHeader = headerValue(request, "idempotency-key") ?? `${requestHeader}:upload-register`;
  const command = { request_id: stringField(requestHeader, "X-Request-Id", 1, 128), idempotency_key: stringField(idempotencyHeader, "Idempotency-Key", 1, 128), expected_version: 0 };
  const result = await context.core.registerInboundUpload(ownerId, payload, command);
  sendJson(response, 201, result.data);
  return;
}

async function uploadLimits(route: RouteRequest): Promise<void> {
  const { request, response } = route;
  requireOwner(request);
  sendJson(response, 200, { data: { max_bytes: MAX_UPLOAD_BYTES, max_files: MAX_MESSAGE_ATTACHMENTS } });
  return;
}

async function uploadContent(route: RouteRequest): Promise<void> {
  const { context, request, response } = route;
  const ownerId = requireOwner(request);
  const uploadId = pathId(route.params.upload_id as string, "upload_id");
  const contentTypeHeader = headerValue(request, "content-type");
  const contentLengthHeader = headerValue(request, "content-length");
  const digestHeader = headerValue(request, "digest");
  if (!contentTypeHeader || !contentLengthHeader || !digestHeader || !/^sha-256=/iu.test(digestHeader)) {
    throw new ApiError(400, "validation_error", "Content-Type、Content-Length、Digest: sha-256=<base64> headerは必須です。");
  }
  if (!/^\d+$/u.test(contentLengthHeader)) throw new ApiError(400, "validation_error", "Content-Lengthが不正です。");
  const content = await readRawBody(request, MAX_UPLOAD_BYTES);
  if (Number(contentLengthHeader) !== content.byteLength) throw new ApiError(400, "validation_error", "Content-Lengthと実際のupload bytesが一致しません。");
  const digestBase64 = digestHeader.slice(digestHeader.indexOf("=") + 1).trim();
  let suppliedDigest: Buffer;
  try {
    suppliedDigest = Buffer.from(digestBase64, "base64");
  } catch (error) {
    throw new ApiError(400, "validation_error", "Digest headerが不正です。", {}, { cause: error });
  }
  const actualDigest = createHash("sha256").update(content).digest();
  if (suppliedDigest.length !== actualDigest.length || !suppliedDigest.equals(actualDigest)) throw new ApiError(409, "upload_checksum_mismatch", "Digestとupload bytesが一致しません。");
  const result = await context.core.putInboundUpload(ownerId, uploadId, { content, sha256: actualDigest.toString("hex"), mime: contentTypeHeader });
  sendJson(response, 200, { data: result });
  return;
}

async function uploadComplete(route: RouteRequest): Promise<void> {
  const { context, request, response } = route;
  const ownerId = requireOwner(request);
  const uploadId = pathId(route.params.upload_id as string, "upload_id");
  const command = commandEnvelope(await readRequestBody(request));
  const payload = validateUploadComplete(command.payload);
  const result = await context.core.completeInboundUpload(ownerId, uploadId, payload, command);
  sendJson(response, 200, { data: result.data });
  return;
}

async function postMessage(route: RouteRequest): Promise<void> {
  const { context, request, response, pathname } = route;
  requireOwner(request);
  const raw = await readRequestBody(request) as JsonObject;
  const text = stringField(raw.text as string, "text", 1, 100000);
  const origin = isObject(raw.origin) ? raw.origin as { channel: string; ref?: string } : undefined;
  const source = typeof raw.source === "string" ? raw.source : "api";
  const { conversation_id: conversationId } = await context.core.getActiveConversation();
  const requestId = createUlid();
  const command = {
    request_id: requestId,
    idempotency_key: `plugin-message:${requestId}`,
    expected_version: 0,
    payload: { body: text, attachment_ids: [] } as unknown as JsonObject,
  };
  const result = await runCommand(context, pathname, command, 201, async () =>
    context.core.postMessage(conversationId, { body: text, attachment_ids: [] }, command),
  );
  const postedMessageId = (result as { data: { message_id: string } }).data.message_id;
  void context.core.advisorRespond(conversationId, postedMessageId, origin ?? { channel: source }).catch((error) => {
    console.error("[owl-server] Advisor response failed:", error);
  });
  sendJson(response, 201, result);
  return;
}

async function listMessages(route: RouteRequest): Promise<void> {
  const { context, request, response, url } = route; const requestIdValue = route.requestId;
  requireOwner(request);
  const conversationId = pathId(route.params.conversation_id as string, "conversation_id");
  const result = await context.core.listMessages(conversationId, {
    limit: parseLimit(url.searchParams.get("limit"), 50),
    cursor: nullableQuery(url.searchParams.get("cursor")),
  });
  sendJson(response, 200, { ...result, request_id: requestIdValue });
  return;
}

async function postConversationMessage(route: RouteRequest): Promise<void> {
  const { context, request, response, pathname } = route;
  requireOwner(request);
  const conversationId = pathId(route.params.conversation_id as string, "conversation_id");
  const body = await readRequestBody(request);
  const command = commandEnvelope(body);
  const payload = validatePostMessagePayload(command.payload);
  const result = await runCommand(context, pathname, command, 201, async () => context.core.postMessage(conversationId, payload, command));
  const postedMessageId = (result as { data: { message_id: string } }).data.message_id;
  void context.core.advisorRespond(conversationId, postedMessageId, { channel: "web" }).catch((error) => {
    console.error("[owl-server] Advisor response failed:", error);
  });
  sendJson(response, 201, result);
  return;
}

async function listAdvisorWindows(route: RouteRequest): Promise<void> {
  const { context, request, response } = route; const requestIdValue = route.requestId;
  requireOwner(request);
  const data = await advisorWindowFeature(context.core).listAdvisorWindows();
  sendJson(response, 200, { request_id: requestIdValue, data, version: 0 });
  return;
}

async function setAdvisorWindowOrder(route: RouteRequest): Promise<void> {
  const { context, request, response, pathname } = route;
  requireOwner(request);
  const command = commandEnvelope(await readRequestBody(request));
  const keys = isObject(command.payload) ? command.payload.keys : undefined;
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) {
    throw new ApiError(400, "validation_error", "keys must be an array of strings.", { field: "keys" });
  }
  if (new Set(keys).size !== keys.length) throw new ApiError(400, "validation_error", "keys must not contain duplicates.", { field: "keys" });
  if (keys.includes(GENERAL_WINDOW_KEY)) throw new ApiError(400, "validation_error", "The general window is always first and cannot be reordered.", { field: "keys" });
  const api = advisorWindowFeature(context.core);
  const result = await runCommand(context, pathname, command, 200, async () => ({
    data: await api.setAdvisorWindowOrder(keys) as unknown as JsonObject,
    version: 0,
  }));
  sendJson(response, 200, result);
  return;
}

async function markAdvisorWindowRead(route: RouteRequest): Promise<void> {
  const { context, request, response, pathname } = route;
  requireOwner(request);
  const key = decodeURIComponent(route.params.key as string);
  const command = commandEnvelope(await readRequestBody(request));
  const readThrough = isObject(command.payload) ? command.payload.read_through_message_id : undefined;
  if (readThrough !== undefined && (typeof readThrough !== "string" || readThrough === "")) {
    throw new ApiError(400, "validation_error", "read_through_message_id must be a message id.", { field: "read_through_message_id" });
  }
  const api = advisorWindowFeature(context.core);
  const result = await runCommand(context, pathname, command, 200, async () => {
    const data = await api.markAdvisorWindowRead(key, readThrough).catch((error: unknown) => {
      if (isObject(error) && error.code === "validation_error") {
        throw new ApiError(400, "validation_error", error instanceof Error ? error.message : "Invalid request.", { field: "read_through_message_id" }, { cause: error });
      }
      throw error;
    });
    if (!data) throw new ApiError(404, "advisor_window_not_found", "指定されたAdvisorの窓が見つかりません。窓の一覧を読み直してください。", { key });
    return { data: data as unknown as JsonObject, version: 0 };
  });
  sendJson(response, 200, result);
  return;
}

async function listChannelBindings(route: RouteRequest): Promise<void> {
  const { context, request, response, url } = route; const requestIdValue = route.requestId;
  requireOwner(request);
  const provider = url.searchParams.get("provider");
  if (provider !== "slack" && provider !== "discord") {
    throw new ApiError(400, "validation_error", "provider must be slack or discord.", { field: "provider" });
  }
  const bindings = await advisorWindowFeature(context.core).listAdvisorChannelBindings(provider);
  sendJson(response, 200, { request_id: requestIdValue, data: { bindings }, version: 0 });
  return;
}

async function getAdvisorWindowConversation(route: RouteRequest): Promise<void> {
  const { context, request, response } = route; const requestIdValue = route.requestId;
  const ownerId = requireOwner(request);
  const key = decodeURIComponent(route.params.key as string);
  const api = advisorWindowFeature(context.core);
  // Same visibility as the list: a switched-off, unbound Project's window is not found even by URL.
  const listed = (await api.listAdvisorWindows()).some((entry) => entry.key === key);
  const window = listed ? await api.ensureAdvisorWindow(ownerId, key) : null;
  if (!window) throw new ApiError(404, "advisor_window_not_found", "指定されたAdvisorの窓が見つかりません。窓の一覧を読み直してください。", { key });
  sendJson(response, 200, { request_id: requestIdValue, conversation_id: window.conversation_id, window_id: window.window_id });
  return;
}

async function getActiveConversation(route: RouteRequest): Promise<void> {
  const { context, request, response } = route; const requestIdValue = route.requestId;
  requireOwner(request);
  const result = await context.core.getActiveConversation();
  sendJson(response, 200, { ...result, request_id: requestIdValue });
  return;
}

async function advisorSession(route: RouteRequest): Promise<void> {
  const { context, request, response, pathname, method } = route; const requestIdValue = route.requestId;
  const ownerId = requireOwner(request);
  try {
    const database = advisorSessionDatabase(context.db);
    const params = requestUrl(request).searchParams;
    const target = resolveAdvisorSessionWindow(database, ownerId, nullableQuery(params.get("conversation_id")), nullableQuery(params.get("window")));
    const session = target === "missing"
      ? null
      : target && context.core.advisorSessions.getActiveSessionForWindow
        ? await context.core.advisorSessions.getActiveSessionForWindow(target.window_id)
        : await context.core.advisorSessions.getActiveSession(ownerId);
    if (!session) {
      sendJson(response, 200, { status: "none" });
      return;
    }

    const sessionRow = database?.get<{
      provider_session_id: string | null;
      provider_id: string | null;
      model: string | null;
      effort: string | null;
      created_at: string;
      resumed_count: number;
    }>(
      `SELECT provider_session_id, provider_id, model, effort, created_at, resumed_count
         FROM advisor_sessions
        WHERE id = ?`,
      session.id,
    );
    const compactionRow = database?.get<{ count: number; last_compaction_at: string | null }>(
      `SELECT COUNT(*) AS count, MAX(created_at) AS last_compaction_at
         FROM advisor_compactions
        WHERE session_id = ?`,
      session.id,
    );
    // The Web view is per conversation: with conversation_id, only that
    // conversation's turns count, so another interface's turn is not shown as thinking here.
    const turnConversationId = nullableQuery(requestUrl(request).searchParams.get("conversation_id"));
    const turnCount = (status: "queued" | "running") =>
      database?.get<{ count: number }>(
        `SELECT COUNT(*) AS count
           FROM advisor_turns
          WHERE session_id = ? AND status = ?${turnConversationId ? " AND conversation_id = ?" : ""}`,
        session.id,
        status,
        ...(turnConversationId ? [turnConversationId] : []),
      );
    const queuedRow = turnCount("queued");
    const runningRow = turnCount("running");

    // A session that has not recorded its provider yet runs on the Advisor role's configured one.
    const advisorRole = sessionRow?.provider_id?.trim()
      ? undefined
      : (await context.core.getModelSettings()).roles.find((role) => role.role === "advisor");
    const providerId = (sessionRow?.provider_id?.trim() || advisorRole?.provider?.trim() || "anthropic").toLowerCase();
    const pauseAliases = providerId === "anthropic" || providerId === "claude"
      ? ["anthropic", "claude"]
      : providerId === "openai" || providerId === "codex" || providerId === "openai/codex"
        ? ["openai", "codex", "openai/codex"]
        : providerId === "opencode"
          ? ["opencode"]
          : [providerId];
    const pause = (await context.core.listProviderPauses()).find(
      (entry) => entry.state === "paused" && pauseAliases.includes(entry.provider.toLowerCase()),
    );

    sendJson(response, 200, {
      status: session.status,
      window_id: session.window_id ?? null,
      provider_session_id: sessionRow ? sessionRow.provider_session_id : session.provider_session_id ?? null,
      model: sessionRow ? sessionRow.model : session.model ?? null,
      effort: sessionRow ? sessionRow.effort : session.effort ?? null,
      compaction_count: Number(database ? compactionRow?.count ?? 0 : session.compaction_count ?? 0),
      last_compaction_at: database ? compactionRow?.last_compaction_at ?? null : session.last_compaction_at ?? null,
      queued_turns: Number(database ? queuedRow?.count ?? 0 : 0),
      running_turns: Number(database ? runningRow?.count ?? 0 : 0),
      activity: await context.core.getAdvisorActivity(session.id, turnConversationId),
      provider_paused_until: pause?.resume_at ?? null,
      created_at: sessionRow ? sessionRow.created_at : session.started_at ?? null,
      resumed_count: Number(sessionRow ? sessionRow.resumed_count : session.resumed_count ?? 0),
    });
  } catch (error) {
    await sendApiError(response, requestIdValue, error, `${method} ${pathname}`, context.core);
  }
  return;
}

async function advisorSessionRestart(route: RouteRequest): Promise<void> {
  const { context, request, response, pathname, method } = route; const requestIdValue = route.requestId;
  const ownerId = requireOwner(request);
  try {
    const body = isJsonContentType(headerValue(request, "content-type")) ? await readRequestBody(request) : {};
    const windowKey = isObject(body) && typeof body.window === "string" && body.window.length > 0 ? body.window : GENERAL_WINDOW_KEY;
    const target = resolveAdvisorSessionWindow(advisorSessionDatabase(context.db), ownerId, null, windowKey);
    const session = target === "missing"
      ? null
      : target && context.core.advisorSessions.getActiveSessionForWindow
        ? await context.core.advisorSessions.getActiveSessionForWindow(target.window_id)
        : await context.core.advisorSessions.getActiveSession(ownerId);
    if (!session) {
      sendJson(response, 404, { error: "no active session" });
      return;
    }
    await context.core.restartAdvisorSession(ownerId, windowKey);
    sendJson(response, 200, { restarted: true, ended_session_id: session.id });
  } catch (error) {
    await sendApiError(response, requestIdValue, error, `${method} ${pathname}`, context.core);
  }
  return;
}

async function advisorSessionInterrupt(route: RouteRequest): Promise<void> {
  const { context, request, response, pathname, method } = route; const requestIdValue = route.requestId;
  const ownerId = requireOwner(request);
  try {
    const body = isJsonContentType(headerValue(request, "content-type")) ? await readRequestBody(request) : {};
    const windowKey = isObject(body) && typeof body.window === "string" && body.window.length > 0 ? body.window : GENERAL_WINDOW_KEY;
    const result = await context.core.interruptAdvisorTurn(ownerId, windowKey);
    if (result.status === "unsupported") {
      sendJson(response, 409, { error: "interrupt_unsupported" });
      return;
    }
    sendJson(response, 200, { interrupted: result.status === "interrupting", turn_id: result.turn_id });
  } catch (error) {
    await sendApiError(response, requestIdValue, error, `${method} ${pathname}`, context.core);
  }
  return;
}


/** key は decodeOnPathMatch で decode 済み。provider は decode しない。 */
async function listAdvisorChannels(route: RouteRequest): Promise<void> {
  const { context, request, response } = route;
  const requestIdValue = route.requestId;
  const key = route.params.key ?? "";
  const windowNotFound = () => new ApiError(404, "advisor_window_not_found", "指定されたAdvisorの窓が見つかりません。窓の一覧を読み直してください。", { key });
  const ownerId = requireOwner(request);
  const api = advisorWindowFeature(context.core);
  const window = await api.ensureAdvisorWindow(ownerId, key);
  if (!window) throw windowNotFound();
  const settings = await api.getAdvisorWindowSettings();
  const channels: JsonObject[] = [];
  for (const provider of CHANNEL_PROVIDERS) {
    const { configured } = await integrationOf(context, provider);
    const admin = context.channelAdmins?.channelAdmin(provider) ?? null;
    let binding = await api.getAdvisorChannelBinding(window.window_id, provider);
    if (binding && admin) {
      // Slack / Discord hold the real name; when it cannot be read the stored one stays.
      const info = await admin.describeChannel(binding.channel_id).catch(() => null);
      if (info && info.name !== binding.display_name && await api.updateAdvisorChannelName(window.window_id, provider, info.name)) {
        binding = { ...binding, display_name: info.name };
      }
    }
    channels.push({
      provider,
      configured,
      running: admin !== null,
      binding: binding ? { channel_id: binding.channel_id, display_name: binding.display_name } : null,
      owner_user_id_set: provider === "slack" && Boolean((await context.core.getIntegrations()).find((integration) => integration.provider === provider)?.owner_user_id),
      default_name: key === GENERAL_WINDOW_KEY ? null : defaultChannelName(projectNameOf(context, key), key, settings),
    });
  }
  sendJson(response, 200, { request_id: requestIdValue, data: { channels }, version: 0 });
  return;
}

async function writeAdvisorChannel(route: RouteRequest, inviteOwner: boolean): Promise<void> {
  const { context, request, response, pathname, method } = route;
  const key = route.params.key ?? "";
  const providerPart = route.params.provider;
  const windowNotFound = () => new ApiError(404, "advisor_window_not_found", "指定されたAdvisorの窓が見つかりません。窓の一覧を読み直してください。", { key });
  const ownerId = requireOwner(request);
  const provider = channelProvider(providerPart);
  const command = commandEnvelope(await readRequestBody(request));
  if (key === GENERAL_WINDOW_KEY) {
    throw new ApiError(422, "validation_error", "ジェネラリストのチャンネルは連携設定で決めます。", { field: "key" });
  }
  const api = advisorWindowFeature(context.core);
  const window = await api.ensureAdvisorWindow(ownerId, key);
  if (!window) throw windowNotFound();

  if (inviteOwner) {
    if (provider !== "slack") throw new ApiError(422, "invite_not_supported", "Discordはチャンネルへの招待に対応していません。", { provider });
    const result = await runCommand(context, pathname, command, 200, async () => {
      const existing = await api.getAdvisorChannelBinding(window.window_id, provider);
      if (!existing) throw new ApiError(404, "channel_binding_not_found", "この窓にはチャンネルが連携していません。", { provider });
      const ownerUserId = await slackOwnerUserId(context);
      const admin = await requireChannelAdmin(context, provider);
      const invite = await inviteOwnerToChannel(admin, existing.channel_id, ownerUserId);
      return { data: { provider, window_key: key, channel_id: existing.channel_id, display_name: existing.display_name, invite }, version: 0 };
    });
    sendJson(response, 200, result);
    return;
  }

  const settings = await api.getAdvisorWindowSettings();

  if (method === "POST") {
    const result = await runCommand(context, pathname, command, 201, async () => {
      if (await api.getAdvisorChannelBinding(window.window_id, provider)) {
        throw new ApiError(409, "window_channel_exists", "この窓には既にチャンネルが連携しています。名前を変えるか、既存の連携を確認してください。", { provider });
      }
      const name = channelNameFromPayload(command.payload.name ?? defaultChannelName(projectNameOf(context, key), key, settings), settings);
      const admin = await requireChannelAdmin(context, provider);
      const info = await channelCall(provider, "create", () => admin.createChannel(name));
      try {
        return { data: channelBindingBody(await api.bindAdvisorChannel(window.window_id, provider, info.channel_id, info.name)), version: 0 };
      } catch (error) {
        throw new ApiError(500, "server_error", "チャンネルは作れましたが、連携を保存できませんでした。既にあるチャンネルとして連携してください。", { provider, channel_id: info.channel_id, name: info.name }, { cause: error });
      }
    });
    sendJson(response, 201, result);
    return;
  }

  if (method === "PUT") {
    const result = await runCommand(context, pathname, command, 200, async () => {
      const channelId = stringField(command.payload.channel_id, "channel_id", 1, 200);
      if (/\s/u.test(channelId)) throw new ApiError(400, "validation_error", "channel_idに空白は使えません。", { field: "channel_id" });
      if ((await integrationOf(context, provider)).channelIds.has(channelId)) {
        throw new ApiError(409, "channel_in_use", "このチャンネルは連携設定の会話・通知チャンネルです。別のチャンネルを選んでください。", { provider, channel_id: channelId });
      }
      const owner = await api.findAdvisorChannelOwner(provider, channelId);
      if (owner && owner.window_id !== window.window_id) {
        throw new ApiError(409, "channel_already_bound", "このチャンネルはほかの窓と連携しています。", { provider, window_key: owner.window_key });
      }
      const admin = await requireChannelAdmin(context, provider);
      const info = await channelCall(provider, "describe", () => admin.describeChannel(channelId));
      if (!info.bot_is_member) {
        throw new ApiError(422, "channel_bot_not_member", "Botがこのチャンネルに入っていません。Botを招待してからやり直してください。", { provider });
      }
      return { data: channelBindingBody(await api.bindAdvisorChannel(window.window_id, provider, info.channel_id, info.name)), version: 0 };
    });
    sendJson(response, 200, result);
    return;
  }

  const result = await runCommand(context, pathname, command, 200, async () => {
    const existing = await api.getAdvisorChannelBinding(window.window_id, provider);
    if (!existing) throw new ApiError(404, "channel_binding_not_found", "この窓にはチャンネルが連携していません。", { provider });
    const name = channelNameFromPayload(command.payload.name, settings);
    const admin = await requireChannelAdmin(context, provider);
    const info = await channelCall(provider, "rename", () => admin.renameChannel(existing.channel_id, name));
    await api.updateAdvisorChannelName(window.window_id, provider, info.name);
    return { data: channelBindingBody({ ...existing, display_name: info.name }), version: 0 };
  });
  sendJson(response, 200, result);
  return;
}

/** 添付のアップロード。conversations と works の2つのルートが使う。 */
export async function handleAttachmentUpload(route: RouteRequest, kind: "works" | "conversations"): Promise<void> {
  const { context, request, response } = route;
  const ownerId = requireOwner(request);
  const id = route.params[kind === "works" ? "work_id" : "conversation_id"] as string;
  const target: WebAttachmentTarget = kind === "works"
    ? { work_id: pathId(id, "work_id") }
    : { conversation_id: pathId(id, "conversation_id") };
  const filenameHeader = headerValue(request, "x-owl-filename");
  const requestHeader = headerValue(request, "x-request-id");
  const idempotencyHeader = headerValue(request, "idempotency-key");
  const contentLengthHeader = headerValue(request, "content-length");
  if (!filenameHeader || !requestHeader || !idempotencyHeader || !contentLengthHeader || !/^\d+$/u.test(contentLengthHeader)) {
    throw new ApiError(400, "validation_error", "X-Owl-Filename、X-Request-Id、Idempotency-Key、Content-Length headerは必須です。");
  }
  let filename: string;
  try {
    filename = decodeURIComponent(filenameHeader);
  } catch (error) {
    throw new ApiError(400, "validation_error", "X-Owl-Filenameを復号できません。", { field: "filename" }, { cause: error });
  }
  const requestIdText = stringField(requestHeader, "X-Request-Id", 1, 128);
  const idempotencyKey = stringField(idempotencyHeader, "Idempotency-Key", 1, 128);
  const content = await readRawBody(request, MAX_UPLOAD_BYTES);
  if (Number(contentLengthHeader) !== content.byteLength) throw new ApiError(400, "validation_error", "Content-Lengthと実際のupload bytesが一致しません。");
  const mime = headerValue(request, "content-type")?.trim() || "application/octet-stream";
  const data = await requireAdapterFeature(context.core, ["uploadWebAttachment"], { code: "dependency_unavailable", message: "The loaded Core does not support Web attachments." }).uploadWebAttachment(
    ownerId,
    target,
    { filename, mime, content },
    { request_id: requestIdText, idempotency_key: idempotencyKey },
  );
  sendJson(response, 201, { data });
  return;
}

export const ADVISOR_ROUTES: readonly ApiRoute[] = [
  { method: "POST", path: ADVISOR_WORKSPACE_API_PATH, handle: advisorWorkspace },
  { method: "POST", path: ADVISOR_WORKSPACE_FINISH_API_PATH, handle: advisorWorkspace },
  { method: "POST", path: "/api/v1/advisor/actions", handle: advisorActions },
  { method: "POST", path: "/api/v1/conversations/{conversation_id}/clear", handle: conversationClear },
  { method: "POST", path: "/api/v1/conversations/{conversation_id}/advisor-deliveries", handle: advisorDelivery },
  { method: "POST", path: "/api/v1/inbound/messages", handle: inboundMessage },
  { method: "POST", path: "/api/v1/inbound/uploads", handle: inboundUploadRegister },
  { method: "GET", path: "/api/v1/uploads/limits", handle: uploadLimits },
  { method: "POST", path: "/api/v1/conversations/{conversation_id}/attachments", handle: (route) => handleAttachmentUpload(route, "conversations") },
  { method: "PUT", path: "/api/v1/inbound/uploads/{upload_id}/content", handle: uploadContent },
  { method: "POST", path: "/api/v1/inbound/uploads/{upload_id}/complete", handle: uploadComplete },
  { method: "POST", path: "/api/v1/messages", handle: postMessage },
  { method: "GET", path: "/api/v1/conversations/{conversation_id}/messages", handle: listMessages },
  { method: "POST", path: "/api/v1/conversations/{conversation_id}/messages", handle: postConversationMessage },
  { method: "GET", path: "/api/v1/advisor/windows", handle: listAdvisorWindows },
  { method: "PUT", path: "/api/v1/advisor/windows/order", handle: setAdvisorWindowOrder },
  { method: "PUT", path: "/api/v1/advisor/windows/{key}/read", handle: markAdvisorWindowRead },
  { method: "GET", path: "/api/v1/advisor/channel-bindings", handle: listChannelBindings },
  { method: "GET", path: "/api/v1/advisor/windows/{key}/channels", decodeOnPathMatch: ["key"], handle: listAdvisorChannels },
  { method: "POST", path: "/api/v1/advisor/windows/{key}/channels/{provider}", decodeOnPathMatch: ["key"], handle: (route) => writeAdvisorChannel(route, false) },
  { method: "PUT", path: "/api/v1/advisor/windows/{key}/channels/{provider}", decodeOnPathMatch: ["key"], handle: (route) => writeAdvisorChannel(route, false) },
  { method: "PATCH", path: "/api/v1/advisor/windows/{key}/channels/{provider}", decodeOnPathMatch: ["key"], handle: (route) => writeAdvisorChannel(route, false) },
  { method: "POST", path: "/api/v1/advisor/windows/{key}/channels/{provider}/invite-owner", decodeOnPathMatch: ["key"], handle: (route) => writeAdvisorChannel(route, true) },
  { method: "GET", path: "/api/v1/advisor/windows/{key}/conversation", handle: getAdvisorWindowConversation },
  { method: "GET", path: "/api/v1/advisor/conversation/active", handle: getActiveConversation },
  { method: "GET", path: "/api/v1/advisor/session", handle: advisorSession },
  { method: "POST", path: "/api/v1/advisor/session/restart", handle: advisorSessionRestart },
  { method: "POST", path: "/api/v1/advisor/session/interrupt", handle: advisorSessionInterrupt },
];
