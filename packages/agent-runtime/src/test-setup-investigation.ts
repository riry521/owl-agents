import { OutputFormatError } from "./output-resubmit";
import {
  extractRoleOutputObject,
  objectSchema,
  providerSchema,
  renderRolePrompt,
  validateRoleOutput,
  type RoleSchema,
} from "./role-contract";
import { TEST_RUN_UNITS, type TestRunSettings } from "../../shared/dist/test-run-settings.js";
import type { TestSetupBootstrap } from "../../shared/dist/test-setup-settings.js";
import type { ProviderResponse } from "./types";

export const TEST_SETUP_VERDICTS = ["ready", "tests_failing", "no_tests", "no_language", "needs_owner", "code_problem"] as const;
export type TestSetupVerdict = (typeof TEST_SETUP_VERDICTS)[number];
export const TEST_SETUP_TRIGGERS = ["project_registered", "project_path_changed", "inputs_changed", "environment_failure", "manual"] as const;
export type TestSetupTrigger = (typeof TEST_SETUP_TRIGGERS)[number];

export interface TestSetupFirstCandidate {
  readonly rule_id: string;
  readonly mode: "per_file" | "whole" | "off";
  readonly prepare_argv: readonly string[];
  readonly argv: readonly string[];
}

export interface TestSetupInvestigationRequest {
  /** Core makes it; the guard finds the run's checkouts with it. */
  readonly invocation_id: string;
  readonly project: { readonly id: string; readonly name: string };
  readonly scope: "project" | "work" | "task";
  /** Absolute path of the folder to investigate; the agent's cwd. */
  readonly checkout: string;
  readonly trigger: TestSetupTrigger;
  readonly mode: "find" | "repair_explicit";
  readonly explicit_test_run: Partial<TestRunSettings> | null;
  readonly first_candidate: TestSetupFirstCandidate | null;
  /** The record in use, as stored (attempts already cut to the settings' count). */
  readonly current: Readonly<Record<string, unknown>> | null;
  readonly failure: { readonly argv: readonly string[]; readonly exit_code: number | null; readonly signal: string; readonly evidence: string } | null;
  readonly approved_installs: readonly (readonly string[])[];
  readonly bootstrap: Readonly<Record<string, TestSetupBootstrap>>;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly role: "worker" | "manager";
  readonly timeout_ms: number;
  readonly env: Readonly<Record<string, string>>;
}

export interface TestSetupInvestigationOutput {
  readonly verdict: TestSetupVerdict;
  readonly setup_argvs: readonly (readonly string[])[];
  /** Files setup_argvs and prepare_argv read (requirements, lock files), relative to the checkout; Core re-runs the setup when their content changes. */
  readonly setup_inputs: readonly string[];
  /** What setup_argvs make (.venv, node_modules), relative to the checkout; Core re-runs the setup when one is missing. */
  readonly setup_outputs: readonly string[];
  readonly test_run: {
    readonly mode: "per_file" | "whole";
    readonly whole_argv: readonly string[];
    readonly file_argv: readonly string[];
    readonly prepare_argv: readonly string[];
    readonly test_patterns: readonly string[];
    readonly cwd: string;
    readonly unit: (typeof TEST_RUN_UNITS)[number];
    readonly unit_argv: readonly string[];
    readonly unit_markers: readonly string[];
  } | null;
  /** A list rather than a map: the output schema has no free-form keys. */
  readonly executables: readonly { readonly name: string; readonly path: string; readonly probe_argv: readonly string[] }[];
  readonly confirm_files: readonly string[];
  readonly probe_argvs: readonly (readonly string[])[];
  readonly sources: readonly string[];
  readonly attempts: readonly { readonly argv: readonly string[]; readonly cwd: string; readonly exit_code: number | null; readonly summary: string; readonly unit: "" | (typeof TEST_RUN_UNITS)[number] }[];
  readonly installed: readonly { readonly argv: readonly string[] }[];
  readonly outside_installs: readonly { readonly argv: readonly string[]; readonly reason: string }[];
  readonly missing: readonly string[];
  readonly notes: string;
}

export type TestSetupInvestigationRunResult =
  | { ok: true; investigation: TestSetupInvestigationOutput; invocation_id: string }
  | { ok: false; error: string; invocation_id?: string };

const ARGV: RoleSchema = { type: "array", items: { type: "string", minLength: 1 }, description: "one command: executable then arguments" };
const ARGV_LIST: RoleSchema = { type: "array", items: ARGV };
const PATHS: RoleSchema = { type: "array", items: { type: "string", minLength: 1 } };

