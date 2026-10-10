import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import { repoRoot } from '../helpers/paths.mjs';
const apiClientPath = join(repoRoot, 'apps/web/lib/api-client.ts');

function loadApiClient() {
  const { outputText } = ts.transpileModule(readFileSync(apiClientPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(apiClientPath);
  loaded.filename = apiClientPath;
  loaded.paths = Module._nodeModulePaths(dirname(apiClientPath));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@/lib/format') return { runOrdinals: () => new Map() };
    if (request === '@/lib/work-detail-safety.mjs') return { normalizeWorkDetailData: (value) => value };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, apiClientPath);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports;
}

function fakeFetch(handler) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://owl.test');
    if (url.pathname === '/api/v1/runtime-config.json') {
      return new Response(JSON.stringify({ base_path: '/owl/', api_base: '/api/v1', ws_url: '/api/v1/ws', schema_version: '1.0.0' }), { status: 200 });
    }
    return handler(url, init);
  };
}

const settings = {
  librarian_times: ['03:00', '15:00'],
  research_autosave: true,
  next_librarian_run_at: '2026-09-29T03:00:00.000Z',
  next_skill_curation_run_at: '2026-09-29T03:00:00.000Z',
  next_rule_curation_run_at: '2026-09-29T03:00:00.000Z',
  time_zone: 'Asia/Tokyo',
};

test('getKnowledgeAutomationSettings GETs the endpoint and returns envelope data', async () => {
  const { getKnowledgeAutomationSettings } = loadApiClient();
  const originalFetch = globalThis.fetch;
  let seenPath = null;
  let seenMethod = null;
  globalThis.fetch = fakeFetch((url, init) => {
    seenPath = url.pathname;
    seenMethod = init.method ?? 'GET';
    return new Response(JSON.stringify({ request_id: 'r1', data: settings, version: 0 }), { status: 200 });
  });
  try {
    assert.deepEqual(await getKnowledgeAutomationSettings(), settings);
    assert.equal(seenPath, '/api/v1/settings/knowledge-automation');
    assert.equal(seenMethod, 'GET');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('setKnowledgeAutomationSettings PUTs the input and returns envelope data', async () => {
  const { setKnowledgeAutomationSettings } = loadApiClient();
  const input = { librarian_times: ['12:00'], research_autosave: false };
  const saved = { ...settings, ...input, next_librarian_run_at: null };
  const originalFetch = globalThis.fetch;
  let seenPath = null;
  let seenMethod = null;
  let seenBody = null;
  globalThis.fetch = fakeFetch((url, init) => {
    seenPath = url.pathname;
    seenMethod = init.method;
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ request_id: 'r2', data: saved, version: 0 }), { status: 200 });
  });
  try {
    assert.deepEqual(await setKnowledgeAutomationSettings(input), saved);
    assert.equal(seenPath, '/api/v1/settings/knowledge-automation');
    assert.equal(seenMethod, 'PUT');
    assert.deepEqual(seenBody.payload, input);
    assert.equal(seenBody.expected_version, 0);
    assert.equal(typeof seenBody.request_id, 'string');
    assert.equal(typeof seenBody.idempotency_key, 'string');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('setKnowledgeAutomationSettings surfaces server validation errors', async () => {
  const { setKnowledgeAutomationSettings, ApiRequestError } = loadApiClient();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(() => new Response(JSON.stringify({
    error: { code: 'validation_error', message: 'Invalid librarian time.' },
  }), { status: 400 }));
  try {
    await assert.rejects(
      () => setKnowledgeAutomationSettings({ librarian_times: ['bad'], research_autosave: true }),
      (error) => {
        assert.ok(error instanceof ApiRequestError);
        assert.equal(error.code, 'validation_error');
        assert.equal(error.rawMessage, 'Invalid librarian time.');
        assert.equal(error.status, 400);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('KnowledgeAutomationSection shows the next run of all three scheduled kinds', () => {
  const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
  const React = webRequire('react');
  const { renderToStaticMarkup } = webRequire('react-dom/server');
  const viewPath = join(repoRoot, 'apps/web/components/SettingsView.tsx');
  const { outputText } = ts.transpileModule(readFileSync(viewPath, 'utf8'), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(viewPath);
  loaded.filename = viewPath;
  loaded.paths = Module._nodeModulePaths(dirname(viewPath));
  // useState order in KnowledgeAutomationSection: settings, librarianTimes, researchAutosave, loading, saving, error, notice.
  const renderSection = (current) => {
  const state = [current, settings.librarian_times, true, false, false, null, null];
  let index = 0;
  const stubs = {
    react: {
      ...React,
      useState: (initial) => {
        const i = index++;
        if (i >= state.length) state[i] = initial;
        return [state[i], () => {}];
      },
      useEffect: () => {},
    },
    '@/lib/i18n': { useLocale: () => ({ t: (key, vars) => (vars?.time ? `${key}|${vars.time}` : key) }) },
    '@/lib/view-loader': { useView: () => ({ data: undefined, error: null, loading: false, refresh: async () => {} }) },
    '@/lib/api-client': new Proxy({}, { get: (_, name) => (name === 'ApiRequestError' ? class extends Error {} : async () => ({})) }),
    '@/lib/format': {},
    '@/lib/settings-errors': {},
    '@/lib/remake-limits.mjs': {},
    '@/lib/model-presets': {},
    '@/components/ModelPresetsBar': {},
    '@/components/FolderPickerDialog': {},
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(stubs, request)) return stubs[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, viewPath);
  } finally {
    Module._load = originalLoad;
  }
  return renderToStaticMarkup(React.createElement(loaded.exports.KnowledgeAutomationSection));
  };
  const time = (iso) => new Date(iso).toLocaleString();
  const withTimes = renderSection({
    ...settings,
    next_librarian_run_at: '2026-09-29T03:00:00.000Z',
    next_skill_curation_run_at: '2026-09-30T04:00:00.000Z',
    next_rule_curation_run_at: '2026-10-01T05:00:00.000Z',
  });
  assert.ok(withTimes.includes(`settings.librarianNextRun|${time('2026-09-29T03:00:00.000Z')}`));
  assert.ok(withTimes.includes(`settings.skillCurationNextRun|${time('2026-09-30T04:00:00.000Z')}`));
  assert.ok(withTimes.includes(`settings.ruleCurationNextRun|${time('2026-10-01T05:00:00.000Z')}`));
  const withoutRule = renderSection({ ...settings, next_rule_curation_run_at: null });
  assert.ok(withoutRule.includes('settings.librarianNextRunNone'));
  assert.ok(!withoutRule.includes('settings.ruleCurationNextRun'));
});
