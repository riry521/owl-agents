import { cliText, cliLanguage } from "./cli-language.js";
import { access, appendFile, chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { scrubLegacySettings } from "./app-settings-store.js";
import { createConfiguredAgentRunner, createExternalAgentRunner, createHybridExecutorRuntime } from "./agent-runner.js";
import { isProcessAlive } from "./process-state.js";
import {
  assertStaticExport,
  resolveDataDir,
  resolveOwlRoot,
  resolveWebOut,
  serverPackageRoot,
  validateContractArtifacts,
  type ContractManifest,
} from "./contracts.js";
import { agentTimeoutConfigurationError, configuredBind, configuredPort, providerMode, serverExposureError } from "./config.js";
import { createConfiguredCore } from "./core.js";
import { ConnectorManager, formatConnectorFailure } from "./connector-manager.js";
import { ApiError, ContractValidationError, humanUnexpectedMessage, newReferenceId } from "./errors.js";
import { createOwlHttpServer, type OwlHttpServer } from "./http.js";
import { GuardTokenRegistry } from "./guard-tokens.js";
import type { IntegrationStore } from "./integration-store.js";
import type { IntegrationProvider } from "./types.js";
import { prepareConnectorConfig } from "./secret-config.js";

const SERVER_VERSION = "1.0.0";

async function recordServerFailure(referenceId: string, context: string, error: unknown): Promise<void> {
  const raw = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const dataDir = resolveDataDir(resolveOwlRoot());
  const logPath = join(dataDir, "server.log");
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await appendFile(logPath, "[" + referenceId + "] " + context + ": " + raw + "\n", { encoding: "utf8", mode: 0o640 });
  } catch {
    console.error(cliText('server logへ記録できませんでした。参照ID: ', 'Could not write to the server log. Reference ID: ') + referenceId);
  }
}

export interface ServerOptions {
  readonly bind: string;
  readonly port: number;
}

export interface RunningServer {
  readonly pid: number;
  readonly port: number;
  readonly bind: string;
  readonly dataDir: string;
  readonly pidFile: string;
  readonly stateFile: string;
  readonly http: OwlHttpServer;
  shutdown(force: boolean, timeoutMs: number): Promise<void>;
}

interface DatabaseModule {
  openDatabase?: (filename: string) => unknown;
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? 3787 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ContractValidationError(cliText('portは1〜65535の整数で指定してください。', 'Specify port as an integer from 1 to 65535.'));
  }
  return port;
}

export function defaultServerOptions(): ServerOptions {
  const bind = configuredBind();
  return { bind, port: parsePort(configuredPort()) };
}

