const MOVABLE_STATES = new Set(['memo', 'ready', 'paused', 'judgement_waiting']);

/** What the Project row of Work detail offers: 'move' (selector), 'pause-hint' (running) or 'none'. */
export function workProjectMoveMode(work) {
  if (work.project_id) return 'none';
  if (MOVABLE_STATES.has(work.state)) return 'move';
  return work.state === 'running' ? 'pause-hint' : 'none';
}

export function canMoveWorkToProject(work) {
  return workProjectMoveMode(work) === 'move';
}

/** Maps a move API failure to a `work.*` translation key; version and network errors reuse the shared keys. */
export function projectMoveErrorKey(code, details = {}, kind = '') {
  switch (code) {
    case 'work_project_already_set': return 'work.moveErrorAlreadySet';
    case 'project_not_found': return 'work.moveErrorProjectNotFound';
    case 'work_has_active_agents': return 'work.moveErrorActiveAgents';
    case 'invalid_state_transition':
      return details?.reason === 'task_fix_pending' ? 'work.moveErrorFixPending' : 'work.moveErrorState';
    case 'version_conflict': return 'work.errorVersionConflict';
    default: return kind === 'network_error' ? 'work.errorNetwork' : 'work.errorOperation';
  }
}
