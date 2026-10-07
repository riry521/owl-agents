import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { necessityFor, criteriaFor } from "../helpers/necessity.mjs";

import { createUlid } from "../../packages/db/dist/index.js";
import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { splitRolePrompt } from "../../packages/agent-runtime/dist/role-contract.js";
import { loadFixContext, readDependencyReport } from "../../packages/core/dist/task-context.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { waitFor } from "../helpers/wait.mjs";

// What a Worker and the Manager are told about earlier
// work. A dependent Worker gets its completed dependencies' reports and
// artifacts and its real depends_on; a fix attempt gets the verification
// failure or the latest review's findings of the attempt before it, never a
// stale round; a Manager replan gets readable failure details (never an
// internal hash) and, after an incomplete final review, what is missing.
//
// Every test drives Core through a real agent runner whose provider answers
// by role, so the assertions read the rendered prompts the agents would see.

const HEX64 = /\b[0-9a-f]{64}\b/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A plan Task in the Manager answer format. */
const planTask = (id, { dependsOn = [], review = false, title = `${id} title` } = {}) => ({
  id,
  title,
  type: "code",
  necessity: necessityFor(), acceptance_criteria: criteriaFor("Done."),
  depends_on: dependsOn,
  context: "",
  notes: "",
  review,
  required_sections: [], required_tests: [], wait_for: null, base_sync_only: null,
  replaces: [],
});

function workerReport(invocationId, extra = {}) {
  return {
    kind: "report",
    schema_version: "1.1.0",
    invocation_id: invocationId,
    result: "success",
    work_done: "Did the work.",
    changes: [],
    verification: { status: "passed", method: "Checked the output.", acceptance: [{ criterion_id: "AC1", status: "passed", evidence: "e" }], checks: [], integration_check: null },
    delegation: { decomposition: "Kept together.", delegated: [], retained: [{ part: "Whole Task", reason: "No independent part was identified." }] },
    remaining_issues: [],
    next_action: "none",
    needs_replanning: false,
    question_for_manager: null, pending_process: null, external_blocker: null,
    ...extra,
  };
}

function review(verdict, problem = null) {
  return {
    verdict,
    summary: `review ${verdict}`,
    findings: problem === null ? [] : [{ severity: "major", subject: "other", file: "out.txt", line: 1, problem, reason: "r", fix: "f" }],
    tests: { ran: false, command: "none", passed: 0, failed: 0 },
  };
}

const COMPLETE = { verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } };

/** The JSON of one `### <name>` input slot of the prompt. */
function promptInput(prompt, name) {
  const inputs = splitRolePrompt(prompt)?.inputs;
  assert.ok(inputs && Object.hasOwn(inputs, name), `prompt has a ${name} section`);
  return inputs[name];
}

const workerInput = (call) => Object.fromEntries(["Project", "Task", "Dependencies", "Attempt"].map((name) => [name, promptInput(call.prompt, name)]));
const managerInput = (call) => promptInput(call.prompt, "Manager input");
const isPlan = (call) => call.role === "manager" && call.prompt.includes("Plan the Work in the input below");
const isReplan = (call) => call.role === "manager" && call.prompt.includes("This is a REPLAN");
const isFinal = (call) => call.role === "manager" && call.prompt.includes("final review");

/**
 * Core with a real agent runner. `answer(call)` returns the provider result
 * for each call: an object/string (stdout, exit 0) or `{ exit_code, stderr }`.
 * Every call is recorded with its role, prompt, cwd and invocation id.
 */
async function openCore(t, answer, { autoOutput = true } = {}) {
  const calls = [];
  const agentRunner = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        const call = {
          role: request.role,
          prompt: String(request.prompt ?? ""),
          cwd: request.cwd ?? null,
          invocation_id: request.invocation_id,
        };
        calls.push(call);
        if (autoOutput && call.role === "worker" && call.cwd) await writeFile(join(call.cwd, "worker-output.mjs"), `export const run = "${request.invocation_id}";\n`);
        const out = await answer(call, calls);
        if (out && typeof out === "object" && typeof out.exit_code === "number") {
          return { adapter: request.adapter, stdout: "", stderr: out.stderr ?? "", exit_code: out.exit_code, signal: null, format: "plain-text" };
        }
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
  const { db, core } = await createTestCore(t, {
    agentRunner,
    max_parallel: 4,
    dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 },
  }, { prefix: "owl-context-handoff-" });
  return { db, core, calls };
}

