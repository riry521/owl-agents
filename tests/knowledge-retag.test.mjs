import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Core } from "../packages/core/dist/core.js";
import { openDatabase } from "../packages/db/dist/index.js";

import { KnowledgeBase } from "../packages/core/dist/knowledge-base.js";
import { KnowledgeNotes } from "../packages/core/dist/knowledge-notes.js";
import { retagKnowledge } from "../packages/core/dist/knowledge-retag.js";
import { isValidTag, mergeTagSets, sanitizeKeywords } from "../packages/core/dist/knowledge-tags.js";

const FRAGMENTS = ["から起動するエージェントのコンテキストに", "エージェント起動時の", "の読み込み内容を制御する", "や設定を", "をオーバーレイして", "環境で", "要約する前に", "関係のない失敗が出たとき", "起動時に使う設定", "日本語の題名から", "review the log", "fix the bug"];

test("sentence fragments are invalid tags and real keywords are valid", () => {
  for (const fragment of FRAGMENTS) assert.equal(isValidTag(fragment), false, fragment);
  for (const tag of ["canary", "sqlite-migration", "レビュー", "エージェント", "codex", "advisor", "work-lessons", "読み込み", "タグ付け", "引き継ぎ"]) assert.equal(isValidTag(tag), true, tag);
  assert.deepEqual(sanitizeKeywords(["A", "a", "b", "c", "d", "e", "f"]), ["a", "b", "c", "d", "e"]);
  assert.equal(mergeTagSets(["a", "b", "c", "d"], ["c", "e", "f"]).length, 5);
});

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "owl-retag-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "root");
  const knowledge = new KnowledgeBase(root);
  await knowledge.ensureDirectories();
  const notes = new KnowledgeNotes(knowledge, { now: () => "2026-09-01T00:00:00.000Z" });
  const bad = await notes.mergeClaim({ topic: "Canary detection", kind: "fact", text: "Canary checks catch false positives.", work_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", project_id: null, tags: [] });
  await notes.setTags(bad.note_id, ["auto-saved", ...FRAGMENTS]);
  const good = await notes.mergeClaim({ topic: "Unrelated good note", kind: "fact", text: "Something else entirely.", work_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", project_id: null, tags: ["alpha", "beta", "gamma"] });
  const backupRoot = join(parent, "backups");
  await mkdir(backupRoot);
  return { knowledge, notes, backupRoot, bad: bad.note_id, good: good.note_id };
}

test("retag re-extracts unrecorded notes even with valid-looking tags, records them, and is idempotent", async (t) => {
  const f = await fixture(t);
  const calls = [];
  const extract = async (items) => {
    calls.push(items.map((item) => item.id));
    return { ok: true, items: items.map((item) => ({ id: item.id, keywords: ["canary", "検出", "誤検知", "や設定を"] })) };
  };
  const before = await f.notes.get(f.bad);

  const dry = await retagKnowledge({ ...f, extract, dry_run: true });
  assert.equal(dry.scanned, 2);
  assert.equal(dry.targeted, 2, "the note with valid old tags is targeted too");
  assert.equal(dry.changes.length, 2);
  assert.ok(dry.changes.every((change) => /^notes\/.+\.md$/u.test(change.path)));
  assert.equal(dry.backup_path, null);
  assert.deepEqual(await readdir(f.backupRoot), []);
  assert.equal((await f.notes.get(f.bad)).tags.length, before.tags.length);
  assert.deepEqual((await f.notes.get(f.good)).tags, ["alpha", "beta", "gamma"]);
  assert.equal((await f.notes.get(f.good)).tags_source, undefined, "dry run records nothing");

  const run = await retagKnowledge({ ...f, extract, dry_run: false });
  assert.deepEqual(run.failed, []);
  assert.ok(run.backup_path);
  assert.equal((await readdir(join(run.backup_path, "notes"))).length, 2);
  const after = await f.notes.get(f.bad);
  assert.deepEqual(after.tags, ["auto-saved", "canary", "検出", "誤検知"]);
  assert.equal(after.updated, before.updated);
  assert.equal(after.tags_source, "keywords");
  const old = await f.notes.get(f.good);
  assert.deepEqual(old.tags, ["canary", "検出", "誤検知"]);
  assert.equal(old.tags_source, "keywords");

  const callsBefore = calls.length;
  const again = await retagKnowledge({ ...f, extract, dry_run: false });
  assert.equal(again.targeted, 0);
  assert.equal(calls.length, callsBefore, "a rerun makes no AI call");
  assert.equal(again.backup_path, null);

  const forced = await retagKnowledge({ ...f, extract, dry_run: true, force: true });
  assert.equal(forced.targeted, 2, "force targets recorded notes too");
});

test("a note whose tags do not change is still recorded by a real run, and the record survives note updates", async (t) => {
  const f = await fixture(t);
  const extract = async (items) => ({ ok: true, items: items.map((item) => ({ id: item.id, keywords: ["alpha", "beta", "gamma"] })) });
  const dry = await retagKnowledge({ ...f, extract, dry_run: true });
  assert.equal(dry.unchanged.length, 1);
  assert.equal((await f.notes.get(f.good)).tags_source, undefined);
  const run = await retagKnowledge({ ...f, extract, dry_run: false });
  assert.equal(run.unchanged.length, 1);
  assert.ok(run.backup_path, "writing a record needs the backup first");
  assert.equal((await f.notes.get(f.good)).tags_source, "keywords");
  await f.notes.setTags(f.good, ["alpha", "beta", "gamma", "delta"]);
  await f.notes.mergeClaim({ topic: "Unrelated good note", kind: "fact", text: "Another claim.", work_id: "01ARZ3NDEKTSV4RRFFQ69G5FAX", project_id: null, tags: ["epsilon"] });
  const kept = await f.notes.get(f.good);
  assert.equal(kept.tags_source, "keywords");
  assert.ok(kept.tags.length <= 5);
  assert.equal((await retagKnowledge({ ...f, extract, dry_run: false })).targeted, 0);
});

test("a failed or insufficient extraction leaves no record and the note is targeted again", async (t) => {
  const f = await fixture(t);
  const flaky = async (items) => ({ ok: true, items: items.filter((item) => item.id === f.bad).map((item) => ({ id: item.id, keywords: ["canary", "検出", "誤検知"] })) });
  const first = await retagKnowledge({ ...f, extract: flaky, dry_run: false });
  assert.deepEqual(first.failed.map((entry) => entry.error), ["keywords_insufficient"]);
  assert.equal((await f.notes.get(f.bad)).tags_source, "keywords");
  assert.equal((await f.notes.get(f.good)).tags_source, undefined);
  assert.deepEqual((await f.notes.get(f.good)).tags, ["alpha", "beta", "gamma"]);
  const second = await retagKnowledge({ ...f, extract: flaky, dry_run: true });
  assert.equal(second.targeted, 1);
});

test("retag writes nothing when extraction fails or the backup cannot be made", async (t) => {
  const f = await fixture(t);
  await assert.rejects(retagKnowledge({ ...f, extract: async () => ({ ok: false, error: "boom" }), dry_run: false }), /retag_extraction_failed/u);
  await assert.rejects(
    retagKnowledge({
      ...f,
      backupRoot: "/dev/null/nope",
      extract: async (items) => ({ ok: true, items: items.map((item) => ({ id: item.id, keywords: ["canary", "検出", "誤検知"] })) }),
      dry_run: false,
    }),
    /retag_backup_failed/u,
  );
  assert.equal((await f.notes.get(f.bad)).tags.length, 13);
});

test("retag never writes an unusable extraction: missing ids and fewer than 3 valid keywords are failures", async (t) => {
  const f = await fixture(t);
  const report = await retagKnowledge({
    ...f,
    dry_run: false,
    extract: async (items) => ({ ok: true, items: items.filter((item) => item.id === f.bad).map((item) => ({ id: item.id, keywords: ["canary", "や設定を", "起動時に使う設定"] })) }),
  });
  assert.equal(report.failed.length, 2);
  assert.equal(report.failed[0].error, "keywords_insufficient");
  assert.equal(report.changes.length, 0);
  assert.equal(report.backup_path, null);
  assert.equal((await f.notes.get(f.bad)).tags.length, 13);
  assert.deepEqual((await f.notes.get(f.good)).tags, ["alpha", "beta", "gamma"]);
  assert.equal((await f.notes.get(f.bad)).tags_source, undefined);
});

test("Core.retagKnowledgeNotes retags the directory it is given, using the agent runner extraction", async (t) => {
  const f = await fixture(t);
  const root = join(f.knowledge.knowledgeDir, "..");
  const db = openDatabase(join(root, "owl.sqlite"));
  t.after(() => db.close());
  db.migrate(fileURLToPath(new URL("../packages/db/migrations", import.meta.url)));
  const seen = [];
  const core = new Core({
    db, version: "retag-test", owlRoot: join(root, "other-root"), dataDir: join(root, "data"),
    agentRunner: { runKeywordExtraction: async ({ items }) => { seen.push(items.length); return { ok: true, items: items.map((item) => ({ id: item.id, keywords: ["canary", "検出", "誤検知"] })) }; } },
  });
  await assert.rejects(core.retagKnowledgeNotes({ knowledge_dir: "relative/knowledge", dry_run: true }), /knowledge_dir/u);
  const dry = await core.retagKnowledgeNotes({ knowledge_dir: f.knowledge.knowledgeDir, dry_run: true });
  assert.equal(dry.changes.length, 2);
  const run = await core.retagKnowledgeNotes({ knowledge_dir: f.knowledge.knowledgeDir, dry_run: false });
  assert.ok(run.backup_path.startsWith(join(root, "data", "backups")));
  assert.deepEqual((await f.notes.get(f.bad)).tags, ["auto-saved", "canary", "検出", "誤検知"]);
  assert.deepEqual(seen, [2, 2]);
});
