import assert from "node:assert/strict";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { waitFor } from "../helpers/wait.mjs";

const ownerId = "owner:default";

/**
 * A Core whose provider is a fake: every createSession is one provider session
 * that answers each turn with "<its label>|<the MSG marker of the turn text>".
 * While `hold.open` is false no session answers, so concurrent windows can be
 * observed running side by side.
 */
async function setup(t) {
  const created = [];
  const hold = { open: false };
  const providerClient = {
    createSession: async () => {
      const label = `session-${created.length + 1}`;
      const sent = [];
      const driver = {
        label,
        sent,
        provider_session_id: `provider-${label}`,
        pid: process.pid,
        send: async (turn) => { sent.push(turn); },
        events: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: "session.ready", provider_session_id: `provider-${label}`, pid: process.pid };
            for (let handled = 0; ; handled += 1) {
              await waitFor(() => sent.length > handled && hold.open, { message: `${label} may answer turn ${handled + 1}` });
              const marker = /MSG-[a-z0-9]+/.exec(sent[handled].text)?.[0] ?? "no-marker";
              yield { type: "turn.completed", turn_id: sent[handled].turn_id, reply: `${label}|${marker}`, usage: null };
            }
          },
        }),
        stop: async () => {},
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
    version: "window-sessions-test",
    dispatcher: { tick_interval_ms: 25 },
  }, { prefix: "owl-window-sessions-" });
  core.gitGateway().resolveAdvisorSessionDirectory = async () => ({ kind: "direct", cwd: root });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
  core.gitGateway().sweepAdvisorWorkspaces = async () => {};
  await core.start();

  const createProjectWindow = async (name) => {
    const projectId = createUlid();
    const now = new Date().toISOString();
    await db.createWriteLane().transact((tx) => tx.run(
      `INSERT INTO projects
         (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
          verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', '[]', '{}', '[]', ?, ?)`,
      projectId, ownerId, name, `/tmp/${projectId}`, now, now,
    ));
    const window = await core.ensureAdvisorWindow(ownerId, projectId);
    assert.ok(window, `${name} window exists`);
    return window;
  };
  const send = async (conversationId, marker) => {
    const posted = await core.postMessage(conversationId, command({ body: `question ${marker}`, attachment_ids: [] }, `window-sessions:${marker}`));
    await core.advisorRespond(conversationId, posted.data.message_id, { channel: "web" });
  };
  const advisorBodies = (conversationId) =>
    core.listMessages(conversationId, { limit: 50 }).data.filter((message) => message.sender !== "user" && /\|MSG-/.test(message.body)).map((message) => message.body);
  const activeSessions = () => db.all("SELECT id, window_id, status FROM advisor_sessions WHERE status IN ('starting','running','ending','suspended')");
  return { core, db, created, hold, createProjectWindow, send, advisorBodies, activeSessions };
}

/** `newSessions` is how many provider sessions the two windows start; the general window's resident session is already up. */
async function expectSeparateSessions(t, first, second, label, newSessions) {
  const world = await setup(t);
  await waitFor(() => world.created.length === 1, { message: "the general window's resident session is up" });
  const residentCount = world.created.length;
  const windows = await Promise.all([first(world), second(world)]);
  const [one, two] = windows;
  assert.notEqual(one.window_id, two.window_id, `${label}: two different windows`);

  await Promise.all([world.send(one.conversation_id, "MSG-aaa"), world.send(two.conversation_id, "MSG-bbb")]);
  await waitFor(() => world.created.filter((driver) => driver.sent.length === 1).length === 2, {
    message: `${label}: both windows have a turn in flight at the same time`,
  });
  assert.equal(world.created.length, residentCount + newSessions, `${label}: one provider session per window`);

  world.hold.open = true;
  await waitFor(() => world.advisorBodies(one.conversation_id).length === 1 && world.advisorBodies(two.conversation_id).length === 1, {
    message: `${label}: both windows get their reply`,
  });
  const forOne = world.advisorBodies(one.conversation_id);
  const forTwo = world.advisorBodies(two.conversation_id);
  assert.match(forOne[0], /\|MSG-aaa$/, `${label}: the first window's reply answers its own message`);
  assert.match(forTwo[0], /\|MSG-bbb$/, `${label}: the second window's reply answers its own message`);
  assert.notEqual(forOne[0].split("|")[0], forTwo[0].split("|")[0], `${label}: the replies come from different sessions`);

  const active = world.activeSessions().filter((session) => [one.window_id, two.window_id].includes(session.window_id));
  assert.equal(active.length, 2, `${label}: exactly one active session per window`);
  assert.deepEqual(active.map((session) => session.window_id).sort(), [one.window_id, two.window_id].sort());
  const turnSessions = world.db.all("SELECT conversation_id, session_id FROM advisor_turns ORDER BY queued_at");
  assert.equal(new Set(turnSessions.map((turn) => turn.session_id)).size, 2, `${label}: the turns ran on different sessions`);
  return { world, one, two };
}

test("the general window and a project window run in separate sessions at the same time, each reply in its own conversation", async (t) => {
  await expectSeparateSessions(
    t,
    (world) => world.core.ensureAdvisorWindow(ownerId, "general"),
    (world) => world.createProjectWindow("Alpha"),
    "general + project",
    1,
  );
});

test("two project windows run in separate sessions at the same time, each reply in its own conversation", async (t) => {
  await expectSeparateSessions(t, (world) => world.createProjectWindow("Alpha"), (world) => world.createProjectWindow("Beta"), "project + project", 2);
});

test("messages to one window never create a second active session for it, even when sent together", async (t) => {
  const { world, one, two } = await expectSeparateSessions(
    t,
    (inner) => inner.createProjectWindow("Alpha"),
    (inner) => inner.createProjectWindow("Beta"),
    "two windows",
    2,
  );
  const before = world.created.length;

  await Promise.all([world.send(one.conversation_id, "MSG-ccc"), world.send(one.conversation_id, "MSG-ddd"), world.send(two.conversation_id, "MSG-eee")]);
  await waitFor(() => world.advisorBodies(one.conversation_id).length === 3 && world.advisorBodies(two.conversation_id).length === 2, {
    message: "every message is answered",
  });

  assert.equal(world.created.length, before, "no new provider session was started for windows that already have one");
  const active = world.activeSessions().filter((session) => [one.window_id, two.window_id].includes(session.window_id));
  assert.equal(active.length, 2);
  assert.equal(new Set(active.map((session) => session.window_id)).size, 2, "one active session per window");
  const answeredByOne = world.advisorBodies(one.conversation_id).map((body) => body.split("|")[0]);
  assert.equal(new Set(answeredByOne).size, 1, "every reply of a window comes from that window's one session");
  assert.deepEqual(
    world.advisorBodies(one.conversation_id).map((body) => body.split("|")[1]).sort(),
    ["MSG-aaa", "MSG-ccc", "MSG-ddd"],
  );
  assert.deepEqual(world.advisorBodies(two.conversation_id).map((body) => body.split("|")[1]).sort(), ["MSG-bbb", "MSG-eee"]);
});
