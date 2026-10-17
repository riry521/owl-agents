// owl-memory over opencode: the built memory-mcp is started by the (fake) opencode from the config Owl passes,
// listed, and called through the execute path, with the permission ask judged by the real hook.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { executeOpencode, startOpencodeServer, toolNamesInLine } from "../../packages/agent-runtime/dist/index.js";
import { opencodeConfigContent, opencodeServeEnv, owlMcpServers } from "../../packages/shared/dist/index.js";
import { unwrapCliResult } from "../../packages/agent-runtime/dist/protocol.js";
import { readFakeOpencodeLog, startFakeOwlApi, writeFakeOpencode } from "../helpers/fake-opencode.mjs";
import { tempDir } from "../helpers/temp.mjs";

const adapter = "opencode-serve/v1";
const owlRoot = process.cwd();

test("owl-memory is started from the config, lists its tools, and a call reaches the Owl API with the run's identity", async (t) => {
  if (!existsSync(path.join(owlRoot, "apps/server/dist/memory-mcp.js"))) return t.skip("apps/server is not built");
  const root = await tempDir(t, "owl-opencode-mcp-");
  const token = randomBytes(8).toString("hex");
  const tokenFile = path.join(root, "guard-token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const api = await startFakeOwlApi(t, { guard: () => ({ allowed: true }), marker: "memory-index-marker", tokenFile });
  if (!api) return t.skip("localhost listen is unavailable");
  // The hook is a stub that records its stdin; the memory server is the built one, linked into the same root.
  const hookRoot = path.join(root, "owl");
  const hookInputs = path.join(root, "hook-inputs.jsonl");
  await mkdir(path.join(hookRoot, "apps/server/dist"), { recursive: true });
  await symlink(path.join(owlRoot, "apps/server/dist/memory-mcp.js"), path.join(hookRoot, "apps/server/dist/memory-mcp.js"));
  await writeFile(path.join(hookRoot, "apps/server/dist/permission-hook.js"), `let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>{require("node:fs").appendFileSync(${JSON.stringify(hookInputs)},s+"\\n");});\n`);
  const executable = await writeFakeOpencode(root);
  const logPath = path.join(root, "log.jsonl");
  const cwd = path.join(root, "work");
  await mkdir(cwd);
  const env = {
    PATH: process.env.PATH ?? "",
    OWL_ROOT: hookRoot,
    OWL_DATA_DIR: path.join(root, "data"),
    OWL_OPENCODE_EXECUTABLE: executable,
    OWL_AGENT_ROLE: "worker",
    OWL_AGENT_CWD: cwd,
    OWL_AGENT_RUN_ID: "run-mcp-1",
    OWL_GUARD_API_BASE: api.baseUrl,
    FAKE_OPENCODE_LOG: logPath,
    FAKE_OPENCODE_HEARTBEAT_MS: "0",
    FAKE_OPENCODE_SCENARIO: JSON.stringify([{ op: "call_mcp_tool", server: "owl-memory", tool: "index", arguments: {} }]),
  };
  const lines = [];
  const response = await executeOpencode(
    { adapter, role: "worker", model: "fake-provider/fake-model", prompt: "look at the memory index", invocation_id: "run-mcp-1", cwd, env, on_stdout_line: (line) => lines.push(line) },
    { env: {}, guardTokenFile: tokenFile, timeouts: { wallMs: 30_000, idleMs: 10_000 }, reapGraceMs: 1_000, eventStallMs: 10_000 },
  );

  const log = await readFakeOpencodeLog(logPath);
  const config = JSON.parse(log.find((entry) => entry.type === "start").env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(Object.keys(config.mcp.servers), ["owl-memory"]);
  const start = log.find((entry) => entry.type === "mcp.start");
  assert.equal(start.server, "owl-memory");
  assert.equal(start.command, process.execPath);
  assert.deepEqual(start.args, [path.join(hookRoot, "apps/server/dist/memory-mcp.js")]);
  assert.equal(start.environment.OWL_ROLE, "worker");
  assert.equal(start.environment.OWL_AGENT_RUN_ID, "run-mcp-1");
  assert.equal(start.environment.OWL_GUARD_TOKEN_FILE, tokenFile);
  const listed = log.find((entry) => entry.type === "mcp.tools");
  for (const tool of ["index", "page", "search"]) assert.ok(listed.tools.includes(tool), `${tool} is listed`);
  assert.equal(log.filter((entry) => entry.type === "mcp.start").length, 1, "owl-api is not started for a Worker");

  // The ask reaches the hook as mcp__owl-memory__index, and the hook's silent exit 0 is answered with `once`.
  const hookCalls = (await readFile(hookInputs, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(hookCalls.map((input) => input.tool_name), ["mcp__owl-memory__index"]);
  assert.equal(hookCalls[0].hook_event_name, "PreToolUse");
  const reply = log.find((entry) => entry.type === "request" && /\/permission\/[^/]+\/reply$/u.test(entry.path));
  assert.deepEqual(reply.body, { decision: "once" });

  const call = api.requests.find((request) => request.path === "/api/v1/memory/index");
  assert.ok(call, "the Owl API received the memory call");
  assert.equal(call.authorization, `Bearer ${token}`);
  assert.equal(call.authorization, `Bearer ${call.token_file_content.trim()}`);
  assert.equal(call.role, "worker");
  assert.equal(call.agent_run_id, "run-mcp-1");

  assert.match(unwrapCliResult(adapter, response.stdout), /memory-index-marker/u);
  assert.ok(lines.some((line) => toolNamesInLine(adapter, line).includes("mcp__owl-memory__index")));
  assert.equal(existsSync(path.join(root, "data", "opencode-runs", "run-mcp-1")), false);
});

test("GET /api/mcp reports owl-memory as connected once serve is up with the config Owl builds", async (t) => {
  if (!existsSync(path.join(owlRoot, "apps/server/dist/memory-mcp.js"))) return t.skip("apps/server is not built");
  const root = await tempDir(t, "owl-opencode-mcp-status-");
  const executable = await writeFakeOpencode(root);
  const baseEnv = { PATH: process.env.PATH ?? "", OWL_AGENT_RUN_ID: "run-mcp-2" };
  const configContent = opencodeConfigContent({ cwd: root, model: "fake-provider/fake-model", env: baseEnv, permissions: [], mcpServers: owlMcpServers({ owlRoot, role: "worker", env: baseEnv }) });
  const env = opencodeServeEnv({ env: { ...baseEnv, FAKE_OPENCODE_HEARTBEAT_MS: "0" }, password: randomBytes(12).toString("hex"), runDir: path.join(root, "run"), configContent });
  const server = await startOpencodeServer({ executable, cwd: root, env, eventStallMs: 10_000 });
  t.after(() => server.stop(1000));
  const status = await server.client.request("GET", "/api/mcp");
  assert.deepEqual(status.data.map((entry) => [entry.name, entry.status.status]), [["owl-memory", "connected"]]);
});
