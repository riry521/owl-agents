import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Module } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { normalizeWorkDetailData } from '../../apps/web/lib/work-detail-safety.mjs';

import { repoRoot } from '../helpers/paths.mjs';
const formatPath = join(repoRoot, 'apps/web/lib/format.ts');
const apiClientPath = join(repoRoot, 'apps/web/lib/api-client.ts');

function loadFormat() {
  const { outputText } = ts.transpileModule(readFileSync(formatPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(formatPath);
  loaded.filename = formatPath;
  loaded.paths = Module._nodeModulePaths(dirname(formatPath));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@/lib/i18n/ja.json') return JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8'));
    if (request === '@/lib/i18n/en.json') return JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8'));
    if (request === '@/lib/work-detail-safety.mjs') return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, formatPath);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports;
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

const { workDisplayNumber } = loadFormat();

test('workDisplayNumber accepts only positive safe integers', () => {
  assert.equal(workDisplayNumber(1), 1);
  assert.equal(workDisplayNumber(42), 42);
  for (const value of [null, undefined, 0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(workDisplayNumber(value), null, `value ${String(value)} should not be displayed`);
  }
});

test('Work detail normalization keeps numeric display numbers and tolerates missing or invalid values', () => {
  const normalized = normalizeWorkDetailData({
    work: { id: 'work-a', display_number: 12, title: 'Example', state: 'ready' },
  }, 'work-a');
  assert.equal(normalized.work.display_number, 12);

  const legacy = normalizeWorkDetailData({ work: { id: 'work-b', title: 'Legacy', state: 'ready' } }, 'work-b');
  assert.equal(legacy.work.display_number, null);

  const invalid = normalizeWorkDetailData({
    work: { id: 'work-c', display_number: '13', title: 'Invalid', state: 'ready' },
  }, 'work-c');
  assert.equal(invalid.work.display_number, null);
});

test('getAgents carries Work display numbers and tolerates old or invalid Work summaries', async () => {
  const { getAgents } = loadApiClient();
  const works = [
    { id: 'work-numbered', display_number: 7, title: 'Numbered Work', state: 'running', state_version: 1, updated_at: '', archived_at: null },
    { id: 'work-legacy', title: 'Legacy Work', state: 'running', state_version: 1, updated_at: '', archived_at: null },
    { id: 'work-invalid', display_number: '8', title: 'Invalid Work', state: 'running', state_version: 1, updated_at: '', archived_at: null },
  ];
  const runs = works.map((work, index) => ({
    id: `run-${index}`,
    work_id: work.id,
    task_id: null,
    role: 'worker',
    provider: 'test',
    model: 'test-model',
    status: 'running',
    pid: null,
    started_at: null,
    ended_at: null,
    parent_agent_id: null,
    phase: null,
    subtask_count: null,
    label: null,
    origin: null,
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://owl.test');
    if (url.pathname === '/api/v1/runtime-config.json') {
      return new Response(JSON.stringify({ base_path: '/owl/', api_base: '/api/v1', ws_url: '/api/v1/ws', schema_version: '1.0.0' }), { status: 200 });
    }
    if (url.pathname !== '/api/v1/agents/view') throw new Error(`Unexpected request: ${url}`);
    const running = runs.map((run, index) => ({ run, ordinal: 1, last_output_at: null, task: null, work: works[index], project_name: null }));
    return new Response(JSON.stringify({ data: { idle_threshold_seconds: 1800, running, recent: [], children: [] } }), { status: 200 });
  };

  try {
    const agents = await getAgents();
    const activityByRun = new Map(agents.running.map((activity) => [activity.run.id, activity]));
    assert.equal(activityByRun.get('run-0')?.work?.display_number, 7);
    assert.equal(activityByRun.get('run-1')?.work?.display_number, null);
    assert.equal(activityByRun.get('run-2')?.work?.display_number, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ja and en define the same Work number label key', () => {
  const ja = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8'));
  const en = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8'));
  assert.equal(ja.work.numberLabel, 'Work #{{number}}');
  assert.equal(en.work.numberLabel, 'Work #{{number}}');
});

test('preview heading puts the Work number label and the title in separate elements', () => {
  const source = readFileSync(join(repoRoot, 'apps/web/components/WorkPreviewPanel.tsx'), 'utf8');
  const heading = source.slice(source.indexOf('className="preview__title"'), source.indexOf('</h2>'));
  assert.match(heading, /displayNumber !== null &&[^\n]*<span className="preview__number">/);
  assert.match(heading, /<span className="preview__title-text">\{work\.title\}<\/span>/);
  const css = readFileSync(join(repoRoot, 'apps/web/app/globals.css'), 'utf8');
  assert.match(css, /\.preview__title-text \{[^}]*overflow-wrap: anywhere/);
});
