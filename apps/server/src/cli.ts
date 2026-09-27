#!/usr/bin/env node

// The `owl` CLI owns the complete local Owl lifecycle. The normal `stop`
// command stops optional standalone helpers first (when they belong to this
// project), then the server recorded in the data-directory state file.

import { closeSync, openSync } from "node:fs";
import { access, appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";

import "./config.js";
import { cliText } from "./cli-language.js";
import { CliError, ContractValidationError, newReferenceId } from "./errors.js";
import { resolveDataDir, resolveOwlRoot, serverPackageRoot } from "./contracts.js";
import { stopManagedAuxiliaryProcesses } from "./lifecycle-stop.js";
import { isProcessAlive } from "./process-state.js";
import { startServer, type RunningServer, type ServerOptions } from "./server.js";
import { configuredBind, configuredPort, deprecatedConfigurationWarnings, serverExposureError, tailscaleServeEnabled } from "./config.js";
import { connectorConfigStatus, prepareConnectorConfig } from "./secret-config.js";
import { providerConfigurationError, providerSelection, resolveExecutableForSelection } from "./provider-selection.js";

interface ServerState {
  pid: number;
  bind: string;
  port: number;
  started_at: string;
}

interface StatusResponse {
  services: Array<{ name: string; state: string; pid: number | null }>;
  mvp_scope: string;
  version: string;
}

interface ParsedStart extends ServerOptions {
  foreground: boolean;
}

interface ParsedAdvisor {
  conversationId: string | null;
}

interface AdvisorEvent {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
}

async function recordCliFailure(referenceId: string, error: unknown): Promise<void> {
  const raw = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const dataDir = resolveDataDir(resolveOwlRoot());
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await appendFile(join(dataDir, "server.log"), "[" + referenceId + "] owl command failed: " + raw + "\n", { encoding: "utf8", mode: 0o640 });
  } catch {
    process.stderr.write(cliText('ログへ記録できませんでした。参照ID: ', 'Could not write to the log. Reference ID: ') + referenceId + "\n");
  }
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new CliError(2, cliText('portは1〜65535の整数で指定してください。', 'Specify port as an integer from 1 to 65535.'));
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError(2, cliText('portは1〜65535の整数で指定してください。', 'Specify port as an integer from 1 to 65535.'));
  return port;
}

function parseStartArgs(argv: readonly string[], allowNoConnectors: boolean): ParsedStart {
  let foreground = false;
  let bind = configuredBind();
  let port = configuredPort() ? parsePort(configuredPort()!) : 3787;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--foreground") {
      foreground = true;
    } else if (argument === "--bind") {
      const value = argv[++index];
      if (!value) throw new CliError(2, cliText('--bindには値が必要です。', '--bind requires a value.'));
      bind = value;
    } else if (argument === "--port") {
      const value = argv[++index];
      if (!value) throw new CliError(2, cliText('--portには値が必要です。', '--port requires a value.'));
      port = parsePort(value);
    } else if (argument === "--no-connectors" && allowNoConnectors) {
      // Connectors are outside the frozen MVP scope; the flag is accepted for argv compatibility.
    } else {
      throw new CliError(2, cliText(`start/restartのargvが契約と一致しません: ${argument}`, `Invalid start/restart arguments: ${argument}`));
    }
  }
  return { bind, port, foreground };
}

function parseStatusArgs(argv: readonly string[]): { json: boolean } {
  let json = false;
  for (const argument of argv) {
    if (argument === "--json") json = true;
    else throw new CliError(2, cliText(`statusのargvが契約と一致しません: ${argument}`, `Invalid status arguments: ${argument}`));
  }
  return { json };
}

function parseAdvisorArgs(argv: readonly string[]): ParsedAdvisor {
  let conversationId: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--conversation") {
      const value = argv[++index];
      if (!value) throw new CliError(2, cliText('--conversationには値が必要です。', '--conversation requires a value.'));
      conversationId = value;
    } else {
      throw new CliError(2, cliText(`advisorのargvが契約と一致しません: ${argument}`, `Invalid advisor arguments: ${argument}`));
    }
  }
  return { conversationId };
}

function parseStopArgs(argv: readonly string[]): { force: boolean; timeoutSeconds: number } {
  let force = false;
  let timeoutSeconds = 30;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") {
      force = true;
    } else if (argument === "--timeout") {
      const value = argv[++index];
      if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 3600) {
        throw new CliError(2, cliText('--timeoutは1〜3600の整数秒で指定してください。', 'Specify --timeout as an integer from 1 to 3600 seconds.'));
      }
      timeoutSeconds = Number(value);
    } else {
      throw new CliError(2, cliText(`stopのargvが契約と一致しません: ${argument}`, `Invalid stop arguments: ${argument}`));
    }
  }
  return { force, timeoutSeconds };
}

async function readState(): Promise<ServerState | null> {
  const root = resolveOwlRoot();
  const path = join(resolveDataDir(root), "owl-server.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) throw new Error("state is not an object");
    const state = parsed as Partial<ServerState>;
    if (!Number.isInteger(state.pid) || typeof state.bind !== "string" || !Number.isInteger(state.port)) throw new Error("state fields are invalid");
    return state as ServerState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError(3, cliText('owl-coreのstateを読み込めません。dataディレクトリと設定を確認してください。', 'Could not read owl-core state. Check the data directory and configuration.'), { cause: error });
  }
}

