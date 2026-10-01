'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getWorkDetail, subscribeToUpdates } from '@/lib/api-client';
import { humanizeWorkDetailError, normalizeWorkDetailData, workDetailHref } from '@/lib/work-detail-safety.mjs';
import type { AgentRun, WorkDetailView as WorkData } from '@/lib/types';
import {
  agentStatusLabels,
  agentOutcomeLabels,
  formatAgentLabel,
  formatRelative,
  roleDisplayName,
  runOrdinals,
  safeEnumLabel,
  workDisplayNumber,
} from '@/lib/format';
import { agentRunDisplay } from '../lib/agent-run-display.mjs';
import { AgentRunTree, ArchivedBadge, HybridPhaseBadge, TaskStateBadge, WorkStateBadge } from '@/components/StateBadge';
import { WorkArchiveActions } from '@/components/WorkArchiveActions';
// Relative on purpose: the node component tests stub the `@/` modules.
import { activeRunByTask, buildRunTree, isRunActive } from '../lib/agent-run-tree.mjs';
import { useLocale } from '@/lib/i18n';
import { WorkSummaryBlock } from '@/components/WorkSummaryBlock';

const LIVE_RUN = new Set<AgentRun['status']>(['launch_pending', 'spawned', 'running', 'cancel_requested']);
const PREVIEW_TIMEOUT_MS = 45_000;
const EVENT_LIMIT = 8;

interface WorkPreviewPanelProps {
  workId: string;
  onBack: () => void;
  onDeleted?: () => void;
}

interface PreviewEvent {
  key: string;
  at: string;
  text: string;
  tone: 'accent' | 'green' | 'amber' | 'red' | 'gray';
}

/**
 * Compact Work detail shown in the Board's left column when a card is selected
 * (design: "Home (Task Detail)"). The full page stays at /work?id=….
 */
