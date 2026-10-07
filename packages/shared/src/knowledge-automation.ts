export const KNOWLEDGE_AUTOMATION_SETTINGS_KEY = "knowledge_automation";
export const DEFAULT_LIBRARIAN_TIMES: readonly string[] = ["03:00", "15:00"];
export const MAX_LIBRARIAN_TIMES = 24;
export const DEFAULT_RESEARCH_SOURCE_LINKS = 5;
export const DEFAULT_RESEARCH_SOURCE_LINKS_MAX = 20;
export const DEFAULT_RESEARCH_TAGS_MIN = 3;
export const DEFAULT_RESEARCH_TAGS_MAX = 5;
export const DEFAULT_RESEARCH_EXISTING_TAGS_MAX = 50;
export const LIBRARIAN_TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u;

export interface KnowledgeAutomationSettings {
  readonly librarian_times: readonly string[];
  readonly research_autosave: boolean;
  /** Top WebSearch result links a clipping lists under 出典; omitted means the default. */
  readonly research_source_links?: number;
  /** Upper bound for research_source_links; omitted means the default. */
  readonly research_source_links_max?: number;
  /** Content tags a clipping gets (range); omitted means the default. */
  readonly research_tags_min?: number;
  readonly research_tags_max?: number;
  /** Existing tags offered to the tagger, most used first; omitted means the default. */
  readonly research_existing_tags_max?: number;
}

export interface KnowledgeAutomationSnapshot extends KnowledgeAutomationSettings {
  readonly next_librarian_run_at: string | null;
  readonly time_zone: string;
}

export const DEFAULT_KNOWLEDGE_AUTOMATION_SETTINGS: KnowledgeAutomationSettings = {
  librarian_times: DEFAULT_LIBRARIAN_TIMES,
  research_autosave: true,
  research_source_links: DEFAULT_RESEARCH_SOURCE_LINKS,
  research_source_links_max: DEFAULT_RESEARCH_SOURCE_LINKS_MAX,
  research_tags_min: DEFAULT_RESEARCH_TAGS_MIN,
  research_tags_max: DEFAULT_RESEARCH_TAGS_MAX,
};

