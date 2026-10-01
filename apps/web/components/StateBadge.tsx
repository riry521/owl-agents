'use client';

import type { AgentRun, AgentRunStatus, TaskState, WorkState } from '@/lib/types';
import { safeEnumLabel, workStateLabels, taskStateLabels, agentStatusLabels, agentOutcomeLabels, agentModelLabel } from '@/lib/format';
import { useLocale, type TFunction } from '@/lib/i18n';
// Relative on purpose: the node component tests stub the `@/` modules.
import { agentRunDisplay } from '../lib/agent-run-display.mjs';
import { flattenRunTree, hybridProgress, isLiveRunStatus, type RunTree } from '../lib/agent-run-tree.mjs';

type Tone = 'accent' | 'amber' | 'green' | 'red' | 'gray';

const WORK_TONE: Record<WorkState, Tone> = {
  memo: 'gray',
  ready: 'gray',
  running: 'accent',
  paused: 'gray',
  judgement_waiting: 'amber',
  completed: 'green',
  cancelled: 'red',
};

const TASK_TONE: Record<TaskState, Tone> = {
  waiting: 'gray',
  ready: 'gray',
  running: 'accent',
  verifying: 'accent',
  review_fix_waiting: 'amber',
  failed: 'red',
  judgement_waiting: 'amber',
  completed: 'green',
  paused: 'gray',
  cancelled: 'red',
};

function Badge({ tone, children }: { tone: Tone; children: string }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function WorkStateBadge({ state }: { state: string }) {
  const { locale } = useLocale();
  const tone = Object.prototype.hasOwnProperty.call(WORK_TONE, state) ? WORK_TONE[state as WorkState] : 'gray';
  const label = safeEnumLabel(workStateLabels(locale), state);
  return <Badge tone={tone}>{label}</Badge>;
}

export function ArchivedBadge() {
  const { t } = useLocale();
  return <Badge tone="amber">{t('work.archived')}</Badge>;
}

export function TaskStateBadge({ status }: { status: string }) {
  const { locale } = useLocale();
  const tone = Object.prototype.hasOwnProperty.call(TASK_TONE, status) ? TASK_TONE[status as TaskState] : 'gray';
  const label = safeEnumLabel(taskStateLabels(locale), status);
  return <Badge tone={tone}>{label}</Badge>;
}

export function AgentStatusBadge({
  status,
  outcome = null,
  origin = null,
}: {
  status: string;
  outcome?: AgentRun['outcome'];
  origin?: AgentRun['origin'];
}) {
  const { locale, t } = useLocale();
  // An observed subagent that disappeared from the process tree has an unknown
  // outcome: show a neutral "exited" rather than the "no report" warning.
  if (status === 'exited' && origin === 'observed') return <Badge tone="gray">{t('hybrid.exited')}</Badge>;
  const display = agentRunDisplay(status, outcome);
  const labels = display.kind === 'outcome' ? agentOutcomeLabels(locale) : agentStatusLabels(locale);
  return <Badge tone={display.tone as Tone}>{safeEnumLabel(labels, display.key)}</Badge>;
}

export function ResultBadge({ result }: { result: string }) {
  const { t } = useLocale();
  const tone: Tone = result === 'success' ? 'green' : result === 'failed' ? 'amber' : result === 'partial' ? 'amber' : 'gray';
  const label = result === 'success' ? t('badge.success') : result === 'failed' ? t('badge.failed') : result === 'partial' ? t('badge.partial') : result || '—';
  return <Badge tone={tone}>{label}</Badge>;
}

// ---- child agent runs (Hybrid executors / observed subagents) ---------------

function hybridPhaseText(run: AgentRun, tree: RunTree, t: TFunction): string | null {
  switch (run.phase) {
    case 'plan':
      return t('hybrid.phasePlan');
    case 'executing': {
      const { done, total } = hybridProgress(run, tree);
      return total > 0
        ? t('hybrid.phaseExecuting', { done: String(done), total: String(total) })
        : t('hybrid.phaseExecutingNoCount');
    }
    case 'verdict':
      return t('hybrid.phaseVerdict');
    default:
      return null;
  }
}

/** Accent badge naming the Hybrid Worker's current phase; nothing for non-Hybrid runs. */
export function HybridPhaseBadge({ run, tree }: { run: AgentRun; tree: RunTree }) {
  const { t } = useLocale();
  const text = hybridPhaseText(run, tree, t);
  return text ? <Badge tone="accent">{text}</Badge> : null;
}

function formatElapsed(startedAt: string | null, endedAt: string | null, now: number, t: TFunction): string {
  const start = typeof startedAt === 'string' ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(start)) return '—';
  const endParsed = typeof endedAt === 'string' ? Date.parse(endedAt) : Number.NaN;
  const end = Number.isFinite(endParsed) ? endParsed : now;
  const total = Math.max(0, Math.floor((end - start) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return t('hybrid.elapsedHours', { h: String(h), m: String(m) });
  if (m > 0) return t('hybrid.elapsedMinutes', { m: String(m), s: String(s).padStart(2, '0') });
  return t('hybrid.elapsedSeconds', { s: String(s) });
}

function childDotClass(status: string, outcome: AgentRun['outcome']): string {
  if (isLiveRunStatus(status)) return 'dot dot--running';
  if (status === 'completed') return agentRunDisplay(status, outcome).tone === 'amber' ? 'dot dot--amber' : 'dot dot--done';
  if (status === 'failed' || status === 'spawn_failed') return 'dot dot--warn';
  if (status === 'cancelled') return 'dot dot--amber';
  return 'dot';
}

/**
 * Compact list of the runs launched under `rootId` (Hybrid executors and any
 * agent CLIs detected beneath them), nested by parent. Renders nothing when
 * the run has no children.
 */
export function AgentRunTree({
  rootId,
  tree,
  now,
}: {
  rootId: string;
  tree: RunTree;
  now: number;
}) {
  const { t } = useLocale();
  const rows = flattenRunTree(rootId, tree);
  if (rows.length === 0) return null;
  return (
    <ul className="run-tree" aria-label={t('hybrid.subagents')}>
      {rows.map(({ run, attempts, depth }) => (
        <li
          key={run.id}
          className={`run-tree__row${isLiveRunStatus(run.status) ? ' run-tree__row--live' : ''}`}
          style={depth > 0 ? { marginLeft: `${depth * 16}px` } : undefined}
        >
          <span className={childDotClass(run.status, run.outcome ?? null)} />
          <div className="run-tree__main">
            <div className="run-tree__title">
              <span className="run-tree__label">{agentModelLabel(run)}</span>
              {run.origin && (
                <Badge tone="gray">{run.origin === 'observed' ? t('hybrid.originObserved') : t('hybrid.originSpawned')}</Badge>
              )}
              {attempts > 1 && (
                <span className="badge badge--amber" title={t('hybrid.attempts', { count: String(attempts) })}>
                  {t('hybrid.retried')}
                </span>
              )}
            </div>
            <div className="run-tree__sub">
              {run.label && <><span className="mono">{run.label}</span>{' · '}</>}
              {formatElapsed(run.started_at, run.ended_at, now, t)}
            </div>
          </div>
          <div className="run-tree__end">
            <AgentStatusBadge status={run.status} outcome={run.outcome} origin={run.origin} />
          </div>
        </li>
      ))}
    </ul>
  );
}
