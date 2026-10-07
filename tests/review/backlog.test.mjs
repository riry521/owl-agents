import assert from "node:assert/strict";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  NoopGitGateway,
  backlogDedupeKey,
  normalizeBacklogFile,
  normalizeBacklogProblem,
  registerReviewBacklogInTransaction,
} from "../../packages/core/dist/index.js";
import { nightlyTestDedupeKey } from "../../packages/core/dist/nightly-tests.js";
import { createUlid, openDatabase } from "../../packages/db/dist/index.js"; // helpers-exempt: the migration tests open a database migrated only to an older version
import { command, createTestCore } from "../helpers/core.mjs";
import { migrationsDir } from "../helpers/paths.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { tempDir } from "../helpers/temp.mjs";
import os from "node:os";
// Some runners start tests with an empty environment; child processes need PATH and HOME.
process.env.PATH ||= [process.execPath.replace(/\/[^/]+$/u, ""), "/usr/bin", "/bin"].join(":");
process.env.HOME ||= os.homedir();

async function setup(t, agentRunner = {}) {
  let root;
  const git = Object.assign(new NoopGitGateway(), { prepareWorktree: async () => ({ ok: true, worktree_path: root }) });
  const created = await createTestCore(t, {
    agentRunner,
    git,
    version: "review-backlog-test",
    dispatcher: { tick_interval_ms: 10, manager_retry_delay_ms: 1 },
  }, { prefix: "owl-review-backlog-", start: true });
  root = created.root;
  const { db, core } = created;
  assert.ok(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backlog_items'"));
  await disablePlanQuality(db);
  return { root, db, core };
}

async function createWork(core, suffix, projectId = null) {
  return (await core.createWork(command({
    title: `Work ${suffix}`,
    summary: "",
    size: "small",
    project_id: projectId,
  }, `create:${suffix}`))).data.work_id;
}

async function createProject(root, core, suffix) {
  const canonicalPath = join(root, `project-${suffix}`);
  await mkdir(canonicalPath, { recursive: true });
  return (await core.createProject(command({
    name: `Project ${suffix}`,
    canonical_path: canonicalPath,
    base_branch: "main",
    allowed_roots: [root],
    verification_plan: [],
  }, `project:${suffix}`))).data.id;
}

async function seedTaskAndReviews(db, workId, { type = "code", worktreePath = "/repo", reviews }) {
  const taskId = createUlid();
  const reviewIds = [];
  const now = "2026-09-27T00:00:00.000Z";
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, worktree_path, created_at, updated_at)
       VALUES (?, ?, 'Backlog test task', ?, 'completed', 'normal', '', '', ?, ?, ?)`,
      taskId, workId, type, worktreePath, now, now,
    );
    for (const review of reviews) {
      const reviewId = createUlid();
      reviewIds.push(reviewId);
      tx.run(
        `INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at)
         VALUES (?, ?, ?, ?, ?, '{}', ?)`,
        reviewId, taskId, review.round, review.verdict ?? "pass", JSON.stringify(review.findings), now,
      );
    }
  });
  return { taskId, reviewIds };
}

async function register(db, taskId) {
  return db.createWriteLane().transact((tx) => registerReviewBacklogInTransaction(tx, taskId, "2026-09-27T01:00:00.000Z"));
}

function minor(file, problem, extras = {}) {
  return { severity: "minor", subject: "other", file, problem, ...extras };
}

function errorCode(code) {
  return (error) => error?.code === code;
}

test("backlog normalization makes equivalent paths and findings share a key", () => {
  assert.equal(normalizeBacklogFile("/repo/apps/a.ts", "/repo"), "apps/a.ts");
  assert.equal(normalizeBacklogFile("./apps\\a.ts", "/repo"), "apps/a.ts");
  assert.equal(normalizeBacklogFile(null, "/repo"), "");
  assert.equal(normalizeBacklogProblem("Unused  import X."), normalizeBacklogProblem("unused import x"));
  assert.equal(normalizeBacklogProblem("未使用の import があります。"), normalizeBacklogProblem("未使用のimportがあります"));
  assert.notEqual(backlogDedupeKey("apps/a.ts", "same"), backlogDedupeKey("apps/b.ts", "same"));
  assert.notEqual(backlogDedupeKey("apps/a.ts", "same"), backlogDedupeKey("apps/a.ts", "different"));
  assert.match(backlogDedupeKey("apps/a.ts", "same"), /^[a-f0-9]{64}$/);
});

// Every migration from `first` on, as the directory has them now, so a new migration does not break these tests.
const migrationNumbersFrom = async (first) => (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).map((name) => name.slice(0, 3)).filter((n) => Number(n) >= first).sort();

test("backlog migration applies to a database that already ran earlier migrations", async (t) => {
  const root = await tempDir(t, "owl-review-backlog-migration-");
  const oldMigrations = join(root, "old-migrations");
  await mkdir(oldMigrations);
  const existingDb = openDatabase(join(root, "existing.sqlite")); // helpers-exempt: the database is migrated only up to an older version first
  t.after(() => existingDb.close());
  for (const filename of (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql") && Number(name.slice(0, 3)) < 18)) {
    await copyFile(join(migrationsDir, filename), join(oldMigrations, filename));
  }
  existingDb.migrate(oldMigrations);
  const applied = existingDb.migrate(migrationsDir).applied;
  assert.deepEqual(applied, await migrationNumbersFrom(18));
  assert.ok(existingDb.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backlog_items'"));
  assert.deepEqual(existingDb.migrate(migrationsDir).applied, []);
});

test("registration stores only the latest review round's minor findings", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWork(core, "dedupe");
  const { taskId, reviewIds } = await seedTaskAndReviews(db, workId, {
    reviews: [
      { round: 0, verdict: "fix_required", findings: [
        minor("apps/a.ts", "Unused import X.", { line: 2, reason: "old reason", fix: "old fix" }),
        minor("apps/b.ts", "Different finding"),
        minor("apps/a.ts", "Another issue"),
        { severity: "major", subject: "other", file: "apps/a.ts", problem: "Major finding" },
      ] },
      { round: 1, findings: [
        minor("/repo/apps\\a.ts", "unused import x", { line: 20, reason: "new reason", fix: "new fix" }),
      ] },
    ],
  });

  assert.equal(await register(db, taskId), 1);
  assert.equal(await register(db, taskId), 0, "reprocessing the Task is idempotent");
  const items = core.listBacklogItems({ work_id: workId }).items;
  assert.equal(items.length, 1);
  const duplicate = items.find((item) => item.problem === "unused import x");
  assert.equal(duplicate.file, "apps/a.ts");
  assert.equal(duplicate.line, 20);
  assert.equal(duplicate.review_round, 1);
  assert.equal(duplicate.review_id, reviewIds[1]);
  assert.equal(duplicate.reason, "new reason");
  assert.equal(duplicate.suggestion, "new fix");
  assert.equal(duplicate.project_id, null);
  const matchingOccurrences = db.all("SELECT findings_json FROM reviews WHERE task_id = ?", taskId)
    .flatMap((review) => JSON.parse(review.findings_json))
    .filter((finding) => ["apps/a.ts", "/repo/apps\\a.ts"].includes(finding.file) && ["Unused import X.", "unused import x"].includes(finding.problem));
  assert.equal(matchingOccurrences.length, 2, "the same minor appeared in two review rounds");
  assert.equal(items.filter((item) => item.problem === "unused import x").length, 1, "both occurrences share one backlog item");

  await core.dismissBacklogItems(command({ item_ids: [duplicate.id] }, "dismiss-dedupe"));
  assert.equal(await register(db, taskId), 0);
  assert.equal(core.listBacklogItems({ work_id: workId }).items.find((item) => item.id === duplicate.id).status, "dismissed");
});

test("minor findings about test results, without a subject, or in the Task's test files are not registered", async (t) => {
  const { root, db, core } = await setup(t);
  const projectId = await createProject(root, core, "test-result-subject");
  const workId = await createWork(core, "test-result-subject", projectId);
  const { taskId } = await seedTaskAndReviews(db, workId, { reviews: [{ round: 0, findings: [
    minor("tests/a.test.ts", "A test fails.", { subject: "test_result" }),
    minor("src/b.ts", "No subject.", { subject: undefined }),
    minor("src/c.ts", "Unknown subject.", { subject: "pre_existing" }),
    minor("/repo/tests/run.test.ts", "Mislabelled test file."),
    minor("src/new.ts", "New minor problem."),
    minor("", "General problem."),
  ] }] });
  const runId = createUlid();
  const at = "2026-09-27T00:00:00.000Z";
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO test_runs (id, project_id, work_id, task_id, scope, mode, commit_sha, status, started_at, finished_at)
       VALUES (?, ?, ?, ?, 'task', 'selected', 'abc', 'failed', ?, ?)`,
      runId, projectId, workId, taskId, at, at,
    );
    tx.run("INSERT INTO test_run_files (run_id, file, status) VALUES (?, 'tests/run.test.ts', 'failed')", runId);
  });

  assert.equal(await register(db, taskId), 2);
  assert.deepEqual(core.listBacklogItems({ work_id: workId }).items.map((item) => item.problem).sort(), ["General problem.", "New minor problem."]);
});

