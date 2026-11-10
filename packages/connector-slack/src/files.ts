import { downloadToDir, type DownloadResult } from "@owl/plugin-sdk/shared";
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
  return downloadToDir({
    url: file.url_private_download,
    headers: { Authorization: `Bearer ${token}` },
    id: file.id,
    name: file.name,
    mime: file.mimetype,
    dir: uploadDir,
    maxBytes,
    provider: "Slack",
  });
}
