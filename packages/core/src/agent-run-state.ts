/**
 * The only place that writes agent_runs. A status change goes through
 * setAgentRunStatus, which puts the allowed source states of the target into the
 * UPDATE's WHERE clause, so a forbidden transition changes 0 rows (the same way
 * the earlier `WHERE status IN (...)` guards behaved) and leaves the row as it was.
 */

export type AgentRunStatus =
  | "launch_pending" | "spawned" | "running" | "cancel_requested"
  | "completed" | "failed" | "spawn_failed" | "cancelled" | "exited";

export interface AgentRunTx {
  run(sql: string, ...params: any[]): { changes: number };
}

export const LIVE_AGENT_RUN_STATUSES: readonly AgentRunStatus[] = ["launch_pending", "spawned", "running", "cancel_requested"];
export const STARTING_AGENT_RUN_STATUSES: readonly AgentRunStatus[] = ["launch_pending", "spawned", "running"];
const ENDED_STATUSES: readonly AgentRunStatus[] = ["completed", "failed", "spawn_failed", "cancelled"];
// A result may still be recorded on a run that already ended (a late provider result), so these three are open from every state.
const RESULT_STATUSES: readonly AgentRunStatus[] = ["completed", "failed", "exited"];

/** Allowed next states per state. A cancelled, spawn_failed, completed, failed or exited run never goes back to running. */
export const AGENT_RUN_TRANSITIONS: Readonly<Record<AgentRunStatus, readonly AgentRunStatus[]>> = {
  launch_pending: ["spawned", "running", "cancel_requested", "cancelled", ...RESULT_STATUSES],
  spawned: ["running", "cancel_requested", "cancelled", ...RESULT_STATUSES],
  running: ["cancel_requested", "cancelled", ...RESULT_STATUSES],
  cancel_requested: ["cancel_requested", "cancelled", ...RESULT_STATUSES],
  completed: RESULT_STATUSES,
  failed: RESULT_STATUSES,
  spawn_failed: RESULT_STATUSES,
  cancelled: RESULT_STATUSES,
  // The Owner may still cancel an exited run (Core.cancelAgent rejects only the four ended states).
  exited: ["cancel_requested", "cancelled", ...RESULT_STATUSES],
};

export function isAgentRunTransitionAllowed(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return AGENT_RUN_TRANSITIONS[from].includes(to);
}

const list = (statuses: readonly string[]) => statuses.map((s) => `'${s}'`).join(",");
const sourcesOf = (to: AgentRunStatus) =>
  (Object.keys(AGENT_RUN_TRANSITIONS) as AgentRunStatus[]).filter((from) => isAgentRunTransitionAllowed(from, to));

/** The states of `from` that the table lets move to every state in `to`. */
const allowedFrom = (from: readonly AgentRunStatus[], ...to: AgentRunStatus[]) =>
  from.filter((s) => to.every((t) => isAgentRunTransitionAllowed(s, t)));

/**
 * A status CASE over `branches` (first match wins, then `otherwise`) and the WHERE condition that keeps
 * only rows whose own branch target the table allows from their current state within `scope`.
 */
function statusCase(scope: readonly AgentRunStatus[], branches: { when: string; to: AgentRunStatus }[], otherwise: AgentRunStatus) {
  const all = [...branches, { when: "1", to: otherwise }];
  // CASE treats a NULL condition as false, so "did not match" is COALESCE(..., 0) = 0, not NOT (...).
  const unmatched = (w: string) => `COALESCE((${w}), 0) = 0`;
  const guards = all.flatMap((b, i) => {
    const sources = allowedFrom(scope, b.to);
    if (sources.length === 0) return [];
    return [[...all.slice(0, i).map((p) => unmatched(p.when)), `(${b.when})`, `status IN (${list(sources)})`].join(" AND ")];
  });
  return {
    set: `CASE ${branches.map((b) => `WHEN ${b.when} THEN '${b.to}'`).join(" ")} ELSE '${otherwise}' END`,
    where: guards.length > 0 ? `(${guards.map((g) => `(${g})`).join(" OR ")})` : "0",
  };
}

