import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CurationRunStore } from "../../dist/curation-runs.js";
import { openDatabase } from "../../../db/dist/index.js";
import { MemoryIndex } from "../../dist/memory/memory-index.js";
import { IndexBuilder } from "../../dist/memory/index-builder.js";
import { LIBRARIAN_OUTPUT_FILE, LIBRARIAN_RULES, PageLibrarian } from "../../dist/memory/page-librarian.js";
import { DEFAULT_MEMORY_LIBRARIAN_BATCH, MEMORY_LIBRARIAN_MAX_BATCHES_LIMIT, readMemoryLibrarianBatch } from "../../../shared/dist/index.js";
import { bodySha256, emptyThemePage, estimatePageTokens, PAGE_LIMITS, pageSize, parsePage } from "../../dist/memory/page-format.js";
import { newLinesOf } from "../../dist/memory/page-integration.js";
import { itemsOf } from "../../dist/memory/page-operations.js";
import { OTHER_NOTES_TITLE, PageRouter } from "../../dist/memory/page-router.js";

const PID = "01HZZZZZZZZZZZZZZZZZZZZZZP";
const PID2 = "01HZZZZZZZZZZZZZZZZZZZZZZQ";
const NOW = new Date("2026-10-05T03:00:00Z");
const MODEL = { provider: "claude", model: "claude-haiku-4-5-20251001", effort: "low" };
const NEW = "<!-- owl:new 2026-10-03 W9 -->";
const FM = (id, title, { hash = "", pid = PID, status = "active" } = {}) => `---\nid: ${id}\ntype: theme\ntitle: ${title}\nsummary: ${title}の要約\nscope: project\nproject_id: ${pid}\nstatus: ${status}\nintegrated_hash: ${hash}\nintegrated_at: ${hash ? "2026-10-01T00:00:00Z" : ""}\ncreated: 2026-09-20\nupdated: 2026-10-01\n---\n`;
const BODY = (title, { facts = [], pitfalls = [] } = {}) => `# ${title}\n\n## 概要\n${title}の概要。\n\n## 決まりごと\n${facts.length ? facts.join("\n") : "（なし）"}\n\n## 落とし穴\n${pitfalls.length ? pitfalls.join("\n") : "（なし）"}\n\n## 手順\n（なし）\n\n## 関連ページ\n（なし）\n\n## 更新履歴\n- 2026-09-28 W812 新規作成\n`;
const page = (id, title, opts = {}, integrated = false) => {
  const body = BODY(title, opts);
  const meta = { pid: opts.pid ?? PID, status: opts.status ?? "active" };
  return FM(id, title, { ...meta, hash: integrated ? bodySha256(`${FM(id, title, meta)}${body}`) : "" }) + body;
};

const PATH_A = "projects/kotori/テスト.md";
const PATH_B = "projects/kotori/ビルド.md";
const PATH_D = "projects/kotori/古い話.md";
const PATH_E = "projects/kotori/眠り.md";
const PATH_F = "projects/other/別件.md";
const ID = (c) => `01HZZZZZZZZZZZZZZZZZZZZZZ${c}`;

const FIXTURE = () => ({
  [PATH_A]: page(ID("A"), "テスト", {
    facts: ["- 日時は注入する（W1）", "- 日付は注入する（W2）"],
    pitfalls: [`- 新しい落とし穴（W9） ${NEW}`, "- 古い手順は src/old.ts を使う（W5）", "- ビルドへ移す行（W3）", "- 切り出す行（W4）", "- 切り出す行その二（W6）", "- tmp を共有しない（W10）"],
  }),
  [PATH_B]: page(ID("B"), "ビルド", { pitfalls: ["- ビルドの行（W20）"] }, true),
  [PATH_D]: page(ID("D"), "古い話", { pitfalls: ["- 古い話（W30）"] }, true),
  [PATH_E]: page(ID("E"), "眠り", { pitfalls: ["- 眠っている話（W31）"], status: "dormant" }, true),
  [PATH_F]: page(ID("F"), "別件", { pitfalls: ["- tmp を共有しない（W11）"], pid: PID2 }, true),
});

function setup(files, { propose, dormant = [], repo, wrapRouter, options = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "owl-page-librarian-"));
  const vault = join(root, "vault");
  const dataDir = join(root, "data");
  mkdirSync(vault, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(vault, rel)), { recursive: true }); writeFileSync(join(vault, rel), text); }
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const index = new MemoryIndex({ dataDir, storage, watch: false });
  const calls = [];
  const state = { propose };
  const librarian = new PageLibrarian({
    vault: { isAvailable: () => true, activeDir: () => vault, withWrite: (fn) => fn() },
    dataDir,
    index: { refresh: () => index.refreshChanged(), listPages: (query) => index.listPages(query) },
    propose: async (request) => { calls.push(request); return state.propose(request); },
    router: (wrapRouter ?? ((r) => r))(new PageRouter({ knowledgeDir: () => vault, withWrite: (fn) => fn(), now: () => NOW })),
    model: () => MODEL,
    dormantCandidates: async () => dormant.map((path) => ({ path })),
    workExists: (n) => n < 100,
    conversationExists: () => true,
    pathMissing: (_project, path) => (repo ? (existsSync(join(repo, path)) ? "exists" : "missing") : "unavailable"),
    now: () => NOW,
    logger: { warn: () => undefined },
    ...options,
  });
  const read = (rel) => readFileSync(join(vault, rel), "utf8");
  const ref = (path, section, index_ = 0) => ({ page: path, section, h: itemsOf(read(path)).find((s) => s.section === section).items[index_].h });
  return {
    root, vault, dataDir, index, librarian, calls, read, ref, state,
    start: async () => { await index.start(); await index.rebuild("manual"); },
    cleanup: async () => { await index.stop(); rmSync(root, { recursive: true, force: true }); },
  };
}

let runSeq = 0;
const runId = () => `01HRUN${String(++runSeq).padStart(20, "0")}`;
const ok = (operations) => ({ ok: true, output: { operations }, usage: { input_tokens: 10, output_tokens: 10 } });

test("one run does intake, merge, move, retire, dormant, reactivate, link, split and promote_common from operation JSON", async () => {
  const repo = mkdtempSync(join(tmpdir(), "owl-librarian-repo-"));
  const t = setup(FIXTURE(), { dormant: [PATH_D], repo, propose: () => ok([]) });
  try {
    await t.start();
    const r = (path, section, i) => t.ref(path, section, i);
    const proposal = ok([
      { op: "move", item: r(PATH_A, "落とし穴", 0), to: { page: PATH_A, section: "落とし穴" } },
      { op: "merge", items: [r(PATH_A, "決まりごと", 0), r(PATH_A, "決まりごと", 1)], into: { page: PATH_A, section: "決まりごと" }, text: "日時と日付は注入する" },
      { op: "move", item: r(PATH_A, "落とし穴", 2), to: { page: PATH_B, section: "落とし穴" } },
      { op: "retire", item: r(PATH_A, "落とし穴", 1), reason: "missing_path", evidence: { paths: ["src/old.ts"] } },
      { op: "split", page: PATH_A, new_title: "切り出し", new_summary: "切り出しの要約", items: [r(PATH_A, "落とし穴", 3), r(PATH_A, "落とし穴", 4)], relation: "切り出し" },
      { op: "promote_common", items: [r(PATH_A, "落とし穴", 5), r(PATH_F, "落とし穴", 0)], to: { title: "tmp の共有", section: "落とし穴" } },
      { op: "link", from: PATH_B, to: PATH_D, relation: "関連" },
      { op: "dormant", page: PATH_D },
      { op: "reactivate", page: PATH_E },
    ]);
    t.state.propose = (request) => {
      const counts = Object.fromEntries(request.pages.map((p) => [p.path, p.new_lines]));
      assert.equal(counts[PATH_A], 1, JSON.stringify(counts));
      assert.equal(counts[PATH_B], 0);
      assert.deepEqual(newLinesOf(t.read(PATH_A)), [{ section: "落とし穴", text: "- 新しい落とし穴（W9）", work_label: "W9" }]);
      return proposal;
    };
    const report = await t.librarian.run({ run_id: runId(), mode: "nightly" });
    assert.equal(report.error, undefined, JSON.stringify(report));
    assert.deepEqual(report.rejected, [], JSON.stringify(report.rejected));
    assert.equal(report.applied, 9);
    assert.equal(t.calls.length, 1);
    assert.equal(report.llm_calls, 1);

    const a = t.read(PATH_A);
    assert.ok(!a.includes("owl:new"), "the owl:new mark is gone");
    assert.ok(a.includes("- 新しい落とし穴（W9）"), "the intaken line stays");
    assert.ok(a.includes("日時と日付は注入する"));
    assert.ok(!a.includes("src/old.ts"));
    assert.ok(!a.includes("ビルドへ移す行"));
    assert.ok(t.read(PATH_B).includes("ビルドへ移す行（W3）"));
    assert.ok(!a.includes("切り出す行（W4）"));
    assert.ok(readFileSync(join(t.vault, "projects/kotori/切り出し.md"), "utf8").includes("切り出す行（W4）"));
    const common = [...new Set(report.pages.map((p) => p.path))].find((p) => p.startsWith("common/"));
    assert.ok(common && t.read(common).includes("tmp を共有しない"));
    assert.equal(parsePage(t.read(PATH_D)).frontmatter.status, "dormant");
    assert.equal(parsePage(t.read(PATH_E)).frontmatter.status, "active");
    assert.ok(t.read(PATH_B).includes("[[古い話]]"));
    // every theme page without a new line is stamped, so nothing is pending afterwards
    assert.equal(parsePage(a).frontmatter.integrated_hash, bodySha256(a));
    assert.equal(report.remaining, 0);
    await t.index.refreshChanged();
    assert.equal(t.index.pendingIntegration(10).length, 0);
  } finally { await t.cleanup(); rmSync(repo, { recursive: true, force: true }); }
});

