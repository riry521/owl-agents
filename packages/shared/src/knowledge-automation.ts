export const KNOWLEDGE_AUTOMATION_SETTINGS_KEY = "knowledge_automation";
export const DEFAULT_LIBRARIAN_TIMES: readonly string[] = ["03:00", "15:00"];
export const MAX_LIBRARIAN_TIMES = 24;
export const LIBRARIAN_TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u;

export interface KnowledgeAutomationSettings {
  readonly librarian_times: readonly string[];
  readonly research_autosave: boolean;
}

export interface KnowledgeAutomationSnapshot extends KnowledgeAutomationSettings {
  readonly next_librarian_run_at: string | null;
  readonly time_zone: string;
}

export const DEFAULT_KNOWLEDGE_AUTOMATION_SETTINGS: KnowledgeAutomationSettings = {
  librarian_times: DEFAULT_LIBRARIAN_TIMES,
  research_autosave: true,
};

export class KnowledgeAutomationValidationError extends Error {
  public constructor(message: string, public readonly field: "librarian_times" | "research_autosave" | "payload") {
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
  if (keys.length !== 2 || !keys.includes("librarian_times") || !keys.includes("research_autosave")) {
    throw new KnowledgeAutomationValidationError("Settings must contain exactly librarian_times and research_autosave.", "payload");
  }
  if (typeof value.research_autosave !== "boolean") {
    throw new KnowledgeAutomationValidationError("research_autosave must be a boolean.", "research_autosave");
  }
  return {
    librarian_times: normalizeLibrarianTimes(value.librarian_times),
    research_autosave: value.research_autosave,
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
  return { librarian_times, research_autosave };
}
