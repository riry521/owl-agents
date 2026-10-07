import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { createCliProvider } from "../../packages/agent-runtime/dist/provider.js";

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

function formatFailure(request, { sessionId = "session-X", subtype = "error_max_structured_output_retries", stderr = "" } = {}) {
  return {
    adapter: request.adapter,
    stdout: JSON.stringify({ type: "result", subtype, is_error: true, errors: ["x"], session_id: sessionId }),
    stderr,
    exit_code: 1,
    signal: null,
    provider_session_id: sessionId,
  };
}

function runnerWith(provider) {
  return createAgentRunner({ adapter: "claude-cli/v1", outputLogDir: null, provider: { execute: provider } });
}

function limited(limit) {
  const request = workerRequest({ invocationId: "worker-1" });
  return { ...request, context: { ...request.context, report_resubmit_limit: limit } };
}

const planCriterion = { id: "AC1", text: "Done.", check: "node --test tests/a.test.mjs", serves: "the request", if_omitted: "not met", check_weight: "light", kind: "work_check", weight_reason: "" };
const planTask = { id: "T1", title: "A", type: "code", acceptance_criteria: [planCriterion], necessity: { serves: "the request", if_omitted: "not met" }, depends_on: [], required_sections: [], required_tests: [], wait_for: null, base_sync_only: null, replaces: [], context: "", notes: "", review: null };

function okResponse(request) {
  const template = outputTemplate(request.prompt);
  const output = Array.isArray(template.tasks) ? { tasks: [planTask] } : fillTemplate(template);
  return {
    adapter: request.adapter,
    stdout: JSON.stringify({ type: "result", result: JSON.stringify(output), session_id: "session-X" }),
    stderr: "",
    exit_code: 0,
    signal: null,
    provider_session_id: "session-X",
  };
}

test("a report format failure is resubmitted in the same session and succeeds", async () => {
  const calls = [];
  const runner = runnerWith(async (request) => {
    calls.push(request);
    return calls.length === 1 ? formatFailure(request) : {
      ...okResponse({ ...request, prompt: calls[0].prompt }),
    };
  });
  const result = await runner.runWorker(limited(2));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].provider_session_id, "session-X");
  assert.match(calls[1].prompt, /Do not edit files/u);
  assert.ok(calls[1].structured_output_schema);
  assert.equal(result.outcome, "success");
});

test("resubmission stops at the configured limit and reports report_format_invalid", async () => {
  for (const limit of [0, 1, 3]) {
    let count = 0;
    const runner = runnerWith(async (request) => {
      count++;
      return formatFailure(request);
    });
    const result = await runner.runWorker(limited(limit));
    assert.equal(count, limit + 1);
    assert.equal(result.error_key, "report_format_invalid");
    assert.equal(result.failure_class, "deterministic");
    assert.equal(result.retry_allowed, false);
  }
});

test("a missing limit makes resubmission use the default limit", async () => {
  let count = 0;
  const runner = runnerWith(async (request) => {
    count++;
    return formatFailure(request);
  });
  const result = await runner.runWorker(workerRequest({ invocationId: "worker-1" }));
  assert.equal(count, 3);
  assert.equal(result.error_key, "report_format_invalid");
});

test("stream-json output with several event lines is recognised as a format failure", async () => {
  let count = 0;
  const runner = runnerWith(async (request) => {
    count++;
    const failure = formatFailure(request);
    if (count === 2) return okResponse({ ...request, prompt: first });
    first ??= request.prompt;
    return { ...failure, stdout: `${JSON.stringify({ type: "system", subtype: "init", session_id: "session-X" })}\n${failure.stdout}\n` };
  });
  let first;
  const result = await runner.runWorker(limited(2));
  assert.equal(count, 2);
  assert.equal(result.outcome, "success");
});

test("an auth-style nonzero exit is not resubmitted and keeps the provider_failed classification", async () => {
  for (const make of [
    (request) => formatFailure(request, { subtype: "error_during_execution" }),
    (request) => ({ adapter: request.adapter, stdout: "", stderr: "Invalid API key", exit_code: 1, signal: null, provider_session_id: "session-X" }),
  ]) {
    let count = 0;
    const runner = runnerWith(async (request) => {
      count++;
      return make(request);
    });
    const result = await runner.runWorker(limited(2));
    assert.equal(count, 1);
    assert.equal(result.error_key, "provider_failed:exit:1");
    assert.equal(result.failure_class, "deterministic");
    assert.equal(result.retry_allowed, false);
  }
});

test("a format failure without a session id falls back to provider_failed", async () => {
  let count = 0;
  const runner = runnerWith(async (request) => {
    count++;
    const { provider_session_id: _drop, ...rest } = formatFailure(request);
    return rest;
  });
  const result = await runner.runWorker(limited(2));
  assert.equal(count, 1);
  assert.equal(result.error_key, "provider_failed:exit:1");
});

