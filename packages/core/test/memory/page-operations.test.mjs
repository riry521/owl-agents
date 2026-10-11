import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyThemePage, estimatePageTokens, lineHash, pageSize, parseHistory, parsePage, renderHistory, renderPage } from "../../dist/memory/page-format.js";
import { applyOperations, applyOperationsToRoot, H_PREFIX, itemsOf, parseOperationsOutput, stripNew, verifyUntouched } from "../../dist/memory/page-operations.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const P1 = "01M441EY1ZZWA4ZVH79VEFV524";
const P2 = "01M441EY1ZZWA4ZVH79VEFV525";
const ID_A = "01M441RV396PGWVD1Z8RH2GCEB";
const ID_B = "01M441RV39VR4X2CEA1G2K2P8G";
const ID_C = "01M442TQ6235E816GDMR80GBKT";

function page({ id, title, scope = "project", project = P1, sections = {} }) {
  const p = emptyThemePage({ id, title, summary: `${title}の要約`, scope, project_id: scope === "project" ? project : null, today: "2026-09-01" });
  return renderPage({ ...p, sections: p.sections.map((s) => (sections[s.heading] ? { ...s, lines: sections[s.heading] } : s)) });
}
const A_PITFALLS = ["- ★ 並列で tmp を共有しない（W10, W12）", "- 別の落とし穴（W11）", "- 古い手順は src/old.ts を使う（W5）", "- 末尾の行（W13） <!-- owl:new 2026-10-01 W13 -->"];
const A_RULES = ["- 決まりその 1（W1）", "- 決まりその 2（W2）"];
const A_STEPS = ["", "### 実行手順", "1. build", "2. test"];
const textA = page({ id: ID_A, title: "テスト実行", sections: { 決まりごと: A_RULES, 落とし穴: A_PITFALLS, 手順: A_STEPS } });
const textB = page({ id: ID_B, title: "ビルド", project: P2, sections: { 落とし穴: ["- ★ 並列で tmp を共有しない（W20）"] } });
const textC = page({ id: ID_C, title: "共有メモ", scope: "common", sections: { 決まりごと: ["- 共通の決まり（W30）"] } });
const PATH_A = "projects/owl/テスト実行.md";
const PATH_B = "projects/other/ビルド.md";
const PATH_C = "common/共有メモ.md";

const state = (extra = {}) => ({
  pages: new Map([[PATH_A, textA], [PATH_B, textB], [PATH_C, textC], ...Object.entries(extra.pages ?? {})]),
  histories: new Map(Object.entries(extra.histories ?? {})),
  pageIds: new Map([[ID_A, PATH_A], [ID_B, PATH_B], [ID_C, PATH_C]]),
});
let seq = 0;
const ctx = (over = {}) => ({
  today: "2026-10-05",
  newId: () => `01M44${String(++seq).padStart(21, "0")}`,
  workExists: (w) => w <= 100,
  pathMissing: (_page, path) => (path === "src/old.ts" ? "missing" : "exists"),
  conversationExists: () => true,
  isDormant: () => false,
  isDormantCandidate: () => true,
  titleTaken: () => false,
  ...over,
});
const item = (path, section, index) => {
  const text = path === PATH_A ? textA : path === PATH_B ? textB : textC;
  const it = itemsOf(text).find((s) => s.section === section).items[index];
  return { page: path, section, h: it.h };
};
const apply = (ops, st = state(), over = {}, opts) => applyOperations(st, ops, ctx(over), opts);
const linesOf = (text) => text.split("\n");
/** Lines of `before` that were not removed must appear in `after` in order. */
const untouchedOk = (before, after, removedTexts = []) => {
  const kept = linesOf(before).filter((l) => !removedTexts.includes(l));
  let j = 0;
  for (const l of linesOf(after)) if (j < kept.length && l === kept[j]) j += 1;
  return j === kept.length;
};

test("merge combines lines into one with the union of their W marks and keeps the originals in _history", () => {
  const r = apply([{ op: "merge", items: [item(PATH_A, "落とし穴", 0), item(PATH_A, "落とし穴", 1)], into: { page: PATH_A, section: "落とし穴" }, text: "tmp は共有せず、別の落とし穴にも注意する" }]);
  assert.deepEqual(r.rejected, []);
  const after = r.state.pages.get(PATH_A);
  assert.ok(after.includes("- ★ tmp は共有せず、別の落とし穴にも注意する（W10, W11, W12）"));
  assert.ok(!after.includes("- 別の落とし穴（W11）"));
  const history = parseHistory(r.state.histories.get("projects/owl/_history/テスト実行.md"));
  assert.equal(history.entries.length, 2);
  assert.deepEqual(history.entries.map((e) => e.reason), ["重複", "重複"]);
  assert.deepEqual(history.entries.map((e) => e.lines[0]), [A_PITFALLS[0], A_PITFALLS[1]]);
  assert.ok(history.entries[0].replaced_by.includes("tmp は共有せず"));
  assert.ok(after.includes("司書: 統合 1"));
});

test("move strips only owl:new when integrating and moves a line to another page byte for byte at the end", () => {
  const ingest = apply([{ op: "move", item: item(PATH_A, "落とし穴", 3), to: { page: PATH_A, section: "落とし穴" } }]);
  assert.ok(ingest.state.pages.get(PATH_A).includes("\n- 末尾の行（W13）\n"));
  const moved = apply([{ op: "move", item: item(PATH_A, "落とし穴", 1), to: { page: PATH_B, section: "決まりごと" } }]);
  assert.deepEqual(moved.rejected, []);
  assert.ok(moved.state.pages.get(PATH_B).includes("- 別の落とし穴（W11）"));
  assert.ok(!moved.state.pages.get(PATH_A).includes("- 別の落とし穴（W11）"));
  const kind = apply([{ op: "move", item: item(PATH_A, "落とし穴", 1), to: { page: PATH_A, section: "手順" } }]);
  assert.equal(kind.rejected[0].code, "kind_mismatch");
});

test("retire removes a line with its evidence from the body and records the section, reason, evidence and date in _history", () => {
  const r = apply([{ op: "retire", item: item(PATH_A, "落とし穴", 2), reason: "missing_path", evidence: { paths: ["src/old.ts"] } }]);
  assert.deepEqual(r.rejected, []);
  assert.ok(!r.state.pages.get(PATH_A).includes("src/old.ts"));
  const [e] = parseHistory(r.state.histories.get("projects/owl/_history/テスト実行.md")).entries;
  assert.equal(e.section, "落とし穴");
  assert.equal(e.reason, "参照先なし");
  assert.ok(e.evidence.includes("src/old.ts"));
  assert.equal(e.date, "2026-10-05");
  assert.deepEqual(e.lines, [A_PITFALLS[2]]);
  const dup = apply([{ op: "retire", item: item(PATH_B, "落とし穴", 0), reason: "duplicate", evidence: { kept: item(PATH_A, "落とし穴", 0) } }]);
  assert.deepEqual(dup.rejected, []);
  assert.ok(dup.touched.has("projects/other/_history/ビルド.md"));
});

test("dormant and reactivate only instruct the database and do not change the file", () => {
  const r = apply([{ op: "dormant", page: PATH_A }], state(), {}, { allowCoreOps: true });
  assert.deepEqual(r.activity, [{ page: PATH_A, action: "dormant" }]);
  assert.equal(r.touched.size, 0);
  assert.equal(r.state.pages.get(PATH_A), textA);
  assert.equal(apply([{ op: "dormant", page: PATH_A }]).rejected[0].code, "unknown_op");
  assert.equal(apply([{ op: "dormant", page: PATH_A }], state(), { isDormantCandidate: () => false }, { allowCoreOps: true }).rejected[0].code, "not_dormant_candidate");
  const re = apply([{ op: "reactivate", page: PATH_A }], state(), { isDormant: () => true });
  assert.deepEqual(re.activity, [{ page: PATH_A, action: "reactivate" }]);
  assert.equal(re.touched.size, 0);
  const none = apply([{ op: "reactivate", page: PATH_A }]);
  assert.deepEqual(none.activity, []);
  assert.equal(none.warnings[0].code, "not_dormant");
  const sleeping = apply([{ op: "retire", item: item(PATH_A, "落とし穴", 2), reason: "missing_path", evidence: { paths: ["src/old.ts"] } }], state(), { isDormant: () => true });
  assert.equal(sleeping.rejected[0].code, "page_not_writable");
});

