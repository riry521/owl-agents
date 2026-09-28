import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runPluginFromEnv } from "../packages/plugin-sdk/dist/index.js";
import { FileConnectorStateStore } from "../packages/plugin-sdk/dist/shared/index.js";

function fakePlugin() {
  return {
    name: "test-plugin",
    async start() {},
    async stop() {},
  };
}

test("runPluginFromEnv maps environment variables into PluginConfig and state store", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "owl-plugin-run-"));
  const signals = new EventEmitter();
  let config;

  const plugin = await runPluginFromEnv((value) => {
    config = value;
    return fakePlugin();
  }, {
    OWL_API_BASE: "http://core.example/api/v1",
    OWL_API_TOKEN: "test-token",
    OWL_WS_URL: "ws://core.example/events",
    OWL_PLUGIN_NAME: "log-notify",
    OWL_PLUGIN_STATE_DIR: stateDir,
  }, { signalTarget: signals, exit() {} });

  assert.equal(plugin.name, "test-plugin");
  assert.equal(config.core_api_base, "http://core.example/api/v1");
  assert.equal(config.core_ws_url, "ws://core.example/events");
  assert.equal(config.api_token, "test-token");
  assert.equal(config.plugin_name, "log-notify");
  assert.ok(config.state_store instanceof FileConnectorStateStore);
  await config.state_store.save({ schema_version: 1, cursor: 1, decisions: {} });
  await stat(join(stateDir, "state.json"));
});

test("runPluginFromEnv leaves optional config values undefined when their variables are absent", async () => {
  let config;
  await runPluginFromEnv((value) => {
    config = value;
    return fakePlugin();
  }, { OWL_API_BASE: "http://core.example/api/v1" }, {
    signalTarget: new EventEmitter(),
    exit() {},
  });

  assert.equal(config.core_ws_url, undefined);
  assert.equal(config.api_token, undefined);
  assert.equal(config.state_store, undefined);
});

test("runPluginFromEnv reports a missing OWL_API_BASE and exits with code 1", async () => {
  const signals = new EventEmitter();
  const errors = [];
  const exits = [];
  let factoryCalled = false;

  await assert.rejects(runPluginFromEnv(() => {
    factoryCalled = true;
    return fakePlugin();
  }, { OWL_API_BASE: "" }, {
    signalTarget: signals,
    stderr: { write: (message) => errors.push(message) },
    exit: (code) => exits.push(code),
  }), /OWL_API_BASE/u);

  assert.equal(factoryCalled, false);
  assert.match(errors.join(""), /OWL_API_BASE/u);
  assert.deepEqual(exits, [1]);
});

test("runPluginFromEnv stops once on SIGTERM and exits with code 0", async () => {
  const signals = new EventEmitter();
  const exits = [];
  let stops = 0;
  let markExited;
  const exited = new Promise((resolve) => { markExited = resolve; });

  await runPluginFromEnv(() => ({
    name: "test-plugin",
    async start() {},
    async stop() { stops += 1; },
  }), { OWL_API_BASE: "http://core.example/api/v1" }, {
    signalTarget: signals,
    exit: (code) => { exits.push(code); markExited(code); },
  });

  signals.emit("SIGTERM");
  assert.equal(await exited, 0);
  signals.emit("SIGINT");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stops, 1);
  assert.deepEqual(exits, [0]);
});

test("runPluginFromEnv still exits with code 0 and reports a stop failure", async () => {
  const signals = new EventEmitter();
  const exits = [];
  const errors = [];
  let markExited;
  const exited = new Promise((resolve) => { markExited = resolve; });

  await runPluginFromEnv(() => ({
    name: "test-plugin",
    async start() {},
    async stop() { throw new Error("stop failed"); },
  }), { OWL_API_BASE: "http://core.example/api/v1" }, {
    signalTarget: signals,
    stderr: { write: (message) => errors.push(message) },
    exit: (code) => { exits.push(code); markExited(code); },
  });

  signals.emit("SIGINT");
  assert.equal(await exited, 0);
  assert.deepEqual(exits, [0]);
  assert.match(errors.join(""), /stop failed/u);
});
