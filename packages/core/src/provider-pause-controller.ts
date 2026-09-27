import { createUlid } from "../../db/dist/index.js";
import type { ProviderPauseRow, ProviderPauseStore, ProviderRateLimit } from "./provider-pause-store";

export type ProviderPauseEventType = "provider.paused" | "provider.resumed";

export interface ProviderPauseEvent {
  readonly idempotency_key: string;
  readonly type: ProviderPauseEventType;
  readonly payload: Record<string, unknown>;
}

export interface ProviderPauseControllerOptions {
  readonly store: ProviderPauseStore;
  readonly now?: () => string;
  readonly setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly emitEvent?: (event: ProviderPauseEvent) => void | Promise<void>;
  readonly onResume?: (provider: string) => void | Promise<void>;
}

export interface ProviderPauseController {
  start(): void;
  stop(): void;
  isPaused(provider: string): boolean;
  recordRateLimit(report: ProviderRateLimit & {
    readonly role?: string;
    readonly work_id?: string | null;
    readonly task_id?: string | null;
    readonly last_error_key?: string | null;
    readonly last_error?: string | null;
  }): Promise<ProviderPauseRow>;
  noteProviderSucceeded(provider: string, runStartedAt: string): Promise<ProviderPauseRow | null>;
}

const FALLBACK_BACKOFF_MINUTES = [15, 30, 60] as const;
const MAX_TIMEOUT_MS = 2_147_000_000;

/** Durable provider pause scheduling shared by Core and the workflow engine. */
export function createProviderPauseController(options: ProviderPauseControllerOptions): ProviderPauseController {
  const now = options.now ?? (() => new Date().toISOString());
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let started = false;

  const emit = async (event: ProviderPauseEvent): Promise<void> => {
    try {
      await options.emitEvent?.(event);
    } catch (error) {
      console.error(`[owl-core] Could not emit ${event.type} for provider ${String(event.payload.provider)}`, error);
    }
  };

  const resumeNotification = async (provider: string, row: ProviderPauseRow): Promise<void> => {
    await emit({
      idempotency_key: `provider-resumed:${provider}:${row.resume_at ?? row.updated_at}`,
      type: "provider.resumed",
      payload: { provider, provider_label: providerLabel(provider) },
    });
    try {
      await options.onResume?.(provider);
    } catch (error) {
      console.error(`[owl-core] Could not resume work after provider ${provider} became available`, error);
    }
  };

  const arm = (row: ProviderPauseRow): void => {
    const provider = normalizeProvider(row.provider);
    const old = timers.get(provider);
    if (old !== undefined) clearTimer(old);
    timers.delete(provider);
    if (!started || row.state !== "paused") return;
    const deadline = resumeDeadline(row, now());
    const remaining = Math.max(0, deadline - Date.parse(now()));
    const timer = setTimer(() => {
      timers.delete(provider);
      const current = options.store.list().find((item) => normalizeProvider(item.provider) === provider);
      if (!current || current.state !== "paused") return;
      const currentDeadline = resumeDeadline(current, now());
      if (currentDeadline > Date.parse(now())) {
        arm(current);
        return;
      }
      void options.store.resume(current.provider).then(async (resumed) => {
        if (resumed) await resumeNotification(provider, resumed);
      }).catch((error: unknown) => {
        console.error(`[owl-core] Could not resume provider ${provider}`, error);
        const retry = options.store.list().find((item) => normalizeProvider(item.provider) === provider);
        if (retry?.state === "paused") arm(retry);
      });
    }, Math.min(remaining, MAX_TIMEOUT_MS));
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as NodeJS.Timeout).unref();
    }
    timers.set(provider, timer);
  };

  return {
    start() {
      if (started) return;
      started = true;
      for (const row of options.store.list()) {
        if (row.state === "paused") arm(row);
        else if (row.state === "probing") void resumeNotification(normalizeProvider(row.provider), row);
      }
    },

    stop() {
      started = false;
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
    },

    isPaused(providerInput) {
      const provider = normalizeProvider(providerInput);
      return options.store.list().some((row) => normalizeProvider(row.provider) === provider && row.state === "paused");
    },

    async recordRateLimit(report) {
      const provider = normalizeProvider(report.provider);
      const before = options.store.list().find((row) => normalizeProvider(row.provider) === provider);
      const row = await options.store.recordRateLimit({ ...report, provider });
      arm(row);
      await emit({
        idempotency_key: `provider-paused:${provider}:${row.updated_at}:${row.resume_at ?? "unknown"}:${createUlid()}`,
        type: "provider.paused",
        payload: {
          provider,
          provider_label: providerLabel(provider),
          resume_at: row.resume_at,
          resume_source: row.resume_source,
          reported_resets_at: row.reported_resets_at,
          backoff_step: row.backoff_step,
          repeat: before !== undefined,
        },
      });
      return row;
    },

    async noteProviderSucceeded(providerInput, runStartedAt) {
      const provider = normalizeProvider(providerInput);
      const row = await options.store.noteProviderSucceeded(provider, runStartedAt);
      if (row?.state === "active") {
        const timer = timers.get(provider);
        if (timer !== undefined) clearTimer(timer);
        timers.delete(provider);
      }
      return row;
    },
  };
}

function normalizeProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "claude" || normalized === "anthropic") return "anthropic";
  if (normalized === "codex" || normalized === "openai/codex" || normalized === "openai") return "openai";
  return normalized;
}

function providerLabel(provider: string): string {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "openai") return "OpenAI";
  return provider;
}

function resumeDeadline(row: ProviderPauseRow, now: string): number {
  if (row.resume_at !== null) return Date.parse(row.resume_at);
  const base = row.paused_at ?? row.updated_at ?? now;
  return Date.parse(base) + FALLBACK_BACKOFF_MINUTES[Math.min(row.backoff_step, FALLBACK_BACKOFF_MINUTES.length - 1)] * 60_000;
}