function connectionHost(bind: string): string {
  return bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind;
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  try {
    const headers = new Headers(init?.headers);
    const apiToken = process.env.OWL_API_TOKEN?.trim();
    if (apiToken && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${apiToken}`);
    }
    const response = await fetch(url, { ...init, headers });
    const body = await response.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("response is not an object");
    if (!response.ok) throw new CliError(response.status === 409 ? 6 : 4, cliText('owl-coreが要求を処理できませんでした。server logとstatusを確認してください。', 'owl-core could not handle the request. Check the server log and status.'));
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(4, cliText('owl-coreへ接続できません。start状態とportを確認してください。', 'Could not connect to owl-core. Check whether it is running and verify the port.'), { cause: error });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function fetchAdvisorEvents(baseUrl: string, cursor: number): Promise<AdvisorEvent[]> {
  const body = await fetchJson(`${baseUrl}/events?after=${cursor}&limit=200`);
  const data = asRecord(body.data);
  if (!data || !Array.isArray(data.events)) {
    throw new CliError(4, cliText('eventsの応答が契約と一致しません。server versionを確認してください。', 'The events response does not match the contract. Check the server version.'));
  }
  return data.events.flatMap((value) => {
    const event = asRecord(value);
    const payload = asRecord(event?.payload);
    return event && payload && typeof event.sequence === "number" && typeof event.type === "string"
      ? [{ sequence: event.sequence, type: event.type, payload }]
      : [];
  });
}

async function latestAdvisorEventCursor(baseUrl: string): Promise<number> {
  const events = await fetchAdvisorEvents(baseUrl, 0);
  return events.reduce((cursor, event) => Math.max(cursor, event.sequence), 0);
}

async function postAdvisorMessage(baseUrl: string, text: string): Promise<void> {
  await fetchJson(`${baseUrl}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "terminal",
      text,
      origin: { channel: "terminal" },
    }),
  });
}

async function fetchAdvisorReply(baseUrl: string, conversationId: string, messageId: string): Promise<string | null> {
  const body = await fetchJson(`${baseUrl}/conversations/${encodeURIComponent(conversationId)}/messages?limit=200`);
  const candidates = Array.isArray(body.data)
    ? body.data
    : asRecord(body.data)?.data && Array.isArray(asRecord(body.data)?.data)
      ? asRecord(body.data)?.data as unknown[]
      : [];
  const message = candidates.find((value) => asRecord(value)?.id === messageId);
  const messageBody = asRecord(message)?.body;
  return typeof messageBody === "string" ? messageBody : null;
}

async function waitForAdvisorReply(
  baseUrl: string,
  conversationId: string,
  initialCursor: number,
): Promise<{ reply: string; cursor: number }> {
  const deadline = Date.now() + 120_000;
  let cursor = initialCursor;
  let responseEvent: AdvisorEvent | null = null;

  while (Date.now() < deadline) {
    const events = await fetchAdvisorEvents(baseUrl, cursor);
    for (const event of events) {
      cursor = Math.max(cursor, event.sequence);
      if (event.type === "advisor.responded" && event.payload.conversation_id === conversationId) {
        responseEvent = event;
      }
    }

    if (responseEvent) {
      const directReply = responseEvent.payload.reply;
      if (typeof directReply === "string") return { reply: directReply, cursor };
      const messageId = responseEvent.payload.message_id;
      if (typeof messageId === "string") {
        const reply = await fetchAdvisorReply(baseUrl, conversationId, messageId);
        if (reply !== null) return { reply, cursor };
      }
    }

    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 250));
  }

  throw new CliError(5, cliText('Advisorの応答が指定時間内に届きませんでした。server statusとeventsを確認してください。', 'The Advisor did not respond in time. Check server status and events.'));
}

async function runAdvisor(args: ParsedAdvisor): Promise<Record<string, unknown>> {
  const state = await readState();
  if (!state || !isAlive(state.pid)) {
    throw new CliError(4, cliText('owl-coreは起動していません。startを実行してからadvisorを実行してください。', 'owl-core is not running. Run start before advisor.'));
  }
  const baseUrl = `http://${connectionHost(state.bind)}:${state.port}/api/v1`;
  let conversationId = args.conversationId;
  if (conversationId === null) {
    const activeConversation = await fetchJson(`${baseUrl}/advisor/conversation/active`);
    if (typeof activeConversation.conversation_id !== "string") {
      throw new CliError(4, cliText('Advisorのactive conversationを解決できませんでした。', 'Could not find the active Advisor conversation.'));
    }
    conversationId = activeConversation.conversation_id;
  }
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: isTTY, prompt: "> " });
  let responses = 0;
  process.stdout.write(cliText('Owl Advisor (Ctrl+D で終了)\n', 'Owl Advisor (Ctrl+D to exit)\n'));
  if (isTTY) rl.prompt();
  try {
    for await (const line of rl) {
      const text = line.trim();
      if (!text) continue;
      const cursor = await latestAdvisorEventCursor(baseUrl);
      await postAdvisorMessage(baseUrl, text);
      const result = await waitForAdvisorReply(baseUrl, conversationId, cursor);
      process.stdout.write(`${result.reply}\n`);
      responses += 1;
      if (isTTY) rl.prompt();
    }
  } finally {
    rl.close();
  }
  return { command: "advisor", status: "ok", responses };
}

const isAlive = isProcessAlive;

function classifyStartupFailure(logText: string): string | null {
  if (/app-settings\.json is corrupt or contains invalid settings/iu.test(logText)) {
    return cliText('Provider設定ファイル（data/app-settings.json）の形式が不正です。`owl doctor`で詳細と修正方法を確認してください。', 'The Provider settings file (data/app-settings.json) is invalid. Run owl doctor for details.');
  }
  if (/Applied migration identity or status does not match|migration/iu.test(logText)) {
    return cliText('SQLite migrationの整合性を検証できませんでした。data/owl.sqliteとプロジェクトのmigrationを確認してください。', 'Could not verify SQLite migrations. Check data/owl.sqlite and the project migrations.');
  }
  if (/EADDRINUSE|address already in use|HTTP serverを起動できませんでした/iu.test(logText)) {
    return cliText('HTTP serverを起動できませんでした。指定portを別プロセスが使用していないか確認してください。', 'Could not start the HTTP server. Check whether another process is using the port.');
  }
  if (/connector|slack|discord|連携の起動/iu.test(logText)) {
    return cliText('連携の起動に失敗しました。Slack/Discordの設定、Token、チャンネル権限を確認してください。', 'Could not start the integration. Check Slack/Discord settings, tokens, and channel permissions.');
  }
  if (/contract|manifest|static assets|web.*out|契約/iu.test(logText)) {
    return cliText('Owlのビルド成果物または契約artifactを検証できませんでした。setup/buildを再実行してください。', 'Could not verify Owl build or contract artifacts. Rerun setup or build.');
  }
  return null;
}

