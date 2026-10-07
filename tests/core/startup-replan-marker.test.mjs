import assert from "node:assert/strict";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { waitFor } from "../helpers/wait.mjs";

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return command(payload, `test:${suffix}`, expectedVersion);
}

/** Build a Core on a new db and root with a fast dispatcher tick. */
function createCore(t, agentRunner) {
  return createTestCore(t, { agentRunner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-startup-replan-" });
}

function insertTask(transaction, workId, { id, status, managerTaskId, title, failedByDependencyTaskId = null }) {
  const now = new Date().toISOString();
  transaction.run(
    `INSERT INTO tasks
       (id, work_id, title, type, status, priority, context, acceptance,
        state_version, failure_count, same_error_count, review_round, worker_generation,
        created_at, updated_at, retry_no, manager_task_id, failed_by_dependency_task_id)
     VALUES (?, ?, ?, 'code', ?, 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, ?, ?)`,
    id, workId, title, status, now, now, managerTaskId, failedByDependencyTaskId,
  );
}

function insertIdempotencyKey(transaction, key, responseBody) {
  const now = new Date().toISOString();
  transaction.run(
    `INSERT INTO idempotency_keys (key, request_hash, response_json, status_code, created_at, expires_at)
     VALUES (?, ?, ?, 202, ?, ?)`,
    key,
    "0".repeat(64),
    JSON.stringify(responseBody),
    now,
    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  );
}

async function createRunningWork(core, db, suffix) {
  const created = await core.createWork(commandEnvelope({ title: `Startup replan ${suffix}`, summary: "x", size: "normal", project_id: null }, `${suffix}-create`));
  const workId = created.data.work_id;
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = 'running', state_version = state_version + 1 WHERE id = ?", workId);
  });
  return workId;
}

const emptyReplanReport = () => ({
  outcome: "success",
  report_valid: true,
  report: { event: "task.replanned", tasks: [] },
});

test("a Manager-trigger marker left attempted by a crash is replayed on the first tick after restart", async (t) => {
  const replanRequests = [];
  const agentRunner = {
    runManagerPlan: async (request) => {
      if (request.mode === "replan") {
        replanRequests.push(request);
        return {
          outcome: "success",
          report_valid: true,
          report: {
            event: "task.replanned",
            tasks: [{ id: "T1r", title: "Retry the root Task", type: "code", acceptance: "Done.", depends_on: [], required_sections: [], required_tests: [], replaces: ["T1"] }],
          },
        };
      }
      return { outcome: "failed", message: "unexpected manager call" };
    },
    runWorker: async () => ({ outcome: "failed", failure_class: "transient", error_key: "test_stop", retry_allowed: true, message: "stop here" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await createCore(t, agentRunner);
  const workId = await createRunningWork(core, db, "trigger");

  const taskId = createUlid();
  await db.createWriteLane().transact((transaction) => {
    insertTask(transaction, workId, { id: taskId, status: "failed", managerTaskId: "T1", title: "Root failure" });
    // A crash between Core marking the trigger attempted and the replan
    // finishing leaves it stuck here, with no in-flight replan left to
    // ever move it forward.
    insertIdempotencyKey(transaction, `manager-trigger:${taskId}`, {
      task_id: taskId,
      event: "task.failure.classified",
      status: "attempted",
      question: null,
    });
  });

  await core.start();

  const replanned = await waitFor(() => replanRequests.length > 0 && replanRequests[0], { timeoutMs: 5_000, message: "startup recovery to requeue the stuck trigger so the first tick replays it" });
  assert.deepEqual(replanned.context.failed_task_ids, [taskId]);
});

test("an Owner-replan marker left attempted by a crash hands the reopen's answer to the Manager on restart", async (t) => {
  const replanRequests = [];
  const agentRunner = {
    runManagerPlan: async (request) => {
      if (request.mode === "replan") {
        replanRequests.push(request);
        return emptyReplanReport();
      }
      return { outcome: "failed", message: "unexpected manager call" };
    },
    runWorker: async () => ({ outcome: "failed", failure_class: "transient", error_key: "test_stop", retry_allowed: true, message: "stop here" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await createCore(t, agentRunner);
  const workId = await createRunningWork(core, db, "reopen");

  const taskId = createUlid();
  await db.createWriteLane().transact((transaction) => {
    // Every Task is terminal, so the tick treats the Work as ready to
    // consume its queued Owner request.
    insertTask(transaction, workId, { id: taskId, status: "completed", managerTaskId: "T1", title: "Done already" });
    // A crash between consumeOwnerReplan moving the marker to attempted
    // and the replan finishing leaves it stuck, with no in-flight replan
    // left to ever act on the Owner's reopen request.
    insertIdempotencyKey(transaction, `owner-replan:${workId}`, {
      work_id: workId,
      status: "attempted",
      kind: "reopen",
      answer: "Please also add a changelog entry.",
    });
  });

  await core.start();

  const replanned = await waitFor(() => replanRequests.length > 0 && replanRequests[0], { timeoutMs: 5_000, message: "startup recovery to requeue the stuck Owner replan so the first tick replays it" });
  // An older marker (answer only) is one request, text whole.
  assert.deepEqual(replanned.context.owner_requests, [{ kind: "reopen", text: "Please also add a changelog entry.", message_ids: [] }]);
  assert.deepEqual(replanned.context.worker_questions, []);
});
