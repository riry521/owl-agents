import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import { repoRoot } from '../helpers/paths.mjs';
const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');

const ja = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8'));
const en = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8'));

// Minimal hook harness: state/refs persist across renders, effects are ignored.
function createHarness() {
  const state = [];
  const refs = [];
  let si = 0;
  let ri = 0;
  const hooks = {
    useState(initial) {
      const i = si++;
      if (i >= state.length) state[i] = typeof initial === 'function' ? initial() : initial;
      return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v; }];
    },
    useRef(initial) {
      const i = ri++;
      if (i >= refs.length) refs[i] = { current: initial };
      return refs[i];
    },
    useEffect() {},
  };
  return { hooks, state, begin() { si = 0; ri = 0; } };
}

const harness = createHarness();
const reactStub = { ...React, ...harness.hooks };
const translations = (dict) => (key, values = {}) => {
  const value = key.split('.').reduce((node, part) => node?.[part], dict);
  if (typeof value !== 'string') return key;
  return value.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name]));
};

const draftPure = await import('../../apps/web/lib/attachment-draft.mjs');
// Spy for use-attachment-draft: the component under test must hand every input path the same add().
const addCalls = [];
const draftSpy = { items: [], notices: [], hint: null, attachmentIds: [], clears: 0 };
const MockAttachButton = (props) => React.createElement('button', { 'data-attach': true, disabled: props.disabled });
const MockTray = (props) => React.createElement('ul', null, props.notices.length > 0 ? React.createElement('li', { role: 'alert' }, props.notices.join('|')) : null);
const MockMessageAttachments = ({ attachments }) => React.createElement('div', { 'data-files': true }, (attachments ?? []).map((a) => `${a.filename}${a.status === 'quarantined' ? '[badge]' : ''}`).join(','));
const sendCalls = [];
let sendImpl = async () => ({});
const pure = {
  instructionBlock: (state) => {
    if (state === 'memo' || state === 'ready') return { blocked: true, reasonKey: 'work.instructionNotStartedNote' };
    if (state === 'cancelled') return { blocked: true, reasonKey: 'work.instructionCancelledNote' };
    if (state === 'completed') return { blocked: false, reopen: true, confirmKey: 'work.instructionReopenConfirm' };
    return { blocked: false, reopen: false };
  },
  shouldSendOnKey: () => false,
  humanizeInstructionError: (err) => (err?.code === 'version_conflict'
    ? { messageKey: 'workChat.errorVersionConflict', refetch: true }
    : { messageKey: 'work.instructionError', refetch: false }),
  instructionBadge: (instruction) => ({
    queued: { tone: 'queued', labelKey: 'workChat.badgeQueued', noteKey: null },
    processing: { tone: 'processing', labelKey: 'workChat.badgeProcessing', noteKey: null },
    answered: { tone: 'answered', labelKey: 'workChat.badgeAnswered', noteKey: null },
  })[instruction.status],
  latestInstructionSummary: () => null,
  messageRole: (m) => (m.source === 'manager' ? 'manager' : m.source === 'advisor' ? 'advisor' : 'owner'),
};

function loadComponent(dict) {
  const modulePath = join(repoRoot, 'apps/web/components/WorkConversation.tsx');
  const { outputText } = ts.transpileModule(readFileSync(modulePath, 'utf8'), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const overrides = {
    react: reactStub,
    'react-markdown': { __esModule: true, default: ({ children }) => React.createElement('div', { 'data-md': true }, children) },
    'remark-gfm': { __esModule: true, default: () => {} },
    '@/lib/api-client': { sendWorkInstruction: (...args) => { sendCalls.push(args); return sendImpl(...args); } },
    '@/lib/format': { formatRelative: () => 'now' },
    '@/lib/i18n': { useLocale: () => ({ locale: 'en', t: translations(dict) }) },
    '@/components/icons': { SendIcon: () => React.createElement('svg'), TrashIcon: () => React.createElement('svg') },
    '@/components/AttachmentTray': { AttachButton: MockAttachButton, AttachmentTray: MockTray, DropOverlay: () => null },
    '@/components/MessageAttachments': { MessageAttachments: MockMessageAttachments },
    '@/lib/use-attachment-draft': {
      useAttachmentDraft: () => ({ ...draftSpy, add: (files) => addCalls.push(files), remove() {}, retry() {}, dismissNotices() {}, clear: () => { draftSpy.clears += 1; } }),
      useFileDrop: (onFiles, disabled) => ({ dragging: false, dropProps: { onDrop: (files) => { if (!disabled) onFiles(files); } } }),
    },
    '@/lib/attachment-draft.mjs': draftPure,
    '../lib/work-conversation.mjs': pure,
  };
  const loaded = new Module(modulePath);
  loaded.filename = modulePath;
  loaded.paths = Module._nodeModulePaths(dirname(modulePath));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(overrides, request)) return overrides[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try { loaded._compile(outputText, modulePath); } finally { Module._load = originalLoad; }
  return loaded.exports.WorkConversation;
}

const WorkConversation = loadComponent(en);

function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  const children = [].concat(node.props?.children ?? []);
  for (const child of children) {
    const hit = find(child, predicate);
    if (hit) return hit;
  }
  return null;
}

