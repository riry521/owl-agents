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
import { isProcessGroupAlive, reapProcessGroup } from "../../packages/shared/dist/index.js";

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
