import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemoryCore, ExternalCoreAdapter } from "../apps/server/dist/core.js";
import { createOwlHttpServer } from "../apps/server/dist/http.js";

async function startServer(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-api-knowledge-automation-"));
  const priorToken = process.env.OWL_API_TOKEN;
  const token = "test-knowledge-automation-token";
  process.env.OWL_API_TOKEN = token;
  const core = new MemoryCore({ version: "test" });
  const calls = [];
  core.librarian = { run: async () => { calls.push("run"); return { ok: true }; } };
  const http = createOwlHttpServer({
    core,
    webOut: root,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot: root,
  });
  let listening = false;
  t.after(async () => {
    if (listening) await http.close();
    await rm(root, { recursive: true, force: true });
    if (priorToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = priorToken;
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
  listening = true;
  const address = http.server.address();
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return {
    base,
    calls,
    get: (authorized = true) => fetch(`${base}/settings/knowledge-automation`, { headers: authorized ? headers : {} }),
    put: (payload, key, options = {}) => fetch(`${base}/settings/knowledge-automation`, {
      method: "PUT",
      headers: { ...headers, ...options.headers },
      body: JSON.stringify({
        request_id: `knowledge-automation-${key}`,
        idempotency_key: `knowledge-automation:${key}`,
        expected_version: 0,
        payload,
      }),
    }),
    postLibrarian: () => fetch(`${base}/librarian/run`, { method: "POST", headers }),
  };
}

test("knowledge automation settings GET defaults and PUT round-trips through MemoryCore", async (t) => {
  const api = await startServer(t);
  if (!api) return;

  const initial = await api.get();
  assert.equal(initial.status, 200);
  const initialBody = await initial.json();
  assert.equal(typeof initialBody.request_id, "string");
  assert.equal(initialBody.version, 0);
  const initialData = initialBody.data;
  assert.deepEqual(initialData, {
    librarian_times: ["03:00", "15:00"],
    research_autosave: true,
    next_librarian_run_at: null,
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
  });

  const updated = await api.put({ librarian_times: ["19:15", "08:30"], research_autosave: false }, "roundtrip");
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json();
  assert.equal(typeof updatedBody.request_id, "string");
  assert.equal(updatedBody.version, 0);
  assert.deepEqual(updatedBody.data, {
    librarian_times: ["08:30", "19:15"],
    research_autosave: false,
    next_librarian_run_at: null,
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
  });

  const readBack = await api.get();
  assert.deepEqual((await readBack.json()).data, updatedBody.data);
});

test("knowledge automation settings reject invalid payloads, require Owner and retain manual librarian runs", async (t) => {
  const api = await startServer(t);
  if (!api) return;

  const unauthorized = await api.get(false);
  assert.equal(unauthorized.status, 401);

  const invalidPayloads = [
    { librarian_times: ["9:00"], research_autosave: true },
    { librarian_times: Array.from({ length: 25 }, (_, hour) => `01:${String(hour).padStart(2, "0")}`), research_autosave: true },
    { librarian_times: ["03:00"], research_autosave: true, extra: "key" },
    { librarian_times: ["03:00"], research_autosave: "true" },
  ];
  for (const [index, payload] of invalidPayloads.entries()) {
    const response = await api.put(payload, `invalid-${index}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "validation_error");
  }

  const csrf = await api.put(
    { librarian_times: [], research_autosave: true },
    "csrf",
    { headers: { origin: "http://evil.example" } },
  );
  assert.equal(csrf.status, 403);

  const manual = await api.postLibrarian();
  assert.equal(manual.status, 200);
  assert.deepEqual(await manual.json(), { report: { ok: true } });
  assert.deepEqual(api.calls, ["run"]);
});

test("ExternalCoreAdapter keeps knowledge automation settings in its in-memory fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-core-knowledge-automation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const external = {
    subscribe: () => () => {},
    status: () => ({ services: [], mvp_scope: "test", version: "test" }),
    start: async () => {},
    stop: async () => {},
  };
  const adapter = new ExternalCoreAdapter(external, null, root, root);
  assert.deepEqual((await adapter.getKnowledgeAutomationSettings()).librarian_times, ["03:00", "15:00"]);
  await adapter.setKnowledgeAutomationSettings({ librarian_times: [], research_autosave: false });
  assert.deepEqual(await adapter.getKnowledgeAutomationSettings(), {
    librarian_times: [],
    research_autosave: false,
    next_librarian_run_at: null,
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
  });
});
