import {
  DEFAULT_PLAN_USAGE_SETTINGS,
  type PlanUsageHarnessView,
  type PlanUsageSettings,
  type PlanUsageView,
} from "../../../shared/dist/plan-usage-settings.js";
import type { PlanUsageFetchResult, PlanUsageHarness, PlanUsageOrigin, PlanUsageSnapshot, PlanUsageSource, PlanUsageStatus, PlanUsageWindow } from "../../../shared/dist/plan-usage.js";
import { sanitizePlanUsageDetail, sanitizePlanUsageSnapshot, sanitizePlanUsageStatus, PlanUsageStore, type PlanUsageRow } from "./store.js";

export interface PlanUsageServiceOptions {
  readonly store: PlanUsageStore;
  readonly claude: PlanUsageSource | null;
  readonly codex: PlanUsageSource | null;
  readonly readSettings: () => PlanUsageSettings;
  readonly now?: () => Date;
  readonly firstPollDelayMs?: number;
  readonly manualCooldownMs?: number;
  readonly log?: (message: string) => void;
}

const OBSERVATION_WRITE_INTERVAL_MS = 30_000;
const EXPIRED_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLAUDE_BACKOFF_MS = 60 * 60 * 1000;

function snapshotKey(harness: PlanUsageHarness, origin: PlanUsageOrigin): string {
  return `${harness}:${origin}`;
}

function newest(...snapshots: (PlanUsageSnapshot | null)[]): PlanUsageSnapshot | null {
  return snapshots
    .filter((snapshot): snapshot is PlanUsageSnapshot => snapshot !== null)
    .sort((left, right) => Date.parse(right.observed_at) - Date.parse(left.observed_at))[0] ?? null;
}

function windowMap(snapshot: PlanUsageSnapshot | null): Map<string, PlanUsageWindow> {
  return new Map((snapshot?.windows ?? []).map((window) => [window.id, window]));
}

export class PlanUsageService {
  private readonly store: PlanUsageStore;
  private readonly claude: PlanUsageSource | null;
  private readonly codex: PlanUsageSource | null;
  private readonly readSettings: () => PlanUsageSettings;
  private readonly now: () => Date;
  private readonly firstPollDelayMs: number;
  private readonly manualCooldownMs: number;
  private readonly log: (message: string) => void;
  private readonly activeControllers = new Set<AbortController>();
  private readonly liveSnapshots = new Map<string, PlanUsageSnapshot>();
  private readonly lastObservationWriteAt = new Map<string, number>();
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private scheduledAt: string | null = null;
  private running = false;
  private activePoll: Promise<PlanUsageView> | null = null;
  private lastClaudeFetchAt: number | null = null;
  private claudeBackoffMs = 0;
  private nextClaudeAllowedAt = 0;

  public constructor(options: PlanUsageServiceOptions) {
    this.store = options.store;
    this.claude = options.claude;
    this.codex = options.codex;
    this.readSettings = options.readSettings;
    this.now = options.now ?? (() => new Date());
    this.firstPollDelayMs = Number.isFinite(options.firstPollDelayMs) && (options.firstPollDelayMs ?? -1) >= 0
      ? options.firstPollDelayMs as number
      : 5_000;
    this.manualCooldownMs = Number.isFinite(options.manualCooldownMs) && (options.manualCooldownMs ?? -1) >= 0
      ? options.manualCooldownMs as number
      : 60_000;
    this.log = options.log ?? ((message) => console.warn(`[owl-plan-usage] ${message}`));
  }

  public start(): void {
    if (this.running || (!this.claude && !this.codex)) return;
    this.running = true;
    this.schedule(this.firstPollDelayMs);
  }

  public stop(): void {
    this.running = false;
    this.clearScheduled();
    for (const controller of this.activeControllers) controller.abort();
    this.activeControllers.clear();
  }

  public reschedule(): void {
    if (!this.running) return;
    this.clearScheduled();
    this.schedule(this.intervalMs());
  }

