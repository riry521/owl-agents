import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createTaskPlanInTransaction, createWorkInTransaction, NoopGitGateway, WorkflowEngine } from "../packages/core/dist/index.js";
import { resolveRoleModel } from "../packages/core/dist/workflow-engine.js";
import { buildDesignerRolePrompt } from "../packages/agent-runtime/dist/worker.js";
import { openDatabase } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("a lead Work assigns design Tasks to Lead Designer without changing other Tasks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-designer-tier-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  t.after(() => db.close());
  const work = await db.createWriteLane().transact((tx) => {
    const created = createWorkInTransaction(tx, {
      title: "Lead design", summary: "Use Lead Designer", size: "normal", project_id: null, design_mode: "lead",
    });
    createTaskPlanInTransaction(tx, created.id, [
      { id: "D1", title: "Design", type: "design", acceptance: "Design exists", depends_on: [] },
      { id: "W1", title: "Implement", type: "code", acceptance: "Code exists", depends_on: ["D1"] },
    ]);
    return created;
  });
  assert.equal(db.get("SELECT design_mode FROM works WHERE id = ?", work.id).design_mode, "lead");
  assert.deepEqual(db.all("SELECT type, lead_designer_start_round AS start FROM tasks WHERE work_id = ? ORDER BY created_at, manager_task_id", work.id), [
    { type: "design", start: 0 },
    { type: "code", start: null },
  ]);
});

test("Designer and Lead Designer keep independent model settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-designer-models-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  t.after(() => db.close());
  await db.createWriteLane().transact((tx) => {
    const now = new Date().toISOString();
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
    "INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('model_settings', 'owner:default', '1.0.0', ?, ?)",
    JSON.stringify({ version: 1, roles: [
      { role: "designer", provider: "anthropic", model: "ordinary-model", effort: "medium" },
      { role: "lead_designer", provider: "anthropic", model: "strong-model", effort: "high" },
    ] }), now,
  );
  });
  assert.equal(resolveRoleModel(db, "designer").model, "ordinary-model");
  assert.equal(resolveRoleModel(db, "lead_designer").model, "strong-model");
});

test("Lead Designer prompt identifies the escalation and retains design restrictions", () => {
  const prompt = buildDesignerRolePrompt({
    task: { id: "T1", work_id: "W1", title: "Architecture", type: "design", acceptance: "Complete design" },
    context: { design_document_path: "/tmp/design.md", design_tier: "lead", reviewer_findings: [] },
  });
  assert.match(prompt, /Owl Lead Designer/);
  assert.match(prompt, /two failed reviews/);
  assert.match(prompt, /Do not modify any file in the repository/);
});

test("workflow launch records the configured model and tier for each design Task", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-designer-dispatch-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const workflow = new WorkflowEngine({
    db, owlRoot: root, dataDir: root, git: new NoopGitGateway(),
    agentRunner: { runDesigner: async () => gate },
  });
  t.after(async () => {
    release({ outcome: "failed", report_valid: false, message: "test stopped", skill_feedback: null });
    await workflow.stop();
    db.close();
  });
  const workId = await db.createWriteLane().transact((tx) => {
    const work = createWorkInTransaction(tx, { title: "Mixed design", summary: "x", size: "normal", project_id: null });
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", work.id);
    const tasks = createTaskPlanInTransaction(tx, work.id, [
      { id: "D1", title: "Ordinary", type: "design", acceptance: "Document", depends_on: [] },
      { id: "D2", title: "Lead", type: "design", acceptance: "Document", depends_on: [] },
    ]);
    tx.run("UPDATE tasks SET lead_designer_start_round = 0 WHERE id = ?", tasks[1].id);
    tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('model_settings', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify({ version: 1, roles: [
        { role: "designer", provider: "anthropic", model: "ordinary-model", effort: "medium" },
        { role: "lead_designer", provider: "anthropic", model: "strong-model", effort: "high" },
      ] }), new Date().toISOString());
    return work.id;
  });
  workflow.start();
  await workflow.resolveDependencies(workId);
  assert.equal((await workflow.launchReady(workId)).length, 2);
  assert.deepEqual(db.all("SELECT design_tier, model FROM agent_runs WHERE work_id = ? ORDER BY model", workId), [
    { design_tier: "standard", model: "ordinary-model" },
    { design_tier: "lead", model: "strong-model" },
  ]);
});