// Output-only resubmission for every role: a stub provider answers prose once (a format violation with a
// session id), then the correct output; or keeps answering prose.
const task = workerTask();
const managerRequest = (limit) => ({
  invocation_id: "manager-1", work_id: "work-1", task_id: null, attempt: 1,
  context: { mode: "plan", work: { id: "work-1", title: "Archive Works" }, ...(limit === undefined ? {} : { report_resubmit_limit: limit }) },
});
const reviewerRequest = (limit) => ({
  invocation_id: "reviewer-1", work_id: "work-1", task_id: "task-1", attempt: 1, review_round: 1,
  context: {
    task,
    report: {
      kind: "report", schema_version: "1.0.0", invocation_id: "worker-1", result: "success", work_done: "Added the migration.",
      changes: [{ file: "migrations/007.sql", action: "created" }], verification: { passed: true, method: "Checked the result." },
      delegation: { decomposition: "Kept together for review.", delegated: [], retained: [{ part: "Whole Task", reason: "No independent part was identified." }] },
      remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null,
    },
    ...(limit === undefined ? {} : { report_resubmit_limit: limit }),
  },
});
const librarianRequest = { title: "T", summary: "S", points: ["p"], existing_tags: [], min: 1, max: 3, model: { provider: "claude", model: "haiku", effort: "low" } };

function proseResponse(request) {
  return {
    adapter: request.adapter,
    stdout: JSON.stringify({ type: "result", result: "I finished, no JSON here.", session_id: "session-X" }),
    stderr: "", exit_code: 0, signal: null, provider_session_id: "session-X",
  };
}

const ROLES = {
  manager: { run: (runner, limit) => runner.runManagerPlan(managerRequest(limit)), accepted: (r) => r.outcome === "success" },
  reviewer: { run: (runner, limit) => runner.runReviewer(reviewerRequest(limit)), accepted: (r) => r.outcome === "success" || r.outcome === "failed" },
  librarian: { run: (runner) => runner.runClippingTags(librarianRequest), accepted: (r) => r.ok === true },
};

test("Manager, Reviewer and Librarian answers that break the format are accepted after a same-session resubmission", async () => {
  for (const [name, role] of Object.entries(ROLES)) {
    const calls = [];
    const runner = runnerWith(async (request) => {
      calls.push(request);
      return calls.length === 1 ? proseResponse(request) : okResponse({ ...request, prompt: calls[0].prompt });
    });
    const result = await role.run(runner, 2);
    assert.equal(calls.length, 2, name);
    assert.equal(calls[1].provider_session_id, "session-X", name);
    assert.match(calls[1].prompt, /Do not edit files/u, name);
    assert.ok(role.accepted(result), `${name}: ${JSON.stringify(result).slice(0, 200)}`);
    assert.notEqual(result.error_key, "output_format_invalid", name);
  }
});

test("a Codex Worker answer that breaks the format is resubmitted through the resumed session and accepted", async () => {
  const codexEvent = (text) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
  const calls = [];
  const runner = createAgentRunner({
    adapter: "codex-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        calls.push(request);
        const text = calls.length === 1 ? "done, no JSON" : JSON.stringify(fillTemplate(outputTemplate(calls[0].prompt)));
        return { adapter: request.adapter, stdout: codexEvent(text), stderr: "", exit_code: 0, signal: null, provider_session_id: "thread-X" };
      },
    },
  });
  const result = await runner.runWorker(limited(2));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].provider_session_id, "thread-X");
  assert.match(calls[1].adapter, /^codex/u);
  assert.equal(result.outcome, "success");
});

test("Manager, Reviewer, Librarian and the Codex Worker stop at the limit without a whole redo and report output_format_invalid", async () => {
  for (const [name, role] of Object.entries(ROLES)) {
    for (const limit of [0, 2]) {
      let count = 0;
      const runner = runnerWith(async (request) => {
        count++;
        return proseResponse(request);
      });
      const result = await role.run(runner, limit);
      assert.equal(count, name === "librarian" ? 3 : limit + 1, `${name} limit ${limit}`);
      if (name === "librarian") {
        assert.equal(result.ok, false);
      } else {
        assert.equal(result.error_key, "output_format_invalid", name);
        assert.equal(result.retry_allowed, false, name);
        assert.equal(result.failure_class, "deterministic", name);
      }
    }
  }
  let count = 0;
  const codex = createAgentRunner({
    adapter: "codex-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        count++;
        return { adapter: request.adapter, stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "no JSON" } }), stderr: "", exit_code: 0, signal: null, provider_session_id: "thread-X" };
      },
    },
  });
  const result = await codex.runWorker(limited(1));
  assert.equal(count, 2);
  assert.equal(result.error_key, "report_format_invalid");
});

test("the limit comes from the settings reader when the request carries none", async () => {
  let count = 0;
  const runner = runnerWith(async (request) => {
    count++;
    return proseResponse(request);
  });
  runner.setOutputResubmitLimit(() => 1);
  const result = await runner.runManagerPlan(managerRequest());
  assert.equal(count, 2);
  assert.equal(result.error_key, "output_format_invalid");
});
