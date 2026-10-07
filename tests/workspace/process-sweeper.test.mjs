// Sweeping processes an agent run left behind. Only processes that carry this
// instance's OWL_INSTANCE_ID and the id of a finished run are ever killed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { markersFromPsLine, WorkspaceProcessSweeper } from "../../packages/core/dist/workspace-process-sweeper.js";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

const WS = "/ws";
const OWL = 100;
const ME = "inst-mine";
const entries = [
  { work_id: "w1", task_id: "t1", path: `${WS}/w1/t1` },
  { work_id: "w1", task_id: "t2", path: `${WS}/w1/t2` },
  { work_id: "w1", task_id: null, path: `${WS}/w1/__work__` },
  { work_id: "w2", task_id: "t9", path: `${WS}/w2/t9` },
];
const idle = { works: new Set(), tasks: new Set() };
const runTable = {
  done1: { work_id: "w1", task_id: "t1", active: false },
  done2: { work_id: "w1", task_id: "t2", active: false },
  live1: { work_id: "w1", task_id: "t1", active: true },
  doneW: { work_id: "w1", task_id: null, active: false },
  done9: { work_id: "w2", task_id: "t9", active: false },
};

function row(pid, ppid, args, extra = {}) {
  return { pid, ppid, pgid: pid, tty: null, args, instanceId: null, runId: null, ...extra };
}
const mine = (runId) => ({ instanceId: ME, runId });

function fakeSweeper({ table, activity = idle, runs = runTable, dead = true }) {
  const signals = [];
  const alive = new Set(table.map((r) => r.pid));
  const logs = [];
  const sweeper = new WorkspaceProcessSweeper({
    listWorkspaces: async () => entries,
    activity: () => activity,
    instanceId: ME,
    runs: (ids) => new Map(ids.filter((id) => runs[id]).map((id) => [id, runs[id]])),
    ownerPid: OWL,
    snapshot: async () => table,
    signal: (pid, name) => {
      signals.push([pid, name]);
      if (dead && name === "SIGTERM") for (const r of table) if (r.pid === Math.abs(pid) || (pid < 0 && r.pgid === -pid)) alive.delete(r.pid);
      return true;
    },
    isAlive: (pid) => alive.has(pid),
    graceMs: 100,
    log: (message) => logs.push(message),
    platform: "linux",
  });
  return { sweeper, signals, logs };
}

const killed = (signals) => signals.filter(([, name]) => name === "SIGTERM").map(([pid]) => pid);

test("a marked orphan of a finished run is terminated and logged without its environment", async () => {
  const { sweeper, signals, logs } = fakeSweeper({
    table: [row(1, 0, "init"), row(OWL, 1, "owl"), row(500, 1, "node server.js SECRET=hunter2", mine("done1"))],
  });
  assert.deepEqual((await sweeper.sweep()).map((s) => s.pid), [500]);
  assert.deepEqual(killed(signals), [-500]);
  assert.match(logs[0], /500/);
  assert.match(logs[0], /done1/);
  assert.doesNotMatch(logs[0], /hunter2/);
});

test("processes without markers are never killed, whatever directory they are in", async () => {
  const { sweeper, signals } = fakeSweeper({
    table: [row(500, 1, "code /ws/w1/t1 --folder-uri"), row(501, 1, "git fsmonitor--daemon run", {}), row(502, 1, "tsserver", { runId: "done1" })],
  });
  assert.deepEqual(await sweeper.sweep(), []);
  assert.deepEqual(signals, []);
});

test("a process marked by another instance is never killed", async () => {
  const { sweeper } = fakeSweeper({ table: [row(500, 1, "x", { instanceId: "inst-other", runId: "done1" })] });
  assert.deepEqual(await sweeper.sweep(), []);
});

test("a marked orphan whose run is active is kept", async () => {
  const { sweeper } = fakeSweeper({ table: [row(500, 1, "x", mine("live1"))] });
  assert.deepEqual(await sweeper.sweep(), []);
});

test("a Task with an in-progress verification or pipeline keeps its finished runs' processes", async () => {
  const { sweeper } = fakeSweeper({
    table: [row(500, 1, "a", mine("done1")), row(501, 1, "b", mine("done2"))],
    activity: { works: new Set(["w1"]), tasks: new Set(["w1/t1"]) },
  });
  assert.deepEqual((await sweeper.sweep()).map((s) => s.pid), [501]);
});

test("a run without a Task is kept while its Work has an active run", async () => {
  const table = [row(500, 1, "a", mine("doneW"))];
  assert.equal((await fakeSweeper({ table, activity: { works: new Set(["w1"]), tasks: new Set() } }).sweeper.sweep()).length, 0);
  assert.equal((await fakeSweeper({ table }).sweeper.sweep()).length, 1);
});

