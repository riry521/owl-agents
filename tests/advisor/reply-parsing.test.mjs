import assert from "node:assert/strict";
import { test } from "node:test";

import { EMPTY_ADVISOR_REPLY_NOTICE, parseAdvisorTurnReply } from "../../packages/core/dist/advisor-runtime.js";
import { parseAdvisorCallApiPayload } from "../../packages/shared/dist/index.js";

test("a non-Slack Advisor reply that the strict parser rejects is kept instead of failing the turn", () => {
  for (const channel of ["web", "terminal", "discord"]) {
    // Starts with "{" but is not the legacy envelope.
    const braces = "{curly} braces start this plain answer.";
    assert.deepEqual(parseAdvisorTurnReply(channel, braces), { reply: braces, suggested_actions: [] });

    // Legacy envelope with an invalid suggested_actions list keeps the reply.
    const envelope = JSON.stringify({ reply: "Done.", suggested_actions: "not-an-array" });
    const parsedEnvelope = parseAdvisorTurnReply(channel, envelope);
    assert.equal(parsedEnvelope.reply.includes("Done."), true);
    assert.deepEqual(parsedEnvelope.suggested_actions, []);
  }
});

test("a well-formed non-Slack reply still yields its owl-actions", () => {
  const raw = "Creating it now.\n```owl-actions\n[{\"type\":\"create_work\",\"description\":\"Archive\"}]\n```\n";
  const parsed = parseAdvisorTurnReply("web", raw);
  assert.equal(parsed.reply, "Creating it now.");
  assert.deepEqual(parsed.suggested_actions, [{ type: "create_work", description: "Archive" }]);
});

test("an empty Advisor reply is surfaced as a visible notice on every channel", () => {
  for (const channel of ["web", "slack", "terminal"]) {
    assert.deepEqual(parseAdvisorTurnReply(channel, "   \n"), { reply: EMPTY_ADVISOR_REPLY_NOTICE, suggested_actions: [] });
  }
  // A reply that is only a malformed action block has nothing to show either.
  const onlyBrokenBlock = "```owl-actions\nnot json\n```\n";
  assert.equal(parseAdvisorTurnReply("web", onlyBrokenBlock).reply, EMPTY_ADVISOR_REPLY_NOTICE);
});

test("parseAdvisorCallApiPayload accepts a blocked API and rejects everything else with a reason", () => {
  const ok = { method: "PUT", path: "/api/v1/settings/models", body: { expected_version: 0, payload: {} }, reason: " cleanup " };
  const parsed = parseAdvisorCallApiPayload(ok);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.reason, "cleanup");
  assert.equal(parsed.value.path, "/api/v1/settings/models");
  assert.equal(parseAdvisorCallApiPayload({ method: "DELETE", path: "/api/v1/backlog/01J9" , reason: "x" }).ok, true);

  const rejected = (payload) => {
    const result = parseAdvisorCallApiPayload(payload);
    assert.equal(result.ok, false);
    assert.ok(result.reason.length > 0);
    return result.reason;
  };
  for (const path of [
    "http://127.0.0.1:1/api/v1/settings/models",
    "//evil.example/api/v1/settings/models",
    "/api/v1/settings/../settings/models",
    "/api/v1/settings/models?x=1",
  ]) rejected({ ...ok, path });
  rejected({ ...ok, method: "GET" });
  rejected({ ...ok, method: "POST", path: "/api/v1/works/01J9/start" });
  assert.match(rejected({ method: "POST", path: "/api/v1/works/01J9/cancel", reason: "x" }), /cancel_work/u);
  assert.match(rejected({ method: "POST", path: "/api/v1/advisor/actions", reason: "x" }), /update_work/u);
  rejected({ ...ok, extra: 1 });
  rejected({ method: ok.method, path: ok.path, body: ok.body });
  rejected({ ...ok, body: [] });
  rejected(null);
});
