import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { createAgentRunner } from "../packages/agent-runtime/dist/index.js";
import { createCliProvider } from "../packages/agent-runtime/dist/provider.js";

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

function providerResponse(request, {
  output = fillTemplate(outputTemplate(request.prompt)),
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

function runnerWith(provider) {
  return createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: { execute: provider },
  });
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
    Task: { task: { title: "Update the storage layer" } },
  });
  assert.doesNotMatch(calls[1].prompt, /Build the storage layer/u);
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

test("same-key overlapping calls stay fresh until every call finishes", async () => {
  const calls = [];
  const releases = [];
  const runner = runnerWith((request) => {
    calls.push(request);
    return new Promise((resolve) => releases.push(() => resolve(providerResponse(
      request,
      request.provider_session_id ? { output: workerReport(request.invocation_id) } : undefined,
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
  assert.match(calls[1].prompt, /Changed input:\n\{"Task":\{"task":\{"title":"Correct the storage layer"\}\}\}/u);
});

async function workerCallsAfterUsage(usage, numTurns) {
  const calls = [];
  const runner = runnerWith(async (request) => {
    calls.push(request);
    const output = fillTemplate(outputTemplate(request.prompt));
    if (calls.length === 1) output.work_done = "estimate-handoff-marker";
    return providerResponse(request, calls.length === 1 ? { output, usage, numTurns } : { output });
  });
  await runner.runWorker(workerRequest({ invocationId: "worker-1" }));
  await runner.runWorker(workerRequest({
    invocationId: "worker-2",
    task: workerTask({ title: "Change after cumulative usage" }),
  }));
  assert.equal(calls.length, 2);
  return calls;
}

test("cumulative usage spread over many model calls still resumes", async () => {
  const calls = await workerCallsAfterUsage({ input_tokens: 10_000, cache_read_tokens: 130_000, cache_write_tokens: 10_000 }, 10);
  assert.equal(calls[1].provider_session_id, "session-worker-1");
  assert.match(calls[1].prompt, /^Continue as the Owl worker/u);
});

test("cumulative usage over few model calls uses a fresh prompt with the handoff", async () => {
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

test("Codex resume argv uses its resume command, permissions, and session id", async () => {
  const root = await mkdtemp(join(tmpdir(), "owl-codex-resume-"));
  const executable = join(root, "fake-codex");
  const capture = join(root, "argv.json");
  const hookPath = join(root, "apps", "server", "dist", "permission-hook.js");
  try {
    await mkdir(dirname(hookPath), { recursive: true });
    await writeFile(hookPath, "", "utf8");
    await writeFile(executable, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => {
  writeFileSync(process.env.ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)));
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-resume-1" }) + "\\n", () => process.exit(0));
});
`, "utf8");
    await chmod(executable, 0o755);

    const provider = createCliProvider({
      adapter: "codex-cli/v1",
      executablePath: executable,
      model: "test-model",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    const response = await provider.execute({
      adapter: "codex-cli/v1",
      role: "worker",
      model: "test-model",
      effort: "high",
      prompt: "Continue the Task.",
      invocation_id: "codex-resume-1",
      provider_session_id: "thread-resume-1",
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ARGV_CAPTURE: capture,
        OWL_ROOT: root,
      },
      structured_output_schema: { type: "object" },
    });
    const argv = JSON.parse(await readFile(capture, "utf8"));

    assert.equal(response.exit_code, 0);
    assert.equal(response.provider_session_id, "thread-resume-1");
    assert.deepEqual(argv.slice(0, 3), ["exec", "resume", "--json"]);
    assert.ok(argv.includes("--output-schema"));
    assert.ok(argv.includes("--dangerously-bypass-hook-trust"));
    assert.ok(argv.includes('sandbox_mode="danger-full-access"'));
    assert.ok(!argv.includes("--sandbox"));
    assert.ok(argv.includes("features.hooks=true"));
    assert.ok(argv.some((arg) => arg.includes("hooks.PreToolUse=[{matcher=\"*\",")));
    assert.ok(argv.includes("--skip-git-repo-check"));
    assert.equal(argv[argv.indexOf("--model") + 1], "test-model");
    assert.ok(argv.includes("model_reasoning_effort=high"));
    assert.deepEqual(argv.slice(-3), ["thread-resume-1", "--", "-"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