async function readStartupFailure(dataDir: string, logOffset: number): Promise<string | null> {
  try {
    const logPath = join(dataDir, "server.log");
    const raw = await readFile(logPath, "utf8");
    const appended = raw.length >= logOffset ? raw.slice(logOffset) : raw;
    return classifyStartupFailure(appended);
  } catch {
    return null;
  }
}

async function waitForServerReady(
  bind: string,
  port: number,
  timeoutMs: number,
  child: ChildProcess,
  dataDir: string,
  logOffset: number,
): Promise<ServerState> {
  const url = `http://${connectionHost(bind)}:${port}/api/v1/health`;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const result = child.signalCode ? `signal=${child.signalCode}` : `exit=${child.exitCode ?? "unknown"}`;
      const detail = await readStartupFailure(dataDir, logOffset);
      throw new CliError(
        4,
        cliText(
          `owl-coreが起動前に終了しました（${result}）${detail ? `。原因: ${detail}` : "。"} server.logとdoctorを確認してください。`,
          `owl-core exited before startup completed (${result})${detail ? `. Cause: ${detail}` : "."} Check server.log and run doctor.`,
        ),
        { cause: lastError },
      );
    }
    let healthy = false;
    try {
      const response = await fetch(url);
      if (response.ok) healthy = true;
      else lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    // Health can become available before startServer() has written its
    // runtime state. Also, an unrelated Owl process on the same port can
    // answer health, so readiness must be tied to this exact child PID.
    try {
      const state = await readState();
      if (healthy && state !== null && state.pid === child.pid && state.bind === bind && state.port === port) return state;
      if (state && state.pid !== child.pid) {
        lastError = new Error(`state pid=${state.pid} does not belong to child pid=${child.pid}`);
      }
    } catch (error) {
      // A state file may be observed while it is being created. Keep polling
      // until the child exits or the readiness deadline is reached.
      lastError = error;
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new CliError(5, cliText('owl-coreのhealthとPID stateを同時に確認できず、起動確認がtimeoutしました。別のowlプロセスがportを使用していないか、ログとdoctorを確認してください。', 'Startup timed out before health and PID state could be confirmed. Check the port, logs, and doctor output.'), { cause: lastError });
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (!child.pid || !isAlive(child.pid)) return;
  try { child.kill("SIGTERM"); } catch { /* best effort */ }
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolvePromise();
      }, 1_000);
      const onExit = (): void => {
        clearTimeout(timer);
        resolvePromise();
      };
      child.once("exit", onExit);
    });
  }
  if (isAlive(child.pid)) {
    try { child.kill("SIGKILL"); } catch { /* best effort */ }
  }
}

const SERVER_LOG_ROTATE_BYTES = 10 * 1024 * 1024;

async function startBackground(options: ServerOptions): Promise<ServerState> {
  const root = resolveOwlRoot();
  const dataDir = resolveDataDir(root);
  const serverLogPath = join(dataDir, "server.log");
  const serverEntry = join(serverPackageRoot(), "dist/server.js");
  try {
    await access(serverEntry);
  } catch (error) {
    throw new CliError(4, cliText('serverのbuild成果物がありません。先にnpx tsc -p tsconfig.jsonを実行してください。', 'The server build is missing. Run npx tsc -p tsconfig.json first.'), { cause: error });
  }
  const current = await readState();
  if (current && isAlive(current.pid)) {
    throw new CliError(3, cliText('owl-coreはすでに起動しています。statusを確認してから再試行してください.', 'owl-core is already running. Check status before trying again.'));
  }
  let serverLogOffset = 0;
  try {
    serverLogOffset = Number((await stat(serverLogPath)).size);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // The detached Core writes its console output here; keep one previous
  // generation instead of letting the file grow across restarts.
  if (serverLogOffset > SERVER_LOG_ROTATE_BYTES) {
    await rename(serverLogPath, `${serverLogPath}.1`);
    serverLogOffset = 0;
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const serverLog = openSync(serverLogPath, "a", 0o640);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [serverEntry, "--bind", options.bind, "--port", String(options.port)], {
      cwd: root,
      detached: true,
      stdio: ["ignore", serverLog, serverLog],
      env: { ...process.env, OWL_ROOT: root, OWL_DATA_DIR: dataDir, OWL_BIND: options.bind, OWL_PORT: String(options.port) },
    });
  } finally {
    closeSync(serverLog);
  }
  child.unref();
  try {
    return await waitForServerReady(options.bind, options.port, 30_000, child, dataDir, serverLogOffset);
  } catch (error) {
    await terminateChild(child);
    throw error;
  }
}

async function runStart(options: ParsedStart): Promise<Record<string, unknown>> {
  const exposureError = serverExposureError(options.bind, tailscaleServeEnabled());
  if (exposureError) throw new CliError(3, exposureError);
  const owlRoot = resolveOwlRoot();
  const dataDir = resolveDataDir(owlRoot);
  try {
    await prepareConnectorConfig(owlRoot, dataDir);
  } catch (error) {
    throw new CliError(3, error instanceof Error ? error.message : cliText('connector設定を準備できません。', 'Could not prepare connector settings.'));
  }

  let pid: number;
  let bind: string;
  let port: number;
  let foregroundRunning: RunningServer | null = null;
  if (options.foreground) {
    foregroundRunning = await startServer(options);
    pid = foregroundRunning.pid;
    bind = foregroundRunning.bind;
    port = foregroundRunning.port;
  } else {
    const state = await startBackground(options);
    pid = state.pid;
    bind = state.bind;
    port = state.port;
  }
  const result: Record<string, unknown> = {
    command: "start",
    pid,
    api_base: `http://${connectionHost(bind)}:${port}/api/v1`,
    scope: "mvp",
  };
  if (tailscaleServeEnabled()) {
    const ts = await setupTailscaleServe(port);
    if (!ts.ok) {
      if (foregroundRunning) await foregroundRunning.shutdown(true, 0);
      else {
        try { await runStop({ force: true, timeoutSeconds: 5 }, true); } catch { /* preserve the useful Tailscale error */ }
      }
      throw new CliError(4, cliText('OWL_TAILSCALE_SERVE=1ですがTailscale Serveを設定できません。Tailscaleをインストールしログインしてから再試行してください。owl startは公開せず停止しました。', 'Tailscale Serve could not be configured. Install Tailscale, sign in, and retry. owl start stopped without publishing.'));
    }
    if (ts.url) result.tailscale_url = ts.url;
  }
  return result;
}

