import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { samePartialReport } from "../../packages/core/dist/auto-recovery.js";
import { RULE_SECTION_HEADING, appendRuleSection, outputTail, runCriterionChecks, splitPlainCommand } from "../../packages/core/dist/criterion-checks.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { openTestRunCore } from "../helpers/test-run-core.mjs";
import { waitFor } from "../helpers/wait.mjs";

// Kind 8: the same partial report twice in a row is repaired by Core and the Manager before partial_limit asks the Owner.

const partial = (open, extra = {}, verificationStatus = "failed") => ({
  report: { result: "partial", needs_replanning: false, external_blocker: null, pending_process: null, ...extra },
  verification: {
    status: verificationStatus,
    acceptance: [
      { criterion_id: "AC1", status: "passed" },
      ...Object.entries(open).map(([criterion_id, status]) => ({ criterion_id, status })),
    ],
  },
});

test("samePartialReport is true only for two plain partials with the same open criteria and verification status", () => {
  assert.equal(samePartialReport(partial({ AC2: "failed" }), partial({ AC2: "failed" })), true);
  assert.equal(samePartialReport(partial({ AC2: "failed" }), partial({ AC2: "failed", AC3: "failed" })), false);
  assert.equal(samePartialReport(partial({ AC2: "failed" }), partial({ AC2: "blocked" })), false);
  assert.equal(samePartialReport(partial({ AC2: "failed" }), partial({ AC2: "failed" }, {}, "blocked")), false);
  // A passing criterion is not part of the comparison.
  assert.equal(samePartialReport(partial({ AC2: "failed" }), partial({ AC2: "failed", AC9: "passed" })), true);
});

test("samePartialReport never compares reports with unverifiable, external_blocker, pending_process or needs_replanning", () => {
  const same = partial({ AC2: "failed" });
  assert.equal(samePartialReport(partial({ AC2: "unverifiable" }), partial({ AC2: "unverifiable" })), false);
  assert.equal(samePartialReport(same, partial({ AC2: "failed", AC3: "unverifiable" })), false);
  for (const extra of [{ external_blocker: { kind: "pre_existing" } }, { pending_process: { pid: 1 } }, { needs_replanning: true }]) {
    assert.equal(samePartialReport(partial({ AC2: "failed" }, extra), same), false);
    assert.equal(samePartialReport(same, partial({ AC2: "failed" }, extra)), false);
    assert.equal(samePartialReport(partial({ AC2: "failed" }, extra), partial({ AC2: "failed" }, extra)), false);
  }
  assert.equal(samePartialReport(same, { ...same, report: { ...same.report, result: "success" } }), false);
  assert.equal(samePartialReport(same, null), false);
});

test("samePartialReport is false when a Reviewer rejection sits between the two reports", () => {
  const a = partial({ AC2: "failed" });
  assert.equal(samePartialReport(a, { ...partial({ AC2: "failed" }), interrupted: true }), false);
  assert.equal(samePartialReport({ ...a, interrupted: true }, partial({ AC2: "failed" })), false);
});

test("runCriterionChecks runs each allowed argv once in the worktree and marks the others not_allowed", async () => {
  const ok = ["node", "-e", "process.exit(0)"];
  const bad = ["node", "-e", "process.exit(1)"];
  const calls = [];
  const run = async (argv, cwd) => {
    calls.push({ argv, cwd });
    return argv === bad || argv[2] === bad[2] ? { passed: false, exit_code: 1, stdout: "", stderr: "boom" } : { passed: true, exit_code: 0, stdout: "fine", stderr: "" };
  };
  const results = await runCriterionChecks({
    checks: [{ criterion_id: "AC1", argv: ok }, { criterion_id: "AC2", argv: bad }, { criterion_id: "AC3", argv: ["rm", "-rf", "/"] }],
    allowed: [ok, bad],
    cwd: "/tmp/the-worktree",
    run,
  });
  assert.deepEqual(results.map((r) => [r.criterion_id, r.status]), [["AC1", "passed"], ["AC2", "failed"], ["AC3", "not_allowed"]]);
  assert.equal(calls.length, 2, "the not allowed argv was not run");
  assert.ok(calls.every((call) => call.cwd === "/tmp/the-worktree"));
  assert.equal(results[2].exit_code, null);
});

