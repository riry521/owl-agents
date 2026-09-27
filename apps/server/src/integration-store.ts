import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";

import { SecretStore } from "../../../packages/core/dist/secret-store.js";
import { createUlid, isUlid } from "./ids.js";
import { prepareDataDir, resolveDataDir } from "./contracts.js";
import type { IntegrationConfig, IntegrationConfigPatch, IntegrationProvider, IntegrationStatus, IntegrationTestResult } from "./types.js";
import type { OwnerLanguage } from "../../../packages/shared/dist/owner-language.js";

function integrationText(language: OwnerLanguage, ja: string, en: string): string {
  return language === "ja" ? ja : en;
}

function slackErrorText(body: unknown, language: OwnerLanguage): string {
  const error = slackError(body);
  return language === "en" && error === "応答不正" ? "invalid response" : error;
}

interface StoredMeta {
  provider: IntegrationProvider;
  has_app_token: boolean;
  has_signing_secret: boolean;
  has_channel_id?: boolean;
  channel_id?: string;
  has_conversation_channel_id: boolean;
  conversation_channel_id?: string;
  has_notification_channel_id: boolean;
  notification_channel_id?: string;
  account_id?: string;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  created_at: string;
  updated_at: string;
}

const SLACK_AUTH_TEST_URL = "https://slack.com/api/auth.test";
const SLACK_SOCKET_MODE_TEST_URL = "https://slack.com/api/apps.connections.open";
const SLACK_CHANNEL_INFO_URL = "https://slack.com/api/conversations.info";
const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const DISCORD_TEST_URL = "https://discord.com/api/v10/users/@me";
const DISCORD_CHANNEL_URL = "https://discord.com/api/v10/channels";
const DISCORD_POST_MESSAGE_URL = "https://discord.com/api/v10/channels";
const DEFAULT_EXTERNAL_REQUEST_TIMEOUT_MS = 15_000;

type IntegrationStoreOptions = {
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
};

function secretKey(provider: IntegrationProvider): string {
  return `integration:${provider}`;
}

function secretEnvNames(provider: IntegrationProvider): Record<string, string> {
  return provider === "slack"
    ? {
        bot_token: "SLACK_BOT_TOKEN",
        app_token: "SLACK_APP_TOKEN",
        signing_secret: "SLACK_SIGNING_SECRET",
      }
    : {
        bot_token: "DISCORD_BOT_TOKEN",
      };
}

function metadataEnvNames(provider: IntegrationProvider): Record<string, string> {
  return provider === "slack"
    ? {
        channel_id: "SLACK_CHANNEL_ID",
        conversation_channel_id: "SLACK_CONVERSATION_CHANNEL_ID",
        notification_channel_id: "SLACK_NOTIFICATION_CHANNEL_ID",
      }
    : {
        channel_id: "DISCORD_CHANNEL_ID",
        conversation_channel_id: "DISCORD_CONVERSATION_CHANNEL_ID",
        notification_channel_id: "DISCORD_NOTIFICATION_CHANNEL_ID",
      };
}

export class IntegrationStore {
  private readonly metaPath: string;
  private readonly envPath: string;
  private readonly legacySecrets: SecretStore;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private configs = new Map<IntegrationProvider, IntegrationConfig>();
  private meta: Map<IntegrationProvider, StoredMeta>;

