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
const en = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8'));
const ja = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8'));

// The composer schedules a resize after a send when the browser lacks field-sizing.
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};

// Hook harness: state persists across renders, effects are ignored.
const state = [];
let si = 0;
const hooks = {
  useState(initial) {
    const i = si++;
    if (i >= state.length) state[i] = typeof initial === 'function' ? initial() : initial;
    return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v; }];
  },
  useRef: (initial) => ({ current: initial }),
  useEffect() {},
  useLayoutEffect() {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};
const reactStub = { ...React, ...hooks };
const translations = (dict) => (key, values = {}) => {
  const value = key.split('.').reduce((node, part) => node?.[part], dict);
  return typeof value === 'string' ? value.replace(/\{\{(\w+)\}\}/g, (_, n) => String(values[n])) : key;
};

const windowsMod = webRequire(join(repoRoot, 'apps/web/lib/advisor-windows.mjs'));
const viewKeys = [];
const postCalls = [];
const routerCalls = [];
const channelCalls = [];
let channelFailure = null;
let searchWindow = null;
let viewData = {};
let windowsError = null;

const baseOverrides = {
  react: reactStub,
  'react-markdown': { __esModule: true, default: ({ children }) => React.createElement('div', null, children) },
  'remark-gfm': { __esModule: true, default: () => {} },
  '@/lib/i18n': { useLocale: () => ({ locale: 'en', t: translations(en) }) },
  '@/lib/advisor-windows.mjs': windowsMod,
  '@/lib/advisor-awaiting.mjs': { replyArrived: () => false },
  '@/lib/format': { formatClock: () => '', formatDateTime: () => '', formatRelative: () => 'now' },
  '@/components/icons': { SendIcon: () => React.createElement('svg') },
  '@/lib/api-client': {
    clearAdvisorConversation: async () => {},
    getAdvisorWindowConversation: async () => 'x',
    getAdvisorSession: async () => ({}),
    ingestConversation: async () => ({}),
    listAdvisorWindows: async () => [],
    listMessages: async () => [],
    getAdvisorWindowChannels: async () => [],
    createAdvisorWindowChannel: async (...args) => { channelCalls.push(['create', ...args]); if (channelFailure) throw channelFailure; },
    bindAdvisorWindowChannel: async (...args) => { channelCalls.push(['bind', ...args]); if (channelFailure) throw channelFailure; },
    renameAdvisorWindowChannel: async (...args) => { channelCalls.push(['rename', ...args]); if (channelFailure) throw channelFailure; },
    postMessage: async (...args) => { postCalls.push(args); return { message_id: 'm' }; },
  },
  '@/lib/view-loader': {
    useView: (key) => {
      viewKeys.push(key);
      return { data: key === null ? undefined : viewData[key], error: key === 'advisor-windows' ? windowsError : null, refresh: async () => {} };
    },
  },
  'next/link': { __esModule: true, default: ({ href, children, ...rest }) => React.createElement('a', { href, 'data-next-link': '', ...rest }, children) },
  'next/navigation': {
    useSearchParams: () => ({ get: (name) => (name === 'window' ? searchWindow : null) }),
    useRouter: () => ({ push: (url) => routerCalls.push(url) }),
  },
};

