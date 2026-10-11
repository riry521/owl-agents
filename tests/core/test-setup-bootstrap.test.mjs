import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";

// The agent is a stub that reports what a real one would prepare. Core runs the probes and the tests for real (sh scripts and the real node).

const PYTHON_FILES = { ".gitignore": ".venv/\n", "requirements.txt": "pytest\n", "src/app.py": "def add(a, b):\n    return a + b\n" };
const NODE_FILES = { ".gitignore": "node_modules/\n", "package.json": '{"name":"sample","version":"1.0.0"}\n', "index.mjs": "export const one = 1;\n" };

const PYTEST_STUB = "#!/bin/sh\necho 'pytest 8.0 (stub)'\n";
const PYTHON_BOOTSTRAP = {
  mode: "whole", whole_argv: ["{python}", "-m", "pytest", "-q"], file_argv: [], prepare_argv: [], test_patterns: ["**/test_*.py", "**/*_test.py"], cwd: ".",
};
const NODE_BOOTSTRAP = {
  mode: "per_file", whole_argv: [], file_argv: ["node", "--test", "--test-reporter=tap", "{file}"], prepare_argv: [], test_patterns: ["**/*.test.{js,mjs,cjs}"], cwd: ".",
};

const report = (over) => ({
  verdict: "no_tests",
  setup_argvs: [],
  test_run: PYTHON_BOOTSTRAP,
  executables: [{ name: "python", path: ".venv/bin/python", probe_argv: ["{python}", "-m", "pytest", "--version"] }],
  confirm_files: [],
  probe_argvs: [["{python}", "-m", "pytest", "--version"]],
  sources: ["requirements.txt"],
  attempts: [],
  installed: [],
  outside_installs: [],
  missing: [],
  notes: "",
  ...over,
});

async function writeExecutable(path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, PYTEST_STUB);
  await chmod(path, 0o755);
}

const venv = (checkout) => writeExecutable(join(checkout, ".venv/bin/python"));

function stubAgent(plan) {
  const calls = [];
  return {
    calls,
    async runTestSetupInvestigation(request) {
      calls.push(request);
      const { act = () => {}, output } = await plan(request);
      await act(request.checkout);
      return { ok: true, invocation_id: request.invocation_id, investigation: output };
    },
  };
}

async function open(t, plan) {
  const agent = stubAgent(plan);
  const ctx = await createTestCore(t, { agentRunner: agent, version: "test-setup-bootstrap" }, { prefix: "owl-test-bootstrap-" });
  const register = async (name, files) => {
    const repo = join(ctx.root, name);
    await mkdir(repo, { recursive: true });
    git(repo, "init", "--initial-branch=main");
    for (const [file, content] of Object.entries({ "README.md": "# sample\n", ...files })) {
      await mkdir(dirname(join(repo, file)), { recursive: true });
      await writeFile(join(repo, file), content);
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "initial");
    const created = await ctx.core.createProject(command({ name, canonical_path: repo, base_branch: "main", allowed_roots: [ctx.root], verification_plan: [] }, `project-${name}`));
    await ctx.core.whenTestSetupIdle();
    return { repo, projectId: created.data.id, tracked: git(repo, "ls-files") };
  };
  const record = (table, id) => {
    const text = ctx.db.get(`SELECT test_setup_json FROM ${table} WHERE id = ?`, id)?.test_setup_json;
    return text == null ? null : JSON.parse(text);
  };
  return { ...ctx, agent, register, record };
}

const untouched = (project) => {
  assert.equal(git(project.repo, "status", "--porcelain", "--untracked-files=no"), "", "no tracked file changed");
  assert.equal(git(project.repo, "ls-files"), project.tracked, "no tracked file added or removed");
};

test("an empty Project is no_language", async (t) => {
  const ctx = await open(t, () => ({ output: report({ verdict: "no_language", test_run: null, executables: [], probe_argvs: [], sources: [] }) }));
  const project = await ctx.register("empty", {});
  assert.equal(ctx.record("projects", project.projectId).status, "no_language");
  untouched(project);
});

test("a Python-only Project is no_tests after .venv, pytest and a probe, and keeps its test_patterns", async (t) => {
  const ctx = await open(t, () => ({ act: venv, output: report({}) }));
  const project = await ctx.register("python-only", PYTHON_FILES);
  const saved = ctx.record("projects", project.projectId);
  assert.equal(saved.status, "no_tests", JSON.stringify(saved.missing));
  assert.ok(saved.test_run.test_patterns.includes("**/test_*.py"));
  assert.equal(saved.probes.length, 1);
  assert.equal(saved.probes[0].exit_code, 0);
  assert.match(saved.executables.python.version, /pytest 8/u);
  untouched(project);
});

