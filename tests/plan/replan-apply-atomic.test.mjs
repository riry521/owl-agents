import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore, command } from "../helpers/core.mjs";
import { withNecessity, necessityFor, criteriaFor } from "../helpers/necessity.mjs";
import { waitFor } from "../helpers/wait.mjs";

// A validated Manager replan is applied in ONE WriteLane
// transaction that re-checks the Work state, the plan revision and every
// root Task's status after the (minutes-long) Manager call. A pause, cancel
// or plan change in the meantime writes nothing and requeues the replan; a
// failure half-way through the apply writes nothing and becomes a Decision
// with the real cause. A retried Task's depends_on replaces its dependencies
// and is validated like a new Task's.

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return command(payload, `test:${suffix}:${createUlid()}`, expectedVersion);
}

function deferred() {
  let resolveIt;
  const promise = new Promise((r) => {
    resolveIt = r;
  });
  return { promise, resolve: () => resolveIt() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function inBackground(promise) {
  const outcome = { settled: false, error: null };
  promise.then(
    () => { outcome.settled = true; },
    (error) => { outcome.settled = true; outcome.error = error; },
  );
  return outcome;
}

/**
 * Core with a real agent runner (so the role contract validates every
 * answer) whose provider answers each prompt with `await handler(prompt)`.
 * Workers wait on a gate released at teardown: nothing a replan adds runs.
 */
async function openCore(t, handler) {
  const gate = deferred();
  t.after(() => gate.resolve());
  const prompts = [];
  const agent = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        const prompt = String(request.prompt ?? request.input ?? JSON.stringify(request));
        prompts.push(prompt);
        const out = await handler(prompt);
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
  const agentRunner = {
    ...agent,
    runWorker: async () => {
      await gate.promise;
      return { outcome: "failed", failure_class: "transient", error_key: "x", retry_allowed: true, message: "x" };
    },
  };
  const { db, core } = await createTestCore(t, {
    agentRunner: withNecessity(agentRunner),
    max_parallel: 4,
    dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 },
  }, { prefix: "owl-replan-atomic-" });
  return { db, core, prompts };
}

const isReplan = (prompt) => prompt.includes("This is a REPLAN");

function managerInput(prompt) {
  const body = prompt.split("### Manager input\n")[1];
  assert.ok(body, "prompt has a Manager input section");
  return JSON.parse(body.trim());
}

const task = (id, { dependsOn = [], replaces = [], title = `${id} title` } = {}) => ({
  id,
  title,
  type: "code",
  necessity: necessityFor(), acceptance_criteria: criteriaFor("Done; verified by the test."),
  depends_on: dependsOn,
  context: "",
  notes: "",
  review: null,
  required_sections: [], required_tests: [], wait_for: null, base_sync_only: null,
  replaces,
});

function insertTask(tx, workId, { id, status, managerTaskId, failedBy = null }) {
  const now = new Date().toISOString();
  tx.run(
    `INSERT INTO tasks
       (id, work_id, title, type, status, priority, context, acceptance,
        state_version, failure_count, same_error_count, review_round, worker_generation,
        created_at, updated_at, retry_no, manager_task_id, failed_by_dependency_task_id)
     VALUES (?, ?, ?, 'code', ?, 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, ?, ?)`,
    id, workId, `${managerTaskId} title`, status, now, now, managerTaskId, failedBy,
  );
}

function insertTrigger(tx, taskId, status = "queued") {
  const now = new Date().toISOString();
  tx.run(
    `INSERT OR REPLACE INTO idempotency_keys (key, request_hash, response_json, status_code, created_at, expires_at)
     VALUES (?, ?, ?, 202, ?, ?)`,
    `manager-trigger:${taskId}`, "0".repeat(64), JSON.stringify({ task_id: taskId, event: "task.failed", status }), now,
    new Date(Date.now() + 86_400_000).toISOString(),
  );
}

const markerStatus = (db, taskId) =>
  db.get("SELECT json_extract(response_json, '$.status') AS s FROM idempotency_keys WHERE key = ?", `manager-trigger:${taskId}`)?.s ?? null;

/**
 * T1 completed, T5 completed, T2 failed (the only root failure, depends on
 * T1), T3 cascade-failed because of T2 (depends on T2). T2 has a queued
 * Manager trigger.
 */
async function seedWork(core, db) {
  const created = await core.createWork(commandEnvelope({ title: "W", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  const ids = { t1: createUlid(), t2: createUlid(), t3: createUlid(), t5: createUlid() };
  await db.createWriteLane().transact((tx) => {
    insertTask(tx, workId, { id: ids.t1, status: "completed", managerTaskId: "T1" });
    insertTask(tx, workId, { id: ids.t5, status: "completed", managerTaskId: "T5" });
    insertTask(tx, workId, { id: ids.t2, status: "failed", managerTaskId: "T2" });
    insertTask(tx, workId, { id: ids.t3, status: "failed", managerTaskId: "T3", failedBy: ids.t2 });
    tx.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)", ids.t2, ids.t1);
    tx.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)", ids.t3, ids.t2);
    insertTrigger(tx, ids.t2);
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    return null;
  });
  return { workId, ...ids };
}

/** Start Core without the driver ticking the seeded Work. */
async function startWithoutDriving(core, db, workId) {
  await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'paused' WHERE id = ?", workId));
  await core.start();
  await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId));
}

