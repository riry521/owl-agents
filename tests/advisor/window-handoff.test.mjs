import assert from "node:assert/strict";
import { test } from "node:test";

import { ADVISOR_CURATION_INSTRUCTION } from "../../packages/shared/dist/index.js";
import { ADVISOR_TEXT } from "../../packages/core/dist/advisor-text.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { waitFor } from "../helpers/wait.mjs";

const ownerId = "owner:default";
const now = "2026-09-30T00:00:00.000Z";

/** A Core whose provider is a fake that records every turn text it receives; with hold, no turn ever completes. */
async function setup(t, shared = {}, { hold = false } = {}) {
  const created = [];
  const providerClient = {
    createSession: async () => {
      const sent = [];
      let stopped;
      const stopping = new Promise((resolve) => { stopped = resolve; });
      const driver = {
        sent,
        provider_session_id: `provider-${created.length + 1}`,
        pid: process.pid,
        send: async (turn) => { sent.push(turn); },
        events: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: "session.ready", provider_session_id: driver.provider_session_id, pid: process.pid };
            if (hold) {
              // Like a real driver killed at shutdown: the exit leaves the running turn for the next Core.
              await stopping;
              yield { type: "session.exited", exit_code: null, signal: "SIGTERM", stderr_tail: "" };
              return;
            }
            for (let handled = 0; ; handled += 1) {
              await waitFor(() => sent.length > handled, { message: "a turn arrives" });
              yield { type: "turn.completed", turn_id: sent[handled].turn_id, reply: "ok", usage: null };
            }
          },
        }),
        stop: async () => { stopped(); },
      };
      created.push(driver);
      return driver;
    },
  };
  const { root, db, core } = await createTestCore(t, {
    agentRunner: {
      runManagerPlan: async () => { throw new Error("No Work is planned here."); },
      runWorker: async () => { throw new Error("No Worker runs here."); },
      runReviewer: async () => { throw new Error("No Reviewer runs here."); },
      runAdvisor: async () => { throw new Error("The persistent provider session handles replies."); },
    },
    providerClient,
    version: "window-handoff-test",
    dispatcher: { tick_interval_ms: 25 },
    ...shared,
  }, { prefix: "owl-window-handoff-" });
  core.gitGateway().resolveAdvisorSessionDirectory = async () => ({ kind: "direct", cwd: root });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
  core.gitGateway().sweepAdvisorWorkspaces = async () => {};
  await core.start();

  const addProject = async (name) => {
    const id = createUlid();
    await db.createWriteLane().transact((tx) => tx.run(
      `INSERT INTO projects
         (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
          verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', '[]', '{}', '[]', ?, ?)`,
      id, ownerId, name, `/tmp/${id}`, now, now,
    ));
    return id;
  };
  return { db, root, core, created, addProject };
}

const handoff = (projectId, summary = "Owner wants a new billing plan.") => ({
  type: "handoff_to_window",
  description: "hand over",
  payload: { project_id: projectId, summary },
});

test("a Project window hands a cross-Project talk to the general window once, with the summary in its next turn", async (t) => {
  const { db, core, created, addProject } = await setup(t);
  const alpha = await addProject("Alpha");
  const window = await core.ensureAdvisorWindow(ownerId, alpha);
  const general = await core.ensureAdvisorWindow(ownerId, "general");
  const handed = () => db.all("SELECT body, metadata_json FROM messages WHERE conversation_id = ? AND source_message_id LIKE '%:handoff:%'", general.conversation_id);

  const messageId = await core.persistAdvisorReply(window.conversation_id, "", createUlid(), { channel: "web" }, [handoff(null)]);
  const body = db.get("SELECT body FROM messages WHERE id = ?", messageId).body;
  assert.equal(body, ADVISOR_TEXT.ja.handoffDone("ジェネラリスト", []));
  assert.match(body, /続きはそちらで/);
  assert.equal(handed().length, 1);
  assert.equal(handed()[0].body, ADVISOR_TEXT.ja.handoffMessage("Alpha", "Owner wants a new billing plan."));
  assert.equal(JSON.parse(handed()[0].metadata_json).kind, "window_handoff");

  const turn = async (marker) => {
    const posted = await core.postMessage(general.conversation_id, command({ body: marker, attachment_ids: [] }, `handoff:${marker}`));
    await core.advisorRespond(general.conversation_id, posted.data.message_id, { channel: "web" });
    await waitFor(() => created.some((driver) => driver.sent.some((sent) => sent.text.includes(marker))), { message: `${marker} reached a session` });
    return created.flatMap((driver) => driver.sent).find((sent) => sent.text.includes(marker)).text;
  };
  const first = await turn("first-turn");
  assert.equal(first.match(/<owl-window-handoff[ >]/g)?.length, 1);
  assert.match(first, /Owner wants a new billing plan\./);
  assert.match(first, /Alpha/);
  assert.doesNotMatch(await turn("second-turn"), /<owl-window-handoff[ >]/);
});

