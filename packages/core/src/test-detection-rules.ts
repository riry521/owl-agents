/** All paths are relative to the checkout root; only the root directory is looked at. */
export type TestDetectionCondition =
  | { readonly file: string; readonly contains?: string }
  | { readonly json_file: string; readonly key_path: readonly string[]; readonly matches?: string; readonly not_matches?: string }
  | { readonly any: readonly TestDetectionCondition[] }
  | { readonly not: TestDetectionCondition };

/** First candidate whose `when` all hold gives the prepare argv ([] = nothing to prepare). */
export interface TestDetectionPrepare {
  readonly when: readonly TestDetectionCondition[];
  readonly argv: readonly string[];
}

export type TestDetectionResult =
  | { readonly enabled: true; readonly mode: "per_file"; readonly file_argv?: readonly string[]; readonly test_patterns?: readonly string[]; readonly prepare: readonly TestDetectionPrepare[] }
  | { readonly enabled: true; readonly mode: "whole"; readonly whole_argv: readonly string[]; readonly test_patterns?: readonly string[]; readonly prepare: readonly TestDetectionPrepare[] }
  | { readonly enabled: false; readonly reason: string };

export interface TestDetectionRule {
  readonly id: string;
  /** All must hold. [] always holds (the last, catch-all rule). */
  readonly when: readonly TestDetectionCondition[];
  readonly result: TestDetectionResult;
}

export interface TestDetectionRules {
  /** "{pm}" in any argv becomes the name of the first entry whose file exists, else default_package_manager. */
  readonly package_managers: readonly { readonly file: string; readonly name: string }[];
  readonly default_package_manager: string;
  /** A marker file larger than this is read as absent. */
  readonly max_file_bytes: number;
  /** Tried in order; the first rule whose `when` all hold decides. */
  readonly rules: readonly TestDetectionRule[];
}

const script = (name: string): TestDetectionCondition => ({ json_file: "package.json", key_path: ["scripts", name] });
const run = (name: string): readonly string[] => ["{pm}", "run", name];

// per_file calls node directly, so pretest never runs on its own: run it once as the prepare step.
const nodePrepareForFiles: readonly TestDetectionPrepare[] = [
  { when: [script("test:prepare")], argv: run("test:prepare") },
  { when: [script("build")], argv: run("build") },
  { when: [script("pretest")], argv: run("pretest") },
];
// whole runs "{pm} test", which runs pretest by itself; build is still run explicitly when present.
const nodePrepareForWhole: readonly TestDetectionPrepare[] = [
  { when: [script("test:prepare")], argv: run("test:prepare") },
  { when: [script("build")], argv: run("build") },
  { when: [script("pretest")], argv: [] },
];
// The bun rules may match without a bun lockfile, so "{pm}" cannot be trusted to resolve to bun.
const bunPrepare: readonly TestDetectionPrepare[] = nodePrepareForWhole.map((entry) => ({ ...entry, argv: entry.argv.map((item) => (item === "{pm}" ? "bun" : item)) }));
const pytestMarker: TestDetectionCondition = {
  any: [
    { file: "pytest.ini" },
    { file: "conftest.py" },
    { file: "pyproject.toml", contains: "[tool.pytest" },
    { file: "setup.cfg", contains: "[tool:pytest]" },
    { file: "tox.ini", contains: "[pytest]" },
  ],
};
const wholeRule = (id: string, when: readonly TestDetectionCondition[], whole_argv: readonly string[]): TestDetectionRule => ({
  id, when, result: { enabled: true, mode: "whole", whole_argv, prepare: [] },
});
const bunLock: TestDetectionCondition = { any: [{ file: "bun.lock" }, { file: "bun.lockb" }] };
// package_managers lists pnpm and yarn before bun; a project that has their lockfile keeps its node-script result.
const noPnpmOrYarnLock: TestDetectionCondition = { not: { any: [{ file: "pnpm-lock.yaml" }, { file: "yarn.lock" }] } };
const offRule = (id: string, when: readonly TestDetectionCondition[], reason: string): TestDetectionRule => ({
  id, when, result: { enabled: false, reason },
});

export const DEFAULT_TEST_DETECTION_RULES: TestDetectionRules = {
  package_managers: [{ file: "pnpm-lock.yaml", name: "pnpm" }, { file: "yarn.lock", name: "yarn" }, { file: "bun.lock", name: "bun" }, { file: "bun.lockb", name: "bun" }],
  default_package_manager: "npm",
  max_file_bytes: 1048576,
  rules: [
    {
      id: "bun-test",
      when: [{ json_file: "package.json", key_path: ["scripts", "test"], matches: "^\\s*bun\\s+test(\\s|$)" }],
      result: { enabled: true, mode: "whole", whole_argv: ["bun", "test"], test_patterns: ["**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}", "**/*_test.{ts,tsx,js,jsx,mjs,cjs}"], prepare: bunPrepare },
    },
    {
      id: "node-test-runner",
      when: [
        { json_file: "package.json", key_path: ["scripts", "test"], matches: "^\\s*node\\s+--test(\\s|$)", not_matches: "--(import|require|loader|experimental)" },
      ],
      result: { enabled: true, mode: "per_file", prepare: nodePrepareForFiles },
    },
    {
      // bun test is bun's own runner, not what a custom scripts.test means, so run the script itself.
      id: "bun-script",
      when: [bunLock, noPnpmOrYarnLock, { json_file: "package.json", key_path: ["scripts", "test"], not_matches: "no test specified" }],
      result: { enabled: true, mode: "whole", whole_argv: ["bun", "run", "test"], prepare: bunPrepare },
    },
    {
      id: "node-script",
      when: [{ json_file: "package.json", key_path: ["scripts", "test"], not_matches: "no test specified" }],
      result: { enabled: true, mode: "whole", whole_argv: ["{pm}", "test"], prepare: nodePrepareForWhole },
    },
    wholeRule("pytest-uv", [{ file: "uv.lock" }, pytestMarker], ["uv", "run", "pytest"]),
    wholeRule("pytest-poetry", [{ file: "poetry.lock" }, pytestMarker], ["poetry", "run", "pytest"]),
    wholeRule("pytest", [pytestMarker], ["python3", "-m", "pytest"]),
    wholeRule("go", [{ file: "go.mod" }], ["go", "test", "./..."]),
    wholeRule("cargo", [{ file: "Cargo.toml" }], ["cargo", "test"]),
    offRule("node-no-test", [{ file: "package.json" }], "node_no_test_script"),
    offRule("python-no-pytest", [{ any: [{ file: "pyproject.toml" }, { file: "setup.py" }, { file: "setup.cfg" }, { file: "requirements.txt" }] }], "python_no_pytest_config"),
    offRule("none", [], "no_test_marker"),
  ],
};
