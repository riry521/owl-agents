import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { createPluginManagerFromEnv, loadPluginSpecs, PluginConfigError, PluginManager } from "../../apps/server/dist/plugin-manager.js";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

async function writeConfig(directory, plugins, extra = {}) {
  const path = join(directory, "plugins.json");
  await writeFile(path, JSON.stringify({ plugins, ...extra }), "utf8");
  return path;
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    child.emit("exit", signal === "SIGTERM" ? 0 : null, signal === "SIGTERM" ? null : signal);
    return true;
  };
  child.exit = (code = 1, signal = null) => child.emit("exit", code, signal);
  return child;
}

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeoutFn(callback, delayMs) {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      if (timer) timer.cleared = true;
    },
    fire(delayMs) {
      const timer = timers.find((entry) => !entry.cleared && entry.delayMs === delayMs);
      assert.ok(timer, `expected a pending ${delayMs}ms restart`);
      timer.cleared = true;
      timer.callback();
    },
    pending() {
      return timers.filter((entry) => !entry.cleared);
    },
  };
}

test("loadPluginSpecs rejects unknown top-level and plugin fields", async (t) => {
  const directory = await tempDir(t, "owl-plugin-test-");
  const unknownTopLevel = await writeConfig(directory, [], { unexpected: true });
  assert.throws(() => loadPluginSpecs(unknownTopLevel), (error) =>
    error instanceof PluginConfigError && error.field === "file.unexpected");

  const unknownPluginField = await writeConfig(directory, [{ name: "alpha", command: "node", cwd: directory, extra: true }]);
  assert.throws(() => loadPluginSpecs(unknownPluginField), (error) =>
    error instanceof PluginConfigError && error.field === "plugins[0].extra");
});

test("loadPluginSpecs rejects duplicate names, reserved environment keys, and missing working directories", async (t) => {
  const directory = await tempDir(t, "owl-plugin-test-");
  const duplicateNames = await writeConfig(directory, [
    { name: "alpha", command: "node", cwd: directory },
    { name: "alpha", command: "node", cwd: directory },
  ]);
  assert.throws(() => loadPluginSpecs(duplicateNames), (error) =>
    error instanceof PluginConfigError && error.field === "plugins[1].name");

  const reservedEnvironmentKey = await writeConfig(directory, [
    { name: "alpha", command: "node", cwd: directory, env: { OWL_PRIVATE: "value" } },
  ]);
  assert.throws(() => loadPluginSpecs(reservedEnvironmentKey), (error) =>
    error instanceof PluginConfigError && error.field === "plugins[0].env.OWL_PRIVATE");

  const missingWorkingDirectory = await writeConfig(directory, [
    { name: "alpha", command: "node", cwd: "missing" },
  ]);
  assert.throws(() => loadPluginSpecs(missingWorkingDirectory), (error) =>
    error instanceof PluginConfigError && error.field === "plugins[0].cwd");
});

test("loadPluginSpecs validates names, command, args, enabled, and environment values", async (t) => {
  const directory = await tempDir(t, "owl-plugin-test-");
  const invalidPlugins = [
    [{ name: "Upper", command: "node", cwd: directory }, "plugins[0].name"],
    [{ name: "alpha\n", command: "node", cwd: directory }, "plugins[0].name"],
    [{ name: "alpha", command: "   ", cwd: directory }, "plugins[0].command"],
    [{ name: "alpha", command: "node", cwd: directory, args: [1] }, "plugins[0].args"],
    [{ name: "alpha", command: "node", cwd: directory, enabled: "yes" }, "plugins[0].enabled"],
    [{ name: "alpha", command: "node", cwd: directory, env: { "bad-key": "value" } }, "plugins[0].env.bad-key"],
    [{ name: "alpha", command: "node", cwd: directory, env: { "GOOD_KEY\n": "value" } }, "plugins[0].env.GOOD_KEY\n"],
    [{ name: "alpha", command: "node", cwd: directory, env: { GOOD_KEY: 1 } }, "plugins[0].env.GOOD_KEY"],
  ];
  for (const [plugin, field] of invalidPlugins) {
    const path = await writeConfig(directory, [plugin]);
    assert.throws(() => loadPluginSpecs(path), (error) =>
      error instanceof PluginConfigError && error.field === field);
  }
});

test("loadPluginSpecs resolves relative working directories from the config file and defaults fields", async (t) => {
  const directory = await tempDir(t, "owl-plugin-test-");
  await mkdir(join(directory, "work"));
  const path = await writeConfig(directory, [{ name: "alpha", command: "node", cwd: "work" }]);

  assert.deepEqual(loadPluginSpecs(path), [{
    name: "alpha",
    command: "node",
    args: [],
    cwd: join(directory, "work"),
    enabled: true,
    env: {},
  }]);
});

