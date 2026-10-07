import assert from "node:assert/strict";
import { test } from "node:test";

import { buildManagerPrompt, parseManagerPlanWithFeedback } from "../../packages/agent-runtime/dist/manager.js";
import { evaluatePlanQuality, planQualityOutcome } from "../../packages/core/dist/plan-quality.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { DEFAULT_PLAN_QUALITY_SETTINGS, readPlanQualitySettings, validatePlanQualitySettings } from "../../packages/shared/dist/plan-quality-settings.js";
import { createTestCore } from "../helpers/core.mjs";
import { waitFor } from "../helpers/wait.mjs";

const S = DEFAULT_PLAN_QUALITY_SETTINGS;

const necessity = (overrides = {}) => ({ serves: "the request", if_omitted: "nothing works", ...overrides });
const crit = (n, text, extra = {}) => ({ id: `AC${n}`, text, check: "pnpm test tests/a.test.mjs", serves: "the request", if_omitted: "the request is not met", check_weight: "light", weight_reason: "", kind: "work_check", ...extra });
const LIGHT = [crit(1, "並びが正しい")];
const heavyCriterion = (extra = {}) => crit(2, "本番保管庫のコピー 142 件を実モデルで全件通す（約45分）", extra);
const render = (list) => list.map((c) => `(${c.id}) ${c.text}`).join("\n");
const item = (list, extra = {}) => ({ id: "t1", title: "Change `foo` in packages/core/src/foo.ts", type: "code", acceptance: render(list), acceptance_criteria: list, necessity: necessity(), ...extra });
const codes = (items, settings = S) => evaluatePlanQuality(items, settings).map((warning) => warning.code);

test("criterion_field_missing: empty necessity, serves, if_omitted or weight; design Tasks too", () => {
  assert.deepEqual(codes([item(LIGHT)]), []);
  const missing = (extra, list = LIGHT, type = "code") => evaluatePlanQuality([item(list, { type, ...extra })], S).filter((w) => w.code === "criterion_field_missing");
  assert.deepEqual(missing({ necessity: null })[0].measured, ["necessity"]);
  assert.deepEqual(missing({ necessity: necessity({ serves: " " }) })[0].measured, ["necessity.serves"]);
  assert.deepEqual(missing({}, [crit(1, "x", { if_omitted: "" })])[0].measured, ["acceptance_criteria[1].if_omitted"]);
  assert.deepEqual(missing({}, [crit(1, "x", { check_weight: null })])[0].measured, ["acceptance_criteria[1].check_weight"]);
  assert.equal(missing({ necessity: null }, LIGHT, "design").length, 1);
});

test("heavy_check_unjustified: a heavy wording or a heavy weight without a reason; a representative sample passes", () => {
  const both = [...LIGHT, heavyCriterion()];
  assert.deepEqual(codes([item(both)]), ["heavy_check_unjustified"]);
  assert.deepEqual(codes([item([...LIGHT, heavyCriterion({ check_weight: "heavy", weight_reason: "only the full set shows the ordering bug" })])]), []);
  assert.deepEqual(codes([item([crit(1, "x", { check_weight: "heavy" })])]), ["criterion_field_missing"]);
  assert.deepEqual(codes([item([crit(1, "一時コピーの 5 件をスタブで通す", { check: "node scripts/sample.mjs --provider stub" })])]), []);
  assert.deepEqual(codes([item(both)], { ...S, heavy_check_patterns: [] }), []);
});

test("plan quality settings: heavy_check_patterns is required and validated, and criterion_field_missing and heavy_check_unjustified block by default", () => {
  assert.ok(S.blocking_codes.includes("heavy_check_unjustified"));
  assert.ok(S.blocking_codes.includes("criterion_field_missing"));
  const heavy = [{ code: "heavy_check_unjustified" }];
  assert.equal(planQualityOutcome(heavy, S.max_repair_requests, S), "rejected");
  assert.equal(planQualityOutcome([{ code: "criterion_field_missing" }], S.max_repair_requests, S), "rejected");
  const { heavy_check_patterns: _drop, ...without } = S;
  assert.throws(() => validatePlanQualitySettings(without));
  assert.throws(() => validatePlanQualitySettings({ ...S, heavy_check_patterns: ["("] }));
  assert.deepEqual(readPlanQualitySettings({ blocking_codes: [] }).heavy_check_patterns, S.heavy_check_patterns);
});

test("Manager schema and prompt: necessity and criteria are required output, a bad weight is refused", () => {
  const request = { work: { id: "work-1", title: "T" }, mode: "plan", context: {} };
  const task = { id: "T1", title: "t", type: "code", acceptance_criteria: LIGHT, necessity: necessity(), depends_on: [], context: "", notes: "", review: null, required_sections: [], required_tests: [], replaces: [], wait_for: null, base_sync_only: null };
  const parse = (extra) => parseManagerPlanWithFeedback({ tasks: [{ ...task, ...extra }] }, request).result.tasks[0];
  assert.deepEqual(parse({}).necessity, necessity());
  assert.deepEqual(parse({}).acceptance_criteria, LIGHT);
  assert.throws(() => parse({ acceptance_criteria: [crit(1, "x", { check_weight: "huge" })] }), { name: "AgentRuntimeError" });
  assert.throws(() => parse({ necessity: undefined }), { name: "AgentRuntimeError" });
  for (const mode of ["plan", "replan"]) {
    const prompt = buildManagerPrompt({ ...request, mode }, "en");
    assert.match(prompt, /Plan only what the Work needs/);
    assert.match(prompt, /representative|lightest check/);
  }
  assert.match(buildManagerPrompt({ ...request, mode: "replan" }, "en"), /retried or replacement Task, write necessity and the acceptance_criteria fields again/);
});

