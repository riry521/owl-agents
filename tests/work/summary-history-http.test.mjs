import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { ExternalCoreAdapter, MemoryCore } from "../../apps/server/dist/core.js";
import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

const envelope = (payload, suffix, expectedVersion = 0) => ({
  request_id: createUlid(),
  idempotency_key: `summary-history:${suffix}:${createUlid()}`,
  expected_version: expectedVersion,
  payload,
});

// A Work whose Manager rewrites the summary on an Owner instruction, plus an untouched Work.
async function setup(t, wrap) {
  const agent = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        const prompt = String(request.prompt ?? request.input ?? JSON.stringify(request));
        const out = prompt.includes("This is a REPLAN") ? { tasks: [], updated_summary: "NEW summary", skills_used: [] } : "not json";
        return { adapter: request.adapter, stdout: typeof out === "string" ? out : JSON.stringify(out), stderr: "", exit_code: 0, signal: null, format: "plain-text" };
      },
    },
  });
  const { root, db, core } = await createTestCore(t, {
    agentRunner: { ...agent, runWorker: () => new Promise(() => {}) },
    dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 },
  }, { prefix: "owl-summary-history-http-" });
  const token = randomBytes(32).toString("hex");

  const created = await core.createWork(envelope({ title: "W", summary: "OLD summary", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  const untouched = (await core.createWork(envelope({ title: "U", summary: "same", size: "normal", project_id: null }, "create2"))).data.work_id;
  const now = new Date().toISOString();
  const run = createUlid();
  const taskId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count,
         same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
       VALUES (?, ?, 'first', 'code', 'completed', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`,
      taskId, workId, now, now,
    );
    tx.run(`INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at) VALUES (?, ?, ?, 'worker', 'anthropic', 'm', 'completed', ?, ?)`, run, workId, taskId, now, now);
    tx.run(
      `INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at)
       VALUES (?, ?, '1', 'success', ?, ?, 0, ?)`,
      createUlid(), run, JSON.stringify({ kind: "report", result: "success", work_done: "did T1" }), "0".repeat(64), now,
    );
    tx.run("UPDATE works SET state = 'paused', state_version = 1 WHERE id = ?", workId);
    return null;
  });
  const posted = await core.postWorkInstruction(workId, envelope({ body: "Add acceptance criteria" }, "post", 1));
  await core.start();
  await core.resumeWork(workId, envelope({}, "resume", db.get("SELECT state_version AS v FROM works WHERE id = ?", workId).v));
  await waitFor(() => db.get("SELECT 1 FROM work_summary_revisions WHERE work_id = ?", workId));

  const api = await startTestHttpServer(t, {
    core: wrap(core, db, root),
    db,
    webOut: root,
    owlRoot: root,
    dataDir: root,
  }, { token });
  if (!api) return null;
  const get = (path) => api.request("GET", `/api/v1${path}`);
  return { get, workId, untouched, messageId: posted.data.message_id };
}

for (const [name, wrap] of [
  ["Core directly", (core) => core],
  ["Core wrapped by ExternalCoreAdapter", (core, db, root) => new ExternalCoreAdapter(core, db, root, root)],
]) {
  test(`summary-revisions route returns the Manager rewrite (${name})`, async (t) => {
    const ctx = await setup(t, wrap);
    if (!ctx) return t.skip("localhost listen is unavailable");

    const res = await ctx.get(`/works/${ctx.workId}/summary-revisions`);
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.equal(data.work_id, ctx.workId);
    assert.equal(data.truncated, false);
    assert.equal(data.revisions.length, 1);
    const [rev] = data.revisions;
    assert.equal(rev.actor, "manager");
    assert.deepEqual(rev.before, { title: "W", summary: "OLD summary" });
    assert.deepEqual(rev.after, { title: "W", summary: "NEW summary" });
    assert.deepEqual(rev.changed_fields, ["summary"]);
    assert.equal(rev.trigger.kind, "instruction");
    assert.deepEqual(rev.trigger.message_ids, [ctx.messageId]);
    assert.equal(rev.trigger.text, "Add acceptance criteria");
    assert.ok(!Number.isNaN(Date.parse(rev.created_at)));

    assert.equal((await (await ctx.get(`/works/${ctx.workId}/summary-revisions?limit=1`)).json()).data.revisions.length, 1);
    assert.equal((await ctx.get(`/works/${ctx.workId}/summary-revisions?limit=abc`)).status, 400);
    const empty = await (await ctx.get(`/works/${ctx.untouched}/summary-revisions`)).json();
    assert.deepEqual(empty.data.revisions, []);
  });
}

test("summary-revisions route returns the Manager rewrite for MemoryCore", async (t) => {
  const root = await tempDir(t, "owl-summary-history-memory-");
  const token = randomBytes(32).toString("hex");
  const memory = new MemoryCore({ version: "test", owlRoot: root, dataDir: root });
  const api = await startTestHttpServer(t, { core: memory, webOut: root, owlRoot: root, dataDir: root }, { token });
  if (!api) return t.skip("localhost listen is unavailable");
  const created = await memory.createWork({ title: "W", summary: "OLD summary", size: "normal", project_id: null }, envelope({}, "create"));
  const workId = created.data.work_id;
  const get = () => api.request("GET", `/api/v1/works/${workId}/summary-revisions`);
  assert.deepEqual((await (await get()).json()).data, { work_id: workId, truncated: false, revisions: [] });

  memory.applyManagerWorkSummary(workId, "NEW summary", { kind: "instruction", message_ids: ["m1"], text: "Add acceptance criteria" }, "run1");
  const res = await get();
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.work_id, workId);
  assert.equal(data.truncated, false);
  assert.equal(data.revisions.length, 1);
  const [rev] = data.revisions;
  assert.equal(rev.actor, "manager");
  assert.equal(rev.agent_run_id, "run1");
  assert.deepEqual(rev.before, { title: "W", summary: "OLD summary" });
  assert.deepEqual(rev.after, { title: "W", summary: "NEW summary" });
  assert.deepEqual(rev.changed_fields, ["summary"]);
  assert.equal(rev.trigger.kind, "instruction");
  assert.deepEqual(rev.trigger.message_ids, ["m1"]);
  assert.equal(rev.trigger.text, "Add acceptance criteria");
  assert.ok(!Number.isNaN(Date.parse(rev.created_at)));
});

test("summary-revisions route answers 503 dependency_unavailable when Core lacks the method", async (t) => {
  const ctx = await setup(t, (core, db, root) => {
    const adapter = new ExternalCoreAdapter(core, db, root, root);
    adapter.core = {};
    return adapter;
  });
  if (!ctx) return t.skip("localhost listen is unavailable");
  const res = await ctx.get(`/works/${ctx.workId}/summary-revisions`);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "dependency_unavailable");
});
