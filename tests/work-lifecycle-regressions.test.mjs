import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";
import { KnowledgeNotes } from "../packages/core/dist/knowledge-notes.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return {
    request_id: createUlid(),
    idempotency_key: `test:${suffix}`,
    expected_version: expectedVersion,
    payload,
  };
}

async function openDb(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-audit-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const cores = [];
  db.__auditCores = cores;
  t.after(async () => {
    for (const core of cores) await core.stop({ force: true });
    db.close();
  });
  return { root, db };
}

function newCore(t, db, root, agentRunner, dispatcher = {}) {
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 25, ...dispatcher } });
  db.__auditCores.push(core);
  return core;
}

async function waitFor(read, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function insertTask(transaction, workId, { id, status, managerTaskId, title, failureCount = 0, type = "code" }) {
  const now = new Date().toISOString();
  transaction.run(
    `INSERT INTO tasks
       (id, work_id, title, type, status, priority, context, acceptance,
        state_version, failure_count, same_error_count, review_round, worker_generation,
        created_at, updated_at, retry_no, manager_task_id)
     VALUES (?, ?, ?, ?, ?, 'normal', '', 'Done.', 0, ?, 0, 0, 0, ?, ?, 0, ?)`,
    id, workId, title, type, status, failureCount, now, now, managerTaskId,
  );
}

function workerReport(invocationId, extra = {}) {
  return {
    kind: "report",
    schema_version: "1.0.0",
    invocation_id: invocationId,
    result: "success",
    work_done: "Done.",
    changes: [],
    verification: { passed: true, method: "Checked the result." },
    remaining_issues: [],
    next_action: "none",
    needs_replanning: false,
    question_for_manager: null,
    ...extra,
  };
}

const finalComplete = (request, lessons = []) => ({
  outcome: "success",
  report_valid: true,
  report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons } },
});

const transientWorkerFailure = async () => ({
  outcome: "failed",
  failure_class: "transient",
  error_key: "test_transient_stop",
  retry_allowed: true,
  message: "stop here",
});

async function createRunningWork(core, db, suffix) {
  const created = await core.createWork(commandEnvelope({ title: `Audit ${suffix}`, summary: "x", size: "normal", project_id: null }, `${suffix}-create`));
  const workId = created.data.work_id;
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = 'running', state_version = state_version + 1 WHERE id = ?", workId);
  });
  return workId;
}

