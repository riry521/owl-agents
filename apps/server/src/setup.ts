import { cliText } from "./cli-language.js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectProcessSkillsPack } from "../../../packages/core/dist/process-skills-pack.js";
import {
  PROCESS_SKILLS_INSTALL_COMMANDS,
  PROCESS_SKILLS_SETTINGS_KEY,
  type ProcessSkillsSettings,
} from "../../../packages/shared/dist/index.js";
import { resolveOwlRoot, resolveDataDir, serverPackageRoot } from "./contracts.js";
import { IntegrationStore } from "./integration-store.js";
import { providerConfigurationError, providerSelection, resolveExecutableForSelection } from "./provider-selection.js";

interface StoredSetupMetadata {
  slack?: {
    channel_id?: string;
    conversation_channel_id?: string;
    notification_channel_id?: string;
    account_id?: string;
  };
  discord?: {
    channel_id?: string;
    conversation_channel_id?: string;
    notification_channel_id?: string;
    account_id?: string;
  };
}

interface LegacySetupConfig extends StoredSetupMetadata {
  slack?: StoredSetupMetadata["slack"] & { bot_token?: string; app_token?: string };
  discord?: StoredSetupMetadata["discord"] & { bot_token?: string };
}

interface ReadonlySqliteDatabase {
  prepare(sql: string): { get(...parameters: unknown[]): unknown };
  close(): void;
}

type ReadonlySqliteConstructor = new (filename: string, options: { readonly: true; fileMustExist: true }) => ReadonlySqliteDatabase;

const DEFAULT_PROCESS_SKILLS_SETTINGS: ProcessSkillsSettings = { enabled: true, path: null };

/** The stored process skills setting, read without modifying the database; the defaults when it is unavailable. */
function readStoredProcessSkillsSettings(dataDir: string): ProcessSkillsSettings {
  let database: ReadonlySqliteDatabase | null = null;
  try {
    const requireFromDb = createRequire(join(serverPackageRoot(), "../../packages/db/package.json"));
    const Database = requireFromDb("better-sqlite3") as ReadonlySqliteConstructor;
    database = new Database(join(dataDir, "owl.sqlite"), { readonly: true, fileMustExist: true });
    const row = database.prepare("SELECT value_json FROM settings WHERE key = ?").get(PROCESS_SKILLS_SETTINGS_KEY) as
      { value_json?: unknown } | undefined;
    if (typeof row?.value_json !== "string") return DEFAULT_PROCESS_SKILLS_SETTINGS;
    const value: unknown = JSON.parse(row.value_json);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_PROCESS_SKILLS_SETTINGS;
    const record = value as Record<string, unknown>;
    return {
      enabled: typeof record.enabled === "boolean" ? record.enabled : true,
      path: typeof record.path === "string" ? record.path : null,
    };
  } catch (error) {
    console.error("[owl-setup] Could not read process skills settings; using defaults", error);
    return DEFAULT_PROCESS_SKILLS_SETTINGS;
  } finally {
    database?.close();
  }
}

