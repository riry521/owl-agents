import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { judgeReviewerFix } from "../../packages/core/dist/reviewer-fix.js";
import { recoverOrphanedState } from "../../packages/core/dist/startup-recovery.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";
import { necessityFor, criteriaFor } from "../helpers/necessity.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { waitFor } from "../helpers/wait.mjs";
import os from "node:os";
// Some runners start tests with an empty environment; child processes need PATH and HOME.
process.env.PATH ||= [process.execPath.replace(/\/[^/]+$/u, ""), "/usr/bin", "/bin"].join(":");
process.env.HOME ||= os.homedir();

// A Reviewer may fix a small blocking finding in place. Core measures what it changed, judges it, runs the Task's tests
// and either keeps the fix (the Task completes) or puts every file back and sends the Task to a second Worker call.

const FEATURE = "src/feature.mjs";
const TESTS = { ran: false, command: "none", passed: 0, failed: 0 };
const sha = (text) => createHash("sha256").update(text).digest("hex");
const lines = (count, tag) => Array.from({ length: count }, (_, index) => `export const ${tag}${index} = ${index};`).join("\n") + "\n";

const FINDING = {
  severity: "major", scope: "in_scope", target: "deliverable", subject: "other", pre_existing: false,
  file: FEATURE, line: 1, problem: "A constant has the wrong value.", reason: "The acceptance needs the right value.", fix: "Change the value.",
};

const workerReport = (invocationId) => ({
  kind: "report", schema_version: "1.1.0", invocation_id: invocationId, result: "success", work_done: "Implemented.", changes: [],
  verification: { status: "passed", acceptance: [{ criterion_id: "AC1", criterion: "c", status: "passed", evidence: "ok" }], checks: [], method: "Checked.", integration_check: null },
  remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null,
});

const failPlan = [{
  command_id: "no-broken-marker",
  argv: ["node", "-e", `process.exit(require("node:fs").readFileSync("${FEATURE}", "utf8").includes("BROKEN") ? 1 : 0)`],
  cwd: ".", env_allowlist: [], timeout_seconds: 15, stdout_limit: 1_024, stderr_limit: 1_024, expected_exit_codes: [0], executor: "core",
}];

const fixEntry = (file, extra = {}) => ({ finding_index: 0, file, line_start: 1, line_end: 1, change: "Changed the value.", ...extra });

/** A review result as the runner returns it. */
const reviewResult = (review) => ({ outcome: review.verdict === "pass" ? "success" : "failed", report_valid: true, report: review, review });
const passReview = () => ({ verdict: "pass", summary: "Good.", findings: [], tests: TESTS });
const fixReview = (fixes, findings = [FINDING]) => ({ verdict: "fix_required", summary: "One small blocking finding.", findings, fixes, tests: TESTS });

/**
 * One Project Work with one reviewed Task.
 * `files` is what the Worker writes (path -> text); `reviews[n]` is the function the n-th Reviewer call runs:
 * it may edit the worktree through `edit(request, path, text)` and returns the review.
 */
