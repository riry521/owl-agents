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
