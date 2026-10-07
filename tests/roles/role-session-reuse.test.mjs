import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { createCliProvider } from "../../packages/agent-runtime/dist/provider.js";
import { tempDir } from "../helpers/temp.mjs";

const OUTPUT_TEMPLATE_HEADING = "## Output template\n";

function outputTemplate(prompt) {
  const start = prompt.indexOf(OUTPUT_TEMPLATE_HEADING);
  assert.notEqual(start, -1);
  const body = prompt.slice(start + OUTPUT_TEMPLATE_HEADING.length);
  return JSON.parse(body.slice(body.indexOf("\n{") + 1, body.indexOf("\n}\n") + 2));
}

function fillTemplate(value) {
  if (typeof value === "string") return /^<.+>$/u.test(value) ? `filled ${value.slice(1, -1)}` : value;
  if (Array.isArray(value)) return value.map(fillTemplate);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillTemplate(item)]));
  }
  return value;
}

function workerTask(overrides = {}) {
  return {
    id: "task-1",
    work_id: "work-1",
    title: "Build the storage layer",
    status: "running",
    type: "code",
    state_version: 0,
    updated_at: "2026-09-24T00:00:00.000Z",
    parent_task_id: null,
    acceptance: "The storage layer works.",
    review_round: 0,
    failure_count: 0,
    worker_generation: 0,
    depends_on: [],
    ...overrides,
  };
}

function workerRequest({
  invocationId,
  workId = "work-1",
  worktree = "/tmp/task-1",
  task = workerTask(),
} = {}) {
  return {
    invocation_id: invocationId,
    work_id: workId,
    task_id: task.id,
    attempt: 1,
    context: { task, worktree },
  };
}

function workerReport(invocationId) {
  return {
    kind: "report",
    schema_version: "1.0.0",
    invocation_id: invocationId,
    result: "success",
    work_done: "A worker completed the Task.",
    delegation: {
      decomposition: "The task was kept together because it was a single coherent change.",
      delegated: [],
      retained: [{
        part: "Implement and verify the storage layer.",
        reason: "The work was small and tightly coupled.",
      }],
    },
    changes: [],
    verification: { passed: true, method: "Checked the implementation." },
    remaining_issues: [],
    next_action: "none",
    needs_replanning: false,
    question_for_manager: null,
  };
}

function reviewerRequest(invocationId, summary = "Review summary") {
  return {
    invocation_id: invocationId,
    work_id: "work-1",
    task_id: "task-1",
    attempt: 1,
    review_round: 1,
    context: {
      task: workerTask(),
      report: workerReport("worker-1"),
      worktree: "/tmp/task-1",
      summary,
    },
  };
}

const planTask = { id: "T1", title: "A", type: "code", acceptance_criteria: [{ id: "AC1", text: "Done.", check: "node --test tests/a.test.mjs", serves: "the request", if_omitted: "not met", check_weight: "light", kind: "work_check", weight_reason: "" }], necessity: { serves: "the request", if_omitted: "not met" }, depends_on: [], required_sections: [], required_tests: [], wait_for: null, base_sync_only: null, replaces: [], context: "", notes: "", review: null };

function filledOutput(prompt) {
  const template = outputTemplate(prompt);
  return Array.isArray(template.tasks) ? { tasks: [planTask] } : fillTemplate(template);
}

function providerResponse(request, {
  output = filledOutput(request.prompt),
  sessionId = `session-${request.invocation_id}`,
  usage = { input_tokens: 100, output_tokens: 20 },
  numTurns = 1,
} = {}) {
  return {
    adapter: request.adapter,
    stdout: JSON.stringify({
      type: "result",
      num_turns: numTurns,
      result: JSON.stringify(output),
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens ?? 20,
        cache_read_input_tokens: usage.cache_read_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_write_tokens ?? 0,
      },
    }),
    stderr: "",
    exit_code: 0,
    signal: null,
    ...(sessionId ? { provider_session_id: sessionId } : {}),
    format: "provider-json",
  };
}

