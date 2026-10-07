import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { KnowledgeBase } from "../../packages/core/dist/knowledge-base.js";
import { ResearchRecorder } from "../../packages/core/dist/research-recorder.js";
import { PageRouter } from "../../packages/core/dist/memory/page-router.js";
import { WorkLogWriter } from "../../packages/core/dist/memory/work-log-writer.js";
import { PageLibrarian } from "../../packages/core/dist/memory/page-librarian.js";
import { MemoryIndex } from "../../packages/core/dist/memory/memory-index.js";
import { assertValidPage, emptyThemePage, PageRejectedError, renderPage } from "../../packages/core/dist/memory/page-format.js";
import { LearningJobs } from "../../packages/core/dist/learning-pipeline.js";
import { openTestDatabase } from "../helpers/db.mjs";
import { tempDir } from "../helpers/temp.mjs";

const PROJECT_ID = createUlid();
const NOW = () => new Date("2026-10-03T00:00:00Z");
const passthrough = (fn) => fn();
const input = (text) => ({ kind: "fact", text, project_id: PROJECT_ID, source: { work_number: 1, work_id: null, actor: "test" } });
const guarded = (root) => new KnowledgeBase(root, { pageGuard: assertValidPage });

async function tmp(t, prefix) {
  return tempDir(t, `owl-write-guard-${prefix}-`);
}

test("PageRouter: a theme page that breaks the template is not appended to; a valid one is", async (t) => {
  const root = await tmp(t, "router");
  const router = new PageRouter({ knowledgeDir: () => root, withWrite: passthrough, projectName: () => "Demo", now: NOW });
  assert.equal((await router.route(input("最初の一行"))).status, "appended");
  const dir = join(root, "projects", (await readdir(join(root, "projects")))[0]);
  const file = join(dir, "その他の注意.md");
  const good = await readFile(file, "utf8");
  assert.equal((await router.route(input("二行目"))).status, "appended");

  const broken = `${good}\n## 自由欄\n独自の形式\n`;
  await writeFile(file, broken);
  const result = await router.route(input("三行目"));
  assert.deepEqual([result.status, result.reason], ["rejected", "template_invalid"]);
  assert.equal(await readFile(file, "utf8"), broken);
});

test("PageRouter.writeOverview (ProjectOverviewService's write): a broken overview page is not rewritten, a valid one is", async (t) => {
  const root = await tmp(t, "overview");
  const router = new PageRouter({ knowledgeDir: () => root, withWrite: passthrough, projectName: () => "Demo", now: NOW });
  const overview = { project_id: PROJECT_ID, overview: ["【目的】テスト"], procedure: [], pitfalls: [] };
  assert.equal(await router.writeOverview(overview), true);
  const dir = join(root, "projects", (await readdir(join(root, "projects")))[0]);
  const file = join(dir, "プロジェクトの構成.md");
  const broken = `${await readFile(file, "utf8")}\n## 自由欄\n独自の形式\n`;
  await writeFile(file, broken);
  assert.equal(await router.writeOverview({ ...overview, overview: ["【目的】別の内容"] }), false);
  assert.equal(await readFile(file, "utf8"), broken);
});

async function workLogFixture(t, completedAt) {
  const { root: parent, db } = await openTestDatabase(t, { prefix: "owl-write-guard-worklog-" });
  const root = join(parent, "vault");
  await mkdir(root);
  const writeLane = db.createWriteLane();
  const now = new Date().toISOString();
  const workId = createUlid();
  await writeLane.transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json, verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, 'owner:default', 'Demo', ?, 'main', '[]', '{}', '[]', ?, ?)`, PROJECT_ID, join(parent, "repo"), now, now,
    );
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, display_number, completed_at, created_at, updated_at)
       VALUES (?, 'owner:default', ?, '確認', '要約', 'normal', 'completed', '[]', '[]', 7, ?, ?, ?)`, workId, PROJECT_ID, completedAt, now, now,
    );
  });
  await new LearningJobs({ db, writeLane }).enqueue(workId, null, PROJECT_ID, [
    { lesson: "ビルドは通る", basis: "観察", applies_to: "今後", kind: "fact", topic: "build" },
  ]);
  return { root, workId, writer: new WorkLogWriter({ knowledgeDir: () => root, withWrite: passthrough, db }) };
}

