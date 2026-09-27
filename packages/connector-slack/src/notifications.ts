import type { WebClient } from "@slack/web-api";
import { formatIntegrationError } from "@owl/plugin-sdk";
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
import type { OwlEvent } from "@owl/plugin-sdk";
import { postSlackMessage } from "./posting.js";

interface NotifyTarget {
  readonly channelId: string;
}

/** A notification message Slack accepted (`ts` is its thread parent id). */
export interface PostedNotification {
  readonly channelId: string;
  readonly ts: string;
}

export interface SendNotificationOptions {
  /** Called for each channel post Slack accepted, e.g. to map thread replies to a Decision. */
  readonly onPosted?: (posted: PostedNotification) => void | Promise<void>;
  readonly retry?: RetryOptions;
  /** The Owner language (CoreClient.language()); decision.opened uses its payload's own. */
  readonly language?: OwlLanguage;
}

type Template = (payload: Record<string, unknown>, event: OwlEvent, language: OwlLanguage) => string;

const EVENT_TEMPLATES: Record<string, Template> = {
  "decision.opened": (p, e) => formatDecision(p, e),
  "decision.resolved": (p, e, l) => formatDecisionResolved(p, e, l),
  "decision.cancelled": (p, e, l) => formatDecisionCancelled(p, e, l),
  "work.completed": (p, e, l) => `${connectorText(l).workCompletedLine(workLabel(p, e))}${workSuffixUnlessLabelled(p, e, l)}`,
  "work.cancelled": (p, e, l) => `${connectorText(l).workCancelledLine(workLabel(p, e))}${workSuffixUnlessLabelled(p, e, l)}`,
  "work.paused": (p, e, l) => formatWorkPaused(p, e, l),
  "work.reopened": (p, e, l) => formatWorkReopened(p, e, l),
  "provider.paused": (p, _e, l) => formatProviderPaused(p, l),
  "provider.resumed": (p, _e, l) => connectorText(l).providerResumedLine(providerLabelOf(p)),
  "system.alert": (p, e, l) => formatSystemAlert(p, e, l),
};

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function providerLabelOf(p: Record<string, unknown>): string {
  return text(p.provider_label) ?? text(p.provider) ?? "Provider";
}

function formatProviderPaused(p: Record<string, unknown>, language: OwlLanguage): string {
  const t = connectorText(language);
  const resumeAt = text(p.resume_at);
  const timestamp = resumeAt === null ? Number.NaN : Date.parse(resumeAt);
  const time = Number.isFinite(timestamp)
    ? `<!date^${Math.floor(timestamp / 1000)}^{date_short_pretty} {time}|${formatResumeTime(timestamp, language)}>`
    : language === "ja" ? "時刻不明" : "unknown time";
  const label = providerLabelOf(p);
  if (p.repeat) return t.providerPausedAgainLine(label, time);
  if (p.resume_source === "reported") return t.providerPausedLine(label, time);
  return t.providerPausedUnknownLine(label, time);
}

