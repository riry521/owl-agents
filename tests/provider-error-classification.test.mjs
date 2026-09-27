// Provider failure classification: structured signals decide first, and the
// pattern fallback reads only the end of stderr and the error message.
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyProviderFailure, providerFailureCause } from "../packages/agent-runtime/dist/index.js";
import { providerFailed } from "../packages/agent-runtime/dist/errors.js";
import { harnessFailureDetail, unwrapClaudeCliResult } from "../packages/agent-runtime/dist/protocol.js";

function exited(fields) {
  return { exit_code: 1, signal: null, kind: "exit", ...fields };
}

function thrown(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail("expected a throw");
}

test("words in the model's stdout do not make a failure transient", () => {
  const failure = classifyProviderFailure("codex-cli/v1", exited({ stdout: "retrying after ECONNRESET on the socket", stderr: "" }));
  assert.equal(failure.failure_class, "deterministic");
  assert.equal(failure.retry_allowed, false);
  assert.equal(failure.error_key, "provider_failed:exit:1");
});

test("words in the model's stdout do not block a retry", () => {
  const stderr = "429 Too Many Requests";
  const plain = classifyProviderFailure("claude-cli/v1", exited({ stdout: "done", stderr }));
  const noisy = classifyProviderFailure("claude-cli/v1", exited({ stdout: "could not parse the config; malformed input", stderr }));
  assert.deepEqual(
    { failure_class: noisy.failure_class, retry_allowed: noisy.retry_allowed },
    { failure_class: plain.failure_class, retry_allowed: plain.retry_allowed },
  );
  assert.equal(noisy.failure_class, "rate_limited");
  assert.equal(noisy.retry_allowed, true);
});

test("the harness HTTP status decides before any text", () => {
  const limited = classifyProviderFailure("claude-cli/v1", exited({ harness_status: 429, stderr: "unauthorized" }));
  assert.equal(limited.failure_class, "rate_limited");
  assert.equal(limited.retry_allowed, true);
  const unauthorized = classifyProviderFailure("claude-cli/v1", exited({ harness_status: 401, stderr: "connection reset" }));
  assert.equal(unauthorized.failure_class, "deterministic");
  assert.equal(unauthorized.retry_allowed, false);
  assert.match(unauthorized.message, /認証に失敗しました（HTTP 401）/u);
  const overloaded = classifyProviderFailure("claude-cli/v1", exited({ harness_status: 529 }));
  assert.equal(overloaded.failure_class, "transient");
  const badRequest = classifyProviderFailure("claude-cli/v1", exited({ harness_status: 400, stderr: "socket hang up" }));
  assert.equal(badRequest.failure_class, "deterministic");
});

test("a timeout is transient whatever the output says, and the key names its kind", () => {
  const idle = classifyProviderFailure("codex-cli/v1", {
    exit_code: null,
    signal: "SIGTERM",
    kind: "timeout",
    timeout_kind: "idle",
    stdout: "invalid api key",
    stderr: "unauthorized\nprovider_timeout",
  });
  assert.equal(idle.failure_class, "transient");
  assert.equal(idle.retry_allowed, true);
  assert.equal(idle.error_key, "provider_failed:timeout:idle");
  assert.match(idle.message, /進捗を出さなかったため停止しました/u);
  const wall = classifyProviderFailure("codex-cli/v1", { exit_code: null, signal: "SIGTERM", kind: "timeout", timeout_kind: "wall" }, "en");
  assert.equal(wall.error_key, "provider_failed:timeout:wall");
  assert.match(wall.message, /timed out/u);
});

test("a cancelled run is never retried", () => {
  const error = providerFailed("provider_cancelled", { exit_code: null, signal: "SIGTERM", stdout: "", stderr: "network unreachable" });
  const failure = classifyProviderFailure("claude-cli/v1", providerFailureCause(error));
  assert.equal(failure.failure_class, "deterministic");
  assert.equal(failure.retry_allowed, false);
  assert.equal(failure.error_key, "provider_failed:cancelled");
});

test("a harness that cannot be started is a configuration failure", () => {
  const cause = Object.assign(new Error("spawn /opt/missing/claude ENOENT"), { code: "ENOENT" });
  const failure = classifyProviderFailure("claude-cli/v1", providerFailureCause(providerFailed("child_process_error", cause)));
  assert.equal(failure.failure_class, "deterministic");
  assert.equal(failure.retry_allowed, false);
  assert.equal(failure.error_key, "provider_failed:spawn_error");
  assert.match(failure.message, /実行設定が不正です/u);
});

test("an unexpected signal is deterministic even when stderr mentions a timeout", () => {
  const failure = classifyProviderFailure("codex-cli/v1", { exit_code: null, signal: "SIGSEGV", kind: "exit", stderr: "request timed out" });
  assert.equal(failure.failure_class, "deterministic");
  assert.equal(failure.error_key, "provider_failed:signal:SIGSEGV");
});

test("only the end of stderr is searched", () => {
  const stderr = `network is down\n${"x".repeat(5_000)}`;
  const failure = classifyProviderFailure("codex-cli/v1", exited({ stderr }));
  assert.equal(failure.failure_class, "deterministic");
});

test("a Claude error result with an overloaded status is transient", () => {
  const stdout = JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 529, result: "API Error: Overloaded" });
  const cause = providerFailureCause(thrown(() => unwrapClaudeCliResult(stdout)));
  assert.equal(cause.kind, "harness_error");
  assert.equal(cause.harness_status, 529);
  const failure = classifyProviderFailure("claude-cli/v1", cause);
  assert.equal(failure.failure_class, "transient");
  assert.equal(failure.retry_allowed, true);
  assert.equal(failure.error_key, "provider_failed:harness_error:529");
});

test("a non-zero exit reads the failure the harness reported in its structured output", () => {
  const claude = harnessFailureDetail("claude-cli/v1", JSON.stringify({ type: "result", is_error: true, api_error_status: 401, result: "Invalid API key" }));
  assert.deepEqual(claude, { harness_status: 401, error: "Invalid API key" });
  const codex = harnessFailureDetail("codex-cli/v1", [
    JSON.stringify({ type: "thread.started", thread_id: "t" }),
    JSON.stringify({ type: "error", message: "Reconnecting... 1/5" }),
    JSON.stringify({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } }),
  ].join("\n"));
  assert.deepEqual(codex, { error: "unexpected status 401 Unauthorized" });
  assert.equal(harnessFailureDetail("claude-cli/v1", "not json"), null);
  assert.equal(harnessFailureDetail("codex-cli/v1", JSON.stringify({ type: "thread.started" })), null);

  const failure = classifyProviderFailure("codex-cli/v1", exited({ ...codex, stdout: "", stderr: "" }));
  assert.equal(failure.failure_class, "deterministic");
  assert.equal(failure.retry_allowed, false);
  assert.match(failure.message, /認証に失敗しました（HTTP 401）/u);
});
