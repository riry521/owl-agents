import { spawnSync } from "node:child_process";
import { isPidAlive } from "@owl/shared";

/**
 * `kill(pid, 0)` also succeeds for a zombie on macOS/Linux until its parent
 * reaps it. Lifecycle commands must treat that process as exited; otherwise
 * owl stop can wait for the full timeout after a successful SIGTERM.
 */
export function readProcessCommand(pid: number): string | null {
  const probe = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const command = probe.status === 0 ? probe.stdout.trim() : "";
  return command.length > 0 ? command : null;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!isPidAlive(pid, { epermAlive: false })) return false;

  const probe = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (probe.error) return true;
  if (probe.status !== 0) return false;
  return !probe.stdout.trim().startsWith("Z");
}
