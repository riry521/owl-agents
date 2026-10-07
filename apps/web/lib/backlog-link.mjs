/** @typedef {import('./types').BacklogItem} BacklogItem */
/** @typedef {import('./types').WorkSummary} WorkSummary */

/** @param {WorkSummary} work */
const isIncomplete = (work) => work.state !== 'completed';

/**
 * Works that can take backlog items of a project (null matches only null): not cancelled, archived allowed.
 * Incomplete Works first, completed after, each by updated_at descending.
 * @param {WorkSummary[]} works @param {string | null} projectId
 */
export function linkableWorks(works, projectId) {
  return works
    .filter((work) => work.project_id === projectId && work.state !== 'cancelled')
    .sort((a, b) => Number(isIncomplete(b)) - Number(isIncomplete(a)) || (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
}

/** @param {'open' | 'in_progress' | 'done' | 'dismissed'} status */
export function backlogStatusBadge(status) {
  return { open: 'badge--blue', in_progress: 'badge--amber', done: 'badge--green', dismissed: 'badge--gray' }[status];
}

/** @param {BacklogItem} item */
export function showsLinkedWork(item) {
  return (item.status === 'in_progress' || item.status === 'done') && item.issued_work_id !== null;
}
