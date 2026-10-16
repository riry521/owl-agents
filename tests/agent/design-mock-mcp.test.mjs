import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { tempDir } from "../helpers/temp.mjs";

const serverPath = fileURLToPath(new URL("../../apps/server/dist/design-mock-mcp.js", import.meta.url));

async function withMcp(t, { handler, env = {} }, run) {
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
  const dir = await tempDir(t, "owl-design-mcp-");
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, "token-one\n");
  const child = spawn(process.execPath, [serverPath], {
    env: {
      PATH: process.env.PATH ?? "",
      OWL_ROLE: "designer",
      OWL_AGENT_RUN_ID: "run-1",
      OWL_GUARD_TOKEN_FILE: tokenFile,
      OWL_GUARD_API_BASE: `http://127.0.0.1:${http.address().port}`,
      ...env,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = new Map();
  let childExit;
  const childClosed = new Promise((resolve) => child.once("exit", (code) => {
    childExit = code;
    for (const call of pending.values()) call.reject(new Error(`MCP process exited with ${code}`));
    pending.clear();
    resolve();
  }));
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
    await run({ rpc, seen });
  } finally {
    if (childExit === undefined) child.kill();
    await childClosed;
    await new Promise((resolve) => http.close(resolve));
  }
}

function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

test("owl-design lists both tools and sends Bearer-authenticated envelopes to the agent routes", async (t) => {
  await withMcp(t, {
    handler: (request, _req, res) => reply(res, 200, { data: request.url.endsWith("/delete") ? { deleted: true } : { size_bytes: 9 } }),
  }, async ({ rpc, seen }) => {
    assert.equal((await rpc("initialize")).result.protocolVersion, "2024-11-05");
    const listed = (await rpc("tools/list")).result.tools;
    assert.deepEqual(listed.map((tool) => tool.name), ["save_design_mock", "delete_design_mock"]);
    assert.deepEqual(listed[0].inputSchema.required, ["name", "html"]);
    assert.deepEqual(listed[1].inputSchema.required, ["name"]);

    const saved = await rpc("tools/call", { name: "save_design_mock", arguments: { name: "top.html", html: "<p>top</p>" } });
    assert.notEqual(saved.result.isError, true);
    const deleted = await rpc("tools/call", { name: "delete_design_mock", arguments: { name: "top.html" } });
    assert.notEqual(deleted.result.isError, true);

    assert.deepEqual(seen.map((item) => item.url), ["/api/v1/agent/design-mocks", "/api/v1/agent/design-mocks/delete"]);
    assert.deepEqual(seen.map((item) => item.authorization), ["Bearer token-one", "Bearer token-one"]);
    for (const item of seen) {
      assert.equal(item.body.expected_version, 0);
      assert.equal(item.body.request_id, item.body.idempotency_key);
    }
    assert.deepEqual(seen[0].body.payload, { name: "top.html", html: "<p>top</p>" });
    assert.deepEqual(seen[1].body.payload, { name: "top.html" });
  });
});

test("owl-design returns an HTTP error as a tool error", async (t) => {
  await withMcp(t, {
    handler: (_request, _req, res) => reply(res, 403, { error: { code: "agent_scope_denied", message: "not a screen design Task" } }),
  }, async ({ rpc }) => {
    await rpc("initialize");
    const result = (await rpc("tools/call", { name: "save_design_mock", arguments: { name: "top.html", html: "<p>x</p>" } })).result;
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, "agent_scope_denied");
  });
});

test("owl-design is unavailable unless OWL_ROLE is designer", async (t) => {
  await withMcp(t, { env: { OWL_ROLE: "worker" } }, async ({ rpc, seen }) => {
    await rpc("initialize");
    const result = (await rpc("tools/call", { name: "save_design_mock", arguments: { name: "top.html", html: "<p>x</p>" } })).result;
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, "owl_design_unavailable");
    assert.equal(seen.length, 0);
  });
});
