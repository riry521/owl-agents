import type { RoutedIntent } from "@owl/plugin-sdk/shared";

export interface SlackConfig {
  readonly botToken: string;
  readonly appToken: string;
  readonly conversationChannelId: string;
  readonly notificationChannelId: string;
  readonly coreApiBase: string;
  readonly apiToken?: string;
  readonly accountId: string;
  readonly coreWsUrl?: string;
  readonly statusKeywords?: readonly string[];
  readonly maxFileSize?: number;
  readonly decisionRenotifyHours?: number;
  /** Where this connector persists its event cursor and Decision notice map. Omitted, that state is kept in memory only. */
  readonly stateFile?: string;
}

export interface SlackMessage {
  readonly user: string;
  readonly text: string;
  readonly channel: string;
  readonly ts: string;
  readonly thread_ts?: string;
  readonly files?: readonly SlackFile[];
}

export interface SlackFile {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly mimetype: string;
  readonly url_private_download?: string;
}

export type Intent = RoutedIntent<SlackFile>;
