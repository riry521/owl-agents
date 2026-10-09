import assert from "node:assert/strict";
import { copyFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createTestCore, command } from "../helpers/core.mjs";
import { openTestDatabase } from "../helpers/db.mjs";
import { migrationsDir as migrations } from "../helpers/paths.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

import { openDatabase, createUlid } from "../../packages/db/dist/index.js"; // helpers-exempt: migration 030 test migrates a partial migrations dir
import { agentRunDisplay } from "../../apps/web/lib/agent-run-display.mjs";
import { createAgentRunner, toolNamesInLine } from "../../packages/agent-runtime/dist/index.js"; // helpers-exempt: runner-level retry decision, no Core needed

// Child processes (sh, sleep) need a PATH even when the runner has none.
process.env.PATH ||= `${process.execPath.replace(/\/[^\/]*$/, "")}:/usr/bin:/bin`;

// agent_runs.status 'failed' means the run produced no valid result. A run
// that produced one is 'completed' and records agent_runs.outcome.

const envelope = (payload, suffix, expectedVersion = 0) => command(payload, `test:${suffix}:${createUlid()}`, expectedVersion);

async function openCore(t, agentRunner) {
  const { db, core } = await createTestCore(t, { agentRunner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-outcome-", start: true });
  await disablePlanQuality(db);
  return { db, core };
}

async function startWork(core, suffix) {
  const created = await core.createWork(envelope({ title: suffix, summary: "Record outcomes.", size: "normal", project_id: null }, `${suffix}-create`));
  await core.startWork(created.data.work_id, envelope({ mode: "normal" }, `${suffix}-start`, created.version));
  return created.data.work_id;
}

const planTask = { id: "T1", title: "A", type: "code", acceptance: "Done.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: true };
const managerMode = (request) => request.mode ?? request.context?.mode;
const managerPlansThenStops = async (request) => managerMode(request) === "plan"
  ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask] } }
  : { outcome: "failed", message: "The Manager stops here in this test." };

const workerReport = (invocationId, extra = {}) => ({
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
  ...extra,
});

const review = (verdict) => ({
  verdict,
  summary: "Review.",
  findings: verdict === "pass" ? [] : [{ severity: "major", description: "Broken." }],
  tests: { ran: false, command: "none", passed: 0, failed: 0 },
});

test("a Reviewer fix_required verdict completes the run as redo, then pass completes it as success", async (t) => {
  let reviews = 0;
  const { db, core } = await openCore(t, {
    runManagerPlan: managerPlansThenStops,
    runWorker: async (request) => (await writeFile(join(request.context.worktree, "out.mjs"), "export {};\n"), { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) }),
    runReviewer: async () => {
      reviews += 1;
      const body = review(reviews === 1 ? "fix_required" : "pass");
      return { outcome: reviews === 1 ? "failed" : "success", report_valid: true, report: body, review: body };
    },
    runAdvisor: async () => ({ reply: "" }),
  });
  const workId = await startWork(core, "reviewer-outcome");
  const rows = await waitFor(() => {
    const found = db.all("SELECT status, outcome FROM agent_runs WHERE work_id = ? AND role = 'reviewer' ORDER BY created_at, rowid", workId);
    return found.length >= 2 ? found : null;
  });
  assert.deepEqual(rows.slice(0, 2), [
    { status: "completed", outcome: "redo" },
    { status: "completed", outcome: "success" },
  ]);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE work_id = ? AND role = 'reviewer' AND status = 'failed'", workId).n, 0);
});

