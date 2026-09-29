import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { Core, NoopGitGateway, WorkflowEngine, createProviderPauseController, createProviderPauseStore, createTaskPlanInTransaction, createWorkInTransaction } from "../packages/core/dist/index.js";
import { openDatabase } from "../packages/db/dist/index.js";
import * as runtime from "../packages/agent-runtime/dist/index.js";

const migrations = join(resolve(process.cwd()), "packages/db/migrations");
const NOW = "2030-01-02T03:04:05.000Z";

function fakeClock(initial = NOW) {
  let current = Date.parse(initial);
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => new Date(current).toISOString(),
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, at: current + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(milliseconds) {
      current += milliseconds;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= current).sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        for (const [id, timer] of due) {
          if (timers.delete(id)) timer.callback();
        }
        await new Promise((resolvePromise) => setImmediate(resolvePromise));
      }
    },
  };
}

async function temporaryDatabase(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-provider-pause-e2e-"));
  const db = openDatabase(join(root, "owl.sqlite"));
  db.migrate(migrations);
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, db, onCleanup: (cleanup) => cleanups.push(cleanup) };
}

async function seedWork(db, clock, { tasks = ["WORK"], state = "running", workerProvider = "anthropic" } = {}) {
  return db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Provider pause E2E", summary: "Resume work after a provider limit", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = ? WHERE id = ?", state, work.id);
    const created = createTaskPlanInTransaction(tx, work.id, tasks.map((id) => ({
      id, title: id, type: "doc", acceptance: "Complete", depends_on: [],
    })));
    tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('model_settings', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify({ version: 1, roles: [
        { role: "manager", provider: "anthropic", model: "provider-test-manager" },
        { role: "worker", provider: workerProvider, model: "provider-test-model" },
        { role: "reviewer", provider: "openai", model: "provider-test-reviewer" },
      ] }), clock.now());
    return { workId: work.id, taskIds: created.map((task) => task.id) };
  });
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise));
}

async function waitUntil(predicate, label) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function makeWorkflow(temp, clock, workId, agentRunner, onReplan = async () => {}) {
  const store = createProviderPauseStore(temp.db, clock.now);
  let workflow;
  const events = [];
  const controller = createProviderPauseController({
    store,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    emitEvent: async (event) => events.push(event.type),
    onResume: async () => { await workflow.launchReady(workId); },
  });
  workflow = new WorkflowEngine({
    db: temp.db,
    agentRunner,
    git: new NoopGitGateway(),
    owlRoot: temp.root,
    dataDir: temp.root,
    providerPauseController: controller,
    onManagerReplanNeeded: onReplan,
  });
  temp.onCleanup(async () => { controller.stop(); await workflow.stop(); });
  workflow.start();
  controller.start();
  return { workflow, controller, store, events };
}

function success() {
  return { outcome: "success", report_valid: true, report: { result: "success", verification: { passed: true } }, skill_feedback: null };
}

test("a reported rate limit preserves Task counters and completes automatically at the resume time", async (t) => {
  const temp = await temporaryDatabase(t);
  const clock = fakeClock();
  const { workId } = await seedWork(temp.db, clock);
  let attempts = 0;
  const replans = [];
  const { workflow, store, events } = makeWorkflow(temp, clock, workId, {
    runWorker: async () => {
      attempts += 1;
      return attempts === 1
        ? { outcome: "failed", failure_class: "rate_limited", error_key: "rate_limited", rate_limit: { resets_at: "2030-01-02T03:04:35.000Z", source: "event" }, message: "limit", skill_feedback: null }
        : success();
    },
  }, async (input) => replans.push(input));
  const taskId = temp.db.get("SELECT id FROM tasks WHERE manager_task_id = 'WORK'").id;

  await workflow.resolveDependencies(workId);
  await workflow.launchReady(workId);
  await workflow.drainPipelines();
  const paused = temp.db.get("SELECT status, retry_no, failure_count, same_error_count FROM tasks WHERE id = ?", taskId);
  assert.deepEqual(paused, { status: "ready", retry_no: 0, failure_count: 0, same_error_count: 0 });
  assert.equal(store.list()[0].resume_at, "2030-01-02T03:05:05.000Z");
  assert.deepEqual(replans, []);

  await clock.advance(60_000);
  await waitUntil(() => attempts === 2, "Task retry at the reported resume time");
  await workflow.drainPipelines();
  const completed = temp.db.get("SELECT status, retry_no, failure_count, same_error_count FROM tasks WHERE id = ?", taskId);
  assert.deepEqual(completed, { status: "completed", retry_no: 0, failure_count: 0, same_error_count: 0 });
  assert.deepEqual(events, ["provider.paused", "provider.resumed"]);
  assert.deepEqual(replans, []);
});

