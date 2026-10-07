import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAdvisorTurnReply } from "../../packages/core/dist/advisor-runtime.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";

const SECRET = "sk-test_SECRETVALUE123";
const VISIBLE = "Work を作成します。";
const NOTICE = /実行できませんでした/gu;
// A raw newline inside a JSON string makes the fence invalid JSON.
const malformedReply = `${VISIBLE}\n\`\`\`owl-actions\n[{"type":"create_work","description":"Create\nbroken ${SECRET}","payload":{"title":"Malformed Work","summary":"x","size":"small","project_id":null}}]\n\`\`\``;
const validReply = `${VISIBLE}\n\`\`\`owl-actions\n${JSON.stringify([{ type: "create_work", description: "Create ok", payload: { title: "Valid Work", summary: "x", size: "small", project_id: null } }])}\n\`\`\``;

async function setup(t) {
  const agentRunner = {
    runManagerPlan: async () => { throw new Error("unexpected"); },
    runWorker: async () => ({ outcome: "failed", failure_class: "deterministic", error_key: "t", retry_allowed: false, message: "stop" }),
    runReviewer: async () => { throw new Error("unexpected"); },
    runAdvisor: async () => { throw new Error("unexpected"); },
  };
  const { db, core } = await createTestCore(t, { agentRunner, version: "t" }, { prefix: "owl-advisor-malformed-" });
  const { conversation_id: conversationId } = await core.getActiveConversation();
  return { core, db, conversationId };
}

function captureWarnings(t) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => { lines.push(args.map(String).join(" ")); };
  t.after(() => { console.warn = original; });
  return lines;
}

test("malformed owl-actions notifies the Owner, creates no Work, and logs position without the full response", async (t) => {
  const { core, db, conversationId } = await setup(t);
  const logs = captureWarnings(t);

  // Runtime path: parse once and pass the flag; Core's fallback then sees stripped text.
  const parsed = parseAdvisorTurnReply("slack", malformedReply, "ja");
  assert.equal(parsed.malformed, true);
  const id = await core.persistAdvisorReply(conversationId, parsed.reply, createUlid(), { channel: "slack" }, parsed.suggested_actions, parsed.malformed);
  const body = db.get("SELECT body FROM messages WHERE id = ?", id).body;
  assert.ok(body.startsWith(VISIBLE));
  assert.equal(body.match(NOTICE).length, 1);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM works WHERE title = ?", "Malformed Work").count, 0);

  // Fallback path parses the raw reply again and the flag is also set: still one notice.
  const id2 = await core.persistAdvisorReply(conversationId, malformedReply, createUlid(), { channel: "slack" }, [], true);
  assert.equal(db.get("SELECT body FROM messages WHERE id = ?", id2).body.match(NOTICE).length, 1);

  const log = logs.join("\n");
  assert.match(log, /invalid_fence_json/u);
  assert.match(log, /position=\d+/u);
  assert.doesNotMatch(log, /SECRETVALUE123/u);
  assert.doesNotMatch(log, /"project_id":null\}\}\]/u, "the full response must not be logged");
});

test("valid create_work and replies without owl-actions get no notice", async (t) => {
  const { core, db, conversationId } = await setup(t);
  const logs = captureWarnings(t);
  const parsed = parseAdvisorTurnReply("slack", validReply, "ja");
  assert.equal(parsed.malformed, undefined);
  const id = await core.persistAdvisorReply(conversationId, parsed.reply, createUlid(), { channel: "slack" }, parsed.suggested_actions);
  assert.doesNotMatch(db.get("SELECT body FROM messages WHERE id = ?", id).body, NOTICE);
  const plain = await core.persistAdvisorReply(conversationId, "ただの返信", createUlid(), { channel: "slack" }, []);
  assert.equal(db.get("SELECT body FROM messages WHERE id = ?", plain).body, "ただの返信");
  assert.equal(logs.filter((line) => /malformed/u.test(line)).length, 0);
});

test("a valid fence runs and a malformed fence in the same Slack reply adds a notice that does not claim nothing changed", async (t) => {
  const { core, db, conversationId } = await setup(t);
  captureWarnings(t);
  const mixed = `${validReply}\n${malformedReply}`;
  const parsed = parseAdvisorTurnReply("slack", mixed, "ja");
  assert.equal(parsed.malformed, true);
  assert.equal(parsed.suggested_actions.length, 1);
  const id = await core.persistAdvisorReply(conversationId, parsed.reply, createUlid(), { channel: "slack" }, parsed.suggested_actions, parsed.malformed);
  const body = db.get("SELECT body FROM messages WHERE id = ?", id).body;
  assert.equal(body.match(NOTICE).length, 1);
  assert.doesNotMatch(body, /何も変更していません|Nothing was changed/u);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM works WHERE title = ?", "Valid Work").count, 1);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM works WHERE title = ?", "Malformed Work").count, 0);
});
