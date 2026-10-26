// executorProviderError reads the harness's own error from structured stdout; it only gets strings, so no provider runs.
import assert from "node:assert/strict";
import { test } from "node:test";

import { executorProviderError } from "../../packages/agent-runtime/dist/index.js";

const lines = (...events) => events.map((event) => JSON.stringify(event)).join("\n");

test("a Claude stream-json failure gives message and http_status with empty stderr, without assistant text", () => {
  const stdout = lines(
    { type: "assistant", message: { content: [{ type: "text", text: "SECRET ASSISTANT BODY" }] } },
    { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1790000000 } },
    { type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "API Error: 429 Too Many Requests" },
  );
  const record = executorProviderError("claude", stdout, "", 1, null);
  assert.equal(record.harness, "claude");
  assert.equal(record.message, "API Error: 429 Too Many Requests");
  assert.equal(record.message_source, "harness_error");
  assert.equal(record.http_status, 429);
  assert.ok(!JSON.stringify(record).includes("ASSISTANT BODY"));
});

test("a Codex JSONL turn.failed gives message and http_status, without agent_message text", () => {
  const stdout = lines(
    { type: "item.completed", item: { type: "agent_message", text: "SECRET AGENT BODY" } },
    { type: "turn.failed", error: { message: "exceeded retry limit, last status: 429 Too Many Requests", codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } } },
  );
  const record = executorProviderError("codex", stdout, "", 1, null);
  assert.equal(record.harness, "codex");
  assert.match(record.message, /exceeded retry limit/u);
  assert.equal(record.http_status, 429);
  assert.equal(record.code, "responseTooManyFailedAttempts");
  assert.ok(!JSON.stringify(record).includes("AGENT BODY"));
});

test("with no structured error the record falls back to the end of stderr", () => {
  const record = executorProviderError("codex", "not json", "first\nlast line", 3, null);
  assert.equal(record.message, "first\nlast line");
  assert.equal(record.message_source, "stderr");
  assert.equal(record.exit_code, 3);
});
