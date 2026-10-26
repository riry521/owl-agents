import assert from "node:assert/strict";
import { test } from "node:test";

import * as runtime from "../../packages/agent-runtime/dist/index.js";
import { harnessFailureDetail, unwrapCodexCliResult } from "../../packages/agent-runtime/dist/protocol.js";

const now = new Date("2026-09-27T00:00:00.000Z");

test("Codex turn.failed attaches rate-limit evidence and preserves its reset time", () => {
  const stdout = JSON.stringify({
    type: "turn.failed",
    error: {
      message: "You've hit your usage limit.",
      codexErrorInfo: { kind: "usageLimitExceeded" },
      rate_limits: {
        primary: { used_percent: 100, resets_at: "2026-09-28T15:05:00.000Z" },
      },
    },
  });
  let thrown;

  assert.throws(() => unwrapCodexCliResult(stdout), (error) => {
    thrown = error;
    return error.code === "provider_failed" && error.reason === "provider_reported_error";
  });

  const cause = runtime.providerFailureCause(thrown);
  assert.ok(cause);
  assert.equal(cause.rate_limit_evidence?.length, 1);
  assert.equal(cause.rate_limit_evidence?.[0]?.kind, "event");

  const failure = runtime.classifyProviderFailure("codex-cli/v1", cause, "en", now);
  assert.equal(failure.failure_class, "rate_limited");
  assert.deepEqual(failure.rate_limit, { resets_at: "2026-09-28T15:05:00.000Z", source: "event" });
});

const failedTurn = (error, extra = {}) => JSON.stringify({ type: "turn.failed", error, ...extra });
const classifyFailedTurn = (stdout) => {
  let thrown;
  assert.throws(() => unwrapCodexCliResult(stdout), (error) => {
    thrown = error;
    return error.code === "provider_failed";
  });
  return runtime.classifyProviderFailure("codex-cli/v1", runtime.providerFailureCause(thrown), "en", now);
};

test("Codex turn.failed with a usage-limit code in any spelling is rate_limited", () => {
  for (const error of [
    { message: "limit", codexErrorInfo: "usageLimitExceeded" },
    { message: "limit", codexErrorInfo: { usageLimitExceeded: {} } },
    { message: "limit", codex_error_info: "usage_limit_exceeded" },
  ]) {
    const failure = classifyFailedTurn(failedTurn(error));
    assert.equal(failure.failure_class, "rate_limited", JSON.stringify(error));
    assert.notEqual(failure.rate_limit, undefined);
  }
});

test("a Retry-After quoted in the model's own message is not a reset time", () => {
  const message = { type: "item.completed", item: { type: "agent_message", text: "Retry-After: 30" } };
  const failure = classifyFailedTurn(`${JSON.stringify(message)}\n${failedTurn({ message: "exceeded retry limit, last status: 429 Too Many Requests" })}`);
  assert.equal(failure.failure_class, "transient");
  assert.equal(failure.error_key, "provider_failed:rate_limit_transient");
});

test("a saturated rate_limits snapshot inside turn.failed.error is a reported reset", () => {
  const failure = classifyFailedTurn(failedTurn({
    message: "429 Too Many Requests",
    rate_limits: { primary: { used_percent: 100, resets_at: 1790000000 } },
  }));
  assert.equal(failure.failure_class, "rate_limited");
  assert.notEqual(failure.rate_limit, undefined);
});

test("a non-zero exit keeps the structured 429 status from codexErrorInfo", () => {
  const detail = harnessFailureDetail("codex-cli/v1", failedTurn({
    message: "slow down",
    codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
  }));
  assert.equal(detail.harness_status, 429);
  assert.equal(detail.harness_code, "responseTooManyFailedAttempts");
});
