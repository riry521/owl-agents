// opencode harness env and config: what Owl hands to `opencode serve`, checked in the process
// env and config the fake opencode records.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { createHybridExecutorRuntime } from "../../apps/server/dist/agent-runner.js";
import { createChildRunScheduler, summarizeChildReport } from "../../packages/core/dist/child-run-scheduler.js";
import { buildChildRunPrompt, OPENCODE_STDERR_TAIL_CHARS, runExecutorProcess, terminateActiveExecutorsImmediately } from "../../packages/core/dist/executor.js";
import { startOpencodeServer } from "../../packages/agent-runtime/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import * as harness from "../../packages/shared/dist/index.js";
import { createTestDatabase } from "../helpers/db.mjs";
import { readFakeOpencodeLog, writeFakeOpencode } from "../helpers/fake-opencode.mjs";
import { tempDir } from "../helpers/temp.mjs";

const { DEFAULT_CHILD_RUN_SETTINGS, opencodeConfigContent, opencodeServeEnv, parseOpencodeVersion, splitOpencodeModel } = harness;
const model = "some-provider/some-model";

test("named constants exist and no constant caps retry attempts", () => {
  assert.equal(harness.OPENCODE_MIN_SUPPORTED_VERSION, "2.0.0");
  for (const name of ["OPENCODE_STARTUP_TIMEOUT_MS", "OPENCODE_EVENT_STALL_MS", "OPENCODE_RETRY_WAIT_LIMIT_MS", "OPENCODE_TOOL_LOOKUP_WAIT_MS"]) {
    assert.equal(typeof harness[name], "number", name);
  }
  assert.deepEqual(Object.keys(harness).filter((name) => /RETRY.*(ATTEMPT|LIMIT)/u.test(name) && !name.endsWith("_WAIT_LIMIT_MS")), []);
});

test("parseOpencodeVersion reads the first x.y.z and splitOpencodeModel splits at the first slash", () => {
  assert.deepEqual(parseOpencodeVersion("opencode 2.0.30 (build)"), [2, 0, 30]);
  assert.equal(parseOpencodeVersion("no version"), null);
  assert.equal(harness.isSupportedOpencodeVersion("1.18.23"), false);
  assert.equal(harness.isSupportedOpencodeVersion("2.0.0"), true);
  assert.deepEqual(splitOpencodeModel("a/b/c"), { providerID: "a", modelID: "b/c" });
  assert.equal(splitOpencodeModel("nomodel"), null);
  assert.equal(splitOpencodeModel("/x"), null);
});

test("opencodeServeEnv overlays the isolation flags on a fresh 0700 config dir and drops foreign config variables", async (t) => {
  const runDir = path.join(await tempDir(t, "owl-opencode-env-"), "run");
  const password = randomBytes(12).toString("hex");
  const env = opencodeServeEnv({
    env: { OWL_ROLE: "worker", OPENCODE_CONFIG: "/x", OPENCODE_CLI_CONFIG_CONTENT: "{}", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_TEST_HOME: "/h", OPENCODE_SERVER_PASSWORD: "old" },
    password,
    runDir,
    configContent: "{}",
  });
  assert.equal(env.OWL_ROLE, "worker");
  assert.equal(env.OPENCODE_PASSWORD, password);
  assert.equal(env.OPENCODE_CONFIG_DIR, path.join(runDir, "config"));
  assert.equal((await stat(env.OPENCODE_CONFIG_DIR)).mode & 0o777, 0o700);
  for (const flag of ["OPENCODE_CONFIG_PROJECT_DISABLE", "OPENCODE_DISABLE_CLAUDE_CODE", "OPENCODE_DISABLE_AUTOUPDATE"]) assert.equal(env[flag], "1");
  for (const name of ["OPENCODE_CONFIG", "OPENCODE_CLI_CONFIG_CONTENT", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_TEST_HOME", "OPENCODE_SERVER_PASSWORD"]) {
    assert.equal(name in env, false, name);
  }
});

test("opencodeConfigContent lists AGENTS.md from the git root to cwd and skips missing files", async (t) => {
  const root = await tempDir(t, "owl-opencode-instr-");
  const inner = path.join(root, "packages", "app");
  await mkdir(path.join(inner, "src"), { recursive: true });
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, "AGENTS.md"), "root", "utf8");
  await writeFile(path.join(inner, "src", "AGENTS.md"), "leaf", "utf8");
  const content = JSON.parse(opencodeConfigContent({ cwd: path.join(inner, "src"), model, env: {}, permissions: [], mcpServers: [], extraInstructions: ["/extra.md"] }));
  assert.deepEqual(content.instructions, [path.join(root, "AGENTS.md"), path.join(inner, "src", "AGENTS.md"), "/extra.md"]);
  assert.equal(content.update, "disable");
  assert.equal(content.share, "disabled");
  assert.equal(content.snapshots, false);
  assert.deepEqual(content.permissions, []);
  assert.deepEqual(content.mcp, { servers: {} });
});

