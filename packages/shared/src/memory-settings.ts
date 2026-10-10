export const MEMORY_MODE_SETTINGS_KEY = "memory_mode";
export const MEMORY_FOLDER_KINDS_SETTINGS_KEY = "memory_folder_kinds";
export const MEMORY_LIBRARIAN_SETTINGS_KEY = "memory_librarian";
export const MEMORY_RECALL_LIMIT_SETTINGS_KEY = "memory_recall_limit";
export const MEMORY_RECALL_MIN_SIMILARITY_SETTINGS_KEY = "memory_recall_min_similarity";

/** Research-clipping recall (design §8.5): at most this many lines per injection, each with at least this cosine similarity. */
export const DEFAULT_MEMORY_RECALL_LIMIT = 2;
export const DEFAULT_MEMORY_RECALL_MIN_SIMILARITY = 0.6;

export const MEMORY_ARCHIVE_SETTINGS_KEY = "memory_archive";
/** The `layout` value in `.owl-knowledge` that marks a vault the pages system has taken over. */
export const PAGES_LAYOUT = "pages-v1";

/** Where the pre-pages knowledge goes when the pages system first opens a vault. */
export interface MemoryArchive {
  /** Absolute path; "" means `<vault><DEFAULT_MEMORY_ARCHIVE_SUFFIX>` beside the vault. */
  readonly dir: string;
  /** Top-level vault entries that stay in the vault. */
  readonly exclude: readonly string[];
}
export const DEFAULT_MEMORY_ARCHIVE: MemoryArchive = { dir: "", exclude: [".obsidian"] };
export const DEFAULT_MEMORY_ARCHIVE_SUFFIX = ".archive";

export function readMemoryArchive(value: unknown): MemoryArchive {
  if (typeof value !== "object" || value === null) return DEFAULT_MEMORY_ARCHIVE;
  const { dir, exclude } = value as { dir?: unknown; exclude?: unknown };
  return {
    dir: typeof dir === "string" ? dir : DEFAULT_MEMORY_ARCHIVE.dir,
    exclude: Array.isArray(exclude) && exclude.every((x) => typeof x === "string") ? exclude : DEFAULT_MEMORY_ARCHIVE.exclude,
  };
}

export type MemoryMode = "legacy" | "pages";
export const DEFAULT_MEMORY_MODE: MemoryMode = "pages";

export const FOLDER_KIND_TYPES = ["clipping", "work-log"] as const;
export type FolderKindType = typeof FOLDER_KIND_TYPES[number];

export interface FolderKindRule {
  /** Vault-relative glob; only `**` and `*` are special. */
  readonly glob: string;
  readonly type: FolderKindType;
  /** `optional`: links into this folder need not resolve. */
  readonly links?: "optional";
}
export interface MemoryFolderKinds {
  readonly version: 1;
  readonly rules: readonly FolderKindRule[];
}

export const DEFAULT_MEMORY_FOLDER_KINDS: MemoryFolderKinds = {
  version: 1,
  rules: [
    { glob: "research/**", type: "clipping", links: "optional" },
    { glob: "works/**", type: "work-log" },
  ],
};

export const MEMORY_LIBRARIAN_PROVIDERS = ["anthropic", "claude", "openai", "codex"] as const;
export const MEMORY_LIBRARIAN_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export interface MemoryLibrarian {
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
}
/** Model for the migration / page-librarian LLM calls; independent of the model_settings roles. */
export const DEFAULT_MEMORY_LIBRARIAN: MemoryLibrarian = { provider: "anthropic", model: "claude-haiku-4-5-20251001", effort: "low" };

export class MemorySettingsValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MemorySettingsValidationError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Strict validation for settings writes. */
export function validateMemoryFolderKinds(value: unknown): MemoryFolderKinds {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.rules)) {
    throw new MemorySettingsValidationError("memory_folder_kinds must be {version: 1, rules: [...]}.");
  }
  const rules = value.rules.map((rule, i): FolderKindRule => {
    if (!isRecord(rule) || typeof rule.glob !== "string" || rule.glob === "" || rule.glob.startsWith("/") || rule.glob.includes("..")) {
      throw new MemorySettingsValidationError(`rules[${i}].glob must be a relative glob.`);
    }
    if (!(FOLDER_KIND_TYPES as readonly unknown[]).includes(rule.type)) {
      throw new MemorySettingsValidationError(`rules[${i}].type must be one of ${FOLDER_KIND_TYPES.join(", ")}.`);
    }
    if (rule.links !== undefined && rule.links !== "optional") throw new MemorySettingsValidationError(`rules[${i}].links must be "optional".`);
    return { glob: rule.glob, type: rule.type as FolderKindType, ...(rule.links ? { links: "optional" as const } : {}) };
  });
  return { version: 1, rules };
}

/** Tolerant parsing of stored values: anything invalid falls back to the default. */
export function readMemoryFolderKinds(value: unknown, warn?: (message: string) => void): MemoryFolderKinds {
  if (value === undefined || value === null) return DEFAULT_MEMORY_FOLDER_KINDS;
  try {
    return validateMemoryFolderKinds(value);
  } catch (error) {
    warn?.(`Invalid memory_folder_kinds; using defaults: ${(error as Error).message}`);
    return DEFAULT_MEMORY_FOLDER_KINDS;
  }
}

