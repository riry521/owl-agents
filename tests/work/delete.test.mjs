import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { SkillBox } from "../../packages/core/dist/skill-box.js";
import { SkillCurator } from "../../packages/core/dist/skill-curator.js";
import { renderSkillMd } from "../../packages/core/dist/skill-files.js";
import { command as envelope, createTestCore } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";
import { tempDir } from "../helpers/temp.mjs";

const command = (payload, suffix, expectedVersion = 0) => envelope(payload, `delete-test:${suffix}`, expectedVersion);

async function setup(t) {
  return createTestCore(t, { version: "work-delete-test", dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-work-delete-" });
}

async function createArchivedWork(core, db, projectId = null, title = "Delete me") {
  const created = await core.createWork(command({ title, summary: "", size: "small", project_id: projectId }, `create:${title}`));
  const id = created.data.work_id;
  const now = "2026-09-25T00:00:00.000Z";
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = 'completed', state_version = 1, completed_at = ?, updated_at = ? WHERE id = ?", now, now, id);
  });
  await core.archiveWork(id, command({}, `archive:${title}`, 1));
  return id;
}

function hasBranch(repository, branch) {
  try {
    git(repository, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

test("deleteWork removes FK-linked execution rows in one transaction and removes conversations and artifacts", async (t) => {
  const { root, db, core } = await setup(t);
  const workId = await createArchivedWork(core, db);
  const outside = await core.createWork(command({ title: "Unrelated", summary: "", size: "small", project_id: null }, "unrelated"));
  const externalWorkId = outside.data.work_id;
  const ids = {
    taskA: createUlid(), taskB: createUlid(),
    run: createUlid(), report: createUlid(),
    decision: createUlid(), answer: createUlid(), conversation: createUlid(),
    account: createUlid(), event: createUlid(), delivery: createUlid(),
    artifact: createUlid(), activity: createUlid(), receipt: createUlid(),
    upload: createUlid(), secret: createUlid(), audit: createUlid(),
  };
  const now = new Date().toISOString();
  const ownerId = db.get("SELECT owner_id FROM works WHERE id = ?", workId).owner_id;
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET related_work_ids_json = ? WHERE id = ?", JSON.stringify([workId]), externalWorkId);
    transaction.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, ?, 'A', 'code', 'completed', 'normal', '', '', ?, ?),
              (?, ?, 'B', 'doc', 'completed', 'normal', '', '', ?, ?)`,
      ids.taskA, workId, now, now, ids.taskB, workId, now, now,
    );
    transaction.run("UPDATE tasks SET parent_task_id = ? WHERE id = ?", ids.taskA, ids.taskB);
    transaction.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)", ids.taskA, ids.taskB);
    transaction.run(
      `INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at)
       VALUES (?, ?, 0, 'pass', '[]', '{}', ?)`,
      createUlid(), ids.taskA, now,
    );
    transaction.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
       VALUES (?, ?, ?, 'worker', 'test', 'test', 'completed', ?, ?)`,
      ids.run, workId, ids.taskA, now, now,
    );
    transaction.run(
      `INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at)
       VALUES (?, ?, '1.0.0', 'success', '{}', ?, 0, ?)`,
      ids.report, ids.run, "a".repeat(64), now,
    );
    transaction.run("UPDATE agent_runs SET report_id = ? WHERE id = ?", ids.report, ids.run);
    transaction.run(
      `INSERT INTO decisions (id, work_id, scope, status, blocked_task_ids_json, reason, question, tried, current_state,
                              options_json, allow_free_text, issuer_role, created_at)
       VALUES (?, ?, 'work', 'resolved', '[]', 'Reason', 'Question?', 'Tried', 'Stopped', '[]', 1, 'core', ?)`,
      ids.decision, workId, now,
    );
    transaction.run(
      `INSERT INTO decision_answers (id, decision_id, answerer_id, answer_json, source, received_at)
       VALUES (?, ?, ?, '{}', 'web', ?)`,
      ids.answer, ids.decision, ownerId, now,
    );
    transaction.run(
      `INSERT INTO conversations (id, owner_id, work_id, channel, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'web', 1, ?, ?)`,
      ids.conversation, ownerId, workId, now, now,
    );
    transaction.run(
      `INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at)
       VALUES (?, ?, 'web', ?, ?)`,
      ids.account, ownerId, `web:${ids.account}`, now,
    );
    const sequence = transaction.get("SELECT coalesce(max(sequence), 0) + 1 AS sequence FROM events").sequence;
    transaction.run(
      `INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, agent_run_id, payload_json, status, created_at)
       VALUES (?, ?, ?, 'task.completed', ?, ?, ?, '{}', 'handled', ?)`,
      ids.event, sequence, `test-delete-event:${ids.event}`, workId, ids.taskA, ids.run, now,
    );
    transaction.run(
      `INSERT INTO outbox_deliveries (id, event_id, provider, provider_message_key, status)
       VALUES (?, ?, 'websocket', ?, 'pending')`,
      ids.delivery, ids.event, ids.event,
    );
    transaction.run(
      `INSERT INTO artifacts (id, work_id, task_id, path, kind, deliverable, sha256, bytes, mime, source_event_id, version_no, created_at)
       VALUES (?, ?, ?, 'result.txt', 'generated', 1, ?, 1, 'text/plain', ?, 1, ?)`,
      ids.artifact, workId, ids.taskA, "b".repeat(64), ids.event, now,
    );
    transaction.run(
      `INSERT INTO agent_activity (id, agent_run_id, work_id, task_id, kind, summary, source_event_id, created_at)
       VALUES (?, ?, ?, ?, 'status', 'done', ?, ?)`,
      ids.activity, ids.run, workId, ids.taskA, ids.event, now,
    );
    transaction.run(
      `INSERT INTO inbound_receipts (id, provider, account_id, external_message_id, request_id, idempotency_key, request_hash,
                                     ack_id, status, event_id, created_at)
       VALUES (?, 'web', ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`,
      ids.receipt, ids.account, `external:${ids.receipt}`, `req:${ids.receipt}`, `key:${ids.receipt}`, "c".repeat(64), ids.receipt, ids.event, now,
    );
    transaction.run(
      `INSERT INTO inbound_uploads (id, provider, account_id, external_attachment_id, request_id, idempotency_key, request_hash,
                                    work_id, conversation_id, filename, declared_bytes, bytes, expires_at, status, artifact_id, created_at)
       VALUES (?, 'web', ?, ?, ?, ?, ?, ?, ?, 'upload.txt', 1, 1, ?, 'stored', ?, ?)`,
      ids.upload, ids.account, `attachment:${ids.upload}`, `req:${ids.upload}`, `key:${ids.upload}`, "d".repeat(64),
      workId, ids.conversation, now, ids.artifact, now,
    );
    transaction.run(
      `INSERT INTO secret_records (id, name, owner_id, scope_json, version_no, updated_at)
       VALUES (?, ?, ?, '{}', 1, ?)`,
      ids.secret, `secret:${ids.secret}`, ownerId, now,
    );
    transaction.run(
      `INSERT INTO secret_audit (id, secret_id, agent_run_id, operation, result, correlation_id, created_at)
       VALUES (?, ?, ?, 'use', 'allowed', ?, ?)`,
      ids.audit, ids.secret, ids.run, ids.audit, now,
    );
    transaction.run(
      `INSERT INTO idempotency_keys (key, request_hash, response_json, status_code, created_at, expires_at)
       VALUES (?, ?, ?, 200, ?, ?)`,
      `old-work-cache:${workId}`, "e".repeat(64), JSON.stringify({ work_id: workId }), now, "2099-01-01T00:00:00.000Z",
    );
  });

  const workspace = join(root, ".owl-workspaces", workId);
  await mkdir(join(workspace, ids.taskA), { recursive: true });
  await writeFile(join(workspace, ids.taskA, "result.txt"), "preserved output\n");
  await writeFile(join(workspace, "root-note.txt"), "also preserved\n");

  const request = command({}, "successful-delete", 1);
  const deleted = await core.deleteWork(workId, request);
  assert.deepEqual(deleted.data, { work_id: workId, deleted: true });
  assert.equal(db.get("SELECT id FROM works WHERE id = ?", workId), undefined);
  assert.equal(db.get("SELECT id FROM tasks WHERE id IN (?, ?)", ids.taskA, ids.taskB), undefined);
  assert.equal(db.get("SELECT id FROM agent_runs WHERE id = ?", ids.run), undefined);
  assert.equal(db.get("SELECT id FROM decisions WHERE id = ?", ids.decision), undefined);
  assert.equal(db.get("SELECT id FROM events WHERE id = ?", ids.event), undefined);
  assert.equal(db.get("SELECT id FROM outbox_deliveries WHERE id = ?", ids.delivery), undefined);
  assert.equal(db.get("SELECT id FROM decision_answers WHERE id = ?", ids.answer), undefined);
  assert.equal(db.get("SELECT id FROM conversations WHERE id = ?", ids.conversation), undefined);
  assert.equal(db.get("SELECT id FROM artifacts WHERE id = ?", ids.artifact), undefined);
  assert.equal(db.get("SELECT id FROM inbound_uploads WHERE id = ?", ids.upload), undefined);
  assert.equal(db.get("SELECT event_id FROM inbound_receipts WHERE id = ?", ids.receipt).event_id, null);
  assert.equal(db.get("SELECT agent_run_id FROM secret_audit WHERE id = ?", ids.audit).agent_run_id, null);
  assert.deepEqual(JSON.parse(db.get("SELECT related_work_ids_json FROM works WHERE id = ?", externalWorkId).related_work_ids_json), []);
  assert.equal(db.get("SELECT key FROM idempotency_keys WHERE key = ?", `old-work-cache:${workId}`), undefined);
  assert.equal(db.get("SELECT key FROM idempotency_keys WHERE key = ?", `work.delete:${workId}:-:-:-:${request.idempotency_key}`), undefined);
  assert.equal(db.all("PRAGMA foreign_key_check").length, 0);
  await assert.rejects(access(workspace));
  await assert.rejects(core.deleteWork(workId, request), (error) => error.code === "work_not_found");
});

