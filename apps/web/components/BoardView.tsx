'use client';

import Link from 'next/link';
import { type FormEvent, type MouseEvent, type PointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  createWork,
  getBoard,
  listProjects,
  startWork,
  subscribeToUpdates,
  type CreateWorkInput,
  type RealtimeStatus,
} from '@/lib/api-client';
import type { BoardView as BoardData, Decision, Project, WorkSummary } from '@/lib/types';
import { type BoardSection, boardSectionOf, boardSectionLabels, formatRelative, workDisplayNumber } from '@/lib/format';
import { ArchivedBadge, WorkStateBadge } from '@/components/StateBadge';
import { useLocale, type TFunction, type Locale } from '@/lib/i18n';
import { workDetailHref } from '@/lib/work-detail-safety.mjs';
import { workSummarySkeleton } from '../lib/work-summary.mjs';
import { confirmDeleteIfUnmerged, removeWorks, revealWork, useWorkRemovals, type RemovalKind } from '@/lib/work-removal';
import { ArchiveBoxIcon, RestoreIcon, TrashIcon } from '@/components/icons';

/** Board section order: needs decision → in progress → waiting → done → cancelled. */
export const SECTION_ORDER: BoardSection[] = ['judgement', 'running', 'waiting', 'done', 'cancelled'];

const EMPTY_FORM: CreateWorkInput = { title: '', summary: '', size: 'normal', project_id: null };

/** Matches the CSS breakpoint above which the Board's left column is visible. */

/** Swipe gesture tuning: how far/fast a drag on a Board card must travel before it "arms". */
const DRAG_THRESHOLD_PX = 8;
const ARM_RATIO = 0.35;
const ARM_VELOCITY_PX_MS = 0.5;
const SPRING_BACK_MS = 220;

/** How long a section's bulk-delete button stays armed (red, "Delete N") before reverting. */
const BULK_ARM_MS = 3000;
/** Below this width the home page hides its preview column, so cards fall back to the detail link. */
const INLINE_PREVIEW_QUERY = '(min-width: 901px)';

interface BoardViewProps {
  /** Select a Work to preview in the left column instead of navigating to /work. */
  onSelectCard?: (id: string) => void;
  selectedCardId?: string | null;
  /** The page has a preview panel at every width (the Board page), so always intercept card clicks. */
  alwaysPreview?: boolean;
  /** Refresh after a sibling preview has deleted a Work. */
  refreshToken?: number;
}

