// Agent process time limits: the wall-clock limit for every run and the
// no-output limit for runs whose output streams progress (Codex --json and Claude stream-json).
// Fake harness executables stand in for the real CLIs.
import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { createCliProvider } from "../../packages/agent-runtime/dist/provider.js";
import { runExecutor } from "../../packages/core/dist/executor.js";
import {
  AGENT_STALE_THRESHOLD_MS,
  agentIdleTimeoutMs,
  agentWallTimeoutMs,
  DEFAULT_AGENT_IDLE_TIMEOUT_MS,
  DEFAULT_AGENT_WALL_TIMEOUT_MS,
  MAX_AGENT_TIMEOUT_MS,
} from "../../packages/shared/dist/index.js";
import { tempDir } from "../helpers/temp.mjs";

const baseEnv = { PATH: process.env.PATH || `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME || "/tmp" };

// FAKE_MODE selects what the harness prints before it waits to be stopped:
//   progress  - one progress event, then silence
//   reconnect - Codex reconnect `error` events every 20 ms, never progress
//   late-json - nothing for FAKE_DELAY_MS, then one JSON result and exit
const FAKE_HARNESS = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  const mode = process.env.FAKE_MODE;
  const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  if (mode === "progress") line(process.argv.includes("exec") ? { type: "thread.started", thread_id: "t1" } : { type: "system", subtype: "init" });
  if (mode === "reconnect") setInterval(() => line({ type: "error", message: "Reconnecting... 1/5" }), 20);
  if (mode === "late-json") {
    setTimeout(() => {
      line({ type: "result", subtype: "success", is_error: false, result: "done" });
      process.exit(0);
    }, Number(process.env.FAKE_DELAY_MS ?? "0"));
    return;
  }
  setInterval(() => {}, 1000);
});
`;

async function withHarness(t, run) {
  const root = await tempDir(t, "owl-provider-timeout-");
  const executable = join(root, "fake-harness");
  await writeFile(executable, FAKE_HARNESS, "utf8");
  await chmod(executable, 0o755);
  return await run(root, executable);
}

function execute(executable, adapter, root, env, onOutput, onSpawn) {
  const provider = createCliProvider({ adapter, executablePath: executable, model: "test-model", env: baseEnv });
  return provider.execute({
    adapter,
    role: "worker",
    model: "test-model",
    prompt: "work",
    invocation_id: "inv-1",
    cwd: root,
    env: { ...baseEnv, ...env },
    on_output: onOutput,
    on_spawn: onSpawn,
  });
}

function signal() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, fire: () => resolve() };
}

test("time limit settings default to 3 hours wall and 60 minutes idle, and 0 disables them", () => {
  assert.equal(agentWallTimeoutMs({}), DEFAULT_AGENT_WALL_TIMEOUT_MS);
  assert.equal(DEFAULT_AGENT_WALL_TIMEOUT_MS, 3 * 60 * 60 * 1000);
  assert.equal(agentIdleTimeoutMs({}), DEFAULT_AGENT_IDLE_TIMEOUT_MS);
  assert.equal(DEFAULT_AGENT_IDLE_TIMEOUT_MS, 60 * 60 * 1000);
  assert.equal(agentWallTimeoutMs({ OWL_PROVIDER_TIMEOUT_MS: "0" }), 0);
  assert.equal(agentIdleTimeoutMs({ OWL_PROVIDER_IDLE_TIMEOUT_MS: "0" }), 0);
  assert.equal(agentWallTimeoutMs({ OWL_PROVIDER_TIMEOUT_MS: "5000" }), 5000);
  assert.equal(agentWallTimeoutMs({ OWL_PROVIDER_TIMEOUT_MS: String(MAX_AGENT_TIMEOUT_MS * 2) }), MAX_AGENT_TIMEOUT_MS);
  assert.throws(() => agentWallTimeoutMs({ OWL_PROVIDER_TIMEOUT_MS: "-1" }), /OWL_PROVIDER_TIMEOUT_MS/);
  assert.throws(() => agentWallTimeoutMs({ OWL_PROVIDER_TIMEOUT_MS: "3h" }), /OWL_PROVIDER_TIMEOUT_MS/);
  assert.throws(() => agentIdleTimeoutMs({ OWL_PROVIDER_IDLE_TIMEOUT_MS: String(AGENT_STALE_THRESHOLD_MS - 1) }), /agent\.idle/);
  assert.equal(agentIdleTimeoutMs({ OWL_PROVIDER_IDLE_TIMEOUT_MS: String(AGENT_STALE_THRESHOLD_MS) }), AGENT_STALE_THRESHOLD_MS);
});