function writeState(db, workId) {
  return {
    plan_revision: db.get("SELECT plan_revision AS n FROM works WHERE id = ?", workId).n,
    tasks: db.all("SELECT id, status, title FROM tasks WHERE work_id = ? ORDER BY id", workId),
    edges: db.all(
      "SELECT task_id, depends_on_task_id FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE work_id = ?) ORDER BY 1, 2",
      workId,
    ),
    replan_events: db.get(
      "SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type IN ('task.replanned', 'task.superseded', 'task.dependency_restored')",
      workId,
    ).n,
  };
}

const workVersion = (db, workId) => db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;
const managerTaskRow = (db, workId, managerTaskId) =>
  db.get("SELECT id, status FROM tasks WHERE work_id = ? AND manager_task_id = ?", workId, managerTaskId);
const dependencyIds = (db, taskId) =>
  db.all("SELECT depends_on_task_id AS id FROM task_dependencies WHERE task_id = ? ORDER BY id", taskId).map((row) => row.id);
const managerDecisions = (db, workId) =>
  db.all("SELECT id, blocked_task_ids_json AS blocked, tried FROM decisions WHERE work_id = ? AND status = 'open' AND issuer_role = 'manager'", workId);

// Replace T2 with N9 (builds on T1).
const replaceT2 = { tasks: [task("N9", { dependsOn: ["T1"], required_sections: [], required_tests: [], replaces: ["T2"] })] };

