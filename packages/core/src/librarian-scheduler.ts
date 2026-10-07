export interface LibrarianSchedulerClock {
  now(): Date;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LibrarianSchedulerOptions {
  readonly run: () => Promise<unknown>;
  readonly clock?: LibrarianSchedulerClock;
  readonly maxTickMs?: number;
  readonly logger?: Pick<Console, "warn">;
}

const DEFAULT_MAX_TICK_MS = 60_000;

const systemClock: LibrarianSchedulerClock = {
  now: () => new Date(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class LibrarianScheduler {
  private readonly run: () => Promise<unknown>;
  private readonly clock: LibrarianSchedulerClock;
  private readonly maxTickMs: number;
  private readonly logger: Pick<Console, "warn">;
  private times: readonly string[] = [];
  private next: Date | null = null;
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private active = false;

  public constructor(options: LibrarianSchedulerOptions) {
    this.run = options.run;
    this.clock = options.clock ?? systemClock;
    const maxTickMs = options.maxTickMs ?? DEFAULT_MAX_TICK_MS;
    this.maxTickMs = Number.isFinite(maxTickMs) ? Math.max(1, Math.floor(maxTickMs)) : DEFAULT_MAX_TICK_MS;
    this.logger = options.logger ?? console;
  }

  public start(times: readonly string[]): void {
    if (this.active) {
      this.reschedule(times);
      return;
    }
    this.active = true;
    this.times = [...times];
    this.next = nextLibrarianRunAt(this.times, this.clock.now());
    this.arm();
  }

  public reschedule(times: readonly string[]): void {
    this.times = [...times];
    if (!this.active) return;
    this.clearTimer();
    this.next = nextLibrarianRunAt(this.times, this.clock.now());
    this.arm();
  }

  public async stop(): Promise<void> {
    this.active = false;
    this.next = null;
    this.clearTimer();
    await this.inFlight;
  }

  public nextRunAt(): Date | null {
    return this.active && this.next !== null ? new Date(this.next) : null;
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
    if (!this.active || this.next === null) return;
    const delay = Math.max(0, Math.min(this.next.getTime() - this.clock.now().getTime(), this.maxTickMs));
    const handle = this.clock.setTimeout(() => this.tick(), delay);
    this.timer = handle;
    if (typeof handle === "object" && handle !== null && "unref" in handle && typeof handle.unref === "function") {
      handle.unref();
    }
  }

  private tick(): void {
    this.timer = null;
    if (!this.active || this.next === null) return;
    const now = this.clock.now();
    if (now.getTime() >= this.next.getTime()) {
      if (this.inFlight === null) {
        const task = Promise.resolve()
          .then(() => this.run())
          .then(() => undefined)
          .catch((error: unknown) => {
            this.logger.warn("[owl-core] Scheduled Librarian run failed", error);
          })
          .finally(() => {
            if (this.inFlight === task) this.inFlight = null;
          });
        this.inFlight = task;
      }
      this.next = nextLibrarianRunAt(this.times, now);
    }
    this.arm();
  }
}

/** Parse a zero-padded local time in HH:MM form. */
export function parseLibrarianTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Return the earliest configured local time strictly after `after`. */
export function nextLibrarianRunAt(times: readonly string[], after: Date): Date | null {
  const parsedTimes = times.map(parseLibrarianTime).filter((time): time is { hour: number; minute: number } => time !== null);
  if (parsedTimes.length === 0) return null;

  let best: Date | null = null;
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    for (const time of parsedTimes) {
      const candidate = new Date(
        after.getFullYear(),
        after.getMonth(),
        after.getDate() + dayOffset,
        time.hour,
        time.minute,
        0,
        0,
      );
      if (candidate.getTime() > after.getTime() && (best === null || candidate.getTime() < best.getTime())) {
        best = candidate;
      }
    }
  }
  return best;
}
