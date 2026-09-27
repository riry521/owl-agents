'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { listWorkBacklog } from '@/lib/api-client';
import type { BacklogItem } from '@/lib/types';
import { backlogLocation } from '@/lib/backlog-draft.mjs';
import type { TFunction } from '@/lib/i18n';

export function WorkBacklogSection({
  workId,
  refreshToken,
  t,
}: {
  workId: string;
  refreshToken: number;
  t: TFunction;
}) {
  const [items, setItems] = useState<BacklogItem[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let alive = true;
    setItems(null);
    setLoadError(false);
    listWorkBacklog(workId)
      .then((result) => {
        if (alive) setItems(result);
      })
      .catch((error) => {
        console.error('[Owl] Work backlog load failed', error);
        if (alive) setLoadError(true);
      });
    return () => {
      alive = false;
    };
  }, [workId, refreshToken]);

  if (!loadError && (!items || items.length === 0)) return null;

  return (
    <section className="panel" aria-labelledby="sec-backlog">
      <h2 className="panel__title" id="sec-backlog">
        {t('backlog.workSection.title')} <span className="count">{items?.length ?? 0}</span>
      </h2>
      {loadError && <div className="error" role="alert">{t('backlog.workSection.loadError')}</div>}
      {items && items.length > 0 && (
        <div className="list">
          {items.map((item) => (
            <div className="row" key={item.id}>
              <div className="row__main">
                <div className="row__sub">
                  <span className={`badge ${item.status === 'open' ? 'badge--blue' : item.status === 'done' ? 'badge--green' : 'badge--gray'}`}>
                    {t(`backlog.status.${item.status}`)}
                  </span>
                </div>
                <div className="row__title mono">{backlogLocation(item, t)}</div>
                <div>{item.problem}</div>
                {item.status === 'done' && item.issued_work_id && (
                  <div className="row__sub">
                    {t('backlog.item.issuedWork')}:{' '}
                    <Link href={`/work?id=${encodeURIComponent(item.issued_work_id)}`}>
                      {item.issued_work_display_number === null
                        ? item.issued_work_title ?? item.issued_work_id
                        : `Work #${item.issued_work_display_number} ${item.issued_work_title ?? ''}`}
                    </Link>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="btn-row mt-10">
        <Link className="btn" href="/backlog">{t('backlog.workSection.openAll')}</Link>
      </div>
    </section>
  );
}
