import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { openPinnedFile } from "../../packages/core/dist/advisor-send-file.js";
import { createCore } from "../../packages/core/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import * as advisorResponse from "../../packages/shared/dist/advisor-response.js";
import { command } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { tempDir } from "../helpers/temp.mjs";

async function setup(t, coreOptions = {}) {
  const root = await tempDir(t, "owl-advisor-work-actions-");
  const db = createTestDatabase(root);
  const advisorReplies = [];
  const advisorRequests = [];
  const cancelledRuns = [];
  const agentRunner = {
    cancelAgent: async (runId) => { cancelledRuns.push(runId); },
    runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async (request) => {
      advisorRequests.push(request);
      return { reply: advisorReplies.shift() ?? "Unexpected empty test Advisor response." };
    },
  };
  const core = createCore({ db, agentRunner, version: "advisor-work-actions-test", owlRoot: root, dataDir: root, ...coreOptions });
  t.after(async () => {
    await core.stop({ force: true }).catch(() => {});
    db.close();
  });
  const { conversation_id: conversationId } = await core.getActiveConversation();
  // `followupActions` is the reply to the automatic follow-up turn that a failed action starts.
  async function respond(actions, text = "Please perform this Work operation.", followupActions = null) {
    const accountId = db.get("SELECT id FROM connector_accounts WHERE owner_id = 'owner:default' AND provider = 'web'").id;
    const userMessageId = createUlid();
    const now = new Date().toISOString();
    await db.createWriteLane().transact((transaction) => {
      transaction.run(
        `INSERT INTO messages
           (id, conversation_id, provider, account_id, source_message_id, body,
            attachment_ids_json, received_at, created_at)
         VALUES (?, ?, 'web', ?, ?, ?, '[]', ?, ?)`,
        userMessageId,
        conversationId,
        accountId,
        `web-user:${userMessageId}`,
        text,
        now,
        now,
      );
    });

    const requestCount = advisorRequests.length;
    advisorReplies.push([
      text,
      "```owl-actions",
      JSON.stringify(actions),
      "```",
    ].join("\n"));
    if (followupActions) advisorReplies.push(["Retrying.", "```owl-actions", JSON.stringify(followupActions), "```"].join("\n"));
    await core.advisorRespond(conversationId, userMessageId, { channel: "slack" });

    // A failed action runs the one follow-up Advisor turn, so the stub is called once, or twice after a failure.
    assert.ok([requestCount + 1, requestCount + 2].includes(advisorRequests.length), "the user message should run through the stub Advisor");
    assert.ok(advisorRequests[requestCount].messages.some((message) => message.source === "user" && message.body === text));
    const message = db.get(
      `SELECT id, body FROM messages
        WHERE conversation_id = ? AND source_message_id LIKE 'advisor:%'
          AND rowid > (SELECT rowid FROM messages WHERE id = ?)
        ORDER BY rowid ASC LIMIT 1`,
      conversationId,
      userMessageId,
    );
    return { messageId: message.id, body: message.body };
  }

  return { db, core, conversationId, respond, cancelledRuns };
}

async function createWorkInState(core, db, state, suffix) {
  const created = await core.createWork(command({
    title: `Work ${suffix}`,
    summary: "Original summary",
    size: "small",
    project_id: null,
  }, `advisor-work-test:create:${suffix}`));
  const workId = created.data.work_id;
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = ?, state_version = 1 WHERE id = ?", state, workId);
  });
  return workId;
}

function action(type, payload = {}) {
  return { type, description: type, payload };
}

function ownerReplan(db, workId) {
  const row = db.get("SELECT response_json FROM idempotency_keys WHERE key = ?", `owner-replan:${workId}`);
  return row ? JSON.parse(row.response_json) : null;
}

test("send_work_instruction reaches the target Work through an Advisor turn", async (t) => {
  const { db, core, respond } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "instruction");

  const first = await respond([action("send_work_instruction", { work_id: workId, body: "Add coverage" })]);
  const workConversation = core.getWork(workId).data.conversation_id;
  assert.ok(workConversation);
  assert.equal(db.get("SELECT body FROM messages WHERE conversation_id = ?", workConversation).body, "Add coverage");
  assert.equal(ownerReplan(db, workId).kind, "instruction");
  assert.match(first.body, /指示を送りました/u);
});

test("update_work changes the title and summary and queues an Owner replan while running", async (t) => {
  const { db, core, respond } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "update");

  const { body } = await respond([action("update_work", {
    work_id: workId,
    title: "Revised title",
    summary: "Revised summary",
  })]);

  assert.deepEqual({ ...db.get("SELECT title, summary FROM works WHERE id = ?", workId) }, {
    title: "Revised title", summary: "Revised summary",
  });
  assert.equal(ownerReplan(db, workId).kind, "work_update");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'work.updated'", workId).n, 1);
  assert.match(body, /タイトルと概要を更新しました/u);
  assert.match(body, /計画の見直し/u);
});

test("pause_work followed by resume_work pauses and resumes the Work", async (t) => {
  const { db, core, respond } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "pause-resume");
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO tasks
         (id, work_id, title, type, status, priority, context, acceptance, state_version,
          failure_count, same_error_count, review_round, worker_generation, created_at, updated_at,
          retry_no, manager_task_id)
       VALUES (?, ?, 'Active task', 'research', 'running', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`,
      createUlid(),
      workId,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  });

  const paused = await respond([action("pause_work", { work_id: workId })]);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "paused");
  assert.match(paused.body, /一時停止しました/u);

  const resumed = await respond([action("resume_work", { work_id: workId })]);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  assert.match(resumed.body, /再開しました/u);
});

test("pause_work through the Advisor stops the running Worker and Manager and pauses the Tasks", async (t) => {
  const { db, core, respond, cancelledRuns } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "pause-stops-agents");
  const taskId = createUlid();
  const workerRunId = createUlid();
  const managerRunId = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO tasks
         (id, work_id, title, type, status, priority, context, acceptance, state_version,
          failure_count, same_error_count, review_round, worker_generation, created_at, updated_at,
          retry_no, manager_task_id)
       VALUES (?, ?, 'Active task', 'research', 'running', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`,
      taskId, workId, now, now,
    );
    for (const [id, role, runTaskId] of [[workerRunId, "worker", taskId], [managerRunId, "manager", null]]) {
      transaction.run(
        `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, fencing_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'test', 'test', 'running', ?, ?, ?)`,
        id, workId, runTaskId, role, id, now, now,
      );
    }
  });

  await respond([action("pause_work", { work_id: workId })]);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "paused");
  assert.deepEqual({ ...db.get("SELECT status, paused_from FROM tasks WHERE id = ?", taskId) }, { status: "paused", paused_from: "ready" });
  assert.deepEqual(new Set(cancelledRuns), new Set([workerRunId, managerRunId]));
  assert.deepEqual(db.all("SELECT id FROM agent_runs WHERE work_id = ? AND status = 'running'", workId), []);
});