test("link adds a described link to the related page in one direction only", () => {
  const r = apply([{ op: "link", from: PATH_A, to: PATH_B, relation: "同じ tmp の問題" }]);
  assert.deepEqual(r.rejected, []);
  assert.ok(r.state.pages.get(PATH_A).includes("- [[ビルド]] — 同じ tmp の問題"));
  assert.equal(r.state.pages.get(PATH_B), textB);
  const again = apply([{ op: "link", from: PATH_A, to: PATH_B, relation: "a" }, { op: "link", from: PATH_A, to: PATH_B, relation: "b" }, { op: "link", from: PATH_A, to: PATH_A, relation: "c" }]);
  assert.deepEqual(again.rejected.map((x) => x.code), ["link_exists", "self_link"]);
  assert.deepEqual(again.rejected[0].detail, { from: PATH_A, to: PATH_B });
});

test("split moves items to a new page byte for byte and links the two pages to each other", () => {
  const r = apply([{ op: "split", page: PATH_A, new_title: "古い手順", new_summary: "古い手順の要約", items: [item(PATH_A, "落とし穴", 2), item(PATH_A, "決まりごと", 1)], relation: "切り出し" }]);
  assert.deepEqual(r.rejected, []);
  const created = r.state.pages.get("projects/owl/古い手順.md");
  assert.ok(created.includes("title: 古い手順") && created.includes("- 古い手順は src/old.ts を使う（W5）") && created.includes("- 決まりその 2（W2）"));
  assert.ok(created.includes("- [[テスト実行]] — 切り出し"));
  const src = r.state.pages.get(PATH_A);
  assert.ok(src.includes("- [[古い手順]] — 切り出し") && !src.includes("src/old.ts"));
  assert.equal(r.state.pageIds.size, 4);
  const all = itemsOf(textA).filter((s) => s.section === "決まりごと" || s.section === "落とし穴" || s.section === "手順");
  const everything = all.flatMap((s) => s.items.map((i) => ({ page: PATH_A, section: s.section, h: i.h })));
  assert.equal(apply([{ op: "split", page: PATH_A, new_title: "全部", new_summary: "s", items: everything, relation: "r" }]).rejected[0].code, "split_empties_page");
  const sameTitle = apply([{ op: "split", page: PATH_A, new_title: "ビルド", new_summary: "s", items: [item(PATH_A, "落とし穴", 1)], relation: "r" }]);
  assert.deepEqual(sameTitle.rejected, []);
  assert.ok(sameTitle.state.pages.get("projects/owl/ビルド.md").includes("- 別の落とし穴（W11）"));
  assert.equal(sameTitle.state.pages.get(PATH_B), textB);
});

test("promote_common lifts items from two projects into common/ and adds links and related_projects", () => {
  const ops = [{ op: "promote_common", items: [item(PATH_A, "落とし穴", 0), item(PATH_B, "落とし穴", 0)], to: { title: "tmp の共有", section: "落とし穴" } }];
  const r = apply(ops);
  assert.deepEqual(r.rejected, []);
  const common = r.state.pages.get("common/tmp-の共有.md");
  assert.ok(common.includes("- ★ 並列で tmp を共有しない（W10, W12, W20）"));
  assert.ok(common.includes(`related_projects: [${P1}, ${P2}]`));
  for (const path of [PATH_A, PATH_B]) assert.ok(r.state.pages.get(path).includes("- [[tmp の共有]] — 共通化"));
  assert.ok(!r.state.pages.get(PATH_B).includes("並列で tmp"));
  assert.equal(parseHistory(r.state.histories.get("projects/other/_history/ビルド.md")).entries[0].reason, "重複");
  const same = apply([{ op: "promote_common", items: [item(PATH_A, "落とし穴", 0), item(PATH_A, "落とし穴", 1)], to: { title: "x", section: "落とし穴" } }]);
  assert.equal(same.rejected[0].code, "not_cross_project");
  const existing = apply([{ op: "promote_common", items: [item(PATH_A, "落とし穴", 0), item(PATH_B, "落とし穴", 0)], to: { title: "共有メモ", section: "決まりごと" } }]);
  assert.ok(existing.state.pages.get(PATH_C).includes("- 共通の決まり（W30）\n- ★ 並列で tmp を共有しない（W10, W12, W20）"));
});

test("restore puts a retired line back at its original position in its original section byte for byte (round trip)", () => {
  const retired = apply([{ op: "retire", item: item(PATH_A, "落とし穴", 1), reason: "missing_path", evidence: { paths: ["src/old.ts"] } }]);
  assert.deepEqual(retired.rejected, []);
  assert.ok(!retired.state.pages.get(PATH_A).includes("別の落とし穴"));
  const histPath = "projects/owl/_history/テスト実行.md";
  const entry = parseHistory(retired.state.histories.get(histPath)).entries[0];
  const back = applyOperations(retired.state, [{ op: "restore", history: histPath, entry: entry.id }], ctx());
  assert.deepEqual(back.rejected, []);
  const restored = back.state.pages.get(PATH_A);
  assert.deepEqual(itemsOf(restored).find((s) => s.section === "落とし穴").items.map((i) => i.text), A_PITFALLS);
  assert.equal(parseHistory(back.state.histories.get(histPath)).entries[0].restored, "2026-10-05");
  assert.equal(applyOperations(back.state, [{ op: "restore", history: histPath, entry: entry.id }], ctx()).rejected[0].code, "already_restored");
  assert.equal(apply([{ op: "restore", history: histPath, entry: "none" }], retired.state).rejected[0].code, "unknown_entry");
  // 手順（複数行）も往復する
  const proc = applyOperations(state(), [{ op: "retire", item: item(PATH_A, "手順", 0), reason: "missing_path", evidence: { paths: ["src/old.ts"] } }], ctx());
  const pe = parseHistory(proc.state.histories.get(histPath)).entries[0];
  assert.deepEqual(pe.lines, ["### 実行手順", "1. build", "2. test"]);
  const procBack = applyOperations(proc.state, [{ op: "restore", history: histPath, entry: pe.id }], ctx());
  assert.deepEqual(itemsOf(procBack.state.pages.get(PATH_A)).find((s) => s.section === "手順").items.map((i) => i.text), ["### 実行手順\n1. build\n2. test"]);
});

test("lines an operation does not target are byte-identical before and after it", () => {
  const ops = [
    { op: "merge", items: [item(PATH_A, "落とし穴", 0), item(PATH_A, "落とし穴", 1)], into: { page: PATH_A, section: "落とし穴" }, text: "まとめ" },
    { op: "retire", item: item(PATH_A, "落とし穴", 2), reason: "missing_path", evidence: { paths: ["src/old.ts"] } },
    { op: "move", item: item(PATH_A, "落とし穴", 3), to: { page: PATH_A, section: "落とし穴" } },
    { op: "link", from: PATH_A, to: PATH_C, relation: "参考" },
  ];
  const r = apply(ops);
  assert.deepEqual(r.rejected, []);
  const updatedLine = textA.match(/^updated: .*$/mu)[0];
  const removed = new Set([...A_PITFALLS, updatedLine, "（なし）"]);
  const survivors = linesOf(textA).filter((l) => !removed.has(l));
  const after = linesOf(r.state.pages.get(PATH_A));
  // 指していない行は、同じ順序・同じバイト列（ハッシュ）で残る。増えたのは操作が作った行だけ
  const survivorSet = new Set(survivors);
  assert.deepEqual(after.filter((l) => survivorSet.has(l)).map(sha), survivors.map(sha));
  // 置き場所の目印は、リンクと更新履歴が入った欄では外れ、概要には残る
  assert.equal(after.filter((l) => l === "（なし）").length, 1);
  assert.ok(untouchedOk(textA, r.state.pages.get(PATH_A), [...removed]));
  assert.equal(r.state.pages.get(PATH_B), textB);
  assert.equal(r.state.pages.get(PATH_C), textC);
  assert.ok(verifyUntouched("a\nb\nc\n", "a\nX\nc\n", new Set([1]), 1));
  assert.ok(!verifyUntouched("a\nb\nc\n", "a\nc\nb\n", new Set(), 0));
});