test("archiving keeps external design documents and deleting the Work removes them", async (t) => {
  const { root, db, core } = await setup(t);
  const created = await core.createWork(command({ title: "Design document cleanup", summary: "", size: "small", project_id: null }, "create:design-cleanup"));
  const workId = created.data.work_id;
  const otherWorkId = await createArchivedWork(core, db, null, "Other design documents");
  const designDirectory = join(root, "data", "designs", workId);
  const otherDirectory = join(root, "data", "designs", otherWorkId);
  await mkdir(designDirectory, { recursive: true });
  await mkdir(otherDirectory, { recursive: true });
  await writeFile(join(designDirectory, "task.md"), "# Design\n");
  await writeFile(join(otherDirectory, "task.md"), "# Other design\n");
  const reportDirectory = join(root, "data", "task-reports", workId);
  const otherReportDirectory = join(root, "data", "task-reports", otherWorkId);
  await mkdir(reportDirectory, { recursive: true });
  await mkdir(otherReportDirectory, { recursive: true });
  await writeFile(join(reportDirectory, "task.json"), "{}");
  await writeFile(join(otherReportDirectory, "task.json"), "{}");
  const now = "2026-09-25T00:00:00.000Z";
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = 'completed', state_version = 1, completed_at = ?, updated_at = ? WHERE id = ?", now, now, workId);
  });
  await core.archiveWork(workId, command({}, "archive:design-cleanup", 1));
  assert.equal(await readFile(join(designDirectory, "task.md"), "utf8"), "# Design\n", "archiving keeps the documents");

  const stateVersion = db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;
  await core.deleteWork(workId, command({}, "delete-design-documents", stateVersion));
  await assert.rejects(access(designDirectory));
  await assert.rejects(access(reportDirectory), "the Work's full task reports go too");
  await access(otherReportDirectory);
  assert.equal(await readFile(join(otherDirectory, "task.md"), "utf8"), "# Other design\n", "another Work's documents stay");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'system.alert' AND json_extract(payload_json, '$.kind') = 'design_documents_orphaned'").count, 0);
});

test("design documents that cannot be removed after a Work delete raise an alert", async (t) => {
  const { root, db, core } = await setup(t);
  const workId = await createArchivedWork(core, db, null, "Locked design documents");
  const designsRoot = join(root, "data", "designs");
  const designDirectory = join(designsRoot, workId);
  await mkdir(designDirectory, { recursive: true });
  await writeFile(join(designDirectory, "task.md"), "# Design\n");
  await chmod(designsRoot, 0o555);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  let result;
  try {
    const stateVersion = db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;
    result = await core.deleteWork(workId, command({}, "delete-locked-design-documents", stateVersion));
  } finally {
    console.warn = originalWarn;
    await chmod(designsRoot, 0o755);
  }

  assert.equal(result.data.deleted, true);
  await access(join(designDirectory, "task.md"));
  const alerts = db.all("SELECT work_id, payload_json FROM events WHERE type = 'system.alert' AND json_extract(payload_json, '$.kind') = 'design_documents_orphaned'");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].work_id, null);
  const payload = JSON.parse(alerts[0].payload_json);
  assert.equal(payload.work_id, workId);
  assert.equal(payload.path, designDirectory);
});

