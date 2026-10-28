import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire, Module } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { createCore as createMemoryCore } from '../../apps/server/dist/core.js';
import { startTestHttpServer } from '../helpers/http.mjs';
import { repoRoot } from '../helpers/paths.mjs';
import { tempDir } from '../helpers/temp.mjs';

import {
  asReportEnvelope,
  humanizeWorkDetailError,
  normalizeWorkDetailData,
  workDetailHref,
} from '../../apps/web/lib/work-detail-safety.mjs';
import * as decisionSections from '../../apps/web/lib/decision-sections.mjs';

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
  getWorkCoreActivity: async () => null,
  answerDecision: async (...args) => { apiCalls.push(['answerDecision', ...args]); return { resumed_task_ids: [] }; },
  startWork: async (...args) => { apiCalls.push(['startWork', ...args]); return {}; },
  pauseWork: async (...args) => { apiCalls.push(['pauseWork', ...args]); return {}; },
  resumeWork: async (...args) => { apiCalls.push(['resumeWork', ...args]); return {}; },
  cancelWork: async (...args) => { apiCalls.push(['cancelWork', ...args]); return {}; },
  reopenWork: async (...args) => { apiCalls.push(['reopenWork', ...args]); return {}; },
  subscribeToUpdates: () => () => {},
};
let viewData;
const viewLoader = {
  useView: () => ({ data: viewData, error: null, loading: false, refresh: async () => {} }),
  useRealtimeStatus: () => 'connected',
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
const workRemoval = { removeWorks: async () => {}, cancelCleanupFailure: () => null, cleanupFailureReason: () => null };
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

  const root = await tempDir(t, 'owl-api-web-controls-');
  const server = await startTestHttpServer(t, { core, webOut: root, owlRoot: root }, { token: 'api-web-controls-test-token' });
  if (!server) return t.skip('localhost listen is unavailable');

  const list = async (workId) => {
    const response = await server.request('GET', '/api/v1/agents?work_id=' + encodeURIComponent(workId));
    assert.equal(response.status, 200);
    return (await response.json()).data.map((agent) => agent.id);
  };
  assert.deepEqual(await list(workA), ['root-a', 'manager-a', 'child-a']);
  assert.deepEqual(await list(workB), ['root-b', 'manager-b']);
});

test('static extensionless page routes work when the web output path has a dotted parent', async (t) => {
  const root = await tempDir(t, 'owl-api-web-controls.static.');
  const webOut = join(root, 'out');
  await mkdir(webOut);
  await writeFile(join(webOut, 'backlog.html'), '<main>Backlog page</main>');
  const core = createMemoryCore({ version: 'test' });
  const server = await startTestHttpServer(t, { core, webOut, owlRoot: root });
  if (!server) return t.skip('localhost listen is unavailable');

  const response = await fetch(`${server.baseUrl}/owl/backlog`);
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
  '@/lib/view-loader': viewLoader,
  '@/lib/work-removal': workRemoval,
  '@/components/StateBadge': badges,
  '@/components/WorkArchiveActions': archiveActions,
  '@/components/DesignDocumentsSection': { DesignDocumentsSection: () => null },
  '@/components/DesignMocksSection': { DesignMocksSection: () => null },
  '@/components/WorkBacklogSection': { WorkBacklogSection: () => null },
  '@/components/WorkConversation': { WorkConversation: () => null },
  '@/components/WorkProjectMove': { WorkProjectMove: () => null },
'@/components/WorkPrerequisitesSection': { WorkPrerequisitesSection: () => null },
  '@/components/ActivityLog': { WorkPostMergeEvents: () => null },
  '@/components/WorkAssurancePanel': { WorkAssurancePanel: () => null },
'@/components/WorkFinalReportPanel': { WorkFinalReportPanel: () => null },
  '@/components/WorkSummaryHistory': { WorkSummaryHistory: () => null },
  '@/components/CoreActivityRows': { CoreActivityRows: () => null },
  '@/lib/i18n': i18n,
  '@/lib/work-detail-safety.mjs': { asReportEnvelope, humanizeWorkDetailError, normalizeWorkDetailData },
  '@/components/WorkSummaryBlock': compile(join(repoRoot, 'apps/web/components/WorkSummaryBlock.tsx'), { '@/lib/i18n': i18n }),
});
const { DecisionView } = compile(join(repoRoot, 'apps/web/components/DecisionView.tsx'), {
  'next/link': link,
  'next/navigation': { useSearchParams: () => new URLSearchParams('id=01J00000000000000000000009') },
  '@/lib/api-client': apiClient,
  '@/lib/format': format,
  '@/lib/view-loader': viewLoader,
  '@/components/StateBadge': badges,
  '@/lib/decision-sections.mjs': decisionSections,
  '@/lib/i18n': i18n,
});

