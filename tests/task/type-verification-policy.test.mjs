import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { matchesGlobWithDots } from "../../packages/core/dist/glob.js";
import { evaluateTaskTypePolicy } from "../../packages/core/dist/task-verification-policy.js";
import { DEFAULT_VERIFICATION_POLICY_SETTINGS, readVerificationPolicySettings } from "../../packages/shared/dist/verification-policy-settings.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { withNecessity } from "../helpers/necessity.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";
import { openTestRunCore, plannedTask, workerReport as projectWorkerReport } from "../helpers/test-run-core.mjs";

function workerReport(invocationId, files) {
  return {
    kind: "report", invocation_id: invocationId, result: "success", work_done: "Done.",
    changes: files.map((file) => ({ file, action: "added" })), remaining_issues: [], next_action: "none",
    needs_replanning: false, question_for_manager: null, schema_version: "1.1.0",
    verification: {
      status: "passed", method: "Checked.", checks: [], integration_check: null,
      acceptance: [{ criterion_id: "AC1", criterion: "Done.", status: "passed", evidence: "Looked." }],
    },
  };
}

/**
 * Run one Task of `type` in a Work without a Project. The Worker writes `files`, claims `claimed`
 * (default: the same files) and reports a passed verification. Returns the first verification.completed payload.
 */