test("a pause during the Manager replan call applies nothing, requeues the trigger, and the replan runs again after resume", async (t) => {
  const entered = deferred();
  const release = deferred();
  let replanCalls = 0;
  const { db, core } = await openCore(t, async (prompt) => {
    if (!isReplan(prompt)) return "not json";
    replanCalls += 1;
    if (replanCalls === 1) {
      entered.resolve();
      await release.promise;
    }
    return replaceT2;
  });
  const { workId, t2 } = await seedWork(core, db);
  await startWithoutDriving(core, db, workId);
  const baseline = writeState(db, workId);

  const replan = inBackground(core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" }));
  await entered.promise;
  assert.equal(markerStatus(db, t2), "attempted");
  await core.pauseWork(workId, commandEnvelope({ reason: "break" }, "pause", workVersion(db, workId)));
  const paused = writeState(db, workId);
  release.resolve();
  await waitFor(() => replan.settled);
  assert.equal(replan.error, null);

  assert.deepEqual(writeState(db, workId), paused, "nothing was applied after the pause");
  assert.equal(managerTaskRow(db, workId, "N9"), undefined);
  assert.equal(paused.plan_revision, baseline.plan_revision);
  assert.equal(markerStatus(db, t2), "queued", "the trigger is back to queued");
  assert.deepEqual(managerDecisions(db, workId), [], "no Decision");

  await core.resumeWork(workId, commandEnvelope({}, "resume", workVersion(db, workId)));
  await waitFor(() => managerTaskRow(db, workId, "N9") && managerTaskRow(db, workId, "T2").status === "cancelled");
  assert.equal(replanCalls, 2, "the Manager was asked again after resume");
  assert.ok(managerTaskRow(db, workId, "N9"), "the second replan applied");
  assert.equal(managerTaskRow(db, workId, "T2").status, "cancelled");
  assert.equal(db.get("SELECT plan_revision AS n FROM works WHERE id = ?", workId).n, baseline.plan_revision + 1, "one plan_revision bump");
  assert.equal(markerStatus(db, t2), "attempted");
  assert.deepEqual(managerDecisions(db, workId), []);
});

test("a Work cancelled during the Manager replan call gets no new Tasks and no Decision", async (t) => {
  const entered = deferred();
  const release = deferred();
  const { db, core } = await openCore(t, async (prompt) => {
    if (!isReplan(prompt)) return "not json";
    entered.resolve();
    await release.promise;
    return replaceT2;
  });
  const { workId, t2 } = await seedWork(core, db);
  await startWithoutDriving(core, db, workId);
  const taskCount = writeState(db, workId).tasks.length;

  const replan = inBackground(core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" }));
  await entered.promise;
  await core.cancelWork(workId, commandEnvelope({ reason: "stop" }, "cancel", workVersion(db, workId)));
  const cancelled = writeState(db, workId);
  release.resolve();
  await waitFor(() => replan.settled);
  assert.equal(replan.error, null);

  assert.deepEqual(writeState(db, workId), cancelled);
  assert.equal(cancelled.tasks.length, taskCount, "no Tasks inserted");
  assert.equal(managerTaskRow(db, workId, "N9"), undefined);
  assert.deepEqual(managerDecisions(db, workId), []);
});

test("a cancel committed after the Manager answered but before the apply aborts the apply transaction with no writes", async (t) => {
  const { db, core } = await openCore(t, (prompt) => (isReplan(prompt) ? replaceT2 : "not json"));
  const { workId, t2 } = await seedWork(core, db);
  await startWithoutDriving(core, db, workId);
  const engine = core.workflowEngine();
  const original = engine.applyReplan.bind(engine);
  const abortCodes = [];
  let cancelledState = null;
  engine.applyReplan = async (...args) => {
    // The cancel wins the race: it commits between Core's post-call state
    // check and the apply transaction.
    await core.cancelWork(workId, commandEnvelope({ reason: "stop" }, "cancel", workVersion(db, workId)));
    cancelledState = writeState(db, workId);
    try {
      return await original(...args);
    } catch (error) {
      abortCodes.push(error.code);
      throw error;
    }
  };

  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });

  assert.deepEqual(abortCodes, ["replan_work_not_running"]);
  assert.deepEqual(writeState(db, workId), cancelledState, "the apply wrote nothing");
  assert.equal(managerTaskRow(db, workId, "N9"), undefined, "no Tasks inserted");
  assert.deepEqual(managerDecisions(db, workId), [], "an abort is not a Decision");
  assert.equal(markerStatus(db, t2), "queued");
});

test("a root Task whose status changed during the Manager call aborts the apply as stale and requeues it", async (t) => {
  const { db, core } = await openCore(t, (prompt) => (isReplan(prompt) ? replaceT2 : "not json"));
  const { workId, t2 } = await seedWork(core, db);
  await startWithoutDriving(core, db, workId);
  const engine = core.workflowEngine();
  const original = engine.applyReplan.bind(engine);
  const abortCodes = [];
  let before = null;
  engine.applyReplan = async (...args) => {
    await db.createWriteLane().transact((tx) => tx.run("UPDATE tasks SET status = 'judgement_waiting' WHERE id = ?", t2));
    before = writeState(db, workId);
    try {
      return await original(...args);
    } catch (error) {
      abortCodes.push(error.code);
      throw error;
    }
  };

  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });

  assert.deepEqual(abortCodes, ["replan_plan_stale"]);
  assert.deepEqual(writeState(db, workId), before, "the apply wrote nothing");
  assert.deepEqual(managerDecisions(db, workId), []);
  assert.equal(markerStatus(db, t2), "queued", "requeued; the tick replays it only while T2 is still failed");
});

