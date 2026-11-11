import { format } from "node:util";

/** Prefixes every line of text with an ISO 8601 time so server.log lines can be ordered. */
export function timestampLines(text: string, now: Date = new Date()): string {
  const stamp = now.toISOString();
  return text.replace(/\n$/u, "").split("\n").map((line) => `${stamp} ${line}`).join("\n");
}

const installed = new WeakSet<Console>();

/**
 * Wraps console.log/info/warn/error so each output line carries a time.
 * Why not wrap process.stdout.write: JSON result lines for machines go through
 * stdout.write and must stay unchanged.
 */
export function installTimestampedConsole(target: Console = console): void {
  if (installed.has(target)) return;
  installed.add(target);
  for (const method of ["log", "info", "warn", "error"] as const) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => original(timestampLines(format(...args)));
  }
}