async function verify(t, { type, files, claimed = Object.keys(files), spec = {}, storedSpecJson }) {
  let db;
  const agentRunner = withNecessity({
    runManagerPlan: async (request) => request.context?.mode === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [
          { id: "T1", title: "Do it", type, acceptance: "Done.", depends_on: [], replaces: [], review: false, ...spec },
        ] } }
      : { outcome: "success", report_valid: true, report: { event: "work.completed", summary: "Done." } },
    runWorker: async (request) => {
      // The plan schema cannot produce a broken spec, so corrupt the stored row the way a damaged DB would.
      if (storedSpecJson !== undefined) {
        await db.createWriteLane().transact((transaction) => {
          // json_valid is a CHECK on this column, so it has to be bypassed to store a broken value.
          transaction.run("PRAGMA ignore_check_constraints = ON");
          transaction.run("UPDATE tasks SET verification_spec_json = ?", storedSpecJson);
          transaction.run("PRAGMA ignore_check_constraints = OFF");
        });
      }
      for (const [name, content] of Object.entries(files)) {
        await mkdir(dirname(join(request.context.worktree, name)), { recursive: true });
        await writeFile(join(request.context.worktree, name), content);
      }
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, claimed) };
    },
    runReviewer: async (request) => ({
      outcome: "success", report_valid: true, report: { kind: "review", invocation_id: request.invocation_id },
      review: { verdict: "pass", findings: [], tests: {} },
    }),
    runAdvisor: async () => ({ reply: "" }),
  });
  const made = await createTestCore(t, { agentRunner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-type-policy-" });
  const { core } = made;
  db = made.db;
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => {
    transaction.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", "owner:default", "Owner", now, now);
  });
  await core.start();
  const created = await core.createWork({
    request_id: createUlid(), idempotency_key: "test:create", expected_version: 0,
    payload: { title: "Policy", summary: "x", size: "normal", project_id: null },
  });
  await core.startWork(created.data.work_id, { request_id: createUlid(), idempotency_key: "test:start", expected_version: created.version, payload: { mode: "normal" } });
  const event = await waitFor(() => db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'verification.completed' ORDER BY rowid LIMIT 1", created.data.work_id));
  assert.ok(event, "verification.completed was recorded");
  return JSON.parse(event.payload_json);
}

const outcomeOf = (payload) => [payload.outcome, payload.verification.source, payload.verification.error_key];

test("code: the Worker's claim alone does not pass; a file that passes the syntax check does", async (t) => {
  assert.deepEqual(outcomeOf(await verify(t, { type: "code", files: {}, claimed: ["a.mjs"] })), ["fail", "task_type_policy", "verification_claimed_change_missing"]);
  assert.deepEqual(outcomeOf(await verify(t, { type: "code", files: { "a.mjs": "export const x = ;\n" } })), ["fail", "task_type_policy", "code_check_failed"]);
  assert.deepEqual(outcomeOf(await verify(t, { type: "code", files: { "a.mjs": "export const x = 1;\n" } })), ["pass", "task_type_policy", null]);
});

test("doc: needs a non-empty document with every required section", async (t) => {
  assert.deepEqual(outcomeOf(await verify(t, { type: "doc", files: {}, claimed: ["a.md"] })), ["fail", "task_type_policy", "verification_claimed_change_missing"]);
  assert.deepEqual(outcomeOf(await verify(t, { type: "doc", files: { "a.md": "  \n" } })), ["fail", "task_type_policy", "doc_empty"]);
  const spec = { required_sections: ["Overview", "Ｓｅｔｔｉｎｇｓ"] };
  assert.deepEqual(outcomeOf(await verify(t, { type: "doc", files: { "a.md": "# Overview\ntext\n" }, spec })), ["fail", "task_type_policy", "doc_section_missing"]);
  assert.deepEqual(outcomeOf(await verify(t, { type: "doc", files: { "a.md": "# overview\n## Settings\n" }, spec })), ["pass", "task_type_policy", null]);
});

test("config: a changed JSON file must parse", async (t) => {
  assert.deepEqual(outcomeOf(await verify(t, { type: "config", files: {}, claimed: ["a.json"] })), ["fail", "task_type_policy", "verification_claimed_change_missing"]);
  assert.deepEqual(outcomeOf(await verify(t, { type: "config", files: { "a.json": "{ nope" } })), ["fail", "task_type_policy", "config_parse_failed"]);
  assert.deepEqual(outcomeOf(await verify(t, { type: "config", files: { "a.json": "{\"a\": 1}" } })), ["pass", "task_type_policy", null]);
});

test("test: the named test must actually run and pass", async (t) => {
  assert.deepEqual(outcomeOf(await verify(t, { type: "test", files: {}, claimed: ["a.test.mjs"] })), ["fail", "task_type_policy", "verification_claimed_change_missing"]);
  const failing = "import {test} from 'node:test'; import assert from 'node:assert'; test('x', () => assert.equal(1, 2));\n";
  const passing = "import {test} from 'node:test'; import assert from 'node:assert'; test('x', () => assert.equal(1, 1));\n";
  assert.deepEqual(outcomeOf(await verify(t, { type: "test", files: { "a.test.mjs": failing } })), ["fail", "task_type_policy", "test_failed"]);
  assert.deepEqual(outcomeOf(await verify(t, { type: "test", files: { "a.test.mjs": passing }, spec: { required_tests: ["b.test.mjs"] } })), ["fail", "task_type_policy", "test_required_not_executed"]);
  assert.deepEqual(outcomeOf(await verify(t, { type: "test", files: { "a.test.mjs": passing }, spec: { required_tests: ["a.test.mjs"] } })), ["pass", "task_type_policy", null]);
});

test("a Task whose stored verification spec is unreadable fails with the parse error; an unset spec still passes", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const broken = await verify(t, { type: "code", files: { "a.mjs": "export const x = 1;\n" }, storedSpecJson: "{ not json" });
  assert.deepEqual(outcomeOf(broken), ["fail", "task_type_policy", "verification_spec_unreadable"]);
  assert.match(broken.verification.error, /verification_spec_json is unreadable: .*JSON/u);
  assert.ok(logged.mock.calls.some((call) => String(call.arguments[0]).includes("verification_spec_json is unreadable")));
  assert.deepEqual(outcomeOf(await verify(t, { type: "code", files: { "a.mjs": "export const x = 1;\n" }, storedSpecJson: "" })), ["pass", "task_type_policy", null]);
});

