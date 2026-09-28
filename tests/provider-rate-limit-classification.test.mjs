import assert from "node:assert/strict";
import { test } from "node:test";

import * as runtime from "../packages/agent-runtime/dist/index.js";

const now = new Date("2026-09-27T00:00:00.000Z");
const failed = (fields = {}) => ({ exit_code: 1, signal: null, kind: "exit", ...fields });

test("Claude rejected rate_limit_event is classified and returns its reset time", () => {
  const event = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "rejected",
      resetsAt: Date.parse("2026-09-28T04:00:00.000Z") / 1000,
      rateLimitType: "five_hour",
    },
  };
  const failure = runtime.classifyProviderFailure("claude-cli/v1", failed({
    rate_limit_evidence: [{ kind: "event", event }],
  }), "en", now);

  assert.equal(failure.failure_class, "rate_limited");
  assert.equal(failure.error_key, "provider_failed:rate_limited");
  assert.equal(failure.retry_allowed, true);
  assert.deepEqual(failure.rate_limit, { resets_at: "2026-09-28T04:00:00.000Z", source: "event" });
});

test("Claude unifiedWindows is used only when the event has no direct reset", () => {
  const reset = runtime.resolveRateLimitReset([{
    kind: "event",
    event: {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        unifiedWindows: {
          five_hour: { resetsAt: Date.parse("2026-09-27T03:00:00.000Z") / 1000 },
          seven_day: { resetsAt: Date.parse("2026-10-01T03:00:00.000Z") / 1000 },
        },
      },
    },
  }], now, { harness: "claude" });
  assert.deepEqual(reset, { resets_at: "2026-10-01T03:00:00.000Z", source: "event" });

  const allowed = runtime.resolveRateLimitReset([{
    kind: "event",
    event: { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1_790_582_400 } },
  }], now, { harness: "claude" });
  assert.deepEqual(allowed, { resets_at: null, source: null });

  const text = runtime.resolveRateLimitReset([{ kind: "text", text: "5-hour limit reached · resets 3pm (Asia/Tokyo)" }], now, { harness: "claude" });
  assert.deepEqual(text, { resets_at: "2026-09-27T06:00:00.000Z", source: "text" });
});

test("Claude result wrapper status and usage-limit epoch provide a reset", () => {
  const wrapper = {
    type: "result",
    is_error: true,
    api_error_status: 429,
    result: "Claude AI usage limit reached|1790496000",
  };
  const failure = runtime.classifyProviderFailure("claude-cli/v1", failed({
    harness_status: wrapper.api_error_status,
    error: wrapper.result,
    rate_limit_evidence: runtime.claudeRateLimitEvidence(wrapper),
  }), "en", now);

  assert.equal(failure.failure_class, "rate_limited");
  assert.equal(failure.rate_limit.resets_at, new Date(1_790_496_000_000).toISOString());
  assert.equal(failure.rate_limit.source, "text");
});

test("Codex usage-limit error and local try-again time are parsed", () => {
  const error = {
    message: "You've hit your usage limit. Try again at Sep 28, 2026 3:05 PM",
    codexErrorInfo: { kind: "usageLimitExceeded" },
  };
  const evidence = runtime.codexRateLimitEvidence(JSON.stringify({ type: "turn.failed", error }));
  const failure = runtime.classifyProviderFailure("codex-cli/v1", failed({
    error: error.message,
    rate_limit_evidence: evidence,
  }), "en", now);
  const localReset = runtime.resolveRateLimitReset([{ kind: "text", text: error.message }], now, { harness: "codex" });
  const losAngelesReset = runtime.resolveRateLimitReset([{ kind: "text", text: error.message }], now, {
    harness: "codex",
    timeZone: "America/Los_Angeles",
  });

  assert.equal(failure.failure_class, "rate_limited");
  assert.deepEqual(failure.rate_limit, localReset);
  assert.deepEqual(losAngelesReset, { resets_at: "2026-09-28T22:05:00.000Z", source: "text" });
});

