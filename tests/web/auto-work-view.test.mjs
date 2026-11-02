import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import { repoRoot } from '../helpers/paths.mjs';
import {
  AUTO_WORK_SETTINGS_VIEW_KEY,
  createdState,
  eventLinks,
  eventsQuery,
  eventsViewKey,
  fromLabelKey,
  hasActionError,
  isMutedEvent,
  knownValue,
  mergeEvents,
  originLabelKey,
  rulesSummary,
  sourceLabelKey,
  summarizeRun,
  verdictLabelKey,
  verdictTone,
} from '../../apps/web/lib/auto-work.mjs';
import { VIEW_EVENT_RULES, viewKeysForEvent } from '../../apps/web/lib/view-events.mjs';

const created = (extra = {}) => ({ id: 'e1', verdict: 'created', work_id: 'w1', work_state: 'memo', action: 'draft', action_error: null, ...extra });

test('createdState follows the Work now, not the action or action_error', () => {
  assert.equal(createdState(created()), 'draft');
  assert.equal(createdState(created({ work_state: 'running' })), 'started');
  assert.equal(createdState(created({ work_id: null, work_state: null })), 'deleted');
  assert.equal(createdState(created({ action: 'start', work_state: 'memo' })), 'draft');
  assert.equal(createdState(created({ action_error: 'comment failed' })), 'draft');
  assert.equal(createdState({ id: 'e2', verdict: 'duplicate' }), null);
});

test('verdict labels, tones and muted rows', () => {
  assert.equal(verdictLabelKey(created()), 'autoWork.verdict.created_draft');
  assert.equal(verdictLabelKey(created({ work_state: 'running' })), 'autoWork.verdict.created_started');
  assert.equal(verdictLabelKey(created({ work_id: null })), 'autoWork.verdict.created_deleted');
  assert.equal(verdictLabelKey({ verdict: 'daily_cap' }), 'autoWork.verdict.daily_cap');
  assert.equal(verdictLabelKey({ verdict: 'something_new' }), 'autoWork.verdict.judge_failed');
  assert.equal(verdictTone(created()), 'green');
  assert.equal(verdictTone({ verdict: 'judge_failed' }), 'red');
  assert.equal(verdictTone({ verdict: 'something_new' }), 'muted');
  assert.equal(isMutedEvent({ verdict: 'duplicate' }), true);
  assert.equal(isMutedEvent({ verdict: 'judge_failed' }), true);
  assert.equal(isMutedEvent({ verdict: 'created' }), false);
  assert.equal(isMutedEvent({ verdict: 'judging' }), false);
  assert.equal(hasActionError({ action_error: 'x' }), true);
  assert.equal(hasActionError({ action_error: '' }), false);
  assert.equal(hasActionError({ action_error: null }), false);
});

test('start action with an action_error is draft or started by work_state, and every verdict has its label and tone', () => {
  const failed = { action: 'start', action_error: 'comment failed' };
  assert.equal(createdState(created({ ...failed, work_state: 'memo' })), 'draft');
  assert.equal(createdState(created({ ...failed, work_state: 'running' })), 'started');
  assert.equal(verdictLabelKey(created({ ...failed, work_state: 'running' })), 'autoWork.verdict.created_started');
  assert.equal(hasActionError(created(failed)), true);
  const tones = {
    duplicate: 'amber', below_threshold: 'muted', daily_cap: 'amber', unauthorized: 'red', no_rule: 'muted',
    disabled: 'muted', not_worth: 'amber', judge_failed: 'red', judging: 'accent',
  };
  for (const [verdict, tone] of Object.entries(tones)) {
    assert.equal(verdictLabelKey({ verdict }), `autoWork.verdict.${verdict}`);
    assert.equal(verdictTone({ verdict }), tone);
  }
  assert.equal(verdictTone(created({ work_id: null })), 'green');
  assert.equal(verdictLabelKey(created({ work_id: null })), 'autoWork.verdict.created_deleted');
});

test('label keys fall back for unknown values', () => {
  assert.equal(fromLabelKey('db'), 'autoWork.from.db');
  assert.equal(fromLabelKey('mystery'), 'autoWork.from.defaults');
  assert.equal(sourceLabelKey('github'), 'autoWork.source.github');
  assert.equal(sourceLabelKey('mystery'), null);
  assert.equal(originLabelKey('project'), 'autoWork.origin.project');
  assert.equal(originLabelKey('mystery'), 'autoWork.origin.defaults');
});

