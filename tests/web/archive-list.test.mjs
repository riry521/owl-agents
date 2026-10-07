import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import { groupArchivedByDay, sortArchivedWorks } from '../../apps/web/lib/archive-list.mjs';

import { repoRoot } from '../helpers/paths.mjs';
const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
const React = webRequire('react');

// Minimal hooks so components can be called as plain functions and their element tree inspected.
let slots = [];
let slotIndex = 0;
const fakeReact = {
  ...React,
  useState(initial) {
    const i = slotIndex++;
    if (!(i in slots)) slots[i] = initial;
    return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
  },
  useRef(initial) {
    const i = slotIndex++;
    if (!(i in slots)) slots[i] = { current: initial };
    return slots[i];
  },
  useEffect() {},
};
function callComponent(Component, props) {
  slotIndex = 0;
  return Component(props);
}

function compile(modulePath, overrides = {}) {
  const { outputText } = ts.transpileModule(readFileSync(modulePath, 'utf8'), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(modulePath);
  loaded.filename = modulePath;
  loaded.paths = Module._nodeModulePaths(dirname(modulePath));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'react') return fakeReact;
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

/** Depth-first search of an element tree for elements matching the predicate (expands function components). */
function findAll(node, predicate, found = []) {
  if (node === null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    node.forEach((child) => findAll(child, predicate, found));
    return found;
  }
  if (predicate(node)) found.push(node);
  if (typeof node.type === 'function' && node.type !== fakeReact.Fragment) {
    try {
      findAll(callComponent(node.type, node.props), predicate, found);
    } catch {
      // Components that need real context are not expanded; their props are still searched below.
    }
  }
  findAll(node.props?.children, predicate, found);
  return found;
}
const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
};
const buttonWith = (tree, label) => findAll(tree, (n) => n.type === 'button' && textOf(n).includes(label))[0];

const translations = {
  'work.unarchiveShort': 'Restore',
  'work.delete': 'Delete',
  'work.archiveAllInSection': 'Archive all',
  'work.archiveAllConfirm': ({ count }) => `Archive ${count}`,
  'work.numberLabel': ({ number }) => `Work #${number}`,
  'archive.deleteConfirm': ({ name }) => `Permanently delete ${name}?`,
  'archive.noProject': '—',
};
const t = (key, values = {}) => (typeof translations[key] === 'function' ? translations[key](values) : translations[key] ?? key);

const removeCalls = [];
let confirmAnswer = true;
const workRemoval = {
  removeWorks: async (works, kind, confirmDelete) => {
    if (kind === 'delete' && confirmDelete && !await confirmDelete()) return false;
    removeCalls.push({ ids: works.map((w) => w.id), kind });
    return true;
  },
  confirmDeleteIfUnmerged: async () => true,
  revealWork: () => {},
  useWorkRemovals: () => ({ hiddenIds: new Set() }),
};
const icons = { TrashIcon: () => null, ArchiveBoxIcon: () => null, RestoreIcon: () => null };
const link = { __esModule: true, default: (props) => React.createElement('a', props) };
const stateBadge = { WorkStateBadge: () => null, ArchivedBadge: () => null };
const format = {
  formatDateTime: (iso) => `at ${iso}`,
  workDisplayNumber: (n) => (typeof n === 'number' ? n : null),
};
const i18n = { useLocale: () => ({ locale: 'en', t }) };
const apiClient = { getBoard: async () => ({}), listProjects: async () => [] };
let viewData;
const viewLoader = {
  useView: () => ({ data: viewData, error: null, loading: viewData === undefined, refresh: async () => {} }),
  useRealtimeStatus: () => 'connected',
};

