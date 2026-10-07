export const REVIEW_LIMIT_SETTINGS_KEY = "review_limits";

export interface ReviewLimitSettings {
  /** Rejected reviews one plan may receive before the Task fails (the old review_round < 2). */
  readonly plan_review_rounds: number;
  /** Valid Reviewer verdicts one Task may use across Manager replans. */
  readonly total_review_attempts: number;
}

export const DEFAULT_REVIEW_LIMIT_SETTINGS: ReviewLimitSettings = { plan_review_rounds: 2, total_review_attempts: 6 };

export class ReviewLimitSettingsValidationError extends Error {
  public constructor(message: string, public readonly field: "plan_review_rounds" | "total_review_attempts" | "payload") {
    super(message);
    this.name = "ReviewLimitSettingsValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isPositiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;

/** For PUT: exact keys, integers, plan_review_rounds >= 1, total_review_attempts > plan_review_rounds. */
export function validateReviewLimitSettings(value: unknown): ReviewLimitSettings {
  if (!isRecord(value)) throw new ReviewLimitSettingsValidationError("Settings must be an object.", "payload");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("plan_review_rounds") || !keys.includes("total_review_attempts")) {
    throw new ReviewLimitSettingsValidationError("Settings must contain exactly plan_review_rounds and total_review_attempts.", "payload");
  }
  if (!isPositiveInteger(value.plan_review_rounds)) {
    throw new ReviewLimitSettingsValidationError("plan_review_rounds must be an integer >= 1.", "plan_review_rounds");
  }
  if (!isPositiveInteger(value.total_review_attempts) || value.total_review_attempts < value.plan_review_rounds + 1) {
    throw new ReviewLimitSettingsValidationError("total_review_attempts must be an integer >= plan_review_rounds + 1.", "total_review_attempts");
  }
  return { plan_review_rounds: value.plan_review_rounds, total_review_attempts: value.total_review_attempts };
}

/** For reads: invalid or missing values fall back to the defaults, per key, and call warn. */
export function readReviewLimitSettings(value: unknown, warn?: (message: string) => void): ReviewLimitSettings {
  const settings = isRecord(value) ? value : {};
  let planRounds = settings.plan_review_rounds;
  if (!isPositiveInteger(planRounds)) {
    warn?.("Invalid review limit plan_review_rounds; using default.");
    planRounds = DEFAULT_REVIEW_LIMIT_SETTINGS.plan_review_rounds;
  }
  let total = settings.total_review_attempts;
  if (!isPositiveInteger(total) || total < (planRounds as number) + 1) {
    warn?.("Invalid review limit total_review_attempts; using default.");
    total = Math.max(DEFAULT_REVIEW_LIMIT_SETTINGS.total_review_attempts, (planRounds as number) + 1);
  }
  return { plan_review_rounds: planRounds as number, total_review_attempts: total as number };
}
