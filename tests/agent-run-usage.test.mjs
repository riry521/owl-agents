import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { addTokenUsage, cliTokenUsage, usageJson } from "../packages/shared/dist/index.js";
import { createAgentRunner, extractProviderUsage } from "../packages/agent-runtime/dist/index.js";
import { Core } from "../packages/core/dist/index.js";
import { extractExecutorUsage } from "../packages/core/dist/executor.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";

// The tokens each finished run spent are read from the provider CLI's
// stdout (Claude `usage`, Codex `turn.completed.usage`) and stored in
// agent_runs.usage_json. Usage the provider did not report is NULL and never
// changes the run's outcome.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = join(repoRoot, "packages/db/migrations");

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
const CODEX_USAGE = { input_tokens: 200, output_tokens: 40, cache_read_tokens: 150 };

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return { request_id: createUlid(), idempotency_key: `test:${suffix}:${createUlid()}`, expected_version: expectedVersion, payload };
}

async function waitFor(read, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
}

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
  assert.equal(usageJson({ input_tokens: 1, extra: 2 }), "{\"input_tokens\":1}");
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
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fillTemplate(entry)]));
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

test("a repaired Hybrid plan reports the tokens of both provider calls", async () => {
  let firstTemplate;
  const calls = [];
  const runner = providerJsonRunner("claude-cli/v1", (template, _request, call) => {
    if (call === 1) {
      firstTemplate = fillTemplate(template);
      return { subtasks: [firstTemplate.subtasks[0], firstTemplate.subtasks[0]] }; // duplicate subtask_id
    }
    return firstTemplate;
  }, { input_tokens: 10, output_tokens: 4 }, calls);
  const plan = await runner.runWorker(workerRequest({ hybrid_mode: true, hybrid_phase: "plan" }));
  assert.equal(calls.length, 2, "the plan was repaired once");
  assert.equal(plan.outcome, "success", plan.message);
  assert.deepEqual(plan.usage, { input_tokens: 20, output_tokens: 8 });
});

async function openCore(t, agentRunner, root) {
  root ??= await mkdtemp(join(tmpdir(), "owl-usage-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });
  await core.start();
  return { db, core };
}

async function startWork(core, suffix) {
  const created = await core.createWork(commandEnvelope({ title: suffix, summary: "Record token usage.", size: "normal", project_id: null }, `${suffix}-create`));
  await core.startWork(created.data.work_id, commandEnvelope({ mode: "normal" }, `${suffix}-start`, created.version));
  return created.data.work_id;
}

const planTask = { id: "T1", title: "A", type: "code", acceptance: "Done.", depends_on: [], replaces: [], review: true };
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
    runWorker: async (request) => ({ outcome: "success", report_valid: true, report: workerReport(request.invocation_id), usage: { input_tokens: 10, output_tokens: 2 } }),
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
    { input_tokens: 10, output_tokens: 2 },
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
  assert.deepEqual(JSON.parse(worker.usage_json), { input_tokens: 9, output_tokens: 3 });
  assert.equal(db.get("SELECT usage_json FROM agent_runs WHERE work_id = ? AND role = 'manager'", workId).usage_json, null);
});

async function fakeClaudeBin(root) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "claude"), [
    "#!/bin/sh",
    "cat >/dev/null",
    `echo '{"type":"result","result":"subtask done","usage":{"input_tokens":7,"output_tokens":3}}'`,
    "",
  ].join("\n"));
  await chmod(join(bin, "claude"), 0o755);
  return bin;
}

test("Hybrid Executor rows hold their own usage and the Worker row the plan and verdict sum", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-usage-hybrid-"));
  const originalPath = process.env.PATH;
  process.env.PATH = `${await fakeClaudeBin(root)}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  let verdictExecutorResults;
  const agentRunner = {
    runManagerPlan: async (request) => managerMode(request) === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{ ...planTask, type: "research", review: false }] } }
      : { outcome: "failed", message: "The Manager stops here in this test." },
    runWorker: async (request) => {
      if (request.context.hybrid_phase === "plan") {
        return {
          outcome: "success",
          report_valid: true,
          report: { subtasks: [
            { subtask_id: "s1", title: "Write", instruction: "Write the notes" },
            { subtask_id: "s2", title: "Check", instruction: "Check the notes" },
          ] },
          usage: { input_tokens: 100, output_tokens: 10 },
        };
      }
      verdictExecutorResults = request.context.executor_results;
      return {
        outcome: "success",
        report_valid: true,
        report: { ...workerReport(request.invocation_id), verdict: "ok" },
        usage: { input_tokens: 50, output_tokens: 5, cache_read_tokens: 40 },
      };
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await openCore(t, agentRunner, root);
  await core.setHybridMode(true);
  const workId = await startWork(core, "usage-hybrid");
  const worker = await waitFor(() => {
    const row = db.get("SELECT * FROM agent_runs WHERE work_id = ? AND role = 'worker'", workId);
    return row && !["launch_pending", "spawned", "running"].includes(row.status) ? row : null;
  }, 20_000);
  assert.ok(worker, "the Hybrid Worker run finishes");
  assert.deepEqual(JSON.parse(worker.usage_json), { input_tokens: 150, output_tokens: 15, cache_read_tokens: 40 });

  const executors = db.all("SELECT label, status, usage_json FROM agent_runs WHERE origin = 'spawned' ORDER BY created_at, rowid");
  assert.deepEqual(executors.map((row) => [row.label, row.status, JSON.parse(row.usage_json)]), [
    ["s1: Write", "completed", { input_tokens: 7, output_tokens: 3 }],
    ["s2: Check", "completed", { input_tokens: 7, output_tokens: 3 }],
  ]);
  const completed = db.all("SELECT json_extract(payload_json, '$.usage.output_tokens') AS output_tokens FROM events WHERE type = 'executor.completed'");
  assert.deepEqual(completed.map((row) => row.output_tokens), [3, 3]);

  // The verdict prompt's Executor results stay the ExecutorResult shape.
  assert.equal(verdictExecutorResults.length, 2);
  for (const result of verdictExecutorResults) {
    assert.deepEqual(Object.keys(result).sort(), ["duration_ms", "exit_code", "output", "subtask_id", "success"]);
  }
});