test("the model is asked for operations only: full text is rejected and every page stays as it was", async () => {
  const files = FIXTURE();
  const t = setup(files, { propose: () => ({ ok: true, output: { pages: [{ path: PATH_A, title: "テスト", summary: "s", body: "## 概要\n全部書き換え\n" }] } }) });
  try {
    await t.start();
    for (const output of [
      { pages: [{ path: PATH_A, body: "x" }] },
      { operations: [], body: "## 概要\nx" },
      { rewrite: "x", operations: [] },
      "plain text",
    ]) {
      t.state.propose = () => ({ ok: true, output });
      const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
      assert.ok(report.error, JSON.stringify(output));
      assert.deepEqual(report.pages, []);
      for (const [rel, text] of Object.entries(files)) assert.equal(t.read(rel), text);
    }
    assert.equal(t.librarian.integrationFailed().length, 1);
    t.state.propose = () => ok([]);
    await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.equal(t.librarian.integrationFailed().length, 0);
  } finally { await t.cleanup(); }
});

test("a retire for a missing path is applied only when the path is really absent from the repo", async () => {
  const repo = mkdtempSync(join(tmpdir(), "owl-librarian-repo-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  const text = page(ID("A"), "テスト", { pitfalls: ["- 古い手順は src/old.ts を使う（W5）"] }, true);
  const t = setup({ [PATH_A]: text }, { repo, propose: () => ok([]) });
  try {
    await t.start();
    const retire = () => ok([{ op: "retire", item: t.ref(PATH_A, "落とし穴", 0), reason: "missing_path", evidence: { paths: ["src/old.ts"] } }]);
    writeFileSync(join(repo, "src/old.ts"), "export {};\n");
    t.state.propose = retire;
    const exists = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.equal(exists.applied, 0);
    assert.equal(exists.rejected.length, 1);
    assert.equal(t.read(PATH_A), text);

    rmSync(join(repo, "src/old.ts"));
    const gone = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.deepEqual(gone.rejected, []);
    assert.equal(gone.applied, 1);
    assert.ok(!t.read(PATH_A).includes("src/old.ts"));
  } finally { await t.cleanup(); rmSync(repo, { recursive: true, force: true }); }
});

test("confirm drops only the owl:new marks of the named new lines and the run is not a failure", async () => {
  const mark = (s) => `${s} ${NEW}`;
  const text = page(ID("A"), "テスト", { pitfalls: [mark("- 確認する行（W9）"), mark("- 確認しない行（W9）"), "- 古い行（W5）"] }, false);
  const t = setup({ [PATH_A]: text }, { propose: () => ok([]) });
  try {
    await t.start();
    t.state.propose = () => ok([{ op: "confirm", items: [t.ref(PATH_A, "落とし穴", 0)] }]);
    const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.deepEqual(report.rejected, []);
    assert.equal(report.applied, 1);
    assert.notEqual(report.stop_reason, "no_progress");
    assert.notEqual(report.stop_reason, "error");
    assert.ok(report.backup_dir && existsSync(report.backup_dir));
    const after = t.read(PATH_A);
    assert.ok(after.includes("- 確認する行（W9）\n"), "the line stays");
    assert.ok(!after.includes(`確認する行（W9） ${NEW}`), "its mark is gone");
    assert.ok(after.includes(`- 確認しない行（W9） ${NEW}`), "an unnamed new line keeps its mark");

    // A line without a mark is rejected and the page stays as it was.
    const before = t.read(PATH_A);
    t.state.propose = () => ok([{ op: "confirm", items: [t.ref(PATH_A, "落とし穴", 2)] }]);
    const rejected = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.equal(rejected.rejected.length, 1);
    assert.equal(t.read(PATH_A), before);
  } finally { await t.cleanup(); }
});

test("a rejected retire leaves an unintegrated page byte-identical", async () => {
  const repo = mkdtempSync(join(tmpdir(), "owl-librarian-repo-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/old.ts"), "export {};\n");
  const text = page(ID("A"), "テスト", { pitfalls: ["- 古い手順は src/old.ts を使う（W5）"] }, false);
  const t = setup({ [PATH_A]: text }, { repo, propose: () => ok([]) });
  try {
    await t.start();
    t.state.propose = () => ok([{ op: "retire", item: t.ref(PATH_A, "落とし穴", 0), reason: "missing_path", evidence: { paths: ["src/old.ts"] } }]);
    const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.equal(report.rejected.length, 1);
    assert.equal(t.read(PATH_A), text);
  } finally { await t.cleanup(); rmSync(repo, { recursive: true, force: true }); }
});

test("a dormant candidate goes dormant, and a page over the size limit neither fails the run nor loses lines", async () => {
  const many = Array.from({ length: 400 }, (_, i) => `- ${"長い決まりごとの文章です。".repeat(8)}その${i}（W${i % 90}）`);
  const big = page(ID("A"), "巨大", { facts: many }, false);
  const files = { [PATH_A]: big, [PATH_D]: page(ID("D"), "古い話", { pitfalls: ["- 古い話（W30）"] }, true) };
  const t = setup(files, { dormant: [PATH_D], propose: () => ok([]) });
  try {
    await t.start();
    t.state.propose = () => ok([{ op: "dormant", page: PATH_D }]);
    const report = await t.librarian.run({ run_id: runId(), mode: "nightly" });
    assert.equal(report.error, undefined, JSON.stringify(report));
    assert.equal(report.applied, 1);
    assert.equal(parsePage(t.read(PATH_D)).frontmatter.status, "dormant");
    const kept = t.read(PATH_A).split("\n").filter((l) => l.startsWith("- 長い決まりごと")).length;
    assert.equal(kept, 400);
    assert.equal(t.calls[0].dormant_candidates.includes(PATH_D), true);
  } finally { await t.cleanup(); }
});

test("dormant is rejected for a page that is not a candidate", async () => {
  const files = FIXTURE();
  const t = setup(files, { dormant: [], propose: () => ok([]) });
  try {
    await t.start();
    t.state.propose = () => ok([{ op: "dormant", page: PATH_B }]);
    const report = await t.librarian.run({ run_id: runId(), mode: "nightly" });
    assert.equal(report.rejected.length, 1);
    assert.equal(parsePage(t.read(PATH_B)).frontmatter.status, "active");
  } finally { await t.cleanup(); }
});

test("a model failure is recorded, nothing is written, and three in a row surface in health", async () => {
  const files = FIXTURE();
  const t = setup(files, { propose: () => ({ ok: false, error: "model_unavailable" }) });
  try {
    await t.start();
    for (let i = 0; i < 3; i += 1) {
      const report = await t.librarian.run({ run_id: runId(), mode: "nightly" });
      assert.equal(report.error, "model_unavailable");
    }
    assert.equal(t.librarian.integrationFailed().length, 1);
    for (const [rel, text] of Object.entries(files)) assert.equal(t.read(rel), text);
  } finally { await t.cleanup(); }
});

const CONV = "conversations/2026-10/2026-10-05-1.md";
const CLIP = "clippings/oauth.md";
const conversation = (extraction = "pending") => `---\nid: ${ID("C")}\ntype: conversation-log\ntitle: 会話 2026-10-05-1\nconversation_id: c1\nsession_id: s1\ncompaction_index: 1\nprovider: claude\nmodel: m\ncause: auto\nsummary_source: provider\nextraction: ${extraction}\nproject_id: ${PID}\ncreated: 2026-10-05\n---\n# 会話 2026-10-05-1\n\n## 話したこと\n- （司書待ち）\n\n## 決まったこと\n- （司書待ち）\n\n## 学んだこと\n- （司書待ち）\n\n## 反映先\n- （司書待ち）\n\n## 原文\n- 認証は PKCE を使うと決めた。tmp は共有しないと分かった。\n`;
const clipping = (usage) => `---\nid: ${ID("K")}\ntype: clipping\ntitle: 認証フローの種類\nsource_url: https://example.com/oauth\nretrieved_at: 2026-10-03T05:00:00Z\nretrieved_by: research-recorder\nproject_ids: [${PID}]\nsummary: OAuth の認証フローの違い。\ntags: [x]\ncreated: 2026-10-03\n---\n# 認証フローの種類\n\n## 出典\n- URL: https://example.com/oauth\n- 取得: 2026-10-03（research-recorder、W812）\n\n## 要点\n- 認証コードフローは PKCE と組み合わせる\n\n${usage}## 関係する Project\n- [[projects/kotori/_index|ことり家計簿 の目次]] — 参考\n`;
const EXTRA = () => ({ ...FIXTURE(), [CONV]: conversation(), [CLIP]: clipping("") });
const allThemes = (t) => { const walk = (d) => readdirSync(join(t.vault, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])); return ["projects", "common"].filter((d) => existsSync(join(t.vault, d))).flatMap(walk).map((p) => t.read(p)); };

test("a pending conversation log is read by the librarian: decisions and learnings are appended with owl:new and the log is marked done", async () => {
  const t = setup(EXTRA(), { propose: () => ok([]) });
  try {
    await t.start();
    const h = bodySha256(t.read(CONV));
    t.state.propose = (request) => {
      assert.deepEqual(request.conversations.map((c) => c.path), [CONV]);
      return ok([{ op: "take_conversation", conversation: CONV, h, items: [{ kind: "decision", text: "認証は PKCE を使う" }, { kind: "pitfall", text: "tmp を共有しない" }] }]);
    };
    const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.deepEqual(report.rejected, [], JSON.stringify(report));
    assert.equal(report.applied, 1);
    const pages = allThemes(t);
    assert.equal(pages.filter((x) => x.includes("認証は PKCE を使う") && x.includes("<!-- owl:new 2026-10-05 会話2026-10-05-1 -->")).length, 1);
    assert.ok(pages.some((x) => x.includes("tmp を共有しない（会話2026-10-05-1）") && x.includes("owl:new")));
    assert.equal(parsePage(t.read(CONV)).frontmatter.extraction, "librarian");
    assert.equal(t.read(CONV).replace("extraction: librarian", "extraction: pending"), conversation());
  } finally { await t.cleanup(); }
});

test("a usage line is written into a clipping and every other line stays byte for byte", async () => {
  for (const usage of ["", "## 使いどころ\n（なし）\n\n"]) {
    const before = clipping(usage);
    const t = setup({ ...EXTRA(), [CLIP]: before }, { propose: () => ok([]) });
    try {
      await t.start();
      t.state.propose = (request) => {
        assert.deepEqual(request.clippings.map((c) => c.path), [CLIP]);
        return ok([{ op: "set_usage", clipping: CLIP, h: bodySha256(before), text: "サインイン方式を選ぶとき" }]);
      };
      const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
      assert.deepEqual(report.rejected, [], JSON.stringify(report));
      const after = t.read(CLIP);
      const expected = usage ? before.replace("（なし）\n", "- サインイン方式を選ぶとき\n") : before.replace("## 関係する Project", "## 使いどころ\n- サインイン方式を選ぶとき\n\n## 関係する Project");
      assert.notEqual(expected, before);
      assert.equal(bodySha256(after), bodySha256(expected));
      assert.equal(after, expected);
      assert.deepEqual(itemsOf(after).find((s) => s.section === "使いどころ").items.map((i) => i.text), ["- サインイン方式を選ぶとき"]);
    } finally { await t.cleanup(); }
  }
});

test("operations for a missing conversation or clipping, or with a wrong hash, change nothing", async () => {
  const t = setup(EXTRA(), { propose: () => ok([]) });
  try {
    await t.start();
    const files = Object.keys(EXTRA());
    const snapshot = () => files.map((f) => t.read(f)).join("\0");
    const before = snapshot();
    const items = [{ kind: "fact", text: "x" }];
    t.state.propose = () => ok([
      { op: "take_conversation", conversation: "conversations/2026-10/none.md", h: "0", items },
      { op: "take_conversation", conversation: CONV, h: "0".repeat(64), items },
      { op: "set_usage", clipping: "clippings/none.md", h: "0", text: "x" },
      { op: "set_usage", clipping: CLIP, h: "0".repeat(64), text: "x" },
      { op: "set_usage", clipping: PATH_A, h: bodySha256(t.read(PATH_A)), text: "x" },
    ]);
    const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.deepEqual(report.rejected.map((r) => r.code), ["unknown_page", "hash_mismatch", "unknown_page", "hash_mismatch", "unknown_page"]);
    assert.equal(report.applied, 0);
    assert.equal(snapshot(), before);
  } finally { await t.cleanup(); }
});

test("a vault without theme pages still takes conversations and fills usage lines", async () => {
  const t = setup({ [CONV]: conversation(), [CLIP]: clipping("") }, { propose: () => ok([]) });
  try {
    await t.start();
    t.state.propose = () => ok([{ op: "set_usage", clipping: CLIP, h: bodySha256(t.read(CLIP)), text: "サインイン方式を選ぶとき" }]);
    const report = await t.librarian.run({ run_id: runId(), mode: "nightly" });
    assert.equal(report.llm_calls, 1);
    assert.equal(report.applied, 1);
  } finally { await t.cleanup(); }
});

test("a path outside the requested pages, even one leaving the vault, is rejected and no file is written", async () => {
  const t = setup(EXTRA(), { propose: () => ok([]) });
  try {
    await t.start();
    const outside = join(t.vault, "..", "outside.md");
    writeFileSync(outside, clipping(""));
    t.state.propose = () => ok([{ op: "set_usage", clipping: "../outside.md", h: bodySha256(clipping("")), text: "x" }]);
    const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.deepEqual(report.rejected.map((r) => r.code), ["unknown_page"]);
    assert.equal(readFileSync(outside, "utf8"), clipping(""));
  } finally { await t.cleanup(); }
});

test("a conversation stays pending when the router does not append", async () => {
  const t = setup(EXTRA(), { propose: () => ok([]), wrapRouter: () => ({ route: async () => ({ status: "deferred", reason: "storage_unavailable" }) }) });
  try {
    await t.start();
    t.state.propose = () => ok([{ op: "take_conversation", conversation: CONV, h: bodySha256(t.read(CONV)), items: [{ kind: "fact", text: "x" }] }]);
    const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.equal(report.applied, 0);
    assert.equal(report.rejected[0].code, "route_failed:storage_unavailable");
    assert.equal(t.read(CONV), conversation());
  } finally { await t.cleanup(); }
});

test("a conversation edited while its lines are routed is rejected and the theme pages are restored", async () => {
  let vaultDir = null;
  const wrapRouter = (r) => ({ route: async (input) => { const out = await r.route(input); writeFileSync(join(vaultDir, CONV), `${conversation()}- 追記\n`); return out; } });
  const t = setup(EXTRA(), { propose: () => ok([]), wrapRouter });
  vaultDir = t.vault;
  try {
    await t.start();
    const fixtureThemes = () => Object.keys(FIXTURE()).map((f) => t.read(f)).join("\0");
    const themes = fixtureThemes();
    t.state.propose = () => ok([{ op: "take_conversation", conversation: CONV, h: bodySha256(t.read(CONV)), items: [{ kind: "fact", text: "新しい事実" }] }]);
    const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.equal(report.applied, 0);
    assert.equal(report.rejected[0].code, "hash_mismatch");
    // the re-check just before the write also reports the page, the field and both hash prefixes
    const d = report.rejected[0].detail;
    assert.deepEqual([d.page, d.section, d.h_given, d.h_checked], [CONV, "extraction", bodySha256(conversation()).slice(0, 8), bodySha256(t.read(CONV)).slice(0, 8)]);
    assert.ok(!JSON.stringify(d).includes("追記"));
    assert.equal(fixtureThemes(), themes);
  } finally { await t.cleanup(); }
});

test("a clipping directory swapped for a symlink out of the vault is refused and the outside file is unchanged", async () => {
  const t = setup(EXTRA(), { propose: () => ok([]) });
  try {
    await t.start();
    const outsideDir = join(t.vault, "..", "outside-clippings");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "oauth.md"), clipping(""));
    t.state.propose = () => {
      rmSync(join(t.vault, "clippings"), { recursive: true });
      symlinkSync(outsideDir, join(t.vault, "clippings"));
      return ok([{ op: "set_usage", clipping: CLIP, h: bodySha256(clipping("")), text: "x" }]);
    };
    const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.equal(report.applied, 0);
    assert.equal(report.rejected[0].code, "unknown_page");
    assert.equal(readFileSync(join(outsideDir, "oauth.md"), "utf8"), clipping(""));
  } finally { await t.cleanup(); }
});

