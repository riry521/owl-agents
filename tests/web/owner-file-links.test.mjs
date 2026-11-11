import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const ReactMarkdown = (await import(pathToFileURL(webRequire.resolve('react-markdown')).href)).default;
const remarkGfm = (await import(pathToFileURL(webRequire.resolve('remark-gfm')).href)).default;
const { ownerFileAnchorProps, remarkOwnerFileLinks } = await import('../../apps/web/lib/owner-file-links.mjs');

const API = '/api/v1';
const ROOTS = [
  { key: 'materials', path: '/data/memory/materials' },
  { key: 'shared', path: '/Users/x/shared files' },
];

const render = (markdown, roots = ROOTS) => renderToStaticMarkup(createElement(ReactMarkdown, {
  remarkPlugins: [remarkGfm, [remarkOwnerFileLinks, { roots, apiBase: API }]],
  components: { a: ({ href, children }) => createElement('a', { href, ...ownerFileAnchorProps(href, API) }, children) },
  skipHtml: true,
}, markdown));
const hrefs = (html) => [...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]);

const HTML = `${API}/owner-files/materials/p/index.html`;
const WAV = `${API}/owner-files/materials/p/sound.wav`;
const PNG = `${API}/owner-files/materials/p/image%20one.png`;

test('paths inside a root become links in prose, inline code, code blocks and file:// links', () => {
  const html = render([
    '場所は /data/memory/materials/p/index.html です。',
    '',
    '`/data/memory/materials/p/sound.wav`',
    '',
    '```',
    'open "/data/memory/materials/p/image.png"',
    '```',
    '',
    '[画像](file:///data/memory/materials/p/image%20one.png)',
  ].join('\n'));
  assert.deepEqual(hrefs(html), [HTML, WAV, `${API}/owner-files/materials/p/image.png`, PNG]);
});

test('a bare file:// path in prose and the root itself link too', () => {
  const html = render('file:///data/memory/materials/p/index.html と /data/memory/materials');
  assert.deepEqual(hrefs(html), [HTML, `${API}/owner-files/materials`]);
  assert.match(render('x /Users/x/shared files/a.txt'), /owner-files\/shared\/a\.txt/);
});

test('outside paths, prefix look-alikes and ".." paths are not linked', () => {
  const text = '/etc/passwd /data/memory/materials-old/a.html /data/memory/materials/../secret.txt /data/memory/materials/p/../../x';
  assert.deepEqual(hrefs(render(text)), []);
  assert.doesNotMatch(render('[x](file:///data/memory/materials/../a)'), /owner-files/);
});

test('without roots the reply is rendered unconverted', () => {
  assert.equal(render('`/data/memory/materials/p/index.html`', []), '<p><code>/data/memory/materials/p/index.html</code></p>');
});

test('every owner-files link opens in a new tab with noopener noreferrer', () => {
  const html = render('/data/memory/materials/p/index.html [a](file:///data/memory/materials/p/sound.wav) [b](https://example.com)');
  const anchors = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
  assert.equal(anchors.length, 3);
  for (const a of anchors.filter((tag) => tag.includes('/owner-files/'))) {
    assert.match(a, /target="_blank"/);
    assert.match(a, /rel="noopener noreferrer"/);
  }
  assert.doesNotMatch(anchors[2], /target=/);
});

const VIEWER = '/owl';
test('a .md name with spaces is one viewer link in prose, inline code and code blocks; neighbours stay separate', () => {
  const M = '/owl/work/markdown?root=materials&amp;path=';
  const body = '/data/memory/materials';
  const html = renderViewer([
    `本文 ${body}/日本語 メモ.md です`,
    '',
    `\`${body}/日本語 メモ.md\``,
    '',
    '```',
    `${body}/a b/c d.MD`,
    `${body}/a.md ${body}/b.md`,
    '```',
    '',
    `${body}/a.md ${body}/b.md`,
    '',
    `${body}/foo.html and notes.md`,
  ].join('\n'));
  assert.deepEqual(hrefs(html), [
    `${M}%E6%97%A5%E6%9C%AC%E8%AA%9E+%E3%83%A1%E3%83%A2.md`,
    `${M}%E6%97%A5%E6%9C%AC%E8%AA%9E+%E3%83%A1%E3%83%A2.md`,
    `${M}a+b%2Fc+d.MD`,
    `${M}a.md`, `${M}b.md`,
    `${M}a.md`, `${M}b.md`,
    HTML.replace('p/index.html', 'foo.html'),
  ]);
  assert.ok(html.includes('>${body}/日本語 メモ.md</a>'.replace('${body}', body)));
});

const renderViewer = (markdown) => renderToStaticMarkup(createElement(ReactMarkdown, {
  remarkPlugins: [remarkGfm, [remarkOwnerFileLinks, { roots: ROOTS, apiBase: API, viewerBase: VIEWER }]],
  components: { a: ({ href, children }) => createElement('a', { href, ...ownerFileAnchorProps(href, API, VIEWER) }, children) },
  skipHtml: true,
}, markdown));

test('.md paths and file:// links go to the Markdown viewer in a new tab; other files stay owner-files links', () => {
  const html = renderViewer([
    '/data/memory/materials/メモ/README.MD と /data/memory/materials/p/index.html',
    '',
    '`/data/memory/materials/a.md`',
    '',
    '```',
    'cat /data/memory/materials/b.md',
    '```',
    '',
    '[x](file:///data/memory/materials/%E6%97%A5%E6%9C%AC/n%20x.md)',
    '',
    '/data/memory/materials/dir.md/',
  ].join('\n'));
  const found = hrefs(html);
  assert.ok(found.includes('/owl/work/markdown?root=materials&amp;path=a.md'));
  assert.ok(found.includes('/owl/work/markdown?root=materials&amp;path=b.md'));
  assert.ok(found.includes('/owl/work/markdown?root=materials&amp;path=%E3%83%A1%E3%83%A2%2FREADME.MD'));
  assert.ok(found.includes('/owl/work/markdown?root=materials&amp;path=%E6%97%A5%E6%9C%AC%2Fn+x.md'));
  assert.ok(found.includes(HTML));
  assert.ok(!found.some((h) => h.includes('path=dir.md')));
  for (const tag of html.match(/<a [^>]*>/g)) {
    assert.match(tag, /target="_blank"/);
    assert.match(tag, /rel="noopener noreferrer"/);
  }
});

test('a direct /api/v1/owner-files link opens in a new tab while roots (and apiBase) are not loaded', () => {
  assert.deepEqual(ownerFileAnchorProps(`${API}/owner-files/materials/a.txt`, ''), { target: '_blank', rel: 'noopener noreferrer' });
  assert.deepEqual(ownerFileAnchorProps('https://example.com/x', ''), {});
  assert.deepEqual(ownerFileAnchorProps('/other/owner-files-old/a', ''), {});
});
