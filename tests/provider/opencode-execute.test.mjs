// opencode execute path: a private `opencode serve` (the fake) runs one turn per call. Covers the result
// lines, session handling, pre-checks, startup checks, error classification, limits and teardown.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { classifyProviderFailure, executeOpencode, opencodeContextTokens } from "../../packages/agent-runtime/dist/index.js";
import { extractProviderUsage, harnessFailureDetail, isClaudeReportFormatFailure, unwrapCliResult } from "../../packages/agent-runtime/dist/protocol.js";
import { opencodePermissionRules } from "../../packages/shared/dist/index.js";
import { readFakeOpencodeLog, writeFakeOpencode } from "../helpers/fake-opencode.mjs";
import { tempDir } from "../helpers/temp.mjs";

const adapter = "opencode-serve/v1";
const tokens = (input, output, reasoning = 0, read = 0, write = 0) => ({ input, output, reasoning, cache: { read, write } });
const step = (text, usage) => [{ op: "text", chunks: [text] }, { op: "step_end", tokens: usage }];
const done = (text = "ok") => [...step(text, tokens(1, 1)), { op: "succeed" }];

/** Runs executeOpencode against the fake. `fake` are FAKE_OPENCODE_* knobs; `request` and `deps` override the defaults. */
async function setup(t, { scenario = [], fake = {}, env = {}, request = {}, deps = {}, sessions } = {}) {
  const root = await tempDir(t, "owl-opencode-exec-");
  const executable = await writeFakeOpencode(root);
  const logPath = path.join(root, "log.jsonl");
  const cwd = path.join(root, "work");
  await mkdir(cwd);
  const runEnv = {
    PATH: process.env.PATH ?? "",
    OWL_ROOT: root,
    OWL_OPENCODE_EXECUTABLE: executable,
    FAKE_OPENCODE_LOG: logPath,
    FAKE_OPENCODE_SCENARIO: JSON.stringify(scenario),
    FAKE_OPENCODE_HEARTBEAT_MS: "0",
    ...(sessions ? { FAKE_OPENCODE_SESSIONS: JSON.stringify(sessions(cwd)) } : {}),
    ...fake,
    ...env,
  };
  const call = (overrides = {}) =>
    executeOpencode(
      { adapter, role: "worker", model: "fake-provider/fake-model", prompt: "do the work\n  exactly", invocation_id: "run-1", cwd, env: runEnv, ...request, ...overrides },
      { env: {}, timeouts: { wallMs: 20_000, idleMs: 5_000 }, reapGraceMs: 1_000, eventStallMs: 5_000, ...deps },
    );
  const requests = async (suffix) => (await readFakeOpencodeLog(logPath)).filter((e) => e.type === "request" && e.method === "POST" && e.path.endsWith(suffix));
  return { root, cwd, call, logPath, requests, runDir: path.join(root, "data", "opencode-runs", "run-1") };
}

const alive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail("expected a rejection");
}

const exited = (response) => ({ exit_code: 1, signal: null, kind: "exit", ...harnessFailureDetail(adapter, response.stdout) });

test("a two-step turn returns the text, the session id and the summed usage in provider-json lines", async (t) => {
  const ctx = await setup(t, { scenario: [...step("first ", tokens(10, 5, 2, 3, 1)), ...step("second", tokens(20, 7, 1, 4, 2)), { op: "succeed" }] });
  const pids = [];
  const response = await ctx.call({ on_spawn: (pid) => pids.push(pid) });
  assert.equal(response.exit_code, 0);
  assert.equal(response.format, "provider-json");
  assert.match(response.provider_session_id, /^ses_/u);
  assert.equal(unwrapCliResult(adapter, response.stdout), "second");
  const usage = extractProviderUsage(response);
  assert.deepEqual([usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cache_write_tokens], [30, 15, 7, 3]);
  assert.equal(opencodeContextTokens(response.stdout), 26);
  const lines = response.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.at(-1).type, "opencode.result");
  assert.ok(lines.slice(0, -1).every((line) => line.type === "opencode.event"));
  assert.ok(lines.every((line) => !/\.delta$|reasoning/u.test(line.event?.type ?? "")));
  assert.equal(isClaudeReportFormatFailure(adapter, response.stdout), false);
  assert.equal(harnessFailureDetail(adapter, response.stdout), null);
  assert.equal(pids.length, 1);
  assert.equal(alive(pids[0]), false);
  assert.equal(existsSync(ctx.runDir), false);
});

