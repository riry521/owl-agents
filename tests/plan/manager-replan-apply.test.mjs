import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { isPlanRejection, validatePlan, validateReplan } from "../../packages/core/dist/replan-plan.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore, command } from "../helpers/core.mjs";
import { withNecessity, necessityFor, criteriaFor } from "../helpers/necessity.mjs";
import { waitFor } from "../helpers/wait.mjs";

// A Manager replan names the failed Tasks each new Task replaces, may be
// empty, and is validated against the Work before any write. A rejected
// answer gets one repair attempt with the reasons; a second bad answer, or
// a failure while applying a valid plan, becomes an Owner Decision that
// carries the real cause and the Owner's answer, never a repeating tick
// error.

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return command(payload, `test:${suffix}:${createUlid()}`, expectedVersion);
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
  const gate = workerGate();
  t.after(gate.release);
  return createTestCore(t, {
    agentRunner: withNecessity(agentRunnerFor({ gate })),
    max_parallel: 4,
    dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 },
  }, { prefix: "owl-replan-apply-" });
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
  necessity: necessityFor(), acceptance_criteria: criteriaFor("Done; verified by the test."),
  depends_on: dependsOn,
  context: "",
  notes: "",
  review: null,
  required_sections: [], required_tests: [], wait_for: null, base_sync_only: null,
  replaces,
});

/** A Task as the engine registers it: Core derives `acceptance` from the criteria, so a provider answer must not carry it. */
const engineTask = (...args) => ({ ...task(...args), acceptance: "Done; verified by the test." });

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
  cancelledDep: { answer: { tasks: [task("N1", { dependsOn: ["T3"], required_sections: [], required_tests: [], replaces: ["T2"] })] }, error: /N1 depends on T3, which is cancelled/ },
  unknownDep: { answer: { tasks: [task("N1", { dependsOn: ["TX"], required_sections: [], required_tests: [], replaces: ["T2"] })] }, error: /N1 depends on TX.*\(unknown dependency\)/ },
  dupIds: {
    answer: { tasks: [task("N1", { required_sections: [], required_tests: [], replaces: ["T2"] }), task("N1", { title: "new2", required_sections: [], required_tests: [], replaces: ["T2"] })] },
    error: /Task id N1 appears more than once/,
  },
  cycle: {
    answer: { tasks: [task("N1", { dependsOn: ["N2"], required_sections: [], required_tests: [], replaces: ["T2"] }), task("N2", { dependsOn: ["N1"] })] },
    error: /dependency cycle: N\d -> N\d -> N\d/,
  },
  reuseCancelledId: {
    answer: { tasks: [task("T3", { title: "redo T3 fresh", required_sections: [], required_tests: [], replaces: ["T2"] }), task("N2", { dependsOn: ["T3"] })] },
    error: /T3 reuses the id of cancelled Task T3/,
  },
  retryCompleted: { answer: { tasks: [task("T1", { title: "T1 again revised" })] }, error: /T1 reuses the id of completed Task T1/ },
};

// A corrected answer: replace T2 with a new Task that builds on T1.
const correctedReplan = { tasks: [task("N9", { dependsOn: ["T1"], required_sections: [], required_tests: [], replaces: ["T2"] })] };

