import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { isPlanRejection, validatePlan, validateReplan } from "../../packages/core/dist/replan-plan.js";
import { evaluateCriteriaRelaxation } from "../../packages/core/dist/plan-quality.js";
import { DEFAULT_PROGRESS_GUARD_SETTINGS } from "../../packages/shared/dist/progress-guard-settings.js";
import { DEFAULT_PLAN_QUALITY_SETTINGS } from "../../packages/shared/dist/plan-quality-settings.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { criterionRequirement } from "../../packages/shared/dist/acceptance-criteria.js";
import { createTaskPlanInTransaction, createWorkInTransaction } from "../../packages/core/dist/index.js";
import { applyReplanInTransaction } from "../../packages/core/dist/state-reducer.js";
import { openTestDatabase } from "../helpers/db.mjs";
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

  // A plan_rejected final answer is recovered automatically twice (default limit); the third round opens the Decision.
  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });
  assert.equal(openDecisions(db, workId).length, 0, "no Decision on the first final rejection");
  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });
  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });

  assert.equal(prompts.filter(isReplan).length, 9);
  const decisions = openDecisions(db, workId);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].issuer_role, "manager");
  assert.equal(decisions[0].scope, "task");
  assert.deepEqual(JSON.parse(decisions[0].blocked), [t2]);
  // The English validation message stays in the logs; the Owner reads the fact and the count, in every field.
  const shown = db.get("SELECT reason, question, current_state, tried, options_json FROM decisions WHERE id = ?", decisions[0].id);
  const everything = Object.values(shown).join("\n");
  assert.doesNotMatch(everything, /rejected twice|depends on T3|auto_recovery|criteria_relaxations/);
  assert.match(shown.tried, /検証ではじかれ/);
  assert.match(shown.tried, /3回/);
  assert.match(shown.reason, /failed one/, "the reason names the failed Task");
  const after = writeState(db, workId);
  assert.equal(after.plan_revision, baseline.plan_revision);
  assert.equal(after.tasks, baseline.tasks);
  assert.equal(after.replanned, baseline.replanned);
  assert.equal(managerTaskRow(db, workId, "T2").status, "judgement_waiting");
  assert.deepEqual(await tickTwice(core, workId), []);
  assert.equal(tickFailureAlerts(db, workId), 0, "never a tick error");
});

test("a plan that changes a criterion without a criteria_relaxations entry is rejected twice and the Decision shows no English validation text", async (t) => {
  const prompts = [];
  const changed = { ...task("T2", { title: "failed one" }), acceptance_criteria: criteriaFor("Loosened: verified by a lighter test.") };
  const { db, core } = await openCore(t, ({ gate }) =>
    gatedRunner((prompt) => (isReplan(prompt) ? { tasks: [changed] } : "not json"), prompts, gate),
  );
  const { workId, t2 } = await seedRepro2(core, db);
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET acceptance_criteria_json = ? WHERE id = ?", JSON.stringify(criteriaFor("Done; verified by the test.")), t2);
    // The Worker reported a criteria defect, so the replan must revise T2's criteria.
    const sequence = tx.get("SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM events").n;
    tx.run(
      `INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, agent_run_id, payload_json, status, attempt_no, created_at)
       VALUES (?, ?, ?, 'task.acceptance_defect_reported', ?, ?, NULL, '{"defects":[],"reason":"cannot check the layout"}', 'handled', 0, ?)`,
      createUlid(), sequence, `defect:${createUlid()}`, workId, t2, new Date().toISOString(),
    );
    return null;
  });
  await startWithoutDriving(core, db, workId);

  for (let round = 0; round < 3; round += 1) await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });

  const decisions = openDecisions(db, workId);
  assert.equal(decisions.length, 1);
  const shown = db.get("SELECT reason, question, current_state, tried, options_json FROM decisions WHERE id = ?", decisions[0].id);
  const everything = Object.values(shown).join("\n");
  assert.doesNotMatch(everything, /was changed but|criteria_relaxations|auto_recovery|Criterion AC/);
  assert.match(shown.tried, /検証ではじかれ/);
  assert.match(shown.tried, /3回/);
  assert.match(shown.reason, /cannot check the layout/, "with no report, the reason comes from the failure record");
});