function render(props) {
  harness.begin();
  const tree = WorkConversation(props);
  return { tree, html: renderToStaticMarkup(tree) };
}

const conversation = {
  messages: [
    { id: 'm1', source: 'web', body: 'add tests', created_at: '2026-01-01T00:00:00Z', instruction: { status: 'queued', outcome: null, reply_message_id: null }, in_reply_to: [] },
    { id: 'm2', source: 'manager', body: 'done', created_at: '2026-01-01T00:01:00Z', instruction: null, in_reply_to: ['m1'] },
  ],
};

function freshProps(overrides = {}) {
  harness.state.length = 0;
  sendCalls.length = 0;
  addCalls.length = 0;
  Object.assign(draftSpy, { items: [], notices: [], hint: null, attachmentIds: [], clears: 0 });
  return { work: { id: 'w1', state: 'running', state_version: 7 }, conversation, onWorkChanged: () => {}, ...overrides };
}

async function typeAndSubmit(props, text) {
  let { tree } = render(props);
  find(tree, (n) => n.type === 'textarea').props.onChange({ target: { value: text } });
  ({ tree } = render(props));
  find(tree, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  return render(props);
}

test('renders turn classes, badge text and Advisor textarea class', () => {
  const { html } = render(freshProps({ conversation: { messages: [...conversation.messages, { id: 'm3', source: 'web', body: 'x', created_at: '2026-01-01T00:02:00Z', instruction: { status: 'processing', outcome: null, reply_message_id: null } }] } }));
  assert.match(html, /class="turn turn--owner"/);
  assert.match(html, /class="turn turn--manager"/);
  assert.match(html, /turn__body turn__body--plain/);
  assert.match(html, /data-md/);
  assert.match(html, /Sent/);
  assert.match(html, /Manager working/);
  assert.match(html, /class="advisor__textarea work-chat__textarea"/);
  assert.match(html, /The Manager is applying your instruction/);
});

test('blocked Works disable input and show the reason', () => {
  for (const [state, text] of [['memo', 'Start the Work'], ['cancelled', 'cancelled Work cannot']]) {
    const { html } = render(freshProps({ work: { id: 'w1', state, state_version: 1 } }));
    assert.match(html, /<textarea[^>]*disabled/);
    assert.match(html, new RegExp(text));
  }
});

test('completed Work confirms, then sends reopen:true with expectedVersion', async () => {
  const props = freshProps({ work: { id: 'w1', state: 'completed', state_version: 9 } });
  let confirms = 0;
  globalThis.window = { confirm: () => { confirms += 1; return true; } };
  await typeAndSubmit(props, 'again');
  assert.equal(confirms, 1);
  assert.deepEqual(sendCalls, [['w1', 'again', { reopen: true, expectedVersion: 9, attachmentIds: [] }]]);

  sendCalls.length = 0;
  globalThis.window = { confirm: () => false };
  await typeAndSubmit(props, 'again');
  assert.equal(sendCalls.length, 0);
  delete globalThis.window;
});

test('409 version_conflict shows an alert, keeps the draft and calls onWorkChanged', async () => {
  let changed = 0;
  const props = freshProps({ onWorkChanged: () => { changed += 1; } });
  sendImpl = async () => { throw Object.assign(new Error('version_conflict'), { code: 'version_conflict' }); };
  const { html } = await typeAndSubmit(props, 'keep me');
  sendImpl = async () => ({});
  assert.deepEqual(sendCalls[0], ['w1', 'keep me', { reopen: false, expectedVersion: 7, attachmentIds: [] }]);
  assert.equal(changed, 1);
  assert.match(html, /role="alert"/);
  assert.match(html, /The Work changed/);
  assert.match(html, />keep me<\/textarea>/);
});

test('non-409 failures (network, 500) show an alert and call onWorkChanged once', async () => {
  for (const err of [new TypeError('fetch failed'), Object.assign(new Error('boom'), { status: 500 })]) {
    let changed = 0;
    const props = freshProps({ onWorkChanged: () => { changed += 1; } });
    sendImpl = async () => { throw err; };
    const { html } = await typeAndSubmit(props, 'keep me');
    sendImpl = async () => ({});
    assert.equal(changed, 1);
    assert.match(html, /role="alert"/);
  }
});

test('workChat keys match between ja and en', () => {
  assert.ok(ja.workChat && en.workChat);
  assert.deepEqual(Object.keys(ja.workChat).sort(), Object.keys(en.workChat).sort());
});

test('drop, paste and the clip button all reach the same add() with the same files; text paste does not', () => {
  const { tree } = render(freshProps());
  const files = [new File(['a'], 'a.png', { type: 'image/png' })];
  find(tree, (n) => n.type === 'form').props.onDrop(files);
  const pasteEvent = (clipboardFiles) => ({ clipboardData: { files: clipboardFiles }, preventDefault() { this.prevented = true; } });
  const paste = pasteEvent(files);
  find(tree, (n) => n.type === 'textarea').props.onPaste(paste);
  find(tree, (n) => n.type === MockAttachButton).props.onFiles(files);
  assert.equal(addCalls.length, 3);
  for (const call of addCalls) assert.deepEqual(call, files);
  assert.equal(paste.prevented, true);
  const textPaste = pasteEvent([]);
  find(tree, (n) => n.type === 'textarea').props.onPaste(textPaste);
  assert.equal(addCalls.length, 3);
  assert.notEqual(textPaste.prevented, true);
});

test('a Work that cannot take instructions stops the clip button and the drop', () => {
  const { tree } = render(freshProps({ work: { id: 'w1', state: 'cancelled', state_version: 1 } }));
  assert.equal(find(tree, (n) => n.type === MockAttachButton).props.disabled, true);
  find(tree, (n) => n.type === 'form').props.onDrop([new File(['a'], 'a.txt')]);
  assert.equal(addCalls.length, 0);
});

test('body only, attachment only and both send once with attachmentIds', async () => {
  for (const [text, ids, expectedBody] of [['hi', [], 'hi'], ['', ['a1'], ''], ['hi', ['a1', 'a2'], 'hi']]) {
    const props = freshProps();
    draftSpy.items = ids.map((id) => ({ id, status: 'ready', attachmentId: id }));
    draftSpy.attachmentIds = ids;
    await typeAndSubmit(props, text);
    assert.deepEqual(sendCalls, [['w1', expectedBody, { reopen: false, expectedVersion: 7, attachmentIds: ids }]]);
    assert.equal(draftSpy.clears, 1);
  }
});

test('an uploading item disables the send button and sets the hint; submit sends nothing', async () => {
  const props = freshProps();
  draftSpy.items = [{ id: 'u1', status: 'uploading' }];
  draftSpy.hint = 'attachments.waitUploading';
  const { tree, html } = await typeAndSubmit(props, 'hi');
  assert.equal(find(tree, (n) => n.type === 'button' && n.props.type === 'submit').props.disabled, true);
  assert.match(html, /attachments\.waitUploading/);
  assert.equal(sendCalls.length, 0);
});

test('a limit rejection is shown with role="alert"', () => {
  const props = freshProps();
  draftSpy.notices = ['big.mov is 72.4 MB'];
  assert.match(render(props).html, /role="alert"[^>]*>big\.mov is 72\.4 MB/);
});

test('ConversationTurn shows file names with a quarantined badge and omits an empty body box', () => {
  const messages = [{ id: 'm9', source: 'web', body: '', created_at: '2026-01-01T00:00:00Z', attachments: [{ id: 'f1', filename: 'a.png', status: 'ready' }, { id: 'f2', filename: 'run.exe', status: 'quarantined' }] }];
  const { html } = render(freshProps({ conversation: { messages } }));
  assert.match(html, /a\.png,run\.exe\[badge\]/);
  assert.doesNotMatch(html, /turn__body/);
});