for (const [scenario, { answer, error }] of Object.entries(badReplans)) {
  test(`a bad replan answer (${scenario.replace(/([A-Z])/g, " $1").toLowerCase()}) is rejected before any write and the corrected answer applies`, async (t) => {
    const prompts = [];
    let replanCalls = 0;
    let stateAtRepair = null;
    let baseline = null;
    let workIdRef = null;
    const { db, core } = await openCore(t, ({ gate }) =>
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

    const replan = inBackground(core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" }));
    await waitFor(() => managerTaskRow(db, workId, "T2").status === "cancelled" || replan.settled);
    assert.equal(replan.error, null);

    assert.equal(replanCalls, 2, "one repair attempt");
    assert.deepEqual(stateAtRepair, baseline, "nothing was written for the rejected answer");
    const replanPrompts = prompts.filter(isReplan);
    const replanInput = managerInput(replanPrompts[1]);
    assert.equal(replanInput.context.previous_output_feedback.kind, "plan_rejected");
    assert.match(replanInput.context.previous_output_feedback.errors.join(" "), error);
    assert.deepEqual(replanInput.trigger, { kind: "queued_failed_tasks" }, "the original trigger is not joined with the rejection");

    const n9 = managerTaskRow(db, workId, "N9");
    assert.ok(n9, "the corrected plan was registered");
    assert.equal(managerTaskRow(db, workId, "T2").status, "cancelled", "T2 was replaced");
    assert.deepEqual(openDecisions(db, workId), []);
    assert.deepEqual(await tickTwice(core, workId), []);
    assert.equal(tickFailureAlerts(db, workId), 0);
  });
}

test("a second bad replan answer opens one Decision listing the errors and blocking only the root failed Task", async (t) => {
  const prompts = [];
  const { db, core } = await openCore(t, ({ gate }) =>
    gatedRunner((prompt) => (isReplan(prompt) ? badReplans.cancelledDep.answer : "not json"), prompts, gate),
  );
  const { workId, t2 } = await seedRepro2(core, db);
  await startWithoutDriving(core, db, workId);
  const baseline = writeState(db, workId);

  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });

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

test("the replan input carries the stored required_sections / required_tests in current_plan as well as in the failed Task", async (t) => {
  const prompts = [];
  const { db, core } = await openCore(t, ({ gate }) =>
    gatedRunner((prompt) => (isReplan(prompt) ? { tasks: [] } : "not json"), prompts, gate),
  );
  const { workId, t2 } = await seedRepro2(core, db);
  const stored = { required_sections: ["Intro"], required_tests: ["tests/a.test.mjs"] };
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET verification_spec_json = ? WHERE id = ?", JSON.stringify(stored), t2);
    return null;
  });
  await startWithoutDriving(core, db, workId);

  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });

  const input = managerInput(prompts.find(isReplan));
  const { context } = input;
  const pick = (view) => ({ required_sections: view.required_sections, required_tests: view.required_tests });
  assert.deepEqual(pick(input.tasks.find((view) => view.id === t2)), stored);
  assert.deepEqual(pick(context.failed_tasks.find((view) => view.task_id === t2)), stored);
  assert.deepEqual(pick(context.current_plan.find((view) => view.id === t2)), stored);
  for (const view of context.current_plan.filter((entry) => entry.id !== t2)) {
    assert.equal("required_sections" in view, false, "a Task without a stored spec omits the fields");
    assert.equal("required_tests" in view, false);
  }
});

test("an old-format answer without replaces is rejected by the role contract and writes nothing", async (t) => {
  const prompts = [];
  const { db, core } = await openCore(t, ({ gate }) =>
    gatedRunner((prompt) => {
      if (!isReplan(prompt)) return "not json";
      const { required_sections: [], required_tests: [], replaces: _replaces, ...old } = task("N1");
      return { tasks: [old] };
    }, prompts, gate),
  );
  const { workId, t2 } = await seedRepro2(core, db);
  await startWithoutDriving(core, db, workId);
  const baseline = writeState(db, workId);

  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });

  const after = writeState(db, workId);
  assert.equal(after.tasks, baseline.tasks);
  assert.equal(after.replanned, baseline.replanned);
  assert.equal(managerTaskRow(db, workId, "N1"), undefined);
  const decisions = openDecisions(db, workId);
  assert.equal(decisions.length, 1);
  assert.deepEqual(JSON.parse(decisions[0].blocked), [t2]);
});

test("a reopened Work with an empty replan completes after the final check without a Decision", async (t) => {
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
  const reason = "\n  Double-check;\n  if nothing is missing just finish.\n";
  await core.reopenWork(workId, commandEnvelope({ reason }, "reopen", version));

  const state = await waitFor(() => db.get("SELECT state FROM works WHERE id = ? AND state = 'completed'", workId)?.state);
  assert.equal(state, "completed", `Work state: ${db.get("SELECT state FROM works WHERE id = ?", workId).state}`);
  const replanPrompt = prompts.find(isReplan);
  assert.ok(replanPrompt, "the reopen ran a Manager replan");
  assert.deepEqual(managerInput(replanPrompt).trigger, { kind: "owner_request", owner_replan_kind: "reopen", automatic: false, situation: "other" });
  assert.equal(managerInput(replanPrompt).context.owner_requests[0].text, reason, "the Owner's reopen reason reaches the Manager verbatim");
  assert.equal(replanPrompt.includes("minItems"), false);
  assert.equal(prompts.filter(isReplan).length, 1, "the empty answer was accepted the first time");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ?", workId).n, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM tasks WHERE work_id = ?", workId).n, 1, "the empty replan wrote no Task");
});

