import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { AdvisorSessionManager, AdvisorSessionRuntime, Core, createTaskPlanInTransaction, createWorkInTransaction, createProviderPauseController, createProviderPauseStore, NoopGitGateway, WorkflowEngine } from "../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";
import { DEFAULT_ROLE_MODELS } from "../packages/shared/dist/index.js";

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
          if (!timers.delete(id)) continue;
          timer.callback();
        }
        await new Promise((resolvePromise) => setImmediate(resolvePromise));
      }
    },
  };
}

async function dbInTemp() {
  const root = await mkdtemp(join(tmpdir(), "owl-provider-pause-engine-"));
  const db = openDatabase(join(root, "owl.sqlite"));
  db.migrate(migrations);
  return { root, db };
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise));
}

// For tests with mocked setTimeout: yield to the event loop until the predicate holds.
async function flushUntil(predicate, label) {
  for (let i = 0; i < 500 && !predicate(); i += 1) await flush();
  if (!predicate()) throw new Error(`timed out waiting for ${label}`);
}

async function waitUntil(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function unsetDefaultRoleModels(t, ...roles) {
  const saved = new Map(roles.map((role) => [role, DEFAULT_ROLE_MODELS[role]]));
  // Exercise the resolver's undefined-model branch without storing role-specific settings.
  for (const role of roles) delete DEFAULT_ROLE_MODELS[role];
  t.after(() => {
    for (const [role, model] of saved) DEFAULT_ROLE_MODELS[role] = model;
  });
}

function mutablePausedProviders() {
  const paused = new Set();
  return {
    paused,
    controller: {
      isPaused: (provider) => paused.has(provider === "claude" ? "anthropic" : provider === "codex" ? "openai" : provider),
      noteProviderSucceeded: async () => {},
    },
  };
}

test("a Task without a role model uses the default Provider in both launch pause checks", async (t) => {
  unsetDefaultRoleModels(t, "worker");
  const { root, db } = await dbInTemp();
  const workId = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Default provider pause", summary: "Wait for Anthropic", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    createTaskPlanInTransaction(tx, work.id, [{ id: "WORK", title: "Implement", type: "doc", acceptance: "Change", depends_on: [] }]);
    return work.id;
  });
  const providerState = mutablePausedProviders();
  let prepareCount = 0;
  let workerAttempts = 0;
  let workerProvider;
  const workflow = new WorkflowEngine({
    db,
    agentRunner: {
      runWorker: async (request) => {
        workerAttempts += 1;
        workerProvider = request.provider;
        return { outcome: "failed", failure_class: "transient", error_key: "temporary", retry_allowed: true, skill_feedback: null };
      },
    },
    git: Object.assign(new NoopGitGateway(), {
      prepareWorktree: async () => {
        prepareCount += 1;
        if (prepareCount === 1) providerState.paused.add("anthropic");
        return { ok: true, worktree_path: root };
      },
    }),
    owlRoot: root,
    dataDir: root,
    providerPauseController: providerState.controller,
  });
  t.after(async () => { await workflow.stop(); db.close(); await rm(root, { recursive: true, force: true }); });
  workflow.start();
  await workflow.resolveDependencies(workId);
  const taskId = db.get("SELECT id FROM tasks WHERE manager_task_id = 'WORK'").id;

  assert.deepEqual(await workflow.launchReady(workId), [], "the transaction rechecks after Anthropic pauses during worktree preparation");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM agent_runs WHERE task_id = ?", taskId).count, 0);
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "ready");
  assert.deepEqual(await workflow.launchReady(workId), [], "a pre-paused default Provider is skipped before preparing the worktree");
  assert.equal(prepareCount, 1);

  providerState.paused.clear();
  providerState.paused.add("openai");
  assert.deepEqual(await workflow.launchReady(workId), [taskId], "a different paused Provider does not block the Anthropic default");
  await workflow.drainPipelines();
  assert.equal(workerAttempts, 1);
  assert.equal(workerProvider, "anthropic", "the fallback Provider is passed to the Worker");
  assert.equal(db.get("SELECT provider FROM agent_runs WHERE task_id = ?", taskId).provider, "anthropic");
});