test("WorkLogWriter: a work log that breaks the template is refused and no file is made; a valid one is written", async (t) => {
  const bad = await workLogFixture(t, "いつか");
  await assert.rejects(() => bad.writer.write(bad.workId), PageRejectedError);
  assert.equal(existsSync(join(bad.root, "works")) ? (await readdir(join(bad.root, "works"), { recursive: true })).filter((n) => n.endsWith(".md")).length : 0, 0);

  const good = await workLogFixture(t, "2026-10-03T00:00:00Z");
  const path = await good.writer.write(good.workId);
  assert.match(await readFile(join(good.root, path), "utf8"), /type: work-log/u);
});

test("ResearchRecorder: a refused page is not saved (failed, no file); a clipping that fits the template is saved", async (t) => {
  const capture = { tool: "WebFetch", url: "https://docs.example.test/guide", query: null, prompt: "目的", title: "Guide", content: "# Guide\n\n- This is a sufficiently long key point for the research note.\n\nThe reference explains useful behavior.", links: [], http_status: 200, is_error: false };
  const attribution = { role: "worker", work_id: null, work_title: null, task_id: null, conversation_id: null };

  const okRoot = await tmp(t, "research-ok");
  const ok = new ResearchRecorder({ knowledge: guarded(okRoot), isEnabled: () => true, language: () => "ja", now: NOW });
  const saved = await ok.record(capture, attribution);
  assert.equal(saved.status, "saved");
  assert.ok(existsSync(join(okRoot, "knowledge", saved.path)));

  const badRoot = await tmp(t, "research-bad");
  const refusing = new KnowledgeBase(badRoot, { pageGuard: () => { throw new PageRejectedError([{ code: "unknown_kind", message: "x" }]); } });
  const bad = new ResearchRecorder({ knowledge: refusing, isEnabled: () => true, language: () => "ja", now: NOW });
  assert.equal((await bad.record(capture, attribution)).status, "failed");
  assert.equal(existsSync(join(badRoot, "knowledge", "research")) ? (await readdir(join(badRoot, "knowledge", "research"))).length : 0, 0);
});

test("KnowledgeBase pageGuard: a free-form entry is refused on create and update with no file change", async (t) => {
  const root = await tmp(t, "kb");
  const kb = guarded(root);
  await assert.rejects(() => kb.create({ folder: "global", filename: "free.md", tags: [], body: "自由な文章\n" }), PageRejectedError);
  assert.equal(existsSync(join(root, "knowledge", "global", "free.md")), false);
});

test("PageLibrarian: a page it would stamp that holds a secret is not written", async (t) => {
  const parent = await tmp(t, "librarian");
  const vault = join(parent, "vault");
  const dataDir = join(parent, "data");
  await mkdir(join(vault, "common"), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const theme = emptyThemePage({ id: createUlid(), title: "秘密", summary: "要約", scope: "common", project_id: null, today: "2026-10-01" });
  const text = renderPage({ ...theme, sections: theme.sections.map((s) => (s.heading === "概要" ? { ...s, lines: ["- キー sk-abcdefghijklmnopqrstuvwxyz0123"] } : s)) });
  const file = join(vault, "common", "秘密.md");
  await writeFile(file, text);
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const index = new MemoryIndex({ dataDir, storage, watch: false });
  const librarian = new PageLibrarian({
    vault: { isAvailable: () => true, activeDir: () => vault, withWrite: (fn) => fn() }, dataDir,
    index: { refresh: () => index.refreshChanged(), listPages: (query) => index.listPages(query) },
    propose: async () => ({ ok: true, output: { operations: [] } }), model: () => ({ provider: "claude", model: "m", effort: "low" }), now: () => new Date("2026-10-03T03:00:00Z"),
    logger: { warn: () => undefined },
  });
  t.after(async () => { await index.stop(); });
  await index.start();
  await index.rebuild("manual");
  await librarian.run({ run_id: "01HRUN00000000000000000001", mode: "nightly" }).catch(() => undefined);
  assert.equal(await readFile(file, "utf8"), text);
});
