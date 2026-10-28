import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { ADVISOR_TEXT } from "../../packages/core/dist/advisor-text.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { waitFor } from "../helpers/wait.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

const text = ADVISOR_TEXT.ja;

/** A Core with no runtime (the one-shot path), a started HTTP server on the production adapter, and a Slack reply that awaits delivery of two files. */
async function setup(t) {
  const calls = [];
  const dir = join((await import("node:os")).tmpdir(), `owl-deliveries-${createUlid()}`);
  await mkdir(dir, { recursive: true });
  const { root, db, core } = await createTestCore(t, {
    agentRunner: {
      runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
      runWorker: async () => ({ outcome: "failed" }),
      runReviewer: async () => ({ outcome: "failed" }),
      runAdvisor: async (request) => { calls.push(request); return { reply: "Looked into it." }; },
    },
    getAdvisorSendFileSettings: () => ({ dirs: [dir] }),
  }, { prefix: "owl-api-deliveries-", start: true });
  const server = await startTestHttpServer(t, { core: new ExternalCoreAdapter(core, db, root, join(root, "data")), webOut: root, owlRoot: root }, { token: "deliveries-token" });
  if (!server) return null;
  const { conversation_id: conversationId } = await core.getActiveConversation();
  await writeFile(join(dir, "a.txt"), "first");
  await writeFile(join(dir, "b.txt"), "second");
  const reply = async () => {
    const turnId = createUlid();
    await core.persistAdvisorReply(conversationId, "here", turnId, { channel: "slack", channel_id: "C1", ref: "1.1" },
      ["a.txt", "b.txt"].map((name) => ({ type: "send_file", description: "send", payload: { path: join(dir, name) } })));
    const payload = JSON.parse(db.get("SELECT payload_json FROM events WHERE type = 'advisor.responded' ORDER BY rowid DESC LIMIT 1").payload_json);
    return { turnId, messageId: payload.message_id };
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
  await waitFor(() => env.calls.length === 1, { message: "the follow-up Advisor turn ran" });
  assert.equal(env.db.all("SELECT 1 FROM events WHERE type = 'advisor.responded' AND json_extract(payload_json, '$.followup_of_turn_id') = ?", turnId).length, 1);
  assert.equal(env.calls.length, 1);
});

test("a delivery report where every file was sent queues no follow-up", async (t) => {
  const env = await setup(t);
  if (!env) return t.skip("listen not permitted");
  const { turnId, messageId } = await env.reply();
  const response = await env.report(turnId, messageId, [{ index: 0, outcome: "sent" }, { index: 1, outcome: "sent" }]);
  assert.deepEqual((await response.json()).data, { deduplicated: false, followup_pending: false, notice: null });
  assert.equal(env.calls.length, 0);
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
