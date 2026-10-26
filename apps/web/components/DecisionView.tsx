'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { answerDecision, getDecision } from '@/lib/api-client';
import { useView } from '@/lib/view-loader';
import type { DecisionAnswerResult, DecisionOption, DecisionView as DecisionData } from '@/lib/types';
import { TaskStateBadge } from '@/components/StateBadge';
import { decisionDisplay } from '@/lib/decision-sections.mjs';
import { workDisplayNumber } from '@/lib/format';
import { useLocale } from '@/lib/i18n';

export function DecisionView() {
  const { t } = useLocale();
  const params = useSearchParams();
  const id = params.get('id');
  const [freeText, setFreeText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DecisionAnswerResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view = useView<DecisionData | null>(id ? `decision:${id}` : null, () => getDecision(id ?? ''));
  const { refresh } = view;
  const data = id ? view.data : null;
  const loadError = id && view.error ? humanizeError(view.error, t) : null;

  useEffect(() => {
    if (view.error) console.error('[Owl] Decision load failed', view.error);
  }, [view.error]);
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [id]);

  if (data === undefined) {
    return loadError ? <div className="error">{loadError}</div> : <p className="empty">{t('common.loading')}</p>;
  }
  if (data === null) {
    return (
      <div className="panel decision">
        <h1 className="page__title">{t('decision.notFound')}</h1>
        <p className="page__sub">
          {t('decision.notFoundDetail', { id: id ?? t('common.none') })}{' '}
          <Link href="/board">{t('common.backToBoard')}</Link>
        </p>
      </div>
    );
  }

  const { decision, work, blocked_tasks } = data;
  const answered = result !== null || decision.status !== 'open';
  const workHref = `/work?id=${encodeURIComponent(work.id)}`;
  const workNumber = workDisplayNumber(work.display_number);
  const workNumberBadge = workNumber !== null && (
    <>
      <span className="badge badge--gray">{t('work.numberLabel', { number: String(workNumber) })}</span>{' '}
    </>
  );
  const statusBadge = decision.status === 'open' ? 'badge badge--amber' : 'badge badge--green';
  const statusText = decision.status === 'open' ? t('decision.statusOpen') : decision.status === 'resolved' ? t('decision.statusResolved') : t('decision.statusCancelled');

  async function submit(answer: string, optionKey: string | null) {
    if (!id || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await answerDecision(id, { answer, option_key: optionKey, source: 'web', source_message_id: null });
      setResult(r);
      void refresh();
    } catch (e) {
      setError(humanizeError(e, t));
    } finally {
      setBusy(false);
    }
  }

  function onFreeText(ev: FormEvent) {
    ev.preventDefault();
    const text = freeText.trim();
    if (!text) {
      setError(t('decision.answerRequired'));
      return;
    }
    void submit(text, null);
  }

  const explanation = decision.explanation ?? null;
  const causeKind = explanation?.cause_kind ?? null;
  const notes = new Map((explanation?.option_notes ?? []).map((n) => [n.key, n.note]));
  // The question and the explanation texts are shown outside the stored reason; put them first so a repeat of them is dropped from the reason lines.
  const questionText = decision.question || t('decision.questionMissing');
  const { ready, howLines, questionLines, lines } = decisionDisplay({ explanation, questionText, decision });
  const fixOptions = decision.options.filter((o) => o.key.startsWith('fix_'));
  const otherOptions = decision.options.filter((o) => !o.key.startsWith('fix_'));
  const paragraphs = (items: string[]) => items.map((line, n) => <p key={n} className="decision__text">{line}</p>);

  function renderOption(o: DecisionOption, i: number) {
    const recommended = o.key === decision.recommended;
    const description = (ready && !o.key.startsWith('fix_') ? notes.get(o.key) : undefined) || o.description;
    return (
      <div key={o.key} className={`option${recommended ? ' option--recommended' : ''}`}>
        <span className="option__key">{String.fromCharCode(65 + i)}</span>
        <div className="option__body">
          <div className="option__label">
            {o.label}
            {recommended && <span className="badge badge--accent badge--ml">{t('decision.recommended')}</span>}
          </div>
          <div className="option__desc">{description || t('decision.effectMissing')}</div>
          {o.criteria_rewrites?.map((r, n) => (
            <dl key={n} className="kv kv--spaced">
              <dt>{t('decision.rewriteBefore')}</dt>
              <dd>{r.before}</dd>
              <dt>{t('decision.rewriteAfter')}</dt>
              <dd>{r.after}</dd>
              <dt>{t('decision.rewriteCheck')}</dt>
              <dd>{r.check}</dd>
            </dl>
          ))}
        </div>
        {!answered && (
          <button type="button" className={`btn${recommended ? ' btn--primary' : ''}`} disabled={busy} onClick={() => void submit(o.label, o.key)}>
            {t('decision.choose')}
          </button>
        )}
      </div>
    );
  }

  const contextList = (
    <dl className="kv kv--spaced">
      {lines.current_state.length > 0 && (
        <>
          <dt>{t('decision.currentState')}</dt>
          <dd>{paragraphs(lines.current_state)}</dd>
        </>
      )}
      {lines.tried.length > 0 && (
        <>
          <dt>{t('decision.tried')}</dt>
          <dd>{paragraphs(lines.tried)}</dd>
        </>
      )}
    </dl>
  );
  const hasContext = lines.current_state.length > 0 || lines.tried.length > 0;

  const answerArea = answered ? (
    <div className="answered mt-14">
      <strong>{t('decision.answerSent')}</strong>
      {result ? t('decision.resumedTasks', { count: String(result.resumed_task_ids.length) }) : t('decision.alreadyAnswered')}
      <div className="mt-10">
        <Link href={workHref} className="btn">
          {t('decision.toWorkDetail')}
        </Link>
      </div>
    </div>
  ) : (
    <>
      {decision.allow_free_text && (
        <form onSubmit={onFreeText} className="mt-14">
          <label htmlFor="free-answer" className="note note--block">
            {t('decision.freeTextLabel')}
          </label>
          <textarea
            id="free-answer"
            className="textarea"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder={t('decision.freeTextPlaceholder')}
            disabled={busy}
          />
          <div className="btn-row mt-8">
            <button type="submit" className="btn" disabled={busy}>
              {t('decision.freeTextSubmit')}
            </button>
          </div>
        </form>
      )}
      {error && <div className="error mt-10">{error}</div>}
    </>
  );

  return (
    <div className="decision">
      <div className="crumbs">
        <Link href="/board">{t('board.title')}</Link>
        <span>›</span>
        <Link href={workHref}>
          {workNumberBadge}
          {work.title}
        </Link>
        <span>›</span>
        <strong>{t('decision.breadcrumbDecision')}</strong>
      </div>

      <div className="page__head">
        <div>
          <h1 className="page__title">{t('decision.title')}</h1>
          <p className="page__sub">{t('decision.subtitle')}</p>
        </div>
        <span className={statusBadge}>{statusText}</span>
      </div>

      {/* Always two parts: why it stopped, then what the Owner can do. Without a ready explanation the stored texts fill both, with repeats removed. */}
      <section className="panel" aria-labelledby="sec-reason">
        <h2 className="panel__title" id="sec-reason">
          {t('decision.why')}
          {ready && causeKind && (
            <span className="badge badge--amber badge--ml">
              {t('decision.causeLabel')}: {t(`decision.causeKind.${causeKind}`)}
            </span>
          )}
        </h2>
        {explanation?.status === 'pending' && <p className="note note--block">{t('decision.explanationPending')}</p>}
        {explanation?.status === 'failed' && <p className="note note--block">{t('decision.explanationFailed')}</p>}
        {ready ? <p className="decision__text">{explanation?.summary}</p> : paragraphs(lines.reason)}
        <dl className="kv kv--spaced">
          <dt>Work</dt>
          <dd>
            <Link href={workHref}>
              {workNumberBadge}
              {work.title}
            </Link>
          </dd>
          <dt>{t('decision.scopeLabel')}</dt>
          <dd>{decision.scope === 'task' ? t('decision.scopeTask') : t('decision.scopeWork')}</dd>
          {blocked_tasks.length > 0 && (
            <>
              <dt>{t('decision.blockedTasks')}</dt>
              <dd>
                <div className="chips chips--flush">
                  {blocked_tasks.map((bt) => (
                    <span key={bt.id} className="badge badge--gray">
                      {bt.title} <TaskStateBadge status={bt.status} />
                    </span>
                  ))}
                </div>
              </dd>
            </>
          )}
        </dl>
      </section>

      <section className="panel decision__ask" aria-labelledby="sec-how">
        <h2 className="panel__title" id="sec-how">
          {t('decision.how')}
        </h2>
        {howLines.map((line, n) => (
          <p key={n} className="decision__question">
            {line}
          </p>
        ))}
        {decision.options.length === 0 && (
          <p className="empty">{decision.allow_free_text ? t('decision.freeTextOnlyHint') : t('decision.noOptions')}</p>
        )}
        <div className="list mt-14">{fixOptions.map((o, i) => renderOption(o, i))}</div>
        {otherOptions.length > 0 && (
          <>
            {fixOptions.length > 0 && <h3 className="decision__subhead">{t('decision.otherOptions')}</h3>}
            <div className="list">{otherOptions.map((o, i) => renderOption(o, fixOptions.length + i))}</div>
          </>
        )}
        {answerArea}
      </section>

      {ready ? (
        <details className="panel decision__details">
          <summary>{t('decision.detailsSummary')}</summary>
          {paragraphs(questionLines)}
          {paragraphs(lines.reason)}
          {contextList}
        </details>
      ) : (
        hasContext && (
          <section className="panel" aria-labelledby="sec-context">
            <h2 className="panel__title" id="sec-context">
              {t('decision.context')}
            </h2>
            {contextList}
          </section>
        )
      )}
    </div>
  );
}

function humanizeError(e: unknown, t: (key: string) => string): string {
  const code = e instanceof Error ? e.message : String(e);
  switch (code) {
    case 'decision_already_resolved':
      return t('decision.errorAlreadyResolved');
    case 'decision_not_found':
      return t('decision.errorNotFound');
    case 'validation_error':
      return t('decision.errorValidation');
    case 'version_conflict':
      return t('decision.errorVersionConflict');
    case 'network_error':
    case 'runtime_config_unavailable':
      return t('decision.errorNetwork');
    case 'invalid_runtime_config':
    case 'invalid_response':
      return t('decision.errorInvalidResponse');
    default:
      return t('decision.errorDefault');
  }
}
