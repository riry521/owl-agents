'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { getAutoWorkEvent, listAutoWorkEvents } from '@/lib/api-client';
import {
  AUTO_WORK_EVENTS_PAGE_SIZE, AUTO_WORK_EVENTS_REFRESH_MS, AUTO_WORK_SOURCES, AUTO_WORK_VERDICTS, createdState, eventLinks,
  eventsViewKey, hasActionError, isMutedEvent, knownValue, mergeEvents, sourceLabelKey, verdictLabelKey, verdictTone,
} from '@/lib/auto-work.mjs';
import { useLocale, type TFunction } from '@/lib/i18n';
import { humanizeSettingsError } from '@/lib/api-error-keys.mjs';
import type { AutoWorkEventDetail, AutoWorkEventView, AutoWorkProjectSettings } from '@/lib/types';
import { useView } from '@/lib/view-loader';

const AUTO_WORK_PATH = '/settings/auto-work';
const WORK_STATE_TONES: Record<string, string> = { running: ' badge--accent', completed: ' badge--green', cancelled: ' badge--red' };
const WORK_STATES = new Set(['memo', 'ready', 'running', 'paused', 'judgement_waiting', 'completed', 'cancelled']);

function WorkStateBadge({ state, t }: { state: string; t: TFunction }) {
  const tone = Object.hasOwn(WORK_STATE_TONES, state) ? WORK_STATE_TONES[state] : '';
  return <span className={`badge${tone}`} title={`work_state: ${state}`}>{WORK_STATES.has(state) ? t(`format.workState.${state}`) : state}</span>;
}

