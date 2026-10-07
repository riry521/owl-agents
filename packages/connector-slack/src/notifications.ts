import type { WebClient } from "@slack/web-api";
import { formatIntegrationError } from "@owl/plugin-sdk";
import {
  buildDecisionClosedCard,
  buildNotificationCard,
  formatClockTime,
  isNotificationCardEvent,
  retryTransient,
  truncateText,
  type ConnectorDecisionMessageRef,
  type NotificationCard,
  type OwlLanguage,
  type RetryOptions,
} from "@owl/plugin-sdk/shared";
import type { OwlEvent } from "@owl/plugin-sdk";
import { postSlackMessage, prepareSlackMessage } from "./posting.js";

interface NotifyTarget {
  readonly channelId: string;
}

/** A notification message Slack accepted (`ts` is its thread parent id). */
export interface PostedNotification {
  readonly channelId: string;
  readonly ts: string;
}

export interface SendNotificationOptions {
  /** Called after Slack accepts the main notification, before a detail reply. */
  readonly onPosted?: (posted: PostedNotification) => void | Promise<void>;
  readonly retry?: RetryOptions;
  /** The Owner language (CoreClient.language()); decision.opened uses its payload's own. */
  readonly language?: OwlLanguage;
}

interface SlackCardMessage {
  readonly text: string;
  readonly blocks: unknown[];
  readonly attachments: Array<{ color: string; fallback: string; blocks: unknown[] }>;
}

const SECTION_TEXT_MAX = 2_900;
const ATTACHMENT_BLOCKS_MAX = 50;

function renderSlackCard(card: NotificationCard): SlackCardMessage {
  const attachmentBlocks: unknown[] = [];
  if (card.body) {
    attachmentBlocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncateText(card.body, SECTION_TEXT_MAX) },
    });
  }
  for (const field of card.fields) {
    attachmentBlocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncateText(`**${field.label}**\n${field.value}`, SECTION_TEXT_MAX) },
    });
  }
  if (card.actions.length > 0) {
    attachmentBlocks.push({
      type: "actions",
      elements: card.actions.map((action) => ({
        type: "button",
        text: { type: "plain_text", text: action.label, emoji: true },
        action_id: action.id,
        value: action.value,
        ...(action.recommended ? { style: "primary" } : {}),
      })),
    });
  }
  if (card.footer) {
    attachmentBlocks.push({
      type: "context",
      elements: [{ type: "plain_text", text: card.footer, emoji: true }],
    });
  }

  return {
    text: card.fallbackText,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: `**${card.emoji} ${card.title}**` } }],
    attachments: [{
      color: card.color,
      fallback: card.fallbackText,
      blocks: attachmentBlocks.slice(0, ATTACHMENT_BLOCKS_MAX),
    }],
  };
}

/** Slack date token that displays in each viewer's timezone, with a plain fallback. */
function slackDateToken(epochMs: number, language: OwlLanguage): string {
  return `<!date^${Math.floor(epochMs / 1_000)}^{date_short_pretty} {time}|${formatClockTime(epochMs, language)}>`;
}

export async function sendNotification(
  client: WebClient,
  event: OwlEvent,
  targets: NotifyTarget[],
  options: SendNotificationOptions = {},
): Promise<void> {
  if (!isNotificationCardEvent(event.type, event.payload)) return;
  const language = options.language ?? "ja";
  const card = buildNotificationCard(event, {
    language,
    formatTime: (epochMs) => slackDateToken(epochMs, language),
    replyStyle: "thread",
  });
  if (!card) return;

  const rendered = renderSlackCard(card);
  const failures: string[] = [];
  for (const target of targets) {
    let parentTs: string | null = null;
    try {
      const result = await retryTransient(
        () => postSlackMessage(client, {
          channel: target.channelId,
          ...rendered,
        } as Parameters<WebClient["chat"]["postMessage"]>[0]),
        {
          ...options.retry,
          onRetry: (error, attempt, delayMs) => console.warn(
            `[slack] Notification for event #${event.sequence} (${event.type}) to ${target.channelId} failed on attempt ${attempt}; retrying in ${delayMs}ms: ${formatIntegrationError("Slack", error, "en")}`,
          ),
        },
      );
      const ts = (result as { ts?: unknown } | undefined)?.ts;
      if (typeof ts === "string") {
        parentTs = ts;
        await options.onPosted?.({ channelId: target.channelId, ts });
      }
    } catch (error) {
      const attempts = (error as { attempts?: number }).attempts ?? 1;
      const message = formatIntegrationError("Slack", error, language);
      console.error(
        `[slack] Notification for event #${event.sequence} (${event.type}, ${event.event_id}) to channel ${target.channelId} failed after ${attempts} attempt(s): ${message}`,
        (error as { cause?: unknown }).cause ?? error,
      );
      failures.push(message);
    }

    if (parentTs !== null && card.threadDetail !== null) {
      await postDecisionDetail(client, event, target.channelId, parentTs, card.threadDetail, options.retry);
    }
  }
  if (failures.length > 0) throw new Error(failures.join(" "));
}

async function postDecisionDetail(
  client: WebClient,
  event: OwlEvent,
  channelId: string,
  parentTs: string,
  detail: string,
  retry?: RetryOptions,
): Promise<void> {
  try {
    await retryTransient(
      () => postSlackMessage(client, {
        channel: channelId,
        thread_ts: parentTs,
        text: detail,
      } as Parameters<WebClient["chat"]["postMessage"]>[0]),
      {
        ...retry,
        onRetry: (error, attempt, delayMs) => console.warn(
          `[slack] Decision detail for event #${event.sequence} to ${channelId} failed on attempt ${attempt}; retrying in ${delayMs}ms: ${formatIntegrationError("Slack", error, "en")}`,
        ),
      },
    );
  } catch (error) {
    const attempts = (error as { attempts?: number }).attempts ?? 1;
    console.error(
      `[slack] Decision detail for event #${event.sequence} (${event.type}, ${event.event_id}) to channel ${channelId} failed after ${attempts} attempt(s); the notification itself was posted and is not re-sent: ${formatIntegrationError("Slack", error, "en")}`,
    );
  }
}

/** Edit a closed Decision's original notice in place, without answer buttons. */
export async function updateNotification(
  client: WebClient,
  posted: ConnectorDecisionMessageRef,
  event: OwlEvent,
  language: OwlLanguage = "ja",
  retry?: RetryOptions,
): Promise<void> {
  const card = buildDecisionClosedCard(event, { language, question: null });
  if (!card) return;
  const rendered = renderSlackCard(card);
  const message = prepareSlackMessage({
    channel: posted.channel_id,
    ts: posted.message_ref,
    ...rendered,
  });
  await retryTransient(() => client.chat.update(
    message as unknown as Parameters<WebClient["chat"]["update"]>[0],
  ), retry);
}

export function shouldNotify(eventType: string, payload?: Record<string, unknown>): boolean {
  return isNotificationCardEvent(eventType, payload);
}
