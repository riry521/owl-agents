import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock, test } from 'node:test';

// jsdom is not a repo dependency, so use one that is installed on the machine (JSDOM_PATH overrides); skip if none.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jsdomPath = [process.env.JSDOM_PATH, '/opt/homebrew/lib/node_modules/n8n/node_modules/jsdom'].find((p) => p && existsSync(p));
const opts = { skip: jsdomPath ? false : 'jsdom is not available' };

const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
const SEND_BODIES = [];
let root;
let container;
let act;
let jsdomWindow;
let scrollHeight = 100;

async function mount() {
  const { JSDOM } = createRequire(import.meta.url)(jsdomPath);
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
  jsdomWindow = dom.window;
  Object.assign(globalThis, { window: jsdomWindow, document: jsdomWindow.document, HTMLElement: jsdomWindow.HTMLElement });
  Object.defineProperty(globalThis, 'navigator', { value: jsdomWindow.navigator, configurable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  jsdomWindow.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(jsdomWindow.HTMLTextAreaElement.prototype, 'scrollHeight', { get: () => scrollHeight, configurable: true });

  const React = webRequire('react');
  const { createRoot } = webRequire('react-dom/client');
  ({ act } = React);
  const ts = webRequire('typescript');
  const lib = await import('../apps/web/lib/work-conversation.mjs');
  const stubs = {
    react: React,
    'react-markdown': () => null,
    'remark-gfm': {},
    '@/lib/api-client': { sendWorkInstruction: async (_id, body) => { SEND_BODIES.push(body); } },
    '@/lib/format': { formatRelative: () => '' },
    '@/lib/i18n': { useLocale: () => ({ locale: 'ja', t: (k) => k }) },
    '@/components/icons': { SendIcon: () => null },
    '../lib/work-conversation.mjs': lib,
  };
  const { readFileSync } = await import('node:fs');
  const { outputText } = ts.transpileModule(readFileSync(join(repoRoot, 'apps/web/components/WorkConversation.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  });
  const jsxRuntime = webRequire('react/jsx-runtime');
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', outputText)((id) => (id === 'react/jsx-runtime' ? jsxRuntime : stubs[id]), mod, mod.exports);
  const { WorkConversation } = mod.exports;

  container = jsdomWindow.document.getElementById('app');
  root = createRoot(container);
  const render = (conversation) => act(() => root.render(
    React.createElement(WorkConversation, {
      work: { id: 'w1', state: 'running', state_version: 1 },
      conversation,
      onWorkChanged() {},
    }),
  ));
  await render({ messages: [] });
  return render;
}

const fire = (el, Ctor, type, init = {}) => act(() => { el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init })); });
const typeText = (ta, value) => act(() => {
  Object.getOwnPropertyDescriptor(jsdomWindow.HTMLTextAreaElement.prototype, 'value').set.call(ta, value);
  ta.dispatchEvent(new jsdomWindow.Event('input', { bubbles: true }));
});
const key = (ta, init) => {
  const ev = new jsdomWindow.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', ...init });
  act(() => { ta.dispatchEvent(ev); });
  return ev;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('WorkConversation textarea behaviour with composition events (jsdom)', opts, async (t) => {
  const render = await mount();
  const ta = container.querySelector('textarea');
  const start = () => fire(ta, jsdomWindow.CompositionEvent, 'compositionstart');
  const end = () => fire(ta, jsdomWindow.CompositionEvent, 'compositionend');
  assert.equal(ta.style.height, '100px');

  await t.test('height and value are untouched during composition, including periodic re-renders', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      start();
      for (const text of ['か', 'か゛', 'が']) {
        scrollHeight += 20;
        typeText(ta, text);
        assert.equal(ta.value, text);
        assert.equal(ta.style.height, '100px');
      }
      act(() => { mock.timers.tick(30_000); }); // the 30s "now" refresh re-renders
      await render({ messages: [] });
      assert.equal(ta.value, 'が');
      assert.equal(ta.style.height, '100px');
    } finally {
      mock.timers.reset();
    }
    end();
    await act(() => sleep(80));
    assert.equal(ta.style.height, '160px', 'height is applied after the composition ends');
  });

  await t.test('a stale end-timer does not clear the next composition', async () => {
    end();
    start(); // timer from this end is still pending
    scrollHeight = 300;
    await act(() => sleep(80));
    typeText(ta, 'がぱ');
    assert.equal(ta.style.height, '160px');
    assert.equal(key(ta, { shiftKey: true }).defaultPrevented, false, 'still composing: Shift+Enter does not send');
    end();
    await act(() => sleep(80));
    assert.equal(ta.style.height, '200px');
  });

  await t.test('composition-confirming Enter does not send; Shift+Enter does, with the typed characters', async () => {
    typeText(ta, 'がぱっゃ');
    assert.equal(key(ta, { shiftKey: true, isComposing: true }).defaultPrevented, false);
    assert.equal(key(ta, { shiftKey: true, keyCode: 229 }).defaultPrevented, false);
    assert.deepEqual(SEND_BODIES, []);
    assert.equal(key(ta, { shiftKey: true }).defaultPrevented, true);
    await act(() => sleep(0));
    assert.deepEqual(SEND_BODIES, ['がぱっゃ']);
  });

  act(() => root.unmount());
  jsdomWindow.close();
});
