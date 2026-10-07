import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export interface ProcessIdentity {
  readonly process_start_time: string | null;
  readonly process_cmdline_sha256: string | null;
}

/**
 * Read the small amount of OS process identity that Core persists with an
 * AgentRun.  A PID is reusable, so callers must not signal a process unless
 * both values match the values captured at spawn time.
 *
 * `ps` is available on the supported Unix/macOS runtimes.  If it is not
 * available, returning null is intentionally fail-closed: the run can still
 * be reconciled in the database, but an unrelated process will not be killed.
 */
export function readProcessIdentity(pid: number): ProcessIdentity {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { process_start_time: null, process_cmdline_sha256: null };
  }
  try {
    const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (started.length === 0 || command.length === 0) {
      return { process_start_time: null, process_cmdline_sha256: null };
    }
    const parsed = Date.parse(started);
    return {
      process_start_time: Number.isFinite(parsed)
        ? new Date(parsed).toISOString().replace(/\.000Z$/u, "Z")
        : null,
      process_cmdline_sha256: createHash("sha256").update(command, "utf8").digest("hex"),
    };
  } catch {
    return { process_start_time: null, process_cmdline_sha256: null };
  }
}

export function processIdentityMatches(
  expected: ProcessIdentity,
  observed: ProcessIdentity,
  toleranceSeconds = 10,
): boolean {
  if (
    expected.process_start_time === null ||
    expected.process_cmdline_sha256 === null ||
    observed.process_start_time === null ||
    observed.process_cmdline_sha256 === null ||
    expected.process_cmdline_sha256 !== observed.process_cmdline_sha256
  ) {
    return false;
  }
  const expectedMs = Date.parse(expected.process_start_time);
  const observedMs = Date.parse(observed.process_start_time);
  return Number.isFinite(expectedMs) && Number.isFinite(observedMs)
    && Math.abs(expectedMs - observedMs) <= toleranceSeconds * 1_000;
}
