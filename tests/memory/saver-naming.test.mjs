import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { test } from "node:test";

import { KnowledgeBase } from "../../packages/core/dist/knowledge-base.js";
import { MemorySaver } from "../../packages/core/dist/memory-saver.js";
import { tempDir } from "../helpers/temp.mjs";

async function makeSaver(t) {
  const root = await tempDir(t, "owl-memory-naming-");
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
