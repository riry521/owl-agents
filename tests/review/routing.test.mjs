import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { decideReviewRouting, effectiveReviewRequired } from "../../packages/core/dist/review-routing.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { globToRegExp, matchesAnyGlob } from "../../packages/shared/dist/glob.js";
import {
  DEFAULT_REVIEW_ROUTING_SETTINGS,
  readReviewRoutingSettings,
  validateReviewRoutingSettings,
} from "../../packages/shared/dist/review-routing-settings.js";
import { createTestCore } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { waitFor } from "../helpers/wait.mjs";
import os from "node:os";
// Some runners start tests with an empty environment; child processes need PATH and HOME.
process.env.PATH ||= [process.execPath.replace(/\/[^/]+$/u, ""), "/usr/bin", "/bin"].join(":");
process.env.HOME ||= os.homedir();

const settings = DEFAULT_REVIEW_ROUTING_SETTINGS;
const file = (path, added = 1, deleted = 0) => ({ path, added_lines: added, deleted_lines: deleted, binary: false });
const facts = { line_counts_approximate: false, delegated: false, gate_failures: 0, rejections: 0, settings };
const skipTask = { type: "code", review_override: "false", review_decision: null };
const codes = (decision) => decision.forced_reasons.map((reason) => reason.code);

test("glob matching lets double star cross directories, keeps single star in one, alternates braces and treats prototype-like names as plain text", () => {
  assert.ok(matchesAnyGlob("a/b/migrations/001.sql", ["**/migrations/**"]));
  assert.ok(matchesAnyGlob("x.sql", ["**/*.sql"]));
  assert.ok(!matchesAnyGlob("a/b.sql.txt", ["**/*.sql"]));
  assert.ok(!matchesAnyGlob("a/b/c.ts", ["a/*.ts"]));
  assert.ok(matchesAnyGlob("vite.config.mjs", ["**/*.config.{js,cjs,mjs,ts}"]));
  assert.ok(!matchesAnyGlob("toString", ["constructor"]));
  assert.throws(() => globToRegExp("{a,b"));
});

test("routing never forces or lowers a Task whose base decision is required", () => {
  const big = [file("a.ts", 500)];
  for (const task of [{ type: "code", review_override: "true", review_decision: null }, { type: "code", review_override: null, review_decision: null }]) {
    const decision = decideReviewRouting({ ...facts, task, files: big });
    assert.equal(decision.required, true);
    assert.deepEqual(decision.forced_reasons, []);
  }
  assert.equal(decideReviewRouting({ ...facts, task: { ...skipTask, review_decision: "required" }, files: [] }).base, "sticky_required");
});

test("routing forces a review for each condition just above its threshold and not at it", () => {
  const route = (extra) => decideReviewRouting({ ...facts, task: skipTask, files: [file("src/a.ts", 10)], ...extra });
  assert.equal(route({}).required, false);
  assert.match(route({}).skip_reason, /override_false; within thresholds \(1 files, 10 lines\)/);
  assert.equal(route({ files: [file("a.ts", 80)] }).required, false);
  assert.deepEqual(codes(route({ files: [file("a.ts", 60, 21)] })), ["changed_lines_over"]);
  assert.equal(route({ files: [file("a.ts"), file("b.ts"), file("c.ts")] }).required, false);
  assert.deepEqual(codes(route({ files: [file("a.ts"), file("b.ts"), file("c.ts"), file("d.ts")] })), ["changed_files_over"]);
  const sensitive = route({ files: [file("packages/db/migrations/x.sql")] }); // helpers-exempt: migration path is input data
  assert.deepEqual(sensitive.forced_reasons.map((reason) => [reason.code, reason.group, reason.measured]), [["sensitive_path", "migration", ["packages/db/migrations/x.sql"]]]); // helpers-exempt: migration path is input data
  assert.deepEqual(codes(route({ delegated: true })), ["hybrid_delegation"]);
  assert.deepEqual(codes(route({ gate_failures: 1 })), ["gate_failure_history"]);
  assert.deepEqual(codes(route({ rejections: 1 })), ["rejection_history"]);
  assert.deepEqual(codes(route({ files: null })), ["changed_files_over"]);
  assert.equal(route({ files: null }).forced_reasons[0].detail, "diff unavailable");
});