async function runStatus(args: { json: boolean }): Promise<Record<string, unknown>> {
  const state = await readState();
  if (!state || !isAlive(state.pid)) throw new CliError(4, cliText('owl-coreは起動していません。startを実行してください。', 'owl-core is not running. Run start.'));
  const body = await fetchJson(`http://${connectionHost(state.bind)}:${state.port}/api/v1/system/status`);
  const status = body as unknown as StatusResponse;
  if (!Array.isArray(status.services)) throw new CliError(4, cliText('system statusのservicesが契約と一致しません。server versionを確認してください。', 'The system status services do not match the contract. Check the server version.'));
  if (args.json) {
    return { services: status.services, works: {}, schema_version: status.version };
  }
  const lines = ["NAME\tSTATE\tPID"];
  for (const service of status.services) lines.push(`${service.name}\t${service.state}\t${service.pid ?? "-"}`);
  return { table: lines.join("\n") };
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return !isAlive(pid);
}

async function runStop(args: { force: boolean; timeoutSeconds: number }, silent = false): Promise<Record<string, unknown>> {
  const root = resolveOwlRoot();
  const auxiliaryResults = await stopManagedAuxiliaryProcesses(root, args);
  const failedAuxiliary = auxiliaryResults.filter((entry) => entry.status === "failed");
  if (failedAuxiliary.length > 0) {
    const details = failedAuxiliary.map((entry) => `${entry.name}(PID ${entry.pid ?? "?"})`).join(", ");
    throw new CliError(5, cliText(`owlの補助プロセスを停止できませんでした: ${details}。--forceで再試行してください。`, `Could not stop Owl helper processes: ${details}. Retry with --force.`));
  }
  const stoppedAuxiliary = auxiliaryResults
    .filter((entry) => entry.status === "stopped")
    .map((entry) => entry.name);
  const state = await readState();
  if (!state || !isAlive(state.pid)) {
    if (stoppedAuxiliary.length > 0) {
      return { command: "stop", services: [...new Set(stoppedAuxiliary)], status: "ok" };
    }
    throw new CliError(6, cliText('停止対象のowlが見つかりません。statusを確認してください。', 'No Owl process was found to stop. Check status.'));
  }
  const status = await fetchJson(`http://${connectionHost(state.bind)}:${state.port}/api/v1/system/status`);
  const services = status.services;
  if (!Array.isArray(services) || !services.some((service) => typeof service === "object" && service !== null && (service as { pid?: unknown }).pid === state.pid)) {
    throw new CliError(6, cliText('PID stateとsystem statusが一致しません。別プロセスを停止せず、stateを確認してください。', 'PID state and system status differ. Check the state before stopping a process.'));
  }
  process.kill(state.pid, args.force ? "SIGINT" : "SIGTERM");
  let exited = await waitForExit(state.pid, args.timeoutSeconds * 1000);
  if (!exited && args.force) {
    process.kill(state.pid, "SIGKILL");
    exited = await waitForExit(state.pid, 5_000);
  }
  if (!exited) throw new CliError(5, cliText('owl-coreが指定時間内に停止しませんでした。--forceで再試行できます。', 'owl-core did not stop in time. Retry with --force.'));
  const result = { command: "stop", services: [...new Set([...stoppedAuxiliary, "owl-core"])], status: "ok" };
  if (!silent) return result;
  return result;
}

async function runRestart(args: ParsedStart): Promise<Record<string, unknown>> {
  await runStop({ force: false, timeoutSeconds: 30 }, true);
  const result = await runStart({ ...args, foreground: false });
  return { command: "restart", pid: result.pid, status: "ok" };
}

interface WorkListPage {
  data: Array<{ id?: unknown }>;
  cursor: string | null;
  has_more: boolean;
}

async function fetchTerminalWorkIds(bind: string, port: number, state: "completed" | "cancelled"): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const query = new URLSearchParams({ state, limit: "200" });
    if (cursor) query.set("cursor", cursor);
    const body = await fetchJson(`http://${connectionHost(bind)}:${port}/api/v1/works?${query.toString()}`);
    const page = body as unknown as WorkListPage;
    if (!Array.isArray(page.data)) {
      throw new CliError(4, cliText('works一覧の応答が契約と一致しません。server versionを確認してください。', 'The Works list response does not match the contract. Check the server version.'));
    }
    for (const item of page.data) {
      if (typeof item?.id === "string") ids.push(item.id);
    }
    if (page.has_more !== true || typeof page.cursor !== "string") break;
    cursor = page.cursor;
  }
  return ids;
}

/** Manual Workspace cleanup: removes `.owl-workspaces/<work_id>` for every Work already in a terminal state (completed/cancelled). Running Works are left untouched. */
async function runCleanup(): Promise<Record<string, unknown>> {
  const state = await readState();
  if (!state || !isAlive(state.pid)) {
    throw new CliError(4, cliText('owl-coreは起動していません。startを実行してから再試行してください。', 'owl-core is not running. Run start and try again.'));
  }
  const owlRoot = resolveOwlRoot();
  const workspacesBase = join(owlRoot, ".owl-workspaces");
  const completed = await fetchTerminalWorkIds(state.bind, state.port, "completed");
  const cancelled = await fetchTerminalWorkIds(state.bind, state.port, "cancelled");
  const terminalWorkIds = [...completed, ...cancelled];
  let removed = 0;
  for (const workId of terminalWorkIds) {
    const dir = join(workspacesBase, workId.replace(/[^a-zA-Z0-9_:-]/g, "_"));
    try {
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Best-effort: one Workspace failing to delete must not abort the batch.
    }
  }
  return { command: "cleanup", checked: terminalWorkIds.length, removed };
}