test("operations with a mismatched hash and retirements without evidence are rejected and leave the page and _history unchanged", () => {
  const histories = { "projects/owl/_history/テスト実行.md": "# 古い履歴\n\n- 2026-01-01 古い行\n" };
  const st = state({ histories });
  const snap = () => ({ pages: [...st.pages].map(([k, v]) => [k, sha(v)]), histories: [...st.histories].map(([k, v]) => [k, sha(v)]) });
  const before = snap();
  const stale = { page: PATH_A, section: "落とし穴", h: "000000000000" };
  const good = item(PATH_A, "落とし穴", 2);
  const r = apply([
    { op: "merge", items: [stale, item(PATH_A, "落とし穴", 1)], into: { page: PATH_A, section: "落とし穴" }, text: "x" },
    { op: "move", item: stale, to: { page: PATH_B, section: "落とし穴" } },
    { op: "retire", item: stale, reason: "missing_path", evidence: { paths: ["src/old.ts"] } },
    { op: "retire", item: good, reason: "missing_path", evidence: {} },
    { op: "retire", item: good, reason: "missing_path", evidence: { paths: ["src/exists.ts"] } },
    { op: "retire", item: good, reason: "contradiction", evidence: {}, replaced_by: item(PATH_A, "落とし穴", 0) },
    { op: "retire", item: good, reason: "contradiction", evidence: { works: ["W1"] }, replaced_by: item(PATH_A, "落とし穴", 0) },
    { op: "retire", item: good, reason: "duplicate", evidence: {} },
    { op: "retire", item: good, reason: "気分", evidence: { works: ["W200"] } },
    { op: "retire", item: good, reason: "missing_path", evidence: { paths: ["src/old.ts"] }, extra: 1 },
  ], st);
  assert.deepEqual(r.applied, []);
  // hardcode-check-allow whole-list-equal: 契約として固定された一覧の完全一致を確かめるため、現状の値を意図して比べている
  assert.deepEqual(r.rejected.map((x) => x.code), [
    "line_hash_mismatch", "line_hash_mismatch", "line_hash_mismatch", "retire_without_evidence", "evidence_path_exists",
    "retire_without_evidence", "evidence_work_invalid", "retire_without_evidence", "unknown_reason", "unknown_op",
  ]);
  assert.deepEqual(snap(), before);
  assert.deepEqual([...r.state.pages].map(([k, v]) => [k, sha(v)]), before.pages);
  assert.deepEqual([...r.state.histories].map(([k, v]) => [k, sha(v)]), before.histories);
  assert.equal(r.touched.size, 0);
  // 同じ項目を 2 つの操作で使えない
  const twice = apply([
    { op: "move", item: good, to: { page: PATH_A, section: "決まりごと" } },
    { op: "retire", item: good, reason: "missing_path", evidence: { paths: ["src/old.ts"] } },
  ]);
  assert.deepEqual(twice.rejected.map((x) => x.code), ["item_already_used"]);
});

test("model output with a full-text key is rejected as a whole", () => {
  assert.deepEqual(parseOperationsOutput('{"operations":[],"pages":[]}'), { error: "full_text_not_accepted" });
  assert.deepEqual(parseOperationsOutput({ operations: [], foo: 1 }), { error: "unexpected_key" });
  assert.deepEqual(parseOperationsOutput("nope"), { error: "invalid_json" });
  assert.deepEqual(parseOperationsOutput({ operations: [{ op: "link" }], note: "x" }), { ops: [{ op: "link" }] });
  assert.equal(apply([{ op: "move", item: item(PATH_A, "落とし穴", 1), to: { page: PATH_B, section: "落とし穴" }, line: "x" }]).rejected[0].code, "unknown_op");
  assert.equal(apply([{ op: "link", from: PATH_A, to: PATH_B, relation: "a\nb" }]).rejected[0].code, "text_has_newline");
});

test("a page over the size limit is still written while lines leave it, loses no line and returns the warnings", () => {
  const many = Array.from({ length: 20 }, (_, i) => `- 落とし穴 ${i} ${"長い文".repeat(200)}（W${i + 1}）`);
  const big = page({ id: ID_A, title: "テスト実行", sections: { 落とし穴: many, 決まりごと: A_RULES } });
  const st = { pages: new Map([[PATH_A, big], [PATH_B, textB]]), histories: new Map(), pageIds: new Map([[ID_A, PATH_A], [ID_B, PATH_B]]) };
  const hs = itemsOf(big).find((s) => s.section === "落とし穴").items.map((i) => i.h);
  const ref = (n) => ({ page: PATH_A, section: "落とし穴", h: hs[n] });
  const r = applyOperations(st, [{ op: "split", page: PATH_A, new_title: "分けた", new_summary: "s", items: [ref(0), ref(1)], relation: "r" }], ctx());
  assert.deepEqual(r.rejected, []);
  const after = [...r.state.pages.values()].join("\n");
  for (const l of many) assert.equal(after.split(l).length - 1, 1);
  assert.ok(r.warnings.some((w) => w.page === PATH_A && w.code === "over_budget"));
  assert.ok(r.warnings.some((w) => w.page === PATH_A && w.code === "section_over_lines"));
  assert.equal(lineHash("x").length, 12);
});

test("merge can combine two identical lines in the same section and keeps both in the history", () => {
  const dup = page({ id: ID_A, title: "テスト実行", sections: { 落とし穴: ["- 同じ行（W1）", "- 同じ行（W1）", "- 別の行（W2）"] } });
  const hs = itemsOf(dup).find((s) => s.section === "落とし穴").items.map((i) => i.h);
  const ref = (h) => ({ page: PATH_A, section: "落とし穴", h });
  const r = apply([{ op: "merge", items: [ref(hs[0]), ref(hs[1])], into: { page: PATH_A, section: "落とし穴" }, text: "統合した行" }], state({ pages: { [PATH_A]: dup } }));
  assert.deepEqual(r.rejected, []);
  assert.ok(r.state.pages.get(PATH_A).includes("- 統合した行（W1）"));
  assert.ok(!r.state.pages.get(PATH_A).includes("- 同じ行"));
  assert.equal(parseHistory(r.state.histories.get("projects/owl/_history/テスト実行.md")).entries.length, 2);
});

test("retiring and then restoring a line in a page with LF, CRLF or mixed line endings returns the page sha256 to its value before the retirement", () => {
  const roundTrip = (text, itemIndex) => {
    const st = state({ pages: { [PATH_A]: text } });
    const h = itemsOf(text).find((s) => s.section === "落とし穴").items[itemIndex].h;
    const r = apply([{ op: "retire", item: { page: PATH_A, section: "落とし穴", h }, reason: "missing_path", evidence: { paths: ["src/old.ts"] } }], st);
    assert.deepEqual(r.rejected, []);
    assert.notEqual(sha(r.state.pages.get(PATH_A)), sha(text));
    const hp = "projects/owl/_history/テスト実行.md";
    const entry = parseHistory(r.state.histories.get(hp)).entries[0];
    const back = apply([{ op: "restore", history: hp, entry: entry.id }], { ...r.state, pageIds: st.pageIds });
    assert.deepEqual(back.rejected, []);
    return { entry, restored: back.state.pages.get(PATH_A), before: text };
  };
  const crlf = textA.replace(/\n/g, "\r\n");
  const mixed = textA.replace("- 別の落とし穴（W11）", "- 別の落とし穴（W11）\r");
  for (const [text, i] of [[textA, 2], [crlf, 2]]) {
    const r = roundTrip(text, i);
    assert.equal(sha(r.restored), sha(r.before));
  }
  const m = roundTrip(mixed, 1);
  assert.ok(m.entry.lines.some((l) => l.endsWith("\r")));
  assert.equal(sha(m.restored), sha(m.before));
  // frontmatter の区切り行・updated 行が CRLF の混在ページ、updated を引用符で囲んだページ
  const upd = /^updated: .*$/m.exec(textA)[0];
  const variants = [
    mixed.replace(upd, `${upd}\r`),
    mixed.replace(/^---$/gm, "---\r"),
    textA.replace(upd, `updated: "${upd.slice(9)}"`),
    mixed.replace(upd, `${upd}\r`).replace(/^---$/gm, "---\r"),
  ];
  for (const v of variants) {
    assert.notEqual(v, textA);
    const r = roundTrip(v, v === variants[2] ? 2 : 1);
    assert.equal(sha(r.restored), sha(r.before));
  }
});