async function open(t, { files = { [FEATURE]: lines(20, "v") }, reviews, plan = [], settings = null, finalizeGate = null } = {}) {
  const state = { workerCalls: 0, reviewCalls: 0, before: {}, startHashes: [], restores: [], touched: new Set(), replans: [], requests: [], restoreOverride: null };
  const hashOf = async (worktree, path) => sha(await readFile(join(worktree, path), "utf8").catch(() => "<absent>"));
  const edit = async (request, path, text) => {
    const target = join(request.context.worktree, path);
    state.before[path] ??= await hashOf(request.context.worktree, path);
    state.touched.add(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  };
  const agentRunner = {
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") {
        return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{
          id: "T1", title: "Implement the feature", type: "code", necessity: necessityFor(), acceptance_criteria: criteriaFor("The feature works."),
          depends_on: [], required_sections: [], required_tests: [], replaces: [], review: true,
        }] } };
      }
      if (mode === "finalize") {
        await finalizeGate;
        return { outcome: "success", report_valid: true, report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } };
      }
      state.replans.push(request);
      return { outcome: "failed", message: `no replan in this test (${mode})` };
    },
    runWorker: async (request) => {
      state.workerCalls += 1;
      state.startHashes.push(Object.fromEntries(await Promise.all(Object.keys(files).map(async (path) => [path, await hashOf(request.context.worktree, path)]))));
      for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(request.context.worktree, path)), { recursive: true });
        await writeFile(join(request.context.worktree, path), text);
      }
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async (request) => {
      state.reviewCalls += 1;
      state.requests.push(request);
      const script = reviews[state.reviewCalls - 1];
      return reviewResult(script ? await script(request, { edit, state }) : passReview());
    },
    runAdvisor: async () => ({ reply: "" }),
  };
  const { root, db, core } = await createTestCore(t, { agentRunner, dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 } }, { prefix: "owl-reviewer-fix-", start: true });
  await disablePlanQuality(db);
  const project = join(root, "project");
  await mkdir(project);
  git(project, "init", "--initial-branch=main");
  await writeFile(join(project, "README.md"), "base\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "initial");
  const registered = await core.createProject(command({ name: "Reviewer fix", canonical_path: project, base_branch: "main", allowed_roots: [root], verification_plan: plan }, `project:${createUlid()}`));
  if (settings) await core.setReviewerFixSettings(settings);

  const gateway = core.gitGateway();
  const restore = gateway.restoreTaskWorktree.bind(gateway);
  gateway.restoreTaskWorktree = async (request, snapshot) => {
    const result = await (state.restoreOverride ? state.restoreOverride(request, snapshot, restore) : restore(request, snapshot));
    const worktree = request.worktree_path;
    state.restores.push({ result, hashes: Object.fromEntries(await Promise.all([...state.touched].map(async (path) => [path, await hashOf(worktree, path)]))) });
    return result;
  };

  const created = await core.createWork(command({ title: "Reviewer fix", summary: "Write the feature.", size: "normal", project_id: registered.data.id }, `create:${createUlid()}`));
  const workId = created.data.work_id;
  const start = () => core.startWork(workId, command({ mode: "normal" }, `start:${createUlid()}`, created.version));
  const events = (...types) => db.all(`SELECT type, payload_json FROM events WHERE work_id = ? AND type IN (${types.map(() => "?").join(",")}) ORDER BY sequence`, workId, ...types)
    .map((row) => ({ type: row.type, ...JSON.parse(row.payload_json) }));
  const task = () => db.get("SELECT * FROM tasks WHERE work_id = ?", workId);
  return { root, db, core, project, workId, state, start, events, task, hashOf, gateway };
}

const waitTask = (fixture, status) => waitFor(() => fixture.task()?.status === status, { timeoutMs: 20_000, message: `the Task becomes ${status} (now ${fixture.task()?.status})` });

/** The files after a verified restore equal what they were before the Reviewer touched them. */
function assertRestored(fixture) {
  assert.ok(fixture.state.restores.length >= 1, "the worktree was restored");
  const { result, hashes } = fixture.state.restores[0];
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  for (const [path, hash] of Object.entries(hashes)) assert.equal(hash, fixture.state.before[path], `${path} has its pre-review sha256 again`);
}

const reviewerFixOf = (events, type) => events.find((event) => event.type === type)?.reviewer_fix;

// --- judgeReviewerFix ---

const file = (path, added, deleted, extra = {}) => ({ path, status: "M", added_lines: added, deleted_lines: deleted, binary: false, ...extra });
const finding = (extra = {}) => ({ severity: "major", scope: "in_scope", target: "deliverable", subject: "other", ...extra });
const permit = (extra = {}) => ({ limits: { max_changed_lines: 30, max_changed_files: 3 }, editable_files: ["a.mjs", "b.mjs", "c.mjs", "d.mjs"], ...extra });
const judge = (extra = {}) => judgeReviewerFix({
  permit: permit(), headMoved: false, verdict: "fix_required", findings: [finding()], fixes: [{ finding_index: 0, file: "a.mjs" }], files: [file("a.mjs", 2, 2)], ...extra,
});