test("send_work_instruction through the Advisor stops the running Worker, not the Manager, and returns the Task to ready", async (t) => {
  const { db, core, respond, cancelledRuns } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "instruction-stops-worker");
  const taskId = createUlid();
  const workerRunId = createUlid();
  const managerRunId = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO tasks
         (id, work_id, title, type, status, priority, context, acceptance, state_version,
          failure_count, same_error_count, review_round, worker_generation, created_at, updated_at,
          retry_no, manager_task_id)
       VALUES (?, ?, 'Active task', 'research', 'running', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`,
      taskId, workId, now, now,
    );
    for (const [id, role, runTaskId] of [[workerRunId, "worker", taskId], [managerRunId, "manager", null]]) {
      transaction.run(
        `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, fencing_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'test', 'test', 'running', ?, ?, ?)`,
        id, workId, runTaskId, role, id, now, now,
      );
    }
  });

  await respond([action("send_work_instruction", { work_id: workId, body: "Change course" })]);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  assert.equal(db.get("SELECT status FROM tasks WHERE id = ?", taskId).status, "ready");
  assert.equal(db.get("SELECT failure_count FROM tasks WHERE id = ?", taskId).failure_count, 0);
  assert.deepEqual(cancelledRuns, [workerRunId], "only the Worker is signalled");
  assert.equal(ownerReplan(db, workId).kind, "instruction");
});

test("resume_work retries a judgement_waiting Work with an open retry Decision", async (t) => {
  const { db, core, respond } = await setup(t);
  const workId = await createWorkInState(core, db, "judgement_waiting", "retry");
  const decisionId = createUlid();
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO decisions
         (id, work_id, scope, status, blocked_task_ids_json, reason, question, tried, current_state,
          options_json, recommended, allow_free_text, issuer_role, state_version, created_at)
       VALUES (?, ?, 'work', 'open', '[]', 'retry', 'Try again?', '', 'judgement_waiting',
               ?, 'retry', 1, 'core', 0, ?)`,
      decisionId,
      workId,
      JSON.stringify([{ key: "retry", label: "Retry" }, { key: "cancel", label: "Cancel" }]),
      new Date().toISOString(),
    );
  });

  const { body } = await respond([action("resume_work", { work_id: workId })]);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  assert.equal(db.get("SELECT status FROM decisions WHERE id = ?", decisionId).status, "resolved");
  assert.match(body, /再試行を指示しました/u);
});

for (const freeText of [1, 0]) test(`resume_work with body records it as the retry Decision answer (allow_free_text=${freeText})`, async (t) => {
  const { db, core, respond } = await setup(t);
  const workId = await createWorkInState(core, db, "judgement_waiting", "retry-body");
  const decisionId = createUlid();
  await db.createWriteLane().transact((transaction) => {
    transaction.run(
      `INSERT INTO decisions
         (id, work_id, scope, status, blocked_task_ids_json, reason, question, tried, current_state,
          options_json, recommended, allow_free_text, issuer_role, state_version, created_at)
       VALUES (?, ?, 'work', 'open', '[]', 'retry', 'Try again?', '', 'judgement_waiting',
               ?, 'retry', ?, 'core', 0, ?)`,
      decisionId,
      workId,
      JSON.stringify([{ key: "retry", label: "Retry" }]),
      freeText,
      new Date().toISOString(),
    );
  });

  await respond([action("resume_work", { work_id: workId, body: "別の方法で試す" })]);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  const row = db.get("SELECT answer_json, source FROM decision_answers WHERE decision_id = ?", decisionId);
  assert.equal(JSON.parse(row.answer_json).answer, "別の方法で試す");
  assert.equal(JSON.parse(row.answer_json).option_key, "retry");
  assert.equal(row.source, "advisor");
});

test("cancel_work cancels the selected Work and appends a success notice", async (t) => {
  const { db, core, respond } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "cancel");

  const { body } = await respond([action("cancel_work", { work_id: workId, reason: "No longer needed" })]);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "cancelled");
  assert.match(body, /キャンセルしました/u);
});

test("delete_work removes memo, ready, completed and cancelled Works from the DB", async (t) => {
  const { db, core, respond } = await setup(t);
  for (const state of ["memo", "ready", "completed", "cancelled"]) {
    const workId = await createWorkInState(core, db, state, `delete-${state}`);
    const { body } = await respond([action("delete_work", { work_id: workId })]);
    assert.equal(db.get("SELECT id FROM works WHERE id = ?", workId), undefined);
    assert.match(body, /削除しました/u);
  }
});

test("delete_work on a running Work fails and keeps the Work", async (t) => {
  const { db, core, respond } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "delete-running");
  const { body } = await respond([action("delete_work", { work_id: workId })]);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  assert.match(body, /削除できません/u);
});

