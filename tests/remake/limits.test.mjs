import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { reduceTask } from "../../packages/core/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import {
  DEFAULT_REMAKE_LIMIT_SETTINGS,
  readRemakeLimitSettings,
  validateRemakeLimitSettings,
} from "../../packages/shared/dist/remake-limit-settings.js";
import { createTestCore } from "../helpers/core.mjs";
import { withNecessity } from "../helpers/necessity.mjs";
import { waitFor } from "../helpers/wait.mjs";

// A replan that replaces a failed Task records a lineage; Reviewer verdicts
// and Worker launches are totalled across it, and a lineage that used up a
// limit (or kept remaking without touching functional code) stops with the
// Work waiting for the Owner instead of creating another Task.

const envelope = (payload, suffix, expectedVersion = 0) => ({
  request_id: createUlid(),
  idempotency_key: `test:${suffix}:${createUlid()}`,
  expected_version: expectedVersion,
  payload,
});

const settingsWith = (overrides) => ({ ...DEFAULT_REMAKE_LIMIT_SETTINGS, ...overrides });

async function openCore(t, agentRunner, { settings } = {}) {
  const { root, db, core } = await createTestCore(t, { agentRunner: withNecessity(agentRunner), dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-remake-limits-", start: true });
  if (settings) await core.setRemakeLimitSettings(settings);
  return { db, core, root };
}

async function startWork(core, suffix) {
  const created = await core.createWork(envelope({ title: suffix, summary: "Exercise the remake limits.", size: "normal", project_id: null }, `${suffix}-create`));
  await core.startWork(created.data.work_id, envelope({ mode: "normal" }, `${suffix}-start`, created.version));
  return created.data.work_id;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const workerReport = (invocationId) => ({
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
});

const planTask = (overrides = {}) => ({ id: "T1", title: "A", type: "code", acceptance: "Done; verified by the test.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: true, ...overrides });

const reviewFailed = () => ({
  outcome: "failed",
  report_valid: true,
  report: { verdict: "fix_required", summary: "One correction remains.", findings: [{ severity: "major", subject: "other", file: "a.txt", problem: "Wrong value.", fix: "Use the right value." }], tests: { ran: false, command: "none", passed: 0, failed: 0 } },
  review: { verdict: "fix_required", summary: "One correction remains.", findings: [{ severity: "major", subject: "other", file: "a.txt", problem: "Wrong value.", fix: "Use the right value." }], tests: { ran: false, command: "none", passed: 0, failed: 0 } },
});

/**
 * A Manager that plans T1 and answers every replan with one new Task that
 * replaces the Task that just failed (T1, then R1, R2, ...).
 */
function lineageRunner({ workerWrites, onReplan }) {
  const state = { replans: 0, workerCalls: 0, reviewerCalls: 0 };
  return {
    state,
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask()] } };
      if (mode === "replan") {
        const failedId = state.replans === 0 ? "T1" : `R${state.replans}`;
        state.replans += 1;
        onReplan?.(state.replans);
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [planTask({ id: `R${state.replans}`, title: `A remake ${state.replans}`, replaces: [failedId] })] } };
      }
      return { outcome: "failed", message: `unexpected manager ${mode}` };
    },
    runWorker: async (request) => {
      state.workerCalls += 1;
      await workerWrites(request.context.worktree, state.workerCalls, request);
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => {
      state.reviewerCalls += 1;
      return reviewFailed();
    },
    runAdvisor: async () => ({ reply: "" }),
  };
}

const writeFileIn = async (root, path, body) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), body);
};

const workState = (db, workId) => db.get("SELECT state FROM works WHERE id = ?", workId)?.state;
const lineageTasks = (db, workId) => db.all("SELECT id, manager_task_id, status, lineage_root_task_id, lineage_generation, replaces_task_ids_json FROM tasks WHERE work_id = ? ORDER BY created_at, id", workId);

test("the lineage relation of replaced Tasks is recorded across generations", async (t) => {
  // Limits are large, so the chain T1 -> R1 -> R2 -> R3 is never stopped.
  const runner = lineageRunner({
    workerWrites: (root, n) => writeFileIn(root, "src/feature.mjs", `export const n = ${n};\n`),
  });
  const { db, core } = await openCore(t, runner, {
    settings: settingsWith({ lineage_review_attempts: 1000, lineage_worker_runs: 1000, non_functional_remakes: 100 }),
  });
  const workId = await startWork(core, "lineage-relation");

  assert.ok(await waitFor(() => lineageTasks(db, workId).length >= 4), "T1 was replaced three times");
  const [t1, r1, r2, r3] = lineageTasks(db, workId);
  assert.deepEqual([t1.manager_task_id, r1.manager_task_id, r2.manager_task_id, r3.manager_task_id], ["T1", "R1", "R2", "R3"]);
  assert.equal(t1.lineage_root_task_id, null, "the first Task is its own root");
  assert.equal(t1.lineage_generation, 1);
  for (const [index, row] of [r1, r2, r3].entries()) {
    assert.equal(row.lineage_root_task_id, t1.id, `${row.manager_task_id} belongs to the lineage of T1`);
    assert.equal(row.lineage_generation, index + 2);
  }
  assert.deepEqual(JSON.parse(r1.replaces_task_ids_json), [t1.id]);
  assert.deepEqual(JSON.parse(r2.replaces_task_ids_json), [r1.id]);
  assert.deepEqual(JSON.parse(r3.replaces_task_ids_json), [r2.id]);
  assert.equal(t1.status, "cancelled", "a replaced Task is superseded");
});

