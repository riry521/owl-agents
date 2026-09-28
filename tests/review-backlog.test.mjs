import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  Core,
  NoopGitGateway,
  backlogDedupeKey,
  normalizeBacklogFile,
  normalizeBacklogProblem,
  registerReviewBacklogInTransaction,
} from "../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = join(repoRoot, "packages/db/migrations");

function command(payload, suffix, expectedVersion = 0) {
  return {
    request_id: createUlid(),
    idempotency_key: `review-backlog:${suffix}`,
    expected_version: expectedVersion,
    payload,
  };
}

async function setup(t, agentRunner = {}) {
  const root = await mkdtemp(join(tmpdir(), "owl-review-backlog-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  assert.ok(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backlog_items'"));
  const core = new Core({
    db,
    agentRunner,
    git: new NoopGitGateway(),
    version: "review-backlog-test",
    owlRoot: root,
    dispatcher: { tick_interval_ms: 10, manager_retry_delay_ms: 1 },
  });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  await core.start();
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
  return { severity: "minor", file, problem, ...extras };
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

test("backlog migration applies to a database that already ran earlier migrations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-review-backlog-migration-"));
  const oldMigrations = join(root, "old-migrations");
  await mkdir(oldMigrations);
  const existingDb = openDatabase(join(root, "existing.sqlite"));
  t.after(async () => {
    existingDb.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const filename of (await readdir(migrations)).filter((name) => name.endsWith(".sql") && Number(name.slice(0, 3)) < 18)) {
    await copyFile(join(migrations, filename), join(oldMigrations, filename));
  }
  existingDb.migrate(oldMigrations);
  const applied = existingDb.migrate(migrations).applied;
  assert.deepEqual(applied, ["018", "019", "020", "021", "022", "023", "024"]);
  assert.ok(existingDb.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backlog_items'"));
  assert.deepEqual(existingDb.migrate(migrations).applied, []);
});

test("registration keeps minor findings once per Task and retains the latest round", async (t) => {
  const { db, core } = await setup(t);
  const workId = await createWork(core, "dedupe");
  const { taskId, reviewIds } = await seedTaskAndReviews(db, workId, {
    reviews: [
      { round: 0, verdict: "fix_required", findings: [
        minor("apps/a.ts", "Unused import X.", { line: 2, reason: "old reason", fix: "old fix" }),
        minor("apps/b.ts", "Different finding"),
        minor("apps/a.ts", "Another issue"),
        { severity: "major", file: "apps/a.ts", problem: "Major finding" },
      ] },
      { round: 1, findings: [
        minor("/repo/apps\\a.ts", "unused import x", { line: 20, reason: "new reason", fix: "new fix" }),
      ] },
    ],
  });

  assert.equal(await register(db, taskId), 3);
  assert.equal(await register(db, taskId), 0, "reprocessing the Task is idempotent");
  const items = core.listBacklogItems({ work_id: workId }).items;
  assert.equal(items.length, 3);
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
      { round: 0, findings: { severity: "minor", problem: "not an array" } },
      { round: 1, findings: ["not an object", minor("a.ts", "   ")] },
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
          { id: "T1", title: "Review this design", type: "design", acceptance: "Pass review.", depends_on: [], replaces: [], review: true },
        ] } }
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
  const major = { severity: "major", file: "src/core.ts", line: 10, problem: "The required path still fails.", reason: "Acceptance is not met.", fix: "Handle the missing case." };
  const minorFinding = { severity: "minor", file: "src/core.ts", line: 12, problem: "This name could be clearer.", reason: "It is only a readability concern.", fix: "Rename the local variable." };
  const workerContexts = [];
  let reviewCalls = 0;
  const runner = {
    runManagerPlan: async (request) => (request.mode ?? request.context?.mode) === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [
          { id: "T1", title: "Implement the reviewed change", type: "code", acceptance: "The required path succeeds.", depends_on: [], replaces: [], review: true },
        ] } }
      : { outcome: "success", report_valid: true, report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } },
    runWorker: async (request) => {
      workerContexts.push(request.context);
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
    runReviewer: async () => {
      reviewCalls += 1;
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
  assert.equal(done.status, "done");
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
