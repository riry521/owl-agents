import { isAgentOutcome } from './agent-run-display.mjs';

/**
 * @typedef {import('./types').WorkDetailView} WorkDetailView
 * @typedef {import('./types').WorkState} WorkState
 */

function isRecord(value) {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function stringOr(value, fallback = '') {
  return typeof value === 'string' ? value : typeof fallback === 'string' ? fallback : '';
}

function finiteNumberOr(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nonNegativeIntegerOr(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function nullableString(value) {
  return typeof value === 'string' ? value : null;
}

function normalizeAdvisorBacklogEntries(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.problem === 'string')
    .map((entry) => ({
      id: entry.id,
      file: nullableString(entry.file),
      line: Number.isInteger(entry.line) ? entry.line : null,
      problem: entry.problem,
    }));
}

function normalizeAdvisorBacklog(value) {
  if (!value || typeof value !== 'object') return null;
  return { linked: normalizeAdvisorBacklogEntries(value.linked), dismissed: normalizeAdvisorBacklogEntries(value.dismissed) };
}

/**
 * remaining_issues as {issue, impact, next_step}. Reports written before the
 * template hold plain strings; those become an issue with no detail.
 * @param {unknown} value
 * @returns {import('./types').RemainingIssue[]}
 */
export function normalizeRemainingIssues(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') return item.trim() ? [{ issue: item.trim(), impact: '', next_step: '' }] : [];
    if (!isRecord(item) || typeof item.issue !== 'string' || !item.issue.trim()) return [];
    return [{ issue: item.issue.trim(), impact: stringOr(item.impact).trim(), next_step: stringOr(item.next_step).trim() }];
  });
}

/**
 * verification as {passed, method}; method is '' for reports written before
 * the template (or when absent).
 * @param {unknown} value
 * @returns {import('./types').ReportVerification}
 */
export function normalizeVerification(value) {
  const source = isRecord(value) ? value : {};
  // Schema 1.1.0 reports carry status; stored 1.0.0 reports carry passed.
  const passed = source.status === undefined ? source.passed === true : source.status === 'passed';
  return { passed, method: stringOr(source.method).trim() };
}

/**
 * Best-effort read of an arbitrary report payload as a ReportEnvelope.
 * Invalid collection members are dropped so a malformed report cannot crash
 * the Work detail render path.
 * @param {unknown} payload
 * @returns {import('./types').ReportEnvelope}
 */
export function asReportEnvelope(payload) {
  try {
    const source = isRecord(payload) ? payload : {};
    const result = source.result;
    return {
      schema_version: '1.0.0',
      invocation_id: stringOr(source.invocation_id),
      result: result === 'success' || result === 'failed' || result === 'partial' ? result : 'unknown',
      work_done: stringOr(source.work_done),
      changes: Array.isArray(source.changes) ? source.changes.filter(isRecord) : [],
      verification: normalizeVerification(source.verification),
      remaining_issues: normalizeRemainingIssues(source.remaining_issues),
      next_action: stringOr(source.next_action),
      needs_replanning: source.needs_replanning === true,
      question_for_manager: typeof source.question_for_manager === 'string' ? source.question_for_manager : null,
    };
  } catch (error) {
    console.error('[work-detail-safety] Could not normalize report envelope', error);
    // An unreadable report must not look like a success.
    return {
      schema_version: '1.0.0',
      invocation_id: '',
      result: 'failed',
      work_done: '',
      changes: [],
      verification: { passed: false, method: '' },
      remaining_issues: [],
      next_action: '',
      needs_replanning: false,
      question_for_manager: null,
    };
  }
}

function normalizeTasks(value, workId) {
  if (!Array.isArray(value)) return [];
  return value.filter((task) => isRecord(task) && typeof task.id === 'string' && task.id.trim().length > 0).map((task) => {
    const id = task.id;
    return {
      id,
      work_id: stringOr(task.work_id, workId),
      title: stringOr(task.title, id),
      status: stringOr(task.status, 'unknown'),
      type: stringOr(task.type),
      state_version: finiteNumberOr(task.state_version),
      updated_at: stringOr(task.updated_at),
      created_at: stringOr(task.created_at),
      depends_on: Array.isArray(task.depends_on) ? task.depends_on.filter((dep) => typeof dep === 'string') : [],
      prerequisite: normalizePrerequisite(task.prerequisite),
      stop_reason: nullableString(task.stop_reason),
    };
  });
}