/** `pages` is the only mode. A `legacy` (or any other) value an older build saved is read as `pages`. */
export function readMemoryMode(_value: unknown): MemoryMode {
  return DEFAULT_MEMORY_MODE;
}

/** Strict validation for settings writes. */
export function validateMemoryLibrarian(value: unknown): MemoryLibrarian {
  if (!isRecord(value) || Object.keys(value).some((key) => !["provider", "model", "effort"].includes(key))) {
    throw new MemorySettingsValidationError("memory_librarian must be {provider, model, effort}.");
  }
  if (!(MEMORY_LIBRARIAN_PROVIDERS as readonly unknown[]).includes(value.provider)) {
    throw new MemorySettingsValidationError(`memory_librarian.provider must be one of ${MEMORY_LIBRARIAN_PROVIDERS.join(", ")}.`);
  }
  if (typeof value.model !== "string" || value.model.trim() === "") throw new MemorySettingsValidationError("memory_librarian.model must be a non-empty string.");
  if (!(MEMORY_LIBRARIAN_EFFORTS as readonly unknown[]).includes(value.effort)) {
    throw new MemorySettingsValidationError(`memory_librarian.effort must be one of ${MEMORY_LIBRARIAN_EFFORTS.join(", ")}.`);
  }
  return { provider: value.provider as string, model: value.model.trim(), effort: value.effort as string };
}

/** Tolerant parsing of stored values: anything invalid falls back to the default. */
export function readMemoryLibrarian(value: unknown, warn?: (message: string) => void): MemoryLibrarian {
  if (value === undefined) return DEFAULT_MEMORY_LIBRARIAN;
  try {
    return validateMemoryLibrarian(value);
  } catch (error) {
    warn?.(`Invalid memory_librarian; using defaults: ${(error as Error).message}`);
    return DEFAULT_MEMORY_LIBRARIAN;
  }
}

/** Integer 1–3; anything else gives the default. */
export function readMemoryRecallLimit(value: unknown, warn?: (message: string) => void): number {
  if (value === undefined || value === null) return DEFAULT_MEMORY_RECALL_LIMIT;
  if (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 3) return value as number;
  warn?.(`Invalid ${MEMORY_RECALL_LIMIT_SETTINGS_KEY}; using ${DEFAULT_MEMORY_RECALL_LIMIT}`);
  return DEFAULT_MEMORY_RECALL_LIMIT;
}

/** Number 0–1; anything else gives the default. */
export function readMemoryRecallMinSimilarity(value: unknown, warn?: (message: string) => void): number {
  if (value === undefined || value === null) return DEFAULT_MEMORY_RECALL_MIN_SIMILARITY;
  if (typeof value === "number" && value >= 0 && value <= 1) return value;
  warn?.(`Invalid ${MEMORY_RECALL_MIN_SIMILARITY_SETTINGS_KEY}; using ${DEFAULT_MEMORY_RECALL_MIN_SIMILARITY}`);
  return DEFAULT_MEMORY_RECALL_MIN_SIMILARITY;
}

export const MEMORY_LIBRARIAN_BATCH_SETTINGS_KEY = "memory_librarian_batch";

/** One librarian request takes at most this many conversation logs + clippings, and at most this many estimated input tokens in total. */
export interface MemoryLibrarianBatch {
  readonly max_items: number;
  readonly max_input_tokens: number;
  /** One run repeats batches up to this many times, while unread input, an over-limit excess or (with nothing over a limit) new lines keep shrinking. */
  readonly max_batches: number;
}
export const DEFAULT_MEMORY_LIBRARIAN_BATCH: MemoryLibrarianBatch = { max_items: 20, max_input_tokens: 60000, max_batches: 10 };
/** Upper bound of max_batches: one batch can use max_input_tokens, so this caps a night's cost. */
export const MEMORY_LIBRARIAN_MAX_BATCHES_LIMIT = 20;

/** Tolerant parsing of stored values: a field that is not a positive integer (max_batches: 1..MEMORY_LIBRARIAN_MAX_BATCHES_LIMIT) falls back to its default. */
export function readMemoryLibrarianBatch(value: unknown, warn?: (message: string) => void): MemoryLibrarianBatch {
  if (value === undefined || value === null) return DEFAULT_MEMORY_LIBRARIAN_BATCH;
  const record = isRecord(value) ? value : {};
  const pick = (key: keyof MemoryLibrarianBatch): number => {
    const v = record[key];
    // Why not clamp an out-of-range max_batches: every unusable value already falls back to the default; one rule for all.
    if (Number.isInteger(v) && (v as number) >= 1 && (key !== "max_batches" || (v as number) <= MEMORY_LIBRARIAN_MAX_BATCHES_LIMIT)) return v as number;
    warn?.(`Invalid ${MEMORY_LIBRARIAN_BATCH_SETTINGS_KEY}.${key}; using ${DEFAULT_MEMORY_LIBRARIAN_BATCH[key]}`);
    return DEFAULT_MEMORY_LIBRARIAN_BATCH[key];
  };
  return { max_items: pick("max_items"), max_input_tokens: pick("max_input_tokens"), max_batches: pick("max_batches") };
}
