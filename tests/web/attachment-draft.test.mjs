import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Module } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

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
  assert.equal(draft.canSend({ hasBody: true, items: [], sending: false }), true);
  assert.equal(draft.canSend({ hasBody: false, items: ready, sending: false }), true);
  assert.equal(draft.canSend({ hasBody: true, items: ready, sending: false }), true);
  assert.equal(draft.canSend({ hasBody: false, items: [], sending: false }), false);
  assert.equal(draft.canSend({ hasBody: true, items: ready, sending: true }), false);
});

test('canSend is false while an item is uploading or failed, true for quarantined only', () => {
  assert.equal(draft.canSend({ hasBody: true, items: [{ status: 'uploading' }], sending: false }), false);
  assert.equal(draft.canSend({ hasBody: true, items: [{ status: 'failed' }], sending: false }), false);
  assert.equal(draft.canSend({ hasBody: false, items: [{ status: 'quarantined' }], sending: false }), true);
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

// Runs use-attachment-draft.ts with a minimal hook runtime: state lives in slots and render() re-reads it.
function runDraftHook(apiClient) {
  const source = readFileSync(join(repoRoot, 'apps/web/lib/use-attachment-draft.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
  const slots = [];
  let cursor = 0;
  const slot = (init) => {
    slots[cursor] ??= { value: init() };
    return slots[cursor++];
  };
  const react = {
    useState: (init) => { const s = slot(() => init); return [s.value, (v) => { s.value = typeof v === 'function' ? v(s.value) : v; }]; },
    useReducer: (reducer, init) => { const s = slot(() => init); return [s.value, (a) => { s.value = reducer(s.value, a); }]; },
    useRef: (init) => slot(() => ({ current: init })).value,
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: () => {},
  };
  const loaded = new Module('use-attachment-draft.ts');
  const originalLoad = Module._load;
  Module._load = (request, ...rest) => {
    if (request === 'react') return react;
    if (request === '@/lib/api-client') return apiClient;
    if (request === '@/lib/attachment-draft.mjs') return draft;
    if (request === '@/lib/i18n') return { useLocale: () => ({ t }) };
    return originalLoad(request, ...rest);
  };
  try { loaded._compile(outputText, 'use-attachment-draft.ts'); } finally { Module._load = originalLoad; }
  return { render: () => { cursor = 0; return loaded.exports.useAttachmentDraft({ kind: 'work', id: 'w1' }); } };
}

const neverUploads = () => new Promise(() => {});

test('back-to-back add calls never accept more than max_files in total', async () => {
  const hook = runDraftHook({ ApiRequestError: class extends Error {}, getUploadLimits: async () => limits, uploadAttachment: neverUploads });
  const first = hook.render();
  await Promise.all([first.add([file('a', 1), file('b', 1)]), first.add([file('c', 1), file('d', 1)])]);
  const after = hook.render();
  assert.deepEqual(after.items.map((item) => item.file.name), ['a', 'b']);
});

test('clear(ids) removes only the sent items and also drops stale rejection notices', async () => {
  const hook = runDraftHook({ ApiRequestError: class extends Error {}, getUploadLimits: async () => ({ max_bytes: 1000, max_files: 3 }), uploadAttachment: neverUploads });
  await hook.render().add([file('a', 1), file('big', 5000)]);
  const sentIds = hook.render().items.map((item) => item.id);
  assert.equal(hook.render().notices.length, 1);
  await hook.render().add([file('late', 1)]);
  hook.render().clear(sentIds);
  const after = hook.render();
  assert.deepEqual(after.items.map((item) => item.file.name), ['late']);
  assert.deepEqual(after.notices, []);
});
