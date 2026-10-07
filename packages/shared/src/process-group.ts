/** Grace between SIGTERM and SIGKILL when reaping an agent's process group. */
export const PROCESS_GROUP_REAP_GRACE_MS = 5_000;

const POLL_INTERVAL_MS = 50;

export interface ReapProcessGroupOptions {
  readonly graceMs?: number;
  readonly pollMs?: number;
}

/** True when at least one member of the process group still exists. */
export function isProcessGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM means the group exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminates every remaining member of a process group: SIGTERM first, then
 * SIGKILL once the grace period elapses with members still alive. The returned
 * promise resolves when the group is gone or the SIGKILL has been sent. Never
 * rejects; a vanished or foreign group is treated as already reaped.
 */
export function reapProcessGroup(pgid: number | undefined, options: ReapProcessGroupOptions = {}): Promise<void> {
  if (process.platform === "win32" || pgid === undefined || !Number.isInteger(pgid) || pgid <= 1) {
    return Promise.resolve();
  }
  if (!signalGroup(pgid, "SIGTERM")) return Promise.resolve();
  const graceMs = Math.max(0, options.graceMs ?? PROCESS_GROUP_REAP_GRACE_MS);
  const pollMs = Math.max(1, options.pollMs ?? POLL_INTERVAL_MS);
  const deadline = Date.now() + graceMs;
  return new Promise<void>((resolve) => {
    const check = (): void => {
      if (!isProcessGroupAlive(pgid)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        signalGroup(pgid, "SIGKILL");
        resolve();
        return;
      }
      setTimeout(check, Math.min(pollMs, Math.max(1, deadline - Date.now())));
    };
    setTimeout(check, Math.min(pollMs, Math.max(1, graceMs)));
  });
}
