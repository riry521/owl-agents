import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RuleStore } from "../../../packages/core/dist/rule-store.js";
import { GuardTokenRegistry } from "./guard-tokens.js";
import { createOwlHttpServer } from "./http.js";

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

function runGuardedHook(env: NodeJS.ProcessEnv, toolName: string, toolInput: Record<string, unknown>, cwd: string): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [hookPath], { env, stdio: ["pipe", "pipe", "ignore"] });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.once("error", reject);
    child.once("close", () => resolveRun(Buffer.concat(stdout).toString("utf8")));
    child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, cwd }));
  });
}

test("PreToolUse lets the Advisor read knowledge notes but still blocks .env and secrets.json", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-hook-knowledge-"));
  const guardTokens = GuardTokenRegistry.open(join(root, "guard-tokens"));
  const lease = guardTokens.issue({ agent_run_id: "run-advisor", role: "advisor" });
  const ruleStore = new RuleStore(process.cwd());
  await ruleStore.load();
  const http = createOwlHttpServer({
    core: { ready: true },
    webOut: root,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot: root,
    ruleStore,
    guardTokens,
  } as never);
  try {
    try {
      await http.listen();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        t.skip("localhost listen is unavailable");
        return;
      }
      throw error;
    }
    const address = http.server.address() as { port: number };
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OWL_AGENT_ROLE: "advisor",
      OWL_GUARD_API_BASE: `http://127.0.0.1:${address.port}`,
      OWL_GUARD_TOKEN_FILE: lease.file,
    };
    const notes = join(root, "Memory", "notes");
    const run = (toolName: string, toolInput: Record<string, unknown>) => runGuardedHook(env, toolName, toolInput, root);

    assert.equal(await run("Read", { file_path: join(notes, "project-overview-01M3X50CF12CW3P838TC4MRG11.md") }), "");
    assert.equal(await run("Grep", { pattern: "stack", path: notes }), "");
    for (const name of [".env", "secrets.json"]) {
      const out = await run("Read", { file_path: join(root, "Memory", name) });
      assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny", name);
    }
  } finally {
    await http.close();
    await rm(root, { recursive: true, force: true });
  }
});
