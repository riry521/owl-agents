import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { GuardTokenRegistry } from "../../apps/server/dist/guard-tokens.js";
import { createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

test("hook events record a Worker's subagent as an observed child and close it", async (t) => {
  const { root, db, core } = await createTestCore(t, {}, { prefix: "owl-hook-children-" });
  const guardTokens = GuardTokenRegistry.open(join(root, "guard-tokens"));
  t.after(() => guardTokens.clear());
  const api = await startTestHttpServer(t, { core, webOut: root, owlRoot: root, guardTokens }, { token: "test-owner-api-token" });
  if (!api) {
    t.skip("localhost listen is unavailable");
    return;
  }
  const { baseUrl: apiBase } = api;

  const created = await core.createWork({ request_id: createUlid(), idempotency_key: "hc-create", expected_version: 0, payload: { title: "Hook", summary: "x", size: "normal", project_id: null } });
  const workId = created.data.work_id;
  const now = new Date().toISOString();
  const workerRun = createUlid();
  const lane = db.createWriteLane();
  await lane.transact((tx) => tx.run(
    "INSERT INTO agent_runs (id, work_id, role, provider, model, status, pid, started_at, created_at, updated_at) VALUES (?, ?, 'worker', 'claude', 'm', 'running', NULL, ?, ?, ?)",
    workerRun, workId, now, now, now,
  ));

  const tokenFor = async (role, agent_run_id) => {
    const lease = guardTokens.issue({ agent_run_id, role });
    return (await readFile(lease.file, "utf8")).trim();
  };
  const post = (authorization, payload) => fetch(`${apiBase}/api/v1/subagents/hook-event`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    body: JSON.stringify({ request_id: createUlid(), idempotency_key: createUlid(), expected_version: 0, payload }),
  });
  const children = () => db.all("SELECT * FROM agent_runs WHERE parent_agent_id = ?", workerRun);
  const events = (type) => db.all("SELECT payload_json FROM events WHERE type = ?", type);
  const workerAuth = `Bearer ${await tokenFor("worker", workerRun)}`;
  const idle = [{ pid: 1, ppid: 0, args: "init" }];

  // Rejected: other roles, no token, extra hook input.
  assert.equal((await post(`Bearer ${await tokenFor("manager", workerRun)}`, { event: "start", agent_id: "a1" })).status, 403);
  assert.ok((await post(null, { event: "start", agent_id: "a1" })).status >= 400);
  assert.equal((await post(workerAuth, { event: "start", agent_id: "a1", prompt: "secret" })).status, 400);
  assert.equal(children().length, 0);

  // start, twice: one child.
  assert.equal((await post(workerAuth, { event: "start", agent_id: "a1", agent_type: "Explore" })).status, 202);
  assert.equal((await post(workerAuth, { event: "start", agent_id: "a1", agent_type: "Explore" })).status, 202);
  assert.equal(children().length, 1);
  let child = children()[0];
  assert.equal(child.role, "executor");
  assert.equal(child.origin, "observed");
  assert.equal(child.status, "running");
  assert.equal(child.label, "Explore");
  assert.equal(events("subagent.detected").length, 1);

  // The process scan does not close it.
  await core.workflow.scanSubagents(idle);
  assert.equal(children()[0].status, "running");

  // Only id and type are stored.
  const stored = JSON.stringify(children()) + JSON.stringify(events("subagent.detected"));
  assert.equal(stored.includes("secret"), false);

  // stop, twice: closed once.
  assert.equal((await post(workerAuth, { event: "stop", agent_id: "a1" })).status, 202);
  assert.equal((await post(workerAuth, { event: "stop", agent_id: "a1" })).status, 202);
  child = children()[0];
  assert.equal(child.status, "exited");
  assert.ok(child.ended_at);
  assert.equal(events("subagent.exited").length, 1);

  // Simultaneous duplicates and a stop right behind its start all succeed.
  const starts = await Promise.all([1, 2, 3].map(() => post(workerAuth, { event: "start", agent_id: "b1" })));
  const stops = await Promise.all([1, 2].map(() => post(workerAuth, { event: "stop", agent_id: "b1" })));
  assert.deepEqual([...starts, ...stops].map((r) => r.status), [202, 202, 202, 202, 202]);
  const b1 = children().filter((c) => c.hook_agent_id === "b1");
  assert.equal(b1.length, 1);
  assert.equal(b1[0].status, "exited");
  assert.equal(events("subagent.exited").length, 2);

  // A child still running after its Worker ended is closed by the scan.
  assert.equal((await post(workerAuth, { event: "start", agent_id: "a2" })).status, 202);
  await lane.transact((tx) => tx.run("UPDATE agent_runs SET status = 'completed', ended_at = ? WHERE id = ?", now, workerRun));
  await core.workflow.scanSubagents(idle);
  assert.equal(children().find((c) => c.hook_agent_id === "a2").status, "exited");
  assert.equal(events("subagent.exited").length, 3);
});