test("item 1+2: cancelAgent at the crash threshold cascades to dependents and the tick replays the lost Manager replan once", async (t) => {
  const { root, db } = await openDb(t);
  const replanRequests = [];
  const agentRunner = {
    runManagerPlan: async (request) => {
      if (request.mode === "replan") {
        replanRequests.push(request);
        return {
          outcome: "success",
          report_valid: true,
          report: { event: "task.replanned", tasks: [{ id: "T1", title: "Revised T1", type: "code", acceptance: "Done.", depends_on: [], replaces: [] }] },
        };
      }
      return { outcome: "failed", message: "unexpected manager call" };
    },
    runWorker: transientWorkerFailure,
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = newCore(t, db, root, agentRunner);
  const workId = await createRunningWork(core, db, "cancel-agent");
  const t1 = createUlid();
  const t2 = createUlid();
  const t3 = createUlid();
  const runId = createUlid();
  await db.createWriteLane().transact((transaction) => {
    insertTask(transaction, workId, { id: t1, status: "running", managerTaskId: "T1", title: "Root", failureCount: 2 });
    insertTask(transaction, workId, { id: t2, status: "waiting", managerTaskId: "T2", title: "Child" });
    insertTask(transaction, workId, { id: t3, status: "waiting", managerTaskId: "T3", title: "Grandchild" });
    transaction.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)", t2, t1);
    transaction.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)", t3, t2);
    const now = new Date().toISOString();
    transaction.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, fencing_token, created_at, updated_at)
       VALUES (?, ?, ?, 'worker', 'test', 'test', 'running', ?, ?, ?)`,
      runId, workId, t1, runId, now, now,
    );
  });

  // Core is not started yet: the replan cannot run now and must not be lost.
  await core.cancelAgent(runId, commandEnvelope({ reason: "owner stops the agent" }, "cancel-agent"));
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", t1).status, "failed");
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", t2).status, "failed", "the waiting dependent is cascade-failed");
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", t3).status, "failed", "the cascade is transitive");
  assert.ok(db.get("SELECT 1 FROM events WHERE type = 'task.dependency_failed' AND task_id = ?", t2));
  assert.ok(db.get("SELECT 1 FROM events WHERE type = 'task.dependency_failed' AND task_id = ?", t3));
  assert.equal(
    JSON.parse(db.get("SELECT response_json FROM idempotency_keys WHERE key = ?", `manager-trigger:${t1}`).response_json).status,
    "queued",
  );

  await core.start();
  const replanned = await waitFor(() => replanRequests.length > 0 && db.get("SELECT status FROM tasks WHERE id = ? AND title = 'Revised T1'", t1));
  assert.ok(replanned, "the tick should replay the queued Manager replan");
  assert.deepEqual(replanRequests[0].context.failed_task_ids, [t1], "only the root failure is replanned, not cascade-failed Tasks");
  assert.equal(
    JSON.parse(db.get("SELECT response_json FROM idempotency_keys WHERE key = ?", `manager-trigger:${t1}`).response_json).status,
    "attempted",
  );
  assert.ok(await waitFor(() => db.get("SELECT 1 FROM tasks WHERE id = ? AND status = 'waiting'", t2)), "the cascaded dependent is restored");
  await sleep(250);
  assert.equal(replanRequests.length, 1, "the replay runs exactly once");
});

test("item 1: the Engine cascadeFailure entry point still cascades a Task failed outside the reducer", async (t) => {
  const { root, db } = await openDb(t);
  const core = newCore(t, db, root, { runManagerPlan: async () => ({ outcome: "failed" }), runWorker: async () => ({ outcome: "failed" }), runReviewer: async () => ({ outcome: "failed" }), runAdvisor: async () => ({ reply: "" }) });
  const workId = await createRunningWork(core, db, "engine-cascade");
  const t1 = createUlid();
  const t2 = createUlid();
  await db.createWriteLane().transact((transaction) => {
    insertTask(transaction, workId, { id: t1, status: "failed", managerTaskId: "T1", title: "Root" });
    insertTask(transaction, workId, { id: t2, status: "waiting", managerTaskId: "T2", title: "Child" });
    transaction.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)", t2, t1);
  });
  await core.workflowEngine().cascadeFailure(workId, t1);
  await core.workflowEngine().cascadeFailure(workId, t1);
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", t2).status, "failed");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'task.dependency_failed' AND task_id = ?", t2).n, 1);
});

test("item 2: an Owner answer queued for a replan survives a Core restart", async (t) => {
  const { root, db } = await openDb(t);
  const prompts = [];
  const agentRunner = {
    runManagerPlan: async (request) => {
      if (request.mode === "replan") {
        prompts.push(request);
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [{ id: "T9", title: "Replacement", type: "code", acceptance: "Done.", depends_on: [], replaces: ["T1"] }] } };
      }
      return { outcome: "failed", message: "unexpected" };
    },
    runWorker: transientWorkerFailure,
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const first = newCore(t, db, root, agentRunner);
  const created = await first.createWork(commandEnvelope({ title: "Restart replan", summary: "x", size: "normal", project_id: null }, "restart-create"));
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
       VALUES (?, ?, 'work', 'open', '[]', 'Tasks failed.', 'Core', 'judgement_waiting', '[]', NULL, 1, 'core', 0, ?)`,
      decisionId, workId, new Date().toISOString(),
    );
  });
  // The first Core never ticks the Work (it is not started).
  await first.answerDecision(decisionId, commandEnvelope({ answer: "restart-marker: try a smaller task", option_key: null, source_message_id: null }, "restart-answer"));
  assert.ok(db.get("SELECT 1 FROM idempotency_keys WHERE key = ?", `owner-replan:${workId}`), "the Owner answer is persisted");

  const second = newCore(t, db, root, agentRunner);
  await second.start();
  const replacement = await waitFor(() => db.get("SELECT id FROM tasks WHERE work_id = ? AND manager_task_id = 'T9'", workId));
  assert.ok(replacement, "the restarted Core should replan with the persisted answer");
  assert.equal(prompts[0].context.question, "restart-marker: try a smaller task");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = ?", `owner-replan:${workId}`).n, 0);
});

