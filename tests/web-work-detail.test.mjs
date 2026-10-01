import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

import {
  asReportEnvelope,
  humanizeWorkDetailError,
  normalizeWorkDetailData,
  workDetailHref,
} from '../apps/web/lib/work-detail-safety.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiClientPath = join(repoRoot, 'apps/web/lib/api-client.ts');
const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const componentReact = { ...React };
const workStates = ['memo', 'ready', 'running', 'paused', 'judgement_waiting', 'completed', 'cancelled', 'queued', 'failed', 'future_backend_state'];
const workSizes = ['small', 'normal', 'large'];

const workStateDisplayNames = {
  memo: 'Memo',
  ready: 'Ready',
  running: 'Running',
  paused: 'Paused',
  judgement_waiting: 'Needs review',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
const taskStateDisplayNames = {
  waiting: 'Waiting',
  ready: 'Ready',
  running: 'Running',
  verifying: 'Verifying',
  review_fix_waiting: 'Review needed',
  failed: 'Failed',
  judgement_waiting: 'Needs review',
  completed: 'Completed',
  paused: 'Paused',
  cancelled: 'Cancelled',
};

let activeHookHarness = null;
let routeSearchParams = new URLSearchParams();
componentReact.useState = (initialValue) => activeHookHarness.useState(initialValue);
componentReact.useEffect = (effect) => activeHookHarness.useEffect(effect);
componentReact.useCallback = (callback) => callback;

const componentTranslations = {
  'common.loading': 'Loading…',
  'common.none': 'None',
  'common.backToBoard': 'Back to board',
  'common.items': ({ count }) => `${count} items`,
  'realtime.connecting': 'Connecting',
  'realtime.connected': 'Connected',
  'realtime.polling': 'Polling',
  'board.title': 'Work board',
  'board.subtitle': 'Current work',
  'board.createWork': 'Create Work',
  'board.titleLabel': 'Title',
  'board.titlePlaceholder': 'Work title',
  'board.summaryLabel': 'Summary',
  'work.summaryAcceptanceCount': ({ count }) => `${count} acceptance conditions`,
  'board.executionModeLabel': 'Execution mode',
  'board.managerPlan': 'Manager plan',
  'board.directWorker': 'Direct worker',
  'board.executionModeHelp': 'Choose how to execute',
  'board.projectLabel': 'Project',
  'board.noProject': 'No project',
  'board.createAndStart': 'Create and start',
  'board.empty': 'No work',
  'work.overview': 'Overview',
  'work.numberLabel': ({ number }) => `Work #${number}`,
  'work.progress': 'Progress',
  'work.progressCompleted': ({ done, total }) => `${done} of ${total} tasks completed`,
  'work.internalTasks': 'Tasks',
  'work.noTasks': 'No tasks yet',
  'work.deliverables': 'Deliverables',
  'work.noDeliverables': 'No deliverables',
  'work.workerReport': 'Worker report',
  'work.noReports': 'No reports',
  'work.decisions': 'Decisions',
  'work.noDecisions': 'No decisions',
  'work.conversation': 'Conversation',
  'work.conversationSub': 'Conversation history',
  'work.noConversation': 'No conversation',
  'work.conversationLoadError': 'Could not load the conversation.',
  'work.manager': 'Manager',
  'work.noManager': 'No manager',
  'work.activeAgents': 'Active agents',
  'work.noActiveAgents': 'No active agents',
  'work.agentHistory': 'Agent history',
  'work.wholeWork': 'Whole Work',
  'work.errorNetwork': 'Could not connect to the server.',
  'work.errorInvalidResponse': 'The server returned invalid Work data.',
  'work.errorDefault': 'Work details could not be loaded.',
  'work.errorRender': 'The Work details could not be displayed. Please try again.',
  'work.errorVersionConflict': 'Work changed; reload the details.',
  'work.retry': 'Retry',
  'work.notFound': 'Work not found',
  'work.notFoundDetail': ({ id }) => `No Work exists with id ${id}.`,
  'work.pause': 'Pause',
  'work.resume': 'Resume',
  'work.abort': 'Abort',
  'work.pauseReason': 'Paused from Work details.',
  'work.abortReason': 'Owner cancelled from Work details.',
  'work.confirmAbort': 'Cancel this Work?',
  'work.operationPending': 'Working…',
  'work.errorOperation': 'The operation failed. Try again.',
  'work.archive': 'Archive',
  'work.unarchive': 'Unarchive',
  'work.delete': 'Delete',
  'work.taskTypeDesign': 'Design',
  'work.designDocuments': 'Design documents',
  'work.errorDesignDocumentsLoad': 'Could not load the design documents.',
  'work.errorDesignDocumentLoad': 'Could not load this design document.',
  'board.backToChat': 'Back',
};

const actualFormatModule = compileWebComponent(join(repoRoot, 'apps/web/lib/format.ts'), {
  '@/lib/work-detail-safety.mjs': { asReportEnvelope },
  '@/lib/i18n/ja.json': JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8')),
  '@/lib/i18n/en.json': JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8')),
});
const actualSkillDiffModule = compileWebComponent(join(repoRoot, 'apps/web/lib/skill-diff.ts'));

function translateForComponent(key, values = {}) {
  const entry = componentTranslations[key];
  return typeof entry === 'function' ? entry(values) : entry ?? key;
}

const componentFormat = {
  asReportEnvelope,
  safeEnumLabel: actualFormatModule.safeEnumLabel,
  workStateLabels: () => workStateDisplayNames,
  taskStateLabels: () => taskStateDisplayNames,
  agentStatusLabels: () => ({}),
  agentOutcomeLabels: () => ({}),
  boardSectionLabels: () => ({ judgement: 'Needs review', running: 'Running', waiting: 'Waiting', done: 'Done', cancelled: 'Cancelled' }),
  boardSectionOf: actualFormatModule.boardSectionOf,
  formatRelative: () => 'just now',
  formatAgentLabel: () => 'Agent',
  roleDisplayName: (role) => role,
  runOrdinals: () => new Map(),
  workDisplayNumber: actualFormatModule.workDisplayNumber,
};
const componentI18n = {
  useLocale: () => ({ locale: 'en', t: translateForComponent }),
};
const componentApiClient = {
  getWorkDetail: async () => { throw new Error('component API was not configured'); },
  getWorkConversation: async () => ({ messages: [] }),
  getBoard: async () => { throw new Error('board effect should not run in the static fixture'); },
  listProjects: async () => [],
  createWork: async () => { throw new Error('board form should not submit in the static fixture'); },
  startWork: async () => { throw new Error('board form should not submit in the static fixture'); },
  pauseWork: async () => { throw new Error('Work controls should not run during static render'); },
  resumeWork: async () => { throw new Error('Work controls should not run during static render'); },
  cancelWork: async () => { throw new Error('Work controls should not run during static render'); },
  subscribeToUpdates: () => () => {},
  getWorkDesigns: async () => ({ designs: [] }),
  getWorkDesign: async () => { throw new Error('design document should not load during static render'); },
};

const componentWorkRemoval = {
  removeWorks: async () => {},
  revealWork: () => {},
  useWorkRemovals: () => ({ hiddenIds: new Set(), error: null }),
};
const componentIcons = {
  TrashIcon: () => null,
  ArchiveBoxIcon: () => null,
  RestoreIcon: () => null,
};
const archiveActionsModule = compileWebComponent(join(repoRoot, 'apps/web/components/WorkArchiveActions.tsx'), {
  '@/lib/api-client': componentApiClient,
  '@/lib/i18n': componentI18n,
  '@/lib/work-removal': componentWorkRemoval,
  '@/components/icons': componentIcons,
});

function compileWebComponent(modulePath, overrides = {}) {
  const source = readFileSync(modulePath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
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

let lastLinkProps = null;
const linkModule = {
  __esModule: true,
  default: function Link({ href, children, ...props }) {
    lastLinkProps = { href, ...props };
    return React.createElement('a', { ...props, href }, children);
  },
};
const stateBadgeModule = compileWebComponent(join(repoRoot, 'apps/web/components/StateBadge.tsx'), {
  '@/lib/format': componentFormat,
  '@/lib/i18n': componentI18n,
});
const boardComponentModule = compileWebComponent(join(repoRoot, 'apps/web/components/BoardView.tsx'), {
  'next/link': linkModule,
  '@/lib/api-client': componentApiClient,
  '@/lib/format': componentFormat,
  '@/components/StateBadge': stateBadgeModule,
  '@/components/WorkArchiveActions': archiveActionsModule,
  '@/lib/i18n': componentI18n,
  '@/lib/work-detail-safety.mjs': { workDetailHref },
  '@/lib/work-removal': componentWorkRemoval,
  '@/components/icons': componentIcons,
});
const workSummaryBlockModule = compileWebComponent(join(repoRoot, 'apps/web/components/WorkSummaryBlock.tsx'), {
  '@/lib/i18n': componentI18n,
});
const designDocumentsSectionModule = compileWebComponent(join(repoRoot, 'apps/web/components/DesignDocumentsSection.tsx'), {
  '@/lib/api-client': componentApiClient,
  '@/lib/format': componentFormat,
  '@/lib/skill-diff': actualSkillDiffModule,
  '@/lib/i18n': componentI18n,
});
const advisorStub = { AdvisorView: () => React.createElement('div', { 'data-testid': 'advisor' }) };
const panelConversationProps = { current: null };
const previewComponentModule = compileWebComponent(join(repoRoot, 'apps/web/components/WorkPreviewPanel.tsx'), {
  'next/link': linkModule,
  '@/lib/api-client': componentApiClient,
  '@/lib/format': { ...componentFormat, agentStatusLabels: () => ({}), agentOutcomeLabels: () => ({}) },
  '@/components/StateBadge': stateBadgeModule,
  '@/components/WorkArchiveActions': archiveActionsModule,
  '@/lib/i18n': componentI18n,
  '@/lib/work-detail-safety.mjs': { humanizeWorkDetailError, normalizeWorkDetailData, workDetailHref },
  '@/components/WorkSummaryBlock': workSummaryBlockModule,
  '@/components/WorkConversation': { WorkConversation: (props) => (panelConversationProps.current = props, null) },
});
const homePageModule = compileWebComponent(join(repoRoot, 'apps/web/app/page.tsx'), {
  '@/components/BoardView': boardComponentModule,
  '@/components/AdvisorView': advisorStub,
  '@/components/WorkPreviewPanel': previewComponentModule,
});
const boardPageModule = compileWebComponent(join(repoRoot, 'apps/web/app/board/page.tsx'), {
  '@/components/BoardView': boardComponentModule,
  '@/components/AdvisorView': advisorStub,
  '@/components/WorkPreviewPanel': previewComponentModule,
});
const detailComponentModule = compileWebComponent(join(repoRoot, 'apps/web/components/WorkDetailView.tsx'), {
  'next/link': linkModule,
  'next/navigation': {
    useRouter: () => ({ replace: () => {} }),
    useSearchParams: () => routeSearchParams,
  },
  '@/lib/api-client': componentApiClient,
  '@/lib/format': componentFormat,
  '@/components/StateBadge': stateBadgeModule,
  '@/components/WorkArchiveActions': archiveActionsModule,
  '@/lib/i18n': componentI18n,
  '@/lib/work-detail-safety.mjs': { asReportEnvelope, humanizeWorkDetailError, normalizeWorkDetailData },
  '@/components/WorkSummaryBlock': workSummaryBlockModule,
  '@/components/DesignDocumentsSection': designDocumentsSectionModule,
  '@/components/WorkBacklogSection': { WorkBacklogSection: () => null },
  '@/components/WorkConversation': { WorkConversation: () => null },
});
const workErrorModule = compileWebComponent(join(repoRoot, 'apps/web/app/work/error.tsx'), {
  'next/link': linkModule,
  '@/lib/i18n': componentI18n,
});

function createHookHarness(initialState = []) {
  const state = [...initialState];
  let hookIndex = 0;
  let effects = [];
  return {
    useState(initialValue) {
      const index = hookIndex++;
      if (index >= state.length) state[index] = initialValue;
      return [state[index], (nextValue) => {
        state[index] = typeof nextValue === 'function' ? nextValue(state[index]) : nextValue;
      }];
    },
    useEffect(effect) {
      effects.push(effect);
    },
    render(Component, props = {}) {
      hookIndex = 0;
      effects = [];
      activeHookHarness = this;
      try {
        const html = renderToStaticMarkup(React.createElement(Component, props));
        return { html, effects: [...effects] };
      } finally {
        activeHookHarness = null;
      }
    },
    runEffects(effectsToRun) {
      return effectsToRun.map((effect) => effect());
    },
  };
}

function renderBoardWorkLink(work, route = '/board', selectedCardId = null) {
  const harness = createHookHarness([
    selectedCardId,
    0,
    { works: [work], open_decisions: [] },
    [],
    Date.parse('2026-09-23T00:00:00.000Z'),
    null,
    'connected',
    { title: '', summary: '', size: 'normal', project_id: null },
    false,
    null,
    null,
  ]);
  lastLinkProps = null;
  const page = route === '/' ? homePageModule.default : boardPageModule.default;
  const { html } = harness.render(page);
  // Match the card's own link specifically: the Board toolbar also renders an
  // `<a>` (the link to /archive), which would otherwise be picked up first.
  const match = html.match(/<a\b[^>]*\bclass="card__link"[^>]*\bhref="([^"]+)"/);
  assert.ok(match, 'the Work card should render as a clickable link');
  return { html, href: match[1], linkProps: lastLinkProps, harness };
}

async function renderDetailFromRoute(href, apiClient) {
  const route = new URL(href, 'http://owl.test');
  routeSearchParams = route.searchParams;
  const requests = [];
  componentApiClient.getWorkDetail = (id) => {
    const promise = apiClient.getWorkDetail(id);
    requests.push({ id, promise });
    return promise;
  };
  const harness = createHookHarness([undefined, 0, null, 'connected']);
  const firstRender = harness.render(detailComponentModule.WorkDetailView);
  harness.runEffects(firstRender.effects);
  assert.equal(requests.length, 1, 'the detail route should fetch the Work selected by the board link');
  let detail = null;
  let requestError = null;
  try {
    detail = await requests[0].promise;
  } catch (error) {
    requestError = error;
  }
  await new Promise((resolveNext) => setImmediate(resolveNext));
  const rendered = harness.render(detailComponentModule.WorkDetailView);
  return { detail, html: rendered.html, requestError, requestedId: requests[0].id, firstHtml: firstRender.html };
}

function loadApiClient() {
  const source = readFileSync(apiClientPath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const loaded = new Module(apiClientPath);
  loaded.filename = apiClientPath;
  loaded.paths = Module._nodeModulePaths(dirname(apiClientPath));

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@/lib/format') return { runOrdinals: () => new Map() };
    if (request === '@/lib/work-detail-safety.mjs') {
      return { asReportEnvelope, humanizeWorkDetailError, normalizeWorkDetailData, workDetailHref };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, apiClientPath);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function listPage(data = []) {
  return { request_id: 'request-1', data, cursor: null, has_more: false };
}

function apiWork({ id, title, summary, state, size, display_number = null }) {
  return {
    id,
    display_number,
    title,
    state,
    state_version: 7,
    updated_at: '2026-09-23T00:00:00.000Z',
    owner_id: 'owner-1',
    project_id: null,
    summary,
    size,
    plan_revision: 0,
  };
}

const progressTasks = [
  { id: 'task-completed-1', status: 'completed' },
  { id: 'task-completed-2', status: 'completed' },
  { id: 'task-waiting', status: 'waiting' },
  { id: 'task-running', status: 'running' },
  { id: 'task-failed', status: 'failed' },
].map(({ id, status }) => ({
  id,
  work_id: '01J00000000000000000000000',
  title: `Task ${status}`,
  status,
  type: 'code',
  state_version: 1,
  updated_at: '2026-09-23T00:00:00.000Z',
}));

function successfulApiFetch(input, options) {
  const {
    state = 'memo',
    size = 'small',
    display_number = null,
    taskRows = [],
    title = 'Slack返信をSlack mrkdwn記法で出力する',
    summary = 'Render the reply using Slack mrkdwn.',
  } = options;
  const url = new URL(String(input), 'http://owl.test');
  if (url.pathname === '/api/v1/runtime-config.json') {
    return jsonResponse({
      base_path: '/owl/',
      api_base: '/api/v1',
      ws_url: '/api/v1/events',
      schema_version: '1.0.0',
    });
  }
  if (url.pathname.startsWith('/api/v1/works/') && url.pathname.endsWith('/tasks')) {
    return jsonResponse(listPage(taskRows));
  }
  if (url.pathname.startsWith('/api/v1/works/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/v1/works/'.length));
    const response = {
      request_id: 'request-1',
      version: 7,
    };
    response.data = Object.hasOwn(options, 'workData')
      ? options.workData
      : apiWork({ id, title, summary, state, size, display_number });
    return jsonResponse(response);
  }
  if (url.pathname === '/api/v1/agents' || url.pathname === '/api/v1/decisions') {
    return jsonResponse(listPage());
  }
  if (url.pathname.startsWith('/api/v1/tasks/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/v1/tasks/'.length).split('?')[0]);
    const row = taskRows.find((task) => task.id === id);
    return jsonResponse({ request_id: 'request-1', data: row, report: null, version: row.state_version });
  }
  throw new Error(`Unexpected Work detail API request: ${url.pathname}${url.search}`);
}

function failingApiFetch(input, mode) {
  const url = new URL(String(input), 'http://owl.test');
  if (url.pathname === '/api/v1/runtime-config.json') {
    return jsonResponse({
      base_path: '/owl/',
      api_base: '/api/v1',
      ws_url: '/api/v1/events',
      schema_version: '1.0.0',
    });
  }
  if (url.pathname.startsWith('/api/v1/works/') && !url.pathname.endsWith('/tasks')) {
    if (mode === 'network') throw new TypeError('fetch failed');
    if (mode === 'http') {
      return jsonResponse({
        request_id: 'request-1',
        error: { code: 'server_error', message: 'Unavailable', details: {} },
      }, 500);
    }
    if (mode === 'malformed-json') return new Response('{not json', { status: 200 });
    if (mode === 'not-found') {
      return jsonResponse({
        request_id: 'request-1',
        error: { code: 'work_not_found', message: 'Missing', details: {} },
      }, 404);
    }
  }
  if (url.pathname.endsWith('/tasks') || url.pathname === '/api/v1/agents' || url.pathname === '/api/v1/decisions') {
    return jsonResponse(listPage());
  }
  throw new Error(`Unexpected Work detail API request: ${url.pathname}${url.search}`);
}

test('asReportEnvelope safely handles non-object and malformed report payloads', () => {
  assert.deepEqual(asReportEnvelope(null), {
    schema_version: '1.0.0',
    invocation_id: '',
    result: 'success',
    work_done: '',
    changes: [],
    verification: { passed: false, method: '' },
    remaining_issues: [],
    next_action: '',
    needs_replanning: false,
    question_for_manager: null,
  });

  const envelope = asReportEnvelope({
    changes: [null, 'bad row', { file: 'src/example.ts', action: 'added' }],
    verification: [],
    remaining_issues: ['one', null, 2, { issue: 'two', impact: 'Blocks release.', next_step: 'Fix it.' }, { impact: 'no issue' }],
  });
  assert.deepEqual(envelope.changes, [{ file: 'src/example.ts', action: 'added' }]);
  assert.deepEqual(envelope.verification, { passed: false, method: '' });
  // Reports from before the template hold plain strings; they become issues without detail.
  assert.deepEqual(envelope.remaining_issues, [
    { issue: 'one', impact: '', next_step: '' },
    { issue: 'two', impact: 'Blocks release.', next_step: 'Fix it.' },
  ]);
  assert.deepEqual(asReportEnvelope({ verification: { passed: true, method: 'Ran npm test.' } }).verification, { passed: true, method: 'Ran npm test.' });
});

test('normalizes fresh Works for every size and known or unexpected Work state', () => {
  for (const state of workStates) {
    for (const size of workSizes) {
      const detail = normalizeWorkDetailData({
        work: {
          id: '01J00000000000000000000000',
          title: 'Slack返信をSlack mrkdwn記法で出力する',
          summary: null,
          project_id: null,
          state,
          size,
        },
      }, 'requested-id');

      assert.equal(detail.work.title, 'Slack返信をSlack mrkdwn記法で出力する');
      assert.equal(detail.work.summary, '');
      assert.equal(detail.work.state, state);
      assert.equal(detail.work.size, size);
      assert.equal(detail.work.project_id, null);
      assert.equal(detail.work.id, '01J00000000000000000000000');
      assert.deepEqual(detail.work.progress, { total_tasks: 0, completed_tasks: 0, percent: 0 });
      assert.deepEqual(detail.tasks, []);
      assert.deepEqual(detail.runs, []);
      assert.deepEqual(detail.reports, []);
      assert.deepEqual(detail.decisions, []);
      assert.deepEqual(detail.messages, []);
    }
  }
});

test('fetches detail data for every size and known or unexpected Work state', async () => {
  const client = loadApiClient();
  const originalFetch = globalThis.fetch;
  try {
    for (const state of workStates) {
      for (const size of workSizes) {
        const id = `work-${size}-${state}`;
        const taskRows = progressTasks.map((task) => ({ ...task, work_id: id }));
        globalThis.fetch = (input) => successfulApiFetch(input, { state, size, taskRows });

        const detail = await client.getWorkDetail(id);
        assert.ok(detail, `expected detail for ${size}/${state}`);
        assert.equal(detail.work.id, id);
        assert.equal(detail.work.title, 'Slack返信をSlack mrkdwn記法で出力する');
        assert.equal(detail.work.summary, 'Render the reply using Slack mrkdwn.');
        assert.equal(detail.work.state, state);
        assert.equal(detail.work.size, size);
        assert.equal(detail.tasks.length, 5);
        assert.equal(detail.tasks.filter((task) => task.status === 'completed').length, 2);
        assert.equal(Math.round((detail.tasks.filter((task) => task.status === 'completed').length / detail.tasks.length) * 100), 40);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pause, resume, and cancel use the Work version and API action routes', async () => {
  const client = loadApiClient();
  const originalFetch = globalThis.fetch;
  const requests = [];
  const id = 'work-control-test';
  try {
    globalThis.fetch = (input, init = {}) => {
      const url = new URL(String(input), 'http://owl.test');
      if (url.pathname === '/api/v1/runtime-config.json') {
        return jsonResponse({ base_path: '/owl/', api_base: '/api/v1', ws_url: '/api/v1/events', schema_version: '1.0.0' });
      }
      requests.push({ path: url.pathname, method: init.method, ...JSON.parse(String(init.body)) });
      return jsonResponse({
        request_id: 'response-1',
        data: { work_id: id, state: 'cancelled', cancel_requested: true },
        version: 5,
      });
    };

    await client.pauseWork(id, 4, 'Paused from the detail screen.');
    await client.resumeWork(id, 5);
    await client.cancelWork(id, 6, 'Owner requested cancellation.', false);

    assert.deepEqual(requests.map((request) => request.path), [
      `/api/v1/works/${id}/pause`,
      `/api/v1/works/${id}/resume`,
      `/api/v1/works/${id}/cancel`,
    ]);
    assert.deepEqual(requests.map((request) => request.expected_version), [4, 5, 6]);
    assert.deepEqual(requests.map((request) => request.payload), [
      { reason: 'Paused from the detail screen.' },
      {},
      { reason: 'Owner requested cancellation.', force: false },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('clicking a Work card on either list route opens detail for every size and Work state', async () => {
  const client = loadApiClient();
  const originalFetch = globalThis.fetch;
  try {
    for (const size of workSizes) {
      for (const state of workStates) {
        const id = `work-${size}-${state}`;
        const title = 'Slack返信をSlack mrkdwn記法で出力する';
        const summary = 'Render the reply using Slack mrkdwn.';
        const boardWork = { id, title, state, updated_at: '2026-09-23T00:00:00.000Z' };
        const taskRows = progressTasks.map((task) => ({ ...task, work_id: id }));
        globalThis.fetch = (input) => successfulApiFetch(input, { state, size, taskRows });
        for (const route of ['/', '/board']) {
          const board = renderBoardWorkLink(boardWork, route);
          const href = new URL(board.href, 'http://owl.test');

          assert.equal(href.pathname, '/work');
          assert.equal(href.searchParams.get('id'), id);
          assert.equal(typeof board.linkProps?.onClick, 'function', 'the Work card should offer an inline preview on wide screens');
          assert.ok(board.html.includes(title), 'the Work should be visible in the list before opening it');
          assert.ok(board.html.includes(workStateDisplayNames[state] ?? state), 'the Work status should be visible in its list row');

          const screen = await renderDetailFromRoute(board.href, client);
          assert.equal(screen.requestedId, id, 'the detail screen should fetch the id from the clicked Work link');
          assert.ok(screen.detail, `expected detail data for ${size}/${state}`);
          assert.equal(screen.detail.work.title, title);
          assert.equal(screen.detail.work.summary, summary);
          assert.equal(screen.detail.work.state, state);
          assert.equal(screen.detail.work.size, size);
          assert.ok(screen.html.includes(`<h1 class="page__title panel__heading">${title}</h1>`));
          assert.ok(screen.html.includes(summary));
          assert.ok(screen.html.includes(workStateDisplayNames[state] ?? state), 'the detail heading should show the Work status');
          assert.ok(screen.html.includes('<strong>40%</strong>'), 'progress should reflect 2 completed tasks out of 5');
          assert.ok(screen.html.includes('2 of 5 tasks completed'));
          assert.ok(screen.html.includes('Waiting'));
          assert.ok(screen.html.includes('Running'));
          assert.ok(screen.html.includes('Failed'));
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Work detail displays its Work number when the API supplies one', async () => {
  const client = loadApiClient();
  const originalFetch = globalThis.fetch;
  const id = 'work-numbered';
  const title = 'Numbered Work';
  try {
    globalThis.fetch = (input) => successfulApiFetch(input, { display_number: 12, title });
    const board = renderBoardWorkLink({
      id,
      title,
      state: 'ready',
      updated_at: '2026-09-23T00:00:00.000Z',
      display_number: 12,
    });
    const screen = await renderDetailFromRoute(board.href, client);
    assert.ok(screen.html.includes('Work #12'));
    assert.ok(screen.html.includes(title));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Work detail marks a design Task with its own badge', async () => {
  const client = loadApiClient();
  const originalFetch = globalThis.fetch;
  const id = 'work-with-design-task';
  const title = 'Design the API contract';
  try {
    const taskRows = [
      {
        id: 'task-design',
        work_id: id,
        title: 'Design the payload shape',
        status: 'running',
        type: 'design',
        state_version: 1,
        updated_at: '2026-09-23T00:00:00.000Z',
      },
    ];
    globalThis.fetch = (input) => successfulApiFetch(input, { state: 'running', title, taskRows });
    const board = renderBoardWorkLink({ id, title, state: 'running', updated_at: '2026-09-23T00:00:00.000Z' });
    const screen = await renderDetailFromRoute(board.href, client);
    assert.ok(screen.html.includes('Design the payload shape'), 'the Task title should still be shown');
    assert.ok(screen.html.includes('badge--purple'), 'a design Task should get its own badge colour');
    assert.ok(screen.html.includes('>Design<'), 'the Task type should show the localized Design label instead of the raw type');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the design documents section lists items and shows a document on click', async () => {
  const harness = createHookHarness([]);
  const designs = [
    { task_id: 'task-1', title: 'API contract', updated_at: '2026-01-01T00:00:00.000Z', size_bytes: 2048 },
  ];
  let capturedPromise = null;
  const originalGetWorkDesigns = componentApiClient.getWorkDesigns;
  const originalGetWorkDesign = componentApiClient.getWorkDesign;
  componentApiClient.getWorkDesigns = () => {
    capturedPromise = Promise.resolve({ designs });
    return capturedPromise;
  };
  componentApiClient.getWorkDesign = async () => ({
    task_id: 'task-1',
    title: 'API contract',
    markdown: '# Design\n\nBody text.',
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  try {
    const props = {
      workId: 'work-1',
      refreshToken: 0,
      now: Date.parse('2026-01-02T00:00:00.000Z'),
      locale: 'en',
      t: translateForComponent,
    };
    const first = harness.render(designDocumentsSectionModule.DesignDocumentsSection, props);
    assert.equal(first.html, '', 'the section should render nothing before the list loads');
    harness.runEffects(first.effects);
    await capturedPromise;
    const loaded = harness.render(designDocumentsSectionModule.DesignDocumentsSection, props);
    assert.ok(loaded.html.includes('API contract'));
    assert.ok(loaded.html.includes('Design documents'));
    assert.ok(loaded.html.includes('2.0 KB'));
  } finally {
    componentApiClient.getWorkDesigns = originalGetWorkDesigns;
    componentApiClient.getWorkDesign = originalGetWorkDesign;
  }
});

test('the design documents section hides itself when there are no design documents', async () => {
  const harness = createHookHarness([]);
  let capturedPromise = null;
  const originalGetWorkDesigns = componentApiClient.getWorkDesigns;
  componentApiClient.getWorkDesigns = () => {
    capturedPromise = Promise.resolve({ designs: [] });
    return capturedPromise;
  };
  try {
    const props = {
      workId: 'work-1',
      refreshToken: 0,
      now: Date.now(),
      locale: 'en',
      t: translateForComponent,
    };
    const first = harness.render(designDocumentsSectionModule.DesignDocumentsSection, props);
    harness.runEffects(first.effects);
    await capturedPromise;
    const loaded = harness.render(designDocumentsSectionModule.DesignDocumentsSection, props);
    assert.equal(loaded.html, '', 'the section should stay hidden when there are no design documents');
  } finally {
    componentApiClient.getWorkDesigns = originalGetWorkDesigns;
  }
});

test('Board shows the Advisor chat by default and previews a clicked Work in the right panel', () => {
  const id = 'work-preview';
  const work = { id, title: 'Slack連携を作る', state: 'running', updated_at: '2026-09-23T00:00:00.000Z' };

  // No selection: the left column keeps the Advisor chat.
  for (const route of ['/', '/board']) {
    const board = renderBoardWorkLink(work, route);
    assert.ok(board.html.includes('data-testid="advisor"'), 'the Advisor chat should show when nothing is selected');
    assert.ok(!board.html.includes('card--selected'));
  }

  // A plain click on a wide screen selects the Work instead of navigating.
  const originalWindow = globalThis.window;
  try {
    let wide = true;
    globalThis.window = { matchMedia: () => ({ matches: wide }) };
    const selected = [];
    const boardHarness = createHookHarness([
      { works: [work], open_decisions: [] },
      [],
      Date.parse('2026-09-23T00:00:00.000Z'),
      null,
      'connected',
      { title: '', summary: '', size: 'normal', project_id: null },
      false,
      null,
      null,
    ]);
    lastLinkProps = null;
    boardHarness.render(boardComponentModule.BoardView, { onSelectCard: (value) => selected.push(value), selectedCardId: null });
    let onClick = lastLinkProps.onClick;
    const click = (overrides = {}) => {
      let prevented = false;
      onClick({ button: 0, defaultPrevented: false, preventDefault: () => { prevented = true; }, ...overrides });
      return prevented;
    };
    assert.equal(click(), true, 'a plain click should stay on the Board');
    assert.deepEqual(selected, [id], 'a plain click should select the Work for the left column');

    // Modified clicks keep normal navigation; on the home page a narrow screen follows the link
    // because its preview column is hidden there.
    assert.equal(click({ metaKey: true }), false);
    wide = false;
    assert.equal(click(), false, 'home: a narrow screen should follow the link to the Work page');
    assert.deepEqual(selected, [id]);

    // The Board page has a right panel at every width, so it keeps intercepting the click.
    lastLinkProps = null;
    boardHarness.render(boardComponentModule.BoardView, { onSelectCard: (value) => selected.push(value), selectedCardId: null, alwaysPreview: true });
    onClick = lastLinkProps.onClick;
    assert.equal(click(), true, 'board: a narrow screen should still open the right panel');
    assert.deepEqual(selected, [id, id]);
  } finally {
    globalThis.window = originalWindow;
  }

  // With a selection, the left column shows the preview and a link to the full Work page.
  const detail = normalizeWorkDetailData({
    work: { id, display_number: 6, title: work.title, state: 'running', summary: 'Slackから操作できるようにする', progress: { total_tasks: 5, completed_tasks: 2, percent: 40 } },
    tasks: progressTasks.map((task) => ({ ...task, work_id: id })),
  }, id);
  const harness = createHookHarness([
    id,
    0,
    { works: [work], open_decisions: [] },
    [],
    Date.parse('2026-09-23T00:00:00.000Z'),
    null,
    'connected',
    { title: '', summary: '', size: 'normal', project_id: null },
    false,
    null,
    null,
    false, // card armed
    'idle', // card swipe state
    null,
    null,
    detail,
    Date.parse('2026-09-23T00:00:00.000Z'),
    null,
    null, // panel conversation
    null, // panel conversation error
  ]);
  const { html } = harness.render(boardPageModule.default);
  assert.ok(!html.includes('data-testid="advisor"'), 'the preview should replace the chat while a Work is selected');
  assert.ok(html.includes('board.preview.openDetail'), 'the preview should offer a way to the full Work page');
  assert.ok(html.includes('Work #6'));
  assert.ok(html.includes(`href="${workDetailHref(id)}"`), 'the full-detail button should link to the Work page');
  assert.ok(html.includes('Back'), 'the preview should offer a way back to the chat');
  assert.ok(html.includes('<strong>40%</strong>'));
  assert.ok(html.includes('Task running'));
  assert.ok(html.includes('card--selected'));
});

test('the create-Work form stays closed until its button is pressed', () => {
  const boardState = [
    { works: [], open_decisions: [] },
    [],
    Date.parse('2026-09-23T00:00:00.000Z'),
    null,
    'connected',
    { title: '', summary: '', size: 'normal', project_id: null },
    false,
    null,
    null,
  ];
  const closed = createHookHarness(boardState).render(boardComponentModule.BoardView).html;
  assert.ok(!closed.includes('id="create-work-panel"'), 'the form should be hidden by default');
  assert.ok(closed.includes('aria-expanded="false"'), 'a toggle button should be offered');
  const open = createHookHarness([...boardState, true]).render(boardComponentModule.BoardView).html;
  assert.ok(open.includes('id="create-work-panel"'), 'the form should show once opened');
  assert.ok(open.includes('aria-expanded="true"'));
});

test('Work detail enables pause or resume and cancellation only in supported states', async () => {
  const client = loadApiClient();
  const originalFetch = globalThis.fetch;
  try {
    for (const state of ['running', 'paused', 'cancelled']) {
      const id = `work-actions-${state}`;
      globalThis.fetch = (input) => successfulApiFetch(input, { state, size: 'small' });
      const board = renderBoardWorkLink({
        id,
        title: `Work ${state}`,
        state,
        updated_at: '2026-09-23T00:00:00.000Z',
      });
      const screen = await renderDetailFromRoute(board.href, client);
      const buttonTag = (label) => screen.html.match(new RegExp(`<button\\b[^>]*>${label}<\\/button>`))?.[0] ?? null;
      if (state === 'running') {
        assert.ok(buttonTag('Pause'));
        assert.ok(buttonTag('Abort'));
        assert.equal(buttonTag('Resume'), null);
      } else if (state === 'paused') {
        assert.ok(buttonTag('Resume'));
        assert.ok(buttonTag('Abort'));
        assert.equal(buttonTag('Pause'), null);
      } else {
        assert.equal(buttonTag('Pause'), null);
        assert.equal(buttonTag('Resume'), null);
        assert.equal(buttonTag('Abort'), null);
        assert.ok(buttonTag('Archive'));
        assert.ok(buttonTag('Delete'));
      }
      for (const label of ['Pause', 'Resume', 'Abort']) {
        const button = buttonTag(label);
        if (button) assert.doesNotMatch(button, /disabled/u);
      }
      assert.doesNotMatch(screen.html, /operation is not yet available|currently in preparation/u);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cancelled Works appear in their own Board section, separate from completed Works', () => {
  assert.equal(actualFormatModule.boardSectionOf('completed'), 'done');
  assert.equal(actualFormatModule.boardSectionOf('cancelled'), 'cancelled');

  const harness = createHookHarness([
    {
      works: [
        { id: 'completed-work', title: 'Completed Work', state: 'completed', updated_at: '2026-09-23T00:00:00.000Z' },
        { id: 'cancelled-work', title: 'Cancelled Work', state: 'cancelled', updated_at: '2026-09-23T00:00:00.000Z' },
      ],
      open_decisions: [],
    },
    [],
    Date.parse('2026-09-23T00:00:00.000Z'),
    null,
    'connected',
    { title: '', summary: '', size: 'normal', project_id: null },
    false,
    null,
    null,
  ]);
  const { html } = harness.render(boardComponentModule.BoardView);
  const section = (name) => html.match(new RegExp(`<section class="section"[^>]*aria-labelledby="sec-${name}"[\\s\\S]*?<\\/section>`))?.[0] ?? '';

  assert.match(section('done'), /Completed Work/);
  assert.doesNotMatch(section('done'), /Cancelled Work/);
  assert.match(section('cancelled'), /Cancelled Work/);
  assert.doesNotMatch(section('cancelled'), /Completed Work/);
});

test('the historical Slack mrkdwn Work opens from its board card with usable details', async () => {
  const client = loadApiClient();
  const originalFetch = globalThis.fetch;
  const id = 'slack-mrkdwn-work';
  const title = 'Slack返信をSlack mrkdwn記法で出力する';
  const summary = 'Render the reply using Slack mrkdwn.';
  globalThis.fetch = (input) => successfulApiFetch(input, { state: 'running', size: 'normal', taskRows: progressTasks });
  try {
    const board = renderBoardWorkLink({
      id,
      title,
      state: 'running',
      updated_at: '2026-09-23T00:00:00.000Z',
    });
    assert.ok(board.html.includes(title));

    const screen = await renderDetailFromRoute(board.href, client);
    assert.equal(screen.requestedId, id);
    assert.equal(screen.detail.work.title, title);
    assert.equal(screen.detail.work.summary, summary);
    assert.equal(screen.detail.work.state, 'running');
    assert.equal(screen.detail.work.size, 'normal');
    assert.ok(screen.html.includes(`<h1 class="page__title panel__heading">${title}</h1>`));
    assert.ok(screen.html.includes(summary));
    assert.ok(screen.html.includes('Running'));
    assert.ok(screen.html.includes('<strong>40%</strong>'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('newly created Works of every size open with an empty but visible progress screen', async () => {
  const client = loadApiClient();
  const originalFetch = globalThis.fetch;
  try {
    for (const size of workSizes) {
      const id = `created-work-${size}`;
      const title = `New ${size} Work`;
      const summary = 'Created moments ago.';
      let createdRecord = null;
      globalThis.fetch = (input, init = {}) => {
        const url = new URL(String(input), 'http://owl.test');
        if (url.pathname === '/api/v1/runtime-config.json') {
          return jsonResponse({ base_path: '/owl/', api_base: '/api/v1', ws_url: '/api/v1/events', schema_version: '1.0.0' });
        }
        if (url.pathname === '/api/v1/works' && init.method === 'POST') {
          const command = JSON.parse(String(init.body));
          assert.equal(command.payload.title, title);
          assert.equal(command.payload.summary, summary);
          assert.equal(command.payload.size, size);
          createdRecord = apiWork({ id, title, summary, state: 'memo', size });
          return jsonResponse({
            request_id: 'request-create',
            data: { work_id: id, state: 'memo', state_version: 1 },
            version: 1,
          });
        }
        if (url.pathname.endsWith('/tasks') || url.pathname === '/api/v1/agents' || url.pathname === '/api/v1/decisions') {
          return jsonResponse(listPage());
        }
        if (url.pathname === `/api/v1/works/${id}`) {
          assert.ok(createdRecord, 'the Work detail request should follow the successful create request');
          return jsonResponse({
            request_id: 'request-1',
            data: createdRecord,
            version: 7,
          });
        }
        throw new Error(`Unexpected fresh Work request: ${url.pathname}${url.search}`);
      };

      const created = await client.createWork({ title, summary, size, project_id: null });
      assert.equal(created.work_id, id);
      assert.equal(created.state, 'memo');
      const board = renderBoardWorkLink({
        id: created.work_id,
        title,
        state: created.state,
        updated_at: '2026-09-23T00:00:00.000Z',
      });
      const screen = await renderDetailFromRoute(board.href, client);
      assert.equal(screen.requestedId, id);
      assert.equal(screen.detail.work.size, size);
      assert.deepEqual(screen.detail.tasks, []);
      assert.ok(screen.html.includes(title));
      assert.ok(screen.html.includes(summary));
      assert.ok(screen.html.includes('Memo'));
      assert.ok(screen.html.includes('<strong>0%</strong>'));
      assert.ok(screen.html.includes('0 of 0 tasks completed'));
      assert.ok(screen.html.includes('No tasks yet'));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('empty Work details render for every size and Work state with safe zero progress', async () => {
  const client = loadApiClient();
  const originalFetch = globalThis.fetch;
  try {
    for (const size of workSizes) {
      for (const state of workStates) {
        const id = `fresh-empty-${size}-${state}`;
        const title = `Fresh ${size} Work in ${state}`;
        const summary = `No tasks exist yet for ${size}/${state}.`;
        globalThis.fetch = (input) => successfulApiFetch(input, {
          state,
          size,
          taskRows: [],
          title,
          summary,
        });

        const board = renderBoardWorkLink({
          id,
          title,
          state,
          updated_at: '2026-09-23T00:00:00.000Z',
        });
        assert.ok(!board.href.includes('undefined'), 'a Work card href must contain its Work id');
        const screen = await renderDetailFromRoute(board.href, client);

        assert.equal(screen.requestedId, id);
        assert.equal(screen.detail.work.title, title);
        assert.equal(screen.detail.work.summary, summary);
        assert.equal(screen.detail.work.state, state);
        assert.equal(screen.detail.work.size, size);
        assert.deepEqual(screen.detail.work.progress, { total_tasks: 0, completed_tasks: 0, percent: 0 });
        assert.deepEqual(screen.detail.tasks, []);
        assert.ok(screen.html.includes(`<h1 class="page__title panel__heading">${title}</h1>`));
        assert.ok(screen.html.includes(summary));
        assert.ok(screen.html.includes(workStateDisplayNames[state] ?? state));
        assert.ok(screen.html.includes('<strong>0%</strong>'));
        assert.ok(screen.html.includes('0 of 0 tasks completed'));
        assert.ok(screen.html.includes('No tasks yet'));
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the detail screen renders every task status and keeps unknown statuses readable', async () => {
  const client = loadApiClient();
  const originalFetch = globalThis.fetch;
  const id = 'work-with-all-task-states';
  const statuses = [...Object.keys(taskStateDisplayNames), 'queued_backend_state'];
  const taskRows = statuses.map((status, index) => ({
    id: `task-${index}`,
    work_id: id,
    title: `Task ${status}`,
    status,
    type: 'code',
    state_version: 1,
    updated_at: '2026-09-23T00:00:00.000Z',
  }));
  globalThis.fetch = (input) => successfulApiFetch(input, {
    state: 'running',
    size: 'large',
    taskRows,
  });
  try {
    const board = renderBoardWorkLink({
      id,
      title: 'Work with mixed task states',
      state: 'running',
      updated_at: '2026-09-23T00:00:00.000Z',
    });
    const screen = await renderDetailFromRoute(board.href, client);
    assert.equal(screen.detail.tasks.length, statuses.length);
    for (const status of statuses) {
      assert.ok(screen.html.includes(status === 'queued_backend_state' ? status : taskStateDisplayNames[status]));
    }
    // The cancelled Task was superseded by a replan and is not counted.
    assert.ok(screen.html.includes('<strong>10%</strong>'));
    assert.ok(screen.html.includes('1 of 10 tasks completed'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normalizes null, missing, or malformed Work payloads and unexpected collections safely', () => {
  const detail = normalizeWorkDetailData({
    work: { title: 'Partial API record', state: 'new_backend_state', summary: null },
    tasks: [null, { id: 'task-1', title: 'Task with unknown status', status: 'queued_backend_state' }],
    runs: { unexpected: true },
    reports: [
      null,
      { id: 'report-1', result: 'new_result', payload: { changes: [null, { file: 'safe.ts', action: 'added' }] } },
    ],
    decisions: [{ options: [null, { key: 'go', label: 'Go' }] }],
    messages: [null, { body: 'message', attachment_ids: [null, 'attachment-1'] }],
  }, 'requested-id');

  assert.equal(detail.work.id, 'requested-id');
  assert.equal(detail.work.title, 'Partial API record');
  assert.equal(detail.work.summary, '');
  assert.equal(detail.work.state, 'new_backend_state');
  assert.equal(detail.tasks.length, 1);
  assert.equal(detail.tasks[0].status, 'queued_backend_state');
  assert.deepEqual(detail.runs, []);
  assert.equal(detail.reports.length, 1);
  assert.deepEqual(detail.reports[0].payload.changes, [{ file: 'safe.ts', action: 'added' }]);
  assert.deepEqual(detail.decisions[0].options, [{ key: 'go', label: 'Go' }]);
  assert.deepEqual(detail.messages[0].attachment_ids, ['attachment-1']);

  for (const value of [null, undefined, [], 'malformed aggregate', {}, { work: null }, { work: [] }, { work: 'malformed', tasks: null }]) {
    const fallback = normalizeWorkDetailData(value, 'work-id');
    assert.equal(fallback.work.id, 'work-id');
    assert.equal(fallback.work.title, 'work-id');
    assert.equal(fallback.work.summary, '');
    assert.equal(fallback.work.state, 'unknown');
    assert.equal(fallback.work.size, 'normal');
    assert.deepEqual(fallback.tasks, []);
  }
});

test('normalizes absent detail fields and malformed report payloads into displayable values', () => {
  const detail = normalizeWorkDetailData({
    work: {
      id: 'partial-work',
      title: null,
      summary: null,
      state: 'future_backend_state',
      size: 'future_backend_size',
      progress: null,
    },
    tasks: null,
    reports: [
      { id: 'missing-payload' },
      { id: 'null-payload', payload: null },
      { id: 'bad-payload', payload: 'not-an-object' },
    ],
    payload: null,
  }, 'requested-work');

  assert.equal(detail.work.id, 'partial-work');
  assert.equal(detail.work.title, 'partial-work');
  assert.equal(detail.work.summary, '');
  assert.equal(detail.work.state, 'future_backend_state');
  assert.equal(detail.work.size, 'normal');
  assert.deepEqual(detail.tasks, []);
  assert.deepEqual(detail.work.progress, { total_tasks: 0, completed_tasks: 0, percent: 0 });
  assert.ok(detail.work.title.trim().length > 0, 'the normalized title should be displayable');
  assert.equal(typeof detail.work.summary, 'string', 'the normalized summary should be displayable');
  assert.ok(detail.work.state.trim().length > 0, 'the normalized status should be displayable');
  assert.ok(Number.isFinite(detail.work.progress.percent), 'the normalized progress should be displayable');
  for (const report of detail.reports) {
    assert.deepEqual(report.payload, { changes: [], remaining_issues: [], verification: { passed: false, method: '' } });
  }

  assert.equal(asReportEnvelope(null).schema_version, '1.0.0');
  assert.deepEqual(asReportEnvelope(undefined).changes, []);
});

test('partially populated detail responses render required fields and derive missing progress', async () => {
  const client = loadApiClient();
  const originalFetch = globalThis.fetch;
  const id = 'partial-detail';
  const workData = {
    id,
    title: 'Partially populated Work',
    summary: null,
    state: 'future_backend_state',
    size: 'normal',
  };
  try {
    globalThis.fetch = (input) => successfulApiFetch(input, { workData });
    const board = renderBoardWorkLink({
      id,
      title: workData.title,
      state: workData.state,
      updated_at: '2026-09-23T00:00:00.000Z',
    });
    const screen = await renderDetailFromRoute(board.href, client);
    assert.ok(screen.detail);
    assert.equal(screen.detail.work.title, workData.title);
    assert.equal(screen.detail.work.state, workData.state);
    assert.ok(screen.html.includes(`<h1 class="page__title panel__heading">${workData.title}</h1>`));
    assert.ok(screen.html.includes('class="wsum__text">—</p>'), 'a missing summary should display a placeholder');
    assert.ok(screen.html.includes(workData.state));
    assert.ok(screen.html.includes('<strong>0%</strong>'));
    assert.ok(screen.html.includes('0 of 0 tasks completed'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Overview header places the number and state badges in the meta row and renders inline code only in the full summary', async () => {
  const client = loadApiClient();
  const originalFetch = globalThis.fetch;
  const id = 'overview-layout';
  const summary = '依頼: `npm test` を実行する\n\n受け入れ条件:\n- `done` になる';
  const workData = { id, display_number: 5, title: 'Overview layout Work', summary, state: 'ready', size: 'normal' };
  try {
    globalThis.fetch = (input) => successfulApiFetch(input, { workData });
    const board = renderBoardWorkLink({ id, title: workData.title, state: workData.state, updated_at: '2026-09-23T00:00:00.000Z' });
    const screen = await renderDetailFromRoute(board.href, client);
    const html = screen.html;
    const meta = html.match(/<div class="work-head__meta">(.*?)<\/div>/s);
    assert.ok(meta, 'the meta row should render');
    assert.ok(meta[1].includes('Work #5'), 'the meta row should hold the Work number badge');
    assert.ok(meta[1].includes('Ready'), 'the meta row should hold the state badge');
    assert.ok(html.includes(`<h1 class="page__title panel__heading">${workData.title}</h1>`), 'the heading should hold only the title');
    assert.ok(/<h2 class="panel__title" id="sec-overview">Overview<\/h2>/.test(html), 'the Overview heading should have no badge');
    assert.ok(html.includes('<code class="wsum__code">npm test</code>'));
    assert.ok(html.includes('<code class="wsum__code">done</code>'), 'acceptance items should render inline code');

    const compact = renderToStaticMarkup(React.createElement(workSummaryBlockModule.WorkSummaryBlock, { summary, variant: 'compact' }));
    assert.ok(compact.includes('wsum--compact'));
    assert.ok(!compact.includes('wsum__code'), 'the compact variant should stay plain text');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('malformed detail envelopes and missing required Work fields show a visible error', async () => {
  const client = loadApiClient();
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  console.error = () => {};
  const cases = [
    ['null-detail', null],
    ['missing-data', undefined],
    ['non-object-detail', 'malformed record'],
    ['array-detail', []],
    ['scalar-detail', 23],
    ['wrong-id', { id: 'another-work', title: 'Wrong Work', state: 'ready' }],
    ['missing-title', { id: 'missing-title', state: 'ready' }],
    ['missing-state', { id: 'missing-state', title: 'No state' }],
  ];
  try {
    for (const [id, workData] of cases) {
      globalThis.fetch = (input) => successfulApiFetch(input, { workData });
      const board = renderBoardWorkLink({
        id,
        title: `Work ${id}`,
        state: 'memo',
        updated_at: '2026-09-23T00:00:00.000Z',
      });
      const screen = await renderDetailFromRoute(board.href, client);
      assert.equal(screen.detail, null, `${id} should not be presented as a successful detail`);
      assert.equal(screen.requestError?.code, 'invalid_response');
      assert.ok(screen.html.includes('role="alert"'));
      assert.ok(screen.html.includes('The server returned invalid Work data.'));
      assert.match(screen.html, /<a\b[^>]*href="\/board"/);
      assert.ok(screen.html.trim().length > 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test('humanizes Work detail network, timeout, malformed-response, and server error codes', () => {
  const translate = (key) => key;
  assert.equal(humanizeWorkDetailError(new Error('network_error'), translate), 'work.errorNetwork');
  assert.equal(humanizeWorkDetailError(new Error('request_timeout'), translate), 'work.errorNetwork');
  assert.equal(humanizeWorkDetailError(new Error('core_not_ready'), translate), 'work.errorNetwork');
  assert.equal(humanizeWorkDetailError(new Error('invalid_query'), translate), 'work.errorInvalidResponse');
  assert.equal(humanizeWorkDetailError(new Error('version_conflict'), translate), 'work.errorVersionConflict');
  assert.equal(humanizeWorkDetailError(new Error('task_not_found'), translate), 'work.errorDefault');
  assert.equal(humanizeWorkDetailError(new Error('server_error'), translate), 'work.errorDefault');
  assert.equal(humanizeWorkDetailError({ code: 'server_error' }, translate), 'work.errorDefault');
});

test('network, HTTP 500, and malformed JSON detail responses become visible UI error text', async () => {
  const client = loadApiClient();
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const messages = {
    'work.errorNetwork': 'Could not connect to the server.',
    'work.errorInvalidResponse': 'The server returned invalid Work data.',
    'work.errorDefault': 'Work details could not be loaded.',
  };
  const translate = (key) => messages[key] ?? key;

  console.error = () => {};
  try {
    for (const [mode, expectedMessage] of [
      ['network', messages['work.errorNetwork']],
      ['http', messages['work.errorDefault']],
      ['malformed-json', messages['work.errorInvalidResponse']],
    ]) {
      globalThis.fetch = (input) => failingApiFetch(input, mode);
      const visibleError = await client.getWorkDetail(`error-${mode}`).then(
        () => null,
        (error) => humanizeWorkDetailError(error, translate),
      );
      assert.equal(visibleError, expectedMessage, `${mode} errors should produce readable UI text`);
      assert.ok(visibleError.trim().length > 0, `${mode} errors must not leave the detail screen blank`);
    }

    globalThis.fetch = (input) => failingApiFetch(input, 'not-found');
    assert.equal(await client.getWorkDetail('missing-work'), null, 'a 404 is a deliberate not-found screen state');
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test('API failures display an error and a way back instead of a blank detail screen', async () => {
  const client = loadApiClient();
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    for (const [mode, expectedMessage] of [
      ['network', 'Could not connect to the server.'],
      ['http', 'Work details could not be loaded.'],
      ['malformed-json', 'The server returned invalid Work data.'],
    ]) {
      globalThis.fetch = (input) => failingApiFetch(input, mode);
      const id = `visible-error-${mode}`;
      const board = renderBoardWorkLink({
        id,
        title: `Error case ${mode}`,
        state: 'memo',
        updated_at: '2026-09-23T00:00:00.000Z',
      });
      const screen = await renderDetailFromRoute(board.href, client);
      assert.ok(screen.requestError, `${mode} should reject the detail request`);
      assert.ok(screen.html.includes('class="error"'), `${mode} should render an error element`);
      assert.ok(screen.html.includes(expectedMessage), `${mode} should show readable error text`);
      assert.match(screen.html, /<a\b[^>]*href="\/board"/, `${mode} should provide a link back to the Work list`);
      assert.ok(screen.html.trim().length > 0, `${mode} must not leave a blank detail screen`);
    }

    globalThis.fetch = (input) => failingApiFetch(input, 'not-found');
    const missingBoard = renderBoardWorkLink({
      id: 'missing-work',
      title: 'Missing Work',
      state: 'memo',
      updated_at: '2026-09-23T00:00:00.000Z',
    });
    const missingScreen = await renderDetailFromRoute(missingBoard.href, client);
    assert.equal(missingScreen.detail, null);
    assert.ok(missingScreen.html.includes('Work not found'));
    assert.ok(missingScreen.html.includes('No Work exists with id missing-work.'));
    assert.match(missingScreen.html, /<a\b[^>]*href="\/board"/, '404 should provide a link back to the Work list');
    assert.ok(missingScreen.html.trim().length > 0, '404 must render a not-found message instead of a blank page');
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test('the Work route error boundary displays a message and a return link', () => {
  const harness = createHookHarness([]);
  const { html } = harness.render(workErrorModule.default, {
    error: new Error('render failed'),
    reset: () => {},
  });
  assert.ok(html.includes('role="alert"'));
  assert.ok(html.includes('The Work details could not be displayed. Please try again.'));
  assert.match(html, /<a\b[^>]*href="\/board"/);
});

test('Work detail links encode IDs and target the detail route', () => {
  assert.equal(workDetailHref('01J00000000000000000000000'), '/work?id=01J00000000000000000000000');
  assert.equal(workDetailHref('with / and?reserved'), '/work?id=with%20%2F%20and%3Freserved');
});

test('Board links, Work route page, and error boundary match the route directory', () => {
  const appDirectory = join(repoRoot, 'apps/web/app');
  const boardViewPath = join(repoRoot, 'apps/web/components/BoardView.tsx');
  const workRouteDirectory = join(appDirectory, 'work');
  const workRoutePagePath = join(workRouteDirectory, 'page.tsx');
  const workErrorPath = join(workRouteDirectory, 'error.tsx');

  assert.equal(existsSync(workErrorPath), true, 'the Work route should have a route error boundary');
  assert.equal(existsSync(workRoutePagePath), true, 'the Work detail route directory should contain page.tsx');

  const boardViewSource = readFileSync(boardViewPath, 'utf8');
  const workRoutePageSource = readFileSync(workRoutePagePath, 'utf8');
  assert.match(boardViewSource, /import\s*\{\s*workDetailHref\s*\}\s*from\s*['"]@\/lib\/work-detail-safety\.mjs['"]/u);
  assert.match(boardViewSource, /href=\{workDetailHref\(work\.id\)\}/u);
  assert.match(workRoutePageSource, /WorkDetailView/u, 'the /work route should render the Work detail view');

  const actualRoutePath = `/${workRouteDirectory.slice(appDirectory.length + 1).replaceAll('\\', '/')}`;
  const linkedRoutePath = new URL(workDetailHref('route-check'), 'http://owl.test').pathname;
  assert.equal(linkedRoutePath, actualRoutePath, 'Board links should resolve to the route directory containing page.tsx');
});

test('English and Japanese Work detail error strings define the same keys', () => {
  const english = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8'));
  const japanese = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8'));
  const detailErrorKeys = (work) => Object.keys(work)
    .filter((key) => key.startsWith('error') || key === 'notFound' || key === 'notFoundDetail')
    .sort();

  const englishKeys = detailErrorKeys(english.work);
  assert.ok(englishKeys.includes('errorNetwork'));
  assert.ok(englishKeys.includes('errorInvalidResponse'));
  assert.ok(englishKeys.includes('errorVersionConflict'));
  assert.ok(englishKeys.includes('errorDefault'));
  assert.ok(englishKeys.includes('notFound'));
  assert.ok(englishKeys.includes('notFoundDetail'));
  assert.deepEqual(detailErrorKeys(japanese.work), englishKeys);
  for (const key of englishKeys) {
    assert.equal(typeof english.work[key], 'string', `English work.${key} should be a string`);
    assert.equal(typeof japanese.work[key], 'string', `Japanese work.${key} should be a string`);
    assert.ok(english.work[key].trim().length > 0, `English work.${key} should not be empty`);
    assert.ok(japanese.work[key].trim().length > 0, `Japanese work.${key} should not be empty`);
  }
});

test('Work detail puts the shared conversation first, with no legacy Bubble/composer', () => {
  const source = readFileSync(join(repoRoot, 'apps/web/components/WorkDetailView.tsx'), 'utf8');
  const css = readFileSync(join(repoRoot, 'apps/web/app/globals.css'), 'utf8');
  assert.ok(source.indexOf('sec-conversation') < source.indexOf('sec-overview'), 'conversation precedes the overview');
  assert.match(source, /<WorkConversation work=\{work\} variant="page" conversation=\{shownConversation\}/);
  assert.doesNotMatch(source, /Bubble|className="composer"|sendWorkInstruction/);
  assert.match(css, /\.work-detail__conversation \{[^}]*height: min\(560px, calc\(100vh - 240px\)\)/);
  const bg = (sel) => css.match(new RegExp(`\\.turn--${sel} \\{[^}]*background: ([^;]+);`))?.[1];
  assert.ok(bg('advisor'), 'advisor turn has a background');
  assert.equal(bg('manager'), bg('advisor'), 'Manager turn background matches Advisor');
});

test("Work detail never shows another Work's conversation and surfaces conversation load errors", () => {
  const source = readFileSync(join(repoRoot, 'apps/web/components/WorkDetailView.tsx'), 'utf8');
  assert.match(source, /setConversation\(null\);\s*setConversationError\(false\);/, 'cleared on Work switch');
  assert.match(source, /conversation\?\.workId === id/, "only the current Work's conversation is shown");
  assert.doesNotMatch(source, /getWorkConversation\(id\)\.catch\(\(\) => null\)/);
  assert.match(source, /setConversationError\(true\)/);
  assert.match(source, /role="alert"[\s\S]*work\.conversationLoadError[\s\S]*onClick=\{\(\) => reloadRef\.current\(\)\}[\s\S]*work\.retry/);
  assert.match(source, /\(shownConversation \|\| !conversationError\) && \(/, 'first-load failure is not shown as an empty conversation');
});

test('shared conversation keeps the send restrictions the detail page relied on', () => {
  const source = readFileSync(join(repoRoot, 'apps/web/components/WorkConversation.tsx'), 'utf8');
  assert.match(source, /disabled = block\.blocked \|\| sending/);
  assert.match(source, /block\.reopen && !window\.confirm/);
  assert.match(source, /reopen: block\.reopen, expectedVersion: work\.state_version/);
});

test('the panel conversation poll retries after a failed fetch and stops on cleanup', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalGet = componentApiClient.getWorkConversation;
  const originalError = console.error;
  const timers = [];
  let calls = 0;
  globalThis.setTimeout = (fn, ms) => (ms === 3000 ? timers.push(fn) : originalSetTimeout(fn, ms));
  console.error = () => {};
  componentApiClient.getWorkConversation = async () => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return { messages: [] };
  };
  const settle = () => new Promise((resolve) => originalSetTimeout(resolve, 0));
  try {
    const harness = createHookHarness();
    const { effects } = harness.render(previewComponentModule.WorkPreviewPanel, { workId: 'w1', onBack: () => {}, withConversation: true });
    const [cleanup] = harness.runEffects([effects[0]]);
    await settle();
    assert.equal(calls, 1);
    assert.equal(timers.length, 1, 'a failed fetch should still schedule the next poll');
    timers.shift()();
    await settle();
    assert.equal(calls, 2, 'the poll should retry after the failure');
    assert.equal(timers.length, 1);
    cleanup();
    timers.shift()();
    await settle();
    assert.equal(timers.length, 0, 'no poll may be scheduled after cleanup');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    console.error = originalError;
    componentApiClient.getWorkConversation = originalGet;
  }
});

test('the panel conversation poll drops a stale fetch that finishes last and keeps one timer', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalGet = componentApiClient.getWorkConversation;
  const live = new Map();
  let nextId = 0;
  globalThis.setTimeout = (fn, ms) => {
    if (ms !== 3000) return originalSetTimeout(fn, ms);
    live.set(++nextId, fn);
    return nextId;
  };
  globalThis.clearTimeout = (id) => (live.delete(id), originalClearTimeout(id));
  const pending = [];
  componentApiClient.getWorkConversation = () => new Promise((resolve) => pending.push(resolve));
  const settle = () => new Promise((resolve) => originalSetTimeout(resolve, 0));
  const props = { workId: 'w1', onBack: () => {}, withConversation: true };
  const shown = (harness) => {
    harness.render(previewComponentModule.WorkPreviewPanel, props);
    return panelConversationProps.current.conversation;
  };
  try {
    const harness = createHookHarness([
      normalizeWorkDetailData({ work: { id: 'w1', title: 'W', state: 'running', progress: {} } }, 'w1'),
    ]);
    const { effects } = harness.render(previewComponentModule.WorkPreviewPanel, props);
    const [cleanup] = harness.runEffects([effects[0]]);
    const { onWorkChanged } = panelConversationProps.current;
    onWorkChanged(); // reload while fetch A is still in flight => fetch B
    assert.equal(pending.length, 2);
    pending[1]({ workId: 'w1', messages: ['B'] });
    await settle();
    assert.deepEqual(shown(harness).messages, ['B']);
    assert.equal(live.size, 1, 'only the latest fetch schedules the next poll');
    pending[0]({ workId: 'w1', messages: ['A'] });
    await settle();
    assert.deepEqual(shown(harness).messages, ['B'], 'the stale fetch must not overwrite the newer conversation');
    assert.equal(live.size, 1, 'the stale fetch must not add a timer');
    cleanup();
    assert.equal(live.size, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    componentApiClient.getWorkConversation = originalGet;
  }
});
