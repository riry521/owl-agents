import test from 'node:test';
import assert from 'node:assert/strict';
import {
  instructionBlock, shouldSendOnKey, humanizeInstructionError, instructionBadge,
  latestInstructionSummary, isConversationPending, messageRole,
} from '../../apps/web/lib/work-conversation.mjs';

test('instructionBlock blocks or allows sending according to the Work state', () => {
  assert.deepEqual(instructionBlock('memo'), { blocked: true, reasonKey: 'work.instructionNotStartedNote' });
  assert.deepEqual(instructionBlock('ready'), { blocked: true, reasonKey: 'work.instructionNotStartedNote' });
  assert.deepEqual(instructionBlock('cancelled'), { blocked: true, reasonKey: 'work.instructionCancelledNote' });
  assert.deepEqual(instructionBlock('completed'), { blocked: false, reopen: true, confirmKey: 'work.instructionReopenConfirm' });
  for (const s of ['running', 'paused', 'judgement_waiting']) {
    assert.deepEqual(instructionBlock(s), { blocked: false, reopen: false });
  }
});

test('shouldSendOnKey sends on Shift+Enter only outside touch input and composition', () => {
  const d = { isTouchDevice: false, composing: false };
  const ev = (o = {}) => ({ key: 'Enter', nativeEvent: {}, ...o });
  assert.equal(shouldSendOnKey(ev({ shiftKey: true }), d), true);
  assert.equal(shouldSendOnKey(ev({ metaKey: true }), d), false);
  assert.equal(shouldSendOnKey(ev({ ctrlKey: true }), d), false);
  assert.equal(shouldSendOnKey(ev(), d), false);
  assert.equal(shouldSendOnKey(ev({ shiftKey: true, key: 'a' }), d), false);
  assert.equal(shouldSendOnKey(ev({ shiftKey: true }), { ...d, isTouchDevice: true }), false);
  assert.equal(shouldSendOnKey(ev({ shiftKey: true }), { ...d, composing: true }), false);
  assert.equal(shouldSendOnKey(ev({ shiftKey: true, nativeEvent: { isComposing: true } }), d), false);
  assert.equal(shouldSendOnKey(ev({ shiftKey: true, nativeEvent: { keyCode: 229 } }), d), false);
});

test('humanizeInstructionError maps API errors to message keys and refetch flags', () => {
  const e = (status, code, kind) => humanizeInstructionError({ status, code, kind });
  assert.deepEqual(e(409, 'version_conflict'), { messageKey: 'workChat.errorVersionConflict', refetch: true });
  assert.deepEqual(e(409, 'work_reopen_required'), { messageKey: 'workChat.errorReopenRequired', refetch: true });
  assert.deepEqual(e(409, 'work_cancelled'), { messageKey: 'work.instructionCancelledNote', refetch: true });
  assert.deepEqual(e(409, 'invalid_state_transition'), { messageKey: 'work.instructionNotStartedNote', refetch: true });
  assert.deepEqual(e(409, 'idempotency_conflict'), { messageKey: 'work.instructionError', refetch: true });
  assert.deepEqual(e(400, 'validation_error'), { messageKey: 'workChat.errorValidation', refetch: false });
  assert.deepEqual(e(null, 'x', 'network_error'), { messageKey: 'work.errorNetwork', refetch: false });
  assert.deepEqual(e(500, 'boom'), { messageKey: 'work.instructionError', refetch: false });
  assert.deepEqual(humanizeInstructionError(new Error('x')), { messageKey: 'work.instructionError', refetch: false });
  assert.deepEqual(humanizeInstructionError(null), { messageKey: 'work.instructionError', refetch: false });
});

test('instructionBadge shows a badge per instruction status, outcome and Work state', () => {
  assert.equal(instructionBadge(null, 'running'), null);
  const q = (w) => instructionBadge({ status: 'queued', outcome: null }, w);
  assert.deepEqual(q('running'), { labelKey: 'workChat.badgeQueued', tone: 'queued', noteKey: 'workChat.noteQueuedRunning' });
  assert.equal(q('paused').noteKey, 'workChat.noteQueuedPaused');
  assert.equal(q('judgement_waiting').noteKey, 'workChat.noteQueuedJudgement');
  assert.equal(q('completed').noteKey, null);
  assert.equal(q('cancelled').labelKey, 'workChat.badgeCancelled');
  assert.deepEqual(instructionBadge({ status: 'processing', outcome: null }, 'running'),
    { labelKey: 'workChat.badgeProcessing', tone: 'processing', noteKey: 'workChat.noteProcessing' });
  for (const outcome of ['tasks_changed', 'no_change']) {
    assert.equal(instructionBadge({ status: 'answered', outcome }, 'running').labelKey, 'workChat.badgeAnswered');
  }
  assert.equal(instructionBadge({ status: 'answered', outcome: 'decision_opened' }, 'judgement_waiting').tone, 'decision');
  assert.equal(instructionBadge({ status: 'weird' }, 'running'), null);
});

test('latestInstructionSummary and isConversationPending reflect the latest instruction status', () => {
  const m = (status) => ({ source: 'web', instruction: status ? { status, outcome: null } : null });
  assert.equal(latestInstructionSummary([], 'running'), null);
  assert.equal(latestInstructionSummary(undefined, 'running'), null);
  assert.equal(latestInstructionSummary([{ source: 'manager', instruction: null }], 'running'), null);
  assert.equal(latestInstructionSummary([m('answered'), m('processing'), { source: 'manager', instruction: null }], 'running').tone, 'processing');
  assert.equal(isConversationPending(null), false);
  assert.equal(isConversationPending({ messages: [] }), false);
  assert.equal(isConversationPending({ messages: [m(null), m('answered')] }), false);
  assert.equal(isConversationPending({ messages: [m('answered'), m('queued')] }), true);
  assert.equal(isConversationPending({ messages: [m('processing')] }), true);
});

test('messageRole maps message sources to owner, manager or advisor roles', () => {
  for (const s of ['web', 'slack', 'discord']) assert.equal(messageRole({ source: s }), 'owner');
  assert.equal(messageRole({ source: 'manager' }), 'manager');
  assert.equal(messageRole({ source: 'advisor' }), 'advisor');
});
