import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { PageRouter, STORAGE_UNAVAILABLE_CODE } from "../../packages/core/dist/memory/page-router.js";
import { WorkLogWriter } from "../../packages/core/dist/memory/work-log-writer.js";
import { emptyThemePage, parsePage, renderPage } from "../../packages/core/dist/memory/page-format.js";
import { LearningJobs, LearningPipeline } from "../../packages/core/dist/learning-pipeline.js";
import { RuleProposals } from "../../packages/core/dist/rule-proposals.js";
import { openTestDatabase } from "../helpers/db.mjs";
import { tempDir } from "../helpers/temp.mjs";

const PROJECT_ID = createUlid();
const NOW = () => new Date("2026-10-03T00:00:00Z");
const passthrough = (fn) => fn();
const source = (n) => ({ work_number: n, work_id: null, actor: "final-manager" });

async function vault(t) {
  const root = await tempDir(t, "owl-page-router-");
  const router = new PageRouter({ knowledgeDir: () => root, withWrite: passthrough, projectName: () => "Demo", now: NOW });
  return { root, router };
}

async function projectDir(root) {
  const [slug] = await readdir(join(root, "projects"));
  return join(root, "projects", slug);
}

async function addTheme(root, title, extra = {}) {
  const dir = await projectDir(root);
  const page = emptyThemePage({ id: createUlid(), title, summary: `${title}の話`, scope: "project", project_id: PROJECT_ID, today: "2026-10-01" });
  const merged = { ...page, frontmatter: { ...page.frontmatter, ...extra }, frontmatter_order: [...page.frontmatter_order, ...Object.keys(extra)] };
  const path = extra.status === "archived" ? join(root, "archive") : dir;
  await mkdir(path, { recursive: true });
  await writeFile(join(path, `${title}.md`), renderPage(merged));
  return join(path, `${title}.md`);
}

const input = (kind, text, extra = {}) => ({ kind, text, project_id: PROJECT_ID, source: source(815), ...extra });
const sectionLines = (page, heading) => page.sections.find((section) => section.heading === heading)?.lines ?? [];

