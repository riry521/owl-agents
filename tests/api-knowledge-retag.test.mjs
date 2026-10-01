import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { KnowledgeNotes } from "../packages/core/dist/knowledge-notes.js";
import { openDatabase } from "../packages/db/dist/index.js";
import { ExternalCoreAdapter } from "../apps/server/dist/core.js";
import { createOwlHttpServer } from "../apps/server/dist/http.js";

const repoRoot = process.cwd();

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-api-retag-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const gate = { release: null, calls: 0 };
  const agentRunner = {
    runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
    runKeywordExtraction: async ({ items }) => {
      gate.calls += 1;
      if (gate.hold) await new Promise((resolve) => { gate.release = resolve; });
      return { ok: true, items: items.map((item) => ({ id: item.id, keywords: ["canary", "検出", "誤検知"] })) };
    },
  };
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root });
  await core.knowledge.ensureDirectories();
  const notes = new KnowledgeNotes(core.knowledge);
  const note = await notes.mergeClaim({ topic: "Canary detection", kind: "fact", text: "Canary checks catch false positives.", work_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", project_id: null, tags: [] });
  await notes.setTags(note.note_id, ["alpha", "beta", "gamma"]);
  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  const priorToken = process.env.OWL_API_TOKEN;
  process.env.OWL_API_TOKEN = "retag-token";
  const http = createOwlHttpServer({ core: adapter, webOut: root, bind: "127.0.0.1", port: 0, contract: { contract_version: "1.0.0" }, owlRoot: root });
  t.after(async () => {
    await http.close().catch(() => {});
    if (priorToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = priorToken;
    await core.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  try {
    await http.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("listen not permitted"); return null; }
    throw error;
  }
  const base = `http://127.0.0.1:${http.server.address().port}/api/v1`;
  let n = 0;
  const post = (payload, headers = {}) => {
    n += 1;
    return fetch(`${base}/knowledge/retag`, {
      method: "POST",
      headers: { authorization: "Bearer retag-token", "content-type": "application/json", ...headers },
      body: JSON.stringify({ request_id: `retag-${n}`, idempotency_key: `retag:${n}`, expected_version: 0, payload }),
    });
  };
  return { post, gate, notes, noteId: note.note_id, core, adapter };
}

test("POST /knowledge/retag runs through the adapter-wrapped Core and validates the payload", async (t) => {
  const api = await setup(t);
  if (!api) return;

  for (const payload of [{}, { dry_run: "yes" }, { dry_run: true, force: 1 }, { dry_run: true, extra: 1 }]) {
    assert.equal((await api.post(payload)).status, 400, JSON.stringify(payload));
  }
  assert.equal((await api.post({ dry_run: true }, { authorization: "Bearer wrong" })).status, 401);

  const dry = await api.post({ dry_run: true });
  assert.equal(dry.status, 200);
  const dryReport = (await dry.json()).data;
  assert.equal(dryReport.dry_run, true);
  assert.equal(dryReport.targeted, 1);
  assert.equal(dryReport.backup_path, null);
  assert.deepEqual((await api.notes.get(api.noteId)).tags, ["alpha", "beta", "gamma"]);

  const run = await api.post({ dry_run: false });
  assert.equal(run.status, 200);
  const report = (await run.json()).data;
  assert.equal(report.changes.length, 1);
  assert.ok(report.backup_path);
  const note = await api.notes.get(api.noteId);
  assert.deepEqual(note.tags, ["canary", "検出", "誤検知"]);
  assert.equal(note.tags_source, "keywords");

  const again = (await (await api.post({ dry_run: false })).json()).data;
  assert.equal(again.targeted, 0);
  assert.equal(again.backup_path, null);
  const forced = (await (await api.post({ dry_run: true, force: true })).json()).data;
  assert.equal(forced.targeted, 1);
});

test("POST /knowledge/retag answers 409 retag_in_progress while a run is active", async (t) => {
  const api = await setup(t);
  if (!api) return;
  api.gate.hold = true;
  const first = api.post({ dry_run: true });
  while (api.gate.release === null) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await api.post({ dry_run: true });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, "retag_in_progress");
  api.gate.release();
  assert.equal((await first).status, 200);
});

test("ExternalCoreAdapter delegates retagKnowledgeNotes to the wrapped Core", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const calls = [];
  api.core.retagKnowledgeNotes = async (input) => { calls.push(input); return { delegated: true }; };
  assert.deepEqual(await api.adapter.retagKnowledgeNotes({ dry_run: true, force: true }), { delegated: true });
  assert.deepEqual(calls, [{ dry_run: true, force: true }]);
});