test("deleteWork rejects non-terminal and missing Works before touching their workspace", async (t) => {
  const { root, db, core } = await setup(t);
  const created = await core.createWork(command({ title: "Running", summary: "", size: "small", project_id: null }, "running"));
  const path = join(root, ".owl-workspaces", created.data.work_id, "keep");
  await mkdir(path, { recursive: true });
  await assert.rejects(core.deleteWork(created.data.work_id, command({}, "delete-running")), (error) =>
    error.code === "invalid_state_transition" && error.details.state === "memo",
  );
  await access(path);

  await assert.rejects(core.deleteWork(createUlid(), command({}, "delete-missing")), (error) => error.code === "work_not_found");
});

test("deleteWork accepts an archived cancelled Work", async (t) => {
  const { db, core } = await setup(t);
  const created = await core.createWork(command({ title: "Cancelled delete", summary: "", size: "small", project_id: null }, "cancelled-delete"));
  const workId = created.data.work_id;
  const now = "2026-09-25T00:00:00.000Z";
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = 'cancelled', state_version = 1, cancelled_at = ?, updated_at = ? WHERE id = ?", now, now, workId);
  });
  await core.archiveWork(workId, command({}, "archive-cancelled-delete", 1));

  const deleted = await core.deleteWork(workId, command({}, "delete-cancelled", 1));
  assert.deepEqual(deleted.data, { work_id: workId, deleted: true });
  assert.equal(db.get("SELECT id FROM works WHERE id = ?", workId), undefined);
  assert.equal(db.all("PRAGMA foreign_key_check").length, 0);
});

