import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Core } from "../../dist/index.js";
import { createUlid, openDatabase } from "../../../db/dist/index.js";
import { KnowledgeBase } from "../../dist/knowledge-base.js";
import { KnowledgeLocation, KNOWLEDGE_MARKER_FILE } from "../../dist/knowledge-location.js";
import { clippingText } from "./clipping-text.mjs";
import { clip } from "../../../../tests/helpers/seed-knowledge.mjs";
import { MemoryService } from "../../dist/memory/memory-service.js";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");

// Wired like Core (used by the disconnect/direct-edit tests): KnowledgeLocation -> MemoryService, KnowledgeBase writes notify the index,
// LearningPipeline's onNotesChanged is `() => memory.notifyChanged()`.
function setup() {
  const root = mkdtempSync(join(tmpdir(), "owl-memory-integration-"));
  const vault = join(root, "vault");
  const away = join(root, "vault-away");
  const dataDir = join(root, "data");
  mkdirSync(join(vault, "research"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(vault, KNOWLEDGE_MARKER_FILE), '{"format":1,"layout":"pages-v1"}\n');
  let raw = vault;
  const persistence = { read: () => raw, write: (v) => { raw = v; } };
  let memory;
  const location = new KnowledgeLocation({
    owlRoot: root,
    dataDir,
    persistence,
    onAvailable: () => memory?.onStorageAvailable(),
    onUnavailable: () => memory?.onStorageUnavailable(),
    onSwitched: () => { void memory?.onStorageSwitched(); },
  });
  memory = new MemoryService({
    dataDir,
    storage: {
      isAvailable: () => location.isAvailable(),
      activeDir: () => location.activeDir(),
      withRead: (op) => location.withRead(op),
      status: () => {
        const s = location.status();
        return { available: s.state !== "unavailable", dir: s.path, since: s.state === "unavailable" ? s.checked_at : null };
      },
    },
    indexOptions: { notifyDebounceMs: 20 },
  });
  const kb = new KnowledgeBase(root, {
    rootDir: () => location.activeDir(),
    requireRoot: () => location.hasEverBeenAvailable(),
    searcher: (q, tags) => memory.searchKnowledgeCompat(q, tags),
  });
  const note = (rel, title, body, dir = vault) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), clippingText(title, body));
  };
  const titles = async (query) => (await memory.search({ query, include_raw: true })).items.map((i) => i.title);
  const waitTitles = async (query, pred, ms = 5000) => {
    const end = Date.now() + ms;
    let last = [];
    while (Date.now() < end) {
      last = await titles(query).catch(() => []);
      if (pred(last)) return last;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`timed out waiting for index (${query}); last=${JSON.stringify(last)}`);
  };
  const stop = async () => {
    await location.stop().catch(() => undefined);
    await memory.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  };
  return { vault, away, location, memory, kb, note, titles, waitTitles, stop };
}

async function started() {
  const t = setup();
  try {
    await t.location.initialize();
    await t.memory.start();
  } catch (error) {
    await t.stop();
    throw error;
  }
  return t;
}

// Real Core wiring: temp owlRoot (vault = <root>/knowledge) and temp OWL_DATA_DIR (<root>/data).
async function realCore(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-memory-core-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const agentRunner = { runManagerPlan: async () => ({ outcome: "failed" }), runWorker: async () => ({ outcome: "failed" }), runReviewer: async () => ({ outcome: "failed" }), runAdvisor: async () => ({ reply: "" }) };
  const core = new Core({ db, agentRunner, version: "t", owlRoot: root, dataDir: join(root, "data") });
  t.after(async () => { await core.stop({ force: true }); db.close(); await rm(root, { recursive: true, force: true }); });
  await core.start();
  const waitFound = async (query, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if ((await core.memory.search({ query, include_raw: true })).items.length > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`not indexed within ${ms}ms: ${query}`);
  };
  return { core, db, waitFound };
}

test("KnowledgeBase save path is searchable within 5s", async (t) => {
  const { core, waitFound } = await realCore(t);
  await core.knowledge.create({ folder: "research", filename: "kb-saved.md", tags: [], ...clip("zebrafish-kb-marker") });
  await waitFound("zebrafish-kb-marker");
});

test("LearningPipeline onNotesChanged hook is reflected within 5s", async (t) => {
  const { core, db, waitFound } = await realCore(t);
  const now = new Date().toISOString();
  const workId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(`INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
      VALUES (?, 'owner:default', NULL, 'Learning', 'x', 'normal', 'completed', '[]', '[]', ?, ?)`, workId, now, now);
  });
  await core.learningJobs.enqueue(workId, null, null, [{
    lesson: "narwhal-learning-marker is needed", basis: "Observed", applies_to: "future Work", kind: "fact",
    topic: "narwhal topic", keywords: ["narwhal", "learning", "marker"],
  }]);
  await core.learningPipeline.processPending();
  await waitFound("narwhal-learning-marker");
});

test("direct vault add, modify and delete are reflected within 5s", async () => {
  const t = await started();
  try {
    t.note("research/direct.md", "Direct note", "axolotl-first-body");
    await t.waitTitles("axolotl-first-body", (r) => r.includes("Direct note"));
    t.note("research/direct.md", "Direct note", "platypus-second-body");
    await t.waitTitles("platypus-second-body", (r) => r.includes("Direct note"));
    await t.waitTitles("axolotl-first-body", (r) => r.length === 0);
    unlinkSync(join(t.vault, "research/direct.md"));
    await t.waitTitles("platypus-second-body", (r) => r.length === 0);
  } finally { await t.stop(); }
});

test("disconnected vault: last index answers, reconnect re-indexes the diff", async () => {
  const t = await started();
  try {
    t.note("research/keep.md", "Keep note", "capybara-keep-body");
    t.note("research/gone.md", "Gone note", "okapi-gone-body");
    await t.waitTitles("capybara-keep-body", (r) => r.length > 0);
    await t.waitTitles("okapi-gone-body", (r) => r.length > 0);

    renameSync(t.vault, t.away);
    await t.location.check();
    assert.equal(t.location.isAvailable(), false);
    assert.deepEqual(await t.titles("capybara-keep-body"), ["Keep note"]);
    assert.deepEqual(await t.titles("okapi-gone-body"), ["Gone note"]);

    // changes made while disconnected
    t.note("research/new.md", "New note", "manatee-new-body", t.away);
    unlinkSync(join(t.away, "research/gone.md"));
    assert.deepEqual(await t.titles("manatee-new-body"), []);

    renameSync(t.away, t.vault);
    await t.location.check();
    assert.equal(t.location.isAvailable(), true);
    await t.waitTitles("manatee-new-body", (r) => r.includes("New note"));
    await t.waitTitles("okapi-gone-body", (r) => r.length === 0);
    assert.deepEqual(await t.titles("capybara-keep-body"), ["Keep note"]);
  } finally { await t.stop(); }
});
