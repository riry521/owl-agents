import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { Client as DiscordClient } from "discord.js";
import {
  answerGuideHint,
  connectorText,
  createDecisionButtonId,
  decisionLanguage,
  decisionShortId,
  decisionTitle,
  formatDecisionText,
  retryTransient,
  type ConnectorDecisionMessageRef,
  type OwlLanguage,
  type RetryOptions,
} from "@owl/plugin-sdk/shared";
import { formatIntegrationError } from "@owl/plugin-sdk";
import type { OwlEvent } from "@owl/plugin-sdk";

const COLORS: Record<string, number> = {
  "decision.opened": 0xf5a623,
  "decision.resolved": 0x4caf50,
  "decision.cancelled": 0x9e9e9e,
  "work.completed": 0x4caf50,
  "work.cancelled": 0x9e9e9e,
  "work.paused": 0xffb300,
  "work.reopened": 0x2196f3,
  "system.alert": 0xf44336,
};

/** Titles for each notified event; decision.opened takes its own from the payload's language. */
function eventTitle(type: string, language: OwlLanguage): string | null {
  const t = connectorText(language);
  switch (type) {
    case "decision.opened": return null;
    case "decision.resolved": return t.decisionResolvedTitle;
    case "decision.cancelled": return t.decisionCancelledTitle;
    case "work.completed": return t.workCompletedTitle;
    case "work.cancelled": return t.workCancelledTitle;
    case "work.paused": return t.workPausedTitle;
    case "work.reopened": return t.workReopenedTitle;
    case "system.alert": return t.systemAlertTitle;
    default: return null;
  }
}

const NOTIFIED_EVENTS = new Set(["decision.opened", "decision.resolved", "decision.cancelled", "work.completed", "work.cancelled", "work.paused", "work.reopened", "system.alert"]);

/** A notification message Discord accepted; replies reference `messageId`. */
export interface PostedNotification {
  readonly channelId: string;
  readonly messageId: string;
}

export interface SendNotificationOptions {
  /** Called for each channel post Discord accepted, e.g. to map replies to a Decision. */
  readonly onPosted?: (posted: PostedNotification) => void | Promise<void>;
  readonly retry?: RetryOptions;
  /** The Owner language (CoreClient.language()); decision.opened uses its payload's own. */
  readonly language?: OwlLanguage;
}

class PermanentDeliveryError extends Error {}

export async function sendNotification(
  client: DiscordClient,
  event: OwlEvent,
  channelIds?: string | readonly string[],
  sendOptions: SendNotificationOptions = {},
): Promise<void> {
  if (!NOTIFIED_EVENTS.has(event.type)) return;
  const language = sendOptions.language ?? "ja";
  const t = connectorText(language);
  const targets = parseChannelIds(channelIds);
  if (targets.length === 0) return;

  const payload = event.payload;
  if (event.type === "system.alert" && typeof payload.message !== "string") return;
  const workId = text(payload.work_id) ?? text(event.work_id);
  const embed = new EmbedBuilder()
    .setColor(COLORS[event.type] ?? 0x607d8b)
    .setTitle(event.type === "system.alert" && workId ? t.workProblemTitle : event.type === "decision.opened" ? decisionTitle(payload) : eventTitle(event.type, language) ?? event.type)
    .setTimestamp(new Date());

  const decisionId = event.type === "decision.opened" || event.type === "decision.resolved" || event.type === "decision.cancelled"
    ? text(payload.decision_id)
    : null;
  const footer = [
    workId ? `Work ${workId.slice(-6)}` : null,
    decisionId ? `ID ${decisionShortId(decisionId)}` : null,
  ].filter((part): part is string => part !== null);
  if (footer.length > 0) {
    embed.setFooter({ text: footer.join(" · ") });
  }

  // Core's work.completed / work.cancelled payloads carry no title.
  const workLabel = text(payload.title) ?? (workId ? `Work ${workId.slice(-6)}` : "Work");
  switch (event.type) {
    case "decision.opened":
      embed.setDescription(truncate(formatDecision(payload, decisionId), 4_096));
      break;
    case "decision.resolved": {
      const answer = text(payload.answer) ?? "";
      embed.setDescription(truncate(answer, 4_096));
      break;
    }
    case "decision.cancelled": {
      const reasonLabel = payload.reason === "work_cancelled" ? t.decisionCancelledReasonWorkCancelled : t.decisionCancelledReasonTaskSuperseded;
      embed.setDescription(reasonLabel);
      break;
    }
    case "work.completed":
      embed.setDescription(t.workCompletedDescription(workLabel));
      break;
    case "work.cancelled":
      embed.setDescription(t.workCancelledDescription(workLabel));
      break;
    case "work.paused": {
      const reason = text(payload.reason);
      embed.setDescription(reason ? `${t.workPausedDescription(workLabel)}\n${t.reasonLine(reason)}` : t.workPausedDescription(workLabel));
      break;
    }
    case "work.reopened": {
      const reason = text(payload.reason);
      embed.setDescription(reason ? `${t.workReopenedDescription(workLabel)}\n${t.reasonLine(reason)}` : t.workReopenedDescription(workLabel));
      break;
    }
    case "system.alert": {
      const remediation = text(payload.remediation);
      embed.setDescription(remediation ? `${payload.message as string}\n${t.remediation(remediation)}` : payload.message as string);
      break;
    }
  }

  const options = Array.isArray(payload.options) ? payload.options as Array<{ key: string; label: string }> : [];
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (options.length > 0) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const [index, opt] of options.slice(0, 5).entries()) {
      if (typeof opt !== "object" || opt === null) continue;
      const decisionId = typeof payload.decision_id === "string" ? payload.decision_id : event.event_id;
      const customId = typeof opt.key === "string" && typeof opt.label === "string"
        ? createDecisionButtonId(decisionId, index)
        : null;
      if (!customId) continue;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(customId)
          .setLabel(opt.label)
          .setStyle(ButtonStyle.Primary),
      );
    }
    if (row.components.length > 0) components.push(row);
  }

  const failures: string[] = [];
  for (const channelId of targets) {
    try {
      const sent = await retryTransient(async () => {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased() || !("send" in channel)) {
          throw new PermanentDeliveryError(`The notification channel ${channelId} is not available.`);
        }
        return channel.send({ embeds: [embed], components });
      }, {
        ...sendOptions.retry,
        onRetry: (error, attempt, delayMs) => console.warn(
          `[discord] Notification for event #${event.sequence} (${event.type}) to ${channelId} failed on attempt ${attempt}; retrying in ${delayMs}ms: ${formatIntegrationError("Discord", error, "en")}`,
        ),
      });
      const messageId = (sent as { id?: unknown } | undefined)?.id;
      if (typeof messageId === "string") await sendOptions.onPosted?.({ channelId, messageId });
    } catch (err) {
      const attempts = (err as { attempts?: number }).attempts ?? 1;
      const message = formatIntegrationError("Discord", err, language);
      console.error(
        `[discord] Notification for event #${event.sequence} (${event.type}, ${event.event_id}) to channel ${channelId} failed after ${attempts} attempt(s): ${message}`,
        (err as { cause?: unknown }).cause ?? err,
      );
      failures.push(message);
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join(" "));
  }
}

