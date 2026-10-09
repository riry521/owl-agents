import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter, MemoryCore } from "../../apps/server/dist/core.js";
import { GuardTokenRegistry } from "../../apps/server/dist/guard-tokens.js";
import { createUlid, openDatabase } from "../../packages/db/dist/index.js";
import { createTestCore, command as coreCommand } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { migrationsDir } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

const command = (payload, suffix = randomUUID(), expectedVersion = 0) => coreCommand(payload, `api-project-edit-delete:${suffix}`, expectedVersion);

async function setup(t, { memory = false, legacyAdapter = false, coreOptions = {} } = {}) {
  const { root, db, core: durableCore } = await createTestCore(t, {
    version: "api-project-edit-delete-test",
    dispatcher: { tick_interval_ms: 25 },
    ...coreOptions,
  }, { prefix: "owl-api-project-edit-delete-" });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  let targetCore = durableCore;
  if (legacyAdapter) {
    targetCore = new Proxy(durableCore, {
      get(target, property) {
        if (["updateProject", "getProjectDeletionImpact", "deleteProject"].includes(property)) return undefined;
        return Reflect.get(target, property, target);
      },
    });
  }
  const httpCore = memory ? new MemoryCore({ version: "api-project-edit-delete-memory" }) : new ExternalCoreAdapter(targetCore, db, root, dataDir);
  const token = randomBytes(32).toString("hex");
  const guardTokens = GuardTokenRegistry.open(join(root, "guard-tokens"));
  t.after(() => guardTokens.clear());
  const server = await startTestHttpServer(t, { core: httpCore, db, webOut: root, owlRoot: root, dataDir, guardTokens }, { token });
  if (!server) {
    t.skip("localhost listen is not permitted in this environment");
    return null;
  }
  const request = (path, { method = "GET", body } = {}) => server.request(method, `/api/v1${path}`, body);
  const advisorToken = async () => (await readFile(guardTokens.issue({ agent_run_id: "advisor-1", role: "advisor" }).file, "utf8")).trim();
  return { root, dataDir, db, durableCore, httpCore, request, server, advisorToken };
}

function testGit(t, cwd, ...args) {
  try {
    return git(cwd, ...args);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("git execution is not permitted in this environment");
      return null;
    }
    throw error;
  }
}

async function makeRepo(t, parent, name, branch = "main") {
  const path = join(parent, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "README.md"), "project files remain\n");
  if (testGit(t, path, "init", `--initial-branch=${branch}`) === null) return null;
  if (testGit(t, path, "add", "README.md") === null) return null;
  if (testGit(t, path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial") === null) return null;
  return path;
}

async function createProject(api, suffix, { name = `Project ${suffix}`, path, branch = "main" } = {}) {
  const canonicalPath = await realpath(path);
  return (await api.durableCore.createProject(command({
    name,
    canonical_path: canonicalPath,
    base_branch: branch,
    allowed_roots: [canonicalPath],
    verification_plan: [],
  }, `create-project:${suffix}`))).data;
}

async function createMemoryProject(api, suffix, path) {
  const canonicalPath = await realpath(path);
  return (await api.httpCore.createProject({
    name: `Project ${suffix}`,
    canonical_path: canonicalPath,
    base_branch: "main",
    allowed_roots: [canonicalPath],
    verification_plan: [],
  }, { request_id: randomUUID(), idempotency_key: `memory-project:${suffix}`, expected_version: 0 })).data;
}

async function createWork(api, title, projectId, state = "memo") {
  const workId = (await api.durableCore.createWork(command({
    title,
    summary: "",
    size: "small",
    project_id: projectId,
  }, `create-work:${randomUUID()}`))).data.work_id;
  if (state !== "memo") await setWorkState(api.db, workId, state);
  return workId;
}

async function setWorkState(db, workId, state) {
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => transaction.run(
    `UPDATE works
        SET state = ?, state_version = 1, updated_at = ?,
            completed_at = CASE WHEN ? = 'completed' THEN ? ELSE NULL END,
            cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE NULL END
      WHERE id = ?`,
    state, now, state, now, state, now, workId,
  ));
}

async function archiveWork(api, workId) {
  await api.durableCore.archiveWork(workId, command({}, `archive-work:${workId}`, 1));
}

async function insertAgentRun(db, workId, status = "running") {
  const taskId = createUlid();
  const runId = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, ?, 'Agent blocker task', 'code', 'ready', 'normal', '', '', ?, ?)`,
      taskId, workId, now, now,
    );
    transaction.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
       VALUES (?, ?, ?, 'worker', 'test', 'test-model', ?, ?, ?)`,
      runId, workId, taskId, status, now, now,
    );
  });
  return runId;
}

