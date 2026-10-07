import type { PlanUsageHarness, PlanUsageOrigin, PlanUsageSnapshot, PlanUsageStatus } from "./plan-usage.js";

export const PLAN_USAGE_SETTINGS_KEY = "plan_usage";
export const PLAN_USAGE_POLL_INTERVALS: readonly number[] = [2, 5, 10, 15, 30, 60];

export interface PlanUsageSettings {
  readonly claude_usage_api_enabled: boolean;
  readonly poll_interval_minutes: number;
}

export const DEFAULT_PLAN_USAGE_SETTINGS: PlanUsageSettings = {
  claude_usage_api_enabled: true,
  poll_interval_minutes: 5,
};

export class PlanUsageSettingsValidationError extends Error {
  public constructor(message: string, public readonly field: "claude_usage_api_enabled" | "poll_interval_minutes" | "payload") {
    super(message);
    this.name = "PlanUsageSettingsValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactSettings(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new PlanUsageSettingsValidationError("Settings must be an object.", "payload");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("claude_usage_api_enabled") || !keys.includes("poll_interval_minutes")) {
    throw new PlanUsageSettingsValidationError("Settings must contain exactly claude_usage_api_enabled and poll_interval_minutes.", "payload");
  }
  return value;
}

function settingsFields(value: Record<string, unknown>): PlanUsageSettings {
  if (typeof value.claude_usage_api_enabled !== "boolean") {
    throw new PlanUsageSettingsValidationError("claude_usage_api_enabled must be a boolean.", "claude_usage_api_enabled");
  }
  if (typeof value.poll_interval_minutes !== "number" || !PLAN_USAGE_POLL_INTERVALS.includes(value.poll_interval_minutes)) {
    throw new PlanUsageSettingsValidationError("poll_interval_minutes is not supported.", "poll_interval_minutes");
  }
  return {
    claude_usage_api_enabled: value.claude_usage_api_enabled,
    poll_interval_minutes: value.poll_interval_minutes,
  };
}

export function validatePlanUsageSettings(value: unknown): PlanUsageSettings {
  return settingsFields(exactSettings(value));
}

export function readPlanUsageSettings(value: unknown, warn?: (message: string) => void): PlanUsageSettings {
  const settings = isRecord(value) ? value : {};
  const claudeUsageApiEnabled = typeof settings.claude_usage_api_enabled === "boolean"
    ? settings.claude_usage_api_enabled
    : DEFAULT_PLAN_USAGE_SETTINGS.claude_usage_api_enabled;
  if (typeof settings.claude_usage_api_enabled !== "boolean") {
    warn?.("Invalid plan usage claude_usage_api_enabled; using default.");
  }
  const pollIntervalMinutes = typeof settings.poll_interval_minutes === "number"
    && PLAN_USAGE_POLL_INTERVALS.includes(settings.poll_interval_minutes)
    ? settings.poll_interval_minutes
    : DEFAULT_PLAN_USAGE_SETTINGS.poll_interval_minutes;
  if (typeof settings.poll_interval_minutes !== "number" || !PLAN_USAGE_POLL_INTERVALS.includes(settings.poll_interval_minutes)) {
    warn?.("Invalid plan usage poll_interval_minutes; using default.");
  }
  return { claude_usage_api_enabled: claudeUsageApiEnabled, poll_interval_minutes: pollIntervalMinutes };
}

export interface PlanUsageHarnessView {
  readonly harness: PlanUsageHarness;
  readonly status: PlanUsageStatus;
  readonly detail: string | null;
  readonly display: PlanUsageSnapshot | null;
  readonly display_origin: PlanUsageOrigin | null;
  readonly fallback: boolean;
  readonly stale: boolean;
  readonly checked_at: string | null;
  readonly next_check_at: string | null;
}

export interface PlanUsageView {
  readonly generated_at: string;
  readonly settings: PlanUsageSettings;
  readonly claude: PlanUsageHarnessView;
  readonly codex: PlanUsageHarnessView;
}
