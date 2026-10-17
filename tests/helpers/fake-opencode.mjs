import { chmod, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";

/**
 * A fake opencode v2 executable. It answers `--version` and `serve --stdio --port 0`, speaks the
 * `/api/` endpoints and SSE events the real 2.x serve does, and acts as an MCP client for the
 * servers named in OPENCODE_CONFIG_CONTENT. Knobs, all optional, all env:
 *   FAKE_OPENCODE_VERSION         output of --version and /api/info
 *   FAKE_OPENCODE_SCENARIO        JSON array of {op, ...} steps run after each prompt (see runStep; `emit` data defaults sessionID to the prompted session)
 *   FAKE_OPENCODE_LOG             JSONL file: start env, requests, MCP starts and tool lists
 *   FAKE_OPENCODE_HEARTBEAT_MS    heartbeat interval; 0 sends none
 *   FAKE_OPENCODE_PLUGINS         JSON array for /api/plugin
 *   FAKE_OPENCODE_MODELS          JSON array for /api/model
 *   FAKE_OPENCODE_CONNECTIONS     number of connections the integration reports
 *   FAKE_OPENCODE_SESSIONS        JSON array of sessions that already exist ({id, projectID, agent, model, location})
 *   FAKE_OPENCODE_SAVED           JSON array for /api/permission/saved
 *   FAKE_OPENCODE_HANG_PATH       requests whose path ends with it are never answered (e.g. /api/model)
 *   FAKE_OPENCODE_HANG_INTERRUPT  any value: POST .../interrupt is never answered
 *   FAKE_OPENCODE_MESSAGE_PAGE_SIZE  GET .../message returns at most this many messages and cursor.next for the rest
 *   FAKE_OPENCODE_MCP_TOOL_TIMEOUT_MS  tools/call limit when the config has no timeout.execution
 * The serve password is checked, then removed from the process env, and only its presence is logged.
 */
const FAKE_OPENCODE_SOURCE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const version = process.env.FAKE_OPENCODE_VERSION ?? "2.0.30";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write(version + "\n");
  process.exit(0);
}
if (args[0] !== "serve" || !args.includes("--stdio") || args[args.indexOf("--port") + 1] !== "0") {
  process.stderr.write("fake opencode: unsupported arguments " + JSON.stringify(args) + "\n");
  process.exit(2);
}