test("a Reviewer without a role model is withheld while the default Provider is paused", async (t) => {
  unsetDefaultRoleModels(t, "reviewer");
  const { root, db } = await dbInTemp();
  const workId = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Default reviewer provider", summary: "Wait for Anthropic", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    const [task] = createTaskPlanInTransaction(tx, work.id, [{ id: "REVIEW", title: "Review me", type: "code", acceptance: "Pass", depends_on: [] }]);
    tx.run("UPDATE tasks SET review_override = 'true' WHERE id = ?", task.id);
    return work.id;
  });
  const providerState = mutablePausedProviders();
  providerState.paused.add("anthropic");
  let workerAttempts = 0;
  let reviewerAttempts = 0;
  const workflow = new WorkflowEngine({
    db,
    agentRunner: {
      runWorker: async () => {
        workerAttempts += 1;
        return { outcome: "success", report_valid: true, report: { result: "success", verification: { passed: true } }, skill_feedback: null };
      },
      runReviewer: async () => {
        reviewerAttempts += 1;
        return { outcome: "success", report_valid: true, report: { result: "success" }, review: { verdict: "pass", findings: [], tests: { passed: true } }, skill_feedback: null };
      },
    },
    git: new NoopGitGateway(),
    owlRoot: root,
    dataDir: root,
    providerPauseController: providerState.controller,
  });
  t.after(async () => { await workflow.stop(); db.close(); await rm(root, { recursive: true, force: true }); });
  workflow.start();
  await workflow.resolveDependencies(workId);
  const launched = await workflow.launchReady(workId);
  assert.equal(launched.length, 1);
  await workflow.drainPipelines();

  const taskId = db.get("SELECT id FROM tasks WHERE manager_task_id = 'REVIEW'").id;
  assert.equal(workerAttempts, 1, "the OpenAI backed Worker can run while Anthropic is paused");
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "verifying");
  assert.equal(reviewerAttempts, 0);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM agent_runs WHERE task_id = ? AND role = 'reviewer'", taskId).count, 0);
});

test("rate-limited Task keeps its counters and worktree while another provider runs; resume retries it", async (t) => {
  const { root, db } = await dbInTemp();
  const clock = fakeClock();
  const store = createProviderPauseStore(db, clock.now);
  const workId = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Provider pause", summary: "Continue with other providers", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    createTaskPlanInTransaction(tx, work.id, [
      { id: "DESIGN", title: "Design", type: "design", acceptance: "Document", depends_on: [] },
      { id: "WORK", title: "Implement", type: "doc", acceptance: "Change", depends_on: [] },
    ]);
    tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('model_settings', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify({ version: 1, roles: [
        { role: "designer", provider: "anthropic", model: "claude-test" },
        { role: "worker", provider: "openai", model: "codex-test" },
      ] }), clock.now());
    return work.id;
  });

  let workflow;
  let designerAttempts = 0;
  let workerAttempts = 0;
  const replans = [];
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
    db,
    agentRunner: {
      runDesigner: async () => {
        designerAttempts += 1;
        return designerAttempts === 1
          ? { outcome: "failed", failure_class: "rate_limited", error_key: "rate_limited", rate_limit: { resets_at: "2030-01-02T03:04:35.000Z", source: "event" }, message: "limit", skill_feedback: null }
          : { outcome: "failed", failure_class: "transient", error_key: "temporary", retry_allowed: true, skill_feedback: null };
      },
      runWorker: async () => {
        workerAttempts += 1;
        return { outcome: "failed", failure_class: "transient", error_key: "temporary", retry_allowed: true, skill_feedback: null };
      },
    },
    git: Object.assign(new NoopGitGateway(), { prepareWorktree: async () => ({ ok: true, worktree_path: root }) }),
    owlRoot: root,
    dataDir: root,
    providerPauseController: controller,
    onManagerReplanNeeded: async (input) => replans.push(input),
  });
  t.after(async () => { controller.stop(); await workflow.stop(); db.close(); await rm(root, { recursive: true, force: true }); });
  workflow.start();
  controller.start();
  await workflow.resolveDependencies(workId);
  const launched = await workflow.launchReady(workId);
  assert.deepEqual(launched.sort(), [
    db.get("SELECT id FROM tasks WHERE manager_task_id = 'DESIGN'").id,
    db.get("SELECT id FROM tasks WHERE manager_task_id = 'WORK'").id,
  ].sort());
  await workflow.drainPipelines();

  const design = db.get("SELECT status, retry_no, failure_count, same_error_count, worktree_state FROM tasks WHERE manager_task_id = 'DESIGN'");
  assert.equal(design.status, "ready");
  assert.equal(design.retry_no, 0);
  assert.equal(design.failure_count, 0);
  assert.equal(design.same_error_count, 0);
  assert.equal(design.worktree_state, "active");
  assert.equal(db.get("SELECT status FROM tasks WHERE manager_task_id = 'WORK'").status, "ready");
  assert.equal(workerAttempts, 1, "the OpenAI backed Task ran while Anthropic was paused");
  assert.deepEqual(replans, []);
  assert.equal(controller.isPaused("claude"), true);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'task.rate_limited'").count, 1);

  await workflow.launchReady(workId);
  assert.equal(designerAttempts, 1, "a second Anthropic Task attempt is withheld during its pause");
  await clock.advance(60_000);
  await flush();
  await workflow.drainPipelines();
  assert.equal(designerAttempts, 2, "the Task is retried when the provider timer resumes");
  const retried = db.get("SELECT status, retry_no, failure_count, same_error_count FROM tasks WHERE manager_task_id = 'DESIGN'");
  assert.equal(retried.status, "ready");
  assert.equal(retried.retry_no, 1, "only the later transient failure increments retry_no");
  assert.equal(retried.failure_count, 0);
  assert.equal(retried.same_error_count, 0);
  assert.deepEqual(events, ["provider.paused", "provider.resumed"]);
  assert.deepEqual(replans, []);
});

