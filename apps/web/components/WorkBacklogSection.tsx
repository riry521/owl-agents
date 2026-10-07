'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { listBacklog, listWorkBacklog } from '@/lib/api-client';
import type { BacklogItem, WorkAdvisorBacklogEntry } from '@/lib/types';
import { backlogLocation } from '@/lib/backlog-draft.mjs';
import { backlogStatusBadge, showsLinkedWork } from '@/lib/backlog-link.mjs';
import type { TFunction } from '@/lib/i18n';

function ItemList({ items, t, showLinked }: { items: BacklogItem[]; t: TFunction; showLinked: boolean }) {
  return (
    <div className="list">
      {items.map((item) => (
        <div className="row" key={item.id}>
          <div className="row__main">
            <div className="row__sub">
              <span className={`badge ${backlogStatusBadge(item.status)}`}>{t(`backlog.status.${item.status}`)}</span>
            </div>
            <div className="row__title mono">{backlogLocation(item, t)}</div>
            <div>{item.problem}</div>
            {showLinked && showsLinkedWork(item) && item.issued_work_id && (
              <div className="row__sub">
                {t('backlog.item.linkedWork')}:{' '}
                <Link href={`/work?id=${encodeURIComponent(item.issued_work_id)}`}>
                  {item.issued_work_display_number === null
                    ? item.issued_work_title ?? item.issued_work_id
                    : `#${item.issued_work_display_number} ${item.issued_work_title ?? ''}`}
                </Link>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function WorkBacklogSection({
  workId,
  dismissed,
  refreshToken,
  t,
}: {
  workId: string;
  dismissed: WorkAdvisorBacklogEntry[];
  refreshToken: number;
  t: TFunction;
}) {
  const [items, setItems] = useState<BacklogItem[] | null>(null);
  const [linked, setLinked] = useState<BacklogItem[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let alive = true;
    setItems(null);
    setLinked(null);
    setLoadError(false);
    Promise.all([listWorkBacklog(workId), listBacklog({ issued_work_id: workId })])
      .then(([own, addressed]) => {
        if (!alive) return;
        setItems(own);
        setLinked(addressed);
      })
      .catch((error) => {
        console.error('[Owl] Work backlog load failed', error);
        if (alive) setLoadError(true);
      });
    return () => {
      alive = false;
    };
  }, [workId, refreshToken]);

  const hasItems = (items?.length ?? 0) > 0;
  const hasLinked = (linked?.length ?? 0) > 0;
  const hasDismissed = dismissed.length > 0;
  if (!loadError && !hasItems && !hasLinked && !hasDismissed) return null;

  return (
    <section className="panel" aria-labelledby="sec-backlog">
      {loadError && <div className="error" role="alert">{t('backlog.workSection.loadError')}</div>}
      {hasItems && items && (
        <>
          <h2 className="panel__title" id="sec-backlog">
            {t('backlog.workSection.title')} <span className="count">{items.length}</span>
          </h2>
          <ItemList items={items} t={t} showLinked />
        </>
      )}
      {hasLinked && linked && (
        <>
          <h2 className="panel__title" id={hasItems ? undefined : 'sec-backlog'}>
            {t('backlog.workSection.linkedTitle')} <span className="count">{linked.length}</span>{' '}
            <Link className="btn" href="/backlog">{t('backlog.workSection.openAll')}</Link>
          </h2>
          <ItemList items={linked} t={t} showLinked={false} />
        </>
      )}
      {hasDismissed && (
        <>
          <h2 className="panel__title" id={hasItems || hasLinked ? undefined : 'sec-backlog'}>
            {t('backlog.workSection.dismissedTitle')} <span className="count">{dismissed.length}</span>
          </h2>
          <div className="list">
            {dismissed.map((entry) => (
              <div className="row" key={entry.id}>
                <div className="row__main">
                  <div className="row__title mono">
                    {entry.file === null ? entry.id : entry.line === null ? entry.file : `${entry.file}:${entry.line}`}
                  </div>
                  <div>{entry.problem}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
