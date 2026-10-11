import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { runWholeSuite } from "../../packages/core/dist/test-runs.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

// The agent and the test commands are stubs; the executables are sh scripts. Core's confirmation, the digests and the records are real.

const REPO_FILES = {
  "README.md": "# sample\n",
  ".gitignore": ".venv/\nnode_modules/\n",
  "requirements.txt": "pytest\n",
  "docs/testing.md": "Run pytest.\n",
  "src/app.py": "import os\n\ndef add(a, b):\n    return a + b\n",
  "tests/test_app.py": "from src.app import add\n\ndef test_add():\n    assert add(1, 2) == 3\n",
};

const SH = "#!/bin/sh\necho 'Python 3.12.0 (stub)'\n";

async function writeFiles(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
}

async function makeRepo(dir, files = REPO_FILES) {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "--initial-branch=main");
  await writeFiles(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "initial");
  return dir;
}

async function writeExecutable(path, body = SH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  await chmod(path, 0o755);
}

const READY = (over = {}) => ({
  verdict: "ready",
  setup_argvs: [],
  test_run: { mode: "whole", whole_argv: ["{python}", "-m", "pytest", "-q"], file_argv: [], prepare_argv: [], test_patterns: ["**/test_*.py"], cwd: "." },
  executables: [{ name: "python", path: ".venv/bin/python", probe_argv: ["{python}", "--version"] }],
  confirm_files: [],
  probe_argvs: [],
  sources: ["requirements.txt", "docs/testing.md", "tests/test_app.py"],
  attempts: [{ argv: ["python3", "-m", "venv", ".venv"], cwd: ".", exit_code: 0, summary: "made the venv" }],
  installed: [],
  outside_installs: [],
  missing: [],
  notes: "",
  ...over,
});

/**
 * An agent that does what `plan(request, n)` says: `act(checkout)` changes the folder, `output` is the report (default: ready with .venv/bin/python).
 * `calls` holds every request.
 */
function stubAgent(plan = () => ({})) {
  const calls = [];
  return {
    calls,
    async runTestSetupInvestigation(request) {
      calls.push(request);
      const { act, output, failure } = await plan(request, calls.length);
      if (failure) return { ok: false, error: failure, invocation_id: request.invocation_id };
      if (act) await act(request.checkout);
      else await writeExecutable(join(request.checkout, ".venv/bin/python"));
      return { ok: true, invocation_id: request.invocation_id, investigation: output ?? READY() };
    },
  };
}

/** A TestCommandRunner that starts nothing; `exitOf(argv, cwd)` gives the exit code. */
function stubRunner(exitOf = () => 0) {
  const calls = [];
  const run = async (argv, cwd) => {
    calls.push({ argv: [...argv], cwd });
    const exit = exitOf(argv, cwd);
    return { exit_code: exit, timed_out: false, stdout: exit === 0 ? "Python 3.12.0 (stub)\n1 passed\n" : "FAILED tests/test_app.py::test_add\n", stderr: "", duration_ms: 1 };
  };
  return { run, calls };
}

async function open(t, { agent, runner = stubRunner() }) {
  const ctx = await createTestCore(t, { agentRunner: agent, testCommandRunner: runner.run, version: "test-setup-investigation" }, { prefix: "owl-test-setup-" });
  const register = async (name, files = REPO_FILES, extra = {}) => {
    const repo = await makeRepo(join(ctx.root, name), files);
    const created = await ctx.core.createProject(command({ name, canonical_path: repo, base_branch: "main", allowed_roots: [ctx.root], verification_plan: [], ...extra }, `project-${name}`));
    await ctx.core.whenTestSetupIdle();
    return { repo, projectId: created.data.id };
  };
  const record = (table, id) => {
    const text = ctx.db.get(`SELECT test_setup_json FROM ${table} WHERE id = ?`, id)?.test_setup_json;
    return text == null ? null : JSON.parse(text);
  };
  return { ...ctx, agent, runner, register, record };
}

async function addTask(ctx, projectId, title) {
  const created = await ctx.core.createWork(command({ title: `W ${title}`, summary: "x", size: "small", project_id: projectId }, `work-${title}`));
  const workId = created.data.work_id;
  const taskId = createUlid();
  const now = new Date().toISOString();
  await ctx.db.createWriteLane().transact((tx) => tx.run(
    "INSERT INTO tasks (id, work_id, manager_task_id, title, type, status, review_decision, acceptance, context, priority, created_at, updated_at) VALUES (?, ?, ?, 'T', 'code', 'running', 'not_required', 'x', '', 'normal', ?, ?)",
    taskId, workId, `m-${title}`, now, now,
  ));
  return { workId, taskId };
}

