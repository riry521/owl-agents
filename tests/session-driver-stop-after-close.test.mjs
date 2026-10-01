// stop() on an Advisor/Codex driver whose process already closed still waits
// for the rest of its process group to be reaped, and never signals the old pid.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AdvisorSessionDriver, CodexSessionDriver } from "../packages/agent-runtime/dist/index.js";

const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

// Answers JSON-RPC requests, leaves a SIGTERM-ignoring member in its own group
// and exits once the exit file appears.
const FAKE_AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const member = spawn("sh", ["-c", "trap '' TERM; exec sleep 60"], { stdio: "ignore" });
fs.writeFileSync(process.env.MEMBER_PID_FILE, String(member.pid));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined) process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: "thread-1" } } }) + "\\n");
});
setInterval(() => { if (fs.existsSync(process.env.EXIT_FILE)) process.exit(0); }, 20);
`;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return condition();
}

for (const [name, Driver] of [["Advisor", AdvisorSessionDriver], ["Codex", CodexSessionDriver]]) {
  test(`${name} stop() after the process closed waits for the group and signals only the group`, async () => {
    const root = await mkdtemp(join(tmpdir(), "owl-driver-stop-"));
    const executable = join(root, "fake-agent");
    const pidFile = join(root, "member.pid");
    const exitFile = join(root, "exit");
    let member = 0;
    const realKill = process.kill;
    try {
      await writeFile(executable, FAKE_AGENT, "utf8");
      await chmod(executable, 0o755);
      const driver = await Driver.create({
        adapter: name === "Advisor" ? "claude" : "codex",
        role: "advisor",
        model: "test-model",
        cwd: root,
        env: { ...baseEnv, MEMBER_PID_FILE: pidFile, EXIT_FILE: exitFile },
        system_prompt: "test",
      }, executable, { reapGraceMs: 300 });
      assert.equal(await waitFor(() => existsSync(pidFile), 3000), true);
      member = Number(await readFile(pidFile, "utf8"));
      assert.equal(alive(member), true);

      await writeFile(exitFile, "", "utf8");
      assert.equal(await waitFor(() => driver.exited, 3000), true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const calls = [];
      process.kill = (target, signal) => {
        calls.push([target, signal]);
        return realKill.call(process, target, signal);
      };
      const started = Date.now();
      await driver.stop("test");
      const elapsed = Date.now() - started;
      process.kill = realKill;

      assert.ok(elapsed >= 100, `stop resolved after ${elapsed}ms, before the group was reaped`);
      assert.equal(await waitFor(() => !alive(member), 1000), true);
      assert.deepEqual(calls.filter(([target, signal]) => target === driver.pid && signal !== 0), []);
    } finally {
      process.kill = realKill;
      if (member > 1) { try { realKill.call(process, member, "SIGKILL"); } catch { /* gone */ } }
      await rm(root, { recursive: true, force: true });
    }
  });
}
