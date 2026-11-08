import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChildEmbedder, DEFAULT_EMBEDDER_CONFIG } from "../../dist/memory/embedder.js";
import { MemoryService } from "../../dist/memory/memory-service.js";
import { clippingText } from "./clipping-text.mjs";
import { writeModelFiles } from "./model-fixture.mjs";

const FAKE = new URL("./fixtures/fake-embedder-child.cjs", import.meta.url).pathname;
const NO_DEPS = new URL("./fixtures/missing-embedder-deps-child.cjs", import.meta.url).pathname;
const OWNER = { caller: "owner", agent_run_id: null, work_id: null, task_id: null, project_id: null };
const listing = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).sort() : null);

const CASES = {
  "the feature is off": { config: { enabled: false } },
  "the model folder is missing": { config: {}, noModel: true },
  "the optional dependency is missing": { config: { childPath: NO_DEPS } },
  "the child fails to initialize": { config: { childPath: FAKE }, mode: "exit-on-init" },
};

for (const [name, { config, noModel, mode }] of Object.entries(CASES)) {
  test(`searchPages answers from word matching and never downloads when ${name}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "owl-fallback-"));
    const realFetch = globalThis.fetch;
    const fetched = [];
    globalThis.fetch = (...args) => { fetched.push(args[0]); return Promise.reject(new Error("fetch must not be called")); };
    if (mode) process.env.FAKE_MODE = mode;
    const vault = join(root, "vault");
    const dataDir = join(root, "data");
    const modelsDir = join(root, "models");
    mkdirSync(join(vault, "research"), { recursive: true });
    mkdirSync(dataDir);
    if (!noModel) writeModelFiles(join(modelsDir, "fake-model"));
    writeFileSync(join(vault, "research", "a.md"), clippingText("Orchard", "the apple harvest was good"));
    const embedder = new ChildEmbedder({ ...DEFAULT_EMBEDDER_CONFIG, enabled: true, model: "fake-model", modelsDirs: [modelsDir], ...config });
    const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
    const service = new MemoryService({ dataDir, storage, embedder, indexOptions: { watch: false } });
    const before = listing(modelsDir);
    try {
      await service.start();
      await service.reindex({ mode: "full" });
      const out = await service.searchPages({ query: "apple" }, OWNER);
      assert.equal(out.error, undefined);
      assert.equal(out.mode, "fts");
      assert.ok(out.items.some((item) => item.title === "Orchard"), "the word match is returned");
      assert.deepEqual(fetched, [], "no download is attempted");
      assert.deepEqual(listing(modelsDir), before, "the model folder gains no files");
    } finally {
      await service.stop();
      globalThis.fetch = realFetch;
      delete process.env.FAKE_MODE;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
