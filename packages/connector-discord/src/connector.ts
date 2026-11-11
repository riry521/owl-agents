import {
  Client,
  DiscordAPIError,
  RateLimitError,
  GatewayIntentBits,
  Partials,
  Events,
  type Message,
  type Interaction,
  type MessageCreateOptions,
} from "discord.js";
import { CoreClient, commandEnvelope, formatIntegrationError } from "@owl/plugin-sdk";
import {
  routeInboundMessage,
  answerDecisionButton,
  connectorText,
  parseDecisionButtonId,
  type OutboundFile,
  FileConnectorStateStore,
  asRecord,
  buildAdvisorReplyText,
  deliverFilesToChannel,
  deliverNotification,
  dispatchCoreEvent,
  refreshBoundChannels,
  routeAdvisorOrigin,
  sendOutboundFiles,
  type OwlLanguage,
  type UploadFailure,
  fetchPendingDecisions,
  parseChannelIds,
  reportNotificationFailure,
  type OutboundFileResult,
  type PendingDecision,
} from "@owl/plugin-sdk/shared";
import type { ChannelAdmin, OwlEvent } from "@owl/plugin-sdk";
import { createDiscordChannelAdmin } from "./channel-admin.js";
import type { DiscordConfig, DiscordMessage } from "./types.js";
import { sendNotification, shouldNotify, updateNotification } from "./notifications.js";
import { downloadAttachment } from "./files.js";

const DEFAULT_CHAR_LIMIT = 2000;
// Replies carry Advisor output and user-supplied names; like notifications,
// they must never ping @everyone, roles or users.
const NO_MENTIONS = { parse: [] } as const;