export interface SetStatusOptions {
  now: string;
  /** Narrows the allowed source states further; the table still applies. */
  from?: readonly AgentRunStatus[];
  /** "set" overwrites ended_at, "coalesce" keeps an earlier value, "keep" leaves the column alone. */
  endedAt?: "set" | "coalesce" | "keep";
  outcome?: string | null;
  reportId?: string | null;
  usageJson?: string | null;
  clearProcess?: boolean;
}

/** Changes status when the table allows it; returns the number of rows changed (0 when rejected). */
export function setAgentRunStatus(tx: AgentRunTx, id: string, to: AgentRunStatus, o: SetStatusOptions): number {
  const sources = sourcesOf(to).filter((s) => !o.from || o.from.includes(s));
  if (sources.length === 0) return 0;
  const sets = ["status = ?"];
  const params: unknown[] = [to];
  if (o.outcome !== undefined) { sets.push("outcome = ?"); params.push(o.outcome); }
  if (o.reportId !== undefined) { sets.push("report_id = ?"); params.push(o.reportId); }
  if (o.clearProcess) sets.push("pid = NULL, process_start_time = NULL, process_cmdline_sha256 = NULL");
  const endedAt = o.endedAt ?? "set";
  if (endedAt === "set") { sets.push("ended_at = ?"); params.push(o.now); }
  if (endedAt === "coalesce") { sets.push("ended_at = COALESCE(ended_at, ?)"); params.push(o.now); }
  sets.push("updated_at = ?");
  params.push(o.now);
  if (o.usageJson !== undefined) { sets.push("usage_json = COALESCE(?, usage_json)"); params.push(o.usageJson); }
  return tx.run(`UPDATE agent_runs SET ${sets.join(", ")} WHERE id = ? AND status IN (${list(sources)})`, ...params, id).changes;
}

/**
 * Closes a live run whose process is gone: cancel_requested becomes cancelled, an observed run becomes
 * `observedAs` (when given), anything else becomes `otherwise`.
 */
export function closeLiveAgentRun(
  tx: AgentRunTx, id: string, o: { now: string; otherwise: "exited" | "failed"; observedAs?: "exited"; endedAt: "set" | "coalesce"; clearIdentity?: boolean },
): number {
  const status = statusCase(LIVE_AGENT_RUN_STATUSES, [
    { when: "status = 'cancel_requested'", to: "cancelled" },
    ...(o.observedAs ? [{ when: "origin = 'observed'", to: o.observedAs }] : []),
  ], o.otherwise);
  return tx.run(
    `UPDATE agent_runs
        SET status = ${status.set},
            pid = NULL, ${o.clearIdentity ? "process_start_time = NULL, process_cmdline_sha256 = NULL, " : ""}
            ended_at = ${o.endedAt === "set" ? "?" : "COALESCE(ended_at, ?)"}, updated_at = ?
      WHERE id = ? AND ${status.where}`,
    o.now, o.now, id,
  ).changes;
}

/** The Owner's cancel: soft sets cancel_requested, force sets cancelled and ended_at. */
export function requestAgentRunCancel(tx: AgentRunTx, id: string, force: boolean, now: string): number {
  return setAgentRunStatus(tx, id, force ? "cancelled" : "cancel_requested", { now, endedAt: force ? "set" : "keep" });
}

/**
 * Stops every live run of a Work or Task. A Worker-side run that never got a pid is closed as cancelled;
 * the others become cancel_requested for Core to signal.
 */
