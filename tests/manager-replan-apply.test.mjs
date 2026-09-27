import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";
import { createAgentRunner } from "../packages/agent-runtime/dist/index.js";

// A Manager replan names the failed Tasks each new Task replaces, may be
// empty, and is validated against the Work before any write. A rejected
// answer gets one repair attempt with the reasons; a second bad answer, or
// a failure while applying a valid plan, becomes an Owner Decision that
// carries the real cause and the Owner's answer, never a repeating tick
// error.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = join(repoRoot, "packages/db/migrations");

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return {
    request_id: createUlid(),
    idempotency_key: `test:${suffix}:${createUlid()}`,
    expected_version: expectedVersion,
    payload,
  };
}

/** A gate a fake Worker waits on; released before Core stops so no call hangs. */
function workerGate() {
  let release;
  const promise = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  return { promise, release: () => release() };
}

async function openCore(t, agentRunnerFor) {
  const root = await mkdtemp(join(tmpdir(), "owl-replan-apply-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const gate = workerGate();
  const agentRunner = agentRunnerFor({ db, gate });
  const core = new Core({
    db,
    agentRunner,
    version: "test",
    owlRoot: root,
    max_parallel: 4,
    dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 },
  });
  t.after(async () => {
    gate.release();
    await core.stop({ force: true });
    db.close();
  });
  return { db, core };
}

async function waitFor(read, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a Core call without awaiting it: once a replan applies, Core dispatches
 * the new Tasks and the dispatch waits on the gated Worker, so the call only
 * settles when the test ends. The test waits on the outcome it checks.
 */
function inBackground(promise) {
  const outcome = { settled: false, error: null };
  promise.then(
    () => { outcome.settled = true; },
    (error) => { outcome.settled = true; outcome.error = error; },
  );
  return outcome;
}

/** Tick the Work twice in the background and report any tick error. */
async function tickTwice(core, workId) {
  const first = inBackground(core.tick(workId));
  await sleep(150);
  const second = inBackground(core.tick(workId));
  await sleep(150);
  return [first.error, second.error].filter((error) => error !== null);
}

/**
 * A real agent runner (so the role contract validates every answer) whose
 * provider answers each prompt with `handler(prompt)`. Workers wait on the
 * gate: nothing a replan adds runs during the test.
 */
function gatedRunner(handler, prompts, gate) {
  const agent = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        const prompt = String(request.prompt ?? request.input ?? JSON.stringify(request));
        prompts.push(prompt);
        const out = handler(prompt, request);
        return {
          adapter: request.adapter,
          stdout: typeof out === "string" ? out : JSON.stringify(out),
          stderr: "",
          exit_code: 0,
          signal: null,
          format: "plain-text",
        };
      },
    },
  });
  return {
    ...agent,
    runWorker: async () => {
      await gate.promise;
      return { outcome: "failed", failure_class: "transient", error_key: "x", retry_allowed: true, message: "x" };
    },
  };
}

function managerInput(prompt) {
  const body = prompt.split("### Manager input\n")[1];
  assert.ok(body, "prompt has a Manager input section");
  return JSON.parse(body.trim());
}

const isReplan = (prompt) => prompt.includes("This is a REPLAN");

const task = (id, { dependsOn = [], replaces = [], title = `${id} title` } = {}) => ({
  id,
  title,
  type: "code",
  acceptance: "Done.",
  depends_on: dependsOn,
  context: "",
  notes: "",
  review: null,
  replaces,
});

function insertTask(tx, workId, { id, status, managerTaskId, title }) {
  const now = new Date().toISOString();
  tx.run(
    `INSERT INTO tasks
       (id, work_id, title, type, status, priority, context, acceptance,
        state_version, failure_count, same_error_count, review_round, worker_generation,
        created_at, updated_at, retry_no, manager_task_id)
     VALUES (?, ?, ?, 'code', ?, 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, ?)`,
    id, workId, title, status, now, now, managerTaskId,
  );
}

