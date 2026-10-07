import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { coreTaskDecisionBrief } from "../../packages/core/dist/decision-brief.js";
import { outputResubmitLimit, reportResubmitLimit } from "../../packages/core/dist/report-resubmit.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { createTestCore, command } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";
import { waitFor as waitForCondition } from "../helpers/wait.mjs";
import os from "node:os";
// Some runners start tests with an empty environment; child processes need PATH and HOME.
process.env.PATH ||= [process.execPath.replace(/\/[^/]+$/u, ""), "/usr/bin", "/bin"].join(":");
process.env.HOME ||= os.homedir();
const envelope = (payload, suffix, expectedVersion = 0) => command(payload, `test:${suffix}:${createUlid()}`, expectedVersion);

const pollFor = (read) => waitForCondition(read, { timeoutMs: 15_000, intervalMs: 25 });

const snapshot = (cwd) => `${git(cwd, "rev-parse", "HEAD")}\n${git(cwd, "status", "--porcelain")}`;

function fill(value) {
  if (typeof value === "string") return /^<.+>$/u.test(value) ? `filled ${value.slice(1, -1)}` : value;
  if (Array.isArray(value)) return value.map(fill);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
  return value;
}

function validReport(prompt) {
  const body = prompt.slice(prompt.indexOf("## Output template\n") + "## Output template\n".length);
  const template = JSON.parse(body.slice(body.indexOf("\n{") + 1, body.indexOf("\n}\n") + 2));
  // No claimed file changes: the fake provider never edits files the report could name.
  return { type: "result", result: JSON.stringify({ ...fill(template), changes: [] }), session_id: "session-X" };
}

const failure = (request, subtype) => ({
  adapter: request.adapter,
  stdout: JSON.stringify({ type: "result", subtype, is_error: true, errors: ["x"], session_id: "session-X" }),
  stderr: "", exit_code: 1, signal: null, provider_session_id: "session-X",
});
const formatFailure = (request) => failure(request, "error_max_structured_output_retries");
const okResponse = (request, firstPrompt) => ({
  adapter: request.adapter, stdout: JSON.stringify(validReport(firstPrompt)), stderr: "", exit_code: 0, signal: null, provider_session_id: "session-X",
});

const planTask = { id: "T1", title: "A", type: "code", acceptance_criteria: [{ id: "AC1", text: "Done.", check: "node --test tests/a.test.mjs", serves: "the request", if_omitted: "the request is not met", check_weight: "light", weight_reason: "" }], necessity: { serves: "the request", if_omitted: "the request is not met" }, depends_on: [], required_sections: [], required_tests: [], replaces: [], review: true };
const pass = { verdict: "pass", summary: "Review.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } };

/** Core with the real agent-runtime Worker on a fake provider; `script(callNo, request, worktree)` answers each provider call. */
async function openCore(t, script, reviewer = async () => ({ outcome: "success", report_valid: true, report: pass, review: pass })) {
  const calls = [];
  const snapshots = [];
  let worktree = null;
  const runtime = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        calls.push(request);
        const response = await script(calls.length, request, worktree);
        snapshots.push(snapshot(worktree));
        return response;
      },
    },
  });
  const agentRunner = {
    runManagerPlan: async (request) => (request.mode ?? request.context?.mode) === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask] } }
      : { outcome: "failed", message: "stop" },
    runWorker: async (request) => {
      if (worktree === null) {
        worktree = request.context.worktree;
        await mkdir(worktree, { recursive: true });
        git(worktree, "init", "-q");
        git(worktree, "commit", "-q", "--allow-empty", "-m", "base");
      }
      return runtime.runWorker({ ...request, provider: "anthropic", model: "claude-sonnet-5-5" });
    },
    runReviewer: reviewer,
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core } = await createTestCore(t, { agentRunner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-report-format-", start: true });
  const created = await core.createWork(envelope({ title: "w", summary: "s", size: "normal", project_id: null }, "create"));
  await core.startWork(created.data.work_id, envelope({ mode: "normal" }, "start", created.version));
  return { db, core, calls, snapshots, workId: created.data.work_id };
}

const workerRuns = (db, workId) => db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE work_id = ? AND role = 'worker'", workId).n;
const taskCompleted = (db, workId) => pollFor(() => db.get("SELECT 1 AS ok FROM tasks WHERE work_id = ? AND status = 'completed'", workId));
const openDecision =(db, workId) => pollFor(() => db.get("SELECT id, reason, options_json, recommended, state_version FROM decisions WHERE work_id = ? AND status = 'open'", workId));
const reviewed = (db, workId) => pollFor(() => db.get("SELECT 1 AS ok FROM agent_runs WHERE work_id = ? AND role = 'reviewer' AND status = 'completed'", workId));

test("a format failure is resubmitted in the same session without touching the worktree", async (t) => {
  const { db, workId, calls, snapshots } = await openCore(t, async (n, request, worktree) => {
    if (n === 1) {
      await writeFile(join(worktree, "out.mjs"), "export {};\n");
      git(worktree, "add", "out.mjs");
      git(worktree, "commit", "-q", "-m", "work");
      await writeFile(join(worktree, "dirty.txt"), "wip\n");
      return formatFailure(request);
    }
    return okResponse(request, calls[0].prompt);
  });
  assert.ok(await reviewed(db, workId), "the Task reached review");
  assert.ok(await taskCompleted(db, workId), "the Task itself completed");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].provider_session_id, "session-X");
  assert.equal(workerRuns(db, workId), 1);
  assert.equal(snapshots[0], snapshots[1], "HEAD and git status are the same before and after the resubmission");
  assert.match(snapshots[1], /\?\? dirty\.txt/u);
});

