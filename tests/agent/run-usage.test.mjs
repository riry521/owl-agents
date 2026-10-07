import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { addTokenUsage, cliTokenUsage, usageJson } from "../../packages/shared/dist/index.js";
import { createAgentRunner, extractProviderUsage } from "../../packages/agent-runtime/dist/index.js";
import { extractExecutorUsage } from "../../packages/core/dist/executor.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { withNecessity } from "../helpers/necessity.mjs";
import { waitFor } from "../helpers/wait.mjs";

// Child processes (sh, sleep) need a PATH even when the runner has none.
process.env.PATH ||= `${process.execPath.replace(/\/[^\/]*$/, "")}:/usr/bin:/bin`;

// The tokens each finished run spent are read from the provider CLI's
// stdout (Claude `usage`, Codex `turn.completed.usage`) and stored in
// agent_runs.usage_json. Usage the provider did not report is NULL and never
// changes the run's outcome.

const CLAUDE_STDOUT = JSON.stringify({
  type: "result",
  result: "{\"ok\":true}",
  usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 },
});
const CLAUDE_USAGE = { input_tokens: 120, output_tokens: 30, cache_read_tokens: 1000, cache_write_tokens: 50 };

const codexStdout = (text, usage = { input_tokens: 200, cached_input_tokens: 150, output_tokens: 40 }) => [
  JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
  JSON.stringify({ type: "item.completed", item: { id: "item-1", type: "agent_message", text } }),
  JSON.stringify({ type: "turn.completed", usage }),
  "",
].join("\n");
const CODEX_USAGE = { input_tokens: 50, output_tokens: 40, cache_read_tokens: 150 };

test("usage is read from Claude and Codex stdout, and anything else is null", () => {
  for (const extract of [(cli, stdout) => cliTokenUsage(cli, stdout), extractExecutorUsage]) {
    assert.deepEqual(extract("claude", CLAUDE_STDOUT), CLAUDE_USAGE);
    assert.deepEqual(extract("codex", codexStdout("{}")), CODEX_USAGE);
    // Codex 0.155 also names cache_write_input_tokens in its exec usage.
    assert.deepEqual(
      extract("codex", codexStdout("{}", { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 4, output_tokens: 2 })),
      { input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 4 },
    );
    assert.equal(extract("claude", JSON.stringify({ type: "result", result: "x" })), null, "no usage");
    assert.equal(extract("claude", JSON.stringify({ type: "result", result: "x", usage: { input_tokens: "12", output_tokens: -1 } })), null, "string and negative counts");
    assert.equal(extract("claude", "not json"), null);
    assert.equal(extract("codex", "not json\n{\"type\":\"turn.completed\"}\n"), null);
  }
  assert.deepEqual(
    cliTokenUsage("claude", JSON.stringify({ type: "result", result: "x", usage: { input_tokens: 5, output_tokens: 1.5 } })),
    { input_tokens: 5 },
    "a non-integer count is dropped, the rest is kept",
  );
  assert.equal(extractExecutorUsage("gemini", CLAUDE_STDOUT), null);

  // Core and agent-runtime read the same fixtures the same way.
  assert.deepEqual(extractProviderUsage({ adapter: "claude-cli/v1", stdout: CLAUDE_STDOUT, format: "provider-json" }), extractExecutorUsage("claude", CLAUDE_STDOUT));
  assert.deepEqual(extractProviderUsage({ adapter: "codex-cli/v1", stdout: codexStdout("{}") }), extractExecutorUsage("codex", codexStdout("{}")));
  assert.equal(extractProviderUsage({ adapter: "claude-cli/v1", stdout: CLAUDE_STDOUT, format: "plain-text" }), null);

  assert.equal(addTokenUsage(null, undefined), null);
  assert.deepEqual(addTokenUsage(null, { output_tokens: 3 }), { output_tokens: 3 });
  assert.deepEqual(addTokenUsage({ input_tokens: 1, output_tokens: 2 }, { output_tokens: 3, cache_read_tokens: 4 }), { input_tokens: 1, output_tokens: 5, cache_read_tokens: 4 });
  assert.equal(usageJson(null), null);
  assert.equal(usageJson({ input_tokens: "x" }), null);
  assert.equal(usageJson({ input_tokens: 1, extra: 2 }), "{\"input_tokens\":1,\"input_excludes_cache\":1}");
});

