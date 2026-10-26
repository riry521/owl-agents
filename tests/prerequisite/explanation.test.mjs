import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { findInternalTerms } from "../../packages/shared/dist/decision-explanation.js";
import { DEFAULT_PROGRESS_GUARD_SETTINGS } from "../../packages/shared/dist/progress-guard-settings.js";
import { createRetryingTestCore } from "../helpers/cleanup.mjs";
import { command } from "../helpers/core.mjs";
import { createExplainer, plainExplanation } from "../helpers/decision-explanation.mjs";
import { withNecessity } from "../helpers/necessity.mjs";
import { waitFor } from "../helpers/wait.mjs";

// The shape of ops-dashboard Work #13: the Manager asks to wait on the Owner, so the Decision's reason is the wait's own sentences
// joined with " / " and ending with the Task's id, and its tried repeats the same conditions. The Owner gets a short explanation instead.

const TITLE = "Add the export job to the ops dashboard";
const WAIT = {
  reason: "Waiting until the Owner confirms the staging server runs the export job",
  conditions: [
    { kind: "owner", target: "", paths: [], description: "Owner confirms the staging server runs the export job" },
    { kind: "owner", target: "", paths: [], description: "Owner confirms the export job finished on the staging server" },
  ],
};
const SHORT = {
  summary: "The export job is paused until you check that the staging server can run it.",
  next_steps: "Check the staging server, then pick the first choice to run the job again.",
};
const sentences = (text) => text.split(/[.!?。]+(?:\s|$)/u).filter((part) => part.trim() !== "").length;

const planTask = (extra = {}) => ({ id: "T1", title: TITLE, type: "code", acceptance: "The export job runs on staging; verified by the test.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false, ...extra });

/** The Worker asks a question once; the replan then answers with the Owner wait. */
function createRunner() {
  const state = { workerCalls: 0, replans: 0 };
  return {
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask()] } };
      if (mode === "replan") {
        state.replans += 1;
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [planTask({ wait_for: WAIT })] } };
      }
      return { outcome: "failed", message: `unexpected manager ${mode}` };
    },
    runWorker: async (request) => {
      state.workerCalls += 1;
      await mkdir(join(request.context.worktree, "src"), { recursive: true });
      await writeFile(join(request.context.worktree, "src/export.mjs"), "export const run = 1;\n");
      return {
        outcome: "success", report_valid: true,
        report: {
          kind: "report", schema_version: "1.0.0", invocation_id: request.invocation_id, result: "partial", work_done: "Done.", changes: [],
          verification: { passed: true, method: "Checked." }, remaining_issues: [], next_action: "none", needs_replanning: false,
          question_for_manager: "Does the staging server run the export job yet?",
        },
      };
    },
    runReviewer: async () => ({ outcome: "success", report_valid: true, report: { verdict: "pass", summary: "Looks right.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } }, review: { verdict: "pass", summary: "Looks right.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } } }),
    runAdvisor: async () => ({ reply: "" }),
  };
}

async function openOwnerWait(t, explainer) {
  const runner = createRunner();
  runner.runDecisionExplanation = explainer.runDecisionExplanation;
  const { db, core } = await createRetryingTestCore(t, { agentRunner: withNecessity(runner), dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-prereq-explanation-", start: true });
  await core.setProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, prerequisite_max_wait_hours: 5 });
  const created = await core.createWork(command({ title: "ops-dashboard", summary: "Add the export job.", size: "normal", project_id: null }, "ops-create"));
  await core.startWork(created.data.work_id, command({ mode: "normal" }, "ops-start", created.version));
  const workId = created.data.work_id;
  const decision = await waitFor(() => db.get("SELECT id, reason, question, current_state, tried, options_json, recommended, blocked_task_ids_json FROM decisions WHERE work_id = ? AND status = 'open'", workId), { message: "the Owner-wait Decision" });
  const taskId = JSON.parse(decision.blocked_task_ids_json)[0];
  return { db, core, workId, decision, taskId };
}