export function BoardView({ onSelectCard, selectedCardId, alwaysPreview, refreshToken = 0 }: BoardViewProps = {}) {
  const { locale, t } = useLocale();
  const [data, setData] = useState<BoardData | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [now, setNow] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>('connecting');
  const [form, setForm] = useState<CreateWorkInput>(EMPTY_FORM);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formNotice, setFormNotice] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const refreshSequence = useRef(0);
  const { hiddenIds } = useWorkRemovals();

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const next = await getBoard({ archived: 'exclude' });
      if (sequence !== refreshSequence.current) return;
      setData(next);
      setNow(Date.now());
      setLoadError(null);
    } catch (error) {
      if (sequence !== refreshSequence.current) return;
      console.error('[Owl] Board refresh failed', error);
      setLoadError(humanizeError(error, t));
    }
  }, [t]);

  useEffect(() => {
    let alive = true;
    void refresh();
    const unsubscribe = subscribeToUpdates(
      [],
      () => {
        if (alive) void refresh();
      },
      (status) => {
        if (alive) setRealtimeStatus(status);
      },
    );
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [refresh, refreshToken]);

  useEffect(() => {
    let alive = true;
    void listProjects().then((items) => {
      if (alive) setProjects(items);
    }).catch((error) => {
      console.error('[Owl] Project list for Work form failed', error);
    });
    return () => { alive = false; };
  }, []);

  async function onCreate(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const title = form.title.trim();
    if (!title) {
      setFormError(t('board.titleRequired'));
      return;
    }

    setFormBusy(true);
    setFormError(null);
    setFormNotice(null);
    let created = false;
    try {
      const work = await createWork({ ...form, title });
      created = true;
      await startWork(work.work_id, work.version, form.size === 'small' ? 'small' : 'normal');
      setForm(EMPTY_FORM);
      setFormNotice(t('board.createSuccess'));
      setFormOpen(false);
      await refresh();
    } catch (error) {
      console.error('[Owl] Work creation/start failed', error);
      setFormError(
        created
          ? t('board.createPartialError')
          : humanizeError(error, t),
      );
    } finally {
      setFormBusy(false);
    }
  }

  const realtimeMessage =
    realtimeStatus === 'polling'
      ? t('realtime.polling')
      : realtimeStatus === 'connected'
        ? t('realtime.connected')
        : t('realtime.connecting');

  if (!data) {
    return (
      <>
        <p className="sync-status" role="status">
          {realtimeMessage}
        </p>
        {loadError ? <div className="error">{loadError}</div> : <p className="empty">{t('common.loading')}</p>}
      </>
    );
  }

  const sectionLabels = boardSectionLabels(locale);
  const grouped: Record<BoardSection, WorkSummary[]> = { judgement: [], running: [], waiting: [], done: [], cancelled: [] };
  for (const w of data.works) {
    if (hiddenIds.has(w.id)) continue;
    // The Board always excludes archived Works server-side; this is a defensive
    // second check in case a stale response ever slips one through.
    if (w.archived_at) continue;
    grouped[boardSectionOf(w.state)].push(w);
  }
  const decisionsByWork = new Map<string, Decision[]>();
  for (const d of data.open_decisions) {
    decisionsByWork.set(d.work_id, [...(decisionsByWork.get(d.work_id) ?? []), d]);
  }

  return (
    <>
      <div className="page__head">
        <div>
          <h1 className="page__title">{t('board.title')}</h1>
          <p className="page__sub">{t('board.subtitle')}</p>
        </div>
        <button
          type="button"
          className={`btn ${formOpen ? '' : 'btn--primary'}`}
          aria-expanded={formOpen}
          aria-controls="create-work-panel"
          onClick={() => {
            setFormOpen((open) => !open);
            setFormNotice(null);
            setFormError(null);
          }}
        >
          {formOpen ? t('common.close') : `+ ${t('board.newWork')}`}
        </button>
      </div>
      <div className="board-toolbar">
        <p className="board-toolbar__status" role="status">
          <span
            className={`board-toolbar__dot${realtimeStatus === 'connected' ? ' board-toolbar__dot--live' : ''}`}
            aria-hidden="true"
          />
          {realtimeMessage}
        </p>
        <Link href="/archive" className="chip-toggle">
          <ArchiveBoxIcon />
          {t('archive.link')}
        </Link>
      </div>
      {formNotice && !formOpen && <p className="note note--success" role="status">{formNotice}</p>}
      {loadError && <div className="error mt-10">{loadError}</div>}

      {formOpen && (
        <section className="panel" id="create-work-panel" aria-labelledby="sec-create-work">
          <h2 className="panel__title" id="sec-create-work">
            {t('board.createWork')}
          </h2>
          <form onSubmit={onCreate}>
            <div className="form-grid">
              <label className="form-field">
                <span>{t('board.titleLabel')}</span>
                <input
                  className="input"
                  value={form.title}
                  onChange={(ev) => setForm((current) => ({ ...current, title: ev.target.value }))}
                  placeholder={t('board.titlePlaceholder')}
                  maxLength={500}
                  required
                  disabled={formBusy}
                />
              </label>
              <label className="form-field">
                <span>{t('board.summaryLabel')}</span>
                <textarea
                  className="textarea"
                  value={form.summary}
                  onChange={(ev) => setForm((current) => ({ ...current, summary: ev.target.value }))}
                  placeholder={workSummarySkeleton(locale)}
                  rows={9}
                  maxLength={20000}
                  disabled={formBusy}
                />
              </label>
              <label className="form-field form-field--short">
                <span>{t('board.executionModeLabel')}</span>
                <select
                  className="select"
                  value={form.size}
                  onChange={(ev) => setForm((current) => ({ ...current, size: ev.target.value as CreateWorkInput['size'] }))}
                  disabled={formBusy}
                >
                  <option value="normal">{t('board.managerPlan')}</option>
                  <option value="small">{t('board.directWorker')}</option>
                </select>
                <span className="note">{t('board.executionModeHelp')}</span>
              </label>
              <label className="form-field form-field--short">
                <span>{t('board.projectLabel')}</span>
                <select
                  className="select"
                  value={form.project_id ?? ''}
                  onChange={(ev) => setForm((current) => ({ ...current, project_id: ev.target.value || null }))}
                  disabled={formBusy}
                >
                  <option value="">{t('board.noProject')}</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>{project.name}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="btn-row mt-10">
              <button type="submit" className="btn btn--primary" disabled={formBusy}>
                {formBusy ? t('common.creating') : t('board.createAndStart')}
              </button>
              <button type="button" className="btn" onClick={() => setFormOpen(false)} disabled={formBusy}>
                {t('common.cancel')}
              </button>
            </div>
            {formError && <div className="error mt-10">{formError}</div>}
          </form>
        </section>
      )}

      {SECTION_ORDER.map((section) => {
        const works = grouped[section];
        // Only the needs-decision section is 2 columns (larger cards); the rest are 3.
        const cols = section === 'judgement' ? 2 : 3;
        return (
          <section className="section" key={section} aria-labelledby={`sec-${section}`}>
            <div className="section__head">
              <h2 className="section__title" id={`sec-${section}`}>
                {sectionLabels[section]}
              </h2>
              <span className={`count count--${section}`}>{t('common.items', { count: String(works.length) })}</span>
              {(section === 'done' || section === 'cancelled') && works.length >= 2 && (
                <SectionBulkButton works={works} t={t} />
              )}
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
                    onSelect={onSelectCard}
                    alwaysPreview={alwaysPreview}
                    isSelected={selectedCardId === w.id}
                    onArchiveChange={refresh}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}

/**
 * Section-wide "delete all" with no undo, so it needs an explicit second tap: the first tap
 * arms a red, count-labelled confirm state for a few seconds; a second tap while armed deletes
 * everything in the section, and letting the timer lapse reverts to the normal label.
 */
export function SectionBulkButton({ works, t }: { works: WorkSummary[]; t: TFunction }) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  const handleClick = () => {
    if (!armed) {
      setArmed(true);
      timerRef.current = setTimeout(() => setArmed(false), BULK_ARM_MS);
      return;
    }
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setArmed(false);
    void removeWorks(works, 'delete', () => confirmDeleteIfUnmerged(works, t));
  };

  return (
    <button
      type="button"
      className={`section__bulk ${armed ? 'section__bulk--armed' : ''}`}
      onClick={handleClick}
    >
      {armed ? t('work.deleteAllConfirm', { count: String(works.length) }) : t('work.deleteAllInSection')}
    </button>
  );
}

/**
 * Terminal-state (done/cancelled) cards can be archived/deleted with a touch swipe or, on
 * pointer devices, hover-revealed icon buttons; other sections render the plain card shell.
 */
export function WorkCard({
  work,
  section,
  decisions,
  now,
  locale,
  t,
  onSelect,
  alwaysPreview,
  isSelected,
  onArchiveChange,
}: {
  work: WorkSummary;
  section: BoardSection;
  decisions: Decision[];
  now: number;
  locale: Locale;
  t: TFunction;
  onSelect?: (id: string) => void;
  alwaysPreview?: boolean;
  isSelected?: boolean;
  /** Refresh the Board after an archive/unarchive commits, so stale `archived_at` reflects it. */
  onArchiveChange?: () => Promise<void>;
}) {
  const first = decisions[0];
  const title = typeof work.title === 'string' && work.title.trim().length > 0 ? work.title : work.id;
  const displayNumber = workDisplayNumber(work.display_number);
  const iconText = section === 'judgement'
    ? '!'
    : section === 'running'
      ? '▶'
      : section === 'done'
        ? '✓'
        : section === 'cancelled'
          ? '×'
          : '…';
  const classes = ['card'];
  if (section === 'judgement') classes.push('card--judgement');
  if (section === 'waiting' || section === 'done' || section === 'cancelled') classes.push('card--muted');
  if (isSelected) classes.push('card--selected');
  if (section === 'done' || section === 'cancelled') classes.push('card--actionable');
  const isActionable = section === 'done' || section === 'cancelled';

  const cardRef = useRef<HTMLDivElement | null>(null);
  const draggedRef = useRef(false);
  const gestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastT: number;
    velocity: number;
    locked: boolean;
    dx: number;
  } | null>(null);
  const [phase, setPhase] = useState<'idle' | 'dragging' | 'released'>('idle');
  const [dragDir, setDragDir] = useState<'left' | 'right' | null>(null);
  const [armedSide, setArmedSide] = useState<'archive' | 'delete' | null>(null);

  const archiveKind: RemovalKind = work.archived_at ? 'unarchive' : 'archive';
  const archiveLabel = work.archived_at ? t('work.unarchiveShort') : t('work.archive');
  const deleteLabel = t('work.delete');

  const reducedMotion = () =>
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const runRemoval = (kind: RemovalKind) => {
    void removeWorks(
      [work],
      kind,
      kind === 'delete' ? () => confirmDeleteIfUnmerged([work], t) : undefined,
    ).then(async () => {
      // A failed removal brings the card back; it must not stay parked off-screen.
      if (cardRef.current) cardRef.current.style.transform = '';
      setDragDir(null);
      if (kind === 'delete') return;
      // Archived cards stay hidden until the refreshed Board data decides whether they show.
      await onArchiveChange?.();
      revealWork(work.id);
    });
  };

  const endDrag = (armed: 'archive' | 'delete' | null) => {
    if (armed) {
      runRemoval(armed === 'delete' ? 'delete' : archiveKind);
    } else {
      setPhase('released');
      if (cardRef.current) cardRef.current.style.transform = 'translateX(0)';
      window.setTimeout(() => {
        setPhase('idle');
        setDragDir(null);
      }, reducedMotion() ? 0 : SPRING_BACK_MS);
    }
    setArmedSide(null);
  };

  // Only touch/pen starts a swipe; mouse drags fall through to native text/click behaviour.
  const onPointerDown = (ev: PointerEvent<HTMLDivElement>) => {
    // Browsers do not always fire a click after a drag, so reset the suppression per gesture.
    draggedRef.current = false;
    if (!isActionable || (ev.pointerType !== 'touch' && ev.pointerType !== 'pen')) return;
    gestureRef.current = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      lastX: ev.clientX,
      lastT: ev.timeStamp,
      velocity: 0,
      locked: false,
      dx: 0,
    };
  };

  const onPointerMove = (ev: PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || ev.pointerId !== g.pointerId) return;
    const dx = ev.clientX - g.startX;
    const dy = ev.clientY - g.startY;
    if (!g.locked) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_THRESHOLD_PX) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        // A mostly-vertical drag is a scroll, not a swipe: abandon the gesture.
        gestureRef.current = null;
        return;
      }
      g.locked = true;
      draggedRef.current = true;
      ev.currentTarget.setPointerCapture(ev.pointerId);
      setPhase('dragging');
    }
    ev.preventDefault();
    const dt = Math.max(1, ev.timeStamp - g.lastT);
    g.velocity = (ev.clientX - g.lastX) / dt;
    g.lastX = ev.clientX;
    g.lastT = ev.timeStamp;
    g.dx = dx;
    if (cardRef.current) cardRef.current.style.transform = `translateX(${dx}px)`;
    if (dx !== 0) setDragDir(dx < 0 ? 'left' : 'right');
    const width = cardRef.current?.offsetWidth || 1;
    const side: 'archive' | 'delete' | null = dx < 0 ? 'delete' : dx > 0 ? 'archive' : null;
    const armed = Math.abs(dx) >= width * ARM_RATIO || Math.abs(g.velocity) >= ARM_VELOCITY_PX_MS;
    const nextArmed = armed ? side : null;
    setArmedSide((current) => {
      if (current === nextArmed) return current;
      if (nextArmed) navigator.vibrate?.(8);
      return nextArmed;
    });
  };

  const onPointerUp = (ev: PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || ev.pointerId !== g.pointerId) return;
    const { locked } = g;
    gestureRef.current = null;
    if (!locked) return;
    endDrag(armedSide);
  };

  const onPointerCancel = (ev: PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || ev.pointerId !== g.pointerId) return;
    const { locked } = g;
    gestureRef.current = null;
    if (!locked) return;
    endDrag(null);
  };

  // Plain clicks preview the Work in the right panel; modified clicks and clicks that end a real drag keep/skip the /work link behaviour.
  const handleLinkClick = (ev: MouseEvent<HTMLAnchorElement>) => {
    if (draggedRef.current) {
      draggedRef.current = false;
      ev.preventDefault();
      return;
    }
    if (!onSelect) return;
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    if (!alwaysPreview && (typeof window === 'undefined' || !window.matchMedia(INLINE_PREVIEW_QUERY).matches)) return;
    ev.preventDefault();
    onSelect(work.id);
  };

  const card = (
    <div className={classes.join(' ')}>
      <Link
        href={workDetailHref(work.id)}
        className="card__link"
        onClick={handleLinkClick}
        aria-current={isSelected ? 'true' : undefined}
      >
        <div className="card__row card__row--top">
          <span className={`icon icon--${section}`} aria-hidden="true">
            {iconText}
          </span>
          {displayNumber !== null && <span className="badge badge--gray">{t('work.numberLabel', { number: String(displayNumber) })}</span>}
          <span className="card__time">{formatRelative(work.updated_at, now, locale)}</span>
          <span className="card__state-group">
            <WorkStateBadge state={work.state} />
          </span>
        </div>
        <div className="card__title card__title--full">{title}</div>
        {work.archived_at && (
          <div className="mt-8">
            <ArchivedBadge />
          </div>
        )}

        {section === 'judgement' && first && (
          <>
            <div className="card__body">{first.question || first.reason}</div>
            <div className="btn-row">
              {first.options.slice(0, 3).map((o) => (
                <span key={o.key} className={`badge ${o.key === first.recommended ? 'badge--accent' : 'badge--gray'}`}>
                  {o.key === first.recommended ? '★ ' : ''}
                  {o.label}
                </span>
              ))}
              {decisions.length > 1 && <span className="note">{t('board.otherDecisions', { count: String(decisions.length - 1) })}</span>}
            </div>
          </>
        )}
      </Link>
      {isActionable && (
        <div className="card__actions">
          <button
            type="button"
            className="card__action-btn"
            aria-label={archiveLabel}
            title={archiveLabel}
            onClick={() => runRemoval(archiveKind)}
          >
            {work.archived_at ? <RestoreIcon /> : <ArchiveBoxIcon />}
          </button>
          <button
            type="button"
            className="card__action-btn card__action-btn--danger"
            aria-label={deleteLabel}
            title={deleteLabel}
            onClick={() => runRemoval('delete')}
          >
            <TrashIcon />
          </button>
        </div>
      )}
    </div>
  );

  if (!isActionable) return card;

  const cardClasses = ['swipe__card'];
  if (phase === 'dragging') cardClasses.push('swipe__card--dragging');
  if (phase === 'released') cardClasses.push('swipe__card--released');

  return (
    <div className={dragDir ? `swipe swipe--${dragDir}` : 'swipe'}>
      <div
        className={`swipe__action swipe__action--archive ${armedSide === 'archive' ? 'swipe__action--armed' : ''}`}
        aria-hidden="true"
      >
        {work.archived_at ? <RestoreIcon /> : <ArchiveBoxIcon />}
        {archiveLabel}
      </div>
      <div
        className={`swipe__action swipe__action--delete ${armedSide === 'delete' ? 'swipe__action--armed' : ''}`}
        aria-hidden="true"
      >
        {deleteLabel}
        <TrashIcon />
      </div>
      <div
        ref={cardRef}
        className={cardClasses.join(' ')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {card}
      </div>
    </div>
  );
}

export function humanizeError(error: unknown, t: TFunction): string {
  const code = error instanceof Error ? error.message : '';
  switch (code) {
    case 'validation_error':
      return t('board.errorValidation');
    case 'project_not_found':
      return t('board.errorProjectNotFound');
    case 'version_conflict':
      return t('board.errorVersionConflict');
    case 'idempotency_conflict':
      return t('board.errorIdempotencyConflict');
    case 'network_error':
    case 'runtime_config_unavailable':
      return t('board.errorNetwork');
    case 'invalid_runtime_config':
    case 'invalid_response':
      return t('board.errorInvalidResponse');
    default:
      return t('board.errorDefault');
  }
}
