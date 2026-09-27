import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = join(repoRoot, 'apps/web/lib/work-removal.ts');
const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
const React = webRequire('react');

function loadWorkRemovalModule(getWorkBranchStatus = async () => 'absent') {
  const source = readFileSync(modulePath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(modulePath);
  loaded.filename = modulePath;
  loaded.paths = Module._nodeModulePaths(dirname(modulePath));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'react') return React;
    if (request === '@/lib/api-client') {
      // The default singleton wires the real API; unit tests always inject their own.
      return {
        archiveWork: async () => {},
        unarchiveWork: async () => {},
        deleteWork: async () => {},
        getWorkBranchStatus,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, modulePath);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports;
}

const { confirmDeleteIfUnmerged, createWorkRemovalStore } = loadWorkRemovalModule();

function work(id, overrides = {}) {
  return { id, title: `Work ${id}`, state_version: 1, archived_at: null, ...overrides };
}

function fakeApi() {
  const calls = [];
  return {
    calls,
    archiveWork: async (id, version) => { calls.push(['archive', id, version]); },
    unarchiveWork: async (id, version) => { calls.push(['unarchive', id, version]); },
    deleteWork: async (id, version) => { calls.push(['delete', id, version]); },
  };
}

test('removeWorks hides ids immediately for delete/archive but not for unarchive', async () => {
  const api = fakeApi();
  const store = createWorkRemovalStore({ api });

  const pending = store.removeWorks([work('a'), work('b')], 'delete');
  assert.deepEqual([...store.getSnapshot().hiddenIds].sort(), ['a', 'b'], 'delete hides immediately, before the API resolves');
  await pending;

  await store.removeWorks([work('c')], 'archive');
  assert.ok(store.getSnapshot().hiddenIds.has('c'));

  await store.removeWorks([work('d')], 'unarchive');
  assert.equal(store.getSnapshot().hiddenIds.has('d'), false, 'unarchive never hides the card');
});

test('a delete archives an unarchived work first, then deletes; an archived work is only deleted', async () => {
  const api = fakeApi();
  const store = createWorkRemovalStore({ api });

  await store.removeWorks([work('unarchived', { archived_at: null, state_version: 3 })], 'delete');
  assert.deepEqual(api.calls, [['archive', 'unarchived', 3], ['delete', 'unarchived', 3]]);

  api.calls.length = 0;
  await store.removeWorks([work('archived', { archived_at: '2026-01-01T00:00:00Z', state_version: 5 })], 'delete');
  assert.deepEqual(api.calls, [['delete', 'archived', 5]]);
});

test('a failed delete of an unarchived work takes it back out of the archive', async () => {
  const api = fakeApi();
  api.deleteWork = async (id, version) => {
    api.calls.push(['delete', id, version]);
    throw new Error('boom');
  };
  const store = createWorkRemovalStore({ api });

  const ok = await store.removeWorks([work('a', { archived_at: null, state_version: 2 })], 'delete');

  assert.equal(ok, false);
  assert.deepEqual(api.calls, [['archive', 'a', 2], ['delete', 'a', 2], ['unarchive', 'a', 2]]);
  assert.equal(store.getSnapshot().hiddenIds.has('a'), false);
  assert.ok(store.getSnapshot().error);
});

test('a failed removal un-hides its ids and surfaces a transient error', async () => {
  const api = fakeApi();
  api.deleteWork = async () => { throw new Error('boom'); };
  const store = createWorkRemovalStore({ api });

  await store.removeWorks([work('a', { archived_at: '2026-01-01T00:00:00Z' })], 'delete');

  assert.equal(store.getSnapshot().hiddenIds.has('a'), false, 'a failed removal should reappear on the board');
  assert.ok(store.getSnapshot().error, 'a failed removal should surface an error');

  store.dismissError();
  assert.equal(store.getSnapshot().error, null);
});

test('a mixed-success batch only un-hides the works that failed', async () => {
  const api = fakeApi();
  api.archiveWork = async (id, version) => {
    if (id === 'bad') throw new Error('boom');
    api.calls.push(['archive', id, version]);
  };
  const store = createWorkRemovalStore({ api });

  await store.removeWorks([work('good'), work('bad')], 'archive');

  assert.equal(store.getSnapshot().hiddenIds.has('good'), true);
  assert.equal(store.getSnapshot().hiddenIds.has('bad'), false);
  assert.ok(store.getSnapshot().error);
});

test('an archived work can be revealed again once the board reflects it', async () => {
  const store = createWorkRemovalStore({ api: fakeApi() });

  await store.removeWorks([work('a')], 'archive');
  assert.equal(store.getSnapshot().hiddenIds.has('a'), true);

  store.reveal('a');
  assert.equal(store.getSnapshot().hiddenIds.has('a'), false);
});

test('cancelled delete confirmation leaves the Work visible and does not call the delete API', async () => {
  const api = fakeApi();
  const store = createWorkRemovalStore({ api });

  const removed = await store.removeWorks([work('unmerged')], 'delete', async () => false);

  assert.equal(removed, false);
  assert.equal(store.getSnapshot().hiddenIds.has('unmerged'), false);
  assert.deepEqual(api.calls, []);
});

test('unmerged changes require explicit confirmation before deletion', async () => {
  const originalWindow = globalThis.window;
  const prompts = [];
  globalThis.window = { confirm: (message) => { prompts.push(message); return false; } };
  try {
    const removal = loadWorkRemovalModule(async () => 'present');
    const confirmed = await removal.confirmDeleteIfUnmerged([work('unmerged')], (key) => key);

    assert.equal(confirmed, false);
    assert.deepEqual(prompts, ['work.deleteUnmergedConfirm']);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('a failed or unknown branch status still asks for confirmation before bulk deletion', async () => {
  const originalWindow = globalThis.window;
  const prompts = [];
  globalThis.window = { confirm: (message) => { prompts.push(message); return true; } };
  try {
    const statuses = {
      clean: 'absent',
      unmerged: 'present',
      unknown: 'unknown',
    };
    const removal = loadWorkRemovalModule(async (id) => {
      if (id === 'offline') throw new Error('network down');
      return statuses[id];
    });
    const t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);

    const confirmed = await removal.confirmDeleteIfUnmerged(
      [work('clean'), work('unmerged'), work('unknown'), work('offline')],
      t,
    );

    assert.equal(confirmed, true);
    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0].split('\n'), ['work.deleteUnmergedConfirm', 'work.deleteUnmergedUnknownConfirm:{"count":"2"}']);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('Works whose branches are all merged are deleted without a prompt', async () => {
  const originalWindow = globalThis.window;
  const prompts = [];
  globalThis.window = { confirm: (message) => { prompts.push(message); return false; } };
  try {
    const removal = loadWorkRemovalModule();
    assert.equal(await removal.confirmDeleteIfUnmerged([work('a'), work('b')], (key) => key), true);
    assert.deepEqual(prompts, []);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