test("a check starting with an allowed argv runs; report commands split into plain argv, shell lines do not", async () => {
  assert.deepEqual(splitPlainCommand("pnpm run test:prepare"), ["pnpm", "run", "test:prepare"]);
  assert.deepEqual(splitPlainCommand("node --test --test-reporter=tap {file}"), ["node", "--test", "--test-reporter=tap"]);
  assert.equal(splitPlainCommand("pnpm test | tail"), null);
  const results = await runCriterionChecks({
    checks: [{ criterion_id: "AC1", argv: ["pnpm", "test", "--", "tests/a.test.mjs"] }, { criterion_id: "AC2", argv: ["pnpm", "build"] }],
    allowed: [["pnpm", "test"]],
    cwd: "/tmp/w",
    run: async () => ({ passed: true, exit_code: 0, stdout: "", stderr: "" }),
  });
  assert.deepEqual(results.map((r) => r.status), ["passed", "not_allowed"]);
});

test("the output tail keeps the last 4000 characters and masks secrets", () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const tail = outputTail({ stdout: `${"x".repeat(6000)}\nGITHUB_TOKEN=${secret}\nend`, stderr: "" });
  assert.ok(tail.length <= 4000);
  assert.ok(tail.endsWith("end"));
  assert.doesNotMatch(tail, new RegExp(secret, "u"));
});

test("appendRuleSection puts the heading and one line per rule at the end of the notes", () => {
  const notes = appendRuleSection("old notes", [
    { criterion_id: "AC2", rule: "no live server", applies: true, reason: "the check needs it" },
    { criterion_id: "AC3", rule: "keep the API", applies: false, reason: "not touched" },
  ]);
  assert.ok(notes.startsWith("old notes\n\n"));
  assert.ok(notes.includes(`\n\n${RULE_SECTION_HEADING}\n`));
  assert.ok(notes.includes("AC2: 規則『no live server』は当てはまります。理由: the check needs it"));
  assert.ok(notes.endsWith("AC3: 規則『keep the API』は当てはまりません。理由: not touched"));
});

// --- Core flow --------------------------------------------------------------------------------

const NODE = process.execPath;
const PASS_ARGV = [NODE, "-e", "console.log('CHECK_OK')"];
const FAIL_ARGV = [NODE, "-e", "console.error('CHECK_FAIL'); process.exit(1)"];
const MANAGER = { kind: "manager", source: null, quote: "" };
const OWNER = { kind: "owner", source: "summary", quote: "Keep this" };
const RULE = { criterion_id: "AC2", rule: "Only changed files are checked", applies: true, reason: "AC2 is about changed files." };

const criterion = (id, text, origin) => ({ id, text, check: "node --test tests/x.test.mjs", serves: "fixture", if_omitted: "fixture", check_weight: "light", weight_reason: "", kind: "work_check", ...(origin ? { origin } : {}) });

const planTask = (criteria, autoRecovery = {}) => ({
  id: "T1", title: "A", type: "code",
  necessity: { serves: "fixture", if_omitted: "fixture" },
  acceptance_criteria: criteria,
  auto_recovery: { criteria_relaxations: [], criterion_checks: [], rule_applicability: [], ...autoRecovery },
  depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false,
});

const baseCriteria = () => [criterion("AC1", "The file exists.", MANAGER), criterion("AC2", "Every test passes in full.", MANAGER)];

const verification = (status2) => ({
  status: status2 === "passed" ? "passed" : "failed",
  method: "Ran it.",
  acceptance: [
    { criterion_id: "AC1", criterion: "The file exists.", status: "passed", evidence: "ls" },
    { criterion_id: "AC2", criterion: "Every test passes in full.", status: status2, evidence: "run" },
  ],
  checks: [],
  integration_check: null,
});

const report = (invocationId, result, status2, changes = []) => ({
  kind: "report", schema_version: "1.1.0", invocation_id: invocationId, result,
  work_done: "Done in part.", delegation: { decomposition: "kept", delegated: [], retained: [] },
  changes, verification: verification(status2), remaining_issues: [], next_action: "none",
  needs_replanning: false, question_for_manager: null, external_blocker: null, pending_process: null,
});

