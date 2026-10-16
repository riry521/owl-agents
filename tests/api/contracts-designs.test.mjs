import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import test from "node:test";

import { ExternalCoreAdapter, createCore as createMemoryCore } from "../../apps/server/dist/core.js";
import { GuardTokenRegistry } from "../../apps/server/dist/guard-tokens.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

test("design document APIs list available documents, return Markdown, and 404 for missing content", async (t) => {
  const { root, db, core: durableCore } = await createTestCore(
    t,
    { version: "api-design-contract-test", dispatcher: { tick_interval_ms: 25 } },
    { prefix: "owl-api-designs-" },
  );
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const core = new ExternalCoreAdapter(durableCore, db, root, dataDir);
  const token = randomBytes(32).toString("hex");
  const api = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root, dataDir }, { token });
  if (!api) return t.skip("localhost listen is unavailable");
  const request = (path) => api.request("GET", `/api/v1${path}`);

  const created = await durableCore.createWork({
    request_id: randomUUID(), idempotency_key: "api-designs:create", expected_version: 0,
    payload: { title: "Design API Work", summary: "", size: "small", project_id: null },
  });
  const workId = created.data.work_id;
  const taskId = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, ?, 'Plan the API', 'design', 'completed', 'normal', '', '', ?, ?)`,
      taskId, workId, now, now,
    );
  });
  const documentPath = join(dataDir, "designs", workId, `${taskId}.md`);
  await mkdir(dirname(documentPath), { recursive: true });
  await writeFile(documentPath, "# API design\n");

  const listResponse = await request(`/works/${workId}/designs`);
  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()).data.designs;
  assert.deepEqual(listed.map(({ task_id, title, size_bytes }) => ({ task_id, title, size_bytes })), [
    { task_id: taskId, title: "Plan the API", size_bytes: Buffer.byteLength("# API design\n") },
  ]);
  assert.ok(Number.isFinite(Date.parse(listed[0].updated_at)));

  const detailResponse = await request(`/works/${workId}/designs/${taskId}`);
  assert.equal(detailResponse.status, 200);
  assert.deepEqual((await detailResponse.json()).data, {
    task_id: taskId, title: "Plan the API", markdown: "# API design\n", updated_at: (await stat(documentPath)).mtime.toISOString(),
  });

  // A file at a non-design Task's path is not a design document.
  const codeTaskId = createUlid();
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, ?, 'Build the API', 'code', 'completed', 'normal', '', '', ?, ?)`,
      codeTaskId, workId, now, now,
    );
  });
  await writeFile(join(dataDir, "designs", workId, `${codeTaskId}.md`), "# Not a design\n");
  const codeTaskResponse = await request(`/works/${workId}/designs/${codeTaskId}`);
  assert.equal(codeTaskResponse.status, 404);
  assert.equal((await codeTaskResponse.json()).error.code, "design_document_not_found");

  // A design Task of another Work is not reachable through this Work.
  const other = await durableCore.createWork({
    request_id: randomUUID(), idempotency_key: "api-designs:create-other", expected_version: 0,
    payload: { title: "Other Work", summary: "", size: "small", project_id: null },
  });
  const otherWorkId = other.data.work_id;
  const otherResponse = await request(`/works/${otherWorkId}/designs/${taskId}`);
  assert.equal(otherResponse.status, 404);
  assert.equal((await otherResponse.json()).error.code, "design_document_not_found");
  assert.deepEqual((await (await request(`/works/${otherWorkId}/designs`)).json()).data.designs, []);

  await rm(documentPath);
  const missingResponse = await request(`/works/${workId}/designs/${taskId}`);
  assert.equal(missingResponse.status, 404);
  assert.equal((await missingResponse.json()).error.code, "design_document_not_found");
});

const MOCK_HTML = "<!doctype html><title>Top</title><script>document.title = 'ok'</script>";