for (const [name, type, payload, expected] of [
  [
    "a failed verification names the failed tests",
    "verification.completed",
    {
      outcome: "fail",
      verification: {
        source: "core",
        error: "internal check detail",
        commands: [{ command_id: "policy:test", passed: false }],
        test_run: { run_id: "r1", mode: "selected", files_run: 1, failed_files: ["tests/layout.test.mjs"], failures: { failures: [{ file: "tests/layout.test.mjs", name: "lists mikata_long" }], omitted_count: 0 } },
      },
    },
    /通らなかった検査: tests\/layout\.test\.mjs: lists mikata_long/,
  ],
  [
    "a failed verification without test failures names the failed check",
    "verification.completed",
    { outcome: "fail", verification: { source: "core", error: "internal check detail", commands: [{ command_id: "policy:doc", passed: false, file: "docs/a.md" }, { command_id: "policy:test", passed: true }] } },
    /通らなかった検査: policy:doc \(docs\/a\.md\)$/m,
  ],
  [
    "a merge conflict names the conflicting files",
    "task.conflict",
    { merge_conflict_files: ["src/a.ts", "src/b.ts"] },
    /統合でコンフリクトしたファイル: src\/a\.ts, src\/b\.ts/,
  ],
]) {
  test(`with no report, the replan_failed reason takes the cause from the failure record: ${name}`, async (t) => {
    const prompts = [];
    const { db, core } = await openCore(t, ({ gate }) =>
      gatedRunner((prompt) => (isReplan(prompt) ? badReplans.cancelledDep.answer : "not json"), prompts, gate),
    );
    const { workId, t2 } = await seedRepro2(core, db);
    await db.createWriteLane().transact((tx) => {
      const sequence = tx.get("SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM events").n;
      tx.run(
        `INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, agent_run_id, payload_json, status, attempt_no, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'handled', 0, ?)`,
        createUlid(), sequence, `failure:${createUlid()}`, type, workId, t2, JSON.stringify(payload), new Date().toISOString(),
      );
      return null;
    });
    await startWithoutDriving(core, db, workId);

    for (let round = 0; round < 3; round += 1) await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });

    const decisions = openDecisions(db, workId);
    assert.equal(decisions.length, 1);
    assert.match(decisions[0].reason, /タスク「failed one」が失敗しました。/);
    assert.match(decisions[0].reason, expected);
    assert.doesNotMatch(decisions[0].reason, /失敗の理由は記録されていません|internal check detail/);
  });
}

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

for (const issuer of ["core", "manager"]) {
  test(`a fix option chosen on a ${issuer} Decision reaches the Manager as the answer, and the Work goes on`, async (t) => {
    const prompts = [];
    const { db, core } = await openCore(t, ({ gate }) =>
      gatedRunner((prompt) => (isReplan(prompt) ? correctedReplan : "not json"), prompts, gate),
    );
    const { workId, t2 } = await seedRepro2(core, db);
    const decisionId = createUlid();
    const options = [
      { key: "fix_1", label: "Do you want to split T2 in two?", description: "Replaces T2 with smaller Tasks.", instruction: "fix-instruction-marker: replace T2 with two smaller Tasks", criteria_rewrites: [] },
      { key: "retry", label: "Retry", description: "Run again." },
      { key: "cancel", label: "Cancel", description: "Stop." },
    ];
    await db.createWriteLane().transact((tx) => {
      tx.run("UPDATE works SET state = 'judgement_waiting' WHERE id = ?", workId);
      tx.run("UPDATE tasks SET status = 'judgement_waiting' WHERE id = ?", t2);
      tx.run(
        `INSERT INTO decisions (id, work_id, scope, status, blocked_task_ids_json, reason, tried, current_state, options_json, recommended, allow_free_text, issuer_role, state_version, created_at)
         VALUES (?, ?, 'task', 'open', ?, 'Stopped.', 'Core', 'judgement_waiting', ?, 'fix_1', 1, ?, 0, ?)`,
        decisionId, workId, JSON.stringify([t2]), JSON.stringify(options), issuer, new Date().toISOString(),
      );
      return null;
    });
    await core.start();
    await core.answerDecision(
      decisionId,
      commandEnvelope({ answer: options[0].label, option_key: "fix_1", source_message_id: null }, "answer"),
    );

    await waitFor(() => prompts.some(isReplan));
    const text = managerInput(prompts.find(isReplan)).context.owner_requests[0].text;
    assert.match(text, /Chosen option: Do you want to split T2 in two\? - Replaces T2 with smaller Tasks\./);
    assert.match(text, /Instruction: fix-instruction-marker: replace T2 with two smaller Tasks/);
    await waitFor(() => managerTaskRow(db, workId, "T2").status === "cancelled");
    assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  });
}

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

