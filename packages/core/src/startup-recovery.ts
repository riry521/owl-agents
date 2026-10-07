import { createUlid, utcNow } from "../../db/dist/index.js";
import { reduceTaskInTransaction, repairWorktreeStateInTransaction } from "./state-reducer.js";
import { reviewRouting } from "./assurance-settings.js";
import { effectiveReviewRequired } from "./review-routing.js";
import { processIdentityMatches, readProcessIdentity } from "./process-identity.js";
import { createProviderPauseStore } from "./provider-pause-store.js";
import { readPausedReviewerWait } from "./provider-pause-reviewer-wait.js";
import type { CoreDatabase, GitGateway, GitOperationRequest, JsonObject, TaskRow } from "./types.js";

export interface RecoveryResult {
  readonly orphanedAgents: number;
  readonly requeuedTasks: number;
  readonly reviewerProvidersToResume: string[];
  readonly staleWorks: string[];
  readonly requeuedReplanMarkers: number;
  /** Tasks whose Task branch was already fully merged into the Work branch by a crashed integration; repaired straight to completed. */
  readonly integratedVerifyingTasks: number;
  /** Completed Tasks whose worktree_state was left `active` by a crash between the merge and recording its outcome. */
  readonly repairedWorktrees: number;
}

/** Reconcile every launch state before any background driver is started. */
export async function recoverOrphanedState(db: CoreDatabase, git?: GitGateway): Promise<RecoveryResult> {
  const now = utcNow();
  let orphanedAgents = 0;
  let requeuedTasks = 0;
  const reviewerProvidersToResume = new Set<string>();
  const lane = db.createWriteLane();
  const providerPauses = createProviderPauseStore(db).list();
  const pausedProviders = new Set(providerPauses.map((pause) => normalizeProviderId(pause.provider)));

  if (git) {
    const works = db.all<{ id: string }>(
      "SELECT id FROM works WHERE project_id IS NOT NULL AND state NOT IN ('completed','cancelled')",
    );
    for (const work of works) {
      try {
        const result = await git.abortIntegrationMerge({ work_id: work.id });
        if (!result.ok) {
          console.warn(`[owl-core] Startup recovery could not abort the integration merge for Work ${work.id}: ${result.message}`);
        }
      } catch (error) {
        console.warn(`[owl-core] Startup recovery could not abort the integration merge for Work ${work.id}`, error);
      }
    }
  }

  // A crash between the Task branch merging into the Work branch and Core
  // recording that result leaves the Task stuck in `verifying` even though
  // its work is already done. Repair these first, before the general
  // orphaned-agent-run sweep below: once such a Task is `completed`, any
  // orphaned Reviewer agent_run row it still owns falls through to that
  // sweep's ordinary catch-all (marked `failed`) instead of re-entering the
  // review-fix cycle through the `verifying` agent.crashed branch.
  let integratedVerifyingTasks = 0;
  if (git) {
    const verifying = db.all<TaskRow>("SELECT * FROM tasks WHERE status = 'verifying'");
    for (const task of verifying) {
      const taskBranch = `owl/task/${task.work_id}/${task.id}`;
      const workBranch = `owl/work/${task.work_id}/work`;
      const request: GitOperationRequest = {
        work_id: task.work_id,
        task_id: task.id,
        worktree_path: task.worktree_path,
        task_branch: taskBranch,
        work_branch: workBranch,
      };
      const merged = await git.taskBranchMerged?.(request);
      if (merged !== true) continue;
      const reviewRequired = effectiveReviewRequired(task, reviewRouting(db));
      const event = reviewRequired ? "review.passed" : "verification.completed";
      const payload: JsonObject = reviewRequired
        ? { merge_exit_code: 0, task_branch: taskBranch, work_branch: workBranch, worktree_state: "merged", agent_run_id: orphanedReviewerRunId(db, task.id) }
        : {
            outcome: "pass",
            review_required: false,
            merge_exit_code: 0,
            task_branch: taskBranch,
            work_branch: workBranch,
            worktree_state: "merged",
            verification: { passed: true, source: "startup_integration_repair", commands: [] },
          };
      await lane.write({
        mutateState: (tx) => reduceTaskInTransaction(tx, task.id, { event, payload }),
        event: {
          id: createUlid(),
          idempotencyKey: `startup-integration:${task.id}`,
          type: event,
          workId: task.work_id,
          taskId: task.id,
          payload,
        },
        outbox: [],
      });
      await git.removeWorktree(request);
      integratedVerifyingTasks += 1;
    }
  }

  const active = db.all<{ id: string; pid: number | null; process_start_time: string | null; process_cmdline_sha256: string | null; work_id: string; task_id: string | null; role: string; status: string }>(
    "SELECT id, pid, process_start_time, process_cmdline_sha256, work_id, task_id, role, status FROM agent_runs WHERE status IN ('running','spawned','launch_pending','cancel_requested') ORDER BY created_at ASC",
  );
  await Promise.all(active.map(async (agent) => {
    if (agent.pid === null || !isProcessAlive(agent.pid)) return;
    const expected = {
      process_start_time: agent.process_start_time,
      process_cmdline_sha256: agent.process_cmdline_sha256,
    };
    if (!processIdentityMatches(expected, readProcessIdentity(agent.pid))) return;
    await terminateProcessGroup(agent.pid);
  }));
  await lane.transact((tx) => tx.run(
    `UPDATE child_runs
        SET status = 'cancelled', blocked_reason = NULL, failure_kind = 'core_restart',
            failure_reason = 'Core restarted before the child finished.', finished_at = ?, updated_at = ?
      WHERE status IN ('queued','running')`,
    now,
    now,
  ));
  for (const agent of active) {
    const reviewerWait = agent.task_id && agent.role === "reviewer"
      ? readPausedReviewerWait(db, agent.task_id)
      : undefined;
    if (
      reviewerWait !== undefined &&
      agent.task_id !== null &&
      db.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", agent.task_id)?.status === "verifying"
    ) {
      const status = agent.status === "cancel_requested" ? "cancelled" : "exited";
      await lane.transact((tx) => tx.run(
        `UPDATE agent_runs
            SET status = ?, pid = NULL, process_start_time = NULL, process_cmdline_sha256 = NULL,
                ended_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('running','spawned','launch_pending','cancel_requested')`,
        status, now, now, agent.id,
      ));
      continue;
    }
    await lane.write({
      mutateState: (tx) => {
        // Child runs and observed subagents belong to their Worker,
        // whose own row drives Task recovery below; just close them.
        if (agent.role === "executor") {
          tx.run(
            `UPDATE agent_runs
                SET status = CASE WHEN status = 'cancel_requested' THEN 'cancelled' WHEN origin = 'observed' THEN 'exited' ELSE 'failed' END,
                    pid = NULL, ended_at = ?, updated_at = ?
              WHERE id = ? AND status IN ('cancel_requested','running','spawned','launch_pending')`,
            now, now, agent.id,
          );
          return { requeued: false };
        }
        const task = agent.task_id ? tx.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", agent.task_id) : undefined;
        if (
          agent.status === "cancel_requested" &&
          agent.task_id &&
          task &&
          (task.status === "running" || (agent.role === "reviewer" && task.status === "verifying"))
        ) {
          reduceTaskInTransaction(tx, agent.task_id, {
            event: "agent.crashed",
            payload: {
              role: agent.role,
              report_present: false,
              error_key: "startup_cancelled_agent",
            },
          });
          tx.run("UPDATE agent_runs SET status = 'cancelled', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'cancel_requested'", now, now, agent.id);
          return { requeued: task.status === "running" || task.status === "verifying" };
        }
        if (agent.status === "cancel_requested" || task?.status === "cancelled") {
          tx.run("UPDATE agent_runs SET status = 'cancelled', ended_at = ?, updated_at = ? WHERE id = ? AND status IN ('cancel_requested','running','spawned','launch_pending')", now, now, agent.id);
          return { requeued: false };
        }
        if (agent.task_id && task?.status === "running") {
          const reduced = reduceTaskInTransaction(tx, agent.task_id, {
            event: "agent.crashed",
            payload: { agent_run_id: agent.id, report_present: false, error_key: "startup_orphaned_agent" },
          });
          return { requeued: reduced.next.status === "ready" };
        }
        if (agent.task_id && agent.role === "reviewer" && task?.status === "verifying") {
          const reduced = reduceTaskInTransaction(tx, agent.task_id, {
            event: "agent.crashed",
            payload: {
              agent_run_id: agent.id,
              role: "reviewer",
              report_present: false,
              error_key: "startup_orphaned_reviewer",
            },
          });
          return { requeued: reduced.next.status === "review_fix_waiting" };
        }
        tx.run("UPDATE agent_runs SET status = 'failed', ended_at = ?, updated_at = ? WHERE id = ? AND status IN ('running','spawned','launch_pending')", now, now, agent.id);
        return { requeued: false };
      },
      event: {
        id: createUlid(),
        idempotencyKey: `startup-recovery:${agent.id}`,
        type: "agent.crashed",
        workId: agent.work_id,
        taskId: agent.task_id,
        agentRunId: agent.id,
        payload: { reason: "process_or_lease_orphaned_at_startup", pid: agent.pid },
      },
      outbox: [],
    });
    orphanedAgents += 1;
    const currentTask = agent.task_id ? db.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", agent.task_id) : undefined;
    if (currentTask?.status === "ready") requeuedTasks += 1;
  }
  await lane.drain();

  // A crash can occur after verification has passed but before Core inserts
  // the Reviewer AgentRun.  Such a Task has no active row to reconcile, so
  // explicitly re-enter the Worker/review path rather than leaving it in
  // verifying forever.
  const strandedVerifying = db.all<{ id: string; work_id: string }>(
    `SELECT tasks.id, tasks.work_id
       FROM tasks
      WHERE tasks.status = 'verifying'
        AND NOT EXISTS (
          SELECT 1 FROM agent_runs
           WHERE agent_runs.task_id = tasks.id
             AND agent_runs.role = 'reviewer'
             AND agent_runs.status IN ('launch_pending','spawned','running','cancel_requested')
        )`,
  );
  for (const task of strandedVerifying) {
    const reviewerWait = readPausedReviewerWait(db, task.id);
    if (reviewerWait) {
      if (!pausedProviders.has(normalizeProviderId(reviewerWait.provider))) {
        reviewerProvidersToResume.add(reviewerWait.provider);
        requeuedTasks += 1;
      }
      continue;
    }
    await lane.write({
      mutateState: (tx) => reduceTaskInTransaction(tx, task.id, {
        event: "agent.crashed",
        payload: { role: "reviewer", report_present: false, error_key: "startup_missing_reviewer" },
      }),
      event: {
        id: createUlid(),
        idempotencyKey: `startup-recovery-reviewer:${task.id}`,
        type: "agent.crashed",
        workId: task.work_id,
        taskId: task.id,
        payload: { role: "reviewer", reason: "reviewer_missing_at_startup" },
      },
      outbox: [],
    });
    requeuedTasks += 1;
  }

  // A crash between a successful merge and recording its worktree_state
  // leaves a completed Task's worktree_state stuck `active`, so a later
  // startup would otherwise try to re-add and re-merge a worktree that is
  // already fully integrated.
  let repairedWorktrees = 0;
  const activeWorktrees = db.all<TaskRow>("SELECT * FROM tasks WHERE status = 'completed' AND worktree_state = 'active'");
  for (const task of activeWorktrees) {
    const project = db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", task.work_id)?.project_id;
    let to: "merged" | "retained" = "retained";
    let reason = project === null || project === undefined ? "no_project" : "git_unavailable_at_startup";
    if (project !== null && project !== undefined && git) {
      const taskBranch = `owl/task/${task.work_id}/${task.id}`;
      const workBranch = `owl/work/${task.work_id}/work`;
      const request: GitOperationRequest = {
        work_id: task.work_id,
        task_id: task.id,
        worktree_path: task.worktree_path,
        task_branch: taskBranch,
        work_branch: workBranch,
      };
      const merged = await git.taskBranchMerged?.(request);
      if (merged === true) {
        await git.removeWorktree(request);
        to = "merged";
        reason = "merged";
      } else {
        // A merge is only ever attempted from the normal Task lifecycle, not
        // from startup recovery, so an unmerged worktree is simply retained.
        reason = "unmerged_at_startup";
        console.log(`[owl-core] Recovery: Task ${task.id} worktree left active but not merged, retaining it for inspection`);
      }
    }
    const changed = await lane.write({
      mutateState: (tx) => repairWorktreeStateInTransaction(tx, task.id, to, now),
      event: {
        id: createUlid(),
        idempotencyKey: `worktree-repair:${task.id}:${to}`,
        type: "task.worktree_repaired",
        workId: task.work_id,
        taskId: task.id,
        payload: { task_id: task.id, from: "active", to, reason },
      },
      outbox: [],
    });
    if (changed.state) repairedWorktrees += 1;
  }

  const staleWorks: string[] = [];
  for (const work of db.all<{ id: string }>("SELECT id FROM works WHERE state = 'running'")) {
    const activeCount = db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE work_id = ? AND status IN ('running','spawned','launch_pending','cancel_requested')", work.id);
    const liveTaskCount = db.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE work_id = ? AND status IN ('waiting','ready','running','verifying','review_fix_waiting')", work.id);
    if (Number(activeCount?.count ?? 0) === 0 && Number(liveTaskCount?.count ?? 0) === 0) staleWorks.push(work.id);
  }

  // A clean shutdown moves an in-flight `attempted` replan trigger back to
  // `queued` itself (see requeueManagerReplan); a crash leaves it stuck
  // `attempted` with no in-flight replan to ever finish it. Move any such
  // marker back to `queued` here so the first tick after restart replays it.
  const requeuedReplanMarkers = await lane.transact((tx) => {
    const triggers = tx.run(
      `UPDATE idempotency_keys
          SET response_json = json_set(response_json, '$.status', 'queued')
        WHERE key LIKE 'manager-trigger:%'
          AND json_extract(response_json, '$.status') = 'attempted'
          AND EXISTS (
            SELECT 1 FROM tasks
              JOIN works ON works.id = tasks.work_id
             WHERE tasks.id = substr(idempotency_keys.key, length('manager-trigger:') + 1)
               AND tasks.status = 'failed'
               AND tasks.failed_by_dependency_task_id IS NULL
               AND works.state = 'running'
          )`,
    );
    const ownerReplans = tx.run(
      `UPDATE idempotency_keys
          SET response_json = json_set(response_json, '$.status', 'queued')
        WHERE key LIKE 'owner-replan:%'
          AND json_extract(response_json, '$.status') = 'attempted'`,
    );
    return triggers.changes + ownerReplans.changes;
  });

  return {
    orphanedAgents,
    requeuedTasks,
    reviewerProvidersToResume: [...reviewerProvidersToResume].sort(),
    staleWorks,
    requeuedReplanMarkers,
    integratedVerifyingTasks,
    repairedWorktrees,
  };
}

function normalizeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "claude" || normalized === "anthropic") return "anthropic";
  if (normalized === "codex" || normalized === "openai/codex" || normalized === "openai") return "openai";
  return normalized;
}

/** The still-orphaned Reviewer agent_run for a Task, if it still has one. */
function orphanedReviewerRunId(db: CoreDatabase, taskId: string): string | null {
  const run = db.get<{ id: string }>(
    `SELECT id FROM agent_runs
      WHERE task_id = ? AND role = 'reviewer' AND status IN ('running','spawned','launch_pending','cancel_requested')
      ORDER BY created_at DESC LIMIT 1`,
    taskId,
  );
  return run?.id ?? null;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    try { process.kill(pid, signal); } catch { /* process may be exiting */ }
  }
}

async function terminateProcessGroup(pid: number): Promise<void> {
  signalProcessGroup(pid, "SIGTERM");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  if (!isProcessAlive(pid)) return;
  signalProcessGroup(pid, "SIGKILL");
  const killDeadline = Date.now() + 5_000;
  while (Date.now() < killDeadline && isProcessAlive(pid)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}
