import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";

import { baselineTestRun, latestTestRun, listTestFiles, recordTestRunInTransaction, runTestFiles, runWholeSuite, selectTests } from "../../packages/core/dist/test-runs.js";
import { runCoreTests } from "../../packages/core/dist/core-test-run.js";
import { resolveTestRun } from "../../packages/core/dist/test-detection.js";
import { testFailureKey } from "../../packages/core/dist/nightly-tests.js";
import { triageTestFailures } from "../../packages/core/dist/test-failure-triage.js";
import { DEFAULT_TEST_RUN_SETTINGS, readTestRunSettings, validateTestRunSettings } from "../../packages/shared/dist/test-run-settings.js";
import { git, createTestRepo } from "../helpers/git.mjs";
import { openTestDatabase } from "../helpers/db.mjs";

const execFileAsync = promisify(execFile);
const pass = "import { test } from 'node:test';\ntest('ok', () => {});\n";
const failing = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('boom', () => assert.equal(1, 2));\n";
const files = {
  "tests/a.test.mjs": pass,
  "tests/b.test.mjs": failing,
  "tests/c.test.mjs": pass,
  "src/lib.mjs": "export const x = 1;\n",
  "tests/d.test.mjs": "import { x } from '../src/lib.mjs';\nimport { test } from 'node:test';\ntest('d', () => x);\n",
};
const settings = readTestRunSettings({ test_patterns: ["tests/**/*.test.mjs"], concurrency: 2, flaky_retries: 1 });

// A real `node --test` process behind the injectable runner, so TAP, exit codes and timing are genuine.
const nodeRunner = async (argv, cwd) => {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    return { exit_code: 0, timed_out: false, stdout, stderr, duration_ms: Date.now() - started };
  } catch (error) {
    return { exit_code: error.code, timed_out: false, stdout: error.stdout ?? "", stderr: error.stderr ?? "", duration_ms: Date.now() - started };
  }
};

