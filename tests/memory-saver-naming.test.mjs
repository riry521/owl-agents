import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

import { KnowledgeBase } from "../packages/core/dist/knowledge-base.js";
import { MemorySaver } from "../packages/core/dist/memory-saver.js";

async function makeSaver(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-memory-naming-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const knowledge = new KnowledgeBase(root);
  const saver = new MemorySaver(knowledge);
  return { knowledge, saver };
}

function summary(title = "Shared Incident", facts = ["Rotate the recovery key"]) {
  return {
    title,
    facts,
    decisions: [],
    open_threads: [],
    related_work_ids: [],
    tags: ["incident"],
  };
}

function compaction(index, text) {
  return {
    conversationId: "conversation-987",
    cause: "auto",
    preTokens: 12000,
    summary: text,
    provider: "test-provider",
    model: "test-model",
    index,
    transcriptPath: null,
  };
}

test("normal and compaction summaries from one session remain separate; compactions update by index", async (t) => {
  const { knowledge, saver } = await makeSaver(t);
  const regularPath = await saver.saveSessionSummary("session-123", summary());
  const first = await saver.saveCompactionSummary("session-123", compaction(1, "Shared Incident"));
  const second = await saver.saveCompactionSummary("session-123", compaction(2, "Shared Incident"));

  assert.notEqual(first.path, regularPath);
  assert.notEqual(second.path, first.path);
  assert.doesNotMatch([regularPath, first.path, second.path].join(" "), /session-123|conversation-987|compaction-[12]/u);

  const before = await readdir(join(knowledge.knowledgeDir, "advisor", "sessions"));
  const updated = await saver.saveCompactionSummary("session-123", compaction(1, "Shared Incident updated"));
  const after = await readdir(join(knowledge.knowledgeDir, "advisor", "sessions"));
  assert.equal(updated.path, first.path);
  assert.equal(after.length, before.length);
  assert.match(await readFile(join(knowledge.knowledgeDir, first.path), "utf8"), /Shared Incident updated/u);
});

test("manual snapshots always get separate source files", async (t) => {
  const { knowledge, saver } = await makeSaver(t);
  const first = await saver.saveManualSnapshot(summary("Manual Recovery"));
  const second = await saver.saveManualSnapshot(summary("Manual Recovery"));

  assert.notEqual(first, second);
  assert.equal(basename(first), "manual-recovery.md");
  assert.equal(basename(second), "manual-recovery-2.md");
  const files = await readdir(join(knowledge.knowledgeDir, "advisor", "sessions"));
  assert.equal(files.length, 2);
  const content = await readFile(join(knowledge.knowledgeDir, first), "utf8");
  assert.match(content, /source_id: [0-9a-f-]{36}/u);
  assert.doesNotMatch(content, /session_id: manual/u);
});

test("empty titles use the first summary fact as the filename slug", async (t) => {
  const { saver } = await makeSaver(t);
  const path = await saver.saveSessionSummary("session-1", summary("  ", ["Invalidate stale locks after recovery"]));
  assert.equal(basename(path), "invalidate-stale-locks-after-recovery.md");
  assert.doesNotMatch(path, /untitled/u);
});

test("empty titles skip summary items that cannot be slugified", async (t) => {
  const { knowledge, saver } = await makeSaver(t);
  const secondFact = await saver.saveSessionSummary("session-fact", {
    ...summary("!!!", ["!!!", "  Preserve recovery notes  "]),
    decisions: ["A later item"],
  });
  const decision = await saver.saveSessionSummary("session-decision", {
    ...summary("!!!", ["!!!"]),
    decisions: ["Preserve rollback options"],
  });

  assert.equal(basename(secondFact), "preserve-recovery-notes.md");
  assert.match(await readFile(join(knowledge.knowledgeDir, secondFact), "utf8"), /# Preserve recovery notes/u);
  assert.equal(basename(decision), "preserve-rollback-options.md");
  assert.match(await readFile(join(knowledge.knowledgeDir, decision), "utf8"), /# Preserve rollback options/u);
});

test("empty summary content and explicit memory use content hashes instead of fixed names", async (t) => {
  const { saver } = await makeSaver(t);
  const sessionPath = await saver.saveSessionSummary("session-2", summary("!!!", []));
  assert.match(basename(sessionPath), /^session-[a-f0-9]{8}\.md$/u);
  assert.doesNotMatch(sessionPath, /untitled/u);

  const first = await saver.saveExplicitMemory("   ");
  const second = await saver.saveExplicitMemory("   ");
  assert.match(basename(first), /^memory-[a-f0-9]{8}\.md$/u);
  assert.equal(basename(second), basename(first).replace(".md", "-2.md"));
  assert.doesNotMatch(first, /untitled/u);
});