const logPath = process.env.FAKE_OPENCODE_LOG;
const log = (entry) => { if (logPath) fs.appendFileSync(logPath, JSON.stringify(entry) + "\n"); };
const configText = process.env.OPENCODE_CONFIG_CONTENT ?? "{}";
const config = JSON.parse(configText);
const password = process.env.OPENCODE_PASSWORD;
const SCRUBBED = ["OPENCODE_CONFIG", "OPENCODE_CLI_CONFIG_CONTENT", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_TEST_HOME", "OPENCODE_SERVER_PASSWORD"];
log({
  type: "start",
  argv: args,
  cwd: process.cwd(),
  env: {
    OPENCODE_CONFIG_CONTENT: configText,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR ?? null,
    OPENCODE_CONFIG_PROJECT_DISABLE: process.env.OPENCODE_CONFIG_PROJECT_DISABLE ?? null,
    OPENCODE_DISABLE_CLAUDE_CODE: process.env.OPENCODE_DISABLE_CLAUDE_CODE ?? null,
    OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? null,
    password_present: typeof password === "string" && password.length > 0,
    scrubbed_present: Object.fromEntries(SCRUBBED.map((name) => [name, name in process.env])),
  },
});
delete process.env.OPENCODE_PASSWORD;
const expectedAuth = "Basic " + Buffer.from("opencode:" + password).toString("base64");

const json = (name, fallback) => (process.env[name] ? JSON.parse(process.env[name]) : fallback);
const scenario = json("FAKE_OPENCODE_SCENARIO", []);
const heartbeatMs = Number(process.env.FAKE_OPENCODE_HEARTBEAT_MS ?? 15000);
const zeroTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

// ---- state ----
let counter = 0;
const nextId = (prefix) => prefix + "_" + String(++counter).padStart(4, "0");
const subscribers = new Set();
const sessions = new Map(json("FAKE_OPENCODE_SESSIONS", []).map((saved) => [saved.id, { messages: [], permissions: [], ...saved }]));
const pendingPermissions = new Map();
let interruptWaiters = [];
let interrupted = false;
const mcp = new Map();

function emit(type, data) {
  const line = "data: " + JSON.stringify({ id: nextId("evt"), type, data }) + "\n\n";
  for (const response of subscribers) response.write(line);
}

// ---- MCP client ----
function startMcpServer(name, spec) {
  const entry = { name, status: { status: "starting" }, pending: new Map(), nextRpc: 1, tools: [], child: null };
  mcp.set(name, entry);
  const catalogMs = spec.timeout?.catalog ?? 20000;
  entry.executionMs = spec.timeout?.execution ?? Number(process.env.FAKE_OPENCODE_MCP_TOOL_TIMEOUT_MS ?? 30000);
  log({ type: "mcp.start", server: name, command: spec.command[0], args: spec.command.slice(1), environment: spec.environment ?? {} });
  entry.ready = new Promise((resolve) => {
    const fail = (error) => {
      if (entry.status.status === "failed") return;
      entry.status = { status: "failed", error: String(error) };
      resolve();
    };
    const child = spawn(spec.command[0], spec.command.slice(1), {
      env: { PATH: process.env.PATH ?? "", ...(spec.environment ?? {}) },
      stdio: ["pipe", "pipe", "ignore"],
    });
    entry.child = child;
    child.on("error", fail);
    child.on("exit", (code) => fail("exited " + code));
    child.stdin.on("error", () => {});
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const waiter = entry.pending.get(message.id);
      if (waiter) { entry.pending.delete(message.id); waiter(message); }
    });
    (async () => {
      await rpc(entry, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-opencode", version } }, catalogMs);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const listed = await rpc(entry, "tools/list", {}, catalogMs);
      entry.tools = (listed.result?.tools ?? []).map((tool) => tool.name);
      log({ type: "mcp.tools", server: name, tools: entry.tools });
      entry.status = { status: "connected" };
      resolve();
    })().catch(fail);
  });
}

