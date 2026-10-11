import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

import type { TestSetupSettings } from "../../shared/dist/test-setup-settings.js";
import {
  advanceWorkingDirectory,
  analyzeShellCommand,
  effectiveCommand,
  isDynamicPath,
  isEnvironmentAssignment,
  normalizeExecutable,
  resolvePathCandidate,
  shellTokenForHome,
  SUBSHELL_CLOSE,
  SUBSHELL_OPEN,
  UNKNOWN_CWD,
} from "./command-analysis.js";
import type { TestRunGate } from "./test-detection.js";
import type { TestCommandRunner } from "./test-runs.js";

export type InstallScope = "none" | "inside" | "outside";
export type InstallSettings = TestSetupSettings["install"];
export type InstallQuery = (argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>) => Promise<{ readonly exit_code: number | null; readonly stdout: string }>;

export interface InstallContext {
  readonly cwd: string;
  /** The checkouts the investigation or run belongs to (absolute). */
  readonly roots: readonly string[];
  /** The environment the command really receives. */
  readonly env: Readonly<Record<string, string>>;
  readonly approved: readonly (readonly string[])[];
  readonly settings: InstallSettings;
  readonly query: InstallQuery;
}

export interface InstallSegmentClass {
  readonly argv: readonly string[];
  /** "outside" is an install onto the Mac (or one whose target is unknown): it runs and is recorded. */
  readonly scope: InstallScope;
  readonly reason: string;
  /** The command needs credentials a run cannot give (sudo), so it is refused. */
  readonly denied?: boolean;
}

export interface InstallClass {
  readonly scope: InstallScope;
  readonly segments: readonly InstallSegmentClass[];
}

type Verdict = { readonly scope: InstallScope; readonly reason: string; readonly denied?: boolean };
const NONE: Verdict = { scope: "none", reason: "" };
const inside = (reason: string): Verdict => ({ scope: "inside", reason });
const outside = (reason: string): Verdict => ({ scope: "outside", reason });

const TRUE_VALUE = /^(?:1|true|yes|on)$/iu;
const ENV_CHDIR = /^(?:--chdir|-[0iv]*C)$/u;
const PREFIX_QUERY = "import sys,json;print(json.dumps([sys.prefix,sys.base_prefix]))";

/** Runs a read-only question (sys.prefix, npm config get ...); null exit code = it could not run or timed out. */
export function execInstallQuery(timeoutMs: number): InstallQuery {
  return (argv, cwd, env) => new Promise((done) => {
    execFile(argv[0] ?? "", argv.slice(1), { cwd, env: { ...env }, timeout: timeoutMs, encoding: "utf8", maxBuffer: 1 << 20 }, (error, stdout) => {
      const code = (error as { code?: unknown } | null)?.code;
      done({ exit_code: error === null ? 0 : typeof code === "number" ? code : null, stdout: String(stdout) });
    });
  });
}

function realRoots(roots: readonly string[]): string[] {
  return roots.map((root) => {
    try { return realpathSync(root); } catch { return resolve(root); }
  });
}

/** The real place `abs` would be written: the nearest existing ancestor's realpath plus the rest; null when that cannot be told. */
function realTarget(abs: string): string | null {
  let current = "/";
  let missing = false;
  for (const part of abs.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (missing) return null;
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    if (!missing) {
      try {
        current = realpathSync(next);
        continue;
      } catch {
        // A dangling symlink would still send the write somewhere we cannot see.
        try { lstatSync(next); return null; } catch { missing = true; }
      }
    }
    current = next;
  }
  return current;
}

/** Whether a path an install would write to really lies inside one of the roots (symlinks resolved). */
export function resolveInstallTarget(path: string, cwd: string, roots: readonly string[]): "inside" | "outside" {
  if (path.length === 0 || isDynamicPath(path)) return "outside";
  const home = process.env.HOME;
  let expanded = path.replaceAll(shellTokenForHome(), home ?? "~");
  if (expanded === "~" || expanded.startsWith("~/")) {
    if (!home) return "outside";
    expanded = join(home, expanded.slice(1));
  }
  if (!expanded.startsWith("/")) {
    if (cwd === UNKNOWN_CWD) return "outside";
    expanded = `${cwd}/${expanded}`;
  }
  const target = realTarget(expanded);
  if (target === null) return "outside";
  return realRoots(roots).some((root) => target === root || target.startsWith(root === "/" ? "/" : `${root}/`)) ? "inside" : "outside";
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The executable as the shell would pick it: a path from cwd, or the first PATH hit. The result is not realpath'ed. */
function findExecutable(name: string, cwd: string, env: Readonly<Record<string, string>>): string | null {
  if (name.includes("/")) {
    const path = resolvePathCandidate(name, cwd);
    return path !== null && isExecutableFile(path) ? path : null;
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir.startsWith("/")) continue;
    const path = join(dir, name);
    if (isExecutableFile(path)) return path;
  }
  return null;
}

