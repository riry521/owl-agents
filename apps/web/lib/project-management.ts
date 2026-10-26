import type {
  Project,
  ProjectDeletionImpact,
  ProjectRunningWork,
  TestRunInput,
  TestSetupInvestigationState,
  TestSetupView,
  UpdateProjectInput,
} from '@/lib/types';

/** auto = test_run null; command = { mode: whole, whole_argv }; off = { mode: off }; custom = a setting the form cannot express (per_file, extra keys), kept as is. */
export type TestRunMode = 'auto' | 'command' | 'off' | 'custom';

export type ProjectEditForm = { name: string; path: string; autoPush: boolean; advisorWindowEnabled?: boolean; commitLanguage?: 'ja' | 'en' | null; setupCommand: string; refreshCommand: string; postMergeCommand: string; postMergeDisabled: boolean; installCommand: string; installDisabled: boolean; testRunMode?: TestRunMode; testRunCommand?: string };

function testRunFormValue(testRun: TestRunInput | null | undefined): { mode: TestRunMode; command: string } {
  if (testRun == null) return { mode: 'auto', command: '' };
  const keys = Object.keys(testRun);
  if (testRun.mode === 'off' && keys.length === 1) return { mode: 'off', command: '' };
  if (testRun.mode === 'whole' && Array.isArray(testRun.whole_argv) && keys.every((key) => key === 'mode' || key === 'whole_argv')) {
    return { mode: 'command', command: formatCommandLine(testRun.whole_argv) };
  }
  return { mode: 'custom', command: '' };
}

export function isProjectAutoPushEnabled(project: Project): boolean {
  return project.auto_push === true;
}

export function projectEditForm(project: Project): ProjectEditForm {
  return {
    name: project.name,
    path: project.canonical_path,
    autoPush: isProjectAutoPushEnabled(project),
    advisorWindowEnabled: project.advisor_window_enabled === true,
    commitLanguage: project.commit_language ?? null,
    setupCommand: formatCommandLine(project.worktree_setup_command ?? []),
    refreshCommand: formatCommandLine(project.worktree_refresh_command ?? []),
    postMergeCommand: formatCommandLine(project.post_merge_command ?? []),
    postMergeDisabled: project.post_merge_command?.length === 0,
    installCommand: formatCommandLine(project.post_merge_install_command ?? []),
    installDisabled: project.post_merge_install_command?.length === 0,
    testRunMode: testRunFormValue(project.test_run).mode,
    testRunCommand: testRunFormValue(project.test_run).command,
  };
}

/** Placeholder for the post-merge field: the default command shows only while the project has no setting. */
export function postMergeCommandPlaceholder(project: Project): { kind: 'default'; command: string } | { kind: 'none' } {
  const effective = project.effective_post_merge_command ?? [];
  return project.post_merge_command == null && effective.length > 0 ? { kind: 'default', command: formatCommandLine(effective) } : { kind: 'none' };
}

/** Splits a command line into argv the way a POSIX shell would for plain words and quotes, without expansions. */
export function parseCommandLine(text: string): string[] | null {
  const args: string[] = [];
  let current = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '\\' && (text[index + 1] === '"' || text[index + 1] === '\\')) current += text[++index];
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === '\\') {
      if (index + 1 >= text.length) return null;
      current += text[++index];
      inWord = true;
    } else if (/\s/u.test(char)) {
      if (inWord) args.push(current);
      current = '';
      inWord = false;
    } else {
      current += char;
      inWord = true;
    }
  }
  if (quote !== null) return null;
  if (inWord) args.push(current);
  return args;
}