function rpc(entry, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = entry.nextRpc++;
    const timer = setTimeout(() => { entry.pending.delete(id); reject(new Error(method + " timed out")); }, timeoutMs);
    entry.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    entry.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

for (const [name, spec] of Object.entries(config.mcp?.servers ?? {})) {
  if (spec.type === "local" && !spec.disabled) startMcpServer(name, spec);
}
const mcpReady = () => Promise.all([...mcp.values()].map((entry) => entry.ready));

// ---- scenario ----
function newMessage(session, type, content, tokens) {
  const message = { id: nextId("msg"), type, content, ...(tokens ? { tokens } : {}) };
  session.messages.push(message);
  return message;
}

async function askPermission(session, step, assistantMessageID, callID) {
  const id = nextId("per");
  emit("session.tool.input.started", { sessionID: session.id, assistantMessageID, id: callID, name: step.name });
  emit("session.tool.called", { sessionID: session.id, assistantMessageID, id: callID, input: step.input ?? {}, executed: false });
  if (step.ask === false) return { decision: "once" };
  const reply = new Promise((resolve) => pendingPermissions.set(id, resolve));
  emit("permission.asked", {
    id, sessionID: session.id, action: step.action ?? step.name, resources: step.resources ?? ["*"], save: false,
    source: { type: "tool", messageID: assistantMessageID, id: callID },
  });
  return reply;
}

async function runTool(session, state, step, execute) {
  const callID = nextId("call");
  const reply = await askPermission(session, step, state.assistantMessageID, callID);
  const base = { sessionID: session.id, assistantMessageID: state.assistantMessageID, id: callID };
  if (reply.decision !== "once") {
    emit("session.tool.failed", { ...base, error: { type: "permission.rejected", message: reply.message ?? "rejected" } });
    return { ok: false, text: reply.message ?? "rejected" };
  }
  const result = await execute();
  if (result.isError) emit("session.tool.failed", { ...base, error: { type: "tool.error", message: result.text } });
  else emit("session.tool.success", { ...base, content: [{ type: "text", text: result.text }] });
  return { ok: !result.isError, text: result.text };
}

function startStep(session, state) {
  if (state.assistantMessageID) return;
  state.assistantMessageID = nextId("msg");
  state.text = "";
  emit("session.step.started", { sessionID: session.id, assistantMessageID: state.assistantMessageID });
}

function endStep(session, state, tokens) {
  if (!state.assistantMessageID) startStep(session, state);
  const t = tokens ?? zeroTokens;
  session.messages.push({ id: state.assistantMessageID, type: "assistant", content: state.text ? [{ type: "text", text: state.text }] : [], tokens: t });
  emit("session.step.ended", { sessionID: session.id, assistantMessageID: state.assistantMessageID, tokens: t });
  state.assistantMessageID = null;
}

function emitText(session, state, chunks) {
  startStep(session, state);
  const base = { sessionID: session.id, assistantMessageID: state.assistantMessageID };
  emit("session.text.started", base);
  for (const chunk of chunks) {
    state.text += chunk;
    emit("session.text.delta", { ...base, delta: chunk });
  }
  emit("session.text.ended", { ...base, text: state.text });
}

async function runStep(session, state, step) {
  const sid = session.id;
  switch (step.op) {
    case "text": emitText(session, state, step.chunks ?? []); return true;
    case "tool":
      startStep(session, state);
      await runTool(session, state, step, async () => ({ text: step.output ?? "ok" }));
      return true;
    case "step_end": endStep(session, state, step.tokens); return true;
    case "retry": emit("session.retry.scheduled", { sessionID: sid, attempt: step.attempt, at: step.at, error: step.error }); return true;
    case "step_fail": emit("session.step.failed", { sessionID: sid, error: step.error }); return true;
    case "succeed":
      if (state.assistantMessageID) endStep(session, state);
      emit("session.execution.succeeded", { sessionID: sid });
      return true;
    case "fail": emit("session.execution.failed", { sessionID: sid, error: step.error }); return true;
    case "wait_interrupt":
      if (!interrupted) await new Promise((resolve) => interruptWaiters.push(resolve));
      emit("session.step.failed", { sessionID: sid, error: { type: "aborted", message: "aborted" } });
      emit("session.execution.interrupted", { sessionID: sid });
      return false;
    case "emit": emit(step.type, { sessionID: sid, ...(step.data ?? {}) }); return true;
    case "stderr": process.stderr.write(String(step.text) + "\n"); return true;
    case "exit": process.exit(step.code ?? 0); return false;
    case "call_mcp_tool": {
      const entry = mcp.get(step.server);
      await mcpReady();
      startStep(session, state);
      const name = step.server + "_" + step.tool;
      const outcome = await runTool(session, state, { name, action: name, resources: ["*"], input: step.arguments ?? {} }, async () => {
        try {
          const reply = await rpc(entry, "tools/call", { name: step.tool, arguments: step.arguments ?? {} }, entry.executionMs);
          const text = (reply.result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
          return { text: reply.error ? String(reply.error.message) : text, isError: Boolean(reply.error) || reply.result?.isError === true };
        } catch (error) {
          return { text: String(error.message), isError: true };
        }
      });
      emitText(session, state, [outcome.text]);
      endStep(session, state, step.tokens);
      emit("session.execution.succeeded", { sessionID: sid });
      return true;
    }
    default: throw new Error("unknown scenario step " + step.op);
  }
}

async function runScenario(session) {
  const state = { assistantMessageID: null, text: "" };
  for (const step of scenario) {
    if (!(await runStep(session, state, step))) return;
  }
}

// ---- HTTP ----
const readBody = (request) => new Promise((resolve) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    try { resolve(text ? JSON.parse(text) : undefined); } catch { resolve(text); }
  });
});

