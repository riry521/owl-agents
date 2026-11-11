import { closeLiveAgentRun, setAgentRunStatus } from "./agent-run-state.js";
import { createUlid, utcNow } from "@owl/db";
import { readProcessIdentity } from "./process-identity.js";
import { agentCliNames, installedAgentCliMatches, listProcesses, passThroughNames, planSubagentReconciliation } from "./subagent-watcher.js";
import { insertRequestUsageRows } from "./token-usage-report.js";
import type { HookRequestUsage } from "@owl/shared/token-relay";
import type { CoreDatabase, CoreWriteLaneTransaction } from "./types";

/** A SubagentStart / SubagentStop notification, or the stopped subagent's request usage. */
export type HookSubagentInput =
  | { readonly event: "start" | "stop"; readonly agentId: string; readonly agentType: string | null }
  | { readonly event: "usage"; readonly agentId: string; readonly agentType: string | null; readonly requests: readonly HookRequestUsage[] };

/**
 * Records the agent runs that running agents started themselves (found by process scan or reported by a harness hook)
 * and closes them when they are gone. Split out of WorkflowEngine; behaviour is unchanged.
 */
export class SubagentObserver {
  private subagentScanInFlight = false;

  public constructor(
    private readonly db: CoreDatabase,
    private readonly writeLane: ReturnType<CoreDatabase["createWriteLane"]>,
    /** Agent runs whose completion gate is still running; they keep their hook-reported children open. */
    private readonly gatingAgentRuns: ReadonlySet<string>,
  ) {}

  /**
   * Record agent CLIs that running agents started by themselves (see
   * subagent-watcher.ts) as observed executor AgentRuns, and close them when
   * their process is gone. Works the same for every provider and harness.
   */
  public async scanSubagents(processes = listProcesses()): Promise<void> {
    if (this.subagentScanInFlight || processes === null) return;
    this.subagentScanInFlight = true;
    try {
      await this.closeOrphanedHookSubagents();
      // Hook-reported children have no process; the stop hook closes them.
      const runs = this.db.all<{ id: string; work_id: string; task_id: string | null; pid: number | null; origin: string | null }>(
        "SELECT id, work_id, task_id, pid, origin FROM agent_runs WHERE hook_agent_id IS NULL AND status IN ('launch_pending','spawned','running','cancel_requested')",
      );
      if (runs.length === 0) return;
      const plan = planSubagentReconciliation(processes, runs, agentCliNames(), installedAgentCliMatches, passThroughNames());
      const runById = new Map(runs.map((run) => [run.id, run]));
      for (const runId of plan.exited) {
        const run = runById.get(runId);
        if (!run) continue;
        await this.writeLane.write({
          mutateState: (transaction: CoreWriteLaneTransaction) => {
            const now = utcNow();
            closeLiveAgentRun(transaction, runId, { now, otherwise: "exited", endedAt: "coalesce" });
            return { agent_run_id: runId };
          },
          event: {
            idempotencyKey: `subagent-exited:${runId}`,
            type: "subagent.exited",
            workId: run.work_id,
            taskId: run.task_id,
            agentRunId: runId,
            payload: { agent_run_id: runId },
          },
          outbox: [{ provider: "websocket" }],
        });
      }
      for (const found of plan.detected) {
        const parent = runById.get(found.parent_run_id);
        if (!parent) continue;
        const runId = createUlid();
        const identity = readProcessIdentity(found.pid);
        await this.writeLane.write({
          mutateState: (transaction: CoreWriteLaneTransaction) => {
            const now = utcNow();
            transaction.run(
              `INSERT INTO agent_runs
                 (id, work_id, task_id, parent_agent_id, role, origin, provider, model, status, label, pid,
                  process_start_time, process_cmdline_sha256, started_at, created_at, updated_at, tool_program)
                 VALUES (?, ?, ?, ?, 'executor', 'observed', ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)`,
              runId,
              parent.work_id,
              parent.task_id,
              parent.id,
              found.provider,
              found.model ?? "unknown",
              found.label,
              found.pid,
              identity.process_start_time,
              identity.process_cmdline_sha256,
              identity.process_start_time ?? now,
              now,
              now,
              found.tool_program,
            );
            return { agent_run_id: runId };
          },
          event: {
            idempotencyKey: `subagent-detected:${runId}`,
            type: "subagent.detected",
            workId: parent.work_id,
            taskId: parent.task_id,
            agentRunId: runId,
            payload: {
              agent_run_id: runId,
              parent_agent_run_id: parent.id,
              provider: found.provider,
              label: found.label,
            },
          },
          outbox: [{ provider: "websocket" }],
        });
      }
    } catch (error) {
      console.error("[owl-core] Subagent scan failed", error);
    } finally {
      this.subagentScanInFlight = false;
    }
  }

