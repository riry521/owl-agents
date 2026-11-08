import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join } from 'node:path';
import { mock, test } from 'node:test';
import ts from 'typescript';

import { repoRoot } from '../helpers/paths.mjs';
const advisorViewPath = join(repoRoot, 'apps/web/components/AdvisorView.tsx');

const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const realJsxRuntime = webRequire('react/jsx-runtime');

// The textarea and hint props are captured as the real JSX runtime builds
// the element tree, the same way other web tests capture a mocked
// component's props (see web-work-detail.test.mjs's lastLinkProps).
let capturedTextarea = null;
let capturedHint = null;
let capturedButton = null;
let capturedForm = null;
let capturedAttachButton = null;
let capturedTray = null;
let capturedSave = null;

function wrapJsx(originalJsx) {
  return function patchedJsx(type, props, ...rest) {
    if (type === 'textarea' && props?.className === 'advisor__textarea') capturedTextarea = props;
    if (type === 'form' && props?.className === 'advisor__form') capturedForm = props;
    if (type === 'p' && props?.className === 'advisor__hint') capturedHint = props;
    if (type === 'button' && props?.className === 'advisor__menu-item') capturedSave ??= props;
    if (type === 'button' && props?.className?.startsWith('advisor__send')) capturedButton = props;
    return originalJsx(type, props, ...rest);
  };
}

const patchedJsxRuntime = {
  ...realJsxRuntime,
  jsx: wrapJsx(realJsxRuntime.jsx),
  jsxs: wrapJsx(realJsxRuntime.jsxs),
};

let activeHookHarness = null;
const componentReact = {
  ...React,
  useState: (initialValue) => activeHookHarness.useState(initialValue),
  useRef: (initialValue) => activeHookHarness.useRef(initialValue),
  useEffect: (effect, deps) => activeHookHarness.useEffect(effect, deps),
  useLayoutEffect: (effect, deps) => activeHookHarness.useLayoutEffect(effect, deps),
  useCallback: (fn) => fn,
};

function translateForComponent(key) {
  const overrides = {
    'advisor.hint': 'DESKTOP_HINT',
    'advisor.hintTouch': 'TOUCH_HINT',
  };
  return overrides[key] ?? key;
}

// The composer schedules a resize after a send when the browser lacks field-sizing.
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};

// Spy for use-attachment-draft: every input path must hand the same File[] to add().
const addCalls = [];
const draftSpy = { items: [], notices: [], hint: null, attachmentIds: [], clears: 0 };
const attachmentPure = await import('../../apps/web/lib/attachment-draft.mjs');
const attachmentOverrides = {
  '@/lib/use-attachment-draft': {
    useAttachmentDraft: () => ({ ...draftSpy, add: (files) => addCalls.push(files), remove() {}, retry() {}, dismissNotices() {}, clear: () => { draftSpy.clears += 1; } }),
    useFileDrop: (onFiles, disabled) => ({ dragging: false, dropProps: { onDrop: (files) => { if (!disabled) onFiles(files); } } }),
  },
  '@/lib/attachment-draft.mjs': attachmentPure,
  '@/components/AttachmentTray': {
    AttachButton: (props) => { capturedAttachButton = props; return null; },
    AttachmentTray: (props) => { capturedTray = props; return props.notices.length > 0 ? React.createElement('div', { role: 'alert' }, props.notices.join('|')) : null; },
    DropOverlay: () => null,
  },
  '@/components/MessageAttachments': {
    MessageAttachments: ({ attachments }) => React.createElement('div', { 'data-files': true }, (attachments ?? []).map((a) => `${a.filename}${a.status === 'quarantined' ? '[badge]' : ''}`).join(',')),
  },
};
let advisorMessages = [];
let postMessageArgs = [];
let postMessageCalls = 0;
let sessionData;
const interruptCalls = [];
const callLog = [];
const componentApiClient = {
  getOwnerFileRoots: async () => ({ roots: [] }),
  getActiveConversation: async () => 'conv-1',
  getAdvisorSession: async () => ({ status: 'none', compaction_count: 0, model: null }),
  listMessages: async () => [],
  postMessage: async (...args) => {
    postMessageArgs.push(args);
    postMessageCalls += 1;
    return { message_id: 'm1', advisor_run_id: null };
  },
  ingestConversation: async () => ({ path: 'knowledge/advisor.md' }),
  clearAdvisorConversation: async () => {},
  interruptAdvisorTurn: async (windowKey) => { callLog.push('interrupt'); interruptCalls.push(windowKey); return { interrupted: true, turn_id: 't1' }; },
};
const componentFormat = {
  formatRelative: () => 'just now',
  newUlid: () => 'conv-1',
};
const componentI18n = {
  useLocale: () => ({ t: translateForComponent }),
};

