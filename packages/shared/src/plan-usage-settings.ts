import { exactKeysValidator, isRecord, SettingsValidationError } from "./settings-validation.js";
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

export class PlanUsageSettingsValidationError extends SettingsValidationError<"claude_usage_api_enabled" | "poll_interval_minutes" | "payload"> {
  public override name = "PlanUsageSettingsValidationError";
}

export const validatePlanUsageSettings = exactKeysValidator<PlanUsageSettings>({
  keys: ["claude_usage_api_enabled", "poll_interval_minutes"],
  exactKeysMessage: "Settings must contain exactly claude_usage_api_enabled and poll_interval_minutes.",
  check: (key, value) => {
    if (key === "claude_usage_api_enabled") {
      if (typeof value !== "boolean") {
        throw new PlanUsageSettingsValidationError("claude_usage_api_enabled must be a boolean.", "claude_usage_api_enabled", { kind: "boolean" });
      }
      return value;
    }
    if (typeof value !== "number" || !PLAN_USAGE_POLL_INTERVALS.includes(value)) {
      throw new PlanUsageSettingsValidationError("poll_interval_minutes is not supported.", "poll_interval_minutes", { kind: "one_of", values: PLAN_USAGE_POLL_INTERVALS });
    }
    return value;
  },
  error: PlanUsageSettingsValidationError,
});

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
