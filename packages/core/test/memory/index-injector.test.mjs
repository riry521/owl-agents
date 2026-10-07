import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Core, createTaskPlanInTransaction, createWorkInTransaction } from "../../dist/index.js";
import { IndexInjector } from "../../dist/memory/index-injector.js";
import { MemoryIndex } from "../../dist/memory/memory-index.js";
import { estimatePageTokens, parsePage, renderPage } from "../../dist/memory/page-format.js";
import { createUlid, openDatabase } from "../../../db/dist/index.js";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
/** Fixture pages are parsed from the shared samples and re-rendered with renderPage; `edit` may change the parsed page. */
const fixture = (kind, suffix, edit) => {
  let page = parsePage(readFileSync(new URL(`./fixtures/pages/${kind}.md`, import.meta.url), "utf8"));
  if (suffix) page = { ...page, frontmatter: { ...page.frontmatter, id: page.frontmatter.id.replace(/\w$/u, suffix) } };
  return renderPage(edit ? edit(page) : page);
};
const PROJECT_ID = /^project_id: (\w+)$/mu.exec(fixture("theme"))[1];
const COMMON_INDEX = fixture("project-index", "C", (page) => {
  const { project_id: _drop, ...frontmatter } = page.frontmatter;
  return {
    ...page,
    frontmatter: { ...frontmatter, scope: "common", title: "共通の目次", source_hash: "c0".repeat(32) },
    frontmatter_order: page.frontmatter_order.filter((k) => k !== "project_id"),
    title: "共通の目次",
    sections: page.sections.map((s) => (s.heading === "概要" ? { ...s, lines: ["Project をまたぐ決まりごと"] } : s)),
  };
});
const tokens = (text) => estimatePageTokens(text);

function writeVault(vault, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(vault, rel)), { recursive: true });
    writeFileSync(join(vault, rel), text);
  }
}

async function indexOf(t, files, available = { value: true }) {
  const root = mkdtempSync(join(tmpdir(), "owl-index-injector-"));
  const vault = join(root, "vault");
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(vault, { recursive: true });
  writeVault(vault, files);
  const storage = { isAvailable: () => available.value, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: available.value, dir: vault, since: null }) };
  const index = new MemoryIndex({ dataDir: join(root, "data"), storage, watch: false });
  await index.start();
  await index.rebuild("manual");
  t.after(async () => { await index.stop(); rmSync(root, { recursive: true, force: true }); });
  return { index, vault, available };
}

const injectorOf = (index, available) => new IndexInjector({ index, isAvailable: () => available.value, now: () => new Date("2030-01-02T03:04:05.000Z"), logger: { warn() {} } });

