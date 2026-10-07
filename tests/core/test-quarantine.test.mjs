import assert from "node:assert/strict";
import { test } from "node:test";

import { runCoreTests } from "../../packages/core/dist/core-test-run.js";
import { quarantinedFiles } from "../../packages/core/dist/test-quarantine.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { DEFAULT_TEST_RUN_SETTINGS } from "../../packages/shared/dist/test-run-settings.js";
import { TEST_RUN_SETTINGS, createStubTestRunner, openTestRunCore } from "../helpers/test-run-core.mjs";

// Files that fail on the base too are quarantined by file; a Project keeps one open backlog item for them.

const settings = { ...DEFAULT_TEST_RUN_SETTINGS, ...TEST_RUN_SETTINGS };
const rows = (db, projectId) => db.all("SELECT * FROM test_quarantine WHERE project_id = ? ORDER BY file", projectId);
const fixTasks = (db, workId) => db.all("SELECT * FROM tasks WHERE work_id = ? AND manager_task_id LIKE 'quarantine-fix:%' ORDER BY manager_task_id", workId);

async function setup(t, failing) {
  const { run } = createStubTestRunner(failing);
  const ctx = await openTestRunCore(t, { agentRunner: {}, runner: run, prefix: "owl-quarantine-" });
  const created = await ctx.core.createWork(ctx.envelope({ title: "W", summary: "x", size: "small", project_id: ctx.projectId }, "work"));
  const workId = created.data.work_id;
  const known = (names) => ctx.db.createWriteLane().transact((tx) => {
    // The latest nightly run names these failures, so a failing file counts as pre-existing without a baseline checkout.
    const failures = names.map((name) => ({ file: `tests/${name}.test.mjs`, name: `${name} works`, line: 3, message: `expected 1 to equal 2 in ${name}` }));
    const now = new Date().toISOString();
    tx.run("INSERT INTO nightly_test_runs (id, project_id, status, started_at, finished_at, failures_json) VALUES (?, ?, 'failed', ?, ?, ?)", createUlid(), ctx.projectId, now, now, JSON.stringify(failures));
  });
  const coreRun = (scope, extra = {}) => runCoreTests(
    { db: ctx.db, writeLane: ctx.db.createWriteLane(), workspaceRoot: ctx.root, baselineRunner: run, baselineLocks: new Map() },
    {
      scope, project_id: ctx.projectId, work_id: workId, task_id: null, agent_run_id: null, root: ctx.repo, commit: "c", base_commit: null, repo: ctx.repo,
      changed_files: [], work_changed_files: [], required_tests: [], force_full: "all", settings, run, ...extra,
    },
  );
  return { ...ctx, workId, known, coreRun };
}

test("a file that fails on the base too is quarantined once, skipped by the Work-level run unless the Work touched it, and released when it passes", async (t) => {
  let bFails = true;
  const ctx = await setup(t, (file) => file === "tests/b.test.mjs" && bFails);
  await ctx.known(["b"]);

  const first = await ctx.coreRun("work");
  assert.equal(first.status, "passed");
  const [row] = rows(ctx.db, ctx.projectId);
  assert.equal(row.file, "tests/b.test.mjs");
  assert.equal(row.classified_by, "nightly");
  assert.equal((await ctx.db.all("SELECT 1 FROM backlog_items WHERE source = 'test_quarantine'")).length, 1);

  // A second registration keeps the first quarantined_at.
  await ctx.db.createWriteLane().transact((tx) => tx.run("UPDATE test_quarantine SET quarantined_at = ?", "2020-01-01T00:00:00.000Z"));
  await ctx.coreRun("work", { work_changed_files: ["tests/b.test.mjs"] });
  assert.equal(rows(ctx.db, ctx.projectId)[0].quarantined_at, "2020-01-01T00:00:00.000Z");

  // The Work-level run skips it and records that.
  const skipped = await ctx.coreRun("work", { force_full: "all" });
  assert.deepEqual(skipped.selection.quarantined, ["tests/b.test.mjs"]);
  assert.ok(!skipped.passed_files.concat(skipped.failed_files).includes("tests/b.test.mjs"));

  // A Work that touched the file still runs it; it is still failing, so it stays quarantined.
  const touched = await ctx.coreRun("work", { work_changed_files: ["tests/b.test.mjs"] });
  assert.equal(touched.selection.quarantined, undefined);
  assert.ok(touched.passed_files.includes("tests/b.test.mjs"));
  assert.deepEqual(quarantinedFiles(ctx.db, ctx.projectId), ["tests/b.test.mjs"]);

  // Once it passes it leaves the list.
  bFails = false;
  await ctx.coreRun("work", { work_changed_files: ["tests/b.test.mjs"] });
  assert.deepEqual(quarantinedFiles(ctx.db, ctx.projectId), []);
});

