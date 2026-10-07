import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { tempDir } from "../helpers/temp.mjs";
import { KnowledgeBase } from "../../packages/core/dist/knowledge-base.js";
import { MemorySaver } from "../../packages/core/dist/memory-saver.js";
import { ResearchRecorder } from "../../packages/core/dist/research-recorder.js";
import { ProjectOverviewService } from "../../packages/core/dist/project-overview-note.js";
import { PageRouter, STORAGE_UNAVAILABLE_CODE } from "../../packages/core/dist/memory/page-router.js";
import { parsePage, validatePage } from "../../packages/core/dist/memory/page-format.js";

const PROJECT_ID = createUlid();
const NOW = () => new Date("2026-10-03T00:00:00Z");
const passthrough = (fn) => fn();
const sections = (page, heading) => page.sections.find((section) => section.heading === heading)?.lines ?? [];

async function vault(t, withWrite = passthrough) {
  const root = await tempDir(t, "owl-writers-");
  const router = new PageRouter({ knowledgeDir: () => root, withWrite, projectName: () => "Demo", now: NOW });
  return { root, router };
}

async function readThemePage(root, name) {
  const [slug] = await readdir(join(root, "projects"));
  return parsePage(await readFile(join(root, "projects", slug, `${name}.md`), "utf8"));
}

test("saveExplicitMemory files a negative statement as a pitfall and the rest as a decision, and uses common/ when there is no Project", async (t) => {
  const { root, router } = await vault(t);
  const saver = new MemorySaver(new KnowledgeBase(root), () => "ja", undefined, { enabled: () => true, router });
  const pitfall = await saver.saveExplicitMemory("本番の data/ には直接書き込まない", [], PROJECT_ID);
  const decision = await saver.saveExplicitMemory("ビルドは pnpm build を使う", [], PROJECT_ID);
  const common = await saver.saveExplicitMemory("返信は日本語にする");
  assert.match(pitfall, /^projects\/.+\/その他の注意\.md$/u);
  const page = await readThemePage(root, "その他の注意");
  assert.ok(sections(page, "落とし穴").some((line) => line.includes("本番の data/ には直接書き込まない")));
  assert.ok(sections(page, "決まりごと").some((line) => line.includes("pnpm build を使う")));
  assert.ok(!("type" in page.frontmatter && page.frontmatter.type === "lesson"));
  assert.equal(validatePage(page, { writer: "owl" }).ok, true);
  assert.equal(decision, pitfall);
  assert.equal(common, "common/その他の注意.md");
  const commonPage = parsePage(await readFile(join(root, common), "utf8"));
  assert.ok(sections(commonPage, "決まりごと").some((line) => line.includes("返信は日本語にする")));
});

test("saveExplicitMemory throws storage_unavailable when the vault is not connected", async (t) => {
  const { root, router: _ } = await vault(t);
  const router = new PageRouter({
    knowledgeDir: () => root,
    withWrite: async () => { throw Object.assign(new Error("unavailable"), { code: STORAGE_UNAVAILABLE_CODE }); },
  });
  const saver = new MemorySaver(new KnowledgeBase(root), () => "ja", undefined, { enabled: () => true, router });
  await assert.rejects(() => saver.saveExplicitMemory("何かを覚える", []), (error) => error.code === "storage_unavailable");
});

test("saveExplicitMemory saves to the conversation Project when no project_id is given", async (t) => {
  const { root, router } = await vault(t);
  const saver = new MemorySaver(new KnowledgeBase(root), () => "ja", undefined, { enabled: () => true, router, conversationProject: () => PROJECT_ID });
  assert.match(await saver.saveExplicitMemory("ビルドは pnpm build を使う"), /^projects\/.+\/その他の注意\.md$/u);
});

const FILES = ["README.md", "package.json", "src/index.ts"];
const reader = {
  listFiles: async () => FILES,
  readFile: async (_repo, _ref, path) => (path === "package.json" ? JSON.stringify({ scripts: { build: "tsc", test: "node --test" } }) : "# Demo\n\nこれはデモ用のツールで、設定を読み込んで画面に表示します。\n"),
  changedPaths: async () => [],
};
const investigation = (purpose) => ({
  ok: true,
  investigation: {
    purpose: { text: purpose, evidence_paths: ["README.md"] },
    architecture_flow: { text: "入口の src/index.ts から設定を読み込んで画面に渡す。", evidence_paths: ["src/index.ts"] },
    entry_points: { text: "起動は src/index.ts から始まる。", evidence_paths: ["src/index.ts"] },
    run_and_test: { text: "pnpm build で作り、pnpm test で確かめる。", evidence_paths: ["package.json"] },
    cautions: [{ text: "設定ファイルの形を変えると画面が空になるので気をつける。", evidence_paths: ["src/index.ts"] }],
  },
});

function overviewService(router, purpose, enabled = true) {
  const notes = { upsertFixedFile: async () => { throw new Error("legacy note must not be written in pages mode"); } };
  return new ProjectOverviewService({
    notes,
    withWrite: passthrough,
    getProject: () => ({ id: PROJECT_ID, name: "Demo", canonical_path: "/tmp/demo", base_branch: "main", verification_plan_json: null }),
    reader,
    investigate: async () => investigation(purpose),
    now: () => "2026-10-03T00:00:00.000Z",
    pages: { enabled: () => enabled, router },
  });
}

