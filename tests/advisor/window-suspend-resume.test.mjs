import assert from "node:assert/strict";
import { test } from "node:test";

import { Core } from "../../packages/core/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { DEFAULT_ADVISOR_WINDOW_SETTINGS } from "../../packages/shared/dist/advisor-window-settings.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { waitFor } from "../helpers/wait.mjs";

const ownerId = "owner:default";

/**
 * A Core whose provider is a fake. Every createSession is recorded with its
 * request; a session answers each turn with "<label>|<MSG marker>". When
 * `failResume` is set, a createSession that asks to resume throws.
 */
async function setup(t) {
  const created = [];
  const control = { actions: null, failResume: false, resumedTurnFails: false, freshTurnFails: false };
  const providerClient = {
    createSession: async (request) => {
      if (request.resume_provider_session_id && control.failResume) throw new Error("the provider no longer knows this session");
      const label = `session-${created.length + 1}`;
      const providerSessionId = request.resume_provider_session_id ?? `provider-${label}`;
      const sent = [];
      const driver = {
        label,
        sent,
        request,
        provider_session_id: providerSessionId,
        pid: process.pid,
        send: async (turn) => { sent.push(turn); },
        events: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: "session.ready", provider_session_id: providerSessionId, pid: process.pid };
            for (let handled = 0; ; handled += 1) {
              await waitFor(() => sent.length > handled, { message: `${label} has turn ${handled + 1}` });
              if (request.resume_provider_session_id && control.resumedTurnFails) {
                yield { type: "turn.failed", turn_id: sent[handled].turn_id, error: "No conversation found with session ID", provider_error: { code: "conversation_not_found" } };
                continue;
              }
              if (!request.resume_provider_session_id && control.freshTurnFails) {
                yield { type: "turn.failed", turn_id: sent[handled].turn_id, error: "the fresh session also failed" };
                continue;
              }
              const marker = /MSG-[a-z0-9]+/.exec(sent[handled].text)?.[0] ?? "no-marker";
              const fence = control.actions && sent[handled].text.includes("question MSG-bbb") ? `\n\`\`\`owl-actions\n${JSON.stringify(control.actions)}\n\`\`\`` : "";
              yield { type: "turn.completed", turn_id: sent[handled].turn_id, reply: `${label}|${marker}${fence}`, usage: null };
            }
          },
        }),
        stop: async () => {},
      };
      created.push(driver);
      return driver;
    },
  };
  const coreOptions = {
    agentRunner: {
      runManagerPlan: async () => { throw new Error("No Work is planned here."); },
      runWorker: async () => { throw new Error("No Worker runs here."); },
      runReviewer: async () => { throw new Error("No Reviewer runs here."); },
      runAdvisor: async () => { throw new Error("The persistent provider session handles replies."); },
    },
    providerClient,
    version: "window-suspend-resume-test",
    dispatcher: { tick_interval_ms: 25 },
  };
  const stubGit = (core, root) => {
    core.gitGateway().resolveAdvisorSessionDirectory = async () => ({ kind: "direct", cwd: root });
    core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
    core.gitGateway().sweepAdvisorWorkspaces = async () => {};
  };
  const { root, db, core } = await createTestCore(t, coreOptions, { prefix: "owl-window-suspend-resume-" });
  stubGit(core, root);
  await core.start();
  /** Stops the Core and starts a second one on the same database and root, the way a restart does. */
  const rebuild = async () => {
    await core.stop({ force: true });
    const second = new Core({ agentRunner: {}, version: "test", ...coreOptions, db, owlRoot: root });
    stubGit(second, root);
    await second.start();
    return second;
  };

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
    const posted = await core.postMessage(conversationId, command({ body: `question ${marker}`, attachment_ids: [] }, `window-suspend-resume:${marker}`));
    await core.advisorRespond(conversationId, posted.data.message_id, { channel: "web" });
  };
  const replies = (conversationId) =>
    core.listMessages(conversationId, { limit: 50 }).data.filter((message) => message.sender !== "user" && /\|MSG-/.test(message.body)).map((message) => message.body);
  const sessionsOf = (windowId) => db.all(
    "SELECT id, status, provider_session_id, resumed_count, end_reason FROM advisor_sessions WHERE window_id = ? ORDER BY created_at",
    windowId,
  );
  /** Makes the window's running session look idle for longer than its timeout, then runs the periodic pass. */
  const idleThenTick = async (windowId) => {
    const stale = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    await db.createWriteLane().transact((tx) => tx.run(
      "UPDATE advisor_sessions SET last_activity_at = ? WHERE window_id = ? AND status = 'running'", stale, windowId,
    ));
    await core.runAdvisorWindowTick();
  };
  return { root, db, core, rebuild, created, control, createProjectWindow, send, replies, sessionsOf, idleThenTick };
}

