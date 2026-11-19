import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { integrationVerificationView, planWarningLines, reviewNotesByTask, reviewerFixesByTask } from "../../apps/web/lib/work-assurance.mjs";
import { createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

async function setup(t) {
  const { root, db, core } = await createTestCore(t, {
    version: "api-work-assurance-test",
    dispatcher: { tick_interval_ms: 25 },
  }, { prefix: "owl-api-work-assurance-" });
  const dataDir = join(root, "store");
  await mkdir(dataDir, { recursive: true });
  const adapter = new ExternalCoreAdapter(core, db, root, dataDir);
  const token = randomBytes(32).toString("hex");
  const server = await startTestHttpServer(t, { core: adapter, db, webOut: root, owlRoot: root, dataDir }, { token });
  if (!server) { t.skip("localhost listen is not permitted"); return null; }
  const request = (path) => server.request("GET", `/api/v1${path}`);
  return { db, core, request };
}

async function seed(core, db) {
  const workId = (await core.createWork({ request_id: randomUUID(), idempotency_key: "wa:create", expected_version: 0, payload: { title: "assurance", summary: "", size: "small", project_id: null } })).data.work_id;
  const now = new Date().toISOString();
  const skipped = createUlid();
  const forced = createUlid();
  const decision = (required, base, skip_reason, forced_reasons) => JSON.stringify({ required, base, skip_reason, forced_reasons });
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE works SET state = 'completed', state_version = 1, updated_at = ? WHERE id = ?", now, workId);
    const task = (id, title, json) => tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id, review_decision, review_decision_json)
       VALUES (?, ?, ?, 'code', 'completed', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, ?, ?, ?)`,
      id, workId, title, now, now, title, JSON.parse(json).required ? "required" : "not_required", json,
    );
    task(skipped, "skipped task", decision(false, "type_default_not_required", "type_default_not_required; within thresholds (1 files, 3 lines)", []));
    task(forced, "forced task", decision(true, "type_default_not_required", null, [{ code: "sensitive_path", detail: "touches core paths: packages/core/src/core.ts" }]));
    let sequence = 1000;
    const event = (type, payload) => {
      sequence += 1;
      tx.run(
        `INSERT INTO events (id, sequence, idempotency_key, type, work_id, payload_json, status, attempt_no, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'handled', 0, ?)`,
        createUlid(), sequence, `wa:${sequence}`, type, workId, JSON.stringify(payload), now,
      );
    };
    event("work.integration_verification_completed", { status: "failed", reason: "command_failed", commands: [{ command_id: "c1", argv: ["pnpm", "test"] }], failed_command_id: "c1", message: "1 test failed", routed_to: "manager" });
    event("work.integration_verification_completed", { status: "passed", reason: null, commands: [], failed_command_id: null, message: null, routed_to: "final_manager" });
    event("work.plan_quality_warned", { phase: "plan", outcome: "accepted_with_warnings", warnings: [{ title: "big task", detail: "The acceptance has 9 items" }] });
  });
  return { workId, skipped, forced };
}

test("GET /works/{id}/assurance returns review reasons, the latest integration verification and plan warnings", async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { core, db, request } = env;
  const { workId, skipped, forced } = await seed(core, db);

  const response = await request(`/works/${workId}/assurance`);
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.work_id, workId);
  const byTask = new Map(data.reviews.map((review) => [review.task_id, review]));
  assert.match(byTask.get(skipped).skip_reason, /within thresholds/);
  assert.equal(byTask.get(forced).required, true);
  assert.match(byTask.get(forced).forced_reasons[0].detail, /packages\/core\/src\/core\.ts/);
  assert.equal(data.integration_verification.status, "passed");
  assert.equal(data.plan_quality_warnings.length, 1);

  // What the screen builds from the response.
  const notes = reviewNotesByTask(data);
  assert.equal(notes.get(skipped).kind, "skipped");
  assert.match(notes.get(skipped).reasons[0], /within thresholds/);
  assert.equal(notes.get(forced).kind, "forced");
  assert.deepEqual(integrationVerificationView(data), { status: "passed", reason: "", message: "", failedCommand: "", commands: 0 });
  assert.deepEqual(planWarningLines(data), [{ phase: "plan", outcome: "accepted_with_warnings", title: "big task", detail: "The acceptance has 9 items" }]);

  assert.equal((await request(`/works/${createUlid()}/assurance`)).status, 404);
});

test("screen helpers tolerate malformed data and show a failed command", () => {
  assert.equal(reviewNotesByTask(null).size, 0);
  assert.equal(integrationVerificationView({}), null);
  assert.deepEqual(planWarningLines({ plan_quality_warnings: [null, { warnings: "x" }] }), []);
  const view = integrationVerificationView({ integration_verification: { status: "failed", commands: [{ command_id: "c1", argv: ["pnpm", "test"] }], failed_command_id: "c1" } });
  assert.equal(view.failedCommand, "pnpm test");
});

test("GET /works/{id}/assurance returns reviewer_fixes from review events and skips malformed payloads", async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { core, db, request } = env;
  const { workId, skipped } = await seed(core, db);
  const good = (outcome, extra = {}) => ({
    reviewer_fix: {
      schema_version: "1.0.0", outcome, reason: null,
      limits: { max_changed_lines: 30, max_changed_files: 3 }, measured: { changed_lines: 12, changed_files: 2 },
      files: [], fixes: [{ finding_index: 0, file: "a.ts", line_start: 3, line_end: 5, change: "fix it", problem: "bad" }],
      tests: { passed: true, error_key: null }, revert: null, ...extra,
    },
  });
  let sequence = 2000;
  await db.createWriteLane().transact((tx) => {
    const event = (type, payload, at) => {
      sequence += 1;
      tx.run(
        `INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, payload_json, status, attempt_no, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'handled', 0, ?)`,
        createUlid(), sequence, `wa:${sequence}`, type, workId, skipped, JSON.stringify(payload), at,
      );
    };
    event("review.failed", good("over_limit", { revert: { verified: true } }), "2026-01-01T00:00:02.000Z");
    event("review.passed", good("applied"), "2026-01-01T00:00:01.000Z");
    event("review.fix_restore_failed", good("tests_failed", { revert: { verified: false } }), "2026-01-01T00:00:03.000Z");
    event("review.failed", { reviewer_fix: { outcome: "bogus" } }, "2026-01-01T00:00:04.000Z");
    event("review.passed", { other: 1 }, "2026-01-01T00:00:05.000Z");
  });
  const { data } = await (await request(`/works/${workId}/assurance`)).json();
  assert.deepEqual(data.reviewer_fixes.map((fix) => [fix.outcome, fix.restore_failed, fix.reverted]), [
    ["applied", false, false], ["over_limit", false, true], ["tests_failed", true, true],
  ]);
  assert.equal(data.reviewer_fixes[0].task_id, skipped);
  assert.deepEqual(data.reviewer_fixes[0].fixes, [{ file: "a.ts", line_start: 3, line_end: 5, problem: "bad", change: "fix it" }]);

  const views = reviewerFixesByTask(data).get(skipped);
  assert.equal(views.length, 3);
  assert.equal(views[2].outcome, "applied", "newest first");
  assert.equal(views[2].fixes[0].location, "a.ts:3-5");
  assert.equal(views[0].restoreFailed, true);
  assert.equal(reviewerFixesByTask(null).size, 0);
});
