'use client';

import { cancelCleanupFailure, cleanupFailureReason } from '@/lib/work-removal';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  answerDecision,
  cancelWork,
  getWorkDetail,
  pauseWork,
  reopenWork,
  resumeTaskPrerequisite,
  resumeWork,
  getWorkConversation,
  getWorkAssurance,
  getWorkCoreActivity,
  startWork,
} from '@/lib/api-client';
import { CoreActivityRows } from '@/components/CoreActivityRows';
import { useRealtimeStatus, useView } from '@/lib/view-loader';
import { humanizeWorkDetailError, normalizeWorkDetailData } from '@/lib/work-detail-safety.mjs';
import type { AgentRun, Report, TaskState, WorkAssurance, WorkCoreActivity, WorkConversation as WorkConversationData, WorkDetailView as WorkData } from '@/lib/types';
import {
  taskStateLabels,
  safeEnumLabel,
  asReportEnvelope,
  formatAgentLabel,
  formatRelative,
  roleDisplayName,
  runOrdinals,
  workDisplayNumber,
} from '@/lib/format';
import { AgentRunTree, AgentStatusBadge, ArchivedBadge, ChildRunList, HybridPhaseBadge, ResultBadge, TaskStateBadge, WorkStateBadge } from '@/components/StateBadge';
import { WorkArchiveActions } from '@/components/WorkArchiveActions';
import { DesignDocumentsSection } from '@/components/DesignDocumentsSection';
import { WorkBacklogSection } from '@/components/WorkBacklogSection';
import { WorkPostMergeEvents } from '@/components/ActivityLog';
// Relative on purpose: the node component tests stub the `@/` modules.
import { orderTasksByStage } from '../lib/task-stages.mjs';
import { activeRunByTask, buildRunTree, isRunActive } from '../lib/agent-run-tree.mjs';
import { reviewNotesByTask } from '../lib/work-assurance.mjs';
import { WorkAssurancePanel } from '@/components/WorkAssurancePanel';
import { workDeliverables } from '../lib/work-deliverables.mjs';
import { useLocale, type TFunction, type Locale } from '@/lib/i18n';
import { WorkConversation } from '@/components/WorkConversation';
import { WorkSummaryHistory } from '@/components/WorkSummaryHistory';
import { WorkSummaryBlock } from '@/components/WorkSummaryBlock';

const LIVE_RUN = new Set<AgentRun['status']>(['launch_pending', 'spawned', 'running', 'cancel_requested']);
const WORK_DETAIL_TIMEOUT_MS = 45_000;

interface WorkDetailViewProps {
  workId?: string;
  onBack?: () => void;
}

