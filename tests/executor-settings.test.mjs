import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { defaultExecutorRuntime, runExecutor } from "../packages/core/dist/executor.js";
import { MINIMAL_CODE_RULES, WORKING_STYLE_RULES } from "../packages/shared/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";
import { buildWorkArgv } from "../packages/providers/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function executorTask(subtaskId, instruction, workspaceDir, task = {}) {
  return {
    subtask_id: subtaskId,
    instruction,
    workspace_dir: workspaceDir,
    task: { title: "Executor Task", acceptance: "It works.", context: "", rules: null, owner_guidance: [], ...task },
  };
}

test("Executor accepts provider IDs from the Web UI and stores CLI harness IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-executor-settings-"));
  const db = openDatabase(join(root, "owl.db"));
  try {
    db.migrate(join(repoRoot, "packages/db/migrations"));
    const core = new Core({ db, agentRunner: {}, version: "test", owlRoot: root });

    assert.deepEqual(await core.setExecutorConfig({
      provider: "openai", model: "gpt-6-sol", effort: "xhigh", timeout_ms: 0,
    }), { provider: "codex", model: "gpt-6-sol", effort: "xhigh", timeout_ms: 0 });
    assert.deepEqual(await core.getExecutorConfig(), {
      provider: "codex", model: "gpt-6-sol", effort: "xhigh", timeout_ms: 0,
    });

    assert.deepEqual(await core.setExecutorConfig({
      provider: "anthropic", model: "claude-sonnet-5", effort: "high", timeout_ms: 0,
    }), { provider: "claude", model: "claude-sonnet-5", effort: "high", timeout_ms: 0 });
    const currentModels = core.getModelSettings();
    const updatedModels = await core.updateModelSettings({
      request_id: createUlid(),
      idempotency_key: "test:xhigh-model-settings",
      expected_version: currentModels.version,
      payload: {
        roles: currentModels.roles.map(({ role, provider, model, effort }) => ({
          role, provider, model, effort: role === "worker" ? "xhigh" : effort,
        })),
      },
    });
    assert.equal(updatedModels.data.roles.find(({ role }) => role === "worker")?.effort, "xhigh");
    await assert.rejects(
      () => core.setExecutorConfig({ provider: "unknown", model: "x", timeout_ms: 0 }),
      (error) => error?.code === "validation_error",
    );
  } finally {
    db.close();
  }
});

