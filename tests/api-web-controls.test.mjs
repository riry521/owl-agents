import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire, Module } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import { createCore as createMemoryCore } from '../apps/server/dist/core.js';
import { createOwlHttpServer } from '../apps/server/dist/http.js';

import {
  asReportEnvelope,
  humanizeWorkDetailError,
  normalizeWorkDetailData,
  workDetailHref,
} from '../apps/web/lib/work-detail-safety.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');

// Hooks are driven by a tiny deterministic harness so a single render shows a chosen state.
let hookState = [];
let hookIndex = 0;
const componentReact = {
  ...React,
  useState: (initial) => {
    const index = hookIndex++;
    if (index >= hookState.length) hookState[index] = initial;
    return [hookState[index], (next) => {
      hookState[index] = typeof next === 'function' ? next(hookState[index]) : next;
    }];
  },
  useEffect: () => {},
  useCallback: (callback) => callback,
  useRef: (value) => ({ current: value }),
};

const en = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8'));
const ja = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8'));
function translate(key, values = {}) {
  const value = key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), en);
  if (typeof value !== 'string') return key;
  return value.replace(/\{\{(\w+)\}\}/gu, (_, name) => values[name] ?? '');
}

function compile(modulePath, overrides, transpile = { jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }) {
  const source = readFileSync(modulePath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { ...transpile, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(modulePath);
  loaded.filename = modulePath;
  loaded.paths = Module._nodeModulePaths(dirname(modulePath));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'react') return componentReact;
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

const apiCalls = [];
const apiClient = {
  getWorkDetail: async () => null,
  getDecision: async () => null,
  answerDecision: async () => ({}),
  startWork: async (...args) => { apiCalls.push(['startWork', ...args]); return {}; },
  pauseWork: async (...args) => { apiCalls.push(['pauseWork', ...args]); return {}; },
  resumeWork: async (...args) => { apiCalls.push(['resumeWork', ...args]); return {}; },
  cancelWork: async (...args) => { apiCalls.push(['cancelWork', ...args]); return {}; },
  reopenWork: async (...args) => { apiCalls.push(['reopenWork', ...args]); return {}; },
  subscribeToUpdates: () => () => {},
};
const i18n = { useLocale: () => ({ locale: 'en', t: translate }) };
const link = { __esModule: true, default: ({ href, children, ...props }) => React.createElement('a', { ...props, href }, children) };
const badges = {
  ResultBadge: () => null,
  TaskStateBadge: () => null,
  WorkStateBadge: ({ state }) => React.createElement('span', null, state),
};
const format = {
  taskStateLabels: () => ({}),
  safeEnumLabel: (_labels, value) => String(value),
  asReportEnvelope,
  formatAgentLabel: () => 'Agent',
  formatRelative: () => 'just now',
  roleDisplayName: (role) => role,
  runOrdinals: () => new Map(),
  workDisplayNumber: () => null,
};
const workRemoval = { removeWorks: async () => {} };
const icons = {
  TrashIcon: () => null,
  ArchiveBoxIcon: () => null,
  RestoreIcon: () => null,
};

test('MemoryCore filters taskless descendant runs by Work', async () => {
  const core = createMemoryCore({ version: 'test' });
  const createWork = async (title) => (await core.createWork(
    { title, summary: '', size: 'small', project_id: null },
    { request_id: title, idempotency_key: title, expected_version: 0 },
  )).data.work_id;
  const workA = await createWork('Work A');
  const workB = await createWork('Work B');
  core.works.get(workA).tasks.push('task-a');
  core.works.get(workB).tasks.push('task-b');
  const run = (id, task_id, parent_agent_id = null) => ({
    id, task_id, parent_agent_id, role: 'worker', provider: 'test', model: 'test', status: 'completed',
    pid: null, started_at: null, ended_at: null, phase: null, subtask_count: null, label: null, origin: null,
  });
  for (const agent of [
    run('root-a', 'task-a'),
    run('manager-a', null, 'root-a'),
    run('child-a', null, 'manager-a'),
    run('root-b', 'task-b'),
    run('manager-b', null, 'root-b'),
  ]) core.agents.set(agent.id, agent);

  const query = { status: null, limit: 100, cursor: null };
  assert.deepEqual((await core.listAgents({ ...query, work_id: workA })).data.map((agent) => agent.id), ['root-a', 'manager-a', 'child-a']);
  assert.deepEqual((await core.listAgents({ ...query, work_id: workB })).data.map((agent) => agent.id), ['root-b', 'manager-b']);
});

test('GET /agents?work_id= includes taskless descendants of the Work', async (t) => {
  const core = createMemoryCore({ version: 'test' });
  const createWork = async (title) => (await core.createWork(
    { title, summary: '', size: 'small', project_id: null },
    { request_id: title, idempotency_key: title, expected_version: 0 },
  )).data.work_id;
  const workA = await createWork('Work A');
  const workB = await createWork('Work B');
  core.works.get(workA).tasks.push('task-a');
  core.works.get(workB).tasks.push('task-b');

  const run = (id, task_id, parent_agent_id = null, role = 'worker') => ({
    id, task_id, parent_agent_id, role, provider: 'test', model: 'test', status: 'completed',
    pid: null, started_at: null, ended_at: null, phase: null, subtask_count: null, label: null, origin: null,
  });
  for (const agent of [
    run('root-a', 'task-a'),
    run('manager-a', null, 'root-a', 'manager'),
    run('child-a', null, 'manager-a', 'executor'),
    run('root-b', 'task-b'),
    run('manager-b', null, 'root-b', 'manager'),
    run('orphan-manager', null, null, 'manager'),
    run('orphan-child', null, 'orphan-manager', 'executor'),
  ]) core.agents.set(agent.id, agent);

  const root = await mkdtemp(join(tmpdir(), 'owl-api-web-controls-'));
  const originalToken = process.env.OWL_API_TOKEN;
  const token = 'api-web-controls-test-token';
  process.env.OWL_API_TOKEN = token;
  const http = createOwlHttpServer({
    core,
    webOut: root,
    bind: '127.0.0.1',
    port: 0,
    contract: { contract_version: '1.0.0' },
    owlRoot: root,
  });
  let listening = false;
  t.after(async () => {
    if (listening) await http.close();
    await rm(root, { recursive: true, force: true });
    if (originalToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = originalToken;
  });
  await http.listen();
  listening = true;

  const base = 'http://127.0.0.1:' + http.server.address().port + '/api/v1/agents?work_id=';
  const list = async (workId) => {
    const response = await fetch(base + encodeURIComponent(workId), { headers: { authorization: 'Bearer ' + token } });
    assert.equal(response.status, 200);
    return (await response.json()).data.map((agent) => agent.id);
  };
  assert.deepEqual(await list(workA), ['root-a', 'manager-a', 'child-a']);
  assert.deepEqual(await list(workB), ['root-b', 'manager-b']);
});

test('static extensionless page routes work when the web output path has a dotted parent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'owl-api-web-controls.static.'));
  const webOut = join(root, 'out');
  await mkdir(webOut);
  await writeFile(join(webOut, 'backlog.html'), '<main>Backlog page</main>');
  const core = createMemoryCore({ version: 'test' });
  const http = createOwlHttpServer({
    core,
    webOut,
    bind: '127.0.0.1',
    port: 0,
    contract: { contract_version: '1.0.0' },
    owlRoot: root,
  });
  let listening = false;
  t.after(async () => {
    if (listening) await http.close();
    await rm(root, { recursive: true, force: true });
  });
  await http.listen();
  listening = true;

  const response = await fetch(`http://127.0.0.1:${http.server.address().port}/owl/backlog`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<main>Backlog page</main>');
});

const archiveActions = compile(join(repoRoot, 'apps/web/components/WorkArchiveActions.tsx'), {
  '@/lib/api-client': apiClient,
  '@/lib/i18n': i18n,
  '@/lib/work-removal': workRemoval,
  '@/components/icons': icons,
});

const { WorkDetailView } = compile(join(repoRoot, 'apps/web/components/WorkDetailView.tsx'), {
  'next/link': link,
  'next/navigation': {
    useRouter: () => ({ replace: () => {} }),
    useSearchParams: () => new URLSearchParams('id=01J00000000000000000000000'),
  },
  '@/lib/api-client': apiClient,
  '@/lib/format': format,
  '@/components/StateBadge': badges,
  '@/components/WorkArchiveActions': archiveActions,
  '@/components/DesignDocumentsSection': { DesignDocumentsSection: () => null },
  '@/components/WorkBacklogSection': { WorkBacklogSection: () => null },
  '@/lib/i18n': i18n,
  '@/lib/work-detail-safety.mjs': { asReportEnvelope, humanizeWorkDetailError, normalizeWorkDetailData },
  '@/components/WorkSummaryBlock': compile(join(repoRoot, 'apps/web/components/WorkSummaryBlock.tsx'), { '@/lib/i18n': i18n }),
});
const { DecisionView } = compile(join(repoRoot, 'apps/web/components/DecisionView.tsx'), {
  'next/link': link,
  'next/navigation': { useSearchParams: () => new URLSearchParams('id=01J00000000000000000000009') },
  '@/lib/api-client': apiClient,
  '@/lib/format': format,
  '@/components/StateBadge': badges,
  '@/lib/i18n': i18n,
});

function renderWith(Component, state) {
  hookState = [...state];
  hookIndex = 0;
  const html = renderToStaticMarkup(React.createElement(Component));
  hookIndex = 0;
  const tree = Component({});
  return { html, tree };
}

/** Collect intrinsic <button> elements from an unrendered element tree (function components are expanded). */
function buttons(node, found = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return found;
  if (Array.isArray(node)) {
    for (const child of node) buttons(child, found);
    return found;
  }
  if (typeof node !== 'object') return found;
  if (typeof node.type === 'function') {
    return buttons(node.type(node.props), found);
  }
  if (node.type === 'button') found.push(node);
  buttons(node.props?.children, found);
  return found;
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}

function workDetailState(state, size = 'normal') {
  const data = normalizeWorkDetailData({
    work: {
      id: '01J00000000000000000000000',
      title: `Work ${state}`,
      state,
      state_version: 3,
      updated_at: '2026-09-23T00:00:00.000Z',
      owner_id: 'owner:default',
      project_id: null,
      summary: 'summary',
      size,
      plan_revision: 0,
    },
  }, '01J00000000000000000000000');
  // data, now, loadError, realtimeStatus, retryCount, operationPending, operationError
  return [data, 0, null, 'connected', 0, false, null];
}

function workButtons(state, size) {
  const { html, tree } = renderWith(WorkDetailView, workDetailState(state, size));
  const list = buttons(tree);
  return { html, byLabel: new Map(list.map((button) => [textOf(button.props.children), button])) };
}

test('Work detail offers Start for memo/ready Works and starts with the Work version and size mode', async () => {
  for (const [state, size, mode] of [['memo', 'small', 'small'], ['ready', 'normal', 'normal'], ['memo', 'large', 'normal']]) {
    apiCalls.length = 0;
    const { byLabel } = workButtons(state, size);
    const start = byLabel.get(en.work.start);
    assert.ok(start, `${state} Work should show a Start button`);
    assert.equal(byLabel.has(en.work.abort), false);
    start.props.onClick();
    await new Promise((resolveNext) => setImmediate(resolveNext));
    assert.deepEqual(apiCalls, [['startWork', '01J00000000000000000000000', 3, mode]]);
  }
});

test('Work detail allows cancelling a judgement_waiting Work', async () => {
  apiCalls.length = 0;
  const { byLabel } = workButtons('judgement_waiting');
  assert.ok(byLabel.get(en.work.abort));
  assert.equal(byLabel.has(en.work.pause), false);
  assert.equal(byLabel.has(en.work.resume), false);
  const originalWindow = globalThis.window;
  globalThis.window = { confirm: () => true };
  try {
    byLabel.get(en.work.abort).props.onClick();
  } finally {
    globalThis.window = originalWindow;
  }
  await new Promise((resolveNext) => setImmediate(resolveNext));
  assert.deepEqual(apiCalls, [['cancelWork', '01J00000000000000000000000', 3, en.work.abortReason]]);
});

test('Work detail offers Reopen for completed Works only', async () => {
  apiCalls.length = 0;
  const completed = workButtons('completed');
  const reopen = completed.byLabel.get(en.work.reopen);
  assert.ok(reopen);
  assert.equal(completed.byLabel.has(en.work.abort), false);
  reopen.props.onClick();
  await new Promise((resolveNext) => setImmediate(resolveNext));
  assert.deepEqual(apiCalls, [['reopenWork', '01J00000000000000000000000', 3, en.work.reopenReason]]);
  for (const state of ['running', 'cancelled', 'memo']) {
    assert.equal(workButtons(state).byLabel.has(en.work.reopen), false, state);
  }
  const cancelled = workButtons('cancelled').byLabel;
  assert.ok(cancelled.has(en.work.archive));
  assert.ok(cancelled.has(en.work.delete));
});

test('English and Japanese define the new Work and Decision strings', () => {
  for (const key of ['start', 'reopen', 'reopenReason']) {
    assert.equal(typeof en.work[key], 'string', `en work.${key}`);
    assert.equal(typeof ja.work[key], 'string', `ja work.${key}`);
  }
  for (const key of ['noOptions', 'freeTextOnlyHint']) {
    assert.equal(typeof en.decision[key], 'string', `en decision.${key}`);
    assert.equal(typeof ja.decision[key], 'string', `ja decision.${key}`);
  }
});

function decisionState({ allowFreeText, options }) {
  const data = {
    decision: {
      id: '01J00000000000000000000009',
      work_id: '01J00000000000000000000000',
      scope: 'work',
      status: 'open',
      reason: 'The Work stopped',
      question: 'Pick one',
      current_state: 'Waiting',
      tried: 'Nothing yet',
      options,
      recommended: options[0]?.key ?? null,
      allow_free_text: allowFreeText,
      blocked_task_ids: [],
      state_version: 1,
    },
    work: { id: '01J00000000000000000000000', title: 'Work' },
    blocked_tasks: [],
  };
  // data, freeText, busy, result, error, loadError
  return [data, '', false, null, null, null];
}

test('Decision hides the free-text form when allow_free_text is false', () => {
  const options = [{ key: 'a', label: 'Option A' }, { key: 'b', label: 'Option B' }];
  const closed = renderWith(DecisionView, decisionState({ allowFreeText: false, options })).html;
  assert.doesNotMatch(closed, /<textarea/u);
  assert.doesNotMatch(closed, new RegExp(en.decision.freeTextSubmit));
  assert.match(closed, /Option A/u);

  const open = renderWith(DecisionView, decisionState({ allowFreeText: true, options })).html;
  assert.match(open, /<textarea/u);
});

test('Decision shows a hint when there are no options', () => {
  const freeOnly = renderWith(DecisionView, decisionState({ allowFreeText: true, options: [] })).html;
  assert.match(freeOnly, new RegExp(en.decision.freeTextOnlyHint.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.match(freeOnly, /<textarea/u);

  const none = renderWith(DecisionView, decisionState({ allowFreeText: false, options: [] })).html;
  assert.match(none, new RegExp(en.decision.noOptions.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.doesNotMatch(none, /<textarea/u);
});

function loadApiClient() {
  const apiClientPath = join(repoRoot, 'apps/web/lib/api-client.ts');
  return compile(apiClientPath, {
    '@/lib/format': { runOrdinals: () => new Map() },
    '@/lib/work-detail-safety.mjs': { asReportEnvelope, humanizeWorkDetailError, normalizeWorkDetailData, workDetailHref },
  }, {});
}

test('api-client asks for the newest events and exposes reopenWork', async () => {
  const client = loadApiClient();
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input), 'http://owl.test');
      if (url.pathname === '/api/v1/runtime-config.json') {
        return new Response(JSON.stringify({ base_path: '/owl/', api_base: '/api/v1', ws_url: '/api/v1/ws', schema_version: '1.0.0' }), { headers: { 'content-type': 'application/json' } });
      }
      requests.push({ path: url.pathname, search: Object.fromEntries(url.searchParams), method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body });
      if (url.pathname === '/api/v1/events') {
        return new Response(JSON.stringify({ request_id: 'r', data: { events: [{ event_id: 'e2', sequence: 2 }, { event_id: 'e1', sequence: 1 }], cursor: '1', has_more: false } }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ request_id: 'r', data: { work_id: 'w', state: 'running' }, version: 4 }), { headers: { 'content-type': 'application/json' } });
    };
    const events = await client.listEvents(100);
    assert.deepEqual(events.map((event) => event.event_id), ['e2', 'e1']);
    assert.deepEqual(requests[0].search, { order: 'desc', limit: '100' });

    await client.reopenWork('01J00000000000000000000000', 3, 'Reopened');
    const reopen = requests[1];
    assert.equal(reopen.path, '/api/v1/works/01J00000000000000000000000/reopen');
    assert.equal(reopen.method, 'POST');
    assert.equal(reopen.headers.get('content-type'), 'application/json');
    const body = JSON.parse(reopen.body);
    assert.equal(body.expected_version, 3);
    assert.deepEqual(body.payload, { reason: 'Reopened' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Decision shows why it stopped, what to decide, and what each option does', () => {
  const options = [
    { key: 'retry', label: 'Fix it', description: 'The Manager plans the fix.' },
    { key: 'cancel', label: 'Stop', description: 'The Work is cancelled.' },
  ];
  const { html } = renderWith(DecisionView, decisionState({ allowFreeText: true, options }));
  const order = [en.decision.why, 'The Work stopped', en.decision.question, 'Pick one', en.decision.options,
    'Fix it', 'The Manager plans the fix.', 'Stop', 'The Work is cancelled.', en.decision.currentState, 'Waiting', en.decision.tried, 'Nothing yet'];
  let at = -1;
  for (const part of order) {
    const next = html.indexOf(part, at + 1);
    assert.ok(next > at, `${part} should follow the previous template section`);
    at = next;
  }
  assert.equal(html.split(en.decision.choose).length - 1, 2, 'each option has its own answer button');
});