function compileWebComponent(modulePath, overrides = {}) {
  const source = readFileSync(modulePath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const loaded = new Module(modulePath);
  loaded.filename = modulePath;
  loaded.paths = Module._nodeModulePaths(dirname(modulePath));

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'react') return componentReact;
    if (request === 'react/jsx-runtime') return patchedJsxRuntime;
    if (Object.hasOwn(overrides, request)) return overrides[request];
    if (Object.hasOwn(attachmentOverrides, request)) return attachmentOverrides[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, modulePath);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports;
}

const viewOptions = {};
const { replyArrived } = await import('../../apps/web/lib/advisor-awaiting.mjs');
const indicatorModule = await import('../../apps/web/lib/advisor-indicator.mjs');
const { advisorIndicatorLabel, advisorSessionBusy } = indicatorModule;
const advisorViewModule = compileWebComponent(advisorViewPath, {
  '@/lib/api-client': componentApiClient,
  '@/lib/format': componentFormat,
  '@/lib/i18n': componentI18n,
  '@/lib/owner-file-links.mjs': await import('../../apps/web/lib/owner-file-links.mjs'),
  '@/lib/advisor-awaiting.mjs': { replyArrived },
'@/lib/advisor-indicator.mjs': indicatorModule,
  '@/lib/advisor-windows.mjs': await import('../../apps/web/lib/advisor-windows.mjs'),
  '@/lib/advisor-file-delivery.mjs': await import('../../apps/web/lib/advisor-file-delivery.mjs'),
  '@/lib/view-loader': { useView: (key, _fetcher, options) => (viewOptions[key?.split(':')[0]] = options, { data: key?.startsWith('advisor-messages:') ? advisorMessages : key === 'advisor-window:general' ? 'conv-1' : sessionData, error: null, loading: false, refresh: async () => { callLog.push('refresh:' + (key?.split(':')[0])); } }) },
  '@/components/icons': { SendIcon: () => null, StopIcon: () => null, TrashIcon: () => null },
  '@/components/AdvisorChannelPanel': { AdvisorChannelPanel: () => null },
});

// State order must match the useState() calls in render order, top to bottom:
// AdvisorView: visibleCount, sending, sendError, stopping, stopError, clearError, knowledgeSaving,
// knowledgeSaveNotice, knowledgeSaveError, menuOpen, isTouchDevice,
// awaitingReply, channelsOpen; then AdvisorComposer: hasText.
// AdvisorView holds four refs (the last is the save-notice timer); the composer's textarea and composing refs follow.
const COMPOSING_REF = 5;
const VISIBLE_STEP = 30;

function createHookHarness(isTouchDevice, awaitingReply = null, hasText = false) {
  const state = [VISIBLE_STEP, false, null, false, null, null, false, null, null, false, isTouchDevice, awaitingReply, false, true];
  if (hasText) state[14] = true; // composer's hasText
  let hookIndex = 0;
  let refIndex = 0;
  // refs[4] is the composer's textarea; the text is read from it at send time.
  const refs = [];
  refs[4] = { current: { value: 'hello', focus() {} } };
  // setCalls counts every state setter call; changes counts those that would re-render.
  const counts = { setCalls: 0, changes: 0 };
  const effects = [];
  return {
    refs,
    state,
    counts,
    useState(initialValue) {
      const index = hookIndex++;
      if (index >= state.length) state[index] = initialValue;
      return [state[index], (nextValue) => {
        const value = typeof nextValue === 'function' ? nextValue(state[index]) : nextValue;
        counts.setCalls += 1;
        if (!Object.is(value, state[index])) counts.changes += 1;
        state[index] = value;
      }];
    },
    useRef(initialValue) {
      const index = refIndex++;
      if (!(index in refs)) refs[index] = { current: initialValue };
      return refs[index];
    },
    effects,
    useEffect(effect) { effects.push(effect); },
    useLayoutEffect() {},
  };
}

function renderAdvisor(isTouchDevice, awaitingReply = null, hasText = false, { stopping = false, stopError = null, menuOpen = false } = {}) {
  const harness = createHookHarness(isTouchDevice, awaitingReply, hasText);
  harness.state[3] = stopping;
  harness.state[4] = stopError;
  harness.state[9] = menuOpen;
  capturedSave = null;
  capturedTextarea = null;
  capturedButton = null;
  capturedHint = null;
  capturedForm = null;
  capturedAttachButton = null;
  capturedTray = null;
  addCalls.length = 0;
  activeHookHarness = harness;
  let html;
  try {
    html = renderToStaticMarkup(React.createElement(advisorViewModule.AdvisorView));
  } finally {
    activeHookHarness = null;
  }
  return { harness, textarea: capturedTextarea, hint: capturedHint, button: capturedButton, form: capturedForm, save: capturedSave, attachButton: capturedAttachButton, tray: capturedTray, html };
}