test("missing, cancelled, and not-started Work instructions produce failure notices without changes", async (t) => {
  const { db, core, respond } = await setup(t);
  const readyId = await createWorkInState(core, db, "ready", "not-started");
  const cancelledId = await createWorkInState(core, db, "cancelled", "cancelled-instruction");
  const missingId = createUlid();
  const before = new Map([readyId, cancelledId].map((id) => [id, {
    ...db.get("SELECT title, summary, state FROM works WHERE id = ?", id),
    events: db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ?", id).n,
    messages: db.get("SELECT COUNT(*) AS n FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE work_id = ?)", id).n,
  }]));

  const { body } = await respond([
    action("send_work_instruction", { work_id: missingId, body: "Do this" }),
    action("send_work_instruction", { body: "Missing ID" }),
    action("send_work_instruction", { work_id: readyId, body: "Not started" }),
    action("send_work_instruction", { work_id: cancelledId, body: "Cancelled" }),
  ]);

  assert.match(body, new RegExp(missingId, "u"));
  assert.match(body, /work_id/u);
  assert.match(body, /まだ開始されていない/u);
  assert.match(body, /キャンセル済み/u);
  for (const [id, snapshot] of before) {
    assert.deepEqual({
      ...db.get("SELECT title, summary, state FROM works WHERE id = ?", id),
      events: db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ?", id).n,
      messages: db.get("SELECT COUNT(*) AS n FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE work_id = ?)", id).n,
    }, snapshot);
  }
});

test("a completed Work instruction without reopen is rejected without changing it", async (t) => {
  const { db, core, respond } = await setup(t);
  const workId = await createWorkInState(core, db, "completed", "completed");
  const before = db.get("SELECT title, summary, state FROM works WHERE id = ?", workId);

  const { body } = await respond([action("send_work_instruction", { work_id: workId, body: "Continue" })]);

  assert.match(body, /再開してよいか確認/u);
  assert.deepEqual({ ...db.get("SELECT title, summary, state FROM works WHERE id = ?", workId) }, { ...before });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ?", workId).n, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE work_id = ?)", workId).n, 0);
});

test("resume_work reports a non-resumable Work without changing it", async (t) => {
  const { db, core, respond } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "not-resumable");
  const before = {
    ...db.get("SELECT title, summary, state FROM works WHERE id = ?", workId),
    events: db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ?", workId).n,
  };

  const { body } = await respond([action("resume_work", { work_id: workId })]);

  assert.match(body, /現在「実行中」のため、再開できません/u);
  assert.deepEqual({
    ...db.get("SELECT title, summary, state FROM works WHERE id = ?", workId),
    events: db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ?", workId).n,
  }, before);
});

test("toString is not treated as a Work operation type", async (t) => {
  const { db, core, respond } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "hostile-type");
  const workTypes = advisorResponse.ADVISOR_WORK_OPERATION_ACTION_TYPES;

  assert.ok(workTypes instanceof Set);
  for (const type of ["toString", "constructor", "valueOf"]) assert.equal(workTypes.has(type), false);
  assert.equal(workTypes.has("delete_work"), true);

  await assert.doesNotReject(respond([
    action("toString", { work_id: workId, body: "Must be ignored" }),
    action("send_work_instruction", { work_id: workId, body: "Still processed" }),
  ]));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE work_id = ?)", workId).n, 1);
});

test("the Advisor system prompt explains Work operations and the confirmation rules", async (t) => {
  const { core } = await setup(t);
  const prompt = core.buildAdvisorSystemPrompt("codex");

  for (const type of ["send_work_instruction", "update_work", "pause_work", "resume_work", "cancel_work", "delete_work", "move_work_to_project"]) {
    assert.ok(prompt.includes(type), `prompt should document ${type}`);
  }
  assert.match(prompt, /send_work_instruction \(without reopen\), pause_work and resume_work in the same turn/u);
  assert.match(prompt, /Never emit cancel_work, delete_work, update_work or move_work_to_project before the operator confirms/u);
  assert.match(prompt, /Adding reopen:true to an instruction for a completed Work also needs the operator's explicit approval/u);
  assert.match(prompt, /every turn carries an <owl-work-search> list/u);
  assert.match(prompt, /If several Works match or none does, ask which Work/u);
  assert.match(prompt, /never claim a Work was created or changed unless the Owl action result confirms it/u);
});

test("work operation notices follow the Owner language in Japanese and English", async (t) => {
  const { core, respond } = await setup(t);
  const japaneseWorkId = await createWorkInState(core, core.db, "running", "notice-ja");
  const japanese = await respond([action("send_work_instruction", { work_id: japaneseWorkId, body: "Add coverage" })]);
  assert.match(japanese.body, /指示を送りました/u);

  await core.setLanguage("en");
  const englishWorkId = await createWorkInState(core, core.db, "running", "notice-en");
  const english = await respond([action("send_work_instruction", { work_id: englishWorkId, body: "Add coverage" })]);
  assert.match(english.body, /Sent the instruction to Work/u);
});

const API_PAYLOAD = { method: "PUT", path: "/api/v1/settings/models", body: { payload: { worker: "secret-model-name" } }, reason: "Owner approved" };

function callApiEvents(db, type) {
  return db.all("SELECT idempotency_key, payload_json FROM events WHERE type = ?", type);
}

test("call_api calls the Owl API once, records started before and finished after, and passes the result on", async (t) => {
  const calls = [];
  let db;
  const callOwnApi = async (request) => {
    calls.push({ request, startedBefore: callApiEvents(db, "advisor.api_call_started").length });
    return { kind: "response", status: 200, body: { data: { ok: true } } };
  };
  const ctx = await setup(t, { callOwnApi });
  db = ctx.db;

  const { body } = await ctx.respond([action("call_api", API_PAYLOAD)]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].startedBefore, 1);
  assert.equal(calls[0].request.method, "PUT");
  assert.equal(calls[0].request.path, "/api/v1/settings/models");
  assert.match(calls[0].request.body.idempotency_key, /^advisor-call-api:/u);
  const finished = callApiEvents(db, "advisor.api_call_finished");
  assert.equal(finished.length, 1);
  const record = JSON.parse(finished[0].payload_json);
  assert.equal(record.outcome, "succeeded");
  assert.equal(record.status, 200);
  for (const row of [...callApiEvents(db, "advisor.api_call_started"), ...finished]) {
    assert.doesNotMatch(row.payload_json, /secret-model-name/u);
  }
  const responded = db.get("SELECT payload_json FROM events WHERE type = 'advisor.responded' ORDER BY rowid DESC LIMIT 1");
  assert.match(JSON.parse(responded.payload_json).action_results, /PUT \/api\/v1\/settings\/models → 200/u);
  assert.match(body, /PUT \/api\/v1\/settings\/models/u);
});

