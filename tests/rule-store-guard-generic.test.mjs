// The guard for tools it does not know by name (MCP tools, web tools): path
// and command arguments are checked, and only a block rule match denies.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuleStore } from "../packages/core/dist/rule-store.js";
import { guardChecksToolCall } from "../packages/shared/dist/index.js";

const RULES = `level: absolute
rules:
  - id: no_force_push
    kind: block_command
    pattern: "git push --force"
    message: "Force push is forbidden."
  - id: no_env_read
    kind: block_path
    pattern: "**/.env"
    mode: read
    message: "Do not read .env files."
  - id: no_lock_write
    kind: block_path
    pattern: "**/locked/**"
    mode: write
    message: "The locked directory is read-only."
`;

async function guardStore(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "owl-guard-generic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "rules", "system"), { recursive: true });
  await writeFile(path.join(root, "rules", "system", "safety.yaml"), RULES);
  const store = new RuleStore(root);
  await store.load();
  const check = (toolName, toolInput) => store.checkGuard({ role: "worker", toolName, toolInput, cwd: root, home: os.homedir() });
  return { root, check };
}

test("an MCP read tool is checked against read rules through its path argument", async (t) => {
  const { check } = await guardStore(t);
  const blocked = check("mcp__serena__read_file", { relative_path: "config/.env" });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.rule_id, "no_env_read");
  assert.equal(blocked.scope, "absolute");
  assert.equal(blocked.message, "Do not read .env files.");
  assert.equal(check("mcp__serena__read_file", { relative_path: "src/index.ts" }).allowed, true);
  // A read rule does not stop writing the same path.
  assert.equal(check("mcp__filesystem__write_file", { path: "config/.env", content: "X=1" }).allowed, true);
});

test("an MCP tool that writes is checked against write rules", async (t) => {
  const { check } = await guardStore(t);
  const byName = check("mcp__filesystem__write_file", { path: "locked/a.txt", content: "text" });
  assert.equal(byName.allowed, false);
  assert.equal(byName.rule_id, "no_lock_write");
  const byContent = check("mcp__notes__store", { file: "locked/b.txt", body: "text" });
  assert.equal(byContent.rule_id, "no_lock_write");
  assert.equal(check("mcp__serena__read_file", { relative_path: "locked/a.txt" }).allowed, true);
});

test("every path in a list argument is checked", async (t) => {
  const { check } = await guardStore(t);
  const result = check("mcp__x__tool", { paths: ["src/ok.ts", "config/.env"] });
  assert.equal(result.allowed, false);
  assert.equal(result.rule_id, "no_env_read");
});

test("a command argument of an MCP tool is checked against command rules", async (t) => {
  const { check } = await guardStore(t);
  const result = check("mcp__x__run_shell", { command: "git push --force" });
  assert.equal(result.allowed, false);
  assert.equal(result.rule_id, "no_force_push");
  assert.equal(check("mcp__x__run_shell", { command: "git push --force-with-lease" }).allowed, true);
  assert.equal(check("mcp__x__run_shell", { cmd: "cat config/.env" }).rule_id, "no_env_read");
});

test("tools without path or command arguments, and unparseable commands, are allowed", async (t) => {
  const { check } = await guardStore(t);
  assert.equal(check("mcp__serena__find_symbol", { name_path: "RuleStore" }).allowed, true);
  assert.equal(check("WebFetch", { url: "https://example.com/.env", prompt: "read" }).allowed, true);
  assert.equal(check("WebSearch", { query: "git push --force" }).allowed, true);
  assert.equal(check("mcp__x__run_shell", { command: "echo 'unterminated" }).allowed, true);
  assert.equal(check("mcp__x__tool", {}).allowed, true);
  // The built-in shell tool still refuses a command it cannot analyse.
  assert.equal(check("Bash", { command: "echo 'unterminated" }).allowed, false);
});

test("the hook asks the guard only when there is something to check", () => {
  assert.equal(guardChecksToolCall("Read", {}), true);
  assert.equal(guardChecksToolCall("apply_patch", { input: "*** Begin Patch" }), true);
  assert.equal(guardChecksToolCall("mcp__serena__read_file", { relative_path: "a.ts" }), true);
  assert.equal(guardChecksToolCall("mcp__x__run", { commands: ["ls"] }), true);
  assert.equal(guardChecksToolCall("mcp__serena__find_symbol", { name_path: "A" }), false);
  assert.equal(guardChecksToolCall("WebFetch", { url: "https://example.com" }), false);
  assert.equal(guardChecksToolCall("mcp__x__tool", { path: "" }), false);
});
