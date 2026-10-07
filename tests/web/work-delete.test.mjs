import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import { repoRoot } from '../helpers/paths.mjs';
const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
const modulePath = join(repoRoot, 'apps/web/components/WorkArchiveActions.tsx');
const en = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8'));
const lookup = (key) => key.split('.').reduce((o, k) => o?.[k], en);
const t = (key, vars = {}) => String(lookup(key)).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]);

function load(removeWorks, removal = { removeWorks, confirmDeleteIfUnmerged: async () => true }) {
  const { outputText } = ts.transpileModule(readFileSync(modulePath, 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const overrides = {
    react: { ...webRequire('react'), useState: (v) => [v, () => {}] },
    '@/lib/api-client': {},
    '@/lib/i18n': { useLocale: () => ({ t }) },
    '@/lib/work-removal': removal,
    '@/components/icons': new Proxy({}, { get: () => () => null }),
  };
  const loaded = new Module(modulePath);
  loaded.filename = modulePath;
  loaded.paths = Module._nodeModulePaths(dirname(modulePath));
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    return Object.hasOwn(overrides, request) ? overrides[request] : originalLoad.call(this, request, ...rest);
  };
  try {
    loaded._compile(outputText, modulePath);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports.WorkArchiveActions;
}

function deleteButton(tree) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === 'button' && /btn--danger/.test(node.props.className)) found.push(node);
    walk(node.props?.children);
  };
  walk(tree);
  return found[0] ?? null;
}

const work = (state, title = 'My Work') => ({ id: 'w1', title, display_number: 7, state, state_version: 3, archived_at: null });

test('delete button is shown only for completed and cancelled Works', () => {
  const Actions = load(async () => true);
  for (const state of ['completed', 'cancelled']) {
    assert.ok(deleteButton(Actions({ work: work(state), onDeleted() {} })), state);
  }
  for (const state of ['memo', 'ready', 'running', 'paused', 'judgement_waiting', 'failed']) {
    assert.equal(deleteButton(Actions({ work: work(state), onDeleted() {} })), null, state);
  }
});

test('delete confirms naming the Work and only proceeds when approved', async () => {
  const originalWindow = globalThis.window;
  try {
    for (const approve of [false, true]) {
      const messages = [];
      globalThis.window = { confirm: (message) => { messages.push(message); return approve; } };
      let confirmResult;
      const removeWorks = async (works, kind, confirmDelete) => {
        confirmResult = await confirmDelete();
        return confirmResult;
      };
      const Actions = load(removeWorks);
      deleteButton(Actions({ work: work('completed', ''), onDeleted() {} })).props.onClick();
      await new Promise((r) => setImmediate(r));
      assert.equal(confirmResult, approve);
      assert.match(messages[0], /Work #7/);
      assert.match(messages[0], /cannot be undone/);
      assert.match(messages[0], /worktree and branch/);
    }
  } finally {
    globalThis.window = originalWindow;
  }
});

function loadRemoval(calls) {
  const path = join(repoRoot, 'apps/web/lib/work-removal.ts');
  const { outputText } = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const apiClient = {
    archiveWork: async () => {},
    unarchiveWork: async () => {},
    getWorkBranchStatus: async () => 'absent',
    deleteWork: async (...args) => { calls.push(args); },
  };
  const loaded = new Module(path);
  loaded.filename = path;
  loaded.paths = Module._nodeModulePaths(dirname(path));
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === '@/lib/api-client' ? apiClient : originalLoad.call(this, request, ...rest);
  };
  try {
    loaded._compile(outputText, path);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports;
}

test('confirmed delete reaches deleteWork through work-removal exactly once', async () => {
  const originalWindow = globalThis.window;
  try {
    for (const approve of [false, true]) {
      const calls = [];
      globalThis.window = { confirm: () => approve };
      const Actions = load(null, loadRemoval(calls));
      const button = deleteButton(Actions({ work: work('completed'), onDeleted() {} }));
      assert.equal(calls.length, 0, 'before confirm');
      button.props.onClick();
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(calls, approve ? [['w1', 3]] : []);
    }
  } finally {
    globalThis.window = originalWindow;
  }
});
