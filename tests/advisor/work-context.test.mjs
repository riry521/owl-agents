import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAdvisorWorkCatalogInstruction, createCore } from "../../packages/core/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestDatabase } from "../helpers/db.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";
const ownerId = "owner:default";
const activeHeader = "Active Works (running, paused or judgement_waiting; most recently updated first):";
const finishedHeader = "Recently finished Works (completed or cancelled; newest first, up to 10):";

async function fixture(t, label, { providerClient } = {}) {
  const root = await tempDir(t, `owl-advisor-work-context-${label}-`);
  const db = createTestDatabase(root);
  const requests = [];
  const core = createCore({
    db,
    agentRunner: {
      runAdvisor: async (request) => { requests.push(request); return { reply: "" }; },
      runManagerPlan: async () => ({ outcome: "failed" }),
      runWorker: async () => ({ outcome: "failed" }),
      runReviewer: async () => ({ outcome: "failed" }),
    },
    version: "advisor-work-context-test",
    owlRoot: root,
    dataDir: root,
    ...(providerClient ? { providerClient } : {}),
  });
  const conversation = await core.getActiveConversation();
  t.after(async () => {
    await core.stop({ force: true }).catch(() => {});
    db.close();
  });
  return { root, db, core, conversation, requests };
}

async function addProject(db, name = "Context Project") {
  const id = createUlid();
  const now = "2026-09-30T00:00:00.000Z";
  await db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO projects
       (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
        verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'main', '[]', '{}', '[]', ?, ?)`,
    id, ownerId, name, `/tmp/${id}`, now, now,
  ));
  return id;
}

async function addWork(db, {
  state = "running",
  title = `${state} Work`,
  projectId = null,
  updatedAt = "2026-09-30T00:00:00.000Z",
  completedAt = null,
  cancelledAt = null,
  archivedAt = null,
  displayNumber = null,
} = {}) {
  const id = createUlid();
  await db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO works
       (id, owner_id, project_id, title, summary, size, state, rules_json,
        related_work_ids_json, created_at, updated_at, completed_at, cancelled_at,
        archived_at, display_number)
     VALUES (?, ?, ?, ?, '', 'small', ?, '[]', '[]', ?, ?, ?, ?, ?, ?)`,
    id, ownerId, projectId, title, state, updatedAt, updatedAt, completedAt,
    cancelledAt, archivedAt, displayNumber,
  ));
  return id;
}

function readGroup(block, header, nextHeader) {
  const start = block.indexOf(`${header}\n`);
  assert.notEqual(start, -1, `missing ${header}`);
  const bodyStart = start + header.length + 1;
  const end = nextHeader ? block.indexOf(`\n${nextHeader}`, bodyStart) : block.indexOf("\n</owl-work-search>", bodyStart);
  assert.notEqual(end, -1, `missing end of ${header}`);
  return block.slice(bodyStart, end).split("\nMore active Works exist")[0].trim();
}

