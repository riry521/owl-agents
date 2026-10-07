'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSkillRevision, listSkillRevisions, restoreSkill } from '@/lib/api-client';
import type { SkillRevision } from '@/lib/types';
import { diffFileMaps } from '@/lib/skill-diff';
import { formatRelative } from '@/lib/format';
import { useLocale } from '@/lib/i18n';
import { SkillFileDiff } from './SkillFileDiff';

interface RevisionFiles {
  after: Record<string, string>;
  before: Record<string, string>;
}

export function SkillHistoryView() {
  const { locale, t } = useLocale();
  const params = useSearchParams();
  const name = params.get('name') ?? '';

  const [revisions, setRevisions] = useState<SkillRevision[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revisionFiles, setRevisionFiles] = useState<RevisionFiles | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [restorePending, setRestorePending] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoredFrom, setRestoredFrom] = useState<number | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const retry = () => setRetryCount((c) => c + 1);

  useEffect(() => {
    if (!name) return;
    setLoadError(null);
    listSkillRevisions(name)
      .then((list) => {
        const sorted = [...list].sort((a, b) => b.revision - a.revision);
        setRevisions(sorted);
        setSelectedId((current) => (current && sorted.some((r) => r.id === current) ? current : sorted[0]?.id ?? null));
      })
      .catch((e) => {
        setLoadError(t('skills.history.loadError'));
        console.error('[Owl] Skill history load error', e);
      });
  }, [name, t, retryCount]);

  const sortedRevisions = revisions ?? [];
  const selectedIndex = sortedRevisions.findIndex((r) => r.id === selectedId);
  const selected = selectedIndex >= 0 ? sortedRevisions[selectedIndex] : null;
  const previous = selectedIndex >= 0 ? sortedRevisions[selectedIndex + 1] ?? null : null;
  const selectedIsCurrent = selectedIndex === 0;

  useEffect(() => {
    setDiffError(null);
    setRevisionFiles(null);
    if (!name || !selected || !selected.has_snapshot || (previous && !previous.has_snapshot)) {
      setDiffLoading(false);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    Promise.all([
      getSkillRevision(name, selected.id),
      previous ? getSkillRevision(name, previous.id) : Promise.resolve(null),
    ])
      .then(([selectedFull, previousFull]) => {
        if (cancelled) return;
        setRevisionFiles({ after: selectedFull.files ?? {}, before: previousFull?.files ?? {} });
      })
      .catch((e) => {
        if (cancelled) return;
        setDiffError(t('skills.history.loadError'));
        console.error('[Owl] Skill revision diff load error', e);
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [name, selected, previous, t]);

  const fileDiffs = useMemo(
    () => (revisionFiles ? diffFileMaps(revisionFiles.before, revisionFiles.after) : null),
    [revisionFiles],
  );

  // Restoring brings back the older side of the diff shown on screen.
  const restoreTarget = previous && previous.has_snapshot ? previous : null;

  const handleRestore = useCallback(async () => {
    if (!restoreTarget) return;
    if (!confirm(t('skills.history.restoreConfirm', { revision: `r${restoreTarget.revision}` }))) return;
    setRestorePending(true);
    setRestoreError(null);
    setRestoredFrom(null);
    try {
      await restoreSkill(name, restoreTarget.id);
      setRestoredFrom(restoreTarget.revision);
      setSelectedId(null);
      retry();
    } catch (e) {
      setRestoreError(t('skills.history.restoreError'));
      console.error('[Owl] Skill restore error', e);
    } finally {
      setRestorePending(false);
    }
  }, [name, restoreTarget, t]);

  const sourceLine = useMemo(() => {
    if (!selected) return null;
    if (selected.source_work_id) {
      return t('skills.history.sourceWork', { title: selected.source_work_title ?? selected.source_work_id });
    }
    if (selected.source_proposal_id) return t('skills.history.sourceProposal', { id: selected.source_proposal_id });
    return t('skills.history.sourceManual');
  }, [selected, t]);

  if (!name) {
    return <p className="empty">{t('skills.history.loadError')}</p>;
  }

  const currentSuffix = selectedIsCurrent ? t('skills.history.currentSuffix') : '';

  return (
    <>
      <div className="crumbs">
        <Link href="/skills">{t('skills.list.title')}</Link>
        <span>/</span>
        <Link href={`/skills/detail?name=${encodeURIComponent(name)}`} className="mono">{name}</Link>
        <span>/</span>
        <strong>{t('skills.history.breadcrumb')}</strong>
      </div>

      {loadError && (
        <div className="panel">
          <div className="error" role="alert">{loadError}</div>
          <div className="btn-row mt-10">
            <button type="button" className="btn" onClick={retry}>{t('work.retry')}</button>
          </div>
        </div>
      )}
      {revisions === null && !loadError && <p className="empty">{t('common.loading')}</p>}

      {revisions !== null && (
        <div className="history-grid">
          <div className="revision-list">
            {sortedRevisions.map((revision, index) => (
              <button
                key={revision.id}
                type="button"
                className={`revision-row${revision.id === selectedId ? ' revision-row--selected' : ''}`}
                aria-pressed={revision.id === selectedId}
                onClick={() => setSelectedId(revision.id)}
              >
                <div className="revision-row__head">
                  <span className="revision-row__id">
                    r{revision.revision}
                    {index === 0 ? t('skills.history.currentSuffix') : ''}
                  </span>
                  <span className="revision-row__meta">
                    {t('skills.history.actorAction', {
                      actor: t(`skills.actor.${revision.actor}`),
                      action: t(`skills.action.${revision.action}`),
                    })}{' '}
                    · {formatRelative(revision.created_at, now, locale)}
                  </span>
                </div>
                {revision.reason && <div className="revision-row__reason">{revision.reason}</div>}
                {!revision.has_snapshot && <div className="note">{t('skills.history.noSnapshotRow')}</div>}
              </button>
            ))}
          </div>

          <div className="panel">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <h2 className="panel__title" style={{ margin: 0 }}>{t('skills.history.diffTitle')}</h2>
              {selected && (
                <span className="mono" style={{ fontSize: 13 }}>
                  {previous ? `r${previous.revision} → ` : ''}r{selected.revision}
                  {currentSuffix}
                </span>
              )}
              <span className="card__spacer" />
              {selected && (
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={!restoreTarget || restorePending}
                  onClick={() => void handleRestore()}
                >
                  {t('skills.history.restoreButton', { revision: `r${restoreTarget?.revision ?? previous?.revision ?? selected.revision}` })}
                </button>
              )}
            </div>
            {sourceLine && <p className="note">{sourceLine}</p>}

            {selected && !selected.has_snapshot && (
              <div className="info-banner">{t('skills.history.restoreNoSnapshot')}</div>
            )}
            {selected && previous && !previous.has_snapshot && selected.has_snapshot && (
              <div className="info-banner">{t('skills.history.restoreNoSnapshot')}</div>
            )}
            {diffError && <div className="error" role="alert">{diffError}</div>}
            {diffLoading && <p className="empty">{t('common.loading')}</p>}

            {!diffLoading && fileDiffs && fileDiffs.length === 0 && (
              <p className="empty">{t('skills.history.noChanges')}</p>
            )}

            {!diffLoading &&
              fileDiffs?.map((fileDiff) => (
                <div key={fileDiff.path} style={{ marginBottom: 16 }}>
                  <SkillFileDiff diff={fileDiff} t={t} headClassName="diff-summary" />
                </div>
              ))}

            {restoreError && <div className="error" role="alert">{restoreError}</div>}
            {restoredFrom !== null ? (
              <div className="note" role="status">{t('skills.history.restoreDone', { from: `r${restoredFrom}` })}</div>
            ) : (
              restoreTarget && <div className="note">{t('skills.history.restoreHint', { from: `r${restoreTarget.revision}` })}</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