/** The value of the first variable in settings.target_env[group] that has `role` in settings.env_roles and is set. */
function targetEnvValue(scope: Scope, group: string, role: string): string | undefined {
  for (const name of scope.ctx.settings.target_env[group] ?? []) {
    const value = scope.ctx.settings.env_roles[name] === role ? envValue(scope.env, name) : undefined;
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/** Applies the leading `NAME=value` words and `env -i / -u / --unset` options of a command to its environment; unknown = an `env` option changed it in a way we cannot follow. */
function prefixEnvironment(prefix: readonly string[], base: Readonly<Record<string, string>>): { env: Record<string, string>; unknown: boolean } {
  let env: Record<string, string> = { ...base };
  let unknown = false;
  const assign = (item: string): void => { env[item.slice(0, item.indexOf("="))] = item.slice(item.indexOf("=") + 1); };
  const drop = (name: string | undefined): void => { env = Object.fromEntries(Object.entries(env).filter(([key]) => key !== name)); };
  for (let index = 0; index < prefix.length; index += 1) {
    const token = prefix[index] ?? "";
    if (isEnvironmentAssignment(token)) { assign(token); continue; }
    if (normalizeExecutable(token) !== "env") continue;
    for (index += 1; index < prefix.length; index += 1) {
      const option = prefix[index] ?? "";
      if (option === "--") break;
      if (isEnvironmentAssignment(option)) { assign(option); continue; }
      if (!option.startsWith("-")) { index -= 1; break; }
      // A short option may carry its value attached (`-uNAME`, `-Cdir`); anything else starting with `-` that is not understood leaves the environment unknown.
      const cluster = option.match(/^-([0iv]*)([CPSu]?)(.*)$/u);
      const known = option === "-" || option === "--ignore-environment" || option.startsWith("--unset") || option.startsWith("--chdir") || option.startsWith("--split-string") || (cluster !== null && (cluster[2] !== "" || cluster[3] === ""));
      if (option === "-" || option === "--ignore-environment" || (cluster !== null && cluster[1]?.includes("i"))) env = {};
      if (option.startsWith("--unset=")) drop(option.slice("--unset=".length));
      else if (option === "--unset" || cluster?.[2] === "u") drop(cluster?.[3] ? cluster[3] : prefix[(index += 1)]);
      else if (option === "--chdir" || (cluster?.[2] === "C" && cluster[3] === "")) index += 1;
      else if (option === "--split-string" || option.startsWith("--split-string=") || cluster?.[2] === "S" || cluster?.[2] === "P") { unknown = true; index += option.includes("=") || cluster?.[3] ? 0 : 1; }
      else if (!known) unknown = true;
    }
  }
  return { env, unknown };
}

/** The working directory a command really runs in once `env -C dir` / `env --chdir=dir` is applied; UNKNOWN_CWD when it cannot be told. */
export function wrapperCwd(seg: readonly string[], cwd: string): string {
  const effective = effectiveCommand(seg);
  if (effective === null || !effective.wrappers.includes("env")) return cwd;
  let result = cwd;
  const prefix = seg.slice(0, seg.length - effective.args.length - 1);
  for (let index = 0; index < prefix.length; index += 1) {
    const token = prefix[index] ?? "";
    const attached = token.match(/^(?:--chdir=|-[0iv]*C(?=.))(.*)$/u);
    const value = ENV_CHDIR.test(token) ? prefix[(index += 1)] : attached?.[1];
    if (value === undefined) continue;
    const next = isDynamicPath(value) || result === UNKNOWN_CWD ? null : resolvePathCandidate(value, result);
    result = next ?? UNKNOWN_CWD;
  }
  return result;
}

function envValue(env: Readonly<Record<string, string>>, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function upwardDirWith(start: string, file: string): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, file))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

const namePattern = (source: string): RegExp => new RegExp(source, "iu");

function stripRedirects(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if ([">", ">>", "<", "<<"].includes(args[index] ?? "")) index += 1;
    else kept.push(args[index] ?? "");
  }
  return kept;
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((part, index) => b[index] === part);

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** The python that `pip` runs under: the one named by `python -m pip`, or the one in the pip script's shebang. */
function pipPython(raw: string, viaModule: boolean, cwd: string, env: Readonly<Record<string, string>>): string | null {
  const found = findExecutable(raw, cwd, env);
  if (found === null || viaModule) return found;
  let head: string;
  try { head = readFileSync(found).subarray(0, 512).toString("latin1").split("\n", 1)[0] ?? ""; } catch { return null; }
  const shebang = head.match(/^#!\s*(\S+)(?:\s+(\S+))?/u);
  if (shebang === null) return null;
  const interpreter = normalizeExecutable(shebang[1] ?? "") === "env" ? shebang[2] : shebang[1];
  return interpreter === undefined ? null : findExecutable(interpreter, cwd, env);
}

interface Scope {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly envUnknown: boolean;
  readonly ctx: InstallContext;
}

const isInside = (scope: Scope, path: string, base = scope.cwd): boolean => resolveInstallTarget(path, base, scope.ctx.roots) === "inside";

async function pipVerdict(scope: Scope, python: string | null, args: readonly string[], isUv: boolean): Promise<Verdict> {
  const { ctx, cwd, env } = scope;
  if (python === null) return outside("the python that pip runs under was not found");
  const queried = await ctx.query([python, ctx.settings.names.python_code_flag, PREFIX_QUERY], cwd, env);
  let prefixes: unknown;
  try { prefixes = queried.exit_code === 0 ? JSON.parse(queried.stdout) : null; } catch { prefixes = null; }
  if (!Array.isArray(prefixes) || typeof prefixes[0] !== "string" || typeof prefixes[1] !== "string") return outside("sys.prefix could not be queried");
  // Why sys.prefix and not the executable: a venv's bin/python usually links to a python outside the Project.
  if (prefixes[0] === prefixes[1]) return outside("not a virtual environment");
  if (!isInside(scope, prefixes[0])) return outside(`sys.prefix is outside: ${prefixes[0]}`);
  const known = new Set([...(ctx.settings.neutral_flags.pip ?? []), ...(isUv ? ctx.settings.neutral_flags.uv ?? [] : [])]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (isDynamicPath(arg)) return outside(`dynamic argument: ${arg}`);
    if (!arg.startsWith("-")) continue;
    const [name = "", inline] = arg.split(/=(.*)/su);
    if ((ctx.settings.outside_flags.pip ?? []).includes(name)) return outside(`${name} installs outside the Project`);
    if ((ctx.settings.source_flags.pip ?? []).includes(name)) {
      // Why the value is skipped: it names where the package comes from, which may be anywhere.
      index += inline === undefined ? 1 : 0;
    } else if ((ctx.settings.path_flags.pip ?? []).includes(name)) {
      const value = inline ?? args[(index += 1)];
      if (value === undefined || !isInside(scope, value)) return outside(`${name} points outside the Project`);
    } else if (isUv && ctx.settings.interpreter_flags.includes(name)) {
      index += inline === undefined ? 1 : 0;
    } else if (!known.has(name)) {
      return outside(`unknown flag: ${arg}`);
    }
  }
  if (isUv) return inside(`installs into ${prefixes[0]}`);
  for (const name of ctx.settings.target_env.pip ?? []) {
    const value = envValue(env, name);
    if (value === undefined || value === "") continue;
    const role = ctx.settings.env_roles[name];
    if (role === "flag_outside") {
      if (TRUE_VALUE.test(value)) return outside(`${name} is set`);
    } else if (role === "path") {
      if (!isInside(scope, value)) return outside(`${name} points outside the Project`);
    } else if (role === "set_outside") {
      return outside(`${name} is set`);
    }
  }
  const config = await ctx.query([python, ctx.settings.names.module_flag, ctx.settings.names.pip, ...ctx.settings.names.pip_config_args], cwd, env);
  if (config.exit_code !== 0) return outside("pip config could not be queried");
  const flagKeys = ctx.settings.names.pip_config_flag_keys;
  const keyAlternatives = [...ctx.settings.names.pip_config_path_keys, ...flagKeys].map((key) => key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  const configLine = new RegExp(`^(?:\\S+\\.)?(${keyAlternatives})\\s*=\\s*'?(.*?)'?\\s*$`, "u");
  for (const line of config.stdout.split("\n")) {
    const match = line.match(configLine);
    if (match === null) continue;
    if (flagKeys.includes(match[1] ?? "") ? TRUE_VALUE.test(match[2] ?? "") : !isInside(scope, match[2] ?? "")) return outside(`pip config sets ${match[1]}`);
  }
  return inside(`installs into ${prefixes[0]}`);
}

function venvVerdict(scope: Scope, args: readonly string[], defaultDir: string | null, group: string): Verdict {
  const known = scope.ctx.settings.neutral_flags[group] ?? [];
  const unknown = args.find((arg) => arg.startsWith("-") && !known.includes(arg));
  if (unknown !== undefined) return outside(`unknown flag: ${unknown}`);
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  const dirs = positionals.length > 0 ? positionals : defaultDir === null ? [] : [defaultDir];
  if (dirs.length === 0) return outside("no environment folder given");
  return dirs.every((dir) => isInside(scope, dir)) ? inside("creates the environment inside the Project") : outside("environment folder is outside the Project");
}

const downloadsStopped = (scope: Scope, args: readonly string[]): boolean => scope.ctx.settings.no_download_flags.some((flag) => args.includes(flag)) || targetEnvValue(scope, scope.ctx.settings.names.uv, "python_downloads") === scope.ctx.settings.names.downloads_stopped_value;

/** Reads the global options in front of the subcommand: those that take a folder give `dir`, known flags are skipped, and an unknown one is `unknown` ("" = no subcommand at all). */
function readGlobals(scope: Scope, tool: string, args: readonly string[]): { sub?: string; rest: readonly string[]; cwdArg?: string; project?: string; unknown?: string; flags: readonly string[] } {
  const { settings } = scope.ctx;
  let cwdArg: string | undefined;
  let project: string | undefined;
  const flags: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("-")) return { sub: arg, rest: args.slice(index + 1), cwdArg, project, flags };
    const [name = "", inline] = arg.split(/=(.*)/su);
    flags.push(name);
    if ((settings.path_flags[tool] ?? []).includes(name)) {
      const value = inline ?? args[(index += 1)];
      // Why two slots: a cwd flag moves relative paths, a project flag only names where the project is searched from.
      if ((settings.names.cwd_flags[tool] ?? []).includes(name)) cwdArg = value;
      else project = value;
    } else if (!(settings.neutral_flags[tool] ?? []).includes(name)) return { rest: [], unknown: arg, flags };
  }
  return { rest: [], unknown: "", flags };
}

/** The folder a command runs in once its cwd flag is applied; null when it cannot be told. */
const movedCwd = (cwd: string, cwdArg: string | undefined): string | null => cwdArg === undefined ? cwd : isDynamicPath(cwdArg) ? null : resolvePathCandidate(cwdArg, cwd);

async function uvVerdict(scope: Scope, args: readonly string[]): Promise<Verdict | null> {
  const { ctx, cwd, env } = scope;
  const names = ctx.settings.names;
  const head = readGlobals(scope, names.uv, args);
  if (head.unknown !== undefined) return head.unknown === "" ? null : outside(`unknown flag: ${head.unknown}`);
  const { sub, rest } = head;
  // Why the folder replaces cwd for pip and venv: a prefixed folder moves where relative paths and the environment resolve; checking it alone can only err toward outside.
  const dirCwd = movedCwd(cwd, head.cwdArg);
  if (dirCwd === null) return outside("uv folder is unknown");
  const moved: Scope = { ...scope, cwd: dirCwd };
  if (sub === names.pip) {
    if (!(ctx.settings.install_words.includes(rest[0] ?? ""))) return null;
    const python = rest.findIndex((arg) => ctx.settings.interpreter_flags.includes(arg.split("=")[0] ?? ""));
    const value = python < 0 ? undefined : rest[python]?.includes("=") ? rest[python]?.split("=")[1] : rest[python + 1];
    const venv = targetEnvValue(scope, ctx.settings.names.uv, "virtual_env");
    const path = value ?? (venv === undefined ? undefined : join(venv, ...ctx.settings.names.env_python_path));
    if (path === undefined || isDynamicPath(path)) return outside("uv pip needs --python or VIRTUAL_ENV");
    return pipVerdict(moved, findExecutable(path, dirCwd, env), rest.slice(1), true);
  }
  if (sub === names.venv) {
    if (!downloadsStopped(scope, [...head.flags, ...rest])) return outside("uv may download Python");
    return venvVerdict(moved, rest, names.python_env_dir, names.uv);
  }
  if (sub === undefined || !names.uv_project.includes(sub)) return null;
  let projectArg = head.project;
  let cwdArg = head.cwdArg;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (isDynamicPath(arg)) return outside(`dynamic argument: ${arg}`);
    if (!arg.startsWith("-")) {
      if (sub === names.run) break;
      continue;
    }
    const [name = "", inline] = arg.split(/=(.*)/su);
    if ((ctx.settings.path_flags[names.uv] ?? []).includes(name)) {
      const value = inline ?? rest[(index += 1)];
      if ((names.cwd_flags[names.uv] ?? []).includes(name)) cwdArg = value;
      else projectArg = value;
    } else if (!(ctx.settings.neutral_flags[names.uv] ?? []).includes(name)) return outside(`unknown flag: ${arg}`);
  }
  const base = movedCwd(cwd, cwdArg);
  const start = base === null ? null : projectArg === undefined ? base : isDynamicPath(projectArg) ? null : resolvePathCandidate(projectArg, base);
  if (start === null) return outside("uv project folder is unknown");
  const projectDir = upwardDirWith(start, names.python_project_file) ?? start;
  const configured = targetEnvValue(scope, ctx.settings.names.uv, "project_environment");
  if (configured !== undefined && configured !== "") {
    if (!isInside(scope, configured, projectDir)) return outside("UV_PROJECT_ENVIRONMENT points outside the Project");
  } else if (!isInside(scope, join(projectDir, names.python_env_dir))) {
    return outside("the uv environment is outside the Project");
  }
  return downloadsStopped(scope, [...head.flags, ...rest]) ? inside("uv environment inside the Project") : outside("uv may download Python");
}

