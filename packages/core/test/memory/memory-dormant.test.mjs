import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Core } from "../../dist/index.js";
import { openDatabase } from "../../../db/dist/index.js";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const fixture = (kind) => readFileSync(new URL(`./fixtures/pages/${kind}.md`, import.meta.url), "utf8");
const PROJECT = "01HZZZZZZZZZZZZZZZZZZZZZZP";
const ctx = { caller: "owner", agent_run_id: "run-1", work_id: null, task_id: null, project_id: PROJECT };
const PATH = "common/休眠候補.md";
const clock = { now: new Date("2026-10-05T00:00:00Z") };

// A temp OWL_DATA_DIR and DB; `open()` builds a Core on them, so a second call is a restart.
function setup({ status = "active" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "owl-dormant-"));
  clock.now = new Date("2026-10-05T00:00:00Z");
  mkdirSync(join(root, "knowledge", dirname(PATH)), { recursive: true });
  // The pages-v1 marker keeps the first-open archive from moving this vault.
  writeFileSync(join(root, "knowledge", ".owl-knowledge"), `${JSON.stringify({ format: 1, layout: "pages-v1" })}\n`);
  writeFileSync(join(root, "knowledge", PATH), fixture("theme").replaceAll("テストの落とし穴", "休眠候補").replace("scope: project", "scope: common").replace(/^project_id: .*\n/mu, "").replace("status: active", `status: ${status}`));
  const open = async () => {
    const db = openDatabase(join(root, "owl.db"));
    db.migrate(migrations);
    const core = new Core({ db, agentRunner: {}, version: "t", owlRoot: root, dataDir: join(root, "data"), now: () => clock.now.toISOString() });
    await core.start();
    await core.memory.reindex({ mode: "full" });
    return { core, db, close: async () => { await core.stop({ force: true }); db.close(); } };
  };
  return { root, open, listed: (core) => core.memory.index.listPages({ types: ["theme"] }).map((r) => r.path), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function seed(db, sql, ...params) {
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(sql, ...params);
  });
}
const addWork = (db, id, number, updatedAt) => seed(db,
  `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, display_number, created_at, updated_at)
   VALUES (?, 'owner:default', NULL, 'w', '', 'normal', 'completed', '[]', '[]', ?, ?, ?)`, id, number, updatedAt, updatedAt);
const setDays = (db, days) => seed(db,
  `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('memory_dormant_days', 'owner:default', '1.0.0', ?, ?)
   ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, JSON.stringify(days), new Date().toISOString());

test("the last opened day survives core.stop() and a new Core on the same DB", async () => {
  const t = setup();
  try {
    const first = await t.open();
    assert.equal((await first.core.memory.page({ page: PATH }, ctx)).found, true);
    assert.equal(first.core.memory.index.lastOpened(PATH), "2026-10-05");
    await first.close();
    const second = await t.open();
    assert.equal(second.core.memory.index.lastOpened(PATH), "2026-10-05");
    await second.close();
  } finally { t.cleanup(); }
});

test("dormant candidates follow memory_dormant_days and the source Works' dates", async () => {
  const t = setup();
  const { core, db, close } = await t.open();
  try {
    await addWork(db, "01HZZZZZZZZZZZZZZZZZZZZZW1", 812, "2026-10-03T00:00:00Z");
    await addWork(db, "01HZZZZZZZZZZZZZZZZZZZZZW2", 815, "2026-10-03T00:00:00Z");
    const paths = async () => (await core.memory.dormantCandidates()).map((c) => c.path);
    clock.now = new Date("2027-01-10T00:00:00Z"); // 99 days after everything
    assert.deepEqual(await paths(), [PATH], "default 90 days");
    await setDays(db, 365);
    assert.deepEqual(await paths(), [], "365 days");
    await setDays(db, 30);
    assert.deepEqual(await paths(), [PATH], "30 days");
    // an old page and old last open, but a cited Work was updated recently
    await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET updated_at = '2027-01-05T00:00:00Z' WHERE display_number = 815"));
    assert.deepEqual(await paths(), [], "a source Work is recent");
    await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET updated_at = '2026-10-03T00:00:00Z'"));
    await core.memory.page({ page: PATH }, ctx); // opened on 2027-01-10
    clock.now = new Date("2027-01-20T00:00:00Z");
    assert.deepEqual(await paths(), [], "opened 10 days ago");
  } finally { await close(); t.cleanup(); }
});

test("a dormant page is left out of the index, found by search, and wakes up when opened", async () => {
  const t = setup({ status: "dormant" });
  const { core, close } = await t.open();
  try {
    assert.deepEqual(t.listed(core), []);
    const found = await core.memory.search({ query: "休眠候補", include_raw: true }, ctx);
    assert.ok(found.items.some((i) => i.path === PATH));
    const recalled = await core.memory.recall({ topic: "休眠候補" }, ctx);
    assert.ok(recalled.items.some((i) => i.path === PATH));
    assert.equal((await core.memory.expand({ note: PATH }, ctx)).found, true);
    assert.match(readFileSync(join(t.root, "knowledge", PATH), "utf8"), /^status: active$/mu);
    assert.deepEqual(t.listed(core), [PATH]);
    assert.equal(core.memory.index.lastOpened(PATH), "2026-10-05");
  } finally { await close(); t.cleanup(); }
});
