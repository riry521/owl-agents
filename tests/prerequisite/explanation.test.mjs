import assert from "node:assert/strict";
import { test } from "node:test";

import { coreDecisionTexts, findInternalTerms } from "../../packages/shared/dist/index.js";
import { command } from "../helpers/core.mjs";
import { createExplainer, plainExplanation } from "../helpers/decision-explanation.mjs";
import { CRITERION_BEFORE, TITLE, WAIT, createRunner, openOwnerWait } from "../helpers/owner-wait.mjs";
import { waitFor } from "../helpers/wait.mjs";

// The shape of ops-dashboard Work #13: the Manager asks to wait on the Owner, so the Decision's reason is the wait's own sentences
// joined with " / " and ending with the Task's id, and its tried repeats the same conditions. The Owner gets a short explanation instead.

const SHORT = {
  summary: "The export job is paused until you check that the staging server can run it.",
};
const sentences = (text) => text.split(/[.!?。]+(?:\s|$)/u).filter((part) => part.trim() !== "").length;

const stored = (db, id) => JSON.parse(db.get("SELECT explanation_json FROM decisions WHERE id = ?", id).explanation_json);

test("an Owner-wait Decision gets a short explanation: the request holds its text and the Task, and the saved sentences are short and free of ids", async (t) => {
  const explainer = createExplainer({ held: false, result: (request) => ({ ok: true, explanation: { ...plainExplanation(request), ...SHORT } }) });
  const { db, core, decision, taskId } = await openOwnerWait(t, explainer);
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
  // next_steps is Core's sentence from the real route, not the model's.
  assert.equal(explanation.next_steps.split("\n").at(-1), (await coreTextsFor(core, decision)).texts.next_steps);
  for (const text of [explanation.summary]) {
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

const OWNER_WORDS = "NVIDIA GPU のマシンは使わず、Mac でできる範囲に変えて進めてください。";
const ADVICE = "The staging server is at 10.0.0.5 if that helps.";
const REWRITE_AFTER = "Runs on this Mac only.";
const rewriteTriage = () => ({ ok: true, triage: { route: "manager", reason: "The words change the scope.", criteria_rewrites: [{ criterion_id: "AC1", after: REWRITE_AFTER, check: "node --test on this Mac" }] } });
/** The payloads Core hands to decisions.resolve; to_manager is only there for an answer that goes to the Manager. */
const spyResolve = (core) => {
  const payloads = [];
  const resolve = core.decisions.resolve.bind(core.decisions);
  core.decisions.resolve = (request) => { payloads.push(request.payload); return resolve(request); };
  return payloads;
};
const answerRetry = (core, decision, answer, key = "answer") => core.answerDecision(decision.id, command({ answer, option_key: "retry", option_note: true, source: "advisor", source_message_id: null }, key, decision.state_version));
const taskRow = (db, workId) => db.get("SELECT status, acceptance_criteria_json FROM tasks WHERE work_id = ?", workId);

test("retry with words that change the criteria goes to the Manager, who rewrites the Task's criterion as the Owner's decision answer", async (t) => {
  const runner = createRunner({ triage: rewriteTriage, rewrittenText: REWRITE_AFTER });
  const { db, core, workId, decision } = await openOwnerWait(t, createExplainer({ held: false }), runner);

  const payloads = spyResolve(core);
  await answerRetry(core, decision, OWNER_WORDS);

  await waitFor(() => JSON.parse(taskRow(db, workId).acceptance_criteria_json)[0].text === REWRITE_AFTER, { message: "the criterion was rewritten" });
  assert.equal(runner.state.triageRequests.length, 1);
  assert.equal(runner.state.triageRequests[0].answer, OWNER_WORDS);
  const request = runner.state.replanRequests.at(-1);
  assert.equal(request.context.trigger?.kind ?? request.context.trigger, "owner_request");
  assert.notEqual(request.context.trigger?.automatic, true);
  const ownerRequests = JSON.stringify(request.context.owner_requests);
  assert.ok(ownerRequests.includes(`Criteria rewrites for Task \\"${TITLE}\\"`), ownerRequests);
  assert.ok(ownerRequests.includes(`\\"${CRITERION_BEFORE}\\" -> \\"${REWRITE_AFTER}\\"`), ownerRequests);
  assert.ok(ownerRequests.includes(`Owner's words: ${OWNER_WORDS}`), ownerRequests);
  const [criterion] = JSON.parse(taskRow(db, workId).acceptance_criteria_json);
  assert.deepEqual({ kind: criterion.origin.kind, source: criterion.origin.source, quote: criterion.origin.quote }, { kind: "owner", source: "decision_answer", quote: OWNER_WORDS });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'work.replan_rejected'").n, 0);
  assert.equal(payloads[0].to_manager, true);
});

test("retry with advice only goes to the Worker: the Task is ready again and no replan is asked for", async (t) => {
  const runner = createRunner({ triage: () => ({ ok: true, triage: { route: "worker", reason: "Only a hint.", criteria_rewrites: [] } }) });
  const { core, decision } = await openOwnerWait(t, createExplainer({ held: false }), runner);
  const replansBefore = runner.state.replans;
  const payloads = spyResolve(core);

  await answerRetry(core, decision, ADVICE);

  assert.equal("to_manager" in payloads[0], false);
  await waitFor(() => runner.state.workerCalls >= 2, { message: "the Worker ran again" });
  assert.ok(JSON.stringify(runner.state.workerRequests.at(-1).context).includes(ADVICE), "the next Worker context holds the advice");
  assert.equal(runner.state.replans, replansBefore);
  assert.equal(runner.state.triageRequests.length, 1);
});

test("retry with its own label is not read by the model", async (t) => {
  const runner = createRunner({ triage: rewriteTriage });
  const { core, decision } = await openOwnerWait(t, createExplainer({ held: false }), runner);
  const payloads = spyResolve(core);
  const label = JSON.parse(decision.options_json).find((option) => option.key === "retry").label;

  await core.answerDecision(decision.id, command({ answer: label, option_key: "retry", source: "web", source_message_id: null }, "label", decision.state_version));

  await waitFor(() => runner.state.workerCalls >= 2, { message: "the Worker ran again" });
  assert.equal(runner.state.triageRequests.length, 0);
  assert.equal("to_manager" in payloads[0], false);
});

test("a triage call that fails sends the words to the Manager without criteria rewrites", async (t) => {
  for (const triage of [
    () => ({ ok: false, error: "decision_answer_triage_unavailable" }),
    () => ({ ok: false, error: "timeout" }),
    () => ({ ok: true, triage: { route: "manager", reason: "x", criteria_rewrites: [{ criterion_id: "AC9", after: "a", check: "c" }] } }),
  ]) {
    const runner = createRunner({ triage });
    const { core, decision, runner: used } = await openOwnerWait(t, createExplainer({ held: false }), runner);
    const replansBefore = used.state.replans;

    await answerRetry(core, decision, OWNER_WORDS);

    await waitFor(() => used.state.replans > replansBefore, { message: "the Manager was asked to replan" });
    const ownerRequests = JSON.stringify(used.state.replanRequests.at(-1).context.owner_requests);
    assert.ok(ownerRequests.includes(`Owner's words: ${OWNER_WORDS}`), ownerRequests);
    assert.ok(!ownerRequests.includes("Criteria rewrites"), ownerRequests);
  }
});

/** The texts Core stores for this Decision, built from the routes Core itself reports and the Decision's own options. */
const coreTextsFor = async (core, decision, preface = []) => {
  const routes = await core.decisionAnswerRoutes(decision.id);
  const language = await core.getLanguage();
  const options = JSON.parse(decision.options_json);
  const texts = coreDecisionTexts({
    free_text_to: routes.free_text,
    options: options.map((option) => ({ key: option.key, description: option.description ?? "", words_to: option.key === "retry" ? routes.retry : "unspecified" })),
  }, language, preface);
  return { routes, texts };
};

test("a model answer with next_steps or option_notes is refused; Core stores its own texts and the model's sentences are stored nowhere", async (t) => {
  const WRONG_STEPS = "回答欄に書けば計画が直ります。";
  const WRONG_NOTE = "マネージャーが計画を直します。";
  const explainer = createExplainer({
    held: false,
    result: (request) => ({ ok: true, explanation: { ...plainExplanation(request), next_steps: WRONG_STEPS, option_notes: [{ key: "retry", note: WRONG_NOTE }] } }),
  });
  const { db, core, decision } = await openOwnerWait(t, explainer);
  await waitFor(() => stored(db, decision.id).status !== "pending", { message: "the explanation was written" });

  assert.ok(explainer.requests.length >= 2, "the model was asked again after the refusal");
  const retried = explainer.requests.find((request) => request.revision);
  assert.match(String(retried?.revision?.problems?.[0]), /next_steps:not_allowed/u);
  const explanation = stored(db, decision.id);
  assert.deepEqual([explanation.status, explanation.plain], ["ready", true]);
  const { routes, texts } = await coreTextsFor(core, decision);
  assert.equal(routes.retry, "worker", "this runner cannot judge an answer");
  assert.equal(routes.free_text, "worker");
  assert.equal(explanation.next_steps.split("\n").at(-1), texts.next_steps);
  assert.deepEqual(explanation.option_notes.filter((entry) => texts.option_notes.some((n) => n.key === entry.key)), texts.option_notes);
  const raw = db.get("SELECT explanation_json FROM decisions WHERE id = ?", decision.id).explanation_json;
  assert.ok(!raw.includes(WRONG_STEPS) && !raw.includes(WRONG_NOTE), "the refused sentences are not stored");
});

test("a clean answer is stored as ready with the texts Core wrote from the routes", async (t) => {
  const explainer = createExplainer({ held: false, result: (request) => ({ ok: true, explanation: { ...plainExplanation(request), ...SHORT } }) });
  const { db, core, decision } = await openOwnerWait(t, explainer);
  await waitFor(() => stored(db, decision.id).status !== "pending", { message: "the explanation was written" });
  const explanation = stored(db, decision.id);
  const { texts } = await coreTextsFor(core, decision);
  assert.deepEqual([explanation.status, explanation.plain ?? false], ["ready", false]);
  assert.equal(explanation.next_steps, texts.next_steps);
  assert.deepEqual(explanation.option_notes, texts.option_notes);
});

test("a runner that can judge answers routes retry and free text to judged, and cancel has no note", async (t) => {
  const runner = createRunner({ triage: rewriteTriage });
  const explainer = createExplainer({ held: false });
  const { db, core, decision } = await openOwnerWait(t, explainer, runner);
  await waitFor(() => stored(db, decision.id).status !== "pending", { message: "the explanation was written" });
  const { routes, texts } = await coreTextsFor(core, decision);
  assert.deepEqual(routes, { retry: "judged", free_text: "judged" });
  const explanation = stored(db, decision.id);
  assert.equal(explanation.next_steps, texts.next_steps);
  assert.deepEqual(explanation.option_notes, texts.option_notes);
  assert.equal(explanation.option_notes.some((entry) => entry.key === "cancel"), false);
  assert.ok(explanation.option_notes.some((entry) => entry.key === "retry"));
});

test("with a runner that cannot judge, a retry that changes the conditions still goes to the Worker; the explanation says so", async (t) => {
  const runner = createRunner();
  const { db, core, decision } = await openOwnerWait(t, createExplainer({ held: false }), runner);
  await waitFor(() => stored(db, decision.id).status !== "pending", { message: "the explanation was written" });
  assert.deepEqual((await coreTextsFor(core, decision)).routes, { retry: "worker", free_text: "worker" });
  const replansBefore = runner.state.replans;
  const payloads = spyResolve(core);
  await answerRetry(core, decision, OWNER_WORDS);
  await waitFor(() => runner.state.workerCalls >= 2, { message: "the Worker ran again" });
  assert.equal("to_manager" in payloads[0], false);
  assert.equal(runner.state.replans, replansBefore);
});