test("normal and legacy minor findings with identical file and problem share an open Project item", async (t) => {
  const { root, db, core } = await setup(t);
  const projectId = await createProject(root, core, "normal-dedupe");
  const firstWork = await createWork(core, "normal-first", projectId);
  const secondWork = await createWork(core, "normal-second", projectId);
  const first = await seedTaskAndReviews(db, firstWork, { reviews: [{ round: 0, findings: [minor("src/a.ts", "Unused import X.")] }] });
  const second = await seedTaskAndReviews(db, secondWork, { reviews: [{ round: 0, findings: [minor("src/a.ts", "Unused import X.")] }] });

  assert.equal(await register(db, first.taskId), 1);
  assert.equal(await register(db, second.taskId), 0);
  assert.equal(core.listBacklogItems({ project_id: projectId }).items.length, 1);
});

test("registration includes design Tasks and skips malformed finding shapes without throwing", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWork(core, "invalid-findings");
  const design = await seedTaskAndReviews(db, workId, {
    type: "design",
    reviews: [{ round: 0, findings: [minor("design.md", "Do not backlog design findings")] }],
  });
  assert.equal(await register(db, design.taskId), 1);
  assert.equal(core.listBacklogItems({ work_id: workId }).items.length, 1);

  const malformed = await seedTaskAndReviews(db, workId, {
    reviews: [
      { round: 0, findings: ["not an object", minor("a.ts", "   ")] },
      { round: 1, findings: { severity: "minor", pre_existing: false, problem: "not an array" } },
    ],
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    assert.equal(await register(db, malformed.taskId), 0);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
});

test("a reviewed design Task completed by a minor-only pass stores its finding", async (t) => {
  const finding = minor("src/reviewed.ts", "Unused helper remains.", { line: 4, reason: "It is no longer called.", fix: "Remove the helper." });
  const runner = {
    runManagerPlan: async (request) => (request.mode ?? request.context?.mode) === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [
          { id: "T1", title: "Review this design", type: "design", acceptance: "Pass review.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: true },
        ] } }
      : request.mode === "replan"
        ? { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [] } }
        : { outcome: "success", report_valid: true, report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } },
    runDesigner: async (request) => {
      await mkdir(dirname(request.context.design_document_path), { recursive: true });
      await writeFile(request.context.design_document_path, "# Reviewed design\n");
      return {
        outcome: "success", report_valid: true,
        report: {
        kind: "report", schema_version: "1.0.0", invocation_id: request.invocation_id,
        result: "success", work_done: "Designed the approach.", changes: [],
        verification: { passed: true, method: "Checked." }, remaining_issues: [],
        next_action: "none", needs_replanning: false, question_for_manager: null,
        },
      };
    },
    runWorker: async () => { throw new Error("design Task must run as Designer"); },
    runReviewer: async () => ({
      outcome: "success", report_valid: true, report: { verdict: "pass", findings: [finding], tests: {} },
      review: { verdict: "pass", findings: [finding], tests: {} },
    }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await setup(t, runner);
  const workId = (await core.createWork(command({ title: "Review pass", summary: "", size: "normal", project_id: null }, "workflow-create"))).data.work_id;
  const created = core.getWork(workId);
  await core.startWork(workId, command({ mode: "normal" }, "workflow-start", created.version));

  const deadline = Date.now() + 10_000;
  let item;
  while (Date.now() < deadline) {
    item = db.get("SELECT * FROM backlog_items WHERE work_id = ?", workId);
    if (item) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.ok(item, "minor finding was registered when the Task completed");
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", item.task_id).status, "completed");
  assert.equal(db.get("SELECT type FROM tasks WHERE id = ?", item.task_id).type, "design");
  assert.equal(item.problem, finding.problem);
  assert.equal(item.suggestion, finding.fix);
  const workDeadline = Date.now() + 10_000;
  while (Date.now() < workDeadline && db.get("SELECT state FROM works WHERE id = ?", workId)?.state !== "completed") {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
});

test("a retry after mixed fix_required findings receives only major findings while review JSON retains both", async (t) => {
  const major = { severity: "major", pre_existing: false, file: "src/core.ts", line: 10, problem: "The required path still fails.", reason: "Acceptance is not met.", fix: "Handle the missing case." };
  const minorFinding = { severity: "minor", pre_existing: false, file: "src/core.ts", line: 12, problem: "This name could be clearer.", reason: "It is only a readability concern.", fix: "Rename the local variable." };
  const workerContexts = [];
  const reviewerPrevious = [];
  let reviewCalls = 0;
  const runner = {
    runManagerPlan: async (request) => (request.mode ?? request.context?.mode) === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [
          { id: "T1", title: "Implement the reviewed change", type: "code", acceptance: "The required path succeeds.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: true },
        ] } }
      : { outcome: "success", report_valid: true, report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } },
    runWorker: async (request) => {
      workerContexts.push(request.context);
      await writeFile(join(request.context.worktree, "a.mjs"), "export const x = 1;\n");
      return {
        outcome: "success",
        report_valid: true,
        report: {
          kind: "report", schema_version: "1.0.0", invocation_id: request.invocation_id,
          result: "success", work_done: "Implemented and verified the required path.", changes: [],
          verification: { passed: true, method: "Checked the change." }, remaining_issues: [],
          next_action: "none", needs_replanning: false, question_for_manager: null,
        },
      };
    },
    runReviewer: async (request) => {
      reviewCalls += 1;
      reviewerPrevious.push(request.context.previous_minor_findings);
      const review = reviewCalls === 1
        ? { verdict: "fix_required", summary: "One blocking issue and one minor concern.", findings: [major, minorFinding], tests: { ran: false, command: "none", passed: 0, failed: 0 } }
        : { verdict: "pass", summary: "The required path is correct.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } };
      return {
        outcome: review.verdict === "pass" ? "success" : "failed",
        report_valid: true,
        report: review,
        review,
      };
    },
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await setup(t, runner);
  const workId = (await core.createWork(command({ title: "Mixed review findings", summary: "", size: "normal", project_id: null }, "mixed-findings-create"))).data.work_id;
  const created = core.getWork(workId);
  await core.startWork(workId, command({ mode: "normal" }, "mixed-findings-start", created.version));

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && db.get("SELECT state FROM works WHERE id = ?", workId)?.state !== "completed") {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.equal(reviewCalls, 2);
  assert.equal(workerContexts.length, 2);
  assert.deepEqual(workerContexts[1].reviewer_findings, [major]);
  assert.equal(reviewerPrevious[0], null);
  assert.deepEqual(reviewerPrevious[1], [minorFinding]);
  const storedReview = db.get("SELECT verdict, findings_json FROM reviews WHERE task_id = (SELECT id FROM tasks WHERE work_id = ?)", workId);
  assert.equal(storedReview.verdict, "fix_required");
  assert.deepEqual(JSON.parse(storedReview.findings_json), [major, minorFinding]);
});

test("Core filters, dismisses, issues Work atomically, and handles missing or non-open items", async (t) => {
  const { root, db, core } = await setup(t);
  const projectA = await createProject(root, core, "a");
  const projectB = await createProject(root, core, "b");
  const workA = await createWork(core, "filter-a", projectA);
  const workB = await createWork(core, "filter-b", projectB);
  const taskA = await seedTaskAndReviews(db, workA, { reviews: [{ round: 0, findings: [minor("a.ts", "A one"), minor("b.ts", "A two"), minor("c.ts", "A three")] }] });
  const taskB = await seedTaskAndReviews(db, workB, { reviews: [{ round: 0, findings: [minor("a.ts", "B one")] }] });
  await register(db, taskA.taskId);
  await register(db, taskB.taskId);
  const projectAItems = core.listBacklogItems({ project_id: projectA }).items;
  const projectBItems = core.listBacklogItems({ project_id: projectB }).items;
  assert.equal(projectAItems.length, 3);
  assert.equal(projectBItems.length, 1);
  assert.equal(core.listBacklogItems({ work_id: workA }).items.length, 3);
  assert.equal(core.listBacklogItems({ status: "open" }).items.length, 4);
  assert.throws(() => core.listBacklogItems({ status: "invalid" }), errorCode("validation_error"));
  assert.throws(() => core.listBacklogItems({ limit: 0 }), errorCode("validation_error"));
  assert.throws(() => core.listBacklogItems({ limit: 501 }), errorCode("validation_error"));
  assert.throws(() => core.listBacklogItems({ offset: -1 }), errorCode("validation_error"));
  assert.throws(() => core.listBacklogItems({ work_id: createUlid() }), errorCode("work_not_found"));

  const [dismissed, issuable] = projectAItems;
  const dismissResult = await core.dismissBacklogItems(command({ item_ids: [dismissed.id] }, "dismiss"));
  assert.equal(dismissResult.data.items[0].status, "dismissed");
  await assert.rejects(core.dismissBacklogItems(command({ item_ids: [dismissed.id] }, "dismiss-again")), errorCode("invalid_state_transition"));
  await assert.rejects(core.dismissBacklogItems(command({ item_ids: [createUlid()] }, "dismiss-missing")), errorCode("backlog_item_not_found"));
  await assert.rejects(core.dismissBacklogItems(command({ item_ids: [] }, "dismiss-empty")), errorCode("validation_error"));

  await assert.rejects(core.issueBacklogWork(command({ item_ids: [issuable.id, projectBItems[0].id], title: "Mixed", summary: "", size: "small" }, "issue-mixed")), errorCode("validation_error"));
  const issuePayload = { item_ids: [issuable.id], title: "Fix backlog finding", summary: "", size: "small" };
  const issueRequest = command(issuePayload, "issue-once");
  const issued = await core.issueBacklogWork(issueRequest);
  const replayed = await core.issueBacklogWork({ ...issueRequest, request_id: createUlid() });
  assert.equal(replayed.data.work_id, issued.data.work_id);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM works WHERE title = 'Fix backlog finding'").count, 1);
  const issuedWork = db.get("SELECT state, project_id FROM works WHERE id = ?", issued.data.work_id);
  assert.equal(issuedWork.state, "memo");
  assert.equal(issuedWork.project_id, projectA);
  const done = core.listBacklogItems({ work_id: workA }).items.find((item) => item.id === issuable.id);
  assert.equal(done.status, "in_progress");
  assert.equal(done.issued_work_id, issued.data.work_id);
  await assert.rejects(core.issueBacklogWork(command({ ...issuePayload, title: "Again" }, "issue-done")), errorCode("invalid_state_transition"));
  await assert.rejects(core.issueBacklogWork(command({ ...issuePayload, item_ids: [createUlid()] }, "issue-missing")), errorCode("backlog_item_not_found"));

  const deleteTarget = issued.data.work_id;
  await db.createWriteLane().transact((tx) => tx.run(
    "UPDATE works SET state = 'completed', state_version = state_version + 1, completed_at = ?, updated_at = ? WHERE id = ?",
    "2026-09-27T02:00:00.000Z", "2026-09-27T02:00:00.000Z", deleteTarget,
  ));
  const archive = await core.archiveWork(deleteTarget, command({}, "archive-issued", 1));
  await core.deleteWork(deleteTarget, command({}, "delete-issued", archive.version));
  const reopened = core.listBacklogItems({ work_id: workA }).items.find((item) => item.id === issuable.id);
  assert.equal(reopened.status, "open");
  assert.equal(reopened.issued_work_id, null);

  // Deleting an issued Work dismisses (instead of reopening) an item whose key is already open in the project.
  const dupWorkId = await createWork(core, "dup-key", projectA);
  const dupTask = await seedTaskAndReviews(db, dupWorkId, { reviews: [{ round: 0, findings: [minor("d.ts", "Dup one")] }] });
  await register(db, dupTask.taskId);
  const dupItem = core.listBacklogItems({ work_id: dupWorkId }).items[0];
  const dupIssued = await core.issueBacklogWork(command({ item_ids: [dupItem.id], title: "Dup issue", summary: "", size: "small" }, "issue-dup"));
  const dupOther = await createWork(core, "dup-key-2", projectA);
  const dupTask2 = await seedTaskAndReviews(db, dupOther, { reviews: [{ round: 0, findings: [minor("d.ts", "Dup one")] }] });
  await register(db, dupTask2.taskId);
  await db.createWriteLane().transact((tx) => tx.run(
    "UPDATE works SET state = 'completed', state_version = state_version + 1, completed_at = ?, updated_at = ? WHERE id = ?",
    "2026-09-27T02:30:00.000Z", "2026-09-27T02:30:00.000Z", dupIssued.data.work_id,
  ));
  const dupArchive = await core.archiveWork(dupIssued.data.work_id, command({}, "archive-dup", 1));
  await core.deleteWork(dupIssued.data.work_id, command({}, "delete-dup", dupArchive.version));
  assert.equal(core.listBacklogItems({ work_id: dupWorkId }).items.find((item) => item.id === dupItem.id).status, "dismissed");
  assert.equal(core.listBacklogItems({ project_id: projectA, status: "open" }).items.filter((item) => item.file === "d.ts").length, 1);

  // A done item (linked later to a completed Work) returns to open when that Work is deleted.
  const doneSrc = await createWork(core, "done-src", projectA);
  const doneTask = await seedTaskAndReviews(db, doneSrc, { reviews: [{ round: 0, findings: [minor("e.ts", "Done one")] }] });
  await register(db, doneTask.taskId);
  const doneItem = core.listBacklogItems({ work_id: doneSrc }).items[0];
  const doneTarget = await createWork(core, "done-target", projectA);
  await db.createWriteLane().transact((tx) => tx.run(
    "UPDATE works SET state = 'completed', state_version = state_version + 1, completed_at = ?, updated_at = ? WHERE id = ?",
    "2026-09-27T02:45:00.000Z", "2026-09-27T02:45:00.000Z", doneTarget,
  ));
  await core.linkBacklogItems(doneTarget, command({ item_ids: [doneItem.id] }, "link-done-delete"));
  assert.equal(core.listBacklogItems({ work_id: doneSrc }).items[0].status, "done");
  const doneArchive = await core.archiveWork(doneTarget, command({}, "archive-done-target", 1));
  await core.deleteWork(doneTarget, command({}, "delete-done-target", doneArchive.version));
  const backOpen = core.listBacklogItems({ work_id: doneSrc }).items[0];
  assert.deepEqual([backOpen.status, backOpen.issued_work_id], ["open", null]);

  const sourceId = workA;
  await db.createWriteLane().transact((tx) => tx.run(
    "UPDATE works SET state = 'completed', state_version = state_version + 1, completed_at = ?, updated_at = ? WHERE id = ?",
    "2026-09-27T03:00:00.000Z", "2026-09-27T03:00:00.000Z", sourceId,
  ));
  const sourceArchive = await core.archiveWork(sourceId, command({}, "archive-source", 1));
  await core.deleteWork(sourceId, command({}, "delete-source", sourceArchive.version));
  assert.equal(db.get("SELECT COUNT(*) AS count FROM backlog_items WHERE work_id = ?", sourceId).count, 0);
});

test("backlog pagination reaches every item without duplicates and keeps filters across pages", async (t) => {
  const { root, db, core } = await setup(t);
  const projectA = await createProject(root, core, "page-a");
  const projectB = await createProject(root, core, "page-b");
  const workA = await createWork(core, "page-a", projectA);
  const workB = await createWork(core, "page-b", projectB);
  const taskA = await seedTaskAndReviews(db, workA, {
    reviews: [{ round: 0, findings: Array.from({ length: 6 }, (_, index) => minor(`src/a${index}.ts`, `Finding A${index}`)) }],
  });
  const taskB = await seedTaskAndReviews(db, workB, {
    reviews: [{ round: 0, findings: [minor("src/b0.ts", "Finding B0"), minor("src/b1.ts", "Finding B1")] }],
  });
  await register(db, taskA.taskId);
  await register(db, taskB.taskId);

  const allItems = [];
  let offset = 0;
  while (true) {
    const page = core.listBacklogItems({ limit: 2, offset });
    allItems.push(...page.items);
    if (page.next_offset === null) break;
    assert.equal(page.next_offset, offset + page.items.length);
    offset = page.next_offset;
  }
  const allIds = allItems.map((item) => item.id);
  assert.equal(allIds.length, 8);
  assert.equal(new Set(allIds).size, 8);
  assert.deepEqual(new Set(allIds), new Set(db.all("SELECT id FROM backlog_items").map((row) => row.id)));

  const dismissed = allItems.find((item) => item.work_id === workA);
  await core.dismissBacklogItems(command({ item_ids: [dismissed.id] }, "page-dismiss"));
  const filteredItems = [];
  offset = 0;
  while (true) {
    const page = core.listBacklogItems({ project_id: projectA, status: "open", work_id: workA, limit: 2, offset });
    filteredItems.push(...page.items);
    if (page.next_offset === null) break;
    offset = page.next_offset;
  }
  assert.equal(filteredItems.length, 5);
  assert.ok(filteredItems.every((item) => item.project_id === projectA && item.work_id === workA && item.status === "open"));
  assert.equal(core.listBacklogItems({ project_id: projectA, status: "dismissed", work_id: workA }).items.length, 1);
});

async function seedItem(db, core, workId, suffix) {
  const task = await seedTaskAndReviews(db, workId, { reviews: [{ round: 0, findings: [minor(`${suffix}.ts`, `Problem ${suffix}`)] }] });
  await register(db, task.taskId);
  return core.listBacklogItems({ work_id: workId }).items.find((item) => item.file === `${suffix}.ts`);
}

function setWorkState(db, workId, state) {
  return db.createWriteLane().transact((tx) => tx.run(
    "UPDATE works SET state = ?, state_version = state_version + 1 WHERE id = ?", state, workId,
  ));
}

test("backlog rows created before the issued-work migration keep status and issued_work_id", async (t) => {
  const root = await tempDir(t, "owl-backlog-old-");
  const oldMigrations = join(root, "old-migrations");
  await mkdir(oldMigrations);
  const db = openDatabase(join(root, "old.sqlite")); // helpers-exempt: the database is migrated only up to an older version first
  t.after(() => db.close());
  for (const filename of (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql") && Number(name.slice(0, 3)) < 26)) {
    await copyFile(join(migrationsDir, filename), join(oldMigrations, filename));
  }
  db.migrate(oldMigrations);
  const source = createUlid();
  const taskId = createUlid();
  const reviewId = createUlid();
  const now = "2026-09-27T00:00:00.000Z";
  const workIds = { completed: createUlid(), running: createUlid(), cancelled: createUlid() };
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    for (const [id, state] of [[source, "completed"], ...Object.entries(workIds).map(([state, id]) => [id, state])]) {
      tx.run("INSERT INTO works (id, title, summary, size, state, state_version, owner_id, rules_json, related_work_ids_json, created_at, updated_at) VALUES (?, 'W', '', 'small', ?, 1, 'owner:default', '{}', '[]', ?, ?)", id, state, now, now);
    }
    tx.run("INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at) VALUES (?, ?, 'T', 'code', 'completed', 'normal', '', '', ?, ?)", taskId, source, now, now);
    tx.run("INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at) VALUES (?, ?, 0, 'pass', '[]', '{}', ?)", reviewId, taskId, now);
    const rows = [
      ["open", "open", null], ["dismissed", "dismissed", null],
      ["done-completed", "done", workIds.completed], ["done-running", "done", workIds.running], ["done-cancelled", "done", workIds.cancelled],
    ];
    for (const [key, status, issued] of rows) {
      tx.run(
        `INSERT INTO backlog_items (id, work_id, task_id, project_id, review_id, review_round, file, line, problem, reason, suggestion, status, issued_work_id, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, 0, 'f.ts', 0, 'p', '', '', ?, ?, ?, ?, ?)`,
        `item-${key}`, source, taskId, reviewId, status, issued, key, now, now,
      );
    }
  });
  assert.deepEqual(db.migrate(migrationsDir).applied, await migrationNumbersFrom(26));
  const rows = Object.fromEntries(db.all("SELECT id, status, issued_work_id FROM backlog_items").map((row) => [row.id, row]));
  assert.deepEqual(rows["item-open"], { id: "item-open", status: "open", issued_work_id: null });
  assert.deepEqual(rows["item-dismissed"], { id: "item-dismissed", status: "dismissed", issued_work_id: null });
  assert.deepEqual([rows["item-done-completed"].status, rows["item-done-completed"].issued_work_id], ["done", workIds.completed]);
  assert.deepEqual([rows["item-done-running"].status, rows["item-done-running"].issued_work_id], ["done", workIds.running]);
  assert.deepEqual([rows["item-done-cancelled"].status, rows["item-done-cancelled"].issued_work_id], ["done", workIds.cancelled]);
  assert.equal(db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'backlog_items' AND name LIKE 'backlog_items_%'").length, 4);
});

test("issue-work links in_progress, completion makes done, cancel returns open", async (t) => {
  const { root, db, core } = await setup(t);
  const project = await createProject(root, core, "lifecycle");
  const source = await createWork(core, "source", project);
  const doneItem = await seedItem(db, core, source, "a");
  const cancelItem = await seedItem(db, core, source, "b");
  const issue = async (item, suffix) => (await core.issueBacklogWork(command({ item_ids: [item.id], title: suffix, summary: "", size: "small" }, `issue-${suffix}`))).data.work_id;
  const doneWork = await issue(doneItem, "done");
  const cancelWork = await issue(cancelItem, "cancel");
  assert.deepEqual(core.listBacklogItems({ status: "in_progress" }).items.map((item) => item.id).sort(), [doneItem.id, cancelItem.id].sort());
  assert.equal(core.listBacklogItems({ issued_work_id: doneWork }).items.length, 1);

  await db.createWriteLane().transact((tx) => tx.run(
    "INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at) VALUES (?, ?, 'T', 'code', 'completed', 'normal', '', '', '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z')",
    createUlid(), doneWork,
  ));
  await setWorkState(db, doneWork, "running");
  assert.equal(await core.workflowEngine().completeWorkIfReady(doneWork, "complete"), true);
  const completed = core.listBacklogItems({ issued_work_id: doneWork }).items[0];
  assert.deepEqual([completed.status, completed.issued_work_id], ["done", doneWork]);

  const other = await seedTaskAndReviews(db, source, { reviews: [{ round: 0, findings: [] }] });
  await db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO backlog_items (id, work_id, task_id, project_id, review_id, review_round, file, line, problem, reason, suggestion, status, issued_work_id, dedupe_key, created_at, updated_at)
     SELECT 'dup-open', work_id, ?, project_id, ?, review_round, file, line, problem, reason, suggestion, 'open', NULL, dedupe_key, created_at, updated_at
       FROM backlog_items WHERE id = ?`,
    other.taskId, other.reviewIds[0], cancelItem.id,
  ));
  const version = db.get("SELECT state_version FROM works WHERE id = ?", cancelWork).state_version;
  await core.cancelWork(cancelWork, command({ reason: "no longer needed" }, "cancel", version));
  const returned = core.listBacklogItems({ work_id: source }).items.find((item) => item.id === cancelItem.id);
  assert.deepEqual([returned.status, returned.issued_work_id], ["open", null]);
});

test("linking later: done for a completed Work, in_progress for a running one, rejects invalid targets", async (t) => {
  const { root, db, core } = await setup(t);
  const projectA = await createProject(root, core, "link-a");
  const projectB = await createProject(root, core, "link-b");
  const source = await createWork(core, "link-source", projectA);
  const sourceB = await createWork(core, "link-source-b", projectB);
  const items = [];
  for (const key of ["a", "b", "c", "d", "e"]) items.push(await seedItem(db, core, source, key));
  const itemB = await seedItem(db, core, sourceB, "z");
  const link = (workId, ids, suffix) => core.linkBacklogItems(workId, command({ item_ids: ids }, `link-${suffix}`));

  const finished = await createWork(core, "finished", projectA);
  await setWorkState(db, finished, "completed");
  const linkedDone = await link(finished, [items[0].id], "done");
  assert.equal(linkedDone.data.status, "done");
  assert.deepEqual(linkedDone.data.items.map((item) => [item.status, item.issued_work_id]), [["done", finished]]);

  const running = await createWork(core, "running", projectA);
  await setWorkState(db, running, "running");
  const linkedRunning = await link(running, [items[1].id], "running");
  assert.equal(linkedRunning.data.status, "in_progress");
  assert.equal(linkedRunning.data.items[0].status, "in_progress");

  const cancelled = await createWork(core, "cancelled", projectA);
  await setWorkState(db, cancelled, "cancelled");
  await assert.rejects(link(cancelled, [items[2].id], "cancelled"), errorCode("invalid_state_transition"));
  await assert.rejects(link(running, [itemB.id], "other-project"), errorCode("validation_error"));
  await assert.rejects(link(running, [items[0].id], "not-open"), errorCode("invalid_state_transition"));
  await assert.rejects(link(running, [items[1].id], "already-linked"), errorCode("invalid_state_transition"));
  await assert.rejects(link(createUlid(), [items[2].id], "no-work"), errorCode("work_not_found"));
  assert.equal(core.listBacklogItems({ status: "open", work_id: source }).items.length, 3);
});

const advisorRunner = {
  runManagerPlan: async () => { throw new Error("unexpected"); },
  runWorker: async () => ({ outcome: "failed", failure_class: "deterministic", error_key: "advisor_backlog_test", retry_allowed: false, message: "stop" }),
  runReviewer: async () => { throw new Error("unexpected"); },
};

async function seedOpenItem(db, workId, problem) {
  const { taskId } = await seedTaskAndReviews(db, workId, { reviews: [{ round: 1, findings: [minor("a.ts", problem)] }] });
  await register(db, taskId);
  return db.get("SELECT id FROM backlog_items WHERE problem = ?", problem).id;
}

function createAction(payload) {
  return { type: "create_work", description: "d", payload: { title: "Advisor Work", summary: "Do it.", size: "small", ...payload } };
}

test("Advisor create_work links and dismisses backlog items atomically, and rejects bad ids", async (t) => {
  const { root, db, core } = await setup(t, advisorRunner);
  const projectA = await createProject(root, core, "adv-a");
  const projectB = await createProject(root, core, "adv-b");
  const sourceA = await createWork(core, "src-a", projectA);
  const sourceB = await createWork(core, "src-b", projectB);
  const link = await seedOpenItem(db, sourceA, "link me");
  const drop = await seedOpenItem(db, sourceA, "drop me");
  const other = await seedOpenItem(db, sourceB, "other project");
  const status = (id) => db.get("SELECT status, issued_work_id FROM backlog_items WHERE id = ?", id);
  const worksTitled = () => db.get("SELECT COUNT(*) AS count FROM works WHERE title = 'Advisor Work'").count;

  for (const [suffix, bad] of [["other", { backlog_item_ids: [other] }], ["missing", { dismiss_backlog_item_ids: ["nope"] }], ["wrong-dismiss", { dismiss_backlog_item_ids: [other] }], ["null-link", { backlog_item_ids: null }], ["null-dismiss", { dismiss_backlog_item_ids: null }]]) {
    const { notices } = await core.dispatchAdvisorWorkActions("c", `turn-bad-${suffix}`, [createAction({ project_id: projectA, ...bad })]);
    assert.match(notices[0], /Workの起票に失敗しました/u);
    assert.equal(worksTitled(), 0);
    assert.equal(status(other).status, "open");
    assert.equal(status(link).status, "open");
  }

  const { notices } = await core.dispatchAdvisorWorkActions("c", "turn-ok", [createAction({
    project_id: projectA, backlog_item_ids: [link], dismiss_backlog_item_ids: [drop],
  })]);
  assert.match(notices[0], /起票し/u);
  const work = db.get("SELECT id, summary, advisor_backlog_json FROM works WHERE title = 'Advisor Work'");
  assert.deepEqual({ ...status(link) }, { status: "in_progress", issued_work_id: work.id });
  assert.equal(status(drop).status, "dismissed");
  assert.equal(work.summary, "Do it.");
  const stored = JSON.parse(work.advisor_backlog_json);
  assert.deepEqual([stored.linked.map((i) => i.id), stored.dismissed.map((i) => i.id)], [[link], [drop]]);
  assert.deepEqual(core.managerWorkContext(work.id).advisor_backlog, stored);
  assert.deepEqual(core.getWork(work.id).data.advisor_backlog, stored);
  const plain = (await core.createWork(command({ title: "Plain", summary: "s", size: "normal", project_id: null }, "plain-create"))).data.work_id;
  assert.equal(core.managerWorkContext(plain).advisor_backlog, null);
  assert.equal(core.getWork(plain).data.advisor_backlog, null);
  for (const bad of ["{}", "[]", "5", '{"linked":[],"dismissed":[{"id":1}]}']) {
    await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET advisor_backlog_json = ? WHERE id = ?", bad, plain));
    assert.equal(core.getWork(plain).data.advisor_backlog, null, bad);
  }

  const again = await core.dispatchAdvisorWorkActions("c", "turn-reuse", [createAction({ project_id: projectA, backlog_item_ids: [link] })]);
  assert.match(again.notices[0], /起票に失敗/u);
  assert.equal(worksTitled(), 1);
});

test("Advisor prompt has no open count and points to GET /api/v1/backlog, not the items", async (t) => {
  const { db, core } = await setup(t, advisorRunner);
  const workId = await createWork(core, "prompt");
  await seedOpenItem(db, workId, "secret finding text");
  const prompt = core.buildAdvisorSystemPrompt();
  assert.doesNotMatch(prompt, /\d+ open item/u);
  assert.ok(prompt.includes("GET /api/v1/backlog"));
  assert.ok(prompt.includes("backlog_item_ids") && prompt.includes("dismiss_backlog_item_ids"));
  assert.ok(!prompt.includes("secret finding text"));
});