test("a plugin receives only its allowlisted environment and stops on SIGTERM", async (t) => {
  const directory = await tempDir(t, "owl-plugin-test-");
  const dumpPath = join(directory, "received.json");
  const fixturePath = new URL("../fixtures/plugins/env-dump.mjs", import.meta.url).pathname;
  const configPath = await writeConfig(directory, [{
    name: "alpha",
    command: process.execPath,
    args: [fixturePath],
    cwd: directory,
    env: { DUMP_FILE: dumpPath, PLUGIN_SETTING: "visible" },
  }]);
  const specs = loadPluginSpecs(configPath);
  const previousSecret = process.env.OWL_SECRET_PASSPHRASE;
  process.env.OWL_SECRET_PASSPHRASE = "parent-only-value";
  let manager;
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  t.after(async () => {
    try {
      await manager?.stopAll(100);
    } finally {
      console.log = originalLog;
      console.error = originalError;
      if (previousSecret === undefined) delete process.env.OWL_SECRET_PASSPHRASE;
      else process.env.OWL_SECRET_PASSPHRASE = previousSecret;
    }
  });

  let childProcess;
  manager = new PluginManager({
    specs,
    serverPort: 4312,
    apiToken: "test-token",
    dataDir: join(directory, "state"),
    spawnFn: (...args) => {
      childProcess = spawn(...args);
      return childProcess;
    },
  });
  await manager.startAll();
  await waitFor(() => logs.some((line) => line.includes("[plugin:alpha] ready")), { timeoutMs: 3000, intervalMs: 10, message: "plugin output was not prefixed" });
  const received = JSON.parse(await readFile(dumpPath, "utf8"));
  assert.equal(received.OWL_API_BASE, "http://127.0.0.1:4312/api/v1");
  assert.equal(received.OWL_PLUGIN_NAME, "alpha");
  assert.equal(received.OWL_PLUGIN_STATE_DIR, join(directory, "state", "plugins", "alpha"));
  assert.equal(received.OWL_API_TOKEN, "test-token");
  assert.equal(received.PLUGIN_SETTING, "visible");
  assert.equal(received.OWL_SECRET_PASSPHRASE, undefined);
  assert.equal((await stat(received.OWL_PLUGIN_STATE_DIR)).isDirectory(), true);
  assert.ok(logs.some((line) => line.includes("[plugin:alpha] diagnostic")));
  await manager.stopAll(1000);
  assert.equal(childProcess.exitCode, 0);
});

test("stopAll kills a process that ignores SIGTERM", async (t) => {
  const directory = await tempDir(t, "owl-plugin-test-");
  const fixturePath = new URL("../fixtures/plugins/ignore-term.mjs", import.meta.url).pathname;
  const readyPath = join(directory, "ready");
  const configPath = await writeConfig(directory, [{
    name: "stubborn",
    command: process.execPath,
    args: [fixturePath],
    cwd: directory,
    env: { READY_FILE: readyPath },
  }]);
  const childProcesses = [];
  const manager = new PluginManager({
    specs: loadPluginSpecs(configPath),
    serverPort: 4312,
    dataDir: directory,
    spawnFn: (...args) => {
      const child = spawn(...args);
      childProcesses.push(child);
      return child;
    },
  });
  t.after(() => manager.stopAll(50));
  await manager.startAll();
  await waitFor(() => childProcesses.length === 1 && childProcesses[0].pid, { timeoutMs: 3000, intervalMs: 10, message: "fixture process was not created" });
  await waitFor(() => existsSync(readyPath), { timeoutMs: 3000, intervalMs: 10, message: "fixture did not install its signal handler" });

  await manager.stopAll(50);
  assert.deepEqual(childProcesses[0].killed, true);
  assert.equal(childProcesses[0].signalCode, "SIGKILL");
});

test("restart delays double, stop after five retries, and log when the limit is reached", async (t) => {
  const scheduler = fakeTimers();
  const children = [];
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => { console.error = originalError; });
  const manager = new PluginManager({
    specs: [{ name: "alpha", command: "node", args: [], cwd: tmpdir(), enabled: true, env: {} }],
    serverPort: 4312,
    dataDir: tmpdir(),
    spawnFn: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    now: () => 0,
    setTimeoutFn: scheduler.setTimeoutFn,
    clearTimeoutFn: scheduler.clearTimeoutFn,
  });
  t.after(() => manager.stopAll(0));

  await manager.startAll();
  const expectedDelays = [1000, 2000, 4000, 8000, 16000];
  for (const [index, expectedDelay] of expectedDelays.entries()) {
    children[index].exit(1);
    assert.deepEqual(scheduler.pending().map((timer) => timer.delayMs), [expectedDelay]);
    scheduler.fire(expectedDelay);
    await waitFor(() => children.length === index + 2, { timeoutMs: 3000, intervalMs: 10, message: "restart did not start" });
  }
  assert.equal(children.length, 6);
  children[5].exit(1);
  assert.deepEqual(scheduler.pending(), []);
  assert.ok(errors.some((line) => line.includes("alpha") && line.includes("restart limit")));
});

