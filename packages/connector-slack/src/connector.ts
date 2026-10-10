import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { CoreClient, commandEnvelope, formatIntegrationError } from "@owl/plugin-sdk";
import {
  classifyIntent,
  connectorText,
  decisionShortId,
  formatAdvisorReply,
  formatStatusResponse,
  parseDecisionButtonId,
  resolveDecisionButtonTarget,
  submitDecisionAnswer,
  uploadAttachment,
  FileConnectorStateStore,
  type PendingDecision,
} from "@owl/plugin-sdk/shared";
import type { OwlEvent } from "@owl/plugin-sdk";
import type { SlackConfig, SlackMessage } from "./types.js";
import { sendNotification, shouldNotify, updateNotification } from "./notifications.js";
import { downloadFile } from "./files.js";
import { postSlackMessage } from "./posting.js";

const PENDING_DECISION_PAGE_LIMIT = 50;
const MAX_PENDING_DECISION_PAGES = 10_000;
const USER_MESSAGE_SUBTYPES: ReadonlySet<string> = new Set(["file_share", "thread_broadcast"]);

export class SlackConnector {
  private readonly config: SlackConfig;
  private readonly conversationChannelIds: readonly string[];
  private readonly notificationChannelIds: readonly string[];
  private readonly web: WebClient;
  private readonly socket: SocketModeClient;
  private readonly core: CoreClient;
  private readonly threadChannels = new Map<string, string>();
  private stopped = false;

  constructor(config: SlackConfig) {
    this.config = config;
    this.conversationChannelIds = parseChannelIds(config.conversationChannelId);
    this.notificationChannelIds = parseChannelIds(config.notificationChannelId);
    this.web = new WebClient(config.botToken);
    this.socket = new SocketModeClient({ appToken: config.appToken });
    this.core = new CoreClient({
      core_api_base: config.coreApiBase,
      core_ws_url: config.coreWsUrl,
      plugin_name: "slack",
      api_token: config.apiToken,
      account_id: config.accountId,
      state_store: config.stateFile ? new FileConnectorStateStore(config.stateFile) : undefined,
    });
  }