async function runServe(argv: readonly string[]): Promise<Record<string, unknown>> {
  let off = false;
  for (const argument of argv) {
    if (argument === "--off") off = true;
    else throw new CliError(2, cliText(`serveのargvが契約と一致しません: ${argument}`, `Invalid serve arguments: ${argument}`));
  }
  if (off) {
    await removeTailscaleServe();
    return { command: "serve", status: "off" };
  }
  const state = await readState();
  if (!state || !isAlive(state.pid)) {
    throw new CliError(4, cliText('owl-coreは起動していません。startを実行してからserveを実行してください。', 'owl-core is not running. Run start before serve.'));
  }
  const exposureError = serverExposureError(state.bind, true);
  if (exposureError) throw new CliError(3, exposureError);
  const ts = await setupTailscaleServe(state.port);
  if (!ts.ok) {
    throw new CliError(4, cliText('Tailscaleが利用できません。Tailscaleをインストールし、ログインしてください。', 'Tailscale is unavailable. Install it and sign in.'));
  }
  return { command: "serve", status: "ok", url: ts.url ?? null };
}

async function runOpen(argv: readonly string[]): Promise<Record<string, unknown>> {
  if (argv.length > 0) throw new CliError(2, cliText(`openのargvが契約と一致しません: ${argv[0]}`, `Invalid open arguments: ${argv[0]}`));
  let state = await readState();
  let started = false;
  if (!state || !isAlive(state.pid)) {
    await runStart(parseStartArgs([], true));
    state = await readState();
    started = true;
    if (!state) throw new CliError(4, cliText('owl-coreを起動できませんでした。statusとserver.logを確認してください。', 'Could not start owl-core. Check status and server.log.'));
  }
  const url = `http://${connectionHost(state.bind)}:${state.port}/owl/`;
  const opened = await openInBrowser(url);
  const lines = [];
  if (started) lines.push(cliText(HUMAN_MESSAGES.start.ja, HUMAN_MESSAGES.start.en));
  lines.push(opened
    ? cliText(`ブラウザで開きました: ${url}`, `Opened in your browser: ${url}`)
    : cliText(`ブラウザを開けませんでした。次のURLを開いてください: ${url}`, `Could not open a browser. Open this URL: ${url}`));
  return { command: "open", url, table: lines.join("\n") };
}

function openInBrowser(url: string): Promise<boolean> {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { detached: true, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

interface DoctorCheckResult {
  check_id: string;
  severity: "required" | "optional";
  status: "pass" | "fail" | "warn";
  message?: string;
  remediation: string | null;
  /** A fresh install has no DB yet; it is informational even in --strict. */
  blocking?: boolean;
}

async function checkNode(): Promise<DoctorCheckResult> {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  const minor = Number(version.split(".")[1]);
  if (Number.isInteger(major) && Number.isInteger(minor) && major === 22 && minor >= 14) {
    return { check_id: "node", severity: "required", status: "pass", remediation: null };
  }
  return {
    check_id: "node",
    severity: "required",
    status: "fail",
    message: cliText(`Node.js ${version}が検出されました。Node.js 22.14以上22系が必要です。`, `Found Node.js ${version}; version 22.14 or later in the 22.x series is required.`),
    remediation: cliText('Node.js 22.14〜22.xをインストールしてください（例: nvm install 22）。', 'Install Node.js 22.14 through 22.x (for example, nvm install 22).'),
  };
}

async function checkSqlite(): Promise<DoctorCheckResult> {
  const root = resolveOwlRoot();
  const dbPath = join(resolveDataDir(root), "owl.sqlite");
  try {
    await access(dbPath);
    return { check_id: "sqlite", severity: "required", status: "pass", remediation: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        check_id: "sqlite",
        severity: "required",
        status: "fail",
        message: cliText('sqlite databaseを確認できません。未初期化ではなく、data directoryのアクセスに失敗しました。', 'Could not access the SQLite database or data directory.'),
        remediation: cliText('OWL_DATA_DIRの所有者・permission・pathを確認してから `owl start` を実行してください。', 'Check the owner, permissions, and path of OWL_DATA_DIR before running owl start.'),
      };
    }
    return {
      check_id: "sqlite",
      severity: "optional",
      status: "warn",
      message: cliText('not_initialized: sqlite databaseはまだ初期化されていません。', 'not_initialized: The SQLite database has not been initialized.'),
      remediation: cliText('一度 `owl start` を実行してdatabaseを初期化してください。起動済みならOWL_DATA_DIRの権限を確認してください。', 'Run owl start once to initialize the database. If Owl is running, check OWL_DATA_DIR permissions.'),
      blocking: false,
    };
  }
}

function safeProviderCheckReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/eacces|eperm|permission denied/iu.test(raw)) return cliText('実行権限がありません。', 'Execution permission was denied.');
  if (/enoent|not found|no such file/iu.test(raw)) return cliText('実行ファイルが見つかりません。', 'The executable was not found.');
  const safe = raw
    .replace(/(bearer\s+|authorization\s*[:=]\s*|api[-_ ]?key\s*[:=]\s*|token\s*[:=]\s*|secret\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
    .slice(0, 300);
  return safe || cliText('実行ファイルの起動に失敗しました。', 'The executable could not be started.');
}

function runCommandVersion(command: string): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let child;
    try {
      child = spawn(command, ["--version"], { stdio: "ignore" });
    } catch (error) {
      resolvePromise({ ok: false, reason: safeProviderCheckReason(error) });
      return;
    }
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        resolvePromise({ ok: false, reason: safeProviderCheckReason(error) });
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        resolvePromise({ ok: code === 0, ...(code === 0 ? {} : { reason: cliText(`終了コード ${String(code ?? "不明")} が返りました。`, `Exited with code ${String(code ?? "unknown")}.`) }) });
      }
    });
  });
}