test("the general window hands a Project's talk to that Project's window; the notice lists its bound channels", async (t) => {
  const { db, core, addProject } = await setup(t);
  const alpha = await addProject("Alpha");
  const general = await core.ensureAdvisorWindow(ownerId, "general");
  const target = await core.ensureAdvisorWindow(ownerId, alpha);
  await core.bindAdvisorChannel(target.window_id, "slack", "C1", "owl-alpha");
  const messageId = await core.persistAdvisorReply(general.conversation_id, "", createUlid(), { channel: "web" }, [handoff(alpha, "x".repeat(4000))]);
  assert.equal(db.get("SELECT body FROM messages WHERE id = ?", messageId).body, ADVISOR_TEXT.ja.handoffDone("Alpha", ["Slack: #owl-alpha"]));
  assert.equal(db.all("SELECT id FROM messages WHERE conversation_id = ? AND source_message_id LIKE '%:handoff:%'", target.conversation_id).length, 1);
});

test("a handoff to the same window, a missing Project, or a bad payload only adds a notice", async (t) => {
  const { db, core, addProject } = await setup(t);
  const alpha = await addProject("Alpha");
  const window = await core.ensureAdvisorWindow(ownerId, alpha);
  const reply = (action) => core.persistAdvisorReply(window.conversation_id, "", createUlid(), { channel: "web" }, [action])
    .then((messageId) => db.get("SELECT body FROM messages WHERE id = ?", messageId).body);
  assert.equal(await reply(handoff(alpha)), ADVISOR_TEXT.ja.handoffSameWindow);
  assert.equal(await reply(handoff(createUlid())), ADVISOR_TEXT.ja.handoffNoProject);
  assert.equal(await reply(handoff(null, "")), ADVISOR_TEXT.ja.handoffInvalid);
  assert.equal(await reply(handoff(null, "x".repeat(4001))), ADVISOR_TEXT.ja.handoffInvalid);
  assert.equal(db.all("SELECT id FROM messages WHERE source_message_id LIKE '%:handoff:%'").length, 0);
});

const carriedBy = (db, summary) => db.get(
  "SELECT json_extract(metadata_json, '$.carried_by') AS c FROM messages WHERE json_extract(metadata_json, '$.summary') = ?",
  summary,
).c;

test("a handoff left half-done by a restart is recovered once: no duplicate, the orphan claim is released, the pending turn is rebuilt with it", async (t) => {
  const first = await setup(t, {}, { hold: true });
  const alpha = await first.addProject("Alpha");
  const window = await first.core.ensureAdvisorWindow(ownerId, alpha);
  const general = await first.core.ensureAdvisorWindow(ownerId, "general");
  const turnId = createUlid();
  const before = await first.core.persistAdvisorReply(window.conversation_id, "", turnId, { channel: "web" }, [handoff(null, "carried summary")])
    .then((messageId) => first.db.get("SELECT body FROM messages WHERE id = ?", messageId).body);

  // A general-window turn claims the handoff and is still running when the process dies.
  const posted = await first.core.postMessage(general.conversation_id, command({ body: "before-restart", attachment_ids: [] }, "handoff:restart"));
  await first.core.advisorRespond(general.conversation_id, posted.data.message_id, { channel: "web" });
  await waitFor(() => first.created.some((driver) => driver.sent.length > 0), { message: "the turn reached a session" });
  assert.equal(carriedBy(first.db, "carried summary"), posted.data.message_id);
  // A second handoff is claimed by a message that never got its advisor_turns row.
  await first.core.persistAdvisorReply(window.conversation_id, "", createUlid(), { channel: "web" }, [handoff(null, "orphan summary")]);
  await first.core.claimWindowHandoffs(general.window_id, "01ORPHANORPHANORPHANORPHAN");
  assert.equal(carriedBy(first.db, "orphan summary"), "01ORPHANORPHANORPHANORPHAN");
  await first.core.stop();
  first.core.stop = async () => {}; // already stopped; the helper's cleanup must not touch the closed DB

  // core.stop() closes the DB, so the second Core opens the same file again; its start() recovers the turn.
  const reopened = createTestDatabase(first.root);
  const second = await setup(t, { db: reopened, owlRoot: first.root });
  t.after(() => reopened.close()); // registered after the Core's own cleanup, which still reads the DB
  assert.equal(carriedBy(second.db, "orphan summary"), null);
  assert.equal(carriedBy(second.db, "carried summary"), posted.data.message_id);

  await waitFor(() => second.created.some((driver) => driver.sent.some((sent) => sent.text.includes("before-restart"))), { message: "the recovered turn reached a session" });
  const text = second.created.flatMap((driver) => driver.sent).find((sent) => sent.text.includes("before-restart")).text;
  assert.equal(text.match(/<owl-window-handoff[ >]/g)?.length, 1);
  assert.match(text, /carried summary/);
  assert.doesNotMatch(text, /orphan summary/);

  assert.equal(await second.core.persistAdvisorReply(window.conversation_id, "", turnId, { channel: "web" }, [handoff(null, "carried summary")])
    .then((messageId) => second.db.get("SELECT body FROM messages WHERE id = ?", messageId).body), before);
  assert.equal(second.db.all("SELECT id FROM messages WHERE json_extract(metadata_json, '$.kind') = 'window_handoff'").length, 2);
});