test("a Claude session limit pauses until its reset, waits out a late reset, then completes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  const temp = await temporaryDatabase(t);
  const clock = fakeClock();
  const { workId } = await seedWork(temp.db, clock);
  // The final result object from a limited Claude stream.
  const limited = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: 429,
    result: "You've hit your session limit · resets 4am (UTC)",
  });
  const claude = runtime.createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => ({ adapter: request.adapter, stdout: limited, stderr: "", exit_code: 1, signal: null, format: "provider-json" }),
    },
  });
  const advance = async (milliseconds) => {
    t.mock.timers.setTime(Date.parse(clock.now()) + milliseconds);
    await clock.advance(milliseconds);
  };
  let attempts = 0;
  const { workflow, store, events } = makeWorkflow(temp, clock, workId, {
    runWorker: async (input) => {
      attempts += 1;
      return attempts <= 2 ? claude.runWorker(input) : success();
    },
  });
  const taskId = temp.db.get("SELECT id FROM tasks WHERE manager_task_id = 'WORK'").id;

  await workflow.resolveDependencies(workId);
  await workflow.launchReady(workId);
  await workflow.drainPipelines();
  assert.equal(temp.db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "ready");
  assert.equal(store.list()[0].provider, "anthropic");
  assert.equal(store.list()[0].resume_at, "2030-01-02T04:00:30.000Z");

  // The provider still refuses just after the reset it reported: retry in a minute, not tomorrow.
  await advance(Date.parse("2030-01-02T04:00:30.000Z") - Date.parse(clock.now()));
  await waitUntil(() => attempts === 2, "Claude retry at the reported reset");
  await workflow.drainPipelines();
  assert.equal(temp.db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "ready");
  assert.equal(store.list()[0].resume_at, "2030-01-02T04:02:00.000Z");

  await advance(90_000);
  await waitUntil(() => attempts === 3, "Claude retry after the late reset");
  await workflow.drainPipelines();
  assert.equal(temp.db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "completed");
  assert.deepEqual(store.list(), []);
  assert.deepEqual(events, ["provider.paused", "provider.resumed", "provider.paused", "provider.resumed"]);
});

test("missing reset times back off by 15, 30, 60, then 60 minutes", async (t) => {
  const temp = await temporaryDatabase(t);
  const clock = fakeClock();
  const { workId } = await seedWork(temp.db, clock);
  let attempts = 0;
  const { workflow, store } = makeWorkflow(temp, clock, workId, {
    runWorker: async () => {
      attempts += 1;
      return { outcome: "failed", failure_class: "rate_limited", error_key: "rate_limited", rate_limit: { resets_at: null, source: null }, message: "limit", skill_feedback: null };
    },
  });
  await workflow.resolveDependencies(workId);
  await workflow.launchReady(workId);
  await workflow.drainPipelines();

  for (const [index, minutes] of [15, 30, 60, 60].entries()) {
    const pause = store.list()[0];
    assert.equal(pause.backoff_step, index);
    assert.equal(Date.parse(pause.resume_at) - Date.parse(clock.now()), minutes * 60_000);
    await clock.advance(minutes * 60_000);
    await waitUntil(() => attempts === index + 2, `rate-limit attempt ${index + 2}`);
    await workflow.drainPipelines();
  }
  assert.equal(attempts, 5);
});

