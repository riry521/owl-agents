import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ADVISOR_TEXT } from "../../packages/core/dist/advisor-text.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { ADVISOR_FOLLOWUP_TURN_TEXT } from "../../packages/shared/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { waitFor } from "../helpers/wait.mjs";

const ownerId = "owner:default";
const text = ADVISOR_TEXT.ja;

const actions = (...list) => ["Working.", "```owl-actions", JSON.stringify(list), "```"].join("\n");
const pauseMissing = (workId = "no-such-work-id") => ({ type: "pause_work", description: "Pause", payload: { work_id: workId } });
const failingKinds = {
  work_op: pauseMissing(),
  call_api: { type: "call_api", description: "Call", payload: { method: "GET" } },
  create_work: { type: "create_work", description: "Create", payload: { title: "", summary: "", size: "small", project_id: null } },
};

/**
 * A Core whose provider replays `script`: a string is the reply, { fail } fails the turn, { hold } never answers
 * (stop() ends the session like a killed driver), { gate, reply } answers after gate resolves.
 */
async function setup(t, script, shared = {}) {
  const sent = [];
  const providerClient = {
    createSession: async () => {
      let stopped;
      let ready = false;
      let handled = 0;
      const stopping = new Promise((resolve) => { stopped = resolve; });
      const driver = {
        provider_session_id: `provider-${sent.length}`,
        pid: process.pid,
        send: async (turn) => { sent.push(turn); },
        events: () => ({
          async *[Symbol.asyncIterator]() {
            if (!ready) {
              ready = true;
              yield { type: "session.ready", provider_session_id: driver.provider_session_id, pid: process.pid };
            }
            // The runtime may iterate events() again for each turn, so the position lives on the driver.
            for (;;) {
              await waitFor(() => sent.length > handled, { message: "a turn arrives" });
              const turn = sent[handled];
              handled += 1;
              const next = script.shift() ?? "ok";
              if (next?.hold) {
                await stopping;
                yield { type: "session.exited", exit_code: null, signal: "SIGTERM", stderr_tail: "" };
                return;
              }
              if (next?.gate) await next.gate;
              if (next?.fail) {
                yield { type: "turn.failed", turn_id: turn.turn_id, error: "provider failed", provider_error: null };
              } else {
                yield { type: "turn.completed", turn_id: turn.turn_id, reply: next?.reply ?? next, usage: null };
              }
            }
          },
        }),
        stop: async () => { stopped(); },
      };
      return driver;
    },
  };
  const { root, db, core } = await createTestCore(t, {
    agentRunner: {
      runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
      runWorker: async () => ({ outcome: "failed" }),
      runReviewer: async () => ({ outcome: "failed" }),
      runAdvisor: async () => { throw new Error("The persistent provider session handles replies."); },
    },
    providerClient,
    version: "followup-test",
    dispatcher: { tick_interval_ms: 25 },
    ...shared,
  }, { prefix: "owl-followup-" });
  core.gitGateway().inspectAdvisorWorkspace = async () => ({ ok: true, dirty: false, message: "clean" });
  core.gitGateway().sweepAdvisorWorkspaces = async () => {};
  await core.start();
  const conversationId = (await core.getActiveConversation()).conversation_id;

  async function ask(body, origin = { channel: "web" }) {
    const accountId = db.get("SELECT id FROM connector_accounts WHERE owner_id = ? AND provider = 'web'", ownerId).id;
    const id = createUlid();
    const now = new Date().toISOString();
    await db.createWriteLane().transact((tx) => tx.run(
      `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
       VALUES (?, ?, 'web', ?, ?, ?, '[]', ?, ?)`,
      id, conversationId, accountId, `web-user:${id}`, body, now, now,
    ));
    await core.advisorRespond(conversationId, id, origin);
    return id;
  }
  const turns = () => db.all("SELECT * FROM advisor_turns WHERE conversation_id = ? ORDER BY queued_at, rowid", conversationId);
  const settled = (count) => waitFor(() => {
    const rows = turns();
    return rows.length >= count && rows.every((row) => ["completed", "failed"].includes(row.status)) ? rows : null;
  }, { message: `${count} turns settled` });
  const responded = (turnId) => {
    const row = db.get("SELECT payload_json FROM events WHERE type = 'advisor.responded' AND json_extract(payload_json, '$.turn_id') = ?", turnId);
    return row ? JSON.parse(row.payload_json) : null;
  };
  const body = (messageId) => db.get("SELECT body FROM messages WHERE id = ?", messageId).body;
  return { root, db, core, conversationId, sent, ask, turns, settled, responded, body };
}

