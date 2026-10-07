#!/usr/bin/env node

// CLI entry point for the standalone Slack / Discord connectors. Each
// connector is a separate process; this CLI wires config from the environment
// and starts the requested full connector implementation.
//
// Usage: node dist/cli.js --slack | --discord | --all

import { join } from "node:path";
import { loadOwlEnv } from "../../../packages/shared/dist/env.js";
import { SlackConnector, type SlackConnectorConfig } from "./slack-connector.js";
import { DiscordConnector, type DiscordConnectorConfig } from "./discord-connector.js";

export const CONNECTOR_ACCOUNT_ENV = {
  slack: "OWL_SLACK_CONNECTOR_ACCOUNT_ID",
  discord: "OWL_DISCORD_CONNECTOR_ACCOUNT_ID",
} as const;

export interface ConnectorLifecycle {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createConnectorLifecycle(connectors: readonly ConnectorLifecycle[]): {
  start(): Promise<void>;
  stop(): Promise<void>;
} {
  let stopPromise: Promise<void> | null = null;

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = Promise.all(connectors.map(async (connector) => {
      try {
        await connector.stop();
      } catch (error) {
        // Cleanup is best-effort; preserve the startup or signal error.
        console.error(`[cli] Failed to stop connector ${connector.name}`, error);
      }
    })).then(() => undefined);
    return stopPromise;
  };

  const start = async (): Promise<void> => {
    try {
      await Promise.all(connectors.map((connector) => connector.start()));
    } catch (error) {
      await stop();
      throw error;
    }
  };

  return { start, stop };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Resolve an account id without allowing --all to claim one provider's
 * account as the other provider's account. The old shared variable remains
 * valid for a single-provider process.
 */
export function resolveConnectorAccountId(provider: "slack" | "discord", allProviders: boolean): string {
  const providerEnv = CONNECTOR_ACCOUNT_ENV[provider];
  const providerValue = process.env[providerEnv]?.trim();
  if (allProviders) {
    if (providerValue) return providerValue;
    if (process.env.OWL_CONNECTOR_ACCOUNT_ID?.trim()) {
      throw new Error(`--all requires ${CONNECTOR_ACCOUNT_ENV.slack} and ${CONNECTOR_ACCOUNT_ENV.discord}; OWL_CONNECTOR_ACCOUNT_ID cannot be shared across providers.`);
    }
    throw new Error(`Missing required environment variable for --all: ${providerEnv}`);
  }
  return providerValue ?? requireEnv("OWL_CONNECTOR_ACCOUNT_ID");
}

function owlApiBase(): string {
  return process.env.OWL_API_BASE ?? "http://127.0.0.1:3787/api/v1";
}

/** Where this process persists its event cursor and Decision notice map, one file per provider account. */
function stateFile(provider: "slack" | "discord", accountId: string): string {
  const stateDir = process.env.OWL_CONNECTOR_STATE_DIR?.trim() || "./data/connectors";
  return join(stateDir, `${provider}-${accountId}.json`);
}

function channelPair(prefix: "SLACK" | "DISCORD"): { conversationChannelId: string; notificationChannelId: string } {
  const value = (name: string): string | undefined => {
    const candidate = process.env[name]?.trim();
    return candidate || undefined;
  };
  const legacy = value(`${prefix}_CHANNEL_ID`);
  const conversationChannelId = value(`${prefix}_CONVERSATION_CHANNEL_ID`) ?? legacy ?? value(`${prefix}_NOTIFICATION_CHANNEL_ID`);
  const notificationChannelId = value(`${prefix}_NOTIFICATION_CHANNEL_ID`) ?? legacy ?? conversationChannelId;
  if (!conversationChannelId || !notificationChannelId) {
    throw new Error(`Missing required environment variable: ${prefix}_CONVERSATION_CHANNEL_ID or ${prefix}_NOTIFICATION_CHANNEL_ID`);
  }
  return { conversationChannelId, notificationChannelId };
}

export function buildSlackConfig(allProviders = false): SlackConnectorConfig {
  const accountId = resolveConnectorAccountId("slack", allProviders);
  return {
    accountId,
    owlApiBase: owlApiBase(),
    slackBotToken: requireEnv("SLACK_BOT_TOKEN"),
    slackAppToken: requireEnv("SLACK_APP_TOKEN"),
    ...channelPair("SLACK"),
    apiToken: process.env.OWL_API_TOKEN,
    coreWsUrl: process.env.OWL_WS_URL,
    stateFile: stateFile("slack", accountId),
  };
}

export function buildDiscordConfig(allProviders = false): DiscordConnectorConfig {
  const accountId = resolveConnectorAccountId("discord", allProviders);
  return {
    accountId,
    owlApiBase: owlApiBase(),
    discordBotToken: requireEnv("DISCORD_BOT_TOKEN"),
    ...channelPair("DISCORD"),
    apiToken: process.env.OWL_API_TOKEN,
    coreWsUrl: process.env.OWL_WS_URL,
    stateFile: stateFile("discord", accountId),
  };
}

async function main(): Promise<void> {
  loadOwlEnv();
  const args = new Set(process.argv.slice(2));
  const wantsSlack = args.has("--slack") || args.has("--all");
  const wantsDiscord = args.has("--discord") || args.has("--all");

  if (!wantsSlack && !wantsDiscord) {
    throw new Error("Usage: node dist/cli.js --slack | --discord | --all");
  }
  const allProviders = args.has("--all");

  const connectors: ConnectorLifecycle[] = [];

  if (wantsSlack) {
    const slack = new SlackConnector(buildSlackConfig(allProviders));
    connectors.push({ name: "slack", start: () => slack.start(), stop: () => slack.stop() });
  }
  if (wantsDiscord) {
    const discord = new DiscordConnector(buildDiscordConfig(allProviders));
    connectors.push({ name: "discord", start: () => discord.start(), stop: () => discord.stop() });
  }

  const lifecycle = createConnectorLifecycle(connectors);
  await lifecycle.start();

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[cli] Received ${signal}, terminating connectors:`, connectors.map((c) => c.name).join(", "));
    // This helper process owns only network clients. Exiting closes every
    // socket immediately; no Owl database state is owned here.
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Connector startup failed."}\n`);
    process.exitCode = 2;
  });
}
