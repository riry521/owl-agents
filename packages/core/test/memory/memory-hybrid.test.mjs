import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clippingText } from "./clipping-text.mjs";
import { ChildEmbedder, DEFAULT_EMBEDDER_CONFIG } from "../../dist/memory/embedder.js";
import { MemoryService } from "../../dist/memory/memory-service.js";
import { fuseRrf } from "../../dist/memory/memory-search.js";
import { chunkNote } from "../../dist/memory/memory-vectors.js";

const PLAIN = { chunkChars: 1500, maxChunks: 20, prefix: false, headVec: 0 };
const FAKE = new URL("./fixtures/fake-embedder-child.cjs", import.meta.url).pathname;
const MISSING_DEPS = new URL("./fixtures/missing-embedder-deps-child.cjs", import.meta.url).pathname;

test("weighted RRF with k=60 gives fixed scores", () => {
  const scores = fuseRrf([{ weight: 1, ids: [10, 20, 30] }, { weight: 2, ids: [20, 40] }]);
  const close = (id, expected) => assert.ok(Math.abs(scores.get(id) - expected) < 1e-12, `${id}: ${scores.get(id)} vs ${expected}`);
  close(10, 1 / 61);
  close(20, 1 / 62 + 2 / 61);
  close(30, 1 / 63);
  close(40, 2 / 62);
  assert.equal(scores.size, 4);
});

test("chunks: heading-delimited chunks of at most 1500 chars, the first led by title and summary", () => {
  assert.equal(chunkNote("T", "S", "short", PLAIN).length, 1);
  const body = `# A\n${"あ".repeat(1200)}\n# B\n${"い".repeat(1200)}\n# C\n${"う".repeat(3000)}`;
  const chunks = chunkNote("T", "S", body, PLAIN);
  assert.ok(chunks[0].startsWith("T\nS\n# A") && !chunks[0].includes("# B"));
  assert.ok(chunks.length >= 4);
  for (const chunk of chunks) assert.ok(chunk.length <= 1500 + "T\nS\n".length, `chunk of ${chunk.length}`);
});

function makeService(embedderOverrides) {
  const root = mkdtempSync(join(tmpdir(), "owl-hybrid-"));
  const vault = join(root, "vault");
  const dataDir = join(root, "data");
  mkdirSync(join(vault, "research"), { recursive: true });
  mkdirSync(join(root, "models", "fake-model"), { recursive: true });
  writeFileSync(join(root, "models", "fake-model", "config.json"), "{}");
  mkdirSync(dataDir);
  writeFileSync(join(vault, "research", "a.md"), clippingText("Orchard", "the apple harvest was good"));
  writeFileSync(join(vault, "research", "b.md"), clippingText("Garage", "the car needs new tires"));
  const embedder = new ChildEmbedder({ ...DEFAULT_EMBEDDER_CONFIG, enabled: true, model: "fake-model", modelsDirs: [join(root, "models")], childPath: FAKE, ...embedderOverrides });
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const service = new MemoryService({ dataDir, storage, embedder, indexOptions: { watch: false } });
  return { root, service, embedder, done: async () => { await service.stop(); rmSync(root, { recursive: true, force: true }); } };
}

test("hybrid search finds a note by meaning that FTS alone misses, and records the weights in meta", async () => {
  const { service, done } = makeService();
  try {
    await service.start();
    await service.reindex({ mode: "full", embed: true });
    const out = await service.search({ query: "fruit", include_raw: true });
    assert.equal(out.mode, "hybrid");
    assert.equal(out.items[0].title, "Orchard");
    assert.equal(out.items[0].match, "vec");
    const meta = Object.fromEntries(service.index.db().prepare("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]));
    assert.equal(meta.embed_model, "fake-model");
    assert.equal(meta.rrf_w_fts, "1");
    assert.equal(meta.rrf_w_vec, "1");
  } finally {
    await done();
  }
});

test("missing model: search answers from FTS and health reports state missing with last_error", async () => {
  const { service, done } = makeService({ modelsDirs: [join(tmpdir(), "owl-no-models")] });
  try {
    await service.start();
    await service.reindex({ mode: "full" });
    const out = await service.search({ query: "apple", include_raw: true });
    assert.equal(out.mode, "fts");
    assert.deepEqual(out.items.map((i) => i.title), ["Orchard"]);
    const health = await service.health();
    assert.equal(health.embedder.state, "missing");
    assert.ok(health.embedder.last_error);
  } finally {
    await done();
  }
});

test("disabled embeddings keep service search on FTS and health reports the setting warning", async () => {
  let starts = 0;
  const { service, done } = makeService({ enabled: false, forkChild: (...args) => { starts += 1; return fork(...args); } });
  try {
    await service.start();
    await service.reindex({ mode: "full" });
    const out = await service.search({ query: "apple", include_raw: true });
    assert.equal(out.mode, "fts");
    assert.deepEqual(out.items.map((i) => i.title), ["Orchard"]);
    const health = await service.health();
    assert.equal(health.embedder.state, "disabled");
    assert.match(health.embedder.warning, /設定で無効/u);
    assert.match(health.embedder.warning, /memory_embeddings\.enabled/u);
    assert.equal(starts, 0);
  } finally {
    await done();
  }
});

test("child that cannot start: search answers from FTS and health reports state failed", async () => {
  const { service, done } = makeService({ childPath: join(tmpdir(), "owl-no-such-child.js") });
  try {
    await service.start();
    await service.reindex({ mode: "full" });
    const out = await service.search({ query: "apple", include_raw: true });
    assert.equal(out.mode, "fts");
    assert.deepEqual(out.items.map((i) => i.title), ["Orchard"]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const health = await service.health();
    assert.equal(health.embedder.state, "failed");
    assert.ok(health.embedder.last_error);
  } finally {
    await done();
  }
});

test("transformers import failure keeps search on FTS and health gives dependency, opt-in, and pull steps", async () => {
  const { service, embedder, done } = makeService({ childPath: MISSING_DEPS });
  try {
    await service.start();
    await service.reindex({ mode: "full" });
    await assert.rejects(embedder.embed("query", ["fictional orchard"]));
    await assert.rejects(embedder.embed("query", ["fictional orchard"]));
    const out = await service.search({ query: "apple", include_raw: true });
    assert.equal(out.mode, "fts");
    assert.deepEqual(out.items.map((i) => i.title), ["Orchard"]);
    const health = await service.health();
    assert.equal(health.embedder.state, "unavailable");
    assert.match(health.embedder.warning, /pnpm install/u);
    assert.match(health.embedder.warning, /memory_embeddings\.enabled/u);
    assert.match(health.embedder.warning, /node scripts\/memory-models\.mjs pull Xenova\/multilingual-e5-small/u);
  } finally {
    await done();
  }
});
