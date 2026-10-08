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
      { pattern: "**/{test_*,*_test}.py", argv: ["python3", "-m", "pytest", "-q", "{file}"] },
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
