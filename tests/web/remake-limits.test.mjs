import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import * as remakeLimits from '../../apps/web/lib/remake-limits.mjs';
import { draftToRemakeLimits, remakeLimitsToDraft } from '../../apps/web/lib/remake-limits.mjs';

import { repoRoot } from '../helpers/paths.mjs';
const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const realJsxRuntime = webRequire('react/jsx-runtime');

const settings = {
  lineage_review_attempts: 9,
  lineage_worker_runs: 10,
  non_functional_remakes: 2,
  base_sync_lineage_review_attempts: 9,
  base_sync_lineage_worker_runs: 10,
  lead_review_rejections: 4,
  verification_paths: ['**/tests/**', '**/*.test.*'],
  checked_task_types: ['code', 'config'],
};

function compile(path, mocks, extra = {}) {
  const { outputText } = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(path);
  loaded.filename = path;
  loaded.paths = Module._nodeModulePaths(dirname(path));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    if (request === 'react') return { ...React, ...extra.react };
    if (request === 'react/jsx-runtime') return extra.jsx ?? realJsxRuntime;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, path);
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
    assert.equal(url.pathname, '/api/v1/settings/remake-limits');
    return handler(init);
  };
}

function loadApiClient() {
  return compile(join(repoRoot, 'apps/web/lib/api-client.ts'), {
    '@/lib/format': { runOrdinals: () => new Map() },
    '@/lib/work-detail-safety.mjs': { normalizeWorkDetailData: (value) => value },
  });
}

test('draft round-trips the settings and turns form text into the API payload', () => {
  const draft = remakeLimitsToDraft(settings);
  assert.equal(draft.verification_paths, '**/tests/**\n**/*.test.*');
  assert.deepEqual(draftToRemakeLimits(draft), settings);
  const edited = { ...draft, lineage_review_attempts: '12', verification_paths: ' a/** \n\n b/** ', checked_task_types: ['doc'] };
  assert.deepEqual(draftToRemakeLimits(edited), {
    ...settings, lineage_review_attempts: 12, verification_paths: ['a/**', 'b/**'], checked_task_types: ['doc'],
  });
  assert.ok(Number.isNaN(draftToRemakeLimits({ ...draft, lineage_worker_runs: '' }).lineage_worker_runs));
});

