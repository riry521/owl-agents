import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { buildDispatchMcpArgs } from "../dist/index.js";

const owlRoot = mkdtempSync(join(tmpdir(), "owl-dispatch-args-"));
const serverPath = join(owlRoot, "apps/server/dist/dispatch-mcp.js");
mkdirSync(join(owlRoot, "apps/server/dist"), { recursive: true });
writeFileSync(serverPath, "");
const env = {
  OWL_DISPATCH_MCP: "1",
  OWL_AGENT_RUN_ID: "run1",
  OWL_GUARD_API_BASE: "http://127.0.0.1:4317",
  OWL_GUARD_TOKEN_FILE: "/tmp/token",
};
const generatedConfigPaths = [];

test.after(() => {
  for (const path of generatedConfigPaths) rmSync(path, { force: true });
  rmSync(owlRoot, { recursive: true, force: true });
});

test("returns no args for roles other than worker", () => {
  for (const adapter of ["claude", "codex"]) {
    for (const role of ["advisor", "manager", "designer", "reviewer", "curator"]) {
      assert.deepEqual(buildDispatchMcpArgs(adapter, { owlRoot, role, env }), []);
    }
  }
});

test("returns no args unless OWL_DISPATCH_MCP is exactly 1", () => {
  for (const adapter of ["claude", "codex"]) {
    assert.deepEqual(buildDispatchMcpArgs(adapter, { owlRoot, role: "worker", env: { ...env, OWL_DISPATCH_MCP: "0" } }), []);
  }
});

test("returns no args when the built dispatch server file is absent", () => {
  for (const adapter of ["claude", "codex"]) {
    assert.deepEqual(buildDispatchMcpArgs(adapter, { owlRoot: join(owlRoot, "missing"), role: "worker", env }), []);
  }
});

test("returns no args if any required server env is empty", () => {
  for (const adapter of ["claude", "codex"]) {
    for (const name of ["OWL_AGENT_RUN_ID", "OWL_GUARD_API_BASE", "OWL_GUARD_TOKEN_FILE"]) {
      assert.deepEqual(buildDispatchMcpArgs(adapter, { owlRoot, role: "worker", env: { ...env, [name]: "" } }), []);
    }
  }
});

test("claude receives a private temporary mcp-config without strict mode", () => {
  const args = buildDispatchMcpArgs("claude", { owlRoot, role: "worker", env });
  assert.equal(args.length, 2);
  assert.equal(args[0], "--mcp-config");
  const path = args[1];
  generatedConfigPaths.push(path);
  const content = readFileSync(path, "utf8");
  const server = JSON.parse(content).mcpServers["owl-dispatch"];
  assert.equal(basename(path), `owl-dispatch-mcp-${createHash("sha256").update(content).digest("hex").slice(0, 16)}.json`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(server, {
    command: process.execPath,
    args: [serverPath],
    env: {
      OWL_ROLE: "worker",
      OWL_AGENT_RUN_ID: "run1",
      OWL_GUARD_API_BASE: "http://127.0.0.1:4317",
      OWL_GUARD_TOKEN_FILE: "/tmp/token",
    },
    timeout: 330000,
  });
  assert.equal(args.includes("--strict-mcp-config"), false);
});

test("codex receives the owl-dispatch MCP configuration", () => {
  const args = buildDispatchMcpArgs("codex", { owlRoot, role: "worker", env });
  const prefix = "mcp_servers.owl-dispatch";
  const expected = [
    ["--config", `${prefix}.command=${JSON.stringify(process.execPath)}`],
    ["--config", `${prefix}.args=[${JSON.stringify(serverPath)}]`],
    ["--config", `${prefix}.env={OWL_ROLE="worker",OWL_AGENT_RUN_ID="run1",OWL_GUARD_API_BASE="http://127.0.0.1:4317",OWL_GUARD_TOKEN_FILE="/tmp/token"}`],
    ["--config", `${prefix}.tool_timeout_sec=330`],
    ["--config", `${prefix}.startup_timeout_sec=20`],
  ].flat();
  assert.deepEqual(args, expected);
});
