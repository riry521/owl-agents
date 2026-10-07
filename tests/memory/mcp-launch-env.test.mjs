// The owl-memory MCP config that production launch paths really generate: the
// argv a fake harness receives must carry the run's guard token file and the
// Work/Task/Project ids (unset where the role has none).
import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { createCliProvider } from "../../packages/agent-runtime/dist/provider.js";
import { runExecutor } from "../../packages/core/dist/executor.js";
import { GuardTokenRegistry } from "../../apps/server/dist/guard-tokens.js";
import { tempDir } from "../helpers/temp.mjs";

const baseEnv = { PATH: process.env.PATH || `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME || tmpdir(), OWL_ROOT: process.cwd(), OWL_GUARD_API_BASE: "http://127.0.0.1:9/api/v1" };
const IDS = { OWL_WORK_ID: "work-1", OWL_TASK_ID: "task-1", OWL_PROJECT_ID: "project-1" };

// Reports its argv and the guard token file as a Claude result or Codex message.
const FAKE_HARNESS = `#!/usr/bin/env node
const report = JSON.stringify({ argv: process.argv.slice(2), file: process.env.OWL_GUARD_TOKEN_FILE ?? null });
process.stdin.resume();
process.stdin.on("end", () => {
  const line = process.argv.includes("exec")
    ? { type: "item.completed", item: { type: "agent_message", text: report } }
    : { type: "result", subtype: "success", is_error: false, result: report };
  process.stdout.write(JSON.stringify(line) + "\\n");
});
`;

async function setup(t) {
  const root = await tempDir(t, "owl-memory-launch-");
  const executable = join(root, "fake-harness");
  await writeFile(executable, FAKE_HARNESS, "utf8");
  await chmod(executable, 0o755);
  const registry = GuardTokenRegistry.open(join(root, "guard-tokens"));
  t.after(() => registry.clear());
  return { root, executable, registry };
}

/** The owl-memory MCP server env found in the argv a harness received. */
async function memoryEnv(argv) {
  const index = argv.indexOf("--mcp-config");
  if (index >= 0) return JSON.parse(await readFile(argv[index + 1], "utf8")).mcpServers["owl-memory"].env;
  const table = argv.find((arg) => arg.startsWith("mcp_servers.owl-memory.env="));
  assert.ok(table, "owl-memory is registered");
  return Object.fromEntries([...table.matchAll(/(\w+)="([^"]*)"/gu)].map((match) => [match[1], match[2]]));
}

for (const [adapter, role] of [["claude-cli/v1", "reviewer"], ["codex-cli/v1", "worker"], ["claude-cli/v1", "curator"]]) {
  test(`provider.execute gives the ${adapter} ${role} MCP config its token file and ids`, async (t) => {
    const { root, executable, registry } = await setup(t);
    const provider = createCliProvider({ adapter, executablePath: executable, model: "m", env: baseEnv, guardToken: registry.issue });
    // The Curator runs with no Work, so its request carries no ids.
    const ids = role === "curator" ? {} : IDS;
    const response = await provider.execute({
      adapter, role, model: "m", prompt: "check", invocation_id: "inv-1", cwd: root,
      env: { ...baseEnv, ...ids, OWL_AGENT_ROLE: role, OWL_AGENT_RUN_ID: "run-1" },
    });
    const text = adapter.startsWith("codex") ? JSON.parse(response.stdout.trim().split("\n").at(-1)).item.text : JSON.parse(response.stdout).result;
    const report = JSON.parse(text);
    const env = await memoryEnv(report.argv);
    assert.equal(env.OWL_ROLE, role);
    assert.equal(env.OWL_AGENT_RUN_ID, "run-1");
    assert.equal(env.OWL_GUARD_TOKEN_FILE, report.file, "the MCP server reads the token file of this very process");
    assert.equal(env.OWL_GUARD_API_BASE, baseEnv.OWL_GUARD_API_BASE);
    for (const name of Object.keys(IDS)) assert.equal(env[name], ids[name], name);
  });
}

// The owl-memory server a launched agent starts lists tools by the Core's memory_mode.
async function listToolsFor(mode) {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/api/v1/memory/mode" ? { mode } : { error: "unexpected" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const env = { PATH: process.env.PATH || `${dirname(process.execPath)}:/usr/bin:/bin`, OWL_GUARD_API_BASE: `http://127.0.0.1:${server.address().port}/api/v1`, OWL_API_TOKEN: "t", OWL_ROLE: "worker", OWL_AGENT_RUN_ID: "run-1" };
    const child = spawn(process.execPath, [join(process.cwd(), "apps/server/dist/memory-mcp.js")], { env });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    await new Promise((resolve) => child.on("close", resolve));
    return JSON.parse(stdout.trim().split("\n")[0]).result.tools;
  } finally {
    server.close();
  }
}

test("memory_mode: pages exposes only index, page and search, with descriptions within 350 tokens", async () => {
  const tools = await listToolsFor("pages");
  assert.deepEqual(tools.map((tool) => tool.name), ["index", "page", "search"]);
  const { estimatePageTokens } = await import("../../packages/core/dist/memory/page-format.js");
  const total = tools.reduce((sum, tool) => sum + estimatePageTokens(tool.description), 0);
  assert.ok(total <= 350, `descriptions total ${total} tokens`);
});

test("a Hybrid Executor's MCP config carries its worker token file and the Task's ids", async (t) => {
  const { root, executable, registry } = await setup(t);
  for (const provider of ["claude", "codex"]) {
    const result = await runExecutor(
      {
        subtask_id: "sub-1", work_id: "work-1", task_id: "task-1", project_id: "project-1", instruction: "work", workspace_dir: root,
        task: { title: "Task", acceptance: "It works.", context: "", rules: null, owner_guidance: [] },
      },
      { provider, model: "m", timeout_ms: 5000 },
      {},
      { owlRoot: process.cwd(), env: baseEnv, executables: { [provider]: executable }, guardToken: registry.issue },
    );
    assert.equal(result.success, true, result.output);
    const report = JSON.parse(result.output);
    const env = await memoryEnv(report.argv);
    assert.equal(env.OWL_ROLE, "worker");
    assert.equal(env.OWL_AGENT_RUN_ID, "sub-1");
    assert.equal(env.OWL_GUARD_TOKEN_FILE, report.file);
    for (const [name, value] of Object.entries(IDS)) assert.equal(env[name], value, name);
  }
});

test("the runner passes work, task and project ids to the provider, and none for a Curator", async () => {
  const seen = [];
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        seen.push({ role: request.role, env: request.env });
        return { adapter: request.adapter, stdout: JSON.stringify({ tasks: [], results: [] }), stderr: "", exit_code: 0, signal: null, format: "plain-text" };
      },
    },
  });
  await runner.runManagerPlan({
    invocation_id: "run-m", work_id: "work-1", task_id: null, project_id: "project-1", attempt: 1,
    context: { mode: "plan", work: { id: "work-1", title: "W" } },
  });
  await runner.runCurator({ invocation_id: "run-c" });
  const [manager, curator] = seen;
  assert.equal(manager.role, "manager");
  assert.equal(manager.env.OWL_WORK_ID, "work-1");
  assert.equal(manager.env.OWL_PROJECT_ID, "project-1");
  assert.ok(!("OWL_TASK_ID" in manager.env), "a Manager has no Task");
  assert.equal(curator.role, "curator");
  for (const name of Object.keys(IDS)) assert.ok(!(name in curator.env), `a Curator has no ${name}`);
});
