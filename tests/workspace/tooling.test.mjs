import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  WorkspaceTooling,
  commitExcludePathspecs,
  copyWorktreeIncludes,
  listIgnoredEntries,
  listUntrackedEntries,
  newEntries,
  runCommand,
} from "../../packages/core/dist/workspace-tooling.js";
import { parseClaudeMcpList, parseCodexMcpList, probeHttpServer, probeStdioServer } from "../../packages/core/dist/mcp-probe.js";
import { git } from "../helpers/git.mjs";
import { tempDir } from "../helpers/temp.mjs";

async function initRepo(dir) {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "--initial-branch=main");
  await writeFile(join(dir, "README.md"), "base\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "initial");
}

/** A CommandRunner that records every call, dispatches to per-command handlers, and otherwise falls back to the real runCommand (so git plumbing still works against real temp repos). */
function fakeRun(handlers) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    const handler = handlers[command];
    if (handler) return handler(args, options);
    if (command === "git") return runCommand(command, args, options);
    return { exit_code: 0, stdout: "", stderr: "", timed_out: false };
  };
  return { run, calls };
}

const okProbe = async () => ({ status: "ok", detail: "" });

// ---------------------------------------------------------------------------
// copyWorktreeIncludes
// ---------------------------------------------------------------------------

test("copyWorktreeIncludes: copies matching ignored files, skips the rest, never touches tracked files", async (t) => {
  const sourceRoot = await tempDir(t, "owl-wti-source-");
  await initRepo(sourceRoot);
  const worktree = await tempDir(t, "owl-wti-worktree-");

  await writeFile(join(sourceRoot, ".gitignore"), "copied.txt\npreexisting.txt\nlinked.txt\nnotlisted.txt\n");
  await writeFile(join(sourceRoot, ".worktreeinclude"), "copied.txt\npreexisting.txt\nlinked.txt\ntracked.txt\n");
  await writeFile(join(sourceRoot, "copied.txt"), "copied content\n");
  await writeFile(join(sourceRoot, "preexisting.txt"), "source content\n");
  await writeFile(join(sourceRoot, "notlisted.txt"), "not listed\n");
  await symlink("copied.txt", join(sourceRoot, "linked.txt"));
  await writeFile(join(sourceRoot, "tracked.txt"), "tracked\n");
  git(sourceRoot, "add", "tracked.txt");
  git(sourceRoot, "commit", "-m", "track a file also named in .worktreeinclude");

  await writeFile(join(worktree, "preexisting.txt"), "already there\n");

  const result = await copyWorktreeIncludes(sourceRoot, worktree);

  assert.deepEqual(result.copied, ["copied.txt"]);
  assert.equal(await readFile(join(worktree, "copied.txt"), "utf8"), "copied content\n");

  const reasons = Object.fromEntries(result.skipped.map((entry) => [entry.path, entry.reason]));
  assert.equal(reasons["preexisting.txt"], "destination already exists");
  assert.equal(await readFile(join(worktree, "preexisting.txt"), "utf8"), "already there\n", "the existing destination is not overwritten");
  assert.equal(reasons["linked.txt"], "source is a symlink");
  assert.equal("notlisted.txt" in reasons, false, "an ignored file not listed in .worktreeinclude is never a candidate");
  assert.equal("tracked.txt" in reasons, false, "a tracked file is never a candidate even if .worktreeinclude names it");
});

test("copyWorktreeIncludes: no .worktreeinclude means nothing is copied", async (t) => {
  const sourceRoot = await tempDir(t, "owl-wti-none-source-");
  await initRepo(sourceRoot);
  const worktree = await tempDir(t, "owl-wti-none-worktree-");
  const result = await copyWorktreeIncludes(sourceRoot, worktree);
  assert.deepEqual(result, { copied: [], skipped: [] });
});

// ---------------------------------------------------------------------------
// listUntrackedEntries / newEntries / commitExcludePathspecs
// ---------------------------------------------------------------------------

