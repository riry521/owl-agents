import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeBase } from "../packages/core/dist/knowledge-base.js";
import { KnowledgeNotes } from "../packages/core/dist/knowledge-notes.js";

const WORK_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const WORK_B = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const WORK_C = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "owl-knowledge-notes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notes = new KnowledgeNotes(new KnowledgeBase(root), options);
  return { root, notes };
}

test("parse(render(note)) preserves the full note including Rule promotion", async (t) => {
  const { notes } = await setup(t);
  const note = {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    title: "SQLite retry policy",
    slug: "sqlite-retry-policy",
    tags: ["database", "retry"],
    sources: [WORK_A],
    links: ["01ARZ3NDEKTSV4RRFFQ69G5FBA"],
    project_ids: [PROJECT],
    created: "2026-09-26T09:00:00.000Z",
    updated: "2026-09-26T10:30:00.000Z",
    summary: "Retry database operations with bounded backoff.",
    claims: [{
      fingerprint: "9f86d081884c7d65",
      kind: "fact",
      text: "test",
      sources: [WORK_A],
    }],
    promotions: [{
      date: "2026-09-26",
      proposal_id: "01ARZ3NDEKTSV4RRFFQ69G5FBB",
      status: "applied",
      path: "rules/system/retry.yaml#owl-01ARZ3NDEKTSV4RRFFQ69G5FBB",
    }],
  };

  assert.deepEqual(notes.parse(notes.render(note)), note);
});

test("merging the same claim twice keeps one claim and unions its sources", async (t) => {
  const { notes } = await setup(t, { minTopicScore: 3, minTopicScoreGap: 2 });
  const first = await notes.mergeClaim({
    topic: "SQLite retry policy",
    kind: "fact",
    text: "Retry database operations with bounded backoff.",
    work_id: WORK_A,
    project_id: PROJECT,
    tags: ["database", "retry"],
  });
  const second = await notes.mergeClaim({
    topic: "SQLite retry policy",
    kind: "fact",
    text: "Retry database operations with bounded backoff.",
    work_id: WORK_B,
    project_id: PROJECT,
    tags: ["database", "retry"],
  });

  const note = await notes.get(first.note_id);
  assert.equal(first.created, true);
  assert.equal(second.note_id, first.note_id);
  assert.equal(second.added, false);
  assert.equal(note.claims.length, 1);
  assert.deepEqual(note.claims[0].sources, [WORK_A, WORK_B]);
  assert.deepEqual(note.sources, [WORK_A, WORK_B]);
});

test("merging a quote-leading claim preserves quotes and backslashes when parsed from disk", async (t) => {
  const { root, notes } = await setup(t);
  const text = '"Quoted" retry policy. Preserve C:\\sqlite\\db path.';
  await notes.mergeClaim({
    topic: "Quoted retry policy",
    kind: "fact",
    text,
    work_id: WORK_A,
    project_id: null,
    tags: [],
  });

  const saved = await readFile(join(root, "knowledge", "notes", "quoted-retry-policy.md"), "utf8");
  assert.equal(notes.parse(saved).claims[0].text, text);
});

test("ambiguous topic matching creates a note and links both candidates bidirectionally", async (t) => {
  const { notes } = await setup(t, { minTopicScore: 3, minTopicScoreGap: 2 });
  const first = await notes.mergeClaim({
    topic: "database retry window",
    kind: "fact",
    text: "Retry window controls delayed database recovery.",
    work_id: WORK_A,
    project_id: null,
    tags: [],
  });
  const second = await notes.mergeClaim({
    topic: "filesystem lock recovery",
    kind: "pitfall",
    text: "Filesystem lock recovery handles stale leases.",
    work_id: WORK_B,
    project_id: null,
    tags: [],
  });

  const created = await notes.mergeClaim({
    topic: "database filesystem retry lock recovery",
    kind: "decision",
    text: "Database filesystem retry lock recovery across projects.",
    work_id: WORK_C,
    project_id: null,
    tags: [],
  });

  assert.equal(created.created, true);
  const newNote = await notes.get(created.note_id);
  const firstNote = await notes.get(first.note_id);
  const secondNote = await notes.get(second.note_id);
  assert.ok(newNote.links.includes(first.note_id));
  assert.ok(newNote.links.includes(second.note_id));
  assert.ok(firstNote.links.includes(created.note_id));
  assert.ok(secondNote.links.includes(created.note_id));
});

