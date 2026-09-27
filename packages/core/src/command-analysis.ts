import { basename, dirname, resolve, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";

const HOME_TOKEN = "__OWL_HOME__";
const UNKNOWN_ENV_PREFIX = "__OWL_ENV_";
const UNKNOWN_COMMAND_SUBSTITUTION = "__OWL_COMMAND_SUBSTITUTION__";

export interface ShellCommandAnalysis {
  readonly segments: readonly (readonly string[])[];
}

/** Tokenize shell commands without executing them; operators and substitutions are analyzed separately. */
export function analyzeShellCommand(command: string): ShellCommandAnalysis | null {
  const nestedSegments: string[][] = [];
  const segments = tokenize(command, nestedSegments, 0);
  if (segments === null) return null;
  const allSegments = [...segments, ...nestedSegments].filter((segment) => segment.length > 0);
  const expanded: string[][] = [];
  for (const segment of allSegments) {
    const effective = effectiveCommand(segment);
    if (!effective) continue;
    const splitStringCommand = environmentSplitStringCommand(segment);
    if (splitStringCommand !== null) {
      const nested = analyzeNestedShell(splitStringCommand, 1);
      if (nested === null) return null;
      expanded.push(...nested);
    }
    let script: string | null = null;
    if (["sh", "bash", "zsh", "dash", "ksh", "fish"].includes(effective.executable)) {
      const commandFlag = effective.args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/u.test(arg));
      if (commandFlag >= 0) script = effective.args[commandFlag + 1] ?? null;
    } else if (effective.executable === "eval") script = effective.args.join(" ");
    if (script === null) continue;
    const nested = analyzeNestedShell(script, 1);
    if (nested === null) return null;
    expanded.push(...nested);
  }
  return { segments: [...allSegments, ...expanded] };
}

function analyzeNestedShell(command: string, depth: number): string[][] | null {
  if (depth > 12) return null;
  const substitutions: string[][] = [];
  const segments = tokenize(command, substitutions, depth);
  if (segments === null) return null;
  const result = [...segments, ...substitutions].filter((segment) => segment.length > 0);
  const expanded: string[][] = [];
  for (const segment of result) {
    const effective = effectiveCommand(segment);
    if (!effective) continue;
    let script: string | null = null;
    if (["sh", "bash", "zsh", "dash", "ksh", "fish"].includes(effective.executable)) {
      const commandFlag = effective.args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/u.test(arg));
      if (commandFlag >= 0) script = effective.args[commandFlag + 1] ?? null;
    } else if (effective.executable === "eval") script = effective.args.join(" ");
    if (script !== null) {
      const nested = analyzeNestedShell(script, depth + 1);
      if (nested === null) return null;
      expanded.push(...nested);
    }
  }
  return [...result, ...expanded];
}

function environmentSplitStringCommand(tokens: readonly string[]): string | null {
  const envIndex = tokens.findIndex((token) => normalizeExecutable(token) === "env");
  if (envIndex < 0) return null;
  for (let index = envIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "-S" || token === "--split-string") {
      return [tokens[index + 1] ?? "", ...tokens.slice(index + 2)].join(" ");
    }
    if (token.startsWith("--split-string=")) {
      return [token.slice("--split-string=".length), ...tokens.slice(index + 1)].join(" ");
    }
    if (token === "--") break;
  }
  return null;
}

