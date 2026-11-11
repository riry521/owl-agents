// @ts-check
import { apiErrorKeyForCode } from './api-error-keys.mjs';

/** What the Project row of Work detail offers: 'move' (selector, only when the server says the Work can move), 'pause-hint' (running) or 'none'. */
/** @param {any} work */
export function workProjectMoveMode(work) {
  if (work.project_id) return 'none';
  if (work.can_move_to_project) return 'move';
  return work.state === 'running' ? 'pause-hint' : 'none';
}

/** @param {any} work */
export function canMoveWorkToProject(work) {
  return workProjectMoveMode(work) === 'move';
}

/** Maps a move API failure to a `work.*` translation key; version and network errors reuse the shared keys. */
/**
 * @param {string} code
 * @param {any} [details]
 * @param {string} [kind]
 */
export function projectMoveErrorKey(code, details = {}, kind = '') {
  switch (code) {
    case 'work_project_already_set': return 'work.moveErrorAlreadySet';
    case 'project_not_found': return 'work.moveErrorProjectNotFound';
    case 'work_has_active_agents': return 'work.moveErrorActiveAgents';
    case 'invalid_state_transition':
      return details?.reason === 'task_fix_pending' ? 'work.moveErrorFixPending' : 'work.moveErrorState';
    default:
      return apiErrorKeyForCode(code, kind, {
        versionConflict: 'work.errorVersionConflict',
        network: 'work.errorNetwork',
        networkFrom: 'kind',
        fallback: 'work.errorOperation',
      });
  }
}
