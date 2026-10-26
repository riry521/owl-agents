import type { CoreWriteLaneTransaction } from "./types";

/** cancel_requested and cancelled: the run was stopped, so its result is never recorded. */
export function isStoppedAgentStatus(status: string | null | undefined): boolean {
  return status === "cancel_requested" || status === "cancelled";
}

export class AgentRunStoppedError extends Error {
  public constructor(public readonly agentRunId: string) {
    super(`Agent run ${agentRunId} was stopped before its result was recorded.`);
    this.name = "AgentRunStoppedError";
  }
}

/** Throw inside the write so the result event row rolls back with the state. */
export function assertAgentRunNotStopped(transaction: CoreWriteLaneTransaction, agentRunId: string): void {
  const run = transaction.get<{ status: string }>("SELECT status FROM agent_runs WHERE id = ?", agentRunId);
  if (isStoppedAgentStatus(run?.status)) throw new AgentRunStoppedError(agentRunId);
}

export function isAgentRunStopped(error: unknown): error is AgentRunStoppedError {
  return error instanceof AgentRunStoppedError;
}
