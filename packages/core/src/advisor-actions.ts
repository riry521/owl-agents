import { createUlid, utcNow } from "@owl/db";
import { ownerLanguage, type OwnerLanguage } from "./owner-language";
import { EventDispatcher } from "./event-dispatcher";
import { HumanReadableError, validationError } from "./errors";
import { advisorActionFingerprint, advisorActionNeedsApproval, advisorActionTarget, buildAdvisorActionFailure, loadFollowupRetries, loadSourceFailures, nextTurnOf, planFollowupActions, type AdvisorActionFailure, type AdvisorFailureDetails, type FollowupCandidate } from "./advisor-followup.js";
import { advisorWorkId, parseAdvisorWorkOperationPayload } from "./advisor-work-payload.js";
import { AdvisorSessionRuntime } from "./advisor-runtime.js";
import { type CurationKind } from "./curation-runs.js";
import { type CurationNoticeEntry } from "./curation-summary.js";
import { advisorWindowSettings } from "./advisor-window-settings.js";
import { ensureWebAccount } from "./advisor-windows.js";
import { GENERAL_WINDOW_KEY } from "@owl/shared/advisor-windows";
import { formatRuntimeFailure } from "./error-display.js";
import { ADVISOR_TEXT, workRef } from "./advisor-text.js";
import { prepareAdvisorSendFile, sendFileNotice, type AdvisorOutboundFile, type AdvisorSendFileSettings } from "./advisor-send-file.js";
import { ADVISOR_CALL_API_ACTION_TYPE, ADVISOR_SEND_FILE_ACTION_TYPE, ADVISOR_WINDOW_ACTION_TYPES, validateWindowHandoffPayload, ADVISOR_WORK_OPERATION_ACTION_TYPES, parseAdvisorCallApiPayload, redactProviderOutput, isAdvisorWorkOperationType, type AdvisorWorkOperationType } from "@owl/shared/advisor-response";
import { ADVISOR_CURATION_ACTION_TYPES, validatePrerequisiteWorkIds, advisorCurationKind } from "@owl/shared";
import { type AdvisorSuggestedAction } from "@owl/shared";
import { externalJsonBlock } from "@owl/shared";
import type { CommandRequest, CommandResponse, CoreDatabase, CoreOptions, CoreWriteLaneTransaction, CreateWorkData, CreateWorkPayload, JsonObject, PauseWorkPayload, ResumeWorkOrRetryData, ResumeWorkOrRetryPayload, StartWorkPayload, UpdateWorkData, UpdateWorkPayload, WorkState, WorktreeCleanupResult } from "./types";
import type { WorkPrerequisiteView } from "@owl/shared/work-prerequisite";
import type { AdvisorWindowRef } from "./advisor-windows.js";
import type { CurationActor, CurationRunView, CurationTrigger } from "./curation-runs.js";

/** The Core members the Advisor actions use; Core builds this from its private state. */
import { advisorWorkKeyForType, advisorWorkTypeForKey, callApiHash, isRecord, parseMessageMetadata, type AdvisorActionOutcome, type AdvisorFileDeliveryMetadata, type AdvisorFileDeliveryPlan, type WebFileDestination } from "./core-shared.js";
export interface AdvisorActionsHost {
  readonly db: CoreDatabase;
  readonly writeLane: ReturnType<CoreDatabase["createWriteLane"]>;
  readonly advisorRuntime: AdvisorSessionRuntime | null;
  readonly dispatcher: EventDispatcher;
  readonly options: CoreOptions;
  readonly started: boolean;
  readonly cancelWork: (workId: string, request: CommandRequest<{ reason: string; force?: boolean } & JsonObject>) => Promise<CommandResponse<{ work_id: string; state: "cancelled"; cancel_requested: boolean; worktree_cleanup: WorktreeCleanupResult }>>;
  readonly claimWindowHandoffs: (windowId: string, messageId: string) => Promise<void>;
  readonly conversationWindowId: (conversationId: string) => string | null;
  readonly createWork: (request: CommandRequest<CreateWorkPayload>) => Promise<CommandResponse<CreateWorkData>>;
  readonly deleteWork: (workId: string, request: CommandRequest<JsonObject>) => Promise<CommandResponse<{ work_id: string; deleted: true }>>;
  readonly ensureAdvisorWindow: (ownerId: string, key: string) => Promise<AdvisorWindowRef | null>;
  readonly moveWorkToProject: (workId: string, request: CommandRequest<{ project_id: string }>, source?: "owner" | "advisor") => Promise<CommandResponse<{ work_id: string; project_id: string; display_number: number; previous_display_number: number; state: WorkState }>>;
  readonly pauseWork: (workId: string, request: CommandRequest<PauseWorkPayload>) => Promise<CommandResponse<{ work_id: string; state: "paused"; signal: "pause_requested" }>>;
  readonly postWorkInstruction: (workId: string, request: CommandRequest<{ body: string; attachment_ids?: string[]; reopen?: boolean }>) => Promise<CommandResponse<{ work_id: string; conversation_id: string; message_id: string; status: "queued" }>>;
  readonly recoverAdvisorCallApis: (turnId: string, actions?: readonly AdvisorSuggestedAction[]) => Promise<{ notices: string[]; failures: AdvisorActionFailure[] }>;
  readonly releaseStatusExchanges: (messageId: string) => Promise<void>;
  readonly releaseWindowHandoffs: (messageId: string) => Promise<void>;
  readonly replaceWorkPrerequisites: (workId: string, request: CommandRequest<{ prerequisite_work_ids: string[] } & JsonObject>) => Promise<CommandResponse<{ work_id: string; state: WorkState; prerequisites: WorkPrerequisiteView[] }>>;
  readonly resolveAdvisorSendFileSettings: () => AdvisorSendFileSettings;
  readonly resolveAttachmentPaths: (messageId: string) => { paths: readonly string[]; notes: readonly string[] };
  readonly resumeWorkOrRetryDecision: (workId: string, request: CommandRequest<ResumeWorkOrRetryPayload>) => Promise<CommandResponse<ResumeWorkOrRetryData>>;
  readonly sendCurationNoticeFor: (entries: readonly CurationNoticeEntry[]) => void;
  readonly sendFileChannelFor: (conversationId: string, origin: { channel: string }, memo: { resolved?: WebFileDestination }) => string;
  readonly startCurationInBackground: (input: { kind: CurationKind; trigger: CurationTrigger; actor: CurationActor; actor_ref?: string | null; request_key?: string | null }, collect?: (finished: Promise<CurationNoticeEntry>) => void) => Promise<{ run: CurationRunView; started: boolean }>;
  readonly startWork: (workId: string, request: CommandRequest<StartWorkPayload>) => Promise<CommandResponse<{ work_id: string; state: "running" | "ready" | "judgement_waiting"; started: boolean; waiting_for_prerequisites: boolean }>>;
  readonly statusExchangesBlock: (messageId: string) => string | null;
  readonly updateWork: (workId: string, request: CommandRequest<UpdateWorkPayload>) => Promise<CommandResponse<UpdateWorkData>>;
  readonly windowHandoffBlock: (messageId: string) => string | null;
  readonly windowHandoffDoneNotice: (windowId: string, targetName: string, t: (typeof ADVISOR_TEXT)["ja"]) => string;
  readonly windowName: (windowId: string, general: string) => string;
  readonly writeAdvisorCallApiEvent: (key: string, type: string, payload: Record<string, unknown>) => Promise<void>;
}

export class AdvisorActions {
  constructor(private readonly host: AdvisorActionsHost) {}

  /**
   * Marks the status answers no Advisor turn has carried yet as carried by this turn's message, in one write-lane
   * transaction, so turns started at the same time cannot both take the same answer.
   */
  async claimStatusExchanges(conversationId: string, messageId: string): Promise<void> {
    await this.host.writeLane.transact((transaction: CoreWriteLaneTransaction) => {
      transaction.run(
        `UPDATE messages SET metadata_json = json_set(metadata_json, '$.delivered', json('true'), '$.carried_by', ?)
          WHERE conversation_id = ?
            AND json_extract(metadata_json, '$.kind') = 'status_question'
            AND json_extract(metadata_json, '$.delivered') = 0`,
        messageId,
        conversationId,
      );
    });
  }