test("routing changes its verdict when thresholds, sensitive paths, switches or type defaults are customized", () => {
  const files = [file("src/a.ts", 10), file("docs/x.md", 5)];
  const base = { ...facts, task: skipTask, files };
  assert.equal(decideReviewRouting(base).required, false);
  assert.deepEqual(codes(decideReviewRouting({ ...base, settings: { ...settings, max_changed_lines: 14 } })), ["changed_lines_over"]);
  assert.deepEqual(codes(decideReviewRouting({ ...base, settings: { ...settings, max_changed_files: 1 } })), ["changed_files_over"]);
  const custom = decideReviewRouting({ ...base, settings: { ...settings, sensitive_paths: { docs: ["docs/**"] } } });
  assert.deepEqual(custom.forced_reasons.map((reason) => [reason.code, reason.group]), [["sensitive_path", "docs"]]);
  assert.equal(decideReviewRouting({ ...base, delegated: true, settings: { ...settings, force_on_hybrid_delegation: false } }).required, false);
  const docTask = { type: "doc", review_override: null, review_decision: null };
  assert.equal(decideReviewRouting({ ...base, task: docTask }).required, false);
  const strict = { ...settings, type_defaults: { ...settings.type_defaults, doc: "required" } };
  assert.equal(decideReviewRouting({ ...base, task: docTask, settings: strict }).required, true);
  assert.equal(effectiveReviewRequired(docTask, strict), true);
  assert.equal(effectiveReviewRequired({ ...docTask, review_decision: "not_required" }, strict), false);
  assert.equal(effectiveReviewRequired({ type: "design", review_override: null, review_decision: null }, settings), true);
  assert.equal(effectiveReviewRequired({ type: "toString", review_override: null, review_decision: null }, settings), false);
});

test("default routing requires test and designs, never reviews research, and the Owner's settings win", () => {
  const plain = (type) => ({ type, review_override: null, review_decision: null });
  const route = (type, extra = {}) => decideReviewRouting({ ...facts, task: plain(type), files: [], ...extra });
  assert.equal(route("test").required, true);
  const forcing = { files: [file("docs/research.md"), file("db/migrations/1.sql")], artifact_paths: ["shared/report.md"], delegated: true, gate_failures: 1, rejections: 1 };
  assert.equal(route("research", forcing).required, false);
  assert.equal(route("research", { ...forcing, files: null }).required, false);
  assert.equal(route("research", { ...forcing, task: { ...plain("research"), review_override: "true" } }).required, false);
  assert.equal(effectiveReviewRequired({ ...plain("research"), review_decision: "required" }, settings), false);
  assert.equal(route("research").required, false);
  assert.equal(route("design").required, true);
  assert.equal(route("design").base, "design_default");
  assert.equal(route("design", { task: { ...plain("design"), review_override: "false" } }).required, false);
  assert.equal(effectiveReviewRequired(plain("design"), settings), true);
  assert.equal(effectiveReviewRequired({ ...plain("design"), review_decision: "not_required" }, settings), false);
  const relaxed = { ...settings, type_defaults: { ...settings.type_defaults, test: "not_required" } };
  assert.equal(route("test", { settings: relaxed }).required, false);
});