async function insertBacklogItem(db, projectId, workId) {
  const taskId = createUlid();
  const reviewId = createUlid();
  const itemId = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, ?, 'Backlog source task', 'code', 'completed', 'normal', '', '', ?, ?)`,
      taskId, workId, now, now,
    );
    transaction.run(
      `INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at)
       VALUES (?, ?, 0, 'pass', '[]', '{}', ?)`,
      reviewId, taskId, now,
    );
    transaction.run(
      `INSERT INTO backlog_items
         (id, work_id, task_id, project_id, review_id, review_round, file, line, problem, reason, suggestion, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 'src/example.ts', 1, 'Example issue', '', '', ?, ?, ?)`,
      itemId, workId, taskId, projectId, reviewId, `backlog:${itemId}`, now, now,
    );
  });
  return itemId;
}

function envelope(payload, key, expectedVersion = 0) {
  return { request_id: randomUUID(), idempotency_key: key, expected_version: expectedVersion, payload };
}

function sendCommand(api, method, path, payload, key = randomUUID(), expectedVersion = 0) {
  return api.request(path, { method, body: envelope(payload, `project-command:${key}`, expectedVersion) });
}

async function assertApiError(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error.code, code);
  return body;
}

async function listProjects(api) {
  const response = await api.request("/projects");
  assert.equal(response.status, 200);
  return (await response.json()).data;
}

function projectRow(api, projectId) {
  return api.db.get("SELECT id, name, canonical_path, base_branch, allowed_roots_json, updated_at FROM projects WHERE id = ?", projectId);
}

test("PATCH name trims the value, preserves path fields, and appears in GET /projects with running work", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const repo = await makeRepo(t, api.root, "name-project");
  if (!repo) return;
  const project = await createProject(api, "name", { path: repo });
  const workId = await createWork(api, "Name update running work", project.id, "running");
  const before = projectRow(api, project.id);

  const response = await sendCommand(api, "PATCH", `/projects/${project.id}`, { name: "  Renamed Project  " }, "patch-name");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { ...project, name: "Renamed Project" });
  const listed = (await listProjects(api)).find((item) => item.id === project.id);
  assert.equal(listed.name, "Renamed Project");
  assert.equal(listed.canonical_path, before.canonical_path);
  assert.equal(listed.base_branch, before.base_branch);
  assert.equal(api.db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, project.id);
});

test("PATCH changes to a new Git repository and adopts its canonical path and branch", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const originalRepo = await makeRepo(t, api.root, "old-project");
  const newRepo = await makeRepo(t, api.root, "new-project", "develop");
  if (!originalRepo || !newRepo) return;
  const project = await createProject(api, "path", { path: originalRepo });

  const response = await sendCommand(api, "PATCH", `/projects/${project.id}`, { canonical_path: newRepo }, "patch-path");
  assert.equal(response.status, 200);
  const updated = (await response.json()).data;
  assert.equal(updated.canonical_path, await realpath(newRepo));
  assert.equal(updated.base_branch, "develop");
  assert.deepEqual(updated.allowed_roots, [await realpath(newRepo)]);
  const listed = (await listProjects(api)).find((item) => item.id === project.id);
  assert.equal(listed.canonical_path, await realpath(newRepo));
});

test("PATCH of the same Git top-level path is a no-op even with running work", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const repo = await makeRepo(t, api.root, "same-path-project");
  if (!repo) return;
  const project = await createProject(api, "same-path", { path: repo });
  await createWork(api, "Same path running work", project.id, "running");
  const before = projectRow(api, project.id);
  const subdirectory = join(repo, "subfolder");
  await mkdir(subdirectory);

  const response = await sendCommand(api, "PATCH", `/projects/${project.id}`, { canonical_path: subdirectory }, "patch-same-path");
  assert.equal(response.status, 200);
  const updated = (await response.json()).data;
  assert.equal(updated.canonical_path, before.canonical_path);
  assert.equal(updated.base_branch, before.base_branch);
  assert.equal(api.db.get("SELECT updated_at FROM projects WHERE id = ?", project.id).updated_at, before.updated_at);
});

test("PATCH rejects another registered Project path and identifies the conflicting Project", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const firstRepo = await makeRepo(t, api.root, "conflict-source");
  const otherRepo = await makeRepo(t, api.root, "conflict-target");
  if (!firstRepo || !otherRepo) return;
  const first = await createProject(api, "conflict-source", { path: firstRepo });
  const other = await createProject(api, "conflict-target", { path: otherRepo });
  const before = projectRow(api, first.id);

  const error = await assertApiError(await sendCommand(api, "PATCH", `/projects/${first.id}`, { canonical_path: otherRepo }, "patch-conflict"), 400, "validation_error");
  assert.equal(error.error.details.canonical_path, await realpath(otherRepo));
  assert.equal(error.error.details.project_id, other.id);
  assert.deepEqual(projectRow(api, first.id), before);
});

test("PATCH validates payloads, missing paths, non-directories, non-Git paths, and unknown ids without DB changes", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const repo = await makeRepo(t, api.root, "validation-project");
  if (!repo) return;
  const project = await createProject(api, "validation", { path: repo });
  const before = projectRow(api, project.id);
  const missing = join(api.root, "missing-directory");
  const file = join(api.root, "not-a-directory");
  const nonGit = join(api.root, "not-a-git-repository");
  await writeFile(file, "file\n");
  await mkdir(nonGit);

  for (const [payload, status, code] of [
    [{}, 400, "validation_error"],
    [{ name: "Valid", extra: true }, 400, "validation_error"],
    [{ name: "x".repeat(201) }, 400, "validation_error"],
    [{ canonical_path: missing }, 400, "validation_error"],
    [{ canonical_path: file }, 400, "validation_error"],
    [{ canonical_path: nonGit }, 400, "validation_error"],
  ]) {
    const error = await assertApiError(await sendCommand(api, "PATCH", `/projects/${project.id}`, payload, `patch-invalid:${randomUUID()}`), status, code);
    if (payload.canonical_path === nonGit) assert.equal(error.error.details.inspection.kind, "not_git");
    assert.deepEqual(projectRow(api, project.id), before);
  }
  await assertApiError(await sendCommand(api, "PATCH", `/projects/${createUlid()}`, { name: "Missing" }, "patch-unknown"), 404, "project_not_found");
  await assertApiError(await sendCommand(api, "PATCH", "/projects/not-a-ulid", { name: "Invalid id" }, "patch-bad-id"), 400, "validation_error");
  assert.deepEqual(projectRow(api, project.id), before);
});

test("PATCH path changes are blocked by locking Works or active Agents, while allowed states pass", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const targetRepo = await makeRepo(t, api.root, "unlocked-target");
  if (!targetRepo) return;
  for (const state of ["running", "paused", "judgement_waiting"]) {
    const repo = await makeRepo(t, api.root, `locked-${state}`);
    if (!repo) return;
    const project = await createProject(api, `locked-${state}`, { path: repo });
    const workId = await createWork(api, `Locked ${state}`, project.id, state);
    const before = projectRow(api, project.id);
    const response = await sendCommand(api, "PATCH", `/projects/${project.id}`, { canonical_path: targetRepo }, `path-blocked:${state}`);
    const error = await assertApiError(response, 409, "project_has_running_works");
    assert.equal(error.error.details.operation, "path_change");
    assert.deepEqual(error.error.details.impact.blockers, ["running_works"]);
    assert.ok(error.error.message.length > 0, "the response includes a reason");
    const deleteError = await assertApiError(await sendCommand(api, "DELETE", `/projects/${project.id}`, { confirmed_work_count: 1 }, `delete-blocked:${state}`), 409, "project_has_running_works");
    assert.equal(deleteError.error.details.operation, "delete");
    assert.deepEqual(deleteError.error.details.impact.blockers, ["running_works"]);
    assert.equal(api.db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, project.id);
    assert.deepEqual(projectRow(api, project.id), before);
  }

  const agentRepo = await makeRepo(t, api.root, "locked-agent");
  if (!agentRepo) return;
  const agentProject = await createProject(api, "locked-agent", { path: agentRepo });
  const agentWork = await createWork(api, "Agent blocker", agentProject.id);
  await insertAgentRun(api.db, agentWork);
  for (const [method, payload, suffix] of [["PATCH", { canonical_path: targetRepo }, "path"], ["DELETE", { confirmed_work_count: 1 }, "delete"]]) {
    const path = `/projects/${agentProject.id}`;
    const error = await assertApiError(await sendCommand(api, method, path, payload, `agent-blocked:${suffix}`), 409, "project_has_running_works");
    assert.equal(error.error.details.operation, method === "PATCH" ? "path_change" : "delete");
    assert.deepEqual(error.error.details.impact.blockers, ["active_agents"]);
    assert.equal(error.error.details.impact.active_agent_count, 1);
    assert.ok(error.error.message.length > 0, "the response includes a reason");
  }

  const allowedRepo = await makeRepo(t, api.root, "unlocked-source");
  const allowedTarget = await makeRepo(t, api.root, "unlocked-second-target", "develop");
  if (!allowedRepo || !allowedTarget) return;
  const allowedProject = await createProject(api, "unlocked", { path: allowedRepo });
  for (const state of ["memo", "ready", "completed", "cancelled"]) await createWork(api, `Allowed ${state}`, allowedProject.id, state);
  const allowed = await sendCommand(api, "PATCH", `/projects/${allowedProject.id}`, { canonical_path: allowedTarget }, "path-unlocked-states");
  assert.equal(allowed.status, 200);
});

test("deletion-impact counts archived Works, blockers, active Agents, backlog, and the first 20 ordered running Works", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const repo = await makeRepo(t, api.root, "impact-project");
  if (!repo) return;
  const project = await createProject(api, "impact", { path: repo });
  const runningIds = [];
  for (let index = 0; index < 22; index += 1) {
    runningIds.push(await createWork(api, `Running ${index}`, project.id, "running"));
  }
  const archivedId = await createWork(api, "Archived completed", project.id, "completed");
  await archiveWork(api, archivedId);
  await insertAgentRun(api.db, runningIds[0]);
  await insertBacklogItem(api.db, project.id, archivedId);

  const response = await api.request(`/projects/${project.id}/deletion-impact`);
  assert.equal(response.status, 200);
  const impact = (await response.json()).data;
  assert.equal(impact.project_id, project.id);
  assert.equal(impact.work_count, 23);
  assert.equal(impact.running_work_count, 22);
  assert.equal(impact.active_agent_count, 1);
  assert.equal(impact.backlog_item_count, 1);
  assert.equal(impact.running_works.length, 20);
  assert.deepEqual(impact.blockers, ["running_works", "active_agents"]);
  assert.equal(impact.deletable, false);
  const expected = api.db.all(
    `SELECT id, display_number, title, state FROM works WHERE project_id = ? AND state IN ('running','paused','judgement_waiting')
     ORDER BY display_number IS NULL, display_number, created_at, id LIMIT 20`,
    project.id,
  );
  assert.deepEqual(impact.running_works, expected);
  await assertApiError(await api.request(`/projects/not-a-ulid/deletion-impact`), 400, "validation_error");
});

test("deleting a Project without Works removes only its row and leaves its repository", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const repo = await makeRepo(t, api.root, "empty-project");
  if (!repo) return;
  const project = await createProject(api, "empty", { path: repo });

  const response = await sendCommand(api, "DELETE", `/projects/${project.id}`, { confirmed_work_count: 0 }, "delete-empty");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, {
    project_id: project.id,
    deleted: true,
    detached_work_count: 0,
    detached_backlog_item_count: 0,
    detached_works: [],
  });
  assert.equal((await listProjects(api)).some((item) => item.id === project.id), false);
  assert.equal(api.db.get("SELECT id FROM projects WHERE id = ?", project.id), undefined);
  assert.equal(await readFile(join(repo, "README.md"), "utf8"), "project files remain\n");
  assert.equal((await stat(repo)).isDirectory(), true);
});

test("confirmed deletion detaches Works and backlog, reassigns colliding numbers, and keeps versions", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const repo = await makeRepo(t, api.root, "number-collision-project");
  if (!repo) return;
  const project = await createProject(api, "number-collision", { path: repo });
  const projectless = [
    await createWork(api, "Projectless one", null),
    await createWork(api, "Projectless two", null),
  ];
  const attached = [
    await createWork(api, "Attached one", project.id),
    await createWork(api, "Attached two", project.id),
    await createWork(api, "Attached archived", project.id, "completed"),
  ];
  await archiveWork(api, attached[2]);
  const backlogId = await insertBacklogItem(api.db, project.id, attached[0]);
  const versions = new Map(attached.map((id) => [id, api.db.get("SELECT state_version FROM works WHERE id = ?", id).state_version]));

  const unconfirmed = await assertApiError(await sendCommand(api, "DELETE", `/projects/${project.id}`, { confirmed_work_count: 0 }, "delete-unconfirmed"), 409, "project_deletion_impact_changed");
  assert.equal(unconfirmed.error.details.impact.work_count, 3);
  const response = await sendCommand(api, "DELETE", `/projects/${project.id}`, { confirmed_work_count: 3 }, "delete-confirmed");
  assert.equal(response.status, 200);
  const result = (await response.json()).data;
  assert.equal(result.detached_work_count, 3);
  assert.equal(result.detached_backlog_item_count, 1);
  assert.deepEqual(result.detached_works.map((work) => work.work_id), attached);
  for (const [index, workId] of attached.entries()) {
    const row = api.db.get("SELECT project_id, display_number, state_version FROM works WHERE id = ?", workId);
    assert.equal(row.project_id, null);
    assert.equal(row.display_number, index + 3);
    assert.equal(row.state_version, versions.get(workId));
  }
  assert.equal(api.db.get("SELECT project_id FROM backlog_items WHERE id = ?", backlogId).project_id, null);
  assert.equal(api.db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'project.deleted' AND json_extract(payload_json, '$.project_id') = ?", project.id).count, 1);
  assert.equal(api.db.get("SELECT id FROM projects WHERE id = ?", project.id), undefined);
  assert.deepEqual(projectless.map((id) => api.db.get("SELECT display_number FROM works WHERE id = ?", id).display_number), [1, 2]);
  const next = await createWork(api, "Projectless after deletion", null);
  assert.equal(api.db.get("SELECT display_number FROM works WHERE id = ?", next).display_number, 6);
});

test("detachment fills the smallest free projectless number", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const first = await createWork(api, "Projectless retained number", null);
  const removed = await createWork(api, "Projectless deleted number", null);
  await setWorkState(api.db, removed, "completed");
  await archiveWork(api, removed);
  await api.durableCore.deleteWork(removed, command({}, `delete-work:${removed}`, 1));
  const repo = await makeRepo(t, api.root, "counter-project");
  if (!repo) return;
  const project = await createProject(api, "counter", { path: repo });
  const attached = await createWork(api, "Attached number", project.id);

  const response = await sendCommand(api, "DELETE", `/projects/${project.id}`, { confirmed_work_count: 1 }, "delete-counter");
  assert.equal(response.status, 200);
  assert.equal(api.db.get("SELECT display_number FROM works WHERE id = ?", first).display_number, 1);
  assert.equal(api.db.get("SELECT display_number FROM works WHERE id = ?", attached).display_number, 2);
});

test("DELETE reports running blockers before a stale confirmed count and leaves the DB unchanged", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const repo = await makeRepo(t, api.root, "delete-blocked-project");
  if (!repo) return;
  const project = await createProject(api, "delete-blocked", { path: repo });
  const workId = await createWork(api, "Delete blocker", project.id, "running");
  const beforeProject = projectRow(api, project.id);
  const beforeWork = api.db.get("SELECT project_id, state, display_number, state_version FROM works WHERE id = ?", workId);

  const error = await assertApiError(await sendCommand(api, "DELETE", `/projects/${project.id}`, { confirmed_work_count: 0 }, "delete-blocked"), 409, "project_has_running_works");
  assert.equal(error.error.details.operation, "delete");
  assert.deepEqual(error.error.details.impact.blockers, ["running_works"]);
  assert.equal(error.error.details.impact.work_count, 1);
  assert.ok(error.error.message.length > 0);
  assert.deepEqual(projectRow(api, project.id), beforeProject);
  assert.deepEqual(api.db.get("SELECT project_id, state, display_number, state_version FROM works WHERE id = ?", workId), beforeWork);
});

test("DELETE rejects a changed Work count, leaves rows intact, then accepts the current count", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const repo = await makeRepo(t, api.root, "impact-changed-project");
  if (!repo) return;
  const project = await createProject(api, "impact-changed", { path: repo });
  const workIds = [await createWork(api, "Count one", project.id), await createWork(api, "Count two", project.id)];
  const before = projectRow(api, project.id);

  const error = await assertApiError(await sendCommand(api, "DELETE", `/projects/${project.id}`, { confirmed_work_count: 0 }, "delete-count-stale"), 409, "project_deletion_impact_changed");
  assert.equal(error.error.details.confirmed_work_count, 0);
  assert.equal(error.error.details.impact.work_count, 2);
  assert.deepEqual(projectRow(api, project.id), before);
  assert.deepEqual(api.db.all("SELECT id, project_id FROM works WHERE id IN (?, ?) ORDER BY id", ...workIds).map((row) => row.project_id), [project.id, project.id]);

  assert.equal((await sendCommand(api, "DELETE", `/projects/${project.id}`, { confirmed_work_count: 2 }, "delete-count-current")).status, 200);
});

test("DELETE replays the same idempotent response and rejects a changed payload for the same key", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const repo = await makeRepo(t, api.root, "idempotent-project");
  if (!repo) return;
  const project = await createProject(api, "idempotent", { path: repo });
  const path = `/projects/${project.id}`;
  const key = "delete-idempotent-project";
  const first = await sendCommand(api, "DELETE", path, { confirmed_work_count: 0 }, key);
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  const replay = await sendCommand(api, "DELETE", path, { confirmed_work_count: 0 }, key);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), firstBody);
  await assertApiError(await sendCommand(api, "DELETE", path, { confirmed_work_count: 1 }, key), 409, "idempotency_conflict");
});

test("deleting a Project preserves its repository and workspace files", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const repo = await makeRepo(t, api.root, "filesystem-project");
  if (!repo) return;
  const project = await createProject(api, "filesystem", { path: repo });
  const workId = await createWork(api, "Workspace file holder", project.id, "completed");
  const taskId = createUlid();
  const task = await api.durableCore.gitGateway().prepareWorktree({ work_id: workId, task_id: taskId });
  assert.equal(task.ok, true, task.message);
  const workspaceFile = join(task.worktree_path, "keep.txt");
  await writeFile(workspaceFile, "keep workspace data\n");

  const response = await sendCommand(api, "DELETE", `/projects/${project.id}`, { confirmed_work_count: 1 }, "delete-preserve-files");
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(await readFile(join(repo, "README.md"), "utf8"), "project files remain\n");
  assert.equal(await readFile(workspaceFile, "utf8"), "keep workspace data\n");
  assert.equal((await stat(task.worktree_path)).isDirectory(), true);
  assert.equal((await stat(repo)).isDirectory(), true);
});

test("a worktree cleanup failure cannot block Project deletion or remove workspace files", async (t) => {
  let cleanupCalls = 0;
  const failingGit = {
    deleteWorkWorkspaces: async () => {
      cleanupCalls += 1;
      return { ok: false, message: "test cleanup failure" };
    },
  };
  const api = await setup(t, { coreOptions: { git: failingGit } });
  if (!api) return;
  const repo = await makeRepo(t, api.root, "cleanup-failure-project");
  if (!repo) return;
  const project = await createProject(api, "cleanup-failure", { path: repo });
  const workId = await createWork(api, "Cleanup failure holder", project.id, "completed");
  const workspace = join(api.root, ".owl-workspaces", workId, "task-files");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "draft.txt"), "keep for failed deletion\n");
  const response = await sendCommand(api, "DELETE", `/projects/${project.id}`, { confirmed_work_count: 1 }, "delete-cleanup-failure");
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.equal(cleanupCalls, 0);
  assert.equal(projectRow(api, project.id), undefined);
  assert.equal(api.db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, null);
  assert.equal(await readFile(join(workspace, "draft.txt"), "utf8"), "keep for failed deletion\n");
});

test("the schema RESTRICT foreign key still rejects deleting a Project with attached Works directly", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const repo = await makeRepo(t, api.root, "foreign-key-project");
  if (!repo) return;
  const project = await createProject(api, "foreign-key", { path: repo });
  const workId = await createWork(api, "Foreign key Work", project.id);

  await assert.rejects(
    api.db.createWriteLane().transact((transaction) => transaction.run("DELETE FROM projects WHERE id = ?", project.id)),
    /FOREIGN KEY constraint failed/u,
  );
  assert.ok(projectRow(api, project.id));
  assert.equal(api.db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, project.id);
});

test("MemoryCore supports PATCH, impact, DELETE, path conflicts, and not-found responses", async (t) => {
  const api = await setup(t, { memory: true });
  if (!api) return;
  const firstRepo = await makeRepo(t, api.root, "memory-project-one");
  const secondRepo = await makeRepo(t, api.root, "memory-project-two");
  if (!firstRepo || !secondRepo) return;
  const first = await createMemoryProject(api, "memory-one", firstRepo);
  const second = await createMemoryProject(api, "memory-two", secondRepo);
  const beforeConflict = await listProjects(api);

  const conflict = await assertApiError(await sendCommand(api, "PATCH", `/projects/${second.id}`, { canonical_path: firstRepo }, "memory-conflict"), 400, "validation_error");
  assert.equal(conflict.error.details.project_id, first.id);
  assert.deepEqual(await listProjects(api), beforeConflict);
  const renamed = await sendCommand(api, "PATCH", `/projects/${first.id}`, { name: "Memory renamed" }, "memory-rename");
  assert.equal(renamed.status, 200);
  const impact = await api.request(`/projects/${first.id}/deletion-impact`);
  assert.equal(impact.status, 200);
  assert.equal((await impact.json()).data.work_count, 0);
  assert.equal((await sendCommand(api, "DELETE", `/projects/${first.id}`, { confirmed_work_count: 0 }, "memory-delete")).status, 200);
  assert.equal((await listProjects(api)).some((item) => item.id === second.id), true);
  await assertApiError(await sendCommand(api, "PATCH", `/projects/${first.id}`, { name: "Gone" }, "memory-patch-missing"), 404, "project_not_found");
  await assertApiError(await api.request(`/projects/${first.id}/deletion-impact`), 404, "project_not_found");
  await assertApiError(await sendCommand(api, "DELETE", `/projects/${first.id}`, { confirmed_work_count: 0 }, "memory-delete-missing"), 404, "project_not_found");
  await assertApiError(await api.request(`/projects/${createUlid()}/deletion-impact`), 404, "project_not_found");
});

test("MemoryCore keeps post_merge_command given at POST /projects and defaults to null", async (t) => {
  const api = await setup(t, { memory: true });
  if (!api) return;
  const repoA = await makeRepo(t, api.root, "memory-post-merge-a");
  const repoB = await makeRepo(t, api.root, "memory-post-merge-b");
  if (!repoA || !repoB) return;
  const body = async (repo, name, fields) => {
    const canonicalPath = await realpath(repo);
    return { name, canonical_path: canonicalPath, base_branch: "main", allowed_roots: [canonicalPath], verification_plan: [], ...fields };
  };
  const withCmd = await sendCommand(api, "POST", "/projects", await body(repoA, "PM a", { post_merge_command: ["node", "-v"] }), "pm-create-a");
  assert.equal(withCmd.status, 201);
  assert.deepEqual((await withCmd.json()).data.post_merge_command, ["node", "-v"]);
  const without = await sendCommand(api, "POST", "/projects", await body(repoB, "PM b", {}), "pm-create-b");
  assert.equal(without.status, 201);
  const projects = await listProjects(api);
  assert.deepEqual(projects.find((item) => item.name === "PM a").post_merge_command, ["node", "-v"]);
  assert.equal(projects.find((item) => item.name === "PM b").post_merge_command, null);
});

test("an ExternalCoreAdapter without the new methods returns core_not_ready for all three routes", async (t) => {
  const api = await setup(t, { legacyAdapter: true });
  if (!api) return;
  const repo = await makeRepo(t, api.root, "legacy-adapter-project");
  if (!repo) return;
  const project = await createProject(api, "legacy-adapter", { path: repo });

  await assertApiError(await sendCommand(api, "PATCH", `/projects/${project.id}`, { name: "Updated" }, "legacy-patch"), 503, "core_not_ready");
  await assertApiError(await api.request(`/projects/${project.id}/deletion-impact`), 503, "core_not_ready");
  await assertApiError(await sendCommand(api, "DELETE", `/projects/${project.id}`, { confirmed_work_count: 0 }, "legacy-delete"), 503, "core_not_ready");
  assert.ok(projectRow(api, project.id));
});

test("post_merge_command saves, reads back, resets, and rejects invalid values", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const repo = await makeRepo(t, api.root, "post-merge-project");
  if (!repo) return;
  const project = await createProject(api, "post-merge-existing", { path: repo });
  assert.equal(project.post_merge_command, null);
  const patch = (value, key) => sendCommand(api, "PATCH", `/projects/${project.id}`, { post_merge_command: value }, `post-merge:${key}`);
  const saved = await patch(["pnpm", "build"], "set");
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).data.post_merge_command, ["pnpm", "build"]);
  assert.deepEqual((await listProjects(api)).find((p) => p.id === project.id).post_merge_command, ["pnpm", "build"]);
  assert.deepEqual((await (await patch([], "off")).json()).data.post_merge_command, []);
  assert.equal((await (await patch(null, "reset")).json()).data.post_merge_command, null);
  for (const [key, value] of [["string", "pnpm build"], ["empty-name", [""]], ["blank-name", [" ", "x"]], ["non-string", ["pnpm", 1]]]) {
    await assertApiError(await patch(value, key), 400, "validation_error");
  }
});

test("auto_push defaults off, PATCH persists booleans, and non-booleans are rejected", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const repo = await makeRepo(t, api.root, "auto-push-project");
  if (!repo) return;
  const existing = await createProject(api, "auto-push-existing", { path: repo });
  assert.equal(existing.auto_push, false);
  assert.equal((await listProjects(api)).find((project) => project.id === existing.id).auto_push, false);

  const createPayload = {
    name: "Auto push created",
    canonical_path: join(api.root, "auto-push-created"),
    base_branch: "main",
    allowed_roots: [join(api.root, "auto-push-created")],
    verification_plan: [],
  };
  await assertApiError(await sendCommand(api, "POST", "/projects", { ...createPayload, auto_push: true }, "auto-push-create-invalid"), 400, "validation_error");
  const createdResponse = await sendCommand(api, "POST", "/projects", createPayload, "auto-push-create");
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).data;
  assert.equal(created.auto_push, false);

  const enabled = await sendCommand(api, "PATCH", `/projects/${existing.id}`, { auto_push: true }, "auto-push:true");
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).data.auto_push, true);
  assert.equal((await listProjects(api)).find((project) => project.id === existing.id).auto_push, true);
  const omitted = await sendCommand(api, "PATCH", `/projects/${existing.id}`, { name: "Auto push renamed" }, "auto-push-omitted");
  assert.equal((await omitted.json()).data.auto_push, true);
  const disabled = await sendCommand(api, "PATCH", `/projects/${existing.id}`, { auto_push: false }, "auto-push:false");
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).data.auto_push, false);
  assert.equal((await listProjects(api)).find((project) => project.id === existing.id).auto_push, false);
  for (const value of ["true", 1, null]) {
    await assertApiError(await sendCommand(api, "PATCH", `/projects/${existing.id}`, { auto_push: value }, `auto-push-invalid:${String(value)}`), 400, "validation_error");
  }

  const memoryApi = await setup(t, { memory: true });
  if (!memoryApi) return;
  const memoryPath = join(memoryApi.root, "memory-auto-push");
  await mkdir(memoryPath);
  const memoryCreate = await sendCommand(memoryApi, "POST", "/projects", {
    name: "Memory auto push",
    canonical_path: memoryPath,
    base_branch: "main",
    allowed_roots: [memoryPath],
    verification_plan: [],
  }, "memory-auto-push-create");
  assert.equal(memoryCreate.status, 201);
  const memoryProject = (await memoryCreate.json()).data;
  assert.equal(memoryProject.auto_push, false);
  const memoryUpdate = await sendCommand(memoryApi, "PATCH", `/projects/${memoryProject.id}`, { auto_push: true }, "memory-auto-push-update");
  assert.equal(memoryUpdate.status, 200);
  assert.equal((await memoryUpdate.json()).data.auto_push, true);
  assert.equal((await listProjects(memoryApi)).find((project) => project.id === memoryProject.id).auto_push, true);
  const memoryDisable = await sendCommand(memoryApi, "PATCH", `/projects/${memoryProject.id}`, { auto_push: false }, "memory-auto-push-disable");
  assert.equal((await memoryDisable.json()).data.auto_push, false);
  assert.equal((await listProjects(memoryApi)).find((project) => project.id === memoryProject.id).auto_push, false);
});

test("an existing Project defaults to auto_push=false when the migration is applied", async (t) => {
  const root = await tempDir(t, "owl-project-auto-push-migration-");
  const oldMigrations = join(root, "old-migrations");
  await mkdir(oldMigrations);
  const migrationFiles = await readdir(migrationsDir);
  const autoPushMigration = migrationFiles.find((file) => file.endsWith("_project_auto_push.sql"));
  assert.ok(autoPushMigration);
  for (const filename of migrationFiles.filter((file) => file.endsWith(".sql") && file < autoPushMigration)) {
    await copyFile(join(migrationsDir, filename), join(oldMigrations, filename));
  }
  const db = openDatabase(join(root, "owl.db")); // helpers-exempt: DB migrated with only the migrations before auto_push
  db.migrate(oldMigrations);
  const { core } = await createTestCore(t, {
    db,
    version: "api-project-auto-push-migration-test",
    owlRoot: root,
    dataDir: root,
  });
  t.after(() => db.close());
  await core.createProject(command({
    name: "Pre-migration Project",
    canonical_path: root,
    base_branch: "main",
    allowed_roots: [root],
    verification_plan: [],
  }, "pre-migration-project"));

  db.migrate(migrationsDir);
  assert.equal(core.listProjects().data[0].auto_push, false);
});

test("worktree setup and refresh commands default empty, PATCH persists argv, and invalid values are rejected", async (t) => {
  for (const memory of [false, true]) {
    const api = await setup(t, memory ? { memory: true } : {});
    if (!api) return;
    let project;
    if (memory) {
      const path = join(api.root, "memory-worktree-commands");
      await mkdir(path);
      const created = await sendCommand(api, "POST", "/projects", {
        name: "Memory worktree commands",
        canonical_path: path,
        base_branch: "main",
        allowed_roots: [path],
        verification_plan: [],
      }, "worktree-commands-create");
      project = (await created.json()).data;
    } else {
      const repo = await makeRepo(t, api.root, "worktree-commands-project");
      if (!repo) return;
      project = await createProject(api, "worktree-commands", { path: repo });
    }
    assert.deepEqual(project.worktree_setup_command, []);
    assert.deepEqual(project.worktree_refresh_command, []);

    const updated = await sendCommand(api, "PATCH", `/projects/${project.id}`, {
      worktree_setup_command: ["make", "deps"],
      worktree_refresh_command: ["serena", "project", "index", "."],
    }, "worktree-commands-set");
    assert.equal(updated.status, 200);
    const data = (await updated.json()).data;
    assert.deepEqual(data.worktree_setup_command, ["make", "deps"]);
    assert.deepEqual(data.worktree_refresh_command, ["serena", "project", "index", "."]);
    const listed = (await listProjects(api)).find((candidate) => candidate.id === project.id);
    assert.deepEqual(listed.worktree_refresh_command, ["serena", "project", "index", "."]);

    const cleared = await sendCommand(api, "PATCH", `/projects/${project.id}`, { worktree_setup_command: [] }, "worktree-commands-clear");
    const clearedData = (await cleared.json()).data;
    assert.deepEqual(clearedData.worktree_setup_command, []);
    assert.deepEqual(clearedData.worktree_refresh_command, ["serena", "project", "index", "."]);

    for (const [index, value] of ["make deps", [" ", "x"], [1], null, ["ok", "a\u0000b"]].entries()) {
      await assertApiError(await sendCommand(api, "PATCH", `/projects/${project.id}`, { worktree_refresh_command: value }, `worktree-commands-invalid:${index}`), 400, "validation_error");
    }
  }
});

test("POST /projects stores post_merge_command and rejects invalid values", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const path = join(api.root, "post-merge-created");
  const payload = { name: "Post merge created", canonical_path: path, base_branch: "main", allowed_roots: [path], verification_plan: [] };
  for (const [index, bad] of ["node", ["node", ""], [""], [1]].entries()) {
    await assertApiError(await sendCommand(api, "POST", "/projects", { ...payload, post_merge_command: bad }, `pm-create-bad-${index}`), 400, "validation_error");
  }
  const response = await sendCommand(api, "POST", "/projects", { ...payload, post_merge_command: ["node", "x.js"] }, "pm-create-ok");
  assert.equal(response.status, 201);
  const created = (await response.json()).data;
  assert.deepEqual(created.post_merge_command, ["node", "x.js"]);
  assert.deepEqual((await listProjects(api)).find((project) => project.id === created.id).post_merge_command, ["node", "x.js"]);
  await assertApiError(await sendCommand(api, "PATCH", `/projects/${created.id}`, { post_merge_command: ["node", ""] }, "pm-patch-bad"), 400, "validation_error");
});

test("Project responses carry test_run_status: detected when unset, explicit after PATCH test_run", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const repo = await makeRepo(t, api.root, "test-status-project");
  if (!repo) return;
  const project = await createProject(api, "test-status", { path: repo });

  assert.deepEqual(project.test_run_status, { enabled: false, reason: "no_test_marker", command: null, source: "detected" });
  const listedBefore = (await listProjects(api)).find((item) => item.id === project.id);
  assert.deepEqual(listedBefore.test_run_status, project.test_run_status);

  const testRun = { mode: "whole", whole_argv: ["make", "test"] };
  const response = await sendCommand(api, "PATCH", `/projects/${project.id}`, { test_run: testRun }, "patch-test-run");
  assert.equal(response.status, 200);
  const expected = { enabled: true, reason: null, command: ["make", "test"], source: "explicit" };
  assert.deepEqual((await response.json()).data.test_run_status, expected);
  const listedAfter = (await listProjects(api)).find((item) => item.id === project.id);
  assert.deepEqual(listedAfter.test_run_status, expected);
});

test("post_merge_install_command saves, reads back, resets, and rejects invalid values over HTTP", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const repo = await makeRepo(t, api.root, "post-merge-install-project");
  if (!repo) return;
  const project = await createProject(api, "post-merge-install", { path: repo });
  assert.equal(project.post_merge_install_command ?? null, null);
  const patch = (value, key) => sendCommand(api, "PATCH", `/projects/${project.id}`, { post_merge_install_command: value }, `pm-install:${key}`);
  const saved = await patch(["npm", "ci"], "set");
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).data.post_merge_install_command, ["npm", "ci"]);
  assert.deepEqual((await listProjects(api)).find((p) => p.id === project.id).post_merge_install_command, ["npm", "ci"]);
  assert.deepEqual((await (await patch([], "off")).json()).data.post_merge_install_command, []);
  assert.equal((await (await patch(null, "reset")).json()).data.post_merge_install_command, null);
  for (const [key, value] of [["string", "npm ci"], ["empty-name", [""]], ["empty-arg", ["npm", ""]], ["non-string", ["npm", 1]]]) {
    await assertApiError(await patch(value, key), 400, "validation_error");
  }
});

test("updateProject rejects an invalid verification_plan and keeps the stored plan readable", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const repo = await makeRepo(t, api.root, "verification-plan-project");
  if (!repo) return;
  const project = await createProject(api, "verification-plan", { path: repo });
  const read = () => api.db.get("SELECT verification_plan_json FROM projects WHERE id = ?", project.id).verification_plan_json;
  const before = read();
  for (const [key, value] of [["string", "x"], ["bad-entry", [{ command_id: "a" }]]]) {
    await assert.rejects(
      () => api.durableCore.updateProject(project.id, command({ verification_plan: value }, `bad-plan:${key}`)),
      (error) => error?.code === "validation_error",
    );
  }
  assert.equal(read(), before);
});

test("an Advisor guard token alone can register a Project with POST /projects", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const path = join(api.root, "advisor-created");
  const response = await fetch(`${api.server.baseUrl}/api/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await api.advisorToken()}` },
    body: JSON.stringify(command({ name: "Advisor created", canonical_path: path, base_branch: "main", allowed_roots: [path], verification_plan: [] }, "advisor-create")),
  });
  assert.equal(response.status, 201);
});
