import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChildEmbedder, DEFAULT_EMBEDDER_CONFIG } from "../../dist/memory/embedder.js";
import { MemoryService } from "../../dist/memory/memory-service.js";
import { clippingText } from "./clipping-text.mjs";
import { writeModelFiles } from "./model-fixture.mjs";

const FAKE = new URL("./fixtures/fake-embedder-child.cjs", import.meta.url).pathname;
const OWNER = { caller: "owner", agent_run_id: null, work_id: null, task_id: null, project_id: null };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeService() {
  // Japanese and English words share one direction, as a multilingual model would place them.
  process.env.FAKE_GROUPS = JSON.stringify([["切り紙", "papercut"], ["リール", "reel"]]);
  const root = mkdtempSync(join(tmpdir(), "owl-cross-lingual-"));
  const vault = join(root, "vault");
  const dataDir = join(root, "data");
  mkdirSync(join(vault, "research"), { recursive: true });
  mkdirSync(dataDir);
  writeModelFiles(join(root, "models", "fake-model"));
  const clip = (name, title, text) => writeFileSync(join(vault, "research", name), clippingText(title, text));
  clip("a.md", "Papercut Reel Maker", "builds vertical reel videos with papercut captions");
  clip("b.md", "Fishing Gear", "a review of a fishing reel");
  const embedder = new ChildEmbedder({ ...DEFAULT_EMBEDDER_CONFIG, enabled: true, model: "fake-model", modelsDirs: [join(root, "models")], childPath: FAKE });
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const service = new MemoryService({ dataDir, storage, embedder, pageTypes: DEFAULT_EMBEDDER_CONFIG.pageTypes, indexOptions: { watch: false } });
  return { service, clip, done: async () => { await service.stop(); rmSync(root, { recursive: true, force: true }); delete process.env.FAKE_GROUPS; } };
}

test("a Japanese query finds an English clipping that has none of its words, with match vec", async () => {
  const { service, done } = makeService();
  try {
    await service.start();
    await service.reindex({ mode: "full", embed: true });
    const out = await service.searchPages({ query: "切り紙 リール" }, OWNER);
    assert.equal(out.mode, "hybrid");
    const hit = out.items.find((item) => item.title === "Papercut Reel Maker");
    assert.ok(hit, "the English clipping is in the result");
    assert.equal(hit.match, "vec");
    assert.doesNotMatch(hit.summary, /切り紙/u);
  } finally {
    await done();
  }
});

test("a clipping added after start is embedded after the scan, without any search", async () => {
  const { service, clip, done } = makeService();
  try {
    await service.start();
    await service.reindex({ mode: "full", embed: true });
    clip("c.md", "Paper Cutting Videos", "another papercut reel tool");
    await service.reindex({ mode: "diff" });
    const embedded = () => service.index.db().prepare("SELECT 1 FROM note_chunks c JOIN notes n ON n.rowid = c.note_rowid WHERE n.path LIKE '%c.md'").get();
    for (let i = 0; i < 400 && !embedded(); i++) await sleep(50);
    assert.ok(embedded(), "vectors of the new clipping exist");
  } finally {
    await done();
  }
});
