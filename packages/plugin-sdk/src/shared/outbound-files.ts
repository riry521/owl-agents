import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export interface OutboundFile {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly comment?: string;
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
    if (typeof path !== "string" || path.length === 0) continue;
    if (typeof name !== "string" || name.length === 0) continue;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) continue;
    if (typeof sha256 !== "string" || sha256.length === 0) continue;
    if (comment !== undefined && typeof comment !== "string") continue;
    files.push({ path, name, size, sha256, ...(comment ? { comment } : {}) });
  }
  return files;
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

/** Appends connector result lines after Core's notices. */
export function appendFileResults(reply: string, actionResults: unknown, lines: readonly string[]): string {
  if (lines.length === 0) return reply;
  const endsWithNotices = typeof actionResults === "string" && actionResults.length > 0 && reply.endsWith(actionResults);
  return `${reply}${endsWithNotices ? "\n" : "\n\n"}${lines.join("\n")}`;
}