  constructor(owlRoot: string, dataDir = resolveDataDir(owlRoot), options: IntegrationStoreOptions = {}) {
    prepareDataDir(owlRoot, dataDir);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.metaPath = join(dataDir, "integrations-meta.json");
    this.envPath = join(owlRoot, ".env");
    if (existsSync(this.metaPath)) {
      try { chmodSync(this.metaPath, 0o600); } catch { /* best effort */ }
    }
    if (existsSync(this.envPath)) {
      try { chmodSync(this.envPath, 0o600); } catch { /* best effort */ }
    }
    this.legacySecrets = new SecretStore(dataDir);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) && (options.requestTimeoutMs ?? 0) > 0
      ? Number(options.requestTimeoutMs)
      : DEFAULT_EXTERNAL_REQUEST_TIMEOUT_MS;
    this.meta = new Map();
    this.loadMeta();
    this.loadConfigs();
  }

  private loadMeta(): void {
    if (!existsSync(this.metaPath)) return;
    try {
      const raw = readFileSync(this.metaPath, "utf8");
      const entries = JSON.parse(raw) as StoredMeta[];
      this.meta = new Map(entries.map((entry) => [entry.provider, entry]));
    } catch (error) {
      throw new Error(`integrations-meta.json is corrupt or unreadable: ${this.metaPath}`, { cause: error });
    }
  }

  private saveMeta(): void {
    const temporaryPath = `${this.metaPath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify([...this.meta.values()], null, 2), { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.metaPath);
      chmodSync(this.metaPath, 0o600);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  private loadConfigs(): void {
    let metaChanged = false;
    for (const provider of ["slack", "discord"] as const) {
      const fromEnv = this.readEnvConfig(provider);
      const fromLegacy = fromEnv ? null : this.loadLegacyConfig(provider);
      const config = fromEnv ?? fromLegacy;
      if (!config) continue;

      if (fromLegacy) this.writeEnvSecrets(provider, config);
      if (!config.account_id) config.account_id = this.meta.get(provider)?.account_id ?? createUlid();
      this.configs.set(provider, cloneIntegrationConfig(config));

      const existing = this.meta.get(provider);
      // Channel values from the environment are effective startup overrides,
      // not persisted settings. Legacy encrypted records are migration input
      // and may be materialized into metadata once, but a normal env-backed
      // load must leave the previous metadata channels untouched.
      const metadataSource = fromEnv
        ? {
            ...config,
            channel_id: existing?.channel_id,
            conversation_channel_id: existing?.conversation_channel_id,
            notification_channel_id: existing?.notification_channel_id,
          }
        : config;
      const next = this.metadataFor(provider, metadataSource, existing);
      const currentComparable = existing ? { ...existing, updated_at: "" } : null;
      const nextComparable = { ...next, updated_at: "" };
      if (JSON.stringify(currentComparable) !== JSON.stringify(nextComparable)) {
        this.meta.set(provider, next);
        metaChanged = true;
      }
    }
    if (metaChanged) this.saveMeta();
  }

  private readEnvConfig(provider: IntegrationProvider): IntegrationConfig | null {
    const secrets = secretEnvNames(provider);
    const botToken = process.env[secrets.bot_token]?.trim();
    if (!botToken) return null;

    const config: IntegrationConfig = { bot_token: botToken };
    for (const field of ["app_token", "signing_secret"] as const) {
      const envName = secrets[field];
      if (envName && process.env[envName]?.trim()) config[field] = process.env[envName]!.trim();
    }

    const metadata = this.meta.get(provider);
    const optional = metadataEnvNames(provider);
    const legacyEnv = normalizeChannelList(process.env[optional.channel_id]);
    const conversationEnv = normalizeChannelList(process.env[optional.conversation_channel_id]);
    const notificationEnv = normalizeChannelList(process.env[optional.notification_channel_id]);
    const persisted = {
      channel_id: metadata?.channel_id,
      conversation_channel_id: metadata?.conversation_channel_id,
      notification_channel_id: metadata?.notification_channel_id,
    } satisfies IntegrationConfigPatch;
    const persistedChannels = resolveChannelIds(persisted);

    // A role-specific environment value is an explicit override for that
    // role. The legacy environment value is the next-most-specific override
    // and applies to both roles. Persisted metadata is consulted only when no
    // environment override exists, so a stale metadata file cannot silently
    // defeat an explicitly supplied process/.env value.
    const legacyChannelId = legacyEnv ?? normalizeChannelList(metadata?.channel_id);
    const conversationChannelId = conversationEnv
      ?? legacyEnv
      ?? notificationEnv
      ?? persistedChannels.conversation
      ?? persistedChannels.notification;
    const notificationChannelId = notificationEnv
      ?? legacyEnv
      ?? conversationEnv
      ?? persistedChannels.notification
      ?? persistedChannels.conversation;
    if (legacyEnv || (!conversationEnv && !notificationEnv && legacyChannelId)) config.channel_id = legacyChannelId;
    if (conversationChannelId) config.conversation_channel_id = conversationChannelId;
    if (notificationChannelId) config.notification_channel_id = notificationChannelId;
    if (metadata?.account_id) config.account_id = metadata.account_id;
    return config;
  }

  private loadLegacyConfig(provider: IntegrationProvider): IntegrationConfig | null {
    const passphrase = process.env.OWL_SECRET_PASSPHRASE?.trim();
    if (!passphrase) return null;
    try {
      this.legacySecrets.load();
      const raw = this.legacySecrets.get(secretKey(provider), passphrase);
      if (!raw) return null;
      const config = parseIntegrationConfig(JSON.parse(raw));
      if (!config) return null;
      // Legacy encrypted records may contain only channel_id. Materialize
      // both role-specific fields during migration so every consumer sees the
      // same canonical split configuration after a restart.
      const channels = resolveChannelIds(config);
      if (channels.conversation) config.conversation_channel_id = channels.conversation;
      if (channels.notification) config.notification_channel_id = channels.notification;
      return config;
    } catch {
      // Legacy encrypted settings are optional. A normal start must not prompt
      // or fail when the old passphrase is unavailable.
      return null;
    }
  }

  private writeEnvSecrets(provider: IntegrationProvider, config: IntegrationConfig): void {
    const names = secretEnvNames(provider);
    const updates: Record<string, string> = {};
    for (const field of ["bot_token", "app_token", "signing_secret"] as const) {
      const envName = names[field];
      const value = config[field];
      if (envName && value) updates[envName] = value;
    }
    this.updateEnvFile(updates);
  }

  private removeEnvSecrets(provider: IntegrationProvider): void {
    const names = secretEnvNames(provider);
    this.updateEnvFile(Object.fromEntries(Object.values(names).map((name) => [name, undefined])));
  }

  private updateEnvFile(updates: Record<string, string | undefined>): void {
    if (!existsSync(this.envPath) && Object.values(updates).every((value) => value === undefined)) return;
    const original = existsSync(this.envPath) ? readFileSync(this.envPath, "utf8") : "";
    const lines = original.length > 0 ? original.split(/\r?\n/u) : [];
    const keys = new Set(Object.keys(updates));
    const seen = new Set<string>();
    const next: string[] = [];

    for (const line of lines) {
      const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
      const key = match?.[2];
      if (!key || !keys.has(key)) {
        next.push(line);
        continue;
      }
      seen.add(key);
      const value = updates[key];
      if (value !== undefined) next.push(`${match![1]}${key}=${JSON.stringify(value)}`);
    }

    const additions = Object.entries(updates).filter(([key, value]) => value !== undefined && !seen.has(key));
    if (additions.length > 0) {
      while (next.length > 0 && next[next.length - 1] === "") next.pop();
      if (next.length > 0) next.push("");
      for (const [key, value] of additions) next.push(`${key}=${JSON.stringify(value)}`);
    }

    const content = next.length > 0 ? `${next.join("\n")}\n` : "";
    const temporaryPath = `${this.envPath}.tmp`;
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.envPath);
      chmodSync(this.envPath, 0o600);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch { /* preserve the original error */ }
      throw error;
    }

    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  private metadataFor(provider: IntegrationProvider, config: IntegrationConfig, existing?: StoredMeta): StoredMeta {
    const now = new Date().toISOString();
    const channels = resolveChannelIds(config);
    return {
      provider,
      has_app_token: Boolean(config.app_token),
      has_signing_secret: Boolean(config.signing_secret),
      ...(config.channel_id ? { has_channel_id: true, channel_id: config.channel_id } : { has_channel_id: false }),
      has_conversation_channel_id: Boolean(channels.conversation),
      ...(channels.conversation ? { conversation_channel_id: channels.conversation } : {}),
      has_notification_channel_id: Boolean(channels.notification),
      ...(channels.notification ? { notification_channel_id: channels.notification } : {}),
      ...(config.account_id ? { account_id: config.account_id } : {}),
      last_tested_at: existing?.last_tested_at ?? null,
      last_test_ok: existing?.last_test_ok ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
  }

  list(): IntegrationStatus[] {
    const providers: IntegrationProvider[] = ["slack", "discord"];
    return providers.map((provider) => {
      const stored = this.meta.get(provider);
      const config = this.configs.get(provider);
      const channels = config ? resolveChannelIds(config) : { conversation: undefined, notification: undefined };
      const configured = isCompleteIntegrationConfig(provider, config, channels);
      return {
        provider,
        configured,
        conversation_channel_id: channels.conversation ?? null,
        notification_channel_id: channels.notification ?? null,
        last_tested_at: stored?.last_tested_at ?? null,
        last_test_ok: stored?.last_test_ok ?? null,
      };
    });
  }

  save_integration(provider: IntegrationProvider, config: IntegrationConfigPatch): IntegrationStatus {
    const patch = normalizeIntegrationPatch(config);
    const existing = this.meta.get(provider);
    const previous = this.getConfig(provider);
    const persistedChannels: IntegrationConfigPatch = {
      channel_id: normalizeChannelList(existing?.channel_id),
      conversation_channel_id: normalizeChannelList(existing?.conversation_channel_id),
      notification_channel_id: normalizeChannelList(existing?.notification_channel_id),
    };
    // getConfig() contains effective environment overrides. Keep those
    // values available for secrets, but explicitly remove all channel values
    // before merging so a partial save can never materialize an override into
    // integrations-meta.json.
    const merged: IntegrationConfig = previous ? { ...previous } : { bot_token: "" };
    for (const key of ["channel_id", "conversation_channel_id", "notification_channel_id"] as const) {
      delete merged[key];
      const persisted = persistedChannels[key];
      if (persisted) merged[key] = persisted;
    }
    for (const key of [
      "bot_token",
      "app_token",
      "signing_secret",
      "channel_id",
      "conversation_channel_id",
      "notification_channel_id",
      "account_id",
    ] as const) {
      const value = patch[key];
      if (value !== undefined && value !== "") merged[key] = value;
    }

    if (!normalizeChannelId(merged.bot_token)) throw new Error(`${provider} bot_token is required.`);
    if (provider === "slack" && !normalizeChannelId(merged.app_token)) {
      throw new Error("slack app_token is required.");
    }
    const explicitLegacy = normalizeChannelList(patch.channel_id);
    const explicitConversation = normalizeChannelList(patch.conversation_channel_id);
    const explicitNotification = normalizeChannelList(patch.notification_channel_id);
    const previousChannels = resolveChannelIds(persistedChannels);
    const persistedLegacyChannel = normalizeChannelList(persistedChannels.channel_id);
    const legacyChannel = explicitLegacy ?? persistedLegacyChannel;
    const conversationChannel = explicitConversation
      ?? (explicitLegacy ? legacyChannel : previousChannels.conversation ?? previousChannels.notification ?? explicitNotification ?? legacyChannel);
    const notificationChannel = explicitNotification
      ?? (explicitLegacy ? legacyChannel : previousChannels.notification ?? previousChannels.conversation ?? explicitConversation ?? legacyChannel);
    if (!conversationChannel || !notificationChannel) {
      throw new Error(`${provider} conversation_channel_id and notification_channel_id are required.`);
    }
    merged.conversation_channel_id = conversationChannel;
    merged.notification_channel_id = notificationChannel;
    if (explicitLegacy || (!explicitConversation && !explicitNotification && persistedLegacyChannel)) {
      merged.channel_id = legacyChannel;
    } else {
      delete merged.channel_id;
    }
    if (!merged.account_id) merged.account_id = existing?.account_id ?? createUlid();
    if (!isUlid(merged.account_id)) throw new Error("Integration account_id must be a canonical ULID.");

    merged.bot_token = merged.bot_token.trim();
    for (const key of ["app_token", "signing_secret"] as const) {
      if (merged[key]) merged[key] = merged[key]!.trim();
    }
    this.writeEnvSecrets(provider, merged);
    this.configs.set(provider, cloneIntegrationConfig(merged));
    const entry = this.metadataFor(provider, merged, existing);
    this.meta.set(provider, entry);
    this.saveMeta();

    // Re-read the effective configuration after persisting. This keeps an
    // active environment override effective for the running connector while
    // the metadata above remains based only on the persisted values.
    const effective = this.readEnvConfig(provider) ?? merged;
    this.configs.set(provider, cloneIntegrationConfig(effective));
    const effectiveChannels = resolveChannelIds(effective);

    return {
      provider,
      configured: isCompleteIntegrationConfig(provider, effective, effectiveChannels),
      conversation_channel_id: effectiveChannels.conversation ?? null,
      notification_channel_id: effectiveChannels.notification ?? null,
      last_tested_at: entry.last_tested_at,
      last_test_ok: entry.last_test_ok,
    };
  }

  getConfig(provider: IntegrationProvider): IntegrationConfig | null {
    const config = this.configs.get(provider);
    return config ? cloneIntegrationConfig(config) : null;
  }

  async test(provider: IntegrationProvider, language: OwnerLanguage = "ja"): Promise<IntegrationTestResult> {
    const config = this.getConfig(provider);
    if (!config) {
      return { provider, ok: false, detail: integrationText(language, `${provider}の設定が見つかりません。先にトークンを登録してください。`, `${provider} settings were not found. Register a token first.`), tested_at: new Date().toISOString() };
    }

    const testedAt = new Date().toISOString();
    let ok = false;
    let detail = "";

    try {
      const channels = resolveChannelIds(config);
      if (!isCompleteIntegrationConfig(provider, config, channels)) {
        detail = integrationText(language, `${provider}の設定が不完全です。Tokenと会話・通知チャンネルを確認してください。`, `${provider} settings are incomplete. Check the token and conversation and notification channels.`);
      } else if (provider === "slack") {
        ({ ok, detail } = await this.testSlack(config, parseChannelIds(channels.conversation), parseChannelIds(channels.notification), language));
      } else {
        ({ ok, detail } = await this.testDiscord(config, parseChannelIds(channels.conversation), parseChannelIds(channels.notification), language));
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "通信エラー";
      detail = integrationText(language, `接続テスト失敗: ${reason}`, `Connection test failed: ${/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(reason) ? "network error" : reason}`);
    }

    const stored = this.meta.get(provider);
    if (stored) {
      stored.last_tested_at = testedAt;
      stored.last_test_ok = ok;
      stored.updated_at = testedAt;
      this.saveMeta();
    }

    return { provider, ok, detail, tested_at: testedAt };
  }

  private async testSlack(
    config: IntegrationConfig,
    conversationChannels: readonly string[],
    notificationChannels: readonly string[],
    language: OwnerLanguage,
  ): Promise<{ ok: boolean; detail: string }> {
    const botAuth = await this.requestJson(SLACK_AUTH_TEST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.bot_token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    if (!botAuth.httpOk || !isSlackOk(botAuth.body)) {
      return { ok: false, detail: integrationText(language, `Slack Bot Tokenの検証に失敗しました（${slackError(botAuth.body)}）。`, `Slack Bot Token verification failed (${slackErrorText(botAuth.body, language)}).`) };
    }

    const socketMode = await this.requestJson(SLACK_SOCKET_MODE_TEST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.app_token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    if (!socketMode.httpOk || !isSlackOk(socketMode.body) || typeof asRecord(socketMode.body)?.url !== "string") {
      return { ok: false, detail: integrationText(language, `Slack App Token（Socket Mode）の検証に失敗しました（${slackError(socketMode.body)}）。`, `Slack App Token (Socket Mode) verification failed (${slackErrorText(socketMode.body, language)}).`) };
    }

    const channels = [...new Set([...conversationChannels, ...notificationChannels])];
    for (const channelId of channels) {
      const info = await this.requestJson(`${SLACK_CHANNEL_INFO_URL}?${new URLSearchParams({ channel: channelId }).toString()}`, {
        headers: { Authorization: `Bearer ${config.bot_token}` },
      });
      const channel = asRecord(asRecord(info.body)?.channel);
      if (!info.httpOk || !isSlackOk(info.body) || channel?.id !== channelId || channel.is_archived === true || channel.is_member !== true) {
        const reason = slackError(info.body);
        return { ok: false, detail: integrationText(language, `Slackチャンネル ${channelId} にアクセスできません${reason === "応答不正" ? "（Bot未参加、アーカイブ、または権限を確認してください）" : `（${reason}）`}。`, `Cannot access Slack channel ${channelId}${reason === "応答不正" ? " (check bot membership, archive status, and permissions)" : ` (${reason})`}.`) };
      }

      const post = await this.requestJson(SLACK_POST_MESSAGE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.bot_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ channel: channelId, text: integrationText(language, "Owl接続テスト", "Owl connection test") }),
      });
      if (!post.httpOk || !isSlackOk(post.body)) {
        return { ok: false, detail: integrationText(language, `Slackチャンネル ${channelId} へ投稿できません（${slackError(post.body)}）。`, `Cannot post to Slack channel ${channelId} (${slackErrorText(post.body, language)}).`) };
      }
    }
    return { ok: true, detail: integrationText(language, "Slack接続、Socket Mode、会話・通知チャンネルのアクセスと投稿を確認しました。", "Slack connection, Socket Mode, channel access, and posting were verified.") };
  }

  private async testDiscord(
    config: IntegrationConfig,
    conversationChannels: readonly string[],
    notificationChannels: readonly string[],
    language: OwnerLanguage,
  ): Promise<{ ok: boolean; detail: string }> {
    const botAuth = await this.requestJson(DISCORD_TEST_URL, {
      headers: { Authorization: `Bot ${config.bot_token}` },
    });
    if (!botAuth.httpOk) return { ok: false, detail: integrationText(language, "Discord Bot Tokenの検証に失敗しました。", "Discord Bot Token verification failed.") };

    const channels = [...new Set([...conversationChannels, ...notificationChannels])];
    for (const channelId of channels) {
      const channel = await this.requestJson(`${DISCORD_CHANNEL_URL}/${encodeURIComponent(channelId)}`, {
        headers: { Authorization: `Bot ${config.bot_token}` },
      });
      const channelBody = asRecord(channel.body);
      if (!channel.httpOk || channelBody?.id !== channelId) {
        return { ok: false, detail: integrationText(language, `Discordチャンネル ${channelId} にアクセスできません。`, `Cannot access Discord channel ${channelId}.`) };
      }

      const post = await this.requestJson(`${DISCORD_POST_MESSAGE_URL}/${encodeURIComponent(channelId)}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${config.bot_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: integrationText(language, "Owl接続テスト", "Owl connection test") }),
      });
      if (!post.httpOk) {
        return { ok: false, detail: integrationText(language, `Discordチャンネル ${channelId} へ投稿できません。`, `Cannot post to Discord channel ${channelId}.`) };
      }
    }
    return { ok: true, detail: integrationText(language, "Discord接続、会話・通知チャンネルのアクセスと投稿を確認しました。", "Discord connection, channel access, and posting were verified.") };
  }

  private async requestJson(url: string, init: RequestInit): Promise<{ httpOk: boolean; body: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const abortFromCaller = (): void => controller.abort(init.signal?.reason);
    if (init.signal) {
      if (init.signal.aborted) abortFromCaller();
      else init.signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const body = await response.json().catch(() => null) as unknown;
      return { httpOk: response.ok, body };
    } catch {
      // A timeout (and other transport failure) is an ordinary failed
      // connection test. Keep the response deliberately generic so neither
      // tokens nor provider error text can leak through this boundary.
      return { httpOk: false, body: null };
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  remove(provider: IntegrationProvider): boolean {
    const existed = this.meta.delete(provider) || this.configs.has(provider);
    this.configs.delete(provider);
    this.removeEnvSecrets(provider);
    try {
      this.legacySecrets.load();
      this.legacySecrets.delete(secretKey(provider));
    } catch {
      // Legacy cleanup is best effort; the active .env configuration is removed.
    }
    if (existed) this.saveMeta();
    return existed;
  }
}

function parseIntegrationConfig(value: unknown): IntegrationConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.bot_token !== "string" || record.bot_token.trim().length === 0) return null;
  const config: IntegrationConfig = { bot_token: record.bot_token };
  for (const key of [
    "app_token",
    "signing_secret",
    "channel_id",
    "conversation_channel_id",
    "notification_channel_id",
    "account_id",
  ] as const) {
    if (typeof record[key] === "string" && record[key].length > 0) {
      config[key] = key === "channel_id" || key.endsWith("_channel_id")
        ? normalizeChannelList(record[key] as string) ?? ""
        : record[key] as string;
    }
  }
  return config;
}

