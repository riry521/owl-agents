import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { childEnv, workTestRunner } from "../../packages/core/dist/core-test-run.js";
import { gatedTestRunner } from "../../packages/core/dist/test-setup-install-guard.js";
import { DEFAULT_TEST_SETUP_SETTINGS } from "../../packages/shared/dist/test-setup-settings.js";
import { createTestCore } from "../helpers/core.mjs";
import { tempDir } from "../helpers/temp.mjs";

const SETTINGS = DEFAULT_TEST_SETUP_SETTINGS.install;
const noQuery = async () => ({ exit_code: null, stdout: "" });

function recorder() {
  const calls = [];
  const run = async (argv, cwd) => {
    calls.push({ argv: [...argv], cwd });
    return { exit_code: 0, timed_out: false, stdout: "ran", stderr: "", duration_ms: 1 };
  };
  return { run, calls };
}

async function setup(t) {
  const proj = await tempDir(t, "owl-core-gate-");
  await mkdir(path.join(proj, "bin"), { recursive: true });
  return { proj, env: { PATH: "/usr/bin:/bin", HOME: proj, UV_PYTHON_DOWNLOADS: "never" } };
}

const gateFor = (box, over = {}) => ({ gate: "all", roots: () => [box.proj], env: box.env, approved: [], settings: SETTINGS, query: noQuery, ...over });

test("gatedTestRunner stops a command that needs credentials without starting a process, and lets Mac-wide, inside and ordinary test commands through", async (t) => {
  const box = await setup(t);
  const { run, calls } = recorder();
  const gated = gatedTestRunner(run, gateFor(box));

  const blocked = await gated(["sudo", "brew", "install", "jq"], box.proj, 1000, 1000);
  assert.equal(blocked.exit_code, null);
  assert.equal(blocked.timed_out, false);
  assert.match(blocked.error, /^install_needs_approval: sudo brew install jq/u);
  assert.equal(calls.length, 0);

  assert.equal((await gated(["pip", "install", "--user", "x"], box.proj, 1000, 1000)).error, undefined, "a Mac-wide install runs");
  assert.equal((await gated(["bun", "--version"], box.proj, 1000, 1000)).error, undefined, "a version check runs");
  await gated([process.execPath, "--test", "a.test.mjs"], box.proj, 1000, 1000);
  await gated(["python3", "-m", "venv", ".venv"], box.proj, 1000, 1000);
  assert.deepEqual(calls.map((call) => call.argv[0]), ["pip", "bun", process.execPath, "python3"]);
});

test("gatedTestRunner lets an approved sudo argv run, and only that argv", async (t) => {
  const box = await setup(t);
  const { run, calls } = recorder();
  const gated = gatedTestRunner(run, gateFor(box, { approved: [["sudo", "brew", "install", "jq"]] }));
  assert.equal((await gated(["sudo", "brew", "install", "jq"], box.proj, 1000, 1000)).error, undefined);
  assert.match((await gated(["sudo", "brew", "install", "ripgrep"], box.proj, 1000, 1000)).error, /^install_needs_approval/u);
  assert.equal(calls.length, 1);
});

test("with gate { only } the Owner's own test_run commands are not judged but the listed setup_argvs are", async (t) => {
  const box = await setup(t);
  const { run, calls } = recorder();
  const repair = ["sudo", "brew", "install", "jq"];
  const gated = gatedTestRunner(run, gateFor(box, { gate: { only: [repair] } }));
  assert.equal((await gated(["sudo", "owner-written"], box.proj, 1000, 1000)).error, undefined, "owner-written commands are not gated");
  assert.match((await gated(repair, box.proj, 1000, 1000)).error, /^install_needs_approval/u);
  assert.deepEqual(calls.map((call) => call.argv.join(" ")), ["sudo owner-written"]);
});

test("the roots are asked per cwd, so a baseline checkout is judged by its own folder", async (t) => {
  const box = await setup(t);
  const other = await tempDir(t, "owl-core-gate-baseline-");
  const { run, calls } = recorder();
  const gated = gatedTestRunner(run, gateFor(box, { roots: (cwd) => [cwd], env: { ...box.env, PATH: "/usr/bin:/bin" } }));
  const inBaseline = await gated(["python3", "-m", "venv", ".venv"], other, 1000, 1000);
  assert.equal(inBaseline.error, undefined);
  assert.equal(calls[0].cwd, other);
});

test("run_env reaches the child process of a Work-level runner and the child env is what the gate assumes", async (t) => {
  const box = await setup(t);
  const marker = "OWL_GATE_TEST_VALUE";
  const run = workTestRunner({ workId: "W1", envAllowlist: [], extraEnv: { [marker]: "from-run-env" }, instanceId: "test-instance" });
  const result = await run([process.execPath, "-e", `process.stdout.write(process.env.${marker} ?? "missing")`], box.proj, 20_000, 10_000);
  assert.equal(result.stdout, "from-run-env");
  assert.equal(childEnv([], { [marker]: "x" })[marker], "x");
  assert.equal(childEnv(["PATH"], {}).PATH, process.env.PATH);
});

test("runVerificationCommand gives the Task's Core child the test_setup run_env", async (t) => {
  const box = await setup(t);
  const { core } = await createTestCore(t, { version: "core-gate-run-env" }, { prefix: "owl-core-gate-env-" });
  delete process.env.UV_PYTHON_DOWNLOADS;
  const result = await core.workflow.runVerificationCommand("T1", [process.execPath, "-e", 'process.stdout.write(process.env.UV_PYTHON_DOWNLOADS ?? "missing")'], box.proj, [], 20_000, 10_000, 10_000, [0]);
  assert.equal(result.stdout, "never");
});

test("the engine's runner gate uses the saved setup's approved installs and the child env", async (t) => {
  const box = await setup(t);
  const { core } = await createTestCore(t, { version: "core-gate-engine" }, { prefix: "owl-core-gate-engine-" });
  const { run, calls } = recorder();
  await writeFile(path.join(box.proj, "marker"), "");
  const resolved = { gate: "all", approved_installs: [["sudo", "brew", "install", "jq"]] };
  const gated = core.workflow.gateTestRunner(run, resolved, [], () => [box.proj]);
  assert.match((await gated(["sudo", "brew", "install", "ripgrep"], box.proj, 1000, 1000)).error, /^install_needs_approval/u);
  assert.equal((await gated(["sudo", "brew", "install", "jq"], box.proj, 1000, 1000)).error, undefined);
  assert.equal(calls.length, 1);
});
