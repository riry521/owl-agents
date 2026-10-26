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

const { roleDisplayName } = compile(join(repoRoot, 'apps/web/lib/format.ts'), {
  '@/lib/work-detail-safety.mjs': {},
  '@/lib/i18n/ja.json': {},
  '@/lib/i18n/en.json': {},
});

// Renders a SettingsView export with useState values preset by call position (others keep their initial value).
function render(name, preset, api, capture) {
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
    '@/lib/format': { roleDisplayName }, '@/lib/model-presets': { presetMatchesSettings: () => true },
    '@/lib/settings-errors': { humanizeError: () => 'ERROR' },
    '@/components/OwnerInviteButton': { OwnerInviteButton: () => null }, '@/components/ModelPresetsBar': { ModelPresetsBar: () => null }, '@/components/FolderPickerDialog': { FolderPickerDialog: () => null },
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
  const html = renderToStaticMarkup(React.createElement(module[name]));
  return { html, captured, state: preset };
}

const roles = ['advisor', 'manager', 'designer', 'lead_designer', 'worker', 'fixer', 'reviewer', 'librarian', 'curator'];
const rows = roles.map((role) => ({ role, provider: 'anthropic', model: `model-${role}`, effort: 'high', catalog_version: 'v1' }));

test('the model settings show a Fixer card after Worker and Save sends every role including fixer', async () => {
  let sent = null;
  const api = { updateModelSettings: async (input) => { sent = input; return { roles: input, version: 1 }; } };
  const { html, captured } = render('SettingsView', { 0: rows }, api, (type, props) => (type === 'form' ? 'form' : null));
  assert.ok(html.indexOf('>Fixer<') > html.indexOf('>Worker<'), 'Fixer is listed after Worker');
  assert.ok(html.indexOf('>Fixer<') < html.indexOf('>Reviewer<'), 'Fixer is listed before Reviewer');
  assert.match(html, /model-fixer/);
  await captured.form.onSubmit({ preventDefault() {} });
  assert.equal(sent.length, roles.length);
  const sentRoles = sent.map((row) => row.role);
  assert.equal(sentRoles.indexOf('fixer'), sentRoles.indexOf('worker') + 1);
  assert.equal(new Set(sentRoles).size, roles.length);
  assert.deepEqual(sent.find((row) => row.role === 'fixer'), { role: 'fixer', provider: 'anthropic', model: 'model-fixer', effort: 'high' });
});

// FixerEscalationSection's useState() calls, in order: loaded, draft, saving, notice, error.
test('the Fixer section shows the saved count and Save sends the edited one', async () => {
  let sent = null;
  const api = { putFixerEscalationSettings: async (payload) => { sent = payload; return payload; } };
  const isSave = (type, props) => (type === 'button' && props?.children === 'settings.fixerEscalationSave' ? 'save' : null);
  const { html, captured, state } = render('FixerEscalationSection', { 0: { after_review_rejections: 2 }, 1: '3', 2: false, 3: null, 4: null }, api, isSave);
  assert.match(html, /name="after_review_rejections"[^>]*value="3"/);
  assert.match(html, /settings\.fixerEscalation_after_review_rejections/);
  await captured.save.onClick();
  assert.deepEqual(sent, { after_review_rejections: 3 });
  assert.equal(state[3], 'settings.fixerEscalationSaved');
  assert.equal(state[4], null);
});

test('the Fixer section shows the API validation message when Save is rejected', async () => {
  class ApiRequestError extends Error {
    code = 'validation_error';
    rawMessage = 'after_review_rejections must be an integer from 1 to 100.';
  }
  const api = { ApiRequestError, putFixerEscalationSettings: async () => { throw new ApiRequestError('validation_error'); } };
  const isSave = (type, props) => (type === 'button' && props?.children === 'settings.fixerEscalationSave' ? 'save' : null);
  const { captured, state } = render('FixerEscalationSection', { 0: { after_review_rejections: 2 }, 1: '0', 2: false, 3: null, 4: null }, api, isSave);
  await captured.save.onClick();
  assert.equal(state[4], 'after_review_rejections must be an integer from 1 to 100.');
  assert.equal(state[3], null);
});

test('the Fixer role has a display name', () => {
  assert.equal(roleDisplayName('fixer'), 'Fixer');
});

test('English and Japanese define the Fixer i18n keys', () => {
  const read = (lang) => JSON.parse(readFileSync(join(repoRoot, `apps/web/lib/i18n/${lang}.json`), 'utf8'));
  const added = [
    ['settings', 'fixerEscalation'],
    ['settings', 'fixerEscalationDescription'],
    ['settings', 'fixerEscalation_after_review_rejections'],
    ['settings', 'fixerEscalationSave'],
    ['settings', 'fixerEscalationSaved'],
    ['settings', 'fixerEscalationError'],
    ['work', 'fixerEscalated'],
  ];
  for (const lang of ['en', 'ja']) {
    const dict = read(lang);
    for (const [section, key] of added) assert.equal(typeof dict[section][key], 'string', `${lang}: ${section}.${key}`);
  }
  assert.match(read('ja').work.fixerEscalated, /検証の不合格とレビューの差し戻しが合わせて \{\{count\}\} 回になったため Fixer が担当しています/);
  assert.match(read('en').work.fixerEscalated, /Fixer took over after \{\{count\}\} verification failures and review rejections/);
});

// AutoRecoverySection's useState() calls, in order: loaded, draft, saving, notice, error.
test('the automatic recovery section saves the edited count', async () => {
  let sent = null;
  const api = { putAutoRecoverySettings: async (payload) => { sent = payload; return payload; } };
  const isSave = (type, props) => (type === 'button' && props?.children === 'settings.autoRecoverySave' ? 'save' : null);
  const { html, captured, state } = render('AutoRecoverySection', { 0: 2, 1: '4', 2: false, 3: null, 4: null }, api, isSave);
  assert.match(html, /name="limit"[^>]*value="4"/);
  await captured.save.onClick();
  assert.deepEqual(sent, { limit: 4 });
  assert.equal(state[3], 'settings.autoRecoverySaved');
  assert.equal(state[4], null);
});

test('the automatic recovery section shows the invalid-value message and sends nothing for a bad count', async () => {
  let sent = null;
  const api = { putAutoRecoverySettings: async (payload) => { sent = payload; return payload; } };
  const isSave = (type, props) => (type === 'button' && props?.children === 'settings.autoRecoverySave' ? 'save' : null);
  for (const draft of ['11', '-1', '1.5', '']) {
    const { captured, state } = render('AutoRecoverySection', { 0: 2, 1: draft, 2: false, 3: null, 4: null }, api, isSave);
    await captured.save.onClick();
    assert.equal(state[4], 'settings.autoRecoveryInvalid', draft);
  }
  assert.equal(sent, null);
  const read = (lang) => JSON.parse(readFileSync(join(repoRoot, `apps/web/lib/i18n/${lang}.json`), 'utf8'));
  assert.equal(read('ja').settings.autoRecoveryInvalid, '0 から 10 の整数を入れてください。');
  assert.equal(read('ja').settings.autoRecovery, '自動の復旧');
  assert.equal(typeof read('en').settings.autoRecoveryInvalid, 'string');
});
