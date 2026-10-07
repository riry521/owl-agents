import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateRemakeGate } from "../../packages/core/dist/remake-gate.js";
import { reduceTaskInTransaction } from "../../packages/core/dist/state-reducer.js";
import {
  assignReplacementLineageInTransaction,
  lineageChainIds,
  lineageGenerationCount,
  lineageReviewAttemptsExcluding,
  lineageUsage,
  parseLineageReset,
  restartLineageBudgetInTransaction,
} from "../../packages/core/dist/task-lineage.js";
import { DEFAULT_REMAKE_LIMIT_SETTINGS } from "../../packages/shared/dist/remake-limit-settings.js";
import { openTestDatabase } from "../helpers/db.mjs";

// The lineage a Task is counted against is the chain of Tasks it replaced,
// not every Task that shares a root; an Owner answer counts from 0 again.

const SETTINGS = { ...DEFAULT_REMAKE_LIMIT_SETTINGS, lineage_worker_runs: 3, lineage_review_attempts: 1000, non_functional_remakes: 1000 };
// Stamps start an hour ago so the real-time stamp of a reducer commit falls between "before" and "after" (see afterReal).
const base = Date.now() - 3600_000;
let clock = 0;
const stamp = () => new Date(base + 1000 * clock++).toISOString();

async function setup(t) {
  const { db } = await openTestDatabase(t, { prefix: "owl-lineage-chain-" });
  const lane = db.createWriteLane();
  const now = stamp();
  await lane.transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES ('W', 'owner:default', NULL, 'W', 'x', 'normal', 'running', '[]', '[]', ?, ?)`,
      now,
      now,
    );
  });
  let runs = 0;
  const api = {
    db,
    task: (id, { root: rootId = null, replaces = [], generation = 1, reviews = 0, baseSyncReviews = 0, type = "code", leadStart = null, leadRejections = 0, escalated = leadStart !== null } = {}) =>
      lane.transact((tx) =>
        tx.run(
          `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count,
             review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id, lineage_root_task_id, lineage_generation,
             replaces_task_ids_json, total_review_attempts, base_sync_review_attempts, lead_designer_start_round, lead_review_rejections, design_escalated)
           VALUES (?, 'W', ?, ?, 'failed', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, id, type, stamp(), stamp(), id, rootId, generation, JSON.stringify(replaces), reviews, baseSyncReviews, leadStart, leadRejections, escalated ? 1 : 0,
        ),
      ),
    run: (taskId, { baseSync = 0 } = {}) =>
      lane.transact((tx) => {
        const at = stamp();
        tx.run(
          `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, outcome, base_sync_only, created_at, updated_at)
           VALUES (?, 'W', ?, 'worker', 'p', 'm', 'completed', 'success', ?, ?, ?)`,
          `run-${runs++}`, taskId, baseSync, at, at,
        );
      }),
    measure: (taskId, generation, paths) =>
      lane.transact((tx) =>
        tx.run(
          `INSERT INTO task_change_measurements (id, work_id, task_id, lineage_generation, task_type, measured, files_json, created_at)
           VALUES (?, 'W', ?, ?, 'code', 1, ?, ?)`,
          `m-${runs++}`, taskId, generation, JSON.stringify(paths.map((path) => ({ path, hash: path }))), stamp(),
        ),
      ),
    setStatus: (taskId, status, reviews) =>
      lane.transact((tx) => tx.run("UPDATE tasks SET status = ?, total_review_attempts = ? WHERE id = ?", status, reviews, taskId)),
    setLimits: (limits) =>
      lane.transact((tx) =>
        tx.run(
          "INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('remake_limits', 'owner:default', '1.0.0', ?, ?)",
          JSON.stringify({ ...DEFAULT_REMAKE_LIMIT_SETTINGS, ...limits }), stamp(),
        ),
      ),
    afterReal: () => { clock += 7200; },
    reduce: (taskId, event, payload) => lane.transact((tx) => reduceTaskInTransaction(tx, taskId, { event, payload })),
    replace: (newTaskId, predecessors, restartLineage = false) => lane.transact((tx) => assignReplacementLineageInTransaction(tx, 'W', new Map([[newTaskId, predecessors]]), restartLineage)),
    restart: (taskId) => lane.transact((tx) => restartLineageBudgetInTransaction(tx, taskId, stamp())),
  };
  return api;
}

