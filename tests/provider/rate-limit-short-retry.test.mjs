import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgentRunner, toolNamesInLine } from "../../packages/agent-runtime/dist/index.js";
import { rateLimitRetrySettings } from "../../packages/shared/dist/index.js";

const TRANSIENT = "API Error: 429 Too Many Requests";
const USAGE_LIMIT = "You've hit your usage limit. Try again at 9:00 PM.";

const workerTask = (overrides = {}) => ({
  id: "task-1", work_id: "work-1", title: "Build it", status: "running", type: "code", state_version: 0,
  updated_at: "2026-09-24T00:00:00.000Z", parent_task_id: null, acceptance: "It works.", review_round: 0,
  failure_count: 0, worker_generation: 0, depends_on: [], ...overrides,
});
const workerRequest = (invocationId, task = workerTask()) => ({
  invocation_id: invocationId, work_id: "work-1", task_id: task.id, attempt: 1, context: { task, worktree: "/tmp/task-1" },
});

const failure = (request, stderr, extra = {}) => ({ adapter: request.adapter, stdout: "", stderr, exit_code: 1, signal: null, format: "provider-json", ...extra });
const success = (request, sessionId) => ({
  adapter: request.adapter,
  stdout: JSON.stringify({ type: "result", num_turns: 1, result: "not a report", usage: { input_tokens: 1, output_tokens: 1 } }),
  stderr: "", exit_code: 0, signal: null, format: "provider-json", ...(sessionId ? { provider_session_id: sessionId } : {}),
});

function runnerWith(execute, env = {}, adapter = "claude-cli/v1") {
  const runner = createAgentRunner({
    adapter,
    outputLogDir: null,
    env: { OWL_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS: "0", ...env },
    provider: { toolNamesInLine, execute },
  });
  runner.setOutputResubmitLimit(() => 0);
  return runner;
}

/** Stub that answers the first `failures` calls with a temporary rate limit, then succeeds. */
function flaky(failures, stderr = TRANSIENT) {
  const calls = [];
  const execute = async (request) => {
    calls.push(request);
    return calls.length <= failures ? failure(request, stderr) : success(request);
  };
  return { calls, execute };
}

test("a temporary rate limit is retried in the same invocation until the stub succeeds", async () => {
  const { calls, execute } = flaky(2);
  const result = await runnerWith(execute, { OWL_PROVIDER_RATE_LIMIT_RETRY_MAX: "2" }).runWorker(workerRequest("worker-1"));
  assert.equal(calls.length, 3);
  assert.deepEqual(new Set(calls.map((request) => request.invocation_id)), new Set(["worker-1"]));
  assert.notEqual(result.error_key, "provider_failed:rate_limit_transient", "the last run succeeded at the provider");
});

test("the n-th retry waits the base delay times n", async () => {
  const stamps = [];
  const execute = async (request) => (stamps.push(Date.now()), stamps.length <= 2 ? failure(request, TRANSIENT) : success(request));
  await runnerWith(execute, { OWL_PROVIDER_RATE_LIMIT_RETRY_MAX: "2", OWL_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS: "40" }).runWorker(workerRequest("worker-wait"));
  assert.ok(stamps[1] - stamps[0] >= 35, "first retry waits about 40 ms");
  assert.ok(stamps[2] - stamps[1] >= 75, "second retry waits about 80 ms");
});

test("a used-up budget returns a transient failure without rate_limit", async () => {
  const { calls, execute } = flaky(99);
  const result = await runnerWith(execute, { OWL_PROVIDER_RATE_LIMIT_RETRY_MAX: "2" }).runWorker(workerRequest("worker-1"));
  assert.equal(calls.length, 3);
  assert.equal(result.failure_class, "transient");
  assert.equal(result.error_key, "provider_failed:rate_limit_transient");
  assert.equal(result.rate_limit, undefined);
  assert.ok(!String(result.message).includes("利用上限"));
});

