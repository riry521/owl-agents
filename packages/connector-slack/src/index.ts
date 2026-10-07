export type { SlackConfig, SlackMessage, SlackFile, Intent } from "./types.js";
export { SlackConnector, isSlackBlockActionsPayload, resolveSlackAdvisorChannel } from "./connector.js";
export { classifyIntent, type PendingDecision } from "@owl/plugin-sdk/shared";
export { sendNotification, shouldNotify } from "./notifications.js";
export { downloadFile, uploadDir, type DownloadResult } from "./files.js";
export { formatStatusResponse } from "@owl/plugin-sdk/shared";
export {
  extractOwlActionsBlock,
  extractOwlActionsBlocks,
  markdownToMrkdwn,
  markdownToSlackMrkdwn,
  type MarkdownToSlackResult,
  type OwlActionsExtraction,
} from "./markdown.js";

import { SlackConnector } from "./connector.js";
import type { SlackConfig } from "./types.js";
import { loadOwlEnv } from "../../shared/dist/env.js";

loadOwlEnv();

export function createSlackConnector(config: SlackConfig): SlackConnector {
  return new SlackConnector(config);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const config: SlackConfig = {
    botToken: process.env.SLACK_BOT_TOKEN ?? "",
    appToken: process.env.SLACK_APP_TOKEN ?? "",
    conversationChannelId: process.env.SLACK_CONVERSATION_CHANNEL_ID ?? process.env.SLACK_CHANNEL_ID ?? "",
    notificationChannelId: process.env.SLACK_NOTIFICATION_CHANNEL_ID
      ?? process.env.SLACK_CHANNEL_ID
      ?? process.env.SLACK_CONVERSATION_CHANNEL_ID
      ?? "",
    // A standalone Slack process is provider-scoped, so the legacy shared
    // variable remains safe as a single-provider fallback.
    accountId: process.env.OWL_SLACK_CONNECTOR_ACCOUNT_ID?.trim()
      || process.env.OWL_CONNECTOR_ACCOUNT_ID?.trim()
      || "",
    apiToken: process.env.OWL_API_TOKEN,
    coreApiBase: process.env.OWL_API_BASE ?? "http://127.0.0.1:3787/api/v1",
    coreWsUrl: process.env.OWL_WS_URL,
  };
  if (!config.botToken || !config.appToken) {
    console.error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required");
    process.exit(1);
  }
  if (!config.conversationChannelId || !config.notificationChannelId) {
    console.error("SLACK_CONVERSATION_CHANNEL_ID and SLACK_NOTIFICATION_CHANNEL_ID are required");
    process.exit(1);
  }
  if (!config.accountId) {
    console.error("OWL_SLACK_CONNECTOR_ACCOUNT_ID (or legacy OWL_CONNECTOR_ACCOUNT_ID) is required");
    process.exit(1);
  }
  const connector = new SlackConnector(config);
  connector.start().catch((err) => {
    console.error("Failed to start Slack connector:", err);
    process.exit(1);
  });
  const shutdown = () => void connector.stop().then(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