test("the session is created with the documented body and the prompt body carries only text", async (t) => {
  const ctx = await setup(t, { scenario: done(), request: { effort: "high" } });
  await ctx.call();
  const [create] = await ctx.requests("/api/session");
  assert.deepEqual(create.body, {
    title: "run-1",
    agent: "build",
    model: { providerID: "fake-provider", id: "fake-model", variant: "high" },
    location: { directory: ctx.cwd },
    permissions: opencodePermissionRules("worker"),
  });
  const [prompt] = await ctx.requests("/prompt");
  assert.deepEqual(Object.keys(prompt.body), ["text"]);
  assert.equal(prompt.body.text, "do the work\n  exactly");
});

test("variant is left out when the effort is not one of the model's variants", async (t) => {
  const ctx = await setup(t, { scenario: done(), request: { effort: "extreme" } });
  const response = await ctx.call();
  const [create] = await ctx.requests("/api/session");
  assert.deepEqual(create.body.model, { providerID: "fake-provider", id: "fake-model" });
  assert.match(response.stderr, /effort "extreme"/u);
});

test("stderr says no variant was passed when there is no effort, and says nothing when a variant was passed", async (t) => {
  const without = await setup(t, { scenario: done() });
  assert.match((await without.call()).stderr, /no variant was passed/u);
  const withVariant = await setup(t, { scenario: done(), request: { effort: "high" } });
  assert.doesNotMatch((await withVariant.call()).stderr, /variant/u);
});

const savedSession = (cwd, overrides = {}) => [{ id: "ses_old", projectID: "proj_1", agent: "build", model: { providerID: "fake-provider", id: "fake-model" }, location: { directory: cwd }, permissions: opencodePermissionRules("worker"), ...overrides }];

test("a resumed session is reused without creating one and a send after it goes to the same id", async (t) => {
  const ctx = await setup(t, { scenario: done("again"), sessions: (cwd) => savedSession(cwd), request: { provider_session_id: "ses_old" } });
  const response = await ctx.call();
  assert.equal(response.provider_session_id, "ses_old");
  assert.equal(unwrapCliResult(adapter, response.stdout), "again");
  assert.equal((await ctx.requests("/api/session")).length, 0);
  assert.equal((await ctx.requests("/model")).length, 0);
  const [prompt] = await ctx.requests("/prompt");
  assert.equal(prompt.path, "/api/session/ses_old/prompt");
});

test("the turn's messages are read page by page with the cursor until this turn's user message", async (t) => {
  const earlier = [
    { id: "msg_old_user", type: "user", content: [{ type: "text", text: "before" }] },
    { id: "msg_old_reply", type: "assistant", content: [{ type: "text", text: "old" }], tokens: tokens(100, 100) },
  ];
  const ctx = await setup(t, {
    scenario: [...step("one", tokens(1, 2)), ...step("two", tokens(10, 20)), ...step("three", tokens(100, 200)), { op: "succeed" }],
    fake: { FAKE_OPENCODE_MESSAGE_PAGE_SIZE: "1" },
    sessions: (cwd) => savedSession(cwd, { messages: earlier }),
    request: { provider_session_id: "ses_old" },
  });
  const response = await ctx.call();
  assert.equal(unwrapCliResult(adapter, response.stdout), "three");
  const usage = extractProviderUsage(response);
  assert.deepEqual([usage.input_tokens, usage.output_tokens], [111, 222]);
  const lists = (await readFakeOpencodeLog(ctx.logPath)).filter((e) => e.type === "request" && e.method === "GET" && /\/api\/session\/ses_old\/message(\?|$)/u.test(e.path));
  // Three assistant pages and the page holding this turn's user message; the older history is not read.
  assert.equal(lists.length, 4);
  assert.equal(lists[0].path, "/api/session/ses_old/message");
  assert.ok(lists.slice(1).every((e) => /\?cursor=msg_/u.test(e.path)));
});

