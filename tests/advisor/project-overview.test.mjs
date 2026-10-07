import { writeCommonIndex } from "../helpers/seed-knowledge.mjs";
import { createTestCore } from "../helpers/core.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";

const ownerId = "owner:default";

async function runTurn(t, label, setup = async () => {}) {
  const sentTurns = [];
  let currentTurn;
  let readySent = false;
  const providerClient = {
    createSession: async () => ({
      provider_session_id: "overview-session",
      pid: process.pid,
      send: async (turn) => { currentTurn = turn; sentTurns.push(turn); },
      events: () => ({
        async *[Symbol.asyncIterator]() {
          if (!readySent) {
            readySent = true;
            yield { type: "session.ready", provider_session_id: "overview-session", pid: process.pid };
          }
          yield { type: "turn.completed", turn_id: currentTurn.turn_id, reply: "ok", usage: null };
        },
      }),
      stop: async () => {},
    }),
  };
  const { root, db, core } = await createTestCore(t, {
    agentRunner: {
      runAdvisor: async () => ({ reply: "" }),
      runManagerPlan: async () => ({ outcome: "failed" }),
      runWorker: async () => ({ outcome: "failed" }),
      runReviewer: async () => ({ outcome: "failed" }),
    },
    version: "advisor-overview-test",
    providerClient,
  }, { prefix: `owl-advisor-overview-${label}-` });
  core.gitGateway().prepareAdvisorWorkspace = async () => ({ ok: true, worktree_path: root });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
  core.gitGateway().sweepAdvisorWorkspaces = async () => {};
  const conversation = await core.getActiveConversation();
  const projectId = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO projects
       (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
        verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
     VALUES (?, ?, 'Overview Project', ?, 'main', '[]', '{}', '[]', ?, ?)`,
    projectId, ownerId, `/tmp/${projectId}`, now, now,
  ));
  const account = db.get("SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'", ownerId).id;
  const messageId = createUlid();
  await db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
     VALUES (?, ?, 'web', ?, ?, 'hi', '[]', ?, ?)`,
    messageId, conversation.conversation_id, account, `web-user:${messageId}`, now, now,
  ));
  const noteFile = `project-overview-${projectId}.md`;
  const knowledgeDir = core.knowledgeLocation.activeDir();
  await setup({ core, projectId, noteFile });
  await core.advisorRespond(conversation.conversation_id, messageId, { channel: "web" });
  for (let i = 0; i < 200 && !db.get("SELECT id FROM advisor_turns WHERE user_message_id = ? AND status = 'completed'", messageId); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(sentTurns[0], "the turn reached the provider");
  return { text: sentTurns[0].text, projectId, core, noteFile, knowledgeDir };
}

const SUMMARY = "Overview summary text";

async function writeOverview({ core, projectId, noteFile }) {
  await mkdir(core.knowledgeLocation.activeDir(), { recursive: true });
  await core.knowledgeNotes.upsertFixedFile(noteFile, () => ({
    id: createUlid(), title: "Overview", slug: "overview", tags: [], sources: [], links: [], project_ids: [projectId],
    created: "2026-09-10", updated: "2026-09-10", summary: SUMMARY, claims: [], promotions: [],
  }));
}

test("Advisor turn carries the memory catalog instead of a grep instruction", async (t) => {
  const { text, projectId, noteFile, core } = await runTurn(t, "ok", async (ctx) => {
    await writeOverview(ctx);
    await writeCommonIndex(ctx.core.knowledgeLocation.activeDir(), "目的の要約");
    await ctx.core.memoryReindex({ mode: "full" });
  });
  assert.match(text, /<owl-project-search>/u);
  assert.match(text, /<owl-memory scope="advisor" generated=/u);
  assert.match(text, /目的の要約/u);
  assert.doesNotMatch(text, /<owl-knowledge-reference>/u);
  assert.doesNotMatch(text, new RegExp(SUMMARY, "u"));
  const note = await core.knowledgeNotes.getProjectOverview(projectId);
  assert.equal(note.summary, SUMMARY);
  assert.ok(noteFile);
});

test("Advisor turn has no knowledge block when the storage is unavailable", async (t) => {
  const { text } = await runTurn(t, "unavailable", ({ core }) => { core.knowledgeLocation.isAvailable = () => false; });
  assert.match(text, /<owl-project-search>/u);
  assert.doesNotMatch(text, /<owl-knowledge-reference>/u);
});

test("Advisor turn has no knowledge block while the storage is moving", async (t) => {
  const { text } = await runTurn(t, "moving", ({ core }) => { core.knowledgeLocation.status = () => ({ state: "moving" }); });
  assert.doesNotMatch(text, /<owl-knowledge-reference>/u);
});

test("Advisor turn continues when reading the storage path throws", async (t) => {
  const { text } = await runTurn(t, "throws", ({ core }) => { core.knowledgeLocation.activeDir = () => { throw new Error("storage unavailable"); }; });
  assert.match(text, /<owl-work-search>/u);
  assert.doesNotMatch(text, /<owl-knowledge-reference>/u);
});