async function seed(db) {
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('o', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json, verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES ('p', 'o', 'P', '/x', 'main', '[]', '[]', '[]', ?, ?)`, now, now,
    );
  });
}

test("a run stores per-file status, commit, duration and failed test names", async (t) => {
  const repo = await createTestRepo(t, { files });
  const { db } = await openTestDatabase(t);
  await seed(db);
  const testFiles = await listTestFiles(repo, settings);
  assert.equal(testFiles.length, 4);
  const execution = await runTestFiles({ root: repo, files: testFiles.slice(0, 3), settings, run: nodeRunner });
  const selection = await selectTests({ scope: "work", root: repo, testFiles, changedFiles: [], previous: null, requiredTests: [], forceFull: "first_work_run", settings });
  const commit = git(repo, "rev-parse", "HEAD");
  await db.createWriteLane().transact((tx) => {
    recordTestRunInTransaction(tx, {
      project_id: "p", work_id: null, task_id: null, agent_run_id: null, scope: "baseline", mode: "full",
      commit_sha: commit, base_commit: null, selection, started_at: new Date().toISOString(), execution, classified: new Map(),
    }, new Date().toISOString());
  });
  const record = baselineTestRun(db, "p", commit);
  assert.equal(record.status, "failed");
  assert.equal(record.commit_sha, commit);
  assert.deepEqual(record.files.map((f) => [f.file, f.status]), [["tests/a.test.mjs", "passed"], ["tests/b.test.mjs", "failed"], ["tests/c.test.mjs", "passed"]]);
  assert.equal(record.files[1].failures[0].name, "boom");
  const row = db.get("SELECT duration_ms, attempts FROM test_run_files WHERE file = 'tests/b.test.mjs'");
  assert.equal(row.attempts, 2);
  assert.ok(row.duration_ms > 0);
});

test("listTestFiles lists test files inside dot-directories such as .github", async (t) => {
  const repo = await createTestRepo(t, { files: { ".github/tests/x.test.mjs": pass, "src/lib.mjs": "" } });
  assert.deepEqual(await listTestFiles(repo, readTestRunSettings({ test_patterns: ["**/*.test.mjs"] })), [".github/tests/x.test.mjs"]);
});

test("a retry selects the previously failed file and the tests related to changes, not the passing unrelated ones", async (t) => {
  const repo = await createTestRepo(t, { files: { ...files, "tests/e.test.mjs": "import '../src/side.mjs';\nimport { test } from 'node:test';\ntest('e', () => {});\n", "src/side.mjs": "" } });
  const { db } = await openTestDatabase(t);
  await seed(db);
  const all = await listTestFiles(repo, settings);
  const testFiles = all.filter((f) => f !== "tests/d.test.mjs" && f !== "tests/e.test.mjs");
  const ran = [];
  const counting = (argv, cwd) => { ran.push(argv[argv.length - 1]); return nodeRunner(argv, cwd); };
  const record = (commit, selection, execution) => db.createWriteLane().transact((tx) => {
    recordTestRunInTransaction(tx, {
      project_id: "p", work_id: null, task_id: null, agent_run_id: null, scope: "baseline", mode: selection.mode,
      commit_sha: commit, base_commit: null, selection, started_at: new Date().toISOString(), execution, classified: new Map(),
    }, new Date().toISOString());
  });
  const select = (previous, changedFiles, list = testFiles) => selectTests({ scope: "work", root: repo, testFiles: list, changedFiles, previous, requiredTests: [], forceFull: previous === null ? "first_work_run" : null, settings });
  const first = await select(null, []);
  await record("c1", first, await runTestFiles({ root: repo, files: first.files, settings, run: counting }));
  const previous = baselineTestRun(db, "p", "c1");
  assert.deepEqual(previous.files.map((f) => f.status), ["passed", "failed", "passed"]);

  ran.length = 0;
  const second = await select(previous, []);
  assert.deepEqual(second.files, ["tests/b.test.mjs"]);
  assert.equal(second.mode, "selected");
  await record("c2", second, await runTestFiles({ root: repo, files: second.files, settings, run: counting }));
  assert.ok(ran.length > 0 && ran.every((f) => f === "tests/b.test.mjs"));
  assert.deepEqual(baselineTestRun(db, "p", "c2").files.map((f) => f.file), ["tests/b.test.mjs"]);

  // A changed module selects the tests that import it, by named or side-effect import.
  assert.deepEqual((await select(previous, ["src/lib.mjs"], all)).files, ["tests/b.test.mjs", "tests/d.test.mjs"]);
  assert.deepEqual((await select(previous, ["src/side.mjs"], all)).files, ["tests/b.test.mjs", "tests/e.test.mjs"]);
});

test("a retried file stores the summed duration of all attempts", async () => {
  const failRun = async () => ({ exit_code: 1, timed_out: false, stdout: "", stderr: "x", duration_ms: 20 });
  const execution = await runTestFiles({ root: ".", files: ["tests/a.test.mjs"], settings, run: failRun });
  assert.equal(execution.files[0].attempts, 2);
  assert.equal(execution.files[0].duration_ms, 40);
});

test("changed files matching full_run_patterns select every test file; the patterns come from settings", async (t) => {
  const repo = await createTestRepo(t, { files });
  const testFiles = await listTestFiles(repo, settings);
  const select = (changedFiles, s, scope = "work") => selectTests({ scope, root: repo, testFiles, changedFiles, previous: null, requiredTests: [], forceFull: null, settings: s });
  const full = await select(["package.json"], settings);
  assert.equal(full.mode, "full");
  assert.deepEqual(full.files, testFiles);
  assert.equal(full.full_reason, "full_run_pattern:package.json");
  assert.equal((await select(["docs/readme.md"], settings)).mode, "selected");
  // The pattern is configuration: a different value changes the selection.
  const custom = readTestRunSettings({ ...settings, full_run_patterns: ["docs/**"] });
  assert.equal((await select(["docs/readme.md"], custom)).mode, "full");
  assert.equal((await select(["package.json"], custom)).mode, "selected");
  // Task-level selection never switches to a full run.
  assert.equal((await select(["package.json"], settings, "task")).mode, "selected");
});

test("test-run settings fall back per key and reject bad values", () => {
  assert.deepEqual(readTestRunSettings(null), DEFAULT_TEST_RUN_SETTINGS);
  const warnings = [];
  const read = readTestRunSettings({ file_argv: ["node"], flaky_retries: 0 }, (m) => warnings.push(m));
  assert.deepEqual(read.file_argv, DEFAULT_TEST_RUN_SETTINGS.file_argv);
  assert.equal(read.flaky_retries, 0);
  assert.equal(warnings.length, 1);
  assert.equal(validateTestRunSettings({ file_argv: ["node", "{file}"], source_map: [{ from: "(", to: "" }], nope: 1 }).length, 2);
});

test("the latest run of a Work is null when none was recorded", async (t) => {
  const { db } = await openTestDatabase(t);
  assert.equal(latestTestRun(db, { scope: "work", work_id: "none" }), null);
});

const target = "tests/x.test.mjs";
const failureOf = (name) => ({ file: target, name, line: 1, message: "boom" });
const baselineOf = (failures, status = "failed") => ({
  id: "b", project_id: "p", work_id: null, task_id: null, scope: "baseline", mode: "selected", commit_sha: "c", status, finished_at: "x",
  files: failures.length === 0 ? [] : [{ file: target, status: "failed", failures: failures.map((f) => ({ ...f, classification: "in_scope", pre_existing_by: null })) }],
});
const triage = (failure, { nightly = [], baseline = null, changed = [] } = {}) => triageTestFailures({
  files: [{ file: target, status: "failed", duration_ms: 1, exit_code: 1, attempts: 1, failures: [failure], output_tail: "" }],
  nightlyKeys: new Set(nightly.map(testFailureKey)),
  baseline,
  workChangedFiles: new Set(changed),
}).get(target)[0];

test("triage marks a failure that the nightly run already has as pre_existing by nightly", () => {
  const f = failureOf("t");
  const result = triage(f, { nightly: [f] });
  assert.deepEqual([result.classification, result.pre_existing_by], ["pre_existing", "nightly"]);
});

test("triage marks a failure that the baseline also has as pre_existing by baseline", () => {
  const f = failureOf("t");
  const result = triage(f, { baseline: baselineOf([f]) });
  assert.deepEqual([result.classification, result.pre_existing_by], ["pre_existing", "baseline"]);
});

test("triage keeps a failure in_scope when the Work changed the test file", () => {
  const f = failureOf("t");
  assert.equal(triage(f, { baseline: baselineOf([f]), changed: [target] }).classification, "in_scope");
});

test("triage keeps a file-level failure in_scope unless the nightly run has it", () => {
  const f = failureOf("");
  assert.equal(triage(f, { baseline: baselineOf([f]) }).classification, "in_scope");
  assert.equal(triage(f, { nightly: [f] }).pre_existing_by, "nightly");
});

test("triage treats a failure as in_scope without a baseline, with an errored baseline or when the baseline lacks the key", () => {
  const f = failureOf("t");
  assert.equal(triage(f, { baseline: null }).classification, "in_scope");
  assert.equal(triage(f, { baseline: baselineOf([failureOf("other")]) }).classification, "in_scope");
  assert.equal(triage(f, { baseline: baselineOf([], "error") }).classification, "in_scope");
});

// Whole-command mode: one run of whole_argv per check, judged by its exit code; prepare runs once before it.

async function wholeRun(t, exitCode) {
  const repo = await createTestRepo(t);
  const { db } = await openTestDatabase(t);
  await seed(db);
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES ('w', 'o', 'p', 'W', '', 'normal', 'running', '[]', '[]', ?, ?)`, now, now,
    );
  });
  const calls = [];
  const run = async (argv) => {
    calls.push(argv.join(" "));
    const failed = argv[0] === "suite" && exitCode !== 0;
    return { exit_code: argv[0] === "suite" ? exitCode : 0, timed_out: false, stdout: "", stderr: failed ? "boom\n" : "", duration_ms: 1 };
  };
  const outcome = await runCoreTests(
    { db, writeLane: db.createWriteLane(), workspaceRoot: repo, baselineRunner: run, baselineLocks: new Map() },
    {
      scope: "work", project_id: "p", work_id: "w", task_id: null, agent_run_id: null, root: repo, commit: git(repo, "rev-parse", "HEAD"),
      base_commit: null, repo, changed_files: [], work_changed_files: [], required_tests: [], force_full: null,
      settings: readTestRunSettings({ mode: "whole", whole_argv: ["suite", "--all"], prepare_argv: ["prep"] }), run,
    },
  );
  return { db, outcome, calls };
}