test('filters: known values only, stable view key, query without empty values', () => {
  assert.equal(knownValue('github', ['github', 'failure_notice']), 'github');
  assert.equal(knownValue('nope', ['github']), null);
  assert.equal(knownValue(undefined, ['github']), null);
  assert.equal(eventsViewKey({}), 'auto-work-events:*:*:*:0');
  assert.equal(eventsViewKey({ projectId: 'p1', source: 'github', verdict: 'created', offset: 50 }), 'auto-work-events:p1:github:created:50');
  assert.equal(eventsQuery({}), '');
  assert.equal(eventsQuery({ projectId: 'p1', verdict: 'created', limit: 50, offset: 0 }), 'project_id=p1&verdict=created&limit=50');
  assert.equal(eventsQuery({ source: 'github', limit: 50, offset: 100 }), 'source=github&limit=50&offset=100');
});

test('rulesSummary counts by origin and ignores the config file flag', () => {
  assert.deepEqual(rulesSummary([{ origin: 'defaults' }, { origin: 'defaults', overridden_fields: [] }]), { defaultsOnly: true, local: 0, project: 0, overridden: 0 });
  assert.deepEqual(
    rulesSummary([{ origin: 'defaults', overridden_fields: ['action'] }, { origin: 'local' }, { origin: 'project' }, { origin: 'project' }]),
    { defaultsOnly: false, local: 1, project: 2, overridden: 1 },
  );
  assert.equal(rulesSummary(undefined).defaultsOnly, true);
});

test('eventLinks builds Work links and keeps only https external links', () => {
  const links = eventLinks({
    work_id: 'w 1', work_display_number: 7, work_title: 'T', work_state: 'memo',
    github_url: 'https://github.com/o/r/issues/3', github_pr_url: 'javascript:alert(1)', github_comment_url: 'http://x.test/c',
    github_issue_number: 3,
  });
  assert.deepEqual(links.work, { href: '/work?id=w%201', number: 7, title: 'T', state: 'memo' });
  assert.deepEqual(links.issue, { href: 'https://github.com/o/r/issues/3', number: 3 });
  assert.equal(links.pr, null);
  assert.equal(links.comment, null);
  assert.equal(links.duplicateWork, null);
  assert.equal(links.duplicateEvent, null);

  const dupWork = eventLinks({ duplicate_of_work_id: 'w9', duplicate_of_work_display_number: 9, duplicate_of_event_id: 'abcdefghij' });
  assert.deepEqual(dupWork.duplicateWork, { href: '/work?id=w9', number: 9 });
  assert.equal(dupWork.duplicateEvent, null);
  const dupEvent = eventLinks({ duplicate_of_event_id: 'abcdefghij' });
  assert.deepEqual(dupEvent.duplicateEvent, { id: 'abcdefghij', short: 'abcdefgh' });
});

test('summarizeRun and mergeEvents', () => {
  assert.deepEqual(summarizeRun([{ verdict: 'created' }, { verdict: 'duplicate' }, { verdict: 'created' }]), { created: 2, skipped: 1 });
  assert.deepEqual(summarizeRun(undefined), { created: 0, skipped: 0 });
  const merged = mergeEvents([{ id: 'a', n: 1 }, { id: 'b', n: 1 }], [{ id: 'b', n: 2 }, { id: 'c', n: 2 }]);
  assert.deepEqual(merged.map((e) => `${e.id}${e.n}`), ['a1', 'b1', 'c2']);
});

test('view-events: auto-work updates and alerts invalidate the auto-work views', () => {
  assert.ok(VIEW_EVENT_RULES.length > 0);
  const mounted = ['settings', AUTO_WORK_SETTINGS_VIEW_KEY, 'auto-work-events:*:*:*:0', 'auto-work-events:p1:github:*:0', 'projects'];
  const updated = viewKeysForEvent({ type: 'settings.auto_work_updated', payload: {} }, mounted);
  assert.ok(updated.includes('settings'));
  assert.ok(updated.includes(AUTO_WORK_SETTINGS_VIEW_KEY));
  assert.ok(!updated.includes('projects'));
  const alert = viewKeysForEvent({ type: 'system.alert', payload: {} }, mounted);
  assert.ok(alert.includes(AUTO_WORK_SETTINGS_VIEW_KEY));
  assert.ok(alert.includes('auto-work-events:*:*:*:0'));
  assert.ok(alert.includes('auto-work-events:p1:github:*:0'));
  assert.ok(!alert.includes('settings'));
  const other = viewKeysForEvent({ type: 'settings.model_updated', payload: {} }, mounted);
  assert.ok(!other.includes(AUTO_WORK_SETTINGS_VIEW_KEY));
});

