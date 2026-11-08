'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ApiRequestError, getWorkMarkdown, type WorkMarkdownDocument } from '@/lib/api-client';
import { useLocale } from '@/lib/i18n';
import { tocEntries } from '@/lib/markdown-toc.mjs';
import { viewerBackTarget, viewerStateForError } from '@/lib/markdown-viewer-state.mjs';
import { MarkdownDocument } from '@/components/MarkdownDocument';
import { MarkdownNotice, type ViewerFailure } from '@/components/MarkdownNotice';
import { MarkdownBackLink, MarkdownToc, type TocItem } from '@/components/MarkdownToc';

const LOAD_TIMEOUT_MS = 45_000;

type Load =
  | { status: 'loading' }
  | { status: 'ready'; doc: WorkMarkdownDocument }
  | { status: 'failed'; failure: ViewerFailure; details: Record<string, unknown> };

const INVALID_URL: Load = { status: 'failed', failure: { state: 'invalid_url', reason: null, network: false }, details: {} };

/** Reads the md of `?id=` (Work) and `?path=` and shows it with a contents list, or why it cannot be shown. */
export function MarkdownViewerView() {
  const { t } = useLocale();
  const params = useSearchParams();
  const id = params.get('id')?.trim() || null;
  const path = params.get('path')?.trim() || null;
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>(id && path ? { status: 'loading' } : INVALID_URL);
  const [entries, setEntries] = useState<TocItem[]>([]);
  const sheetRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!id || !path) {
      setLoad(INVALID_URL);
      return;
    }
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    setLoad({ status: 'loading' });
    Promise.race([
      getWorkMarkdown(id, path),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('request_timeout')), LOAD_TIMEOUT_MS);
      }),
    ])
      .then((doc) => !cancelled && setLoad({ status: 'ready', doc }))
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoad({ status: 'failed', failure: viewerStateForError(error), details: error instanceof ApiRequestError ? error.details : {} });
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [id, path, attempt]);

  useLayoutEffect(() => {
    if (load.status !== 'ready') {
      setEntries([]);
      return;
    }
    const headings = [...(sheetRef.current?.querySelectorAll('.md-body > :is(h1, h2, h3)') ?? [])].map((el) => ({
      id: el.id,
      text: el.textContent ?? '',
      level: Number(el.tagName.slice(1)),
    }));
    setEntries(tocEntries(headings));
  }, [load]);

  const select = useCallback((headingId: string) => {
    if (dialogRef.current?.open) dialogRef.current.close();
    const heading = document.getElementById(headingId);
    heading?.scrollIntoView({ block: 'start' });
    heading?.focus({ preventScroll: true });
  }, []);

  const failedState = load.status === 'failed' ? load.failure.state : 'ready';
  const backHref = viewerBackTarget(id, failedState);
  const backLabel = backHref === '/board' ? t('common.backToBoard') : t('mdViewer.backToWork');
  const back = <MarkdownBackLink href={backHref} label={backLabel} />;
  const hasToc = load.status === 'loading' || entries.length > 0;
  const shownPath = load.status === 'ready' ? load.doc.path : path;

  return (
    <div className={`md-viewer${hasToc ? '' : ' md-viewer--no-toc'}`} aria-busy={load.status === 'loading'}>
      <header className="md-viewer__head">
        {back}
        {shownPath && <p className="md-viewer__path">{shownPath}</p>}
        {load.status === 'ready' && load.doc.source === 'work_branch' && (
          <p className="md-source-note">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v5M12 8h.01" />
            </svg>
            {t('mdViewer.sourceWorkBranch')}
          </p>
        )}
      </header>

      <article className="md-sheet" ref={sheetRef} aria-label={load.status === 'ready' ? load.doc.name : undefined}>
        {load.status === 'loading' && (
          <>
            <p className="sr-only" role="status">
              {t('common.loading')}
            </p>
            <span className="md-skeleton md-skeleton--title" />
            <span className="md-skeleton" />
            <span className="md-skeleton" style={{ width: '96%' }} />
            <span className="md-skeleton" style={{ width: '88%' }} />
            <span className="md-skeleton md-skeleton--heading" />
            <span className="md-skeleton" />
            <span className="md-skeleton" style={{ width: '92%' }} />
            <span className="md-skeleton" style={{ width: '70%' }} />
          </>
        )}
        {load.status === 'failed' && (
          <MarkdownNotice
            failure={load.failure}
            details={load.details}
            workId={id}
            backHref={backHref}
            backLabel={backLabel}
            onReload={() => setAttempt((n) => n + 1)}
          />
        )}
        {load.status === 'ready' && (
          <>
            <MarkdownDocument markdown={load.doc.markdown} />
            <div className="md-sheet__foot">{back}</div>
          </>
        )}
      </article>

      {load.status === 'loading' && (
        <aside className="md-toc" aria-hidden="true">
          {[40, 80, 64, 72, 56].map((width) => (
            <span key={width} className="md-skeleton" style={{ width: `${width}%` }} />
          ))}
        </aside>
      )}
      {load.status === 'ready' && entries.length > 0 && (
        <>
          <aside className="md-toc" aria-label={t('mdViewer.toc')}>
            <p className="md-toc__title">{t('mdViewer.toc')}</p>
            <MarkdownToc items={entries} onSelect={select} />
            <div className="md-toc__foot">{back}</div>
          </aside>
          <button
            type="button"
            className="md-toc-button"
            aria-haspopup="dialog"
            onClick={() => {
              if (!dialogRef.current?.open) dialogRef.current?.showModal();
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
            </svg>
            {t('mdViewer.toc')}
          </button>
          <dialog
            className="md-toc-sheet"
            ref={dialogRef}
            aria-labelledby="md-toc-sheet-title"
            onClick={(event) => {
              if (event.target === dialogRef.current) dialogRef.current?.close();
            }}
          >
            <div className="md-toc-sheet__head">
              <h2 className="md-toc-sheet__title" id="md-toc-sheet-title">
                {t('mdViewer.toc')}
              </h2>
              <button type="button" className="md-toc-sheet__close" aria-label={t('mdViewer.tocClose')} onClick={() => dialogRef.current?.close()}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="md-toc-sheet__body">
              <MarkdownToc items={entries} onSelect={select} />
            </div>
            <div className="md-toc-sheet__foot">{back}</div>
          </dialog>
        </>
      )}
    </div>
  );
}
