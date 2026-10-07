import assert from "node:assert/strict";
import { test } from "node:test";

import * as runtime from "../../packages/agent-runtime/dist/index.js";
import { unwrapCodexCliResult } from "../../packages/agent-runtime/dist/protocol.js";

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
