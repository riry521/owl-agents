import { clip, seedNote } from "../helpers/seed-knowledge.mjs";
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeBase, KnowledgeLocation, KnowledgeNotes } from "../../packages/core/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { tempDir } from "../helpers/temp.mjs";

const WORK_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const WORK_B = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const CANARY_VERIFY =
  "架空の画面を検査するときは、操作説明にも載る「青い三角」を判定用の目印にしてはいけない。判定は結果欄だけで行う。画面全体を検索すると、見本と実際の目印を区別できない。";
const CANARY_SELECT =
  "架空の画面を確認するときは、操作案内にも載る「青い三角」を判定用の目印にしてはいけない。判定は結果欄だけで行う。画面全体を調べると、見本と実際の目印を区別できない。";

const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

/** A Core whose knowledge lives in `<base>/<name>` (not called "knowledge"); `stored` mimics app-settings.json. */
async function setup(t, { name = "owl-kb", marker = true, coreOptions = {} } = {}) {
  const base = await tempDir(t, "owl-kb-location-");
  const owlRoot = join(base, "root");
  const dataDir = join(base, "root", "data");
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  if (marker) await writeFile(join(dir, ".owl-knowledge"), "{}");
  const db = createTestDatabase(base);
  const stored = { value: dir };
  const knowledgeStorage = { read: () => stored.value, write: (value) => { stored.value = value; } };
  const { core } = await createTestCore(t, { db, agentRunner, version: "kb-test", owlRoot, dataDir, knowledgeStorage, ...coreOptions });
  t.after(() => db.close());
  return { base, owlRoot, dataDir, dir, db, core, stored, knowledgeStorage };
}

async function listFiles(dir, rel = "") {
  const out = [];
  for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
    const childRel = rel ? join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...await listFiles(dir, childRel));
    else out.push(childRel);
  }
  return out.sort();
}

test("an absolute knowledge_dir of any name is accepted for retag; relative ones are rejected", async (t) => {
  const { dir, core } = await setup(t, { name: "anything" });
  await assert.rejects(core.retagKnowledgeNotes({ knowledge_dir: "relative/x", dry_run: true, extract: async () => ({ ok: true, items: [] }) }), /knowledge_dir/u);
  const report = await core.retagKnowledgeNotes({ knowledge_dir: dir, dry_run: true, extract: async () => ({ ok: true, items: [] }) });
  assert.equal(report.scanned, 0);
});

test("the storage becomes unavailable when its directory disappears, Work APIs keep working, and it recovers", async (t) => {
  const { base, dir, core, db } = await setup(t);
  await core.start();
  await core.knowledge.create({ folder: "global", filename: "kept.md", tags: [], ...clip("hello") });
  assert.equal((await core.knowledge.list()).length, 1);

  const gone = join(base, "gone");
  await rename(dir, gone);
  const status = await core.checkKnowledgeStorage();
  assert.equal(status.state, "unavailable");
  assert.equal(status.reason, "missing");

  // Knowledge features stop with the designed error ...
  for (const operation of [
    () => core.knowledge.list(),
    () => core.memorySaver.saveExplicitMemory("remember this"),
    () => core.runCuration({ kind: "librarian", trigger: "manual_api", actor: "owner" }),
    () => core.retagKnowledgeNotes({ dry_run: true, extract: async () => ({ ok: true, items: [] }) }),
  ]) {
    await assert.rejects(operation(), (error) => /^(knowledge_)?storage_unavailable$/u.test(error.code) && (error.details?.reason ?? "missing") === "missing");
  }
  // ... and nothing recreated the missing directory.
  await assert.rejects(stat(dir), /ENOENT/u);
  assert.equal(db.all("SELECT id FROM curation_runs").length, 0);

  // ... while Works are still created and listed.
  const created = await core.createWork({ request_id: createUlid(), idempotency_key: `kb:${createUlid()}`, expected_version: 0, payload: { title: "still works", summary: "s", size: "normal", project_id: null } });
  assert.ok(created);
  assert.equal(core.listWorks().data.length, 1);

  await rename(gone, dir);
  const recovered = await core.checkKnowledgeStorage();
  assert.equal(recovered.state, "available");
  assert.equal(recovered.reason, null);
  assert.equal((await core.knowledge.list()).length, 1);
  await core.memorySaver.saveExplicitMemory("remember this");
});

test("removing only the marker file makes a custom storage unavailable", async (t) => {
  const { dir, core } = await setup(t);
  await core.start();
  await rm(join(dir, ".owl-knowledge"));
  const status = await core.checkKnowledgeStorage();
  assert.equal(status.state, "unavailable");
  assert.equal(status.reason, "marker_missing");
});

