import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { MemoryIndex } from "../../dist/memory/memory-index.js";
import { PageLibrarian } from "../../dist/memory/page-librarian.js";
import { bodySha256, estimatePageTokens, parsePage } from "../../dist/memory/page-format.js";
import { newLinesOf } from "../../dist/memory/page-integration.js";
import { itemsOf } from "../../dist/memory/page-operations.js";
import { PageRouter } from "../../dist/memory/page-router.js";

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
const allThemes = (t) => { const walk = (d) => readdirSync(join(t.vault, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])); return walk("projects").map((p) => t.read(p)); };

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
