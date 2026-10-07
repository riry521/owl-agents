'use client';

import { useEffect, useState, useCallback } from 'react';
import { listEvents, listEventsPage } from '@/lib/api-client';
import { useView } from '@/lib/view-loader';
import { useLocale, type TFunction } from '@/lib/i18n';
import { agentModelLabel } from '@/lib/format';
import { formatCommandLine } from '@/lib/project-management';

interface EventFrame {
  event_id: string;
  type: string;
  work_id?: string;
  task_id?: string;
  agent_run_id?: string;
  agent_run?: { model: string | null; effort: string | null };
  payload: Record<string, unknown>;
  created_at: string;
}

const EVENT_ICONS: Record<string, string> = {
  'work.created': '📋',
  'work.started': '▶️',
  'work.completed': '✅',
  'work.pushed': '⬆️',
  'work.post_merge_command_queued': '⏳',
  'work.post_merge_command_succeeded': '🛠️',
  'work.failed': '❌',
  'task.ready': '📝',
  'task.completed': '✔️',
  'task.failed': '⚠️',
  'worker.started': '🔧',
  'worker.completed': '🔧',
  'worker.failed': '💥',
  'manager.started': '🧠',
  'manager.completed': '🧠',
  'manager.failed': '💥',
  'reviewer.started': '🔍',
  'reviewer.completed': '🔍',
  'worker.phase_changed': '🔀',
  'executor.started': '🤖',
  'executor.completed': '🤖',
  'executor.failed': '💥',
  'child_run.dispatched': '🤖',
  'child_run.finished': '🤖',
  'subagent.detected': '👀',
  'subagent.exited': '👋',
  'decision.created': '❓',
  'decision.resolved': '💡',
  'system.alert': '🚨',
};

const EVENT_LABEL_KEYS: Record<string, string> = {
  'work.created': 'activity.workCreated',
  'work.started': 'activity.workStarted',
  'work.completed': 'activity.workCompleted',
  'work.pushed': 'activity.workPushed',
  'work.post_merge_command_queued': 'activity.workPostMergeQueued',
  'work.post_merge_command_succeeded': 'activity.workPostMergeSucceeded',
  'work.failed': 'activity.workFailed',
  'task.ready': 'activity.taskReady',
  'task.completed': 'activity.taskCompleted',
  'task.failed': 'activity.taskFailed',
  'worker.started': 'activity.workerStarted',
  'worker.completed': 'activity.workerCompleted',
  'worker.failed': 'activity.workerFailed',
  'manager.started': 'activity.managerStarted',
  'manager.completed': 'activity.managerCompleted',
  'manager.failed': 'activity.managerFailed',
  'reviewer.started': 'activity.reviewerStarted',
  'reviewer.completed': 'activity.reviewerCompleted',
  'worker.phase_changed': 'activity.workerPhaseChanged',
  'executor.started': 'activity.executorStarted',
  'executor.completed': 'activity.executorCompleted',
  'executor.failed': 'activity.executorFailed',
  'child_run.dispatched': 'activity.childRunDispatched',
  'child_run.finished': 'activity.childRunFinished',
  'subagent.detected': 'activity.subagentDetected',
  'subagent.exited': 'activity.subagentExited',
  'decision.created': 'activity.decisionCreated',
  'decision.resolved': 'activity.decisionResolved',
  'system.alert': 'activity.systemAlert',
};

/** A system.alert is titled by its kind; unknown kinds keep the generic label. */
const ALERT_LABEL_KEYS: Record<string, string> = {
  workflow_tick_failed: 'activity.alertWorkflowStopped',
  work_merge_failed: 'activity.alertWorkMergeFailed',
  work_merge_conflict_auto_resolve: 'activity.alertWorkMergeConflictAuto',
  work_merge_branch_cleanup_failed: 'activity.alertBranchCleanupFailed',
  final_manager_failed: 'activity.alertFinalCheckFailed',
  final_manager_incomplete: 'activity.alertFinalCheckIncomplete',
  work_integration_verification_failed: 'activity.alertWorkIntegrationVerificationFailed',
  rules_load_failed: 'activity.alertRulesLoadFailed',
  rules_reloaded: 'activity.alertRulesReloaded',
  design_documents_orphaned: 'activity.alertDesignDocumentsOrphaned',
  design_changes_discarded: 'activity.alertDesignChangesDiscarded',
  agent_cancel_signal_failed: 'activity.alertAgentCancelFailed',
  work_push_failed: 'activity.alertWorkPushFailed',
  work_push_blocked_by_hook: 'activity.alertWorkPushBlocked',
  work_push_skipped_no_upstream: 'activity.alertWorkPushSkipped',
  work_post_merge_command_failed: 'activity.alertWorkPostMergeFailed',
  agent_tooling_mismatch: 'activity.alertAgentToolingMismatch',
  agent_tooling_recovered: 'activity.alertAgentToolingRecovered',
  workspaces_root_inside_repository: 'activity.alertWorkspacesInsideRepository',
};

