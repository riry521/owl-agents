import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Module } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const formatPath = join(repoRoot, 'apps/web/lib/format.ts');
const apiClientPath = join(repoRoot, 'apps/web/lib/api-client.ts');

function loadFormat() {
  const source = readFileSync(formatPath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const loaded = new Module(formatPath);
  loaded.filename = formatPath;
  loaded.paths = Module._nodeModulePaths(dirname(formatPath));
  const translations = {
    '@/lib/i18n/ja.json': JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8')),
    '@/lib/i18n/en.json': JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8')),
    '@/lib/work-detail-safety.mjs': {},
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(translations, request)) return translations[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, formatPath);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports;
}

const { formatAgentLabel, agentModelLabel, runOrdinals } = loadFormat();

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
  const dependencies = {
    '@/lib/format': { runOrdinals },
    '@/lib/work-detail-safety.mjs': { normalizeWorkDetailData: (value) => value },
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(dependencies, request)) return dependencies[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, apiClientPath);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports;
}

function run(id, role, taskId, startedAt, workId = null) {
  return {
    id,
    work_id: workId,
    role,
    task_id: taskId,
    provider: 'test',
    model: 'test-model',
    status: 'running',
    pid: null,
    started_at: startedAt,
    ended_at: null,
    parent_agent_id: null,
    phase: null,
    subtask_count: null,
    label: null,
    origin: null,
  };
}

test('runOrdinals counts each role within its Work in creation order', () => {
  const runs = [
    run('01C-work-b-worker', 'worker', 'task-b', '2026-01-03T00:00:00.000Z'),
    run('01B-work-a-worker-2', 'worker', 'task-a-2', '2026-01-02T00:00:00.000Z'),
    run('01A-work-a-worker-1', 'worker', 'task-a-1', '2026-01-01T00:00:00.000Z'),
  ];
  const workByTask = new Map([
    ['task-a-1', 'work-a'],
    ['task-a-2', 'work-a'],
    ['task-b', 'work-b'],
  ]);
  const ordinals = runOrdinals(runs, (agentRun) => workByTask.get(agentRun.task_id) ?? null);

  assert.equal(ordinals.get('01A-work-a-worker-1'), 1);
  assert.equal(ordinals.get('01B-work-a-worker-2'), 2);
  assert.equal(ordinals.get('01C-work-b-worker'), 1);
});

test('runOrdinals follows run ids, not start times', () => {
  const ordinals = runOrdinals([
    run('01A-first', 'worker', 'task-a', '2026-01-02T00:00:00.000Z'),
    run('01B-second', 'worker', 'task-a', '2026-01-01T00:00:00.000Z'),
  ], () => 'work-a');

  assert.equal(ordinals.get('01A-first'), 1);
  assert.equal(ordinals.get('01B-second'), 2);
});

test('a run that has not started does not shift the numbers of earlier runs', () => {
  const started = [
    run('01A-first', 'worker', 'task-a', '2026-01-01T00:00:00.000Z'),
    run('01B-second', 'worker', 'task-a', '2026-01-02T00:00:00.000Z'),
  ];
  const before = runOrdinals(started, () => 'work-a');
  const after = runOrdinals([run('01C-pending', 'worker', 'task-a', null), ...started], () => 'work-a');

  assert.equal(after.get('01A-first'), before.get('01A-first'));
  assert.equal(after.get('01B-second'), before.get('01B-second'));
  assert.equal(after.get('01C-pending'), 3);
});

test('runOrdinals numbers roles independently within a Work', () => {
  const ordinals = runOrdinals([
    run('01A-worker', 'worker', 'task-a', '2026-01-01T00:00:00.000Z'),
    run('01B-reviewer', 'reviewer', 'task-a', '2026-01-02T00:00:00.000Z'),
  ], () => 'work-a');

  assert.equal(ordinals.get('01A-worker'), 1);
  assert.equal(ordinals.get('01B-reviewer'), 1);
});

