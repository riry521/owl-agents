import { CoreRequestError, commandEnvelopeFor, type CoreClient } from "../client";

/**
 * A Decision answer submission with a deterministic idempotency key and the
 * Decision's expected state_version, so retrying the exact same action (the
 * same button, the same replied-to message) replays Core's first response
 * instead of racing a second write against it.
 */
export interface DecisionAnswerRequest {
  readonly decisionId: string;
  readonly answer: string;
  readonly optionKey: string | null;
  /** What to show the Owner if this turns out to already be answered: the option's label, or the free-text answer itself. */
  readonly displayLabel: string;
  readonly source: "slack" | "discord";
  readonly sourceMessageId: string | null;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
}

export type DecisionAnswerOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "already_answered"; readonly label: string };

/**
 * Error codes core.ts returns for a Decision that is no longer open
 * (resolved or cancelled) or whose state_version has moved past what the
 * caller expected. Core has no single-Decision GET endpoint to tell resolved
 * apart from cancelled, so both are reported the same way: as already
 * answered, using the caller's own attempted label rather than the (unknown)
 * winning one.
 */
const ALREADY_SETTLED_CODES = new Set(["decision_already_resolved", "version_conflict", "decision_not_found"]);

/** Submit a Decision answer, turning a duplicate/retried submission into an "already answered" outcome instead of an error. */
export async function submitDecisionAnswer(
  core: CoreClient,
  request: DecisionAnswerRequest,
): Promise<DecisionAnswerOutcome> {
  try {
    await core.request(`/decisions/${request.decisionId}/answer`, {
      method: "POST",
      body: commandEnvelopeFor({
        payload: {
          answer: request.answer,
          option_key: request.optionKey,
          source: request.source,
          source_message_id: request.sourceMessageId,
        },
        idempotencyKey: request.idempotencyKey,
        expectedVersion: request.expectedVersion,
      }),
    });
    return { kind: "accepted" };
  } catch (error) {
    if (error instanceof CoreRequestError && ALREADY_SETTLED_CODES.has(error.code)) {
      return { kind: "already_answered", label: request.displayLabel };
    }
    throw error;
  }
}