const TEMPLATE_HEADING = "## Output template\n";

function renderedTemplate(prompt) {
  const start = prompt.indexOf(TEMPLATE_HEADING);
  if (start === -1) return null;
  const body = prompt.slice(start + TEMPLATE_HEADING.length);
  return JSON.parse(body.slice(body.indexOf("\n{") + 1, body.indexOf("\n}\n") + 2));
}

/** Replace every unfilled `<...>` fill-in placeholder in a rendered template with a realistic value. */
function fillTemplate(value) {
  if (typeof value === "string") return /^<.+>$/.test(value) ? `filled ${value.slice(1, -1)}` : value;
  if (Array.isArray(value)) return value.map(fillTemplate);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === "acceptance_criteria" ? entry.map((criterion, index) => ({ ...fillTemplate(criterion), id: `AC${index + 1}`, check_weight: "light", weight_reason: "" })) : fillTemplate(entry)]));
  }
  return value;
}

/** Runner whose provider answers `answer(template, request)` as a real CLI's provider-json stdout. */
function providerJsonRunner(adapter, answer, usage, calls = []) {
  return createAgentRunner({
    adapter,
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        calls.push(request);
        const reply = JSON.stringify(answer(renderedTemplate(request.prompt), request, calls.length));
        const stdout = adapter.startsWith("codex")
          ? codexStdout(reply, usage)
          : JSON.stringify({ type: "result", result: reply, usage });
        return { adapter: request.adapter, stdout, stderr: "", exit_code: 0, signal: null, format: "provider-json" };
      },
    },
  });
}

const task = {
  id: "task-1",
  work_id: "work-1",
  title: "Add archived_at column",
  status: "running",
  type: "code",
  state_version: 0,
  updated_at: "2026-09-24T00:00:00.000Z",
  parent_task_id: null,
  acceptance: "Migration applies cleanly.",
  review_round: 0,
  failure_count: 0,
  worker_generation: 0,
  depends_on: [],
};

const workerRequest = (context = {}) => ({ invocation_id: "worker-1", work_id: "work-1", task_id: "task-1", attempt: 1, context: { task, ...context } });

const workerReport = (invocationId) => ({
  kind: "report",
  schema_version: "1.0.0",
  invocation_id: invocationId,
  result: "success",
  work_done: "Done.",
  delegation: {
    decomposition: "The whole Task stayed together.",
    delegated: [],
    retained: [{ part: "Whole Task", reason: "No safe independent part was identified." }],
  },
  changes: [],
  verification: { passed: true, method: "Checked." },
  remaining_issues: [],
  next_action: "none",
  needs_replanning: false,
  question_for_manager: null,
});

test("runner results carry the provider's usage for Claude and Codex adapters", async () => {
  const claudeUsage = { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 };
  const codexUsage = { input_tokens: 200, cached_input_tokens: 150, output_tokens: 40 };
  for (const [adapter, usage, expected] of [["claude-cli/v1", claudeUsage, CLAUDE_USAGE], ["codex-cli/v1", codexUsage, CODEX_USAGE]]) {
    const runner = providerJsonRunner(adapter, (template) => fillTemplate(template), usage);
    const worker = await runner.runWorker(workerRequest());
    assert.equal(worker.outcome, "success", worker.message);
    assert.deepEqual(worker.usage, expected, adapter);

    const manager = await runner.runManagerPlan({ invocation_id: "manager-1", work_id: "work-1", task_id: null, attempt: 1, context: { mode: "plan", work: { id: "work-1", title: "Archive Works" } } });
    assert.equal(manager.outcome, "success", manager.message);
    assert.deepEqual(manager.usage, expected);

    const finalize = await runner.runManagerPlan({ work: { id: "work-1", title: "Archive Works" }, mode: "finalize", tasks: [task], reports: [] });
    assert.ok(finalize.verdict, "the finalize path keeps its role shape");
    assert.deepEqual(finalize.usage, expected);

    const review = await runner.runReviewer({
      invocation_id: "reviewer-1", work_id: "work-1", task_id: "task-1", attempt: 1, review_round: 1,
      context: { task, report: workerReport("worker-1") },
    });
    assert.equal(review.outcome, "success", review.message);
    assert.deepEqual(review.usage, expected);
  }

  // Broken role output still spent the tokens; it fails as before and keeps them.
  const broken = await providerJsonRunner("claude-cli/v1", () => ({ unexpected: true }), claudeUsage).runWorker(workerRequest());
  assert.equal(broken.outcome, "failed");
  assert.deepEqual(broken.usage, CLAUDE_USAGE);

  // A provider that reports no usage leaves the key out.
  const silent = await providerJsonRunner("claude-cli/v1", (template) => fillTemplate(template), undefined).runWorker(workerRequest());
  assert.equal(silent.outcome, "success", silent.message);
  assert.equal("usage" in silent, false);
});