function providerList() {
  const overrides = config.providers ?? {};
  const ids = new Set(["fake-provider", ...Object.keys(overrides)]);
  return [...ids].map((id) => ({ id, integrationID: "fake-integration", name: id, package: "fake", settings: { ...(overrides[id]?.settings?.baseURL ? { baseURL: overrides[id].settings.baseURL } : {}) } }));
}

function models() {
  return json("FAKE_OPENCODE_MODELS", providerList().map((provider) => ({
    providerID: provider.id, modelID: "fake-model", name: "fake", variants: [{ id: "high" }], status: "active", enabled: true, limit: { context: 1000, output: 100 },
  })));
}

function sessionBody(session) {
  return { id: session.id, projectID: session.projectID, agent: session.agent, model: session.model, location: session.location, permissions: session.permissions };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const body = request.method === "POST" ? await readBody(request) : undefined;
  if (request.headers.authorization !== expectedAuth) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  log({ type: "request", method: request.method, path: url.pathname + url.search, body: body ?? null });
  // Requests whose path ends with FAKE_OPENCODE_HANG_PATH (and interrupts when FAKE_OPENCODE_HANG_INTERRUPT is set) are read and never answered.
  if ((process.env.FAKE_OPENCODE_HANG_PATH && url.pathname.endsWith(process.env.FAKE_OPENCODE_HANG_PATH)) || (process.env.FAKE_OPENCODE_HANG_INTERRUPT && url.pathname.endsWith("/interrupt"))) return;
  const reply = (status, payload) => {
    response.writeHead(status, payload === undefined ? {} : { "content-type": "application/json" });
    response.end(payload === undefined ? undefined : JSON.stringify(payload));
  };
  const path = url.pathname;
  const sessionMatch = /^\/api\/session\/([^/]+)(?:\/(.*))?$/u.exec(path);
  const session = sessionMatch ? sessions.get(sessionMatch[1]) : undefined;
  const sub = sessionMatch?.[2];

  if (path === "/api/event" && request.method === "GET") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    subscribers.add(response);
    request.on("close", () => subscribers.delete(response));
    emit("server.connected", {});
    return;
  }
  if (path === "/api/info") return reply(200, { version, pid: process.pid, urls: [], paths: {}, capabilities: {} });
  if (path === "/api/plugin") return reply(200, { data: json("FAKE_OPENCODE_PLUGINS", [{ id: "builtin-core", source: { type: "builtin" }, features: [], state: "active" }]) });
  if (path === "/api/provider") return reply(200, { data: providerList() });
  if (path === "/api/integration") {
    const count = Number(process.env.FAKE_OPENCODE_CONNECTIONS ?? 1);
    return reply(200, { data: [{ id: "fake-integration", name: "fake", methods: [], connections: Array.from({ length: count }, (_, i) => ({ id: "conn" + i })) }] });
  }
  if (path === "/api/model") return reply(200, { data: models() });
  if (path === "/api/permission/saved") return reply(200, { data: json("FAKE_OPENCODE_SAVED", []) });
  if (path === "/api/config") return reply(200, { data: [{ path: "fake-config" }] });
  if (path === "/api/mcp") {
    await mcpReady();
    return reply(200, { data: [...mcp.values()].map((entry) => ({ name: entry.name, status: entry.status })) });
  }
  if (path === "/api/session" && request.method === "POST") {
    const created = { id: nextId("ses"), projectID: "proj_1", agent: body.agent, model: body.model, location: body.location, permissions: body.permissions ?? [], messages: [] };
    sessions.set(created.id, created);
    return reply(200, { data: sessionBody(created) });
  }
  if (session && !sub && request.method === "GET") return reply(200, { data: sessionBody(session) });
  if (session && sub === "model" && request.method === "POST") {
    session.model = body.model;
    return reply(200, { data: sessionBody(session) });
  }
  if (session && sub === "prompt" && request.method === "POST") {
    const message = newMessage(session, "user", [{ type: "text", text: body.text }]);
    interrupted = false;
    reply(200, { data: { id: message.id } });
    setImmediate(() => runScenario(session).catch((error) => process.stderr.write(String(error.stack) + "\n")));
    return;
  }
  if (session && sub === "message" && request.method === "GET") {
    let list = [...session.messages].reverse();
    const cursor = url.searchParams.get("cursor");
    if (cursor) list = list.slice(list.findIndex((message) => message.id === cursor) + 1);
    const pageSize = Number(process.env.FAKE_OPENCODE_MESSAGE_PAGE_SIZE ?? 0);
    if (pageSize > 0 && list.length > pageSize) {
      list = list.slice(0, pageSize);
      return reply(200, { data: list, cursor: { next: list.at(-1).id } });
    }
    return reply(200, { data: list, cursor: {} });
  }
  const one = sub ? /^message\/(.+)$/u.exec(sub) : null;
  if (session && one) {
    const found = session.messages.find((message) => message.id === one[1]);
    return found ? reply(200, { data: found }) : reply(404, { error: "not found" });
  }
  if (session && sub === "interrupt" && request.method === "POST") {
    interrupted = true;
    for (const resolve of interruptWaiters.splice(0)) resolve();
    return reply(200, { interrupted: true });
  }
  const permissionReply = sub ? /^permission\/([^/]+)\/reply$/u.exec(sub) : null;
  if (session && permissionReply && request.method === "POST") {
    const resolve = pendingPermissions.get(permissionReply[1]);
    if (!resolve) return reply(404, { error: "no such permission request" });
    pendingPermissions.delete(permissionReply[1]);
    // The shape real opencode emits once a request is answered.
    emit("permission.replied", { sessionID: session.id, requestID: permissionReply[1], reply: body.decision === "once" ? "once" : "reject" });
    resolve(body);
    return reply(204);
  }
  reply(404, { error: "not found" });
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ url: "http://127.0.0.1:" + server.address().port }) + "\n");
  if (heartbeatMs > 0) setInterval(() => { for (const response of subscribers) response.write(": heartbeat\n\n"); }, heartbeatMs).unref();
});

