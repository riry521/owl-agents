import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { DEFAULT_MEMORY_FOLDER_KINDS, DEFAULT_MEMORY_MODE, readMemoryFolderKinds, readMemoryMode, validateMemoryFolderKinds } from "@owl/shared";
import { MemoryIndex, MEMORY_INDEX_FILE, MEMORY_INDEX_SCHEMA_VERSION } from "../../dist/memory/memory-index.js";
import { bodySha256 } from "../../dist/memory/page-format.js";

/** `suffix` replaces the last character of the id, so copies of one fixture do not collide on id. */
const fixture = (kind, suffix) => {
  const text = readFileSync(new URL(`./fixtures/pages/${kind}.md`, import.meta.url), "utf8");
  return suffix ? text.replace(/^(id: \w{25})\w$/mu, `$1${suffix}`) : text;
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), "owl-memory-pages-"));
  const vault = join(root, "vault");
  const dataDir = join(root, "data");
  mkdirSync(vault, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const storage = {
    isAvailable: () => true,
    activeDir: () => vault,
    withRead: async (op) => op(),
    status: () => ({ available: true, dir: vault, since: null }),
  };
  const write = (rel, text) => {
    mkdirSync(dirname(join(vault, rel)), { recursive: true });
    writeFileSync(join(vault, rel), text);
  };
  const make = (opts = {}) => new MemoryIndex({ dataDir, storage, watch: false, ...opts });
  return { root, vault, dataDir, write, make, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("schema version is 2", () => assert.equal(MEMORY_INDEX_SCHEMA_VERSION, 2));

test("an index of the old schema version is set aside and rebuilt", async () => {
  const t = setup();
  try {
    const old = new Database(join(t.dataDir, MEMORY_INDEX_FILE));
    old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '1'); CREATE TABLE notes (rowid INTEGER PRIMARY KEY, path TEXT);");
    old.close();
    t.write("notes/plain.md", "---\ntitle: 平文\n---\n本文\n");
    const index = t.make();
    await index.start();
    await index.rebuild("manual");
    try {
      assert.ok(readdirSync(t.dataDir).some((f) => f.includes(".corrupt-")));
      assert.equal(index.pageReport().by_page_type.legacy, 1);
    } finally { await index.stop(); }
  } finally { t.cleanup(); }
});

test("a mixed vault is counted per type; themes carry body_sha256 and integrated_hash", async () => {
  const t = setup();
  try {
    t.write("projects/kotori-kakeibo/テストの落とし穴.md", fixture("theme"));
    t.write("projects/kotori-kakeibo/_index.md", fixture("project-index"));
    t.write("works/2026-10/W815-月末テストの修正.md", fixture("work-log"));
    t.write("research/2026-10-01-日付ライブラリの比較.md", fixture("clipping"));
    // Old files without a template type are legacy; folders do not decide.
    t.write("research/old-clip.md", "---\nkind: research\nurl: https://example.com/old\n---\n古い資料\n");
    t.write("advisor/2026-10-01-session.md", "古い圧縮要約\n");
    t.write("works/old-work.md", "---\ntitle: 古い Work\n---\n古い記録\n");
    t.write("notes/plain.md", "---\ntitle: 平文\n---\n本文\n");
    t.write("archive/legacy/テストの落とし穴.md", fixture("theme", "B"));
    const index = t.make();
    await index.start();
    await index.rebuild("manual");
    try {
      assert.deepEqual(index.pageReport().by_page_type, { theme: 1, "project-index": 1, "work-log": 1, clipping: 1, legacy: 4, archive: 1 });
      const theme = index.getPageColumns("projects/kotori-kakeibo/テストの落とし穴.md");
      assert.equal(theme.page_type, "theme");
      assert.equal(theme.page_type_source, "frontmatter");
      assert.equal(theme.body_sha256, bodySha256(fixture("theme")));
      assert.match(theme.integrated_hash, /^[0-9a-f]{64}$/u);
      assert.equal(theme.integrated_at, "2026-10-03T02:10:00Z");
      assert.equal(theme.template_valid, 1);
      assert.equal(theme.valid, true);
      for (const old of ["research/old-clip.md", "advisor/2026-10-01-session.md", "works/old-work.md"]) assert.equal(index.getPageColumns(old).page_type, "legacy");
      assert.equal(index.getPageColumns("works/old-work.md").template_valid, null);
      assert.equal(index.getPageColumns("notes/plain.md").page_type, "legacy");
    } finally { await index.stop(); }
  } finally { t.cleanup(); }
});

test("owner hand edits: broken template gives valid=0; secrets, size and duplicate names are reported", async () => {
  const t = setup();
  try {
    const secret = `sk-${"a1B2".repeat(8)}`;
    t.write("projects/p/壊れた.md", fixture("theme", "C").replace("summary: 日付・乱数・並び順に依存して落ちるテストの直し方\n", ""));
    t.write("projects/p/欄なし.md", fixture("theme", "D").replace("## 手順", "## 手順メモ"));
    t.write("projects/p/秘密.md", fixture("theme", "E").replace("テスト用の DB は毎回作り直す", `鍵は ${secret}`));
    t.write("projects/p/大きい.md", fixture("theme", "F").replace("テスト用の DB は毎回作り直す", "あ".repeat(3100)));
    t.write("projects/a/同じ名前.md", fixture("clipping", "G"));
    t.write("projects/b/同じ名前.md", fixture("clipping", "H"));
    const index = t.make();
    await index.start();
    await index.rebuild("manual");
    try {
      const broken = index.getPageColumns("projects/p/壊れた.md");
      assert.equal(broken.valid, false);
      assert.equal(broken.template_valid, 0);
      assert.deepEqual(broken.invalid_reasons, ["template:missing_key:summary"]);
      assert.deepEqual(index.getPageColumns("projects/p/欄なし.md").invalid_reasons, ["template:unexpected_section:手順メモ", "template:missing_section:手順"]);
      assert.equal(index.getPageColumns("projects/p/秘密.md").valid, true);
      const report = index.pageReport();
      const warned = Object.fromEntries(report.template_warnings.map((w) => [w.path, w.warnings]));
      assert.deepEqual(warned["projects/p/秘密.md"], ["secret_pattern"]);
      assert.deepEqual(warned["projects/p/大きい.md"], ["over_budget"]);
      assert.deepEqual(report.duplicate_filenames, { 同じ名前: ["projects/a/同じ名前.md", "projects/b/同じ名前.md"] });
      assert.ok(!JSON.stringify(report).includes(secret));
    } finally { await index.stop(); }
  } finally { t.cleanup(); }
});

test("memory_mode is always pages; memory_folder_kinds validates and falls back", () => {
  assert.equal(DEFAULT_MEMORY_MODE, "pages");
  assert.equal(readMemoryMode(undefined), "pages");
  assert.equal(readMemoryMode("legacy"), "pages");
  assert.equal(readMemoryMode("pages"), "pages");
  assert.deepEqual(DEFAULT_MEMORY_FOLDER_KINDS.rules.map((r) => [r.glob, r.type]), [["research/**", "clipping"], ["works/**", "work-log"]]);
  assert.deepEqual(readMemoryFolderKinds(undefined), DEFAULT_MEMORY_FOLDER_KINDS);
  const warnings = [];
  assert.deepEqual(readMemoryFolderKinds({ version: 2 }, (m) => warnings.push(m)), DEFAULT_MEMORY_FOLDER_KINDS);
  assert.equal(warnings.length, 1);
  assert.throws(() => validateMemoryFolderKinds({ version: 1, rules: [{ glob: "a/**", type: "log" }] }));
  assert.throws(() => validateMemoryFolderKinds({ version: 1, rules: [{ glob: "a/**", type: "theme" }] }));
  assert.deepEqual(validateMemoryFolderKinds({ version: 1, rules: [{ glob: "a/**", type: "clipping", links: "optional" }] }).rules[0], { glob: "a/**", type: "clipping", links: "optional" });
});

test("owner hand edits with a bad project_id give valid=0 on a full rebuild (work-log, theme common, project-index)", async () => {
  const t = setup();
  try {
    const cases = [
      ["works/bad", "work-log", (x, v) => x.replace(/^project_id: .*$/mu, `project_id: ${v}`)],
      ["projects/common-theme", "theme", (x, v) => x.replace("scope: project", "scope: common").replace(/^project_id: .*$/mu, `project_id: ${v}`)],
      ["projects/common-index", "project-index", (x, v) => x.replace("scope: project", "scope: common").replace(/^project_id: .*$/mu, `project_id: ${v}`)],
    ];
    const paths = [];
    let n = 0;
    for (const [dir, kind, edit] of cases) {
      for (const value of ["123", "not-a-ulid", "[abc]"]) {
        const path = `${dir}-${n}.md`;
        t.write(path, edit(fixture(kind, String.fromCharCode(65 + n++)), value));
        paths.push(path);
      }
    }
    const index = t.make();
    await index.start();
    await index.rebuild("manual");
    try {
      for (const path of paths) {
        const columns = index.getPageColumns(path);
        assert.equal(columns.template_valid, 0, path);
        assert.equal(columns.valid, false, path);
        assert.ok(columns.invalid_reasons.includes("template:invalid_value:project_id"), `${path}: ${JSON.stringify(columns.invalid_reasons)}`);
      }
    } finally { await index.stop(); }
  } finally { t.cleanup(); }
});
