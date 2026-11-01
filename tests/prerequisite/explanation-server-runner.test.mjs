import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { coreDecisionTexts } from "../../packages/shared/dist/index.js";
import { command } from "../helpers/core.mjs";
import { createExplainer } from "../helpers/decision-explanation.mjs";
import { createRunner, openOwnerWait } from "../helpers/owner-wait.mjs";
import { serverRunnerModuleWithout } from "../helpers/server-runner.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

// The explanation says where the Owner's words go. The server wraps the agent runtime, and the wrapper always has
// runDecisionAnswerTriage, so only decisionAnswerTriageAvailable tells Core whether the runtime can judge an answer.

const OWNER_WORDS = "NVIDIA GPU のマシンは使わず、Mac でできる範囲に変えて進めてください。";
const REWRITE_AFTER = "Runs on this Mac only.";
const ENV_KEYS = ["PATH", "HOME", "OWL_PROVIDER", "OWL_PROVIDER_ID", "OWL_PROVIDER_ADAPTER", "OWL_PROVIDER_EXECUTABLE", "OWL_CLAUDE_EXECUTABLE", "OWL_CODEX_EXECUTABLE"];

/** Sets the provider environment and returns the function that puts the previous one back. */
function setEnvironment(values) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  return () => {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
}

async function providerEnvironment(t) {
  const root = await tempDir(t, "owl-prereq-explanation-server-");
  const executable = path.join(root, "fake-claude");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);
  return { root, environment: { HOME: root, PATH: "/usr/bin:/bin", OWL_PROVIDER: "real", OWL_PROVIDER_ADAPTER: "claude-cli/v1", OWL_PROVIDER_EXECUTABLE: executable } };
}

const stored = (db, id) => JSON.parse(db.get("SELECT explanation_json FROM decisions WHERE id = ?", id).explanation_json);
const taskRow = (db, workId) => db.get("SELECT status, acceptance_criteria_json FROM tasks WHERE work_id = ?", workId);

/**
 * The wrapper createExternalAgentRunner returns, over a scripted delegate runner, and a Core that gets the wrapper itself.
 * The wrapper resolves the provider again on each call, so the fake provider environment stays until Core has stopped;
 * restoring it right after createExternalAgentRunner would make those calls look for a real claude on PATH.
 */
async function openThroughWrapper(t, delegate, explainer) {
  const { root, environment } = await providerEnvironment(t);
  const module = await serverRunnerModuleWithout(t, [], delegate);
  const restore = setEnvironment(environment);
  try {
    const wrapper = await module.createExternalAgentRunner(root, false);
    assert.equal(typeof wrapper.runDecisionAnswerTriage, "function", "the wrapper always has the method");
    const opened = await openOwnerWait(t, explainer, wrapper);
    // t.after hooks run in the order they were added, so this one runs after the hook that stops Core.
    t.after(restore);
    return { wrapper, ...opened };
  } catch (error) {
    restore();
    throw error;
  }
}

async function expectedTexts(core, decision) {
  const routes = await core.decisionAnswerRoutes(decision.id);
  const language = await core.getLanguage();
  const texts = coreDecisionTexts({
    free_text_to: routes.free_text,
    options: JSON.parse(decision.options_json).map((option) => ({ key: option.key, description: option.description ?? "", words_to: option.key === "retry" ? routes.retry : "unspecified" })),
  }, language);
  return { routes, texts };
}

test("a runtime without runDecisionAnswerTriage: the routes are worker, the stored texts say so, and a condition-changing retry goes to the Worker", async (t) => {
  const runner = createRunner();
  const explainer = createExplainer({ held: false });
  runner.runDecisionExplanation = explainer.runDecisionExplanation;
  const { wrapper, db, core, workId, decision } = await openThroughWrapper(t, runner, explainer);
  assert.equal(await wrapper.decisionAnswerTriageAvailable(), false);
  await waitFor(() => stored(db, decision.id).status !== "pending", { message: "the explanation was written" });

  const { routes, texts } = await expectedTexts(core, decision);
  assert.deepEqual(routes, { retry: "worker", free_text: "worker" });
  const explanation = stored(db, decision.id);
  assert.equal(explanation.next_steps, texts.next_steps);
  assert.deepEqual(explanation.option_notes, texts.option_notes);

  const replansBefore = runner.state.replans;
  const payloads = [];
  const resolve = core.decisions.resolve.bind(core.decisions);
  core.decisions.resolve = (request) => { payloads.push(request.payload); return resolve(request); };
  await core.answerDecision(decision.id, command({ answer: OWNER_WORDS, option_key: "retry", option_note: true, source: "advisor", source_message_id: null }, "answer", decision.state_version));

  await waitFor(() => runner.state.workerCalls >= 2, { message: "the Worker ran again" });
  assert.equal("to_manager" in payloads[0], false);
  assert.equal(runner.state.replans, replansBefore, "no owner replan");
  assert.equal(runner.state.triageRequests.length, 0);
  assert.equal(JSON.parse(taskRow(db, workId).acceptance_criteria_json)[0].text, "The export job runs on staging; verified by the test.", "the criterion is unchanged");
});

test("a runtime with runDecisionAnswerTriage: the routes are judged, and the same answer becomes a Manager owner_request", async (t) => {
  const runner = createRunner({ triage: () => ({ ok: true, triage: { route: "manager", reason: "The words change the scope.", criteria_rewrites: [{ criterion_id: "AC1", after: REWRITE_AFTER, check: "node --test on this Mac" }] } }) });
  const explainer = createExplainer({ held: false });
  runner.runDecisionExplanation = explainer.runDecisionExplanation;
  const { wrapper, db, core, workId, decision } = await openThroughWrapper(t, runner, explainer);
  assert.equal(await wrapper.decisionAnswerTriageAvailable(), true);
  await waitFor(() => stored(db, decision.id).status !== "pending", { message: "the explanation was written" });

  const { routes, texts } = await expectedTexts(core, decision);
  assert.deepEqual(routes, { retry: "judged", free_text: "judged" });
  const explanation = stored(db, decision.id);
  assert.equal(explanation.next_steps, texts.next_steps);
  assert.deepEqual(explanation.option_notes, texts.option_notes);

  await core.answerDecision(decision.id, command({ answer: OWNER_WORDS, option_key: "retry", option_note: true, source: "advisor", source_message_id: null }, "answer", decision.state_version));

  await waitFor(() => JSON.parse(taskRow(db, workId).acceptance_criteria_json)[0].text === REWRITE_AFTER, { message: "the criterion was rewritten" });
  const request = runner.state.replanRequests.at(-1);
  assert.equal(request.context.trigger?.kind ?? request.context.trigger, "owner_request");
  assert.equal(runner.state.triageRequests.length, 1, "the wrapper passed the answer to the delegate's judge");
  assert.ok(JSON.stringify(request.context.owner_requests).includes(`Owner's words: ${OWNER_WORDS}`));
});