test("an idle window is suspended and keeps its provider session id", async (t) => {
  const world = await setup(t);
  const window = await world.createProjectWindow("Alpha");
  await world.send(window.conversation_id, "MSG-aaa");
  await waitFor(() => world.replies(window.conversation_id).length === 1, { message: "first reply" });
  const [running] = world.sessionsOf(window.window_id);
  assert.equal(running.status, "running");

  await world.idleThenTick(window.window_id);

  const [suspended, ...others] = world.sessionsOf(window.window_id);
  assert.equal(others.length, 0);
  assert.equal(suspended.id, running.id);
  assert.equal(suspended.status, "suspended");
  assert.equal(suspended.provider_session_id, running.provider_session_id);
  assert.ok(suspended.provider_session_id);
});

test("a window that is not idle long enough is left running", async (t) => {
  const world = await setup(t);
  const window = await world.createProjectWindow("Alpha");
  await world.send(window.conversation_id, "MSG-aaa");
  await waitFor(() => world.replies(window.conversation_id).length === 1, { message: "first reply" });

  await world.core.runAdvisorWindowTick();

  assert.equal(world.sessionsOf(window.window_id)[0].status, "running");
});

test("a message to a suspended window resumes it with the old id and replies in the same conversation", async (t) => {
  const world = await setup(t);
  const window = await world.createProjectWindow("Alpha");
  await world.send(window.conversation_id, "MSG-aaa");
  await waitFor(() => world.replies(window.conversation_id).length === 1, { message: "first reply" });
  const [before] = world.sessionsOf(window.window_id);
  await world.idleThenTick(window.window_id);
  assert.equal(world.sessionsOf(window.window_id)[0].status, "suspended");
  const startedBefore = world.created.length;

  await world.send(window.conversation_id, "MSG-bbb");
  await waitFor(() => world.replies(window.conversation_id).length === 2, { message: "reply after resume" });

  assert.equal(world.created.length, startedBefore + 1);
  assert.equal(world.created.at(-1).request.resume_provider_session_id, before.provider_session_id, "resumed with the old provider session id");
  const sessions = world.sessionsOf(window.window_id);
  assert.equal(sessions.length, 1, "the same session row carries on");
  assert.equal(sessions[0].id, before.id);
  assert.equal(sessions[0].status, "running");
  assert.equal(sessions[0].provider_session_id, before.provider_session_id);
  assert.equal(sessions[0].resumed_count, before.resumed_count + 1);
  assert.match(world.replies(window.conversation_id)[1], /\|MSG-bbb$/);
});

test("a suspended general window is not relaunched by residency checks or a Core rebuild", async (t) => {
  const world = await setup(t);
  await waitFor(() => world.created.length === 1, { message: "the resident session is up" });
  const general = await world.core.ensureAdvisorWindow(ownerId, "general");
  await waitFor(() => world.sessionsOf(general.window_id).some((session) => session.status === "running"), { message: "general session running" });
  await world.idleThenTick(general.window_id);
  assert.equal(world.sessionsOf(general.window_id)[0].status, "suspended");

  await world.core.keepAdvisorResident();
  assert.equal(world.created.length, 1, "a residency check does not relaunch it");
  assert.equal(world.sessionsOf(general.window_id)[0].status, "suspended");

  const rebuilt = await world.rebuild();
  try {
    await rebuilt.keepAdvisorResident();
  } finally {
    await rebuilt.stop({ force: true });
  }
  assert.equal(world.created.length, 1, "a Core rebuild does not relaunch it either");
  assert.equal(world.sessionsOf(general.window_id)[0].status, "suspended");
  assert.equal(world.sessionsOf(general.window_id).length, 1);
});

test("a failed resume ends with resume_failed and the fresh session's first turn carries the last N messages", async (t) => {
  const world = await setup(t);
  const window = await world.createProjectWindow("Alpha");
  const handoff = DEFAULT_ADVISOR_WINDOW_SETTINGS.history_handoff_messages;
  for (let index = 0; index < handoff + 2; index += 1) {
    await world.send(window.conversation_id, `MSG-h${index}`);
    await waitFor(() => world.replies(window.conversation_id).length === index + 1, { message: `reply ${index + 1}` });
  }
  const [before] = world.sessionsOf(window.window_id);
  await world.idleThenTick(window.window_id);
  world.control.failResume = true;
  const startedBefore = world.created.length;

  await world.send(window.conversation_id, "MSG-new");
  await waitFor(() => world.replies(window.conversation_id).length === handoff + 3, { message: "reply from the fresh session" });

  const sessions = world.sessionsOf(window.window_id);
  assert.equal(sessions[0].id, before.id);
  assert.equal(sessions[0].status, "ended");
  assert.equal(sessions[0].end_reason, "resume_failed");
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].status, "running");
  const fresh = world.created.at(-1);
  assert.equal(world.created.length, startedBefore + 1);
  assert.equal(fresh.request.resume_provider_session_id, undefined);
  const firstTurn = fresh.sent[0].text;
  assert.match(firstTurn, /owl-window-history/);
  assert.equal((firstTurn.match(/"body"/g) ?? []).length, handoff, "exactly the last N messages are handed over");
  assert.match(firstTurn, /MSG-new/);
});

