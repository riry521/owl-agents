import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createUlid } from "../../db/dist/index.js";
import { designMockDirectory } from "../../shared/dist/index.js";
import { command, createTestCore } from "../../../tests/helpers/core.mjs";
import { criteriaFor, necessityFor } from "../../../tests/helpers/necessity.mjs";
import { waitFor } from "../../../tests/helpers/wait.mjs";

const NOW = "2026-01-01T00:00:00.000Z";
const sha = (text) => createHash("sha256").update(text).digest("hex");

async function seed(t, { assigned = "lead_designer", workState = "running" } = {}) {
  const { core, db, root } = await createTestCore(t, {}, { prefix: "owl-design-mocks-" });
  const workId = createUlid();
  const taskId = createUlid();
  const otherTaskId = createUlid();
  const runId = createUlid();
  const workerRunId = createUlid();
  const otherRunId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", NOW, NOW);
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:default', NULL, 'Design Work', '', 'normal', ?, '[]', '[]', ?, ?)`,
      workId, workState, NOW, NOW,
    );
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, assigned_designer, created_at, updated_at)
       VALUES (?, ?, 'Screen design', 'design', 'running', 'normal', '', '', ?, ?, ?)`,
      taskId, workId, assigned, NOW, NOW,
    );
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, ?, 'Implementation', 'code', 'running', 'normal', '', '', ?, ?)`,
      otherTaskId, workId, NOW, NOW,
    );
    for (const [id, task, role] of [[runId, taskId, "designer"], [otherRunId, otherTaskId, "designer"], [workerRunId, taskId, "worker"]]) {
      tx.run(
        `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'claude', 'test-model', 'running', ?, ?)`,
        id, workId, task, role, NOW, NOW,
      );
    }
  });
  const dir = designMockDirectory(join(root, "data"), workId, taskId);
  return { core, db, root, workId, taskId, otherTaskId, runId, otherRunId, workerRunId, dir };
}

const rows = (db, taskId) => db.all("SELECT name, html, size_bytes FROM design_mocks WHERE task_id = ? ORDER BY name", taskId);

test("save writes a regular file and a DB row", async (t) => {
  const { core, db, runId, taskId, dir } = await seed(t);
  const result = await core.saveDesignMock(runId, "top.html", "<h1>top</h1>");
  assert.equal(result.task_id, taskId);
  assert.equal(result.size_bytes, 12);
  const details = await lstat(join(dir, "top.html"));
  assert.ok(details.isFile() && !details.isSymbolicLink());
  assert.equal(await readFile(join(dir, "top.html"), "utf8"), "<h1>top</h1>");
  assert.deepEqual(rows(db, taskId), [{ name: "top.html", html: "<h1>top</h1>", size_bytes: 12 }]);
  await core.saveDesignMock(runId, "top.html", "<h1>v2</h1>");
  assert.equal(rows(db, taskId).length, 1);
  assert.equal(rows(db, taskId)[0].html, "<h1>v2</h1>");
});

test("a symlink at the mock name is replaced and its target is untouched", async (t) => {
  const { core, root, runId, dir } = await seed(t);
  await mkdir(dir, { recursive: true });
  const target = join(root, "outside.txt");
  await writeFile(target, "secret");
  await symlink(target, join(dir, "top.html"));
  await core.saveDesignMock(runId, "top.html", "<p>safe</p>");
  assert.equal(sha(await readFile(target, "utf8")), sha("secret"));
  assert.ok((await lstat(join(dir, "top.html"))).isFile());
  assert.equal(await readFile(join(dir, "top.html"), "utf8"), "<p>safe</p>");
});

test("a hardlink at the mock name is replaced and the other link is untouched", async (t) => {
  const { core, root, runId, dir } = await seed(t);
  await mkdir(dir, { recursive: true });
  const target = join(root, "outside.txt");
  await writeFile(target, "secret");
  await link(target, join(dir, "top.html"));
  await core.saveDesignMock(runId, "top.html", "<p>safe</p>");
  assert.equal(await readFile(target, "utf8"), "secret");
  assert.equal(await readFile(join(dir, "top.html"), "utf8"), "<p>safe</p>");
  assert.equal((await stat(join(dir, "top.html"))).nlink, 1);
});

test("a mock directory replaced by a symlink fails with design_mock_write_failed and no row", async (t) => {
  const { core, db, root, runId, taskId, dir } = await seed(t);
  const outside = join(root, "outside-dir");
  await mkdir(outside);
  await mkdir(join(dir, ".."), { recursive: true });
  await symlink(outside, dir);
  await assert.rejects(core.saveDesignMock(runId, "top.html", "<p>x</p>"), (error) => error.code === "design_mock_write_failed");
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(rows(db, taskId), []);
});

test("a Worker run and a run of a non-design Task get the scope error", async (t) => {
  const { core, db, otherRunId, otherTaskId, workerRunId, taskId } = await seed(t);
  await assert.rejects(core.saveDesignMock(workerRunId, "top.html", "<p>x</p>"), (error) => error.code === "design_mock_scope_denied");
  await assert.rejects(core.deleteDesignMock(workerRunId, "top.html"), (error) => error.code === "design_mock_scope_denied");
  assert.deepEqual(rows(db, taskId), []);
  await assert.rejects(core.saveDesignMock(otherRunId, "top.html", "<p>x</p>"), (error) => error.code === "design_mock_scope_denied");
  await assert.rejects(core.deleteDesignMock(otherRunId, "top.html"), (error) => error.code === "design_mock_scope_denied");
  assert.deepEqual(rows(db, otherTaskId), []);
});

