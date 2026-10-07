import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../dist/index.js";
import { LibrarianScheduler } from "../dist/librarian-scheduler.js";
import { MemoryIndex } from "../dist/memory/memory-index.js";
import { PageLibrarian } from "../dist/memory/page-librarian.js";
import { itemsOf } from "../dist/memory/page-operations.js";
import { openDatabase } from "../../db/dist/index.js";

class FakeClock {
  constructor(now) { this.value = new Date(now); this.timers = new Map(); this.nextId = 0; }
  now() { return new Date(this.value); }
  setTimeout(callback, ms) {
    const handle = { id: ++this.nextId, unref: () => undefined };
    this.timers.set(handle, { callback, at: this.value.getTime() + ms });
    return handle;
  }
  clearTimeout(handle) { this.timers.delete(handle); }
  async advanceTo(now) {
    const target = new Date(now).getTime();
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.timers.delete(next[0]);
      this.value = new Date(next[1].at);
      next[1].callback();
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    }
    this.value = new Date(target);
  }
}

/** Waits for the run started by the fake clock to finish its file and database work (not a time wait). */
async function settled(done) {
  for (let i = 0; i < 2000 && !done(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(done(), "the scheduled run finished");
}

const PID = "01HZZZZZZZZZZZZZZZZZZZZZZP";
const NEW = "<!-- owl:new 2026-10-03 W9 -->";
const PAGE = `---\nid: 01HZZZZZZZZZZZZZZZZZZZZZZA\ntype: theme\ntitle: テスト\nsummary: テストの要約\nscope: project\nproject_id: ${PID}\nstatus: active\nintegrated_hash: \nintegrated_at: \ncreated: 2026-09-20\nupdated: 2026-10-01\n---\n# テスト\n\n## 概要\nテストの概要。\n\n## 決まりごと\n（なし）\n\n## 落とし穴\n- 新しい落とし穴（W9） ${NEW}\n\n## 手順\n（なし）\n\n## 関連ページ\n（なし）\n\n## 更新履歴\n- 2026-09-28 W812 新規作成\n`;
const PATH = "projects/kotori/テスト.md";

test("the librarian runs once per librarian_times slot, with no run reserved by an append", async () => {
  const root = mkdtempSync(join(tmpdir(), "owl-librarian-scheduler-"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, dirname(PATH)), { recursive: true });
  writeFileSync(join(vault, PATH), PAGE);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const index = new MemoryIndex({ dataDir, storage, watch: false });
  const clock = new FakeClock(new Date(2026, 9, 5, 22, 0));
  const modes = [];
  let proposals = 0;
  const librarian = new PageLibrarian({
    vault: { isAvailable: () => true, activeDir: () => vault, withWrite: (fn) => fn() },
    dataDir,
    index: { refresh: () => index.refreshChanged(), listPages: (query) => index.listPages(query) },
    propose: async () => {
      proposals += 1;
      const h = itemsOf(readFileSync(join(vault, PATH), "utf8")).find((s) => s.section === "落とし穴").items[0].h;
      return { ok: true, output: { operations: [{ op: "move", item: { page: PATH, section: "落とし穴", h }, to: { page: PATH, section: "落とし穴" } }] } };
    },
    model: () => ({ provider: "claude", model: "m", effort: "low" }),
    workExists: () => true,
    logger: { warn: () => undefined },
  });
  assert.equal(librarian.schedule, undefined);
  assert.equal(librarian.stop, undefined);
  const scheduler = new LibrarianScheduler({
    run: async () => { const report = await librarian.run({ run_id: `01HRUN${String(proposals).padStart(20, "0")}`, mode: "nightly" }); modes.push(report.mode); return report; },
    clock,
    maxTickMs: 60_000,
  });
  try {
    await index.start();
    await index.rebuild("manual");
    scheduler.start(["03:00"]);
    // an append during the day (the file changes) reserves nothing
    writeFileSync(join(vault, PATH), PAGE.replace("（なし）\n\n## 落とし穴", `- 追記（W10） <!-- owl:new 2026-10-05 W10 -->\n\n## 落とし穴`));
    await clock.advanceTo(new Date(2026, 9, 6, 2, 59));
    assert.equal(proposals, 0);
    await clock.advanceTo(new Date(2026, 9, 6, 3, 0));
    await settled(() => modes.length === 1);
    assert.equal(proposals, 1);
    assert.deepEqual(modes, ["nightly"]);
    assert.ok(!readFileSync(join(vault, PATH), "utf8").includes("<!-- owl:new 2026-10-03 W9"));
    await clock.advanceTo(new Date(2026, 9, 6, 23, 0));
    assert.equal(proposals, 1);
    await clock.advanceTo(new Date(2026, 9, 7, 3, 0));
    await settled(() => modes.length === 2);
    assert.equal(proposals, 2);
  } finally {
    await scheduler.stop();
    await index.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

async function setupCore(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-librarian-run-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(fileURLToPath(new URL("../../db/migrations", import.meta.url)));
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root });
  t.after(async () => { await core.stop({ force: true }); db.close(); await rm(root, { recursive: true, force: true }); });
  await core.start();
  await db.createWriteLane().transact((tx) => {
    const now = new Date().toISOString();
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('memory_mode', 'owner:default', '1.0.0', ?, ?)", JSON.stringify("pages"), now);
  });
  return core;
}

test("run_librarian (manual) and the nightly run do the same page run: intake, merge, metabolism and linking in one librarian run", async (t) => {
  const core = await setupCore(t);
  const runs = [];
  core.pageLibrarian.run = async (input) => { runs.push(input.mode); return { run_id: input.run_id, mode: input.mode, pages: [], applied: 0, rejected: [], warnings: [], remaining: 0, llm_calls: 1, input_tokens: 1, backup_dir: null }; };
  const manual = await core.runCuration({ kind: "librarian", trigger: "manual_api", actor: "owner" });
  assert.equal(manual.status, "succeeded");
  const nightly = await core.runCuration({ kind: "librarian", trigger: "scheduled", actor: "system" });
  assert.equal(nightly.status, "succeeded");
  assert.deepEqual(runs, ["manual", "nightly"]);
  assert.equal(core.getCurationRun(manual.id).report.mode, "manual");
  assert.equal(core.getCurationRun(nightly.id).report.mode, "nightly");
});

const reportOf = (input, extra) => ({ run_id: input.run_id, mode: input.mode, pages: [], applied: 0, rejected: [], warnings: [], remaining: 0, llm_calls: 1, input_tokens: 1, backup_dir: null, ...extra });

test("a librarian report with an error, or with remaining items and no organized page, is recorded as failed", async (t) => {
  const core = await setupCore(t);
  const cases = [
    { extra: { error: "propose_failed" }, status: "failed", error: /^propose_failed$/ },
    { extra: { remaining: 3, rejected: [{ index: 0, code: "x" }] }, status: "failed", error: /3.*1/ },
    { extra: { remaining: 3, pages: [{ path: "a.md", action: "updated" }] }, status: "succeeded" },
    { extra: { remaining: 0 }, status: "succeeded" },
    { extra: { remaining: 3, skipped: "retag_running" }, status: "succeeded" },
  ];
  for (const c of cases) {
    core.pageLibrarian.run = async (input) => reportOf(input, c.extra);
    const run = await core.runCuration({ kind: "librarian", trigger: "manual_api", actor: "owner" });
    const stored = core.getCurationRun(run.id);
    assert.equal(stored.status, c.status);
    assert.ok(stored.report, "report is kept");
    if (c.status === "failed") assert.match(stored.error, c.error);
  }
});

test("a failed scheduled librarian run records one system.alert naming the run", async (t) => {
  const core = await setupCore(t);
  core.pageLibrarian.run = async (input) => reportOf(input, { error: "propose_failed" });
  const run = await core.runCuration({ kind: "librarian", trigger: "scheduled", actor: "system" });
  assert.equal(core.getCurationRun(run.id).status, "failed");
  const alerts = () => core.db.all("SELECT payload_json FROM events WHERE type = 'system.alert'").map((r) => JSON.parse(r.payload_json)).filter((p) => p.kind === "curation_run_failed");
  for (let i = 0; i < 200 && alerts().length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].message, new RegExp(`${run.id}.*propose_failed`));
});

test("a scheduled librarian run that throws is recorded as failed with one system.alert", async (t) => {
  const core = await setupCore(t);
  core.pageLibrarian.run = async () => { throw new Error("boom"); };
  const run = await core.runCuration({ kind: "librarian", trigger: "scheduled", actor: "system" });
  const stored = core.getCurationRun(run.id);
  assert.equal(stored.status, "failed");
  assert.equal(stored.error, "boom");
  const alerts = () => core.db.all("SELECT payload_json FROM events WHERE type = 'system.alert'").map((r) => JSON.parse(r.payload_json)).filter((p) => p.kind === "curation_run_failed");
  for (let i = 0; i < 200 && alerts().length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].message, new RegExp(`${run.id}.*boom`));
});
