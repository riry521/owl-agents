import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { withNecessity } from "../helpers/necessity.mjs";
import { waitFor } from "../helpers/wait.mjs";

// The final report Manager writes when a Work completes, in three sections: stored once, returned by GET /works/{id},
// checked by final_report_text_checks, and never a reason for the Work not to complete.

const REPORT_MARKER = "You write its final report";

/** A runner whose provider answers the final report prompt with `reportAnswer(prompt, request)` and everything else as a completed final check. */
function providerRunner(reportAnswer, requests) {
  return createAgentRunner({
    adapter: "claude-cli/v1",
    provider: {
      execute: async (request) => {
        const prompt = String(request.prompt ?? request.input ?? JSON.stringify(request));
        let out;
        if (prompt.includes(REPORT_MARKER)) {
          requests.push({ prompt, request });
          out = await reportAnswer(prompt, request);
        } else {
          out = { verdict: { verdict: "complete", summary: "done", missing: [], lessons: [] } };
        }
        return { adapter: request.adapter, stdout: typeof out === "string" ? out : JSON.stringify(out), stderr: "", exit_code: 0, signal: null, format: "plain-text" };
      },
    },
  });
}

/** A running Work whose only Task is completed, finished by the final check once started. */
async function completeWork(t, { reportAnswer, finalReportTextChecks, settings = {} }) {
  const requests = [];
  const agentRunner = {};
  const { db, core } = await createTestCore(t, { agentRunner, finalReportTextChecks, dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 } }, { prefix: "owl-final-report-" });
  const runner = providerRunner(reportAnswer, requests);
  Object.assign(agentRunner, withNecessity({
    ...runner,
    runManagerPlan: async (request) => request.mode === "finalize"
      ? { outcome: "success", report_valid: true, report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "All done.", missing: [], lessons: [] } } }
      : { outcome: "failed", message: "unexpected" },
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  }));
  const workId = (await core.createWork(command({ title: "Export", summary: "Add an export page", size: "normal", project_id: null }, `create-${createUlid()}`))).data.work_id;
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    for (const [key, value] of Object.entries(settings)) {
      tx.run("INSERT OR REPLACE INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES (?, 'owner:default', '1.0.0', ?, ?)", key, JSON.stringify(value), now);
    }
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
       VALUES (?, ?, 'Build page', 'code', 'completed', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`,
      createUlid(), workId, now, now,
    );
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
  });
  await core.start();
  await core.tick(workId);
  await waitFor(() => db.get("SELECT state FROM works WHERE id = ?", workId)?.state === "completed", { message: "the Work completed" });
  return { db, core, workId, requests };
}

const sectionsOf = (summary, test_results = "All criteria met.", issues = "None.") => ({ summary, test_results, issues });
const reportOf = (core, workId) => core.getWork(workId).data.final_report;
const quiet = (t) => t.mock.method(console, "error", () => undefined);

test("a completed Work stores one final report that the work detail returns; an unfinished Work and a Work without one return null", async (t) => {
  const { db, core, workId, requests } = await completeWork(t, { reportAnswer: () => sectionsOf("Built the export page.", "Every criterion is met.", "None.") });
  await waitFor(() => reportOf(core, workId) !== null, { message: "the report was stored" });
  const { created_at, ...sections } = reportOf(core, workId);
  assert.deepEqual(sections, { summary: "Built the export page.", test_results: "Every criterion is met.", issues: "None." });
  assert.match(created_at, /^\d{4}-\d{2}-\d{2}T/u);
  assert.deepEqual(core.getWorkView(workId).work.final_report, reportOf(core, workId), "the view returns the same report");
  assert.equal(requests.length, 1, "the model is asked once");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM work_final_reports WHERE work_id = ?", workId).n, 1);

  const other = (await core.createWork(command({ title: "Other", summary: "x", size: "normal", project_id: null }, `create-${createUlid()}`))).data.work_id;
  assert.equal(reportOf(core, other), null, "a Work that is not completed has none");
  await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'completed' WHERE id = ?", other));
  assert.equal(reportOf(core, other), null, "a completed Work without a stored text has none");
});

test("the prompt asks for the three sections in the Work language with the Manager role's model", async (t) => {
  const settings = { language: "en", model_settings: { roles: [{ role: "manager", provider: "anthropic", model: "stub-manager-model", effort: "low" }] } };
  const { requests, core, workId } = await completeWork(t, { reportAnswer: () => sectionsOf("ok"), settings });
  await waitFor(() => reportOf(core, workId) !== null);
  const [{ prompt, request }] = requests;
  for (const point of [
    "summary is a brief report: what was done and what changed",
    "test_results gives the result of each acceptance criterion and of the tests",
    "issues lists the goals that were not met with the reason for each, and the issues that remain",
    "Never leave a section empty",
  ]) assert.ok(prompt.includes(point), point);
  for (const key of ["\"summary\"", "\"test_results\"", "\"issues\""]) assert.ok(JSON.stringify(request).includes(key), `the output schema has ${key}`);
  assert.ok(prompt.includes("Write every human-readable value in English"), "the output language follows the Owner language setting");
  assert.equal(request.model, "stub-manager-model");
});

test("a failing check has the model rewrite once and the rewrite is stored even when the second check still fails", async (t) => {
  quiet(t);
  const checked = [];
  const check = { name: "lint", run: async (input) => { checked.push(input); return { ok: false, problems: ["Too long."] }; } };
  const { core, workId, requests } = await completeWork(t, {
    finalReportTextChecks: [check],
    reportAnswer: (prompt) => prompt.includes("Too long.") ? sectionsOf("second", "tests 2", "issues 2") : sectionsOf("first", "tests 1", "issues 1"),
  });
  await waitFor(() => reportOf(core, workId) !== null);
  const { created_at: _created, ...stored } = reportOf(core, workId);
  assert.deepEqual(stored, { summary: "second", test_results: "tests 2", issues: "issues 2" });
  assert.deepEqual(checked.map(({ language: _language, ...sections }) => sections), [
    { summary: "first", test_results: "tests 1", issues: "issues 1" },
    { summary: "second", test_results: "tests 2", issues: "issues 2" },
  ], "every section is checked, twice and never a third time");
  assert.equal(requests.length, 2);
  assert.match(requests[1].prompt, /Too long\./u, "the problems go to the model");
  for (const earlier of ["first", "tests 1", "issues 1"]) assert.ok(requests[1].prompt.includes(earlier), `the earlier ${earlier} goes to the model`);
  for (const { prompt } of requests.slice(0, 2)) {
    for (const part of ["no specialist knowledge", "junior-high or high-school student", "Avoid technical terms, identifiers and abbreviations", "add a short explanation", "Keep every sentence short", "Start with what changed and what got better"]) assert.ok(prompt.includes(part), part);
  }
});

test("without final_report_text_checks, or with [], no check runs", async (t) => {
  for (const finalReportTextChecks of [undefined, []]) {
    const { core, workId, requests } = await completeWork(t, { finalReportTextChecks, reportAnswer: () => sectionsOf("plain") });
    await waitFor(() => reportOf(core, workId) !== null);
    assert.equal(reportOf(core, workId).summary, "plain");
    assert.equal(requests.length, 1);
  }
});

test("a model error or a failing check still completes the Work and leaves final_report null", async (t) => {
  const errors = t.mock.method(console, "error", () => undefined);
  const failing = await completeWork(t, { reportAnswer: () => { throw new Error("provider down"); } });
  await waitFor(() => errors.mock.calls.some((c) => String(c.arguments[0]).includes("Final report failed")));
  assert.equal(reportOf(failing.core, failing.workId), null);
  assert.equal(failing.db.get("SELECT state FROM works WHERE id = ?", failing.workId).state, "completed");

  const broken = await completeWork(t, { finalReportTextChecks: [{ name: "lint", run: async () => { throw new Error("exit 1"); } }], reportAnswer: () => sectionsOf("text") });
  await waitFor(() => errors.mock.calls.filter((c) => String(c.arguments[0]).includes("Final report failed")).length >= 2);
  assert.equal(reportOf(broken.core, broken.workId), null);
  assert.equal(broken.db.get("SELECT state FROM works WHERE id = ?", broken.workId).state, "completed");
});
