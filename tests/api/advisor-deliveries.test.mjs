import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { ADVISOR_TEXT } from "../../packages/core/dist/advisor-text.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { scriptedProvider } from "../helpers/advisor-provider.mjs";
import { createTestCore } from "../helpers/core.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

const text = ADVISOR_TEXT.ja;

/** A Core whose Advisor session is scripted, a started HTTP server on the production adapter, and a Slack reply that awaits delivery of two files. */
async function setup(t) {
  const script = [];
  const { providerClient, sent: calls } = scriptedProvider(script);
  const dir = await tempDir(t, "owl-deliveries-");
  const { root, db, core } = await createTestCore(t, {
    agentRunner: {
      runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
      runWorker: async () => ({ outcome: "failed" }),
      runReviewer: async () => ({ outcome: "failed" }),
    },
    providerClient,
    getAdvisorSendFileSettings: () => ({ dirs: [dir] }),
    getAdvisorFileDestinationSettings: () => ({
      preferredProvider: null,
      defaultDestination: { provider: "slack", channel_id: "CDEF", display_name: "owl" },
      integrations: [{ provider: "slack", configured: true, conversationChannelIds: ["CDEF"] }],
    }),
  }, { prefix: "owl-api-deliveries-", start: true });
  const server = await startTestHttpServer(t, { core: new ExternalCoreAdapter(core, db, root, join(root, "data")), webOut: root, owlRoot: root }, { token: "deliveries-token" });
  if (!server) return null;
  const { conversation_id: conversationId } = await core.getActiveConversation();
  await writeFile(join(dir, "a.txt"), "first");
  await writeFile(join(dir, "b.txt"), "second");
  const reply = async (origin = { channel: "slack", channel_id: "C1", ref: "1.1" }) => {
    const sendFiles = ["a.txt", "b.txt"].map((name) => ({ type: "send_file", description: "send", payload: { path: join(dir, name) } }));
    script.push(["here", "```owl-actions", JSON.stringify(sendFiles), "```"].join("\n"), "Looked into it.");
    const accountId = db.get("SELECT id FROM connector_accounts WHERE owner_id = 'owner:default' AND provider = 'web'").id;
    const userMessageId = createUlid();
    const now = new Date().toISOString();
    await db.createWriteLane().transact((transaction) => {
      transaction.run(
        `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
         VALUES (?, ?, 'web', ?, ?, ?, '[]', ?, ?)`,
        userMessageId, conversationId, accountId, `web-user:${userMessageId}`, "Send the files.", now, now,
      );
    });
    await core.advisorRespond(conversationId, userMessageId, origin);
    const row = await waitFor(
      () => db.get("SELECT payload_json FROM events WHERE type = 'advisor.responded' ORDER BY rowid DESC LIMIT 1"),
      { message: "the Advisor reply is recorded" },
    );
    const payload = JSON.parse(row.payload_json);
    return { turnId: payload.turn_id, messageId: payload.message_id };
  };
  const report = (turnId, messageId, results, id = conversationId) => server.request("POST", `/api/v1/conversations/${id}/advisor-deliveries`, {
    request_id: createUlid(), idempotency_key: `d:${createUlid()}`, expected_version: 0, payload: { turn_id: turnId, message_id: messageId, results },
  });
  const reported = () => db.all("SELECT payload_json FROM events WHERE type = 'advisor.delivery_reported'").map((row) => JSON.parse(row.payload_json));
  return { db, calls, conversationId, reply, report, reported };
}

const failed = { index: 1, outcome: "failed", code: "upload_rejected", platform_error: "not_in_channel", message: "⚠ b.txt を送れませんでした" };

