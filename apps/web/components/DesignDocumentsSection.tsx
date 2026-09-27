'use client';

import { useEffect, useState } from 'react';
import { getWorkDesign, getWorkDesigns, type WorkDesignSummary } from '@/lib/api-client';
import { formatRelative } from '@/lib/format';
import { formatByteCount } from '@/lib/skill-diff';
import type { Locale, TFunction } from '@/lib/i18n';

interface DesignDocumentsSectionProps {
  workId: string;
  refreshToken: number;
  now: number;
  locale: Locale;
  t: TFunction;
}

interface OpenDesignDocument {
  title: string;
  markdown: string;
}

/**
 * Design documents the Work's Designer agent has written. Listed from
 * getWorkDesigns and, once a row is clicked, fetched in full from
 * getWorkDesign. Hidden entirely when there is nothing to show.
 */
export function DesignDocumentsSection({ workId, refreshToken, now, locale, t }: DesignDocumentsSectionProps) {
  const [designs, setDesigns] = useState<WorkDesignSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OpenDesignDocument | null>(null);
  const [detailPending, setDetailPending] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getWorkDesigns(workId)
      .then((result) => {
        if (!alive) return;
        setDesigns(result.designs);
        setLoadError(null);
      })
      .catch((error) => {
        console.error('[Owl] Design documents list failed', error);
        if (alive) setLoadError(t('work.errorDesignDocumentsLoad'));
      });
    return () => {
      alive = false;
    };
  }, [workId, refreshToken, t]);

  const openDesign = (taskId: string) => {
    setSelectedTaskId(taskId);
    setDetail(null);
    setDetailError(null);
    setDetailPending(true);
    getWorkDesign(workId, taskId)
      .then((result) => setDetail({ title: result.title, markdown: result.markdown }))
      .catch((error) => {
        console.error('[Owl] Design document load failed', error);
        setDetailError(t('work.errorDesignDocumentLoad'));
      })
      .finally(() => setDetailPending(false));
  };

  // Nothing to show and nothing went wrong: the section stays hidden.
  if (!loadError && (designs === null || designs.length === 0)) return null;

  return (
    <section className="panel" aria-labelledby="sec-designs">
      <h2 className="panel__title" id="sec-designs">
        {t('work.designDocuments')} <span className="count">{designs?.length ?? 0}</span>
      </h2>
      {loadError && <div className="error" role="alert">{loadError}</div>}
      {designs && designs.length > 0 && (
        <div className="list">
          {designs.map((doc) => (
            <button
              type="button"
              key={doc.task_id}
              className="row"
              style={{ width: '100%', border: 'none', textAlign: 'left', font: 'inherit', cursor: 'pointer' }}
              onClick={() => openDesign(doc.task_id)}
            >
              <div className="row__main">
                <div className="row__title">{doc.title}</div>
                <div className="row__sub">
                  {formatRelative(doc.updated_at, now, locale)} · {formatByteCount(doc.size_bytes)}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {selectedTaskId && (
        <div className="mt-10">
          {detailPending && <p className="empty">{t('common.loading')}</p>}
          {detailError && <div className="error" role="alert">{detailError}</div>}
          {detail && (
            <>
              <h3 className="panel__title">{detail.title}</h3>
              <div className="kb-body">{detail.markdown}</div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
