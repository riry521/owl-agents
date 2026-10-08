export const REVIEW_FOCUS_SETTINGS_KEY = "review_focus";

export interface ReviewFocusSettings {
  /** Consecutive fix_required reviews pointing at the same spot before the Task goes back to the Manager. */
  readonly same_spot_threshold: number;
  /** Two findings in one file are the same spot when their lines are at most this far apart. */
  readonly same_spot_line_distance: number;
  /** Review attempts handed back each time the Manager replans the Task. */
  readonly replan_refund: number;
  /** Most review attempts one Task may get back in total, so replans cannot go on forever. */
  readonly refund_limit: number;
}

export const DEFAULT_REVIEW_FOCUS_SETTINGS: ReviewFocusSettings = {
  same_spot_threshold: 3,
  same_spot_line_distance: 20,
  replan_refund: 2,
  refund_limit: 4,
};

const MINIMUMS: Record<keyof ReviewFocusSettings, number> = { same_spot_threshold: 2, same_spot_line_distance: 0, replan_refund: 0, refund_limit: 0 };

/** For reads: per-key fallback to the default (a key never saved falls back silently), calling warn for an invalid one. */
export function readReviewFocusSettings(value: unknown, warn?: (message: string) => void): ReviewFocusSettings {
  const stored = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const entries = (Object.keys(DEFAULT_REVIEW_FOCUS_SETTINGS) as (keyof ReviewFocusSettings)[]).map((key) => {
    const candidate = stored[key];
    if (candidate === undefined) return [key, DEFAULT_REVIEW_FOCUS_SETTINGS[key]];
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= MINIMUMS[key]) return [key, candidate];
    warn?.(`Invalid review focus setting ${key}; using default.`);
    return [key, DEFAULT_REVIEW_FOCUS_SETTINGS[key]];
  });
  return Object.fromEntries(entries) as unknown as ReviewFocusSettings;
}
