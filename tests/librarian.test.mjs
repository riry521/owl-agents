import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeBase } from "../packages/core/dist/knowledge-base.js";
import { KnowledgeNotes } from "../packages/core/dist/knowledge-notes.js";
import { Librarian } from "../packages/core/dist/librarian.js";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-librarian-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const knowledge = new KnowledgeBase(root);
  await knowledge.ensureDirectories();
  return { knowledge, librarian: new Librarian(knowledge) };
}

test("hot.md includes knowledge notes as a source", async (t) => {
  const { librarian, knowledge } = await setup(t);
  let now = "2026-09-01T00:00:00.000Z";
  const notes = new KnowledgeNotes(knowledge, { now: () => now });
  await notes.mergeClaim({
    topic: "SQLite retry policy",
    kind: "fact",
    text: "Retry database operations with bounded backoff.",
    work_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    project_id: null,
    tags: ["database", "retry"],
  });
  await notes.mergeClaim({
    topic: "SQLite retry policy",
    kind: "fact",
    text: "Retry database operations with bounded backoff.",
    work_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    project_id: null,
    tags: ["database", "retry"],
  });
  now = "2026-09-27T00:00:00.000Z";
  await notes.mergeClaim({
    topic: "Release checklist",
    kind: "fact",
    text: "Document release commands carefully.",
    work_id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    project_id: null,
    tags: ["release"],
  });

  await librarian.run();

  const hot = await knowledge.get("hot.md");
  assert.match(hot.body, /\[\[notes\/sqlite-retry-policy\]\]/u);
  assert.ok(hot.body.indexOf("notes/sqlite-retry-policy") < hot.body.indexOf("notes/release-checklist"));
});