test("a Hybrid Worker session reports usage for its single provider call", async () => {
  const calls = [];
  const runner = providerJsonRunner("claude-cli/v1", (template) => fillTemplate(template), { input_tokens: 10, output_tokens: 4 }, calls);
  const hybridWorker = await runner.runWorker(workerRequest({ hybrid_mode: true }));
  assert.equal(calls.length, 1);
  assert.equal(hybridWorker.outcome, "success", hybridWorker.message);
  assert.deepEqual(hybridWorker.usage, { input_tokens: 10, output_tokens: 4 });
});

async function openCore(t, agentRunner, root) {
  const coreOptions = { agentRunner: withNecessity(agentRunner), dispatcher: { tick_interval_ms: 25 } };
  if (root !== undefined) coreOptions.owlRoot = root;
  const { db, core } = await createTestCore(t, coreOptions, { prefix: "owl-usage-", start: true });
  return { db, core };
}

async function startWork(core, suffix) {
  const created = await core.createWork(command({ title: suffix, summary: "Record token usage.", size: "normal", project_id: null }, `${suffix}-create`));
  await core.startWork(created.data.work_id, command({ mode: "normal" }, `${suffix}-start`, created.version));
  return created.data.work_id;
}

const planTask = { id: "T1", title: "A", type: "code", acceptance: "Done; verified by the test.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: true };
const managerMode = (request) => request.mode ?? request.context?.mode;
const outputTokens = (db, workId) => db.all(
  "SELECT role, json_extract(usage_json, '$.output_tokens') AS output_tokens FROM agent_runs WHERE work_id = ? ORDER BY created_at, rowid",
  workId,
).map((row) => [row.role, row.output_tokens]);

test("Core stores usage on Manager, Worker and Reviewer rows, and NULL when none was reported", async (t) => {
  const agentRunner = {
    runManagerPlan: async (request) => {
      const mode = managerMode(request);
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask] }, usage: { input_tokens: 10, output_tokens: 1 } };
      if (mode === "finalize") {
        return {
          outcome: "success",
          report_valid: true,
          report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } },
          usage: { input_tokens: 10, output_tokens: 4 },
        };
      }
      return { outcome: "failed", message: `unexpected manager ${mode}` };
    },
    runWorker: async (request) => (await writeFile(join(request.context.worktree, "out.mjs"), "export {};\n"), { outcome: "success", report_valid: true, report: workerReport(request.invocation_id), usage: { input_tokens: 10, output_tokens: 2 } }),
    // The Reviewer reports no usage.
    runReviewer: async () => {
      const review = { verdict: "pass", summary: "Looks right.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } };
      return { outcome: "success", report_valid: true, report: review, review };
    },
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await openCore(t, agentRunner);
  const workId = await startWork(core, "usage-stored");
  const done = await waitFor(() => db.get("SELECT state FROM works WHERE id = ? AND state = 'completed'", workId));
  assert.ok(done, `the Work completes (state=${db.get("SELECT state FROM works WHERE id = ?", workId)?.state})`);
  assert.deepEqual(outputTokens(db, workId), [["manager", 1], ["worker", 2], ["reviewer", null], ["manager", 4]]);
  assert.deepEqual(
    JSON.parse(db.get("SELECT usage_json FROM agent_runs WHERE work_id = ? AND role = 'worker'", workId).usage_json),
    { input_tokens: 10, output_tokens: 2, input_excludes_cache: 1 },
  );
  assert.equal(db.get("SELECT usage_json FROM agent_runs WHERE work_id = ? AND role = 'reviewer'", workId).usage_json, null);

  // The column only takes JSON.
  const runId = db.get("SELECT id FROM agent_runs WHERE work_id = ? AND role = 'reviewer'", workId).id;
  const setUsage = (value) => db.createWriteLane().transact((transaction) => transaction.run("UPDATE agent_runs SET usage_json = ? WHERE id = ?", value, runId));
  await assert.rejects(setUsage("not json"), /CHECK constraint failed/);
  await setUsage("{\"input_tokens\":1}");
  await setUsage(null);
  assert.ok(db.all("PRAGMA table_info(agent_runs)").some((column) => column.name === "usage_json" && column.notnull === 0));
});