export async function runSetup(): Promise<{ command: string; status: string; configured: string[] }> {
  const rl = createInterface({ input: stdin, output: stdout });
  const owlRoot = resolveOwlRoot();
  const dataDir = resolveDataDir(owlRoot);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  const configPath = join(dataDir, "owl-config.json");
  let existing: LegacySetupConfig = {};
  try {
    existing = JSON.parse(await readFile(configPath, "utf8")) as LegacySetupConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(cliText(`セットアップ設定を読み込めません: ${configPath}`, `Could not read setup settings: ${configPath}`), { cause: error });
    }
  }

  const pending: {
    slack?: { bot_token: string; app_token: string; conversation_channel_id: string; notification_channel_id: string };
    discord?: { bot_token: string; conversation_channel_id: string; notification_channel_id: string };
  } = {};
  const configured: string[] = [];

  stdout.write(cliText('\n=== Owl-Agent セットアップ ===\n\n', '\n=== Owl-Agent Setup ===\n\n'));

  const provider = providerSelection(owlRoot);
  const providerExecutable = await resolveExecutableForSelection(provider);
  const providerIssue = providerConfigurationError(provider, providerExecutable);
  if (provider.mode === "stub") {
    stdout.write(cliText('Provider: stub（外部provider CLIは不要、offline実行）\n', 'Provider: stub (no external CLI needed; offline mode)\n'));
  } else if (providerIssue) {
    stdout.write(`Provider: ${provider.providerId} / ${provider.adapter ?? cliText('未設定', 'not set')}\n`);
    stdout.write(`⚠ ${providerIssue}\n`);
    stdout.write(cliText('provider CLIはOwlが自動インストールしません。設定後に `owl doctor` を再実行してください。\n\n', 'Owl does not install Provider CLIs automatically. Rerun owl doctor after configuring one.\n\n'));
  } else {
    stdout.write(cliText(`Provider: ${provider.providerId} / ${provider.adapter}（実行ファイル確認済み）\n\n`, `Provider: ${provider.providerId} / ${provider.adapter} (executable verified)\n\n`));
  }

  const processSkillsSettings = readStoredProcessSkillsSettings(dataDir);
  const processSkillsPack = detectProcessSkillsPack({ env: process.env, settings: processSkillsSettings, homedir: homedir() });
  if (!processSkillsSettings.enabled) {
    stdout.write(cliText('プロセススキル: 設定でオフになっています\n\n', 'Process skills: disabled in settings\n\n'));
  } else if (processSkillsPack) {
    const source = processSkillsPack.source === "claude" ? "Claude" : processSkillsPack.source === "codex" ? "Codex" : cliText('設定したフォルダ', 'configured folder');
    const version = processSkillsPack.version ? ` ${processSkillsPack.version}` : "";
    stdout.write(cliText(`プロセススキル: superpowers${version}（${source}）を使います\n\n`, `Process skills: using superpowers${version} (${source})\n\n`));
  } else {
    const availableHarnesses = provider.mode !== "stub" && !providerIssue && provider.harness ? [provider.harness] : (["claude", "codex"] as const);
    stdout.write(cliText('superpowers が入っていないため、プロセススキルは使いません。使う場合は次のコマンドで導入してください（導入後は自動で検出します）:\n', 'Process skills are unavailable because superpowers is not installed. Install it with the following command to enable automatic detection:\n'));
    for (const harness of availableHarnesses) {
      stdout.write(`  ${PROCESS_SKILLS_INSTALL_COMMANDS[harness]}\n`);
    }
    stdout.write("\n");
  }

  const setupSlack = await rl.question(cliText('Slack連携を設定しますか？ (y/n): ', 'Configure Slack integration? (y/n): '));
  if (setupSlack.toLowerCase() === "y") {
    const botToken = await rl.question("Slack Bot Token (xoxb-...): ");
    const appToken = await rl.question("Slack App-Level Token (xapp-...): ");
    const conversationChannelId = await rl.question(cliText('Slack 会話用チャンネルID（複数はカンマ/改行区切り）: ', 'Slack conversation channel IDs (comma or newline separated): '));
    const notificationChannelId = await rl.question(cliText('Slack タスク通知用チャンネルID（複数はカンマ/改行区切り。会話用と同じなら同じID）: ', 'Slack task notification channel IDs (comma or newline separated; use the same IDs if shared): '));
    if (!botToken.startsWith("xoxb-") || !appToken.startsWith("xapp-") || !conversationChannelId.trim() || !notificationChannelId.trim()) {
      stdout.write(cliText('⚠ SlackのTokenまたはチャンネルIDが不正です。Slack設定は保存しません。\n', '⚠ Invalid Slack token or channel ID. Slack settings were not saved.\n'));
    } else {
      pending.slack = {
        bot_token: botToken,
        app_token: appToken,
        conversation_channel_id: conversationChannelId.trim(),
        notification_channel_id: notificationChannelId.trim(),
      };
      stdout.write(cliText('✓ Slack設定を受け付けました。\n', '✓ Slack settings accepted.\n'));
    }
  }

  const setupDiscord = await rl.question(cliText('\nDiscord連携を設定しますか？ (y/n): ', '\nConfigure Discord integration? (y/n): '));
  if (setupDiscord.toLowerCase() === "y") {
    const botToken = await rl.question("Discord Bot Token: ");
    const conversationChannelId = await rl.question(cliText('Discord 会話用チャンネルID（複数はカンマ/改行区切り）: ', 'Discord conversation channel IDs (comma or newline separated): '));
    const notificationChannelId = await rl.question(cliText('Discord タスク通知用チャンネルID（複数はカンマ/改行区切り。会話用と同じなら同じID）: ', 'Discord task notification channel IDs (comma or newline separated; use the same IDs if shared): '));
    if (botToken.length < 20 || !conversationChannelId.trim() || !notificationChannelId.trim()) {
      stdout.write(cliText('⚠ DiscordのTokenまたはチャンネルIDが不正です。Discord設定は保存しません。\n', '⚠ Invalid Discord token or channel ID. Discord settings were not saved.\n'));
    } else {
      pending.discord = {
        bot_token: botToken,
        conversation_channel_id: conversationChannelId.trim(),
        notification_channel_id: notificationChannelId.trim(),
      };
      stdout.write(cliText('✓ Discord設定を受け付けました。\n', '✓ Discord settings accepted.\n'));
    }
  }

  rl.close();
  const store = new IntegrationStore(owlRoot, dataDir);
  const slack = pending.slack ?? legacySlack(existing);
  const discord = pending.discord ?? legacyDiscord(existing);
  if (slack) {
    store.save_integration("slack", {
      bot_token: slack.bot_token,
      app_token: slack.app_token,
      conversation_channel_id: slack.conversation_channel_id,
      notification_channel_id: slack.notification_channel_id,
      account_id: existing.slack?.account_id,
    });
    configured.push("slack");
  }
  if (discord) {
    store.save_integration("discord", {
      bot_token: discord.bot_token,
      conversation_channel_id: discord.conversation_channel_id,
      notification_channel_id: discord.notification_channel_id,
      account_id: existing.discord?.account_id,
    });
    configured.push("discord");
  }

  const metadata: StoredSetupMetadata = {};
  const savedSlack = store.getConfig("slack");
  const savedDiscord = store.getConfig("discord");
  if (savedSlack) {
    metadata.slack = {
      channel_id: savedSlack.channel_id,
      conversation_channel_id: savedSlack.conversation_channel_id,
      notification_channel_id: savedSlack.notification_channel_id,
      account_id: savedSlack.account_id,
    };
  }
  if (savedDiscord) {
    metadata.discord = {
      channel_id: savedDiscord.channel_id,
      conversation_channel_id: savedDiscord.conversation_channel_id,
      notification_channel_id: savedDiscord.notification_channel_id,
      account_id: savedDiscord.account_id,
    };
  }
  await atomicWrite(configPath, JSON.stringify(metadata, null, 2) + "\n", 0o600);

  stdout.write(cliText('\n=== セットアップ完了 ===\n', '\n=== Setup Complete ===\n'));
  if (configured.length === 0) {
    stdout.write(cliText('何も保存されませんでした。連携Tokenを設定する場合は再度setupを実行してください。\n', 'Nothing was saved. Run setup again to configure integration tokens.\n'));
  } else {
    stdout.write(cliText(`設定済み: ${configured.join(", ")}\n`, `Configured: ${configured.join(", ")}\n`));
    stdout.write(cliText(`設定ファイル: ${configPath}\n`, `Settings file: ${configPath}\n`));
    stdout.write(cliText('Tokenはプロジェクトの.env（権限600）に保存しました。\n', 'Tokens were saved in the project .env file (mode 600).\n'));
  }

  return { command: "setup", status: "ok", configured };
}

function legacySlack(config: LegacySetupConfig): {
  bot_token: string;
  app_token: string;
  conversation_channel_id: string;
  notification_channel_id: string;
} | undefined {
  const value = config.slack;
  const conversationChannelId = value?.conversation_channel_id ?? value?.channel_id;
  const notificationChannelId = value?.notification_channel_id ?? value?.channel_id ?? conversationChannelId;
  return value?.bot_token && value.app_token && conversationChannelId && notificationChannelId
    ? {
        bot_token: value.bot_token,
        app_token: value.app_token,
        conversation_channel_id: conversationChannelId,
        notification_channel_id: notificationChannelId,
      }
    : undefined;
}

function legacyDiscord(config: LegacySetupConfig): {
  bot_token: string;
  conversation_channel_id: string;
  notification_channel_id: string;
} | undefined {
  const value = config.discord;
  const conversationChannelId = value?.conversation_channel_id ?? value?.channel_id;
  const notificationChannelId = value?.notification_channel_id ?? value?.channel_id ?? conversationChannelId;
  return value?.bot_token && conversationChannelId && notificationChannelId
    ? {
        bot_token: value.bot_token,
        conversation_channel_id: conversationChannelId,
        notification_channel_id: notificationChannelId,
      }
    : undefined;
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
