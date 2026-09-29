import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createOwlHttpServer, isAllowedOrigin } from "../apps/server/dist/http.js";

const ULID = "01J00000000000000000000000";

function envelope(payload, key = "k") {
  return { request_id: `req-${key}`, idempotency_key: `idem-${key}`, expected_version: 0, payload };
}

function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === "function") return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

async function startServer(t, core) {
  const root = await mkdtemp(join(tmpdir(), "owl-api-csrf-"));
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
  const port = typeof address === "object" && address ? address.port : 0;
  return { http, port, base: `http://127.0.0.1:${port}` };
}

function fakeCore(calls) {
  return {
    ready: true,
    status: () => ({ services: [], mvp_scope: "test", version: "1.0.0" }),
    subscribe: () => () => {},
    eventsAfter: () => [],
    getAdvisorPersona: async () => "",
    setAdvisorPersona: async (value) => {
      calls.push(["setAdvisorPersona", value]);
      return value;
    },
    getActiveConversation: async () => ({ conversation_id: ULID }),
    postMessage: async (...args) => {
      calls.push(["postMessage", ...args]);
      return { data: { message_id: ULID }, version: 0 };
    },
    putInboundUpload: async (ownerId, uploadId, content) => {
      calls.push(["putInboundUpload", uploadId, content.mime]);
      return { upload_id: uploadId, status: "stored" };
    },
    memorySaver: { saveManualSnapshot: async () => "", saveExplicitMemory: async () => "" },
    runCuration: async () => {
      calls.push(["librarian.run"]);
      return { id: "run", status: "succeeded", summary: "", error: null, report: {} };
    },
    listCurationRuns: () => ({ items: [], next_cursor: null }),
    getCurationRun: () => null,
  };
}

