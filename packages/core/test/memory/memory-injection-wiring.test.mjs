import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Core, createTaskPlanInTransaction, createWorkInTransaction } from "../../dist/index.js";
import { createUlid, openDatabase } from "../../../db/dist/index.js";
import { writeCommonIndex } from "../../../../tests/helpers/seed-knowledge.mjs";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const SUMMARY = "zebra keyword の共通の決まりごと";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-injection-wiring-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  // Every mock runner records its input and stops; the catalog is read from what the real path handed to it.
  const seen = {};
  const capture = (role) => async (input) => { seen[role] = input; throw new Error("stop after capture"); };
  const agentRunner = { runManagerPlan: capture("manager"), runDesigner: capture("designer"), runWorker: capture("worker"), runReviewer: capture("reviewer"), runCurator: capture("curator"), runAdvisor: async () => ({ reply: "" }) };
  const core = new Core({ db, agentRunner, version: "t", owlRoot: root, dataDir: join(root, "data") });
  t.after(async () => { await core.stop({ force: true }); db.close(); await rm(root, { recursive: true, force: true }); });
  await core.start();
  await writeCommonIndex(join(root, "knowledge"), SUMMARY);
  await core.memory.reindex({ mode: "full" });
  const now = new Date().toISOString();
  const { workId, designId, taskId } = await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    const created = createWorkInTransaction(tx, { title: "zebra keyword", summary: "x", size: "normal", project_id: null });
    createTaskPlanInTransaction(tx, created.id, [
      { id: "D1", title: "Design", type: "design", acceptance: "ok", depends_on: [] },
      { id: "W1", title: "Implement zebra keyword", type: "code", acceptance: "ok", depends_on: [] },
    ]);
    const rows = tx.all("SELECT id, type FROM tasks WHERE work_id = ?", created.id);
    return { workId: created.id, designId: rows.find((r) => r.type === "design").id, taskId: rows.find((r) => r.type !== "design").id };
  });
  const startRun = async (task, role, taskStatus) => {
    const id = createUlid();
    await db.createWriteLane().transact((tx) => {
      tx.run("INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'anthropic', 'm', 'running', ?, ?, ?)", id, workId, task, role, now, now, now);
      tx.run("UPDATE tasks SET status = ? WHERE id = ?", taskStatus, task);
    });
    return id;
  };
  const setSetting = (key, value) => db.createWriteLane().transact((tx) => tx.run(
    "INSERT OR REPLACE INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES (?, 'owner:default', 1, ?, ?)", key, JSON.stringify(value), now));
  const catalogIn = (input) => {
    const found = [];
    const walk = (v) => {
      if (typeof v === "string") { if (v.startsWith("<owl-memory")) found.push(v); } else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(input);
    return found[0];
  };
  // Each role runs through its real path (Core, WorkflowEngine, SkillCurator); resolves to the catalog in the runner's input.
  const run = {
    manager: async () => { await core.invokeManagerPlan({ work_id: workId }, "plan").catch(() => {}); return catalogIn(seen.manager); },
    designer: async () => { await core.workflow.runWorkerInternal(workId, designId, await startRun(designId, "designer", "running"), 1).catch(() => {}); return catalogIn(seen.designer); },
    worker: async () => { await core.workflow.runWorkerInternal(workId, taskId, await startRun(taskId, "worker", "running"), 1).catch(() => {}); return catalogIn(seen.worker); },
    reviewer: async () => {
      const workerRun = await startRun(taskId, "worker", "verifying");
      await core.workflow.runReviewerInternal(workId, taskId, workerRun, { summary: "s" }, 1).catch(() => {});
      return catalogIn(seen.reviewer);
    },
    curator: async () => {
      const payload = { kind: "new", target: null, summary: "zebra keyword", steps_or_diff: "Review the source, run the required checks, and record the result for the next release.", evidence: "Used in more than one task." };
      await db.createWriteLane().transact((tx) => tx.run(
        "INSERT INTO skill_proposals (id, kind, target_skill, payload_json, project_id, status, attempts, created_at, updated_at) VALUES (?, 'new', NULL, ?, NULL, 'pending', 0, ?, ?)",
        createUlid(), JSON.stringify(payload), now, now));
      await core.skillCurator.curate().catch(() => {});
      return catalogIn(seen.curator);
    },
  };
  return { core, setSetting, run };
}

test("every role input carries the index; the Reviewer's has no summary and the Curator's has none", async (t) => {
  const { run } = await setup(t);
  for (const role of ["manager", "designer", "worker", "reviewer"]) {
    const text = await run[role]();
    assert.ok(text, `${role} input has no index`);
    assert.match(text, /^<owl-memory scope="common" data="external[^"]*">/, role);
    assert.ok(text.includes("</owl-memory>"), role);
    assert.equal(text.includes(SUMMARY), role !== "reviewer", role);
  }
  assert.equal(await run.curator(), undefined, "the Curator gets no index");
});

test("disconnected vault: the last index answers with a notice", async (t) => {
  const { core } = await setup(t);
  core.knowledgeLocation.isAvailable = () => false;
  const text = await core.memoryInjector.compose({ role: "manager", query: ["zebra keyword"], project_id: "p1" });
  assert.match(text, /保管庫未接続/);
  assert.ok(text.includes(SUMMARY));
});
