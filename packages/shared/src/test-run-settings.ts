/** A rewrite applied to a module path a test imports, so a built file maps back to its source. */
export interface SourceMapRule {
  /** Regular expression matched against the repo-relative import target. */
  readonly from: string;
  /** Replacement ($1 ...); the result is a repo-relative source path. */
  readonly to: string;
}

export interface TestRunSettings {
  /** Globs (path.matchesGlob) that tell a test file from other files. */
  readonly test_patterns: readonly string[];
  /** Run once per checkout before the tests ([] = nothing). */
  readonly prepare_argv: readonly string[];
  /** argv for one test file; contains "{file}" exactly once and must print TAP. */
  readonly file_argv: readonly string[];
  /** A changed file matching one of these makes a Work-level run select every test file. */
  readonly full_run_patterns: readonly string[];
  readonly source_map: readonly SourceMapRule[];
  /** null = max(1, floor(availableParallelism / 2)) */
  readonly concurrency: number | null;
  readonly file_timeout_seconds: number;
  readonly prepare_timeout_seconds: number;
  readonly output_limit_bytes: number;
  /** Times a failed file is run again on its own (0 = never). */
  readonly flaky_retries: number;
  readonly output_tail_chars: number;
  readonly brief_message_chars: number;
  readonly brief_max_failures: number;
  /** Extra environment variable names passed to child processes (PATH and HOME always are). */
  readonly env_allowlist: readonly string[];
  /** per_file: file_argv once per selected file (TAP). whole: whole_argv once, pass = exit 0. off: Core does not run tests. */
  readonly mode: "per_file" | "whole" | "off";
  /** argv run once in the checkout root for mode "whole" (no {file}). */
  readonly whole_argv: readonly string[];
  readonly whole_timeout_seconds: number;
}

/** The one place the defaults live; a Project's test_run JSON overrides it per key. */
export const DEFAULT_TEST_RUN_SETTINGS: TestRunSettings = {
  test_patterns: ["**/*.test.{mjs,js,cjs}"],
  prepare_argv: [],
  file_argv: ["node", "--test", "--test-reporter=tap", "{file}"],
  full_run_patterns: [
    "package.json", "**/package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock",
    "**/tsconfig*.json", "**/helpers/**", "**/fixtures/**",
  ],
  source_map: [{ from: "^(packages|apps)/([^/]+)/dist/(.*)\\.js$", to: "$1/$2/src/$3.ts" }],
  concurrency: null,
  file_timeout_seconds: 300,
  prepare_timeout_seconds: 1800,
  output_limit_bytes: 1048576,
  flaky_retries: 1,
  output_tail_chars: 8000,
  brief_message_chars: 300,
  brief_max_failures: 20,
  env_allowlist: [],
  mode: "per_file",
  whole_argv: [],
  whole_timeout_seconds: 1800,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const strings = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === "string");
const nonEmptyStrings = (value: unknown): boolean => strings(value) && (value as string[]).every((item) => item.length > 0);
const fileArgv = (value: unknown): boolean => nonEmptyStrings(value) && (value as string[]).length > 0 && (value as string[]).filter((item) => item === "{file}").length === 1;
const integerAtLeast = (min: number) => (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= min;
const concurrency = (value: unknown): boolean => value === null || integerAtLeast(1)(value);
const sourceMap = (value: unknown): boolean =>
  Array.isArray(value) && value.every((rule) => {
    if (!isRecord(rule) || typeof rule.from !== "string" || typeof rule.to !== "string") return false;
    try {
      new RegExp(rule.from);
      return true;
    } catch {
      return false;
    }
  });

const mode = (value: unknown): boolean => value === "per_file" || value === "whole" || value === "off";
const wholeArgv = (value: unknown): boolean => nonEmptyStrings(value) && !(value as string[]).includes("{file}");

const VALIDATORS: Readonly<Record<keyof TestRunSettings, (value: unknown) => boolean>> = {
  test_patterns: nonEmptyStrings,
  prepare_argv: nonEmptyStrings,
  file_argv: fileArgv,
  full_run_patterns: nonEmptyStrings,
  source_map: sourceMap,
  concurrency,
  file_timeout_seconds: integerAtLeast(1),
  prepare_timeout_seconds: integerAtLeast(1),
  output_limit_bytes: integerAtLeast(1),
  flaky_retries: integerAtLeast(0),
  output_tail_chars: integerAtLeast(1),
  brief_message_chars: integerAtLeast(1),
  brief_max_failures: integerAtLeast(1),
  env_allowlist: nonEmptyStrings,
  mode,
  whole_argv: wholeArgv,
  whole_timeout_seconds: integerAtLeast(1),
};

/** For reads: each invalid or missing key falls back to its default; invalid ones are reported through warn. */
export function readTestRunSettings(value: unknown, warn?: (message: string) => void): TestRunSettings {
  const source = isRecord(value) ? value : {};
  const result: Record<string, unknown> = { ...DEFAULT_TEST_RUN_SETTINGS };
  for (const key of Object.keys(VALIDATORS) as Array<keyof TestRunSettings>) {
    if (!Object.hasOwn(source, key)) continue;
    if (VALIDATORS[key](source[key])) result[key] = source[key];
    else warn?.(`Invalid test_run.${key}; using default.`);
  }
  return result as unknown as TestRunSettings;
}

/** For writes: one message per invalid key ([] = valid). */
export function validateTestRunSettings(value: unknown): string[] {
  if (!isRecord(value)) return ["test_run must be an object"];
  const errors: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    const valid = Object.hasOwn(VALIDATORS, key) ? VALIDATORS[key as keyof TestRunSettings] : undefined;
    if (valid === undefined) errors.push(`test_run.${key} is not a known key`);
    else if (!valid(item)) errors.push(`test_run.${key} is invalid`);
  }
  if (value.mode === "whole" && !(Array.isArray(value.whole_argv) && value.whole_argv.length > 0)) errors.push("test_run.whole_argv is required when mode is whole");
  return errors;
}