test("the wall-clock limit stops a provider run and reports a wall timeout", async (t) => {
  await withHarness(t, async (root, executable) => {
    const error = await execute(executable, "claude-cli/v1", root, { FAKE_MODE: "progress", OWL_PROVIDER_TIMEOUT_MS: "200" })
      .then(() => null, (caught) => caught);
    assert.equal(error?.code, "provider_failed");
    assert.equal(error.reason, "provider_timeout");
    assert.equal(error.cause.timeout_kind, "wall");
  });
});

test("a Codex run that stops making progress is stopped by the no-output limit", async (t) => {
  await withHarness(t, async (root, executable) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const output = signal();
    const run = execute(executable, "codex-cli/v1", root, { FAKE_MODE: "progress" }, output.fire).then(() => null, (caught) => caught);
    await output.promise;
    t.mock.timers.tick(DEFAULT_AGENT_IDLE_TIMEOUT_MS);
    const error = await run;
    assert.equal(error?.reason, "provider_timeout");
    assert.equal(error.cause.timeout_kind, "idle");
  });
});

test("Codex reconnect errors do not count as progress", async (t) => {
  await withHarness(t, async (root, executable) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const spawned = signal();
    const run = execute(executable, "codex-cli/v1", root, { FAKE_MODE: "reconnect" }, undefined, spawned.fire).then(() => null, (caught) => caught);
    await spawned.promise;
    t.mock.timers.tick(DEFAULT_AGENT_IDLE_TIMEOUT_MS);
    const error = await run;
    assert.equal(error?.cause?.timeout_kind, "idle");
  });
});

test("a Claude stream run with no progress reaches its no-output limit", async (t) => {
  await withHarness(t, async (root, executable) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const output = signal();
    const run = execute(executable, "claude-cli/v1", root, { FAKE_MODE: "progress" }, output.fire);
    await output.promise;
    t.mock.timers.tick(DEFAULT_AGENT_IDLE_TIMEOUT_MS);
    const error = await run.then(() => null, (caught) => caught);
    assert.equal(error?.cause?.timeout_kind, "idle");
  });
});

test("an explicit 0 removes the wall-clock limit", async (t) => {
  await withHarness(t, async (root, executable) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const spawned = signal();
    const run = execute(executable, "claude-cli/v1", root, { FAKE_MODE: "late-json", FAKE_DELAY_MS: "300", OWL_PROVIDER_TIMEOUT_MS: "0", OWL_PROVIDER_IDLE_TIMEOUT_MS: "0" }, undefined, spawned.fire);
    await spawned.promise;
    t.mock.timers.tick(MAX_AGENT_TIMEOUT_MS);
    assert.equal((await run).exit_code, 0);
  });
});

test("an invalid no-output limit is a provider configuration error", async (t) => {
  await withHarness(t, async (root, executable) => {
    await assert.rejects(
      () => execute(executable, "codex-cli/v1", root, { FAKE_MODE: "progress", OWL_PROVIDER_IDLE_TIMEOUT_MS: "1000" }),
      (error) => error?.code === "provider_config_invalid",
    );
  });
});

function executorTask(root) {
  return {
    subtask_id: "sub-1",
    instruction: "work",
    workspace_dir: root,
    task: { title: "Executor Task", acceptance: "It works.", context: "", rules: null, owner_guidance: [] },
  };
}

function executorRuntime(root, executable, env) {
  return {
    owlRoot: process.env.OWL_ROOT ?? process.cwd(),
    env: { ...baseEnv, ...env },
    executables: { claude: executable, codex: executable },
  };
}

test("a Codex Executor that stops making progress is stopped by the no-output limit", async (t) => {
  await withHarness(t, async (root, executable) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const output = signal();
    const run = runExecutor(
      executorTask(root),
      { provider: "codex", model: "gpt-5.6-terra", timeout_ms: 0 },
      { onOutput: output.fire },
      executorRuntime(root, executable, { FAKE_MODE: "progress" }),
    );
    await output.promise;
    t.mock.timers.tick(DEFAULT_AGENT_IDLE_TIMEOUT_MS);
    const result = await run;
    assert.equal(result.success, false);
    assert.equal(result.exit_code, -1);
    assert.match(result.output, /進捗を出さなかったため停止しました/);
  });
});

test("a Claude Executor with no progress reaches its no-output limit", async (t) => {
  await withHarness(t, async (root, executable) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const output = signal();
    const run = runExecutor(
      executorTask(root),
      { provider: "claude", model: "claude-sonnet-5", timeout_ms: 0 },
      { onOutput: output.fire },
      executorRuntime(root, executable, { FAKE_MODE: "progress" }),
    );
    await output.promise;
    t.mock.timers.tick(DEFAULT_AGENT_IDLE_TIMEOUT_MS);
    const result = await run;
    assert.equal(result.exit_code, -1);
    assert.match(result.output, /進捗を出さなかったため停止しました/);
  });
});
