import { globToRegExp } from "./glob.js";

export const REVIEW_ROUTING_SETTINGS_KEY = "review_routing";

export const REVIEW_ROUTING_TASK_TYPES = ["code", "doc", "config", "test", "research"] as const;
export type ReviewRoutingTaskType = (typeof REVIEW_ROUTING_TASK_TYPES)[number];
export type ReviewDefault = "required" | "not_required";

export interface ReviewRoutingSettings {
  /** The review a Task of each type gets when the Manager did not say; Core only ever raises "not_required" to required. */
  readonly type_defaults: Readonly<Record<ReviewRoutingTaskType, ReviewDefault>>;
  /** Added + deleted lines above this force the Reviewer. */
  readonly max_changed_lines: number;
  /** Changed files above this force the Reviewer. */
  readonly max_changed_files: number;
  /** Group name -> globs; a changed path that matches any glob forces the Reviewer. */
  readonly sensitive_paths: Readonly<Record<string, readonly string[]>>;
  readonly force_on_hybrid_delegation: boolean;
  readonly force_on_gate_failure_history: boolean;
  readonly force_on_rejection_history: boolean;
}

export const DEFAULT_REVIEW_ROUTING_SETTINGS: ReviewRoutingSettings = {
  type_defaults: { code: "required", config: "required", doc: "not_required", test: "required", research: "not_required" },
  max_changed_lines: 80,
  max_changed_files: 3,
  sensitive_paths: {
    migration: ["**/migrations/**", "**/*.sql"],
    config: ["**/package.json", "**/pnpm-lock.yaml", "**/tsconfig*.json", "**/*.config.{js,cjs,mjs,ts}", ".github/**", "**/Dockerfile", "**/.env*"],
    auth: ["**/auth/**", "**/*auth*.{ts,js,mjs,py}", "**/*permission*.{ts,js,mjs,py}", "**/*session*.{ts,js,mjs,py}"],
    security: ["**/security/**", "**/*secret*", "**/*credential*", "**/*sandbox*.{ts,js,mjs}", "**/*csrf*.{ts,js,mjs}"],
  },
  force_on_hybrid_delegation: true,
  force_on_gate_failure_history: true,
  force_on_rejection_history: true,
};

export class ReviewRoutingSettingsValidationError extends Error {
  public constructor(message: string, public readonly field: string) {
    super(message);
    this.name = "ReviewRoutingSettingsValidationError";
  }
}

const MAX_GLOBS_PER_GROUP = 200;
const MAX_GROUPS = 50;
const MAX_TEXT = 500;
const LIMITS = { max_changed_lines: 100000, max_changed_files: 10000 } as const;
const TOP_KEYS = ["type_defaults", "max_changed_lines", "max_changed_files", "sensitive_paths", "force_on_hybrid_delegation", "force_on_gate_failure_history", "force_on_rejection_history"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function fail(field: string, message: string): never {
  throw new ReviewRoutingSettingsValidationError(message, field);
}

function validGlobs(field: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_GLOBS_PER_GROUP) fail(field, `${field} must be an array of at most ${MAX_GLOBS_PER_GROUP} globs.`);
  return value.map((glob) => {
    if (typeof glob !== "string" || glob.length === 0 || glob.length > MAX_TEXT) fail(field, `${field} must contain non-empty globs of at most ${MAX_TEXT} characters.`);
    try {
      globToRegExp(glob);
    } catch {
      fail(field, `${field} contains an invalid glob: ${glob}`);
    }
    return glob;
  });
}

