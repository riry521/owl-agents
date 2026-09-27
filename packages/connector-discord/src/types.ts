import type { RoutedIntent } from "@owl/plugin-sdk/shared";

export interface DiscordConfig {
  readonly botToken: string;
  readonly conversationChannelId: string;
  readonly notificationChannelId: string;
  readonly coreApiBase: string;
  readonly apiToken?: string;
  readonly accountId: string;
  readonly coreWsUrl?: string;
  readonly statusKeywords?: readonly string[];
  readonly maxFileSize?: number;
  readonly messageCharLimit?: number;
  /** Where this connector persists its event cursor and Decision notice map. Omitted, that state is kept in memory only. */
  readonly stateFile?: string;
}

export interface DiscordMessage {
  readonly userId: string;
  readonly text: string;
  readonly channelId: string;
  readonly messageId: string;
  /** Decision whose notification this message replies to (Discord reply reference). */
  readonly replyToDecisionId?: string | null;
  readonly attachments: readonly DiscordAttachment[];
}

export interface DiscordAttachment {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly contentType: string | null;
  readonly url: string;
}

export type Intent = RoutedIntent<DiscordAttachment>;