function cloneIntegrationConfig(config: IntegrationConfig): IntegrationConfig {
  const clone: IntegrationConfig = { bot_token: config.bot_token };
  for (const key of [
    "app_token",
    "signing_secret",
    "channel_id",
    "conversation_channel_id",
    "notification_channel_id",
    "account_id",
  ] as const) {
    if (config[key]) {
      clone[key] = key === "channel_id" || key.endsWith("_channel_id")
        ? normalizeChannelList(config[key])
        : config[key];
    }
  }
  return clone;
}

function normalizeIntegrationPatch(config: IntegrationConfigPatch): IntegrationConfigPatch {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("Integration config must be a JSON object.");
  }
  const patch: Partial<IntegrationConfig> = {};
  for (const key of [
    "bot_token",
    "app_token",
    "signing_secret",
    "channel_id",
    "conversation_channel_id",
    "notification_channel_id",
    "account_id",
  ] as const) {
    const value = config[key];
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`${key} must be a string when supplied.`);
    }
    if (typeof value === "string") {
      patch[key] = key === "channel_id" || key.endsWith("_channel_id")
        ? normalizeChannelList(value) ?? ""
        : value.trim();
    }
  }
  return patch;
}

function normalizeChannelId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/** Normalize a channel list while retaining the legacy string-based API. */
function normalizeChannelList(value: string | undefined): string | undefined {
  const ids = value
    ?.split(/[\s,]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (!ids || ids.length === 0) return undefined;
  return [...new Set(ids)].join(",");
}

export function parseChannelIds(value: string | undefined): string[] {
  const normalized = normalizeChannelList(value);
  return normalized ? normalized.split(",") : [];
}

function resolveChannelIds(config: Pick<IntegrationConfig, "channel_id" | "conversation_channel_id" | "notification_channel_id"> | null | undefined): {
  conversation: string | undefined;
  notification: string | undefined;
} {
  const legacy = normalizeChannelList(config?.channel_id);
  const conversation = normalizeChannelList(config?.conversation_channel_id) ?? legacy;
  const notification = normalizeChannelList(config?.notification_channel_id) ?? legacy ?? conversation;
  return { conversation, notification };
}

function isCompleteIntegrationConfig(
  provider: IntegrationProvider,
  config: IntegrationConfig | null | undefined,
  channels: { conversation: string | undefined; notification: string | undefined },
): boolean {
  return Boolean(
    normalizeChannelId(config?.bot_token)
    && parseChannelIds(channels.conversation).length > 0
    && parseChannelIds(channels.notification).length > 0
    && (provider === "discord" || normalizeChannelId(config?.app_token)),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isSlackOk(value: unknown): boolean {
  return asRecord(value)?.ok === true;
}

function slackError(value: unknown): string {
  const error = asRecord(value)?.error;
  return typeof error === "string" && error.length > 0 ? error : "応答不正";
}
