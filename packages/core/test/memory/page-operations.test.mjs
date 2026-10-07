import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyThemePage, lineHash, parseHistory, renderPage } from "../../dist/memory/page-format.js";
import { applyOperations, applyOperationsToRoot, itemsOf, parseOperationsOutput, verifyUntouched } from "../../dist/memory/page-operations.js";

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
  assert.equal(apply([{ op: "split", page: PATH_A, new_title: "ビルド", new_summary: "s", items: [item(PATH_A, "落とし穴", 1)], relation: "r" }]).rejected[0].code, "title_exists");
});

test("promote_common lifts items from two projects into common/ and adds links and related_projects", () => {
  const ops = [{ op: "promote_common", items: [item(PATH_A, "落とし穴", 0), item(PATH_B, "落とし穴", 0)], to: { title: "tmp の共有", section: "落とし穴" } }];
  const r = apply(ops);
  assert.deepEqual(r.rejected, []);
  const common = r.state.pages.get("common/tmp の共有.md");
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

test("a page over the size limit does not fail, loses no line and returns only a warning", () => {
  const many = Array.from({ length: 20 }, (_, i) => `- 落とし穴 ${i} ${"長い文".repeat(200)}（W${i + 1}）`);
  const big = page({ id: ID_A, title: "テスト実行", sections: { 落とし穴: many, 決まりごと: A_RULES } });
  const st = { pages: new Map([[PATH_A, big], [PATH_B, textB]]), histories: new Map(), pageIds: new Map([[ID_A, PATH_A], [ID_B, PATH_B]]) };
  const first = itemsOf(big).find((s) => s.section === "落とし穴").items[0];
  const r = applyOperations(st, [{ op: "link", from: PATH_A, to: PATH_B, relation: "あ".repeat(500) }, { op: "move", item: { page: PATH_A, section: "落とし穴", h: first.h }, to: { page: PATH_A, section: "決まりごと" } }], ctx());
  assert.deepEqual(r.rejected, []);
  const after = r.state.pages.get(PATH_A);
  for (const l of many) assert.ok(after.includes(l));
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