function shutdown() {
  for (const entry of mcp.values()) entry.child?.kill();
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.resume();
`;

/** Writes the fake opencode executable into `dir` and returns its path. */
export async function writeFakeOpencode(dir, name = "opencode") {
  const path = join(dir, name);
  await writeFile(path, FAKE_OPENCODE_SOURCE, "utf8");
  await chmod(path, 0o755);
  return path;
}

/** Parsed JSONL log written by the fake (FAKE_OPENCODE_LOG). */
export async function readFakeOpencodeLog(path) {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

/**
 * Fake Owl API for hooks and Owl's MCP servers, on 127.0.0.1:0. Returns null when listening is not permitted.
 *   guard(payload) -> { allowed, message? }   decides /api/v1/guard/check (default: allow)
 *   marker                                   text placed in the body of every other answer
 *   tokenFile                                when set, its content is read at request time and recorded as `token_file_content`
 * `requests` records method, path, body and the authorization / x-owl-role / x-owl-agent-run-id headers.
 */
export async function startFakeOwlApi(t, { guard = () => ({ allowed: true }), marker = "fake-owl-api-marker", tokenFile } = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    const path = request.url ?? "";
    requests.push({
      method: request.method,
      path,
      body,
      authorization: request.headers.authorization ?? null,
      role: request.headers["x-owl-role"] ?? null,
      agent_run_id: request.headers["x-owl-agent-run-id"] ?? null,
      token_file_content: tokenFile ? await readFile(tokenFile, "utf8").catch(() => null) : null,
    });
    let payload;
    if (path === "/api/v1/guard/check") {
      const decision = guard(body?.payload ?? {});
      payload = { data: { allowed: decision.allowed, ...(decision.message === undefined ? {} : { message: decision.message }) } };
    } else if (path === "/api/v1/memory/mode") {
      payload = { data: { mode: "pages" } };
    } else {
      payload = { data: { marker } };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") return null;
    throw error;
  }
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests, marker };
}