async function poetryVerdict(scope: Scope, args: readonly string[]): Promise<Verdict | null> {
  const { ctx, cwd, env } = scope;
  const names = ctx.settings.names;
  const head = readGlobals(scope, names.poetry, args);
  if (head.unknown !== undefined) return head.unknown === "" ? null : outside(`unknown flag: ${head.unknown}`);
  const { sub } = head;
  if (sub === undefined || !names.poetry_project.includes(sub)) return null;
  const unknown = head.rest.find((arg) => arg.startsWith("-") && !(ctx.settings.neutral_flags[names.poetry] ?? []).includes(arg));
  if (unknown !== undefined && sub !== names.run) return outside(`unknown flag: ${unknown}`);
  const start = movedCwd(cwd, head.cwdArg);
  if (start === null) return outside("poetry project folder is unknown");
  if (sub === names.run) {
    const info = await ctx.query([names.poetry, ...names.poetry_env_args], start, env);
    const path = info.stdout.trim();
    return info.exit_code === 0 && path !== "" && isInside(scope, path) ? NONE : outside("the poetry environment is not inside the Project");
  }
  const flag = targetEnvValue(scope, names.poetry, "in_project");
  let inProject = flag !== undefined && TRUE_VALUE.test(flag);
  if (flag === undefined) {
    const config = await ctx.query([names.poetry, ...names.config_get_args, names.poetry_in_project_key], start, env);
    inProject = config.exit_code === 0 && TRUE_VALUE.test(config.stdout.trim());
  }
  if (!inProject) return outside("poetry does not create the environment in the Project");
  const projectDir = upwardDirWith(start, names.python_project_file) ?? start;
  return isInside(scope, join(projectDir, names.python_env_dir)) ? inside("poetry environment inside the Project") : outside("the poetry environment is outside the Project");
}