for (const [kind, failing] of Object.entries(failingKinds)) {
  test(`a failed ${kind} queues one follow-up in the reply's transaction and the follow-up replies with the label`, async (t) => {
    const env = await setup(t, [actions(failing), "Fixed it."]);
    const first = await env.ask("Please do it");
    const [source, followup] = await env.settled(2);
    assert.equal(env.turns().length, 2);

    assert.equal(followup.followup_of_turn_id, source.id);
    assert.equal(followup.origin_channel, source.origin_channel);
    assert.equal(followup.session_id, source.session_id);

    const payload = env.responded(source.id);
    assert.equal(payload.followup_pending, true);
    assert.ok(payload.action_results.includes(text.followupPending));
    assert.ok(payload.action_failures.length >= 1);

    const input = env.sent[1].text;
    assert.ok(input.includes("<owl-action-results>"));
    assert.ok(input.includes("<owl-action-failures"));
    assert.ok(input.includes(`"code"`) && input.includes(`"message"`), "the failure carries its code and message");
    assert.ok(input.includes(ADVISOR_FOLLOWUP_TURN_TEXT));
    assert.notEqual(first, followup.user_message_id);

    const followupPayload = env.responded(followup.id);
    assert.equal(followupPayload.followup_of_turn_id, source.id);
    const reply = env.db.get(
      "SELECT body FROM messages WHERE conversation_id = ? AND source_message_id LIKE ?", env.conversationId, `advisor:%:${followup.id}`,
    );
    assert.ok(reply.body.startsWith(text.followupLabel), "the follow-up reply carries the label prefix");
    assert.equal(followup.user_message_id, env.db.get("SELECT id FROM messages WHERE source_message_id LIKE ?", `advisor:%:${source.id}`).id);
  });
}