test("call_api does not send when the started record cannot be written", async (t) => {
  let calls = 0;
  const ctx = await setup(t, { callOwnApi: async () => { calls += 1; return { kind: "response", status: 200, body: {} }; } });
  const write = ctx.core.writeLane.write.bind(ctx.core.writeLane);
  ctx.core.writeLane.write = async (input) => {
    if (input.event?.type === "advisor.api_call_started") throw new Error("disk full");
    return write(input);
  };

  const { body } = await ctx.respond([action("call_api", API_PAYLOAD)]);

  assert.equal(calls, 0);
  assert.match(body, /記録を書けなかった/u);
  assert.equal(callApiEvents(ctx.db, "advisor.api_call_finished").length, 0);
});

test("call_api is never sent twice for a reprocessed turn or a duplicated action", async (t) => {
  let calls = 0;
  const ctx = await setup(t, { callOwnApi: async () => { calls += 1; return { kind: "response", status: 200, body: {} }; } });
  const turnId = createUlid();
  const reply = (actions) => ctx.core.persistAdvisorReply(ctx.conversationId, "", turnId, { channel: "web" }, actions);

  await reply([action("call_api", API_PAYLOAD), action("call_api", API_PAYLOAD)]);
  assert.equal(calls, 1);
  await reply([action("call_api", API_PAYLOAD)]);
  assert.equal(calls, 1);
  assert.equal(callApiEvents(ctx.db, "advisor.api_call_finished").length, 1);
});

test("a call_api left started-only is recorded unknown and not sent again", async (t) => {
  let calls = 0;
  const ctx = await setup(t, { callOwnApi: async () => { calls += 1; return { kind: "response", status: 200, body: {} }; } });
  const turnId = createUlid();
  // First attempt crashes after the send: make the finished write fail.
  const write = ctx.core.writeLane.write.bind(ctx.core.writeLane);
  ctx.core.writeLane.write = async (input) => {
    if (input.event?.type === "advisor.api_call_finished") throw new Error("crash");
    return write(input);
  };
  await ctx.core.persistAdvisorReply(ctx.conversationId, "", turnId, { channel: "web" }, [action("call_api", API_PAYLOAD)]);
  assert.equal(calls, 1);
  ctx.core.writeLane.write = write;

  await ctx.core.persistAdvisorReply(ctx.conversationId, "", turnId, { channel: "web" }, [action("call_api", API_PAYLOAD)]);

  assert.equal(calls, 1);
  const finished = callApiEvents(ctx.db, "advisor.api_call_finished").map((row) => JSON.parse(row.payload_json));
  assert.deepEqual(finished.map((row) => row.outcome), ["unknown"]);
});

test("call_api unknown results are not retried and not_sent is a failure", async (t) => {
  const results = [{ kind: "unknown", error: "timeout" }, { kind: "not_sent", error: "ECONNREFUSED" }];
  let calls = 0;
  const ctx = await setup(t, { callOwnApi: async () => { calls += 1; return results.shift(); } });

  const unknown = await ctx.respond([action("call_api", API_PAYLOAD)]);
  assert.match(unknown.body, /結果がわかりません/u);
  const failed = await ctx.respond([action("call_api", API_PAYLOAD)]);
  assert.match(failed.body, /失敗しました/u);

  assert.equal(calls, 2);
  const outcomes = callApiEvents(ctx.db, "advisor.api_call_finished").map((row) => JSON.parse(row.payload_json).outcome).sort();
  assert.deepEqual(outcomes, ["failed", "unknown"]);
});

async function createMoveTarget(t, core) {
  const repo = await realpath(await tempDir(t, "owl-advisor-move-repo-"));
  git(repo, "init", "--initial-branch=main");
  await writeFile(join(repo, "README.md"), "test\n");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "add", "README.md");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial");
  return (await core.createProject(command({
    name: "Move target", canonical_path: repo, base_branch: "main", allowed_roots: [repo], verification_plan: [],
  }, `advisor-move:project:${createUlid()}`))).data;
}

function projectAttachedEvents(db, workId) {
  return db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.project_attached'", workId).map((row) => JSON.parse(row.payload_json));
}

test("move_work_to_project moves a Project-less Work once and answers in the Owner's language", async (t) => {
  const { db, core, respond } = await setup(t);
  const project = await createMoveTarget(t, core);
  const workId = await createWorkInState(core, db, "paused", "move");

  const { body } = await respond([action("move_work_to_project", { work_id: workId, project_id: project.id })]);

  assert.equal(db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, project.id);
  assert.match(body, /Move target/u);
  assert.match(body, /移しました/u);
  const events = projectAttachedEvents(db, workId);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "advisor");

  const again = await respond([action("move_work_to_project", { work_id: workId, project_id: project.id })]);
  assert.equal(projectAttachedEvents(db, workId).length, 1);
  assert.match(again.body, /すでにProjectに属している/u);
});

test("move_work_to_project reports missing input, unknown Project and running Works", async (t) => {
  const { db, core, respond } = await setup(t);
  const project = await createMoveTarget(t, core);
  const workId = await createWorkInState(core, db, "paused", "move-errors");

  const incomplete = await respond([action("move_work_to_project", { work_id: workId })]);
  assert.match(incomplete.body, /Project への移動を実行できませんでした/u);

  const missing = await respond([action("move_work_to_project", { work_id: workId, project_id: "no-such-project" })]);
  assert.match(missing.body, /no-such-project/u);

  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = 'running', state_version = state_version + 1 WHERE id = ?", workId);
  });
  const running = await respond([action("move_work_to_project", { work_id: workId, project_id: project.id })]);
  assert.match(running.body, /実行中/u);
  assert.equal(db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, null);
  assert.equal(projectAttachedEvents(db, workId).length, 0);
});

