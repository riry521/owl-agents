import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Module } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import { backlogLocation, backlogWorkDraft } from '../apps/web/lib/backlog-draft.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
