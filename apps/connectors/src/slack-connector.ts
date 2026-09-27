// Standalone deployment adapter for the full Slack connector. Keeping this
// thin wrapper preserves the historical CLI config names while ensuring the
// separate-process path receives notifications and handles decision buttons in
// exactly the same way as the server-managed connector.

import {
  SlackConnector as FullSlackConnector,
  type SlackConfig,
} from "@owl/connector-slack";

export interface SlackConnectorConfig {
  readonly owlApiBase: string;
  readonly slackBotToken: string;
  readonly slackAppToken: string;
  /** Retained for config-file compatibility; Socket Mode does not use it. */
  readonly slackSigningSecret?: string;
  readonly conversationChannelId: string;
  readonly notificationChannelId: string;
  readonly accountId: string;
  readonly apiToken?: string;
  readonly coreWsUrl?: string;
  /** Where this connector persists its event cursor and Decision notice map. */
  readonly stateFile?: string;
}

class SlackConnector {
  private readonly delegate: FullSlackConnector;

  constructor(config: SlackConnectorConfig) {
    const fullConfig: SlackConfig = {
      botToken: config.slackBotToken,
      appToken: config.slackAppToken,
      conversationChannelId: config.conversationChannelId,
      notificationChannelId: config.notificationChannelId,
      coreApiBase: config.owlApiBase,
      apiToken: config.apiToken,
      accountId: config.accountId,
      coreWsUrl: config.coreWsUrl,
      stateFile: config.stateFile,
    };
    this.delegate = new FullSlackConnector(fullConfig);
  }

  start(): Promise<void> {
    return this.delegate.start();
  }

  stop(): Promise<void> {
    return this.delegate.stop();
  }
}

export { SlackConnector };