test("a quarantined file adds no fix Task to the Work; the Project gets one open backlog item that names every quarantined file", async (t) => {
  const ctx = await setup(t, (file) => file === "tests/b.test.mjs" || file === "tests/c.test.mjs");
  await ctx.known(["b"]);
  const tasksBefore = ctx.db.all("SELECT id FROM tasks WHERE work_id = ?", ctx.workId).length;
  const items = () => ctx.db.all("SELECT * FROM backlog_items WHERE project_id = ? AND source = 'test_quarantine' AND status IN ('open', 'in_progress')", ctx.projectId);

  const first = await ctx.coreRun("work");
  assert.equal(first.fix_tasks_added, undefined);
  assert.equal(fixTasks(ctx.db, ctx.workId).length, 0);
  assert.equal(ctx.db.all("SELECT id FROM tasks WHERE work_id = ?", ctx.workId).length, tasksBefore);
  assert.equal(items().length, 1);
  assert.match(items()[0].problem, /tests\/b\.test\.mjs/);
  assert.match(items()[0].problem, /expected 1 to equal 2 in b/);

  // The same file again, another Work and another file: still one item, which now names both files.
  await ctx.coreRun("work", { work_changed_files: ["tests/b.test.mjs"] });
  assert.equal(items().length, 1);
  await ctx.known(["b", "c"]);
  const other = await ctx.core.createWork(ctx.envelope({ title: "W2", summary: "x", size: "small", project_id: ctx.projectId }, "work2"));
  await ctx.coreRun("work", { work_id: other.data.work_id, work_changed_files: ["tests/c.test.mjs"] });
  assert.equal(items().length, 1);
  assert.match(items()[0].problem, /tests\/b\.test\.mjs/);
  assert.match(items()[0].problem, /tests\/c\.test\.mjs/);
  assert.equal(ctx.db.all("SELECT 1 FROM backlog_items WHERE source = 'test_quarantine'").length, 1);

  // A failed legacy fix Task does not count as a failed Task for the Work.
  const now = new Date().toISOString();
  await ctx.db.createWriteLane().transact((tx) => tx.run(
    "INSERT INTO tasks (id, work_id, manager_task_id, title, type, status, review_decision, acceptance, context, priority, created_at, updated_at) VALUES (?, ?, 'quarantine-fix:tests/b.test.mjs', 'F', 'code', 'failed', 'not_required', 'x', '', 'normal', ?, ?)",
    createUlid(), ctx.workId, now, now,
  ));
  assert.equal(ctx.core.checkTerminalTasks(ctx.workId).anyFailed, false);
});

test("quarantine does not expire: days passing add no Work and no event", async (t) => {
  const ctx = await setup(t, (file) => file === "tests/b.test.mjs");
  await ctx.known(["b"]);
  await ctx.coreRun("work");
  await ctx.db.createWriteLane().transact((tx) => tx.run("UPDATE test_quarantine SET quarantined_at = ?", "2020-01-01T00:00:00.000Z"));
  await ctx.coreRun("work");
  assert.equal(ctx.db.all("SELECT id FROM works").length, 1);
  assert.equal(ctx.db.all("SELECT 1 FROM events WHERE type = 'test_quarantine.expired'").length, 0);
});
