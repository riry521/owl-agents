import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_CHILD_RUN_SETTINGS } from "../../../packages/shared/dist/child-runs.js";
import { Core } from "../../../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../../../packages/db/dist/index.js";
import { AppSettingsStore } from "../dist/app-settings-store.js";
import { ExternalCoreAdapter } from "../dist/core.js";
import { createOwlHttpServer } from "../dist/http.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const envelope = (payload, suffix, expected_version = 0) => ({
  request_id: createUlid(), idempotency_key: `child-http:${suffix}:${createUlid()}`, expected_version, payload,
});

async function waitFor(read, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

function fakeCore() {
  let settings = structuredClone(DEFAULT_CHILD_RUN_SETTINGS);
  const runs = [];
  const byKey = new Map();
  const calls = { wait: [], list: [] };
  const subscribers = new Set();
  const core = {
    subscribe(handler) { subscribers.add(handler); return () => subscribers.delete(handler); },
    status() { return { services: [], mvp_scope: "test", version: "test" }; },
    async stop() {},
    getChildRunSettings() { return settings; },
    async setChildRunSettings(value) { settings = structuredClone(value); return settings; },
    async dispatchChildRun(parentId, request, requestKey) {
      if (parentId !== "worker-run") throw Object.assign(new Error("The Worker is not active."), { code: "parent_not_active" });
      const provider = request.provider ?? settings.default_provider;
      const model = request.model ?? settings.default_model;
      if (!settings.allowed_models.some((choice) => choice.provider === provider && choice.model === model)) {
        throw Object.assign(new Error("The requested provider/model is not in the allowed list."), { code: "model_not_allowed" });
      }
      const key = `${parentId}:${requestKey}`;
      if (byKey.has(key)) return byKey.get(key);
      const child = {
        child_id: `child-${runs.length + 1}`, status: "running", blocked_reason: null,
        provider,
        model,
        effort: request.effort ?? settings.default_effort,
        timeout_minutes: request.timeout_minutes ?? settings.timeout_minutes,
        max_attempts: settings.max_attempts,
      };
      runs.push({ parentId, request, requestKey, child });
      byKey.set(key, child);
      return child;
    },
    async waitChildRuns(parentId, request, signal) {
      calls.wait.push({ parentId, request, signal });
      const items = request.child_ids.map((id) => {
        const run = runs.find((item) => item.child.child_id === id && item.parentId === parentId);
        if (!run) throw Object.assign(new Error("Child was not found."), { code: "child_not_found" });
        return {
          child_id: id, title: run.request.title, status: run.child.status,
          blocked_reason: null, attempt: 0, summary: null, summary_omitted: false,
        };
      });
      const timeout = request.timeout_seconds ?? 0;
      if (timeout > 0 && items.some((item) => item.status === "queued" || item.status === "running")) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, timeout * 1000);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
      const done = items.every((item) => item.status === "completed" || item.status === "failed" || item.status === "cancelled");
      return { done, truncated: false, children: items };
    },
    listChildRuns(filter) {
      calls.list.push(filter);
      return runs.filter((run) => filter.task_id === undefined || filter.task_id === "task-1").map((run) => ({
        id: run.child.child_id, work_id: "work-1", task_id: "task-1", parent_agent_run_id: run.parentId,
        seq: 1, title: run.request.title, instruction: run.request.instruction,
        write_paths: run.request.write_paths, provider: run.child.provider, model: run.child.model,
        effort: run.child.effort, timeout_ms: run.child.timeout_minutes * 60_000, max_attempts: run.child.max_attempts,
        attempt: 0, status: run.child.status, blocked_reason: null, current_agent_run_id: null,
        summary: null, report_text: null, failure_kind: null, failure_reason: null,
        created_at: "2026-01-01T00:00:00.000Z", started_at: null, finished_at: null, updated_at: "2026-01-01T00:00:00.000Z",
      }));
    },
  };
  return { core, runs, calls, settings: () => settings };
}