async function nodeVerdict(scope: Scope, manager: string, args: readonly string[]): Promise<Verdict | null> {
  const { ctx, cwd, env } = scope;
  let sub: string | undefined;
  let dir: string | undefined;
  let global = false;
  let unknown: string | undefined;
  let unknownBefore: string | undefined;
  const names = ctx.settings.names;
  const dirFlags = ctx.settings.path_flags[manager] ?? [];
  const globalFlags = ctx.settings.outside_flags[manager] ?? [];
  const neutral = ctx.settings.neutral_flags[manager] ?? [];
  const readOnly = ctx.settings.read_only_words[manager] ?? [];
  // Why only when every argument reads: `yarn` with no subcommand installs, so `yarn --version --frozen-lockfile` must stay an install.
  if (args.length > 0 && args.every((arg) => readOnly.includes(arg))) return null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (isDynamicPath(arg)) return outside(`dynamic argument: ${arg}`);
    if (!arg.startsWith("-")) {
      if (sub === undefined) sub = arg;
      else if (sub === names.global_word) global = true;
      continue;
    }
    const [name = "", inline] = arg.split(/=(.*)/su);
    if (globalFlags.includes(name)) global = true;
    else if (ctx.settings.location_flags.includes(name)) global ||= ctx.settings.global_location_values.includes(inline ?? args[(index += 1)] ?? "");
    else if (dirFlags.includes(name)) dir = inline ?? args[(index += 1)];
    else if (!neutral.includes(name)) {
      if (sub === undefined) unknownBefore ??= arg;
      unknown ??= arg;
    }
  }
  // Why a later install word still counts: an unknown flag may take a value, so the word after it can be the real subcommand. Without one (`bun --version`) the command only reads.
  if (unknownBefore !== undefined && !names.bare_install_managers.includes(manager) && !args.some((arg) => ctx.settings.install_words.includes(arg) || names.node_install.includes(arg))) return null;
  if (unknownBefore !== undefined) return outside(`unknown flag before the subcommand: ${unknownBefore}`);
  const installs = sub === undefined ? names.bare_install_managers.includes(manager) : ctx.settings.install_words.includes(sub) || names.node_install.includes(sub);
  if (!installs) return null;
  if (global) return outside("global install");
  if (unknown !== undefined) return outside(`unknown flag: ${unknown}`);
  let prefixFromEnv: string | undefined;
  for (const name of ctx.settings.target_env.npm ?? []) {
    const value = envValue(env, name);
    if (value === undefined || value === "") continue;
    if (isDynamicPath(value)) return outside(`${name} is dynamic`);
    const role = ctx.settings.env_roles[name];
    if (role === "flag_outside") {
      if (TRUE_VALUE.test(value)) return outside(`${name} is set`);
    } else if (role === "location") {
      if (ctx.settings.global_location_values.includes(value)) return outside(`${name} is global`);
    } else if (role === "path") {
      prefixFromEnv = value;
    }
  }
  {
    for (const key of names.global_config_keys[manager] ?? []) {
      const answer = await ctx.query([manager, ...names.config_get_args, key], cwd, env);
      if (answer.exit_code !== 0) return outside(`${manager} config get ${key} failed`);
      if (answer.stdout.trim() === names.global_config_values[key]) return outside(`${manager} ${key} is global`);
    }
  }
  const baseArg = dir ?? prefixFromEnv;
  const base = baseArg === undefined ? cwd : resolvePathCandidate(baseArg, cwd);
  if (base === null) return outside("install folder is unknown");
  const packageDir = upwardDirWith(base, names.node_project_file) ?? base;
  return isInside(scope, join(packageDir, names.node_env_dir)) ? inside("node_modules inside the Project") : outside("node_modules is outside the Project");
}

