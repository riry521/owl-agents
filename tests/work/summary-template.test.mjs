import assert from "node:assert/strict";
import { test } from "node:test";

import { WORK_SUMMARY_SECTIONS, workSummaryInstruction, workSummarySkeleton } from "../../packages/shared/dist/index.js";
import {
  WORK_SUMMARY_SECTIONS as WEB_SECTIONS,
  parseWorkSummary,
  splitInlineCode,
  workSummarySkeleton as webSkeleton,
} from "../../apps/web/lib/work-summary.mjs";

test("the Web copy of the summary template matches the shared definition", () => {
  assert.deepEqual(WEB_SECTIONS, WORK_SUMMARY_SECTIONS);
  assert.equal(webSkeleton("ja"), workSummarySkeleton());
});

test("the Advisor instruction names every section label", () => {
  const instruction = workSummaryInstruction();
  for (const section of WORK_SUMMARY_SECTIONS) assert.ok(instruction.includes(`"${section.label}:"`), section.label);
});

test("a templated summary is split into sections in template order", () => {
  const parsed = parseWorkSummary([
    "受け入れ条件:",
    "- 一覧から片付けられる",
    "- リロード後も保持される",
    "  （アーカイブ扱い）",
    "",
    "依頼: 完了済みのWorkを一覧から片付けたい。",
    "",
    "注意：物理削除はしない。",
  ].join("\r\n"));
  assert.equal(parsed.templated, true);
  assert.equal(parsed.preamble, "");
  assert.deepEqual(parsed.sections.map((section) => section.key), ["request", "acceptance", "notes"]);
  assert.equal(parsed.sections[0].text, "完了済みのWorkを一覧から片付けたい。");
  assert.deepEqual(parsed.sections[1].items, ["一覧から片付けられる", "リロード後も保持される （アーカイブ扱い）"]);
  assert.equal(parsed.sections[2].text, "物理削除はしない。");
});

test("English labels and leading text are kept; untemplated text stays whole", () => {
  const parsed = parseWorkSummary("Redo the cancelled Work.\n\nRequest: Fix the label.\nAcceptance:\n1. Label reads OK");
  assert.equal(parsed.preamble, "Redo the cancelled Work.");
  assert.deepEqual(parsed.sections.map((section) => [section.key, section.text, section.items]), [
    ["request", "Fix the label.", []],
    ["acceptance", "", ["Label reads OK"]],
  ]);
  assert.deepEqual(parseWorkSummary("Just fix it.\nPlease."), { templated: false, preamble: "Just fix it.\nPlease.", sections: [] });
  assert.deepEqual(parseWorkSummary(null), { templated: false, preamble: "", sections: [] });
  assert.equal(parseWorkSummary("依頼:\n\n背景: なし").sections.map((section) => section.key).join(), "background");
});

test("splitInlineCode splits backtick pairs and leaves unmatched backticks as text", () => {
  assert.deepEqual(splitInlineCode("run `npm test` now"), [
    { code: false, text: "run " },
    { code: true, text: "npm test" },
    { code: false, text: " now" },
  ]);
  assert.deepEqual(splitInlineCode("a ` b"), [{ code: false, text: "a ` b" }]);
});

test("splitInlineCode handles multi-backtick spans and degenerate input", () => {
  assert.deepEqual(splitInlineCode("``"), [{ code: false, text: "``" }]);
  assert.deepEqual(splitInlineCode("```"), [{ code: false, text: "```" }]);
  assert.deepEqual(splitInlineCode("a `b\nc` d"), [{ code: false, text: "a `b\nc` d" }]);
  assert.deepEqual(splitInlineCode("``x``"), [{ code: true, text: "x" }]);
  assert.deepEqual(splitInlineCode("`a``b`"), [
    { code: false, text: "`a`" },
    { code: true, text: "b" },
  ]);
  assert.deepEqual(splitInlineCode("`````"), [{ code: false, text: "`````" }]);
});
