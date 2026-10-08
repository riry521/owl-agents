import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { GUARD_TOKEN_FILE_ENV } from "../../packages/shared/dist/guard-token.js";
import { SUBAGENT_USAGE_BATCH_MAX } from "../../packages/shared/dist/token-relay.js";
import { repoRoot } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

const hookPath = path.join(repoRoot, "apps/server/dist/subagent-hook.js");

function runHook(input, { apiBase, tokenFile } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.OWL_GUARD_API_BASE;
    delete env[GUARD_TOKEN_FILE_ENV];
    if (apiBase !== undefined) env.OWL_GUARD_API_BASE = apiBase;
    if (tokenFile !== undefined) env[GUARD_TOKEN_FILE_ENV] = tokenFile;
    const started = Date.now();
    const child = spawn(process.execPath, [hookPath], { env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), ms: Date.now() - started }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

async function setup(t) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(202);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await tempDir(t, "owl-subagent-hook-");
  const tokenFile = path.join(dir, "token");
  await writeFile(tokenFile, "guard-token-value\n", "utf8");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  return { requests, apiBase: `http://127.0.0.1:${server.address().port}`, tokenFile, dir };
}

for (const [name, event] of [["SubagentStart", "start"], ["SubagentStop", "stop"]]) {
  test(`${name} posts only event, agent_id and a truncated agent_type`, async (t) => {
    const { requests, apiBase, tokenFile } = await setup(t);
    const result = await runHook({
      hook_event_name: name,
      agent_id: "agent-1",
      agent_type: "x".repeat(500),
      prompt: "SECRET-PROMPT ".repeat(1000),
      transcript_path: "/tmp/SECRET-transcript.jsonl",
      last_assistant_message: "SECRET-MESSAGE sk-abcdef",
    }, { apiBase, tokenFile });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/api/v1/subagents/hook-event");
    assert.equal(requests[0].authorization, "Bearer guard-token-value");
    const body = JSON.parse(requests[0].body);
    assert.equal(body.expected_version, 0);
    assert.match(body.request_id, /^[0-9a-f-]{36}$/u);
    assert.match(body.idempotency_key, /^[0-9a-f-]{36}$/u);
    assert.deepEqual(body.payload, { event, agent_id: "agent-1", agent_type: "x".repeat(200) });
    assert.ok(!/SECRET|sk-abcdef|guard-token-value/u.test(requests[0].body));
  });
}

test("hook exits 0 quickly and silently when Core is unreachable, token is missing or input is broken", async (t) => {
  const { requests, apiBase, tokenFile, dir } = await setup(t);
  const valid = { hook_event_name: "SubagentStart", agent_id: "a" };
  const cases = [
    [valid, { apiBase: "http://127.0.0.1:1", tokenFile }],
    [valid, { apiBase, tokenFile: path.join(dir, "missing") }],
    ["{not json", { apiBase, tokenFile }],
    [valid, {}],
  ];
  for (const [input, options] of cases) {
    const result = await runHook(input, options);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.ok(result.ms < 5000, `took ${result.ms}ms`);
  }
  assert.equal(requests.length, 0);
});

const assistantLine = (id, prompt, timestamp) => JSON.stringify({
  type: "assistant",
  timestamp,
  message: {
    id, model: "claude-haiku-5-5", content: [{ type: "text", text: "SECRET-BODY" }],
    usage: { input_tokens: prompt - 1000, cache_read_input_tokens: 600, cache_creation_input_tokens: 400, output_tokens: 7 },
  },
});

test("SubagentStop posts stop, then the transcript's deduplicated request usage without its text", async (t) => {
  const { requests, apiBase, tokenFile, dir } = await setup(t);
  const transcript = path.join(dir, "agent.jsonl");
  await writeFile(transcript, [
    assistantLine("msg_a", 120000, "2026-10-08T00:00:00.000Z"),
    assistantLine("msg_a", 120000, "2026-10-08T00:00:01.000Z"),
    JSON.stringify({ type: "user", message: { content: "SECRET-USER" } }),
    "{broken json SECRET",
    assistantLine("msg_b", 50000, "2026-10-08T00:00:02.000Z"),
  ].join("\n"), "utf8");
  const result = await runHook({ hook_event_name: "SubagentStop", agent_id: "agent-1", agent_type: "owl-researcher", agent_transcript_path: transcript }, { apiBase, tokenFile });
  assert.equal(result.code, 0);
  assert.deepEqual(requests.map((r) => JSON.parse(r.body).payload.event), ["stop", "usage"]);
  const usage = JSON.parse(requests[1].body).payload;
  assert.equal(usage.agent_id, "agent-1");
  assert.deepEqual(usage.requests.map((r) => [r.message_id, r.model, r.input_tokens + r.cache_read_tokens + r.cache_write_tokens]), [
    ["msg_a", "claude-haiku-5-5", 120000],
    ["msg_b", "claude-haiku-5-5", 50000],
  ]);
  assert.deepEqual(Object.keys(usage.requests[0]).sort(), ["cache_read_tokens", "cache_write_tokens", "created_at", "input_tokens", "message_id", "model", "output_tokens"]);
  assert.equal(usage.requests[0].created_at, "2026-10-08T00:00:00.000Z");
  assert.ok(!requests.some((r) => /SECRET/u.test(r.body)));
});

test("SubagentStart sends no usage, a missing transcript sends only stop, and a long one is split into batches", async (t) => {
  const { requests, apiBase, tokenFile, dir } = await setup(t);
  const transcript = path.join(dir, "long.jsonl");
  const lines = Array.from({ length: SUBAGENT_USAGE_BATCH_MAX + 1 }, (_, i) => assistantLine(`msg_${i}`, 2000, "2026-10-08T00:00:00.000Z"));
  await writeFile(transcript, lines.join("\n"), "utf8");

  assert.equal((await runHook({ hook_event_name: "SubagentStart", agent_id: "a", agent_transcript_path: transcript }, { apiBase, tokenFile })).code, 0);
  assert.equal((await runHook({ hook_event_name: "SubagentStop", agent_id: "a", agent_transcript_path: path.join(dir, "missing.jsonl") }, { apiBase, tokenFile })).code, 0);
  assert.deepEqual(requests.map((r) => JSON.parse(r.body).payload.event), ["start", "stop"]);

  requests.length = 0;
  assert.equal((await runHook({ hook_event_name: "SubagentStop", agent_id: "a", agent_transcript_path: transcript }, { apiBase, tokenFile })).code, 0);
  const payloads = requests.map((r) => JSON.parse(r.body).payload);
  assert.deepEqual(payloads.map((p) => p.event), ["stop", "usage", "usage"]);
  assert.deepEqual(payloads.slice(1).map((p) => p.requests.length), [SUBAGENT_USAGE_BATCH_MAX, 1]);
});
