export type { DiscordConfig, DiscordMessage, DiscordAttachment, Intent } from "./types.js";
export { DiscordConnector, resolveDiscordAdvisorChannel } from "./connector.js";
export { classifyIntent, type PendingDecision } from "@owl/plugin-sdk/shared";
export { sendNotification, shouldNotify } from "./notifications.js";
export { downloadAttachment, type DownloadResult } from "./files.js";
export { uploadDir as getUploadDir } from "@owl/plugin-sdk/shared";
export { formatStatusResponse } from "@owl/plugin-sdk/shared";

import { DiscordConnector } from "./connector.js";
import type { DiscordConfig } from "./types.js";

export function createDiscordConnector(config: DiscordConfig): DiscordConnector {
  return new DiscordConnector(config);
}
