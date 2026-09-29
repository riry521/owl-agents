import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeStreamReader } from "../packages/shared/dist/index.js";
import { harnessFailureDetail } from "../packages/agent-runtime/dist/protocol.js";

test("Claude stream returns the final result and session id without retaining tool output", () => {
  const seen = [];
  const reader = new ClaudeStreamReader(() => seen.push(true));
  reader.push(JSON.stringify({ type: "system", subtype: "init" }) + "\n");
  reader.push(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(5 * 1024 * 1024) }] } }) + "\n");
  const result = { type: "result", result: "done", session_id: "session-1", structured_output: { ok: true } };
  reader.push(JSON.stringify(result).slice(0, 20));
  reader.push(JSON.stringify(result).slice(20) + "\n");
  assert.deepEqual(JSON.parse(reader.output()), result);
  assert.ok(reader.retainedBytes() <= 65 * 1024);
  assert.equal(seen.length, 3);
});

test("Claude stream retains a bounded diagnostic tail without a result", () => {
  const reader = new ClaudeStreamReader(() => {});
  reader.push("noise\n" + JSON.stringify({ type: "user", content: "x".repeat(100000) }) + "\n");
  assert.ok(reader.output().length <= 65536);
  assert.equal(reader.output().includes("noise"), false);
});

test("Claude stream signals progress for events but not retry-only events", () => {
  let count = 0;
  const reader = new ClaudeStreamReader(() => { count += 1; });
  const event = (value) => reader.push(JSON.stringify(value) + "\n");
  event({ type: "rate_limit_event" });
  event({ type: "system", subtype: "api_retry" });
  event({ type: "error" });
  assert.equal(count, 0);
  event({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
  event({ type: "system", subtype: "thinking_tokens" });
  assert.equal(count, 2);
});

test("Claude stream decodes UTF-8 split across Buffer chunks", () => {
  const reader = new ClaudeStreamReader(() => {});
  const bytes = Buffer.from(JSON.stringify({ type: "result", result: "日本語" }) + "\n");
  const split = bytes.indexOf(Buffer.from("日")) + 1;
  reader.push(bytes.subarray(0, split));
  reader.push(bytes.subarray(split));
  assert.equal(JSON.parse(reader.output()).result, "日本語");
});

test("Claude stream keeps an error wrapper line as the final object", () => {
  const reader = new ClaudeStreamReader(() => {});
  reader.push(JSON.stringify({ type: "system", subtype: "init" }) + "\n");
  reader.push(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) + "\n");
  assert.deepEqual(harnessFailureDetail("claude-cli/v1", reader.output()), { harness_code: "overloaded_error", error: "Overloaded" });
});

test("Claude stream bounds an oversized newline-free line and keeps the next result", () => {
  const reader = new ClaudeStreamReader(() => {});
  const block = "x".repeat(1024 * 1024);
  for (let i = 0; i < 20; i += 1) reader.push(block);
  assert.ok(reader.retainedBytes() <= 65 * 1024);
  const result = { type: "result", result: "done" };
  reader.push("tail\n" + JSON.stringify(result) + "\n");
  assert.deepEqual(JSON.parse(reader.output()), result);
});

test("Claude stream tail never starts mid UTF-8 character", () => {
  const reader = new ClaudeStreamReader(() => {});
  reader.push("あ".repeat(30000) + "\n");
  const out = reader.output();
  assert.equal(out.includes("�"), false);
  assert.ok(out.startsWith("あ"));
});
