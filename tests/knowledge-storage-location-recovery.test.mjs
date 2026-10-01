import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { KnowledgeLocation } from "../packages/core/dist/index.js";

async function setup(t, current = "store") {
  const base = await fs.mkdtemp(join(tmpdir(), "owl-kb-recovery-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = join(base, current);
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(join(source, ".owl-knowledge"), "{}");
  const stored = { value: source };
  const location = new KnowledgeLocation({
    owlRoot: join(base, "root"),
    dataDir: join(base, "data"),
    persistence: { read: () => stored.value, write: (value) => { stored.value = value; } },
  });
  t.after(() => location.stop());
  return { base, source, stored, location };
}

test("a write lease detects a missing storage before a writer can recreate it", async (t) => {
  const { base, source, location } = await setup(t);
  assert.equal((await location.initialize()).state, "available");
  await fs.rename(source, join(base, "detached"));

  await assert.rejects(location.withWrite(async () => {
    await fs.mkdir(location.activeDir(), { recursive: true });
    await fs.writeFile(join(location.activeDir(), "memo.md"), "must not be saved");
  }), (error) => error.code === "knowledge_storage_unavailable" && error.details.reason === "missing");

  assert.equal(location.status().state, "unavailable");
  assert.equal(location.status().reason, "missing");
  await assert.rejects(fs.stat(source), { code: "ENOENT" });
});

test("a read before polling detects that the storage itself disappeared", async (t) => {
  const { base, source, location } = await setup(t);
  await fs.rename(source, join(base, "detached"));

  await assert.rejects(location.withRead(() => fs.readdir(source)),
    (error) => error.code === "knowledge_storage_unavailable" && error.details.reason === "missing");
  assert.equal(location.status().state, "unavailable");
  assert.equal(location.status().reason, "missing");
});

test("a missing note remains an ENOENT when the storage is healthy", async (t) => {
  const { source, location } = await setup(t);

  await assert.rejects(location.withRead(() => fs.readFile(join(source, "missing-note.md"), "utf8")), { code: "ENOENT" });
  assert.equal(location.status().state, "available");
});

test("a write lease detects a removed custom marker", async (t) => {
  const { source, location } = await setup(t);
  assert.equal((await location.initialize()).state, "available");
  await fs.unlink(join(source, ".owl-knowledge"));

  await assert.rejects(location.withWrite(async () => assert.fail("writer ran without a storage marker")),
    (error) => error.code === "knowledge_storage_unavailable" && error.details.reason === "marker_missing");
  assert.equal(location.status().reason, "marker_missing");
});

test("the availability callback can write under a lease without deadlocking recovery", async (t) => {
  const base = await fs.mkdtemp(join(tmpdir(), "owl-kb-write-recovery-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = join(base, "store");
  let location;
  let recoveryWrites = 0;
  location = new KnowledgeLocation({
    owlRoot: join(base, "root"),
    dataDir: join(base, "data"),
    persistence: { read: () => source, write() {} },
    pollIntervalMs: 60_000,
    unavailablePollIntervalMs: 60_000,
    onAvailable: async () => location.withWrite(async () => { recoveryWrites += 1; }),
  });
  assert.equal((await location.initialize()).state, "unavailable");
  await fs.mkdir(source);
  await fs.writeFile(join(source, ".owl-knowledge"), "{}");

  const checking = location.check();
  const completed = await Promise.race([checking.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 250))]);

  assert.equal(completed, true, "recovery must not deadlock in a nested write lease");
  assert.equal(recoveryWrites, 1);
  await location.stop();
});

test("write-probe access errors update status and become knowledge_storage_unavailable", async (t) => {
  const { source } = await setup(t);
  let denyWrites = false;
  const location = new KnowledgeLocation({
    owlRoot: join(source, "root"),
    dataDir: join(source, "data"),
    persistence: { read: () => source, write() {} },
    fs: {
      ...fs,
      writeFile: async (...args) => {
        if (denyWrites && String(args[0]).includes(".owl-probe-")) {
          const error = new Error("permission denied");
          error.code = "EACCES";
          throw error;
        }
        return fs.writeFile(...args);
      },
    },
  });
  t.after(() => location.stop());
  assert.equal((await location.initialize()).state, "available");
  denyWrites = true;

  await assert.rejects(location.withWrite(async () => assert.fail("writer ran despite failed storage probe")),
    (error) => error.code === "knowledge_storage_unavailable" && error.details.reason === "not_writable");
  assert.equal(location.status().state, "unavailable");
  assert.equal(location.status().reason, "not_writable");
});

test("an access error during a leased write is refreshed and mapped to the storage error", async (t) => {
  const base = await fs.mkdtemp(join(tmpdir(), "owl-kb-write-error-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = join(base, "store");
  await fs.mkdir(source);
  await fs.writeFile(join(source, ".owl-knowledge"), "{}");
  const location = new KnowledgeLocation({
    owlRoot: join(base, "root"),
    dataDir: join(base, "data"),
    persistence: { read: () => source, write() {} },
  });
  t.after(() => location.stop());
  assert.equal((await location.initialize()).state, "available");

  await assert.rejects(location.withWrite(async () => {
    const error = new Error("write permission denied");
    error.code = "EACCES";
    throw error;
  }), (error) => error.code === "knowledge_storage_unavailable" && error.details.reason === "not_writable");
  assert.equal(location.status().state, "unavailable");
  assert.equal(location.status().reason, "not_writable");
});

test("failed relink persistence preserves the target's existing marker and data", async (t) => {
  const base = await fs.mkdtemp(join(tmpdir(), "owl-kb-relink-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = join(base, "missing-source");
  const target = join(base, "existing-target");
  const marker = JSON.stringify({ format: 1, retained: true });
  const data = "target knowledge";
  await fs.mkdir(target);
  await fs.writeFile(join(target, ".owl-knowledge"), marker);
  await fs.writeFile(join(target, "kept.md"), data);
  const location = new KnowledgeLocation({
    owlRoot: join(base, "root"),
    dataDir: join(base, "data"),
    persistence: { read: () => source, write: () => { throw new Error("settings write failed"); } },
  });
  t.after(() => location.stop());
  assert.equal((await location.initialize()).state, "unavailable");

  await assert.rejects(location.move({ path: target, mode: "relink" }),
    (error) => error.code === "knowledge_move_failed" && error.details.stage === "switching");

  assert.equal(await fs.readFile(join(target, ".owl-knowledge"), "utf8"), marker);
  assert.equal(await fs.readFile(join(target, "kept.md"), "utf8"), data);
});

test("cleaning-up recovery removes only verified manifest files and warns about late source files", async (t) => {
  const base = await fs.mkdtemp(join(tmpdir(), "owl-kb-cleanup-recovery-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = join(base, "old-store");
  const target = join(base, "new-store");
  const dataDir = join(base, "data");
  const copied = "copied before the switch";
  await fs.mkdir(source);
  await fs.mkdir(target);
  await fs.mkdir(dataDir);
  await fs.writeFile(join(source, "kept.md"), copied);
  await fs.writeFile(join(source, "late.md"), "added after verification");
  await fs.writeFile(join(target, ".owl-knowledge"), "{}");
  await fs.writeFile(join(target, "kept.md"), copied);
  const digest = createHash("sha256").update(copied).digest("hex");
  await fs.writeFile(join(dataDir, "knowledge-move.json"), JSON.stringify({
    move_id: "move-1",
    source,
    target,
    mode: "move",
    created_target: false,
    stage: "cleaning_up",
    started_at: "2026-01-01T00:00:00.000Z",
    manifest: { dirs: [], files: [{ rel: "kept.md", size: Buffer.byteLength(copied), sha256: digest }] },
  }));
  const location = new KnowledgeLocation({
    owlRoot: join(base, "root"),
    dataDir,
    persistence: { read: () => target, write() {} },
  });
  t.after(() => location.stop());

  const status = await location.initialize();

  assert.equal(status.state, "available");
  assert.equal(await fs.readFile(join(target, "kept.md"), "utf8"), copied);
  await assert.rejects(fs.stat(join(source, "kept.md")), { code: "ENOENT" });
  assert.equal(await fs.readFile(join(source, "late.md"), "utf8"), "added after verification");
  await assert.rejects(fs.stat(join(target, "late.md")), { code: "ENOENT" });
  assert.equal(status.last_move.warnings[0].code, "source_cleanup_incomplete");
  assert.equal(status.last_move.warnings[0].remaining_files, 1);
});