test("opencodeConfigContent without a git root uses only cwd's AGENTS.md", async (t) => {
  const root = await tempDir(t, "owl-opencode-noroot-");
  const content = JSON.parse(opencodeConfigContent({ cwd: root, model, env: {}, permissions: [], mcpServers: [] }));
  assert.deepEqual(content.instructions, []);
  await writeFile(path.join(root, "AGENTS.md"), "x", "utf8");
  assert.deepEqual(JSON.parse(opencodeConfigContent({ cwd: root, model, env: {}, permissions: [], mcpServers: [] })).instructions, [path.join(root, "AGENTS.md")]);
});

test("connection settings come only from OWL_OPENCODE_BASE_URL and OWL_OPENCODE_API_KEY_ENV, and never hold secret values", async (t) => {
  const cwd = await tempDir(t, "owl-opencode-conn-");
  const secret = randomBytes(12).toString("hex");
  const build = (env) => opencodeConfigContent({ cwd, model, env, permissions: [], mcpServers: [] });
  assert.equal("providers" in JSON.parse(build({})), false);
  assert.deepEqual(JSON.parse(build({ OWL_OPENCODE_BASE_URL: "http://example.invalid/v1?a={env:X}" })).providers, {
    "some-provider": { settings: { baseURL: "http://example.invalid/v1?a={env:X}" } },
  });
  const both = build({ OWL_OPENCODE_BASE_URL: "http://example.invalid", OWL_OPENCODE_API_KEY_ENV: "MY_KEY_VAR", MY_KEY_VAR: secret });
  assert.deepEqual(JSON.parse(both).providers["some-provider"].settings, { baseURL: "http://example.invalid", apiKey: "{env:MY_KEY_VAR}" });
  assert.equal(both.includes(secret), false);
  assert.deepEqual(JSON.parse(build({ OWL_OPENCODE_API_KEY_ENV: "MY_KEY_VAR" })).providers["some-provider"].settings, { apiKey: "{env:MY_KEY_VAR}" });
});

test("the env and config reach serve intact and the password value is never logged", async (t) => {
  const root = await tempDir(t, "owl-opencode-serve-");
  const executable = await writeFakeOpencode(root);
  const logPath = path.join(root, "log.jsonl");
  const password = randomBytes(12).toString("hex");
  const configContent = opencodeConfigContent({ cwd: root, model, env: { OWL_OPENCODE_BASE_URL: "http://example.invalid" }, permissions: [], mcpServers: [] });
  const env = opencodeServeEnv({
    env: { PATH: process.env.PATH ?? "", FAKE_OPENCODE_LOG: logPath, OPENCODE_CONFIG: "/should/be/dropped" },
    password,
    runDir: path.join(root, "run"),
    configContent,
  });
  const server = await startOpencodeServer({ executable, cwd: root, env });
  t.after(() => server.stop(1000));
  const providers = await server.client.request("GET", "/api/provider");
  assert.equal(providers.data.find((provider) => provider.id === "some-provider").settings.baseURL, "http://example.invalid");
  const start = (await readFakeOpencodeLog(logPath)).find((entry) => entry.type === "start");
  assert.equal(start.env.OPENCODE_CONFIG_CONTENT, configContent);
  assert.equal(start.env.OPENCODE_CONFIG_DIR, env.OPENCODE_CONFIG_DIR);
  assert.equal(start.env.OPENCODE_CONFIG_PROJECT_DISABLE, "1");
  assert.equal(start.env.password_present, true);
  assert.equal(start.env.scrubbed_present.OPENCODE_CONFIG, false);
  assert.equal(JSON.stringify(await readFakeOpencodeLog(logPath)).includes(password), false);
});