test("a rejected second conversation keeps the theme page the first one created and its processed mark", async () => {
  const CONV2 = "conversations/2026-10/2026-10-05-2.md";
  const conv2 = conversation().replace("2026-10-05-1", "2026-10-05-2").replace(ID("C"), ID("D"));
  let vaultDir = null;
  let calls = 0;
  const wrapRouter = (r) => ({ route: async (input) => { const out = await r.route(input); if (++calls === 2) writeFileSync(join(vaultDir, CONV2), `${conv2}- 追記\n`); return out; } });
  const t = setup({ [CONV]: conversation(), [CONV2]: conv2 }, { propose: () => ok([]), wrapRouter });
  vaultDir = t.vault;
  try {
    await t.start();
    t.state.propose = () => ok([
      { op: "take_conversation", conversation: CONV, h: bodySha256(t.read(CONV)), items: [{ kind: "fact", text: "一件目の事実" }] },
      { op: "take_conversation", conversation: CONV2, h: bodySha256(conv2), items: [{ kind: "fact", text: "二件目の事実" }] },
    ]);
    const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.equal(report.applied, 1, JSON.stringify(report));
    assert.equal(report.rejected[0].code, "hash_mismatch");
    const themes = allThemes(t).filter((x) => x.includes("type: theme"));
    assert.equal(themes.filter((x) => x.includes("一件目の事実")).length, 1);
    assert.ok(themes.every((x) => !x.includes("二件目の事実")));
    assert.equal(parsePage(t.read(CONV)).frontmatter.extraction, "librarian");
    assert.equal(parsePage(t.read(CONV2)).frontmatter.extraction, "pending");
  } finally { await t.cleanup(); }
});