function keyEvent({ shiftKey = false, isComposing = false, keyCode = 13 } = {}) {
  let defaultPrevented = false;
  return {
    event: {
      key: 'Enter',
      shiftKey,
      nativeEvent: { isComposing, keyCode },
      preventDefault: () => { defaultPrevented = true; },
    },
    wasPrevented: () => defaultPrevented,
  };
}

test('desktop: plain Enter is a newline, not a send', async () => {
  postMessageCalls = 0;
  const { textarea } = renderAdvisor(false);
  const { event, wasPrevented } = keyEvent({ shiftKey: false });
  textarea.onKeyDown(event);
  await new Promise((r) => setImmediate(r));
  assert.equal(wasPrevented(), false, 'plain Enter should not be intercepted');
  assert.equal(postMessageCalls, 0);
});

test('desktop: Shift+Enter sends', async () => {
  postMessageCalls = 0;
  const { textarea } = renderAdvisor(false);
  const { event, wasPrevented } = keyEvent({ shiftKey: true });
  textarea.onKeyDown(event);
  await new Promise((r) => setImmediate(r));
  assert.equal(wasPrevented(), true, 'Shift+Enter should send instead of inserting a newline');
  assert.equal(postMessageCalls, 1);
});

test('desktop: Shift+Enter is ignored while composing (IME)', async () => {
  const { textarea, harness } = renderAdvisor(false);

  postMessageCalls = 0;
  harness.refs[COMPOSING_REF].current = true; // composingRef
  const composingRef = keyEvent({ shiftKey: true });
  textarea.onKeyDown(composingRef.event);
  await new Promise((r) => setImmediate(r));
  assert.equal(composingRef.wasPrevented(), false, 'composingRef guard should block send');
  assert.equal(postMessageCalls, 0);
  harness.refs[COMPOSING_REF].current = false;

  postMessageCalls = 0;
  const nativeComposing = keyEvent({ shiftKey: true, isComposing: true });
  textarea.onKeyDown(nativeComposing.event);
  await new Promise((r) => setImmediate(r));
  assert.equal(nativeComposing.wasPrevented(), false, 'nativeEvent.isComposing guard should block send');
  assert.equal(postMessageCalls, 0);

  postMessageCalls = 0;
  const imeKeyCode = keyEvent({ shiftKey: true, keyCode: 229 });
  textarea.onKeyDown(imeKeyCode.event);
  await new Promise((r) => setImmediate(r));
  assert.equal(imeKeyCode.wasPrevented(), false, 'keyCode 229 guard should block send');
  assert.equal(postMessageCalls, 0);
});

test('touch devices never send on a key, including Shift+Enter', async () => {
  postMessageCalls = 0;
  const { textarea } = renderAdvisor(true);
  const { event, wasPrevented } = keyEvent({ shiftKey: true });
  textarea.onKeyDown(event);
  await new Promise((r) => setImmediate(r));
  assert.equal(wasPrevented(), false, 'touch devices should only send via the send button');
  assert.equal(postMessageCalls, 0);
});

test('the textarea asks mobile keyboards for a return key, not a send key', () => {
  const { textarea } = renderAdvisor(false);
  assert.equal(textarea.enterKeyHint, 'enter');
});

test('the hint text switches between desktop and touch phrasing', () => {
  const desktop = renderAdvisor(false);
  assert.equal(desktop.hint.children, 'DESKTOP_HINT');

  const touch = renderAdvisor(true);
  assert.equal(touch.hint.children, 'TOUCH_HINT');
});

test('English and Japanese advisor hint strings define the same keys', () => {
  const english = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8'));
  const japanese = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8'));
  assert.equal(typeof english.advisor.hint, 'string');
  assert.equal(typeof english.advisor.hintTouch, 'string');
  assert.equal(typeof japanese.advisor.hint, 'string');
  assert.equal(typeof japanese.advisor.hintTouch, 'string');
  assert.ok(english.advisor.hint.length > 0 && japanese.advisor.hint.length > 0);
  assert.ok(english.advisor.hintTouch.length > 0 && japanese.advisor.hintTouch.length > 0);
});

test('while awaiting a reply the spinner shows and both views poll, even if the session reads idle', () => {
  const idle = { status: 'none', running_turns: 0, queued_turns: 0 };
  renderAdvisor(false);
  assert.equal(viewOptions['advisor-session'].refreshMs(idle), null);
  assert.equal(viewOptions['advisor-messages'].refreshMs, null);

  renderAdvisor(false, { messageId: 'm1' });
  assert.equal(viewOptions['advisor-session'].refreshMs(idle), 1500);
  assert.equal(viewOptions['advisor-messages'].refreshMs, 1500);
});

