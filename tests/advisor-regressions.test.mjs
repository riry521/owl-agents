import assert from "node:assert/strict";
import { test } from "node:test";

import { EMPTY_ADVISOR_REPLY_NOTICE, parseAdvisorTurnReply } from "../packages/core/dist/advisor-runtime.js";

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