  /**
   * A Worker's own subagent as its harness reported it (SubagentStart / Stop
   * hook). Only the id and type are kept, never the hook's prompt or other
   * input. A repeated start or stop changes nothing. A usage upload stores
   * the subagent's request token counts; a repeated one adds no rows.
   */
  public recordHookSubagent(
    parentRunId: string,
    input: HookSubagentInput,
  ): Promise<{ readonly agent_run_id: string | null; readonly changed: boolean }> {
    // One notification at a time, so the lookup and the write cannot interleave.
    const run = this.hookSubagentChain.then(() => this.recordHookSubagentNow(parentRunId, input));
    this.hookSubagentChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private hookSubagentChain: Promise<void> = Promise.resolve();

  private async recordHookSubagentNow(
    parentRunId: string,
    input: HookSubagentInput,
  ): Promise<{ readonly agent_run_id: string | null; readonly changed: boolean }> {
    const parent = this.db.get<{ id: string; work_id: string; task_id: string | null; provider: string; model: string }>(
      "SELECT id, work_id, task_id, provider, model FROM agent_runs WHERE id = ? AND role = 'worker'",
      parentRunId,
    );
    if (!parent) return { agent_run_id: null, changed: false };
    const existing = this.db.get<{ id: string; status: string }>(
      "SELECT id, status FROM agent_runs WHERE parent_agent_id = ? AND hook_agent_id = ?",
      parent.id,
      input.agentId,
    );
    if (input.event === "usage") {
      // Without a recorded start, the rows belong to the Worker's own run.
      const runId = existing?.id ?? parent.id;
      const inserted = await this.writeLane.transact((tx) => insertRequestUsageRows(tx, input.requests.map((request) => ({
        ...request, agent_run_id: runId, work_id: parent.work_id, child_run_id: null, provider: parent.provider, subagent: true,
      }))));
      return { agent_run_id: runId, changed: inserted > 0 };
    }
    if (input.event === "start") {
      if (existing) return { agent_run_id: existing.id, changed: false };
      const runId = createUlid();
      const label = input.agentType ?? "subagent";
      await this.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) => {
          const now = utcNow();
          transaction.run(
            `INSERT INTO agent_runs
               (id, work_id, task_id, parent_agent_id, role, origin, provider, model, status, label, hook_agent_id,
                started_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'executor', 'observed', ?, ?, 'running', ?, ?, ?, ?, ?)`,
            runId, parent.work_id, parent.task_id, parent.id, parent.provider, parent.model, label, input.agentId, now, now, now,
          );
          return { agent_run_id: runId };
        },
        event: {
          idempotencyKey: `subagent-detected:${runId}`,
          type: "subagent.detected",
          workId: parent.work_id,
          taskId: parent.task_id,
          agentRunId: runId,
          payload: { agent_run_id: runId, parent_agent_run_id: parent.id, provider: parent.provider, label },
        },
        outbox: [{ provider: "websocket" }],
      });
      return { agent_run_id: runId, changed: true };
    }
    if (!existing || existing.status !== "running") return { agent_run_id: existing?.id ?? null, changed: false };
    await this.closeHookSubagent(existing.id, parent.work_id, parent.task_id);
    return { agent_run_id: existing.id, changed: true };
  }

  private async closeHookSubagent(runId: string, workId: string, taskId: string | null): Promise<void> {
    await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        const now = utcNow();
        setAgentRunStatus(transaction, runId, "exited", { now, from: ["running"], endedAt: "coalesce" });
        return { agent_run_id: runId };
      },
      event: {
        idempotencyKey: `subagent-exited:${runId}`,
        type: "subagent.exited",
        workId,
        taskId,
        agentRunId: runId,
        payload: { agent_run_id: runId },
      },
      outbox: [{ provider: "websocket" }],
    });
  }

  /**
   * Hook-reported children with no live ancestor never get a stop hook. An
   * ancestor that is active, or whose completion gate is still running, keeps
   * them open: a finished intermediate parent (e.g. an executor) is not enough.
   */
  private async closeOrphanedHookSubagents(): Promise<void> {
    const running = this.db.all<{ id: string; work_id: string; task_id: string | null; parent_agent_id: string | null }>(
      "SELECT id, work_id, task_id, parent_agent_id FROM agent_runs WHERE hook_agent_id IS NOT NULL AND status = 'running'",
    );
    const active = new Set(["launch_pending", "spawned", "running", "cancel_requested"]);
    for (const child of running) {
      let alive = false;
      const seen = new Set<string>();
      for (let id = child.parent_agent_id; id && !seen.has(id) && !alive; ) {
        seen.add(id);
        const row = this.db.get<{ parent_agent_id: string | null; status: string }>("SELECT parent_agent_id, status FROM agent_runs WHERE id = ?", id);
        if (!row) break;
        alive = active.has(row.status) || this.gatingAgentRuns.has(id);
        id = row.parent_agent_id;
      }
      if (!alive) await this.closeHookSubagent(child.id, child.work_id, child.task_id);
    }
  }
}
