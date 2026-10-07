import { spawnSync } from "node:child_process";

/**
 * `kill(pid, 0)` also succeeds for a zombie on macOS/Linux until its parent
 * reaps it. Lifecycle commands must treat that process as exited; otherwise
 * owl stop can wait for the full timeout after a successful SIGTERM.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  const probe = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (probe.error) return true;
  if (probe.status !== 0) return false;
  return !probe.stdout.trim().startsWith("Z");
}
