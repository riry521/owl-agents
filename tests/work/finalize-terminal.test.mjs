import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { createAgentRunner, toolNamesInLine } from "../../packages/agent-runtime/dist/index.js";
import { command as commandEnvelope, createTestCore } from "../helpers/core.mjs";
import { withNecessity } from "../helpers/necessity.mjs";
import { waitFor } from "../helpers/wait.mjs";

// One terminal-Task predicate (a superseded Task counts as terminal)
// and a hardened final-check path (task_id on reports, bounded retry, a
// final_manager_failed Decision that reruns the check instead of replanning).

/** The runner needs the db and root that createTestCore creates, so the Core gets an empty runner object that is filled in right after. */
async function openCore(t, agentRunnerFor) {
  const agentRunner = {};
  const { root, db, core } = await createTestCore(t, { agentRunner, dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 } }, { prefix: "owl-finalize-" });
  Object.assign(agentRunner, withNecessity(agentRunnerFor({ db, root })));
  return { db, core, root };
}

async function waitForLearningJob(db, workId) {
  const job = await waitFor(() => db.get("SELECT * FROM learning_jobs WHERE work_id = ? AND status = 'done'", workId), { timeoutMs: 15_000 });
  assert.ok(job, JSON.stringify(db.all("SELECT status, attempts, last_error FROM learning_jobs WHERE work_id = ?", workId)));
  return job;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FINAL_REVIEW_MARKER = "performing the final review";

/** A real agent runner whose provider answers each prompt with `handler(prompt)`. */
function providerRunner(handler, prompts, extra = {}) {
  return createAgentRunner({
    adapter: "claude-cli/v1",
    ...extra,
    provider: {
      execute: async (request) => {
        const prompt = String(request.prompt ?? request.input ?? JSON.stringify(request));
        prompts.push(prompt);
        const out = await handler(prompt, request);
        return {
          adapter: request.adapter,
          stdout: typeof out === "string" ? out : JSON.stringify(out),
          stderr: "",
          exit_code: 0,
          signal: null,
          format: "plain-text",
        };
      },
    },
  });
}

function managerInput(prompt) {
  const body = prompt.split("### Manager input\n")[1];
  assert.ok(body, "prompt has a Manager input section");
  // The Manager input is the last section of the prompt.
  return JSON.parse(body.trim());
}

function insertTask(tx, workId, { id, status, managerTaskId, title }) {
  const now = new Date().toISOString();
  tx.run(
    `INSERT INTO tasks
       (id, work_id, title, type, status, priority, context, acceptance,
        state_version, failure_count, same_error_count, review_round, worker_generation,
        created_at, updated_at, retry_no, manager_task_id)
     VALUES (?, ?, ?, 'code', ?, 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, ?)`,
    id, workId, title, status, now, now, managerTaskId,
  );
}

function insertReport(tx, workId, taskId) {
  const now = new Date().toISOString();
  const run = createUlid();
  tx.run(
    `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
     VALUES (?, ?, ?, 'worker', 'anthropic', 'm', 'completed', ?, ?)`,
    run, workId, taskId, now, now,
  );
  tx.run(
    `INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at)
     VALUES (?, ?, '1', 'success', ?, ?, 0, ?)`,
    createUlid(), run, JSON.stringify({ kind: "report", result: "success", work_done: `did ${taskId}` }), "0".repeat(64), now,
  );
}

/** A running Work whose Tasks are already terminal, driven only by the final check. */
async function seedFinishedWork(core, db, tasks) {
  const created = await core.createWork(commandEnvelope({ title: "W", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  await db.createWriteLane().transact((tx) => {
    for (const task of tasks) {
      insertTask(tx, workId, task);
      if (task.withReport) insertReport(tx, workId, task.id);
    }
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    return null;
  });
  return workId;
}

function workerReport(invocationId) {
  return {
    kind: "report",
    schema_version: "1.0.0",
    invocation_id: invocationId,
    result: "success",
    work_done: "Done.",
    changes: [],
    verification: { passed: true, method: "Checked." },
    remaining_issues: [],
    next_action: "none",
    needs_replanning: false,
    question_for_manager: null,
  };
}

const completeVerdict = { verdict: { verdict: "complete", summary: "done", missing: [], lessons: [] } };

const ruleLesson = (rule_text, rule_scope = "worker") => ({
  lesson: `Learned: ${rule_text}`,
  basis: "The Work showed this.",
  applies_to: "Future shared work.",
  kind: "rule_candidate",
  topic: "shared work",
  procedure: "",
  rule_text,
  rule_scope,
});

async function saveFinalVerdict(t, verdict) {
  const { db, core, root } = await openCore(t, () => ({
    runManagerPlan: async (request) => request.mode === "finalize"
      ? { outcome: "success", report_valid: true, report: { tasks: request.tasks ?? [], event: null, verdict } }
      : { outcome: "failed", message: "unexpected" },
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  }));
  const done = createUlid();
  const workId = await seedFinishedWork(core, db, [
    { id: done, status: "completed", managerTaskId: "T1", title: "done", withReport: true },
  ]);
  await core.start();
  await core.tick(workId);
  return { db, core, root, workId };
}

test("a complete Work enqueues a worker-scoped rule candidate for approval", async (t) => {
  const { db, core, workId } = await saveFinalVerdict(t, {
    verdict: "complete", summary: "Done.", missing: [], lessons: [ruleLesson("Use the shared lock.")],
  });
  const job = await waitForLearningJob(db, workId);
  const proposal = db.get("SELECT * FROM rule_proposals WHERE id = ?", JSON.parse(job.result_json).rule_proposal_ids[0]);
  assert.equal(proposal.status, "awaiting_approval");
  assert.equal(proposal.level, "role");
  assert.equal(proposal.role, "worker");
  assert.equal(proposal.text, "Use the shared lock.");
  assert.equal(db.get("SELECT source_ref FROM rule_proposal_sources WHERE proposal_id = ?", proposal.id).source_ref, workId);
  assert.equal((await core.knowledge.list("policies")).length, 0);
});

test("a complete Work routes a legacy proposes_rule lesson through the learning queue", async (t) => {
  const { db, core, workId } = await saveFinalVerdict(t, {
    verdict: "complete", summary: "Done.", missing: [], lessons: [
      { lesson: "Legacy rule text.", basis: "Legacy evidence.", applies_to: "Future Work.", proposes_rule: true },
    ],
  });
  const job = await waitForLearningJob(db, workId);
  const proposal = db.get("SELECT * FROM rule_proposals WHERE id = ?", JSON.parse(job.result_json).rule_proposal_ids[0]);
  assert.equal(proposal.status, "awaiting_approval");
  assert.equal(proposal.origin, "lesson");
  assert.equal(proposal.level, "system");
  assert.equal(proposal.text, "Legacy rule text.");
  assert.equal(proposal.rationale, "Legacy evidence.");
  assert.equal((await core.knowledge.list("policies")).length, 0);
});

test("a fact lesson is routed to a knowledge note without creating a rule proposal", async (t) => {
  const { db, core, workId } = await saveFinalVerdict(t, {
    verdict: "complete", summary: "Done.", missing: [], lessons: [{
      lesson: "A stable fact.", basis: "The Work showed it.", applies_to: "Future Work.",
      kind: "fact", topic: "stable fact", procedure: "", rule_text: "", rule_scope: "all",
    }],
  });
  const job = await waitForLearningJob(db, workId);
  const { routes } = JSON.parse(job.result_json);
  assert.equal(routes.length, 1, job.result_json);
  assert.equal(routes[0].kind, "fact");
  assert.equal(routes[0].status, "appended");
  assert.match(routes[0].page, /^common\//u);
  const page = await readFile(join(core.knowledge.knowledgeDir, routes[0].page), "utf8");
  assert.match(page, /A stable fact\./u);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM rule_proposals").n, 0);
  assert.equal((await core.knowledge.list("works")).length, 1, "the Work log page");
  assert.equal((await core.knowledge.list("policies")).length, 0);
});

test("repeated final lessons deduplicate rule proposals by text and scope", async (t) => {
  let finalizeCalls = 0;
  const { db, core } = await createTestCore(t, {
    agentRunner: {
      runManagerPlan: async (request) => {
        if (request.mode === "replan") {
          return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [] } };
        }
        if (request.mode !== "finalize") return { outcome: "failed", message: "unexpected" };
        finalizeCalls += 1;
        const lessons = finalizeCalls === 1
          ? [ruleLesson("candidate-1", "all")]
          : finalizeCalls === 2
            ? [ruleLesson("candidate-2", "all")]
            : [ruleLesson("candidate-3", "all"), ruleLesson("candidate-3", "worker")];
        return {
          outcome: "success",
          report_valid: true,
          report: {
            tasks: request.tasks ?? [],
            event: null,
            verdict: {
              verdict: finalizeCalls === 1 ? "incomplete" : "complete",
              summary: "Done.",
              missing: finalizeCalls === 1 ? [{ item: "docs", reason: "missing", fix: "" }] : [],
              lessons,
            },
          },
        };
      },
      runWorker: async () => ({ outcome: "failed" }),
      runReviewer: async () => ({ outcome: "failed" }),
      runAdvisor: async () => ({ reply: "" }),
    },
    dispatcher: { tick_interval_ms: 25 },
  }, { prefix: "owl-finalize-lesson-merge-" });
  const done = createUlid();
  const workId = await seedFinishedWork(core, db, [
    { id: done, status: "completed", managerTaskId: "T1", title: "done", withReport: true },
  ]);
  await core.start();
  await core.tick(workId);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "judgement_waiting");
  const incompleteDecision = db.get("SELECT id, state_version, options_json FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.ok(incompleteDecision, "the incomplete verdict opens an Owner retry Decision");
  const retryOption = JSON.parse(incompleteDecision.options_json).find((option) => option.key === "retry");
  await core.answerDecision(incompleteDecision.id, commandEnvelope(
    { answer: retryOption.label, option_key: "retry", source_message_id: null },
    "retry-final-review",
    incompleteDecision.state_version,
  ));
  assert.ok(await waitFor(() => finalizeCalls >= 2 && db.get("SELECT state FROM works WHERE id = ?", workId).state === "completed"));
  await waitForLearningJob(db, workId);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM rule_proposals").n, 2);

  let version = db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;
  await core.reopenWork(workId, commandEnvelope({ reason: "Add both scopes of the third rule." }, "candidate-3-scopes", version));
  assert.ok(await waitFor(() => finalizeCalls >= 3 && db.get("SELECT state FROM works WHERE id = ?", workId).state === "completed"));
  await waitFor(() => db.get("SELECT COUNT(*) AS n FROM rule_proposals").n === 4, { timeoutMs: 15_000 });
  const proposals = db.all("SELECT text, level, role, status FROM rule_proposals ORDER BY text, level, role");
  assert.deepEqual(proposals, [
    { text: "candidate-1", level: "system", role: null, status: "awaiting_approval" },
    { text: "candidate-2", level: "system", role: null, status: "awaiting_approval" },
    { text: "candidate-3", level: "role", role: "worker", status: "awaiting_approval" },
    { text: "candidate-3", level: "system", role: null, status: "awaiting_approval" },
  ]);

  version = db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;
  await core.reopenWork(workId, commandEnvelope({ reason: "Repeat both scopes of the third rule." }, "repeat-candidate-3-scopes", version));
  assert.ok(await waitFor(() => finalizeCalls >= 4 && db.get("SELECT state FROM works WHERE id = ?", workId).state === "completed"));
  await waitForLearningJob(db, workId);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM rule_proposals").n, 4);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM rule_proposal_sources WHERE source_kind = 'work' AND source_ref = ?", workId).n, 4);
  assert.equal((await core.knowledge.list("policies")).length, 0);
});

test("a Work with a superseded (cancelled) Task completes on a complete final verdict", async (t) => {
  let finalizeCalls = 0;
  let replanCalls = 0;
  const { db, core } = await openCore(t, ({ db }) => ({
    runManagerPlan: async (request) => {
      if (request.mode === "finalize") {
        finalizeCalls += 1;
        return {
          outcome: "success",
          report_valid: true,
          report: { tasks: request.tasks ?? [], event: null, verdict: completeVerdict.verdict },
        };
      }
      if (request.mode === "replan") {
        replanCalls += 1;
        return {
          outcome: "success",
          report_valid: true,
          report: { event: "task.replanned", tasks: [{ id: "T9", title: "Replacement", type: "research", acceptance: "Done.", depends_on: [], required_sections: [], required_tests: [], replaces: ["T1"], review: false }] },
        };
      }
      return {
        outcome: "success",
        report_valid: true,
        report: { event: "work.planned", tasks: [{ id: "T1", title: "Original", type: "research", acceptance: "Done.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false }] },
      };
    },
    runWorker: async (request) => {
      const row = db.get("SELECT manager_task_id FROM tasks WHERE id = ?", request.task_id ?? request.context?.task_id ?? request.task?.id);
      if (row?.manager_task_id === "T1") {
        return { outcome: "failed", failure_class: "deterministic", error_key: "same_err", retry_allowed: true, message: "broken" };
      }
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  }));
  await core.start();
  const created = await core.createWork(commandEnvelope({ title: "Supersede", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, "start", created.version));

  const state = await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "completed" && "completed", { timeoutMs: 8_000 });
  assert.equal(state, "completed", `Work state: ${db.get("SELECT state FROM works WHERE id = ?", workId).state}`);
  const tasks = db.all("SELECT manager_task_id, status FROM tasks WHERE work_id = ? ORDER BY manager_task_id", workId);
  assert.deepEqual(tasks, [
    { manager_task_id: "T1", status: "cancelled" },
    { manager_task_id: "T9", status: "completed" },
  ]);
  assert.equal(replanCalls, 1);
  // The driver stops after completion: no final check loop.
  await sleep(300);
  assert.equal(finalizeCalls, 1);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND status = 'open'", workId).n, 0);
});

test("finalize input carries task_id per report, omits cancelled Tasks' reports, and survives a completed Task without a stored report", async (t) => {
  const prompts = [];
  const { db, core } = await openCore(t, () => providerRunner(
    (prompt) => (prompt.includes(FINAL_REVIEW_MARKER) ? completeVerdict : { tasks: [] }),
    prompts,
    { outputLogDir: null },
  ));
  const done = createUlid();
  const superseded = createUlid();
  const lostReport = createUlid();
  const workId = await seedFinishedWork(core, db, [
    { id: done, status: "completed", managerTaskId: "T1", title: "done one", withReport: true },
    { id: superseded, status: "cancelled", managerTaskId: "T2", title: "superseded one", withReport: true },
    { id: lostReport, status: "completed", managerTaskId: "T3", title: "report row lost", withReport: false },
  ]);
  await core.start();
  for (let i = 0; i < 3; i += 1) await core.tick(workId);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  const finalPrompts = prompts.filter((prompt) => prompt.includes(FINAL_REVIEW_MARKER));
  assert.equal(finalPrompts.length, 1);
  const input = managerInput(finalPrompts[0]);
  assert.equal(input.mode, "finalize");
  // One report, for the completed Task that has one, linked by task_id.
  assert.deepEqual(input.reports.map((report) => report.task_id), [done]);
  assert.equal(input.reports[0].work_done, `did ${done}`);
  // Every Task is listed through the Manager view (no Core internals).
  assert.deepEqual(input.tasks.map((task) => [task.id, task.status]).sort(), [
    [done, "completed"],
    [superseded, "cancelled"],
    [lostReport, "completed"],
  ].sort());
  for (const task of input.tasks) {
    // hardcode-check-allow whole-list-equal: 契約として固定された一覧の完全一致を確かめるため、現状の値を意図して比べている
    assert.deepEqual(Object.keys(task).sort(), [
      "acceptance_criteria", "context", "depends_on", "failure_count", "id", "manager_notes", "manager_task_id", "necessity", "plan_context_legacy", "review_round", "status", "title", "type",
    ]);
  }
  assert.match(finalPrompts[0], /reports\[\]\.task_id links each report to a Task in tasks/);
  assert.match(finalPrompts[0], /do not count their absence as missing work/);
});

test("a malformed final answer is retried once, then opens a final_manager_failed Decision; answering retry reruns the final check without a replan", async (t) => {
  const prompts = [];
  let finalCalls = 0;
  const { db, core, root } = await openCore(t, ({ root }) => providerRunner(
    (prompt) => {
      if (!prompt.includes(FINAL_REVIEW_MARKER)) return { tasks: [] };
      finalCalls += 1;
      return finalCalls <= 2 ? "Sorry, rate limited" : completeVerdict;
    },
    prompts,
    { outputLogDir: join(root, "agent-output") },
  ));
  const done = createUlid();
  const workId = await seedFinishedWork(core, db, [
    { id: done, status: "completed", managerTaskId: "T1", title: "done", withReport: true },
  ]);
  await core.start();
  await core.tick(workId);

  // Attempt 1 and its single retry both broke the contract.
  assert.equal(finalCalls, 2);
  const work = db.get("SELECT state FROM works WHERE id = ?", workId);
  assert.equal(work.state, "judgement_waiting");
  const alert = db.get(
    "SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert' ORDER BY sequence DESC LIMIT 1",
    workId,
  );
  assert.equal(JSON.parse(alert.payload_json).kind, "final_manager_failed");
  const decision = db.get("SELECT id, question, reason, options_json, recommended FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.ok(decision, "an open Decision");
  assert.equal(decision.question, "最終チェックに失敗しました。もう一度実行しますか？");
  assert.equal(decision.reason.includes("未完了と判定"), false, "the reason must not claim an incomplete verdict");
  assert.deepEqual(JSON.parse(decision.options_json).map((option) => option.key), ["retry", "cancel"]);
  assert.equal(decision.recommended, "retry");
  // The role-shaped runner path keeps the broken answers for the operator.
  const logs = await readdir(join(root, "agent-output"));
  assert.equal(logs.length, 2);
  assert.match(await readFile(join(root, "agent-output", logs[0]), "utf8"), /role: manager/);

  await core.answerDecision(decision.id, commandEnvelope({ answer: "最終チェックをやり直す", option_key: "retry", source_message_id: null }, "answer"));
  const completed = await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "completed", { timeoutMs: 5_000 });
  assert.ok(completed, `Work state: ${db.get("SELECT state FROM works WHERE id = ?", workId).state}`);
  assert.equal(finalCalls, 3);
  assert.equal(prompts.some((prompt) => prompt.includes("This is a REPLAN")), false, "no Manager replan");
  assert.equal(prompts.some((prompt) => prompt.includes("final review judged the Work incomplete")), false);
});

test("an instruction posted during the final check is replanned before the Work completes", async (t) => {
  const prompts = [];
  let finalCalls = 0;
  let core;
  let workId;
  const opened = await openCore(t, () => providerRunner(
    async (prompt) => {
      if (!prompt.includes(FINAL_REVIEW_MARKER)) return { tasks: [] };
      finalCalls += 1;
      if (finalCalls === 1) {
        await core.postWorkInstruction(workId, commandEnvelope({ body: "Also add a changelog entry" }, "during-final", 1));
      }
      return completeVerdict;
    },
    prompts,
  ));
  core = opened.core;
  const { db } = opened;
  workId = await seedFinishedWork(core, db, [
    { id: createUlid(), status: "completed", managerTaskId: "T1", title: "done", withReport: true },
  ]);
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state_version = 1 WHERE id = ?", workId);
  });
  await core.start();
  await core.tick(workId);
  assert.equal(finalCalls, 1);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  await core.tick(workId);
  assert.ok(prompts.some((prompt) => prompt.includes("Also add a changelog entry")), "the Manager received the instruction");
  assert.ok(await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "completed"));
  assert.equal(finalCalls, 2);
});

test("an incomplete final verdict enqueues proposed rules while waiting for Owner review", async (t) => {
  const { db, core } = await openCore(t, () => ({
    runManagerPlan: async (request) => {
      if (request.mode === "finalize") {
        return {
          outcome: "success",
          report_valid: true,
          report: {
            tasks: request.tasks ?? [],
            event: null,
            verdict: {
              verdict: "incomplete",
              summary: "The docs are missing.",
              missing: [{ item: "docs", reason: "not written", fix: "" }],
              lessons: [{ lesson: "lesson-marker", basis: "seen here", applies_to: "future Work", proposes_rule: true }],
            },
          },
        };
      }
      return { outcome: "failed", message: "unexpected" };
    },
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  }));
  const done = createUlid();
  const workId = await seedFinishedWork(core, db, [
    { id: done, status: "completed", managerTaskId: "T1", title: "done", withReport: true },
  ]);
  await core.start();
  await core.tick(workId);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "judgement_waiting");
  const alert = db.get(
    "SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert' ORDER BY sequence DESC LIMIT 1",
    workId,
  );
  assert.equal(JSON.parse(alert.payload_json).kind, "final_manager_incomplete");

  const job = await waitForLearningJob(db, workId);
  const result = JSON.parse(job.result_json);
  const proposal = db.get("SELECT * FROM rule_proposals WHERE id = ?", result.rule_proposal_ids[0]);
  assert.equal(proposal.status, "awaiting_approval");
  assert.equal(proposal.text, "lesson-marker");
  assert.equal(proposal.rationale, "seen here");
  assert.equal((await core.knowledge.list("works")).length, 1, "the Work log page");
  assert.equal((await core.knowledge.list("policies")).length, 0);
  assert.equal(
    db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND scope = 'work' AND issuer_role = 'core' AND tried LIKE '%lesson-marker%'", workId).n,
    0,
    "a proposed-rule lesson does not open a policy Decision",
  );
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "judgement_waiting", "the incomplete final verdict still waits for owner review");
});

