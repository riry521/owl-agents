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

// Hooks that keep state between renders and let the test run the effects itself.
let slots = [];
let slotIndex = 0;
let effects = [];
let pending = [];
const fakeReact = {
  ...React,
  useState(initial) {
    const i = slotIndex++;
    if (!(i in slots)) slots[i] = initial;
    return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
  },
  useEffect(effect) { effects.push(effect); },
  // The component starts load() with `void`, so keep the promises to wait for them.
  useCallback(callback) {
    return (...args) => {
      const result = callback(...args);
      pending.push(result);
      return result;
    };
  },
};

const api = {};
const stubs = {
  react: fakeReact,
  'next/link': { __esModule: true, default: (props) => React.createElement('a', props) },
  'next/navigation': { useRouter: () => ({ replace() {} }), useSearchParams: () => new URLSearchParams('name=demo') },
  '@/lib/api-client': api,
  '@/lib/format': { formatRelative: () => '', roleDisplayName: (role) => role },
  '@/lib/i18n': { useLocale: () => ({ locale: 'en', t: (key) => key }) },
  '@/lib/skill-diff': { formatByteCount: String, formatByteSize: String },
  '@/lib/skill-scope': { GLOBAL_SKILL_SCOPE: 'global', projectSkillScope: (id) => `project:${id}`, skillScopeLabel: (scope) => scope },
};

const modulePath = join(repoRoot, 'apps/web/components/SkillDetailView.tsx');
const { outputText } = ts.transpileModule(readFileSync(modulePath, 'utf8'), {
  compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const loaded = new Module(modulePath);
loaded.filename = modulePath;
loaded.paths = Module._nodeModulePaths(dirname(modulePath));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.hasOwn(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
try {
  loaded._compile(outputText, modulePath);
} finally {
  Module._load = originalLoad;
}
const SkillDetailView = loaded.exports.default ?? loaded.exports.SkillDetailView;

const skill = { name: 'demo', scope: 'global', state: 'active', tags: [], trial: 0, use_count: 0, last_used_at: null, current_revision: 1 };
async function renderAfterLoad({ revisions, projects }) {
  Object.assign(api, {
    listSkills: async () => [{ name: 'demo' }],
    getSkill: async () => ({ skill, body: '', files: {}, file_sizes: {}, recent_uses: [] }),
    listSkillRevisions: revisions,
    listProjects: projects,
  });
  slots = [];
  effects = [];
  pending = [];
  slotIndex = 0;
  renderToStaticMarkup(React.createElement(SkillDetailView));
  const originalError = console.error;
  console.error = () => {};
  try {
    for (const effect of effects) effect();
    await Promise.all(pending);
  } finally {
    console.error = originalError;
  }
  slotIndex = 0;
  return renderToStaticMarkup(React.createElement(SkillDetailView));
}

test('skill detail shows errors, not empty history and scopes, when revisions and projects fail to load', async () => {
  const markup = await renderAfterLoad({
    revisions: async () => { throw new Error('rev boom'); },
    projects: async () => { throw new Error('proj boom'); },
  });

  assert.match(markup, /skills\.detail\.revisionsLoadError: rev boom/);
  assert.match(markup, /skills\.detail\.projectsLoadError: proj boom/);
  assert.match(markup, /skills\.detail\.tabHistory/);
  assert.doesNotMatch(markup, /originNone/);
  assert.match(markup, /skills\.detail\.projectsLoadError/);
  assert.match(markup, /role="alert"/);
});

test('skill detail shows no load error when revisions and projects load, even if both are empty', async () => {
  const markup = await renderAfterLoad({ revisions: async () => [], projects: async () => [] });

  assert.match(markup, /skills\.detail\.skillMdTitle/);
  assert.doesNotMatch(markup, /LoadError/);
});
