export const VERIFICATION_POLICY_SETTINGS_KEY = "verification_policy";

/** How a required section name is compared with a heading: "exact" or "folded" (Unicode NFKC, case-insensitive). */
export type SectionMatch = "exact" | "folded";

/** A glob (path.matchesGlob) and the argv Core runs for each matching file; "{file}" is the worktree-relative path. */
export interface PolicyCommand {
  readonly pattern: string;
  readonly argv: readonly string[];
}

export interface VerificationPolicySettings {
  readonly doc: {
    readonly file_patterns: readonly string[];
    /** Regular expression for one line; capture group 1 is the section name. */
    readonly heading_pattern: string;
    readonly section_match: SectionMatch;
    /** Sections every document Task must contain, in addition to the Manager's required_sections. */
    readonly required_sections: readonly string[];
  };
  readonly config: {
    readonly json_patterns: readonly string[];
    readonly yaml_patterns: readonly string[];
    readonly checkers: readonly PolicyCommand[];
    readonly skip_patterns: readonly string[];
  };
  readonly test: { readonly runners: readonly PolicyCommand[] };
  readonly code: {
    readonly checkers: readonly PolicyCommand[];
    readonly run_test_runners: boolean;
  };
  readonly limits: {
    readonly timeout_seconds: number;
    readonly stdout_limit_bytes: number;
    readonly stderr_limit_bytes: number;
    readonly max_files_per_check: number;
    readonly max_read_bytes: number;
    readonly env_allowlist: readonly string[];
  };
}

export type VerificationPolicyPatch = {
  readonly [K in keyof VerificationPolicySettings]?: Partial<VerificationPolicySettings[K]>;
};

export class VerificationPolicySettingsValidationError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
    this.name = "VerificationPolicySettingsValidationError";
  }
}

/** The one place the per-type verification rules are defined; settings override it per key. */
export const DEFAULT_VERIFICATION_POLICY_SETTINGS: VerificationPolicySettings = {
  doc: {
    file_patterns: ["**/*.md", "**/*.mdx", "**/*.txt", "**/*.rst", "**/*.adoc"],
    heading_pattern: "^#{1,6}\\s+(.*?)\\s*#*\\s*$",
    section_match: "folded",
    required_sections: [],
  },
  config: { json_patterns: ["**/*.json"], yaml_patterns: ["**/*.yml", "**/*.yaml"], checkers: [], skip_patterns: ["**/.env*"] },
  test: {
    runners: [
      { pattern: "**/*.test.{mjs,js,cjs}", argv: ["node", "--test", "{file}"] },
      { pattern: "**/{test_*,*_test}.py", argv: ["{python}", "-m", "pytest", "-q", "{file}"] },
    ],
  },
  code: {
    checkers: [
      { pattern: "**/*.{js,mjs,cjs}", argv: ["node", "--check", "{file}"] },
      { pattern: "**/*.py", argv: ["python3", "-c", "import ast,sys;ast.parse(open(sys.argv[1]).read())", "{file}"] },
      { pattern: "**/*.sh", argv: ["bash", "-n", "{file}"] },
    ],
    run_test_runners: true,
  },
  limits: { timeout_seconds: 120, stdout_limit_bytes: 65536, stderr_limit_bytes: 65536, max_files_per_check: 50, max_read_bytes: 1048576, env_allowlist: [] },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const stringList = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
const commandList = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.pattern === "string" && stringList(item.argv) && (item.argv as unknown[]).length > 0);
const sectionMatch = (value: unknown): boolean => value === "exact" || value === "folded";
const headingPattern = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  try {
    new RegExp(value);
    // The empty alternative always matches "", so the match length reveals whether capture group 1 exists.
    return (new RegExp(`(?:${value})|`).exec("")?.length ?? 0) >= 2;
  } catch {
    return false;
  }
};
const positiveInteger = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 1;
const boolean = (value: unknown): boolean => typeof value === "boolean";
const anyStrings = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === "string");

type StrictValidator = (value: unknown, field: string) => unknown;

function invalid(field: string, expected: string): never {
  throw new VerificationPolicySettingsValidationError(`${field} ${expected}.`, field);
}

function ownRecord(value: unknown, field: string, allowed: Readonly<Record<string, StrictValidator>>): Record<string, unknown> {
  if (!isRecord(value)) invalid(field, "must be an object");
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string" || !Object.hasOwn(allowed, key)) invalid(field, "contains an unknown key");
  }
  if (keys.length === 0) invalid(field, "must contain at least one known key");
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !Object.hasOwn(value, key)) invalid(field, "contains an unknown key");
    copy[key] = allowed[key](value[key], `${field}.${key}`);
  }
  return copy;
}

function strictStringList(value: unknown, field: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value)) invalid(field, "must be an array");
  const result: string[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) invalid(`${field}[${index}]`, "must be present");
    const item: unknown = value[index];
    if (typeof item !== "string" || (!allowEmpty && item.length === 0) || item.includes("\0")) invalid(`${field}[${index}]`, "must be a valid string");
    result.push(item);
  }
  return result;
}

