import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const repoRoot = process.cwd();
const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

async function setup(t, coreOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "owl-knowledge-automation-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const core = new Core({ db, agentRunner, version: "settings-test", owlRoot: root, ...coreOptions });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { db, root, core };
}

test("knowledge automation defaults are read without creating a settings row", async (t) => {
  const { db, core } = await setup(t);
  const settings = await core.getKnowledgeAutomationSettings();

  assert.deepEqual(settings.librarian_times, ["03:00", "15:00"]);
  assert.equal(settings.research_autosave, true);
  assert.equal(db.get("SELECT key FROM settings WHERE key = 'knowledge_automation'"), undefined);
});

test("knowledge automation settings persist after a stopped Core is recreated", async (t) => {
  const { db, root, core } = await setup(t);
  await core.start();
  const saved = await core.setKnowledgeAutomationSettings({ librarian_times: ["16:00", "08:30"], research_autosave: false });
  await core.stop({ force: true });
  const restarted = new Core({ db, agentRunner, version: "settings-test", owlRoot: root });
  t.after(() => restarted.stop({ force: true }));

  const loaded = await restarted.getKnowledgeAutomationSettings();

  assert.deepEqual(saved.librarian_times, ["08:30", "16:00"]);
  assert.deepEqual(loaded.librarian_times, ["08:30", "16:00"]);
  assert.equal(loaded.research_autosave, false);
  assert.equal(db.get("SELECT owner_id FROM settings WHERE key = 'knowledge_automation'").owner_id, "owner:default");
  assert.equal(db.get("SELECT type FROM events WHERE type = 'settings.knowledge_automation_updated'").type, "settings.knowledge_automation_updated");
});

test("invalid knowledge automation settings raise a core validation error", async (t) => {
  const { core, db } = await setup(t);

  await assert.rejects(
    core.setKnowledgeAutomationSettings({ librarian_times: ["9:00"], research_autosave: false }),
    (error) => error.code === "validation_error" && error.details.field === "librarian_times",
  );
  assert.equal(db.get("SELECT key FROM settings WHERE key = 'knowledge_automation'"), undefined);
});

test("learning a note does not trigger Librarian runs", async (t) => {
  // The retired note-change timer used this debounce setting, so keep the
  // regression check short while still waiting past its configured delay.
  const { db, core } = await setup(t, { skillCuratorDebounceMs: 20 });
  let runs = 0;
  core.librarian.run = async () => { runs += 1; };

  await core.start();
  assert.equal(runs, 0);
  const workId = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      "INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)",
      now,
      now,
    );
    transaction.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:default', NULL, 'Learning fixture', 'x', 'normal', 'completed', '[]', '[]', ?, ?)`,
      workId,
      now,
      now,
    );
  });
  await core.learningJobs.enqueue(workId, null, null, [{
    lesson: "A fact learned from a completed Work.",
    basis: "Observed in this Work",
    applies_to: "future Work",
    kind: "fact",
    topic: "learning pipeline regression",
    procedure: "",
    rule_text: "",
    rule_scope: "all",
  }]);
  await core.learningPipeline.requestRun();
  const job = db.get("SELECT status, result_json FROM learning_jobs WHERE work_id = ?", workId);
  assert.equal(job.status, "done");
  assert.ok(JSON.parse(job.result_json).note_ids.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(runs, 0);
});