test("item 3: the initial Manager plan retries transient failures before escalating", async (t) => {
  const { root, db } = await openDb(t);
  let planCalls = 0;
  const agentRunner = {
    runManagerPlan: async (request) => {
      if (request.context?.mode === "plan") {
        planCalls += 1;
        if (planCalls <= 2) return { outcome: "failed", failure_class: "transient", error_key: "rate_limited", retry_allowed: true, message: "429" };
        return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{ id: "T1", title: "Planned", type: "code", acceptance: "Done.", depends_on: [], replaces: [] }] } };
      }
      return { outcome: "failed", message: "unexpected" };
    },
    runWorker: transientWorkerFailure,
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = newCore(t, db, root, agentRunner, { manager_retry_delay_ms: 5 });
  await core.start();
  const created = await core.createWork(commandEnvelope({ title: "Plan retry", summary: "x", size: "normal", project_id: null }, "plan-retry-create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, "plan-retry-start", created.version));
  assert.ok(await waitFor(() => db.get("SELECT id FROM tasks WHERE work_id = ? AND manager_task_id = 'T1'", workId)));
  assert.equal(planCalls, 3);
  assert.notEqual(db.get("SELECT state FROM works WHERE id = ?", workId).state, "judgement_waiting");
});

test("item 3: a non-retryable initial plan failure escalates without retrying", async (t) => {
  const { root, db } = await openDb(t);
  let planCalls = 0;
  const agentRunner = {
    runManagerPlan: async () => {
      planCalls += 1;
      return { outcome: "failed", failure_class: "deterministic", error_key: "auth", retry_allowed: false, message: "auth revoked" };
    },
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = newCore(t, db, root, agentRunner, { manager_retry_delay_ms: 5 });
  await core.start();
  const created = await core.createWork(commandEnvelope({ title: "Plan no retry", summary: "x", size: "normal", project_id: null }, "plan-noretry-create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, "plan-noretry-start", created.version));
  assert.ok(await waitFor(() => db.get("SELECT 1 FROM works WHERE id = ? AND state = 'judgement_waiting'", workId)));
  assert.equal(planCalls, 1);
});

test("item 4: completed Work lessons are routed through the learning pipeline without a policy Decision", async (t) => {
  const { root, db } = await openDb(t);
  const agentRunner = {
    runManagerPlan: async (request) => {
      if (request.context?.mode === "plan") {
        return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{ id: "T1", title: "Research", type: "research", acceptance: "Done.", depends_on: [], replaces: [], review: false }] } };
      }
      if (request.mode === "finalize") return finalComplete(request, [
        { lesson: "policy-marker", basis: "The Work showed it.", applies_to: "Every Work.", proposes_rule: true },
        { lesson: "not-a-rule-marker", basis: "One observation.", applies_to: "This Work only.", proposes_rule: false },
      ]);
      return { outcome: "failed", message: "unexpected" };
    },
    runWorker: async (request) => ({ outcome: "success", report_valid: true, report: workerReport(request.invocation_id) }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = newCore(t, db, root, agentRunner);
  await core.start();
  const created = await core.createWork(commandEnvelope({ title: "Policy decision", summary: "x", size: "normal", project_id: null }, "policy-create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, "policy-start", created.version));
  const job = await waitFor(() => db.get("SELECT * FROM learning_jobs WHERE work_id = ? AND status = 'done'", workId), 15_000);
  assert.ok(job, "the learning job has finished");
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  const result = JSON.parse(job.result_json);
  const proposal = db.get("SELECT * FROM rule_proposals WHERE id = ?", result.rule_proposal_ids[0]);
  assert.equal(proposal.status, "awaiting_approval");
  assert.equal(proposal.origin, "lesson");
  assert.equal(proposal.text, "policy-marker");
  assert.equal(proposal.rationale, "The Work showed it.");
  const notes = await new KnowledgeNotes(core.knowledge).list();
  assert.ok(notes.some((note) => note.claims.some((claim) => claim.text === "not-a-rule-marker")));
  assert.equal((await core.knowledge.list("works")).length, 0);
  assert.equal((await core.knowledge.list("policies")).length, 0);
  assert.equal(
    db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND scope = 'work' AND issuer_role = 'core' AND tried LIKE '%policy-marker%'", workId).n,
    0,
    "no policy Decision is opened for an automatically saved lesson",
  );
});

test("item 5: reopening a completed Work hands the Owner's reason to the Manager so it can add Tasks", async (t) => {
  const { root, db } = await openDb(t);
  const replanRequests = [];
  const agentRunner = {
    runManagerPlan: async (request) => {
      if (request.mode === "replan") {
        replanRequests.push(request);
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [{ id: "T2", title: "Follow-up", type: "code", acceptance: "Done.", depends_on: [], replaces: [] }] } };
      }
      return { outcome: "failed", message: "unexpected" };
    },
    runWorker: transientWorkerFailure,
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = newCore(t, db, root, agentRunner);
  const created = await core.createWork(commandEnvelope({ title: "Reopen", summary: "x", size: "small", project_id: null }, "reopen-create"));
  const workId = created.data.work_id;
  await db.createWriteLane().transact((transaction) => {
    insertTask(transaction, workId, { id: createUlid(), status: "completed", managerTaskId: "T1", title: "Done task" });
    transaction.run("UPDATE works SET state = 'completed', state_version = 5, completed_at = ? WHERE id = ?", new Date().toISOString(), workId);
  });
  await core.start();
  await core.reopenWork(workId, commandEnvelope({ reason: "reopen-marker: also add dark mode" }, "reopen", 5));
  const added = await waitFor(() => db.get("SELECT id FROM tasks WHERE work_id = ? AND manager_task_id = 'T2'", workId));
  assert.ok(added, "the Manager should add a Task for the reopen request");
  assert.equal(replanRequests[0].context.question, "reopen-marker: also add dark mode");
  assert.match(replanRequests[0].context.reason, /reopened/u);
});

test("item 6: the owner can cancel memo and ready Works", async (t) => {
  const { root, db } = await openDb(t);
  const core = newCore(t, db, root, { runManagerPlan: async () => ({ outcome: "failed" }), runWorker: async () => ({ outcome: "failed" }), runReviewer: async () => ({ outcome: "failed" }), runAdvisor: async () => ({ reply: "" }) });
  const memo = await core.createWork(commandEnvelope({ title: "Memo", summary: "x", size: "normal", project_id: null }, "memo-create"));
  await core.cancelWork(memo.data.work_id, commandEnvelope({ reason: "not needed" }, "memo-cancel", memo.version));
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", memo.data.work_id).state, "cancelled");

  const ready = await core.createWork(commandEnvelope({ title: "Ready", summary: "x", size: "normal", project_id: null }, "ready-create"));
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = 'ready', state_version = state_version + 1 WHERE id = ?", ready.data.work_id);
  });
  const version = db.get("SELECT state_version FROM works WHERE id = ?", ready.data.work_id).state_version;
  await core.cancelWork(ready.data.work_id, commandEnvelope({ reason: "not needed" }, "ready-cancel", version));
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", ready.data.work_id).state, "cancelled");
});

test("item 7: Core Decisions offer retry/cancel options and the cancel option cancels the Work", async (t) => {
  const { root, db } = await openDb(t);
  const agentRunner = {
    runManagerPlan: async () => ({ outcome: "failed", message: "plan failed" }),
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = newCore(t, db, root, agentRunner);
  await core.start();
  const created = await core.createWork(commandEnvelope({ title: "Cancel option", summary: "x", size: "normal", project_id: null }, "cancel-option-create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, "cancel-option-start", created.version));
  const decision = await waitFor(() => db.get("SELECT id, state_version, question, options_json, allow_free_text FROM decisions WHERE work_id = ? AND status = 'open'", workId));
  assert.ok(decision);
  // The Decision template: what is asked, and what each option does.
  assert.ok(decision.question.length > 0);
  const options = JSON.parse(decision.options_json);
  assert.deepEqual(options.map((option) => option.key), ["retry", "cancel"]);
  for (const option of options) assert.ok(option.label.length > 0 && option.description.length > 0, JSON.stringify(option));
  assert.equal(decision.allow_free_text, 1);
  const announced = await waitFor(() => db.get("SELECT payload_json FROM events WHERE type = 'decision.opened' AND work_id = ?", workId));
  assert.deepEqual(JSON.parse(announced.payload_json).options.map((option) => option.key), ["retry", "cancel"]);

  await core.answerDecision(decision.id, commandEnvelope({ answer: "Workを中止する", option_key: "cancel", source_message_id: null }, "cancel-option-answer", decision.state_version));
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "cancelled");
  assert.equal(db.get("SELECT status FROM decisions WHERE id = ?", decision.id).status, "resolved");
});

test("item 8: a Worker question fails the Task before the Manager replan so the revision is applied", async (t) => {
  const { root, db } = await openDb(t);
  const replanRequests = [];
  let workerCalls = 0;
  const agentRunner = {
    runManagerPlan: async (request) => {
      if (request.context?.mode === "plan") {
        return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{ id: "T1", title: "Original", type: "code", acceptance: "Done.", depends_on: [], replaces: [] }] } };
      }
      if (request.mode === "replan") {
        replanRequests.push(request);
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [{ id: "T1", title: "Revised by Manager", type: "code", acceptance: "Use API v2.", depends_on: [], replaces: [] }] } };
      }
      return { outcome: "failed", message: "unexpected" };
    },
    runWorker: async (request) => {
      workerCalls += 1;
      if (workerCalls === 1) {
        return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, { question_for_manager: "Which API version?" }) };
      }
      return transientWorkerFailure();
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = newCore(t, db, root, agentRunner);
  await core.start();
  const created = await core.createWork(commandEnvelope({ title: "Worker question", summary: "x", size: "normal", project_id: null }, "question-create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, "question-start", created.version));
  const revised = await waitFor(() => db.get("SELECT id FROM tasks WHERE work_id = ? AND title = 'Revised by Manager'", workId));
  assert.ok(revised, "the Manager revision must be applied to the Task");
  assert.equal(replanRequests.length, 1);
  assert.equal(replanRequests[0].context.question, "Which API version?");
  assert.equal(replanRequests[0].context.tasks[0].status, "failed", "the Task is failed before the Manager runs");
  assert.equal(replanRequests[0].context.failed_tasks[0].failure.kind, "replan_requested", "the Manager reads why the Task stopped");
  const firstRun = db.get(
    "SELECT status, report_id FROM agent_runs WHERE task_id = ? AND role = 'worker' ORDER BY created_at ASC LIMIT 1",
    revised.id,
  );
  assert.equal(firstRun.status, "completed");
  assert.ok(firstRun.report_id, "the Worker report is recorded");
  assert.ok(db.get("SELECT 1 FROM events WHERE type = 'task.replan_requested' AND task_id = ?", revised.id));
});

