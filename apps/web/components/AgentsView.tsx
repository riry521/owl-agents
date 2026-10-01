'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getAgents } from '@/lib/api-client';
import type { AgentActivity, AgentsView as AgentsData } from '@/lib/types';
import { formatAgentLabel, formatRelative, silentSeconds, workDisplayNumber } from '@/lib/format';
import { agentRunDisplay } from '../lib/agent-run-display.mjs';
import { AgentRunTree, AgentStatusBadge, HybridPhaseBadge } from '@/components/StateBadge';
import { buildRunTree, type RunTree } from '@/lib/agent-run-tree.mjs';
import { useLocale } from '@/lib/i18n';

export function AgentsView() {
  const { locale, t } = useLocale();
  const [data, setData] = useState<AgentsData | null>(null);
  const [now, setNow] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getAgents()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setNow(Date.now());
        setLoadError(null);
      })
      .catch((error) => {
        console.error('[Owl] Agents load failed', error);
        if (alive) setLoadError(humanizeLoadError(error, t));
      });
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [t]);

  if (!data) return loadError ? <div className="error">{loadError}</div> : <p className="empty">{t('common.loading')}</p>;

  const idleCount = data.running.filter((a) => isIdle(a, data.idle_threshold_seconds, now)).length;
  // Child runs (Hybrid executors / detected subagents) are nested under their parent.
  const runTree = buildRunTree([...data.running.map((a) => a.run), ...data.recent.map((a) => a.run), ...data.children]);

  return (
    <>
      <div className="page__head">
        <div>
          <h1 className="page__title">{t('agents.title')}</h1>
          <p className="page__sub">
            {t('agents.subtitle', { minutes: String(Math.round(data.idle_threshold_seconds / 60)) })}
          </p>
        </div>
      </div>

      <section className="section" aria-labelledby="sec-running">
        <div className="section__head">
          <h2 className="section__title" id="sec-running">
            {t('agents.running')}
          </h2>
          <span className="count count--running">{t('common.items', { count: String(data.running.length) })}</span>
          {idleCount > 0 && <span className="warn">{t('agents.idleWarning', { count: String(idleCount) })}</span>}
        </div>
        {data.running.length === 0 ? (
          <p className="empty">{t('agents.noRunning')}</p>
        ) : (
          <div className="grid grid--3">
            {data.running.map((a) => (
              <RunningCard key={a.run.id} activity={a} threshold={data.idle_threshold_seconds} now={now} tree={runTree} />
            ))}
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="sec-recent">
        <div className="section__head">
          <h2 className="section__title" id="sec-recent">
            {t('agents.recentRuns')}
          </h2>
          <span className="count">{t('common.items', { count: String(data.recent.length) })}</span>
        </div>
        {data.recent.length === 0 ? (
          <p className="empty">{t('agents.noRecent')}</p>
        ) : (
          <div className="panel panel--tight">
            <div className="list">
              {data.recent.map((a) => (
                <RecentRow key={a.run.id} activity={a} now={now} tree={runTree} />
              ))}
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function humanizeLoadError(error: unknown, t: (key: string) => string): string {
  const code = error instanceof Error ? error.message : '';
  switch (code) {
    case 'network_error':
    case 'runtime_config_unavailable':
      return t('agents.errorNetwork');
    case 'invalid_runtime_config':
    case 'invalid_response':
      return t('agents.errorInvalidResponse');
    default:
      return t('agents.errorDefault');
  }
}

function isIdle(a: AgentActivity, threshold: number, now: number): boolean {
  const s = silentSeconds(a.last_output_at, a.run.started_at, now);
  return s !== null && s >= threshold;
}

function WorkLink({ activity, suffix = '' }: { activity: AgentActivity; suffix?: string }) {
  const { t } = useLocale();
  if (!activity.work) return null;
  const displayNumber = workDisplayNumber(activity.work.display_number);
  return (
    <Link href={`/work?id=${encodeURIComponent(activity.work.id)}`} className="note">
      {activity.project_name && <>{activity.project_name} · </>}
      {displayNumber !== null && <>{t('work.numberLabel', { number: String(displayNumber) })} · </>}
      {activity.work.title}
      {suffix}
    </Link>
  );
}

/** Marks a child run shown at top level because its parent run is not listed. */
function OriginBadge({ origin }: { origin: AgentActivity['run']['origin'] }) {
  const { t } = useLocale();
  if (!origin) return null;
  return (
    <span className="badge badge--gray">
      {origin === 'observed' ? t('hybrid.originObserved') : t('hybrid.originSpawned')}
    </span>
  );
}

function RunningCard({
  activity,
  threshold,
  now,
  tree,
}: {
  activity: AgentActivity;
  threshold: number;
  now: number;
  tree: RunTree;
}) {
  const { locale, t } = useLocale();
  const { run, ordinal, task, work } = activity;
  const silent = silentSeconds(activity.last_output_at, run.started_at, now);
  const idle = silent !== null && silent >= threshold;
  const silentMin = silent === null ? 0 : Math.floor(silent / 60);
  return (
    <div className={`card${idle ? ' card--idle' : ''}`}>
      <div className="card__row">
        <span className={`dot ${idle ? 'dot--warn' : 'dot--running'}`} />
        <div className="card__main">
          <div className="card__title">
            {formatAgentLabel(run, ordinal, locale)} <OriginBadge origin={run.origin} />
          </div>
          <div className="card__meta mono">{run.model}</div>
        </div>
        <AgentStatusBadge status={run.status} outcome={run.outcome} origin={run.origin} />
      </div>
      {run.phase && (
        <div>
          <HybridPhaseBadge run={run} tree={tree} />
        </div>
      )}
      {idle && (
        <div>
          <span className="warn">{t('agents.idleMinutes', { minutes: String(silentMin) })}</span>
        </div>
      )}
      <div className="card__body">
        {task ? (
          <>
            <div>{task.title}</div>
            <WorkLink activity={activity} />
          </>
        ) : work ? (
          <WorkLink activity={activity} suffix={t('agents.wholeWork')} />
        ) : (
          <span className="note">{t('agents.noTask')}</span>
        )}
      </div>
      <div className="card__meta">
        {t('agents.startedMeta', {
          time: formatRelative(run.started_at, now, locale),
          lastOutput: activity.last_output_at ? formatRelative(activity.last_output_at, now, locale) : t('agents.lastOutputNone'),
        })}
        {run.pid !== null ? ` · pid ${run.pid}` : ''}
      </div>
      <AgentRunTree rootId={run.id} tree={tree} now={now} />
    </div>
  );
}

function RecentRow({ activity, now, tree }: { activity: AgentActivity; now: number; tree: RunTree }) {
  const { locale, t } = useLocale();
  const { run, ordinal, task, work } = activity;
  const dot =
    run.status === 'completed'
      ? agentRunDisplay(run.status, run.outcome).tone === 'amber' ? 'dot dot--amber' : 'dot dot--done'
      : run.status === 'failed' || run.status === 'spawn_failed'
        ? 'dot dot--warn'
        : 'dot dot--amber';
  return (
    <div className={`row${run.status === 'completed' ? ' row--done' : ''}`}>
      <span className={dot} />
      <div className="row__main">
        <div className="row__title">
          {formatAgentLabel(run, ordinal, locale)} <OriginBadge origin={run.origin} />
        </div>
        <div className="row__sub">
          {task ? task.title : t('work.wholeWork')}
          {work ? (
            <>
              {' · '}
              <WorkLink activity={activity} />
            </>
          ) : null}
        </div>
        <AgentRunTree rootId={run.id} tree={tree} now={now} />
      </div>
      <div className="row__end">
        <span className="note">{t('agents.ended', { time: formatRelative(run.ended_at, now, locale) })}</span>
        <AgentStatusBadge status={run.status} outcome={run.outcome} origin={run.origin} />
      </div>
    </div>
  );
}