const BATCH = (max_batches) => () => ({ max_items: 100, max_input_tokens: 1_000_000, max_batches });
const convN = (n) => ({ path: `conversations/2026-10/2026-10-05-${n}.md`, text: conversation().replace("2026-10-05-1", `2026-10-05-${n}`).replace(ID("C"), ID(String(n))) });

test("an output over the output limit is asked again with fewer items instead of being thrown away", async () => {
  const convs = [1, 2, 3, 4].map(convN);
  const files = Object.fromEntries(convs.map((c) => [c.path, c.text]));
  const opsFor = (request) => request.conversations.map((c) => ({ op: "take_conversation", conversation: c.path, h: c.h, items: [{ kind: "fact", text: `事実 ${"あ".repeat(300)}` }] }));
  const limit = estimatePageTokens(JSON.stringify({ operations: opsFor({ conversations: [{ path: convs[0].path, h: "x".repeat(64) }, { path: convs[1].path, h: "x".repeat(64) }] }) })) + 50;
  const t = setup(files, { propose: () => ok([]), options: { limits: { output_tokens: limit } } });
  try {
    await t.start();
    t.state.propose = (request) => ok(opsFor(request));
    const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.equal(report.error, undefined, JSON.stringify(report));
    assert.ok(report.pages.length > 0);
    assert.deepEqual(t.calls.map((c) => c.conversations.length), [4, 2]);
    assert.equal(report.llm_calls, 2);
  } finally { await t.cleanup(); }
});

test("an output over the limit with entries and detailed pages together shrinks to one item in a few calls", async () => {
  const c = convN(1);
  const t = setup({ ...FIXTURE(), [c.path]: c.text }, { propose: () => ok([]), options: { limits: { output_tokens: 5 } } });
  try {
    await t.start();
    t.state.propose = () => ok([{ op: "take_conversation", conversation: c.path, h: "x".repeat(64), items: [{ kind: "fact", text: "あ".repeat(200) }] }]);
    const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.equal(report.error, "output_over_limit");
    assert.ok(t.calls.length <= 4, `${t.calls.length} calls`);
    const last = t.calls.at(-1);
    assert.equal(last.conversations.length + last.pages.filter((p) => p.items !== null).length, 1);
  } finally { await t.cleanup(); }
});

test("an output over the limit with a single item ends with output_over_limit", async () => {
  const c = convN(1);
  const t = setup({ [c.path]: c.text }, { propose: () => ok([]), options: { limits: { output_tokens: 5 } } });
  try {
    await t.start();
    t.state.propose = (request) => ok(request.conversations.map((x) => ({ op: "take_conversation", conversation: x.path, h: x.h, items: [{ kind: "fact", text: "あ".repeat(200) }] })));
    const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.equal(report.error, "output_over_limit");
    assert.equal(report.pages.length, 0);
  } finally { await t.cleanup(); }
});

test("nightly keeps going while lines remain on theme pages even when no conversation is pending", async () => {
  const c = convN(1);
  const t = setup({ ...FIXTURE(), [c.path]: c.text }, { propose: () => ok([]), options: { batch: BATCH(3) } });
  try {
    await t.start();
    t.state.propose = (request) => (request.conversations.length > 0
      ? ok(request.conversations.map((x) => ({ op: "take_conversation", conversation: x.path, h: x.h, items: [{ kind: "fact", text: "一件目の事実" }] })))
      : ok(t.read(PATH_A).includes("owl:new") ? [{ op: "move", item: t.ref(PATH_A, "落とし穴", 0), to: { page: PATH_A, section: "落とし穴" } }] : []));
    assert.ok(t.read(PATH_A).includes("owl:new"));
    const report = await t.librarian.run({ run_id: runId(), mode: "nightly" });
    assert.deepEqual(report.rejected, [], JSON.stringify(report));
    assert.ok(t.calls.length >= 2, "a later batch runs for the remaining new lines");
    assert.ok(!t.read(PATH_A).includes("owl:new"), "the later batch settled the remaining line");
    assert.ok(report.applied >= 2, JSON.stringify(report));
  } finally { await t.cleanup(); }
});

test("nightly stops when a batch is all rejected and the item is an input of the next run", async () => {
  const c = convN(1);
  const t = setup({ [c.path]: c.text }, { propose: () => ok([]), options: { batch: BATCH(3) } });
  try {
    await t.start();
    t.state.propose = (request) => ok(request.conversations.map((x) => ({ op: "take_conversation", conversation: x.path, h: "0".repeat(64), items: [{ kind: "fact", text: "事実" }] })));
    const report = await t.librarian.run({ run_id: runId(), mode: "nightly" });
    assert.equal(report.applied, 0);
    assert.equal(report.rejected.length, 1);
    assert.equal(t.calls.length, 1);
    await t.librarian.run({ run_id: runId(), mode: "nightly" });
    assert.equal(t.calls.at(-1).conversations.length, 1);
  } finally { await t.cleanup(); }
});

/** Saves the report as curation_runs.report_json and reads it back by run id. */
async function stored(report) {
  const root = mkdtempSync(join(tmpdir(), "owl-librarian-runs-"));
  const db = openDatabase(join(root, "owl.db"));
  try {
    db.migrate(fileURLToPath(new URL("../../../db/migrations", import.meta.url)));
    const runs = new CurationRunStore(db);
    const run = await runs.start({ kind: "librarian", trigger: "manual_api", actor: "system" });
    await runs.finish(run.id, { summary: "", counts: {}, report });
    return runs.get(run.id).report;
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}

test("a rejected operation is reported with its op name and top-level keys, never its values", async () => {
  const SECRET = "SECRET-CANARY-sk-0123456789";
  const t = setup({ [PATH_A]: page(ID("A"), "テスト", {}, false) }, { propose: () => ok([]) });
  try {
    await t.start();
    t.state.propose = () => ok([
      { op: "merge_items", items: [], into: "x", text: SECRET },
      { op: 42, text: SECRET },
      "bare-string-op",
      { op: "x".repeat(500), ...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, SECRET])) },
    ]);
    const report = await stored(await t.librarian.run({ run_id: runId(), mode: "manual" }));
    const [a, b, c, d] = report.rejected;
    assert.deepEqual([a.op, a.keys], ["merge_items", ["op", "items", "into", "text"]]);
    assert.deepEqual([b.op, b.op_type, b.keys], [undefined, "number", ["op", "text"]]);
    assert.deepEqual([c.shape, c.keys], ["string", undefined]);
    assert.ok(d.op.length <= 64 && d.keys.length <= 20);
    assert.ok(!JSON.stringify(report).includes(SECRET));
  } finally { await t.cleanup(); }
});

test("a rejected take_conversation operation is reported by shape too", async () => {
  const SECRET = "SECRET-CANARY-extra";
  const t = setup(EXTRA(), { propose: () => ok([]) });
  try {
    await t.start();
    t.state.propose = () => ok([{ op: "take_conversation", conversation: CONV, h: "bad", items: [{ kind: "fact", text: SECRET }] }]);
    const report = await stored(await t.librarian.run({ run_id: runId(), mode: "manual" }));
    assert.equal(report.rejected[0].op, "take_conversation");
    assert.deepEqual(report.rejected[0].keys, ["op", "conversation", "h", "items"]);
    assert.ok(!JSON.stringify(report).includes(SECRET));
  } finally { await t.cleanup(); }
});

test("a model that wraps operations as {\"retire\":{…}} unless told otherwise is told to use flat {op:…} objects, and its operations then apply (the real model was rejected as unknown_op)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "owl-librarian-repo-"));
  const t = setup({ [PATH_A]: page(ID("A"), "テスト", { pitfalls: ["- 古い手順は src/old.ts を使う（W5）"] }, true) }, { repo, propose: () => ok([]) });
  try {
    await t.start();
    // The stub follows the instructions it is given, as the real model did: wrapped by name unless LIBRARIAN_RULES says flat.
    t.state.propose = () => {
      const body = { item: t.ref(PATH_A, "落とし穴", 0), reason: "missing_path", evidence: { paths: ["src/old.ts"] } };
      return ok([/Never wrap it as/u.test(LIBRARIAN_RULES) ? { op: "retire", ...body } : { retire: body }]);
    };
    const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.deepEqual(report.rejected, []);
    assert.equal(report.applied, 1);
  } finally { await t.cleanup(); rmSync(repo, { recursive: true, force: true }); }
});

