import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createOwlHttpServer } from "../apps/server/dist/http.js";
import { ExternalCoreAdapter } from "../apps/server/dist/core.js";
import { Core } from "../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("design document APIs list available documents, return Markdown, and 404 for missing content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-api-designs-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const durableCore = new Core({ db, agentRunner: {}, version: "api-design-contract-test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  const core = new ExternalCoreAdapter(durableCore, db, root, dataDir);
  const originalToken = process.env.OWL_API_TOKEN;
  const token = randomBytes(32).toString("hex");
  process.env.OWL_API_TOKEN = token;
  const http = createOwlHttpServer({
    core, db, webOut: root, bind: "127.0.0.1", port: 0,
    contract: { contract_version: "1.0.0" }, owlRoot: root, dataDir,
  });
  t.after(async () => {
    if (http.server.listening) await http.close();
    await durableCore.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
    if (originalToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = originalToken;
  });
  await http.listen();
  const base = `http://127.0.0.1:${http.server.address().port}/api/v1`;
  const request = (path) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });

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
