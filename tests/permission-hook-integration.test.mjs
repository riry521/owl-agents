import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RuleStore } from "../packages/core/dist/rule-store.js";
import { createOwlHttpServer } from "../apps/server/dist/http.js";
import { GuardTokenRegistry } from "../apps/server/dist/guard-tokens.js";

function runHook({ role = "worker", apiBase, tokenFile, toolName, toolInput, cwd }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, OWL_AGENT_ROLE: role, OWL_GUARD_API_BASE: apiBase, OWL_AGENT_CWD: cwd };
    delete env.OWL_GUARD_TOKEN;
    if (tokenFile === undefined) delete env.OWL_GUARD_TOKEN_FILE;
    else env.OWL_GUARD_TOKEN_FILE = tokenFile;
    const child = spawn(process.execPath, [path.resolve("apps/server/dist/permission-hook.js")], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, cwd }));
  });
}

test("PreToolUse hook enforces the live RuleStore API and fails closed when it is offline", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "owl-permission-hook-"));
  const guardTokens = GuardTokenRegistry.open(path.join(root, "guard-tokens"));
  const workerLease = guardTokens.issue({ agent_run_id: "run-worker", role: "worker" });
  const advisorLease = guardTokens.issue({ agent_run_id: "run-advisor", role: "advisor" });
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
  });
  let listening = false;
  try {
    try {
      await http.listen();
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        t.skip("localhost listen is unavailable");
        return;
      }
      throw error;
    }
    listening = true;
    const address = http.server.address();
    const apiBase = `http://127.0.0.1:${address.port}`;
    const hookOptions = { apiBase, tokenFile: workerLease.file, cwd: root };

    const blocked = await runHook({ ...hookOptions, toolName: "Bash", toolInput: { command: "echo ok && git push -f" } });
    assert.equal(blocked.code, 0);
    assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.match(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecisionReason, /force|禁止/u);

    const leasedPush = await runHook({ ...hookOptions, toolName: "Bash", toolInput: { command: "git push --force-with-lease" } });
    assert.equal(leasedPush.code, 0);
    assert.equal(leasedPush.stdout, "");

    const outsideRead = await runHook({
      ...hookOptions,
      toolName: "Read",
      toolInput: { file_path: path.resolve("package.json") },
    });
    assert.equal(outsideRead.stdout, "");

    const secretRead = await runHook({
      ...hookOptions,
      toolName: "Read",
      toolInput: { file_path: path.join(root, ".env.local") },
    });
    assert.equal(JSON.parse(secretRead.stdout).hookSpecificOutput.permissionDecision, "deny");

    const mcpSecretRead = await runHook({
      ...hookOptions,
      toolName: "mcp__serena__read_file",
      toolInput: { relative_path: ".env.local" },
    });
    assert.equal(JSON.parse(mcpSecretRead.stdout).hookSpecificOutput.permissionDecision, "deny");

    const mcpSourceRead = await runHook({
      ...hookOptions,
      toolName: "mcp__serena__read_file",
      toolInput: { relative_path: "src/index.ts" },
    });
    assert.equal(mcpSourceRead.stdout, "");

    const advisorWrite = await runHook({
      ...hookOptions,
      role: "advisor",
      tokenFile: advisorLease.file,
      toolName: "Edit",
      toolInput: { file_path: "src/index.ts", old_string: "a", new_string: "b" },
    });
    assert.equal(advisorWrite.stdout, "");

    const advisorCreate = await runHook({
      ...hookOptions,
      role: "advisor",
      tokenFile: advisorLease.file,
      toolName: "Write",
      toolInput: { file_path: "src/new-file.ts", content: "text" },
    });
    assert.equal(advisorCreate.stdout, "");

    const sqlitePatch = await runHook({
      ...hookOptions,
      toolName: "apply_patch",
      toolInput: { command: "*** Begin Patch\n*** Update File: data/state.sqlite\n*** End Patch" },
    });
    assert.equal(JSON.parse(sqlitePatch.stdout).hookSpecificOutput.permissionDecision, "deny");

    const readonlySqlite = await runHook({
      ...hookOptions,
      toolName: "Bash",
      toolInput: { command: "sqlite3 -readonly data/state.sqlite 'select 1'" },
    });
    assert.equal(readonlySqlite.stdout, "");
    try {
      execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
      const dataDir = path.join(root, "data");
      await mkdir(dataDir, { recursive: true });
      const databasePath = path.join(dataDir, "state.sqlite");
      execFileSync("sqlite3", [databasePath, "create table sample (value integer); insert into sample values (42);"]);
      const query = execFileSync("sqlite3", ["-readonly", databasePath, "select value from sample;"], { encoding: "utf8" }).trim();
      assert.equal(query, "42", "sqlite3 -readonly can run after the guard approves it");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  } finally {
    if (listening) await http.close();
    guardTokens.clear();
  }

  const offlineTokens = GuardTokenRegistry.open(path.join(root, "offline-tokens"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const offlineLease = offlineTokens.issue({ agent_run_id: "run-offline", role: "worker" });
  const offline = await runHook({
    role: "worker",
    apiBase: "http://127.0.0.1:1",
    tokenFile: offlineLease.file,
    cwd: root,
    toolName: "Bash",
    toolInput: { command: "echo safe" },
  });
  assert.equal(offline.code, 0);
  assert.equal(JSON.parse(offline.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(JSON.parse(offline.stdout).hookSpecificOutput.permissionDecisionReason, /could not be reached/u);

  const offlineMcpPath = await runHook({
    role: "worker",
    apiBase: "http://127.0.0.1:1",
    tokenFile: offlineLease.file,
    cwd: root,
    toolName: "mcp__serena__read_file",
    toolInput: { relative_path: "src/index.ts" },
  });
  assert.equal(JSON.parse(offlineMcpPath.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("PreToolUse hook allows tool calls without path or command arguments without asking the guard", async () => {
  for (const [toolName, toolInput] of [
    ["mcp__serena__find_symbol", { name_path: "RuleStore/checkGuard" }],
    ["WebFetch", { url: "https://example.com", prompt: "summarize" }],
    ["WebSearch", { query: "node test runner" }],
    ["mcp__slack__post_message", { channel: "C1", text: "hello" }],
  ]) {
    const result = await runHook({
      role: "worker",
      apiBase: "http://127.0.0.1:1",
      cwd: os.tmpdir(),
      toolName,
      toolInput,
    });
    assert.equal(result.code, 0, toolName);
    assert.equal(result.stdout, "", toolName);
  }
});

test("a guard token answers only for its own role and only until it is released", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "owl-guard-token-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const guardTokens = GuardTokenRegistry.open(path.join(root, "guard-tokens"));
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
  });
  try {
    await http.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("localhost listen is unavailable");
      return;
    }
    throw error;
  }
  try {
    const apiBase = `http://127.0.0.1:${http.server.address().port}`;
    const lease = guardTokens.issue({ agent_run_id: "run-1", role: "worker" });
    const token = (await readFile(lease.file, "utf8")).trim();
    assert.equal((await stat(lease.file)).mode & 0o777, 0o600);
    assert.equal((await stat(guardTokens.directory)).mode & 0o777, 0o700);
    assert.deepEqual(guardTokens.verify(token), { agent_run_id: "run-1", role: "worker" });
    const check = (role) => fetch(`${apiBase}/api/v1/guard/check`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        request_id: "r",
        idempotency_key: "k",
        expected_version: 0,
        payload: { role, tool_name: "Bash", tool_input: { command: "echo ok" }, cwd: root },
      }),
    });
    assert.equal((await check("worker")).status, 200);
    const otherRole = await check("advisor");
    assert.equal(otherRole.status, 403);
    assert.equal((await otherRole.json()).error.code, "agent_scope_denied");

    const hookAsAdvisor = await runHook({ role: "advisor", apiBase, tokenFile: lease.file, cwd: root, toolName: "Bash", toolInput: { command: "echo ok" } });
    assert.match(JSON.parse(hookAsAdvisor.stdout).hookSpecificOutput.permissionDecisionReason, /HTTP 403/u);

    lease.release();
    lease.release();
    assert.equal(guardTokens.verify(token), null);
    await assert.rejects(() => stat(lease.file), { code: "ENOENT" });
    assert.equal((await check("worker")).status, 401);

    const missingFile = await runHook({ apiBase, tokenFile: lease.file, cwd: root, toolName: "Bash", toolInput: { command: "echo ok" } });
    assert.match(JSON.parse(missingFile.stdout).hookSpecificOutput.permissionDecisionReason, /token could not be read/u);
    const noFile = await runHook({ apiBase, cwd: root, toolName: "Bash", toolInput: { command: "echo ok" } });
    assert.equal(JSON.parse(noFile.stdout).hookSpecificOutput.permissionDecision, "deny");
  } finally {
    await http.close();
    guardTokens.clear();
  }
});

test("opening the registry discards token files left by an earlier server", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "owl-guard-token-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "guard-tokens");
  const earlier = GuardTokenRegistry.open(directory);
  const stale = earlier.issue({ agent_run_id: "run-old", role: "worker" });
  const token = (await readFile(stale.file, "utf8")).trim();
  const current = GuardTokenRegistry.open(directory);
  assert.equal(current.verify(token), null);
  await assert.rejects(() => stat(stale.file), { code: "ENOENT" });
});