/** These tests are about session reuse after a rejected answer, so output-only resubmission is off. */
function runnerWith(provider, env) {
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    ...(env ? { env } : {}),
    provider: { execute: provider },
  });
  runner.setOutputResubmitLimit(() => 0);
  return runner;
}

test("a second Worker call in the same Task resumes with only changed input fields", async () => {
  const calls = [];
  const runner = runnerWith(async (request) => {
    calls.push(request);
    return providerResponse(request, { output: { ...fillTemplate(outputTemplate(request.prompt)), work_done: "worker answer" } });
  });

  await runner.runWorker(workerRequest({ invocationId: "worker-1" }));
  await runner.runWorker(workerRequest({
    invocationId: "worker-2",
    task: workerTask({ title: "Update the storage layer" }),
  }));

  assert.equal(calls.length, 2);
  assert.equal(calls[1].provider_session_id, "session-worker-1");
  assert.match(calls[1].prompt, /^Continue as the Owl worker for this Task\./u);
  const changedInputAt = calls[1].prompt.indexOf("Changed input:\n");
  assert.notEqual(changedInputAt, -1);
  assert.deepEqual(JSON.parse(calls[1].prompt.slice(changedInputAt + "Changed input:\n".length)), {
    Task: { title: "Update the storage layer" },
  });
  assert.doesNotMatch(calls[1].prompt, /Build the storage layer/u);
});

test("a change only in the Attempt slot resumes with only the Attempt slot and records fresh then resumed with full-prompt hashes", async () => {
  const calls = [];
  const records = [];
  const runner = runnerWith(async (request) => {
    calls.push(request);
    return providerResponse(request);
  });
  runner.setPromptObserver((invocationId, record) => records.push({ invocationId, ...record }));
  const findings = [{ severity: "major", target: "code", file: "a.ts", line: 1, problem: "p", reason: "r", fix: "f" }];

  await runner.runWorker(workerRequest({ invocationId: "worker-1" }));
  const second = workerRequest({ invocationId: "worker-2" });
  await runner.runWorker({ ...second, context: { ...second.context, reviewer_findings: findings } });

  const changedInputAt = calls[1].prompt.indexOf("Changed input:\n");
  assert.deepEqual(JSON.parse(calls[1].prompt.slice(changedInputAt + "Changed input:\n".length)), {
    Attempt: { reviewer_findings: [{ id: "F1", target: "code", file: "a.ts", line: 1, problem: "p", reason: "r", fix: "f" }] },
  });
  assert.deepEqual(records.map((record) => [record.invocationId, record.mode]), [["worker-1", "fresh"], ["worker-2", "resumed"]]);
  const [first, resumed] = records.map((record) => record.fingerprint);
  for (const layer of ["header", "project", "task"]) assert.equal(resumed[layer], first[layer], layer);
  assert.notEqual(resumed.dynamic, first.dynamic);
  for (const hash of Object.values(resumed)) assert.match(hash, /^[0-9a-f]{64}$/u);
  assert.equal(calls[1].prompt.includes(resumed.dynamic), false, "hashes never enter the prompt");
});

test("Workers in different Task worktrees run concurrently without sharing sessions", async () => {
  const calls = [];
  const releases = [];
  const runner = runnerWith((request) => {
    calls.push(request);
    return new Promise((resolve) => releases.push(() => resolve(providerResponse(request))));
  });

  const first = runner.runWorker(workerRequest({
    invocationId: "worker-a",
    worktree: "/tmp/task-a",
    task: workerTask({ id: "task-a", title: "Task A only" }),
  }));
  const second = runner.runWorker(workerRequest({
    invocationId: "worker-b",
    worktree: "/tmp/task-b",
    task: workerTask({ id: "task-b", title: "Task B only" }),
  }));

  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2);
    assert.ok(calls.every((request) => request.provider_session_id === undefined));
    assert.match(calls[0].prompt, /Task A only/u);
    assert.doesNotMatch(calls[0].prompt, /Task B only/u);
    assert.match(calls[1].prompt, /Task B only/u);
    assert.doesNotMatch(calls[1].prompt, /Task A only/u);
  } finally {
    for (const release of releases) release();
  }

  await Promise.all([first, second]);
});

