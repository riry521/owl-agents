import type { TestRunSettings } from "./test-run-settings.js";

export const TEST_SETUP_SETTINGS_KEY = "test_setup";

/** Roles that can write to a checkout and run commands; the others are read-only, document-only, or stopped from running tests. */
export const TEST_SETUP_ROLES = ["worker", "manager"] as const;
export type TestSetupRole = (typeof TEST_SETUP_ROLES)[number];

export interface TestSetupBootstrap {
  /** Text for the investigating agent: how to prepare a test environment for this language. */
  readonly instructions: string;
  readonly test_run: Partial<TestRunSettings>;
  /** Commands that show the prepared runner works when no test file exists yet. */
  readonly probe_argvs: readonly (readonly string[])[];
}

export interface TestSetupSettings {
  readonly role: TestSetupRole;
  readonly timeout_seconds: number;
  readonly max_reinvestigations: number;
  readonly probe_timeout_seconds: number;
  readonly max_confirm_files: number;
  /** Executable name -> command used when no saved setup resolves it ("{python}" in an argv becomes default_executables.python). */
  readonly default_executables: Readonly<Record<string, string>>;
  readonly run_env: Readonly<Record<string, string>>;
  /** Globs of files whose content goes into the layout digest. */
  readonly input_files: readonly string[];
  readonly test_file_globs: readonly string[];
  /** Regular expression sources (flags "iu"); a test file's matching lines go into the tests digest. */
  readonly import_patterns: readonly string[];
  /** Folder names left out of every digest. */
  readonly ignored_dirs: readonly string[];
  /** Untracked folders an investigation may leave in a checkout. */
  readonly environment_dirs: readonly string[];
  readonly environment: { readonly exit_codes: readonly number[]; readonly patterns: readonly string[] };
  /** Regular expression sources (flags "ium"); group 1 is the number of passing tests in a runner's summary line. A whole run that failed with a count above 0 had some tests pass. */
  readonly passed_count_patterns: readonly string[];
  readonly install: {
    readonly always_outside: readonly (readonly string[])[];
    /** Command prefixes that need credentials a run cannot give; these are refused instead of run. */
    readonly credential_commands: readonly (readonly string[])[];
    /** Tool -> first arguments, after its neutral_flags, that only read (brew list, pipx --version); an always_outside command starting with one is not an install, nor is a node manager given only these (yarn --version). */
    readonly read_only_words: Readonly<Record<string, readonly string[]>>;
    readonly config_writes: readonly (readonly string[])[];
    readonly install_words: readonly string[];
    readonly neutral_flags: Readonly<Record<string, readonly string[]>>;
    readonly target_env: Readonly<Record<string, readonly string[]>>;
    /** Tool -> flags whose value is a folder the install writes to or runs in. */
    readonly path_flags: Readonly<Record<string, readonly string[]>>;
    /** Tool -> flags whose value is where the package comes from, not where it goes. */
    readonly source_flags: Readonly<Record<string, readonly string[]>>;
    /** Tool -> flags that send the install outside the Project by themselves. */
    readonly outside_flags: Readonly<Record<string, readonly string[]>>;
    /** Flags whose value names the Python (or its environment) the tool installs into. */
    readonly interpreter_flags: readonly string[];
    readonly writable_outside: readonly string[];
    /** What each variable in target_env means to the install: path, flag_outside, set_outside, location, python_downloads, virtual_env, project_environment or in_project. */
    readonly env_roles: Readonly<Record<string, string>>;
    /** Flags that stop uv from downloading a Python. */
    readonly no_download_flags: readonly string[];
    /** Flags whose value (one of global_location_values) sends an npm install to the machine. */
    readonly location_flags: readonly string[];
    readonly global_location_values: readonly string[];
    /** Executable names: regular expression sources (flags "iu") for python and pip, plain names for the rest. */
    /** Names the classifier tells tools apart by: tool executables, subcommands, project files and environment folders. */
    readonly names: InstallNames;
    readonly executables: { readonly python: string; readonly pip: string; readonly shells: readonly string[]; readonly venv_names: readonly string[] };
  };
  readonly bootstrap: Readonly<Record<string, TestSetupBootstrap>>;
  readonly max_attempts_recorded: number;
  readonly summary_chars: number;
}

