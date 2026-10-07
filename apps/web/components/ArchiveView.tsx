'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getBoard, listProjects } from '@/lib/api-client';
import { useView } from '@/lib/view-loader';
import type { BoardView as BoardData, WorkSummary } from '@/lib/types';
import { formatDateTime, workDisplayNumber } from '@/lib/format';
import { useLocale, type Locale, type TFunction } from '@/lib/i18n';
import { workDetailHref } from '@/lib/work-detail-safety.mjs';
import { groupArchivedByDay } from '@/lib/archive-list.mjs';
import { confirmDeleteIfUnmerged, removeWorks, revealWork, useWorkRemovals } from '@/lib/work-removal';
import { WorkStateBadge } from '@/components/StateBadge';
import { RestoreIcon, TrashIcon } from '@/components/icons';
import { humanizeError } from '@/components/BoardView';

/** Permanently deletes an archived Work; nothing is removed unless the Owner confirms. */
export function deleteArchivedWork(work: WorkSummary, t: TFunction): Promise<boolean> {
  const name = work.title || t('work.numberLabel', { number: String(work.display_number ?? '') });
  return removeWorks(
    [work],
    'delete',
    async () => window.confirm(t('archive.deleteConfirm', { name })) && await confirmDeleteIfUnmerged([work], t),
  );
}

/** Un-archives a Work and reveals it on the Board. */
export async function restoreArchivedWork(work: WorkSummary): Promise<void> {
  await removeWorks([work], 'unarchive');
  revealWork(work.id);
}

export function ArchiveRow({
  work,
  projectName,
  locale,
  t,
  onRestore,
  onDelete,
}: {
  work: WorkSummary;
  projectName: string | null;
  locale: Locale;
  t: TFunction;
  onRestore: (work: WorkSummary) => void;
  onDelete: (work: WorkSummary) => void;
}) {
  const number = workDisplayNumber(work.display_number);
  return (
    <li className="archive-row">
      <span className="archive-row__number">{number !== null ? t('work.numberLabel', { number: String(number) }) : ''}</span>
      <Link href={workDetailHref(work.id)} className="archive-row__title">
        {work.title || work.id}
      </Link>
      <span className="archive-row__project">{projectName ?? t('archive.noProject')}</span>
      <span className="archive-row__state">
        <WorkStateBadge state={work.state} />
      </span>
      <span className="archive-row__time">{formatDateTime(work.archived_at ?? work.updated_at, locale)}</span>
      <span className="archive-row__actions">
        <button type="button" className="btn" onClick={() => onRestore(work)}>
          <RestoreIcon />
          {t('work.unarchiveShort')}
        </button>
        <button type="button" className="btn btn--danger" onClick={() => onDelete(work)}>
          <TrashIcon />
          {t('work.delete')}
        </button>
      </span>
    </li>
  );
}

export function ArchiveView() {
  const { locale, t } = useLocale();
  const [fallbackProjects, setFallbackProjects] = useState<Map<string, string>>(new Map());
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const { hiddenIds } = useWorkRemovals();
  const { data: viewData, error, refresh } = useView<BoardData>('archive', () => getBoard({ archived: 'only' }));
  const data = viewData ?? null;
  const loadError = error ? humanizeError(error, t) : null;
  const hasProjects = data?.projects !== undefined;
  const projectNames = data?.projects ? new Map(data.projects.map((project) => [project.id, project.name])) : fallbackProjects;

  useEffect(() => {
    if (error) console.error('[Owl] Archive refresh failed', error);
  }, [error]);

  useEffect(() => {
    if (data === null || hasProjects) return;
    let alive = true;
    listProjects()
      .then((projects) => {
        if (alive) setFallbackProjects(new Map(projects.map((project) => [project.id, project.name])));
      })
      .catch((error) => {
        console.error('[Owl] Archive project names load failed', error);
        if (alive) setProjectsError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      alive = false;
    };
  }, [data === null, hasProjects]);

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

  // getBoard({ archived: 'only' }) already filters server-side; rows without archived_at sort by updated_at.
  const works = data.works.filter((w) => !hiddenIds.has(w.id));
  const groups = groupArchivedByDay(works) as { day: string; works: WorkSummary[] }[];
  const dayFormat = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { dateStyle: 'full' });

  const restore = (work: WorkSummary) => {
    void restoreArchivedWork(work).then(refresh);
  };
  const remove = (work: WorkSummary) => {
    void deleteArchivedWork(work, t);
  };

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
      {projectsError && !hasProjects && <div className="error mt-10" role="alert">{t('archive.projectsLoadError')}: {projectsError}</div>}

      {works.length === 0 ? (
        <p className="empty">{t('archive.empty')}</p>
      ) : (
        groups.map((group) => (
          <section className="section" key={group.day} aria-labelledby={`archive-day-${group.day}`}>
            <div className="section__head">
              <h2 className="section__title" id={`archive-day-${group.day}`}>
                {dayFormat.format(new Date(`${group.day}T00:00:00`))}
              </h2>
              <span className="count">{t('common.items', { count: String(group.works.length) })}</span>
            </div>
            <ul className="archive-list">
              {group.works.map((w) => (
                <ArchiveRow
                  key={w.id}
                  work={w}
                  projectName={(w.project_id && projectNames.get(w.project_id)) || null}
                  locale={locale}
                  t={t}
                  onRestore={restore}
                  onDelete={remove}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
}
