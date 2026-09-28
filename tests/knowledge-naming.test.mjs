import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeBase } from "../packages/core/dist/knowledge-base.js";
import { MemorySaver } from "../packages/core/dist/memory-saver.js";
import { resolveKnowledgeFilename, slugifyKnowledgeContent, slugifyKnowledgeName } from "../packages/core/dist/knowledge-naming.js";

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-knowledge-naming-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("knowledge slugs preserve words and Unicode, replace punctuation, and stay bounded", () => {
  assert.equal(slugifyKnowledgeName("SQLite Lock / Retry"), "sqlite-lock-retry");
  assert.equal(slugifyKnowledgeName("SQLite ロック・再試行"), "sqlite-ロック-再試行");
  assert.match(slugifyKnowledgeName("***"), /^note-[a-f0-9]{8}$/u);
  assert.equal(slugifyKnowledgeName("abcdefghi-jkl", undefined, 10), "abcdefghi");
  assert.ok(slugifyKnowledgeName("x".repeat(100)).length <= 60);
});

test("empty content gets a prefix and content hash instead of a fixed fallback name", () => {
  for (const prefix of ["advisor", "policy"]) {
    const name = slugifyKnowledgeContent("", prefix);
    assert.match(name, new RegExp(`^${prefix}-[a-f0-9]{8}$`, "u"));
    assert.doesNotMatch(name, /untitled|advisor-conversation|^policy$/u);
  }
});

test("filename resolution uses the first free suffix and reuses matching sources", async (t) => {
  const dir = join(await tempRoot(t), "not-created-yet");
  assert.deepEqual(await resolveKnowledgeFilename(dir, "same-title", { key: "work_id", value: "A" }), {
    filename: "same-title.md",
    existing: false,
  });

  const first = await resolveKnowledgeFilename(dir, "same-title");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, first.filename), "---\nwork_id: A\n---\nfirst\n");
  assert.deepEqual(await resolveKnowledgeFilename(dir, "same-title", { key: "work_id", value: "B" }), {
    filename: "same-title-2.md",
    existing: false,
  });
  await writeFile(join(dir, "same-title-2.md"), "---\nwork_id: B\n---\nsecond\n");
  assert.deepEqual(await resolveKnowledgeFilename(dir, "same-title", { key: "work_id", value: "B" }), {
    filename: "same-title-2.md",
    existing: true,
  });
});

test("filename resolution finds matching sources after suffix gaps", async (t) => {
  const dir = join(await tempRoot(t), "with-gap");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "x.md"), "---\nwork_id: A\n---\nfirst\n");
  await writeFile(join(dir, "x-3.md"), "---\nwork_id: B\n---\nthird\n");

  assert.deepEqual(await resolveKnowledgeFilename(dir, "x", { key: "work_id", value: "B" }), {
    filename: "x-3.md",
    existing: true,
  });
  assert.deepEqual(await resolveKnowledgeFilename(dir, "x", { key: "work_id", value: "C" }), {
    filename: "x-2.md",
    existing: false,
  });
});

test("filename resolution reuses a source when its title slug changes", async (t) => {
  const dir = join(await tempRoot(t), "changed-title");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "old-title.md"), "---\nwork_id: work-42\n---\nold entry\n");

  assert.deepEqual(await resolveKnowledgeFilename(dir, "new-title", { key: "work_id", value: "work-42" }), {
    filename: "old-title.md",
    existing: true,
  });
});

test("filename resolution separates matching conversations by kind", async (t) => {
  const dir = join(await tempRoot(t), "conversation-kinds");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "advisor-chat.md"), "---\nconversation_id: conv-1\n---\nadvisor notes\n");

  const source = { key: "conversation_id", value: "conv-1" };
  const summary = await resolveKnowledgeFilename(dir, "advisor-chat", { ...source, kind: "summary" });
  assert.deepEqual(summary, { filename: "advisor-chat-2.md", existing: false });
  await writeFile(join(dir, summary.filename), "---\nconversation_id: conv-1\nkind: summary\n---\nsummary notes\n");

  assert.deepEqual(await resolveKnowledgeFilename(dir, "renamed-chat", source), {
    filename: "advisor-chat.md",
    existing: true,
  });
  assert.deepEqual(await resolveKnowledgeFilename(dir, "renamed-chat", { ...source, kind: "summary" }), {
    filename: "advisor-chat-2.md",
    existing: true,
  });
});