export interface InstallNames {
  readonly uv: string;
  readonly poetry: string;
  /** Package managers judged by nodeVerdict. */
  readonly node_managers: readonly string[];
  /** Node managers that install when given no subcommand. */
  readonly bare_install_managers: readonly string[];
  /** Node manager -> `config get` keys that can make an install global. */
  readonly global_config_keys: Readonly<Record<string, readonly string[]>>;
  readonly pip: string;
  readonly venv: string;
  readonly run: string;
  readonly uv_project: readonly string[];
  readonly poetry_project: readonly string[];
  /** Node subcommands that install besides install_words. */
  readonly node_install: readonly string[];
  readonly python_project_file: string;
  readonly node_project_file: string;
  readonly python_env_dir: string;
  readonly node_env_dir: string;
  /** Flag that makes python run a module (`python -m pip`). */
  readonly module_flag: string;
  /** Arguments after `python -m pip` that print the pip configuration. */
  readonly pip_config_args: readonly string[];
  /** Arguments after `poetry` that print the environment path. */
  readonly poetry_env_args: readonly string[];
  /** Arguments before a key that print one configuration value. */
  readonly config_get_args: readonly string[];
  readonly poetry_in_project_key: string;
  /** Config key -> the value of that key that makes an install global. */
  readonly global_config_values: Readonly<Record<string, string>>;
  /** Node subcommand after which every argument is a global install. */
  readonly global_word: string;
  /** Path parts from VIRTUAL_ENV to its python. */
  readonly env_python_path: readonly string[];
  /** Flag that makes python run code (`python -c`). */
  readonly python_code_flag: string;
  /** `pip config list` keys whose value is a folder, and keys whose value is a yes/no that sends the install outside. */
  readonly pip_config_path_keys: readonly string[];
  readonly pip_config_flag_keys: readonly string[];
  /** Value of the uv Python-download setting that stops downloads. */
  readonly downloads_stopped_value: string;
  /** Tool -> the subset of path_flags that move the working directory (the others only name the project). */
  readonly cwd_flags: Readonly<Record<string, readonly string[]>>;
}

export const REGEX_FLAGS = "iu";