test("siblings made by splitting one Task do not count each other; ancestors do", async (t) => {
  const { db, task, run } = await setup(t);
  await task("T1");
  await task("R1", { root: "T1", replaces: ["T1"], generation: 2 });
  await task("R2", { root: "T1", replaces: ["T1"], generation: 2 });
  await task("M", { root: "T1", replaces: ["R1", "R2"], generation: 3 });
  await task("O"); // Owner replan: a lineage of its own
  assert.deepEqual(lineageChainIds(db, "R1"), ["T1", "R1"]);
  assert.deepEqual(lineageChainIds(db, "R2"), ["T1", "R2"]);
  assert.deepEqual(lineageChainIds(db, "M"), ["T1", "R1", "R2", "M"]);
  assert.deepEqual(lineageChainIds(db, "O"), ["O"]);
  await run("T1");
  await run("R1");
  await run("R1");
  await run("R2");
  assert.equal(lineageUsage(db, "R1", SETTINGS).worker_runs, 3);
  assert.equal(lineageUsage(db, "R2", SETTINGS).worker_runs, 2);
  assert.equal(lineageUsage(db, "M", SETTINGS).worker_runs, 4);
});

test("review verdicts of siblings are not counted either", async (t) => {
  const { db, task } = await setup(t);
  await task("T1", { reviews: 1 });
  await task("R1", { root: "T1", replaces: ["T1"], generation: 2, reviews: 2 });
  await task("R2", { root: "T1", replaces: ["T1"], generation: 2, reviews: 5 });
  assert.deepEqual(lineageReviewAttemptsExcluding(db, "R1"), { main: 1, base_sync: 0, lead: 0 });
  assert.equal(lineageUsage(db, "R2", SETTINGS).review_attempts, 6);
});

test("a one-for-one replacement chain is still totalled, including a cancelled ancestor", async (t) => {
  const { db, task, run } = await setup(t);
  await task("T1");
  await task("T2", { root: "T1", replaces: ["T1"], generation: 2 });
  await task("T3", { root: "T1", replaces: ["T2"], generation: 3 });
  await run("T1");
  await run("T2");
  await run("T3");
  assert.deepEqual(lineageChainIds(db, "T3"), ["T1", "T2", "T3"]);
  const usage = lineageUsage(db, "T3", SETTINGS);
  assert.equal(usage.worker_runs, 3);
  assert.equal(usage.generations, 3);
  assert.equal(evaluateRemakeGate(usage, SETTINGS).blocked, true);
});

test("a cancelled ancestor is totalled; a cancelled Task of the same root that is not an ancestor is not", async (t) => {
  const { db, task, run, setStatus } = await setup(t);
  await task("T1");
  await task("X", { root: "T1", replaces: ["T1"], generation: 2 });
  await task("T2", { root: "T1", replaces: ["T1"], generation: 2 });
  await task("T3", { root: "T1", replaces: ["T2"], generation: 3 });
  await setStatus("T2", "cancelled", 0);
  await setStatus("X", "cancelled", 0);
  await run("T1");
  await run("T2");
  await run("X");
  await run("X");
  await run("T3");
  assert.deepEqual(lineageChainIds(db, "T3"), ["T1", "T2", "T3"]);
  assert.equal(lineageUsage(db, "T3", SETTINGS).worker_runs, 3);
});

test("base_sync_only runs stay out of the main count", async (t) => {
  const { db, task, run } = await setup(t);
  await task("T1");
  await run("T1", { baseSync: 1 });
  await run("T1", { baseSync: 1 });
  await run("T1");
  const usage = lineageUsage(db, "T1", SETTINGS);
  assert.equal(usage.worker_runs, 1);
  assert.equal(usage.base_sync_worker_runs, 2);
});

test("an Owner answer counts the Task's lineage from 0 again; going over the limit again stops it", async (t) => {
  const { db, task, run, restart } = await setup(t);
  await task("T1", { reviews: 2 });
  await task("T2", { root: "T1", replaces: ["T1"], generation: 2, reviews: 2 });
  await run("T1");
  await run("T2");
  await run("T2");
  assert.equal(evaluateRemakeGate(lineageUsage(db, "T2", SETTINGS), SETTINGS).blocked, true);
  await restart("T2");
  assert.ok(parseLineageReset(db.get("SELECT lineage_reset_json AS j FROM tasks WHERE id = 'T2'").j));
  let usage = lineageUsage(db, "T2", SETTINGS);
  assert.equal(usage.worker_runs, 0);
  assert.equal(usage.review_attempts, 0);
  assert.equal(usage.generations, 1);
  assert.equal(lineageGenerationCount(db, "T2"), 1);
  assert.deepEqual(lineageChainIds(db, "T2"), ["T2"]);
  assert.deepEqual(lineageReviewAttemptsExcluding(db, "T2"), { main: -2, base_sync: 0, lead: 0 });
  assert.equal(evaluateRemakeGate(usage, SETTINGS).blocked, false, "a replan right after the answer is not stopped");
  await run("T2");
  await run("T2");
  assert.equal(evaluateRemakeGate(lineageUsage(db, "T2", SETTINGS), SETTINGS).blocked, false);
  await run("T2");
  usage = lineageUsage(db, "T2", SETTINGS);
  assert.equal(usage.worker_runs, 3);
  assert.equal(evaluateRemakeGate(usage, SETTINGS).blocked, true, "using the limit again stops it again");
});

