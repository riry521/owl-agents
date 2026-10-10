import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { MemoryReadLedger } from "../../dist/memory/memory-read-ledger.js";
import { MemoryService } from "../../dist/memory/memory-service.js";
import { IndexBuilder } from "../../dist/memory/index-builder.js";
import { estimatePageTokens, parsePage } from "../../dist/memory/page-format.js";

const fixture = (kind) => readFileSync(new URL(`./fixtures/pages/${kind}.md`, import.meta.url), "utf8");
const PROJECT = "01HZZZZZZZZZZZZZZZZZZZZZZP";
const ctx = (over = {}) => ({ caller: "worker", agent_run_id: "run-1", work_id: null, task_id: null, project_id: PROJECT, ...over });
/** The fixture theme under another title and id. */
const theme = (title, n) => fixture("theme").replace(/^id: \w{25}\w$/mu, `id: 01HZZZZZZZZZZZZZZZZZZZZZZ${n}`).replaceAll("テストの落とし穴", title);

async function setup({ available = true, extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "owl-service-pages-"));
  const vault = join(root, "vault");
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const write = (rel, text) => { mkdirSync(dirname(join(vault, rel)), { recursive: true }); writeFileSync(join(vault, rel), text); };
  for (const [i, title] of ["第一", "第二", "第三", "第四"].entries()) write(`projects/kotori/${title}.md`, theme(title, String(i + 1)));
  write("projects/kotori/_index.md", fixture("project-index"));
  write("works/2026-10/W815-月末.md", fixture("work-log"));
  write("research/2026-10-01-日付.md", fixture("clipping"));
  write("research/2026-10-02-長い資料.md", fixture("clipping").replace(/^id: \w{25}\w$/mu, "id: 01HZZZZZZZZZZZZZZZZZZZZZZD").replace("バンドルサイズは最大で 10 倍違う", "日付の扱いに関する長い説明。".repeat(400)));
  const storage = {
    isAvailable: () => available, activeDir: () => vault, withRead: async (op) => op(),
    status: () => ({ available, dir: vault, since: null }),
  };
  const service = new MemoryService({
    dataDir, storage, embedder: { enabled: false, health: () => ({}), stop: async () => {} }, indexOptions: { watch: false },
    mode: () => "pages", ...extra,
  });
  await service.start();
  await service.reindex({ mode: "full" });
  return { service, vault, root, cleanup: async () => { await service.stop(); rmSync(root, { recursive: true, force: true }); } };
}

test("a Worker's 4th theme page is refused with an outline; reopening an opened page is free", async () => {
  const t = await setup();
  try {
    for (const title of ["第一", "第二", "第三"]) {
      const out = await t.service.page({ page: title }, ctx());
      assert.equal(out.found, true, title);
    }
    assert.equal((await t.service.page({ page: "第一" }, ctx())).found, true);
    const refused = await t.service.page({ page: "第四" }, ctx());
    assert.equal(refused.error, "page_budget_exceeded");
    assert.ok(refused.outline.some((s) => s.section === "落とし穴" && s.lines > 0));
    assert.equal(refused.budget.pages_limit, 3);
    // Another run starts from zero.
    assert.equal((await t.service.page({ page: "第四" }, ctx({ agent_run_id: "run-2" }))).found, true);
  } finally { await t.cleanup(); }
});

