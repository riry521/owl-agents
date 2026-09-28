import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { GUARD_TOKEN_FILE_ENV } from "../packages/shared/dist/guard-token.js";

const hookPath = path.resolve("apps/server/dist/research-hook.js");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function runHook(input, { apiBase, tokenFile } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, OWL_AGENT_ROLE: "worker" };
    if (apiBase === undefined) delete env.OWL_GUARD_API_BASE;
    else env.OWL_GUARD_API_BASE = apiBase;
    if (tokenFile === undefined) delete env[GUARD_TOKEN_FILE_ENV];
    else env[GUARD_TOKEN_FILE_ENV] = tokenFile;
    const child = spawn(process.execPath, [hookPath], { env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

async function receiver(t) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(202);
      response.end();
    });
  });
  const apiBase = await listen(server);
  t.after(() => close(server));
  return { apiBase, requests };
}

test("research hook sends PostToolUse data with Bearer auth and keeps stdout empty", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owl-research-hook-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = path.join(root, "guard-token");
  await writeFile(tokenFile, "test-guard-token\n", { mode: 0o600 });
  const { apiBase, requests } = await receiver(t);
  const input = {
    hook_event_name: "PostToolUse",
    tool_name: "WebFetch",
    tool_input: { url: "https://example.com/research", prompt: "find the key facts" },
    tool_response: { bytes: 100, code: 200, codeText: "OK", result: "A long enough captured research result.", durationMs: 5, url: "https://example.com/research" },
  };

  const result = await runHook(input, { apiBase, tokenFile });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/v1/research/capture");
  assert.equal(requests[0].authorization, "Bearer test-guard-token");
  const body = JSON.parse(requests[0].body);
  assert.equal(body.expected_version, 0);
  assert.equal(typeof body.request_id, "string");
  assert.equal(typeof body.idempotency_key, "string");
  assert.deepEqual(body.payload, { tool_name: input.tool_name, tool_input: input.tool_input, tool_response: input.tool_response });
});

test("research hook truncates oversized WebFetch results and refuses bodies over one megabyte", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owl-research-hook-size-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = path.join(root, "guard-token");
  await writeFile(tokenFile, "test-guard-token\n", { mode: 0o600 });
  const { apiBase, requests } = await receiver(t);
  const base = { hook_event_name: "PostToolUse", tool_name: "WebFetch", tool_input: { url: "https://example.com" } };

  const truncated = await runHook({ ...base, tool_response: { code: 200, result: "x".repeat(300_000) } }, { apiBase, tokenFile });
  assert.equal(truncated.code, 0);
  assert.equal(truncated.stdout, "");
  assert.equal(truncated.stderr, "");
  assert.equal(JSON.parse(requests[0].body).payload.tool_response.result.length, 262_144);

  const oversized = await runHook({ ...base, tool_input: { url: "https://example.com", extra: "x".repeat(1_000_001) }, tool_response: { code: 200, result: "small" } }, { apiBase, tokenFile });
  assert.equal(oversized.code, 0);
  assert.equal(oversized.stdout, "");
  assert.equal(oversized.stderr, "");
  assert.equal(requests.length, 1);
});

test("research hook detects auth forms in full string responses and only flags WebFetch", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owl-research-hook-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = path.join(root, "guard-token");
  await writeFile(tokenFile, "test-guard-token\n", { mode: 0o600 });
  const { apiBase, requests } = await receiver(t);
  const tail = "x".repeat(262_144) + '<input autocomplete="current-password">';

  const fetchResult = await runHook({
    hook_event_name: "PostToolUse",
    tool_name: "WebFetch",
    tool_input: { url: "https://example.com/login" },
    tool_response: tail,
  }, { apiBase, tokenFile });
  assert.equal(fetchResult.code, 0);
  assert.equal(JSON.parse(requests[0].body).payload.auth_form_detected, true);

  const searchResult = await runHook({
    hook_event_name: "PostToolUse",
    tool_name: "WebSearch",
    tool_input: { query: "password forms" },
    tool_response: { result: tail },
  }, { apiBase, tokenFile });
  assert.equal(searchResult.code, 0);
  assert.equal(Object.hasOwn(JSON.parse(requests[1].body).payload, "auth_form_detected"), false);
});

test("research hook exits quietly when input, token, or server is unavailable", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owl-research-hook-fail-open-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = path.join(root, "guard-token");
  await writeFile(tokenFile, "test-guard-token\n", { mode: 0o600 });
  const valid = { hook_event_name: "PostToolUse", tool_name: "WebSearch", tool_input: { query: "owl agents" }, tool_response: { results: [] } };

  for (const options of [
    { input: "{" , apiBase: "http://127.0.0.1:1", tokenFile },
    { input: valid, apiBase: "http://127.0.0.1:1" },
    { input: valid, apiBase: "http://127.0.0.1:1", tokenFile },
  ]) {
    const result = await runHook(options.input, options);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
});
