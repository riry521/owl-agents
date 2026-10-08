import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeBase } from "../../packages/core/dist/knowledge-base.js";
import { MemorySaver } from "../../packages/core/dist/memory-saver.js";
import { resolveKnowledgeFilename, slugifyKnowledgeContent, slugifyKnowledgeName } from "../../packages/core/dist/knowledge-naming.js";
import { tempDir } from "../helpers/temp.mjs";

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
  const dir = join(await tempDir(t, "owl-knowledge-naming-"), "not-created-yet");
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

test("filename resolution treats names that differ only in case or Unicode normalization as taken", async (t) => {
  const dir = await tempDir(t, "owl-knowledge-naming-fold-");
  await writeFile(join(dir, "Foo.md"), "hand written\n");
  await writeFile(join(dir, "ガイド.md".normalize("NFD")), "hand written\n");

  assert.deepEqual(await resolveKnowledgeFilename(dir, "foo"), { filename: "foo-2.md", existing: false });
  assert.deepEqual(await resolveKnowledgeFilename(dir, "ガイド"), { filename: "ガイド-2.md", existing: false });
});

test("filename resolution finds matching sources after suffix gaps", async (t) => {
  const dir = join(await tempDir(t, "owl-knowledge-naming-"), "with-gap");
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
  const dir = join(await tempDir(t, "owl-knowledge-naming-"), "changed-title");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "old-title.md"), "---\nwork_id: work-42\n---\nold entry\n");

  assert.deepEqual(await resolveKnowledgeFilename(dir, "new-title", { key: "work_id", value: "work-42" }), {
    filename: "old-title.md",
    existing: true,
  });
});

test("filename resolution separates matching conversations by kind", async (t) => {
  const dir = join(await tempDir(t, "owl-knowledge-naming-"), "conversation-kinds");
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
  const dir = join(await tempDir(t, "owl-knowledge-naming-"), "multiple-source-keys");
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