async function checkProvider(): Promise<DoctorCheckResult> {
  try {
    const root = resolveOwlRoot();
    const selection = providerSelection(root);
    if (selection.mode === "stub") {
      return {
        check_id: "provider",
        severity: "required",
        status: "pass",
        message: cliText('stub providerが選択されています。外部provider CLIは不要です。', 'The stub Provider is selected. No external Provider CLI is needed.'),
        remediation: null,
      };
    }
    const executable = await resolveExecutableForSelection(selection);
    const configError = providerConfigurationError(selection, executable);
    if (!configError) {
      const version = await runCommandVersion(executable!);
      if (version.ok) {
        return {
          check_id: "provider",
          severity: "required",
          status: "pass",
          message: `${selection.providerId}/${selection.adapter} provider executable is available.`,
          remediation: null,
        };
      }
      return {
        check_id: "provider",
        severity: "required",
        status: "fail",
        message: cliText(`${selection.providerId}/${selection.adapter}の実行ファイルを起動できませんでした。${version.reason ? `原因: ${version.reason}` : ""}`, `Could not start the ${selection.providerId}/${selection.adapter} executable.${version.reason ? ` Cause: ${version.reason}` : ""}`),
        remediation: cliText(`${selection.executableEnv}へ実行可能な絶対パスを設定するか、${selection.binaryName} --versionが成功する環境を用意してください。`, `Set ${selection.executableEnv} to an executable absolute path, or make ${selection.binaryName} --version work.`),
      };
    }
    return {
      check_id: "provider",
      severity: "required",
      status: "fail",
      message: configError,
      remediation: selection.mode === "real"
        ? cliText('OWL_PROVIDER=stubでoffline実行するか、OWL_PROVIDER_ADAPTERと対応するCLIを設定してください。provider CLIはOwlが自動インストールしません。', 'Use OWL_PROVIDER=stub for offline operation, or configure OWL_PROVIDER_ADAPTER and its CLI. Owl does not install Provider CLIs.')
        : cliText('OWL_PROVIDER=stubまたはrealを指定してください。', 'Set OWL_PROVIDER to stub or real.'),
    };
  } catch (error) {
    return {
      check_id: "provider",
      severity: "required",
      status: "fail",
      message: cliText(`provider設定を読み込めませんでした。原因: ${safeProviderCheckReason(error)}`, `Could not read Provider settings. Cause: ${safeProviderCheckReason(error)}`),
      remediation: cliText('OWL_PROVIDER=stubでoffline実行するか、OWL_PROVIDER_ADAPTERと対応するCLIを設定してください。', 'Use OWL_PROVIDER=stub for offline operation, or configure OWL_PROVIDER_ADAPTER and its CLI.'),
    };
  }
}

async function checkSecretStore(): Promise<DoctorCheckResult> {
  try {
    const root = resolveOwlRoot();
    const dataDir = resolveDataDir(root);
    const status = connectorConfigStatus(root, dataDir);
    if (!status.configured) {
      return { check_id: "secret-store", severity: "optional", status: "pass", message: cliText('connector設定は未設定です。', 'Connector settings have not been configured.'), remediation: null };
    }
    if (status.accessible) {
      return { check_id: "secret-store", severity: "optional", status: "pass", message: cliText('connector Tokenを.envから読み込めます。', 'Connector tokens can be read from .env.'), remediation: null };
    }
  } catch {
    // Fall through to the same safe warning without exposing parsing or secret details.
  }
  return {
    check_id: "secret-store",
    severity: "optional",
    status: "warn",
    message: cliText('connector Tokenを読み込めません。Owl本体は起動できます。', 'Could not read connector tokens. Owl itself can still start.'),
    remediation: cliText('SettingsでSlack/DiscordのTokenを再保存するか、.envに対応するTokenを設定してください。', 'Save Slack/Discord tokens again in Settings, or set them in .env.'),
    blocking: false,
  };
}

async function checkNetworkAuth(): Promise<DoctorCheckResult> {
  const bind = configuredBind();
  const error = serverExposureError(bind, tailscaleServeEnabled());
  if (!error) {
    return {
      check_id: "network-auth",
      severity: "required",
      status: "pass",
      message: tailscaleServeEnabled() ? cliText('Tailscale Serveと外部経路にはBearer tokenが必要です。', 'Tailscale Serve and external access require a Bearer token.') : "loopback-only access or a bearer token is configured.",
      remediation: null,
    };
  }
  return {
    check_id: "network-auth",
    severity: "required",
    status: "fail",
    message: error,
    remediation: cliText('ローカル限定ならOWL_BIND=127.0.0.1、外部公開なら長いランダムなOWL_API_TOKENを設定してください。', 'For local access, set OWL_BIND=127.0.0.1. For external access, set a long random OWL_API_TOKEN.'),
  };
}

async function checkEnvironment(): Promise<DoctorCheckResult> {
  const warnings = deprecatedConfigurationWarnings();
  return warnings.length === 0
    ? { check_id: "environment", severity: "required", status: "pass", remediation: null }
    : { check_id: "environment", severity: "optional", status: "warn", message: warnings.join(" "), remediation: cliText('OWL_HOSTを削除し、正式名OWL_BINDを使用してください。', 'Remove OWL_HOST and use OWL_BIND.'), blocking: false };
}

async function checkEnvFilePermissions(): Promise<DoctorCheckResult> {
  const envPath = join(resolveOwlRoot(), ".env");
  try {
    const mode = (await stat(envPath)).mode;
    if ((mode & 0o077) === 0) {
      return { check_id: "env-permissions", severity: "required", status: "pass", remediation: null };
    }
    return {
      check_id: "env-permissions",
      severity: "optional",
      status: "warn",
      message: cliText('.envのgroup/world permissionが広すぎます。secretを設定する場合はmode 600にしてください。', '.env is accessible to group or other users. Use mode 600 when it contains secrets.'),
      remediation: cliText('`chmod 600 .env`を実行してください。secretの値はdoctorに表示しません。', 'Run chmod 600 .env. Doctor does not display secret values.'),
      blocking: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { check_id: "env-permissions", severity: "required", status: "pass", message: cliText('.envはありません。process environmentを使用します。', '.env is absent. Process environment variables will be used.'), remediation: null };
    }
    return { check_id: "env-permissions", severity: "optional", status: "warn", message: cliText('.envのpermissionを確認できませんでした。', 'Could not check .env permissions.'), remediation: cliText('`.env`の所有者とmodeを確認してください。', 'Check the owner and mode of .env.'), blocking: false };
  }
}

function isPortAvailable(port: number, host: string): Promise<{ available: boolean; errorCode?: string }> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolvePromise({ available: false, errorCode: error.code });
    });
    server.once("listening", () => {
      server.close(() => resolvePromise({ available: true }));
    });
    try {
      server.listen(port, host);
    } catch {
      resolvePromise({ available: false, errorCode: "EPERM" });
    }
  });
}

interface TailscaleInfo {
  available: boolean;
  hostname?: string;
}