test("a resumed session that does not exist, or lives in another directory, is a harness error before any prompt", async (t) => {
  const missing = await setup(t, { scenario: done(), request: { provider_session_id: "ses_none" } });
  assert.equal((await rejection(missing.call())).cause.code, "opencode_session_not_found");
  const other = await setup(t, { scenario: done(), sessions: () => savedSession("/somewhere/else"), request: { provider_session_id: "ses_old" } });
  const error = await rejection(other.call());
  assert.equal(error.cause.code, "opencode_session_mismatch");
  assert.equal(error.cause.harness_transient, false);
  for (const ctx of [missing, other]) {
    assert.equal((await ctx.requests("/prompt")).length, 0);
    assert.equal(existsSync(ctx.runDir), false);
  }
});

test("a resumed session on another model has its model changed first", async (t) => {
  const ctx = await setup(t, { scenario: done(), sessions: (cwd) => savedSession(cwd, { model: { providerID: "other", id: "old-model" } }), request: { provider_session_id: "ses_old", effort: "high" } });
  await ctx.call();
  const [change] = await ctx.requests("/model");
  assert.deepEqual(change.body, { model: { providerID: "fake-provider", id: "fake-model", variant: "high" } });
  assert.equal((await ctx.requests("/api/session")).length, 0);
});

test("no login stops the call before anything is sent; an API key from Owl skips the check, a base URL alone does not", async (t) => {
  const none = await setup(t, { fake: { FAKE_OPENCODE_CONNECTIONS: "0" } });
  const response = await none.call();
  assert.equal(response.exit_code, 1);
  const detail = harnessFailureDetail(adapter, response.stdout);
  assert.equal(detail.harness_code, "provider.auth");
  assert.equal(detail.harness_status, 401);
  assert.equal((await none.requests("/api/session")).length, 0);
  assert.equal((await none.requests("/prompt")).length, 0);

  const withKey = await setup(t, { scenario: done(), fake: { FAKE_OPENCODE_CONNECTIONS: "0" }, env: { OWL_OPENCODE_API_KEY_ENV: "SOME_KEY_VAR", SOME_KEY_VAR: "k" } });
  assert.equal((await withKey.call()).exit_code, 0);

  const withUrl = await setup(t, { fake: { FAKE_OPENCODE_CONNECTIONS: "0" }, env: { OWL_OPENCODE_BASE_URL: "http://127.0.0.1:9/v1" } });
  assert.equal(harnessFailureDetail(adapter, (await withUrl.call()).stdout).harness_code, "provider.auth");
});

test("a missing or disabled model is deterministic model.not-found and nothing is sent", async (t) => {
  for (const models of [[], [{ providerID: "fake-provider", modelID: "fake-model", variants: [], enabled: false }]]) {
    const ctx = await setup(t, { fake: { FAKE_OPENCODE_MODELS: JSON.stringify(models) } });
    const response = await ctx.call();
    const detail = harnessFailureDetail(adapter, response.stdout);
    assert.equal(detail.harness_code, "model.not-found");
    assert.equal(detail.harness_status, 404);
    assert.equal((await ctx.requests("/api/session")).length, 0);
    assert.equal(classifyProviderFailure(adapter, exited(response)).failure_class, "deterministic");
  }
});

test("an old opencode is refused before serve starts, and a non-builtin plugin is refused", async (t) => {
  const old = await setup(t, { fake: { FAKE_OPENCODE_VERSION: "1.0.0" } });
  assert.equal((await rejection(old.call())).cause.code, "opencode_version_unsupported");
  assert.equal(existsSync(old.runDir), false);

  const plugin = await setup(t, { fake: { FAKE_OPENCODE_PLUGINS: JSON.stringify([{ id: "x", source: { type: "npm" }, features: [], state: "active" }]) } });
  assert.equal((await rejection(plugin.call())).cause.code, "opencode_external_plugin");
  assert.equal(existsSync(plugin.runDir), false);
});

const rateLimit = { type: "provider.rate-limit", message: "slow down", status: 429 };

