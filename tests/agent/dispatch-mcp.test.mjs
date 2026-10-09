import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { tempDir } from "../helpers/temp.mjs";

const serverPath = fileURLToPath(new URL("../../apps/server/dist/dispatch-mcp.js", import.meta.url));

async function withMcp(t, { handler, env = {}, captureTimeouts = false, forceTimeoutMs }, run) {
  const seen = [];
  const http = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const request = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
      seen.push(request);
      handler?.(request, req, res, seen);
    });
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const dir = await tempDir(t, "owl-dispatch-mcp-");
  const tokenFile = join(dir, "token");
  const timeoutFile = join(dir, "timeouts");
  const preload = join(dir, "timeout-hook.mjs");
  await writeFile(tokenFile, "token-one\n");
  if (captureTimeouts) {
    await writeFile(preload, `import { appendFileSync } from "node:fs";
const original = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms) => { appendFileSync(process.env.DISPATCH_TIMEOUT_CAPTURE, String(ms) + "\\n"); return original(Number(process.env.DISPATCH_TIMEOUT_FORCE_MS) || ms); };
`);
  }
  const args = captureTimeouts ? ["--import", preload, serverPath] : [serverPath];
  const child = spawn(process.execPath, args, {
    env: {
      PATH: process.env.PATH ?? "",
      OWL_ROLE: "worker",
      OWL_AGENT_RUN_ID: "run-1",
      OWL_GUARD_TOKEN_FILE: tokenFile,
      OWL_GUARD_API_BASE: `http://127.0.0.1:${http.address().port}`,
      ...(captureTimeouts ? { DISPATCH_TIMEOUT_CAPTURE: timeoutFile } : {}),
      ...(forceTimeoutMs ? { DISPATCH_TIMEOUT_FORCE_MS: String(forceTimeoutMs) } : {}),
      ...env,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let childExit;
  const childClosed = new Promise((resolve) => child.once("exit", (code) => {
    childExit = code;
    for (const call of pending.values()) call.reject(new Error(`MCP process exited with ${code}`));
    pending.clear();
    resolve();
  }));
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.resolve(message);
    }
  });
  let nextId = 1;
  const rpc = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for JSON-RPC ${method}`));
      }, 5000);
      pending.set(id, { resolve: (message) => { clearTimeout(timer); resolve(message); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  try {
    await run({ child, dir, tokenFile, timeoutFile, rpc, seen });
  } finally {
    if (childExit === undefined) child.kill();
    await childClosed;
    await new Promise((resolve) => http.close(resolve));
  }
}

function jsonResult(message) {
  return JSON.parse(message.result.content[0].text);
}

function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

test("owl-dispatch initializes, lists the tool schemas, and sends authenticated envelopes with a freshly read token", async (t) => {
  await withMcp(t, {
    handler: (request, _req, res) => reply(res, 200, { data: request.url.endsWith("/wait") ? { done: true, children: [] } : { child_id: "child-1", status: "queued" } }),
  }, async ({ rpc, tokenFile, seen }) => {
    assert.equal((await rpc("initialize")).result.protocolVersion, "2024-11-05");
    const listed = (await rpc("tools/list")).result.tools;
    assert.deepEqual(listed.map((tool) => tool.name), ["dispatch", "wait"]);
    assert.deepEqual(listed[0].inputSchema.required, ["title", "instruction", "write_paths"]);
    assert.equal(listed[0].inputSchema.additionalProperties, false);
    assert.match(listed[0].description, /provider, model, and effort can be specified independently/i);
    assert.match(listed[0].description, /omitted fields use the defaults for the harness different from the parent/i);
    for (const field of ["provider", "model", "effort"]) {
      assert.equal(listed[0].inputSchema.required.includes(field), false);
      assert.match(listed[0].inputSchema.properties[field].description, /optional/i);
      assert.match(listed[0].inputSchema.properties[field].description, /independently/i);
    }
    assert.deepEqual(listed[1].inputSchema.required, ["child_ids"]);
    assert.equal(listed[1].inputSchema.properties.timeout_seconds.maximum, 240);

    const dispatch = jsonResult(await rpc("tools/call", { name: "dispatch", arguments: { title: "t", instruction: "i", write_paths: ["src/a.ts"] } }));
    assert.equal(dispatch.child_id, "child-1");
    await writeFile(tokenFile, "token-two\n");
    const wait = jsonResult(await rpc("tools/call", { name: "wait", arguments: { child_ids: ["child-1"], timeout_seconds: 999 } }));
    assert.equal(wait.done, true);

    assert.deepEqual(seen.map((item) => item.url), ["/api/v1/agent/child-runs", "/api/v1/agent/child-runs/wait"]);
    assert.deepEqual(seen.map((item) => item.authorization), ["Bearer token-one", "Bearer token-two"]);
    for (const item of seen) {
      assert.equal(item.body.expected_version, 0);
      assert.equal(item.body.request_id, item.body.idempotency_key);
      assert.match(item.body.idempotency_key, /^\d+-[a-z0-9]+:\d+$/);
    }
    assert.deepEqual(seen[0].body.payload, { title: "t", instruction: "i", write_paths: ["src/a.ts"] });
    assert.deepEqual(seen[1].body.payload, { child_ids: ["child-1"], timeout_seconds: 240 });
  });
});

test("an ECONNRESET retries once with the same idempotency key", async (t) => {
  await withMcp(t, {
    handler: (request, req, res, seen) => {
      if (seen.length === 1) { req.socket.destroy(); return; }
      reply(res, 200, { data: { child_id: "child-retried", status: "queued" } });
    },
  }, async ({ rpc, seen }) => {
    const result = jsonResult(await rpc("tools/call", { name: "dispatch", arguments: { title: "t", instruction: "i", write_paths: ["a"] } }));
    assert.equal(result.child_id, "child-retried");
    assert.equal(seen.length, 2);
    assert.equal(seen[0].body.idempotency_key, seen[1].body.idempotency_key);
    assert.deepEqual(seen[0].body, seen[1].body);
  });
});

test("an HTTP client error response is returned without retry", async (t) => {
  await withMcp(t, { handler: (_request, _req, res) => reply(res, 422, { error: { code: "write_paths_invalid", message: "不正なパス" } }) }, async ({ rpc, seen }) => {
    const response = await rpc("tools/call", { name: "dispatch", arguments: { title: "t", instruction: "i", write_paths: ["../a"] } });
    assert.equal(response.result.isError, true);
    assert.deepEqual(jsonResult(response), { error: { code: "write_paths_invalid", message: "不正なパス" } });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(seen.length, 1);
  });
});

test("wait fetch timeout is timeout_seconds plus a grace period and dispatch fetch timeout is a fixed limit", async (t) => {
  await withMcp(t, {
    captureTimeouts: true,
    handler: (request, _req, res) => reply(res, 200, { data: request.url.endsWith("/wait") ? { done: true } : { child_id: "c", status: "queued" } }),
  }, async ({ rpc, timeoutFile }) => {
    await rpc("tools/call", { name: "dispatch", arguments: { title: "t", instruction: "i", write_paths: ["a"] } });
    await rpc("tools/call", { name: "wait", arguments: { child_ids: ["c"], timeout_seconds: 7 } });
    assert.deepEqual((await readFile(timeoutFile, "utf8")).trim().split("\n").map(Number), [30000, 37000]);
  });
});

test("wait fetch timeout returns owl_dispatch_timeout and does not retry", async (t) => {
  await withMcp(t, {
    captureTimeouts: true,
    forceTimeoutMs: 300,
    handler: (_request, _req, res) => setTimeout(() => reply(res, 200, { data: { done: true } }), 1500),
  }, async ({ rpc, timeoutFile, seen }) => {
    const response = await rpc("tools/call", { name: "wait", arguments: { child_ids: ["c"], timeout_seconds: 9 } });
    assert.equal(response.result.isError, true);
    const error = jsonResult(response).error;
    assert.equal(error.code, "owl_dispatch_timeout");
    assert.match(error.message, /状態は wait で確かめてください/);
    assert.deepEqual((await readFile(timeoutFile, "utf8")).trim().split("\n").map(Number), [39000]);
    assert.equal(seen.length, 1);
  });
});

async function withOwlApi(t, { handler, env = {}, tokenValue = "api-token-xyz" }, run) {
  const seen = [];
  const http = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const request = { method: req.method, url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(request);
      handler(request, req, res);
    });
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const dir = await tempDir(t, "owl-api-mcp-");
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, `${tokenValue}\n`);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../apps/server/dist/owl-api-mcp.js", import.meta.url))], {
    env: { PATH: process.env.PATH ?? "", OWL_ROLE: "advisor", OWL_GUARD_TOKEN_FILE: tokenFile, OWL_GUARD_API_BASE: `http://127.0.0.1:${http.address().port}`, ...env },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let buffer = "";
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let nextId = 1;
  const call = (args) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "request", arguments: args } })}\n`);
  });
  try {
    await run({ call, seen, tokenValue });
  } finally {
    child.kill();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
}

const errorCodeOf = (response) => JSON.parse(response.result.content[0].text).error.code;

test("owl-api request sends a Bearer GET to the local server and returns status and body; 403 comes back as an error", async (t) => {
  await withOwlApi(t, {
    handler: (request, _req, res) => request.url.startsWith("/api/v1/works") ? reply(res, 200, { data: [1] }) : reply(res, 403, { error: { code: "advisor_action_required" } }),
  }, async ({ call, seen }) => {
    const ok = await call({ method: "GET", api_path: "/api/v1/works?limit=1" });
    assert.deepEqual(JSON.parse(ok.result.content[0].text), { status: 200, body: { data: [1] } });
    assert.equal(ok.result.isError, undefined);
    assert.equal(seen[0].authorization, "Bearer api-token-xyz");
    assert.equal(seen[0].url, "/api/v1/works?limit=1");
    const denied = await call({ method: "GET", api_path: "/api/v1/settings/x" });
    assert.equal(denied.result.isError, true);
    assert.deepEqual(JSON.parse(denied.result.content[0].text), { status: 403, body: { error: { code: "advisor_action_required" } } });
  });
});

test("owl-api rejects unsafe paths and non-loopback bases without any request, and never prints the token", async (t) => {
  await withOwlApi(t, { handler: (_request, _req, res) => reply(res, 200, {}) }, async ({ call, seen, tokenValue }) => {
    for (const api_path of ["http://evil.example/api/v1/x", "//evil.example/api/v1/x", "/api/v1/../x", "/api/v1/%2e%2e/x", "/api/v1\\x", "/other/x"]) {
      const response = await call({ method: "GET", api_path });
      assert.equal(errorCodeOf(response), "owl_api_invalid_path", api_path);
      assert.equal(response.result.content[0].text.includes(tokenValue), false);
    }
    assert.equal(seen.length, 0);
  });
  await withOwlApi(t, { handler: (_request, _req, res) => reply(res, 200, {}), env: { OWL_GUARD_API_BASE: "http://example.com:80" } }, async ({ call, seen, tokenValue }) => {
    const response = await call({ method: "GET", api_path: "/api/v1/works" });
    assert.equal(errorCodeOf(response), "owl_api_unavailable");
    assert.equal(response.result.content[0].text.includes(tokenValue), false);
    assert.equal(seen.length, 0);
  });
});

test("owl-api does not follow a 302 and reports a dropped connection as result unknown after one request", async (t) => {
  await withOwlApi(t, { handler: (_request, _req, res) => { res.statusCode = 302; res.setHeader("location", "http://127.0.0.1:1/x"); res.end(); } }, async ({ call, seen }) => {
    const response = await call({ method: "POST", api_path: "/api/v1/works", json_body: { payload: {} } });
    assert.equal(errorCodeOf(response), "owl_api_result_unknown");
    assert.equal(seen.length, 1);
    assert.match(seen[0].body, /idempotency_key/);
  });
  await withOwlApi(t, { handler: (_request, req) => req.socket.destroy() }, async ({ call, seen }) => {
    const response = await call({ method: "GET", api_path: "/api/v1/works" });
    assert.equal(errorCodeOf(response), "owl_api_result_unknown");
    assert.equal(seen.length, 1);
  });
});

test("owl-api strips the token from JSON and text responses", async (t) => {
  await withOwlApi(t, { handler: (request, _req, res) => request.url.endsWith("/text") ? (res.end("echo api-token-xyz")) : reply(res, 200, { leak: "api-token-xyz" }) }, async ({ call, tokenValue }) => {
    for (const api_path of ["/api/v1/json", "/api/v1/text"]) {
      const response = await call({ method: "GET", api_path });
      assert.equal(response.result.content[0].text.includes(tokenValue), false, api_path);
      assert.match(response.result.content[0].text, /\[redacted\]/);
    }
  });
});

test("owl-api strips a token hidden behind JSON unicode escapes", async (t) => {
  await withOwlApi(t, { handler: (_request, _req, res) => { res.setHeader("content-type", "application/json"); res.end('{"leak":"\\u0061pi-token-xyz"}'); } }, async ({ call, tokenValue }) => {
    const response = await call({ method: "GET", api_path: "/api/v1/json" });
    assert.equal(response.result.content[0].text.includes(tokenValue), false);
    assert.match(response.result.content[0].text, /\[redacted\]/);
  });
});

test("owl-api reports an unresponsive server as result unknown after one request", async (t) => {
  await withOwlApi(t, { handler: () => {}, env: { OWL_GUARD_API_TIMEOUT_MS: "300" } }, async ({ call, seen }) => {
    const response = await call({ method: "GET", api_path: "/api/v1/works" });
    assert.equal(errorCodeOf(response), "owl_api_result_unknown");
    assert.equal(seen.length, 1);
  });
});

test("owl-dispatch ignores a JSON line that is not an object and keeps serving", async (t) => {
  await withMcp(t, {}, async ({ child, rpc }) => {
    child.stdin.write("null\n123\n");
    // The unhandled rejection of a bad line surfaces after the next ping would already be answered.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual((await rpc("ping")).result, {});
  });
});
