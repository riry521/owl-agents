import { isRecord } from "./settings-validation.js";

export const WORK_REVIEW_SETTINGS_KEY = "work_review";

export const WORK_REVIEW_SIZES = ["small", "normal", "large"] as const;

export interface WorkReviewSettings {
  /** Run the whole-Work review after the Tasks are merged. */
  readonly enabled: boolean;
  /** Work sizes that get the review. */
  readonly sizes: readonly (typeof WORK_REVIEW_SIZES)[number][];
  /** Run only when the Work counts at least this many Tasks. */
  readonly min_tasks: number;
  /** Most reviews since the last Owner decision. */
  readonly max_rounds: number;
}

export const DEFAULT_WORK_REVIEW_SETTINGS: WorkReviewSettings = {
  enabled: true,
  sizes: ["normal", "large"],
  min_tasks: 2,
  max_rounds: 2,
};

/** For reads: invalid or missing values fall back to the defaults, per key, and call warn. */
export function readWorkReviewSettings(value: unknown, warn?: (message: string) => void): WorkReviewSettings {
  const settings = isRecord(value) ? value : {};
  const d = DEFAULT_WORK_REVIEW_SETTINGS;
  const pick = <T>(name: string, ok: boolean, read: T, fallback: T): T => {
    if (ok) return read;
    warn?.(`Invalid work review ${name}; using default.`);
    return fallback;
  };
  const { enabled, sizes, min_tasks, max_rounds } = settings;
  const sizesOk = Array.isArray(sizes) && sizes.every((s) => (WORK_REVIEW_SIZES as readonly unknown[]).includes(s));
  return {
    enabled: pick("enabled", typeof enabled === "boolean", enabled as boolean, d.enabled),
    sizes: pick("sizes", sizesOk, sizesOk ? [...new Set(sizes as WorkReviewSettings["sizes"])] : d.sizes, d.sizes),
    min_tasks: pick("min_tasks", Number.isInteger(min_tasks) && (min_tasks as number) >= 2, min_tasks as number, d.min_tasks),
    max_rounds: pick("max_rounds", Number.isInteger(max_rounds) && (max_rounds as number) >= 1, max_rounds as number, d.max_rounds),
  };
}