function renderWith(Component, state) {
  [viewData, ...hookState] = state;
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
  // data (from useView), now, deleted, operationPending, operationError
  return [data, 0, false, false, null];
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
  // data (from useView), freeText, busy, result, error
  return [data, '', false, null, null];
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

const ID26 = '01ARZ3NDEKTSV4RRFFQ69TASK1';
const stateOptions = [
  { key: 'retry', label: 'Run again', description: 'Stored description of retry.' },
  { key: 'cancel', label: 'Stop', description: 'Stored description of cancel.' },
];
const explanations = {
  ready: { kind: 'work_prerequisite', status: 'ready', summary: 'Why summary text.', cause_kind: 'work', next_steps: 'Next steps text.',
    option_notes: [{ key: 'retry', note: 'Note for retry.' }, { key: 'cancel', note: 'Note for cancel.' }] },
  pending: { kind: 'work_prerequisite', status: 'pending', summary: null, cause_kind: null },
  failed: { kind: 'work_prerequisite', status: 'failed', summary: null, cause_kind: null },
  none: null,
};

/** A Work #13 shaped Decision: the reason ends with a bare id and the tried lines repeat the reason. */
function explainedState(name) {
  const state = decisionState({ allowFreeText: true, options: stateOptions });
  const d = state[0].decision;
  d.reason = `Waiting for A / Detail: A is not done. / （${ID26}）`;
  d.tried = 'Waiting for A\n- Detail: A is not done';
  d.recommended = 'retry';
  d.explanation = explanations[name];
  return state;
}

function findForm(node) {
  if (node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) return node.map(findForm).find(Boolean) ?? null;
  if (typeof node.type === 'function') return findForm(node.type(node.props));
  return node.type === 'form' ? node : findForm(node.props?.children);
}

test('Decision splits why and how in every state and never repeats a line or shows an id', () => {
  for (const name of ['ready', 'pending', 'failed', 'none']) {
    const { html } = renderWith(DecisionView, explainedState(name));
    assert.ok(html.indexOf(en.decision.why) < html.indexOf(en.decision.how), `${name}: why comes before how`);
    assert.equal(html.split(en.decision.recommended).length - 1, 1, `${name}: one recommendation`);
    assert.doesNotMatch(html, new RegExp(ID26), `${name}: no id`);
    const lines = html.replace(/<[^>]*>/gu, '\n').split('\n').map((l) => l.trim()).filter((l) => l.length > 6);
    assert.deepEqual(lines.filter((l, i) => lines.indexOf(l) !== i), [], `${name}: repeated lines`);
  }
  for (const name of ['ready', 'pending', 'failed', 'none']) {
    const state = explainedState(name);
    state[0].decision.reason = state[0].decision.question;
    const { html } = renderWith(DecisionView, state);
    const same = html.replace(/<[^>]*>/gu, '\n').split('\n').filter((l) => l.trim() === state[0].decision.question);
    assert.ok(same.length <= 1, `${name}: question not repeated`);
  }
  const echoed = explainedState('ready');
  echoed[0].decision.explanation = { ...explanations.ready, next_steps: explanations.ready.summary };
  const echoedView = renderWith(DecisionView, echoed);
  assert.equal(echoedView.html.split('Why summary text.').length - 1, 1, 'summary and next_steps shown once');
  assert.equal(buttons(echoedView.tree).filter((b) => textOf(b.props.children) === en.decision.choose).length, 2, 'options stay answerable');
  const partial = explainedState('ready');
  partial[0].decision.explanation = { ...explanations.ready, next_steps: 'Why summary text.\nWait, then run again.' };
  partial[0].decision.question = 'Wait, then run again.\nPick one';
  const partialHtml = renderWith(DecisionView, partial).html;
  assert.equal(partialHtml.split('Why summary text.').length - 1, 1, 'a summary line repeated in next_steps shown once');
  assert.equal(partialHtml.split('Wait, then run again.').length - 1, 1, 'a next_steps line repeated in the question shown once');
  assert.match(partialHtml.slice(partialHtml.indexOf('<details')), /Pick one/u, 'the new question line stays in the full record');
  for (const name of ['pending', 'failed', 'none']) {
    const state = explainedState(name);
    state[0].decision.question = 'Pick one\nPick one.';
    assert.equal(renderWith(DecisionView, state).html.split('Pick one').length - 1, 1, `${name}: a question line shown once`);
  }
  const bare = explainedState('ready');
  bare[0].decision.explanation = { ...explanations.ready, next_steps: null };
  for (const [name, html] of [['echoed', echoedView.html], ['no next_steps', renderWith(DecisionView, bare).html]]) {
    assert.doesNotMatch(html.slice(0, html.indexOf('<details')), /Pick one/u, `${name}: question stays out of how`);
    assert.match(html.slice(html.indexOf('<details')), /Pick one/u, `${name}: question in the full record`);
  }
  const ready = renderWith(DecisionView, explainedState('ready')).html;
  assert.match(ready, /Why summary text\./u);
  assert.match(ready, /Next steps text\./u);
  assert.match(ready, /Note for retry\./u);
  assert.doesNotMatch(ready.slice(0, ready.indexOf('<details')), /Pick one/u, 'question stays out of how');
  assert.match(ready, new RegExp(`<summary>${en.decision.detailsSummary}</summary>`, 'u'));
  const pending = renderWith(DecisionView, explainedState('pending')).html;
  assert.ok(pending.includes(en.decision.explanationPending));
  assert.match(pending, /Pick one/u);
  assert.match(pending, /Stored description of retry\./u);
  assert.ok(renderWith(DecisionView, explainedState('failed')).html.includes(en.decision.explanationFailed));
  assert.ok(!renderWith(DecisionView, explainedState('none')).html.includes(en.decision.explanationFailed));
  for (const key of ['how', 'explanationFailed', 'detailsSummary']) {
    assert.equal(typeof ja.decision[key], 'string', `ja decision.${key}`);
  }
});

test('Decision answers with option_key for a button and null for free text in every state', async () => {
  for (const name of ['ready', 'pending', 'failed', 'none']) {
    apiCalls.length = 0;
    const choose = buttons(renderWith(DecisionView, explainedState(name)).tree).filter((b) => textOf(b.props.children) === en.decision.choose);
    assert.equal(choose.length, 2, `${name}: both option buttons`);
    choose[1].props.onClick();
    await new Promise((resolveNext) => setImmediate(resolveNext));
    assert.deepEqual(apiCalls[0].slice(0, 2), ['answerDecision', '01J00000000000000000000009']);
    assert.equal(apiCalls[0][2].option_key, 'cancel', name);

    apiCalls.length = 0;
    const state = explainedState(name);
    state[1] = 'My own answer';
    findForm(renderWith(DecisionView, state).tree).props.onSubmit({ preventDefault() {} });
    await new Promise((resolveNext) => setImmediate(resolveNext));
    assert.equal(apiCalls[0][2].option_key, null, name);
    assert.equal(apiCalls[0][2].answer, 'My own answer', name);
  }
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

test('Decision without an explanation shows why it stopped, then what to do, then the record', () => {
  const options = [
    { key: 'retry', label: 'Fix it', description: 'The Manager plans the fix.' },
    { key: 'cancel', label: 'Stop', description: 'The Work is cancelled.' },
  ];
  const { html } = renderWith(DecisionView, decisionState({ allowFreeText: true, options }));
  const order = [en.decision.why, 'The Work stopped', en.decision.how, 'Pick one',
    'Fix it', 'The Manager plans the fix.', 'Stop', 'The Work is cancelled.', en.decision.currentState, 'Waiting', en.decision.tried, 'Nothing yet'];
  let at = -1;
  for (const part of order) {
    const next = html.indexOf(part, at + 1);
    assert.ok(next > at, `${part} should follow the previous section`);
    at = next;
  }
  assert.equal(html.split(en.decision.choose).length - 1, 2, 'each option has its own answer button');
});

test('Decision with a ready explanation shows summary, fix options and the recommendation first, and folds the record', () => {
  const options = [
    { key: 'fix_1', label: 'Reword the criterion', description: 'Rerun with the new wording.', criteria_rewrites: [{ criterion_id: 'AC1', before: 'Old wording', after: 'New wording', check: 'Measure it twice' }] },
    { key: 'retry', label: 'Run again', description: 'Run the Task again.' },
    { key: 'cancel', label: 'Stop', description: 'The Work is cancelled.' },
  ];
  const state = decisionState({ allowFreeText: true, options });
  state[0].decision.recommended = 'fix_1';
  state[0].decision.explanation = { kind: 'partial_limit', status: 'ready', summary: 'The criterion cannot be met as written.', cause_kind: 'criteria' };
  const { html } = renderWith(DecisionView, state);
  const at = (s) => html.indexOf(s);
  const detailsAt = at('<details');
  assert.ok(at('The criterion cannot be met as written.') > 0 && at('The criterion cannot be met as written.') < detailsAt);
  assert.ok(at('Reword the criterion') < at(en.decision.otherOptions));
  assert.ok(at('New wording') < at(en.decision.otherOptions));
  assert.match(html, /btn btn--primary"[^>]*>[^<]*<\/button>/);
  assert.ok(html.indexOf('btn--primary') < at(en.decision.otherOptions));
  assert.ok(at('The Work stopped') > detailsAt, 'reason is inside the details');
  assert.doesNotMatch(html, /<details[^>]*\sopen/);
  assert.doesNotMatch(html, /AC1/);

  const plain = decisionState({ allowFreeText: true, options: options.slice(1) });
  plain[0].decision.explanation = null;
  assert.doesNotMatch(renderWith(DecisionView, plain).html, /<details/);
});