async function coreWithPages(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-index-wiring-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const seen = {};
  const capture = (role) => async (input) => { seen[role] = input; throw new Error("stop after capture"); };
  const agentRunner = { runManagerPlan: capture("manager"), runDesigner: capture("designer"), runWorker: capture("worker"), runReviewer: capture("reviewer"), runCurator: capture("curator"), runAdvisor: async () => ({ reply: "" }) };
  const core = new Core({ db, agentRunner, version: "t", owlRoot: root, dataDir: join(root, "data") });
  t.after(async () => { await core.stop({ force: true }); db.close(); await rm(root, { recursive: true, force: true }); });
  await core.start();
  const now = new Date().toISOString();
  const lane = db.createWriteLane();
  await lane.transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run("INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json, verification_plan_json, worktree_prepare_argv_json, created_at, updated_at) VALUES (?, 'owner:default', 'ことり家計簿', ?, 'main', ?, '{}', '[]', ?, ?)", PROJECT_ID, root, JSON.stringify([root]), now, now);
    tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('memory_mode', 'owner:default', 1, '\"pages\"', ?)", now);
  });
  await mkdir(join(root, "knowledge", "projects", "p"), { recursive: true });
  await mkdir(join(root, "knowledge", "common"), { recursive: true });
  await writeFile(join(root, "knowledge", "projects", "p", "_index.md"), fixture("project-index"));
  await writeFile(join(root, "knowledge", "common", "_index.md"), COMMON_INDEX);
  await core.memory.reindex({ mode: "full" });
  const plan = async (projectId) => lane.transact((tx) => {
    const created = createWorkInTransaction(tx, { title: "w", summary: "x", size: "normal", project_id: projectId });
    createTaskPlanInTransaction(tx, created.id, [
      { id: "D1", title: "Design", type: "design", acceptance: "ok", depends_on: [] },
      { id: "W1", title: "Implement", type: "code", acceptance: "ok", depends_on: [] },
    ]);
    const rows = tx.all("SELECT id, type FROM tasks WHERE work_id = ?", created.id);
    return { workId: created.id, designId: rows.find((r) => r.type === "design").id, taskId: rows.find((r) => r.type !== "design").id };
  });
  const startRun = (workId, task, role, taskStatus) => {
    const id = createUlid();
    return lane.transact((tx) => {
      tx.run("INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'anthropic', 'm', 'running', ?, ?, ?)", id, workId, task, role, now, now, now);
      tx.run("UPDATE tasks SET status = ? WHERE id = ?", taskStatus, task);
    }).then(() => id);
  };
  const roles = async (projectId) => {
    const { workId, designId, taskId } = await plan(projectId);
    for (const k of Object.keys(seen)) delete seen[k];
    await core.invokeManagerPlan({ work_id: workId }, "plan").catch(() => {});
    await core.workflow.runWorkerInternal(workId, designId, await startRun(workId, designId, "designer", "running"), 1).catch(() => {});
    await core.workflow.runWorkerInternal(workId, taskId, await startRun(workId, taskId, "worker", "running"), 1).catch(() => {});
    const workerRun = await startRun(workId, taskId, "worker", "verifying");
    await core.workflow.runReviewerInternal(workId, taskId, workerRun, { summary: "s" }, 1).catch(() => {});
    return Object.fromEntries(["manager", "designer", "worker", "reviewer"].map((r) => [r, seen[r]?.context?.knowledge]));
  };
  return { core, roles, root };
}

test("pages mode: Manager, Designer, Worker and Reviewer get the project index within 1,200 tokens; Reviewer has no summary", async (t) => {
  const { roles } = await coreWithPages(t);
  const found = await roles(PROJECT_ID);
  for (const [role, text] of Object.entries(found)) {
    assert.ok(text, `${role} has no index`);
    assert.match(text, /^<owl-memory scope="project" project="ことり家計簿">/u, role);
    assert.ok(text.includes("[[テストの落とし穴]]") && text.includes("owl-memory の page で開く"), role);
    assert.ok(tokens(text) <= 1200, `${role} ${tokens(text)} tokens`);
    assert.match(text, /\n<\/owl-memory>\n_memory injected: [\d.]+kB \/ [\d.]+kB budget · collapsed: none_$/u, role);
  }
  assert.ok(found.manager.includes("## 概要") && found.worker.includes("## 概要"));
  assert.ok(!found.reviewer.includes("## 概要") && found.reviewer.includes("## 必読"));
});

test("pages mode: a Work without a Project gets the common index; the Curator gets nothing", async (t) => {
  const { core, roles } = await coreWithPages(t);
  const found = await roles(null);
  assert.match(found.manager, /^<owl-memory scope="common">/u);
  assert.ok(found.manager.includes("Project をまたぐ決まりごと"));
  assert.equal(await core.memoryInjector.compose({ role: "curator", query: ["x"], project_id: PROJECT_ID }), null);
});