test("judgeReviewerFix accepts a fix at exactly the limits and rejects one past them", () => {
  assert.deepEqual(judge(), { outcome: "ok", reason: null, measured: { changed_lines: 4, changed_files: 1 } });
  assert.equal(judge({ files: [file("a.mjs", 15, 15)] }).outcome, "ok", "30 lines is within the limit");
  assert.equal(judge({ files: [file("a.mjs", 16, 15)] }).outcome, "over_limit", "31 lines is over it");
  const three = ["a.mjs", "b.mjs", "c.mjs"];
  const threeFiles = { files: three.map((path) => file(path, 1, 1)), fixes: three.map((path) => ({ finding_index: 0, file: path })) };
  assert.equal(judge(threeFiles).outcome, "ok", "3 files is within the limit");
  const four = [...three, "d.mjs"];
  assert.deepEqual(judge({ files: four.map((path) => file(path, 1, 1)), fixes: four.map((path) => ({ finding_index: 0, file: path })) }), { outcome: "over_limit", reason: null, measured: { changed_lines: 8, changed_files: 4 } });
});

test("judgeReviewerFix names the first rule that is broken (a to h)", () => {
  const reason = (extra) => { const judged = judge(extra); assert.equal(judged.outcome, "not_allowed"); return judged.reason; };
  assert.equal(reason({ permit: null }), "fix_not_permitted");
  assert.equal(reason({ headMoved: true }), "head_moved");
  for (const verdict of ["pass", "replan_required", "acceptance_defect"]) assert.equal(reason({ verdict }), "verdict_not_fixable", verdict);
  assert.equal(reason({ files: [file("other.mjs", 1, 1)] }), "file_not_editable", "a file outside editable_files");
  assert.equal(reason({ files: [file("a.mjs", 1, 1, { status: "A" })] }), "file_not_editable", "a new file");
  assert.equal(reason({ files: [file("a.mjs", 1, 1, { status: "D" })] }), "file_not_editable", "a deleted file");
  assert.equal(reason({ files: [file("a.mjs", 0, 0, { binary: true })] }), "file_not_editable", "a binary file");
  assert.equal(reason({ fixes: [] }), "no_fix_report");
  assert.equal(reason({ fixes: [{ finding_index: 5, file: "a.mjs" }] }), "finding_not_fixable", "an index with no finding");
  for (const extra of [{ severity: "minor" }, { scope: "goal" }, { scope: "overbuilt" }, { target: "test_result" }, { subject: "test_result" }]) {
    assert.equal(reason({ findings: [finding(extra)] }), "finding_not_fixable", JSON.stringify(extra));
  }
  assert.equal(reason({ findings: [finding(), finding()] }), "blocking_finding_left", "a second blocking finding was not fixed");
  assert.equal(reason({ fixes: [{ finding_index: 0, file: "b.mjs" }] }), "report_mismatch", "the report names another file");
  assert.equal(reason({ files: [file("a.mjs", 1, 1), file("b.mjs", 1, 1)] }), "report_mismatch", "a changed file is not in the report");
  assert.equal(judge({ findings: [finding(), finding({ severity: "minor" })] }).outcome, "ok", "a minor finding may stay");
});

test("a finding the Task's change caused is fixable whatever its scope, within the same other conditions", () => {
  for (const scope of ["beyond_acceptance", "goal"]) {
    assert.equal(judge({ findings: [finding({ scope, caused_by_change: true })] }).outcome, "ok", scope);
    assert.equal(judge({ findings: [finding({ scope, caused_by_change: false })] }).reason, "finding_not_fixable", scope);
  }
  assert.equal(judge({ findings: [finding({ scope: "beyond_acceptance", caused_by_change: true, subject: "test_result" })] }).reason, "finding_not_fixable");
});

// --- the flow ---

