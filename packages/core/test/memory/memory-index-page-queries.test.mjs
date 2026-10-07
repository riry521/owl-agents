import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { MemoryIndex } from "../../dist/memory/memory-index.js";

/** `suffix` replaces the last character of the id, so copies of one fixture do not collide on id. */
const fixture = (kind, suffix) => {
  const text = readFileSync(new URL(`./fixtures/pages/${kind}.md`, import.meta.url), "utf8");
  return suffix ? text.replace(/^(id: \w{25})\w$/mu, `$1${suffix}`) : text;
};
const PROJECT_ID = /^project_id: (\w+)$/mu.exec(fixture("theme"))[1];

test("page queries: project pages, themes by title, pending integration, optional links, stats", async () => {
  const root = mkdtempSync(join(tmpdir(), "owl-memory-page-queries-"));
  const vault = join(root, "vault");
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const write = (rel, text) => {
    mkdirSync(dirname(join(vault, rel)), { recursive: true });
    writeFileSync(join(vault, rel), text);
  };
  write("projects/p/テスト.md", fixture("theme"));
  write("projects/p/_index.md", fixture("project-index"));
  write("projects/p/未統合.md", fixture("theme", "B").replace(/^integrated_hash: .*$/mu, "integrated_hash:").replace(/^title: .*$/mu, "title: 未統合のテーマ"));
  write("common/共通.md", fixture("theme", "C")
    .replace(/^scope: .*$/mu, "scope: common")
    .replace(/^project_id: .*\n/mu, "")
    .replace(/^title: .*$/mu, "title: 共通のテーマ")
    .replace(/^updated: .*$/mu, `updated: 2026-10-03\nrelated_projects: [${PROJECT_ID}]`));
  write("works/2026-10/W815-a.md", fixture("work-log"));
  write("research/clip.md", fixture("clipping").replace(/\n$/u, "") + " [[どこにもない資料]]\n");
  write("notes/x.md", "---\ntitle: x\ntype: lesson\nsummary: s\nstatus: active\n---\n本文 [[どこにもない]]\n");
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const index = new MemoryIndex({ dataDir, storage, watch: false });
  await index.start();
  await index.rebuild("manual");
  try {
    assert.deepEqual(index.listPages({ types: ["theme"], scope: "project", project_id: PROJECT_ID }).map((r) => r.path), ["projects/p/テスト.md", "projects/p/未統合.md"]);
    assert.deepEqual(index.listPages({ types: ["theme"], scope: "common", related_to_project: PROJECT_ID }).map((r) => r.title), ["共通のテーマ"]);
    assert.deepEqual(index.listPages({ types: ["theme"], scope: "common", related_to_project: "other" }), []);
    assert.equal(index.getProjectIndex(PROJECT_ID)?.page_type, "project-index");
    assert.equal(index.getProjectIndex(null), null);
    assert.equal(index.findTheme("project", PROJECT_ID, "未統合の テーマ")?.path, "projects/p/未統合.md");
    assert.equal(index.findTheme("common", null, "共通のテーマ")?.path, "common/共通.md");
    assert.equal(index.findTheme("project", PROJECT_ID, "ない"), null);
    assert.equal(index.resolvePageRef("[[未統合]]")?.path, "projects/p/未統合.md");
    assert.equal(index.listPages({ types: ["work-log"] })[0].work_number, 815);
    assert.ok(index.pendingIntegration(10).some((r) => r.path === "projects/p/未統合.md"));
    assert.ok(!index.pendingIntegration(10).some((r) => r.path === "projects/p/テスト.md" && r.integrated_hash === r.body_sha256));
    const unresolved = index.unresolvedLinks().map((l) => l.src);
    assert.ok(unresolved.includes("notes/x.md"));
    assert.ok(!unresolved.includes("research/clip.md"), "clippings have optional links");
    assert.deepEqual(index.unresolvedLinks("notes/x.md"), [{ src: "notes/x.md", raw: "どこにもない" }]);
    const stats = index.pageStats();
    assert.equal(stats.by_type.theme, 3);
    assert.equal(stats.by_type["project-index"], 1);
    assert.ok(stats.pending_integration >= 1);
    assert.equal(stats.unresolved_links, unresolved.length);
  } finally {
    await index.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pageReport lists duplicate filenames even for names like constructor.md and toString.md", async () => {
  const root = mkdtempSync(join(tmpdir(), "owl-memory-dup-names-"));
  const vault = join(root, "vault");
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  for (const [i, rel] of ["a/constructor.md", "b/constructor.md", "a/toString.md", "b/toString.md", "a/__proto__.md", "b/__proto__.md"].entries()) {
    mkdirSync(dirname(join(vault, rel)), { recursive: true });
    writeFileSync(join(vault, rel), fixture("theme", String.fromCharCode(65 + i)));
  }
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const index = new MemoryIndex({ dataDir, storage, watch: false });
  await index.start();
  await index.rebuild("manual");
  try {
    const report = index.pageReport();
    for (const name of ["constructor", "toString", "__proto__"]) assert.equal(report.duplicate_filenames[name]?.length, 2, name);
    assert.equal(index.pageStats().by_type.theme, 6);
  } finally {
    await index.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