test("a failure half-way through the apply leaves no partial writes and opens a Decision with the real cause", async (t) => {
  const { db, core } = await openCore(t, (prompt) => (isReplan(prompt) ? replaceT2 : "not json"));
  const { workId, t2 } = await seedWork(core, db);
  await startWithoutDriving(core, db, workId);
  const baseline = writeState(db, workId);
  // The supersession step (after the new Task rows are inserted) throws.
  const lane = db.createWriteLane();
  await lane.transact((tx) => tx.run(`CREATE TRIGGER wp8_fail_supersede BEFORE UPDATE OF status ON tasks
    WHEN NEW.status = 'cancelled' AND NEW.id = '${t2}'
    BEGIN SELECT RAISE(ABORT, 'SUPERSEDE-FAILURE-MARKER'); END`));

  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });
  await lane.transact((tx) => tx.run("DROP TRIGGER wp8_fail_supersede"));

  const after = writeState(db, workId);
  assert.equal(managerTaskRow(db, workId, "N9"), undefined, "no new Task row");
  assert.equal(after.tasks.length, baseline.tasks.length);
  assert.equal(after.plan_revision, baseline.plan_revision, "plan_revision unchanged");
  assert.deepEqual(after.edges, baseline.edges);
  assert.equal(after.replan_events, baseline.replan_events, "no replan events");
  const decisions = managerDecisions(db, workId);
  assert.equal(decisions.length, 1, "the apply error became a Decision");
  assert.match(decisions[0].tried, /SUPERSEDE-FAILURE-MARKER/);
  assert.deepEqual(JSON.parse(decisions[0].blocked), [t2]);
  assert.equal(managerTaskRow(db, workId, "T2").status, "judgement_waiting");
  assert.equal(managerTaskRow(db, workId, "T3").status, "failed", "the cascaded dependent was not restored");
});

test("an Owner replan interrupted by a pause is persisted again and handed to the Manager after resume", async (t) => {
  const entered = deferred();
  const release = deferred();
  let replanCalls = 0;
  const { db, core, prompts } = await openCore(t, async (prompt) => {
    if (!isReplan(prompt)) return "not json";
    replanCalls += 1;
    if (replanCalls === 1) {
      entered.resolve();
      await release.promise;
    }
    return replaceT2;
  });
  const { workId, t2 } = await seedWork(core, db);
  const decisionId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE works SET state = 'judgement_waiting' WHERE id = ?", workId);
    insertTrigger(tx, t2, "attempted");
    tx.run(
      `INSERT INTO decisions (id, work_id, scope, status, blocked_task_ids_json, reason, tried, current_state, options_json, recommended, allow_free_text, issuer_role, state_version, created_at)
       VALUES (?, ?, 'work', 'open', '[]', 'One or more tasks failed.', 'Core', 'judgement_waiting', '[]', NULL, 1, 'core', 0, ?)`,
      decisionId, workId, new Date().toISOString(),
    );
    return null;
  });
  await core.start();
  await core.answerDecision(
    decisionId,
    commandEnvelope({ answer: "owner-answer-marker: replace T2", option_key: null, source_message_id: null }, "answer"),
  );
  await entered.promise;
  await core.pauseWork(workId, commandEnvelope({ reason: "break" }, "pause", workVersion(db, workId)));
  release.resolve();
  const ownerKey = () => db.get("SELECT response_json FROM idempotency_keys WHERE key = ?", `owner-replan:${workId}`);
  await waitFor(() => ownerKey());
  assert.equal(JSON.parse(ownerKey().response_json).answer, "owner-answer-marker: replace T2", "the Owner's answer is kept");
  assert.equal(markerStatus(db, t2), "attempted", "the trigger keeps its previous status");
  assert.equal(managerTaskRow(db, workId, "N9"), undefined);

  await core.resumeWork(workId, commandEnvelope({}, "resume", workVersion(db, workId)));
  await waitFor(() => managerTaskRow(db, workId, "N9"));
  assert.ok(managerTaskRow(db, workId, "N9"), "the Owner replan applied after resume");
  const replans = prompts.filter(isReplan);
  assert.equal(replans.length, 2);
  assert.equal(managerInput(replans[1]).context.owner_requests[0].text, "owner-answer-marker: replace T2");
  assert.equal(ownerKey(), undefined, "consumed");
  assert.deepEqual(managerDecisions(db, workId), []);
});