test("review routing settings validate the defaults, name the field of bad values and fall back per key when read", () => {
  assert.deepEqual(validateReviewRoutingSettings(JSON.parse(JSON.stringify(settings))), settings);
  const bad = (change) => assert.throws(() => validateReviewRoutingSettings({ ...settings, ...change }), (error) => error.field.startsWith(Object.keys(change)[0]));
  bad({ max_changed_lines: -1 });
  bad({ max_changed_files: 1.5 });
  bad({ type_defaults: { ...settings.type_defaults, doc: "maybe" } });
  bad({ sensitive_paths: { group: ["{oops"] } });
  bad({ force_on_hybrid_delegation: "yes" });
  assert.throws(() => validateReviewRoutingSettings({ ...settings, extra: 1 }), (error) => error.field === "payload");
  assert.throws(() => validateReviewRoutingSettings(null), (error) => error.field === "payload");
  const warnings = [];
  const read = readReviewRoutingSettings({ ...settings, max_changed_lines: "many", max_changed_files: 9 }, (message) => warnings.push(message));
  assert.equal(read.max_changed_lines, settings.max_changed_lines);
  assert.equal(read.max_changed_files, 9);
  assert.equal(warnings.length, 1);
  assert.deepEqual(readReviewRoutingSettings(undefined), settings);
  const legacy = { ...settings, force_on_persistent_research: true };
  const legacyWarnings = [];
  assert.deepEqual(readReviewRoutingSettings(legacy, (message) => legacyWarnings.push(message)), settings);
  assert.deepEqual(legacyWarnings, []);
});

async function seedProject(db, root, project) {
  const now = new Date().toISOString();
  const plan = [{
    command_id: "project-check", argv: [process.execPath, "-e", "process.exit(0)"],
    cwd: ".", env_allowlist: [], timeout_seconds: 10, stdout_limit: 1024, stderr_limit: 1024, expected_exit_codes: [0], executor: "core",
  }];
  await db.createWriteLane().transact((transaction) => {
    transaction.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", "owner:default", "Owner", now, now);
    transaction.run(
      `INSERT INTO projects
         (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
          verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', ?, ?, '[]', ?, ?)`,
      "project:routing", "owner:default", "Routing", project, JSON.stringify([root]), JSON.stringify(plan), now, now,
    );
  });
}

/** Run one code Task the Manager marked `review: false`, writing `files` ({ path: contents }), and report what Core did. */
async function runSkippedReviewTask(t, files, configure, opts = {}) {
  const agentRunner = {
    runManagerPlan: async (request) => request.context?.mode === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [
          ...(opts.tasks ?? [{ id: "T1", title: "Small fix", type: "code", acceptance: "Fixed.", review: false, depends_on: [], replaces: [] }]),
        ] } }
      : { outcome: "success", report_valid: true, report: { event: "work.completed", summary: "Done." } },
    runWorker: async (request) => {
      await opts.onWorker?.(core);
      const step = opts.steps?.[request.context.task.title] ?? { files, remove: opts.remove ?? [] };
      for (const path of step.remove) await rm(join(request.context.worktree, path));
      for (const [path, contents] of Object.entries(step.files)) {
        await mkdir(dirname(join(request.context.worktree, path)), { recursive: true });
        await writeFile(join(request.context.worktree, path), contents);
      }
      await opts.afterWrite?.(request.context.worktree);
      return {
        outcome: "success", report_valid: true,
        report: {
          kind: "report", invocation_id: request.invocation_id, result: "success", schema_version: "1.0.0",
          work_done: "Done.", changes: [...Object.keys(step.files).map((file) => ({ file, action: "added" })), ...step.remove.map((file) => ({ file, action: "deleted" }))],
          remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null,
          verification: { passed: true, method: "Checked.", ...(request.context.hybrid_mode ? { integration_check: { status: "passed", evidence: "Nothing to integrate." } } : {}) },
        },
      };
    },
    runReviewer: async (request) => ({
      outcome: "success", report_valid: true, report: { kind: "review", invocation_id: request.invocation_id },
      review: { verdict: "pass", findings: [], tests: {} },
    }),
    runAdvisor: async () => ({ reply: "" }),
  };
  // Core keeps writing worktrees in the background after stop(), so removing the root races with it; the root is left to OS temp cleanup.
  const ownedRoot = await realpath(await mkdtemp(join(tmpdir(), "owl-review-routing-"))); // helpers-exempt: removing the root after core.stop() races with Core background worktree work
  const { root, db, core } = await createTestCore(t, { agentRunner, owlRoot: ownedRoot, dispatcher: { tick_interval_ms: 25 } });
  const project = join(root, "repo");
  await mkdir(project, { recursive: true });
  git(project, "init", "--initial-branch=main");
  await writeFile(join(project, "README.md"), "base\n");
  for (const [path, contents] of Object.entries(opts.baseFiles ?? {})) {
    await mkdir(dirname(join(project, path)), { recursive: true });
    await writeFile(join(project, path), contents);
  }
  git(project, "add", ".");
  git(project, "commit", "-m", "initial");
  await seedProject(db, root, project);
  await core.start();
  await disablePlanQuality(db);
  if (configure) await configure(core);
  const created = await core.createWork({
    request_id: createUlid(), idempotency_key: `test:${createUlid()}`, expected_version: 0,
    payload: { title: "Routing", summary: "x", size: "normal", project_id: opts.projectless ? null : "project:routing" },
  });
  const workId = created.data.work_id;
  await core.startWork(workId, { request_id: createUlid(), idempotency_key: `test:${createUlid()}`, expected_version: created.version, payload: { mode: "normal" } });
  const expected = opts.tasks?.at(-1)?.title ?? "Small fix";
  // `untilVerified` is for Tasks that are routed correctly but cannot finish afterwards (git cannot commit an unreadable file).
  const task = await waitFor(() => opts.untilVerified
    ? db.get("SELECT t.* FROM tasks t WHERE t.work_id = ? AND t.title = ? AND EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.type = 'verification.completed') AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.work_id = t.work_id AND r.role = 'reviewer')", workId, expected)
    : db.get("SELECT * FROM tasks WHERE work_id = ? AND status = 'completed' AND title = ?", workId, expected), { timeoutMs: 20_000, intervalMs: 25, message: "the Task to complete" });
  assert.ok(task, "the Task completed");
  const verification = JSON.parse(db.get("SELECT payload_json FROM events WHERE task_id = ? AND type = 'verification.completed' ORDER BY rowid LIMIT 1", task.id).payload_json);
  const reviewerRuns = db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE work_id = ? AND role = 'reviewer'", workId).n;
  return { task, verification, reviewerRuns, db, core, workId, root };
}

