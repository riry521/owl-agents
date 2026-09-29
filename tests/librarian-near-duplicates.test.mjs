import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeBase } from "../packages/core/dist/knowledge-base.js";
import { KnowledgeNotes } from "../packages/core/dist/knowledge-notes.js";
import { Librarian } from "../packages/core/dist/librarian.js";

const WORK_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const WORK_B = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

// Claim texts copied from the real knowledge/notes/canary-*.md notes.
const CANARY_VERIFY =
  "指示ファイルの除外を canary で検証するときは、hook の出力や CLI の help にも出る文字列を user canary にしてはいけない。判定もモデルの最終応答だけで行う。出力ログ全体への grep で判定すると、誤検知と本当の漏れを区別できない。";
const CANARY_SELECT =
  "canary を使った実セッション検証では、ユーザー側の目印に既存の文字列(例: 'RTK - Rust Token Killer')を使うと、hook の出力やモデルの一般知識と区別できず、誤検知が起きる。同じ構成でも Task によって判定が逆になった。";

async function setup(t, notesOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "owl-librarian-near-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const knowledge = new KnowledgeBase(root);
  await knowledge.ensureDirectories();
  // A high topic threshold keeps write-time matching out of the way so both notes are created.
  const notes = new KnowledgeNotes(knowledge, { minTopicScore: 1000, ...notesOptions });
  return { root, knowledge, notes, librarian: new Librarian(knowledge) };
}

async function addNote(notes, topic, text, tags, work_id) {
  return notes.mergeClaim({ topic, kind: "pitfall", text, work_id, project_id: null, tags });
}

test("real-data canary notes are merged, the source leaves knowledge/ and wiki links follow", async (t) => {
  const { root, knowledge, notes, librarian } = await setup(t);
  const a = await addNote(notes, "canary 検証の誤検知", CANARY_VERIFY, ["canary", "task"], WORK_A);
  const b = await addNote(notes, "canary 選定の誤検知", CANARY_SELECT, ["canary", "task"], WORK_B);
  assert.notEqual(a.note_id, b.note_id);
  const files = (await readdir(join(knowledge.knowledgeDir, "notes"))).filter((f) => f.endsWith(".md"));
  await writeFile(
    join(knowledge.knowledgeDir, "Home.md"),
    files.map((f) => `- [[notes/${f.replace(/\.md$/, "")}]]`).join("\n") + "\n",
  );

  const report = await librarian.run({ runId: "run-1" });

  assert.equal(report.merged.length, 1);
  assert.equal(report.merged[0].reason, "near_duplicate");
  assert.ok(report.merged[0].archived_path.startsWith(join(root, "data", "backups", "knowledge-merged", "run-1")));
  const remaining = (await readdir(join(knowledge.knowledgeDir, "notes"))).filter((f) => f.endsWith(".md"));
  assert.equal(remaining.length, 1);
  assert.equal((await notes.list())[0].claims.length, 2);
  const home = await readFile(join(knowledge.knowledgeDir, "Home.md"), "utf8");
  assert.equal(home.trim(), `- [[notes/${remaining[0].replace(/\.md$/, "")}]]`);
  const hot = await readFile(join(knowledge.knowledgeDir, "hot.md"), "utf8");
  assert.equal(hot.includes(`notes/${files.find((f) => f !== remaining[0]).replace(/\.md$/, "")}`), false);
});

test("similar titles without overlapping claim text are not merged and the reason is recorded", async (t) => {
  const { notes, librarian } = await setup(t);
  await addNote(notes, "canary 検証の誤検知", CANARY_VERIFY, ["canary", "task"], WORK_A);
  await addNote(notes, "canary 選定の誤検知", "新しい実装では 'foo' と 'bar' を設定ファイルから読み込み、キャッシュの有効期限を延長する。", ["canary", "task"], WORK_B);

  const report = await librarian.run();

  assert.equal(report.merged.length, 0);
  assert.equal(report.merge_skipped.length, 1);
  assert.equal(report.merge_skipped[0].reason, "no_content_overlap");
  assert.equal(report.merge_skipped[0].paths.length, 2);
  assert.equal((await notes.list()).length, 2);
});

test("contradicting claims are not merged", async (t) => {
  const { notes, librarian } = await setup(t);
  await addNote(notes, "canary 検証の誤検知", CANARY_VERIFY.replace("にしてはいけない", "にしてよい").replace("区別できない", "区別できる"), ["canary", "task"], WORK_A);
  await addNote(notes, "canary 選定の誤検知", CANARY_VERIFY, ["canary", "task"], WORK_B);

  const report = await librarian.run();

  assert.equal(report.merged.length, 0);
  assert.equal(report.merge_skipped[0].reason, "possible_contradiction");
  assert.equal((await notes.list()).length, 2);
});

test("titles that differ too much are recorded as below the merge threshold", async (t) => {
  const { notes, librarian } = await setup(t);
  await addNote(notes, "canary 検証の誤検知", "alpha beta gamma", ["canary"], WORK_A);
  await addNote(notes, "canary 検証の手順", "delta epsilon zeta", ["canary"], WORK_B);

  const report = await librarian.run();

  assert.equal(report.merged.length, 0);
  assert.equal(report.merge_skipped[0].reason, "below_merge_threshold");
});

test("exact duplicate notes are retired too and a third copy is recorded as merged elsewhere", async (t) => {
  const { knowledge, notes, librarian } = await setup(t);
  const text = "Always run the migration dry run against a copy of the production database first.";
  await addNote(notes, "dry run first", text, ["a"], WORK_A);
  await addNote(notes, "database copy rule", text, ["b"], WORK_B);
  await addNote(notes, "prod db copy", text, ["c"], WORK_B);

  const report = await librarian.run();

  assert.equal(report.merged.length, 2);
  assert.equal((await readdir(join(knowledge.knowledgeDir, "notes"))).filter((f) => f.endsWith(".md")).length, 1);
});

test("pairs deferred by the entry limit are recorded with concrete paths", async (t) => {
  const { knowledge, notes } = await setup(t);
  const librarian = new Librarian(knowledge, { maxEntriesPerRun: 1 });
  await addNote(notes, "canary 検証の誤検知", CANARY_VERIFY, ["canary", "task"], WORK_A);
  await addNote(notes, "canary 選定の誤検知", CANARY_SELECT, ["canary", "task"], WORK_B);

  const report = await librarian.run();

  assert.equal(report.merged.length, 0);
  const item = report.merge_skipped.find((entry) => entry.reason === "entry_limit");
  assert.ok(item && item.paths[0].startsWith("notes/") && item.paths[1].startsWith("notes/"));
});