export const TEST_SETUP_OUTPUT_SCHEMA: RoleSchema = objectSchema({
  verdict: { type: "string", enum: TEST_SETUP_VERDICTS, description: "the outcome of the investigation" },
  setup_argvs: { ...ARGV_LIST, description: "commands that prepare the environment inside the checkout, in order" },
  setup_inputs: { ...PATHS, description: "files the setup commands depend on (requirements, lock files, package manifests), relative to the checkout root; empty when none" },
  setup_outputs: { ...PATHS, description: "paths the setup commands create (.venv, node_modules), relative to the checkout root; empty when none" },
  test_run: {
    ...objectSchema({
      mode: { type: "string", enum: ["whole", "per_file"], description: "per_file (default) runs one test file at a time; whole only when running one file could not be confirmed, with the reason in notes" },
      whole_argv: { ...ARGV, description: "whole-suite command; empty when mode is per_file" },
      file_argv: { ...ARGV, description: "command with {file} for one test file; empty when mode is whole" },
      prepare_argv: { ...ARGV, description: "command run once before the tests; empty when none" },
      test_patterns: { ...PATHS, description: "globs of this language's test files" },
      cwd: { type: "string", minLength: 1, description: "folder to run in, relative to the checkout" },
      unit: { type: "string", enum: TEST_RUN_UNITS, description: "the unit one run takes: the first unit in the order that worked; file when mode is whole" },
      unit_argv: { ...ARGV, description: "command with {unit} for one folder or package; empty when unit is file" },
      unit_markers: { ...PATHS, description: "file name globs that mark a package root, taken from the files the runner uses to find a package; empty unless unit is package" },
    }),
    type: ["object", "null"],
  },
  executables: {
    type: "array",
    items: objectSchema({
      name: { type: "string", minLength: 1, description: "name used as {name} in commands, for example python" },
      path: { type: "string", minLength: 1, description: "checkout-relative path, or an absolute path outside the checkout" },
      probe_argv: { ...ARGV, description: "command starting with {name} that shows it works" },
    }),
  },
  confirm_files: { ...PATHS, description: "test files that confirm the command; with unit folder or package, test files inside the units you ran" },
  probe_argvs: { ...ARGV_LIST, description: "commands that show the runner works when no test file exists" },
  sources: { ...PATHS, description: "files you read, relative to the checkout" },
  attempts: {
    type: "array",
    items: objectSchema({
      argv: ARGV,
      cwd: { type: "string", minLength: 1, description: "folder the command ran in" },
      exit_code: { type: ["integer", "null"], description: "exit code, null when it did not exit" },
      summary: { type: "string", description: "one short line about the result" },
      unit: { type: "string", enum: ["", ...TEST_RUN_UNITS], description: "the unit this command ran as a test run; empty for setup, probes and other commands" },
    }),
    description: "every command you ran and what happened",
  },
  installed: { type: "array", items: objectSchema({ argv: ARGV }), description: "environment commands that worked" },
  outside_installs: {
    type: "array",
    items: objectSchema({ argv: ARGV, reason: { type: "string", minLength: 1, description: "why it is needed" } }),
    description: "commands you could not run that need to change something outside the Project; commands you ran yourself go in installed",
  },
  missing: { type: "array", items: { type: "string", minLength: 1 }, description: "what is still missing" },
  notes: { type: "string", description: "short notes for the Owner; required when mode is whole: why one test file cannot be run alone" },
});

const ORDER = TEST_RUN_UNITS.join(", ");

const BOOTSTRAP_LINES = (bootstrap: Readonly<Record<string, TestSetupBootstrap>>): string[] =>
  Object.entries(bootstrap).map(([language, entry]) => `- ${language}: ${entry.instructions}`);