test('the awaiting state survives idle or stale session reads and ends only when the reply arrives', () => {
  const sent = { id: 'm1', source: 'web' };
  const awaiting = { messageId: 'm1' };
  assert.equal(replyArrived(awaiting, null), false, 'messages not loaded yet');
  assert.equal(replyArrived(awaiting, []), false, 'send not listed yet');
  assert.equal(replyArrived(awaiting, [{ id: 'old', source: 'advisor' }, sent]), false, 'an earlier advisor reply is not the reply');
  assert.equal(replyArrived(awaiting, [sent, { id: 'm2', source: 'web' }]), false, 'session going idle without a reply does not end the wait');
  assert.equal(replyArrived(awaiting, [sent, { id: 'r1', source: 'advisor' }]), true);
  assert.equal(replyArrived(null, [sent]), false);
});

test('rendered: the spinner stays through idle or stale session reads after a send and goes when the reply arrives', async () => {
  // A harness that really runs effects and re-renders on state changes, with controllable view data.
  let session = { status: 'none', running_turns: 0, queued_turns: 0 };
  let messages = [];
  const compiled = compileWebComponent(advisorViewPath, {
    '@/lib/api-client': componentApiClient,
    '@/lib/format': componentFormat,
    '@/lib/i18n': componentI18n,
    '@/lib/owner-file-links.mjs': await import('../../apps/web/lib/owner-file-links.mjs'),
  '@/lib/advisor-awaiting.mjs': { replyArrived },
    '@/lib/advisor-indicator.mjs': indicatorModule,
    '@/lib/advisor-windows.mjs': await import('../../apps/web/lib/advisor-windows.mjs'),
    '@/lib/advisor-file-delivery.mjs': await import('../../apps/web/lib/advisor-file-delivery.mjs'),
    '@/lib/view-loader': { useView: (key) => ({ data: key?.startsWith('advisor-messages:') ? messages : key === 'advisor-window:general' ? 'conv-1' : session, error: null, loading: false, refresh: async () => {} }) },
    '@/components/icons': { SendIcon: () => null, StopIcon: () => null, TrashIcon: () => null },
  '@/components/AdvisorChannelPanel': { AdvisorChannelPanel: () => null },
  });
  const state = [];
  const effects = [];
  const refs = [];
  refs[4] = { current: { value: 'hello', focus() {} } };
  let dirty = false;
  let hookIndex = 0;
  let effectIndex = 0;
  let refIndex = 0;
  const init = [0, false, null, false, null, null, false, null, null, false, false, null, false, true];
  const harness = {
    useState(initialValue) {
      const index = hookIndex++;
      if (!(index in state)) state[index] = index < init.length ? init[index] : initialValue;
      return [state[index], (next) => {
        const value = typeof next === 'function' ? next(state[index]) : next;
        if (!Object.is(value, state[index])) { state[index] = value; dirty = true; }
      }];
    },
    useRef(initialValue) {
      const index = refIndex++;
      if (!(index in refs)) refs[index] = { current: initialValue };
      return refs[index];
    },
    useEffect(effect, deps) {
      const index = effectIndex++;
      const prev = effects[index];
      if (prev && deps && prev.deps && deps.every((d, i) => Object.is(d, prev.deps[i]))) return;
      prev?.cleanup?.();
      effects[index] = { deps, cleanup: undefined, pending: effect };
    },
    useLayoutEffect() {},
  };
  const originalWindow = globalThis.window;
  const originalFrame = [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame];
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
  function render() {
    for (let pass = 0; pass < 20; pass += 1) {
      hookIndex = 0; effectIndex = 0; refIndex = 0; dirty = false;
      capturedTextarea = null;
      activeHookHarness = harness;
      let html;
      try {
        html = renderToStaticMarkup(React.createElement(compiled.AdvisorView));
      } finally {
        activeHookHarness = null;
      }
      for (const slot of effects) {
        if (slot?.pending) {
          const run = slot.pending;
          slot.pending = undefined;
          slot.cleanup = run();
        }
      }
      if (!dirty) return html;
    }
    throw new Error('render did not settle');
  }
  const spinner = (html) => html.includes('turn__typing');
  try {
    assert.equal(spinner(render()), false, 'idle before sending');

    capturedTextarea.onKeyDown(keyEvent({ shiftKey: true }).event);
    await new Promise((r) => setImmediate(r));
    assert.equal(spinner(render()), true, 'spinner after send while the session still reads idle');

    session = { status: 'none', running_turns: 1, queued_turns: 0 };
    assert.equal(spinner(render()), true, 'running');
    session = { status: 'none', running_turns: 0, queued_turns: 0 };
    assert.equal(spinner(render()), true, 'stale idle read does not clear it');

    messages = [{ id: 'm1', source: 'web', created_at: '1' }];
    assert.equal(spinner(render()), true, 'own message listed, no reply yet');

    messages = [...messages, { id: 'r1', source: 'advisor', created_at: '2' }];
    assert.equal(spinner(render()), false, 'reply arrived clears the spinner');
  } finally {
    for (const slot of effects) slot?.cleanup?.();
    globalThis.window = originalWindow;
    [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = originalFrame;
  }
});

function withBrowserGlobals(fieldSizing, run) {
  const saved = [globalThis.CSS, globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame];
  let frames = 0;
  globalThis.CSS = { supports: (q) => fieldSizing && q === 'field-sizing: content' };
  globalThis.requestAnimationFrame = () => { frames += 1; return 1; };
  globalThis.cancelAnimationFrame = () => {};
  try { run(() => frames); } finally { [globalThis.CSS, globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = saved; }
}

test('with field-sizing, typing sets no state and schedules no height measurement', () => {
  withBrowserGlobals(true, (frames) => {
    const { textarea, harness } = renderAdvisor(false, null, true);
    textarea.onChange({ target: { value: 'hello w' } });
    textarea.onChange({ target: { value: 'hello wo' } });
    textarea.onCompositionEnd();
    assert.equal(frames(), 0);
    assert.deepEqual(harness.counts, { setCalls: 0, changes: 0 }, 'no state update, so no re-render, per keystroke');
    assert.equal(textarea.value, undefined, 'textarea is uncontrolled');
    textarea.onChange({ target: { value: '  ' } });
    assert.deepEqual(harness.counts, { setCalls: 1, changes: 1 }, 'state updates only when empty-ness changes');
  });
});

test('without field-sizing, the JS resize is scheduled per change and on composition end', () => {
  withBrowserGlobals(false, (frames) => {
    const { textarea } = renderAdvisor(false);
    textarea.onChange({ target: { value: 'hello w' } });
    assert.equal(frames(), 1);
    textarea.onCompositionEnd();
    assert.equal(frames(), 2);
  });
});

test('without field-sizing, the scheduled resize writes no height while composing', () => {
  withBrowserGlobals(false, () => {
    const { textarea, harness } = renderAdvisor(false);
    const writes = [];
    harness.refs[4].current = { scrollHeight: 80, style: { set height(v) { writes.push(v); } } };
    let frame;
    globalThis.requestAnimationFrame = (fn) => { frame = fn; return 1; };
    harness.refs[5].current = true;
    textarea.onChange({ target: { value: 'x' } });
    frame();
    assert.deepEqual(writes, []);
    harness.refs[5].current = false;
    textarea.onChange({ target: { value: 'xy' } });
    frame();
    assert.deepEqual(writes, ['', '80px']);
  });
});

test('send clears the box before postMessage answers, restores it on failure, and blocks a second send', async () => {
  const original = componentApiClient.postMessage;
  let calls = 0;
  let settle;
  componentApiClient.postMessage = () => { calls += 1; return new Promise((resolve, reject) => { settle = { resolve, reject }; }); };
  try {
    const { textarea, harness } = renderAdvisor(false);
    assert.equal(textarea.disabled, undefined, 'textarea is never disabled');
    const ta = harness.refs[4].current;
    textarea.onKeyDown(keyEvent({ shiftKey: true }).event);
    assert.equal(ta.value, '', 'cleared before the API answers');
    ta.value = 'again';
    textarea.onKeyDown(keyEvent({ shiftKey: true }).event);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1, 'second send is blocked while one is in flight');
    ta.value = '';
    settle.reject(new Error('boom'));
    await new Promise((r) => setImmediate(r));
    assert.equal(ta.value, 'hello', 'failed send restores the draft');

    textarea.onKeyDown(keyEvent({ shiftKey: true }).event);
    ta.value = 'newer';
    settle.reject(new Error('boom'));
    await new Promise((r) => setImmediate(r));
    assert.equal(ta.value, 'newer', 'text typed after the send is not overwritten');
  } finally {
    componentApiClient.postMessage = original;
  }
});

test('the composer shows a stop button only while a turn is running, and it interrupts the window then reloads', async () => {
  sessionData = { status: 'running', running_turns: 0, queued_turns: 1 };
  try {
    const queued = renderAdvisor(false);
    assert.equal(queued.button.type, 'submit', 'queued turns alone keep the send button');

    sessionData = { status: 'running', running_turns: 1, queued_turns: 0 };
    interruptCalls.length = 0;
    callLog.length = 0;
    const running = renderAdvisor(false);
    assert.equal(running.button['aria-label'], 'advisor.stopLabel');
    assert.equal(running.button.type, 'button');
    assert.equal(running.button.disabled, false);
    await running.button.onClick();
    assert.equal(interruptCalls.length, 1);
    assert.equal(interruptCalls[0], 'general', 'the call carries the rendered window key');
    assert.deepEqual(
      [callLog[0], ...callLog.slice(1).sort()],
      ['interrupt', 'refresh:advisor-messages', 'refresh:advisor-session'],
      'session and messages are reloaded after the interrupt',
    );
    assert.deepEqual(running.harness.state.slice(3, 5), [false, null], 'stopping ends without an error');

    sessionData = { status: 'running', running_turns: 0, queued_turns: 0 };
    assert.equal(renderAdvisor(false).button['aria-label'], 'advisor.sendLabel', 'back to send when the turn ends');
  } finally {
    sessionData = undefined;
  }
});

test('while stopping the stop button is disabled and the indicator says so; a failed stop shows the error', async () => {
  sessionData = { status: 'running', running_turns: 1, queued_turns: 0 };
  const original = componentApiClient.interruptAdvisorTurn;
  try {
    const stopping = renderAdvisor(false, null, false, { stopping: true });
    assert.equal(stopping.button.disabled, true);
    assert.ok(stopping.html.includes('advisor.stopping'));

    componentApiClient.interruptAdvisorTurn = async () => { throw new Error('409'); };
    const originalError = console.error;
    console.error = () => {};
    try {
      const running = renderAdvisor(false);
      await running.button.onClick();
      assert.equal(running.harness.state[4], 'advisor.errorStop');
    } finally {
      console.error = originalError;
    }
    assert.ok(renderAdvisor(false, null, false, { stopError: 'advisor.errorStop' }).html.includes('advisor.errorStop'));
  } finally {
    componentApiClient.interruptAdvisorTurn = original;
    sessionData = undefined;
  }
});

test('Shift+Enter while a turn is running still sends and does not stop', async () => {
  sessionData = { status: 'running', running_turns: 1, queued_turns: 0 };
  try {
    postMessageCalls = 0;
    interruptCalls.length = 0;
    const { textarea } = renderAdvisor(false);
    textarea.onKeyDown(keyEvent({ shiftKey: true }).event);
    await new Promise((r) => setImmediate(r));
    assert.equal(postMessageCalls, 1);
    assert.equal(interruptCalls.length, 0);
  } finally {
    sessionData = undefined;
  }
});

// Real ja/en strings with {{name}} filled in; translateForComponent only echoes keys.
function realT(locale) {
  const dict = JSON.parse(readFileSync(join(repoRoot, `apps/web/lib/i18n/${locale}.json`), 'utf8'));
  return (key, params = {}) => key.split('.').reduce((node, part) => node?.[part], dict).replace(/\{\{(\w+)\}\}/g, (_, name) => params[name]);
}
const tJa = realT('ja');
const tEn = realT('en');
const label = (t, session, extra = {}) => advisorIndicatorLabel({ t, session, sending: false, stopping: false, pausedLabel: null, ...extra });
const act = (state, tool_name = null, background_count = 0) => ({ activity: { state, tool_name, background_count } });

test('the indicator names each activity', () => {
  assert.equal(label(tJa, { running_turns: 1, ...act('thinking') }), '考え中…');
  assert.equal(label(tJa, { running_turns: 1, ...act('tool', 'Bash') }), 'Bash を実行中…');
  assert.equal(label(tJa, { running_turns: 1, ...act('subagent') }), 'サブエージェント実行中…');
  assert.equal(label(tJa, { running_turns: 0, ...act(null, null, 2) }), 'バックグラウンドで実行中（2件）');
  assert.equal(label(tEn, { running_turns: 1, ...act('tool', 'Bash') }), 'Running Bash…');
  assert.equal(label(tEn, { running_turns: 1, ...act('subagent') }), 'Subagent running…');
  assert.equal(label(tEn, { running_turns: 0, ...act(null, null, 2) }), 'Running in background (2)');
});

test('the indicator priority', () => {
  const busy = { running_turns: 1, queued_turns: 1 };
  assert.equal(label(tJa, { ...busy, ...act('tool', 'Bash') }, { stopping: true }), '止めています…');
  assert.equal(label(tJa, { ...busy, ...act('tool', 'Bash') }, { pausedLabel: 'P' }), 'Bash を実行中…');
  assert.equal(label(tJa, { ...busy, ...act('subagent') }), 'サブエージェント実行中…');
  assert.equal(label(tJa, { ...busy, ...act('thinking') }, { pausedLabel: 'P' }), '考え中…');
  assert.equal(label(tJa, { running_turns: 0, queued_turns: 1 }, { sending: true, pausedLabel: 'P' }), '考え中…');
  assert.equal(label(tJa, { running_turns: 0, queued_turns: 1 }, { pausedLabel: 'P' }), 'P');
  assert.equal(label(tJa, { running_turns: 0, queued_turns: 1 }), '順番待ち…');
  assert.equal(label(tJa, { running_turns: 0, queued_turns: 0, ...act(null, null, 1) }), 'バックグラウンドで実行中（1件）');
  assert.equal(label(tJa, { running_turns: 0, queued_turns: 0 }), '考え中…');
});

test('background is added to the main label', () => {
  assert.equal(label(tJa, { running_turns: 1, ...act('tool', 'Bash', 2) }), 'Bash を実行中… / バックグラウンドで実行中（2件）');
  assert.equal(label(tJa, { running_turns: 1, ...act('thinking', null, 1) }), '考え中… / バックグラウンドで実行中（1件）');
  assert.equal(label(tJa, { running_turns: 1, ...act(null, null, 1) }, { stopping: true }), '止めています… / バックグラウンドで実行中（1件）');
  assert.equal(label(tJa, { running_turns: 0, ...act(null, null, 2) }), 'バックグラウンドで実行中（2件）');
});

test('without activity the indicator matches the old rule', () => {
  const old = ({ stopping, sending, running_turns, queued_turns, pausedLabel }) => stopping ? 'STOP'
    : sending || running_turns > 0 || queued_turns === 0 ? 'THINK'
    : pausedLabel ?? 'QUEUE';
  const t = (key) => ({ 'advisor.stopping': 'STOP', 'advisor.thinking': 'THINK', 'advisor.waitingInQueue': 'QUEUE' })[key];
  for (const activity of [undefined, null, { state: null, tool_name: null, background_count: 0 }]) {
    for (const stopping of [false, true]) for (const sending of [false, true])
      for (const running_turns of [0, 1]) for (const queued_turns of [0, 2]) for (const pausedLabel of [null, 'PAUSED']) {
        const session = { running_turns, queued_turns, activity };
        assert.equal(advisorIndicatorLabel({ t, session, sending, stopping, pausedLabel }), old({ stopping, sending, running_turns, queued_turns, pausedLabel }));
      }
  }
  assert.equal(advisorIndicatorLabel({ t, session: undefined, sending: false, stopping: false, pausedLabel: null }), 'THINK');
});

test('background keeps the indicator and both polls after the reply', () => {
  try {
    sessionData = { status: 'running', running_turns: 0, queued_turns: 0, activity: { state: null, tool_name: null, background_count: 1 } };
    const shown = renderAdvisor(false);
    assert.ok(shown.html.includes('advisor.activityBackground'));
    assert.equal(viewOptions['advisor-session'].refreshMs(sessionData), 1500);
    assert.equal(viewOptions['advisor-messages'].refreshMs, 1500);

    sessionData = { status: 'running', running_turns: 0, queued_turns: 0, activity: { state: null, tool_name: null, background_count: 0 } };
    const gone = renderAdvisor(false);
    assert.ok(!gone.html.includes('advisor.activityBackground') && !gone.html.includes('advisor.thinking'));
    assert.equal(viewOptions['advisor-session'].refreshMs(sessionData), null);
    assert.equal(viewOptions['advisor-messages'].refreshMs, null);
    assert.equal(advisorSessionBusy(null), false);
  } finally {
    sessionData = undefined;
  }
});

test('a turn Claude starts on its own shows without a stop button', () => {
  try {
    sessionData = { status: 'running', running_turns: 0, queued_turns: 0, activity: { state: 'thinking', tool_name: null, background_count: 0 } };
    const view = renderAdvisor(false);
    assert.ok(view.html.includes('advisor.thinking'));
    assert.equal(view.button['aria-label'], 'advisor.sendLabel');
  } finally {
    sessionData = undefined;
  }
});

function resetDraftSpy(overrides = {}) {
  Object.assign(draftSpy, { items: [], notices: [], hint: null, attachmentIds: [], clears: 0 }, overrides);
  postMessageArgs = [];
  postMessageCalls = 0;
}

test('drop, paste and the clip button reach the same add() with the same files; text paste does not', () => {
  resetDraftSpy();
  const { form, textarea, attachButton } = renderAdvisor(false);
  const files = [new File(['a'], 'a.png', { type: 'image/png' })];
  form.onDrop(files);
  const paste = { clipboardData: { files }, preventDefault() { this.prevented = true; } };
  textarea.onPaste(paste);
  attachButton.onFiles(files);
  assert.equal(addCalls.length, 3);
  for (const call of addCalls) assert.deepEqual(call, files);
  assert.equal(paste.prevented, true);
  const textPaste = { clipboardData: { files: [] }, preventDefault() { this.prevented = true; } };
  textarea.onPaste(textPaste);
  assert.equal(addCalls.length, 3);
  assert.notEqual(textPaste.prevented, true);
});

test('an uploading item disables the send button, shows the hint and blocks Shift+Enter', async () => {
  resetDraftSpy({ items: [{ id: 'u1', status: 'uploading' }], hint: 'attachments.waitUploading' });
  const { button, hint, textarea } = renderAdvisor(false, null, true);
  assert.equal(button.disabled, true);
  assert.equal(hint.children, 'attachments.waitUploading');
  textarea.onKeyDown(keyEvent({ shiftKey: true }).event);
  await new Promise((r) => setImmediate(r));
  assert.equal(postMessageCalls, 0);
});

test('attachment only and body plus attachment each post once with the attachment ids', async () => {
  for (const [text, expectedBody] of [['', ''], ['hello', 'hello']]) {
    resetDraftSpy({ items: [{ id: 'i1', status: 'ready', attachmentId: 'a1' }], attachmentIds: ['a1'] });
    const { button, harness, textarea } = renderAdvisor(false, null, false);
    assert.equal(button.disabled, false, 'an attachment alone enables the send button');
    harness.refs[4].current.value = text;
    textarea.onKeyDown(keyEvent({ shiftKey: true }).event);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(postMessageArgs, [['conv-1', expectedBody, ['a1']]]);
    assert.equal(draftSpy.clears, 1);
  }
});

test('a body-only send passes an empty attachment list', async () => {
  resetDraftSpy();
  const { textarea } = renderAdvisor(false);
  textarea.onKeyDown(keyEvent({ shiftKey: true }).event);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(postMessageArgs, [['conv-1', 'hello', []]]);
});

test('a limit rejection is shown with role="alert"', () => {
  resetDraftSpy({ notices: ['big.mov is 72.4 MB'] });
  assert.match(renderAdvisor(false).html, /role="alert">big\.mov is 72\.4 MB/);
});

test('Turn shows body and file names, a quarantined badge, and no body box when the body is empty', () => {
  resetDraftSpy();
  advisorMessages = [
    { id: 'm1', source: 'web', body: 'see this', created_at: '1', attachments: [{ id: 'f1', filename: 'a.png', status: 'ready' }] },
    { id: 'm2', source: 'web', body: '', created_at: '2', attachments: [{ id: 'f2', filename: 'run.exe', status: 'quarantined' }] },
  ];
  try {
    const { html } = renderAdvisor(false);
    assert.match(html, /see this/);
    assert.match(html, /a\.png/);
    assert.match(html, /run\.exe\[badge\]/);
    assert.equal(html.split('class="turn__body').length - 1, 1, 'only the non-empty body gets a box');
  } finally {
    advisorMessages = [];
  }
});

test('the save-success notice clears after 5s, restarts on a repeat save, is cancelled on unmount, and errors stay', async () => {
  const original = componentApiClient.ingestConversation;
  const savedMessages = advisorMessages;
  advisorMessages = [{ id: 'm1', source: 'web', created_at: '1' }];
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { harness, save } = renderAdvisor(false, null, false, { menuOpen: true });
    const NOTICE = 7;
    await save.onClick();
    assert.match(harness.state[NOTICE], /advisor\.saveSuccess/);
    mock.timers.tick(4000);
    assert.notEqual(harness.state[NOTICE], null, 'still shown before 5s');
    await save.onClick();
    mock.timers.tick(4000);
    assert.notEqual(harness.state[NOTICE], null, 'the first save timer does not clear the second notice');
    mock.timers.tick(1000);
    assert.equal(harness.state[NOTICE], null, 'cleared 5s after the latest save');

    await save.onClick();
    const unmount = harness.effects.filter((e) => String(e).includes('clearTimeout')).map((e) => e())[0];
    unmount();
    const before = harness.counts.setCalls;
    mock.timers.tick(10000);
    assert.equal(harness.counts.setCalls, before, 'no state update after unmount');

    componentApiClient.ingestConversation = async () => { throw new Error('boom'); };
    const failed = renderAdvisor(false, null, false, { menuOpen: true });
    const quiet = console.error;
    console.error = () => {};
    try { await failed.save.onClick(); } finally { console.error = quiet; }
    assert.notEqual(failed.harness.state[8], null);
    mock.timers.tick(60000);
    assert.notEqual(failed.harness.state[8], null, 'the error is not auto-dismissed');
  } finally {
    componentApiClient.ingestConversation = original;
    advisorMessages = savedMessages;
    mock.timers.reset();
  }
});
