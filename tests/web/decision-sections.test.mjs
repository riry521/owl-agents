import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decisionContextLines, decisionDisplay } from '../../apps/web/lib/decision-sections.mjs';

test('decisionContextLines drops bare ids and lines an earlier text already said', () => {
  const lines = decisionContextLines({
    reason: '前提待ち / 待っていた内容: Aの完了 / 詳細: 依存先が未完了です。 / （01ARZ3NDEKTSV4RRFFQ69TASK1）',
    current_state: '判断待ち',
    tried: '待っていた内容: Aの完了\n- Aの完了\n詳細: 依存先が未完了です',
  });
  assert.deepEqual(lines, {
    reason: ['前提待ち', '待っていた内容: Aの完了', '詳細: 依存先が未完了です。'],
    current_state: ['判断待ち'],
    tried: [],
  });
});

test('decisionContextLines keeps long headings as part of the line and handles empty texts', () => {
  assert.deepEqual(
    decisionContextLines({ reason: 'とても長い見出しの付いた行です: X', current_state: 'X', tried: '原因（01ARZ3NDEKTSV4RRFFQ69TASK1）の調査' }),
    { reason: ['とても長い見出しの付いた行です: X'], current_state: ['X'], tried: ['原因の調査'] },
  );
  assert.deepEqual(decisionContextLines({ reason: '', current_state: '  ', tried: '\n / \n' }), { reason: [], current_state: [], tried: [] });
});

test('decisionDisplay shows a plain explanation (ready, plain) summary and next_steps in the why and how parts', () => {
  const view = decisionDisplay({
    explanation: { status: 'ready', plain: true, summary: 'レイアウトが登録一覧にありません。', next_steps: 'mikata_long か duo_wide を選んでください。' },
    questionText: 'どちらにしますか？',
    decision: { reason: '検証できません', current_state: '', tried: '' },
  });
  assert.equal(view.ready, true);
  assert.deepEqual(view.howLines, ['mikata_long か duo_wide を選んでください。']);
  assert.ok(!view.lines.reason.includes('レイアウトが登録一覧にありません。'));
});

test('the screen headings put the bottleneck before the options and the answer-field guide is shown', async () => {
  const { readFileSync } = await import('node:fs');
  const ja = JSON.parse(readFileSync(new URL('../../apps/web/lib/i18n/ja.json', import.meta.url), 'utf8')).decision;
  assert.equal(ja.why, 'ネックになっている部分');
  assert.equal(ja.how, '選択肢');
  assert.match(ja.freeTextPlaceholder, /Manager が直します/u);
  const view = readFileSync(new URL('../../apps/web/components/DecisionView.tsx', import.meta.url), 'utf8');
  assert.ok(view.indexOf("t('decision.why')") < view.indexOf("t('decision.how')"));
});

test('decisionDisplay leads with the bottleneck summary, then the options guidance', () => {
  const out = decisionDisplay({
    explanation: { status: 'ready', summary: '止まっています', next_steps: '回答欄に一言書けば Manager が直します' },
    questionText: '続けますか？',
    decision: { reason: '', current_state: '', tried: '' },
  });
  assert.deepEqual(out.howLines, ['回答欄に一言書けば Manager が直します']);
  assert.deepEqual(out.questionLines, ['続けますか？']);
});