function runTailscaleCommand(args: string[], timeoutMs = 5_000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let stdout = "";
    let child;
    try {
      child = spawn("tailscale", args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolvePromise({ ok: false, stdout: "" });
      return;
    }
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill(); } catch { /* best-effort */ }
        resolvePromise({ ok: false, stdout: "" });
      }
    }, timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 64 * 1024) stdout = stdout.slice(0, 64 * 1024);
    });
    child.on("error", () => {
      if (!settled) { settled = true; clearTimeout(timer); resolvePromise({ ok: false, stdout: "" }); }
    });
    child.on("close", (code) => {
      if (!settled) { settled = true; clearTimeout(timer); resolvePromise({ ok: code === 0, stdout }); }
    });
  });
}

async function detectTailscale(): Promise<TailscaleInfo> {
  const result = await runTailscaleCommand(["status", "--json"]);
  if (!result.ok) return { available: false };
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const self = parsed.Self as Record<string, unknown> | undefined;
    const dnsName = typeof self?.DNSName === "string" ? self.DNSName : undefined;
    const hostname = dnsName ? dnsName.replace(/\.$/, "") : undefined;
    return { available: true, hostname };
  } catch {
    return { available: true };
  }
}

async function setupTailscaleServe(port: number): Promise<{ ok: boolean; url?: string }> {
  const info = await detectTailscale();
  if (!info.available) return { ok: false };
  const base = `http://127.0.0.1:${port}`;
  const owlResult = await runTailscaleCommand(["serve", "--bg", "--set-path", "/owl", `${base}/owl`]);
  if (!owlResult.ok) return { ok: false };
  await runTailscaleCommand(["serve", "--bg", "--set-path", "/api", `${base}/api`]);
  const url = info.hostname ? `https://${info.hostname}/owl/` : undefined;
  return { ok: true, url };
}

async function removeTailscaleServe(): Promise<void> {
  await Promise.allSettled([
    runTailscaleCommand(["serve", "--set-path", "/owl", "off"]),
    runTailscaleCommand(["serve", "--set-path", "/api", "off"]),
  ]);
}

async function checkPort(): Promise<DoctorCheckResult> {
  let port: number;
  try {
    port = configuredPort() ? parsePort(configuredPort()!) : 3787;
  } catch (error) {
    return { check_id: "port", severity: "required", status: "fail", message: error instanceof Error ? error.message : cliText('OWL_PORTが不正です。', 'OWL_PORT is invalid.'), remediation: cliText('OWL_PORTを1〜65535の整数に設定してください。', 'Set OWL_PORT to an integer from 1 to 65535.') };
  }
  const bind = configuredBind();
  const availability = await isPortAvailable(port, bind);
  if (availability.available) {
    return { check_id: "port", severity: "required", status: "pass", remediation: null };
  }
  if (availability.errorCode === "EPERM" || availability.errorCode === "EACCES") {
    return {
      check_id: "port",
      severity: "optional",
      status: "warn",
      message: cliText(`port ${port} のlisten probeが権限で拒否されました。実際の起動時に再確認してください。`, `Permission denied while probing port ${port}. Check again when starting the server.`),
      remediation: cliText('sandboxやOS policyがlistenを制限していないか確認してから `owl start` を実行してください。', 'Check whether the sandbox or OS restricts listening before running owl start.'),
      blocking: false,
    };
  }
  const state = await readState().catch(() => null);
  if (state && state.port === port && isAlive(state.pid)) {
    return { check_id: "port", severity: "required", status: "pass", remediation: null };
  }
  return {
    check_id: "port",
    severity: "required",
    status: "fail",
    message: cliText(`port ${port} はowl-core以外のプロセスで使用中です。`, `Port ${port} is used by another process.`),
    remediation: cliText(`port ${port} を使用しているプロセスを停止するか、OWL_PORTで別のportを指定してください。`, `Stop the process using port ${port}, or select another port with OWL_PORT.`),
  };
}

async function checkTailscale(): Promise<DoctorCheckResult> {
  if (!tailscaleServeEnabled()) {
    return { check_id: "tailscale", severity: "optional", status: "pass", message: cliText('Tailscale Serveはopt-inのため未要求です。', 'Tailscale Serve was not requested.'), remediation: null };
  }
  const info = await detectTailscale();
  if (info.available) {
    return { check_id: "tailscale", severity: "required", status: "pass", remediation: null };
  }
  return {
    check_id: "tailscale",
    severity: "required",
    status: "fail",
    message: cliText('OWL_TAILSCALE_SERVE=1ですがTailscaleが検出されませんでした。', 'OWL_TAILSCALE_SERVE=1 is set, but Tailscale was not found.'),
    remediation: cliText('Tailscaleをインストールしてログインするか、OWL_TAILSCALE_SERVEを削除してローカル起動してください。', 'Install Tailscale and sign in, or remove OWL_TAILSCALE_SERVE to start locally.'),
  };
}

function parseDoctorArgs(argv: readonly string[]): { json: boolean; strict: boolean } {
  let json = false;
  let strict = false;
  for (const argument of argv) {
    if (argument === "--json") json = true;
    else if (argument === "--strict") strict = true;
    else throw new CliError(2, cliText(`doctorのargvが契約と一致しません: ${argument}`, `Invalid doctor arguments: ${argument}`));
  }
  return { json, strict };
}