test("a lineage that used up its review attempts creates no new Task and the Work waits for the Owner", async (t) => {
  // Every review fails: T1 fails after 3 verdicts; R1's first verdict makes
  // the lineage total 4 >= 4, so R1 stops without another replan.
  const runner = lineageRunner({
    workerWrites: (root, n) => writeFileIn(root, "src/feature.mjs", `export const n = ${n};\n`),
  });
  const { db, core } = await openCore(t, runner, {
    settings: settingsWith({ lineage_review_attempts: 4, lineage_worker_runs: 1000, non_functional_remakes: 100 }),
  });
  const workId = await startWork(core, "lineage-review-limit");

  assert.ok(await waitFor(() => workState(db, workId) === "judgement_waiting"), `the Work waits (state=${workState(db, workId)})`);
  await sleep(300); // a regression would keep replanning
  const tasks = lineageTasks(db, workId);
  assert.equal(runner.state.replans, 1, "the Manager replanned once, not twice");
  assert.equal(tasks.length, 2, "no third Task was created");
  assert.equal(tasks[1].status, "judgement_waiting");
  assert.equal(tasks.reduce((sum, row) => sum + db.get("SELECT total_review_attempts AS n FROM tasks WHERE id = ?", row.id).n, 0), 4, "verdicts are totalled across the lineage");

  const decision = db.get("SELECT * FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.ok(decision, "the reason is recorded as an open Decision for the Owner");
  assert.match(JSON.stringify(decision), /4/, "the Decision states the numbers");
});

test("a lineage that used up its Worker launches is stopped at replan time", async (t) => {
  // Per Task, three failed reviews end it; with a limit of 4 Worker runs the
  // second generation is not created after T1's 4 runs (3 reviews + Worker
  // fix rounds), or the gate stops it after the first remake.
  const runner = lineageRunner({
    workerWrites: (root, n) => writeFileIn(root, "src/feature.mjs", `export const n = ${n};\n`),
  });
  const { db, core } = await openCore(t, runner, {
    settings: settingsWith({ lineage_review_attempts: 1000, lineage_worker_runs: 3, non_functional_remakes: 100 }),
  });
  const workId = await startWork(core, "lineage-worker-limit");

  assert.ok(await waitFor(() => workState(db, workId) === "judgement_waiting"), `the Work waits (state=${workState(db, workId)})`);
  await sleep(300);
  assert.equal(runner.state.replans, 0, "the Manager was never asked to replan");
  assert.equal(lineageTasks(db, workId).length, 1, "no new Task was created");
  const decision = db.get("SELECT * FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.ok(decision, "the reason is recorded for the Owner");
});

test("remaking N times without touching functional code stops the Work", async (t) => {
  // Generation 1 writes src/feature.mjs; every remake only writes a test.
  const runner = lineageRunner({
    workerWrites: async (root, n, request) => {
      const generation = db_generation(request);
      // A remake carries the same source forward and only changes its tests.
      await writeFileIn(root, "src/feature.mjs", "export const f = 1;\n");
      if (generation > 1) await writeFileIn(root, "tests/feature.test.mjs", `// attempt ${n}\n`);
    },
  });
  let db;
  const opened = await openCore(t, runner, {
    settings: settingsWith({ lineage_review_attempts: 1000, lineage_worker_runs: 1000, non_functional_remakes: 2 }),
  });
  db = opened.db;
  function db_generation(request) {
    return db.get("SELECT lineage_generation AS g FROM tasks WHERE id = ?", request.task_id).g;
  }
  const workId = await startWork(opened.core, "non-functional");

  assert.ok(await waitFor(() => workState(db, workId) === "judgement_waiting"), `the Work waits (state=${workState(db, workId)}) ${JSON.stringify(db.all("SELECT task_id, lineage_generation, task_type, measured, files_json FROM task_change_measurements WHERE work_id = ?", workId))} ${JSON.stringify(lineageTasks(db, workId))}`);
  await sleep(300);
  assert.equal(runner.state.replans, 2, "two remakes were made, the third replan was refused");
  assert.equal(lineageTasks(db, workId).length, 3);
  const decision = db.get("SELECT * FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.ok(decision);
  assert.match(JSON.stringify(decision), /feature\.test\.mjs/, "the Decision names the test files that were the only change");
});

test("a remake that changes functional code resets the non-functional streak", async (t) => {
  let db;
  const runner = lineageRunner({
    workerWrites: async (root, n, request) => {
      const generation = db.get("SELECT lineage_generation AS g FROM tasks WHERE id = ?", request.task_id).g;
      // Generation 2 changes the source; generations 3 and 4 only change tests.
      await writeFileIn(root, "src/feature.mjs", `export const f = ${Math.min(generation, 2)};\n`);
      if (generation > 2) await writeFileIn(root, "tests/feature.test.mjs", `// attempt ${n}\n`);
    },
  });
  const opened = await openCore(t, runner, {
    settings: settingsWith({ lineage_review_attempts: 1000, lineage_worker_runs: 1000, non_functional_remakes: 2 }),
  });
  db = opened.db;
  const workId = await startWork(opened.core, "functional-reset");

  assert.ok(await waitFor(() => workState(db, workId) === "judgement_waiting"), "the Work eventually waits");
  await sleep(300);
  // The functional remake (generation 2) did not count: three replans, not two.
  assert.equal(runner.state.replans, 3);
});

test("changing the settings changes the limits, and they persist across a Core restart", async (t) => {
  const runner = lineageRunner({ workerWrites: (root, n) => writeFileIn(root, "src/feature.mjs", `export const n = ${n};\n`) });
  const { db, core, root } = await openCore(t, runner);
  assert.deepEqual(await core.getRemakeLimitSettings(), DEFAULT_REMAKE_LIMIT_SETTINGS, "no stored row means the design defaults");

  const changed = settingsWith({ lineage_review_attempts: 5, lineage_worker_runs: 6, non_functional_remakes: 3, checked_task_types: ["code"], verification_paths: ["**/spec/**"] });
  assert.deepEqual(await core.setRemakeLimitSettings(changed), changed);
  assert.deepEqual(await core.getRemakeLimitSettings(), changed);

  await core.stop({ force: true });
  const { core: reopened } = await createTestCore(t, { db, owlRoot: root, agentRunner: withNecessity(runner), dispatcher: { tick_interval_ms: 25 } }, { start: true });
  assert.deepEqual(await reopened.getRemakeLimitSettings(), changed, "the saved limits survive a restart");

  await assert.rejects(() => reopened.setRemakeLimitSettings({ ...changed, lineage_review_attempts: 0 }), /lineage_review_attempts/);
  assert.deepEqual(await reopened.getRemakeLimitSettings(), changed, "a rejected save changes nothing");
  await reopened.stop({ force: true });
});

test("missing or invalid stored settings fall back to the design defaults per key", async (t) => {
  const { db, core } = await openCore(t, lineageRunner({ workerWrites: async () => {} }));
  const store = (value) => db.get(
    `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('remake_limits', (SELECT id FROM owners LIMIT 1), '1.0.0', ?, '2026-10-04T00:00:00.000Z')
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json RETURNING key`,
    value,
  );
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });

  await core.setRemakeLimitSettings(settingsWith({ lineage_worker_runs: 7 }));
  store(JSON.stringify({ lineage_review_attempts: "many", lineage_worker_runs: 7, non_functional_remakes: -1 }));
  assert.deepEqual(await core.getRemakeLimitSettings(), settingsWith({ lineage_worker_runs: 7 }), "invalid and missing keys use defaults, valid ones are kept");
  store(JSON.stringify([1, 2]));
  assert.deepEqual(await core.getRemakeLimitSettings(), DEFAULT_REMAKE_LIMIT_SETTINGS);

  assert.deepEqual(readRemakeLimitSettings(null), DEFAULT_REMAKE_LIMIT_SETTINGS);
  assert.deepEqual(readRemakeLimitSettings({ checked_task_types: ["bogus"] }), DEFAULT_REMAKE_LIMIT_SETTINGS);
  assert.throws(() => validateRemakeLimitSettings({ lineage_review_attempts: 3 }), /exactly/);
});

test("review_limits stored without the new keys keeps working and is not disturbed by remake_limits", async (t) => {
  const { core } = await openCore(t, lineageRunner({ workerWrites: async () => {} }));
  const before = await core.getReviewLimitSettings();
  assert.deepEqual(Object.keys(before).sort(), ["plan_review_rounds", "total_review_attempts"]);
  await core.setRemakeLimitSettings(settingsWith({ lineage_review_attempts: 12 }));
  assert.deepEqual(await core.getReviewLimitSettings(), before);
  const saved = await core.setReviewLimitSettings({ ...before, total_review_attempts: before.total_review_attempts + 1 });
  assert.equal(saved.total_review_attempts, before.total_review_attempts + 1);
  assert.equal((await core.getRemakeLimitSettings()).lineage_review_attempts, 12);
});

test("reducer: a review.failed past the lineage budget waits for judgement", () => {
  const now = "2026-10-04T00:00:00.000Z";
  const row = {
    id: "task-1", work_id: "work-1", parent_task_id: null, title: "A", type: "code", status: "verifying", review_override: "true",
    priority: "normal", context: "", acceptance: "Done.", state_version: 3, failure_count: 0, same_error_count: 0, last_error_key: null,
    last_error_generation: null, review_round: 0, reviewer_failure_count: 0, total_review_attempts: 1, worker_generation: 1,
    manager_task_id: "T1", retry_no: 0, next_attempt_at: null, worktree_path: null, worktree_state: null, last_failure_class: null,
    paused_from: null, lineage_root_task_id: null, lineage_generation: 1, replaces_task_ids_json: "[]", created_at: now, updated_at: now,
  };
  const command = { event: "review.failed", payload: { verdict: "fix_required" } };
  const over = reduceTask(row, command, { lineage: { otherReviewAttempts: 3, limit: 5, generations: 2 } });
  assert.equal(over.next.status, "judgement_waiting");
  assert.ok(over.lineage_budget, "the budget that was hit is reported");
  const under = reduceTask(row, command, { lineage: { otherReviewAttempts: 1, limit: 5, generations: 2 } });
  assert.notEqual(under.next.status, "judgement_waiting");
  assert.equal(under.lineage_budget, undefined);
});


test("lineage usage: a unit whose latest verification could not be measured is neutral, not its earlier measurement", async () => {
  const { lineageUsage } = await import("../../packages/core/dist/task-lineage.js");
  const measurements = [
    { id: "m1", task_id: "X", lineage_generation: 1, task_type: "code", measured: 1, files_json: JSON.stringify([{ path: "tests/a.test.mjs", hash: "h" }]), created_at: "2026-01-01T00:00:01Z" },
    { id: "m2", task_id: "X", lineage_generation: 1, task_type: "code", measured: 0, files_json: "[]", created_at: "2026-01-01T00:00:02Z" },
  ];
  const reader = {
    get: (sql) => {
      if (sql.includes("replaces_task_ids_json")) return { replaces_task_ids_json: "[]" };
      if (sql.includes("lineage_root_task_id")) return { lineage_root_task_id: null };
      return { work_id: "W" };
    },
    all: (sql) => {
      if (sql.includes("task_change_measurements")) return measurements;
      if (sql.includes("agent_runs")) return [];
      if (sql.includes("total_review_attempts")) return [{ id: "X", title: "X", lineage_generation: 1, total_review_attempts: 0 }];
      return [{ id: "X" }];
    },
  };
  const usage = lineageUsage(reader, "X", DEFAULT_REMAKE_LIMIT_SETTINGS);
  assert.equal(usage.non_functional_streak, 0);
  assert.equal(usage.history[0].kind, "unmeasured");
});

test("replanning under the same Task id: remakes that only add tests stop the Work, src carried over is not counted as deleted", async (t) => {
  const base = lineageRunner({
    workerWrites: async (root, n) => {
      if (n === 1) await writeFileIn(root, "src/feature.mjs", "export const f = 1;\n");
      else await writeFileIn(root, "tests/feature.test.mjs", `// attempt ${n}\n`);
    },
  });
  const runner = {
    ...base,
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "replan") base.state.replans += 1;
      return mode === "plan" || mode === "replan"
        ? { outcome: "success", report_valid: true, report: { event: mode === "plan" ? "work.planned" : "task.replanned", tasks: [planTask()] } }
        : { outcome: "failed", message: `unexpected manager ${mode}` };
    },
  };
  const { db, core } = await openCore(t, runner, {
    settings: settingsWith({ lineage_review_attempts: 1000, lineage_worker_runs: 1000, non_functional_remakes: 2 }),
  });
  // The per-Task review limit would stop the retried Task first; raise it.
  const reviewLimits = await core.getReviewLimitSettings();
  await core.setReviewLimitSettings({ ...reviewLimits, total_review_attempts: 100 });
  const workId = await startWork(core, "same-id");
  assert.ok(await waitFor(() => workState(db, workId) === "judgement_waiting"), `the Work waits (state=${workState(db, workId)}) replans=${base.state.replans} ${JSON.stringify(lineageTasks(db, workId))}`);
  assert.equal(base.state.replans, 2);
});