test("take_conversation and set_usage give the same result flat and wrapped, and unsettled shapes keep their rejection codes", async () => {
  const runWith = async (build) => {
    const t = setup(EXTRA(), { propose: () => ok([]) });
    try {
      await t.start();
      const hs = { conv: bodySha256(t.read(CONV)), clip: bodySha256(t.read(CLIP)) };
      t.state.propose = () => ok(build(hs));
      const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
      return { applied: report.applied, rejected: report.rejected.map((r) => r.code), conv: t.read(CONV), clip: t.read(CLIP), pages: allThemes(t).map((x) => x.replace(/^id: .*$/gmu, "")) };
    } finally { await t.cleanup(); }
  };
  const take = (h) => ({ conversation: CONV, h: h.conv, items: [{ kind: "decision", text: "認証は PKCE を使う" }] });
  const usage = (h) => ({ clipping: CLIP, h: h.clip, text: "サインイン方式を選ぶとき" });
  const flatTake = await runWith((h) => [{ op: "take_conversation", ...take(h) }]);
  const flatUsage = await runWith((h) => [{ op: "set_usage", ...usage(h) }]);
  assert.deepEqual([flatTake.applied, flatTake.rejected], [1, []]);
  assert.deepEqual([flatUsage.applied, flatUsage.rejected], [1, []]);
  assert.equal(parsePage(flatTake.conv).frontmatter.extraction, "librarian");
  assert.ok(flatUsage.clip.includes("- サインイン方式を選ぶとき"));
  assert.deepEqual(await runWith((h) => [{ take_conversation: take(h) }]), flatTake);
  assert.deepEqual(await runWith((h) => [{ op: "take_conversation", take_conversation: take(h) }]), flatTake);
  assert.deepEqual(await runWith((h) => [{ op: " TAKE_CONVERSATION ", ...take(h) }]), flatTake);
  assert.deepEqual(await runWith((h) => [{ set_usage: usage(h) }]), flatUsage);
  assert.deepEqual(await runWith((h) => [{ op: "set_usage", set_usage: usage(h) }]), flatUsage);
  assert.deepEqual(await runWith((h) => [{ op: " SET_USAGE ", ...usage(h) }]), flatUsage);

  const untouched = await runWith(() => []);
  const rejects = [
    ["missing_field", (h) => ({ op: "set_usage", set_usage: usage(h), take_conversation: {} })], // op names it, but its fields are not at the top level
    ["unknown_op", (h) => ({ set_usage: { op: "take_conversation", ...usage(h) } })], // inner op disagrees
    ["unknown_op", (h) => ({ nonsense: usage(h) })],
    ["missing_field", (h) => ({ set_usage: { ...usage(h), extra: 1 } })], // extra key
    ["missing_field", (h) => ({ op: "set_usage", ...usage(h), extra: 1 })],
    ["missing_field", (h) => ({ set_usage: { clipping: CLIP, h: h.clip } })], // required field missing
    ["missing_field", (h) => ({ op: "take_conversation", conversation: CONV, h: h.conv })],
    ["hash_mismatch", (h) => ({ set_usage: { ...usage(h), h: "0".repeat(64) } })],
  ];
  for (const [code, build] of rejects) {
    const r = await runWith((h) => [build(h)]);
    assert.deepEqual([r.applied, r.rejected, r.clip, r.conv], [0, [code], untouched.clip, untouched.conv], `${code} ${build}`);
  }
});

test("the librarian rules spell out the field types of every operation the program checks", () => {
  const rules = Array.isArray(LIBRARIAN_RULES) ? LIBRARIAN_RULES.join("\n") : String(LIBRARIAN_RULES);
  assert.match(rules, /Field types:/);
  assert.match(rules, /link `from`\/`to` and the `page` of dormant\/reactivate are page paths as plain strings/);
  assert.match(rules, /`evidence\.kept` and every element of `items` are line references/);
  assert.match(rules, /merge needs at least 2 items/);
  assert.match(rules, /evidence \{kept:\{page,section,h\}\}/);
  assert.doesNotMatch(rules, /`into`\/`to` are \{page,section\}/);
});

test("the librarian rules forbid numbered continuation pages for the other-notes page and send lines to theme pages, once", () => {
  const rules = Array.isArray(LIBRARIAN_RULES) ? LIBRARIAN_RULES.join("\n") : String(LIBRARIAN_RULES);
  const rule = `title ${OTHER_NOTES_TITLE})`;
  assert.equal(rules.split(rule).length - 1, 1);
  assert.match(rules, /never create or fill a numbered continuation page/);
  assert.match(rules, /move each line to a page named for its theme, new or listed/);
});

test("a rejected extra operation reports field names and hash prefixes, never page text", async () => {
  const t = setup(EXTRA(), { propose: () => ok([]) });
  try {
    await t.start();
    const h = bodySha256(t.read(CLIP));
    const usage = { op: "set_usage", clipping: CLIP, h, text: "サインイン方式を選ぶとき" };
    t.state.propose = () => ok([usage, { ...usage }, { ...usage, h: "f".repeat(64) }, { op: "set_usage", clipping: CLIP, h, extra: 1 }]);
    const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
    const byIndex = (i) => report.rejected.find((r) => r.index === i);
    assert.equal(report.applied, 1);
    // the second operation shows a hash the first one already made stale
    assert.deepEqual(byIndex(1).detail, { page: CLIP, section: "使いどころ", h_given: h.slice(0, 8), h_given_length: 64, h_checked: bodySha256(t.read(CLIP)).slice(0, 8), changed_earlier: true });
    assert.equal(byIndex(2).detail.h_given, "ffffffff");
    assert.deepEqual(byIndex(3).detail, { missing: ["text"], unknown: ["extra"] });
    const dump = JSON.stringify(report.rejected);
    for (const secret of ["サインイン", "PKCE", "認証コードフロー"]) assert.ok(!dump.includes(secret));
  } finally { await t.cleanup(); }
});

const routed = (theme, over = {}) => ({ kind: "pitfall", text: `${theme || "無題"}の落とし穴`, theme, project_id: PID, source: { work_number: 7, work_id: null, actor: "manager" }, ...over });
const themeTitles = (t, folder) => readdirSync(join(t.vault, folder)).filter((f) => f.endsWith(".md") && f !== "_index.md").sort();
const linesOf = (text) => Object.fromEntries(parsePage(text).sections.map((s) => [s.heading, s.lines]));

test("PageRouter: an unknown theme gets a new theme page in its scope and appears in the rebuilt index", async () => {
  const t = setup({});
  try {
    await t.start();
    const router = new PageRouter({ knowledgeDir: () => t.vault, withWrite: (fn) => fn(), now: () => NOW, projectName: () => "kotori" });
    const own = await router.route(routed("新しい話"));
    assert.deepEqual([own.status, own.page], ["appended", "projects/kotori/新しい話.md"]);
    const common = await router.route(routed("共通の新話", { cross_project: true }));
    assert.equal(common.page, "common/共通の新話.md");
    assert.equal(parsePage(t.read(common.page)).frontmatter.scope, "common");
    assert.ok(linesOf(t.read(own.page))["落とし穴"].some((l) => l.includes("新しい話の落とし穴")));
    const written = new Map();
    const builder = new IndexBuilder({
      index: t.index, projects: { get: () => ({ id: PID, name: "kotori" }) },
      writer: { read: async (p) => written.get(p) ?? null, write: async (p, text) => { written.set(p, text); return { path: p, written: true }; } },
    });
    const project = await builder.rebuild({ kind: "project", project_id: PID });
    assert.ok(linesOf(project.text)["テーマ"].some((l) => l.includes("[[新しい話")));
    const shared = await builder.rebuild({ kind: "common" });
    assert.ok(linesOf(shared.text)["テーマ"].some((l) => l.includes("[[共通の新話")));
  } finally { await t.cleanup(); }
});

test("PageRouter: spelling variants of an existing theme go to that page and create none", async () => {
  const t = setup({});
  try {
    const router = new PageRouter({ knowledgeDir: () => t.vault, withWrite: (fn) => fn(), now: () => NOW, projectName: () => "kotori" });
    const first = await router.route(routed("Build Cache"));
    const before = themeTitles(t, "projects/kotori");
    for (const variant of ["build cache", "  BUILD   CACHE ", "Build\tCache", "ＢＵＩＬＤ Ｃａｃｈｅ"]) {
      const out = await router.route(routed(variant, { text: `${variant}の別の落とし穴` }));
      assert.equal(out.page, first.page, variant);
    }
    assert.deepEqual(themeTitles(t, "projects/kotori"), before);
  } finally { await t.cleanup(); }
});

test("PageRouter: an empty theme goes to その他の注意 and creates no theme page", async () => {
  const t = setup({});
  try {
    const router = new PageRouter({ knowledgeDir: () => t.vault, withWrite: (fn) => fn(), now: () => NOW, projectName: () => "kotori" });
    const out = await router.route(routed("  "));
    assert.equal(out.page, "projects/kotori/その他の注意.md");
    assert.deepEqual(themeTitles(t, "projects/kotori"), ["その他の注意.md", "プロジェクトの構成.md"]);
    const unsymbolic = await router.route(routed("///"));
    assert.equal(unsymbolic.page, "projects/kotori/その他の注意.md");
  } finally { await t.cleanup(); }
});

test("PageRouter: a theme with a slash gets a safe file name, keeps its title, and later routes find it", async () => {
  const t = setup({});
  try {
    const router = new PageRouter({ knowledgeDir: () => t.vault, withWrite: (fn) => fn(), now: () => NOW, projectName: () => "kotori" });
    const first = await router.route(routed("CI/CD"));
    assert.match(first.page, /^projects\/kotori\/[^/]+\.md$/u);
    assert.notEqual(first.page, "projects/kotori/その他の注意.md");
    assert.equal(parsePage(t.read(first.page)).title, "CI/CD");
    const again = await router.route(routed("ci/cd", { text: "別の落とし穴" }));
    assert.equal(again.page, first.page);
    const escape = await router.route(routed("../escape"));
    assert.match(escape.page, /^projects\/kotori\/[^/.][^/]*\.md$/u);
  } finally { await t.cleanup(); }
});

const FACTS40 = Array.from({ length: 40 }, (_, i) => `- 決まりごとその${i}：${"あ".repeat(120)}（W${i + 1}）`);
const overLimitPages = (request) => request.pages.filter((p) => p.over_limit);

