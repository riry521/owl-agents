import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remarkHeadingIds, slugifyHeading, tocEntries } from '../../apps/web/lib/markdown-toc.mjs';

test('slugifyHeading keeps Japanese letters and numbers', () => {
  assert.equal(slugifyHeading('  1. 目的と 制約 ', new Set()), '1-目的と-制約');
  assert.equal(slugifyHeading('Hello, World_x', new Set()), 'hello-world_x');
});

test('slugifyHeading numbers repeats and falls back to section when empty', () => {
  const used = new Set();
  assert.deepEqual(['概要', '概要', '概要'].map((t) => slugifyHeading(t, used)), ['概要', '概要-2', '概要-3']);
  assert.deepEqual(['!!!', '???'].map((t) => slugifyHeading(t, used)), ['section', 'section-2']);
});

test('remarkHeadingIds sets id and tabIndex on root headings, including inline code text', () => {
  const heading = (text) => ({ type: 'heading', children: [{ type: 'text', value: 'a ' }, { type: 'inlineCode', value: text }] });
  const tree = { type: 'root', children: [heading('x'), { type: 'paragraph', children: [] }, heading('x')] };
  remarkHeadingIds()(tree);
  assert.deepEqual(tree.children.map((n) => n.data?.hProperties), [
    { id: 'a-x', tabIndex: -1 },
    undefined,
    { id: 'a-x-2', tabIndex: -1 },
  ]);
});

const h = (level, text) => ({ id: text, text, level });

test('tocEntries drops a lone leading h1 and indents from the shallowest level', () => {
  assert.deepEqual(tocEntries([h(1, 'T'), h(2, 'A'), h(3, 'B'), h(2, 'C')]).map((e) => [e.text, e.indent]), [['A', 0], ['B', 1], ['C', 0]]);
});

test('tocEntries keeps h1 when it is not the lone leading one', () => {
  assert.deepEqual(tocEntries([h(1, 'A'), h(1, 'B')]).map((e) => e.text), ['A', 'B']);
  assert.deepEqual(tocEntries([h(2, 'A'), h(1, 'B')]).map((e) => [e.text, e.indent]), [['A', 1], ['B', 0]]);
});

test('tocEntries returns nothing below two entries', () => {
  assert.deepEqual(tocEntries([]), []);
  assert.deepEqual(tocEntries([h(2, 'A')]), []);
  assert.deepEqual(tocEntries([h(1, 'T'), h(2, 'A')]), []);
});
