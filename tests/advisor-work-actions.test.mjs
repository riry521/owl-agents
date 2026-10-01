import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createCore } from "../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";
import * as advisorResponse from "../packages/shared/dist/advisor-response.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function command(payload, suffix, expectedVersion = 0) {
  return { request_id: createUlid(), idempotency_key: `advisor-work-test:${suffix}`, expected_version: expectedVersion, payload };
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-advisor-work-actions-"));
  const db = openDatabase(join(root, "owl.sqlite"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
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
  const core = createCore({ db, agentRunner, version: "advisor-work-actions-test", owlRoot: root, dataDir: root });
  t.after(async () => {
    await core.stop({ force: true }).catch(() => {});
    db.close();
    await rm(root, { recursive: true, force: true });
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
  }, `create:${suffix}`));
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

test("cancel_work cancels the selected Work and appends a success notice", async (t) => {
  const { db, core, respond } = await setup(t);
  const workId = await createWorkInState(core, db, "running", "cancel");

  const { body } = await respond([action("cancel_work", { work_id: workId, reason: "No longer needed" })]);

  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "cancelled");
  assert.match(body, /キャンセルしました/u);
});

test("delete_work removes completed and cancelled Works from the DB", async (t) => {
  const { db, core, respond } = await setup(t);
  for (const state of ["completed", "cancelled"]) {
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

  for (const type of ["send_work_instruction", "update_work", "pause_work", "resume_work", "cancel_work", "delete_work"]) {
    assert.ok(prompt.includes(type), `prompt should document ${type}`);
  }
  assert.match(prompt, /send_work_instruction \(without reopen\), pause_work and resume_work in the same turn/u);
  assert.match(prompt, /Never emit cancel_work, delete_work or update_work before the operator confirms/u);
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