test('api client reads settings and PUTs the payload; validation errors keep the API message', async () => {
  const { getRemakeLimitSettings, putRemakeLimitSettings, ApiRequestError } = loadApiClient();
  const originalFetch = globalThis.fetch;
  try {
    let seen = null;
    globalThis.fetch = fakeFetch((init) => {
      seen = init;
      return new Response(JSON.stringify({ request_id: 'r1', data: settings, version: 0 }), { status: 200 });
    });
    assert.deepEqual(await getRemakeLimitSettings(), settings);
    assert.deepEqual(await putRemakeLimitSettings(settings), settings);
    assert.equal(seen.method, 'PUT');
    assert.deepEqual(JSON.parse(seen.body).payload, settings);

    globalThis.fetch = fakeFetch(() =>
      new Response(JSON.stringify({ error: { code: 'validation_error', message: 'lineage_review_attempts must be an integer from 1 to 1000.' } }), { status: 400 }));
    await assert.rejects(() => putRemakeLimitSettings({ ...settings, lineage_review_attempts: 0 }), (error) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, 'validation_error');
      assert.match(error.rawMessage, /lineage_review_attempts/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// RemakeLimitsSection's useState() calls, in order:
// open, loaded, draft, loading, saving, notice, error.
function renderSection(state, api) {
  const values = [...state];
  let index = 0;
  let saveButton = null;
  const wrap = (jsx) => (type, props, ...rest) => {
    if (type === 'button' && props?.className === 'btn btn--primary btn--small') saveButton = props;
    return jsx(type, props, ...rest);
  };
  const module = compile(join(repoRoot, 'apps/web/components/SettingsView.tsx'), {
    '@/lib/view-loader': { useView: () => ({ data: undefined, error: null, loading: false, refresh: async () => {} }) },
    '@/lib/remake-limits.mjs': remakeLimits,
    '@/lib/i18n': { useLocale: () => ({ t: (key) => key }) },
    '@/lib/api-client': { ApiRequestError: class ApiRequestError extends Error {}, ...api },
    '@/lib/format': {}, '@/lib/model-presets': {}, '@/lib/settings-errors': { humanizeError: () => 'ERROR' },
    '@/components/ModelPresetsBar': {}, '@/components/FolderPickerDialog': {},
  }, {
    react: {
      useEffect: () => {},
      useState: (initial) => {
        const i = index++;
        if (i >= values.length) values[i] = initial;
        return [values[i], (next) => { values[i] = typeof next === 'function' ? next(values[i]) : next; }];
      },
    },
    jsx: { ...realJsxRuntime, jsx: wrap(realJsxRuntime.jsx), jsxs: wrap(realJsxRuntime.jsxs) },
  });
  const html = renderToStaticMarkup(React.createElement(module.RemakeLimitsSection));
  return { html, values, saveButton };
}

test('the section shows the loaded values and Save sends the edited ones', async () => {
  const draft = { ...remakeLimitsToDraft(settings), lineage_worker_runs: '15' };
  let sent = null;
  const api = { putRemakeLimitSettings: async (payload) => { sent = payload; return { ...settings, lineage_worker_runs: 15 }; } };
  const { html, saveButton, values } = renderSection([true, settings, draft, false, false, null, null], api);
  assert.match(html, /name="lineage_review_attempts"[^>]*value="9"/);
  assert.match(html, /name="lineage_worker_runs"[^>]*value="15"/);
  assert.match(html, /name="non_functional_remakes"[^>]*value="2"/);
  assert.match(html, /name="lead_review_rejections"[^>]*value="4"/);
  assert.match(html, /settings\.remakeLimits_lead_review_rejections/);
  assert.match(html, /\*\*\/tests\/\*\*\n\*\*\/\*\.test\.\*/);
  assert.match(html, /name="checked_task_type_code"[^>]*checked/);
  assert.doesNotMatch(html, /name="checked_task_type_doc"[^>]*checked/);
  await saveButton.onClick();
  assert.deepEqual(sent, { ...settings, lineage_worker_runs: 15 });
  assert.equal(values[5], 'settings.remakeLimitsSaved');
  assert.equal(values[6], null);
});

test('the section shows the API validation message when Save is rejected', async () => {
  class ApiRequestError extends Error {
    code = 'validation_error';
    rawMessage = 'lineage_review_attempts must be an integer from 1 to 1000.';
  }
  const draft = { ...remakeLimitsToDraft(settings), lineage_review_attempts: '0' };
  const api = { ApiRequestError, putRemakeLimitSettings: async () => { throw new ApiRequestError('validation_error'); } };
  const { saveButton, values } = renderSection([true, settings, draft, false, false, null, null], api);
  await saveButton.onClick();
  assert.equal(values[6], 'lineage_review_attempts must be an integer from 1 to 1000.');
  assert.equal(values[5], null);
});

test('English and Japanese define the same settings.remakeLimits* keys', () => {
  const read = (lang) => JSON.parse(readFileSync(join(repoRoot, `apps/web/lib/i18n/${lang}.json`), 'utf8')).settings;
  const keys = (dict) => Object.keys(dict).filter((key) => key.startsWith('remakeLimits')).sort();
  assert.ok(keys(read('en')).length > 0);
  assert.deepEqual(keys(read('en')), keys(read('ja')));
});

// SettingsView's useState() calls, by position: 0 rows, 9 hybridMode, 11 childSettings,
// 12 childDefaults, 16 childSettingsLoading. Others keep their initial value.
test('child-run settings have no concurrency-limit inputs and Save sends none', async () => {
  const pair = { provider: 'claude', model: 'm1', effort: null };
  const child = {
    default_provider: 'claude', default_model: 'm1', default_effort: null,
    defaults_by_parent_harness: { claude: pair, codex: { ...pair, provider: 'codex' } },
    allowed_models: [{ provider: 'claude', model: 'm1' }, { provider: 'codex', model: 'm1' }],
    allowed_efforts: [], timeout_minutes: 60, max_timeout_minutes: 120, max_attempts: 2,
    max_parallel_per_worker: 3, max_parallel_total: 6, // the API still returns them; Save must not echo them back
  };
  const preset = { 0: [], 9: true, 11: child, 12: child.defaults_by_parent_harness, 16: false };
  let index = 0;
  let saveButton = null;
  const wrap = (jsx) => (type, props, ...rest) => {
    if (type === 'button' && props?.children === 'settings.childRunSave') saveButton = props;
    return jsx(type, props, ...rest);
  };
  let sent = null;
  const module = compile(join(repoRoot, 'apps/web/components/SettingsView.tsx'), {
    '@/lib/view-loader': { useView: () => ({ data: undefined, error: null, loading: false, refresh: async () => {} }) },
    '@/lib/remake-limits.mjs': remakeLimits,
    '@/lib/i18n': { useLocale: () => ({ t: (key) => key }) },
    '@/lib/api-client': { ApiRequestError: class extends Error {}, setChildRunSettings: async (config) => { sent = config; return config; } },
    '@/lib/format': {}, '@/lib/model-presets': {}, '@/lib/settings-errors': { humanizeError: () => 'ERROR' },
    '@/components/ModelPresetsBar': { ModelPresetsBar: () => null }, '@/components/FolderPickerDialog': { FolderPickerDialog: () => null },
  }, {
    react: { useEffect: () => {}, useState: (initial) => { const i = index++; return [Object.hasOwn(preset, i) ? preset[i] : initial, () => {}]; } },
    jsx: { ...realJsxRuntime, jsx: wrap(realJsxRuntime.jsx), jsxs: wrap(realJsxRuntime.jsxs) },
  });
  const html = renderToStaticMarkup(React.createElement(module.SettingsView));
  assert.match(html, /settings\.childRunTimeoutMinutes/);
  assert.match(html, /settings\.childRunMaxAttempts/);
  assert.doesNotMatch(html, /childRunParallel|max_parallel/i);
  await saveButton.onClick();
  assert.ok(sent);
  assert.deepEqual(Object.keys(sent).filter((key) => key.startsWith('max_parallel')), []);
});

test('i18n has no child-run concurrency-limit keys', () => {
  for (const lang of ['en', 'ja']) {
    const { settings } = JSON.parse(readFileSync(join(repoRoot, `apps/web/lib/i18n/${lang}.json`), 'utf8'));
    assert.deepEqual(Object.keys(settings).filter((key) => key.startsWith('childRunParallel')), []);
  }
});
