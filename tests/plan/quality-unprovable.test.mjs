import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluatePlanQuality, formatPlanQualityReason, planQualityOutcome } from "../../packages/core/dist/plan-quality.js";
import { createUlid } from "../../packages/db/dist/index.js";
import {
  DEFAULT_PLAN_QUALITY_SETTINGS,
  readPlanQualitySettings,
  validatePlanQualitySettings,
} from "../../packages/shared/dist/plan-quality-settings.js";
import { createTestCore } from "../helpers/core.mjs";
import { waitFor } from "../helpers/wait.mjs";

const S = DEFAULT_PLAN_QUALITY_SETTINGS;

const necessity = { serves: "test fixture", if_omitted: "test fixture" };
const crit = (n, text, check = "`npm test`") => ({ id: `AC${n}`, text, check, serves: "test fixture", if_omitted: "test fixture", check_weight: "light", weight_reason: "test fixture" });
const render = (list) => list.map((c) => `(${c.id}) ${c.text}\n  check: ${c.check}`).join("\n");
const item = (list, extra = {}) => ({ id: "t1", title: "Change `foo` in packages/core/src/foo.ts", type: "code", acceptance: render(list), acceptance_criteria: list, necessity, ...extra });
const codes = (items, settings = S) => evaluatePlanQuality(items, settings).map((warning) => warning.code);

const ok = crit(1, "出力が正しい");
const external = crit(2, "稼働中の本番 data/ が前後で変わらない");

test("external_state_comparison: flagged for production before/after, with the Task named in the reason", () => {
  assert.deepEqual(codes([item([ok, external])]), ["external_state_comparison"]);
  assert.deepEqual(codes([item([crit(1, "production data remains the same before and after")])]), ["external_state_comparison"]);
  assert.deepEqual(codes([item([crit(1, "ok", "本番 data/ が前後で変わらないことを npm test で確認する")])]), ["external_state_comparison"]);
  const warnings = evaluatePlanQuality([item([ok, external])], S);
  assert.match(warnings[0].detail, /本番/);
  assert.match(formatPlanQualityReason(warnings), /t1.*external_state_comparison/);
});

test("external_state_comparison: not flagged for copies, plain mentions, internal state, write-denied evidence or design Tasks", () => {
  assert.deepEqual(codes([item([ok, crit(2, "本番 data/ のコピーを Task 内に作り、そのコピーが前後で変わらない")])]), []);
  assert.deepEqual(codes([item([crit(1, "本番に反映する"), { ...ok, id: "AC2" }])]), []);
  assert.deepEqual(codes([item([crit(1, "キャッシュの内容が前後で変わらない"), { ...ok, id: "AC2" }])]), []);
  assert.deepEqual(codes([item([crit(1, "sandbox で本番 data/ への書き込みが拒否されたログを残す")])]), []);
  assert.deepEqual(codes([item([{ ...external, id: "AC1" }], { type: "design" })]), []);
});

test("external_state_comparison: a copied log or a sandbox log does not exempt a production comparison", () => {
  assert.deepEqual(codes([item([crit(1, "本番 data/ が前後で変わらないことをコピーしたログで確認する")])]), ["external_state_comparison"]);
  assert.deepEqual(codes([item([crit(1, "本番 data/ が前後で変わらないことを sandbox のログで確認する")])]), ["external_state_comparison"]);
  assert.deepEqual(codes([item([crit(1, "本番 data/ のコピーを作り、本番 data/ が前後で変わらないことを確認する")])]), ["external_state_comparison"]);
});