test("a small Task marked not-required completes with no Reviewer, after Core verification, and records why", async (t) => {
  const { task, verification, reviewerRuns } = await runSkippedReviewTask(t, { "src/fix.js": "export const x = 1;\n" });
  assert.equal(reviewerRuns, 0);
  assert.equal(task.review_decision, "not_required");
  assert.equal(verification.outcome, "pass");
  assert.equal(verification.review_required, false);
  assert.equal(verification.verification.source, "project_verification_plan");
  assert.deepEqual(verification.verification.commands.map((command) => [command.command_id, command.passed]), [["project-check", true]]);
  assert.equal(verification.review_routing.base, "override_false");
  assert.match(verification.review_routing.skip_reason, /within thresholds \(1 files, 1 lines\)/);
  assert.deepEqual(JSON.parse(task.review_decision_json), verification.review_routing);
});

test("a Task marked not-required still gets the Reviewer when it changes more lines than the threshold", async (t) => {
  const big = Array.from({ length: 81 }, (_, index) => `line ${index}`).join("\n") + "\n";
  const { task, verification, reviewerRuns } = await runSkippedReviewTask(t, { "src/big.js": big });
  assert.ok(reviewerRuns >= 1);
  assert.equal(task.review_decision, "required");
  assert.equal(verification.review_required, true);
  assert.deepEqual(verification.review_routing.forced_reasons.map((reason) => [reason.code, reason.measured, reason.threshold]), [["changed_lines_over", 81, 80]]);
});

test("a Task marked not-required still gets the Reviewer when it touches a sensitive path", async (t) => {
  const { task, verification, reviewerRuns } = await runSkippedReviewTask(t, { "packages/db/migrations/099_x.sql": "SELECT 1;\n" }); // helpers-exempt: migration path is input data
  assert.ok(reviewerRuns >= 1);
  assert.equal(task.review_decision, "required");
  const reasons = verification.review_routing.forced_reasons;
  assert.ok(reasons.every((reason) => reason.code === "sensitive_path"));
  assert.ok(reasons.some((reason) => reason.group === "migration" && reason.measured.includes("packages/db/migrations/099_x.sql"))); // helpers-exempt: migration path is input data
});