test("a rate-limited Reviewer resumes without consuming Reviewer failures", async (t) => {
  const { root, db } = await dbInTemp();
  const clock = fakeClock();
  const store = createProviderPauseStore(db, clock.now);
  const workId = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Review pause", summary: "Retry review", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    const [task] = createTaskPlanInTransaction(tx, work.id, [{ id: "REVIEW", title: "Review me", type: "code", acceptance: "Pass", depends_on: [] }]);
    tx.run("UPDATE tasks SET review_override = 'true' WHERE id = ?", task.id);
    tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('model_settings', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify({ version: 1, roles: [
        { role: "worker", provider: "openai", model: "codex-test" },
        { role: "reviewer", provider: "anthropic", model: "claude-test" },
      ] }), clock.now());
    return work.id;
  });
  let workflow;
  let reviewerAttempts = 0;
  const controller = createProviderPauseController({
    store,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onResume: async (provider) => workflow.resumeProvider(provider),
  });
  workflow = new WorkflowEngine({
    db,
    agentRunner: {
      runWorker: async () => ({
        outcome: "success", report_valid: true,
        report: { result: "success", verification: { passed: true } },
        skill_feedback: null,
      }),
      runReviewer: async () => {
        reviewerAttempts += 1;
        if (reviewerAttempts === 1) return {
          outcome: "failed", failure_class: "rate_limited", error_key: "rate_limited",
          rate_limit: { resets_at: NOW, source: "event" }, message: "limit", skill_feedback: null,
        };
        return {
          outcome: "success", report_valid: true, report: { result: "success" },
          review: { verdict: "pass", findings: [], tests: { passed: true } }, skill_feedback: null,
        };
      },
    },
    git: new NoopGitGateway(),
    owlRoot: root,
    dataDir: root,
    providerPauseController: controller,
  });
  t.after(async () => { controller.stop(); await workflow.stop(); db.close(); await rm(root, { recursive: true, force: true }); });
  workflow.start();
  controller.start();
  await workflow.resolveDependencies(workId);
  await workflow.launchReady(workId);
  await workflow.drainPipelines();

  const taskId = db.get("SELECT id FROM tasks WHERE manager_task_id = 'REVIEW'").id;
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "verifying");
  assert.equal(db.get("SELECT reviewer_failure_count FROM tasks WHERE id = ?", taskId).reviewer_failure_count, 0);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'review.failed'").count, 0);
  assert.equal(db.get("SELECT status FROM agent_runs WHERE role = 'reviewer'").status, "exited");

  await clock.advance(30_000);
  for (let i = 0; i < 30 && db.get("SELECT status FROM tasks WHERE id = ?", taskId).status !== "completed"; i += 1) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  assert.equal(reviewerAttempts, 2);
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "completed");
  assert.equal(db.get("SELECT reviewer_failure_count FROM tasks WHERE id = ?", taskId).reviewer_failure_count, 0);
});

