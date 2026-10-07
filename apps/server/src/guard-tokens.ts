import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { GuardTokenAgent, GuardTokenLease } from "../../../packages/shared/dist/guard-token.js";

/**
 * Guard tokens for agent processes. Each process gets its own token, bound to
 * its agent run and role and valid until the process ends. Tokens live in
 * memory only, so a server restart revokes all of them; the token files let
 * the permission hook read the token without it being in the agent
 * environment.
 *
 * Agents run as the same user as the server and can read these files. The
 * token limits what a leaked value is worth: it answers guard checks for its
 * own role only, and only while its process runs.
 */
export class GuardTokenRegistry {
  private readonly leases = new Map<string, { readonly agent: GuardTokenAgent; readonly file: string }>();

  private constructor(readonly directory: string) {}

  /** Opens the registry with an empty token directory (owner-only access). */
  static open(directory: string): GuardTokenRegistry {
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    return new GuardTokenRegistry(directory);
  }

  readonly issue = (agent: GuardTokenAgent): GuardTokenLease => {
    const token = randomBytes(32).toString("hex");
    const key = tokenKey(token);
    const file = join(this.directory, randomUUID());
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeFileSync(file, token, { encoding: "utf8", mode: 0o600, flag: "wx" });
    this.leases.set(key, { agent: { agent_run_id: agent.agent_run_id, role: agent.role }, file });
    let released = false;
    return {
      file,
      release: () => {
        if (released) return;
        released = true;
        this.leases.delete(key);
        rmSync(file, { force: true });
      },
    };
  };

  /** The agent a token was issued to, or null for an unknown or released token. */
  verify(token: string): GuardTokenAgent | null {
    return this.leases.get(tokenKey(token))?.agent ?? null;
  }

  /** Revokes every token and removes the token files. */
  clear(): void {
    this.leases.clear();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