  public refresh(): Promise<PlanUsageView> {
    if (this.activePoll) return this.activePoll;
    return this.beginPoll(true);
  }

  /** Live observations are accepted synchronously; persistence failures never escape into agent execution. */
  public observe(snapshot: PlanUsageSnapshot): void {
    try {
      let clean = sanitizePlanUsageSnapshot(snapshot);
      if (!clean) return;
      const key = snapshotKey(clean.harness, clean.origin);
      const previous = this.liveSnapshot(clean.harness, clean.origin);
      const limitedTransition = clean.windows.some((window) => window.state === "limited" && windowMap(previous).get(window.id)?.state !== "limited");
      if (clean.harness === "claude" && clean.origin === "claude_rate_limit_event") {
        clean = this.mergeClaudeRateLimitObservation(previous, clean);
      }
      this.liveSnapshots.set(key, clean);
      const now = this.now().getTime();
      let lastWrite = this.lastObservationWriteAt.get(key);
      if (lastWrite === undefined) {
        const stored = this.safeRows().find((row) => row.harness === clean!.harness && row.origin === clean!.origin);
        lastWrite = stored ? Date.parse(stored.checked_at) : Number.NEGATIVE_INFINITY;
      }
      if (!limitedTransition && now - lastWrite < OBSERVATION_WRITE_INTERVAL_MS) return;
      this.lastObservationWriteAt.set(key, now);
      void this.store.recordObservation(clean, this.isoNow()).catch(() => this.safeLog(`Could not persist observation (${clean!.origin}).`));
    } catch {
      // Observation is best-effort and must never interfere with an agent run; logging here could itself throw into that run.
    }
  }

  public view(): PlanUsageView {
    const settings = this.safeSettings();
    const rows = this.safeRows();
    const byKey = new Map(rows.map((row) => [snapshotKey(row.harness, row.origin), row]));
    const intervalMs = settings.poll_interval_minutes * 60_000;
    return {
      generated_at: this.isoNow(),
      settings,
      claude: this.claudeView(settings, intervalMs, byKey),
      codex: this.codexView(intervalMs, byKey),
    };
  }

  private async beginPoll(manual: boolean): Promise<PlanUsageView> {
    const poll = this.poll(manual);
    this.activePoll = poll;
    try {
      return await poll;
    } finally {
      if (this.activePoll === poll) this.activePoll = null;
    }
  }

  private async poll(manual: boolean): Promise<PlanUsageView> {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    try {
      const settings = this.safeSettings();
      await Promise.allSettled([
        this.checkClaude(settings, manual, controller.signal),
        this.checkCodex(controller.signal),
      ]);
    } finally {
      this.activeControllers.delete(controller);
    }
    return this.view();
  }

  private async checkClaude(settings: PlanUsageSettings, manual: boolean, signal: AbortSignal): Promise<void> {
    if (!settings.claude_usage_api_enabled) {
      await this.recordResult("claude", "claude_usage_api", { status: "disabled", snapshot: null, detail: null });
      return;
    }
    if (!this.claude) {
      await this.recordResult("claude", "claude_usage_api", { status: "not_configured", snapshot: null, detail: null });
      return;
    }
    const now = this.now().getTime();
    if (now < this.nextClaudeAllowedAt) return;
    if (manual && this.lastClaudeFetchAt !== null && now - this.lastClaudeFetchAt < this.manualCooldownMs) return;
    this.lastClaudeFetchAt = now;
    const result = await this.fetchResult(this.claude, signal);
    if (signal.aborted) return;
    if (result.status === "rate_limited") {
      const interval = settings.poll_interval_minutes * 60_000;
      this.claudeBackoffMs = Math.min(MAX_CLAUDE_BACKOFF_MS, this.claudeBackoffMs === 0 ? interval * 2 : this.claudeBackoffMs * 2);
      this.nextClaudeAllowedAt = this.now().getTime() + this.claudeBackoffMs;
    } else if (result.status === "ok") {
      this.claudeBackoffMs = 0;
      this.nextClaudeAllowedAt = 0;
    }
    await this.recordResult(this.claude.harness, this.claude.origin, result);
  }

