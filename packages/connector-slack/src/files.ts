import { mkdir, open, unlink } from "node:fs/promises";
import { join, extname } from "node:path";
import {
  EXECUTABLE_EXTENSIONS,
  KNOWN_EXTENSIONS,
  uniqueName,
  type DownloadResult,
} from "@owl/plugin-sdk/shared";
import type { SlackFile } from "./types.js";

export type { DownloadResult } from "@owl/plugin-sdk/shared";

export async function downloadFile(
  token: string,
  file: SlackFile,
  uploadDir: string,
  maxBytes = 50 * 1024 * 1024,
): Promise<DownloadResult> {
  if (!file.url_private_download) {
    throw new Error(`File ${file.name} has no download URL`);
  }

  await mkdir(uploadDir, { recursive: true });
  const safeName = await uniqueName(uploadDir, `${file.id}${extname(file.name).toLowerCase()}`);
  const destPath = join(uploadDir, safeName);
  const ext = extname(file.name).toLowerCase();
  const executable = EXECUTABLE_EXTENSIONS.has(ext);
  const knownFormat = KNOWN_EXTENSIONS.has(ext);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  timeout.unref?.();
  const response = await fetch(file.url_private_download, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  clearTimeout(timeout);
  if (!response.ok) {
    throw new Error(`Failed to download ${file.name}: ${response.status}`);
  }

  const fileHandle = await open(destPath, "wx", 0o600);
  let size = 0;
  try {
    if (!response.body) throw new Error("Slack download response has no body");
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error(`File ${file.name} exceeds the ${maxBytes}-byte limit`);
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
    mime: file.mimetype,
    executable,
    knownFormat,
  };
}

export function uploadDir(dataDir: string, workId: string | null, conversationId?: string): string {
  if (workId) return join(dataDir, "uploads", workId);
  return join(dataDir, "uploads", "general", conversationId ?? "unknown");
}