test("the owner, its descendants and processes with a tty are never swept", async () => {
  const { sweeper, signals } = fakeSweeper({
    table: [
      row(OWL, 1, "owl-server", mine("done1")),
      row(200, OWL, "agent", mine("done1")),
      row(201, 200, "dev server", { ...mine("done1"), pgid: 999 }),
      row(300, 1, "bash", { ...mine("done1"), tty: "ttys003" }),
      row(400, 1, "leftover", mine("done1")),
    ],
  });
  assert.deepEqual((await sweeper.sweep()).map((s) => s.pid), [400]);
  assert.deepEqual(killed(signals), [-400]);
});

test("SIGKILL follows when the process survives the grace period", async () => {
  const { sweeper, signals } = fakeSweeper({ table: [row(500, 1, "x", mine("done1"))], dead: false });
  await sweeper.sweep();
  assert.deepEqual(signals, [[-500, "SIGTERM"], [-500, "SIGKILL"]]);
});

test("a group is signalled as a whole only when every member is swept", async () => {
  const { sweeper, signals } = fakeSweeper({
    table: [row(500, 1, "leader", mine("done1")), row(501, 500, "member", { ...mine("done1"), pgid: 500 }), row(502, 1, "other", { pgid: 500 })],
  });
  await sweeper.sweep();
  assert.deepEqual(killed(signals).sort(), [500, 501]);
});

test("scopes limit the sweep to the runs of one Work or Task directory", async () => {
  const table = [row(500, 1, "a", mine("done1")), row(501, 1, "b", mine("done9"))];
  assert.deepEqual((await fakeSweeper({ table }).sweeper.sweep({ workId: "w2" })).map((s) => s.pid), [501]);
  assert.deepEqual((await fakeSweeper({ table }).sweeper.sweep({ path: `${WS}/w1/t1` })).map((s) => s.pid), [500]);
});

test("a run this instance does not know is only swept globally", async () => {
  const table = [row(500, 1, "a", mine("verification"))];
  assert.equal((await fakeSweeper({ table }).sweeper.sweep({ workId: "w1" })).length, 0);
  assert.equal((await fakeSweeper({ table }).sweeper.sweep()).length, 1);
});

test("an unavailable process table sweeps nothing", async () => {
  const sweeper = new WorkspaceProcessSweeper({
    listWorkspaces: async () => entries, activity: () => idle, instanceId: ME, runs: () => new Map(), snapshot: async () => null, log: () => {},
  });
  assert.deepEqual(await sweeper.sweep(), []);
});

test("ps environment markers are read from the end of the line", () => {
  const line = "node /x/OWL_INSTANCE_ID=spoof OWL_AGENT_RUN_ID=fake PATH=/bin OWL_INSTANCE_ID=inst-mine OWL_AGENT_RUN_ID=run1 HOME=/h";
  assert.deepEqual(markersFromPsLine(line), { instanceId: "inst-mine", runId: "run1" });
  assert.deepEqual(markersFromPsLine("node server.js"), { instanceId: null, runId: null });
});

// Real processes and the real process table.
function startOrphan(cwd, env) {
  return new Promise((resolve) => {
    // A node process: macOS exposes the environment of ordinary binaries, not of platform ones such as sleep.
    const parent = spawn("sh", ["-c", `"${process.execPath}" -e "setTimeout(() => {}, 60000)" >/dev/null 2>&1 & echo $!`], {
      cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    parent.stdout.on("data", (chunk) => { out += chunk; });
    parent.once("close", () => resolve(Number(out.trim())));
  });
}

function gone(pid) {
  try { process.kill(pid, 0); return false; } catch { return true; }
}

async function waitGone(pid, ms) {
  try {
    return await waitFor(() => gone(pid), { timeoutMs: ms, intervalMs: 25, message: `pid ${pid} to exit` });
  } catch {
    return gone(pid);
  }
}

test("a real marked orphan is reaped while an unmarked process in the same directory survives", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no environment inspection");
  const root = await tempDir(t, "owl-sweep-");
  const dir = join(root, "w1", "t1");
  mkdirSync(dir, { recursive: true });
  const instance = `test-${process.pid}-${Date.now()}`;
  const marked = await startOrphan(dir, { OWL_INSTANCE_ID: instance, OWL_AGENT_RUN_ID: "run-finished" });
  const unmarked = await startOrphan(dir, { OWL_INSTANCE_ID: "", OWL_AGENT_RUN_ID: "" });
  const otherInstance = await startOrphan(dir, { OWL_INSTANCE_ID: "someone-else", OWL_AGENT_RUN_ID: "run-finished" });
  try {
    await new Promise((r) => setTimeout(r, 200));
    const sweeper = new WorkspaceProcessSweeper({
      listWorkspaces: async () => [{ work_id: "w1", task_id: "t1", path: dir }],
      activity: () => idle,
      instanceId: instance,
      runs: () => new Map([["run-finished", { work_id: "w1", task_id: "t1", active: false }]]),
      ownerPid: process.pid,
      graceMs: 500,
      log: () => {},
    });
    assert.deepEqual((await sweeper.sweep()).map((s) => s.pid), [marked]);
    assert.equal(await waitGone(marked, 3000), true);
    assert.equal(gone(unmarked), false);
    assert.equal(gone(otherInstance), false);
  } finally {
    for (const pid of [marked, unmarked, otherInstance]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
});
