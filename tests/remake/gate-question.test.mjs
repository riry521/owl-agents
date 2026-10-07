import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { lineageUsage } from "../../packages/core/dist/task-lineage.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { DEFAULT_REMAKE_LIMIT_SETTINGS } from "../../packages/shared/dist/remake-limit-settings.js";
import { createTestCore, command } from "../helpers/core.mjs";
import { openTestDatabase } from "../helpers/db.mjs";
import { withNecessity } from "../helpers/necessity.mjs";
import { waitFor } from "../helpers/wait.mjs";

// A Worker question (needs_replanning:false) is answered by the Manager and is
// neither stopped by the remake gate nor counted in the lineage; the same
// report with needs_replanning:true still hits the gate.

const envelope = (payload, suffix, expectedVersion = 0) => command(payload, `test:${suffix}:${createUlid()}`, expectedVersion);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const planTask = () => ({ id: "T1", title: "A", type: "code", acceptance: "Done; verified by the test.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false });
const review = { verdict: "pass", summary: "ok", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } };

function runnerWith({ needsReplanning }) {
  const state = { workerCalls: 0, replans: 0 };
  return {
    state,
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask()] } };
      if (mode === "replan") {
        state.replans += 1;
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [planTask()] } };
      }
      return { outcome: "failed", message: `unexpected manager ${mode}` };
    },
    runWorker: async (request) => {
      state.workerCalls += 1;
      const question = state.workerCalls === 1 || needsReplanning ? "Is the acceptance criterion X what you want?" : null;
      if (question === null) {
        await mkdir(join(request.context.worktree, "src"), { recursive: true });
        await writeFile(join(request.context.worktree, "src/feature.mjs"), "export const f = 1;\n");
      }
      const report = { kind: "report", schema_version: "1.0.0", invocation_id: request.invocation_id, result: question ? "partial" : "success", work_done: "Done.", changes: [], verification: { passed: true, method: "Checked." }, remaining_issues: [], next_action: "none", needs_replanning: needsReplanning, question_for_manager: question };
      return { outcome: "success", report_valid: true, report };
    },
    runReviewer: async () => ({ outcome: "success", report_valid: true, report: review, review }),
    runAdvisor: async () => ({ reply: "" }),
  };
}

async function setup(t, runner) {
  const { db, core } = await createTestCore(t, { agentRunner: withNecessity(runner), dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-remake-gate-question-", start: true });
  await core.setRemakeLimitSettings({ ...DEFAULT_REMAKE_LIMIT_SETTINGS, lineage_worker_runs: 1 });
  const created = await core.createWork(envelope({ title: "q", summary: "Worker question vs remake gate.", size: "normal", project_id: null }, "create"));
  await core.startWork(created.data.work_id, envelope({ mode: "normal" }, "start", created.version));
  return { db, workId: created.data.work_id };
}

const remakeDecisions = (db, workId) => db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND reason LIKE '%作り直しが上限に達した%'", workId).n;

test("a question at the lineage worker-run limit reaches the Manager and is not counted", async (t) => {
  const runner = runnerWith({ needsReplanning: false });
  const { db, workId } = await setup(t, runner);
  assert.ok(await waitFor(() => runner.state.replans >= 1), "the Manager is asked");
  assert.ok(await waitFor(() => db.get("SELECT status FROM tasks WHERE work_id = ? ORDER BY created_at DESC LIMIT 1", workId)?.status === "completed"));
  assert.equal(remakeDecisions(db, workId), 0);
  assert.equal(runner.state.replans, 1, "the Manager is asked exactly once");
  assert.ok(db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE outcome = 'question'").n >= 1);
  const taskId = db.get("SELECT id FROM tasks WHERE work_id = ? ORDER BY created_at DESC LIMIT 1", workId).id;
  assert.equal(lineageUsage(db, taskId, DEFAULT_REMAKE_LIMIT_SETTINGS).worker_runs, 1, "the question run is not counted");
});

test("a run that reported an external blocker is not a lineage Worker run", async (t) => {
  const { db } = await openTestDatabase(t, { prefix: "owl-remake-gate-blocker-" });
  const now = "2026-09-24T00:00:00.000Z";
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(`INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
            VALUES ('W', 'owner:default', NULL, 'W', 'x', 'normal', 'running', '[]', '[]', ?, ?)`, now, now);
    tx.run(`INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at, manager_task_id)
            VALUES ('T1', 'W', 'T1', 'code', 'running', 'normal', '', 'Done.', ?, ?, 'T1')`, now, now);
    for (const id of ["R1", "R2"]) {
      tx.run(`INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
              VALUES (?, 'W', 'T1', 'worker', 'p', 'm', 'completed', ?, ?)`, id, now, now);
    }
    tx.run(`INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, agent_run_id, payload_json, status, created_at)
            VALUES ('E1', 1, 'k1', 'task.external_blocker_reported', 'W', 'T1', 'R2', '{}', 'handled', ?)`, now);
  });
  assert.equal(lineageUsage(db, "T1", DEFAULT_REMAKE_LIMIT_SETTINGS).worker_runs, 1);
});

test("needs_replanning:true is still stopped by the remake gate", async (t) => {
  const runner = runnerWith({ needsReplanning: true });
  const { db, workId } = await setup(t, runner);
  assert.ok(await waitFor(() => remakeDecisions(db, workId) > 0), "a remake-limit Decision opens");
  await sleep(300);
  assert.equal(runner.state.replans, 0, "the Manager is never asked");
});