test("a Worker report with result failed completes the run as not_achieved and still counts a failure", async (t) => {
  let calls = 0;
  const { db, core } = await openCore(t, {
    runManagerPlan: managerPlansThenStops,
    runWorker: async (request) => {
      calls += 1;
      const report = workerReport(request.invocation_id, { result: "failed" });
      return { outcome: "failed", failure_class: "deterministic", error_key: "report_result:failed", retry_allowed: true, report_valid: true, report, message: "The Worker reported failed." };
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  });
  const workId = await startWork(core, "worker-not-achieved");
  const run = await waitFor(() => db.get("SELECT status, outcome FROM agent_runs WHERE work_id = ? AND role = 'worker' AND status = 'completed'", workId));
  assert.deepEqual(run, { status: "completed", outcome: "not_achieved" });
  const task = await waitFor(() => db.get("SELECT failure_count, same_error_count, last_error_key FROM tasks WHERE work_id = ? AND manager_task_id = 'T1' AND failure_count >= 1", workId));
  assert.ok(task.last_error_key);
  assert.ok(task.same_error_count >= 1);
  assert.ok(calls >= 1);
});

test("a Worker that cannot produce a valid result fails with no outcome", async (t) => {
  const { db, core } = await openCore(t, {
    runManagerPlan: managerPlansThenStops,
    runWorker: async () => ({ outcome: "failed", failure_class: "deterministic", error_key: "runtime:report_invalid:worker_schema", retry_allowed: false, message: "broke" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  });
  const workId = await startWork(core, "worker-error");
  const run = await waitFor(() => db.get("SELECT status, outcome FROM agent_runs WHERE work_id = ? AND role = 'worker' AND status = 'failed'", workId));
  assert.deepEqual(run, { status: "failed", outcome: null });
});

test("a Worker needs_replanning report completes the run as replan", async (t) => {
  const { db, core } = await openCore(t, {
    runManagerPlan: managerPlansThenStops,
    runWorker: async (request) => ({ outcome: "success", report_valid: true, report: workerReport(request.invocation_id, { needs_replanning: true }) }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  });
  const workId = await startWork(core, "worker-replan");
  const run = await waitFor(() => db.get("SELECT status, outcome FROM agent_runs WHERE work_id = ? AND role = 'worker' AND status = 'completed'", workId));
  assert.deepEqual(run, { status: "completed", outcome: "replan" });
});

test("the outcome column only takes the known values", async (t) => {
  const { db } = await openTestDatabase(t, { prefix: "owl-outcome-check-" });
  {
    assert.ok(db.all("PRAGMA table_info(agent_runs)").some((column) => column.name === "outcome" && column.notnull === 0));
    await assert.rejects(
      db.createWriteLane().transact((tx) => tx.run("INSERT INTO agent_runs (id, work_id, role, provider, model, status, outcome, created_at, updated_at) VALUES ('x','w','worker','p','m','completed','bogus','n','n')")),
      /CHECK constraint failed|FOREIGN KEY/,
    );
  }
});

test("migration 030 backfills outcomes from reviews, reports and retry events", async (t) => {
  const dir = await tempDir(t, "owl-outcome-migrations-");
  for (const name of (await readdir(migrations)).filter((file) => file.endsWith(".sql") && file < "030")) {
    await copyFile(join(migrations, name), join(dir, name));
  }
  const root = await tempDir(t, "owl-outcome-db-");
  const db = openDatabase(join(root, "owl.db")); // helpers-exempt: needs a DB migrated only up to migration 029
  db.migrate(dir);
  const now = new Date().toISOString();
  const workId = createUlid();
  const taskId = createUlid();
  const ids = Object.fromEntries(
    ["revPass", "revFix", "revReplan", "revCrash", "wSuccess", "wPartial", "wFailed", "wReplan", "wQuestion", "wBoth", "wRetry", "wCrash", "manager", "cancelled"].map((k) => [k, createUlid()]),
  );
  let sequence = 0;
  try {
    await db.createWriteLane().transact((tx) => {
      tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default','owner:default',?,?)", now, now);
      tx.run(
        `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, state_version, plan_revision, rules_json, related_work_ids_json, created_at, updated_at)
         VALUES (?, 'owner:default', NULL, 'W', 'x', 'normal', 'running', 0, 0, ?, '[]', ?, ?)`,
        workId, JSON.stringify({ schema_version: "1.0.0", rules: [] }), now, now,
      );
      tx.run(
        `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
         VALUES (?, ?, 'T', 'code', 'failed', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`,
        taskId, workId, now, now,
      );
      const run = (id, role, status) => tx.run(
        "INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'p', 'm', ?, ?, ?)",
        id, workId, taskId, role, status, now, now,
      );
      let round = 0;
      const reviewRow = (id, verdict) => tx.run(
        "INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at) VALUES (?, ?, ?, ?, '[]', '{}', ?)",
        id, taskId, round++, verdict, now,
      );
      run(ids.revPass, "reviewer", "completed"); reviewRow(ids.revPass, "pass");
      run(ids.revFix, "reviewer", "failed"); reviewRow(ids.revFix, "fix_required");
      run(ids.revReplan, "reviewer", "failed"); reviewRow(ids.revReplan, "replan_required");
      run(ids.revCrash, "reviewer", "failed");
      const reportRow = (id, result, payload) => tx.run(
        "INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at) VALUES (?, ?, '1.0.0', ?, ?, ?, 2, ?)",
        createUlid(), id, result, JSON.stringify({ result, ...payload }), "0".repeat(64), now,
      );
      run(ids.wSuccess, "worker", "completed"); reportRow(ids.wSuccess, "success", {});
      run(ids.wPartial, "worker", "failed"); reportRow(ids.wPartial, "partial", { needs_replanning: false, question_for_manager: null });
      run(ids.wFailed, "worker", "failed"); reportRow(ids.wFailed, "failed", {});
      run(ids.wReplan, "worker", "completed"); reportRow(ids.wReplan, "failed", { needs_replanning: true });
      run(ids.wQuestion, "worker", "completed"); reportRow(ids.wQuestion, "success", { question_for_manager: "Which one?" });
      run(ids.wBoth, "worker", "completed"); reportRow(ids.wBoth, "success", { needs_replanning: true, question_for_manager: "Which one?" });
      run(ids.wRetry, "worker", "failed");
      sequence += 1;
      tx.run(
        `INSERT INTO events (id, sequence, idempotency_key, type, work_id, task_id, agent_run_id, payload_json, status, attempt_no, created_at)
         VALUES (?, ?, ?, 'task.failure.classified', ?, ?, ?, ?, 'handled', 0, ?)`,
        createUlid(), sequence, `k:${sequence}`, workId, taskId, ids.wRetry, JSON.stringify({ error_key: "hybrid_worker_retry_requested" }), now,
      );
      run(ids.wCrash, "worker", "failed");
      run(ids.manager, "manager", "completed");
      run(ids.cancelled, "worker", "cancelled");
      return null;
    });
    db.migrate(migrations);
    const state = (id) => db.get("SELECT status, outcome FROM agent_runs WHERE id = ?", id);
    assert.deepEqual(state(ids.revPass), { status: "completed", outcome: "success" });
    assert.deepEqual(state(ids.revFix), { status: "completed", outcome: "redo" });
    assert.deepEqual(state(ids.revReplan), { status: "completed", outcome: "replan" });
    assert.deepEqual(state(ids.revCrash), { status: "failed", outcome: null });
    assert.deepEqual(state(ids.wSuccess), { status: "completed", outcome: "success" });
    assert.deepEqual(state(ids.wPartial), { status: "completed", outcome: "partial" });
    assert.deepEqual(state(ids.wFailed), { status: "completed", outcome: "not_achieved" });
    assert.deepEqual(state(ids.wReplan), { status: "completed", outcome: "replan" });
    assert.deepEqual(state(ids.wQuestion), { status: "completed", outcome: "question" });
    assert.deepEqual(state(ids.wBoth), { status: "completed", outcome: "question" });
    assert.deepEqual(state(ids.wRetry), { status: "completed", outcome: "redo" });
    assert.deepEqual(state(ids.wCrash), { status: "failed", outcome: null });
    assert.deepEqual(state(ids.manager), { status: "completed", outcome: "success" });
    assert.deepEqual(state(ids.cancelled), { status: "cancelled", outcome: null });
  } finally {
    db.close();
  }
});

test("the web display shows the outcome of a completed run and the status otherwise", () => {
  assert.deepEqual(agentRunDisplay("completed", "success"), { kind: "outcome", key: "success", tone: "green" });
  for (const outcome of ["redo", "replan", "question", "partial", "not_achieved"]) {
    assert.deepEqual(agentRunDisplay("completed", outcome), { kind: "outcome", key: outcome, tone: "amber" });
  }
  assert.deepEqual(agentRunDisplay("completed", null), { kind: "status", key: "completed", tone: "green" });
  assert.deepEqual(agentRunDisplay("failed", null), { kind: "status", key: "failed", tone: "red" });
  assert.deepEqual(agentRunDisplay("failed", "redo"), { kind: "status", key: "failed", tone: "red" });
  assert.deepEqual(agentRunDisplay("completed", "unknown"), { kind: "status", key: "completed", tone: "green" });
});

// A failure after an external side effect (a tool call that reaches outside the worktree) must not be
// retried automatically, however the error is classified.
const toolUseLine = (name) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input: {} }] } });
const sideEffectWorkerRequest = { invocation_id: "worker-side-effect", work_id: "work-1", task_id: "t1", attempt: 1, context: { task: { id: "t1", work_id: "work-1", title: "T", status: "running", type: "code", state_version: 0, updated_at: "2026-10-05T00:00:00.000Z", parent_task_id: null, acceptance: "Done.", review_round: 0, failure_count: 0, worker_generation: 0, depends_on: [] } } };