const CHILD_REPORT = "```owl-child-report\n{\"result\":\"succeeded\",\"summary\":\"done\",\"changed_files\":[],\"checks\":[],\"remaining_issues\":[]}\n```";
const textSteps = [{ op: "text", chunks: [CHILD_REPORT] }, { op: "step_end", tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } }, { op: "succeed" }];

/** A runtime from createHybridExecutorRuntime with the fake opencode; env is restored after the test. */
async function childFixture(t, scenario) {
  const root = await tempDir(t, "owl-opencode-child-");
  const owlRoot = path.join(root, "owl");
  const workspace = path.join(root, "ws");
  await mkdir(owlRoot);
  await mkdir(workspace);
  const executable = await writeFakeOpencode(root);
  const saved = {};
  for (const [key, value] of Object.entries({ OWL_PROVIDER: "stub", OWL_OPENCODE_EXECUTABLE: executable, OWL_ROOT: owlRoot, FAKE_OPENCODE_SCENARIO: JSON.stringify(scenario) })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const runtime = await createHybridExecutorRuntime(owlRoot)();
  const task = { subtask_id: "child-1", instruction: "Do the part.", workspace_dir: workspace, write_paths: ["src/"], task: { title: "T", acceptance: "ok", context: "", rules: null, owner_guidance: [] } };
  const run = (config, rt = runtime, observer = {}) => {
    const sink = { usage: null };
    return runExecutorProcess(task, { provider: "opencode", model: "fake-provider/fake-model", timeout_ms: 30_000, ...config }, { agent_run_id: "run-1", ...observer }, sink, rt).then((result) => ({ result, sink }));
  };
  return { runtime, run, owlRoot, runsDir: path.join(owlRoot, "data", "opencode-runs") };
}

test("an opencode child runs on its own serve and returns a structured report with usage, leaving no serve or run directory", async (t) => {
  const { run, runsDir } = await childFixture(t, textSteps);
  const pids = [];
  const { result, sink } = await run({}, undefined, { onSpawn: (pid) => pids.push(pid) });
  assert.equal(result.success, true, result.output);
  assert.ok(result.output.includes("```owl-child-report"));
  const summary = summarizeChildReport(result.output, { success: true, failure_kind: null, failure_reason: null }, 1, 1);
  assert.equal(summary.report_format, "structured");
  assert.equal(sink.usage?.input_tokens, 7);
  assert.equal(pids.length, 1);
  assert.throws(() => process.kill(-pids[0], 0), { code: "ESRCH" });
  assert.equal(existsSync(runsDir) ? (await readdir(runsDir)).length : 0, 0);
});

test("three opencode children in one workspace with a guard token and the permission responder all succeed, each answering a write ask", async (t) => {
  const tool = { op: "tool", name: "write", action: "edit", input: { path: "src/a.txt", content: "hi" }, resources: ["src/a.txt"] };
  const { runtime, owlRoot, run } = await childFixture(t, [tool, ...textSteps]);
  // The hook is a stub that allows; what is under test is the reply handshake with serve, which real opencode
  // confirms with permission.replied carrying `requestID`.
  await mkdir(path.join(owlRoot, "apps/server/dist"), { recursive: true });
  await writeFile(path.join(owlRoot, "apps/server/dist/permission-hook.js"), "process.stdin.resume().on('end', () => {});\n");
  const guarded = { ...runtime, guardToken: ({ agent_run_id }) => {
    const file = path.join(owlRoot, `guard-token-${agent_run_id}`);
    writeFileSync(file, randomBytes(8).toString("hex"), { mode: 0o600 });
    return { file, release() {} };
  } };
  const results = await Promise.all([1, 2, 3].map((n) => run({}, guarded, { agent_run_id: `run-${n}` })));
  for (const { result } of results) {
    assert.equal(result.success, true, result.output);
    assert.ok(result.output.includes("```owl-child-report"));
  }
});

test("opencode child failures map to the existing failure kinds", async (t) => {
  const timeout = await childFixture(t, [{ op: "wait_interrupt" }]);
  assert.equal((await timeout.run({ timeout_ms: 1500 })).result.failure_kind, "timeout");

  const exit = await childFixture(t, [{ op: "exit", code: 1 }]);
  const exited = (await exit.run({})).result;
  assert.equal(exited.success, false);
  assert.equal(exited.failure_kind, "exit_code");

  const silent = await childFixture(t, [{ op: "succeed" }]);
  assert.equal((await silent.run({})).result.failure_kind, "no_final_report");

  const { runtime, run } = await childFixture(t, textSteps);
  const { runOpencode: _omit, ...withoutOpencode } = runtime;
  assert.equal((await run({}, withoutOpencode)).result.failure_kind, "spawn_error");
});

/** Runs one opencode child through the child scheduler (one attempt) and returns its child_runs row. */
async function failedChildRun(t, executorRuntime) {
  const root = await tempDir(t, "owl-opencode-child-run-");
  const db = createTestDatabase(root);
  const ids = { work: createUlid(), task: createUlid(), parent: createUlid() };
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run("INSERT INTO works (id, owner_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at) VALUES (?, 'owner:default', 'W', '', 'normal', 'running', '[]', '[]', ?, ?)", ids.work, now, now);
    tx.run("INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at) VALUES (?, ?, 'T', 'code', 'running', 'normal', '', 'ok', ?, ?)", ids.task, ids.work, now, now);
    tx.run("INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at) VALUES (?, ?, ?, 'worker', 'claude', 'm', 'running', ?, ?)", ids.parent, ids.work, ids.task, now, now);
  });
  const opencode = { ...DEFAULT_CHILD_RUN_SETTINGS.executor_by_harness.opencode, model: "fake-provider/fake-model" };
  const scheduler = createChildRunScheduler({
    db,
    writeLane: db.createWriteLane(),
    executorRuntime,
    settings: () => ({ ...DEFAULT_CHILD_RUN_SETTINGS, executor_harness: "opencode", executor_by_harness: { ...DEFAULT_CHILD_RUN_SETTINGS.executor_by_harness, opencode }, max_attempts: 1 }),
    onParentActivity() {},
  });
  t.after(async () => { await scheduler.stop(); db.close(); });
  scheduler.registerParent({
    agent_run_id: ids.parent, work_id: ids.work, task_id: ids.task, workspace_dir: root, worktree: root,
    task: { title: "T", acceptance_criteria: [], context: "", manager_notes: null, necessity: null, rules: null, owner_guidance: [], knowledge: null },
  });
  const child = await scheduler.dispatch(ids.parent, { title: "child", instruction: "Do the part.", write_paths: ["src/"] }, "child");
  await scheduler.wait(ids.parent, { child_ids: [child.child_id], timeout_seconds: 20 }, new AbortController().signal);
  return db.get("SELECT status, failure_reason FROM child_runs WHERE id = ?", child.child_id);
}

