import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { baselineTestRun, latestTestRun, listTestFiles, listTestTargets, prepareCheckout, recordTestRunInTransaction, runTestFiles, runWholeSuite, selectTests, targetCommand, WORK_EVERY_UNIT_REASON } from "../../packages/core/dist/test-runs.js";
import { runCoreTests, WHOLE_DEFERRED_REASON } from "../../packages/core/dist/core-test-run.js";
import { resolveTestRun } from "../../packages/core/dist/test-detection.js";
import { testFailureKey } from "../../packages/core/dist/nightly-tests.js";
import { ensureBaselineRun, triageTestFailures } from "../../packages/core/dist/test-failure-triage.js";
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
const triage = (failure, { nightly = [], baseline = null, changed = [], known = [] } = {}) => triageTestFailures({
  files: [{ file: target, status: "failed", duration_ms: 1, exit_code: 1, attempts: 1, failures: [failure], output_tail: "" }],
  nightlyKeys: new Set(nightly.map(testFailureKey)),
  baseline,
  workChangedFiles: new Set(changed),
  knownKeys: new Set(known.map(testFailureKey)),
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

test("triage marks a failure recorded as known pre_existing by known, and keeps others and changed files in_scope", () => {
  const f = failureOf("t");
  const result = triage(f, { known: [f] });
  assert.deepEqual([result.classification, result.pre_existing_by], ["pre_existing", "known"]);
  assert.equal(triage(failureOf("other"), { known: [f] }).classification, "in_scope");
  assert.equal(triage(f, { known: [f], changed: [target] }).classification, "in_scope");
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

async function wholeRun(t, exitCode, { scope = "work", force_full = null } = {}) {
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
      scope, project_id: "p", work_id: "w", task_id: scope === "task" ? "t" : null, agent_run_id: null, root: repo, commit: git(repo, "rev-parse", "HEAD"),
      base_commit: null, repo, changed_files: [], work_changed_files: [], required_tests: [], force_full,
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

test("a whole Work check runs whole_argv on the first and later runs, recorded as scope work and mode full", async (t) => {
  for (const force_full of ["first_work_run", null]) {
    const { db, outcome, calls } = await wholeRun(t, 0, { force_full });
    assert.deepEqual(calls, ["prep", "suite --all"]);
    const row = db.get("SELECT scope, mode FROM test_runs WHERE id = ?", outcome.run_id);
    assert.deepEqual([row.scope, row.mode], ["work", "full"]);
  }
});

test("a whole Task check starts no runner and is skipped with the whole_deferred_to_work reason", async (t) => {
  const { db, outcome, calls } = await wholeRun(t, 1, { scope: "task" });
  assert.deepEqual(calls, []);
  assert.deepEqual([outcome.status, outcome.reason, outcome.run_id], ["skipped", WHOLE_DEFERRED_REASON, null]);
  assert.equal(WHOLE_DEFERRED_REASON, "whole_deferred_to_work");
  assert.equal(db.all("SELECT id FROM test_runs").length, 0);
});

test("per_file: a Task check runs only the tests related to the change, the Work's first run runs every test file", async (t) => {
  const repo = await createTestRepo(t, { files });
  const { db } = await openTestDatabase(t);
  await seed(db);
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES ('w', 'o', 'p', 'W', '', 'normal', 'running', '[]', '[]', ?, ?)`, now, now,
    );
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
       VALUES ('t', 'w', 'T', 'code', 'running', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`, now, now,
    );
  });
  const ran = [];
  const run = async (argv) => {
    ran.push(argv.at(-1));
    return { exit_code: 0, timed_out: false, stdout: "", stderr: "", duration_ms: 1 };
  };
  const check = (scope, force_full) => runCoreTests(
    { db, writeLane: db.createWriteLane(), workspaceRoot: repo, baselineRunner: run, baselineLocks: new Map() },
    {
      scope, project_id: "p", work_id: "w", task_id: scope === "task" ? "t" : null, agent_run_id: null, root: repo, commit: git(repo, "rev-parse", "HEAD"),
      base_commit: null, repo, changed_files: ["src/lib.mjs"], work_changed_files: ["src/lib.mjs"], required_tests: [], force_full,
      settings: readTestRunSettings({ test_patterns: ["tests/**/*.test.mjs"], concurrency: 1 }), run,
    },
  );
  const task = await check("task", null);
  assert.deepEqual([task.selection.mode, task.selection.files], ["selected", ["tests/d.test.mjs"]]);
  assert.deepEqual(ran, ["tests/d.test.mjs"]);
  ran.length = 0;
  const work = await check("work", "first_work_run");
  assert.deepEqual([work.selection.mode, work.selection.full_reason], ["full", "first_work_run"]);
  assert.deepEqual(work.selection.files, ["tests/a.test.mjs", "tests/b.test.mjs", "tests/c.test.mjs", "tests/d.test.mjs"]);
  assert.deepEqual(ran.sort(), work.selection.files);
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

test("a baseline file already run at a commit is not run again, even after other files were run at that commit", async (t) => {
  const repo = await createTestRepo(t, { files });
  const { db } = await openTestDatabase(t);
  await seed(db);
  const commit = git(repo, "rev-parse", "HEAD");
  const ran = [];
  const counting = (argv, cwd) => { ran.push(argv[argv.length - 1]); return nodeRunner(argv, cwd); };
  const ensure = (baselineFiles) => ensureBaselineRun({
    db, writeLane: db.createWriteLane(), settings, projectId: "p", repo, baseCommit: commit, files: baselineFiles,
    workspaceRoot: repo, run: counting, locks: new Map(),
  });
  await ensure(["tests/b.test.mjs"]);
  await ensure(["tests/a.test.mjs"]);
  ran.length = 0;
  const again = await ensure(["tests/b.test.mjs"]);
  assert.deepEqual(ran, []);
  assert.ok(again.files.some((entry) => entry.file === "tests/b.test.mjs" && entry.status === "failed"));
});

test("prepareCheckout runs setup_argvs in order, then prepare, in test_run.cwd, and stops at the first failure", async () => {
  const calls = [];
  const runWith = (failing) => async (argv, cwd) => {
    calls.push({ argv: argv.join(" "), cwd });
    return { exit_code: argv[0] === failing ? 3 : 0, timed_out: false, stdout: "", stderr: argv[0] === failing ? "no luck\n" : "", duration_ms: 1 };
  };
  const settings = readTestRunSettings({ mode: "whole", whole_argv: ["suite"], setup_argvs: [["one"], ["two"], ["three"]], prepare_argv: ["prep"], cwd: "sub/dir" });
  const root = join(tmpdir(), "owl-prepare-root");
  assert.equal(await prepareCheckout({ root, settings, run: runWith(null) }), null);
  assert.deepEqual(calls.map((call) => call.argv), ["one", "two", "three", "prep"]);
  assert.deepEqual([...new Set(calls.map((call) => call.cwd))], [join(root, "sub/dir")]);
  calls.length = 0;
  const error = await prepareCheckout({ root, settings, run: runWith("two") });
  assert.match(error, /^setup failed \(exit 3\): no luck/u);
  assert.deepEqual(calls.map((call) => call.argv), ["one", "two"]);
});

test("setup_argvs read cwd-relative paths in a subfolder, and a checkout-relative path is not doubled", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-setup-root-"));
  await mkdir(join(root, "backend"));
  await writeFile(join(root, "backend", "requirements.txt"), "x\n");
  const read = (path) => [process.execPath, "-e", `require('node:fs').readFileSync(${JSON.stringify(path)})`];
  const settingsFor = (path) => readTestRunSettings({ mode: "whole", whole_argv: ["suite"], cwd: "backend", setup_argvs: [read(path)] });
  assert.equal(await prepareCheckout({ root, settings: settingsFor("requirements.txt"), run: nodeRunner }), null);
  assert.match(await prepareCheckout({ root, settings: settingsFor("backend/requirements.txt"), run: nodeRunner }), /^setup failed/u);
  await rm(root, { recursive: true, force: true });
});

test("test_run.cwd is relative without .., and every mode accepts a subfolder", () => {
  assert.equal(readTestRunSettings({ mode: "whole", whole_argv: ["suite"], cwd: "a/b" }).cwd, "a/b");
  assert.equal(readTestRunSettings({ mode: "whole", whole_argv: ["suite"], cwd: "../x" }).cwd, ".");
  assert.equal(readTestRunSettings({ mode: "whole", whole_argv: ["suite"], cwd: "/abs" }).cwd, ".");
  assert.equal(readTestRunSettings({ cwd: "a" }).cwd, "a");
  assert.deepEqual(validateTestRunSettings({ mode: "per_file", cwd: "a" }), []);
  for (const cwd of ["../x", "/abs", ""]) assert.notEqual(validateTestRunSettings({ mode: "per_file", cwd }).length, 0, cwd);
});

// setup_cache: the setup runs once per checkout until its inputs change; the hash lives in the git directory.
const cacheSettings = (over = {}) => readTestRunSettings({
  mode: "whole", whole_argv: ["suite"], setup_argvs: [["mkenv"]], prepare_argv: ["prep"],
  setup_cache: { inputs: ["requirements.txt"], outputs: [".venv"] }, ...over,
});

async function cacheCheckout(t) {
  const root = await createTestRepo(t);
  await writeFile(join(root, "requirements.txt"), "a\n");
  git(root, "add", "requirements.txt");
  git(root, "commit", "-m", "requirements");
  await mkdir(join(root, ".venv"));
  const calls = [];
  const run = async (argv) => {
    calls.push(argv[0]);
    return { exit_code: argv[0] === "mkenv" && calls.failMkenv ? 1 : 0, timed_out: false, stdout: "", stderr: "", duration_ms: 1 };
  };
  return { root, calls, run };
}

const setupCalls = (calls) => calls.filter((name) => name === "mkenv" || name === "prep").length;

test("an unchanged setup is not run again in either run path, and leaves git status clean", async (t) => {
  const { root, calls, run } = await cacheCheckout(t);
  const settings = cacheSettings();
  await runWholeSuite({ root, settings, run });
  await runWholeSuite({ root, settings, run });
  assert.equal(setupCalls(calls), 2, "mkenv and prep ran once in total");
  await runTestFiles({ root, files: ["a.test.mjs"], settings: { ...settings, mode: "per_file", file_argv: ["node", "--test", "{file}"] }, run });
  assert.equal(setupCalls(calls), 2);
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("a changed input, changed argv, removed output or failed setup runs the setup again", async (t) => {
  const { root, calls, run } = await cacheCheckout(t);
  await runWholeSuite({ root, settings: cacheSettings(), run });
  await writeFile(join(root, "requirements.txt"), "b\n");
  await runWholeSuite({ root, settings: cacheSettings(), run });
  assert.equal(setupCalls(calls), 4, "input content changed");
  await runWholeSuite({ root, settings: cacheSettings({ prepare_argv: ["prep", "2"] }), run });
  assert.equal(setupCalls(calls), 6, "prepare_argv changed");
  await rm(join(root, ".venv"), { recursive: true });
  await runWholeSuite({ root, settings: cacheSettings({ prepare_argv: ["prep", "2"] }), run });
  assert.equal(setupCalls(calls), 8, "output removed");
  await writeFile(join(root, "requirements.txt"), "c\n");
  calls.failMkenv = true;
  assert.equal((await runWholeSuite({ root, settings: cacheSettings(), run })).status, "error");
  calls.failMkenv = false;
  const failed = setupCalls(calls);
  await runWholeSuite({ root, settings: cacheSettings(), run });
  assert.equal(setupCalls(calls), failed + 2, "a failed setup recorded nothing");
});

test("settings without a setup record run the setup every time", async (t) => {
  const { root, calls, run } = await cacheCheckout(t);
  const settings = cacheSettings({ setup_cache: null });
  assert.equal(settings.setup_cache, null);
  await runWholeSuite({ root, settings, run });
  await runWholeSuite({ root, settings, run });
  assert.equal(setupCalls(calls), 4);
});

test("a test run that fails for the environment after a skipped setup prepares again and runs once more", async (t) => {
  const repo = await createTestRepo(t);
  const { db } = await openTestDatabase(t);
  await seed(db);
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run(`INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at) VALUES ('w', 'o', 'p', 'W', '', 'normal', 'running', '[]', '[]', ?, ?)`, now, now);
  });
  await mkdir(join(repo, ".venv"));
  let broken = false;
  const calls = [];
  const count = (name) => calls.filter((call) => call === name).length;
  const run = async (argv) => {
    calls.push(argv[0]);
    const bad = argv[0] === "suite" && broken;
    if (argv[0] === "mkenv") broken = false;
    return { exit_code: bad ? 127 : 0, timed_out: false, stdout: "", stderr: bad ? "no such interpreter\n" : "", duration_ms: 1 };
  };
  const request = () => ({
    scope: "work", project_id: "p", work_id: "w", task_id: null, agent_run_id: null, root: repo, commit: git(repo, "rev-parse", "HEAD"),
    base_commit: null, repo, changed_files: [], work_changed_files: [], required_tests: [], force_full: null,
    settings: cacheSettings({ setup_cache: { inputs: [], outputs: [".venv"] }, prepare_argv: [] }), run,
    environment_signals: { exit_codes: [127], patterns: [] },
  });
  const deps = { db, writeLane: db.createWriteLane(), workspaceRoot: repo, baselineRunner: run, baselineLocks: new Map() };
  await runCoreTests(deps, request());
  broken = true;
  const outcome = await runCoreTests(deps, request());
  assert.equal(count("mkenv"), 2, "setup ran again after the environment failure");
  assert.equal(count("suite"), 3, "the suite ran once more");
  assert.equal(outcome.status, "passed");
  await runCoreTests(deps, request());
  assert.equal(count("mkenv"), 2, "the re-prepare was recorded");
});

// Units: a folder or package is one run target; the marker names and globs below exist only in these tests.
test("listTestTargets maps paths to folder and package targets, and targetCommand passes cwd-relative paths", async (t) => {
  const repo = await createTestRepo(t, { files: {
    "backend/pkgs/one/unit.marker": "", "backend/pkgs/one/src/lib.txt": "", "backend/pkgs/one/checks/check_a.t": "", "backend/pkgs/two/check_b.t": "",
    "backend/loose/check_c.t": "", "other/check_d.t": "",
  } });
  const base = { test_patterns: ["**/check_*.t"], unit_argv: ["unit-runner", "{unit}"], unit_markers: ["unit.marker"] };
  const folder = await listTestTargets(repo, readTestRunSettings({ ...base, unit: "folder" }));
  assert.deepEqual(folder.targets, ["backend/loose", "backend/pkgs/one/checks", "backend/pkgs/two", "other"]);
  assert.deepEqual([folder.targetOf("backend/pkgs/one/checks/check_a.t"), folder.targetOf("backend/pkgs/one/src/lib.txt"), folder.targetOf("backend/pkgs/two/helper.txt")], ["backend/pkgs/one/checks", null, "backend/pkgs/two"]);
  assert.deepEqual(folder.files, (await listTestFiles(repo, readTestRunSettings({ ...base, unit: "folder" }))));

  const pkgSettings = readTestRunSettings({ ...base, unit: "package", cwd: "backend" });
  const pkg = await listTestTargets(repo, pkgSettings);
  assert.deepEqual(pkg.files, ["backend/loose/check_c.t", "backend/pkgs/one/checks/check_a.t", "backend/pkgs/two/check_b.t"]);
  assert.deepEqual(pkg.targets, ["backend", "backend/pkgs/one"], "a test outside any package root falls back to cwd");
  assert.deepEqual([pkg.targetOf("backend/pkgs/one/checks/check_a.t"), pkg.targetOf("backend/pkgs/one/src/lib.txt"), pkg.targetOf("backend/pkgs/one/unit.marker")], ["backend/pkgs/one", "backend/pkgs/one", "backend/pkgs/one"]);
  assert.equal(pkg.targetOf("other/check_d.t"), null, "outside cwd");
  assert.equal(pkg.targetOf("backend/../other/check_d.t"), null, "path leaving cwd after normalisation");
  assert.equal(pkg.targetOf("../check_d.t"), null, "parent path");
  assert.deepEqual(targetCommand("/r", pkgSettings, "backend/pkgs/one"), { argv: ["unit-runner", "pkgs/one"], cwd: "/r/backend" });
  assert.deepEqual(targetCommand("/r", pkgSettings, "backend").argv, ["unit-runner", "."]);
  assert.deepEqual(targetCommand("/r", readTestRunSettings({ ...base, unit: "folder" }), "other"), { argv: ["unit-runner", "other"], cwd: "/r" });
  const fileSettings = readTestRunSettings({ file_argv: ["runner", "{file}"], test_patterns: ["backend/**/*.t"], cwd: "backend" });
  assert.deepEqual(targetCommand("/r", fileSettings, "backend/x/a.t"), { argv: ["runner", "x/a.t"], cwd: "/r/backend" });
  assert.equal((await listTestTargets(repo, fileSettings)).targetOf("other/check_d.t"), null);
});

test("folder units: a Task check runs the units the change touches and the failed ones; a Work check runs every unit", async (t) => {
  const repo = await createTestRepo(t, { files: {
    "suite/alpha/check_one.t": "", "suite/alpha/helper.txt": "", "suite/beta/check_two.t": "", "suite/gamma/check_three.t": "",
  } });
  const { db } = await openTestDatabase(t);
  await seed(db);
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run(`INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at) VALUES ('w', 'o', 'p', 'W', '', 'normal', 'running', '[]', '[]', ?, ?)`, now, now);
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
       VALUES ('t', 'w', 'T', 'code', 'running', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`, now, now,
    );
  });
  let failUnit = "suite/gamma";
  const ran = [];
  const run = async (argv, cwd) => {
    const unit = argv.at(-1);
    ran.push({ unit, cwd });
    const bad = unit === failUnit;
    return { exit_code: bad ? 1 : 0, timed_out: false, stdout: bad ? "TAP version 13\nnot ok 1 - gamma\n1..1\n" : "", stderr: "", duration_ms: 1 };
  };
  const check = (scope, changed, force_full) => runCoreTests(
    { db, writeLane: db.createWriteLane(), workspaceRoot: repo, baselineRunner: run, baselineLocks: new Map() },
    {
      scope, project_id: "p", work_id: "w", task_id: scope === "task" ? "t" : null, agent_run_id: null, root: repo, commit: git(repo, "rev-parse", "HEAD"),
      base_commit: null, repo, changed_files: changed, work_changed_files: changed, required_tests: [], force_full,
      settings: readTestRunSettings({ test_patterns: ["suite/**/check_*.t"], unit: "folder", unit_argv: ["unit-runner", "{unit}"], concurrency: 1, flaky_retries: 0 }), run,
    },
  );
  const first = await check("task", ["suite/gamma/check_three.t"], null);
  assert.deepEqual([first.selection.files, first.failed_files], [["suite/gamma"], ["suite/gamma"]]);
  assert.deepEqual(first.test_files, { passed: [], failed: ["suite/gamma/check_three.t"] });
  failUnit = "";
  ran.length = 0;
  const second = await check("task", ["suite/alpha/helper.txt"], null);
  assert.deepEqual(second.selection.files, ["suite/alpha", "suite/gamma"]);
  assert.deepEqual(ran.map((call) => call.unit).sort(), ["suite/alpha", "suite/gamma"], "suite/beta did not run");
  assert.deepEqual(second.test_files, { passed: ["suite/alpha/check_one.t", "suite/gamma/check_three.t"], failed: [] });
  assert.deepEqual(db.all("SELECT file FROM test_run_files WHERE run_id = ? ORDER BY file", second.run_id).map((row) => row.file), ["suite/alpha", "suite/gamma"]);

  const workFirst = await check("work", ["suite/alpha/helper.txt"], "first_work_run");
  assert.equal(workFirst.selection.files.length, 3);
  ran.length = 0;
  const workSecond = await check("work", ["suite/alpha/helper.txt"], null);
  assert.deepEqual([workSecond.selection.mode, workSecond.selection.full_reason], ["full", WORK_EVERY_UNIT_REASON]);
  assert.equal(WORK_EVERY_UNIT_REASON, "work_every_unit");
  assert.deepEqual(ran.map((call) => call.unit).sort(), ["suite/alpha", "suite/beta", "suite/gamma"]);
});

test("a folder-unit Project prepares once for any number of units, in cwd, and not again until an input changes", async (t) => {
  const root = await createTestRepo(t, { files: { "backend/requirements.txt": "a\n", "backend/a/check_1.t": "", "backend/b/check_2.t": "", "backend/c/check_3.t": "" } });
  await mkdir(join(root, "backend/.venv"));
  const calls = [];
  const run = async (argv, cwd) => {
    calls.push({ name: argv[0], arg: argv[1], cwd });
    return { exit_code: 0, timed_out: false, stdout: "", stderr: "", duration_ms: 1 };
  };
  const settings = readTestRunSettings({
    mode: "per_file", unit: "folder", unit_argv: ["unit-runner", "{unit}"], cwd: "backend", setup_argvs: [["mkenv"]], prepare_argv: ["prep"],
    setup_cache: { inputs: ["backend/requirements.txt"], outputs: ["backend/.venv"] }, test_patterns: ["backend/**/check_*.t"], concurrency: 3,
  });
  const prepared = () => calls.filter((call) => call.name === "mkenv" || call.name === "prep");
  const files = ["backend/a", "backend/b", "backend/c"];
  await runTestFiles({ root, files, settings, run });
  assert.deepEqual(prepared().map((call) => [call.name, call.cwd]), [["mkenv", join(root, "backend")], ["prep", join(root, "backend")]]);
  assert.deepEqual(calls.filter((call) => call.name === "unit-runner").map((call) => call.arg).sort(), ["a", "b", "c"]);
  await runTestFiles({ root, files, settings, run });
  assert.equal(prepared().length, 2, "the second run prepares nothing");
  assert.equal(git(root, "status", "--porcelain"), "");
  await writeFile(join(root, "backend/requirements.txt"), "b\n");
  await runTestFiles({ root, files, settings, run });
  assert.equal(prepared().length, 4);
});
