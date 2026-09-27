import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  type Message,
  type Interaction,
} from "discord.js";
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
import type { DiscordConfig, DiscordMessage } from "./types.js";
import { sendNotification, shouldNotify, updateNotification } from "./notifications.js";
import { downloadAttachment } from "./files.js";

const DEFAULT_CHAR_LIMIT = 2000;
const PENDING_DECISION_PAGE_LIMIT = 50;
const MAX_PENDING_DECISION_PAGES = 10_000;

export class DiscordConnector {
  private readonly config: DiscordConfig;
  private readonly conversationChannelIds: readonly string[];
  private readonly notificationChannelIds: readonly string[];
  private readonly client: Client;
  private readonly core: CoreClient;
  private readonly charLimit: number;
  private stopped = false;

  constructor(config: DiscordConfig) {
    this.config = config;
    this.conversationChannelIds = parseChannelIds(config.conversationChannelId);
    this.notificationChannelIds = parseChannelIds(config.notificationChannelId);
    this.client = new Client({
      intents: [
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
    this.core = new CoreClient({
      core_api_base: config.coreApiBase,
      core_ws_url: config.coreWsUrl,
      plugin_name: "discord",
      api_token: config.apiToken,
      account_id: config.accountId,
      state_store: config.stateFile ? new FileConnectorStateStore(config.stateFile) : undefined,
    });
    this.charLimit = config.messageCharLimit ?? DEFAULT_CHAR_LIMIT;
  }

  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, (message) => {
      if (message.author.bot) return;
      if (message.channel.isDMBased()) return;
      if (!this.conversationChannelIds.includes(message.channelId) && !this.decisionForReply(message)) return;
      void this.handleMessage(message).catch((err) =>
        this.reportMessageError(message, err)
      );
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isButton()) return;
      void this.handleButtonInteraction(interaction).catch((err) =>
        console.error(`[discord] interaction handler error: ${formatIntegrationError("Owl", err)}`, err)
      );
    });

    // Connect to Discord first: a bad token/gateway config fails here, before
    // any Core resource (WebSocket, persisted cursor) is touched.
    await this.client.login(this.config.botToken);
    console.log("[discord] Connected via Gateway");

    // Core emits no work.failed: Work failures arrive as work-scoped system.alert
    // events (or as a Decision), which notifications.ts renders as failures.
    try {
      await this.core.subscribeEvents(
        ["advisor.responded", "decision.opened", "decision.resolved", "decision.cancelled", "work.completed", "work.cancelled", "work.paused", "work.reopened", "system.alert"],
        (event) => this.handleCoreEvent(event).catch((err) =>
          this.reportEventError(err)
        ),
      );
    } catch (error) {
      // Subscribing failed after Discord already connected: tear the Discord
      // connection back down rather than leaving it live with no Core events flowing.
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.client.destroy();
    this.core.close();
    console.log("[discord] Disconnected");
  }

  private async handleMessage(message: Message): Promise<void> {
    const discordMsg: DiscordMessage = {
      userId: message.author.id,
      text: message.content,
      channelId: message.channelId,
      messageId: message.id,
      replyToDecisionId: this.decisionForReply(message),
      attachments: [...message.attachments.values()].map((a) => ({
        id: a.id,
        name: a.name,
        size: a.size,
        contentType: a.contentType,
        url: a.url,
      })),
    };

    const pendingDecisions = await this.fetchPendingDecisions();
    const language = await this.core.language();
    const t = connectorText(language);
    const intent = classifyIntent(discordMsg, pendingDecisions, this.config.statusKeywords, language);

    switch (intent.kind) {
      case "status_query": {
        const status = await formatStatusResponse(this.core, language);
        await this.sendLong(message, status);
        break;
      }

      case "decision_answer": {
        const pending = pendingDecisions.find((candidate) => candidate.id === intent.decisionId);
        const outcome = await submitDecisionAnswer(this.core, {
          decisionId: intent.decisionId,
          answer: intent.answer,
          optionKey: intent.optionKey,
          displayLabel: intent.optionLabel ?? intent.answer,
          source: "discord",
          sourceMessageId: message.id,
          idempotencyKey: `discord:decision:${intent.decisionId}:msg:${message.id}`,
          expectedVersion: pending?.state_version ?? 0,
        });
        await this.sendNativeMessage(
          message,
          outcome.kind === "accepted" ? t.answerAccepted(decisionShortId(intent.decisionId)) : t.alreadyAnswered(outcome.label),
        );
        break;
      }

      case "decision_clarification": {
        await this.sendLong(message, intent.text);
        break;
      }

      case "file_upload": {
        // Same grouping sendToCore uses for this message's conversation_hint
        // (dm_ref = thread_ref = channelId), so an attachment uploaded ahead
        // of the message still lands in the conversation the message
        // resolves to.
        const conversationHint = { work_id: null, dm_ref: message.channelId, thread_ref: message.channelId };
        const tempDir = await mkdtemp(join(tmpdir(), "owl-discord-upload-"));
        const attachmentIds: string[] = [];
        try {
          for (const attachment of intent.files) {
            if (this.config.maxFileSize !== undefined && attachment.size > this.config.maxFileSize) {
              console.warn(`[discord] Skipping ${attachment.name}: ${attachment.size} bytes exceeds maxFileSize ${this.config.maxFileSize}`);
              continue;
            }
            const result = await downloadAttachment(attachment, tempDir, this.config.maxFileSize);
            try {
              const bytes = await readFile(result.path);
              const uploaded = await uploadAttachment(this.core, {
                provider: "discord",
                account_id: this.config.accountId,
                external_attachment_id: attachment.id,
                conversation_hint: conversationHint,
                work_id: null,
                file: { name: attachment.name, mime: result.mime, bytes },
              });
              attachmentIds.push(uploaded.upload_id);
              const notice = t.fileReceived(attachment.name, formatBytes(result.size), result.knownFormat);
              await this.sendNativeMessage(message, uploaded.status === "quarantined" ? `${notice}\n${t.executableNotRun}` : notice);
            } finally {
              await unlink(result.path).catch(() => undefined);
            }
          }
        } finally {
          await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
        if (attachmentIds.length === 0 && !intent.text) break;
        await this.sendToCore(message, intent.text ?? "", attachmentIds);
        break;
      }

      case "conversation": {
        await this.sendToCore(message, intent.text, []);
        break;
      }
    }
  }

  private async handleButtonInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton()) return;
    if (!interaction.channelId
      || (!this.conversationChannelIds.includes(interaction.channelId)
        && !this.notificationChannelIds.includes(interaction.channelId))) return;
    const target = parseDecisionButtonId(interaction.customId);
    if (!target) return;
    let acknowledged = false;
    try {
      // Discord requires an acknowledgement promptly. Validate the local
      // custom ID and channel first, then acknowledge before any Core I/O.
      await interaction.deferReply({ ephemeral: true });
      acknowledged = true;

      const t = connectorText(await this.core.language());
      const selected = resolveDecisionButtonTarget(await this.fetchPendingDecisions(true), target);
      if (!selected) {
        await interaction.editReply({ content: t.decisionGone });
        return;
      }
      const messageRef = interaction.message?.id ?? "none";
      const outcome = await submitDecisionAnswer(this.core, {
        decisionId: selected.decisionId,
        answer: selected.label,
        optionKey: selected.optionKey,
        displayLabel: selected.label,
        source: "discord",
        sourceMessageId: interaction.message?.id ?? null,
        idempotencyKey: `discord:decision:${selected.decisionId}:${selected.optionKey}:${messageRef}`,
        expectedVersion: selected.stateVersion,
      });

      await interaction.editReply({
        content: outcome.kind === "accepted" ? t.answeredWith(selected.label) : t.alreadyAnswered(outcome.label),
      });
    } catch (error) {
      // Keep the interaction answered even when pending-list/Core I/O fails.
      // Do not call reply after deferReply; the flags also cover a Discord
      // client error that happened after the acknowledgement reached Discord.
      const message = formatIntegrationError("Owl", error, await this.core.language());
      console.error(`[discord] decision interaction failed: ${formatIntegrationError("Owl", error, "en")}`, error);
      if (acknowledged || interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: `⚠ ${message}` }).catch((replyError) =>
          console.error("[discord] Could not post the decision failure message:", replyError));
      } else {
        await interaction.reply({ content: `⚠ ${message}`, ephemeral: true }).catch((replyError) =>
          console.error("[discord] Could not post the decision failure message:", replyError));
      }
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
          await updateNotification(this.client, posted, event, await this.core.language());
        } catch (error) {
          await this.reportNotificationFailure(event, error);
        }
        if (decisionId) await this.core.forgetDecisionMessage(decisionId);
        return;
      }
    }

    try {
      await sendNotification(this.client, event, this.notificationChannelIds, {
        language: await this.core.language(),
        onPosted: async ({ channelId, messageId }) => {
          if (decisionId) {
            await this.core.rememberDecisionMessage(decisionId, {
              channel_id: channelId,
              message_ref: messageId,
              posted_at: new Date().toISOString(),
            });
          }
        },
      });
    } catch (error) {
      await this.reportNotificationFailure(event, error);
    }
  }

  /** Decision whose notification this message replies to, if known. */
  private decisionForReply(message: Pick<Message, "reference">): string | null {
    const referenced = message.reference?.messageId;
    if (!referenced) return null;
    for (const [decisionId, ref] of this.core.listDecisionMessages()) {
      if (ref.message_ref === referenced) return decisionId;
    }
    return null;
  }

  /** Surface a notification that failed after retries, with the event sequence. */
  private async reportNotificationFailure(event: OwlEvent, error: unknown): Promise<void> {
    const decisionId = typeof event.payload.decision_id === "string" ? event.payload.decision_id : null;
    const language = await this.core.language();
    const t = connectorText(language);
    const subject = t.notificationSubject(event.sequence, event.type, decisionId ? decisionShortId(decisionId) : null);
    const safe = formatIntegrationError("Discord", error, language);
    console.error(`[discord] Notification delivery failed (event #${event.sequence} ${event.type}, event_id ${event.event_id}): ${formatIntegrationError("Discord", error, "en")}`);
    for (const channelId of this.conversationChannelIds) {
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (channel && channel.isTextBased() && "send" in channel) {
          await channel.send({ content: t.notificationFailed(subject, safe) });
        }
      } catch (postError) {
        console.error(`[discord] Could not post notification failure to ${channelId}:`, postError);
      }
    }
  }

  private async handleAdvisorResponse(event: OwlEvent): Promise<void> {
    const origin = asRecord(event.payload.origin);
    if (origin?.channel !== "discord") return;

    const channelId = resolveDiscordAdvisorChannel(event, this.conversationChannelIds);
    if (!channelId) {
      console.error("[discord] Advisor response has no configured destination channel:", event.payload.origin);
      return;
    }

    try {
      const reply = await this.fetchAdvisorReply(event);
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        throw new Error(`The Discord channel ${channelId} for the Advisor reply is not available.`);
      }
      // Core is the sole parsing point: `reply` is already the text Core
      // decided to show. Append any structured suggested_actions it left
      // unhandled, the same way the Slack connector does.
      const text = formatAdvisorReply(reply, event.payload.suggested_actions, await this.core.language());
      for (const chunk of splitAtParagraphs(text, this.charLimit)) {
        await channel.send({ content: chunk });
      }
    } catch (error) {
      await this.reportChannelError(channelId, error);
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

  private async sendToCore(message: Message, text: string, attachmentIds: readonly string[]): Promise<void> {
    const envelope = commandEnvelope({
      provider: "discord",
      account_id: this.config.accountId,
      external_message_id: message.id,
      user_id: message.author.id,
      channel_id: message.channelId,
      thread_id: message.channelId,
      received_at: new Date().toISOString(),
      text,
      conversation_hint: {
        work_id: null,
        dm_ref: message.channelId,
        thread_ref: message.channelId,
      },
      attachment_ids: attachmentIds,
    }, `discord:message:${this.config.accountId}:${message.id}`);
    await this.core.request("/inbound/messages", {
      method: "POST",
      body: envelope.payload,
      headers: {
        "X-Request-Id": String(envelope.request_id),
        "Idempotency-Key": String(envelope.idempotency_key),
      },
    });
  }

  private async sendLong(message: Message, text: string): Promise<void> {
    if (text.length <= this.charLimit) {
      await this.sendNativeMessage(message, text);
      return;
    }
    const chunks = splitAtParagraphs(text, this.charLimit);
    for (const chunk of chunks) {
      await this.sendNativeMessage(message, chunk);
    }
  }

  private async sendNativeMessage(message: Message, content: string): Promise<void> {
    const channel = message.channel;
    if (!channel.isTextBased() || !("send" in channel)) {
      throw new Error("The Discord channel for this message is not available.");
    }
    await channel.send({ content });
  }

  private async fetchPendingDecisions(_throwOnError = true): Promise<PendingDecision[]> {
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

  private async reportMessageError(message: Message, error: unknown): Promise<void> {
    const safe = formatIntegrationError("Owl", error, await this.core.language());
    console.error(`[discord] Message processing failed: ${formatIntegrationError("Owl", error, "en")}`, error);
    await this.sendNativeMessage(message, `⚠ ${safe}`).catch((postError) =>
      console.error("[discord] Could not post the failure message:", postError));
  }

  private async reportChannelError(channelId: string, error: unknown): Promise<void> {
    const safe = formatIntegrationError("Owl", error, await this.core.language());
    console.error(`[discord] Channel processing failed: ${formatIntegrationError("Owl", error, "en")}`, error);
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && channel.isTextBased() && "send" in channel) {
        await channel.send({ content: `⚠ ${safe}` });
      }
    } catch (postError) {
      console.error(`[discord] Could not post the failure message to ${channelId}:`, postError);
    }
  }

  private async reportEventError(error: unknown): Promise<void> {
    const safe = formatIntegrationError("Owl", error);
    console.error(`[discord] Event processing failed: ${safe}`, error);
    for (const channelId of this.conversationChannelIds) {
      await this.reportChannelError(channelId, error);
    }
  }
}

export function resolveDiscordAdvisorChannel(
  event: OwlEvent,
  conversationChannelIds: readonly string[] | string,
): string | null {
  const origin = asRecord(event.payload.origin);
  if (origin?.channel !== "discord") return null;
  const channelId = typeof origin.channel_id === "string"
    ? origin.channel_id
    : typeof origin.ref === "string"
      ? origin.ref
      : typeof event.payload.channel_id === "string"
        ? event.payload.channel_id
        : null;
  const allowedChannels = typeof conversationChannelIds === "string"
    ? parseChannelIds(conversationChannelIds)
    : conversationChannelIds;
  return channelId && allowedChannels.includes(channelId) ? channelId : null;
}

function parseChannelIds(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/u).map((item) => item.trim()).filter((item) => item.length > 0))];
}

function splitAtParagraphs(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut <= 0) cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
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
