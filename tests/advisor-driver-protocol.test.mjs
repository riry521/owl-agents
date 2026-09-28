// Advisor session driver protocol behavior: Codex app-server handshake,
// resume, server requests and reply selection, and Claude stream-json turns
// and start arguments. The drivers are exercised against fake harness
// executables written to a temp dir; no real Codex or Claude process is started.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AdvisorSessionDriver, CodexSessionDriver } from "../packages/agent-runtime/dist/index.js";
import { unwrapCodexCliResult } from "../packages/agent-runtime/dist/protocol.js";
import { isProviderResumeUnsupportedError } from "../packages/shared/dist/index.js";

const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

async function writeExecutable(root, name, source) {
  const path = join(root, name);
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
  return path;
}

async function readLog(path) {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

/** Collect events until `until(event)` is true (or the stream ends). */
async function collectEvents(driver, until) {
  const events = [];
  for await (const event of driver.events()) {
    events.push(event);
    if (until(event)) break;
  }
  return events;
}

// A strict fake `codex app-server`: rejects every request with -32600 until
// it has seen the `initialize` request AND the `initialized` notification,
// like codex-cli 0.155.1. Every message it receives is appended to FAKE_LOG.
const FAKE_CODEX_APP_SERVER = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const log = process.env.FAKE_LOG;
const scenario = process.env.FAKE_TURN ?? "items";
if (process.env.FAKE_START_LOG) fs.writeFileSync(process.env.FAKE_START_LOG, JSON.stringify({ args: process.argv.slice(2), codexHome: process.env.CODEX_HOME ?? null }));
let initializeAnswered = false;
let initialized = false;
let pendingTurn = null;
const responses = new Map();
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const delta = (threadId, itemId, text) =>
  send({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn-c1", itemId, delta: text } });
const agentMessage = (id, text, phase) => ({ type: "agentMessage", id, text, ...(phase === undefined ? {} : { phase }) });
const itemCompleted = (threadId, item) =>
  send({ method: "item/completed", params: { threadId, turnId: "turn-c1", item, completedAtMs: 0 } });
const turnCompleted = (threadId, items) =>
  send({ method: "turn/completed", params: { threadId, turn: { id: "turn-c1", status: "completed", items, itemsView: items.length === 0 ? "notLoaded" : "full", error: null } } });
function finishTurn(threadId, items) {
  delta(threadId, "i1", "hel");
  delta(threadId, "i1", "lo");
  turnCompleted(threadId, items);
}
// i1 is commentary ("thinking..."), i2 the final answer ("hello").
const commentary = agentMessage("i1", "thinking...", "commentary");
const finalAnswer = agentMessage("i2", "hello", "final_answer");
function phasedTurn(threadId) {
  if (scenario === "delta-missing-item-id") {
    send({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn-c1", delta: "hello" } });
    return;
  }
  if (scenario === "legacy-multi") {
    delta(threadId, "i1", "draft");
    delta(threadId, "i2", "hello");
    turnCompleted(threadId, [agentMessage("i1", "draft", null), agentMessage("i2", "hello", null)]);
    return;
  }
  delta(threadId, "i1", "thinking...");
  if (scenario === "commentary-only") {
    itemCompleted(threadId, commentary);
    turnCompleted(threadId, [commentary]);
    return;
  }
  delta(threadId, "i2", "hel");
  delta(threadId, "i2", "lo");
  if (scenario === "phased") {
    itemCompleted(threadId, commentary);
    itemCompleted(threadId, { type: "reasoning", id: "r1", summary: [], content: [] });
    itemCompleted(threadId, finalAnswer);
    // A late delta after the item settled is already part of it.
    delta(threadId, "i2", "lo");
    turnCompleted(threadId, [commentary, finalAnswer]);
  } else if (scenario === "phased-items-only") {
    turnCompleted(threadId, [commentary, finalAnswer]);
  } else {
    turnCompleted(threadId, []);
  }
}
const PHASED = new Set(["phased", "phased-items-only", "phased-delta-only", "commentary-only", "legacy-multi", "delta-missing-item-id"]);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(log, JSON.stringify(message) + "\\n");
  if (message.method === undefined && message.id !== undefined) {
    responses.set(message.id, message);
    if (pendingTurn && responses.has(9) && responses.has("approval-1")) {
      finishTurn(pendingTurn, [{ type: "agentMessage", id: "i1", text: "hello" }]);
      pendingTurn = null;
    }
    return;
  }
  if (message.method === "initialize") {
    initializeAnswered = true;
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.id === undefined) {
    if (message.method === "initialized" && initializeAnswered) initialized = true;
    return;
  }
  if (!initialized) {
    send({ id: message.id, error: { code: -32600, message: "Not initialized" } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-fresh" } } });
    return;
  }
  if (message.method === "thread/resume") {
    const hasOverrides = "sandbox" in message.params || "developerInstructions" in message.params;
    if (process.env.FAKE_REJECT_RESUME_OVERRIDES === "1" && hasOverrides) {
      send({ id: message.id, error: { code: -32602, message: "Invalid params" } });
      return;
    }
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }
  if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    send({ id: message.id, result: { turn: { id: "turn-c1", status: "inProgress", items: [] } } });
    if (scenario === "server-request") {
      pendingTurn = threadId;
      send({ id: 9, method: "x/y", params: {} });
      send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId, turnId: "turn-c1", itemId: "cmd-1" } });
      return;
    }
    if (PHASED.has(scenario)) {
      phasedTurn(threadId);
      return;
    }
    finishTurn(threadId, scenario === "delta-only" ? [] : [{ type: "agentMessage", id: "i1", text: "hello" }]);
    return;
  }
  send({ id: message.id, error: { code: -32601, message: "unknown method" } });
});
`;

async function createCodexDriver(t, { env = {}, providerSessionId } = {}) {
  const root = await mkdtemp(join(tmpdir(), "owl-codex-protocol-"));
  const executable = await writeExecutable(root, "fake-codex", FAKE_CODEX_APP_SERVER);
  const log = join(root, "received.jsonl");
  const startLog = join(root, "start.json");
  const requestEnv = {
    ...baseEnv,
    FAKE_LOG: log,
    FAKE_START_LOG: startLog,
    CODEX_HOME: env.CODEX_HOME ?? join(root, "user-codex-home"),
    ...env,
  };
  const driver = await CodexSessionDriver.create({
    adapter: "codex",
    role: "advisor",
    model: "gpt-test",
    cwd: root,
    env: requestEnv,
    system_prompt: "advisor system prompt",
    ...(providerSessionId ? { provider_session_id: providerSessionId } : {}),
  }, executable);
  t.after(() => driver.stop("test", 1000));
  return { driver, log, startLog, requestEnv };
}

async function assertCodexAppServerExclusions(startLog, requestEnv) {
  const { args, codexHome } = JSON.parse(await readFile(startLog, "utf8"));
  const configs = args.flatMap((arg, index) => arg === "--config" ? [args[index + 1]] : []);
  assert.ok(configs.some((config) => config.startsWith("marketplaces.openai-bundled.source=")));
  assert.notEqual(codexHome, requestEnv.CODEX_HOME);
}

test("Codex app-server driver sends initialize and initialized before thread/start", async (t) => {
  const { driver, log, startLog, requestEnv } = await createCodexDriver(t);
  await assertCodexAppServerExclusions(startLog, requestEnv);
  assert.equal(driver.provider_session_id, "thread-fresh");
  const [ready] = await collectEvents(driver, () => true);
  assert.deepEqual(ready, { type: "session.ready", provider_session_id: "thread-fresh", pid: driver.pid });

  const received = await readLog(log);
  assert.deepEqual(received.map((message) => message.method), ["initialize", "initialized", "thread/start"]);
  const [initialize, initialized, threadStart] = received;
  assert.equal(typeof initialize.id, "number");
  assert.equal(initialize.params.clientInfo.name, "owl");
  assert.equal(typeof initialize.params.clientInfo.version, "string");
  assert.equal("id" in initialized, false, "initialized is a notification");
  assert.equal(threadStart.params.sandbox, "danger-full-access");
  assert.equal(threadStart.params.developerInstructions, "advisor system prompt");
  assert.equal(driver.exited, false);
});

test("Codex thread/resume carries sandbox and developerInstructions, and a server that rejects them fails as resume-unsupported", async (t) => {
  const accepted = await createCodexDriver(t, { providerSessionId: "thread-old" });
  await assertCodexAppServerExclusions(accepted.startLog, accepted.requestEnv);
  assert.equal(accepted.driver.provider_session_id, "thread-old");
  const acceptedResume = (await readLog(accepted.log)).filter((message) => message.method === "thread/resume");
  assert.equal(acceptedResume.length, 1);
  assert.equal(acceptedResume[0].params.sandbox, "danger-full-access");
  assert.equal(acceptedResume[0].params.developerInstructions, "advisor system prompt");

  const root = await mkdtemp(join(tmpdir(), "owl-codex-protocol-"));
  const executable = await writeExecutable(root, "fake-codex", FAKE_CODEX_APP_SERVER);
  const log = join(root, "received.jsonl");
  await assert.rejects(CodexSessionDriver.create({
    adapter: "codex",
    role: "advisor",
    model: "gpt-test",
    cwd: root,
    env: { ...baseEnv, FAKE_LOG: log, FAKE_REJECT_RESUME_OVERRIDES: "1" },
    system_prompt: "advisor system prompt",
    provider_session_id: "thread-old",
  }, executable), (error) => {
    assert.equal(isProviderResumeUnsupportedError(error), true);
    assert.equal(error.code, "provider_resume_unsupported");
    return true;
  });
  const received = await readLog(log);
  assert.deepEqual(received.map((message) => message.method), ["initialize", "initialized", "thread/resume"], "no resume without the system prompt is sent");
});

test("Codex driver answers server-initiated requests", async (t) => {
  const { driver, log } = await createCodexDriver(t, { env: { FAKE_TURN: "server-request" } });
  await driver.send({ turn_id: "local-turn", text: "hello" });
  const events = await collectEvents(driver, (event) => event.type === "turn.completed" || event.type === "turn.failed");
  const completed = events.find((event) => event.type === "turn.completed");
  assert.equal(completed?.turn_id, "local-turn");
  assert.equal(completed?.reply, "hello");

  const received = await readLog(log);
  const unknownResponse = received.find((message) => message.id === 9 && message.method === undefined);
  assert.equal(unknownResponse?.error?.code, -32601);
  assert.equal("result" in (unknownResponse ?? {}), false);
  const approvalResponse = received.find((message) => message.id === "approval-1" && message.method === undefined);
  assert.deepEqual(approvalResponse?.result, { decision: "accept" });
  assert.equal(driver.exited, false);
});

test("Codex driver builds the reply from streamed deltas when turn/completed carries no items", async (t) => {
  const { driver } = await createCodexDriver(t, { env: { FAKE_TURN: "delta-only" } });
  await driver.send({ turn_id: "local-turn", text: "hello" });
  const events = await collectEvents(driver, (event) => event.type === "turn.completed" || event.type === "turn.failed");
  const completed = events.find((event) => event.type === "turn.completed");
  assert.equal(completed?.reply, "hello");
});

/** Runs one turn of the given FAKE_TURN scenario and returns its events. */
async function codexTurn(t, scenario) {
  const { driver } = await createCodexDriver(t, { env: { FAKE_TURN: scenario } });
  await driver.send({ turn_id: "local-turn", text: "hello" });
  const events = await collectEvents(driver, (event) => event.type === "turn.completed" || event.type === "turn.failed");
  return { driver, events, completed: events.find((event) => event.type === "turn.completed") };
}

test("Codex reply is the final_answer item only, never the commentary", async (t) => {
  const { events, completed } = await codexTurn(t, "phased");
  assert.equal(completed?.reply, "hello");
  const streamed = events.filter((event) => event.type === "turn.delta").map((event) => event.text).join("");
  assert.ok(streamed.includes("thinking..."), "commentary still streams as turn.delta");
});

test("Codex reply uses phases carried only by turn/completed items", async (t) => {
  const { completed } = await codexTurn(t, "phased-items-only");
  assert.equal(completed?.reply, "hello");
});

test("Codex reply from deltas alone is the last item, per itemId", async (t) => {
  const { completed } = await codexTurn(t, "phased-delta-only");
  assert.equal(completed?.reply, "hello");
});

test("Codex turn with commentary but no final_answer fails", async (t) => {
  const { events, completed } = await codexTurn(t, "commentary-only");
  assert.equal(completed, undefined);
  const failed = events.find((event) => event.type === "turn.failed");
  assert.equal(failed?.turn_id, "local-turn");
  assert.match(failed?.error ?? "", /final_answer/);
  assert.doesNotMatch(failed?.error ?? "", /thinking\.\.\./);
});

test("Codex legacy turn without phases replies with the last agentMessage only", async (t) => {
  const { completed } = await codexTurn(t, "legacy-multi");
  assert.equal(completed?.reply, "hello");
});

test("a Codex delta without itemId is a protocol error", async (t) => {
  const { driver, events } = await codexTurn(t, "delta-missing-item-id");
  assert.deepEqual(events.slice(-2).map((event) => event.type), ["session.exited", "turn.failed"]);
  assert.equal(driver.exited, true);
});

// Fake `claude -p --input-format stream-json`: for the Nth user message it
// prints the Nth entry of FAKE_TURNS (an array of stream-json lines; string
// entries are written verbatim).
const FAKE_CLAUDE = `#!/usr/bin/env node
const readline = require("node:readline");
if (process.env.FAKE_ARGV_LOG) require("node:fs").writeFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_START_LOG) require("node:fs").writeFileSync(process.env.FAKE_START_LOG, JSON.stringify({
  args: process.argv.slice(2),
  env: { HOME: process.env.HOME ?? null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null },
  cwd: process.cwd(),
}));
const turns = JSON.parse(process.env.FAKE_TURNS);
let index = 0;
readline.createInterface({ input: process.stdin }).on("line", () => {
  const lines = turns[index] ?? [];
  index += 1;
  if (index === 1) process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-session" }) + "\\n");
  for (const line of lines) process.stdout.write((typeof line === "string" ? line : JSON.stringify(line)) + "\\n");
});
`;

async function createClaudeDriver(t, turns, request = {}) {
  const { env = {}, ...driverRequest } = request;
  const root = await mkdtemp(join(tmpdir(), "owl-claude-protocol-"));
  const executable = await writeExecutable(root, "fake-claude", FAKE_CLAUDE);
  const argvLog = join(root, "argv.json");
  const startLog = join(root, "start.json");
  const driver = await AdvisorSessionDriver.create({
    adapter: "claude",
    role: "advisor",
    model: "claude-opus-5",
    cwd: root,
    env: {
      ...baseEnv,
      FAKE_TURNS: JSON.stringify(turns),
      FAKE_ARGV_LOG: argvLog,
      FAKE_START_LOG: startLog,
      ...env,
    },
    system_prompt: "test",
    ...driverRequest,
  }, executable);
  t.after(() => driver.stop("test", 1000));
  driver.argvLog = argvLog;
  driver.startLog = startLog;
  driver.cwd = root;
  return driver;
}

const settled = (event) => event.type === "turn.completed" || event.type === "turn.failed";

test("Claude Advisor result with is_error settles the turn as failed without posting the error text", async (t) => {
  const apiError = "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)";
  const driver = await createClaudeDriver(t, [[
    { type: "assistant", message: { content: [{ type: "text", text: apiError }] }, error: "server_error" },
    { type: "result", subtype: "success", is_error: true, api_error_status: null, terminal_reason: "api_error", result: apiError },
  ]]);
  await driver.send({ turn_id: "turn-is-error", text: "hello" });
  const events = await collectEvents(driver, settled);
  const failed = events.find((event) => event.type === "turn.failed");
  assert.equal(failed?.turn_id, "turn-is-error");
  assert.match(failed?.error ?? "", /接続できませんでした/);
  assert.doesNotMatch(failed?.error ?? "", /API Error/);
  assert.equal(events.some((event) => event.type === "turn.completed"), false);
});

test("Claude Advisor reply is result.result, not the concatenated turn text", async (t) => {
  const driver = await createClaudeDriver(t, [[
    { type: "assistant", message: { content: [{ type: "text", text: "ファイルを確認します。" }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Final answer." }] } },
    { type: "result", subtype: "success", is_error: false, result: "Final answer." },
  ]]);
  await driver.send({ turn_id: "turn-final", text: "hello" });
  const events = await collectEvents(driver, settled);
  const completed = events.find((event) => event.type === "turn.completed");
  assert.equal(completed?.reply, "Final answer.");
});

test("tool_progress events do not end the Advisor session", async (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (...args) => { warnings.push(args.join(" ")); });
  const driver = await createClaudeDriver(t, [
    [
      { type: "assistant", message: { content: [{ type: "text", text: "Running the long command." }] } },
      { type: "tool_progress", tool_use_id: "toolu_1", tool_name: "Bash", elapsed_time_seconds: 30 },
      { type: "owl_test_future_event_kind", data: 1 },
      { type: "owl_test_future_event_kind", data: 2 },
      { type: "result", subtype: "success", is_error: false, result: "Done." },
    ],
    [
      { type: "assistant", message: { content: [{ type: "text", text: "Second." }] } },
      { type: "result", subtype: "success", is_error: false, result: "Second." },
    ],
  ]);
  await driver.send({ turn_id: "turn-1", text: "run it" });
  const first = await collectEvents(driver, settled);
  assert.equal(first.at(-1)?.type, "turn.completed");
  assert.equal(first.at(-1)?.reply, "Done.");
  assert.equal(first.some((event) => event.type === "session.exited"), false);
  assert.equal(driver.exited, false);

  await driver.send({ turn_id: "turn-2", text: "again" });
  const second = await collectEvents(driver, settled);
  assert.equal(second.at(-1)?.type, "turn.completed");
  assert.equal(second.at(-1)?.reply, "Second.");

  assert.equal(warnings.filter((warning) => warning.includes("tool_progress")).length, 0, "tool_progress is a known informational kind");
  assert.equal(warnings.filter((warning) => warning.includes("owl_test_future_event_kind")).length, 1, "unknown kinds warn once");
});

function optionValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

test("Claude Advisor excludes CLAUDE.md from the child config directory or child HOME", async (t) => {
  const childHome = join(tmpdir(), "owl-claude-protocol-child-home");
  const childConfigDir = join(tmpdir(), "owl-claude-protocol-child-config");
  const cases = [
    {
      name: "uses the child's CLAUDE_CONFIG_DIR",
      env: { HOME: childHome, CLAUDE_CONFIG_DIR: childConfigDir },
      expectedPath: join(childConfigDir, "CLAUDE.md"),
      loggedConfigDir: childConfigDir,
    },
    {
      name: "falls back to the child's HOME",
      env: { HOME: childHome },
      expectedPath: join(childHome, ".claude", "CLAUDE.md"),
      loggedConfigDir: null,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const driver = await createClaudeDriver(
        subtest,
        [[{ type: "result", subtype: "success", is_error: false, result: "ok" }]],
        { env: scenario.env },
      );
      await driver.send({ turn_id: "turn-env", text: "hello" });
      await collectEvents(driver, settled);
      const start = JSON.parse(await readFile(driver.startLog, "utf8"));
      const settings = JSON.parse(optionValue(start.args, "--settings"));

      assert.equal(start.env.HOME, childHome);
      assert.equal(start.env.CLAUDE_CONFIG_DIR, scenario.loggedConfigDir);
      assert.equal(start.cwd, await realpath(driver.cwd));
      assert.deepEqual(settings.claudeMdExcludes, [scenario.expectedPath]);
      assert.equal(optionValue(start.args, "--input-format"), "stream-json");
      assert.ok(optionValue(start.args, "--session-id"));
      assert.equal(start.args.includes("--resume"), false);
    });
  }
});

test("Claude Advisor passes the configured model both on a fresh start and on resume", async (t) => {
  const fresh = await createClaudeDriver(t, [[{ type: "result", subtype: "success", is_error: false, result: "ok" }]]);
  await fresh.send({ turn_id: "turn-fresh", text: "hello" });
  await collectEvents(fresh, settled);
  const freshArgv = JSON.parse(await readFile(fresh.argvLog, "utf8"));
  const freshSettings = freshArgv.flatMap((arg, index) => arg === "--settings" ? [freshArgv[index + 1]] : []);
  assert.equal(freshSettings.length, 1);
  const freshSettingsJson = JSON.parse(freshSettings[0]);
  assert.deepEqual(freshSettingsJson.claudeMdExcludes, [join(baseEnv.HOME, ".claude", "CLAUDE.md")]);
  assert.ok(freshSettingsJson.hooks.PreToolUse);
  assert.equal(optionValue(freshArgv, "--input-format"), "stream-json");
  assert.equal(optionValue(freshArgv, "--output-format"), "stream-json");
  assert.equal(optionValue(freshArgv, "--append-system-prompt"), "test");
  assert.equal(optionValue(freshArgv, "--model"), "claude-opus-5");
  assert.ok(optionValue(freshArgv, "--session-id"));
  assert.equal(freshArgv.includes("--resume"), false);

  const resumed = await createClaudeDriver(
    t,
    [[{ type: "result", subtype: "success", is_error: false, result: "ok" }]],
    { model: "claude-sonnet-5", provider_session_id: "saved-session" },
  );
  await resumed.send({ turn_id: "turn-resumed", text: "hello" });
  await collectEvents(resumed, settled);
  const resumedArgv = JSON.parse(await readFile(resumed.argvLog, "utf8"));
  const resumedSettings = resumedArgv.flatMap((arg, index) => arg === "--settings" ? [resumedArgv[index + 1]] : []);
  assert.equal(resumedSettings.length, 1);
  const resumedSettingsJson = JSON.parse(resumedSettings[0]);
  assert.deepEqual(resumedSettingsJson.claudeMdExcludes, [join(baseEnv.HOME, ".claude", "CLAUDE.md")]);
  assert.ok(resumedSettingsJson.hooks.PreToolUse);
  assert.equal(optionValue(resumedArgv, "--input-format"), "stream-json");
  assert.equal(optionValue(resumedArgv, "--output-format"), "stream-json");
  assert.equal(optionValue(resumedArgv, "--append-system-prompt"), "test");
  assert.equal(optionValue(resumedArgv, "--resume"), "saved-session");
  assert.equal(optionValue(resumedArgv, "--model"), "claude-sonnet-5");
  assert.equal(resumedArgv.includes("--session-id"), false);
});

test("malformed stream-json still ends the Claude Advisor session", async (t) => {
  const driver = await createClaudeDriver(t, [["this is not json"]]);
  await driver.send({ turn_id: "turn-malformed", text: "hello" });
  const events = await collectEvents(driver, settled);
  assert.deepEqual(events.slice(-2).map((event) => event.type), ["session.exited", "turn.failed"]);
  assert.equal(driver.exited, true);
});

test("Codex JSONL with a transient error line and a later agent_message succeeds; turn.failed still fails", () => {
  const recovered = [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "error", message: "Reconnecting... 1/5 waiting for network" }),
    JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "{\"ok\":true}" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
  ].join("\n");
  assert.equal(unwrapCodexCliResult(recovered), "{\"ok\":true}");

  const failed = [
    JSON.stringify({ type: "error", message: "Reconnecting... 1/5 waiting for network" }),
    JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "partial" } }),
    JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected before completion" } }),
  ].join("\n");
  assert.throws(() => unwrapCodexCliResult(failed), (error) => {
    assert.equal(error.code, "provider_failed");
    assert.equal(error.reason, "provider_reported_error");
    assert.equal(error.cause.error, "stream disconnected before completion");
    assert.deepEqual(error.cause.errors, ["Reconnecting... 1/5 waiting for network", "stream disconnected before completion"]);
    return true;
  });

  const errorOnly = [
    JSON.stringify({ type: "error", message: "Reconnecting... 5/5 waiting for network" }),
    JSON.stringify({ type: "error", message: "stream error: connection refused" }),
  ].join("\n");
  assert.throws(() => unwrapCodexCliResult(errorOnly), (error) => {
    assert.equal(error.code, "provider_failed");
    assert.equal(error.cause.error, "stream error: connection refused", "the failure names the last error");
    assert.equal(error.cause.errors.length, 2);
    return true;
  });

  const noMessage = JSON.stringify({ type: "turn.completed" });
  assert.throws(() => unwrapCodexCliResult(noMessage), (error) => error.code === "report_invalid"
    && error.reason === "codex_final_agent_message_missing");
});
