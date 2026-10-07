import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderTasksByStage } from '../../apps/web/lib/task-stages.mjs';

const task = (id, created_at, depends_on = []) => ({ id, created_at, depends_on });
const labels = (tasks) => orderTasksByStage(tasks).map((r) => `${r.task.id}:${r.label}`);

test('parallel tasks get branch numbers, lone stages get none', () => {
  const tasks = [
    task('d', '4', ['c1', 'c2']),
    task('c2', '3', ['a']),
    task('c1', '2', ['a']),
    task('b', '1.5'),
    task('a', '1'),
  ];
  assert.deepEqual(labels(tasks), ['a:1-1', 'b:1-2', 'c1:2-1', 'c2:2-2', 'd:3']);
});

test('stage is latest dependency stage + 1', () => {
  const tasks = [task('a', '1'), task('b', '2', ['a']), task('c', '3', ['a', 'b'])];
  assert.deepEqual(labels(tasks), ['a:1', 'b:2', 'c:3']);
});

test('single task and empty list', () => {
  assert.deepEqual(labels([task('a', '1')]), ['a:1']);
  assert.deepEqual(labels([]), []);
});

test('cycles and outside dependencies go last without a label', () => {
  const tasks = [task('x', '1', ['y']), task('y', '2', ['x']), task('o', '3', ['gone']), task('a', '4')];
  assert.deepEqual(labels(tasks), ['a:1', 'x:', 'y:', 'o:']);
});

test('normalizeWorkDetailData keeps created_at and depends_on so stages survive normalization', async () => {
  const { normalizeWorkDetailData } = await import('../../apps/web/lib/work-detail-safety.mjs');
  const raw = (id, created_at, depends_on) => ({ id, title: id, status: 'waiting', type: 'code', created_at, depends_on });
  const data = normalizeWorkDetailData({ work: { id: 'w', title: 'w', state: 'running' }, tasks: [raw('b', '2', ['a']), raw('c', '3', ['a']), raw('a', '1', [])] }, 'w');
  assert.deepEqual(labels(data.tasks), ['a:1', 'b:2-1', 'c:2-2']);
});