function isCount(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

export class KnowledgeAutomationValidationError extends Error {
  public constructor(message: string, public readonly field: "librarian_times" | "research_autosave" | "research_source_links" | "research_source_links_max" | "research_tags_min" | "research_tags_max" | "research_existing_tags_max" | "payload") {
    super(message);
    this.name = "KnowledgeAutomationValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLibrarianTimes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new KnowledgeAutomationValidationError("librarian_times must be an array.", "librarian_times");
  }
  const uniqueTimes = new Set<string>();
  for (const time of value) {
    if (typeof time !== "string" || !LIBRARIAN_TIME_PATTERN.test(time)) {
      throw new KnowledgeAutomationValidationError("librarian_times must contain valid HH:MM times.", "librarian_times");
    }
    uniqueTimes.add(time);
  }
  const times = [...uniqueTimes].sort();
  if (times.length > MAX_LIBRARIAN_TIMES) {
    throw new KnowledgeAutomationValidationError(`librarian_times must contain at most ${MAX_LIBRARIAN_TIMES} times.`, "librarian_times");
  }
  return times;
}

/** Strict validation for settings writes; successful values are deduplicated and sorted. */
export function validateKnowledgeAutomationSettings(value: unknown): KnowledgeAutomationSettings {
  if (!isRecord(value)) {
    throw new KnowledgeAutomationValidationError("Settings must be an object.", "payload");
  }
  const keys = Reflect.ownKeys(value);
  const optional = ["research_source_links", "research_source_links_max", "research_tags_min", "research_tags_max", "research_existing_tags_max"].filter((key) => keys.includes(key));
  if (keys.length !== 2 + optional.length || !keys.includes("librarian_times") || !keys.includes("research_autosave")) {
    throw new KnowledgeAutomationValidationError("Settings must contain librarian_times, research_autosave and optionally research_source_links and research_source_links_max.", "payload");
  }
  const max = value.research_source_links_max;
  if (optional.includes("research_source_links_max") && !isCount(max)) {
    throw new KnowledgeAutomationValidationError("research_source_links_max must be a non-negative integer.", "research_source_links_max");
  }
  if (optional.includes("research_source_links") && !isCount(value.research_source_links, isCount(max) ? max : DEFAULT_RESEARCH_SOURCE_LINKS_MAX)) {
    throw new KnowledgeAutomationValidationError("research_source_links must be a non-negative integer within research_source_links_max.", "research_source_links");
  }
  const tagsMin = value.research_tags_min;
  const tagsMax = value.research_tags_max;
  if (optional.includes("research_tags_min") && !(isCount(tagsMin) && tagsMin >= 1)) {
    throw new KnowledgeAutomationValidationError("research_tags_min must be a positive integer.", "research_tags_min");
  }
  if (optional.includes("research_tags_max") && !(isCount(tagsMax) && tagsMax >= 1 && tagsMax >= (isCount(tagsMin) ? tagsMin : 1))) {
    throw new KnowledgeAutomationValidationError("research_tags_max must be a positive integer not below research_tags_min.", "research_tags_max");
  }
  if (optional.includes("research_existing_tags_max") && !(isCount(value.research_existing_tags_max) && value.research_existing_tags_max >= 1)) {
    throw new KnowledgeAutomationValidationError("research_existing_tags_max must be a positive integer.", "research_existing_tags_max");
  }
  if (typeof value.research_autosave !== "boolean") {
    throw new KnowledgeAutomationValidationError("research_autosave must be a boolean.", "research_autosave");
  }
  return {
    librarian_times: normalizeLibrarianTimes(value.librarian_times),
    research_autosave: value.research_autosave,
    ...(optional.includes("research_source_links") ? { research_source_links: value.research_source_links as number } : {}),
    ...(optional.includes("research_source_links_max") ? { research_source_links_max: max as number } : {}),
    ...(optional.includes("research_tags_min") ? { research_tags_min: tagsMin as number } : {}),
    ...(optional.includes("research_tags_max") ? { research_tags_max: tagsMax as number } : {}),
    ...(optional.includes("research_existing_tags_max") ? { research_existing_tags_max: value.research_existing_tags_max as number } : {}),
  };
}

/** Tolerant parsing for stored settings; invalid fields independently fall back to defaults. */
export function readKnowledgeAutomationSettings(
  value: unknown,
  warn?: (message: string) => void,
): KnowledgeAutomationSettings {
  const settings = isRecord(value) ? value : {};
  let librarian_times: readonly string[];
  try {
    librarian_times = normalizeLibrarianTimes(settings.librarian_times);
  } catch {
    librarian_times = DEFAULT_KNOWLEDGE_AUTOMATION_SETTINGS.librarian_times;
    warn?.("Invalid knowledge automation librarian_times; using defaults.");
  }
  let research_autosave: boolean;
  if (typeof settings.research_autosave === "boolean") {
    research_autosave = settings.research_autosave;
  } else {
    research_autosave = DEFAULT_KNOWLEDGE_AUTOMATION_SETTINGS.research_autosave;
    warn?.("Invalid knowledge automation research_autosave; using defaults.");
  }
  let research_source_links_max = DEFAULT_RESEARCH_SOURCE_LINKS_MAX;
  if (settings.research_source_links_max !== undefined) {
    if (isCount(settings.research_source_links_max)) research_source_links_max = settings.research_source_links_max;
    else warn?.("Invalid knowledge automation research_source_links_max; using defaults.");
  }
  let research_source_links = Math.min(DEFAULT_RESEARCH_SOURCE_LINKS, research_source_links_max);
  if (settings.research_source_links !== undefined) {
    if (isCount(settings.research_source_links, research_source_links_max)) research_source_links = settings.research_source_links;
    else warn?.("Invalid knowledge automation research_source_links; using defaults.");
  }
  let research_tags_min = DEFAULT_RESEARCH_TAGS_MIN;
  let research_tags_max = DEFAULT_RESEARCH_TAGS_MAX;
  const { research_tags_min: minValue, research_tags_max: maxValue } = settings;
  if (minValue !== undefined || maxValue !== undefined) {
    const min = minValue === undefined ? (isCount(maxValue) ? Math.min(DEFAULT_RESEARCH_TAGS_MIN, maxValue) : DEFAULT_RESEARCH_TAGS_MIN) : minValue;
    const max = maxValue === undefined ? Math.max(min as number, DEFAULT_RESEARCH_TAGS_MAX) : maxValue;
    if (isCount(min) && isCount(max) && min >= 1 && max >= min) { research_tags_min = min; research_tags_max = max; }
    else warn?.("Invalid knowledge automation research_tags range; using defaults.");
  }
  const existingMax = settings.research_existing_tags_max;
  const existingValid = isCount(existingMax) && existingMax >= 1;
  if (existingMax !== undefined && !existingValid) warn?.("Invalid knowledge automation research_existing_tags_max; using defaults.");
  return {
    librarian_times, research_autosave, research_source_links, research_source_links_max, research_tags_min, research_tags_max,
    ...(existingValid ? { research_existing_tags_max: existingMax } : {}),
  };
}