const SECRETS = ["dummyBearer123", "dummyKey456", "dummySk789"];
const SECRET_STDERR = `Authorization: Bearer ${SECRETS[0]} api_key=${SECRETS[1]} sk-${SECRETS[2]}`;

function assertRedacted(reason) {
  for (const dummy of SECRETS) assert.ok(!reason.includes(dummy), dummy);
  assert.match(reason, /Bearer \[redacted\] api_key=\[redacted\] \[redacted\]/u);
}

test("child_runs.failure_reason keeps the spawn ENOENT of a missing opencode executable, through the production runtime", async (t) => {
  const { owlRoot } = await childFixture(t, textSteps);
  process.env.OWL_OPENCODE_EXECUTABLE = path.join(owlRoot, "missing", "opencode");
  const row = await failedChildRun(t, createHybridExecutorRuntime(owlRoot));
  assert.equal(row.status, "failed");
  assert.match(row.failure_reason, /\[original error\][^]*spawn \S+missing\/opencode ENOENT/u);
});

test("child_runs.failure_reason keeps a permission rejection and the serve stderr with secrets redacted, through the production runtime", async (t) => {
  const { owlRoot } = await childFixture(t, [
    { op: "stderr", text: SECRET_STDERR },
    { op: "fail", error: { type: "permission.rejected", message: "permission denied: write outside the workspace" } },
  ]);
  const row = await failedChildRun(t, createHybridExecutorRuntime(owlRoot));
  assert.equal(row.status, "failed");
  assert.match(row.failure_reason, /\[original error\] permission denied: write outside the workspace/u);
  assertRedacted(row.failure_reason);
});