test("note writes use one final markdown file and leave no temporary file", async (t) => {
  const { root, notes } = await setup(t);
  const result = await notes.mergeClaim({
    topic: "Atomic file update",
    kind: "fact",
    text: "Write a complete note before replacing its previous version.",
    work_id: WORK_A,
    project_id: null,
    tags: ["atomic", "file"],
  });
  const files = await readdir(join(root, "knowledge", "notes"));

  assert.deepEqual(files, ["atomic-file-update.md"]);
  const saved = await readFile(join(root, "knowledge", "notes", files[0]), "utf8");
  assert.equal(notes.parse(saved).id, result.note_id);
  assert.doesNotMatch(files[0], /\.tmp/u);
});

test("a Japanese topic never produces sentence-fragment tags and merged tags stay within five", async (t) => {
  const { notes } = await setup(t, { minTopicScore: 1, minTopicScoreGap: 0 });
  const topic = "から起動するエージェントのコンテキストに反映する";
  const first = await notes.mergeClaim({
    topic, kind: "fact", text: "Agents read the context on start.", work_id: WORK_A, project_id: PROJECT,
    tags: ["agent", "context", "から起動するエージェントのコンテキストに"],
  });
  assert.deepEqual((await notes.get(first.note_id)).tags, ["agent", "context"]);

  const merged = await notes.mergeClaim({
    topic, kind: "fact", text: "A second claim on the same topic.", work_id: WORK_B, project_id: PROJECT,
    tags: ["t1", "t2", "t3", "t4", "t5"],
  });
  assert.equal(merged.note_id, first.note_id);
  assert.ok((await notes.get(first.note_id)).tags.length <= 5);
});

test("mergeNotes keeps the union of tags at five or fewer", async (t) => {
  const { notes } = await setup(t, { minTopicScore: 100 });
  const a = await notes.mergeClaim({ topic: "Alpha topic", kind: "fact", text: "alpha claim", work_id: WORK_A, project_id: PROJECT, tags: ["a1", "a2", "a3", "shared"] });
  const b = await notes.mergeClaim({ topic: "Beta topic", kind: "fact", text: "beta claim", work_id: WORK_B, project_id: PROJECT, tags: ["b1", "b2", "b3", "shared"] });
  assert.notEqual(a.note_id, b.note_id);
  await notes.mergeNotes(a.note_id, b.note_id);
  const tags = (await notes.get(a.note_id)).tags;
  assert.equal(tags.length, 5);
  assert.ok(tags.includes("shared"));
});

test("the tags_source record is written for new keyword-tagged notes and survives update, merge and setTags", async (t) => {
  const { root, notes } = await setup(t);
  const a = await notes.mergeClaim({ topic: "Alpha topic", kind: "fact", text: "Alpha claim text.", work_id: WORK_A, project_id: null, tags: ["one", "two", "three"], tags_source: "keywords" });
  const b = await notes.mergeClaim({ topic: "Beta subject", kind: "fact", text: "Beta claim text.", work_id: WORK_B, project_id: null, tags: ["four", "five", "six"] });
  assert.match(await readFile(join(root, "knowledge", "notes", (await readdir(join(root, "knowledge", "notes"))).find((f) => f.startsWith("alpha"))), "utf8"), /^tags_source: keywords$/mu);
  assert.equal((await notes.get(a.note_id)).tags_source, "keywords");
  assert.equal((await notes.get(b.note_id)).tags_source, undefined);

  await notes.mergeClaim({ topic: "Alpha topic", kind: "fact", text: "Second alpha claim.", work_id: WORK_C, project_id: null, tags: ["seven", "eight"] });
  await notes.setTags(a.note_id, ["one", "two", "three"]);
  assert.equal((await notes.get(a.note_id)).tags_source, "keywords");
  await notes.mergeNotes(a.note_id, b.note_id);
  const merged = await notes.get(a.note_id);
  assert.equal(merged.tags_source, "keywords");
  assert.ok(merged.tags.length <= 5);
  await notes.setTags(b.note_id, ["four", "five", "six"], true);
  assert.equal((await notes.get(b.note_id)).tags_source, "keywords");
});
