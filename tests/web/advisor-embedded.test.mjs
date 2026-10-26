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
const windowsMod = webRequire(join(repoRoot, 'apps/web/lib/advisor-windows.mjs'));

const viewKeys = [];
const state = [];
let si = 0;
const reactStub = {
  ...React,
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
const t = (key) => key.split('.').reduce((node, part) => node?.[part], en) ?? key;
const viewData = { 'advisor-window:general': 'conv-g', 'advisor-messages:conv-g': [], 'advisor-session:conv-g': { status: 'none' } };

const overrides = {
  react: reactStub,
  'react-markdown': { __esModule: true, default: () => null },
  'remark-gfm': { __esModule: true, default: () => {} },
  '@/lib/i18n': { useLocale: () => ({ locale: 'en', t }) },
  '@/lib/advisor-windows.mjs': windowsMod,
  '@/lib/advisor-awaiting.mjs': { replyArrived: () => false },
  '@/lib/format': { formatClock: () => '', formatDateTime: () => '', formatRelative: () => '' },
  '@/components/icons': { SendIcon: () => React.createElement('svg') },
  '@/components/AdvisorChannelPanel': { AdvisorChannelPanel: () => null },
  '@/lib/api-client': {},
  '@/lib/view-loader': {
    useView: (key) => { viewKeys.push(key); return { data: key === null ? undefined : viewData[key], error: null, refresh: async () => {} }; },
  },
  // A URL naming another window must not leak into the embedded view.
  'next/navigation': { useSearchParams: () => ({ get: () => 'P1' }), useRouter: () => ({ replace() {} }) },
};

function loadAdvisorView() {
  const modulePath = join(repoRoot, 'apps/web/components/AdvisorView.tsx');
  const { outputText } = ts.transpileModule(readFileSync(modulePath, 'utf8'), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(modulePath);
  loaded.filename = modulePath;
  loaded.paths = Module._nodeModulePaths(dirname(modulePath));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(overrides, request)) return overrides[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try { loaded._compile(outputText, modulePath); } finally { Module._load = originalLoad; }
  return loaded.exports.AdvisorView;
}

test('AdvisorView without props stays on the generalist window', () => {
  const AdvisorView = loadAdvisorView();
  si = 0;
  const html = renderToStaticMarkup(AdvisorView());
  assert.ok(viewKeys.includes('advisor-window:general'));
  assert.ok(!viewKeys.some((key) => key?.startsWith('advisor-window:') && key !== 'advisor-window:general'));
  assert.doesNotMatch(html, /advisor-window-picker/);
  assert.doesNotMatch(html, new RegExp(en.advisorWindows.channelsButton));
});

test('the default window key equals the shared general window key', () => {
  const shared = readFileSync(join(repoRoot, 'packages/shared/src/advisor-windows.ts'), 'utf8');
  const sharedKey = shared.match(/GENERAL_WINDOW_KEY\s*=\s*"([^"]+)"/)[1];
  assert.equal(windowsMod.DEFAULT_WINDOW_KEY, sharedKey);
});

test('the board and home pages render AdvisorView without props', () => {
  for (const page of ['apps/web/app/page.tsx', 'apps/web/app/board/page.tsx']) {
    const source = readFileSync(join(repoRoot, page), 'utf8');
    assert.match(source, /<AdvisorView \/>/, page);
    assert.doesNotMatch(source, /AdvisorWindow/, page);
  }
});