test("lead_review_rejections: default 1, 0 and 101 are rejected, missing key reads the default", () => {
  assert.equal(readRemakeLimitSettings({}).lead_review_rejections, 1);
  assert.equal(DEFAULT_REMAKE_LIMIT_SETTINGS.lead_review_rejections, 1);
  for (const bad of [0, 101]) {
    assert.throws(() => validateRemakeLimitSettings({ ...DEFAULT_REMAKE_LIMIT_SETTINGS, lead_review_rejections: bad }), /lead_review_rejections/);
  }
  assert.equal(validateRemakeLimitSettings({ ...DEFAULT_REMAKE_LIMIT_SETTINGS, lead_review_rejections: 100 }).lead_review_rejections, 100);
});

// ---- base-sync-only generations: counted apart from the main-work totals ----

const BASE_SYNC_KEYS = ["base_sync_lineage_review_attempts", "base_sync_lineage_worker_runs"];

test("base-sync limits: defaults exist, out-of-range values are rejected, a stored row without them reads the defaults silently", async (t) => {
  for (const key of BASE_SYNC_KEYS) {
    assert.ok(Number.isInteger(DEFAULT_REMAKE_LIMIT_SETTINGS[key]) && DEFAULT_REMAKE_LIMIT_SETTINGS[key] >= 1, `${key} has a default`);
    for (const bad of [0, 1001, 1.5, "3", null]) {
      assert.throws(() => validateRemakeLimitSettings({ ...DEFAULT_REMAKE_LIMIT_SETTINGS, [key]: bad }), new RegExp(key), `${key}=${JSON.stringify(bad)} is rejected`);
    }
    assert.equal(validateRemakeLimitSettings({ ...DEFAULT_REMAKE_LIMIT_SETTINGS, [key]: 1000 })[key], 1000);
  }
  assert.throws(() => validateRemakeLimitSettings({ lineage_review_attempts: 3, lineage_worker_runs: 3, non_functional_remakes: 3, checked_task_types: ["code"], verification_paths: [] }), /exactly/, "the new keys are part of the exact key set");

  const warnings = [];
  const warn = (message) => warnings.push(message);
  const legacy = { lineage_review_attempts: 4, lineage_worker_runs: 5, non_functional_remakes: 2, checked_task_types: ["code"], verification_paths: ["**/tests/**"] };
  assert.deepEqual(readRemakeLimitSettings(legacy, warn), { ...DEFAULT_REMAKE_LIMIT_SETTINGS, ...legacy });
  assert.equal(warnings.length, 0, "a row saved before the new keys existed is not a warning");
  const fallen = readRemakeLimitSettings({ ...legacy, base_sync_lineage_worker_runs: -3 }, warn);
  assert.equal(fallen.base_sync_lineage_worker_runs, DEFAULT_REMAKE_LIMIT_SETTINGS.base_sync_lineage_worker_runs, "an invalid new value falls back to its default");
  assert.equal(warnings.length, 1, "an invalid value still warns");
});

