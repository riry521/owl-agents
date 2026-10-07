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