test("a package.json Project with no test script is no_tests after a probe with the real node", async (t) => {
  const ctx = await open(t, () => ({ output: report({ test_run: NODE_BOOTSTRAP, executables: [], probe_argvs: [["node", "-e", "require('node:test')"]], sources: ["package.json"] }) }));
  const project = await ctx.register("node-only", NODE_FILES);
  const saved = ctx.record("projects", project.projectId);
  assert.equal(saved.status, "no_tests", JSON.stringify(saved.missing));
  assert.deepEqual(saved.probes.map((probe) => probe.exit_code), [0]);
  assert.deepEqual(saved.probes[0].argv, ["node", "-e", "require('node:test')"]);
  untouched(project);
});

test("an existing test_a.py is run, not reported as no_tests", async (t) => {
  const ctx = await open(t, () => ({ act: venv, output: report({}) }));
  const project = await ctx.register("python-tests", { ...PYTHON_FILES, "tests/test_a.py": "def test_a():\n    assert True\n" });
  const saved = ctx.record("projects", project.projectId);
  assert.equal(saved.status, "ready", JSON.stringify(saved.missing));
  assert.equal(saved.confirmed.by, "core");
  untouched(project);
});

test("a no_tests report without test_patterns is unresolved", async (t) => {
  const ctx = await open(t, () => ({ act: venv, output: report({ test_run: { ...PYTHON_BOOTSTRAP, test_patterns: [] } }) }));
  const project = await ctx.register("no-patterns", PYTHON_FILES);
  const saved = ctx.record("projects", project.projectId);
  assert.equal(saved.status, "unresolved");
  assert.match(saved.missing.join("\n"), /test_patterns/u);
  untouched(project);
});

test("a later Task that adds a.test.mjs runs the no_tests record's setup without the agent and gets a ready record", async (t) => {
  const ctx = await open(t, (request) => {
    if (request.scope === "project") {
      return { output: report({ test_run: NODE_BOOTSTRAP, executables: [], probe_argvs: [["node", "-e", "require('node:test')"]], sources: ["package.json"] }) };
    }
    return { output: report({ verdict: "ready", test_run: request.current.test_run, executables: [], probe_argvs: [], confirm_files: ["a.test.mjs"], sources: ["package.json"] }) };
  });
  const project = await ctx.register("node-later", NODE_FILES);
  const before = ctx.db.get("SELECT test_setup_json FROM projects WHERE id = ?", project.projectId).test_setup_json;
  assert.equal(JSON.parse(before).status, "no_tests");

  const calls = ctx.agent.calls.length;
  const created = await ctx.core.createWork(command({ title: "W", summary: "x", size: "small", project_id: project.projectId }, "work-later"));
  const workId = created.data.work_id;
  const taskId = createUlid();
  const now = new Date().toISOString();
  await ctx.db.createWriteLane().transact((tx) => tx.run(
    "INSERT INTO tasks (id, work_id, manager_task_id, title, type, status, review_decision, acceptance, context, priority, created_at, updated_at) VALUES (?, ?, 'm-later', 'T', 'code', 'running', 'not_required', 'x', '', 'normal', ?, ?)",
    taskId, workId, now, now,
  ));
  const worktree = join(ctx.root, "task-later");
  execFileSync("git", ["clone", project.repo, worktree], { stdio: "ignore" });
  await writeFile(join(worktree, "a.test.mjs"), "import test from 'node:test';\ntest('a', () => {});\n");

  const place = { scope: "task", work_id: workId, task_id: taskId };
  const resolved = await ctx.core.workflow.resolveProjectTestRun(ctx.core.workflow.projectTestRunRow(workId, taskId), worktree, { investigate: true, place });
  assert.equal(ctx.agent.calls.length, calls);
  assert.equal(resolved.setup_match, "tests_changed");
  await ctx.core.workflow.adoptPassedSetup(resolved, { status: "passed" }, { mode: "whole", whole_argv: ["node", "--test"], file_argv: [] }, project.projectId, worktree, place);
  const saved = ctx.record("tasks", taskId);
  assert.equal(saved.status, "ready", JSON.stringify(saved.missing));
  assert.equal(saved.confirmed.by, "core");
  assert.equal(ctx.db.get("SELECT test_setup_json FROM projects WHERE id = ?", project.projectId).test_setup_json, before);
});
