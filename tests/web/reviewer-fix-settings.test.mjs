import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import * as remakeLimits from '../../apps/web/lib/remake-limits.mjs';

import { repoRoot } from '../helpers/paths.mjs';
const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const realJsxRuntime = webRequire('react/jsx-runtime');

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

// Renders ReviewerFixSection with useState values preset by call position: loaded, draft, saving, notice, error.
function render(preset, api, capture) {
  let index = 0;
  const captured = {};
  const wrap = (jsx) => (type, props, ...rest) => {
    const key = capture(type, props);
    if (key) captured[key] = props;
    return jsx(type, props, ...rest);
  };
  const module = compile(join(repoRoot, 'apps/web/components/SettingsView.tsx'), {
    '@/lib/view-loader': { useView: () => ({ data: undefined, error: null, loading: false, refresh: async () => {} }) },
    '@/lib/remake-limits.mjs': remakeLimits,
    '@/lib/i18n': { useLocale: () => ({ t: (key) => key }) },
    '@/lib/api-client': { ApiRequestError: class ApiRequestError extends Error {}, ...api },
    '@/lib/format': { roleDisplayName: () => '' }, '@/lib/model-presets': { presetMatchesSettings: () => true },
    '@/lib/api-error-keys.mjs': { humanizeSettingsError: () => 'ERROR' },
    '@/components/OwnerInviteButton': { OwnerInviteButton: () => null }, '@/components/ModelPresetsBar': { ModelPresetsBar: () => null }, '@/components/FolderPickerDialog': { FolderPickerDialog: () => null },
    '@/components/AutoWorkEntryPanel': { AutoWorkEntryPanel: () => null },
  }, {
    react: {
      useEffect: () => {},
      useState: (initial) => {
        const i = index++;
        const value = Object.hasOwn(preset, i) ? preset[i] : initial;
        return [value, (next) => { preset[i] = typeof next === 'function' ? next(value) : next; }];
      },
    },
    jsx: { ...realJsxRuntime, jsx: wrap(realJsxRuntime.jsx), jsxs: wrap(realJsxRuntime.jsxs) },
  });
  const html = renderToStaticMarkup(React.createElement(module.ReviewerFixSection));
  return { html, captured, state: preset };
}

const isSave = (type, props) => (type === 'button' && props?.children === 'settings.reviewerFixSave' ? 'save' : null);
const loaded = { max_changed_lines: 30, max_changed_files: 3 };

test('the Reviewer fix section shows both saved numbers and Save sends the edited ones', async () => {
  let sent = null;
  const api = { putReviewerFixSettings: async (payload) => { sent = payload; return payload; } };
  const { html, captured, state } = render({ 0: loaded, 1: { max_changed_lines: '50', max_changed_files: '4' }, 2: false, 3: null, 4: null }, api, isSave);
  assert.match(html, /name="max_changed_lines"[^>]*value="50"/);
  assert.match(html, /name="max_changed_files"[^>]*value="4"/);
  await captured.save.onClick();
  assert.deepEqual(sent, { max_changed_lines: 50, max_changed_files: 4 });
  assert.equal(state[3], 'settings.reviewerFixSaved');
  assert.equal(state[4], null);
});

test('the Reviewer fix section shows the API validation message when Save is rejected', async () => {
  class ApiRequestError extends Error {
    code = 'validation_error';
    rawMessage = 'max_changed_lines must be an integer from 0 to 1000.';
  }
  const api = { ApiRequestError, putReviewerFixSettings: async () => { throw new ApiRequestError('validation_error'); } };
  const { captured, state } = render({ 0: loaded, 1: { max_changed_lines: '5000', max_changed_files: '3' }, 2: false, 3: null, 4: null }, api, isSave);
  await captured.save.onClick();
  assert.equal(state[4], 'max_changed_lines must be an integer from 0 to 1000.');
  assert.equal(state[3], null);
});

test('English and Japanese define the Reviewer fix i18n keys', () => {
  const read = (lang) => JSON.parse(readFileSync(join(repoRoot, `apps/web/lib/i18n/${lang}.json`), 'utf8'));
  const keys = ['reviewerFix', 'reviewerFixDescription', 'reviewerFix_max_changed_lines', 'reviewerFix_max_changed_files', 'reviewerFixSave', 'reviewerFixSaved', 'reviewerFixError'];
  for (const lang of ['en', 'ja']) {
    const dict = read(lang);
    for (const key of keys) assert.equal(typeof dict.settings[key], 'string', `${lang}: settings.${key}`);
  }
});
