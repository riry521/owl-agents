import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { runEmbeddingsCommand } from "../../apps/server/dist/embeddings-command.js";
import { ChildEmbedder } from "../../packages/core/dist/memory/embedder.js";
import { MemoryService } from "../../packages/core/dist/memory/memory-service.js";
import { clippingText } from "../../packages/core/test/memory/clipping-text.mjs";
import { tempDir } from "../helpers/temp.mjs";

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))("better-sqlite3");
const FAKE = new URL("../../packages/core/test/memory/fixtures/fake-embedder-child.cjs", import.meta.url).pathname;
const DEFAULT_MODEL = "Xenova/multilingual-e5-small";

/** A model host that answers every file with "{}" and records the requested paths. */
async function startHost(t) {
  const requests = [];
  const server = createServer((req, res) => { requests.push(req.url); res.end("{}"); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

/** Runs the command and collects the output; embed() calls reaching the fake child are counted. */
async function run(dataDir, env, extra = {}) {
  const lines = [];
  const errors = [];
  const counter = { embedCalls: 0 };
  const code = await runEmbeddingsCommand({
    dataDir, env, out: (line) => lines.push(line), err: (line) => errors.push(line),
    createEmbedder: (config) => {
      const embedder = new ChildEmbedder({ ...config, childPath: FAKE });
      const embed = embedder.embed.bind(embedder);
      embedder.embed = (...args) => { counter.embedCalls += 1; return embed(...args); };
      return embedder;
    },
    ...extra,
  });
  return { code, lines, errors, counter };
}

/** A data directory holding an index of two notes with no vectors yet. */
async function dataDirWithIndex(t) {
  const root = await tempDir(t, "owl-embeddings-cmd-");
  const vault = join(root, "vault");
  const write = (rel, text) => { mkdirSync(dirname(join(vault, rel)), { recursive: true }); writeFileSync(join(vault, rel), text); };
  write("research/a.md", clippingText("Orchard", "apple harvest"));
  write("materials/common/note.md", "car material note\n");
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const service = new MemoryService({ dataDir, storage, embedder: new ChildEmbedder({ model: DEFAULT_MODEL, modelsDirs: [] }), pageTypes: ["clipping", "material"], indexOptions: { watch: false } });
  await service.start();
  await service.reindex({ mode: "full" });
  await service.stop();
  return dataDir;
}

const chunkIds = (dataDir) => {
  const db = new Database(join(dataDir, "memory-index.sqlite"), { readonly: true });
  try { return db.prepare("SELECT chunk_id AS id FROM note_chunks ORDER BY id").all().map((r) => r.id); } finally { db.close(); }
};

test("an unset enabled downloads the model under <dataDir>/models and writes enabled: true; without an index it only says so", async (t) => {
  const host = await startHost(t);
  const dataDir = await tempDir(t, "owl-embeddings-cmd-");
  const { code, lines } = await run(dataDir, { OWL_MEMORY_MODEL_HOST: host.url });
  assert.equal(code, 0);
  assert.ok(existsSync(join(dataDir, "models", DEFAULT_MODEL, "onnx", "model_quantized.onnx")));
  assert.ok(host.requests.every((url) => url.startsWith(`/${DEFAULT_MODEL}/resolve/main/`)));
  assert.equal(JSON.parse(readFileSync(join(dataDir, "memory-embedder.json"), "utf8")).enabled, true);
  assert.ok(lines.some((line) => /索引はまだありません|no index yet/u.test(line)));
});

test("an explicit off exits 0 without any request or file", async (t) => {
  const host = await startHost(t);
  const dataDir = await tempDir(t, "owl-embeddings-cmd-");
  const byEnv = await run(dataDir, { OWL_MEMORY_MODEL_HOST: host.url, OWL_MEMORY_EMBEDDINGS_ENABLED: "false" });
  writeFileSync(join(dataDir, "memory-embedder.json"), JSON.stringify({ enabled: false }));
  const byFile = await run(dataDir, { OWL_MEMORY_MODEL_HOST: host.url });
  assert.deepEqual([byEnv.code, byFile.code], [0, 0]);
  assert.equal(host.requests.length, 0);
  assert.equal(existsSync(join(dataDir, "models")), false);
});

test("an existing index gets its pending notes embedded, and a second run embeds none", async (t) => {
  const host = await startHost(t);
  const dataDir = await dataDirWithIndex(t);
  const env = { OWL_MEMORY_MODEL_HOST: host.url };
  const first = await run(dataDir, env);
  assert.equal(first.code, 0);
  assert.ok(first.counter.embedCalls > 0);
  const ids = chunkIds(dataDir);
  assert.ok(ids.length > 0);
  const second = await run(dataDir, env);
  assert.equal(second.code, 0);
  assert.equal(second.counter.embedCalls, 0);
  assert.deepEqual(chunkIds(dataDir), ids);
});

test("on a terminal the progress goes to the write argument, not process.stdout", async (t) => {
  const host = await startHost(t);
  const dataDir = await dataDirWithIndex(t);
  const chunks = [];
  const original = process.stdout.write;
  let leaked = false;
  process.stdout.write = (...args) => { leaked = true; return original.apply(process.stdout, args); };
  let result;
  try { result = await run(dataDir, { OWL_MEMORY_MODEL_HOST: host.url }, { isTTY: true, write: (text) => chunks.push(text) }); } finally { process.stdout.write = original; }
  assert.equal(result.code, 0);
  assert.ok(chunks.some((text) => text.startsWith("\r")) && chunks.at(-1) === "\n");
  assert.equal(leaked, false);
});

test("on a terminal without a write argument the progress still goes to out", async (t) => {
  const host = await startHost(t);
  const dataDir = await dataDirWithIndex(t);
  const result = await run(dataDir, { OWL_MEMORY_MODEL_HOST: host.url }, { isTTY: true });
  assert.equal(result.code, 0);
  assert.ok(result.lines.some((text) => text.startsWith("\r")));
});

test("changing OWL_MEMORY_EMBED_MODEL downloads that model and rebuilds every vector", async (t) => {
  const host = await startHost(t);
  const dataDir = await dataDirWithIndex(t);
  await run(dataDir, { OWL_MEMORY_MODEL_HOST: host.url });
  const before = chunkIds(dataDir);
  const other = await run(dataDir, { OWL_MEMORY_MODEL_HOST: host.url, OWL_MEMORY_EMBED_MODEL: "other/model" });
  assert.equal(other.code, 0);
  assert.ok(existsSync(join(dataDir, "models", "other", "model", "config.json")));
  assert.ok(host.requests.some((url) => url.startsWith("/other/model/resolve/main/")));
  assert.ok(other.counter.embedCalls > 0);
  const db = new Database(join(dataDir, "memory-index.sqlite"), { readonly: true });
  try {
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'embed_model'").get().value, "other/model");
    assert.equal(db.prepare("SELECT count(*) AS n FROM note_chunks").get().n, before.length, "every chunk is rebuilt, none is lost");
  } finally { db.close(); }
  assert.ok(other.counter.embedCalls > 0 && other.counter.embedCalls >= 2, "all notes are embedded again");
});

test("a failed download prints the URL and returns 1", async (t) => {
  const dataDir = await tempDir(t, "owl-embeddings-cmd-");
  const { code, errors } = await run(dataDir, { OWL_MEMORY_MODEL_HOST: "http://127.0.0.1:9" });
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /http:\/\/127\.0\.0\.1:9\/Xenova\/multilingual-e5-small\/resolve\/main\//u);
});
