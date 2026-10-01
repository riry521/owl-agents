import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { createAgentRunner } from "../packages/agent-runtime/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

// An Owner instruction is "queued" until the Manager takes it, "processing"
// while the Manager replans, then "answered" by a Manager reply message whose
// outcome says what happened. Old markers and messages carry no state.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const envelope = (payload, suffix, expectedVersion = 0) => ({
  request_id: createUlid(),
  idempotency_key: `instruction-status:${suffix}:${createUlid()}`,
  expected_version: expectedVersion,
  payload,
});

const task = (id, title) => ({ id, title, type: "code", acceptance: "Done.", depends_on: [], context: "", notes: "", review: null, replaces: [] });

async function waitFor(read, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A Core whose Manager answers every replan with `answer(core, workId)`; Workers never run. */
async function setup(t, answer) {
  const root = await mkdtemp(join(tmpdir(), "owl-instruction-status-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const ref = { core: null, workId: null };  const agent = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        const prompt = String(request.prompt ?? request.input ?? JSON.stringify(request));
        const out = prompt.includes("This is a REPLAN") ? await answer(ref) : "not json";
        return { adapter: request.adapter, stdout: typeof out === "string" ? out : JSON.stringify(out), stderr: "", exit_code: 0, signal: null, format: "plain-text" };
      },
    },
  });
  const core = new Core({
    db,
    agentRunner: { ...agent, runWorker: () => new Promise(() => {}) },
    version: "test",
    owlRoot: root,
    dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 },
  });
  ref.core = core;
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });
  const created = await core.createWork(envelope({ title: "W", summary: "x", size: "normal", project_id: null }, "create"));
  ref.workId = created.data.work_id;
  return { db, core, ref, root };
}

