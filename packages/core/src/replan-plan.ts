import type { TaskPlanItem } from "./types";

/**
 * Validate a Manager plan or replan before Core writes any of it. Pure: it
 * reads only the snapshot taken before the Manager was invoked and returns
 * either the plan to apply or one human-readable line per problem, which
 * Core hands back to the Manager for one repair attempt and, failing that,
 * to the Owner in a Decision.
 */

export interface ReplanSnapshotTask {
  readonly id: string;
  readonly manager_task_id: string | null;
  readonly status: string;
  /** True when the Task failed only because a dependency failed (Task row 27). */
  readonly failed_by_dependency: boolean;
}

export interface ReplanSnapshot {
  readonly tasks: readonly ReplanSnapshotTask[];
  readonly edges: readonly { readonly task_id: string; readonly depends_on_task_id: string }[];
  /**
   * works.plan_revision when the snapshot was read. WorkflowEngine.applyReplan
   * refuses to apply a plan validated against an older revision.
   */
  readonly plan_revision?: number;
}

/** A dependency of a retried Task: an existing Task, or a new Task of the same replan (by its local id). */
export type ReplanDependency = { readonly task_id: string } | { readonly new_task: string };

export type TaskRevision = Pick<TaskPlanItem, "title" | "acceptance" | "context" | "type" | "review"> & {
  /**
   * The retried Task's dependencies as the Manager listed them; they replace
   * its current task_dependencies edges. Absent: the edges are kept.
   */
  readonly depends_on?: readonly ReplanDependency[];
};

export interface ReplanPlan {
  /** Tasks to register (new ids), in the Manager's order. */
  readonly newItems: readonly TaskPlanItem[];
  /** Revised instructions for each retried Task, keyed by its Task id. */
  readonly revisions: ReadonlyMap<string, TaskRevision>;
  /** Root failed Tasks the Manager retries, by Task id. */
  readonly reopenIds: readonly string[];
  /** Root failed Task id -> local ids (manager ids) of the new Tasks replacing it. */
  readonly supersessions: ReadonlyMap<string, readonly string[]>;
}

export interface PlanRejection {
  readonly errors: readonly string[];
}

export const EMPTY_REPLAN_SNAPSHOT: ReplanSnapshot = { tasks: [], edges: [] };

/** The id a plan item is registered under (createTaskPlanInTransaction uses the same rule). */
export function planItemLocalId(item: TaskPlanItem, index: number): string {
  return item.manager_task_id ?? item.id ?? `item-${index}`;
}

function itemAliases(item: TaskPlanItem, index: number): string[] {
  return [...new Set([planItemLocalId(item, index), item.id, item.manager_task_id]
    .filter((alias): alias is string => typeof alias === "string" && alias.length > 0))];
}

/**
 * The first dependency cycle in `edges` (node -> the nodes it depends on) as
 * the list of nodes on it, or null. Edges to nodes absent from the map are
 * ignored; callers that care check them separately.
 */