test("remake gate: main limits are checked first, the base-sync limits last, and a base-sync unit is neutral", async () => {
  const { evaluateRemakeGate, classifyRemakeUnit } = await import("../../packages/core/dist/remake-gate.js");
  const settings = settingsWith({ lineage_review_attempts: 5, lineage_worker_runs: 6, non_functional_remakes: 2, base_sync_lineage_review_attempts: 3, base_sync_lineage_worker_runs: 4 });
  const usage = (o) => ({ review_attempts: 0, worker_runs: 0, non_functional_streak: 0, base_sync_review_attempts: 0, base_sync_worker_runs: 0, ...o });
  assert.deepEqual(evaluateRemakeGate(usage({ review_attempts: 5, base_sync_review_attempts: 3 }), settings), { blocked: true, reason: "lineage_review_attempts" });
  assert.deepEqual(evaluateRemakeGate(usage({ base_sync_review_attempts: 3 }), settings), { blocked: true, reason: "base_sync_lineage_review_attempts" });
  assert.deepEqual(evaluateRemakeGate(usage({ base_sync_worker_runs: 4 }), settings), { blocked: true, reason: "base_sync_lineage_worker_runs" });
  assert.deepEqual(evaluateRemakeGate(usage({ review_attempts: 4, worker_runs: 5, base_sync_review_attempts: 2, base_sync_worker_runs: 3 }), settings), { blocked: false });

  const unit = { task_id: "X", generation: 2, task_type: "code", measured: true, files: [{ path: "tests/a.test.mjs", hash: "h" }], baseline: [], base_sync_only: false };
  assert.equal(classifyRemakeUnit(unit, settings).kind, "non_functional");
  assert.equal(classifyRemakeUnit({ ...unit, base_sync_only: true }, settings).kind, "neutral");
});

