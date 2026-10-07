import assert from "node:assert/strict";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid, openDatabase } from "../../packages/db/dist/index.js";
import { command as envelope, createTestCore } from "../helpers/core.mjs";
import { migrationsDir } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

const command = (payload, suffix, expectedVersion = 0) => envelope(payload, `archive-test:${suffix}`, expectedVersion);

async function setup(t) {
  return createTestCore(t, { version: "work-archive-test", dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-work-archive-" });
}

async function createCompletedWork(core, db, title = "Archive me") {
  const created = await core.createWork(command({ title, summary: "", size: "small", project_id: null }, `create:${title}`));
  const id = created.data.work_id;
  const old = "2020-01-01T00:00:00.000Z";
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = 'completed', state_version = 1, completed_at = ?, updated_at = ? WHERE id = ?", old, old, id);
  });
  return id;
}

async function createCancelledWork(core, db) {
  const created = await core.createWork(command({ title: "Cancelled", summary: "", size: "small", project_id: null }, "create-cancelled"));
  const id = created.data.work_id;
  const now = "2020-01-01T00:00:00.000Z";
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = 'cancelled', state_version = 1, cancelled_at = ?, updated_at = ? WHERE id = ?", now, now, id);
  });
  return id;
}

function workEvents(db, workId) {
  return db.all("SELECT type FROM events WHERE work_id = ? ORDER BY sequence", workId).map((row) => row.type);
}

test("migration 014 adds nullable archive metadata and its list index to an existing database", async (t) => {
  const root = await tempDir(t, "owl-work-archive-migration-");
  const db = openDatabase(join(root, "owl.db")); // helpers-exempt: migrates in two steps (prior migrations first)
  const priorMigrations = join(root, "prior-migrations");
  await mkdir(priorMigrations);
  const migrations = await readdir(migrationsDir);
  for (const filename of migrations.filter((filename) => Number(filename.slice(0, 3)) <= 13)) {
    await copyFile(join(migrationsDir, filename), join(priorMigrations, filename));
  }
  t.after(() => db.close());

  db.migrate(priorMigrations);
  const now = "2026-09-25T00:00:00.000Z";
  const ownerId = createUlid();
  const workId = createUlid();
  await db.createWriteLane().transact((transaction) => {
    transaction.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, 'Owner', ?, ?)", ownerId, now, now);
    transaction.run(
      `INSERT INTO works
         (id, owner_id, title, summary, size, state, state_version, plan_revision, rules_json, related_work_ids_json, created_at, updated_at, completed_at)
       VALUES (?, ?, 'Existing', '', 'small', 'completed', 2, 0, '{"schema_version":"1.0.0","rules":[]}', '[]', ?, ?, ?)`,
      workId, ownerId, now, now, now,
    );
  });

  db.migrate(migrationsDir);
  assert.deepEqual(db.get("SELECT archived_at FROM works WHERE id = ?", workId), { archived_at: null });
  assert.equal(db.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'works_archived_at_id'")?.name, "works_archived_at_id");
});

