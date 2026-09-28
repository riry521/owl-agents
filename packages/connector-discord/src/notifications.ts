import type { Client as DiscordClient, MessageCreateOptions } from "discord.js";
import {
  buildNotificationCard,
  isNotificationCardEvent,
  retryTransient,
  type ConnectorDecisionMessageRef,
  type OwlLanguage,
  type RetryOptions,
} from "@owl/plugin-sdk/shared";
import { formatIntegrationError } from "@owl/plugin-sdk";
import type { OwlEvent } from "@owl/plugin-sdk";
import { discordTimestamp, renderDiscordCard, renderDiscordDecisionDetail } from "./card.js";

/** A notification message Discord accepted; replies reference `messageId`. */
export interface PostedNotification {
  readonly channelId: string;
  readonly messageId: string;
}

export interface PostedDecisionDetail {
  readonly channelId: string;
  readonly messageId: string;
  readonly parentMessageId: string;
}

export interface SendNotificationOptions {
  /** Called for each channel's main post after Discord accepts it. */
  readonly onPosted?: (posted: PostedNotification) => void | Promise<void>;
  /** Called after Discord accepts a detail reply to the main post. */
  readonly onDetailPosted?: (posted: PostedDecisionDetail) => void | Promise<void>;
  readonly retry?: RetryOptions;
  /** The Owner language; decision.opened uses its payload language. */
  readonly language?: OwlLanguage;
}

class PermanentDeliveryError extends Error {}

type NotificationChannel = {
  send(options: MessageCreateOptions): Promise<{ id?: unknown }>;
};

export async function sendNotification(
  client: DiscordClient,
  event: OwlEvent,
  channelIds?: string | readonly string[],
  sendOptions: SendNotificationOptions = {},
): Promise<void> {
  const card = buildNotificationCard(event, {
    language: sendOptions.language ?? "ja",
    formatTime: discordTimestamp,
    replyStyle: "reply",
  });
  if (!card) return;
  const targets = parseChannelIds(channelIds);
  if (targets.length === 0) return;
  const rendered = renderDiscordCard(card);
  const language = sendOptions.language ?? "ja";
  const failures: string[] = [];

  for (const channelId of targets) {
    let notificationChannel: NotificationChannel | null = null;
    let parentMessageId: string | null = null;
    try {
      const sent = await retryTransient(async () => {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased() || !("send" in channel)) {
          throw new PermanentDeliveryError(`The notification channel ${channelId} is not available.`);
        }
        notificationChannel = channel as unknown as NotificationChannel;
        return notificationChannel.send({
          content: card.fallbackText,
          ...rendered,
          allowedMentions: { parse: [] },
        });
      }, {
        ...sendOptions.retry,
        onRetry: (error, attempt, delayMs) => console.warn(
          `[discord] Notification for event #${event.sequence} (${event.type}) to ${channelId} failed on attempt ${attempt}; retrying in ${delayMs}ms: ${formatIntegrationError("Discord", error, "en")}`,
        ),
      });
      const messageId = sent.id;
      if (typeof messageId === "string") {
        parentMessageId = messageId;
        await sendOptions.onPosted?.({ channelId, messageId });
      }
    } catch (error) {
      const attempts = (error as { attempts?: number }).attempts ?? 1;
      const message = formatIntegrationError("Discord", error, language);
      console.error(
        `[discord] Notification for event #${event.sequence} (${event.type}, ${event.event_id}) to channel ${channelId} failed after ${attempts} attempt(s): ${message}`,
        (error as { cause?: unknown }).cause ?? error,
      );
      failures.push(message);
    }

    if (notificationChannel && parentMessageId && card.threadDetail) {
      try {
        const detail = await retryTransient(() => notificationChannel!.send({
          ...renderDiscordDecisionDetail(card.threadDetail!, card.language),
          reply: { messageReference: parentMessageId!, failIfNotExists: false },
          allowedMentions: { parse: [], repliedUser: false },
        }), {
          ...sendOptions.retry,
          onRetry: (error, attempt, delayMs) => console.warn(
            `[discord] Decision detail for event #${event.sequence} (${event.type}) to ${channelId} failed on attempt ${attempt}; retrying in ${delayMs}ms: ${formatIntegrationError("Discord", error, "en")}`,
          ),
        });
        if (typeof detail.id === "string") {
          await sendOptions.onDetailPosted?.({ channelId, messageId: detail.id, parentMessageId });
        }
      } catch (error) {
        const attempts = (error as { attempts?: number }).attempts ?? 1;
        console.error(
          `[discord] Decision detail for event #${event.sequence} (${event.type}, ${event.event_id}) to channel ${channelId} failed after ${attempts} attempt(s); the notification itself was posted and is not re-sent: ${formatIntegrationError("Discord", error, "en")}`,
          (error as { cause?: unknown }).cause ?? error,
        );
      }
    }
  }

  if (failures.length > 0) throw new Error(failures.join(" "));
}

export async function updateNotification(
  client: DiscordClient,
  posted: ConnectorDecisionMessageRef,
  event: OwlEvent,
  language: OwlLanguage = "ja",
): Promise<void> {
  if (event.type !== "decision.resolved" && event.type !== "decision.cancelled") return;
  const card = buildNotificationCard(event, {
    language,
    formatTime: discordTimestamp,
    replyStyle: "reply",
  });
  if (!card) return;
  const { embeds } = renderDiscordCard(card);
  await retryTransient(async () => {
    const channel = await client.channels.fetch(posted.channel_id);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) {
      throw new PermanentDeliveryError(`The notification channel ${posted.channel_id} is not available.`);
    }
    const message = await (channel as unknown as {
      messages: { fetch(id: string): Promise<{ edit(options: unknown): Promise<unknown> }> };
    }).messages.fetch(posted.message_ref);
    await message.edit({ content: card.fallbackText, embeds, components: [], allowedMentions: { parse: [] } });
  });
}

export function shouldNotify(eventType: string, payload?: Record<string, unknown>): boolean {
  return isNotificationCardEvent(eventType, payload);
}

function parseChannelIds(value: string | readonly string[] | undefined): string[] {
  const values: readonly string[] = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.flatMap((item) => item.split(/[\s,]+/u).map((part) => part.trim()).filter((part) => part.length > 0)))];
}