export function requestStopOfAgentRuns(
  tx: AgentRunTx, scope: { column: "work_id" | "task_id"; id: string }, now: string,
  filter: { roles?: readonly string[]; excludeRoles?: readonly string[]; skipHookAndObserved?: boolean } = {},
): number {
  const never = "status = 'launch_pending' AND pid IS NULL AND role <> 'executor'";
  const status = statusCase(STARTING_AGENT_RUN_STATUSES, [{ when: never, to: "cancelled" }], "cancel_requested");
  const extra = [
    filter.roles ? `AND role IN (${list(filter.roles)})` : "",
    filter.excludeRoles ? `AND role NOT IN (${list(filter.excludeRoles)})` : "",
    filter.skipHookAndObserved ? "AND hook_agent_id IS NULL AND (origin IS NULL OR origin <> 'observed')" : "",
  ].join(" ");
  return tx.run(
    `UPDATE agent_runs
        SET status = ${status.set},
            ended_at = CASE WHEN ${never} THEN COALESCE(ended_at, ?) ELSE ended_at END,
            updated_at = ?
      WHERE ${scope.column} = ? AND ${status.where} ${extra}`,
    now, now, scope.id,
  ).changes;
}

/** Records the process of a run; launch_pending and spawned become running. */
export function recordAgentRunProcess(
  tx: AgentRunTx, id: string,
  o: { pid: number; identity: { process_start_time: string | null; process_cmdline_sha256: string | null }; now: string; stampStart?: boolean },
): number {
  const stamp = o.stampStart ? "started_at = COALESCE(started_at, ?), last_output_at = COALESCE(last_output_at, ?), " : "";
  const toRunning = list(allowedFrom(["launch_pending", "spawned"], "running"));
  const guard = o.stampStart ? `NOT IN (${list(ENDED_STATUSES)})` : `IN (${list(LIVE_AGENT_RUN_STATUSES)})`;
  return tx.run(
    `UPDATE agent_runs SET pid = ?, process_start_time = ?, process_cmdline_sha256 = ?,
            status = CASE WHEN status IN (${toRunning}) THEN 'running' ELSE status END, ${stamp}updated_at = ?
      WHERE id = ? AND status ${guard}`,
    o.pid, o.identity.process_start_time, o.identity.process_cmdline_sha256, ...(o.stampStart ? [o.now, o.now] : []), o.now, id,
  ).changes;
}

/** Forgets the recorded process once it exited, if it is still the one recorded. */
export function clearAgentRunProcess(tx: AgentRunTx, id: string, pid: number, now: string): number {
  return tx.run(
    `UPDATE agent_runs SET pid = NULL, process_start_time = NULL, process_cmdline_sha256 = NULL, updated_at = ?
      WHERE id = ? AND pid = ? AND status IN (${list(LIVE_AGENT_RUN_STATUSES)})`,
    now, id, pid,
  ).changes;
}

/** Marks activity. `statuses` limits the runs touched (all when omitted); `role` limits further. */
export function touchAgentRunOutput(tx: AgentRunTx, id: string, now: string, o: { statuses?: readonly AgentRunStatus[]; role?: string } = {}): number {
  return tx.run(
    `UPDATE agent_runs SET last_output_at = ?, updated_at = ? WHERE id = ?${o.role ? " AND role = ?" : ""}${o.statuses ? ` AND status IN (${list(o.statuses)})` : ""}`,
    now, now, id, ...(o.role ? [o.role] : []),
  ).changes;
}

export function touchAgentRunUpdatedAt(tx: AgentRunTx, id: string, now: string): number {
  return tx.run("UPDATE agent_runs SET updated_at = ? WHERE id = ?", now, id).changes;
}

export function recordAgentRunPromptFingerprint(
  tx: AgentRunTx, id: string, f: { header: string | null; project: string | null; task: string | null; dynamic: string | null }, mode: string,
): number {
  return tx.run(
    `UPDATE agent_runs SET prompt_header_hash = ?, prompt_project_hash = ?, prompt_task_hash = ?,
       prompt_dynamic_hash = ?, prompt_mode = ? WHERE id = ?`,
    f.header, f.project, f.task, f.dynamic, mode, id,
  ).changes;
}

/** Cuts the links between a Work's own runs so the rows can be deleted. */
export function detachAgentRunLinks(tx: AgentRunTx, workId: string): number {
  return tx.run("UPDATE agent_runs SET parent_agent_id = NULL, retry_of_run_id = NULL, report_id = NULL WHERE work_id = ?", workId).changes;
}