test("reopening a completed Work does not depend on its size", async (t) => {
  const { db, core } = await openCore(t, () => ({
    runManagerPlan: async () => ({ outcome: "failed", message: "unexpected" }),
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  }));
  const created = await core.createWork(commandEnvelope({ title: "Normal work", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE works SET state = 'completed', state_version = state_version + 1, completed_at = ? WHERE id = ?", new Date().toISOString(), workId);
    return null;
  });
  const version = db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;

  await core.reopenWork(workId, commandEnvelope({ reason: "please add one more thing" }, "reopen", version));

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  const marker = db.get(
    "SELECT json_extract(response_json, '$.status') AS status FROM idempotency_keys WHERE key = ?",
    `owner-replan:${workId}`,
  );
  assert.equal(marker?.status, "queued", "an Owner replan is queued for the next tick");
});

function incompleteRunner(replans, missing) {
  return () => ({
    runManagerPlan: async (request) => {
      if (request.mode === "replan") {
        replans.push(JSON.stringify(request));
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [] } };
      }
      if (request.mode !== "finalize") return { outcome: "failed", message: "unexpected" };
      return {
        outcome: "success",
        report_valid: true,
        report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "incomplete", summary: "Docs missing.", missing, lessons: [] } },
      };
    },
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  });
}

