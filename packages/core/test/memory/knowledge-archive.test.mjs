import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Core } from "../../dist/index.js";
import { archiveLegacyKnowledge, restoreArchivedKnowledge, ArchiveConflictError } from "../../dist/memory/knowledge-archive.js";
import { openDatabase } from "../../../db/dist/index.js";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const fixture = (kind) => readFileSync(new URL(`./fixtures/pages/${kind}.md`, import.meta.url), "utf8");
const PROJECT = "01HZZZZZZZZZZZZZZZZZZZZZZP";
const ctx = { caller: "owner", agent_run_id: "run-1", work_id: null, task_id: null, project_id: PROJECT };
const LEGACY_MARKER = '{"format":1,"moved_at":"2026-01-01T00:00:00.000Z","move_id":"abc123"}\n';
const DEFAULTS = { dir: "", exclude: [".obsidian"] };
const SECRET = "ユニーク印ZQXJ7731";

/** Every file under dir (relative path -> sha256), skipping the top-level names in `skip`. */
function listing(dir, skip = []) {
  const out = {};
  const visit = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const p = rel === "" ? e.name : `${rel}/${e.name}`;
      if (rel === "" && skip.includes(e.name)) continue;
      if (e.isDirectory()) visit(p);
      else out[p] = createHash("sha256").update(readFileSync(join(dir, p))).digest("hex");
    }
  };
  visit("");
  return out;
}

/** A vault shaped like production, under a temp parent so the default archive dir stays in the temp dir. */
function makeVault() {
  const parent = mkdtempSync(join(tmpdir(), "owl-archive-"));
  const vault = join(parent, "knowledge");
  const put = (rel, data) => { mkdirSync(dirname(join(vault, rel)), { recursive: true }); writeFileSync(join(vault, rel), data); };
  for (const dir of ["advisor", "global", "notes", "policies", "projects", "research", "works"]) put(`${dir}/${dir}-1.md`, `# ${dir}\n本文 ${dir}\n`);
  put("works/2026-10/W1-日報.md", "# 日報\n");
  put("notes/空白 と 日本語.md", Buffer.from([0xff, 0x00, 0x41, 0x0a]));
  put("Home.md", "# Home\n");
  put("hot.md", "# hot\n");
  put(".DS_Store", Buffer.from([0, 0, 0, 1]));
  put(".obsidian/app.json", "{}");
  put(".owl-knowledge", LEGACY_MARKER);
  mkdirSync(join(vault, "projects/empty-dir"), { recursive: true });
  return { parent, vault, archive: `${vault}.archive`, put, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}
const runFiles = (runDir) => listing(join(runDir, "files"));
/** manifest.json's files (relative path + sha256) must equal the original listing; the files on disk are compared separately via runFiles. */
function assertManifest(runDir, expected) {
  const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "complete");
  assert.deepEqual(Object.fromEntries(manifest.files.map((f) => [f.path, f.sha256])), expected);
}

test("archives everything except the marker and excluded entries, byte for byte, then starts an empty pages vault", async () => {
  const v = makeVault();
  try {
    const before = listing(v.vault, [".owl-knowledge", ".obsidian"]);
    const result = await archiveLegacyKnowledge({ root: v.vault, archive: DEFAULTS });
    assert.equal(result.archived, Object.keys(before).length);
    assert.deepEqual(runFiles(result.run_dir), before);
    assertManifest(result.run_dir, before);
    assert.deepEqual(readdirSync(v.vault).sort(), [".obsidian", ".owl-knowledge"]);
    const marker = JSON.parse(readFileSync(join(v.vault, ".owl-knowledge"), "utf8"));
    assert.deepEqual(marker, { format: 1, moved_at: "2026-01-01T00:00:00.000Z", move_id: "abc123", layout: "pages-v1" });
    assert.ok(relative(v.vault, v.archive).startsWith(".."), "default archive is outside the vault");
    // Second call: marker says pages, nothing more moves.
    v.put("notes/new.md", "new");
    assert.equal((await archiveLegacyKnowledge({ root: v.vault, archive: DEFAULTS })).archived, 0);
    assert.ok(existsSync(join(v.vault, "notes/new.md")));
  } finally { v.cleanup(); }
});

