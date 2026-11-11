import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import { viewerBackTarget, viewerStateForError } from '../../apps/web/lib/markdown-viewer-state.mjs';
import { repoRoot } from '../helpers/paths.mjs';

const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');

function compile(relPath, overrides) {
  const modulePath = join(repoRoot, relPath);
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
  try {
    loaded._compile(outputText, modulePath);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const runtimeConfig = { base_path: '/owl/', api_base: '/api/v1', ws_url: '/api/v1/events', schema_version: '1.0.0' };

/** Loads the real api-client with a fetch stub; `owner` answers owner-files and works/markdown requests. */
function loadApi(answer) {
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://owl.test');
    if (url.pathname === '/api/v1/runtime-config.json') return json(runtimeConfig);
    requests.push(url.pathname + url.search);
    return answer(url);
  };
  const api = compile('apps/web/lib/api-client.ts', {
    '@/lib/format': { runOrdinals: () => new Map() },
    '@/lib/work-detail-safety.mjs': {},
  });
  return { api, requests };
}

/** Renders the viewer once with effects run to completion: a minimal stand-in for React's state and effect scheduling. */
async function renderViewer(search, api) {
  const state = [];
  const effects = [];
  const layoutEffects = [];
  const refs = [];
  let index = 0;
  let refIndex = 0;
  const hooks = {
    ...React,
    useState: (initial) => {
      const i = index++;
      if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial;
      return [state[i], (value) => { state[i] = typeof value === 'function' ? value(state[i]) : value; }];
    },
    useEffect: (effect) => effects.push(effect),
    useLayoutEffect: (effect) => layoutEffects.push(effect),
    useRef: () => refs[refIndex++] ?? (refs[refIndex - 1] = { current: null }),
    useCallback: (fn) => fn,
  };
  const shared = {
    react: hooks,
    'next/link': { __esModule: true, default: ({ href, children }) => React.createElement('a', { href }, children) },
    '@/lib/i18n': { useLocale: () => ({ t: (key) => key }) },
    '@/lib/markdown-toc.mjs': webRequire('../../apps/web/lib/markdown-toc.mjs'),
  };
  const { MarkdownDocument } = compile('apps/web/components/MarkdownDocument.tsx', shared);
  const { MarkdownBackLink, MarkdownToc } = compile('apps/web/components/MarkdownToc.tsx', shared);
  const { MarkdownViewerView } = compile('apps/web/components/MarkdownViewerView.tsx', {
    ...shared,
    'next/navigation': { useSearchParams: () => new URLSearchParams(search) },
    '@/lib/api-client': api,
    '@/lib/markdown-viewer-state.mjs': { viewerBackTarget, viewerStateForError },
    '@/components/MarkdownDocument': { MarkdownDocument },
    '@/components/MarkdownNotice': { MarkdownNotice: ({ failure }) => React.createElement('div', { 'data-state': failure.state }) },
    '@/components/MarkdownToc': { MarkdownBackLink, MarkdownToc },
  });
  const render = () => {
    index = 0;
    refIndex = 0;
    effects.length = 0;
    layoutEffects.length = 0;
    return renderToStaticMarkup(React.createElement(MarkdownViewerView));
  };
  render();
  for (const effect of effects) effect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // No DOM here: the sheet answers the heading query from its own server-rendered markup.
  const ready = render();
  const headings = [...ready.matchAll(/<h([1-3])[^>]*id="([^"]*)"[^>]*>(.*?)<\/h\1>/g)].map((m) => ({ id: m[2], textContent: m[3].replace(/<[^>]+>/g, ''), tagName: `H${m[1]}` }));
  for (const ref of refs) ref.current = { querySelectorAll: () => headings };
  for (const effect of layoutEffects) effect();
  return render();
}

test('root and path read the .md from owner-files with an encoded URL and render it', async () => {
  const { api, requests } = loadApi(() => new Response('# 題名\n\n## 見出し\n\n本文\n\n## 次の節\n\n続き', { status: 200, headers: { 'content-type': 'text/markdown' } }));
  const html = await renderViewer('root=docs&path=a%20b/メモ.md', api);
  assert.deepEqual(requests, [`/api/v1/owner-files/docs/${encodeURIComponent('a b')}/${encodeURIComponent('メモ.md')}`]);
  const headingId = html.match(/<h2[^>]*id="([^"]+)"[^>]*>見出し<\/h2>/)?.[1];
  assert.ok(headingId, 'heading is rendered with an id');
  assert.match(html, /<p>本文<\/p>/);
  assert.match(html, new RegExp(`<a class="md-toc__link"[^>]*href="#${headingId}"[^>]*>見出し</a>`));
  assert.match(html, /a b\/メモ\.md/);
});

test('id and path still read works/{id}/markdown, and id wins over root', async () => {
  const doc = { path: 'README.md', name: 'README.md', source: 'project', markdown: 'work body', size_bytes: 9 };
  const { api, requests } = loadApi(() => json({ data: doc }));
  const html = await renderViewer('id=01ABC&root=docs&path=README.md', api);
  assert.deepEqual(requests, ['/api/v1/works/01ABC/markdown?path=README.md']);
  assert.match(html, /<p>work body<\/p>/);
});

test('a URL without id/root or without path is invalid_url and calls no API', async () => {
  const { api, requests } = loadApi(() => json({}));
  for (const search of ['path=a.md', 'root=docs', 'id=01ABC', '']) {
    assert.match(await renderViewer(search, api), /data-state="invalid_url"/, search);
  }
  assert.deepEqual(requests, []);
});

test('owner-files failures map to the existing viewer states', async () => {
  const cases = [
    [404, 'markdown_not_found', 'not_found'],
    [403, 'markdown_path_denied', 'denied'],
    [500, 'server_error', 'load_failed'],
  ];
  for (const [status, code, state] of cases) {
    const { api } = loadApi(() => json({ error: { code, message: 'x', details: {} } }, status));
    assert.match(await renderViewer('root=docs&path=a.md', api), new RegExp(`data-state="${state}"`), code);
  }
  const { api: htmlApi } = loadApi(() => new Response('<html>oops</html>', { status: 502 }));
  assert.match(await renderViewer('root=docs&path=a.md', htmlApi), /data-state="load_failed"/);
  const { api: netApi } = loadApi(() => { throw new TypeError('fetch failed'); });
  assert.match(await renderViewer('root=docs&path=a.md', netApi), /data-state="load_failed"/);
});
