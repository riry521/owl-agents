import { isRecord } from "./settings-validation.js";

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
