import { utcNow } from "../../db/dist/index.js";
import { STARTING_AGENT_RUN_STATUSES, setAgentRunStatus } from "./agent-run-state.js";
import { AGENT_STALE_THRESHOLD_MS } from "@owl/shared";
import { processIdentityMatches, readProcessIdentity } from "./process-identity.js";
import type { CoreDatabase, JsonObject } from "./types";

/** Thrown inside a write that must leave no row because the Owner stopped the work it records. */
export const OWNER_STOP_ABORT = new Error("The Owner stopped this work before its result was recorded.");

/**
 * Reconciles agent runs whose process died and raises `agent.idle` for silent ones.
 * Split out of WorkflowEngine; behaviour is unchanged.
 */
export class StaleAgentChecker {
  /**
   * Worker/Reviewer runs whose process looked dead on the last scan, keyed by
   * agent_run_id. A process that just exited normally is still reflected in
   * `pid`/identity columns for a brief window before its own exit handler
   * clears them, so the first dead-pid observation is recorded rather than
   * acted on; only a run whose pid is still the same one two scans later is
   * a real orphan.
   */
  private readonly deadPidSeen = new Map<string, { pid: number; at: number }>();
  private readonly idleAlertedAgentRuns = new Map<string, string>();

  public constructor(
    private readonly db: CoreDatabase,
    private readonly writeLane: ReturnType<CoreDatabase["createWriteLane"]>,
    private readonly writeFailureEvent: (workId: string, taskId: string, agentRunId: string, payload: JsonObject, event: string) => Promise<unknown>,
  ) {}

