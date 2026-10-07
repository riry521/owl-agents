import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChildEmbedder, DEFAULT_EMBEDDER_CONFIG, embeddingText } from "../../dist/memory/embedder.js";

const FAKE = new URL("./fixtures/fake-embedder-child.cjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "owl-embedder-"));
  mkdirSync(join(root, "models", "fake-model"), { recursive: true });
  writeFileSync(join(root, "models", "fake-model", "config.json"), "{}");
  const embedder = new ChildEmbedder({ ...DEFAULT_EMBEDDER_CONFIG, enabled: true, model: "fake-model", modelsDirs: [join(root, "models")], childPath: FAKE, idleMs: 200, retryMs: 60_000, ...overrides });
  return { root, embedder, done: async () => { await embedder.stop(); rmSync(root, { recursive: true, force: true }); delete process.env.FAKE_MODE; } };
}

test("e5 gets query:/passage: prefixes, other models their own or none", () => {
  assert.equal(embeddingText("Xenova/multilingual-e5-small", "query", "q"), "query: q");
  assert.equal(embeddingText("Xenova/multilingual-e5-small", "passage", "p"), "passage: p");
  assert.equal(embeddingText("fake-model", "query", "q"), "q");
});

test("starts on the first embed, stops after the idle time, and starts again on the next one", async () => {
  const { embedder, done } = setup();
  try {
    assert.equal(embedder.health().state, "idle");
    assert.equal(embedder.health().pid, null);
    const [v] = await embedder.embed("query", ["apple"]);
    assert.equal(v.length, 4);
    const first = embedder.health();
    assert.equal(first.state, "ready");
    assert.ok(first.pid);
    await sleep(500);
    assert.equal(embedder.health().state, "idle");
    assert.equal(embedder.health().pid, null);
    assert.throws(() => process.kill(first.pid, 0), "the idle child process is gone");
    await embedder.embed("query", ["car"]);
    assert.equal(embedder.health().state, "ready");
    assert.notEqual(embedder.health().pid, first.pid);
  } finally {
    await done();
  }
});

test("a crash fails that call, the next call restarts once and succeeds", async () => {
  process.env.FAKE_MODE = "die-once";
  process.env.FAKE_MARKER = join(tmpdir(), `owl-fake-marker-${process.pid}-${Date.now()}`);
  const { embedder, done } = setup({ idleMs: 60_000 });
  try {
    await assert.rejects(embedder.embed("query", ["apple"]));
    assert.equal(embedder.health().state, "failed");
    assert.match(embedder.health().last_error, /exited/);
    await embedder.embed("query", ["apple"]);
    assert.equal(embedder.health().state, "ready");
  } finally {
    rmSync(process.env.FAKE_MARKER, { force: true });
    delete process.env.FAKE_MARKER;
    await done();
  }
});

test("a second crash in a row stops restarting until retryMs has passed", async () => {
  process.env.FAKE_MODE = "die-always";
  const { embedder, done } = setup({ idleMs: 60_000 });
  try {
    await assert.rejects(embedder.embed("query", ["a"]));
    await assert.rejects(embedder.embed("query", ["a"]));
    const health = embedder.health();
    assert.equal(health.state, "failed");
    assert.ok(health.retry_after);
    await assert.rejects(embedder.embed("query", ["a"]));
    assert.equal(embedder.health().pid, null, "no new child while waiting");
  } finally {
    await done();
  }
});

test("a missing model reports state missing with last_error", async () => {
  const { embedder, done } = setup({ modelsDirs: [join(tmpdir(), "owl-no-such-models")] });
  try {
    await assert.rejects(embedder.embed("query", ["a"]));
    const health = embedder.health();
    assert.equal(health.state, "missing");
    assert.match(health.last_error, /not found/);
    assert.equal(health.pid, null);
  } finally {
    await done();
  }
});

test("a child that cannot start reports state failed", async () => {
  const { embedder, done } = setup({ childPath: join(tmpdir(), "owl-no-such-child.js") });
  try {
    await assert.rejects(embedder.embed("query", ["a"]));
    assert.equal(embedder.health().state, "failed");
    assert.ok(embedder.health().last_error);
  } finally {
    await done();
  }
});