export function WorkPreviewPanel({ workId, onBack, onDeleted }: WorkPreviewPanelProps) {
  const { locale, t } = useLocale();
  const [data, setData] = useState<WorkData | null | undefined>(undefined);
  const [now, setNow] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Tick the clock while agents run so subagent elapsed times stay current.
  const hasLiveRun = !!data && data.runs.some((r) => LIVE_RUN.has(r.status));
  useEffect(() => {
    if (!hasLiveRun) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasLiveRun]);

  useEffect(() => {
    let alive = true;
    const requestTimers = new Set<ReturnType<typeof setTimeout>>();
    setData(undefined);
    setLoadError(null);
    const load = async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const next = await Promise.race([
          getWorkDetail(workId),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('request_timeout')), PREVIEW_TIMEOUT_MS);
            requestTimers.add(timeout);
          }),
        ]);
        if (!alive) return;
        setData(next === null ? null : normalizeWorkDetailData(next, workId));
        setNow(Date.now());
        setLoadError(null);
      } catch (error) {
        console.error('[Owl] Work preview refresh failed', error);
        if (alive) setLoadError(humanizeWorkDetailError(error, t));
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
          requestTimers.delete(timeout);
        }
      }
    };
    void load();
    const unsubscribe = subscribeToUpdates(
      [workId],
      () => {
        if (alive) void load();
      },
      () => {},
    );
    return () => {
      alive = false;
      for (const timer of requestTimers) clearTimeout(timer);
      requestTimers.clear();
      unsubscribe();
    };
  }, [workId, t]);

  const detailHref = workDetailHref(workId);
  const backRow = (
    <div className="board-layout__back-row">
      <button type="button" className="btn btn--back" onClick={onBack}>
        ← {t('board.backToChat')}
      </button>
    </div>
  );

  if (data === undefined) {
    return (
      <div className="preview">
        {backRow}
        <div className="preview__body">
          {loadError ? <div className="error" role="alert">{loadError}</div> : <p className="empty">{t('common.loading')}</p>}
          <Link className="btn btn--primary btn--block" href={detailHref}>
            {t('board.preview.openDetail')} →
          </Link>
        </div>
      </div>
    );
  }
  if (data === null) {
    return (
      <div className="preview">
        {backRow}
        <div className="preview__body">
          <p className="empty">{t('work.notFoundDetail', { id: workId })}</p>
        </div>
      </div>
    );
  }

  const { work, tasks, runs, reports, decisions } = data;
  const displayNumber = workDisplayNumber(work.display_number);
  const ordinals = runOrdinals(runs);
  const label = (run: AgentRun) => formatAgentLabel(run, ordinals.get(run.id) ?? 1, locale);
  const runById = new Map(runs.map((r) => [r.id, r]));
  const taskTitle = (taskId: string | null): string =>
    taskId ? (tasks.find((tk) => tk.id === taskId)?.title ?? taskId) : t('work.wholeWork');

  // Child runs (Hybrid executors / detected subagents) render nested under the
  // run that launched them; the Task's representative run is its Worker /
  // Reviewer, which stays active while anything it launched is live.
  const runTree = buildRunTree(runs);
  const liveRuns = runs.filter((r) => !runTree.isChild(r) && isRunActive(r, runTree));
  const liveRunByTask = activeRunByTask(runs, runTree);
  const openDecisions = decisions.filter((d) => d.status === 'open');
  const { completed_tasks: doneCount, total_tasks: taskTotal, percent: pct } = work.progress;

  const statusLabels = agentStatusLabels(locale);
  const outcomeLabels = agentOutcomeLabels(locale);
  const events: PreviewEvent[] = [];
  for (const r of runs) {
    if (r.started_at) {
      events.push({ key: `${r.id}-start`, at: r.started_at, text: t('board.preview.eventStarted', { agent: label(r) }), tone: 'accent' });
    }
    if (r.ended_at) {
      const display = agentRunDisplay(r.status, r.outcome);
      const tone = display.tone === 'accent' ? 'gray' : display.tone;
      events.push({
        key: `${r.id}-end`,
        at: r.ended_at,
        text: t('board.preview.eventEnded', { agent: label(r), status: safeEnumLabel(display.kind === 'outcome' ? outcomeLabels : statusLabels, display.key) }),
        tone,
      });
    }
  }
  for (const rep of reports) {
    const run = runById.get(rep.agent_run_id);
    events.push({
      key: `${rep.id}-report`,
      at: rep.created_at,
      text: t('board.preview.eventReported', { agent: run ? label(run) : roleDisplayName('worker', locale) }),
      tone: rep.result === 'success' ? 'green' : rep.result === 'failed' ? 'amber' : 'gray',
    });
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  const recentEvents = events.slice(0, EVENT_LIMIT);

  return (
    <div className="preview">
      {backRow}
      <div className="preview__body">
        {loadError && <div className="error" role="alert">{loadError}</div>}

        <section className="preview__head" aria-labelledby="preview-title">
          <h2 className="preview__title" id="preview-title">
            {displayNumber !== null && <span className="badge badge--gray">{t('work.numberLabel', { number: String(displayNumber) })}</span>}
            {displayNumber !== null && ' '}
            {work.title}
          </h2>
          <div className="chips chips--flush">
            <WorkStateBadge state={work.state} /> {work.archived_at && <ArchivedBadge />}
            <span className="note">{formatRelative(work.updated_at, now, locale)}</span>
          </div>
          <WorkSummaryBlock summary={work.summary} variant="compact" />
          <div className="progress-row">
            <div className="progress">
              <div className="progress__bar" style={{ width: `${pct}%` }} />
            </div>
            <strong>{pct}%</strong>
            <span className="note">
              {t('work.progressCompleted', { done: String(doneCount), total: String(taskTotal) })}
            </span>
          </div>
          <Link className="btn btn--primary btn--block" href={detailHref}>
            {t('board.preview.openDetail')} →
          </Link>
          {(work.state === 'completed' || work.state === 'cancelled') && (
            <div className="btn-row mt-10">
              <WorkArchiveActions work={work} onDeleted={() => (onDeleted ?? onBack)()} />
            </div>
          )}
        </section>

        {openDecisions.length > 0 && (
          <section className="preview__section" aria-labelledby="preview-decisions">
            <h3 className="preview__label" id="preview-decisions">
              {t('board.preview.openDecisions')} <span className="count">{openDecisions.length}</span>
            </h3>
            <div className="list">
              {openDecisions.map((d) => (
                <Link key={d.id} href={`/decision?id=${encodeURIComponent(d.id)}`} className="row row--warn">
                  <span className="dot dot--amber" />
                  <div className="row__main">
                    <div className="row__title row__title--wrap">{d.question || d.reason}</div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        <section className="preview__section" aria-labelledby="preview-agents">
          <h3 className="preview__label" id="preview-agents">{t('work.activeAgents')}</h3>
          {liveRuns.length === 0 ? (
            <p className="empty">{t('work.noActiveAgents')}</p>
          ) : (
            <div className="list">
              {liveRuns.map((r) => (
                <div className="row row--running" key={r.id}>
                  <span className="dot dot--running" />
                  <div className="row__main">
                    <div className="row__title">{label(r)}</div>
                    <div className="row__sub">
                      {taskTitle(r.task_id)} · <span className="mono">{r.model}</span>
                    </div>
                  </div>
                  {r.phase && (
                    <div className="row__end">
                      <HybridPhaseBadge run={r} tree={runTree} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="preview__section" aria-labelledby="preview-tasks">
          <h3 className="preview__label" id="preview-tasks">
            {t('work.internalTasks')} <span className="count">{tasks.length}</span>
          </h3>
          {tasks.length === 0 ? (
            <p className="empty">{t('work.noTasks')}</p>
          ) : (
            <div className="list">
              {tasks.map((tk) => {
                const live = liveRunByTask.get(tk.id);
                const rowClass = tk.status === 'completed' ? 'row row--done' : live ? 'row row--running' : 'row';
                // A Task whose agents are still working must not read as idle (waiting).
                const shownStatus = live && (tk.status === 'waiting' || tk.status === 'ready') ? 'running' : tk.status;
                const dotClass =
                  tk.status === 'completed'
                    ? 'dot dot--done'
                    : live
                      ? 'dot dot--running'
                      : tk.status === 'judgement_waiting' || tk.status === 'failed'
                        ? 'dot dot--amber'
                        : 'dot';
                return (
                  <div className={rowClass} key={tk.id}>
                    <span className={dotClass} />
                    <div className="row__main">
                      <div className="row__title row__title--task">{tk.title}</div>
                      {live && <div className="row__sub">{label(live)} {t('work.working')}</div>}
                      {live?.phase && (
                        <div className="chips chips--tight">
                          <HybridPhaseBadge run={live} tree={runTree} />
                        </div>
                      )}
                      {live && <AgentRunTree rootId={live.id} tree={runTree} now={now} />}
                    </div>
                    <div className="row__end">
                      <TaskStateBadge status={shownStatus} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="preview__section" aria-labelledby="preview-events">
          <h3 className="preview__label" id="preview-events">{t('board.preview.eventLog')}</h3>
          {recentEvents.length === 0 ? (
            <p className="empty">{t('board.preview.noEvents')}</p>
          ) : (
            <ol className="preview__events">
              {recentEvents.map((ev) => (
                <li key={ev.key} className="preview__event">
                  <span className={`preview__event-dot preview__event-dot--${ev.tone}`} aria-hidden="true" />
                  <span className="preview__event-text">{ev.text}</span>
                  <span className="preview__event-time">{formatRelative(ev.at, now, locale)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
