export type { SlackConfig, SlackMessage, SlackFile, Intent } from "./types.js";
export { SlackConnector, isSlackBlockActionsPayload, resolveSlackAdvisorChannel } from "./connector.js";
export { classifyIntent, type PendingDecision } from "@owl/plugin-sdk/shared";
export { sendNotification, shouldNotify } from "./notifications.js";
export { downloadFile, type DownloadResult } from "./files.js";
export { uploadDir } from "@owl/plugin-sdk/shared";
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

export function createSlackConnector(config: SlackConfig): SlackConnector {
  return new SlackConnector(config);
}
