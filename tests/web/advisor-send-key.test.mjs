import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
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

function wrapJsx(originalJsx) {
  return function patchedJsx(type, props, ...rest) {
    if (type === 'textarea' && props?.className === 'advisor__textarea') capturedTextarea = props;
    if (type === 'p' && props?.className === 'advisor__hint') capturedHint = props;
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

let postMessageCalls = 0;
const componentApiClient = {
  getActiveConversation: async () => 'conv-1',
  getAdvisorSession: async () => ({ status: 'none', compaction_count: 0, model: null }),
  listMessages: async () => [],
  postMessage: async () => {
    postMessageCalls += 1;
    return { message_id: 'm1', advisor_run_id: null };
  },
  ingestConversation: async () => ({ path: 'knowledge/advisor.md' }),
  clearAdvisorConversation: async () => {},
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
const advisorViewModule = compileWebComponent(advisorViewPath, {
  '@/lib/api-client': componentApiClient,
  '@/lib/format': componentFormat,
  '@/lib/i18n': componentI18n,
  '@/lib/advisor-awaiting.mjs': { replyArrived },
  '@/lib/advisor-windows.mjs': await import('../../apps/web/lib/advisor-windows.mjs'),
  '@/lib/view-loader': { useView: (key, _fetcher, options) => (viewOptions[key?.split(':')[0]] = options, { data: key?.startsWith('advisor-messages:') ? [] : key === 'advisor-window:general' ? 'conv-1' : undefined, error: null, loading: false, refresh: async () => {} }) },
  '@/components/icons': { SendIcon: () => null },
  '@/components/AdvisorChannelPanel': { AdvisorChannelPanel: () => null },
});

// State order must match the useState() calls in render order, top to bottom:
// AdvisorView: visibleCount, sending, sendError, clearError, knowledgeSaving,
// knowledgeSaveNotice, knowledgeSaveError, menuOpen, isTouchDevice,
// awaitingReply, channelsOpen; then AdvisorComposer: hasText.
// AdvisorView holds three refs; the composer's textarea and composing refs follow.
const COMPOSING_REF = 4;
const VISIBLE_STEP = 30;

function createHookHarness(isTouchDevice, awaitingReply = null, hasText = false) {
  const state = [VISIBLE_STEP, false, null, null, false, null, null, false, isTouchDevice, awaitingReply, false, true];
  if (hasText) state[12] = true; // composer's hasText
  let hookIndex = 0;
  let refIndex = 0;
  // refs[3] is the composer's textarea; the text is read from it at send time.
  const refs = [];
  refs[3] = { current: { value: 'hello', focus() {} } };
  // setCalls counts every state setter call; changes counts those that would re-render.
  const counts = { setCalls: 0, changes: 0 };
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
    useEffect() {},
    useLayoutEffect() {},
  };
}

function renderAdvisor(isTouchDevice, awaitingReply = null, hasText = false) {
  const harness = createHookHarness(isTouchDevice, awaitingReply, hasText);
  capturedTextarea = null;
  capturedHint = null;
  activeHookHarness = harness;
  try {
    renderToStaticMarkup(React.createElement(advisorViewModule.AdvisorView));
  } finally {
    activeHookHarness = null;
  }
  return { harness, textarea: capturedTextarea, hint: capturedHint };
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
    '@/lib/advisor-awaiting.mjs': { replyArrived },
    '@/lib/advisor-windows.mjs': await import('../../apps/web/lib/advisor-windows.mjs'),
    '@/lib/view-loader': { useView: (key) => ({ data: key?.startsWith('advisor-messages:') ? messages : key === 'advisor-window:general' ? 'conv-1' : session, error: null, loading: false, refresh: async () => {} }) },
    '@/components/icons': { SendIcon: () => null },
  '@/components/AdvisorChannelPanel': { AdvisorChannelPanel: () => null },
  });
  const state = [];
  const effects = [];
  const refs = [];
  refs[3] = { current: { value: 'hello', focus() {} } };
  let dirty = false;
  let hookIndex = 0;
  let effectIndex = 0;
  let refIndex = 0;
  const init = [0, false, null, null, false, null, null, false, false, null, false, true];
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
    harness.refs[3].current = { scrollHeight: 80, style: { set height(v) { writes.push(v); } } };
    let frame;
    globalThis.requestAnimationFrame = (fn) => { frame = fn; return 1; };
    harness.refs[4].current = true;
    textarea.onChange({ target: { value: 'x' } });
    frame();
    assert.deepEqual(writes, []);
    harness.refs[4].current = false;
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
    const ta = harness.refs[3].current;
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