export function loadTsx(relPath, extra = {}) {
  const modulePath = join(repoRoot, relPath);
  const { outputText } = ts.transpileModule(readFileSync(modulePath, 'utf8'), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const overrides = { ...baseOverrides, ...extra };
  const loaded = new Module(modulePath);
  loaded.filename = modulePath;
  loaded.paths = Module._nodeModulePaths(dirname(modulePath));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(overrides, request)) return overrides[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try { loaded._compile(outputText, modulePath); } finally { Module._load = originalLoad; }
  return loaded.exports;
}

const { AdvisorChannelPanel } = loadTsx('apps/web/components/AdvisorChannelPanel.tsx');
const { AdvisorView } = loadTsx('apps/web/components/AdvisorView.tsx', { '@/components/AdvisorChannelPanel': { AdvisorChannelPanel } });
const { AdvisorWindowPicker } = loadTsx('apps/web/components/AdvisorWindowPicker.tsx');
const { AdvisorWindowSheet } = loadTsx('apps/web/components/AdvisorWindowSheet.tsx', { '@/components/AdvisorWindowPicker': { AdvisorWindowPicker } });
const AdvisorStub = () => null;
const { AdvisorWindowsView } = loadTsx('apps/web/components/AdvisorWindowsView.tsx', {
  '@/components/AdvisorView': { AdvisorView: AdvisorStub },
  '@/components/AdvisorWindowPicker': { AdvisorWindowPicker },
  '@/components/AdvisorWindowSheet': { AdvisorWindowSheet },
});

const windows = [
  { key: 'general', scope: 'general', project_id: null, name: null, window_id: 'w0', conversation_id: 'c0', session_status: 'running', channels: [], last_message_at: null },
  { key: 'P1', scope: 'project', project_id: 'P1', name: 'Alpha', window_id: null, conversation_id: null, session_status: 'none', channels: [{ provider: 'slack', channel_id: 'C1', display_name: 'owl-alpha' }], last_message_at: null },
  { key: 'P2', scope: 'project', project_id: 'P2', name: 'Beta', window_id: 'w2', conversation_id: 'c2', session_status: 'suspended', channels: [], last_message_at: null },
];

function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of [].concat(node.props?.children ?? []).flat(Infinity)) {
    const hit = find(child, predicate);
    if (hit) return hit;
  }
  return null;
}

function renderWindows(param) {
  searchWindow = param;
  viewData = { 'advisor-windows': windows };
  const tree = AdvisorWindowsView();
  return { tree, html: renderToStaticMarkup(tree), advisor: find(tree, (n) => n.type === AdvisorStub), picker: find(tree, (n) => n.type === AdvisorWindowPicker) };
}

