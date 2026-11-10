import assert from "node:assert/strict";
import test from "node:test";
import { openTestDatabase } from "../helpers/db.mjs";
import {
  AGENT_RUN_TRANSITIONS,
  isAgentRunTransitionAllowed,
  recordAgentRunProcess,
  requestAgentRunCancel,
  requestStopOfAgentRuns,
  setAgentRunStatus,
} from "../../packages/core/dist/agent-run-state.js";

// Spec: agent_runs.status changes only along AGENT_RUN_TRANSITIONS; a rejected change leaves the row as it was.

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";

async function fixture(t, status) {
  const { db } = await openTestDatabase(t, { prefix: "owl-agent-run-state-" });
  const lane = db.createWriteLane();
  await lane.transact((q) => {
    q.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", NOW, NOW);
    q.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES ('W1', 'owner:default', NULL, 'W', '', 'normal', 'running', '[]', '[]', ?, ?)`, NOW, NOW,
    );
    q.run(
      `INSERT INTO agent_runs (id, work_id, role, provider, model, status, created_at, updated_at)
       VALUES ('R1', 'W1', 'worker', 'claude', 'm', ?, ?, ?)`, status, NOW, NOW,
    );
  });
  const row = () => db.get("SELECT status, ended_at, updated_at, pid FROM agent_runs WHERE id = 'R1'");
  return { lane, row };
}

test("a terminal run is never moved back to running or cancel_requested", async (t) => {
  for (const ended of ["completed", "failed", "cancelled", "exited", "spawn_failed"]) {
    assert.equal(isAgentRunTransitionAllowed(ended, "running"), false, ended);
  }
  for (const ended of ["completed", "failed", "cancelled", "spawn_failed"]) {
    assert.equal(isAgentRunTransitionAllowed(ended, "cancel_requested"), false, ended);
  }
  // The Owner can still cancel an exited run.
  assert.equal(isAgentRunTransitionAllowed("exited", "cancel_requested"), true);
  assert.equal(isAgentRunTransitionAllowed("exited", "cancelled"), true);
  const { lane, row } = await fixture(t, "cancelled");
  const before = row();
  let changes = 0;
  await lane.transact((q) => {
    changes += setAgentRunStatus(q, "R1", "running", { now: LATER });
    changes += requestAgentRunCancel(q, "R1", false, LATER);
  });
  assert.equal(changes, 0);
  assert.deepEqual(row(), before);
});

test("the `from` list narrows the table and a state outside it is rejected", async (t) => {
  const { lane, row } = await fixture(t, "cancel_requested");
  const before = row();
  let changes = -1;
  await lane.transact((q) => { changes = setAgentRunStatus(q, "R1", "failed", { now: LATER, from: ["launch_pending", "spawned", "running"] }); });
  assert.equal(changes, 0);
  assert.deepEqual(row(), before);
});

test("allowed transitions are applied with ended_at and updated_at", async (t) => {
  const { lane, row } = await fixture(t, "running");
  let changes = 0;
  await lane.transact((q) => { changes = setAgentRunStatus(q, "R1", "completed", { now: LATER, outcome: "success" }); });
  assert.equal(changes, 1);
  assert.deepEqual({ ...row() }, { status: "completed", ended_at: LATER, updated_at: LATER, pid: null });
  for (const [from, targets] of Object.entries(AGENT_RUN_TRANSITIONS)) {
    for (const to of targets) assert.equal(isAgentRunTransitionAllowed(from, to), true);
  }
});

test("stopping a Work checks the table for the state each row actually moves to", async (t) => {
  // A launch_pending Worker run without a pid is closed as cancelled, not cancel_requested.
  const a = await fixture(t, "launch_pending");
  await a.lane.transact((q) => requestStopOfAgentRuns(q, { column: "work_id", id: "W1" }, LATER));
  assert.equal(a.row().status, "cancelled");
  // When the table forbids launch_pending -> cancelled, that row is left alone even though cancel_requested is allowed.
  const original = AGENT_RUN_TRANSITIONS.launch_pending;
  AGENT_RUN_TRANSITIONS.launch_pending = original.filter((s) => s !== "cancelled");
  t.after(() => { AGENT_RUN_TRANSITIONS.launch_pending = original; });
  const b = await fixture(t, "launch_pending");
  const before = b.row();
  let changes = -1;
  await b.lane.transact((q) => { changes = requestStopOfAgentRuns(q, { column: "work_id", id: "W1" }, LATER); });
  assert.equal(changes, 0);
  assert.deepEqual(b.row(), before);
});

test("recording a process promotes launch_pending to running and keeps cancel_requested", async (t) => {
  const identity = { process_start_time: "t", process_cmdline_sha256: null };
  const a = await fixture(t, "launch_pending");
  await a.lane.transact((q) => recordAgentRunProcess(q, "R1", { pid: 42, identity, now: LATER }));
  assert.equal(a.row().status, "running");
  assert.equal(a.row().pid, 42);
  const b = await fixture(t, "cancel_requested");
  await b.lane.transact((q) => recordAgentRunProcess(q, "R1", { pid: 43, identity, now: LATER }));
  assert.equal(b.row().status, "cancel_requested");
});
