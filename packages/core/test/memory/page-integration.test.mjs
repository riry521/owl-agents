import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parsePage } from "../../dist/memory/page-format.js";
import { buildIntegrationRequest, checkClassifyOutput, checkIntegrationOutput } from "../../dist/memory/page-integration.js";

const text = readFileSync(new URL("./fixtures/pages/theme.md", import.meta.url), "utf8");
const before = parsePage(text);
const bodyFrom = (t) => t.slice(t.indexOf("## 概要"));
const resolveLink = () => true;
const out = (over = {}) => ({
  op: "rewrite",
  pages: [{ path: "projects/x/テストの落とし穴.md", title: "テストの落とし穴", summary: "日付・乱数に依存して落ちるテストの直し方", body: bodyFrom(text) }],
  history_line: "- 2026-10-03 W815 整理（司書）", star_changes: [], reason: "x", ...over,
});
const check = (raw, opts = { resolveLink }) => checkIntegrationOutput(raw, before, opts);
const errs = (r) => (r.ok ? [] : r.errors.join("|"));

test("an unchanged page passes and returns parsed pages", () => {
  const r = check(out());
  assert.equal(r.ok, true, errs(r));
  assert.equal(r.pages.length, 1);
  assert.equal(r.pages[0].frontmatter.id, before.frontmatter.id);
});
test("noop passes with no pages", () => assert.equal(check(out({ op: "noop", pages: [] })).ok, true));
test("shape and op errors", () => {
  assert.equal(check(null).ok, false);
  assert.match(errs(check(out({ op: "delete" }))), /invalid_op/);
  assert.match(errs(check(out({ pages: [] }))), /pages_empty/);
  assert.match(errs(check(out({ history_line: 1 }))), /history_line_missing/);
});
test("owl:new left, secret and unresolved link are rejected; over budget is not", () => {
  const page = (body) => out({ pages: [{ ...out().pages[0], body }] });
  assert.match(errs(check(page(`${bodyFrom(text)}\n<!-- owl:new 2026-10-03 W9 -->`))), /owl_new_left/);
  assert.match(errs(check(page(bodyFrom(text).replace("## 手順", `- sk-${"a1B2".repeat(8)}\n\n## 手順`)))), /secret_pattern/);
  assert.equal(check(page(`${bodyFrom(text)}\n${"あ".repeat(3100)}`)).ok, true, "over budget is a warning, not a rejection");
  assert.match(errs(check(out(), { resolveLink: () => false })), /unresolved_link/);
});
test("template violation is rejected", () => {
  const body = bodyFrom(text).replace("## 決まりごと", "## ルール");
  assert.equal(check(out({ pages: [{ ...out().pages[0], body }] })).ok, false);
});
test("sources and stars do not count as changes", () => {
  const body = bodyFrom(text).replace("（W812）", "").replace("- ★ 月末", "- 月末");
  assert.equal(check(out({ pages: [{ ...out().pages[0], body }] })).ok, true);
});

test("buildIntegrationRequest lists owl:new lines", () => {
  const withNew = text.replace("- 乱数のテスト", "- 新しい落とし穴 <!-- owl:new 2026-10-04 W820 -->\n- 乱数のテスト");
  const row = { path: "p.md", title: "T", page_scope: "project", project_id: "P", token_estimate: 100 };
  const req = buildIntegrationRequest({ run_id: "r", reason: "owl_new", page: row, text: withNew, siblings: [row, { path: "q.md", title: "Q", summary: "s" }], model: { provider: "claude", model: "m", effort: "low" } });
  assert.deepEqual(req.new_lines, [{ section: "落とし穴", text: "- 新しい落とし穴", work_label: "W820" }]);
  assert.deepEqual(req.siblings, [{ title: "Q", summary: "s" }]);
  assert.ok(req.page.body.startsWith("## 概要"));
  assert.equal(req.max_output_tokens, 3500);
});

const creq = { lines: [{ id: "a", text: "x", source_path: "n.md", project_ids: [] }, { id: "b", text: "y", source_path: "n.md", project_ids: [] }], themes: [] };
const asg = (id, over = {}) => ({ id, theme: "新しいテーマ", scope: "common", kind: "fact", cross_project: false, ...over });
test("checkClassifyOutput", () => {
  assert.equal(checkClassifyOutput({ assignments: [asg("a"), asg("b")] }, creq).ok, true);
  assert.match(errs(checkClassifyOutput({ assignments: [asg("a")] }, creq)), /missing_id:b/);
  assert.match(errs(checkClassifyOutput({ assignments: [asg("a"), asg("a"), asg("b")] }, creq)), /duplicate_id:a/);
  assert.match(errs(checkClassifyOutput({ assignments: [asg("a"), asg("b"), asg("c")] }, creq)), /unknown_id:c/);
  assert.match(errs(checkClassifyOutput({ assignments: [asg("a", { theme: "あ".repeat(31) }), asg("b")] }, creq)), /theme_invalid:a/);
  assert.match(errs(checkClassifyOutput({ assignments: [asg("a", { kind: "x" }), asg("b", { scope: "y" })] }, creq)), /kind_invalid:a.*scope_invalid:b|scope_invalid:b.*kind_invalid:a/);
  assert.equal(checkClassifyOutput({}, creq).ok, false);
});
