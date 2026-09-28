import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Module } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