test("listUntrackedEntries and newEntries: a new untracked directory shows as one dir/ entry; ignored files never appear", async (t) => {
  const worktree = await tempDir(t, "owl-untracked-");
  await initRepo(worktree);
  await writeFile(join(worktree, ".gitignore"), "ignored.txt\n");
  git(worktree, "add", ".gitignore");
  git(worktree, "commit", "-m", "add gitignore");

  const before = await listUntrackedEntries(worktree);
  assert.deepEqual(before, []);

  await writeFile(join(worktree, "ignored.txt"), "skip me\n");
  await mkdir(join(worktree, "newdir"), { recursive: true });
  await writeFile(join(worktree, "newdir", "a.txt"), "a\n");
  await writeFile(join(worktree, "newdir", "b.txt"), "b\n");

  const after = await listUntrackedEntries(worktree);
  assert.deepEqual(after, ["newdir/"]);
  assert.deepEqual(newEntries(before, after), ["newdir/"]);
});

test("listIgnoredEntries lists ignored paths that listUntrackedEntries leaves out", async (t) => {
  const worktree = await tempDir(t, "owl-ignored-");
  await initRepo(worktree);
  await writeFile(join(worktree, ".gitignore"), "ignored.txt\ncache/\n");
  git(worktree, "add", ".gitignore");
  git(worktree, "commit", "-m", "add gitignore");

  await writeFile(join(worktree, "ignored.txt"), "skip me\n");
  await mkdir(join(worktree, "cache"), { recursive: true });
  await writeFile(join(worktree, "cache", "index.bin"), "x");

  assert.deepEqual((await listIgnoredEntries(worktree)).sort(), ["cache/", "ignored.txt"]);
});

test("commitExcludePathspecs: excludes only paths not already tracked in HEAD", async () => {
  const tracked = new Set(["existing/tracked.txt"]);
  const pathspecs = commitExcludePathspecs(
    ["new/file.txt", "newdir/", "existing/tracked.txt"],
    (path) => tracked.has(path),
  );
  assert.deepEqual(pathspecs, [":(exclude,literal)new/file.txt", ":(exclude,literal)newdir"]);
});

// ---------------------------------------------------------------------------
// probeStdioServer
// ---------------------------------------------------------------------------

const OK_SCRIPT = `
const fs = require("fs");
fs.writeFileSync(process.argv[2], String(process.pid));
process.stdin.on("data", (chunk) => {
  const line = chunk.toString("utf8").trim();
  if (!line) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\\n");
});
`;

const FAILING_SCRIPT = `
const fs = require("fs");
fs.writeFileSync(process.argv[2], String(process.pid));
process.stderr.write("boom: could not start\\n", () => process.exit(1));
`;

const HANGING_SCRIPT = `
const fs = require("fs");
fs.writeFileSync(process.argv[2], String(process.pid));
process.stdin.resume();
`;

async function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("probeStdioServer: a server that answers initialize is ok, and is killed afterwards", async (t) => {
  const dir = await tempDir(t, "owl-probe-ok-");
  const scriptPath = join(dir, "server.js");
  const pidFile = join(dir, "pid.txt");
  await writeFile(scriptPath, OK_SCRIPT);

  const result = await probeStdioServer({ command: process.execPath, args: [scriptPath, pidFile], env: process.env, cwd: dir }, 3_000);
  assert.equal(result.status, "ok");

  await new Promise((resolve) => setTimeout(resolve, 300));
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.equal(await isAlive(pid), false, "the probed process is killed once it responds");
});

test("probeStdioServer: a server that exits immediately reports failed with its stderr", async (t) => {
  const dir = await tempDir(t, "owl-probe-fail-");
  const scriptPath = join(dir, "server.js");
  const pidFile = join(dir, "pid.txt");
  await writeFile(scriptPath, FAILING_SCRIPT);

  const result = await probeStdioServer({ command: process.execPath, args: [scriptPath, pidFile], env: process.env, cwd: dir }, 3_000);
  assert.equal(result.status, "failed");
  assert.match(result.detail, /boom: could not start/);
});

test("probeStdioServer: a server that never answers times out, and the child is killed", async (t) => {
  const dir = await tempDir(t, "owl-probe-timeout-");
  const scriptPath = join(dir, "server.js");
  const pidFile = join(dir, "pid.txt");
  await writeFile(scriptPath, HANGING_SCRIPT);

  const start = Date.now();
  const result = await probeStdioServer({ command: process.execPath, args: [scriptPath, pidFile], env: process.env, cwd: dir }, 500);
  assert.equal(result.status, "timeout");
  assert.ok(Date.now() - start < 3_000, "the probe resolves close to its own timeout, not the SIGKILL grace period");

  await new Promise((resolve) => setTimeout(resolve, 300));
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.equal(await isAlive(pid), false, "a hung process is killed once the probe times out");
});

