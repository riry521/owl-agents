import { mkdir, open, unlink } from "node:fs/promises";
import { join, extname } from "node:path";
import {
  EXECUTABLE_EXTENSIONS,
  KNOWN_EXTENSIONS,
  uniqueName,
  type DownloadResult,
} from "@owl/plugin-sdk/shared";
import type { DiscordAttachment } from "./types.js";

export type { DownloadResult } from "@owl/plugin-sdk/shared";

export async function downloadAttachment(
  attachment: DiscordAttachment,
  uploadDir: string,
  maxBytes = 50 * 1024 * 1024,
): Promise<DownloadResult> {
  await mkdir(uploadDir, { recursive: true });
  const safeName = await uniqueName(uploadDir, `${attachment.id}${extname(attachment.name).toLowerCase()}`);
  const destPath = join(uploadDir, safeName);
  const ext = extname(attachment.name).toLowerCase();
  const executable = EXECUTABLE_EXTENSIONS.has(ext);
  const knownFormat = KNOWN_EXTENSIONS.has(ext);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  timeout.unref?.();
  const response = await fetch(attachment.url, { signal: controller.signal });
  clearTimeout(timeout);
  if (!response.ok) {
    throw new Error(`Failed to download ${attachment.name}: ${response.status}`);
  }

  const fileHandle = await open(destPath, "wx", 0o600);
  let size = 0;
  try {
    if (!response.body) throw new Error("Discord download response has no body");
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error(`File ${attachment.name} exceeds the ${maxBytes}-byte limit`);
      await fileHandle.write(Buffer.from(next.value));
    }
  } catch (error) {
    await fileHandle.close();
    await unlink(destPath).catch(() => undefined);
    throw error;
  }
  await fileHandle.close();

  return {
    path: destPath,
    name: safeName,
    size,
    mime: attachment.contentType ?? "application/octet-stream",
    executable,
    knownFormat,
  };
}

export function getUploadDir(dataDir: string, workId: string | null, conversationId?: string): string {
  if (workId) return join(dataDir, "uploads", workId);
  return join(dataDir, "uploads", "general", conversationId ?? "unknown");
}