test("a fix within the limits that passes Core's tests completes the Task with one Worker call and one Reviewer call", async (t) => {
  let release;
  const fixture = await open(t, {
    finalizeGate: new Promise((resolve) => { release = resolve; }),
    reviews: [async (request, { edit }) => {
      await edit(request, FEATURE, lines(20, "v").replace("v0 = 0", "v0 = 100").replace("v1 = 1", "v1 = 101"));
      return fixReview([fixEntry(FEATURE, { line_end: 2 })]);
    }],
  });
  await fixture.start();
  await waitTask(fixture, "completed");
  t.after(() => release());
  assert.equal(fixture.state.workerCalls, 1);
  assert.equal(fixture.state.reviewCalls, 1);
  assert.equal(fixture.state.restores.length, 0, "nothing was undone");
  assert.match(git(fixture.project, "show", `owl/work/${fixture.workId}/work:${FEATURE}`), /v0 = 100;\nexport const v1 = 101;/u, "the fix is on the Work branch");

  const events = fixture.events("reviewer.started", "review.passed", "review.failed");
  assert.deepEqual(events.map((event) => event.type), ["reviewer.started", "review.passed"]);
  const started = events[0];
  assert.deepEqual(started.fix_permit, { max_changed_lines: 30, max_changed_files: 3, editable_files: [FEATURE] });
  assert.equal(started.fix_permit_reason, null);
  assert.match(started.fix_snapshot.tree, /^[0-9a-f]{40,64}$/u);
  const request = fixture.state.requests[0];
  assert.deepEqual(request.context.fix, { allowed: true, max_changed_lines: 30, max_changed_files: 3, editable_files: [FEATURE] });

  const fix = reviewerFixOf(events, "review.passed");
  assert.equal(fix.outcome, "applied");
  assert.equal(fix.reason, null);
  assert.deepEqual(fix.limits, { max_changed_lines: 30, max_changed_files: 3 });
  assert.deepEqual(fix.measured, { changed_lines: 4, changed_files: 1 });
  assert.deepEqual(fix.files, [{ path: FEATURE, added_lines: 2, deleted_lines: 2 }]);
  assert.deepEqual(fix.fixes, [{ finding_index: 0, file: FEATURE, line_start: 1, line_end: 2, change: "Changed the value.", problem: FINDING.problem }]);
  assert.equal(fix.tests.passed, true);
  assert.equal(fix.revert, null);
});

test("a fix of exactly 30 lines in 3 files counts as within the limits", async (t) => {
  const files = { "a.mjs": lines(15, "a"), "b.mjs": lines(15, "b"), "c.mjs": lines(15, "c") };
  const fixture = await open(t, {
    files,
    reviews: [async (request, { edit }) => {
      for (const path of Object.keys(files)) await edit(request, path, files[path].replace("0 = 0", "0 = 9"));
      return fixReview(Object.keys(files).map((path) => fixEntry(path)));
    }],
  });
  await fixture.start();
  await waitTask(fixture, "completed");
  const fix = reviewerFixOf(fixture.events("review.passed"), "review.passed");
  assert.deepEqual([fix.outcome, fix.measured], ["applied", { changed_lines: 6, changed_files: 3 }]);
  assert.equal(fixture.state.workerCalls, 1);
});

/** Runs a Reviewer that edits once and a second Reviewer that passes: the first edit must not stand. */
async function undoneCase(t, firstReview, options = {}) {
  const fixture = await open(t, { ...options, reviews: [firstReview] });
  await fixture.start();
  await waitTask(fixture, "completed");
  assert.equal(fixture.state.workerCalls, 2, "the Task went back to a Worker");
  assert.equal(fixture.state.reviewCalls, 2);
  assertRestored(fixture);
  for (const [path, hash] of Object.entries(fixture.state.startHashes[1])) assert.equal(hash, fixture.state.before[path] ?? hash, `the second Worker found ${path} as before the review`);
  const failed = fixture.events("review.failed")[0];
  assert.equal(failed.verdict, "fix_required");
  assert.equal(failed.reviewer_fix.revert.verified, true);
  return { fixture, fix: failed.reviewer_fix };
}

test("31 changed lines is over the limit: the files are restored and a second Worker runs", async (t) => {
  const { fix } = await undoneCase(t, async (request, { edit }) => {
    await edit(request, FEATURE, lines(15, "w") + lines(5, "v").split("\n").slice(0, 5).join("\n") + "\n" + "export const extra = 1;\n");
    return fixReview([fixEntry(FEATURE)]);
  });
  assert.equal(fix.outcome, "over_limit");
  assert.ok(fix.measured.changed_lines > 30);
});

test("4 changed files is over the limit: the files are restored and a second Worker runs", async (t) => {
  const files = { "a.mjs": "a = 1;\n", "b.mjs": "b = 1;\n", "c.mjs": "c = 1;\n", "d.mjs": "d = 1;\n" };
  const { fix } = await undoneCase(t, async (request, { edit }) => {
    for (const path of Object.keys(files)) await edit(request, path, `${path[0]} = 2;\n`);
    return fixReview(Object.keys(files).map((path) => fixEntry(path)));
  }, { files });
  assert.deepEqual([fix.outcome, fix.measured.changed_files], ["over_limit", 4]);
});