test("lineage usage: marked runs and verdicts leave the main totals; unmarked and legacy rows count as main work", async () => {
  const { lineageUsage } = await import("../../packages/core/dist/task-lineage.js");
  const readerFor = ({ tasks, runs }) => ({
    get: (sql) => {
      if (sql.includes("replaces_task_ids_json")) return { replaces_task_ids_json: "[]" };
      if (sql.includes("lineage_root_task_id")) return { lineage_root_task_id: null };
      return { work_id: "W" };
    },
    all: (sql) => {
      if (sql.includes("task_change_measurements")) return [];
      if (sql.includes("agent_runs")) return runs;
      if (sql.includes("total_review_attempts")) return tasks;
      return [{ id: "X" }];
    },
  });
  const marked = lineageUsage(readerFor({
    tasks: [{ id: "X", title: "X", lineage_generation: 4, total_review_attempts: 7, base_sync_generations: 2, base_sync_review_attempts: 3 }],
    runs: [{ task_id: "X", base_sync_only: 0, count: 2 }, { task_id: "X", base_sync_only: 1, count: 4 }],
  }), "X", DEFAULT_REMAKE_LIMIT_SETTINGS);
  assert.equal(marked.review_attempts, 4, "7 verdicts - 3 base-sync");
  assert.equal(marked.worker_runs, 2);
  assert.equal(marked.base_sync_review_attempts, 3);
  assert.equal(marked.base_sync_worker_runs, 4);
  assert.equal(marked.base_sync_generations, 2);
  assert.equal(marked.main_generations, 2);
  assert.equal(marked.history[0].worker_runs, 6, "the history line keeps its own total");

  const legacy = lineageUsage(readerFor({
    tasks: [{ id: "X", title: "X", lineage_generation: 2, total_review_attempts: 5 }],
    runs: [{ task_id: "X", count: 3 }],
  }), "X", DEFAULT_REMAKE_LIMIT_SETTINGS);
  assert.deepEqual([legacy.review_attempts, legacy.worker_runs, legacy.base_sync_review_attempts, legacy.base_sync_worker_runs, legacy.main_generations], [5, 3, 0, 0, 2], "rows without the mark are main work");
});