test("move_work_to_project reports busy Agents and pending fixes in both languages without changing the Work", async (t) => {
  const { db, core, respond } = await setup(t);
  const project = await createMoveTarget(t, core);
  const busyId = await createWorkInState(core, db, "paused", "move-busy");
  const fixId = await createWorkInState(core, db, "paused", "move-fix");
  const projectedId = await createWorkInState(core, db, "paused", "move-projected");
  const taskId = createUlid();
  const taskPath = core.workspaceLayout.taskPath(fixId, taskId);
  await mkdir(taskPath, { recursive: true });
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO agent_runs (id, work_id, role, provider, model, status, created_at, updated_at) VALUES (?, ?, 'worker', 'test', 'test', 'running', ?, ?)", createUlid(), busyId, now, now);
    tx.run(`INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, worktree_path, paused_from, created_at, updated_at)
      VALUES (?, ?, 'fix', 'code', 'paused', 'normal', '', '', ?, 'review_fix_waiting', ?, ?)`, taskId, fixId, taskPath, now, now);
    tx.run("UPDATE works SET project_id = ? WHERE id = ?", project.id, projectedId);
  });
  const move = (workId, payload = { project_id: project.id }) => respond([action("move_work_to_project", { work_id: workId, ...payload })]);
  const assertUnmoved = () => {
    for (const id of [busyId, fixId]) assert.equal(db.get("SELECT project_id FROM works WHERE id = ?", id).project_id, null);
    assert.equal(projectAttachedEvents(db, busyId).length + projectAttachedEvents(db, fixId).length, 0);
  };

  assert.match((await move(busyId)).body, /Agentが動作中/u);
  assert.match((await move(fixId)).body, new RegExp(`修正待ち.*${taskId}`, "u"));
  assert.match((await move(projectedId)).body, /すでにProjectに属している/u);
  assertUnmoved();

  await core.setLanguage("en");
  assert.match((await move(busyId)).body, /has running Agents/u);
  assert.match((await move(fixId)).body, new RegExp(`waiting for a fix.*${taskId}`, "u"));
  assert.match((await move(projectedId)).body, /already belongs to a Project/u);
  assert.match((await move(busyId, { project_id: undefined })).body, /Could not run the move to a Project/u);
  assert.match((await move(busyId, { project_id: "no-such-project" })).body, /No Project has the ID no-such-project/u);
  assertUnmoved();

  const englishId = await createWorkInState(core, db, "paused", "move-en");
  assert.match((await move(englishId)).body, /Moved Work .* into the Project "Move target"/u);
  assert.equal(db.get("SELECT project_id FROM works WHERE id = ?", englishId).project_id, project.id);
  const events = projectAttachedEvents(db, englishId);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "advisor");
  await move(englishId);
  assert.equal(projectAttachedEvents(db, englishId).length, 1);
});

test("the Advisor prompt describes move_work_to_project and its confirmation rule", async (t) => {
  const { core } = await setup(t);
  const prompt = core.getAdvisorSettingsSnapshot().systemPrompt;
  assert.ok(advisorResponse.isAdvisorWorkOperationType("move_work_to_project"));
  assert.match(prompt, /\{type:"move_work_to_project",description,payload:\{work_id,project_id\}\}/u);
  assert.match(prompt, /Get project_id from GET \/api\/v1\/projects/u);
  assert.match(prompt, /Moving between Projects is not possible/u);
  assert.match(prompt, /a Work whose Task is still being fixed in its isolated folder must wait/u);
  assert.match(prompt, /Never emit cancel_work, delete_work, update_work or move_work_to_project before the operator confirms/u);
  assert.match(prompt, /destination Project \(name, canonical_path\)/u);
  assert.match(prompt, /delete_work, move_work_to_project, run_librarian/u);
});

test("a retried turn saves the prerequisites that were never stored and reports the wait", async (t) => {
  for (const [language, waiting] of [["ja", /前提の Work がすべて完了したら/u], ["en", /prerequisite/iu]]) {
    const { db, core, conversationId } = await setup(t);
    if (language === "en") await core.setLanguage("en");
    const prerequisiteId = await createWorkInState(core, db, "running", `prerequisite-${language}`);
    const turnId = createUlid();
    const actions = [action("create_work", {
      title: `Waiting ${language}`,
      summary: "Needs the prerequisite first.",
      size: "small",
      project_id: null,
      prerequisite_work_ids: [prerequisiteId],
    })];
    const origin = { channel: "web" };
    // The first attempt stops after createWork, before the prerequisites are stored.
    const realReplace = core.replaceWorkPrerequisites;
    core.replaceWorkPrerequisites = async () => { throw new Error("stopped"); };
    await core.persistAdvisorReply(conversationId, "first", turnId, origin, actions);
    core.replaceWorkPrerequisites = realReplace;
    const work = db.get("SELECT id FROM works WHERE title = ?", `Waiting ${language}`);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM work_prerequisites WHERE work_id = ?", work.id).count, 0);

    await core.persistAdvisorReply(conversationId, "second", turnId, origin, actions);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM work_prerequisites WHERE work_id = ?", work.id).count, 1);
    assert.equal(db.get("SELECT state FROM works WHERE id = ?", work.id).state, "ready", "waiting for the prerequisite, not running");
    const body = db.get("SELECT body FROM messages WHERE source_message_id LIKE ? ORDER BY rowid DESC LIMIT 1", `advisor:%:${turnId}%`).body;
    assert.match(body, waiting);
    assert.doesNotMatch(body, /開始しました|started it now/u);
  }
});

async function sendFileSetup(t, settings) {
  const dir = await tempDir(t, "owl-send-file-");
  const allowed = join(dir, "allowed");
  const outside = join(dir, "outside");
  await mkdir(allowed);
  await mkdir(outside);
  const ctx = await setup(t, settings === undefined ? {} : { getAdvisorSendFileSettings: () => settings(allowed) });
  const send = async (channel, ...paths) => {
    const turnId = createUlid();
    const origin = { channel, channel_id: "C1", ref: "1.1" };
    await ctx.core.persistAdvisorReply(ctx.conversationId, "reply", turnId, origin,
      paths.map((path) => action("send_file", typeof path === "string" ? { path } : path)));
    const row = ctx.db.get("SELECT payload_json FROM events WHERE type = 'advisor.responded' ORDER BY rowid DESC LIMIT 1");
    return JSON.parse(row.payload_json);
  };
  return { ...ctx, allowed, outside, send };
}