test("CSRF: a text/plain (no-cors simple) POST body is rejected with 415 before any side effect", async (t) => {
  await withEnv({ OWL_API_TOKEN: undefined }, async () => {
    const calls = [];
    const server = await startServer(t, fakeCore(calls));
    if (!server) return;
    for (const [method, path, body] of [
      ["POST", "/api/v1/messages", JSON.stringify({ text: "delete everything" })],
      ["PUT", "/api/v1/settings/advisor-persona", JSON.stringify(envelope({ advisor_persona: "evil" }))],
      ["POST", "/api/v1/works", JSON.stringify(envelope({ title: "x", summary: "y", size: "small", project_id: null }))],
      ["POST", "/api/v1/advisor/actions", JSON.stringify(envelope({}))],
    ]) {
      const response = await fetch(`${server.base}${path}`, {
        method,
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body,
      });
      assert.equal(response.status, 415, `${method} ${path} must reject text/plain`);
      const json = await response.json();
      assert.equal(json.error.code, "unsupported_media_type");
    }
    // A form-encoded body is also a CORS-safelisted content type.
    const form = await fetch(`${server.base}/api/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "text=hi",
    });
    assert.equal(form.status, 415);
    // Missing content type entirely is refused too.
    const missing = await fetch(`${server.base}/api/v1/messages`, {
      method: "POST",
      body: new Uint8Array(Buffer.from(JSON.stringify({ text: "hi" }))),
    });
    assert.equal(missing.status, 415);
    assert.deepEqual(calls, []);
  });
});

test("CSRF: a foreign Origin or Sec-Fetch-Site: cross-site is rejected for every state-changing request", async (t) => {
  await withEnv({ OWL_API_TOKEN: undefined, OWL_PUBLIC_HOST: undefined }, async () => {
    const calls = [];
    const server = await startServer(t, fakeCore(calls));
    if (!server) return;
    const json = { "content-type": "application/json" };
    const foreign = await fetch(`${server.base}/api/v1/settings/advisor-persona`, {
      method: "PUT",
      headers: { ...json, origin: "http://evil.example" },
      body: JSON.stringify(envelope({ advisor_persona: "evil" }, "foreign")),
    });
    assert.equal(foreign.status, 403);
    assert.equal((await foreign.json()).error.code, "forbidden");

    const nullOrigin = await fetch(`${server.base}/api/v1/settings/advisor-persona`, {
      method: "PUT",
      headers: { ...json, origin: "null" },
      body: JSON.stringify(envelope({ advisor_persona: "evil" }, "null-origin")),
    });
    assert.equal(nullOrigin.status, 403);

    const crossSite = await fetch(`${server.base}/api/v1/settings/advisor-persona`, {
      method: "PUT",
      headers: { ...json, "sec-fetch-site": "cross-site" },
      body: JSON.stringify(envelope({ advisor_persona: "evil" }, "cross-site")),
    });
    assert.equal(crossSite.status, 403);

    // Body-less POST routes are protected by the same Origin check.
    const librarian = await fetch(`${server.base}/api/v1/librarian/run`, {
      method: "POST",
      headers: { origin: "http://evil.example" },
    });
    assert.equal(librarian.status, 403);
    assert.deepEqual(calls, []);

    // Same-origin browser requests from the Web UI and non-browser clients (no Origin) keep working.
    const sameOrigin = await fetch(`${server.base}/api/v1/settings/advisor-persona`, {
      method: "PUT",
      headers: { ...json, origin: server.base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify(envelope({ advisor_persona: "friendly" }, "same")),
    });
    assert.equal(sameOrigin.status, 200);
    const cli = await fetch(`${server.base}/api/v1/settings/advisor-persona`, {
      method: "PUT",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(envelope({ advisor_persona: "cli" }, "cli")),
    });
    assert.equal(cli.status, 200);
    const bodyless = await fetch(`${server.base}/api/v1/librarian/run`, { method: "POST", headers: { origin: server.base } });
    assert.equal(bodyless.status, 200);
    assert.deepEqual(calls, [["setAdvisorPersona", "friendly"], ["setAdvisorPersona", "cli"], ["librarian.run"]]);

    // GET stays readable for same-origin navigation and is not subject to the write checks.
    const get = await fetch(`${server.base}/api/v1/system/status`, { headers: { "sec-fetch-site": "none" } });
    assert.equal(get.status, 200);
  });
});

test("CSRF: binary upload content keeps its own media type and is not forced to JSON", async (t) => {
  await withEnv({ OWL_API_TOKEN: undefined }, async () => {
    const calls = [];
    const server = await startServer(t, fakeCore(calls));
    if (!server) return;
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const digest = createHash("sha256").update(bytes).digest("base64");
    const response = await fetch(`${server.base}/api/v1/inbound/uploads/${ULID}/content`, {
      method: "PUT",
      headers: { "content-type": "image/png", digest: `sha-256=${digest}` },
      body: bytes,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [["putInboundUpload", ULID, "image/png"]]);

    const crossSite = await fetch(`${server.base}/api/v1/inbound/uploads/${ULID}/content`, {
      method: "PUT",
      headers: { "content-type": "image/png", digest: `sha-256=${digest}`, origin: "http://evil.example" },
      body: bytes,
    });
    assert.equal(crossSite.status, 403);
    assert.equal(calls.length, 1);
  });
});

test("isAllowedOrigin pins Tailscale origins to OWL_PUBLIC_HOST when it is configured", () => {
  const context = { bind: "127.0.0.1", port: 3787 };
  withEnv({ OWL_PUBLIC_HOST: "owl-box.tail1234.ts.net" }, () => {
    assert.equal(isAllowedOrigin("https://owl-box.tail1234.ts.net", context), true);
    assert.equal(isAllowedOrigin("http://owl-box.tail1234.ts.net:3787", context), true);
    assert.equal(isAllowedOrigin("https://attacker.tail9999.ts.net", context), false);
    assert.equal(isAllowedOrigin("http://127.0.0.1:3787", context), true);
    assert.equal(isAllowedOrigin("http://evil.example", context), false);
  });
  withEnv({ OWL_PUBLIC_HOST: undefined }, () => {
    // Legacy fallback without a configured public host: any HTTPS *.ts.net origin.
    assert.equal(isAllowedOrigin("https://owl-box.tail1234.ts.net", context), true);
    assert.equal(isAllowedOrigin("http://evil.example", context), false);
    assert.equal(isAllowedOrigin("https://evil-ts.net", context), false);
    assert.equal(isAllowedOrigin("null", context), false);
    assert.equal(isAllowedOrigin(undefined, context), true);
  });
});
