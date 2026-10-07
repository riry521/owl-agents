import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveDataDir } from "./contracts.js";
import type { IntegrationStore } from "./integration-store.js";
import type { IntegrationConfig, IntegrationProvider } from "./types.js";
import type { OwnerLanguage } from "../../../packages/shared/dist/owner-language.js";
import { cliLanguage } from "./cli-language.js";

export interface Connector {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface SlackConnectorModule {
  createSlackConnector?: (config: {
    botToken: string;
    appToken: string;
    conversationChannelId: string;
    notificationChannelId: string;
    coreApiBase: string;
    apiToken?: string;
    accountId: string;
    stateFile?: string;
  }) => Connector;
}

interface DiscordConnectorModule {
  createDiscordConnector?: (config: {
    botToken: string;
    conversationChannelId: string;
    notificationChannelId: string;
    coreApiBase: string;
    apiToken?: string;
    accountId: string;
    stateFile?: string;
  }) => Connector;
}

export function formatConnectorFailure(provider: IntegrationProvider, error: unknown, language: OwnerLanguage = cliLanguage()): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/401|invalid[_ -]?auth|token|oauth|unauthorized/iu.test(raw)) {
    return language === "ja" ? `${provider}連携の認証に失敗しました。Bot/Appトークンを確認して保存し、再起動してください。` : `${provider} authentication failed. Check and save the Bot/App tokens, then restart.`;
  }
  if (/channel|conversation|access|permission|forbidden/iu.test(raw)) {
    return language === "ja" ? `${provider}連携のチャンネルへアクセスできません。Botの参加状態、チャンネルID、権限を確認してください。` : `Cannot access the ${provider} channel. Check bot membership, channel ID, and permissions.`;
  }
  if (/network|connection|timeout|fetch failed|econnreset/iu.test(raw)) {
    return language === "ja" ? `${provider}連携へ接続できませんでした。ネットワークと外部サービスの状態を確認してください。` : `Could not connect to ${provider}. Check the network and service status.`;
  }
  const safe = raw
    .replace(/(bearer\s+|authorization\s*[:=]\s*|api[-_ ]?key\s*[:=]\s*|token\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
    .slice(0, 500);
  return language === "ja"
    ? `${provider}連携の起動に失敗しました。${safe || "設定とログを確認してください。"}`
    : `Could not start ${provider}. ${/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(safe) ? "Check the settings and logs." : safe || "Check the settings and logs."}`;
}

export class ConnectorManager {
  private readonly connectors = new Map<IntegrationProvider, Connector>();

  constructor(
    private readonly owlRoot: string,
    private readonly integrationStore: IntegrationStore,
    private readonly serverPort: number,
    private readonly getLanguage: () => Promise<OwnerLanguage> = async () => cliLanguage(),
  ) {}

  async startAll(): Promise<void> {
    const integrations = this.integrationStore.list();
    const failures: string[] = [];
    for (const integration of integrations) {
      if (!integration.configured) continue;
      try {
        await this.startConnector(integration.provider);
      } catch (error) {
        const message = formatConnectorFailure(integration.provider, error, await this.getLanguage());
        console.error(`[owl-server] ${message}`, error);
        failures.push(message);
      }
    }
    if (failures.length > 0) {
      throw new Error(failures.join(" "));
    }
  }

  async startConnector(provider: IntegrationProvider): Promise<void> {
    await this.stopConnector(provider);
    const config = this.integrationStore.getConfig(provider);
    if (!config) {
      throw new Error(`${provider} connector configuration is missing even though the integration is marked configured.`);
    }
    const connector = await this.createConnector(provider, config);
    try {
      await connector.start();
    } catch (error) {
      // Never leave a half-started connector unreachable: it is not in
      // `connectors` yet, so a plain stopConnector() call could not find it.
      await connector.stop().catch((stopError) => {
        console.error(`[owl-server] ${provider} connector failed to clean up after a failed start.`, stopError);
      });
      throw error;
    }
    this.connectors.set(provider, connector);
    console.log(`[owl-server] ${provider} connector started.`);
  }

  async stopConnector(provider: IntegrationProvider): Promise<void> {
    const connector = this.connectors.get(provider);
    if (!connector) return;

    let failure: unknown;
    try {
      await connector.stop();
    } catch (error) {
      failure = error;
      console.error(`[owl-server] ${formatConnectorFailure(provider, error, await this.getLanguage())}`, error);
    } finally {
      this.connectors.delete(provider);
    }
    if (failure !== undefined) throw failure;
  }

  async stopAll(): Promise<void> {
    const failures: string[] = [];
    for (const provider of [...this.connectors.keys()]) {
      try {
        await this.stopConnector(provider);
      } catch (error) {
        // Always attempt every connector during shutdown, then report all
        // failures to the lifecycle caller instead of claiming a clean stop.
        const message = formatConnectorFailure(provider, error, await this.getLanguage());
        console.error(`[owl-server] ${message}`, error);
        failures.push(message);
      }
    }
    if (failures.length > 0) throw new Error(failures.join(" "));
  }

  private async createConnector(provider: IntegrationProvider, config: IntegrationConfig): Promise<Connector> {
    const coreApiBase = `http://127.0.0.1:${this.serverPort}/api/v1`;
    const accountId = config.account_id;
    if (!accountId) throw new Error(`${provider} connector account_id is missing; save the integration again.`);
    const conversationChannelId = config.conversation_channel_id ?? config.channel_id;
    const notificationChannelId = config.notification_channel_id ?? conversationChannelId;
    if (!conversationChannelId || !notificationChannelId) {
      throw new Error(`${provider} connector conversation_channel_id and notification_channel_id are missing; save the integration again.`);
    }
    const apiToken = process.env.OWL_API_TOKEN;
    const stateFile = join(resolveDataDir(this.owlRoot), "connectors", `${provider}-${accountId}.json`);

    if (provider === "slack") {
      if (!config.app_token) throw new Error("Slack app_token is missing.");
      const connectorPath = join(this.owlRoot, "packages/connector-slack/dist/index.js");
      const mod = await import(pathToFileURL(connectorPath).href) as SlackConnectorModule;
      if (typeof mod.createSlackConnector !== "function") {
        throw new Error("createSlackConnector is not available.");
      }
      return mod.createSlackConnector({
        botToken: config.bot_token,
        appToken: config.app_token,
        conversationChannelId,
        notificationChannelId,
        coreApiBase,
        apiToken,
        accountId,
        stateFile,
      });
    }

    const connectorPath = join(this.owlRoot, "packages/connector-discord/dist/index.js");
    const mod = await import(pathToFileURL(connectorPath).href) as DiscordConnectorModule;
    if (typeof mod.createDiscordConnector !== "function") {
      throw new Error("createDiscordConnector is not available.");
    }
    return mod.createDiscordConnector({
      botToken: config.bot_token,
      conversationChannelId,
      notificationChannelId,
      coreApiBase,
      apiToken,
      accountId,
      stateFile,
    });
  }
}
