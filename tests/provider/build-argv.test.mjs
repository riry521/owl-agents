import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { buildArgv } from "../../packages/agent-runtime/dist/provider.js";
import { tempDir } from "../helpers/temp.mjs";

async function withDispatchServer(t, run) {
  const owlRoot = await tempDir(t, "owl-provider-dispatch-");
  const serverPath = join(owlRoot, "apps", "server", "dist", "dispatch-mcp.js");
  await mkdir(join(owlRoot, "apps", "server", "dist"), { recursive: true });
  await writeFile(serverPath, "");
  await writeFile(join(owlRoot, "apps", "server", "dist", "permission-hook.js"), "");
  const tokenFile = join(owlRoot, "guard-token");
  const env = {
    OWL_ROOT: owlRoot,
    HOME: owlRoot,
    CODEX_HOME: owlRoot,
    OWL_DISPATCH_MCP: "1",
    OWL_AGENT_RUN_ID: "run-123",
    OWL_GUARD_API_BASE: "http://127.0.0.1:4317",
    OWL_GUARD_TOKEN_FILE: tokenFile,
    OWL_CLAUDE_EXECUTABLE: "/bin/claude",
    OWL_CODEX_EXECUTABLE: "/bin/codex",
  };
  await run({ owlRoot, tokenFile, env });
}

function argvFor(adapter, role, env) {
  return buildArgv({
    adapter,
    role,
    model: "test-model",
    cwd: "/tmp",
    env,
  });
}

test("buildArgv registers owl-dispatch for enabled workers and passes the guard token to Claude MCP", async (t) => {
  await withDispatchServer(t, async ({ env, tokenFile }) => {
    const args = argvFor("claude-cli/v1", "worker", env);
    const configFlag = args.indexOf("--mcp-config");
    assert.notEqual(configFlag, -1);
    const configPath = args[configFlag + 1];
    try {
      const config = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(config.mcpServers["owl-dispatch"].env.OWL_GUARD_TOKEN_FILE, tokenFile);
      assert.equal(config.mcpServers["owl-dispatch"].env.OWL_ROLE, "worker");
    } finally {
      await rm(configPath, { force: true });
    }
  });
});

test("buildArgv registers owl-dispatch in Codex config for enabled workers", async (t) => {
  await withDispatchServer(t, async ({ env, tokenFile }) => {
    const args = argvFor("codex-cli/v1", "worker", env);
    assert.ok(args.includes("mcp_servers.owl-dispatch.tool_timeout_sec=330"));
    assert.ok(args.includes("mcp_servers.owl-dispatch.startup_timeout_sec=20"));
    assert.ok(args.some((arg) => arg.includes(`OWL_GUARD_TOKEN_FILE=${JSON.stringify(tokenFile)}`)));
  });
});

test("buildArgv does not register owl-dispatch for reviewer, manager, or a disabled worker", async (t) => {
  await withDispatchServer(t, async ({ env }) => {
    for (const role of ["reviewer", "manager"]) {
      assert.equal(argvFor("claude-cli/v1", role, env).includes("--mcp-config"), false);
      assert.equal(argvFor("codex-cli/v1", role, env).some((arg) => arg.includes("mcp_servers.owl-dispatch.")), false);
    }
    const disabledEnv = { ...env, OWL_DISPATCH_MCP: "0" };
    assert.equal(argvFor("claude-cli/v1", "worker", disabledEnv).includes("--mcp-config"), false);
    assert.equal(argvFor("codex-cli/v1", "worker", disabledEnv).some((arg) => arg.includes("mcp_servers.owl-dispatch.")), false);
  });
});
