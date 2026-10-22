import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

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
  const agentRunner = {
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
  async function respond(actions, text = "Please perform this Work operation.") {
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
    await core.advisorRespond(conversationId, userMessageId, { channel: "slack" });

    assert.equal(advisorRequests.length, requestCount + 1, "the user message should run through the stub Advisor");
    assert.ok(advisorRequests.at(-1).messages.some((message) => message.source === "user" && message.body === text));
    const message = db.get(
      "SELECT id, body FROM messages WHERE conversation_id = ? AND source_message_id LIKE 'advisor:%' ORDER BY rowid DESC LIMIT 1",
      conversationId,
    );
    return { messageId: message.id, body: message.body };
  }

  return { db, core, conversationId, respond };
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
