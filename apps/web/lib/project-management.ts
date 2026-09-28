import type {
  Project,
  ProjectDeletionImpact,
  ProjectRunningWork,
  UpdateProjectInput,
} from '@/lib/types';

export type ProjectEditForm = { name: string; path: string };

export function buildProjectUpdateInput(
  project: Project,
  form: ProjectEditForm,
): UpdateProjectInput | null | { error: 'nameRequired' | 'pathRequired' } {
  const name = form.name.trim();
  if (!name) return { error: 'nameRequired' };
  if (!form.path.trim()) return { error: 'pathRequired' };

  const input: UpdateProjectInput = {};
  if (name !== project.name) input.name = name;
  if (form.path !== project.canonical_path) input.canonical_path = form.path;
  return Object.keys(input).length ? input : null;
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