test("a second failure inside a follow-up stops with a notice, queues no third turn and cannot be forced by a duplicate row", async (t) => {
  const env = await setup(t, [actions(pauseMissing()), actions(pauseMissing()), "unused"]);
  await env.ask("Please do it");
  const [source, followup] = await env.settled(2);
  const reply = env.db.get("SELECT body FROM messages WHERE source_message_id LIKE ?", `advisor:%:${followup.id}`).body;
  assert.ok(reply.includes(text.followupStopped), reply + JSON.stringify(env.responded(followup.id)));
  assert.equal(env.responded(followup.id).followup_pending, undefined);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(env.turns().length, 2, "no third turn");
  await assert.rejects(env.db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO advisor_turns (id, session_id, conversation_id, user_message_id, status, origin_channel, queued_at, followup_of_turn_id)
     VALUES (?, ?, ?, ?, 'queued', 'web', ?, ?)`,
    createUlid(), source.session_id, env.conversationId, followup.user_message_id, new Date().toISOString(), source.id,
  )), /UNIQUE/u);
});

test("a provider error in a follow-up only records advisor_error and an action that is not a retry is not executed", async (t) => {
  const env = await setup(t, [actions(pauseMissing()), { fail: true }]);
  await env.ask("Please do it");
  const [source, followup] = await env.settled(2);
  assert.equal(followup.status, "failed");
  assert.equal(env.turns().length, 2);
  assert.equal(env.responded(followup.id)?.kind, "advisor_error", "a failed follow-up records only the error");
  assert.equal(env.db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'advisor.followup_retry_started'").n, 0);

  // A follow-up that wants an unrelated, non-retry action gets it held rather than executed.
  const env2 = await setup(t, [actions(pauseMissing()), actions({ type: "cancel_work", description: "Cancel", payload: { work_id: "another-work" } })]);
  await env2.ask("Please do it");
  const [, held] = await env2.settled(2);
  const heldReply = env2.db.get("SELECT body FROM messages WHERE source_message_id LIKE ?", `advisor:%:${held.id}`).body;
  assert.ok(heldReply.includes(text.followupHeldChanged("cancel_work")) || heldReply.includes(text.followupHeldOther("cancel_work")));
  assert.equal(env2.db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'work.cancelled'").n, 0);
  assert.ok(source);
});

test("advisor.followup_retry_started is written before the retry runs, and a failed write holds the action", async (t) => {
  const env = await setup(t, [actions(pauseMissing()), actions(pauseMissing()), "ok"]);
  await env.ask("Please do it");
  const [source, followup] = await env.settled(2);
  const started = env.db.get("SELECT payload_json, sequence FROM events WHERE idempotency_key = ?", `advisor-followup-retry:${source.id}:0`);
  assert.ok(started, "the retry record exists under the documented key");
  const record = JSON.parse(started.payload_json);
  assert.equal(record.followup_turn_id, followup.id);
  assert.equal(record.source_turn_id, source.id);
  const responded = env.db.get("SELECT sequence FROM events WHERE type = 'advisor.responded' AND json_extract(payload_json, '$.turn_id') = ?", followup.id);
  assert.ok(started.sequence < responded.sequence);

  const env2 = await setup(t, [actions(pauseMissing()), actions(pauseMissing())]);
  const write = env2.core.writeLane.write.bind(env2.core.writeLane);
  env2.core.writeLane.write = (request) => request.event.type === "advisor.followup_retry_started"
    ? Promise.reject(new Error("disk full"))
    : write(request);
  await env2.ask("Please do it");
  const [, held] = await env2.settled(2);
  const body = env2.db.get("SELECT body FROM messages WHERE source_message_id LIKE ?", `advisor:%:${held.id}`).body;
  assert.ok(body.includes(text.followupHeldNotRecorded("pause_work")));
  assert.equal(env2.db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'advisor.followup_retry_started'").n, 0);
});

test("a follow-up re-sent after an interruption does not run the same retry again at another index", async (t) => {
  const env = await setup(t, [actions(pauseMissing()), actions(pauseMissing()), actions({ type: "update_work", description: "x", payload: {} }, pauseMissing())]);
  // The process dies after the retry was recorded but before the follow-up's reply was saved.
  const write = env.core.writeLane.write.bind(env.core.writeLane);
  let crashed = false;
  env.core.writeLane.write = (request) => {
    if (!crashed && request.event.type === "advisor.responded" && request.event.payload.followup_of_turn_id) {
      crashed = true;
      return Promise.reject(new Error("crash before the reply was saved"));
    }
    return write(request);
  };
  await env.ask("Please do it");
  const [source, followup] = await env.settled(2);
  assert.equal(crashed, true);
  assert.equal(env.db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'advisor.followup_retry_started'").n, 1);
  await env.db.createWriteLane().transact((tx) => {
    tx.run("UPDATE advisor_turns SET status = 'interrupted', retry_count = 0 WHERE id = ?", followup.id);
  });
  await env.core.advisorRuntime.recoverTurns();
  await waitFor(() => env.turns().find((row) => row.id === followup.id)?.status === "completed", { message: "the follow-up ran again" });
  const body = env.db.get(
    "SELECT body FROM messages WHERE source_message_id LIKE ? AND source_message_id NOT LIKE 'advisor:error:%'", `advisor:%:${followup.id}%`,
  ).body;
  assert.ok(body.includes(text.followupHeldRecorded("pause_work")), body);
  assert.equal(env.db.get("SELECT COUNT(*) AS n FROM events WHERE idempotency_key = ?", `advisor-followup-retry:${source.id}:0`).n, 1);
  assert.equal(env.turns().length, 2);
});

test("a follow-up that was running at a restart runs once on the next Core", async (t) => {
  const first = await setup(t, [actions(pauseMissing()), { hold: true }]);
  await first.ask("Please do it");
  await waitFor(() => first.turns().length === 2 && first.turns()[1].status === "running", { message: "the follow-up is running" });
  const followupId = first.turns()[1].id;
  await first.core.stop();
  first.core.stop = async () => {};

  const reopened = createTestDatabase(first.root);
  const second = await setup(t, ["Recovered."], { db: reopened, owlRoot: first.root });
  t.after(() => reopened.close()); // after the Core's own cleanup, which still reads the DB
  await waitFor(() => second.turns().find((row) => row.id === followupId)?.status === "completed", { message: "the recovered follow-up completed" });
  assert.equal(second.sent.filter((turn) => turn.text.includes("<owl-action-failures")).length, 1);
  assert.equal(second.turns().length, 2);
  assert.equal(second.db.get("SELECT COUNT(*) AS n FROM advisor_turns WHERE followup_of_turn_id IS NOT NULL").n, 1);
});

test("no follow-up is queued when an Owner turn is already queued and that turn carries the failures", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const env = await setup(t, [{ gate, reply: actions(pauseMissing()) }, "Second answer."]);
  await env.ask("First");
  await waitFor(() => env.turns().length === 1 && env.turns()[0].status === "running", { message: "the first turn runs" });
  await env.ask("Second");
  release();
  const rows = await env.settled(2);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => row.followup_of_turn_id !== null).length, 0);
  const payload = env.responded(rows[0].id);
  assert.equal(payload.followup_pending, undefined);
  assert.ok(!payload.action_results.includes(text.followupPending));
  assert.ok(env.sent[1].text.includes("<owl-action-results>"));
  assert.ok(env.sent[1].text.indexOf("<owl-action-results>") < env.sent[1].text.indexOf("Second"));
});

test("a spontaneous reply still gets a follow-up when a later turn is queued, and the Web counts the queued follow-up", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const env = await setup(t, ["Plain answer.", { gate, reply: "Slow answer." }, "Follow-up answer."]);
  await env.ask("First");
  await env.settled(1);
  await env.ask("Second");
  await waitFor(() => env.turns().length === 2 && env.turns()[1].status === "running", { message: "the second turn runs" });
  await env.ask("Third");
  assert.equal(env.turns().length, 3);

  const spontaneousId = createUlid();
  const messageId = await env.core.persistAdvisorReply(env.conversationId, "", spontaneousId, { channel: "web" }, [pauseMissing()]);
  const followup = env.db.get("SELECT * FROM advisor_turns WHERE followup_of_turn_id = ?", spontaneousId);
  assert.ok(followup, "a follow-up was queued for the spontaneous reply");
  assert.equal(followup.user_message_id, messageId);
  assert.equal(followup.status, "queued");
  const queued = env.db.get(
    "SELECT COUNT(*) AS count FROM advisor_turns WHERE session_id = ? AND status = 'queued' AND conversation_id = ?", followup.session_id, env.conversationId,
  ).count;
  assert.ok(queued >= 2, "the queued follow-up is counted with the queued Owner turn");

  release();
  await waitFor(() => env.turns().find((row) => row.id === followup.id)?.status === "completed", { message: "the follow-up completed" });
  const reply = env.db.get("SELECT body FROM messages WHERE conversation_id = ? AND source_message_id LIKE ?", env.conversationId, `advisor:%:${followup.id}`);
  assert.ok(reply.body.startsWith(text.followupLabel), "the follow-up reply lands in messages");
});

const sendInstruction = (workId) => ({ type: "send_work_instruction", description: "Send", payload: { work_id: workId, body: "do it", reopen: false } });

test("an interrupted follow-up that re-presents the same send_work_instruction at another index sends it once", async (t) => {
  const script = [];
  const env = await setup(t, script);
  const created = await env.core.createWork(command({ title: "Target", summary: "s", size: "small", project_id: null }, "followup-test:create"));
  const workId = created.data.work_id;
  await env.db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'running', state_version = 1 WHERE id = ?", workId));
  let calls = 0;
  let delivered = 0;
  env.core.postWorkInstruction = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("stale"), { code: "version_conflict" });
    delivered += 1;
    return { data: {} };
  };
  script.push(
    actions(sendInstruction(workId)),
    actions(sendInstruction(workId)),
    actions({ type: "update_work", description: "x", payload: {} }, sendInstruction(workId)),
  );
  const write = env.core.writeLane.write.bind(env.core.writeLane);
  let crashed = false;
  env.core.writeLane.write = (request) => {
    if (!crashed && request.event.type === "advisor.responded" && request.event.payload.followup_of_turn_id) {
      crashed = true;
      return Promise.reject(new Error("crash before the reply was saved"));
    }
    return write(request);
  };
  await env.ask("Please do it");
  const [, followup] = await env.settled(2);
  assert.equal(crashed, true);
  assert.equal(delivered, 1, "the follow-up delivered the instruction");
  await env.db.createWriteLane().transact((tx) => {
    tx.run("UPDATE advisor_turns SET status = 'interrupted', retry_count = 0 WHERE id = ?", followup.id);
  });
  await env.core.advisorRuntime.recoverTurns();
  await waitFor(() => env.turns().find((row) => row.id === followup.id)?.status === "completed", { message: "the follow-up ran again" });
  assert.equal(delivered, 1, "the re-presented instruction was not delivered again");
});

test("a queued follow-up left at a restart runs once on the next Core", async (t) => {
  const first = await setup(t, [actions(pauseMissing()), { hold: true }]);
  await first.ask("Please do it");
  await waitFor(() => first.turns().length === 2 && first.turns()[1].status === "running", { message: "the follow-up is running" });
  const followupId = first.turns()[1].id;
  await first.core.stop();
  first.core.stop = async () => {};
  await first.db.createWriteLane().transact((tx) => tx.run("UPDATE advisor_turns SET status = 'queued' WHERE id = ?", followupId));

  const reopened = createTestDatabase(first.root);
  const second = await setup(t, ["Recovered."], { db: reopened, owlRoot: first.root });
  t.after(() => reopened.close());
  await waitFor(() => second.turns().find((row) => row.id === followupId)?.status === "completed", { message: "the queued follow-up completed" });
  assert.equal(second.sent.filter((turn) => turn.text.includes("<owl-action-failures")).length, 1);
  assert.equal(second.turns().length, 2);
  assert.equal(second.db.get("SELECT COUNT(*) AS n FROM messages WHERE source_message_id LIKE ?", `advisor:%:${followupId}`).n, 1);
});

const slackOrigin = { channel: "slack", channel_id: "C1", ref: "1.1" };
const sendFiles = (...paths) => actions(...paths.map((path) => ({ type: "send_file", description: "Send", payload: { path } })));
const sentFile = (index) => ({ index, outcome: "sent" });
const rejectedFile = (index) => ({ index, outcome: "failed", code: "upload_rejected", platform_error: "not_in_channel", message: "not in channel" });

/**
 * A runtime Core whose send_file allow-list is a directory holding a.txt and b.txt. `script(files)` returns the provider replies;
 * report() posts a delivery report for the reply of a turn.
 */
async function deliverySetup(t, script) {
  const dir = await mkdtemp(join(tmpdir(), "owl-followup-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "a.txt"), "first");
  await writeFile(join(dir, "b.txt"), "second");
  const files = [join(dir, "a.txt"), join(dir, "b.txt")];
  const env = await setup(t, script(files), { getAdvisorSendFileSettings: () => ({ dirs: [dir] }) });
  const report = (turnId, results) => env.core.reportAdvisorDelivery(ownerId, env.conversationId, {
    turn_id: turnId, message_id: env.responded(turnId).message_id, results,
  });
  const reports = () => env.db.all("SELECT payload_json FROM events WHERE type = 'advisor.delivery_reported' ORDER BY sequence").map((row) => JSON.parse(row.payload_json));
  return { ...env, files, report, reports };
}

test("a failed send_file report queues one follow-up whose input carries the send_file failure, and an all-sent report queues none", async (t) => {
  const env = await deliverySetup(t, (files) => [sendFiles(...files), "Sent the rest.", sendFiles(...files), "unused"]);
  await env.ask("Send them", slackOrigin);
  const [source] = await env.settled(1);
  assert.equal(env.responded(source.id).delivery_pending, true);

  const result = await env.report(source.id, [sentFile(0), rejectedFile(1)]);
  assert.deepEqual(result, { deduplicated: false, followup_pending: true, notice: text.followupPending });
  const [, followup] = await env.settled(2);
  assert.equal(followup.followup_of_turn_id, source.id);
  assert.equal(env.turns().length, 2);
  const input = env.sent[1].text;
  assert.ok(input.includes("<owl-action-failures") && input.includes(`"type":"send_file"`) && input.includes("upload_rejected"), input);
  assert.equal(env.reports()[0].followup_scope, "all");

  const second = await env.ask("Again", slackOrigin);
  const [, , again] = await env.settled(3);
  assert.notEqual(again.user_message_id, second.id);
  const none = await env.report(again.id, [sentFile(0), sentFile(1)]);
  assert.deepEqual(none, { deduplicated: false, followup_pending: false, notice: null });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(env.turns().length, 3, "an all-sent report queues nothing");
});

test("a delivery failure on a reply that is itself a follow-up queues no row and returns the stop notice", async (t) => {
  const env = await deliverySetup(t, (files) => [sendFiles(...files), sendFiles(files[1])]);
  await env.ask("Send them", slackOrigin);
  const [source] = await env.settled(1);
  await env.report(source.id, [sentFile(0), { ...rejectedFile(1), code: "upload_rate_limited", platform_error: "ratelimited" }]);
  const [, followup] = await env.settled(2);
  assert.equal(followup.followup_of_turn_id, source.id);
  assert.equal(env.responded(followup.id).delivery_pending, true);
  const result = await env.report(followup.id, [rejectedFile(0)]);
  assert.equal(result.followup_pending, false);
  assert.equal(result.notice, text.followupStopped);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(env.turns().length, 2, "no third turn");
});

test("a report arriving after the next Owner turn started is queued with followup_scope delivery and only the delivery failure", async (t) => {
  const env = await deliverySetup(t, (files) => [sendFiles(...files), "Next answer.", "Resent."]);
  await env.ask("Send them", slackOrigin);
  const [source] = await env.settled(1);
  await env.ask("Something else", slackOrigin);
  await env.settled(2);

  const result = await env.report(source.id, [sentFile(0), rejectedFile(1)]);
  assert.equal(result.followup_pending, true);
  const rows = await env.settled(3);
  assert.equal(rows[2].followup_of_turn_id, source.id);
  assert.equal(env.reports()[0].followup_scope, "delivery");
  const input = env.sent[2].text;
  assert.ok(input.includes(`"type":"send_file"`) && input.includes("upload_rejected"), input);
});

test("after upload_unknown a re-emitted identical send_file is not delivered again", async (t) => {
  const env = await deliverySetup(t, (files) => [sendFiles(files[0]), sendFiles(files[0])]);
  await env.ask("Send it", slackOrigin);
  const [source] = await env.settled(1);
  await env.report(source.id, [{ index: 0, outcome: "unknown", code: "upload_unknown", platform_error: null, message: "no answer" }]);
  const [, followup] = await env.settled(2);
  const payload = env.responded(followup.id);
  assert.ok(!payload.outbound_files?.length, JSON.stringify(payload));
  assert.notEqual(payload.delivery_pending, true);
});