test("default Executor runtime carries provider config roots into the child environment", () => {
  const previous = {
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  process.env.CODEX_HOME = "/tmp/owl-test-codex-home";
  process.env.CLAUDE_CONFIG_DIR = "/tmp/owl-test-claude-config";
  try {
    const env = defaultExecutorRuntime().env;
    assert.equal(env.CODEX_HOME, process.env.CODEX_HOME);
    assert.equal(env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
  } finally {
    if (previous.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.CODEX_HOME;
    if (previous.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous.CLAUDE_CONFIG_DIR;
  }
});

function provider(adapter) {
  return {
    adapter,
    adapterVersion: "test-version",
    logicalProvider: adapter === "claude-cli/v1" ? "claude" : "codex",
    contractVersion: "1.0.0",
    executablePath: "/usr/local/bin/agent",
    executableSha256: "test-hash",
    lockPath: "/tmp/provider-lock.json",
  };
}

test("Claude provider argv keeps its hook and adds user instruction exclusions in one settings argument", () => {
  const args = buildWorkArgv(provider("claude-cli/v1"), "claude-sonnet-5", "work", {
    owlRoot: process.cwd(),
    env: { HOME: "/tmp/owl-provider-home", CLAUDE_CONFIG_DIR: "/tmp/owl-provider-claude" },
  });
  const settingsArgs = args.flatMap((arg, index) => arg === "--settings" ? [args[index + 1]] : []);
  assert.equal(settingsArgs.length, 1);
  assert.ok(JSON.parse(settingsArgs[0]).claudeMdExcludes);
});

test("Codex provider argv adds the bundled marketplace exclusion config", () => {
  const args = buildWorkArgv(provider("codex-cli/v1"), "gpt-6-sol", "work", {
    owlRoot: process.cwd(),
    env: { HOME: "/tmp/owl-provider-home", CODEX_HOME: "/tmp/owl-provider-codex" },
  });
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.some((arg) => arg.startsWith("marketplaces.openai-bundled.source=")));
});

test("Codex provider resume argv uses sandbox_mode config instead of --sandbox", () => {
  const args = buildWorkArgv(provider("codex-cli/v1"), "gpt-6-sol", "Continue", {
    owlRoot: process.cwd(),
    env: { HOME: "/tmp/owl-provider-home", CODEX_HOME: "/tmp/owl-provider-codex" },
    resume: true,
    sessionId: "saved-codex-session",
  });
  assert.deepEqual(args.slice(1, 4), ["exec", "resume", "--json"]);
  assert.deepEqual(args.slice(args.indexOf("saved-codex-session")), ["saved-codex-session", "--", "Continue"]);
  assert.equal(args.includes("--sandbox"), false);
  assert.ok(args.includes('sandbox_mode="danger-full-access"'));
});

test("Codex provider resume argv requires a session ID", () => {
  assert.throws(() => buildWorkArgv(provider("codex-cli/v1"), "gpt-6-sol", "Continue", {
    owlRoot: process.cwd(),
    resume: true,
  }), TypeError);
});

test("Codex Executor passes xhigh effort to the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-executor-effort-"));
  const executable = join(root, "codex");
  await writeFile(executable, `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const result = JSON.stringify({ args: process.argv.slice(2), prompt });
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }) + "\\n");
});
`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = [root, previousPath ?? ""].filter(Boolean).join(":");
  try {
    const result = await runExecutor(
      executorTask("effort-check", "check", root),
      { provider: "codex", model: "gpt-6-sol", effort: "xhigh", timeout_ms: 1000 },
    );
    assert.equal(result.success, true);
    const args = JSON.parse(result.output);
    assert.ok(args.args.includes("model_reasoning_effort=xhigh"));
    assert.equal(args.args.at(-1), "-");
    assert.match(args.prompt, /^Complete this subtask:\ncheck\n/);
    assert.match(args.prompt, /files changed or reports produced/);
    assert.match(args.prompt, /Do not paste raw tool output, command logs, or full diffs/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

async function captureExecutorInvocation(provider, runtimeEnv) {
  const root = await mkdtemp(join(tmpdir(), `owl-executor-${provider}-argv-`));
  const executable = join(root, provider);
  await writeFile(executable, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  const invocation = JSON.stringify({ args: process.argv.slice(2), codexHome: process.env.CODEX_HOME ?? null });
  if (${JSON.stringify(provider)} === "codex") {
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: invocation } }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n" + JSON.stringify({ type: "result", result: invocation }) + "\\n");
  }
});
`);
  await chmod(executable, 0o755);
  const result = await runExecutor(
    executorTask(`${provider}-argv`, "check arguments", root),
    { provider, model: provider === "codex" ? "gpt-6-sol" : "claude-sonnet-5", timeout_ms: 1000 },
    {},
    {
      owlRoot: repoRoot,
      env: runtimeEnv,
      executables: { [provider]: executable },
    },
  );
  assert.equal(result.success, true, result.output);
  return JSON.parse(result.output);
}

function assertSingleClaudeSettingsExclusion(args) {
  const settingsArgs = args.flatMap((arg, index) => arg === "--settings" ? [args[index + 1]] : []);
  assert.equal(settingsArgs.length, 1);
  assert.ok(JSON.parse(settingsArgs[0]).claudeMdExcludes);
}

test("Claude Executor passes user instruction exclusions in its single settings argument", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-executor-claude-exclusions-"));
  const invocation = await captureExecutorInvocation("claude", {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root,
    CLAUDE_CONFIG_DIR: join(root, "claude-config"),
  });
  assertSingleClaudeSettingsExclusion(invocation.args);
  assert.equal(invocation.args[invocation.args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(invocation.args.includes("--verbose"));
});

test("Codex Executor passes user instruction exclusions and overlays CODEX_HOME for the child only", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-executor-codex-exclusions-"));
  const runtimeEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root,
    CODEX_HOME: join(root, "codex-home"),
  };
  const originalCodexHome = runtimeEnv.CODEX_HOME;
  const invocation = await captureExecutorInvocation("codex", runtimeEnv);
  assert.ok(invocation.args.some((arg) => arg.startsWith("marketplaces.openai-bundled.source=")));
  assert.ok(invocation.codexHome);
  assert.notEqual(invocation.codexHome, originalCodexHome);
  assert.equal(runtimeEnv.CODEX_HOME, originalCodexHome);
});

async function capturedCodexPrompt(prefix, task) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const executable = join(root, "codex");
  await writeFile(executable, `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: prompt } }) + "\\n");
});
`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = [root, previousPath ?? ""].filter(Boolean).join(":");
  try {
    const result = await runExecutor(executorTask("prompt-check", "check", root, task), { provider: "codex", model: "gpt-6-luna", timeout_ms: 1000 });
    assert.equal(result.success, true);
    return result.output;
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

test("the Executor prompt carries the Task, its rules and the Owner guidance before the general guidance", async () => {
  const prompt = await capturedCodexPrompt("owl-executor-rules-", {
    title: "Add the parser",
    acceptance: "Parses every sample file.",
    context: "Samples live in fixtures/.",
    rules: "[system] no force push\n[work] keep tests green",
    owner_guidance: [{ decision_reason: "Which format?", answer: "Use YAML", option_key: null, answered_at: "2026-09-25T00:00:00Z" }],
  });
  assert.match(prompt, /^Complete this subtask:\ncheck\n/);
  assert.match(prompt, /\n## Task\nTitle: Add the parser\nAcceptance criteria:\nParses every sample file\.\nContext:\nSamples live in fixtures\/\.\n/);
  assert.match(prompt, /\n## Rules\nThese rules come from the operator's Rule Store and the Work\. They always win over the guidance below\.\n\[system\] no force push\n\[work\] keep tests green\n/);
  assert.match(prompt, /\n## Owner guidance\n.*\n- \{"decision_reason":"Which format\?","answer":"Use YAML"/);
  assert.ok(prompt.indexOf("## Rules") < prompt.indexOf(WORKING_STYLE_RULES[0]));
  assert.ok(prompt.indexOf(WORKING_STYLE_RULES[0]) < prompt.indexOf(MINIMAL_CODE_RULES[0]));
});

test("the Executor prompt says None. when the Task has no rules or Owner guidance", async () => {
  const prompt = await capturedCodexPrompt("owl-executor-no-rules-", {});
  assert.match(prompt, /\n## Rules\n.*\nNone\.\n/);
  assert.match(prompt, /\n## Owner guidance\n.*\nNone\.\n/);
  assert.match(prompt, /\nAcceptance criteria:\nIt works\.\nContext:\nNone\.\n/);
});

test("Codex Executor sends only the final assistant result to the Hybrid Worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-executor-compact-output-"));
  const executable = join(root, "codex");
  await writeFile(executable, `#!/usr/bin/env node