test("archive then restore round-trips the listing, keeps the archive, and stops on a path conflict", async () => {
  const v = makeVault();
  try {
    const before = listing(v.vault, [".obsidian"]);
    const { run_dir } = await archiveLegacyKnowledge({ root: v.vault, archive: DEFAULTS });
    const archived = runFiles(run_dir);

    v.put("notes/notes-1.md", "different");
    const vaultBefore = listing(v.vault);
    await assert.rejects(restoreArchivedKnowledge({ root: v.vault, archive: DEFAULTS }), ArchiveConflictError);
    assert.deepEqual(listing(v.vault), vaultBefore);
    assert.deepEqual(runFiles(run_dir), archived);
    rmSync(join(v.vault, "notes/notes-1.md"));

    const restored = await restoreArchivedKnowledge({ root: v.vault, archive: DEFAULTS });
    assert.equal(restored.restored, Object.keys(archived).length);
    assert.deepEqual(listing(v.vault, [".obsidian"]), before);
    assert.deepEqual(runFiles(run_dir), archived, "archive files stay");
    assert.ok(existsSync(join(v.vault, "projects/empty-dir")));
  } finally { v.cleanup(); }
});

for (const crossVolume of [false, true]) {
  test(`a move that fails midway (${crossVolume ? "copy across volumes" : "rename"}) loses nothing, and the next run finishes it`, async () => {
    const { rename: realRename } = await import("node:fs/promises");
    const v = makeVault();
    try {
      const all = listing(v.vault, [".owl-knowledge", ".obsidian"]);
      let n = 0;
      const failing = (a, b) => {
        if (a.endsWith(".part")) return realRename(a, b);
        if (++n === 5) throw new Error("boom");
        if (crossVolume) { const e = new Error("xdev"); e.code = "EXDEV"; throw e; }
        return realRename(a, b);
      };
      await assert.rejects(archiveLegacyKnowledge({ root: v.vault, archive: DEFAULTS, rename: failing }), /boom/u);
      const run = join(v.archive, readdirSync(v.archive)[0]);
      const here = { ...listing(v.vault, [".owl-knowledge", ".obsidian"]), ...runFiles(run) };
      assert.deepEqual(here, all, "every file is in the vault or the archive with the same content");
      assert.equal(JSON.parse(readFileSync(join(v.vault, ".owl-knowledge"), "utf8")).layout, undefined);

      await archiveLegacyKnowledge({ root: v.vault, archive: DEFAULTS });
      assert.deepEqual(runFiles(run), all);
      assert.equal(readdirSync(v.archive).length, 1, "the interrupted run was resumed, not duplicated");
      assert.deepEqual(readdirSync(v.vault).sort(), [".obsidian", ".owl-knowledge"]);
    } finally { v.cleanup(); }
  });
}

// A temp DB and vault; `open()` builds a Core on them, so a second call is a restart.
function coreSetup(v) {
  const dataDir = join(v.parent, "data");
  const open = async (mode, archive, hooks = {}) => {
    const db = openDatabase(join(v.parent, "owl.sqlite"));
    db.migrate(migrations);
    const at = new Date().toISOString();
    await db.createWriteLane().transact((tx) => {
      tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", at, at);
      tx.run(`INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('memory_mode', 'owner:default', '1.0.0', ?, ?)
              ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, JSON.stringify(mode), at);
    });
    if (archive) {
      await db.createWriteLane().transact((tx) => tx.run(`INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('memory_archive', 'owner:default', '1.0.0', ?, ?)
              ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, JSON.stringify(archive), at));
    }
    const core = new Core({ db, agentRunner: {}, version: "t", owlRoot: v.parent, dataDir, ...(hooks.now ? { now: hooks.now } : {}) });
    const close = async () => { await core.stop({ force: true }); db.close(); };
    hooks.beforeStart?.(core);
    try { await core.start(); } catch (error) { try { await hooks.afterFail?.(core); } finally { await close(); } throw error; }
    return { core, db, close };
  };
  return { open };
}

/** A Core that indexes the old files and does not archive them, standing for a vault the archive has not reached yet. */
const openBeforeArchive = (v) => coreSetup(v).open("pages", undefined, { beforeStart: (core) => { core.archiveLegacyKnowledgeOnFirstOpen = async () => {}; } });

test("Core archives once on the first pages start; a page made afterwards survives a restart and the archive does not grow", async () => {
  const v = makeVault();
  try {
    const before = listing(v.vault, [".owl-knowledge", ".obsidian"]);
    const first = await coreSetup(v).open("pages");
    for (const path of Object.keys(before)) assert.equal(existsSync(join(v.vault, path)), false, path);
    const run = join(v.archive, readdirSync(v.archive)[0]);
    assert.deepEqual(runFiles(run), before);

    const page = "common/新しいテーマ.md";
    mkdirSync(join(v.vault, "common"), { recursive: true });
    writeFileSync(join(v.vault, page), fixture("theme").replace("scope: project", "scope: common").replace(/^project_id: .*\n/mu, ""));
    await first.core.memory.reindex({ mode: "diff" });
    await first.close();

    const second = await coreSetup(v).open("pages");
    assert.ok(existsSync(join(v.vault, page)), "the new page was not moved");
    assert.equal(second.core.memory.index.listPages({ types: ["theme"] }).length, 1);
    assert.equal(readdirSync(v.archive).length, 1);
    assert.deepEqual(runFiles(run), before);
    await second.close();
  } finally { v.cleanup(); }
});