function EventRow({ event, initiallyOpen, t }: { event: AutoWorkEventView; initiallyOpen: boolean; t: TFunction }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [detail, setDetail] = useState<AutoWorkEventDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const links = eventLinks(event);
  const unauthorized = event.verdict === 'unauthorized';
  const sourceKey = sourceLabelKey(event.source);

  async function load() {
    setLoading(true);
    setFailed(false);
    try {
      setDetail(await getAutoWorkEvent(event.id));
    } catch (err) {
      console.error('[Owl] Auto Work event detail failed', err);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (initiallyOpen) setOpen(true);
  }, [initiallyOpen]);

  useEffect(() => {
    if (open && detail === null && !unauthorized) void load();
    // Opening is the only trigger; `load` closes over this row's id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const reason = event.verdict === 'judging' ? t('autoWork.history.judging') : event.verdict_reason;
  return (
    <article className={`aw-event${isMutedEvent(event) ? ' aw-event--muted' : ''}`} id={`aw-event-${event.id}`}>
      <div className="aw-event__verdict">
        <span className={`badge${verdictTone(event) === 'muted' ? '' : ` badge--${verdictTone(event)}`}`}>{t(verdictLabelKey(event))}</span>
        {hasActionError(event) && <span className="badge badge--red">{t('autoWork.actionError.badge')}</span>}
        <span className="aw-event__time" title={event.occurred_at}>{new Date(event.occurred_at || event.created_at).toLocaleString()}</span>
      </div>
      <div>
        <div className="aw-event__title">
          {unauthorized ? <span className="note">{t('autoWork.history.unauthorizedTitle')}</span> : event.title}
        </div>
        <div className="aw-event__meta">
          <span className="badge">{event.project_name ?? event.project_id}</span>
          <span className="badge badge--accent">{sourceKey === null ? event.source : t(sourceKey)}</span>
          <span className="mono">{event.kind}</span>
          {event.rule_id !== null && <span>{t('autoWork.history.rule')} <span className="mono">{event.rule_id}</span></span>}
          {event.github_author !== null && <span>{t('autoWork.history.author')} <span className="mono">{event.github_author}</span></span>}
        </div>
        {reason !== '' && <p className="aw-event__reason">{t('autoWork.history.reason')} {reason}</p>}
        {hasActionError(event) && <p className="aw-event__err">{t('autoWork.actionError.text', { error: event.action_error ?? '' })}</p>}
        <div className="aw-event__links">
          {links.work !== null && (
            <>
              <Link href={links.work.href}>{t('autoWork.history.work', { number: String(links.work.number ?? '—'), title: links.work.title })}</Link>
              {links.work.state !== null && <WorkStateBadge state={links.work.state} t={t} />}
            </>
          )}
          {createdState(event) === 'deleted' && <span className="badge">{t('autoWork.history.workDeleted')}</span>}
          {links.duplicateWork !== null && (
            <Link href={links.duplicateWork.href}>{t('autoWork.history.duplicateWork', { number: String(links.duplicateWork.number ?? '—') })}</Link>
          )}
          {links.duplicateEvent !== null && (
            <Link href={`${AUTO_WORK_PATH}?tab=history&event=${encodeURIComponent(links.duplicateEvent.id)}`}>
              {t('autoWork.history.duplicateEvent', { id: links.duplicateEvent.short })}
            </Link>
          )}
          {links.issue !== null && (
            <a href={links.issue.href} target="_blank" rel="noreferrer">{t('autoWork.history.issue', { number: String(links.issue.number ?? '—') })}</a>
          )}
          {links.pr !== null && (
            <a href={links.pr.href} target="_blank" rel="noreferrer">{t('autoWork.history.pr', { number: String(links.pr.number ?? '—') })}</a>
          )}
          {links.comment !== null && <a href={links.comment.href} target="_blank" rel="noreferrer">{t('autoWork.history.comment')}</a>}
        </div>
      </div>
      <div className="aw-event__end">
        <button
          type="button"
          className="btn btn--small"
          aria-expanded={open}
          disabled={unauthorized}
          title={unauthorized ? t('autoWork.history.noBody') : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          {t(open ? 'autoWork.history.close' : 'autoWork.history.detail')}
        </button>
      </div>
      {open && !unauthorized && (
        <div className="aw-detail">
          {loading && <p className="empty">{t('autoWork.state.loading')}</p>}
          {failed && (
            <div className="error" role="alert">
              {t('autoWork.history.detailFailed')} <button type="button" className="text-btn" onClick={() => void load()}>{t('autoWork.state.retry')}</button>
            </div>
          )}
          {detail !== null && (
            <>
              <div><p className="aw-detail__title">{t('autoWork.history.body')}</p>{detail.detail === '' ? <p className="note">{t('autoWork.history.noBody')}</p> : <pre>{detail.detail}</pre>}</div>
              <div>
                <p className="aw-detail__title">{t('autoWork.history.judge')}</p>
                {detail.judge_json === null ? <p className="note">{t('autoWork.history.noJudge')}</p> : <pre>{JSON.stringify(detail.judge_json, null, 2)}</pre>}
              </div>
              <dl className="kv">
                <dt>dedupe_key</dt><dd className="mono">{detail.dedupe_key}</dd>
                <dt>day_key</dt><dd className="mono">{detail.day_key}</dd>
                <dt>action</dt><dd>{detail.action === null ? '—' : t(`autoWork.action.${detail.action}`) + ` (action: ${detail.action})`}</dd>
                {detail.github_repo !== null && <><dt>GitHub</dt><dd className="mono">{detail.github_repo}#{detail.github_issue_number}</dd></>}
                {detail.github_updated_at !== null && <><dt>github_updated_at</dt><dd className="mono">{detail.github_updated_at}</dd></>}
              </dl>
            </>
          )}
        </div>
      )}
    </article>
  );
}

export function AutoWorkHistoryTab({ projects }: { projects: AutoWorkProjectSettings[] }) {
  const { t } = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const projectId = params.get('project_id') || '';
  const source = knownValue(params.get('source'), AUTO_WORK_SOURCES) ?? '';
  const verdict = knownValue(params.get('verdict'), AUTO_WORK_VERDICTS) ?? '';
  const openEventId = params.get('event');
  const filtered = projectId !== '' || source !== '' || verdict !== '';
  const filterKey = eventsViewKey({ projectId, source, verdict, offset: 0 });

  const first = useView(
    filterKey,
    () => listAutoWorkEvents({ projectId, source, verdict, limit: AUTO_WORK_EVENTS_PAGE_SIZE }),
    { refreshMs: AUTO_WORK_EVENTS_REFRESH_MS },
  );
  // Pages after the first are kept here; the first page is re-read on a timer, so new rows land in front of them.
  const [moreState, setMore] = useState<{ key: string; items: AutoWorkEventView[]; nextOffset: number | null } | null>(null);
  const filterKeyRef = useRef(filterKey);
  filterKeyRef.current = filterKey;
  // A page fetched under an earlier filter must not be shown under the current one.
  const more = moreState !== null && moreState.key === filterKey ? moreState : null;
  const [linked, setLinked] = useState<AutoWorkEventView | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    setMore(null);
    setMoreError(null);
    setLoadingMore(false);
  }, [filterKey]);
  const listed = openEventId !== null && Boolean(first.data?.items.some((e) => e.id === openEventId) || more?.items.some((e) => e.id === openEventId));
  const firstReady = first.data !== undefined;
  useEffect(() => {
    if (openEventId === null || !firstReady || listed) {
      setLinked(null);
      return;
    }
    let cancelled = false;
    getAutoWorkEvent(openEventId).then((event) => { if (!cancelled) setLinked(event); }).catch((err) => console.error('[Owl] Auto Work linked event failed', err));
    return () => { cancelled = true; };
  }, [openEventId, firstReady, listed]);
  useEffect(() => {
    if (first.data !== undefined) setUpdatedAt(new Date());
  }, [first.data]);

  const listedItems = first.data === undefined ? [] : mergeEvents(first.data.items, more?.items ?? []);
  const items = linked !== null && linked.id === openEventId && !listed ? [linked, ...listedItems] : listedItems;
  const nextOffset = more === null ? (first.data?.next_offset ?? null) : more.nextOffset;

  function setFilter(next: { project_id?: string; source?: string; verdict?: string }) {
    const query = new URLSearchParams({ tab: 'history' });
    const merged = { project_id: projectId, source, verdict, ...next };
    for (const [key, value] of Object.entries(merged)) if (value) query.set(key, value);
    router.replace(`${AUTO_WORK_PATH}?${query.toString()}`);
  }

  async function loadMore() {
    if (nextOffset === null) return;
    const key = filterKey;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listAutoWorkEvents({ projectId, source, verdict, offset: nextOffset, limit: AUTO_WORK_EVENTS_PAGE_SIZE });
      if (filterKeyRef.current !== key) return;
      setMore((current) => ({ key, items: mergeEvents(current?.key === key ? current.items : [], page.items), nextOffset: page.next_offset }));
    } catch (err) {
      console.error('[Owl] Auto Work history page failed', err);
      if (filterKeyRef.current === key) setMoreError(humanizeSettingsError(err, t));
    } finally {
      if (filterKeyRef.current === key) setLoadingMore(false);
    }
  }

  const projectChoices = projects.some((project) => project.project_id === projectId) || projectId === ''
    ? projects.map((project) => ({ id: project.project_id, name: project.project_name ?? project.project_id }))
    : [...projects.map((project) => ({ id: project.project_id, name: project.project_name ?? project.project_id })), { id: projectId, name: projectId }];

  return (
    <>
      <section className="panel panel--tight" aria-label={t('autoWork.history.filters')}>
        <div className="form-grid--filters">
          <label className="form-field form-field--short"><span>Project</span>
            <select className="select" value={projectId} onChange={(event) => setFilter({ project_id: event.target.value })}>
              <option value="">{t('autoWork.history.allProjects')}</option>
              {projectChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
            </select>
          </label>
          <label className="form-field form-field--short"><span>{t('autoWork.history.source')}</span>
            <select className="select" value={source} onChange={(event) => setFilter({ source: event.target.value })}>
              <option value="">{t('autoWork.history.all')}</option>
              {AUTO_WORK_SOURCES.map((value: string) => <option key={value} value={value}>{t(sourceLabelKey(value) ?? '')}</option>)}
            </select>
          </label>
          <label className="form-field form-field--short"><span>{t('autoWork.history.verdict')}</span>
            <select className="select" value={verdict} onChange={(event) => setFilter({ verdict: event.target.value })}>
              <option value="">{t('autoWork.history.all')}</option>
              {AUTO_WORK_VERDICTS.map((value: string) => (
                <option key={value} value={value}>{value === 'created' ? t('autoWork.history.verdictCreated') : t(`autoWork.verdict.${value}`)}</option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn--small" disabled={!filtered} onClick={() => router.replace(`${AUTO_WORK_PATH}?tab=history`)}>
            {t('autoWork.history.clearFilters')}
          </button>
        </div>
      </section>

      <div className="aw-toolbar">
        <div className="section__head" style={{ margin: 0 }}>
          <h2 className="section__title">{t('autoWork.history.heading')}</h2>
          <span className="count">{t('autoWork.count', { n: String(items.length) })}</span>
        </div>
        <p className="aw-toolbar__status" role="status" style={first.error !== null && first.data !== undefined ? { color: '#b91c1c' } : undefined}>
          {first.error !== null && first.data !== undefined ? (
            <>{t('autoWork.history.staleError')} <button type="button" className="text-btn" onClick={() => void first.refresh()}>{t('autoWork.state.retry')}</button></>
          ) : updatedAt !== null ? (
            t('autoWork.history.updated', {
              time: updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              seconds: String(AUTO_WORK_EVENTS_REFRESH_MS / 1000),
            })
          ) : ''}
        </p>
      </div>

      {first.data === undefined ? (
        first.loading ? (
          <p className="empty">{t('autoWork.state.loading')}</p>
        ) : (
          <section className="panel">
            <div className="error" role="alert">{t('autoWork.history.loadFailed')}</div>
            <div className="btn-row mt-10"><button type="button" className="btn" onClick={() => void first.refresh()}>{t('autoWork.state.retry')}</button></div>
          </section>
        )
      ) : items.length === 0 ? (
        <div className="empty">
          {filtered ? t('autoWork.state.emptyFiltered') : t('autoWork.state.emptyEvents')}
          {filtered && <> <button type="button" className="text-btn" onClick={() => router.replace(`${AUTO_WORK_PATH}?tab=history`)}>{t('autoWork.history.clearFilters')}</button></>}
        </div>
      ) : (
        <div className="aw-events">
          {items.map((event: AutoWorkEventView) => <EventRow key={event.id} event={event} initiallyOpen={event.id === openEventId} t={t} />)}
        </div>
      )}

      {nextOffset !== null && (
        <div className="btn-row mt-10">
          <button type="button" className="btn" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? t('autoWork.state.loading') : t('autoWork.history.loadMore')}
          </button>
          <span className="note">{t('autoWork.history.hasMore')}</span>
          {moreError !== null && <span className="error" role="alert">{moreError}</span>}
        </div>
      )}
    </>
  );
}