test("a page over the size limit always has its items in the request, even without new lines and past the item budget", async () => {
  const t = setup({ [PATH_A]: page(ID("A"), "巨大", { facts: FACTS40 }, true), [PATH_B]: page(ID("B"), "ビルド", { pitfalls: ["- ビルドの行（W20）"] }, true) }, { propose: () => ok([]), options: { limits: { input_tokens: 1 } } });
  try {
    await t.start();
    await t.librarian.run({ run_id: runId(), mode: "nightly" });
    const big = t.calls[0].pages.find((p) => p.path === PATH_A);
    assert.equal(big.over_limit, true);
    assert.equal(big.new_lines, 0);
    assert.equal(big.items.find((s) => s.section === "決まりごと").items.length, 40);
    assert.equal(t.calls[0].pages.find((p) => p.path === PATH_B).items, null);
  } finally { await t.cleanup(); }
});

test("a page over the limit is split by line references over repeated calls until every page fits, and no line is lost", async () => {
  const t = setup({ [PATH_A]: page(ID("A"), "巨大", { facts: FACTS40 }, true) }, { propose: () => ok([]), options: { batch: BATCH(DEFAULT_MEMORY_LIBRARIAN_BATCH.max_batches) } });
  try {
    await t.start();
    const linesOf = () => allThemes(t).flatMap((text) => text.split("\n").filter((l) => l.startsWith("- 決まりごとその"))).sort();
    const before = linesOf();
    assert.ok(allThemes(t).every((text) => estimatePageTokens(text) > PAGE_LIMITS.theme_tokens), "the page starts over the token target");
    let n = 0;
    t.state.propose = (request) => ok(overLimitPages(request).map((p) => {
      const items = p.items.find((s) => s.section === "決まりごと").items.slice(0, 10).map((i) => i.ref);
      return { op: "split", page: p.path, new_title: `分冊${++n}`, new_summary: "分けた行", items, relation: "分割元" };
    }));
    const report = await t.librarian.run({ run_id: runId(), mode: "nightly" });
    assert.equal(report.error, undefined, JSON.stringify(report));
    assert.ok(t.calls.length > 1, "the model is called again in the same run");
    for (const text of allThemes(t)) {
      assert.ok(estimatePageTokens(text) <= PAGE_LIMITS.theme_tokens);
      assert.ok(itemsOf(text).find((s) => s.section === "決まりごと").items.length <= LIMIT.決まりごと);
    }
    assert.ok(allThemes(t).length > 1);
    assert.deepEqual(linesOf(), before);
  } finally { await t.cleanup(); }
});

test("set_usage and take_conversation accept the head of the hash as theme lines do, and reject a different head", async () => {
  const t = setup(EXTRA(), { propose: () => ok([]) });
  try {
    await t.start();
    const head = (path) => bodySha256(t.read(path)).slice(0, 12);
    t.state.propose = () => ok([
      { op: "set_usage", clipping: CLIP, h: "0".repeat(12), text: "x" },
      { op: "take_conversation", conversation: CONV, h: "0".repeat(12), items: [{ kind: "fact", text: "x" }] },
      { op: "set_usage", clipping: CLIP, h: head(CLIP), text: "サインイン方式を選ぶとき" },
      { op: "take_conversation", conversation: CONV, h: head(CONV), items: [{ kind: "fact", text: "短い照合の事実" }] },
    ]);
    const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.deepEqual(report.rejected.map((r) => r.code), ["hash_mismatch", "hash_mismatch"]);
    assert.equal(report.applied, 2);
    assert.match(t.read(CLIP), /サインイン方式を選ぶとき/u);
    assert.equal(parsePage(t.read(CONV)).frontmatter.extraction, "librarian");
  } finally { await t.cleanup(); }
});

// ---- continuing by what actually shrank (design 4.2) ----
const SIZE0 = pageSize(emptyThemePage({ id: ID("Z"), title: "x", summary: "x", scope: "project", project_id: PID, today: "2026-10-05" }));
const LIMIT = Object.fromEntries(SIZE0.sections.map((x) => [x.section, x.limit]));
const MAX_BATCHES = DEFAULT_MEMORY_LIBRARIAN_BATCH.max_batches;
const longLines = (prefix, n) => Array.from({ length: n }, (_, i) => `- ${prefix}その${i + 1}：${"あ".repeat(50)}（W${i + 1}）`);
const shortLines = (prefix, n) => Array.from({ length: n }, (_, i) => `- ${prefix}${i + 1}（W${i + 1}）`);
const ownerUpdates = (n) => Array.from({ length: n }, (_, i) => `- 2026-09-${String(i + 1).padStart(2, "0")} Owner: 更新その${i + 1}`);
const themeFile = (id, title, scope, { summary = [], rules = [], pitfalls = [], updates = ["- 2026-09-28 W812 新規作成"], hashed = true }) => {
  const list = (lines) => (lines.length ? lines.join("\n") : "（なし）");
  const body = `# ${title}\n\n## 概要\n${list(summary)}\n\n## 決まりごと\n${list(rules)}\n\n## 落とし穴\n${list(pitfalls)}\n\n## 手順\n（なし）\n\n## 関連ページ\n（なし）\n\n## 更新履歴\n${updates.join("\n")}\n`;
  const head = (hash) => `---\nid: ${id}\ntype: theme\ntitle: ${title}\nsummary: ${title}の要約\nscope: ${scope}\n${scope === "project" ? `project_id: ${PID}\n` : ""}status: active\nintegrated_hash: ${hash}\nintegrated_at: ${hash ? "2026-10-01T00:00:00Z" : ""}\ncreated: 2026-09-20\nupdated: 2026-10-01\n---\n`;
  return head(hashed ? bodySha256(head("") + body) : "") + body;
};
const countLines = (t, wanted) => {
  const all = allThemes(t).flatMap((text) => text.split("\n").map((l) => l.trim()));
  return wanted.map((l) => all.filter((x) => x === l).length);
};
const fileTexts = (t) => allThemes(t).filter((x) => x.includes("type: theme"));
const sectionOf = (text, name) => itemsOf(text).find((x) => x.section === name)?.items ?? [];

test("an incident-sized page shared by title with a common page converges within max_batches: every section and page fits, no line is lost or duplicated, the common page is untouched, and each batch's output is kept", async () => {
  const PROJ = "projects/kotori/その他の注意.md";
  const COMMON = "common/その他の注意.md";
  const summary = longLines("概要", LIMIT.概要 + 14);
  const rules = longLines("決まり", LIMIT.決まりごと + 9);
  const pitfalls = longLines("落とし穴", LIMIT.落とし穴 + 54);
  const updates = ownerUpdates(LIMIT.更新履歴 + 2);
  const projText = themeFile(ID("A"), "その他の注意", "project", { summary, rules, pitfalls, updates });
  const commonText = themeFile(ID("B"), "その他の注意", "common", { summary: ["- 共通の概要（W1）"], rules: ["- 共通の決まり（W2）"], pitfalls: ["- 共通の落とし穴その一（W3）", "- 共通の落とし穴その二（W4）"] });
  const size = pageSize(parsePage(projText));
  assert.ok(size.tokens > PAGE_LIMITS.theme_tokens * 2);
  for (const name of ["概要", "決まりごと", "落とし穴", "更新履歴"]) assert.ok(size.sections.find((x) => x.section === name).lines > LIMIT[name], name);
  const linkCost = estimatePageTokens("- [[その他の注意]] — 分割元\n") + estimatePageTokens("- 2026-10-05 司書: 移動 1\n");
  const secret = "sk-" + "a".repeat(24);
  let seq = 0;
  let batchNo = 0;
  const propose = (request) => {
    batchNo += 1;
    const ops = [];
    const used = new Map();
    for (const p of request.pages.filter((x) => x.over_limit && x.items)) {
      const negative = Object.entries(p.free.lines).filter(([, v]) => v < 0).map(([k]) => k);
      for (const section of negative.length ? negative : p.free.tokens < 0 ? ["落とし穴"] : []) {
        const lines = p.items.find((x) => x.section === section).items;
        const lineCost = estimatePageTokens(JSON.stringify(lines[0].text));
        const want = Math.min(LIMIT[section], lines.length);
        if (batchNo === 1 && section === "決まりごと") {
          const half = want / 2;
          for (const part of [lines.slice(0, half), lines.slice(half, want)]) ops.push({ op: "split", page: p.path, items: part.map((i) => i.ref), relation: "分割元", new_title: "合流先", new_summary: "二回の split の行き先" });
          continue;
        }
        const dest = request.pages.find((d) => d.path !== p.path && d.scope === p.scope && d.project_id === p.project_id && !d.over_limit && d.free && !used.has(d.path) && d.free.lines[section] > 0);
        const fit = dest ? Math.min(want, dest.free.lines[section], Math.floor((dest.free.tokens - 2 * linkCost) / lineCost)) : 0;
        if (dest && fit > 0) {
          used.set(dest.path, true);
          ops.push({ op: "split", page: p.path, items: lines.slice(0, fit).map((i) => i.ref), relation: "分割元", into: dest.path });
        } else {
          ops.push({ op: "split", page: p.path, items: lines.slice(0, want).map((i) => i.ref), relation: "分割元", new_title: `分冊${++seq}`, new_summary: "分けた行" });
        }
      }
    }
    if (batchNo === 1) {
      const foreign = request.pages.find((x) => x.scope === "common").items.find((x) => x.section === "落とし穴").items[0].ref;
      ops.push({ op: "move", item: { page: PROJ, section: "落とし穴", h: foreign.h }, to: { page: PROJ, section: "落とし穴" } });
    }
    return { ok: true, output: { operations: ops, ...(batchNo === 1 ? { note: secret } : {}) }, usage: { input_tokens: 1, output_tokens: 1 } };
  };
  const t = setup({ [PROJ]: projText, [COMMON]: commonText }, { propose, options: { batch: BATCH(MAX_BATCHES) } });
  try {
    await t.start();
    const report = await t.librarian.run({ run_id: runId(), mode: "nightly" });
    assert.equal(report.stop_reason, "done", JSON.stringify(report));
    assert.ok(t.calls.length >= 2 && t.calls.length <= MAX_BATCHES, String(t.calls.length));
    for (const text of fileTexts(t)) {
      const fit = pageSize(parsePage(text));
      assert.ok(fit.tokens <= fit.token_limit, `${fit.tokens} tokens`);
      for (const x of fit.sections) assert.ok(x.lines <= x.limit, `${x.section}: ${x.lines}`);
    }
    assert.deepEqual(countLines(t, [...summary, ...rules, ...pitfalls, ...updates, "- 共通の概要（W1）", "- 共通の決まり（W2）", "- 共通の落とし穴その一（W3）", "- 共通の落とし穴その二（W4）"]).filter((n) => n !== 1), []);
    assert.equal(t.read(COMMON), commonText);
    assert.deepEqual([...new Set(report.rejected.map((r) => r.code))], ["item_in_other_page"]);
    assert.ok(report.rejected.every((r) => r.detail.found_in.includes(COMMON)));
    const joined = fileTexts(t).filter((x) => x.includes("title: 合流先"));
    assert.equal(joined.length, 1);
    assert.deepEqual(sectionOf(joined[0], "決まりごと").map((i) => i.text), rules.slice(0, LIMIT.決まりごと));
    for (const entry of t.calls[0].pages) for (const sec of entry.items ?? []) for (const i of sec.items) assert.equal(i.ref.page, entry.path);
    for (let k = 1; k <= t.calls.length; k++) {
      const file = readFileSync(join(report.backup_dir, `batch-${k}`, LIBRARIAN_OUTPUT_FILE), "utf8");
      assert.ok(Array.isArray(JSON.parse(file).calls[0].output.operations));
      if (k === 1) {
        assert.ok(file.includes("[secret:sk-]") && !file.includes(secret));
        assert.equal(JSON.parse(file).rejected[0].op.op, "move");
      }
    }
  } finally { await t.cleanup(); }
});