test("narrowing with sections returns what fits in the remaining token budget", async () => {
  const limits = { manager: {}, designer: {}, reviewer: {}, advisor: {}, worker: { pages: 3, page_tokens: 250, searches: 2, clippings: 1 } };
  const t = await setup({ extra: { ledger: new MemoryReadLedger({ limits: () => limits }) } });
  try {
    const whole = await t.service.page({ page: "第一" }, ctx());
    assert.equal(whole.error, "page_budget_exceeded", "the whole page does not fit in 250 tokens");
    const narrowed = await t.service.page({ page: "第一", sections: ["決まりごと", "落とし穴", "手順"] }, ctx());
    assert.equal(narrowed.found, true);
    assert.ok(narrowed.tokens <= 250);
    assert.match(narrowed.text, /## 決まりごと/u);
    assert.equal(narrowed.truncated, true, "the sections that did not fit are left out");
    assert.equal((await t.service.page({ page: "第一", sections: ["存在しない"] }, ctx())).error, "unknown_sections");
  } finally { await t.cleanup(); }
});

test("a narrowed read never returns more than the ledger charged, at any budget boundary", async () => {
  for (let tokens = 10; tokens <= 250; tokens += 7) {
    const limits = { manager: {}, designer: {}, reviewer: {}, advisor: {}, worker: { pages: 3, page_tokens: tokens, searches: 2, clippings: 1 } };
    const t = await setup({ extra: { ledger: new MemoryReadLedger({ limits: () => limits }) } });
    try {
      const out = await t.service.page({ page: "第一", sections: ["決まりごと", "落とし穴", "手順"] }, ctx());
      if (out.error) { assert.equal(out.error, "page_budget_exceeded"); continue; }
      assert.ok(out.tokens <= tokens, `returned ${out.tokens} tokens within ${tokens}`);
      assert.ok(out.budget.tokens_used >= out.tokens && out.budget.tokens_used <= tokens);
    } finally { await t.cleanup(); }
  }
});

test("a miss returns did_you_mean", async () => {
  const t = await setup();
  try {
    const out = await t.service.page({ page: "落とし穴のページ" }, ctx());
    assert.equal(out.found, false);
    assert.ok(Array.isArray(out.did_you_mean));
    assert.ok(out.did_you_mean.length > 0);
  } finally { await t.cleanup(); }
});

test("search covers clippings, adds work logs on request, and stays within 5 items and 800 tokens", async () => {
  const t = await setup();
  try {
    const clippings = await t.service.searchPages({ query: "日付" }, ctx());
    assert.ok(clippings.items.length > 0);
    assert.ok(clippings.items.every((i) => i.path.startsWith("research/")));
    assert.ok(clippings.items.length <= 5);
    assert.ok(estimatePageTokens(JSON.stringify(clippings)) <= 800);
    const withLogs = await t.service.searchPages({ query: "月末", include_work_log: true }, ctx({ agent_run_id: "run-3" }));
    assert.ok(withLogs.items.some((i) => i.path.startsWith("works/")));
    const without = await t.service.searchPages({ query: "月末" }, ctx({ agent_run_id: "run-4" }));
    assert.ok(without.items.every((i) => !i.path.startsWith("works/")));
    // Worker: 2 searches per run.
    await t.service.searchPages({ query: "日付" }, ctx({ agent_run_id: "run-5" }));
    await t.service.searchPages({ query: "日付" }, ctx({ agent_run_id: "run-5" }));
    assert.equal((await t.service.searchPages({ query: "日付" }, ctx({ agent_run_id: "run-5" }))).error, "search_budget_exceeded");
  } finally { await t.cleanup(); }
});

test("opening a clipping or a work log cuts at 1,500 tokens and counts as a clipping", async () => {
  const t = await setup();
  try {
    const long = await t.service.page({ page: "research/2026-10-02-長い資料.md" }, ctx());
    assert.equal(long.found, true, JSON.stringify(long).slice(0, 300));
    assert.equal(long.truncated, true);
    assert.ok(long.tokens <= 1500);
    assert.equal(long.budget.clippings_used, 1);
    // A Worker may open one clipping per run.
    assert.equal((await t.service.page({ page: "第一" }, ctx())).found, true, "themes are counted separately");
    assert.equal((await t.service.page({ page: "research/2026-10-01-日付.md" }, ctx())).error, "clipping_budget_exceeded");
    const log = await t.service.page({ page: "W815-月末.md" }, ctx({ agent_run_id: "run-6" }));
    assert.equal(log.found, true);
    assert.ok(log.tokens <= 1500);
  } finally { await t.cleanup(); }
});

test("index is free, and an Advisor's turn budget resets through the ledger", async () => {
  const ledger = new MemoryReadLedger();
  const t = await setup({ extra: { ledger } });
  try {
    for (let i = 0; i < 5; i += 1) assert.equal((await t.service.readIndex({}, ctx())).found, true);
    const advisor = ctx({ caller: "advisor", agent_run_id: "session-1" });
    await t.service.page({ page: "第一" }, advisor);
    await t.service.page({ page: "第二" }, advisor);
    assert.equal((await t.service.page({ page: "第三" }, advisor)).error, "page_budget_exceeded");
    ledger.reset("advisor:session-1");
    assert.equal((await t.service.page({ page: "第三" }, advisor)).found, true);
  } finally { await t.cleanup(); }
});

test("an unconnected vault answers from the index with stale: true", async () => {
  const t = await setup();
  try {
    const offline = new MemoryService({
      dataDir: join(t.root, "data"), embedder: { enabled: false, health: () => ({}), stop: async () => {} }, indexOptions: { watch: false },
      storage: { isAvailable: () => false, activeDir: () => { throw new Error("unavailable"); }, withRead: async (op) => op(), status: () => ({ available: false, dir: null, since: null }) },
    });
    await offline.start();
    try {
      const out = await offline.page({ page: "第一" }, ctx());
      assert.equal(out.found, true);
      assert.equal(out.stale, true);
      assert.equal((await offline.readIndex({}, ctx())).stale, true);
      assert.equal(offline.mode(), "pages");
    } finally { await offline.stop(); }
  } finally { await t.cleanup(); }
});

test("append puts one 会話 line on the named theme page and creates a listed page when none fits", async () => {
  const { PageRouter } = await import("../../dist/memory/page-router.js");
  const { createHash } = await import("node:crypto");
  const holder = {};
  const router = { route: (input) => holder.router.route(input) };
  const now = () => new Date("2026-10-10T03:00:00Z");
  const rebuildProjectIndex = (project_id) => new IndexBuilder({
    index: holder.t.service.index,
    writer: { read: async (path) => { try { return read(path); } catch { return null; } }, write: async (path, text) => { mkdirSync(dirname(join(holder.t.vault, path)), { recursive: true }); writeFileSync(join(holder.t.vault, path), text); return { path, written: true }; } },
    projects: { get: (id) => ({ id, name: "ことり家計簿" }) },
  }).rebuildAll([{ kind: "project", project_id }]);
  const t = await setup({ extra: { router, now, rebuildProjectIndex } });
  holder.t = t;
  holder.router = new PageRouter({ knowledgeDir: () => t.vault, withWrite: (fn) => fn(), now });
  const read = (rel) => readFileSync(join(t.vault, rel), "utf8");
  const advisor = ctx({ caller: "advisor" });
  try {
    const before = read("projects/kotori/第一.md").split("\n");
    const out = await t.service.append({ project_id: PROJECT, section: "落とし穴", text: "月末は固定日時を渡す", theme: "第一" }, advisor);
    assert.equal(out.status, "appended");
    assert.equal(out.section, "落とし穴");
    const after = read("projects/kotori/第一.md").split("\n");
    assert.ok(after.some((line) => /^- 月末は固定日時を渡す（会話2026-10-10-1） <!-- owl:new /u.test(line)));
    assert.deepEqual(before.filter((line) => !after.includes(line)), ["updated: 2026-10-03"], "only the updated date changes; no existing line is rewritten");
    assert.equal((await t.service.append({ project_id: PROJECT, section: "落とし穴", text: "月末は固定日時を渡す", theme: "第一" }, advisor)).status, "duplicate");
    // A duplicate never rewrites the stored line's sources, and a second conversation of the day gets the next number.
    mkdirSync(join(t.vault, "conversations/2026-10"), { recursive: true });
    writeFileSync(join(t.vault, "conversations/2026-10/2026-10-10-1.md"), "x");
    const kept = read("projects/kotori/第一.md");
    assert.equal((await t.service.append({ project_id: PROJECT, section: "落とし穴", text: "月末は固定日時を渡す", theme: "第一" }, advisor)).status, "duplicate");
    assert.equal(read("projects/kotori/第一.md"), kept);
    await t.service.append({ project_id: PROJECT, section: "概要", text: "二つ目の会話の記録", theme: "第一" }, advisor);
    assert.match(read("projects/kotori/第一.md"), /二つ目の会話の記録（会話2026-10-10-2）/u);

    const created = await t.service.append({ project_id: PROJECT, section: "決まりごと", text: "請求は月初にまとめて出す", theme: "請求の扱い" }, advisor);
    assert.equal(created.status, "appended");
    assert.match(created.page, /請求の扱い/u);
    // append itself rebuilds the Project index, so the new page is listed without a librarian run.
    await t.service.reindex({ mode: "diff" });
    const index = await t.service.readIndex({ project_id: PROJECT }, ctx());
    assert.ok(parsePage(index.text).sections.find((s) => s.heading === "テーマ").lines.some((line) => line.includes("[[請求の扱い]]")), index.text);

    const hash = createHash("sha256").update(read("projects/kotori/第一.md")).digest("hex");
    for (const input of [{ section: "関連ページ", text: "x" }, { section: "更新履歴", text: "x" }, { section: "toString", text: "x" }, { section: "概要", text: "   " }]) {
      assert.ok((await t.service.append({ project_id: PROJECT, theme: "第一", ...input }, advisor)).error, JSON.stringify(input));
    }
    assert.equal((await t.service.append({ section: "概要", text: "x" }, ctx({ caller: "advisor", project_id: null }))).error, "project_required");
    assert.equal(createHash("sha256").update(read("projects/kotori/第一.md")).digest("hex"), hash);
  } finally { await t.cleanup(); }
});