  async runWindowHandoff(
    conversationId: string,
    turnId: string,
    index: number,
    action: AdvisorSuggestedAction,
    t: (typeof ADVISOR_TEXT)["ja"],
  ): Promise<AdvisorActionOutcome> {
    const fail = (code: string, notice: string, targetProjectId?: string | null): AdvisorActionOutcome => ({
      notice,
      failure: buildAdvisorActionFailure({
        index, type: action.type, action, code, message: notice,
        details: { target_project_id: targetProjectId },
      }),
    });
    const parsed = validateWindowHandoffPayload(action.payload, advisorWindowSettings(this.host.db).handoff_summary_max_chars);
    if (!parsed.ok) return fail("invalid_payload", t.handoffInvalid);
    const owner = this.host.db.get<{ owner_id: string }>("SELECT owner_id FROM conversations WHERE id = ?", conversationId);
    if (!owner) return fail("invalid_payload", t.handoffInvalid);
    const source = { owner_id: owner.owner_id, advisor_window_id: this.host.conversationWindowId(conversationId) };
    const { project_id: projectId, summary } = parsed.value;
    if (projectId !== null && !this.host.db.get("SELECT id FROM projects WHERE id = ? AND owner_id = ?", projectId, source.owner_id)) {
      return fail("no_project", t.handoffNoProject, projectId);
    }
    const target = await this.host.ensureAdvisorWindow(source.owner_id, projectId ?? GENERAL_WINDOW_KEY);
    if (!target) return fail("no_project", t.handoffNoProject, projectId);
    if (target.window_id === source.advisor_window_id) return fail("same_window", t.handoffSameWindow, projectId);
    const targetName = this.host.windowName(target.window_id, t.generalWindowName);
    const fromName = source.advisor_window_id ? this.host.windowName(source.advisor_window_id, t.generalWindowName) : t.generalWindowName;
    const messageId = createUlid();
    const now = utcNow();
    try {
    await this.host.writeLane.write({
      mutateState: (transaction) => {
        const account = ensureWebAccount(transaction, source.owner_id, now);
        transaction.run(
          `INSERT INTO messages
             (id, conversation_id, provider, account_id, source_message_id, body,
              attachment_ids_json, received_at, created_at, metadata_json)
           VALUES (?, ?, 'web', ?, ?, ?, ?, ?, ?, ?)`,
          messageId, target.conversation_id, account.id,
          `advisor:${target.conversation_id}:handoff:${turnId}:${index}`,
          t.handoffMessage(fromName, summary), JSON.stringify([]), now, now,
          JSON.stringify({ kind: "window_handoff", from_window_id: source.advisor_window_id, from_conversation_id: conversationId, source_turn_id: turnId, summary, delivered: false }),
        );
      },
      event: {
        id: createUlid(),
        idempotencyKey: `advisor-window-handoff:${turnId}:${index}`,
        type: "advisor.window_handoff",
        payload: {
          kind: "advisor_window_handoff",
          schema_version: "1.0.0",
          from_window_id: source.advisor_window_id,
          to_window_id: target.window_id,
          conversation_id: target.conversation_id,
          message_id: messageId,
        },
      },
      outbox: [],
    });
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 300) : t.unknownCause;
      return fail("result_unknown", t.handoffInvalid + " " + detail, projectId);
    }
    return { notice: this.host.windowHandoffDoneNotice(target.window_id, targetName, t) };
  }

  /**
   * AdvisorSessionRuntime.onReply: persists one turn's reply as a new message.
   * `options.interrupted` saves the reply of a turn the user stopped: it runs, publishes and follows up no action.
   */
  async persistAdvisorReply(
    conversationId: string,
    reply: string,
    turnId: string,
    origin: { channel: string; channel_id?: string; ref?: string },
    suggestedActions: readonly AdvisorSuggestedAction[],
    actionsMalformed = false,
    options: { interrupted?: boolean } = {},
  ): Promise<string | null> {
    const conversation = this.host.db.get<{ id: string; owner_id: string }>(
      "SELECT id, owner_id FROM conversations WHERE id = ?",
      conversationId,
    );
    if (!conversation) return null;

    const visibleReply = reply;
    // One memo per reply: the follow-up reconcile and the dispatch resolve the Web destination once between them.
    const destinationMemo: { resolved?: WebFileDestination } = {};
    const interrupted = options.interrupted === true;
    const allSuggestedActions = interrupted ? [] : [...suggestedActions];
    const recovery = interrupted
      ? { notices: [] as string[], failures: [] as AdvisorActionFailure[], recoveredIndexes: new Set<number>() }
      : await this.recoverAdvisorWorkActions(turnId, allSuggestedActions);
    if (!interrupted) {
      const recoveredApis = await this.host.recoverAdvisorCallApis(turnId, allSuggestedActions);
      recovery.notices.push(...recoveredApis.notices);
      recovery.failures.push(...recoveredApis.failures);
    }
    const t = ADVISOR_TEXT[ownerLanguage(this.host.db)];
    const followupOf = this.host.db.get<{ followup_of_turn_id: string | null }>(
      "SELECT followup_of_turn_id FROM advisor_turns WHERE id = ?", turnId,
    )?.followup_of_turn_id ?? null;
    const reconciled = followupOf === null || interrupted
      ? { heldIndexes: new Set<number>(), notices: [] as string[], failures: [] as AdvisorActionFailure[] }
      : await this.reconcileFollowupActions(conversationId, turnId, followupOf, allSuggestedActions, origin, destinationMemo);
    const actionResult = interrupted
      ? { notices: [] as string[], failures: [] as AdvisorActionFailure[], handledIndexes: new Set<number>(), outboundFiles: [] as (AdvisorOutboundFile & { index: number })[], fileDelivery: null as AdvisorFileDeliveryPlan | null }
      : await this.dispatchAdvisorWorkActions(conversationId, turnId, allSuggestedActions, origin, destinationMemo, recovery.recoveredIndexes, reconciled.heldIndexes);
    const trimmedReply = visibleReply.trimEnd();
    const allNotices = [
      ...recovery.notices,
      ...reconciled.notices,
      ...actionResult.notices,
      ...(actionsMalformed && !interrupted ? [t.actionsMalformed] : []),
    ];
    const actionFailures = [
      ...recovery.failures,
      ...reconciled.failures,
      ...actionResult.failures,
      ...(actionsMalformed && !interrupted
        ? [buildAdvisorActionFailure({ index: -1, type: "owl-actions", code: "invalid_payload", message: t.actionsMalformed })]
        : []),
    ];
    // A follow-up that fails again ends the automatic retry (7.3); a source reply with files waits for the delivery report.
    const followupPending = !interrupted && followupOf === null && actionResult.outboundFiles.length === 0
      && this.host.advisorRuntime?.followupSessionFor({ sourceTurnId: turnId, conversationId, failures: actionFailures }) != null;
    if (followupPending) allNotices.push(t.followupPending);
    if (followupOf !== null && actionFailures.some((failure) => failure.status === "failed" || failure.status === "unknown")) allNotices.push(t.followupStopped);
    const actionNotices = allNotices.join("\n");
    const unlabelledBody = allNotices.length === 0
      ? visibleReply
      : trimmedReply.length === 0
        ? actionNotices
        : `${trimmedReply}\n\n${actionNotices}`;
    const replyBody = followupOf === null ? unlabelledBody : `${t.followupLabel}\n${unlabelledBody}`;
    const publishedActions = allSuggestedActions.filter((_action, index) => !actionResult.handledIndexes.has(index));
    const now = utcNow();
    const messageId = createUlid();
    // A turn retried after a crash between this call and markTurnCompleted
    // (AdvisorSessionRuntime.recoverTurns) reaches this method a second time
    // for the same turnId with a fresh completion. That is a distinct reply,
    // not a replay of the first one, so the message/event keys below are
    // scoped by how many replies this turn already produced instead of by
    // turnId alone; otherwise the second call's event insert would collide
    // with the first attempt's on the events table's unique idempotency_key.
    const priorReplyCount = this.host.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND source_message_id LIKE ?",
      conversationId,
      `advisor:${conversationId}:${turnId}%`,
    )?.count ?? 0;
    const replyKeySuffix = priorReplyCount === 0 ? "" : `:retry${priorReplyCount}`;
    const sourceMessageId = `advisor:${conversationId}:${turnId}${replyKeySuffix}`;

    const plan = actionResult.fileDelivery;
    const fileDeliveryMetadata: AdvisorFileDeliveryMetadata | null = plan === null ? null : { kind: "advisor_file_delivery", ...plan };
    const deliveryTarget = actionResult.outboundFiles.length > 0 ? plan?.destination ?? null : null;
    let followupTurn: { turnId: string; sessionId: string } | null = null;
    const result = await this.host.writeLane.write({
      mutateState: (transaction) => {
        const account = ensureWebAccount(transaction, conversation.owner_id, utcNow());
        transaction.run(
          `INSERT INTO messages
             (id, conversation_id, provider, account_id, source_message_id, body,
              attachment_ids_json, received_at, created_at, metadata_json)
           VALUES (?, ?, 'web', ?, ?, ?, ?, ?, ?, ?)`,
          messageId,
          conversationId,
          account.id,
          sourceMessageId,
          replyBody,
          JSON.stringify([]),
          now,
          now,
          fileDeliveryMetadata === null ? null : JSON.stringify(fileDeliveryMetadata),
        );
        // Linked here, not only in markTurnCompleted, so the window list fetched on advisor.responded already counts it unread.
        transaction.run("UPDATE advisor_turns SET reply_message_id = ? WHERE id = ?", messageId, turnId);
        // Same transaction as the reply, so a crash can neither lose the follow-up nor queue it twice.
        if (followupPending) {
          followupTurn = this.host.advisorRuntime?.insertFollowupTurn(transaction, { sourceTurnId: turnId, conversationId, replyMessageId: messageId, origin, failures: actionFailures }) ?? null;
        }
        return messageId;
      },
      event: {
        id: createUlid(),
        idempotencyKey: `advisor-respond:${conversationId}:${turnId}${replyKeySuffix}`,
        type: "advisor.responded",
        payload: {
          kind: "advisor_responded",
          schema_version: "1.0.0",
          conversation_id: conversationId,
          message_id: messageId,
          turn_id: turnId,
          // Connectors post this body as-is instead of searching the
          // conversation's message list, which pages oldest first.
          reply: replyBody,
          // The next turn's input carries these (AdvisorSessionRuntime), since the provider session never saw them.
          action_results: actionNotices,
          suggested_actions: publishedActions,
          origin,
          ...(actionResult.outboundFiles.length > 0 ? { outbound_files: actionResult.outboundFiles, delivery_pending: true } : {}),
          ...(deliveryTarget === null ? {} : { delivery_target: deliveryTarget }),
          ...(actionFailures.length > 0 ? { action_failures: actionFailures } : {}),
          ...(followupPending ? { followup_pending: true } : {}),
          ...(followupOf !== null ? { followup_of_turn_id: followupOf } : {}),
          ...(interrupted ? { interrupted: true } : {}),
        },
      },
      outbox: [],
    });
    // Nothing else dispatches after an Advisor turn, so without this the Web learns of the reply (and the window's unread dot) only at the next unrelated dispatch.
    if (this.host.started) await this.host.dispatcher.replayPending();
    if (followupTurn) this.host.advisorRuntime?.kickFollowupTurn((followupTurn as { sessionId: string }).sessionId);
    return result.state;
  }

  /**
   * Decides which of a follow-up reply's actions may run (7.2). Each allowed retry is recorded durably before it
   * runs, so a follow-up re-sent after a restart cannot run the same retry again; an action held back is reported
   * as a failure with status "held".
   */
  async reconcileFollowupActions(
    conversationId: string,
    turnId: string,
    sourceTurnId: string,
    actions: readonly AdvisorSuggestedAction[],
    origin: { channel: string; channel_id?: string; ref?: string },
    destinationMemo: { resolved?: WebFileDestination },
  ): Promise<{ heldIndexes: Set<number>; notices: string[]; failures: AdvisorActionFailure[] }> {
    const t = ADVISOR_TEXT[ownerLanguage(this.host.db)];
    const candidates: { index: number; action: AdvisorSuggestedAction; candidate: FollowupCandidate }[] = [];
    for (const [index, action] of actions.entries()) {
      const executedByCore = ADVISOR_CURATION_ACTION_TYPES.has(action.type) || ADVISOR_WINDOW_ACTION_TYPES.has(action.type)
        || action.type === ADVISOR_CALL_API_ACTION_TYPE || action.type === ADVISOR_SEND_FILE_ACTION_TYPE
        || action.type === "create_work" || ADVISOR_WORK_OPERATION_ACTION_TYPES.has(action.type);
      if (!executedByCore) continue;
      // The real path of a file is a second key: the same file written differently is still the same file.
      const prepared = action.type === ADVISOR_SEND_FILE_ACTION_TYPE
        ? await prepareAdvisorSendFile(action.payload, this.host.sendFileChannelFor(conversationId, origin, destinationMemo), this.host.resolveAdvisorSendFileSettings())
        : null;
      candidates.push({
        index,
        action,
        candidate: {
          type: action.type,
          targets: advisorActionTarget(action, prepared?.ok ? { path: prepared.file.path } : undefined),
          approval: advisorActionNeedsApproval(action),
          fingerprint: advisorActionFingerprint(action),
        },
      });
    }
    const decisions = planFollowupActions(
      loadSourceFailures(this.host.db, sourceTurnId),
      candidates.map((entry) => entry.candidate),
      loadFollowupRetries(this.host.db, sourceTurnId),
    );
    const heldIndexes = new Set<number>();
    const notices: string[] = [];
    const failures: AdvisorActionFailure[] = [];
    const hold = (entry: (typeof candidates)[number], reason: string, notice: string): void => {
      heldIndexes.add(entry.index);
      notices.push(notice);
      failures.push({
        index: entry.index, type: entry.action.type, status: "held", code: reason, message: notice, retryable: false,
        approval: entry.candidate.approval, target: entry.candidate.targets[0] ?? null, details: {},
      });
    };
    for (const [position, decision] of decisions.entries()) {
      const entry = candidates[position]!;
      if (decision.action === "hold") {
        hold(entry, decision.reason, t[decision.reason](entry.action.type));
        continue;
      }
      try {
        await this.host.writeLane.write({
          mutateState: () => null,
          event: {
            id: createUlid(),
            idempotencyKey: `advisor-followup-retry:${sourceTurnId}:${decision.sourceIndex}`,
            type: "advisor.followup_retry_started",
            payload: {
              schema_version: "1.0.0",
              conversation_id: conversationId,
              source_turn_id: sourceTurnId,
              source_index: decision.sourceIndex,
              followup_turn_id: turnId,
              action_index: entry.index,
              type: entry.action.type,
              target: entry.candidate.targets[0] ?? null,
            },
          },
          outbox: [],
        });
      } catch {
        hold(entry, "followupHeldNotRecorded", t.followupHeldNotRecorded(entry.action.type));
      }
    }
    return { heldIndexes, notices, failures };
  }

  async runAdvisorCallApi(
    conversationId: string,
    turnId: string,
    action: AdvisorSuggestedAction,
    t: (typeof ADVISOR_TEXT)[keyof typeof ADVISOR_TEXT],
    index: number,
  ): Promise<AdvisorActionOutcome> {
    const fail = (code: string | null, notice: string, details: AdvisorFailureDetails, forceUnknown = false): AdvisorActionOutcome => ({
      notice,
      failure: buildAdvisorActionFailure({ index, type: action.type, action, code, message: notice, details, forceUnknown }),
    });
    const parsed = parseAdvisorCallApiPayload(action.payload);
    if (!parsed.ok) return fail(parsed.kind === "blocked" ? "blocked" : "invalid_payload", t.callApiRejected(parsed.reason), {});
    const { method, path, body, reason } = parsed.value;
    const requestHash = callApiHash(method, path, body);
    const callOwnApi = this.host.options.callOwnApi;
    if (!callOwnApi) return fail("unavailable", t.callApiUnavailable, { method, path, request_hash: requestHash });
    const key = `advisor-call-api:${turnId}:${requestHash}`;
    const previous = this.host.db.all<{ idempotency_key: string; payload_json: string }>(
      "SELECT idempotency_key, payload_json FROM events WHERE idempotency_key IN (?, ?)",
      `${key}:started`,
      `${key}:finished`,
    );
    const finished = previous.find((row) => row.idempotency_key === `${key}:finished`);
    if (finished) {
      const record = JSON.parse(finished.payload_json) as { outcome: string; status: number | null };
      return { notice: t.callApiAlreadyHandled(method, path, record.outcome, record.status) };
    }
    if (previous.length > 0) {
      await this.host.recoverAdvisorCallApis(turnId);
      return fail(null, t.callApiUnknown(method, path), { method, path, request_hash: requestHash });
    }
    const base = { schema_version: "1.0.0", conversation_id: conversationId, turn_id: turnId, request_hash: requestHash, method, path };
    const payloadValue = body?.payload;
    try {
      await this.host.writeAdvisorCallApiEvent(`${key}:started`, "advisor.api_call_started", {
        ...base,
        reason,
        body_keys: Object.keys(isRecord(payloadValue) ? payloadValue : body ?? {}),
      });
    } catch (error) {
      console.warn("[owl-core] Could not record call_api start; not sending.", error);
      return fail("not_sent", t.callApiNotRecorded(method, path), { method, path, request_hash: requestHash });
    }
    const sendBody = body !== undefined && Object.hasOwn(body, "payload")
      ? { ...body, request_id: turnId, idempotency_key: key, expected_version: body.expected_version ?? 0 }
      : body;
    const result = await callOwnApi({ method, path, ...(sendBody === undefined ? {} : { body: sendBody }) });
    let outcome: "succeeded" | "failed" | "unknown";
    let status: number | null = null;
    let summary: string;
    let apiErrorCode: string | null = null;
    if (result.kind === "response") {
      status = result.status;
      // A 5xx may have written before it failed, so it is unknown, not failed.
      outcome = status >= 200 && status < 300 ? "succeeded" : status >= 500 ? "unknown" : "failed";
      const data = isRecord(result.body) ? result.body : {};
      const error = isRecord(data.error) ? data.error : null;
      apiErrorCode = error && typeof error.code === "string" ? error.code : null;
      summary = outcome === "succeeded"
        ? JSON.stringify(data.data ?? null)
        : error ? `${String(error.code)}: ${String(error.message)}` : "";
    } else {
      outcome = result.kind === "unknown" ? "unknown" : "failed";
      summary = result.error;
    }
    summary = redactProviderOutput(summary.slice(0, 300));
    try {
      await this.host.writeAdvisorCallApiEvent(`${key}:finished`, "advisor.api_call_finished", { ...base, outcome, status, summary });
    } catch (error) {
      console.warn("[owl-core] Could not record call_api result.", error);
    }
    const details = { method, path, request_hash: requestHash, http_status: status, api_error_code: apiErrorCode };
    if (outcome === "unknown") return fail(null, t.callApiUnknown(method, path), details);
    if (outcome === "succeeded") return { notice: t.callApiDone(method, path, status ?? 0, summary) };
    return fail(result.kind === "response" ? apiErrorCode ?? `http_${status}` : "not_sent", t.callApiFailed(method, path, status ?? 0, summary), details);
  }

  /**
   * A turn retry (recoverTurns) can re-run this handler with different AI
   * output for the same turn. A create_work action at an index that already
   * created a Work on an earlier attempt would otherwise collide with that
   * attempt's idempotency key as soon as the payload differs (createWork's
   * request hash no longer matches), surfacing as "creation failed" even
   * though the Work exists. Recover those Works here first: start any that
   * an earlier attempt created but never started, and mark their index as
   * handled so the main loop below does not try to create them again.
   */
  async recoverAdvisorWorkActions(turnId: string, actions: readonly AdvisorSuggestedAction[]): Promise<{ notices: string[]; failures: AdvisorActionFailure[]; recoveredIndexes: Set<number> }> {
    const notices: string[] = [];
    const failures: AdvisorActionFailure[] = [];
    const recoveredIndexes = new Set<number>();
    const t = ADVISOR_TEXT[ownerLanguage(this.host.db)];
    const rows = this.host.db.all<{ key: string; response_json: string }>(
      "SELECT key, response_json FROM idempotency_keys WHERE key LIKE ?",
      `%:advisor-work:${turnId}:%`,
    );
    // A handoff message that already exists was delivered by an earlier attempt; it must not be inserted twice.
    for (const row of this.host.db.all<{ source_message_id: string; conversation_id: string }>(
      "SELECT source_message_id, conversation_id FROM messages WHERE source_message_id LIKE ?",
      `advisor:%:handoff:${turnId}:%`,
    )) {
      const index = Number.parseInt(row.source_message_id.split(":").pop() ?? "", 10);
      const windowId = this.host.db.get<{ advisor_window_id: string | null }>("SELECT advisor_window_id FROM conversations WHERE id = ?", row.conversation_id)?.advisor_window_id;
      if (!Number.isInteger(index) || index < 0 || !windowId || !row.source_message_id.startsWith(`advisor:${row.conversation_id}:handoff:`)) continue;
      recoveredIndexes.add(index);
      notices.push(this.host.windowHandoffDoneNotice(windowId, this.host.windowName(windowId, t.generalWindowName), t));
    }
    for (const row of rows) {
      // Work commands scope their key as <event>:<work>:-:-:-:advisor-work:turn:index:op.
      const parts = row.key.split(":");
      if (parts.length !== 9 || parts[5] !== "advisor-work" || parts[6] !== turnId) continue;
      const index = Number.parseInt(parts[7], 10);
      if (!Number.isInteger(index) || index < 0) continue;
      let response: unknown;
      try {
        response = JSON.parse(row.response_json);
      } catch (parseError) {
        console.warn("[owl-core] Skipping malformed advisor-work idempotency response_json", parseError);
        continue;
      }
      if (!isRecord(response) || !isRecord(response.data) || typeof response.data.work_id !== "string") continue;
      const workId = response.data.work_id;

      if (parts[8] !== "create") {
        const actionType = advisorWorkTypeForKey(parts[8]!);
        if (!actionType) continue;
        const work = this.host.db.get<{ title: string; display_number: number | null }>(
          "SELECT title, display_number FROM works WHERE id = ?",
          workId,
        );
        if (!work) continue;
        recoveredIndexes.add(index);
        notices.push(t.workActionAlreadyApplied(actionType, workRef(ownerLanguage(this.host.db), work.title, work.display_number, workId)));
        continue;
      }

      const work = this.host.db.get<{ title: string; size: "small" | "normal" | "large"; state: WorkState; state_version: number; project_id: string | null }>(
        "SELECT title, size, state, state_version, project_id FROM works WHERE id = ?",
        workId,
      );
      if (!work) continue;
      recoveredIndexes.add(index);
      if (work.state !== "memo" && work.state !== "ready") {
        // Already started (or further along) by an earlier attempt; nothing to recover.
        continue;
      }
      try {
        // An earlier attempt may have stopped between createWork and
        // replaceWorkPrerequisites; saving again with the same key is a no-op
        // when it already ran, and keeps the Work from starting without them.
        const action = actions[index];
        const requested = action?.type === "create_work" ? action.payload?.prerequisite_work_ids : undefined;
        const prerequisiteIds = requested === undefined ? [] : validatePrerequisiteWorkIds(requested);
        if (prerequisiteIds.length > 0) {
          const missing = prerequisiteIds.find((id) => !this.host.db.get("SELECT id FROM works WHERE id = ?", id));
          if (missing !== undefined) throw new Error(`Prerequisite Work ${missing} was not found.`);
          await this.host.replaceWorkPrerequisites(workId, {
            request_id: turnId,
            idempotency_key: `advisor-work:${turnId}:${index}:prerequisites`,
            expected_version: work.state_version,
            payload: { prerequisite_work_ids: prerequisiteIds },
          });
        }
        const current = this.host.db.get<{ state_version: number }>("SELECT state_version FROM works WHERE id = ?", workId);
        const started = await this.host.startWork(workId, {
          request_id: turnId,
          idempotency_key: `advisor-work:${turnId}:${index}:start`,
          expected_version: current?.state_version ?? work.state_version,
          payload: { mode: work.size === "small" ? "small" : "normal" },
        });
        notices.push(started.data.waiting_for_prerequisites
          ? t.createdWaiting(work.title, workId)
          : t.createdRecovered(work.title, workId));
      } catch (error) {
        const detail = error instanceof Error ? error.message.slice(0, 300) : t.unknownCause;
        const notice = t.createdNotStarted(work.title, workId, detail);
        notices.push(notice);
        failures.push(buildAdvisorActionFailure({
          index, type: "create_work", action: actions[index] ?? { type: "create_work", payload: { title: work.title } },
          code: "start_failed", message: notice, details: { title: work.title, project_id: work.project_id, created_work_id: workId },
        }));
      }
    }
    return { notices, failures, recoveredIndexes };
  }

  /**
   * The Advisor process has no direct write access to Owl's database/API.
   * Explicit Work actions in its response are therefore executed here by
   * Core, where normal validation, idempotency, and workflow dispatch apply.
   */
  async dispatchAdvisorWorkActions(
    conversationId: string,
    turnId: string,
    actions: readonly AdvisorSuggestedAction[],
    origin: { channel: string; channel_id?: string; ref?: string },
    destinationMemo: { resolved?: WebFileDestination } = {},
    recoveredIndexes: ReadonlySet<number> = new Set(),
    heldIndexes: ReadonlySet<number> = new Set(),
  ): Promise<{ notices: string[]; failures: AdvisorActionFailure[]; handledIndexes: Set<number>; outboundFiles: (AdvisorOutboundFile & { index: number })[]; fileDelivery: AdvisorFileDeliveryPlan | null }> {
    const notices: string[] = [];
    const failures: AdvisorActionFailure[] = [];
    const outboundFiles: (AdvisorOutboundFile & { index: number })[] = [];
    const fileResults: AdvisorFileDeliveryMetadata["files"][number][] = [];
    const add = (outcome: AdvisorActionOutcome): void => {
      notices.push(outcome.notice);
      if (outcome.failure) failures.push(outcome.failure);
    };
    const fail = (index: number, action: AdvisorSuggestedAction, code: string | null, notice: string, details: AdvisorFailureDetails = {}, preparedPath?: string): void => {
      add({ notice, failure: buildAdvisorActionFailure({ index, type: action.type, action, code, message: notice, details, preparedPath }) });
    };
    const handledIndexes = new Set<number>();
    const curatedKinds = new Set<CurationKind>();
    // Curations this reply started: their outcomes go out as one notice once all of them have ended.
    const finishedCurations: Promise<CurationNoticeEntry>[] = [];
    const t = ADVISOR_TEXT[ownerLanguage(this.host.db)];
    // A Project window pins every Work it creates or moves to its own Project.
    const windowProject = this.host.db.get<{ id: string; name: string }>(
      `SELECT project.id, project.name
         FROM conversations AS conversation
         JOIN advisor_windows AS window ON window.id = conversation.advisor_window_id
         JOIN projects AS project ON project.id = window.project_id
        WHERE conversation.id = ?`,
      conversationId,
    ) ?? null;
    const mismatchNotice = (requestedProjectId: string): string =>
      t.windowProjectMismatch(
        windowProject!.name,
        this.host.db.get<{ name: string }>("SELECT name FROM projects WHERE id = ?", requestedProjectId)?.name ?? requestedProjectId,
      );
    const inheritedProject = windowProject?.id ?? this.host.db.get<{ project_id: string | null }>(
      `SELECT work.project_id
         FROM conversations AS conversation
         LEFT JOIN works AS work ON work.id = conversation.work_id
        WHERE conversation.id = ?`,
      conversationId,
    )?.project_id ?? null;

    for (const [index, action] of actions.entries()) {
      if (heldIndexes.has(index)) {
        handledIndexes.add(index);
        continue;
      }
      // The action list is untrusted input: a Set membership test keeps
      // inherited keys ("toString", "constructor", …) out of the curation
      // path entirely, and advisorCurationKind only reads own properties.
      if (ADVISOR_CURATION_ACTION_TYPES.has(action.type)) {
        const kind = advisorCurationKind(action.type);
        if (kind === null) continue;
        handledIndexes.add(index);
        // A reply that repeats a tidy-up must not run the same curation twice.
        if (curatedKinds.has(kind)) continue;
        curatedKinds.add(kind);
        try {
          const { run, started } = await this.host.startCurationInBackground({
            kind,
            trigger: "advisor_action",
            actor: "advisor",
            actor_ref: turnId,
            request_key: `advisor-curation:${turnId}:${index}`,
          }, (finished) => finishedCurations.push(finished));
          notices.push(t.curationStarted(kind, run.id, !started));
        } catch (error) {
          fail(index, action, "start_failed", t.curationFailed(kind, error instanceof Error ? error.message.slice(0, 300) : t.unknownCause), { kind });
        }
        continue;
      }
      if (action.type === ADVISOR_CALL_API_ACTION_TYPE) {
        // Kept out of suggested_actions: the body may carry secrets.
        handledIndexes.add(index);
        add(await this.runAdvisorCallApi(conversationId, turnId, action, t, index));
        continue;
      }
      if (ADVISOR_WINDOW_ACTION_TYPES.has(action.type)) {
        handledIndexes.add(index);
        if (!recoveredIndexes.has(index)) add(await this.runWindowHandoff(conversationId, turnId, index, action, t));
        continue;
      }
      if (action.type === ADVISOR_SEND_FILE_ACTION_TYPE) {
        // Kept out of suggested_actions: a raw path must not appear as a suggestion.
        handledIndexes.add(index);
        const prepared = await prepareAdvisorSendFile(action.payload, this.host.sendFileChannelFor(conversationId, origin, destinationMemo), this.host.resolveAdvisorSendFileSettings());
        const resolved = destinationMemo.resolved;
        if (prepared.ok) {
          outboundFiles.push({ ...prepared.file, index });
          fileResults.push({ index, name: prepared.file.name, size: prepared.file.size, status: "pending" });
        } else if (prepared.kind === "unsupported_channel" && resolved?.result.kind === "refused") {
          const reason = resolved.result.reason;
          const notice = t.sendFileNoDestination(prepared.name, reason, resolved.platform, resolved.channel);
          fail(index, action, "no_destination", notice, { name: prepared.name, reason });
          fileResults.push({ index, name: prepared.name, size: null, status: "rejected", code: "no_destination", message: notice.slice(0, 300) });
        } else if (prepared.kind === "rejected") {
          const notice = sendFileNotice(prepared, t);
          fail(index, action, prepared.rejection, notice, {
            name: prepared.name, rejection: prepared.rejection, size: prepared.size, limit: prepared.limit, channel: prepared.channel,
          });
          fileResults.push({ index, name: prepared.name, size: prepared.size ?? null, status: "rejected", code: prepared.rejection, message: notice.slice(0, 300) });
        } else if (prepared.kind === "unsupported_channel") {
          fail(index, action, "unsupported_channel", sendFileNotice(prepared, t), { name: prepared.name, channel: origin.channel });
        } else {
          fail(index, action, "invalid_payload", sendFileNotice(prepared, t));
        }
        continue;
      }
      if (ADVISOR_WORK_OPERATION_ACTION_TYPES.has(action.type)) {
        if (!isAdvisorWorkOperationType(action.type)) continue;
        handledIndexes.add(index);
        if (recoveredIndexes.has(index)) continue;
        const moveTarget = action.type === "move_work_to_project" ? action.payload?.project_id : undefined;
        if (windowProject && typeof moveTarget === "string" && moveTarget.trim() !== windowProject.id) {
          fail(index, action, "window_project_mismatch", mismatchNotice(moveTarget.trim()), { work_id: advisorWorkId(action.payload) ?? undefined });
          continue;
        }
        add(await this.runAdvisorWorkOperation(turnId, index, action, action.type, t));
        continue;
      }
      if (action.type !== "create_work") continue;
      handledIndexes.add(index);
      if (recoveredIndexes.has(index)) {
        // recoverAdvisorWorkActions already created (and, if needed, started)
        // this index's Work on an earlier attempt; do not create a second one
        // even if this attempt's AI output describes it differently.
        continue;
      }
      const payload = action.payload;
      const title = payload?.title;
      const summary = payload?.summary;
      const size = payload?.size;
      const designMode = payload?.design_mode ?? "auto";
      const draft = payload !== null && typeof payload === "object" && "draft" in payload ? payload.draft : false;
      const createDetails: AdvisorFailureDetails = { title: typeof title === "string" ? title.trim().slice(0, 100) : undefined, project_id: typeof payload?.project_id === "string" ? payload.project_id : undefined };
      if (
        typeof draft !== "boolean" ||
        typeof title !== "string" || title.trim().length === 0 || title.length > 500 ||
        typeof summary !== "string" || summary.trim().length === 0 || summary.length > 20_000 ||
        (size !== "small" && size !== "normal" && size !== "large") ||
        (designMode !== "auto" && designMode !== "lead")
      ) {
        fail(index, action, "invalid_payload", t.createIncomplete, createDetails);
        continue;
      }
      const requestedProjectId = payload?.project_id;
      if (requestedProjectId !== undefined && requestedProjectId !== null && typeof requestedProjectId !== "string") {
        fail(index, action, "not_found", t.createBadProject, createDetails);
        continue;
      }
      if (windowProject && typeof requestedProjectId === "string" && requestedProjectId !== windowProject.id) {
        fail(index, action, "window_project_mismatch", mismatchNotice(requestedProjectId), createDetails);
        continue;
      }
      const projectId = typeof requestedProjectId === "string" ? requestedProjectId : inheritedProject;
      const resolvedDetails: AdvisorFailureDetails = { ...createDetails, project_id: projectId };
      const backlogItemIds: unknown = payload?.backlog_item_ids === undefined ? [] : payload.backlog_item_ids;
      const dismissItemIds: unknown = payload?.dismiss_backlog_item_ids === undefined ? [] : payload.dismiss_backlog_item_ids;
      const isIdList = (value: unknown): value is string[] =>
        Array.isArray(value) && value.every((id) => typeof id === "string");
      if (!isIdList(backlogItemIds) || !isIdList(dismissItemIds)) {
        fail(index, action, "invalid_payload", t.createFailed("backlog_item_ids and dismiss_backlog_item_ids must be arrays of strings."), resolvedDetails);
        continue;
      }
      let prerequisiteIds: string[] = [];
      let prerequisiteCode = "invalid_payload";
      try {
        prerequisiteIds = payload?.prerequisite_work_ids === undefined ? [] : validatePrerequisiteWorkIds(payload.prerequisite_work_ids);
        const missing = prerequisiteIds.find((id) => !this.host.db.get("SELECT id FROM works WHERE id = ?", id));
        if (missing !== undefined) {
          prerequisiteCode = "not_found";
          throw new Error(`Prerequisite Work ${missing} was not found.`);
        }
      } catch (error) {
        fail(index, action, prerequisiteCode, t.createFailed(error instanceof Error ? error.message.slice(0, 300) : t.unknownCause), resolvedDetails);
        continue;
      }
      const createKey = `advisor-work:${turnId}:${index}:create`;
      let createdWorkId: string | null = null;
      try {
        const created = await this.host.createWork({
          request_id: turnId,
          idempotency_key: createKey,
          expected_version: 0,
          payload: {
            title: title.trim(),
            summary: summary.trim(),
            size,
            project_id: projectId,
            ...(designMode === "lead" ? { design_mode: "lead" as const } : {}),
            ...(backlogItemIds.length > 0 ? { backlog_item_ids: backlogItemIds } : {}),
            ...(dismissItemIds.length > 0 ? { dismiss_backlog_item_ids: dismissItemIds } : {}),
          },
        });
        createdWorkId = created.data.work_id;
        let version = created.version;
        if (prerequisiteIds.length > 0) {
          version = (await this.host.replaceWorkPrerequisites(createdWorkId, {
            request_id: turnId,
            idempotency_key: `advisor-work:${turnId}:${index}:prerequisites`,
            expected_version: version,
            payload: { prerequisite_work_ids: prerequisiteIds },
          })).version;
        }
        if (draft) {
          notices.push(t.createdDraft(title.trim(), createdWorkId));
          continue;
        }
        const started = await this.host.startWork(createdWorkId, {
          request_id: turnId,
          idempotency_key: `advisor-work:${turnId}:${index}:start`,
          expected_version: version,
          payload: { mode: size === "small" ? "small" : "normal" },
        });
        if (started.data.waiting_for_prerequisites) {
          notices.push(t.createdWaiting(title.trim(), createdWorkId));
          continue;
        }
        notices.push(t.created(title.trim(), size === "small" ? "Worker" : "Manager", createdWorkId));
      } catch (error) {
        const detail = error instanceof Error ? error.message.slice(0, 300) : t.unknownCause;
        const errorCode = isRecord(error) && typeof error.code === "string" ? error.code : null;
        if (createdWorkId) {
          fail(index, action, "start_failed", t.createdNotStarted(title.trim(), createdWorkId, detail), { ...resolvedDetails, created_work_id: createdWorkId });
        } else {
          fail(index, action, errorCode, t.createFailed(detail), resolvedDetails);
        }
      }
    }
    if (finishedCurations.length > 0) void Promise.all(finishedCurations).then((entries) => this.host.sendCurationNoticeFor(entries));
    const webDestination = destinationMemo.resolved;
    const fileDelivery: AdvisorFileDeliveryPlan | null = fileResults.length > 0 && origin.channel.trim().toLowerCase() === "web"
      ? {
          destination: webDestination?.result.kind === "resolved" ? webDestination.result.destination : null,
          refusal: webDestination?.result.kind === "refused" ? webDestination.result.reason : null,
          files: fileResults,
        }
      : null;
    return { notices, failures, handledIndexes, outboundFiles, fileDelivery };
  }

  async runAdvisorWorkOperation(
    turnId: string,
    index: number,
    action: AdvisorSuggestedAction,
    type: AdvisorWorkOperationType,
    t: (typeof ADVISOR_TEXT)[OwnerLanguage],
  ): Promise<AdvisorActionOutcome> {
    const fail = (code: string | null, notice: string, details: AdvisorFailureDetails = {}): AdvisorActionOutcome => ({
      notice,
      failure: buildAdvisorActionFailure({ index, type, action, code, message: notice, details: { work_id: advisorWorkId(action.payload) ?? undefined, ...details } }),
    });
    const parsedPayload = parseAdvisorWorkOperationPayload(type, action.payload);
    if (!parsedPayload.ok) return fail("invalid_payload", t.workActionIncomplete(type));
    const { workId, body, reopen, title, summary, pauseReason, cancelReason, resumeBody, projectId } = parsedPayload.value;

    const language = ownerLanguage(this.host.db);
    const work = this.host.db.get<{ title: string; display_number: number | null; state: WorkState; state_version: number }>(
      "SELECT title, display_number, state, state_version FROM works WHERE id = ?",
      workId,
    );
    if (!work) return fail("work_not_found", t.workNotFound(workId));
    const ref = workRef(language, work.title, work.display_number, workId);
    const request = {
      request_id: turnId,
      idempotency_key: `advisor-work:${turnId}:${index}:${advisorWorkKeyForType(type)}`,
      expected_version: work.state_version,
    };

    const done = (notice: string): AdvisorActionOutcome => ({ notice });
    try {
      switch (type) {
        case "send_work_instruction": {
          await this.host.postWorkInstruction(workId, { ...request, payload: { body: body!, reopen } });
          return done(work.state === "completed" ? t.instructionSentReopened(ref) : t.instructionSent(ref));
        }
        case "update_work": {
          const result = await this.host.updateWork(workId, {
            ...request,
            payload: { ...(title === undefined ? {} : { title }), ...(summary === undefined ? {} : { summary }) },
          });
          return done(result.data.changed_fields.length === 0
            ? t.workUnchanged(ref)
            : t.workUpdated(ref, result.data.changed_fields, result.data.replan_queued));
        }
        case "pause_work":
          await this.host.pauseWork(workId, { ...request, payload: { reason: pauseReason } });
          return done(t.workPaused(ref));
        case "resume_work": {
          const result = await this.host.resumeWorkOrRetryDecision(workId, { ...request, payload: { source: "advisor", ...(resumeBody === undefined ? {} : { body: resumeBody }) } });
          return done(result.data.resumed_by === "resume" ? t.workResumed(ref) : t.workRetried(ref));
        }
        case "cancel_work":
          await this.host.cancelWork(workId, { ...request, payload: { reason: cancelReason!, force: false } });
          return done(t.workCancelledNotice(ref));
        case "delete_work":
          await this.host.deleteWork(workId, { ...request, payload: {} });
          return done(t.workDeletedNotice(ref));
        case "move_work_to_project": {
          const result = await this.host.moveWorkToProject(workId, { ...request, payload: { project_id: projectId } }, "advisor");
          const projectName = this.host.db.get<{ name: string }>("SELECT name FROM projects WHERE id = ?", projectId)?.name ?? projectId;
          return done(t.workMovedToProject(ref, projectName, result.data.display_number));
        }
      }
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
      const currentState = this.host.db.get<{ state: WorkState }>("SELECT state FROM works WHERE id = ?", workId)?.state ?? work.state;
      const errorDetails = isRecord(error) && isRecord(error.details) ? error.details : null;
      const failed = (notice: string): AdvisorActionOutcome => fail(code, notice, {
        work_state: currentState,
        expected_version: request.expected_version,
        error_reason: typeof errorDetails?.reason === "string" ? errorDetails.reason : undefined,
      });
      if (code === "work_not_found") return failed(t.workNotFound(workId));
      if (type === "send_work_instruction") {
        if (code === "work_cancelled") return failed(t.instructionCancelled(ref));
        if (code === "work_reopen_required") return failed(t.instructionReopenRequired(ref));
        if (code === "invalid_state_transition" && (currentState === "memo" || currentState === "ready")) {
          return failed(t.instructionNotStarted(ref));
        }
      }
      if (type === "move_work_to_project") {
        if (code === "work_project_already_set") return failed(t.workProjectAlreadySet(ref));
        if (code === "project_not_found") return failed(t.projectNotFoundForMove(projectId));
        if (code === "work_has_active_agents") return failed(t.workBusyForMove(ref));
        if (code === "invalid_state_transition" && errorDetails?.reason === "task_fix_pending") {
          const taskIds = Array.isArray(errorDetails.task_ids) ? errorDetails.task_ids.filter((id): id is string => typeof id === "string") : [];
          return failed(t.workFixPendingForMove(ref, taskIds));
        }
      }
      if (code === "invalid_state_transition") return failed(t.notAllowedInState(type, ref, currentState));
      if (code === "version_conflict") return failed(t.workActionConflict(ref));
      if (code === "idempotency_conflict") return done(t.workActionAlreadyApplied(type, ref));
      const detail = error instanceof Error ? error.message.slice(0, 300) : t.unknownCause;
      return failed(t.workActionFailed(type, ref, detail));
    }
  }

  async persistAdvisorError(
    conversationId: string,
    errorMessage: string,
    turnId: string,
    origin: { channel: string; channel_id?: string; ref?: string },
  ): Promise<void> {
    const conversation = this.host.db.get<{ id: string; owner_id: string }>(
      "SELECT id, owner_id FROM conversations WHERE id = ?",
      conversationId,
    );
    if (!conversation) return;

    const now = utcNow();
    const messageId = createUlid();
    const sourceMessageId = `advisor:error:${turnId}`;
    const language = ownerLanguage(this.host.db);
    const body = `${ADVISOR_TEXT[language].replyFailed}\n${formatRuntimeFailure(errorMessage, "Advisor", language)}`;

    await this.host.writeLane.write({
      mutateState: (transaction) => {
        const account = ensureWebAccount(transaction, conversation.owner_id, utcNow());
        transaction.run(
          `INSERT OR IGNORE INTO messages
             (id, conversation_id, provider, account_id, source_message_id, body,
              attachment_ids_json, received_at, created_at)
           VALUES (?, ?, 'web', ?, ?, ?, ?, ?, ?)`,
          messageId,
          conversationId,
          account.id,
          sourceMessageId,
          body,
          JSON.stringify([]),
          now,
          now,
        );
      },
      event: {
        id: createUlid(),
        idempotencyKey: `advisor-error:${conversationId}:${turnId}`,
        type: "advisor.responded",
        payload: {
          kind: "advisor_error",
          schema_version: "1.0.0",
          conversation_id: conversationId,
          message_id: messageId,
          turn_id: turnId,
          reply: body,
          origin,
        },
      },
      outbox: [],
    });
  }

  async respond(conversationId: string, messageId: string, origin?: { channel: string; channel_id?: string; ref?: string }): Promise<void> {
    try {
      const advisorRuntime = this.host.advisorRuntime;
      if (!advisorRuntime) throw new Error("Advisor requires a ProviderClient that can create sessions");
      const conversation = this.host.db.get<{ id: string; owner_id: string; advisor_window_id: string | null }>(
        "SELECT id, owner_id, advisor_window_id FROM conversations WHERE id = ?",
        conversationId,
      );
      if (!conversation) return;

      const message = this.host.db.get<{ id: string; body: string }>(
        `SELECT id, body FROM messages WHERE id = ? AND conversation_id = ?`,
        messageId,
        conversationId,
      );
      if (!message) {
        console.error("[owl-core] advisorRespond could not find its message", conversationId, messageId);
        return;
      }

      const { paths: attachmentPaths, notes } = this.host.resolveAttachmentPaths(message.id);
      await this.claimStatusExchanges(conversationId, message.id);
      const statusBlock = this.host.statusExchangesBlock(message.id);
      const handoffWindowId = this.host.conversationWindowId(conversationId);
      if (handoffWindowId) await this.host.claimWindowHandoffs(handoffWindowId, message.id);
      const handoffBlock = this.host.windowHandoffBlock(message.id);
      const blocks = [
        ...(notes.length > 0 ? [externalJsonBlock("owl-attachment-notes", notes)] : []),
        ...(statusBlock ? [statusBlock] : []),
        ...(handoffBlock ? [handoffBlock] : []),
      ];
      try {
        await advisorRuntime.ensureSessionAndEnqueue(conversation.owner_id, conversationId, message.id, {
          turn_id: createUlid(),
          text: [message.body, ...blocks].join("\n\n"),
          origin: origin ?? { channel: "web" },
          attachment_paths: attachmentPaths,
        });
      } catch (error) {
        // A failed enqueue leaves the answers for the next turn.
        await this.host.releaseStatusExchanges(message.id);
        await this.host.releaseWindowHandoffs(message.id);
        throw error;
      }
    } catch (error) {
      const turnId = createUlid();
      const message = formatRuntimeFailure(error, "Advisor", ownerLanguage(this.host.db));
      try {
        await this.persistAdvisorError(conversationId, message, turnId, origin ?? { channel: "web" });
      } catch (surfaceError) {
        console.error("[owl-core] advisorRespond failed and could not surface the error", conversationId, surfaceError);
      }
      console.error("[owl-core] advisorRespond failed for conversation", conversationId, error);
    }
  }

  /**
   * Takes a connector's report of how an `outbound_files` reply was delivered (4.4) and decides, together with the
   * reply's own failures, whether to queue the follow-up (6.4). Reported once per reply: a repeat returns the first answer.
   */
  async reportDelivery(
    ownerId: string,
    conversationId: string,
    payload: unknown,
  ): Promise<{ deduplicated: boolean; followup_pending: boolean; notice: string | null }> {
    const notFoundError = (message: string) => new HumanReadableError({ code: "not_found", message, remediation: "Report only replies that still await delivery.", details: { conversation_id: conversationId } });
    const conversation = this.host.db.get<{ owner_id: string }>("SELECT owner_id FROM conversations WHERE id = ?", conversationId);
    if (!conversation || conversation.owner_id !== ownerId) throw notFoundError(`conversation ${conversationId} was not found.`);

    const idField = (value: unknown, name: string): string => {
      if (typeof value !== "string" || value.length < 1 || value.length > 128) throw validationError(`${name} must be a string of 1 to 128 characters.`, { field: name }, { code: "advisor.delivery_id_invalid", values: { field: name } });
      return value;
    };
    if (!isRecord(payload) || !Array.isArray(payload.results) || payload.results.length === 0) throw validationError("The delivery report needs turn_id, message_id and at least one result.", {}, { code: "advisor.delivery_report_incomplete", values: { field: "results" } });
    const turnId = idField(payload.turn_id, "turn_id");
    const messageId = idField(payload.message_id, "message_id");
    const codesByOutcome: Readonly<Record<string, readonly string[]>> = { failed: ["changed", "unreadable", "upload_rejected", "upload_rate_limited"], unknown: ["upload_unknown"], sent: [] };
    const results = payload.results.map((entry: unknown) => {
      if (!isRecord(entry) || typeof entry.index !== "number" || !Number.isSafeInteger(entry.index) || entry.index < 0) throw validationError("Each result needs a non-negative integer index.", {}, { code: "advisor.delivery_index_invalid", values: { field: "index" } });
      const outcome = entry.outcome;
      if (typeof outcome !== "string" || !Object.hasOwn(codesByOutcome, outcome)) throw validationError("outcome must be sent, failed or unknown.", { index: entry.index }, { code: "advisor.delivery_outcome_invalid", values: { field: "outcome", index: entry.index as number } });
      const code = entry.code;
      if (outcome === "sent" ? code !== undefined : typeof code !== "string" || !codesByOutcome[outcome]!.includes(code)) throw validationError("code does not match outcome.", { index: entry.index }, { code: "advisor.delivery_code_mismatch", values: { field: "code", index: entry.index as number } });
      const platformError = entry.platform_error ?? null;
      if (platformError !== null && (typeof platformError !== "string" || platformError.length > 100)) throw validationError("platform_error must be null or a string of at most 100 characters.", { index: entry.index }, { code: "advisor.delivery_platform_error_invalid", values: { field: "platform_error", index: entry.index as number, max: 100 } });
      if (entry.message !== undefined && (typeof entry.message !== "string" || entry.message.length > 300)) throw validationError("message must be a string of at most 300 characters.", { index: entry.index }, { code: "advisor.delivery_message_invalid", values: { field: "message", index: entry.index as number, max: 300 } });
      return { index: entry.index, outcome, code: code as string | undefined, platformError, message: entry.message as string | undefined };
    });
    if (new Set(results.map((r) => r.index)).size !== results.length) throw validationError("result indexes must not repeat.", {}, { code: "advisor.delivery_index_repeated", values: { field: "index" } });

    const row = this.host.db.get<{ payload_json: string }>(
      `SELECT payload_json FROM events
        WHERE type = 'advisor.responded' AND json_extract(payload_json, '$.conversation_id') = ?
          AND json_extract(payload_json, '$.turn_id') = ? AND json_extract(payload_json, '$.message_id') = ?
          AND json_extract(payload_json, '$.delivery_pending') = 1
        ORDER BY rowid DESC LIMIT 1`,
      conversationId, turnId, messageId,
    );
    if (!row) throw notFoundError(`No reply of turn ${turnId} awaits delivery.`);
    const responded = JSON.parse(row.payload_json) as Record<string, unknown>;
    const files = new Map<number, { path: string; name: string }>();
    for (const file of Array.isArray(responded.outbound_files) ? responded.outbound_files : []) {
      if (isRecord(file) && typeof file.index === "number" && typeof file.path === "string") files.set(file.index, { path: file.path, name: String(file.name ?? "") });
    }
    for (const result of results) if (!files.has(result.index)) throw validationError(`index ${result.index} is not one of the reply's outbound_files.`, { index: result.index }, { code: "advisor.delivery_index_unknown", values: { field: "index", index: result.index } });

    const idempotencyKey = `advisor-delivery:${turnId}:${messageId}`;
    const saved = this.host.db.get<{ payload_json: string }>("SELECT payload_json FROM events WHERE idempotency_key = ?", idempotencyKey);
    if (saved) {
      const first = JSON.parse(saved.payload_json) as { followup_pending?: boolean; notice?: string | null };
      return { deduplicated: true, followup_pending: first.followup_pending === true, notice: first.notice ?? null };
    }

    const t = ADVISOR_TEXT[ownerLanguage(this.host.db)];
    const deliveryFailures = results.filter((r) => r.outcome !== "sent").map((r) => {
      const file = files.get(r.index)!;
      return buildAdvisorActionFailure({
        index: r.index,
        type: "send_file",
        code: r.code!,
        message: r.message ?? `${file.name}: ${r.code}`,
        details: { platform_error: r.platformError },
        preparedPath: file.path,
        targetPayload: { path: file.path },
      });
    });
    const sourceFailures = Array.isArray(responded.action_failures) ? responded.action_failures as AdvisorActionFailure[] : [];
    // A later turn that already built its input took the reply's own failures (6.5), so only the delivery's are handed over.
    const followupScope = nextTurnOf(this.host.db, turnId) !== null ? "delivery" : "all";
    const failures = followupScope === "delivery" ? deliveryFailures : [...sourceFailures, ...deliveryFailures];
    const sourceIsFollowup = typeof responded.followup_of_turn_id === "string";
    const origin = isRecord(responded.origin) && typeof responded.origin.channel === "string"
      ? responded.origin as { channel: string; channel_id?: string; ref?: string }
      : { channel: "web" };
    const followupPending = this.host.advisorRuntime?.followupSessionFor({ sourceTurnId: turnId, conversationId, failures }) != null;
    const hasFailed = (list: readonly AdvisorActionFailure[]) => list.some((f) => f.status === "failed" || f.status === "unknown");
    const notice = followupPending
      ? t.followupPending
      : sourceIsFollowup && hasFailed(deliveryFailures) && !hasFailed(sourceFailures) ? t.followupStopped : null;

    let followupTurn: { turnId: string; sessionId: string } | null = null;
    try {
    await this.host.writeLane.write({
      mutateState: (transaction) => {
        // Same write as the event, so the card on the reply and the report cannot disagree.
        const stored = transaction.get<{ metadata_json: string | null }>("SELECT metadata_json FROM messages WHERE id = ?", messageId);
        const card = parseMessageMetadata(stored?.metadata_json);
        if (card?.kind === "advisor_file_delivery") {
          const byIndex = new Map(results.map((r) => [r.index, r]));
          const updated: AdvisorFileDeliveryMetadata = {
            ...card,
            files: card.files.map((file) => {
              const r = byIndex.get(file.index);
              if (!r) return file;
              const { code: _code, message: _message, ...rest } = file;
              return r.outcome === "sent"
                ? { ...rest, status: "sent" as const }
                : { ...rest, status: r.outcome as "failed" | "unknown", code: r.code!, message: (r.message ?? `${file.name}: ${r.code}`).slice(0, 300) };
            }),
            ...(notice === null ? {} : { notice }),
          };
          transaction.run("UPDATE messages SET metadata_json = ? WHERE id = ?", JSON.stringify(updated), messageId);
        }
        if (followupPending) {
          followupTurn = this.host.advisorRuntime?.insertFollowupTurn(transaction, { sourceTurnId: turnId, conversationId, replyMessageId: messageId, origin, failures }) ?? null;
        }
        return null;
      },
      event: {
        id: createUlid(),
        idempotencyKey,
        type: "advisor.delivery_reported",
        payload: {
          kind: "advisor_delivery_reported",
          schema_version: "1.0.0",
          conversation_id: conversationId,
          turn_id: turnId,
          message_id: messageId,
          results: results.map((r) => ({ index: r.index, outcome: r.outcome, ...(r.code === undefined ? {} : { code: r.code }) })),
          action_failures: deliveryFailures,
          followup_scope: followupScope,
          followup_pending: followupPending,
          notice,
        },
      },
      outbox: [],
    });
    } catch (error) {
      // A concurrent identical report wrote first; the unique key rolled this write back, so answer with theirs.
      const first = this.host.db.get<{ payload_json: string }>("SELECT payload_json FROM events WHERE idempotency_key = ?", idempotencyKey);
      if (!first) throw error;
      const body = JSON.parse(first.payload_json) as { followup_pending?: boolean; notice?: string | null };
      return { deduplicated: true, followup_pending: body.followup_pending === true, notice: body.notice ?? null };
    }
    if (followupTurn) this.host.advisorRuntime?.kickFollowupTurn((followupTurn as { sessionId: string }).sessionId);
    return { deduplicated: false, followup_pending: followupPending, notice };
  }
}
