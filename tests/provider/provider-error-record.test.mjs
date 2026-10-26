// Raw provider error record: its content, masking and bound, and the runner's per-call observer.
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyProviderFailure, createAgentRunner, maskProviderText, providerErrorRecord, toolNamesInLine } from "../../packages/agent-runtime/dist/index.js";
import { PROVIDER_ERROR_RECORD_MAX_CHARS } from "../../packages/shared/dist/index.js";

// Dummy credentials are built at run time so no key-looking literal sits in the source.
const tail = (n) => "a1B2c3D4".repeat(n);
const verdict = { failure_class: "deterministic" };

test("maskProviderText hides auth headers, keys, tokens and the given secret values", () => {
  const secret = `custom-${tail(1)}`;
  const text = [
    `Authorization: Bearer ${tail(2)}`, `Basic ${tail(2)}`, `sk-${tail(2)}`, `xoxb-${tail(2)}`, `xapp-${tail(2)}`,
    `ghp_${tail(2)}`, `gho_${tail(2)}`, `github_pat_${tail(2)}`, `api key=${tail(1)}`, `access_token=${tail(1)}`, `secret=${tail(1)}`, `own ${secret}`,
  ].join("\n");
  const masked = maskProviderText(text, [secret]);
  assert.ok(!masked.includes(tail(1)), masked);
  assert.ok(!masked.includes("custom-"), masked);
  assert.match(masked, /\*\*\*/u);
});

test("maskProviderText hides short Bearer/Basic values, Authorization schemes and quoted values whole", () => {
  assert.equal(maskProviderText("Bearer abc"), "Bearer ***");
  assert.equal(maskProviderText("Authorization: Basic YTpi"), "Authorization: ***");
  assert.equal(maskProviderText('secret="two words" done'), "secret=*** done");
});

test("the record uses the harness error first, else the end of stderr, never stdout", () => {
  const now = new Date("2026-10-01T00:00:00.000Z");
  const fromHarness = providerErrorRecord("codex", { exit_code: 1, signal: null, kind: "harness_error", harness_code: "x", harness_status: 429, error: "boom", stdout: "assistant text", stderr: "noise" }, verdict, "k", [], now, 2);
  assert.deepEqual(fromHarness, {
    harness: "codex", message: "boom", message_source: "harness_error", code: "x", http_status: 429, failure_kind: "harness_error",
    exit_code: 1, signal: null, failure_class: "deterministic", error_key: "k", attempt: 2, recorded_at: now.toISOString(),
  });
  const fromStderr = providerErrorRecord("claude", { exit_code: 2, signal: null, kind: "exit", stdout: "assistant text", stderr: "last words" }, verdict, "k", [], now);
  assert.equal(fromStderr.message, "last words");
  assert.equal(fromStderr.message_source, "stderr");
  const empty = providerErrorRecord("claude", { exit_code: 2, signal: null, stdout: "assistant text", stderr: "" }, verdict, "k", [], now);
  assert.equal(empty.message, null);
  assert.equal(empty.message_source, null);
});

test("the message is masked then cut: harness errors from the start, stderr from the end", () => {
  const long = `${"word ".repeat(PROVIDER_ERROR_RECORD_MAX_CHARS)}END`;
  const harness = providerErrorRecord("codex", { exit_code: 1, signal: null, error: `START ${long}` }, verdict, "k");
  assert.equal(harness.message.length, PROVIDER_ERROR_RECORD_MAX_CHARS);
  assert.ok(harness.message.startsWith("START "));
  const stderr = providerErrorRecord("codex", { exit_code: 1, signal: null, stderr: `START ${long}` }, verdict, "k");
  assert.equal(stderr.message.length, PROVIDER_ERROR_RECORD_MAX_CHARS);
  assert.ok(stderr.message.endsWith("END"));
  const masked = providerErrorRecord("codex", { exit_code: 1, signal: null, error: `Bearer ${tail(3)}` }, verdict, "k");
  assert.ok(!masked.message.includes(tail(1)));
});

test("classifyProviderFailure returns the record with its error_key", () => {
  const classification = classifyProviderFailure("codex-cli/v1", { exit_code: 1, signal: null, kind: "exit", stderr: "exceeded retry limit, last status: 429 Too Many Requests" });
  assert.equal(classification.provider_error.harness, "codex");
  assert.equal(classification.provider_error.error_key, classification.error_key);
  assert.equal(classification.provider_error.failure_class, classification.failure_class);
});

const curatorInput = { invocation_id: "cur-1", knowledge_dir: "/tmp/owl-test-unused", reason: "test" };

test("the runner reports each failed provider call with invocation_id, role and attempt, curator included", async () => {
  const calls = [];
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    env: { OWL_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS: "0", OWL_PROVIDER_RATE_LIMIT_RETRY_MAX: "2" },
    provider: {
      toolNamesInLine,
      execute: async (request) => ({ adapter: request.adapter, stdout: "", stderr: "API Error: 429 Too Many Requests", exit_code: 1, signal: null, format: "provider-json" }),
    },
  });
  runner.setOutputResubmitLimit(() => 0);
  runner.setProviderErrorObserver((event) => calls.push(event));
  const task = { id: "t1", work_id: "w1", title: "T", status: "running", type: "code", state_version: 0, updated_at: "2026-09-24T00:00:00.000Z", parent_task_id: null, acceptance: "ok", review_round: 0, failure_count: 0, worker_generation: 0, depends_on: [] };
  await runner.runWorker({ invocation_id: "inv-1", work_id: "w1", task_id: "t1", attempt: 1, context: { task, worktree: "/tmp/owl-test-unused" } }).catch(() => undefined);
  const worker = calls.filter((call) => call.invocation_id === "inv-1");
  assert.deepEqual(worker.map((call) => call.record.attempt), [1, 2, 3]);
  assert.ok(worker.every((call) => call.role === "worker" && call.record.harness === "claude" && call.record.message?.includes("429")));

  await runner.runCurator(curatorInput).catch(() => undefined);
  const curator = calls.filter((call) => call.invocation_id === "cur-1");
  assert.ok(curator.length >= 1);
  assert.ok(curator.every((call) => call.role === "curator"));
});