test("settings drive the verdict and are validated", () => {
  const plan = [item([ok, external])];
  assert.deepEqual(codes(plan, { ...S, external_state_patterns: [] }), []);
  assert.deepEqual(codes(plan, { ...S, state_comparison_patterns: ["^$"] }), []);
  assert.deepEqual(codes(plan, { ...S, external_state_exempt_patterns: ["稼働中の本番 data/"] }), []);
  assert.deepEqual(validatePlanQualitySettings({ ...S }), S);
  assert.throws(() => validatePlanQualitySettings({ ...S, blocking_codes: ["nope"] }));
  assert.throws(() => validatePlanQualitySettings({ ...S, blocking_codes: ["broad_scope", "broad_scope"] }));
  assert.throws(() => validatePlanQualitySettings({ ...S, external_state_patterns: ["("] }));
  assert.throws(() => validatePlanQualitySettings({ ...S, external_state_patterns: ["\\a"] }));
  const { blocking_codes: _drop, ...missing } = S;
  assert.throws(() => validatePlanQualitySettings(missing));
  const read = readPlanQualitySettings({ external_state_patterns: ["("], max_components: 9 });
  assert.deepEqual(read.external_state_patterns, S.external_state_patterns);
  assert.equal(read.max_components, 9);
});

test("planQualityOutcome: repair first, then reject blocking codes only", () => {
  const blocking = [{ code: "external_state_comparison" }];
  const soft = [{ code: "acceptance_items_over" }];
  assert.equal(planQualityOutcome(blocking, 0, S), "repair_requested");
  assert.equal(planQualityOutcome(blocking, S.max_repair_requests, S), "rejected");
  assert.equal(planQualityOutcome(soft, S.max_repair_requests, S), "accepted_with_warnings");
  assert.equal(planQualityOutcome(blocking, S.max_repair_requests, { ...S, blocking_codes: [] }), "accepted_with_warnings");
});

const managerTask = (id, list) => ({
  id, title: `${id} title`, type: "code", acceptance: render(list), acceptance_criteria: list, necessity, depends_on: [], required_sections: [], required_tests: [], replaces: [], context: "", notes: "", review: false,
});

async function openCore(t, plans, seen, event = "work.planned") {
  let release;
  const gate = new Promise((resolvePromise) => { release = resolvePromise; });
  t.after(() => release());
  const { db, core } = await createTestCore(t, {
    agentRunner: {
      runManagerPlan: async (request) => {
        seen.push(request.context?.previous_output_feedback ? JSON.stringify(request.context.previous_output_feedback) : null);
        const tasks = plans[Math.min(seen.length, plans.length) - 1];
        return { outcome: "success", report_valid: true, report: { event, tasks } };
      },
      runWorker: async () => {
        await gate;
        return { outcome: "failed", failure_class: "transient", error_key: "x", retry_allowed: true, message: "x" };
      },
      runReviewer: async () => ({ outcome: "failed" }),
      runAdvisor: async () => ({ reply: "" }),
    },
    max_parallel: 4,
    dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 },
  }, { prefix: "owl-plan-unprovable-", start: true });
  return { db, core };
}

async function startWork(core) {
  const created = await core.createWork({
    request_id: createUlid(), idempotency_key: `test:create:${createUlid()}`, expected_version: 0,
    payload: { title: "W", summary: "x", size: "normal", project_id: null },
  });
  const workId = created.data.work_id;
  await core.startWork(workId, {
    request_id: createUlid(), idempotency_key: `test:start:${createUlid()}`, expected_version: created.version,
    payload: { mode: "normal" },
  });
  return workId;
}

const outcomes = (db, workId) =>
  db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.plan_quality_warned' ORDER BY sequence", workId)
    .map((row) => JSON.parse(row.payload_json).outcome);
const taskCount = (db, workId) => db.get("SELECT COUNT(*) AS n FROM tasks WHERE work_id = ?", workId).n;

const replanTask = (id, list) => ({ ...managerTask(id, list), replaces: ["T2"], depends_on: ["T1"] });