test("validateReplan accepts a ready Task listed in revisable as a revision and rejects the unsafe forms", () => {
  const item = (extra = {}) => ({ id: "R1", title: "A", type: "code", acceptance: "x", depends_on: [], replaces: [], ...extra });
  const snapshot = { tasks: [{ id: "R1", manager_task_id: "R1", status: "ready", failed_by_dependency: false }], edges: [] };
  const revisable = new Map([["R1", "code"]]);
  const check = (items, options = {}) => validateReplan(items, snapshot, [], { allowOpen: true, revisable, ...options });
  const accepted = check([item({ title: "Rewritten" })]);
  assert.ok(!isPlanRejection(accepted), "a ready Task in revisable may be revised");
  assert.deepEqual([...accepted.reviseIds], ["R1"]);
  assert.equal(accepted.revisions.get("R1").title, "Rewritten");
  assert.deepEqual(accepted.reopenIds, []);
  for (const [name, items, options] of [
    ["replaces", [item({ replaces: ["R1"] })]],
    ["wait_for", [item({ wait_for: { conditions: [{ kind: "owner", description: "later" }], reason: "x" } })]],
    ["a type change", [item({ type: "design" })]],
    ["base_sync_only", [item({ base_sync_only: true })]],
    ["a replacement of the same Task", [item(), item({ id: "N1", replaces: ["R1"] })]],
    ["a task_action on the same Task", [item()], { actions: [{ task_id: "R1", action: "cancel", reason: "x" }] }],
  ]) {
    assert.ok(isPlanRejection(check(items, options)), `${name} is rejected`);
  }
  assert.ok(isPlanRejection(validateReplan([item()], snapshot, [], { allowOpen: true })), "without revisable a ready Task is still rejected");
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

/** Retry one failed Task with a revision that changes its type or designation, and read back its designer state. */
async function retryDesignerState(t, { designMode, from, revision }) {
  const { db } = await openTestDatabase(t, { prefix: "owl-replan-designer-" });
  const created = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Designer retry", summary: "x", size: "normal", project_id: null, design_mode: designMode });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    const [task] = createTaskPlanInTransaction(tx, work.id, [
      { id: "T1", title: "Task", type: from.type, assigned_designer: from.assigned_designer, acceptance: "Done", depends_on: [] },
    ]);
    tx.run("UPDATE tasks SET status = 'failed', design_escalated = ? WHERE id = ?", from.escalated ?? 0, task.id);
    return { work_id: work.id, id: task.id };
  });
  await db.createWriteLane().transact((tx) => {
    applyReplanInTransaction(tx, created.work_id, {
      newItems: [],
      revisions: new Map([[created.id, { title: "Task", acceptance: "Done", ...revision }]]),
      reopenIds: [created.id],
      supersessions: new Map(),
      waits: new Map(),
      actions: new Map(),
    }, { base_plan_revision: 0, root_statuses: new Map() }, "test");
  });
  return db.get("SELECT type, assigned_designer, lead_designer_start_round AS start, design_escalated AS escalated FROM tasks WHERE id = ?", created.id);
}

test("a retried design Task given designer returns to the standard Designer", async (t) => {
  const state = await retryDesignerState(t, { designMode: "auto", from: { type: "design", assigned_designer: "lead_designer" }, revision: { type: "design", assigned_designer: "designer" } });
  assert.deepEqual(state, { type: "design", assigned_designer: "designer", start: null, escalated: 0 });
});

test("a retried design Task given null keeps its designation", async (t) => {
  const state = await retryDesignerState(t, { designMode: "auto", from: { type: "design", assigned_designer: "lead_designer" }, revision: { type: "design" } });
  assert.deepEqual(state, { type: "design", assigned_designer: "lead_designer", start: 0, escalated: 0 });
});

test("a design_mode=lead Work keeps Lead when a retry names designer", async (t) => {
  const state = await retryDesignerState(t, { designMode: "lead", from: { type: "design" }, revision: { type: "design", assigned_designer: "designer" } });
  assert.deepEqual(state, { type: "design", assigned_designer: "designer", start: 0, escalated: 0 });
});

test("a design_mode=lead Work makes a code Task retried as design a Lead Task", async (t) => {
  const state = await retryDesignerState(t, { designMode: "lead", from: { type: "code" }, revision: { type: "design" } });
  assert.deepEqual(state, { type: "design", assigned_designer: null, start: 0, escalated: 0 });
});

test("a design_mode=auto Work decides a code Task retried as design by its designation", async (t) => {
  const standard = await retryDesignerState(t, { designMode: "auto", from: { type: "code" }, revision: { type: "design" } });
  assert.deepEqual(standard, { type: "design", assigned_designer: null, start: null, escalated: 0 });
  const lead = await retryDesignerState(t, { designMode: "auto", from: { type: "code" }, revision: { type: "design", assigned_designer: "lead_designer" } });
  assert.deepEqual(lead, { type: "design", assigned_designer: "lead_designer", start: 0, escalated: 0 });
});

test("an escalated design Task retried as code loses every designer state", async (t) => {
  const state = await retryDesignerState(t, { designMode: "auto", from: { type: "design", escalated: 1 }, revision: { type: "code" } });
  assert.deepEqual(state, { type: "code", assigned_designer: null, start: null, escalated: 0 });
});

// Automatic recovery of a Manager call: a final quality rejection and a temporary provider error each get
// a counted wait first, and only after the limit become a Decision.

const recoveryRecords = (db, workId) =>
  db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'recovery.started' ORDER BY sequence", workId).map((row) => JSON.parse(row.payload_json));