test("a delivery report goes through ExternalCoreAdapter, is saved once and queues one follow-up", async (t) => {
  const env = await setup(t);
  if (!env) return t.skip("listen not permitted");
  const { turnId, messageId } = await env.reply();

  const first = await env.report(turnId, messageId, [{ index: 0, outcome: "sent" }, failed]);
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()).data, { deduplicated: false, followup_pending: true, notice: text.followupPending });
  const [saved] = env.reported();
  assert.equal(saved.turn_id, turnId);
  assert.equal(saved.followup_scope, "all");
  assert.deepEqual(saved.action_failures.map((f) => [f.type, f.status, f.code, f.index]), [["send_file", "failed", "upload_rejected", 1]]);

  const second = await env.report(turnId, messageId, [{ index: 0, outcome: "sent" }, failed]);
  assert.equal(second.status, 200);
  assert.deepEqual((await second.json()).data, { deduplicated: true, followup_pending: true, notice: text.followupPending });
  assert.equal(env.reported().length, 1);
  await waitFor(() => env.calls.length === 2, { message: "the follow-up Advisor turn ran" });
  const followupReplies = () => env.db.all("SELECT 1 FROM events WHERE type = 'advisor.responded' AND json_extract(payload_json, '$.followup_of_turn_id') = ?", turnId);
  await waitFor(() => followupReplies().length === 1, { message: "the follow-up reply is saved" });
  assert.equal(env.calls.length, 2);
});

test("a report on a Web reply updates the card metadata in the same write and a repeated report changes nothing", async (t) => {
  const env = await setup(t);
  if (!env) return t.skip("listen not permitted");
  const { turnId, messageId } = await env.reply({ channel: "web" });
  const card = () => JSON.parse(env.db.get("SELECT metadata_json FROM messages WHERE id = ?", messageId).metadata_json);
  assert.deepEqual(card().files.map((f) => f.status), ["pending", "pending"]);
  assert.equal(card().destination.channel_id, "CDEF");

  const results = [{ index: 0, outcome: "sent" }, failed];
  assert.equal((await env.report(turnId, messageId, results)).status, 200);
  const after = card();
  assert.deepEqual(after.files.map((f) => [f.status, f.code, f.message]), [["sent", undefined, undefined], ["failed", "upload_rejected", failed.message]]);
  assert.equal(after.notice, text.followupPending);
  assert.deepEqual(after.destination, { provider: "slack", channel_id: "CDEF", display_name: "owl", source: "default_destination" });

  assert.equal((await env.report(turnId, messageId, results)).status, 200);
  assert.deepEqual(card(), after);
  assert.equal(env.reported().length, 1);
});

test("a delivery report where every file was sent queues no follow-up", async (t) => {
  const env = await setup(t);
  if (!env) return t.skip("listen not permitted");
  const { turnId, messageId } = await env.reply();
  const response = await env.report(turnId, messageId, [{ index: 0, outcome: "sent" }, { index: 1, outcome: "sent" }]);
  assert.deepEqual((await response.json()).data, { deduplicated: false, followup_pending: false, notice: null });
  assert.equal(env.calls.length, 1, "only the source turn ran");
});

test("a delivery report with an unknown index is 400 and one with no matching reply or conversation is 404", async (t) => {
  const env = await setup(t);
  if (!env) return t.skip("listen not permitted");
  const { turnId, messageId } = await env.reply();
  assert.equal((await env.report(turnId, messageId, [{ index: 7, outcome: "sent" }])).status, 400);
  assert.equal((await env.report(turnId, messageId, [{ index: 0, outcome: "failed", code: "upload_unknown" }])).status, 400);
  assert.equal((await env.report(turnId, messageId, [{ index: 0, outcome: "sent" }, { index: 0, outcome: "sent" }])).status, 400);
  assert.equal((await env.report(turnId, messageId, [])).status, 400);
  assert.equal((await env.report(createUlid(), messageId, [{ index: 0, outcome: "sent" }])).status, 404);
  assert.equal((await env.report(turnId, createUlid(), [{ index: 0, outcome: "sent" }])).status, 404);
  assert.equal((await env.report(turnId, messageId, [{ index: 0, outcome: "sent" }], createUlid())).status, 404);
  assert.equal(env.reported().length, 0);
});

test("two identical reports sent at once save one event and both answer", async (t) => {
  const env = await setup(t);
  if (!env) return t.skip("listen not permitted");
  const { turnId, messageId } = await env.reply();
  const responses = await Promise.all([1, 2].map(() => env.report(turnId, messageId, [failed])));
  assert.deepEqual(responses.map((r) => r.status), [200, 200]);
  const bodies = await Promise.all(responses.map(async (r) => (await r.json()).data));
  assert.deepEqual(bodies.map((b) => b.deduplicated).sort(), [false, true]);
  assert.equal(env.reported().length, 1);
});
