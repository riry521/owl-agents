import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { commandEnvelope, type CoreClient } from "../client";
import type { OwlEvent } from "../types";

export interface OutboundFile {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly comment?: string;
  /** Position in the turn's action list; connectors report delivery results by it. */
  readonly index?: number;
}

/** Keeps only well-formed entries; ignores anything else in the event. */
export function parseOutboundFiles(value: unknown): OutboundFile[] {
  if (!Array.isArray(value)) return [];
  const files: OutboundFile[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const read = (key: string): unknown => (Object.hasOwn(candidate, key) ? (candidate as Record<string, unknown>)[key] : undefined);
    const path = read("path");
    const name = read("name");
    const size = read("size");
    const sha256 = read("sha256");
    const comment = read("comment");
    const index = read("index");
    if (typeof path !== "string" || path.length === 0) continue;
    if (typeof name !== "string" || name.length === 0) continue;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) continue;
    if (typeof sha256 !== "string" || sha256.length === 0) continue;
    if (comment !== undefined && typeof comment !== "string") continue;
    const hasIndex = typeof index === "number" && Number.isSafeInteger(index) && index >= 0;
    files.push({ path, name, size, sha256, ...(comment ? { comment } : {}), ...(hasIndex ? { index } : {}) });
  }
  return files;
}

export interface DeliveryTarget {
  readonly provider: "slack" | "discord";
  readonly channel_id: string;
  readonly display_name: string | null;
}

/** Reads the destination Core chose for a Web-origin reply; null when absent or malformed. */
export function parseDeliveryTarget(event: OwlEvent): DeliveryTarget | null {
  const raw = event.payload.delivery_target;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const read = (key: string): unknown => (Object.hasOwn(raw, key) ? (raw as Record<string, unknown>)[key] : undefined);
  const provider = read("provider");
  const channelId = read("channel_id");
  const displayName = read("display_name");
  if (provider !== "slack" && provider !== "discord") return null;
  if (typeof channelId !== "string" || channelId.length < 1 || channelId.length > 200) return null;
  return { provider, channel_id: channelId, display_name: typeof displayName === "string" ? displayName : null };
}

/** Re-reads the file Core checked and verifies size and sha256. */
export async function readOutboundFile(
  file: OutboundFile,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: "changed" | "unreadable" }> {
  let handle;
  try {
    handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = typeof error === "object" && error !== null && Object.hasOwn(error, "code") ? (error as { code: unknown }).code : undefined;
    return { ok: false, reason: code === "ELOOP" ? "changed" : "unreadable" };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== file.size) return { ok: false, reason: "changed" };
    const bytes = await handle.readFile();
    if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      return { ok: false, reason: "changed" };
    }
    return { ok: true, bytes };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface OutboundFileResult {
  readonly index: number;
  readonly outcome: "sent" | "failed" | "unknown";
  readonly code?: "changed" | "unreadable" | "upload_rejected" | "upload_rate_limited" | "upload_unknown";
  readonly platform_error?: string | null;
  readonly message?: string;
}

/**
 * Reports a `delivery_pending` reply's upload results to Core and returns the notice to append to the reply.
 * Returns null when the event predates reporting or Core could not be reached; the reply is posted either way.
 */
export async function reportAdvisorDelivery(
  core: CoreClient,
  event: OwlEvent,
  results: readonly OutboundFileResult[],
): Promise<string | null> {
  const { conversation_id: conversationId, turn_id: turnId, message_id: messageId } = event.payload;
  if (event.payload.delivery_pending !== true || typeof conversationId !== "string" || typeof turnId !== "string" || typeof messageId !== "string") return null;
  if (!parseOutboundFiles(event.payload.outbound_files).every((file) => file.index !== undefined)) return null;
  try {
    const reported = await core.request<{ notice?: string | null }>(`/conversations/${encodeURIComponent(conversationId)}/advisor-deliveries`, {
      method: "POST",
      // Core rejects a message over 300 characters, which would drop the whole report; formatted errors can be longer.
      body: commandEnvelope({ turn_id: turnId, message_id: messageId, results: results.map((r) => (r.message === undefined ? r : { ...r, message: r.message.slice(0, 300) })) }, "advisor-delivery"),
    });
    return typeof reported?.notice === "string" && reported.notice !== "" ? reported.notice : null;
  } catch (error) {
    console.error(`[connector] Could not report the file delivery of turn ${turnId} to Core:`, error);
    return null;
  }
}

/** Appends connector result lines after Core's notices. */
export function appendFileResults(reply: string, actionResults: unknown, lines: readonly string[]): string {
  if (lines.length === 0) return reply;
  const endsWithNotices = typeof actionResults === "string" && actionResults.length > 0 && reply.endsWith(actionResults);
  return `${reply}${endsWithNotices ? "\n" : "\n\n"}${lines.join("\n")}`;
}
