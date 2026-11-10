import { downloadToDir, type DownloadResult } from "@owl/plugin-sdk/shared";
import type { DiscordAttachment } from "./types.js";

export type { DownloadResult } from "@owl/plugin-sdk/shared";

export async function downloadAttachment(
  attachment: DiscordAttachment,
  uploadDir: string,
  maxBytes = 50 * 1024 * 1024,
): Promise<DownloadResult> {
  return downloadToDir({
    url: attachment.url,
    id: attachment.id,
    name: attachment.name,
    mime: attachment.contentType ?? "application/octet-stream",
    dir: uploadDir,
    maxBytes,
    provider: "Discord",
  });
}
