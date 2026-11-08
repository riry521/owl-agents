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