test("item 9: Hybrid retry_subtasks reach the next Worker attempt as context.retry_subtasks", async (t) => {
  const { root, db } = await openDb(t);
  const workerRequests = [];
  const agentRunner = {
    runManagerPlan: async (request) => {
      if (request.context?.mode === "plan") {
        return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{ id: "T1", title: "Hybrid", type: "code", acceptance: "Done.", depends_on: [], replaces: [] }] } };
      }
      return { outcome: "failed", message: "unexpected" };
    },
    runWorker: async (request) => {
      workerRequests.push(request);
      if (workerRequests.length === 1) {
        return {
          outcome: "success",
          report_valid: true,
          report: workerReport(request.invocation_id, {
            verdict: "retry",
            retry_subtasks: [{ subtask_id: "s2", instruction: "Fix the parser edge case" }],
          }),
        };
      }
      return transientWorkerFailure();
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = newCore(t, db, root, agentRunner);
  await core.start();
  const created = await core.createWork(commandEnvelope({ title: "Hybrid retry", summary: "x", size: "normal", project_id: null }, "hybrid-retry-create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, "hybrid-retry-start", created.version));
  assert.ok(await waitFor(() => workerRequests.length >= 2));
  assert.equal(workerRequests[0].context.retry_subtasks, undefined);
  assert.deepEqual(workerRequests[1].context.retry_subtasks, ["s2: Fix the parser edge case"]);
});

// retry_subtasks belong to one line of attempts. A Manager replan or a
// resolved Decision starts a new line (Work-scoped events, task_id NULL), so
// the first Worker after it gets none; a failure without a Worker verdict
// (transient, crash) keeps them.
const hybridPlan = { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{ id: "T1", title: "Hybrid", type: "code", acceptance: "Done.", depends_on: [], replaces: [] }] } };