async function mockFixture(t, wrap) {
  const { root, db, core: durableCore } = await createTestCore(t, { version: "api-design-mock-test" }, { prefix: "owl-api-mocks-" });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const core = wrap ? new ExternalCoreAdapter(durableCore, db, root, dataDir) : durableCore;
  const guardTokens = GuardTokenRegistry.open(join(root, "guard-tokens"));
  t.after(() => guardTokens.clear());
  const ownerToken = randomBytes(32).toString("hex");
  const api = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root, dataDir, guardTokens }, { token: ownerToken });
  if (!api) return null;
  const createWork = async (key) => (await durableCore.createWork({
    request_id: randomUUID(), idempotency_key: key, expected_version: 0,
    payload: { title: key, summary: "", size: "small", project_id: null },
  })).data.work_id;
  const workId = await createWork("api-mocks:work");
  const otherWorkId = await createWork("api-mocks:other");
  const now = new Date().toISOString();
  const ids = { screenTask: createUlid(), codeTask: createUlid(), screenRun: createUlid(), codeRun: createUlid(), workerRun: createUlid() };
  await db.createWriteLane().transact((tx) => {
    const task = (id, type, designer) => tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, assigned_designer, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', 'normal', '', '', ?, ?, ?)`,
      id, workId, `Task ${type}`, type, designer, now, now,
    );
    task(ids.screenTask, "design", "lead_designer");
    task(ids.codeTask, "code", null);
    for (const [id, taskId, role] of [[ids.screenRun, ids.screenTask, "designer"], [ids.codeRun, ids.codeTask, "designer"], [ids.workerRun, ids.screenTask, "worker"]]) {
      tx.run(
        `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'claude', 'test-model', 'running', ?, ?)`,
        id, workId, taskId, role, now, now,
      );
    }
  });
  const tokenFor = async (agentRunId, role) => {
    const lease = guardTokens.issue({ agent_run_id: agentRunId, role });
    return (await readFile(lease.file, "utf8")).trim();
  };
  const post = (route, token, payload) => fetch(`${api.baseUrl}/api/v1${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ request_id: randomUUID(), idempotency_key: randomUUID(), expected_version: 0, payload }),
  });
  return { api, workId, otherWorkId, ids, tokenFor, post, get: (path) => api.request("GET", `/api/v1${path}`) };
}

for (const [label, wrap] of [["the Core itself", false], ["an ExternalCoreAdapter-wrapped Core", true]]) {
  test(`design mock APIs save, list and serve through ${label}`, async (t) => {
    const fx = await mockFixture(t, wrap);
    if (!fx) return t.skip("localhost listen is unavailable");
    const { ids, workId } = fx;
    const designerToken = await fx.tokenFor(ids.screenRun, "designer");

    const saved = await fx.post("/agent/design-mocks", designerToken, { name: "top.html", html: MOCK_HTML });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).data.size_bytes, Buffer.byteLength(MOCK_HTML));

    const listed = (await (await fx.get(`/works/${workId}/design-mocks`)).json()).data.mocks;
    assert.deepEqual(listed.map(({ task_id, name, size_bytes }) => ({ task_id, name, size_bytes })), [
      { task_id: ids.screenTask, name: "top.html", size_bytes: Buffer.byteLength(MOCK_HTML) },
    ]);

    const served = await fx.get(`/works/${workId}/design-mocks/${ids.screenTask}/top.html`);
    assert.equal(served.status, 200);
    assert.equal(await served.text(), MOCK_HTML);
    assert.equal(served.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(served.headers.get("content-security-policy"), /sandbox allow-scripts/u);
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
    assert.equal(served.headers.get("cache-control"), "no-store");

    for (const path of [
      `/works/${workId}/design-mocks/${ids.screenTask}/Bad_Name.html`,
      `/works/${workId}/design-mocks/${ids.screenTask}/..%2Ftop.html`,
      `/works/${fx.otherWorkId}/design-mocks/${ids.screenTask}/top.html`,
      `/works/${workId}/design-mocks/${ids.codeTask}/top.html`,
      `/works/${workId}/design-mocks/${ids.screenTask}/missing.html`,
    ]) {
      const response = await fx.get(path);
      assert.equal(response.status, 404, path);
      assert.equal((await response.json()).error.code, "design_mock_not_found", path);
    }

    assert.equal((await fx.post("/agent/design-mocks", await fx.tokenFor(ids.workerRun, "worker"), { name: "top.html", html: MOCK_HTML })).status, 403);
    assert.equal((await fx.post("/agent/design-mocks", await fx.tokenFor(ids.codeRun, "designer"), { name: "top.html", html: MOCK_HTML })).status, 403);
    assert.equal((await fx.post("/agent/design-mocks", designerToken, { name: "Bad Name.html", html: MOCK_HTML })).status, 400);

    const deleted = await fx.post("/agent/design-mocks/delete", designerToken, { name: "top.html" });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).data.deleted, true);
    assert.deepEqual((await (await fx.get(`/works/${workId}/design-mocks`)).json()).data.mocks, []);
  });
}

test("design mock APIs answer 503 when the Core lacks the methods", async (t) => {
  const { root } = await createTestCore(t, {}, { prefix: "owl-api-mocks-503-" });
  const guardTokens = GuardTokenRegistry.open(join(root, "guard-tokens"));
  t.after(() => guardTokens.clear());
  const api = await startTestHttpServer(t, { core: createMemoryCore({ version: "1.0.0" }), owlRoot: root, webOut: root, guardTokens }, { token: "owner-token" });
  if (!api) return t.skip("localhost listen is unavailable");
  const lease = guardTokens.issue({ agent_run_id: createUlid(), role: "designer" });
  const designerToken = (await readFile(lease.file, "utf8")).trim();
  const list = await api.request("GET", `/api/v1/works/${createUlid()}/design-mocks`);
  assert.equal(list.status, 503);
  const save = await fetch(`${api.baseUrl}/api/v1/agent/design-mocks`, {
    method: "POST",
    headers: { authorization: `Bearer ${designerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ request_id: randomUUID(), idempotency_key: "k", expected_version: 0, payload: { name: "top.html", html: "<p>x</p>" } }),
  });
  assert.equal(save.status, 503);
});
