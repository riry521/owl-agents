import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryIndex, MEMORY_INDEX_FILE } from "../../dist/memory/memory-index.js";

const script = new URL("../../../../scripts/memory-eval.mjs", import.meta.url).pathname;
const set = new URL("../fixtures/memory-eval/set.jsonl", import.meta.url).pathname;
const run = (index) => spawnSync(process.execPath, [script, "--set", set, "--index", index, "--json"], { encoding: "utf8" });

test("--index opens the named file; a missing path fails without creating an index", async () => {
  const root = mkdtempSync(join(tmpdir(), "owl-memory-eval-cli-"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, "notes", "n01.md"), "---\nid: n01\ntitle: 月次レポートの自動集計\n---\n毎月の売上を集計してメールで送る。\n");
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const index = new MemoryIndex({ dataDir: join(root, "data"), storage, watch: false });
  try {
    index.open();
    await index.rebuild("test");
    await index.stop();
    const custom = join(root, "custom-name.sqlite");
    copyFileSync(join(root, "data", MEMORY_INDEX_FILE), custom);
    const ok = run(custom);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(JSON.parse(ok.stdout).metrics.all.count > 0);

    mkdirSync(join(root, "empty"));
    const missing = join(root, "empty", "memory-index.sqlite");
    const bad = run(missing);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /index not found/);
    assert.equal(existsSync(missing), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