const overPage = (pitfalls, extra = {}) => themeFile(ID("A"), "超過", "project", { pitfalls, ...extra });

test("a model that never makes progress stops after one batch with no_progress", async () => {
  const before = overPage(shortLines("落とし穴", LIMIT.落とし穴 + 3));
  const t = setup({ [PATH_A]: before, [PATH_F]: page(ID("F"), "別件", { pitfalls: ["- 別件の行（W11）"], pid: PID2 }, true) }, {
    propose: (request) => ok([{ op: "split", page: PATH_A, items: request.pages.find((p) => p.path === PATH_A).items.find((x) => x.section === "落とし穴").items.slice(0, 3).map((i) => i.ref), relation: "分割元", into: PATH_F }]),
    options: { batch: BATCH(MAX_BATCHES) },
  });
  try {
    await t.start();
    const report = await t.librarian.run({ run_id: runId(), mode: "nightly" });
    assert.equal(report.stop_reason, "no_progress");
    assert.equal(t.calls.length, 1);
    assert.deepEqual(report.rejected.map((r) => r.code), ["scope_mismatch"]);
    assert.equal(t.read(PATH_A), before);
  } finally { await t.cleanup(); }
});

test("while a page stays over a limit, taking new lines in or moving lines into new pages is not progress", async () => {
  const marked = (n) => Array.from({ length: n }, (_, i) => `- 新しい行${i + 1}（W9） ${NEW}`);
  const first = (request, path, pick) => request.pages.find((p) => p.path === path).items.flatMap((x) => x.items).find(pick).ref;
  const isNew = (i) => i.text.includes("owl:new");
  const split = (ref, page, n) => ({ op: "split", page, items: [ref], relation: "分割元", new_title: `新規${n}`, new_summary: "分けた行" });
  const cases = {
    "new lines of a page within its limits go to new pages": {
      files: { [PATH_A]: overPage(shortLines("落とし穴", LIMIT.落とし穴 + 3), { hashed: true }), [PATH_B]: themeFile(ID("B"), "ビルド", "project", { pitfalls: ["- ビルドの行（W20）", ...marked(2)], hashed: false }) },
      propose: (n) => (request) => ok([split(first(request, PATH_B, isNew), PATH_B, ++n.v)]),
    },
    "new lines of the over-limit page lose their mark in the same section": {
      files: { [PATH_A]: overPage([...shortLines("落とし穴", LIMIT.落とし穴 + 1), ...marked(2)], { hashed: false }) },
      propose: () => (request) => { const ref = first(request, PATH_A, isNew); return ok([{ op: "move", item: ref, to: { page: PATH_A, section: "落とし穴" } }]); },
    },
    "unmarked lines of a page within its limits go to new pages": {
      files: { [PATH_A]: overPage(shortLines("落とし穴", LIMIT.落とし穴 + 3)), [PATH_B]: themeFile(ID("B"), "ビルド", "project", { pitfalls: ["- ビルドの行（W20）", "- ビルドの行その二（W21）"] }) },
      propose: (n) => (request) => ok([split(first(request, PATH_B, (i) => i.text.includes("ビルドの行")), PATH_B, ++n.v)]),
    },
  };
  for (const [name, c] of Object.entries(cases)) {
    const t = setup(c.files, { propose: () => ok([]), options: { batch: BATCH(MAX_BATCHES) } });
    try {
      await t.start();
      t.state.propose = c.propose({ v: 0 });
      const report = await t.librarian.run({ run_id: runId(), mode: "nightly" });
      assert.equal(t.calls.length, 1, name);
      assert.equal(report.stop_reason, "no_progress", name);
      assert.deepEqual(report.rejected, [], name);
    } finally { await t.cleanup(); }
  }
  const t = setup({ [PATH_B]: themeFile(ID("B"), "ビルド", "project", { pitfalls: ["- ビルドの行（W20）", ...marked(2)], hashed: false }) }, { propose: () => ok([]), options: { batch: BATCH(MAX_BATCHES) } });
  try {
    await t.start();
    let n = 0;
    t.state.propose = (request) => ok([split(first(request, PATH_B, isNew), PATH_B, ++n)]);
    const report = await t.librarian.run({ run_id: runId(), mode: "nightly" });
    assert.equal(t.calls.length, 2, "with no page over a limit the run continues until no new line is left");
    assert.equal(report.stop_reason, "done");
  } finally { await t.cleanup(); }
});

test("Core moving 更新履歴 lines to _history counts as progress once, so a model that does nothing stops after the second batch", async () => {
  const UPD = "projects/kotori/履歴.md";
  const pitfalls = shortLines("落とし穴", LIMIT.落とし穴 + 3);
  const t = setup({ [PATH_A]: overPage(pitfalls), [UPD]: themeFile(ID("G"), "履歴", "project", { pitfalls: ["- 履歴の行（W1）"], updates: ownerUpdates(LIMIT.更新履歴 + 2) }) }, { propose: () => ok([]), options: { batch: BATCH(MAX_BATCHES) } });
  try {
    await t.start();
    const report = await t.librarian.run({ run_id: runId(), mode: "nightly" });
    assert.equal(t.calls.length, 2, JSON.stringify(report));
    assert.equal(report.stop_reason, "no_progress");
    assert.equal(sectionOf(t.read(UPD), "更新履歴").length, LIMIT.更新履歴);
    assert.ok(t.read("projects/kotori/_history/履歴.md").includes(ownerUpdates(LIMIT.更新履歴 + 2)[LIMIT.更新履歴 + 1]));
    assert.deepEqual(sectionOf(t.read(PATH_A), "落とし穴").map((i) => i.text), pitfalls);
  } finally { await t.cleanup(); }
});

test("a model that keeps making small progress stops at max_batches", async () => {
  const t = setup({ [PATH_A]: overPage(shortLines("落とし穴", LIMIT.落とし穴 + 5)) }, { propose: () => ok([]), options: { batch: BATCH(3) } });
  try {
    await t.start();
    let n = 0;
    t.state.propose = (request) => ok([{ op: "split", page: PATH_A, items: [request.pages.find((p) => p.path === PATH_A).items.find((x) => x.section === "落とし穴").items[0].ref], relation: "分割元", new_title: `一行${++n}`, new_summary: "分けた行" }]);
    const report = await t.librarian.run({ run_id: runId(), mode: "nightly" });
    assert.equal(t.calls.length, 3);
    assert.equal(report.stop_reason, "max_batches");
  } finally { await t.cleanup(); }
});