test("ProjectOverviewService writes the overview, procedure and pitfall sections of the project structure page and replaces its investigation lines", async (t) => {
  const { root, router } = await vault(t);
  await router.route({ kind: "pitfall", text: "手で足した注意", project_id: PROJECT_ID, theme: "プロジェクトの構成", source: { work_number: 1, work_id: null, actor: "x" } });
  const first = await overviewService(router, "デモ用のツールで、設定を読み込んで画面に表示する。").refresh(PROJECT_ID, { kind: "project_created" });
  assert.equal(first, "written");
  let page = await readThemePage(root, "プロジェクトの構成");
  assert.ok(sections(page, "概要").some((line) => line.includes("【目的】") && line.includes("〔調査 2026-10-03")));
  assert.ok(sections(page, "手順").some((line) => line.startsWith("### ")));
  assert.ok(sections(page, "手順").some((line) => /^\d+\. 【主要コマンド】/u.test(line)));
  assert.ok(sections(page, "落とし穴").some((line) => line.includes("設定ファイルの形を変えると")));
  assert.ok(sections(page, "落とし穴").some((line) => line.includes("手で足した注意")));
  assert.equal(validatePage(page, { writer: "owl" }).ok, true);

  const again = await overviewService(router, "新しい目的の説明として、画面に設定を表示する。").refresh(PROJECT_ID, { kind: "manual_investigation" });
  assert.equal(again, "written");
  page = await readThemePage(root, "プロジェクトの構成");
  const purposes = sections(page, "概要").filter((line) => line.includes("【目的】"));
  assert.equal(purposes.length, 1);
  assert.match(purposes[0], /新しい目的の説明/u);
  assert.equal(sections(page, "手順").filter((line) => line.startsWith("### ")).length, 1);
  assert.ok(sections(page, "落とし穴").some((line) => line.includes("手で足した注意")));
  assert.equal(validatePage(page, { writer: "owl" }).ok, true);
});

test("ResearchRecorder saves a clipping with the frontmatter keys and sections of the page format and keeps existing keys on update", async (t) => {
  const root = await tempDir(t, "owl-research-");
  const knowledge = new KnowledgeBase(root);
  await knowledge.ensureDirectories();
  const recorder = new ResearchRecorder({ knowledge, isEnabled: () => true, language: () => "ja", now: NOW });
  const body = "# Guide\n\n## 見出し付きの行\n\n- This is a sufficiently long key point for the research note.\n\nThe reference explains useful behavior for callers.";
  const fetched = await recorder.record(
    { tool: "WebFetch", url: "https://docs.example.test/guide", query: null, prompt: "Explain", title: "Guide", content: body, links: [], http_status: 200, is_error: false },
    { role: "worker", work_id: "work-7", work_title: "Demo" },
  );
  const searched = await recorder.record(
    { tool: "WebSearch", url: null, query: "owl guide", prompt: null, title: "Owl guide", content: "- Search overview provides enough context for readers.", links: [{ title: "Public guide", url: "https://example.test/guide" }], http_status: 200, is_error: false },
    { role: "advisor" },
  );
  for (const result of [fetched, searched]) {
    assert.equal(result.status, "saved");
    const page = parsePage(await readFile(join(knowledge.knowledgeDir, result.path), "utf8"));
    const check = validatePage(page, { writer: "owl" });
    assert.deepEqual(check.errors, []);
    assert.equal(page.kind, "clipping");
    assert.equal(page.frontmatter.retrieved_by, "research-recorder");
    assert.equal(page.frontmatter.retrieved_at, "2026-10-03T00:00:00.000Z");
    for (const key of ["kind", "research_key", "url", "query", "researched_at", "first_researched_at", "agent_role", "work_id", "work_title", "task_id", "conversation_id", "status"]) {
      assert.ok(key in page.frontmatter, `missing ${key}`);
    }
    assert.deepEqual(page.sections.map((section) => section.heading), ["出典", "要点", "関係する Project"]);
  }
  const page = parsePage(await readFile(join(knowledge.knowledgeDir, fetched.path), "utf8"));
  assert.equal(page.frontmatter.source_url, "https://docs.example.test/guide");

  const again = await recorder.record(
    { tool: "WebFetch", url: "https://docs.example.test/guide", query: null, prompt: "Explain", title: "Guide", content: body, links: [], http_status: 200, is_error: false },
    { role: "worker" },
  );
  assert.equal(again.created, false);
  const updated = parsePage(await readFile(join(knowledge.knowledgeDir, fetched.path), "utf8"));
  assert.equal(updated.frontmatter.id, page.frontmatter.id);
  assert.deepEqual(validatePage(updated, { writer: "owl" }).errors, []);
});

test("memory-saver reads no free-text AI output: the fence/brace-hunting extraction is gone", async () => {
  const source = await readFile(new URL("../../packages/core/src/memory-saver.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /parseJsonObject|extractJsonObject|parseExtractionResponse/u);
});
