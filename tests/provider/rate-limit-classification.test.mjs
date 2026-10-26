import assert from "node:assert/strict";
import { test } from "node:test";

import * as runtime from "../../packages/agent-runtime/dist/index.js";

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
  assert.deepEqual(text, { resets_at: "2026-09-27T06:01:00.000Z", source: "text" });
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

test("Claude CLI 'You've hit your … limit' messages are rate limits with their reset", () => {
  // 20:40 in Tokyo, read from a server in another zone.
  const tokyoEvening = new Date("2026-09-28T11:40:00.000Z");
  const classify = (fields) => runtime.classifyProviderFailure("claude-cli/v1", failed(fields), "en", tokyoEvening);
  const cases = [
    [{ harness_status: 429, error: "You've hit your session limit · resets 9pm (Asia/Tokyo)" }, "2026-09-28T12:01:00.000Z"],
    [{ harness_status: 429, error: "You've hit your session limit · resets 9:30pm (Asia/Tokyo) · progress saved" }, "2026-09-28T12:31:00.000Z"],
    [{ harness_status: 429, error: "You've hit your weekly limit · resets Oct 3, 9am (Asia/Tokyo)" }, "2026-10-03T00:01:00.000Z"],
    [{ error: "You've hit your limit · resets 9pm (Asia/Tokyo)" }, "2026-09-28T12:01:00.000Z"],
  ];
  for (const [fields, resetsAt] of cases) {
    const failure = classify(fields);
    assert.equal(failure.failure_class, "rate_limited", fields.error);
    assert.deepEqual(failure.rate_limit, { resets_at: resetsAt, source: "text" }, fields.error);
  }

  // A parenthesis elsewhere in the output is not taken for the zone.
  assert.deepEqual(
    runtime.resolveRateLimitReset([{ kind: "text", text: "spawn (os error 2)\nYou've hit your usage limit. Try again at 9:30 PM." }], tokyoEvening, { harness: "codex", timeZone: "Asia/Tokyo" }),
    { resets_at: "2026-09-28T12:31:00.000Z", source: "text" },
  );
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
  assert.deepEqual(losAngelesReset, { resets_at: "2026-09-28T22:06:00.000Z", source: "text" });
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
    { resets_at: "2026-09-28T16:01:00.000Z", source: "text" },
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
  const failure = runtime.classifyProviderFailure("codex-cli/v1", failed({
    stderr: "You've hit your usage limit",
    rate_limit_evidence: [{ kind: "event", event: { error: { codexErrorInfo: "usageLimitExceeded" } } }],
  }), "en", now);
  assert.equal(failure.failure_class, "rate_limited");
  assert.deepEqual(failure.rate_limit, { resets_at: null, source: null });
});

const INCIDENT = "exceeded retry limit, last status: 429 Too Many Requests";
const jsonl = (...events) => events.map((event) => JSON.stringify(event)).join("\n");

// Design table 3.5: rows with no usage-limit code and no reported reset time.
const TRANSIENT_CASES = {
  "1 codex exec turn.failed": ["codex-cli/v1", failed({ stdout: jsonl({ type: "turn.failed", error: { message: INCIDENT } }), error: INCIDENT })],
  "2 app-server responseTooManyFailedAttempts": ["codex", failed({ kind: "harness_error", harness_status: 429, harness_code: "responseTooManyFailedAttempts", error: INCIDENT })],
  "3 rollout snake_case": ["codex", failed({ kind: "harness_error", harness_status: 429, error: INCIDENT, rate_limit_evidence: [{ kind: "event", event: { codex_error_info: { response_too_many_failed_attempts: { http_status_code: 429 } } } }] })],
  "4 rateLimitExceeded": ["codex", failed({ kind: "harness_error", harness_code: "rateLimitExceeded", error: "slow down" })],
  "8 usage limit sentence only": ["codex-cli/v1", failed({ stderr: "You've hit your usage limit." })],
  "9 try again later": ["codex-cli/v1", failed({ stderr: "You've hit your usage limit. Try again later." })],
  "10 relative wait": ["codex-cli/v1", failed({ stderr: "You've hit your usage limit. Try again in 45m" })],
  "11 word usageLimitExceeded in the text": ["codex-cli/v1", failed({ error: "usageLimitExceeded", stderr: "429" })],
  "13 snapshot below 100%": ["codex-cli/v1", failed({ harness_status: 429, rate_limit_evidence: [{ kind: "event", event: { rate_limits: { primary: { used_percent: 40, resets_at: Date.parse("2026-09-27T05:00:00.000Z") / 1000 } } } }] })],
  "15 relative wait with 429": ["codex-cli/v1", failed({ harness_status: 429, error: "Rate limit reached for gpt-5. Please try again in 6ms." })],
  "16 time without a marker": ["codex-cli/v1", failed({ harness_status: 429, stderr: "2026-09-27 03:04:05 429 Too Many Requests" })],
  "17 stderr 429 only": ["codex-cli/v1", failed({ stderr: "429 Too Many Requests" })],
  "18 Retry-After in the model output": ["codex-cli/v1", failed({
    stdout: jsonl({ type: "item.completed", item: { type: "agent_message", text: "Retry-After: 30" } }, { type: "turn.failed", error: { message: INCIDENT } }),
    error: INCIDENT,
    rate_limit_evidence: runtime.codexRateLimitEvidence(jsonl({ type: "item.completed", item: { type: "agent_message", text: "Retry-After: 30" } }, { type: "turn.failed", error: { message: INCIDENT } })),
  })],
  "23 claude rate_limit_error": ["claude-cli/v1", failed({ harness_status: 429, harness_code: "rate_limit_error", error: "API Error: Rate limit reached" })],
  "24 claude stderr 429": ["claude-cli/v1", failed({ stderr: "API Error: 429 Too Many Requests" })],
  "25 thrown usage limit": ["codex-cli/v1", { exit_code: null, signal: null, error: new Error("You've hit your usage limit") }],
  "32 429 before unauthorized": ["claude-cli/v1", failed({ harness_status: 429, stderr: "unauthorized" })],
};

