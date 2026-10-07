import assert from "node:assert/strict";
import { test } from "node:test";
import { necessityFor, criteriaFor } from "../helpers/necessity.mjs";

import { createUlid } from "../../packages/db/dist/index.js";
import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { waitFor } from "../helpers/wait.mjs";

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return command(payload, `test:${suffix}`, expectedVersion);
}

async function openCore(t, agentRunner) {
  return createTestCore(t, { agentRunner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-coordination-" });
}

/** A provider that answers Manager prompts with `plan` and fails every other role. */
function providerRunner(plan, prompts) {
  return createAgentRunner({
    adapter: "claude-cli/v1",
    provider: {
      execute: async (request) => {
        const prompt = String(request.prompt ?? request.input ?? JSON.stringify(request));
        prompts.push(prompt);
        const isManager = prompt.includes("You are the Owl Manager");
        return {
          adapter: request.adapter,
          stdout: isManager ? JSON.stringify(plan) : "not json",
          stderr: "",
          exit_code: 0,
          signal: null,
          format: "plain-text",
        };
      },
    },
  });
}

function insertTask(transaction, workId, { id, status, managerTaskId, title }) {
  const now = new Date().toISOString();
  transaction.run(
    `INSERT INTO tasks
       (id, work_id, title, type, status, priority, context, acceptance,
        state_version, failure_count, same_error_count, review_round, worker_generation,
        created_at, updated_at, retry_no, manager_task_id)
     VALUES (?, ?, ?, 'code', ?, 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, ?)`,
    id, workId, title, status, now, now, managerTaskId,
  );
}

const replacementPlan = {
  tasks: [
    { id: "T9", title: "Replacement task", type: "code", necessity: necessityFor(), acceptance_criteria: criteriaFor("Replacement done."), depends_on: [], required_sections: [], required_tests: [], wait_for: null, base_sync_only: null, replaces: ["T1"], context: "", notes: "", review: null },
  ],
};

test("a Work blocked on a Core Decision can be cancelled and its Decisions close", async (t) => {
  const agentRunner = {
    runManagerPlan: async () => ({ outcome: "failed", message: "plan failed" }),
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await openCore(t, agentRunner);
  await core.start();
  const created = await core.createWork(commandEnvelope({ title: "Cancel blocked", summary: "x", size: "normal", project_id: null }, "cancel-blocked-create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, "cancel-blocked-start", created.version));
  const blocked = await waitFor(() => db.get("SELECT state, state_version FROM works WHERE id = ? AND state = 'judgement_waiting'", workId));
  assert.ok(blocked, "the Work should halt at judgement_waiting");

  await core.cancelWork(workId, commandEnvelope({ reason: "owner gives up" }, "cancel-blocked-cancel", blocked.state_version));

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "cancelled");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND status = 'open'", workId).n, 0);
});

test("a Decision opened by Core is announced with a decision.opened event carrying its id and reason", async (t) => {
  const agentRunner = {
    runManagerPlan: async () => ({ outcome: "failed", message: "announce-marker" }),
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await openCore(t, agentRunner);
  await core.start();
  const created = await core.createWork(commandEnvelope({ title: "Announce", summary: "x", size: "normal", project_id: null }, "announce-create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, "announce-start", created.version));
  const decision = await waitFor(() => db.get("SELECT id FROM decisions WHERE work_id = ? AND status = 'open'", workId));
  assert.ok(decision);
  const event = await waitFor(() => db.get("SELECT payload_json FROM events WHERE type = 'decision.opened' AND work_id = ?", workId));
  assert.ok(event, "decision.opened should be emitted for a Core Decision");
  const payload = JSON.parse(event.payload_json);
  assert.equal(payload.decision_id, decision.id);
  assert.match(payload.reason, /announce-marker/u);
});

test("a replan that adds new Tasks supersedes the failed Task and restores its cascade-failed dependent", async (t) => {
  const prompts = [];
  const { db, core } = await openCore(t, providerRunner(replacementPlan, prompts));
  await core.start();
  const created = await core.createWork(commandEnvelope({ title: "Replan supersede", summary: "x", size: "normal", project_id: null }, "supersede-create"));
  const workId = created.data.work_id;
  const [failedTask, dependent] = await core.workflowEngine().registerPlan(workId, [
    { id: "T1", title: "Original", type: "code", acceptance: "Done.", necessity: necessityFor(), acceptance_criteria: criteriaFor("Done."), depends_on: [] },
    { id: "T2", title: "Follow-up", type: "code", acceptance: "Done.", necessity: necessityFor(), acceptance_criteria: criteriaFor("Done."), depends_on: ["T1"] },
  ], "work.planned");
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE tasks SET status = 'failed' WHERE id = ?", failedTask.id);
    // A Manager replan only runs for a running Work.
    transaction.run("UPDATE works SET state = 'running', state_version = state_version + 1 WHERE id = ?", workId);
  });
  // Cascade the failure the same way Core does for a permanent failure.
  await core.workflowEngine().cascadeFailure(workId, failedTask.id);
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", dependent.id).status, "failed");

  await core.triggerManagerReplan(workId, [failedTask.id], { kind: "queued_failed_tasks" });

  const managerPrompt = prompts.find((prompt) => prompt.includes("You are the Owl Manager"));
  assert.match(managerPrompt, /REPLAN/u);
  assert.match(managerPrompt, /current_plan/u);
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", failedTask.id).status, "cancelled");
  const replacement = db.get("SELECT id FROM tasks WHERE work_id = ? AND manager_task_id = 'T9'", workId);
  assert.ok(replacement, "the replacement Task should be registered");
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", dependent.id).status, "waiting");
  assert.deepEqual(
    db.all("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?", dependent.id).map((row) => row.depends_on_task_id),
    [replacement.id],
  );
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND status = 'open'", workId).n, 0);
});

test("answering a Work-scope Core Decision replans with the owner's answer instead of halting again", async (t) => {
  const prompts = [];
  const { db, core } = await openCore(t, providerRunner(replacementPlan, prompts));
  const created = await core.createWork(commandEnvelope({ title: "Answer replans", summary: "x", size: "normal", project_id: null }, "answer-create"));
  const workId = created.data.work_id;
  const failedId = createUlid();
  const decisionId = createUlid();
  await db.createWriteLane().transact((transaction) => {
    insertTask(transaction, workId, { id: failedId, status: "failed", managerTaskId: "T1", title: "Original" });
    transaction.run("UPDATE works SET state = 'judgement_waiting' WHERE id = ?", workId);
    transaction.run(
      `INSERT INTO decisions
         (id, work_id, scope, status, blocked_task_ids_json, reason, tried, current_state,
          options_json, recommended, allow_free_text, issuer_role, state_version, created_at)
       VALUES (?, ?, 'work', 'open', '[]', 'One or more tasks failed.', 'Core', 'judgement_waiting', '[]', NULL, 1, 'core', 0, ?)`,
      decisionId, workId, new Date().toISOString(),
    );
  });
  await core.start();

  await core.answerDecision(decisionId, commandEnvelope({
    answer: "owner-guidance-marker: split the work into a smaller task",
    option_key: null,
    source_message_id: null,
  }, "answer-replan"));

  const replacement = await waitFor(() => db.get("SELECT id FROM tasks WHERE work_id = ? AND manager_task_id = 'T9'", workId));
  assert.ok(replacement, "the owner's answer should drive a Manager replan");
  const managerPrompt = prompts.find((prompt) => prompt.includes("owner-guidance-marker"));
  assert.ok(managerPrompt, "the Manager prompt should carry the owner's answer");
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", failedId).status, "cancelled");
});

test("a Worker report's placeholder invocation_id is replaced by the real invocation id", async () => {
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    provider: {
      execute: async (request) => ({
        adapter: request.adapter,
        stdout: JSON.stringify({
          kind: "report",
          schema_version: "1.1.0",
          invocation_id: "<will be filled>",
          result: "success",
          work_done: "done",
          delegation: {
            decomposition: "Kept this task as one part because no child work was needed.",
            delegated: [],
            retained: [{ part: "Complete the task", reason: "No child task was needed." }],
          },
          changes: [],
          verification: { status: "passed", method: "Checked the result.", acceptance: [{ criterion_id: "AC1", status: "passed", evidence: "e" }], checks: [], integration_check: null },
          remaining_issues: [],
          next_action: "none",
          needs_replanning: false,
          question_for_manager: null,
          pending_process: null, external_blocker: null,
        }),
        stderr: "",
        exit_code: 0,
        signal: null,
        format: "plain-text",
      }),
    },
  });
  const result = await runner.runWorker({
    invocation_id: "real-invocation-id",
    work_id: "w",
    task_id: "t",
    attempt: 1,
    context: { task: { id: "t", work_id: "w", title: "x", status: "running", type: "code", state_version: 0, updated_at: "2026-01-01T00:00:00.000Z", parent_task_id: null, acceptance: "x", review_round: 0, failure_count: 0, worker_generation: 0, depends_on: [] } },
  });
  assert.equal(result.outcome, "success");
  assert.equal(result.report.invocation_id, "real-invocation-id");
});

test("owner guidance in the Core Worker context reaches the Worker prompt", async () => {
  const prompts = [];
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    provider: {
      execute: async (request) => {
        prompts.push(String(request.prompt ?? JSON.stringify(request)));
        return { adapter: request.adapter, stdout: "not json", stderr: "", exit_code: 0, signal: null, format: "plain-text" };
      },
    },
  });
  await runner.runWorker({
    invocation_id: "inv",
    work_id: "w",
    task_id: "t",
    attempt: 1,
    context: {
      task: { id: "t", work_id: "w", title: "x", status: "running", type: "code", state_version: 0, updated_at: "2026-01-01T00:00:00.000Z", parent_task_id: null, acceptance: "x", review_round: 0, failure_count: 0, worker_generation: 0, depends_on: [] },
      owner_guidance: [{ decision_reason: "failed", answer: "worker-guidance-marker" }],
    },
  });
  assert.match(prompts[0], /worker-guidance-marker/u);
});