test("a clock time that just passed is the reset still under way, not tomorrow's", () => {
  const tokyo = { timeZone: "Asia/Tokyo" };
  // 21:02:33 in Tokyo: the provider still reports the 21:02 reset a few seconds after it.
  const justAfter = new Date("2026-09-28T12:02:33.000Z");
  const retrySoon = { resets_at: "2026-09-28T12:03:33.000Z", source: "text" };
  assert.deepEqual(
    runtime.resolveRateLimitReset([{ kind: "text", text: "You've hit your usage limit. Try again at 9:02 PM." }], justAfter, { ...tokyo, harness: "codex" }),
    retrySoon,
  );
  assert.deepEqual(
    runtime.resolveRateLimitReset([{ kind: "text", text: "5-hour limit reached · resets 9:02pm (Asia/Tokyo)" }], justAfter, { harness: "claude" }),
    retrySoon,
  );

  // 23:00 in Tokyo: 1:00 AM is tomorrow.
  assert.deepEqual(
    runtime.resolveRateLimitReset([{ kind: "text", text: "You've hit your usage limit. Try again at 1:00 AM." }], new Date("2026-09-28T14:00:00.000Z"), { ...tokyo, harness: "codex" }),
    { resets_at: "2026-09-28T16:00:00.000Z", source: "text" },
  );
});

test("Codex rate-limit snapshots and retry-after values resolve to UTC ISO strings", () => {
  const snapshot = {
    rate_limits: {
      primary: { used_percent: 100, resets_at: 1_790_496_000 },
      secondary: { used_percent: 10, resets_in_seconds: 86_400 },
    },
  };
  const eventReset = runtime.resolveRateLimitReset([{ kind: "event", event: snapshot }], now, { harness: "codex" });
  assert.deepEqual(eventReset, { resets_at: new Date(1_790_496_000_000).toISOString(), source: "event" });

  const seconds = runtime.resolveRateLimitReset([{ kind: "retry_after", value: "120" }], now);
  assert.deepEqual(seconds, { resets_at: "2026-09-27T00:02:00.000Z", source: "retry_after" });

  const httpDate = runtime.resolveRateLimitReset([{ kind: "retry_after", value: "Mon, 28 Sep 2026 06:00:00 GMT" }], now);
  assert.deepEqual(httpDate, { resets_at: "2026-09-28T06:00:00.000Z", source: "retry_after" });

  const relative = runtime.resolveRateLimitReset([{ kind: "text", text: "You've hit your usage limit. Try again in 45m" }], now, { harness: "codex" });
  assert.deepEqual(relative, { resets_at: "2026-09-27T00:45:00.000Z", source: "text" });

  const retryFailure = runtime.classifyProviderFailure("codex-cli/v1", {
    exit_code: 1,
    signal: null,
    kind: "harness_error",
    harness_status: 429,
    error: "You've hit your usage limit.\nRetry-After: 120",
  }, "en", now);
  assert.deepEqual(retryFailure.rate_limit, { resets_at: "2026-09-27T00:02:00.000Z", source: "retry_after" });
});

test("a usage-limit failure without a readable reset carries null", () => {
  const failure = runtime.classifyProviderFailure("codex-cli/v1", failed({ stderr: "You've hit your usage limit" }), "en", now);
  assert.equal(failure.failure_class, "rate_limited");
  assert.deepEqual(failure.rate_limit, { resets_at: null, source: null });
});

test("billing quota exhaustion is not classified as a resettable limit", () => {
  const failure = runtime.classifyProviderFailure("codex-cli/v1", failed({
    harness_status: 429,
    harness_code: "insufficient_quota",
  }), "en", now);
  assert.equal(failure.failure_class, "deterministic");
  assert.equal(failure.rate_limit, undefined);
});

test("overloaded responses, HTTP 529 and network failures remain transient", () => {
  for (const cause of [
    failed({ stderr: "Overloaded (rate limit)" }),
    failed({ harness_status: 529, harness_code: "serverOverloaded" }),
    failed({ stderr: "ECONNRESET: connection reset" }),
  ]) {
    const failure = runtime.classifyProviderFailure("claude-cli/v1", cause, "en", now);
    assert.equal(failure.failure_class, "transient");
    assert.equal(failure.retry_allowed, true);
    assert.equal(failure.rate_limit, undefined);
  }
});

test("a 100% rate-limit snapshot does not override a final network error", () => {
  const failure = runtime.classifyProviderFailure("codex-cli/v1", failed({
    stderr: "ECONNRESET: connection reset",
    rate_limit_evidence: [{
      kind: "event",
      event: { rate_limits: { primary: { used_percent: 100 } } },
    }],
  }), "en", now);

  assert.equal(failure.failure_class, "transient");
  assert.equal(failure.retry_allowed, true);
  assert.equal(failure.rate_limit, undefined);
});