test("a Task with nothing Core can check fails instead of passing", async (t) => {
  assert.deepEqual(outcomeOf(await verify(t, { type: "code", files: { "notes.xyz": "x" } })), ["fail", "task_type_policy", "code_unchecked"]);
});

test("the rules come from the settings, with the defaults defined in one place", async () => {
  const input = (settings) => ({
    type: "config", root: tmpdir(), files: ["a.toml"], claimedChanges: [], spec: {}, mode: "sole", settings,
    runCommand: async () => ({ passed: false, exit_code: 1 }),
  });
  assert.equal((await evaluateTaskTypePolicy(input(DEFAULT_VERIFICATION_POLICY_SETTINGS))).error_key, "config_unsupported_format");
  const custom = readVerificationPolicySettings({ config: { bogus: 1 }, doc: { file_patterns: "nope" } });
  assert.deepEqual(custom.doc, DEFAULT_VERIFICATION_POLICY_SETTINGS.doc);
  const withChecker = readVerificationPolicySettings({ config: { checkers: [{ pattern: "**/*.toml", argv: ["taplo", "{file}"] }] } });
  assert.equal((await evaluateTaskTypePolicy(input(withChecker))).error_key, "config_parse_failed");
});

async function directly(t, { type, files, spec = {}, settings = DEFAULT_VERIFICATION_POLICY_SETTINGS, root, runCommand, coreTestRun }) {
  const dir = root === undefined ? await tempDir(t, "owl-type-policy-direct-") : root;
  if (dir !== null) for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return evaluateTaskTypePolicy({
    type, root: dir, files: Object.keys(files), claimedChanges: [], spec, mode: "sole", settings, coreTestRun,
    runCommand: runCommand ?? (async () => ({ passed: true, exit_code: 0, stdout: "" })),
  });
}

test("a Task without a worktree fails instead of passing", async (t) => {
  for (const type of ["code", "doc", "config", "test"]) {
    const result = await directly(t, { type, files: {}, root: null });
    assert.equal(result.passed, false, type);
    assert.equal(result.error_key, "verification_no_output");
  }
});

test("a Task that only deleted files passes; one that changed nothing still fails", async (t) => {
  const dir = await tempDir(t, "owl-type-policy-delete-");
  const base = { root: dir, files: [], spec: {}, mode: "sole", settings: DEFAULT_VERIFICATION_POLICY_SETTINGS, runCommand: async () => ({ passed: true, exit_code: 0, stdout: "" }) };
  for (const type of ["code", "doc", "config", "test"]) {
    const deleted = await evaluateTaskTypePolicy({ ...base, type, deletedFiles: ["old.txt"], claimedChanges: [{ file: "old.txt", action: "削除（1行）" }] });
    assert.equal(deleted.passed, true, type);
    assert.equal(deleted.error_key, null);
    const nothing = await evaluateTaskTypePolicy({ ...base, type, deletedFiles: [], claimedChanges: [] });
    assert.equal(nothing.passed, false, type);
    assert.equal(nothing.error_key, "verification_no_output");
  }
  const missing = await evaluateTaskTypePolicy({ ...base, type: "code", deletedFiles: ["old.txt"], claimedChanges: [{ file: "ghost.txt", action: "added" }] });
  assert.equal(missing.error_key, "verification_claimed_change_missing");
});

test("removed unrequested tests are output even when no other files remain", async (t) => {
  const dir = await tempDir(t, "owl-type-policy-removed-tests-");
  const base = { root: dir, files: [], deletedFiles: [], removedTests: ["tests/new.test.mjs"], claimedChanges: [], spec: {}, mode: "sole", settings: DEFAULT_VERIFICATION_POLICY_SETTINGS, runCommand: async () => ({ passed: true, exit_code: 0, stdout: "" }) };
  for (const type of ["code", "test"]) {
    const result = await evaluateTaskTypePolicy({ ...base, type });
    assert.equal(result.passed, true, type);
    assert.equal(result.error_key, null, type);
  }
});