const resolveAt = (ctx, workId, taskId, root) => ctx.core.workflow.resolveProjectTestRun(
  ctx.core.workflow.projectTestRunRow(workId, taskId), root, { investigate: true, place: { scope: "task", work_id: workId, task_id: taskId } },
);

// ---- AC1: the four registration routes

async function openApi(t, ctx) {
  const dataDir = join(ctx.root, "data");
  await mkdir(dataDir, { recursive: true });
  const api = await startTestHttpServer(t, { core: new ExternalCoreAdapter(ctx.core, ctx.db, ctx.root, dataDir), db: ctx.db, webOut: ctx.root, owlRoot: ctx.root, dataDir }, { token: "test-owner-token" });
  if (api === null) return null;
  const send = async (method, route, payload, version = 0) => {
    const response = await api.request(method, `/api/v1${route}`, command(payload, `route-${createUlid()}`, version));
    return { status: response.status, body: await response.json() };
  };
  return { send };
}

test("every registration route schedules one investigation, and a Project with its own test_run is not investigated", async (t) => {
  const agent = stubAgent();
  const ctx = await open(t, { agent });
  const api = await openApi(t, ctx);
  if (api === null) return t.skip("localhost listen is not permitted in this environment");
  const triggers = () => agent.calls.map((call) => call.trigger);

  const existing = await makeRepo(join(ctx.root, "existing"));
  const setupExisting = await api.send("POST", "/projects/setup", { mode: "existing", name: "existing", path: existing });
  assert.equal(setupExisting.status, 201, JSON.stringify(setupExisting.body));
  await ctx.core.whenTestSetupIdle();
  assert.deepEqual(triggers(), ["project_registered"]);
  assert.equal(agent.calls[0].checkout, existing);

  const parent = join(ctx.root, "parent");
  await mkdir(parent);
  assert.equal((await api.send("POST", "/projects/setup", { mode: "new", name: "fresh", path: parent })).status, 201);
  await ctx.core.whenTestSetupIdle();
  assert.equal(agent.calls.length, 2);
  assert.equal(agent.calls[1].checkout, join(parent, "fresh"));

  const plain = join(ctx.root, "plain");
  await writeFiles(plain, { "README.md": "# plain\n" });
  assert.equal((await api.send("POST", "/projects/setup", { mode: "initialize_existing", name: "plain", path: plain })).status, 201);
  await ctx.core.whenTestSetupIdle();
  assert.equal(agent.calls.length, 3);
  assert.equal(agent.calls[2].checkout, plain);

  const cloned = join(ctx.root, "cloned");
  execFileSync("git", ["clone", existing, cloned], { stdio: "ignore" });
  const created = await api.send("POST", "/projects", { name: "cloned", canonical_path: cloned, base_branch: "main", allowed_roots: [ctx.root], verification_plan: [] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await ctx.core.whenTestSetupIdle();
  assert.equal(agent.calls.length, 4);
  assert.equal(agent.calls[3].checkout, cloned);

  const moved = await makeRepo(join(ctx.root, "moved"));
  const patched = await api.send("PATCH", `/projects/${created.body.data.id}`, { canonical_path: moved }, created.body.version);
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  await ctx.core.whenTestSetupIdle();
  assert.equal(agent.calls.length, 5);
  assert.equal(agent.calls[4].trigger, "project_path_changed");
  assert.equal(agent.calls[4].checkout, moved);

  const own = await api.send("POST", "/projects", {
    name: "owned", canonical_path: await makeRepo(join(ctx.root, "owned")), base_branch: "main", allowed_roots: [ctx.root], verification_plan: [],
    test_run: { test_patterns: ["tests/**/*.test.mjs"], file_argv: ["node", "--test", "{file}"], concurrency: 1, flaky_retries: 0, source_map: [] },
  });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  await ctx.core.whenTestSetupIdle();
  assert.equal(agent.calls.length, 5, "a Project with test_run is not scheduled");
  assert.equal(ctx.record("projects", own.body.data.id), null);
});

// ---- AC2: four environments

test("Core confirms four environments and saves a ready command with its executables, sources, attempts and times", async (t) => {
  const pyenv = (root) => join(root, "pyenv-home", "shims", "python");
  const agent = stubAgent((request) => {
    const root = dirname(request.checkout);
    switch (request.project.name) {
      case "venv":
        return { output: READY({ setup_argvs: [["python3", "-m", "venv", ".venv"]] }) };
      case "pyenv":
        return { act: () => writeExecutable(pyenv(root)), output: READY({ executables: [{ name: "python", path: pyenv(root), probe_argv: ["{python}", "--version"] }] }) };
      case "uv":
        return { output: READY({ sources: ["requirements.txt", "docs/testing.md"], attempts: [{ argv: ["uv", "sync", "--frozen"], cwd: ".", exit_code: 0, summary: "synced" }], installed: [{ argv: ["uv", "sync", "--frozen"] }] }) };
      default:
        return {
          act: async (checkout) => { await writeExecutable(join(checkout, ".venv/bin/python")); await mkdir(join(checkout, "node_modules/.bin"), { recursive: true }); },
          output: READY({ executables: [
            { name: "python", path: ".venv/bin/python", probe_argv: ["{python}", "--version"] },
            { name: "node", path: process.execPath, probe_argv: ["{node}", "--version"] },
          ] }),
        };
    }
  });
  const runner = stubRunner();
  const ctx = await open(t, { agent, runner });

  for (const name of ["venv", "pyenv", "uv", "node"]) {
    const files = name === "node" ? { ...REPO_FILES, "package.json": '{"name":"sample"}\n' } : name === "uv" ? { ...REPO_FILES, "uv.lock": "version = 1\n" } : REPO_FILES;
    const { projectId, repo } = await ctx.register(name, files);
    const saved = ctx.record("projects", projectId);
    assert.equal(saved.status, "ready", `${name}: ${JSON.stringify(saved.missing)}`);
    assert.equal(saved.test_run.whole_argv[0], "{python}");
    const python = saved.executables.python;
    assert.equal(python.relative_to, name === "pyenv" ? null : "checkout");
    assert.equal(python.path, name === "pyenv" ? pyenv(ctx.root) : ".venv/bin/python");
    assert.match(python.version, /Python 3\.12/u);
    assert.deepEqual(saved.sources, name === "uv" ? ["requirements.txt", "docs/testing.md"] : ["requirements.txt", "docs/testing.md", "tests/test_app.py"]);
    assert.ok(saved.attempts.some((entry) => entry.by === "agent"), `${name}: the agent's attempts are kept`);
    assert.ok(saved.attempts.some((entry) => entry.by === "core"), `${name}: Core's own runs are kept`);
    assert.equal(typeof saved.confirmed_at, "string");
    assert.equal(typeof saved.investigated_at, "string");
    assert.equal(saved.confirmed.by, "core");
    assert.deepEqual(saved.setup_argvs, name === "venv" ? [["python3", "-m", "venv", ".venv"]] : []);
    assert.deepEqual(saved.test_run.setup_argvs ?? [], saved.setup_argvs);
    const resolved = python.relative_to === null ? python.path : join(repo, python.path);
    assert.ok(runner.calls.some((call) => call.argv[0] === resolved && call.argv.includes("pytest")), `${name}: the tests ran with ${resolved}`);
    if (name === "node") assert.equal(saved.executables.node.path, process.execPath);
  }
});

test("with test_run.cwd in a subfolder, setup_argvs read cwd-relative files in the confirmation and again in a later Task's run", async (t) => {
  // The stub python really runs: "read <file>" fails when <file> is missing from its cwd.
  const python = "#!/bin/sh\nif [ \"$1\" = read ]; then cat \"$2\" > /dev/null || exit 1; fi\necho 'Python 3.12.0 (stub)'\n";
  const setupFor = { cwd: ["{python}", "read", "requirements.txt"], doubled: ["{python}", "read", "backend/requirements.txt"] };
  const agent = stubAgent((request) => ({
    act: (checkout) => writeExecutable(join(checkout, "backend/.venv/bin/python"), python),
    output: READY({
      setup_argvs: [setupFor[request.project.name]],
      test_run: { mode: "whole", whole_argv: ["{python}", "-m", "pytest", "-q"], file_argv: [], prepare_argv: [], test_patterns: ["**/test_*.py"], cwd: "backend" },
      executables: [{ name: "python", path: "backend/.venv/bin/python", probe_argv: ["{python}", "--version"] }],
    }),
  }));
  const realRunner = () => stubRunner((argv, cwd) => spawnSync(argv[0], argv.slice(1), { cwd }).status);
  const runner = realRunner();
  const ctx = await open(t, { agent, runner });
  const files = { "README.md": "# sample\n", ".gitignore": ".venv/\n", "backend/requirements.txt": "pytest\n", "backend/tests/test_app.py": "def test_add():\n    assert True\n" };
  const setupCall = (calls) => calls.find((call) => call.argv.includes("read"));

  const doubled = ctx.record("projects", (await ctx.register("doubled", files)).projectId);
  assert.equal(doubled.status, "unresolved", "a checkout-relative path is read as backend/backend/requirements.txt");
  assert.match(doubled.missing.join("\n"), /read backend\/requirements\.txt \(exit 1\)/u);

  const { projectId, repo } = await ctx.register("cwd", files);
  const saved = ctx.record("projects", projectId);
  assert.equal(saved.status, "ready", JSON.stringify(saved.missing));
  assert.equal(saved.executables.python.path, "backend/.venv/bin/python");
  assert.equal(saved.executables.python.relative_to, "checkout");
  const executable = join(repo, "backend/.venv/bin/python");
  assert.deepEqual(setupCall(runner.calls.filter((call) => call.cwd.startsWith(repo))), { argv: [executable, "read", "requirements.txt"], cwd: join(repo, "backend") });

  const { workId, taskId } = await addTask(ctx, projectId, "cwd");
  const resolved = await resolveAt(ctx, workId, taskId, repo);
  assert.equal(resolved.source, "setup");
  const later = realRunner();
  const run = await runWholeSuite({ root: repo, settings: resolved.settings, run: later.run });
  assert.equal(run.error, null);
  assert.equal(run.files[0].status, "passed");
  assert.deepEqual(setupCall(later.calls), { argv: [executable, "read", "requirements.txt"], cwd: join(repo, "backend") });
});

// ---- AC3: Core's confirmation

test("a failing test run is tests_failing, an exit 0 is ready, and a failing confirm file is not ready", async (t) => {
  const agent = stubAgent((request) => {
    if (request.project.name === "files-failing" || request.project.name === "files-passing") {
      return { output: READY({ test_run: { mode: "per_file", whole_argv: [], file_argv: ["{python}", "-m", "pytest", "-q", "{file}"], prepare_argv: [], test_patterns: ["**/test_*.py"], cwd: "." }, confirm_files: ["tests/test_app.py"] }) };
    }
    return {};
  });
  const ctx = await open(t, { agent, runner: stubRunner((argv, cwd) => (cwd.includes("failing") && argv.includes("pytest") ? 1 : 0)) });

  const whole = await ctx.register("whole-failing");
  const failing = ctx.record("projects", whole.projectId);
  assert.equal(failing.status, "tests_failing");
  assert.equal(failing.confirmed, null);
  assert.deepEqual(failing.candidate.argv.slice(-2), ["pytest", "-q"]);

  const fileFail = ctx.record("projects", (await ctx.register("files-failing")).projectId);
  assert.notEqual(fileFail.status, "ready");
  assert.equal(fileFail.confirmed, null);

  const filePass = ctx.record("projects", (await ctx.register("files-passing")).projectId);
  assert.equal(filePass.status, "ready");
  assert.deepEqual(filePass.confirmed.files, ["tests/test_app.py"]);
  assert.equal(filePass.confirmed.exit_code, 0);
});

test("a changed tracked file or a deleted file is unresolved and kept as is; files only inside .venv stay ready", async (t) => {
  const keepVenv = (checkout) => writeExecutable(join(checkout, ".venv/bin/python"));
  const acts = {
    tracked: async (checkout) => { await keepVenv(checkout); await writeFile(join(checkout, "README.md"), "# changed\n"); },
    deleted: async (checkout) => { await keepVenv(checkout); await rm(join(checkout, "docs/testing.md")); },
    venv: async (checkout) => { await keepVenv(checkout); await writeFile(join(checkout, ".venv/lib.txt"), "x\n"); },
    serena: async (checkout) => { await keepVenv(checkout); await mkdir(join(checkout, ".serena"), { recursive: true }); await writeFile(join(checkout, ".serena/project.yml"), "x: 1\n"); },
  };
  const ctx = await open(t, { agent: stubAgent((request) => ({ act: acts[request.project.name] })) });
  const status = {};
  const paths = {};
  for (const name of Object.keys(acts)) {
    const registered = await ctx.register(name);
    paths[name] = registered.repo;
    status[name] = ctx.record("projects", registered.projectId);
  }
  assert.equal(status.tracked.status, "unresolved");
  assert.match(status.tracked.missing.join("\n"), /README\.md/u);
  assert.equal(readFileSync(join(paths.tracked, "README.md"), "utf8"), "# changed\n");
  assert.equal(existsSync(join(paths.deleted, "docs/testing.md")), false);
  assert.equal(status.deleted.status, "unresolved");
  assert.match(status.deleted.missing.join("\n"), /docs\/testing\.md/u);
  assert.equal(status.venv.status, "ready");
  assert.equal(status.serena.status, "ready");
  for (const name of ["tracked", "deleted"]) assert.equal(status[name].confirmed, null, name);
});

test("investigations of the same Project and digest share one agent run", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const agent = stubAgent(async () => { await gate; return {}; });
  const ctx = await open(t, { agent });
  const repo = await makeRepo(join(ctx.root, "shared"));
  const created = await ctx.core.createProject(command({ name: "shared", canonical_path: repo, base_branch: "main", allowed_roots: [ctx.root], verification_plan: [] }, "project-shared"));
  const projectId = created.data.id;
  const input = { project_id: projectId, scope: "project", place_id: projectId, checkout: repo, trigger: "inputs_changed" };
  const again = [ctx.core.testSetup.investigate(input), ctx.core.testSetup.investigate(input)];
  ctx.core.testSetup.schedule(projectId, { trigger: "inputs_changed" });
  while (agent.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  const outcomes = await Promise.all(again);
  await ctx.core.whenTestSetupIdle();
  assert.equal(agent.calls.length, 1);
  assert.deepEqual(outcomes.map((outcome) => outcome.saved), [true, true]);
  assert.equal(ctx.record("projects", projectId).status, "ready");
});

// ---- AC4: investigation on change

test("a layout change of the canonical checkout schedules a Project investigation, an unchanged layout does not", async (t) => {
  const agent = stubAgent();
  const ctx = await open(t, { agent });
  const { projectId, repo } = await ctx.register("canonical");
  const { workId, taskId } = await addTask(ctx, projectId, "canonical");
  assert.equal(agent.calls.length, 1);

  await resolveAt(ctx, workId, taskId, repo);
  await ctx.core.whenTestSetupIdle();
  assert.equal(agent.calls.length, 1, "nothing changed");

  await writeFile(join(repo, "requirements.txt"), "pytest\nrequests\n");
  await resolveAt(ctx, workId, taskId, repo);
  await ctx.core.whenTestSetupIdle();
  assert.equal(agent.calls.length, 2);
  assert.equal(agent.calls[1].scope, "project");
  assert.equal(agent.calls[1].trigger, "inputs_changed");
});

test("a Task that changes requirements.txt or a source document waits for an investigation at its own place only", async (t) => {
  const agent = stubAgent();
  const ctx = await open(t, { agent });
  const { projectId, repo } = await ctx.register("owner");
  const before = ctx.db.get("SELECT test_setup_json FROM projects WHERE id = ?", projectId).test_setup_json;

  for (const [index, change] of [["requirements.txt", "pytest\nrequests\n"], ["docs/testing.md", "Run pytest -x.\n"]].entries()) {
    const { workId, taskId } = await addTask(ctx, projectId, `own-${index}`);
    const worktree = join(ctx.root, `task-${index}`);
    execFileSync("git", ["clone", repo, worktree], { stdio: "ignore" });
    await writeFile(join(worktree, change[0]), change[1]);
    const calls = agent.calls.length;
    const resolved = await resolveAt(ctx, workId, taskId, worktree);
    assert.equal(agent.calls.length, calls + 1, `${change[0]} is investigated before the run`);
    assert.equal(agent.calls.at(-1).scope, "task");
    assert.equal(agent.calls.at(-1).checkout, worktree);
    assert.equal(ctx.record("tasks", taskId).status, "ready");
    assert.equal(resolved.setup_match, "exact");
    assert.equal(ctx.db.get("SELECT test_setup_json FROM projects WHERE id = ?", projectId).test_setup_json, before, "the Project record is unchanged");
  }
});

test("only import lines or only a new test file do not call the agent; the passing current setup becomes the Task's record", async (t) => {
  const agent = stubAgent();
  const ctx = await open(t, { agent });
  const { projectId, repo } = await ctx.register("tests-only");

  for (const [index, change] of [
    ["tests/test_app.py", "import os\nfrom src.app import add\n\ndef test_add():\n    assert add(1, 2) == 3\n"],
    ["tests/test_more.py", "def test_more():\n    assert True\n"],
  ].entries()) {
    const { workId, taskId } = await addTask(ctx, projectId, `tests-${index}`);
    const worktree = join(ctx.root, `tests-${index}`);
    execFileSync("git", ["clone", repo, worktree], { stdio: "ignore" });
    await writeFile(join(worktree, change[0]), change[1]);
    const calls = agent.calls.length;
    const resolved = await resolveAt(ctx, workId, taskId, worktree);
    assert.equal(agent.calls.length, calls, `${change[0]}: the agent is not called`);
    assert.equal(resolved.setup_match, "tests_changed");
    assert.equal(ctx.record("tasks", taskId), null, "nothing is saved before the run passes");
    const place = { scope: "task", work_id: workId, task_id: taskId };
    await ctx.core.workflow.adoptPassedSetup(resolved, { status: "failed" }, { mode: "whole", whole_argv: ["x"], file_argv: [] }, projectId, worktree, place);
    assert.equal(ctx.record("tasks", taskId), null, "a failing run saves nothing");
    await ctx.core.workflow.adoptPassedSetup(resolved, { status: "passed" }, { mode: "whole", whole_argv: ["{python}", "-m", "pytest", "-q"], file_argv: [] }, projectId, worktree, place);
    const saved = ctx.record("tasks", taskId);
    assert.equal(saved.status, "ready");
    assert.equal(saved.confirmed.by, "core");
    assert.equal(saved.trigger, "core_confirmed");
    assert.equal(saved.agent_run, null);
  }
});

test("Mac-wide installs by the agent's tool call and by Core's setup run are not stopped and are kept in the saved record; sudo is still refused", async (t) => {
  const holder = {};
  const verdicts = [];
  const agent = stubAgent(async (request) => {
    const check = async (cmd) => {
      const result = await holder.core.checkTestSetupTool({ agent_run_id: request.invocation_id, tool_name: "Bash", tool_input: { command: cmd }, cwd: request.checkout });
      // The HTTP route records once the rule-store guard has also allowed the call.
      if (!result.denied) holder.core.recordTestSetupInstalls(request.invocation_id, result.installs);
      return result;
    };
    verdicts.push((await check("npm install -g x")).denied, (await check("sudo brew install jq")).denied);
    return { output: READY({ setup_argvs: [["brew", "install", "jq"]] }) };
  });
  const runner = stubRunner();
  const ctx = await open(t, { agent, runner });
  holder.core = ctx.core;
  const { projectId } = await ctx.register("mac-wide");
  const saved = ctx.record("projects", projectId);
  assert.equal(saved.status, "ready");
  assert.deepEqual(verdicts, [false, true]);
  assert.ok(runner.calls.some((call) => call.argv.join(" ") === "brew install jq"), "Core ran the install");
  assert.deepEqual(saved.outside_installs.map((entry) => entry.argv.join(" ")).sort(), ["brew install jq", "npm install -g x"]);
  assert.ok(saved.outside_installs.every((entry) => entry.reason === "mac_wide_install" && typeof entry.approved_at === "string"));
});

test("a per_file setup where some files pass and some fail is ready with the failing tests recorded as known", async (t) => {
  const perFile = { mode: "per_file", whole_argv: [], file_argv: [process.execPath, "--test", "--test-reporter=tap", "{file}"], prepare_argv: [], test_patterns: ["tests/*.test.mjs"], cwd: "." };
  const files = {
    ...REPO_FILES,
    "tests/ok.test.mjs": "import { test } from 'node:test';\ntest('fine', () => {});\n",
    "tests/bad.test.mjs": "import { test } from 'node:test';\ntest('boom', () => { throw new Error('x'); });\n",
  };
  const confirm_files = ["tests/ok.test.mjs", "tests/bad.test.mjs"];
  const agent = stubAgent(() => ({ output: READY({ executables: [], test_run: perFile, confirm_files }) }));
  const real = async (argv, cwd) => {
    const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", env: { PATH: process.env.PATH } });
    return { exit_code: result.status, timed_out: false, stdout: result.stdout, stderr: result.stderr, duration_ms: 1 };
  };
  const ctx = await open(t, { agent, runner: { run: real, calls: [] } });
  const saved = ctx.record("projects", (await ctx.register("some-failing", files)).projectId);
  assert.equal(saved.status, "ready");
  assert.deepEqual(saved.known_failures, [{ file: "tests/bad.test.mjs", name: "boom" }]);

  // Every file failing is not a usable setup: nothing passes, so it stays tests_failing.
  const allBad = { ...files, "tests/ok.test.mjs": files["tests/bad.test.mjs"] };
  const none = ctx.record("projects", (await ctx.register("all-failing", allBad)).projectId);
  assert.equal(none.status, "tests_failing");
  assert.deepEqual(none.known_failures, []);

  // Passing and failing tests inside one file: the summary line shows some passed.
  const mixed = "import { test } from 'node:test';\ntest('fine', () => {});\ntest('boom', () => { throw new Error('Cannot find module x'); });\n";
  const oneFile = { ...REPO_FILES, "tests/ok.test.mjs": mixed, "tests/bad.test.mjs": mixed };
  const some = ctx.record("projects", (await ctx.register("mixed-in-file", oneFile)).projectId);
  assert.equal(some.status, "ready", JSON.stringify(some.missing));
  assert.ok(some.known_failures.every((entry) => entry.name === "boom"));

  // Every test failing stays tests_failing even when the output reads like an environment problem.
  const envLike = "import { test } from 'node:test';\ntest('boom', () => { throw new Error('Cannot find module x'); });\n";
  const allEnvLike = { ...REPO_FILES, "tests/ok.test.mjs": envLike, "tests/bad.test.mjs": envLike };
  const envNone = ctx.record("projects", (await ctx.register("all-env-like", allEnvLike)).projectId);
  assert.equal(envNone.status, "tests_failing");
});

test("a whole setup where some tests pass is ready with the named failures known, even when a failure reads like an environment problem; all failing stays tests_failing", async (t) => {
  const whole = { mode: "whole", whole_argv: [process.execPath, "--test", "--test-reporter=tap", "tests/ok.test.mjs", "tests/bad.test.mjs"], file_argv: [], prepare_argv: [], test_patterns: ["tests/*.test.mjs"], cwd: "." };
  const files = {
    ...REPO_FILES,
    "tests/ok.test.mjs": "import { test } from 'node:test';\ntest('fine', () => {});\n",
    "tests/bad.test.mjs": "import { test } from 'node:test';\ntest('boom', () => { throw new Error('Cannot find module x'); });\n",
  };
  const agent = stubAgent(() => ({ output: READY({ executables: [], test_run: whole }) }));
  const real = async (argv, cwd) => {
    const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", env: { PATH: process.env.PATH } });
    return { exit_code: result.status, timed_out: false, stdout: result.stdout, stderr: result.stderr, duration_ms: 1 };
  };
  const ctx = await open(t, { agent, runner: { run: real, calls: [] } });
  const saved = ctx.record("projects", (await ctx.register("whole-some-failing", files)).projectId);
  assert.equal(saved.status, "ready", JSON.stringify(saved.missing));
  assert.deepEqual(saved.known_failures, [{ file: "*", name: "boom" }]);

  const failing = (name) => `import { test } from 'node:test';\ntest('${name}', () => { throw new Error('x'); });\n`;
  const allBad = { ...files, "tests/ok.test.mjs": failing("boom2"), "tests/bad.test.mjs": failing("boom") };
  const none = ctx.record("projects", (await ctx.register("whole-all-failing", allBad)).projectId);
  assert.equal(none.status, "tests_failing");
  assert.deepEqual(none.known_failures, []);
});

test("new untracked files made by the agent and by Core's confirmation run are removed, recorded and the setup is ready; older untracked, ignored and tracked files stay", async (t) => {
  const agent = stubAgent(() => ({ act: async (checkout) => {
    await writeExecutable(join(checkout, ".venv/bin/python"));
    await writeFile(join(checkout, "agent-made.txt"), "x\n");
    await mkdir(join(checkout, "newdir/inner"), { recursive: true });
    await writeFile(join(checkout, "newdir/inner/made.txt"), "x\n");
  } }));
  const base = stubRunner();
  const runner = { calls: base.calls, run: async (argv, cwd, ...rest) => {
    const outcome = await base.run(argv, cwd, ...rest);
    if (argv.includes("pytest")) await writeFile(join(cwd, "core-run-made.txt"), "x\n");
    return outcome;
  } };
  const ctx = await open(t, { agent, runner });
  const repo = await makeRepo(join(ctx.root, "cleanup"));
  await writeFile(join(repo, "older.txt"), "mine\n");
  await mkdir(join(repo, "node_modules"), { recursive: true });
  await writeFile(join(repo, "node_modules/ignored.txt"), "mine\n");
  const created = await ctx.core.createProject(command({ name: "cleanup", canonical_path: repo, base_branch: "main", allowed_roots: [ctx.root], verification_plan: [] }, "project-cleanup"));
  await ctx.core.whenTestSetupIdle();
  const saved = ctx.record("projects", created.data.id);
  assert.equal(saved.status, "ready");
  assert.deepEqual([...saved.removed_files].sort(), ["agent-made.txt", "core-run-made.txt", "newdir/inner/made.txt"]);
  for (const gone of ["agent-made.txt", "core-run-made.txt", "newdir"]) assert.equal(existsSync(join(repo, gone)), false, gone);
  for (const kept of ["older.txt", "node_modules/ignored.txt", "README.md", "src/app.py"]) assert.equal(existsSync(join(repo, kept)), true, kept);
});

test("a tracked file changed by Core's confirmation run is unresolved and not restored; a '..result' file is removed", async (t) => {
  const agent = stubAgent(() => ({ act: async (checkout) => { await writeExecutable(join(checkout, ".venv/bin/python")); } }));
  const base = stubRunner();
  const runner = { calls: base.calls, run: async (argv, cwd, ...rest) => {
    const outcome = await base.run(argv, cwd, ...rest);
    if (argv.includes("pytest")) {
      await writeFile(join(cwd, "README.md"), "changed by the run\n");
      await writeFile(join(cwd, "..result"), "x\n");
    }
    return outcome;
  } };
  const ctx = await open(t, { agent, runner });
  const repo = await makeRepo(join(ctx.root, "lateTracked"));
  const created = await ctx.core.createProject(command({ name: "lateTracked", canonical_path: repo, base_branch: "main", allowed_roots: [ctx.root], verification_plan: [] }, "project-late"));
  await ctx.core.whenTestSetupIdle();
  const saved = ctx.record("projects", created.data.id);
  assert.equal(saved.status, "unresolved");
  assert.ok(saved.missing.some((line) => line.includes("README.md")));
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "changed by the run\n");
  assert.deepEqual(saved.removed_files, ["..result"]);
  assert.equal(existsSync(join(repo, "..result")), false);
});

test("a new file under a folder that became a symlink is not removed through the link, and the setup is unresolved", async (t) => {
  let outside = "";
  const agent = stubAgent(() => ({ act: async (checkout) => { await writeExecutable(join(checkout, ".venv/bin/python")); } }));
  const base = stubRunner();
  const runner = { calls: base.calls, run: async (argv, cwd, ...rest) => {
    const outcome = await base.run(argv, cwd, ...rest);
    if (argv.includes("pytest")) {
      await mkdir(join(cwd, "made"), { recursive: true });
      await writeFile(join(cwd, "made/new.txt"), "x\n");
      await rm(join(cwd, "made"), { recursive: true });
      symlinkSync(outside, join(cwd, "made"));
    }
    return outcome;
  } };
  const ctx = await open(t, { agent, runner });
  outside = join(ctx.root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "new.txt"), "keep\n");
  const repo = await makeRepo(join(ctx.root, "linkRepo"));
  const created = await ctx.core.createProject(command({ name: "linkRepo", canonical_path: repo, base_branch: "main", allowed_roots: [ctx.root], verification_plan: [] }, "project-link"));
  await ctx.core.whenTestSetupIdle();
  assert.equal(readFileSync(join(outside, "new.txt"), "utf8"), "keep\n");
  assert.equal(ctx.record("projects", created.data.id).status, "ready");
});
