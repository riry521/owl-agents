/**
 * Deliverables of a Work: the files its completed Tasks changed.
 *
 * Each Task's latest Worker report lists its changes as `{ file, action }`
 * (the Worker report schema in packages/agent-runtime/src/worker.ts). Reports
 * of Tasks that did not complete (e.g. a Task superseded after a merge
 * conflict) are left out: their changes never reached the Work branch. A file
 * changed by several Tasks is listed once, with its latest change.
 * Plain JS imported by relative path, like agent-run-tree.mjs.
 *
 * @typedef {object} Deliverable
 * @property {string} file Changed file, relative to the Project root.
 * @property {string} action What was changed in it ('' when not reported).
 * @property {string} task_id Task whose report listed it.
 * @property {string} agent_run_id Worker run that wrote the report.
 */

/**
 * @param {ReadonlyArray<{ id: string; agent_run_id: string; payload: Record<string, unknown>; created_at: string }>} reports
 * @param {ReadonlyArray<{ id: string; task_id: string | null }>} runs
 * @param {ReadonlyArray<{ id: string; status: string }>} tasks
 * @returns {Deliverable[]}
 */
export function workDeliverables(reports, runs, tasks) {
  const taskOfRun = new Map(runs.map((run) => [run.id, run.task_id]));
  const completed = new Set(tasks.filter((task) => task.status === 'completed').map((task) => task.id));
  /** @type {Map<string, Deliverable>} */
  const byFile = new Map();
  const ordered = [...reports].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  for (const report of ordered) {
    const taskId = taskOfRun.get(report.agent_run_id);
    if (!taskId || !completed.has(taskId)) continue;
    const changes = Array.isArray(report.payload?.changes) ? report.payload.changes : [];
    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const file = typeof change.file === 'string' ? change.file.trim() : '';
      if (file.length === 0) continue;
      byFile.delete(file);
      byFile.set(file, {
        file,
        action: typeof change.action === 'string' ? change.action.trim() : '',
        task_id: taskId,
        agent_run_id: report.agent_run_id,
      });
    }
  }
  return [...byFile.values()];
}