test("filename resolution requires every additional source key to match", async (t) => {
  const dir = join(await tempRoot(t), "multiple-source-keys");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "summary.md"), "---\nsession_id: session-1\ntrigger: compaction\ncompaction_index: 2\n---\nsummary\n");

  const source = {
    key: "session_id",
    value: "session-1",
    match: { trigger: "compaction", compaction_index: "2" },
  };
  assert.deepEqual(await resolveKnowledgeFilename(dir, "summary", source), {
    filename: "summary.md",
    existing: true,
  });
  assert.deepEqual(await resolveKnowledgeFilename(dir, "summary", {
    ...source,
    match: { ...source.match, compaction_index: "3" },
  }), {
    filename: "summary-2.md",
    existing: false,
  });
  assert.deepEqual(await resolveKnowledgeFilename(dir, "summary", {
    ...source,
    match: { trigger: "compaction", missing_key: "value" },
  }), {
    filename: "summary-2.md",
    existing: false,
  });
});

test("work lessons use content slugs, update by work ID, and preserve legacy filenames", async (t) => {
  const root = await tempRoot(t);
  const knowledge = new KnowledgeBase(root);
  await knowledge.ensureDirectories();
  const legacyPath = join(knowledge.knowledgeDir, "works", "work-42-sqlite-lock-retry.md");
  await writeFile(legacyPath, "legacy content\n");

  const first = await knowledge.saveWorkLessons("work-42", "SQLite lock retry", ["first lesson"]);
  assert.equal(first.path, "works/sqlite-lock-retry.md");
  assert.doesNotMatch(first.path, /work-42/u);
  assert.match(await readFile(join(knowledge.knowledgeDir, first.path), "utf8"), /^---\ntags: .*\ncreated: .*\nwork_id: work-42\n---/u);

  const second = await knowledge.saveWorkLessons("work-77", "SQLite lock retry", ["another work"]);
  assert.equal(second.path, "works/sqlite-lock-retry-2.md");
  const updated = await knowledge.saveWorkLessons("work-42", "SQLite lock retry", ["updated lesson"]);
  assert.equal(updated.path, first.path);
  assert.match(updated.body, /updated lesson/u);
  assert.equal(await readFile(legacyPath, "utf8"), "legacy content\n");
  assert.deepEqual((await readdir(join(knowledge.knowledgeDir, "works"))).sort(), [
    "sqlite-lock-retry-2.md",
    "sqlite-lock-retry.md",
    "work-42-sqlite-lock-retry.md",
  ]);
});

test("session memories are slugged and source-aware; explicit memories always get new files", async (t) => {
  const knowledge = new KnowledgeBase(await tempRoot(t));
  const saver = new MemorySaver(knowledge);
  const summary = (fact) => ({
    title: "Incident Recovery",
    facts: [fact],
    decisions: [],
    open_threads: [],
    related_work_ids: [],
    tags: ["incident"],
  });

  const first = await saver.saveSessionSummary("session-A", summary("old fact"));
  assert.equal(first, join("advisor", "sessions", "incident-recovery.md"));
  const updated = await saver.saveSessionSummary("session-A", summary("new fact"));
  assert.equal(updated, first);
  assert.match(await readFile(join(knowledge.knowledgeDir, first), "utf8"), /session_id: session-A/u);
  assert.match(await readFile(join(knowledge.knowledgeDir, first), "utf8"), /new fact/u);

  const differentSource = await saver.saveSessionSummary("session-B", summary("other fact"));
  assert.equal(differentSource, join("advisor", "sessions", "incident-recovery-2.md"));
  const explicit1 = await saver.saveExplicitMemory("Remember this important note");
  const explicit2 = await saver.saveExplicitMemory("Remember this important note");
  assert.equal(explicit1, join("advisor", "notes", "remember-this-import.md"));
  assert.equal(explicit2, join("advisor", "notes", "remember-this-import-2.md"));
});