test("a failed Worker still stores the tokens it spent", async (t) => {
  const agentRunner = {
    runManagerPlan: async (request) => managerMode(request) === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask] } }
      : { outcome: "failed", message: "The Manager stops here in this test." },
    runWorker: async () => ({
      outcome: "failed",
      failure_class: "deterministic",
      error_key: "runtime:report_invalid:worker_schema",
      retry_allowed: false,
      message: "The Worker broke its contract.",
      usage: { input_tokens: 9, output_tokens: 3 },
    }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await openCore(t, agentRunner);
  const workId = await startWork(core, "usage-failed");
  const worker = await waitFor(() => db.get("SELECT status, usage_json FROM agent_runs WHERE work_id = ? AND role = 'worker' AND status = 'failed'", workId));
  assert.ok(worker, "the Worker run fails");
  assert.deepEqual(JSON.parse(worker.usage_json), { input_tokens: 9, output_tokens: 3, input_excludes_cache: 1 });
  assert.equal(db.get("SELECT usage_json FROM agent_runs WHERE work_id = ? AND role = 'manager'", workId).usage_json, null);
});

test("Hybrid Worker usage belongs to its single run and reaches the Reviewer", async (t) => {
  const workerRequests = [];
  let reviewerRequest;
  const agentRunner = {
    runManagerPlan: async (request) => managerMode(request) === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{ ...planTask, type: "code", review: true }] } }
      : { outcome: "failed", message: "The Manager stops here in this test." },
    runWorker: async (request) => {
      workerRequests.push(request);
      await writeFile(join(request.context.worktree, "out.mjs"), "export {};\n");
      const report = workerReport(request.invocation_id);
      return {
        outcome: "success",
        report_valid: true,
        report: { ...report, verification: { ...report.verification, integration_check: { status: "passed", evidence: "Checked.", required: false } } },
        usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 40 },
      };
    },
    runReviewer: async (request) => {
      reviewerRequest = request;
      return new Promise(() => {});
    },
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await openCore(t, agentRunner);
  await core.setHybridMode(true);
  const workId = await startWork(core, "usage-hybrid-single-session");
  const worker = await waitFor(() => db.get("SELECT * FROM agent_runs WHERE work_id = ? AND role = 'worker' AND status = 'completed'", workId));
  assert.ok(worker, "the Worker run completes");
  assert.equal(workerRequests.length, 1);
  assert.equal(workerRequests[0].context.hybrid_mode, true);
  assert.equal(workerRequests[0].context.hybrid_phase, undefined);
  assert.deepEqual(JSON.parse(worker.usage_json), { input_tokens: 100, output_tokens: 10, cache_read_tokens: 40, input_excludes_cache: 1 });
  assert.ok(await waitFor(() => reviewerRequest));
  assert.deepEqual(reviewerRequest.context.report.delegation, workerReport(worker.id).delegation);
  assert.equal(worker.phase, null);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE work_id = ? AND type = 'worker.phase_changed'", workId).count, 0);
});