test("a plugin stable for ten minutes resets its restart delay", async (t) => {
  const scheduler = fakeTimers();
  const children = [];
  let currentTime = 0;
  const manager = new PluginManager({
    specs: [{ name: "alpha", command: "node", args: [], cwd: tmpdir(), enabled: true, env: {} }],
    serverPort: 4312,
    dataDir: tmpdir(),
    spawnFn: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    now: () => currentTime,
    setTimeoutFn: scheduler.setTimeoutFn,
    clearTimeoutFn: scheduler.clearTimeoutFn,
  });
  t.after(() => manager.stopAll(0));

  await manager.startAll();
  children[0].exit(1);
  scheduler.fire(1000);
  await waitFor(() => children.length === 2, { timeoutMs: 3000, intervalMs: 10, message: "restart did not start" });
  currentTime = 600_000;
  children[1].exit(1);
  assert.deepEqual(scheduler.pending().map((timer) => timer.delayMs), [1000]);
});

test("stopAll clears a pending restart and disabled plugins do not start", async (t) => {
  const scheduler = fakeTimers();
  const children = [];
  const manager = new PluginManager({
    specs: [
      { name: "alpha", command: "node", args: [], cwd: tmpdir(), enabled: true, env: {} },
      { name: "disabled", command: "node", args: [], cwd: tmpdir(), enabled: false, env: {} },
    ],
    serverPort: 4312,
    dataDir: tmpdir(),
    spawnFn: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    now: () => 0,
    setTimeoutFn: scheduler.setTimeoutFn,
    clearTimeoutFn: scheduler.clearTimeoutFn,
  });

  await manager.startAll();
  children[0].exit(1);
  assert.equal(scheduler.pending().length, 1);
  await manager.stopAll(100);
  assert.equal(scheduler.pending().length, 0);
  assert.equal(children.length, 1);
  scheduler.timers[0].callback();
  assert.equal(children.length, 1);
});

test("an unset plugin file does not invoke the spawn function", async () => {
  let spawnCalls = 0;
  const manager = createPluginManagerFromEnv({ OWL_PLUGINS_FILE: "  " }, {
    serverPort: 4312,
    dataDir: tmpdir(),
    spawnFn: () => { spawnCalls += 1; throw new Error("must not spawn"); },
  });

  assert.equal(manager, null);
  assert.equal(spawnCalls, 0);
});

test("createPluginManagerFromEnv loads a configured file before starting its plugins", async (t) => {
  const directory = await tempDir(t, "owl-plugin-test-");
  const configPath = await writeConfig(directory, [{ name: "alpha", command: "node", cwd: directory }]);
  const childProcesses = [];
  const manager = createPluginManagerFromEnv({ OWL_PLUGINS_FILE: configPath }, {
    serverPort: 4312,
    dataDir: directory,
    spawnFn: () => {
      const child = fakeChild();
      childProcesses.push(child);
      return child;
    },
  });
  t.after(() => manager?.stopAll(100));

  assert.ok(manager instanceof PluginManager);
  await manager.startAll();
  assert.equal(childProcesses.length, 1);
  await manager.stopAll(100);
});

test("createPluginManagerFromEnv validates all entries before any spawn can occur", async (t) => {
  const directory = await tempDir(t, "owl-plugin-test-");
  const configPath = await writeConfig(directory, [
    { name: "alpha", command: "node", cwd: directory },
    { name: "invalid", command: "node", cwd: directory, unknown: true },
  ]);
  let spawnCalls = 0;

  assert.throws(() => createPluginManagerFromEnv({ OWL_PLUGINS_FILE: configPath }, {
    serverPort: 4312,
    dataDir: directory,
    spawnFn: () => { spawnCalls += 1; throw new Error("must not spawn"); },
  }), PluginConfigError);
  assert.equal(spawnCalls, 0);
});

test("createPluginManagerFromEnv requires an absolute configuration path", async (t) => {
  const directory = await tempDir(t, "owl-plugin-test-");
  const configPath = await writeConfig(directory, []);

  assert.throws(() => createPluginManagerFromEnv({ OWL_PLUGINS_FILE: relative(process.cwd(), configPath) }, {
    serverPort: 4312,
    dataDir: directory,
  }), (error) => error instanceof PluginConfigError
    && error.field === "OWL_PLUGINS_FILE"
    && error.message === "OWL_PLUGINS_FILE must be an absolute path.");
});