async function setup(t, { missingChildApi = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "owl-child-run-http-"));
  const fake = fakeCore();
  if (missingChildApi) {
    for (const method of ["dispatchChildRun", "waitChildRuns", "listChildRuns", "getChildRunSettings", "setChildRunSettings"]) {
      delete fake.core[method];
    }
  }
  const adapter = new ExternalCoreAdapter(fake.core, null, root, join(root, "data"));
  const previousToken = process.env.OWL_API_TOKEN;
  process.env.OWL_API_TOKEN = "owner-token";
  const tokens = new Map([
    ["worker-token", { agent_run_id: "worker-run", role: "worker" }],
    ["executor-token", { agent_run_id: "executor-run", role: "executor" }],
  ]);
  const http = createOwlHttpServer({
    core: adapter, webOut: root, bind: "127.0.0.1", port: 0,
    contract: { contract_version: "1.0.0" }, owlRoot: root,
    guardTokens: { verify: (token) => tokens.get(token) ?? null },
  });
  t.after(async () => {
    await http.close().catch(() => {});
    if (previousToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  });
  try {
    await http.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("listen not permitted"); return null; }
    throw error;
  }
  const base = `http://127.0.0.1:${http.server.address().port}/api/v1`;
  let sequence = 0;
  const envelope = (payload, key = `child-http:${++sequence}`) => ({
    request_id: key, idempotency_key: key, expected_version: 0, payload,
  });
  const request = (path, { method = "GET", token = "owner-token", body } = {}) => fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const post = (path, payload, key, token = "worker-token") => request(path, { method: "POST", token, body: envelope(payload, key) });
  return { adapter, fake, post, request };
}

test("child-run HTTP routes use the adapter-wrapped Core, scope guard tokens, and reuse idempotency keys", async (t) => {
  const api = await setup(t);
  if (!api) return;

  assert.equal(typeof api.adapter.dispatchChildRun, "function");
  const payload = { title: "Test child", instruction: "Do the work", write_paths: ["src/a.ts"], provider: "codex", model: "gpt-5.6-luna", effort: "low" };
  const first = await api.post("/agent/child-runs", payload, "dispatch-once");
  assert.equal(first.status, 200);
  const child = (await first.json()).data;
  assert.equal(child.provider, "codex");
  assert.equal(child.model, "gpt-5.6-luna");
  assert.equal(child.effort, "low");
  const retry = await api.post("/agent/child-runs", payload, "dispatch-once");
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).data.child_id, child.child_id);
  assert.equal(api.fake.runs.length, 1);
  assert.equal(api.fake.runs[0].requestKey, "dispatch-once");

  const owner = await api.post("/agent/child-runs", payload, "owner-denied", "owner-token");
  assert.equal(owner.status, 403);
  assert.equal((await owner.json()).error.code, "agent_scope_denied");
  const invalid = await api.post("/agent/child-runs", payload, "bad-token", "invalid-token");
  assert.equal(invalid.status, 403);
  assert.equal((await invalid.json()).error.code, "agent_scope_denied");
  const executor = await api.post("/agent/child-runs", payload, "executor-denied", "executor-token");
  assert.equal(executor.status, 409);
  assert.equal((await executor.json()).error.code, "parent_not_active");

  const rejected = await api.post("/agent/child-runs", { ...payload, model: "not-allowed" }, "model-denied");
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.code, "model_not_allowed");
  assert.equal(api.fake.runs.length, 1);
});

test("wait long-polls with an abort signal and Task-filtered dispatch records are available to Owner", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const dispatched = await api.post("/agent/child-runs", { title: "Wait child", instruction: "Wait", write_paths: ["src/a.ts"] }, "wait-child");
  const childId = (await dispatched.json()).data.child_id;

  const response = await api.post("/agent/child-runs/wait", { child_ids: [childId], return_when: "any", timeout_seconds: 1 }, "wait-once");
  assert.equal(response.status, 200);
  const waited = (await response.json()).data;
  assert.equal(waited.done, false);
  assert.equal(waited.children[0].status, "running");
  assert.equal(api.fake.calls.wait[0].request.timeout_seconds, 1);
  assert.ok(api.fake.calls.wait[0].signal instanceof AbortSignal);

  const listed = await api.request("/child-runs?task_id=task-1");
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).data[0].id, childId);
  assert.deepEqual(api.fake.calls.list, [{ task_id: "task-1" }]);

  const otherTask = await api.request("/child-runs?task_id=task-other");
  assert.equal(otherTask.status, 200);
  assert.deepEqual((await otherTask.json()).data, []);
  assert.deepEqual(api.fake.calls.list, [{ task_id: "task-1" }, { task_id: "task-other" }]);

  const invalidFilter = await api.request("/child-runs");
  assert.equal(invalidFilter.status, 400);
});

