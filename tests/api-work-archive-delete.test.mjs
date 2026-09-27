import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createOwlHttpServer } from "../apps/server/dist/http.js";
import { ExternalCoreAdapter } from "../apps/server/dist/core.js";
import { Core } from "../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function command(payload, suffix, expectedVersion = 0) {
  return { request_id: randomUUID(), idempotency_key: `api-work-archive:${suffix}`, expected_version: expectedVersion, payload };
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-api-work-archive-delete-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const durableCore = new Core({ db, agentRunner: {}, version: "api-work-archive-delete-test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  const core = new ExternalCoreAdapter(durableCore, db, root, dataDir);
  const originalToken = process.env.OWL_API_TOKEN;
  const token = randomBytes(32).toString("hex");
  process.env.OWL_API_TOKEN = token;
  const http = createOwlHttpServer({
    core,
    db,
    webOut: root,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot: root,
    dataDir,
  });
  t.after(async () => {
    if (http.server.listening) await http.close();
    await durableCore.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
    if (originalToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = originalToken;
  });
  try {
    await http.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("localhost listen is not permitted in this environment");
      return null;
    }
    throw error;
  }

  const base = `http://127.0.0.1:${http.server.address().port}/api/v1`;
  const request = (path, { method = "GET", body, origin } = {}) => {
    const headers = { "content-type": "application/json" };
    headers.authorization = `Bearer ${token}`;
    if (origin !== undefined) headers.origin = origin;
    return fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  return { root, dataDir, db, core: durableCore, origin: new URL(base).origin, request };
}

async function createWork(core, db, title, state) {
  const created = await core.createWork(command({ title, summary: "", size: "small", project_id: null }, `create:${title}`));
  const workId = created.data.work_id;
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `UPDATE works
         SET state = ?, state_version = 1, updated_at = ?,
             completed_at = CASE WHEN ? = 'completed' THEN ? ELSE NULL END,
             cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE NULL END
       WHERE id = ?`,
      state, now, state, now, state, now, workId,
    );
  });
  return workId;
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function assertApiError(response, status, code, details) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error.code, code);
  if (details) {
    for (const [key, value] of Object.entries(details)) assert.deepEqual(body.error.details[key], value);
  }
  return body;
}

function commandBody(key, expectedVersion = 1, payload = {}) {
  return { request_id: `req-${randomUUID()}`, idempotency_key: key, expected_version: expectedVersion, payload };
}

async function archive(request, workId, key = `archive-${randomUUID()}`) {
  return request(`/works/${workId}/archive`, { method: "POST", body: commandBody(key) });
}

async function unarchive(request, workId, key = `unarchive-${randomUUID()}`) {
  return request(`/works/${workId}/unarchive`, { method: "POST", body: commandBody(key) });
}

async function deleteWork(request, workId, key = `delete-${randomUUID()}`) {
  return request(`/works/${workId}`, { method: "DELETE", body: commandBody(key) });
}

async function listedIds(request, archived) {
  const response = await request(`/works${archived ? `?archived=${archived}` : ""}`);
  assert.equal(response.status, 200);
  return (await response.json()).data.map((work) => work.id);
}