export function findDependencyCycle(edges: ReadonlyMap<string, readonly string[]>): readonly string[] | null {
  const visiting: string[] = [];
  const onPath = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): readonly string[] | null => {
    if (onPath.has(node)) return [...visiting.slice(visiting.indexOf(node)), node];
    if (visited.has(node)) return null;
    visiting.push(node);
    onPath.add(node);
    for (const dependency of edges.get(node) ?? []) {
      if (!edges.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    visiting.pop();
    onPath.delete(node);
    visited.add(node);
    return null;
  };
  for (const node of edges.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

/** Validate an initial plan: no existing Tasks, nothing to retry or replace. */
export function validatePlan(items: readonly TaskPlanItem[]): ReplanPlan | PlanRejection {
  return validatePlanAgainst(items, EMPTY_REPLAN_SNAPSHOT, [], "plan");
}

/**
 * Validate a replan against the Work as it was when the Manager was asked.
 * rootFailedIds are the failed Tasks this replan must resolve: each one is
 * retried (listed with its existing id) or replaced (named in a new Task's
 * replaces).
 */
export function validateReplan(
  items: readonly TaskPlanItem[],
  snapshot: ReplanSnapshot,
  rootFailedIds: readonly string[],
): ReplanPlan | PlanRejection {
  return validatePlanAgainst(items, snapshot, rootFailedIds, "replan");
}

function validatePlanAgainst(
  items: readonly TaskPlanItem[],
  snapshot: ReplanSnapshot,
  rootFailedIds: readonly string[],
  mode: "plan" | "replan",
): ReplanPlan | PlanRejection {
  const errors: string[] = [];
  const report = (message: string): void => {
    if (!errors.includes(message)) errors.push(message);
  };
  const existing = new Map<string, ReplanSnapshotTask>();
  for (const task of snapshot.tasks) {
    existing.set(task.id, task);
    if (task.manager_task_id !== null) existing.set(task.manager_task_id, task);
  }
  const label = (task: ReplanSnapshotTask): string => task.manager_task_id ?? task.id;
  const rootFailed = new Set(rootFailedIds);

  // Duplicate ids in the output.
  const aliasOwner = new Map<string, number>();
  items.forEach((item, index) => {
    for (const alias of itemAliases(item, index)) {
      const owner = aliasOwner.get(alias);
      if (owner !== undefined && owner !== index) report(`Task id ${alias} appears more than once in the plan (duplicate id).`);
      else aliasOwner.set(alias, index);
    }
  });

  // Retries (an existing id) versus new Tasks.
  const revisions = new Map<string, TaskRevision>();
  const retried: { item: TaskPlanItem; localId: string; taskId: string }[] = [];
  const newItems: { item: TaskPlanItem; index: number; localId: string }[] = [];
  items.forEach((item, index) => {
    const localId = planItemLocalId(item, index);
    const match = itemAliases(item, index).map((alias) => existing.get(alias)).find((task) => task !== undefined);
    if (match === undefined) {
      newItems.push({ item, index, localId });
      return;
    }
    if (rootFailed.has(match.id)) {
      if (revisions.has(match.id)) {
        report(`Task ${localId} is retried more than once in the plan (duplicate id).`);
        return;
      }
      if ((item.replaces ?? []).length > 0) {
        report(`Task ${localId} is retried with its existing id, so its replaces must be [] (it lists ${(item.replaces ?? []).join(", ")}).`);
      }
      revisions.set(match.id, {
        title: item.title,
        acceptance: item.acceptance,
        context: item.context,
        type: item.type,
        review: item.review,
      });
      retried.push({ item, localId, taskId: match.id });
      return;
    }
    if (match.status === "completed" || match.status === "cancelled") {
      report(`Task ${localId} reuses the id of ${match.status} Task ${label(match)} (id reuse); give a new Task an id that does not appear in current_plan.`);
    } else if (match.status === "failed" && match.failed_by_dependency) {
      report(`Task ${localId} failed only because a dependency failed; do not retry or replace it, it resumes on its own.`);
    } else if (match.status === "failed") {
      report(`Task ${localId} is not one of the failed Tasks of this replan; do not retry or revise it.`);
    } else {
      report(`Task ${localId} is ${match.status}, not a failed Task (revision of a non-failed Task); leave it out of the plan.`);
    }
  });

  // Dependencies of new and retried Tasks, and replacements.
  const newAliases = new Map<string, string>();
  for (const { item, index, localId } of newItems) {
    for (const alias of itemAliases(item, index)) newAliases.set(alias, localId);
  }
  const newNode = (localId: string): string => `new:${localId}`;
  /**
   * Resolve one Task's depends_on to graph nodes (existing Task ids or
   * new:<localId>), reporting unknown, cancelled and self dependencies.
   * `self` is the node of the Task itself.
   */
  const resolveDependencies = (item: TaskPlanItem, localId: string, self: string): { nodes: string[]; refs: ReplanDependency[] } => {
    const nodes: string[] = [];
    const refs: ReplanDependency[] = [];
    for (const dependency of item.depends_on ?? []) {
      const dependencyTask = existing.get(dependency);
      const node = dependencyTask !== undefined
        ? dependencyTask.id
        : newAliases.has(dependency) ? newNode(newAliases.get(dependency)!) : null;
      if (node === null) {
        report(`Task ${localId} depends on ${dependency}, which is neither a Task in current_plan nor a Task of this plan (unknown dependency).`);
        continue;
      }
      if (node === self) {
        report(`Task ${localId} depends on itself (self-dependency).`);
        continue;
      }
      if (dependencyTask !== undefined && dependencyTask.status === "cancelled") {
        report(`Task ${localId} depends on ${dependency}, which is cancelled (depends on a cancelled Task).`);
        continue;
      }
      if (nodes.includes(node)) continue;
      nodes.push(node);
      refs.push(dependencyTask !== undefined ? { task_id: dependencyTask.id } : { new_task: newAliases.get(dependency)! });
    }
    return { nodes, refs };
  };
  const newEdges = new Map<string, string[]>();
  const supersessions = new Map<string, string[]>();
  for (const { item, localId } of newItems) {
    newEdges.set(newNode(localId), resolveDependencies(item, localId, newNode(localId)).nodes);
    for (const replaced of new Set(item.replaces ?? [])) {
      const replacedTask = existing.get(replaced);
      if (mode === "plan") {
        report(`Task ${localId} lists ${replaced} in replaces, but a plan replaces nothing; use [].`);
        continue;
      }
      if (replacedTask === undefined || !rootFailed.has(replacedTask.id)) {
        report(`Task ${localId} replaces ${replaced}, which is not a root failed Task of this replan (replaces a Task that is not a root failed Task).`);
        continue;
      }
      const replacements = supersessions.get(replacedTask.id) ?? [];
      if (!replacements.includes(localId)) replacements.push(localId);
      supersessions.set(replacedTask.id, replacements);
    }
  }
  // L1: a retried Task's depends_on replaces its current dependencies (an
  // item without depends_on keeps them).
  const retriedEdges = new Map<string, string[]>();
  for (const { item, localId, taskId } of retried) {
    if (item.depends_on === undefined) continue;
    const { nodes, refs } = resolveDependencies(item, localId, taskId);
    retriedEdges.set(taskId, nodes);
    const revision = revisions.get(taskId);
    if (revision !== undefined) revisions.set(taskId, { ...revision, depends_on: refs });
  }

  // Every root failed Task is resolved exactly one way.
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
  for (const rootId of rootFailedIds) {
    const name = byId.has(rootId) ? label(byId.get(rootId)!) : rootId;
    const retried = revisions.has(rootId);
    const replaced = supersessions.has(rootId);
    if (retried && replaced) report(`Task ${name} is both retried and replaced; do one or the other.`);
    if (!retried && !replaced) report(`Task ${name} is neither retried nor replaced.`);
  }

  // Cycle check on the graph as it will be after the apply: existing edges
  // (a retried Task's replaced by its new depends_on) and the new Tasks'
  // edges, with every edge into a replaced Task re-pointed at that Task's own
  // replacements (WorkflowEngine.applyReplan).
  const graph = new Map<string, string[]>();
  for (const task of snapshot.tasks) graph.set(task.id, []);
  for (const edge of snapshot.edges) graph.get(edge.task_id)?.push(edge.depends_on_task_id);
  for (const [node, edges] of retriedEdges) graph.set(node, [...edges]);
  for (const [node, edges] of newEdges) graph.set(node, [...edges]);
  for (const [node, edges] of graph) {
    const projected: string[] = [];
    for (const dependency of edges) {
      const replacements = supersessions.get(dependency);
      if (replacements === undefined) {
        projected.push(dependency);
        continue;
      }
      for (const replacement of replacements) {
        if (newNode(replacement) !== node) projected.push(newNode(replacement));
      }
    }
    graph.set(node, [...new Set(projected)]);
  }
  const cycle = findDependencyCycle(graph);
  if (cycle) {
    const name = (node: string): string => node.startsWith("new:") ? node.slice(4) : byId.has(node) ? label(byId.get(node)!) : node;
    report(`The plan creates a dependency cycle: ${cycle.map(name).join(" -> ")}.`);
  }

  if (errors.length > 0) return { errors };
  return {
    newItems: newItems.map(({ item }) => item),
    revisions,
    reopenIds: rootFailedIds.filter((rootId) => revisions.has(rootId)),
    supersessions,
  };
}

export function isPlanRejection(value: ReplanPlan | PlanRejection): value is PlanRejection {
  return "errors" in value;
}