test("deleteWork rolls back every related DB change when the final Work delete fails", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createArchivedWork(core, db, null, "Rollback delete");
  const taskId = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, ?, 'Task', 'code', 'completed', 'normal', '', '', ?, ?)`,
      taskId, workId, now, now,
    );
    transaction.run(
      `INSERT INTO idempotency_keys (key, request_hash, response_json, status_code, created_at, expires_at)
       VALUES (?, ?, '{}', 200, ?, ?)`,
      `old-task-cache:${taskId}`, "f".repeat(64), now, "2099-01-01T00:00:00.000Z",
    );
  });
  await db.createWriteLane().transact((transaction) => transaction.run(
    `CREATE TRIGGER stop_work_delete BEFORE DELETE ON works
      WHEN OLD.id = '${workId}' BEGIN SELECT RAISE(ABORT, 'test rollback'); END`,
  ));

  const request = command({}, "rollback-delete", 1);
  await assert.rejects(core.deleteWork(workId, request), (error) =>
    error.code === "core_write_failed" || error.code === "SQLITE_CONSTRAINT_TRIGGER",
  );
  assert.ok(db.get("SELECT id FROM works WHERE id = ?", workId));
  assert.ok(db.get("SELECT id FROM tasks WHERE id = ?", taskId));
  assert.ok(db.get("SELECT key FROM idempotency_keys WHERE key = ?", `old-task-cache:${taskId}`));
  assert.equal(db.get("SELECT key FROM idempotency_keys WHERE key = ?", `work.delete:${workId}:-:-:-:${request.idempotency_key}`), undefined);
  assert.equal(db.all("PRAGMA foreign_key_check").length, 0);

  await db.createWriteLane().transact((transaction) => transaction.run("DROP TRIGGER stop_work_delete"));
  assert.equal((await core.deleteWork(workId, request)).data.deleted, true);
});

test("a branch that cannot be deleted does not fail the committed Work delete", async (t) => {
  const { root, db, core } = await setup(t);
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  git(projectRoot, "init", "--initial-branch=main");
  await writeFile(join(projectRoot, "README.md"), "base\n");
  git(projectRoot, "add", ".");
  git(projectRoot, "commit", "-m", "initial");
  const project = await core.createProject(command({
    name: "Branch cleanup failure project",
    canonical_path: projectRoot,
    base_branch: "main",
    allowed_roots: [root],
    verification_plan: [],
  }, "create-branch-failure-project"));
  const workId = await createArchivedWork(core, db, project.data.id, "Busy branch");
  const task = await core.git.prepareWorktree({ work_id: workId, task_id: createUlid() });
  assert.equal(task.ok, true, task.message);
  const busyBranch = `owl/task/${workId}/busy`;
  git(projectRoot, "worktree", "add", "-b", busyBranch, join(root, "busy-checkout"), "main");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  let result;
  try {
    result = await core.deleteWork(workId, command({}, "busy-branch-delete", 1));
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.data.deleted, true);
  assert.equal(db.get("SELECT id FROM works WHERE id = ?", workId), undefined);
  assert.equal(hasBranch(projectRoot, busyBranch), true);
  assert.ok(warnings.some((warning) => warning.includes(busyBranch)), warnings.join("\n"));
});

const BUILD_OUTPUT = ["node_modules/pkg/index.js", "dist/main.js", ".next/cache/data", "out/index.html"];

/** A Project whose repository ignores build output, plus a Work in `state` with that Project. */
async function projectWork(core, db, root, name, state) {
  const projectRoot = join(root, `project-${name}`);
  await mkdir(projectRoot, { recursive: true });
  git(projectRoot, "init", "--initial-branch=main");
  await writeFile(join(projectRoot, ".gitignore"), "node_modules/\ndist/\n.next/\nout/\n");
  await writeFile(join(projectRoot, "README.md"), "base\n");
  git(projectRoot, "add", ".");
  git(projectRoot, "commit", "-m", "initial");
  const project = await core.createProject(command({
    name,
    canonical_path: projectRoot,
    base_branch: "main",
    allowed_roots: [root],
    verification_plan: [],
  }, `project:${name}`));
  const created = await core.createWork(command({ title: name, summary: "", size: "small", project_id: project.data.id }, `create:${name}`));
  const workId = created.data.work_id;
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = ?, state_version = 1 WHERE id = ?", state, workId);
  });
  return { projectRoot, workId };
}

/** A Task worktree holding build output, an uncommitted tracked edit and a symlink to a file outside the Work. */
async function dirtyWorkspace(core, root, projectRoot, workId) {
  const task = await core.git.prepareWorktree({ work_id: workId, task_id: createUlid() });
  assert.equal(task.ok, true, task.message);
  for (const file of BUILD_OUTPUT) {
    await mkdir(dirname(join(task.worktree_path, file)), { recursive: true });
    await writeFile(join(task.worktree_path, file), "build output\n");
  }
  await writeFile(join(task.worktree_path, "README.md"), "uncommitted edit\n");
  const outside = join(root, `outside-${workId}.txt`);
  await writeFile(outside, "outside content\n");
  await symlink(outside, join(task.worktree_path, "link-outside.txt"));
  const other = join(root, ".owl-workspaces", createUlid(), "keep.txt");
  await mkdir(dirname(other), { recursive: true });
  await writeFile(other, "another Work\n");
  return {
    workDir: join(root, ".owl-workspaces", workId),
    async assertOutsideUntouched() {
      assert.equal(await readFile(outside, "utf8"), "outside content\n");
      assert.equal(await readFile(other, "utf8"), "another Work\n");
    },
  };
}

function seedActiveRun(db, workId) {
  const runId = createUlid();
  const now = new Date().toISOString();
  return db.createWriteLane().transact((transaction) => transaction.run(
    `INSERT INTO agent_runs (id, work_id, role, provider, model, status, created_at, updated_at)
     VALUES (?, ?, 'worker', 'test', 'test', 'running', ?, ?)`, runId, workId, now, now,
  ));
}

async function openCoreWithStoppableAgents(t) {
  const stopped = [];
  let database;
  const agentRunner = {
    cancelAgent: async (runId) => {
      stopped.push(runId);
      await database.createWriteLane().transact((transaction) => transaction.run("UPDATE agent_runs SET status = 'cancelled' WHERE id = ?", runId));
    },
  };
  const opened = await createTestCore(t, { version: "work-delete-test", agentRunner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-work-purge-" });
  database = opened.db;
  return { ...opened, stopped };
}

const activeRuns = (db, workId) => db.get(
  "SELECT COUNT(*) AS count FROM agent_runs WHERE work_id = ? AND status IN ('launch_pending', 'spawned', 'running', 'cancel_requested')", workId,
).count;

test("cancelWork stops the Agents and removes the whole workspace and the Work branches, keeping the Work row", async (t) => {
  const { root, db, core, stopped } = await openCoreWithStoppableAgents(t);
  const { projectRoot, workId } = await projectWork(core, db, root, "cancel-purge", "running");
  const workspace = await dirtyWorkspace(core, root, projectRoot, workId);
  await seedActiveRun(db, workId);
  const mainBefore = git(projectRoot, "rev-parse", "main");
  assert.notEqual(git(projectRoot, "branch", "--list", `owl/*/${workId}/*`), "");

  const cancelled = await core.cancelWork(workId, command({ reason: "no longer needed" }, "cancel-purge", 1));

  assert.equal(cancelled.data.worktree_cleanup.ok, true, cancelled.data.worktree_cleanup.message);
  assert.equal(stopped.length, 1);
  assert.equal(activeRuns(db, workId), 0);
  await assert.rejects(access(workspace.workDir));
  assert.equal(git(projectRoot, "branch", "--list", `owl/*/${workId}/*`), "");
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "cancelled");
  await workspace.assertOutsideUntouched();
  assert.equal(git(projectRoot, "rev-parse", "main"), mainBefore);
});

test("deleteWork removes a cancelled Work's leftover workspace and a Work whose Agent is still running", async (t) => {
  const { root, db, core } = await openCoreWithStoppableAgents(t);
  const leftover = await projectWork(core, db, root, "delete-leftover", "cancelled");
  const leftoverSpace = await dirtyWorkspace(core, root, leftover.projectRoot, leftover.workId);
  const busy = await projectWork(core, db, root, "delete-busy", "cancelled");
  const busySpace = await dirtyWorkspace(core, root, busy.projectRoot, busy.workId);
  await seedActiveRun(db, busy.workId);
  const mainBefore = git(leftover.projectRoot, "rev-parse", "main");

  for (const [suffix, { workId, projectRoot }, space] of [["leftover", leftover, leftoverSpace], ["busy", busy, busySpace]]) {
    assert.equal((await core.deleteWork(workId, command({}, `delete-${suffix}`, 1))).data.deleted, true);
    assert.equal(db.get("SELECT id FROM works WHERE id = ?", workId), undefined);
    await assert.rejects(access(space.workDir));
    assert.equal(git(projectRoot, "branch", "--list", `owl/*/${workId}/*`), "");
    await space.assertOutsideUntouched();
  }
  assert.equal(git(leftover.projectRoot, "rev-parse", "main"), mainBefore);
});

test("a workspace cleanup failure is returned by cancelWork and raised by deleteWork with its cause and path", async (t) => {
  const { root, db, core } = await openCoreWithStoppableAgents(t);
  core.git.deleteWorkWorkspaces = async () => ({
    ok: false,
    message: "Device or resource busy",
    details: { path: "/work/dir/task", stage: "work_directory_remove" },
  });
  const running = await projectWork(core, db, root, "failure-cancel", "running");
  const cancelled = await core.cancelWork(running.workId, command({ reason: "stop" }, "failure-cancel", 1));
  assert.equal(cancelled.data.state, "cancelled");
  assert.deepEqual(cancelled.data.worktree_cleanup, {
    ok: false,
    message: "Device or resource busy",
    details: { path: "/work/dir/task", stage: "work_directory_remove" },
  });

  await assert.rejects(
    core.deleteWork(running.workId, command({}, "failure-delete", 2)),
    (error) => error.code === "worktree_cleanup_failed"
      && error.message.includes("Device or resource busy")
      && error.message.includes("/work/dir/task")
      && error.details.path === "/work/dir/task",
  );
  assert.ok(db.get("SELECT id FROM works WHERE id = ?", running.workId));
});

async function createWorkInState(core, db, title, state) {
  const id = (await core.createWork(command({ title, summary: "", size: "small", project_id: null }, `create:${title}`))).data.work_id;
  const now = "2026-09-25T00:00:00.000Z";
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = ?, state_version = 1, updated_at = ? WHERE id = ?", state, now, id);
  });
  return id;
}

function countIdRows(db, id) {
  let total = 0;
  for (const { name } of db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
    const columns = db.all(`PRAGMA table_info("${name}")`).filter((column) => /TEXT|CHAR|CLOB/iu.test(column.type));
    if (columns.length === 0) continue;
    const where = columns.map((column) => `"${column.name}" LIKE ?`).join(" OR ");
    total += db.get(`SELECT COUNT(*) AS count FROM "${name}" WHERE ${where}`, ...columns.map(() => `%${id}%`)).count;
  }
  return total;
}

test("deleteWork deletes unarchived completed and cancelled Works", async (t) => {
  const { db, core } = await setup(t);
  for (const state of ["completed", "cancelled"]) {
    const id = await createWorkInState(core, db, `Unarchived ${state}`, state);
    assert.equal(db.get("SELECT archived_at FROM works WHERE id = ?", id).archived_at, null);
    assert.deepEqual((await core.deleteWork(id, command({}, `delete-${state}`, 1))).data, { work_id: id, deleted: true });
    assert.equal(db.get("SELECT id FROM works WHERE id = ?", id), undefined);
  }
});

test("deleteWork refuses running and paused Works and keeps every row", async (t) => {
  const { db, core } = await setup(t);
  for (const state of ["running", "paused"]) {
    const id = await createWorkInState(core, db, `Active ${state}`, state);
    const ownerId = db.get("SELECT owner_id FROM works WHERE id = ?", id).owner_id;
    const now = "2026-09-25T00:00:00.000Z";
    const taskId = createUlid(), runId = createUlid(), conversationId = createUlid(), accountId = createUlid(), messageId = createUlid(), reviewId = createUlid();
    await db.createWriteLane().transact((transaction) => {
      transaction.run(
        `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
         VALUES (?, ?, 'T', 'code', 'running', 'normal', '', '', ?, ?)`, taskId, id, now, now);
      transaction.run(
        `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
         VALUES (?, ?, ?, 'worker', 'test', 'test', 'running', ?, ?)`, runId, id, taskId, now, now);
      transaction.run("INSERT INTO conversations (id, owner_id, work_id, channel, is_active, created_at, updated_at) VALUES (?, ?, ?, 'web', 0, ?, ?)", conversationId, ownerId, id, now, now);
      transaction.run("INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'web', ?, ?)", accountId, ownerId, `web:${accountId}`, now);
      transaction.run(
        `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
         VALUES (?, ?, 'web', ?, ?, 'hi', '[]', ?, ?)`, messageId, conversationId, accountId, `src:${messageId}`, now, now);
      transaction.run("INSERT INTO learning_jobs (id, work_id, payload_json, status, created_at, updated_at) VALUES (?, ?, '{}', 'pending', ?, ?)", createUlid(), id, now, now);
      transaction.run(
        `INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at)
         VALUES (?, ?, 0, 'pass', '[]', '{}', ?)`, reviewId, taskId, now);
      transaction.run(
        `INSERT INTO backlog_items (id, work_id, task_id, review_id, review_round, file, problem, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 'f.ts', 'p', ?, ?, ?)`, createUlid(), id, taskId, reviewId, `d:${id}`, now, now);
      const sequence = transaction.get("SELECT coalesce(max(sequence), 0) + 1 AS sequence FROM events").sequence;
      transaction.run(
        `INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, agent_run_id, payload_json, status, created_at)
         VALUES (?, ?, ?, 'task.started', ?, ?, ?, '{}', 'handled', ?)`, createUlid(), sequence, `ev:${createUlid()}`, id, taskId, runId, now);
      transaction.run(
        `INSERT INTO skill_proposals (id, kind, target_skill, payload_json, source_work_id, source_agent_run_id, status, attempts, created_at, updated_at)
         VALUES (?, 'new', NULL, '{}', ?, ?, 'awaiting_approval', 0, ?, ?)`, `sp-${state}`, id, runId, now, now);
    });
    const snapshot = () => JSON.stringify([
      db.all("SELECT * FROM works WHERE id = ?", id),
      ...["tasks", "agent_runs", "backlog_items", "learning_jobs", "conversations", "events"].map((table) => db.all(`SELECT * FROM ${table} WHERE work_id = ?`, id)),
      db.all("SELECT * FROM messages WHERE conversation_id = ?", conversationId),
      db.all("SELECT * FROM skill_proposals WHERE source_work_id = ?", id),
    ]);
    const before = snapshot();
    await assert.rejects(core.deleteWork(id, command({}, `delete-${state}`, 1)), (error) => error.code === "invalid_state_transition");
    assert.equal(snapshot(), before);
  }
});

function preparedDecision(proposalId, name, { work, run, reason }) {
  return JSON.stringify({
    proposal_id: proposalId, target_name: name, target_revision: null,
    files: { "SKILL.md": renderSkillMd({ name, description: "d", tags: [], scope: "global" }, "# Skill\n\nBody.") }, meta: { description: "d", tags: [], scope: "global" },
    action: "create", archive: [], reason, source_proposal_id: proposalId,
    source_work_id: work, source_agent_run_id: run, project_id: null, relation: "different",
  });
}

test("deleteWork leaves no trace of the Work id and does not touch other Works", async (t) => {
  const { root, db, core } = await setup(t);
  const target = await createWorkInState(core, db, "Trace target", "completed");
  const other = await createWorkInState(core, db, "Trace other", "completed");
  const ownerId = db.get("SELECT owner_id FROM works WHERE id = ?", target).owner_id;
  const now = "2026-09-25T00:00:00.000Z";
  const seed = (transaction, workId) => {
    const ids = { task: createUlid(), run: createUlid(), review: createUlid(), conversation: createUlid(), message: createUlid(), account: createUlid() };
    transaction.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, ?, 'T', 'code', 'completed', 'normal', '', '', ?, ?)`, ids.task, workId, now, now);
    transaction.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
       VALUES (?, ?, ?, 'worker', 'test', 'test', 'completed', ?, ?)`, ids.run, workId, ids.task, now, now);
    transaction.run(
      `INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at)
       VALUES (?, ?, 0, 'pass', '[]', '{}', ?)`, ids.review, ids.task, now);
    transaction.run(
      `INSERT INTO backlog_items (id, work_id, task_id, review_id, review_round, file, problem, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 'f.ts', 'p', ?, ?, ?)`, createUlid(), workId, ids.task, ids.review, `d:${workId}`, now, now);
    transaction.run("INSERT INTO learning_jobs (id, work_id, payload_json, status, created_at, updated_at) VALUES (?, ?, '{}', 'pending', ?, ?)", createUlid(), workId, now, now);
    transaction.run("INSERT INTO conversations (id, owner_id, work_id, channel, is_active, created_at, updated_at) VALUES (?, ?, ?, 'web', 0, ?, ?)", ids.conversation, ownerId, workId, now, now);
    transaction.run("INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'web', ?, ?)", ids.account, ownerId, `web:${ids.account}`, now);
    transaction.run(
      `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
       VALUES (?, ?, 'web', ?, ?, 'hi', '[]', ?, ?)`, ids.message, ids.conversation, ids.account, `src:${ids.message}`, now, now);
    const sequence = transaction.get("SELECT coalesce(max(sequence), 0) + 1 AS sequence FROM events").sequence;
    transaction.run(
      `INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, agent_run_id, payload_json, status, created_at)
       VALUES (?, ?, ?, 'task.completed', ?, ?, ?, '{}', 'handled', ?)`, createUlid(), sequence, `ev:${createUlid()}`, workId, ids.task, ids.run, now);
    return ids;
  };
  let targetRun;
  await db.createWriteLane().transact((transaction) => {
    targetRun = seed(transaction, target).run;
    seed(transaction, other);
    for (const [id, status] of [["sp-wait", "awaiting_approval"], ["sp-applied", "applied"]]) {
      transaction.run(
        `INSERT INTO skill_proposals (id, kind, target_skill, payload_json, source_work_id, source_agent_run_id, status, decision_json, attempts, created_at, updated_at)
         VALUES (?, 'new', NULL, '{}', ?, ?, ?, ?, 0, ?, ?)`,
        id, target, targetRun, status, preparedDecision(id, `trace-${id}`, { work: target, run: targetRun, reason: "because" }), now, now);
    }
  });
  const snapshot = () => JSON.stringify([
    db.all("SELECT * FROM works WHERE id = ?", other),
    ...["tasks", "agent_runs", "backlog_items", "learning_jobs", "conversations", "events"].map((table) => db.all(`SELECT * FROM ${table} WHERE work_id = ?`, other)),
    db.all("SELECT * FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE work_id = ?)", other),
  ]);
  const before = snapshot();
  assert.ok(countIdRows(db, target) > 0);

  await core.deleteWork(target, command({}, "delete-trace", 1));

  assert.equal(countIdRows(db, target), 0);
  assert.equal(countIdRows(db, targetRun), 0);
  assert.equal(snapshot(), before);
  assert.equal(db.all("PRAGMA foreign_key_check").length, 0);
  const curator = new SkillCurator({ db, skillBox: new SkillBox({ db, owlRoot: root }), agentRunner: {} });
  await curator.approveProposal("sp-wait");
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = 'sp-wait'").status, "applied");
  assert.ok(db.get("SELECT name FROM skills WHERE name = 'trace-sp-wait'"));
});

async function insertCompletedWork(db, id) {
  const now = "2026-09-25T00:00:00.000Z";
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = 'completed', state_version = 1, completed_at = ?, updated_at = ? WHERE id = ?", now, now, id);
  });
}

function insertArtifact(transaction, id, workId, path) {
  transaction.run(
    `INSERT INTO artifacts (id, work_id, path, kind, deliverable, sha256, bytes, mime, version_no, created_at)
     VALUES (?, ?, ?, 'generated', 1, ?, 1, 'text/plain', 1, ?)`,
    id, workId, path, "b".repeat(64), "2026-09-25T00:00:00.000Z",
  );
}

test("deleteWork removes the Work's outputs and temp uploads, and keeps files outside data, shared with another Work, or in knowledge", async (t) => {
  const { root, db, core } = await setup(t);
  const created = await core.createWork(command({ title: "Files", summary: "", size: "small", project_id: null }, "create:files"));
  const workId = created.data.work_id;
  const other = await core.createWork(command({ title: "Other files", summary: "", size: "small", project_id: null }, "create:files-other"));
  await insertCompletedWork(db, workId);
  const ownerId = db.get("SELECT owner_id FROM works WHERE id = ?", workId).owner_id;
  const ids = { conversation: createUlid(), account: createUlid(), upload: createUlid(), otherUpload: createUlid(), otherConversation: createUlid() };
  const files = {
    own: join(root, "data", "uploads", "own.bin"),
    shared: join(root, "data", "uploads", "shared.bin"),
    sharedCopy: join(root, "data", "uploads", "shared-copy.bin"),
    knowledge: join(root, "knowledge", "note.md"),
    outside: join(root, "outside.txt"),
    outsideCopy: join(root, "outside-copy.txt"),
    part: join(root, "data", "uploads", ".tmp", `${ids.upload}.part`),
    outputs: join(root, "data", "outputs", workId, "saved.txt"),
  };
  for (const file of Object.values(files)) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "x");
  }
  const now = "2026-09-25T00:00:00.000Z";
  await db.createWriteLane().transact((transaction) => {
    insertArtifact(transaction, createUlid(), workId, "data/uploads/own.bin");
    insertArtifact(transaction, createUlid(), workId, "data/uploads/shared.bin");
    insertArtifact(transaction, createUlid(), other.data.work_id, "data/uploads/shared.bin");
    insertArtifact(transaction, createUlid(), workId, "knowledge/note.md");
    insertArtifact(transaction, createUlid(), workId, "outside.txt");
    transaction.run(
      `INSERT INTO conversations (id, owner_id, work_id, channel, is_active, created_at, updated_at) VALUES (?, ?, ?, 'web', 1, ?, ?)`,
      ids.conversation, ownerId, workId, now, now,
    );
    transaction.run(
      `INSERT INTO conversations (id, owner_id, work_id, channel, is_active, created_at, updated_at) VALUES (?, ?, ?, 'web', 0, ?, ?)`,
      ids.otherConversation, ownerId, other.data.work_id, now, now,
    );
    transaction.run(
      `INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'web', ?, ?)`,
      ids.account, ownerId, `web:${ids.account}`, now,
    );
    for (const [id, workRef, status, shared] of [
      [ids.upload, workId, "receiving", null],
      [createUlid(), workId, "stored", files.outsideCopy],
      [createUlid(), workId, "stored", files.sharedCopy],
      [ids.otherUpload, other.data.work_id, "stored", files.sharedCopy],
    ]) {
      const conversationId = id === ids.otherUpload ? ids.otherConversation : ids.conversation;
      transaction.run(
        `INSERT INTO inbound_uploads (id, provider, account_id, external_attachment_id, request_id, idempotency_key, request_hash,
                                      work_id, conversation_id, filename, declared_bytes, bytes, expires_at, status, shared_copy_path, created_at)
         VALUES (?, 'web', ?, ?, ?, ?, ?, ?, ?, 'f.txt', 1, ?, ?, ?, ?, ?)`,
        id, ids.account, `attachment:${id}`, `req:${id}`, `key:${id}`, "d".repeat(64),
        workRef, conversationId, status === "receiving" ? null : 1, "2099-01-01T00:00:00.000Z", status, shared, now,
      );
    }
  });
  const workspace = join(root, ".owl-workspaces", workId);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "left.txt"), "left\n");

  await core.deleteWork(workId, command({}, "delete-files", 1));

  await assert.rejects(access(join(root, "data", "outputs", workId)));
  await assert.rejects(access(files.own));
  await assert.rejects(access(files.part));
  for (const kept of [files.shared, files.sharedCopy, files.knowledge, files.outside, files.outsideCopy]) await access(kept);
  assert.equal(db.all("PRAGMA foreign_key_check").length, 0);
});

test("deleteWork leaves another Work's rows unchanged apart from related_work_ids_json", async (t) => {
  const { db, core } = await setup(t);
  const workId = (await core.createWork(command({ title: "Target", summary: "", size: "small", project_id: null }, "create:target"))).data.work_id;
  const otherId = (await core.createWork(command({ title: "Other", summary: "", size: "small", project_id: null }, "create:other"))).data.work_id;
  await insertCompletedWork(db, workId);
  const taskId = createUlid();
  const otherTaskId = createUlid();
  const now = "2026-09-25T00:00:00.000Z";
  await db.createWriteLane().transact((transaction) => {
    for (const [id, work, parent] of [[taskId, workId, null], [otherTaskId, otherId, null]]) {
      transaction.run(
        `INSERT INTO tasks (id, work_id, parent_task_id, title, type, status, priority, context, acceptance, created_at, updated_at)
         VALUES (?, ?, ?, 'T', 'code', 'completed', 'normal', '', '', ?, ?)`,
        id, work, parent, now, now,
      );
    }
    transaction.run("UPDATE works SET related_work_ids_json = ? WHERE id = ?", JSON.stringify([workId]), otherId);
  });
  const snapshot = () => ({
    tasks: db.all("SELECT * FROM tasks WHERE work_id = ?", otherId),
    runs: db.all("SELECT * FROM agent_runs WHERE work_id = ?", otherId),
    artifacts: db.all("SELECT * FROM artifacts WHERE work_id = ?", otherId),
    uploads: db.all("SELECT * FROM inbound_uploads WHERE work_id = ?", otherId),
    work: { ...db.get("SELECT * FROM works WHERE id = ?", otherId), related_work_ids_json: null },
  });
  const before = snapshot();
  // Another Work's task points at the target's task: the delete must not rewrite it.
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE tasks SET parent_task_id = ? WHERE id = ?", taskId, otherTaskId);
  });
  before.tasks[0].parent_task_id = taskId;
  await assert.rejects(core.deleteWork(workId, command({}, "delete-cross-ref", 1)));
  assert.deepEqual(snapshot(), before);
  assert.ok(db.get("SELECT id FROM works WHERE id = ?", workId));

  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE tasks SET parent_task_id = NULL WHERE id = ?", otherTaskId);
  });
  before.tasks[0].parent_task_id = null;
  await core.deleteWork(workId, command({}, "delete-no-ref", 1));
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(JSON.parse(db.get("SELECT related_work_ids_json FROM works WHERE id = ?", otherId).related_work_ids_json), []);
});

test("deleteWork compares files by real path: aliases, outputs and symlinks never delete shared or protected files", async (t) => {
  const { root, db, core } = await setup(t);
  const workId = (await core.createWork(command({ title: "Real", summary: "", size: "small", project_id: null }, "create:real"))).data.work_id;
  const otherId = (await core.createWork(command({ title: "Real other", summary: "", size: "small", project_id: null }, "create:real-other"))).data.work_id;
  await insertCompletedWork(db, workId);
  const outside = join(root, "elsewhere");
  const files = {
    keep: join(root, "data", "uploads", "keep.txt"),
    own: join(root, "data", "uploads", "own.txt"),
    sharedOut: join(root, "data", "outputs", workId, "shared.txt"),
    ownOut: join(root, "data", "outputs", workId, "own.txt"),
    knowledge: join(root, "knowledge", "keep.txt"),
    outside: join(outside, "keep.txt"),
  };
  for (const file of Object.values(files)) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "x");
  }
  await symlink(join(root, "knowledge"), join(root, "data", "linked"));
  await symlink(outside, join(root, "data", "linked-out"));
  await db.createWriteLane().transact((transaction) => {
    insertArtifact(transaction, createUlid(), workId, "data/uploads/keep.txt");
    insertArtifact(transaction, createUlid(), otherId, "./data/uploads/keep.txt");
    insertArtifact(transaction, createUlid(), workId, "data/uploads/own.txt");
    insertArtifact(transaction, createUlid(), otherId, `data/outputs/${workId}/shared.txt`);
    insertArtifact(transaction, createUlid(), workId, "data/linked/keep.txt");
    insertArtifact(transaction, createUlid(), workId, "data/linked-out/keep.txt");
  });
  await core.deleteWork(workId, command({}, "delete-real", 1));
  for (const kept of [files.keep, files.sharedOut, files.knowledge, files.outside]) await access(kept);
  await assert.rejects(access(files.own));
  await assert.rejects(access(files.ownOut));
});

test("deleteWork leaves agent_activity, inbound_uploads and skill_usages rows of another Work unchanged", async (t) => {
  const { db, core } = await setup(t);
  const workId = (await core.createWork(command({ title: "Mine", summary: "", size: "small", project_id: null }, "create:mine"))).data.work_id;
  const otherId = (await core.createWork(command({ title: "Theirs", summary: "", size: "small", project_id: null }, "create:theirs"))).data.work_id;
  await insertCompletedWork(db, workId);
  const ownerId = db.get("SELECT owner_id FROM works WHERE id = ?", workId).owner_id;
  const ids = { run: createUlid(), conversation: createUlid(), account: createUlid(), activity: createUlid(), upload: createUlid() };
  const now = "2026-09-25T00:00:00.000Z";
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO agent_runs (id, work_id, role, provider, model, status, created_at, updated_at)
       VALUES (?, ?, 'worker', 'test', 'test', 'completed', ?, ?)`,
      ids.run, workId, now, now,
    );
    transaction.run(
      `INSERT INTO conversations (id, owner_id, work_id, channel, is_active, created_at, updated_at) VALUES (?, ?, ?, 'web', 1, ?, ?)`,
      ids.conversation, ownerId, workId, now, now,
    );
    transaction.run(
      `INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'web', ?, ?)`,
      ids.account, ownerId, `web:${ids.account}`, now,
    );
    transaction.run(
      "INSERT INTO skill_usages (agent_run_id, skill_name, work_id, revision, created_at, updated_at) VALUES (?, 'x', ?, 1, ?, ?)",
      ids.run, otherId, now, now,
    );
  });
  const snapshot = () => ({ usages: db.all("SELECT * FROM skill_usages WHERE work_id = ?", otherId) });
  const before = snapshot();
  assert.equal(before.usages.length, 1);
  await core.deleteWork(workId, command({}, "delete-ownership", 1));
  assert.deepEqual(snapshot(), before);
});

async function seedUpload(db, workId, uploadId) {
  const ownerId = db.get("SELECT owner_id FROM works WHERE id = ?", workId).owner_id;
  const now = "2026-09-25T00:00:00.000Z";
  const conversation = createUlid();
  const account = createUlid();
  await db.createWriteLane().transact((transaction) => {
    transaction.run("INSERT INTO conversations (id, owner_id, work_id, channel, is_active, created_at, updated_at) VALUES (?, ?, ?, 'web', 0, ?, ?)", conversation, ownerId, workId, now, now);
    transaction.run("INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'web', ?, ?)", account, ownerId, `web:${account}`, now);
    transaction.run(
      `INSERT INTO inbound_uploads (id, provider, account_id, external_attachment_id, request_id, idempotency_key, request_hash,
                                    work_id, conversation_id, filename, declared_bytes, bytes, expires_at, status, shared_copy_path, created_at)
       VALUES (?, 'web', ?, ?, ?, ?, ?, ?, ?, 'f.txt', 1, NULL, ?, 'receiving', NULL, ?)`,
      uploadId, account, `attachment:${uploadId}`, `req:${uploadId}`, `key:${uploadId}`, "d".repeat(64), workId, conversation, "2099-01-01T00:00:00.000Z", now,
    );
  });
}

test("deleteWork keeps proposal bodies equal to the Work id and the proposal can still be approved", async (t) => {
  const { root, db, core } = await setup(t);
  const target = await createWorkInState(core, db, "Skill source", "completed");
  const now = "2026-09-25T00:00:00.000Z";
  await db.createWriteLane().transact((transaction) => {
    const decision = JSON.parse(preparedDecision("sp-same", "same-id", { work: target, run: null, reason: target }));
    decision.files["references/notes.md"] = target;
    transaction.run(
      `INSERT INTO skill_proposals (id, kind, target_skill, payload_json, source_work_id, status, decision_json, attempts, created_at, updated_at)
       VALUES ('sp-same', 'new', NULL, '{}', ?, 'awaiting_approval', ?, 0, ?, ?)`, target, JSON.stringify(decision), now, now);
  });

  await core.deleteWork(target, command({}, "delete-same", 1));

  const decision = JSON.parse(db.get("SELECT decision_json FROM skill_proposals WHERE id = 'sp-same'").decision_json);
  assert.equal(decision.source_work_id, null);
  assert.equal(decision.reason, target);
  assert.equal(decision.files["references/notes.md"], target);
  const curator = new SkillCurator({ db, skillBox: new SkillBox({ db, owlRoot: root }), agentRunner: {} });
  await curator.approveProposal("sp-same");
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = 'sp-same'").status, "applied");
  assert.ok(db.get("SELECT name FROM skills WHERE name = 'same-id'"));
});

test("deleteWork keeps files behind a symlinked uploads/.tmp that points into knowledge or outside data", async (t) => {
  const { root, db, core } = await setup(t);
  const outside = await tempDir(t, "owl-part-outside-");
  for (const [label, linkTarget] of [["knowledge", join(root, "knowledge", "tmp-link")], ["outside", outside]]) {
    const target = await createWorkInState(core, db, `Part ${label}`, "completed");
    const uploadId = createUlid();
    await seedUpload(db, target, uploadId);
    await mkdir(linkTarget, { recursive: true });
    const kept = join(linkTarget, `${uploadId}.part`);
    await writeFile(kept, label);
    await rm(join(root, "data", "uploads", ".tmp"), { recursive: true, force: true });
    await mkdir(join(root, "data", "uploads"), { recursive: true });
    await symlink(linkTarget, join(root, "data", "uploads", ".tmp"));

    await core.deleteWork(target, command({}, `delete-part-${label}`, 1));

    assert.equal(db.get("SELECT id FROM works WHERE id = ?", target), undefined);
    await access(kept);
  }
});

test("deleteWork keeps a .part that another Work's artifact references", async (t) => {
  const { root, db, core } = await setup(t);
  const target = await createWorkInState(core, db, "Shared part", "completed");
  const other = await createWorkInState(core, db, "Shared part other", "completed");
  const uploadId = createUlid();
  await seedUpload(db, target, uploadId);
  const part = join(root, "data", "uploads", ".tmp", `${uploadId}.part`);
  await mkdir(dirname(part), { recursive: true });
  await writeFile(part, "x");
  await db.createWriteLane().transact((transaction) => insertArtifact(transaction, createUlid(), other, `data/uploads/.tmp/${uploadId}.part`));

  await core.deleteWork(target, command({}, "delete-shared-part", 1));

  await access(part);
});

// A run that outlives agentStopWaitMs must keep its workspace and records; a run whose process is gone must not block.
async function insertActiveRun(db, workId, { pid, alive }) {
  const { readProcessIdentity } = await import("../../packages/core/dist/process-identity.js");
  const identity = alive ? readProcessIdentity(pid) : { process_start_time: "Thu Jan  1 00:00:00 1970", process_cmdline_sha256: "0".repeat(64) };
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO agent_runs (id, work_id, role, provider, model, status, pid, process_start_time, process_cmdline_sha256, created_at, updated_at)
       VALUES (?, ?, 'worker', 'test', 'test', 'running', ?, ?, ?, ?, ?)`,
      createUlid(), workId, pid, identity.process_start_time, identity.process_cmdline_sha256, now, now,
    );
  });
}

test("cancelWork and deleteWork keep the workspace and branches while an Agent process outlives agentStopWaitMs", async (t) => {
  const { spawn } = await import("node:child_process");
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => child.kill());
  const { root, db, core } = await createTestCore(
    t,
    { version: "work-delete-test", agentRunner: { cancelAgent: async () => {} }, agentStopWaitMs: 50 },
    { prefix: "owl-work-stop-wait-" },
  );
  const doomed = await projectWork(core, db, root, "stop-wait-delete", "cancelled");
  const doomedSpace = await dirtyWorkspace(core, root, doomed.projectRoot, doomed.workId);
  await insertActiveRun(db, doomed.workId, { pid: child.pid, alive: true });
  await assert.rejects(core.deleteWork(doomed.workId, command({}, "delete-alive", 1)), (error) => error.code === "worktree_cleanup_failed" && error.details.stage === "agent_stop");
  assert.ok(db.get("SELECT id FROM works WHERE id = ?", doomed.workId), "row stays");
  await access(doomedSpace.workDir);

  const running = await projectWork(core, db, root, "stop-wait-cancel", "running");
  const space = await dirtyWorkspace(core, root, running.projectRoot, running.workId);
  await insertActiveRun(db, running.workId, { pid: child.pid, alive: true });
  const cancelled = await core.cancelWork(running.workId, command({ reason: "stop" }, "cancel-alive", 1));
  assert.equal(cancelled.data.state, "cancelled");
  assert.equal(cancelled.data.worktree_cleanup.ok, false);
  assert.equal(cancelled.data.worktree_cleanup.details.stage, "agent_stop");
  assert.equal(cancelled.data.worktree_cleanup.details.agent_run_ids.length, 1);
  await access(space.workDir);
  assert.notEqual(git(running.projectRoot, "branch", "--list", `owl/*/${running.workId}/*`), "");
});

test("a live process whose identity was never recorded still blocks deleteWork", async (t) => {
  const { spawn } = await import("node:child_process");
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => child.kill());
  const { db, core } = await createTestCore(t, { version: "work-delete-test", agentRunner: { cancelAgent: async () => {} }, agentStopWaitMs: 50 }, { prefix: "owl-work-stop-unknown-" });
  const workId = await createArchivedWork(core, db, null, "Unknown identity");
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => transaction.run(
    `INSERT INTO agent_runs (id, work_id, role, provider, model, status, pid, created_at, updated_at)
     VALUES (?, ?, 'worker', 'test', 'test', 'running', ?, ?, ?)`, createUlid(), workId, child.pid, now, now,
  ));
  await assert.rejects(core.deleteWork(workId, command({}, "delete-unknown", db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version)), (error) => error.details.stage === "agent_stop");
});

test("a run left active by a crashed process does not block deleteWork", async (t) => {
  const { db, core } = await createTestCore(t, { version: "work-delete-test", agentRunner: { cancelAgent: async () => {} }, agentStopWaitMs: 50 }, { prefix: "owl-work-stop-dead-" });
  const workId = await createArchivedWork(core, db, null, "Dead");
  await insertActiveRun(db, workId, { pid: 999999, alive: false });
  await core.deleteWork(workId, command({}, "delete-dead", db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version));
  assert.equal(db.get("SELECT id FROM works WHERE id = ?", workId), undefined);
});