test("a Task that replaces a restarted Task inherits only what came after the restart", async (t) => {
  const { db, task, run, restart } = await setup(t);
  await task("T1");
  await task("T2", { root: "T1", replaces: ["T1"], generation: 2 });
  await run("T1");
  await run("T2");
  await restart("T2");
  await run("T2");
  await task("T3", { root: "T1", replaces: ["T2"], generation: 3 });
  assert.deepEqual(lineageChainIds(db, "T3"), ["T2", "T3"]);
  assert.equal(lineageUsage(db, "T3", SETTINGS).worker_runs, 1);
  assert.equal(lineageUsage(db, "T3", SETTINGS).generations, 2);
});

const ANSWER = { winner_commit: true, dependencies_completed: true };
const stateOf = (db, id) => db.get("SELECT status, lineage_reset_json AS reset FROM tasks WHERE id = ?", id);
const blocked = (db, id, settings = SETTINGS) => evaluateRemakeGate(lineageUsage(db, id, settings), settings).blocked;

test("the Decision answer (decision.resolved) restarts the lineage count; using the limit again stops it", async (t) => {
  const { db, task, run, setStatus, reduce, afterReal } = await setup(t);
  await task("T1");
  await task("T2", { root: "T1", replaces: ["T1"], generation: 2 });
  await run("T1");
  await run("T2");
  await run("T2");
  await setStatus("T2", "judgement_waiting", 0);
  assert.equal(blocked(db, "T2"), true);
  await reduce("T2", "decision.resolved", ANSWER);
  afterReal();
  assert.ok(parseLineageReset(stateOf(db, "T2").reset), "the answer stored the reset");
  assert.equal(blocked(db, "T2"), false, "a replan right after the answer is not stopped");
  await run("T2");
  await run("T2");
  assert.equal(blocked(db, "T2"), false);
  await run("T2");
  assert.equal(blocked(db, "T2"), true);
});

test("non-functional remakes: siblings and units from before the answer are not in the streak", async (t) => {
  const { db, task, measure, restart } = await setup(t);
  const settings = { ...DEFAULT_REMAKE_LIMIT_SETTINGS, lineage_worker_runs: 1000, lineage_review_attempts: 1000, non_functional_remakes: 2 };
  await task("T1");
  await task("R1", { root: "T1", replaces: ["T1"], generation: 2 });
  await task("R2", { root: "T1", replaces: ["T1"], generation: 2 });
  await measure("T1", 1, ["src/a.ts"]);
  await measure("R1", 2, ["src/a.ts", "tests/a.test.mjs"]);
  await measure("R2", 2, ["src/a.ts", "tests/b.test.mjs"]);
  assert.equal(lineageUsage(db, "R2", settings).non_functional_streak, 1, "R1 is a sibling and does not extend R2's streak");
  assert.equal(blocked(db, "R2", settings), false);
  await task("R3", { root: "T1", replaces: ["R2"], generation: 3 });
  await measure("R3", 3, ["src/a.ts", "tests/b.test.mjs", "tests/c.test.mjs"]);
  assert.equal(lineageUsage(db, "R3", settings).non_functional_streak, 2);
  assert.equal(blocked(db, "R3", settings), true);
  await restart("R3");
  assert.equal(lineageUsage(db, "R3", settings).non_functional_streak, 0, "units from before the answer no longer count");
  assert.equal(blocked(db, "R3", settings), false);
});

test("review.failed after the answer counts from 0: continues below the limit, stops at it", async (t) => {
  const { db, task, setStatus, setLimits, reduce } = await setup(t);
  await setLimits({ lineage_review_attempts: 3 });
  await task("T1", { reviews: 1 });
  await task("T2", { root: "T1", replaces: ["T1"], generation: 2, reviews: 2 });
  await setStatus("T2", "verifying", 2);
  assert.equal((await reduce("T2", "review.failed", { verdict: "fix_required" })).next.status, "judgement_waiting", "before the answer the lineage is over the limit");
  await setStatus("T2", "judgement_waiting", 2);
  await reduce("T2", "decision.resolved", ANSWER);
  assert.ok(lineageReviewAttemptsExcluding(db, "T2").main < 0);
  await setStatus("T2", "verifying", 3);
  assert.notEqual((await reduce("T2", "review.failed", { verdict: "fix_required" })).next.status, "judgement_waiting", "one verdict after the answer is under the limit");
  await setStatus("T2", "verifying", 4);
  assert.equal((await reduce("T2", "review.failed", { verdict: "fix_required" })).next.status, "judgement_waiting", "three verdicts after the answer reach the limit again");
});

