import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fakeFetch, loadApiClient } from '../helpers/web-api-client.mjs';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const work = (id) => ({ id, title: id, state: 'running', project_id: null });
const decision = { id: 'D1', work_id: 'W1', status: 'open', blocked_task_ids: [] };

const views = {
  getBoard: ['/api/v1/board/view', () => [], { works: [work('W1')], open_decisions: [], projects: [], next_cursor: null }],
  getWorkDetail: ['/api/v1/works/W1/view', () => ['W1'], { work: work('W1'), tasks: [], runs: [], child_runs: [], reports: [], decisions: [], messages: [] }],
  getDecision: ['/api/v1/decisions/D1/view', () => ['D1'], { decision, work: work('W1'), blocked_tasks: [] }],
  getBacklogView: ['/api/v1/backlog/view', () => [], { items: [], next_offset: null, projects: [] }],
  listLinkableWorks: ['/api/v1/backlog/linkable-works', () => [null], { works: [], next_cursor: null }],
  getTokensView: ['/api/v1/tokens/view', () => ['7d'], { report: {}, plan_usage: {}, plan_usage_settings: {}, projects: [] }],
  getSettingsView: ['/api/v1/settings/view', () => [], { models: {} }],
  getAgents: ['/api/v1/agents/view', () => [], { running: [], recent: [], children: [], idle_threshold_seconds: 60 }],
};

async function withFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = fakeFetch((url, init) => {
    requests.push({ path: url.pathname, search: url.searchParams, headers: new Headers(init.headers) });
    return handler(url, init, requests.length);
  });
  try {
    await run(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

for (const [name, [path, args, data]] of Object.entries(views)) {
  test(`${name} makes exactly one request to its screen view API`, async () => {
    const client = loadApiClient();
    await withFetch(() => json({ request_id: 'r', data, version: 1 }), async (requests) => {
      await client[name](...args());
      assert.equal(requests.length, 1);
      assert.equal(requests[0].path, path);
    });
  });
}

test('requestView sends If-None-Match, returns not_modified on 304 and data/version/etag on 200', async () => {
  const { requestView } = loadApiClient();
  await withFetch((url, init) => {
    if (new Headers(init.headers).get('If-None-Match') === 'W/"a"') return new Response(null, { status: 304 });
    return json({ request_id: 'r', data: { n: 1 }, version: 3 }, 200, { etag: 'W/"b"' });
  }, async (requests) => {
    assert.deepEqual(await requestView('/board/view', 'W/"a"'), { kind: 'not_modified' });
    assert.equal(requests[0].headers.get('If-None-Match'), 'W/"a"');
    assert.deepEqual(await requestView('/board/view'), { kind: 'fresh', value: { data: { n: 1 }, version: 3, etag: 'W/"b"' } });
    assert.equal(requests[1].headers.get('If-None-Match'), null);
  });
});

test('getBoard and listLinkableWorks follow next_cursor and join pages without overlap', async () => {
  const { getBoard, listLinkableWorks } = loadApiClient();
  await withFetch((url) => {
    const second = url.searchParams.get('cursor') === 'c1';
    const board = url.pathname.endsWith('/board/view');
    const works = second ? [work('W2'), work('W3')] : [work('W1'), work('W2')];
    const page = { works, next_cursor: second ? null : 'c1', ...(board ? { open_decisions: [], projects: [] } : {}) };
    return json({ request_id: 'r', data: page, version: 1 });
  }, async (requests) => {
    assert.deepEqual((await getBoard()).works.map((w) => w.id), ['W1', 'W2', 'W3']);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].search.get('cursor'), 'c1');
    assert.deepEqual((await listLinkableWorks(null)).map((w) => w.id), ['W1', 'W2', 'W3']);
    assert.equal(requests.length, 4);
    assert.equal(requests[3].search.get('cursor'), 'c1');
  });
});

test('getBoard without next_cursor stops after one request', async () => {
  const { getBoard } = loadApiClient();
  await withFetch(() => json({ request_id: 'r', data: { ...views.getBoard[2] }, version: 1 }), async (requests) => {
    await getBoard({ archived: 'only' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].search.get('archived'), 'only');
  });
});

test('getWorkDetail returns the view decisions and reports as given, and null on 404; getDecision null on 404', async () => {
  const { getWorkDetail, getDecision } = loadApiClient();
  const view = { work: work('W1'), tasks: [], runs: [], child_runs: [], reports: [{ id: 'R1' }], decisions: [decision], messages: [] };
  await withFetch(() => json({ request_id: 'r', data: view, version: 1 }), async () => {
    const detail = await getWorkDetail('W1');
    assert.deepEqual(detail.decisions, [decision]);
    assert.deepEqual(detail.reports, [{ id: 'R1' }]);
  });
  const notFound = () => json({ request_id: 'r', error: { code: 'not_found', message: 'no' } }, 404);
  await withFetch(notFound, async () => {
    assert.equal(await getWorkDetail('W1'), null);
  });
  await withFetch(notFound, async () => {
    assert.equal(await getDecision('D1'), null);
  });
});

test('api-client no longer defines listDecisions or reportsForTasks', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { repoRoot } = await import('../helpers/paths.mjs');
  assert.doesNotMatch(readFileSync(join(repoRoot, 'apps/web/lib/api-client.ts'), 'utf8'), /listDecisions|reportsForTasks/);
});

test('subscribeToUpdates hands the event frame to onUpdate', async () => {
  const { subscribeToUpdates } = loadApiClient();
  const sockets = [];
  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() { sockets.push(this); }
    send(message) { this.sent.push(message); }
    close() {}
  }
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  globalThis.window = { location: { protocol: 'http:', host: 'owl.test' } };
  const frame = { kind: 'event', event_id: 'E1', sequence: 1, cursor: 'k1', schema_version: '1.0.0', type: 'work.updated', payload: {} };
  try {
    await withFetch(() => json({}), async () => {
      const received = [];
      const stop = subscribeToUpdates([], (event) => received.push(event), () => {});
      for (let i = 0; i < 50 && sockets.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      sockets[0].onmessage({ data: JSON.stringify(frame) });
      stop();
      assert.deepEqual(received, [frame]);
    });
  } finally {
    globalThis.WebSocket = originalSocket;
    delete globalThis.window;
  }
});
