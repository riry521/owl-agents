import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bodySha256, emptyThemePage, estimatePageTokens, findSecretPatterns, lineHash, PAGE_LIMITS, parseHistory, parsePage, renderHistory, renderPage, themeTitleKey, uniqueFilename, validatePage } from "../../dist/memory/page-format.js";
import { estimateTokens } from "../../dist/knowledge-retrieval.js";
import { matchFolderKind } from "../../dist/memory/folder-kinds.js";
import { DEFAULT_MEMORY_FOLDER_KINDS } from "@owl/shared";

const KINDS = ["theme", "project-index", "work-log", "clipping", "conversation-log"];
const fixture = (kind) => readFileSync(new URL(`./fixtures/pages/${kind}.md`, import.meta.url), "utf8");
const codes = (issues) => issues.map((i) => i.code);
const fake = { sk: `sk-${"a1B2".repeat(8)}`, slack: `xoxb-${"1234567890".repeat(2)}`, gh: `ghp_${"aB3d".repeat(6)}`, aws: `AKIA${"ABCD1234".repeat(2)}` };

for (const kind of KINDS) {
  test(`${kind}: parse then render gives the original text`, () => {
    const text = fixture(kind);
    const page = parsePage(text);
    assert.equal(page.kind, kind);
    assert.equal(renderPage(page), text);
  });
  test(`${kind}: the fictional example is valid for both writers`, () => {
    for (const writer of ["owl", "owner"]) {
      const result = validatePage(parsePage(fixture(kind)), { writer, resolveLink: () => true });
      assert.deepEqual(result.errors, [], `${writer}`);
      assert.deepEqual(result.warnings, []);
    }
  });
}

test("estimatePageTokens equals the old estimateTokens", () => {
  for (const text of ["", "abcd", "日本語のテキスト abc", "ＡＢＣ"]) assert.equal(estimatePageTokens(text), estimateTokens(text));
  assert.equal(estimatePageTokens("abcdefgh"), 2);
  assert.equal(estimatePageTokens("あい"), 2);
});

test("parsePage never throws and handles doubled frontmatter by using the outer block", () => {
  for (const text of ["", "---", "---\n---\n", "no frontmatter", "---\ntype: theme\n---\n---\ntype: log\n---\nbody\n"]) assert.doesNotThrow(() => parsePage(text));
  const page = parsePage("---\ntype: theme\n---\n---\ntype: log\n---\nbody\n");
  assert.equal(page.kind, "theme");
});

test("headings inside a code fence are not sections", () => {
  const page = parsePage(fixture("clipping").replace("## 関係する Project\n", "```\n## 偽の見出し\n```\n## 関係する Project\n"));
  assert.deepEqual(page.sections.map((s) => s.heading), ["出典", "要点", "関係する Project"]);
});

test("frontmatter keys and values: owl is rejected, owner is reported as errors for the index", () => {
  const base = parsePage(fixture("theme"));
  const without = (key) => ({ ...base, frontmatter: Object.fromEntries(Object.entries(base.frontmatter).filter(([k]) => k !== key)), frontmatter_order: base.frontmatter_order.filter((k) => k !== key) });
  for (const writer of ["owl", "owner"]) {
    const missing = validatePage(without("summary"), { writer });
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.errors.map((e) => [e.code, e.key]), [["missing_key", "summary"]]);
    const badScope = validatePage({ ...base, frontmatter: { ...base.frontmatter, scope: "global" } }, { writer });
    assert.deepEqual(badScope.errors.map((e) => [e.code, e.key]), [["invalid_value", "scope"]]);
    const longTitle = validatePage({ ...base, frontmatter: { ...base.frontmatter, title: "あ".repeat(31) } }, { writer });
    assert.equal(longTitle.ok, false);
  }
  const noProject = without("project_id");
  assert.deepEqual(codes(validatePage(noProject, { writer: "owl" }).errors), ["missing_key"]);
  const common = { ...noProject, frontmatter: { ...noProject.frontmatter, scope: "common" } };
  assert.equal(validatePage(common, { writer: "owl" }).ok, true);
  assert.equal(validatePage(parsePage("# 題だけ\n"), { writer: "owner" }).errors[0].code, "missing_frontmatter");
  assert.equal(validatePage(parsePage("---\ntype: memo\n---\n"), { writer: "owl" }).errors[0].code, "unknown_kind");
});