test("send_file refuses paths outside the folders, symlink escapes, secret names, folders and missing files with a reason each", async (t) => {
  const { allowed, outside, send } = await sendFileSetup(t, (dir) => ({ dirs: [dir] }));
  await writeFile(join(outside, "out.txt"), "x");
  await writeFile(join(allowed, ".env"), "x");
  await writeFile(join(allowed, "id_rsa"), "x");
  await writeFile(join(allowed, "ok.txt"), "ok");
  await mkdir(join(allowed, "sub"));
  await symlink(join(outside, "out.txt"), join(allowed, "escape.txt"));
  await symlink(join(allowed, "ok.txt"), join(allowed, "inner.txt"));
  const payload = await send("slack", join(outside, "out.txt"), join(allowed, "escape.txt"), join(allowed, ".env"),
    join(allowed, "id_rsa"), join(allowed, "sub"), allowed, join(allowed, "missing.txt"), join(allowed, "inner.txt"));
  assert.deepEqual(payload.outbound_files.map((file) => file.name), ["ok.txt"]);
  for (const pattern of [/out\.txt は送っていません: 送信できるフォルダの外/u, /escape\.txt は送っていません: リンク先が/u,
    /\.env は送っていません: 秘密情報/u, /id_rsa は送っていません: 秘密情報/u, /sub は送っていません: 通常のファイルではありません/u,
    /missing\.txt は送っていません: ファイルが見つかりません/u]) {
    assert.match(payload.reply, pattern);
    assert.match(payload.action_results, pattern);
  }
});

test("send_file over the channel limit is not published and the notice names the size and the limit", async (t) => {
  const { allowed, send } = await sendFileSetup(t, (dir) => ({ dirs: [dir], slackMaxBytes: 10, discordMaxBytes: 40 }));
  await writeFile(join(allowed, "big.txt"), "x".repeat(30));
  const slack = await send("slack", join(allowed, "big.txt"));
  assert.equal(slack.outbound_files, undefined);
  assert.match(slack.reply, /30B あり、Slack の上限 10B/u);
  const discord = await send("discord", join(allowed, "big.txt"));
  assert.equal(discord.outbound_files.length, 1);
  await writeFile(join(allowed, "bigger.txt"), "x".repeat(50));
  assert.match((await send("discord", join(allowed, "bigger.txt"))).reply, /50B あり、Discord の上限 40B/u);
});

test("send_file from a Slack conversation publishes the verified file in outbound_files and keeps it out of suggested_actions", async (t) => {
  const { allowed, send } = await sendFileSetup(t, (dir) => ({ dirs: [dir] }));
  const content = "demo contents";
  await writeFile(join(allowed, "a.txt"), content);
  await writeFile(join(allowed, "b.txt"), "second");
  const payload = await send("slack", { path: join(allowed, "a.txt"), comment: "note" }, join(allowed, "b.txt"));
  assert.deepEqual(payload.outbound_files, [
    { path: await realpath(join(allowed, "a.txt")), name: "a.txt", size: content.length, sha256: createHash("sha256").update(content).digest("hex"), comment: "note", index: 0 },
    { path: await realpath(join(allowed, "b.txt")), name: "b.txt", size: 6, sha256: createHash("sha256").update("second").digest("hex"), index: 1 },
  ]);
  assert.equal(payload.delivery_pending, true);
  assert.deepEqual(payload.suggested_actions, []);
  assert.equal(payload.reply, "reply");
  assert.equal(payload.action_results, "");
});

test("send_file from a Web conversation reports that sending works only in Slack and Discord", async (t) => {
  const { allowed, send } = await sendFileSetup(t, (dir) => ({ dirs: [dir] }));
  await writeFile(join(allowed, "a.txt"), "x");
  const payload = await send("web", join(allowed, "a.txt"));
  assert.equal(payload.outbound_files, undefined);
  assert.match(payload.reply, /a\.txt は送っていません。ファイルの送信は Slack と Discord/u);
});

test("send_file with a missing or malformed payload reports the reason", async (t) => {
  const { send } = await sendFileSetup(t, () => ({}));
  const payload = await send("slack", {}, { path: 1 }, { path: "/x", extra: true }, { path: "relative/a.txt" });
  assert.equal(payload.outbound_files, undefined);
  assert.equal((payload.action_results.match(/send_file を実行しませんでした/gu) ?? []).length, 4);
  assert.match(payload.action_results, /must be absolute/u);
});

test("send_file defaults to the materials folder only when advisor_send_file_dirs is absent", async (t) => {
  for (const [settings, allowed] of [[undefined, true], [() => ({}), true], [() => ({ dirs: [] }), false]]) {
    const ctx = await sendFileSetup(t, settings);
    const materials = join(ctx.core.knowledgeLocation.path, "materials");
    await mkdir(materials, { recursive: true });
    await writeFile(join(materials, "m.txt"), "m");
    const payload = await ctx.send("slack", join(materials, "m.txt"));
    assert.equal(payload.outbound_files?.length, allowed ? 1 : undefined);
    if (!allowed) assert.match(payload.reply, /送信できるフォルダがありません/u);
  }
});

test("openPinnedFile refuses a path whose parent folder is a symbolic link and opens the same path without links", async (t) => {
  const dir = await tempDir(t, "owl-pinned-");
  await mkdir(join(dir, "root", "sub"), { recursive: true });
  await mkdir(join(dir, "outside"));
  await writeFile(join(dir, "outside", "f.txt"), "outside");
  await writeFile(join(dir, "root", "sub", "f.txt"), "inside");
  await symlink(join(dir, "outside"), join(dir, "root", "link"));
  assert.deepEqual(await openPinnedFile(join(dir, "root", "link", "f.txt")), { ok: false, rejection: "changed" });
  const opened = await openPinnedFile(join(dir, "root", "sub", "f.txt"));
  assert.equal(opened.ok, true);
  assert.equal(await opened.handle.readFile("utf8"), "inside");
  await opened.handle.close();
});