async function seedAndTick(core, db, limit) {
  const workId = await seedFinishedWork(core, db, [
    { id: createUlid(), status: "completed", managerTaskId: "T1", title: "done", withReport: true },
  ]);
  await db.createWriteLane().transact((tx) => {
    tx.run(
      "INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('final_auto_continue_limit', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify(limit),
      new Date().toISOString(),
    );
    return null;
  });
  await core.start();
  await core.tick(workId);
  return workId;
}

test("an incomplete final verdict with fixes creates an extra Task and keeps the Work running", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const replans = [];
  const workerTasks = [];
  const { db, core } = await openCore(t, ({ db }) => ({
    runManagerPlan: async (request) => {
      if (request.mode === "replan") {
        replans.push(JSON.stringify(request));
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [{ id: "T9", title: "Write docs", type: "research", acceptance: "Done.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false }] } };
      }
      if (request.mode !== "finalize") return { outcome: "failed", message: "unexpected" };
      return { outcome: "success", report_valid: true, report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "incomplete", summary: "Docs missing.", missing: [{ item: "docs", reason: "not written", fix: "write them" }], lessons: [] } } };
    },
    runWorker: async (request) => {
      workerTasks.push(db.get("SELECT manager_task_id FROM tasks WHERE id = ?", request.task_id ?? request.context?.task_id ?? request.task?.id)?.manager_task_id);
      await gate;
      return { outcome: "failed" };
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  }));
  const workId = await seedAndTick(core, db, 1);

  assert.ok(await waitFor(() => db.get("SELECT id FROM tasks WHERE work_id = ? AND manager_task_id = 'T9'", workId)), "the extra Task was created");
  assert.equal(replans.length, 1);
  assert.match(replans[0], /write them/, "the verdict reached the Manager as final_verdict");
  assert.ok(await waitFor(() => workerTasks.includes("T9")), "the extra Task was started");
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ?", workId).n, 0);
});