for (const [name, [harness, cause]] of Object.entries(TRANSIENT_CASES)) {
  test(`a 429 without a usage-limit code or reset time is a transient limit: ${name}`, () => {
    const failure = runtime.classifyProviderFailure(harness, cause, "ja", now);
    assert.equal(failure.failure_class, "transient");
    assert.equal(failure.error_key, "provider_failed:rate_limit_transient");
    assert.equal(failure.rate_limit, undefined);
    assert.equal(failure.retry_allowed, true);
  });
}

// Design table 3.5 rows 5-7, 12, 14, 18-22, 26: a code or a reported reset time.
const LIMITED_CASES = {
  "5 string code": ["codex", failed({ kind: "harness_error", harness_code: "usageLimitExceeded", error: "limit" }), null],
  "5 string codexErrorInfo": ["codex", failed({ rate_limit_evidence: [{ kind: "event", event: { error: { codexErrorInfo: "usageLimitExceeded" } } }] }), null],
  "5 one-key object": ["codex", failed({ rate_limit_evidence: [{ kind: "event", event: { error: { codexErrorInfo: { usageLimitExceeded: {} } } } }] }), null],
  "5 snake_case": ["codex", failed({ rate_limit_evidence: [{ kind: "event", event: { codex_error_info: "usage_limit_exceeded" } }] }), null],
  "5 record form": ["codex", failed({ rate_limit_evidence: [{ kind: "event", event: { error: { codexErrorInfo: { kind: "usageLimitExceeded" } } } }] }), null],
  "7 try again at": ["codex-cli/v1", failed({ stderr: "You've hit your usage limit. Try again at 9:00 PM." }), "text"],
  "12 saturated snapshot": ["codex-cli/v1", failed({ harness_status: 429, rate_limit_evidence: [{ kind: "event", event: { rate_limits: { primary: { used_percent: 100, resets_at: Date.parse("2026-09-27T05:00:00.000Z") / 1000 } } } }] }), "event"],
  "14 Retry-After": ["codex-cli/v1", failed({ harness_status: 429, stderr: "Retry-After: 120" }), "retry_after"],
  "20 usage limit epoch": ["claude-cli/v1", failed({ harness_status: 429, error: "Claude AI usage limit reached|1790000000" }), "text"],
  "21 session limit resets 4am": ["claude-cli/v1", failed({ harness_status: 429, error: "You've hit your session limit · resets 4am (UTC)" }), "text"],
  "22 5-hour limit resets 3pm": ["claude-cli/v1", failed({ harness_status: 429, error: "5-hour limit reached · resets 3pm" }), "text"],
  "19 claude rejected": ["claude-cli/v1", failed({ rate_limit_evidence: [{ kind: "event", event: { type: "rate_limit_event", rate_limit_info: { status: "rejected" } } }] }), null],
  "26 opencode provider.rate-limit": ["opencode-serve/v1", failed({ harness_status: 429, harness_code: "provider.rate-limit", error: "slow down" }), null],
};

for (const [name, [harness, cause, source]] of Object.entries(LIMITED_CASES)) {
  test(`a usage-limit code or a reported reset time is rate_limited: ${name}`, () => {
    const failure = runtime.classifyProviderFailure(harness, cause, "en", now);
    assert.equal(failure.failure_class, "rate_limited");
    assert.equal(failure.error_key, "provider_failed:rate_limited");
    assert.notEqual(failure.rate_limit, undefined);
    if (source !== null) assert.equal(failure.rate_limit.source, source);
  });
}