test("the Advisor system prompt separates required acceptance criteria from goals", async (t) => {
  const { core } = await setup(t);
  const prompt = core.buildAdvisorSystemPrompt("codex");
  assert.match(prompt, /keep these few/u);
  assert.match(prompt, /Put a condition under "目標:" when it is wanted but not required, when it depends on anything outside the Work/u);
  assert.match(prompt, /count or a procedure/u);
  assert.match(prompt, /Never put a condition that depends on things outside the Work under "受け入れ条件:"/u);
  assert.match(prompt, /An unmet goal is reported with its reason and does not stop the Work/u);
  assert.match(prompt, /"目標:"/u);
});

function lastResponded(db) {
  // The follow-up reply (followup_of_turn_id set) is a separate event; these tests read the source reply.
  return JSON.parse(db.get("SELECT payload_json FROM events WHERE type = 'advisor.responded' AND json_extract(payload_json, '$.followup_of_turn_id') IS NULL ORDER BY rowid DESC LIMIT 1").payload_json);
}

test("a failed Work operation is recorded in action_failures and a successful reply has no such field", async (t) => {
  const { db, core, respond } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "failure");

  await respond([action("update_work", { work_id: workId, title: "Renamed" })]);
  assert.equal(Object.hasOwn(lastResponded(db), "action_failures"), false);

  await respond([action("send_work_instruction", { work_id: "01NOSUCHWORK", body: "hi" }), action("update_work", { work_id: workId })]);
  const [missing, invalid] = lastResponded(db).action_failures;
  assert.deepEqual({ ...missing, fingerprint: undefined }, {
    index: 0, type: "send_work_instruction", status: "failed", code: "work_not_found", fingerprint: undefined,
    message: missing.message, retryable: true, approval: false, target: "01NOSUCHWORK", details: { work_id: "01NOSUCHWORK" },
  });
  assert.match(missing.fingerprint, /^[0-9a-f]{64}$/u);
  assert.match(missing.message, /01NOSUCHWORK/u);
  assert.equal(invalid.index, 1);
  assert.equal(invalid.code, "invalid_payload");
  assert.equal(invalid.approval, true);
  assert.equal(invalid.target, workId);
});

test("call_api failures keep the body out, treat 5xx as unknown and cut the message to 300 characters", async (t) => {
  const results = [
    { kind: "response", status: 502, body: { error: { code: "bad_gateway", message: "x" } } },
    { kind: "response", status: 422, body: { error: { code: "validation_error", message: `sk-test_SECRETVALUE123 ${"y".repeat(400)}` } } },
    { kind: "response", status: 404, body: {} },
    { kind: "not_sent", error: "ECONNREFUSED" },
  ];
  const ctx = await setup(t, { callOwnApi: async () => results.shift() });
  const failuresOf = async () => {
    await ctx.respond([action("call_api", API_PAYLOAD)]);
    return lastResponded(ctx.db).action_failures;
  };

  const [fiveXx] = await failuresOf();
  assert.deepEqual([fiveXx.status, fiveXx.code, fiveXx.retryable, fiveXx.details.http_status, fiveXx.details.api_error_code], ["unknown", "result_unknown", false, 502, "bad_gateway"]);
  assert.equal(JSON.parse(callApiEvents(ctx.db, "advisor.api_call_finished")[0].payload_json).outcome, "unknown");

  const [fourXx] = await failuresOf();
  assert.deepEqual([fourXx.status, fourXx.code, fourXx.retryable, fourXx.approval], ["failed", "validation_error", true, true]);
  assert.ok(fourXx.message.length <= 300);
  assert.equal(JSON.stringify(lastResponded(ctx.db)).includes("secret-model-name"), false);
  assert.equal(JSON.stringify(lastResponded(ctx.db)).includes("SECRETVALUE123"), false);
  assert.equal(Object.hasOwn(fourXx.details, "body"), false);
  assert.match(fourXx.details.request_hash, /^[0-9a-f]{16}$/u);

  assert.equal((await failuresOf())[0].code, "http_404");
  assert.equal((await failuresOf())[0].code, "not_sent");

  await ctx.respond([action("call_api", { method: "POST", path: "/api/v1/works", body: {}, reason: "r" }), action("call_api", { method: "GET" })]);
  const [blocked, invalid] = lastResponded(ctx.db).action_failures;
  assert.deepEqual([blocked.status, blocked.code, blocked.retryable], ["failed", "blocked", false]);
  assert.deepEqual([invalid.code, invalid.retryable], ["invalid_payload", true]);
});

test("send_file marks a verified reply delivery_pending with each file's index and records Core refusals", async (t) => {
  const { allowed, outside, send } = await sendFileSetup(t, (dir) => ({ dirs: [dir] }));
  await writeFile(join(allowed, "a.txt"), "a");
  await writeFile(join(outside, "o.txt"), "o");
  await writeFile(join(allowed, ".env"), "x");
  const payload = await send("slack", join(outside, "o.txt"), join(allowed, "a.txt"), join(allowed, ".env"), {});
  assert.equal(payload.delivery_pending, true);
  assert.deepEqual(payload.outbound_files.map((file) => [file.name, file.index]), [["a.txt", 1]]);
  assert.deepEqual(payload.action_failures.map((f) => [f.index, f.type, f.code, f.status, f.retryable]), [
    [0, "send_file", "outside", "failed", true],
    [2, "send_file", "secret", "failed", false],
    [3, "send_file", "invalid_payload", "failed", true],
  ]);
  assert.equal(payload.action_failures[0].details.rejection, "outside");

  const none = await send("slack", join(outside, "o.txt"));
  assert.equal(Object.hasOwn(none, "delivery_pending"), false);
  const web = await send("web", join(allowed, "a.txt"));
  assert.equal(web.action_failures[0].code, "unsupported_channel");
});

