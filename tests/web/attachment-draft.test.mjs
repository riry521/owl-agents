import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { repoRoot } from '../helpers/paths.mjs';

const draft = await import(join(repoRoot, 'apps/web/lib/attachment-draft.mjs'));
const ja = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8'));
const t = (key, params = {}) =>
  key.split('.').reduce((node, part) => node[part], ja).replace(/\{(\w+)\}/g, (_, name) => params[name]);

const limits = { max_bytes: 1000, max_files: 2 };
const file = (name, size) => ({ name, size });

test('a file over max_bytes is refused as too_large with the formatted limit in the reason', () => {
  const { accepted, rejected } = draft.checkFiles([file('big.mov', 1001), file('ok.txt', 1000)], limits, 0);
  assert.deepEqual(accepted.map((f) => f.name), ['ok.txt']);
  assert.equal(rejected[0].reason, 'too_large');
  const text = draft.rejectionMessage(rejected[0], limits, t);
  assert.ok(text.includes('big.mov') && text.includes(draft.formatBytes(1000)));
});

test('files beyond max_files are too_many; the ones within the limit are kept', () => {
  const { accepted, rejected } = draft.checkFiles([file('a', 1), file('b', 1), file('c', 1)], limits, 1);
  assert.deepEqual(accepted.map((f) => f.name), ['a']);
  assert.deepEqual(rejected.map((r) => [r.file.name, r.reason]), [['b', 'too_many'], ['c', 'too_many']]);
  assert.ok(draft.rejectionMessage(rejected[0], limits, t).includes('2'));
});

test('canSend allows text only, files only and both, and blocks when both are empty', () => {
  const ready = [{ id: '1', status: 'ready' }];
  assert.equal(draft.canSend({ body: 'hi', items: [], sending: false }), true);
  assert.equal(draft.canSend({ body: '  ', items: ready, sending: false }), true);
  assert.equal(draft.canSend({ body: 'hi', items: ready, sending: false }), true);
  assert.equal(draft.canSend({ body: ' ', items: [], sending: false }), false);
  assert.equal(draft.canSend({ body: 'hi', items: ready, sending: true }), false);
});

test('canSend is false while an item is uploading or failed, true for quarantined only', () => {
  assert.equal(draft.canSend({ body: 'x', items: [{ status: 'uploading' }], sending: false }), false);
  assert.equal(draft.canSend({ body: 'x', items: [{ status: 'failed' }], sending: false }), false);
  assert.equal(draft.canSend({ body: '', items: [{ status: 'quarantined' }], sending: false }), true);
});

test('reducer: add, upload, fail, retry, remove, and a late result for a removed item is ignored', () => {
  const f = file('a.png', 5);
  let s = draft.draftReducer(draft.emptyDraft, { type: 'add', items: [{ id: 'k1', file: f }] });
  assert.equal(s.items[0].status, 'uploading');
  s = draft.draftReducer(s, { type: 'failed', id: 'k1', reason: { key: 'attachments.uploadFailed', params: {} } });
  assert.equal(s.items[0].status, 'failed');
  s = draft.draftReducer(s, { type: 'retry', id: 'k1' });
  assert.equal(s.items[0].status, 'uploading');
  assert.equal(s.items[0].reason, undefined);
  s = draft.draftReducer(s, { type: 'uploaded', id: 'k1', attachment: { attachment_id: 'A1', status: 'stored' } });
  assert.deepEqual([s.items[0].status, s.items[0].attachmentId], ['ready', 'A1']);
  assert.deepEqual(draft.attachmentIdsOf(s.items), ['A1']);
  s = draft.draftReducer(s, { type: 'remove', id: 'k1' });
  assert.equal(s.items.length, 0);
  const after = draft.draftReducer(s, { type: 'uploaded', id: 'k1', attachment: { attachment_id: 'A1', status: 'stored' } });
  assert.equal(after.items.length, 0);
  const quarantined = draft.draftReducer(
    draft.draftReducer(draft.emptyDraft, { type: 'add', items: [{ id: 'q', file: f }] }),
    { type: 'uploaded', id: 'q', attachment: { attachment_id: 'Q', status: 'quarantined' } },
  );
  assert.equal(quarantined.items[0].status, 'quarantined');
});

test('filesFromTransfer takes only File entries and ignores text items', () => {
  const a = file('a.txt', 1);
  const transfer = { items: [{ kind: 'string' }, { kind: 'file', getAsFile: () => a }, { kind: 'file', getAsFile: () => null }] };
  assert.deepEqual(draft.filesFromTransfer(transfer), [a]);
  assert.deepEqual(draft.filesFromTransfer({ files: [a] }), [a]);
  assert.deepEqual(draft.filesFromTransfer({ items: [{ kind: 'string' }] }), []);
  assert.equal(draft.isFileDrag({ types: ['text/plain'] }), false);
  assert.equal(draft.isFileDrag({ types: ['Files'] }), true);
});