/** Format the Slack date token fallback in the host's local timezone. */
function formatResumeTime(timestamp: number, language: OwlLanguage): string {
  return new Intl.DateTimeFormat(language === "ja" ? "ja-JP" : "en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

/** Work id from the payload, or from the canonical event frame (system.alert payloads omit it). */
function workId(p: Record<string, unknown>, e: OwlEvent): string | null {
  return text(p.work_id) ?? text(e.work_id);
}

function workSuffix(p: Record<string, unknown>, e: OwlEvent, language: OwlLanguage): string {
  const id = workId(p, e);
  return id ? connectorText(language).workSuffix(id.slice(-6)) : "";
}

/** Core's work.completed / work.cancelled payloads carry no title; fall back to the Work id. */
function workLabel(p: Record<string, unknown>, e: OwlEvent): string {
  const title = text(p.title);
  if (title) return title;
  const id = workId(p, e);
  return id ? `Work ${id.slice(-6)}` : "Work";
}

function workSuffixUnlessLabelled(p: Record<string, unknown>, e: OwlEvent, language: OwlLanguage): string {
  return text(p.title) ? workSuffix(p, e, language) : "";
}

function formatDecision(p: Record<string, unknown>, e: OwlEvent): string {
  const decisionId = text(p.decision_id);
  const language = decisionLanguage(p);
  const idLabel = decisionId ? (language === "en" ? ` (ID ${decisionShortId(decisionId)})` : `（ID ${decisionShortId(decisionId)}）`) : "";
  const hasButtons = Array.isArray(p.options) && p.options.length > 0;
  const lines = [
    `${decisionTitle(p)}${idLabel}${workSuffix(p, e, language)}`,
    formatDecisionText(p),
    answerGuideHint(decisionId, language, hasButtons),
  ];
  return lines.join("\n\n");
}

/**
 * decision.resolved: an open Decision (posted by the web UI, or by a
 * different connector, or by this one) was answered. The caller edits the
 * original notice in place when it knows which message announced this
 * Decision (see updateNotification below), and only falls back to posting
 * this line as a new message when it does not.
 */
function formatDecisionResolved(p: Record<string, unknown>, e: OwlEvent, language: OwlLanguage): string {
  const decisionId = text(p.decision_id);
  const idLabel = decisionId ? decisionShortId(decisionId) : "?";
  const answer = text(p.answer) ?? "";
  return `${connectorText(language).decisionResolvedLine(idLabel, answer)}${workSuffix(p, e, language)}`;
}

/** decision.cancelled: the Decision closed on its own (Work cancelled, or its Task superseded) without being answered. */
function formatDecisionCancelled(p: Record<string, unknown>, e: OwlEvent, language: OwlLanguage): string {
  const t = connectorText(language);
  const decisionId = text(p.decision_id);
  const idLabel = decisionId ? decisionShortId(decisionId) : "?";
  const reasonLabel = p.reason === "work_cancelled" ? t.decisionCancelledReasonWorkCancelled : t.decisionCancelledReasonTaskSuperseded;
  return `${t.decisionCancelledLine(idLabel, reasonLabel)}${workSuffix(p, e, language)}`;
}

/** work.paused: the Owner (or a policy) paused a running Work; its payload carries the reason given. */
function formatWorkPaused(p: Record<string, unknown>, e: OwlEvent, language: OwlLanguage): string {
  const t = connectorText(language);
  const lines = [`${t.workPausedLine(workLabel(p, e))}${workSuffixUnlessLabelled(p, e, language)}`];
  const reason = text(p.reason);
  if (reason) lines.push(t.reasonLine(reason));
  return lines.join("\n");
}

/** work.reopened: the Owner reopened a completed Work, optionally with a reason for the Manager. */
function formatWorkReopened(p: Record<string, unknown>, e: OwlEvent, language: OwlLanguage): string {
  const t = connectorText(language);
  const lines = [`${t.workReopenedLine(workLabel(p, e))}${workSuffixUnlessLabelled(p, e, language)}`];
  const reason = text(p.reason);
  if (reason) lines.push(t.reasonLine(reason));
  return lines.join("\n");
}

/** Work-scoped alerts (tick failure, incomplete final verdict) are failures the owner must act on. */
function formatSystemAlert(p: Record<string, unknown>, e: OwlEvent, language: OwlLanguage): string {
  const t = connectorText(language);
  const message = String(p.message);
  const remediation = text(p.remediation);
  const lines = workId(p, e)
    ? [`${t.workProblemLine(message)}${workSuffix(p, e, language)}`]
    : [t.systemAlertLine(message)];
  if (remediation) lines.push(t.remediation(remediation));
  return lines.join("\n");
}

export async function sendNotification(
  client: WebClient,
  event: OwlEvent,
  targets: NotifyTarget[],
  options: SendNotificationOptions = {},
): Promise<void> {
  const template = EVENT_TEMPLATES[event.type];
  if (!template) return;

  if (event.type === "system.alert" && typeof event.payload.message !== "string") return;
  const language = options.language ?? "ja";
  const body = template(event.payload, event, language);
  const decisionOptions = Array.isArray(event.payload.options)
    ? event.payload.options as Array<{ key: string; label: string }>
    : [];

  const failures: string[] = [];
  for (const target of targets) {
    const blocks: any[] = [
      {
        type: "section",
        // Slack rejects section text over 3,000 chars; keep margin for mrkdwn conversion.
        text: { type: "mrkdwn", text: truncate(body, 2_900) },
      },
    ];

    if (decisionOptions.length > 0) {
      blocks.push({
        type: "actions",
        elements: decisionOptions.flatMap((opt, index) => {
          const decisionId = typeof event.payload.decision_id === "string"
            ? event.payload.decision_id
            : event.event_id;
          const actionId = typeof opt.key === "string" && typeof opt.label === "string"
            ? createDecisionButtonId(decisionId, index)
            : null;
          return actionId
            ? [{
                type: "button",
                text: { type: "plain_text", text: opt.label },
                action_id: actionId,
                value: opt.key,
              }]
            : [];
        }),
      });
    }

    try {
      const message = {
        channel: target.channelId,
        text: body,
        blocks,
      } as Parameters<WebClient["chat"]["postMessage"]>[0];
      const post = event.type === "provider.paused"
        // Slack's date token contains a required space, which the Markdown
        // converter treats as an unknown tag and escapes. Preserve it verbatim.
        ? () => client.chat.postMessage(message)
        : () => postSlackMessage(client, message);
      const result = await retryTransient(post, {
        ...options.retry,
        onRetry: (error, attempt, delayMs) => console.warn(
          `[slack] Notification for event #${event.sequence} (${event.type}) to ${target.channelId} failed on attempt ${attempt}; retrying in ${delayMs}ms: ${formatIntegrationError("Slack", error, "en")}`,
        ),
      });
      const ts = (result as { ts?: unknown } | undefined)?.ts;
      if (typeof ts === "string") await options.onPosted?.({ channelId: target.channelId, ts });
    } catch (error) {
      const attempts = (error as { attempts?: number }).attempts ?? 1;
      const message = formatIntegrationError("Slack", error, language);
      console.error(
        `[slack] Notification for event #${event.sequence} (${event.type}, ${event.event_id}) to channel ${target.channelId} failed after ${attempts} attempt(s): ${message}`,
        (error as { cause?: unknown }).cause ?? error,
      );
      failures.push(message);
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join(" "));
  }
}

/**
 * Edit the message that announced a Decision to show how it was resolved or
 * cancelled, in place, instead of posting a new notification. The edited
 * message has no action buttons: the Decision is closed, so answering it is
 * no longer possible.
 */
export async function updateNotification(
  client: WebClient,
  posted: ConnectorDecisionMessageRef,
  event: OwlEvent,
  language: OwlLanguage = "ja",
  retry?: RetryOptions,
): Promise<void> {
  const template = EVENT_TEMPLATES[event.type];
  if (!template) return;
  const body = template(event.payload, event, language);
  await retryTransient(() => client.chat.update({
    channel: posted.channel_id,
    ts: posted.message_ref,
    text: body,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: truncate(body, 2_900) } }],
  } as Parameters<WebClient["chat"]["update"]>[0]), retry);
}

export function shouldNotify(eventType: string, payload?: Record<string, unknown>): boolean {
  if (!(eventType in EVENT_TEMPLATES)) return false;
  return eventType !== "system.alert" || (typeof payload?.message === "string" && payload.message.trim().length > 0);
}