async function classifySegment(seg: readonly string[], scope: Scope): Promise<Verdict> {
  const { ctx, cwd, env } = scope;
  const effective = effectiveCommand(seg);
  if (effective === null) return NONE;
  const args = stripRedirects(effective.args);
  const settings = ctx.settings;
  const lead = [effective.executable, ...args];
  const startsWith = (prefix: readonly string[]): boolean => prefix.every((part, index) => lead[index] === part);
  if (effective.wrappers.some((wrapper) => settings.credential_commands.some((prefix) => prefix.length === 1 && prefix[0] === wrapper)) || settings.credential_commands.some(startsWith)) return { scope: "outside", reason: `${[...effective.wrappers, effective.executable].join(" ")} needs credentials`, denied: true };
  if (effective.wrappers.some((wrapper) => settings.always_outside.some((prefix) => prefix.length === 1 && prefix[0] === wrapper))) return outside(`${effective.wrappers.join(" ")} changes the system`);
  if (settings.always_outside.some(startsWith)) {
    // Why flags are skipped per tool: brew -v alone prints the version, but brew -v install jq is a verbose install, so only the first word after the tool's neutral flags decides.
    const word = args.find((arg) => !(settings.neutral_flags[effective.executable] ?? []).includes(arg));
    return word === undefined || (settings.read_only_words[effective.executable] ?? []).includes(word) ? NONE : outside(`${effective.executable} changes the system`);
  }

  const pythonName = namePattern(settings.executables.python);
  const pipName = namePattern(settings.executables.pip);
  const raw = seg[seg.length - effective.args.length - 1] ?? effective.executable;
  const module = pythonName.test(effective.executable) && args[0] === settings.names.module_flag ? args[1] ?? "" : "";
  const viaModule = pipName.test(module);
  const tool = viaModule || pipName.test(effective.executable) ? settings.names.pip : settings.executables.venv_names.includes(module) || settings.executables.venv_names.includes(effective.executable) ? settings.names.venv : effective.executable;
  const rest = viaModule ? args.slice(2) : tool === settings.names.venv && module !== "" ? args.slice(2) : args;
  if (settings.config_writes.some((prefix) => prefix.every((part, index) => [tool, ...rest][index] === part))) return outside(`${tool} configuration is changed`);

  if (settings.executables.shells.includes(effective.executable)) {
    const readsStdin = !args.some((arg) => /^-[A-Za-z]*c[A-Za-z]*$/u.test(arg)) && (args.includes("-s") || !args.some((arg) => !arg.startsWith("-")));
    return readsStdin ? outside("a shell runs a script from standard input") : NONE;
  }

  let verdict: Verdict | null = null;
  const known = (): Verdict | null => (scope.envUnknown ? outside("environment variables are unknown after source") : cwd === UNKNOWN_CWD ? outside("working directory is unknown") : null);
  if (tool === settings.names.pip) {
    // Options in front of the subcommand are read: --python changes which Python pip runs under, and an unknown one is not followed.
    let sub: string | undefined;
    let subAt = 0;
    let interpreter: string | undefined;
    let unknownFlag: string | undefined;
    for (; subAt < rest.length; subAt += 1) {
      const arg = rest[subAt] ?? "";
      if (!arg.startsWith("-")) { sub = arg; break; }
      const [name = "", inline] = arg.split(/=(.*)/su);
      if (settings.interpreter_flags.includes(name)) interpreter = inline ?? rest[(subAt += 1)] ?? "";
      else if (!(settings.neutral_flags[settings.names.pip] ?? []).includes(name)) unknownFlag ??= arg;
    }
    // Why any later install word counts: an unknown option may take a value, so the word after it can still be the real subcommand.
    if (unknownFlag !== undefined && rest.some((arg) => settings.install_words.includes(arg))) return outside(`unknown flag before the subcommand: ${unknownFlag}`);
    if (sub === undefined || !settings.install_words.includes(sub)) return NONE;
    if (unknownFlag !== undefined) return outside(`unknown flag before the subcommand: ${unknownFlag}`);
    const python = interpreter === undefined ? pipPython(raw, viaModule, cwd, env) : isDynamicPath(interpreter) ? null : findExecutable(interpreter, cwd, env);
    verdict = known() ?? await pipVerdict(scope, python, rest.slice(subAt + 1), false);
  } else if (tool === settings.names.venv) {
    verdict = known() ?? venvVerdict(scope, rest, null, settings.names.venv);
  } else if (tool === settings.names.uv) {
    verdict = (await uvVerdict(scope, rest).then((result) => result === null ? null : known() ?? result));
  } else if (tool === settings.names.poetry) {
    const pending = await poetryVerdict(scope, rest);
    verdict = pending === null ? null : known() ?? pending;
  } else if (settings.names.node_managers.includes(tool)) {
    const pending = await nodeVerdict(scope, tool, rest);
    verdict = pending === null ? null : known() ?? pending;
  }
  // Why one fallback for every branch: a dedicated verdict of null means the form is unsupported, and an install word in it must still count as outside.
  if (verdict === null && rest.some((arg) => settings.install_words.includes(arg))) return outside(`${tool} looks like an install`);
  return verdict ?? NONE;
}

