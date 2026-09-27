import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function command(payload, suffix, expectedVersion = 0) {
  return { request_id: createUlid(), idempotency_key: `delete-test:${suffix}`, expected_version: expectedVersion, payload };
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-work-delete-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const core = new Core({ db, agentRunner: {}, version: "work-delete-test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, db, core };
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

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function hasBranch(repository, branch) {
  try {
    git(repository, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

test("deleteWork removes FK-linked execution rows in one transaction and preserves conversations and outputs", async (t) => {
  const { root, db, core } = await setup(t);
  const workId = await createArchivedWork(core, db);
  const outside = await core.createWork(command({ title: "Unrelated", summary: "", size: "small", project_id: null }, "unrelated"));
  const externalWorkId = outside.data.work_id;
  const ids = {
    taskA: createUlid(), taskB: createUlid(), externalTask: createUlid(),
    run: createUlid(), externalRun: createUlid(), report: createUlid(),
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
    transaction.run(
      `INSERT INTO tasks (id, work_id, parent_task_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, ?, ?, 'Outside child', 'test', 'completed', 'normal', '', '', ?, ?)`,
      ids.externalTask, externalWorkId, ids.taskA, now, now,
    );
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
      `INSERT INTO agent_runs (id, work_id, task_id, parent_agent_id, subtask_id, report_id, role, provider, model, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'reviewer', 'test', 'test', 'completed', ?, ?)`,
      ids.externalRun, externalWorkId, ids.taskA, ids.run, ids.taskA, ids.report, now, now,
    );
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
  const detachedConversation = db.get("SELECT work_id, archived_at, is_active FROM conversations WHERE id = ?", ids.conversation);
  assert.equal(detachedConversation.work_id, null);
  assert.match(detachedConversation.archived_at, /^\d{4}-\d\d-\d\dT/u);
  assert.equal(detachedConversation.is_active, 0);
  assert.deepEqual(db.get("SELECT work_id, task_id, source_event_id FROM artifacts WHERE id = ?", ids.artifact), {
    work_id: null, task_id: null, source_event_id: null,
  });
  assert.equal(db.get("SELECT work_id FROM inbound_uploads WHERE id = ?", ids.upload).work_id, null);
  assert.equal(db.get("SELECT event_id FROM inbound_receipts WHERE id = ?", ids.receipt).event_id, null);
  assert.equal(db.get("SELECT agent_run_id FROM secret_audit WHERE id = ?", ids.audit).agent_run_id, null);
  assert.deepEqual(db.get("SELECT parent_task_id FROM tasks WHERE id = ?", ids.externalTask), { parent_task_id: null });
  assert.deepEqual(db.get("SELECT task_id, parent_agent_id, subtask_id, report_id FROM agent_runs WHERE id = ?", ids.externalRun), {
    task_id: null, parent_agent_id: null, subtask_id: null, report_id: null,
  });
  assert.deepEqual(JSON.parse(db.get("SELECT related_work_ids_json FROM works WHERE id = ?", externalWorkId).related_work_ids_json), []);
  assert.equal(db.get("SELECT key FROM idempotency_keys WHERE key = ?", `old-work-cache:${workId}`), undefined);
  assert.ok(db.get("SELECT key FROM idempotency_keys WHERE key = ?", `work.delete:${workId}:-:-:-:${request.idempotency_key}`));
  assert.equal(db.all("PRAGMA foreign_key_check").length, 0);
  assert.equal(await readFile(join(root, "data", "outputs", workId, "result.txt"), "utf8"), "preserved output\n");
  assert.equal(await readFile(join(root, "data", "outputs", workId, "root-note.txt"), "utf8"), "also preserved\n");
  await assert.rejects(access(workspace));
  assert.deepEqual(await core.deleteWork(workId, request), deleted, "delete retry replays the stored response after the Work row is gone");
  await assert.rejects(
    core.deleteWork(workId, { ...request, payload: { changed: true } }),
    (error) => error.code === "idempotency_conflict",
  );
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
  const now = "2026-09-25T00:00:00.000Z";
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = 'completed', state_version = 1, completed_at = ?, updated_at = ? WHERE id = ?", now, now, workId);
  });
  await core.archiveWork(workId, command({}, "archive:design-cleanup", 1));
  assert.equal(await readFile(join(designDirectory, "task.md"), "utf8"), "# Design\n", "archiving keeps the documents");

  const stateVersion = db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;
  await core.deleteWork(workId, command({}, "delete-design-documents", stateVersion));
  await assert.rejects(access(designDirectory));
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

test("deleteWork rejects non-terminal and unarchived Works before touching their workspace", async (t) => {
  const { root, db, core } = await setup(t);
  const created = await core.createWork(command({ title: "Running", summary: "", size: "small", project_id: null }, "running"));
  const path = join(root, ".owl-workspaces", created.data.work_id, "keep");
  await mkdir(path, { recursive: true });
  await assert.rejects(core.deleteWork(created.data.work_id, command({}, "delete-running")), (error) =>
    error.code === "invalid_state_transition" && error.details.state === "memo",
  );
  await access(path);

  const finished = await createArchivedWork(core, db, null, "Not yet archived");
  await db.createWriteLane().transact((transaction) => transaction.run("UPDATE works SET archived_at = NULL WHERE id = ?", finished));
  const finishedPath = join(root, ".owl-workspaces", finished, "keep");
  await mkdir(finishedPath, { recursive: true });
  await assert.rejects(core.deleteWork(finished, command({}, "delete-unarchived", 1)), (error) => error.code === "work_not_archived");
  await access(finishedPath);
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

test("ignored files stop deletion before worktree removal or the database transaction", async (t) => {
  const { root, db, core } = await setup(t);
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  git(projectRoot, "init", "--initial-branch=main");
  await writeFile(join(projectRoot, ".gitignore"), "ignored-dir/\n");
  await writeFile(join(projectRoot, "README.md"), "base\n");
  git(projectRoot, "add", ".");
  git(projectRoot, "commit", "-m", "initial");
  const project = await core.createProject(command({
    name: "Delete test project",
    canonical_path: projectRoot,
    base_branch: "main",
    allowed_roots: [root],
    verification_plan: [],
  }, "create-project"));
  const workId = await createArchivedWork(core, db, project.data.id, "Ignored content");
  const taskId = createUlid();
  const task = await core.git.prepareWorktree({ work_id: workId, task_id: taskId });
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => transaction.run(
    `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, worktree_path, worktree_state, created_at, updated_at)
     VALUES (?, ?, 'Task', 'code', 'completed', 'normal', '', '', ?, 'active', ?, ?)`,
    taskId, workId, task.worktree_path, now, now,
  ));
  await writeFile(join(task.worktree_path, "saved.txt"), "commit before ignored check\n");
  await mkdir(join(task.worktree_path, "ignored-dir"), { recursive: true });
  await writeFile(join(task.worktree_path, "ignored-dir", "keep.txt"), "ignored content\n");

  await assert.rejects(
    core.deleteWork(workId, command({}, "ignored-delete", 1)),
    (error) => error.code === "worktree_cleanup_failed"
      && error.details.worktrees[0].path.endsWith(taskId)
      && error.details.worktrees[0].ignored_count >= 1
      && error.details.worktrees[0].ignored_paths.includes("ignored-dir/"),
  );
  await access(task.worktree_path);
  assert.ok(db.get("SELECT id FROM works WHERE id = ?", workId));
  assert.ok(db.get("SELECT id FROM tasks WHERE id = ?", taskId));
  assert.equal(db.get("SELECT key FROM idempotency_keys WHERE key = ?", `work.delete:${workId}:-:-:-:delete-test:ignored-delete`), undefined);
  assert.equal(git(projectRoot, "show", `owl/task/${workId}/${taskId}:saved.txt`), "commit before ignored check");

  await rm(join(task.worktree_path, "ignored-dir"), { recursive: true });
  const retried = await core.deleteWork(workId, command({}, "ignored-delete-retry", 1));
  assert.equal(retried.data.deleted, true);
  assert.equal(db.get("SELECT id FROM works WHERE id = ?", workId), undefined);
  await assert.rejects(access(task.worktree_path));
  assert.equal(hasBranch(projectRoot, `owl/task/${workId}/${taskId}`), false);
  assert.equal(hasBranch(projectRoot, `owl/work/${workId}/work`), false);
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

test("ignored files in the integration worktree block all worktree removals", async (t) => {
  const { root, db, core } = await setup(t);
  const projectRoot = join(root, "integration-project");
  await mkdir(projectRoot, { recursive: true });
  git(projectRoot, "init", "--initial-branch=main");
  await writeFile(join(projectRoot, ".gitignore"), "ignored-dir/\n");
  await writeFile(join(projectRoot, "README.md"), "base\n");
  git(projectRoot, "add", ".");
  git(projectRoot, "commit", "-m", "initial");
  const project = await core.createProject(command({
    name: "Integration delete test project",
    canonical_path: projectRoot,
    base_branch: "main",
    allowed_roots: [root],
    verification_plan: [],
  }, "create-integration-project"));
  const workId = await createArchivedWork(core, db, project.data.id, "Integration ignored content");
  const taskId = createUlid();
  const task = await core.git.prepareWorktree({ work_id: workId, task_id: taskId });
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => transaction.run(
    `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, worktree_path, worktree_state, created_at, updated_at)
     VALUES (?, ?, 'Task', 'code', 'completed', 'normal', '', '', ?, 'active', ?, ?)`,
    taskId, workId, task.worktree_path, now, now,
  ));
  await writeFile(join(task.worktree_path, "feature.txt"), "merged feature\n");
  const integrated = await core.git.integrateTask({ work_id: workId, task_id: taskId, worktree_path: task.worktree_path });
  assert.equal(integrated.merged, true, integrated.message);
  const integrationPath = join(root, ".owl-workspaces", workId, "__work__");
  await writeFile(join(integrationPath, "saved-work.txt"), "commit before ignored check\n");
  await mkdir(join(integrationPath, "ignored-dir"), { recursive: true });
  await writeFile(join(integrationPath, "ignored-dir", "keep.txt"), "ignored content\n");

  await assert.rejects(
    core.deleteWork(workId, command({}, "ignored-integration-delete", 1)),
    (error) => error.code === "worktree_cleanup_failed"
      && error.details.worktrees.some((worktree) => worktree.path.endsWith("/__work__") && worktree.ignored_paths.includes("ignored-dir/")),
  );
  await access(integrationPath);
  assert.ok(db.get("SELECT id FROM works WHERE id = ?", workId));
  assert.ok(db.get("SELECT id FROM tasks WHERE id = ?", taskId));
  assert.equal(git(projectRoot, "show", `owl/work/${workId}/work:saved-work.txt`), "commit before ignored check");

  await rm(join(integrationPath, "ignored-dir"), { recursive: true });
  assert.equal((await core.deleteWork(workId, command({}, "ignored-integration-retry", 1))).data.deleted, true);
  await assert.rejects(access(integrationPath));
  assert.equal(hasBranch(projectRoot, `owl/work/${workId}/work`), false);
  assert.equal(hasBranch(projectRoot, `owl/task/${workId}/${taskId}`), false);
});

test("a workspace scan failure retains its directories and skips database deletion", async (t) => {
  const { root, db, core } = await setup(t);
  const projectRoot = join(root, "scan-project");
  await mkdir(projectRoot, { recursive: true });
  git(projectRoot, "init", "--initial-branch=main");
  await writeFile(join(projectRoot, "README.md"), "base\n");
  git(projectRoot, "add", ".");
  git(projectRoot, "commit", "-m", "initial");
  const project = await core.createProject(command({
    name: "Scan failure test project",
    canonical_path: projectRoot,
    base_branch: "main",
    allowed_roots: [root],
    verification_plan: [],
  }, "create-scan-project"));
  const workId = await createArchivedWork(core, db, project.data.id, "Unreadable workspace");
  const orphan = join(root, ".owl-workspaces", workId, "orphan");
  await mkdir(orphan, { recursive: true });
  const external = join(root, "outside.txt");
  await writeFile(external, "outside content\n");
  await symlink(external, join(orphan, "escape.txt"));

  await assert.rejects(
    core.deleteWork(workId, command({}, "scan-failure", 1)),
    (error) => error.code === "worktree_cleanup_failed"
      && error.details.stage === "workspace_scan"
      && error.details.path.endsWith("/orphan"),
  );
  await access(join(orphan, "escape.txt"));
  assert.ok(db.get("SELECT id FROM works WHERE id = ?", workId));
  assert.equal(db.get("SELECT key FROM idempotency_keys WHERE key = ?", `work.delete:${workId}:-:-:-:delete-test:scan-failure`), undefined);
});