test("Work archive routes filter completed and cancelled Works and support no-op unarchive", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const completedId = await createWork(api.core, api.db, "API completed archive", "completed");
  const cancelledId = await createWork(api.core, api.db, "API cancelled archive", "cancelled");

  for (const workId of [completedId, cancelledId]) {
    const response = await archive(api.request, workId, `archive:${workId}`);
    assert.equal(response.status, 200);
    const archived = await response.json();
    assert.equal(archived.data.work_id, workId);
    assert.match(archived.data.archived_at, /^\d{4}-\d\d-\d\dT.*Z$/u);
    assert.equal(archived.version, 1);
    assert.ok(!(await listedIds(api.request)).includes(workId));
    assert.ok((await listedIds(api.request, "include")).includes(workId));
    assert.ok((await listedIds(api.request, "only")).includes(workId));
    const detail = await api.request(`/works/${workId}`);
    assert.equal((await detail.json()).data.archived_at, archived.data.archived_at);
  }
  await assertApiError(await api.request("/works?archived=bad"), 400, "invalid_query");

  const unarchived = await unarchive(api.request, completedId, `unarchive:${completedId}`);
  assert.equal(unarchived.status, 200);
  assert.deepEqual((await unarchived.json()).data, { work_id: completedId, archived_at: null });
  assert.ok((await listedIds(api.request)).includes(completedId));
  assert.ok(!(await listedIds(api.request, "only")).includes(completedId));

  const archivedAgain = await archive(api.request, completedId, `archive-again:${completedId}`);
  assert.equal(archivedAgain.status, 200);
  const archivedAgainBody = await archivedAgain.json();
  const archiveNoop = await archive(api.request, completedId, `archive-noop:${completedId}`);
  assert.equal(archiveNoop.status, 200);
  assert.equal((await archiveNoop.json()).data.archived_at, archivedAgainBody.data.archived_at);

  const unarchivedAgain = await unarchive(api.request, completedId, `unarchive-again:${completedId}`);
  assert.equal(unarchivedAgain.status, 200);
  const unarchiveNoop = await unarchive(api.request, completedId, `unarchive-noop:${completedId}`);
  assert.equal(unarchiveNoop.status, 200);
  assert.deepEqual((await unarchiveNoop.json()).data, { work_id: completedId, archived_at: null });
});

test("non-terminal Works reject archive, unarchive, and DELETE with their current state", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const runningId = await createWork(api.core, api.db, "API running state", "running");
  const waitingId = await createWork(api.core, api.db, "API waiting state", "judgement_waiting");
  const readyId = await createWork(api.core, api.db, "API ready state", "ready");

  await assertApiError(await archive(api.request, runningId), 409, "invalid_state_transition", { state: "running" });
  await assertApiError(await unarchive(api.request, waitingId), 409, "invalid_state_transition", { state: "judgement_waiting" });
  await assertApiError(await deleteWork(api.request, readyId), 409, "invalid_state_transition", { state: "ready" });

  const unarchivedTerminalId = await createWork(api.core, api.db, "API terminal but active", "completed");
  await assertApiError(await deleteWork(api.request, unarchivedTerminalId), 409, "work_not_archived");
});

test("DELETE permanently removes an archived Work and reports missing ids", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const workId = await createWork(api.core, api.db, "API delete archived", "completed");
  const archiveResponse = await archive(api.request, workId, `archive-before-delete:${workId}`);
  assert.equal(archiveResponse.status, 200);

  const deleted = await deleteWork(api.request, workId, `delete:${workId}`);
  assert.equal(deleted.status, 200);
  assert.deepEqual((await deleted.json()).data, { work_id: workId, deleted: true });
  await assertApiError(await api.request(`/works/${workId}`), 404, "work_not_found");
  assert.ok(!(await listedIds(api.request, "include")).includes(workId));
  assert.ok(!(await listedIds(api.request, "only")).includes(workId));
  await assertApiError(await deleteWork(api.request, createUlid()), 404, "work_not_found");
});

