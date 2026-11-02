import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Module } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import { repoRoot } from '../helpers/paths.mjs';

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

async function withFetch(handler, body) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(handler);
  try {
    return await body();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('getAutoWorkSettings GETs the endpoint and merges the envelope version into the data', async () => {
  const { getAutoWorkSettings } = loadApiClient();
  const data = { enabled: { effective: true, from: 'db' }, config_error: null, projects: [] };
  let seen = null;
  await withFetch((url, init) => {
    seen = { path: url.pathname, method: init.method ?? 'GET' };
    return json({ request_id: 'r1', data, version: 4 });
  }, async () => {
    assert.deepEqual(await getAutoWorkSettings(), { ...data, version: 4 });
  });
  assert.deepEqual(seen, { path: '/api/v1/auto-work/settings', method: 'GET' });
});

test('putAutoWorkSettings PUTs the command envelope with the expected version', async () => {
  const { putAutoWorkSettings } = loadApiClient();
  const input = { enabled: false, projects: { p1: { enabled: null } } };
  let seen = null;
  await withFetch((url, init) => {
    seen = { path: url.pathname, method: init.method, body: JSON.parse(init.body) };
    return json({ request_id: 'r2', data: { enabled: { effective: false } }, version: 5 });
  }, async () => {
    assert.deepEqual(await putAutoWorkSettings(input, 4), { enabled: { effective: false }, version: 5 });
  });
  assert.equal(seen.path, '/api/v1/auto-work/settings');
  assert.equal(seen.method, 'PUT');
  assert.deepEqual(seen.body.payload, input);
  assert.equal(seen.body.expected_version, 4);
  assert.equal(typeof seen.body.request_id, 'string');
  assert.equal(typeof seen.body.idempotency_key, 'string');
});

test('putAutoWorkSettings surfaces a version conflict with its code', async () => {
  const { putAutoWorkSettings, ApiRequestError } = loadApiClient();
  await withFetch(
    () => json({ error: { code: 'version_conflict', message: 'stale' } }, 409),
    async () => {
      await assert.rejects(
        () => putAutoWorkSettings({ enabled: true }, 1),
        (error) => {
          assert.ok(error instanceof ApiRequestError);
          assert.equal(error.code, 'version_conflict');
          assert.equal(error.status, 409);
          return true;
        },
      );
    },
  );
});

test('listAutoWorkEvents sends only the filters that are set and returns items with next_offset', async () => {
  const { listAutoWorkEvents } = loadApiClient();
  const page = { items: [{ id: 'e1' }], next_offset: 50 };
  const seen = [];
  await withFetch((url) => {
    seen.push(`${url.pathname}${url.search}`);
    return json({ request_id: 'r3', data: page });
  }, async () => {
    assert.deepEqual(await listAutoWorkEvents({}), page);
    await listAutoWorkEvents({ projectId: 'p1', source: 'github', verdict: 'created', limit: 50, offset: 50 });
  });
  assert.equal(seen[0], '/api/v1/auto-work/events');
  const query = new URL(`http://owl.test${seen[1]}`);
  assert.equal(query.pathname, '/api/v1/auto-work/events');
  assert.equal(query.searchParams.get('project_id'), 'p1');
  assert.equal(query.searchParams.get('source'), 'github');
  assert.equal(query.searchParams.get('verdict'), 'created');
  assert.equal(query.searchParams.get('limit'), '50');
  assert.equal(query.searchParams.get('offset'), '50');
});

test('getAutoWorkEvent GETs one event by id', async () => {
  const { getAutoWorkEvent } = loadApiClient();
  const event = { id: 'e/1', detail: 'body', judge_json: null };
  let seen = null;
  await withFetch((url) => {
    seen = url.pathname;
    return json({ request_id: 'r4', data: event });
  }, async () => {
    assert.deepEqual(await getAutoWorkEvent('e/1'), event);
  });
  assert.equal(seen, '/api/v1/auto-work/events/e%2F1');
});

test('runAutoWorkNow POSTs a bare {what} body and returns the run result', async () => {
  const { runAutoWorkNow } = loadApiClient();
  const result = { project_id: 'p1', what: 'scheduled_check', events: [{ id: 'e1', verdict: 'created' }] };
  let seen = null;
  await withFetch((url, init) => {
    seen = { path: url.pathname, method: init.method, body: JSON.parse(init.body) };
    return json({ request_id: 'r5', data: result });
  }, async () => {
    assert.deepEqual(await runAutoWorkNow('p1', 'scheduled_check'), result);
  });
  assert.equal(seen.path, '/api/v1/auto-work/projects/p1/run');
  assert.equal(seen.method, 'POST');
  assert.deepEqual(seen.body, { what: 'scheduled_check' });
});

test('runAutoWorkNow surfaces the 409 invalid_state returned when the Project is off', async () => {
  const { runAutoWorkNow, ApiRequestError } = loadApiClient();
  await withFetch(
    () => json({ error: { code: 'invalid_state', message: 'Auto work is off for this project.' } }, 409),
    async () => {
      await assert.rejects(
        () => runAutoWorkNow('p1', 'github'),
        (error) => {
          assert.ok(error instanceof ApiRequestError);
          assert.equal(error.code, 'invalid_state');
          assert.equal(error.status, 409);
          return true;
        },
      );
    },
  );
});
