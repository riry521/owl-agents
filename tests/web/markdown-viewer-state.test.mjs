import assert from 'node:assert/strict';
import { test } from 'node:test';
import { viewerBackTarget, viewerStateForError } from '../../apps/web/lib/markdown-viewer-state.mjs';

const api = (code, extra = {}) => ({ code, kind: 'server_error', details: {}, ...extra });

test('viewerStateForError maps each error code to its state', () => {
  const cases = [
    ['markdown_not_found', 'not_found'],
    ['markdown_not_integrated', 'not_integrated'],
    ['markdown_too_large', 'too_large'],
    ['markdown_unreadable', 'unreadable'],
    ['knowledge_storage_unavailable', 'storage'],
    ['validation_error', 'invalid_url'],
    ['work_not_found', 'work_not_found'],
  ];
  for (const [code, state] of cases) assert.deepEqual(viewerStateForError(api(code)), { state, reason: null, network: false }, code);
});

test('viewerStateForError picks the denied reason, defaulting to outside', () => {
  const reason = (r) => viewerStateForError(api('markdown_path_denied', { details: { reason: r } }));
  assert.deepEqual(reason('secret'), { state: 'denied', reason: 'secret', network: false });
  assert.equal(reason('not_markdown').reason, 'not_markdown');
  for (const r of ['outside', 'traversal', 'symlink_escape', 'new_reason', undefined]) assert.equal(reason(r).reason, 'outside', String(r));
  assert.equal(viewerStateForError(api('markdown_path_denied')).reason, 'outside');
});

test('viewerStateForError sends unknown failures to load_failed and tells network from server', () => {
  assert.deepEqual(viewerStateForError(api('network_error', { kind: 'network_error' })), { state: 'load_failed', reason: null, network: true });
  assert.deepEqual(viewerStateForError(new Error('timeout')), { state: 'load_failed', reason: null, network: true });
  assert.deepEqual(viewerStateForError(api('unauthorized')), { state: 'load_failed', reason: null, network: false });
  assert.equal(viewerStateForError(api('toString')).state, 'load_failed');
  assert.equal(viewerStateForError(null).state, 'load_failed');
});

test('viewerBackTarget returns Work detail, or the Board without a Work', () => {
  assert.equal(viewerBackTarget('01ABC', 'denied'), '/work?id=01ABC');
  assert.equal(viewerBackTarget('01ABC', 'work_not_found'), '/board');
  assert.equal(viewerBackTarget(null, 'invalid_url'), '/board');
  assert.equal(viewerBackTarget('', 'not_found'), '/board');
});
