import { clippingText } from "./clipping-text.mjs";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChildEmbedder, DEFAULT_EMBEDDER_CONFIG, loadEmbedderConfig } from "../../dist/memory/embedder.js";
import { MemoryService } from "../../dist/memory/memory-service.js";

const src = (name) => readFileSync(new URL(`../../src/memory/${name}`, import.meta.url), "utf8");
const MISSING_TRANSFORMERS = new URL("./fixtures/missing-embedder-deps-child.cjs", import.meta.url).pathname;

function makeService(embedder) {
  const root = mkdtempSync(join(tmpdir(), "owl-optional-memory-"));
  const vault = join(root, "vault");
  const dataDir = join(root, "data");
  mkdirSync(join(vault, "research"), { recursive: true });
  mkdirSync(dataDir);
  writeFileSync(join(vault, "research", "sample.md"), clippingText("Apricot Notes", "fictional apricot orchard sample"));
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const service = new MemoryService({ dataDir, storage, ...(embedder ? { embedder } : {}), indexOptions: { watch: false } });
  return { root, service, done: async () => { await service.stop(); rmSync(root, { recursive: true, force: true }); } };
}

test("embedder-child imports transformers via a non-literal specifier so tsc needs no installed types", () => {
  const code = src("embedder-child.ts");
  assert.doesNotMatch(code, /import\(\s*["']@huggingface\/transformers["']\s*\)/u);
  assert.match(code, /import\(specifier\)/u);
  assert.match(code, /allowRemoteModels\s*=\s*false/u);
});

test("embedding is opt-in and OWL_MEMORY_EMBEDDINGS_ENABLED overrides the data-dir setting", () => {
  const root = mkdtempSync(join(tmpdir(), "owl-embed-config-"));
  try {
    assert.equal(loadEmbedderConfig(root, {}).enabled, false);
    writeFileSync(join(root, "memory-embedder.json"), JSON.stringify({ enabled: true }));
    assert.equal(loadEmbedderConfig(root, {}).enabled, true);
    assert.equal(loadEmbedderConfig(root, { OWL_MEMORY_EMBEDDINGS_ENABLED: "false" }).enabled, false);
    assert.equal(loadEmbedderConfig(root, { OWL_MEMORY_EMBEDDINGS_ENABLED: "true" }).enabled, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("disabled embeddings do not start a child or call fetch and explain the opt-in setting", async () => {
  const root = mkdtempSync(join(tmpdir(), "owl-disabled-embedder-"));
  const modelDir = join(root, "models", DEFAULT_EMBEDDER_CONFIG.model);
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(join(modelDir, "config.json"), "{}");
  let starts = 0;
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { fetches += 1; return originalFetch(...args); };
  const config = loadEmbedderConfig(root, {});
  const embedder = new ChildEmbedder({ ...config, modelsDirs: [join(root, "models")], forkChild: (...args) => { starts += 1; return fork(...args); } });
  try {
    embedder.warmup();
    await assert.rejects(embedder.embed("query", ["fictional sample"]));
    assert.equal(starts, 0);
    assert.equal(fetches, 0);
    assert.equal(embedder.health().state, "disabled");
    assert.match(embedder.health().warning, /設定で無効/u);
    assert.match(embedder.health().warning, /memory_embeddings\.enabled/u);
  } finally {
    globalThis.fetch = originalFetch;
    await embedder.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("enabled embeddings do not download a missing model and show the explicit pull command", async () => {
  const root = mkdtempSync(join(tmpdir(), "owl-no-embed-model-"));
  let starts = 0;
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { fetches += 1; return originalFetch(...args); };
  const embedder = new ChildEmbedder({
    ...DEFAULT_EMBEDDER_CONFIG, enabled: true, modelsDirs: [root],
    forkChild: (...args) => { starts += 1; return fork(...args); },
  });
  try {
    assert.equal(embedder.health().state, "missing");
    assert.match(embedder.health().warning, /node scripts\/memory-models\.mjs pull Xenova\/multilingual-e5-small/u);
    await assert.rejects(embedder.embed("query", ["fictional sample"]));
    assert.equal(starts, 0);
    assert.equal(fetches, 0);
    assert.equal(embedder.health().state, "missing");
    assert.match(embedder.health().warning, /node scripts\/memory-models\.mjs pull Xenova\/multilingual-e5-small/u);
  } finally {
    globalThis.fetch = originalFetch;
    await embedder.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sqlite-vec load failure is reported with the pnpm install hint and does not throw", async () => {
  const { loadVec } = await import("../../dist/memory/memory-vectors.js");
  const fake = { loadExtension() { throw new Error("no ext"); } };
  const msg = loadVec(fake);
  assert.ok(msg === null || msg.includes("pnpm install"));
});

test("missing sqlite-vec keeps FTS search and combines the disabled setting with recovery steps", async () => {
  const originalLoad = Module._load;
  Module._load = function (request, ...args) {
    if (request === "sqlite-vec") throw new Error("Cannot find module 'sqlite-vec'");
    return originalLoad.call(this, request, ...args);
  };
  const { service, done } = makeService();
  try {
    await service.start();
    await service.reindex({ mode: "full" });
    const result = await service.search({ query: "apricot", include_raw: true });
    assert.equal(result.mode, "fts");
    assert.deepEqual(result.items.map((item) => item.title), ["Apricot Notes"]);
    const warning = (await service.health()).embedder.warning;
    assert.match(warning, /設定で無効/u);
    assert.match(warning, /pnpm install/u);
    assert.match(warning, /node scripts\/memory-models\.mjs pull Xenova\/multilingual-e5-small/u);
    assert.match(warning, /memory_embeddings\.enabled を true/u);
  } finally {
    try { await done(); }
    finally { Module._load = originalLoad; }
  }
});

test("transformers import failure while enabled keeps FTS search and reports valid recovery steps", async () => {
  const root = mkdtempSync(join(tmpdir(), "owl-enabled-import-failure-"));
  const modelDir = join(root, "models", "fake-model");
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(join(modelDir, "config.json"), "{}");
  const embedder = new ChildEmbedder({
    ...DEFAULT_EMBEDDER_CONFIG, enabled: true, model: "fake-model", modelsDirs: [join(root, "models")], childPath: MISSING_TRANSFORMERS,
  });
  const { service, done } = makeService(embedder);
  try {
    await service.start();
    await service.reindex({ mode: "full" });
    await assert.rejects(embedder.embed("query", ["fictional apricot orchard"]));
    await assert.rejects(embedder.embed("query", ["fictional apricot orchard"]));
    const result = await service.search({ query: "apricot", include_raw: true });
    assert.equal(result.mode, "fts");
    assert.deepEqual(result.items.map((item) => item.title), ["Apricot Notes"]);
    const warning = (await service.health()).embedder.warning;
    assert.match(warning, /optional 依存を除外せず pnpm install/u);
    assert.match(warning, /node scripts\/memory-models\.mjs pull Xenova\/multilingual-e5-small/u);
    assert.match(warning, /memory_embeddings\.enabled/u);
  } finally {
    await done();
    rmSync(root, { recursive: true, force: true });
  }
});