test("a whole-command run is passed on exit code 0 and failed otherwise, with prepare run once first", async (t) => {
  for (const [exitCode, status] of [[0, "passed"], [1, "failed"]]) {
    const { db, outcome, calls } = await wholeRun(t, exitCode);
    assert.equal(outcome.status, status);
    assert.deepEqual(calls, ["prep", "suite --all"]);
    assert.equal(db.get("SELECT status FROM test_runs WHERE id = ?", outcome.run_id).status, status);
    assert.deepEqual(db.all("SELECT file FROM test_run_files WHERE run_id = ?", outcome.run_id).map((row) => row.file), ["*"]);
  }
});

test("resolveTestRun prefers explicit settings, then a saved detection, and detects when neither fits", async (t) => {
  const repo = await createTestRepo(t, { files: { "go.mod": "module x\n" } });
  const now = "2026-01-01T00:00:00.000Z";
  const fresh = resolveTestRun({ explicit_json: null, detected_json: null, root: repo, now });
  assert.deepEqual([fresh.enabled, fresh.source, fresh.settings.whole_argv, fresh.save?.rule_id], [true, "detected", ["go", "test", "./..."], "go"]);
  const saved = resolveTestRun({ explicit_json: null, detected_json: JSON.stringify(fresh.save), root: repo, now });
  assert.equal(saved.save, null);
  assert.deepEqual(saved.settings.whole_argv, ["go", "test", "./..."]);
  const stale = resolveTestRun({ explicit_json: null, detected_json: JSON.stringify({ ...fresh.save, marker_digest: "old" }), root: repo, now });
  assert.notEqual(stale.save, null);
  const explicit = resolveTestRun({ explicit_json: JSON.stringify({ file_argv: ["x", "{file}"] }), detected_json: JSON.stringify(fresh.save), root: repo, now });
  assert.deepEqual([explicit.source, explicit.settings.mode, explicit.save], ["explicit", "per_file", null]);
  const off = resolveTestRun({ explicit_json: JSON.stringify({ mode: "off" }), detected_json: null, root: repo, now });
  assert.deepEqual([off.enabled, off.reason], [false, "explicit_off"]);
});