/** Worker runs follow `partials` (that many same partial reports), then succeed. The Manager answers each replan with `answer(request, n)`. */
function runner({ partials, answer }) {
  const state = { workerRequests: [], replans: [], db: null };
  return {
    state,
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask(baseCriteria())] } };
      if (mode === "finalize") return { outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } };
      if (mode === "replan") {
        state.replans.push(request);
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: answer(request, state.replans.length) } };
      }
      return { outcome: "failed", message: `unexpected manager ${mode}` };
    },
    runWorker: async (request) => {
      state.workerRequests.push(request);
      const n = state.workerRequests.length;
      if (n <= partials) {
        await mkdir(join(request.context.worktree, "src"), { recursive: true });
        await writeFile(join(request.context.worktree, `src/p${n}.mjs`), "export const p = 1;\n");
        return { outcome: "partial", failure_class: "deterministic", error_key: "report_result:partial", retry_allowed: true, report_valid: true, report: report(request.invocation_id, "partial", "failed") };
      }
      await mkdir(join(request.context.worktree, "src"), { recursive: true });
      const file = `src/done-${createUlid()}.mjs`;
      await writeFile(join(request.context.worktree, file), "export const d = 1;\n");
      return { outcome: "success", report_valid: true, report: report(request.invocation_id, "success", "passed", [{ file, action: "added" }]) };
    },
    runReviewer: async () => {
      const review = { verdict: "pass", summary: "ok", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } };
      return { outcome: "success", report_valid: true, report: review, review };
    },
    runAdvisor: async () => ({ reply: "" }),
  };
}

/** The Project allows `checkCommands`; Core also runs them all when it verifies a Task, so a failing one keeps the Task from completing. */
async function open(t, agentRunner, { limit = 2, checkCommands = [PASS_ARGV], testRun, reportCheckCommands } = {}) {
  const opened = await openTestRunCore(t, { agentRunner, prefix: "owl-partial-repeated-", testPolicy: { check_commands: checkCommands }, ...(testRun ? { testRun } : {}) });
  if (reportCheckCommands) await opened.core.updateProject(opened.projectId, opened.envelope({ report_check_commands: reportCheckCommands }, "report-checks"));
  await opened.core.setAutoRecoverySettings({ limit });
  agentRunner.state.db = opened.db;
  const created = await opened.core.createWork(opened.envelope({ title: "partial", summary: "Exercise kind 8.", size: "normal", project_id: opened.projectId }, "work"));
  await opened.core.startWork(created.data.work_id, { ...opened.envelope({ mode: "normal" }, "start"), expected_version: created.version });
  return { ...opened, workId: created.data.work_id };
}

const events = (db, workId, type) => db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = ? ORDER BY rowid", workId, type).map((row) => JSON.parse(row.payload_json));
const taskStatus = (db, workId) => db.get("SELECT status FROM tasks WHERE work_id = ? AND manager_task_id = 'T1'", workId)?.status;
/** Wait for T1 to complete; on a timeout say where the Work stands. */
async function completes(db, workId) {
  try {
    await waitFor(() => taskStatus(db, workId) === "completed", { timeoutMs: 30_000, message: "T1 completes" });
  } catch (error) {
    const rows = db.all("SELECT id, status, last_error_key FROM tasks WHERE work_id = ?", workId);
    const types = db.all("SELECT type FROM events WHERE work_id = ? ORDER BY rowid", workId).map((row) => row.type).join(",");
    const decided = db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'verification.completed' ORDER BY rowid DESC LIMIT 1", workId).map((row) => row.payload_json.slice(0, 5000));
    throw new Error(`${error.message}: ${JSON.stringify(rows)} ${types} ${decided.join(" | ")}`);
  }
}
const openDecisions = (db, workId) => db.all("SELECT * FROM decisions WHERE work_id = ? AND status = 'open' AND blocked_task_ids_json != '[]'", workId);