test("a storage that is unavailable at start is polled and comes back by itself", async (t) => {
  const base = await tempDir(t, "owl-kb-poll-");
  const dir = join(base, "drive");
  let available = 0;
  const location = new KnowledgeLocation({
    owlRoot: join(base, "root"), dataDir: join(base, "data"),
    persistence: { read: () => dir, write() {} },
    unavailablePollIntervalMs: 20, pollIntervalMs: 20,
    onAvailable: () => { available += 1; },
  });
  t.after(() => location.stop());
  assert.equal((await location.initialize()).state, "unavailable");
  await assert.rejects(stat(dir), /ENOENT/u, "a custom storage is never created automatically");
  await mkdir(dir);
  await writeFile(join(dir, ".owl-knowledge"), "{}");
  for (let i = 0; i < 100 && location.status().state !== "available"; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(location.status().state, "available");
  assert.equal(available, 1);
});

test("leaving the storage unavailable pauses learning jobs without consuming attempts, and recovery resumes them", async (t) => {
  const { base, dir, core, db } = await setup(t);
  await core.start();
  const now = new Date().toISOString();
  const work = await core.createWork({ request_id: createUlid(), idempotency_key: `kb:${createUlid()}`, expected_version: 0, payload: { title: "w", summary: "s", size: "normal", project_id: null } });
  db.handle.prepare(
    `INSERT INTO learning_jobs (id, work_id, status, attempts, payload_version, payload_json, created_at, updated_at) VALUES (?, ?, 'pending', 0, 1, '{}', ?, ?)`,
  ).run(createUlid(), work.data.work_id, now, now);
  await rename(dir, join(base, "gone"));
  await core.checkKnowledgeStorage();
  await core.learningPipeline.processPendingNow();
  const row = db.get("SELECT status, attempts FROM learning_jobs");
  assert.deepEqual({ status: row.status, attempts: row.attempts }, { status: "pending", attempts: 0 });
});

test("move switches Core and every KnowledgeBase on the same provider without a restart", async (t) => {
  const { base, dir, core, stored } = await setup(t);
  await core.start();
  await core.knowledge.create({ folder: "global", filename: "a.md", tags: ["x"], ...clip("alpha") });
  await core.knowledge.create({ folder: "projects", filename: "b.md", tags: [], ...clip("beta") });
  const before = await readFile(join(dir, "global", "a.md"));
  await utimes(join(dir, "global", "a.md"), 1_700_000_000, 1_700_000_000);
  const mtime = (await stat(join(dir, "global", "a.md"))).mtimeMs;
  const other = new KnowledgeBase(base, { rootDir: () => core.activeKnowledgeDir() });
  const target = join(base, "moved-kb");

  const result = await core.moveKnowledgeStorage({ path: target });

  assert.equal(stored.value, target);
  assert.equal(core.activeKnowledgeDir(), target);
  assert.equal(result.status.state, "available");
  assert.deepEqual(result.warnings, []);
  assert.equal((await stat(join(target, ".owl-knowledge"))).isFile(), true);
  assert.deepEqual(await readFile(join(target, "global", "a.md")), before);
  assert.equal((await stat(join(target, "global", "a.md"))).mtimeMs, mtime);
  await assert.rejects(stat(dir), /ENOENT/u, "the emptied source is removed");
  assert.equal((await other.list()).length, 2);
  assert.equal((await core.knowledge.list()).length, 2);
  await core.memorySaver.saveExplicitMemory("after the move");
  assert.ok((await listFiles(target)).some((file) => file.startsWith("common/")));
  assert.equal(core.getKnowledgeStorage().last_move.to, target);
});

test("move rejects unusable targets and leaves the source untouched", async (t) => {
  const { base, dir, owlRoot, dataDir, core } = await setup(t);
  await core.start();
  await core.knowledge.create({ folder: "global", filename: "a.md", tags: [], ...clip("alpha") });
  await mkdir(dataDir, { recursive: true });
  const nonEmpty = join(base, "full");
  await mkdir(nonEmpty);
  await writeFile(join(nonEmpty, "x.txt"), "x");
  const aFile = join(base, "file.txt");
  await writeFile(aFile, "x");
  const cases = [
    [nonEmpty, "not_empty"],
    [aFile, "not_directory"],
    [dir, "same_as_current"],
    [join(dir, "inside"), "nested"],
    [base, "nested"],
    [owlRoot, "reserved"],
    [join(dataDir, "kb"), "reserved"],
    [join(base, "missing-parent", "deeper"), null],
  ];
  for (const [path, reason] of cases) {
    if (reason === null) continue;
    await assert.rejects(core.moveKnowledgeStorage({ path }), (error) => error.code === "knowledge_target_invalid" && error.details.reason === reason, `${path} -> ${reason}`);
  }
  await assert.rejects(core.moveKnowledgeStorage({ path: "relative/path" }), (error) => error.code === "validation_error");
  await assert.rejects(core.moveKnowledgeStorage({ path: join(base, "x"), mode: "relink" }), (error) => error.details.reason === "relink_requires_unavailable");
  assert.equal(core.activeKnowledgeDir(), dir);
  assert.equal((await core.knowledge.list()).length, 1);
});

test("a copy failure mid-move keeps the source and setting and removes the partial copy", async (t) => {
  const base = await tempDir(t, "owl-kb-fail-");
  const source = join(base, "src");
  const target = join(base, "dst");
  await mkdir(join(source, "global"), { recursive: true });
  await writeFile(join(source, ".owl-knowledge"), "{}");
  for (const name of ["a", "b", "c"]) await writeFile(join(source, "global", `${name}.md`), name);
  const stored = { value: source };
  let copies = 0;
  const fs = await import("node:fs/promises");
  const location = new KnowledgeLocation({
    owlRoot: join(base, "root"), dataDir: join(base, "data"),
    persistence: { read: () => stored.value, write: (v) => { stored.value = v; } },
    fs: { ...fs, copyFile: async (...args) => { copies += 1; if (copies === 3) throw new Error("disk full"); return copyFile(...args); } },
  });
  await location.initialize();
  t.after(() => location.stop());

  await assert.rejects(location.move({ path: target, mode: "move" }), (error) =>
    error.code === "knowledge_move_failed" && error.details.stage === "copying" && error.details.source_intact === true && error.details.target_cleaned === true);

  assert.equal(stored.value, source);
  assert.equal(location.status().state, "available");
  assert.equal(location.activeDir(), source);
  assert.deepEqual(await listFiles(source), [".owl-knowledge", "global/a.md", "global/b.md", "global/c.md"]);
  await assert.rejects(stat(target), /ENOENT/u, "the created target is removed again");
});

test("a move never uses rename between source and target (EXDEV-safe) and a checksum mismatch aborts it", async (t) => {
  const base = await tempDir(t, "owl-kb-exdev-");
  const source = join(base, "src");
  await mkdir(join(source, "notes"), { recursive: true });
  await writeFile(join(source, ".owl-knowledge"), "{}");
  await writeFile(join(source, "notes", "n.md"), "note");
  const stored = { value: source };
  const fs = await import("node:fs/promises");
  const calls = [];
  const location = new KnowledgeLocation({
    owlRoot: join(base, "root"), dataDir: join(base, "data"),
    persistence: { read: () => stored.value, write: (v) => { stored.value = v; } },
    fs: { ...fs, rename: async () => { calls.push("rename"); const error = new Error("cross-device"); error.code = "EXDEV"; throw error; } },
  });
  await location.initialize();
  t.after(() => location.stop());
  const target = join(base, "dst");
  const result = await location.move({ path: target, mode: "move" });
  assert.deepEqual(calls, []);
  assert.equal(result.moved.files, 1);
  assert.equal(await readFile(join(target, "notes", "n.md"), "utf8"), "note");

  // Corrupt the copy after it was written: verification must reject it.
  const back = join(base, "back");
  const corrupting = new KnowledgeLocation({
    owlRoot: join(base, "root"), dataDir: join(base, "data"),
    persistence: { read: () => stored.value, write: (v) => { stored.value = v; } },
    fs: { ...fs, utimes: async (path, ...rest) => { await fs.writeFile(path, "XXXX"); return fs.utimes(path, ...rest); } },
  });
  await corrupting.initialize();
  t.after(() => corrupting.stop());
  await assert.rejects(corrupting.move({ path: back, mode: "move" }), (error) => error.details.stage === "verifying");
  assert.equal(stored.value, target);
  assert.equal(await readFile(join(target, "notes", "n.md"), "utf8"), "note");
});

test("an unlink failure during clean-up is a warning, not a failed move", async (t) => {
  const base = await tempDir(t, "owl-kb-warn-");
  const source = join(base, "src");
  await mkdir(source);
  await writeFile(join(source, ".owl-knowledge"), "{}");
  await writeFile(join(source, "stay.md"), "stay");
  const stored = { value: source };
  const fs = await import("node:fs/promises");
  const location = new KnowledgeLocation({
    owlRoot: join(base, "root"), dataDir: join(base, "data"),
    persistence: { read: () => stored.value, write: (v) => { stored.value = v; } },
    fs: { ...fs, unlink: async (path) => { if (String(path).endsWith("stay.md") && String(path).startsWith(source)) throw Object.assign(new Error("busy"), { code: "EBUSY" }); return fs.unlink(path); } },
  });
  await location.initialize();
  t.after(() => location.stop());
  const target = join(base, "dst");
  const result = await location.move({ path: target, mode: "move" });
  assert.equal(result.warnings[0].code, "source_cleanup_incomplete");
  assert.equal(stored.value, target);
  assert.equal(await readFile(join(source, "stay.md"), "utf8"), "stay");
});

test("writes wait while a move is copying and land in the new storage; nested leases do not deadlock", async (t) => {
  const base = await tempDir(t, "owl-kb-lease-");
  const source = join(base, "src");
  await mkdir(source);
  await writeFile(join(source, ".owl-knowledge"), "{}");
  await writeFile(join(source, "a.md"), "a");
  const stored = { value: source };
  const fs = await import("node:fs/promises");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let copying;
  const inCopy = new Promise((resolve) => { copying = resolve; });
  const location = new KnowledgeLocation({
    owlRoot: join(base, "root"), dataDir: join(base, "data"),
    persistence: { read: () => stored.value, write: (v) => { stored.value = v; } },
    fs: { ...fs, copyFile: async (...args) => { copying(); await gate; return fs.copyFile(...args); } },
  });
  await location.initialize();
  t.after(() => location.stop());
  const target = join(base, "dst");
  const moving = location.move({ path: target, mode: "move" });
  await inCopy;
  assert.equal(location.status().state, "moving");
  let wroteTo = null;
  const write = location.withWrite(async () => {
    wroteTo = location.activeDir();
    return location.withWrite(async () => "nested");
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(wroteTo, null, "the write waits for the move");
  release();
  await moving;
  assert.equal(await write, "nested");
  assert.equal(wroteTo, target);
});

test("an interrupted move is reported on start and a finished-but-not-cleaned one is cleaned up", async (t) => {
  const base = await tempDir(t, "owl-kb-journal-");
  const dataDir = join(base, "data");
  await mkdir(dataDir);
  const source = join(base, "src");
  const target = join(base, "dst");
  await mkdir(source);
  await mkdir(target);
  await writeFile(join(source, "old.md"), "old");
  await writeFile(join(target, ".owl-knowledge"), "{}");
  await writeFile(join(target, "old.md"), "old");
  const journal = (stage) => JSON.stringify({ move_id: "m", source, target, mode: "move", created_target: false, stage, started_at: "2026-01-01T00:00:00.000Z" });

  await writeFile(join(dataDir, "knowledge-move.json"), journal("copying"));
  const untouched = new KnowledgeLocation({ owlRoot: join(base, "root"), dataDir, persistence: { read: () => source, write() {} } });
  const status = await untouched.initialize();
  await untouched.stop();
  assert.equal(status.interrupted_move.stage, "copying");
  assert.equal(untouched.path, source);
  assert.equal((await stat(target)).isDirectory(), true);
  await assert.rejects(stat(join(dataDir, "knowledge-move.json")), /ENOENT/u);

  await mkdir(source, { recursive: true }).catch(() => undefined);
  await writeFile(join(source, "old.md"), "old");
  await writeFile(join(dataDir, "knowledge-move.json"), journal("cleaning_up"));
  const switched = new KnowledgeLocation({ owlRoot: join(base, "root"), dataDir, persistence: { read: () => target, write() {} } });
  await switched.initialize();
  await switched.stop();
  await assert.rejects(stat(source), /ENOENT/u, "the old copy was cleaned up");
  assert.equal(await readFile(join(target, "old.md"), "utf8"), "old");
  await assert.rejects(stat(join(dataDir, "knowledge-move.json")), /ENOENT/u);
});

test("retag items keep summary and claims separate and drop whole claims from the end over the limit", async () => {
  const { clipSummaryAndClaims } = await import("../../packages/core/dist/knowledge-retag.js");
  assert.deepEqual(clipSummaryAndClaims("sum", ["aaaa", "bbbb", "cc"], 11), { summary: "sum", claims: ["aaaa", "bbbb"] });
  assert.deepEqual(clipSummaryAndClaims("sum", ["aaaa"], 2), { summary: "su", claims: [] });
});

test("retag passes summary and claims as separate unmodified fields", async (t) => {
  const { dir, core } = await setup(t, { name: "retag-fields" });
  await core.start();
  const text = 'first line\n"quoted" claim';
  await seedNote(core.knowledgeNotes, { topic: "retag fields", kind: "fact", text, work_id: WORK_A });
  let seen = [];
  await core.retagKnowledgeNotes({ knowledge_dir: dir, dry_run: true, extract: async (items) => { seen = items; return { ok: true, items: [] }; } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].summary, text);
  assert.deepEqual(seen[0].claims, [text]);
  assert.equal("text" in seen[0], false);
});