test("Core restart preserves a paused Task and its deadline, then resumes it", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(NOW) });
  const temp = await temporaryDatabase(t);
  const clock = { now: () => new Date().toISOString() };
  const { workId, taskIds: [taskId] } = await seedWork(temp.db, clock, { state: "ready" });
  let attempts = 0;
  const agentRunner = {
    runWorker: async () => {
      attempts += 1;
      return attempts === 1
        ? { outcome: "failed", failure_class: "rate_limited", error_key: "rate_limited", rate_limit: { resets_at: "2030-01-02T03:04:35.000Z", source: "event" }, message: "limit", skill_feedback: null }
        : success();
    },
  };
  const makeCore = () => new Core({
    db: temp.db, agentRunner, version: "provider-pause-e2e", owlRoot: temp.root, git: new NoopGitGateway(),
    dispatcher: { tick_interval_ms: 60_000 }, now: clock.now,
  });
  let firstCore = makeCore();
  temp.onCleanup(async () => { await firstCore.stop({ force: true }); });
  await firstCore.start();
  await temp.db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId));
  await firstCore.tick(workId);
  await firstCore.workflow.drainPipelines();
  const savedPause = createProviderPauseStore(temp.db, clock.now).list()[0];
  assert.equal(savedPause.state, "paused");
  assert.equal(savedPause.resume_at, "2030-01-02T03:05:05.000Z");
  assert.equal(temp.db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "ready");

  await firstCore.stop({ force: true });
  firstCore = makeCore();
  await firstCore.start();
  assert.deepEqual(createProviderPauseStore(temp.db, clock.now).list(), [savedPause]);
  assert.equal(temp.db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "ready");

  t.mock.timers.tick(60_000);
  await waitUntil(() => attempts === 2, "Task retry after Core restart");
  await firstCore.workflow.drainPipelines();
  assert.equal(temp.db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "completed");
});

test("a paused Provider's Task is withheld while a different Provider's Task runs", async (t) => {
  const temp = await temporaryDatabase(t);
  const clock = fakeClock();
  const { workId } = await seedWork(temp.db, clock);
  const attempts = new Map();
  const runOtherProvider = async ({ task_id: taskId }) => {
    attempts.set(taskId, (attempts.get(taskId) ?? 0) + 1);
    return { outcome: "failed", failure_class: "transient", error_key: "temporary", retry_allowed: true, skill_feedback: null };
  };
  const { workflow, controller } = makeWorkflow(temp, clock, workId, {
    runWorker: async ({ task_id: taskId }) => {
      attempts.set(taskId, (attempts.get(taskId) ?? 0) + 1);
      return { outcome: "failed", failure_class: "rate_limited", error_key: "rate_limited", rate_limit: { resets_at: null, source: null }, message: "limit", skill_feedback: null };
    },
    runDesigner: runOtherProvider,
  });
  await workflow.resolveDependencies(workId);
  await workflow.launchReady(workId);
  await workflow.drainPipelines();
  assert.equal(controller.isPaused("anthropic"), true);

  const [blockedTaskId, otherTaskId] = await temp.db.createWriteLane().transact((tx) => {
    const [blocked, other] = createTaskPlanInTransaction(tx, workId, [
      { id: "BLOCKED", title: "Anthropic task", type: "doc", acceptance: "Complete", depends_on: [] },
      { id: "OTHER", title: "OpenAI task", type: "doc", acceptance: "Complete", depends_on: [] },
    ]);
    tx.run("UPDATE settings SET value_json = ? WHERE key = 'model_settings'",
      JSON.stringify({ version: 1, roles: [
        { role: "worker", provider: "anthropic", model: "provider-test-model" },
        { role: "designer", provider: "openai", model: "provider-test-model" },
      ] }));
    return [blocked.id, other.id];
  });
  // The openai Task uses the Designer role so it can proceed beside the paused Worker.
  await temp.db.createWriteLane().transact((tx) => tx.run("UPDATE tasks SET type = 'design' WHERE id = ?", otherTaskId));
  await workflow.resolveDependencies(workId);
  const launched = await workflow.launchReady(workId);
  await workflow.drainPipelines();

  assert.deepEqual(launched, [otherTaskId]);
  assert.equal(attempts.get(blockedTaskId) ?? 0, 0);
  assert.equal(attempts.get(otherTaskId), 1);
  assert.equal(temp.db.get("SELECT COUNT(*) AS count FROM agent_runs WHERE task_id = ?", blockedTaskId).count, 0);
});

