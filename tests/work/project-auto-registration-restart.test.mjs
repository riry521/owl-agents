import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { createAutoRegistrationCore, eventTypes, gitIn, makeRepository, plannedTask, tempFolder } from "../helpers/auto-registration.mjs";
import { command } from "../helpers/core.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { waitFor } from "../helpers/wait.mjs";

const digestOf = (path) => createHash("sha256").update(path).digest("hex");

/**
 * Builds the state an earlier Core left behind: a Project-less running Work with a completed Task and a ready Task,
 * plus the auto-registration events and Projects of `stage`. Core 1 is stopped before Core 2 starts on the same DB.
 */
async function interruptedCore(t, { candidates = 1, stage }) {
  const root = await tempFolder(t, "owl-auto-registration-restart-", { removeOnExit: false });
  const repositories = [];
  for (let index = 0; index < candidates; index += 1) {
    const path = join(root, `repository-${index}`);
    await makeRepository(path);
    repositories.push(realpathSync(path));
  }
  const db = createTestDatabase(root);
  const laterWorktrees = [];
  const first = await createAutoRegistrationCore(t, {
    tasks: [],
    coreOptions: { db, owlRoot: root },
    workers: {},
    start: false,
  });
  const created = await first.core.createWork(command({ title: "restart", summary: "x", size: "normal", project_id: null }, "restart-work"));
  const workId = created.data.work_id;
  const creatorTask = createUlid();
  const laterTask = createUlid();
  const now = new Date().toISOString();
  const insertEvent = (tx, type, key, payload, taskId = null) => {
    const sequence = tx.get("SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM events").n;
    const id = createUlid();
    tx.run(`INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, payload_json, status, attempt_no, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'handled', 0, ?)`, id, sequence, key, type, workId, taskId,
    JSON.stringify({ kind: type.replace(/\./gu, "_"), schema_version: "1.0.0", work_id: workId, ...payload }), now);
    return id;
  };
  const projectFor = async (path) => (await first.core.createProject(command({
    name: path.split("/").pop(),
    canonical_path: path,
    base_branch: "main",
    allowed_roots: [path],
    verification_plan: [],
  }, `auto-project:${workId}:${digestOf(path)}`))).data;

  const registered = [];
  // A Project created through the same request the product uses, so its stored response can be reused.
  const registerThrough = stage.registeredThrough ?? 0;
  for (let index = 0; index < registerThrough; index += 1) registered.push(await projectFor(repositories[index]));
  let detectionId;
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    insertEvent(tx, "work.started", `restart-started:${workId}`, {});
    tx.run(`INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
      VALUES (?, ?, 'creator', 'research', 'completed', 'normal', '', '', ?, ?)`, creatorTask, workId, now, now);
    tx.run(`INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
      VALUES (?, ?, 'later task', 'research', 'ready', 'normal', '', '', ?, ?)`, laterTask, workId, now, now);
    detectionId = insertEvent(tx, "work.new_repositories_detected", `new-repositories-detected:${creatorTask}`, {
      task_id: creatorTask,
      candidates: repositories.map((path) => ({ canonical_path: path, base_branch: "main", name: path.split("/").pop() })),
      skipped: [],
    }, creatorTask);
    for (const [index, project] of registered.entries()) {
      if (stage.recordRegistered === false) break;
      insertEvent(tx, "work.project_auto_registered", `project-auto-registered:${detectionId}:${digestOf(repositories[index])}`, {
        task_id: creatorTask, detection_event_id: detectionId, project_id: project.id, canonical_path: repositories[index], base_branch: "main",
      }, creatorTask);
    }
    if (stage.requested) {
      insertEvent(tx, "work.project_auto_attach_requested", `project-auto-attach-requested:${detectionId}`, { detection_event_id: detectionId, project_id: registered[0].id });
    }
    if (stage.skipped) {
      insertEvent(tx, "work.project_auto_attach_skipped", `project-auto-attach-skipped:${detectionId}`, { detection_event_id: detectionId, reason: "attach_failed" });
    }
    return null;
  });
  const projectCreatedBefore = db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'project.created'").count;
  await first.core.stop({ force: true });

  const second = await createAutoRegistrationCore(t, {
    tasks: [],
    coreOptions: { db, owlRoot: root },
    workers: {
      "later task": async (request) => {
        // Read while the worktree exists: it is removed when the Work completes.
        const gitDir = (args) => { try { return gitIn(request.context.worktree, args); } catch { return null; } };
        laterWorktrees.push({ gitDir: gitDir(["rev-parse", "--git-dir"]), commonDir: gitDir(["rev-parse", "--git-common-dir"]) });
        return [];
      },
    },
  });
  // Cleanup order: the Cores stop first, then the DB closes and the folder is removed.
  // Project overview and learning jobs may still be writing under the root when the Cores have stopped, so the removal retries.
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const completed = () => waitFor(
    () => (db.get("SELECT state FROM works WHERE id = ?", workId).state === "completed" ? true : null),
    { timeoutMs: 20_000, intervalMs: 25, message: `Work ${workId} completed after the restart` },
  );
  return { db, workId, repositories, registered, detectionId, projectCreatedBefore, laterWorktrees, completed, state: second.state };
}

