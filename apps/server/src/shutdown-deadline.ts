import { Worker } from "node:worker_threads";

const activeStages = new Set<string>();

/** Runs one shutdown stage and logs its start, completion (or failure) and elapsed milliseconds. */
export async function timedStage<T>(name: string, run: () => Promise<T> | T, log: (line: string) => void = console.log): Promise<T> {
  const started = Date.now();
  activeStages.add(name);
  log(`[owl-server] shutdown stage start: ${name}`);
  try {
    const result = await run();
    log(`[owl-server] shutdown stage done: ${name} (${Date.now() - started}ms)`);
    return result;
  } catch (error) {
    log(`[owl-server] shutdown stage failed: ${name} (${Date.now() - started}ms): ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    activeStages.delete(name);
  }
}

/**
 * Why a worker thread: a synchronous call (better-sqlite3) blocks the main
 * thread's timers, so only another thread can still kill the process.
 */
export function startKillWatchdog(afterMs: number): void {
  const worker = new Worker(
    "const { workerData: d } = process.getBuiltinModule('node:worker_threads'); setTimeout(() => process.kill(d.pid, 'SIGKILL'), d.afterMs);",
    { eval: true, workerData: { pid: process.pid, afterMs } },
  );
  worker.unref();
}

const describeError = (error: unknown): string => (error instanceof Error ? error.stack ?? error.message : String(error));

export interface ShutdownDeadlineOptions {
  /** The shutdown work. coreTimeoutMs is the deadline minus a margin so the graceful path ends first. */
  run(coreTimeoutMs: number, force: boolean): Promise<void>;
  deadlineMs: number;
  graceMs: number;
  forceTerminate(): void;
  /** Synchronous: removes pid/state files, then releases the lock. */
  cleanup(): void;
  exit(code: number): void;
  log(line: string): void;
  startWatchdog?(afterMs: number): void;
}

export function createShutdownDeadline(options: ShutdownDeadlineOptions): { handleSignal(signal: string, force: boolean): void } {
  const { deadlineMs, graceMs, log } = options;
  const marginMs = Math.min(2_000, Math.floor(deadlineMs / 5));
  let started = false;
  let exiting = false;

  const forceExit = (reason: string): void => {
    if (exiting) return;
    exiting = true;
    const stages = [...activeStages];
    log(`[owl-server] shutdown aborted (${reason})${stages.length ? `; unfinished stages: ${stages.join(", ")}` : ""}`);
    try { options.forceTerminate(); } catch (error) { log(`[owl-server] forceTerminateProcesses failed: ${describeError(error)}`); }
    try { options.cleanup(); } catch (error) { log(`[owl-server] runtime cleanup failed: ${describeError(error)}`); }
    options.exit(1);
  };

  return {
    handleSignal(signal, force) {
      log(`[owl-server] received ${signal}`);
      if (started) {
        forceExit(`${signal} received during shutdown`);
        return;
      }
      started = true;
      log(`[owl-server] shutdown start (force=${force}, deadline=${deadlineMs}ms)`);
      try { (options.startWatchdog ?? startKillWatchdog)(deadlineMs + graceMs); } catch (error) { log(`[owl-server] watchdog could not start: ${String(error)}`); }
      setTimeout(() => forceExit(`deadline ${deadlineMs}ms exceeded`), deadlineMs);
      void (async () => {
        try {
          await options.run(Math.max(0, deadlineMs - marginMs), force);
          if (exiting) return;
          // Why cleanup runs before `exiting` is set: if it throws, forceExit must still be allowed to exit(1).
          options.cleanup();
          exiting = true;
          log("[owl-server] shutdown complete");
          options.exit(0);
        } catch (error) {
          forceExit(`shutdown failed: ${describeError(error)}`);
        }
      })();
    },
  };
}
