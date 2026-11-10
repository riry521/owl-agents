import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { NoopGitGateway } from "../../packages/core/dist/index.js";

import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { criteriaFor, necessityFor, withNecessity } from "../helpers/necessity.mjs";
import { waitFor } from "../helpers/wait.mjs";

// When a Work completes or is cancelled, and at startup for finished Works, rows nothing reads any more are cleared
// (delivered outbox rows, clone uses of completed Tasks, review verification reports, all but each Task's latest report).
// The work_data_retention setting turns it off; without it, it is on.

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
let sequence = 0;

async function newWork(core, db, state) {
  const created = await core.createWork(command({ title: "W", summary: "x", size: "normal", project_id: null }, `create-${createUlid()}`));
  const workId = created.data.work_id;
  await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = ? WHERE id = ?", state, workId));
  return workId;
}

/** One completed Task with two reports, a review, a clone use, and delivered/pending outbox rows on a Work event. */
async function seed(db, workId) {
  const ids = { work: workId, task: createUlid(), oldRun: createUlid(), newRun: createUlid(), oldReport: createUlid(), newReport: createUlid(), review: createUlid(), event: createUlid(), delivered: createUlid(), pending: createUlid() };
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
       VALUES (?, ?, 't', 'code', 'completed', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`,
      ids.task, workId, NOW, NOW,
    );
    for (const [run, report, at] of [[ids.oldRun, ids.oldReport, NOW], [ids.newRun, ids.newReport, LATER]]) {
      tx.run(
        `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at) VALUES (?, ?, ?, 'worker', 'p', 'm', 'completed', ?, ?)`,
        run, workId, ids.task, at, at,
      );
      tx.run(
        `INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at) VALUES (?, ?, '1', 'success', '{}', ?, 0, ?)`,
        report, run, "0".repeat(64), at,
      );
      tx.run("UPDATE agent_runs SET report_id = ? WHERE id = ?", report, run);
    }
    tx.run(
      `INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at) VALUES (?, ?, 0, 'pass', '[{"a":1}]', '{"big":"report"}', ?)`,
      ids.review, ids.task, NOW,
    );
    tx.run("INSERT INTO task_clone_uses (task_id, path, clone_exists, baseline) VALUES (?, '/c', 1, 'b')", ids.task);
    sequence += 1;
    tx.run(
      "INSERT INTO events (id, sequence, idempotency_key, type, work_id, payload_json, status, created_at) VALUES (?, ?, ?, 'work.completed', ?, '{}', 'handled', ?)",
      ids.event, 900000 + sequence, `k-${ids.event}`, workId, NOW,
    );
    tx.run("INSERT INTO outbox_deliveries (id, event_id, provider, provider_message_key, status) VALUES (?, ?, 'websocket', 'm1', 'delivered')", ids.delivered, ids.event);
    tx.run("INSERT INTO outbox_deliveries (id, event_id, provider, provider_message_key, status) VALUES (?, ?, 'slack', 'm2', 'pending')", ids.pending, ids.event);
    tx.run("INSERT INTO work_final_reports (work_id, summary, test_results, issues, created_at) VALUES (?, 'final-summary', 'final-tests', 'final-issues', ?)", workId, NOW);
    tx.run(
      `INSERT INTO decisions (id, work_id, scope, status, blocked_task_ids_json, reason, tried, current_state, options_json, allow_free_text, issuer_role, created_at)
       VALUES (?, ?, 'work', 'resolved', '[]', 'decision-reason', 't', 'c', '[]', 0, 'core', ?)`,
      `dec-${ids.task}`, workId, NOW,
    );
    tx.run("INSERT INTO idempotency_keys (key, request_hash, response_json, status_code, created_at, expires_at) VALUES (?, ?, '{}', 200, ?, ?)", `idem-${ids.task}`, "0".repeat(64), NOW, LATER);
  });
  return ids;
}

const count = (db, sql, ...args) => db.get(sql, ...args).n;

function snapshot(db, ids) {
  return {
    delivered: count(db, "SELECT COUNT(*) AS n FROM outbox_deliveries WHERE id = ?", ids.delivered),
    pending: count(db, "SELECT COUNT(*) AS n FROM outbox_deliveries WHERE id = ?", ids.pending),
    cloneUses: count(db, "SELECT COUNT(*) AS n FROM task_clone_uses WHERE task_id = ?", ids.task),
    verification: db.get("SELECT verification_report_json AS v FROM reviews WHERE id = ?", ids.review).v,
    findings: db.get("SELECT findings_json AS f FROM reviews WHERE id = ?", ids.review).f,
    oldReport: count(db, "SELECT COUNT(*) AS n FROM reports WHERE id = ?", ids.oldReport),
    newReport: count(db, "SELECT COUNT(*) AS n FROM reports WHERE id = ?", ids.newReport),
    runs: count(db, "SELECT COUNT(*) AS n FROM agent_runs WHERE task_id = ?", ids.task),
    newRunReport: db.get("SELECT report_id FROM agent_runs WHERE id = ?", ids.newRun).report_id,
    work: db.get("SELECT title, summary, state FROM works WHERE id = ?", ids.work),
    task: db.get("SELECT title, acceptance, status FROM tasks WHERE id = ?", ids.task),
    finalReport: db.get("SELECT summary, test_results, issues FROM work_final_reports WHERE work_id = ?", ids.work),
    decision: db.get("SELECT reason, status FROM decisions WHERE id = ?", `dec-${ids.task}`),
    verdict: db.get("SELECT verdict FROM reviews WHERE id = ?", ids.review).verdict,
    events: count(db, "SELECT COUNT(*) AS n FROM events WHERE id = ?", ids.event),
    idempotency: count(db, "SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = ?", `idem-${ids.task}`),
  };
}

const UNTOUCHED = {
  work: { title: "W", summary: "x" },
  task: { title: "t", acceptance: "Done.", status: "completed" },
  finalReport: { summary: "final-summary", test_results: "final-tests", issues: "final-issues" },
  decision: { reason: "decision-reason", status: "resolved" },
  verdict: "pass", delivered: 1, pending: 1, cloneUses: 1, verification: '{"big":"report"}', findings: '[{"a":1}]', oldReport: 1, newReport: 1, runs: 2, events: 1, idempotency: 1 };
const PRUNED = { ...UNTOUCHED, delivered: 0, cloneUses: 0, verification: "{}", oldReport: 0 };

async function setRetention(db, value) {
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", NOW, NOW);
    tx.run(
      "INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('work_data_retention', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify(value), NOW,
    );
  });
}

function check(db, ids, expected) {
  const actual = snapshot(db, ids);
  delete actual.work.state; // the state differs per case; the rest of the summary must stay
  assert.deepEqual({ ...actual, newRunReport: undefined }, { ...expected, newRunReport: undefined });
  assert.equal(actual.newRunReport, ids.newReport, "the latest run keeps its report link");
}

test("cancelling a Work clears only its own unread rows; another running Work is unchanged", async (t) => {
  const { core, db } = await createTestCore(t, {}, { start: true });
  const cancelled = await newWork(core, db, "running");
  const other = await newWork(core, db, "running");
  const a = await seed(db, cancelled);
  const b = await seed(db, other);

  const version = db.get("SELECT state_version FROM works WHERE id = ?", cancelled).state_version;
  await core.cancelWork(cancelled, command({ reason: "stop" }, `cancel-${createUlid()}`, version));

  check(db, a, PRUNED);
  check(db, b, UNTOUCHED);
});

test("startup clears finished Works but not running ones", async (t) => {
  const { core, db, root } = await createTestCore(t);
  const done = await newWork(core, db, "completed");
  const running = await newWork(core, db, "running");
  const a = await seed(db, done);
  const b = await seed(db, running);
  await core.stop({ force: true });

  const restarted = await createTestCore(t, { db, owlRoot: root }, { start: true });
  assert.ok(restarted.core);
  check(db, a, PRUNED);
  check(db, b, UNTOUCHED);
});

test("with the setting off nothing is cleared at startup or on cancel; with no setting it is on", async (t) => {
  const { core, db, root } = await createTestCore(t);
  await setRetention(db, { enabled: false });
  const done = await newWork(core, db, "completed");
  const running = await newWork(core, db, "running");
  const a = await seed(db, done);
  const b = await seed(db, running);
  await core.stop({ force: true });

  const restarted = await createTestCore(t, { db, owlRoot: root }, { start: true });
  check(db, a, UNTOUCHED);
  const version = db.get("SELECT state_version FROM works WHERE id = ?", running).state_version;
  await restarted.core.cancelWork(running, command({ reason: "stop" }, `cancel-${createUlid()}`, version));
  check(db, b, UNTOUCHED);

  await db.createWriteLane().transact((tx) => tx.run("DELETE FROM settings WHERE key = 'work_data_retention'"));
  await restarted.core.stop({ force: true });
  await createTestCore(t, { db, owlRoot: root }, { start: true });
  check(db, a, PRUNED);
});

test("a Work reopened after its rows were cleared plans, runs and reviews a new Task, then completes", async (t) => {
  const prompts = [];
  const agentRunner = {
    runManagerPlan: async (request) => {
      prompts.push(request.mode ?? request.context?.mode);
      if (request.mode === "finalize" || request.context?.mode === "finalize") {
        return { outcome: "success", report_valid: true, report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "done", missing: [], lessons: [] } } };
      }
      return {
        outcome: "success",
        report_valid: true,
        report: {
          tasks: [{ id: "N1", title: "N1", type: "code", necessity: necessityFor(), acceptance_criteria: criteriaFor("Done."), depends_on: [], required_sections: [], required_tests: [], replaces: [], review: true, context: "", notes: "", wait_for: null, base_sync_only: null }],
          event: "task.replanned",
        },
      };
    },
    runWorker: async (request) => (await writeFile(join(request.context.worktree, "a.mjs"), "export const x = 1;\n"), {
      outcome: "success",
      report_valid: true,
      report: { kind: "report", schema_version: "1.1.0", invocation_id: request.invocation_id, result: "success", work_done: "done", changes: [], verification: { status: "passed", acceptance: [{ criterion_id: "AC1", criterion: "c", status: "passed", evidence: "ok" }], checks: [], method: "Checked.", integration_check: null }, remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null },
    }),
    runReviewer: async () => ({ outcome: "success", report_valid: true, report: {}, review: { verdict: "pass", summary: "ok", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } } }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const git = (root) => Object.assign(new NoopGitGateway(), { prepareWorktree: async () => ({ ok: true, worktree_path: root }) });
  const { core, db, root } = await createTestCore(t, { agentRunner: withNecessity(agentRunner), dispatcher: { tick_interval_ms: 25 } });
  const workId = await newWork(core, db, "completed");
  const ids = await seed(db, workId);
  await core.stop({ force: true });
  const restarted = await createTestCore(t, { db, owlRoot: root, agentRunner: withNecessity(agentRunner), git: git(root), dispatcher: { tick_interval_ms: 25 } }, { start: true });
  check(db, ids, PRUNED);

  const version = db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;
  await restarted.core.reopenWork(workId, command({ reason: "one more thing" }, `reopen-${createUlid()}`, version));

  assert.ok(await waitFor(() => db.get("SELECT 1 AS n FROM tasks WHERE work_id = ? AND manager_task_id = 'N1' AND status = 'completed'", workId)), "the new Task ran");
  assert.ok(await waitFor(() => db.get("SELECT state FROM works WHERE id = ? AND state = 'completed'", workId)), "the Work completed again");
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM reviews r JOIN tasks t ON t.id = r.task_id WHERE t.manager_task_id = 'N1' AND r.verdict = 'pass'"), 1, "the new Task was reviewed");
  // A forced stop in t.after does not wait for the driver's last tick, which then reads the DB that the first Core's hook has closed.
  await restarted.core.stop();
});

/** Events the cleanup treats differently, a major finding, a Skill use and token usage on the seeded Task. */
async function seedEvents(db, ids) {
  const types = {
    "agent.exited": { outcome: "success", report: { r: 1 }, usage: { input_tokens: 5 } },
    "test_run.completed": { status: "passed" },
    "agent.started": { pid: 1 },
    "verification.completed": { outcome: "passed" },
  };
  await db.createWriteLane().transact((tx) => {
    for (const [type, payload] of Object.entries(types)) {
      sequence += 1;
      tx.run(
        "INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'handled', ?)",
        `ev-${type}-${ids.task}`, 900000 + sequence, `command-event:${type}-${ids.task}`, type, ids.work, ids.task, JSON.stringify(payload), NOW,
      );
    }
    tx.run("UPDATE reviews SET findings_json = '[{\"severity\":\"major\"}]' WHERE id = ?", ids.review);
    // The report counts [since, now), so a run stamped with the current millisecond is missed when the report is read in the same one.
    const now = new Date(Date.now() - 60_000).toISOString();
    tx.run("UPDATE agent_runs SET usage_json = '{\"input_tokens\":7,\"output_tokens\":3}', created_at = ?, updated_at = ? WHERE id = ?", now, now, ids.newRun);
    tx.run("INSERT INTO skill_usages (agent_run_id, skill_name, work_id, role, revision, read_detected, verdict, created_at, updated_at) VALUES (?, 's', ?, 'worker', 1, 1, 'helpful', ?, ?)", ids.newRun, ids.work, NOW, NOW);
  });
}

const eventRows = (db, ids) => db.all("SELECT id, type, idempotency_key, task_id, payload_json FROM events WHERE work_id = ? ORDER BY id", ids.work);
const measures = async (core) => ({
  review: await core.getReviewMetrics(),
  skill: core.skillBox.objectiveFeedback("s"),
  tokens: { ...core.getTokenUsageReport({ period: "30d", top: 10 }), until: null, daily: null }, // `until` is the call time
});

test("finished Works lose unread event payloads but keep every row and the payloads that are read", async (t) => {
  const { core, db, root } = await createTestCore(t);
  const done = await newWork(core, db, "completed");
  const ids = await seed(db, done);
  await seedEvents(db, ids);
  await core.stop({ force: true });
  const before = eventRows(db, ids);

  await createTestCore(t, { db, owlRoot: root }, { start: true });
  const after = eventRows(db, ids);

  const payload = (rows, type) => JSON.parse(rows.find((row) => row.type === type).payload_json);
  assert.deepEqual(payload(after, "agent.exited"), { outcome: "success" });
  assert.deepEqual(payload(after, "test_run.completed"), {});
  assert.deepEqual(payload(after, "agent.started"), {});
  assert.deepEqual(payload(after, "verification.completed"), { outcome: "passed" });
  const keys = (rows) => rows.map(({ id, type, idempotency_key, task_id }) => [id, type, idempotency_key, task_id]);
  assert.deepEqual(keys(after), keys(before));
});

test("event payloads stay when the setting is off", async (t) => {
  const { core, db, root } = await createTestCore(t);
  await setRetention(db, { enabled: false });
  const done = await newWork(core, db, "completed");
  const ids = await seed(db, done);
  await seedEvents(db, ids);
  await core.stop({ force: true });
  const before = eventRows(db, ids);
  await createTestCore(t, { db, owlRoot: root }, { start: true });
  assert.deepEqual(eventRows(db, ids), before);
});

test("review metrics, Skill feedback and the token usage report are the same after the cleanup", async (t) => {
  const { core, db, root } = await createTestCore(t);
  await setRetention(db, { enabled: false });
  const done = await newWork(core, db, "completed");
  const ids = await seed(db, done);
  await seedEvents(db, ids);
  const before = await measures(core);
  assert.equal(before.skill.major_finding_count, 1);
  assert.equal(before.tokens.totals.total_tokens, 10);
  await core.stop({ force: true });
  await db.createWriteLane().transact((tx) => tx.run("DELETE FROM settings WHERE key = 'work_data_retention'"));

  const restarted = await createTestCore(t, { db, owlRoot: root }, { start: true });
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM task_clone_uses WHERE task_id = ?", ids.task), 0, "the cleanup ran");
  assert.deepEqual(await measures(restarted.core), before);
});
