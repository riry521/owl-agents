'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getBoard, subscribeToUpdates } from '@/lib/api-client';
import type { BoardView as BoardData, Decision, WorkSummary } from '@/lib/types';
import { type BoardSection, boardSectionOf, boardSectionLabels } from '@/lib/format';
import { useLocale } from '@/lib/i18n';
import { useWorkRemovals } from '@/lib/work-removal';
import { humanizeError, SECTION_ORDER, SectionBulkButton, WorkCard } from '@/components/BoardView';

/** Archive sections always shown, even empty; anything else (unexpected states) follows if non-empty. */
const PRIMARY_SECTIONS: BoardSection[] = ['done', 'cancelled'];

export function ArchiveView() {
  const { locale, t } = useLocale();
  const [data, setData] = useState<BoardData | null>(null);
  const [now, setNow] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const refreshSequence = useRef(0);
  const { hiddenIds } = useWorkRemovals();

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const next = await getBoard({ archived: 'only' });
      if (sequence !== refreshSequence.current) return;
      setData(next);
      setNow(Date.now());
      setLoadError(null);
    } catch (error) {
      if (sequence !== refreshSequence.current) return;
      console.error('[Owl] Archive refresh failed', error);
      setLoadError(humanizeError(error, t));
    }
  }, [t]);

  useEffect(() => {
    let alive = true;
    void refresh();
    const unsubscribe = subscribeToUpdates([], () => {
      if (alive) void refresh();
    }, () => {});
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [refresh]);

  const backLink = (
    <Link href="/board" className="btn btn--back">
      {t('archive.backToBoard')}
    </Link>
  );

  if (!data) {
    return (
      <>
        <div className="page__head">
          <div>
            <h1 className="page__title">{t('archive.title')}</h1>
            <p className="page__sub">{t('archive.subtitle')}</p>
          </div>
          {backLink}
        </div>
        {loadError ? <div className="error">{loadError}</div> : <p className="empty">{t('common.loading')}</p>}
      </>
    );
  }

  const sectionLabels = boardSectionLabels(locale);
  const grouped: Record<BoardSection, WorkSummary[]> = { judgement: [], running: [], waiting: [], done: [], cancelled: [] };
  for (const w of data.works) {
    if (hiddenIds.has(w.id)) continue;
    // getBoard({ archived: 'only' }) already filters server-side; this is a
    // defensive second check in case a stale response includes a live Work.
    if (!w.archived_at) continue;
    grouped[boardSectionOf(w.state)].push(w);
  }
  const overflowSections = SECTION_ORDER.filter(
    (section) => !PRIMARY_SECTIONS.includes(section) && grouped[section].length > 0,
  );
  const sectionsToRender = [...PRIMARY_SECTIONS, ...overflowSections];
  const totalWorks = sectionsToRender.reduce((sum, section) => sum + grouped[section].length, 0);

  const decisionsByWork = new Map<string, Decision[]>();
  for (const d of data.open_decisions) {
    decisionsByWork.set(d.work_id, [...(decisionsByWork.get(d.work_id) ?? []), d]);
  }

  return (
    <>
      <div className="page__head">
        <div>
          <h1 className="page__title">{t('archive.title')}</h1>
          <p className="page__sub">{t('archive.subtitle')}</p>
        </div>
        {backLink}
      </div>
      {loadError && <div className="error mt-10">{loadError}</div>}

      {totalWorks === 0 ? (
        <p className="empty">{t('archive.empty')}</p>
      ) : (
        sectionsToRender.map((section) => {
          const works = grouped[section];
          const cols = section === 'judgement' ? 2 : 3;
          return (
            <section className="section" key={section} aria-labelledby={`sec-archive-${section}`}>
              <div className="section__head">
                <h2 className="section__title" id={`sec-archive-${section}`}>
                  {sectionLabels[section]}
                </h2>
                <span className={`count count--${section}`}>{t('common.items', { count: String(works.length) })}</span>
                {works.length >= 2 && <SectionBulkButton works={works} t={t} />}
              </div>
              {works.length === 0 ? (
                <p className="empty">{t('board.empty')}</p>
              ) : (
                <div className={`grid grid--${cols}`}>
                  {works.map((w) => (
                    <WorkCard
                      key={w.id}
                      work={w}
                      section={section}
                      decisions={decisionsByWork.get(w.id) ?? []}
                      now={now}
                      locale={locale}
                      t={t}
                      onArchiveChange={refresh}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })
      )}
    </>
  );
}
