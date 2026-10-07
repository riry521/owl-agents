export type { DiscordConfig, DiscordMessage, DiscordAttachment, Intent } from "./types.js";
export { DiscordConnector, resolveDiscordAdvisorChannel } from "./connector.js";
export { classifyIntent, type PendingDecision } from "@owl/plugin-sdk/shared";
export { sendNotification, shouldNotify } from "./notifications.js";
export { downloadAttachment, getUploadDir, type DownloadResult } from "./files.js";
export { formatStatusResponse } from "@owl/plugin-sdk/shared";

import { DiscordConnector } from "./connector.js";
import type { DiscordConfig } from "./types.js";
import { loadOwlEnv } from "../../shared/dist/env.js";

loadOwlEnv();

export function createDiscordConnector(config: DiscordConfig): DiscordConnector {
  return new DiscordConnector(config);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const config: DiscordConfig = {
    botToken: process.env.DISCORD_BOT_TOKEN ?? "",
    conversationChannelId: process.env.DISCORD_CONVERSATION_CHANNEL_ID ?? process.env.DISCORD_CHANNEL_ID ?? "",
    notificationChannelId: process.env.DISCORD_NOTIFICATION_CHANNEL_ID
      ?? process.env.DISCORD_CHANNEL_ID
      ?? process.env.DISCORD_CONVERSATION_CHANNEL_ID
      ?? "",
    // A standalone Discord process is provider-scoped, so the legacy shared
    // variable remains safe as a single-provider fallback.
    accountId: process.env.OWL_DISCORD_CONNECTOR_ACCOUNT_ID?.trim()
      || process.env.OWL_CONNECTOR_ACCOUNT_ID?.trim()
      || "",
    apiToken: process.env.OWL_API_TOKEN,
    coreApiBase: process.env.OWL_API_BASE ?? "http://127.0.0.1:3787/api/v1",
    coreWsUrl: process.env.OWL_WS_URL,
  };
  if (!config.botToken) {
    console.error("DISCORD_BOT_TOKEN is required");
    process.exit(1);
  }
  if (!config.conversationChannelId || !config.notificationChannelId) {
    console.error("DISCORD_CONVERSATION_CHANNEL_ID and DISCORD_NOTIFICATION_CHANNEL_ID are required");
    process.exit(1);
  }
  if (!config.accountId) {
    console.error("OWL_DISCORD_CONNECTOR_ACCOUNT_ID (or legacy OWL_CONNECTOR_ACCOUNT_ID) is required");
    process.exit(1);
  }
  const connector = new DiscordConnector(config);
  connector.start().catch((err) => {
    console.error("Failed to start Discord connector:", err);
    process.exit(1);
  });
  const shutdown = () => void connector.stop().then(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