async function startReplan(db, core) {
  const created = await core.createWork({
    request_id: createUlid(), idempotency_key: `test:create:${createUlid()}`, expected_version: 0,
    payload: { title: "W", summary: "x", size: "normal", project_id: null },
  });
  const workId = created.data.work_id;
  const ids = { t1: createUlid(), t2: createUlid() };
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    for (const [id, status, m] of [[ids.t1, "completed", "T1"], [ids.t2, "failed", "T2"]]) {
      tx.run(
        `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
         VALUES (?, ?, ?, 'code', ?, 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, ?)`,
        id, workId, `${m} title`, status, now, now, m,
      );
    }
    tx.run("UPDATE works SET state = 'paused' WHERE id = ?", workId);
    return null;
  });
  await core.start();
  await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId));
  const replan = core.triggerManagerReplan(workId, [ids.t2], { kind: "queued_failed_tasks" }).catch(() => null);
  return { workId, replan };
}

test("initial plan: an external-state criterion is sent back, then rejected; nothing is registered", async (t) => {
  const seen = [];
  const { db, core } = await openCore(t, [[managerTask("A", [ok, external])]], seen);
  const workId = await startWork(core);
  assert.ok(await waitFor(() => outcomes(db, workId).includes("rejected")));
  assert.match(seen[1], /"task_ref":"A","title":"A title","code":"external_state_comparison"/);
  assert.deepEqual(outcomes(db, workId).slice(0, 2), ["repair_requested", "rejected"]);
  assert.equal(taskCount(db, workId), 0);
});

test("initial plan: a repaired plan is accepted; a non-blocking warning alone is accepted after the repair", async (t) => {
  const seen = [];
  const { db, core } = await openCore(t, [[managerTask("A", [ok, external])], [managerTask("A", [ok])]], seen);
  const workId = await startWork(core);
  assert.ok(await waitFor(() => taskCount(db, workId) === 1));
  assert.deepEqual(outcomes(db, workId), ["repair_requested"]);

  const many = Array.from({ length: S.max_acceptance_items + 1 }, (_, i) => crit(i + 1, `item ${i + 1}`));
  const second = await openCore(t, [[managerTask("B", many)]], []);
  const workId2 = await startWork(second.core);
  assert.ok(await waitFor(() => taskCount(second.db, workId2) === 1));
  assert.deepEqual(outcomes(second.db, workId2), ["repair_requested", "accepted_with_warnings"]);
});

test("replan: an external-state criterion is sent back with the Task and code, then rejected with nothing applied", async (t) => {
  const seen = [];
  const { db, core } = await openCore(t, [[replanTask("N1", [ok, external])]], seen, "task.replanned");
  const { workId, replan } = await startReplan(db, core);
  assert.ok(await waitFor(() => outcomes(db, workId).includes("rejected")));
  await replan;
  assert.deepEqual(outcomes(db, workId).slice(0, 2), ["repair_requested", "rejected"]);
  assert.match(seen[1], /"task_ref":"N1","title":"N1 title","code":"external_state_comparison"/);
  assert.equal(taskCount(db, workId), 2);
});

test("a plan whose criteria lack a check is a format error that is sent back for a fields-only fix, and a repaired replan is applied", async (t) => {
  const bad = [ok, { ...crit(2, "見た目が良い"), check: "" }];
  const seen = [];
  const { db, core } = await openCore(t, [[replanTask("N1", bad)], [replanTask("N1", [ok])]], seen, "task.replanned");
  const replanned = await startReplan(db, core);
  assert.ok(await waitFor(() => taskCount(db, replanned.workId) === 3));
  await replanned.replan;
  assert.match(seen[1], /"task_ref":"N1","title":"N1 title","code":"criterion_field_missing".*acceptance_criteria\[2\]\.check/s);
  assert.match(seen[1], /"kind":"fields_missing"/);
  assert.deepEqual(outcomes(db, replanned.workId), []);
  const stored = db.get("SELECT acceptance_criteria_json AS json FROM tasks WHERE work_id = ? AND manager_task_id = 'N1'", replanned.workId);
  assert.deepEqual(JSON.parse(stored.json), [ok]);
});