test("a retried Task's unknown dependency is rejected before any write; the corrected depends_on replaces its edges", async (t) => {
  let replanCalls = 0;
  let stateAtRepair = null;
  let workIdRef = null;
  let dbRef = null;
  const { db, core, prompts } = await openCore(t, (prompt) => {
    if (!isReplan(prompt)) return "not json";
    replanCalls += 1;
    if (replanCalls === 1) return { tasks: [task("T2", { dependsOn: ["TX"] })] };
    stateAtRepair = writeState(dbRef, workIdRef);
    return { tasks: [task("N1"), task("T2", { dependsOn: ["T5", "N1"], title: "T2 revised" })] };
  });
  dbRef = db;
  const { workId, t2, t3, t5 } = await seedWork(core, db);
  workIdRef = workId;
  await startWithoutDriving(core, db, workId);
  const baseline = writeState(db, workId);

  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });

  assert.equal(replanCalls, 2);
  assert.deepEqual(stateAtRepair, baseline, "nothing was written for the rejected answer");
  assert.match(managerInput(prompts.filter(isReplan)[1]).context.previous_output_feedback.errors.join(" "), /T2 depends on TX.*\(unknown dependency\)/);
  const n1 = managerTaskRow(db, workId, "N1");
  assert.ok(n1);
  assert.deepEqual(dependencyIds(db, t2), [n1.id, t5].sort(), "T2's edges were replaced (T1 dropped)");
  assert.equal(managerTaskRow(db, workId, "T2").status, "waiting", "T2 waits for the new Task N1");
  assert.equal(db.get("SELECT title FROM tasks WHERE id = ?", t2).title, "T2 revised");
  assert.deepEqual(dependencyIds(db, t3), [t2], "the cascaded dependent keeps its edge");
  assert.equal(managerTaskRow(db, workId, "T3").status, "waiting", "and is restored");
  assert.equal(db.get("SELECT plan_revision AS n FROM works WHERE id = ?", workId).n, baseline.plan_revision + 1);
  assert.deepEqual(managerDecisions(db, workId), []);
});

test("a retried Task's self-dependency is rejected, and one without depends_on keeps its edges", async (t) => {
  let replanCalls = 0;
  const { db, core, prompts } = await openCore(t, (prompt) => {
    if (!isReplan(prompt)) return "not json";
    replanCalls += 1;
    return { tasks: [task("T2", { dependsOn: replanCalls === 1 ? ["T2"] : ["T1"] })] };
  });
  const { workId, t1, t2 } = await seedWork(core, db);
  await startWithoutDriving(core, db, workId);
  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });
  assert.match(managerInput(prompts.filter(isReplan)[1]).context.previous_output_feedback.errors.join(" "), /T2 depends on itself/);
  assert.deepEqual(dependencyIds(db, t2), [t1]);
  assert.equal(managerTaskRow(db, workId, "T2").status, "ready");
});

test("a cycle through a retried Task's new depends_on is rejected by validation and by the apply transaction", async (t) => {
  const { db, core, prompts } = await openCore(t, (prompt) => (isReplan(prompt) ? { tasks: [task("T2", { dependsOn: ["T3"] })] } : "not json"));
  const { workId, t1, t2, t3 } = await seedWork(core, db);
  await startWithoutDriving(core, db, workId);
  const baseline = writeState(db, workId);

  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });
  assert.match(managerInput(prompts.filter(isReplan)[1]).context.previous_output_feedback.errors.join(" "), /dependency cycle/);
  const decisions = managerDecisions(db, workId);
  assert.equal(decisions.length, 1);
  assert.match(decisions[0].tried, /rejected twice.*dependency cycle/s);
  assert.deepEqual(dependencyIds(db, t2), [t1]);
  assert.equal(writeState(db, workId).plan_revision, baseline.plan_revision);

  // The apply transaction checks the graph itself before commit.
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE decisions SET status = 'cancelled' WHERE work_id = ?", workId);
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    tx.run("UPDATE tasks SET status = 'failed' WHERE id = ?", t2);
    return null;
  });
  const before = writeState(db, workId);
  const plan = {
    newItems: [],
    reopenIds: [t2],
    revisions: new Map([[t2, { title: "T2 again", acceptance: "Done.", context: "", type: "code", review: undefined, depends_on: [{ task_id: t3 }] }]]),
    supersessions: new Map(),
  };
  const guard = { base_plan_revision: before.plan_revision, root_statuses: new Map([[t2, "failed"]]) };
  await assert.rejects(core.workflowEngine().applyReplan(workId, plan, guard, "test"), /dependency cycle/);
  assert.deepEqual(writeState(db, workId), before, "no partial writes");
});

