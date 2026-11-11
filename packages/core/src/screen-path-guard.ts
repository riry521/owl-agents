import { lstatSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { GUARD_SHELL_COMMAND_KEYS, GUARD_SHELL_TOOL_NAMES } from "@owl/shared/guard-inputs";
import { advanceWorkingDirectory, analyzeShellCommand, effectiveCommand, resolvePathCandidate, SUBSHELL_CLOSE, SUBSHELL_OPEN, UNKNOWN_CWD } from "./command-analysis.js";
import { wrapperCwd } from "./test-setup-install-guard.js";

export type ScreenPathCheck = { readonly denied: false } | { readonly denied: true; readonly path: string; readonly message: string };

/** Worker instructions match a guard denial by this prefix. */
export const SCREEN_DESIGN_REQUIRED_MESSAGE_PREFIX = "Screen design required";

export const screenDesignRequiredMessage = (path: string): string =>
  `${SCREEN_DESIGN_REQUIRED_MESSAGE_PREFIX}: creating ${path} adds a new file under the Project's screen paths, and this Task does not depend on a screen design Task. `
  + "Do not create it another way (another tool, a script, or another name under the same paths). "
  + `Stop and report result "partial" with external_blocker {kind: "screen_design", summary, evidence, suggested_fix}: quote this message and the path in evidence, and name the screens to design in suggested_fix.`;

export interface FsView {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
}

/** exists uses lstat, so a broken symlink counts as existing; isDirectory follows links, so cp into a symlinked directory is seen. */
export const nodeFsView: FsView = {
  exists: (path) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  },
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
};

/** A file the tool call would create; `from` is the source of a rename, which the caller may let through. */
export interface ScreenCreation {
  readonly path: string;
  readonly from?: string;
}

