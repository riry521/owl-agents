import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runExecutor } from "../packages/core/dist/executor.js";

function executorTask(subtaskId, instruction, workspaceDir, task = {}) {
  return {
    subtask_id: subtaskId,
    instruction,
    workspace_dir: workspaceDir,
    task: { title: "Executor Task", acceptance: "It works.", context: "", rules: null, owner_guidance: [], ...task },
  };
}

async function fakeClaude(root, resultJson, captureArgs = false) {
  const executable = join(root, "claude");
  await writeFile(executable, `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const result = ${JSON.stringify(resultJson)};
  if (${captureArgs}) result.result = JSON.stringify({ result: result.result, args: process.argv.slice(2) });
  process.stdout.write(JSON.stringify(result));
});
`);
  await chmod(executable, 0o755);
  return executable;
}

async function withClaudeOnPath(root, resultJson, run) {
  const previousPath = process.env.PATH;
  await fakeClaude(root, resultJson);
  process.env.PATH = [root, previousPath ?? ""].filter(Boolean).join(":");
  try {
    return await run();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

test("a Claude Executor result with is_error true fails even though the process exited cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-executor-claude-error-"));
  const result = await withClaudeOnPath(root, { type: "result", is_error: true, result: "boom" }, () =>
    runExecutor(
      executorTask("claude-error", "inspect the changes", root),
      { provider: "claude", model: "claude-sonnet-5", timeout_ms: 1000 },
    ));
  assert.equal(result.success, false);
  assert.match(result.output, /Executor reported an error/);
});

test("a Claude Executor result with a non-success subtype fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-executor-claude-subtype-"));
  const result = await withClaudeOnPath(root, { type: "result", subtype: "error_max_turns", result: "gave up" }, () =>
    runExecutor(
      executorTask("claude-subtype", "inspect the changes", root),
      { provider: "claude", model: "claude-sonnet-5", timeout_ms: 1000 },
    ));
  assert.equal(result.success, false);
  assert.match(result.output, /Executor reported an error/);
});

test("a normal Claude Executor result still succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-executor-claude-success-"));
  const result = await withClaudeOnPath(root, { type: "result", subtype: "success", result: "all good" }, () =>
    runExecutor(
      executorTask("claude-success", "inspect the changes", root),
      { provider: "claude", model: "claude-sonnet-5", timeout_ms: 1000 },
    ));
  assert.equal(result.success, true);
  assert.equal(result.output, "all good");
});

test("Claude Executor keeps the hook settings and user instruction exclusions in one settings argument", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-executor-claude-argv-"));
  const executable = await fakeClaude(root, { type: "result", subtype: "success", result: "captured" }, true);
  const runtimeEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root,
    CLAUDE_CONFIG_DIR: join(root, "claude-config"),
  };
  const result = await runExecutor(
    executorTask("claude-argv", "inspect argv", root),
    { provider: "claude", model: "claude-sonnet-5", timeout_ms: 1000 },
    {},
    { owlRoot: process.cwd(), env: runtimeEnv, executables: { claude: executable } },
  );
  assert.equal(result.success, true, result.output);
  const captured = JSON.parse(result.output);
  assert.equal(captured.result, "captured");
  const settingsArgs = captured.args.flatMap((arg, index, args) => arg === "--settings" ? [args[index + 1]] : []);
  assert.equal(settingsArgs.length, 1);
  assert.ok(JSON.parse(settingsArgs[0]).claudeMdExcludes);
});

test("the Executor process receives its run id and subtask id as environment variables", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-executor-claude-env-"));
  const executable = join(root, "claude");
  await writeFile(executable, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  const text = JSON.stringify({ runId: process.env.OWL_AGENT_RUN_ID ?? null, subtaskId: process.env.OWL_AGENT_SUBTASK_ID ?? null });
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: text }));
});
`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = [root, previousPath ?? ""].filter(Boolean).join(":");
  try {
    const result = await runExecutor(
      executorTask("env-subtask", "inspect the changes", root),
      { provider: "claude", model: "claude-sonnet-5", timeout_ms: 1000 },
      { agent_run_id: "run-abc123" },
    );
    assert.equal(result.success, true, result.output);
    const reported = JSON.parse(result.output);
    assert.equal(reported.runId, "run-abc123");
    assert.equal(reported.subtaskId, "env-subtask");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
