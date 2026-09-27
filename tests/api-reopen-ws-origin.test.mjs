import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createOwlHttpServer } from "../apps/server/dist/http.js";

const WORK_ID = "01J00000000000000000000000";

function envelope(payload, key) {
  return { request_id: `req-${key}`, idempotency_key: `idem-${key}`, expected_version: 3, payload };
}

async function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeCore(calls) {
  return {
    ready: true,
    status: () => ({ services: [], mvp_scope: "test", version: "1.0.0" }),
    subscribe: () => () => {},
    eventsAfter: () => [],
    listEventsAfter: () => [],
    reopenWork: async (workId, reason) => {
      calls.push(["reopenWork", workId, reason]);
      return { data: { work_id: workId, state: "running" }, version: 4 };
    },
  };
}

async function startServer(t, core) {
  const root = await mkdtemp(join(tmpdir(), "owl-api-reopen-"));
  const http = createOwlHttpServer({
    core,
    webOut: root,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot: root,
  });
  try {
    await http.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("localhost listen is not permitted in this environment");
      return null;
    }
    throw error;
  }
  t.after(() => http.close());
  const address = http.server.address();
  return { port: address.port, base: `http://127.0.0.1:${address.port}` };
}

test("POST /works/{id}/reopen validates the payload: reason optional, non-blank, <= 1000 chars, no extra keys", async (t) => {
  await withEnv({ OWL_API_TOKEN: undefined }, async () => {
    const calls = [];
    const server = await startServer(t, fakeCore(calls));
    if (!server) return;
    const post = (payload, key) => fetch(`${server.base}/api/v1/works/${WORK_ID}/reopen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope(payload, key)),
    });

    for (const [payload, key] of [
      [{ reason: "" }, "empty"],
      [{ reason: "   " }, "blank"],
      [{ reason: 42 }, "number"],
      [{ reason: null }, "null"],
      [{ reason: "x".repeat(1001) }, "long"],
      [{ reason: "ok", force: true }, "extra"],
    ]) {
      const response = await post(payload, key);
      assert.equal(response.status, 400, key);
      assert.equal((await response.json()).error.code, "validation_error", key);
    }
    assert.deepEqual(calls, []);

    const withReason = await post({ reason: "追加の修正" }, "valid");
    assert.equal(withReason.status, 200);
    assert.deepEqual((await withReason.json()).data, { work_id: WORK_ID, state: "running" });
    const withoutReason = await post({}, "omitted");
    assert.equal(withoutReason.status, 200);
    assert.deepEqual(calls, [["reopenWork", WORK_ID, "追加の修正"], ["reopenWork", WORK_ID, ""]]);
  });
});

function upgrade(port, origin) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/api/v1/ws",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
        ...(origin ? { Origin: origin } : {}),
      },
    });
    req.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    req.on("response", (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}

test("WebSocket upgrade uses the same narrowed Origin check as HTTP writes", async (t) => {
  await withEnv({ OWL_API_TOKEN: undefined, OWL_PUBLIC_HOST: "owl-box.tail1234.ts.net" }, async () => {
    const server = await startServer(t, fakeCore([]));
    if (!server) return;
    assert.equal(await upgrade(server.port, "https://attacker.tail9999.ts.net"), 403);
    assert.equal(await upgrade(server.port, "http://evil.example"), 403);
    assert.equal(await upgrade(server.port, "https://owl-box.tail1234.ts.net"), 101);
    // Same-origin Web UI on an ephemeral port (port 0) is accepted, as for HTTP.
    assert.equal(await upgrade(server.port, server.base), 101);
    assert.equal(await upgrade(server.port, undefined), 101);
  });
});