test("a retried Task's invalid type is rejected by the role contract before any write", async (t) => {
  let replanCalls = 0;
  const { db, core, prompts } = await openCore(t, (prompt) => {
    if (!isReplan(prompt)) return "not json";
    replanCalls += 1;
    return {
      tasks: [{
        id: "T2", title: "T2 revised", type: "bogus-type", necessity: necessityFor(), acceptance_criteria: criteriaFor("Done."),
        depends_on: ["T1"], context: "", notes: "", review: null, required_sections: [], required_tests: [], wait_for: null, base_sync_only: null, replaces: [],
      }],
    };
  });
  const { workId, t1, t2 } = await seedWork(core, db);
  await startWithoutDriving(core, db, workId);
  const baseline = writeState(db, workId);

  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });

  assert.equal(replanCalls, 1, "an invalid type is rejected on the first attempt, no repair round");
  assert.equal(db.get("SELECT plan_revision AS n FROM works WHERE id = ?", workId).n, baseline.plan_revision, "no plan revision was applied");
  assert.deepEqual(dependencyIds(db, t2), [t1], "T2's dependencies are unchanged");
  assert.equal(db.get("SELECT type, title FROM tasks WHERE id = ?", t2).type, "code", "T2's type was not rewritten");
  const decisions = managerDecisions(db, workId);
  assert.equal(decisions.length, 1);
  assert.match(decisions[0].tried, /not_one_of_research\|design\|code\|config\|doc\|test/);
  assert.equal(managerTaskRow(db, workId, "T2").status, "judgement_waiting", "the blocked root failure awaits the Owner");
});

test("applyReplan refuses a Work that is not running or a stale plan with a coded error and no writes", async (t) => {
  const { db, core } = await openCore(t, () => "not json");
  const { workId, t2 } = await seedWork(core, db);
  const engine = core.workflowEngine();
  const plan = { newItems: [], reopenIds: [t2], revisions: new Map(), supersessions: new Map() };
  const revision = db.get("SELECT plan_revision AS n FROM works WHERE id = ?", workId).n;
  const before = writeState(db, workId);

  await assert.rejects(
    engine.applyReplan(workId, plan, { base_plan_revision: revision + 1, root_statuses: new Map([[t2, "failed"]]) }, "x"),
    (error) => error.code === "replan_plan_stale",
  );
  await assert.rejects(
    engine.applyReplan(workId, plan, { base_plan_revision: revision, root_statuses: new Map([[t2, "judgement_waiting"]]) }, "x"),
    (error) => error.code === "replan_plan_stale",
  );
  await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'paused' WHERE id = ?", workId));
  await assert.rejects(
    engine.applyReplan(workId, plan, { base_plan_revision: revision, root_statuses: new Map([[t2, "failed"]]) }, "x"),
    (error) => error.code === "replan_work_not_running",
  );
  assert.deepEqual(writeState(db, workId), before);

  await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId));
  await engine.applyReplan(workId, plan, { base_plan_revision: revision, root_statuses: new Map([[t2, "failed"]]) }, "x");
  assert.equal(managerTaskRow(db, workId, "T2").status, "ready");
  assert.equal(db.get("SELECT plan_revision AS n FROM works WHERE id = ?", workId).n, revision + 1);
  const events = db.all("SELECT type, task_id FROM events WHERE work_id = ? AND type IN ('task.replanned', 'task.dependency_restored') ORDER BY sequence", workId);
  assert.deepEqual(events, [
    { type: "task.replanned", task_id: null },
    { type: "task.dependency_restored", task_id: before.tasks.find((row) => row.title === "T3 title").id },
  ]);
});