export async function runDoctor(args: { json: boolean; strict: boolean }): Promise<{ exitCode: number; output: string }> {
  const checks = await Promise.all([
    checkNode(),
    checkEnvironment(),
    checkEnvFilePermissions(),
    checkNetworkAuth(),
    checkProvider(),
    checkSecretStore(),
    checkSqlite(),
    checkPort(),
    checkTailscale(),
  ]);
  const hasRequiredFailure = checks.some((check) => check.severity === "required" && check.status !== "pass");
  const hasOptionalIssue = checks.some((check) => check.severity === "optional" && check.status !== "pass" && check.blocking !== false);
  let status: "ok" | "warning" | "error";
  let exitCode: number;
  if (hasRequiredFailure || (args.strict && hasOptionalIssue)) {
    status = "error";
    exitCode = 3;
  } else if (hasOptionalIssue) {
    status = "warning";
    exitCode = 1;
  } else {
    status = "ok";
    exitCode = 0;
  }
  const payload = {
    checks: checks.map((check) => ({
      check_id: check.check_id,
      severity: check.severity,
      status: check.status,
      ...(check.message ? { message: check.message } : {}),
      remediation: check.remediation,
    })),
    status,
  };
  if (args.json) {
    return { exitCode, output: JSON.stringify(payload) };
  }
  const lines = [cliText("項目\t重要度\t状態\t対処方法", "CHECK\tSEVERITY\tSTATUS\tREMEDIATION")];
  for (const check of checks) {
    lines.push(`${check.check_id}\t${check.severity}\t${check.status}\t${check.remediation ?? "-"}`);
  }
  lines.push(cliText(`全体: ${status}`, `overall: ${status}`));
  return { exitCode, output: lines.join("\n") };
}

const HUMAN_MESSAGES: Record<string, { ja: string; en: string }> = {
  start: { ja: "Owlを起動しました。", en: "Owl started." },
  stop: { ja: "Owlを停止しました。", en: "Owl stopped." },
  restart: { ja: "Owlを再起動しました。", en: "Owl restarted." },
  cleanup: { ja: "クリーンアップが完了しました。", en: "Cleanup complete." },
  serve: { ja: "Serveを更新しました。", en: "Serve updated." },
  advisor: { ja: "Advisorセッションを終了しました。", en: "Advisor session ended." },
};

const HELP_TEXT = `Owl-Agent v1 CLI

Usage:
  owl start [--foreground] [--bind HOST] [--port PORT]
  owl stop [--force] [--timeout SECONDS]
  owl restart [--bind HOST] [--port PORT]
  owl open
  owl status [--json]
  owl doctor [--json] [--strict]
  owl serve [--off]
  owl setup

Configuration:
  OWL_BIND=127.0.0.1    loopback-only default (OWL_HOST is not supported)
  OWL_PORT=3787         local HTTP port
  OWL_API_TOKEN=...     required for non-loopback bind or Tailscale Serve
  OWL_PROVIDER=stub     offline provider; real requires the selected CLI
  OWL_PROVIDER_ADAPTER=claude-cli/v1|codex-cli/v1
  OWL_TAILSCALE_SERVE=1 opt-in remote Serve setup
  OWL_DATA_DIR=./data   common DB/log/settings/secret data root
  OWL_LANG=ja|en        CLI and setup display language

The project .env is loaded automatically. Explicit process environment values win.
Provider CLIs and Tailscale are never installed automatically.`;

const HELP_TEXT_JA = `Owl-Agent v1 CLI

使い方:
  owl start [--foreground] [--bind HOST] [--port PORT]
  owl stop [--force] [--timeout SECONDS]
  owl restart [--bind HOST] [--port PORT]
  owl open
  owl status [--json]
  owl doctor [--json] [--strict]
  owl serve [--off]
  owl setup

設定:
  OWL_BIND=127.0.0.1    ローカル接続のデフォルト（OWL_HOSTは非対応）
  OWL_PORT=3787         ローカルHTTPポート
  OWL_API_TOKEN=...     外部接続またはTailscale Serveに必要
  OWL_PROVIDER=stub     オフラインProvider。realには選択したCLIが必要
  OWL_PROVIDER_ADAPTER=claude-cli/v1|codex-cli/v1
  OWL_TAILSCALE_SERVE=1 リモートServeの設定を有効化
  OWL_DATA_DIR=./data   DB・ログ・設定・secretの共通保存先
  OWL_LANG=ja|en        CLIとセットアップの表示言語

.envは自動で読み込まれます。プロセス環境変数が優先されます。
Provider CLIとTailscaleは自動インストールされません。`;

function writeStdout(value: Record<string, unknown>): void {
  if (typeof value.table === "string") {
    process.stdout.write(`${value.table}\n`);
    return;
  }
  const cmd = typeof value.command === "string" ? value.command : "";
  const human = HUMAN_MESSAGES[cmd];
  if (human) {
    process.stdout.write(`${cliText(human.ja, human.en)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  const warnings = deprecatedConfigurationWarnings();
  for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${cliText(HELP_TEXT_JA, HELP_TEXT)}\n`);
    return;
  }
  if (!command) {
    throw new CliError(
      2,
      cliText('コマンドを指定してください。--helpで使い方を表示できます。owl start|open|status|stop|restart|cleanup|doctor|serve|setup|advisorを使用してください。', 'Specify a command. Run --help for usage. Available commands: start, open, status, stop, restart, cleanup, doctor, serve, setup, advisor.'),
    );
  }
  if (command === "doctor") {
    const { exitCode, output } = await runDoctor(parseDoctorArgs(rest));
    process.stdout.write(`${output}\n`);
    process.exitCode = exitCode;
    return;
  }
  let result: Record<string, unknown>;
  if (command === "start") {
    result = await runStart(parseStartArgs(rest, true));
  } else if (command === "status") {
    result = await runStatus(parseStatusArgs(rest));
  } else if (command === "stop") {
    result = await runStop(parseStopArgs(rest));
  } else if (command === "restart") {
    result = await runRestart(parseStartArgs(rest, false));
  } else if (command === "cleanup") {
    result = await runCleanup();
  } else if (command === "serve") {
    result = await runServe(rest);
  } else if (command === "open") {
    result = await runOpen(rest);
  } else if (command === "setup") {
    const { runSetup } = await import("./setup.js");
    result = await runSetup();
  } else if (command === "advisor") {
    result = await runAdvisor(parseAdvisorArgs(rest));
  } else {
    throw new CliError(2, cliText(`未知のowl commandです: ${command}`, `Unknown Owl command: ${command}`));
  }
  writeStdout(result);
}

export async function main(): Promise<void> {
  try {
    await runCli();
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
   }
   const referenceId = newReferenceId();
    await recordCliFailure(referenceId, error);
   process.stderr.write(cliText('owl commandを完了できませんでした。ログの参照IDを確認してください。\n', 'Could not complete the Owl command. Check the logs using the reference ID.\n'));
   process.exitCode = 8;
  }
}

if (process.argv[1]?.endsWith("/cli.js")) {
  void main();
}
