import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import { repoRoot } from '../helpers/paths.mjs';
const apiClientPath = join(repoRoot, 'apps/web/lib/api-client.ts');
const settingsViewPath = join(repoRoot, 'apps/web/components/SettingsView.tsx');

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

function fakeFetch(handlers) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://owl.test');
    if (url.pathname === '/api/v1/runtime-config.json') {
      return new Response(JSON.stringify({ base_path: '/owl/', api_base: '/api/v1', ws_url: '/api/v1/ws', schema_version: '1.0.0' }), { status: 200 });
    }
    const handler = handlers[url.pathname];
    if (!handler) throw new Error(`Unexpected request: ${url.pathname}`);
    return handler(url, init);
  };
}

test('getAdvisorFolders GETs /settings/advisor-folders and returns the envelope data', async () => {
  const { getAdvisorFolders } = loadApiClient();
  const data = {
    shared_dir: '/home/owner/.owl/advisor/shared',
    screenshot_dir: '/home/owner/Desktop',
    defaults: { shared_dir: '/home/owner/.owl/advisor/shared', screenshot_dir: '/home/owner/Desktop' },
    custom: { shared_dir: false, screenshot_dir: false },
  };
  let seenMethod = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({
    '/api/v1/settings/advisor-folders': (url, init) => {
      seenMethod = init.method ?? 'GET';
      return new Response(JSON.stringify({ request_id: 'r1', data, version: 1 }), { status: 200 });
    },
  });
  try {
    const result = await getAdvisorFolders();
    assert.equal(seenMethod, 'GET');
    assert.deepEqual(result, data);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('putAdvisorFolders PUTs the shared_dir/screenshot_dir payload and returns the envelope data', async () => {
  const { putAdvisorFolders } = loadApiClient();
  const data = {
    shared_dir: '/custom/shared',
    screenshot_dir: '/home/owner/Desktop',
    defaults: { shared_dir: '/home/owner/.owl/advisor/shared', screenshot_dir: '/home/owner/Desktop' },
    custom: { shared_dir: true, screenshot_dir: false },
  };
  let seenMethod = null;
  let seenBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({
    '/api/v1/settings/advisor-folders': (url, init) => {
      seenMethod = init.method;
      seenBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ request_id: 'r1', data, version: 2 }), { status: 200 });
    },
  });
  try {
    const result = await putAdvisorFolders({ shared_dir: '/custom/shared', screenshot_dir: '' });
    assert.equal(seenMethod, 'PUT');
    assert.deepEqual(seenBody.payload, { shared_dir: '/custom/shared', screenshot_dir: '' });
    assert.equal(typeof seenBody.request_id, 'string');
    assert.equal(seenBody.expected_version, 0);
    assert.deepEqual(result, data);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('putAdvisorFolders surfaces the server-localized message on a 422 validation error', async () => {
  const { putAdvisorFolders, ApiRequestError } = loadApiClient();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({
    '/api/v1/settings/advisor-folders': () =>
      new Response(JSON.stringify({ error: { code: 'validation_error', message: '共有フォルダのパスが不正です。' } }), { status: 422 }),
  });
  try {
    await assert.rejects(
      () => putAdvisorFolders({ shared_dir: '/bad', screenshot_dir: '' }),
      (error) => {
        assert.ok(error instanceof ApiRequestError);
        assert.equal(error.code, 'validation_error');
        assert.equal(error.rawMessage, '共有フォルダのパスが不正です。');
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---- AdvisorFoldersSection component -------------------------------------
//
// Compiled the same way tests/web-advisor-send-key.test.mjs compiles
// AdvisorView.tsx: transpile with the real TS compiler, patch the JSX
// runtime to capture the elements we care about, and drive React hooks with
// a tiny harness instead of a full renderer.

const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const realJsxRuntime = webRequire('react/jsx-runtime');

let capturedResetButton = null;
let capturedSaveButton = null;

function wrapJsx(originalJsx) {
  return function patchedJsx(type, props, ...rest) {
    if (type === 'button' && props?.className === 'btn btn--small') capturedResetButton = props;
    if (type === 'button' && props?.className === 'btn btn--primary btn--small') capturedSaveButton = props;
    return originalJsx(type, props, ...rest);
  };
}

const patchedJsxRuntime = {
  ...realJsxRuntime,
  jsx: wrapJsx(realJsxRuntime.jsx),
  jsxs: wrapJsx(realJsxRuntime.jsxs),
};

function translateForComponent(key) {
  return key;
}

const componentI18n = { useLocale: () => ({ t: translateForComponent }) };

function compileSettingsView(overrides) {
  const source = readFileSync(settingsViewPath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const loaded = new Module(settingsViewPath);
  loaded.filename = settingsViewPath;
  loaded.paths = Module._nodeModulePaths(dirname(settingsViewPath));

  const componentReact = {
    ...React,
    useState: (initialValue) => overrides.harness.useState(initialValue),
    useEffect: () => {},
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'react') return componentReact;
    if (request === 'react/jsx-runtime') return patchedJsxRuntime;
    if (request === '@/lib/i18n') return componentI18n;
    if (Object.hasOwn(overrides.modules, request)) return overrides.modules[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, settingsViewPath);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports;
}

// AdvisorFoldersSection's useState() calls, in declaration order:
// open, folders, sharedDir, screenshotDir, loading, saving, notice, error.
function createHookHarness(initialState) {
  const state = [...initialState];
  let hookIndex = 0;
  return {
    state,
    useState(initialValue) {
      const index = hookIndex++;
      if (index >= state.length) state[index] = initialValue;
      return [state[index], (nextValue) => {
        state[index] = typeof nextValue === 'function' ? nextValue(state[index]) : nextValue;
      }];
    },
  };
}

function renderAdvisorFolders(state, apiClientOverrides) {
  capturedResetButton = null;
  capturedSaveButton = null;
  const harness = createHookHarness(state);
  const module = compileSettingsView({
    harness,
    modules: {
      '@/lib/api-client': {
        getAdvisorFolders: async () => ({}),
        putAdvisorFolders: async () => ({}),
        setAdvisorPersona: async () => '',
        getAdvisorPersona: async () => '',
        ...apiClientOverrides,
        // Everything else SettingsView.tsx imports from api-client is unused
        // by AdvisorFoldersSection, but must exist so the module loads.
        getModelSettings: async () => [], updateModelSettings: async () => {}, getIntegrations: async () => [],
        saveIntegration: async () => {}, testIntegration: async () => {}, deleteIntegration: async () => {},
        getHybridMode: async () => false, setHybridMode: async () => false, getExecutorConfig: async () => ({}),
        setExecutorConfig: async () => ({}), listProviders: async () => [], createProvider: async () => ({}),
        deleteProvider: async () => {}, testProvider: async () => ({}), saveProvider: async () => ({}),
        getProviderModels: async () => ({}), setProviderModels: async () => [], getTypesafeApiKey: async () => '',
        setTypesafeApiKey: async () => '', getOwnerLanguage: async () => 'ja', setOwnerLanguage: async () => 'ja',
        ApiRequestError: class ApiRequestError extends Error {},
      },
      '@/lib/view-loader': { useView: () => ({ data: undefined, error: null, loading: false, refresh: async () => {} }) },
      '@/lib/format': { roleDisplayName: (role) => role },
      '@/lib/settings-errors': { humanizeError: () => 'ERROR' },
      '@/lib/remake-limits.mjs': {},
      '@/lib/model-presets': { presetMatchesSettings: () => false },
      '@/components/ModelPresetsBar': { ModelPresetsBar: () => null },
      '@/components/FolderPickerDialog': { FolderPickerDialog: () => null },
    },
  });
  renderToStaticMarkup(React.createElement(module.AdvisorFoldersSection));
  return { harness, resetButton: capturedResetButton, saveButton: capturedSaveButton };
}

test('the reset button clears that field, and Save then sends "" for it', async () => {
  const loaded = {
    shared_dir: '/custom/shared',
    screenshot_dir: '/home/owner/Desktop',
    defaults: { shared_dir: '/home/owner/.owl/advisor/shared', screenshot_dir: '/home/owner/Desktop' },
    custom: { shared_dir: true, screenshot_dir: false },
  };
  // open=true, folders=loaded, sharedDir=loaded value, screenshotDir=loaded value, loading=false, saving=false, notice=null, error=null
  const state = [true, loaded, loaded.shared_dir, loaded.screenshot_dir, false, false, null, null];

  const { harness, resetButton } = renderAdvisorFolders(state);
  assert.ok(resetButton, 'expected the shared-folder reset button to render when custom.shared_dir is true');

  resetButton.onClick();
  assert.equal(harness.state[2], '', 'clicking reset should clear the shared_dir draft');

  // Re-render with sharedDir already reset, the way it would look right after
  // the click above, and confirm Save sends "" for that field.
  let putPayload = null;
  const { saveButton } = renderAdvisorFolders(
    [true, loaded, '', loaded.screenshot_dir, false, false, null, null],
    { putAdvisorFolders: async (payload) => { putPayload = payload; return loaded; } },
  );
  assert.ok(saveButton, 'expected the save button to render');
  await saveButton.onClick();
  assert.deepEqual(putPayload, { shared_dir: '', screenshot_dir: loaded.screenshot_dir });
});

test('the screenshot-folder field shows the "Default" badge (no reset button) when not custom', async () => {
  const loaded = {
    shared_dir: '/home/owner/.owl/advisor/shared',
    screenshot_dir: '/home/owner/Desktop',
    defaults: { shared_dir: '/home/owner/.owl/advisor/shared', screenshot_dir: '/home/owner/Desktop' },
    custom: { shared_dir: false, screenshot_dir: false },
  };
  const state = [true, loaded, loaded.shared_dir, loaded.screenshot_dir, false, false, null, null];
  const { resetButton } = renderAdvisorFolders(state);
  assert.equal(resetButton, null, 'no reset button should render when neither field is custom');
});

test('English and Japanese define the same settings.advisorFolders* keys', () => {
  const english = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8'));
  const japanese = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8'));
  const englishKeys = Object.keys(english.settings).filter((key) => key.startsWith('advisorFolders')).sort();
  const japaneseKeys = Object.keys(japanese.settings).filter((key) => key.startsWith('advisorFolders')).sort();
  assert.ok(englishKeys.length > 0, 'expected at least one settings.advisorFolders* key');
  assert.deepEqual(englishKeys, japaneseKeys);
  for (const key of englishKeys) {
    assert.ok(english.settings[key].length > 0, `en ${key} should not be empty`);
    assert.ok(japanese.settings[key].length > 0, `ja ${key} should not be empty`);
  }
});

test('English and Japanese settings.json define the exact same key set overall', () => {
  const english = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8'));
  const japanese = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8'));
  assert.deepEqual(Object.keys(english.settings).sort(), Object.keys(japanese.settings).sort());
});