async function addUserMessage(db, conversationId, channel) {
  const accountId = db.get("SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'", ownerId).id;
  const id = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO messages
       (id, conversation_id, provider, account_id, source_message_id, body,
        attachment_ids_json, received_at, created_at)
     VALUES (?, ?, 'web', ?, ?, ?, '[]', ?, ?)`,
    id, conversationId, accountId, `${channel}-user:${id}`, `${channel} turn`, now, now,
  ));
  return id;
}

test("Work catalog lists eligible states, excludes archived and resolves Project names", async (t) => {
  const { db } = await fixture(t, "catalog");
  const projectId = await addProject(db);
  const runningId = await addWork(db, { state: "running", projectId, displayNumber: 1, updatedAt: "2026-09-30T00:00:00.000Z" });
  const pausedId = await addWork(db, { state: "paused", projectId, displayNumber: 2, updatedAt: "2026-09-30T00:01:00.000Z" });
  const waitingId = await addWork(db, { state: "judgement_waiting", projectId, displayNumber: 3, updatedAt: "2026-09-30T00:02:00.000Z" });
  await addWork(db, { state: "running", title: "Archived Work", archivedAt: "2026-09-30T00:00:00.000Z" });
  await addWork(db, { state: "ready", title: "Ready Work" });
  await addWork(db, { state: "memo", title: "Memo Work" });
  const completedId = await addWork(db, { state: "completed", completedAt: "2026-09-29T00:00:00.000Z" });
  const cancelledId = await addWork(db, { state: "cancelled", cancelledAt: "2026-09-30T00:00:00.000Z" });
  await addWork(db, { state: "completed", title: "Archived Finished Work", archivedAt: "2026-09-30T00:00:00.000Z" });

  const block = buildAdvisorWorkCatalogInstruction(db);
  assert.match(block, /^<owl-work-search>\n/u);
  assert.match(block, /Never invent an id/u);
  assert.match(block, /<\/owl-work-search>$/u);
  const active = JSON.parse(readGroup(block, activeHeader, finishedHeader));
  const finished = JSON.parse(readGroup(block, finishedHeader));
  assert.deepEqual(active.map((work) => work.id), [waitingId, pausedId, runningId]);
  assert.deepEqual(finished.map((work) => work.id), [cancelledId, completedId]);
  assert.deepEqual(Object.keys(active[0]), ["id", "display_number", "title", "state", "project_id", "project_name", "updated_at"]);
  const running = active.find((work) => work.id === runningId);
  assert.equal(running.project_id, projectId);
  assert.equal(running.project_name, "Context Project");
  assert.equal(finished[0].project_id, null);
  assert.equal(finished[0].project_name, null);
  assert.equal(finished[0].display_number, null);
  assert.doesNotMatch(block, /Archived Work|Archived Finished Work|Ready Work|Memo Work/u);
});

test("Work catalog applies the active and recently finished limits", async (t) => {
  const { db } = await fixture(t, "limits");
  for (let i = 0; i < 51; i += 1) {
    await addWork(db, {
      state: "running",
      title: `Active ${i}`,
      updatedAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
    });
  }
  for (let i = 0; i < 11; i += 1) {
    await addWork(db, {
      state: "completed",
      title: `Finished ${i}`,
      completedAt: new Date(Date.UTC(2026, 8, 2, 0, i)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
    });
  }

  const block = buildAdvisorWorkCatalogInstruction(db);
  const active = JSON.parse(readGroup(block, activeHeader, finishedHeader));
  const finished = JSON.parse(readGroup(block, finishedHeader));
  assert.equal(active.length, 50);
  assert.equal(finished.length, 10);
  assert.equal(active[0].title, "Active 50");
  assert.equal(finished[0].title, "Finished 10");
  assert.match(block, /More active Works exist than are listed \(showing the 50 most recently updated\)/u);
});

test("web and Slack Advisor turns receive a fresh Work catalog in system_prompt", async (t) => {
  const { db, core, conversation, requests } = await fixture(t, "turns");
  const projectId = await addProject(db, "Turn Project");
  const workId = await addWork(db, { state: "paused", title: "Current Work", projectId });

  const webMessageId = await addUserMessage(db, conversation.conversation_id, "web");
  await core.advisorRespond(conversation.conversation_id, webMessageId, { channel: "web" });
  const webPrompt = requests[0].system_prompt;
  assert.match(webPrompt, /<owl-project-search>/u);
  assert.match(webPrompt, /<owl-work-search>/u);
  assert.match(webPrompt, new RegExp(workId, "u"));
  assert.match(webPrompt, /Turn Project/u);

  const latestWorkId = await addWork(db, { state: "running", title: "Added before Slack turn", projectId });
  const slackMessageId = await addUserMessage(db, conversation.conversation_id, "slack");
  await core.advisorRespond(conversation.conversation_id, slackMessageId, { channel: "slack" });
  const slackPrompt = requests[1].system_prompt;
  assert.match(slackPrompt, /<owl-project-search>/u);
  assert.match(slackPrompt, /<owl-work-search>/u);
  assert.match(slackPrompt, new RegExp(workId, "u"));
  assert.match(slackPrompt, new RegExp(latestWorkId, "u"));
  assert.match(slackPrompt, /Turn Project/u);
  assert.equal(requests.length, 2);
});

test("persistent web and Slack turns receive the latest Work catalog", async (t) => {
  const sentTurns = [];
  let currentTurn;
  let readySent = false;
  const providerClient = {
    createSession: async () => ({
      provider_session_id: "advisor-work-context-session",
      pid: process.pid,
      send: async (turn) => {
        currentTurn = turn;
        sentTurns.push(turn);
      },
      events: () => ({
        async *[Symbol.asyncIterator]() {
          if (!readySent) {
            readySent = true;
            yield {
              type: "session.ready",
              provider_session_id: "advisor-work-context-session",
              pid: process.pid,
            };
          }
          assert.ok(currentTurn, "the provider should receive a turn before returning its reply");
          yield { type: "turn.completed", turn_id: currentTurn.turn_id, reply: "ok", usage: null };
        },
      }),
      stop: async () => {},
    }),
  };
  const { root, db, core, conversation } = await fixture(t, "persistent-turns", { providerClient });
  core.gitGateway().resolveAdvisorSessionDirectory = async () => ({ kind: "direct", cwd: root });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
  core.gitGateway().sweepAdvisorWorkspaces = async () => {};

  const projectId = await addProject(db, "Persistent Turn Project");
  const workId = await addWork(db, { state: "running", title: "Persistent Work", projectId });
  const webMessageId = await addUserMessage(db, conversation.conversation_id, "web");
  await core.advisorRespond(conversation.conversation_id, webMessageId, { channel: "web" });
  await waitFor(() => sentTurns[0], { message: "the persistent web turn to reach the provider" });
  await waitFor(() => db.get(
    "SELECT id FROM advisor_turns WHERE user_message_id = ? AND status = 'completed'",
    webMessageId,
  ), { message: "the persistent web turn to complete" });

  const webActive = JSON.parse(readGroup(sentTurns[0].text, activeHeader, finishedHeader));
  assert.match(sentTurns[0].text, /<owl-project-search>/u);
  assert.match(sentTurns[0].text, /<owl-work-search>/u);
  assert.deepEqual(webActive.map((work) => work.id), [workId]);
  assert.equal(webActive[0].state, "running");
  assert.equal(webActive[0].project_name, "Persistent Turn Project");

  await db.createWriteLane().transact((tx) => tx.run(
    "UPDATE works SET state = 'paused', updated_at = ? WHERE id = ?",
    "2026-10-01T00:00:00.000Z",
    workId,
  ));
  const slackMessageId = await addUserMessage(db, conversation.conversation_id, "slack");
  await core.advisorRespond(conversation.conversation_id, slackMessageId, { channel: "slack" });
  await waitFor(() => sentTurns[1], { message: "the persistent Slack turn to reach the provider" });
  await waitFor(() => db.get(
    "SELECT id FROM advisor_turns WHERE user_message_id = ? AND status = 'completed'",
    slackMessageId,
  ), { message: "the persistent Slack turn to complete" });

  const slackActive = JSON.parse(readGroup(sentTurns[1].text, activeHeader, finishedHeader));
  assert.match(sentTurns[1].text, /<owl-project-search>/u);
  assert.match(sentTurns[1].text, /<owl-work-search>/u);
  assert.deepEqual(slackActive.map((work) => work.id), [workId]);
  assert.equal(slackActive[0].state, "paused");
  assert.equal(slackActive[0].project_name, "Persistent Turn Project");
  assert.equal(sentTurns.length, 2);
});