test("branch status reports unmerged branch changes and DELETE removes those branches", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const projectRoot = join(api.root, "project");
  await mkdir(projectRoot, { recursive: true });
  git(projectRoot, "init", "--initial-branch=main");
  git(projectRoot, "config", "user.name", "Test");
  git(projectRoot, "config", "user.email", "test@example.invalid");
  await writeFile(join(projectRoot, "README.md"), "base\n");
  git(projectRoot, "add", ".");
  git(projectRoot, "commit", "-m", "initial");
  const project = await api.core.createProject(command({
    name: "Delete branch API project",
    canonical_path: projectRoot,
    base_branch: "main",
    allowed_roots: [api.root],
    verification_plan: [],
  }, "create-project-with-unmerged-branches"));
  const workId = await createWork(api.core, api.db, "API unmerged branch status", "completed");
  await api.db.createWriteLane().transact((transaction) => transaction.run(
    "UPDATE works SET project_id = ? WHERE id = ?", project.data.id, workId,
  ));
  const taskId = createUlid();
  const task = await api.core.gitGateway().prepareWorktree({ work_id: workId, task_id: taskId });
  assert.equal(task.ok, true, task.message);
  await writeFile(join(task.worktree_path, "unmerged.txt"), "will be deleted\n");
  git(task.worktree_path, "add", "unmerged.txt");
  git(task.worktree_path, "commit", "-m", "unmerged Task change");

  const detail = await api.request(`/works/${workId}`);
  assert.equal(detail.status, 200);
  assert.equal("has_unmerged_changes" in (await detail.json()).data, false);
  const status = await api.request(`/works/${workId}/branch-status`);
  assert.equal(status.status, 200);
  assert.deepEqual((await status.json()).data, { work_id: workId, unmerged_changes: "present" });
  const missing = await api.request(`/works/${createUlid()}/branch-status`);
  assert.equal(missing.status, 404);
  await archive(api.request, workId, `archive-unmerged:${workId}`);

  const deleted = await deleteWork(api.request, workId, `delete-unmerged:${workId}`);
  assert.equal(deleted.status, 200);
  assert.equal(git(projectRoot, "branch", "--list", `owl/work/${workId}/work`), "");
  assert.equal(git(projectRoot, "branch", "--list", `owl/task/${workId}/${taskId}`), "");
});

test("archive, unarchive, and DELETE reject cross-origin requests from an authenticated owner", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const workId = await createWork(api.core, api.db, "API CSRF authenticated", "completed");
  const foreignOrigin = "http://evil.example";

  await assertApiError(await api.request(`/works/${workId}/archive`, {
    method: "POST",
    origin: foreignOrigin,
    body: commandBody(`csrf-archive:${workId}`),
  }), 403, "forbidden");
  let detail = await api.request(`/works/${workId}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).data.archived_at, null);

  const archived = await api.request(`/works/${workId}/archive`, {
    method: "POST",
    origin: api.origin,
    body: commandBody(`same-origin-archive:${workId}`),
  });
  assert.equal(archived.status, 200);
  const archivedAt = (await archived.json()).data.archived_at;

  await assertApiError(await api.request(`/works/${workId}/unarchive`, {
    method: "POST",
    origin: foreignOrigin,
    body: commandBody(`csrf-unarchive:${workId}`),
  }), 403, "forbidden");
  detail = await api.request(`/works/${workId}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).data.archived_at, archivedAt);

  await assertApiError(await api.request(`/works/${workId}`, {
    method: "DELETE",
    origin: foreignOrigin,
    body: commandBody(`csrf-delete:${workId}`),
  }), 403, "forbidden");
  detail = await api.request(`/works/${workId}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).data.archived_at, archivedAt);
});

test("archive idempotency replays the same response and rejects a changed body", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const workId = await createWork(api.core, api.db, "API idempotency", "completed");
  const key = `archive-idempotency:${workId}`;
  const firstCommand = commandBody(key);
  const first = await api.request(`/works/${workId}/archive`, { method: "POST", body: firstCommand });
  assert.equal(first.status, 200);
  const firstBody = await first.json();

  const replay = await api.request(`/works/${workId}/archive`, {
    method: "POST",
    body: { ...firstCommand, request_id: `replay-${randomUUID()}` },
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), firstBody);

  const conflict = await api.request(`/works/${workId}/archive`, {
    method: "POST",
    body: { ...firstCommand, expected_version: firstCommand.expected_version + 1 },
  });
  await assertApiError(conflict, 409, "idempotency_conflict");
});
