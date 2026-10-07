'use client';

import { useEffect, useState } from 'react';
import { getWorkSummaryRevisions, type WorkSummaryRevision } from '@/lib/api-client';
import { formatDateTime, formatRelative } from '@/lib/format';
import type { Locale, TFunction } from '@/lib/i18n';

const TRIGGER_KEYS = {
  owner_edit: 'work.summaryTriggerOwnerEdit',
  instruction: 'work.summaryTriggerInstruction',
  reopen: 'work.summaryTriggerReopen',
  decision: 'work.summaryTriggerDecision',
  auto_conflict: 'work.summaryTriggerAutoConflict',
} as const;

interface WorkSummaryHistoryProps {
  workId: string;
  refreshToken: number;
  now: number;
  locale: Locale;
  t: TFunction;
}

/** Past Work title/summary revisions. Hidden when there are none; a failed fetch only affects this section. */
export function WorkSummaryHistory({ workId, refreshToken, now, locale, t }: WorkSummaryHistoryProps) {
  const [revisions, setRevisions] = useState<WorkSummaryRevision[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let alive = true;
    getWorkSummaryRevisions(workId)
      .then((result) => {
        if (!alive) return;
        setRevisions(result.revisions);
        setTruncated(result.truncated);
        setLoadError(false);
      })
      .catch((error) => {
        console.error('[Owl] Summary history failed', error);
        if (alive) setLoadError(true);
      });
    return () => {
      alive = false;
    };
  }, [workId, refreshToken]);

  if (!loadError && (!revisions || revisions.length === 0)) return null;

  return (
    <section className="panel" aria-labelledby="sec-summary-history">
      <h2 className="panel__title" id="sec-summary-history">
        {t('work.summaryHistory')} <span className="count">{revisions?.length ?? 0}</span>
      </h2>
      {loadError && <div className="error" role="alert">{t('work.errorSummaryHistoryLoad')}</div>}
      {truncated && <p className="empty">{t('work.summaryHistoryTruncated')}</p>}
      <div className="list">
        {revisions?.map((rev) => (
          <details key={rev.id} className="row">
            <summary>
              {rev.actor === 'owner' ? t('work.summaryActorOwner') : t('work.summaryActorManager')} · {t(TRIGGER_KEYS[rev.trigger.kind] ?? TRIGGER_KEYS.instruction)} · {formatDateTime(rev.created_at, locale)} ({formatRelative(rev.created_at, now, locale)})
              {rev.trigger.text ? ` · ${rev.trigger.text}` : ''}
            </summary>
            {rev.changed_fields.map((field) => (
              <div key={field} className="mt-10">
                <strong>{t(field === 'title' ? 'work.summaryFieldTitle' : 'work.summaryFieldSummary')}</strong>
                <div className="kb-body">{t('work.summaryBefore')}: {rev.before[field]}</div>
                <div className="kb-body">{t('work.summaryAfter')}: {rev.after[field]}</div>
              </div>
            ))}
          </details>
        ))}
      </div>
    </section>
  );
}
