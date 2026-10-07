import { PrerequisiteValidationError, validateWaitFor, type PlanWaitFor } from "../../shared/dist/prerequisite.js";
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

export type TaskRevision = Pick<TaskPlanItem, "title" | "acceptance" | "acceptance_criteria" | "context" | "plan_context" | "type" | "review" | "required_sections" | "required_tests" | "base_sync_only"> & {
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
  /** Retried Task id -> the prerequisite it waits for before running again (wait_for). */
  readonly waits: ReadonlyMap<string, PlanWaitFor>;
  /** Open Tasks the Manager cancels or treats as done, by Task id (Owner-initiated replans only). */
  readonly actions: ReadonlyMap<string, ReplanAction>;
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
  const plan = validatePlanAgainst(items, EMPTY_REPLAN_SNAPSHOT, [], "plan", { actions: [], allowOpen: false });
  if (isPlanRejection(plan)) return plan;
  const designAliases = new Set(items.flatMap((item, index) => (item.type === "design" ? itemAliases(item, index) : [])));
  const errors = items.flatMap((item, index) => {
    if (item.type === "design") return [];
    const blocker = (item.depends_on ?? []).find((dependency) => designAliases.has(dependency));
    return blocker === undefined
      ? []
      : [`Task ${planItemLocalId(item, index)} (type ${item.type}) depends on design Task ${blocker}; leave it out of the first plan and add it in a replan after the design is completed.`];
  });
  return errors.length > 0 ? { errors } : plan;
}

/** Task statuses an Owner-initiated replan may cancel, complete or replace. */
const OPEN_TASK_STATUSES: ReadonlySet<string> = new Set([
  "waiting", "ready", "running", "verifying", "review_fix_waiting", "paused", "judgement_waiting",
]);

/** What the Manager of an Owner-initiated replan does with an open Task. */
export interface ReplanAction {
  readonly task_id: string;
  readonly action: "cancel" | "complete";
  readonly reason: string;
}

export interface ReplanOptions {
  /** Cancel or complete open Tasks (Owner-initiated replans only). */
  readonly actions?: readonly ReplanAction[];
  /** A new Task's replaces may name an open Task, not only a root failed one. */
  readonly allowOpen?: boolean;
  /** Task id -> its current acceptance. Each is retried with its existing id and a rewritten acceptance. */
  readonly acceptanceRevisionRequired?: ReadonlyMap<string, string>;
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
  options: ReplanOptions = {},
): ReplanPlan | PlanRejection {
  const plan = validatePlanAgainst(items, snapshot, rootFailedIds, "replan", { actions: options.actions ?? [], allowOpen: options.allowOpen === true });
  const required = options.acceptanceRevisionRequired;
  if (isPlanRejection(plan) || required === undefined || required.size === 0) return plan;
  const labelOf = (id: string): string => snapshot.tasks.find((task) => task.id === id)?.manager_task_id ?? id;
  const errors: string[] = [];
  for (const [id, current] of required) {
    const label = labelOf(id);
    const revision = plan.revisions.get(id);
    if (plan.supersessions.has(id)) {
      errors.push(`Task ${label} has acceptance criteria that cannot be proven; retry it with its existing id instead of replacing it.`);
    } else if (revision === undefined) {
      errors.push(`Task ${label} must be retried with its existing id and rewritten acceptance.`);
    } else if (revision.acceptance.trim() === current.trim()) {
      errors.push(`Task ${label}: rewrite the criteria listed in acceptance_defects; the acceptance is unchanged.`);
    } else if (plan.waits.has(id)) {
      errors.push(`Task ${label}: an acceptance rewrite must not wait (wait_for).`);
    }
  }
  return errors.length > 0 ? { errors } : plan;
}