test("doc: every changed document must have content, and the section rules come from the settings", async (t) => {
  assert.equal((await directly(t, { type: "doc", files: { "ok.md": "# A\n", "empty.md": " \n" } })).error_key, "doc_empty");
  const custom = readVerificationPolicySettings({ doc: { heading_pattern: "^Title: (.*)$", section_match: "exact", required_sections: ["Intro"] } });
  assert.equal((await directly(t, { type: "doc", files: { "a.md": "Title: intro\n" }, settings: custom })).error_key, "doc_section_missing");
  assert.equal((await directly(t, { type: "doc", files: { "a.md": "Title: Intro\n" }, settings: custom })).passed, true);
});

test("config: one parsed file does not excuse an unsupported one, nor does a fully skipped set", async (t) => {
  assert.equal((await directly(t, { type: "config", files: { "ok.json": "{}", "bad.toml": "a = [" } })).error_key, "config_unsupported_format");
  assert.equal((await directly(t, { type: "config", files: { ".env.example": "A=1" } })).error_key, "config_unsupported_format");
});

test("config: YAML parses by default, and its patterns come from the settings", async (t) => {
  assert.equal((await directly(t, { type: "config", files: { "ci.yml": "on: [push]\njobs:\n  a:\n    steps:\n      - run: x\n", "b.yaml": "a: 1\n---\nb: 2\n" } })).passed, true);
  assert.equal((await directly(t, { type: "config", files: { "bad.yml": "a: [\n" } })).error_key, "config_parse_failed");
  assert.equal((await directly(t, { type: "config", files: { "dup.yaml": "a: 1\na: 2\n" } })).error_key, "config_parse_failed");
  const custom = readVerificationPolicySettings({ config: { yaml_patterns: ["**/*.cfg"] } });
  assert.equal((await directly(t, { type: "config", files: { "a.cfg": "a: [\n" }, settings: custom })).error_key, "config_parse_failed");
  assert.equal((await directly(t, { type: "config", files: { "a.yml": "a: [\n" }, settings: custom })).error_key, "config_unsupported_format");
});

test("config: dot-directories such as .github are matched by ** and * patterns", async (t) => {
  const bad = { ".github/workflows/ci.yml": "a: [\n" };
  assert.equal((await directly(t, { type: "config", files: bad })).error_key, "config_parse_failed");
  assert.equal((await directly(t, { type: "config", files: bad, settings: readVerificationPolicySettings({ config: { skip_patterns: ["**/*.yml"] } }) })).error_key, "config_unsupported_format");
  assert.equal(matchesGlobWithDots(".github/workflows/ci.yml", "**/*.yml"), true);
  assert.equal(matchesGlobWithDots(".github/workflows/ci.yml", ".github/**/*.yml"), true);
  assert.equal(matchesGlobWithDots("src/a.yml", "docs/**"), false);
  assert.equal(matchesGlobWithDots(".github/.hidden/ci.yml", ".github/**/*.yml"), true);
  assert.equal(matchesGlobWithDots(".github/workflows/.ci.yml", ".github/**/*.yml"), true);
  assert.equal(matchesGlobWithDots(".a.yml", "a.yml"), false);
  assert.equal(matchesGlobWithDots("_dot_github/workflows/ci.yml", ".github/**/*.yml"), false);
  assert.equal(matchesGlobWithDots(".github/ci.yml", "[!.]github/*.yml"), false);
  assert.equal(matchesGlobWithDots(".github/ci.yml", "[^.]github/*.yml"), false);
  assert.equal(matchesGlobWithDots("a/.hidden/b.test.mjs", "**/*.test.mjs"), true);
  assert.equal(matchesGlobWithDots("a/b.json", "**/*.{json,yml}"), true);
  const deep = Array.from({ length: 24 }, (_, i) => `.d${i}`).join("/") + "/x.yml";
  const started = performance.now();
  assert.equal(matchesGlobWithDots(deep, "**/*.json"), false);
  assert.equal(matchesGlobWithDots(deep, "**/*.yml"), true);
  assert.equal(matchesGlobWithDots(deep, "**/".repeat(24) + "x.json"), false);
  assert.ok(performance.now() - started < 100);
  assert.equal(matchesGlobWithDots("a.test.mjs", "**/*.@(test|spec).mjs"), true);
  assert.equal(matchesGlobWithDots("a2.yml", "a{1..3}.yml"), true);
  assert.equal(matchesGlobWithDots("a/b", "a[!x]b"), false);
  assert.equal(matchesGlobWithDots("a/b", "a[/]b"), false);
  const runner = readVerificationPolicySettings({ test: { runners: [{ pattern: "**/*.test.mjs", argv: ["node", "--test", "{file}"] }] } });
  const ran = [];
  await directly(t, { type: "test", files: { ".github/ci.test.mjs": "" }, settings: runner, runCommand: async (argv) => { ran.push(argv.at(-1)); return { passed: true, exit_code: 0, stdout: "" }; } });
  assert.deepEqual(ran, [".github/ci.test.mjs"]);
});