export function WorkDetailView({ workId: workIdProp, onBack }: WorkDetailViewProps = {}) {
  const { locale, t } = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const requestedId = workIdProp ?? params.get('id');
  const id = typeof requestedId === 'string' && requestedId.trim().length > 0 ? requestedId : null;
  const [now, setNow] = useState(0);
  const realtimeStatus = useRealtimeStatus();
  const [deleted, setDeleted] = useState(false);
  const [operationPending, setOperationPending] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [conversation, setConversation] = useState<{ workId: string; data: WorkConversationData } | null>(null);
  const [conversationError, setConversationError] = useState(false);
  const [assurance, setAssurance] = useState<WorkAssurance | null>(null);
  const [assuranceError, setAssuranceError] = useState(false);
  // Bumped whenever a Work detail refresh succeeds, so the design documents
  // section refetches its list alongside the rest of the Work's data.
  const [designsRefreshToken, setDesignsRefreshToken] = useState(0);

  const view = useView<WorkData | null>(id ? `work:${id}` : null, async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const next = await Promise.race([
        getWorkDetail(id ?? ''),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('request_timeout')), WORK_DETAIL_TIMEOUT_MS);
        }),
      ]);
      return next === null ? null : normalizeWorkDetailData(next, id ?? '');
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  });
  const { refresh } = view;
  // After a delete the screen is leaving; keep what it last showed rather than flashing "not found".
  const lastData = useRef<WorkData | null | undefined>(undefined);
  if (!deleted) lastData.current = id ? view.data : null;
  const data = lastData.current;
  const loadError = !deleted && id && view.error ? humanizeWorkDetailError(view.error, t) : null;
  const retry = () => void refresh();
  // Silent reload (no loading flash) so the conversation draft survives a send.
  const reloadRef = useRef<() => void>(() => {});
  reloadRef.current = () => void refresh();

  useEffect(() => {
    if (view.error) console.error('[Owl] Work Detail refresh failed', view.error);
  }, [view.error]);

  // Core's own work rows are optional: a failed fetch leaves the list empty and the Work screen untouched.
  const coreView = useView<WorkCoreActivity | null>(id ? `work-core-activity:${id}` : null, () => getWorkCoreActivity(id ?? ''));
  const coreActivities = coreView.error ? [] : (coreView.data?.activities ?? []);

  // Tick the clock while agents run so subagent elapsed times stay current.
  const hasLiveRun =
    !!data && (data.runs.some((r) => LIVE_RUN.has(r.status)) || data.child_runs.some((r) => r.status === 'running')) || coreActivities.length > 0;
  useEffect(() => {
    if (!hasLiveRun) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasLiveRun]);

  const runWorkOperation = async (operation: () => Promise<unknown>) => {
    setOperationPending(true);
    setOperationError(null);
    try {
      const result = await operation();
      retry();
      const cancelCleanup = cancelCleanupFailure(result);
      if (cancelCleanup) setOperationError(`${t('work.errorCancelCleanup')} ${cancelCleanup}`);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : '';
      const kind = typeof error === 'object' && error !== null && 'kind' in error && typeof error.kind === 'string'
        ? error.kind
        : '';
      const cleanupReason = cleanupFailureReason(error);
      setOperationError(
        code === 'version_conflict'
          ? t('work.errorVersionConflict')
          : cleanupReason
            ? `${t('work.errorOperation')} ${cleanupReason}`
            : kind === 'network_error'
              ? t('work.errorNetwork')
              : t('work.errorOperation'),
      );
    } finally {
      setOperationPending(false);
    }
  };

  // The conversation and assurance ride along with each Work detail load.
  useEffect(() => {
    setConversation(null);
    setConversationError(false);
    setAssurance(null);
    setAssuranceError(false);
  }, [id]);
  useEffect(() => {
    if (deleted || !id || !data) return;
    let alive = true;
    void Promise.all([getWorkConversation(id).catch((error) => {
        console.error('Failed to load Work conversation', error);
        return undefined;
      }), getWorkAssurance(id).catch((error) => {
        console.error('Failed to load Work assurance', error);
        return undefined;
      })]).then(
      ([nextConversation, nextAssurance]) => {
        if (!alive) return;
        if (nextConversation) {
          setConversation({ workId: id, data: nextConversation });
          setConversationError(false);
        } else {
          setConversationError(true);
        }
        setAssurance(nextAssurance ?? null);
        setAssuranceError(nextAssurance === undefined);
        setNow(Date.now());
        setDesignsRefreshToken((token) => token + 1);
      },
    );
    return () => {
      alive = false;
    };
  }, [deleted, id, data]);

  const realtimeMessage =
    realtimeStatus === 'polling'
      ? t('realtime.polling')
      : realtimeStatus === 'connected'
        ? t('realtime.connected')
        : t('realtime.connecting');

  if (data === undefined) {
    return (
      <>
        <p className="sync-status" role="status">
          {realtimeMessage}
        </p>
        {loadError ? (
          <WorkLoadError message={loadError} onRetry={retry} t={t} />
        ) : <p className="empty">{t('common.loading')}</p>}
      </>
    );
  }
  if (data === null) {
    return (
      <div className="panel">
        <h1 className="page__title">{t('work.notFound')}</h1>
        <p className="page__sub">
          {t('work.notFoundDetail', { id: id ?? t('common.none') })}
        </p>
        <div className="btn-row mt-10">
          <button type="button" className="btn" onClick={retry}>{t('work.retry')}</button>
          <Link className="btn" href="/board">{t('common.backToBoard')}</Link>
        </div>
      </div>
    );
  }

  const { work, tasks, runs, child_runs, reports, decisions } = data;
  const shownConversation = conversation?.workId === id ? conversation.data : null;
  const displayNumber = workDisplayNumber(work.display_number);
  const canStart = work.state === 'memo' || work.state === 'ready';
  const canPause = work.state === 'running';
  // A Work stopped by an error waits on a Core Decision that offers a retry.
  const retryDecision = work.state === 'judgement_waiting'
    ? decisions.find((d) => d.status === 'open' && d.scope === 'work' && d.options.some((o) => o.key === 'retry'))
    : undefined;
  const hasOpenDecision = decisions.some((d) => d.status === 'open');
  const canResume = work.state === 'paused' || retryDecision !== undefined;
  // judgement_waiting Works are blocked on the owner; cancelling them must stay possible.
  const canCancel = canPause || canResume || work.state === 'judgement_waiting';
  const resumeWorkOrDecision = () => {
    if (retryDecision === undefined) return resumeWork(work.id, work.state_version);
    const option = retryDecision.options.find((o) => o.key === 'retry');
    return answerDecision(retryDecision.id, {
      answer: option?.label ?? 'retry',
      option_key: 'retry',
      source: 'web',
      source_message_id: null,
    });
  };
  const canReopen = work.state === 'completed';
  const canArchive = work.state === 'completed' || work.state === 'cancelled';
  const hasActions = canStart || canCancel || canReopen || canArchive;
  const handleDeleted = () => {
    setDeleted(true);
    if (onBack) onBack();
    else router.replace('/board');
  };
  const ordinals = runOrdinals(runs, () => work.id, tasks);
  const runById = new Map(runs.map((r) => [r.id, r]));
  const taskTitle = (taskId: string | null): string =>
    taskId ? (tasks.find((t_) => t_.id === taskId)?.title ?? taskId) : t('work.wholeWork');
  const label = (run: AgentRun) => formatAgentLabel(run, ordinals.get(run.id) ?? 1, locale);
  const parentLabels = Object.fromEntries(runs.map((run) => [run.id, label(run)]));

  // Child AgentRuns and detected subagents render nested under the
  // run that launched them, never as separate top-level agents. A run counts as
  // active while it or anything it launched is live (e.g. a Worker whose
  // child executions are running).
  const runTree = buildRunTree(runs);
  const liveRuns = runs.filter((r) => !runTree.isChild(r) && isRunActive(r, runTree));
  const liveRunByTask = activeRunByTask(runs, runTree);
  const reviewNotes = reviewNotesByTask(assurance);

  const managerRuns = runs.filter((r) => r.role === 'manager');
  const latestManager = managerRuns[managerRuns.length - 1];

  const { completed_tasks: doneCount, total_tasks: taskTotal, percent: pct } = work.progress;
  const stateCounts = new Map<TaskState, number>();
  for (const tk of tasks) stateCounts.set(tk.status, (stateCounts.get(tk.status) ?? 0) + 1);

  const stateLabels = taskStateLabels(locale);

  const deliverables = workDeliverables(reports, runs, tasks);

  const history = [...runs].sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));

  return (
    <>
      <p className="sync-status" role="status">
        {realtimeMessage}
      </p>
      {loadError && <WorkLoadError message={loadError} onRetry={retry} t={t} />}
      {onBack ? (
        <div className="board-layout__back-row">
          <button type="button" className="btn btn--back" onClick={onBack}>
            ← {t('board.backToChat')}
          </button>
          <strong>{work.title}</strong>
        </div>
      ) : (
        <div className="crumbs">
          <Link href="/board">{t('board.title')}</Link>
          <span>›</span>
          <strong>{work.title}</strong>
        </div>
      )}

      {hasOpenDecision && (
        <div className="decision-banner" role="status">
          <span>{t('work.decisionBanner')}</span>
          <a className="btn" href="#sec-decisions">{t('work.decisionBannerLink')} →</a>
        </div>
      )}

      <div className="two-col">
        <div>
          {/* Overview */}
          <section className="panel" aria-labelledby="sec-overview">
            <h2 className="panel__title" id="sec-overview">
              {t('work.overview')}
            </h2>
            <div className="work-head__meta">
              {displayNumber !== null && <span className="badge badge--gray">{t('work.numberLabel', { number: String(displayNumber) })}</span>}
              <WorkStateBadge state={work.state} />
              {work.archived_at && <ArchivedBadge />}
            </div>
            <h1 className="page__title panel__heading">{work.title}</h1>
            <WorkSummaryBlock summary={work.summary} variant="full" />
            <dl className="kv kv--spaced">
              <dt>{t('work.owner')}</dt>
              <dd>{work.owner_id}</dd>
              <dt>{t('work.project')}</dt>
              <dd className="mono">{work.project_id ?? '—'}</dd>
              <dt>{t('work.planRevision')}</dt>
              <dd>{work.plan_revision}</dd>
              <dt>{t('work.designRole')}</dt>
              <dd>{t(work.design_mode === 'lead' ? 'work.designModeLead' : 'work.designModeAuto')}</dd>
              <dt>{t('work.updated')}</dt>
              <dd>{formatRelative(work.updated_at, now, locale)}</dd>
              <dt>{t('work.id')}</dt>
              <dd className="mono">{work.id}</dd>
            </dl>
            {hasActions && (
              <div className="btn-row btn-row--spaced" aria-busy={operationPending}>
                {canStart && (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={operationPending}
                    onClick={() => void runWorkOperation(() => startWork(work.id, work.state_version, work.size === 'small' ? 'small' : 'normal'))}
                  >
                    {t('work.start')}
                  </button>
                )}
                {canPause && (
                  <button
                    type="button"
                    className="btn"
                    disabled={operationPending}
                    onClick={() => void runWorkOperation(() => pauseWork(work.id, work.state_version, t('work.pauseReason')))}
                  >
                    {t('work.pause')}
                  </button>
                )}
                {canResume && (
                  <button
                    type="button"
                    className="btn"
                    disabled={operationPending}
                    onClick={() => void runWorkOperation(resumeWorkOrDecision)}
                  >
                    {t('work.resume')}
                  </button>
                )}
                {canCancel && (
                  <button
                    type="button"
                    className="btn btn--danger"
                    disabled={operationPending}
                    onClick={() => {
                      if (typeof window !== 'undefined' && window.confirm(t('work.confirmAbort'))) {
                        void runWorkOperation(() => cancelWork(work.id, work.state_version, t('work.abortReason')));
                      }
                    }}
                  >
                    {t('work.abort')}
                  </button>
                )}
                {canReopen && (
                  <button
                    type="button"
                    className="btn"
                    disabled={operationPending}
                    onClick={() => void runWorkOperation(() => reopenWork(work.id, work.state_version, t('work.reopenReason')))}
                  >
                    {t('work.reopen')}
                  </button>
                )}
                {canArchive && (
                  <WorkArchiveActions
                    work={work}
                    disabled={operationPending}
                    onChanged={retry}
                    onDeleted={handleDeleted}
                  />
                )}
                {operationPending && <span className="note" role="status">{t('work.operationPending')}</span>}
              </div>
            )}
            {operationError && <p className="error" role="alert">{operationError}</p>}
          </section>

          {/* Conversation */}
          <section className="panel work-detail__conversation" aria-labelledby="sec-conversation">
            <h2 className="panel__title" id="sec-conversation">
              {t('work.conversation')} <span className="note">{t('work.conversationSub')}</span>
            </h2>
            {conversationError && (
              <p className="error" role="alert">
                {t('work.conversationLoadError')}{' '}
                <button type="button" className="btn" onClick={() => reloadRef.current()}>{t('work.retry')}</button>
              </p>
            )}
            {(shownConversation || !conversationError) && (
              <WorkConversation work={work} conversation={shownConversation} onWorkChanged={() => reloadRef.current()} />
            )}
          </section>

          {/* Progress */}
          <section className="panel" aria-labelledby="sec-progress">
            <h2 className="panel__title" id="sec-progress">
              {t('work.progress')}
            </h2>
            <div className="progress-row">
              <div className="progress">
                <div className="progress__bar" style={{ width: `${pct}%` }} />
              </div>
              <strong>{pct}%</strong>
              <span className="note">
                {t('work.progressCompleted', { done: String(doneCount), total: String(taskTotal) })}
              </span>
            </div>
            <div className="chips">
              {[...stateCounts.entries()].map(([s, n]) => (
                <span key={s} className="badge badge--gray">
                  {safeEnumLabel(stateLabels, s)} {n}
                </span>
              ))}
            </div>
          </section>

          {/* Internal Tasks */}
          <section className="panel" aria-labelledby="sec-tasks">
            <h2 className="panel__title" id="sec-tasks">
              {t('work.internalTasks')} <span className="count">{tasks.length}</span>
            </h2>
            {tasks.length === 0 ? (
              <p className="empty">{t('work.noTasks')}</p>
            ) : (
              <div className="list panel__scroll">
                {orderTasksByStage(tasks).map(({ task: tk, label: stageLabel }) => {
                  const live = liveRunByTask.get(tk.id);
                  const taskChildRuns = child_runs.filter((child) => child.task_id === tk.id);
                  const childAgentRunIds = new Set(taskChildRuns.flatMap((child) => child.current_agent_run_id ? [child.current_agent_run_id] : []));
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
                        <div className="row__title row__title--task">{stageLabel ? `${stageLabel}. ${tk.title}` : tk.title}</div>
                        <div className="row__sub">
                          {tk.type === 'design' ? <span className="badge badge--purple">{t('work.taskTypeDesign')}</span> : tk.type}
                          {live ? ` · ${label(live)} ${t('work.working')}` : ''}
                        </div>
                        {live && (
                          <>
                            {live.phase && (
                              <div className="chips chips--tight">
                                <HybridPhaseBadge run={live} tree={runTree} />
                              </div>
                            )}
                            <AgentRunTree rootId={live.id} tree={runTree} now={now} excludedIds={childAgentRunIds} />
                          </>
                        )}
                        <ChildRunList runs={taskChildRuns} parentLabels={parentLabels} now={now} />
                        {reviewNotes.get(tk.id)?.reasons.map((reason) => (
                          <div className="row__sub" key={reason}>
                            {t(reviewNotes.get(tk.id)?.kind === 'skipped' ? 'work.reviewSkipped' : 'work.reviewForced', { reason })}
                          </div>
                        ))}
                        {tk.prerequisite && (
                          <>
                            <div className="row__sub">
                              <span className="badge badge--amber">{t(tk.prerequisite.source === 'worker' ? 'work.processWaiting' : 'work.prerequisiteWaiting')}</span>{' '}
                              {t('work.prerequisiteReason', { reason: tk.prerequisite.reason })}
                            </div>
                            <div className="row__sub">
                              {t('work.prerequisiteTargets', { targets: tk.prerequisite.conditions.map((condition: { description: string }) => condition.description).join(' / ') })}
                            </div>
                            {tk.prerequisite.deadline_at && (
                              <div className="row__sub">
                                {t('work.prerequisiteDeadline', { time: new Date(tk.prerequisite.deadline_at).toLocaleString(locale) })}
                              </div>
                            )}
                            <div className="btn-row mt-10">
                              <button
                                type="button"
                                className="btn"
                                disabled={operationPending}
                                onClick={() => void runWorkOperation(() => resumeTaskPrerequisite(tk.id))}
                              >
                                {t('work.prerequisiteResume')}
                              </button>
                            </div>
                          </>
                        )}
                        {tk.status === 'judgement_waiting' && tk.stop_reason && (
                          <div className="row__sub">{t('work.stopReason', { reason: tk.stop_reason })}</div>
                        )}
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

          {assuranceError && <p className="error" role="alert">{t('work.assuranceLoadError')}</p>}
          <WorkAssurancePanel assurance={assurance} t={t} />

          {/* Design documents (hidden by the section itself when there are none) */}
          <DesignDocumentsSection
            workId={work.id}
            refreshToken={designsRefreshToken}
            now={now}
            locale={locale}
            t={t}
          />
          <WorkSummaryHistory workId={work.id} refreshToken={designsRefreshToken} now={now} locale={locale} t={t} />
          <WorkBacklogSection workId={work.id} dismissed={work.advisor_backlog?.dismissed ?? []}refreshToken={designsRefreshToken} t={t} />
          <WorkPostMergeEvents workId={work.id} refreshToken={designsRefreshToken} />

          {/* Deliverables */}
          <section className="panel" aria-labelledby="sec-deliverables">
            <h2 className="panel__title" id="sec-deliverables">
              {t('work.deliverables')} <span className="count">{deliverables.length}</span>
            </h2>
            {deliverables.length === 0 ? (
              <p className="empty">{t('work.noDeliverables')}</p>
            ) : (
              <div className="list panel__scroll">
                {deliverables.map((item) => (
                  <div className="row" key={item.file}>
                    <div className="row__main">
                      <div className="row__title mono">{item.file}</div>
                      <div className="row__sub">
                        {[item.action, taskTitle(item.task_id)].filter((part) => part.length > 0).join(' · ')}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Worker Report */}
          <section className="panel" aria-labelledby="sec-reports">
            <h2 className="panel__title" id="sec-reports">
              {t('work.workerReport')} <span className="count">{reports.length}</span>
            </h2>
            {reports.length === 0 ? (
              <p className="empty">{t('work.noReports')}</p>
            ) : (
              <div className="list panel__scroll">
                {[...reports].reverse().map((rep) => (
                  <ReportCard key={rep.id} report={rep} run={runById.get(rep.agent_run_id)} labelFn={label} now={now} locale={locale} t={t} />
                ))}
              </div>
            )}
          </section>

          {/* Decisions */}
          <section className="panel" aria-labelledby="sec-decisions">
            <h2 className="panel__title" id="sec-decisions">
              {t('work.decisions')} <span className="count">{decisions.length}</span>
            </h2>
            {decisions.length === 0 ? (
              <p className="empty">{t('work.noDecisions')}</p>
            ) : (
              <div className="list panel__scroll">
                {decisions.map((d) => {
                  const badge =
                    d.status === 'open' ? 'badge badge--amber' : d.status === 'resolved' ? 'badge badge--green' : 'badge badge--red';
                  const text = d.status === 'open' ? t('work.statusOpen') : d.status === 'resolved' ? t('work.statusResolved') : t('work.statusCancelled');
                  return (
                    <Link
                      key={d.id}
                      href={`/decision?id=${encodeURIComponent(d.id)}`}
                      className={`row${d.status === 'open' ? ' row--warn' : ''}`}
                    >
                      <span className={`dot ${d.status === 'open' ? 'dot--amber' : 'dot--done'}`} />
                      <div className="row__main">
                        <div className="row__title row__title--wrap">{d.question || d.reason}</div>
                        {d.question && <div className="row__sub">{d.reason.split('\n')[0]}</div>}
                        <div className="row__sub">
                          {t('work.scope')}: {d.scope} · {t('work.optionCount', { count: String(d.options.length) })} · {t('work.recommended')}:{' '}
                          {d.options.find((o) => o.key === d.recommended)?.label ?? t('work.recommendedNone')}
                        </div>
                      </div>
                      <div className="row__end">
                        <span className={badge}>{text}</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <aside>
          {/* Manager */}
          <section className="panel" aria-labelledby="sec-manager">
            <h2 className="panel__title" id="sec-manager">
              {t('work.manager')}
            </h2>
            {latestManager ? (
              <dl className="kv">
                <dt>{t('work.assignee')}</dt>
                <dd>{label(latestManager)}</dd>
                <dt>{t('work.model')}</dt>
                <dd className="mono">{latestManager.model}</dd>
                <dt>{t('work.status')}</dt>
                <dd><AgentStatusBadge status={latestManager.status} outcome={latestManager.outcome} origin={latestManager.origin} /></dd>
                <dt>{t('work.lastActivity')}</dt>
                <dd>{formatRelative(latestManager.ended_at ?? latestManager.started_at, now, locale)}</dd>
              </dl>
            ) : (
              <p className="empty">{t('work.noManager')}</p>
            )}
          </section>

          {/* Active Agents */}
          <section className="panel" aria-labelledby="sec-agents">
            <h2 className="panel__title" id="sec-agents">
              {t('work.activeAgents')}
            </h2>
            {liveRuns.length === 0 && coreActivities.length === 0 ? (
              <p className="empty">{t('work.noActiveAgents')}</p>
            ) : (
              <div className="list panel__scroll">
                <CoreActivityRows activities={coreActivities} workNumber={displayNumber} now={now} t={t} />
                {liveRuns.map((r) => (
                  <div className="row row--running" key={r.id}>
                    <span className="dot dot--running" />
                    <div className="row__main">
                      <div className="row__title">{label(r)}</div>
                      <div className="row__sub">
                        {r.task_id ? taskTitle(r.task_id) : roleDisplayName(r.role, locale)}
                        {' · '}
                        {formatRelative(r.started_at, now, locale)}{t('work.launchedAt')}
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

          {/* Agent History */}
          <section className="panel" aria-labelledby="sec-history">
            <h2 className="panel__title" id="sec-history">
              {t('work.agentHistory')} <span className="count">{runs.length}</span>
            </h2>
            <div className="list panel__scroll">
              {history.map((r) => (
                <div className="row" key={r.id}>
                  <div className="row__main">
                    <div className="row__title">{label(r)}</div>
                    <div className="row__sub">
                      {taskTitle(r.task_id)} · {formatRelative(r.started_at, now, locale)}
                    </div>
                  </div>
                  <div className="row__end">
                    <AgentStatusBadge status={r.status} outcome={r.outcome} origin={r.origin} />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}

function WorkLoadError({ message, onRetry, t }: { message: string; onRetry: () => void; t: TFunction }) {
  return (
    <section className="panel mt-10" aria-label={message}>
      <div className="error" role="alert">{message}</div>
      <div className="btn-row mt-10">
        <button type="button" className="btn" onClick={onRetry}>{t('work.retry')}</button>
        <Link className="btn" href="/board">{t('common.backToBoard')}</Link>
      </div>
    </section>
  );
}

function ReportCard({
  report,
  run,
  labelFn,
  now,
  locale,
  t,
}: {
  report: Report;
  run: AgentRun | undefined;
  labelFn: (run: AgentRun) => string;
  now: number;
  locale: Locale;
  t: TFunction;
}) {
  const env = asReportEnvelope(report.payload);
  const changes = env.changes.flatMap((change, index) => {
    const file = typeof change.file === 'string' ? change.file.trim() : '';
    const action = typeof change.action === 'string' ? change.action.trim() : '';
    return file || action ? [{ key: `${index}-${file}`, file, action }] : [];
  });
  const fallbackSummary = conciseWorkerSummary(env.work_done);
  return (
    <article className="report">
      <div className="report__head">
        <span className="report__label">{run ? labelFn(run) : report.agent_run_id}</span>
        <ResultBadge result={report.result} />
        {env.needs_replanning && <span className="badge badge--amber">{t('work.replanRequired')}</span>}
        <span className="card__spacer" />
        <span className="note">{formatRelative(report.created_at, now, locale)}</span>
      </div>
      <div className="report__body">
        <strong>{t('work.reportSummary')}</strong>
        <ul>
          {changes.length > 0 ? (
            changes.map((change) => (
              <li key={change.key}>
                {change.file && <code>{change.file}</code>}
                {change.file && change.action ? ' — ' : ''}
                {clipReportText(change.action)}
              </li>
            ))
          ) : (
            <li>{fallbackSummary || t('work.noBody')}</li>
          )}
        </ul>
        <details className="report__details">
          <summary>{t('work.fullReport')}</summary>
          <div className="report__details-body">
            <p>{env.work_done || t('work.noBody')}</p>
            <p>
              <strong>{t('work.workerCheck')}</strong>{' '}
              {env.verification.passed ? t('work.checkPassed') : t('work.checkNotPassed')}
            </p>
            {env.verification.method && (
              <p>
                <strong>{t('work.verificationMethod')}</strong> {env.verification.method}
              </p>
            )}
          </div>
        </details>
        {env.remaining_issues.length > 0 && (
          <>
            <p>
              <strong>{t('work.remainingIssues')}</strong>
            </p>
            <ul>
              {env.remaining_issues.map((issue, i) => (
                <li key={i}>
                  {issue.issue}
                  {issue.impact && (
                    <div className="note">
                      {t('work.issueImpact')} {issue.impact}
                    </div>
                  )}
                  {issue.next_step && (
                    <div className="note">
                      {t('work.issueNextStep')} {issue.next_step}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {env.next_action && (
          <p>
            <strong>{t('work.nextAction')}</strong> {env.next_action}
          </p>
        )}
        {env.question_for_manager && (
          <p>
            <strong>{t('work.questionForManager')}</strong> {env.question_for_manager}
          </p>
        )}
      </div>
    </article>
  );
}

function conciseWorkerSummary(value: string): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  if (!compact) return '';
  const sentenceEnd = compact.search(/[。.!?](?:\s|$)/u);
  const firstSentence = sentenceEnd >= 0 ? compact.slice(0, sentenceEnd + 1) : compact;
  return clipReportText(firstSentence);
}

function clipReportText(value: string, maxLength = 180): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}
