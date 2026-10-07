import { validationError } from "./errors";
import type { WorkState } from "./types";

export const DEFAULT_WORK_DRIVER_TICK_INTERVAL_MS = 250;
export const DEFAULT_WORK_DRIVER_MAX_CONCURRENT = 4;

export interface WorkDriverOptions {
  readonly tick: (workId: string) => Promise<unknown>;
  readonly getState: (workId: string) => WorkState | undefined;
  readonly onTickError: (workId: string, error: unknown) => Promise<void>;
  readonly tickIntervalMs?: number;
  readonly maxConcurrent?: number;
}

/**
 * Background driver for running Work rows. The driver owns only scheduling;
 * Core remains responsible for state transitions and durable alert events.
 */
export class WorkDriver {
  private readonly tick: WorkDriverOptions["tick"];
  private readonly getState: WorkDriverOptions["getState"];
  private readonly onTickError: WorkDriverOptions["onTickError"];
  private readonly tickIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly workIds = new Set<string>();
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Works woken while their tick was in flight; each ticks once more after it. */
  private readonly wakeRequested = new Set<string>();
  private pumpScheduled = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private nextWorkIndex = 0;

  public constructor(options: WorkDriverOptions) {
    this.tick = options.tick;
    this.getState = options.getState;
    this.onTickError = options.onTickError;
    this.tickIntervalMs = positiveInteger(
      options.tickIntervalMs ?? DEFAULT_WORK_DRIVER_TICK_INTERVAL_MS,
      "dispatcher.tick_interval_ms",
    );
    this.maxConcurrent = positiveInteger(
      options.maxConcurrent ?? DEFAULT_WORK_DRIVER_MAX_CONCURRENT,
      "dispatcher.work_concurrency",
    );
  }

  public start(workIds: readonly string[] = []): void {
    if (this.running) {
      return;
    }
    this.running = true;
    for (const workId of workIds) {
      this.register(workId);
    }
    this.timer = setInterval(() => {
      void this.pump().catch((error: unknown) => console.error("[owl-core] Work driver pump failed; the next tick will retry", error));
    }, this.tickIntervalMs);
  }

  public async stop(): Promise<void> {
    this.stopScheduling();
    const pending = [...this.inFlight.values()];
    const results = await Promise.allSettled(pending);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
  }

  /** Stop launching work without waiting for provider calls already in flight. */
  public stopScheduling(): void {
    this.running = false;
    this.clearTimer();
    this.workIds.clear();
    this.wakeRequested.clear();
  }

  public isStarted(): boolean {
    return this.running;
  }

  public register(workId: string): void {
    if (workId.length === 0) {
      throw validationError("A Work driver registration requires a Work identifier.", { field: "work_id" });
    }
    this.workIds.add(workId);
  }

  public unregister(workId: string): void {
    this.workIds.delete(workId);
    this.wakeRequested.delete(workId);
  }

  /**
   * Tick a running Work as soon as possible instead of at the next interval.
   * A Work whose tick is in flight ticks once more after that tick ends.
   */
  public wake(workId: string): void {
    if (!this.running || this.getState(workId) !== "running") {
      return;
    }
    this.workIds.add(workId);
    if (this.inFlight.has(workId)) {
      this.wakeRequested.add(workId);
      return;
    }
    this.schedulePump();
  }

  private schedulePump(): void {
    if (this.pumpScheduled) {
      return;
    }
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      void this.pump().catch((error: unknown) => console.error("[owl-core] Work driver pump failed; the next tick will retry", error));
    });
  }

  private settle(workId: string): void {
    this.inFlight.delete(workId);
    if (this.wakeRequested.delete(workId) && this.running) {
      this.schedulePump();
    }
  }

  private async pump(): Promise<void> {
    if (!this.running) {
      return;
    }
    const candidates = [...this.workIds];
    if (candidates.length === 0) {
      return;
    }
    const startIndex = this.nextWorkIndex % candidates.length;
    let visited = 0;
    for (; visited < candidates.length && this.inFlight.size < this.maxConcurrent; visited += 1) {
      const workId = candidates[(startIndex + visited) % candidates.length];
      if (this.inFlight.has(workId)) {
        continue;
      }
      if (this.getState(workId) !== "running") {
        this.workIds.delete(workId);
        continue;
      }
      const run = this.drive(workId);
      this.inFlight.set(workId, run);
      void run.then(
        () => {
          this.settle(workId);
        },
        (error: unknown) => {
          this.settle(workId);
          console.error(`[owl-core] Work ${workId} driver tick failed outside the normal recovery path`, error);
          if (this.running && this.getState(workId) === "running") this.workIds.add(workId);
        },
      );
    }
    this.nextWorkIndex = (startIndex + Math.max(1, visited)) % candidates.length;
  }

  private async drive(workId: string): Promise<void> {
    try {
      await this.tick(workId);
    } catch (error) {
      this.workIds.delete(workId);
      try {
        await this.onTickError(workId, error);
      } catch (recoveryError) {
        console.error(`[owl-core] Work ${workId} tick recovery failed; leaving the Work registered for retry`, recoveryError);
        if (this.running && this.getState(workId) === "running") this.workIds.add(workId);
      }
      return;
    }
    if (this.getState(workId) !== "running") {
      this.workIds.delete(workId);
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw validationError(`${field} must be a positive integer.`, { [field]: value });
  }
  return value;
}
