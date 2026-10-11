import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Core } from "../../dist/index.js";
import { IndexBuilder } from "../../dist/memory/index-builder.js";
import { ConversationLogWriter } from "../../dist/memory/conversation-log-writer.js";
import { assertValidPage, parsePage } from "../../dist/memory/page-format.js";
import { DEFAULT_RESEARCH_TAGS_MAX, DEFAULT_RESEARCH_TAGS_MIN } from "../../../shared/dist/index.js";
import { createUlid, openDatabase } from "../../../db/dist/index.js";

const LIBRARIAN_ROLE = { role: "librarian", provider: "codex", model: "librarian-test-model", effort: "high" };
const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const PROJECT = "01HZZZZZZZZZZZZZZZZZZZZZZP";
const ctx = { caller: "owner", agent_run_id: "run-1", work_id: null, task_id: null, project_id: PROJECT };
const LEGACY_MARKER = '{"format":1,"moved_at":"2026-01-01T00:00:00.000Z","move_id":"abc123"}\n';
const OLD = "旧印ZQXJ7731";
const BODY_MARK = "BODY_MARK_58213";

/** Stand-in embedder: one dimension per keyword plus a constant, so which statements are related is fully predictable. */
const GROUPS = ["日付", "圧縮"];
const vec = (text) => {
  const v = [...GROUPS.map((g) => (text.includes(g) ? 1 : 0)), 0.1];
  const norm = Math.hypot(...v);
  return Float32Array.from(v, (x) => x / norm);
};
const fakeEmbedder = {
  model: "fake-keywords", isReady: () => true, warmup() {}, stop: async () => {},
  health: () => ({ model: "fake-keywords", state: "ready", warning: null }),
  embed: async (_kind, texts) => texts.map(vec),
};

const FIELD_SUMMARY = [
  "# 題名は捨てる", "", "## 話したこと", "- 圧縮の要約の扱い", "", "## 決まったこと", "- 会話の記録は conversations/ に置く", "",
  "## 学んだこと", "- [事実] 圧縮の要約は欄の形で受け取る", "", "## 反映先", "- なし",
].join("\n");

const lesson = (kind, text) => ({
  lesson: text, basis: "観察", applies_to: "今後", kind, topic: "build", procedure: "1. 確認する", rule_text: "確認せずに実行しない", rule_scope: "all",
});

/** Every file under dir (relative path), skipping the top-level names in `skip`. */
function mdFiles(dir) {
  return readdirSync(dir, { recursive: true }).map(String).filter((p) => p.endsWith(".md"));
}

