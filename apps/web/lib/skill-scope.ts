import type { Project } from './types';
import type { TFunction } from './i18n';

const PROJECT_PREFIX = 'project:';

export const GLOBAL_SKILL_SCOPE = 'global';

export function projectSkillScope(projectId: string): string {
  return `${PROJECT_PREFIX}${projectId}`;
}

/** Display label for a skill scope: "global" or "project:<id>" (shown as the project's name when known). */
export function skillScopeLabel(scope: string, projects: Project[], t: TFunction): string {
  if (scope === GLOBAL_SKILL_SCOPE) return t('skills.scopeGlobal');
  if (scope.startsWith(PROJECT_PREFIX)) {
    const id = scope.slice(PROJECT_PREFIX.length);
    return projects.find((p) => p.id === id)?.name ?? t('skills.scopeProjectUnknown', { id });
  }
  return scope;
}