test("automatic continuation stops at the configured limit and then waits for the Owner", async (t) => {
  const replans = [];
  const { db, core } = await openCore(t, incompleteRunner(replans, [{ item: "docs", reason: "not written", fix: "write them" }]));
  const workId = await seedAndTick(core, db, 1);

  assert.ok(await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId).state === "judgement_waiting"));
  assert.equal(replans.length, 1, "exactly one automatic round ran");
  const alerts = db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert' ORDER BY sequence", workId).map((row) => JSON.parse(row.payload_json));
  assert.equal(alerts.filter((alert) => alert.auto_continue === 1).length, 1);
  assert.equal(alerts.at(-1).kind, "final_manager_incomplete");
  assert.equal(alerts.at(-1).driver_stopped, true);
});

/** A runner whose Manager finalize call fails with a 529 after an optional tool call; returns the call counter. */
function failingFinalRunner(toolName) {
  const state = { finalCalls: 0 };
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    provider: { toolNamesInLine,
      execute: async (request) => {
        const prompt = String(request.prompt ?? request.input ?? JSON.stringify(request));
        if (!prompt.includes(FINAL_REVIEW_MARKER)) return { adapter: request.adapter, stdout: JSON.stringify({ tasks: [] }), stderr: "", exit_code: 0, signal: null, format: "plain-text" };
        state.finalCalls += 1;
        const stdout = toolName ? `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: toolName, input: {} }] } })}\n` : "";
        return { adapter: request.adapter, stdout, stderr: "API Error: 529 overloaded_error", exit_code: 1, signal: null, format: "provider-json" };
      },
    },
  });
  return { runner, state };
}

