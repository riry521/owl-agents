import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownLinkPath, markdownViewerHref, splitMarkdownPaths } from '../../apps/web/lib/markdown-path-links.mjs';

const shown = (text) => splitMarkdownPaths(text).map((s) => (s.path === null ? s.text : [s.path]));

const SPLITS = [
  ['報告書の場所: /data/memory/materials/projects/a/report.md', ['報告書の場所: ', ['/data/memory/materials/projects/a/report.md']]],
  ['/data/m/2026-11-01_設計_2部門制と制作の流れ.md に置きました', [['/data/m/2026-11-01_設計_2部門制と制作の流れ.md'], ' に置きました']],
  ['docs/operations.md の71行目', [['docs/operations.md'], ' の71行目']],
  ['README.md）にも', [['README.md'], '）にも']],
  ['・README.md の決めた場所に', ['・', ['README.md'], ' の決めた場所に']],
  ['記録.md もあります', [['記録.md'], ' もあります']],
  ['materials/common/note.md', [['materials/common/note.md']]],
  ['./docs/x.md', [['./docs/x.md']]],
  ['README.MD', [['README.MD']]],
  ['a.md と b.md', [['a.md'], ' と ', ['b.md']]],
  ['a.mdとb.md', [['a.md'], 'とb.md']],
  ['docs/x.md:71', [['docs/x.md'], ':71']],
  ['docs/x.md#heading', [['docs/x.md'], '#heading']],
  ['docs/x.md.', [['docs/x.md'], '.']],
  ['[設計](docs/x.md)', ['[設計](', ['docs/x.md'], ')']],
  ['`docs/x.md`', ['`', ['docs/x.md'], '`']],
];

const PLAIN = [
  'https://example.com/docs/x.md を参照',
  'https://a.example/x?file=docs/y.md',
  '../secret.md',
  '~/notes/a.md',
  'C:\\docs\\x.md',
  'docs/a.txt',
  'x.mdx',
  'x.md.bak',
  '*.md',
  'docs/*.md',
  '.md',
];

test('splitMarkdownPaths links Markdown paths and keeps the rest as text', () => {
  for (const [input, expected] of SPLITS) assert.deepEqual(shown(input), expected, input);
});

test('splitMarkdownPaths leaves URLs, ~, .., backslashes and non-md names as text', () => {
  for (const input of PLAIN) assert.deepEqual(splitMarkdownPaths(input), [{ text: input, path: null }], input);
});

test('splitMarkdownPaths segments join back to the input', () => {
  for (const input of [...SPLITS.map(([i]) => i), ...PLAIN]) {
    assert.equal(splitMarkdownPaths(input).map((s) => s.text).join(''), input);
  }
});

test('markdownLinkPath returns a path only when the whole string is one path', () => {
  assert.equal(markdownLinkPath('docs/x.md'), 'docs/x.md');
  assert.equal(markdownLinkPath('/abs/x.md'), '/abs/x.md');
  for (const input of ['docs/a.ts', 'CLAUDE.md, docs/design.md', 'scripts/a.sh, docs/operations.md', 'docs/my notes.md']) {
    assert.equal(markdownLinkPath(input), null, input);
  }
});

test('markdownViewerHref round-trips a Japanese path with slashes', () => {
  const path = '/data/資料/記録 1.md';
  const url = new URL(markdownViewerHref('01ABC', path), 'http://x');
  assert.equal(url.pathname, '/work/markdown');
  assert.equal(url.searchParams.get('id'), '01ABC');
  assert.equal(url.searchParams.get('path'), path);
});