  private async checkCodex(signal: AbortSignal): Promise<void> {
    if (!this.codex) {
      await this.recordResult("codex", "codex_session_log", { status: "not_configured", snapshot: null, detail: null });
      return;
    }
    const result = await this.fetchResult(this.codex, signal);
    if (signal.aborted) return;
    await this.recordResult(this.codex.harness, this.codex.origin, result);
  }

  private async fetchResult(source: PlanUsageSource, signal: AbortSignal): Promise<PlanUsageFetchResult> {
    try {
      const raw: unknown = await source.fetch(signal);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { status: "error", snapshot: null, detail: "invalid_result" };
      }
      const result = raw as Record<string, unknown>;
      const status = sanitizePlanUsageStatus(result.status);
      let snapshot = status === "ok"
        ? sanitizePlanUsageSnapshot(result.snapshot, { harness: source.harness, origin: source.origin })
        : null;
      let detail = sanitizePlanUsageDetail(result.detail);
      if (status === "ok" && !snapshot) {
        detail = "unrecognized_response";
        snapshot = null;
        return { status: "unrecognized", snapshot, detail };
      }
      return { status, snapshot, detail };
    } catch {
      return { status: "error", snapshot: null, detail: "source_threw" };
    }
  }

  private async recordResult(harness: PlanUsageHarness, origin: PlanUsageOrigin, result: PlanUsageFetchResult): Promise<void> {
    const previous = this.safeRows().find((row) => row.harness === harness && row.origin === origin);
    try {
      await this.store.recordCheck({ ...result, harness, origin }, this.isoNow());
      if (previous && previous.status !== result.status) {
        const detail = sanitizePlanUsageDetail(result.detail);
        this.safeLog(`${origin}: ${previous.status} -> ${result.status}${detail ? ` (${detail})` : ""}`);
      }
    } catch (error) {
      this.safeLog(`Could not persist check (${origin}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private mergeClaudeRateLimitObservation(previous: PlanUsageSnapshot | null, incoming: PlanUsageSnapshot): PlanUsageSnapshot {
    const cutoff = this.now().getTime() - EXPIRED_EVENT_RETENTION_MS;
    const windows = new Map<string, PlanUsageWindow>();
    for (const window of previous?.windows ?? []) {
      if (window.resets_at !== null && Date.parse(window.resets_at) < cutoff) continue;
      windows.set(window.id, window);
    }
    for (const window of incoming.windows) windows.set(window.id, window);
    return { ...incoming, windows: [...windows.values()] };
  }

  private liveSnapshot(harness: PlanUsageHarness, origin: PlanUsageOrigin): PlanUsageSnapshot | null {
    const memory = this.liveSnapshots.get(snapshotKey(harness, origin));
    if (memory) return memory;
    return this.safeRows().find((row) => row.harness === harness && row.origin === origin)?.snapshot ?? null;
  }

  private claudeView(settings: PlanUsageSettings, intervalMs: number, rows: Map<string, PlanUsageRow>): PlanUsageHarnessView {
    const api = rows.get(snapshotKey("claude", "claude_usage_api"));
    const event = rows.get(snapshotKey("claude", "claude_rate_limit_event"));
    const eventSnapshot = this.liveSnapshots.get(snapshotKey("claude", "claude_rate_limit_event")) ?? event?.snapshot ?? null;
    const apiSnapshot = api?.snapshot ?? null;
    const now = this.now().getTime();
    const apiFresh = apiSnapshot !== null && now - Date.parse(apiSnapshot.observed_at) <= intervalMs * 3;
    const apiUsable = settings.claude_usage_api_enabled && api?.status === "ok" && apiFresh;
    const display = !settings.claude_usage_api_enabled
      ? eventSnapshot
      : apiUsable ? apiSnapshot : eventSnapshot ?? apiSnapshot;
    const fallback = display?.origin === "claude_rate_limit_event";
    const status = !settings.claude_usage_api_enabled
      ? "disabled"
      : api?.status ?? (this.claude ? "no_data" : "not_configured");
    const checkedAt = display?.origin === "claude_rate_limit_event"
      ? event?.checked_at ?? display.observed_at
      : api?.checked_at ?? null;
    return {
      harness: "claude",
      status,
      detail: settings.claude_usage_api_enabled ? api?.detail ?? null : null,
      display,
      display_origin: display?.origin ?? null,
      fallback,
      stale: this.isStale(display, intervalMs),
      checked_at: checkedAt,
      next_check_at: this.scheduledAt,
    };
  }

  private codexView(intervalMs: number, rows: Map<string, PlanUsageRow>): PlanUsageHarnessView {
    const live = this.liveSnapshots.get(snapshotKey("codex", "codex_live"))
      ?? rows.get(snapshotKey("codex", "codex_live"))?.snapshot ?? null;
    const sessionRow = rows.get(snapshotKey("codex", "codex_session_log"));
    const display = newest(live, sessionRow?.snapshot ?? null);
    const usedLive = display?.origin === "codex_live";
    const status = usedLive ? "ok" : sessionRow?.status ?? (this.codex ? "no_data" : "not_configured");
    return {
      harness: "codex",
      status,
      detail: usedLive ? null : sessionRow?.detail ?? null,
      display,
      display_origin: display?.origin ?? null,
      fallback: false,
      stale: this.isStale(display, intervalMs),
      checked_at: usedLive ? display?.observed_at ?? null : sessionRow?.checked_at ?? null,
      next_check_at: this.scheduledAt,
    };
  }

  private isStale(snapshot: PlanUsageSnapshot | null, intervalMs: number): boolean {
    return snapshot !== null && this.now().getTime() - Date.parse(snapshot.observed_at) > intervalMs * 3;
  }

  private safeRows(): PlanUsageRow[] {
    try { return this.store.list(); } catch { return []; }
  }

  private safeSettings(): PlanUsageSettings {
    try {
      const value = this.readSettings();
      return {
        claude_usage_api_enabled: value.claude_usage_api_enabled === true,
        poll_interval_minutes: [2, 5, 10, 15, 30, 60].includes(value.poll_interval_minutes) ? value.poll_interval_minutes : DEFAULT_PLAN_USAGE_SETTINGS.poll_interval_minutes,
      };
    } catch (error) {
      this.safeLog(`Could not read plan usage settings; using defaults: ${error instanceof Error ? error.message : String(error)}`);
      return DEFAULT_PLAN_USAGE_SETTINGS;
    }
  }

  private intervalMs(): number {
    return this.safeSettings().poll_interval_minutes * 60_000;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.clearScheduled();
    const delay = Math.max(0, delayMs);
    this.scheduledAt = new Date(this.now().getTime() + delay).toISOString();
    const timeout = setTimeout(() => {
      if (!this.running || this.timeout !== timeout) return;
      this.timeout = null;
      this.scheduledAt = null;
      const poll = this.beginPoll(false);
      void poll.finally(() => {
        if (this.running) this.schedule(Math.max(this.intervalMs(), this.claudeBackoffMs));
      }).catch((error) => console.error("[owl-core] Plan usage poll failed", error)); // Why not an Owner event: a failed poll only leaves the usage view stale and the next poll retries.
    }, delay);
    this.timeout = timeout;
    this.timeout.unref?.();
  }

  private clearScheduled(): void {
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null;
    this.scheduledAt = null;
  }

  private isoNow(): string {
    try { return this.now().toISOString(); } catch { return new Date().toISOString(); }
  }

  private safeLog(message: string): void {
    try { this.log(message); } catch { /* Logs cannot interrupt collection or observation. */ }
  }
}
