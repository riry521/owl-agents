import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { GUARD_PATH_KEYS, GUARD_SHELL_COMMAND_KEYS, GUARD_SHELL_TOOL_NAMES } from "../../shared/dist/guard-inputs.js";
import type { PolicyCheck } from "./task-verification-policy.js";

const run = promisify(execFile);

/** Folders under root (relative paths) that hold their own .git, root excluded. Does not descend into a clone or follow symlinks. */
export async function findNestedClones(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    // Why not skip an unreadable folder: a clone inside it would pass unseen.
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      throw new Error(`Cannot scan ${rel === "" ? "." : rel} for clones: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (rel !== "" && entries.some((entry) => entry.name === ".git")) {
      found.push(rel);
      return;
    }
    for (const entry of entries) {
      // A symlink Dirent reports isDirectory() false, so links are never followed.
      if (entry.isDirectory() && entry.name !== ".git") await walk(join(dir, entry.name), rel === "" ? entry.name : `${rel}/${entry.name}`);
    }
  };
  await walk(root, "");
  return found.sort();
}

/** Paths HEAD adds or changes as gitlinks (mode 160000) against `base`. Throws when git fails. */
export async function gitlinkPathsSince(cwd: string, base: string): Promise<string[]> {
  const out = await run("git", ["diff", "-z", "--raw", "--no-renames", "--diff-filter=AMT", base, "HEAD"], { cwd, maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout, (error: unknown) => {
    throw new Error(`Cannot list gitlinks since ${base}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const parts = out.split("\0");
  const paths: string[] = [];
  // With -z each record is ":<old mode> <new mode> <old sha> <new sha> <status>" then the path.
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i].split(" ")[1] === "160000") paths.push(parts[i + 1]);
  return paths.sort();
}

const inside = (path: string, root: string): boolean => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** One shell word; `redirect` marks the target of a `<` or `>` redirection. */
interface ShellWord {
  readonly text: string;
  readonly redirect: boolean;
}

const HOME_VARIABLE = /^\$(?:HOME\b|\{HOME\})/u;

/**
 * The simple commands of a shell line, each as its words, with `(` and `)` kept where a subshell opens and closes.
 * Quotes and backslashes are honoured; an unquoted leading `~`, `$HOME` and `${HOME}` become `home`, nothing else is expanded.
 */
function shellCommands(command: string, home: string): Array<ShellWord[] | "(" | ")"> {
  let words: ShellWord[] = [];
  const commands: Array<ShellWord[] | "(" | ")"> = [words];
  let word: string | null = null;
  let quote: string | null = null;
  let redirect = false;
  const end = (): void => {
    if (word === null) return;
    words.push({ text: word, redirect });
    word = null;
    redirect = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const homeVariable = c === "$" && quote !== "'" ? HOME_VARIABLE.exec(command.slice(i)) : null;
    if (homeVariable !== null) {
      word = (word ?? "") + home;
      i += homeVariable[0].length - 1;
    } else if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === "\"" && i + 1 < command.length) word += command[++i];
      else word += c;
    } else if (c === "~" && word === null && /^[/\s;&|()<>]?$/u.test(command.slice(i + 1, i + 2))) word = home;
    else if (c === "'" || c === "\"") {
      quote = c;
      word ??= "";
    } else if (c === "\\" && i + 1 < command.length) word = (word ?? "") + command[++i];
    else if (c === "<" || c === ">") {
      end();
      // `<<` and `<<<` take a heredoc delimiter or a string, and `>&2` a file descriptor, not a path.
      if (c === "<" && command[i + 1] === "<") while (command[i + 1] === "<") i++;
      else if (command[i + 1] === "&") while (/[&\d-]/u.test(command[i + 1] ?? "")) i++;
      else redirect = true;
    } else if (";&|()\n".includes(c)) {
      end();
      redirect = false;
      if (c === "(" || c === ")") commands.push(c);
      words = [];
      commands.push(words);
    } else if (/\s/u.test(c)) end();
    else word = (word ?? "") + c;
  }
  end();
  return commands;
}

/** git global options that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set(["-c", "--namespace", "--config-env", "--git-dir", "--work-tree"]);
/** git clone options that take the next word as their value. */
const CLONE_VALUE_OPTIONS = new Set(["-b", "--branch", "--depth", "-o", "--origin", "--reference", "--separate-git-dir", "--template", "-j", "--jobs", "--filter", "--config", "-c", "--upload-pack", "-u", "--server-option", "--shallow-since", "--shallow-exclude", "--revision"]);