test("saved settings change the verdict, and survive a Core restart", async (t) => {
  const first = await runSkippedReviewTask(t, { "src/fix.js": "export const x = 1;\nexport const y = 2;\n" }, async (core) => {
    await core.setReviewRoutingSettings({ ...DEFAULT_REVIEW_ROUTING_SETTINGS, max_changed_lines: 1 });
  });
  assert.ok(first.reviewerRuns >= 1);
  assert.deepEqual(first.verification.review_routing.forced_reasons.map((reason) => reason.code), ["changed_lines_over"]);
  assert.equal(first.verification.review_routing.thresholds.max_changed_lines, 1);
  await first.core.stop({ force: true });
  const { core: second } = await createTestCore(t, { db: first.db, agentRunner: {}, owlRoot: first.root, dispatcher: { tick_interval_ms: 25 } });
  assert.equal((await second.getReviewRoutingSettings()).max_changed_lines, 1);
  await assert.rejects(() => second.setReviewRoutingSettings({ ...DEFAULT_REVIEW_ROUTING_SETTINGS, max_changed_lines: -5 }), (error) => error.details?.field === "max_changed_lines" || /max_changed_lines/.test(error.message));
});

test("a Hybrid Task that delegated nothing still gets the Reviewer, and says why", async (t) => {
  const { task, verification, reviewerRuns } = await runSkippedReviewTask(t, { "src/fix.js": "export const x = 1;\n" }, (core) => core.setHybridMode(true));
  assert.ok(reviewerRuns >= 1);
  assert.equal(task.review_decision, "required");
  assert.deepEqual(verification.review_routing.forced_reasons.map((reason) => [reason.code, reason.detail]), [["hybrid_delegation", "the Worker ran with Hybrid Mode on"]]);
});

test("Hybrid Mode is judged as it was when the Worker started, not when it finished", async (t) => {
  const turnedOff = await runSkippedReviewTask(t, { "src/fix.js": "export const x = 1;\n" }, (core) => core.setHybridMode(true), { onWorker: (core) => core.setHybridMode(false) });
  assert.ok(turnedOff.reviewerRuns >= 1);
  const turnedOn = await runSkippedReviewTask(t, { "src/fix.js": "export const x = 1;\n" }, undefined, { onWorker: (core) => core.setHybridMode(true) });
  assert.equal(turnedOn.reviewerRuns, 0);
  assert.equal(turnedOn.verification.review_required, false);
});

test("a Project-less Task is measured from its worktree: a file over the capture limit in a sensitive path still forces the Reviewer", async (t) => {
  const huge = `// ${"x".repeat(12 * 1024 * 1024)}\n`;
  const { task, verification, reviewerRuns } = await runSkippedReviewTask(t, { "auth/large.js": huge, "src/ok.js": "export const x = 1;\n" }, undefined, { projectless: true });
  assert.ok(reviewerRuns >= 1);
  assert.equal(task.review_decision, "required");
  const reasons = verification.review_routing.forced_reasons;
  assert.ok(reasons.some((reason) => reason.code === "sensitive_path" && reason.group === "auth" && reason.measured.includes("auth/large.js")));
  assert.equal(verification.review_routing.measured.changed_files, 2);
});

test("deleting a file counts as a change: removing a sensitive file forces the Reviewer", async (t) => {
  const { verification, reviewerRuns } = await runSkippedReviewTask(t, { "src/fix.js": "export const x = 1;\n" }, undefined, {
    baseFiles: { "auth/session.js": "export const a = 1;\nexport const b = 2;\n" },
    remove: ["auth/session.js"],
  });
  assert.ok(reviewerRuns >= 1);
  const routing = verification.review_routing;
  assert.equal(routing.measured.changed_files, 2);
  assert.equal(routing.measured.deleted_lines, 2);
  assert.ok(routing.forced_reasons.some((reason) => reason.code === "sensitive_path" && reason.measured.includes("auth/session.js")));
});