test("archiving a Work filters the list, no-ops when repeated, and reopening an archived completed Work unarchives it first", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createCompletedWork(core, db);
  const cancelledWorkId = await createCancelledWork(core, db);
  const allWorkIds = [workId, cancelledWorkId].sort();
  const before = core.getWork(workId).data;
  const archived = await core.archiveWork(workId, command({}, "archive", before.state_version));
  assert.equal(archived.version, before.state_version);
  assert.match(archived.data.archived_at, /^\d{4}-\d\d-\d\dT.*Z$/u);
  const completionDates = db.get("SELECT completed_at, cancelled_at FROM works WHERE id = ?", workId);
  assert.deepEqual(completionDates, { completed_at: before.updated_at, cancelled_at: null });
  assert.equal(core.getWork(workId).data.archived_at, archived.data.archived_at);
  assert.notEqual(core.getWork(workId).data.updated_at, before.updated_at);
  assert.equal(core.getWork(workId).data.state_version, before.state_version);
  assert.deepEqual(core.listWorks().data.map((work) => work.id), [cancelledWorkId]);
  assert.deepEqual(core.listWorks({ archived: "only" }).data.map((work) => work.id), [workId]);
  assert.deepEqual(core.listWorks({ archived: "include" }).data.map((work) => work.id), allWorkIds);

  await core.archiveWork(cancelledWorkId, command({}, "archive-cancelled", 1));
  assert.equal(core.getWork(cancelledWorkId).data.state, "cancelled");
  assert.deepEqual(core.listWorks().data.map((work) => work.id), []);
  assert.deepEqual(core.listWorks({ archived: "only" }).data.map((work) => work.id), allWorkIds);
  assert.deepEqual(core.listWorks({ archived: "include" }).data.map((work) => work.id), allWorkIds);
  await core.unarchiveWork(cancelledWorkId, command({}, "unarchive-cancelled", 1));
  assert.equal(core.getWork(cancelledWorkId).data.state, "cancelled");
  assert.deepEqual(core.listWorks().data.map((work) => work.id), [cancelledWorkId]);
  assert.deepEqual(core.listWorks({ archived: "only" }).data.map((work) => work.id), [workId]);

  const archivedEvents = workEvents(db, workId);
  const archiveTime = archived.data.archived_at;
  const updatedAt = core.getWork(workId).data.updated_at;
  await core.archiveWork(workId, command({}, "archive-noop", before.state_version));
  assert.deepEqual(workEvents(db, workId), archivedEvents);
  assert.equal(core.getWork(workId).data.archived_at, archiveTime);
  assert.equal(core.getWork(workId).data.updated_at, updatedAt);

  await core.unarchiveWork(workId, command({}, "unarchive", before.state_version));
  assert.equal(core.getWork(workId).data.archived_at, null);
  const unarchivedEvents = workEvents(db, workId);
  await core.unarchiveWork(workId, command({}, "unarchive-noop", before.state_version));
  assert.deepEqual(workEvents(db, workId), unarchivedEvents);
  assert.deepEqual(core.listWorks().data.map((work) => work.id), allWorkIds);

  await core.archiveWork(workId, command({}, "archive-before-reopen", before.state_version));
  const reopenEventStart = workEvents(db, workId).length;
  const reopened = await core.reopenWork(workId, command({ reason: "Continue" }, "reopen", before.state_version));
  assert.equal(reopened.data.state, "running");
  assert.equal(reopened.version, before.state_version + 1);
  assert.equal(core.getWork(workId).data.archived_at, null);
  assert.deepEqual(workEvents(db, workId).slice(reopenEventStart), ["work.unarchived", "work.reopened"]);
  assert.deepEqual(core.listWorks().data.map((work) => work.id), allWorkIds);
});

test("archive and unarchive reject non-terminal Works", async (t) => {
  const { core } = await setup(t);
  const created = await core.createWork(command({ title: "Not terminal", summary: "", size: "small", project_id: null }, "nonterminal"));
  await assert.rejects(
    core.archiveWork(created.data.work_id, command({}, "archive-running")),
    (error) => error.code === "invalid_state_transition" && error.details.state === "memo",
  );
  await assert.rejects(
    core.unarchiveWork(created.data.work_id, command({}, "unarchive-running")),
    (error) => error.code === "invalid_state_transition" && error.details.state === "memo",
  );
});

test("archive rejects active Agents and open Decisions", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createCompletedWork(core, db, "Blocked archive");
  const now = new Date().toISOString();
  const agentRunId = createUlid();
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO agent_runs (id, work_id, role, provider, model, status, created_at, updated_at)
       VALUES (?, ?, 'manager', 'test', 'test', 'running', ?, ?)`,
      agentRunId, workId, now, now,
    );
  });
  await assert.rejects(
    core.archiveWork(workId, command({}, "active-agent", 1)),
    (error) => error.code === "work_has_active_agents",
  );

  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE agent_runs SET status = 'completed', ended_at = ? WHERE id = ?", now, agentRunId);
    transaction.run(
      `INSERT INTO decisions
         (id, work_id, scope, status, blocked_task_ids_json, reason, question, tried, current_state,
          options_json, allow_free_text, issuer_role, created_at)
       VALUES (?, ?, 'work', 'open', '[]', 'Reason', 'Question?', 'Tried', 'Stopped', '[]', 1, 'core', ?)`,
      createUlid(), workId, now,
    );
  });
  await assert.rejects(
    core.archiveWork(workId, command({}, "open-decision", 1)),
    (error) => error.code === "work_has_open_decisions",
  );
  assert.equal(core.getWork(workId).data.archived_at, null);
});
