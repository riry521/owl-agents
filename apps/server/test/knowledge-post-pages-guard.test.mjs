import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Core } from "../../../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../../../packages/db/dist/index.js";
import { ExternalCoreAdapter } from "../dist/core.js";
import { createOwlHttpServer } from "../dist/http.js";

const repoRoot = join(import.meta.dirname, "../../..");
const FOLDER = "research";

const CLIPPING = `---
id: ${createUlid()}
type: clipping
title: 切り抜きの例
source_url: https://example.test/a
retrieved_at: 2026-10-04T00:00:00Z
retrieved_by: external
summary: 例の要約
created: 2026-10-04
---

# 切り抜きの例

## 出典
- https://example.test/a

## 要点
- 要点

## 関係する Project
- （なし）
`;

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-kb-pages-guard-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const agentRunner = { runManagerPlan: async () => ({ outcome: "failed" }), runWorker: async () => ({ outcome: "failed" }), runReviewer: async () => ({ outcome: "failed" }), runAdvisor: async () => ({ reply: "" }) };
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root });
  core.memory = { stop: async () => {}, notifyChanged: () => {} };
  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  const priorToken = process.env.OWL_API_TOKEN;
  const priorData = process.env.OWL_DATA_DIR;
  process.env.OWL_API_TOKEN = "guard-token";
  process.env.OWL_DATA_DIR = join(root, "data");
  const http = createOwlHttpServer({ core: adapter, webOut: root, bind: "127.0.0.1", port: 0, contract: { contract_version: "1.0.0" }, owlRoot: root });
  t.after(async () => {
    await http.close().catch(() => {});
    if (priorToken === undefined) delete process.env.OWL_API_TOKEN; else process.env.OWL_API_TOKEN = priorToken;
    if (priorData === undefined) delete process.env.OWL_DATA_DIR; else process.env.OWL_DATA_DIR = priorData;
    await core.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  try { await http.listen(); } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("listen not permitted"); return null; }
    throw error;
  }
  const origin = `http://127.0.0.1:${http.server.address().port}`;
  const headers = { authorization: "Bearer guard-token", "content-type": "application/json" };
  return {
    post: (body) => fetch(`${origin}/api/v1/knowledge`, { method: "POST", headers, body: JSON.stringify({ folder: FOLDER, ...body }) }),
    put: (path, body) => fetch(`${origin}/api/v1/knowledge/${path}`, { method: "PUT", headers, body: JSON.stringify(body) }),
    file: (filename) => join(root, "knowledge", FOLDER, filename),
  };
}

const bodyOf = (text) => text.slice(text.indexOf("# 切り抜きの例"));

test("POST /knowledge refuses a page outside the templates with 422 and errors, and writes no file", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const res = await api.post({ filename: "free.md", tags: [], body: "テンプレートのない自由な文章\n" });
  assert.equal(res.status, 422);
  const json = await res.json();
  assert.ok(Array.isArray(json.error.details.errors) && json.error.details.errors.length > 0);
  assert.equal(existsSync(api.file("free.md")), false);
});

test("POST /knowledge writes a page that fits a template", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const { id, type, title, source_url, retrieved_at, retrieved_by, summary } = Object.fromEntries(
    CLIPPING.split("---")[1].trim().split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]),
  );
  const res = await api.post({
    filename: "clip.md", tags: [], body: bodyOf(CLIPPING),
    metadata: { id, type, title, source_url, retrieved_at, retrieved_by, summary },
  });
  assert.equal(res.status, 201, await res.clone().text());
  assert.match(await readFile(api.file("clip.md"), "utf8"), /type: clipping/u);
});

test("PUT /knowledge refuses a body that breaks the template and leaves the file as it was", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const fields = Object.fromEntries(CLIPPING.split("---")[1].trim().split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
  const { created: _created, ...metadata } = fields;
  assert.equal((await api.post({ filename: "clip.md", tags: [], body: bodyOf(CLIPPING), metadata })).status, 201);
  const before = await readFile(api.file("clip.md"), "utf8");
  const res = await api.put(`${FOLDER}/clip.md`, { body: "## 自由欄\n独自の形式\n" });
  assert.equal(res.status, 422);
  assert.equal(await readFile(api.file("clip.md"), "utf8"), before);
});