test("the same partial twice repairs without a Decision and asks the Manager with trigger partial_repeated", async (t) => {
  const fake = runner({ partials: 2, answer: () => [planTask(baseCriteria(), { criterion_checks: [{ criterion_id: "AC2", argv: PASS_ARGV }], rule_applicability: [RULE] })] });
  const { db, workId } = await open(t, fake);

  await completes(db, workId);
  assert.equal(fake.state.replans.length, 1, "the Manager was called once, before partial_limit (3)");
  const trigger = JSON.stringify(fake.state.replans[0].trigger);
  assert.match(trigger, /"kind":"partial_repeated"/);
  assert.equal(openDecisions(db, workId).length, 0, "no Decision opened");
  const started = events(db, workId, "recovery.started").filter((e) => e.kind === "partial_repeated");
  assert.equal(started.length, 1);
  assert.equal(started[0].attempt_no, 1);

  // AC3: Core ran the Manager's check once, in the Task's worktree, and wrote the result.
  const steps = events(db, workId, "recovery.step").filter((e) => e.kind === "partial_repeated");
  assert.equal(steps.length, 1);
  assert.equal(steps[0].all_passed, true);
  assert.deepEqual(steps[0].check_results.map((r) => [r.criterion_id, r.status]), [["AC2", "passed"]]);
  assert.match(steps[0].check_results[0].output_tail, /CHECK_OK/);
  // All passed: the criteria rewrite is discarded and the Worker re-reports with the check results.
  assert.equal(events(db, workId, "criteria.relaxed").length, 0);
  const last = fake.state.workerRequests[fake.state.workerRequests.length - 1];
  assert.match(JSON.stringify(last), /Core が残りの条件を確かめ、全部通りました。この結果を証拠にして success を報告してください。/);
  assert.match(JSON.stringify(last), /check_results/);
  // AC5: the Manager's judgement of the rule reached manager_notes, under the heading.
  const notes = JSON.stringify(last);
  assert.ok(notes.includes(RULE_SECTION_HEADING));
  assert.ok(notes.includes("AC2: 規則『Only changed files are checked』は当てはまります。理由: AC2 is about changed files."));
});

test("a failed check and an argv outside the Project's commands do not pass; only Manager-made failing criteria are relaxed", async (t) => {
  const criteria = [criterion("AC1", "The file exists.", OWNER), criterion("AC2", "Every test passes in full.", MANAGER)];
  const relaxed = [criterion("AC1", "The file exists.", OWNER), criterion("AC2", "The changed tests pass; verified by node --test tests/x.test.mjs.", MANAGER)];
  const answer = () => [planTask(relaxed, {
    criterion_checks: [{ criterion_id: "AC2", argv: FAIL_ARGV }, { criterion_id: "AC1", argv: [NODE, "-e", "console.log('not allowed')"] }],
    criteria_relaxations: [
      { criterion_id: "AC2", reason: "The full run is outside the Task.", keeps: "The changed tests still pass." },
    ],
    rule_applicability: [RULE],
  })];
  const fake = runner({ partials: 2, answer });
  fake.runManagerPlan = ((original) => async (request) => {
    const mode = request.mode ?? request.context?.mode;
    if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask(criteria)] } };
    return original(request);
  })(fake.runManagerPlan);
  const { db, workId } = await open(t, fake, { checkCommands: [PASS_ARGV, FAIL_ARGV] });

  await waitFor(() => events(db, workId, "criteria.relaxed").length >= 1, { timeoutMs: 30_000, message: "the criterion is relaxed" });
  const step = events(db, workId, "recovery.step").find((e) => e.kind === "partial_repeated");
  assert.equal(step.all_passed, false);
  assert.deepEqual(step.check_results.map((r) => [r.criterion_id, r.status]), [["AC2", "failed"]], "AC1 is passed in the report, so it is not checked");
  assert.match(step.check_results[0].output_tail, /CHECK_FAIL/);
  // AC4: only the Manager-made criterion changed; the Owner's stays. Kind 7 count +1 and criteria.relaxed.
  const row = db.get("SELECT acceptance_criteria_json FROM tasks WHERE work_id = ? AND manager_task_id = 'T1'", workId);
  const stored = JSON.parse(row.acceptance_criteria_json);
  assert.equal(stored.find((c) => c.id === "AC1").text, "The file exists.");
  assert.equal(stored.find((c) => c.id === "AC2").text, "The changed tests pass; verified by node --test tests/x.test.mjs.");
  const relaxedEvents = events(db, workId, "criteria.relaxed");
  assert.equal(relaxedEvents.length, 1);
  assert.equal(relaxedEvents[0].trigger, "partial_repeated", "a kind 8 (b) loosening is not recorded as acceptance_defect");
  assert.equal(events(db, workId, "recovery.started").filter((e) => e.kind === "criteria_too_strict").length, 1);
});