export function buildTestSetupInvestigationPrompt(request: TestSetupInvestigationRequest): string {
  const repair = request.mode === "repair_explicit";
  return renderRolePrompt({
    role: "You are Owl's test environment investigator. You find a command that runs this checkout's tests and prepare the environment it needs, inside the checkout only.",
    instructions: [
      "The current directory is the checkout to investigate. Work in this order:",
      "1. Read the documents: README, CI settings (.github/workflows/*, .gitlab-ci.yml), Makefile, tox.ini, noxfile.py, lock files (uv.lock, poetry.lock, requirements*.txt, package.json and its lock), .python-version, .tool-versions, .nvmrc.",
      "2. Check the tools at hand: an existing .venv, pyenv, uv, node and the package managers (which, --version).",
      "3. Try first_candidate first. If current is not null, try its commands too.",
      "4. When the environment is missing something, prepare it inside the checkout and try again. Examples: python3 -m venv .venv, .venv/bin/python -m pip install -r requirements-dev.txt, uv sync --frozen, pnpm install --frozen-lockfile.",
      "5. Write the commands that prepared the environment to setup_argvs. Core runs them in every fresh checkout before the tests, so each must give the same result however often it runs: it must not delete or rebuild an environment that is already in place (an existing .venv or node_modules), so avoid commands that rebuild every time such as python -m venv --clear; create the environment only when it is missing. Core runs setup_argvs in test_run.cwd (not the checkout root), so write their relative paths from test_run.cwd (with cwd \"backend\": requirements.txt, not backend/requirements.txt). Executables paths stay relative to the checkout; Core turns them into absolute paths. A Task worktree or a Work checkout starts with no .venv and no node_modules.",
      "5b. Core skips setup_argvs and prepare_argv in a checkout where they already succeeded, until something they depend on changes. Write the files they read (requirements files, lock files, package manifests) in setup_inputs and the paths they create (the environment folder) in setup_outputs, both relative to the checkout root (not test_run.cwd) and without \"..\". Core re-runs the setup when an input's content changes or an output is missing.",
      "6. Write an executable inside the checkout as a checkout-relative path in executables (for example .venv/bin/python); write one outside as an absolute path. Write a Python in argv as {python}.",
      "7. If the environment needs something installed on the Mac itself (brew install, npm -g, pip install --user and the like), run it yourself; Core records the command it saw. Installing into the Project's own environment from a local path outside the Project (for example .venv/bin/python -m pip install -e <path outside the Project>) needs no approval: run it yourself. Never run sudo or anything that asks for a password, and never write files outside the Project by redirection or tee: the guard stops them.",
      "8. Do not change tracked files. Do not write test code or settings files. The only untracked folders you may leave in the checkout are the environment folders (.venv, venv, node_modules, .pytest_cache, __pycache__).",
      `9. mode per_file runs one unit at a time. Try the units in this order: ${ORDER}. Stop at the first unit that works and do not skip a unit. file: one test file given on the command line (file_argv with {file}; for example pytest <file>, node --test <file>, vitest run <file>, bun test <file>, jest <file>). folder: one folder of test files (unit_argv with {unit}). package: one package, the folder that holds one of the files the runner uses to mark a package (unit_argv with {unit}; write those file name globs in unit_markers). A unit works when the command, given one unit inside test_run.cwd, runs the tests of that unit and ends with a pass or with failures of those tests, not with an error about the environment or about test files outside the unit. List the test files that confirm it in confirm_files. When the unit is not file, write in notes why each finer unit did not work. Choose mode whole only when none of the units works; then write in notes what you tried for each unit and why it failed.`,
      "10. Write every command you ran and its result in attempts. For a command that ran tests as one unit, write that unit in the attempt's unit; leave unit empty for other commands.",
      repair
        ? "11. mode is repair_explicit: do not change the command in explicit_test_run. Prepare only the checkout's environment so that exact command runs, and set test_run to null."
        : "11. mode is find: test_run is required when verdict is ready, tests_failing or no_tests.",
      "Verdicts: ready = the tests run and pass; tests_failing = the environment works and the tests fail because of the code; no_tests = the runner is prepared and works but no test file exists yet; no_language = no file shows a language; needs_owner = the environment needs something you cannot do automatically, such as a password or an account login; code_problem = the original failure in failure is a code problem, not an environment problem.",
      "A no_tests answer needs test_run.test_patterns for the language and probe_argvs that show the runner works. Never write a test file.",
      "For a project with no test runner yet, prepare one by language:",
      ...BOOTSTRAP_LINES(request.bootstrap),
      "Commands in approved_installs were approved by the Owner and may run even though they change something outside the Project.",
      "Prohibited: network access other than the package installs above, and opening secret files such as .env*, secrets.json, *.pem, *.key, id_rsa*, .ssh/, .aws/, .npmrc, .netrc.",
    ],
    output: TEST_SETUP_OUTPUT_SCHEMA,
    outputRules: [
      "Output exactly one JSON object at the end.",
      "Use an empty array or an empty string for a field with nothing to say. Use null for test_run only in repair_explicit or when verdict is no_language, needs_owner or code_problem.",
      "In test_run, leave the argv you do not use empty. cwd is \".\" unless the tests run in a subfolder.",
      "test_patterns, confirm_files, setup_inputs and setup_outputs are relative to the checkout root, also when test_run.cwd is a subfolder. Core passes the file or unit to the command relative to test_run.cwd.",
      "unit is file, and unit_argv and unit_markers are empty, unless mode is per_file and a unit other than file worked.",
    ],
    language: "ja",
    inputs: [
      { name: "Project", value: { ...request.project, scope: request.scope, checkout: request.checkout, trigger: request.trigger, mode: request.mode } },
      { name: "Explicit test run", value: request.explicit_test_run },
      { name: "First candidate", value: request.first_candidate },
      { name: "Current record", value: request.current },
      { name: "Failure", value: request.failure },
      { name: "Approved installs", value: request.approved_installs },
    ],
  });
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

// Why not a check of which units appear in attempts: package, folder, file would pass it, and trying finer units first is the policy.
function checkUnits(output: TestSetupInvestigationOutput): void {
  const run = output.test_run;
  if (run === null) return;
  if (run.mode === "whole" && run.unit !== "file") throw new OutputFormatError("test_run.unit: must be file when mode is whole");
  if (output.verdict === "no_tests" && run.unit !== "file") throw new OutputFormatError("test_run.unit: must be file when verdict is no_tests");
  if (output.verdict === "ready" || output.verdict === "tests_failing") {
    const idx = (unit: string): number => TEST_RUN_UNITS.indexOf(unit as (typeof TEST_RUN_UNITS)[number]);
    const runs = output.attempts.flatMap((attempt) => (attempt.unit === "" ? [] : [attempt.unit]));
    const chosen = run.mode === "whole" ? TEST_RUN_UNITS.length - 1 : idx(run.unit);
    const back = runs.findIndex((unit, at) => at > 0 && idx(unit) < idx(runs[at - 1]));
    if (back > 0) throw new OutputFormatError(`attempts: try the units in the order ${ORDER}: an attempt with unit ${runs[back]} comes after an attempt with unit ${runs[back - 1]}`);
    const missing = TEST_RUN_UNITS.slice(0, chosen + 1).find((unit) => !runs.includes(unit));
    if (missing !== undefined) {
      throw new OutputFormatError(run.mode === "whole"
        ? `attempts: mode whole needs an attempt for every unit (${ORDER}): no attempt with unit ${missing}`
        : `attempts: try the units in the order ${ORDER}: no attempt with unit ${missing} before choosing ${run.unit}`);
    }
    const over = runs.find((unit) => idx(unit) > chosen);
    if (over !== undefined && run.mode === "per_file") throw new OutputFormatError(`attempts: stop at the first unit that works: an attempt with unit ${over} comes after choosing ${run.unit}`);
  }
  if (run.unit === "file") return;
  if (output.notes.trim() === "") throw new OutputFormatError("notes: required when test_run.unit is folder or package: write why each finer unit cannot be run alone");
  if (run.unit_argv.filter((arg) => arg === "{unit}").length !== 1 || run.unit_argv.includes("{file}")) throw new OutputFormatError("test_run.unit_argv: must contain {unit} exactly once and no {file}");
  if (run.unit === "package" && run.unit_markers.length === 0) throw new OutputFormatError("test_run.unit_markers: required when unit is package");
}

/** Throws OutputFormatError for anything that is not one valid output object, so the runner can resubmit. */
export function parseTestSetupResponse(
  response: Pick<ProviderResponse, "adapter" | "stdout" | "format">,
  options: { readonly mode?: "find" | "repair_explicit" } = {},
): TestSetupInvestigationOutput {
  let value: Record<string, unknown>;
  try {
    value = extractRoleOutputObject(response, "test_setup_stdout_not_single_json_object", { allowCodeFence: true });
  } catch (error) {
    throw new OutputFormatError(error instanceof Error ? error.message : "test_setup_output_invalid");
  }
  const problem = validateRoleOutput(TEST_SETUP_OUTPUT_SCHEMA, value);
  if (problem) throw new OutputFormatError(problem);
  const output = value as unknown as TestSetupInvestigationOutput;
  const emptyArgv = [...output.setup_argvs, ...output.probe_argvs].findIndex((argv) => argv.length === 0);
  if (emptyArgv >= 0) throw new OutputFormatError("setup_argvs and probe_argvs: a command must not be empty");
  const bad = output.executables.find((entry) => !entry.probe_argv[0]?.startsWith(`{${entry.name}}`));
  if (bad) throw new OutputFormatError(`executables.${bad.name}.probe_argv: must start with {${bad.name}}`);
  if (!isStringArray(output.sources)) throw new OutputFormatError("sources: must be strings");
  const needsRun = ["ready", "tests_failing", "no_tests"].includes(output.verdict);
  checkUnits(output);
  if (output.test_run?.mode === "whole" && output.notes.trim() === "") throw new OutputFormatError(`notes: required when test_run.mode is whole: write why no unit (${ORDER}) can be run alone, or use per_file`);
  if (options.mode === "repair_explicit" && output.test_run !== null) throw new OutputFormatError("test_run: must be null in repair_explicit");
  if (options.mode === "find" && needsRun && output.test_run === null) throw new OutputFormatError(`test_run: required when verdict is ${output.verdict}`);
  return output;
}

export function testSetupProviderSchema(): Readonly<Record<string, unknown>> {
  return providerSchema(TEST_SETUP_OUTPUT_SCHEMA);
}