test("create_work and handoff_to_window failures are recorded with their codes", async (t) => {
  const ctx = await setup(t);
  const valid = { title: "T", summary: "S", size: "small", project_id: null };
  await ctx.respond([
    action("create_work", { title: "x" }),
    action("create_work", { ...valid, project_id: 5 }),
    action("create_work", { ...valid, prerequisite_work_ids: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"] }),
    action("handoff_to_window", {}),
    action("handoff_to_window", { project_id: "01MISSINGPROJECT", summary: "s" }),
  ]);
  const failures = lastResponded(ctx.db).action_failures;
  assert.deepEqual(failures.map((f) => [f.index, f.type, f.code]), [
    [0, "create_work", "invalid_payload"], [1, "create_work", "not_found"], [2, "create_work", "not_found"],
    [3, "handoff_to_window", "invalid_payload"], [4, "handoff_to_window", "no_project"],
  ]);
  assert.equal(failures[4].details.target_project_id, "01MISSINGPROJECT");
  assert.equal(failures[0].target, "x");

  ctx.core.startWork = async () => { throw new Error("cannot start"); };
  await ctx.respond([action("create_work", { ...valid, title: "Unstarted" })]);
  const [notStarted] = lastResponded(ctx.db).action_failures;
  assert.deepEqual([notStarted.code, notStarted.retryable, notStarted.status], ["start_failed", false, "failed"]);
  assert.match(notStarted.details.created_work_id, /./u);
});

function latestAdvisorBody(db, conversationId) {
  return db.get(
    "SELECT body FROM messages WHERE conversation_id = ? AND source_message_id LIKE 'advisor:%' ORDER BY rowid DESC LIMIT 1",
    conversationId,
  ).body;
}

// Makes the first call of a Core method fail with a version_conflict, then lets later calls through.
function failFirstWithVersionConflict(core, method) {
  const original = core[method].bind(core);
  const calls = { total: 0 };
  core[method] = async (...args) => {
    calls.total += 1;
    if (calls.total === 1) throw Object.assign(new Error("stale"), { code: "version_conflict" });
    return original(...args);
  };
  return calls;
}

test("an update_work that failed with version_conflict is re-run when the follow-up repeats it unchanged", async (t) => {
  const { db, core, respond } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "retry-same");
  const calls = failFirstWithVersionConflict(core, "updateWork");
  const update = action("update_work", { work_id: workId, title: "Renamed once" });

  await respond([update], undefined, [update]);

  assert.equal(calls.total, 2);
  assert.equal(db.get("SELECT title FROM works WHERE id = ?", workId).title, "Renamed once");
});

test("an update_work retried with different content is held for approval and the Work is unchanged", async (t) => {
  const { db, core, conversationId, respond } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "retry-changed");
  const calls = failFirstWithVersionConflict(core, "updateWork");

  await respond(
    [action("update_work", { work_id: workId, title: "Approved title" })],
    undefined,
    [action("update_work", { work_id: workId, title: "Different title" })],
  );

  assert.equal(calls.total, 1);
  assert.equal(db.get("SELECT title FROM works WHERE id = ?", workId).title, "Work retry-changed");
  assert.match(latestAdvisorBody(db, conversationId), /承認した内容と変わった/u);
});

test("a cancel_work retried with only a different reason is held and the Work is not cancelled", async (t) => {
  const { db, core, conversationId, respond } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "retry-cancel");
  const calls = failFirstWithVersionConflict(core, "cancelWork");

  await respond(
    [action("cancel_work", { work_id: workId, reason: "No longer needed" })],
    undefined,
    [action("cancel_work", { work_id: workId, reason: "Some other reason" })],
  );

  assert.equal(calls.total, 1);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "running");
  assert.match(latestAdvisorBody(db, conversationId), /承認した内容と変わった/u);
});

test("a reopening send_work_instruction retried twice by the follow-up is sent only once more", async (t) => {
  const { db, core, respond } = await setup(t);
  const workId = await createWorkInState(core, db, "completed", "retry-reopen");
  const calls = failFirstWithVersionConflict(core, "postWorkInstruction");
  const send = action("send_work_instruction", { work_id: workId, body: "Please extend it", reopen: true });

  await respond([send], undefined, [send, send]);

  // One failed attempt plus exactly one retry; the duplicate in the follow-up is held.
  assert.equal(calls.total, 2);
  const workConversation = core.getWork(workId).data.conversation_id;
  assert.equal(db.get("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND body = 'Please extend it'", workConversation).n, 1);
});

test("a body-less DELETE call_api that was not sent is re-sent when the follow-up repeats the same method and path", async (t) => {
  const results = [{ kind: "not_sent", error: "ECONNREFUSED" }, { kind: "response", status: 200, body: {} }];
  let calls = 0;
  const ctx = await setup(t, { callOwnApi: async () => { calls += 1; return results.shift(); } });
  const del = action("call_api", { method: "DELETE", path: "/api/v1/settings/model-presets/01NOSUCHPRESET", reason: "Owner approved" });

  await ctx.respond([del], undefined, [del]);

  assert.equal(calls, 2);
});

for (const [name, firstResult] of [
  ["an unknown result", { kind: "unknown", error: "timeout" }],
  ["a 5xx response", { kind: "response", status: 503, body: { error: { code: "unavailable", message: "down" } } }],
]) {
  test(`a call_api with ${name} is not re-sent by the follow-up, even with a changed body`, async (t) => {
    let calls = 0;
    const ctx = await setup(t, { callOwnApi: async () => { calls += 1; return firstResult; } });
    const changed = action("call_api", { ...API_PAYLOAD, body: { payload: { worker: "another-model" } } });

    await ctx.respond([action("call_api", API_PAYLOAD)], undefined, [action("call_api", API_PAYLOAD)]);
    assert.equal(calls, 1);
    assert.match(latestAdvisorBody(ctx.db, ctx.conversationId), /前の結果がわからない/u);

    await ctx.respond([action("call_api", API_PAYLOAD)], undefined, [changed]);
    assert.equal(calls, 2, "only the new source turn's own call is sent; the changed follow-up body is not");
  });
}