test("reducer: a base-sync generation is not stopped by the main limit but by its own", () => {
  const now = "2026-10-04T00:00:00.000Z";
  const row = (extra) => ({
    id: "task-1", work_id: "work-1", parent_task_id: null, title: "A", type: "code", status: "verifying", review_override: "true",
    priority: "normal", context: "", acceptance: "Done.", state_version: 3, failure_count: 0, same_error_count: 0, last_error_key: null,
    last_error_generation: null, review_round: 0, reviewer_failure_count: 0, total_review_attempts: 1, worker_generation: 1,
    manager_task_id: "T1", retry_no: 0, next_attempt_at: null, worktree_path: null, worktree_state: null, last_failure_class: null,
    paused_from: null, lineage_root_task_id: null, lineage_generation: 1, replaces_task_ids_json: "[]", created_at: now, updated_at: now, ...extra,
  });
  const command = { event: "review.failed", payload: { verdict: "fix_required" } };
  const lineage = (extra) => ({ otherReviewAttempts: 2, otherBaseSyncReviewAttempts: 0, limit: 3, baseSyncLimit: 3, generations: 2, ...extra });

  // Main row: 2 other + this one = 3 >= 3 stops on the main limit.
  assert.equal(reduceTask(row({}), command, { lineage: lineage({}) }).lineage_budget?.reason, "lineage_review_attempts");
  // Marked row: its own verdict is not main work, so the main limit (2 + 0) does not stop it.
  const marked = reduceTask(row({ base_sync_only: 1, base_sync_review_attempts: 1 }), command, { lineage: lineage({}) });
  assert.equal(marked.lineage_budget, undefined);
  assert.notEqual(marked.next.status, "judgement_waiting");
  assert.equal(marked.next.base_sync_review_attempts, 2, "the verdict is counted on the base-sync side");
  // ...but the base-sync limit stops it.
  const stopped = reduceTask(row({ base_sync_only: 1, base_sync_review_attempts: 1 }), command, { lineage: lineage({ otherBaseSyncReviewAttempts: 2 }) });
  assert.equal(stopped.next.status, "judgement_waiting");
  assert.equal(stopped.lineage_budget.reason, "base_sync_lineage_review_attempts");
  assert.equal(stopped.lineage_budget.limit, 3);
  // The main limit wins when both are reached.
  const both = reduceTask(row({ base_sync_only: 1, base_sync_review_attempts: 1 }), command, { lineage: lineage({ otherReviewAttempts: 3, otherBaseSyncReviewAttempts: 2 }) });
  assert.equal(both.lineage_budget.reason, "lineage_review_attempts");
});

test("the Owner brief splits main work and base-sync only when base-sync work exists or stopped the Work", async () => {
  const { remakeLimitBrief } = await import("../../packages/core/dist/decision-brief.js");
  const usage = (o) => ({ generations: 3, main_generations: 3, review_attempts: 4, worker_runs: 5, base_sync_generations: 0, base_sync_review_attempts: 0, base_sync_worker_runs: 0, non_functional_streak: 0, last_streak_paths: [], history: [{ generation: 1, title: "A", review_attempts: 2, worker_runs: 3, kind: "functional", base_sync_generations: 0, base_sync_review_attempts: 0, base_sync_worker_runs: 0 }], ...o });
  const brief = (language, reason, u) => remakeLimitBrief({ taskId: "X", taskTitle: "A", reason, usage: usage(u), settings: DEFAULT_REMAKE_LIMIT_SETTINGS }, language);
  for (const [language, totals, baseSync] of [["ja", /^通算:/m, /取り込み/], ["en", /^Totals:/m, /base-sync|base branch/i]]) {
    const plain = brief(language, "lineage_worker_runs", {});
    assert.match(plain.reason, totals, `${language}: unmarked usage keeps the single totals line`);
    assert.doesNotMatch(JSON.stringify(plain), baseSync, `${language}: no base-sync wording without base-sync work`);
    const split = brief(language, "base_sync_lineage_worker_runs", { base_sync_generations: 2, base_sync_review_attempts: 3, base_sync_worker_runs: 9, main_generations: 1 });
    assert.doesNotMatch(split.reason, totals, `${language}: the totals line is labelled as main work`);
    assert.match(split.reason, /本題の通算|Main work totals/);
    assert.match(split.reason, /(本題の通算（|Main work totals \()1( 世代| generations)/, `${language}: the main generation count is stated separately`);
    assert.match(split.reason, baseSync);
    assert.match(split.reason, /9\/\d+/, `${language}: the base-sync count and limit are stated`);
    const review = brief(language, "base_sync_lineage_review_attempts", { base_sync_generations: 2, base_sync_review_attempts: 7, base_sync_worker_runs: 9, main_generations: 1 });
    assert.match(review.reason, baseSync, `${language}: a base-sync review stop is attributed to base-sync work`);
    assert.match(review.reason, /7\/\d+/, `${language}: the base-sync review count and limit are stated`);
  }
});

/** A Manager whose replans retry T1 under the same id; markFor(n) decides the base_sync_only mark of the n-th replan. */
function sameIdRunner(markFor) {
  const state = { replans: 0 };
  return {
    state,
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask()] } };
      if (mode === "replan") {
        state.replans += 1;
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [planTask({ base_sync_only: markFor(state.replans) })] } };
      }
      return { outcome: "failed", message: `unexpected manager ${mode}` };
    },
    runWorker: async (request) => {
      await writeFileIn(request.context.worktree, "src/feature.mjs", `export const n = ${Date.now()};\n`);
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => reviewFailed(),
    runAdvisor: async () => ({ reply: "" }),
  };
}