/** For PUT: exact keys, integers in range, enums, globs that compile. */
export function validateReviewRoutingSettings(value: unknown): ReviewRoutingSettings {
  if (!isRecord(value)) fail("payload", "Settings must be an object.");
  if (!sameKeys(value, TOP_KEYS)) fail("payload", `Settings must contain exactly ${TOP_KEYS.join(", ")}.`);
  const defaults = value.type_defaults;
  if (!isRecord(defaults) || !sameKeys(defaults, REVIEW_ROUTING_TASK_TYPES)) fail("type_defaults", `type_defaults must contain exactly ${REVIEW_ROUTING_TASK_TYPES.join(", ")}.`);
  const typeDefaults = Object.fromEntries(REVIEW_ROUTING_TASK_TYPES.map((type) => {
    const entry = defaults[type];
    if (entry !== "required" && entry !== "not_required") fail(`type_defaults.${type}`, `type_defaults.${type} must be "required" or "not_required".`);
    return [type, entry];
  })) as Record<ReviewRoutingTaskType, ReviewDefault>;
  for (const key of ["max_changed_lines", "max_changed_files"] as const) {
    const number = value[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < 0 || number > LIMITS[key]) fail(key, `${key} must be an integer from 0 to ${LIMITS[key]}.`);
  }
  for (const key of ["force_on_hybrid_delegation", "force_on_gate_failure_history", "force_on_rejection_history"] as const) {
    if (typeof value[key] !== "boolean") fail(key, `${key} must be a boolean.`);
  }
  const paths = value.sensitive_paths;
  if (!isRecord(paths) || Reflect.ownKeys(paths).length > MAX_GROUPS) fail("sensitive_paths", `sensitive_paths must be an object of at most ${MAX_GROUPS} groups.`);
  const sensitive = Object.fromEntries(Object.entries(paths).map(([group, globs]) => {
    if (group.length === 0 || group.length > 100) fail("sensitive_paths", "sensitive_paths group names must be 1 to 100 characters.");
    return [group, validGlobs(`sensitive_paths.${group}`, globs)];
  }));
  return {
    type_defaults: typeDefaults,
    max_changed_lines: value.max_changed_lines as number,
    max_changed_files: value.max_changed_files as number,
    sensitive_paths: sensitive,
    force_on_hybrid_delegation: value.force_on_hybrid_delegation as boolean,
    force_on_gate_failure_history: value.force_on_gate_failure_history as boolean,
    force_on_rejection_history: value.force_on_rejection_history as boolean,
  };
}

/** For reads: each invalid or missing key falls back to its default and calls warn. */
export function readReviewRoutingSettings(value: unknown, warn?: (message: string) => void): ReviewRoutingSettings {
  const stored = isRecord(value) ? value : {};
  const defaults = DEFAULT_REVIEW_ROUTING_SETTINGS;
  const pick = <T>(key: string, fallback: T, check: (candidate: unknown) => T): T => {
    try {
      if (!Object.hasOwn(stored, key)) throw new Error("missing");
      return check(stored[key]);
    } catch {
      warn?.(`Invalid review routing ${key}; using default.`);
      return fallback;
    }
  };
  const only = (key: string) => (candidate: unknown) => {
    const probe = { ...defaults, [key]: candidate } as unknown;
    return (validateReviewRoutingSettings(probe) as unknown as Record<string, unknown>)[key];
  };
  return {
    type_defaults: pick("type_defaults", defaults.type_defaults, only("type_defaults") as (c: unknown) => ReviewRoutingSettings["type_defaults"]),
    max_changed_lines: pick("max_changed_lines", defaults.max_changed_lines, only("max_changed_lines") as (c: unknown) => number),
    max_changed_files: pick("max_changed_files", defaults.max_changed_files, only("max_changed_files") as (c: unknown) => number),
    sensitive_paths: pick("sensitive_paths", defaults.sensitive_paths, only("sensitive_paths") as (c: unknown) => ReviewRoutingSettings["sensitive_paths"]),
    force_on_hybrid_delegation: pick("force_on_hybrid_delegation", defaults.force_on_hybrid_delegation, only("force_on_hybrid_delegation") as (c: unknown) => boolean),
    force_on_gate_failure_history: pick("force_on_gate_failure_history", defaults.force_on_gate_failure_history, only("force_on_gate_failure_history") as (c: unknown) => boolean),
    force_on_rejection_history: pick("force_on_rejection_history", defaults.force_on_rejection_history, only("force_on_rejection_history") as (c: unknown) => boolean),
  };
}