test("child_runs.failure_reason keeps the cause error and stderr of an error thrown by runOpencode, redacted before the stderr tail is cut", async (t) => {
  const { runtime } = await childFixture(t, textSteps);
  // The tail starts right after "Bearer ", so a cut before redaction would keep the bare value.
  const tailSecret = "dummyTail000";
  const stderr = `early line\nAuthorization: Bearer ${tailSecret} ${"z".repeat(OPENCODE_STDERR_TAIL_CHARS - tailSecret.length - 1)}`;
  const thrown = new Error("opencode serve stopped", { cause: { error: `spawn opencode EACCES ${SECRET_STDERR}`, stderr } });
  const row = await failedChildRun(t, async () => ({ ...runtime, runOpencode: async () => { throw thrown; } }));
  assert.equal(row.status, "failed");
  assert.match(row.failure_reason, /\[original error\] opencode serve stopped\nspawn opencode EACCES/u);
  assert.match(row.failure_reason, /\[redacted\] z+/u);
  assert.ok(!row.failure_reason.includes(tailSecret));
  assertRedacted(row.failure_reason);
});

test("terminateActiveExecutorsImmediately kills the serve process group of a stuck opencode child", async (t) => {
  const { run } = await childFixture(t, [{ op: "wait_interrupt" }]);
  let pid = 0;
  const running = run({}, undefined, { onSpawn: (value) => { pid = value; } });
  for (let i = 0; i < 100 && pid === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(pid > 0);
  terminateActiveExecutorsImmediately();
  for (let i = 0; i < 100; i += 1) {
    try { process.kill(-pid, 0); } catch (error) { assert.equal(error.code, "ESRCH"); break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" });
  assert.equal((await running).result.success, false);
});

// Calls a real model once; runs only when OWL_OPENCODE_SMOKE_MODEL (providerID/modelID) is set, so the suite stays free.
const smokeModel = process.env.OWL_OPENCODE_SMOKE_MODEL;
test("a real opencode child returns a structured report through the production runtime", { skip: smokeModel ? false : "OWL_OPENCODE_SMOKE_MODEL is not set" }, async (t) => {
  const root = await tempDir(t, "owl-opencode-live-");
  const owlRoot = path.join(root, "owl");
  const workspace = path.join(root, "ws");
  await mkdir(owlRoot);
  await mkdir(workspace);
  const saved = process.env.OWL_ROOT;
  process.env.OWL_ROOT = owlRoot;
  t.after(() => { if (saved === undefined) delete process.env.OWL_ROOT; else process.env.OWL_ROOT = saved; });
  const runtime = await createHybridExecutorRuntime(owlRoot)();
  const task = {
    subtask_id: "live-1",
    instruction: `Do not use any tool. Reply with only one fenced block that starts with the line \`\`\`owl-child-report and holds this JSON: ${JSON.stringify({ result: "succeeded", summary: "ok", changed_files: [], checks: [], remaining_issues: [] })}`,
    workspace_dir: workspace,
    write_paths: [],
    task: { title: "Smoke", acceptance: "Return the report block only.", context: "", rules: null, owner_guidance: [] },
  };
  const pids = [];
  const result = await runExecutorProcess(task, { provider: "opencode", model: smokeModel, timeout_ms: 300_000 }, { agent_run_id: "live-run", onSpawn: (pid) => pids.push(pid) }, { usage: null }, runtime);
  assert.equal(result.success, true, result.output);
  assert.equal(summarizeChildReport(result.output, { success: true, failure_kind: null, failure_reason: null }, 1, 1).report_format, "structured");
  assert.equal(pids.length, 1);
  assert.throws(() => process.kill(-pids[0], 0), { code: "ESRCH" });
  const runsDir = path.join(owlRoot, "data", "opencode-runs");
  assert.equal(existsSync(runsDir) ? (await readdir(runsDir)).length : 0, 0);
});

test("the weaker write_paths guard of opencode children is stated in doctor gaps and in the opencode prompt only", () => {
  const gap = harness.OPENCODE_HARNESS_GAPS.find((entry) => entry.key === "child_write_paths");
  assert.ok(gap && gap.ja.length > 0 && gap.en.length > 0);
  const task = { subtask_id: "c", instruction: "x", workspace_dir: "/w", write_paths: ["src/"], task: { title: "T", acceptance: "ok", context: "", rules: null, owner_guidance: [] } };
  const line = "confirm that the path is inside your write_paths";
  assert.ok(buildChildRunPrompt(task, null, null, null, "opencode").includes(line));
  assert.equal(buildChildRunPrompt(task, null, null, null, "claude").includes(line), false);
  assert.equal(buildChildRunPrompt(task).includes(line), false);
});
