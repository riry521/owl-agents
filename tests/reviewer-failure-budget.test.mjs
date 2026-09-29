import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core, NoopGitGateway, reduceTask } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";

// Reviewer failures are counted in tasks.reviewer_failure_count, which
// Worker starts and successes never reset, and a Manager replan gives the
// Task its review rounds back without colliding with its earlier reviews
// rows (reviews.round is a per-Task sequence).

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

async function openCore(t, agentRunner, git) {
  const root = await mkdtemp(join(tmpdir(), "owl-reviewer-budget-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, git, dispatcher: { tick_interval_ms: 25 } });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });
  await core.start();
  return { db, core };
}

/** A GitGateway whose changedPaths always reports a fixed, known list of files. */
class FakeChangedPathsGit extends NoopGitGateway {
  async changedPaths() {
    return ["src/index.ts", "out/a.txt"];
  }
}

async function startWork(core, suffix) {
  const created = await core.createWork(commandEnvelope({ title: suffix, summary: "Exercise the Reviewer budget.", size: "normal", project_id: null }, `${suffix}-create`));
  await core.startWork(created.data.work_id, commandEnvelope({ mode: "normal" }, `${suffix}-start`, created.version));
  return created.data.work_id;
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

function workerReport(invocationId) {
  return {
    kind: "report",
    schema_version: "1.0.0",
    invocation_id: invocationId,
    result: "success",
    work_done: "Done.",
    changes: [],
    verification: { passed: true, method: "Checked." },
    remaining_issues: [],
    next_action: "none",
    needs_replanning: false,
    question_for_manager: null,
  };
}

const planTask = (overrides = {}) => ({ id: "T1", title: "A", type: "code", acceptance: "Done.", depends_on: [], replaces: [], review: true, ...overrides });

const reviewerContractInvalid = () => ({
  outcome: "failed",
  failure_class: "deterministic",
  error_key: "contract_invalid",
  retry_allowed: true,
  message: "Reviewer contract invalid",
});

function reviewResult(verdict) {
  const review = verdict === "pass"
    ? { verdict: "pass", summary: "Looks right.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } }
    : {
        verdict,
        summary: "One correction remains.",
        findings: [{ severity: "major", pre_existing: false, file: "a.txt", problem: "Wrong value.", fix: "Use the right value." }],
        tests: { ran: false, command: "none", passed: 0, failed: 0 },
      };
  return { outcome: verdict === "pass" ? "success" : "failed", report_valid: true, report: review, review };
}

const finalComplete = (request) => ({
  outcome: "success",
  report_valid: true,
  report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } },
});

test("a Reviewer that always fails stops the Task after three Reviewer failures and triggers a Manager replan", async (t) => {
  // A successful Worker pass resets the Worker failure counters, so without
  // a separate reviewer_failure_count a Reviewer that always fails would let
  // Worker/Reviewer rounds repeat without ever stopping.
  let workerCalls = 0;
  let reviewerCalls = 0;
  const replanSnapshots = [];
  let db;
  const agentRunner = {
    runManagerPlan: async (request) => {
      if ((request.mode ?? request.context?.mode) === "plan") {
        return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask()] } };
      }
      if (request.mode === "replan") {
        replanSnapshots.push(db.get("SELECT status, reviewer_failure_count FROM tasks WHERE manager_task_id = 'T1'"));
        return { outcome: "failed", message: "The Manager stops here in this test." };
      }
      return { outcome: "failed", message: `unexpected manager ${request.mode}` };
    },
    runWorker: async (request) => {
      workerCalls += 1;
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => {
      reviewerCalls += 1;
      return reviewerContractInvalid();
    },
    runAdvisor: async () => ({ reply: "" }),
  };
  const opened = await openCore(t, agentRunner);
  db = opened.db;
  const workId = await startWork(opened.core, "reviewer-loop");

  assert.ok(await waitFor(() => replanSnapshots.length > 0), "the Manager replan is triggered");
  await sleep(400); // a regression would keep looping here
  assert.equal(reviewerCalls, 3, "the Reviewer runs exactly three times");
  assert.ok(workerCalls <= 4, `Worker invocations are bounded (got ${workerCalls})`);
  assert.deepEqual(replanSnapshots, [{ status: "failed", reviewer_failure_count: 3 }]);

  const task = db.get("SELECT id, reviewer_failure_count, failure_count, same_error_count, last_error_key, review_round FROM tasks WHERE work_id = ? AND manager_task_id = 'T1'", workId);
  assert.equal(task.reviewer_failure_count, 3);
  // Worker counters are left to describe Worker failures only.
  assert.equal(task.failure_count, 0);
  assert.equal(task.same_error_count, 0);
  assert.equal(task.last_error_key, null);
  // A Reviewer failure produced no finding, so it consumed no review round.
  assert.equal(task.review_round, 0);
  assert.ok(db.get("SELECT key FROM idempotency_keys WHERE key = ?", `manager-trigger:${task.id}`), "a manager-trigger row exists");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'review.failed'", task.id).n, 3);
});