test("reportedRateLimitReset reads only a time right after a marker", () => {
  const read = (text) => runtime.reportedRateLimitReset([{ kind: "text", text }], now, { harness: "codex", timeZone: "UTC" });
  assert.equal(read("You've hit your usage limit. Try again at 9:00 PM.").resets_at, "2026-09-27T21:01:00.000Z");
  assert.equal(read("Try again at Sep 28, 2026 3:05 PM").resets_at, "2026-09-28T15:06:00.000Z");
  assert.equal(read("limit reached, resets 9pm (Asia/Tokyo)").resets_at, "2026-09-27T12:01:00.000Z");
  assert.equal(read("Please try again in 6ms."), null);
  assert.equal(read("try again in 45m"), null);
  assert.equal(read("2026-09-27 03:04:05 Too Many Requests"), null);
  assert.equal(read("429 Too Many Requests; resets unknown; log entry Sep 28, 2026 3:05 PM"), null);
  assert.equal(read("429 Too Many Requests; resets Monday unknown; log entry Sep 28, 2026 3:05 PM"), null);
  assert.equal(read("resets 9pm; log entry Sep 28, 2026 3:05 PM").resets_at, "2026-09-27T21:01:00.000Z");
  assert.equal(read("resets 9pm; log entry 3:05 PM (Asia/Tokyo)").resets_at, "2026-09-27T21:01:00.000Z");
  assert.equal(read("resets 2026-09-28 03:04:05"), null);
  assert.equal(runtime.reportedRateLimitReset([{ kind: "retry_after", value: 120 }], now, { harness: "codex" }).source, "retry_after");
});

test("the transient limit message never says usage limit, while the detail keeps the provider's words", () => {
  for (const [language, expected] of [
    ["ja", "Codexへのリクエストが一時的に制限されました（HTTP 429）。"],
    ["en", "Codex is temporarily limiting requests (HTTP 429)."],
  ]) {
    const failure = runtime.classifyProviderFailure("codex-cli/v1", failed({ harness_status: 429, error: "You've hit your usage limit." }), language, now);
    assert.equal(failure.message, expected);
    assert.doesNotMatch(failure.message, /利用上限/u);
    assert.doesNotMatch(failure.message, /usage limit/iu);
    assert.match(runtime.withProviderDetail(failure, language), /You've hit your usage limit\./u);
  }
});

test("sessionFailureMessage adds the resend note only to a transient limit", () => {
  const transient = runtime.classifyProviderFailure("codex", failed({ harness_status: 429, error: INCIDENT }), "ja", now);
  assert.equal(runtime.sessionFailureMessage(transient), `${transient.message} 少し待ってから、もう一度送ってください。`);
  assert.match(runtime.sessionFailureMessage(transient, "en"), /Wait a moment, then send the message again\.$/u);
  const limited = runtime.classifyProviderFailure("codex", failed({ harness_code: "usageLimitExceeded" }), "ja", now);
  assert.equal(runtime.sessionFailureMessage(limited), limited.message);
  const network = runtime.classifyProviderFailure("codex", failed({ stderr: "ECONNRESET" }), "ja", now);
  assert.equal(runtime.sessionFailureMessage(network), network.message);
});

test("formatProviderError without a verdict shows a rate-limit-like text as a transient limit", () => {
  assert.equal(runtime.formatProviderError("codex", "429 Too Many Requests", {}, "en"), "Codex is temporarily limiting requests.");
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

test("minute-only reset clocks use the end of the reported minute", () => {
  const beforeReset = new Date("2026-10-13T10:20:00.000Z");
  const options = { harness: "codex", timeZone: "Asia/Tokyo" };
  for (const clock of ["8:36 PM", "Oct 13, 8:36 PM", "Oct 13 8:36 PM"]) {
    assert.deepEqual(
      runtime.resolveRateLimitReset([{ kind: "text", text: `try again at ${clock}` }], beforeReset, options),
      { resets_at: "2026-10-13T11:37:00.000Z", source: "text" },
      clock,
    );
  }
  for (const clock of ["8:36:59 PM", "Oct 13, 8:36:59 PM"]) {
    assert.deepEqual(
      runtime.resolveRateLimitReset([{ kind: "text", text: `try again at ${clock}` }], beforeReset, options),
      { resets_at: "2026-10-13T11:36:59.000Z", source: "text" },
      clock,
    );
  }
  assert.deepEqual(
    runtime.resolveRateLimitReset(
      [{ kind: "text", text: "try again at Oct 13, 8:36:59 PM" }],
      new Date("2026-10-13T11:36:30.000Z"),
      options,
    ),
    { resets_at: "2026-10-13T11:36:59.000Z", source: "text" },
  );
  const preciseReset = new Date("2026-10-13T11:36:59.000Z");
  for (const input of [
    { kind: "event", event: { resets_at: preciseReset.getTime() / 1000 } },
    { kind: "event", event: { resets_at: preciseReset.toISOString() } },
    { kind: "text", text: `usage limit reached | ${preciseReset.getTime() / 1000}` },
  ]) {
    assert.equal(runtime.resolveRateLimitReset([input], beforeReset, options).resets_at, preciseReset.toISOString());
  }
});
