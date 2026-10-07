import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAgentPermissionArgs } from "../../../packages/shared/dist/index.js";

const ROLES = ["advisor", "manager", "designer", "worker", "reviewer", "curator"];
const env = {
  OWL_AGENT_RUN_ID: "run-1",
  OWL_WORK_ID: "work-1",
  OWL_TASK_ID: "task-1",
  OWL_PROJECT_ID: "project-1",
  OWL_GUARD_API_BASE: "http://127.0.0.1:1/api/v1",
};

function owlRootWithServers() {
  const root = mkdtempSync(path.join(os.tmpdir(), "owl-memory-args-"));
  mkdirSync(path.join(root, "apps", "server", "dist"), { recursive: true });
  for (const name of ["permission-hook.js", "memory-mcp.js"]) writeFileSync(path.join(root, "apps", "server", "dist", name), "");
  return root;
}

for (const role of ROLES) {
  test(`${role} registers owl-memory for Claude`, () => {
    const owlRoot = owlRootWithServers();
    const args = buildAgentPermissionArgs(role, "claude", { owlRoot, env });
    assert.ok(!args.includes("--strict-mcp-config"));
    const server = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")).mcpServers["owl-memory"];
    assert.deepEqual(server.args, [path.join(owlRoot, "apps/server/dist/memory-mcp.js")]);
    assert.equal(server.env.OWL_ROLE, role);
    for (const name of ["OWL_AGENT_RUN_ID", "OWL_WORK_ID", "OWL_TASK_ID", "OWL_PROJECT_ID"]) assert.equal(server.env[name], env[name]);
  });

  test(`${role} registers owl-memory for Codex`, () => {
    const owlRoot = owlRootWithServers();
    const args = buildAgentPermissionArgs(role, "codex", { owlRoot, env });
    assert.ok(!args.includes("--strict-mcp-config"));
    assert.ok(args.includes(`mcp_servers.owl-memory.args=["${path.join(owlRoot, "apps/server/dist/memory-mcp.js")}"]`));
    assert.ok(args.some((arg) => arg.startsWith("mcp_servers.owl-memory.command=")));
    const table = args.find((arg) => arg.startsWith("mcp_servers.owl-memory.env="));
    assert.ok(table.includes(`OWL_ROLE="${role}"`));
    for (const name of ["OWL_AGENT_RUN_ID", "OWL_WORK_ID", "OWL_TASK_ID", "OWL_PROJECT_ID"]) assert.ok(table.includes(`${name}="${env[name]}"`));
  });
}

test("ids the role has none of are left unset, not empty", () => {
  const owlRoot = owlRootWithServers();
  // An Advisor has no Work yet and a Curator no Task; only the run id and role remain.
  const args = buildAgentPermissionArgs("curator", "claude", { owlRoot, env: { OWL_AGENT_RUN_ID: "run-2", OWL_WORK_ID: "" } });
  const { env: serverEnv } = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")).mcpServers["owl-memory"];
  assert.deepEqual(serverEnv, { OWL_ROLE: "curator", OWL_AGENT_RUN_ID: "run-2" });
});