const stored = (db, id) => JSON.parse(db.get("SELECT explanation_json FROM decisions WHERE id = ?", id).explanation_json);

test("an Owner-wait Decision gets a short explanation: the request holds its text and the Task, and the saved sentences are short and free of ids", async (t) => {
  const explainer = createExplainer({ held: false, result: (request) => ({ ok: true, explanation: { ...plainExplanation(request), ...SHORT } }) });
  const { db, decision, taskId } = await openOwnerWait(t, explainer);
  await waitFor(() => stored(db, decision.id).status !== "pending", { message: "the explanation was written" });

  // The shape: " / "-joined, ending with the 26-character id, and the conditions repeated in tried.
  assert.match(decision.reason, new RegExp(` / ${taskId}$`, "u"));
  assert.match(taskId, /^[0-9A-Z]{26}$/u);
  assert.ok(decision.reason.split(" / ").length >= 4, decision.reason);
  assert.ok(decision.tried.includes(WAIT.conditions[0].description) && decision.tried.includes(WAIT.reason), "tried repeats the wait");

  assert.equal(explainer.requests.length, 1);
  const [request] = explainer.requests;
  assert.equal(request.kind, "prerequisite_wait");
  assert.deepEqual({ reason: request.decision.reason, question: request.decision.question, current_state: request.decision.current_state, tried: request.decision.tried }, {
    reason: decision.reason, question: decision.question, current_state: decision.current_state, tried: decision.tried,
  });
  assert.equal(request.task.title, TITLE);
  assert.ok(request.forbidden_terms.includes(taskId), "the Task's id is a forbidden term");

  const explanation = stored(db, decision.id);
  assert.equal(explanation.status, "ready");
  assert.equal(explanation.summary, SHORT.summary);
  assert.equal(explanation.next_steps, SHORT.next_steps);
  for (const text of [explanation.summary, explanation.next_steps]) {
    assert.ok(sentences(text) <= 2, text);
    assert.ok(text.length < decision.reason.length, "shorter than the original reason");
    assert.doesNotMatch(text, /[0-9A-Z]{26}/u, "no 26-character id");
    assert.doesNotMatch(text, /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/u, "no snake_case word");
    assert.deepEqual(findInternalTerms(text, request.forbidden_terms), []);
  }
});

test("an answer that names an id is refused: Core stores its fixed-form explanation and the Decision keeps its own text", async (t) => {
  let taskId = null;
  const explainer = createExplainer({
    held: false,
    result: (request) => ({ ok: true, explanation: { ...plainExplanation(request), ...SHORT, summary: `Task ${request.forbidden_terms.find((term) => /^[0-9A-Z]{26}$/u.test(term) && request.decision.reason.endsWith(term))} is paused.` } }),
  });
  const { db, decision, taskId: blockedId } = await openOwnerWait(t, explainer);
  taskId = blockedId;
  await waitFor(() => stored(db, decision.id).status !== "pending", { message: "the explanation was written" });

  assert.ok(explainer.requests[0].forbidden_terms.includes(taskId));
  const explanation = stored(db, decision.id);
  assert.deepEqual([explanation.status, explanation.plain, explanation.error], ["ready", true, "internal_terms"]);
  assert.ok(explanation.summary.length > 0 && explanation.next_steps.length > 0);
  const after = db.get("SELECT reason, question, current_state, tried, options_json, recommended FROM decisions WHERE id = ?", decision.id);
  assert.deepEqual(after, { reason: decision.reason, question: decision.question, current_state: decision.current_state, tried: decision.tried, options_json: decision.options_json, recommended: decision.recommended }, "the current text is kept");
  // The Decision is announced once, with the fixed-form explanation.
  const opened = await waitFor(() => db.all("SELECT payload_json FROM events WHERE type = 'decision.opened'").map((row) => JSON.parse(row.payload_json)).filter((payload) => payload.decision_id === decision.id), { message: "decision.opened" });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].explanation.summary, explanation.summary);
  assert.equal(opened[0].reason, decision.reason);
});
