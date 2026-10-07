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
const componentReact = { ...React };
const dictionaries = {
  ja: JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/ja.json'), 'utf8')),
  en: JSON.parse(readFileSync(join(repoRoot, 'apps/web/lib/i18n/en.json'), 'utf8')),
};

const proposal = {
  id: '01M3F000000000000000000001',
  fingerprint: 'a'.repeat(16),
  origin: 'note',
  level: 'role',
  role: 'worker',
  text: 'Keep each change focused.',
  rationale: 'The review found unrelated edits were hard to validate.',
  applies_to: 'When changing an existing codebase.',
  note_id: '01M3F000000000000000000002',
  source_work_ids_json: '[]',
  source_work_ids: [],
  source_count: 2,
  project_id: null,
  status: 'awaiting_approval',
  decision: null,
  attempts: 0,
  last_error: 'rule_store_busy',
  applied_rule_id: null,
  applied_path: null,
  created_at: '2026-09-27T00:00:00.000Z',
  updated_at: '2026-09-27T00:00:00.000Z',
};

function translate(locale, key, values = {}) {
  const entry = key.split('.').reduce((current, part) => current?.[part], dictionaries[locale]);
  return typeof entry === 'string'
    ? entry.replace(/\{\{(\w+)\}\}/gu, (_, name) => String(values[name] ?? ''))
    : key;
}

function translationKeys(value, prefix = '') {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child !== null && typeof child === 'object' && !Array.isArray(child)
      ? translationKeys(child, path)
      : [path];
  }).sort();
}

function compileWebComponent(modulePath, overrides = {}) {
  const source = readFileSync(modulePath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const loaded = new Module(modulePath);
  loaded.filename = modulePath;
  loaded.paths = Module._nodeModulePaths(dirname(modulePath));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'react') return componentReact;
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

function renderRuleApprovals(locale, status = 'awaiting_approval', proposalValue = proposal) {
  const state = [
    new Set(),
    {},
    null,
    status,
  ];
  let nextState = 0;
  componentReact.useState = () => [state[nextState++], () => {}];
  componentReact.useEffect = () => {};
  componentReact.useCallback = (callback) => callback;
  componentReact.useMemo = (callback) => callback();
  const componentApiClient = {
    listRuleProposals: async () => [proposal],
    approveRuleProposal: async () => ({ proposal_id: proposal.id, status: 'applied', applied_rule_id: 'approved-rule', applied_path: 'rules/system/owl-approved.yaml' }),
    rejectRuleProposal: async () => ({ proposal_id: proposal.id, status: 'rejected', applied_rule_id: null, applied_path: null }),
  };
  const componentViewLoader = { useView: () => ({ data: [proposalValue], error: null, loading: false, refresh: async () => {} }) };
  const componentI18n = { useLocale: () => ({ locale, t: (key, values) => translate(locale, key, values) }) };
  const module = compileWebComponent(join(repoRoot, 'apps/web/components/RuleApprovalsView.tsx'), {
    '@/lib/api-client': componentApiClient,
    '@/lib/i18n': componentI18n,
    '@/lib/view-loader': componentViewLoader,
  });
  return renderToStaticMarkup(React.createElement(module.RuleApprovalsView)).replaceAll('&amp;', '&');
}

test('RuleApprovalsView renders proposal details and localized actions in Japanese and English', () => {
  for (const locale of ['ja', 'en']) {
    const html = renderRuleApprovals(locale);
    for (const text of [
      proposal.text,
      proposal.rationale,
      proposal.applies_to,
      'worker',
      '2',
      translate(locale, 'rules.approvals.title', { count: '1' }),
      translate(locale, 'rules.approvals.origin.note'),
      translate(locale, 'rules.approvals.sourceWorkLabel', { count: '0' }),
      translate(locale, 'rules.approvals.reasonLabel'),
      translate(locale, 'rules.approvals.scopeLabel'),
      translate(locale, 'rules.approvals.lastError', { error: 'rule_store_busy' }),
      translate(locale, 'rules.approvals.approveButton'),
      translate(locale, 'rules.approvals.rejectButton'),
    ]) {
      assert.ok(html.includes(text), `${locale} screen should render ${text}`);
    }
  }
});

test('RuleApprovalsView hides approval actions for proposals waiting for sources', () => {
  const pendingProposal = { ...proposal, status: 'pending' };
  for (const locale of ['ja', 'en']) {
    const html = renderRuleApprovals(locale, 'pending', pendingProposal);
    assert.ok(html.includes(translate(locale, 'rules.approvals.pendingSubtitle')));
    assert.ok(!html.includes(translate(locale, 'rules.approvals.approveButton')));
    assert.ok(!html.includes(translate(locale, 'rules.approvals.rejectButton')));
  }
});

test('Japanese and English message keys stay aligned', () => {
  assert.deepEqual(translationKeys(dictionaries.ja), translationKeys(dictionaries.en));
});