test("PageRouter maps kinds to sections, sends a specified theme to its page and an unspecified one to the miscellaneous-cautions page, with owl:new marks", async (t) => {
  const { root, router } = await vault(t);
  const first = await router.route(input("pitfall", "未指定の落とし穴"));
  assert.equal(first.status, "appended");
  assert.equal(first.section, "落とし穴");
  assert.match(first.page, /その他の注意/u);
  const dir = await projectDir(root);
  const files = (await readdir(dir)).sort();
  assert.deepEqual(files, ["_index.md", "その他の注意.md", "プロジェクトの構成.md"]);

  await addTheme(root, "デプロイ");
  const decision = await router.route(input("decision", "決めたこと", { theme: "デプロイ" }));
  const fact = await router.route(input("fact", "分かった事実", { theme: "デプロイ" }));
  const pit = await router.route(input("pitfall", "デプロイの罠", { theme: "デプロイ" }));
  assert.deepEqual([decision.section, fact.section, pit.section], ["決まりごと", "概要", "落とし穴"]);
  for (const result of [decision, fact, pit]) assert.match(result.page, /デプロイ/u);
  const page = parsePage(await readFile(join(dir, "デプロイ.md"), "utf8"));
  const line = sectionLines(page, "決まりごと").find((item) => item.includes("決めたこと"));
  assert.match(line, /（W815）/u);
  assert.match(line, /<!-- owl:new 2026-10-03 W815 -->/u);
  assert.ok(sectionLines(page, "落とし穴").some((item) => item.includes("デプロイの罠")));
  assert.ok(sectionLines(page, "概要").some((item) => item.includes("分かった事実")));

  const proc = await router.route(input("procedure", "手順タイトル", { procedure: "1. 一つ目\n2. 二つ目", theme: "デプロイ" }));
  assert.equal(proc.status, "appended");
  assert.equal(proc.section, "手順");
  const withProc = await readFile(join(dir, "デプロイ.md"), "utf8");
  assert.match(withProc, /### 手順タイトル <!-- owl:new/u);
  const noSteps = await router.route(input("procedure", "手順なし", { theme: "デプロイ" }));
  assert.equal(noSteps.status, "skill_proposal");
});

test("PageRouter routes an archived page to its merged_into target", async (t) => {
  const { root, router } = await vault(t);
  await router.route(input("fact", "初期化"));
  await addTheme(root, "新しいテーマ");
  await addTheme(root, "古いテーマ", { status: "archived", merged_into: "[[新しいテーマ]]" });
  const result = await router.route(input("decision", "古い名前で来た決まりごと", { theme: "古いテーマ" }));
  assert.equal(result.status, "appended");
  assert.match(result.page, /新しいテーマ/u);
  assert.equal(result.section, "決まりごと");
});

test("PageRouter adds no line when the same lesson is reprocessed, only the source Work number", async (t) => {
  const { root, router } = await vault(t);
  await router.route(input("fact", "初期化"));
  await addTheme(root, "ビルド");
  const base = input("decision", "同じ決まりごと", { theme: "ビルド" });
  const a = await router.route(base);
  const b = await router.route(base);
  const c = await router.route({ ...base, source: source(820) });
  assert.equal(a.status, "appended");
  assert.equal(b.status, "duplicate");
  assert.equal(c.status, "duplicate");
  const page = parsePage(await readFile(join(await projectDir(root), "ビルド.md"), "utf8"));
  const lines = sectionLines(page, "決まりごと").filter((line) => line.includes("同じ決まりごと"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /（W815, W820）/u);
});

test("PageRouter keeps every line when appends to one page run in parallel", async (t) => {
  const { root, router } = await vault(t);
  await router.route(input("fact", "初期化"));
  await addTheme(root, "並列");
  await Promise.all(Array.from({ length: 8 }, (_, i) => router.route(input("pitfall", `並列の罠 ${i}`, { theme: "並列" }))));
  const page = parsePage(await readFile(join(await projectDir(root), "並列.md"), "utf8"));
  assert.equal(sectionLines(page, "落とし穴").filter((line) => line.includes("並列の罠")).length, 8);
});

test("PageRouter defers instead of throwing when the vault is unavailable", async (t) => {
  const root = await tempDir(t, "owl-page-router-");
  const router = new PageRouter({
    knowledgeDir: () => root, now: NOW,
    withWrite: async () => { throw Object.assign(new Error("down"), { code: STORAGE_UNAVAILABLE_CODE }); },
  });
  const result = await router.route(input("fact", "x"));
  assert.equal(result.status, "deferred");
});

async function pipelineFixture(t, { enabled = true } = {}) {
  const { root: parent, db } = await openTestDatabase(t, { prefix: "owl-pages-pipeline-" });
  const root = join(parent, "vault");
  await mkdir(root);
  const writeLane = db.createWriteLane();
  const now = new Date().toISOString();
  const workId = createUlid();
  await writeLane.transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json, verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, 'owner:default', 'Demo', ?, 'main', '[]', '{}', '[]', ?, ?)`,
      PROJECT_ID, join(parent, "repo"), now, now,
    );
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, display_number, created_at, updated_at)
       VALUES (?, 'owner:default', ?, 'ページ保存の確認', '一行目の要約', 'normal', 'completed', '[]', '[]', 815, ?, ?)`,
      workId, PROJECT_ID, now, now,
    );
  });
  let available = true;
  let logAvailable = true;
  const withWrite = async (fn) => {
    if (!available) throw Object.assign(new Error("vault offline"), { code: STORAGE_UNAVAILABLE_CODE });
    return fn();
  };
  const store = { knowledgeDir: () => root, withWrite };
  const legacyNotes = { merges: 0, async list() { return []; }, async mergeClaim() { this.merges += 1; return { note_id: "n", created: true, added: true }; } };
  const skillBox = { proposals: [], async insertProposals(_run, _work, _project, proposals) { this.proposals.push(...proposals); return proposals.map(() => createUlid()); } };
  const ruleProposals = new RuleProposals({ db, writeLane, ruleStore: { rules: { promptRules: [] } } });
  const pipeline = new LearningPipeline({
    db, writeLane, skillBox, notes: legacyNotes, ruleProposals, debounce_ms: 0,
    pages: {
      enabled: () => enabled,
      router: new PageRouter({ ...store, projectName: () => "Demo", now: NOW }),
      workLog: new WorkLogWriter({ ...store, db, withWrite: async (fn) => { if (!logAvailable) throw Object.assign(new Error("vault offline"), { code: STORAGE_UNAVAILABLE_CODE }); return store.withWrite(fn); } }),
    },
  });
  const jobs = new LearningJobs({ db, writeLane });
  return {
    root, db, workId, pipeline, jobs, legacyNotes, skillBox,
    setAvailable(value) { available = value; },
    setLogAvailable(value) { logAvailable = value; },
    row: () => db.get("SELECT * FROM learning_jobs WHERE work_id = ?", workId),
  };
}

