import type { AgentPermissionRole } from "./permission-args.js";

/**
 * Environment variable naming the file that holds an agent process's guard
 * token. The path is not a secret; the token itself never enters the agent
 * environment.
 */
export const GUARD_TOKEN_FILE_ENV = "OWL_GUARD_TOKEN_FILE";

/** The agent run a guard token is bound to. */
export interface GuardTokenAgent {
  readonly agent_run_id: string;
  readonly role: AgentPermissionRole;
}

/** A guard token written for one agent process, valid until released. */
export interface GuardTokenLease {
  readonly file: string;
  /** Revoke the token and delete its file. Calling it again does nothing. */
  release(): void;
}

/** Issues a token that lets one agent process ask the guard about its own role only. */
export type GuardTokenIssuer = (agent: GuardTokenAgent) => GuardTokenLease;