export class DiscordConnector {
  private readonly config: DiscordConfig;
  private readonly conversationChannelIds: readonly string[];
  private readonly notificationChannelIds: readonly string[];
  private boundChannelIds: ReadonlySet<string> = new Set();
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
        GatewayIntentBits.Guilds,
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
      void (async () => {
        const replyToDecisionId = await this.decisionForReply(message);
        if (!this.isConversationChannel(message.channelId) && !replyToDecisionId) return;
        await this.handleMessage(message, replyToDecisionId);
      })().catch((err) => this.reportMessageError(message, err));
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isButton()) return;
      void this.handleButtonInteraction(interaction).catch((err) =>
        console.error(`[discord] interaction handler error: ${formatIntegrationError("Owl", err)}`, err)
      );
    });

    // Load the bound channels before the first message can arrive; until then
    // the channel filter would drop them (Slack acks first, so no redelivery).
    await this.refreshBindings();
    // Connect to Discord first: a bad token/gateway config fails here, before
    // any Core resource (WebSocket, persisted cursor) is touched.
    await this.client.login(this.config.botToken);
    console.log("[discord] Connected via Gateway");

    // Core emits no work.failed: Work failures arrive as work-scoped system.alert
    // events (or as a Decision), which notifications.ts renders as failures.
    try {
      await this.core.subscribeEvents(
        ["advisor.responded", "advisor.channel_binding_changed", "decision.opened", "decision.resolved", "decision.cancelled", "work.completed", "work.cancelled", "work.paused", "work.reopened", "provider.paused", "provider.resumed", "system.alert"],
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

  private async handleMessage(message: Message, routedDecisionId?: string | null): Promise<void> {
    const discordMsg: DiscordMessage = {
      userId: message.author.id,
      text: message.content,
      channelId: message.channelId,
      messageId: message.id,
      replyToDecisionId: routedDecisionId === undefined ? await this.decisionForReply(message) : routedDecisionId,
      attachments: [...message.attachments.values()].map((a) => ({
        id: a.id,
        name: a.name,
        size: a.size,
        contentType: a.contentType,
        url: a.url,
      })),
    };
    await routeInboundMessage(this.core, {
      source: "discord",
      fetchPendingDecisions: () => this.fetchPendingDecisions(),
      accountId: this.config.accountId,
      statusKeywords: this.config.statusKeywords,
      message: discordMsg,
      messageId: message.id,
      reply: (text) => this.sendLong(message, text),
      notice: (text) => this.sendLong(message, text),
      // Same grouping sendToCore uses for this message's conversation_hint, so an attachment uploaded ahead of the message lands in the same conversation.
      conversationHint: { work_id: null, dm_ref: message.channelId, thread_ref: message.channelId },
      tempDirPrefix: "owl-discord-upload-",
      download: async (attachment, dir) => {
        if (this.config.maxFileSize !== undefined && attachment.size > this.config.maxFileSize) {
          console.warn(`[discord] Skipping ${attachment.name}: ${attachment.size} bytes exceeds maxFileSize ${this.config.maxFileSize}`);
          return null;
        }
        return downloadAttachment(attachment, dir, this.config.maxFileSize);
      },
      sendInbound: (text, attachmentIds, statusReply) => this.sendToCore(message, text, attachmentIds, statusReply),
    });
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

      const answered = await answerDecisionButton(this.core, { source: "discord", target, fetchPendingDecisions: () => this.fetchPendingDecisions(), messageId: interaction.message?.id ?? null });
      await interaction.editReply({ content: answered.text });
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

  /** Channel create / rename / describe with the bot's discord.js Client; the HTTP API reaches it through ConnectorManager. */
  channelAdmin(): ChannelAdmin {
    return createDiscordChannelAdmin(this.client, this.conversationChannelIds);
  }

  private isConversationChannel(channelId: string): boolean {
    return this.conversationChannelIds.includes(channelId) || this.boundChannelIds.has(channelId);
  }

  private async refreshBindings(): Promise<void> {
    this.boundChannelIds = await refreshBoundChannels(this.core, "discord", this.boundChannelIds);
  }

  private handleCoreEvent(event: OwlEvent): Promise<void> {
    return dispatchCoreEvent(event, {
      refreshBindings: () => this.refreshBindings(),
      advisorResponse: (advisorEvent) => this.handleAdvisorResponse(advisorEvent),
      shouldNotify,
      notify: (notifyEvent) => deliverNotification(this.core, notifyEvent, {
        update: (posted, language) => updateNotification(this.client, posted, notifyEvent, language),
        send: (language, remember) => sendNotification(this.client, notifyEvent, this.notificationChannelIds, {
          language,
          onPosted: ({ channelId, messageId }) => remember(channelId, messageId),
        }),
        fail: (error) => this.reportNotificationFailure(notifyEvent, error),
      }),
    });
  }

  /** Decision whose notification this message replies to, if known. */
  private async decisionForReply(message: Pick<Message, "reference" | "fetchReference">): Promise<string | null> {
    const referenced = message.reference?.messageId;
    if (!referenced) return null;
    for (const [decisionId, ref] of this.core.listDecisionMessages()) {
      if (ref.message_ref === referenced) return decisionId;
    }
    try {
      const referencedMessage = await message.fetchReference();
      if (!this.client.user?.id || referencedMessage.author.id !== this.client.user.id) return null;
      const parentMessageId = referencedMessage.reference?.messageId;
      if (!parentMessageId) return null;
      for (const [decisionId, ref] of this.core.listDecisionMessages()) {
        if (ref.message_ref === parentMessageId) return decisionId;
      }
    } catch {
      // A deleted or inaccessible reply target cannot be used to route an answer.
    }
    return null;
  }

  private reportNotificationFailure(event: OwlEvent, error: unknown): Promise<void> {
    return reportNotificationFailure(this.core, event, error, { tag: "discord", label: "Discord" }, this.conversationChannelIds,
      async (channelId, text) => {
        const channel = await this.client.channels.fetch(channelId);
        if (channel && channel.isTextBased() && "send" in channel) {
          await channel.send({ content: text, allowedMentions: NO_MENTIONS });
        }
      });
  }

  private async handleAdvisorResponse(event: OwlEvent): Promise<void> {
    if (!await routeAdvisorOrigin(event, "discord", (channelId) => this.deliverToChannel(event, channelId))) return;
    const channelId = resolveDiscordAdvisorChannel(event, [...this.conversationChannelIds, ...this.boundChannelIds]);
    if (!channelId) {
      console.error("[discord] Advisor response has no configured destination channel:", event.payload.origin);
      return;
    }

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        throw new Error(`The Discord channel ${channelId} for the Advisor reply is not available.`);
      }
      const text = await buildAdvisorReplyText(this.core, event, (files, language) => this.uploadOutboundFiles(channel, files, language));
      for (const chunk of splitAtParagraphs(text, this.charLimit)) {
        await channel.send({ content: chunk, allowedMentions: NO_MENTIONS });
      }
    } catch (error) {
      await this.reportChannelError(channelId, error);
    }
  }

  private deliverToChannel(event: OwlEvent, channelId: string): Promise<void> {
    const fetchAllowed = async () => {
      if (!this.isConversationChannel(channelId)) return null;
      const channel = await this.client.channels.fetch(channelId).catch(() => null);
      return channel && channel.isTextBased() && "send" in channel ? channel : null;
    };
    return deliverFilesToChannel(this.core, event, {
      resolveChannel: async () => {
        const channel = await fetchAllowed();
        if (channel) return channel;
        await this.refreshBindings();
        return fetchAllowed();
      },
      notAllowedMessage: `Discord のチャンネル ${channelId} は Connector の配送先に入っていないか、取得できません。`,
      upload: (channel, files, language) => this.uploadOutboundFiles(channel, files, language),
      onError: (error) => this.reportChannelError(channelId, error),
    });
  }

  private uploadOutboundFiles(
    channel: { send(options: MessageCreateOptions): Promise<unknown> },
    files: readonly OutboundFile[],
    language: OwlLanguage,
  ): Promise<{ lines: string[]; results: OutboundFileResult[] }> {
    return sendOutboundFiles(files, language, {
      label: "Discord",
      send: async (file, bytes) => {
        await channel.send({
          ...(file.comment ? { content: file.comment } : {}),
          files: [{ attachment: bytes, name: file.name }],
          allowedMentions: NO_MENTIONS,
        });
      },
      classifyError: classifyDiscordUploadError,
      hint: discordSendHint,
    });
  }

  private async sendToCore(message: Message, text: string, attachmentIds: readonly string[], statusReply?: string): Promise<void> {
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
      ...(statusReply === undefined ? {} : { status_reply: statusReply }),
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
    await channel.send({ content, allowedMentions: NO_MENTIONS });
  }

  /** Instance seam over the shared reader so tests can stub the open Decisions. */
  private fetchPendingDecisions(): Promise<PendingDecision[]> {
    return fetchPendingDecisions(this.core);
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
        await channel.send({ content: `⚠ ${safe}`, allowedMentions: NO_MENTIONS });
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

/** Failed only when Discord plainly refused the send (4xx); a 5xx, a timeout or an unrecognised error may have gone through. */
export function classifyDiscordUploadError(error: unknown): UploadFailure {
  if (error instanceof RateLimitError || (error instanceof DiscordAPIError && error.status === 429)) {
    return { outcome: "failed", code: "upload_rate_limited", platform_error: null };
  }
  if (error instanceof DiscordAPIError && error.status >= 400 && error.status < 500) {
    return { outcome: "failed", code: "upload_rejected", platform_error: String(error.code).slice(0, 100) };
  }
  return { outcome: "unknown", code: "upload_unknown", platform_error: null };
}

function discordSendHint(error: unknown, t: ReturnType<typeof connectorText>): string {
  const wrapper = asRecord(error);
  const code = wrapper && Object.hasOwn(wrapper, "code") ? wrapper.code : undefined;
  if (code === 50013) return t.fileSendHint.discordPermission;
  if (code === 40005) return t.fileSendHint.discordTooLarge;
  return "";
}
