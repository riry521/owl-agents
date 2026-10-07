import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Module } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import { repoRoot } from '../helpers/paths.mjs';
const libPath = join(repoRoot, 'apps/web/lib/token-usage-table.ts');

function loadLib() {
  const { outputText } = ts.transpileModule(readFileSync(libPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(libPath);
  loaded.filename = libPath;
  loaded._compile(outputText, libPath);
  return loaded.exports;
}

const {
  DEFAULT_TOKEN_SORT, nextTokenSort, sortTokenRows, aggregateByProject,
  columnsFor, uncachedInputOf, cacheRateOf, shareOf, cellValue, sortForGroup,
} = loadLib();

const totals = (input, output, total) => ({
  input_tokens: input, output_tokens: output, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: total, runs: 1,
});
const rows = [
  { label: 'b', totals: totals(5, 1, 10) },
  { label: 'a', totals: totals(1, 9, 30) },
  { label: 'c', totals: totals(3, 5, 20) },
];
const report = totals(9, 15, 60);
const labels = (list) => list.map((row) => row.label).join('');

test('default sort is total descending; same column again is ascending', () => {
  assert.deepEqual(DEFAULT_TOKEN_SORT, { key: 'total', dir: 'desc' });
  assert.equal(labels(sortTokenRows(rows, DEFAULT_TOKEN_SORT, report)), 'acb');
  const again = nextTokenSort(DEFAULT_TOKEN_SORT, 'total');
  assert.equal(again.dir, 'asc');
  assert.equal(labels(sortTokenRows(rows, again, report)), 'bca');
});

test('sorts by name and by a numeric column', () => {
  const byName = nextTokenSort(DEFAULT_TOKEN_SORT, 'name');
  assert.deepEqual(byName, { key: 'name', dir: 'asc' });
  assert.equal(labels(sortTokenRows(rows, byName, report)), 'abc');
  assert.equal(labels(sortTokenRows(rows, nextTokenSort(byName, 'name'), report)), 'cba');
  assert.equal(labels(sortTokenRows(rows, nextTokenSort(byName, 'output'), report)), 'acb');
});

test('columnsFor returns the per-tab column keys in order; only share is not sortable', () => {
  const keys = (group) => columnsFor(group).map((column) => column.key).join(',');
  const base = 'total,share,uncached,output,cacheRate,runs';
  assert.equal(keys('project'), base);
  assert.equal(keys('model'), base);
  assert.equal(keys('harness'), base);
  assert.equal(keys('role'), `${base},passRate,perTask,afterReview`);
  assert.equal(keys('work'), `${base},passRate,perTask,afterReview`);
  assert.equal(keys('task'), `${base},firstReview,afterReview`);
  assert.deepEqual(columnsFor('work').filter((column) => !column.sortable).map((column) => column.key), ['share']);
});

test('derived values use the design formulas and return null for zero or missing denominators', () => {
  const t = { input_tokens: 10, output_tokens: 7, cache_read_tokens: 60, cache_write_tokens: 30, total_tokens: 107, runs: 2 };
  assert.equal(uncachedInputOf({ label: 'x', totals: t }), 40);
  assert.equal(uncachedInputOf({ label: 'x', totals: t, metrics: { uncached_input_tokens: 5 } }), 5);
  assert.equal(cacheRateOf(t), 0.6);
  assert.equal(shareOf(t, { ...t, total_tokens: 214 }), 0.5);
  const zero = { ...t, input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0 };
  assert.equal(cacheRateOf(zero), null);
  assert.equal(shareOf(t, zero), null);
  const row = { label: 'x', totals: t };
  assert.equal(cellValue(row, 'passRate', t), null);
  assert.equal(cellValue(row, 'afterReview', t), null);
  assert.equal(cellValue(row, 'firstReview', t), null);
  assert.equal(cellValue({ ...row, metrics: { first_review_pass_rate: 0.5, tokens_after_first_review: 9, uncached_input_tokens: 1, uncached_input_tokens_per_completed_task: 3 } }, 'afterReview', t), 9);
  assert.equal(cellValue(row, 'runs', t), 2);
  assert.equal(cellValue({ label: 'x', totals: { ...t, output_tokens: NaN } }, 'output', t), null);
  assert.equal(uncachedInputOf({ label: 'x', totals: { ...t, input_tokens: Infinity } }), null);
  assert.equal(uncachedInputOf({ label: 'x', totals: t, metrics: { uncached_input_tokens: NaN } }), null);
  assert.equal(cacheRateOf({ ...t, input_tokens: Infinity }), null);
  assert.equal(shareOf(t, { ...t, total_tokens: Infinity }), null);
  const bad = { first_review_pass_rate: NaN, tokens_after_first_review: Infinity, uncached_input_tokens: 1, uncached_input_tokens_per_completed_task: NaN };
  for (const key of ['passRate', 'afterReview', 'perTask']) assert.equal(cellValue({ label: 'x', totals: t, metrics: bad }, key, t), null);
});

test('legacy raw-count keys still sort numerically', () => {
  assert.equal(labels(sortTokenRows(rows, { key: 'input', dir: 'desc' }, report)), 'bca');
  assert.equal(labels(sortTokenRows(rows, { key: 'input', dir: 'asc' }, report)), 'acb');
});

test('missing values sort last in both directions; ties fall back to name ascending; verdict is 1 > 0 > null', () => {
  const t = totals(1, 1, 1);
  const mk = (label, verdict) => ({ label, totals: t, firstReviewVerdict: verdict });
  const list = [mk('d', null), mk('c', 0), mk('b', 1), mk('a', 0)];
  assert.equal(labels(sortTokenRows(list, { key: 'firstReview', dir: 'desc' }, t)), 'bacd');
  assert.equal(labels(sortTokenRows(list, { key: 'firstReview', dir: 'asc' }, t)), 'acbd');
  const rated = [
    { label: 'x', totals: totals(1, 0, 1) },
    { label: 'y', totals: { ...totals(1, 0, 1), cache_read_tokens: 9 } },
    { label: 'z', totals: { ...totals(0, 0, 0) } },
  ];
  assert.equal(labels(sortTokenRows(rated, { key: 'cacheRate', dir: 'desc' }, t)), 'yxz');
  assert.equal(labels(sortTokenRows(rated, { key: 'cacheRate', dir: 'asc' }, t)), 'xyz');
});

test('sortForGroup keeps a sort the tab has and resets one it lacks', () => {
  const asc = { key: 'passRate', dir: 'asc' };
  assert.deepEqual(sortForGroup(asc, 'work'), asc);
  assert.deepEqual(sortForGroup(asc, 'model'), DEFAULT_TOKEN_SORT);
  assert.deepEqual(sortForGroup({ key: 'name', dir: 'desc' }, 'model'), { key: 'name', dir: 'desc' });
  assert.deepEqual(sortForGroup({ key: 'firstReview', dir: 'desc' }, 'role'), DEFAULT_TOKEN_SORT);
});

test('aggregates by_work per project, grouping null project_id', () => {
  const work = (id, project_id, input, total) => ({ work_id: id, title: id, display_number: null, project_id, state: null, totals: totals(input, 0, total) });
  const result = aggregateByProject([work('w1', 'p1', 1, 10), work('w2', 'p2', 2, 20), work('w3', null, 4, 40), work('w4', 'p1', 8, 80), work('w5', null, 16, 160)]);
  const byId = Object.fromEntries(result.map((row) => [String(row.project_id), row.totals]));
  assert.equal(result.length, 3);
  assert.equal(byId.p1.input_tokens, 9);
  assert.equal(byId.p1.total_tokens, 90);
  assert.equal(byId.p1.runs, 2);
  assert.equal(byId.p2.total_tokens, 20);
  assert.equal(byId.null.input_tokens, 20);
  assert.equal(byId.null.total_tokens, 200);
});