test("child settings APIs and the legacy executor route map defaults and timeout fields", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const initial = await api.request("/settings/child-runs");
  assert.equal(initial.status, 200);
  const settings = (await initial.json()).data;
  assert.deepEqual(settings, DEFAULT_CHILD_RUN_SETTINGS);

  const childUpdate = await api.request("/settings/child-runs", {
    method: "PUT",
    body: envelope(settings, "child-settings-update"),
  });
  assert.equal(childUpdate.status, 200);
  assert.deepEqual((await childUpdate.json()).data, settings);

  const legacy = await api.request("/settings/executor");
  assert.equal(legacy.status, 200);
  assert.deepEqual((await legacy.json()).data, {
    ...settings,
    provider: settings.default_provider,
    model: settings.default_model,
    effort: settings.default_effort,
    timeout_ms: settings.timeout_minutes * 60_000,
  });

  const update = await api.request("/settings/executor", {
    method: "PUT",
    body: {
      request_id: "legacy-update", idempotency_key: "legacy-update", expected_version: 0,
      payload: { provider: "openai", model: "gpt-5.6-luna", effort: "high", timeout_ms: 30 * 60_000 },
    },
  });
  assert.equal(update.status, 200);
  const updatedSettings = {
    ...settings,
    default_provider: "codex",
    default_model: "gpt-5.6-luna",
    default_effort: "high",
    defaults_by_parent_harness: {
      claude: { provider: "codex", model: "gpt-5.6-luna", effort: "high" },
      codex: { provider: "codex", model: "gpt-5.6-luna", effort: "high" },
    },
    timeout_minutes: 30,
  };
  assert.deepEqual((await update.json()).data, {
    ...updatedSettings,
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "high",
    timeout_ms: 30 * 60_000,
  });
  assert.equal(api.fake.settings().default_provider, "codex");
  assert.equal(api.fake.settings().default_model, "gpt-5.6-luna");
  assert.equal(api.fake.settings().default_effort, "high");
  assert.equal(api.fake.settings().timeout_minutes, 30);

  const unsetEffort = await api.request("/settings/executor", {
    method: "PUT",
    body: {
      request_id: "legacy-unset-effort", idempotency_key: "legacy-unset-effort", expected_version: 0,
      payload: { provider: "codex", model: "gpt-5.6-luna", effort: null, timeout_ms: 0 },
    },
  });
  assert.equal(unsetEffort.status, 200);
  assert.equal((await unsetEffort.json()).data.effort, null);
  assert.equal(api.fake.settings().default_effort, null);
});

