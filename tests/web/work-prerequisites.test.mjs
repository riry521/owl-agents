import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import { workDetailHref } from '../../apps/web/lib/work-detail-safety.mjs';
import { repoRoot } from '../helpers/paths.mjs';

const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const en = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8'));

function lookup(key) {
  return key.split('.').reduce((node, part) => node?.[part], en);
}
function t(key, values = {}) {
  const text = lookup(key);
  assert.equal(typeof text, 'string', `missing en.json key ${key}`);
  return text.replace(/\{\{(\w+)\}\}/g, (_, name) => values[name]);
}

function compile(relativePath, overrides = {}) {
  const modulePath = join(repoRoot, relativePath);
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

const i18n = { useLocale: () => ({ locale: 'en', t }) };
const link = { __esModule: true, default: ({ href, children }) => React.createElement('a', { href }, children) };
const ja = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8'));
const format = compile('apps/web/lib/format.ts', {
  '@/lib/work-detail-safety.mjs': { asReportEnvelope: (value) => value },
  '@/lib/i18n/ja.json': ja,
  '@/lib/i18n/en.json': en,
});
const stateBadge = compile('apps/web/components/StateBadge.tsx', { '@/lib/format': format, '@/lib/i18n': i18n });
const apiClientStub = { ApiRequestError: class extends Error {}, replaceWorkPrerequisites: async () => {}, releaseWorkPrerequisiteWait: async () => {} };
const { WorkPrerequisitesSection } = compile('apps/web/components/WorkPrerequisitesSection.tsx', {
  'next/link': link,
  '@/lib/api-client': apiClientStub,
  '@/components/StateBadge': stateBadge,
  '@/lib/i18n': i18n,
  '@/lib/work-detail-safety.mjs': { workDetailHref },
});

const prerequisite = (overrides = {}) => ({
  work_id: '01J00000000000000000000003',
  project_id: '01J00000000000000000000009',
  project_name: 'Owl',
  display_number: 3,
  title: 'Build the base',
  state: 'running',
  deleted: false,
  satisfied: false,
  ...overrides,
});
const renderSection = (work, prerequisites) =>
  renderToStaticMarkup(React.createElement(WorkPrerequisitesSection, { work: { id: 'w1', state_version: 4, ...work }, prerequisites, onChanged: () => {} }));

test('a ready Work shows the wait, its prerequisites and the release button', () => {
  const html = renderSection({ state: 'ready', prerequisite_wait: true }, [prerequisite(), prerequisite({ work_id: 'p2', project_name: 'Web', display_number: 5 })]);
  assert.equal(en.format.workState.ready, 'Waiting on prerequisites');
  assert.equal(ja.format.workState.ready, '前提待ち');
  const badge = renderToStaticMarkup(React.createElement(stateBadge.WorkStateBadge, { state: 'ready' }));
  assert.ok(badge.includes('Waiting on prerequisites'), 'the ready state badge text');
  assert.ok(html.includes('Owl Work #3') && html.includes('Web Work #5'));
  assert.ok(html.includes(`href="${workDetailHref('p2')}"`));
  assert.ok(html.includes('Stop waiting and start'));
});

test('a memo Work shows the prerequisite editor and no release button', () => {
  const html = renderSection({ state: 'memo', prerequisite_wait: false }, []);
  assert.ok(html.includes(t('work.prerequisites.add')));
  assert.ok(html.includes(t('work.prerequisites.save')));
  assert.ok(!html.includes('Stop waiting and start'));
});

test('a deleted prerequisite is marked as deleted', () => {
  const html = renderSection({ state: 'ready', prerequisite_wait: true }, [prerequisite({ deleted: true, state: null })]);
  assert.ok(html.includes('Deleted'));
});

test('the Work detail hides the plain start button while waiting on prerequisites', () => {
  const source = readFileSync(join(repoRoot, 'apps/web/components/WorkDetailView.tsx'), 'utf8');
  assert.ok(source.includes("work.state === 'memo' || (work.state === 'ready' && !work.prerequisite_wait)"));
});

test('the board WorkCard lists the Works it is waiting on', () => {
  const { WorkCard } = compile('apps/web/components/BoardView.tsx', {
    'next/link': link,
    '@/lib/view-loader': {},
    '@/lib/api-client': {},
    '@/lib/format': { workDisplayNumber: (n) => n ?? null, formatRelative: () => 'now', boardSectionOf: () => 'waiting', boardSectionLabels: () => ({}) },
    '@/components/StateBadge': { ...stateBadge, ArchivedBadge: () => null },
    '@/components/WorkArchiveActions': {},
    '@/lib/i18n': i18n,
    '@/lib/work-detail-safety.mjs': { workDetailHref },
    '@/lib/work-removal': {},
    '@/components/icons': {},
  });
  const work = {
    id: 'w1', display_number: 7, title: 'Waiting Work', state: 'ready', state_version: 1, updated_at: '2026-01-01T00:00:00Z', archived_at: null,
    waiting_on: [prerequisite(), prerequisite({ work_id: 'p2', project_name: 'Web', display_number: 5 })],
  };
  const html = renderToStaticMarkup(React.createElement(WorkCard, { work, section: 'waiting', decisions: [], now: 0, locale: 'en', t }));
  assert.ok(html.includes('Prerequisites: '));
  assert.ok(html.includes('Owl Work #3') && html.includes('Web Work #5'));
});

test('api-client sends the PUT and release routes with the design bodies', async () => {
  const { outputText } = ts.transpileModule(readFileSync(join(repoRoot, 'apps/web/lib/api-client.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const apiPath = join(repoRoot, 'apps/web/lib/api-client.ts');
  const loaded = new Module(apiPath);
  loaded.filename = apiPath;
  loaded.paths = Module._nodeModulePaths(dirname(apiPath));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@/lib/format') return { runOrdinals: () => new Map() };
    if (request === '@/lib/work-detail-safety.mjs') return { normalizeWorkDetailData: (value) => value };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, apiPath);
  } finally {
    Module._load = originalLoad;
  }
  const { replaceWorkPrerequisites, releaseWorkPrerequisiteWait } = loaded.exports;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://owl.test');
    if (url.pathname === '/api/v1/runtime-config.json') {
      return new Response(JSON.stringify({ base_path: '/owl/', api_base: '/api/v1', ws_url: '/api/v1/ws', schema_version: '1.0.0' }), { status: 200 });
    }
    calls.push({ path: url.pathname, method: init.method, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ request_id: 'r', data: { work_id: 'w1' }, version: 5 }), { status: 200 });
  };
  try {
    await replaceWorkPrerequisites('w1', 4, ['a', 'b']);
    await releaseWorkPrerequisiteWait('w1', 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls[0].path, '/api/v1/works/w1/prerequisites');
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].body.expected_version, 4);
  assert.deepEqual(calls[0].body.payload, { prerequisite_work_ids: ['a', 'b'] });
  assert.equal(calls[1].path, '/api/v1/works/w1/prerequisites/release');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].body.expected_version, 4);
  assert.deepEqual(calls[1].body.payload, {});
});