process.stderr.write("raw stderr tool log\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "x".repeat(1_100_000) } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Final audit summary." } }) + "\\n");
`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = [root, previousPath ?? ""].filter(Boolean).join(":");
  try {
    const result = await runExecutor(
      executorTask("compact-output", "audit", root),
      { provider: "codex", model: "gpt-6-luna", timeout_ms: 1000 },
    );
    assert.equal(result.success, true);
    assert.equal(result.output, "Final audit summary.");
    assert.ok(Buffer.byteLength(result.output) < 100);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("Codex Executor fails safely instead of returning raw logs without a final report", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-executor-missing-report-"));
  const executable = join(root, "codex");
  await writeFile(executable, `#!/usr/bin/env node
process.stdout.write("raw command log with internal details\\n");
process.stderr.write("raw stderr log with internal details\\n");
`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = [root, previousPath ?? ""].filter(Boolean).join(":");
  try {
    const result = await runExecutor(
      executorTask("missing-report", "audit", root),
      { provider: "codex", model: "gpt-6-luna", timeout_ms: 1000 },
    );
    assert.equal(result.success, false);
    assert.match(result.output, /did not emit a parseable final assistant report/);
    assert.doesNotMatch(result.output, /raw command log|raw stderr log|internal details/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("Claude Executor sends a concise prompt on stdin and returns only its final report", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-executor-claude-report-"));
  const executable = join(root, "claude");
  await writeFile(executable, `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  process.stderr.write("raw stderr tool log\\n");
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n" + JSON.stringify({ type: "result", result: "Claude completion report", prompt }) + "\\n");
});
`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = [root, previousPath ?? ""].filter(Boolean).join(":");
  try {
    const result = await runExecutor(
      executorTask("claude-report", "inspect the changes", root),
      { provider: "claude", model: "claude-sonnet-5", timeout_ms: 1000 },
    );
    assert.equal(result.success, true);
    assert.equal(result.output, "Claude completion report");
    assert.doesNotMatch(result.output, /raw stderr tool log/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("Executor processes get only the supplied runtime environment and use its CLI paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-executor-runtime-"));
  const binDir = join(root, "not-on-path");
  await mkdir(binDir, { recursive: true });
  const executable = join(binDir, "codex-cli");
  await writeFile(executable, `#!${process.execPath}
process.stdin.resume();
process.stdin.on("end", () => {
  const text = JSON.stringify({ keys: Object.keys(process.env).sort(), probe: process.env.RUNTIME_PROBE ?? null });
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\\n");
});
`);
  await chmod(executable, 0o755);
  const previous = { secret: process.env.SECRET_PROBE, guard: process.env.OWL_GUARD_TOKEN };
  process.env.SECRET_PROBE = "server-only";
  process.env.OWL_GUARD_TOKEN = "server-guard";
  try {
    const result = await runExecutor(
      executorTask("runtime-env", "check", root),
      { provider: "codex", model: "gpt-5.6-terra", timeout_ms: 5000 },
      {},
      { owlRoot: repoRoot, env: { PATH: "/usr/bin:/bin", HOME: root, RUNTIME_PROBE: "runtime" }, executables: { codex: executable } },
    );
    assert.equal(result.success, true, result.output);
    const reported = JSON.parse(result.output);
    assert.equal(reported.probe, "runtime");
    assert.equal(reported.keys.includes("SECRET_PROBE"), false);
    assert.equal(reported.keys.includes("OWL_GUARD_TOKEN"), false);
    assert.ok(reported.keys.includes("OWL_AGENT_ROLE"));
  } finally {
    if (previous.secret === undefined) delete process.env.SECRET_PROBE;
    else process.env.SECRET_PROBE = previous.secret;
    if (previous.guard === undefined) delete process.env.OWL_GUARD_TOKEN;
    else process.env.OWL_GUARD_TOKEN = previous.guard;
  }
});
