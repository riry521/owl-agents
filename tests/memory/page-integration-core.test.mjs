import assert from "node:assert/strict";
import { test } from "node:test";

import { createTestCore } from "../helpers/core.mjs";

const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
  runPageIntegration: async () => ({ ok: false, error: "unused" }),
};

async function setup(t, mode) {
  const { core, db } = await createTestCore(t, { agentRunner }, { prefix: "owl-page-integration-core-", start: true });
  if (mode) {
    await db.createWriteLane().transact((tx) => {
      const now = new Date().toISOString();
      tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
      tx.run(
        "INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('memory_mode', 'owner:default', '1.0.0', ?, ?)",
        JSON.stringify(mode), now,
      );
    });
  }
  return { core, db };
}

const manual = { mode: "manual", trigger: "manual_api", actor: "owner" };

test("a manual page integration is recorded as a librarian run and found by its run id", async (t) => {
  const { core } = await setup(t, "pages");
  const run = await core.integrateMemoryPages(manual);
  assert.equal(run.status, "succeeded");
  const stored = core.getCurationRun(run.id);
  assert.equal(stored.kind, "librarian");
  assert.equal(stored.report.run_id, run.id);
  assert.deepEqual(stored.report.pages, []);
  assert.equal(stored.report.skipped, undefined);
});

test("a run is recorded as skipped while a retag is running", async (t) => {
  const { core } = await setup(t, "pages");
  core.retagRunning = true;
  const run = await core.integrateMemoryPages(manual);
  core.retagRunning = false;
  const stored = core.getCurationRun(run.id);
  assert.equal(stored.report.skipped, "retag_running");
  assert.match(stored.summary, /skipped: retag_running/u);
});

test("a manual run is recorded as skipped while another librarian run is active; nightly queues behind it", async (t) => {
  const { core } = await setup(t, "pages");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const realRun = core.pageLibrarian.run.bind(core.pageLibrarian);
  core.pageLibrarian.run = async (...args) => { await gate; return realRun(...args); };
  const running = core.runCuration({ kind: "librarian", trigger: "scheduled", actor: "system" });
  const skipped = await core.integrateMemoryPages(manual);
  assert.equal(core.getCurationRun(skipped.id).report.skipped, "librarian_running");
  const nightly = core.integrateMemoryPages({ mode: "nightly", trigger: "scheduled", actor: "system" });
  release();
  const first = await running;
  const second = await nightly;
  assert.equal(first.status, "succeeded");
  assert.equal(core.getCurationRun(second.id).report.skipped, undefined);
  assert.equal(core.getCurationRun(second.id).report.mode, "nightly");
});
