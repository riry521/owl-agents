export const ADVISOR_WINDOW_SETTINGS_KEY = "advisor_windows";

export interface AdvisorWindowSettings {
  /** Seconds without activity before a window's session is suspended. */
  readonly idle_timeout_seconds: number;
  readonly channel_name_prefix: string;
  readonly channel_name_max_length: number;
  /** Recent messages handed to a fresh session when a suspended one cannot be resumed. */
  readonly history_handoff_messages: number;
  readonly project_backlog_limit: number;
  readonly handoff_summary_max_chars: number;
}

export type AdvisorWindowSettingsField = keyof AdvisorWindowSettings | "payload";

export const DEFAULT_ADVISOR_WINDOW_SETTINGS: AdvisorWindowSettings = {
  idle_timeout_seconds: 7200,
  channel_name_prefix: "owl-",
  channel_name_max_length: 80,
  history_handoff_messages: 20,
  project_backlog_limit: 20,
  handoff_summary_max_chars: 4000,
};

export class AdvisorWindowSettingsValidationError extends Error {
  public constructor(message: string, public readonly field: AdvisorWindowSettingsField) {
    super(message);
    this.name = "AdvisorWindowSettingsValidationError";
  }
}

const SETTING_KEYS = Object.keys(DEFAULT_ADVISOR_WINDOW_SETTINGS) as readonly (keyof AdvisorWindowSettings)[];
const INTEGER_RANGES = {
  idle_timeout_seconds: [60, 604_800],
  channel_name_max_length: [1, 80],
  history_handoff_messages: [0, 200],
  project_backlog_limit: [0, 200],
  handoff_summary_max_chars: [100, 20_000],
} as const;
const PREFIX_MAX_LENGTH = 20;
const PREFIX_PATTERN = /^[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*-?$/u;
const NAME_DISALLOWED = /[^\p{L}\p{N}\-_]/gu;
const codePointLength = (value: string): number => Array.from(value).length;

/** The prefix is concatenated as is, so it may end in one "-" separator that normalizeChannelName would strip. */
export function isValidChannelNamePrefix(prefix: string): boolean {
  if (prefix === "") return true;
  if (codePointLength(prefix) > PREFIX_MAX_LENGTH) return false;
  return prefix === prefix.normalize("NFKC").toLowerCase() && PREFIX_PATTERN.test(prefix);
}

const trimDashes = (value: string): string => value.replace(/^-+|-+$/gu, "");
const truncate = (value: string, maxLength: number): string => Array.from(value).slice(0, maxLength).join("");

/** Lowercase letters, digits, "-" and "_" only; no leading or trailing "-"; at most channel_name_max_length code points. */
export function normalizeChannelName(input: string, settings: Pick<AdvisorWindowSettings, "channel_name_max_length">): string {
  const cleaned = input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s./]/gu, "-")
    .replace(NAME_DISALLOWED, "")
    .replace(/-{2,}/gu, "-");
  return trimDashes(truncate(trimDashes(cleaned), settings.channel_name_max_length));
}

/** prefix + normalized project name; an empty name falls back to the last 8 characters of the project id. The prefix is never cut. */
export function defaultChannelName(
  projectName: string,
  projectId: string,
  settings: Pick<AdvisorWindowSettings, "channel_name_prefix" | "channel_name_max_length">,
): string {
  const prefix = settings.channel_name_prefix;
  const namePart = normalizeChannelName(projectName, settings) || projectId.slice(-8).toLowerCase();
  const room = Math.max(1, settings.channel_name_max_length - codePointLength(prefix));
  return `${prefix}${trimDashes(truncate(namePart, room))}`;
}

/** For PUT: exactly the six settings, each in range. */
export function validateAdvisorWindowSettings(value: unknown): AdvisorWindowSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AdvisorWindowSettingsValidationError("Settings must be an object.", "payload");
  }
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  const extra = keys.find((key) => typeof key !== "string" || !SETTING_KEYS.includes(key as keyof AdvisorWindowSettings));
  if (extra !== undefined || keys.length !== SETTING_KEYS.length) {
    throw new AdvisorWindowSettingsValidationError(`Settings must contain exactly ${SETTING_KEYS.join(", ")}.`, "payload");
  }
  for (const [field, [min, max]] of Object.entries(INTEGER_RANGES)) {
    const number = record[field];
    if (typeof number !== "number" || !Number.isInteger(number) || number < min || number > max) {
      throw new AdvisorWindowSettingsValidationError(`${field} must be an integer from ${min} to ${max}.`, field as keyof AdvisorWindowSettings);
    }
  }
  const prefix = record.channel_name_prefix;
  if (typeof prefix !== "string" || !isValidChannelNamePrefix(prefix)) {
    throw new AdvisorWindowSettingsValidationError(
      `channel_name_prefix must be at most ${PREFIX_MAX_LENGTH} lowercase letters, digits, "_" and single "-" separators, and may end in one "-".`,
      "channel_name_prefix",
    );
  }
  if ((record.channel_name_max_length as number) <= codePointLength(prefix)) {
    throw new AdvisorWindowSettingsValidationError("channel_name_max_length must be longer than channel_name_prefix.", "channel_name_max_length");
  }
  return Object.fromEntries(SETTING_KEYS.map((key) => [key, record[key]])) as unknown as AdvisorWindowSettings;
}

/** For reads: an invalid or missing value falls back to the default and calls warn. */
export function readAdvisorWindowSettings(value: unknown, warn?: (message: string) => void): AdvisorWindowSettings {
  try {
    return validateAdvisorWindowSettings(value);
  } catch (error) {
    if (!(error instanceof AdvisorWindowSettingsValidationError)) throw error;
    warn?.(`Invalid advisor window settings (${error.message}); using defaults.`);
    return DEFAULT_ADVISOR_WINDOW_SETTINGS;
  }
}
