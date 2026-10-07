'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { answerDecision, getDecision } from '@/lib/api-client';
import { useView } from '@/lib/view-loader';
import type { DecisionAnswerResult, DecisionView as DecisionData } from '@/lib/types';
import { TaskStateBadge } from '@/components/StateBadge';
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

      {/* The Decision template: why it stopped → what to decide → what each choice does → the facts. */}
      <section className="panel" aria-labelledby="sec-reason">
        <h2 className="panel__title" id="sec-reason">
          {t('decision.why')}
        </h2>
        <p className="decision__text">{decision.reason}</p>
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

      <section className="panel decision__ask" aria-labelledby="sec-question">
        <h2 className="panel__title" id="sec-question">
          {t('decision.question')}
        </h2>
        <p className="decision__question">{decision.question || t('decision.questionMissing')}</p>
      </section>

      <section className="panel" aria-labelledby="sec-options">
        <h2 className="panel__title" id="sec-options">
          {t('decision.options')}
        </h2>
        {decision.options.length === 0 && (
          <p className="empty">{decision.allow_free_text ? t('decision.freeTextOnlyHint') : t('decision.noOptions')}</p>
        )}
        <div className="list">
          {decision.options.map((o, i) => (
            <div key={o.key} className={`option${o.key === decision.recommended ? ' option--recommended' : ''}`}>
              <span className="option__key">{String.fromCharCode(65 + i)}</span>
              <div className="option__body">
                <div className="option__label">
                  {o.label}
                  {o.key === decision.recommended && <span className="badge badge--accent badge--ml">{t('decision.recommended')}</span>}
                </div>
                <div className="option__desc">{o.description || t('decision.effectMissing')}</div>
              </div>
              {!answered && (
                <button
                  type="button"
                  className={`btn${o.key === decision.recommended ? ' btn--primary' : ''}`}
                  disabled={busy}
                  onClick={() => void submit(o.label, o.key)}
                >
                  {t('decision.choose')}
                </button>
              )}
            </div>
          ))}
        </div>
        {answered ? (
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
        )}
      </section>

      {(decision.current_state || decision.tried) && (
        <section className="panel" aria-labelledby="sec-context">
          <h2 className="panel__title" id="sec-context">
            {t('decision.context')}
          </h2>
          <dl className="kv kv--spaced">
            {decision.current_state && (
              <>
                <dt>{t('decision.currentState')}</dt>
                <dd className="decision__text">{decision.current_state}</dd>
              </>
            )}
            {decision.tried && (
              <>
                <dt>{t('decision.tried')}</dt>
                <dd className="decision__text">{decision.tried}</dd>
              </>
            )}
          </dl>
        </section>
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