/** A Core whose Manager is `manage(request, callNo)`; the Work driver is not running. */
async function openStubManagerCore(t, manage) {
  const calls = [];
  const agentRunner = {
    runManagerPlan: async (request) => {
      calls.push(request);
      return manage(request, calls.length);
    },
    runWorker: async () => ({ outcome: "failed", failure_class: "transient", error_key: "x", retry_allowed: true, message: "x" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const opened = await createTestCore(t, { agentRunner, max_parallel: 4, dispatcher: { tick_interval_ms: 60_000, manager_retry_delay_ms: 1 } }, { prefix: "owl-replan-recovery-" });
  return { ...opened, calls };
}

test("a replan the quality check finally rejects opens no Decision the first time and hands its feedback to the next Manager call", async (t) => {
  const bad = { ...task("N1", { replaces: ["T2"] }), review: false, acceptance: "x", acceptance_criteria: criteriaFor("本番のデータが前後で変わらない") };
  const { db, core, calls } = await openStubManagerCore(t, () => ({ outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [bad] } }));
  const { workId, t2 } = await seedRepro2(core, db);
  await startWithoutDriving(core, db, workId);

  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });
  const firstRoundCalls = calls.length;
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ?", workId).n, 0, "no Decision on the first final rejection");
  const records = recoveryRecords(db, workId);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "plan_quality_rejected");
  assert.equal(records[0].counted, true);
  assert.equal(records[0].attempt_no, 1);
  const feedback = JSON.parse(records[0].previous_failure.detail);
  assert.equal(feedback.kind, "quality_rejected");
  assert.equal(feedback.warnings[0].code, "external_state_comparison");

  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });
  assert.deepEqual(calls[firstRoundCalls].context.previous_output_feedback, feedback, "the next Manager call starts from the last feedback");

  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });
  assert.equal(recoveryRecords(db, workId).length, 2);
  assert.equal(openDecisions(db, workId).length, 1, "after the limit a Decision opens");
  assert.match(openDecisions(db, workId)[0].tried, /自動で試したこと|Tried automatically/);
});

