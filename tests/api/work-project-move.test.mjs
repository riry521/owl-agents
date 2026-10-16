import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { GuardTokenRegistry } from "../../apps/server/dist/guard-tokens.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { loadFixContext } from "../../packages/core/dist/task-context.js";
import { WorkDriver } from "../../packages/core/dist/work-driver.js";
import { createTestCore, command } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { waitFor } from "../helpers/wait.mjs";

async function setup(t, { agentRunner = {}, start = false } = {}) {
  const { root, db, core } = await createTestCore(t, { agentRunner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-work-project-move-", start });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const repo = join(root, "project-repo");
  await mkdir(repo);
  await writeFile(join(repo, "README.md"), "test\n");
  git(repo, "init", "--initial-branch=main");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "add", "README.md");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial");
  const project = (await core.createProject(command({
    name: "Move target", canonical_path: await realpath(repo), base_branch: "main", allowed_roots: [await realpath(repo)], verification_plan: [],
  }, `project:${randomUUID()}`))).data;
  const guardTokens = GuardTokenRegistry.open(join(root, "guard-tokens"));
  t.after(() => guardTokens.clear());
  const httpCore = new ExternalCoreAdapter(core, db, root, dataDir);
  const token = randomBytes(32).toString("hex");
  const server = await startTestHttpServer(t, { core: httpCore, db, webOut: root, owlRoot: root, dataDir, guardTokens }, { token });
  if (!server) {
    t.skip("localhost listen is not permitted in this environment");
    return null;
  }
  const request = async (path, body, method = "POST") => {
    const response = await server.request(method, `/api/v1${path}`, body);
    return { status: response.status, body: await response.json() };
  };
  return { root, db, core, httpCore, project, request, server, token };
}

async function createWork(core, projectId, key) {
  return (await core.createWork(command({ title: key, summary: "", size: "small", project_id: projectId }, key))).data.work_id;
}

function moveCommand(projectId, key, expectedVersion = 0) {
  return { request_id: createUlid(), idempotency_key: key, expected_version: expectedVersion, payload: { project_id: projectId } };
}

test("WorkDriver.exclusive waits for its tick and holds the Work until the operation completes", async () => {
  let releaseTick;
  let releaseOperation;
  const tickStarted = new Promise((resolve) => {
    releaseTick = resolve;
  });
  const operationStarted = new Promise((resolve) => {
    releaseOperation = resolve;
  });
  let finishTick;
  let finishOperation;
  let tickCalls = 0;
  let operationActive = false;
  const tick = new Promise((resolve) => {
    finishTick = resolve;
  });
  const operation = new Promise((resolve) => {
    finishOperation = resolve;
  });
  const driver = new WorkDriver({
    tick: async () => {
      tickCalls += 1;
      releaseTick();
      await tick;
    },
    getState: () => "running",
    onTickError: async () => {},
  });
  driver.start(["work"]);
  driver.wake("work");
  await tickStarted;
  const exclusive = driver.exclusive("work", async () => {
    operationActive = true;
    releaseOperation();
    await operation;
    operationActive = false;
    return "moved";
  });
  finishTick();
  await operationStarted;
  driver.wake("work");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tickCalls, 1);
  assert.equal(operationActive, true);
  finishOperation();
  assert.equal(await exclusive, "moved");
  await driver.stop();
});

test("HTTP moves Project-less Works, reallocates the number, preserves state/version and replays idempotently", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const attachedWorkId = await createWork(api.core, api.project.id, "occupy-number");
  const alreadyAttached = await api.request(`/works/${attachedWorkId}/project`, moveCommand(api.project.id, "already-attached"));
  assert.equal(alreadyAttached.status, 409);
  assert.equal(alreadyAttached.body.error.code, "work_project_already_set");
  for (const [index, state] of ["memo", "ready", "paused", "judgement_waiting"].entries()) {
    const workId = await createWork(api.core, null, `move-${state}-${index}`);
    await api.db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = ?, state_version = 7 WHERE id = ?", state, workId));
    const input = moveCommand(api.project.id, `move-key-${state}` , 7);
    const first = await api.request(`/works/${workId}/project`, input);
    const replay = await api.request(`/works/${workId}/project`, input);
    assert.equal(first.status, 200, state);
    assert.deepEqual(replay.body, first.body, state);
    assert.equal(first.body.data.project_id, api.project.id);
    assert.equal(first.body.data.display_number, index === 0 ? 2 : index + 2);
    assert.equal(first.body.data.state, state);
    assert.equal(first.body.version, 7);
    const row = api.db.get("SELECT project_id, display_number, state, state_version FROM works WHERE id = ?", workId);
    assert.deepEqual(row, { project_id: api.project.id, display_number: first.body.data.display_number, state, state_version: 7 });
    assert.equal(api.db.get("SELECT COUNT(*) AS count FROM events WHERE work_id = ? AND type = 'work.project_attached'", workId).count, 1);
    await assert.rejects(api.core.moveWorkToProject(workId, command({ project_id: createUlid() }, input.idempotency_key, 7)), { code: "idempotency_conflict" });
  }
});

