import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { fakeFetch, loadApiClient } from '../helpers/web-api-client.mjs';
import { repoRoot } from '../helpers/paths.mjs';
const ja = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8'));
const en = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8'));

const usageSettings = { claude_usage_api_enabled: false, poll_interval_minutes: 15 };
const planUsage = { generated_at: '2026-10-03T00:00:00.000Z', settings: usageSettings, claude: {}, codex: {} };
const report = { period: '30d', since: '2026-09-04T00:00:00.000Z', until: '2026-10-03T00:00:00.000Z', totals: {}, top_works: [] };

test('token and plan usage clients follow the server paths, query, and response envelopes', async () => {
  const { getTokenUsageReport, getPlanUsage, getPlanUsageSettings } = loadApiClient();
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = fakeFetch((url, init) => {
    requests.push({ path: url.pathname, period: url.searchParams.get('period'), method: init.method ?? 'GET' });
    if (url.pathname.endsWith('/token-usage')) return new Response(JSON.stringify({ request_id: 'r1', data: report }), { status: 200 });
    if (url.pathname === '/api/v1/plan-usage') return new Response(JSON.stringify({ request_id: 'r2', data: planUsage }), { status: 200 });
    return new Response(JSON.stringify({ request_id: 'r3', data: usageSettings, version: 0 }), { status: 200 });
  });
  try {
    assert.deepEqual(await getTokenUsageReport('30d'), report);
    assert.deepEqual(await getPlanUsage(), planUsage);
    assert.deepEqual(await getPlanUsageSettings(), usageSettings);
    assert.deepEqual(requests, [
      { path: '/api/v1/token-usage', period: '30d', method: 'GET' },
      { path: '/api/v1/plan-usage', period: null, method: 'GET' },
      { path: '/api/v1/settings/plan-usage', period: null, method: 'GET' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('plan usage setting updates use the exact PUT payload and versioned command envelope', async () => {
  const { setPlanUsageSettings } = loadApiClient();
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = fakeFetch((url, init) => {
    request = { path: url.pathname, method: init.method, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ request_id: 'r4', data: usageSettings, version: 0 }), { status: 200 });
  });
  try {
    assert.deepEqual(await setPlanUsageSettings(usageSettings), usageSettings);
    assert.equal(request.path, '/api/v1/settings/plan-usage');
    assert.equal(request.method, 'PUT');
    assert.deepEqual(request.body.payload, usageSettings);
    assert.equal(request.body.expected_version, 0);
    assert.equal(typeof request.body.request_id, 'string');
    assert.equal(typeof request.body.idempotency_key, 'string');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('token UI text is translated in both locales for navigation, plan sources, and usage sections', () => {
  const keys = [
    'nav.tokens', 'tokens.title', 'tokens.planTitle', 'tokens.consumptionTitle',
    'tokens.source.claude_usage_api', 'tokens.source.claude_rate_limit_event',
    'tokens.source.codex_session_log', 'tokens.source.codex_live',
    'tokens.period.today', 'tokens.period.7d', 'tokens.period.30d',
    'tokens.settings.title', 'tokens.status.not_configured',
    'tokens.column.share', 'tokens.column.cacheRate', 'tokens.column.perTask', 'tokens.column.firstReview',
    'tokens.review.pass', 'tokens.review.fail', 'tokens.legend',
    'tokens.sort.label', 'tokens.sort.asc', 'tokens.sort.desc',
  ];
  const lookup = (dict, key) => key.split('.').reduce((value, part) => value?.[part], dict);
  for (const key of keys) {
    assert.equal(typeof lookup(ja, key), 'string', `Japanese translation missing: ${key}`);
    assert.equal(typeof lookup(en, key), 'string', `English translation missing: ${key}`);
  }
});

test('token table is built from the column model with card labels, tabs, sort bar and legend', () => {
  const view = readFileSync(join(repoRoot, 'apps/web/components/TokensView.tsx'), 'utf8');
  const css = readFileSync(join(repoRoot, 'apps/web/app/tokens/tokens.css'), 'utf8');
  assert.doesNotMatch(view, /<colgroup|METRIC_COLUMNS/);
  assert.match(view, /columnsFor\(group\)/);
  assert.match(view, /<td\s[^>]*data-label=\{/);
  for (const name of ['token-usage__cell--total', 'token-usage__cell--share', 'token-usage__cell--section', 'pill-group', 'pill--active', 'token-usage__sort-bar', '<select']) {
    assert.ok(view.includes(name), `missing ${name}`);
  }
  assert.match(view, /setSort\(sortForGroup\(sort, key\)\)/);
  assert.match(view, /t\('tokens\.legend'\)/);
  const narrow = css.slice(css.indexOf('@media (max-width: 768px)'));
  assert.doesNotMatch(narrow, /display: block|::before|max-height: none/);
  assert.match(css, /\.token-usage__table tbody th\s*\{[^}]*position: sticky;\s*left: 0/);
  assert.match(css, /\.token-usage__table-wrap\s*\{[^}]*max-height:[^}]*overflow: auto/);
  assert.match(narrow, /\.token-usage__sort-bar\s*\{\s*display: flex/);
});

test('token CSS lives in tokens.css, is scoped to token classes, and does not collapse columns', () => {
  const css = readFileSync(join(repoRoot, 'apps/web/app/tokens/tokens.css'), 'utf8');
  const globals = readFileSync(join(repoRoot, 'apps/web/app/globals.css'), 'utf8');
  const page = readFileSync(join(repoRoot, 'apps/web/app/tokens/page.tsx'), 'utf8');
  assert.match(page, /import '\.\/tokens\.css';/);
  assert.doesNotMatch(globals, /token-usage|token-meter/);
  assert.doesNotMatch(css, /table-layout: fixed|\bcol\b|!important/);
  assert.match(css, /white-space: nowrap/);
  const selectors = css.split('\n').filter((line) => /[{,]$/.test(line.trimEnd()) && !line.trim().startsWith('@media')).map((line) => line.trim());
  for (const selector of selectors) assert.match(selector, /^\.token-(usage|meter)/, `unscoped selector: ${selector}`);
});
