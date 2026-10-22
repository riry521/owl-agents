import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkflowEngine } from "../../packages/core/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { openTestDatabase } from "../helpers/db.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { waitFor } from "../helpers/wait.mjs";

test("a Task whose worktree conflicts with the Work branch fails alone while the Work keeps launching", async (t) => {
  let workflow;
  // Registered before the database hook so the engine stops before the DB closes.
  t.after(() => workflow?.stop());
  const { db } = await openTestDatabase(t, { prefix: "owl-worktree-sync-conflict-" });
  const workId = createUlid();
  const conflictedId = createUlid();
  const otherId = createUlid();
  const createdAt = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, 'Owner', ?, ?)", "owner:sync-conflict", createdAt, createdAt);
    tx.run(
      `INSERT INTO works (id, owner_id, title, summary, size, state, rules_json,
        related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:sync-conflict', 'Work', '', 'normal', 'running', ?, '[]', ?, ?)`,
      workId, JSON.stringify({ schema_version: "1.0.0", rules: [] }), createdAt, createdAt,
    );
    for (const [id, status] of [[conflictedId, "review_fix_waiting"], [otherId, "ready"]]) {
      tx.run(
        `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
         VALUES (?, ?, 'Task', 'code', ?, 'normal', '', '', ?, ?)`,
        id, workId, status, createdAt, createdAt,
      );
    }
  });

  const replans = [];
  workflow = new WorkflowEngine({
    db,
    agentRunner: {
      runWorker: async () => ({ outcome: "failed", failure_class: "transient", error_key: "provider_failed:network", retry_allowed: true, message: "ECONNRESET" }),
    },
    git: {
      prepareWorktree: async ({ task_id }) => task_id === conflictedId
        ? {
          ok: false,
          exit_code: 1,
          recorded: false,
          failure_kind: "work_sync_conflict",
          message: "Task worktree conflicts with the Work branch: Auto-merging src/types.ts\nCONFLICT (content): Merge conflict in src/types.ts\nAutomatic merge failed; fix conflicts and then commit the result.",
        }
        : { ok: true, exit_code: 0, recorded: false, message: "prepared" },
    },
    onManagerReplanNeeded: async (input) => { replans.push(input); },
  });
  workflow.start();

  assert.deepEqual(await workflow.launchReady(workId), [otherId]);
  await workflow.drainPipelines();

  const conflicted = db.get("SELECT status, last_failure_class, last_error_key, failure_count FROM tasks WHERE id = ?", conflictedId);
  assert.equal(conflicted.status, "failed");
  assert.equal(conflicted.last_failure_class, "deterministic");
  assert.notEqual(conflicted.last_error_key, null);
  assert.equal(conflicted.failure_count, 1);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");

  const event = db.get("SELECT payload_json FROM events WHERE task_id = ? AND type = 'task.conflict'", conflictedId);
  assert.deepEqual(JSON.parse(event.payload_json).merge_conflict_files, ["src/types.ts"]);
  assert.equal(replans.length, 1);
  assert.deepEqual(replans[0].failed_task_ids, [conflictedId]);
  assert.deepEqual(replans[0].trigger, { kind: "launch_conflict", task_id: conflictedId, merge_conflict_files: ["src/types.ts"] });
});

const syncConflict = {
  ok: false,
  exit_code: 1,
  recorded: false,
  failure_kind: "work_sync_conflict",
  message: "Task worktree conflicts with the Work branch: Auto-merging src/types.ts\nCONFLICT (content): Merge conflict in src/types.ts\nAutomatic merge failed; fix conflicts and then commit the result.",
};

const taskPlan = { id: "T1", title: "A", type: "code", acceptance: "Done; verified by the test.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false };

test("the first launch-time sync conflict reaches the Manager with auto_recovery and opens no Decision", async (t) => {
  const replans = [];
  let db;
  const agentRunner = {
    runManagerPlan: async (request) => {
      if ((request.mode ?? request.context?.mode) === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [taskPlan] } };
      console.log("TRIGGER", JSON.stringify(request.trigger));
      if ((request.mode ?? request.context?.mode) !== "replan") return { outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } };
      replans.push({
        openDecisions: db.get("SELECT COUNT(*) AS n FROM decisions WHERE status = 'open'").n,
        started: db.all("SELECT payload_json FROM events WHERE type = 'recovery.started'").map((row) => JSON.parse(row.payload_json)),
        context: request.context,
      });
      return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [taskPlan] } };
    },
    runWorker: async (request) => ({
      outcome: "success",
      report_valid: true,
      report: { kind: "report", schema_version: "1.0.0", invocation_id: request.invocation_id, result: "success", work_done: "Done.", changes: [], verification: { passed: true, method: "Checked." }, remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null },
    }),
    runReviewer: async () => ({ outcome: "success", report_valid: true, report: {}, review: { verdict: "pass", summary: "ok", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } } }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const created = await createTestCore(t, { agentRunner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-sync-conflict-recovery-", start: true });
  db = created.db;
  await disablePlanQuality(db);
  let conflicts = 0;
  const gateway = created.core.gitGateway();
  const prepareWorktree = gateway.prepareWorktree.bind(gateway);
  gateway.prepareWorktree = async (request) => (conflicts++ === 0 ? syncConflict : prepareWorktree(request));

  const work = await created.core.createWork(command({ title: "sync conflict", summary: "Exercise recovery.", size: "normal", project_id: null }, "sync-create"));
  await created.core.startWork(work.data.work_id, command({ mode: "normal" }, "sync-start", work.version));
  await waitFor(() => replans.length > 0, { timeoutMs: 15_000, message: "the Manager is asked about the conflict" });

  assert.equal(replans[0].openDecisions, 0);
  assert.deepEqual(replans[0].started.map((entry) => [entry.kind, entry.attempt_no, entry.limit]), [["integration_conflict", 1, 2]]);
  assert.equal(replans[0].context.auto_recovery.kind, "integration_conflict");
  assert.match(replans[0].context.auto_recovery.instruction, /both sides' changes/u);
  assert.match(replans[0].context.auto_recovery.instruction, /check_commands/u);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions").n, 0);
});