test("a replan hit by a 503 waits for resume_at without calling the Manager, and after the limit opens a Decision", async (t) => {
  const start = Date.parse("2030-01-02T03:04:05.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const { db, core, calls } = await openStubManagerCore(t, () => ({ outcome: "failed", failure_class: "transient", error_key: "provider_failed:harness_error:503", retry_allowed: true, message: "503 Service Unavailable" }));
  const { workId, t2 } = await seedRepro2(core, db);
  await startWithoutDriving(core, db, workId);
  const queueTrigger = () => db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO idempotency_keys (key, request_hash, response_json, status_code, created_at, expires_at)
     VALUES (?, ?, ?, 202, ?, ?) ON CONFLICT(key) DO UPDATE SET response_json = excluded.response_json`,
    `manager-trigger:${t2}`, "0".repeat(64), JSON.stringify({ status: "queued" }), new Date().toISOString(), "2031-01-02T03:04:05.000Z",
  ));
  await queueTrigger();

  await core.tick(workId);
  assert.equal(calls.length, 1);
  assert.equal(openDecisions(db, workId).length, 0, "the first failure opens no Decision");
  const first = recoveryRecords(db, workId);
  assert.equal(first.length, 1);
  assert.deepEqual([first[0].kind, first[0].counted, first[0].attempt_no], ["provider_transient", true, 1]);
  assert.equal(first[0].resume_at, new Date(start + 15 * 60_000).toISOString());

  t.mock.timers.setTime(start + 60_000);
  await core.tick(workId);
  assert.equal(calls.length, 1, "no Manager call before resume_at");

  t.mock.timers.setTime(Date.parse(first[0].resume_at));
  await core.tick(workId);
  assert.equal(calls.length, 2);
  const second = recoveryRecords(db, workId);
  assert.equal(second.length, 2);
  assert.equal(second[1].resume_at, new Date(Date.parse(first[0].resume_at) + 30 * 60_000).toISOString());
  assert.equal(openDecisions(db, workId).length, 0);

  t.mock.timers.setTime(Date.parse(second[1].resume_at));
  await core.tick(workId);
  assert.equal(calls.length, 3);
  assert.equal(recoveryRecords(db, workId).length, 2, "no third recovery");
  assert.equal(openDecisions(db, workId).length, 1, "after the limit a Decision opens");
  assert.match(openDecisions(db, workId)[0].tried, /自動で試したこと|Tried automatically/);
});

const MANAGER = { kind: "manager", source: null, quote: "" };
const OWNER = { kind: "owner", source: "summary", quote: "check it" };
const stored = (id, origin, extra = {}) => ({ id, text: `${id} holds`, check: "node --test the file", kind: "work_check", check_weight: "light", weight_reason: "", serves: "test fixture", if_omitted: "test fixture", origin, ...extra });
const loosened = (before, extra = {}) => ({ ...before, text: `${before.id} holds for a sample`, ...extra });
const record = (id, extra = {}) => ({ criterion_id: id, reason: "too wide to prove", keeps: "the sample still holds", ...extra });

test("evaluateCriteriaRelaxation accepts a recorded loosening of a Manager criterion and rejects each way of breaking the rules", () => {
  const S = DEFAULT_PLAN_QUALITY_SETTINGS;
  const before = stored("AC1", MANAGER);
  const run = (revised, records) => evaluateCriteriaRelaxation([before], revised, records, S);
  assert.deepEqual(run([loosened(before)], [record("AC1")]), []);
  assert.match(run([], [record("AC1")]).join("\n"), /removed/);
  assert.match(run([loosened(before, { text: "" })], [record("AC1")]).join("\n"), /empty/);
  assert.match(run([loosened(before, { check: " " })], [record("AC1")]).join("\n"), /empty/);
  assert.match(run([loosened(before, { kind: "spec_test" })], [record("AC1")]).join("\n"), /kind must stay/);
  assert.match(run([loosened(before)], [record("AC1", { keeps: "" })]).join("\n"), /keeps/);
  assert.match(run([loosened(before, { text: "Run it on 全件" })], [record("AC1")]).join("\n"), /plan quality/);
  assert.match(run([loosened(before)], []).join("\n"), /no entry/);
});

test("validateReplan: an automatic replan loosens Manager criteria but never changes or removes an Owner (or origin-less) criterion; an Owner replan may", () => {
  const snapshot = { tasks: [{ id: "T1", manager_task_id: "T1", status: "failed", failed_by_dependency: false }], edges: [] };
  const retry = (criteria, relaxations) => ({
    id: "T1", title: "A", type: "code", acceptance: "x", depends_on: [], replaces: [],
    acceptance_criteria: criteria, auto_recovery: relaxations === undefined ? undefined : { criteria_relaxations: relaxations },
  });
  const validate = (current, criteria, relaxations, automatic = true) =>
    validateReplan([retry(criteria, relaxations)], snapshot, ["T1"], { currentCriteria: new Map([["T1", current]]), automatic });
  const owner = stored("AC1", OWNER);
  const noOrigin = stored("AC1", undefined);
  const manager = stored("AC1", MANAGER);
  assert.ok(!isPlanRejection(validate([manager], [loosened(manager)], [record("AC1")])));
  for (const protectedCriterion of [owner, noOrigin]) {
    assert.ok(isPlanRejection(validate([protectedCriterion], [loosened(protectedCriterion)], [record("AC1")])), "text change");
    assert.ok(isPlanRejection(validate([protectedCriterion], [{ ...protectedCriterion, check: "node --test other" }], [])), "check change");
    assert.ok(isPlanRejection(validate([protectedCriterion], [stored("AC2", MANAGER)], [])), "removal");
    assert.ok(!isPlanRejection(validate([protectedCriterion], [protectedCriterion], [])), "unchanged is fine");
    assert.ok(!isPlanRejection(validate([protectedCriterion], [loosened(protectedCriterion)], [], false)), "an Owner replan may change it");
  }
});

const setProgressGuard = (db, patch) => db.createWriteLane().transact((tx) => {
  const now = new Date().toISOString();
  tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
  return tx.run(
    "INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('progress_guard', 'owner:default', '1.0.0', ?, ?)",
    JSON.stringify({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, ...patch }), now,
  );
});

const stubAnswer = (tasks) => ({ outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: tasks.map((entry) => ({ ...entry, review: false })) } });
const RULE = { criterion_id: "AC1", rule: "Only changed files are checked", applies: true, reason: "AC1 is about changed files." };
const RELAX = { criterion_id: "AC1", reason: "too wide to prove", keeps: "the sample still holds" };
const loosenedPlan = (extra = {}) => ({ ...task("T2", { title: "failed one" }), acceptance: "Loosened", acceptance_criteria: criteriaFor("Loosened: verified by a lighter test."), ...extra });

// Each case: a plan with the omission, the plan that fixes it, and the text the feedback must contain.
const omissionCases = {
  "criteria_relaxations missing": {
    defect: true,
    bad: loosenedPlan(),
    good: loosenedPlan({ auto_recovery: { criteria_relaxations: [RELAX] } }),
    field: /criteria_relaxations|no entry/,
  },
  "rewrite reason (keeps) empty in criteria_relaxations": {
    defect: true,
    bad: loosenedPlan({ auto_recovery: { criteria_relaxations: [{ ...RELAX, keeps: "" }] } }),
    good: loosenedPlan({ auto_recovery: { criteria_relaxations: [RELAX] } }),
    field: /keeps/,
  },
  "reason omitted in criteria_relaxations": {
    defect: true,
    bad: loosenedPlan({ auto_recovery: { criteria_relaxations: [{ criterion_id: "AC1", keeps: RELAX.keeps }] } }),
    good: loosenedPlan({ auto_recovery: { criteria_relaxations: [RELAX] } }),
    field: /reason/,
  },
  "reason blank in criteria_relaxations": {
    defect: true,
    bad: loosenedPlan({ auto_recovery: { criteria_relaxations: [{ ...RELAX, reason: "  " }] } }),
    good: loosenedPlan({ auto_recovery: { criteria_relaxations: [RELAX] } }),
    field: /reason/,
  },
  "criteria_relaxations not a list": {
    defect: true,
    bad: loosenedPlan({ auto_recovery: { criteria_relaxations: "AC1 is loosened" } }),
    good: loosenedPlan({ auto_recovery: { criteria_relaxations: [RELAX] } }),
    field: /Task T2: .*criteria_relaxations must be a list of criterion_id, reason and keeps/,
  },
  "criterion_id missing in criteria_relaxations": {
    defect: true,
    bad: loosenedPlan({ auto_recovery: { criteria_relaxations: [{ reason: RELAX.reason, keeps: RELAX.keeps }] } }),
    good: loosenedPlan({ auto_recovery: { criteria_relaxations: [RELAX] } }),
    field: /Task T2: .*criteria_relaxations must be a list of criterion_id, reason and keeps/,
  },
  "rule_applicability empty": {
    trigger: (t2) => ({ kind: "task_failed", tasks: [{ kind: "partial_repeated", task_id: t2 }] }),
    bad: { ...task("T2", { title: "failed one" }), acceptance: "Done; verified by the test.", auto_recovery: { criteria_relaxations: [], criterion_checks: [], rule_applicability: [] } },
    good: { ...task("T2", { title: "failed one" }), acceptance: "Done; verified by the test.", auto_recovery: { criteria_relaxations: [], criterion_checks: [], rule_applicability: [RULE] } },
    field: /rule_applicability/,
  },
};

async function seedOmission(core, db, { defect }) {
  const seeded = await seedRepro2(core, db);
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE tasks SET acceptance_criteria_json = ? WHERE id = ?", JSON.stringify(criteriaFor("Done; verified by the test.")), seeded.t2);
    if (defect) {
      const sequence = tx.get("SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM events").n;
      tx.run(
        `INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, agent_run_id, payload_json, status, attempt_no, created_at)
         VALUES (?, ?, ?, 'task.acceptance_defect_reported', ?, ?, NULL, '{"defects":[],"reason":"cannot check the layout"}', 'handled', 0, ?)`,
        createUlid(), sequence, `defect:${createUlid()}`, seeded.workId, seeded.t2, new Date().toISOString(),
      );
    }
    return null;
  });
  return seeded;
}

for (const [name, spec] of Object.entries(omissionCases)) {
  test(`a plan with ${name} goes back to the Manager with the field named, opens no Decision before the limit and is applied once fixed`, async (t) => {
    const { db, core, calls } = await openStubManagerCore(t, (_request, n) => stubAnswer([n < 3 ? spec.bad : spec.good]));
    const { workId, t2 } = await seedOmission(core, db, spec);
    await startWithoutDriving(core, db, workId);
    const before = writeState(db, workId);

    const replan = inBackground(core.triggerManagerReplan(workId, [t2], spec.trigger?.(t2) ?? { kind: "queued_failed_tasks" }));
    await waitFor(() => calls.length >= 3 || replan.settled);

    assert.equal(calls.length, 3, "the default allows three Manager calls");
    assert.ok(!calls[0].context.previous_output_feedback);
    for (const call of calls.slice(1, 3)) {
      const feedback = call.context.previous_output_feedback;
      assert.match(JSON.stringify(feedback), spec.field, "the feedback names the missing item");
    }
    assert.deepEqual(openDecisions(db, workId), []);
    assert.equal(recoveryRecords(db, workId).length, 0, "no recovery was started before the limit");
    await waitFor(() => writeState(db, workId).plan_revision > before.plan_revision || replan.settled);
    assert.ok(writeState(db, workId).plan_revision > before.plan_revision, "only the fixed third answer was applied");
  });
}

for (const limit of [1, 3]) {
  test(`plan_rejection_attempts_max=${limit}: an incomplete plan is sent to the Manager ${limit} time(s) per round and the Decision opens after the recovery rounds`, async (t) => {
    const { db, core, calls } = await openStubManagerCore(t, () => stubAnswer([omissionCases["criteria_relaxations missing"].bad]));
    await setProgressGuard(db, { plan_rejection_attempts_max: limit });
    const { workId, t2 } = await seedOmission(core, db, { defect: true });
    await startWithoutDriving(core, db, workId);
    const before = writeState(db, workId);

    await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });
    assert.equal(calls.length, limit);
    assert.deepEqual(openDecisions(db, workId), []);
    await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });
    assert.equal(calls.length, limit * 2);
    assert.deepEqual(openDecisions(db, workId), []);
    await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });
    assert.equal(calls.length, limit * 3);
    assert.equal(openDecisions(db, workId).length, 1);
    assert.equal(writeState(db, workId).plan_revision, before.plan_revision, "the incomplete plan was never applied");
  });
}

test("the Owner's one-line answer to a replan_failed Decision is in work.owner_guidance of the next Manager call", async (t) => {
  const { db, core, calls } = await openStubManagerCore(t, () => stubAnswer([omissionCases["criteria_relaxations missing"].bad]));
  const { workId, t2 } = await seedOmission(core, db, { defect: true });
  await startWithoutDriving(core, db, workId);
  for (let round = 0; round < 3; round += 1) await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });
  const [decision] = openDecisions(db, workId);
  assert.ok(decision);

  const before = calls.length;
  await core.answerDecision(
    decision.id,
    commandEnvelope({ answer: "OWNER-ONE-LINE: relax the wording only", option_key: null, source_message_id: null }, "answer", decision.state_version),
  );
  await core.tick(workId);
  await waitFor(() => calls.length > before);
  assert.equal(calls[before].context.work.owner_guidance[0].answer, "OWNER-ONE-LINE: relax the wording only");
});

/** One automatic replan whose stub Manager answers `first`, then `fixed`; `seen` is the state each Manager call found. */
async function replanFixedOnSecondCall(t, first, fixed, { seed = async () => {}, configure = async () => {} } = {}) {
  const ref = {};
  const seen = [];
  const { db, core, calls } = await openStubManagerCore(t, (_request, n) => {
    seen.push({ plan_revision: writeState(ref.db, ref.workId).plan_revision, decisions: openDecisions(ref.db, ref.workId).length });
    return stubAnswer([n === 1 ? first : fixed]);
  });
  const { workId, t2 } = await seedRepro2(core, db);
  await seed(db, t2);
  Object.assign(ref, { db, workId });
  await startWithoutDriving(core, db, workId);
  await configure(core);
  const initial = writeState(db, workId).plan_revision;
  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });
  assert.equal(calls.length, 2);
  assert.deepEqual(seen[1], { plan_revision: initial, decisions: 0 }, "the rejected plan was not applied and no Decision opened before the second call");
  assert.ok(writeState(db, workId).plan_revision > initial, "the fixed plan was applied");
  assert.deepEqual(openDecisions(db, workId), []);
  return { db, workId, feedback: calls[1].context.previous_output_feedback };
}

const replacementN1 = (criteria) => ({ ...task("N1", { dependsOn: ["T1"], replaces: ["T2"] }), acceptance_criteria: criteria });
const storedCriteriaOf = (db, workId, managerTaskId) =>
  JSON.parse(db.get("SELECT acceptance_criteria_json AS json FROM tasks WHERE work_id = ? AND manager_task_id = ?", workId, managerTaskId).json);

test("a replacement Task that drops the Owner's criteria goes back with each criterion's original id, text and check, and is applied once they are carried over", async (t) => {
  const quoted = { kind: "owner", source: "summary", quote: "x" };
  const ownerCriteria = ["AC1", "AC2", "AC3"].map((id) => stored(id, quoted, { text: `${id}: the Owner's "exact" wording`, check: `node --test tests/${id.toLowerCase()}.test.mjs` }));
  const { db, workId, feedback } = await replanFixedOnSecondCall(t, replacementN1(criteriaFor("Done; verified by the test.")), replacementN1(ownerCriteria), {
    seed: (db, t2) => db.createWriteLane().transact((tx) => tx.run("UPDATE tasks SET acceptance_criteria_json = ? WHERE id = ?", JSON.stringify(ownerCriteria), t2)),
  });
  assert.equal(feedback.kind, "plan_rejected");
  for (const criterion of ownerCriteria) {
    const error = feedback.errors.find((line) => line.startsWith(`Task T2: criterion ${criterion.id} `));
    assert.ok(error, `the feedback names T2 and ${criterion.id}`);
    assert.ok(error.includes(JSON.stringify(criterion.text)), `the feedback quotes the text of ${criterion.id}`);
    assert.ok(error.includes(JSON.stringify(criterion.check)), `the feedback quotes the check of ${criterion.id}`);
  }
  assert.deepEqual(storedCriteriaOf(db, workId, "N1").map((criterion) => [criterion.id, criterion.text, criterion.check]), ownerCriteria.map((criterion) => [criterion.id, criterion.text, criterion.check]));
});

