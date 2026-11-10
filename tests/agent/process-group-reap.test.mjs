// Process-group cleanup when an agent exits: members that ignore SIGTERM are
// killed after the grace period, whether the leader exited normally or not.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { createCliProvider } from "../../packages/agent-runtime/dist/provider.js";
import { runExecutor } from "../../packages/core/dist/executor.js";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";
import { createOutputCapture, isPidAlive, isProcessGroupAlive, reapProcessGroup, runCliVersion, runProcess, signalProcessGroup } from "../../packages/shared/dist/index.js";

// Fake harnesses start with `#!/usr/bin/env node`, so PATH must reach node even when the runner has none.
const baseEnv = { PATH: process.env.PATH || dirname(process.execPath), HOME: process.env.HOME || tmpdir() };

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}


// A leader that starts a SIGTERM-ignoring member in its own group, prints the
// member pid and exits.
const LEADER_SCRIPT = `#!/bin/sh
sh -c 'trap "" TERM; exec sleep 60' >/dev/null 2>&1 &
echo $!
exit 0
`;

function safeKill(pid) {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

test("reapProcessGroup kills a member that ignores SIGTERM after the leader exited", async (t) => {
  const root = await tempDir(t, "owl-reap-");
  let member = 0;
  try {
    const script = join(root, "leader.sh");
    await writeFile(script, LEADER_SCRIPT, "utf8");
    await chmod(script, 0o755);
    const leader = spawn(script, [], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    leader.stdout.on("data", (chunk) => { out += chunk; });
    await new Promise((resolve) => leader.once("close", resolve));
    member = Number(out.trim());
    assert.ok(member > 1);
    assert.equal(alive(member), true);
    assert.equal(isProcessGroupAlive(leader.pid), true);
    await reapProcessGroup(leader.pid, { graceMs: 300, pollMs: 20 });
    assert.equal(await waitFor(() => !alive(member), { timeoutMs: 2000 }), true);
    assert.equal(isProcessGroupAlive(leader.pid), false);
    // A group that is already gone is not an error.
    await reapProcessGroup(leader.pid, { graceMs: 50 });
    await reapProcessGroup(undefined);
  } finally {
    if (member > 1) safeKill(member);
  }
});

// A fake agent CLI: leaves a SIGTERM-ignoring member in its group, answers and exits.
const FAKE_AGENT = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => {
  const member = spawn("sh", ["-c", 'trap "" TERM; exec sleep 60'], { stdio: "ignore" });
  writeFileSync(process.env.MEMBER_PID_FILE, String(member.pid));
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }) + "\\n");
  setTimeout(() => process.exit(0), 50);
});
`;

async function withFakeAgent(t, run) {
  const root = await tempDir(t, "owl-reap-agent-");
  const pidFile = join(root, "member.pid");
  try {
    const executable = join(root, "fake-agent.cjs");
    await writeFile(executable, FAKE_AGENT, "utf8");
    await chmod(executable, 0o755);
    await run({ root, executable, pidFile, member: async () => Number(await readFile(pidFile, "utf8")) });
  } finally {
    try { safeKill(Number(await readFile(pidFile, "utf8"))); } catch { /* never started */ }
  }
}

test("a one-shot provider run reaps group members left behind by the agent", async (t) => {
  await withFakeAgent(t, async ({ root, executable, pidFile, member }) => {
    const provider = createCliProvider({ adapter: "claude-cli/v1", executablePath: executable, model: "m", env: baseEnv, reapGraceMs: 300 });
    await provider.execute({
      adapter: "claude-cli/v1", role: "worker", model: "m", prompt: "work", invocation_id: "inv-1", cwd: root,
      env: { ...baseEnv, MEMBER_PID_FILE: pidFile, OWL_PROVIDER_TIMEOUT_MS: "0", OWL_PROVIDER_IDLE_TIMEOUT_MS: "0" },
    });
    const pid = await member();
    assert.equal(await waitFor(() => !alive(pid), { timeoutMs: 3000 }), true);
  });
});

test("an Executor run reaps group members left behind by the agent", async (t) => {
  await withFakeAgent(t, async ({ root, executable, pidFile, member }) => {
    await runExecutor(
      { subtask_id: "sub-1", instruction: "work", workspace_dir: root, task: { title: "T", acceptance: "A", context: "", rules: null, owner_guidance: [] } },
      { provider: "claude", model: "claude-sonnet-5", timeout_ms: 0 },
      {},
      { owlRoot: process.env.OWL_ROOT ?? process.cwd(), env: { ...baseEnv, MEMBER_PID_FILE: pidFile }, executables: { claude: executable, codex: executable } },
    );
    const pid = await member();
    assert.equal(await waitFor(() => !alive(pid), { timeoutMs: 8000 }), true);
  });
});

test("createOutputCapture keeps the head or the tail under the limit and never splits a UTF-8 code point", () => {
  const head = createOutputCapture(4, "head");
  head.push(Buffer.from("abc"));
  head.push(Buffer.from("defg"));
  assert.equal(head.text(), "abcd");
  assert.equal(head.truncated(), true);
  const tail = createOutputCapture(7, "tail");
  tail.push(Buffer.from("あいう"));
  assert.equal(tail.text(), "いう");
});

test("runProcess stops the whole group after the timeout and SIGKILLs a member that ignores SIGTERM", async (t) => {
  let memberPid = 0;
  const script = "const {spawn}=require('node:child_process');const c=spawn('sh',['-c','trap \"\" TERM; exec sleep 60'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)";
  const result = await runProcess(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    env: baseEnv,
    timeoutMs: 600,
    killGraceMs: 300,
    onData: (stream, chunk) => { if (stream === "stdout") memberPid = Number(chunk.toString().trim()) || memberPid; },
  });
  t.after(() => safeKill(memberPid));
  assert.equal(result.timedOut, true);
  assert.ok(memberPid > 0);
  assert.equal(await waitFor(() => !alive(memberPid), { timeoutMs: 5000 }), true);
});

test("isPidAlive counts EPERM as alive only when asked to", (t) => {
  assert.equal(isPidAlive(process.pid, { epermAlive: false }), true);
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
  assert.equal(isPidAlive(1, { epermAlive: true }), true);
  assert.equal(isPidAlive(1, { epermAlive: false }), false);
});

test("signalProcessGroup skips the leader fallback only when the group is gone and the caller asked to", (t) => {
  const calls = [];
  const child = { pid: 4242, kill: (signal) => { calls.push(signal); return true; } };
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
  signalProcessGroup(child, "SIGTERM", { skipFallbackWhenGone: true });
  assert.deepEqual(calls, []);
  signalProcessGroup(child, "SIGTERM");
  assert.deepEqual(calls, ["SIGTERM"]);
});

test("signalProcessGroup groupOnly never signals the child alone when the group send fails", () => {
  const calls = [];
  const child = { pid: 2_000_000_000, kill: (signal) => { calls.push(signal); return true; } };
  signalProcessGroup(child, "SIGTERM", { groupOnly: true });
  signalProcessGroup({ kill: (signal) => { calls.push(signal); return true; } }, "SIGTERM", { groupOnly: true });
  assert.deepEqual(calls, []);
  signalProcessGroup(child, "SIGTERM");
  assert.deepEqual(calls, ["SIGTERM"]);
});

test("runProcess cancelKillOnClose drops the pending SIGKILL when the child closes; by default it still fires", async (t) => {
  const original = process.kill.bind(process);
  const sent = [];
  t.mock.method(process, "kill", (pid, signal) => { if (signal === "SIGKILL") sent.push(pid); return original(pid, signal); });
  const run = (cancelKillOnClose) => runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    cwd: process.cwd(), env: baseEnv, timeoutMs: 100, killGraceMs: 400, cancelKillOnClose, onData: () => undefined,
  });
  assert.equal((await run(true)).timedOut, true);
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual(sent, []);
  assert.equal((await run(false)).timedOut, true);
  await waitFor(() => sent.length > 0, { timeoutMs: 2000 });
  assert.ok(sent.length > 0);
});

test("runProcess stopMode reap stops a member that ignores SIGTERM", async (t) => {
  let memberPid = 0;
  const script = "const {spawn}=require('node:child_process');const c=spawn('sh',['-c','trap \"\" TERM; exec sleep 60'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)";
  const result = await runProcess(process.execPath, ["-e", script], {
    cwd: process.cwd(), env: baseEnv, timeoutMs: 600, killGraceMs: 300, stopMode: "reap",
    onData: (stream, chunk) => { if (stream === "stdout") memberPid = Number(chunk.toString().trim()) || memberPid; },
  });
  t.after(() => safeKill(memberPid));
  assert.equal(result.timedOut, true);
  assert.equal(await waitFor(() => !alive(memberPid), { timeoutMs: 5000 }), true);
});

test("runCliVersion with ignoreStdio spawns with stdio ignored: closed stdin, no stdout, no output limit", async () => {
  const big = "process.stdout.write('x'.repeat(2*1024*1024));process.stdin.on('end',()=>process.exit(3));process.stdin.resume()";
  const result = await runCliVersion(process.execPath, ["-e", big], 10_000, { ignoreStdio: true });
  assert.deepEqual({ stdout: result.stdout, exitCode: result.exitCode, spawnError: result.spawnError }, { stdout: "", exitCode: 3, spawnError: null });
  const missing = await runCliVersion("/nonexistent-owl-cli", ["--version"], 1000, { ignoreStdio: true });
  assert.equal(missing.exitCode, null);
  assert.ok(missing.spawnError);
});
