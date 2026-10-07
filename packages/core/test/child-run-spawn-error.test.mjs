import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createChildRunScheduler } from "../dist/child-run-scheduler.js";
import { DEFAULT_CHILD_RUN_SETTINGS } from "../../shared/dist/index.js";
import { createUlid, openDatabase } from "../../db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-child-run-spawn-error-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const ids = { work: createUlid(), task: createUlid(), parent: createUlid() };
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO works (id, owner_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:default', 'Spawn error test', '', 'normal', 'running', '[]', '[]', ?, ?)`,
      ids.work, now, now,
    );
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, ?, 'Spawn error test', 'code', 'running', 'normal', '', '', ?, ?)`,
      ids.task, ids.work, now, now,
    );
    tx.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
       VALUES (?, ?, ?, 'worker', 'claude', 'test-model', 'running', ?, ?)`,
      ids.parent, ids.work, ids.task, now, now,
    );
  });
  let runtimeCalls = 0;
  const scheduler = createChildRunScheduler({
    db,
    executorRuntime: () => {
      runtimeCalls += 1;
      throw new Error("executor runtime unavailable");
    },
    settings: () => ({ ...DEFAULT_CHILD_RUN_SETTINGS, max_attempts: 3 }),
    onParentActivity() {},
  });
  scheduler.registerParent({
    agent_run_id: ids.parent,
    work_id: ids.work,
    task_id: ids.task,
    harness: "claude",
    workspace_dir: root,
    worktree: root,
    task: { title: "test", acceptance: "", context: "", rules: "", owner_guidance: [] },
  });
  t.after(async () => {
    await scheduler.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { db, ids, scheduler, runtimeCalls: () => runtimeCalls };
}

test("executorRuntime exceptions fail AgentRuns and retry until the attempt limit", async (t) => {
  const { db, ids, scheduler, runtimeCalls } = await setup(t);
  const child = await scheduler.dispatch(ids.parent, {
    title: "Child task",
    instruction: "Run the child task.",
    write_paths: ["src/child.ts"],
  }, "spawn-error-retry");

  const result = await scheduler.wait(ids.parent, { child_ids: [child.child_id], timeout_seconds: 10 }, new AbortController().signal);
  assert.equal(result.done, true);
  const [childRun] = scheduler.list({ parent_agent_run_id: ids.parent });
  const agentRuns = db.all(
    "SELECT id, status, retry_of_run_id FROM agent_runs WHERE child_run_id = ?",
    child.child_id,
  );
  assert.deepEqual(agentRuns.map((run) => run.status), ["failed", "failed", "failed"]);
  assert.equal(childRun.status, "failed");
  assert.equal(childRun.failure_kind, "spawn_error");
  assert.equal(childRun.attempt, 3);
  assert.equal(runtimeCalls(), 3);
  // created_at can tie within one millisecond, so follow retry_of_run_id instead of row order.
  const chain = [];
  let next = agentRuns.filter((run) => run.retry_of_run_id === null);
  while (next.length === 1) {
    chain.push(next[0]);
    next = agentRuns.filter((run) => run.retry_of_run_id === chain.at(-1).id);
  }
  assert.equal(chain.length, 3);
  assert.equal(new Set(chain.map((run) => run.id)).size, 3);
});