test("a replanned Task gets its review rounds back and its later review row does not collide", async (t) => {
  // Reviewer: one crash, then fix_required three times (review_round 0 -> 2,
  // then failed), then, after the Manager retried the Task, pass.
  const reviewerScript = ["crash", "fix_required", "fix_required", "fix_required", "pass"];
  let reviewerCalls = 0;
  const workerSnapshots = [];
  const managerModes = [];
  let db;
  const agentRunner = {
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      managerModes.push(mode);
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask()] } };
      if (mode === "replan") {
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [planTask({ title: "A (revised)" })] } };
      }
      if (mode === "finalize") return finalComplete(request);
      return { outcome: "failed", message: `unexpected manager ${mode}` };
    },
    runWorker: async (request) => {
      workerSnapshots.push(db.get("SELECT title, review_round, reviewer_failure_count FROM tasks WHERE id = ?", request.task_id));
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => {
      const step = reviewerScript[reviewerCalls] ?? "pass";
      reviewerCalls += 1;
      return step === "crash" ? reviewerContractInvalid() : reviewResult(step);
    },
    runAdvisor: async () => ({ reply: "" }),
  };
  const opened = await openCore(t, agentRunner);
  db = opened.db;
  const workId = await startWork(opened.core, "reviewer-replan");

  const done = await waitFor(() => db.get("SELECT state FROM works WHERE id = ? AND state = 'completed'", workId), 8_000);
  assert.ok(done, `the Work completes (state=${db.get("SELECT state FROM works WHERE id = ?", workId)?.state})`);
  assert.deepEqual(managerModes, ["plan", "replan", "finalize"]);
  assert.equal(reviewerCalls, 5);

  assert.equal(workerSnapshots.length, 5);
  // Before the replan: Worker starts and successes did not erase the
  // Reviewer failure, and the fix rounds were consumed.
  assert.deepEqual(workerSnapshots[3], { title: "A", review_round: 2, reviewer_failure_count: 1 });
  // After task.replanned: both budgets are back to 0.
  assert.deepEqual(workerSnapshots[4], { title: "A (revised)", review_round: 0, reviewer_failure_count: 0 });

  const task = db.get("SELECT id, status, review_round, reviewer_failure_count FROM tasks WHERE work_id = ? AND manager_task_id = 'T1'", workId);
  assert.equal(task.status, "completed");
  assert.equal(task.reviewer_failure_count, 0);
  const replanned = db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'task.replanned'", workId);
  assert.deepEqual(JSON.parse(replanned.payload_json).task_ids, [task.id], "the Task was replanned (retried), not superseded");
  const reviews = db.all("SELECT round, verdict FROM reviews WHERE task_id = ? ORDER BY round", task.id);
  // reviews.round is a per-Task sequence: the post-replan review is round 3,
  // not a second round 0 (which would violate UNIQUE (task_id, round)).
  assert.deepEqual(reviews, [
    { round: 0, verdict: "fix_required" },
    { round: 1, verdict: "fix_required" },
    { round: 2, verdict: "fix_required" },
    { round: 3, verdict: "pass" },
  ]);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'system.alert'", workId).n, 0);
});

test("the Reviewer receives the Task without internal bookkeeping fields and the list of changed files", async (t) => {
  const reviewerRequests = [];
  const agentRunner = {
    runManagerPlan: async (request) => {
      if ((request.mode ?? request.context?.mode) === "plan") {
        return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask()] } };
      }
      return finalComplete(request);
    },
    runWorker: async (request) => ({ outcome: "success", report_valid: true, report: workerReport(request.invocation_id) }),
    runReviewer: async (request) => {
      reviewerRequests.push(request);
      return reviewResult("pass");
    },
    runAdvisor: async () => ({ reply: "" }),
  };
  const opened = await openCore(t, agentRunner, new FakeChangedPathsGit());
  const workId = await startWork(opened.core, "reviewer-context-shape");

  await waitFor(() => opened.db.get("SELECT state FROM works WHERE id = ? AND state = 'completed'", workId), 8_000);
  assert.equal(reviewerRequests.length, 1);
  const reviewedTask = reviewerRequests[0].context.task;
  assert.equal(Object.prototype.hasOwnProperty.call(reviewedTask, "state_version"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(reviewedTask, "updated_at"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(reviewedTask, "work_id"), false);
  assert.equal(reviewedTask.title, "A");
  assert.ok(Array.isArray(reviewerRequests[0].context.changed_files));
  assert.deepEqual(reviewerRequests[0].context.changed_files, ["src/index.ts", "out/a.txt"]);
});