test("a legacy history entry (a bare-date updated before the update, or no item before the update) can be read and restored", () => {
  const hp = "projects/owl/_history/テスト実行.md";
  const st = state({ pages: { [PATH_A]: textA } });
  const h = itemsOf(textA).find((s) => s.section === "落とし穴").items[2].h;
  const r = apply([{ op: "retire", item: { page: PATH_A, section: "落とし穴", h }, reason: "missing_path", evidence: { paths: ["src/old.ts"] } }], st);
  assert.deepEqual(r.rejected, []);
  const histText = r.state.histories.get(hp);
  const fresh = parseHistory(histText).entries[0];
  assert.match(fresh.pre_updated, /^updated: /);
  const restoreFrom = (text) => apply([{ op: "restore", history: hp, entry: fresh.id }], { ...r.state, histories: new Map([[hp, text]]), pageIds: st.pageIds });
  // 旧形式: 更新前updated が素の日付
  const bare = histText.replace(/^- 更新前updated: (".*")$/m, (_, j) => `- 更新前updated: ${JSON.parse(j).slice("updated: ".length)}`);
  assert.notEqual(bare, histText);
  const old = parseHistory(bare).entries[0];
  assert.equal(old.pre_updated, fresh.pre_updated);
  assert.deepEqual(old.pre_updates, fresh.pre_updates);
  const back = restoreFrom(bare);
  assert.deepEqual(back.rejected, []);
  assert.equal(sha(back.state.pages.get(PATH_A)), sha(textA));
  // 更新前の項目なし: 行は戻る
  const none = histText.split("\n").filter((l) => !l.startsWith("- 更新前")).join("\n");
  const plain = parseHistory(none).entries[0];
  assert.equal(plain.pre_updated, undefined);
  const back2 = restoreFrom(none);
  assert.deepEqual(back2.rejected, []);
  assert.ok(back2.state.pages.get(PATH_A).includes("src/old.ts を使う"));
  // 新形式の読み書き
  assert.match(histText, /^- 更新前updated: "updated: /m);
});

test("applyOperationsToRoot applies to the files of the given root and leaves the sha256 unchanged on rejection", () => {
  const root = mkdtempSync(join(tmpdir(), "ops-"));
  try {
    for (const [p, t] of [[PATH_A, textA], [PATH_B, textB], [PATH_C, textC]]) { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), t); }
    const snap = () => [PATH_A, PATH_B, PATH_C].map((p) => sha(readFileSync(join(root, p), "utf8")));
    const before = snap();
    const bad = applyOperationsToRoot(root, [{ op: "retire", item: item(PATH_A, "落とし穴", 2), reason: "missing_path", evidence: {} }], ctx());
    assert.equal(bad.rejected.length, 1);
    assert.deepEqual(snap(), before);
    assert.ok(!existsSync(join(root, "projects/owl/_history")));
    const ok = applyOperationsToRoot(root, [{ op: "retire", item: item(PATH_A, "落とし穴", 2), reason: "missing_path", evidence: { paths: ["src/old.ts"] } }], ctx());
    assert.deepEqual(ok.rejected, []);
    assert.ok(!readFileSync(join(root, PATH_A), "utf8").includes("src/old.ts を使う"));
    assert.ok(readFileSync(join(root, "projects/owl/_history/テスト実行.md"), "utf8").includes("src/old.ts を使う"));
    assert.equal(snap()[1], before[1]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The shape the model returns must not change what is applied: flat vs wrapped by name, per operation.
test("every operation applies the same when wrapped by its name, with or without a matching op, or with a differently cased op", () => {
  const retireOp = { op: "retire", item: item(PATH_A, "落とし穴", 1), reason: "missing_path", evidence: { paths: ["src/old.ts"] } };
  const retired = apply([retireOp]);
  const histPath = "projects/owl/_history/テスト実行.md";
  const entry = parseHistory(retired.state.histories.get(histPath)).entries[0];
  const cases = [
    [{ op: "merge", items: [item(PATH_A, "落とし穴", 0), item(PATH_A, "落とし穴", 1)], into: { page: PATH_A, section: "落とし穴" }, text: "まとめ" }],
    [{ op: "move", item: item(PATH_A, "落とし穴", 1), to: { page: PATH_B, section: "決まりごと" } }],
    [retireOp],
    [{ op: "dormant", page: PATH_A }, {}, { allowCoreOps: true }],
    [{ op: "reactivate", page: PATH_A }, { isDormant: () => true }],
    [{ op: "link", from: PATH_A, to: PATH_B, relation: "同じ" }],
    [{ op: "split", page: PATH_A, new_title: "古い手順", new_summary: "要約", items: [item(PATH_A, "落とし穴", 2)], relation: "切り出し" }],
    [{ op: "promote_common", items: [item(PATH_A, "落とし穴", 0), item(PATH_B, "落とし穴", 0)], to: { title: "tmp の共有", section: "落とし穴" } }],
    [{ op: "restore", history: histPath, entry: entry.id }, {}, undefined, retired.state],
  ];
  assert.equal(cases.length, 9);
  for (const [flat, over, opts, st] of cases) {
    const { op, ...fields } = flat;
    const run = (o) => {
      let n = 0; // the same ids for every run, so the written text can be compared
      const r = apply([o], st ?? state(), { ...over, newId: () => `01M44${String(++n).padStart(21, "0")}` }, opts);
      return { applied: r.applied.length, rejected: r.rejected.map((x) => x.code), pages: [...r.state.pages], histories: [...r.state.histories] };
    };
    const expected = run(flat);
    assert.equal(expected.applied, 1, op);
    for (const wrapped of [{ [op]: fields }, { op, [op]: fields }, { op: ` ${op.toUpperCase()} `, ...fields }]) assert.deepEqual(run(wrapped), expected, op);
  }
});

test("shapes the definition cannot settle are rejected as unknown_op, and every check after shaping still applies to a wrapped operation", () => {
  const retire = { item: item(PATH_A, "落とし穴", 2), reason: "missing_path", evidence: { paths: ["src/old.ts"] } };
  const code = (o, opts) => apply([o], state(), {}, opts).rejected[0]?.code;
  assert.equal(code({ retire, link: { from: PATH_A, to: PATH_B, relation: "r" } }), "unknown_op");
  assert.equal(code({ nonsense: retire }), "unknown_op");
  assert.equal(code({ op: "link", retire }), "unknown_op");
  assert.equal(code({ op: "merge", retire }), "unknown_op");
  assert.equal(code({ toString: retire }), "unknown_op");
  assert.equal(code({ dormant: { page: PATH_A } }), "unknown_op"); // a core-only operation stays refused without allowCoreOps
  const bad = [
    { ...retire, extra: 1 }, // extra key
    { item: retire.item, reason: "missing_path" }, // missing evidence
    { ...retire, evidence: {} }, // retire without evidence
    { ...retire, evidence: { paths: ["src/exists.ts"] } },
    { ...retire, item: { ...retire.item, h: "000000000000" } },
  ];
  for (const fields of bad) {
    const flat = code({ op: "retire", ...fields });
    assert.ok(flat !== undefined, JSON.stringify(fields));
    assert.equal(code({ retire: fields }), flat);
  }
});

test("a list under another key is taken when it is the only one left, otherwise the output is refused", () => {
  assert.deepEqual(parseOperationsOutput({ ops: [{ op: "x" }], note: "n" }), { ops: [{ op: "x" }] });
  assert.deepEqual(parseOperationsOutput({ operations: [], other: [] }), { error: "unexpected_key" });
  assert.deepEqual(parseOperationsOutput({ ops: [], acts: [] }), { error: "unexpected_key" });
  assert.deepEqual(parseOperationsOutput({ ops: "x" }), { error: "unexpected_key" });
  assert.deepEqual(parseOperationsOutput({ pages: [], ops: [] }), { error: "full_text_not_accepted" });
});

test("retire aimed at an Owner-written place is refused with the same code flat or wrapped, and the page stays as it was", () => {
  const fields = { item: { page: PATH_A, section: "更新履歴", h: "000000000000" }, reason: "missing_path", evidence: { paths: ["src/old.ts"] } };
  for (const o of [{ op: "retire", ...fields }, { retire: fields }]) {
    const r = apply([o]);
    assert.equal(r.applied.length, 0);
    assert.equal(r.rejected[0].code, "section_not_allowed");
    assert.equal(r.state.pages.get(PATH_A), textA);
  }
  const broken = state({ pages: { [PATH_A]: "# not a page\n" } });
  const r = apply([{ retire: { ...fields, item: { ...fields.item, section: "落とし穴" } } }], broken);
  assert.equal(r.rejected[0].code, "page_not_writable");
});

test("link, retire(duplicate) and merge keep their field types: objects where a path is expected and one-item merges are missing_field", () => {
  const linkObj = apply([{ op: "link", from: { page: PATH_A, section: "落とし穴" }, to: { page: PATH_B, section: "落とし穴" }, relation: "関連" }]);
  assert.equal(linkObj.rejected[0].code, "missing_field");
  const linkOk = apply([{ op: "link", from: PATH_A, to: PATH_B, relation: "関連" }]);
  assert.deepEqual(linkOk.rejected, []);
  const retireStr = apply([{ op: "retire", item: item(PATH_B, "落とし穴", 0), reason: "duplicate", evidence: { kept: "並列で tmp を共有しない" } }]);
  assert.equal(retireStr.rejected[0].code, "missing_field");
  const retireRef = apply([{ op: "retire", item: item(PATH_B, "落とし穴", 0), reason: "duplicate", evidence: { kept: item(PATH_A, "落とし穴", 0) } }]);
  assert.deepEqual(retireRef.rejected, []);
  const one = apply([{ op: "merge", items: [item(PATH_A, "落とし穴", 1)], into: { page: PATH_A, section: "落とし穴" }, text: "- 別の落とし穴（W11）" }]);
  assert.equal(one.rejected[0].code, "missing_field");
});

test("a rejection reports field names and hash prefixes, never line text", () => {
  const good = item(PATH_A, "落とし穴", 1);
  const r = apply([
    { op: "link", from: PATH_A, to: PATH_B },
    { op: "retire", item: { ...good, h: "deadbeefcafe" }, reason: "missing_path", evidence: { paths: ["src/old.ts"] } },
  ]);
  assert.deepEqual(r.rejected[0].detail, { missing: ["relation"], unknown: [] });
  const d = r.rejected[1].detail;
  assert.deepEqual([d.page, d.section, d.h_given, d.changed_earlier], [PATH_A, "落とし穴", "deadbeef", false]);
  assert.ok(d.h_checked.includes(good.h.slice(0, 8)));
  assert.ok(!JSON.stringify(r.rejected.map((x) => x.detail)).includes("別の落とし穴"));
  // the same page after an earlier operation of the run changed it
  const later = apply([
    { op: "retire", item: item(PATH_A, "落とし穴", 2), reason: "missing_path", evidence: { paths: ["src/old.ts"] } },
    { op: "move", item: { ...good, h: "deadbeefcafe" }, to: { page: PATH_B, section: "落とし穴" } },
  ]);
  assert.equal(later.rejected[0].detail.changed_earlier, true);
});

test("equal lines keep resolving after an earlier operation removed one of them", () => {
  const dup = textA.replace("- 別の落とし穴（W11）", "- 重複（W11）\n- 重複（W11）");
  const hs = itemsOf(dup).find((s) => s.section === "落とし穴").items.filter((i) => i.text.includes("重複")).map((i) => i.h);
  const ref = (h) => ({ page: PATH_A, section: "落とし穴", h });
  const r = apply([
    { op: "move", item: ref(hs[0]), to: { page: PATH_A, section: "決まりごと" } },
    { op: "move", item: ref(hs[1]), to: { page: PATH_A, section: "決まりごと" } },
  ], state({ pages: { [PATH_A]: dup } }));
  assert.deepEqual(r.rejected, []);
  assert.equal(r.applied.length, 2);
});

test("references follow the lines as they stood before the run, however many equal lines an earlier operation removed", () => {
  const dup = textA.replace("- 別の落とし穴（W11）", "- 重複（W11）\n- 重複（W11）\n- 重複（W11）");
  const hs = itemsOf(dup).find((s) => s.section === "落とし穴").items.filter((i) => i.text.includes("重複")).map((i) => i.h);
  assert.equal(hs.length, 3);
  const ref = (h) => ({ page: PATH_A, section: "落とし穴", h });
  const move = (h) => ({ op: "move", item: ref(h), to: { page: PATH_A, section: "決まりごと" } });
  const st = () => state({ pages: { [PATH_A]: dup } });
  // 1st, then 3rd (renumbered to ~2 by now), then 2nd
  const ok = apply([move(hs[0]), move(hs[2]), move(hs[1])], st());
  assert.deepEqual(ok.rejected, []);
  assert.equal(ok.applied.length, 3);
  // a reference used once stays used even though its number now names another line
  const again = apply([move(hs[0]), move(hs[0])], st());
  assert.deepEqual(again.rejected.map((x) => x.code), ["item_already_used"]);
});

test("a reference the model was never shown, or one whose line was already moved, is still rejected", () => {
  const dup = textA.replace("- 別の落とし穴（W11）", "- 重複（W11）\n- 重複（W11）");
  const hs = itemsOf(dup).find((s) => s.section === "落とし穴").items.filter((i) => i.text.includes("重複")).map((i) => i.h);
  const base = hs[0].split("~")[0];
  const mv = (h) => ({ op: "move", item: { page: PATH_A, section: "落とし穴", h }, to: { page: PATH_A, section: "決まりごと" } });
  const r = apply([mv(`${base}~999`), mv("invalid~1"), mv(base)], state({ pages: { [PATH_A]: dup } }));
  assert.deepEqual(r.rejected.map((x) => x.code), ["line_hash_mismatch", "line_hash_mismatch", "line_hash_mismatch"]);
  const good = item(PATH_A, "落とし穴", 1);
  const gone = apply([{ op: "move", item: good, to: { page: PATH_B, section: "落とし穴" } }, { op: "retire", item: good, reason: "missing_path", evidence: { paths: ["src/old.ts"] } }]);
  assert.deepEqual(gone.rejected.map((x) => x.code), ["item_already_used"]);
});

test("merge, link and retire name their failure: a stale line hash, a missing field, a wrong type or an extra key", () => {
  const a = item(PATH_A, "落とし穴", 0);
  const b = item(PATH_A, "落とし穴", 1);
  const run = (ops) => apply(ops).rejected.map((x) => [x.code, x.detail?.missing]);
  const to = { page: PATH_A, section: "落とし穴" };
  assert.deepEqual(run([{ op: "merge", items: [a, { ...b, h: "deadbeefcafe" }], into: to, text: "x" }]), [["line_hash_mismatch", undefined]]);
  assert.deepEqual(run([{ op: "link", from: PATH_A, to: PATH_B }]), [["missing_field", ["relation"]]]);
  assert.deepEqual(run([{ op: "link", from: PATH_A, to: 3, relation: "r" }]), [["missing_field", ["to"]]]);
  assert.deepEqual(run([{ op: "retire", item: a, reason: "missing_path" }]).map((x) => x[0]), ["missing_field"]);
  assert.deepEqual(run([{ op: "retire", item: { ...a, extra: 1 }, reason: "missing_path", evidence: { paths: ["x"] } }]).map((x) => x[0]), ["missing_field"]);
  assert.deepEqual(run([{ op: "link", from: PATH_A, to: PATH_B, relation: "r", extra: 1 }]).map((x) => x[0]), ["unknown_op"]);
});

test("a merge after an earlier removal of an equal line keeps its references, and an unshown bare hash stays rejected", () => {
  const dup = textA.replace("- 別の落とし穴（W11）", "- 重複（W11）\n- 重複（W11）\n- 重複（W11）");
  const hs = itemsOf(dup).find((s) => s.section === "落とし穴").items.filter((i) => i.text.includes("重複")).map((i) => i.h);
  const ref = (h) => ({ page: PATH_A, section: "落とし穴", h });
  const first = { op: "move", item: ref(hs[0]), to: { page: PATH_A, section: "決まりごと" } };
  const ok = apply([first, { op: "merge", items: [ref(hs[1]), ref(hs[2])], into: { page: PATH_A, section: "落とし穴" }, text: "まとめ" }], state({ pages: { [PATH_A]: dup } }));
  assert.deepEqual(ok.rejected, []);
  const bare = hs[0].split("~")[0];
  const two = textA.replace("- 別の落とし穴（W11）", "- 重複（W11）\n- 重複（W11）");
  const r = apply([{ op: "move", item: ref(bare), to: { page: PATH_A, section: "決まりごと" } }], state({ pages: { [PATH_A]: two } }));
  assert.equal(r.rejected[0].code, "line_hash_mismatch");
});

test("missing_field names the unknown keys inside a ref or the evidence, never their values", () => {
  const a = item(PATH_A, "落とし穴", 0);
  const d = (op) => apply([op]).rejected[0].detail;
  const inRef = d({ op: "retire", item: { ...a, extra: "SECRET" }, reason: "missing_path", evidence: { paths: ["x"] } });
  assert.deepEqual(inRef.unknown, ["extra"]);
  assert.ok(!JSON.stringify(inRef).includes("SECRET"));
  assert.deepEqual(d({ op: "retire", item: a, reason: "missing_path", evidence: { paths: ["x"], bogus: "SECRET" } }).unknown, ["bogus"]);
});

test("evidence_item_missing says which reference failed and why, with a hash prefix only", () => {
  const a = item(PATH_A, "落とし穴", 0);
  const retire = (evidence) => apply([{ op: "retire", item: a, reason: "duplicate", evidence }]).rejected[0];
  const same = retire({ kept: a });
  assert.equal(same.code, "evidence_item_missing");
  assert.deepEqual(same.detail, { field: "kept", page: PATH_A, section: "落とし穴", h_given: a.h.slice(0, 8), cause: "same_as_item" });
  const gone = retire({ kept: { ...item(PATH_B, "落とし穴", 0), h: "deadbeefcafe" } });
  assert.deepEqual([gone.detail.field, gone.detail.cause, gone.detail.h_given], ["kept", "line_hash_mismatch", "deadbeef"]);
});

// ---------------------------------------------------------------- split into an existing page, other pages, limits, update history

const nid = (n) => `01M4FB${String(n).padStart(20, "0")}`;
const SIZE = pageSize(parsePage(textA));
const LIMIT = Object.fromEntries(SIZE.sections.map((s) => [s.section, s.limit]));
const TOKEN_LIMIT = SIZE.token_limit;
const sizeOf = (text) => pageSize(parsePage(text));
const stateOf = (pages, histories = {}) => ({ pages: new Map(Object.entries(pages)), histories: new Map(Object.entries(histories)), pageIds: new Map() });
const refsOf = (text, path, section) => itemsOf(text).find((s) => s.section === section).items.map((i) => ({ page: path, section, h: i.h }));
const same = (st, r) => { for (const [p, t] of st.pages) assert.equal(r.state.pages.get(p), t, p); assert.equal(r.state.pages.size, st.pages.size); assert.equal(r.state.histories.size, st.histories.size); };
/** Every list line of the pages except links, audit lines and placeholders, sorted: nothing is lost or doubled. */
const bulletsOf = (...maps) => maps.flatMap((m) => [...m.values()]).flatMap((t) => t.split("\n")).filter((l) => /^- /u.test(l) && !l.startsWith("- [[") && !l.includes("司書:") && !l.includes("（なし）")).sort();

const PATH_D = "projects/owl/既存の手順.md";
const textD = page({ id: nid(1), title: "既存の手順", sections: { 落とし穴: ["- 既存の行（W1）"] } });

test("split with into appends the lines to the same sections of an existing page of the same scope and project, links the pages once, and never says title_exists", () => {
  const st = state({ pages: { [PATH_D]: textD } });
  const r = apply([
    { op: "split", page: PATH_A, into: PATH_D, items: [item(PATH_A, "落とし穴", 1)], relation: "移した" },
    { op: "split", page: PATH_A, into: PATH_D, items: [item(PATH_A, "決まりごと", 0)], relation: "移した" },
  ], st);
  assert.deepEqual(r.rejected, []);
  const d = r.state.pages.get(PATH_D);
  assert.ok(d.includes("- 既存の行（W1）\n- 別の落とし穴（W11）") && d.includes("- 決まりその 1（W1）"));
  assert.equal(d.split("- [[テスト実行]]").length - 1, 1);
  assert.equal(r.state.pages.get(PATH_A).split("- [[既存の手順]]").length - 1, 1);
  assert.equal(r.state.pageIds.size, st.pageIds.size);
  assert.deepEqual(bulletsOf(r.state.pages), bulletsOf(st.pages));
});

test("a second split with the same new_title appends to the page the first one created in the same run", () => {
  const split = (n) => ({ op: "split", page: PATH_A, new_title: "まとめ先", new_summary: "要約", items: [item(PATH_A, "落とし穴", n)], relation: "r" });
  const r = apply([split(1), split(2)]);
  assert.deepEqual(r.rejected, []);
  assert.equal(r.state.pages.size, 4);
  const created = r.state.pages.get("projects/owl/まとめ先.md");
  assert.ok(created.includes("- 別の落とし穴（W11）") && created.includes("- 古い手順は src/old.ts を使う（W5）"));
});

test("a new_title used by a page of another project or of common creates the page next to the source; a new_title equal to the source's own title is split_into_self", () => {
  for (const title of ["ビルド", "共有メモ"]) {
    const r = apply([{ op: "split", page: PATH_A, new_title: title, new_summary: "s", items: [item(PATH_A, "落とし穴", 1)], relation: "r" }]);
    assert.deepEqual(r.rejected, []);
    assert.ok(r.state.pages.get(`projects/owl/${title}.md`).includes("- 別の落とし穴（W11）"));
    assert.equal(r.state.pages.get(PATH_B), textB);
    assert.equal(r.state.pages.get(PATH_C), textC);
  }
  const self = apply([{ op: "split", page: PATH_A, new_title: "テスト実行", new_summary: "s", items: [item(PATH_A, "落とし穴", 1)], relation: "r" }]);
  assert.equal(self.rejected[0].code, "split_into_self");
  const stray = state({ pages: { "projects/owl/別.md": page({ id: nid(2), title: "別の題名" }) } });
  const clash = apply([{ op: "split", page: PATH_A, new_title: "別", new_summary: "s", items: [item(PATH_A, "落とし穴", 1)], relation: "r" }], stray);
  assert.equal(clash.rejected[0].code, "title_exists");
  same(stray, clash);
});

test("a split with a wrong destination is rejected with its own code and every page keeps its bytes; a dormant destination is applied and reactivated", () => {
  const archived = textD.replace("status: active", "status: archived");
  const st = state({ pages: { [PATH_D]: textD, "projects/owl/済.md": archived.replace("既存の手順", "済") } });
  const split = (extra) => ({ op: "split", page: PATH_A, items: [item(PATH_A, "落とし穴", 1)], relation: "r", ...extra });
  const cases = [
    [split({ into: PATH_D, new_title: "x" }), "split_target_conflict"],
    [split({ into: PATH_D, new_summary: "x" }), "split_target_conflict"],
    [split({}), "missing_field", { missing: ["into", "new_title"], unknown: [] }],
    [split({ new_title: "新規" }), "missing_field", { missing: ["new_summary"], unknown: [] }],
    [split({ into: "projects/owl/無い.md" }), "unknown_page"],
    [split({ into: PATH_B }), "scope_mismatch", { into: PATH_B, reason: "project" }],
    [split({ into: PATH_C }), "scope_mismatch", { into: PATH_C, reason: "scope" }],
    [split({ into: "projects/owl/済.md" }), "page_not_writable"],
    [split({ into: PATH_A }), "split_into_self"],
  ];
  for (const [op, code, detail] of cases) {
    const r = apply([op], st);
    assert.equal(r.rejected[0]?.code, code, JSON.stringify(op));
    if (detail) assert.deepEqual(r.rejected[0].detail, detail);
    same(st, r);
  }
  const dormant = apply([split({ into: PATH_D })], st, { isDormant: (p) => p === PATH_D });
  assert.deepEqual(dormant.rejected, []);
  assert.deepEqual(dormant.activity, [{ page: PATH_D, action: "reactivate" }]);
});

test("a line named under a page that does not hold it is item_in_other_page with the pages that do, and nothing changes", () => {
  const X = "projects/owl/同題.md";
  const Y = "common/同題.md";
  const Z = "projects/other/同題.md";
  const line = "- 共通側だけにある行（W1）";
  const xText = page({ id: nid(3), title: "同題", sections: { 落とし穴: ["- 個別の行（W2）"] } });
  const yText = page({ id: nid(4), title: "同題", scope: "common", sections: { 落とし穴: [line] } });
  const zText = page({ id: nid(5), title: "同題", project: P2, sections: { 落とし穴: [line] } });
  const h = refsOf(yText, Y, "落とし穴")[0].h;
  const move = { op: "move", item: { page: X, section: "落とし穴", h }, to: { page: X, section: "決まりごと" } };
  const one = stateOf({ [X]: xText, [Y]: yText });
  const r1 = apply([move], one);
  assert.equal(r1.rejected[0].code, "item_in_other_page");
  assert.deepEqual(r1.rejected[0].detail, { page: X, section: "落とし穴", h_given: h.slice(0, H_PREFIX), found_in: [Y] });
  same(one, r1);
  const two = stateOf({ [X]: xText, [Y]: yText, [Z]: zText });
  const r2 = apply([move], two);
  assert.deepEqual(r2.rejected[0].detail.found_in.sort(), [Y, Z]);
  same(two, r2);
  const r3 = apply([{ ...move, item: { ...move.item, h: "0".repeat(12) } }], one);
  assert.equal(r3.rejected[0].code, "line_hash_mismatch");
  same(one, r3);
});

test("a page that receives lines must fit every limit afterwards, its audit line included, or the operation is target_over_limit and every page keeps its lines", () => {
  const rejectedWith = (st, ops, expected) => {
    const r = apply(ops, st);
    assert.equal(r.rejected[0]?.code, "target_over_limit");
    assert.deepEqual(r.rejected[0].detail, expected);
    same(st, r);
  };
  // a section already at its line limit
  const full = page({ id: nid(6), title: "満杯", sections: { 決まりごと: Array.from({ length: LIMIT.決まりごと }, (_, i) => `- 決まり ${i}（W1）`) } });
  rejectedWith(state({ pages: { "projects/owl/満杯.md": full } }), [{ op: "move", item: item(PATH_A, "落とし穴", 0), to: { page: "projects/owl/満杯.md", section: "決まりごと" } }],
    { page: "projects/owl/満杯.md", role: "destination", section: "決まりごと", limit: LIMIT.決まりごと, before: LIMIT.決まりごと, after: LIMIT.決まりごと + 1 });
  // a section the lines do not go to is over its limit
  const src = page({ id: nid(7), title: "元", sections: { 概要: ["- 概要の行 1", "- 概要の行 2"] } });
  const over = page({ id: nid(8), title: "超過", sections: { 落とし穴: Array.from({ length: LIMIT.落とし穴 + 1 }, (_, i) => `- 落とし穴 ${i}（W1）`) } });
  const st2 = stateOf({ "projects/owl/元.md": src, "projects/owl/超過.md": over });
  rejectedWith(st2, [{ op: "split", page: "projects/owl/元.md", into: "projects/owl/超過.md", items: [refsOf(src, "projects/owl/元.md", "概要")[0]], relation: "r" }],
    { page: "projects/owl/超過.md", role: "destination", section: "落とし穴", limit: LIMIT.落とし穴, before: LIMIT.落とし穴 + 1, after: LIMIT.落とし穴 + 1 });
  // a new page over the token limit
  const wide = "あ".repeat(500);
  const n = Math.ceil(TOKEN_LIMIT / 500) + 1;
  assert.ok(n < LIMIT.落とし穴);
  const bigSrc = page({ id: nid(9), title: "大元", sections: { 落とし穴: Array.from({ length: n + 1 }, (_, i) => `- ${wide}${i}`) } });
  const st3 = stateOf({ "projects/owl/大元.md": bigSrc });
  const r3 = apply([{ op: "split", page: "projects/owl/大元.md", new_title: "大先", new_summary: "s", items: refsOf(bigSrc, "projects/owl/大元.md", "落とし穴").slice(0, n), relation: "r" }], st3);
  assert.equal(r3.rejected[0].code, "target_over_limit");
  assert.equal(r3.rejected[0].detail.role, "destination");
  assert.equal(r3.rejected[0].detail.section, null);
  assert.equal(r3.rejected[0].detail.limit, TOKEN_LIMIT);
  assert.ok(r3.rejected[0].detail.after > TOKEN_LIMIT);
  same(st3, r3);
  // fits without the audit line, does not with it: the largest padding that is accepted ends exactly at the limit
  const target = (pad) => page({ id: nid(10), title: "境界", sections: { 落とし穴: [`- ${"あ".repeat(pad)}`] } });
  const sink = stateOf({ [PATH_A]: textA });
  const tryPad = (pad) => apply([{ op: "split", page: PATH_A, into: "projects/owl/境界.md", items: [item(PATH_A, "落とし穴", 1)], relation: "r" }], stateOf({ [PATH_A]: textA, "projects/owl/境界.md": target(pad) }));
  let pad = TOKEN_LIMIT;
  while (tryPad(pad).rejected.length > 0) pad -= 1;
  const accepted = tryPad(pad).state.pages.get("projects/owl/境界.md");
  assert.ok(accepted.includes("司書:") && sizeOf(accepted).tokens <= TOKEN_LIMIT);
  assert.equal(tryPad(pad + 1).rejected[0].detail.after, TOKEN_LIMIT + 1);
  assert.ok(sink.pages.size > 0);
});

test("merge into a section already at its line limit is target_over_limit and the page keeps its lines", () => {
  const P = "projects/owl/満杯の落とし穴.md";
  const full = page({ id: nid(15), title: "満杯の落とし穴", sections: { 落とし穴: Array.from({ length: LIMIT.落とし穴 }, (_, i) => `- 穴 ${i}（W1）`), 概要: ["- 概要の行 1", "- 概要の行 2"] } });
  const st = stateOf({ [P]: full });
  const r = apply([{ op: "merge", items: refsOf(full, P, "概要"), into: { page: P, section: "落とし穴" }, text: "まとめ" }], st);
  assert.equal(r.rejected[0]?.code, "target_over_limit");
  assert.equal(r.rejected[0].detail.section, "落とし穴");
  same(st, r);
});

test("a page that only gives lines may stay over its limits while it shrinks, but nothing over a limit grows and nothing within one crosses it", () => {
  const wide = "あ".repeat(300);
  const lines = Array.from({ length: LIMIT.落とし穴 + 2 }, (_, i) => `- 長い行 ${i} ${wide}`);
  const S = "projects/owl/超過元.md";
  const sText = page({ id: nid(11), title: "超過元", sections: { 落とし穴: lines } });
  assert.ok(sizeOf(sText).tokens > TOKEN_LIMIT);
  const E = "projects/owl/空き.md";
  const st = stateOf({ [S]: sText, [E]: page({ id: nid(12), title: "空き" }) });
  const ok = apply([{ op: "split", page: S, into: E, items: refsOf(sText, S, "落とし穴").slice(0, 2), relation: "r" }], st);
  assert.deepEqual(ok.rejected, []);
  const after = sizeOf(ok.state.pages.get(S));
  assert.ok(after.tokens > TOKEN_LIMIT && after.tokens < sizeOf(sText).tokens);
  assert.deepEqual(bulletsOf(ok.state.pages), bulletsOf(st.pages));
  // inside one page: a section at its limit, a section over its limit
  const crossing = (sections, from, to) => {
    const text = page({ id: nid(13), title: "同頁", sections });
    const st2 = stateOf({ "projects/owl/同頁.md": text });
    const r = apply([{ op: "move", item: refsOf(text, "projects/owl/同頁.md", from)[0], to: { page: "projects/owl/同頁.md", section: to } }], st2);
    assert.equal(r.rejected[0]?.code, "target_over_limit");
    same(st2, r);
    return r.rejected[0].detail;
  };
  const rows = (n, label) => Array.from({ length: n }, (_, i) => `- ${label} ${i}`);
  const d1 = crossing({ 決まりごと: rows(LIMIT.決まりごと, "決"), 落とし穴: rows(1, "穴") }, "落とし穴", "決まりごと");
  assert.deepEqual([d1.role, d1.section, d1.limit, d1.before, d1.after], ["source", "決まりごと", LIMIT.決まりごと, LIMIT.決まりごと, LIMIT.決まりごと + 1]);
  const d2 = crossing({ 概要: rows(LIMIT.概要 + 1, "概"), 落とし穴: rows(1, "穴") }, "落とし穴", "概要");
  assert.deepEqual([d2.role, d2.section, d2.before, d2.after], ["source", "概要", LIMIT.概要 + 1, LIMIT.概要 + 2]);
  // taking in an owl:new line only drops the mark, yet the audit line makes an over-token page grow
  const marked = [...Array.from({ length: 4 }, (_, i) => `- ${"あ".repeat(800)}${i}`), `- 新しい行 ${"あ".repeat(100)} <!-- owl:new 2026-10-01 W1 -->`];
  const mText = page({ id: nid(14), title: "印", sections: { 落とし穴: marked } });
  assert.ok(sizeOf(mText).tokens > TOKEN_LIMIT && sizeOf(mText).sections.every((s) => s.lines <= s.limit));
  const M = "projects/owl/印.md";
  const st3 = stateOf({ [M]: mText });
  const r3 = apply([{ op: "move", item: refsOf(mText, M, "落とし穴")[4], to: { page: M, section: "落とし穴" } }], st3);
  assert.equal(r3.rejected[0].code, "target_over_limit");
  assert.deepEqual([r3.rejected[0].detail.role, r3.rejected[0].detail.section, r3.rejected[0].detail.before], ["source", null, sizeOf(stripNew(mText)).tokens]);
  assert.ok(r3.rejected[0].detail.after > r3.rejected[0].detail.before);
  same(st3, r3);
});

test("Core moves the oldest 更新履歴 lines over the limit to _history before the operations, whoever wrote them, and the audit line pushes the oldest line out when it is full", () => {
  const updates = (n) => Array.from({ length: n }, (_, i) => `- 2026-08-${String(30 - i).padStart(2, "0")} Owner: メモ ${i}`);
  const U = "projects/owl/履歴.md";
  const HU = "projects/owl/_history/履歴.md";
  const newer = (text) => parseHistory(text).updates;
  // before the operations: over by two, an operation that does not touch the page
  const over = page({ id: nid(15), title: "履歴", sections: { 更新履歴: updates(LIMIT.更新履歴 + 2) } });
  const st = state({ pages: { [U]: over } });
  const r = apply([{ op: "link", from: PATH_B, to: PATH_C, relation: "r" }], st);
  assert.deepEqual(r.rejected, []);
  const settled = r.state.pages.get(U);
  assert.equal(sizeOf(settled).sections.find((s) => s.section === "更新履歴").lines, LIMIT.更新履歴);
  assert.ok(settled.includes("updated: 2026-09-01") && !settled.includes("司書:"));
  assert.deepEqual(newer(r.state.histories.get(HU)), updates(LIMIT.更新履歴 + 2).slice(LIMIT.更新履歴));
  assert.equal([...settled.split("\n"), ...r.state.histories.get(HU).split("\n")].filter((l) => l.includes("Owner: メモ")).length, LIMIT.更新履歴 + 2);
  // the audit line of this run
  const full = page({ id: nid(15), title: "履歴", sections: { 更新履歴: updates(LIMIT.更新履歴) } });
  const st2 = state({ pages: { [U]: full } });
  const r2 = apply([{ op: "link", from: U, to: PATH_C, relation: "r" }], st2);
  assert.deepEqual(r2.rejected, []);
  const written = r2.state.pages.get(U);
  assert.ok(written.includes("updated: 2026-10-05") && written.includes("- 2026-10-05 司書: リンク 1"));
  assert.equal(sizeOf(written).sections.find((s) => s.section === "更新履歴").lines, LIMIT.更新履歴);
  assert.deepEqual(newer(r2.state.histories.get(HU)), updates(LIMIT.更新履歴).slice(-1));
  // an archived page stays as it is
  const archived = over.replace("status: active", "status: archived");
  const st3 = state({ pages: { [U]: archived } });
  const r3 = apply([{ op: "link", from: PATH_B, to: PATH_C, relation: "r" }], st3);
  assert.equal(r3.state.pages.get(U), archived);
  assert.equal(r3.state.histories.size, 0);
});

test("the update lines Core moves go to the top of ## 更新履歴 in _history/<題名>.md in each of its four shapes, and its retired entries stay", () => {
  const U = "projects/owl/履歴.md";
  const HU = "projects/owl/_history/履歴.md";
  const moved = Array.from({ length: LIMIT.更新履歴 + 1 }, (_, i) => `- 2026-08-${String(30 - i).padStart(2, "0")} Owner: メモ ${i}`);
  const pageText = page({ id: nid(16), title: "履歴", sections: { 更新履歴: moved } });
  const fm = { id: nid(17), type: "history", title: "履歴 の履歴", page_id: nid(16), created: "2026-08-01", updated: "2026-08-01" };
  const entry = { id: nid(18), date: "2026-08-02", reason: "重複", section: "落とし穴", evidence: "e", replaced_by: "r", before: "（欄の先頭）", lines: ["- 退役した行"], restored: null };
  const render = (entries, updates) => renderHistory({ frontmatter: fm, frontmatter_order: Object.keys(fm), title: "履歴 の履歴", entries, updates });
  const oldLine = "- 2026-07-01 古い更新";
  const shapes = {
    withUpdates: [render([entry], [oldLine]), 1],
    retiredOnly: [render([entry], []), 1],
    oldShape: [`---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n# 履歴 の履歴\n\n${oldLine}\n`, 0],
  };
  for (const [name, [text, entries]] of Object.entries(shapes)) {
    const r = apply([{ op: "link", from: PATH_B, to: PATH_C, relation: "r" }], state({ pages: { [U]: pageText }, histories: { [HU]: text } }));
    const out = r.state.histories.get(HU);
    assert.ok(out.indexOf(moved[LIMIT.更新履歴]) > out.indexOf("## 更新履歴"), name);
    assert.ok(out.indexOf(moved[LIMIT.更新履歴]) < out.indexOf(oldLine) || !text.includes(oldLine), name);
    assert.equal(parseHistory(out).entries.length, entries, name);
    assert.ok(out.includes("updated: 2026-10-05"), name);
  }
  const none = apply([{ op: "link", from: PATH_B, to: PATH_C, relation: "r" }], state({ pages: { [U]: pageText } }));
  const created = parseHistory(none.state.histories.get(HU));
  assert.deepEqual([created.entries.length, created.updates, created.frontmatter.type], [0, [moved[LIMIT.更新履歴]], "history"]);
});

test("a split from a page whose 関連ページ is full is applied without the link and warns link_skipped_section_full", () => {
  const S = "projects/owl/関連満杯.md";
  const links = Array.from({ length: LIMIT.関連ページ }, (_, i) => `- [[他${i}]] — 関連`);
  const sText = page({ id: nid(19), title: "関連満杯", sections: { 落とし穴: ["- 行 1", "- 行 2"], 関連ページ: links } });
  const r = apply([{ op: "split", page: S, new_title: "切出し", new_summary: "s", items: [refsOf(sText, S, "落とし穴")[0]], relation: "r" }], stateOf({ [S]: sText }));
  assert.deepEqual(r.rejected, []);
  assert.ok(!r.state.pages.get(S).includes("[[切出し]]"));
  assert.ok(r.state.pages.get("projects/owl/切出し.md").includes("- [[関連満杯]] — r"));
  assert.ok(r.warnings.some((w) => w.page === S && w.code === "link_skipped_section_full"));
});

test("split names a new page by slugifyKnowledgeName and keeps the title, and a 「・」 path reaches the page stored with 「-」", () => {
  const dashed = "projects/owl/テスト-検証.md";
  const st = state({ pages: { [dashed]: page({ id: "01M441RV39VR4X2CEA1G2K2P9A", title: "テスト・検証" }) } });
  const r = apply([{ op: "split", page: PATH_A, new_title: "テスト・検証・リソース", new_summary: "s", items: [item(PATH_A, "落とし穴", 2)], relation: "切り出し" }], st);
  assert.deepEqual(r.rejected, []);
  assert.ok(r.state.pages.get("projects/owl/テスト-検証-リソース.md").includes("title: テスト・検証・リソース"));
  assert.ok(!r.state.pages.has("projects/owl/テスト・検証・リソース.md"));
  const into = apply([{ op: "split", page: PATH_A, into: "projects/owl/テスト・検証.md", items: [item(PATH_A, "落とし穴", 3)], relation: "切り出し" }], st);
  assert.deepEqual(into.rejected, []);
  assert.ok(into.state.pages.get(dashed).includes("切り出す行") || into.state.pages.get(dashed).includes("末尾の行"));
});

test("link resolves a 「・」 path to a page an earlier split of the same run created with 「-」", () => {
  const r = apply([
    { op: "split", page: PATH_A, new_title: "テスト・検証・リソース", new_summary: "s", items: [item(PATH_A, "落とし穴", 2)], relation: "切り出し" },
    { op: "link", from: PATH_A, to: "projects/owl/テスト・検証・リソース.md", relation: "関連" },
  ]);
  assert.ok(!r.rejected.some((x) => x.code === "unknown_page"), JSON.stringify(r.rejected));
});

test("a split from the 「その他」 page or its continuation into a numbered continuation page is rejected; theme pages stay allowed", () => {
  const OTHER = "common/その他の注意.md";
  const CONT = "common/その他の注意-2.md";
  const otherText = page({ id: nid(10), title: "その他の注意", scope: "common", sections: { 落とし穴: ["- 一（W1）", "- 二（W2）", "- 三（W3）"] } });
  const contText = page({ id: nid(11), title: "その他の注意（2）", scope: "common", sections: { 落とし穴: ["- 四（W4）", "- 五（W5）"] } });
  const themeText = page({ id: nid(12), title: "テーマ", scope: "common", sections: { 落とし穴: ["- 既存（W6）"] } });
  const st = () => stateOf({ [OTHER]: otherText, [CONT]: contText, "common/テーマ.md": themeText });
  const one = (src, text, extra) => ({ op: "split", page: src, items: [refsOf(text, src, "落とし穴")[0]], relation: "r", ...extra });
  for (const extra of [{ new_title: "その他の注意（2）", new_summary: "s" }, { new_title: "その他の注意 2", new_summary: "s" }, { into: CONT }]) {
    const s = st();
    const r = apply([one(OTHER, otherText, extra)], s);
    assert.equal(r.rejected[0]?.code, "split_into_continuation", JSON.stringify(extra));
    same(s, r);
  }
  const fromCont = apply([one(CONT, contText, { new_title: "その他の注意(3)", new_summary: "s" })], st());
  assert.equal(fromCont.rejected[0]?.code, "split_into_continuation");
  assert.equal(apply([one(OTHER, otherText, { new_title: "ビルド手順", new_summary: "s" })], st()).rejected.length, 0);
  assert.equal(apply([one(OTHER, otherText, { into: "common/テーマ.md" })], st()).rejected.length, 0);
  const normal = apply([one(PATH_A, textA, { new_title: "テスト実行（2）", new_summary: "s" })]);
  assert.equal(normal.rejected.length, 0);
});