test("archived knowledge disappears from search, the table of contents and the index, including rows indexed before", async () => {
  const v = makeVault();
  try {
    v.put("notes/印のノート.md", `---\nid: 01HZZZZZZZZZZZZZZZZZZZZZZ1\ntype: note\ntitle: ${SECRET}題名\n---\n本文に ${SECRET} を含む\n`);
    const legacy = await openBeforeArchive(v);
    const row = (core) => core.memory.index.db().prepare("SELECT path FROM notes WHERE path LIKE ?").all("notes/印のノート%");
    assert.equal(row(legacy.core).length, 1, "indexed before the archive");
    await legacy.close();

    const pages = await coreSetup(v).open("pages");
    assert.equal(row(pages.core).length, 0);
    const found = await pages.core.memory.search({ query: SECRET }, ctx);
    assert.equal(JSON.stringify(found).includes(SECRET), false);
    assert.equal(found.items.length, 0);
    assert.equal(JSON.stringify(await pages.core.memory.readIndex({ project_id: PROJECT }, ctx)).includes(SECRET), false);
    assert.equal(JSON.stringify(await pages.core.memory.recall({ topic: SECRET }, ctx)).includes(SECRET), false);
    assert.equal(pages.core.memory.index.listPages({ types: ["theme", "project-index", "work-log", "clipping"] }).length, 0);
    await pages.close();
  } finally { v.cleanup(); }
});

for (const [name, blocker] of [["a file where a directory goes", "projects/empty-dir"], ["a file where a parent directory goes", "works"], ["a file two levels up", "works/2026-10"]]) {
  test(`restore stops without writing when ${name}`, async () => {
    const v = makeVault();
    try {
      const { run_dir } = await archiveLegacyKnowledge({ root: v.vault, archive: DEFAULTS });
      const archived = runFiles(run_dir);
      v.put(blocker, "in the way");
      const vaultBefore = listing(v.vault);
      const dirsBefore = readdirSync(v.vault, { recursive: true }).sort();
      await assert.rejects(restoreArchivedKnowledge({ root: v.vault, archive: DEFAULTS }), ArchiveConflictError);
      assert.deepEqual(listing(v.vault), vaultBefore);
      assert.deepEqual(readdirSync(v.vault, { recursive: true }).sort(), dirsBefore, "no directory was created either");
      assert.deepEqual(runFiles(run_dir), archived);
    } finally { v.cleanup(); }
  });
}

/** A valid theme page that mentions SECRET: unlike a type: note file it passes the pages search filter, so only the gate hides it. */
const themePage = () => fixture("theme").replace("# テストの落とし穴", `# テストの落とし穴 ${SECRET}`);
/** What a failed Core must not offer: search, table of contents, page list and saving all stay off, and the vault is not written. */
async function assertPagesOffline(core, v) {
  const vaultBefore = listing(v.vault);
  const found = await core.memory.search({ query: SECRET }, ctx);
  assert.equal(found.items.length, 0);
  assert.equal(JSON.stringify(await core.memory.readIndex({ project_id: PROJECT }, ctx)).includes(SECRET), false);
  assert.equal(JSON.stringify(await core.memory.searchPages({ query: SECRET }, ctx)).includes(SECRET), false);
  await assert.rejects(core.memorySaver.saveExplicitMemory("覚えておく"), /pages_unavailable/u);
  assert.deepEqual(listing(v.vault), vaultBefore, "saving wrote nothing");
}

test("when the archive cannot finish, Core refuses to start pages: nothing is lost and the old files are not searchable", async () => {
  const v = makeVault();
  try {
    v.put("notes/印のノート.md", `---\nid: 01HZZZZZZZZZZZZZZZZZZZZZZ1\ntype: note\ntitle: ${SECRET}題名\n---\n本文に ${SECRET} を含む\n`);
    const before = listing(v.vault, [".owl-knowledge", ".obsidian"]);
    const legacy = await openBeforeArchive(v);
    await legacy.core.memory.reindex({ mode: "full" });
    await legacy.close();
    writeFileSync(join(v.parent, "blocked"), "a file, not a directory");
    await assert.rejects(coreSetup(v).open("pages", { dir: join(v.parent, "blocked", "archive"), exclude: [".obsidian"] }), /could not be archived/u);
    assert.deepEqual(listing(v.vault, [".owl-knowledge", ".obsidian"]), before, "files are still in the vault, unchanged");
    assert.equal(JSON.parse(readFileSync(join(v.vault, ".owl-knowledge"), "utf8")).layout, undefined);
    // The same vault opened by an unblocked Core finishes the archive and shows nothing old.
    const pages = await coreSetup(v).open("pages", { dir: "", exclude: [".obsidian"] });
    for (const path of Object.keys(before)) assert.equal(existsSync(join(v.vault, path)), false, path);
    const found = await pages.core.memory.search({ query: SECRET }, ctx);
    assert.equal(found.items.length, 0);
    await pages.close();
  } finally { v.cleanup(); }
});