test("review.failed after the answer counts the Task's own review limit from 0 too", async (t) => {
  const { task, setStatus, setLimits, reduce } = await setup(t);
  const failed = { verdict: "fix_required" };
  await setLimits({ lineage_review_attempts: 1000 });
  await task("T1", { reviews: 7 });
  await setStatus("T1", "judgement_waiting", 7);
  await reduce("T1", "decision.resolved", ANSWER);
  await setStatus("T1", "verifying", 7);
  assert.notEqual((await reduce("T1", "review.failed", failed)).next.status, "judgement_waiting", "one verdict after the answer is not 8/6");
  await setStatus("T1", "verifying", 12);
  assert.equal((await reduce("T1", "review.failed", failed)).next.status, "failed", "the limit is reached from the answer, not exceeded");
  await setStatus("T1", "verifying", 13);
  assert.equal((await reduce("T1", "review.failed", failed)).next.status, "judgement_waiting", "going past the limit from the answer stops it again");
});

const FAILED = { verdict: "fix_required" };
const REPLAN = { base_plan_version: 1, current_plan_version: 1, dependencies_completed: true };

test("Lead rejections are not reset by a Manager re-run or replacement; only the Decision answer restarts them", async (t) => {
  const { db, task, setStatus, setLimits, reduce, afterReal } = await setup(t);
  await setLimits({ lead_review_rejections: 2 });
  // Re-run: the same Task is replanned and rejected again.
  await task("T1", { type: "design", leadStart: 1 });
  await setStatus("T1", "verifying", 0);
  const first = await reduce("T1", "review.failed", FAILED);
  assert.equal(first.next.design_stop_json ?? null, null, "1 of 2: the design is remade");
  await setStatus("T1", "failed", 1);
  await reduce("T1", "task.replanned", REPLAN);
  assert.equal(db.get("SELECT lead_review_rejections AS n FROM tasks WHERE id = 'T1'").n, 1, "a re-run keeps the count");
  await setStatus("T1", "verifying", 1);
  const second = await reduce("T1", "review.failed", FAILED);
  assert.equal(second.next.status, "review_fix_waiting");
  assert.equal(JSON.parse(second.next.design_stop_json).rejections, 2, "2 of 2 after the re-run: stopped");
  // Replacement: the new Task starts at 0 itself but its chain carries the count.
  await task("T2", { type: "design", leadStart: 1, root: "T1", replaces: ["T1"], generation: 2 });
  assert.equal(lineageReviewAttemptsExcluding(db, "T2").lead, 2);
  await setStatus("T2", "verifying", 0);
  assert.equal(JSON.parse((await reduce("T2", "review.failed", FAILED)).next.design_stop_json).rejections, 3, "the replacement is stopped at its first rejection");
  // The Owner's answer restarts the count for the Task that was stopped.
  await setStatus("T2", "judgement_waiting", 1);
  await reduce("T2", "decision.resolved", { winner_commit: true, dependencies_completed: true, to_manager: true });
  afterReal();
  assert.equal(lineageReviewAttemptsExcluding(db, "T2").lead, -1, "T2's own rejection is settled and T1 is no longer in its chain");
  await task("T3", { type: "design", leadStart: 1, root: "T1", replaces: ["T2"], generation: 3 });
  assert.equal(lineageReviewAttemptsExcluding(db, "T3").lead, 0, "the answered rejections do not reach T3");
  await setStatus("T3", "verifying", 0);
  assert.equal((await reduce("T3", "review.failed", FAILED)).next.design_stop_json ?? null, null, "after the answer one rejection is under the limit of 2");
});

test("A replacement made by the Manager's replan keeps the Lead tier, so the stop still applies to it", async (t) => {
  const { db, task, setStatus, setLimits, reduce, replace } = await setup(t);
  await setLimits({ lead_review_rejections: 2 });
  await task("T1", { type: "design", leadStart: 1, leadRejections: 1 });
  await task("T2", { type: "design" }); // created by the replan with no tier of its own
  await replace("T2", ["T1"]);
  assert.equal(db.get("SELECT lead_designer_start_round AS n FROM tasks WHERE id = 'T2'").n, 0, "the replacement starts at the Lead tier");
  await setStatus("T2", "verifying", 0);
  assert.equal(JSON.parse((await reduce("T2", "review.failed", FAILED)).next.design_stop_json).rejections, 2, "the carried rejection plus its own reach the limit");
  await task("C1", { type: "code" });
  await task("C2", { type: "code" });
  await replace("C2", ["C1"]);
  assert.equal(db.get("SELECT lead_designer_start_round AS n FROM tasks WHERE id = 'C2'").n, null, "a code Task is not promoted");
});