test("a retry scheduled beyond the wait limit interrupts and reports rate_limited with the reset time", async (t) => {
  const at = Date.now() + 3_600_000;
  const ctx = await setup(t, { scenario: [{ op: "retry", attempt: 1, at, error: rateLimit }, { op: "wait_interrupt" }], deps: { retryWaitLimitMs: 1_000 } });
  const response = await ctx.call();
  assert.equal(response.exit_code, 1);
  assert.equal((await ctx.requests("/interrupt")).length, 1);
  const failure = classifyProviderFailure(adapter, exited(response));
  assert.equal(failure.failure_class, "rate_limited");
  assert.ok(Math.abs(Date.parse(failure.rate_limit.resets_at) - at) < 2_000);
});

test("a retry within the wait limit keeps waiting however large attempt is", async (t) => {
  const at = Date.now() + 600;
  const scenario = [{ op: "retry", attempt: 500, at, error: rateLimit }, ...done("late")];
  const ctx = await setup(t, { scenario, deps: { retryWaitLimitMs: 5_000, timeouts: { wallMs: 20_000, idleMs: 200 } } });
  const response = await ctx.call();
  assert.equal(unwrapCliResult(adapter, response.stdout), "late");
  assert.equal((await ctx.requests("/interrupt")).length, 0);
});

test("transport and timeout errors are transient whatever the message says; context-overflow is deterministic even with 'timeout'", async (t) => {
  const run = async (error) => {
    const ctx = await setup(t, { scenario: [{ op: "step_fail", error }, { op: "fail", error }] });
    return classifyProviderFailure(adapter, exited(await ctx.call()));
  };
  for (const type of ["provider.transport", "provider.timeout"]) {
    const failure = await run({ type, message: "bad request: invalid" });
    assert.equal(failure.failure_class, "transient");
    assert.equal(failure.retry_allowed, true);
  }
  const overflow = await run({ type: "context-overflow", message: "timeout while counting" });
  assert.equal(overflow.failure_class, "deterministic");
  assert.equal(overflow.retry_allowed, false);
});

test("a model error keeps its detail in the result line with exit_code 1", async (t) => {
  const error = { type: "provider.quota", message: "out of credit", status: 429 };
  const ctx = await setup(t, { scenario: [{ op: "step_fail", error }, { op: "fail", error }] });
  const response = await ctx.call();
  assert.equal(response.exit_code, 1);
  assert.equal(harnessFailureDetail(adapter, response.stdout).harness_status, 429);
});

test("no events, or only heartbeats, is an idle timeout", async (t) => {
  for (const heartbeat of ["0", "20"]) {
    const ctx = await setup(t, { scenario: [{ op: "wait_interrupt" }], fake: { FAKE_OPENCODE_HEARTBEAT_MS: heartbeat }, deps: { timeouts: { wallMs: 20_000, idleMs: 400 } } });
    const error = await rejection(ctx.call());
    assert.equal(error.reason, "provider_timeout");
    assert.equal(error.cause.timeout_kind, "idle");
    assert.equal(existsSync(ctx.runDir), false);
  }
});

test("a stream that goes completely silent is reported as an exit", async (t) => {
  const ctx = await setup(t, { scenario: [{ op: "wait_interrupt" }], deps: { eventStallMs: 300, timeouts: { wallMs: 20_000, idleMs: 10_000 } } });
  const error = await rejection(ctx.call());
  assert.match(error.reason, /^provider_exit:/u);
});

test("an abort signal interrupts the turn and is cancelled", async (t) => {
  const controller = new AbortController();
  const ctx = await setup(t, { scenario: [{ op: "wait_interrupt" }] });
  const pending = ctx.call({ signal: controller.signal });
  setTimeout(() => controller.abort(), 700);
  const error = await rejection(pending);
  assert.equal(error.reason, "provider_cancelled");
  assert.equal((await ctx.requests("/interrupt")).length, 1);
  assert.equal(existsSync(ctx.runDir), false);
});

test("serve dying mid-turn is an exit with the stderr tail, and everything is cleaned up", async (t) => {
  const ctx = await setup(t, { scenario: [{ op: "exit", code: 3 }] });
  const pids = [];
  const error = await rejection(ctx.call({ on_spawn: (pid) => pids.push(pid) }));
  assert.equal(error.reason, "provider_exit:3");
  assert.equal(error.cause.exit_code, 3);
  assert.equal(typeof error.cause.stderr, "string");
  assert.equal(alive(pids[0]), false);
  assert.equal(existsSync(ctx.runDir), false);
});