test("an index over the limit collapses sections and lists them in collapsed:", async (t) => {
  const many = (n) => Array.from({ length: n }, (_, i) => `- [[ページ${i}]] — ${"説明".repeat(20)}`).join("\n");
  const big = fixture("project-index").replace(/## テーマ\n[\s\S]*?\n\n## 共通テーマ\n.*\n?/u, `## テーマ\n${many(40)}\n\n## 共通テーマ\n${many(10)}\n`);
  const { index, available } = await indexOf(t, { "projects/p/_index.md": big });
  const text = await injectorOf(index, available).compose({ role: "worker", query: [], project_id: PROJECT_ID });
  assert.ok(tokens(text) <= 1200, `${tokens(text)} tokens`);
  assert.match(text, /collapsed: 共通テーマ(, 概要)?(, テーマ)?_$/u);
  assert.ok(text.includes("## 必読") && text.includes("上限超過のため省略"));
});

test("disconnected vault: the index copy is used with a first line saying so; an empty index says memory is unavailable", async (t) => {
  const { index, available } = await indexOf(t, { "projects/p/_index.md": fixture("project-index") });
  available.value = false;
  const injector = injectorOf(index, available);
  const text = await injector.compose({ role: "manager", query: [], project_id: PROJECT_ID });
  const lines = text.split("\n");
  assert.match(lines[0], /^保管庫未接続：\S+ 時点の目次$/u);
  assert.match(lines[2], /^<owl-memory /u);
  assert.ok(text.includes("[[金額と集計]]"));
  const empty = await indexOf(t, {});
  empty.available.value = false;
  assert.equal(await injectorOf(empty.index, empty.available).compose({ role: "manager", query: [], project_id: null }), "記憶は利用できません（保管庫未接続）");
});

test("Advisor: first turn lists project index titles; later turns are empty until something changes; compaction restarts", async (t) => {
  const theme = fixture("theme");
  const { index, vault, available } = await indexOf(t, { "projects/p/_index.md": fixture("project-index"), "common/_index.md": COMMON_INDEX, "projects/p/テスト.md": theme });
  const injector = injectorOf(index, available);
  const turn = (session_id) => injector.compose({ role: "advisor", query: [], project_id: null, session_id });
  const first = await turn("s1");
  assert.match(first, /^<owl-memory scope="advisor" /u);
  assert.ok(first.includes("Project をまたぐ決まりごと") && first.includes("## Project 目次の一覧\n- ことり家計簿 の目次"));
  assert.ok(tokens(first) <= 1600, `${tokens(first)} tokens`);
  assert.equal(await turn("s1"), null);

  // The session opened the theme page and the project index through MCP; the common index was injected. All three change on disk.
  const themePath = index.listPages({ types: ["theme"] })[0].path;
  injector.noteShown("s1", themePath);
  injector.noteShown("s1", "projects/p/_index.md");
  writeFileSync(join(vault, "common/_index.md"), COMMON_INDEX.replace("Project をまたぐ決まりごと", "Project をまたぐ決まりごと（更新）").replace(/^source_hash: .*$/mu, "source_hash: " + "d1".repeat(32)));
  writeFileSync(join(vault, themePath), theme.replace(/^integrated_hash: .*$/mu, "integrated_hash: newhash").replace(/(## 更新履歴\n)/u, "$1- 2030-01-02 W900 落とし穴+1（司書）\n"));
  writeFileSync(join(vault, "projects/p/_index.md"), fixture("project-index").replace("- [[金額と集計]] — 金額の型と月次集計の区切り方\n", "").replace(/^source_hash: .*$/mu, "source_hash: " + "e1".repeat(32)));
  await index.rebuild("manual");
  const diff = await turn("s1");
  assert.match(diff, /^<owl-memory-diff generated="[^"]+">/u);
  assert.ok(diff.includes("+ Project をまたぐ決まりごと（更新）") && diff.includes("- Project をまたぐ決まりごと"));
  assert.ok(diff.includes("+ - 2030-01-02 W900 落とし穴+1（司書）") && diff.includes("- - [[金額と集計]] — 金額の型と月次集計の区切り方"));
  assert.ok(!diff.includes("テストの落とし穴]] — 日付"), "unchanged lines are not repeated");
  assert.ok(tokens(diff) <= 300);
  assert.equal(await turn("s1"), null);

  injector.resetSession("s1");
  assert.match(await turn("s1"), /^<owl-memory scope="advisor" /u);
});

test("an oversized required-reading section still ends up within the limit", async (t) => {
  const huge = Array.from({ length: 600 }, (_, i) => `- [[必読${i}]] — ${"説明".repeat(20)}`).join("\n");
  const big = fixture("project-index").replace(/(## 必読\n)[\s\S]*?\n\n(## )/u, `$1${huge}\n\n$2`);
  const { index, available } = await indexOf(t, { "projects/p/_index.md": big, "common/_index.md": big.replace(/^source_hash: .*$/mu, "source_hash: " + "c9".repeat(32)) });
  const injector = injectorOf(index, available);
  const text = await injector.compose({ role: "worker", query: [], project_id: PROJECT_ID });
  assert.ok(tokens(text) <= 1200, `${tokens(text)} tokens`);
  assert.ok(text.includes("collapsed:") && text.includes("必読"));
  const start = await injector.compose({ role: "advisor", query: [], project_id: null, session_id: "s" });
  assert.ok(tokens(start) <= 1600, `${tokens(start)} tokens`);
});

test("Advisor: a body-only edit (same source_hash) shows up in the diff, through Core.noteMemoryShown", async (t) => {
  const { core, root } = await coreWithPages(t);
  const advisor = () => core.memoryInjector.compose({ role: "advisor", query: [], project_id: null, session_id: "s" });
  assert.match(await advisor(), /^<owl-memory scope="advisor" /u);
  core.noteMemoryShown("s", "projects/p/_index.md");
  assert.equal(await advisor(), null);
  await writeFile(join(root, "knowledge", "projects", "p", "_index.md"), fixture("project-index").replace("- [[金額と集計]] — 金額の型と月次集計の区切り方\n", ""));
  await core.memory.reindex({ mode: "full" });
  const diff = await advisor();
  assert.match(diff, /^<owl-memory-diff /u);
  assert.ok(diff.includes("- - [[金額と集計]]"));
});

test("a very long index title or many headings still fit both limits", async (t) => {
  const longTitle = fixture("project-index").replace(/^title: .*$/mu, `title: ${"長".repeat(1400)} の目次`);
  const headings = fixture("project-index") + Array.from({ length: 400 }, (_, i) => `\n## 見出し${i}\n- [[x${i}]] — 説明\n`).join("");
  for (const [name, body] of [["title", longTitle], ["headings", headings]]) {
    const { index, available } = await indexOf(t, { "projects/p/_index.md": body, "common/_index.md": COMMON_INDEX });
    const injector = injectorOf(index, available);
    const worker = await injector.compose({ role: "worker", query: [], project_id: PROJECT_ID });
    assert.ok(tokens(worker) <= 1200, `${name} worker ${tokens(worker)} tokens`);
    // An index that breaks its template is not knowledge, so the Worker may get only the common index.
    assert.match(worker, /^<owl-memory scope="(?:project|common)"/u);
    const start = await injector.compose({ role: "advisor", query: [], project_id: null, session_id: name });
    assert.ok(tokens(start) <= 1600, `${name} advisor ${tokens(start)} tokens`);
  }
});

test("Advisor: Project title list changes (add, rename, delete) and a deleted tracked page are reported", async (t) => {
  const theme = fixture("theme");
  const { index, vault, available } = await indexOf(t, { "projects/p/_index.md": fixture("project-index"), "common/_index.md": COMMON_INDEX, "projects/p/テスト.md": theme });
  const injector = injectorOf(index, available);
  const turn = () => injector.compose({ role: "advisor", query: [], project_id: null, session_id: "s" });
  await turn();
  assert.equal(await turn(), null);
  const themePath = index.listPages({ types: ["theme"] })[0].path;
  injector.noteShown("s", themePath);

  writeFileSync(join(vault, "projects/p/_index.md"), fixture("project-index").replace(/^title: .*$/mu, "title: 改名後 の目次"));
  await index.rebuild("manual");
  const renamed = await turn();
  assert.ok(renamed.includes("+ - 改名後 の目次") && renamed.includes("- - ことり家計簿 の目次"), renamed);
  assert.equal(await turn(), null);

  rmSync(join(vault, themePath));
  await index.rebuild("manual");
  const deleted = await turn();
  assert.ok(deleted.includes("（削除された）"), deleted);
  assert.equal(await turn(), null);

  rmSync(join(vault, "projects/p/_index.md"));
  await index.rebuild("manual");
  assert.ok((await turn()).includes("- - 改名後 の目次"));
});

const advisorTurn = (injector) => injector.compose({ role: "advisor", query: [], project_id: null, session_id: "s" });
const changedCommon = COMMON_INDEX.replace(/^source_hash: .*$/mu, "source_hash: " + "f2".repeat(32)).replace(/## テーマ\n/u, "## テーマ\n- [[作り直し後]] — 新しい\n");

test("Advisor: a deleted common index is reported once, then a re-created one shows in the diff", async (t) => {
  const { index, vault, available } = await indexOf(t, { "common/_index.md": COMMON_INDEX });
  const injector = injectorOf(index, available);
  await advisorTurn(injector);
  rmSync(join(vault, "common/_index.md"));
  await index.rebuild("manual");
  assert.ok((await advisorTurn(injector)).includes("（削除された）"));
  assert.equal(await advisorTurn(injector), null);
  writeFileSync(join(vault, "common/_index.md"), changedCommon);
  await index.rebuild("manual");
  const again = await advisorTurn(injector);
  assert.ok(again && again.includes("<owl-memory-diff"), again);
  assert.equal(await advisorTurn(injector), null);
});

test("Advisor: a common index created after turn 1 shows in the next diff", async (t) => {
  const { index, vault, available } = await indexOf(t, { "projects/p/_index.md": fixture("project-index") });
  const injector = injectorOf(index, available);
  await advisorTurn(injector);
  assert.equal(await advisorTurn(injector), null);
  mkdirSync(join(vault, "common"), { recursive: true });
  writeFileSync(join(vault, "common/_index.md"), COMMON_INDEX);
  await index.rebuild("manual");
  const diff = await advisorTurn(injector);
  assert.ok(diff && diff.includes("<owl-memory-diff"), diff);
  assert.equal(await advisorTurn(injector), null);
});

test("Advisor: with an empty vault on turn 1, a common index created later shows in the diff, then null", async (t) => {
  const { index, vault, available } = await indexOf(t, {});
  const injector = injectorOf(index, available);
  assert.equal(await advisorTurn(injector), null);
  mkdirSync(join(vault, "common"), { recursive: true });
  writeFileSync(join(vault, "common/_index.md"), COMMON_INDEX);
  await index.rebuild("manual");
  const diff = await advisorTurn(injector);
  assert.ok(diff && diff.startsWith("<owl-memory-diff"), diff);
  assert.equal(await advisorTurn(injector), null);
});

test("Advisor: a theme page deleted and re-created at the same path shows in the diff, then stays quiet", async (t) => {
  const theme = fixture("theme");
  const { index, vault, available } = await indexOf(t, { "projects/p/_index.md": fixture("project-index"), "projects/p/テスト.md": theme });
  const injector = injectorOf(index, available);
  await advisorTurn(injector);
  const themePath = index.listPages({ types: ["theme"] })[0].path;
  injector.noteShown("s", themePath);
  rmSync(join(vault, themePath));
  await index.rebuild("manual");
  assert.ok((await advisorTurn(injector)).includes("（削除された）"));
  writeFileSync(join(vault, themePath), theme.replace(/\n$/u, "\n\n再作成\n"));
  await index.rebuild("manual");
  const again = await advisorTurn(injector);
  assert.ok(again && again.includes("（作り直された）"), again);
  assert.equal(await advisorTurn(injector), null);
});

test("Advisor: after delete and re-create, no further change gives an empty diff", async (t) => {
  const { index, vault, available } = await indexOf(t, { "common/_index.md": COMMON_INDEX });
  const injector = injectorOf(index, available);
  await advisorTurn(injector);
  rmSync(join(vault, "common/_index.md"));
  await index.rebuild("manual");
  await advisorTurn(injector);
  writeFileSync(join(vault, "common/_index.md"), COMMON_INDEX);
  await index.rebuild("manual");
  assert.ok(await advisorTurn(injector));
  await index.rebuild("manual");
  assert.equal(await advisorTurn(injector), null);
});

test("Advisor: a diff over 300 tokens becomes a one-line notice", async (t) => {
  const { index, vault, available } = await indexOf(t, { "common/_index.md": COMMON_INDEX });
  const injector = injectorOf(index, available);
  await injector.compose({ role: "advisor", query: [], project_id: null, session_id: "s" });
  const lines = Array.from({ length: 80 }, (_, i) => `- [[新しいページ${i}]] — ${"説明".repeat(10)}`).join("\n");
  writeFileSync(join(vault, "common/_index.md"), COMMON_INDEX.replace(/## テーマ\n/u, `## テーマ\n${lines}\n`).replace(/^source_hash: .*$/mu, "source_hash: " + "f1".repeat(32)));
  await index.rebuild("manual");
  assert.match(await injector.compose({ role: "advisor", query: [], project_id: null, session_id: "s" }), /^<owl-memory-diff generated="[^"]+">1 ページが更新された。page で開き直す<\/owl-memory-diff>$/u);
});

const advisorCtx = { caller: "advisor", agent_run_id: "s", work_id: null, task_id: null, project_id: null };
const themeText = (title, n) => fixture("theme").replace(/^id: \w{25}\w$/mu, `id: 01HZZZZZZZZZZZZZZZZZZZZZZ${n}`).replaceAll("テストの落とし穴", title);

test("Advisor: a page opened through MemoryService.page is recorded as shown and a later edit reaches <owl-memory-diff>", async (t) => {
  const { core, root } = await coreWithPages(t);
  const file = join(root, "knowledge", "projects", "p", "第一.md");
  await writeFile(file, themeText("第一", "1"));
  await core.memory.reindex({ mode: "full" });
  const advisor = () => core.memoryInjector.compose({ role: "advisor", query: [], project_id: null, session_id: "s" });
  await advisor();
  assert.equal(await advisor(), null);
  assert.equal((await core.memory.page({ page: "第一" }, advisorCtx)).found, true);
  assert.equal(await advisor(), null);
  await writeFile(file, themeText("第一", "1").replace("## 落とし穴", "## 落とし穴\n- 追記された一行"));
  await core.memory.reindex({ mode: "full" });
  const diff = await advisor();
  assert.match(diff, /^<owl-memory-diff /u);
  assert.ok(diff.includes("第一"), diff);
});

test("Advisor: the page budget is counted afresh at the start of each turn", async (t) => {
  const { core, root } = await coreWithPages(t);
  for (const [i, title] of ["第一", "第二", "第三"].entries()) await writeFile(join(root, "knowledge", "projects", "p", `${title}.md`), themeText(title, String(i + 1)));
  await core.memory.reindex({ mode: "full" });
  const advisor = () => core.memoryInjector.compose({ role: "advisor", query: [], project_id: null, session_id: "s" });
  await advisor();
  assert.equal((await core.memory.page({ page: "第一" }, advisorCtx)).found, true);
  assert.equal((await core.memory.page({ page: "第二" }, advisorCtx)).found, true);
  assert.equal((await core.memory.page({ page: "第三" }, advisorCtx)).error, "page_budget_exceeded");
  await advisor();
  assert.equal((await core.memory.page({ page: "第三" }, advisorCtx)).found, true);
});

test("Advisor: a project-index, clipping or work-log opened through MemoryService.page is recorded as shown too", async (t) => {
  const { core, root } = await coreWithPages(t);
  const pages = { "projects/p/_index.md": "projects/p/_index.md", "research/日付.md": fixture("clipping"), "works/W815-月末.md": fixture("work-log") };
  for (const [rel, text] of Object.entries(pages)) {
    await mkdir(dirname(join(root, "knowledge", rel)), { recursive: true });
    await writeFile(join(root, "knowledge", rel), rel === "projects/p/_index.md" ? fixture("project-index") : text);
  }
  await core.memory.reindex({ mode: "full" });
  for (const [rel, text] of Object.entries(pages)) {
    const sessionId = `s-${rel}`;
    const advisor = () => core.memoryInjector.compose({ role: "advisor", query: [], project_id: null, session_id: sessionId });
    await advisor();
    const opened = await core.memory.page({ page: rel }, { ...advisorCtx, agent_run_id: sessionId });
    assert.equal(opened.found, true, rel);
    assert.equal(await advisor(), null, rel);
    const body = rel === "projects/p/_index.md" ? fixture("project-index") : text;
    await writeFile(join(root, "knowledge", rel), `${body.trimEnd()}\n追記された一行\n`);
    await core.memory.reindex({ mode: "full" });
    assert.match(await advisor(), /^<owl-memory-diff /u, rel);
  }
});