/** The argv that runs and is recorded has no subshell parentheses, wherever they stand in the segment. */
function withoutSubshellMarkers(seg: readonly string[]): readonly string[] {
  return seg.filter((token) => token !== SUBSHELL_OPEN && token !== SUBSHELL_CLOSE);
}

/**
 * Whether a command installs something, and whether that stays inside the checkouts.
 * Only an install shown to stay inside counts as "inside"; every install that cannot be shown is "outside".
 */
export async function classifyInstallCommand(command: string | readonly string[], ctx: InstallContext): Promise<InstallClass> {
  const analysis = analyzeShellCommand(typeof command === "string" ? command : command.map(shellQuote).join(" "));
  if (analysis === null) return { scope: "outside", segments: [{ argv: [], scope: "outside", reason: "the command could not be analyzed" }] };
  let cwd = ctx.cwd;
  let env: Record<string, string> = { ...ctx.env };
  let envUnknown = false;
  const segments: InstallSegmentClass[] = [];
  // An approved command also covers the installs expanded out of its own text (`sh -c "brew install jq"`), once per approved parent.
  const allowedNested: (readonly string[])[] = analysis.segments.slice(0, analysis.top_level_count).map(withoutSubshellMarkers)
    .filter((seg) => ctx.approved.some((argv) => sameArgv(argv, seg)))
    .flatMap((seg) => { const own = analyzeShellCommand(seg.map(shellQuote).join(" ")); return own === null ? [] : own.segments.slice(own.top_level_count).map(withoutSubshellMarkers); });
  for (const [index, rawSeg] of analysis.segments.entries()) {
    const topLevel = index < analysis.top_level_count;
    const subshell = rawSeg.includes(SUBSHELL_OPEN);
    const seg = withoutSubshellMarkers(rawSeg);
    let segmentCwd: string | null = null;
    const assignments = seg.filter(isEnvironmentAssignment);
    if (assignments.length === seg.length) {
      if (topLevel) for (const item of assignments) env[item.slice(0, item.indexOf("="))] = item.slice(item.indexOf("=") + 1);
      continue;
    }
    const effective = effectiveCommand(seg);
    if (effective === null) continue;
    if (topLevel && effective.executable === "export") {
      for (const item of effective.args.filter(isEnvironmentAssignment)) env[item.slice(0, item.indexOf("="))] = item.slice(item.indexOf("=") + 1);
      continue;
    }
    if (topLevel && effective.executable === "unset") {
      env = Object.fromEntries(Object.entries(env).filter(([key]) => !effective.args.includes(key)));
      continue;
    }
    if (topLevel && (effective.executable === "source" || effective.executable === ".")) {
      envUnknown = true;
      continue;
    }
    if (topLevel) {
      cwd = advanceWorkingDirectory(seg, cwd);
      // `(cd x; ...)` runs in a subshell, so what follows it cannot be placed.
      // The subshell's own command still runs in the directory it was written in.
      if (subshell) { segmentCwd = cwd; cwd = UNKNOWN_CWD; }
    }
    // A prefix assignment (`PIP_TARGET=/x pip install`) applies to that segment only.
    const { env: segmentEnv, unknown } = prefixEnvironment(seg.slice(0, seg.length - effective.args.length - 1), env);
    const nestedAt = topLevel ? -1 : allowedNested.findIndex((candidate) => sameArgv(candidate, seg));
    if (nestedAt >= 0) allowedNested.splice(nestedAt, 1);
    if ((topLevel && ctx.approved.some((argv) => sameArgv(argv, seg))) || nestedAt >= 0) {
      segments.push({ argv: seg, scope: "inside", reason: "approved by the Owner" });
      continue;
    }
    const verdict = await classifySegment(seg, { cwd: wrapperCwd(seg, segmentCwd ?? cwd), env: segmentEnv, envUnknown: envUnknown || unknown, ctx });
    // Inside `sh -c` and `$(...)` the working directory and environment are not tracked.
    segments.push({ argv: seg, scope: !topLevel && verdict.scope !== "none" ? "outside" : verdict.scope, reason: !topLevel && verdict.scope !== "none" && !verdict.denied ? "an install inside a nested shell cannot be placed" : verdict.reason, ...(verdict.denied ? { denied: true } : {}) });
  }
  const scope: InstallScope = segments.some((s) => s.scope === "outside") ? "outside" : segments.some((s) => s.scope === "inside") ? "inside" : "none";
  return { scope, segments };
}

