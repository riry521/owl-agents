import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeStreamReader, RequestUsageTracker, promptTokensOf } from "../../packages/shared/dist/index.js";
import { harnessFailureDetail } from "../../packages/agent-runtime/dist/protocol.js";

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

const usageLine = (id, usage, extra = {}) => ({ type: "assistant", message: { id, model: "claude-haiku-5-5", usage, content: [{ type: "text", text: "step" }] }, ...extra });

test("Claude stream hands assistant lines to the request tracker, one request per message id with the prompt-side sum", () => {
  const requests = [];
  const flushed = [];
  const tracker = new RequestUsageTracker({ onRequest: (u) => requests.push(u), onFlush: (u) => flushed.push(u) }, "fallback-model");
  const reader = new ClaudeStreamReader(() => {}, { onAssistant: (event) => tracker.accept(event) });
  const push = (value) => reader.push(JSON.stringify(value) + "\n");
  push(usageLine("msg_1", { input_tokens: 10, cache_read_input_tokens: 70000, cache_creation_input_tokens: 2000, output_tokens: 1 }));
  push(usageLine("msg_1", { input_tokens: 10, cache_read_input_tokens: 70000, cache_creation_input_tokens: 2000, output_tokens: 40 }));
  push(usageLine("msg_sub", { input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 2 }, { parent_tool_use_id: "toolu_1" }));
  push({ type: "assistant", message: { id: "msg_2", usage: { input_tokens: 3 }, content: [] } });
  push({ type: "result", result: "done", usage: { input_tokens: 999999, cache_read_input_tokens: 999999 } });
  reader.output();
  tracker.flush();
  assert.deepEqual(requests.map((u) => [u.message_id, u.prompt_tokens, u.subagent]), [["msg_1", 72010, false], ["msg_sub", 105, true], ["msg_2", 3, false]]);
  assert.equal(flushed.length, 3);
  assert.equal(flushed[0].output_tokens, 40, "the id's last line is the recorded usage");
  assert.equal(flushed[2].model, "fallback-model");
  assert.ok(flushed.every((u) => u.prompt_tokens < 999999), "the cumulative result usage is never counted");
});

test("Request tracker uses a transcript line's timestamp and ignores a message id once it was flushed", () => {
  const flushed = [];
  const tracker = new RequestUsageTracker({ onFlush: (u) => flushed.push(u) });
  tracker.accept({ ...usageLine("msg_a", { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 }), timestamp: "2026-10-01T00:00:00.000Z" });
  tracker.accept(usageLine("msg_b", { input_tokens: 1 }));
  tracker.accept(usageLine("msg_a", { input_tokens: 1, output_tokens: 99 }));
  tracker.flush();
  assert.deepEqual(flushed.map((u) => u.message_id), ["msg_a", "msg_b"]);
  assert.equal(flushed[0].created_at, "2026-10-01T00:00:00.000Z");
  assert.equal(flushed[0].prompt_tokens, 6);
  assert.equal(promptTokensOf({ input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 50 }), 6);
});