function eventLabelKey(ev: EventFrame): string {
  const kind = ev.type === 'system.alert' ? ev.payload?.kind : undefined;
  if (typeof kind === 'string' && ALERT_LABEL_KEYS[kind]) return ALERT_LABEL_KEYS[kind];
  return EVENT_LABEL_KEYS[ev.type] ?? ev.type;
}

const PHASE_LABEL_KEYS: Record<string, string> = {
  plan: 'hybrid.phasePlan',
  executing: 'hybrid.phaseExecutingNoCount',
  verdict: 'hybrid.phaseVerdict',
};

/** Short payload detail for legacy phase and current child-run events. */
function eventDetail(ev: EventFrame, t: TFunction): string | null {
  const payload: Record<string, unknown> = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
  const { phase, label, provider, model, effort } = payload;
  if (ev.type === 'system.alert' && payload.kind === 'work_post_merge_command_failed') {
    const tail = String(payload.stderr_tail || payload.stdout_tail || '').slice(-500);
    const exit = typeof payload.exit_code === 'number' ? `${t('activity.exitCode')}: ${payload.exit_code}` : '';
    return [payload.message, exit, tail].filter((part) => typeof part === 'string' && part).join('\n');
  }
  if (ev.type === 'system.alert' && typeof payload.message === 'string') return payload.message;
  if ((ev.type === 'work.post_merge_command_queued' || ev.type === 'work.post_merge_command_succeeded') && Array.isArray(payload.argv)) {
    const command = formatCommandLine(payload.argv.map(String));
    if (ev.type === 'work.post_merge_command_succeeded' && typeof payload.duration_ms === 'number') {
      return `${command} · ${t('activity.durationSeconds', { count: String(Math.round(payload.duration_ms / 1000)) })}`;
    }
    return command;
  }
  if (ev.type === 'work.pushed' && typeof payload.remote === 'string' && typeof payload.remote_branch === 'string') {
    return `${payload.remote}/${payload.remote_branch}`;
  }
  if (ev.type === 'worker.phase_changed' && typeof phase === 'string') {
    return PHASE_LABEL_KEYS[phase] ? t(PHASE_LABEL_KEYS[phase]) : phase;
  }
  if (ev.type === 'child_run.dispatched') {
    const title = typeof payload.title === 'string' ? payload.title : '';
    const providerModel = typeof provider === 'string' && typeof model === 'string' ? `${provider} · ${model}` : '';
    return [title, providerModel].filter(Boolean).join(' · ') || null;
  }
  if (ev.type === 'child_run.finished') {
    const result = typeof payload.result === 'string' ? payload.result : '';
    const resultLabel = result === 'succeeded' || result === 'partial' || result === 'failed'
      ? t(`hybrid.childResult${result === 'succeeded' ? 'Succeeded' : result === 'partial' ? 'Partial' : 'Failed'}`)
      : result;
    const attempts = typeof payload.attempts === 'number' && payload.attempts > 1 ? t('hybrid.attempts', { count: String(payload.attempts) }) : '';
    return [resultLabel, attempts].filter(Boolean).join(' · ') || null;
  }
  if (typeof label === 'string' && label.length > 0) return label;
  // Prefer the AgentRun's model/effort; older payloads only name the provider.
  const runModel = ev.agent_run?.model || (typeof model === 'string' ? model : '');
  if (runModel) {
    const runEffort = ev.agent_run?.model ? ev.agent_run.effort : typeof effort === 'string' ? effort : null;
    return agentModelLabel({ model: runModel, effort: runEffort || null });
  }
  if (typeof provider === 'string' && provider.length > 0) return provider;
  return null;
}