test("0 disables the retry and a role key overrides the common key", async () => {
  const off = flaky(99);
  await runnerWith(off.execute, { OWL_PROVIDER_RATE_LIMIT_RETRY_MAX: "0" }).runWorker(workerRequest("worker-1"));
  assert.equal(off.calls.length, 1);

  const role = flaky(99);
  await runnerWith(role.execute, { OWL_PROVIDER_RATE_LIMIT_RETRY_MAX: "5", OWL_PROVIDER_RATE_LIMIT_RETRY_MAX_WORKER: "1" }).runWorker(workerRequest("worker-1"));
  assert.equal(role.calls.length, 2);

  assert.deepEqual(rateLimitRetrySettings({}, "reviewer"), { maxRetries: 2, delayMs: 15000 });
  assert.deepEqual(
    rateLimitRetrySettings({ OWL_PROVIDER_RATE_LIMIT_RETRY_MAX: "3", OWL_PROVIDER_RATE_LIMIT_RETRY_MAX_REVIEWER: "4", OWL_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS: "7" }, "reviewer"),
    { maxRetries: 4, delayMs: 7 },
  );
});

test("an invalid setting fails with config_invalid before the provider runs", async () => {
  for (const env of [
    { OWL_PROVIDER_RATE_LIMIT_RETRY_MAX: "11" },
    { OWL_PROVIDER_RATE_LIMIT_RETRY_MAX: "-1" },
    { OWL_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS: "600001" },
    { OWL_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS: "soon" },
  ]) {
    const { calls, execute } = flaky(1);
    const result = await runnerWith(execute, env).runWorker(workerRequest("worker-1"));
    assert.equal(calls.length, 0, JSON.stringify(env));
    assert.match(String(result.error_key), /config_invalid/u, JSON.stringify(env));
  }
});

test("a usage limit is not retried", async () => {
  const { calls, execute } = flaky(99, USAGE_LIMIT);
  const result = await runnerWith(execute, { OWL_PROVIDER_RATE_LIMIT_RETRY_MAX: "2" }, "codex-cli/v1").runWorker(workerRequest("worker-1"));
  assert.equal(calls.length, 1);
  assert.equal(result.failure_class, "rate_limited");
});

test("a temporary rate limit after a side effect is not retried", async () => {
  const started = JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "curl -X POST https://example.com" } });
  const calls = [];
  const execute = async (request) => (calls.push(request), { adapter: request.adapter, stdout: `${started}\n`, stderr: TRANSIENT, exit_code: 1, signal: null, format: "provider-json" });
  const result = await runnerWith(execute, { OWL_PROVIDER_RATE_LIMIT_RETRY_MAX: "2" }, "codex-cli/v1").runWorker(workerRequest("worker-1"));
  assert.equal(calls.length, 1);
  assert.equal(result.error_key, "side_effect_failure:provider_failed:rate_limit_transient");
});

test("cancelAgent during the wait ends the invocation as cancelled", async () => {
  const { calls, execute } = flaky(99);
  const runner = runnerWith(execute, { OWL_PROVIDER_RATE_LIMIT_RETRY_MAX: "2", OWL_PROVIDER_RATE_LIMIT_RETRY_DELAY_MS: "60000" });
  const running = runner.runWorker(workerRequest("worker-cancel"));
  while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await runner.cancelAgent("worker-cancel");
  const result = await running;
  assert.equal(calls.length, 1);
  assert.match(String(result.error_key), /cancelled/u);
});

test("the retry budget is shared with the session manager's fresh retry", async () => {
  const calls = [];
  const execute = async (request) => {
    calls.push(request);
    if (calls.length === 1) return success(request, "session-1");
    return failure(request, TRANSIENT);
  };
  const runner = runnerWith(execute, { OWL_PROVIDER_RATE_LIMIT_RETRY_MAX: "1" });
  await runner.runWorker(workerRequest("worker-1"));
  const result = await runner.runWorker(workerRequest("worker-2", workerTask({ title: "Build it again" })));
  // call 2: resumed run, call 3: its one retry, call 4: the session manager's fresh run with no retry left.
  assert.equal(calls.length, 4);
  assert.equal(calls[1].provider_session_id, "session-1");
  assert.equal(calls[3].provider_session_id, undefined);
  assert.equal(result.error_key, "provider_failed:rate_limit_transient");
});

test("a background role such as the curator is not retried", async () => {
  const { calls, execute } = flaky(99);
  const runner = runnerWith(execute, { OWL_PROVIDER_RATE_LIMIT_RETRY_MAX: "2" });
  const result = await runner.runCurator({ proposals: [], skill_index: [], candidates: [], usages: [], with_judgement: false, invocation_id: "curator-1" });
  assert.equal(calls.length, 1);
  assert.equal(result.ok, false);
});