function hybridRetryReport(request) {
  return {
    outcome: "success",
    report_valid: true,
    report: workerReport(request.invocation_id, {
      verdict: "retry",
      retry_subtasks: [{ subtask_id: "s2", instruction: "Fix the parser edge case" }],
    }),
  };
}

async function startHybridWork(t, agentRunner, suffix) {
  const { root, db } = await openDb(t);
  const core = newCore(t, db, root, agentRunner);
  await core.start();
  const created = await core.createWork(commandEnvelope({ title: `Hybrid ${suffix}`, summary: "x", size: "normal", project_id: null }, `${suffix}-create`));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, `${suffix}-start`, created.version));
  return { db, core, workId };
}

test("item 9b: a Manager replan clears Hybrid retry_subtasks", async (t) => {
  const workerRequests = [];
  let replanned = false;
  let firstAfterReplan = -1;
  const agentRunner = {
    runManagerPlan: async (request) => {
      if (request.context?.mode === "plan") return hybridPlan;
      if (request.mode === "replan") {
        replanned = true;
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [{ id: "T1", title: "Hybrid, replanned", type: "code", acceptance: "Done.", depends_on: [], replaces: [] }] } };
      }
      return { outcome: "failed", message: "unexpected" };
    },
    runWorker: async (request) => {
      workerRequests.push(request);
      // Keep asking for a retry until the Task fails at the threshold and the
      // Manager reopens it: the hybrid record is the Task's latest event.
      if (!replanned) return hybridRetryReport(request);
      if (firstAfterReplan < 0) firstAfterReplan = workerRequests.length - 1;
      return transientWorkerFailure();
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, workId } = await startHybridWork(t, agentRunner, "hybrid-replan");
  assert.ok(await waitFor(() => firstAfterReplan >= 0), "the Worker runs again after the Manager replan");
  assert.deepEqual(workerRequests[1].context.retry_subtasks, ["s2: Fix the parser edge case"], "within one line the instructions are handed on");
  const taskId = db.get("SELECT id FROM tasks WHERE work_id = ? AND manager_task_id = 'T1'", workId).id;
  const latest = db.get(
    `SELECT type, json_extract(payload_json, '$.error_key') AS error_key FROM events
      WHERE task_id = ? AND sequence < (SELECT MIN(sequence) FROM events WHERE type = 'task.replanned' AND json_extract(payload_json, '$.kind') = 'manager_replan_applied')
      ORDER BY sequence DESC LIMIT 1`,
    taskId,
  );
  assert.deepEqual({ ...latest }, { type: "task.failure.classified", error_key: "hybrid_worker_retry_requested" });
  assert.equal(workerRequests[firstAfterReplan].context.retry_subtasks, undefined);
});