/** Discord rejects embed descriptions over 4,096 characters. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function formatDecision(payload: Record<string, unknown>, decisionId: string | null): string {
  const hasButtons = Array.isArray(payload.options) && payload.options.length > 0;
  return [
    formatDecisionText(payload),
    answerGuideHint(decisionId, decisionLanguage(payload), hasButtons),
  ].join("\n\n");
}

function parseChannelIds(value: string | readonly string[] | undefined): string[] {
  const values: readonly string[] = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.flatMap((item) => item.split(/[\s,]+/u).map((part) => part.trim()).filter((part) => part.length > 0)))];
}

/**
 * Edit the message that announced a Decision to show how it was resolved or
 * cancelled, in place, instead of posting a new notification. The edited
 * message has no buttons: the Decision is closed, so answering it is no
 * longer possible.
 */
export async function updateNotification(
  client: DiscordClient,
  posted: ConnectorDecisionMessageRef,
  event: OwlEvent,
  language: OwlLanguage = "ja",
): Promise<void> {
  if (event.type !== "decision.resolved" && event.type !== "decision.cancelled") return;
  const t = connectorText(language);
  const payload = event.payload;
  const decisionId = text(payload.decision_id);
  const workId = text(payload.work_id) ?? text(event.work_id);
  const embed = new EmbedBuilder()
    .setColor(COLORS[event.type] ?? 0x607d8b)
    .setTitle(eventTitle(event.type, language) ?? event.type)
    .setTimestamp(new Date());
  const footer = [
    workId ? `Work ${workId.slice(-6)}` : null,
    decisionId ? `ID ${decisionShortId(decisionId)}` : null,
  ].filter((part): part is string => part !== null);
  if (footer.length > 0) embed.setFooter({ text: footer.join(" · ") });
  if (event.type === "decision.resolved") {
    embed.setDescription(truncate(text(payload.answer) ?? "", 4_096));
  } else {
    const reasonLabel = payload.reason === "work_cancelled" ? t.decisionCancelledReasonWorkCancelled : t.decisionCancelledReasonTaskSuperseded;
    embed.setDescription(reasonLabel);
  }
  await retryTransient(async () => {
    const channel = await client.channels.fetch(posted.channel_id);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) {
      throw new PermanentDeliveryError(`The notification channel ${posted.channel_id} is not available.`);
    }
    const message = await (channel as unknown as { messages: { fetch(id: string): Promise<{ edit(options: unknown): Promise<unknown> }> } }).messages.fetch(posted.message_ref);
    await message.edit({ embeds: [embed], components: [] });
  });
}

export function shouldNotify(eventType: string, payload?: Record<string, unknown>): boolean {
  if (!NOTIFIED_EVENTS.has(eventType)) return false;
  return eventType !== "system.alert" || (typeof payload?.message === "string" && payload.message.trim().length > 0);
}
