import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createTaskPlanInTransaction, NoopGitGateway, WorkflowEngine } from "../../packages/core/dist/index.js";
import { reduceTaskInTransaction } from "../../packages/core/dist/state-reducer.js";
import { resolveRoleModel, taskModelRole } from "../../packages/core/dist/workflow-engine.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { DEFAULT_ROLE_MODELS } from "../../packages/shared/dist/default-role-models.js";
import { createTestCore } from "../helpers/core.mjs";
import { withNecessity } from "../helpers/necessity.mjs";
import { waitFor } from "../helpers/wait.mjs";

const NOW = "2026-10-10T00:00:00.000Z";
const setSetting = (tx, key, value) => tx.run(
  `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES (?, 'owner:default', '1.0.0', ?, ?)
   ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, key, JSON.stringify(value), NOW,
);
const envelope = (payload, suffix, expectedVersion = 0) => ({ request_id: createUlid(), idempotency_key: `test:${suffix}:${createUlid()}`, expected_version: expectedVersion, payload });
const rejection = () => {
  const review = { verdict: "fix_required", summary: "Not yet.", findings: [{ severity: "major", pre_existing: false, file: "a.ts", problem: "Wrong.", fix: "Fix." }], tests: {} };
  return { outcome: "failed", report_valid: true, report: { kind: "review", ...review }, review };
};
const workerReport = (invocationId) => ({
  kind: "report", schema_version: "1.0.0", invocation_id: invocationId, result: "success", work_done: "Done.", changes: [],
  verification: { passed: true, method: "Checked." }, remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null,
});
const runs = (db, workId) => db.all("SELECT worker_tier AS tier, model FROM agent_runs WHERE work_id = ? AND role = 'worker' ORDER BY id", workId);

// A real Core whose Reviewer always rejects: the dispatcher remakes the Task until it stops.
class ChangedPathsGit extends NoopGitGateway {
  async changedPaths() {
    return ["out/a.mjs"];
  }
}

async function runRejectedTask(t, { db, owlRoot, settings, modelSettings } = {}) {
  const git = new ChangedPathsGit();
  let replans = 0;
  const agentRunner = withNecessity({
    runManagerPlan: async (request) => (request.mode ?? request.context?.mode) === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{ id: "T1", title: "Code", type: "code", acceptance: "Done; verified by the test.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: true }] } }
      : (replans += 1, { outcome: "failed", message: "no replan" }),
    runWorker: async (request) => {
      await mkdir(join(request.context.worktree, "out"), { recursive: true });
      await writeFile(join(request.context.worktree, "out/a.mjs"), "export const x = 1;\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => rejection(),
    runAdvisor: async () => ({ reply: "" }),
  });
  const built = await createTestCore(t, { agentRunner, git, dispatcher: { tick_interval_ms: 25 }, ...(db ? { db, owlRoot } : {}) }, { prefix: "owl-fixer-e2e-" });
  git.prepareWorktree = async () => ({ ok: true, worktree_path: built.root });
  await built.core.start();
  if (settings) await built.core.setFixerEscalationSettings(settings);
  if (modelSettings) await built.db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", NOW, NOW);
    setSetting(tx, "model_settings", modelSettings);
  });
  const created = await built.core.createWork(envelope({ title: "fixer", summary: "x", size: "normal", project_id: null }, "create"));
  await built.core.startWork(created.data.work_id, envelope({ mode: "normal" }, "start", created.version));
  const workId = created.data.work_id;
  await waitFor(() => replans > 0, { timeoutMs: 20_000, message: "the Task is rejected until the Manager is asked to replan" });
  await built.core.stop({ force: true });
  return { ...built, workId };
}

// Completes a Manager replan of the stopped Task, then launches it again on a new engine; returns the new run.
async function relaunchAfterReplan(t, { db, root, workId }) {
  const task = db.get("SELECT id FROM tasks WHERE work_id = ?", workId);
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    tx.run("UPDATE tasks SET status = 'failed' WHERE id = ?", task.id);
    reduceTaskInTransaction(tx, task.id, { event: "task.replanned", payload: { base_plan_version: 1, current_plan_version: 1, dependencies_completed: true } });
  });
  const engine = new WorkflowEngine({ db, owlRoot: root, dataDir: root, git: new NoopGitGateway(), agentRunner: { runWorker: async () => new Promise(() => {}) } });
  engine.start();
  t.after(() => engine.stop());
  await engine.resolveDependencies(workId);
  assert.equal((await engine.launchReady(workId)).length, 1, JSON.stringify(db.all("SELECT status, review_rejections, fixer_escalated_rejections FROM tasks WHERE work_id = ?", workId)));
  return { engine, run: runs(db, workId).at(-1) };
}

test("the Fixer takes over after the second rejection, stays Fixer after a replan, and the next Task starts as Worker", async (t) => {
  const worker = DEFAULT_ROLE_MODELS.worker.model;
  const fixer = DEFAULT_ROLE_MODELS.fixer.model;
  assert.equal(fixer, "claude-opus-5-5");
  const first = await runRejectedTask(t);
  const { db, workId } = first;
  assert.deepEqual(runs(db, workId), [{ tier: "standard", model: worker }, { tier: "standard", model: worker }, { tier: "fixer", model: fixer }]);
  const { engine, run } = await relaunchAfterReplan(t, first);
  assert.deepEqual(run, { tier: "fixer", model: fixer });
  // The next Task of the same Work is a Worker.
  const next = await db.createWriteLane().transact((tx) => createTaskPlanInTransaction(tx, workId, [{ id: "W2", title: "Next", type: "code", acceptance: "Done", depends_on: [] }])[0]);
  await engine.resolveDependencies(workId);
  assert.equal((await engine.launchReady(workId)).length, 1);
  assert.deepEqual(db.get("SELECT worker_tier AS tier, model FROM agent_runs WHERE task_id = ?", next.id), { tier: "standard", model: worker });
});

test("the rejection count and the Fixer model come from settings, across a Core restart; a missing fixer entry uses the default", async (t) => {
  const worker = DEFAULT_ROLE_MODELS.worker.model;
  const fixer = DEFAULT_ROLE_MODELS.fixer.model;
  const first = await runRejectedTask(t, { settings: { after_review_rejections: 3 } });
  // With the count at 3 the second rejection does not switch; the third one does, so the next run is the Fixer's.
  assert.deepEqual(runs(first.db, first.workId), [{ tier: "standard", model: worker }, { tier: "standard", model: worker }, { tier: "standard", model: worker }]);
  assert.equal(first.db.get("SELECT fixer_escalated_rejections AS f FROM tasks WHERE work_id = ?", first.workId).f, 3);
  // Restart: a new Core on the same DB still reads the saved count and decides from it.
  const restarted = await runRejectedTask(t, { db: first.db, owlRoot: first.root });
  assert.deepEqual(await restarted.core.getFixerEscalationSettings(), { after_review_rejections: 3 });
  assert.equal(restarted.db.get("SELECT fixer_escalated_rejections AS f FROM tasks WHERE work_id = ?", restarted.workId).f, 3);
  assert.deepEqual(runs(restarted.db, restarted.workId), [{ tier: "standard", model: worker }, { tier: "standard", model: worker }, { tier: "standard", model: worker }]);
  // The third rejection switches: after the replan the restarted Core launches the Task as the Fixer.
  const switched = await relaunchAfterReplan(t, restarted);
  assert.deepEqual(switched.run, { tier: "fixer", model: fixer });
  // Changing the Fixer model applies to the next run of a Task that is already the Fixer's.
  const others = Object.entries(DEFAULT_ROLE_MODELS).filter(([role]) => role !== "fixer").map(([role, entry]) => ({ role, ...entry }));
  await restarted.db.createWriteLane().transact((tx) => setSetting(tx, "model_settings", { version: 1, roles: [...others, { role: "fixer", provider: "anthropic", model: "changed-fixer", effort: "high" }] }));
  const changed = await relaunchAfterReplan(t, restarted);
  assert.deepEqual(changed.run, { tier: "fixer", model: "changed-fixer" });
  await restarted.db.createWriteLane().transact((tx) => tx.run("DELETE FROM settings WHERE key = 'model_settings'"));
  const lowered = await runRejectedTask(t, { db: first.db, owlRoot: first.root, settings: { after_review_rejections: 1 } });
  assert.deepEqual(runs(lowered.db, lowered.workId), [{ tier: "standard", model: worker }, { tier: "fixer", model: fixer }, { tier: "fixer", model: fixer }]);
  // A saved model_settings without a fixer entry falls back to the default; a saved one is used.
  // A saved model_settings without a fixer entry falls back to the default; one with a fixer entry is used.
  const withoutFixer = { version: 1, roles: Object.entries(DEFAULT_ROLE_MODELS).filter(([role]) => role !== "fixer").map(([role, entry]) => ({ role, ...entry })) };
  const fresh = await runRejectedTask(t, { modelSettings: withoutFixer });
  assert.deepEqual(resolveRoleModel(fresh.db, "fixer"), DEFAULT_ROLE_MODELS.fixer);
  assert.deepEqual(runs(fresh.db, fresh.workId).at(-1), { tier: "fixer", model: fixer });
  const custom = await runRejectedTask(t, { modelSettings: { ...withoutFixer, roles: [...withoutFixer.roles, { role: "fixer", provider: "anthropic", model: "custom-fixer", effort: "high" }] } });
  assert.deepEqual(runs(custom.db, custom.workId).at(-1), { tier: "fixer", model: "custom-fixer" });
  assert.equal(taskModelRole({ type: "code", lead_designer_start_round: null, fixer_escalated_rejections: 2 }), "fixer");
  assert.equal(taskModelRole({ type: "design", lead_designer_start_round: null, fixer_escalated_rejections: 2 }), "designer");
});
