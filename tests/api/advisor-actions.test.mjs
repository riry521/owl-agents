import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createCore as createMemoryCore, ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

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
  const root = await tempDir(t, "owl-api-advisor-actions-");
  const api = await startTestHttpServer(t, { core, webOut: root, owlRoot: root });
  if (!api) {
    t.skip("localhost listen is not permitted in this environment");
    return null;
  }
  return { base: api.baseUrl };
}

async function startAdapterServer(t) {
  const { root, db, core } = await createTestCore(t, { version: "api-advisor-actions-test", dispatcher: { tick_interval_ms: 60_000 } }, { prefix: "owl-api-advisor-actions-adapter-" });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const adapter = new ExternalCoreAdapter(core, db, root, dataDir);
  const api = await startTestHttpServer(t, { core: adapter, db, webOut: root, owlRoot: root, dataDir });
  if (!api) {
    t.skip("localhost listen is not permitted in this environment");
    return null;
  }
  return { base: api.baseUrl, core, db };
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

test("/advisor/actions executes Work operations through ExternalCoreAdapter and applies their effects", async (t) => {
  await withEnv({ OWL_API_TOKEN: undefined }, async () => {
    const server = await startAdapterServer(t);
    if (!server) return;

    const runningWorkId = (await server.core.createWork(command({ title: "Instruction target", summary: "", size: "small", project_id: null }, "create-running"))).data.work_id;
    await server.core.startWork(runningWorkId, command({ mode: "normal" }, "start-running"));
    const pausedWorkId = (await server.core.createWork(command({ title: "Resume target", summary: "", size: "small", project_id: null }, "create-paused"))).data.work_id;
    await server.db.createWriteLane().transact((transaction) => {
      transaction.run("UPDATE works SET state = 'paused', state_version = 2 WHERE id = ?", pausedWorkId);
    });

    const { response, body } = await post(server.base, "/api/v1/advisor/actions", envelope({
      invocation_id: createUlid(),
      actions: [
        action({ sequence: 1, type: "send_work_instruction", payload: { work_id: runningWorkId, body: "Add a regression test." }, expected_version: 1 }),
        action({ sequence: 2, type: "update_work", payload: { work_id: runningWorkId, title: "Advisor updated title" }, expected_version: 1 }),
        action({ sequence: 3, type: "resume_work", payload: { work_id: pausedWorkId }, expected_version: 2 }),
      ],
    }, "adapter-work-operations"));

    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body.data.results.map((result) => result.status), ["executed", "executed", "executed"], JSON.stringify(body.data.results));
    assert.ok(body.data.results.every((result) => result.error_code === null));
    assert.equal(server.db.get("SELECT body FROM messages WHERE conversation_id = (SELECT conversation_id FROM works WHERE id = ?)", runningWorkId).body, "Add a regression test.");
    assert.equal(server.core.getWork(runningWorkId).data.title, "Advisor updated title");
    assert.equal(server.core.getWork(pausedWorkId).data.state, "running");
  });
});

test("/advisor/actions rejects missing Works with work_not_found through ExternalCoreAdapter", async (t) => {
  await withEnv({ OWL_API_TOKEN: undefined }, async () => {
    const server = await startAdapterServer(t);
    if (!server) return;
    const missingWorkId = createUlid();

    const { response, body } = await post(server.base, "/api/v1/advisor/actions", envelope({
      invocation_id: createUlid(),
      actions: [
        action({ sequence: 1, type: "send_work_instruction", payload: { work_id: missingWorkId, body: "Do this." } }),
        action({ sequence: 2, type: "update_work", payload: { work_id: missingWorkId, title: "Missing" } }),
        action({ sequence: 3, type: "resume_work", payload: { work_id: missingWorkId } }),
      ],
    }, "missing-work-operations"));

    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body.data.results.map((result) => [result.status, result.error_code]), [
      ["rejected", "work_not_found"],
      ["rejected", "work_not_found"],
      ["rejected", "work_not_found"],
    ]);
  });
});

test("/advisor/actions rejects invalid payloads and state violations without changing the Work", async (t) => {
  await withEnv({ OWL_API_TOKEN: undefined }, async () => {
    const server = await startAdapterServer(t);
    if (!server) return;
    const runningWorkId = (await server.core.createWork(command({ title: "Running work", summary: "", size: "small", project_id: null }, "invalid-running"))).data.work_id;
    await server.core.startWork(runningWorkId, command({ mode: "normal" }, "invalid-start"));
    const completedWorkId = (await server.core.createWork(command({ title: "Completed work", summary: "", size: "small", project_id: null }, "invalid-completed"))).data.work_id;
    await server.db.createWriteLane().transact((transaction) => {
      transaction.run("UPDATE works SET state = 'completed', state_version = 1 WHERE id = ?", completedWorkId);
    });

    const { response, body } = await post(server.base, "/api/v1/advisor/actions", envelope({
      invocation_id: createUlid(),
      actions: [
        action({ sequence: 1, type: "send_work_instruction", payload: { work_id: runningWorkId, body: "Do this", attachment_ids: [] }, expected_version: 1 }),
        action({ sequence: 2, type: "update_work", payload: { work_id: runningWorkId }, expected_version: 1 }),
        action({ sequence: 3, type: "update_work", payload: { work_id: completedWorkId, title: "Changed" }, expected_version: 1 }),
        action({ sequence: 4, type: "send_work_instruction", payload: { work_id: completedWorkId, body: "Do this" }, expected_version: 1 }),
        action({ sequence: 5, type: "resume_work", payload: { work_id: completedWorkId }, expected_version: 1 }),
      ],
    }, "invalid-work-operations"));

    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body.data.results.map((result) => [result.status, result.error_code]), [
      ["rejected", "validation_error"],
      ["rejected", "validation_error"],
      ["rejected", "invalid_state_transition"],
      ["rejected", "work_reopen_required"],
      ["rejected", "invalid_state_transition"],
    ]);
    assert.equal(server.db.get("SELECT COUNT(*) AS count FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE work_id IN (?, ?))", runningWorkId, completedWorkId).count, 0);
    assert.equal(server.core.getWork(runningWorkId).data.title, "Running work");
    assert.equal(server.core.getWork(completedWorkId).data.title, "Completed work");
    assert.equal(server.core.getWork(completedWorkId).data.state, "completed");
  });
});
