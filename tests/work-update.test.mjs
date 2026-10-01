import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { WORK_TRANSITION_TABLE } from "../packages/core/dist/state-reducer.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function command(payload, suffix, expectedVersion = 0, idempotencyKey = `work-update:${suffix}`) {
  return { request_id: createUlid(), idempotency_key: idempotencyKey, expected_version: expectedVersion, payload };
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-work-update-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const core = new Core({ db, agentRunner: {}, version: "work-update-test", owlRoot: root, dispatcher: { tick_interval_ms: 60_000 } });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { db, core };
}

async function createWorkInState(core, db, state, suffix) {
  const created = await core.createWork(command({ title: `Work ${suffix}`, summary: "Old summary", size: "small", project_id: null }, `create:${suffix}`));
  const workId = created.data.work_id;
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = ?, state_version = 1 WHERE id = ?", state, workId);
  });
  return workId;
}

function ownerReplan(db, workId) {
  const row = db.get("SELECT response_json FROM idempotency_keys WHERE key = ?", `owner-replan:${workId}`);
  return row ? JSON.parse(row.response_json) : null;
}

test("updating a running Work changes its fields without changing state_version and queues a work_update replan", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "running");

  const response = await core.updateWork(workId, command({ title: "Renamed Work", summary: "New summary" }, "running", 1));

  assert.deepEqual(response.data, {
    work_id: workId,
    title: "Renamed Work",
    summary: "New summary",
    state: "running",
    changed_fields: ["title", "summary"],
    replan_queued: true,
  });
  assert.equal(response.version, 1);
  assert.deepEqual({ ...db.get("SELECT title, summary, state_version FROM works WHERE id = ?", workId) }, {
    title: "Renamed Work", summary: "New summary", state_version: 1,
  });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'work.updated' AND work_id = ?", workId).n, 1);
  assert.equal(WORK_TRANSITION_TABLE.some((row) => row.event === "work.updated"), false);
  assert.deepEqual(ownerReplan(db, workId), {
    work_id: workId,
    status: "queued",
    kind: "work_update",
    answer: 'The Owner renamed the Work from "Work running" to "Renamed Work".\nThe Owner rewrote the Work summary. New summary:\nNew summary',
  });
});

test("updating a paused Work queues a replan for when it resumes", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "paused", "paused");

  const response = await core.updateWork(workId, command({ summary: "Updated while paused" }, "paused", 1));

  assert.equal(response.data.state, "paused");
  assert.deepEqual(response.data.changed_fields, ["summary"]);
  assert.equal(response.data.replan_queued, true);
  assert.equal(db.get("SELECT summary FROM works WHERE id = ?", workId).summary, "Updated while paused");
  assert.equal(ownerReplan(db, workId).kind, "work_update");
});

test("updating a cancelled Work is rejected without changing its title", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "cancelled", "cancelled");

  await assert.rejects(
    core.updateWork(workId, command({ title: "Must stay unchanged" }, "cancelled", 1)),
    (error) => error.code === "invalid_state_transition",
  );
  assert.equal(db.get("SELECT title FROM works WHERE id = ?", workId).title, "Work cancelled");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'work.updated' AND work_id = ?", workId).n, 0);
});

test("updating a missing Work returns work_not_found", async (t) => {
  const { core } = await setup(t);
  await assert.rejects(
    core.updateWork(createUlid(), command({ title: "Missing" }, "missing", 0)),
    (error) => error.code === "work_not_found",
  );
});

test("a pending instruction replan is merged with the Work update", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "merge-instruction");
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO idempotency_keys (key, request_hash, response_json, status_code, created_at, expires_at)
       VALUES (?, ?, ?, 202, ?, ?)`,
      `owner-replan:${workId}`, "0".repeat(64),
      JSON.stringify({ work_id: workId, status: "queued", kind: "instruction", answer: "Existing instruction" }),
      new Date().toISOString(), "2999-01-01T00:00:00.000Z",
    );
  });

  await core.updateWork(workId, command({ title: "Merged title" }, "merge-instruction", 1));

  const queued = ownerReplan(db, workId);
  assert.equal(queued.kind, "instruction");
  assert.ok(queued.answer.startsWith("Existing instruction\n\nThe Owner renamed the Work"));
});

test("a pending decision replan is upgraded to work_update without losing its answer", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "merge-decision");
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO idempotency_keys (key, request_hash, response_json, status_code, created_at, expires_at)
       VALUES (?, ?, ?, 202, ?, ?)`,
      `owner-replan:${workId}`, "0".repeat(64),
      JSON.stringify({ work_id: workId, status: "queued", kind: "decision", answer: "Existing decision answer" }),
      new Date().toISOString(), "2999-01-01T00:00:00.000Z",
    );
  });

  await core.updateWork(workId, command({ summary: "Revised summary" }, "merge-decision", 1));

  const queued = ownerReplan(db, workId);
  assert.equal(queued.kind, "work_update");
  assert.ok(queued.answer.startsWith("Existing decision answer\n\nThe Owner rewrote the Work summary."));
});