test("app settings ignore the retired executor_config fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-child-run-app-settings-"));
  try {
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, "app-settings.json"), JSON.stringify({ hybrid_mode: false, executor_config: { provider: "bad" } }));
    const store = new AppSettingsStore(root, dataDir);
    assert.equal(store.getHybridMode(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("child-run routes return dependency_unavailable when the wrapped Core lacks the feature", async (t) => {
  const api = await setup(t, { missingChildApi: true });
  if (!api) return;
  const response = await api.request("/settings/child-runs");
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "dependency_unavailable");
});

test("an adapter-wrapped Core dispatches through HTTP from its public Worker run and lists records by Task", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-child-run-http-core-"));
  const bin = join(root, "bin");
  const records = join(root, "records");
  const guards = join(root, "guards");
  await Promise.all([mkdir(bin), mkdir(records), mkdir(guards)]);
  const fakeCli = [
    "#!/usr/bin/env node",
    "const { writeFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    "let prompt = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { prompt += chunk; });",
    "process.stdin.on('end', () => setTimeout(() => {",
    "  const provider = process.argv[1].endsWith('/codex') ? 'codex' : 'claude';",
    "  const report = '```owl-child-report\\n' + JSON.stringify({ result: 'succeeded', summary: provider + ' completed', changed_files: ['src/' + provider + '.ts'], checks: [], remaining_issues: [] }) + '\\n```';",
    "  writeFileSync(join(process.env.OWL_TEST_RECORD_DIR, process.env.OWL_AGENT_RUN_ID + '.json'), JSON.stringify({ provider, prompt }));",
    "  if (provider === 'codex') process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: report } }) + '\\n');",
    "  else process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: report }) + '\\n');",
    "}, Number(process.env.OWL_TEST_DELAY_MS || 0)));",
  ].join("\n");
  const claude = join(bin, "claude");
  const codex = join(bin, "codex");
  await Promise.all([writeFile(claude, fakeCli), writeFile(codex, fakeCli)]);
  await Promise.all([chmod(claude, 0o755), chmod(codex, 0o755)]);

  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  let activeWorkerId = null;
  let base = null;
  let releaseWorker;
  const workerGate = new Promise((resolve) => { releaseWorker = resolve; });
  let observeWorker;
  const workerObserved = new Promise((resolve) => { observeWorker = resolve; });
  const call = (path, payload, key) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: "Bearer http-worker-token", "content-type": "application/json" },
    body: JSON.stringify({ request_id: key, idempotency_key: key, expected_version: 0, payload }),
  });
  const agentRunner = {
    runManagerPlan: async () => { throw new Error("Small Work must start its Worker directly."); },
    runWorker: async (request) => {
      activeWorkerId = request.invocation_id;
      const rejected = await call("/agent/child-runs", {
        title: "Disallowed child", instruction: "Must be rejected", write_paths: ["src/no.ts"], provider: "codex", model: "not-allowed",
      }, "model-denied");
      const rejectedBody = await rejected.json();
      const dispatched = await call("/agent/child-runs", {
        title: "HTTP child", instruction: "Run through the fake provider", write_paths: ["src/http-child.ts"],
        provider: "codex", model: "gpt-5.6-luna", effort: "low",
      }, "dispatch-child");
      const dispatchedBody = await dispatched.json();
      const child = dispatchedBody.data;
      const waited = await call("/agent/child-runs/wait", {
        child_ids: [child.child_id], return_when: "any", timeout_seconds: 1,
      }, "wait-child");
      const waitedBody = await waited.json();
      observeWorker({
        agentRunId: request.invocation_id,
        taskId: request.task_id,
        rejectedStatus: rejected.status,
        rejected: rejectedBody,
        dispatchedStatus: dispatched.status,
        child,
        waitedStatus: waited.status,
        waited: waitedBody.data,
      });
      await workerGate;
      return {
        outcome: "success", report_valid: true,
        report: {
          kind: "report", schema_version: "1.0.0", invocation_id: request.invocation_id,
          result: "success", work_done: "Dispatched and waited for a child.", changes: [],
          verification: { passed: true, method: "Observed the child run through HTTP." },
          remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null,
        },
      };
    },
    runReviewer: async () => { throw new Error("Reviewer should not run."); },
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = new Core({
    db, agentRunner, version: "child-run-http-test", owlRoot: root,
    dispatcher: { tick_interval_ms: 10 },
    executorRuntime: () => ({
      owlRoot: repoRoot,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: root,
        OWL_TEST_RECORD_DIR: records, OWL_TEST_DELAY_MS: "5000",
      },
      executables: { claude, codex },
      guardToken: ({ agent_run_id }) => ({ file: join(guards, agent_run_id), release() {} }),
    }),
  });
  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  const previousToken = process.env.OWL_API_TOKEN;
  process.env.OWL_API_TOKEN = "http-owner-token";
  const http = createOwlHttpServer({
    core: adapter, webOut: root, bind: "127.0.0.1", port: 0,
    contract: { contract_version: "1.0.0" }, owlRoot: root,
    guardTokens: { verify: (token) => token === "http-worker-token" && activeWorkerId ? { agent_run_id: activeWorkerId, role: "worker" } : null },
  });
  t.after(async () => {
    releaseWorker();
    await http.close().catch(() => {});
    if (previousToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = previousToken;
    await core.stop({ force: true, timeoutMs: 1000 }).catch(() => {});
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  try {
    await http.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("listen not permitted"); return; }
    throw error;
  }
  base = `http://127.0.0.1:${http.server.address().port}/api/v1`;

  await core.start();
  const created = await core.createWork(envelope({
    title: "HTTP child run", summary: "Exercise the child run API.", size: "small", project_id: null,
  }, "create-work"));
  await core.startWork(created.data.work_id, envelope({ mode: "small" }, "start-work", created.version));
  const observed = await waitFor(() => workerObserved);
  assert.ok(observed, "Worker did not dispatch and wait for its child");
  assert.equal(observed.rejectedStatus, 400);
  assert.equal(observed.rejected.error.code, "model_not_allowed");
  assert.equal(observed.dispatchedStatus, 200);
  assert.equal(observed.child.status === "queued" || observed.child.status === "running", true);
  assert.ok(observed.child.child_id);
  assert.equal(observed.child.provider, "codex");
  assert.equal(observed.child.model, "gpt-5.6-luna");
  assert.equal(observed.child.effort, "low");
  assert.equal(observed.waitedStatus, 200);
  assert.equal(observed.waited.done, false);
  assert.equal(observed.waited.children[0].status, "running");

  const recordsResponse = await fetch(`${base}/child-runs?task_id=${observed.taskId}`, { headers: { authorization: "Bearer http-owner-token" } });
  assert.equal(recordsResponse.status, 200);
  const recordsBody = await recordsResponse.json();
  assert.equal(recordsBody.data.length, 1);
  assert.equal(recordsBody.data[0].id, observed.child.child_id);
  assert.equal(recordsBody.data[0].parent_agent_run_id, observed.agentRunId);
  assert.equal(recordsBody.data[0].provider, "codex");
  assert.equal(recordsBody.data[0].task_id, observed.taskId);
  const childAgent = db.get("SELECT provider, parent_agent_id FROM agent_runs WHERE child_run_id = ?", observed.child.child_id);
  assert.deepEqual(childAgent, { provider: "codex", parent_agent_id: observed.agentRunId });
  const recordFile = await waitFor(async () => {
    const run = db.get("SELECT id FROM agent_runs WHERE child_run_id = ?", observed.child.child_id);
    if (!run) return null;
    return readFile(join(records, `${run.id}.json`), "utf8").catch(() => null);
  });
  assert.equal(JSON.parse(recordFile).provider, "codex");
});
