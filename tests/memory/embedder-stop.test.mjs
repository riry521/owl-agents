import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ChildEmbedder, DEFAULT_EMBEDDER_CONFIG } from "../../packages/core/dist/memory/embedder.js";

test("embedder stop() sends SIGKILL after the grace period when the child ignores SIGTERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owl-embedder-stop-"));
  const modelsDir = join(dir, "models");
  mkdirSync(join(modelsDir, "test-model"), { recursive: true });
  writeFileSync(join(modelsDir, "test-model", "config.json"), "{}");
  const childPath = join(dir, "child.mjs");
  writeFileSync(childPath, 'process.on("SIGTERM", () => {});\nprocess.on("message", (m) => { if (m.op === "init") process.send({ op: "ready", dim: 3 }); });\nsetInterval(() => {}, 1000);\n');
  const embedder = new ChildEmbedder({ ...DEFAULT_EMBEDDER_CONFIG, enabled: true, model: "test-model", modelsDirs: [modelsDir], childPath, killGraceMs: 200, requestTimeoutMs: 5_000 });
  embedder.warmup();
  const readyBy = Date.now() + 5_000;
  while (!embedder.isReady() && Date.now() < readyBy) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(embedder.isReady(), "child reported ready");
  const pid = embedder.health().pid;
  assert.ok(pid);
  const began = Date.now();
  await embedder.stop();
  assert.ok(Date.now() - began >= 150, "waited for the grace period before SIGKILL");
  assert.throws(() => process.kill(pid, 0), "child is gone after stop()");
});
