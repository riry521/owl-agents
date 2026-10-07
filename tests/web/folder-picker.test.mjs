import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import { repoRoot } from '../helpers/paths.mjs';
const apiClientPath = join(repoRoot, 'apps/web/lib/api-client.ts');
const dialogPath = join(repoRoot, 'apps/web/components/FolderPickerDialog.tsx');

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

test('listDirectories GETs /fs/directories with path and show_hidden encoded, omitted when not given, and unwraps data', async () => {
  const { listDirectories } = loadApiClient();
  const data = {
    path: '/Users/x',
    parent: '/Users',
    entries: [{ name: 'Documents', path: '/Users/x/Documents' }],
    truncated: false,
    shortcuts: [{ key: 'home', path: '/Users/x' }],
  };
  const seenUrls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch({
    '/api/v1/fs/directories': (url) => {
      seenUrls.push(url.search);
      return new Response(JSON.stringify({ request_id: 'r1', data, version: 1 }), { status: 200 });
    },
  });
  try {
    const noArgs = await listDirectories();
    assert.equal(seenUrls[0], '', 'no args should omit both query params');
    assert.deepEqual(noArgs, data);

    await listDirectories('/Users/x with space');
    assert.equal(seenUrls[1], '?path=%2FUsers%2Fx+with+space', 'path alone should be URL-encoded and show_hidden omitted');

    await listDirectories('/Users/x', true);
    assert.equal(seenUrls[2], '?path=%2FUsers%2Fx&show_hidden=1');

    await listDirectories(undefined, false);
    assert.equal(seenUrls[3], '?show_hidden=0', 'an explicit false still encodes show_hidden=0, but path stays omitted');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---- FolderPickerDialog component -----------------------------------------
//
// Compiled the same way tests/web-advisor-folders.test.mjs compiles
// AdvisorFoldersSection: transpile with the real TS compiler, patch the JSX
// runtime to capture the elements we care about, and drive React hooks with
// a tiny harness instead of a full renderer.

const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const realJsxRuntime = webRequire('react/jsx-runtime');

let capturedEntryButtons = [];
let capturedUpButton = null;
let capturedUseButton = null;

function wrapJsx(originalJsx) {
  return function patchedJsx(type, props, ...rest) {
    if (type === 'button' && props?.className === 'folder-picker__item') capturedEntryButtons.push(props);
    if (type === 'button' && props?.className === 'btn folder-picker__up') capturedUpButton = props;
    if (type === 'button' && props?.className === 'btn btn--primary folder-picker__use') capturedUseButton = props;
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

function compileFolderPickerDialog(overrides) {
  const source = readFileSync(dialogPath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const loaded = new Module(dialogPath);
  loaded.filename = dialogPath;
  loaded.paths = Module._nodeModulePaths(dirname(dialogPath));

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
    loaded._compile(outputText, dialogPath);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports;
}

// FolderPickerDialog's useState() calls, in declaration order:
// listing, loading, error, showHidden.
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

function renderFolderPicker(state, props, apiClientOverrides) {
  capturedEntryButtons = [];
  capturedUpButton = null;
  capturedUseButton = null;
  const harness = createHookHarness(state);
  const module = compileFolderPickerDialog({
    harness,
    modules: {
      '@/lib/api-client': {
        listDirectories: async () => ({ path: '/', parent: null, entries: [], truncated: false, shortcuts: [] }),
        ApiRequestError: class ApiRequestError extends Error {
          constructor(code, rawMessage, status) {
            super(code);
            this.code = code;
            this.rawMessage = rawMessage;
            this.status = status;
          }
        },
        ...apiClientOverrides,
      },
      '@/lib/settings-errors': { humanizeError: () => 'ERROR' },
      '@/components/icons': { FolderIcon: () => null },
    },
  });
  renderToStaticMarkup(React.createElement(module.FolderPickerDialog, {
    open: true,
    initialPath: '/Users/x',
    onSelect: () => {},
    onClose: () => {},
    ...props,
  }));
  return { harness, entryButtons: capturedEntryButtons, upButton: capturedUpButton, useButton: capturedUseButton };
}

test('clicking an entry navigates into it', async () => {
  const listing = {
    path: '/Users/x',
    parent: '/Users',
    entries: [
      { name: 'Documents', path: '/Users/x/Documents' },
      { name: 'Desktop', path: '/Users/x/Desktop' },
    ],
    truncated: false,
    shortcuts: [],
  };
  const nested = { path: '/Users/x/Documents', parent: '/Users/x', entries: [], truncated: false, shortcuts: [] };
  // listing=loaded, loading=false, error=null, showHidden=false
  const state = [listing, false, null, false];
  let seenArgs = null;
  const { harness, entryButtons } = renderFolderPicker(state, {}, {
    listDirectories: async (path, hidden) => {
      seenArgs = [path, hidden];
      return nested;
    },
  });

  const docsButton = entryButtons.find((props) => props.title === '/Users/x/Documents');
  assert.ok(docsButton, 'expected a rendered button for the Documents entry');
  await docsButton.onClick();

  assert.deepEqual(seenArgs, ['/Users/x/Documents', false]);
  assert.deepEqual(harness.state[0], nested, 'listing state should be replaced with the navigated-into folder');
});

test('Up navigates to the parent folder', async () => {
  const listing = {
    path: '/Users/x/Documents',
    parent: '/Users/x',
    entries: [],
    truncated: false,
    shortcuts: [],
  };
  const parentListing = { path: '/Users/x', parent: '/Users', entries: [], truncated: false, shortcuts: [] };
  const state = [listing, false, null, false];
  let seenArgs = null;
  const { harness, upButton } = renderFolderPicker(state, {}, {
    listDirectories: async (path, hidden) => {
      seenArgs = [path, hidden];
      return parentListing;
    },
  });

  assert.ok(upButton, 'expected the Up button to render');
  await upButton.onClick();

  assert.deepEqual(seenArgs, ['/Users/x', false]);
  assert.deepEqual(harness.state[0], parentListing);
});

test('"Use this folder" calls onSelect with the current path and closes', () => {
  const listing = { path: '/Users/x/Documents', parent: '/Users/x', entries: [], truncated: false, shortcuts: [] };
  const state = [listing, false, null, false];
  let selected = null;
  let closed = false;
  const { useButton } = renderFolderPicker(state, {
    onSelect: (path) => { selected = path; },
    onClose: () => { closed = true; },
  });

  assert.ok(useButton, 'expected the Use this folder button to render');
  assert.equal(useButton.disabled, false);
  useButton.onClick();

  assert.equal(selected, '/Users/x/Documents');
  assert.ok(closed, 'expected onClose to be called when a folder is chosen');
});

test('English and Japanese define the same folderPicker.* keys', () => {
  const english = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8'));
  const japanese = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8'));
  assert.ok(english.folderPicker, 'expected an English folderPicker section');
  assert.ok(japanese.folderPicker, 'expected a Japanese folderPicker section');
  assert.deepEqual(Object.keys(english.folderPicker).sort(), Object.keys(japanese.folderPicker).sort());
  for (const key of Object.keys(english.folderPicker)) {
    assert.ok(english.folderPicker[key].length > 0, `en folderPicker.${key} should not be empty`);
    assert.ok(japanese.folderPicker[key].length > 0, `ja folderPicker.${key} should not be empty`);
  }
});
