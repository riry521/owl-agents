import { clip } from "../helpers/seed-knowledge.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

test("HTTP knowledge follows Core storage changes and availability without affecting Works", async (t) => {
  const root = await tempDir(t, "owl-knowledge-storage-http-");
  const dataDir = join(root, "data");
  const webOut = join(root, "web");
  await mkdir(dataDir, { recursive: true });
  await mkdir(webOut, { recursive: true });
  const stored = { value: "" };
  const { core, db } = await createTestCore(t, {
    agentRunner: {},
    version: "knowledge-storage-http-test",
    owlRoot: root,
    dataDir,
    knowledgeStorage: {
      read: () => stored.value,
      write: (value) => { stored.value = value; },
    },
  });
  const adapter = new ExternalCoreAdapter(core, db, root, dataDir);
  const token = randomBytes(32).toString("hex");

  await core.start();
  const first = await core.knowledge.create({
    folder: "global",
    filename: "before-switch.md",
    tags: ["storage"],
    ...clip("this note moved with Core"),
  });
  const api = await startTestHttpServer(t, { core: adapter, db, webOut, owlRoot: root, dataDir }, { token });
  if (!api) return t.skip("localhost listen is unavailable");
  const request = (path, { method = "GET", body } = {}) => api.request(method, `/api/v1${path}`, body);

  const defaultKnowledge = join(root, "knowledge");
  const detachedDefault = join(root, "detached-default-knowledge");
  await rename(defaultKnowledge, detachedDefault);
  const defaultUnavailable = await request("/knowledge");
  assert.equal(defaultUnavailable.status, 503);
  assert.equal((await defaultUnavailable.json()).error.code, "knowledge_storage_unavailable");
  assert.equal(core.getKnowledgeStorage().state, "unavailable");
  await assert.rejects(stat(defaultKnowledge), { code: "ENOENT" });
  await rename(detachedDefault, defaultKnowledge);
  assert.equal((await core.checkKnowledgeStorage()).state, "available");

  const storagePath = join(root, "custom-knowledge-store");
  await core.moveKnowledgeStorage({ path: storagePath });
  const afterSwitch = await request("/knowledge");
  assert.equal(afterSwitch.status, 200);
  assert.ok((await afterSwitch.json()).data.some((entry) => entry.path === first.path));

  const disconnectedPath = join(root, "disconnected-knowledge-store");
  await rename(storagePath, disconnectedPath);
  const unavailable = await request("/knowledge");
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "knowledge_storage_unavailable");
  assert.equal(core.getKnowledgeStorage().state, "unavailable");
  await assert.rejects(stat(storagePath), { code: "ENOENT" });

  const work = await request("/works", {
    method: "POST",
    body: {
      request_id: createUlid(),
      idempotency_key: `knowledge-storage-http:${createUlid()}`,
      expected_version: 0,
      payload: { title: "Work during storage outage", summary: "still available", size: "small", project_id: null },
    },
  });
  assert.equal(work.status, 201);
  assert.ok((await work.json()).data.work_id);

  await rename(disconnectedPath, storagePath);
  assert.equal((await core.checkKnowledgeStorage()).state, "available");
  const recovered = await request("/knowledge");
  assert.equal(recovered.status, 200);
  assert.ok((await recovered.json()).data.some((entry) => entry.path === first.path));
});