export const DEFAULT_TEST_SETUP_SETTINGS: TestSetupSettings = {
  role: "worker",
  timeout_seconds: 900,
  max_reinvestigations: 2,
  probe_timeout_seconds: 120,
  max_confirm_files: 5,
  default_executables: { python: "python3" },
  run_env: { UV_PYTHON_DOWNLOADS: "never" },
  input_files: [
    "pyproject.toml", "setup.cfg", "tox.ini", "pytest.ini", "**/conftest.py", "requirements*.txt", "**/requirements*.txt",
    "uv.lock", "poetry.lock", "Pipfile.lock", "package.json", "**/package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock",
    "jest.config.*", "vitest.config.*", ".github/workflows/*", "Makefile", "README*", ".python-version", ".nvmrc", ".tool-versions",
  ],
  test_file_globs: ["**/test_*.py", "**/*_test.py", "**/*.test.{mjs,js,cjs,ts,mts,cts,tsx,jsx}", "**/*.spec.{mjs,js,cjs,ts,mts,cts,tsx,jsx}", "**/*_test.{go,ts,js}"],
  import_patterns: ["^\\s*import\\s", "^\\s*from\\s+\\S+\\s+import\\s", "\\brequire\\s*\\("],
  ignored_dirs: [".venv", "venv", "node_modules", ".tox", ".nox", "__pycache__", ".pytest_cache"],
  environment_dirs: [".venv/", "venv/", "node_modules/", ".pytest_cache/", "__pycache__/", ".serena/"],
  environment: {
    exit_codes: [126, 127],
    patterns: [
      "No module named '?pytest'?",
      "ModuleNotFoundError: No module named",
      "command not found",
      "env: [^:]+: No such file or directory",
      "spawn \\S+ ENOENT",
      "Cannot find module",
      "pytest: error: unrecognized arguments",
    ],
  },
  passed_count_patterns: ["^\\s*(\\d+) pass\\b", "\\b(\\d+) passed\\b", "^# pass (\\d+)"],
  install: {
    always_outside: [
      ["brew"], ["port"], ["apt"], ["apt-get"], ["yum"], ["dnf"], ["pipx"],
      ["pyenv", "install"], ["nvm", "install"], ["asdf", "install"], ["volta", "install"], ["corepack", "enable"],
      ["gem", "install"], ["cargo", "install"], ["go", "install"],
    ],
    credential_commands: [["sudo"], ["doas"], ["su"]],
    read_only_words: {
      brew: ["--version", "--help", "-h", "help", "list", "ls", "info", "search", "outdated", "--prefix", "--cellar", "--repository", "--cache", "config", "doctor", "deps", "uses", "leaves"],
      pipx: ["--version", "--help", "-h", "list", "environment"],
      port: ["version", "help", "list", "installed", "info", "search", "outdated", "deps"],
      apt: ["--version", "--help", "-h", "list", "search", "show", "policy"],
      "apt-get": ["--version", "--help", "-h"],
      yum: ["--version", "--help", "-h", "help", "list", "info", "search"],
      dnf: ["--version", "--help", "-h", "help", "list", "info", "search"],
      yarn: ["--version", "-v", "--help", "-h"],
    },
    config_writes: [["pip", "config", "set"], ["pip", "config", "unset"], ["pip", "config", "edit"], ["npm", "config", "set"], ["npm", "config", "delete"], ["pnpm", "config", "set"], ["yarn", "config", "set"]],
    install_words: ["install", "add", "i", "sync", "upgrade", "update"],
    neutral_flags: {
      venv: ["--clear", "--without-pip", "--upgrade-deps", "--copies", "--symlinks", "--upgrade"],
      pip: ["-q", "--quiet", "-v", "--verbose", "-r", "--requirement", "-U", "--upgrade", "--no-cache-dir", "--disable-pip-version-check", "--no-input", "--require-hashes", "--no-deps"],
      npm: ["--frozen-lockfile", "--ignore-scripts", "--no-audit", "--no-fund", "--silent", "--legacy-peer-deps"],
      pnpm: ["--frozen-lockfile", "--ignore-scripts", "--silent"],
      yarn: ["--frozen-lockfile", "--immutable", "--silent"],
      bun: ["--frozen-lockfile", "--silent"],
      uv: ["--frozen", "--locked", "--no-python-downloads", "--quiet", "-q"],
      poetry: ["--no-interaction", "--no-root", "--quiet", "-q"],
      brew: ["-v", "--verbose", "-d", "--debug", "-q", "--quiet"],
      pipx: ["-v", "--verbose", "-q", "--quiet"],
      port: ["-v", "-d", "-q"],
      apt: ["-q", "--quiet"],
      "apt-get": ["-q", "--quiet"],
      yum: ["-q", "--quiet", "-v", "--verbose"],
      dnf: ["-q", "--quiet", "-v", "--verbose"],
    },
    target_env: {
      pip: ["PIP_TARGET", "PIP_PREFIX", "PIP_ROOT", "PIP_SRC", "PIP_USER", "PIP_CONFIG_FILE", "PYTHONHOME"],
      npm: ["npm_config_global", "npm_config_location", "npm_config_prefix"],
      uv: ["UV_PROJECT_ENVIRONMENT", "VIRTUAL_ENV", "UV_PYTHON_DOWNLOADS"],
      poetry: ["POETRY_VIRTUALENVS_IN_PROJECT"],
    },
    path_flags: {
      pip: ["--target", "-t", "--prefix", "--root", "--src"],
      npm: ["--prefix"],
      pnpm: ["--dir", "-C"],
      yarn: ["--cwd"],
      bun: ["--cwd"],
      uv: ["--project", "--directory"],
      poetry: ["--directory", "-C"],
    },
    source_flags: { pip: ["-e", "--editable"] },
    outside_flags: { pip: ["--user", "--break-system-packages", "--system"], npm: ["-g", "--global"], pnpm: ["-g", "--global"], yarn: ["-g", "--global"], bun: ["-g", "--global"] },
    interpreter_flags: ["--python"],
    writable_outside: ["/dev/null", "/dev/stdout", "/dev/stderr"],
    env_roles: {
      PIP_TARGET: "path", PIP_PREFIX: "path", PIP_ROOT: "path", PIP_SRC: "path", PIP_USER: "flag_outside", PYTHONHOME: "set_outside",
      npm_config_global: "flag_outside", npm_config_location: "location", npm_config_prefix: "path",
      UV_PROJECT_ENVIRONMENT: "project_environment", VIRTUAL_ENV: "virtual_env", UV_PYTHON_DOWNLOADS: "python_downloads",
      POETRY_VIRTUALENVS_IN_PROJECT: "in_project",
    },
    no_download_flags: ["--no-python-downloads"],
    location_flags: ["--location"],
    global_location_values: ["global"],
    names: {
      uv: "uv", poetry: "poetry", node_managers: ["npm", "pnpm", "yarn", "bun"], bare_install_managers: ["yarn"],
      global_config_keys: { npm: ["global", "location"], pnpm: ["global"] },
      pip: "pip", venv: "venv", run: "run", uv_project: ["sync", "run", "add"], poetry_project: ["install", "sync", "add", "run"], node_install: ["ci", "global"],
      python_project_file: "pyproject.toml", node_project_file: "package.json", python_env_dir: ".venv", node_env_dir: "node_modules",
      module_flag: "-m", pip_config_args: ["config", "list"], poetry_env_args: ["env", "info", "--path"], config_get_args: ["config", "get"],
      poetry_in_project_key: "virtualenvs.in-project", global_config_values: { global: "true", location: "global" }, global_word: "global", env_python_path: ["bin", "python"],
      python_code_flag: "-c", pip_config_path_keys: ["target", "prefix", "root", "src"], pip_config_flag_keys: ["user"], downloads_stopped_value: "never",
      cwd_flags: { uv: ["--directory"], poetry: ["--directory", "-C"] },
    },
    executables: { python: "^(?:python[0-9.]*|py)$", pip: "^pip[0-9.]*$", shells: ["sh", "bash", "zsh", "dash", "ksh", "fish"], venv_names: ["venv", "virtualenv"] },
  },
  bootstrap: {
    python: {
      instructions: "Create a virtual environment in .venv and install pytest into it. Do not write test files.",
      test_run: { mode: "whole", whole_argv: ["{python}", "-m", "pytest", "-q"], test_patterns: ["**/test_*.py", "**/*_test.py"] },
      probe_argvs: [["{python}", "-m", "pytest", "--version"]],
    },
    node_js: {
      instructions: "Use node:test, which ships with Node. Install dependencies with the lockfile's package manager when there is a lockfile. Do not edit package.json.",
      test_run: { mode: "per_file", file_argv: ["node", "--test", "--test-reporter=tap", "{file}"], test_patterns: ["**/*.test.{js,mjs,cjs}"] },
      probe_argvs: [["node", "-e", "require('node:test')"]],
    },
    node_ts: {
      instructions: "Use node:test with --experimental-strip-types. If the installed Node cannot run TypeScript, install a Node that can.",
      test_run: { mode: "per_file", file_argv: ["node", "--experimental-strip-types", "--test", "--test-reporter=tap", "{file}"], test_patterns: ["**/*.test.{ts,mts,cts}"] },
      probe_argvs: [["node", "--experimental-strip-types", "-e", "0"]],
    },
  },
  max_attempts_recorded: 20,
  summary_chars: 500,
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const int = (min: number, max: number) => (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const strings = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
const argvs = (value: unknown): boolean => Array.isArray(value) && value.every(strings) && value.every((argv) => (argv as unknown[]).length > 0);
const stringMap = (value: unknown): boolean => isRecord(value) && Object.values(value).every((item) => typeof item === "string" && item.length > 0);
const stringListMap = (value: unknown): boolean => isRecord(value) && Object.values(value).every(strings);
const regexList = (value: unknown): boolean => {
  if (!strings(value)) return false;
  try {
    for (const source of value as string[]) new RegExp(source, REGEX_FLAGS);
    return true;
  } catch {
    return false;
  }
};
const executables = (value: unknown): boolean => isRecord(value) && regexList([value.python, value.pip]) && strings(value.shells) && strings(value.venv_names);
const names = (value: unknown): boolean =>
  isRecord(value) && ["uv", "poetry", "pip", "venv", "run", "python_project_file", "node_project_file", "python_env_dir", "node_env_dir", "module_flag", "poetry_in_project_key", "global_word", "python_code_flag", "downloads_stopped_value"].every((key) => typeof value[key] === "string" && value[key] !== "")
  && ["node_managers", "bare_install_managers", "uv_project", "poetry_project", "node_install", "pip_config_args", "poetry_env_args", "config_get_args", "env_python_path", "pip_config_path_keys", "pip_config_flag_keys"].every((key) => strings(value[key])) && stringListMap(value.global_config_keys) && stringListMap(value.cwd_flags) && stringMap(value.global_config_values);
const bootstrap = (value: unknown): boolean =>
  isRecord(value) && Object.values(value).every((entry) => isRecord(entry) && typeof entry.instructions === "string" && isRecord(entry.test_run) && argvs(entry.probe_argvs));

const TOP_VALIDATORS: Readonly<Record<string, (value: unknown) => boolean>> = {
  role: (value) => (TEST_SETUP_ROLES as readonly unknown[]).includes(value),
  timeout_seconds: int(60, 3600),
  max_reinvestigations: int(0, 5),
  probe_timeout_seconds: int(1, 3600),
  max_confirm_files: int(1, 1000),
  default_executables: stringMap,
  run_env: stringMap,
  input_files: strings,
  test_file_globs: strings,
  import_patterns: regexList,
  ignored_dirs: strings,
  environment_dirs: strings,
  passed_count_patterns: regexList,
  bootstrap,
  max_attempts_recorded: int(1, 1000),
  summary_chars: int(1, 100000),
};

const ENVIRONMENT_VALIDATORS: Readonly<Record<string, (value: unknown) => boolean>> = {
  exit_codes: (value) => Array.isArray(value) && value.every(int(0, 255)),
  patterns: regexList,
};

const INSTALL_VALIDATORS: Readonly<Record<string, (value: unknown) => boolean>> = {
  always_outside: argvs,
  credential_commands: argvs,
  read_only_words: stringListMap,
  config_writes: argvs,
  install_words: strings,
  neutral_flags: stringListMap,
  target_env: stringListMap,
  path_flags: stringListMap,
  source_flags: stringListMap,
  outside_flags: stringListMap,
  interpreter_flags: strings,
  writable_outside: strings,
  env_roles: stringMap,
  no_download_flags: strings,
  location_flags: strings,
  global_location_values: strings,
  names,
  executables,
};

/** Takes each key of `fallback` from `stored` when it passes its validator, else from `fallback`; a bad value is reported through warn. */
function pickKeys<T extends object>(stored: unknown, fallback: T, validators: Readonly<Record<string, (value: unknown) => boolean>>, path: string, warn?: (message: string) => void): T {
  const source = isRecord(stored) ? stored : {};
  const result: Record<string, unknown> = { ...(fallback as Record<string, unknown>) };
  for (const key of Object.keys(validators)) {
    if (!Object.hasOwn(source, key)) continue;
    if (validators[key](source[key])) result[key] = source[key];
    else warn?.(`Invalid test_setup.${path}${key}; using default.`);
  }
  return result as T;
}

/** Missing or invalid values fall back to the defaults, per key; invalid ones are reported through warn. */
export function readTestSetupSettings(value: unknown, warn?: (message: string) => void): TestSetupSettings {
  const d = DEFAULT_TEST_SETUP_SETTINGS;
  const source = isRecord(value) ? value : {};
  const top = pickKeys(source, d, TOP_VALIDATORS, "", warn);
  return {
    ...top,
    environment: pickKeys(source.environment, d.environment, ENVIRONMENT_VALIDATORS, "environment.", warn),
    install: pickKeys(source.install, d.install, INSTALL_VALIDATORS, "install.", warn),
  };
}