async function startWork(core) {
  await core.start();
  const created = await core.createWork(command({ title: "W", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  await core.startWork(workId, command({ mode: "normal" }, "start", created.version));
  return workId;
}

const workState = (db, workId) => db.get("SELECT state FROM works WHERE id = ?", workId).state;
const taskId = (db, workId, managerTaskId) =>
  db.get("SELECT id FROM tasks WHERE work_id = ? AND manager_task_id = ?", workId, managerTaskId).id;
const workerCallsFor = (calls, title) => calls.filter((call) => call.role === "worker" && workerInput(call).Task.title === title);

test("a dependent Worker receives the completed dependency's report and artifact paths and its real depends_on", async (t) => {
  const { db, core, calls } = await openCore(t, async (call) => {
    if (isPlan(call)) return { tasks: [planTask("T1", { title: "A" }), planTask("T2", { title: "B", dependsOn: ["T1"] })] };
    if (isFinal(call)) return COMPLETE;
    if (call.role === "worker") {
      if (workerInput(call).Task.title === "A") {
        await writeFile(join(call.cwd, "out.mjs"), "export {};\n");
        return workerReport(call.invocation_id, {
          work_done: "Wrote output FOO-MARKER.",
          changes: [{ file: "out.mjs", action: "created" }],
          remaining_issues: [{ issue: "LEFT-OPEN-MARKER", impact: "low", next_step: "later" }],
        });
      }
      await writeFile(join(call.cwd, "b-out.mjs"), "export {};\n");
      return workerReport(call.invocation_id);
    }
    return review("pass");
  }, { autoOutput: false });
  const workId = await startWork(core);
  await waitFor(() => workState(db, workId) === "completed");
  assert.equal(workState(db, workId), "completed");

  const [first] = workerCallsFor(calls, "A");
  const [second] = workerCallsFor(calls, "B");
  assert.ok(first && second, "both Workers ran");
  const t1 = taskId(db, workId, "T1");

  const a = workerInput(first);
  assert.deepEqual(a.Task.depends_on, []);
  assert.deepEqual(a.Dependencies.dependencies, []);
  assert.deepEqual(a.Dependencies.artifact_paths, []);

  const b = workerInput(second);
  assert.deepEqual(b.Task.depends_on, [t1], "the real dependency ids, not []");
  const [summary] = b.Dependencies.dependencies;
  assert.deepEqual(b.Dependencies.dependencies, [{
    task_id: t1,
    manager_task_id: "T1",
    title: "A",
    work_done: "Wrote output FOO-MARKER.",
    changed_files: ["out.mjs"],
    open_issues: ["LEFT-OPEN-MARKER"],
    design_document_path: null,
    report_path: summary.report_path,
  }]);
  assert.equal(readDependencyReport(summary.report_path).work_done, "Wrote output FOO-MARKER.");
  assert.deepEqual(b.Dependencies.artifact_paths, ["out.mjs"]);
  assert.equal(b.Attempt.previous_report, null);
  assert.deepEqual(b.Attempt.reviewer_findings, []);
  assert.equal(b.Attempt.verification_failure, null);
  for (const call of calls) assert.doesNotMatch(call.prompt, HEX64, `${call.role} prompt carries no 64-hex value`);

  // The run's per-slot hashes and prompt mode are stored on its agent_runs row, never in the prompt.
  const run = db.get("SELECT * FROM agent_runs WHERE id = ?", second.invocation_id);
  for (const column of ["prompt_header_hash", "prompt_project_hash", "prompt_task_hash", "prompt_dynamic_hash"]) {
    assert.match(run[column], /^[0-9a-f]{64}$/u, column);
  }
  assert.ok(["fresh", "resumed", "handoff"].includes(run.prompt_mode), run.prompt_mode);
});

test("the dependency summary setting, written through Core, sets the length of the summary a dependent Worker receives", async (t) => {
  const { db, core, calls } = await openCore(t, async (call) => {
    if (isPlan(call)) return { tasks: [planTask("T1", { title: "A" }), planTask("T2", { title: "B", dependsOn: ["T1"] })] };
    if (isFinal(call)) return COMPLETE;
    if (call.role === "worker") {
      await writeFile(join(call.cwd, `${workerInput(call).Task.title}.mjs`), "export {};\n");
      return workerReport(call.invocation_id, { work_done: "0123456789".repeat(10) });
    }
    return review("pass");
  }, { autoOutput: false });
  await core.start();
  const created = await core.createWork(command({ title: "W", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  assert.deepEqual(await core.getDependencySummarySettings(), { max_chars: 600 });
  for (const bad of [{ max_chars: 0 }, { max_chars: 1.5 }, { max_chars: "25" }, { max_chars: 25, extra: 1 }, {}]) {
    await assert.rejects(core.setDependencySummarySettings(bad));
  }
  assert.deepEqual(await core.setDependencySummarySettings({ max_chars: 25 }), { max_chars: 25 });
  await core.startWork(workId, command({ mode: "normal" }, "start", created.version));
  await waitFor(() => workState(db, workId) === "completed");
  const [second] = workerCallsFor(calls, "B");
  assert.equal(workerInput(second).Dependencies.dependencies[0].work_done.length, 25);
});

test("a self-contradictory success report is rejected before verification and the retry keeps the last accepted report", async (t) => {
  // repro-context: attempt 1 is sent back by the Reviewer, attempt 2 fails
  // its own verification, attempt 3 passes review. Attempt 3 must see the
  // verification failure, not the older review's findings.
  let attempts = 0;
  let reviews = 0;
  const { db, core, calls } = await openCore(t, (call) => {
    if (isPlan(call)) return { tasks: [planTask("T1", { title: "A", review: true })] };
    if (isFinal(call)) return COMPLETE;
    if (call.role === "worker") {
      attempts += 1;
      const failed = attempts === 2;
      return workerReport(call.invocation_id, {
        work_done: `attempt ${attempts} WORK-${attempts}-MARKER`,
        verification: { status: failed ? "failed" : "passed", method: failed ? "VERIF-FAIL-MARKER tests failed" : "ok", acceptance: [{ criterion_id: "AC1", status: failed ? "failed" : "passed", evidence: "e" }], checks: [], integration_check: null },
      });
    }
    reviews += 1;
    return reviews === 1 ? review("fix_required", "REVIEW-FINDING-1") : review("pass");
  });
  const workId = await startWork(core);
  await waitFor(() => workState(db, workId) === "completed");
  assert.equal(workState(db, workId), "completed");

  const workerCalls = workerCallsFor(calls, "A");
  const inputs = workerCalls.map(workerInput);
  assert.equal(inputs.length, 3);

  assert.equal(inputs[0].Attempt.verification_failure, null);
  assert.equal(inputs[0].Attempt.previous_report, null);
  assert.deepEqual(inputs[0].Attempt.reviewer_findings, []);

  // Attempt 2 follows the Reviewer's fix_required.
  assert.equal(inputs[1].Attempt.verification_failure, null);
  assert.match(inputs[1].Attempt.previous_report.work_done, /WORK-1-MARKER/);
  assert.deepEqual(inputs[1].Attempt.reviewer_findings.map((finding) => finding.problem), ["REVIEW-FINDING-1"]);

  // A success report whose verification failed contradicts itself: the protocol
  // rejects it before Core verification, so the retry keeps the last accepted
  // report and the Reviewer findings.
  assert.equal(inputs[2].Attempt.verification_failure, null);
  assert.match(inputs[2].Attempt.previous_report.work_done, /WORK-1-MARKER/);
  assert.deepEqual(inputs[2].Attempt.reviewer_findings.map((finding) => finding.problem), ["REVIEW-FINDING-1"]);
});

test("a review-fix attempt receives only the latest round's findings", async (t) => {
  let attempts = 0;
  let reviews = 0;
  const { db, core, calls } = await openCore(t, (call) => {
    if (isPlan(call)) return { tasks: [planTask("T1", { title: "A", review: true })] };
    if (isFinal(call)) return COMPLETE;
    if (call.role === "worker") {
      attempts += 1;
      return workerReport(call.invocation_id, { work_done: `attempt ${attempts} WORK-${attempts}-MARKER` });
    }
    reviews += 1;
    return reviews <= 2 ? review("fix_required", `ROUND-${reviews}-FINDING`) : review("pass");
  });
  const workId = await startWork(core);
  await waitFor(() => workState(db, workId) === "completed");
  assert.equal(workState(db, workId), "completed");

  const workerCalls = workerCallsFor(calls, "A");
  const inputs = workerCalls.map(workerInput);
  assert.equal(inputs.length, 3);
  assert.deepEqual(inputs[0].Attempt.reviewer_findings, []);
  assert.deepEqual(inputs[1].Attempt.reviewer_findings.map((finding) => finding.problem), ["ROUND-1-FINDING"]);
  assert.match(inputs[1].Attempt.previous_report.work_done, /WORK-1-MARKER/);
  assert.deepEqual(inputs[2].Attempt.reviewer_findings.map((finding) => finding.problem), ["ROUND-2-FINDING"]);
  assert.match(inputs[2].Attempt.previous_report.work_done, /WORK-2-MARKER/);
  assert.doesNotMatch(workerCalls[2].prompt, /ROUND-1-FINDING/);
  for (const input of inputs) assert.equal(input.Attempt.verification_failure, null);
  // The Reviewer sees the Task through the same fixed view: no hashes.
  for (const call of calls.filter((c) => c.role === "reviewer")) assert.doesNotMatch(call.prompt, HEX64);
});

test("a Manager replan receives readable failure details, not hashes", async (t) => {
  let replans = 0;
  let dbRef = null;
  let keyAtReplan = null;
  const { db, core, calls } = await openCore(t, (call) => {
    if (isPlan(call)) return { tasks: [planTask("T1", { title: "A" })] };
    if (isReplan(call)) {
      replans += 1;
      keyAtReplan ??= dbRef.get("SELECT last_error_key AS k FROM tasks WHERE manager_task_id = 'T1'").k;
      return { tasks: [planTask("T1", { title: "A" })] };
    }
    if (isFinal(call)) return COMPLETE;
    if (call.role === "worker" && replans === 0) {
      return workerReport(call.invocation_id, {
        result: "failed",
        work_done: "Could not write out.txt: DISK-FULL-MARKER.",
        verification: { status: "failed", method: "none", acceptance: [{ criterion_id: "AC1", status: "failed", evidence: "e" }], checks: [], integration_check: null },
        remaining_issues: [{ issue: "out.txt missing", impact: "high", next_step: "free disk space" }],
      });
    }
    if (call.role === "worker") return workerReport(call.invocation_id);
    return review("pass");
  });
  dbRef = db;
  const workId = await startWork(core);
  await waitFor(() => workState(db, workId) === "completed");
  assert.equal(workState(db, workId), "completed", "the retried Task completed");

  const replan = calls.find(isReplan);
  assert.ok(replan, "the Manager was asked to replan");
  const input = managerInput(replan);
  const t1 = taskId(db, workId, "T1");
  assert.deepEqual(input.context.failed_task_ids, [t1]);
  assert.equal(input.tasks.length, 1);
  assert.equal(input.tasks[0].status, "failed");
  assert.ok(!("last_error_key" in input.tasks[0]), "the task view has no error hash");
  assert.deepEqual(input.context.failed_tasks, [{
    task_id: t1,
    manager_task_id: "T1",
    title: "A",
    acceptance_criteria: [{ id: "AC1", text: "Done.", check: "test fixture", serves: "test fixture", if_omitted: "test fixture", check_weight: "light", weight_reason: "", kind: "work_check" }],
    acceptance_defects: [],
    // One field per fact: no joined sentence, and no `detail`.
    failure: { kind: "worker_failed", role: "Worker", reported_result: "failed", work_done: "Could not write out.txt: DISK-FULL-MARKER.", reason: null },
    last_report: {
      work_done: "Could not write out.txt: DISK-FULL-MARKER.",
      changes: [],
      remaining_issues: [{ issue: "out.txt missing", impact: "high", next_step: "free disk space" }],
    },
    reviewer_findings: [],
    verification_failure: null,
  }]);
  assert.equal(input.context.final_verdict, null);

  // The failed Task's stored last_error_key (read when the replan was asked)
  // is a 64-hex hash; no prompt may carry it or any other 64-hex value.
  assert.match(keyAtReplan, /^[0-9a-f]{64}$/);
  for (const call of calls) {
    assert.doesNotMatch(call.prompt, HEX64, `${call.role} prompt carries no 64-hex value`);
    assert.ok(!call.prompt.includes(keyAtReplan), `${call.role} prompt does not carry last_error_key`);
  }
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

test("a replan after an incomplete final verdict carries final_verdict.missing", async (t) => {
  // mgr/repro6: the final review says the Work is incomplete; the Owner
  // answers "retry"; the replan Manager must see what is missing.
  let finals = 0;
  const incomplete = {
    verdict: {
      verdict: "incomplete",
      summary: "mostly done",
      missing: [{ item: "MISSING-MARKER docs page", reason: "no report mentions docs", fix: "FIX-MARKER write docs/x.md" }],
      lessons: [],
    },
  };
  const { db, core, calls } = await openCore(t, (call) => {
    if (isFinal(call)) {
      finals += 1;
      return finals === 1 ? incomplete : COMPLETE;
    }
    if (isReplan(call)) {
      return { tasks: [{ ...planTask("N1", { title: "write docs" }), type: "doc" }] };
    }
    if (call.role === "worker") return workerReport(call.invocation_id);
    return review("pass");
  });
  const created = await core.createWork(command({ title: "W", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  const t1 = createUlid();
  await db.createWriteLane().transact((tx) => {
    insertTask(tx, workId, { id: t1, status: "completed", managerTaskId: "T1", title: "done" });
    insertReport(tx, workId, t1);
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    return null;
  });
  await core.start();
  await core.tick(workId);
  const decision = await waitFor(() =>
    db.get("SELECT id FROM decisions WHERE work_id = ? AND status = 'open'", workId));
  assert.ok(decision, "the incomplete final verdict opened an Owner Decision");
  const { options_json: optionsJson } = db.get("SELECT options_json FROM decisions WHERE id = ?", decision.id);
  const retry = JSON.parse(optionsJson).find((option) => option.key === "retry");
  await core.answerDecision(decision.id, command({ answer: retry.label, option_key: "retry", source_message_id: null }, "answer"));
  await waitFor(() => calls.some(isReplan));

  const replan = calls.find(isReplan);
  assert.ok(replan, "the Owner's retry answer led to a replan");
  assert.match(replan.prompt, /MISSING-MARKER/);
  const input = managerInput(replan);
  assert.deepEqual(input.context.final_verdict, {
    summary: "mostly done",
    missing: [{ item: "MISSING-MARKER docs page", reason: "no report mentions docs", fix: "FIX-MARKER write docs/x.md" }],
  });
  assert.deepEqual(input.context.failed_task_ids, []);
  assert.deepEqual(input.context.failed_tasks, []);
  for (const call of calls) assert.doesNotMatch(call.prompt, HEX64);
});

// Fix context never crosses a replan boundary, and a missing or
// damaged stored review is skipped instead of failing every Worker attempt.

test("a Task retried by the Manager does not receive the pre-replan reviewer findings", async (t) => {
  let attempts = 0;
  let reviews = 0;
  const { db, core, calls } = await openCore(t, (call) => {
    if (isPlan(call)) return { tasks: [planTask("T1", { title: "A", review: true })] };
    if (isReplan(call)) return { tasks: [planTask("T1", { title: "A", review: true })] };
    if (isFinal(call)) return COMPLETE;
    if (call.role === "worker") {
      attempts += 1;
      return workerReport(call.invocation_id, { work_done: `attempt ${attempts} WORK-${attempts}-MARKER` });
    }
    reviews += 1;
    return reviews === 1 ? review("replan_required", "PRE-REPLAN-FINDING") : review("pass");
  });
  const workId = await startWork(core);
  await waitFor(() => workState(db, workId) === "completed");
  assert.equal(workState(db, workId), "completed");

  const replan = calls.find(isReplan);
  assert.ok(replan, "the Reviewer's replan_required reached the Manager");
  assert.deepEqual(
    managerInput(replan).context.failed_tasks[0].reviewer_findings.map((finding) => finding.problem),
    ["PRE-REPLAN-FINDING"],
    "the Manager still sees why the Task failed",
  );
  const workerCalls = workerCallsFor(calls, "A");
  assert.equal(workerCalls.length, 2);
  const retried = workerInput(workerCalls[1]);
  assert.deepEqual(retried.Attempt.reviewer_findings, [], "no pre-replan findings");
  assert.equal(retried.Attempt.verification_failure, null);
  assert.equal(retried.Attempt.previous_report, null);
  assert.doesNotMatch(workerCalls[1].prompt, /PRE-REPLAN-FINDING/);
});

test("a missing stored review does not stop the Worker; it runs with no fix context", async (t) => {
  let attempts = 0;
  let reviews = 0;
  const { db, core, calls } = await openCore(t, (call) => {
    if (isPlan(call)) return { tasks: [planTask("T1", { title: "A", review: true })] };
    if (isFinal(call)) return COMPLETE;
    if (call.role === "worker") {
      attempts += 1;
      return workerReport(call.invocation_id, { work_done: `attempt ${attempts}` });
    }
    reviews += 1;
    return reviews === 1 ? review("fix_required", "LOST-FINDING") : review("pass");
  });
  // Every stored review disappears right after it is written.
  await db.createWriteLane().transact((tx) =>
    tx.run("CREATE TRIGGER wp8_drop_review AFTER INSERT ON reviews BEGIN DELETE FROM reviews WHERE id = NEW.id; END"),
  );
  const workId = await startWork(core);
  await waitFor(() => workState(db, workId) === "completed");
  assert.equal(workState(db, workId), "completed");
  const workerCalls = workerCallsFor(calls, "A");
  assert.equal(workerCalls.length, 2, "the fix attempt ran");
  const fix = workerInput(workerCalls[1]);
  assert.deepEqual(fix.Attempt.reviewer_findings, []);
  assert.equal(fix.Attempt.previous_report, null);
  assert.equal(fix.Attempt.verification_failure, null);
});

test("loadFixContext only reads verdicts after the latest replan, restore or Decision answer for the Task", async (t) => {
  const { db, core } = await openCore(t, () => "not json");
  const created = await core.createWork(command({ title: "W", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  const taskA = createUlid();
  const other = createUlid();
  const lane = db.createWriteLane();
  await lane.transact((tx) => {
    insertTask(tx, workId, { id: taskA, status: "failed", managerTaskId: "T1", title: "A" });
    insertTask(tx, workId, { id: other, status: "failed", managerTaskId: "T2", title: "B" });
    return null;
  });
  const event = (type, taskIdValue, payload) => lane.transact((tx) => {
    const sequence = tx.get("SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM events").n;
    tx.run(
      `INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, agent_run_id, payload_json, status, attempt_no, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'handled', 0, ?)`,
      createUlid(), sequence, `test:${createUlid()}`, type, workId, taskIdValue, JSON.stringify(payload), new Date().toISOString(),
    );
    return null;
  });
  const verificationFailed = (marker) =>
    event("verification.completed", taskA, { outcome: "fail", verification: { source: "core", commands: [], error: marker } });
  const fixError = () => loadFixContext(db, taskA)?.verification_failure?.error ?? null;

  await verificationFailed("BEFORE-REPLAN");
  assert.equal(fixError(), "BEFORE-REPLAN");
  await event("task.replanned", null, { task_ids: [other] });
  assert.equal(fixError(), "BEFORE-REPLAN", "another Task's replan is not a boundary");
  await event("task.replanned", null, { task_ids: [taskA] });
  assert.equal(loadFixContext(db, taskA), null, "the Work-level replan listing the Task cuts it");

  await verificationFailed("BEFORE-RESTORE");
  assert.equal(fixError(), "BEFORE-RESTORE");
  await event("task.dependency_restored", taskA, { task_id: taskA, restored_dependency_task_id: other });
  assert.equal(loadFixContext(db, taskA), null, "a cascade restore cuts it");

  await verificationFailed("BEFORE-ANSWER");
  const decisionId = createUlid();
  await lane.transact((tx) => tx.run(
    `INSERT INTO decisions (id, work_id, scope, status, blocked_task_ids_json, reason, tried, current_state, options_json, recommended, allow_free_text, issuer_role, state_version, created_at)
     VALUES (?, ?, 'task', 'resolved', ?, 'r', 't', 'c', '[]', NULL, 1, 'manager', 1, ?)`,
    decisionId, workId, JSON.stringify([taskA]), new Date().toISOString(),
  ));
  await event("decision.resolved", null, { decision_id: decisionId, answer: "retry" });
  assert.equal(loadFixContext(db, taskA), null, "the answer to a Decision blocking the Task cuts it");

  // A review.failed whose stored review is missing or malformed is skipped
  // (logged), never thrown or reinterpreted.
  const reviewerRun = createUlid();
  await event("review.failed", taskA, { agent_run_id: reviewerRun, review: { verdict: "fix_required" } });
  assert.equal(loadFixContext(db, taskA), null, "missing reviews row");
  await lane.transact((tx) => tx.run(
    `INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at)
     VALUES (?, ?, 0, 'fix_required', '{"not":"a list"}', '{"report":{}}', ?)`,
    reviewerRun, taskA, new Date().toISOString(),
  ));
  assert.equal(loadFixContext(db, taskA), null, "invalid stored review shape");
  await lane.transact((tx) => tx.run("UPDATE reviews SET findings_json = '[{\"problem\":\"OK-FINDING\"}]' WHERE id = ?", reviewerRun));
  assert.deepEqual(loadFixContext(db, taskA), { previous_report: {}, reviewer_findings: [{ problem: "OK-FINDING" }] });
});