  async start(): Promise<void> {
    this.socket.on("message", async ({ event, body, ack }) => {
      try {
        await ack();
        const message = event as (SlackMessage & {
          subtype?: string;
          bot_id?: string;
          bot_profile?: unknown;
        }) | undefined;
        // Slack may omit `subtype` on some bot-authored channel events. Never
        // feed app/bot messages back into Owl, or outbound notifications loop.
        // A user's file upload arrives as `file_share` and a thread reply also
        // sent to the channel as `thread_broadcast`; every other subtype is an
        // edit, deletion or system message.
        if (!message || (message.subtype && !USER_MESSAGE_SUBTYPES.has(message.subtype))
          || message.bot_id || message.bot_profile || !message.user) return;
        if (!this.conversationChannelIds.includes(message.channel) && !this.decisionForThread(message)) return;
        await this.handleMessage(message).catch((error) => this.reportMessageError(message.channel, error));
      } catch (error) {
        await this.reportEventError(error);
      }
    });

    this.socket.on("interactive", async ({ body, ack }) => {
      try {
        await ack();
        if (!isSlackBlockActionsPayload(body)) return;
        await this.handleInteraction(body).catch((error) => this.reportEventError(error));
      } catch (error) {
        await this.reportEventError(error);
      }
    });

    // Connect to Slack first: a bad token/app config fails here, before any
    // Core resource (WebSocket, persisted cursor) is touched.
    await this.socket.start();
    console.log("[slack] Connected via Socket Mode");

    // Core emits no work.failed: Work failures arrive as work-scoped system.alert
    // events (or as a Decision), which notifications.ts renders as failures.
    try {
      await this.core.subscribeEvents(
        ["advisor.responded", "decision.opened", "decision.resolved", "decision.cancelled", "work.completed", "work.cancelled", "work.paused", "work.reopened", "provider.paused", "provider.resumed", "system.alert"],
        (event) => this.handleCoreEvent(event).catch((error) => this.reportEventError(error)),
      );
    } catch (error) {
      // Subscribing failed after Slack already connected: tear the Slack
      // connection back down rather than leaving it live with no Core events flowing.
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.socket.disconnect();
    this.core.close();
    console.log("[slack] Disconnected");
  }

  private async handleMessage(message: SlackMessage): Promise<void> {
    const pendingDecisions = await this.fetchPendingDecisions();
    const language = await this.core.language();
    const t = connectorText(language);
    const intent = classifyIntent(
      { ...message, replyToDecisionId: this.decisionForThread(message) },
      pendingDecisions,
      this.config.statusKeywords,
      language,
    );

    switch (intent.kind) {
      case "status_query": {
        const status = await formatStatusResponse(this.core, language);
        await postSlackMessage(this.web, {
          channel: message.channel,
          text: status,
        });
        break;
      }

      case "decision_answer": {
        const decision = pendingDecisions.find((candidate) => candidate.id === intent.decisionId);
        const outcome = await submitDecisionAnswer(this.core, {
          decisionId: intent.decisionId,
          answer: intent.answer,
          optionKey: intent.optionKey,
          displayLabel: intent.optionLabel ?? intent.answer,
          source: "slack",
          sourceMessageId: message.ts,
          idempotencyKey: `slack:decision:${intent.decisionId}:msg:${message.ts}`,
          expectedVersion: decision?.state_version ?? 0,
        });
        await postSlackMessage(this.web, {
          channel: message.channel,
          ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
          text: outcome.kind === "accepted" ? t.answerAccepted(decisionShortId(intent.decisionId)) : t.alreadyAnswered(outcome.label),
        });
        break;
      }

      case "decision_clarification": {
        await postSlackMessage(this.web, {
          channel: message.channel,
          ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
          text: intent.text,
        });
        break;
      }

      case "file_upload": {
        // Group by channel, matching the "conversation" case below, so an
        // attachment uploaded ahead of its message (registration needs no
        // conversation_id yet) still lands in the same conversation.
        const conversationHint = { work_id: null, dm_ref: message.channel, thread_ref: null };
        const tempDir = await mkdtemp(join(tmpdir(), "owl-slack-upload-"));
        const attachmentIds: string[] = [];
        try {
          for (const file of intent.files) {
            // One failing file must not stop the other files or the message
            // text, so each is caught, logged and reported to the channel.
            try {
              if (this.config.maxFileSize !== undefined && file.size > this.config.maxFileSize) {
                throw new Error(`${file.size} bytes exceeds maxFileSize ${this.config.maxFileSize}`);
              }
              const result = await downloadFile(this.config.botToken, file, tempDir, this.config.maxFileSize);
              try {
                const bytes = await readFile(result.path);
                const uploaded = await uploadAttachment(this.core, {
                  provider: "slack",
                  account_id: this.config.accountId,
                  external_attachment_id: file.id,
                  conversation_hint: conversationHint,
                  work_id: null,
                  file: { name: file.name, mime: result.mime, bytes },
                });
                attachmentIds.push(uploaded.upload_id);
                const notice = t.fileReceived(file.name, formatBytes(result.size), result.knownFormat);
                await postSlackMessage(this.web, {
                  channel: message.channel,
                  text: uploaded.status === "quarantined" ? `${notice}\n${t.executableNotRun}` : notice,
                });
              } finally {
                await unlink(result.path).catch(() => undefined);
              }
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              console.warn(`[slack] Could not import ${file.name}: ${reason}`);
              const checkScope = !file.url_private_download || /: (401|403)$/u.test(reason);
              await postSlackMessage(this.web, {
                channel: message.channel,
                text: t.fileFailed(file.name, reason, checkScope),
              }).catch(() => undefined);
            }
          }
        } finally {
          await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
        if (attachmentIds.length === 0 && !intent.text) break;
        const threadTs = message.thread_ts;
        if (threadTs) this.threadChannels.set(threadTs, message.channel);
        await this.sendSlackInboundMessage(message, intent.text ?? "", attachmentIds);
        break;
      }

      case "conversation": {
        // Group every conversation channel-wide (dm_ref = channel,
        // thread_ref = null), the same rule Discord already follows: Advisor
        // context lives in the owner-scoped session, not in the conversation
        // row, so splitting by thread only fragments the conversation list
        // without adding context. thread_id still carries the actual reply
        // destination (undefined for a top-level post) so a reply can be
        // posted back into the thread it came from.
        const threadTs = message.thread_ts;
        if (threadTs) this.threadChannels.set(threadTs, message.channel);
        await this.sendSlackInboundMessage(message, intent.text, []);
        break;
      }
    }
  }

  /**
   * Sends exactly one /inbound/messages call for a Slack message, optionally
   * carrying attachment_ids from a batch of uploadAttachment() calls made
   * for the same message (file_upload case).
   */
  private async sendSlackInboundMessage(message: SlackMessage, text: string, attachmentIds: readonly string[]): Promise<void> {
    const threadTs = message.thread_ts;
    const envelope = commandEnvelope({
      provider: "slack",
      account_id: this.config.accountId,
      external_message_id: message.ts,
      user_id: message.user,
      channel_id: message.channel,
      thread_id: threadTs ?? null,
      received_at: slackTimestampToIso(message.ts),
      text,
      conversation_hint: {
        work_id: null,
        dm_ref: message.channel,
        thread_ref: null,
      },
      attachment_ids: attachmentIds,
    }, `slack:message:${this.config.accountId}:${message.ts}`);
    await this.core.request("/inbound/messages", {
      method: "POST",
      body: envelope.payload,
      headers: {
        "X-Request-Id": String(envelope.request_id),
        "Idempotency-Key": String(envelope.idempotency_key),
      },
    });
  }

  private async handleInteraction(body: unknown): Promise<void> {
    const payload = body as {
      actions?: Array<{ action_id: string; value: string }>;
      user?: { id: string };
      channel?: { id: string };
      message?: { ts: string };
    };
    if (!payload.actions?.length) return;
    const interactionChannelId = payload.channel?.id;
    if (!interactionChannelId
      || (!this.conversationChannelIds.includes(interactionChannelId)
        && !this.notificationChannelIds.includes(interactionChannelId))) return;

    try {
      const action = payload.actions[0];
      const target = parseDecisionButtonId(action.action_id);
      if (!target) return;
      const t = connectorText(await this.core.language());
      const selected = resolveDecisionButtonTarget(await this.fetchPendingDecisions(), target);
      if (!selected) {
        throw new Error(t.decisionGone);
      }
      const messageRef = payload.message?.ts ?? "none";
      const outcome = await submitDecisionAnswer(this.core, {
        decisionId: selected.decisionId,
        answer: selected.label,
        optionKey: selected.optionKey,
        displayLabel: selected.label,
        source: "slack",
        sourceMessageId: payload.message?.ts ?? null,
        idempotencyKey: `slack:decision:${selected.decisionId}:${selected.optionKey}:${messageRef}`,
        expectedVersion: selected.stateVersion,
      });

      if (payload.channel) {
        await postSlackMessage(this.web, {
          channel: payload.channel.id,
          text: outcome.kind === "accepted" ? t.answeredWith(selected.label) : t.alreadyAnswered(outcome.label),
        });
      }
    } catch (error) {
      await this.reportMessageError(payload.channel?.id, error);
    }
  }

  private async handleCoreEvent(event: OwlEvent): Promise<void> {
    if (event.type === "advisor.responded") {
      await this.handleAdvisorResponse(event);
      return;
    }
    if (!shouldNotify(event.type, event.payload)) return;
    const decisionId = event.type === "decision.opened" || event.type === "decision.resolved" || event.type === "decision.cancelled"
      ? (typeof event.payload.decision_id === "string" ? event.payload.decision_id : null)
      : null;

    if (event.type === "decision.resolved" || event.type === "decision.cancelled") {
      const posted = decisionId ? this.core.decisionMessage(decisionId) : null;
      if (posted) {
        try {
          await updateNotification(this.web, posted, event, await this.core.language());
        } catch (error) {
          await this.reportNotificationFailure(event, error);
        }
        if (decisionId) await this.core.forgetDecisionMessage(decisionId);
        return;
      }
    }

    try {
      await sendNotification(this.web, event, this.notificationChannelIds.map((channelId) => ({ channelId })), {
        language: await this.core.language(),
        onPosted: async ({ channelId, ts }) => {
          if (decisionId) {
            await this.core.rememberDecisionMessage(decisionId, {
              channel_id: channelId,
              message_ref: ts,
              posted_at: new Date().toISOString(),
            });
          }
        },
      });
    } catch (error) {
      await this.reportNotificationFailure(event, error);
    }
  }

  /** Decision whose notification thread this message replies in, if known. */
  private decisionForThread(message: SlackMessage): string | null {
    if (!message.thread_ts || message.thread_ts === message.ts) return null;
    for (const [decisionId, ref] of this.core.listDecisionMessages()) {
      if (ref.channel_id === message.channel && ref.message_ref === message.thread_ts) return decisionId;
    }
    return null;
  }

  /** Surface a notification that failed after retries, with the event sequence. */
  private async reportNotificationFailure(event: OwlEvent, error: unknown): Promise<void> {
    const decisionId = typeof event.payload.decision_id === "string" ? event.payload.decision_id : null;
    const t = connectorText(await this.core.language());
    const subject = t.notificationSubject(event.sequence, event.type, decisionId ? decisionShortId(decisionId) : null);
    const message = formatIntegrationError("Slack", error, await this.core.language());
    console.error(`[slack] Notification delivery failed (event #${event.sequence} ${event.type}, event_id ${event.event_id}): ${formatIntegrationError("Slack", error, "en")}`);
    for (const channelId of this.conversationChannelIds) {
      await postSlackMessage(this.web, { channel: channelId, text: t.notificationFailed(subject, message) })
        .catch((postError) => console.error(`[slack] Could not post notification failure to ${channelId}:`, postError));
    }
  }

  private async handleAdvisorResponse(event: OwlEvent): Promise<void> {
    const origin = asRecord(event.payload.origin);
    if (origin?.channel !== "slack") return;

    const threadTs = typeof origin.ref === "string" ? origin.ref : undefined;
    const channel = resolveSlackAdvisorChannel(event, this.conversationChannelIds, this.threadChannels, threadTs);
    if (!channel) {
      throw new Error("Could not determine the Slack channel for the Advisor reply.");
    }
    try {
      const reply = await this.fetchAdvisorReply(event);
      // Core is the sole parsing point for Advisor replies: it has already
      // parsed and dispatched any action fence before emitting this event, so
      // `reply` is the text Core decided to show, as-is.
      await postSlackMessage(this.web, {
        channel,
        // Reply in the same thread the operator messaged from, if any; a
        // channel-scoped conversation does not imply a thread.
        ...(threadTs ? { thread_ts: threadTs } : {}),
        text: formatAdvisorReply(reply, event.payload.suggested_actions, await this.core.language()),
      });
    } catch (error) {
      await this.reportMessageError(channel, error);
    }
  }

  private async fetchAdvisorReply(event: OwlEvent): Promise<string> {
    for (const candidate of [event.payload.reply, event.payload.text]) {
      if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
    }

    const conversationId = event.payload.conversation_id;
    const messageId = event.payload.message_id;
    if (typeof conversationId !== "string" || typeof messageId !== "string") {
      throw new Error("The Advisor reply event has no conversation id or message id.");
    }

    const response = await this.core.request<unknown>(`/conversations/${encodeURIComponent(conversationId)}/messages?limit=200`);
    const messages = Array.isArray(response)
      ? response
      : asRecord(response)?.data && Array.isArray(asRecord(response)?.data)
        ? asRecord(response)?.data as unknown[]
        : null;
    if (!messages) throw new Error("Core returned a malformed Advisor message list.");
    const message = messages.find((candidate) => asRecord(candidate)?.id === messageId);
    const body = asRecord(message)?.body;
    if (typeof body !== "string" || body.trim().length === 0) {
      throw new Error("Could not read the Advisor reply body from Core.");
    }
    return body;
  }

  private async fetchPendingDecisions(): Promise<PendingDecision[]> {
    const decisions: PendingDecision[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    for (let pageCount = 0; pageCount < MAX_PENDING_DECISION_PAGES; pageCount += 1) {
      const query = new URLSearchParams({ status: "open", limit: String(PENDING_DECISION_PAGE_LIMIT) });
      if (cursor !== null) query.set("cursor", cursor);
      const page = await this.core.requestPage<PendingDecision[]>(`/decisions?${query.toString()}`);
      if (!Array.isArray(page.data)) {
        throw new Error("Core pending decisions response returned invalid data");
      }
      decisions.push(...page.data);
      if (!page.has_more) return decisions;

      if (!page.cursor || seenCursors.has(page.cursor)) {
        throw new Error("Core pending decisions response returned a non-advancing cursor");
      }
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }

    throw new Error("Core pending decisions pagination exceeded the safety limit");
  }

  private async reportMessageError(channelId: string | undefined, error: unknown): Promise<void> {
    const message = formatIntegrationError("Owl", error, await this.core.language());
    console.error(`[slack] Message processing failed: ${formatIntegrationError("Owl", error, "en")}`, error);
    if (!channelId) return;
    await postSlackMessage(this.web, {
      channel: channelId,
      text: `⚠ ${message}`,
    }).catch((postError) => console.error("[slack] Could not post the failure message:", postError));
  }

  private async reportEventError(error: unknown): Promise<void> {
    const message = formatIntegrationError("Owl", error, await this.core.language());
    console.error(`[slack] Event processing failed: ${formatIntegrationError("Owl", error, "en")}`, error);
    // Event failures have no guaranteed source thread. Use the configured
    // conversation channels only as a visible diagnostic destination; a
    // failed post is logged and never retried as another provider.
    for (const channelId of this.conversationChannelIds) {
      await postSlackMessage(this.web, { channel: channelId, text: `⚠ ${message}` }).catch((postError) =>
        console.error(`[slack] Could not post event failure to ${channelId}:`, postError));
    }
  }
}

/**
 * Resolve the Advisor destination without requiring this connector's in-memory
 * thread map. New events carry origin.channel_id persisted by Core; the older
 * payload/channel and map fallbacks keep compatible events working while still
 * enforcing the configured conversation channel boundary.
 */
export function resolveSlackAdvisorChannel(
  event: OwlEvent,
  conversationChannelIds: readonly string[] | string,
  threadChannels: ReadonlyMap<string, string> = new Map(),
  threadTs = advisorThreadRef(event),
): string | null {
  const origin = asRecord(event.payload.origin);
  if (origin?.channel !== "slack") return null;
  const channel = typeof origin.channel_id === "string"
    ? origin.channel_id
    : typeof event.payload.channel_id === "string"
      ? event.payload.channel_id
      : typeof event.payload.channel === "string"
        ? event.payload.channel
        : threadTs ? threadChannels.get(threadTs) : undefined;
  const allowedChannels = typeof conversationChannelIds === "string"
    ? parseChannelIds(conversationChannelIds)
    : conversationChannelIds;
  return channel && allowedChannels.includes(channel) ? channel : null;
}

function parseChannelIds(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/u).map((item) => item.trim()).filter((item) => item.length > 0))];
}

/** Socket Mode emits all interactive envelopes under the `interactive` event. */
export function isSlackBlockActionsPayload(value: unknown): value is {
  readonly type: "block_actions";
  readonly actions: readonly { readonly action_id: string; readonly value: string }[];
} {
  const payload = asRecord(value);
  return payload?.type === "block_actions" && Array.isArray(payload.actions);
}

function advisorThreadRef(event: OwlEvent): string | undefined {
  const origin = asRecord(event.payload.origin);
  return typeof origin?.ref === "string" ? origin.ref : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function slackTimestampToIso(value: string): string {
  const seconds = Number.parseFloat(value);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : new Date().toISOString();
}