const boardModule = compile(join(repoRoot, 'apps/web/components/BoardView.tsx'), {
  'next/link': link,
  '@/lib/api-client': apiClient,
  '@/lib/view-loader': viewLoader,
  '@/lib/format': { ...format, boardSectionOf: () => 'done', boardSectionLabels: () => ({}), formatRelative: () => '' },
  '@/components/StateBadge': stateBadge,
  '@/lib/i18n': i18n,
  '@/lib/work-detail-safety.mjs': { workDetailHref: (id) => `/work?id=${id}` },
  '../lib/work-summary.mjs': { workSummarySkeleton: () => null },
  '@/lib/work-removal': workRemoval,
  '@/components/icons': icons,
});
const archiveModule = compile(join(repoRoot, 'apps/web/components/ArchiveView.tsx'), {
  'next/link': link,
  '@/lib/api-client': apiClient,
  '@/lib/view-loader': viewLoader,
  '@/lib/format': format,
  '@/lib/i18n': i18n,
  '@/lib/work-detail-safety.mjs': { workDetailHref: (id) => `/work?id=${id}` },
  '@/lib/archive-list.mjs': { groupArchivedByDay },
  '@/lib/work-removal': workRemoval,
  '@/components/StateBadge': stateBadge,
  '@/components/icons': icons,
  '@/components/BoardView': { humanizeError: () => '' },
});

const work = (id, archived_at, extra = {}) => ({
  id, title: `Work ${id}`, display_number: 1, state: 'completed', state_version: 1, updated_at: archived_at, archived_at, ...extra,
});

test('Board bulk button archives (not deletes) the section only after the armed second tap', async () => {
  removeCalls.length = 0;
  slots = [];
  const works = [work('a', '2026-10-01T00:00:00Z'), work('b', '2026-10-02T00:00:00Z')];
  const props = { works, t, onArchived: async () => {} };
  let tree = callComponent(boardModule.SectionBulkButton, props);
  assert.equal(textOf(tree), 'Archive all');
  tree.props.onClick();
  assert.equal(removeCalls.length, 0, 'the first tap only arms the button');
  tree = callComponent(boardModule.SectionBulkButton, props);
  assert.equal(textOf(tree), 'Archive 2');
  tree.props.onClick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(removeCalls, [{ ids: ['a', 'b'], kind: 'archive' }]);
});

test('Board source has no delete operation for Works', () => {
  const source = readFileSync(join(repoRoot, 'apps/web/components/BoardView.tsx'), 'utf8');
  assert.doesNotMatch(source, /'delete'|deleteLabel|TrashIcon|confirmDeleteIfUnmerged|deleteAll/u);
});

test('archived Works sort newest-archived first and group by day', () => {
  const works = [
    work('old', '2026-09-01T10:00:00Z'),
    work('new', '2026-10-03T10:00:00Z'),
    work('mid', '2026-10-01T10:00:00Z'),
    work('legacy', null, { updated_at: '2026-09-15T10:00:00Z' }),
  ];
  assert.deepEqual(sortArchivedWorks(works).map((w) => w.id), ['new', 'mid', 'legacy', 'old']);
  const groups = groupArchivedByDay([...works, work('new2', '2026-10-03T10:30:00Z')]);
  assert.deepEqual(groups.map((g) => g.works.map((w) => w.id)), [['new2', 'new'], ['mid'], ['legacy'], ['old']]);
});

test('archive row shows number, title, project, state, time and restore/delete only', () => {
  const row = callComponent(archiveModule.ArchiveRow, {
    work: work('a', '2026-10-01T00:00:00Z', { display_number: 7 }),
    projectName: 'Owl',
    locale: 'en',
    t,
    onRestore: () => {},
    onDelete: () => {},
  });
  const text = textOf(row);
  for (const expected of ['Work #7', 'Work a', 'Owl', 'at 2026-10-01T00:00:00Z', 'Restore', 'Delete']) {
    assert.ok(text.includes(expected), `row should include ${expected}`);
  }
  assert.equal(row.type, 'li');
  assert.equal(findAll(row, (n) => n.type === 'button').length, 2);
});