function normalizePrerequisite(value) {
  if (!isRecord(value)) return null;
  return {
    reason: stringOr(value.reason),
    conditions: Array.isArray(value.conditions)
      ? value.conditions.filter(isRecord).map((condition) => ({
        kind: stringOr(condition.kind),
        target: nullableString(condition.target),
        description: stringOr(condition.description),
      }))
      : [],
    deadline_at: stringOr(value.deadline_at),
    since: nullableString(value.since),
  };
}

function normalizeRuns(value, workId) {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((run, index) => ({
    id: stringOr(run.id, `${workId}-run-${index}`),
    work_id: nullableString(run.work_id),
    task_id: nullableString(run.task_id),
    role: stringOr(run.role, 'unknown'),
    provider: stringOr(run.provider),
    model: stringOr(run.model),
    effort: nullableString(run.effort),
    status: stringOr(run.status, 'unknown'),
    outcome: isAgentOutcome(run.outcome) ? run.outcome : null,
    pid: typeof run.pid === 'number' && Number.isFinite(run.pid) ? run.pid : null,
    started_at: nullableString(run.started_at),
    ended_at: nullableString(run.ended_at),
    last_output_at: nullableString(run.last_output_at),
    parent_agent_id: nullableString(run.parent_agent_id),
    child_run_id: nullableString(run.child_run_id),
    phase: run.phase === 'plan' || run.phase === 'executing' || run.phase === 'verdict' ? run.phase : null,
    subtask_count: Number.isInteger(run.subtask_count) && run.subtask_count >= 0 ? run.subtask_count : null,
    label: nullableString(run.label),
    origin: run.origin === 'spawned' || run.origin === 'observed' ? run.origin : null,
  }));
}

function normalizeChildRunSummary(value) {
  if (!isRecord(value) || !['succeeded', 'partial', 'failed'].includes(value.result)) return null;
  const failure = isRecord(value.failure) && typeof value.failure.kind === 'string'
    ? { kind: value.failure.kind, reason: stringOr(value.failure.reason) }
    : null;
  return {
    result: value.result,
    summary: stringOr(value.summary),
    changed_files: Array.isArray(value.changed_files) ? value.changed_files.filter((item) => typeof item === 'string') : [],
    checks: Array.isArray(value.checks)
      ? value.checks.filter((item) => isRecord(item) && typeof item.command === 'string').map((item) => ({ command: item.command, passed: item.passed === true }))
      : [],
    remaining_issues: Array.isArray(value.remaining_issues) ? value.remaining_issues.filter((item) => typeof item === 'string') : [],
    failure,
    attempts: nonNegativeIntegerOr(value.attempts),
    duration_seconds: Math.max(0, finiteNumberOr(value.duration_seconds)),
    report_format: value.report_format === 'fallback' ? 'fallback' : 'structured',
  };
}

function normalizeChildRuns(value, workId) {
  if (!Array.isArray(value)) return [];
  return value.filter((run) => isRecord(run) && typeof run.id === 'string').map((run, index) => ({
    id: run.id,
    work_id: stringOr(run.work_id, workId),
    task_id: stringOr(run.task_id),
    parent_agent_run_id: stringOr(run.parent_agent_run_id),
    seq: nonNegativeIntegerOr(run.seq),
    title: stringOr(run.title, `Child ${index + 1}`),
    instruction: stringOr(run.instruction),
    write_paths: Array.isArray(run.write_paths) ? run.write_paths.filter((item) => typeof item === 'string') : [],
    provider: run.provider === 'codex' ? 'codex' : 'claude',
    model: stringOr(run.model),
    effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(run.effort) ? run.effort : null,
    timeout_ms: nonNegativeIntegerOr(run.timeout_ms),
    max_attempts: nonNegativeIntegerOr(run.max_attempts),
    attempt: nonNegativeIntegerOr(run.attempt),
    status: typeof run.status === 'string' ? run.status : 'failed',
    blocked_reason: nullableString(run.blocked_reason),
    current_agent_run_id: nullableString(run.current_agent_run_id),
    summary: normalizeChildRunSummary(run.summary),
    report_text: nullableString(run.report_text),
    failure_kind: nullableString(run.failure_kind),
    failure_reason: nullableString(run.failure_reason),
    created_at: stringOr(run.created_at),
    started_at: nullableString(run.started_at),
    finished_at: nullableString(run.finished_at),
    updated_at: stringOr(run.updated_at),
  }));
}

