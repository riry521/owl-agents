import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sampleDir = join(repoRoot, "examples/plugins/log-notify");
const serverPath = join(repoRoot, "apps/server/dist/server.js");
const samplePath = join(sampleDir, "dist/index.js");

async function freePort() {
  const server = createNetServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function waitForOutput(child, getOutput, expected, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!getOutput().includes(expected)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Server exited before ${JSON.stringify(expected)} appeared:\n${getOutput().slice(-2000)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${JSON.stringify(expected)}:\n${getOutput().slice(-2000)}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

function waitForClose(child, timeoutMs = 15_000) {
  return new Promise((resolveClose, reject) => {
    const timer = setTimeout(() => {
      child.off("close", onClose);
      reject(new Error("Server did not exit after SIGTERM."));
    }, timeoutMs);
    const onClose = (code, signal) => {
      clearTimeout(timer);
      resolveClose({ code, signal });
    };
    child.once("close", onClose);
  });
}

async function killTree(child, output) {
  if (!child?.pid) return;
  const running = child.exitCode === null && child.signalCode === null;
  const pluginMayRemain = !output.includes("[plugin-e2e-child-exit]");
  let groupSignalled = false;
  if (process.platform !== "win32" && (running || pluginMayRemain)) {
    try {
      process.kill(-child.pid, "SIGTERM");
      groupSignalled = true;
    } catch {}
  }
  if (running && !groupSignalled) {
    child.kill("SIGTERM");
  }
  if (running) {
    try { await waitForClose(child, 2_000); } catch {
      let groupKilled = false;
      if (process.platform !== "win32" && groupSignalled) {
        try {
          process.kill(-child.pid, "SIGKILL");
          groupKilled = true;
        } catch {}
      }
      if (!groupKilled) child.kill("SIGKILL");
      try { await waitForClose(child, 2_000); } catch {}
    }
  }
  if (process.platform !== "win32" && !output.includes("[plugin-e2e-child-exit]")) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
}

test("server launches log-notify, delivers decision.opened, and stops it on SIGTERM", async (t) => {
  if (!existsSync(serverPath) || !existsSync(samplePath)) {
    t.skip("build apps/server and examples/plugins/log-notify first");
    return;
  }
  if (process.platform === "win32") {
    t.skip("external plugin SIGTERM lifecycle is supported on macOS and Linux");
    return;
  }

  const [{ DecisionService }, { createUlid, openDatabase }] = await Promise.all([
    import("../packages/core/dist/index.js"),
    import("../packages/db/dist/index.js"),
  ]);
  let owlRoot;
  let dataDir;
  let server;
  let output = "";
  try {
    owlRoot = await mkdtemp(join(tmpdir(), "owl-plugin-e2e-root-"));
    dataDir = await mkdtemp(join(tmpdir(), "owl-plugin-e2e-data-"));
    await Promise.all([
      symlink(join(repoRoot, "packages"), join(owlRoot, "packages"), "dir"),
      symlink(join(repoRoot, "contracts"), join(owlRoot, "contracts"), "dir"),
    ]);

    const pluginsFile = join(owlRoot, "plugins.json");
    await writeFile(pluginsFile, JSON.stringify({ plugins: [{
      name: "log-notify",
      command: "node",
      args: ["dist/index.js"],
      cwd: sampleDir,
      enabled: true,
      env: {},
    }] }));
    const exitObserver = join(owlRoot, "observe-plugin-exit.cjs");
    await writeFile(exitObserver, [
      'const cp = require("node:child_process");',
      'const { syncBuiltinESMExports } = require("node:module");',
      'const spawn = cp.spawn;',
      'cp.spawn = function (...args) {',
      '  const child = spawn.apply(this, args);',
      '  if (Array.isArray(args[1]) && args[1].includes("dist/index.js")) {',
      '    child.once("exit", (code, signal) => require("node:fs").writeSync(1, "[plugin-e2e-child-exit] code=" + code + " signal=" + signal + "\\n"));',
      '  }',
      '  return child;',
      '};',
      'syncBuiltinESMExports();',
    ].join("\n"));

    const port = await freePort();
    const apiToken = randomBytes(24).toString("hex");
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("OWL_")) delete env[key];
    Object.assign(env, {
      HOME: owlRoot,
      NODE_OPTIONS: `--require=${exitObserver}`,
      OWL_API_TOKEN: apiToken,
      OWL_BIND: "127.0.0.1",
      OWL_DATA_DIR: dataDir,
      OWL_PLUGINS_FILE: pluginsFile,
      OWL_PORT: String(port),
      OWL_PROVIDER: "stub",
      OWL_ROOT: owlRoot,
      OWL_WEB_OUT: join(repoRoot, "apps/web/out"),
    });
    server = spawn(process.execPath, [serverPath], {
      cwd: repoRoot,
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    server.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });

    await waitForOutput(server, () => output, "[plugin:log-notify] [log-notify] started");
    const base = `http://127.0.0.1:${port}/api/v1`;
    const created = await fetch(`${base}/works`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        request_id: createUlid(),
        idempotency_key: `plugin-e2e-work:${createUlid()}`,
        expected_version: 0,
        payload: { title: "Plugin e2e", summary: "Exercise the external plugin event path.", size: "small", project_id: null },
      }),
    });
    const createdBody = await created.json();
    assert.equal(created.status, 201, JSON.stringify(createdBody));
    const workId = createdBody.data.work_id;
    const db = openDatabase(join(dataDir, "owl.sqlite"));
    try {
      await new DecisionService(db).open({
        request_id: createUlid(),
        idempotency_key: `plugin-e2e-decision:${createUlid()}`,
        expected_version: 0,
        payload: {
          work_id: workId,
          scope: "work",
          blocked_task_ids: [],
          reason: "Exercise the plugin event path.",
          question: "Continue?",
          tried: "Created a Work through the API.",
          current_state: "judgement_waiting",
          options: [
            { key: "approve", label: "Proceed", description: "Continue." },
            { key: "reject", label: "Stop", description: "Do not continue." },
          ],
          recommended: null,
          allow_free_text: true,
          issuer_role: "manager",
          blocks_work: false,
        },
      });
    } finally {
      db.close();
    }
    await waitForOutput(server, () => output, '"type":"decision.opened"');
    assert.match(output, /\[plugin:log-notify\].*"type":"decision\.opened"/u);

    const closed = waitForClose(server);
    server.kill("SIGTERM");
    const exit = await closed;
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.match(output, /\[plugin:log-notify\] \[log-notify\] stopped/u);
    assert.match(output, /\[plugin-e2e-child-exit\] code=0 signal=null/u);
    assert.equal(output.split("[plugin:log-notify] [log-notify] started").length - 1, 1, "the plugin must not restart during shutdown");
  } finally {
    await killTree(server, output);
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (owlRoot) await rm(owlRoot, { recursive: true, force: true });
  }
});