// ---------------------------------------------------------------------------
// probeHttpServer
// ---------------------------------------------------------------------------

async function withHttpServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  try {
    await callback(`http://127.0.0.1:${port}/`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("probeHttpServer: a plain JSON response is ok", async () => {
  await withHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
  }, async (url) => {
    const result = await probeHttpServer({ url, headers: {} }, 2_000);
    assert.equal(result.status, "ok");
  });
});

test("probeHttpServer: an SSE response is ok", async () => {
  await withHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n\n`);
    res.end();
  }, async (url) => {
    const result = await probeHttpServer({ url, headers: {} }, 2_000);
    assert.equal(result.status, "ok");
  });
});

test("probeHttpServer: 401 is unverified, not failed", async () => {
  await withHttpServer((req, res) => { res.writeHead(401); res.end("nope"); }, async (url) => {
    const result = await probeHttpServer({ url, headers: {} }, 2_000);
    assert.equal(result.status, "unverified");
    assert.match(result.detail, /401/);
  });
});

test("probeHttpServer: 500 is failed", async () => {
  await withHttpServer((req, res) => { res.writeHead(500); res.end("boom"); }, async (url) => {
    const result = await probeHttpServer({ url, headers: {} }, 2_000);
    assert.equal(result.status, "failed");
    assert.match(result.detail, /500/);
  });
});

// ---------------------------------------------------------------------------
// parseClaudeMcpList / parseCodexMcpList
// ---------------------------------------------------------------------------

const CLAUDE_MCP_LIST_SAMPLE = `Checking MCP server health…

claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected
claude.ai Canva: https://mcp.canva.com/mcp - ! Needs authentication
serena: serena start-mcp-server --project-from-cwd - ✔ Connected
broken: node /nope.js - ✘ Failed to connect
dropped: node /gone.js - ✘ Disconnected
`;

test("parseClaudeMcpList: classifies each server line and ignores banners/blank lines", () => {
  const parsed = parseClaudeMcpList(CLAUDE_MCP_LIST_SAMPLE);
  assert.deepEqual(parsed.map((server) => [server.name, server.status]), [
    ["claude.ai Claude Docs", "ok"],
    ["claude.ai Canva", "unverified"],
    ["serena", "ok"],
    ["broken", "failed"],
    ["dropped", "failed"],
  ]);
  assert.equal(parsed[3].detail, "✘ Failed to connect");
  assert.ok(parsed.every((server) => server.harness === "claude"));
});

const CODEX_MCP_LIST_SAMPLE = JSON.stringify([
  {
    name: "code-review-graph",
    enabled: true,
    transport: { type: "stdio", command: "/opt/homebrew/bin/uvx", args: ["--with", "rich", "code-review-graph", "serve"], env: null, env_vars: [], cwd: null },
    startup_timeout_sec: null,
    auth_status: "unsupported",
  },
  {
    name: "codex_app",
    enabled: false,
    transport: { type: "stdio", command: "/x/launch", args: ["./server.mjs"], env: {}, env_vars: ["HOME", "PATH"], cwd: "/x" },
    startup_timeout_sec: 10.0,
  },
]);

test("parseCodexMcpList: keeps only enabled servers and normalizes their transport", () => {
  const parsed = parseCodexMcpList(CODEX_MCP_LIST_SAMPLE);
  assert.deepEqual(parsed, [
    {
      name: "code-review-graph",
      transport: { type: "stdio", command: "/opt/homebrew/bin/uvx", args: ["--with", "rich", "code-review-graph", "serve"], env: {}, cwd: null },
    },
  ]);
});

test("parseCodexMcpList: returns null for invalid JSON", () => {
  assert.equal(parseCodexMcpList("not json"), null);
  assert.equal(parseCodexMcpList('{"not":"an array"}'), null);
});

test("parseCodexMcpList: normalizes a non-stdio transport into the http shape", () => {
  const sample = JSON.stringify([
    { name: "remote", enabled: true, transport: { type: "streamable_http", url: "https://example.invalid/mcp", http_headers: { "x-a": "1" }, bearer_token_env_var: "REMOTE_TOKEN" } },
  ]);
  const parsed = parseCodexMcpList(sample);
  assert.deepEqual(parsed, [
    { name: "remote", transport: { type: "http", url: "https://example.invalid/mcp", headers: { "x-a": "1" }, bearer_token_env_var: "REMOTE_TOKEN" } },
  ]);
});

// ---------------------------------------------------------------------------
// WorkspaceTooling
// ---------------------------------------------------------------------------

async function repoPair(t, prefix) {
  const sourceRoot = await tempDir(t, `owl-wt-${prefix}-source-`);
  await initRepo(sourceRoot);
  const worktree = await tempDir(t, `owl-wt-${prefix}-worktree-`);
  await initRepo(worktree);
  return { sourceRoot, worktree };
}

test("WorkspaceTooling.prepareNewWorktree: runs setup with the right cwd/env and marks the worktree fresh for refreshBeforeRun", async (t) => {
  const { sourceRoot, worktree } = await repoPair(t, "setup");
  const setupCalls = [];
  const refreshCalls = [];
  const { run } = fakeRun({
    "run-setup": (args, options) => { setupCalls.push({ args, options }); return { exit_code: 0, stdout: "", stderr: "", timed_out: false }; },
    "run-refresh": (args, options) => { refreshCalls.push({ args, options }); return { exit_code: 0, stdout: "", stderr: "", timed_out: false }; },
  });
  const tooling = new WorkspaceTooling({ run, probeStdio: okProbe, probeHttp: okProbe, env: () => ({ PATH: process.env.PATH }), harnesses: () => [], home: tmpdir() });

  const commands = { setup: ["run-setup", "--flag"], refresh: ["run-refresh"] };
  const outcome = await tooling.prepareNewWorktree({ projectKey: "setup-project", sourceRoot, worktree, commands });

  assert.equal(setupCalls.length, 1);
  assert.equal(setupCalls[0].args[0], "--flag");
  assert.equal(setupCalls[0].options.cwd, worktree);
  assert.equal(setupCalls[0].options.env.OWL_WORKTREE, worktree);
  assert.equal(setupCalls[0].options.env.OWL_SOURCE_ROOT, sourceRoot);
  assert.equal(outcome.setup.exit_code, 0);

  const firstRefresh = await tooling.refreshBeforeRun({ worktree, sourceRoot, commands });
  assert.equal(firstRefresh, null, "the first refresh after setup is skipped");
  assert.equal(refreshCalls.length, 0);

  const secondRefresh = await tooling.refreshBeforeRun({ worktree, sourceRoot, commands });
  assert.equal(secondRefresh.result.exit_code, 0);
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].options.cwd, worktree);
});

test("WorkspaceTooling.prepareNewWorktree: does not rehearse twice for the same fingerprint, but does once a config file's mtime changes", async (t) => {
  const { sourceRoot, worktree } = await repoPair(t, "fingerprint");
  let claudeCalls = 0;
  const { run } = fakeRun({
    claude: () => { claudeCalls += 1; return { exit_code: 0, stdout: "svc: cmd -  ✔ Connected\n", stderr: "", timed_out: false }; },
  });
  const tooling = new WorkspaceTooling({ run, probeStdio: okProbe, probeHttp: okProbe, env: () => ({}), harnesses: () => ["claude"], home: tmpdir() });
  const commands = { setup: null, refresh: null };

  const first = await tooling.prepareNewWorktree({ projectKey: "fp-project", sourceRoot, worktree, commands });
  assert.equal(claudeCalls, 1);
  assert.ok(first.rehearsal);

  const second = await tooling.prepareNewWorktree({ projectKey: "fp-project", sourceRoot, worktree, commands });
  assert.equal(claudeCalls, 1, "same fingerprint: no re-rehearsal");
  assert.equal(second.rehearsal, null);

  const mcpJson = join(sourceRoot, ".mcp.json");
  await writeFile(mcpJson, "{}");
  const future = new Date(Date.now() + 60_000);
  await utimes(mcpJson, future, future);

  const third = await tooling.prepareNewWorktree({ projectKey: "fp-project", sourceRoot, worktree, commands });
  assert.equal(claudeCalls, 2, "a changed fingerprint file triggers rehearsal again");
  assert.ok(third.rehearsal);
});

test("WorkspaceTooling.prepareNewWorktree: reports a codex server missing from the worktree", async (t) => {
  const { sourceRoot, worktree } = await repoPair(t, "missing");
  const worktreeServers = JSON.stringify([
    { name: "alpha", enabled: true, transport: { type: "stdio", command: "echo", args: [], env: null, env_vars: [] } },
  ]);
  const sourceServers = JSON.stringify([
    { name: "alpha", enabled: true, transport: { type: "stdio", command: "echo", args: [], env: null, env_vars: [] } },
    { name: "beta", enabled: true, transport: { type: "stdio", command: "echo", args: [], env: null, env_vars: [] } },
  ]);
  const { run } = fakeRun({
    codex: (args, options) => ({
      exit_code: 0,
      stdout: options.cwd === worktree ? worktreeServers : sourceServers,
      stderr: "",
      timed_out: false,
    }),
  });
  const tooling = new WorkspaceTooling({ run, probeStdio: okProbe, probeHttp: okProbe, env: () => ({}), harnesses: () => ["codex"], home: tmpdir() });

  const outcome = await tooling.prepareNewWorktree({ projectKey: "missing-project", sourceRoot, worktree, commands: { setup: null, refresh: null } });
  const missing = outcome.rehearsal.problems.filter((problem) => problem.kind === "missing_in_worktree");
  assert.equal(missing.length, 1);
  assert.equal(missing[0].server, "beta");
});

test("WorkspaceTooling.prepareNewWorktree: reports an untrusted codex project when config.toml servers are absent from codex mcp list", async (t) => {
  const { sourceRoot, worktree } = await repoPair(t, "untrusted");
  await mkdir(join(sourceRoot, ".codex"), { recursive: true });
  await writeFile(join(sourceRoot, ".codex", "config.toml"), '[mcp_servers.alpha]\ncommand = "alpha-cmd"\n\n[mcp_servers.beta]\ncommand = "beta-cmd"\n');
  const { run } = fakeRun({
    codex: () => ({ exit_code: 0, stdout: "[]", stderr: "", timed_out: false }),
  });
  const tooling = new WorkspaceTooling({ run, probeStdio: okProbe, probeHttp: okProbe, env: () => ({}), harnesses: () => ["codex"], home: tmpdir() });

  const outcome = await tooling.prepareNewWorktree({ projectKey: "untrusted-project", sourceRoot, worktree, commands: { setup: null, refresh: null } });
  const untrusted = outcome.rehearsal.problems.filter((problem) => problem.kind === "codex_project_untrusted");
  assert.equal(untrusted.length, 1);
  assert.equal(outcome.rehearsal.problems.some((problem) => problem.kind === "missing_in_worktree"), false);
});

test("WorkspaceTooling.prepareNewWorktree: tool_state_paths captures a directory the rehearsal step creates", async (t) => {
  const { sourceRoot, worktree } = await repoPair(t, "toolstate");
  const { run } = fakeRun({
    claude: async (args, options) => {
      await mkdir(join(options.cwd, "cache-dir"), { recursive: true });
      await writeFile(join(options.cwd, "cache-dir", "state.json"), "{}");
      return { exit_code: 0, stdout: "svc: cmd -  ✔ Connected\n", stderr: "", timed_out: false };
    },
  });
  const tooling = new WorkspaceTooling({ run, probeStdio: okProbe, probeHttp: okProbe, env: () => ({}), harnesses: () => ["claude"], home: tmpdir() });

  const outcome = await tooling.prepareNewWorktree({ projectKey: "toolstate-project", sourceRoot, worktree, commands: { setup: null, refresh: null } });
  assert.deepEqual(outcome.tool_state_paths, ["cache-dir/"]);
});

test("WorkspaceTooling: tool_state_paths includes ignored output from setup and from a later refresh", async (t) => {
  const { sourceRoot, worktree } = await repoPair(t, "ignored-state");
  await writeFile(join(worktree, ".gitignore"), "node_modules/\n.index/\n");
  git(worktree, "add", ".gitignore");
  git(worktree, "commit", "-m", "add gitignore");
  const { run } = fakeRun({
    "run-setup": async (args, options) => {
      await mkdir(join(options.cwd, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(options.cwd, "node_modules", "pkg", "index.js"), "");
      return { exit_code: 0, stdout: "", stderr: "", timed_out: false };
    },
    "run-refresh": async (args, options) => {
      await mkdir(join(options.cwd, ".index"), { recursive: true });
      await writeFile(join(options.cwd, ".index", "db"), "");
      return { exit_code: 0, stdout: "", stderr: "", timed_out: false };
    },
  });
  const tooling = new WorkspaceTooling({ run, probeStdio: okProbe, probeHttp: okProbe, env: () => ({}), harnesses: () => [], home: tmpdir() });
  const commands = { setup: ["run-setup"], refresh: ["run-refresh"] };

  const outcome = await tooling.prepareNewWorktree({ projectKey: "ignored-state-project", sourceRoot, worktree, commands });
  assert.deepEqual(outcome.tool_state_paths, ["node_modules/"]);

  assert.equal(await tooling.refreshBeforeRun({ worktree, sourceRoot, commands }), null, "the first refresh after setup is skipped");
  await writeFile(join(worktree, "agent-note.txt"), "written by the agent between runs\n");
  const refreshed = await tooling.refreshBeforeRun({ worktree, sourceRoot, commands });
  assert.deepEqual(refreshed.tool_state_paths, [".index/"]);
});

test("WorkspaceTooling.alertFor: dedupes an unchanged problem set and reports recovery once", () => {
  const tooling = new WorkspaceTooling({ run: async () => ({ exit_code: 0, stdout: "", stderr: "", timed_out: false }), env: () => ({}), harnesses: () => [], home: tmpdir() });
  const problem = { harness: "claude", server: "x", kind: "failed", detail: "boom" };

  assert.deepEqual(tooling.alertFor("P", [problem]), { kind: "agent_tooling_mismatch", problems: [problem] });
  assert.equal(tooling.alertFor("P", [problem]), null, "the same problem set is not re-alerted");
  assert.deepEqual(tooling.alertFor("P", []), { kind: "agent_tooling_recovered" });
  assert.equal(tooling.alertFor("P", []), null, "recovery is only reported once");

  const other = { harness: "codex", server: "y", kind: "timeout", detail: "slow" };
  assert.deepEqual(tooling.alertFor("P", [other]), { kind: "agent_tooling_mismatch", problems: [other] });
});

test("WorkspaceTooling.refreshBeforeRun: serializes calls for the same worktree but not across worktrees", async () => {
  const calls = [];
  const { run } = fakeRun({
    "run-refresh": async () => {
      const call = { start: performance.now() };
      await new Promise((resolve) => setTimeout(resolve, 60));
      call.end = performance.now();
      calls.push(call);
      return { exit_code: 0, stdout: "", stderr: "", timed_out: false };
    },
  });
  const tooling = new WorkspaceTooling({ run, env: () => ({}), harnesses: () => [], home: tmpdir() });
  const commands = { setup: null, refresh: ["run-refresh"] };

  calls.length = 0;
  await Promise.all([
    tooling.refreshBeforeRun({ worktree: "/wt/same-a", sourceRoot: "/src", commands }),
    tooling.refreshBeforeRun({ worktree: "/wt/same-a", sourceRoot: "/src", commands }),
  ]);
  assert.equal(calls.length, 2);
  const sameWorktree = [...calls].sort((a, b) => a.start - b.start);
  assert.ok(sameWorktree[1].start >= sameWorktree[0].end, "the second call on the same worktree waits for the first");

  calls.length = 0;
  await Promise.all([
    tooling.refreshBeforeRun({ worktree: "/wt/diff-a", sourceRoot: "/src", commands }),
    tooling.refreshBeforeRun({ worktree: "/wt/diff-b", sourceRoot: "/src", commands }),
  ]);
  assert.equal(calls.length, 2);
  const differentWorktrees = [...calls].sort((a, b) => a.start - b.start);
  assert.ok(differentWorktrees[1].start < differentWorktrees[0].end, "calls on different worktrees overlap");
});