test("a general window claims handoffs only from its own Owner's legacy conversations", async (t) => {
  const { db, core } = await setup(t);
  const general = await core.ensureAdvisorWindow(ownerId, "general");
  const conversationId = createUlid();
  const messageId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:other', 'Other', ?, ?)", now, now);
    tx.run("INSERT INTO conversations (id, owner_id, channel, is_active, created_at, updated_at) VALUES (?, 'owner:other', 'web', 1, ?, ?)", conversationId, now, now);
    tx.run(
      `INSERT INTO messages
         (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, metadata_json, received_at, created_at)
       VALUES (?, ?, 'web', (SELECT id FROM connector_accounts WHERE provider = 'web' LIMIT 1), ?, 'other', '[]', ?, ?, ?)`,
      messageId, conversationId, `other:handoff:${messageId}`,
      JSON.stringify({ kind: "window_handoff", delivered: false, summary: "other owner summary" }), now, now,
    );
  });
  await core.claimWindowHandoffs(general.window_id, "01MINEMINEMINEMINEMINEMINE");
  assert.equal(carriedBy(db, "other owner summary"), null);
});

test("a legacy conversation without a window counts as the general window for handing over and for receiving", async (t) => {
  const { db, core, created, addProject } = await setup(t);
  const alpha = await addProject("Alpha");
  const general = await core.ensureAdvisorWindow(ownerId, "general");
  const target = await core.ensureAdvisorWindow(ownerId, alpha);
  await db.createWriteLane().transact((tx) => tx.run("UPDATE conversations SET advisor_window_id = NULL WHERE id = ?", general.conversation_id));
  const reply = (action) => core.persistAdvisorReply(general.conversation_id, "", createUlid(), { channel: "web" }, [action])
    .then((messageId) => db.get("SELECT body FROM messages WHERE id = ?", messageId).body);
  assert.equal(await reply(handoff(null)), ADVISOR_TEXT.ja.handoffSameWindow);
  assert.equal(await reply(handoff(alpha)), ADVISOR_TEXT.ja.handoffDone("Alpha", []));
  await core.persistAdvisorReply(target.conversation_id, "", createUlid(), { channel: "web" }, [handoff(null, "legacy summary")]);
  const posted = await core.postMessage(general.conversation_id, command({ body: "legacy-turn", attachment_ids: [] }, "handoff:legacy"));
  await core.advisorRespond(general.conversation_id, posted.data.message_id, { channel: "web" });
  await waitFor(() => created.some((driver) => driver.sent.some((sent) => sent.text.includes("legacy-turn"))), { message: "the turn reached a session" });
  const text = created.flatMap((driver) => driver.sent).find((sent) => sent.text.includes("legacy-turn")).text;
  assert.match(text, /legacy summary/);
});

test("the system prompt explains handoff_to_window and a Project window's turn says to hand cross-Project talk to the general window", async (t) => {
  const { core, created, addProject } = await setup(t);
  assert.match(ADVISOR_CURATION_INSTRUCTION, /handoff_to_window/);
  const alpha = await addProject("Alpha");
  const window = await core.ensureAdvisorWindow(ownerId, alpha);
  const posted = await core.postMessage(window.conversation_id, command({ body: "rule-check", attachment_ids: [] }, "handoff:rule"));
  await core.advisorRespond(window.conversation_id, posted.data.message_id, { channel: "web" });
  await waitFor(() => created.some((driver) => driver.sent.length > 0), { message: "the turn reached a session" });
  const text = created.flatMap((driver) => driver.sent).find((sent) => sent.text.includes("rule-check")).text;
  assert.match(text, /handoff_to_window/);
  assert.match(text, /project_id null/);
});