async function setup(t) {
  const parent = mkdtempSync(join(tmpdir(), "owl-fresh-start-"));
  const vault = join(parent, "knowledge");
  const put = (rel, data) => { mkdirSync(dirname(join(vault, rel)), { recursive: true }); writeFileSync(join(vault, rel), data); };
  put("notes/旧ノート.md", `---\nid: 01HZZZZZZZZZZZZZZZZZZZZZZ1\ntype: note\ntitle: ${OLD}題名\n---\n本文に ${OLD} を含む 日付 の話\n`);
  put("research/旧資料.md", `# 旧資料\n${OLD} 日付\n`);
  put("Home.md", `# Home\n${OLD}\n`);
  put(".owl-knowledge", LEGACY_MARKER);

  const db = openDatabase(join(parent, "owl.sqlite"));
  db.migrate(migrations);
  const at = new Date().toISOString();
  const workId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", at, at);
    tx.run(`INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('model_settings', 'owner:default', '1.0.0', ?, ?)`, JSON.stringify({ version: 1, roles: [LIBRARIAN_ROLE] }), at);
    tx.run(`INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('memory_mode', 'owner:default', '1.0.0', ?, ?)`, JSON.stringify("pages"), at);
    tx.run(
      `INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json, verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, 'owner:default', 'Demo', ?, 'main', '[]', '{}', '[]', ?, ?)`, PROJECT, join(parent, "repo"), at, at);
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, display_number, created_at, updated_at)
       VALUES (?, 'owner:default', ?, 'ページ保存の確認', '一行目の要約', 'normal', 'completed', '[]', '[]', 815, ?, ?)`, workId, PROJECT, at, at);
  });

  // Fake model: tags (some of them to be dropped by normalization) and one usage line per clipping the librarian is shown.
  const tagCalls = [];
  const opsCalls = [];
  const agentRunner = {
    runClippingTags: async (request) => {
      tagCalls.push(request);
      return { ok: true, output: { tags: ["Date Library", "time_zone", "日付", "Research", "Web Fetch", "tz-a", "tz-b", "tz-c", "tz-d"] } };
    },
    runLibrarianOperations: async (request) => (opsCalls.push(request), {
      ok: true, usage: { input_tokens: 1, output_tokens: 1 },
      output: { operations: request.clippings.map((c) => ({ op: "set_usage", clipping: c.path, h: c.h, text: "日付の扱いを決めるとき" })) },
    }),
  };
  const core = new Core({ db, agentRunner, version: "t", owlRoot: parent, dataDir: join(parent, "data") });
  core.memory.embedder = fakeEmbedder;
  core.memory.searcher.embedder = fakeEmbedder;
  t.after(async () => {
    await new Promise((r) => setTimeout(r, 100));
    await core.stop({ force: true });
    db.close();
    rmSync(parent, { recursive: true, force: true });
  });
  await core.start();
  return { parent, vault, core, workId, tagCalls, opsCalls };
}

const contains = (value, text) => JSON.stringify(value).includes(text);

test("a legacy vault is archived at start, and everything saved afterwards is a valid page that is found and recalled", async (t) => {
  const { parent, vault, core, workId, tagCalls, opsCalls } = await setup(t);

  // 1. The old files moved out; the vault starts as an empty pages vault.
  assert.ok(!existsSync(join(vault, "notes")) && !existsSync(join(vault, "research")) && !existsSync(join(vault, "Home.md")));
  assert.equal(JSON.parse(readFileSync(join(vault, ".owl-knowledge"), "utf8")).layout, "pages-v1");
  const archive = join(`${vault}.archive`, readdirSync(`${vault}.archive`)[0], "files");
  for (const rel of ["notes/旧ノート.md", "research/旧資料.md", "Home.md"]) {
    assert.ok(existsSync(join(archive, rel)), `${rel} was archived`);
    assert.ok(readFileSync(join(archive, rel), "utf8").includes(OLD), `${rel} kept its content`);
  }
  assert.deepEqual(mdFiles(vault), []);

  // 2. A Work's work-log and its lines on a theme page.
  await core.learningJobs.enqueue(workId, null, PROJECT, [lesson("fact", "ビルドは pnpm build で通る"), lesson("pitfall", "オフラインだと install が失敗する")]);
  await core.learningPipeline.processPendingNow();
  for (let i = 0; i < 100 && core.db.get("SELECT status FROM learning_jobs").status !== "done"; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(core.db.get("SELECT status FROM learning_jobs").status, "done");
  const [workLogPath] = mdFiles(join(vault, "works"));
  assert.ok(workLogPath, "a work-log was written");
  const workLog = readFileSync(join(vault, "works", workLogPath), "utf8");
  assertValidPage(workLog);
  assert.equal(parsePage(workLog).frontmatter.type, "work-log");
  const themePath = mdFiles(join(vault, "projects")).find((p) => p.endsWith("その他の注意.md"));
  assert.ok(themePath, "a theme page received the lessons");
  const theme = readFileSync(join(vault, "projects", themePath), "utf8");
  assertValidPage(theme);
  assert.match(theme, /ビルドは pnpm build で通る/u);

  // 3. A conversation log from a field-shaped compaction summary.
  const writer = new ConversationLogWriter({
    knowledgeDir: () => vault, withWrite: (fn) => core.knowledgeLocation.withWrite(fn), router: core.pageRouter, project: () => null,
  });
  const conversation = await writer.write({ sessionId: "s1", conversationId: "c1", cause: "auto", summary: FIELD_SUMMARY, transcriptPath: null, provider: "anthropic", model: "m", index: 1 });
  const conversationText = readFileSync(join(vault, conversation.path), "utf8");
  assertValidPage(conversationText);
  assert.equal(parsePage(conversationText).frontmatter.type, "conversation-log");

  // 4. A clipping saved from a fetch; the fake model gives the tags, then (librarian) the 使いどころ line.
  const saved = await core.recordAgentResearch({ role: "worker", agent_run_id: createUlid() }, {
    tool: "WebFetch", url: "https://docs.example.test/date-libs", query: null, prompt: "日付ライブラリを比べる", title: "日付ライブラリ 3 種の比較",
    content: `# 日付ライブラリ\n\n- 日付ライブラリのタイムゾーン対応を 3 種で比べた記事である。\n\n${BODY_MARK} 本文の続き。これは丸写しされてはいけない長い本文である。`,
    links: [], http_status: 200, is_error: false,
  });
  assert.equal(saved.accepted, true);
  await core.researchRecorder.idle();
  await core.memory.reindex({ mode: "diff", embed: true });
  await core.pageLibrarian.run({ run_id: `01HRUN${"0".repeat(19)}1`, mode: "manual" });
  await core.memory.reindex({ mode: "diff", embed: true });

  const [clippingPath] = mdFiles(join(vault, "research"));
  assert.ok(clippingPath, "a clipping was written");
  const clippingText = readFileSync(join(vault, "research", clippingPath), "utf8");
  assertValidPage(clippingText);
  const clipping = parsePage(clippingText);
  assert.equal(clipping.frontmatter.type, "clipping");
  assert.ok(clipping.sections.some((s) => s.heading === "使いどころ" && s.lines.some((l) => l.includes("日付の扱いを決めるとき"))));
  assert.ok(clipping.sections.every((s) => s.heading !== "抜粋"));
  assert.ok(!clippingText.includes(BODY_MARK), "the body is not copied");
  const tags = /^tags: \[(.*)\]$/mu.exec(clippingText)[1].split(", ").filter(Boolean);
  assert.ok(tags.length >= DEFAULT_RESEARCH_TAGS_MIN && tags.length <= DEFAULT_RESEARCH_TAGS_MAX, tags.join());
  assert.ok(tags.every((tag) => /^[a-z0-9]+(-[a-z0-9]+)*$/u.test(tag)), tags.join());
  assert.ok(!tags.some((tag) => ["research", "web-search", "web-fetch"].includes(tag)));
  assert.equal(tagCalls.length, 1);
  assert.deepEqual(tagCalls[0].model, { provider: LIBRARIAN_ROLE.provider, model: LIBRARIAN_ROLE.model, effort: LIBRARIAN_ROLE.effort }, "clipping tags run on the Librarian role model");
  assert.ok(opsCalls.length > 0, "knowledge upkeep called the runner");
  for (const call of opsCalls) assert.deepEqual(call.model, { provider: LIBRARIAN_ROLE.provider, model: LIBRARIAN_ROLE.model, effort: LIBRARIAN_ROLE.effort }, "knowledge upkeep runs on the Librarian role model");

  // 5. Each saved page is reachable by the route the design gives it:
  //    theme pages are in the table of contents injected into roles; theme / work-log / clipping are found by search;
  //    conversation logs are not searchable by design, but are registered, open by path, and their lines are found through the theme page.
  const paths = { workLog: `works/${workLogPath}`, theme: `projects/${themePath}`, conversation: conversation.path, clipping: `research/${clippingPath}` };
  const listed = core.memory.index.listPages({ types: ["work-log", "theme", "conversation-log", "clipping"] });
  for (const path of Object.values(paths)) assert.ok(listed.some((p) => p.path === path), `${path} is registered in the index`);
  const projectIndex = await core.memory.readIndex({ project_id: PROJECT }, ctx);
  assert.ok(contains(projectIndex, "[[その他の注意]]"));
  const injected = await core.memoryInjector.compose({ role: "worker", query: [], project_id: PROJECT, session_id: "s-t" });
  assert.ok(contains(injected, "[[その他の注意]]"), "the injected table of contents lists the theme page");
  const found = await core.memory.search({ query: "pnpm build" }, ctx);
  assert.ok(found.items.some((i) => i.path === paths.workLog));
  // A project's theme page is searched within that project's scope.
  const foundTheme = await core.memory.search({ query: "オフラインだと install が失敗する", project_id: PROJECT }, ctx);
  assert.ok(foundTheme.items.some((i) => i.path === paths.theme));
  const foundClipping = await core.memory.searchPages({ query: "日付ライブラリ" }, ctx);
  assert.ok(foundClipping.items.some((i) => i.path === paths.clipping));
  const foundConversation = await core.memory.search({ query: "圧縮の要約" }, ctx);
  assert.ok(!foundConversation.items.some((i) => i.path === paths.conversation));
  const opened = await core.memory.page({ page: paths.conversation }, ctx);
  assert.ok(opened.found && opened.path === paths.conversation, "the conversation log opens by path");
  const decisionLine = parsePage(readFileSync(join(vault, conversation.path), "utf8")).sections.flatMap((s) => s.lines).join("\n");
  assert.ok(decisionLine.length > 0);
  // Both conversation items (決まったこと / 学んだこと) were appended to the common theme page, and each is found through it.
  const appended = conversation.routed.filter((r) => r.status === "appended");
  assert.equal(appended.length, 2, JSON.stringify(conversation.routed));
  const commonTheme = appended[0].page;
  assert.ok(commonTheme.startsWith("common/") && appended.every((r) => r.page === commonTheme), "conversation items went to a common theme page");
  const commonThemeText = readFileSync(join(vault, commonTheme), "utf8");
  assertValidPage(commonThemeText);
  for (const text of ["会話の記録は conversations/ に置く", "圧縮の要約は欄の形で受け取る"]) {
    assert.ok(commonThemeText.includes(text), `${text} was written to ${commonTheme}`);
    const hit = await core.memory.search({ query: text }, ctx);
    assert.ok(hit.items.some((i) => i.path === commonTheme), `${text} is found through ${commonTheme}`);
    assert.ok(!hit.items.some((i) => i.path === paths.conversation));
  }

  // Index pages are derived: rebuild them with the production IndexBuilder, then read what roles are actually given.
  const builder = new IndexBuilder({
    index: core.memory.index,
    writer: {
      read: async (path) => (existsSync(join(vault, path)) ? readFileSync(join(vault, path), "utf8") : null),
      write: async (path, text) => { mkdirSync(dirname(join(vault, path)), { recursive: true }); writeFileSync(join(vault, path), text); return { path, written: true }; },
    },
    projects: { get: (id) => core.db.get("SELECT id, name FROM projects WHERE id = ?", id) ?? null },
  });
  await builder.rebuildAll();
  await core.memory.reindex({ mode: "diff", embed: true });
  const themeLines = (text) => parsePage(text).sections.find((s) => s.heading === "テーマ")?.lines.filter((l) => l.includes("[[その他の注意]]")) ?? [];
  const rebuiltProject = await core.memory.readIndex({ project_id: PROJECT }, ctx);
  assert.equal(themeLines(rebuiltProject.text).length, 1, "the Work's theme page is in the project index");
  const rebuiltCommon = await core.memory.readIndex({ project_id: null }, ctx);
  assert.ok(rebuiltCommon.found && rebuiltCommon.path === "common/_index.md", "the common index exists");
  assert.equal(themeLines(rebuiltCommon.text).length, 1, "the conversation's theme page is in the common index");
  const injectedProject = await core.memoryInjector.compose({ role: "worker", query: [], project_id: PROJECT, session_id: "s-p" });
  const injectedCommon = await core.memoryInjector.compose({ role: "worker", query: [], project_id: null, session_id: "s-c" });
  assert.ok(contains(injectedProject, "[[その他の注意]]") && injectedProject.includes(`scope="project" project="Demo"`), "the project table of contents is injected");
  assert.ok(contains(injectedCommon, "[[その他の注意]]") && injectedCommon.includes(`scope="common"`) && !injectedCommon.includes("Demo"), "the common table of contents is injected apart from the project's");

  // 6. Recall: one line for a related statement, nothing for an unrelated one.
  const related = await core.memoryInjector.compose({ role: "advisor", query: [], project_id: null, session_id: "s-r", recall_query: "日付のタイムゾーンってどうだっけ" });
  const lines = (related ?? "").split("\n").filter((l) => l.startsWith("前に調べた資料:"));
  assert.equal(lines.length, 1, related ?? "");
  const { title, summary, retrieved_at } = clipping.frontmatter;
  assert.equal(lines[0], `前に調べた資料: [[${title}]] — ${summary}（${String(retrieved_at).slice(0, 10)}）`);
  assert.ok(!(related ?? "").includes(BODY_MARK));
  const unrelated = await core.memoryInjector.compose({ role: "advisor", query: [], project_id: null, session_id: "s-u", recall_query: "おはよう" });
  assert.ok(!(unrelated ?? "").includes("前に調べた資料") && !(unrelated ?? "").includes("owl-research-recall"));

  // 7. The archived files never show up.
  for (const result of [found, foundClipping, await core.memory.search({ query: OLD }, ctx), await core.memory.searchPages({ query: OLD }, ctx)]) assert.ok(!contains(result, OLD));
  assert.ok(!contains(await core.memory.readIndex({ project_id: PROJECT }, ctx), OLD));
  assert.ok(!contains(listed, OLD));
  assert.ok(!contains(projectIndex, OLD));
  assert.ok(!(related ?? "").includes(OLD));
  const oldQuery = await core.memoryInjector.compose({ role: "advisor", query: [], project_id: null, session_id: "s-o", recall_query: `${OLD} 日付` });
  assert.ok(!(oldQuery ?? "").includes(OLD));
});