test("a fix that breaks Core's tests is restored (tests_failed)", async (t) => {
  const { fix } = await undoneCase(t, async (request, { edit }) => {
    await edit(request, FEATURE, `${lines(20, "v")}// BROKEN\n`);
    return fixReview([fixEntry(FEATURE)]);
  }, { plan: failPlan });
  assert.equal(fix.outcome, "tests_failed");
  assert.equal(fix.tests.passed, false);
});

test("a setting of 0 gives no permit, and an edit anyway is restored", async (t) => {
  for (const settings of [{ max_changed_lines: 0, max_changed_files: 3 }, { max_changed_lines: 30, max_changed_files: 0 }]) {
    const { fixture, fix } = await undoneCase(t, async (request, { edit }) => {
      await edit(request, FEATURE, lines(20, "v").replace("v0 = 0", "v0 = 1"));
      return fixReview([fixEntry(FEATURE)]);
    }, { settings });
    assert.deepEqual([fix.outcome, fix.reason], ["not_allowed", "fix_not_permitted"], JSON.stringify(settings));
    const started = fixture.events("reviewer.started")[0];
    assert.equal(started.fix_permit, null);
    assert.equal(started.fix_permit_reason, "disabled_by_setting");
    assert.deepEqual(fixture.state.requests[0].context.fix, { allowed: false });
  }
});

test("a file the Worker did not change cannot be fixed, even when the guard was passed with a direct write (file_not_editable)", async (t) => {
  const { fixture, fix } = await undoneCase(t, async (request, { edit }) => {
    await edit(request, "src/extra.mjs", "export const extra = 1;\n");
    await edit(request, FEATURE, lines(20, "v").replace("v0 = 0", "v0 = 1"));
    return fixReview([fixEntry(FEATURE), fixEntry("src/extra.mjs")]);
  });
  assert.deepEqual([fix.outcome, fix.reason], ["not_allowed", "file_not_editable"]);
  assert.equal(fixture.state.restores[0].hashes["src/extra.mjs"], sha("<absent>"), "the new file is gone again");
});

test("an edit without a report of the fix is restored (no_fix_report)", async (t) => {
  const { fix } = await undoneCase(t, async (request, { edit }) => {
    await edit(request, FEATURE, lines(20, "v").replace("v0 = 0", "v0 = 1"));
    return fixReview([]);
  });
  assert.deepEqual([fix.outcome, fix.reason], ["not_allowed", "no_fix_report"]);
});

test("a pass with edits is restored and the Task completes as before (verdict_not_fixable)", async (t) => {
  const fixture = await open(t, {
    reviews: [async (request, { edit }) => {
      await edit(request, FEATURE, lines(20, "v").replace("v0 = 0", "v0 = 1"));
      return passReview();
    }],
  });
  await fixture.start();
  await waitTask(fixture, "completed");
  assert.equal(fixture.state.workerCalls, 1);
  assert.equal(fixture.state.reviewCalls, 1);
  assertRestored(fixture);
  const fix = reviewerFixOf(fixture.events("review.passed"), "review.passed");
  assert.deepEqual([fix.outcome, fix.reason, fix.revert], ["not_allowed", "verdict_not_fixable", { verified: true }]);
});

test("a replan_required with edits is restored and still goes to the Manager", async (t) => {
  const fixture = await open(t, {
    reviews: [async (request, { edit }) => {
      await edit(request, FEATURE, lines(20, "v").replace("v0 = 0", "v0 = 1"));
      return { verdict: "replan_required", summary: "The plan is wrong.", findings: [], fixes: [fixEntry(FEATURE)], tests: TESTS };
    }],
  });
  await fixture.start();
  await waitFor(() => fixture.state.replans.length > 0, { timeoutMs: 20_000, message: "the Manager was asked to replan" });
  assertRestored(fixture);
  const fix = reviewerFixOf(fixture.events("review.failed"), "review.failed");
  assert.deepEqual([fix.outcome, fix.reason], ["not_allowed", "verdict_not_fixable"]);
});

