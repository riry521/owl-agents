import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isFinalLesson, normalizeLesson, parseLessonBlocks } from "../../packages/core/dist/final-verdict.js";
import { parseManagerPlanWithFeedback } from "../../packages/agent-runtime/dist/manager.js";

const newRule = (rule_scope = "worker") => ({
  lesson: "The shared path needs coordination.",
  basis: "Two writers touched it.",
  applies_to: "Future shared storage work.",
  kind: "rule_candidate",
  topic: "shared storage",
  procedure: "",
  rule_text: "Coordinate writes to shared state.",
  rule_scope,
});

test("accepts the new lesson shape and legacy boolean shape", () => {
  assert.equal(isFinalLesson(newRule()), true);
  assert.equal(isFinalLesson({ lesson: "Old", basis: "Evidence", applies_to: "Future", proposes_rule: true }), true);
  assert.equal(isFinalLesson({ ...newRule(), rule_text: undefined }), false, "rule_candidate requires rule_text");
  assert.equal(isFinalLesson({ ...newRule(), kind: "discard" }), false);
});

test("normalizes legacy lessons to the new contract", () => {
  assert.deepEqual(normalizeLesson({ lesson: "Use a lock.", basis: "Writers raced.", applies_to: "Shared files.", proposes_rule: true }), {
    lesson: "Use a lock.", basis: "Writers raced.", applies_to: "Shared files.",
    kind: "rule_candidate", topic: "", procedure: "", rule_text: "Use a lock.", rule_scope: "all",
  });
  assert.deepEqual(normalizeLesson({ lesson: "Stable fact.", basis: "Observed.", applies_to: "Future.", proposes_rule: false }), {
    lesson: "Stable fact.", basis: "Observed.", applies_to: "Future.",
    kind: "fact", topic: "", procedure: "", rule_text: "", rule_scope: "all",
  });
});

test("a structured lesson saved to disk reads back field by field", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "owl-lesson-contract-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lessons = [newRule(), { ...newRule("all"), kind: "procedure", procedure: "1. Lock.\n2. Write.", rule_text: "" }];
  const file = join(dir, "lessons.json");
  await writeFile(file, JSON.stringify(lessons.map(normalizeLesson)));
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), lessons.map(normalizeLesson));
  const [rule, procedure] = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual([rule.rule_text, rule.basis, rule.applies_to, rule.rule_scope], ["Coordinate writes to shared state.", "Two writers touched it.", "Future shared storage work.", "worker"]);
  assert.equal(procedure.procedure, "1. Lock.\n2. Write.");
});

test("the structured read path never uses the Markdown label readers", async () => {
  for (const file of ["learning-pipeline.ts", "rule-proposals.ts", "rule-store.ts", "memory-saver.ts"]) {
    const source = await readFile(new URL(`../../packages/core/src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /parseLessonBlocks|splitLessonBlocks/u, file);
  }
});

test("a finalize verdict with a blank procedure or rule_text is a format error", () => {
  const request = { mode: "finalize", memory_mode: "files" };
  const verdict = (lesson) => ({ verdict: { verdict: "complete", summary: "ok", missing: [], unaddressed_backlog_items: [], lessons: [{ keywords: ["storage"], ...lesson }] } });
  const attempt = (lesson) => parseManagerPlanWithFeedback(verdict(lesson), request);
  assert.throws(() => attempt({ ...newRule(), kind: "procedure", procedure: " ", rule_text: "" }), { reason: "manager_output_schema:lessons:procedure:blank" });
  assert.throws(() => attempt({ ...newRule(), rule_text: "" }), { reason: "manager_output_schema:lessons:rule_text:blank" });
  assert.doesNotThrow(() => attempt({ ...newRule(), kind: "fact", rule_text: "" }));
});

// Markdown lessons recorded before lessons were stored as fields stay readable through the legacy reader.
test("legacy Markdown lessons: localized blocks and one-based indexes", () => {
  assert.deepEqual(parseLessonBlocks([
    "ignored preface",
    "- Coordinate writes.",
    "  根拠: Two writers raced.",
    "  当てはまる場面: Shared storage.",
    "  適用範囲: worker",
    "",
    "- Keep a changelog.",
    "  Basis: Releases were hard to track.",
    "  Applies to: Versioned packages.",
  ].join("\n")), [
    { index: 1, text: "Coordinate writes.", rationale: "Two writers raced.", applies_to: "Shared storage.", scope: "worker" },
    { index: 2, text: "Keep a changelog.", rationale: "Releases were hard to track.", applies_to: "Versioned packages.", scope: null },
  ]);
});

test("legacy Markdown lessons: continuation lines join the preceding field", () => {
  assert.deepEqual(parseLessonBlocks([
    "old file preface",
    "- Keep retries bounded.",
    "Applies to older task runners.",
    "  Basis: Repeated retries stalled the queue.",
    "Observed in the release run.",
    "  Applies to: Transient provider failures.",
    "Keep the delay short.",
    "  Legacy note: retain this explanation.",
    "  Scope: unknown-role",
    "",
    "- ",
  ].join("\n")), [
    {
      index: 1,
      text: "Keep retries bounded.",
      rationale: "Applies to older task runners.\nRepeated retries stalled the queue.\nObserved in the release run.",
      applies_to: "Transient provider failures.\nKeep the delay short.\nLegacy note: retain this explanation.",
      scope: null,
    },
  ]);
});