function validatePlanAgainst(
  items: readonly TaskPlanItem[],
  snapshot: ReplanSnapshot,
  rootFailedIds: readonly string[],
  mode: "plan" | "replan",
  options: { readonly actions: readonly ReplanAction[]; readonly allowOpen: boolean },
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

  // Cancel or complete actions on open Tasks.
  const actions = new Map<string, ReplanAction>();
  for (const action of options.actions) {
    const task = existing.get(action.task_id);
    if (!options.allowOpen) {
      report(`Task ${action.task_id}: cancelling or completing a Task is allowed only in a replan that follows an Owner request.`);
    } else if (task === undefined) {
      report(`Task ${action.task_id} is not a Task in current_plan (unknown Task in task_actions).`);
    } else if (rootFailed.has(task.id)) {
      report(`Task ${label(task)} is a root failed Task; retry or replace it instead of listing it in task_actions.`);
    } else if (!OPEN_TASK_STATUSES.has(task.status)) {
      report(`Task ${label(task)} is ${task.status}, not an open Task; leave it out of task_actions.`);
    } else if (actions.has(task.id)) {
      report(`Task ${label(task)} appears more than once in task_actions.`);
    } else {
      actions.set(task.id, action.task_id === task.id ? action : { ...action, task_id: task.id });
    }
  }
  const cancelled = new Set([...actions.values()].filter((action) => action.action === "cancel").map((action) => action.task_id));

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
  const waits = new Map<string, PlanWaitFor>();
  /** wait_for is valid only on a retried Task of a replan; returns it checked, or null when absent or rejected. */
  const checkedWaitFor = (item: TaskPlanItem, localId: string, retriedTask: boolean): PlanWaitFor | null => {
    if (item.wait_for === undefined || item.wait_for === null) return null;
    if (mode === "plan") {
      report(`Task ${localId} has wait_for, but a plan waits for nothing; use null.`);
    } else if (!retriedTask) {
      report(`Task ${localId} has wait_for, which is allowed only on a retried Task (its existing id, replaces []); use null.`);
    } else {
      try {
        return validateWaitFor(item.wait_for);
      } catch (error) {
        if (!(error instanceof PrerequisiteValidationError)) throw error;
        report(`Task ${localId} has an invalid wait_for: ${error.message}`);
      }
    }
    return null;
  };
  const retried: { item: TaskPlanItem; localId: string; taskId: string }[] = [];
  const newItems: { item: TaskPlanItem; index: number; localId: string }[] = [];
  items.forEach((item, index) => {
    const localId = planItemLocalId(item, index);
    const match = itemAliases(item, index).map((alias) => existing.get(alias)).find((task) => task !== undefined);
    if (match === undefined) {
      checkedWaitFor(item, localId, false);
      if (mode === "replan" && item.base_sync_only === true && (item.replaces ?? []).length === 0) {
        report(`Task ${localId} has base_sync_only, which in a replan is allowed only on a retried Task or a NEW Task with replaces; use null.`);
      }
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
      const wait = checkedWaitFor(item, localId, (item.replaces ?? []).length === 0);
      if (wait !== null) waits.set(match.id, wait);
      revisions.set(match.id, {
        title: item.title,
        acceptance: item.acceptance,
        acceptance_criteria: item.acceptance_criteria,
        context: item.context,
        plan_context: item.plan_context,
        type: item.type,
        review: item.review,
        required_sections: item.required_sections,
        required_tests: item.required_tests,
        base_sync_only: item.base_sync_only,
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
      if (dependencyTask !== undefined && (dependencyTask.status === "cancelled" || cancelled.has(dependencyTask.id))) {
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
      if (replacedTask === undefined || actions.has(replacedTask.id) || !(rootFailed.has(replacedTask.id) || (options.allowOpen && (OPEN_TASK_STATUSES.has(replacedTask.status) || (replacedTask.status === "failed" && replacedTask.failed_by_dependency))))) {
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
  // A Task that stays must not wait for a Task this plan cancels.
  for (const [node, dependencies] of graph) {
    const stays = byId.get(node);
    if (stays === undefined || !OPEN_TASK_STATUSES.has(stays.status) || actions.has(node) || supersessions.has(node)) continue;
    for (const dependency of dependencies) {
      if (cancelled.has(dependency)) {
        report(`Task ${label(stays)} depends on ${label(byId.get(dependency)!)}, which this plan cancels; cancel, replace or re-point it too.`);
      }
    }
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
    waits,
    actions,
  };
}

export function isPlanRejection(value: ReplanPlan | PlanRejection): value is PlanRejection {
  return "errors" in value;
}
