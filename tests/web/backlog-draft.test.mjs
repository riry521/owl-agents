import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { backlogLocation, backlogWorkDraft } from '../../apps/web/lib/backlog-draft.mjs';
import { backlogStatusBadge, linkableWorks, showsLinkedWork } from '../../apps/web/lib/backlog-link.mjs';

import { repoRoot } from '../helpers/paths.mjs';
const apiClientPath = join(repoRoot, 'apps/web/lib/api-client.ts');
const translations = {
  'backlog.item.general': '(no file)',
  'backlog.issue.defaultTitleOne': 'Address review finding: {{problem}}',
  'backlog.issue.defaultTitleMany': 'Address {{count}} minor review findings',
  'backlog.issue.summaryRequest': 'Address {{count}} minor review findings kept in the backlog.',
  'backlog.issue.summarySource': 'Source: Work #{{number}} {{work}} / Task {{task}}',
  'backlog.issue.summaryAcceptanceResolved': 'Every finding above is resolved',
  'backlog.issue.summaryAcceptanceTests': 'Existing tests pass',
  'backlog.item.reason': 'Reason',
  'backlog.item.suggestion': 'Suggestion',
};

function t(key, params = {}) {
  return (translations[key] ?? key).replace(/\{\{(\w+)\}\}/gu, (_match, name) => String(params[name] ?? ''));
}

function item(overrides = {}) {
  return {
    id: '01J00000000000000000000001',
    work_id: '01J00000000000000000000002',
    work_title: 'Improve login',
    work_display_number: 12,
    task_id: '01J00000000000000000000003',
    task_title: 'Validate form',
    project_id: '01J00000000000000000000004',
    project_name: 'Owl',
    review_id: '01J00000000000000000000005',
    review_round: 1,
    file: 'apps/web/login.tsx',
    line: 42,
    problem: 'Error text is repeated',
    reason: 'Three copies can drift apart',
    suggestion: 'Move it to i18n',
    status: 'open',
    issued_work_id: null,
    issued_work_title: null,
    issued_work_display_number: null,
    created_at: '2026-09-27T01:23:45.678Z',
    updated_at: '2026-09-27T01:23:45.678Z',
    ...overrides,
  };
}