test("an argv outside the Project's commands is recorded as not_allowed and not run", async (t) => {
  const answer = () => [planTask(baseCriteria(), { criterion_checks: [{ criterion_id: "AC2", argv: [NODE, "-e", "console.log('NOT_ALLOWED_RAN')"] }], rule_applicability: [RULE] })];
  const fake = runner({ partials: 2, answer });
  const { db, workId } = await open(t, fake);

  await waitFor(() => events(db, workId, "recovery.step").some((e) => e.kind === "partial_repeated"), { timeoutMs: 30_000, message: "the step is written" });
  const step = events(db, workId, "recovery.step").find((e) => e.kind === "partial_repeated");
  assert.deepEqual(step.check_results.map((r) => [r.criterion_id, r.status, r.output_tail]), [["AC2", "not_allowed", ""]]);
  assert.equal(step.all_passed, false);
});

test("with report_check_commands set, the resolved test_run argv still runs as a Manager check", async (t) => {
  const resolved = [NODE, "--version"];
  const answer = () => [planTask(baseCriteria(), { criterion_checks: [{ criterion_id: "AC2", argv: resolved }], rule_applicability: [RULE] })];
  const fake = runner({ partials: 2, answer });
  const testRun = { test_patterns: ["tests/**/*.test.mjs"], file_argv: [...resolved, "{file}"], concurrency: 1, flaky_retries: 0, source_map: [] };
  const { db, workId } = await open(t, fake, { testRun, reportCheckCommands: ["pnpm test:layout"] });

  await waitFor(() => events(db, workId, "recovery.step").some((e) => e.kind === "partial_repeated"), { timeoutMs: 30_000, message: "the step is written" });
  const step = events(db, workId, "recovery.step").find((e) => e.kind === "partial_repeated");
  assert.deepEqual(step.check_results.map((r) => [r.criterion_id, r.status]), [["AC2", "passed"]]);
});

test("an empty rule_applicability goes back to the Manager as fields_missing", async (t) => {
  const answer = (_request, n) => [planTask(baseCriteria(), { criterion_checks: [{ criterion_id: "AC2", argv: PASS_ARGV }], rule_applicability: n === 1 ? [] : [RULE] })];
  const fake = runner({ partials: 2, answer });
  const { db, workId } = await open(t, fake);

  await completes(db, workId);
  assert.ok(fake.state.replans.length >= 2, "the Manager was asked again");
  assert.match(JSON.stringify(fake.state.replans[1]), /rule_applicability/);
  assert.equal(events(db, workId, "recovery.step").filter((e) => e.kind === "partial_repeated").length, 1);
});

test("with the default limit 2 the next same partial opens exactly one partialStopped Decision after two tries", async (t) => {
  const workersAtRepair = [];
  const answer = () => {
    workersAtRepair.push(fake.state.workerRequests.length);
    return [planTask(baseCriteria(), { criterion_checks: [{ criterion_id: "AC2", argv: FAIL_ARGV }], rule_applicability: [RULE] })];
  };
  const fake = runner({ partials: 100, answer });
  const { db, workId } = await open(t, fake, { checkCommands: [PASS_ARGV, FAIL_ARGV] });

  await waitFor(() => openDecisions(db, workId).length >= 1, { timeoutMs: 60_000, message: "the Decision opens" });
  const decisions = openDecisions(db, workId);
  assert.equal(decisions.length, 1);
  assert.equal(events(db, workId, "recovery.started").filter((e) => e.kind === "partial_repeated").length, 2);
  assert.equal(fake.state.replans.length, 2);
  assert.deepEqual(workersAtRepair, [2, 4], "the second repair needs two new same partials: the report before a repair is not compared again");
  assert.match(decisions[0].tried ?? JSON.stringify(decisions[0]), /自動で試したこと: 2回/);
});
