'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ApiRequestError, releaseWorkPrerequisiteWait, replaceWorkPrerequisites } from '@/lib/api-client';
import { WorkStateBadge } from '@/components/StateBadge';
import { useLocale, type TFunction } from '@/lib/i18n';
import { workDetailHref } from '@/lib/work-detail-safety.mjs';
import type { WorkPrerequisite } from '@/lib/types';

interface PrerequisiteWork {
  id: string;
  state: string;
  state_version: number;
  prerequisite_wait: boolean;
}

/** "Project name Work #N"; a Work without a number falls back to its ID. */
export function prerequisiteName(p: WorkPrerequisite, t: TFunction): string {
  if (p.display_number === null || p.display_number === undefined) return p.work_id;
  return t('work.prerequisites.item', {
    project: p.project_name ?? t('work.prerequisites.noProject'),
    number: String(p.display_number),
  });
}

/** Prerequisite Works of a Work: list, release of the wait, and editing while memo or ready. */
export function WorkPrerequisitesSection({
  work,
  prerequisites,
  onChanged,
}: {
  work: PrerequisiteWork;
  prerequisites: WorkPrerequisite[];
  onChanged: () => void;
}) {
  const { t } = useLocale();
  const editable = work.state === 'memo' || work.state === 'ready';
  const [ids, setIds] = useState<string[]>(prerequisites.map((p) => p.work_id));
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (prerequisites.length === 0 && !editable) return null;

  async function run(operation: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await operation();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError && err.rawMessage ? err.rawMessage : fallback);
    } finally {
      setBusy(false);
    }
  }

  function addDraft() {
    const id = draft.trim();
    if (id && !ids.includes(id)) setIds([...ids, id]);
    setDraft('');
  }

  const nameOf = (id: string) => {
    const known = prerequisites.find((p) => p.work_id === id);
    return known ? prerequisiteName(known, t) : id;
  };

  return (
    <section className="section" aria-label={t('work.prerequisites.title')}>
      <h3 className="section__title">{t('work.prerequisites.title')}</h3>
      {prerequisites.length > 0 && (
        <ul className="list">
          {prerequisites.map((p) => (
            <li key={p.work_id}>
              {p.deleted ? <span>{prerequisiteName(p, t)}</span> : <Link href={workDetailHref(p.work_id)}>{prerequisiteName(p, t)}</Link>}
              {' '}
              <span>{p.title}</span>
              {' '}
              {p.deleted ? <span className="badge badge--gray">{t('work.prerequisites.deleted')}</span> : p.state && <WorkStateBadge state={p.state} />}
              {' '}
              <span className="note">{t(p.satisfied ? 'work.prerequisites.satisfied' : 'work.prerequisites.pending')}</span>
            </li>
          ))}
        </ul>
      )}
      {work.prerequisite_wait && (
        <div className="btn-row">
          <p className="note">{t('work.prerequisites.autoStart')}</p>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => void run(() => releaseWorkPrerequisiteWait(work.id, work.state_version), t('work.prerequisites.releaseFailed'))}
          >
            {t('work.prerequisites.release')}
          </button>
        </div>
      )}
      {editable && (
        <div>
          <ul className="list">
            {ids.map((id) => (
              <li key={id}>
                <span>{nameOf(id)}</span>
                {' '}
                <button type="button" className="btn" disabled={busy} onClick={() => setIds(ids.filter((x) => x !== id))}>
                  {t('work.prerequisites.remove')}
                </button>
              </li>
            ))}
          </ul>
          <div className="btn-row">
            <input
              className="input"
              value={draft}
              onChange={(ev) => setDraft(ev.target.value)}
              placeholder={t('work.prerequisites.idPlaceholder')}
              disabled={busy}
            />
            <button type="button" className="btn" disabled={busy} onClick={addDraft}>{t('work.prerequisites.add')}</button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void run(() => replaceWorkPrerequisites(work.id, work.state_version, ids), t('work.prerequisites.saveFailed'))}
            >
              {t('work.prerequisites.save')}
            </button>
          </div>
        </div>
      )}
      {error && <div className="error mt-10">{error}</div>}
    </section>
  );
}