test("max_batches outside 1..MEMORY_LIBRARIAN_MAX_BATCHES_LIMIT falls back to the default with a warning", () => {
  for (const bad of [0, MEMORY_LIBRARIAN_MAX_BATCHES_LIMIT + 1, "5"]) {
    const warned = [];
    assert.equal(readMemoryLibrarianBatch({ ...DEFAULT_MEMORY_LIBRARIAN_BATCH, max_batches: bad }, (m) => warned.push(m)).max_batches, DEFAULT_MEMORY_LIBRARIAN_BATCH.max_batches);
    assert.equal(warned.length, 1);
  }
  for (const good of [1, MEMORY_LIBRARIAN_MAX_BATCHES_LIMIT]) {
    assert.equal(readMemoryLibrarianBatch({ ...DEFAULT_MEMORY_LIBRARIAN_BATCH, max_batches: good }, () => assert.fail("no warning")).max_batches, good);
  }
});

test("a page path written with 「・」 resolves to the page stored with 「-」 instead of unknown_page", async () => {
  const dashed = "projects/kotori/テスト-検証.md";
  const t = setup({ ...FIXTURE(), [dashed]: page(ID("G"), "テスト・検証", {}, true) }, { propose: () => ok([]) });
  try {
    await t.start();
    t.state.propose = () => ok([{ op: "split", page: PATH_A, into: "projects/kotori/テスト・検証.md", items: [t.ref(PATH_A, "落とし穴", 3)], relation: "切り出し" }]);
    const report = await t.librarian.run({ run_id: runId(), mode: "nightly" });
    assert.deepEqual(report.rejected, []);
    assert.ok(t.read(dashed).includes("切り出す行"));
  } finally { await t.cleanup(); }
});

// ---- destination room, scope and repeated rejections ----
const PATH_COMMON = "common/共通.md";
const commonPage = () => themeFile(ID("M"), "共通", "common", { pitfalls: ["- 共通の行（W40）"] });

test("the request lists, per page, only same-scope same-project destinations with their free room; a common page is never a destination of a project page", async () => {
  const t = setup({ [PATH_A]: page(ID("A"), "巨大", { facts: FACTS40 }, true), [PATH_B]: page(ID("B"), "ビルド", { pitfalls: ["- ビルドの行（W20）"] }, true), [PATH_COMMON]: commonPage(), [PATH_F]: page(ID("F"), "別件", { pid: PID2 }, true) }, { propose: () => ok([]) });
  try {
    await t.start();
    await t.librarian.run({ run_id: runId(), mode: "nightly" });
    const pages = new Map(t.calls[0].pages.map((p) => [p.path, p]));
    assert.deepEqual(pages.get(PATH_A).move_to, [PATH_B]);
    assert.deepEqual(pages.get(PATH_B).move_to, [PATH_A]);
    assert.deepEqual(pages.get(PATH_COMMON).move_to, []);
    assert.equal(pages.get(PATH_B).free.lines.落とし穴, LIMIT.落とし穴 - 1);
    assert.ok(pages.get(PATH_B).free.tokens > 0);
  } finally { await t.cleanup(); }
});

test("a split that sends more lines than the destination has room for is cut to the room, and the other operations of the batch still apply", async () => {
  const t = setup({
    [PATH_A]: page(ID("A"), "元", { facts: longLines("元", 3), pitfalls: ["- 切り出す行（W4）", "- 残す行（W5）"] }, true),
    [PATH_B]: page(ID("B"), "先", { facts: shortLines("先", LIMIT.決まりごと - 1) }, true),
  }, { propose: () => ok([]) });
  try {
    await t.start();
    t.state.propose = () => ok([
      { op: "split", page: PATH_A, into: PATH_B, relation: "分割", items: [0, 1, 2].map((i) => t.ref(PATH_A, "決まりごと", i)) },
      { op: "split", page: PATH_A, new_title: "新ページ", new_summary: "切り出し", relation: "分割", items: [t.ref(PATH_A, "落とし穴", 0)] },
    ]);
    const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.deepEqual(report.rejected, []);
    assert.equal(report.applied, 2);
    assert.equal(itemsOf(t.read(PATH_B)).find((s) => s.section === "決まりごと").items.length, LIMIT.決まりごと);
    assert.ok(allThemes(t).every((text) => itemsOf(text).find((s) => s.section === "決まりごと").items.length <= LIMIT.決まりごと));
    assert.ok(existsSync(join(t.vault, "projects/kotori/新ページ.md")));
  } finally { await t.cleanup(); }
});

test("an operation rejected in one run is handed to the next run's model, even on a new librarian over the same data dir", async () => {
  const files = { [PATH_A]: page(ID("A"), "巨大", { facts: FACTS40 }, true), [PATH_COMMON]: commonPage() };
  const t = setup(files, { propose: () => ok([]) });
  try {
    await t.start();
    const bad = () => ok([{ op: "split", page: PATH_A, into: PATH_COMMON, relation: "分割", items: [t.ref(PATH_A, "決まりごと", 0)] }]);
    t.state.propose = bad;
    const first = await t.librarian.run({ run_id: runId(), mode: "nightly" });
    assert.equal(first.stop_reason, "no_progress");
    assert.equal(first.rejected[0].code, "scope_mismatch");
    assert.deepEqual(t.calls[0].previous_rejections, []);
    const again = setup(files, { propose: bad });
    try {
      writeFileSync(join(again.dataDir, "memory-page-rejections.json"), readFileSync(join(t.dataDir, "memory-page-rejections.json")));
      await again.start();
      await again.librarian.run({ run_id: runId(), mode: "nightly" });
      const [prev] = again.calls[0].previous_rejections;
      assert.deepEqual([prev.code, prev.op, prev.page, prev.into], ["scope_mismatch", "split", PATH_A, PATH_COMMON]);
    } finally { await again.cleanup(); }
  } finally { await t.cleanup(); }
});

test("moves and splits are fitted in order to the room the batch leaves, a dropped one is rejected at its index in the model's ops, and the saved rejections follow those indexes", async () => {
  const t = setup({
    [PATH_A]: page(ID("A"), "元", { facts: longLines("元", 3), pitfalls: ["- 落とし穴の行（W4）"] }, true),
    [PATH_B]: page(ID("B"), "先", { facts: shortLines("先", LIMIT.決まりごと - 1) }, true),
    [PATH_COMMON]: commonPage(),
    [CONV]: conversation(),
  }, { propose: () => ok([]) });
  try {
    await t.start();
    const into = (i) => ({ op: "move", item: t.ref(PATH_A, "決まりごと", i), to: { page: PATH_B, section: "決まりごと" } });
    t.state.propose = () => ok([
      { op: "take_conversation", conversation: CONV, h: "0".repeat(64), items: [{ kind: "fact", text: "x" }] },
      into(0),
      into(1),
      { op: "split", page: PATH_A, into: PATH_B, relation: "分割", items: [t.ref(PATH_A, "決まりごと", 2)] },
      { op: "split", page: PATH_A, into: PATH_COMMON, relation: "分割", items: [t.ref(PATH_A, "落とし穴", 0)] },
    ]);
    const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.deepEqual(report.rejected.map((r) => [r.index, r.code]), [[0, "hash_mismatch"], [2, "target_over_limit"], [3, "target_over_limit"], [4, "scope_mismatch"]]);
    assert.equal(report.applied, 1);
    assert.ok(allThemes(t).every((text) => itemsOf(text).find((s) => s.section === "決まりごと").items.length <= LIMIT.決まりごと));
    const saved = JSON.parse(readFileSync(join(t.dataDir, "memory-page-rejections.json"), "utf8"));
    assert.deepEqual(saved.map((r) => [r.code, r.op]), [["hash_mismatch", "take_conversation"], ["target_over_limit", "move"], ["target_over_limit", "split"], ["scope_mismatch", "split"]]);
    const next = setup({ [PATH_A]: t.read(PATH_A), [PATH_B]: t.read(PATH_B) }, { propose: () => ok([]) });
    try {
      writeFileSync(join(next.dataDir, "memory-page-rejections.json"), readFileSync(join(t.dataDir, "memory-page-rejections.json")));
      await next.start();
      await next.librarian.run({ run_id: runId(), mode: "manual" });
      assert.equal(next.calls[0].previous_rejections.length, 4);
    } finally { await next.cleanup(); }
  } finally { await t.cleanup(); }
});

test("room a move frees on a full page counts for the operations after it, and one that cannot be applied takes none", async () => {
  const t = setup({
    [PATH_A]: page(ID("A"), "元", { facts: shortLines("元", 2) }, true),
    [PATH_B]: page(ID("B"), "先", { facts: shortLines("先", LIMIT.決まりごと) }, true),
    [PATH_COMMON]: commonPage(),
    [CONV]: conversation(),
  }, { propose: () => ok([]) });
  try {
    await t.start();
    const mv = (from, i, to) => ({ op: "move", item: t.ref(from, "決まりごと", i), to: { page: to, section: "決まりごと" } });
    t.state.propose = () => ok([mv(PATH_B, 0, PATH_A), mv(PATH_A, 0, PATH_B), mv(PATH_A, 1, PATH_B)]);
    const report = await t.librarian.run({ run_id: runId(), mode: "manual" });
    assert.deepEqual(report.rejected.map((r) => [r.index, r.code]), [[2, "target_over_limit"]]);
    assert.equal(report.applied, 2);
    assert.ok(allThemes(t).every((text) => itemsOf(text).find((s) => s.section === "決まりごと").items.length <= LIMIT.決まりごと));
  } finally { await t.cleanup(); }
});