test("code and test: files no checker or runner covers fail", async (t) => {
  assert.equal((await directly(t, { type: "code", files: { "a.ts": "x" } })).error_key, "code_unchecked");
  assert.equal((await directly(t, { type: "test", files: { "readme.md": "x" } })).error_key, "test_not_executed");
});

test("code: a whole-command Core test run verifies a .ts-only Task; its failure is a test failure; no run stays code_unchecked", async (t) => {
  const run = (coreTestRun) => directly(t, { type: "code", files: { "src/a.ts": "x" }, coreTestRun });
  const passed = await run({ run_id: "R1", passed_files: ["*"], failed_files: [] });
  assert.equal(passed.passed, true);
  assert.ok(passed.checks.some((check) => check.command_id === "policy:test" && check.passed));
  assert.equal((await run({ run_id: "R2", passed_files: [], failed_files: ["*"] })).error_key, "test_failed");
  assert.equal((await run(undefined)).error_key, "code_unchecked");
});

test("doc: a file limit cannot hide an empty document", async (t) => {
  const limited = readVerificationPolicySettings({ limits: { max_files_per_check: 1 } });
  const result = await directly(t, { type: "doc", files: { "ok.md": "# A\n", "empty.md": " \n" }, settings: limited });
  assert.equal(result.passed, false);
  assert.ok(result.checks.some((check) => check.command_id === "policy:verification_limit_exceeded"));
});

test("test: a required test counts only when its own run passed, not when output mentions its name", async (t) => {
  const result = await directly(t, {
    type: "test", files: { "a.test.mjs": "x" }, spec: { required_tests: ["missing.test.mjs"] },
    runCommand: async () => ({ passed: true, exit_code: 0, stdout: "missing.test.mjs\n" }),
  });
  assert.equal(result.error_key, "test_required_not_executed");
});

test("the Manager's plan output schema carries required_sections and required_tests", async () => {
  const { MANAGER_PLAN_OUTPUT_SCHEMA } = await import("../../packages/agent-runtime/dist/manager.js");
  const properties = MANAGER_PLAN_OUTPUT_SCHEMA.properties.tasks.items.properties;
  assert.ok(Object.hasOwn(properties, "required_sections") && Object.hasOwn(properties, "required_tests"));
});

test("config: lockfiles are never checked, even with custom skip_patterns, while other files still is", async () => {
  const input = (files, settings) => ({ type: "config", root: tmpdir(), files, claimedChanges: [], spec: {}, mode: "sole", settings });
  const empty = readVerificationPolicySettings({ config: { skip_patterns: [] } });
  const custom = readVerificationPolicySettings({ config: { skip_patterns: ["**/other.txt"] } });
  for (const settings of [DEFAULT_VERIFICATION_POLICY_SETTINGS, empty, custom]) {
    assert.equal((await evaluateTaskTypePolicy(input(["pnpm-lock.yaml"], settings))).passed, true);
    assert.equal((await evaluateTaskTypePolicy(input(["sub/Cargo.lock", "go.sum"], settings))).passed, true);
    assert.equal((await evaluateTaskTypePolicy(input(["pnpm-lock.yaml", "a.toml"], settings))).error_key, "config_unsupported_format");
    assert.equal((await evaluateTaskTypePolicy(input(["a.toml"], settings))).error_key, "config_unsupported_format");
  }
});