test("a Project-less Task is measured against what it started with: deleting and editing a dependency's file counts, an untouched one does not", async (t) => {
  const base = { id: "T1", title: "Make", type: "code", acceptance: "Done.", review: false, depends_on: [], replaces: [] };
  const { verification, reviewerRuns } = await runSkippedReviewTask(t, {}, undefined, {
    projectless: true,
    tasks: [base, { ...base, id: "T2", title: "Change", depends_on: ["T1"] }],
    steps: {
      Make: { files: { "auth/session.js": "export const a = 1;\nexport const b = 2;\n", "src/keep.js": "export const k = 1;\n", "src/edit.js": "export const e = 1;\nexport const f = 2;\n" }, remove: [] },
      Change: { files: { "src/edit.js": "export const e = 1;\nexport const g = 3;\n" }, remove: ["auth/session.js"] },
    },
  });
  assert.ok(reviewerRuns >= 1);
  const routing = verification.review_routing;
  assert.equal(routing.measured.changed_files, 2);
  assert.equal(routing.measured.added_lines, 1);
  assert.equal(routing.measured.deleted_lines, 3);
  assert.ok(routing.forced_reasons.some((reason) => reason.code === "sensitive_path" && reason.measured.includes("auth/session.js")));
});

test("a Project-less change under node_modules is still a change", async (t) => {
  const { verification, reviewerRuns } = await runSkippedReviewTask(t, { "node_modules/auth.js": "export const a = 1;\n", "src/ok.js": "export const x = 1;\n" }, undefined, { projectless: true });
  assert.ok(reviewerRuns >= 1);
  assert.equal(verification.review_routing.measured.changed_files, 2);
});

test("routing forces a review for a Task launched in Hybrid Mode without delegation and records the reason for an unmeasurable change", () => {
  const hybrid = decideReviewRouting({ ...facts, task: skipTask, files: [file("a.ts")], hybrid_at_launch: true });
  assert.deepEqual(codes(hybrid), ["hybrid_delegation"]);
  assert.equal(decideReviewRouting({ ...facts, task: skipTask, files: [file("a.ts")], hybrid_at_launch: true, settings: { ...settings, force_on_hybrid_delegation: false } }).required, false);
  const unmeasured = decideReviewRouting({ ...facts, task: skipTask, files: null, unmeasured_reason: "changes could not be measured: EACCES" });
  assert.equal(unmeasured.required, true);
  assert.equal(unmeasured.forced_reasons[0].detail, "changes could not be measured: EACCES");
});

test("reordering lines counts as a change so reversing a long file in a Project-less Task forces the Reviewer", async (t) => {
  const base = { id: "T1", title: "Make", type: "code", acceptance: "Done.", review: false, depends_on: [], replaces: [] };
  const lines = Array.from({ length: 100 }, (_, i) => `export const v${i} = ${i};`);
  const { verification, reviewerRuns } = await runSkippedReviewTask(t, {}, undefined, {
    projectless: true,
    tasks: [base, { ...base, id: "T2", title: "Reorder", depends_on: ["T1"] }],
    steps: {
      Make: { files: { "src/order.js": `${lines.join("\n")}\n` }, remove: [] },
      Reorder: { files: { "src/order.js": `${[...lines].reverse().join("\n")}\n` }, remove: [] },
    },
  });
  assert.ok(reviewerRuns >= 1);
  const measured = verification.review_routing.measured;
  assert.ok(measured.added_lines >= 99 && measured.deleted_lines >= 99);
  assert.ok(verification.review_routing.forced_reasons.some((reason) => reason.code === "changed_lines_over"));
});

test("a measurement that throws requires the Reviewer and records the reason in the routing", async (t) => {
  const { task, verification, reviewerRuns } = await runSkippedReviewTask(t, { "src/fix.js": "export const x = 1;\n" }, (core) => {
    core.git.diffStats = async () => { throw new Error("diff exploded"); };
  });
  assert.ok(reviewerRuns >= 1);
  assert.equal(task.review_decision, "required");
  const reason = verification.review_routing.forced_reasons.find((entry) => /could not be measured/.test(entry.detail));
  assert.ok(reason && reason.detail.includes("diff exploded"));
});

