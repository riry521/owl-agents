import Database from "better-sqlite3";

export interface ServerLock {
  /** Releases the lock. Safe to call more than once. */
  release(): void;
}

/**
 * Takes the single-instance lock for a data directory, or returns null when
 * another process holds it.
 *
 * The lock is a SQLite EXCLUSIVE transaction on a dedicated file, held until
 * release() or process exit. SQLite uses an OS file lock, so the kernel drops
 * it even on SIGKILL and a reused PID cannot keep it alive.
 *
 * Why not open(path, "wx") as a lock file: SIGKILL leaves the file behind, and
 * two starters that both find it stale race to delete and recreate it.
 */
// Why a module-level Set: the lock lives only as long as the open handle, and
// nothing else keeps the handle reachable, so a GC would close it silently.
const heldHandles = new Set<Database.Database>();

export function acquireServerLock(path: string): ServerLock | null {
  const handle = new Database(path, { timeout: 0 });
  try {
    handle.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    handle.close();
    if ((error as { code?: string }).code === "SQLITE_BUSY") return null;
    throw error;
  }
  heldHandles.add(handle);
  return {
    release() {
      heldHandles.delete(handle);
      if (handle.open) handle.close();
    },
  };
}