function loadApiClient() {
  const { outputText } = ts.transpileModule(readFileSync(apiClientPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(apiClientPath);
  loaded.filename = apiClientPath;
  loaded.paths = Module._nodeModulePaths(dirname(apiClientPath));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@/lib/format') return { runOrdinals: (runs) => new Map(runs.map((run) => [run.id, 1])) };
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

test('backlogLocation renders an explicit file, line, or localized no-file label', () => {
  assert.equal(backlogLocation(item(), t), 'apps/web/login.tsx:42');
  assert.equal(backlogLocation(item({ line: 0 }), t), 'apps/web/login.tsx');
  assert.equal(backlogLocation(item({ file: '' }), t), '(no file)');
});

test('backlogWorkDraft uses localized summary labels and omits blank reason and suggestion rows', () => {
  const draft = backlogWorkDraft([item({ reason: '', suggestion: '' })], 'en', t);

  assert.equal(draft.title, 'Address review finding: Error text is repeated');
  assert.equal(draft.summary, [
    'Request: Address 1 minor review findings kept in the backlog.',
    '',
    'Background:',
    '1. apps/web/login.tsx:42 — Error text is repeated',
    '   Source: Work #12 Improve login / Task Validate form',
    '',
    'Acceptance:',
    '- Every finding above is resolved',
    '- Existing tests pass',
  ].join('\n'));
});

test('backlogWorkDraft makes one and many item titles and truncates a long first problem line to 80 characters', () => {
  const longProblem = `${'x'.repeat(90)}\nsecond line`;
  const one = backlogWorkDraft([item({ problem: longProblem })], 'en', t);
  const many = backlogWorkDraft([item(), item({ id: 'other' })], 'en', t);

  assert.equal(one.title, `Address review finding: ${'x'.repeat(79)}…`);
  assert.equal(many.title, 'Address 2 minor review findings');
});

test('backlogWorkDraft caps the title at 500 characters', () => {
  const draft = backlogWorkDraft([item()], 'en', (key) => key === 'backlog.issue.defaultTitleOne' ? 'x'.repeat(700) : t(key));
  assert.equal(draft.title.length, 500);
});

test('backlogWorkDraft keeps the summary under 20,000 characters and marks omitted trailing findings', () => {
  const findings = [1, 2, 3].map((number) => item({
    id: `item-${number}`,
    file: `src/file-${number}.ts`,
    problem: 'p'.repeat(11_000),
    reason: '',
    suggestion: '',
  }));
  const draft = backlogWorkDraft(findings, 'en', t);

  assert.ok(draft.summary.length <= 20_000);
  assert.ok(draft.summary.includes('1. src/file-1.ts:42 — '));
  assert.ok(draft.summary.includes('…\n\nAcceptance:'));
  assert.ok(!draft.summary.includes('2. src/file-2.ts'));
});

test('backlogWorkDraft keeps a single over-long finding within 20,000 characters including the omission mark', () => {
  const draft = backlogWorkDraft([item({ problem: 'p'.repeat(30_000), reason: '', suggestion: '' })], 'en', t);

  assert.equal(draft.summary.length, 20_000);
  assert.ok(draft.summary.includes('…\n\nAcceptance:'));
});

test('ja and en expose the same backlog translation keys', () => {
  const ja = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8'));
  const en = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8'));
  const flatten = (value, prefix = '') => Object.entries(value).flatMap(([key, child]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === 'object' && !Array.isArray(child)
      ? flatten(child, fullKey)
      : [fullKey];
  });
  const backlogKeys = (messages) => [
    'nav.backlog',
    ...flatten(messages.backlog, 'backlog'),
  ].sort();

  assert.deepEqual(backlogKeys(ja), backlogKeys(en));
  assert.ok(backlogKeys(ja).length > 1);
});

test('backlog API client uses the v1 paths, command envelope, and trimmed issue-work text', async () => {
  const { dismissBacklogItems, issueBacklogWork, listBacklog, listWorkBacklog } = loadApiClient();
  const calls = [];
  const backlog = [item()];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://owl.test');
    calls.push({ url, init });
    if (url.pathname === '/api/v1/runtime-config.json') {
      return new Response(JSON.stringify({ base_path: '/owl/', api_base: '/api/v1', ws_url: '/api/v1/ws', schema_version: '1.0.0' }), { status: 200 });
    }
    if (url.pathname === '/api/v1/backlog' && init.method !== 'POST') {
      return new Response(JSON.stringify({ request_id: 'req-list', data: backlog }), { status: 200 });
    }
    if (url.pathname === '/api/v1/works/01J00000000000000000000002/backlog') {
      return new Response(JSON.stringify({ request_id: 'req-work', data: backlog }), { status: 200 });
    }
    if (url.pathname === '/api/v1/backlog/dismiss') {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ request_id: body.request_id, data: { items: backlog }, version: 0 }), { status: 200 });
    }
    if (url.pathname === '/api/v1/backlog/issue-work') {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({
        request_id: body.request_id,
        data: { work_id: '01J00000000000000000000006', display_number: 13, state: 'memo', state_version: 0, project_id: backlog[0].project_id, item_ids: body.payload.item_ids },
        version: 0,
      }), { status: 201 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    assert.deepEqual(await listBacklog({ status: 'open', project_id: backlog[0].project_id }), backlog);
    assert.deepEqual(await listWorkBacklog(backlog[0].work_id), backlog);
    assert.deepEqual(await dismissBacklogItems([backlog[0].id]), backlog);
    const issued = await issueBacklogWork({ item_ids: [backlog[0].id], title: '  Fix findings  ', summary: '  Address them.  ', size: 'normal' });
    assert.equal(issued.work_id, '01J00000000000000000000006');

    const listCall = calls.find(({ url }) => url.pathname === '/api/v1/backlog');
    assert.equal(listCall.url.searchParams.get('status'), 'open');
    assert.equal(listCall.url.searchParams.get('project_id'), backlog[0].project_id);
    const dismissCall = calls.find(({ url }) => url.pathname === '/api/v1/backlog/dismiss');
    const dismissEnvelope = JSON.parse(dismissCall.init.body);
    assert.equal(dismissEnvelope.expected_version, 0);
    assert.deepEqual(dismissEnvelope.payload, { item_ids: [backlog[0].id] });
    const issueCall = calls.find(({ url }) => url.pathname === '/api/v1/backlog/issue-work');
    const issueEnvelope = JSON.parse(issueCall.init.body);
    assert.equal(issueEnvelope.expected_version, 0);
    assert.deepEqual(issueEnvelope.payload, {
      item_ids: [backlog[0].id], title: 'Fix findings', summary: 'Address them.', size: 'normal',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('linkBacklogItems posts item_ids to the Work link path with the command envelope', async () => {
  const { linkBacklogItems } = loadApiClient();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://owl.test');
    calls.push({ url, init });
    if (url.pathname === '/api/v1/runtime-config.json') {
      return new Response(JSON.stringify({ base_path: '/owl/', api_base: '/api/v1', ws_url: '/api/v1/ws', schema_version: '1.0.0' }), { status: 200 });
    }
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({
      request_id: body.request_id,
      data: { work_id: '01J00000000000000000000006', status: 'in_progress', items: [item({ status: 'in_progress' })] },
      version: 0,
    }), { status: 200 });
  };
  try {
    const result = await linkBacklogItems('01J00000000000000000000006', ['a', 'b']);
    assert.equal(result.status, 'in_progress');
    assert.equal(result.items[0].status, 'in_progress');
    const call = calls.find(({ url }) => url.pathname.endsWith('/backlog/link'));
    assert.equal(call.url.pathname, '/api/v1/works/01J00000000000000000000006/backlog/link');
    assert.equal(call.init.method, 'POST');
    assert.deepEqual(JSON.parse(call.init.body).payload, { item_ids: ['a', 'b'] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const messages = {
  ja: JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8')),
  en: JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8')),
};
const enT = (key, params = {}) => key.split('.').reduce((node, part) => node?.[part], messages.en)?.replace?.(/\{\{(\w+)\}\}/gu, (_m, name) => String(params[name] ?? '')) ?? key;

// Runs a client component with a tiny hook harness: state persists across renders, effects re-run when deps change.
function mountClient(modulePath, overrides, props = {}) {
  const slots = [];
  const effectDeps = [];
  let cursor = 0;
  let effectCursor = 0;
  let pending = [];
  const hooks = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useEffect(effect, deps) {
      const index = effectCursor++;
      const previous = effectDeps[index];
      if (previous && deps && deps.every((dep, i) => Object.is(dep, previous[i]))) return;
      effectDeps[index] = deps;
      pending.push(effect);
    },
  };
  const { outputText } = ts.transpileModule(readFileSync(modulePath, 'utf8'), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(modulePath);
  loaded.filename = modulePath;
  loaded.paths = Module._nodeModulePaths(dirname(modulePath));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'react') return hooks;
    if (Object.hasOwn(overrides, request)) return overrides[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, modulePath);
  } finally {
    Module._load = originalLoad;
  }
  const Component = Object.values(loaded.exports).find((value) => typeof value === 'function');
  const render = () => {
    cursor = 0;
    effectCursor = 0;
    pending = [];
    return Component(props);
  };
  // Re-render until effects and their promises settle.
  const settle = async () => {
    let tree = render();
    for (let round = 0; round < 5; round += 1) {
      pending.forEach((effect) => effect());
      await new Promise((resolve) => setImmediate(resolve));
      tree = render();
      if (pending.length === 0) break;
    }
    return tree;
  };
  return { render, settle };
}

function findAll(node, predicate, found = []) {
  if (Array.isArray(node)) {
    node.forEach((child) => findAll(child, predicate, found));
  } else if (node && typeof node === 'object' && node.props) {
    if (predicate(node)) found.push(node);
    findAll(node.props.children, predicate, found);
  }
  return found;
}
const textOf = (node) => (Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node?.props ? textOf(node.props.children) : '');
const html = (tree) => renderToStaticMarkup(React.createElement(React.Fragment, null, tree));

function mountBacklog({ items, works, link }) {
  const listCalls = [];
  const api = {
    ApiRequestError: class extends Error {},
    dismissBacklogItems: async () => {},
    issueBacklogWork: async () => { throw new Error('unused'); },
    linkBacklogItems: link,
    listLinkableWorks: async (projectId) => linkableWorks(works, projectId),
    getBacklogView: async (filters) => {
      listCalls.push(filters);
      return { items: items.filter((entry) => !filters.status || entry.status === filters.status), next_offset: null, projects: [] };
    },
  };
  // Minimal useView: results are cached per key and picked up on the next render.
  const viewCache = new Map();
  const useView = (key, fetcher) => {
    if (key === null) return { data: undefined, error: null, loading: false, refresh: async () => {} };
    const entry = viewCache.get(key);
    if (!entry) {
      const fresh = { data: undefined, error: null };
      viewCache.set(key, fresh);
      fetcher().then((data) => { fresh.data = data; }, (error) => { fresh.error = error; });
    }
    const current = viewCache.get(key);
    return { data: current.data, error: current.error, loading: current.data === undefined, refresh: async () => { viewCache.delete(key); } };
  };
  const view = mountClient(join(repoRoot, 'apps/web/components/BacklogView.tsx'), {
    'next/link': { __esModule: true, default: ({ href, children }) => React.createElement('a', { href }, children) },
    '@/lib/api-client': api,
    '@/lib/view-loader': { useView },
    '@/lib/i18n': { useLocale: () => ({ locale: 'en', t: enT }) },
    '@/lib/backlog-draft.mjs': { backlogLocation, backlogWorkDraft },
    '@/lib/backlog-link.mjs': { backlogStatusBadge, showsLinkedWork },
  });
  return { ...view, listCalls };
}

const workSummary = (id, title, projectId) => ({ id, title, display_number: null, state: 'completed', archived_at: null, project_id: projectId });

test('BacklogView renders in_progress items as "In progress" and filters by that status', async () => {
  const items = [item({ id: 'a', status: 'open' }), item({ id: 'b', status: 'in_progress', issued_work_id: 'w1', issued_work_title: 'Fix it', issued_work_display_number: 7 })];
  const { settle, render, listCalls } = mountBacklog({ items, works: [], link: async () => { throw new Error('unused'); } });
  let tree = await settle();
  assert.equal(listCalls[0].status, 'open');
  assert.doesNotMatch(html(tree), /badge[^>]*>In progress/u);

  const statusSelect = findAll(tree, (node) => node.type === 'select' && node.props.value === 'open')[0];
  assert.ok(findAll(statusSelect, (node) => node.type === 'option' && node.props.value === 'in_progress').length === 1);
  statusSelect.props.onChange({ target: { value: 'in_progress' } });
  tree = await settle();
  assert.equal(listCalls.at(-1).status, 'in_progress');
  const markup = html(tree);
  assert.match(markup, /badge--amber[^>]*>In progress</u);
  assert.match(markup, />#7 Fix it</u);
  assert.doesNotMatch(markup, /Work #7 Fix it/u);
  assert.equal(findAll(tree, (node) => node.type === 'input' && node.props.type === 'checkbox').length, 0);
  assert.ok(render());
});

test('BacklogView links selected items to a Work of the same project and submits them', async () => {
  const items = [item({ id: 'a' }), item({ id: 'b' })];
  const works = [
    workSummary('w-same', 'Same project', items[0].project_id),
    workSummary('w-other', 'Other project', 'other-project'),
    workSummary('w-none', 'No project', null),
  ];
  const linkCalls = [];
  const { settle } = mountBacklog({ items, works, link: async (workId, ids) => { linkCalls.push({ workId, ids }); return { work_id: workId, status: 'done', items: [] }; } });
  let tree = await settle();
  for (const checkbox of findAll(tree, (node) => node.type === 'input' && node.props.type === 'checkbox')) checkbox.props.onChange();
  tree = await settle();
  const linkButton = findAll(tree, (node) => node.type === 'button' && textOf(node) === enT('backlog.actions.link'))[0];
  assert.ok(linkButton);
  linkButton.props.onClick();
  tree = await settle();

  const workSelect = findAll(tree, (node) => node.type === 'select' && findAll(node, (child) => child.type === 'option' && child.props.value === 'w-same').length > 0)[0];
  const optionIds = findAll(workSelect, (node) => node.type === 'option').map((node) => node.props.value);
  assert.deepEqual(optionIds, ['', 'w-same']);
  workSelect.props.onChange({ target: { value: 'w-same' } });
  tree = await settle();
  const form = findAll(tree, (node) => node.type === 'form' && typeof node.props.onSubmit === 'function').at(-1);
  await form.props.onSubmit({ preventDefault() {} });
  tree = await settle();
  assert.deepEqual(linkCalls, [{ workId: 'w-same', ids: ['a', 'b'] }]);
  assert.match(html(tree), /role="status"/u);
});

test('BacklogView offers only Works without a project for items that have no project', async () => {
  const items = [item({ id: 'a', project_id: null, project_name: null })];
  const works = [workSummary('w-project', 'Has project', 'p1'), workSummary('w-none', 'No project', null)];
  const { settle } = mountBacklog({ items, works, link: async () => { throw new Error('unused'); } });
  let tree = await settle();
  findAll(tree, (node) => node.type === 'input' && node.props.type === 'checkbox')[0].props.onChange();
  tree = await settle();
  findAll(tree, (node) => node.type === 'button' && textOf(node) === enT('backlog.actions.link'))[0].props.onClick();
  tree = await settle();
  const workSelect = findAll(tree, (node) => node.type === 'select' && findAll(node, (child) => child.type === 'option' && child.props.value === 'w-none').length > 0)[0];
  assert.deepEqual(findAll(workSelect, (node) => node.type === 'option').map((node) => node.props.value), ['', 'w-none']);
});

test('WorkBacklogSection shows items linked to the Work under their own heading', async () => {
  const own = [item({ id: 'o', status: 'open' })];
  const linked = [item({ id: 'l', status: 'in_progress', issued_work_id: 'w0' })];
  const mount = (ownItems, linkedItems) => mountClient(join(repoRoot, 'apps/web/components/WorkBacklogSection.tsx'), {
    'next/link': { __esModule: true, default: ({ href, children }) => React.createElement('a', { href }, children) },
    '@/lib/api-client': {
      listWorkBacklog: async () => ownItems,
      listBacklog: async (filter) => { assert.deepEqual(filter, { issued_work_id: 'w0' }); return linkedItems; },
    },
    '@/lib/backlog-draft.mjs': { backlogLocation },
    '@/lib/backlog-link.mjs': { backlogStatusBadge, showsLinkedWork },
  }, { workId: 'w0', refreshToken: 0, dismissed: [], t: enT });
  const markup = html(await mount(own, linked).settle());
  assert.match(markup, /badge--amber[^>]*>In progress</u);
  assert.match(markup, /badge--blue[^>]*>Open</u);
  assert.match(markup, /Items this Work addresses/u);
  assert.doesNotMatch(markup, /work\?id=w0/u);
  assert.doesNotMatch(markup, /Work:/u);
  const ownLinked = [item({ id: 'x', status: 'in_progress', issued_work_id: 'w1', issued_work_title: 'Other', issued_work_display_number: 4 })];
  assert.match(html(await mount(ownLinked, []).settle()), /Work:.*href="\/work\?id=w1">#4 Other</u);
  assert.doesNotMatch(html(await mount(own, []).settle()), /Items this Work addresses/u);
  assert.doesNotMatch(html(await mount([], linked).settle()), />Backlog </u);
  assert.equal(html(await mount([], []).settle()), '');
});

test('linkableWorks keeps archived Works, drops cancelled and other-project Works, and orders them', () => {
  const work = (id, state, updated_at, project_id = 'p1', archived_at = null) => ({ id, state, updated_at, project_id, archived_at });
  const works = [
    work('done-new', 'completed', '2026-03-01'),
    work('run-old', 'running', '2026-01-01'),
    work('done-archived', 'completed', '2026-02-01', 'p1', '2026-02-02'),
    work('run-new', 'memo', '2026-02-01'),
    work('cancelled', 'cancelled', '2026-04-01'),
    work('other', 'running', '2026-04-01', 'p2'),
    work('none', 'running', '2026-04-01', null),
  ];
  assert.deepEqual(linkableWorks(works, 'p1').map((w) => w.id), ['run-new', 'run-old', 'done-new', 'done-archived']);
  assert.deepEqual(linkableWorks(works, null).map((w) => w.id), ['none']);
});

test('backlogStatusBadge maps the four statuses and showsLinkedWork needs a linked in_progress or done item', () => {
  assert.deepEqual(['open', 'in_progress', 'done', 'dismissed'].map(backlogStatusBadge), ['badge--blue', 'badge--amber', 'badge--green', 'badge--gray']);
  assert.equal(showsLinkedWork({ status: 'in_progress', issued_work_id: 'w' }), true);
  assert.equal(showsLinkedWork({ status: 'done', issued_work_id: 'w' }), true);
  assert.equal(showsLinkedWork({ status: 'done', issued_work_id: null }), false);
  assert.equal(showsLinkedWork({ status: 'open', issued_work_id: 'w' }), false);
  assert.equal(showsLinkedWork({ status: 'dismissed', issued_work_id: 'w' }), false);
});

test('backlog.status.done says "Done" and never "Issued"', () => {
  assert.equal(messages.ja.backlog.status.done, '対応済み');
  assert.equal(messages.en.backlog.status.done, 'Done');
});

test('ja and en define the same backlog keys including in_progress and link', () => {
  const flatten = (node, prefix = '') => Object.entries(node).flatMap(([key, value]) => (typeof value === 'object' ? flatten(value, `${prefix}${key}.`) : [`${prefix}${key}`]));
  assert.deepEqual(flatten(messages.ja.backlog).sort(), flatten(messages.en.backlog).sort());
  for (const locale of ['ja', 'en']) {
    assert.ok(messages[locale].backlog.status.in_progress);
    assert.ok(messages[locale].backlog.link.submit);
  }
});