test("routing keeps the reason and records no zero counts when a required base has an unmeasurable change", () => {
  const reason = "changes could not be measured: EACCES";
  const decision = decideReviewRouting({ ...facts, task: { type: "code", review_override: null, review_decision: null }, files: null, unmeasured_reason: reason });
  assert.equal(decision.base, "type_default_required");
  assert.equal(decision.required, true);
  assert.equal(decision.forced_reasons[0].detail, reason);
  assert.deepEqual([decision.measured.changed_files, decision.measured.added_lines, decision.measured.deleted_lines], [null, null, null]);
  const overridden = decideReviewRouting({ ...facts, task: { ...skipTask, review_override: "true" }, files: null, unmeasured_reason: reason });
  assert.equal(overridden.base, "override_true");
  assert.equal(overridden.forced_reasons[0].detail, reason);
});

test("a review=true Task whose measurement throws saves the reason on the Task and in the event", async (t) => {
  const base = { id: "T1", title: "Make", type: "code", acceptance: "Done.", review: true, depends_on: [], replaces: [] };
  const { task, verification } = await runSkippedReviewTask(t, { "src/fix.js": "export const x = 1;\n" }, (core) => {
    core.git.diffStats = async () => { throw new Error("diff exploded"); };
  }, { tasks: [base] });
  const stored = JSON.parse(task.review_decision_json);
  for (const routing of [stored, verification.review_routing]) {
    assert.equal(routing.base, "override_true");
    assert.ok(routing.forced_reasons.some((entry) => entry.detail.includes("diff exploded")));
    assert.equal(routing.measured.changed_files, null);
    assert.equal(routing.measured.added_lines, null);
  }
});

test("an unreadable untracked file requires the Reviewer for a small review=false change and names the path", async (t) => {
  // A dangling symlink is listed as untracked but cannot be read, even as root (a chmod 000 file would fail artifact capture first).
  const { verification, reviewerRuns } = await runSkippedReviewTask(t, { "src/fix.js": "export const x = 1;\n" }, undefined, {
    afterWrite: async (worktree) => { await symlink("missing-target", join(worktree, "src/locked.js")); },
  });
  assert.ok(reviewerRuns >= 1);
  assert.ok(verification.review_routing.forced_reasons.some((entry) => entry.detail.includes("src/locked.js")));
});

test("a code Task with no review flag whose measurement throws records type_default_required, the reason and null counts in the event", async (t) => {
  const base = { id: "T1", title: "Make", type: "code", acceptance: "Done.", depends_on: [], replaces: [] };
  const { task, verification } = await runSkippedReviewTask(t, { "src/fix.js": "export const x = 1;\n" }, (core) => {
    core.git.diffStats = async () => { throw new Error("diff exploded"); };
  }, { tasks: [base] });
  const stored = JSON.parse(task.review_decision_json);
  for (const routing of [stored, verification.review_routing]) {
    assert.equal(routing.base, "type_default_required");
    assert.ok(routing.forced_reasons.some((entry) => entry.detail.includes("diff exploded")));
    assert.deepEqual([routing.measured.changed_files, routing.measured.added_lines, routing.measured.deleted_lines], [null, null, null]);
  }
});

test("an untracked file with no read permission requires the Reviewer for a small review=false change and names the path", async (t) => {
  let readable = false;
  const { verification, reviewerRuns } = await runSkippedReviewTask(t, { "src/fix.js": "export const x = 1;\n" }, undefined, {
    untilVerified: true,
    afterWrite: async (worktree) => {
      const locked = join(worktree, "src/locked.js");
      await writeFile(locked, "export const y = 2;\n");
      await chmod(locked, 0o000);
      readable = await readFile(locked).then(() => true, () => false);
      t.after(() => chmod(locked, 0o644).catch(() => {}));
    },
  });
  if (readable) return t.skip("the file is readable in this environment (running as root)");
  assert.ok(reviewerRuns >= 1);
  assert.ok(verification.review_routing.forced_reasons.some((entry) => entry.detail.includes("src/locked.js")));
});
