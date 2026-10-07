import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Core } from "../../../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../../../packages/db/dist/index.js";
import { ExternalCoreAdapter } from "../dist/core.js";
import { createOwlHttpServer } from "../dist/http.js";

const repoRoot = join(import.meta.dirname, "../../..");

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-memory-settings-http-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const agentRunner = { runManagerPlan: async () => ({ outcome: "failed" }), runWorker: async () => ({ outcome: "failed" }), runReviewer: async () => ({ outcome: "failed" }), runAdvisor: async () => ({ reply: "" }) };
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, dataDir: join(root, "data") });
  core.memory = { stop: async () => {}, notifyChanged: () => {} };
  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  const prior = process.env.OWL_API_TOKEN;
  process.env.OWL_API_TOKEN = "settings-token";
  const http = createOwlHttpServer({ core: adapter, webOut: root, bind: "127.0.0.1", port: 0, contract: { contract_version: "1.0.0" }, owlRoot: root });
  t.after(async () => {
    await http.close().catch(() => {});
    if (prior === undefined) delete process.env.OWL_API_TOKEN; else process.env.OWL_API_TOKEN = prior;
    await core.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  try { await http.listen(); } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("listen not permitted"); return null; }
    throw error;
  }
  const origin = `http://127.0.0.1:${http.server.address().port}`;
  const headers = { authorization: "Bearer settings-token", "content-type": "application/json" };
  return {
    db,
    get: () => fetch(`${origin}/api/v1/settings/memory`, { headers }),
    put: (payload) => fetch(`${origin}/api/v1/settings/memory`, {
      method: "PUT", headers, body: JSON.stringify({ request_id: createUlid(), idempotency_key: `memory-settings:${createUlid()}`, expected_version: 0, payload }),
    }),
  };
}

const folderKinds = { version: 1, rules: [{ glob: "clips/**", type: "clipping", links: "optional" }, { glob: "journal/**", type: "work-log" }] };

test("PUT /api/v1/settings/memory saves folder kinds and GET reads them back; memory_mode defaults to pages", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const before = await (await api.get()).json();
  assert.equal(before.data.mode, "pages");
  const put = await api.put({ folder_kinds: folderKinds });
  assert.equal(put.status, 200);
  const after = await (await api.get()).json();
  assert.deepEqual(after.data.folder_kinds, folderKinds);
  assert.equal(after.data.mode, "pages");
});

test("memory_librarian defaults to haiku/low, is saved by PUT, and invalid values give 400", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const haiku = { provider: "anthropic", model: "claude-haiku-4-5-20251001", effort: "low" };
  assert.deepEqual((await (await api.get()).json()).data.memory_librarian, haiku);
  const chosen = { provider: "codex", model: "gpt-5.6-luna", effort: "medium" };
  const put = await api.put({ memory_librarian: chosen });
  assert.equal(put.status, 200);
  assert.deepEqual((await put.json()).data.memory_librarian, chosen);
  assert.deepEqual((await (await api.get()).json()).data.memory_librarian, chosen);
  for (const payload of [
    {},
    { memory_librarian: "haiku" },
    { memory_librarian: { provider: "nope", model: "m", effort: "low" } },
    { memory_librarian: { provider: "anthropic", model: "", effort: "low" } },
    { memory_librarian: { provider: "anthropic", model: "m", effort: "ultra" } },
    { memory_librarian: { ...chosen, extra: 1 } },
    { memory_librarian: chosen, memory_mode: "pages" },
  ]) {
    assert.equal((await api.put(payload)).status, 400, JSON.stringify(payload));
  }
  const after = await (await api.get()).json();
  assert.deepEqual(after.data.memory_librarian, chosen);
  assert.equal(after.data.mode, "pages");
});

test("PUT /api/v1/settings/memory rejects an invalid or unwritable memory_mode and invalid folder kinds with 4xx", async (t) => {
  const api = await setup(t);
  if (!api) return;
  for (const payload of [
    { memory_mode: "bogus" },
    { memory_mode: "pages" },
    { folder_kinds: folderKinds, memory_mode: "pages" },
    { folder_kinds: { version: 1, rules: [{ glob: "/abs/**", type: "clipping" }] } },
    { folder_kinds: { version: 1, rules: [{ glob: "a/**", type: "theme" }] } },
    { folder_kinds: "clipping" },
  ]) {
    const response = await api.put(payload);
    assert.ok(response.status >= 400 && response.status < 500, `${JSON.stringify(payload)} -> ${response.status}`);
  }
  const after = await (await api.get()).json();
  assert.equal(after.data.mode, "pages");
  assert.equal(after.data.folder_kinds.rules.length, 2);
});

test("a database that stores memory_mode legacy runs as pages", async (t) => {
  const api = await setup(t);
  if (!api) return;
  await api.db.createWriteLane().transact((tx) => {
    const now = new Date().toISOString();
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('memory_mode', 'owner:default', '1.0.0', ?, ?)", JSON.stringify("legacy"), now);
  });
  const stored = api.db.get("SELECT value_json FROM settings WHERE key = 'memory_mode'");
  assert.equal(JSON.parse(stored.value_json), "legacy");
  assert.equal((await (await api.get()).json()).data.mode, "pages");
});