async function failedWorkerAfter(toolName, options = {}) {
  let calls = 0;
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    ...options,
    provider: { toolNamesInLine,
      execute: async (request) => {
        calls += 1;
        return { adapter: request.adapter, stdout: `${toolUseLine(toolName)}\n`, stderr: "API Error: 529 overloaded_error", exit_code: 1, signal: null, format: "provider-json" };
      },
    },
  });
  const result = await runner.runWorker(sideEffectWorkerRequest);
  return { result, calls };
}

test("a transient failure after a side-effect tool call is not retried, and one without is", async () => {
  const sideEffect = await failedWorkerAfter("mcp__slack__post_message");
  assert.equal(sideEffect.calls, 1);
  assert.equal(sideEffect.result.outcome, "failed");
  assert.equal(sideEffect.result.retry_allowed, false);
  assert.equal(sideEffect.result.failure_class, "deterministic");
  assert.match(sideEffect.result.error_key, /^side_effect_failure:/u);

  const safe = await failedWorkerAfter("Read");
  assert.equal(safe.calls, 1);
  assert.equal(safe.result.failure_class, "transient", "classification decides when no side effect was seen");
  assert.doesNotMatch(safe.result.error_key, /^side_effect_failure:/u);
});

test("which tools count as side effects is configurable", async () => {
  assert.equal((await failedWorkerAfter("Bash")).result.retry_allowed, false, "shell commands (gh, curl, deploy) are side effects by default");
  assert.equal((await failedWorkerAfter("Bash", { sideEffectTools: ["mcp__*"] })).result.failure_class, "transient");
  const custom = await failedWorkerAfter("Read", { sideEffectTools: ["Read"] });
  assert.equal(custom.result.retry_allowed, false);
  assert.match(custom.result.error_key, /^side_effect_failure:/u);
  assert.equal((await failedWorkerAfter("mcp__slack__post_message", { sideEffectTools: [] })).result.failure_class, "transient");
});