const lesson = (kind, text, extra = {}) => ({
  lesson: text, basis: "観察", applies_to: "今後", kind, topic: "build",
  procedure: "1. 確認する\n2. 実行する", rule_text: "確認せずに実行しない", rule_scope: "all", ...extra,
});

test("the learning pipeline in pages mode records routes, writes the destination in the work log, and leaves skill proposals and legacy notes unchanged", async (t) => {
  const f = await pipelineFixture(t);
  await f.jobs.enqueue(f.workId, null, PROJECT_ID, [
    lesson("fact", "ビルドは pnpm build で通る"),
    lesson("pitfall", "オフラインだと install が失敗する", { theme: "存在しないテーマ" }),
    lesson("procedure", "リリース手順"),
  ]);
  await f.pipeline.processPendingNow();
  const row = f.row();
  assert.equal(row.status, "done");
  const result = JSON.parse(row.result_json);
  assert.equal(result.routes.filter((route) => route.status === "appended").length, 2);
  assert.ok(result.routes.some((route) => route.section === "落とし穴" && /その他の注意/u.test(route.page)));
  assert.equal(f.skillBox.proposals.length, 1);
  assert.equal(f.legacyNotes.merges, 0);

  const logDir = join(f.root, "works", (await readdir(join(f.root, "works")))[0]);
  const [name] = await readdir(logDir);
  assert.match(name, /^W815-/u);
  const text = await readFile(join(logDir, name), "utf8");
  assert.match(text, /type: work-log/u);
  assert.match(text, /## 反映先/u);
  assert.match(text, /\[\[projects\/[^\]]+\/その他の注意\]\]/u);
  assert.match(text, /Skill 提案/u);
  const before = text;
  await f.pipeline.processJob(row.id).catch(() => undefined);
  const logs = await readdir(logDir);
  assert.equal(logs.length, 1);
  assert.equal(await readFile(join(logDir, name), "utf8"), before);
});

test("the learning pipeline in pages mode keeps the job pending without attempts, and reconnection processes it", async (t) => {
  const f = await pipelineFixture(t);
  await f.jobs.enqueue(f.workId, null, PROJECT_ID, [lesson("decision", "接続待ちの決まりごと")]);
  f.setAvailable(false);
  await f.pipeline.processPendingNow();
  let row = f.row();
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0);
  assert.equal(row.last_error, STORAGE_UNAVAILABLE_CODE);
  await f.pipeline.processPendingNow();
  assert.equal(f.row().attempts, 0);
  assert.equal(f.row().status, "pending");

  f.setAvailable(true);
  await f.pipeline.processPendingNow();
  row = f.row();
  assert.equal(row.status, "done");
  const [route] = JSON.parse(row.result_json).routes;
  assert.equal(route.status, "appended");
  const dir = await projectDir(f.root);
  assert.match(await readFile(join(dir, "その他の注意.md"), "utf8"), /接続待ちの決まりごと/u);
});

test("the learning pipeline in pages mode keeps the job pending without attempts until the log is written", async (t) => {
  const f = await pipelineFixture(t);
  await f.jobs.enqueue(f.workId, null, PROJECT_ID, [lesson("decision", "記録だけ失敗する")]);
  f.setLogAvailable(false);
  await f.pipeline.processPendingNow();
  assert.equal(f.row().status, "pending");
  assert.equal(f.row().attempts, 0);
  f.setLogAvailable(true);
  await f.pipeline.processPendingNow();
  assert.equal(f.row().status, "done");
  assert.equal((await readdir(join(f.root, "works", (await readdir(join(f.root, "works")))[0]))).length, 1);
});

test("the Final Manager schema has theme and cross_project only for memory_mode pages and leaves the legacy schema and prompt unchanged", async () => {
  const { managerOutputSchema, buildManagerPrompt } = await import("../../packages/agent-runtime/dist/manager.js");
  const keys = (schema) => Object.keys(schema.properties.verdict.properties.lessons.items.properties);
  const legacy = managerOutputSchema({ mode: "finalize" });
  const pages = managerOutputSchema({ mode: "finalize", memory_mode: "pages" });
  assert.equal(keys(legacy).includes("theme"), false);
  assert.deepEqual(keys(pages).slice(-2), ["theme", "cross_project"]);
  const request = { work: { id: "w", title: "t" }, mode: "finalize", context: {} };
  assert.equal(buildManagerPrompt(request, "en").includes("cross_project"), false);
  assert.equal(buildManagerPrompt({ ...request, memory_mode: "pages" }, "en").includes("cross_project"), true);
});