test("glob: representative patterns keep their answers", () => {
  assert.equal(matchesGlobWithDots("src/a.ts", "**/*.ts"), true);
  assert.equal(matchesGlobWithDots("a.json", "*.json"), true);
  assert.equal(matchesGlobWithDots("src/x/a.test.mjs", "src/**/*.test.mjs"), true);
  assert.equal(matchesGlobWithDots("a/b.json", "*.json"), false);
  assert.equal(matchesGlobWithDots("src/a.ts", "docs/**"), false);
  assert.equal(matchesGlobWithDots(".github/ci.yml", "{.github,src}/**/*.yml"), true);
});

/** A Project with an explicit whole-command test setting and no verification plan; the Worker changes only src/a.ts. */
async function tsOnlyTaskWithWholeRun(t, { wholePasses }) {
  const argvs = [];
  const runner = async (argv) => {
    argvs.push(argv);
    return { exit_code: wholePasses ? 0 : 1, timed_out: false, stdout: "", stderr: wholePasses ? "" : "boom\n", duration_ms: 1 };
  };
  let ran = false;
  const agentRunner = {
    runManagerPlan: async (request) => request.mode === "finalize"
      ? { outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } }
      : { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [plannedTask("T1")] } },
    runWorker: async (request) => {
      ran = true;
      await mkdir(join(request.context.worktree, "src"), { recursive: true });
      await writeFile(join(request.context.worktree, "src/a.ts"), "export const a = 1;\n");
      return { outcome: "success", report_valid: true, report: projectWorkerReport(request.invocation_id, ["src/a.ts"]) };
    },
    runReviewer: async (request) => ({ outcome: "success", report_valid: true, report: { kind: "review", invocation_id: request.invocation_id }, review: { verdict: "pass", findings: [], tests: {} } }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core, projectId, envelope } = await openTestRunCore(t, {
    agentRunner, runner, prefix: "owl-ts-whole-", emptyPlan: true, files: { "README.md": "x\n" },
    testRun: { mode: "whole", whole_argv: ["bun", "test"] },
  });
  const created = await core.createWork(envelope({ title: "ts", summary: "x", size: "normal", project_id: projectId }, "work"));
  await core.startWork(created.data.work_id, { ...envelope({ mode: "normal" }, "start"), expected_version: created.version });
  await waitFor(() => ran && db.all("SELECT id FROM events WHERE type = 'verification.completed'").length >= 1, { timeoutMs: 30_000, message: "the Task verification" });
  const event = db.all("SELECT payload_json FROM events WHERE type = 'verification.completed' ORDER BY rowid")[0];
  return { argvs, payload: JSON.parse(event.payload_json) };
}

test("code: a .ts-only Task is verified by the Project's whole test run, not left code_unchecked", async (t) => {
  const { argvs, payload } = await tsOnlyTaskWithWholeRun(t, { wholePasses: true });
  assert.deepEqual(argvs.at(-1), ["bun", "test"]);
  assert.notEqual(payload.verification.error_key, "code_unchecked");
  assert.equal(payload.outcome, "pass");
});

test("code: a failing whole test run fails the .ts-only Task as a test failure", async (t) => {
  const { argvs, payload } = await tsOnlyTaskWithWholeRun(t, { wholePasses: false });
  assert.deepEqual(argvs.at(-1), ["bun", "test"]);
  assert.equal(payload.outcome, "fail");
  assert.equal(payload.verification.error_key, "test_failed");
});
