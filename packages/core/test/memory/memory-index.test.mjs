import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { MemoryIndex, MEMORY_INDEX_FILE } from "../../dist/memory/memory-index.js";
import { MemorySearch } from "../../dist/memory/memory-search.js";
import { MemoryService } from "../../dist/memory/memory-service.js";
import { inferMemoryType, memoryIdForPath } from "../../dist/memory/memory-note-reader.js";

const ID_A = "01HZZZZZZZZZZZZZZZZZZZZZZA";

function setup(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "owl-memory-test-"));
  const vault = join(root, "vault");
  const dataDir = join(root, "data");
  mkdirSync(vault, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const state = { available: true, dir: vault };
  const storage = {
    isAvailable: () => state.available,
    activeDir: () => {
      if (!state.available) throw Object.assign(new Error("unavailable"), { code: "knowledge_storage_unavailable" });
      return state.dir;
    },
    withRead: async (op) => {
      if (!state.available) throw Object.assign(new Error("unavailable"), { code: "knowledge_storage_unavailable" });
      return op();
    },
    status: () => ({ available: state.available, dir: state.available ? state.dir : null, since: null }),
  };
  const write = (rel, text) => {
    mkdirSync(dirname(join(vault, rel)), { recursive: true });
    writeFileSync(join(vault, rel), text);
  };
  const note = (rel, title, body, tags = []) =>
    write(rel, `---\ntitle: ${title}\ntags: [${tags.join(", ")}]\n---\n${body}\n`);
  const make = (opts = {}) => new MemoryIndex({ dataDir, storage, watch: false, notifyDebounceMs: 20, ...extra, ...opts });
  const search = (index) => new MemorySearch({ index, embedder: { enabled: false } });
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, vault, dataDir, state, storage, write, note, make, search, cleanup };
}

const titles = async (s, query, extra = {}) => (await s.search({ query, include_raw: true, ...extra })).hits.map((h) => h.row.title);
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test("notes without an id get a path: id", async (tc) => {
  assert.equal(memoryIdForPath("global/a.md"), "path:global/a.md");
  const t = setup();
  try {
    t.note("global/legacy.md", "Legacy", "古い形式のノート");
    const index = t.make();
    await index.start();
    tc.after(() => index.stop());
    await index.rebuild("manual");
    assert.equal(index.resolveNoteRef("path:global/legacy.md").match?.path, "global/legacy.md");
    await index.stop();
  } finally { t.cleanup(); }
});

test("trigram search finds mid-word substrings", async (tc) => {
  const t = setup();
  try {
    t.note("global/a.md", "Deployment pipeline", "continuous integration setup");
    t.note("global/b.md", "Cooking", "pasta recipe");
    const index = t.make();
    await index.start();
    tc.after(() => index.stop());
    await index.rebuild("manual");
    assert.deepEqual(await titles(t.search(index), "ployme"), ["Deployment pipeline"]);
    await index.stop();
  } finally { t.cleanup(); }
});

test("hiragana-only trigrams are excluded from matching", async (tc) => {
  const t = setup();
  try {
    t.note("global/a.md", "雑談", "これはそれです");
    t.note("global/b.md", "設計", "データベース設計の方針");
    const index = t.make();
    await index.start();
    tc.after(() => index.stop());
    await index.rebuild("manual");
    const s = t.search(index);
    assert.deepEqual(await titles(s, "これはそれですか"), []);
    assert.deepEqual(await titles(s, "データベース設計"), ["設計"]);
    await index.stop();
  } finally { t.cleanup(); }
});

test("an exact phrase outranks a scattered match", async (tc) => {
  const t = setup();
  try {
    t.note("global/scatter.md", "Scatter", "ingest the queue and later retry worker jobs");
    t.note("global/phrase.md", "Phrase", "the retry worker handles failures");
    const index = t.make();
    await index.start();
    tc.after(() => index.stop());
    await index.rebuild("manual");
    const result = await titles(t.search(index), '"retry worker"');
    assert.equal(result[0], "Phrase");
    await index.stop();
  } finally { t.cleanup(); }
});

test("terms of two characters or fewer match via LIKE on title/summary/tags", async (tc) => {
  const t = setup();
  try {
    t.note("global/a.md", "認証", "本文は無関係", ["db"]);
    t.note("global/b.md", "Other", "nothing here");
    const index = t.make();
    await index.start();
    tc.after(() => index.stop());
    await index.rebuild("manual");
    const s = t.search(index);
    assert.deepEqual(await titles(s, "認証"), ["認証"]);
    assert.deepEqual(await titles(s, "db"), ["認証"]);
    await index.stop();
  } finally { t.cleanup(); }
});

test("deleting the index and rebuilding yields the same note count", async (tc) => {
  const t = setup();
  try {
    for (let i = 0; i < 7; i += 1) t.note(`global/n${i}.md`, `Note ${i}`, `body number ${i} unique${i}token`);
    t.write("projects/p/old.md", "no frontmatter at all\n");
    const first = t.make();
    await first.start();
    tc.after(() => first.stop());
    await first.rebuild("manual");
    const count = first.status().notes;
    assert.equal(count, 8);
    await first.stop();
    for (const f of readdirSync(t.dataDir)) if (f.startsWith(MEMORY_INDEX_FILE)) unlinkSync(join(t.dataDir, f));
    const second = t.make();
    await second.start();
    tc.after(() => second.stop());
    await second.rebuild("manual");
    assert.equal(second.status().notes, count);
    await second.stop();
  } finally { t.cleanup(); }
});

