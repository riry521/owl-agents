import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import test from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
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