function timeAgo(iso: string, t: TFunction): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return t('activity.secondsAgo', { count: String(s) });
  const m = Math.floor(s / 60);
  if (m < 60) return t('activity.minutesAgo', { count: String(m) });
  const h = Math.floor(m / 60);
  if (h < 24) return t('activity.hoursAgo', { count: String(h) });
  return t('activity.daysAgo', { count: String(Math.floor(h / 24)) });
}

function ActivityItem({ ev, t }: { ev: EventFrame; t: TFunction }) {
  const detail = eventDetail(ev, t);
  return (
    <div className="activity-item">
      <span className="activity-icon">{EVENT_ICONS[ev.type] ?? '📌'}</span>
      <div className="activity-body">
        <span className="activity-label">{t(eventLabelKey(ev))}</span>
        {detail && <span className="activity-ref" style={{ whiteSpace: 'pre-wrap' }}>{detail}</span>}
        {ev.work_id && <span className="activity-ref">Work {ev.work_id.slice(-6)}</span>}
        {ev.task_id && <span className="activity-ref">Task {ev.task_id.slice(-6)}</span>}
      </div>
      <span className="activity-time">{timeAgo(ev.created_at, t)}</span>
    </div>
  );
}

function isPostMergeEvent(ev: EventFrame): boolean {
  return ev.type === 'work.post_merge_command_queued' || ev.type === 'work.post_merge_command_succeeded'
    || (ev.type === 'system.alert' && ev.payload?.kind === 'work_post_merge_command_failed');
}

/** Post-merge command events of one Work (queued, succeeded, failed alert); renders nothing when it has none. */
export function appendPostMergeEvents(prev: EventFrame[], page: EventFrame[], workId: string): EventFrame[] {
  const seen = new Set(prev.map((ev) => ev.event_id));
  return [...prev, ...page.filter((ev) => ev.work_id === workId && isPostMergeEvent(ev) && !seen.has(ev.event_id))];
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function WorkPostMergeEvents({ workId, refreshToken }: { workId: string; refreshToken: number }) {
  const { t } = useLocale();
  const [events, setEvents] = useState<EventFrame[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadPage = useCallback(async (before?: string) => {
    const page = await listEventsPage(200, before);
    // 同じ cursor の繰り返しは打ち切る
    setNextCursor(page.has_more && page.cursor !== before ? page.cursor : null);
    return page.events as EventFrame[];
  }, []);

  useEffect(() => {
    let alive = true;
    loadPage()
      .then((page) => {
        if (!alive) return;
        setLoadError(null);
        setEvents(appendPostMergeEvents([], page, workId));
      })
      .catch((error) => {
        console.error('[Owl] Post-merge history load failed', error);
        if (alive) setLoadError(errorText(error));
      });
    return () => { alive = false; };
  }, [workId, refreshToken, loadPage]);

  const loadOlder = async () => {
    if (loading || !nextCursor) return;
    setLoading(true);
    try {
      const page = await loadPage(nextCursor);
      setLoadError(null);
      setEvents((prev) => appendPostMergeEvents(prev, page, workId));
    } catch (error) {
      // ボタンは残るので、次の操作で再試行できる
      console.error('[Owl] Older post-merge history load failed', error);
      setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  };

  if (events.length === 0 && !nextCursor && !loadError) return null;
  return (
    <section className="panel">
      <h2 className="panel__title">{t('activity.postMergeHistory')}</h2>
      <div className="activity-list">
        {events.map((ev) => <ActivityItem key={ev.event_id} ev={ev} t={t} />)}
      </div>
      {loadError && <div className="error" role="alert">{t('activity.postMergeLoadError')}: {loadError}</div>}
      {nextCursor && (
        <button type="button" className="btn" disabled={loading} onClick={loadOlder}>{t('activity.postMergeLoadOlder')}</button>
      )}
    </section>
  );
}

export default function ActivityLog() {
  const { t } = useLocale();
  const { data, error: loadError } = useView('events', () => listEvents(100));
  const events = (data ?? []) as EventFrame[];
  const error = loadError ? String(loadError) : '';

  if (error) return <div className="page"><p style={{ color: 'var(--red)' }}>{error}</p></div>;

  return (
    <div className="page">
      <h1 style={{ fontSize: '1.4rem', marginBottom: '1.2rem' }}>{t('activity.title')}</h1>
      {events.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>{t('activity.noEvents')}</p>
      ) : (
        <div className="activity-list">
          {events.map((ev) => <ActivityItem key={ev.event_id} ev={ev} t={t} />)}
        </div>
      )}
    </div>
  );
}