async function readPid(pidFile: string): Promise<number | null> {
  try {
    const text = (await readFile(pidFile, "utf8")).trim();
    if (!/^\d+$/.test(text)) return null;
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function ensurePidAvailable(pidFile: string): Promise<void> {
  const pid = await readPid(pidFile);
  if (pid !== null && pid !== process.pid && isProcessAlive(pid)) {
    throw new ApiError(409, "idempotency_conflict", cliText('owl-coreはすでに起動しています。statusを確認してから再試行してください。', 'owl-core is already running. Check status before retrying.'), { pid });
  }
  if (pid !== null && pid !== process.pid) {
    try {
      await unlink(pidFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function loadDatabase(owlRoot: string, dataDir: string): Promise<unknown> {
  if (process.env.OWL_CORE_MODE === "standalone") {
    return null;
  }
  const dbPath = join(serverPackageRoot(), "../../packages/db/dist/index.js");
  try {
    await access(dbPath);
  } catch (error) {
    throw new ApiError(503, "dependency_unavailable", cliText('DB実行基盤がまだ利用できません。必要なdistをビルドしてから再実行してください。', 'The database runtime is unavailable. Build the required dist files and retry.'), { dependency: "packages/db/dist/index.js" }, { cause: error });
  }
  let loaded: DatabaseModule;
  try {
    loaded = (await import(pathToFileURL(dbPath).href)) as DatabaseModule;
  } catch (error) {
    throw new ApiError(503, "dependency_unavailable", cliText('DB実行基盤を読み込めませんでした。ビルド成果物を確認してください。', 'Could not load the database runtime. Check the build artifacts.'), { dependency: "packages/db/dist/index.js" }, { cause: error });
  }
  if (typeof loaded.openDatabase !== "function") {
    throw new ApiError(503, "dependency_unavailable", cliText('DBの公開APIが契約と一致しません。openDatabaseを確認してください.', 'The database API does not match the contract. Check openDatabase.'), { dependency: "packages/db/dist/index.js", export: "openDatabase" });
  }
  const database = loaded.openDatabase(join(dataDir, "owl.sqlite")) as {
    migrate?: (directory: string) => unknown;
    close?: () => void;
  };
  if (typeof database.migrate !== "function") {
    throw new ApiError(503, "dependency_unavailable", cliText('DB migration APIが契約と一致しません。migrateを確認してください。', 'The database migration API does not match the contract. Check migrate.'), { dependency: "packages/db/dist/index.js", export: "migrate" });
  }
  try {
    database.migrate(join(owlRoot, "packages/db/migrations"));
  } catch (error) {
    database.close?.();
    throw error;
  }
  return database;
}

/**
 * The address the permission hook uses to reach this server. A wildcard bind
 * address accepts connections but is not one to connect to, so the hook uses
 * the loopback address of the same family.
 */
function guardHost(bind: string): string {
  const host = bind.replace(/^\[|\]$/gu, "");
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "::0") return "::1";
  return host;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const host = guardHost(options.bind);
  const authority = host.includes(":") ? `[${host}]` : host;
  const guardApiBase = `http://${authority}:${options.port}`;
  const previousGuardEnvironment = {
    OWL_ROOT: process.env.OWL_ROOT,
    OWL_GUARD_API_BASE: process.env.OWL_GUARD_API_BASE,
  };
  process.env.OWL_ROOT = resolveOwlRoot();
  process.env.OWL_GUARD_API_BASE = guardApiBase;
  const restoreGuardEnvironment = (): void => {
    for (const [key, value] of Object.entries(previousGuardEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const running = await startServerWithGuard(options, guardApiBase);
    return {
      ...running,
      shutdown: async (force, timeoutMs) => {
        try {
          await running.shutdown(force, timeoutMs);
        } finally {
          restoreGuardEnvironment();
        }
      },
    };
  } catch (error) {
    restoreGuardEnvironment();
    throw error;
  }
}

async function startServerWithGuard(options: ServerOptions, guardApiBase: string): Promise<RunningServer> {
  const owlRoot = resolveOwlRoot();
  const dataDir = resolveDataDir(owlRoot);
  const webOut = resolveWebOut(owlRoot);
  const exposureError = serverExposureError(options.bind);
  if (exposureError) throw new ContractValidationError(exposureError);
  const timeoutError = agentTimeoutConfigurationError();
  if (timeoutError) throw new ContractValidationError(timeoutError);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700).catch(() => undefined);
  try {
    await prepareConnectorConfig(owlRoot, dataDir);
  } catch (error) {
    throw new ContractValidationError(error instanceof Error ? error.message : cliText('connector設定を準備できません。', 'Could not prepare connector settings.'));
  }
  try {
    const cleanup = scrubLegacySettings(owlRoot, dataDir);
    if (cleanup) {
      const moved = cleanup.env_names.length > 0 ? `; keys moved to .env: ${cleanup.env_names.join(", ")}` : "";
      console.log(`[owl] legacy settings retired to ${cleanup.file}${moved}`);
    }
  } catch (error) {
    console.warn(`[owl] legacy settings could not be cleaned up: ${error instanceof Error ? error.message : String(error)}`);
  }
  await assertStaticExport(webOut);
  const contract = await validateContractArtifacts(owlRoot);
  const pidFile = join(dataDir, "owl-server.pid");
  const stateFile = join(dataDir, "owl-server.json");
  await ensurePidAvailable(pidFile);
  // Tokens from an earlier server process are invalid; the directory starts empty.
  const guardTokens = GuardTokenRegistry.open(join(dataDir, "guard-tokens"));
  const guard = { apiBase: guardApiBase, issueToken: guardTokens.issue };

  const db = await loadDatabase(owlRoot, dataDir);
  const agentRunner = process.env.OWL_CORE_MODE !== "standalone"
    ? await createExternalAgentRunner(owlRoot, providerMode() === "stub", guard)
    : createConfiguredAgentRunner();
  // Forward the agent-runtime ProviderClient to Core so every real deployment
  // uses the same persistent Advisor session path. A missing or
  // non-session-capable provider is a startup error; silently switching to the
  // legacy one-shot path hides authentication, harness, and protocol failures.
  let providerClient: unknown = null;
  if (process.env.OWL_CORE_MODE !== "standalone" && providerMode() !== "stub") {
    const getProvider = (agentRunner as { getProvider?: () => Promise<unknown> }).getProvider;
    if (typeof getProvider !== "function") {
      throw new ApiError(
        503,
        "dependency_unavailable",
        cliText('実運用ProviderがAdvisorセッションAPIを提供していません。Provider/Harnessの設定を確認してください。', 'The selected Provider does not expose the Advisor session API. Check Provider and Harness settings.'),
        { dependency: "ProviderClient.createSession" },
      );
    }
    providerClient = await getProvider();
    if (!providerClient || typeof (providerClient as { createSession?: unknown }).createSession !== "function") {
      throw new ApiError(
        503,
        "dependency_unavailable",
        cliText('選択したProvider/HarnessはAdvisorの永続セッションをサポートしていません。対応Harnessを選択するか、設定を修正してください。', 'The selected Provider/Harness does not support persistent Advisor sessions. Select a supported Harness or update the settings.'),
        { dependency: "ProviderClient.createSession" },
      );
    }
  }
  const core = await createConfiguredCore({
    db,
    agentRunner,
    git: undefined,
    version: SERVER_VERSION,
    owlRoot,
    dataDir,
    providerClient,
    executorRuntime: createHybridExecutorRuntime(owlRoot, guard),
  });
  // Core owns the RuleStore and its watcher. Reuse it for HTTP so Core and the
  // API never observe different rule generations; standalone MemoryCore still
  // gets a local store for its compatibility mode.
  const { RuleStore } = await import("../../../packages/core/dist/rule-store.js");
  const coreRuleStore = (core as unknown as { ruleStore?: InstanceType<typeof RuleStore> }).ruleStore;
  const ruleStore = coreRuleStore ?? new RuleStore(owlRoot);
  if (!coreRuleStore) {
    await ruleStore.ensureDirectories();
    await ruleStore.load();
    await ruleStore.startWatching((result) => {
      if (result.ok) console.log(`[owl-server] Rules reloaded (generation ${result.generation}).`);
      else console.error(`[owl-server] Rule reload failed; keeping the previous rules. ${result.error.message}`);
    });
  }
  const http = createOwlHttpServer({ core, db, webOut, bind: options.bind, port: options.port, contract, owlRoot, dataDir, ruleStore, guardTokens });
  try {
    await http.listen();
  } catch (error) {
    let cleanupReferenceId: string | undefined;
    try {
      await core.shutdown({ force: true, timeoutMs: 0 });
    } catch (cleanupError) {
      cleanupReferenceId = newReferenceId();
      await recordServerFailure(cleanupReferenceId, "core cleanup after HTTP startup failure", cleanupError);
    }
    throw new ApiError(
      503,
      "dependency_unavailable",
      cliText('HTTP serverを起動できませんでした。bindとportが利用可能か確認してください。', 'Could not start the HTTP server. Check the bind address and port.'),
      {
        bind: options.bind,
        port: options.port,
        ...(cleanupReferenceId ? { cleanup_reference_id: cleanupReferenceId } : {}),
      },
      { cause: error },
    );
  }

  const integrationStore = (core as unknown as { integrationStore?: IntegrationStore }).integrationStore;
  const ownerId = process.env.OWL_OWNER_ID?.trim() || "owner:default";
  if (integrationStore) {
    for (const provider of ["slack", "discord"] as const) {
      try {
        const config = integrationStore.getConfig(provider);
        if (config?.account_id) {
          await core.ensureConnectorAccount(ownerId, provider, config.account_id);
        }
      } catch (error) {
        const language = await core.getLanguage();
        const message = formatConnectorFailure(provider, error, language);
        console.error(`[owl-server] ${message}`, error);
        let cleanupReferenceId: string | undefined;
        try {
          await core.shutdown({ force: true, timeoutMs: 0 });
          await http.close();
        } catch (cleanupError) {
          cleanupReferenceId = newReferenceId();
          await recordServerFailure(cleanupReferenceId, "cleanup after connector account reconciliation failure", cleanupError);
        }
        throw new ApiError(
          503,
          "dependency_unavailable",
          language === "ja" ? `${message} サーバーは起動していません。` : `${message} The server is not running.`,
          { provider, ...(cleanupReferenceId ? { cleanup_reference_id: cleanupReferenceId } : {}) },
          { cause: error },
        );
      }
    }
  }
  const connectorManager = integrationStore ? new ConnectorManager(owlRoot, integrationStore, options.port, () => core.getLanguage()) : null;
  if (connectorManager) {
    try {
      await connectorManager.startAll();
    } catch (error) {
      const language = await core.getLanguage();
      let cleanupReferenceId: string | undefined;
      try {
        await connectorManager.stopAll();
      } catch (cleanupError) {
        cleanupReferenceId = newReferenceId();
        await recordServerFailure(cleanupReferenceId, "connector cleanup after startup failure", cleanupError);
      }
      try {
        await core.shutdown({ force: true, timeoutMs: 0 });
        await http.close();
      } catch (cleanupError) {
        cleanupReferenceId ??= newReferenceId();
        await recordServerFailure(cleanupReferenceId, "core/http cleanup after connector startup failure", cleanupError);
      }
      const message = error instanceof Error
        ? error.message
        : language === "ja" ? "連携の起動に失敗しました。連携設定と外部サービスの状態を確認してください。" : "Could not start the integration. Check its settings and external service status.";
      throw new ApiError(
        503,
        "dependency_unavailable",
        language === "ja" ? `${message} サーバーは起動していません。` : `${message} The server is not running.`,
        { ...(cleanupReferenceId ? { cleanup_reference_id: cleanupReferenceId } : {}) },
        { cause: error },
      );
    }
  }
  // Integration changes arrive on the process-local control channel, not the
  // durable event stream (they have no Core sequence of their own).
  const unsubscribeConnectors = connectorManager && core.subscribeControl ? core.subscribeControl((signal) => {
    const provider = signal.provider as IntegrationProvider;
    if (!provider) return;
    if (signal.type === "integration.saved") {
      void connectorManager.startConnector(provider).catch(async (e) => {
        const language = await core.getLanguage();
        const message = formatConnectorFailure(provider, e, language);
        console.error(language === "ja" ? `[owl-server] ${message} 設定保存後の再接続に失敗しました。` : `[owl-server] ${message} Reconnection after saving settings failed.`, e);
      });
    } else {
      void connectorManager.stopConnector(provider).catch(async (e) => {
        const language = await core.getLanguage();
        const message = formatConnectorFailure(provider, e, language);
        console.error(language === "ja" ? `[owl-server] ${message} 連携停止に失敗しました。` : `[owl-server] ${message} Could not stop the integration.`, e);
      });
    }
  }) : () => undefined;

  await writeFile(pidFile, String(process.pid), { encoding: "utf8", mode: 0o600 });
  await writeFile(stateFile, JSON.stringify({ pid: process.pid, bind: options.bind, port: options.port, started_at: new Date().toISOString() }), { encoding: "utf8", mode: 0o600 });
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async (force: boolean, timeoutMs: number): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      try {
        unsubscribeConnectors();
        // Connector sockets belong to this process and disappear on exit. Start
        // their best-effort disconnect, but do not make Owl shutdown wait for
        // network acknowledgements from Slack or Discord.
        if (connectorManager) {
          void connectorManager.stopAll().catch((error) =>
            console.error("[owl-server] Connector disconnect failed during shutdown", error));
        }
        if (!coreRuleStore) ruleStore.stopWatching();
        // close() synchronously stops accepting requests and destroys open
        // sockets. Process exit below owns the final resource teardown.
        void http.close().catch((error) =>
          console.error("[owl-server] HTTP close failed during shutdown", error));
        await core.shutdown({ force, timeoutMs });
      } finally {
        guardTokens.clear();
        await removeRuntimeFile(pidFile);
        await removeRuntimeFile(stateFile);
      }
    })();
    return shutdownPromise;
  };

  const handleSignal = (signal: NodeJS.Signals, force: boolean) => {
    void (async () => {
      try {
        await shutdown(force, 30_000);
        // Async cleanup can leave SDK sockets, file watchers, or native DB
        // handles in the event loop. Exit only after cleanup has completed so
        // owl stop can observe a definitive process termination.
        process.exit(0);
      } catch (error) {
        const referenceId = newReferenceId();
        await recordServerFailure(referenceId, signal + " shutdown failed", error);
        console.error(cliText('安全停止に失敗しました。ログの参照IDを確認してください: ', 'Safe shutdown failed. Check the logs using reference ID: ') + referenceId);
        process.exit(1);
      }
    })();
  };
  process.once("SIGTERM", () => handleSignal("SIGTERM", false));
  process.once("SIGINT", () => handleSignal("SIGINT", true));

  return { pid: process.pid, port: options.port, bind: options.bind, dataDir, pidFile, stateFile, http, shutdown };
}

async function removeRuntimeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export function parseServerArgs(argv: readonly string[]): ServerOptions {
  let bind = configuredBind();
  let port = parsePort(configuredPort());
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--bind") {
      const value = argv[++index];
      if (!value) throw new ContractValidationError(cliText('--bindには値が必要です。', '--bind requires a value.'));
      bind = value;
    } else if (argument === "--port") {
      const value = argv[++index];
      if (!value) throw new ContractValidationError(cliText('--portには値が必要です。', '--port requires a value.'));
      port = parsePort(value);
    } else {
      throw new ContractValidationError(cliText(`server argvが契約と一致しません: ${argument}`, `Invalid server arguments: ${argument}`));
    }
  }
  return { bind, port };
}

export async function runServerProcess(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const running = await startServer(parseServerArgs(argv));
  console.log(JSON.stringify({ command: "server", pid: running.pid, api_base: "/api/v1", scope: "mvp" }));
}

export async function main(): Promise<void> {
  try {
    await runServerProcess();
  } catch (error) {
    const referenceId = newReferenceId();
    await recordServerFailure(referenceId, "server startup failed", error);
    if (error instanceof ContractValidationError) {
      console.error(error.message + cliText(' 参照ID: ', ' Reference ID: ') + referenceId);
      process.exit(3);
    } else if (error instanceof ApiError) {
      console.error(error.message + cliText(' 参照ID: ', ' Reference ID: ') + referenceId);
      process.exit(error.status === 409 ? 6 : 4);
    } else {
      console.error(humanUnexpectedMessage(cliLanguage()) + cliText(' 参照ID: ', ' Reference ID: ') + referenceId);
      process.exit(8);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