/** A running Work whose only Task is completed, so the next tick consumes an Owner replan. */
async function seedCompletedTask(db, workId) {
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
    tx.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
       VALUES (?, ?, ?, 'worker', 'anthropic', 'm', 'completed', ?, ?)`,
      run, workId, taskId, now, now,
    );
    tx.run(
      `INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at)
       VALUES (?, ?, '1', 'success', ?, ?, 0, ?)`,
      createUlid(), run, JSON.stringify({ kind: "report", result: "success", work_done: "did T1" }), "0".repeat(64), now,
    );
    tx.run("UPDATE works SET state = 'paused', state_version = 1 WHERE id = ?", workId);
    return null;
  });
}

const marker = (db, workId) => {
  const row = db.get("SELECT response_json FROM idempotency_keys WHERE key = ?", `owner-replan:${workId}`);
  return row ? JSON.parse(row.response_json) : null;
};

const instructionOf = (core, workId, messageId) => core.getWorkConversation(workId, { limit: 100 }).messages.find((m) => m.id === messageId);

/** Post an instruction to a paused Work (nothing consumes it), then let the Manager run by resuming. */
async function postWhilePaused(core, db, ref, body = "Add docs") {
  await seedCompletedTask(db, ref.workId);
  const posted = await core.postWorkInstruction(ref.workId, envelope({ body }, "post", 1));
  return posted.data.message_id;
}

async function resume(core, db, workId) {
  const version = db.get("SELECT state_version AS v FROM works WHERE id = ?", workId).v;
  await core.start();
  await core.resumeWork(workId, envelope({}, "resume", version));
}

test("the marker collects message ids; the instruction goes queued -> processing -> answered (no_change)", async (t) => {
  const seen = [];
  const { db, core, ref } = await setup(t, ({ core: c, workId }) => {
    seen.push(c.getWorkConversation(workId, {}).messages.map((m) => m.instruction?.status ?? null));
    return { tasks: [] };
  });
  const first = await postWhilePaused(core, db, ref, "Add docs");
  const second = (await core.postWorkInstruction(ref.workId, envelope({ body: "And tests" }, "second", 1))).data.message_id;
  assert.deepEqual(marker(db, ref.workId).message_ids, [first, second]);
  assert.equal(instructionOf(core, ref.workId, first).instruction.status, "queued");

  await resume(core, db, ref.workId);
  const reply = await waitFor(() => core.getWorkConversation(ref.workId, {}).messages.find((m) => m.source === "manager"));
  assert.ok(reply, "the Manager replied");
  assert.deepEqual(seen[0], ["processing", "processing"], "the marker was attempted while the Manager worked");
  assert.equal(marker(db, ref.workId), null, "the marker is gone with the reply");
  assert.deepEqual(reply.in_reply_to, [first, second]);
  assert.equal(reply.instruction, null);
  const row = db.get("SELECT source_message_id, metadata_json FROM messages WHERE id = ?", reply.id);
  assert.match(row.source_message_id, /^manager:/);
  assert.equal(JSON.parse(row.metadata_json).outcome, "no_change");
  for (const id of [first, second]) {
    assert.deepEqual(instructionOf(core, ref.workId, id).instruction, { status: "answered", outcome: "no_change", reply_message_id: reply.id });
  }
});

test("an applied replan answers with tasks_changed naming the added Task", async (t) => {
  const { db, core, ref } = await setup(t, () => ({ tasks: [task("N1", "Write the docs")] }));
  const id = await postWhilePaused(core, db, ref);
  await resume(core, db, ref.workId);
  const reply = await waitFor(() => core.getWorkConversation(ref.workId, {}).messages.find((m) => m.source === "manager"));
  assert.ok(reply);
  assert.match(reply.body, /Write the docs/);
  assert.equal(JSON.parse(db.get("SELECT metadata_json FROM messages WHERE id = ?", reply.id).metadata_json).outcome, "tasks_changed");
  assert.equal(instructionOf(core, ref.workId, id).instruction.outcome, "tasks_changed");
  assert.equal(marker(db, ref.workId), null);
});

test("a failed replan opens a Decision and answers with decision_opened; a requeue makes it queued again", async (t) => {
  const { db, core, ref } = await setup(t, () => "not json");
  const id = await postWhilePaused(core, db, ref);
  await resume(core, db, ref.workId);
  const reply = await waitFor(() => core.getWorkConversation(ref.workId, {}).messages.find((m) => m.source === "manager"));
  assert.ok(reply);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND status = 'open'", ref.workId).n, 1);
  assert.equal(instructionOf(core, ref.workId, id).instruction.outcome, "decision_opened");
  assert.equal(marker(db, ref.workId).status, "attempted", "the marker stays for recovery");

  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE idempotency_keys SET response_json = json_set(response_json, '$.status', 'queued') WHERE key = ?", `owner-replan:${ref.workId}`);
    return null;
  });
  assert.equal(instructionOf(core, ref.workId, id).instruction.status, "queued");
});

test("an instruction sent while the Manager handles another stays queued and the first stays processing", async (t) => {
  let during = null;
  let first = null;
  let second = null;
  const { db, core, ref } = await setup(t, async ({ core: c, workId }) => {
    if (during) return { tasks: [] };
    const version = db.get("SELECT state_version AS v FROM works WHERE id = ?", workId).v;
    second = (await c.postWorkInstruction(workId, envelope({ body: "And tests" }, "second", version))).data.message_id;
    const status = (id) => instructionOf(c, workId, id).instruction?.status ?? null;
    during = [status(first), status(second)];
    return { tasks: [] };
  });
  first = await postWhilePaused(core, db, ref, "Add docs");
  await resume(core, db, ref.workId);
  assert.ok(await waitFor(() => instructionOf(core, ref.workId, first).instruction?.status === "answered"), "the first instruction is answered");
  assert.deepEqual(during, ["processing", "queued"]);
  assert.ok(await waitFor(() => instructionOf(core, ref.workId, second).instruction?.status === "answered"));
});

test("old markers and messages without ids or metadata carry no instruction state", async (t) => {
  const { db, core, ref } = await setup(t, () => ({ tasks: [] }));
  const id = await postWhilePaused(core, db, ref);
  await db.createWriteLane().transact((tx) => {
    tx.run(
      "UPDATE idempotency_keys SET response_json = json_remove(response_json, '$.message_ids') WHERE key = ?",
      `owner-replan:${ref.workId}`,
    );
    return null;
  });
  const conversation = core.getWorkConversation(ref.workId, {});
  assert.equal(conversation.messages.find((m) => m.id === id).instruction, null);
  assert.equal(core.getWorkConversation(ref.workId, { limit: 1 }).truncated, false);
  assert.throws(() => core.getWorkConversation("missing", {}), { code: "work_not_found" });
});

test("pausing the Work while the Manager handles A requeues A and B; both end answered, none stuck processing", async (t) => {
  let calls = 0;
  const version = (workId) => db.get("SELECT state_version AS v FROM works WHERE id = ?", workId).v;
  const { db, core, ref } = await setup(t, async ({ core: c, workId }) => {
    if (calls++ > 0) return { tasks: [] };
    await c.postWorkInstruction(workId, envelope({ body: "And tests" }, "second", version(workId)));
    await c.pauseWork(workId, envelope({}, "pause", version(workId)));
    return { tasks: [] };
  });
  const first = await postWhilePaused(core, db, ref, "Add docs");
  await resume(core, db, ref.workId);
  assert.ok(await waitFor(() => calls > 0 && db.get("SELECT state FROM works WHERE id = ?", ref.workId).state === "paused"), "paused during the first replan");
  await resume(core, db, ref.workId);
  const ids = () => core.getWorkConversation(ref.workId, {}).messages.filter((m) => m.source !== "manager").map((m) => m.id);
  assert.ok(
    await waitFor(() => ids().length === 2 && ids().every((id) => instructionOf(core, ref.workId, id).instruction?.status === "answered")),
    "A and B are both answered",
  );
  assert.ok(ids().includes(first));
  assert.equal(marker(db, ref.workId), null);
});

/** A fresh Core on the same database file, as after a process restart. */
function restartedCore(t, root, answer) {
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const agent = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        const prompt = String(request.prompt ?? request.input ?? JSON.stringify(request));
        const out = prompt.includes("This is a REPLAN") ? answer(prompt) : "not json";
        return { adapter: request.adapter, stdout: typeof out === "string" ? out : JSON.stringify(out), stderr: "", exit_code: 0, signal: null, format: "plain-text" };
      },
    },
  });
  const core = new Core({ db, agentRunner: { ...agent, runWorker: () => new Promise(() => {}) }, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 } });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });
  return { db, core };
}

test("a crash while the Manager handles A with B queued: after restart A and B are both answered in one replan", async (t) => {
  let second = null;
  const { db, core, ref, root } = await setup(t, async ({ core: c, workId }) => {
    const version = db.get("SELECT state_version AS v FROM works WHERE id = ?", workId).v;
    second = (await c.postWorkInstruction(workId, envelope({ body: "And tests" }, "second", version))).data.message_id;
    return new Promise(() => {}); // the process dies while the Manager is working
  });
  const first = await postWhilePaused(core, db, ref, "Add docs");
  await resume(core, db, ref.workId);
  assert.ok(await waitFor(() => second && marker(db, ref.workId)?.processing_message_ids?.includes(first)), "A was set aside and B queued");
  // No core.stop(): the old Core is simply abandoned.
  const prompts = [];
  const next = restartedCore(t, root, (prompt) => (prompts.push(prompt), { tasks: [] }));
  await next.core.start();
  assert.ok(
    await waitFor(() => [first, second].every((id) => instructionOf(next.core, ref.workId, id)?.instruction?.status === "answered")),
    "A and B are both answered by the restarted Core",
  );
  assert.equal(prompts.length, 1, "one replan handled both");
  assert.ok(prompts[0].includes("Add docs") && prompts[0].includes("And tests"));
  assert.equal(marker(next.db, ref.workId), null);
});

test("after a restart an already answered A is not reprocessed; only B is", async (t) => {
  const { db, core, ref, root } = await setup(t, () => ({ tasks: [] }));
  const first = await postWhilePaused(core, db, ref, "Add docs");
  await resume(core, db, ref.workId);
  assert.ok(await waitFor(() => instructionOf(core, ref.workId, first).instruction?.status === "answered"));
  const version = db.get("SELECT state_version AS v FROM works WHERE id = ?", ref.workId).v;
  const second = (await core.postWorkInstruction(ref.workId, envelope({ body: "And tests" }, "second", version))).data.message_id;
  await db.createWriteLane().transact((tx) => {
    tx.run(
      "UPDATE idempotency_keys SET response_json = json_set(response_json, '$.status', 'queued', '$.processing_answer', 'Add docs', '$.processing_kind', 'instruction', '$.processing_message_ids', json_array(?)) WHERE key = ?",
      first,
      `owner-replan:${ref.workId}`,
    );
    return null;
  });
  await core.stop({ force: true });
  const prompts = [];
  const next = restartedCore(t, root, (prompt) => (prompts.push(prompt), { tasks: [] }));
  await next.core.start();
  assert.ok(await waitFor(() => instructionOf(next.core, ref.workId, second)?.instruction?.status === "answered"));
  assert.equal(prompts.length, 1);
  assert.ok(!prompts[0].includes("Add docs"), "A is not handled again");
  assert.equal(marker(next.db, ref.workId), null);
  assert.equal(next.core.getWorkConversation(ref.workId, {}).messages.filter((m) => m.source === "manager").length, 2);
});