test("item 9c: a Decision retry clears Hybrid retry_subtasks", async (t) => {
  const workerRequests = [];
  let answered = false;
  let firstAfterAnswer = -1;
  const agentRunner = {
    runManagerPlan: async (request) => {
      if (request.context?.mode === "plan") return hybridPlan;
      return { outcome: "failed", failure_class: "deterministic", retry_allowed: false, message: "The Manager cannot replan." };
    },
    runWorker: async (request) => {
      workerRequests.push(request);
      if (!answered) return hybridRetryReport(request);
      if (firstAfterAnswer < 0) firstAfterAnswer = workerRequests.length - 1;
      return transientWorkerFailure();
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core, workId } = await startHybridWork(t, agentRunner, "hybrid-decision");
  const decision = await waitFor(() => db.get("SELECT id, state_version FROM decisions WHERE work_id = ? AND status = 'open'", workId), 10_000);
  assert.ok(decision, "the failed replan opens a Decision");
  answered = true;
  await core.answerDecision(decision.id, commandEnvelope({ answer: "もう一度実行する", option_key: "retry", source_message_id: null }, "hybrid-decision-answer", decision.state_version));
  assert.ok(await waitFor(() => firstAfterAnswer >= 0), "the Worker runs again after the Decision");
  assert.deepEqual(workerRequests[1].context.retry_subtasks, ["s2: Fix the parser edge case"]);
  assert.equal(workerRequests[firstAfterAnswer].context.retry_subtasks, undefined);
});

test("a transient failure keeps Hybrid retry_subtasks", async (t) => {
  const workerRequests = [];
  const agentRunner = {
    runManagerPlan: async (request) => {
      if (request.context?.mode === "plan") return hybridPlan;
      return { outcome: "failed", message: "unexpected" };
    },
    runWorker: async (request) => {
      workerRequests.push(request);
      return workerRequests.length === 1 ? hybridRetryReport(request) : transientWorkerFailure();
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, workId } = await startHybridWork(t, agentRunner, "hybrid-transient");
  assert.ok(await waitFor(() => workerRequests.length >= 2));
  const taskId = db.get("SELECT id FROM tasks WHERE work_id = ? AND manager_task_id = 'T1'", workId).id;
  assert.ok(await waitFor(() => db.get(
    "SELECT 1 FROM events WHERE task_id = ? AND type = 'task.failure.classified' AND json_extract(payload_json, '$.failure_class') = 'transient'",
    taskId,
  )));
  // Skip the transient backoff (30 s) so the next attempt starts now.
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE tasks SET next_attempt_at = NULL WHERE id = ?", taskId);
  });
  assert.ok(await waitFor(() => workerRequests.length >= 3), "the Worker runs again after the transient failure");
  assert.deepEqual(workerRequests[1].context.retry_subtasks, ["s2: Fix the parser edge case"]);
  assert.deepEqual(workerRequests[2].context.retry_subtasks, ["s2: Fix the parser edge case"], "a failure without a Worker verdict keeps the instructions");
});
