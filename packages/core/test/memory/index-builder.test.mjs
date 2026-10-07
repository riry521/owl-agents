import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexBuilder } from "../../dist/memory/index-builder.js";
import { bodySha256, estimatePageTokens, parsePage, validatePage } from "../../dist/memory/page-format.js";

const PID = "01HZZZZZZZZZZZZZZZZZZZZZZP";
const IID = "01HZZZZZZZZZZZZZZZZZZZZZZK";
const NOW = new Date("2026-10-03T02:10:05Z");
const hex = (c) => c.repeat(64);
const section = (s) => (s.startsWith("- ★") ? s : `- ${s}`);

const materials = (over = {}) => ({
  scope: { kind: "project", project_id: PID, project_name: "ことり家計簿" },
  overview: "家計簿の Web アプリ。",
  themes: [], must_read: [], common_themes: [], existing: null, ...over,
});
const theme = (n, over = {}) => ({ title: `テーマ${String(n).padStart(3, "0")}の長めの題名をつけておくあああああああ`, summary: `テーマ${n}の要約をできるだけ長めに書いておく文章です`, updated: `2026-09-${String(10 + (n % 20)).padStart(2, "0")}`, integrated_hash: hex("a"), ...over });
const bodyLines = (text) => parsePage(text).sections.map((s) => [s.heading, s.lines]);

test("compose: 4 sections, must-read order (Owner first, then newest Work), themes newest first", () => {
  const result = IndexBuilder.compose(materials({
    themes: [theme(1, { updated: "2026-09-01" }), theme(2, { updated: "2026-09-30" })],
    must_read: [
      { text: "古い決まり", page: "テーマ001", owner: false, latest_work: 3 },
      { text: "新しい決まり", page: "テーマ001", owner: false, latest_work: 90 },
      { text: "Owner の指示は[[別名]]を守る", page: "テーマ002", owner: true, latest_work: 1 },
    ],
    common_themes: [{ title: "共通A", summary: "共通の要約", integrated_hash: null }],
  }), NOW, IID);
  assert.equal(result.path, "projects/ことり家計簿/_index.md");
  const sections = Object.fromEntries(bodyLines(result.text));
  assert.deepEqual(Object.keys(sections), ["概要", "必読（決まりごと・落とし穴）", "テーマ", "共通テーマ"]);
  assert.deepEqual(sections["必読（決まりごと・落とし穴）"], [
    "- Owner の指示は別名を守る → [[テーマ002]]", "- 新しい決まり → [[テーマ001]]", "- 古い決まり → [[テーマ001]]",
  ]);
  assert.deepEqual(sections["テーマ"].map((l) => l.slice(0, 10)), ["- [[テーマ002", "- [[テーマ001"]);
  assert.deepEqual(sections["共通テーマ"], ["- [[共通A]] — 共通の要約"]);
  assert.ok(result.text.includes("<!-- 自動生成。直すときはテーマページを直す -->\n# ことり家計簿 の目次"));
  assert.equal(result.changed, true);
  assert.deepEqual(result.collapsed, []);
});

test("compose: common index keeps all four sections and fixed overview; deterministic", () => {
  const a = IndexBuilder.compose(materials({ scope: { kind: "common" }, overview: null, themes: [theme(1)] }), NOW, IID);
  const b = IndexBuilder.compose(materials({ scope: { kind: "common" }, overview: null, themes: [theme(1)] }), new Date("2027-01-01T00:00:00Z"), "01HZZZZZZZZZZZZZZZZZZZZZZJ");
  assert.equal(a.path, "common/_index.md");
  assert.equal(a.source_hash, b.source_hash);
  const sections = Object.fromEntries(bodyLines(a.text));
  assert.deepEqual(sections["概要"], ["Project をまたぐ決まりごと"]);
  assert.deepEqual(sections["必読（決まりごと・落とし穴）"], ["（なし）"]);
  assert.deepEqual(sections["共通テーマ"], ["（なし）"]);
  const frontmatter = parsePage(a.text).frontmatter;
  assert.equal(frontmatter.title, "共通の目次");
  assert.equal(frontmatter.scope, "common");
  assert.ok(!("project_id" in frontmatter));
});

