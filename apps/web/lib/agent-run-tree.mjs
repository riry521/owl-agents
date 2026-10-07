/**
 * Parent → child structure over one list of AgentRuns.
 *
 * Child runs are executions launched by a Worker and agent CLIs detected in
 * the process tree (origin
 * `observed`). They carry `parent_agent_id` and are shown nested under the run
 * that launched them instead of as separate top-level agents.
 *
 * Plain JS (like work-detail-safety.mjs) and imported by relative path so the
 * node component tests, which stub the `@/` modules, still load it.
 *
 * @typedef {import('./types').AgentRun} AgentRun
 *
 * @typedef {object} RunTree
 * @property {Map<string, AgentRun[]>} children Child runs per parent id, oldest first.
 * @property {(run: AgentRun) => boolean} isChild True when the run's parent is in the list (so it renders nested).
 *
 * @typedef {object} RunTreeRow
 * @property {AgentRun} run Latest attempt.
 * @property {number} attempts Rows sharing the label (1 = no retry).
 * @property {number} depth 0 = direct child of the root.
 */

const LIVE_RUN_STATUSES = new Set(['launch_pending', 'spawned', 'running', 'cancel_requested']);

/** @param {string} status */
export function isLiveRunStatus(status) {
  return LIVE_RUN_STATUSES.has(status);
}

/**
 * @param {AgentRun[]} runs
 * @returns {RunTree}
 */
export function buildRunTree(runs) {
  const ids = new Set(runs.map((run) => run.id));
  /** @type {Set<string>} */
  const childIds = new Set();
  /** @type {Map<string, AgentRun[]>} */
  const children = new Map();
  for (const run of runs) {
    const parent = run.parent_agent_id;
    if (typeof parent !== 'string' || parent === run.id || !ids.has(parent)) continue;
    childIds.add(run.id);
    const list = children.get(parent);
    if (list) list.push(run);
    else children.set(parent, [run]);
  }
  for (const list of children.values()) {
    list.sort((a, b) => (a.started_at ?? '￿').localeCompare(b.started_at ?? '￿') || a.id.localeCompare(b.id));
  }
  return { children, isChild: (run) => childIds.has(run.id) };
}

/**
 * Owl-launched retries share a label: keep the latest attempt and count them.
 * Observed subagents are distinct processes even with the same label.
 * @param {AgentRun[]} siblings oldest first
 * @returns {Array<{ run: AgentRun; attempts: number }>}
 */
function collapseAttempts(siblings) {
  /** @type {Array<{ run: AgentRun; attempts: number }>} */
  const out = [];
  /** @type {Map<string, { run: AgentRun; attempts: number }>} */
  const byLabel = new Map();
  for (const run of siblings) {
    const label = run.origin !== 'observed' && typeof run.label === 'string' && run.label.length > 0 ? run.label : null;
    const existing = label === null ? undefined : byLabel.get(label);
    if (existing) {
      existing.run = run;
      existing.attempts += 1;
      continue;
    }
    const entry = { run, attempts: 1 };
    if (label !== null) byLabel.set(label, entry);
    out.push(entry);
  }
  return out;
}

/**
 * Descendants of `rootId` in display order (depth-first, retries collapsed).
 * @param {string} rootId
 * @param {RunTree} tree
 * @param {Set<string>} [excludedIds] Child AgentRuns represented by durable child-run records.
 * @returns {RunTreeRow[]}
 */
export function flattenRunTree(rootId, tree, excludedIds = new Set()) {
  /** @type {RunTreeRow[]} */
  const rows = [];
  const seen = new Set([rootId]);
  /** @param {string} parentId @param {number} depth */
  const walk = (parentId, depth) => {
    for (const entry of collapseAttempts(tree.children.get(parentId) ?? [])) {
      if (seen.has(entry.run.id)) continue;
      seen.add(entry.run.id);
      const excluded = excludedIds.has(entry.run.id);
      if (!excluded) rows.push({ ...entry, depth });
      walk(entry.run.id, depth + (excluded ? 0 : 1));
    }
  };
  walk(rootId, 0);
  return rows;
}

/**
 * True while the run or anything it launched is live (e.g. a Worker whose
 * child executions are running).
 * @param {AgentRun} run
 * @param {RunTree} tree
 */
export function isRunActive(run, tree) {
  if (isLiveRunStatus(run.status)) return true;
  const seen = new Set([run.id]);
  const stack = [...(tree.children.get(run.id) ?? [])];
  while (stack.length > 0) {
    const child = /** @type {AgentRun} */ (stack.pop());
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    if (isLiveRunStatus(child.status)) return true;
    stack.push(...(tree.children.get(child.id) ?? []));
  }
  return false;
}

/**
 * Active run representing each Task. A top-level run (Worker / Reviewer / …)
 * wins over a child run carrying the same task_id.
 * @param {AgentRun[]} runs
 * @param {RunTree} tree
 * @returns {Map<string, AgentRun>}
 */
export function activeRunByTask(runs, tree) {
  /** @type {Map<string, AgentRun>} */
  const out = new Map();
  /** @type {Map<string, AgentRun>} */
  const fallback = new Map();
  for (const run of runs) {
    if (!run.task_id || !isRunActive(run, tree)) continue;
    if (tree.isChild(run) || run.role === 'executor') fallback.set(run.task_id, run);
    else out.set(run.task_id, run);
  }
  for (const [taskId, run] of fallback) if (!out.has(taskId)) out.set(taskId, run);
  return out;
}

/**
 * Legacy phase progress for older Hybrid Worker runs. New child-run Workers
 * show their durable child records instead of this planned-task counter.
 * @param {AgentRun} root
 * @param {RunTree} tree
 * @returns {{ done: number; total: number }}
 */
export function hybridProgress(root, tree) {
  const spawned = (tree.children.get(root.id) ?? []).filter((run) => run.origin !== 'observed');
  const latest = collapseAttempts(spawned);
  const planned = root.subtask_count;
  const total = typeof planned === 'number' ? Math.max(planned, latest.length) : latest.length;
  return { done: latest.filter((entry) => !isLiveRunStatus(entry.run.status)).length, total };
}