test("reaching the limit opens a report-format Decision and resubmitting only the report never reruns the Task", async (t) => {
  let resubmit = false;
  const { db, core, workId, calls } = await openCore(t, async (n, request, worktree) => {
    if (n === 1) await writeFile(join(worktree, "out.mjs"), "export {};\n");
    return resubmit ? okResponse(request, calls[0].prompt) : formatFailure(request);
  });
  const decision = await openDecision(db, workId);
  assert.ok(decision);
  assert.match(decision.reason, /報告の書式違反/u);
  assert.ok(JSON.parse(decision.options_json).some((o) => o.key === "resubmit_report" && o.label === "報告だけ出し直す"));
  assert.equal(decision.recommended, "resubmit_report");
  assert.equal(calls.length, 3, "the first call plus two automatic resubmissions");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(workerRuns(db, workId), 1, "no new Worker generation starts while waiting");

  resubmit = true;
  await core.answerDecision(decision.id, envelope({ answer: "報告だけ出し直す", option_key: "resubmit_report", source_message_id: null }, "answer", decision.state_version));
  assert.ok(await reviewed(db, workId), "the Task moved on to review");
  assert.ok(await taskCompleted(db, workId), "the Task itself completed");
  assert.equal(calls.length, 4);
  assert.equal(calls[3].provider_session_id, "session-X");
  assert.match(calls[3].prompt, /Do not edit files/u);
  assert.doesNotMatch(calls[3].prompt, /## Output template/u);
});

test("a Reviewer whose verdict keeps breaking the format opens a Decision, and rerunning only the Reviewer never reruns the Worker", async (t) => {
  let reviews = 0;
  const { db, core, workId, calls } = await openCore(
    t,
    async (n, request, worktree) => {
      await writeFile(join(worktree, "out.mjs"), "export {};\n");
      return okResponse(request, calls[0].prompt);
    },
    async () => {
      reviews++;
      return reviews === 1
        ? { outcome: "failed", report_valid: false, failure_class: "deterministic", error_key: "output_format_invalid", retry_allowed: false, message: "verdict format" }
        : { outcome: "success", report_valid: true, report: pass, review: pass };
    },
  );
  const decision = await openDecision(db, workId);
  assert.ok(decision);
  assert.deepEqual(JSON.parse(decision.options_json).map((o) => o.key), ["rerun_review", "cancel"]);
  assert.equal(decision.recommended, "rerun_review");
  assert.equal(db.get("SELECT status, reviewer_failure_count FROM tasks WHERE work_id = ?", workId).reviewer_failure_count, 0);
  assert.equal(reviews, 1, "no automatic Reviewer rerun while waiting");

  await core.answerDecision(decision.id, envelope({ answer: "Reviewer だけやり直す", option_key: "rerun_review", source_message_id: null }, "answer", decision.state_version));
  assert.ok(await taskCompleted(db, workId), "the Task completed after the Reviewer reran");
  assert.equal(reviews, 2);
  assert.equal(workerRuns(db, workId), 1, "the Worker was not rerun");
  assert.equal(calls.length, 1);
});

test("a nonzero exit that is not a format violation keeps the Harness decision", async (t) => {
  const { db, workId, calls } = await openCore(t, async (n, request) => failure(request, "error_during_execution"));
  const decision = await openDecision(db, workId);
  assert.ok(decision);
  assert.match(decision.reason, /Harness/u);
  assert.ok(!JSON.parse(decision.options_json).some((o) => o.key === "resubmit_report"));
  assert.equal(decision.recommended, null);
  assert.equal(calls.length, 1);
});

test("coreTaskDecisionBrief only offers the resubmission for a format violation with a session", () => {
  const base = { error_key: "report_format_invalid", reason: "x" };
  assert.deepEqual(coreTaskDecisionBrief("T", { ...base, provider_session_id: "s" }, "ja").options.map((o) => o.key).slice(0, 2), ["resubmit_report", "retry"]);
  assert.ok(!coreTaskDecisionBrief("T", base, "ja").options.some((o) => o.key === "resubmit_report"));
  assert.equal(coreTaskDecisionBrief("T", { error_key: "provider_failed:exit:1", reason: "x" }, "ja").recommended, null);
});

test("reportResubmitLimit reads the setting and falls back to the default when it is missing or invalid", () => {
  const reader = (value) => ({ get: () => (value === undefined ? undefined : { value_json: value }) });
  assert.equal(reportResubmitLimit(reader(undefined)), 2);
  assert.equal(reportResubmitLimit(reader("0")), 0);
  assert.equal(reportResubmitLimit(reader("10")), 10);
  for (const bad of ["11", "-1", "1.5", '"3"', "{", "null"]) assert.equal(reportResubmitLimit(reader(bad)), 2, bad);
});

test("outputResubmitLimit reads output_resubmit_limit first, then the older report_resubmit_limit, then the default", () => {
  const reader = (rows) => ({ get: (_sql, key) => (rows[key] === undefined ? undefined : { value_json: rows[key] }) });
  assert.equal(outputResubmitLimit(reader({})), 2);
  assert.equal(outputResubmitLimit(reader({ report_resubmit_limit: "4" })), 4);
  assert.equal(outputResubmitLimit(reader({ output_resubmit_limit: "1", report_resubmit_limit: "4" })), 1);
  assert.equal(outputResubmitLimit(reader({ output_resubmit_limit: "11", report_resubmit_limit: "4" })), 4);
});