test("an acceptance_defect with edits is restored and still goes to the Manager without counting as a review", async (t) => {
  const fixture = await open(t, {
    reviews: [async (request, { edit }) => {
      await edit(request, FEATURE, lines(20, "v").replace("v0 = 0", "v0 = 1"));
      return {
        verdict: "acceptance_defect", summary: "A criterion cannot be proven.", findings: [], fixes: [fixEntry(FEATURE)], tests: TESTS,
        acceptance_defects: [{ criterion_id: "AC1", criterion: "The feature works.", reason: "It cannot be proven inside the Task.", suggestion: "Check a copy." }],
      };
    }],
  });
  await fixture.start();
  await waitFor(() => fixture.events("task.acceptance_defect_reported").length > 0, { timeoutMs: 20_000, message: "the defect was reported" });
  assertRestored(fixture);
  assert.equal(fixture.events("review.failed").length, 0, "not counted as a review");
});

// --- a restore that fails ---

test("a restore that cannot be verified fails the Task and asks the Manager (worktree_restore_failure)", async (t) => {
  const fixture = await open(t, {
    reviews: [async (request, { edit }) => {
      await edit(request, FEATURE, `${lines(20, "v")}// BROKEN\n`);
      return fixReview([fixEntry(FEATURE)]);
    }],
    plan: failPlan,
  });
  fixture.state.restoreOverride = async () => ({ ok: false, message: "restore exploded" });
  await fixture.start();
  await waitFor(() => fixture.state.replans.length > 0, { timeoutMs: 20_000, message: "the Manager was called" });
  assert.ok(["failed", "judgement_waiting"].includes(fixture.task().status), `the Task failed and waits for the Manager (${fixture.task().status})`);
  assert.equal(fixture.state.workerCalls, 1, "no second Worker call");
  const [failed] = fixture.events("review.fix_restore_failed");
  assert.equal(failed.reviewer_fix.revert.verified, false);
  assert.equal(failed.reviewer_fix.outcome, "tests_failed");
  assert.match(failed.message, /restore exploded/u);
  assert.equal(fixture.events("review.passed", "review.failed").length, 0);
  const [entry] = fixture.state.replans[0].trigger.tasks;
  assert.deepEqual([entry.kind, entry.after, entry.failure_kind], ["task_integration_failed", "review", "worktree_restore_failure"]);
  assert.match(entry.message, /restore exploded/u);
});

// --- Core restarts while a Reviewer is running ---

/** A Reviewer that edits the worktree and never answers; Core stops, then recovery runs on the same database. */
async function orphanedReviewer(t) {
  const fixture = await open(t, {
    reviews: [async (request, { edit }) => {
      await edit(request, FEATURE, lines(20, "v").replace("v0 = 0", "v0 = 1"));
      return new Promise(() => {});
    }],
  });
  await fixture.start();
  await waitFor(() => fixture.state.before[FEATURE] !== undefined && fixture.hashOf(fixture.task().worktree_path, FEATURE).then((hash) => hash !== fixture.state.before[FEATURE]), { timeoutMs: 20_000, message: "the Reviewer edited the file" });
  await fixture.core.stop({ force: true });
  return fixture;
}

test("on restart a Reviewer run without an outcome has its worktree restored to the snapshot", async (t) => {
  const fixture = await orphanedReviewer(t);
  const worktree = fixture.task().worktree_path;
  await recoverOrphanedState(fixture.db, fixture.gateway);
  assert.equal(await fixture.hashOf(worktree, FEATURE), fixture.state.before[FEATURE], "the file has its pre-review sha256");
  assert.equal(fixture.state.restores[0].result.verified, true);
  assert.equal(fixture.events("review.fix_restore_failed").length, 0);
});

test("on restart a restore that fails fails the Task and queues the Manager", async (t) => {
  const fixture = await orphanedReviewer(t);
  fixture.state.restoreOverride = async () => ({ ok: false, message: "restore exploded" });
  await recoverOrphanedState(fixture.db, fixture.gateway);
  const [failed] = fixture.events("review.fix_restore_failed");
  assert.equal(failed.reviewer_fix.revert.verified, false);
  assert.deepEqual(failed.reviewer_fix.measured, { changed_lines: 0, changed_files: 0 });
  assert.deepEqual([failed.reviewer_fix.files, failed.reviewer_fix.fixes, failed.reviewer_fix.tests], [[], [], null]);
  assert.equal(typeof failed.reviewer_fix.limits.max_changed_lines, "number");
  assert.equal(fixture.task().status, "failed");
  assert.equal(fixture.db.get("SELECT status FROM manager_replan_triggers WHERE task_id = ?", fixture.task().id)?.status, "queued");
});
