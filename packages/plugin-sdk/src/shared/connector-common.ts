import { mkdir, open, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { formatIntegrationError } from "../error-display";
import type { CoreClient } from "../client";
import type { OwlEvent } from "../types";
import { connectorText } from "./connector-text";
import type { OwlLanguage } from "./language";
import { decisionShortId, type PendingDecision } from "./router";
import { EXECUTABLE_EXTENSIONS, KNOWN_EXTENSIONS, uniqueName, type DownloadResult } from "./files";
import type { ConnectorDecisionMessageRef } from "./state-store";

export const PENDING_DECISION_PAGE_LIMIT = 50;
export const MAX_PENDING_DECISION_PAGES = 10_000;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseChannelIds(value: string | readonly string[] | undefined): string[] {
  const values: readonly string[] = Array.isArray(value) ? value : value ? [value as string] : [];
  return [...new Set(values.flatMap((item) => item.split(/[\s,]+/u).map((part) => part.trim()).filter((part) => part.length > 0)))];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function uploadDir(dataDir: string, workId: string | null, conversationId?: string): string {
  if (workId) return join(dataDir, "uploads", workId);
  return join(dataDir, "uploads", "general", conversationId ?? "unknown");
}

export async function fetchAdvisorReply(core: CoreClient, event: OwlEvent): Promise<string> {
  for (const candidate of [event.payload.reply, event.payload.text]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }

  const conversationId = event.payload.conversation_id;
  const messageId = event.payload.message_id;
  if (typeof conversationId !== "string" || typeof messageId !== "string") {
    throw new Error("The Advisor reply event has no conversation id or message id.");
  }

  const response = await core.request<unknown>(`/conversations/${encodeURIComponent(conversationId)}/messages?limit=200`);
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

export async function fetchPendingDecisions(core: CoreClient): Promise<PendingDecision[]> {
  const decisions: PendingDecision[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let pageCount = 0; pageCount < MAX_PENDING_DECISION_PAGES; pageCount += 1) {
    const query = new URLSearchParams({ status: "open", limit: String(PENDING_DECISION_PAGE_LIMIT) });
    if (cursor !== null) query.set("cursor", cursor);
    const page = await core.requestPage<PendingDecision[]>(`/decisions?${query.toString()}`);
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

export interface NotificationDelivery {
  /** Edit the notification posted earlier for a Decision that has just closed. */
  update(posted: ConnectorDecisionMessageRef, language: OwlLanguage): Promise<void>;
  /** Post a new notification; call `remember` with the posted message so the Decision can be updated later. */
  send(language: OwlLanguage, remember: (channelId: string, messageRef: string) => Promise<void>): Promise<void>;
  /** Called when update or send fails. */
  fail(error: unknown): Promise<void>;
}

/** Shared Decision notice flow: update the stored message when a Decision closes, otherwise post and remember it. */
export async function deliverNotification(core: CoreClient, event: OwlEvent, delivery: NotificationDelivery): Promise<void> {
  const decisionId = event.type === "decision.opened" || event.type === "decision.resolved" || event.type === "decision.cancelled"
    ? (typeof event.payload.decision_id === "string" ? event.payload.decision_id : null)
    : null;

  if (event.type === "decision.resolved" || event.type === "decision.cancelled") {
    const posted = decisionId ? core.decisionMessage(decisionId) : null;
    if (posted) {
      try {
        await delivery.update(posted, await core.language());
      } catch (error) {
        await delivery.fail(error);
      }
      if (decisionId) await core.forgetDecisionMessage(decisionId);
      return;
    }
  }

  try {
    await delivery.send(await core.language(), async (channelId, messageRef) => {
      if (decisionId) {
        await core.rememberDecisionMessage(decisionId, {
          channel_id: channelId,
          message_ref: messageRef,
          posted_at: new Date().toISOString(),
        });
      }
    });
  } catch (error) {
    await delivery.fail(error);
  }
}

/** Surface a notification that failed after retries, with the event sequence. */
export async function reportNotificationFailure(
  core: CoreClient,
  event: OwlEvent,
  error: unknown,
  provider: { readonly tag: string; readonly label: string },
  channelIds: readonly string[],
  post: (channelId: string, text: string) => Promise<void>,
): Promise<void> {
  const decisionId = typeof event.payload.decision_id === "string" ? event.payload.decision_id : null;
  const language = await core.language();
  const t = connectorText(language);
  const subject = t.notificationSubject(event.sequence, event.type, decisionId ? decisionShortId(decisionId) : null);
  const message = formatIntegrationError(provider.label, error, language);
  console.error(`[${provider.tag}] Notification delivery failed (event #${event.sequence} ${event.type}, event_id ${event.event_id}): ${formatIntegrationError(provider.label, error, "en")}`);
  for (const channelId of channelIds) {
    try {
      await post(channelId, t.notificationFailed(subject, message));
    } catch (postError) {
      console.error(`[${provider.tag}] Could not post notification failure to ${channelId}:`, postError);
    }
  }
}

/** Download `url` into `dir` under a collision-free name, aborting on a stall or when the body exceeds `maxBytes`. */
export async function downloadToDir(options: {
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly dir: string;
  readonly maxBytes: number;
  readonly provider: string;
}): Promise<DownloadResult> {
  const { url, headers, id, name, mime, dir, maxBytes, provider } = options;
  await mkdir(dir, { recursive: true });
  const safeName = await uniqueName(dir, `${id}${extname(name).toLowerCase()}`);
  const destPath = join(dir, safeName);
  const ext = extname(name).toLowerCase();
  const executable = EXECUTABLE_EXTENSIONS.has(ext);
  const knownFormat = KNOWN_EXTENSIONS.has(ext);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  timeout.unref?.();
  const response = await fetch(url, { headers, signal: controller.signal });
  if (!response.ok) {
    clearTimeout(timeout);
    throw new Error(`Failed to download ${name}: ${response.status}`);
  }

  const fileHandle = await open(destPath, "wx", 0o600);
  let size = 0;
  try {
    if (!response.body) throw new Error(`${provider} download response has no body`);
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error(`File ${name} exceeds the ${maxBytes}-byte limit`);
      await fileHandle.write(Buffer.from(next.value));
    }
  } catch (error) {
    await fileHandle.close();
    await unlink(destPath).catch(() => undefined);
    throw error;
  } finally {
    // Cleared only after the body: the abort signal is the sole guard against a stalled stream.
    clearTimeout(timeout);
  }
  await fileHandle.close();

  return { path: destPath, name: safeName, size, mime, executable, knownFormat };
}