function normalizeReports(value, workId) {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((report, index) => {
    const payload = isRecord(report.payload) ? report.payload : {};
    return {
      id: stringOr(report.id, `${workId}-report-${index}`),
      agent_run_id: stringOr(report.agent_run_id),
      schema_version: stringOr(report.schema_version, '1.0.0'),
      result: stringOr(report.result, 'unknown'),
      payload: {
        ...payload,
        changes: Array.isArray(payload.changes) ? payload.changes.filter(isRecord) : [],
        remaining_issues: normalizeRemainingIssues(payload.remaining_issues),
        verification: normalizeVerification(payload.verification),
      },
      created_at: stringOr(report.created_at),
    };
  });
}

function normalizeDecisions(value, workId) {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((decision, index) => ({
    id: stringOr(decision.id, `${workId}-decision-${index}`),
    work_id: stringOr(decision.work_id, workId),
    scope: stringOr(decision.scope, 'work'),
    status: stringOr(decision.status, 'unknown'),
    reason: stringOr(decision.reason),
    question: stringOr(decision.question),
    current_state: stringOr(decision.current_state),
    tried: stringOr(decision.tried),
    options: Array.isArray(decision.options)
      ? decision.options.filter(isRecord).map((option, optionIndex) => ({
          key: stringOr(option.key, `option-${optionIndex}`),
          label: stringOr(option.label, stringOr(option.key, `Option ${optionIndex + 1}`)),
          ...(typeof option.description === 'string' ? { description: option.description } : {}),
        }))
      : [],
    recommended: nullableString(decision.recommended),
    allow_free_text: decision.allow_free_text === true,
    blocked_task_ids: Array.isArray(decision.blocked_task_ids)
      ? decision.blocked_task_ids.filter((id) => typeof id === 'string')
      : [],
    state_version: finiteNumberOr(decision.state_version),
  }));
}

function normalizeMessages(value, workId) {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((message, index) => ({
    id: stringOr(message.id, `${workId}-message-${index}`),
    conversation_id: stringOr(message.conversation_id),
    source: stringOr(message.source, 'unknown'),
    body: stringOr(message.body),
    attachment_ids: Array.isArray(message.attachment_ids)
      ? message.attachment_ids.filter((id) => typeof id === 'string')
      : [],
    created_at: stringOr(message.created_at),
  }));
}

