/** A rewrite applied to a module path a test imports, so a built file maps back to its source. */
export interface SourceMapRule {
  /** Regular expression matched against the repo-relative import target. */
  readonly from: string;
  /** Replacement ($1 ...); the result is a repo-relative source path. */
  readonly to: string;
}

export const TEST_RUN_UNITS = ["file", "folder", "package"] as const;
export type TestRunUnit = (typeof TEST_RUN_UNITS)[number];

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
  /** argv run in order in cwd (relative paths are cwd-relative; "{name}" executables become absolute) before prepare_argv; the first failure stops the run ([] = nothing). Builds the test environment. */
  readonly setup_argvs: readonly (readonly string[])[];
  /** Files the setup depends on and what it makes, checkout-relative; the setup is skipped while those files are unchanged and the made paths exist. null = no record: always run the setup. */
  readonly setup_cache: { readonly inputs: readonly string[]; readonly outputs: readonly string[] } | null;
  /** Working directory of the test command, relative to the checkout root without "..". */
  readonly cwd: string;
  /** With mode per_file: what one command runs on (the order is the order an investigation tries). Unused by whole and off. */
  readonly unit: TestRunUnit;
  /** argv for one folder or package unit; contains "{unit}" exactly once and no "{file}" ([] = none). */
  readonly unit_argv: readonly string[];
  /** For unit "package": file name globs (no "/") that mark a package root. */
  readonly unit_markers: readonly string[];
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
  setup_argvs: [],
  setup_cache: null,
  cwd: ".",
  unit: "file",
  unit_argv: [],
  unit_markers: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const strings = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === "string");
const nonEmptyStrings = (value: unknown): boolean => strings(value) && (value as string[]).every((item) => item.length > 0);
const fileArgv = (value: unknown): boolean =>
  nonEmptyStrings(value) && (value as string[]).length > 0 && (value as string[]).filter((item) => item === "{file}").length === 1 && !(value as string[]).includes("{unit}");
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
const wholeArgv = (value: unknown): boolean => nonEmptyStrings(value) && !(value as string[]).includes("{file}") && !(value as string[]).includes("{unit}");
const unit = (value: unknown): boolean => (TEST_RUN_UNITS as readonly unknown[]).includes(value);
const unitArgv = (value: unknown): boolean =>
  nonEmptyStrings(value) && ((value as string[]).length === 0 || ((value as string[]).filter((item) => item === "{unit}").length === 1 && !(value as string[]).includes("{file}")));
const unitMarkers = (value: unknown): boolean =>
  nonEmptyStrings(value) && (value as string[]).every((item) => !/[\\/]/u.test(item) && item !== "." && item !== "..");

const setupArgvs = (value: unknown): boolean => Array.isArray(value) && value.every((argv) => nonEmptyStrings(argv) && (argv as string[]).length > 0);
const relativePaths = (value: unknown): boolean => nonEmptyStrings(value) && (value as string[]).every((item) => !item.startsWith("/") && !item.split(/[\\/]/u).includes(".."));
const setupCache = (value: unknown): boolean => value === null || (isRecord(value) && relativePaths(value.inputs) && relativePaths(value.outputs));
const relativeCwd =(value: unknown): boolean =>
  typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.split(/[\\/]/u).includes("..");

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
  setup_argvs: setupArgvs,
  setup_cache: setupCache,
  cwd: relativeCwd,
  unit,
  unit_argv: unitArgv,
  unit_markers: unitMarkers,
};

/** The message for a unit that cannot run with the other settings, or null. */
function unitProblem(mode: unknown, unitValue: unknown, argv: unknown, markers: unknown): string | null {
  const empty = (list: unknown): boolean => !Array.isArray(list) || list.length === 0;
  if (unitValue === "file") return null;
  if (mode !== "per_file") return 'test_run.unit must be "file" unless mode is per_file';
  if (empty(argv)) return "test_run.unit_argv is required when unit is folder or package";
  if (unitValue === "package" && empty(markers)) return "test_run.unit_markers is required when unit is package";
  return null;
}

/** The argv Core runs: whole_argv for whole, unit_argv for a folder or package unit, file_argv otherwise. */
export function runArgvOf(settings: TestRunSettings): readonly string[] {
  if (settings.mode === "whole") return settings.whole_argv;
  return settings.unit === "file" ? settings.file_argv : settings.unit_argv;
}

/** "{unit}" for a folder or package unit, "{file}" otherwise. */
export function targetPlaceholderOf(settings: TestRunSettings): "{file}" | "{unit}" {
  return settings.mode === "per_file" && settings.unit !== "file" ? "{unit}" : "{file}";
}

/** For reads: each invalid or missing key falls back to its default; invalid ones are reported through warn. */
export function readTestRunSettings(value: unknown, warn?: (message: string) => void): TestRunSettings {
  const source = isRecord(value) ? value : {};
  const result: Record<string, unknown> = { ...DEFAULT_TEST_RUN_SETTINGS };
  for (const key of Object.keys(VALIDATORS) as Array<keyof TestRunSettings>) {
    if (!Object.hasOwn(source, key)) continue;
    if (VALIDATORS[key](source[key])) result[key] = source[key];
    else warn?.(`Invalid test_run.${key}; using default.`);
  }
  const settings = result as unknown as TestRunSettings;
  const problem = unitProblem(settings.mode, settings.unit, settings.unit_argv, settings.unit_markers);
  if (problem !== null) {
    warn?.(`Invalid test_run.unit (${problem}); using "file".`);
    return { ...settings, unit: "file" };
  }
  return settings;
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
  if (unit(value.unit)) {
    const problem = unitProblem(value.mode ?? DEFAULT_TEST_RUN_SETTINGS.mode, value.unit, value.unit_argv, value.unit_markers);
    if (problem !== null) errors.push(problem);
  }
  return errors;
}
