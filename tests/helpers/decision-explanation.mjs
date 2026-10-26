import assert from "node:assert/strict";

import { waitFor } from "./wait.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a model that follows the rules answers: a note for every option, Core's recommendation or the first key. */
export function plainExplanation(request) {
  return {
    summary: "The work stopped before it could be finished.",
    cause_kind: "work",
    next_steps: "Pick one of the choices below to go on.",
    option_notes: request.decision.options.map((option) => ({ key: option.key, note: "Carries on with this choice." })),
    options: [],
    recommended_option_key: request.decision.recommended ?? request.decision.options[0].key,
  };
}

/**
 * A runDecisionExplanation that holds every answer until release() (or answers `result` at once when `held` is false).
 * @param {{ held?: boolean, result?: (request: object) => object }} [options]
 */
export function createExplainer({ held = true, result = (request) => ({ ok: true, explanation: plainExplanation(request) }) } = {}) {
  const requests = [];
  let release = () => {};
  const gate = held ? new Promise((resolve) => { release = resolve; }) : Promise.resolve();
  return {
    requests,
    release,
    runDecisionExplanation: async (request) => {
      requests.push(request);
      await gate;
      return result(request);
    },
  };
}

export const openedEvents = (db, decisionId) =>
  db.all("SELECT payload_json FROM events WHERE type = 'decision.opened'").map((row) => JSON.parse(row.payload_json)).filter((payload) => payload.decision_id === decisionId);

export const explanationStatus = (db, decisionId) => JSON.parse(db.get("SELECT explanation_json FROM decisions WHERE id = ?", decisionId).explanation_json).status;

/**
 * decision.opened is held back while the explanation is pending, comes once it is ready or failed, and does not come twice.
 * `explainer` must hold its answer (createExplainer()); `settleMs` is a few dispatcher ticks.
 */
export async function assertOpenedOnceAfterExplanation(db, decisionId, explainer, { settleMs = 300 } = {}) {
  await waitFor(() => explainer.requests.length >= 1, { message: "the explanation was asked for" });
  await sleep(settleMs);
  assert.equal(explanationStatus(db, decisionId), "pending", "the explanation is still pending");
  assert.equal(openedEvents(db, decisionId).length, 0, "no decision.opened while the explanation is pending");

  explainer.release();
  await waitFor(() => openedEvents(db, decisionId).length > 0, { message: "decision.opened" });
  await sleep(settleMs);
  const opened = openedEvents(db, decisionId);
  assert.equal(opened.length, 1, "decision.opened is emitted exactly once");
  const status = explanationStatus(db, decisionId);
  assert.ok(status === "ready" || status === "failed", `the notice came after the explanation was written (${status})`);
  if (status === "ready") assert.equal(typeof opened[0].explanation?.summary, "string", "the notice carries the explanation");
  return opened[0];
}
