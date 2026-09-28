import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("./permission-hook.js", import.meta.url));

function runHook(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [hookPath], { env, stdio: ["pipe", "pipe", "ignore"] });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code, stdout: Buffer.concat(stdout).toString("utf8") }));
    child.stdin.end(JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push -f" },
      cwd: process.cwd(),
    }));
  });
}

test("PreToolUse denies a guarded command when role or guard API configuration is missing", async (t) => {
  const cases = [
    { name: "OWL_AGENT_ROLE", env: { OWL_GUARD_API_BASE: "http://127.0.0.1:1" } },
    { name: "OWL_GUARD_API_BASE", env: { OWL_AGENT_ROLE: "worker" } },
  ] as const;

  for (const missing of cases) {
    await t.test(`${missing.name} is absent`, async () => {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? "",
        ...missing.env,
        OWL_GUARD_TOKEN_FILE: resolve("missing-guard-token-for-test"),
      };
      const result = await runHook(env);
      assert.equal(result.code, 0);
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /configuration is unavailable/u);
    });
  }
});