/** Paths a command writes by redirection or `tee` that lie outside the roots and the always-writable places. */
export function outsideWriteTargets(command: string, input: { readonly cwd: string; readonly roots: readonly string[]; readonly writable: readonly string[] }): string[] {
  const analysis = analyzeShellCommand(command);
  if (analysis === null) return [command];
  const places = [...input.roots, ...input.writable];
  const offenders: string[] = [];
  let cwd = input.cwd;
  // A nested shell (`sh -c`, `$(...)`) inherits the directory of a parent we cannot pair it with, so its relative targets are only placed when nothing in the command moves.
  const words = analysis.segments.map(withoutSubshellMarkers);
  let moved = words.slice(analysis.top_level_count).some((seg) => ["cd", "pushd", "popd"].includes(effectiveCommand(seg)?.executable ?? "") || wrapperCwd(seg, input.cwd) !== input.cwd);
  for (const [index, seg] of words.entries()) {
    const topLevel = index < analysis.top_level_count;
    // A redirection is opened by the calling shell before `env -C` takes effect; `tee` opens its file in the directory it runs in.
    const shellCwd = topLevel ? cwd : moved ? UNKNOWN_CWD : input.cwd;
    const targets = seg.flatMap((token, position) => (token === ">" || token === ">>") && seg[position + 1] !== undefined ? [{ path: seg[position + 1] as string, base: shellCwd }] : []);
    const effective = effectiveCommand(seg);
    if (effective?.executable === "tee") targets.push(...effective.args.filter((arg) => !arg.startsWith("-")).map((path) => ({ path, base: wrapperCwd(seg, shellCwd) })));
    for (const target of targets) if (resolveInstallTarget(target.path, target.base, places) === "outside") offenders.push(target.path);
    if (topLevel) {
      const next = analysis.segments[index]?.includes(SUBSHELL_OPEN) ? UNKNOWN_CWD : advanceWorkingDirectory(seg, cwd);
      if (next !== cwd || wrapperCwd(seg, cwd) !== cwd) moved = true;
      cwd = next;
    }
  }
  return offenders;
}