const formatFailureStdout = (...lines) => `${[...lines, JSON.stringify({ type: "result", is_error: true, subtype: "error_max_structured_output_retries" })].join("\n")}\n`;
async function reportFormatFailureCalls(toolName) {
  let calls = 0;
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: { toolNamesInLine,
      execute: async (request) => {
        calls += 1;
        return { adapter: request.adapter, stdout: formatFailureStdout(toolUseLine(toolName)), stderr: "", exit_code: 1, signal: null, format: "provider-json", provider_session_id: "s1" };
      },
    },
  });
  await runner.runWorker({ ...sideEffectWorkerRequest, context: { ...sideEffectWorkerRequest.context, report_resubmit_limit: 2 } });
  return calls;
}

test("report resubmission re-runs the provider whether or not the run had a side effect", async () => {
  assert.equal(await reportFormatFailureCalls("Read"), 3);
  assert.equal(await reportFormatFailureCalls("mcp__slack__post_message"), 3);
});

test("a reviewer failure after a side effect is not retryable", async () => {
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: { toolNamesInLine, execute: async (request) => ({ adapter: request.adapter, stdout: `${toolUseLine("mcp__slack__post_message")}\n`, stderr: "API Error: 529 overloaded_error", exit_code: 1, signal: null, format: "provider-json" }) },
  });
  const result = await runner.runReviewer({ ...sideEffectWorkerRequest, invocation_id: "reviewer-side-effect", review_round: 1, context: { ...sideEffectWorkerRequest.context, report: {
    kind: "report", schema_version: "1.1.0", invocation_id: "w1", result: "success", work_done: "Done.", delegation: { decomposition: "none", delegated: [], retained: [] }, changes: [], remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null,
    verification: { status: "passed", method: "Checked.", checks: [], integration_check: null, acceptance: [{ criterion_id: "AC1", criterion: "Works.", status: "passed", evidence: "Looked." }] },
  } } });
  assert.equal(result.retry_allowed, false);
  assert.match(result.error_key, /^side_effect_failure:/u);
});

test("a codex tool call that started but never completed counts as a side effect", async () => {
  const started = JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", server: "slack", tool: "post_message" } });
  const runner = createAgentRunner({
    adapter: "codex-cli/v1",
    outputLogDir: null,
    provider: { toolNamesInLine, execute: async (request) => ({ adapter: request.adapter, stdout: `${started}\n`, stderr: "stream disconnected", exit_code: 1, signal: null, format: "provider-json" }) },
  });
  const result = await runner.runWorker(sideEffectWorkerRequest);
  assert.equal(result.retry_allowed, false);
  assert.match(result.error_key, /^side_effect_failure:/u);
});

test("a codex shell command (command_execution) counts as a side effect by default", async () => {
  const started = JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "curl -X POST https://example.com" } });
  const runner = createAgentRunner({
    adapter: "codex-cli/v1",
    outputLogDir: null,
    provider: { toolNamesInLine, execute: async (request) => ({ adapter: request.adapter, stdout: `${started}\n`, stderr: "stream disconnected", exit_code: 1, signal: null, format: "provider-json" }) },
  });
  const result = await runner.runWorker(sideEffectWorkerRequest);
  assert.equal(result.retry_allowed, false);
  assert.match(result.error_key, /^side_effect_failure:/u);
});