test("section headings must follow the template", () => {
  const base = parsePage(fixture("theme"));
  const dropped = { ...base, sections: base.sections.filter((s) => s.heading !== "手順") };
  assert.deepEqual(validatePage(dropped, { writer: "owl" }).errors.map((e) => [e.code, e.section]), [["missing_section", "手順"]]);
  const extra = { ...base, sections: [...base.sections, { heading: "雑記", lines: ["- x"] }] };
  assert.deepEqual(codes(validatePage(extra, { writer: "owner" }).errors), ["unexpected_section"]);
  const swapped = { ...base, sections: [base.sections[1], base.sections[0], ...base.sections.slice(2)] };
  assert.deepEqual(codes(validatePage(swapped, { writer: "owl" }).errors), ["section_order"]);
  assert.equal(validatePage(parsePage(fixture("clipping")), { writer: "owl" }).ok, true);
});

test("unresolved links are a warning, never an error", () => {
  for (const writer of ["owl", "owner"]) {
    const result = validatePage(parsePage(fixture("theme")), { writer, resolveLink: (t) => t !== "CI の決まりごと" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings.map((w) => w.code), ["unresolved_link"]);
  }
  assert.deepEqual(validatePage(parsePage(fixture("theme")), { writer: "owl" }).warnings, []);
  const ulid = parsePage(fixture("theme").replace("[[CI の決まりごと]]", "[[01HZZZZZZZZZZZZZZZZZZZZZZA]]"));
  assert.deepEqual(validatePage(ulid, { writer: "owl", resolveLink: () => true }).warnings.map((w) => w.code), ["ulid_link"]);
});

test("page size: appends are not rejected, the librarian's output is, the owner is told", () => {
  const base = parsePage(fixture("theme"));
  const big = { ...base, sections: base.sections.map((s) => (s.heading === "概要" ? { ...s, lines: [...s.lines, "あ".repeat(PAGE_LIMITS.theme_tokens + 1)] } : s)) };
  const append = validatePage(big, { writer: "owl" });
  assert.equal(append.ok, true);
  assert.deepEqual(codes(append.warnings), ["over_budget"]);
  assert.ok(append.tokens > PAGE_LIMITS.theme_tokens);
  const librarian = validatePage(big, { writer: "owl", require_integrated: true });
  assert.equal(librarian.ok, true);
  assert.deepEqual(codes(librarian.warnings), ["over_budget"]);
  const owner = validatePage(big, { writer: "owner" });
  assert.equal(owner.ok, true);
  assert.deepEqual(codes(owner.warnings), ["over_budget"]);
});

test("sk- is a secret only at a word start, not inside a word", () => {
  const body = "x".repeat(24);
  assert.deepEqual(findSecretPatterns("task-decision-blocks-work-for-owl-agents"), []);
  assert.deepEqual(findSecretPatterns(`ask-${body}`), []);
  for (const text of [`${"sk-"}${body}`, `key ${"sk-"}${body}`, `k=${"sk-"}${body}`, `"${"sk-"}${body}"`, `${"sk-"}${"ant-"}${body}`]) assert.deepEqual(findSecretPatterns(text), ["sk-"], text);
});

test("secret shapes: owl is rejected, owner is reported", () => {
  assert.deepEqual(findSecretPatterns("plain text sk-short"), []);
  assert.deepEqual(findSecretPatterns(Object.values(fake).join(" ")), ["sk-", "xox[bp]-", "ghp_", "AKIA"]);
  for (const secret of Object.values(fake)) {
    const page = parsePage(fixture("theme").replace("テスト用の DB は毎回作り直す", `鍵は ${secret}`));
    assert.deepEqual(codes(validatePage(page, { writer: "owl" }).errors), ["secret_pattern"]);
    const owner = validatePage(page, { writer: "owner" });
    assert.equal(owner.ok, true);
    assert.deepEqual(codes(owner.warnings), ["secret_pattern"]);
    assert.ok(!JSON.stringify(owner).includes(secret));
  }
});

test("owl:new marks must be gone in the librarian's output", () => {
  const page = parsePage(fixture("theme").replace("（W790）", "（W790） <!-- owl:new 2026-10-03 W790 -->"));
  assert.equal(validatePage(page, { writer: "owl" }).ok, true);
  assert.deepEqual(codes(validatePage(page, { writer: "owl", require_integrated: true }).errors), ["owl_new_left"]);
});

test("filename uniqueness: owl gets -2, -3", () => {
  const taken = new Set(["a.md", "a-2.md"]);
  assert.equal(uniqueFilename("a.md", (n) => taken.has(n)), "a-3.md");
  assert.equal(uniqueFilename("b.md", (n) => taken.has(n)), "b.md");
});

test("helpers: bodySha256 ignores frontmatter, emptyThemePage is valid, themeTitleKey, folder rules", () => {
  const text = fixture("theme");
  assert.equal(bodySha256(text), bodySha256(text.replace("updated: 2026-10-03", "updated: 2026-10-04")));
  assert.notEqual(bodySha256(text), bodySha256(`${text}x`));
  const empty = emptyThemePage({ id: "01HZZZZZZZZZZZZZZZZZZZZZZB", title: "新規", summary: "s", scope: "common", project_id: null, today: "2026-10-03" });
  assert.equal(validatePage(parsePage(renderPage(empty)), { writer: "owl" }).ok, true);
  assert.equal(themeTitleKey("テスト の　ＡＢＣ"), "テストのABC");
  assert.equal(matchFolderKind(DEFAULT_MEMORY_FOLDER_KINDS, "research/2026/a.md")?.type, "clipping");
  assert.equal(matchFolderKind(DEFAULT_MEMORY_FOLDER_KINDS, "advisor/x.md"), null);
  assert.equal(matchFolderKind(DEFAULT_MEMORY_FOLDER_KINDS, "works/2026-10/W1-x.md")?.type, "work-log");
  assert.equal(matchFolderKind(DEFAULT_MEMORY_FOLDER_KINDS, "notes/a.md"), null);
  assert.equal(matchFolderKind({ version: 1, rules: [{ glob: "ext/*/in.md", type: "clipping" }] }, "ext/a/in.md")?.type, "clipping");
  assert.equal(matchFolderKind({ version: 1, rules: [{ glob: "ext/*/in.md", type: "clipping" }] }, "ext/a/b/in.md"), null);
});

test("long lines, many W numbers, too many lines and tokens only warn; the page stays valid", () => {
  const base = parsePage(fixture("theme"));
  const longLine = `- ${"あ".repeat(80)}（W1, W2, W3, W4）`;
  const lines = Array.from({ length: 30 }, (_, i) => `- 行 ${i}（W${i}）`);
  const page = { ...base, sections: base.sections.map((s) => (s.heading === "落とし穴" ? { ...s, lines: [longLine, ...lines, "あ".repeat(PAGE_LIMITS.theme_tokens + 1)] } : s)) };
  const result = validatePage(page, { writer: "owl", require_integrated: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(codes(result.warnings).sort(), ["over_budget", "section_over_lines"]);
});

test("lineHash: same content same hash, different content different hash, CR ignored", () => {
  const a = "- ★ テストは `pnpm test` で実行する（W900）";
  assert.match(lineHash(a), /^[0-9a-f]{12}$/u);
  assert.equal(lineHash(a), lineHash(`${a}`));
  assert.equal(lineHash(a), lineHash(`${a}\r`));
  assert.notEqual(lineHash(a), lineHash(`${a} `));
  assert.notEqual(lineHash(a), lineHash(a.replace("★ ", "")));
});

const F4 = "`".repeat(4);
const HISTORY = [
  "---", "id: 01HZZZZZZZZZZZZZZZZZZZZZZH", "type: history", "title: テスト実行 の履歴", "page_id: 01HZZZZZZZZZZZZZZZZZZZZZZA", "created: 2026-10-05", "updated: 2026-10-05", "---",
  "# テスト実行 の履歴", "", "## 退役", "",
  "### 2026-10-05 矛盾 01HZZZZZZZZZZZZZZZZZZZZZZ1", "- 元の欄: 落とし穴", "- 理由: 矛盾", "- 根拠: W900", "- 置き換え先: - ★ テストは `pnpm test:core` で実行する（W900）", "- 直前の行: 3f9a0c12be47", "- 元の行:", `${F4}text`,
  "- テストは `node --test tests/` で直接実行する（W640, W712）", F4, "",
  "### 2026-10-05 参照先なし 01HZZZZZZZZZZZZZZZZZZZZZZ2", "- 元の欄: 手順", "- 理由: 参照先なし", "- 根拠: packages/core/src/old-runner.ts（base: main に無い）", "- 置き換え先: なし", "- 直前の行: （欄の先頭）", "- 元の行:", `${F4}text`,
  "### 実行器", "```sh", "node old-runner.ts", "```", F4, "- 復元: 2026-10-07", "",
  "## 更新履歴", "", "- 2026-09-20 司書: 統合 1（W812）", "- 2026-09-12 PageRouter: 追記 1（W640）", "",
].join("\n");

test("_history: retired entries round-trip with line, section, reason, evidence and date", () => {
  const parsed = parseHistory(HISTORY);
  assert.equal(parsed.entries.length, 2);
  const [first, second] = parsed.entries;
  assert.deepEqual([first.date, first.reason, first.section, first.evidence, first.before, first.restored], ["2026-10-05", "矛盾", "落とし穴", "W900", "3f9a0c12be47", null]);
  assert.deepEqual(first.lines, ["- テストは `node --test tests/` で直接実行する（W640, W712）"]);
  assert.deepEqual(second.lines, ["### 実行器", "```sh", "node old-runner.ts", "```"]);
  assert.equal(second.restored, "2026-10-07");
  assert.equal(second.replaced_by, "なし");
  assert.equal(parsed.updates.length, 2);
  assert.equal(renderHistory(parsed), HISTORY);
});

test("_history: a code example with a ## heading inside the original lines survives the round trip", () => {
  const parsed = parseHistory(HISTORY);
  const lines = ["- 手順", "```md", "## 内部見出し", "本文", "```"];
  const text = renderHistory({ ...parsed, entries: [{ ...parsed.entries[0], lines }] });
  const again = parseHistory(text);
  assert.deepEqual(again.entries[0].lines, lines);
  assert.equal(renderHistory(again), text);
});

test("_history: a reason containing spaces survives the round trip", () => {
  const parsed = parseHistory(HISTORY);
  const text = renderHistory({ ...parsed, entries: [{ ...parsed.entries[0], reason: "参照先が 消滅" }] });
  const again = parseHistory(text);
  assert.equal(again.entries.length, 1);
  assert.equal(again.entries[0].reason, "参照先が 消滅");
  assert.equal(again.entries[0].id, parsed.entries[0].id);
  assert.equal(renderHistory(again), text);
});

const USAGE = "## 使いどころ\n- 日付ライブラリを選ぶとき\n- （未記入）\n\n";
const withUsage = (text) => text.replace("## 関係する Project", `${USAGE}## 関係する Project`);
const owlOpts = { writer: "owl", resolveLink: () => true };

test("clipping: the usage section round-trips, and a clipping without it stays valid", () => {
  const text = withUsage(fixture("clipping"));
  const page = parsePage(text);
  assert.equal(renderPage(page), text);
  assert.deepEqual(page.sections.find((s) => s.heading === "使いどころ").lines, ["- 日付ライブラリを選ぶとき", "- （未記入）"]);
  assert.deepEqual(validatePage(page, owlOpts).errors, []);
  assert.deepEqual(validatePage(parsePage(fixture("clipping")), owlOpts).errors, []);
  const wrong = `${fixture("clipping")}\n${USAGE}`;
  assert.ok(codes(validatePage(parsePage(wrong), owlOpts).errors).includes("section_order"));
});

test("conversation-log: sections survive a round trip and keys are checked", () => {
  const base = fixture("conversation-log");
  const page = parsePage(base);
  assert.deepEqual(page.sections.map((s) => s.heading), ["話したこと", "決まったこと", "学んだこと", "反映先"]);
  const withRaw = `${base}\n## 原文\n\`\`\`\n## 偽\n\`\`\`\n`;
  assert.equal(renderPage(parsePage(withRaw)), withRaw);
  assert.deepEqual(validatePage(parsePage(withRaw), { writer: "owl" }).errors, []);
  for (const [from, to, key] of [["cause: owl", "cause: x", "cause"], ["compaction_index: 3", "compaction_index: 0", "compaction_index"], ["extraction: program", "extraction: no", "extraction"], ["summary_source: provider", "summary_source: no", "summary_source"], ["session_id: 01HZZZZZZZZZZZZZZZZZZZZZZS", "session_id: ", "session_id"]]) {
    const result = validatePage(parsePage(base.replace(from, to)), { writer: "owl" });
    assert.ok(result.errors.some((e) => e.key === key), key);
  }
  const missing = base.replace("## 決まったこと\n- 会話ログは conversations/ に置く\n\n", "");
  assert.ok(codes(validatePage(parsePage(missing), { writer: "owl" }).errors).includes("missing_section"));
});

test("conversation-log and the usage section have no line or size limit: nothing is rejected or warned", () => {
  const long = "あ".repeat(5000);
  const many = Array.from({ length: 300 }, (_, i) => `- 行 ${i} ${long}`).join("\n");
  const log = fixture("conversation-log").replace("- 会話ログは conversations/ に置く", many).replace("- [落とし穴] 圧縮の指示は自動圧縮に効かない", many);
  const result = validatePage(parsePage(log), { writer: "owl" });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(renderPage(parsePage(log)), log);
  const clip = withUsage(fixture("clipping")).replace("- 日付ライブラリを選ぶとき", many);
  const clipResult = validatePage(parsePage(clip), owlOpts);
  assert.deepEqual(clipResult.errors, []);
  assert.ok(!clipResult.warnings.some((w) => w.section === "使いどころ"));
  assert.equal(renderPage(parsePage(clip)), clip);
});