test("compose: many themes stay within 1,200 tokens and collapse in the section 7.2 order", () => {
  const many = materials({
    themes: Array.from({ length: 60 }, (_, i) => theme(i)),
    must_read: Array.from({ length: 30 }, (_, i) => ({ text: `決まりごとその${i}を長めの文章で書く。${"あ".repeat(60)}`, page: "テーマ001", owner: false, latest_work: i })),
    common_themes: Array.from({ length: 10 }, (_, i) => ({ title: `共通${i}`, summary: "共通の要約".repeat(5), integrated_hash: null })),
  });
  const result = IndexBuilder.compose(many, NOW, IID);
  assert.ok(result.tokens <= 1200, `tokens ${result.tokens}`);
  assert.equal(result.tokens, estimatePageTokens(result.text.replace(/^---\n[\s\S]*?\n---\n/u, "")));
  assert.deepEqual(result.collapsed, ["summary", "common_themes", "must_read", "themes"]);
  const sections = Object.fromEntries(bodyLines(result.text));
  assert.equal(sections["必読（決まりごと・落とし穴）"].length, 6);
  assert.equal(sections["共通テーマ"].length, 3);
  assert.ok(sections["テーマ"].length <= 16);
  const rest = Number(/^- ほか (\d+) テーマ（index で全件）$/u.exec(sections["テーマ"].at(-1))[1]);
  assert.equal(rest + sections["テーマ"].length - 1, 60);
  assert.ok(sections["テーマ"][0].split(" — ")[1].length <= 25);

  // Fewer themes: only the first steps are needed.
  const mild = IndexBuilder.compose(materials({ themes: Array.from({ length: 20 }, (_, i) => theme(i)), common_themes: many.common_themes }), NOW, IID);
  assert.ok(mild.tokens <= 1200);
  assert.deepEqual(mild.collapsed, ["summary", "common_themes", "must_read", "themes"].slice(0, mild.collapsed.length));
});

test("compose: output passes validatePage as owner", () => {
  const result = IndexBuilder.compose(materials({ themes: [theme(1)], must_read: [{ text: "決まり", page: "テーマ001", owner: false, latest_work: 1 }] }), NOW, IID);
  const verdict = validatePage(parsePage(result.text), { writer: "owner" });
  assert.deepEqual(verdict.errors, []);
  assert.ok(verdict.ok);
});

test("composeHome: project-index template with links and kept links, deterministic, over-limit gives an error", () => {
  const entries = [
    { title: "共通の目次", path: "common/_index.md" },
    { title: "ことり家計簿 の目次", path: "projects/kotori/_index.md" },
  ];
  const home = IndexBuilder.composeHome(entries, ["[[残すリンク]]"], NOW, IID);
  assert.ok(home.text.includes("- [[common/_index|共通の目次]]"));
  assert.ok(home.text.includes("- [[projects/kotori/_index|ことり家計簿 の目次]]"));
  assert.ok(home.text.includes("- [[残すリンク]]"));
  assert.deepEqual(validatePage(parsePage(home.text), { writer: "owner" }).errors, []);
  assert.equal(parsePage(home.text).frontmatter.type, "project-index");
  assert.deepEqual(home, IndexBuilder.composeHome(entries, ["[[残すリンク]]"], NOW, IID));
  const over = IndexBuilder.composeHome(entries, Array.from({ length: 25 }, (_, i) => `[[リンク${i}]]`), NOW, IID);
  assert.ok("error" in over);
});

/** Fake MemoryIndex over a list of {row, text}; the writer is an in-memory vault the fake index reads back. */
function harness(files) {
  const vault = new Map(Object.entries(files));
  const writes = [];
  const rowOf = (path) => {
    const fm = parsePage(vault.get(path)).frontmatter;
    return {
      path, title: fm.title, summary: fm.summary ?? "", status: fm.status ?? "active", updated: fm.updated ?? null,
      page_type: fm.type, page_scope: fm.scope, project_id: fm.project_id ?? null,
      related_projects: fm.related_projects ?? [], integrated_hash: fm.integrated_hash || null,
      source_hash: fm.source_hash ?? null, body_sha256: bodySha256(vault.get(path)),
    };
  };
  const rows = () => [...vault.keys()].filter((p) => p !== "Home.md").map(rowOf);
  const index = {
    refreshChanged: async () => ({}),
    listPages: (q) => rows().filter((r) => q.types.includes(r.page_type) && (q.status ?? ["active"]).includes(r.status)
      && (!q.scope || r.page_scope === q.scope) && (q.project_id === undefined || r.project_id === q.project_id)
      && (q.related_to_project === undefined || r.related_projects.includes(q.related_to_project))),
    getProjectIndex: (id) => rows().find((r) => r.page_type === "project-index" && (id === null ? r.page_scope === "common" : r.project_id === id)) ?? null,
    readBody: async (row) => ({ body: vault.get(row.path).replace(/^---\n[\s\S]*?\n---\n/u, ""), truncated: false, stale: false }),
  };
  const writer = {
    read: async (path) => vault.get(path) ?? null,
    write: async (path, text, options) => {
      writes.push({ path, options });
      vault.set(path, text);
      return { path, written: true };
    },
  };
  let n = 0;
  const builder = new IndexBuilder({
    index, writer, projects: { get: (id) => (id === PID ? { id, name: "ことり家計簿" } : null) },
    now: () => NOW, newId: () => `01HZZZZZZZZZZZZZZZZZZZZ${String(++n).padStart(3, "0")}`.slice(0, 26),
  });
  return { builder, vault, writes };
}

const themeFile = (title, scope, extra = "", body = "") => `---
id: 01HZZZZZZZZZZZZZZZZZZZZZZT
type: theme
title: ${title}
summary: ${title}の要約
scope: ${scope}
${scope === "project" ? `project_id: ${PID}\n` : ""}status: active
integrated_hash: ${hex("b")}
integrated_at: 2026-10-01T00:00:00Z
created: 2026-09-01
updated: 2026-09-20
${extra}---
# ${title}

## 概要
${title}の概要。

## 決まりごと
${body || "（なし）"}

## 落とし穴
（なし）

## 手順
（なし）

## 関連ページ
（なし）

## 更新履歴
（なし）
`;

