import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createOwlHttpServer } from "../apps/server/dist/http.js";
import { createCore as createMemoryCore } from "../apps/server/dist/core.js";
import { createUlid } from "../packages/db/dist/index.js";

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
  const root = await mkdtemp(join(tmpdir(), "owl-api-advisor-actions-"));
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
  return { base: `http://127.0.0.1:${port}` };
}

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function action(overrides) {
  return { action_id: createUlid(), sequence: 1, type: "start_work", payload: {}, expected_version: 0, ...overrides };
}

test("/advisor/actions honors each action's own expected_version instead of a batch-wide one", async (t) => {
  await withEnv({ OWL_API_TOKEN: undefined }, async () => {
    const core = createMemoryCore({ version: "1.0.0", agentRunner: { start: async () => {} } });
    const server = await startServer(t, core);
    if (!server) return;

    const created = await post(server.base, "/api/v1/works", envelope({ title: "Batch actions", summary: "", size: "normal", project_id: null }, "create"));
    assert.equal(created.response.status, 201);
    const workId = created.body.data.work_id;
    assert.equal(created.body.data.state_version, 0);

    // start_work needs expected_version 0 (the Work's current version); the
    // pause_work that follows in the same batch needs expected_version 1,
    // the version start_work leaves behind. A batch-wide expected_version
    // could satisfy at most one of these.
    const { response, body } = await post(server.base, "/api/v1/advisor/actions", envelope({
      invocation_id: createUlid(),
      actions: [
        action({ sequence: 1, type: "start_work", payload: { work_id: workId }, expected_version: 0 }),
        action({ sequence: 2, type: "pause_work", payload: { work_id: workId }, expected_version: 1 }),
      ],
    }, "batch"));

    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body.data.results.map((result) => result.status), ["executed", "executed"], JSON.stringify(body.data.results));
    assert.equal(body.data.results[0].error_code, null);
    assert.equal(body.data.results[1].error_code, null);

    const detail = await fetch(`${server.base}/api/v1/works/${workId}`);
    const detailBody = await detail.json();
    assert.equal(detailBody.data.state, "paused");
    assert.equal(detailBody.data.state_version, 2);
  });
});

test("/advisor/actions rejects the whole batch when an action omits expected_version", async (t) => {
  await withEnv({ OWL_API_TOKEN: undefined }, async () => {
    const core = createMemoryCore({ version: "1.0.0", agentRunner: { start: async () => {} } });
    const server = await startServer(t, core);
    if (!server) return;

    const raw = { action_id: createUlid(), sequence: 1, type: "start_work", payload: {} };
    const { response, body } = await post(server.base, "/api/v1/advisor/actions", envelope({
      invocation_id: createUlid(),
      actions: [raw],
    }, "missing-version"));

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "validation_error");
  });
});
