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
    '@/components/icons': { SendIcon: () => React.createElement('svg') },
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
  assert.deepEqual(sendCalls, [['w1', 'again', { reopen: true, expectedVersion: 9 }]]);

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
  assert.deepEqual(sendCalls[0], ['w1', 'keep me', { reopen: false, expectedVersion: 7 }]);
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
