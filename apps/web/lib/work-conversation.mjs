// @ts-check
// Pure helpers for the shared WorkConversation component.

import { apiErrorKeyForCode } from './api-error-keys.mjs';

/**
 * Whether an instruction can be sent for a Work in `workState`.
 * @param {string} workState
 * @returns {{blocked: true, reasonKey: string} | {blocked: false, reopen: boolean, confirmKey?: string}}
 */
export function instructionBlock(workState) {
  if (workState === 'memo' || workState === 'ready') {
    return { blocked: true, reasonKey: 'work.instructionNotStartedNote' };
  }
  if (workState === 'cancelled') {
    return { blocked: true, reasonKey: 'work.instructionCancelledNote' };
  }
  if (workState === 'completed') {
    return { blocked: false, reopen: true, confirmKey: 'work.instructionReopenConfirm' };
  }
  return { blocked: false, reopen: false };
}

/**
 * Only Shift+Enter sends; Cmd/Ctrl+Enter and plain Enter do not (plain Enter is a newline). Touch devices
 * never send on a key, and IME composition is never interrupted.
 * @param {{key: string, shiftKey?: boolean, metaKey?: boolean, ctrlKey?: boolean, keyCode?: number, nativeEvent?: {isComposing?: boolean, keyCode?: number}}} event
 * @param {{isTouchDevice: boolean, composing: boolean}} state
 */
export function shouldSendOnKey(event, { isTouchDevice, composing }) {
  if (isTouchDevice || composing) return false;
  if (event.key !== 'Enter') return false;
  if (event.nativeEvent?.isComposing) return false;
  if (event.nativeEvent?.keyCode === 229) return false;
  return Boolean(event.shiftKey);
}

/**
 * Map a send failure to an i18n key and whether the parent must refetch.
 * @param {{kind?: string, status?: number | null, code?: string} | null | undefined} err
 * @returns {{messageKey: string, refetch: boolean}}
 */
export function humanizeInstructionError(err) {
  // kind が network_error なら code と status に関係なくネットワークの文言にし、再取得しない。
  // code を渡さないのは、409 の codes の表が kind より先に当たるのを避けるため。
  const networkKey = apiErrorKeyForCode('', err?.kind ?? '', { network: 'work.errorNetwork', networkFrom: 'kind', fallback: '' });
  if (networkKey) return { messageKey: networkKey, refetch: false };
  const code = err?.code ?? '';
  if (err?.status === 409) {
    return {
      messageKey: apiErrorKeyForCode(code, '', {
        versionConflict: 'workChat.errorVersionConflict',
        fallback: 'work.instructionError',
        codes: {
          work_reopen_required: 'workChat.errorReopenRequired',
          work_cancelled: 'work.instructionCancelledNote',
          invalid_state_transition: 'work.instructionNotStartedNote',
        },
      }),
      refetch: true,
    };
  }
  // validation_error の文言は 400 のときだけ出す。
  const validation = err?.status === 400 ? 'workChat.errorValidation' : undefined;
  return { messageKey: apiErrorKeyForCode(code, '', { validation, fallback: 'work.instructionError' }), refetch: false };
}

/**
 * Badge for an owner instruction. `instruction` is the message's
 * `{status, outcome}` (null for legacy messages -> no badge).
 * @param {any} instruction
 * @param {string} workState
 * @returns {{labelKey: string, tone: string, noteKey: string | null} | null}
 */
export function instructionBadge(instruction, workState) {
  if (!instruction) return null;
  if (instruction.status === 'queued') {
    if (workState === 'cancelled') return { labelKey: 'workChat.badgeCancelled', tone: 'muted', noteKey: null };
    const noteKey =
      workState === 'running' ? 'workChat.noteQueuedRunning'
      : workState === 'paused' ? 'workChat.noteQueuedPaused'
      : workState === 'judgement_waiting' ? 'workChat.noteQueuedJudgement'
      : null;
    return { labelKey: 'workChat.badgeQueued', tone: 'queued', noteKey };
  }
  if (instruction.status === 'processing') {
    return { labelKey: 'workChat.badgeProcessing', tone: 'processing', noteKey: 'workChat.noteProcessing' };
  }
  if (instruction.status === 'answered') {
    if (instruction.outcome === 'decision_opened') {
      return { labelKey: 'workChat.badgeDecision', tone: 'decision', noteKey: null };
    }
    return { labelKey: 'workChat.badgeAnswered', tone: 'answered', noteKey: null };
  }
  return null;
}

/**
 * Badge of the latest owner instruction (for the status line), or null when none.
 * @param {any[]} messages
 * @param {string} workState
 * @returns {{labelKey: string, tone: string, noteKey: string | null} | null}
 */
export function latestInstructionSummary(messages, workState) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    if (messages[i].instruction) return instructionBadge(messages[i].instruction, workState);
  }
  return null;
}

/**
 * True while any instruction is still queued or being processed.
 * @param {any} data
 */
export function isConversationPending(data) {
  return Boolean(
    data?.messages?.some((/** @type {any} */ m) => m.instruction?.status === 'queued' || m.instruction?.status === 'processing'),
  );
}

/**
 * @param {any} message
 * @returns {'owner' | 'manager' | 'advisor'}
 */
export function messageRole(message) {
  if (message?.source === 'manager') return 'manager';
  if (message?.source === 'advisor') return 'advisor';
  return 'owner';
}