function strictCommandList(value: unknown, field: string): PolicyCommand[] {
  if (!Array.isArray(value)) invalid(field, "must be an array");
  const result: PolicyCommand[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) invalid(`${field}[${index}]`, "must be present");
    const command: unknown = value[index];
    const commandField = `${field}[${index}]`;
    const copy = ownRecord(command, commandField, {
      pattern: (item, path) => {
        if (typeof item !== "string" || item.length === 0 || item.includes("\0")) invalid(path, "must be a non-empty string without NUL");
        return item;
      },
      argv: (item, path) => {
        const argv = strictStringList(item, path, false);
        if (argv.length === 0 || argv[0].trim().length === 0) invalid(path, "must contain a non-blank first argument");
        return argv;
      },
    });
    if (Reflect.ownKeys(copy).length !== 2 || !Object.hasOwn(copy, "pattern") || !Object.hasOwn(copy, "argv")) invalid(commandField, "must contain pattern and argv only");
    result.push(copy as unknown as PolicyCommand);
  }
  return result;
}

function strictHeadingPattern(value: unknown, field: string): string {
  if (!headingPattern(value)) invalid(field, "must be a valid regular expression with capture group 1");
  return value as string;
}

function strictPositiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(field, "must be a positive safe integer");
  return value;
}

function strictBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field, "must be a boolean");
  return value;
}

/** Strict validation for PATCH input; unlike reads, invalid values are rejected as a whole. */
export function validateVerificationPolicyPatch(value: unknown): VerificationPolicyPatch {
  const patch = ownRecord(value, "payload", {
    doc: (group, field) => ownRecord(group, field, {
      file_patterns: (item, path) => strictStringList(item, path, false),
      heading_pattern: strictHeadingPattern,
      section_match: (item, path) => {
        if (!sectionMatch(item)) invalid(path, "must be exact or folded");
        return item;
      },
      required_sections: (item, path) => strictStringList(item, path, false),
    }),
    config: (group, field) => ownRecord(group, field, {
      json_patterns: (item, path) => strictStringList(item, path, false),
      yaml_patterns: (item, path) => strictStringList(item, path, false),
      checkers: strictCommandList,
      skip_patterns: (item, path) => strictStringList(item, path, false),
    }),
    test: (group, field) => ownRecord(group, field, { runners: strictCommandList }),
    code: (group, field) => ownRecord(group, field, {
      checkers: strictCommandList,
      run_test_runners: strictBoolean,
    }),
    limits: (group, field) => ownRecord(group, field, {
      timeout_seconds: strictPositiveSafeInteger,
      stdout_limit_bytes: strictPositiveSafeInteger,
      stderr_limit_bytes: strictPositiveSafeInteger,
      max_files_per_check: strictPositiveSafeInteger,
      max_read_bytes: strictPositiveSafeInteger,
      env_allowlist: (item, path) => strictStringList(item, path, true),
    }),
  });
  return patch as VerificationPolicyPatch;
}

/** Take each own key from `stored` when it passes `valid`, else from `fallback`; invalid keys are reported through warn. */
function pick<T extends object>(stored: unknown, fallback: T, valid: Readonly<Record<keyof T, (value: unknown) => boolean>>, path: string, warn?: (message: string) => void): T {
  const source = isRecord(stored) ? stored : {};
  const result = { ...fallback };
  for (const key of Object.keys(fallback) as Array<keyof T & string>) {
    if (!Object.hasOwn(source, key)) continue;
    if (valid[key](source[key])) result[key] = source[key] as T[typeof key];
    else warn?.(`Invalid verification policy ${path}.${key}; using default.`);
  }
  return result;
}

/** For reads: missing or invalid values fall back to the defaults, per key, and call warn. */
export function readVerificationPolicySettings(value: unknown, warn?: (message: string) => void): VerificationPolicySettings {
  const root = isRecord(value) ? value : {};
  const d = DEFAULT_VERIFICATION_POLICY_SETTINGS;
  return {
    doc: pick(root.doc, d.doc, { file_patterns: stringList, heading_pattern: headingPattern, section_match: sectionMatch, required_sections: stringList }, "doc", warn),
    config: pick(root.config, d.config, { json_patterns: stringList, yaml_patterns: stringList, checkers: commandList, skip_patterns: stringList }, "config", warn),
    test: pick(root.test, d.test, { runners: commandList }, "test", warn),
    code: pick(root.code, d.code, { checkers: commandList, run_test_runners: boolean }, "code", warn),
    limits: pick(root.limits, d.limits, {
      timeout_seconds: positiveInteger, stdout_limit_bytes: positiveInteger, stderr_limit_bytes: positiveInteger,
      max_files_per_check: positiveInteger, max_read_bytes: positiveInteger, env_allowlist: anyStrings,
    }, "limits", warn),
  };
}
