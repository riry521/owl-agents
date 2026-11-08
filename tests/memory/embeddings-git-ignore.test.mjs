import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { test } from "node:test";

import { resolveDataDir } from "../../apps/server/dist/contracts.js";
import { MEMORY_INDEX_FILE, MODEL_FILES, modelDirFor } from "../../packages/core/dist/index.js";
import { DEFAULT_EMBEDDER_CONFIG } from "../../packages/core/dist/memory/embedder.js";
import { repoRoot } from "../helpers/paths.mjs";

const isIgnored = (path) => {
  try { execFileSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: repoRoot }); return true; } catch { return false; }
};

test("the default model files, the index with its WAL files and memory-embedder.json are ignored by git", () => {
  const saved = process.env.OWL_DATA_DIR;
  delete process.env.OWL_DATA_DIR;
  try {
    const dataDir = resolveDataDir(repoRoot);
    const modelDir = modelDirFor(join(dataDir, "models"), DEFAULT_EMBEDDER_CONFIG.model);
    const paths = [
      ...MODEL_FILES.map((file) => join(modelDir, file)),
      ...["", "-wal", "-shm"].map((suffix) => join(dataDir, `${MEMORY_INDEX_FILE}${suffix}`)),
      join(dataDir, "memory-embedder.json"),
    ];
    for (const path of paths) assert.ok(isIgnored(relative(repoRoot, path)), `${relative(repoRoot, path)} is ignored`);
  } finally {
    if (saved !== undefined) process.env.OWL_DATA_DIR = saved;
  }
});