test('runOrdinals and formatAgentLabel number the Designer role like any other role', () => {
  const ordinals = runOrdinals([
    run('01A-designer', 'designer', 'task-a', '2026-01-01T00:00:00.000Z'),
    run('01B-worker', 'worker', 'task-a', '2026-01-02T00:00:00.000Z'),
    run('01C-designer', 'designer', 'task-b', '2026-01-03T00:00:00.000Z'),
  ], () => 'work-a');

  assert.equal(ordinals.get('01A-designer'), 1);
  assert.equal(ordinals.get('01B-worker'), 1);
  assert.equal(ordinals.get('01C-designer'), 2);

  const secondDesigner = run('01C-designer', 'designer', 'task-b', '2026-01-03T00:00:00.000Z');
  assert.equal(formatAgentLabel(secondDesigner, ordinals.get('01C-designer'), 'en'), 'Designer #2 (test-model)');
});

test('formatAgentLabel leaves Manager unnumbered', () => {
  const manager = run('manager', 'manager', null, null);
  assert.equal(formatAgentLabel(manager, 7, 'en'), 'Manager');
});

test('runOrdinals handles missing Work and start times and assigns every run', () => {
  const runs = [
    run('01A-no-task', 'worker', null, null),
    run('01B-unresolved-task', 'worker', 'missing-task', '2026-01-01T00:00:00.000Z'),
    run('01C-known-task', 'reviewer', 'task-a', null),
  ];
  const ordinals = runOrdinals(runs, (agentRun) => agentRun.task_id === 'task-a' ? 'work-a' : null);

  assert.equal(ordinals.size, runs.length);
  assert.equal(ordinals.get('01A-no-task'), 1);
  assert.equal(ordinals.get('01B-unresolved-task'), 2);
  assert.equal(ordinals.get('01C-known-task'), 1);
});

