import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDesignMockMcpArgs } from "../dist/index.js";

const owlRoot = mkdtempSync(join(tmpdir(), "owl-design-mock-args-"));
mkdirSync(join(owlRoot, "apps/server/dist"), { recursive: true });
writeFileSync(join(owlRoot, "apps/server/dist/design-mock-mcp.js"), "");
const env = {
  OWL_DESIGN_MOCK_MCP: "1",
  OWL_AGENT_RUN_ID: "run1",
  OWL_GUARD_API_BASE: "http://127.0.0.1:4317",
  OWL_GUARD_TOKEN_FILE: "/tmp/token",
};
const generated = [];

test.after(() => {
  for (const path of generated) rmSync(path, { force: true });
  rmSync(owlRoot, { recursive: true, force: true });
});

test("returns no args unless every registration condition is met", () => {
  for (const adapter of ["claude", "codex"]) {
    for (const role of ["worker", "advisor", "manager", "reviewer"]) assert.deepEqual(buildDesignMockMcpArgs(adapter, { owlRoot, role, env }), []);
    assert.deepEqual(buildDesignMockMcpArgs(adapter, { owlRoot, role: "designer", env: { ...env, OWL_DESIGN_MOCK_MCP: "0" } }), []);
    assert.deepEqual(buildDesignMockMcpArgs(adapter, { owlRoot: join(owlRoot, "missing"), role: "designer", env }), []);
    for (const name of ["OWL_AGENT_RUN_ID", "OWL_GUARD_API_BASE", "OWL_GUARD_TOKEN_FILE"]) {
      assert.deepEqual(buildDesignMockMcpArgs(adapter, { owlRoot, role: "designer", env: { ...env, [name]: "" } }), []);
    }
  }
});

test("claude receives an mcp-config that starts the owl-design server as a designer", () => {
  const args = buildDesignMockMcpArgs("claude", { owlRoot, role: "designer", env });
  assert.equal(args[0], "--mcp-config");
  generated.push(args[1]);
  const server = JSON.parse(readFileSync(args[1], "utf8")).mcpServers["owl-design"];
  assert.deepEqual(server.args, [join(owlRoot, "apps/server/dist/design-mock-mcp.js")]);
  assert.equal(server.env.OWL_ROLE, "designer");
  assert.equal(server.env.OWL_GUARD_TOKEN_FILE, "/tmp/token");
});

test("codex receives mcp_servers.owl-design config arguments", () => {
  const args = buildDesignMockMcpArgs("codex", { owlRoot, role: "designer", env });
  assert.ok(args.some((arg) => arg.startsWith("mcp_servers.owl-design.command=")));
  assert.ok(args.some((arg) => arg.includes('OWL_ROLE="designer"')));
  assert.ok(args.includes("mcp_servers.owl-design.startup_timeout_sec=20"));
});
