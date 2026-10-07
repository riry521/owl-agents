import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore, command } from "./core.mjs";
import { git } from "./git.mjs";
import { disablePlanQuality } from "./plan-quality.mjs";

/** Marker that only appears in raw stdout/stderr, so a test can prove it never reaches a Worker. */
export const RAW_STDOUT_MARKER = "RAW_STDOUT_TAIL_MARKER";
export const RAW_STDERR_MARKER = "RAW_STDERR_TAIL_MARKER";

/** Settings a Project saves as test_run: the commands and locations come from here, not from Core. */
export const TEST_RUN_SETTINGS = {
  test_patterns: ["tests/**/*.test.mjs"],
  file_argv: ["node", "--test", "{file}"],
  concurrency: 1,
  flaky_retries: 0,
  source_map: [],
};

const moduleSource = (name) => `export const ${name} = 1;\n`;
const testSource = (name) => `import { ${name} } from '../src/${name}.mjs';\nimport { test } from 'node:test';\ntest('${name}', () => ${name});\n`;

/** Three test files, each importing its own module: a, b and c are unrelated to each other. */
export const REPO_FILES = Object.fromEntries(["a", "b", "c"].flatMap((name) => [
  [`src/${name}.mjs`, moduleSource(name)],
  [`tests/${name}.test.mjs`, testSource(name)],
]));

/** Where a stub run happened: the Task worktree, the integrated Work checkout or the baseline checkout. */
export const phaseOf = (cwd) => (cwd.includes("test-baseline") ? "baseline" : cwd.includes("__work__") ? "work" : "task");

/**
 * A TestCommandRunner that never starts a process. `failing(file, phase)` says whether a test file
 * fails; a failing file prints TAP with one failed test plus raw output that carries the markers.
 */
export function createStubTestRunner(failing) {
  const calls = [];
  const run = async (argv, cwd) => {
    const file = argv[argv.length - 1];
    const phase = phaseOf(cwd);
    calls.push({ file, phase, cwd });
    const name = file.replace(/^tests\//u, "").replace(/\.test\.mjs$/u, "");
    if (!failing(file, phase)) {
      return { exit_code: 0, timed_out: false, stdout: `TAP version 13\nok 1 - ${name}\n`, stderr: "", duration_ms: 1 };
    }
    const stdout = [
      "TAP version 13",
      `# Subtest: ${name} works`,
      `not ok 1 - ${name} works`,
      "  ---",
      "  duration_ms: 1",
      `  location: '${join(cwd, file)}:3:1'`,
      "  failureType: 'testCodeFailure'",
      `  error: 'expected 1 to equal 2 in ${name}'`,
      "  ...",
      RAW_STDOUT_MARKER,
    ].join("\n");
    return { exit_code: 1, timed_out: false, stdout, stderr: `${RAW_STDERR_MARKER}\n`, duration_ms: 1 };
  };
  return { run, calls };
}

const envelope = (payload, key) => command(payload, `test-run-core:${key}:${createUlid()}`, 0);

/**
 * A real Core (real Git gateway) with a Project whose repository holds REPO_FILES and whose test_run
 * settings drive the stub runner. Plan quality is off so a minimal Manager plan is accepted.
 */
export async function openTestRunCore(t, { agentRunner, runner, prefix, files = REPO_FILES, testRun = TEST_RUN_SETTINGS, testPolicy, projectCheckArgv = [process.execPath, "-e", "process.exit(0)"], emptyPlan = false }) {
  const { root, db, core } = await createTestCore(t, {
    agentRunner,
    testCommandRunner: runner,
    max_parallel: 1,
    dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 },
  }, { prefix });
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "--initial-branch=main");
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(repo, name, ".."), { recursive: true });
    await writeFile(join(repo, name), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "initial");
  // A passing Project check keeps Task verification in "supplement" mode, so Core's test run is what decides.
  const created = await core.createProject(envelope({
    name: "Test run project",
    canonical_path: repo,
    base_branch: "main",
    allowed_roots: [root],
    verification_plan: emptyPlan ? [] : [{
      command_id: "project-check", argv: projectCheckArgv, cwd: ".", env_allowlist: [],
      timeout_seconds: 10, stdout_limit: 1024, stderr_limit: 1024, expected_exit_codes: [0], executor: "core",
    }],
    test_run: testRun,
    ...(testPolicy === undefined ? {} : { test_policy: testPolicy }),
  }, "project"));
  await core.start();
  await disablePlanQuality(db);
  return { root, db, core, repo, projectId: created.data.id, envelope };
}

/** A Worker report that passes the completion gate. */
export function workerReport(invocationId, changes) {
  return {
    kind: "report", schema_version: "1.1.0", invocation_id: invocationId, result: "success",
    work_done: "Done.", changes: changes.map((file) => ({ file, action: "modified" })), remaining_issues: [], next_action: "none",
    needs_replanning: false, question_for_manager: null,
    verification: {
      status: "passed", method: "Checked.", checks: [], integration_check: null,
      acceptance: [{ criterion_id: "AC1", criterion: "Code works.", status: "passed", evidence: "Looked." }],
    },
  };
}

export const plannedTask = (id, title = `${id} title`) => ({
  id, title, type: "code", acceptance: "Code works.", depends_on: [], required_sections: [], required_tests: [], replaces: [],
});