function taskRow(overrides = {}) {
  const now = "2026-09-24T00:00:00.000Z";
  return {
    id: "task-1",
    work_id: "work-1",
    parent_task_id: null,
    title: "A",
    type: "code",
    status: "verifying",
    review_override: "true",
    priority: "normal",
    context: "",
    acceptance: "Done.",
    state_version: 3,
    failure_count: 0,
    same_error_count: 0,
    last_error_key: null,
    last_error_generation: null,
    review_round: 0,
    reviewer_failure_count: 0,
    worker_generation: 1,
    manager_task_id: "T1",
    retry_no: 0,
    next_attempt_at: null,
    worktree_path: null,
    worktree_state: null,
    last_failure_class: null,
    paused_from: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

const reviewerCrash = { event: "agent.crashed", payload: { role: "reviewer", report_present: false, error_key: "reviewer_failed:contract_invalid" } };
const workerStart = { event: "task.started", payload: { capacity_acquired: true, launch_lease_acquired: true } };
const workerSuccess = { event: "agent.exited", payload: { outcome: "success", report_valid: true } };

test("Worker success no longer erases Reviewer failures", () => {
  let row = taskRow();
  // Row 29, then rows 19/2 (task.started) and 4 (agent.exited success): twice.
  for (const expected of [1, 2]) {
    const crashed = reduceTask(row, reviewerCrash);
    assert.equal(crashed.next.status, "review_fix_waiting");
    assert.equal(crashed.next.reviewer_failure_count, expected);
    assert.equal(crashed.manager_trigger, false);
    const started = reduceTask(crashed.next, workerStart);
    assert.equal(started.next.status, "running");
    assert.equal(started.next.reviewer_failure_count, expected, "task.started keeps the Reviewer failures");
    const exited = reduceTask(started.next, workerSuccess);
    assert.equal(exited.next.status, "verifying");
    assert.equal(exited.next.reviewer_failure_count, expected, "a Worker success keeps the Reviewer failures");
    row = exited.next;
  }
  const third = reduceTask(row, reviewerCrash);
  assert.equal(third.next.status, "failed");
  assert.equal(third.next.reviewer_failure_count, 3);
  assert.equal(third.manager_trigger, true);
  assert.deepEqual(third.side_effects, ["manager_trigger_required"]);
  // The Worker counters stay untouched (they are CHECK-coupled to last_error_key).
  assert.equal(third.next.failure_count, 0);
  assert.equal(third.next.same_error_count, 0);
  assert.equal(third.next.last_error_key, null);
  assert.equal(third.next.last_error_generation, null);
});

test("task.replanned resets review_round and the Reviewer budget; Decision and completion reset the Reviewer budget", () => {
  const replanned = reduceTask(
    taskRow({ status: "failed", review_round: 2, reviewer_failure_count: 3, failure_count: 1, same_error_count: 1, last_error_key: "a".repeat(64), last_error_generation: 1 }),
    { event: "task.replanned", payload: { base_plan_version: 4, current_plan_version: 4, dependencies_completed: true } },
  );
  assert.equal(replanned.next.status, "ready");
  assert.equal(replanned.next.review_round, 0);
  assert.equal(replanned.next.reviewer_failure_count, 0);
  assert.equal(replanned.next.failure_count, 0);
  assert.equal(replanned.next.lead_designer_start_round, null);

  const resolved = reduceTask(
    taskRow({ status: "judgement_waiting", reviewer_failure_count: 2 }),
    { event: "decision.resolved", payload: { winner_commit: true, dependencies_completed: true } },
  );
  assert.equal(resolved.next.status, "ready");
  assert.equal(resolved.next.reviewer_failure_count, 0);

  const restored = reduceTask(
    taskRow({ status: "failed", reviewer_failure_count: 2 }),
    { event: "task.dependency_restored", payload: { restored_dependency_task_id: "task-0" } },
  );
  assert.equal(restored.next.status, "waiting");
  assert.equal(restored.next.reviewer_failure_count, 0);

  const merged = reduceTask(taskRow({ reviewer_failure_count: 2 }), { event: "review.passed", payload: { merge_exit_code: 0 } });
  assert.equal(merged.next.status, "completed");
  assert.equal(merged.next.reviewer_failure_count, 0);

  // A fix_required review and a verification failure leave it alone.
  const fix = reduceTask(taskRow({ reviewer_failure_count: 2 }), { event: "review.failed", payload: { verdict: "fix_required" } });
  assert.equal(fix.next.status, "review_fix_waiting");
  assert.equal(fix.next.reviewer_failure_count, 2);
});

test("design review escalates after two failures and gives Lead Designer two attempts", () => {
  const fail = (row) => reduceTask(row, { event: "review.failed", payload: { verdict: "fix_required" } });
  const first = fail(taskRow({ type: "design", review_round: 0, lead_designer_start_round: null }));
  assert.equal(first.next.status, "review_fix_waiting");
  assert.equal(first.next.lead_designer_start_round, null);
  const second = fail(taskRow({ type: "design", review_round: 1, lead_designer_start_round: null }));
  assert.equal(second.next.status, "review_fix_waiting");
  assert.equal(second.next.lead_designer_start_round, 2);
  const leadFirst = fail(taskRow({ type: "design", review_round: 2, lead_designer_start_round: 2 }));
  assert.equal(leadFirst.next.status, "review_fix_waiting");
  const leadSecond = fail(taskRow({ type: "design", review_round: 3, lead_designer_start_round: 2 }));
  assert.equal(leadSecond.next.status, "failed");
  assert.equal(leadSecond.manager_trigger, true);
  const explicitFirst = fail(taskRow({ type: "design", review_round: 0, lead_designer_start_round: 0 }));
  assert.equal(explicitFirst.next.status, "review_fix_waiting");
  const explicitSecond = fail(taskRow({ type: "design", review_round: 1, lead_designer_start_round: 0 }));
  assert.equal(explicitSecond.next.status, "failed");
  const retriedLead = reduceTask(
    taskRow({ type: "design", status: "failed", review_round: 4, lead_designer_start_round: 2 }),
    { event: "task.replanned", payload: { base_plan_version: 5, current_plan_version: 5, dependencies_completed: true } },
  );
  assert.equal(retriedLead.next.lead_designer_start_round, 0);
  assert.equal(retriedLead.next.review_round, 0);
});

test("migration 010 adds reviewer_failure_count = 0 to Tasks of a pre-010 database", async (t) => {
  const before = await mkdtemp(join(tmpdir(), "owl-migrations-pre010-"));
  for (const file of await readdir(migrations)) {
    if (file < "010") await copyFile(join(migrations, file), join(before, file));
  }
  const root = await mkdtemp(join(tmpdir(), "owl-pre010-db-"));
  const db = openDatabase(join(root, "owl.db"));
  t.after(() => db.close());
  db.migrate(before);
  assert.equal(db.all("PRAGMA table_info(tasks)").some((column) => column.name === "reviewer_failure_count"), false);
  const now = "2026-09-24T00:00:00.000Z";
  await db.createWriteLane().transact((transaction) => {
    transaction.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner', 'Owner', ?, ?)", now, now);
    transaction.run(
      `INSERT INTO works (id, owner_id, title, summary, size, state, state_version, plan_revision, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES ('W', 'owner', 'Legacy', 'Legacy Work.', 'normal', 'running', 1, 0, '{"schema_version":"1.0.0","rules":[]}', '[]', ?, ?)`,
      now, now,
    );
    transaction.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, review_round, created_at, updated_at)
       VALUES ('T', 'W', 'Legacy Task', 'code', 'review_fix_waiting', 'normal', '', 'Done.', 2, 1, ?, ?)`,
      now, now,
    );
  });

  const result = db.migrate(migrations);
  // Later migrations (011+) apply after it; this test pins only 010.
  assert.equal(result.applied[0], "010");
  assert.deepEqual(db.get("SELECT status, review_round, reviewer_failure_count FROM tasks WHERE id = 'T'"), {
    status: "review_fix_waiting",
    review_round: 1,
    reviewer_failure_count: 0,
  });
  const column = db.all("PRAGMA table_info(tasks)").find((entry) => entry.name === "reviewer_failure_count");
  assert.equal(column.notnull, 1);
  assert.equal(column.dflt_value, "0");
});