test('lists the generalist and every project window', () => {
  const { html } = renderWindows(null);
  assert.match(html, /Owl/);
  assert.match(html, /Alpha/);
  assert.match(html, /Beta/);
  assert.match(html, /#owl-alpha/);
});

test('?window=P selects P and passes it to AdvisorView', () => {
  const { html, advisor } = renderWindows('P2');
  assert.equal(advisor.props.windowKey, 'P2');
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(html, /aria-current="page"[^>]*><span[^>]*>Beta/);
});

test('a key missing from the list falls back to the generalist with a notice', () => {
  const { html, advisor } = renderWindows('gone');
  assert.equal(advisor.props.windowKey, 'general');
  assert.match(html, /aria-current="page"[^>]*><span[^>]*>Owl/);
  assert.match(html, /not found/);
});

test('choosing a window pushes its URL so Back returns to the previous window', () => {
  routerCalls.length = 0;
  const { picker } = renderWindows(null);
  picker.props.onSelect('P1');
  picker.props.onSelect('general');
  assert.deepEqual(routerCalls, ['/advisor?window=P1']);
});

test('AdvisorView for P reads advisor-window:P and posts to the conversation of P', async () => {
  viewKeys.length = 0;
  postCalls.length = 0;
  state.length = 0;
  viewData = { 'advisor-window:P': 'conv-P', 'advisor-messages:conv-P': [], 'advisor-session:conv-P': { status: 'none' } };
  // The input lives in AdvisorComposer, a child component: render it right after AdvisorView so its hooks follow the parent's.
  const render = () => {
    si = 0;
    const view = AdvisorView({ windowKey: 'P' });
    const composer = find(view, (n) => n.type?.name === 'AdvisorComposer');
    return composer.type(composer.props);
  };
  render();
  assert.ok(viewKeys.includes('advisor-window:P'));
  // The textarea is uncontrolled: the text is read from its ref at submit time.
  const composerView = render();
  find(composerView, (n) => n.type === 'textarea').props.ref.current = { value: 'hello', focus() {} };
  find(composerView, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(postCalls, [['conv-P', 'hello']]);
});

test('owner messages from Slack and Discord carry the channel in the sender name', () => {
  state.length = 0;
  const message = (source, id) => ({ id, conversation_id: 'conv-P', source, body: 'hi', attachment_ids: [], created_at: `2026-01-01T00:00:0${id}Z` });
  viewData = {
    'advisor-window:P': 'conv-P',
    'advisor-messages:conv-P': [message('slack', 1), message('discord', 2), message('web', 3)],
    'advisor-session:conv-P': { status: 'none' },
  };
  si = 0;
  const html = renderToStaticMarkup(AdvisorView({ windowKey: 'P' }));
  assert.match(html, /You \(Slack\)/);
  assert.match(html, /You \(Discord\)/);
  assert.equal((html.match(/turn__name">You</g) ?? []).length, 1);
  assert.equal(ja.advisorWindows.via.slack, '（Slack）');
  assert.equal(ja.advisorWindows.via.discord, '（Discord）');
});

// ---- channel panel ----------------------------------------------------------

const channelItems = [
  { provider: 'slack', configured: true, running: true, binding: null, default_name: 'owl-alpha' },
  { provider: 'discord', configured: true, running: true, binding: { channel_id: '123', display_name: 'owl-beta' }, default_name: 'owl-alpha' },
];
let refreshed = 0;

// A provider section is a component of its own: find it in the panel tree and call it directly.
function sectionOf(provider) {
  viewData = { 'advisor-window-channels:P1': channelItems };
  const tree = AdvisorChannelPanel({ windowKey: 'P1', onClose() {} });
  const element = find(tree, (n) => typeof n.type === 'function' && n.props.item?.provider === provider);
  state.length = 0;
  return () => { si = 0; return element.type({ ...element.props, onChanged: () => { refreshed += 1; } }); };
}
const press = (tree, label) => find(tree, (n) => n.type === 'button' && [].concat(n.props.children).includes(label));
const typeInto = (tree, label, value) => find(tree, (n) => n.type === 'input' && n.props['aria-label'].endsWith(label)).props.onChange({ target: { value } });

test('panel: a section per provider, with the default name prefilled', () => {
  viewData = { 'advisor-window-channels:P1': channelItems };
  state.length = 0; si = 0;
  const html = renderToStaticMarkup(AdvisorChannelPanel({ windowKey: 'P1', onClose() {} }));
  assert.match(html, /value="owl-alpha"/);
  assert.match(html, /#owl-beta <code>123<\/code>/);
  assert.match(html, /Slack/);
  assert.match(html, /Discord/);
});

test('panel: create, bind and rename call the API with the typed values', async () => {
  channelFailure = null;
  channelCalls.length = 0;
  refreshed = 0;
  const unbound = sectionOf('slack');
  typeInto(unbound(), 'new channel', 'my-name');
  await press(unbound(), en.advisorWindows.channels.createButton).props.onClick();
  typeInto(unbound(), 'Channel ID', ' C99 ');
  await press(unbound(), en.advisorWindows.channels.bindButton).props.onClick();
  const bound = sectionOf('discord');
  typeInto(bound(), 'New channel name', 'renamed');
  await press(bound(), en.advisorWindows.channels.renameButton).props.onClick();
  assert.deepEqual(channelCalls, [['create', 'P1', 'slack', 'my-name'], ['bind', 'P1', 'slack', 'C99'], ['rename', 'P1', 'discord', 'renamed']]);
  assert.equal(refreshed, 3);
});

test('panel: a dialog, with ChannelSection keyed by provider and window', () => {
  viewData = { 'advisor-window-channels:P1': channelItems };
  state.length = 0; si = 0;
  const tree = AdvisorChannelPanel({ windowKey: 'P1', onClose() {} });
  const html = renderToStaticMarkup(tree);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="advisor-channel-panel-title"/);
  assert.doesNotMatch(html, /windowKey=/);
  const keys = [];
  find(tree, (n) => { if (typeof n.type === 'function' && n.props.item) keys.push(n.key); return false; });
  assert.deepEqual(keys, ['slack-P1', 'discord-P1']);
});

test('panel: the generalist sees only the note and a Link to /settings', () => {
  viewData = {};
  state.length = 0; si = 0;
  const html = renderToStaticMarkup(AdvisorChannelPanel({ windowKey: 'general', generalist: true, onClose() {} }));
  assert.match(html, /advisor-channel-panel__text">The Owl/);
  assert.match(html, /<a href="\/settings" data-next-link="" class="btn">/);
  assert.doesNotMatch(html, /Slack|class="note"/);
});

test('AdvisorView shows the channel button only with channelControls', () => {
  viewData = { 'advisor-window:P1': 'c', 'advisor-messages:c': [], 'advisor-session:c': { status: 'none' } };
  state.length = 0; si = 0;
  assert.match(renderToStaticMarkup(AdvisorView({ windowKey: 'P1', channelControls: true })), />Channels</);
  state.length = 0; si = 0;
  assert.doesNotMatch(renderToStaticMarkup(AdvisorView({ windowKey: 'P1' })), />Channels</);
});

// ---- error guidance ---------------------------------------------------------

const resolves = (dict, key) => typeof key.split('.').reduce((node, part) => node?.[part], dict) === 'string';

test('channelErrorMessage: missing permission shows what is needed and how to set it up', () => {
  const slack = windowsMod.channelErrorMessage('integration_permission_missing', { needed: ['channels:manage'] }, 'slack');
  assert.equal(slack.values.needed, 'channels:manage');
  assert.equal(slack.steps.length, 5);
  assert.match(translations(en)(slack.steps[1], slack.values), /channels:manage/);
  assert.match(translations(ja)(slack.steps[1], slack.values), /channels:manage/);
  const discord = windowsMod.channelErrorMessage('integration_permission_missing', { needed: ['manage_channels'] }, 'discord');
  assert.match(translations(ja)(discord.key, discord.values), /チャンネルの管理/);
  assert.match(translations(en)(discord.key, discord.values), /Manage Channels/);
});

test('channelErrorMessage: every message and step resolves in ja and en', () => {
  const codes = ['integration_permission_missing', 'channel_bot_not_member', 'integration_not_running', 'integration_rate_limited', 'window_channel_exists',
    'channel_in_use', 'channel_already_bound', 'channel_binding_not_found', 'validation_error', 'channel_name_taken', 'channel_not_found',
    'integration_not_authorized', 'integration_provider_error', 'toString', 'unexpected'];
  for (const provider of ['slack', 'discord']) {
    for (const code of codes) {
      const { key, steps } = windowsMod.channelErrorMessage(code, { retry_after_seconds: 7 }, provider);
      for (const k of [key, ...steps]) assert.ok(resolves(en, k) && resolves(ja, k), `${provider} ${code} ${k}`);
    }
  }
  assert.match(translations(en)(windowsMod.channelErrorMessage('integration_not_running', {}, 'slack').key), /not running/);
  assert.match(translations(en)('advisorWindows.channelError.rateLimited', { seconds: '7' }), /7 seconds/);
});

test('a failed call shows the guidance in the section', async () => {
  channelFailure = { code: 'integration_permission_missing', details: { needed: ['channels:manage'] } };
  const unbound = sectionOf('slack');
  await press(unbound(), en.advisorWindows.channels.createButton).props.onClick();
  const html = renderToStaticMarkup(unbound());
  channelFailure = null;
  assert.match(html, /Slack app lacks the channels:manage permission/);
  assert.match(html, /Reinstall to Workspace/);
});

test('Advisor Turn is memoized so typing in the draft does not re-parse every message', () => {
  const src = readFileSync(join(repoRoot, 'apps/web/components/AdvisorView.tsx'), 'utf8');
  assert.match(src, /const Turn = memo\(function Turn\(/);
});

// ---- heading and window picker ---------------------------------------------

// What <AdvisorView /> rendered for Home and Board before the window props existed.
const OMITTED_PROPS_MARKUP = '<link rel="preload" as="image" href="/owl/icon.png"/><div class="advisor"><div class="advisor__header"><div class="advisor__header-left"><img src="/owl/icon.png" alt="Owl" class="advisor__header-icon" width="24" height="24"/><span class="advisor__header-title">Owl Advisor</span><div class="advisor__session-badges" aria-label="Advisor session status"><span class="advisor__session-badge advisor__session-badge--model">m1</span><span class="advisor__session-badge advisor__session-badge--none">No session</span><span class="advisor__session-badge">Compactions: 2</span></div></div><div class="advisor__kebab-wrap"><button class="advisor__kebab" aria-label="Menu">⋮</button></div></div><div class="advisor__messages"><div class="advisor__empty"><div class="advisor__empty-icon"><img src="/owl/icon.png" alt="Owl" width="48" height="48" style="border-radius:10px"/></div><h2>Owl Advisor</h2><p>Get advice on strategy and direction.<br/>Type a message below to start.</p></div></div><div class="advisor__input-area"><form class="advisor__form"><div class="advisor__input-wrap"><textarea class="advisor__textarea" placeholder="Ask the Advisor a question" maxLength="100000" rows="2" enterKeyHint="enter"></textarea><button type="submit" class="advisor__send" disabled="" aria-label="Send"><svg></svg></button></div><p class="advisor__hint">Shift+Enter to send / Enter for new line</p></form></div></div>';

function renderAdvisor(props, session = { status: 'none' }) {
  viewData = { 'advisor-window:general': 'c', 'advisor-messages:c': [], 'advisor-session:c': session };
  state.length = 0; si = 0;
  return renderToStaticMarkup(AdvisorView(props));
}

test('AdvisorView with the window props omitted renders the Home/Board markup as before', () => {
  const html = renderAdvisor(undefined, { status: 'none', model: 'm1', compaction_count: 2 });
  assert.equal(html, OMITTED_PROPS_MARKUP);
  assert.doesNotMatch(html, /advisor__window-trigger|advisor__actions/);
});

test('AdvisorView heading shows the window name and the scope badge first', () => {
  const project = renderAdvisor({ windowName: 'owl-agents', windowScope: 'project' }, { status: 'none', model: 'm1' });
  assert.match(project, /<span class="advisor__header-title" title="owl-agents">owl-agents<\/span>/);
  assert.match(project, /<div class="advisor__session-badges"[^>]*><span class="badge badge--accent">Project<\/span><span class="advisor__session-badge advisor__session-badge--model">/);
  assert.match(project, /<h2>owl-agents<\/h2>/);
  const general = renderAdvisor({ windowName: 'Owl', windowScope: 'general' });
  assert.match(general, /<div class="advisor__session-badges"[^>]*><span class="badge">General<\/span>/);
  assert.equal(ja.advisorWindows.scopeGeneral, '全体の窓');
  assert.equal(ja.advisorWindows.scopeProject, 'プロジェクト窓');
});

test('the window-name button appears only with onOpenWindowPicker and names the window', () => {
  assert.doesNotMatch(renderAdvisor({ windowName: 'Alpha' }), /advisor__window-trigger/);
  const html = renderAdvisor({ windowName: 'Alpha', onOpenWindowPicker() {}, windowPickerOpen: true });
  assert.match(html, /<button type="button" class="advisor__window-trigger" aria-haspopup="dialog" aria-expanded="true" aria-label="Switch window: Alpha"/);
});

test('the window picker has no select and marks only the current row', () => {
  for (const variant of ['sidebar', 'sheet']) {
    const html = renderToStaticMarkup(AdvisorWindowPicker({ windows, currentKey: 'P1', onSelect() {}, variant }));
    assert.doesNotMatch(html, /<select/);
    assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
    assert.match(html, /aria-current="page" title="Alpha"/);
    assert.equal(html.includes('<nav'), variant === 'sidebar');
  }
  assert.equal(en.advisorWindows.statusNone, 'No session');
  assert.equal(ja.advisorWindows.statusNone, 'セッションなし');
});

test('the window picker moves focus with arrows, Home and End and stops at the ends', () => {
  const tree = AdvisorWindowPicker({ windows, currentKey: 'general', onSelect() {}, variant: 'sheet' });
  let focused = null;
  const rows = windows.map(() => ({ focus() { focused = this; } }));
  const savedDocument = globalThis.document;
  globalThis.document = { activeElement: rows[0] };
  const press = (key) => {
    let prevented = false;
    tree.props.onKeyDown({ key, currentTarget: { querySelectorAll: () => rows }, preventDefault() { prevented = true; } });
    return prevented;
  };
  try {
    assert.ok(press('ArrowDown'));
    assert.equal(focused, rows[1]);
    globalThis.document.activeElement = rows[2];
    press('ArrowDown');
    assert.equal(focused, rows[2]);
    press('Home');
    assert.equal(focused, rows[0]);
    press('End');
    assert.equal(focused, rows[2]);
    globalThis.document.activeElement = rows[0];
    press('ArrowUp');
    assert.equal(focused, rows[0]);
    assert.equal(press('a'), false);
  } finally { globalThis.document = savedDocument; }
});

test('the window sheet renders only when open; the backdrop closes it and picking a row selects it and closes', () => {
  const closed = [];
  const selected = [];
  const props = { windows, currentKey: 'general', onClose: () => closed.push(1), onSelect: (k) => selected.push(k), returnFocusTo: { current: null } };
  state.length = 0; si = 0;
  assert.equal(renderToStaticMarkup(AdvisorWindowSheet({ ...props, open: false })), '');
  state.length = 0; si = 0;
  const tree = AdvisorWindowSheet({ ...props, open: true });
  assert.match(renderToStaticMarkup(tree), /role="dialog" aria-modal="true"/);
  find(tree, (n) => n.props?.className === 'advisor-window-sheet__overlay').props.onMouseDown();
  assert.equal(closed.length, 1);
  find(tree, (n) => n.type === AdvisorWindowPicker).props.onSelect('P2');
  assert.deepEqual(selected, ['P2']);
  assert.equal(closed.length, 2);
});

test('AdvisorWindowsView renders the notices row only for an unknown window or a list error', () => {
  const known = renderWindows('P1');
  assert.doesNotMatch(known.html, /advisor-windows-layout__notices/);
  assert.equal(known.advisor.props.windowName, 'Alpha');
  assert.equal(known.advisor.props.windowScope, 'project');
  assert.equal(typeof known.advisor.props.onOpenWindowPicker, 'function');
  const unknown = renderWindows('gone');
  assert.match(unknown.html, /<div class="advisor-windows-layout__notices">.*not found/);
  assert.equal(unknown.advisor.props.windowName, 'Owl');
  assert.equal(unknown.advisor.props.windowScope, 'general');
  searchWindow = null;
  viewData = {};
  windowsError = new Error('x');
  state.length = 0; si = 0;
  let failed;
  try { failed = renderToStaticMarkup(AdvisorWindowsView()); } finally { windowsError = null; }
  assert.match(failed, /advisor-windows-layout__notices.*Could not load the window list/);
  assert.match(failed, /aria-current="page" title="Owl"/);
});

// ---- render cost ------------------------------------------------------------

const { act } = React;
const { createRoot } = webRequire('react-dom/client');

// react-dom/client needs a DOM; this stub is just enough for React to mount and update, and is removed afterwards.
async function withStubDom(run) {
  const doc = { nodeType: 9, activeElement: null, addEventListener() {}, removeEventListener() {}, defaultView: null };
  const makeNode = (tag) => {
    const n = {
      nodeType: 1, nodeName: tag.toUpperCase(), tagName: tag.toUpperCase(), childNodes: [], style: {}, ownerDocument: doc, parentNode: null,
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      appendChild(c) { c.parentNode = n; n.childNodes.push(c); return c; },
      insertBefore(c) { c.parentNode = n; n.childNodes.push(c); return c; },
      removeChild(c) { n.childNodes = n.childNodes.filter((x) => x !== c); return c; },
      setAttribute() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {},
      get firstChild() { return n.childNodes[0] ?? null; },
    };
    return n;
  };
  doc.createElement = makeNode;
  doc.createElementNS = (_ns, tag) => makeNode(tag);
  doc.createTextNode = (text) => ({ nodeType: 3, nodeValue: text, textContent: text, parentNode: null, ownerDocument: doc });
  doc.documentElement = makeNode('html');
  doc.body = makeNode('body');
  const keys = ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT'];
  const saved = Object.fromEntries(keys.map((k) => [k, globalThis[k]]));
  keys.push('matchMedia');
  saved.matchMedia = globalThis.matchMedia;
  const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Object.assign(globalThis, { window: globalThis, document: doc, HTMLIFrameElement: class {}, IS_REACT_ACT_ENVIRONMENT: true, matchMedia });
  try { await run(createRoot(makeNode('div'))); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k]; }
  }
}

test('a refetch with equal content and a clock tick do not re-render the Markdown of existing Turns', async (t) => {
  let markdownRenders = 0;
  const messagesFor = () => [1, 2].map((id) => ({ id, conversation_id: 'conv-P', source: 'advisor', body: 'reply ' + id, attachment_ids: [], created_at: '2026-01-01T00:00:0' + id + 'Z' }));
  const { AdvisorView: View } = loadTsx('apps/web/components/AdvisorView.tsx', {
    react: React,
    '@/components/AdvisorChannelPanel': { AdvisorChannelPanel },
    'react-markdown': { __esModule: true, default: ({ children }) => { markdownRenders += 1; return React.createElement('p', null, children); } },
    '@/lib/view-loader': { useView: (key) => ({ data: key === null ? undefined : viewData[key], error: null, refresh: async () => {} }) },
  });
  const setData = () => { viewData = { 'advisor-messages:conv-P': messagesFor(), 'advisor-session:conv-P': { status: 'none' } }; };
  const view = () => React.createElement(View, { windowKey: 'P', knownConversationId: 'conv-P' });
  t.mock.timers.enable({ apis: ['setInterval'] });
  await withStubDom(async (root) => {
    setData();
    await act(async () => root.render(view()));
    assert.equal(markdownRenders, 2);
    // A refetch: equal content in new arrays and objects.
    setData();
    await act(async () => root.render(view()));
    // The relative-time labels tick.
    await act(async () => t.mock.timers.tick(10 * 60_000));
    assert.equal(markdownRenders, 2);
    // Control: a changed body does re-render that Markdown.
    const list = viewData['advisor-messages:conv-P'];
    viewData['advisor-messages:conv-P'] = [list[0], { ...list[1], body: 'edited' }];
    await act(async () => root.render(view()));
    assert.equal(markdownRenders, 3);
    await act(async () => root.unmount());
  });
});

test('only the latest 30 messages render first and the show-earlier button reveals older ones', () => {
  const messages = Array.from({ length: 45 }, (_, i) => ({ id: 'm' + String(i).padStart(2, '0'), conversation_id: 'conv-P', source: 'web', body: 'body ' + i, attachment_ids: [], created_at: '2026-01-01T00:00:' + String(i).padStart(2, '0') + 'Z' }));
  viewData = { 'advisor-window:P': 'conv-P', 'advisor-messages:conv-P': messages, 'advisor-session:conv-P': { status: 'none' } };
  state.length = 0; si = 0;
  const html = () => { si = 0; return renderToStaticMarkup(AdvisorView({ windowKey: 'P' })); };
  let out = html();
  assert.equal((out.match(/class="turn turn--owner"/g) ?? []).length, 30);
  assert.doesNotMatch(out, />body 14</);
  assert.match(out, />body 15</);
  assert.match(out, />body 44</);
  si = 0;
  const button = find(AdvisorView({ windowKey: 'P' }), (n) => n.props?.className === 'advisor__show-earlier');
  assert.equal(button.props.children, en.advisor.showEarlier);
  assert.ok(ja.advisor.showEarlier);
  button.props.onClick();
  out = html();
  assert.equal((out.match(/class="turn turn--owner"/g) ?? []).length, 45);
  assert.doesNotMatch(out, /advisor__show-earlier/);
});

test('only the selected window loads its conversation, and a listed conversation_id skips the lookup request', async () => {
  const calls = [];
  const mod = loadTsx('apps/web/components/AdvisorView.tsx', {
    react: React,
    '@/components/AdvisorChannelPanel': { AdvisorChannelPanel },
    '@/lib/api-client': {
      ...baseOverrides['@/lib/api-client'],
      getAdvisorWindowConversation: async (key) => { calls.push(['conversation', key]); return 'conv-' + key; },
      listMessages: async (id) => { calls.push(['messages', id]); return []; },
      getAdvisorSession: async (id) => { calls.push(['session', id]); return { status: 'none' }; },
    },
    '@/lib/view-loader': {
      useView: (key, fetcher) => {
        if (key !== null) fetcher();
        return { data: undefined, error: null, refresh: async () => {} };
      },
    },
  });
  const mount = (props) => withStubDom(async (root) => {
    calls.length = 0;
    await act(async () => root.render(React.createElement(mod.AdvisorView, props)));
    await act(async () => root.unmount());
  });
  await mount({ windowKey: 'P1' });
  assert.deepEqual(calls.filter((c) => c[0] === 'conversation'), [['conversation', 'P1']]);
  assert.ok(calls.every((c) => !String(c[1]).includes('P2')));
  await mount({ windowKey: 'P2', knownConversationId: 'c2' });
  assert.equal(calls.some((c) => c[0] === 'conversation'), false);
  assert.deepEqual(calls.filter((c) => c[0] === 'messages' || c[0] === 'session').map((c) => c.join(':')).sort(), ['messages:c2', 'session:c2']);
  // AdvisorWindowsView hands over the listed id of the selected window only.
  assert.equal(renderWindows('P2').advisor.props.knownConversationId, 'c2');
  assert.equal(renderWindows('P1').advisor.props.knownConversationId, null);
});