test("a Final Manager failure after a side effect is not retried by Core, and one without is", async (t) => {
  const results = {};
  for (const [label, toolName] of [["side_effect", "mcp__slack__post_message"], ["none", null]]) {
    const { runner, state } = failingFinalRunner(toolName);
    const { db, core } = await openCore(t, () => runner);
    const workId = await seedFinishedWork(core, db, [
      { id: createUlid(), status: "completed", managerTaskId: "T1", title: "done", withReport: true },
    ]);
    await core.start();
    await core.tick(workId);
    const alert = db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert' ORDER BY sequence DESC LIMIT 1", workId);
    results[label] = { calls: state.finalCalls, alert: JSON.parse(alert.payload_json) };
  }
  assert.equal(results.side_effect.calls, 1);
  assert.equal(results.side_effect.alert.kind, "final_manager_failed"); assert.equal(results.side_effect.alert.outcome, "failed_after_side_effect"); assert.equal(results.side_effect.alert.retry_allowed, false); assert.equal(results.none.alert.outcome, undefined);
  assert.equal(results.none.calls, 2);
});

test("a rate-limited final check pauses the Provider without a Decision, keeps its attempts, and reruns after the pause ends", async (t) => {
  const NOW = "2030-01-02T03:04:05.000Z";
  const limit = { resets_at: NOW, source: "event" };
  const rateLimited = {
    returned: () => ({ outcome: "failed", failure_class: "rate_limited", error_key: "rate_limited", rate_limit: limit, message: "limit", skill_feedback: null }),
    thrown: () => Object.assign(new Error("limit"), { failure_class: "rate_limited", rate_limit: limit, outcome: "failed_after_side_effect", retry_allowed: false }),
  };
  for (const [label, makeLimit] of Object.entries(rateLimited)) {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(NOW) });
    let finalCalls = 0;
    const { db, core } = await openCore(t, () => ({
      runManagerPlan: async (request) => {
        assert.equal(request.mode, "finalize");
        finalCalls += 1;
        if (finalCalls === 1) {
          const limited = makeLimit();
          if (limited instanceof Error) throw limited;
          return limited;
        }
        return { outcome: "success", report_valid: true, report: { tasks: request.tasks ?? [], event: null, verdict: completeVerdict.verdict } };
      },
      runWorker: async () => ({ outcome: "failed" }),
      runReviewer: async () => ({ outcome: "failed" }),
      runAdvisor: async () => ({ reply: "" }),
    }));
    const workId = await seedFinishedWork(core, db, [
      { id: createUlid(), status: "completed", managerTaskId: "T1", title: "done", withReport: true },
    ]);
    await core.start();
    await core.tick(workId);

    const count = (type) => db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = ?", workId, type).n;
    assert.equal(finalCalls, 1, `${label}: the limited call is not retried while paused`);
    assert.equal(count("decision.opened"), 0, label);
    assert.equal(count("system.alert"), 0, label);
    assert.equal(count("manager.rate_limited"), 1, label);
    assert.ok(db.get("SELECT provider FROM provider_pauses WHERE resume_at IS NOT NULL"), `${label}: the Provider is paused`);
    assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running", label);

    t.mock.timers.tick(30_000);
    for (let i = 0; i < 500 && db.get("SELECT state FROM works WHERE id = ?", workId).state !== "completed"; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(finalCalls, 2, `${label}: the final check runs again after the pause`);
    assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed", label);
    t.mock.timers.reset();
  }
});