  public check(): void {
    // Observed subagents are reconciled by scanSubagents(), and Owl cannot
    // see their output, so neither crash nor idle detection applies to them.
    const agents = this.db.all<{ id: string; work_id: string; task_id: string | null; role: string; status: string; pid: number | null; process_start_time: string | null; process_cmdline_sha256: string | null; last_output_at: string | null; updated_at: string }>(
      "SELECT id, work_id, task_id, role, status, pid, process_start_time, process_cmdline_sha256, last_output_at, updated_at FROM agent_runs WHERE status IN ('launch_pending','spawned','running','cancel_requested') AND (origin IS NULL OR origin <> 'observed')",
    );
    const activeIds = new Set(agents.map((agent) => agent.id));
    for (const id of this.idleAlertedAgentRuns.keys()) {
      if (!activeIds.has(id)) this.idleAlertedAgentRuns.delete(id);
    }
    for (const id of this.deadPidSeen.keys()) {
      if (!activeIds.has(id)) this.deadPidSeen.delete(id);
    }
    for (const run of agents) {
      let processFailure: string | null = null;
      if (run.pid != null && run.pid > 0) {
        try {
          process.kill(run.pid, 0);
          const expected = {
            process_start_time: run.process_start_time,
            process_cmdline_sha256: run.process_cmdline_sha256,
          };
          const observed = readProcessIdentity(run.pid);
          const identityAvailable = expected.process_start_time !== null
            && expected.process_cmdline_sha256 !== null
            && observed.process_start_time !== null
            && observed.process_cmdline_sha256 !== null;
          if (identityAvailable && !processIdentityMatches(expected, observed)) {
            processFailure = "process_identity_mismatch";
          }
        } catch {
          processFailure = "process_died_without_report";
        }
      }
      // A child Executor's exit is recorded by its own close handler;
      // reconciling it here would race that handler.
      if (processFailure !== null && run.role === "executor") continue;
      // A Worker/Reviewer CLI that exits normally still has its old pid on
      // this row for a brief window before its own exit handler clears it,
      // which a scan landing in that window would otherwise misread as a
      // crash. Only a pid still dead on a second, later scan is a real orphan.
      if (processFailure !== null && (run.role === "worker" || run.role === "designer" || run.role === "reviewer")) {
        const seen = this.deadPidSeen.get(run.id);
        if (!seen || seen.pid !== run.pid) {
          this.deadPidSeen.set(run.id, { pid: run.pid ?? -1, at: Date.now() });
          continue;
        }
        this.deadPidSeen.delete(run.id);
      } else if (processFailure === null) {
        this.deadPidSeen.delete(run.id);
      }
      if (processFailure !== null) {
        if (run.status === "cancel_requested") {
          void this.writeLane.write({
            mutateState: (transaction) => {
              const now = utcNow();
              setAgentRunStatus(transaction, run.id, "cancelled", { now, from: ["cancel_requested"], endedAt: "coalesce" });
              return { agent_run_id: run.id, cancelled: true };
            },
            event: {
              idempotencyKey: `stale-cancel:${run.id}`,
              type: "agent.exited",
              workId: run.work_id,
              taskId: run.task_id,
              agentRunId: run.id,
              payload: { agent_run_id: run.id, outcome: "cancelled", result_ignored: true },
            },
            outbox: [{ provider: "websocket" }],
          }).catch((error) => console.error(`[stale-detect] Failed to reconcile cancelled agent ${run.id}`, error));
          continue;
        }
        const payload: JsonObject = {
          role: run.role,
          report_present: false,
          error_key: processFailure,
          pid: run.pid,
        };
        if (run.task_id && (run.role === "worker" || run.role === "designer" || run.role === "reviewer")) {
            void this.writeFailureEvent(run.work_id, run.task_id, run.id, payload, "agent.crashed")
              .catch((error) => console.error(`[stale-detect] Failed to reconcile crashed agent ${run.id}`, error));
        } else {
          void this.writeLane.write({
            mutateState: (transaction) => {
              const now = utcNow();
              const changed = setAgentRunStatus(transaction, run.id, "failed", { now, from: STARTING_AGENT_RUN_STATUSES });
              // The Owner stopped this run after the scan read it; no crash is recorded for it.
              if (changed === 0) throw OWNER_STOP_ABORT;
              return { agent_run_id: run.id };
            },
            event: {
              idempotencyKey: `stale-crash:${run.id}`,
              type: "agent.crashed",
              workId: run.work_id,
              taskId: run.task_id,
              agentRunId: run.id,
              payload,
            },
            outbox: [{ provider: "websocket" }],
          }).catch((error) => {
            if (error !== OWNER_STOP_ABORT) console.error(`[stale-detect] Failed to record stale agent ${run.id}`, error);
          });
        }
        console.log(`[stale-detect] Agent ${run.id} (pid ${run.pid ?? "unknown"} ${processFailure}) → reconciled`);
        continue;
      }
      const outputAt = Date.parse(run.last_output_at ?? run.updated_at);
      if (!Number.isFinite(outputAt) || Date.now() - outputAt <= AGENT_STALE_THRESHOLD_MS) continue;
      const outputMarker = run.last_output_at ?? run.updated_at;
      if (this.idleAlertedAgentRuns.get(run.id) === outputMarker) continue;
      this.idleAlertedAgentRuns.set(run.id, outputMarker);
      const thresholdSeconds = Math.floor(AGENT_STALE_THRESHOLD_MS / 1000);
      this.writeLane.write({
        mutateState: () => ({ agent_run_id: run.id, idle: true }),
        event: {
          idempotencyKey: `agent-idle:${run.id}:${outputMarker}`,
          type: "agent.idle",
          workId: run.work_id,
          taskId: run.task_id,
          agentRunId: run.id,
          payload: {
            agent_run_id: run.id,
            threshold_seconds: thresholdSeconds,
            last_output_at: outputMarker,
            action: "notify_only",
          },
        },
        outbox: [{ provider: "websocket" }],
      }).catch((error) => console.error(`[stale-detect] Failed to record idle alert for ${run.id}`, error));
      console.log(`[stale-detect] Agent ${run.id} has produced no output for more than ${thresholdSeconds}s → alert only`);
    }
  }
}