/**
 * Every path a Bash command may touch, taken broadly: its working folder as `cd` and `git -C` move it, every word that is
 * not an option, the value after `=` in an option or assignment, redirection targets, and the folder `git clone` creates.
 * Why not pick only the path operands of each command: every per-command rule missed a path or took text as one.
 * An extra path is harmless because usedCloneCheck fails a clone only when it changed from its baseline.
 */
function bashPaths(command: string, cwd: string, home: string): string[] {
  const paths = [cwd];
  let dir = cwd;
  const outer: string[] = [];
  for (const words of shellCommands(command, home)) {
    if (words === "(") outer.push(dir);
    if (words === ")") dir = outer.pop() ?? dir;
    if (typeof words === "string") continue;
    const args = words.filter((word) => !word.redirect).map((word) => word.text);
    while (args.length > 0 && /^[A-Za-z_]\w*=/u.test(args[0])) args.shift();
    const [program = "", ...rest] = args;
    const name = basename(program);
    let where = dir;
    if (name === "cd" || name === "pushd") {
      let i = 0;
      while (i < rest.length && rest[i].startsWith("-") && rest[i] !== "-") if (rest[i++] === "--") break;
      const target = rest[i] ?? home;
      if (target !== "-") {
        dir = resolve(dir, target);
        paths.push(dir);
      }
    }
    if (name === "git") {
      let i = 0;
      for (; i < rest.length && rest[i].startsWith("-"); i++) {
        if (rest[i].startsWith("-C")) where = resolve(where, (rest[i] === "-C" ? rest[++i] : rest[i].slice(2)) ?? ".");
        else if (GIT_VALUE_OPTIONS.has(rest[i])) i++;
      }
      paths.push(where);
      const operands = rest.slice(i + 1);
      if (rest[i] === "clone") {
        const positional: string[] = [];
        for (let j = 0; j < operands.length; j++) {
          if (operands[j] === "--") {
            positional.push(...operands.slice(j + 1));
            break;
          }
          if (!operands[j].startsWith("-")) positional.push(operands[j]);
          else if (CLONE_VALUE_OPTIONS.has(operands[j])) j++;
        }
        const repo = positional[0]?.split(/[/:]/u).filter((part) => part !== "").pop();
        const target = positional[1] ?? (repo === undefined ? undefined : basename(repo, ".git"));
        if (target !== undefined) paths.push(resolve(where, target));
      }
    }
    for (const word of words) {
      const base = word.redirect ? dir : where;
      const value = word.text.indexOf("=");
      if (value > 0) paths.push(resolve(base, word.text.slice(value + 1)));
      if (!word.text.startsWith("-")) paths.push(resolve(base, word.text));
    }
  }
  return paths;
}

/** `path` with a leading `~` replaced by `home`. */
const expandHome = (path: string, home: string): string => (path === "~" || path.startsWith("~/") ? home + path.slice(1) : path);

/**
 * Paths under `root` that a tool call points at: its path arguments and, for Bash, the paths bashPaths finds.
 * `home` is the folder `~` and `$HOME` stand for. A clone that does not exist yet is mapped by usedClones later.
 */
export function pathsUnderCloneRoot(root: string, toolName: string, toolInput: Readonly<Record<string, unknown>>, cwd: string, home: string): string[] {
  const raw: string[] = [];
  const key = GUARD_SHELL_COMMAND_KEYS.find((candidate) => typeof toolInput[candidate] === "string");
  if (GUARD_SHELL_TOOL_NAMES.has(toolName.toLowerCase()) && key !== undefined) raw.push(...bashPaths(String(toolInput[key]), cwd, home));
  for (const name of GUARD_PATH_KEYS) {
    const value = toolInput[name];
    const values = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    raw.push(...values.map((item) => resolve(cwd, expandHome(item, home))));
  }
  return [...new Set(raw.filter((path) => inside(path, root)))];
}

/** The clones (folders with their own .git) under `root` that contain any of `paths`; a path not created yet counts through its nearest existing parent. */
export function usedClones(root: string, paths: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const path of paths) {
    for (let dir = path; inside(dir, root); dir = dirname(dir)) {
      if (existsSync(join(dir, ".git"))) {
        found.add(dir);
        break;
      }
    }
  }
  return [...found].sort();
}

