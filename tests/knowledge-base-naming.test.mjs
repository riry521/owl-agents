import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeBase } from "../packages/core/dist/knowledge-base.js";

async function newKnowledgeBase(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-knowledge-base-naming-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const knowledge = new KnowledgeBase(root);
  await knowledge.ensureDirectories();
  return knowledge;
}

async function seedNote(knowledge, filename = "sample.md") {
  await mkdir(join(knowledge.knowledgeDir, "notes"), { recursive: true });
  await writeFile(
    join(knowledge.knowledgeDir, "notes", filename),
    "---\ntags: []\ncreated: 2026-09-26\n---\n# Note\n\nBody\n",
  );
  return `notes/${filename}`;
}

test("update rejects notes managed files", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const path = await seedNote(knowledge);

  await assert.rejects(knowledge.update(path, { body: "Changed" }), /^Error: notes_managed: notes\/sample\.md$/u);
});

test("remove rejects notes managed files", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const path = await seedNote(knowledge);

  await assert.rejects(knowledge.remove(path), /^Error: notes_managed: notes\/sample\.md$/u);
});

test("upsert rejects the notes folder before creating a managed note", async (t) => {
  const knowledge = await newKnowledgeBase(t);

  await assert.rejects(knowledge.upsert({
    folder: "notes",
    filename: "sample.md",
    tags: [],
    body: "Body",
  }), /^Error: notes_managed: notes$/u);
  assert.deepEqual(await readdir(join(knowledge.knowledgeDir, "notes")), []);
});

test("notes frontmatter titles are used by get, list, and search", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  await mkdir(join(knowledge.knowledgeDir, "notes"), { recursive: true });
  await writeFile(
    join(knowledge.knowledgeDir, "notes", "secret-elephant.md"),
    "---\ntitle: Secret Elephant\ntags: []\ncreated: 2026-09-26\n---\n\nA private note.\n",
  );

  const path = "notes/secret-elephant.md";
  assert.equal((await knowledge.get(path)).title, "Secret Elephant");
  assert.equal((await knowledge.list("notes")).find((entry) => entry.path === path)?.title, "Secret Elephant");
  const matches = await knowledge.search("Secret Elephant");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, path);
  assert.equal(matches[0].title, "Secret Elephant");
});

test("notes frontmatter titles restore JSON escapes for get, list, and search", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  await mkdir(join(knowledge.knowledgeDir, "notes"), { recursive: true });
  const title = '"Quoted" retry \\ policy';
  await writeFile(
    join(knowledge.knowledgeDir, "notes", "quoted-retry-policy.md"),
    `---\ntitle: ${JSON.stringify(title)}\ntags: []\ncreated: 2026-09-26\n---\n\nRetry safely.\n`,
  );

  const path = "notes/quoted-retry-policy.md";
  assert.equal((await knowledge.get(path)).title, title);
  assert.equal((await knowledge.list("notes")).find((entry) => entry.path === path)?.title, title);
  const matches = await knowledge.search(title);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, path);
  assert.equal(matches[0].title, title);
});

test("notes without a frontmatter title fall back to the filename", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const path = await seedNote(knowledge, "legacy-note.md");

  assert.equal((await knowledge.get(path)).title, "legacy-note");
  assert.equal((await knowledge.list("notes")).find((entry) => entry.path === path)?.title, "legacy-note");
});

test("saveWorkLessons updates the existing file for the same work ID, even when the title changes", async (t) => {
  const knowledge = await newKnowledgeBase(t);

  const first = await knowledge.saveWorkLessons("work-42", "SQLite lock retry", ["first lesson"]);
  const second = await knowledge.saveWorkLessons("work-42", "Retrying SQLite locks", ["updated lesson"]);

  assert.equal(second.path, first.path);
  assert.equal((await readdir(join(knowledge.knowledgeDir, "works"))).length, 1);
  assert.deepEqual(second.body, "updated lesson");
  const contents = await readFile(join(knowledge.knowledgeDir, second.path), "utf8");
  assert.match(contents, /work_id: work-42\n/u);
  assert.match(contents, /updated lesson/u);
});