test("write-path notification reaches the index within 5 seconds", async (tc) => {
  const t = setup();
  try {
    const index = t.make();
    await index.start();
    tc.after(() => index.stop());
    await index.rebuild("manual");
    t.note("global/fresh.md", "Fresh", "zebrafish migration plan");
    index.notifyChanged(["global/fresh.md"]);
    assert.ok(await waitFor(async () => (await titles(t.search(index), "zebrafish")).length === 1));
    await index.stop();
  } finally { t.cleanup(); }
});

test("direct vault edits are picked up by the watcher within 5 seconds", async (tc) => {
  const t = setup();
  try {
    const index = t.make({ watch: true, watchDebounceMs: 100 });
    await index.start();
    tc.after(() => index.stop());
    await index.rebuild("manual");
    t.note("global/direct.md", "Direct", "quokkaword appears");
    assert.ok(await waitFor(async () => (await titles(t.search(index), "quokkaword")).length === 1));
    unlinkSync(join(t.vault, "global/direct.md"));
    assert.ok(await waitFor(async () => (await titles(t.search(index), "quokkaword")).length === 0));
    await index.stop();
  } finally { t.cleanup(); }
});

test("disconnect serves the last index, reconnect diff re-indexes", async (tc) => {
  const t = setup();
  try {
    t.note("global/a.md", "Alpha", "persistent content");
    const index = t.make();
    await index.start();
    tc.after(() => index.stop());
    await index.rebuild("manual");
    const s = t.search(index);
    t.state.available = false;
    index.onStorageUnavailable();
    assert.deepEqual(await titles(s, "persistent"), ["Alpha"]);
    assert.equal(index.status().stale, true);
    t.state.available = true;
    t.note("global/b.md", "Beta", "added while away");
    await index.onStorageAvailable();
    assert.equal(index.status().stale, false);
    assert.deepEqual(await titles(s, "while away"), ["Beta"]);
    assert.equal(index.status().notes, 2);
    await index.stop();
  } finally { t.cleanup(); }
});

test("a corrupt index is renamed to .corrupt-<ts> and rebuilt", async (tc) => {
  const t = setup();
  try {
    t.note("global/a.md", "Alpha", "content");
    writeFileSync(join(t.dataDir, MEMORY_INDEX_FILE), "this is not a sqlite database".repeat(50));
    const index = t.make();
    await index.start();
    tc.after(() => index.stop());
    await index.rebuild("manual");
    assert.ok(readdirSync(t.dataDir).some((f) => f.startsWith(`${MEMORY_INDEX_FILE}.corrupt-`)));
    assert.equal(index.status().notes, 1);
    await index.stop();
  } finally { t.cleanup(); }
});

test("service health reports a disabled embedder and searchKnowledgeCompat gates on the first build", async (tc) => {
  const t = setup();
  try {
    t.note("global/a.md", "Alpha", "gamma delta", ["x"]);
    const service = new MemoryService({ dataDir: t.dataDir, storage: t.storage, indexOptions: { watch: false } });
    assert.equal(await service.searchKnowledgeCompat("gamma", []), null);
    await service.start();
    tc.after(() => service.stop());
    await service.reindex({ mode: "full" });
    const health = await service.health();
    assert.equal(health.embedder.state, "disabled");
    const results = await service.searchKnowledgeCompat("gamma", []);
    assert.equal(results?.length, 1);
    assert.equal(results[0].path, "global/a.md");
    await service.stop();
  } finally { t.cleanup(); }
});

test("ulid ids and [[ULID|alias]] links resolve through expand", async (tc) => {
  const t = setup();
  try {
    t.write("global/a.md", `---\nid: ${ID_A}\ntitle: Alpha\n---\nbody\n`);
    t.write("global/b.md", `---\ntitle: Beta\n---\nsee [[${ID_A}|alpha]]\n`);
    const service = new MemoryService({ dataDir: t.dataDir, storage: t.storage, indexOptions: { watch: false } });
    await service.start();
    tc.after(() => service.stop());
    await service.reindex({ mode: "full" });
    const out = await service.expand({ note: ID_A });
    assert.equal(out.found, true);
    assert.equal(out.linked_from.length, 1);
    await service.stop();
  } finally { t.cleanup(); }
});

test("OWL_MEMORY_RAW_PREFIXES adds raw prefixes: type raw and unresolved links not counted", async () => {
  const t = setup();
  const prev = process.env.OWL_MEMORY_RAW_PREFIXES;
  try {
    t.note("extra/a.md", "A", "[[no-such-note]]");
    t.note("research/b.md", "B", "[[no-such-note]]");
    t.note("plain/c.md", "C", "[[no-such-note]]");
    delete process.env.OWL_MEMORY_RAW_PREFIXES;
    assert.equal(inferMemoryType("research/b.md", {}, "").type, "raw");
    assert.notEqual(inferMemoryType("extra/a.md", {}, "").type, "raw");
    let index = t.make();
    await index.start();
    await index.rebuild("manual");
    assert.equal(index.status().unresolved_links, 2);
    await index.stop();
    process.env.OWL_MEMORY_RAW_PREFIXES = "extra/, other/";
    assert.equal(inferMemoryType("extra/a.md", {}, "").type, "raw");
    index = t.make();
    await index.start();
    await index.rebuild("manual");
    assert.equal(index.status().unresolved_links, 1);
    await index.stop();
  } finally {
    if (prev === undefined) delete process.env.OWL_MEMORY_RAW_PREFIXES; else process.env.OWL_MEMORY_RAW_PREFIXES = prev;
    t.cleanup();
  }
});
