import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../apps/server/dist/core.js";
import { createOwlHttpServer } from "../apps/server/dist/http.js";
import { Core } from "../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const migrations = join(process.cwd(), "packages/db/migrations");

test("HTTP knowledge follows Core storage changes and availability without affecting Works", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-knowledge-storage-http-"));
  const dataDir = join(root, "data");
  const webOut = join(root, "web");
  await mkdir(dataDir, { recursive: true });
  await mkdir(webOut, { recursive: true });
  const db = openDatabase(join(dataDir, "owl.db"));
  db.migrate(migrations);
  const stored = { value: "" };
  const core = new Core({
    db,
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
  const previousToken = process.env.OWL_API_TOKEN;
  const token = randomBytes(32).toString("hex");
  process.env.OWL_API_TOKEN = token;
  let http;
  t.after(async () => {
    if (http?.server.listening) await http.close().catch(() => undefined);
    await core.stop({ force: true }).catch(() => undefined);
    db.close();
    await rm(root, { recursive: true, force: true });
    if (previousToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = previousToken;
  });

  await core.start();
  const first = await core.knowledge.create({
    folder: "global",
    filename: "before-switch.md",
    tags: ["storage"],
    body: "this note moved with Core",
  });
  http = createOwlHttpServer({
    core: adapter,
    db,
    webOut,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot: root,
    dataDir,
  });
  try {
    await http.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("localhost listen is not permitted in this environment");
      return;
    }
    throw error;
  }

  const base = `http://127.0.0.1:${http.server.address().port}/api/v1`;
  const request = (path, { method = "GET", body } = {}) => fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

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