const projectCreatedCount = (db) => db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'project.created'").count;
const countOf = (db, workId, type) => db.get("SELECT COUNT(*) AS count FROM events WHERE work_id = ? AND type = ?", workId, type).count;

test("an interruption between two registrations finishes both and attaches neither", async (t) => {
  const run = await interruptedCore(t, { candidates: 2, stage: { registeredThrough: 1 } });
  await run.completed();
  const { db, workId } = run;
  assert.equal(db.get("SELECT COUNT(*) AS count FROM projects").count, 2, "both candidates are registered");
  assert.equal(projectCreatedCount(db), 2, "the first registration is not repeated");
  assert.equal(countOf(db, workId, "work.project_auto_registered"), 2);
  assert.equal(db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, null);
  assert.equal(countOf(db, workId, "work.project_attached"), 0);
  assert.equal(countOf(db, workId, "work.project_auto_attach_requested"), 0);
  const skipped = db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.project_auto_attach_skipped'", workId).map((row) => JSON.parse(row.payload_json));
  assert.deepEqual(skipped.map((payload) => payload.reason), ["multiple_repositories"]);
  assert.equal(run.laterWorktrees.length, 1, "the Task still runs");
  assert.equal(run.laterWorktrees[0].gitDir, null, "it runs in the isolated folder, not a Project worktree");
});

test("a registered Project whose registration event was lost is reused and attached after the restart", async (t) => {
  // The Project exists (its createProject response is stored) but work.project_auto_registered was never recorded.
  const run = await interruptedCore(t, { stage: { registeredThrough: 1, recordRegistered: false } });
  await run.completed();
  const { db, workId } = run;
  const [project] = run.registered;
  assert.equal(projectCreatedCount(db), run.projectCreatedBefore, "createProject is not called again");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM projects").count, 1);
  assert.equal(db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, project.id);
  const [registered] = db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.project_auto_registered'", workId).map((row) => JSON.parse(row.payload_json));
  assert.equal(registered.project_id, project.id);
  const types = eventTypes(db, workId);
  assert.ok(types.indexOf("work.project_auto_attach_requested") < types.indexOf("work.project_attached"));
  assert.equal(countOf(db, workId, "work.project_attached"), 1);
  assert.equal(run.laterWorktrees.length, 1);
  assert.notEqual(run.laterWorktrees[0].gitDir, run.laterWorktrees[0].commonDir, "the Task runs in a Git worktree of the Project");
});

test("a registered single candidate gets its attach request and attach after the restart", async (t) => {
  const run = await interruptedCore(t, { stage: { registeredThrough: 1 } });
  await run.completed();
  const { db, workId } = run;
  assert.equal(db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, run.registered[0].id);
  assert.equal(countOf(db, workId, "work.project_auto_attach_requested"), 1);
  assert.equal(countOf(db, workId, "work.project_attached"), 1);
  assert.equal(projectCreatedCount(db), run.projectCreatedBefore);
  assert.notEqual(run.laterWorktrees[0].gitDir, run.laterWorktrees[0].commonDir);
});

test("an attach that was requested but not done is performed after the restart", async (t) => {
  const run = await interruptedCore(t, { stage: { registeredThrough: 1, requested: true } });
  await run.completed();
  const { db, workId } = run;
  assert.equal(db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, run.registered[0].id);
  assert.equal(countOf(db, workId, "work.project_auto_attach_requested"), 1, "the request is not recorded twice");
  assert.equal(countOf(db, workId, "work.project_attached"), 1);
  assert.equal(projectCreatedCount(db), run.projectCreatedBefore);
  assert.notEqual(run.laterWorktrees[0].gitDir, run.laterWorktrees[0].commonDir);
});

test("a detection that was skipped is not resumed after the restart", async (t) => {
  const run = await interruptedCore(t, { stage: { registeredThrough: 1, requested: true, skipped: true } });
  await run.completed();
  const { db, workId } = run;
  assert.equal(db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, null);
  assert.equal(countOf(db, workId, "work.project_attached"), 0);
  assert.equal(countOf(db, workId, "work.project_auto_attach_skipped"), 1);
  assert.equal(run.laterWorktrees.length, 1);
  assert.equal(run.laterWorktrees[0].gitDir, null, "the Task runs in the isolated folder");
});