const firstString = (input: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined =>
  keys.map((key) => input[key]).find((value): value is string => typeof value === "string");

function patchTargets(patch: string): { path: string; from?: string }[] {
  const targets: { path: string; from?: string }[] = [];
  let updating: string | undefined;
  let devNull = false;
  for (const line of patch.split(/\r?\n/u)) {
    const add = /^\*\*\* Add File: (.+)$/u.exec(line);
    const update = /^\*\*\* Update File: (.+)$/u.exec(line);
    const move = /^\*\*\* Move to: (.+)$/u.exec(line);
    if (add) targets.push({ path: add[1] as string });
    if (move) targets.push(updating === undefined ? { path: move[1] as string } : { path: move[1] as string, from: updating });
    if (line.startsWith("*** ")) updating = update?.[1];
    if (line.startsWith("--- ")) devNull = line.slice(4).trim() === "/dev/null";
    else if (line.startsWith("+++ ") && devNull) {
      targets.push({ path: line.slice(4).trim().replace(/^b\//u, "") });
      devNull = false;
    }
  }
  return targets;
}

/** Destinations of cp, mv, install, ln: the last operand, or each source under -t DIR; into an existing directory the source's name is appended. */
function copyTargets(args: readonly string[], cwd: string, fs: FsView): { dest: string; src: string }[] {
  const operands: string[] = [];
  let directory: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") operands.push(...args.slice(i + 1));
    else if (arg === "-t") directory = args[(i += 1)];
    else if (arg.startsWith("--target-directory=")) directory = arg.slice("--target-directory=".length);
    else if (!arg.startsWith("-")) operands.push(arg);
    if (arg === "--") break;
  }
  const sources = directory === undefined ? operands.slice(0, -1) : operands;
  const dest = directory ?? operands.at(-1);
  if (dest === undefined || sources.length === 0) return [];
  const resolved = resolvePathCandidate(dest, cwd);
  const intoDirectory = directory !== undefined || (resolved !== null && fs.isDirectory(resolved));
  return sources.map((src) => ({ src, dest: intoDirectory ? join(dest, basename(src)) : dest }));
}

function shellTargets(command: string, cwd: string, fs: FsView): { path: string; from?: string; base: string }[] {
  // An unparseable command is RuleStore's to judge.
  const analysis = analyzeShellCommand(command);
  if (analysis === null) return [];
  const out: { path: string; from?: string; base: string }[] = [];
  const words = analysis.segments.map((seg) => seg.filter((token) => token !== SUBSHELL_OPEN && token !== SUBSHELL_CLOSE));
  // Same rule as outsideWriteTargets: a nested shell's relative paths are only placed while nothing in the command moves.
  let moved = words.slice(analysis.top_level_count).some((seg) => ["cd", "pushd", "popd"].includes(effectiveCommand(seg)?.executable ?? "") || wrapperCwd(seg, cwd) !== cwd);
  let current = cwd;
  for (const [index, seg] of words.entries()) {
    const topLevel = index < analysis.top_level_count;
    const shellCwd = topLevel ? current : moved ? UNKNOWN_CWD : cwd;
    const base = wrapperCwd(seg, shellCwd);
    seg.forEach((token, i) => {
      if ((token === ">" || token === ">>") && seg[i + 1] !== undefined) out.push({ path: seg[i + 1] as string, base: shellCwd });
    });
    const effective = effectiveCommand(seg);
    if (effective !== null) {
      const { executable, args } = effective;
      const operands = args.filter((arg) => !arg.startsWith("-"));
      if (executable === "tee" || executable === "touch") out.push(...operands.map((path) => ({ path, base })));
      else if (executable === "cp" || executable === "install" || executable === "ln") out.push(...copyTargets(args, base, fs).map(({ dest }) => ({ path: dest, base })));
      else if (executable === "mv" || (executable === "git" && args[0] === "mv")) {
        const pairs = copyTargets(executable === "mv" ? args : args.slice(1), base, fs);
        out.push(...pairs.map(({ src, dest }) => ({ path: dest, from: src, base })));
      }
    }
    if (topLevel) {
      const next = analysis.segments[index]?.includes(SUBSHELL_OPEN) ? UNKNOWN_CWD : advanceWorkingDirectory(seg, current);
      if (next !== current || wrapperCwd(seg, current) !== current) moved = true;
      current = next;
    }
  }
  return out;
}

/**
 * The absolute paths a tool call would newly create (nothing is returned for an existing path, which is an edit), before the call runs.
 * Shell commands are only read for the writes whose target the command text fixes; scripts, generators and archive extraction are left to the Reviewer.
 */
export function screenCreationTargets(toolName: string, toolInput: Readonly<Record<string, unknown>>, cwd: string, fs: FsView = nodeFsView): ScreenCreation[] {
  const name = toolName.toLowerCase();
  let candidates: { path: string; from?: string; base?: string }[] = [];
  if (name === "write" || name === "write_file") {
    const path = firstString(toolInput, ["file_path", "path", "filename"]);
    if (path !== undefined) candidates = [{ path }];
  } else if (name === "edit" || name === "multiedit") {
    const path = firstString(toolInput, ["file_path"]);
    if (path !== undefined) candidates = [{ path }];
  } else if (name === "notebookedit") {
    const path = firstString(toolInput, ["notebook_path"]);
    if (path !== undefined) candidates = [{ path }];
  } else if (name === "apply_patch") {
    const patch = firstString(toolInput, ["patch", "input", "diff", "command"]);
    if (patch !== undefined) candidates = patchTargets(patch);
  } else if (GUARD_SHELL_TOOL_NAMES.has(name)) {
    const command = firstString(toolInput, GUARD_SHELL_COMMAND_KEYS);
    if (command !== undefined) candidates = shellTargets(command, cwd, fs);
  }
  const result: ScreenCreation[] = [];
  for (const candidate of candidates) {
    const base = candidate.base ?? cwd;
    const path = resolvePathCandidate(candidate.path, base);
    if (path === null || fs.exists(path)) continue;
    const from = candidate.from === undefined ? null : resolvePathCandidate(candidate.from, base);
    result.push(from !== null && fs.exists(from) ? { path, from } : { path });
  }
  return result;
}