const managerTask = (id, list, extra = {}) => ({
  id, title: `${id} title`, type: "code", acceptance: render(list), acceptance_criteria: list, necessity: necessity(), depends_on: [], required_sections: [], required_tests: [], replaces: [], context: "", notes: "", review: false, ...extra,
});

async function openCore(t, plans, seen, event) {
  let release;
  const gate = new Promise((resolvePromise) => { release = resolvePromise; });
  t.after(() => release());
  const { db, core } = await createTestCore(t, {
    agentRunner: {
      runManagerPlan: async (request) => {
        seen.push(request.context?.previous_output_feedback ? JSON.stringify(request.context.previous_output_feedback) : null);
        return { outcome: "success", report_valid: true, report: { event, tasks: plans[Math.min(seen.length, plans.length) - 1] } };
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
  }, { prefix: "owl-plan-necessity-", start: true });
  return { db, core };
}

const warned = (db, workId) =>
  db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.plan_quality_warned' ORDER BY sequence", workId).map((row) => JSON.parse(row.payload_json));

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

const heavyAcceptance = [...LIGHT, heavyCriterion()];
const REPLANS = [
  ["a retried Task with its existing id", (acceptance, extra) => managerTask("T2", acceptance, { depends_on: ["T1"], ...extra }), /"task_ref":"T2","title":"T2 title","code":"heavy_check_unjustified"/],
  ["a replacement Task (replaces)", (acceptance, extra) => managerTask("N1", acceptance, { depends_on: ["T1"], replaces: ["T2"], ...extra }), /"task_ref":"N1","title":"N1 title","code":"heavy_check_unjustified"/],
];

for (const [name, make, expectedReason] of REPLANS) {
  test(`replan: ${name} with a heavy check and no reason is sent back, then rejected`, async (t) => {
    const seen = [];
    const { db, core } = await openCore(t, [[make(heavyAcceptance)]], seen, "task.replanned");
    const { workId, replan } = await startReplan(db, core);
    assert.ok(await waitFor(() => warned(db, workId).some((e) => e.outcome === "rejected")));
    await replan;
    assert.deepEqual(warned(db, workId).slice(0, 2).map((e) => e.outcome), ["repair_requested", "rejected"]);
    assert.match(seen[1], expectedReason);
  });

  test(`replan: ${name} with empty necessity that is never fixed is a format rejection, not a quality repair`, async (t) => {
    const seen = [];
    const { db, core } = await openCore(t, [[make(LIGHT, { necessity: null })]], seen, "task.replanned");
    const { workId, replan } = await startReplan(db, core);
    await replan;
    assert.deepEqual(warned(db, workId), []);
    assert.match(seen[1], /"kind":"fields_missing".*criterion_field_missing/s);
  });

  test(`replan: ${name} with empty necessity is sent back and, once repaired, applied with the necessity in its context`, async (t) => {
    const seen = [];
    const { db, core } = await openCore(t, [[make(LIGHT, { necessity: null })], [make(LIGHT)]], seen, "task.replanned");
    const { workId, replan } = await startReplan(db, core);
    await replan;
    assert.match(seen[1], /"kind":"fields_missing".*criterion_field_missing/s);
    assert.deepEqual(warned(db, workId), []);
    const contexts = db.all("SELECT context FROM tasks WHERE work_id = ? AND manager_task_id IN ('T2', 'N1')", workId).map((row) => row.context);
    assert.ok(contexts.some((context) => context.includes("Necessity (Manager plan):")));
  });
}

for (const [label, task, format] of [["a heavy check without a reason", managerTask("A", heavyAcceptance), false], ["an empty necessity", managerTask("A", LIGHT, { necessity: null }), true]])
test(`initial plan: ${label} is rejected after the repair request`, async (t) => {
  const seen = [];
  const { db, core } = await openCore(t, [[task]], seen, "work.planned");
  const created = await core.createWork({
    request_id: createUlid(), idempotency_key: `test:create:${createUlid()}`, expected_version: 0,
    payload: { title: "W", summary: "x", size: "normal", project_id: null },
  });
  await core.startWork(created.data.work_id, {
    request_id: createUlid(), idempotency_key: `test:start:${createUlid()}`, expected_version: created.version, payload: { mode: "normal" },
  });
  const workId = created.data.work_id;
  if (format) {
    // Missing fields are a format error: fields-only reason, no quality warning event.
    assert.ok(await waitFor(() => seen.length >= 2));
    assert.match(seen[1], /"kind":"fields_missing".*criterion_field_missing/s);
    assert.deepEqual(warned(db, workId), []);
  } else {
    assert.ok(await waitFor(() => warned(db, workId).some((e) => e.outcome === "rejected")));
    assert.deepEqual(warned(db, workId).slice(0, 2).map((e) => e.outcome), ["repair_requested", "rejected"]);
  }
  assert.equal(db.get("SELECT COUNT(*) AS n FROM tasks WHERE work_id = ?", workId).n, 0);
});
