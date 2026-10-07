// Standalone deployment adapter for the full Discord connector. The adapter
// keeps the historical CLI config names while reusing notification delivery,
// Advisor replies, and interactive Decision handling from the package used by
// the server-managed connector.

import {
  DiscordConnector as FullDiscordConnector,
  type DiscordConfig,
} from "@owl/connector-discord";

export interface DiscordConnectorConfig {
  readonly owlApiBase: string;
  readonly discordBotToken: string;
  /** Retained for CLI/config compatibility; discord.js authenticates with the bot token. */
  readonly discordApplicationId?: string;
  readonly conversationChannelId: string;
  readonly notificationChannelId: string;
  readonly accountId: string;
  readonly apiToken?: string;
  readonly coreWsUrl?: string;
  /** Where this connector persists its event cursor and Decision notice map. */
  readonly stateFile?: string;
}

class DiscordConnector {
  private readonly delegate: FullDiscordConnector;

  constructor(config: DiscordConnectorConfig) {
    const fullConfig: DiscordConfig = {
      botToken: config.discordBotToken,
      conversationChannelId: config.conversationChannelId,
      notificationChannelId: config.notificationChannelId,
      coreApiBase: config.owlApiBase,
      apiToken: config.apiToken,
      accountId: config.accountId,
      coreWsUrl: config.coreWsUrl,
      stateFile: config.stateFile,
    };
    this.delegate = new FullDiscordConnector(fullConfig);
  }

  start(): Promise<void> {
    return this.delegate.start();
  }

  stop(): Promise<void> {
    return this.delegate.stop();
  }
}

export { DiscordConnector };