test('archive row buttons call restore and delete handlers with the Work', () => {
  const calls = [];
  const w = work('a', '2026-10-01T00:00:00Z');
  const row = callComponent(archiveModule.ArchiveRow, {
    work: w, projectName: null, locale: 'en', t, onRestore: (x) => calls.push(['restore', x.id]), onDelete: (x) => calls.push(['delete', x.id]),
  });
  buttonWith(row, 'Restore').props.onClick();
  buttonWith(row, 'Delete').props.onClick();
  assert.deepEqual(calls, [['restore', 'a'], ['delete', 'a']]);
});

test('restoring an archived Work calls the unarchive operation for that Work', async () => {
  removeCalls.length = 0;
  await archiveModule.restoreArchivedWork(work('a', '2026-10-01T00:00:00Z'));
  assert.deepEqual(removeCalls, [{ ids: ['a'], kind: 'unarchive' }]);
});

test('archive list keeps rows without archived_at and shows number and project at every width', () => {
  const view = readFileSync(join(repoRoot, 'apps/web/components/ArchiveView.tsx'), 'utf8');
  assert.doesNotMatch(view, /&& w\.archived_at/u);
  const css = readFileSync(join(repoRoot, 'apps/web/app/globals.css'), 'utf8');
  const narrow = css.slice(css.indexOf('/* ---- archive list'));
  assert.doesNotMatch(narrow, /archive-row__(number|project)[^{]*\{[^}]*display:\s*none/u);
});

test('deleting an archived Work runs only after the confirmation is accepted', async () => {
  removeCalls.length = 0;
  const w = work('a', '2026-10-01T00:00:00Z');
  const prompts = [];
  globalThis.window = { confirm: (message) => { prompts.push(message); return confirmAnswer; } };
  try {
    confirmAnswer = false;
    assert.equal(await archiveModule.deleteArchivedWork(w, t), false);
    assert.equal(removeCalls.length, 0, 'declining must not delete');
    confirmAnswer = true;
    assert.equal(await archiveModule.deleteArchivedWork(w, t), true);
    assert.deepEqual(removeCalls, [{ ids: ['a'], kind: 'delete' }]);
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /Permanently delete Work a/u);
  } finally {
    delete globalThis.window;
  }
});

test('archive list shows an error when project names failed to load, and a plain empty state otherwise', () => {
  viewData = { works: [] };
  try {
    // useState order: fallbackProjects, projectsFailed
    slots = [new Map(), 'projects down'];
    const failed = textOf(callComponent(archiveModule.ArchiveView, {}));
    assert.ok(failed.includes('archive.projectsLoadError: projects down'));
    assert.ok(failed.includes('archive.empty'), 'the list itself stays visible');
    slots = [];
    const empty = textOf(callComponent(archiveModule.ArchiveView, {}));
    assert.ok(empty.includes('archive.empty'));
    assert.ok(!empty.includes('archive.projectsLoadError'));
  } finally {
    viewData = undefined;
  }
});

test('ja and en define the same archive/work i18n keys used by the archive list', () => {
  const load = (lang) => JSON.parse(readFileSync(join(repoRoot, `apps/web/lib/i18n/${lang}.json`), 'utf8'));
  const ja = load('ja');
  const en = load('en');
  for (const [group, keys] of [
    ['archive', ['subtitle', 'empty', 'noProject', 'deleteConfirm', 'projectsLoadError']],
    ['work', ['archiveAllInSection', 'archiveAllConfirm', 'unarchiveShort', 'delete']],
  ]) {
    for (const key of keys) {
      assert.equal(typeof ja[group][key], 'string', `ja ${group}.${key}`);
      assert.equal(typeof en[group][key], 'string', `en ${group}.${key}`);
    }
  }
  assert.equal(ja.work.deleteAllInSection, undefined);
  assert.equal(en.work.deleteAllInSection, undefined);
});
