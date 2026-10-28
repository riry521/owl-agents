/** The moment a Work entered the archive, falling back to its last update for older rows. */
function archivedTime(work) {
  const at = Date.parse(work.archived_at ?? work.updated_at ?? '');
  return Number.isFinite(at) ? at : 0;
}

/** Newest-archived first; a tie-break on id keeps the order deterministic. */
export function sortArchivedWorks(works) {
  return [...works].sort((a, b) => archivedTime(b) - archivedTime(a) || (a.id < b.id ? 1 : -1));
}

/** Local calendar day (YYYY-MM-DD) of the archive moment. */
export function archivedDayKey(work) {
  const d = new Date(archivedTime(work));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Newest-first Works split into consecutive day groups: [{ day, works }]. */
export function groupArchivedByDay(works) {
  const groups = [];
  for (const work of sortArchivedWorks(works)) {
    const day = archivedDayKey(work);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.works.push(work);
    else groups.push({ day, works: [work] });
  }
  return groups;
}

/**
 * Works split by project: [{ projectId, works }] in `projectIds` order (the project list order).
 * Works without a project, or with one missing from the list, go last under projectId null.
 */
export function groupByProject(works, projectIds) {
  const known = new Set(projectIds);
  const groups = [];
  for (const projectId of [...projectIds, null]) {
    const inGroup = works.filter((w) => (known.has(w.project_id) ? w.project_id : null) === projectId);
    if (inGroup.length > 0) groups.push({ projectId, works: inGroup });
  }
  return groups;
}