test("heavy_check_unjustified goes back with the Task and every criterion id, opens no Decision before the limit and is applied once fixed", async (t) => {
  const light = ["AC1", "AC2", "AC3"].map((id) => stored(id, MANAGER));
  const heavy = [{ ...light[0], text: "Run it on 全件" }, light[1], { ...light[2], check: "node --test with 実モデル" }];
  const { feedback } = await replanFixedOnSecondCall(t, replacementN1(heavy), replacementN1(light));
  assert.equal(feedback.kind, "quality_repair");
  const warning = feedback.warnings.find((entry) => entry.code === "heavy_check_unjustified");
  assert.equal(warning.task_ref, "N1");
  assert.deepEqual(warning.measured, ["AC1", "AC3"]);
  assert.match(warning.detail, /^Task N1: criteria AC1, AC3 need a heavy check without a reason/);
});

test("acceptance_chars_over, when sent back, goes back with the Task, the total and limit and each criterion's length, and is applied once fixed", async (t) => {
  const short = ["AC1", "AC2", "AC3"].map((id) => stored(id, MANAGER));
  const long = [{ ...short[0], text: "a".repeat(1000) }, { ...short[1], text: "b".repeat(600) }, short[2]];
  const { feedback } = await replanFixedOnSecondCall(t, replacementN1(long), replacementN1(short), {
    // By default acceptance_chars_over is record-only and never sent back; this turns that off to follow the send-back path.
    configure: (core) => core.setPlanQualitySettings({ ...DEFAULT_PLAN_QUALITY_SETTINGS, record_only_codes: [] }),
  });
  assert.equal(feedback.kind, "quality_repair");
  const warning = feedback.warnings.find((entry) => entry.code === "acceptance_chars_over");
  assert.equal(warning.task_ref, "N1");
  assert.deepEqual([warning.measured, warning.threshold], [1669, 1500]);
  assert.match(warning.detail, /^Task N1: the acceptance is 1669 characters in total \(limit 1500\); .*AC1 1020, AC2 620, AC3 29\./);
});