const baseSettings = {
  enabled: { effective: true, from: 'db' },
  config_error: null,
  today: { created_all: 2, cap_all: 10 },
  judge_role: 'auto_work_judge',
  projects: [{ enabled: { effective: true } }, { enabled: { effective: false } }, { enabled: { effective: true } }],
};

function renderEntryPanel(view) {
  const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
  const React = webRequire('react');
  const { renderToStaticMarkup } = webRequire('react-dom/server');
  const panelPath = join(repoRoot, 'apps/web/components/AutoWorkEntryPanel.tsx');
  const { outputText } = ts.transpileModule(readFileSync(panelPath, 'utf8'), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(panelPath);
  loaded.filename = panelPath;
  loaded.paths = Module._nodeModulePaths(dirname(panelPath));
  const stubs = {
    'next/link': { __esModule: true, default: ({ href, className, children }) => React.createElement('a', { href, className }, children) },
    '@/lib/api-client': { getAutoWorkSettings: async () => ({}) },
    '@/lib/i18n': { useLocale: () => ({ t: (key, vars) => (vars ? `${key}|${Object.values(vars).join(',')}` : key) }) },
    '@/lib/view-loader': { useView: () => view },
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(stubs, request)) return stubs[request];
    if (request === '@/lib/auto-work.mjs') return originalLoad.call(this, join(repoRoot, 'apps/web/lib/auto-work.mjs'), parent, isMain);
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, panelPath);
  } finally {
    Module._load = originalLoad;
  }
  return renderToStaticMarkup(React.createElement(loaded.exports.AutoWorkEntryPanel));
}

const view = (data, extra = {}) => ({ data, error: null, loading: false, refresh: async () => {}, ...extra });

test('AutoWorkEntryPanel (on) shows the status, counts and a primary link to the page', () => {
  const html = renderEntryPanel(view(baseSettings));
  assert.ok(html.includes('id="sec-auto-work"'));
  assert.ok(html.includes('autoWork.on'));
  assert.ok(html.includes('autoWork.decidedBy|autoWork.from.db'));
  assert.ok(html.includes('autoWork.entry.todayValue|2,10'));
  assert.ok(html.includes('autoWork.entry.projectsValue|2,1'));
  assert.ok(html.includes('auto_work_judge'));
  assert.ok(html.includes('autoWork.entry.hintOn'));
  assert.ok(html.includes('href="/settings/auto-work"'));
  assert.ok(html.includes('btn btn--primary'));
});

test('AutoWorkEntryPanel (off) hides the counts and links with a plain button', () => {
  const html = renderEntryPanel(view({ ...baseSettings, enabled: { effective: false, from: 'defaults' } }));
  assert.ok(html.includes('autoWork.off'));
  assert.ok(html.includes('autoWork.entry.hintOff'));
  assert.ok(!html.includes('autoWork.entry.todayValue'));
  assert.ok(!html.includes('btn--primary'));
  assert.ok(html.includes('href="/settings/auto-work"'));
});

test('AutoWorkEntryPanel (config_error) shows the error and says it is treated as off', () => {
  const html = renderEntryPanel(view({ ...baseSettings, config_error: 'local.json: bad value' }));
  assert.ok(html.includes('autoWork.entry.configError'));
  assert.ok(html.includes('autoWork.entry.treatedAsOff'));
  assert.ok(html.includes('local.json: bad value'));
  assert.ok(!html.includes('autoWork.entry.todayValue'));
  assert.ok(html.includes('href="/settings/auto-work"'));
});

test('AutoWorkEntryPanel shows loading, and a retry plus the link when loading fails', () => {
  const loading = renderEntryPanel(view(undefined, { loading: true }));
  assert.ok(loading.includes('autoWork.state.loading'));
  const failed = renderEntryPanel(view(undefined, { error: new Error('x') }));
  assert.ok(failed.includes('autoWork.entry.loadFailed'));
  assert.ok(failed.includes('autoWork.state.retry'));
  assert.ok(failed.includes('href="/settings/auto-work"'));
});