test("a rate-limited initial Manager plan is retried after resume without failing the Work", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(NOW) });
  const temp = await temporaryDatabase(t);
  const clock = { now: () => new Date().toISOString() };
  const { workId } = await seedWork(temp.db, clock, { tasks: [], state: "ready" });
  let managerCalls = 0;
  const core = new Core({
    db: temp.db,
    agentRunner: {
      runManagerPlan: async () => {
        managerCalls += 1;
        if (managerCalls === 1) return {
          outcome: "failed", failure_class: "rate_limited", error_key: "rate_limited",
          rate_limit: { resets_at: NOW, source: "event" }, message: "limit", skill_feedback: null,
        };
        return {
          outcome: "success", report_valid: true, skill_feedback: null,
          report: { result: "success", event: "work.planned", tasks: [
            { id: "INITIAL", title: "First Task", type: "doc", acceptance: "Complete", depends_on: [], replaces: [] },
          ] },
        };
      },
    },
    version: "provider-pause-e2e", owlRoot: temp.root, git: new NoopGitGateway(),
    dispatcher: { tick_interval_ms: 60_000 }, now: clock.now,
  });
  temp.onCleanup(async () => { await core.stop({ force: true }); await flush(); });
  await core.start();
  await temp.db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId));
  await core.tick(workId);
  assert.equal(managerCalls, 1);
  assert.equal(temp.db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  assert.equal(temp.db.get("SELECT COUNT(*) AS count FROM tasks WHERE work_id = ?", workId).count, 0);
  assert.equal(temp.db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'manager.failed'").count, 0);

  t.mock.timers.tick(30_000);
  await waitUntil(() => managerCalls === 2, "initial Manager plan after Provider resume");
  assert.equal(temp.db.get("SELECT COUNT(*) AS count FROM tasks WHERE work_id = ?", workId).count, 1);
  assert.equal(temp.db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  assert.equal(temp.db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'manager.failed'").count, 0);
});

test("overloaded and HTTP 529 failures retry as transient without pausing the Provider", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(NOW) });
  const temp = await temporaryDatabase(t);
  const clock = { now: () => new Date().toISOString() };
  const { workId } = await seedWork(temp.db, clock);
  const causes = [
    { exit_code: 1, signal: null, kind: "exit", stderr: "Overloaded (rate limit)" },
    { exit_code: 1, signal: null, kind: "harness_error", harness_status: 529, harness_code: "serverOverloaded" },
  ];
  let attempts = 0;
  const store = createProviderPauseStore(temp.db, clock.now);
  const controller = createProviderPauseController({ store, now: clock.now });
  const workflow = new WorkflowEngine({
    db: temp.db,
    agentRunner: {
      runWorker: async () => {
        attempts += 1;
        if (attempts <= causes.length) {
          const classified = runtime.classifyProviderFailure("claude-cli/v1", causes[attempts - 1], "en", new Date(clock.now()));
          assert.equal(classified.failure_class, "transient");
          assert.equal(classified.retry_allowed, true);
          assert.equal(classified.rate_limit, undefined);
          return { outcome: "failed", ...classified, skill_feedback: null };
        }
        return success();
      },
    },
    git: new NoopGitGateway(), owlRoot: temp.root, dataDir: temp.root, providerPauseController: controller,
  });
  temp.onCleanup(async () => { controller.stop(); await workflow.stop(); });
  controller.start();
  workflow.start();
  await workflow.resolveDependencies(workId);
  const [taskId] = await workflow.launchReady(workId);
  await workflow.drainPipelines();
  assert.equal(temp.db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "ready");
  assert.equal(temp.db.get("SELECT retry_no FROM tasks WHERE id = ?", taskId).retry_no, 1);
  assert.equal(store.list().length, 0);

  let nextAttemptAt = temp.db.get("SELECT next_attempt_at FROM tasks WHERE id = ?", taskId).next_attempt_at;
  t.mock.timers.tick(Date.parse(nextAttemptAt) - Date.now());
  await workflow.launchReady(workId);
  await workflow.drainPipelines();
  assert.equal(temp.db.get("SELECT retry_no FROM tasks WHERE id = ?", taskId).retry_no, 2);
  assert.equal(store.list().length, 0);

  nextAttemptAt = temp.db.get("SELECT next_attempt_at FROM tasks WHERE id = ?", taskId).next_attempt_at;
  t.mock.timers.tick(Date.parse(nextAttemptAt) - Date.now());
  await workflow.launchReady(workId);
  await workflow.drainPipelines();
  assert.equal(attempts, 3);
  assert.equal(temp.db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "completed");
  assert.equal(temp.db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'provider.paused'").count, 0);
});