test('getAgents numbers runs by their work_id with one request per list and shows the Project name', async () => {
  const { getAgents } = loadApiClient();
  const archivedWork = {
    id: 'archived-work',
    display_number: 1,
    title: 'Archived Work',
    state: 'completed',
    state_version: 1,
    updated_at: '2026-01-02T00:00:00.000Z',
    archived_at: '2026-01-03T00:00:00.000Z',
    project_id: 'project-a',
  };
  const activeWork = {
    id: 'active-work',
    display_number: 1,
    title: 'Active Work',
    state: 'running',
    state_version: 1,
    updated_at: '2026-01-03T00:00:00.000Z',
    archived_at: null,
    project_id: 'project-b',
  };
  const unassociatedWorker = run('01A-unassociated-worker', 'worker', null, '2026-01-01T00:00:00.000Z');
  const archivedWorker = run('01B-archived-worker', 'worker', null, '2026-01-02T00:00:00.000Z', archivedWork.id);
  const archivedManager = run('01C-archived-manager', 'manager', null, null, archivedWork.id);
  const activeWorker = run('01D-active-worker', 'worker', null, '2026-01-03T00:00:00.000Z', activeWork.id);
  activeWorker.last_output_at = '2026-01-03T00:10:00.000Z';
  const allRuns = [unassociatedWorker, archivedWorker, archivedManager, activeWorker];
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://owl.test');
    requests.push(url);
    let data;
    if (url.pathname === '/api/v1/runtime-config.json') {
      return new Response(JSON.stringify({
        base_path: '/owl/',
        api_base: '/api/v1',
        ws_url: '/api/v1/ws',
        schema_version: '1.0.0',
      }), { status: 200 });
    }
    if (url.pathname === '/api/v1/works') {
      data = [activeWork, archivedWork];
    } else if (url.pathname === '/api/v1/agents') {
      data = allRuns;
    } else if (url.pathname === '/api/v1/projects') {
      data = [{ id: 'project-a', name: 'Alpha' }, { id: 'project-b', name: 'Beta' }];
    } else {
      throw new Error(`Unexpected request: ${url}`);
    }
    return new Response(JSON.stringify({ data, has_more: false, cursor: null }), { status: 200 });
  };

  try {
    const agents = await getAgents();
    const worksRequest = requests.find((url) => url.pathname === '/api/v1/works');
    assert.equal(worksRequest?.searchParams.get('archived'), 'include');
    const apiRequests = requests.filter((url) => url.pathname !== '/api/v1/runtime-config.json');
    assert.deepEqual(apiRequests.map((url) => url.pathname).sort(), ['/api/v1/agents', '/api/v1/projects', '/api/v1/works']);
    assert.equal(apiRequests.some((url) => url.searchParams.has('work_id')), false);

    const activity = new Map(agents.running.map((item) => [item.run.id, item]));
    assert.equal(activity.get(archivedManager.id)?.work?.id, archivedWork.id);
    assert.equal(activity.get(archivedWorker.id)?.work?.id, archivedWork.id);
    assert.equal(activity.get(archivedWorker.id)?.project_name, 'Alpha');
    assert.equal(activity.get(activeWorker.id)?.project_name, 'Beta');
    assert.equal(activity.get(unassociatedWorker.id)?.ordinal, 1);
    assert.equal(activity.get(unassociatedWorker.id)?.work, null);
    // Idle warnings count from the last output, not from the start.
    assert.equal(activity.get(activeWorker.id)?.last_output_at, '2026-01-03T00:10:00.000Z');
    assert.equal(activity.get(unassociatedWorker.id)?.last_output_at, null);

    // Work Detail numbers the Work's own run list; Agents must agree.
    const workDetailOrdinals = runOrdinals([archivedWorker, archivedManager], () => archivedWork.id);
    assert.equal(activity.get(archivedWorker.id)?.ordinal, workDetailOrdinals.get(archivedWorker.id));
    assert.equal(activity.get(archivedWorker.id)?.ordinal, 1);
    assert.equal(activity.get(activeWorker.id)?.ordinal, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runOrdinals without a Work resolver keeps one group across all runs', () => {
  const ordinals = runOrdinals([
    run('01B-later', 'worker', 'task-b', '2026-01-02T00:00:00.000Z'),
    run('01A-earlier', 'worker', 'task-a', '2026-01-01T00:00:00.000Z'),
  ]);

  assert.equal(ordinals.get('01A-earlier'), 1);
  assert.equal(ordinals.get('01B-later'), 2);
});

test('agentModelLabel shows the short model name and effort for Claude and OpenAI models', () => {
  assert.equal(agentModelLabel({ model: 'claude-opus-5-5', effort: 'low' }), 'Opus5.5-low');
  assert.equal(agentModelLabel({ model: 'claude-haiku-4-5-20251001', effort: 'high' }), 'Haiku4.5-high');
  assert.equal(agentModelLabel({ model: 'claude-fable-5-1', effort: 'xhigh' }), 'Fable5.1-xhigh');
  assert.equal(agentModelLabel({ model: 'claude-opus-5', effort: 'high' }), 'Opus5-high');
  assert.equal(agentModelLabel({ model: 'gpt-5.4', effort: 'high' }), 'GPT-5.4-high');
  assert.equal(agentModelLabel({ model: 'gpt-5.3-codex', effort: 'medium' }), 'GPT-5.3-Codex-medium');
});

test('agentModelLabel falls back to the model name alone when effort is unset or unknown', () => {
  assert.equal(agentModelLabel({ model: 'claude-sonnet-5', effort: null }), 'Sonnet5');
  assert.equal(agentModelLabel({ model: 'gpt-5.4' }), 'GPT-5.4');
  assert.equal(agentModelLabel({ model: 'local-llama', effort: '' }), 'local-llama');
  assert.equal(agentModelLabel({ model: '', provider: 'openai', effort: null }), 'openai');
});

test('formatAgentLabel shows the model and effort instead of the provider', () => {
  const worker = { ...run('01A-worker', 'worker', 'task-a', null), provider: 'openai', model: 'gpt-5.4', effort: 'high' };
  assert.equal(formatAgentLabel(worker, 1, 'en'), 'Worker #1 (GPT-5.4-high)');
  assert.equal(formatAgentLabel(worker, 1, 'ja'), 'Worker #1（GPT-5.4-high）');
  const executor = { ...run('01B-exec', 'executor', 'task-a', null), provider: 'claude', model: 'claude-opus-5-5', effort: 'low', label: 's1' };
  assert.match(formatAgentLabel(executor, 1, 'en'), /s1 \(Opus5\.5-low\)$/);
});
