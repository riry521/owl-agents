import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_PROGRESS_GUARD_SETTINGS } from "../../packages/shared/dist/progress-guard-settings.js";
import { createRetryingTestCore } from "./cleanup.mjs";
import { command } from "./core.mjs";
import { withNecessity } from "./necessity.mjs";
import { waitFor } from "./wait.mjs";

// The shape of ops-dashboard Work #13: the Manager asks to wait on the Owner, so Core opens a prerequisite_wait Decision.

export const TITLE = "Add the export job to the ops dashboard";
export const WAIT = {
  reason: "Waiting until the Owner confirms the staging server runs the export job",
  conditions: [
    { kind: "owner", target: "", paths: [], description: "Owner confirms the staging server runs the export job" },
    { kind: "owner", target: "", paths: [], description: "Owner confirms the export job finished on the staging server" },
  ],
};
export const SUMMARY_LINE = "Add the export job.";
export const WORK_SUMMARY = `受け入れ条件:\n- ${SUMMARY_LINE}`;
export const CRITERION_BEFORE = "The export job runs on staging; verified by the test.";

/** The Task's first criterion is the Owner's, quoted from the Work summary, as in Work #11. */
const ownerCriterion = (text, check, origin) => ({
  id: "AC1", text, check, serves: "test fixture", if_omitted: "test fixture", check_weight: "light", weight_reason: "", kind: "work_check", requirement: "required", origin,
});
const FIRST_CRITERIA = [ownerCriterion(CRITERION_BEFORE, "node --test", { kind: "owner", source: "summary", quote: SUMMARY_LINE })];

const planTask = (extra = {}) => ({
  id: "T1", title: TITLE, type: "code", acceptance: CRITERION_BEFORE, acceptance_criteria: FIRST_CRITERIA,
  depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false, ...extra,
});

/**
 * The Worker asks a question once; the replan then answers with the Owner wait.
 * A replan that carries an Owner request (context.owner_requests) retries T1 with AC1 rewritten, quoting the Owner's words.
 * After the Owner's answer the Worker succeeds. `triage(request)` is the runDecisionAnswerTriage stub; none means the runner has no such method.
 */
export function createRunner({ triage, rewrittenText = "Runs on this Mac only." } = {}) {
  const state = { workerCalls: 0, workerRequests: [], replans: 0, replanRequests: [], triageRequests: [] };
  const runner = {
    state,
    runManagerPlan: async (request) => {
      const mode = request.mode ?? request.context?.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [planTask()] } };
      if (mode === "replan") {
        state.replans += 1;
        state.replanRequests.push(request);
        const ownerRequests = JSON.stringify(request.context?.owner_requests ?? []);
        const words = /Owner's words: ([^\n"\\]+)/u.exec(ownerRequests)?.[1];
        if (words !== undefined) {
          const criteria = [ownerCriterion(rewrittenText, "node --test", { kind: "owner", source: "decision_answer", quote: words.trim() })];
          return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [planTask({ acceptance: rewrittenText, acceptance_criteria: criteria })] } };
        }
        return { outcome: "success", report_valid: true, report: { event: "task.replanned", tasks: [planTask({ wait_for: WAIT })] } };
      }
      return { outcome: "failed", message: `unexpected manager ${mode}` };
    },
    runWorker: async (request) => {
      state.workerCalls += 1;
      state.workerRequests.push(request);
      await mkdir(join(request.context.worktree, "src"), { recursive: true });
      await writeFile(join(request.context.worktree, "src/export.mjs"), `export const run = ${state.workerCalls};\n`);
      const asked = state.workerCalls === 1;
      return {
        outcome: "success", report_valid: true,
        report: {
          kind: "report", schema_version: "1.0.0", invocation_id: request.invocation_id, result: asked ? "partial" : "success", work_done: "Done.", changes: [],
          verification: { passed: true, method: "Checked." }, remaining_issues: [], next_action: "none", needs_replanning: false,
          question_for_manager: asked ? "Does the staging server run the export job yet?" : null,
        },
      };
    },
    runReviewer: async () => ({ outcome: "success", report_valid: true, report: { verdict: "pass", summary: "Looks right.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } }, review: { verdict: "pass", summary: "Looks right.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } } }),
    runAdvisor: async () => ({ reply: "" }),
  };
  if (triage) {
    runner.runDecisionAnswerTriage = async (request) => {
      state.triageRequests.push(request);
      return triage(request);
    };
  }
  return withNecessity(runner);
}

/** Starts a Work whose Task waits on the Owner, and returns the open Decision. */
export async function openOwnerWait(t, explainer, runner = createRunner()) {
  runner.runDecisionExplanation = explainer.runDecisionExplanation;
  const { db, core } = await createRetryingTestCore(t, { agentRunner: runner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-prereq-explanation-", start: true });
  await core.setProgressGuardSettings({ ...DEFAULT_PROGRESS_GUARD_SETTINGS, prerequisite_max_wait_hours: 5 });
  const created = await core.createWork(command({ title: "ops-dashboard", summary: WORK_SUMMARY, size: "normal", project_id: null }, "ops-create"));
  await core.startWork(created.data.work_id, command({ mode: "normal" }, "ops-start", created.version));
  const workId = created.data.work_id;
  const decision = await waitFor(() => db.get("SELECT id, state_version, reason, question, current_state, tried, options_json, recommended, blocked_task_ids_json FROM decisions WHERE work_id = ? AND status = 'open'", workId), { message: "the Owner-wait Decision" });
  const taskId = JSON.parse(decision.blocked_task_ids_json)[0];
  return { db, core, runner, workId, decision, taskId };
}
