/**
 * How an AgentRun's result is shown: a `completed` run that recorded an
 * outcome shows the outcome (success green, the rest amber); every other run
 * shows its status.
 *
 * Plain JS (like agent-run-tree.mjs) so node component tests load it without
 * the `@/` module aliases.
 */

const OUTCOME_TONES = {
  success: 'green',
  redo: 'amber',
  replan: 'amber',
  question: 'amber',
  partial: 'amber',
  not_achieved: 'amber',
};

const STATUS_TONES = {
  launch_pending: 'gray',
  spawned: 'accent',
  running: 'accent',
  exited: 'amber',
  completed: 'green',
  failed: 'red',
  spawn_failed: 'red',
  cancel_requested: 'amber',
  cancelled: 'red',
};

/** @returns {boolean} */
export function isAgentOutcome(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(OUTCOME_TONES, value);
}

/**
 * @param {string} status
 * @param {string | null | undefined} outcome
 * @returns {{ kind: 'outcome' | 'status', key: string, tone: 'green' | 'amber' | 'red' | 'gray' | 'accent' }}
 */
export function agentRunDisplay(status, outcome) {
  if (status === 'completed' && isAgentOutcome(outcome)) {
    return { kind: 'outcome', key: outcome, tone: OUTCOME_TONES[outcome] };
  }
  const tone = Object.prototype.hasOwnProperty.call(STATUS_TONES, status) ? STATUS_TONES[status] : 'gray';
  return { kind: 'status', key: status, tone };
}