test("a designer-assigned design Task saves, lists, reads and deletes mocks", async (t) => {
  const { core, db, runId, taskId, workId } = await seed(t, { assigned: "designer" });
  await core.saveDesignMock(runId, "top.html", "<h1>top</h1>");
  assert.deepEqual((await core.listWorkDesignMocks(workId)).mocks.map((mock) => [mock.task_id, mock.name]), [[taskId, "top.html"]]);
  assert.equal(await core.readWorkDesignMock(workId, taskId, "top.html"), "<h1>top</h1>");
  await core.deleteDesignMock(runId, "top.html");
  assert.deepEqual(rows(db, taskId), []);
});

test("delete removes the row and file; a link at the name is removed alone", async (t) => {
  const { core, db, root, runId, taskId, dir } = await seed(t);
  await core.saveDesignMock(runId, "a.html", "<p>a</p>");
  const result = await core.deleteDesignMock(runId, "a.html");
  assert.equal(result.deleted, true);
  assert.deepEqual(rows(db, taskId), []);
  await assert.rejects(lstat(join(dir, "a.html")), { code: "ENOENT" });

  await core.saveDesignMock(runId, "b.html", "<p>b</p>");
  const target = join(root, "outside.txt");
  await writeFile(target, "keep");
  await rename(join(dir, "b.html"), join(root, "moved.html"));
  await symlink(target, join(dir, "b.html"));
  await core.deleteDesignMock(runId, "b.html");
  assert.equal(await readFile(target, "utf8"), "keep");
  await assert.rejects(lstat(join(dir, "b.html")), { code: "ENOENT" });
  assert.deepEqual(rows(db, taskId), []);
});

test("list and read use the DB even when the folder file is replaced by a link", async (t) => {
  const { core, root, runId, workId, taskId, otherTaskId, dir } = await seed(t);
  await core.saveDesignMock(runId, "top.html", "<p>db</p>");
  const target = join(root, "evil.html");
  await writeFile(target, "<p>evil</p>");
  await rename(join(dir, "top.html"), join(root, "gone.html"));
  await symlink(target, join(dir, "top.html"));
  assert.equal(await core.readWorkDesignMock(workId, taskId, "top.html"), "<p>db</p>");
  const { mocks } = await core.listWorkDesignMocks(workId);
  assert.equal(mocks.length, 1);
  assert.equal(mocks[0].name, "top.html");
  assert.equal(mocks[0].task_id, taskId);
  assert.equal(await core.readWorkDesignMock(workId, otherTaskId, "top.html"), null);
  assert.equal(await core.readWorkDesignMock(workId, taskId, "..%2Ftop.html"), null);
  assert.equal(await core.readWorkDesignMock(workId, taskId, "missing.html"), null);
});

test("deleting a Work removes its design_mocks rows", async (t) => {
  const { core, db, runId, workId, taskId } = await seed(t, { workState: "completed" });
  await core.saveDesignMock(runId, "top.html", "<p>x</p>");
  assert.equal(rows(db, taskId).length, 1);
  await core.deleteWork(workId, command({}, createUlid(), 0));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM design_mocks").n, 0);
});

const designReport = (invocationId) => ({
  kind: "report", schema_version: "1.1.0", invocation_id: invocationId, result: "success", work_done: "Done.",
  changes: [], remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null,
  verification: {
    status: "passed", method: "Checked.", checks: [], integration_check: null,
    acceptance: [{ criterion_id: "AC1", criterion: "Done.", status: "passed", evidence: "Looked." }],
  },
});

for (const [label, assigned] of [["a lead_designer design Task", "lead_designer"], ["a designer design Task", "designer"]]) {
  const expectMocks = true;
  test(`the Reviewer design_document lists mocks for ${label}`, async (t) => {
    const reviewerContexts = [];
    let coreRef;
    let dbRef;
    const agentRunner = {
      runManagerPlan: async () => ({
        outcome: "success", report_valid: true,
        report: { event: "work.planned", tasks: [{
          id: "D1", title: "Design", type: "design", necessity: necessityFor(), acceptance_criteria: criteriaFor("Done."),
          depends_on: [], context: "", notes: "", review: true, assigned_designer: assigned, required_sections: [], required_tests: [], wait_for: null, base_sync_only: null, replaces: [],
        }] },
      }),
      runDesigner: async (request) => {
        await writeFile(request.context.design_document_path, "# Design\n\nDone.\n");
        if (expectMocks) await coreRef.saveDesignMock(dbRef.get("SELECT id FROM agent_runs WHERE role = 'designer'").id, "top.html", "<p>top</p>");
        return { outcome: "success", report_valid: true, report: designReport(request.invocation_id) };
      },
      runWorker: async () => ({ outcome: "failed" }),
      runReviewer: async (request) => {
        reviewerContexts.push(request.context);
        return { outcome: "failed" };
      },
      runAdvisor: async () => ({ reply: "" }),
    };
    const { core, db, root } = await createTestCore(t, { agentRunner, max_parallel: 2, dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 } }, { prefix: "owl-design-mocks-review-", start: true });
    coreRef = core;
    dbRef = db;
    const created = await core.createWork(command({ title: "W", summary: "x", size: "normal", project_id: null }, `test:create:${createUlid()}`));
    const workId = created.data.work_id;
    core.startWork(workId, command({ mode: "normal" }, `test:start:${createUlid()}`, created.version)).catch(() => {});
    await waitFor(() => reviewerContexts.length > 0, { timeoutMs: 15_000, message: "Reviewer launch" });
    const document = reviewerContexts[0].design_document;
    const task = db.get("SELECT id FROM tasks WHERE work_id = ? AND type = 'design'", workId);
    if (expectMocks) {
      assert.deepEqual(document.mocks, [{ name: "top.html", path: join(designMockDirectory(join(root, "data"), workId, task.id), "top.html") }]);
    } else {
      assert.equal(Object.hasOwn(document, "mocks"), false);
    }
  });
}