/** Answers one turn, then marks it failed so the session looks like one that never produced a reply, then suspends it. */
async function suspendUnanswered(world, window) {
  await world.send(window.conversation_id, "MSG-aaa");
  await waitFor(() => world.replies(window.conversation_id).length === 1, { message: "first reply" });
  await world.db.createWriteLane().transact((tx) => tx.run("UPDATE advisor_turns SET status = 'failed' WHERE status = 'completed'"));
  await world.idleThenTick(window.window_id);
  assert.equal(world.sessionsOf(window.window_id)[0].status, "suspended");
}

test("a suspended session that never completed a turn starts fresh without --resume and gets the window history", async (t) => {
  const world = await setup(t);
  const window = await world.createProjectWindow("Alpha");
  await suspendUnanswered(world, window);

  await world.send(window.conversation_id, "MSG-bbb");
  await waitFor(() => world.replies(window.conversation_id).length === 2, { message: "reply from the fresh session" });

  const fresh = world.created.at(-1);
  assert.equal(fresh.request.resume_provider_session_id, undefined);
  assert.match(fresh.sent[0].text, /owl-window-history/);
  assert.equal(world.sessionsOf(window.window_id)[0].end_reason, "resume_failed");
});

test("a resumed first turn that finds no conversation is resent once on a fresh session without an error reaching the Owner", async (t) => {
  const world = await setup(t);
  const window = await world.createProjectWindow("Alpha");
  await world.send(window.conversation_id, "MSG-aaa");
  await waitFor(() => world.replies(window.conversation_id).length === 1, { message: "first reply" });
  await world.idleThenTick(window.window_id);
  world.control.resumedTurnFails = true;
  world.control.actions = [{ type: "create_work", description: "Create Work", payload: { title: "Resend Work", summary: "s", size: "small", project_id: null } }];
  const startedBefore = world.created.length;

  await world.send(window.conversation_id, "MSG-bbb");
  await waitFor(() => world.replies(window.conversation_id).length === 2, { message: "reply after the resend" });
  const responded = world.db.all("SELECT payload_json FROM events WHERE type = 'advisor.responded'").map((row) => JSON.parse(row.payload_json));
  assert.equal(responded.length, 2, "one reply for each message, so the resent message's owl-actions are handled once");
  assert.equal(world.db.all("SELECT 1 FROM works WHERE title = 'Resend Work'").length, 1, "the action created exactly one Work");

  assert.equal(world.created.length, startedBefore + 2, "one resumed session and one fresh session");
  assert.equal(world.created.at(-2).sent.length, 1);
  assert.equal(world.created.at(-1).sent.length, 1, "the message is sent once on the fresh session");
  assert.equal(world.sessionsOf(window.window_id)[0].end_reason, "resume_failed");
  const advisorMessages = world.core.listMessages(window.conversation_id, { limit: 50 }).data.filter((m) => m.sender !== "user");
  assert.ok(!advisorMessages.some((m) => /No conversation found/.test(m.body)), "no failure message was posted");
});

test("when the resend also fails the error is returned and nothing is sent a third time", async (t) => {
  const world = await setup(t);
  const window = await world.createProjectWindow("Alpha");
  await world.send(window.conversation_id, "MSG-aaa");
  await waitFor(() => world.replies(window.conversation_id).length === 1, { message: "first reply" });
  await world.idleThenTick(window.window_id);
  world.control.resumedTurnFails = true;
  world.control.freshTurnFails = true;
  const startedBefore = world.created.length;

  await world.send(window.conversation_id, "MSG-bbb");
  await waitFor(() => world.db.all("SELECT 1 FROM advisor_turns WHERE status = 'failed'").length === 1, { message: "the turn fails" });

  assert.equal(world.created.length, startedBefore + 2);
  const sentTotal = world.created.slice(startedBefore).reduce((sum, driver) => sum + driver.sent.length, 0);
  assert.equal(sentTotal, 2, "resumed send plus a single resend");
  assert.equal(world.replies(window.conversation_id).length, 1);
  const errors = () => world.core.listMessages(window.conversation_id, { limit: 50 }).data
    .filter((m) => m.sender !== "user" && /the fresh session also failed|No conversation found/.test(m.body)).map((m) => m.body);
  await waitFor(() => errors().length === 1, { message: "the error reaches the Owner" });
  assert.match(errors()[0], /the fresh session also failed/);
  assert.ok(!errors().some((body) => /No conversation found/.test(body)), "the first resume failure is not shown");
});
