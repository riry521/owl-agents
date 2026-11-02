import type { LibrarianSchedulerClock } from "../librarian-scheduler.js";

export interface PeriodicRunnerOptions {
  readonly run: () => Promise<unknown>;
  readonly intervalMs: number;
  readonly clock?: LibrarianSchedulerClock;
  readonly logger?: Pick<Console, "warn">;
}

const systemClock: LibrarianSchedulerClock = {
  now: () => new Date(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Runs `run` every `intervalMs`. `LibrarianScheduler` takes clock times of day and does not fit "every n minutes". */
export class PeriodicRunner {
  private readonly run: () => Promise<unknown>;
  private readonly clock: LibrarianSchedulerClock;
  private readonly logger: Pick<Console, "warn">;
  private intervalMs: number;
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private active = false;

  public constructor(options: PeriodicRunnerOptions) {
    this.run = options.run;
    this.intervalMs = options.intervalMs;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? console;
  }

  /** The first run is one interval from now, not at once. */
  public start(): void {
    if (this.active) return;
    this.active = true;
    this.arm();
  }

  public reschedule(intervalMs: number): void {
    this.intervalMs = intervalMs;
    if (!this.active) return;
    this.clearTimer();
    this.arm();
  }

  public async stop(): Promise<void> {
    this.active = false;
    this.clearTimer();
    await this.inFlight;
  }

  public isRunning(): boolean {
    return this.inFlight !== null;
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    const handle = this.clock.setTimeout(() => this.tick(), this.intervalMs);
    this.timer = handle;
    if (typeof handle === "object" && handle !== null && "unref" in handle && typeof handle.unref === "function") handle.unref();
  }

  private tick(): void {
    this.timer = null;
    if (!this.active) return;
    // A run still going when the next one is due is not stacked; the next interval is armed either way.
    if (this.inFlight === null) {
      const task = Promise.resolve()
        .then(() => this.run())
        .then(() => undefined)
        .catch((error: unknown) => { this.logger.warn("[owl-core] Periodic automatic Work run failed", error); })
        .finally(() => { if (this.inFlight === task) this.inFlight = null; });
      this.inFlight = task;
    }
    this.arm();
  }
}
