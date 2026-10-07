import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { KnowledgeBase } from "../../packages/core/dist/knowledge-base.js";
import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

const token = "knowledge-policies-readonly-owner-token";

test("policies are read-only over HTTP while other knowledge folders remain writable", async (t) => {
  const root = await tempDir(t, "owl-knowledge-policies-readonly-");
  const webOut = join(root, ".web.out");
  await mkdir(webOut, { recursive: true });
  const { core: durableCore, db } = await createTestCore(t, {
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
  }, { start: true });
  const core = new ExternalCoreAdapter(durableCore, db, root, root);
  const api = await startTestHttpServer(t, { core, db, webOut, owlRoot: root }, { token });
  if (!api) return t.skip("localhost listen is unavailable");
  const request = (method, path, body) => api.request(method, `/api/v1${path}`, body);
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
    tags: [],
    body: "# 切り抜きの例\n\n## 出典\n- https://example.test/a\n\n## 要点\n- 要点\n\n## 関係する Project\n- （なし）\n",
    metadata: {
      id: createUlid(),
      type: "clipping",
      title: "切り抜きの例",
      source_url: "https://example.test/a",
      retrieved_at: "2026-10-04T00:00:00Z",
      retrieved_by: "external",
      summary: "例の要約",
    },
  });
  assert.equal(createResponse.status, 201, await createResponse.clone().text());
  assert.equal((await createResponse.json()).data.path, "global/new.md");
});
