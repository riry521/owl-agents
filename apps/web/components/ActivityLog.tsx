'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { listEvents } from '@/lib/api-client';
import { useLocale, type TFunction } from '@/lib/i18n';
import { agentModelLabel } from '@/lib/format';

interface EventFrame {
  event_id: string;
  type: string;
  work_id?: string;
  task_id?: string;
  agent_run_id?: string;
  payload: Record<string, unknown>;
  created_at: string;
}

const EVENT_ICONS: Record<string, string> = {
  'work.created': '📋',
  'work.started': '▶️',
  'work.completed': '✅',
  'work.pushed': '⬆️',
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
  work_merge_branch_cleanup_failed: 'activity.alertBranchCleanupFailed',
  final_manager_failed: 'activity.alertFinalCheckFailed',
  final_manager_incomplete: 'activity.alertFinalCheckIncomplete',
  rules_load_failed: 'activity.alertRulesLoadFailed',
  rules_reloaded: 'activity.alertRulesReloaded',
  design_documents_orphaned: 'activity.alertDesignDocumentsOrphaned',
  design_changes_discarded: 'activity.alertDesignChangesDiscarded',
  agent_cancel_signal_failed: 'activity.alertAgentCancelFailed',
  work_push_failed: 'activity.alertWorkPushFailed',
  work_push_blocked_by_hook: 'activity.alertWorkPushBlocked',
  work_push_skipped_no_upstream: 'activity.alertWorkPushSkipped',
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

/** Short payload detail for Hybrid / subagent events (phase name or run label). */
function eventDetail(ev: EventFrame, t: TFunction): string | null {
  const payload: Record<string, unknown> = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
  const { phase, label, provider, model, effort } = payload;
  if (ev.type === 'system.alert' && typeof payload.message === 'string') return payload.message;
  if (ev.type === 'work.pushed' && typeof payload.remote === 'string' && typeof payload.remote_branch === 'string') {
    return `${payload.remote}/${payload.remote_branch}`;
  }
  if (ev.type === 'worker.phase_changed' && typeof phase === 'string') {
    return PHASE_LABEL_KEYS[phase] ? t(PHASE_LABEL_KEYS[phase]) : phase;
  }
  if (typeof label === 'string' && label.length > 0) return label;
  if (typeof model === 'string' && model.length > 0) {
    return agentModelLabel({ model, effort: typeof effort === 'string' && effort.length > 0 ? effort : null });
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

export default function ActivityLog() {
  const { t } = useLocale();
  const [events, setEvents] = useState<EventFrame[]>([]);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await listEvents(100);
      setEvents(res as EventFrame[]);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    load();
    timer.current = setInterval(load, 10_000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]);

  if (error) return <div className="page"><p style={{ color: 'var(--red)' }}>{error}</p></div>;

  return (
    <div className="page">
      <h1 style={{ fontSize: '1.4rem', marginBottom: '1.2rem' }}>{t('activity.title')}</h1>
      {events.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>{t('activity.noEvents')}</p>
      ) : (
        <div className="activity-list">
          {events.map((ev) => {
            const detail = eventDetail(ev, t);
            return (
              <div key={ev.event_id} className="activity-item">
                <span className="activity-icon">{EVENT_ICONS[ev.type] ?? '📌'}</span>
                <div className="activity-body">
                  <span className="activity-label">{t(eventLabelKey(ev))}</span>
                  {detail && <span className="activity-ref">{detail}</span>}
                  {ev.work_id && <span className="activity-ref">Work {ev.work_id.slice(-6)}</span>}
                  {ev.task_id && <span className="activity-ref">Task {ev.task_id.slice(-6)}</span>}
                </div>
                <span className="activity-time">{timeAgo(ev.created_at, t)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