export function formatCommandLine(argv: readonly string[]): string {
  return argv
    .map((arg) => (arg !== '' && /^[\w@%+=:,./-]+$/u.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`))
    .join(' ');
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((arg, index) => arg === right[index]);
}

export function buildProjectUpdateInput(
  project: Project,
  form: ProjectEditForm,
): UpdateProjectInput | null | { error: 'nameRequired' | 'pathRequired' | 'commandInvalid' | 'testCommandRequired' } {
  const name = form.name.trim();
  if (!name) return { error: 'nameRequired' };
  if (!form.path.trim()) return { error: 'pathRequired' };
  const setupCommand = parseCommandLine(form.setupCommand ?? '');
  const refreshCommand = parseCommandLine(form.refreshCommand ?? '');
  // Blank = null (use the default), disabled toggle = [], text = argv.
  const postMergeText = (form.postMergeCommand ?? '').trim();
  const postMergeCommand = form.postMergeDisabled ? [] : postMergeText === '' ? null : parseCommandLine(postMergeText);
  const installText = (form.installCommand ?? '').trim();
  const installCommand = form.installDisabled ? [] : installText === '' ? null : parseCommandLine(installText);
  if (setupCommand === null || refreshCommand === null || (postMergeCommand === null && postMergeText !== '' && !form.postMergeDisabled) || (installCommand === null && installText !== '' && !form.installDisabled)) return { error: 'commandInvalid' };

  // A form without a test_run choice, or "custom", leaves the stored setting alone.
  const testRunMode = form.testRunMode ?? 'custom';
  const testRunCommand = testRunMode === 'command' ? parseCommandLine(form.testRunCommand ?? '') : null;
  if (testRunMode === 'command' && testRunCommand === null) return { error: 'commandInvalid' };
  if (testRunMode === 'command' && testRunCommand?.length === 0) return { error: 'testCommandRequired' };

  const input: UpdateProjectInput = {};
  if (name !== project.name) input.name = name;
  if (form.path !== project.canonical_path) input.canonical_path = form.path;
  const autoPush = form.autoPush === true;
  if (autoPush !== isProjectAutoPushEnabled(project)) input.auto_push = autoPush;
  if (form.advisorWindowEnabled !== undefined && form.advisorWindowEnabled !== (project.advisor_window_enabled === true)) input.advisor_window_enabled = form.advisorWindowEnabled;
  // A form without a commitLanguage choice leaves the stored setting alone.
  if (form.commitLanguage !== undefined && form.commitLanguage !== (project.commit_language ?? null)) input.commit_language = form.commitLanguage;
  if (!sameArgv(setupCommand, project.worktree_setup_command ?? [])) input.worktree_setup_command = setupCommand;
  if (!sameArgv(refreshCommand, project.worktree_refresh_command ?? [])) input.worktree_refresh_command = refreshCommand;
  const currentPostMerge = project.post_merge_command ?? null;
  const postMergeChanged = postMergeCommand === null || currentPostMerge === null ? postMergeCommand !== currentPostMerge : !sameArgv(postMergeCommand, currentPostMerge);
  if (postMergeChanged) input.post_merge_command = postMergeCommand;
  const currentInstall = project.post_merge_install_command ?? null;
  const installChanged = installCommand === null || currentInstall === null ? installCommand !== currentInstall : !sameArgv(installCommand, currentInstall);
  if (installChanged) input.post_merge_install_command = installCommand;
  const currentTestRun = testRunFormValue(project.test_run);
  if (testRunMode !== 'custom' && (testRunMode !== currentTestRun.mode || (testRunMode === 'command' && formatCommandLine(testRunCommand ?? []) !== currentTestRun.command))) {
    input.test_run = testRunMode === 'auto' ? null : testRunMode === 'off' ? { mode: 'off' } : { mode: 'whole', whole_argv: testRunCommand ?? [] };
  }
  return Object.keys(input).length ? input : null;
}

/** How often the edit form re-reads the Project list while an investigation runs, and when it stops waiting. */
export const INVESTIGATE_POLL_INTERVAL_MS = 3000;
export const INVESTIGATE_POLL_TIMEOUT_MS = 10 * 60 * 1000;

/** Why not read investigated_at: a run that ends without saving a record (not a git checkout, an error) leaves it unchanged, so only the server knows the run ended. */
export function investigateOutcome(state: TestSetupInvestigationState): { state: 'pending' } | { state: 'done' } | { state: 'failed'; reason: string } {
  if (state.running) return { state: 'pending' };
  const { outcome } = state;
  if (!outcome) return { state: 'failed', reason: 'unknown' };
  if (!outcome.saved) return { state: 'failed', reason: outcome.reason ?? 'unknown' };
  return outcome.status === 'ready' ? { state: 'done' } : { state: 'failed', reason: outcome.status ?? 'unknown' };
}

export type DeletionDialogModel =
  | { variant: 'empty' }
  | { variant: 'withWorks'; workCount: number; backlogCount: number }
  | { variant: 'blocked'; runningWorks: ProjectRunningWork[]; hiddenRunningCount: number; activeAgentCount: number };

export function deletionDialogModel(impact: ProjectDeletionImpact): DeletionDialogModel {
  if (!impact.deletable) {
    return {
      variant: 'blocked',
      runningWorks: impact.running_works,
      hiddenRunningCount: impact.running_work_count - impact.running_works.length,
      activeAgentCount: impact.active_agent_count,
    };
  }
  if (impact.work_count === 0) return { variant: 'empty' };
  return { variant: 'withWorks', workCount: impact.work_count, backlogCount: impact.backlog_item_count };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isProjectRunningWork(value: unknown): value is ProjectRunningWork {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.display_number === null || (typeof value.display_number === 'number' && Number.isSafeInteger(value.display_number)))
    && typeof value.title === 'string'
    && (value.state === 'running' || value.state === 'paused' || value.state === 'judgement_waiting');
}

function isProjectDeletionImpact(value: unknown): value is ProjectDeletionImpact {
  return isRecord(value)
    && typeof value.project_id === 'string'
    && isNonNegativeInteger(value.work_count)
    && isNonNegativeInteger(value.running_work_count)
    && isNonNegativeInteger(value.active_agent_count)
    && isNonNegativeInteger(value.backlog_item_count)
    && Array.isArray(value.running_works)
    && value.running_works.every(isProjectRunningWork)
    && Array.isArray(value.blockers)
    && value.blockers.every((blocker) => blocker === 'running_works' || blocker === 'active_agents')
    && typeof value.deletable === 'boolean';
}

export function impactFromError(error: unknown): ProjectDeletionImpact | null {
  if (!isRecord(error)) return null;
  const code = typeof error.code === 'string' ? error.code : error.message;
  if (code !== 'project_has_running_works' && code !== 'project_deletion_impact_changed') return null;
  const details = error.details;
  if (!isRecord(details) || !isProjectDeletionImpact(details.impact)) return null;
  return details.impact;
}

/** i18n key shown after the re-investigate button: accepted when error is null, the 409 reason for test_setup_unavailable, otherwise the generic Project error. */
export function investigateNoticeKey(error: unknown): string {
  if (error === null) return 'projects.testSetupInvestigateAccepted';
  const record = isRecord(error) ? error : {};
  const details = isRecord(record.details) ? record.details : {};
  if (record.code === 'test_setup_unavailable' && typeof details.reason === 'string') return `projects.testSetupInvestigateUnavailable_${details.reason}`;
  return projectErrorKey(error, 'load');
}

export function projectErrorKey(error: unknown, context: 'load' | 'edit' | 'delete'): string {
  const record = isRecord(error) ? error : {};
  const code = typeof record.code === 'string'
    ? record.code
    : typeof record.message === 'string' ? record.message : '';
  const details = isRecord(record.details) ? record.details : {};

  switch (code) {
    case 'validation_error': {
      const inspection = isRecord(details.inspection) ? details.inspection : {};
      if (context === 'edit' && (inspection.kind === 'not_git' || inspection.kind === 'git_needs_initial_commit')) {
        return 'projects.editNeedsGit';
      }
      if (context === 'edit' && typeof details.project_id === 'string') return 'projects.errorDuplicate';
      return 'projects.errorValidation';
    }
    case 'project_path_conflict':
      return context === 'delete' ? 'projects.errorDefault' : 'projects.errorDuplicate';
    case 'project_has_running_works':
      if (context === 'edit') return 'projects.editBlocked';
      if (context === 'delete') return 'projects.deleteBlocked';
      return 'projects.errorDefault';
    case 'project_deletion_impact_changed':
      return context === 'delete' ? 'projects.deleteImpactChanged' : 'projects.errorDefault';
    case 'project_not_found':
      return 'projects.errorNotFound';
    case 'worktree_cleanup_failed':
      return context === 'delete' ? 'projects.errorCleanupFailed' : 'projects.errorDefault';
    case 'network_error':
    case 'runtime_config_unavailable':
      return 'projects.errorNetwork';
    case 'invalid_runtime_config':
    case 'invalid_response':
      return 'projects.errorInvalidResponse';
    default:
      return 'projects.errorDefault';
  }
}