test("a role-shaped Manager finalize failure after a side effect keeps the side-effect classification", async () => {
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: { toolNamesInLine, execute: async (request) => ({ adapter: request.adapter, stdout: `${toolUseLine("mcp__slack__post_message")}\n`, stderr: "API Error: 529 overloaded_error", exit_code: 1, signal: null, format: "provider-json" }) },
  });
  const work = { id: "work-1", title: "W", summary: "S", size: "normal", status: "running", tasks: [] };
  await assert.rejects(
    runner.runManagerPlan({ mode: "finalize", work, invocation_id: "manager-legacy-side-effect" }),
    (error) => error.outcome === "failed_after_side_effect" && error.retry_allowed === false,
  );
});

const codexShellStarted = JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "curl -X POST https://example.com" } });
const codexLimitError = JSON.stringify({ type: "error", message: "You've hit your usage limit. Try again in 45m" });
const limitedAfterBash = (stdoutTail) => createAgentRunner({
  adapter: "codex-cli/v1",
  outputLogDir: null,
  provider: { toolNamesInLine, execute: async (request) => ({ adapter: request.adapter, stdout: `${codexShellStarted}\n${stdoutTail}\n`, stderr: "", exit_code: 1, signal: null, format: "provider-json" }) },
});

test("a rate limit after a side effect stays rate_limited, other failures are still reclassified", async () => {
  const limited = await limitedAfterBash(codexLimitError).runWorker(sideEffectWorkerRequest);
  assert.equal(limited.failure_class, "rate_limited");
  assert.equal(limited.retry_allowed, true);
  assert.doesNotMatch(limited.error_key, /^side_effect_failure:/u);
  assert.ok(limited.rate_limit?.resets_at);
  const other = await limitedAfterBash(JSON.stringify({ type: "error", message: "stream disconnected" })).runWorker(sideEffectWorkerRequest);
  assert.equal(other.failure_class, "deterministic");
  assert.equal(other.retry_allowed, false);
  assert.match(other.error_key, /^side_effect_failure:/u);
});

test("a role-shaped rate limit after a side effect is rethrown without the side-effect marks, other errors keep them", async () => {
  const work = { id: "work-1", title: "W", summary: "S", size: "normal", status: "running", tasks: [] };
  await assert.rejects(
    limitedAfterBash(codexLimitError).runManagerPlan({ mode: "finalize", work, invocation_id: "manager-limited" }),
    (error) => error.outcome === undefined && error.failure_class === "rate_limited" && error.retry_allowed === undefined && error.code === "provider_failed" && Boolean(error.rate_limit?.resets_at),
  );
  await assert.rejects(
    limitedAfterBash(JSON.stringify({ type: "error", message: "stream disconnected" })).runManagerPlan({ mode: "finalize", work, invocation_id: "manager-other" }),
    (error) => error.outcome === "failed_after_side_effect" && error.failure_class === "deterministic" && error.retry_allowed === false,
  );
});

test("a role-shaped failure is marked rate_limited only when the runner classifier says so", async () => {
  const work = { id: "work-1", title: "W", summary: "S", size: "normal", status: "running", tasks: [] };
  const runnerFor = (execute) => createAgentRunner({ adapter: "claude-cli/v1", outputLogDir: null, provider: { toolNamesInLine, execute } });
  const result = (stderr, extra = {}) => async (request) => ({ adapter: request.adapter, stdout: "", stderr, exit_code: 1, signal: null, format: "provider-json", ...extra });
  const cases = [
    ["cause Error", async () => { throw new Error("You've hit your usage limit"); }, true],
    ["stderr only", result("You've hit your usage limit. Try again in 45m"), true],
    ["429", result("API Error: 429 Too Many Requests"), true],
    ["529", result("API Error: 529 overloaded_error"), false],
    ["argument list too long", async () => { throw Object.assign(new Error("spawn E2BIG: argument list too long"), { code: "E2BIG" }); }, false],
    ["serverOverloaded", result("", { harness_code: "serverOverloaded" }), false],
  ];
  for (const [label, execute, marked] of cases) {
    await assert.rejects(
      runnerFor(execute).runManagerPlan({ mode: "finalize", work, invocation_id: `manager-${label}` }),
      (error) => (error.failure_class === "rate_limited") === marked,
      label,
    );
  }
});
