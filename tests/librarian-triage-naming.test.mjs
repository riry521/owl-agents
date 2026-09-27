import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

import { KnowledgeBase } from "../packages/core/dist/knowledge-base.js";
import { KnowledgeNotes } from "../packages/core/dist/knowledge-notes.js";
import { Librarian } from "../packages/core/dist/librarian.js";
import { slugifyKnowledgeContent } from "../packages/core/dist/knowledge-naming.js";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-librarian-triage-naming-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const knowledge = new KnowledgeBase(root);
  await knowledge.ensureDirectories();
  return { knowledge, librarian: new Librarian(knowledge) };
}

function dbFor(messages, conversationId) {
  return {
    all(sql) {
      if (sql.includes("SELECT c.id FROM conversations")) return [{ id: conversationId }];
      if (sql.includes("SELECT id, body, provider, created_at FROM messages")) return messages;
      return [];
    },
  };
}

test("triage skips an un-sluggable first line and uses the next slugifiable message line", async (t) => {
  const { librarian, knowledge } = await setup(t);
  const messages = [
    { id: "m1", body: "!!!\nPreserve recovery guidelines", provider: "user", created_at: "2026-01-01" },
    { id: "m2", body: "Use a durable retry interval", provider: "web", created_at: "2026-01-02" },
  ];

  await librarian.triageConversations(dbFor(messages, "conversation-one"));

  const files = await readdir(join(knowledge.knowledgeDir, "advisor", "conversations"));
  assert.deepEqual(files, ["preserve-recovery-guidelines.md"]);
});

test("triage uses an advisor hash when every message line is un-sluggable", async (t) => {
  const { librarian, knowledge } = await setup(t);
  const messages = [
    { id: "m1", body: "!!!\n🔐", provider: "user", created_at: "2026-01-01" },
    { id: "m2", body: "💥\n???", provider: "web", created_at: "2026-01-02" },
  ];
  const rawText = messages.map((message) => message.body).join("\n");

  await librarian.triageConversations(dbFor(messages, "conversation-two"));

  const files = await readdir(join(knowledge.knowledgeDir, "advisor", "conversations"));
  assert.deepEqual(files, [`${slugifyKnowledgeContent(rawText, "advisor")}.md`]);
  assert.match(basename(files[0]), /^advisor-[a-f0-9]{8}\.md$/u);
  assert.doesNotMatch(files[0], /tags|created|\d{4}-\d{2}-\d{2}/u);
});

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
