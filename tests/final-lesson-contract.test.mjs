import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatLesson,
  formatLessonList,
  formatRuleCandidate,
  isFinalLesson,
  lessonBlockKey,
  normalizeLesson,
  parseLessonBlocks,
  splitLessonBlocks,
} from "../packages/core/dist/final-verdict.js";
import { mergeLessonBlocks } from "../packages/core/dist/core.js";

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

test("formats rule candidates as four-line blocks without changing lesson display", () => {
  assert.equal(formatRuleCandidate(normalizeLesson(newRule()), "ja"), [
    "- Coordinate writes to shared state.",
    "  根拠: Two writers touched it.",
    "  当てはまる場面: Future shared storage work.",
    "  適用範囲: worker",
  ].join("\n"));
  assert.equal(formatRuleCandidate(normalizeLesson(newRule()), "en"), [
    "- Coordinate writes to shared state.",
    "  Basis: Two writers touched it.",
    "  Applies to: Future shared storage work.",
    "  Scope: worker",
  ].join("\n"));
  assert.equal(formatRuleCandidate(normalizeLesson({ ...newRule(), kind: "fact", rule_text: "" }), "en"), null);
  assert.equal(formatLesson(newRule(), "en"), [
    "- The shared path needs coordination.",
    "  Basis: Two writers touched it.",
    "  Applies to: Future shared storage work.",
  ].join("\n"));
  assert.equal(formatLessonList([newRule()], "en"), formatLesson(newRule(), "en"));
});

test("splits newline-joined and blank-line-joined lesson blocks", () => {
  const first = formatLesson(newRule(), "en");
  const second = formatLesson({ ...newRule(), lesson: "A second lesson." }, "en");
  assert.deepEqual(splitLessonBlocks(`${first}\n${second}`), [first, second]);
  assert.deepEqual(splitLessonBlocks(`${first}\n\n${second}\n\n`), [first, second]);
  assert.deepEqual(splitLessonBlocks(`ignored preface\n\n${first}\n  \n${second}`), [first, second]);
});

test("lesson block keys include only the head and optional scope", () => {
  const all = formatRuleCandidate(normalizeLesson(newRule("all")), "ja");
  const worker = formatRuleCandidate(normalizeLesson(newRule("worker")), "ja");
  const display = formatLesson(newRule(), "ja");
  assert.equal(lessonBlockKey(all), "Coordinate writes to shared state.\nall");
  assert.equal(lessonBlockKey(worker), "Coordinate writes to shared state.\nworker");
  assert.equal(lessonBlockKey(display), "The shared path needs coordination.\n");
});

test("parses localized lesson blocks and one-based indexes", () => {
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

test("parses formatted Japanese and English lessons and rule scopes", () => {
  const lesson = newRule();
  for (const language of ["ja", "en"]) {
    assert.deepEqual(parseLessonBlocks(formatLessonList([lesson], language)), [
      { index: 1, text: lesson.lesson, rationale: lesson.basis, applies_to: lesson.applies_to, scope: null },
    ]);
  }
  assert.deepEqual(parseLessonBlocks(formatRuleCandidate(normalizeLesson(lesson), "en")), [
    { index: 1, text: lesson.rule_text, rationale: lesson.basis, applies_to: lesson.applies_to, scope: "worker" },
  ]);
});

test("parses legacy continuation lines into the preceding field", () => {
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

test("merges lesson blocks in order, deduplicating by text and scope", () => {
  const all = formatRuleCandidate(normalizeLesson(newRule("all")), "ja");
  const worker = formatRuleCandidate(normalizeLesson(newRule("worker")), "ja");
  const other = formatRuleCandidate(normalizeLesson({ ...newRule("worker"), rule_text: "Keep writes serialized." }), "ja");
  const merged = mergeLessonBlocks(`${all}\n${worker}`, [worker, other, other]);
  assert.deepEqual(merged, { body: `${all}\n${worker}\n${other}`, added: 1 });
  assert.deepEqual(mergeLessonBlocks(`${all}\n${worker}`, [all, worker]), { body: `${all}\n${worker}`, added: 0 });
  assert.deepEqual(mergeLessonBlocks(null, [all, worker, all]), { body: `${all}\n${worker}`, added: 2 });
});