function tokenize(command: string, nestedSegments: string[][], depth: number): string[][] | null {
  if (depth > 12) return null;
  const segments: string[][] = [];
  let segment: string[] = [];
  let current = "";
  let tokenStarted = false;
  let quote: "'" | '"' | null = null;

  const pushToken = (): void => {
    if (tokenStarted) segment.push(current);
    current = "";
    tokenStarted = false;
  };
  const pushSegment = (): void => {
    pushToken();
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";

    if (quote !== "'") {
      if (character === "$" && command[index + 1] === "(") {
        const nested = readParenthesized(command, index + 1);
        if (nested === null) return null;
        const nestedResult = tokenize(nested.content, nestedSegments, depth + 1);
        if (nestedResult === null) return null;
        nestedSegments.push(...nestedResult.filter((part) => part.length > 0));
        current += UNKNOWN_COMMAND_SUBSTITUTION;
        tokenStarted = true;
        index = nested.end;
        continue;
      }
      if (character === "`" && (index === 0 || command[index - 1] !== "\\")) {
        const end = findUnescaped(command, "`", index + 1);
        if (end < 0) return null;
        const nestedResult = tokenize(command.slice(index + 1, end), nestedSegments, depth + 1);
        if (nestedResult === null) return null;
        nestedSegments.push(...nestedResult.filter((part) => part.length > 0));
        current += UNKNOWN_COMMAND_SUBSTITUTION;
        tokenStarted = true;
        index = end;
        continue;
      }
      if (character === "$") {
        const variable = readVariable(command, index);
        if (variable !== null) {
          current += variable.value;
          tokenStarted = true;
          index = variable.end;
          continue;
        }
      }
    }

    if (character === "\\" && quote !== "'") {
      const next = command[index + 1];
      if (next === undefined) return null;
      if (quote === '"' && !["$", "`", '"', "\\", "\n"].includes(next)) {
        current += "\\";
      } else if (next !== "\n") {
        current += next;
        tokenStarted = true;
      }
      index += 1;
      continue;
    }

    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (character === "#" && !tokenStarted && (index === 0 || /\s/u.test(command[index - 1] ?? ""))) {
      while (index < command.length && command[index] !== "\n") index += 1;
      if (index < command.length) pushSegment();
      continue;
    }
    if (character === "\n" || character === ";") {
      pushSegment();
      continue;
    }
    if (character === "&" || character === "|") {
      pushSegment();
      if (command[index + 1] === character) index += 1;
      continue;
    }
    if (character === ">" || character === "<") {
      pushToken();
      if (command[index + 1] === character) {
        segment.push(character + character);
        index += 1;
      } else {
        segment.push(character);
      }
      continue;
    }
    if (/\s/u.test(character)) {
      pushToken();
      continue;
    }
    current += character;
    tokenStarted = true;
  }

  if (quote !== null) return null;
  pushSegment();
  return segments;
}

function readParenthesized(value: string, openIndex: number): { content: string; end: number } | null {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = openIndex; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return { content: value.slice(openIndex + 1, index), end: index };
    }
  }
  return null;
}

function findUnescaped(value: string, target: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === target && value[index - 1] !== "\\") return index;
  }
  return -1;
}

function readVariable(value: string, start: number): { value: string; end: number } | null {
  if (value[start + 1] === "{") {
    const close = value.indexOf("}", start + 2);
    if (close < 0) return null;
    const name = value.slice(start + 2, close);
    if (name === "HOME") return { value: HOME_TOKEN, end: close };
    const baseName = name.match(/^[A-Za-z_][A-Za-z0-9_]*/u)?.[0] ?? "UNKNOWN";
    return { value: `${UNKNOWN_ENV_PREFIX}${baseName}__`, end: close };
  }
  const match = value.slice(start + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/u);
  if (!match) return null;
  const name = match[0];
  return {
    value: name === "HOME" ? HOME_TOKEN : `${UNKNOWN_ENV_PREFIX}${name}__`,
    end: start + name.length,
  };
}

export function normalizeExecutable(value: string): string {
  return basename(value.replace(/\\/gu, "/")).replace(/\.exe$/iu, "").toLowerCase();
}

export interface EffectiveCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly wrappers: readonly string[];
}

