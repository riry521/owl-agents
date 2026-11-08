import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import { repoRoot } from '../helpers/paths.mjs';

const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const ja = JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8'));

const t = (key, params = {}) =>
  key.split('.').reduce((node, part) => node[part], ja).replace(/\{\{(\w+)\}\}/g, (_, name) => params[name]);

function compile(relativePath, overrides) {
  const modulePath = join(repoRoot, relativePath);
  const { outputText } = ts.transpileModule(readFileSync(modulePath, 'utf8'), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(modulePath);
  loaded.filename = modulePath;
  loaded.paths = Module._nodeModulePaths(dirname(modulePath));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(overrides, request)) return overrides[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, modulePath);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports;
}

const { MarkdownDocument } = compile('apps/web/components/MarkdownDocument.tsx', {
  '@/lib/i18n': { useLocale: () => ({ locale: 'ja', t }) },
  '@/lib/markdown-toc.mjs': await import(join(repoRoot, 'apps/web/lib/markdown-toc.mjs')),
});
const render = (markdown) => renderToStaticMarkup(React.createElement(MarkdownDocument, { markdown }));

test('raw HTML is not rendered', () => {
  const html = render('<script>alert(1)</script>\n\n<img src="https://evil.example/x.png" onerror="x()">\n\ntext');
  assert.ok(!html.includes('<script') && !html.includes('onerror') && !html.includes('evil.example'));
  assert.ok(html.includes('text'));
});

test('an image is shown as its alt text and never loaded', () => {
  const html = render('![architecture](https://evil.example/a.png)');
  assert.ok(!html.includes('<img') && !html.includes('evil.example'));
  assert.ok(html.includes('画像: architecture'));
});

test('http and https links open in a new tab with noopener noreferrer', () => {
  const html = render('[a](https://example.com/x) and [b](http://example.com/y)');
  assert.equal(html.match(/target="_blank" rel="noopener noreferrer"/g)?.length, 2);
});

test('# links stay links; every other link becomes plain text', () => {
  const html = render('[top](#top) [rel](./other.md) [js](javascript:alert(1)) [mail](mailto:a@b.c)');
  assert.ok(html.includes('<a href="#top">top</a>'));
  assert.ok(!html.includes('other.md"') && !html.includes('javascript') && !html.includes('mailto'));
  for (const label of ['rel', 'js', 'mail']) assert.ok(html.includes(label));
});

test('a table is wrapped in a scrollable region', () => {
  const html = render('| a | b |\n| - | - |\n| 1 | 2 |');
  assert.ok(html.includes('<div class="md-table-scroll" tabindex="0" role="region" aria-label="横に動かせる表"><table>'));
});

test('top-level headings get an id and tabindex for the contents list', () => {
  const html = render('# 題名\n\n## はじめに');
  assert.ok(html.includes('id="はじめに"') && html.includes('tabindex="-1"'));
});

test('an empty body shows the empty message', () => {
  assert.ok(render('  \n').includes('このファイルは空です'));
});
