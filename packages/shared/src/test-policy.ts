/** Per-Project test handling set by the Owner; stored in projects.test_policy_json (apart from test_run so setting it never disables test detection). */
export interface TestPolicy {
  /** Commands (space-separated word prefixes) a Reviewer may not run, in addition to those derived from the test_run settings. */
  readonly reviewer_denied_commands: readonly string[];
  /** Commands (argv) Core runs in a Task worktree during verification and the Worker runs before reporting. */
  readonly check_commands: readonly (readonly string[])[];
}

/** The one place the defaults live. */
export const DEFAULT_TEST_POLICY: TestPolicy = {
  reviewer_denied_commands: [],
  check_commands: [],
};

const KEYS = Object.keys(DEFAULT_TEST_POLICY);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const boundedString = (value: unknown, max: number): boolean => typeof value === "string" && value.length >= 1 && value.length <= max;

/** API input check: the problems found as key names; [] when the value is a valid policy object. */
export function validateTestPolicy(value: unknown): string[] {
  if (!isRecord(value)) return ["test_policy"];
  const problems = Object.keys(value).filter((key) => !KEYS.includes(key));
  const denied = value.reviewer_denied_commands;
  if (denied !== undefined && !(Array.isArray(denied) && denied.length <= 20 && denied.every((item) => boundedString(item, 200)))) problems.push("reviewer_denied_commands");
  const checks = value.check_commands;
  if (checks !== undefined && !(Array.isArray(checks) && checks.length <= 10 && checks.every((argv) => Array.isArray(argv) && argv.length >= 1 && argv.every((word) => boundedString(word, 500))))) problems.push("check_commands");
  return problems;
}

/** NULL and missing keys read as the defaults; keys an older version saved and this one dropped are ignored; a stored value that is not a valid policy throws. */
export function readTestPolicy(json: string | null): TestPolicy {
  if (json === null) return DEFAULT_TEST_POLICY;
  const parsed: unknown = JSON.parse(json);
  const known = isRecord(parsed) ? Object.fromEntries(Object.entries(parsed).filter(([key]) => KEYS.includes(key))) : parsed;
  const problems = validateTestPolicy(known);
  if (problems.length > 0) throw new Error(`Stored test_policy is invalid: ${problems.join(", ")}`);
  return { ...DEFAULT_TEST_POLICY, ...(known as Partial<TestPolicy>) };
}
