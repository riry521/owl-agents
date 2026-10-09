import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  claudeRateLimitEventObservation,
  claudeWindowKind,
  parseClaudeUsageResponse,
} from "../../packages/shared/dist/plan-usage-claude.js";
import { readClaudeCredential } from "../../packages/core/dist/plan-usage/claude-credentials.js";
import { CLAUDE_USAGE_URL, createClaudeUsageSource } from "../../packages/core/dist/plan-usage/claude-source.js";

const observedAt = new Date("2026-10-03T00:00:00.000Z");
const canary = "fake-claude-token-canary-7f4c";
const credential = {
  kind: "found",
  credential: { accessToken: canary, expiresAt: null, subscriptionType: "max" },
};

test("Claude usage response parses known and unknown windows safely", () => {
  const body = JSON.parse(`{
    "five_hour":{"utilization":125.26,"resets_at":"2026-10-03T05:00:00Z"},
    "seven_day":{"utilization":42.24,"resets_at":1791000000},
    "zero":{"utilization":0,"resets_at":"not a date"},
    "__proto__":{"utilization":15},
    "toString":{"utilization":5},
    "bad-key!":{"utilization":50},
    "wrong":{"utilization":"25"}
  }`);
  const parsed = parseClaudeUsageResponse(body, observedAt, "max");

  assert.equal(parsed?.origin, "claude_usage_api");
  assert.equal(parsed?.plan_type, "max");
  assert.deepEqual(parsed?.windows.map((window) => [window.id, window.kind, window.used_percent, window.resets_at, window.window_minutes, window.label]), [
    ["five_hour", "five_hour", 100, "2026-10-03T05:00:00.000Z", 300, null],
    ["seven_day", "weekly", 42.2, "2026-10-03T04:00:00.000Z", 10080, null],
    ["__proto__", "other", 15, null, null, "__proto__"],
    ["zero", "other", 0, null, null, "zero"],
  ]);
  assert.equal(parsed?.windows.some((window) => window.id === "toString"), false);
  assert.equal(claudeWindowKind("toString"), "other");
  assert.equal(parseClaudeUsageResponse({ five_hour: { utilization: "25" } }, observedAt, null), null);
  assert.equal(parseClaudeUsageResponse(null, observedAt, null), null);
});

test("Claude rate_limit_event maps states and merges direct and unified windows", () => {
  const parsed = claudeRateLimitEventObservation({
    type: "rate_limit_event",
    rate_limit_info: {
      rateLimitType: "five_hour",
      status: "allowed_warning",
      utilization: 0.75,
      resetsAt: 1_791_000_000,
      unifiedWindows: {
        five_hour: { utilization: 0.2, resetsAt: 1_792_000_000 },
        seven_day: { utilization: 100, resetsAt: "invalid" },
        toString: { utilization: 0.5 },
      },
    },
  }, observedAt);

  assert.equal(parsed?.origin, "claude_rate_limit_event");
  assert.equal(parsed?.plan_type, null);
  assert.deepEqual(parsed?.windows.map((window) => [window.id, window.kind, window.used_percent, window.resets_at, window.state]), [
    ["five_hour", "five_hour", 75, "2026-10-03T04:00:00.000Z", "warning"],
    ["seven_day", "weekly", 100, null, null],
  ]);
  assert.equal(parsed?.windows.some((window) => window.id === "toString"), false);
  assert.equal(claudeRateLimitEventObservation({ rate_limit_info: null }, observedAt), null);
  assert.equal(claudeRateLimitEventObservation({ rate_limit_info: { utilization: 2 } }, observedAt), null);
});

test("Claude usage API and rate_limit_event preserve zero utilization", () => {
  const usage = parseClaudeUsageResponse({ five_hour: { utilization: 0 } }, observedAt, null);
  const event = claudeRateLimitEventObservation({
    rate_limit_info: {
      rateLimitType: "five_hour",
      utilization: 0,
      unifiedWindows: { seven_day: { utilization: 0 } },
    },
  }, observedAt);

  assert.equal(usage?.windows[0].used_percent, 0);
  assert.deepEqual(event?.windows.map((window) => [window.id, window.used_percent]), [
    ["five_hour", 0],
    ["seven_day", 0],
  ]);
});

test("Claude rate_limit_event rejects utilization above one hundred in direct and unified windows", () => {
  const event = claudeRateLimitEventObservation({
    rate_limit_info: {
      rateLimitType: "five_hour",
      status: "allowed",
      utilization: 101,
      unifiedWindows: { seven_day: { utilization: 101, resetsAt: 1_791_000_000 } },
    },
  }, observedAt);

  assert.deepEqual(event?.windows.map((window) => [window.id, window.used_percent, window.resets_at]), [
    ["five_hour", null, null],
    ["seven_day", null, "2026-10-03T04:00:00.000Z"],
  ]);
});