/** What a tool call used: `exists` is true when `path` was already a clone then, so its later absence is a deletion. */
export interface CloneUse {
  readonly path: string;
  readonly exists: boolean;
}

/** The clone uses of one tool call under `root`; `home` is the folder `~` and `$HOME` stand for. */
export function cloneUses(root: string, toolName: string, toolInput: Readonly<Record<string, unknown>>, cwd: string, home: string): CloneUse[] {
  const uses = new Map<string, boolean>();
  for (const path of pathsUnderCloneRoot(root, toolName, toolInput, cwd, home)) {
    const [clone] = usedClones(root, [path]);
    if (clone !== undefined) uses.set(clone, true);
    else if (!uses.has(path)) uses.set(path, false);
  }
  return [...uses].map(([path, exists]) => ({ path, exists }));
}

/** A CloneUse with the state its clone had when the Task first used it ("" for a clean clone or one not created yet). */
export interface RecordedCloneUse extends CloneUse {
  readonly baseline: string;
}

/**
 * The state of a clone: `git status --porcelain` with a hash of each file it lists, so a further edit to an already changed file shows too.
 * "" for a clean clone. Rejects when git cannot read the clone.
 */
export async function cloneState(clone: string): Promise<string> {
  const { stdout } = await run("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: clone, maxBuffer: 64 * 1024 * 1024 });
  const entries = stdout.split("\0").filter((entry) => entry !== "");
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const path = join(clone, entries[i].slice(3));
    const info = await lstat(path).catch(() => null);
    const content = info?.isFile() ? await readFile(path) : info?.isSymbolicLink() ? await readlink(path) : null;
    lines.push(`${entries[i]}\t${content === null ? "-" : createHash("sha256").update(content).digest("hex")}`);
    // A rename or copy entry is followed by its source path.
    if (/^[RC]/u.test(entries[i])) lines.push(entries[++i] ?? "");
  }
  return lines.join("\n");
}

/** The baseline to save when a Task first uses a clone: its state before the tool call runs, or "" when the clone does not exist yet. */
export const cloneBaseline = (use: CloneUse): Promise<string> => (use.exists ? cloneState(use.path).catch((error: unknown) => `unreadable: ${error instanceof Error ? error.message : String(error)}`) : Promise.resolve(""));

/**
 * A failed PolicyCheck when a clone the Task used changed from its baseline, vanished, or cannot be read; null otherwise.
 * A clone created after the Task first used its path has a clean baseline, so any change in it fails.
 */
export async function usedCloneCheck(root: string, uses: readonly RecordedCloneUse[]): Promise<PolicyCheck | null> {
  const problems: string[] = [];
  const baselines = new Map<string, string>();
  for (const use of uses) if (use.exists) baselines.set(use.path, use.baseline);
  for (const clone of usedClones(root, uses.filter((use) => !use.exists).map((use) => use.path))) baselines.set(clone, "");
  for (const [clone, baseline] of [...baselines].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!existsSync(join(clone, ".git"))) {
      problems.push(`${clone} (deleted)`);
      continue;
    }
    // Why not skip a clone git cannot read: a broken clone would pass as untouched.
    const state = await cloneState(clone).catch(() => null);
    if (state === null) problems.push(`${clone} (git status failed)`);
    else if (state !== baseline) problems.push(clone);
  }
  if (problems.length === 0) return null;
  return {
    command_id: "policy:clone_changed",
    passed: false,
    detail: `A clone this Task used was edited, added to, deleted from or removed: ${problems.join(", ")}. Revert the changes in the clone, or clone it again (git status --porcelain must be as it was when the Task first used the clone). Write output outside the repository or in the worktree.`,
    error_key: "clone_modified",
  };
}

const FIX = "Move the clone to a clone folder outside the project and remove it from the worktree (and from the commit).";

/** A failed PolicyCheck when the worktree holds a clone or the Task committed a gitlink; null otherwise. */
export async function cloneCheck(root: string, gitlinks: readonly string[]): Promise<PolicyCheck | null> {
  const all = [...new Set([...await findNestedClones(root), ...gitlinks])].sort();
  if (all.length === 0) return null;
  return {
    command_id: "policy:clone",
    passed: false,
    detail: `A clone (a folder with its own .git) or gitlink is in the worktree: ${all.join(", ")}. ${FIX}`,
    error_key: "clone_in_worktree",
  };
}