test("a mark on the initial plan is stored on the Task and its Worker runs count as base-sync", async (t) => {
  const runner = sameIdRunner(() => true);
  runner.runManagerPlan = async () => ({ outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask({ base_sync_only: true })] } });
  const { db, core } = await openCore(t, runner, { settings: settingsWith({}) });
  const workId = await startWork(core, "plan-mark");
  assert.ok(await waitFor(() => db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE task_id IN (SELECT id FROM tasks WHERE work_id = ?) AND role = 'worker'", workId).n > 0), "a Worker started");
  const row = db.get("SELECT id, base_sync_only FROM tasks WHERE work_id = ? ORDER BY created_at LIMIT 1", workId);
  assert.equal(row.base_sync_only, 1);
  assert.ok(db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE task_id = ? AND role = 'worker' AND base_sync_only = 1", row.id).n >= 1);
  // The in-process Worker keeps writing into the worktree until it exits; Core.stop() cannot cancel it, so
  // finishing earlier makes the temp-dir cleanup race it (ENOTEMPTY).
  assert.ok(await waitFor(() => db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE task_id = ? AND role = 'worker' AND ended_at IS NOT NULL", row.id).n > 0), "the Worker exited");
});

test("a lineage of marked retries stops at the base-sync limit and its runs never enter the main totals", async (t) => {
  const { lineageUsage } = await import("../../packages/core/dist/task-lineage.js");
  const runner = sameIdRunner(() => true);
  const settings = settingsWith({ lineage_review_attempts: 1000, lineage_worker_runs: 1000, non_functional_remakes: 100, base_sync_lineage_review_attempts: 1000, base_sync_lineage_worker_runs: 5 });
  const { db, core } = await openCore(t, runner, { settings });
  await core.setReviewLimitSettings({ ...(await core.getReviewLimitSettings()), total_review_attempts: 100 });
  const workId = await startWork(core, "base-sync-limit");

  assert.ok(await waitFor(() => workState(db, workId) === "judgement_waiting"), `the Work waits (state=${workState(db, workId)})`);
  await sleep(300);
  const taskId = db.get("SELECT id FROM tasks WHERE work_id = ? ORDER BY created_at LIMIT 1", workId).id;
  const usage = lineageUsage(db, taskId, settings);
  const mainRuns = db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE task_id = ? AND role = 'worker' AND base_sync_only = 0", taskId).n;
  const markedRuns = db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE task_id = ? AND role = 'worker' AND base_sync_only = 1", taskId).n;
  assert.ok(markedRuns >= 5, `the separate limit was reached (${markedRuns} marked runs)`);
  assert.equal(usage.worker_runs, mainRuns, "marked runs are not in the main total");
  assert.equal(usage.base_sync_worker_runs, markedRuns);
  assert.ok(usage.worker_runs < usage.worker_runs + usage.base_sync_worker_runs);
  const decision = db.get("SELECT * FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.ok(decision, "the Work waits for the Owner on an open Decision");
  assert.match(JSON.stringify(decision), /取り込み|base-sync|base branch/i, "the Decision names the separate limit");
});

test("main-work limits still stop a lineage that is mixed with base-sync work", async (t) => {
  const { lineageUsage } = await import("../../packages/core/dist/task-lineage.js");
  // Only the first replan is marked; later retries are main work again.
  const runner = sameIdRunner((n) => n === 1);
  const settings = settingsWith({ lineage_review_attempts: 1000, lineage_worker_runs: 6, non_functional_remakes: 100, base_sync_lineage_review_attempts: 1000, base_sync_lineage_worker_runs: 1000 });
  const { db, core } = await openCore(t, runner, { settings });
  await core.setReviewLimitSettings({ ...(await core.getReviewLimitSettings()), total_review_attempts: 100 });
  const workId = await startWork(core, "mixed-main-limit");

  assert.ok(await waitFor(() => workState(db, workId) === "judgement_waiting"), `the Work waits (state=${workState(db, workId)})`);
  await sleep(300);
  const taskId = db.get("SELECT id FROM tasks WHERE work_id = ? ORDER BY created_at LIMIT 1", workId).id;
  const usage = lineageUsage(db, taskId, settings);
  assert.ok(usage.base_sync_worker_runs > 0, "the lineage does contain base-sync work");
  assert.ok(usage.worker_runs >= 6, `the main limit was reached by main work alone (${usage.worker_runs})`);
  assert.ok(usage.base_sync_worker_runs + usage.worker_runs > usage.worker_runs);
  assert.ok(runner.state.replans < 20, "the Manager was not asked to replan without end");
  const decision = db.get("SELECT * FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.ok(decision);
  assert.doesNotMatch(JSON.stringify(decision), /base_sync_lineage/, "the stop is on the main limit");
});

const designRow = (overrides = {}) => {
  const now = "2026-10-04T00:00:00.000Z";
  return {
    id: "task-d", work_id: "work-1", parent_task_id: null, title: "D", type: "design", status: "verifying",
    priority: "normal", context: "", acceptance: "Done.", state_version: 3, failure_count: 0, same_error_count: 0, last_error_key: null,
    last_error_generation: null, review_round: 2, lead_designer_start_round: 2, design_escalated: 1, reviewer_failure_count: 0, total_review_attempts: 3, worker_generation: 1,
    manager_task_id: "T1", retry_no: 0, next_attempt_at: null, worktree_path: null, worktree_state: null, last_failure_class: null,
    paused_from: null, lineage_root_task_id: null, lineage_generation: 1, replaces_task_ids_json: "[]", lead_review_rejections: 0, design_stop_json: null,
    created_at: now, updated_at: now, ...overrides,
  };
};
const leadReviewFailed = (row, lineage) => reduceTask(row, { event: "review.failed", payload: { verdict: "fix_required" } }, { lineage });
const leadLineage = (overrides = {}) => ({ otherReviewAttempts: 0, otherBaseSyncReviewAttempts: 0, limit: 100, baseSyncLimit: 100, generations: 1, otherLeadRejections: 0, leadRejectionLimit: 1, ...overrides });

test("reducer 18e: the lead rejection limit (1 by default, 2 when configured) stops the design after a report-only run", () => {
  const stopped = leadReviewFailed(designRow(), leadLineage());
  assert.equal(stopped.next.status, "review_fix_waiting");
  assert.equal(stopped.next.lead_review_rejections, 1);
  assert.ok(stopped.next.design_stop_json, "the stop is recorded");
  assert.equal(JSON.parse(stopped.next.design_stop_json).rejections, 1);

  const first = leadReviewFailed(designRow(), leadLineage({ leadRejectionLimit: 2 }));
  assert.equal(first.next.design_stop_json ?? null, null, "limit 2: the first rejection is remade");
  assert.equal(first.next.lead_review_rejections, 1);
  const second = leadReviewFailed(designRow({ lead_review_rejections: 1 }), leadLineage({ leadRejectionLimit: 2 }));
  assert.equal(JSON.parse(second.next.design_stop_json).rejections, 2, "limit 2: the second rejection stops");
  const chained = leadReviewFailed(designRow(), leadLineage({ leadRejectionLimit: 2, otherLeadRejections: 1 }));
  assert.ok(chained.next.design_stop_json, "rejections of earlier Tasks in the lineage count");
});

test("reducer 18e: standard-stage rejections neither count nor stop", () => {
  const standard = leadReviewFailed(designRow({ lead_designer_start_round: null, design_escalated: 0, review_round: 0 }), leadLineage());
  assert.equal(standard.next.lead_review_rejections ?? 0, 0);
  assert.equal(standard.next.design_stop_json ?? null, null);
  const startedAtLead = leadReviewFailed(designRow({ lead_designer_start_round: 0, design_escalated: 0, review_round: 0 }), leadLineage());
  assert.equal(startedAtLead.next.design_stop_json ?? null, null, "a Task that began at Lead (design_mode=lead) is not escalated");
  const code = leadReviewFailed(designRow({ type: "code" }), leadLineage());
  assert.equal(code.next.design_stop_json ?? null, null);
});

test("designBlockedBrief copies the structured report; without one it uses fixed wording", async () => {
  const { designBlockedBrief } = await import("../../packages/core/dist/decision-brief.js");
  const report = {
    cause_kind: "policy_conflict", cause: "The request contradicts a rule.", repeated_findings: [{ summary: "No migration", times: 2 }],
    question: "Which way?", options: [{ label: "A", description: "do a" }, { label: "B", description: "do b" }], recommended_option: 1,
  };
  const brief = designBlockedBrief({ taskTitle: "D", trigger: "lead_review_rejections", rejections: 1, limit: 1, latestFindings: ["f1"], report }, "en");
  assert.ok(brief.options.length >= 3, "the report's options plus cancel");
  assert.equal(brief.options.at(-1).key, "cancel");
  const bare = designBlockedBrief({ taskTitle: "D", trigger: "designer", rejections: null, limit: null, latestFindings: ["f1"], report: null }, "en");
  assert.ok(bare.options.some((o) => o.key === "replan"));
  assert.equal(bare.options.at(-1).key, "cancel");
});

test("a remake gate whose transaction fails skips the replan, tells the Owner once, and the next tick after recovery stops the lineage", async (t) => {
  const runner = lineageRunner({ workerWrites: (root, n) => writeFileIn(root, "src/feature.mjs", `export const n = ${n};\n`) });
  const { db, core } = await openCore(t, runner, { settings: settingsWith({ lineage_review_attempts: 1000, lineage_worker_runs: 3, non_functional_remakes: 100 }) });
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  const lane = core.writeLane;
  const transact = lane.transact.bind(lane);
  let broken = true;
  lane.transact = (fn) => transact((transaction) => {
    const run = transaction.run.bind(transaction);
    transaction.run = (sql, ...params) => {
      if (broken && String(sql).includes("UPDATE idempotency_keys SET response_json")) throw new Error("gate write failed");
      return run(sql, ...params);
    };
    return fn(transaction);
  });
  t.after(() => { console.warn = warn; lane.transact = transact; });
  const workId = await startWork(core, "remake-gate-failure");
  const events = () => db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.loop_gate_failed'", workId);
  const openDecision = () => db.get("SELECT * FROM decisions WHERE work_id = ? AND status = 'open'", workId);

  assert.ok(await waitFor(() => events().length === 1), "the Owner-visible event is recorded");
  await sleep(300); // several ticks keep failing the same way
  assert.equal(events().length, 1, "the same failure is not recorded again");
  assert.equal(runner.state.replans, 0, "no replan without the gate");
  assert.ok(!openDecision(), "the limit is not decided while the gate is down");
  assert.ok(JSON.parse(events()[0].payload_json).message.includes("gate write failed"));
  assert.ok(warnings.some((line) => line.includes("gate write failed")), "the error is logged");

  broken = false;
  assert.ok(await waitFor(() => openDecision()), "the kept trigger is evaluated again and the limit opens the Owner Decision");
  assert.equal(runner.state.replans, 0, "still no replan");
});