test("an Advisor rate limit replies with the reset time, pauses the provider and never resends the turn", async (t) => {
  const { root, db } = await dbInTemp();
  const clock = fakeClock();
  const ownerId = createUlid();
  const accountId = createUlid();
  const conversationId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, 'Owner', ?, ?)", ownerId, clock.now(), clock.now());
    tx.run("INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'web', ?, ?)", accountId, ownerId, `web:${ownerId}`, clock.now());
    tx.run("INSERT INTO conversations (id, owner_id, channel, is_active, created_at, updated_at) VALUES (?, ?, 'web', 1, ?, ?)", conversationId, ownerId, clock.now(), clock.now());
  });
  const messageId = createUlid();
  await db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
     VALUES (?, ?, 'web', ?, ?, 'question', '[]', ?, ?)`,
    messageId, conversationId, accountId, `web-user:${messageId}`, clock.now(), clock.now(),
  ));
  const sent = [];
  const queued = [];
  const waiters = [];
  let providerPauseController;
  let runtime;
  const providerSession = {
    pid: 901,
    provider_session_id: "advisor-provider-session",
    exited: false,
    async send(turn) {
      sent.push(turn);
      setImmediate(() => {
        const event = sent.length === 1
          ? { type: "turn.failed", turn_id: turn.turn_id, error: "limit", rate_limit: { resets_at: "2030-01-02T03:04:10.000Z", source: "event" } }
          : { type: "turn.completed", turn_id: turn.turn_id, reply: "recovered reply", usage: null };
        const waiter = waiters.shift();
        if (waiter) waiter({ value: event, done: false });
        else queued.push(event);
      });
    },
    events() {
      return { [Symbol.asyncIterator]() { return { next() {
        const event = queued.shift();
        if (event) return Promise.resolve({ value: event, done: false });
        return new Promise((resolveNext) => waiters.push(resolveNext));
      } }; } };
    },
    async stop() {},
  };
  const errors = [];
  const replies = [];
  runtime = new AdvisorSessionRuntime({
    db,
    sessionManager: new AdvisorSessionManager(db),
    memorySaver: {},
    providerClient: { createSession: async () => providerSession },
    owlRoot: root,
    git: { prepareAdvisorWorkspace: async () => ({ ok: true, worktree_path: root }) },
    getAdvisorSettings: () => ({ providerId: "anthropic", harnessId: "claude", model: "claude-test", systemPrompt: "Advisor" }),
    resolveAttachmentPaths: () => ({ paths: [], notes: [] }),
    isProviderPaused: (provider) => providerPauseController.isPaused(provider),
    onProviderRateLimited: async (provider, rateLimit) => providerPauseController.recordRateLimit({ provider, resets_at: rateLimit.resets_at, role: "advisor" }),
    onProviderSucceeded: async (provider, startedAt) => providerPauseController.noteProviderSucceeded(provider, startedAt),
    onReply: async (_conversationId, reply) => { replies.push(reply); return null; },
    onError: async (_conversationId, error) => errors.push(error),
  });
  providerPauseController = createProviderPauseController({
    store: createProviderPauseStore(db, clock.now),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onResume: async (provider) => runtime.resumeProvider(provider),
  });
  t.after(async () => {
    providerPauseController.stop();
    await runtime.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  providerPauseController.start();
  const session = await runtime.ensureSession(ownerId, conversationId);
  const turnId = await runtime.enqueueTurn(session.id, conversationId, messageId, { turn_id: "", text: "question", origin: { channel: "web" } });
  await waitUntil(() => replies.length === 1 && providerPauseController.isPaused("anthropic"), "Advisor rate-limit reply");
  assert.equal(db.get("SELECT status FROM advisor_turns WHERE id = ?", turnId).status, "failed");
  assert.match(replies[0], /ごろ解除/u);
  assert.deepEqual(errors, []);
  assert.equal(sent.length, 1);

  await clock.advance(35_000);
  await flush();
  assert.equal(providerPauseController.isPaused("anthropic"), false);
  assert.equal(sent.length, 1, "the rate-limited request must not be resent after the provider resumes");
  assert.equal(replies.length, 1);
  assert.deepEqual(errors, []);
});

test("a Manager replan rate limit is requeued and retried after persisted pause recovery", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(NOW) });
  const { root, db } = await dbInTemp();
  const workId = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Replan pause", summary: "Retry the Manager", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    const [task] = createTaskPlanInTransaction(tx, work.id, [{ id: "FAILED", title: "Failed", type: "doc", acceptance: "Retry", depends_on: [] }]);
    tx.run("UPDATE tasks SET status = 'failed' WHERE id = ?", task.id);
    tx.run(
      `INSERT INTO idempotency_keys (key, request_hash, response_json, status_code, created_at, expires_at)
       VALUES (?, ?, ?, 202, ?, ?)`,
      `manager-trigger:${task.id}`, "0".repeat(64), JSON.stringify({ status: "queued" }), NOW, "2031-01-02T03:04:05.000Z",
    );
    return work.id;
  });
  let managerCalls = 0;
  const agentRunner = {
    runManagerPlan: async () => {
      managerCalls += 1;
      if (managerCalls === 1) return {
        outcome: "failed", failure_class: "rate_limited", error_key: "rate_limited",
        rate_limit: { resets_at: NOW, source: "event" }, message: "limit", skill_feedback: null,
      };
      return {
        outcome: "success", report_valid: true, skill_feedback: null,
        report: { result: "success", event: "task.replanned", tasks: [
          { id: "REPLACEMENT", title: "Replacement", type: "doc", acceptance: "Continue", depends_on: [], replaces: ["FAILED"] },
        ] },
      };
    },
    runWorker: async () => ({ outcome: "failed", failure_class: "transient", error_key: "temporary", retry_allowed: true, skill_feedback: null }),
    runReviewer: async () => ({ outcome: "failed", skill_feedback: null }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = new Core({ db, agentRunner, version: "provider-pause-replan-test", owlRoot: root, dispatcher: { tick_interval_ms: 60_000 }, now: () => new Date().toISOString() });
  t.after(async () => { await core.stop({ force: true }); await flush(); db.close(); await rm(root, { recursive: true, force: true }); });
  await core.start();
  const taskId = db.get("SELECT id FROM tasks WHERE work_id = ?", workId).id;

  await core.tick(workId);
  assert.equal(managerCalls, 1);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "failed");
  assert.equal(db.get("SELECT status FROM agent_runs WHERE role = 'manager' ORDER BY created_at DESC LIMIT 1").status, "exited");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'manager.failed'").count, 0);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM decisions WHERE status = 'open'").count, 0);
  assert.equal(JSON.parse(db.get("SELECT response_json FROM idempotency_keys WHERE key = ?", `manager-trigger:${taskId}`).response_json).status, "queued");

  t.mock.timers.tick(30_000);
  await flushUntil(() => db.get("SELECT status FROM tasks WHERE manager_task_id = 'REPLACEMENT'")?.status === "waiting", "requeued replan");
  assert.equal(managerCalls, 2, "the Work driver retries the queued replan when provider.resumed fires");
  assert.equal(db.get("SELECT status FROM tasks WHERE manager_task_id = 'REPLACEMENT'").status, "waiting");
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "cancelled");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'provider.paused'").count, 1);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'provider.resumed'").count, 1);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM decisions WHERE status = 'open'").count, 0);
});

test("an initial Manager plan rate limit leaves the Work running and retries after resume", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(NOW) });
  const { root, db } = await dbInTemp();
  const workId = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Initial plan pause", summary: "Plan after resume", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    return work.id;
  });
  let managerCalls = 0;
  const core = new Core({
    db,
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
      runWorker: async () => ({ outcome: "failed", failure_class: "transient", error_key: "temporary", retry_allowed: true, skill_feedback: null }),
      runReviewer: async () => ({ outcome: "failed", skill_feedback: null }),
      runAdvisor: async () => ({ reply: "" }),
    },
    version: "provider-pause-initial-plan-test",
    owlRoot: root,
    dispatcher: { tick_interval_ms: 60_000 },
    now: () => new Date().toISOString(),
  });
  t.after(async () => { await core.stop({ force: true }); await flush(); db.close(); await rm(root, { recursive: true, force: true }); });
  await core.start();

  await core.tick(workId);
  assert.equal(managerCalls, 1);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM tasks WHERE work_id = ?", workId).count, 0);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM decisions WHERE status = 'open'").count, 0);

  t.mock.timers.tick(30_000);
  await flushUntil(() => db.get("SELECT COUNT(*) AS count FROM tasks WHERE work_id = ?", workId).count === 1, "resumed Manager plan");
  assert.equal(managerCalls, 2);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM tasks WHERE work_id = ?", workId).count, 1);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'manager.failed'").count, 0);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM decisions WHERE status = 'open'").count, 0);
});
