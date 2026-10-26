import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { repoRoot } from '../helpers/paths.mjs';

const css = readFileSync(join(repoRoot, 'apps/web/app/globals.css'), 'utf8');
const BEGIN = '/* advisor-windows: begin */';
const END = '/* advisor-windows: end */';
const start = css.indexOf(BEGIN);
const end = css.indexOf(END);
const own = css.slice(start, end);
const outside = css.slice(0, start) + css.slice(end + END.length);
const squash = (s) => s.replace(/\s+/g, '').replace(/\/\*.*?\*\//g, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Body of the first rule whose selector is exactly `selector`, searched in `src`.
function block(src, selector) {
  const m = new RegExp(`(?:^|[};])${esc(squash(selector))}\\{([^{}]*)\\}`).exec(squash(src));
  assert.ok(m, `rule not found: ${selector}`);
  return m[1];
}
function media(query) {
  const s = squash(own);
  const head = `@media${squash(query)}{`;
  const i = s.indexOf(head);
  assert.ok(i >= 0, `media not found: ${query}`);
  let depth = 1, j = i + head.length;
  while (depth > 0) depth += s[j] === '{' ? 1 : s[j] === '}' ? -1 : 0, j++;
  return s.slice(i + head.length, j - 1);
}
const has = (body, ...decls) => decls.forEach((d) => assert.ok(body.includes(squash(d)), `missing: ${d}`));

test('the advisor-windows fence exists', () => {
  assert.ok(start >= 0 && end > start);
});

test('page frame: body, .page and wrap', () => {
  has(block(own, 'body:has(.advisor-page-wrap)'), 'display:flex', 'height:100dvh', 'min-height:0');
  has(block(own, '.page:has(> .advisor-page-wrap)'), 'padding:0', 'max-width:none', 'min-height:0');
  has(block(own, '.advisor-page-wrap'), 'min-height:var(--advisor-min-h)');
  for (const v of ['--tabbar-h', '--advisor-picker-w', '--advisor-min-h', '--advisor-notice-max-h', '--advisor-fixed-h']) {
    assert.ok(squash(block(own, ':root')).includes(`${v}:`), v);
  }
});

test('old .advisor-page-wrap rules are gone', () => {
  assert.ok(!/\.advisor-page-wrap\{[^}]*margin:-20px/.test(squash(css)));
  assert.ok(!/\.advisor-page-wrap\{[^}]*height:calc\(100vh/.test(squash(css)));
});

test('grid rows, notice cap and list scroll', () => {
  has(block(own, '.advisor-windows-layout'), 'grid-template-rows:auto minmax(0, 1fr)', 'min-height:0');
  has(block(own, '.advisor-windows-layout__notices'), 'max-height:var(--advisor-notice-max-h)', 'overflow-y:auto');
  has(block(own, '.advisor-window-picker__list'), 'overflow-y:auto', 'min-height:0');
});

test('mobile: wrap padding and static input area', () => {
  const m = media('(max-width: 768px)');
  has(block(m, '.advisor-page-wrap'), 'padding:0 12px var(--tabbar-h)');
  has(block(m, '.advisor-page-wrap .advisor__input-area'), 'position:static');
});

test('low-screen tiers', () => {
  const t1 = media('(max-height: 560px), (max-width: 768px) and (max-height: 640px)');
  has(t1, '--advisor-min-h:250px', '--advisor-notice-max-h:40px', '--advisor-fixed-h:257px');
  has(block(t1, 'body:has(.advisor-page-wrap) .info-banner'), 'max-height:32px');
  const t2 = media('(max-width: 768px) and (max-height: 640px)');
  has(t2, '--advisor-min-h:176px', '--advisor-fixed-h:280px', '.advisor-page-wrap .advisor__session-badges{display:none');
});

test('textarea max-height and banner shrink', () => {
  const ta = block(own, '.advisor-page-wrap .advisor__textarea');
  has(ta, 'max-height:max(calc(1.5em + 8px), min(', '100dvh - var(--advisor-fixed-h) - var(--advisor-banner-h, 0px)');
  has(block(own, 'body:has(.advisor-page-wrap) .info-banner'), 'max-height:64px', 'overflow-y:auto');
  has(block(own, 'body:has(.advisor-page-wrap):has(.info-banner)'), '--advisor-banner-h');
});

test('picker row, window-name button and sheet live inside the fence', () => {
  has(block(own, '.advisor-window-picker__row[aria-current="page"]'), 'background:var(--card)', 'box-shadow:var(--shadow)');
  has(block(own, '.advisor__window-trigger'), 'display:none');
  has(block(own, '.advisor-window-sheet'), 'position:fixed', 'bottom:var(--tabbar-h)');
  has(block(own, '.advisor-window-sheet__overlay'), 'position:fixed', 'inset:0');
  assert.ok(!squash(outside).includes('.advisor-window-picker__select'));
});

test('shared selectors inside the fence are scoped', () => {
  const rules = squash(own).replace(/@media[^{]*\{/g, '').split('}');
  for (const r of rules) {
    const sel = r.split('{')[0];
    for (const s of sel.split(',')) {
      if (!s) continue;
      if (/(^|[^-\w])\.advisor(__|\{|\s|:|\[|$)/.test(s)) {
        assert.match(s, /^\.advisor-page-wrap|^\.advisor__window-trigger/, s);
      }
      if (/\.info-banner|\.provider-pause-banner/.test(s)) assert.match(s, /^body:has\(\.advisor-page-wrap\)/, s);
    }
  }
});

test('home and board rules outside the fence are unchanged', () => {
  const o = squash(outside);
  has(block(outside, '.advisor'), 'height:calc(100vh - var(--nav-h) - 40px)', 'max-width:1080px');
  assert.ok(o.includes('.advisor{height:calc(100vh-var(--nav-h)-83px)'));
  assert.ok(/\.advisor__input-area\{position:fixed/.test(o));
  has(block(outside, '.info-banner'), 'padding:12px 14px');
  has(block(outside, '.btn'), 'min-height:40px');
  assert.ok(!/(^|[};])\.advisor__header-title\{display:none/.test(o));
  assert.ok(!o.includes('.advisor-page-wrap{'));
});