function insertReport(tx, workId, taskId) {
  const now = new Date().toISOString();
  const run = createUlid();
  tx.run(
    `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
     VALUES (?, ?, ?, 'worker', 'anthropic', 'm', 'completed', ?, ?)`,
    run, workId, taskId, now, now,
  );
  tx.run(
    `INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at)
     VALUES (?, ?, '1', 'success', ?, ?, 0, ?)`,
    createUlid(), run, JSON.stringify({ kind: "report", result: "success", work_done: `did ${taskId}` }), "0".repeat(64), now,
  );
}

/** Start Core without the driver ticking the seeded Work (a paused Work is not registered at start). */
async function startWithoutDriving(core, db, workId) {
  await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'paused' WHERE id = ?", workId));
  await core.start();
  await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId));
}

/**
 * The mgr/repro2 Work: T1 completed, T2 failed (the only root failure), T3
 * cancelled (superseded earlier).
 */
async function seedRepro2(core, db) {
  const created = await core.createWork(commandEnvelope({ title: "W", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  const ids = { t1: createUlid(), t2: createUlid(), t3: createUlid() };
  await db.createWriteLane().transact((tx) => {
    insertTask(tx, workId, { id: ids.t1, status: "completed", managerTaskId: "T1", title: "done one" });
    insertTask(tx, workId, { id: ids.t2, status: "failed", managerTaskId: "T2", title: "failed one" });
    insertTask(tx, workId, { id: ids.t3, status: "cancelled", managerTaskId: "T3", title: "old superseded" });
    insertReport(tx, workId, ids.t1);
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    return null;
  });
  return { workId, ...ids };
}

function writeState(db, workId) {
  return {
    plan_revision: db.get("SELECT plan_revision AS n FROM works WHERE id = ?", workId).n,
    tasks: db.get("SELECT COUNT(*) AS n FROM tasks WHERE work_id = ?", workId).n,
    replanned: db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'task.replanned'", workId).n,
    statuses: db.all("SELECT manager_task_id AS m, status AS s FROM tasks WHERE work_id = ? ORDER BY manager_task_id", workId),
  };
}

function openDecisions(db, workId) {
  return db.all(
    "SELECT id, scope, issuer_role, blocked_task_ids_json AS blocked, reason, tried FROM decisions WHERE work_id = ? AND status = 'open'",
    workId,
  );
}

function tickFailureAlerts(db, workId) {
  return db.get(
    "SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'system.alert' AND json_extract(payload_json, '$.kind') = 'workflow_tick_failed'",
    workId,
  ).n;
}

function dependencyIds(db, taskId) {
  return db.all("SELECT depends_on_task_id AS id FROM task_dependencies WHERE task_id = ? ORDER BY id", taskId).map((row) => row.id);
}

const managerTaskRow = (db, workId, managerTaskId) =>
  db.get("SELECT id, status FROM tasks WHERE work_id = ? AND manager_task_id = ?", workId, managerTaskId);

// The first (bad) answer of every mgr/repro2 scenario, in the new protocol,
// and the rule each one breaks.
const badReplans = {
  cancelledDep: { answer: { tasks: [task("N1", { dependsOn: ["T3"], replaces: ["T2"] })] }, error: /N1 depends on T3, which is cancelled/ },
  unknownDep: { answer: { tasks: [task("N1", { dependsOn: ["TX"], replaces: ["T2"] })] }, error: /N1 depends on TX.*\(unknown dependency\)/ },
  dupIds: {
    answer: { tasks: [task("N1", { replaces: ["T2"] }), task("N1", { title: "new2", replaces: ["T2"] })] },
    error: /Task id N1 appears more than once/,
  },
  cycle: {
    answer: { tasks: [task("N1", { dependsOn: ["N2"], replaces: ["T2"] }), task("N2", { dependsOn: ["N1"] })] },
    error: /dependency cycle: N\d -> N\d -> N\d/,
  },
  reuseCancelledId: {
    answer: { tasks: [task("T3", { title: "redo T3 fresh", replaces: ["T2"] }), task("N2", { dependsOn: ["T3"] })] },
    error: /T3 reuses the id of cancelled Task T3/,
  },
  retryCompleted: { answer: { tasks: [task("T1", { title: "T1 again revised" })] }, error: /T1 reuses the id of completed Task T1/ },
};

// A corrected answer: replace T2 with a new Task that builds on T1.
const correctedReplan = { tasks: [task("N9", { dependsOn: ["T1"], replaces: ["T2"] })] };

for (const [scenario, { answer, error }] of Object.entries(badReplans)) {
  test(`repro2 ${scenario}: the bad answer is rejected before any write and the corrected answer applies`, async (t) => {
    const prompts = [];
    let replanCalls = 0;
    let stateAtRepair = null;
    let baseline = null;
    let workIdRef = null;
    const { db, core } = await openCore(t, ({ db, gate }) =>
      gatedRunner((prompt) => {
        if (!isReplan(prompt)) return "not json";
        replanCalls += 1;
        if (replanCalls === 1) return answer;
        stateAtRepair = writeState(db, workIdRef);
        return correctedReplan;
      }, prompts, gate),
    );
    const { workId, t2 } = await seedRepro2(core, db);
    workIdRef = workId;
    await startWithoutDriving(core, db, workId);
    baseline = writeState(db, workId);

    const replan = inBackground(core.triggerManagerReplan(workId, [t2], "T2 failed"));
    await waitFor(() => managerTaskRow(db, workId, "T2").status === "cancelled" || replan.settled);
    assert.equal(replan.error, null);

    assert.equal(replanCalls, 2, "one repair attempt");
    assert.deepEqual(stateAtRepair, baseline, "nothing was written for the rejected answer");
    const replanPrompts = prompts.filter(isReplan);
    const repairReason = managerInput(replanPrompts[1]).reason;
    assert.match(repairReason, /^Your previous replan was rejected/);
    assert.match(repairReason, error);
    assert.match(repairReason, /T2 failed$/, "the original reason follows the rejection");

    const n9 = managerTaskRow(db, workId, "N9");
    assert.ok(n9, "the corrected plan was registered");
    assert.equal(managerTaskRow(db, workId, "T2").status, "cancelled", "T2 was replaced");
    assert.deepEqual(openDecisions(db, workId), []);
    assert.deepEqual(await tickTwice(core, workId), []);
    assert.equal(tickFailureAlerts(db, workId), 0);
  });
}

test("repro2: a second bad answer opens one Decision listing the errors, blocking only the root failed Task", async (t) => {
  const prompts = [];
  const { db, core } = await openCore(t, ({ gate }) =>
    gatedRunner((prompt) => (isReplan(prompt) ? badReplans.cancelledDep.answer : "not json"), prompts, gate),
  );
  const { workId, t2 } = await seedRepro2(core, db);
  await startWithoutDriving(core, db, workId);
  const baseline = writeState(db, workId);

  await core.triggerManagerReplan(workId, [t2], "T2 failed");

  assert.equal(prompts.filter(isReplan).length, 2);
  const decisions = openDecisions(db, workId);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].issuer_role, "manager");
  assert.equal(decisions[0].scope, "task");
  assert.deepEqual(JSON.parse(decisions[0].blocked), [t2]);
  assert.match(decisions[0].tried, /rejected twice/);
  assert.match(decisions[0].tried, /N1 depends on T3, which is cancelled/);
  const after = writeState(db, workId);
  assert.equal(after.plan_revision, baseline.plan_revision);
  assert.equal(after.tasks, baseline.tasks);
  assert.equal(after.replanned, baseline.replanned);
  assert.equal(managerTaskRow(db, workId, "T2").status, "judgement_waiting");
  assert.deepEqual(await tickTwice(core, workId), []);
  assert.equal(tickFailureAlerts(db, workId), 0, "never a tick error");
});

test("an old-format answer without replaces is rejected by the role contract and writes nothing", async (t) => {
  const prompts = [];
  const { db, core } = await openCore(t, ({ gate }) =>
    gatedRunner((prompt) => {
      if (!isReplan(prompt)) return "not json";
      const { replaces: _replaces, ...old } = task("N1");
      return { tasks: [old] };
    }, prompts, gate),
  );
  const { workId, t2 } = await seedRepro2(core, db);
  await startWithoutDriving(core, db, workId);
  const baseline = writeState(db, workId);

  await core.triggerManagerReplan(workId, [t2], "T2 failed");

  const after = writeState(db, workId);
  assert.equal(after.tasks, baseline.tasks);
  assert.equal(after.replanned, baseline.replanned);
  assert.equal(managerTaskRow(db, workId, "N1"), undefined);
  const decisions = openDecisions(db, workId);
  assert.equal(decisions.length, 1);
  assert.deepEqual(JSON.parse(decisions[0].blocked), [t2]);
});

test("repro4: reopen, an empty replan, then the final check completes the Work without a Decision", async (t) => {
  const prompts = [];
  const { db, core } = await openCore(t, ({ gate }) =>
    gatedRunner(
      (prompt) => (isReplan(prompt)
        ? { tasks: [] }
        : { verdict: { verdict: "complete", summary: "ok", missing: [], lessons: [] } }),
      prompts,
      gate,
    ),
  );
  const created = await core.createWork(commandEnvelope({ title: "W", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  const t1 = createUlid();
  await db.createWriteLane().transact((tx) => {
    insertTask(tx, workId, { id: t1, status: "completed", managerTaskId: "T1", title: "done one" });
    insertReport(tx, workId, t1);
    tx.run("UPDATE works SET state = 'completed' WHERE id = ?", workId);
    return null;
  });
  await core.start();
  const version = db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;
  await core.reopenWork(workId, commandEnvelope({ reason: "Double-check; if nothing is missing just finish." }, "reopen", version));

  const state = await waitFor(() => db.get("SELECT state FROM works WHERE id = ? AND state = 'completed'", workId)?.state);
  assert.equal(state, "completed", `Work state: ${db.get("SELECT state FROM works WHERE id = ?", workId).state}`);
  const replanPrompt = prompts.find(isReplan);
  assert.ok(replanPrompt, "the reopen ran a Manager replan");
  assert.match(managerInput(replanPrompt).reason, /return \{"tasks": \[\]\}/);
  assert.equal(replanPrompt.includes("minItems"), false);
  assert.equal(prompts.filter(isReplan).length, 1, "the empty answer was accepted the first time");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ?", workId).n, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM tasks WHERE work_id = ?", workId).n, 1, "the empty replan wrote no Task");
});

test("repro5: each replacement takes over only its own replaced Task's dependents; no cycle", async (t) => {
  const prompts = [];
  const { db, core } = await openCore(t, ({ gate }) =>
    gatedRunner(
      (prompt) => (isReplan(prompt)
        ? { tasks: [task("N1", { replaces: ["T1"] }), task("N2", { dependsOn: ["T3"], replaces: ["T2"] })] }
        : "not json"),
      prompts,
      gate,
    ),
  );
  const created = await core.createWork(commandEnvelope({ title: "W", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  const [f1, f2, d] = await core.workflowEngine().registerPlan(
    workId,
    [task("T1"), task("T2"), task("T3", { dependsOn: ["T1"] })],
    "work.planned",
  );
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET status = 'failed' WHERE id IN (?, ?)", f1.id, f2.id);
    tx.run("UPDATE works SET state = 'running', state_version = state_version + 1 WHERE id = ?", workId);
    return null;
  });
  await core.workflowEngine().cascadeFailure(workId, f1.id);
  await startWithoutDriving(core, db, workId);

  const replan = inBackground(core.triggerManagerReplan(workId, [f1.id, f2.id], "T1 and T2 failed"));
  await waitFor(() => managerTaskRow(db, workId, "T2").status === "cancelled" || replan.settled);
  assert.equal(replan.error, null);

  assert.equal(prompts.filter(isReplan).length, 1, "the plan was valid the first time");
  const n1 = managerTaskRow(db, workId, "N1");
  const n2 = managerTaskRow(db, workId, "N2");
  assert.ok(n1 && n2, "both replacements were registered");
  assert.equal(managerTaskRow(db, workId, "T1").status, "cancelled");
  assert.equal(managerTaskRow(db, workId, "T2").status, "cancelled");
  assert.deepEqual(dependencyIds(db, d.id), [n1.id], "T3 depends only on its own dependency's replacement");
  assert.deepEqual(dependencyIds(db, n2.id), [d.id]);
  assert.equal(managerTaskRow(db, workId, "T3").status, "waiting");
  const superseded = db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'task.superseded'", workId);
  const payload = JSON.parse(superseded.payload_json);
  assert.deepEqual(payload.replacements, { [f1.id]: [n1.id], [f2.id]: [n2.id] });
  assert.deepEqual(openDecisions(db, workId), []);
  assert.deepEqual(await tickTwice(core, workId), [], "no cycle error on later ticks");
  assert.equal(tickFailureAlerts(db, workId), 0);
});

test("A7: a failure while applying a valid replan becomes a Decision with the real cause and the Owner's answer", async (t) => {
  const prompts = [];
  const { db, core } = await openCore(t, ({ gate }) =>
    gatedRunner((prompt) => (isReplan(prompt) ? correctedReplan : "not json"), prompts, gate),
  );
  const { workId, t2 } = await seedRepro2(core, db);
  const decisionId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE works SET state = 'judgement_waiting' WHERE id = ?", workId);
    tx.run(
      `INSERT INTO decisions (id, work_id, scope, status, blocked_task_ids_json, reason, tried, current_state, options_json, recommended, allow_free_text, issuer_role, state_version, created_at)
       VALUES (?, ?, 'work', 'open', '[]', 'One or more tasks failed.', 'Core', 'judgement_waiting', '[]', NULL, 1, 'core', 0, ?)`,
      decisionId, workId, new Date().toISOString(),
    );
    return null;
  });
  core.workflowEngine().applyReplan = async () => {
    throw new Error("REGISTER-FAILURE-MARKER");
  };
  await core.start();
  await core.answerDecision(
    decisionId,
    commandEnvelope({ answer: "owner-answer-marker: replace T2", option_key: null, source_message_id: null }, "answer"),
  );

  const decision = await waitFor(() => openDecisions(db, workId).find((row) => row.issuer_role === "manager"));
  assert.ok(decision, "the apply failure opened a Manager Decision");
  assert.match(decision.tried, /REGISTER-FAILURE-MARKER/);
  assert.match(decision.tried, /owner-answer-marker: replace T2/, "the Owner's answer is not lost");
  assert.deepEqual(JSON.parse(decision.blocked), [t2]);
  assert.equal(managerInput(prompts.find(isReplan)).context.question, "owner-answer-marker: replace T2");
  await sleep(200);
  assert.equal(tickFailureAlerts(db, workId), 0, "no workflow_tick_failed alert");
  assert.equal(openDecisions(db, workId).length, 1);
});

test("A5 regression: replacing the root Task via replaces keeps the cascaded dependent and re-points it", async (t) => {
  const prompts = [];
  const { db, core } = await openCore(t, ({ gate }) =>
    gatedRunner((prompt) => (isReplan(prompt) ? { tasks: [task("N1", { replaces: ["T1"] })] } : "not json"), prompts, gate),
  );
  const created = await core.createWork(commandEnvelope({ title: "W", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  const [t1, t2] = await core.workflowEngine().registerPlan(workId, [task("T1"), task("T2", { dependsOn: ["T1"] })], "work.planned");
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET status = 'failed' WHERE id = ?", t1.id);
    tx.run("UPDATE works SET state = 'running', state_version = state_version + 1 WHERE id = ?", workId);
    return null;
  });
  await core.workflowEngine().cascadeFailure(workId, t1.id);
  await startWithoutDriving(core, db, workId);

  const replan = inBackground(core.triggerManagerReplan(workId, [t1.id, t2.id], "T1 failed"));
  await waitFor(() => managerTaskRow(db, workId, "T1").status === "cancelled" || replan.settled);
  assert.equal(replan.error, null);

  const input = managerInput(prompts.find(isReplan));
  assert.deepEqual(input.context.failed_task_ids, [t1.id], "only the root failure reaches the Manager");
  const n1 = managerTaskRow(db, workId, "N1");
  assert.ok(n1);
  assert.equal(managerTaskRow(db, workId, "T1").status, "cancelled");
  assert.deepEqual(db.get("SELECT status, failed_by_dependency_task_id AS marker FROM tasks WHERE id = ?", t2.id), { status: "waiting", marker: null });
  assert.deepEqual(dependencyIds(db, t2.id), [n1.id]);
  const superseded = db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'task.superseded'", workId)
    .flatMap((row) => JSON.parse(row.payload_json).task_ids);
  assert.deepEqual(superseded, [t1.id]);
  assert.deepEqual(openDecisions(db, workId), []);
});

test("the initial plan with a duplicate id gets one repair attempt before it is registered", async (t) => {
  const prompts = [];
  let planCalls = 0;
  const { db, core } = await openCore(t, ({ gate }) =>
    gatedRunner((prompt) => {
      if (isReplan(prompt)) return "not json";
      planCalls += 1;
      return planCalls === 1
        ? { tasks: [task("T1"), task("T1", { title: "again" })] }
        : { tasks: [task("T1"), task("T2", { dependsOn: ["T1"] })] };
    }, prompts, gate),
  );
  await core.start();
  const created = await core.createWork(commandEnvelope({ title: "W", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, "start", created.version));

  const t2 = await waitFor(() => managerTaskRow(db, workId, "T2"));
  assert.ok(t2, "the corrected plan was registered");
  assert.equal(planCalls, 2);
  assert.match(managerInput(prompts[1]).reason, /^Your previous plan was rejected: Task id T1 appears more than once/);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM tasks WHERE work_id = ?", workId).n, 2);
});

test("a retry's revised type and review are applied and take effect on the Task's next run", async (t) => {
  const workerRequests = [];
  const reviewerRequests = [];
  const root = await mkdtemp(join(tmpdir(), "owl-replan-retry-type-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const agentRunner = {
    runManagerPlan: async (request) => {
      if (request.context?.mode === "finalize") {
        return {
          outcome: "success",
          report_valid: true,
          report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "T2 is done.", missing: [], lessons: [] } },
        };
      }
      return {
        outcome: "success",
        report_valid: true,
        report: {
          tasks: [{ id: "T2", title: "T2 revised as a test task", type: "test", acceptance: "All tests pass.", depends_on: [], replaces: [], review: false }],
          event: "task.replanned",
        },
      };
    },
    runWorker: async (request) => {
      workerRequests.push(request);
      return {
        outcome: "success",
        report_valid: true,
        report: {
          kind: "report",
          schema_version: "1.0.0",
          invocation_id: request.invocation_id,
          result: "success",
          work_done: "T2 done.",
          changes: [],
          verification: { passed: true, method: "Ran the tests." },
          remaining_issues: [],
          next_action: "none",
          needs_replanning: false,
          question_for_manager: null,
        },
      };
    },
    runReviewer: async (request) => {
      reviewerRequests.push(request);
      const review = { verdict: "pass", summary: "ok", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } };
      return { outcome: "success", report_valid: true, report: review, review };
    },
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });

  const created = await core.createWork(commandEnvelope({ title: "W", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  const t2 = createUlid();
  await db.createWriteLane().transact((tx) => {
    insertTask(tx, workId, { id: t2, status: "failed", managerTaskId: "T2", title: "failed one" });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    return null;
  });
  await core.start();

  await core.triggerManagerReplan(workId, [t2], "T2 failed");

  const row = db.get("SELECT type, review_override FROM tasks WHERE id = ?", t2);
  assert.equal(row.type, "test");
  assert.equal(row.review_override, "false");

  await waitFor(() => workerRequests.length > 0);
  assert.equal(workerRequests.length, 1);
  assert.equal(workerRequests[0].context.task.type, "test");
  assert.equal(workerRequests[0].context.task.review, false);

  await waitFor(() => db.get("SELECT status FROM tasks WHERE id = ?", t2)?.status === "completed");
  assert.equal(reviewerRequests.length, 0, "review: false on the retried Task skips the Reviewer");
});
