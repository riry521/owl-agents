import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryIndex } from "../../dist/memory/memory-index.js";
import { MemorySearch, buildFtsQueryPlan } from "../../dist/memory/memory-search.js";

test("quoted multi-word phrase keeps its boundary in the plan", () => {
  assert.deepEqual(buildFtsQueryPlan('"retry worker"').phrases, ["retry worker"]);
});

test("only the note with the contiguous phrase ranks first", async () => {
  const root = mkdtempSync(join(tmpdir(), "owl-phrase-"));
  try {
    const vault = join(root, "vault");
    const dataDir = join(root, "data");
    mkdirSync(join(vault, "global"), { recursive: true });
    mkdirSync(dataDir);
    // Scatter sorts first by path and is newer, so neither can explain Exact winning.
    const scatter = join(vault, "global", "a-scatter.md");
    writeFileSync(scatter, "---\ntitle: Scatter\n---\nworker pool, retry later; the worker retry again\n");
    writeFileSync(join(vault, "global", "z-exact.md"), "---\ntitle: Exact\n---\nthe retry worker handles failures\n");
    const later = new Date(Date.now() + 60_000);
    utimesSync(scatter, later, later);
    const storage = {
      isAvailable: () => true,
      activeDir: () => vault,
      withRead: async (op) => op(),
      status: () => ({ available: true, dir: vault, since: null }),
    };
    const index = new MemoryIndex({ dataDir, storage, watch: false });
    await index.start();
    await index.rebuild("manual");
    const { hits } = await new MemorySearch({ index, embedder: { enabled: false } }).search({ query: '"retry worker"' });
    assert.equal(hits[0].row.title, "Exact");
    await index.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
