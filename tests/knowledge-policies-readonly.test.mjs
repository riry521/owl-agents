import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../packages/db/dist/index.js";
import { Core } from "../packages/core/dist/index.js";
import { KnowledgeBase } from "../packages/core/dist/knowledge-base.js";
import { ExternalCoreAdapter } from "../apps/server/dist/core.js";
import { createOwlHttpServer } from "../apps/server/dist/http.js";

const migrations = join(process.cwd(), "packages/db/migrations");
const token = "knowledge-policies-readonly-owner-token";

test("policies are read-only over HTTP while other knowledge folders remain writable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-knowledge-policies-readonly-"));
  const webOut = join(root, ".web.out");
  await mkdir(webOut, { recursive: true });
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const durableCore = new Core({
    db,
    agentRunner: {
      runManagerPlan: async () => ({ outcome: "failed" }),
      runWorker: async () => ({ outcome: "failed" }),
      runReviewer: async () => ({ outcome: "failed" }),
      runAdvisor: async () => ({ reply: "" }),
      runCurator: async () => ({ ok: false, error: "curator_unavailable" }),
    },
    version: "test",
    owlRoot: root,
    dataDir: root,
  });
  await durableCore.start();
  const core = new ExternalCoreAdapter(durableCore, db, root, root);
  const http = createOwlHttpServer({
    core,
    db,
    webOut,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot: root,
  });
  const previousToken = process.env.OWL_API_TOKEN;
  process.env.OWL_API_TOKEN = token;
  t.after(async () => {
    await http.close().catch(() => undefined);
    await durableCore.stop({ force: true }).catch(() => undefined);
    db.close();
    if (previousToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  });
  await http.listen();

  const base = `http://127.0.0.1:${http.server.address().port}/api/v1`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const request = (method, path, body) => fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const knowledge = new KnowledgeBase(root);
  const legacyEntry = await knowledge.create({
    folder: "policies",
    filename: "legacy.md",
    tags: [],
    body: "移行済みポリシー本文",
  });

  const listResponse = await request("GET", "/knowledge?folder=policies");
  assert.equal(listResponse.status, 200);
  assert.ok((await listResponse.json()).data.some((entry) => entry.path === legacyEntry.path));

  const getResponse = await request("GET", `/knowledge/${encodeURIComponent(legacyEntry.path)}`);
  assert.equal(getResponse.status, 200);
  assert.equal((await getResponse.json()).data.body.trim(), "移行済みポリシー本文");

  for (const [method, path, body] of [
    ["POST", "/knowledge", { folder: "policies/archive", filename: "new.md", body: "禁止" }],
    ["PUT", `/knowledge/${encodeURIComponent(legacyEntry.path)}`, { body: "更新禁止" }],
    ["DELETE", `/knowledge/${encodeURIComponent(legacyEntry.path)}`],
  ]) {
    const response = await request(method, path, body);
    assert.equal(response.status, 400, `${method} ${path} should be rejected`);
    const result = await response.json();
    assert.equal(result.error.code, "validation_error");
    assert.match(result.error.message, /移行済み/u);
    assert.match(result.error.message, /読み取り専用/u);
  }

  const createResponse = await request("POST", "/knowledge", {
    folder: "global",
    filename: "new.md",
    body: "通常フォルダへの作成",
  });
  assert.equal(createResponse.status, 201);
  assert.equal((await createResponse.json()).data.path, "global/new.md");
});