test("a move that fails after some files moved: Core refuses to start, every file is in the vault or the archive, and the failed Core shows nothing old", async () => {
  const v = makeVault();
  try {
    v.put("common/テーマ.md", themePage());
    const all = listing(v.vault, [".owl-knowledge", ".obsidian"]);
    const legacy = await openBeforeArchive(v);
    await legacy.core.memory.reindex({ mode: "full" });
    await legacy.close();
    // A fixed clock names the run folder, so a non-empty folder can be put where one file will land: the move of that file fails after the earlier ones moved.
    const at = "2026-10-05T00:00:00.000Z";
    const run = join(v.archive, at.replace(/[:.]/gu, "-"));
    mkdirSync(join(run, "files/notes/notes-1.md"), { recursive: true });
    writeFileSync(join(run, "files/notes/notes-1.md/keep"), "x");
    let seen = null;
    await assert.rejects(coreSetup(v).open("pages", { dir: "", exclude: [".obsidian"] }, {
      now: () => at,
      afterFail: async (core) => { await assertPagesOffline(core, v); seen = true; },
    }), /could not be archived/u);
    assert.equal(seen, true, "the failed Core kept pages offline");
    const inArchive = runFiles(run);
    delete inArchive["notes/notes-1.md/keep"];
    const inVault = listing(v.vault, [".owl-knowledge", ".obsidian"]);
    assert.ok(Object.keys(inArchive).length > 0 && Object.keys(inVault).length > 0, "the move stopped midway");
    assert.deepEqual({ ...inVault, ...inArchive }, all, "same content everywhere");
    assert.equal(JSON.parse(readFileSync(join(v.vault, ".owl-knowledge"), "utf8")).layout, undefined);
  } finally { v.cleanup(); }
});

test("when the first index scan fails, core.start() fails and the failed Core shows nothing old", async () => {
  const v = makeVault();
  try {
    v.put("common/テーマ.md", themePage());
    const legacy = await openBeforeArchive(v);
    await legacy.core.memory.reindex({ mode: "full" });
    await legacy.close();
    let seen = null;
    await assert.rejects(coreSetup(v).open("pages", undefined, {
      beforeStart: (core) => { core.memory.index.scanInto = async () => { throw new Error("scan boom"); }; },
      afterFail: async (core) => { await assertPagesOffline(core, v); seen = true; },
    }), /scan boom/u);
    assert.equal(seen, true);
  } finally { v.cleanup(); }
});

test("Core archives an old-layout vault, and the owner's restore command brings back an identical listing", async () => {
  const v = makeVault();
  try {
    const marker = readFileSync(join(v.vault, ".owl-knowledge"), "utf8");
    const before = listing(v.vault, [".owl-knowledge", ".obsidian"]);
    const core = await coreSetup(v).open("pages");
    await core.close();
    const run_dir = join(v.archive, readdirSync(v.archive)[0]);
    assert.deepEqual(runFiles(run_dir), before);
    assert.deepEqual(readdirSync(v.vault).sort(), [".obsidian", ".owl-knowledge"]);
    const after = JSON.parse(readFileSync(join(v.vault, ".owl-knowledge"), "utf8"));
    assert.equal(after.layout, "pages-v1");
    assert.equal(after.move_id, JSON.parse(marker).move_id);
    assertManifest(run_dir, before);
    const archivedFiles = runFiles(run_dir);
    // The owner's command, in a child process with an empty environment (nothing points at production).
    const script = join(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/memory-restore-archive.mjs");
    const child = spawnSync(process.execPath, [script, "--vault", v.vault], { env: {}, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(listing(v.vault, [".owl-knowledge", ".obsidian"]), before);
    assert.deepEqual(runFiles(run_dir), archivedFiles, "the archive stays");
    assert.equal(readFileSync(join(v.vault, ".owl-knowledge"), "utf8"), marker);
  } finally { v.cleanup(); }
});
