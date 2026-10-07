/**
 * Execution stage of each Task, computed from dependencies on every render.
 * Stage = 1 for no dependencies, else (latest stage among dependencies) + 1.
 * Tasks in the same stage get a branch number by created_at ("1-1", "1-2");
 * a stage with one Task is just "4". Tasks whose stage cannot be computed
 * (cycle, dependency outside the list) go last with an empty label.
 *
 * @typedef {{ id: string, created_at: string, depends_on?: readonly string[] }} StagedTask
 * @template {StagedTask} T
 * @param {T[]} tasks
 * @returns {Array<{ task: T, stage: number | null, label: string }>} In display order.
 */
export function orderTasksByStage(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  /** @type {Map<string, number | null>} */
  const stages = new Map();
  /** @param {string} id @param {Set<string>} path @returns {number | null} */
  const stageOf = (id, path) => {
    if (stages.has(id)) return stages.get(id) ?? null;
    const task = byId.get(id);
    if (!task || path.has(id)) return null;
    path.add(id);
    /** @type {number | null} */
    let stage = 1;
    for (const dep of task.depends_on ?? []) {
      const depStage = stageOf(dep, path);
      if (depStage === null) {
        stage = null;
        break;
      }
      stage = Math.max(stage, depStage + 1);
    }
    path.delete(id);
    stages.set(id, stage);
    return stage;
  };
  const sorted = [...tasks].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const staged = sorted.map((task) => ({ task, stage: stageOf(task.id, new Set()) }));
  const sizes = new Map();
  for (const { stage } of staged) if (stage !== null) sizes.set(stage, (sizes.get(stage) ?? 0) + 1);
  const seen = new Map();
  const rows = staged.map(({ task, stage }) => {
    if (stage === null) return { task, stage, label: '' };
    const branch = (seen.get(stage) ?? 0) + 1;
    seen.set(stage, branch);
    return { task, stage, label: sizes.get(stage) === 1 ? String(stage) : `${stage}-${branch}` };
  });
  return [...rows.filter((r) => r.stage !== null).sort((a, b) => a.stage - b.stage), ...rows.filter((r) => r.stage === null)];
}