test("each replacement takes over only its own replaced Task's dependents without a cycle", async (t) => {
  const prompts = [];
  const { db, core } = await openCore(t, ({ gate }) =>
    gatedRunner(
      (prompt) => (isReplan(prompt)
        ? { tasks: [task("N1", { required_sections: [], required_tests: [], replaces: ["T1"] }), task("N2", { dependsOn: ["T3"], required_sections: [], required_tests: [], replaces: ["T2"] })] }
        : "not json"),
      prompts,
      gate,
    ),
  );
  const created = await core.createWork(commandEnvelope({ title: "W", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  const [f1, f2, d] = await core.workflowEngine().registerPlan(
    workId,
    [engineTask("T1"), engineTask("T2"), engineTask("T3", { dependsOn: ["T1"] })],
    "work.planned",
  );
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET status = 'failed' WHERE id IN (?, ?)", f1.id, f2.id);
    tx.run("UPDATE works SET state = 'running', state_version = state_version + 1 WHERE id = ?", workId);
    return null;
  });
  await core.workflowEngine().cascadeFailure(workId, f1.id);
  await startWithoutDriving(core, db, workId);

  const replan = inBackground(core.triggerManagerReplan(workId, [f1.id, f2.id], { kind: "queued_failed_tasks" }));
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

test("a failure while applying a valid replan becomes a Decision with the real cause and the Owner's answer", async (t) => {
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
  assert.equal(managerInput(prompts.find(isReplan)).context.owner_requests[0].text, "owner-answer-marker: replace T2");
  await sleep(200);
  assert.equal(tickFailureAlerts(db, workId), 0, "no workflow_tick_failed alert");
  assert.equal(openDecisions(db, workId).length, 1);
});

test("replacing the root Task through a replan keeps the cascaded dependent and re-points it", async (t) => {
  const prompts = [];
  const { db, core } = await openCore(t, ({ gate }) =>
    gatedRunner((prompt) => (isReplan(prompt) ? { tasks: [task("N1", { required_sections: [], required_tests: [], replaces: ["T1"] })] } : "not json"), prompts, gate),
  );
  const created = await core.createWork(commandEnvelope({ title: "W", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  const [t1, t2] = await core.workflowEngine().registerPlan(workId, [engineTask("T1"), engineTask("T2", { dependsOn: ["T1"] })], "work.planned");
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET status = 'failed' WHERE id = ?", t1.id);
    tx.run("UPDATE works SET state = 'running', state_version = state_version + 1 WHERE id = ?", workId);
    return null;
  });
  await core.workflowEngine().cascadeFailure(workId, t1.id);
  await startWithoutDriving(core, db, workId);

  const replan = inBackground(core.triggerManagerReplan(workId, [t1.id, t2.id], { kind: "queued_failed_tasks" }));
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
  const feedback = managerInput(prompts[1]).context.previous_output_feedback;
  assert.equal(feedback.kind, "plan_rejected");
  assert.match(feedback.errors[0], /^Task id T1 appears more than once/);
  assert.deepEqual(managerInput(prompts[1]).trigger, { kind: "initial_plan" });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM tasks WHERE work_id = ?", workId).n, 2);
});

test("a retry's revised type and review are applied and take effect on the Task's next run", async (t) => {
  const workerRequests = [];
  const reviewerRequests = [];
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
          tasks: [{ id: "T2", title: "T2 revised as a test task", type: "test", necessity: necessityFor(), acceptance_criteria: criteriaFor("All tests pass."), depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false }],
          event: "task.replanned",
        },
      };
    },
    runWorker: async (request) => {
      workerRequests.push(request);
      await writeFile(join(request.context.worktree, "out.test.mjs"), 'import test from "node:test";\ntest("ok", () => {});\n');
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
  const { db, core } = await createTestCore(t, { agentRunner: withNecessity(agentRunner), dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-replan-retry-type-" });

  const created = await core.createWork(commandEnvelope({ title: "W", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  const t2 = createUlid();
  await db.createWriteLane().transact((tx) => {
    insertTask(tx, workId, { id: t2, status: "failed", managerTaskId: "T2", title: "failed one" });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    return null;
  });
  await core.start();

  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });

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

test("a retry's base_sync_only mark is stored per generation and never carried over", async (t) => {
  let mark = true;
  const agentRunner = {
    runManagerPlan: async (request) => {
      if (request.context?.mode === "finalize") {
        return { outcome: "success", report_valid: true, report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "done", missing: [], lessons: [] } } };
      }
      return {
        outcome: "success",
        report_valid: true,
        report: {
          tasks: [{ id: "T2", title: "T2 merges the base", type: "research", necessity: necessityFor(), acceptance_criteria: criteriaFor("Done."), depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false, context: "", notes: "", wait_for: null, base_sync_only: mark ? true : null }],
          event: "task.replanned",
        },
      };
    },
    runWorker: async (request) => ({
      outcome: "success",
      report_valid: true,
      report: { kind: "report", schema_version: "1.0.0", invocation_id: request.invocation_id, result: "success", work_done: "done", changes: [], verification: { passed: true, method: "Checked." }, remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null },
    }),
    runReviewer: async () => ({ outcome: "success", report_valid: true, report: {}, review: { verdict: "pass", summary: "ok", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } } }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await createTestCore(t, { agentRunner: withNecessity(agentRunner), dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-replan-base-sync-" });
  const created = await core.createWork(commandEnvelope({ title: "W", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  const t2 = createUlid();
  await db.createWriteLane().transact((tx) => {
    insertTask(tx, workId, { id: t2, status: "failed", managerTaskId: "T2", title: "failed one" });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    return null;
  });
  await core.start();

  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });
  assert.deepEqual({ ...db.get("SELECT base_sync_only, base_sync_generations FROM tasks WHERE id = ?", t2) }, { base_sync_only: 1, base_sync_generations: 1 });
  await waitFor(() => db.get("SELECT status FROM tasks WHERE id = ?", t2)?.status === "completed");
  assert.deepEqual(db.all("SELECT base_sync_only FROM agent_runs WHERE task_id = ? AND role = 'worker'", t2).map((row) => row.base_sync_only), [1], "the Worker run keeps the generation's mark");

  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET status = 'failed' WHERE id = ?", t2);
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    return null;
  });
  mark = false;
  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });
  assert.deepEqual({ ...db.get("SELECT base_sync_only, base_sync_generations FROM tasks WHERE id = ?", t2) }, { base_sync_only: 0, base_sync_generations: 1 });
});

test("validateReplan and validatePlan allow base_sync_only on a plan Task, a retried Task or a new Task with replaces", () => {
  const item = (extra = {}) => ({ id: "T1", title: "A", type: "code", acceptance: "x", depends_on: [], replaces: [], ...extra });
  const snapshot = { tasks: [{ id: "T1", manager_task_id: "T1", status: "failed", failed_by_dependency: false }], edges: [] };
  assert.ok(!isPlanRejection(validateReplan([item({ base_sync_only: true })], snapshot, ["T1"])), "a retried Task may carry the mark");
  assert.ok(!isPlanRejection(validateReplan([item({ id: "N1", replaces: ["T1"], base_sync_only: true })], snapshot, ["T1"])), "a new Task with replaces may carry it");
  assert.ok(isPlanRejection(validateReplan([item({ id: "N1", base_sync_only: true }), item({ id: "T1" })], snapshot, ["T1"])), "a new Task that replaces nothing may not");
  assert.ok(!isPlanRejection(validatePlan([item({ base_sync_only: true })])), "a plan may carry it");
});

test("replan: an over-threshold answer is sent back with the quality warnings, then applied and recorded", async (t) => {
  const prompts = [];
  let replanCalls = 0;
  const big = Array.from({ length: 12 }, (_, i) => ({ ...criteriaFor(`item ${i + 1} is verified by the test`)[0], id: `AC${i + 1}` }));
  const { db, core } = await openCore(t, ({ gate }) =>
    gatedRunner((prompt) => {
      if (!isReplan(prompt)) return "not json";
      replanCalls += 1;
      const acceptance_criteria = replanCalls === 1 ? big : criteriaFor("Fix it in packages/core/src/a.ts; verify with node --test.");
      return { tasks: [{ ...task("N9", { dependsOn: ["T1"], required_sections: [], required_tests: [], replaces: ["T2"] }), acceptance: undefined, acceptance_criteria }] };
    }, prompts, gate),
  );
  const { workId, t2 } = await seedRepro2(core, db);
  await startWithoutDriving(core, db, workId);
  const replan = inBackground(core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" }));
  await waitFor(() => managerTaskRow(db, workId, "T2").status === "cancelled" || replan.settled);
  assert.equal(replan.error, null);
  assert.equal(replanCalls, 2);
  const repairInput = managerInput(prompts.filter(isReplan)[1]);
  assert.equal(repairInput.context.previous_output_feedback.kind, "quality_repair");
  assert.ok(repairInput.context.previous_output_feedback.warnings.some((warning) => warning.code === "acceptance_items_over"));
  assert.deepEqual(repairInput.trigger, { kind: "queued_failed_tasks" });
  assert.ok(managerTaskRow(db, workId, "N9"));
  const events = db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.plan_quality_warned'", workId).map((row) => JSON.parse(row.payload_json));
  assert.deepEqual(events.map((event) => [event.phase, event.outcome]), [["replan", "repair_requested"]]);
  assert.ok(db.get("SELECT id FROM agent_runs WHERE id = ? AND role = 'manager'", events[0].manager_agent_run_id), "the event points at the Manager replan run");
  assert.ok(db.get("SELECT id FROM events WHERE idempotency_key = ?", `plan-quality:${workId}:${events[0].manager_agent_run_id}`));
});

test("validatePlan rejects a non-design Task that depends on a design Task, only in the first plan", () => {
  const item = (extra = {}) => ({ id: "T1", title: "A", type: "code", acceptance: "x", depends_on: [], replaces: [], ...extra });
  const rejected = validatePlan([item({ id: "D1", type: "design" }), item({ id: "I1", depends_on: ["D1"] })]);
  assert.ok(isPlanRejection(rejected));
  assert.equal(rejected.errors.length, 1);
  assert.match(rejected.errors[0], /I1.*D1.*after the design is completed/);
  assert.ok(!isPlanRejection(validatePlan([item({ id: "D1", type: "design" }), item({ id: "R1", type: "research" })])), "independent Tasks are fine");
  assert.ok(!isPlanRejection(validatePlan([item({ id: "D1", type: "design" }), item({ id: "D2", type: "design", depends_on: ["D1"] })])), "design may depend on design");
  assert.ok(!isPlanRejection(validatePlan([item({ id: "I1" }), item({ id: "I2", depends_on: ["I1"] })])), "no design Task");
  const snapshot = { tasks: [{ id: "D1", manager_task_id: "D1", status: "completed", failed_by_dependency: false }], edges: [] };
  assert.ok(!isPlanRejection(validateReplan([item({ id: "I1", depends_on: ["D1"] })], snapshot, [])), "a replan may depend on a completed design Task");
});

test("first plan: a Task depending on a design Task gets plan_rejected feedback from Core, then the repaired plan is applied", async (t) => {
  const feedbacks = [];
  const design = { ...task("D1"), type: "design", review: false };
  const plans = [[design, { ...task("I1", { dependsOn: ["D1"] }), review: false }], [design]];
  const gate = workerGate();
  t.after(gate.release);
  const { db, core } = await createTestCore(t, {
    agentRunner: {
      runManagerPlan: async (request) => {
        feedbacks.push(request.context?.previous_output_feedback ?? null);
        return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: plans[Math.min(feedbacks.length, plans.length) - 1] } };
      },
      runWorker: async () => {
        await gate.promise;
        return { outcome: "failed", failure_class: "transient", error_key: "x", retry_allowed: true, message: "x" };
      },
      runReviewer: async () => ({ outcome: "failed" }),
      runAdvisor: async () => ({ reply: "" }),
    },
    max_parallel: 4,
    dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 },
  }, { prefix: "owl-plan-design-dep-", start: true });
  const created = await core.createWork(commandEnvelope({ title: "W", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  inBackground(core.startWork(workId, commandEnvelope({ mode: "normal" }, "start", created.version)));
  await waitFor(() => db.get("SELECT COUNT(*) AS n FROM tasks WHERE work_id = ?", workId).n === 1);
  assert.equal(feedbacks[0], null);
  assert.equal(feedbacks[1].kind, "plan_rejected");
  assert.match(feedbacks[1].errors.join(" "), /I1.*D1.*after the design is completed/);
});