export function effectiveCommand(tokens: readonly string[]): EffectiveCommand | null {
  let index = 0;
  const wrappers: string[] = [];
  let executable = "";
  let args: string[] = [];
  let guard = 0;

  while (index < tokens.length && guard++ < 12) {
    while (index < tokens.length && isEnvironmentAssignment(tokens[index] ?? "")) index += 1;
    if (index >= tokens.length) return null;
    const current = normalizeExecutable(tokens[index] ?? "");
    if (current === "env") {
      wrappers.push(current);
      index += 1;
      while (index < tokens.length) {
        const token = tokens[index] ?? "";
        if (token === "-i" || token === "--ignore-environment" || token === "-0" || token === "--null") index += 1;
        else if (token === "-u" || token === "--unset") index += 2;
        else if (isEnvironmentAssignment(token)) index += 1;
        else break;
      }
      continue;
    }
    if (current === "sudo") {
      wrappers.push(current);
      index += 1;
      while (index < tokens.length) {
        const token = tokens[index] ?? "";
        if (token === "--") { index += 1; break; }
        if (token === "-u" || token === "--user" || token === "-g" || token === "--group" || token === "-h" || token === "--host" || token === "-p" || token === "--prompt" || token === "-C" || token === "--close-from") {
          index += 2;
          continue;
        }
        if (/^-(?:n|E|H|S|b|s|k|K|V|v|l|P|i|D|A|a|R|T|U|r|t|B|X|x|e|g|h|p|C|u|)$/.test(token) || token.startsWith("--preserve-env")) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (["!", "command", "exec", "builtin", "nohup", "time"].includes(current)) {
      wrappers.push(current);
      index += 1;
      if ((current === "command" || current === "builtin") && tokens[index] === "--") index += 1;
      if (current === "time" && tokens[index]?.startsWith("-")) index += 1;
      continue;
    }

    executable = current;
    args = tokens.slice(index + 1);
    if (executable === "git") args = stripGitGlobalOptions(args);
    break;
  }
  if (executable.length === 0) return null;
  return { executable, args, wrappers };
}

function isEnvironmentAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value);
}

function stripGitGlobalOptions(args: readonly string[]): string[] {
  const result: string[] = [];
  let index = 0;
  while (index < args.length) {
    const token = args[index] ?? "";
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(token)) {
      index += 2;
      continue;
    }
    if (["--no-pager", "--paginate", "--no-optional-locks", "--bare", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs"].includes(token)) {
      index += 1;
      continue;
    }
    if (["--git-dir", "--work-tree", "--namespace"].some((name) => token.startsWith(`${name}=`)) || /^-C.+$/u.test(token)) {
      index += 1;
      continue;
    }
    result.push(...args.slice(index));
    break;
  }
  return result;
}

export function optionFlags(value: string): ReadonlySet<string> {
  if (value.startsWith("--")) {
    const name = value.split("=", 1)[0] ?? value;
    const aliases: Readonly<Record<string, string>> = {
      "--force": "-f",
      "--recursive": "-r",
      "--directories": "-d",
      "--directory": "-d",
      "--ignored": "-x",
      "--interactive": "-i",
      "--verbose": "-v",
      "--hard": "--hard",
    };
    return new Set([aliases[name] ?? name]);
  }
  if (/^-[^-].*$/u.test(value) && value.length > 1) return new Set([...value.slice(1)].map((flag) => flag === "R" ? "-r" : `-${flag}`));
  return new Set();
}

export const UNKNOWN_CWD = "__OWL_UNKNOWN_CWD__";