export interface RunnerGate {
  readonly gate: TestRunGate;
  /** The checkouts a command run in `cwd` belongs to. */
  readonly roots: (cwd: string) => readonly string[];
  /** The environment the wrapped runner gives its child processes. */
  readonly env: Readonly<Record<string, string>>;
  readonly approved: readonly (readonly string[])[];
  readonly settings: InstallSettings;
  readonly query: InstallQuery;
  /** Called with each Mac-wide install the wrapped runner is about to run. */
  readonly onInstall?: (argv: readonly string[]) => void;
}

/**
 * Wraps a runner so that an install needing credentials never starts a process; an install onto the Mac runs and is reported to onInstall.
 * `gate: "all"` judges every command; `{ only }` judges just those argvs (the rest is the Owner's own test_run).
 */
export function gatedTestRunner(run: TestCommandRunner, gate: RunnerGate): TestCommandRunner {
  return async (argv, cwd, timeoutMs, outputLimitBytes, onOutput) => {
    const judged = gate.gate === "all" || gate.gate.only.some((candidate) => candidate.length === argv.length && candidate.every((part, index) => argv[index] === part));
    if (judged) {
      const result = await classifyInstallCommand(argv, { cwd, roots: gate.roots(cwd), env: gate.env, approved: gate.approved, settings: gate.settings, query: gate.query });
      if (result.segments.some((segment) => segment.denied === true)) return { exit_code: null, timed_out: false, stdout: "", stderr: "", duration_ms: 0, error: `install_needs_approval: ${argv.join(" ")}` };
      for (const segment of result.segments) if (segment.scope === "outside") gate.onInstall?.(segment.argv);
    }
    return run(argv, cwd, timeoutMs, outputLimitBytes, onOutput);
  };
}

export interface TestSetupRunEntry {
  readonly project_id: string;
  readonly roots: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly approved: readonly (readonly string[])[];
  /** Mac-wide installs Core saw the investigation run; filled while it runs. */
  readonly installs: (readonly string[])[];
}

/** The investigations that are running now, by agent run id. Memory only: the guard token dies with the server too. */
export class TestSetupRunRegistry {
  private readonly runs = new Map<string, TestSetupRunEntry>();

  /** Returns the function that removes the entry. */
  public register(invocationId: string, entry: TestSetupRunEntry): () => void {
    this.runs.set(invocationId, entry);
    return () => { this.runs.delete(invocationId); };
  }

  public get(invocationId: string): TestSetupRunEntry | undefined {
    return this.runs.get(invocationId);
  }
}