test("macOS credentials try hashed then default Keychain services and accept exit zero", async () => {
  const configDir = "/tmp/claude-alt-config";
  const hashed = createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  const calls = [];
  const result = await readClaudeCredential({
    platform: "darwin",
    env: { CLAUDE_CONFIG_DIR: configDir },
    homedir: "/home/test",
    runSecurity: async (args) => {
      calls.push(args);
      if (args[2].endsWith(hashed)) return { code: 44, stdout: "" };
      return { code: 0, stdout: JSON.stringify({ claudeAiOauth: { accessToken: canary, expiresAt: 2_000_000_000_000, subscriptionType: "max", refreshToken: "ignored" } }) };
    },
    readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  });

  assert.deepEqual(calls.map((args) => args[2]), [`Claude Code-credentials-${hashed}`, "Claude Code-credentials"]);
  assert.deepEqual(result, { kind: "found", credential: { accessToken: canary, expiresAt: 2_000_000_000_000, subscriptionType: "max" } });
});

test("Keychain failures continue to the credentials file and ENOENT means missing", async () => {
  const calls = [];
  const result = await readClaudeCredential({
    platform: "darwin",
    env: {},
    homedir: "/home/test",
    runSecurity: async (args) => { calls.push(args); return { code: 1, stdout: "" }; },
    readFile: async (path) => {
      assert.equal(path, "/home/test/.claude/.credentials.json");
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.deepEqual(calls.map((args) => args[2]), ["Claude Code-credentials"]);
  assert.deepEqual(result, { kind: "missing" });
});

test("a Keychain read killed by execFile's timeout is reported as keychain_timeout, not missing", async () => {
  const result = await readClaudeCredential({
    platform: "darwin",
    env: {},
    homedir: "/home/test",
    // The same error shape execFile produces when its `timeout` kills the child.
    runSecurity: () => new Promise((_resolve, reject) => {
      execFile(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { timeout: 50 }, (error) => reject(error));
    }),
    readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  });
  assert.deepEqual(result, { kind: "unreadable", detail: "keychain_timeout" });
});

test("a Keychain read that fails by maxBuffer overflow or abort is not reported as keychain_timeout", async () => {
  const failures = [
    Object.assign(new Error("maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }),
    Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR", killed: true }),
  ];
  for (const failure of failures) {
    const result = await readClaudeCredential({
      platform: "darwin",
      env: {},
      homedir: "/home/test",
      runSecurity: async () => { throw failure; },
      readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    });
    assert.notDeepEqual(result, { kind: "unreadable", detail: "keychain_timeout" });
  }
});

test("Linux credentials honor CLAUDE_CONFIG_DIR and reject malformed JSON", async () => {
  const paths = [];
  const result = await readClaudeCredential({
    platform: "linux",
    env: { CLAUDE_CONFIG_DIR: " /tmp/claude-config " },
    homedir: "/home/test",
    runSecurity: async () => { throw new Error("must not run"); },
    readFile: async (path) => { paths.push(path); return "{"; },
  });
  assert.deepEqual(paths, ["/tmp/claude-config/.credentials.json"]);
  assert.deepEqual(result, { kind: "unreadable", detail: "invalid_json" });
});

test("source fetches only the fixed Anthropic URL and returns a parsed snapshot", async () => {
  let request;
  const source = createClaudeUsageSource({
    readCredential: async () => credential,
    now: () => observedAt,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ five_hour: { utilization: 35, resets_at: "2026-10-03T05:00:00Z" } }), { status: 200 });
    },
  });
  const result = await source.fetch(new AbortController().signal);

  assert.equal(CLAUDE_USAGE_URL, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(new URL(request.url).hostname, "api.anthropic.com");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.Authorization, `Bearer ${canary}`);
  assert.equal(request.options.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(request.options.headers.Accept, "application/json");
  assert.equal(request.options.headers["User-Agent"], "owl-agents");
  assert.equal(request.options.signal.aborted, false);
  assert.equal(result.status, "ok");
  assert.equal(result.snapshot?.windows[0].used_percent, 35);
  assert.equal(result.snapshot?.plan_type, "max");
});

test("source does not fetch credentials expiring within sixty seconds", async () => {
  let fetched = false;
  const source = createClaudeUsageSource({
    now: () => observedAt,
    readCredential: async () => ({ kind: "found", credential: { accessToken: canary, expiresAt: observedAt.getTime() + 60_000, subscriptionType: null } }),
    fetchImpl: async () => { fetched = true; return new Response("{}", { status: 200 }); },
  });
  assert.deepEqual(await source.fetch(new AbortController().signal), { status: "expired", snapshot: null, detail: null });
  assert.equal(fetched, false);
});

test("source maps unauthorized, malformed, missing, and ill-typed responses without throwing", async () => {
  const make = (readCredential, fetchImpl) => createClaudeUsageSource({ readCredential, fetchImpl, now: () => observedAt });
  const call = (source) => source.fetch(new AbortController().signal);

  assert.deepEqual(await call(make(async () => credential, async () => new Response("private body", { status: 401 }))), {
    status: "unauthorized", snapshot: null, detail: "http_401",
  });
  assert.deepEqual(await call(make(async () => credential, async () => new Response("private body", { status: 403 }))), {
    status: "unauthorized", snapshot: null, detail: "http_403",
  });
  assert.deepEqual(await call(make(async () => credential, async () => new Response("private body", { status: 429 }))), {
    status: "rate_limited", snapshot: null, detail: "http_429",
  });
  assert.deepEqual(await call(make(async () => credential, async () => new Response("private body", { status: 503 }))), {
    status: "unavailable", snapshot: null, detail: "http_503",
  });
  assert.deepEqual(await call(make(async () => credential, async () => new Response("not-json", { status: 200 }))), {
    status: "unrecognized", snapshot: null, detail: "unrecognized_response",
  });
  assert.deepEqual(await call(make(async () => credential, async () => new Response(JSON.stringify({} ), { status: 200 }))), {
    status: "unrecognized", snapshot: null, detail: "unrecognized_response",
  });
  assert.deepEqual(await call(make(async () => credential, async () => new Response(JSON.stringify({ five_hour: { utilization: "35" } }), { status: 200 }))), {
    status: "unrecognized", snapshot: null, detail: "unrecognized_response",
  });
  assert.deepEqual(await call(make(async () => ({ kind: "missing" }), async () => { throw new Error("must not fetch"); })), {
    status: "not_logged_in", snapshot: null, detail: null,
  });
  assert.deepEqual(await call(make(async () => { throw new Error(`private ${canary}`); }, async () => { throw new Error("must not fetch"); })), {
    status: "error", snapshot: null, detail: "source_threw",
  });
});

test("source maps network timeouts to unavailable without exposing the thrown message", async () => {
  const source = createClaudeUsageSource({
    readCredential: async () => credential,
    now: () => observedAt,
    fetchImpl: async () => { throw Object.assign(new Error(`timed out with ${canary}`), { name: "TimeoutError" }); },
  });
  const result = await source.fetch(new AbortController().signal);
  assert.deepEqual(result, { status: "unavailable", snapshot: null, detail: "timeout" });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(canary));
});

test("source maps a timeout while reading the response body to unavailable", async () => {
  const controller = new AbortController();
  const source = createClaudeUsageSource({
    readCredential: async () => credential,
    now: () => observedAt,
    fetchImpl: async (_url, options) => ({
      status: 200,
      json: async () => {
        controller.abort(Object.assign(new Error("body timed out"), { name: "TimeoutError" }));
        assert.equal(options.signal.aborted, true);
        throw Object.assign(new Error("body read aborted"), { name: "AbortError" });
      },
    }),
  });

  assert.deepEqual(await source.fetch(controller.signal), { status: "unavailable", snapshot: null, detail: "timeout" });
});

test("source result and captured console output never expose the credential token", async () => {
  const captured = [];
  const old = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...values) => captured.push(values.join(" "));
  console.warn = (...values) => captured.push(values.join(" "));
  console.error = (...values) => captured.push(values.join(" "));
  try {
    const source = createClaudeUsageSource({
      readCredential: async () => credential,
      now: () => observedAt,
      fetchImpl: async () => { throw new Error(`network failed with ${canary}`); },
    });
    const result = await source.fetch(new AbortController().signal);
    assert.equal(result.status, "unavailable");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(canary));
    assert.equal(captured.join("\n").includes(canary), false);

    const success = createClaudeUsageSource({
      readCredential: async () => ({ ...credential, credential: { ...credential.credential, subscriptionType: canary } }),
      now: () => observedAt,
      fetchImpl: async () => new Response(JSON.stringify({ five_hour: { utilization: 35 } }), { status: 200 }),
    });
    const successfulResult = await success.fetch(new AbortController().signal);
    assert.equal(successfulResult.status, "ok");
    assert.doesNotMatch(JSON.stringify(successfulResult), new RegExp(canary));
  } finally {
    console.log = old.log;
    console.warn = old.warn;
    console.error = old.error;
  }
});
