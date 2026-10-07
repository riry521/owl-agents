// Pure helpers for the shared WorkConversation component.

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
  if (err?.kind === 'network_error') return { messageKey: 'work.errorNetwork', refetch: false };
  if (err?.status === 409) {
    switch (err.code) {
      case 'version_conflict':
        return { messageKey: 'workChat.errorVersionConflict', refetch: true };
      case 'work_reopen_required':
        return { messageKey: 'workChat.errorReopenRequired', refetch: true };
      case 'work_cancelled':
        return { messageKey: 'work.instructionCancelledNote', refetch: true };
      case 'invalid_state_transition':
        return { messageKey: 'work.instructionNotStartedNote', refetch: true };
      default:
        return { messageKey: 'work.instructionError', refetch: true };
    }
  }
  if (err?.status === 400 && err.code === 'validation_error') {
    return { messageKey: 'workChat.errorValidation', refetch: false };
  }
  return { messageKey: 'work.instructionError', refetch: false };
}

/**
 * Badge for an owner instruction. `instruction` is the message's
 * `{status, outcome}` (null for legacy messages -> no badge).
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
 * @returns {{labelKey: string, tone: string, noteKey: string | null} | null}
 */
export function latestInstructionSummary(messages, workState) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    if (messages[i].instruction) return instructionBadge(messages[i].instruction, workState);
  }
  return null;
}

/** True while any instruction is still queued or being processed. */
export function isConversationPending(data) {
  return Boolean(
    data?.messages?.some((m) => m.instruction?.status === 'queued' || m.instruction?.status === 'processing'),
  );
}

/** @returns {'owner' | 'manager' | 'advisor'} */
export function messageRole(message) {
  if (message?.source === 'manager') return 'manager';
  if (message?.source === 'advisor') return 'advisor';
  return 'owner';
}