export function resolvePathCandidate(value: string, cwd: string, home = process.env.HOME): string | null {
  if (value.includes(UNKNOWN_ENV_PREFIX) || value.includes(UNKNOWN_COMMAND_SUBSTITUTION)) return null;
  let expanded = value.replaceAll(HOME_TOKEN, home ? resolve(home) : "~");
  if (expanded === "~+" || expanded.startsWith("~+/")) {
    if (cwd === UNKNOWN_CWD) return null;
    expanded = resolve(cwd, expanded.slice(3));
  } else if (expanded === "~-" || expanded.startsWith("~-/")) {
    return null;
  } else {
    const username = process.env.USER ?? process.env.USERNAME;
    if (home && username && (expanded === `~${username}` || expanded.startsWith(`~${username}/`))) {
      expanded = resolve(home, expanded.slice(username.length + 1).replace(/^\//u, ""));
    }
  }
  if (expanded === "~") expanded = home ? resolve(home) : "~";
  else if (expanded.startsWith("~/")) expanded = home ? resolve(home, expanded.slice(2)) : `~/${expanded.slice(2)}`;
  if (cwd === UNKNOWN_CWD && !expanded.startsWith("/")) return null;
  const lexicalPath = resolve(cwd === UNKNOWN_CWD ? "/" : cwd, expanded);
  return lexicalPath.replaceAll(String.fromCharCode(92), "/");
}

export function normalizePathCandidate(value: string, cwd: string, home = process.env.HOME): string | null {
  const candidate = resolvePathCandidate(value, cwd, home);
  return candidate === null ? null : canonicalizePath(candidate);
}

/** Resolve existing symlinks in the longest path prefix, including new files and globs. */
export function canonicalizePath(value: string): string {
  const absolute = resolve(value);
  let cursor = absolute;
  const suffix: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync(cursor), ...suffix).replaceAll(String.fromCharCode(92), "/");
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return absolute.replaceAll(String.fromCharCode(92), "/");
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export function advanceWorkingDirectory(tokens: readonly string[], cwd: string, home = process.env.HOME): string {
  const effective = effectiveCommand(tokens);
  if (!effective) return cwd;
  if (effective.executable === "popd") return UNKNOWN_CWD;
  if (effective.executable !== "cd" && effective.executable !== "pushd") return cwd;
  if (effective.args.includes("-")) return UNKNOWN_CWD;
  const target = pathArguments(effective.args)[0] ?? (effective.executable === "cd" ? HOME_TOKEN : null);
  if (target === null) return UNKNOWN_CWD;
  const normalized = normalizePathCandidate(target, cwd, home);
  if (normalized === null) return UNKNOWN_CWD;
  try {
    return statSync(normalized).isDirectory() ? normalized : cwd;
  } catch {
    return cwd;
  }
}

function pathArguments(args: readonly string[]): string[] {
  const values: string[] = [];
  let afterTerminator = false;
  for (const arg of args) {
    if (arg === "--") {
      afterTerminator = true;
      continue;
    }
    if (!afterTerminator && arg.startsWith("-")) continue;
    values.push(arg);
  }
  return values;
}

export function pathIsRootOrContainsHome(value: string, cwd: string, home = process.env.HOME): boolean {
  const normalized = normalizePathCandidate(value, cwd, home);
  if (normalized === null) return true;
  if (normalized === "/") return true;
  if (!home) return false;
  let normalizedHome = resolve(home).replaceAll("\\", "/");
  try {
    normalizedHome = realpathSync(normalizedHome).replaceAll("\\", "/");
  } catch {
    // Keep the configured home spelling if it is not resolvable.
  }
  const relativeHome = normalizedHome === normalized ? "" : normalizedHome.startsWith(`${normalized}${sep}`) || normalizedHome.startsWith(`${normalized}/`)
    ? normalizedHome.slice(normalized.length).replace(/^\/+/, "")
    : null;
  if (relativeHome !== null) return true;
  if ([`${normalizedHome}/*`, `${normalizedHome}/**`, `${normalizedHome}/.*`].includes(normalized)) return true;
  const targetParts = normalized.split("/").filter(Boolean);
  const homeParts = normalizedHome.split("/").filter(Boolean);
  for (let count = 0; count <= homeParts.length; count += 1) {
    const ancestor = homeParts.slice(0, count);
    if (targetParts.length === ancestor.length && targetParts.every((part, index) => part === ancestor[index] || part === "*" || part === "**")) return true;
  }
  return false;
}

export function isPathLike(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value === "~+" || value.startsWith("~+/") || value === "~-" || value.startsWith("~-/") || value.startsWith("/") || value.startsWith(HOME_TOKEN) || value.includes("/") || value.startsWith(".");
}

export function isDynamicPath(value: string): boolean {
  const normalized = value.toUpperCase();
  return normalized.includes(UNKNOWN_ENV_PREFIX) || normalized.includes(UNKNOWN_COMMAND_SUBSTITUTION);
}

export function shellTokenForHome(): string {
  return HOME_TOKEN;
}