test("an unchanged Work update is a no-op and command idempotency replays the original response", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "idempotency");
  const request = command({ title: "Work idempotency" }, "idempotency", 1, "work-update:replay");

  const first = await core.updateWork(workId, request);
  const replay = await core.updateWork(workId, { ...request, request_id: createUlid() });
  assert.deepEqual(first, replay);
  assert.deepEqual(first.data.changed_fields, []);
  assert.equal(first.data.replan_queued, false);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'work.updated' AND work_id = ?", workId).n, 0);
  assert.equal(ownerReplan(db, workId), null);
});

test("a stale expected_version rejects a Work update without changing its title", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "stale-version");

  await assert.rejects(
    core.updateWork(workId, command({ title: "Stale update" }, "stale-version", 0)),
    (error) => error.code === "version_conflict",
  );
  assert.equal(db.get("SELECT title FROM works WHERE id = ?", workId).title, "Work stale-version");
});

test("resumeWorkOrRetryDecision resumes a paused Work through resumeWork", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "paused", "resume-paused");

  const request = command({ source: "advisor" }, "resume-paused", 1);
  const response = await core.resumeWorkOrRetryDecision(workId, request);
  const replay = await core.resumeWorkOrRetryDecision(workId, { ...request, request_id: createUlid() });

  assert.deepEqual(response.data, { work_id: workId, state: "running", resumed_by: "resume", decision_id: null });
  assert.deepEqual(replay, response);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
});

test("resumeWorkOrRetryDecision answers an open work retry Decision in judgement_waiting", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "judgement_waiting", "resume-retry");
  const decisionId = createUlid();
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO decisions
         (id, work_id, scope, status, blocked_task_ids_json, reason, question, tried, current_state,
          options_json, recommended, allow_free_text, issuer_role, state_version, created_at)
       VALUES (?, ?, 'work', 'open', '[]', 'retry', 'Try again?', '', 'judgement_waiting',
               ?, 'retry', 1, 'core', 0, ?)`,
      decisionId,
      workId,
      JSON.stringify([{ key: "retry", label: "Retry the Work" }, { key: "cancel", label: "Cancel" }]),
      new Date().toISOString(),
    );
  });

  const request = command({ source: "advisor" }, "resume-retry", 1);
  const response = await core.resumeWorkOrRetryDecision(workId, request);
  const replay = await core.resumeWorkOrRetryDecision(workId, { ...request, request_id: createUlid() });

  assert.deepEqual(response.data, { work_id: workId, state: "running", resumed_by: "retry_decision", decision_id: decisionId });
  assert.deepEqual(replay, response);
  assert.equal(db.get("SELECT status FROM decisions WHERE id = ?", decisionId).status, "resolved");
  assert.equal(db.get("SELECT source FROM decision_answers WHERE decision_id = ?", decisionId).source, "advisor");
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
});

test("resumeWorkOrRetryDecision records retry answers as advisor when source is omitted or different", async (t) => {
  for (const [suffix, payload] of [["omitted", {}], ["web", { source: "web" }]]) {
    const { db, core } = await setup(t);
    const workId = await createWorkInState(core, db, "judgement_waiting", `resume-source-${suffix}`);
    const decisionId = createUlid();
    await db.createWriteLane().transact((transaction) => {
      transaction.run(
        `INSERT INTO decisions
           (id, work_id, scope, status, blocked_task_ids_json, reason, question, tried, current_state,
            options_json, recommended, allow_free_text, issuer_role, state_version, created_at)
         VALUES (?, ?, 'work', 'open', '[]', 'retry', 'Try again?', '', 'judgement_waiting',
                 ?, 'retry', 1, 'core', 0, ?)`,
        decisionId,
        workId,
        JSON.stringify([{ key: "retry", label: "Retry the Work" }]),
        new Date().toISOString(),
      );
    });

    await core.resumeWorkOrRetryDecision(workId, command(payload, `resume-source-${suffix}`, 1));

    assert.equal(db.get("SELECT source FROM decision_answers WHERE decision_id = ?", decisionId).source, "advisor");
  }
});

test("resumeWorkOrRetryDecision rejects an ineligible Work without changing it", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "resume-ineligible");

  await assert.rejects(
    core.resumeWorkOrRetryDecision(workId, command({ source: "advisor" }, "resume-ineligible", 1)),
    (error) => error.code === "invalid_state_transition" && error.details.reason === "not_resumable",
  );
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
});