test("a plan still over a non-blocking limit is not applied before the last call plan_rejection_attempts_max allows", async (t) => {
  const items = Array.from({ length: DEFAULT_PLAN_QUALITY_SETTINGS.max_acceptance_items + 1 }, (_, i) => stored(`AC${i + 1}`, MANAGER));
  const ref = {};
  const seen = [];
  const { db, core, calls } = await openStubManagerCore(t, () => {
    seen.push(writeState(ref.db, ref.workId).plan_revision);
    return stubAnswer([replacementN1(items)]);
  });
  await setProgressGuard(db, { plan_rejection_attempts_max: 4 });
  const { workId, t2 } = await seedRepro2(core, db);
  Object.assign(ref, { db, workId });
  await startWithoutDriving(core, db, workId);
  const initial = writeState(db, workId).plan_revision;
  await core.triggerManagerReplan(workId, [t2], { kind: "queued_failed_tasks" });
  assert.equal(calls.length, 4);
  assert.deepEqual(seen, [initial, initial, initial, initial]);
  const outcomes = db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.plan_quality_warned' ORDER BY sequence", workId).map((row) => JSON.parse(row.payload_json).outcome);
  assert.deepEqual(outcomes, ["repair_requested", "repair_requested", "repair_requested", "accepted_with_warnings"]);
  assert.ok(writeState(db, workId).plan_revision > initial, "on the last call the current judgement accepts it with warnings");
});

