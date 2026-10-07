import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Module } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import ts from "typescript";

import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { migrationsDir, repoRoot } from "../helpers/paths.mjs";

// Tasks a Manager replan retired (superseded_at) leave the Work's Task list
// and progress. Owner-cancelled Tasks stay; rows are never deleted.

test("superseded Tasks are hidden from listTasks and getWork progress", async (t) => {
  const { db, core } = await createTestCore(t, {}, { prefix: "owl-superseded-" });
  const now = new Date().toISOString();
  const ids = {};
  let sequence = 0;
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default','owner:default',?,?)", now, now);
    const work = (name, state) => {
      const id = (ids[name] = createUlid());
      tx.run(
        `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, state_version, plan_revision, rules_json, related_work_ids_json, created_at, updated_at)
         VALUES (?, 'owner:default', NULL, 'W', 'x', 'normal', ?, 0, 0, ?, '[]', ?, ?)`,
        id, state, JSON.stringify({ schema_version: "1.0.0", rules: [] }), now, now,
      );
      return id;
    };
    const task = (workId, name, status, supersededAt = null) => {
      const id = (ids[name] = createUlid());
      tx.run(
        `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id, superseded_at)
         VALUES (?, ?, ?, 'code', ?, 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, ?, ?)`,
        id, workId, name, status, now, now, name, supersededAt,
      );
    };
    const running = work("running", "running");
    for (const [name, status] of [["run", "running"], ["done", "completed"], ["wait", "judgement_waiting"], ["fail", "failed"]]) task(running, name, status);
    task(running, "old", "cancelled", now);
    const cancelled = work("cancelled", "cancelled");
    task(cancelled, "cdone", "completed");
    task(cancelled, "cowner", "cancelled");
    task(cancelled, "cold", "cancelled", now);
    // A pre-migration superseded Task is found from its event by the backfill.
    task(running, "legacy", "cancelled");
    // A cancel-operation Task from before the migration has no event; it is cancelled in a Work that is not.
    task(running, "legacyCancel", "cancelled");
    sequence += 1;
    tx.run(
      `INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, agent_run_id, payload_json, status, attempt_no, created_at)
       VALUES (?, ?, 'k:1', 'task.superseded', ?, NULL, NULL, ?, 'handled', 0, ?)`,
      createUlid(), sequence, running, JSON.stringify({ task_ids: [ids.legacy] }), now,
    );
    return null;
  });
  const backfill = (await readFile(join(migrationsDir, "046_task_superseded_at.sql"), "utf8")).split("\nUPDATE").pop();
  await db.createWriteLane().transact((tx) => { tx.run(`UPDATE${backfill}`); return null; });

  const listed = (workId) => core.listTasks(workId, {}).data.map((item) => item.id).sort();
  assert.deepEqual(listed(ids.running), [ids.run, ids.done, ids.wait, ids.fail].sort());
  assert.deepEqual(listed(ids.cancelled), [ids.cdone, ids.cowner].sort());
  const progress = (workId) => core.getWork(workId).data.progress;
  assert.deepEqual([progress(ids.running).total_tasks, progress(ids.running).completed_tasks], [4, 1]);
  assert.deepEqual([progress(ids.cancelled).total_tasks, progress(ids.cancelled).completed_tasks], [2, 1]);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM tasks").n, 10);
});