test("HTTP move requires Owner auth and validates the project payload", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const workId = await createWork(api.core, null, "validation-work");
  const deniedResponse = await fetch(`${api.server.baseUrl}/api/v1/works/${workId}/project`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(moveCommand(api.project.id, "denied")) });
  const denied = { status: deniedResponse.status, body: await deniedResponse.json() };
  assert.equal(denied.status, 401);
  const invalid = await api.request(`/works/${workId}/project`, { ...moveCommand(api.project.id, "invalid"), payload: { project_id: "not-a-ulid" } });
  assert.equal(invalid.status, 400);
  const stale = await api.request(`/works/${workId}/project`, { ...moveCommand(api.project.id, "stale-version"), expected_version: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "version_conflict");
  assert.equal(api.db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, null);
});

test("an ExternalCoreAdapter without move support returns dependency_unavailable", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const workId = await createWork(api.core, null, "unsupported-core");
  api.httpCore.core = new Proxy(api.core, { get(target, property, receiver) { return property === "moveWorkToProject" ? undefined : Reflect.get(target, property, receiver); } });
  const result = await api.request(`/works/${workId}/project`, moveCommand(api.project.id, "unsupported-key"));
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "dependency_unavailable");
  assert.equal(api.db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, null);
});

test("HTTP wraps the raw Core fallback when an adapter omits its move method", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const workId = await createWork(api.core, null, "raw-core-fallback");
  Object.defineProperty(api.httpCore, "moveWorkToProject", { configurable: true, value: undefined });
  const stale = await api.request(`/works/${workId}/project`, { ...moveCommand(api.project.id, "raw-core-stale-key"), expected_version: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "version_conflict");
  assert.equal(api.db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, null);
  const result = await api.request(`/works/${workId}/project`, moveCommand(api.project.id, "raw-core-fallback-key"));
  assert.equal(result.status, 200);
  assert.equal(result.body.data.project_id, api.project.id);
  assert.equal(api.db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, api.project.id);
  const again = await api.request(`/works/${workId}/project`, moveCommand(api.project.id, "raw-core-again-key", result.body.version));
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "work_project_already_set");
  const otherWork = await createWork(api.core, null, "raw-core-unsupported");
  api.httpCore.core = new Proxy(api.core, { get(target, property, receiver) { return property === "moveWorkToProject" ? undefined : Reflect.get(target, property, receiver); } });
  const unsupported = await api.request(`/works/${otherWork}/project`, moveCommand(api.project.id, "raw-core-unsupported-key"));
  assert.equal(unsupported.status, 503);
  assert.equal(unsupported.body.error.code, "dependency_unavailable");
  assert.equal(api.db.get("SELECT project_id FROM works WHERE id = ?", otherWork).project_id, null);
});