test("a failed bun whole run reports the failing test names and error lines, not the summary", async () => {
  const stdout = "bun test v1.2.0\n\nsrc/a.test.ts:\n(pass) ok [0.10ms]\n(fail) math > adds [1.20ms]\n\n 1 pass\n 1 fail\nRan 2 tests across 1 files. [20.00ms]\n";
  const stderr = "error: expect(received).toBe(expected)\n\nExpected: 3\nReceived: 2\n";
  const bunSettings = readTestRunSettings({ mode: "whole", whole_argv: ["bun", "test"] });
  const run = async () => ({ exit_code: 1, timed_out: false, stdout, stderr, duration_ms: 1 });
  const [file] = (await runWholeSuite({ root: ".", settings: bunSettings, run })).files;
  assert.equal(file.status, "failed");
  assert.deepEqual(file.failures.map((failure) => failure.name), ["math > adds"]);
  assert.match(file.failures[0].message, /^error: expect/);

  const errorOnly = async () => ({ exit_code: 1, timed_out: false, stdout: "Ran 0 tests across 1 files.\n", stderr: "error: Cannot find module './x'\n", duration_ms: 1 });
  const [second] = (await runWholeSuite({ root: ".", settings: bunSettings, run: errorOnly })).files;
  assert.equal(second.failures[0].message, "error: Cannot find module './x'");
});