test("saveWorkLessons gives a different work ID the next suffix without changing the first entry", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const first = await knowledge.saveWorkLessons("work-42", "SQLite lock retry", ["first lesson"]);

  const second = await knowledge.saveWorkLessons("work-77", "SQLite lock retry", ["second lesson"]);

  assert.equal(second.path, "works/sqlite-lock-retry-2.md");
  assert.equal((await knowledge.get(first.path)).body.trim(), "first lesson");
  assert.equal((await knowledge.get(second.path)).body.trim(), "second lesson");
  assert.deepEqual((await readdir(join(knowledge.knowledgeDir, "works"))).sort(), [
    "sqlite-lock-retry-2.md",
    "sqlite-lock-retry.md",
  ]);
});

test("saveWorkLessons uses the lesson body when the title has no slug", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const workId = "01J8Y3Q8K9M2N4P6R7T0V1W2X3";

  const entry = await knowledge.saveWorkLessons(workId, "", ["Retry database connection"]);

  assert.equal(entry.path, "works/retry-database-connection.md");
  assert.ok(!entry.path.includes(workId));
});

test("saveWorkLessons uses a body hash when neither title nor body has a slug", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const workId = "01J8Y3Q8K9M2N4P6R7T0V1W2X3";

  const entry = await knowledge.saveWorkLessons(workId, "", ["🔐"]);

  assert.match(entry.path, /^works\/note-[a-f0-9]{8}\.md$/u);
  assert.ok(!entry.path.includes(workId));
  assert.doesNotMatch(entry.path, /untitled|da39a3ee/u);
});

test("upsertBySource never derives a fallback filename from frontmatter in its body", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const body = "---\ntags: [advisor-conversation]\ncreated: 2026-09-25\n---\n\n## Q&A\n!!!\n";

  const withoutFallback = await knowledge.upsertBySource({
    folder: "advisor/conversations",
    title: "!!!",
    source: { key: "conversation_id", value: "frontmatter-only" },
    body,
    tags: ["advisor-conversation"],
  });
  assert.match(withoutFallback.path, /^advisor\/conversations\/note-[a-f0-9]{8}\.md$/u);
  assert.doesNotMatch(withoutFallback.path, /tags|created|2026/u);

  const withFallback = await knowledge.upsertBySource({
    folder: "advisor/conversations",
    title: "!!!",
    source: { key: "conversation_id", value: "raw-text" },
    body,
    nameFallback: "!!!\nRecover stale database connections",
    tags: ["advisor-conversation"],
  });
  assert.equal(withFallback.path, "advisor/conversations/recover-stale-database-connections.md");
});

test("concurrent create calls reserve the same filename exclusively", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const outcomes = await Promise.allSettled([
    knowledge.create({ folder: "works", filename: "same.md", tags: [], body: "alpha" }),
    knowledge.create({ folder: "works", filename: "same.md", tags: [], body: "beta" }),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.match(String(rejected?.reason), /^Error: already_exists: works\/same\.md$/u);
  const contents = await readFile(join(knowledge.knowledgeDir, "works", "same.md"), "utf8");
  assert.ok(contents.endsWith("alpha") || contents.endsWith("beta"));
  assert.equal((await readdir(join(knowledge.knowledgeDir, "works"))).length, 1);
});

test("create accepts the research folder", async (t) => {
  const knowledge = await newKnowledgeBase(t);

  const entry = await knowledge.create({ folder: "research", filename: "example.md", tags: ["research"], body: "Source notes" });

  assert.equal(entry.path, "research/example.md");
  assert.equal((await knowledge.get(entry.path)).body.trim(), "Source notes");
});

test("upsertBySource keeps kind and no-kind conversation entries separate", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const source = { key: "conversation_id", value: "conversation-1" };

  const typed = await knowledge.upsertBySource({
    folder: "advisor/conversations",
    title: "Incident recovery",
    source: { ...source, kind: "summary" },
    body: "typed entry",
    tags: ["conversation"],
  });
  const untyped = await knowledge.upsertBySource({
    folder: "advisor/conversations",
    title: "Incident recovery",
    source,
    body: "untyped entry",
    tags: ["conversation"],
  });

  assert.notEqual(typed.path, untyped.path);
  assert.equal((await knowledge.get(typed.path)).body.trim(), "typed entry");
  assert.equal((await knowledge.get(untyped.path)).body.trim(), "untyped entry");
  assert.match(await readFile(join(knowledge.knowledgeDir, typed.path), "utf8"), /kind: summary\n/u);
  assert.doesNotMatch(await readFile(join(knowledge.knowledgeDir, untyped.path), "utf8"), /^kind:/mu);
  assert.equal((await readdir(join(knowledge.knowledgeDir, "advisor", "conversations"))).length, 2);
});