test("the wall timeout stops the run as a wall timeout", async (t) => {
  const ctx = await setup(t, { scenario: [{ op: "wait_interrupt" }], deps: { timeouts: { wallMs: 600, idleMs: 10_000 } } });
  const error = await rejection(ctx.call());
  assert.equal(error.reason, "provider_timeout");
  assert.equal(error.cause.timeout_kind, "wall");
});

test("a serve that never answers a request is stopped by the wall timeout and by an abort, and is reaped", async (t) => {
  const walled = await setup(t, { fake: { FAKE_OPENCODE_HANG_PATH: "/api/model" }, deps: { timeouts: { wallMs: 600, idleMs: 10_000 } } });
  const error = await rejection(walled.call());
  assert.equal(error.reason, "provider_timeout");
  assert.equal(error.cause.timeout_kind, "wall");
  assert.equal(existsSync(walled.runDir), false);

  const cancelled = await setup(t, { fake: { FAKE_OPENCODE_HANG_PATH: "/api/model" } });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 400).unref();
  assert.equal((await rejection(cancelled.call({ signal: controller.signal }))).reason, "provider_cancelled");
  assert.equal(existsSync(cancelled.runDir), false);
});

test("an interrupt serve never answers does not hold the stop", async (t) => {
  const ctx = await setup(t, { scenario: [{ op: "wait_interrupt" }], fake: { FAKE_OPENCODE_HANG_INTERRUPT: "1" }, deps: { timeouts: { wallMs: 600, idleMs: 10_000 } } });
  const error = await rejection(ctx.call());
  assert.equal(error.reason, "provider_timeout");
  assert.equal(existsSync(ctx.runDir), false);
});

test("a permission reply serve never answers does not hold the stop after the turn ends", async (t) => {
  const call = { id: "call_x", assistantMessageID: "msg_x" };
  const scenario = [
    { op: "emit", type: "session.tool.input.started", data: { id: call.id, assistantMessageID: call.assistantMessageID, name: "read" } },
    { op: "emit", type: "session.tool.called", data: { id: call.id, assistantMessageID: call.assistantMessageID, input: { filePath: "a.txt" } } },
    { op: "emit", type: "permission.asked", data: { id: "per_x", action: "read", resources: ["*"], save: false, source: { type: "tool", messageID: call.assistantMessageID, id: call.id } } },
    { op: "succeed" },
  ];
  const fake = { FAKE_OPENCODE_HANG_PATH: "/permission/per_x/reply" };
  const walled = await setup(t, { scenario, fake, deps: { timeouts: { wallMs: 800, idleMs: 10_000 } } });
  const error = await rejection(walled.call());
  assert.equal(error.reason, "provider_timeout");
  assert.equal(error.cause.timeout_kind, "wall");
  assert.equal((await walled.requests("/interrupt")).length, 1);
  assert.equal(existsSync(walled.runDir), false);

  const cancelled = await setup(t, { scenario, fake });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 800).unref();
  assert.equal((await rejection(cancelled.call({ signal: controller.signal }))).reason, "provider_cancelled");
  assert.equal((await cancelled.requests("/interrupt")).length, 1);
  assert.equal(existsSync(cancelled.runDir), false);
});

test("a stop while the prompt or the result is in flight sends an interrupt", async (t) => {
  for (const hang of ["/prompt", "/message"]) {
    const ctx = await setup(t, { scenario: done(), fake: { FAKE_OPENCODE_HANG_PATH: hang }, deps: { timeouts: { wallMs: 800, idleMs: 10_000 } } });
    const error = await rejection(ctx.call());
    assert.equal(error.reason, "provider_timeout", hang);
    assert.equal((await ctx.requests("/interrupt")).length, 1, hang);
    assert.equal(existsSync(ctx.runDir), false, hang);
  }
});

test("stdout without an opencode.result line is not read as Claude output", () => {
  assert.throws(() => unwrapCliResult(adapter, '{"type":"result","result":"x"}\n'), (error) => error.reason === "opencode_result_missing");
  assert.equal(extractProviderUsage({ adapter, stdout: '{"type":"result","usage":{"input_tokens":5}}\n' }), null);
  assert.equal(opencodeContextTokens("not json"), null);
});