test("a replan that revises a Task clears its goal_shortfalls_json and keeps a stored criterion without requirement as required", async (t) => {
  const quoted = { kind: "owner", source: "summary", quote: "x" };
  const stale = [{ criterion_id: "AC1", text: "old goal", reason: "old reason", source: "worker" }];
  const noRequirement = ["AC1", "AC2", "AC3"].map((id) => stored(id, quoted));
  const { db, workId } = await replanFixedOnSecondCall(t, replacementN1(criteriaFor("Done; verified by the test.")), { ...task("T2", { title: "failed one" }), acceptance_criteria: noRequirement }, {
    seed: (db, t2) => db.createWriteLane().transact((tx) => tx.run("UPDATE tasks SET acceptance_criteria_json = ?, goal_shortfalls_json = ? WHERE id = ?", JSON.stringify(noRequirement), JSON.stringify(stale), t2)),
  });
  const row = db.get("SELECT goal_shortfalls_json AS g, acceptance_criteria_json AS c FROM tasks WHERE work_id = ? AND manager_task_id = 'T2'", workId);
  assert.equal(row.g, null);
  for (const criterion of JSON.parse(row.c)) assert.equal(criterionRequirement(criterion), "required");
});

test("an automatic replan cannot change the requirement of an Owner or Manager criterion, and evaluateCriteriaRelaxation refuses it", () => {
  const snapshot = { tasks: [{ id: "T1", manager_task_id: "T1", status: "failed", failed_by_dependency: false }], edges: [] };
  const retry = (criteria) => ({ id: "T1", title: "A", type: "code", acceptance: "x", depends_on: [], replaces: [], acceptance_criteria: criteria });
  const validate = (current, criteria) => validateReplan([retry(criteria)], snapshot, ["T1"], { currentCriteria: new Map([["T1", current]]), automatic: true });
  for (const origin of [OWNER, MANAGER]) {
    const required = stored("AC1", origin);
    assert.ok(isPlanRejection(validate([required], [{ ...required, requirement: "goal" }])), "required to goal");
    assert.ok(!isPlanRejection(validate([required], [{ ...required, requirement: "required" }])), "the same requirement is fine");
    const goal = { ...required, requirement: "goal" };
    assert.ok(isPlanRejection(validate([goal], [{ ...goal, requirement: "required" }])), "goal to required");
  }
  const manager = stored("AC1", MANAGER);
  const errors = evaluateCriteriaRelaxation([manager], [{ ...manager, requirement: "goal" }], [record("AC1")], DEFAULT_PLAN_QUALITY_SETTINGS);
  assert.ok(errors.some((line) => /requirement must stay required/.test(line)));
});

test("an automatic replan cannot change a Manager criterion's requirement when a replacement Task carries it", () => {
  const snapshot = { tasks: [{ id: "T1", manager_task_id: "T1", status: "failed", failed_by_dependency: false }], edges: [] };
  const manager = stored("AC1", MANAGER);
  const replace = (criterion) => validateReplan([{ id: "N1", title: "A", type: "code", acceptance: "x", depends_on: [], replaces: ["T1"], acceptance_criteria: [criterion] }], snapshot, ["T1"], { currentCriteria: new Map([["T1", [manager]]]), automatic: true });
  assert.ok(!isPlanRejection(replace(manager)), "the same requirement is fine");
  assert.ok(isPlanRejection(replace({ ...manager, requirement: "goal" })), "required to goal");
});
