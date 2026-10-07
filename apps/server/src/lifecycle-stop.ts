import { cliText } from "./cli-language.js";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { isProcessAlive } from "./process-state.js";

const execFileAsync = promisify(execFile);

export interface ManagedProcessStopEntry {
  name: string;
  pid: number | null;
  status: "stopped" | "not_running" | "failed";
  message?: string;
}

interface StopOptions {
  force: boolean;
  timeoutSeconds: number;
}

function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const deadline = Date.now() + timeoutMs;
    const check = (): void => {
      if (!isProcessAlive(pid)) {
        resolvePromise(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolvePromise(false);
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

async function processCommand(pid: number): Promise<string | null> {
  try {
    const result = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { timeout: 5_000 });
    return result.stdout.trim();
  } catch (error) {
    // Unknown means "not provably ours": the caller skips this pid.
    console.error(`[owl stop] ps failed for PID ${pid}`, error);
    return null;
  }
}

async function processWorkingDirectory(pid: number): Promise<string | null> {
  try {
    const result = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 5_000 });
    const path = result.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1);
    return path ? resolve(path) : null;
  } catch {
    try {
      return await realpath(`/proc/${pid}/cwd`);
    } catch (procError) {
      console.error(`[owl stop] lsof and /proc cwd lookup failed for PID ${pid}`, procError);
      return null;
    }
  }
}

async function findManagedPids(root: string, relativeEntry: string): Promise<number[]> {
  let stdout = "";
  try {
    const result = await execFileAsync("pgrep", ["-f", relativeEntry], { timeout: 5_000 });
    stdout = result.stdout;
  } catch (error) {
    // pgrep returns exit code 1 when no process matches.
    if ((error as { code?: number }).code === 1) return [];
    // Any other failure (pgrep missing, timeout) is not "no process": surface it.
    console.error(`[owl stop] pgrep failed for ${relativeEntry}`, error);
    throw error;
  }

  const absoluteEntry = join(resolve(root), relativeEntry).replaceAll("\\", "/");
  const relativeMarker = relativeEntry.replaceAll("\\", "/");
  const currentPid = process.pid;
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const pid = Number(line.trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === currentPid) continue;
    const command = (await processCommand(pid))?.replaceAll("\\", "/") ?? "";
    let belongsToProject = command.includes(absoluteEntry);
    if (!belongsToProject && (command.includes(` ${relativeMarker}`) || command.includes(`./${relativeMarker}`))) {
      belongsToProject = (await processWorkingDirectory(pid)) === resolve(root);
    }
    if (belongsToProject) pids.push(pid);
  }
  return [...new Set(pids)];
}

async function gracefulKill(pid: number, name: string, options: StopOptions): Promise<ManagedProcessStopEntry> {
  if (!isProcessAlive(pid)) return { name, pid, status: "not_running" };
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as { code?: string }).code === "ESRCH") return { name, pid, status: "not_running" };
    console.error(`[owl stop] SIGTERM failed for PID ${pid}`, error);
    return { name, pid, status: "failed", message: cliText(`PID ${pid} にSIGTERMを送れませんでした。`, `Could not send SIGTERM to PID ${pid}.`) };
  }

  const graceMs = options.force ? Math.min(options.timeoutSeconds * 1000, 5_000) : options.timeoutSeconds * 1000;
  let exited = await waitForExit(pid, graceMs);
  if (!exited && options.force) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    exited = await waitForExit(pid, 5_000);
  }
  return exited
    ? { name, pid, status: "stopped" }
    : { name, pid, status: "failed", message: cliText(`PID ${pid} がタイムアウト内に停止しませんでした。`, `PID ${pid} did not stop before the timeout.`) };
}

/**
 * Stop only optional Owl helper processes launched from this project.
 * The server itself is stopped by cli.ts after validating owl-server.json and
 * the HTTP status PID, so a same-named process from another checkout cannot
 * be signalled accidentally.
 */
export async function stopManagedAuxiliaryProcesses(root: string, options: StopOptions): Promise<ManagedProcessStopEntry[]> {
  const results: ManagedProcessStopEntry[] = [];
  // Stop the supervisor first so it cannot restart the server while `owl stop`
  // is shutting the server down.
  for (const [name, entry] of [["supervisor", "apps/supervisor/dist/supervisor.js"], ["connectors", "apps/connectors/dist/cli.js"]] as const) {
    let pids: number[];
    try {
      pids = await findManagedPids(root, entry);
    } catch {
      // findManagedPids already logged the error; report it so `owl stop` fails instead of claiming success.
      results.push({ name, pid: null, status: "failed", message: cliText(`${name}のプロセス検索(pgrep)に失敗しました。`, `Could not search for ${name} processes (pgrep failed).`) });
      continue;
    }
    for (const pid of pids) results.push(await gracefulKill(pid, name, options));
  }
  return results;
}
