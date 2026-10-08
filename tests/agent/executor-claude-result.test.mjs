import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { runExecutor, runExecutorProcess } from "../../packages/core/dist/executor.js";
import { repoRoot } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

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
  await writeFile(executable, `#!${process.execPath}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const result = ${JSON.stringify(resultJson)};
  if (${captureArgs}) result.result = JSON.stringify({ result: result.result, args: process.argv.slice(2) });
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n" + JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }) + "\\n" + JSON.stringify(result) + "\\n");
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

test("a Claude Executor result with is_error true fails even though the process exited cleanly", async (t) => {
  const root = await tempDir(t, "owl-executor-claude-error-");
  const result = await withClaudeOnPath(root, { type: "result", is_error: true, result: "boom" }, () =>
    runExecutor(
      executorTask("claude-error", "inspect the changes", root),
      { provider: "claude", model: "claude-sonnet-5", timeout_ms: 1000 },
    ));
  assert.equal(result.success, false);
  assert.match(result.output, /Executor reported an error/);
});

test("a Claude Executor result with a non-success subtype fails", async (t) => {
  const root = await tempDir(t, "owl-executor-claude-subtype-");
  const result = await withClaudeOnPath(root, { type: "result", subtype: "error_max_turns", result: "gave up" }, () =>
    runExecutor(
      executorTask("claude-subtype", "inspect the changes", root),
      { provider: "claude", model: "claude-sonnet-5", timeout_ms: 1000 },
    ));
  assert.equal(result.success, false);
  assert.match(result.output, /Executor reported an error/);
});

test("a normal Claude Executor result still succeeds", async (t) => {
  const root = await tempDir(t, "owl-executor-claude-success-");
  const result = await withClaudeOnPath(root, { type: "result", subtype: "success", result: "all good" }, () =>
    runExecutor(
      executorTask("claude-success", "inspect the changes", root),
      { provider: "claude", model: "claude-sonnet-5", timeout_ms: 1000 },
    ));
  assert.equal(result.success, true);
  assert.equal(result.output, "all good");
});

test("Claude Executor keeps the hook settings and user instruction exclusions in one settings argument", async (t) => {
  const root = await tempDir(t, "owl-executor-claude-argv-");
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
  assert.equal(captured.args[captured.args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(captured.args.includes("--verbose"));
  const settingsArgs = captured.args.flatMap((arg, index, args) => arg === "--settings" ? [args[index + 1]] : []);
  assert.equal(settingsArgs.length, 1);
  assert.ok(JSON.parse(settingsArgs[0]).claudeMdExcludes);
});

test("the Executor process receives its run id and subtask id as environment variables", async (t) => {
  const root = await tempDir(t, "owl-executor-claude-env-");
  const executable = join(root, "claude");
  await writeFile(executable, `#!${process.execPath}
process.stdin.resume();
process.stdin.on("end", () => {
  const text = JSON.stringify({ runId: process.env.OWL_AGENT_RUN_ID ?? null, subtaskId: process.env.OWL_AGENT_SUBTASK_ID ?? null });
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n" + JSON.stringify({ type: "result", subtype: "success", result: text }) + "\\n");
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

// Fake Claude whose requests follow USAGE_PLAN=[prompt tokens, ...] in the prompt. It stands in for the relay hook by
// polling the state file, hands off when Owl asks, and otherwise ends with an owl-child-report. HANG_AFTER_PLAN makes it
// wait to be stopped; MEMO_MIDSTREAM makes its first request carry a handoff memo.
async function fakeRelayClaude(root) {
  const executable = join(root, "claude-relay");
  await writeFile(executable, `#!${process.execPath}
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  const memo = (summary) => "\`\`\`owl-child-handoff\\n" + JSON.stringify({ summary, done: ["a"], remaining: ["b"], next_steps: ["c"], changed_files: ["x.txt"], notes: "n" }) + "\\n\`\`\`";
  const record = (extra) => fs.writeFileSync(process.env.RECORD_FILE, JSON.stringify({ args: process.argv.slice(2), stateFile: process.env.OWL_RELAY_STATE_FILE ?? null, prompt, ...extra }));
  const request = (id, tokens, text, extra = {}) => ({ type: "assistant", ...extra, message: { id, model: "claude-haiku-5-5", usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, cache_creation_input_tokens: 0, output_tokens: 5 }, content: [{ type: "text", text }] } });
  // Recorded before any usage line so that Owl stopping the child cannot cut the record short.
  if (prompt.includes("HANG_AFTER_PLAN")) record({});
  out(request("msg_sub", 200000, "subagent", { parent_tool_use_id: "toolu_1" }));
  JSON.parse(/USAGE_PLAN=(\\[[^\\]]*\\])/.exec(prompt)[1]).forEach((tokens, index) => {
    const line = request("msg_" + index, tokens, index === 0 && prompt.includes("MEMO_MIDSTREAM") ? memo("mid") : "step");
    out(line);
    out(line);
  });
  if (prompt.includes("HANG_AFTER_PLAN")) { setInterval(() => {}, 1000); return; }
  const deadline = Date.now() + 500;
  const poll = () => {
    let state = null;
    try { state = JSON.parse(fs.readFileSync(process.env.OWL_RELAY_STATE_FILE, "utf8")); } catch {}
    if (state?.phase === "handoff") {
      record({ stateMessage: state.message });
      out({ type: "result", subtype: "success", result: "Handing off.\\n" + memo("final") });
    } else if (Date.now() > deadline) {
      record({});
      out({ type: "result", subtype: "success", result: "\`\`\`owl-child-report\\n{}\\n\`\`\`" });
    } else setTimeout(poll, 20);
  };
  poll();
});
`);
  await chmod(executable, 0o755);
  return executable;
}

async function runRelayChild(t, { model = "claude-haiku-5-5", relay, plan, marks = "", env = {} }) {
  const root = await tempDir(t, "owl-executor-relay-");
  const executable = await fakeRelayClaude(root);
  const recordFile = join(root, "record.json");
  const requests = [];
  const sink = { usage: null };
  const result = await runExecutorProcess(
    executorTask("relay", `USAGE_PLAN=${JSON.stringify(plan)} ${marks}`, root),
    { provider: "claude", model, timeout_ms: 10000, ...(relay ? { relay } : {}) },
    { onRequestUsage: (usage) => requests.push(usage) },
    sink,
    { owlRoot: repoRoot, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude-config"), RECORD_FILE: recordFile, ...env }, executables: { claude: executable } },
  );
  return { result, sink, requests, record: JSON.parse(await readFile(recordFile, "utf8")) };
}

const RELAY = { handoff_tokens: 70000, kill_tokens: 95000 };

test("a relay-watched child past handoff_tokens is told to hand off and returns its memo in the result's relay", async (t) => {
  const { result, requests, record } = await runRelayChild(t, { relay: RELAY, plan: [1000, 72000] });
  assert.equal(result.success, true, result.output);
  assert.equal(result.relay.reason, "handoff");
  assert.equal(result.relay.memo.summary, "final");
  assert.deepEqual(result.relay.memo.changed_files, ["x.txt"]);
  assert.equal(result.relay.peak_prompt_tokens, 72000, "the subagent's 200000-token request is not the child's own context");
  assert.match(record.stateMessage, /reached 72000 tokens, over the handoff limit of 70000.*stops this session at 95000/s);
  assert.match(record.prompt, /## Context budget/);
  assert.equal(typeof record.stateFile, "string");
  assert.ok(record.args.join(" ").includes("PreCompact"));
  assert.deepEqual(requests.map((u) => [u.message_id, u.prompt_tokens, u.subagent]), [["msg_sub", 200000, true], ["msg_0", 1000, false], ["msg_1", 72000, false]]);
  assert.equal(existsSync(dirname(record.stateFile)), false, "the segment's state directory is removed");
});

test("the handoff limit comes from the config: the same plan under a higher handoff_tokens finishes normally", async (t) => {
  const { result, record } = await runRelayChild(t, { relay: { handoff_tokens: 80000, kill_tokens: 95000 }, plan: [1000, 72000] });
  assert.equal(result.success, true, result.output);
  assert.equal(result.relay, undefined);
  assert.match(result.output, /owl-child-report/);
  assert.equal(record.stateMessage, undefined);
});

test("a relay-watched child past kill_tokens is stopped and the memo it streamed goes into the result's relay", async (t) => {
  const { result, sink } = await runRelayChild(t, { relay: RELAY, plan: [1000, 96000], marks: "HANG_AFTER_PLAN MEMO_MIDSTREAM" });
  assert.equal(result.success, false);
  assert.equal(result.failure_kind, "exit_code");
  assert.match(result.output, /stopped at 96000 prompt tokens \(token relay stop limit 95000\)/);
  assert.deepEqual([result.relay.reason, result.relay.memo?.summary, result.relay.peak_prompt_tokens], ["kill", "mid", 96000]);
  assert.ok(sink.usage.cache_read_tokens >= 96000 - 10, "usage of a stopped child comes from its tracked requests");
});

test("a child Owl does not watch gets no relay state file, not even one inherited from the server env", async (t) => {
  const { result, record } = await runRelayChild(t, { model: "claude-sonnet-5-5", plan: [1000, 96000], env: { OWL_RELAY_STATE_FILE: "/tmp/inherited-state.json" } });
  assert.equal(result.success, true, result.output);
  assert.equal(result.relay, undefined);
  assert.equal(record.stateFile, null);
  assert.equal(record.args.join(" ").includes("PreCompact"), false);
  assert.doesNotMatch(record.prompt, /## Context budget/);
});

test("Claude Executor reports streamed output to its run observer", async (t) => {
  const root = await tempDir(t, "owl-executor-progress-");
  let outputs = 0;
  const result = await withClaudeOnPath(root, { type: "result", subtype: "success", result: "done" }, () =>
    runExecutor(executorTask("progress", "inspect", root),
      { provider: "claude", model: "claude-sonnet-5", timeout_ms: 1000 },
      { onOutput: () => { outputs += 1; } }));
  assert.equal(result.success, true);
  assert.ok(outputs > 0);
});