test("overlapping calls with the same key stay fresh until every call finishes", async () => {
  const calls = [];
  const releases = [];
  let template;
  const runner = runnerWith((request) => {
    calls.push(request);
    if (!request.provider_session_id) template = fillTemplate(outputTemplate(request.prompt));
    return new Promise((resolve) => releases.push(() => resolve(providerResponse(
      request,
      request.provider_session_id ? { output: { ...template, invocation_id: request.invocation_id } } : undefined,
    ))));
  });

  const first = runner.runWorker(workerRequest({
    invocationId: "worker-first",
    task: workerTask({ title: "First overlapping request" }),
  }));
  let second;
  let third;
  try {
    await new Promise((resolve) => setImmediate(resolve));
    second = runner.runWorker(workerRequest({
      invocationId: "worker-second",
      task: workerTask({ title: "Second overlapping request" }),
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.length, 2);
    assert.ok(calls.every((request) => request.provider_session_id === undefined));
    releases[0]();
    await first;

    third = runner.runWorker(workerRequest({
      invocationId: "worker-third",
      task: workerTask({ title: "Third overlapping request" }),
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 3);
    assert.equal(calls[2].provider_session_id, undefined);
    assert.match(calls[2].prompt, /## Input/u);

    releases[2]();
    await third;
    releases[1]();
    await second;

    const fourth = runner.runWorker(workerRequest({
      invocationId: "worker-fourth",
      task: workerTask({ title: "Fourth sequential request" }),
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls[3].provider_session_id, "session-worker-first");
    releases[3]();
    await fourth;
  } finally {
    for (const release of releases) release();
  }
});

test("Reviewer calls stay fresh and append the previous review handoff", async () => {
  const calls = [];
  const runner = runnerWith(async (request) => {
    calls.push(request);
    const output = fillTemplate(outputTemplate(request.prompt));
    output.summary = calls.length === 1 ? "previous-review-handoff-marker" : "second review";
    return providerResponse(request, { output });
  });

  await runner.runReviewer(reviewerRequest("reviewer-1"));
  await runner.runReviewer(reviewerRequest("reviewer-2"));

  assert.equal(calls.length, 2);
  assert.equal(calls[1].provider_session_id, undefined);
  assert.match(calls[1].prompt, /^You are the Owl Reviewer\./u);
  assert.match(calls[1].prompt, /previous-review-handoff-marker/u);
  assert.match(calls[1].prompt, /## Input/u);
});

test("a resume rejected before a conversation starts retries once with the full prompt", async () => {
  const calls = [];
  const runner = runnerWith(async (request) => {
    calls.push(request);
    if (calls.length === 2) {
      return { adapter: request.adapter, stdout: "", stderr: "No conversation found", exit_code: 1, signal: null };
    }
    const output = fillTemplate(outputTemplate(request.prompt));
    if (calls.length === 1) output.work_done = "saved-handoff-marker";
    return providerResponse(request, { output });
  });

  await runner.runWorker(workerRequest({ invocationId: "worker-1" }));
  await runner.runWorker(workerRequest({
    invocationId: "worker-2",
    task: workerTask({ title: "Retry the storage layer" }),
  }));

  assert.equal(calls.length, 3);
  assert.equal(calls[1].provider_session_id, "session-worker-1");
  assert.equal(calls[2].provider_session_id, undefined);
  assert.match(calls[2].prompt, /## Input/u);
  assert.doesNotMatch(calls[2].prompt, /Changed input:\n/u);
  assert.match(calls[2].prompt, /saved-handoff-marker/u);
});

test("large prior context uses a fresh prompt with the previous answer handoff", async () => {
  const calls = [];
  const runner = runnerWith(async (request) => {
    calls.push(request);
    const output = fillTemplate(outputTemplate(request.prompt));
    if (calls.length === 1) output.work_done = "large-context-handoff-marker";
    return providerResponse(request, {
      output,
      usage: { input_tokens: calls.length === 1 ? 40_001 : 100, output_tokens: 20 },
    });
  });

  await runner.runWorker(workerRequest({ invocationId: "worker-1" }));
  await runner.runWorker(workerRequest({
    invocationId: "worker-2",
    task: workerTask({ title: "Change after a large context" }),
  }));

  assert.equal(calls.length, 2);
  assert.equal(calls[1].provider_session_id, undefined);
  assert.match(calls[1].prompt, /## Input/u);
  assert.match(calls[1].prompt, /large-context-handoff-marker/u);
});

test("a rejected Worker answer adds its validation reason to the next resumed prompt", async () => {
  const calls = [];
  const runner = runnerWith(async (request) => {
    calls.push(request);
    if (calls.length === 1) return providerResponse(request, { output: {} });
    return providerResponse(request);
  });

  const failed = await runner.runWorker(workerRequest({ invocationId: "worker-1" }));
  assert.equal(failed.outcome, "failed");
  await runner.runWorker(workerRequest({
    invocationId: "worker-2",
    task: workerTask({ title: "Correct the storage layer" }),
  }));

  assert.equal(calls.length, 2);
  assert.equal(calls[1].provider_session_id, "session-worker-1");
  assert.match(calls[1].prompt, /previous answer was rejected for report_invalid:worker_output_schema:/u);
  assert.match(calls[1].prompt, /Changed input:\n\{"Task":\{"title":"Correct the storage layer"\}\}/u);
});

async function workerCallsAfterUsage(usage, numTurns, env) {
  const calls = [];
  const runner = runnerWith(async (request) => {
    calls.push(request);
    const output = fillTemplate(outputTemplate(request.prompt));
    if (calls.length === 1) output.work_done = "estimate-handoff-marker";
    return providerResponse(request, calls.length === 1 ? { output, usage, numTurns } : { output });
  }, env);
  await runner.runWorker(workerRequest({ invocationId: "worker-1" }));
  await runner.runWorker(workerRequest({
    invocationId: "worker-2",
    task: workerTask({ title: "Change after cumulative usage" }),
  }));
  assert.equal(calls.length, 2);
  return calls;
}

test("cumulative usage spread over many model calls still resumes the session", async () => {
  const calls = await workerCallsAfterUsage({ input_tokens: 10_000, cache_read_tokens: 130_000, cache_write_tokens: 10_000 }, 10);
  assert.equal(calls[1].provider_session_id, "session-worker-1");
  assert.match(calls[1].prompt, /^Continue as the Owl worker/u);
});

test("cumulative usage concentrated in few model calls uses a fresh prompt with the handoff", async () => {
  const calls = await workerCallsAfterUsage({ input_tokens: 10_000, cache_read_tokens: 130_000, cache_write_tokens: 10_000 }, 2);
  assert.equal(calls[1].provider_session_id, undefined);
  assert.match(calls[1].prompt, /## Input/u);
  assert.match(calls[1].prompt, /estimate-handoff-marker/u);
});

test("a changed header after a rejected answer hands off with the rejection reason", async () => {
  const calls = [];
  const runner = runnerWith(async (request) => {
    calls.push(request);
    if (calls.length === 1) return providerResponse(request, { output: { work_done: "rejected-marker" } });
    return providerResponse(request);
  });

  const failed = await runner.runWorker(workerRequest({ invocationId: "worker-1" }));
  assert.equal(failed.outcome, "failed");
  await runner.runWorker({ ...workerRequest({ invocationId: "worker-2" }), language: "en" });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].provider_session_id, undefined);
  assert.match(calls[1].prompt, /## Input/u);
  assert.match(calls[1].prompt, /Previous worker answer handoff:/u);
  assert.match(calls[1].prompt, /rejected for report_invalid:worker_output_schema:/u);
});

test("a second Manager call for the same Work resumes its session", async () => {
  const calls = [];
  const runner = runnerWith(async (request) => {
    calls.push(request);
    return providerResponse(request);
  });
  const managerRequest = (invocationId, title) => ({
    invocation_id: invocationId, work_id: "work-1", task_id: null, attempt: 1,
    context: { mode: "plan", work: { id: "work-1", title } },
  });

  const first = await runner.runManagerPlan(managerRequest("manager-1", "Release"));
  assert.equal(first.outcome, "success", first.message);
  await runner.runManagerPlan(managerRequest("manager-2", "Release notes"));

  assert.equal(calls.length, 2);
  assert.equal(calls[1].cwd, calls[0].cwd);
  assert.equal(calls[1].provider_session_id, "session-manager-1");
  assert.match(calls[1].prompt, /^Continue as the Owl manager/u);
});

async function captureOneShotProvider(t, adapter, providerSessionId) {
  const root = await tempDir(t, `owl-${adapter}-launch-`);
  const executable = join(root, "fake-codex");
  const capture = join(root, "argv.json");
  const hookPath = join(root, "apps", "server", "dist", "permission-hook.js");
  await mkdir(dirname(hookPath), { recursive: true });
  await writeFile(hookPath, "", "utf8");
  await writeFile(executable, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => {
  writeFileSync(process.env.ARGV_CAPTURE, JSON.stringify({ args: process.argv.slice(2), codexHome: process.env.CODEX_HOME ?? null }));
  const reply = process.argv.includes("exec")
    ? JSON.stringify({ type: "thread.started", thread_id: "thread-test" }) + "\\n"
    : JSON.stringify({ type: "system", subtype: "init" }) + "\\n" + JSON.stringify({ type: "result", result: "done", session_id: "session-test" }) + "\\n";
  process.stdout.write(reply, () => process.exit(0));
});
`, "utf8");
  await chmod(executable, 0o755);

  const requestEnv = {
    PATH: process.env.PATH || [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: process.env.HOME || root,
    ARGV_CAPTURE: capture,
    OWL_ROOT: root,
    CODEX_HOME: join(root, "user-codex-home"),
  };
  const provider = createCliProvider({
    adapter: adapter === "codex" ? "codex-cli/v1" : "claude-cli/v1",
    executablePath: executable,
    model: "test-model",
    env: { PATH: requestEnv.PATH, HOME: requestEnv.HOME },
  });
  const response = await provider.execute({
    adapter: adapter === "codex" ? "codex-cli/v1" : "claude-cli/v1",
    role: "worker",
    model: "test-model",
    effort: "high",
    prompt: "Continue the Task.",
    invocation_id: `provider-${adapter}-test`,
    ...(providerSessionId ? { provider_session_id: providerSessionId } : {}),
    cwd: root,
    env: requestEnv,
    ...(adapter === "codex" ? { structured_output_schema: { type: "object" } } : {}),
  });
  const invocation = JSON.parse(await readFile(capture, "utf8"));
  return { root, requestEnv, response, ...invocation };
}

function assertClaudeSettingsExclusion(args) {
  const settings = args.flatMap((arg, index) => arg === "--settings" ? [args[index + 1]] : []);
  assert.equal(settings.length, 1);
  assert.ok(JSON.parse(settings[0]).claudeMdExcludes);
}

function assertCodexSourceOverride(args) {
  const configs = args.flatMap((arg, index) => arg === "--config" ? [args[index + 1]] : []);
  assert.ok(configs.some((config) => config.startsWith("marketplaces.openai-bundled.source=")));
}

test("Codex exec resume argv excludes user instructions and overlays CODEX_HOME", async (t) => {
  const { root, requestEnv, response, args, codexHome } = await captureOneShotProvider(t, "codex", "thread-resume-1");
  assert.equal(response.exit_code, 0);
  assert.equal(response.provider_session_id, "thread-test");
  assert.deepEqual(args.slice(0, 3), ["exec", "resume", "--json"]);
  assert.ok(args.includes("--output-schema"));
  assert.ok(args.includes("--dangerously-bypass-hook-trust"));
  assert.ok(args.includes('sandbox_mode="danger-full-access"'));
  assert.ok(!args.includes("--sandbox"));
  assert.ok(args.includes("features.hooks=true"));
  assert.ok(args.some((arg) => arg.includes("hooks.PreToolUse=[{matcher=\"*\",")));
  assert.ok(args.includes("--skip-git-repo-check"));
  assert.equal(args[args.indexOf("--model") + 1], "test-model");
  assert.ok(args.includes("model_reasoning_effort=high"));
  assertCodexSourceOverride(args);
  assert.notEqual(codexHome, requestEnv.CODEX_HOME);
  assert.equal(requestEnv.CODEX_HOME, join(root, "user-codex-home"));
  assert.deepEqual(args.slice(-3), ["thread-resume-1", "--", "-"]);
});

test("Codex exec fresh argv excludes user instructions and overlays CODEX_HOME", async (t) => {
  const { requestEnv, response, args, codexHome } = await captureOneShotProvider(t, "codex");
  assert.equal(response.exit_code, 0);
  assert.ok(!args.includes("resume"));
  assertCodexSourceOverride(args);
  assert.notEqual(codexHome, requestEnv.CODEX_HOME);
});

test("Claude provider argv excludes user instructions on fresh starts and resumes", async (t) => {
  for (const providerSessionId of [undefined, "saved-claude-session"]) {
    const { response, args } = await captureOneShotProvider(t, "claude", providerSessionId);
    assert.equal(response.exit_code, 0);
    assertClaudeSettingsExclusion(args);
    assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
    assert.ok(args.includes("--verbose"));
    assert.equal(args.includes("--resume"), providerSessionId !== undefined);
    if (providerSessionId) assert.equal(args[args.indexOf("--resume") + 1], providerSessionId);
  }
});

// One model call, so the estimated context is twice the input tokens.
const CONTEXT_80K = { input_tokens: 40_000 };
const CONTEXT_OVER_80K = { input_tokens: 40_001 };

test("without a context limit setting a role keeps its session up to 80k tokens", async () => {
  const atLimit = await workerCallsAfterUsage(CONTEXT_80K, 1);
  assert.equal(atLimit[1].provider_session_id, "session-worker-1");
  const overLimit = await workerCallsAfterUsage(CONTEXT_OVER_80K, 1);
  assert.equal(overLimit[1].provider_session_id, undefined);
});

test("a role-specific context limit overrides the common limit and applies only to that role", async () => {
  const raised = await workerCallsAfterUsage(CONTEXT_OVER_80K, 1, { OWL_ROLE_SESSION_CONTEXT_LIMIT_WORKER: "200000" });
  assert.equal(raised[1].provider_session_id, "session-worker-1");
  const lowered = await workerCallsAfterUsage(CONTEXT_80K, 1, { OWL_ROLE_SESSION_CONTEXT_LIMIT_WORKER: "1000" });
  assert.equal(lowered[1].provider_session_id, undefined);
  const otherRole = await workerCallsAfterUsage(CONTEXT_OVER_80K, 1, { OWL_ROLE_SESSION_CONTEXT_LIMIT_REVIEWER: "200000" });
  assert.equal(otherRole[1].provider_session_id, undefined);
  const common = await workerCallsAfterUsage(CONTEXT_OVER_80K, 1, {
    OWL_ROLE_SESSION_CONTEXT_LIMIT: "1000",
    OWL_ROLE_SESSION_CONTEXT_LIMIT_WORKER: "200000",
  });
  assert.equal(common[1].provider_session_id, "session-worker-1");
});

test("an invalid context limit fails the first Worker run as a provider configuration error naming the key", async () => {
  const calls = [];
  const runner = runnerWith(async (request) => {
    calls.push(request);
    return providerResponse(request);
  }, { OWL_ROLE_SESSION_CONTEXT_LIMIT: "abc" });

  const result = await runner.runWorker(workerRequest({ invocationId: "worker-1" }));

  assert.equal(result.outcome, "failed");
  assert.match(JSON.stringify(result), /owl_role_session_context_limit_invalid/);
  assert.equal(calls.length, 0);
});