test("a replan cancel followed at once by an Owner cancel hides only the replan's Task", async (t) => {
  const { db, core } = await createTestCore(t, {}, { prefix: "owl-superseded-flow-" });
  const now = new Date().toISOString();
  const workId = createUlid();
  const ids = { replanned: createUlid(), owner: createUlid(), done: createUlid() };
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default','owner:default',?,?)", now, now);
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, state_version, plan_revision, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:default', NULL, 'W', 'x', 'normal', 'running', 0, 0, ?, '[]', ?, ?)`,
      workId, JSON.stringify({ schema_version: "1.0.0", rules: [] }), now, now,
    );
    for (const [name, status] of [["replanned", "running"], ["owner", "ready"], ["done", "completed"]]) {
      tx.run(
        `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
         VALUES (?, ?, ?, 'code', ?, 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, ?)`,
        ids[name], workId, name, status, now, now, name,
      );
    }
    return null;
  });

  // Core's replan application: the Manager's cancel action stops the running Task.
  const plan = {
    newItems: [], reopenIds: [], supersessions: new Map(), revisions: new Map(),
    actions: new Map([[ids.replanned, { action: "cancel", task_id: ids.replanned, reason: "no longer needed" }]]),
  };
  const guard = { base_plan_revision: 0, root_statuses: new Map([[ids.replanned, "running"]]), owner_replan: false };
  await core.workflow.applyReplan(workId, plan, guard, "Manager replan: test");
  // The Owner cancels the Work right after.
  const version = db.get("SELECT state_version AS v FROM works WHERE id = ?", workId).v;
  await core.cancelWork(workId, {
    request_id: createUlid(), idempotency_key: `test:cancel:${createUlid()}`, expected_version: version, payload: { reason: "stop" },
  });

  const status = (id) => db.get("SELECT status, superseded_at FROM tasks WHERE id = ?", id);
  assert.equal(status(ids.replanned).status, "cancelled");
  assert.ok(status(ids.replanned).superseded_at);
  assert.equal(status(ids.owner).status, "cancelled");
  assert.equal(status(ids.owner).superseded_at, null);
  const listed = core.listTasks(workId, {}).data.map((item) => item.id).sort();
  assert.deepEqual(listed, [ids.owner, ids.done].sort());
  const progress = core.getWork(workId).data.progress;
  assert.deepEqual([progress.total_tasks, progress.completed_tasks], [2, 1]);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM tasks WHERE work_id = ?", workId).n, 3);
  assert.ok(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'task.superseded'", workId).n >= 1);
  // The hidden Task is still readable by id (Decision references use it).
  assert.equal(core.getTask(ids.replanned).data.id, ids.replanned);
});

test("web getDecision returns a blocked Task the Work's Task list no longer shows", async (t) => {
  const modulePath = join(repoRoot, "apps/web/lib/api-client.ts");
  const { outputText } = ts.transpileModule(readFileSync(modulePath, "utf8"), {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const overrides = {
    "@/lib/format": { runOrdinals: () => new Map() },
    "./backlog-link.mjs": await import("../../apps/web/lib/backlog-link.mjs"),
    "@/lib/work-detail-safety.mjs": await import("../../apps/web/lib/work-detail-safety.mjs"),
  };
  const loaded = new Module(modulePath);
  loaded.filename = modulePath;
  loaded.paths = Module._nodeModulePaths(dirname(modulePath));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    return Object.hasOwn(overrides, request) ? overrides[request] : originalLoad.call(this, request, parent, isMain);
  };
  try { loaded._compile(outputText, modulePath); } finally { Module._load = originalLoad; }

  const { db, core } = await createTestCore(t, {}, { prefix: "owl-superseded-decision-" });
  const now = new Date().toISOString();
  const workId = createUlid();
  const supersededTaskId = createUlid();
  const decisionId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default','owner:default',?,?)", now, now);
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, state_version, plan_revision, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:default', NULL, 'W', 'x', 'normal', 'running', 0, 0, ?, '[]', ?, ?)`,
      workId, JSON.stringify({ schema_version: "1.0.0", rules: [] }), now, now,
    );
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id, superseded_at)
       VALUES (?, ?, 'old', 'code', 'judgement_waiting', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'old', ?)`,
      supersededTaskId, workId, now, now, now,
    );
    tx.run(
      `INSERT INTO decisions (id, work_id, scope, status, blocked_task_ids_json, reason, tried, current_state, options_json, recommended, allow_free_text, issuer_role, state_version, created_at)
       VALUES (?, ?, 'task', 'open', ?, 'stuck', 'Core', 'judgement_waiting', '[]', NULL, 1, 'core', 0, ?)`,
      decisionId, workId, JSON.stringify([supersededTaskId]), now,
    );
    return null;
  });
  assert.deepEqual(core.listTasks(workId, {}).data, []);
  const coreView = core.getDecisionView(decisionId);
  assert.deepEqual(coreView.blocked_tasks.map((task) => task.id), [supersededTaskId]);

  const requested = [];
  const originalFetch = globalThis.fetch;
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), "http://x");
    requested.push(parsed.pathname);
    if (parsed.pathname.endsWith("runtime-config.json")) return json({ base_path: "/owl/", api_base: "/api/v1", ws_url: "/ws", schema_version: "1.0.0" });
    if (parsed.pathname === `/api/v1/decisions/${decisionId}/view`) return json({ data: JSON.parse(JSON.stringify(coreView)), version: 1 });
    return new Response("{}", { status: 404 });
  };
  try {
    const view = await loaded.exports.getDecision(decisionId);
    assert.equal(view.decision.id, decisionId);
    assert.deepEqual(view.blocked_tasks.map((task) => task.id), [supersededTaskId]);
    assert.ok(!requested.includes(`/api/v1/works/${workId}/tasks`));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