test("move rejects terminal states, active Agents and isolated fix work without changing membership or workspace", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const now = new Date().toISOString();
  for (const state of ["running", "completed", "cancelled"]) {
    const workId = await createWork(api.core, null, `reject-${state}`);
    await api.db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = ? WHERE id = ?", state, workId));
    await assert.rejects(api.core.moveWorkToProject(workId, command({ project_id: api.project.id }, `reject-key-${state}`)), { code: "invalid_state_transition" });
    assert.equal(api.db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, null);
  }
  const activeWork = await createWork(api.core, null, "active-agent");
  const activeRun = createUlid();
  await api.db.createWriteLane().transact((tx) => {
    tx.run("UPDATE works SET state = 'paused' WHERE id = ?", activeWork);
    tx.run(`INSERT INTO agent_runs (id, work_id, role, provider, model, status, created_at, updated_at) VALUES (?, ?, 'worker', 'test', 'test', 'running', ?, ?)`, activeRun, activeWork, now, now);
  });
  await assert.rejects(api.core.moveWorkToProject(activeWork, command({ project_id: api.project.id }, "active-agent-key")), { code: "work_has_active_agents" });
  assert.equal(api.db.get("SELECT project_id FROM works WHERE id = ?", activeWork).project_id, null);
  const fixWork = await createWork(api.core, null, "fix-pending");
  const taskId = createUlid();
  const taskPath = api.core.workspaceLayout.taskPath(fixWork, taskId);
  await mkdir(taskPath, { recursive: true });
  await api.db.createWriteLane().transact((tx) => {
    tx.run("UPDATE works SET state = 'paused' WHERE id = ?", fixWork);
    tx.run(`INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, worktree_path, paused_from, created_at, updated_at)
      VALUES (?, ?, 'fix', 'code', 'paused', 'normal', '', '', ?, 'review_fix_waiting', ?, ?)`, taskId, fixWork, taskPath, now, now);
  });
  await writeFile(join(taskPath, "keep.txt"), "work in progress");
  await assert.rejects(api.core.moveWorkToProject(fixWork, command({ project_id: api.project.id }, "fix-pending-key")), (error) => error.code === "invalid_state_transition" && error.details.reason === "task_fix_pending");
  assert.equal(api.db.get("SELECT project_id FROM works WHERE id = ?", fixWork).project_id, null);
  assert.equal(api.db.get("SELECT 1 FROM tasks WHERE id = ?", taskId) !== undefined, true);
  assert.equal(await (await import("node:fs/promises")).readFile(join(taskPath, "keep.txt"), "utf8"), "work in progress");

  const failedVerificationWork = await createWork(api.core, null, "failed-verification-fix-pending");
  const failedVerificationTask = createUlid();
  const failedVerificationPath = api.core.workspaceLayout.taskPath(failedVerificationWork, failedVerificationTask);
  await mkdir(failedVerificationPath, { recursive: true });
  await writeFile(join(failedVerificationPath, "keep.txt"), "verification fix in progress");
  await api.db.createWriteLane().transact((tx) => {
    tx.run("UPDATE works SET state = 'paused' WHERE id = ?", failedVerificationWork);
    tx.run(`INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, worktree_path, created_at, updated_at)
      VALUES (?, ?, 'verification fix', 'code', 'ready', 'normal', '', '', ?, ?, ?)`, failedVerificationTask, failedVerificationWork, failedVerificationPath, now, now);
    const sequence = tx.get("SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM events").n;
    tx.run(`INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, payload_json, status, attempt_no, created_at)
      VALUES (?, ?, ?, 'verification.completed', ?, ?, ?, 'handled', 0, ?)`, createUlid(), sequence, `failed-verification:${failedVerificationTask}`, failedVerificationWork, failedVerificationTask, JSON.stringify({ outcome: "fail", verification: { source: "core", commands: [], error: "verification failed" } }), now);
  });
  assert.notEqual(loadFixContext(api.db, failedVerificationTask), null);
  await assert.rejects(api.core.moveWorkToProject(failedVerificationWork, command({ project_id: api.project.id }, "failed-verification-fix-pending-key")), (error) => error.code === "invalid_state_transition" && error.details.reason === "task_fix_pending");
  assert.equal(api.db.get("SELECT project_id FROM works WHERE id = ?", failedVerificationWork).project_id, null);
  assert.equal(await (await import("node:fs/promises")).readFile(join(failedVerificationPath, "keep.txt"), "utf8"), "verification fix in progress");
});

test("a failed isolated-workspace save leaves membership and source files intact", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const workId = await createWork(api.core, null, "save-failure");
  const workspace = api.core.workspaceLayout.workDir(workId);
  const outside = join(api.root, "outside-workspace");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "original");
  const { symlink } = await import("node:fs/promises");
  await mkdir(join(workspace, ".."), { recursive: true });
  await symlink(outside, workspace);
  await assert.rejects(api.core.moveWorkToProject(workId, command({ project_id: api.project.id }, "save-failure-key")), { code: "worktree_cleanup_failed" });
  assert.equal(api.db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, null);
  assert.equal(await (await import("node:fs/promises")).readFile(join(outside, "keep.txt"), "utf8"), "original");
});

test("successful move saves and removes the old isolated workspace", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const workId = await createWork(api.core, null, "save-success");
  const workspace = api.core.workspaceLayout.workDir(workId);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "keep.txt"), "saved output");
  await api.core.moveWorkToProject(workId, command({ project_id: api.project.id }, "save-success-key"));
  const { access, readFile } = await import("node:fs/promises");
  await assert.rejects(access(workspace));
  assert.equal(await readFile(join(api.root, "data", "outputs", workId, "keep.txt"), "utf8"), "saved output");
});

test("a Task started after moving runs inside the target Project worktree", async (t) => {
  let worktreeRoot;
  let commonGitDir;
  const runner = {
    runManagerPlan: async (request) => (request.mode ?? request.context?.mode) === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{ id: "T1", title: "Check worktree", type: "code", acceptance: "Run in the target Project.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false }] } }
      : { outcome: "failed" },
    runWorker: async (request) => {
      worktreeRoot = git(request.context.worktree, "rev-parse", "--show-toplevel");
      commonGitDir = git(request.context.worktree, "rev-parse", "--git-common-dir");
      return { outcome: "failed" };
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const api = await setup(t, { agentRunner: runner, start: true });
  if (!api) return;
  const workId = await createWork(api.core, null, "launch-after-move");
  await api.core.moveWorkToProject(workId, command({ project_id: api.project.id }, "launch-move"));
  assert.equal(api.db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, api.project.id);
  await api.core.startWork(workId, { ...command({ mode: "normal" }, "launch-work"), expected_version: 0 });
  assert.equal(await waitFor(() => worktreeRoot !== undefined && commonGitDir !== undefined, { timeoutMs: 15_000 }), true);
  assert.equal(await realpath(worktreeRoot), await realpath(api.core.workspaceLayout.taskPath(workId, api.db.get("SELECT id FROM tasks WHERE work_id = ?", workId).id)));
  assert.equal(await realpath(commonGitDir), await realpath(join(api.root, "project-repo", ".git")));
});