function normalizeProgress(value, tasks, state) {
  if (isRecord(value)) {
    const total = value.total_tasks;
    const completed = value.completed_tasks;
    if (
      Number.isSafeInteger(total) && total >= 0 &&
      Number.isSafeInteger(completed) && completed >= 0 && completed <= total
    ) {
      return {
        total_tasks: total,
        completed_tasks: completed,
        percent: total === 0 ? 0 : Math.round((completed / total) * 100),
      };
    }
  }

  // Same rule as Core: Tasks superseded by a replan are not part of the plan.
  const counted = state === 'cancelled' ? tasks : tasks.filter((task) => task.status !== 'cancelled');
  const total = counted.length;
  const completed = counted.filter((task) => task.status === 'completed').length;
  return {
    total_tasks: total,
    completed_tasks: completed,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
}

/**
 * Normalize the aggregate from getWorkDetail before React renders it. Bad
 * optional collections are treated as empty, and absent Work fields receive
 * safe display values so a partial Core response remains inspectable.
 * @param {unknown} value
 * @param {string} requestedWorkId
 * @returns {WorkDetailView}
 */
function normalizeWorkDetailDataUnsafe(value, requestedWorkId) {
  const source = isRecord(value) ? value : {};
  const rawWork = isRecord(source.work) ? source.work : {};
  const id = stringOr(rawWork.id, requestedWorkId) || requestedWorkId || 'unknown-work';
  const rawTitle = stringOr(rawWork.title);
  const title = rawTitle.trim().length > 0 ? rawTitle : id || 'Work';
  const rawState = stringOr(rawWork.state);
  const state = rawState.trim().length > 0 ? rawState : 'unknown';
  const rawSummary = stringOr(rawWork.summary);
  const summary = rawSummary.trim().length > 0 ? rawSummary : '';
  const rawOwnerId = stringOr(rawWork.owner_id);
  const size = rawWork.size === 'small' || rawWork.size === 'normal' || rawWork.size === 'large'
    ? rawWork.size
    : 'normal';
  const tasks = normalizeTasks(source.tasks, id);

  return {
    work: {
      id,
      display_number: typeof rawWork.display_number === 'number' && Number.isFinite(rawWork.display_number)
        ? rawWork.display_number
        : null,
      title,
      state: /** @type {WorkState} */ (state),
      state_version: nonNegativeIntegerOr(rawWork.state_version),
      updated_at: stringOr(rawWork.updated_at),
      archived_at: nullableString(rawWork.archived_at),
      owner_id: rawOwnerId.trim().length > 0 ? rawOwnerId : '—',
      project_id: nullableString(rawWork.project_id),
      summary,
      size,
      design_mode: rawWork.design_mode === 'lead' ? 'lead' : 'auto',
      plan_revision: nonNegativeIntegerOr(rawWork.plan_revision),
      progress: normalizeProgress(rawWork.progress, tasks, state),
      conversation_id: nullableString(rawWork.conversation_id),
      advisor_backlog: normalizeAdvisorBacklog(rawWork.advisor_backlog),
    },
    tasks: /** @type {WorkDetailView['tasks']} */ (tasks),
    runs: normalizeRuns(source.runs, id),
    child_runs: normalizeChildRuns(source.child_runs, id),
    reports: normalizeReports(source.reports, id),
    decisions: normalizeDecisions(source.decisions, id),
    messages: normalizeMessages(source.messages, id),
  };
}

/**
 * Normalize an arbitrary detail aggregate into the stable view shape. Even
 * hostile or malformed objects fall back to an empty, renderable Work rather
 * than leaking bad field types into the React tree.
 * @param {unknown} value
 * @param {unknown} requestedWorkId
 * @returns {WorkDetailView}
 */
export function normalizeWorkDetailData(value, requestedWorkId = 'unknown-work') {
  const id = typeof requestedWorkId === 'string' && requestedWorkId.trim().length > 0
    ? requestedWorkId
    : 'unknown-work';
  try {
    return normalizeWorkDetailDataUnsafe(value, id);
  } catch {
    return {
      work: {
        id,
        display_number: null,
        title: id,
        state: /** @type {WorkState} */ ('unknown'),
        state_version: 0,
        updated_at: '',
        archived_at: null,
        owner_id: '—',
        project_id: null,
        summary: '',
        size: 'normal',
        design_mode: 'auto',
        plan_revision: 0,
        progress: { total_tasks: 0, completed_tasks: 0, percent: 0 },
        conversation_id: null,
        advisor_backlog: null,
      },
      tasks: [],
      runs: [],
      child_runs: [],
      reports: [],
      decisions: [],
      messages: [],
    };
  }
}

/** Build the detail URL used by Board rows. Missing IDs open the route's visible not-found state. @param {unknown} id */
export function workDetailHref(id) {
  if (typeof id !== 'string' || id.trim().length === 0) return '/work';
  return `/work?id=${encodeURIComponent(id)}`;
}

/**
 * Convert a frontend/API code into a localized Work detail error.
 * @param {unknown} error
 * @param {(key: string) => string} t
 */
export function humanizeWorkDetailError(error, t) {
  const kind = isRecord(error) && typeof error.kind === 'string' ? error.kind : '';
  if (kind === 'network_error') return t('work.errorNetwork');
  if (kind === 'bad_data') return t('work.errorInvalidResponse');
  if (kind === 'server_error' || kind === 'not_found') return t('work.errorDefault');
  const code = isRecord(error) && typeof error.code === 'string'
    ? error.code
    : error instanceof Error ? error.message : '';
  switch (code) {
    case 'network_error':
    case 'request_timeout':
    case 'runtime_config_unavailable':
    case 'core_not_ready':
    case 'dependency_unavailable':
      return t('work.errorNetwork');
    case 'invalid_runtime_config':
    case 'invalid_response':
    case 'invalid_query':
    case 'contract_invalid':
      return t('work.errorInvalidResponse');
    case 'version_conflict':
      return t('work.errorVersionConflict');
    default:
      return t('work.errorDefault');
  }
}