const files = () => ({
  "projects/kotori/テストの落とし穴.md": themeFile("テストの落とし穴", "project", "", "- ★ 日時は clock を注入する（出典 W12）\n- ★ Owner の指示: 本番に書かない（出典 W3）\n- ふつうの行"),
  "projects/kotori/プロジェクトの構成.md": themeFile("プロジェクトの構成", "project").replace("プロジェクトの構成の概要。", "TypeScript と SQLite の家計簿。"),
  "common/ブランチ運用.md": themeFile("ブランチ運用", "common", `related_projects: [${PID}]\n`),
  "common/無関係.md": themeFile("無関係", "common", "related_projects: [01HZZZZZZZZZZZZZZZZZZZZZZQ]\n"),
});

test("rebuildAll: writes indexes and Home.md, valid, then writes nothing when source_hash is unchanged", async () => {
  const { builder, vault, writes } = harness(files());
  const results = await builder.rebuildAll();
  assert.deepEqual(results.map((r) => r.path), ["common/_index.md", "projects/ことり家計簿/_index.md", "Home.md"]);
  assert.deepEqual(writes.map((w) => w.path), ["common/_index.md", "projects/ことり家計簿/_index.md", "Home.md"]);
  assert.ok(writes.every((w) => w.options.expected_body_sha256 === null));

  const project = vault.get("projects/ことり家計簿/_index.md");
  const sections = Object.fromEntries(bodyLines(project));
  assert.deepEqual(sections["概要"], ["TypeScript と SQLite の家計簿。"]);
  assert.deepEqual(sections["必読（決まりごと・落とし穴）"], [
    "- Owner の指示: 本番に書かない（出典 W3） → [[テストの落とし穴]]",
    "- 日時は clock を注入する（出典 W12） → [[テストの落とし穴]]",
  ]);
  assert.equal(sections["テーマ"].length, 2);
  assert.deepEqual(sections["共通テーマ"], ["- [[ブランチ運用]] — ブランチ運用の要約"]);
  assert.deepEqual(Object.fromEntries(bodyLines(vault.get("common/_index.md")))["テーマ"].length, 2);
  for (const path of ["common/_index.md", "projects/ことり家計簿/_index.md"]) {
    assert.deepEqual(validatePage(parsePage(vault.get(path)), { writer: "owner" }).errors, [], path);
  }
  const home = vault.get("Home.md");
  assert.deepEqual(validatePage(parsePage(home), { writer: "owner" }).errors, []);
  assert.ok(home.includes("[[common/_index|共通の目次]]") && home.includes("[[projects/ことり家計簿/_index|ことり家計簿 の目次]]"));

  // The indexes now exist in the vault; the fake index sees them and a second run changes nothing.
  writes.length = 0;
  const again = await builder.rebuildAll();
  assert.deepEqual(writes, []);
  assert.deepEqual(again.map((r) => r.changed), [false, false, false]);
});

test("rebuild: reuses id and folder of an existing index, rewrites with expected hash when a theme changes", async () => {
  const { builder, vault, writes } = harness(files());
  await builder.rebuild({ kind: "project", project_id: PID });
  const first = vault.get("projects/ことり家計簿/_index.md");
  // Move the index to another folder, as if the project had been renamed.
  vault.delete("projects/ことり家計簿/_index.md");
  vault.set("projects/kotori/_index.md", first);
  vault.set("projects/kotori/新テーマ.md", themeFile("新テーマ", "project"));
  writes.length = 0;
  const result = await builder.rebuild({ kind: "project", project_id: PID });
  assert.equal(result.changed, true);
  assert.equal(result.path, "projects/kotori/_index.md");
  assert.deepEqual(writes.map((w) => w.path), ["projects/kotori/_index.md"]);
  assert.equal(writes[0].options.expected_body_sha256, bodySha256(first));
  assert.equal(parsePage(vault.get("projects/kotori/_index.md")).frontmatter.id, parsePage(first).frontmatter.id);
  assert.equal(Object.fromEntries(bodyLines(vault.get("projects/kotori/_index.md")))["テーマ"].length, 3);
});

test("compose: links point at the real file name while the title stays the label", () => {
  const result = IndexBuilder.compose(materials({
    themes: [theme(1, { title: "同名テーマ", link: "同名テーマ-2" }), theme(2, { title: "別テーマ", link: "別テーマ" })],
    must_read: [{ text: "決まり", page: "同名テーマ", link: "同名テーマ-2", owner: false, latest_work: 1 }],
  }), NOW, IID);
  const sections = Object.fromEntries(bodyLines(result.text));
  assert.ok(sections["テーマ"].some((l) => l.startsWith("- [[同名テーマ-2|同名テーマ]]")));
  assert.ok(sections["テーマ"].some((l) => l.startsWith("- [[別テーマ]]")));
  assert.deepEqual(sections["必読（決まりごと・落とし穴）"], ["- 決まり → [[同名テーマ-2|同名テーマ]]"]);
});
