import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile, watch, mkdir } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { GUARD_COMMAND_KEYS, GUARD_CONTENT_KEYS, GUARD_PATH_KEYS, isRuleRole, type ActorRole } from "@owl/shared";
import {
  analyzeShellCommand,
  advanceWorkingDirectory,
  canonicalizePath,
  effectiveCommand,
  isDynamicPath,
  isPathLike,
  normalizeExecutable,
  normalizePathCandidate,
  optionFlags,
  pathIsRootOrContainsHome,
  resolvePathCandidate,
  UNKNOWN_CWD,
} from "./command-analysis";
import { HumanReadableError } from "./errors";
import { isSecretPath } from "./project-overview-note";

class YamlSyntaxError extends Error {
  public constructor(message: string, public readonly line: number) {
    super(message);
  }
}

interface ParsedYaml {
  readonly data: Record<string, unknown>;
  /** 1-based line of each top-level key and of each list item's first line. */
  readonly keyLines: ReadonlyMap<string, number>;
  readonly itemLines: WeakMap<object, number>;
}

function parseYaml(content: string): ParsedYaml {
  const lines = content.split(/\r?\n/);
  const result: Record<string, unknown> = {};
  const keyLines = new Map<string, number>();
  const itemLines = new WeakMap<object, number>();
  let currentArray: Record<string, unknown>[] | null = null;
  let currentItem: Record<string, unknown> | null = null;
  let arrayItemIndent: number | null = null;
  let itemFieldIndent: number | null = null;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const trimmed = line.trimEnd();
    const contentLine = trimmed.trim();
    if (!contentLine || contentLine.startsWith("#")) continue;

    const topMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (topMatch && trimmed === trimmed.trimStart()) {
      if (currentItem && currentArray) currentArray.push(currentItem);
      currentItem = null;
      const key = topMatch[1];
      if (keyLines.has(key)) throw new YamlSyntaxError(`Duplicate key '${key}'`, lineNumber);
      keyLines.set(key, lineNumber);
      const val = parseYamlValue(topMatch[2], lineNumber);
      if (val !== "") {
        result[key] = val;
        currentArray = null;
      } else {
        currentArray = [];
        result[key] = currentArray;
      }
      arrayItemIndent = null;
      itemFieldIndent = null;
      continue;
    }

    const itemStart = trimmed.match(/^\s+-\s+(\w+):\s*(.*)$/);
    if (itemStart && currentArray !== null) {
      const indent = leadingWhitespaceLength(trimmed);
      if (arrayItemIndent === null) {
        arrayItemIndent = indent;
      } else if (arrayItemIndent !== indent) {
        throw new YamlSyntaxError("Unsupported YAML indentation", lineNumber);
      }
      if (currentItem) currentArray.push(currentItem);
      currentItem = { [itemStart[1]]: parseYamlValue(itemStart[2], lineNumber) };
      itemLines.set(currentItem, lineNumber);
      continue;
    }

    const fieldMatch = trimmed.match(/^\s+(\w+):\s*(.*)$/);
    if (fieldMatch && currentItem) {
      const indent = leadingWhitespaceLength(trimmed);
      if (arrayItemIndent === null || indent <= arrayItemIndent) {
        throw new YamlSyntaxError("Unsupported YAML indentation", lineNumber);
      }
      if (itemFieldIndent === null) {
        itemFieldIndent = indent;
      } else if (itemFieldIndent !== indent) {
        throw new YamlSyntaxError("Unsupported nested YAML structure", lineNumber);
      }
      if (Object.hasOwn(currentItem, fieldMatch[1])) throw new YamlSyntaxError(`Duplicate key '${fieldMatch[1]}'`, lineNumber);
      currentItem[fieldMatch[1]] = parseYamlValue(fieldMatch[2], lineNumber);
      continue;
    }

    throw new YamlSyntaxError(`Unsupported YAML construct: ${contentLine}`, lineNumber);
  }
  if (currentItem && currentArray) currentArray.push(currentItem);
  return { data: result, keyLines, itemLines };
}

function leadingWhitespaceLength(value: string): number {
  return value.match(/^\s*/)?.[0].length ?? 0;
}

function parseYamlValue(value: string, lineNumber: number): string | [] {
  const t = stripYamlComment(value).trim();
  if (t === "") return "";
  if (t === "[]") return [];
  if (
    t === "{}" || t.startsWith("[") || t.startsWith("{") || t.startsWith("&") ||
    t.startsWith("*") || t.startsWith("!") || t === "|" || t === ">"
  ) {
    throw new YamlSyntaxError(`Unsupported YAML value: ${t}`, lineNumber);
  }
  if (
    (t.startsWith('"') && !t.endsWith('"')) ||
    (t.startsWith("'") && !t.endsWith("'"))
  ) {
    throw new YamlSyntaxError("Unterminated YAML quote", lineNumber);
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function stripYamlComment(value: string): string {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === "'" || character === '"') && (index === 0 || value[index - 1] !== "\\")) {
      quote = quote === character ? null : quote ?? character;
    } else if (character === "#" && quote === null && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

/**
 * Where a rule applies. `absolute` and `system` apply to every role, `role`
 * only to the file's `role`. Levels never override each other; they order the
 * prompt lines and label a guard decision's scope. Work-specific rules live
 * only in works.rules_json (see parseWorkRules).
 */
export type RuleLevel = "absolute" | "system" | "role";
export type RuleKind = "block_command" | "block_path" | "instruction";
export type BlockPathMode = "read" | "write" | "both";
export type RuleRole = ActorRole;
export { RULE_ROLES } from "@owl/shared";

export interface RuleDefinition {
  readonly id: string;
  readonly kind: RuleKind;
  readonly pattern?: string;
  readonly mode?: BlockPathMode;
  /** block_path only: a path matching this glob is not blocked by this rule. */
  readonly except?: string;
  readonly text?: string;
  readonly message?: string;
}

export interface RuleFile {
  readonly path: string;
  readonly level: RuleLevel;
  /** Set exactly when level is "role". */
  readonly role?: RuleRole;
  readonly rules: readonly RuleDefinition[];
}

export interface CompiledBlockRule {
  readonly id: string;
  readonly level: RuleLevel;
  readonly role?: RuleRole;
  readonly pattern: string;
  readonly message: string;
}

export interface CompiledBlockPathRule {
  readonly id: string;
  readonly level: RuleLevel;
  readonly role?: RuleRole;
  readonly pattern: string;
  readonly mode: BlockPathMode;
  readonly matcher: RegExp;
  readonly exceptMatcher?: RegExp;
  readonly message: string;
}

/** One prompt line. Block rules carry their message (default text included), instructions their text. */
export interface PromptRule {
  readonly id: string;
  readonly level: RuleLevel;
  readonly role?: RuleRole;
  readonly kind: RuleKind;
  readonly text: string;
}

export interface RuleSet {
  readonly files: readonly RuleFile[];
  readonly blockRules: readonly CompiledBlockRule[];
  readonly blockPaths: readonly CompiledBlockPathRule[];
  readonly promptRules: readonly PromptRule[];
}

export interface RuleLoadFailure {
  readonly path: string;
  readonly line: number | null;
  readonly reason: string;
}

/** One rule file that cannot be used as written. */
export class RuleFileError extends Error {
  public readonly path: string;
  public readonly line: number | null;
  public readonly reason: string;

  public constructor(path: string, line: number | null, reason: string) {
    super(`${path}${line === null ? "" : `:${line}`}: ${reason}`);
    this.name = "RuleFileError";
    this.path = path;
    this.line = line;
    this.reason = reason;
  }
}

/** A load that found at least one unusable rule file; every failure is listed. */
export class RuleLoadError extends Error {
  public readonly failures: readonly RuleLoadFailure[];

  public constructor(failures: readonly RuleLoadFailure[]) {
    super(`Rule files are invalid: ${failures.map((failure) => `${failure.path}${failure.line === null ? "" : `:${failure.line}`} (${failure.reason})`).join("; ")}`);
    this.name = "RuleLoadError";
    this.failures = failures;
  }
}

export interface RuleStoreStatus {
  /** +1 per successful load (1 right after startup). */
  readonly generation: number;
  /** When the rule set in use was loaded. */
  readonly loaded_at: string | null;
  /** The last load's failures when it failed; the previous rule set stays in use. */
  readonly error: { readonly at: string; readonly failures: readonly RuleLoadFailure[] } | null;
}

export type RuleReloadResult =
  | { readonly ok: true; readonly generation: number }
  | { readonly ok: false; readonly error: RuleLoadError };

const LEVEL_PRIORITY: Record<RuleLevel, number> = {
  absolute: 0,
  system: 1,
  role: 2,
};

const RULES_SUBDIRS = ["system", "role"] as const;
const RELOAD_DEBOUNCE_MS = 250;
const UNRESOLVED_PATH_RULE_ID = "guard-unresolved-path";
const EMPTY_RULE_SET: RuleSet = { files: [], blockRules: [], blockPaths: [], promptRules: [] };

export class RuleStore {
  private readonly rulesDir: string;
  private currentRules: RuleSet = EMPTY_RULE_SET;
  private generation = 0;
  private loadedAt: string | null = null;
  private lastError: RuleStoreStatus["error"] = null;
  private watcherAbort: AbortController | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private reloadRunning = false;
  private reloadPending = false;

  public constructor(owlRoot: string) {
    this.rulesDir = join(owlRoot, "rules");
  }

  public get rules(): RuleSet {
    return this.currentRules;
  }

  public get status(): RuleStoreStatus {
    return { generation: this.generation, loaded_at: this.loadedAt, error: this.lastError };
  }

  public async ensureDirectories(): Promise<void> {
    for (const sub of RULES_SUBDIRS) {
      await mkdir(join(this.rulesDir, sub), { recursive: true });
    }
  }

  /**
   * Replaces the rule set only when every file is valid. On failure the
   * previous rule set stays in use (the guard keeps judging with it), the
   * failure is kept in `status.error`, and RuleLoadError is thrown.
   */
  public async load(): Promise<RuleSet> {
    let ruleSet: RuleSet;
    try {
      ruleSet = await this.readRuleSet();
    } catch (error) {
      const loadError = error instanceof RuleLoadError
        ? error
        : new RuleLoadError([{ path: this.rulesDir, line: null, reason: error instanceof Error ? error.message : String(error) }]);
      this.lastError = { at: new Date().toISOString(), failures: loadError.failures };
      throw loadError;
    }
    this.currentRules = ruleSet;
    this.generation += 1;
    this.loadedAt = new Date().toISOString();
    this.lastError = null;
    return ruleSet;
  }

  public checkCommand(command: string, cwd = process.cwd(), home = process.env.HOME, role?: string): { blocked: boolean; rule?: CompiledBlockRule; message?: string; unparseable?: boolean; normalizedSegments?: readonly (readonly string[])[] } {
    const analysis = analyzeShellCommand(command);
    if (analysis === null) {
      return { blocked: true, message: "The command could not be parsed safely, so execution was denied.", unparseable: true };
    }
    if (analysis.segments.some((segment) => {
      const effective = effectiveCommand(segment);
      return effective !== null && isDynamicPath(effective.executable);
    })) {
      return { blocked: true, message: "The command could not be determined because of environment variables or other indirection.", unparseable: true, normalizedSegments: analysis.segments };
    }
    const workingDirectories: string[] = [];
    let currentCwd = cwd;
    for (const segment of analysis.segments) {
      workingDirectories.push(currentCwd);
      currentCwd = advanceWorkingDirectory(segment, currentCwd, home);
    }
    for (const rule of this.currentRules.blockRules) {
      if (rule.role && rule.role !== role) continue;
      if (analysis.segments.some((segment, index) => commandPatternMatches(rule.pattern, segment, workingDirectories[index] ?? cwd, home))) {
        return { blocked: true, rule, message: rule.message, normalizedSegments: analysis.segments };
      }
    }
    // Root/home deletion commands with computed path arguments cannot be
    // proven safe statically. Refuse these high-impact operations.
    for (const [index, segment] of analysis.segments.entries()) {
      const effective = effectiveCommand(segment);
      if (!effective || effective.executable !== "rm") continue;
      const flags = effective.args.flatMap((arg) => [...optionFlags(arg)]);
      if (!flags.includes("-r") || !flags.includes("-f")) continue;
      if ((workingDirectories[index] ?? cwd) === UNKNOWN_CWD || effective.args.some((arg) => isDynamicPath(arg))) {
        const rule = this.currentRules.blockRules.find((candidate) => candidate.id === "block-rm-root-home");
        return { blocked: true, rule, message: rule?.message ?? "The deletion target could not be parsed safely.", normalizedSegments: analysis.segments };
      }
    }
    return { blocked: false, normalizedSegments: analysis.segments };
  }

  public checkPath(path: string, mode: "read" | "write", cwd = process.cwd(), role?: string, home = process.env.HOME): { blocked: boolean; rule?: CompiledBlockPathRule } {
    const lexicalPath = resolvePathCandidate(path, cwd, home);
    if (lexicalPath === null) {
      return { blocked: true, rule: unresolvedPathRule("The path could not be parsed safely.") };
    }
    const normalized = normalizePathCandidate(path, cwd, home) ?? lexicalPath;
    for (const rule of this.currentRules.blockPaths) {
      if (rule.role && rule.role !== role) continue;
      if (rule.mode !== mode && rule.mode !== "both") continue;
      // Each candidate is judged alone: a symlink named like an exempt template
      // must not exempt the secret it resolves to.
      const denied = [lexicalPath, normalized].some((candidate) => rule.matcher.test(candidate) && !rule.exceptMatcher?.test(candidate));
      if (!denied) continue;
      return { blocked: true, rule };
    }
    return { blocked: false };
  }

  public checkGuard(input: {
    readonly role: string;
    readonly toolName: string;
    readonly toolInput: unknown;
    readonly cwd: string;
    readonly home?: string;
    /** Present only for a Designer guard token; null denies all writes. */
    readonly designerWritePath?: string | null;
  }): {
    readonly allowed: boolean;
    readonly rule_id: string | null;
    readonly scope: RuleLevel | null;
    readonly message: string;
    readonly normalized_segments?: readonly (readonly string[])[];
  } {
    const { role, toolName, toolInput, cwd, home = process.env.HOME } = input;
    const designerWriteScope = role === "designer" && Object.hasOwn(input, "designerWritePath");
    const designerWritePath = input.designerWritePath ?? null;
    const designerWriteAllowed = (path: string, pathCwd = cwd): boolean => {
      if (!designerWriteScope || designerWritePath === null) return !designerWriteScope;
      const candidate = resolvePathCandidate(path, pathCwd, home);
      return candidate !== null && candidate === resolve(designerWritePath);
    };
    const denyDesignerWrite = () => ({
      allowed: false,
      rule_id: "designer-write-path",
      scope: "role" as const,
      message: "Designer can write only its assigned external design document.",
    });
    const tool = toolName.toLowerCase();
    const record = isRecord(toolInput) ? toolInput : {};
    const deny = (message: string, rule?: CompiledBlockRule | CompiledBlockPathRule, normalizedSegments?: readonly (readonly string[])[]) => ({
      allowed: false,
      rule_id: rule?.id ?? null,
      scope: rule?.level ?? null,
      message: rule?.message ?? message,
      ...(normalizedSegments ? { normalized_segments: normalizedSegments } : {}),
    });
    const allow = (normalizedSegments?: readonly (readonly string[])[]) => ({
      allowed: true,
      rule_id: null,
      scope: null,
      message: "",
      ...(normalizedSegments ? { normalized_segments: normalizedSegments } : {}),
    });

    if (role === "librarian") {
      const reason = readOnlyDenial(tool, record, cwd, home);
      if (reason !== null) return deny(reason);
    }

    if (["read", "read_file", "open"].includes(tool)) {
      const path = firstString(record, ["file_path", "path", "filename"]);
      if (!path) return deny("The Read tool path could not be determined.");
      const result = this.checkPath(path, "read", cwd, role, home);
      return result.blocked ? deny("This path matches a rule that denies reading.", result.rule) : allow();
    }

    if (["glob", "grep", "search", "ripgrep"].includes(tool)) {
      const paths = stringsFrom(record, ["path", "paths", "file_path"]);
      const patterns = tool === "glob"
        ? stringsFrom(record, ["pattern", "glob", "glob_pattern"])
        : stringsFrom(record, ["include", "glob"]);
      const candidates = [...paths, ...patterns].filter((value) => value.length > 0);
      for (const path of candidates) {
        const result = this.checkPath(path, "read", cwd, role, home);
        if (result.blocked) return deny("This path matches a rule that denies reading.", result.rule);
      }
      return allow();
    }

    if (["edit", "write", "multiedit", "notebookedit", "write_file", "apply_patch"].includes(tool)) {
      const paths = extractWritePaths(tool, record);
      if (paths === null || paths.length === 0) return deny("The Write tool target path could not be determined.");
      if (designerWriteScope && paths.some((path) => !designerWriteAllowed(path))) return denyDesignerWrite();
      for (const path of paths) {
        const result = this.checkPath(path, "write", cwd, role, home);
        if (result.blocked) return deny("This path matches a rule that denies writing.", result.rule);
      }
      return allow();
    }

    if (["bash", "shell", "terminal", "exec", "command"].includes(tool)) {
      const command = firstString(record, ["command", "cmd", "script"]);
      if (command === null) return deny("The Bash command could not be determined.");
      if (designerWriteScope && hasDesignerGitMutation(command)) return denyDesignerWrite();
      const commandResult = this.checkCommand(command, cwd, home, role);
      if (commandResult.blocked) return deny(commandResult.message ?? "This command matches a blocking rule.", commandResult.rule, commandResult.normalizedSegments);
      const analysis = analyzeShellCommand(command);
      if (analysis === null) return deny("The command could not be parsed safely, so execution was denied.");
      const fileDecision = this.checkCommandPaths(analysis.segments, cwd, role, home, designerWriteScope ? designerWritePath : undefined);
      if (fileDecision) {
        if (fileDecision.message) return deny(fileDecision.message, fileDecision.rule, analysis.segments);
        return deny(fileDecision.rule.message, fileDecision.rule, analysis.segments);
      }
      return allow(analysis.segments);
    }

    return this.checkOtherTool(tool, record, cwd, role, home, designerWriteScope, designerWritePath);
  }

  /**
   * Any other tool, including MCP tools (`mcp__<server>__<tool>`) and web
   * tools: its path-like and command-like arguments are checked against the
   * block rules, and it is denied only when one of them matches a rule. A
   * tool without such arguments, or one whose arguments cannot be analysed,
   * is allowed; the fail-closed handling above stays with the built-in file
   * and shell tools.
   */
  private checkOtherTool(
    tool: string,
    record: Record<string, unknown>,
    cwd: string,
    role: string,
    home: string | undefined,
    designerWriteScope = false,
    designerWritePath: string | null = null,
  ): GuardDecision {
    const baseTool = tool.startsWith("mcp__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool;
    const mode = WRITE_TOOL_NAME.test(baseTool) || GUARD_CONTENT_KEYS.some((key) => key in record) ? "write" : "read";
    for (const path of stringsFrom(record, GUARD_PATH_KEYS)) {
      if (path.length === 0) continue;
      if (mode === "write" && designerWriteScope) {
        const candidate = resolvePathCandidate(path, cwd, home);
        if (designerWritePath === null || candidate === null || candidate !== resolve(designerWritePath)) {
          return guardDeny("Designer can write only its assigned external design document.", {
            id: "designer-write-path", level: "role", role: "designer", pattern: designerWritePath ?? "", mode: "write", matcher: /$^/u,
            message: "Designer can write only its assigned external design document.",
          });
        }
      }
      const result = this.checkPath(path, mode, cwd, role, home);
      if (result.blocked && result.rule && result.rule.id !== UNRESOLVED_PATH_RULE_ID) {
        return guardDeny(mode === "write" ? "This path matches a rule that denies writing." : "This path matches a rule that denies reading.", result.rule);
      }
    }
    for (const command of stringsFrom(record, GUARD_COMMAND_KEYS)) {
      const analysis = analyzeShellCommand(command);
      if (analysis === null) continue;
      const commandResult = this.checkCommand(command, cwd, home, role);
      if (commandResult.blocked && commandResult.rule) {
        return guardDeny(commandResult.message ?? "This command matches a blocking rule.", commandResult.rule, analysis.segments);
      }
      const fileDecision = this.checkCommandPaths(analysis.segments, cwd, role, home);
      if (fileDecision && fileDecision.rule.id !== UNRESOLVED_PATH_RULE_ID) {
        return guardDeny(fileDecision.rule.message, fileDecision.rule, analysis.segments);
      }
    }
    return GUARD_ALLOW;
  }

  /**
   * The prompt lines for `role`: one line per rule as `[level] text`, in
   * absolute → system → role order (file path, then written order), then the
   * Work's rules as `[work] text`. A line identical to an earlier one is
   * emitted once; guard enforcement is unaffected.
   */
  public getInstructionsForRole(role: RuleRole, workRules: readonly string[] = []): string[] {
    const seen = new Set<string>();
    const lines: string[] = [];
    const push = (line: string) => {
      if (seen.has(line)) return;
      seen.add(line);
      lines.push(line);
    };
    for (const rule of this.currentRules.promptRules) {
      if (rule.level === "role" && rule.role !== role) continue;
      push(`[${rule.level}] ${rule.text}`);
    }
    for (const rule of workRules) push(`[work] ${rule}`);
    return lines;
  }

  private checkCommandPaths(
    segments: readonly (readonly string[])[],
    cwd: string,
    role: string,
    home: string | undefined,
    designerWritePath?: string | null,
  ): { rule: CompiledBlockPathRule; message?: string } | null {
    let currentCwd = cwd;
    for (const tokens of segments) {
      const effective = effectiveCommand(tokens);
      if (!effective) {
        currentCwd = advanceWorkingDirectory(tokens, currentCwd, home);
        continue;
      }
      const { executable, args } = effective;
      const writePaths = commandWritePaths(executable, args, tokens);
      const readPaths = commandReadPaths(executable, args);
      for (const path of writePaths) {
        if (designerWritePath !== undefined) {
          const candidate = resolvePathCandidate(path, currentCwd, home);
          if (designerWritePath === null || candidate === null || candidate !== resolve(designerWritePath)) {
            return {
              rule: {
                id: "designer-write-path", level: "role", role: "designer", pattern: designerWritePath ?? "", mode: "write", matcher: /$^/u,
                message: "Designer can write only its assigned external design document.",
              },
            };
          }
        }
        const result = this.checkPath(path, "write", currentCwd, role, home);
        if (result.blocked && result.rule?.id === UNRESOLVED_PATH_RULE_ID) return { rule: unresolvedPathRule("The write target path could not be parsed safely.") };
        if (result.blocked && result.rule) return { rule: result.rule };
      }
      for (const path of readPaths) {
        const result = this.checkPath(path, "read", currentCwd, role, home);
        if (result.blocked && result.rule?.id === UNRESOLVED_PATH_RULE_ID) return { rule: unresolvedPathRule("The read target path could not be parsed safely.") };
        if (result.blocked && result.rule) return { rule: result.rule };
      }
      currentCwd = advanceWorkingDirectory(tokens, currentCwd, home);
    }
    return null;
  }

  /**
   * Reloads after file changes: events are debounced and loads never overlap
   * (a change during a load triggers one more). Every load result reaches
   * `onChange`; a throwing handler is logged and the watcher keeps running.
   */
  public async startWatching(onChange: (result: RuleReloadResult) => Promise<void> | void): Promise<void> {
    if (this.watcherAbort) return;
    const abort = new AbortController();
    let watcher: ReturnType<typeof watch>;
    try {
      watcher = watch(this.rulesDir, { recursive: true, signal: abort.signal });
    } catch (error) {
      console.warn("[owl-core] fs.watch is not available; rule hot reload is disabled.", error);
      return;
    }
    this.watcherAbort = abort;
    const deliver = async (result: RuleReloadResult): Promise<void> => {
      try {
        await onChange(result);
      } catch (error) {
        console.error("[owl-core] Rule reload handler failed", error);
      }
    };
    const reload = async (): Promise<void> => {
      if (this.reloadRunning) {
        this.reloadPending = true;
        return;
      }
      this.reloadRunning = true;
      try {
        do {
          this.reloadPending = false;
          let result: RuleReloadResult;
          try {
            await this.load();
            result = { ok: true, generation: this.generation };
          } catch (error) {
            result = { ok: false, error: error as RuleLoadError };
          }
          if (abort.signal.aborted) return;
          await deliver(result);
        } while (this.reloadPending && !abort.signal.aborted);
      } finally {
        this.reloadRunning = false;
      }
    };
    void (async () => {
      try {
        for await (const _event of watcher) {
          if (this.reloadTimer !== null) clearTimeout(this.reloadTimer);
          this.reloadTimer = setTimeout(() => {
            this.reloadTimer = null;
            void reload();
          }, RELOAD_DEBOUNCE_MS);
          this.reloadTimer.unref?.();
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        // The watcher itself died: later file changes are not seen until Owl
        // restarts, so tell the Owner once.
        console.error("[owl-core] Rule file watcher failed", error);
        await deliver({ ok: false, error: new RuleLoadError([{ path: this.rulesDir, line: null, reason: `watcher failed: ${error instanceof Error ? error.message : String(error)}` }]) });
      }
    })();
  }

  public stopWatching(): void {
    if (this.watcherAbort) {
      this.watcherAbort.abort();
      this.watcherAbort = null;
    }
    if (this.reloadTimer !== null) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  /**
   * Reads, validates and compiles every rule file. Any invalid file fails the
   * whole load with every failure listed; nothing is partially applied.
   */
  private async readRuleSet(): Promise<RuleSet> {
    const paths: string[] = [];
    await this.walkYaml(this.rulesDir, paths);
    const failures: RuleLoadFailure[] = [];
    const compiled: { file: RuleFile; rules: CompiledRuleFile }[] = [];
    for (const path of paths.sort()) {
      let content: string;
      try {
        content = await readFile(path, "utf8");
      } catch (error) {
        if (isNodeErrorWithCode(error, "ENOENT")) continue;
        failures.push({ path, line: null, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      try {
        const file = parseRuleYaml(content, path);
        compiled.push({ file, rules: compileRuleFile(file) });
      } catch (error) {
        if (!(error instanceof RuleFileError)) throw error;
        failures.push({ path: error.path, line: error.line, reason: error.reason });
      }
    }
    const idOwners = new Map<string, string>();
    for (const { file } of compiled) {
      for (const rule of file.rules) {
        const owner = idOwners.get(rule.id);
        if (owner !== undefined) {
          failures.push({ path: file.path, line: null, reason: `duplicate rule id '${rule.id}' (also in ${owner})` });
        } else {
          idOwners.set(rule.id, file.path);
        }
      }
    }
    if (failures.length > 0) throw new RuleLoadError(failures);
    // Stable: level, then path (already sorted), then written order.
    compiled.sort((a, b) => LEVEL_PRIORITY[a.file.level] - LEVEL_PRIORITY[b.file.level]);
    return {
      files: compiled.map((entry) => entry.file),
      blockRules: compiled.flatMap((entry) => entry.rules.blockRules),
      blockPaths: compiled.flatMap((entry) => entry.rules.blockPaths),
      promptRules: compiled.flatMap((entry) => entry.rules.promptRules),
    };
  }

  private async walkYaml(dir: string, out: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      // A missing rules/ directory (or one removed mid-walk) holds no rules.
      if (isNodeErrorWithCode(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walkYaml(full, out);
      } else if (entry.isFile() && (extname(entry.name) === ".yaml" || extname(entry.name) === ".yml")) {
        out.push(full);
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    if (typeof record[name] === "string") return record[name] as string;
  }
  return null;
}

export const WRITE_TOOL_NAME = /write|edit|create|delete|remove|move|rename|insert|replace|patch|save|mkdir|touch|append|modify|update|put|copy|rm|unlink|chmod|truncate/iu;

interface GuardDecision {
  readonly allowed: boolean;
  readonly rule_id: string | null;
  readonly scope: RuleLevel | null;
  readonly message: string;
  readonly normalized_segments?: readonly (readonly string[])[];
}

const GUARD_ALLOW: GuardDecision = { allowed: true, rule_id: null, scope: null, message: "" };

function guardDeny(message: string, rule: CompiledBlockRule | CompiledBlockPathRule, normalizedSegments?: readonly (readonly string[])[]): GuardDecision {
  return {
    allowed: false,
    rule_id: rule.id,
    scope: rule.level,
    message: rule.message ?? message,
    ...(normalizedSegments ? { normalized_segments: normalizedSegments } : {}),
  };
}

function stringsFrom(record: Record<string, unknown>, names: readonly string[]): string[] {
  const result: string[] = [];
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string") result.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") result.push(item);
    }
  }
  return result;
}

const READ_ONLY_READ_TOOLS = new Set(["read", "read_file", "open", "glob", "grep", "search", "ripgrep"]);
const READ_ONLY_SHELL_TOOLS = new Set(["bash", "shell", "terminal", "exec", "command"]);
const READ_ONLY_EXECUTABLES = new Set(["cat", "head", "tail", "wc", "ls", "git", "pwd"]);
// Quote-blind on purpose: any shell expansion or control character anywhere in the command is refused.
const SHELL_METACHARACTERS = /[*?[\]{}$`~;|&<>()\r\n]/u;

/** Extra restrictions for the read-only investigation role; null means nothing extra to deny. */
function readOnlyDenial(tool: string, record: Record<string, unknown>, cwd: string, home: string | undefined): string | null {
  const secret = (path: string): boolean => {
    const resolved = resolvePathCandidate(path, cwd, home);
    return isSecretPath(path) || (resolved !== null && isSecretPath(resolved));
  };
  // Also checks the real path: secret, outside cwd, unresolvable or hard-linked targets are unsafe.
  const rootReal = canonicalizePath(cwd);
  const unsafe = (path: string): boolean => {
    if (secret(path)) return true;
    const absolute = resolvePathCandidate(path, cwd, home);
    if (absolute === null) return true;
    const real = canonicalizePath(absolute);
    if (isSecretPath(real) || (real !== rootReal && !real.startsWith(`${rootReal}/`))) return true;
    let stat;
    try { stat = lstatSync(absolute); } catch { return false; }
    if (stat.isSymbolicLink()) { try { realpathSync(absolute); } catch { return true; } }
    if (stat.isFile() && stat.nlink > 1) return true;
    try { const target = statSync(absolute); return target.isFile() && target.nlink > 1; } catch { return false; }
  };
  if (READ_ONLY_READ_TOOLS.has(tool)) {
    if (tool === "glob") return null; // Only lists file names, never contents.
    for (const key of ["file_path", "path", "filename"]) {
      const value = record[key];
      if (typeof value === "string") { try { if (statSync(resolve(cwd, value)).isDirectory()) return "The read-only investigation cannot read a directory."; } catch { /* missing path: keep the secret check below */ } }
    }
    // A directory search cannot exclude secrets, so only single files may be searched.
    if (/^(?:grep|search|ripgrep)$/u.test(tool)) {
      const target = firstString(record, ["path"]);
      let isDirectory = true;
      try { isDirectory = target === null || statSync(resolve(cwd, target)).isDirectory(); } catch { isDirectory = true; }
      if (isDirectory) return "The read-only investigation cannot search a whole directory with the search tool; grep a single file instead.";
    }
    return stringsFrom(record, ["file_path", "path", "paths", "filename"]).some(unsafe) || stringsFrom(record, ["include", "glob", "glob_pattern", "pattern"]).some(secret)
      ? "The read-only investigation cannot read secret files." : null;
  }
  if (!READ_ONLY_SHELL_TOOLS.has(tool)) return "The read-only investigation can use only read tools and read-only shell commands.";
  const command = firstString(record, ["command", "cmd", "script"]);
  const analysis = command === null ? null : analyzeShellCommand(command);
  if (command === null || analysis === null) return "The command could not be parsed safely, so execution was denied.";
  const soleCommand = analysis.segments.length === 1 ? effectiveCommand(analysis.segments[0] ?? []) : null;
  const gitAncestryRefs = soleCommand?.executable === "git" && ["log", "show", "diff", "whatchanged", "stash"].includes(soleCommand.args[0] ?? "")
    ? soleCommand.args.slice(1, soleCommand.args.indexOf("--") < 0 ? undefined : soleCommand.args.indexOf("--")).filter((arg) => /^HEAD~\d+$/u.test(arg))
    : [];
  const bareAncestryRefs = [...command.matchAll(/(?:^|\s)(HEAD~\d+)(?=\s|$)/gu)];
  const shellCheckCommand = bareAncestryRefs.length === gitAncestryRefs.length
    ? command.replace(/(?:^|\s)(HEAD~\d+)(?=\s|$)/gu, (match) => match.replace("~", ""))
    : command;
  if (SHELL_METACHARACTERS.test(shellCheckCommand)) return "The read-only investigation cannot use shell expansion, pipes, redirects or command chaining.";
  const denied = "The read-only investigation cannot run this command.";
  // An existing, non-secret, in-tree path; cat/head/tail/wc need a regular file, ls may take a directory.
  const safePath = (path: string, directoryOk: boolean): boolean => {
    if (path === "" || unsafe(path)) return false;
    try { const target = statSync(resolve(cwd, path)); return target.isFile() || (directoryOk && target.isDirectory()); } catch { return false; }
  };
  for (const tokens of analysis.segments) {
    const effective = effectiveCommand(tokens);
    if (!effective) continue;
    const { executable, args } = effective;
    // No env assignments or wrappers: the executable must be the first token as typed.
    if (!READ_ONLY_EXECUTABLES.has(executable) || tokens.length !== args.length + 1 || tokens[0] !== executable) return denied;
    if (executable === "pwd") { if (args.length > 0) return denied; continue; }
    if (executable !== "git") {
      const paths: string[] = [];
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (!arg.startsWith("-")) { paths.push(arg); continue; }
        const allowed = executable === "wc" ? /^-[lcwm]$/u.test(arg)
          : executable === "ls" ? /^-[la1hR]+$/u.test(arg)
            : (executable === "head" || executable === "tail") && (/^-\d+$/u.test(arg) || (arg === "-n" && /^\d+$/u.test(args[index + 1] ?? "") && ++index > 0));
        if (!allowed) return denied;
      }
      if (executable !== "ls" && paths.length === 0) return denied;
      if (!paths.every((path) => safePath(path, executable === "ls"))) return "The read-only investigation cannot read secret files.";
      continue;
    }
    const subcommand = args[0] !== undefined && !args[0].startsWith("-") ? args[0] : undefined;
    const dashDash = args.indexOf("--");
    const gitOptions = dashDash < 0 ? args : args.slice(0, dashDash);
    const gitPaths = dashDash < 0 ? [] : args.slice(dashDash + 1);
    const operands: string[] = [];
    for (let index = 1; index < gitOptions.length; index += 1) {
      const arg = gitOptions[index]!;
      if (arg === "-n") { index += 1; continue; }
      if (!arg.startsWith("-")) operands.push(arg);
    }
    if (subcommand === "stash" && operands[0] === "list") operands.shift();
    else if (subcommand === "stash" && operands[0] === "show") operands.shift();
    const revisionAtom = (value: string): boolean => /^(?:HEAD|HEAD~\d+|HEAD\^|[A-Za-z0-9][A-Za-z0-9._/-]*)$/u.test(value)
      && !value.includes("..") && !value.includes("//") && !value.includes("@{")
      && value.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"));
    const revisionSpec = (value: string): boolean => {
      if (revisionAtom(value)) return true;
      const range = value.split("..");
      return range.length === 2 && range.every(revisionAtom);
    };
    const safeGitPath = (path: string, directoryOk = false): boolean => !path.startsWith("/")
      && !path.includes("..") && !path.includes(":") && !path.includes("\\") && !path.startsWith("-")
      && safePath(path, directoryOk);
    const existsAsPath = (value: string): boolean => { try { statSync(resolve(cwd, value)); return true; } catch { return false; } };
    const gitRefs: string[] = [];
    const blobRefs: string[] = [];
    const positionalPaths: string[] = [];
    for (const operand of operands) {
      if (subcommand === "ls-files" || subcommand === "status") { positionalPaths.push(operand); continue; }
      if (operand.includes(":")) {
        const colon = operand.indexOf(":");
        const revision = operand.slice(0, colon);
        const path = operand.slice(colon + 1);
        if (operand.indexOf(":", colon + 1) >= 0 || !revisionSpec(revision) || !safeGitPath(path)) return "The read-only investigation cannot read secret files.";
        blobRefs.push(operand);
      } else if (revisionSpec(operand)) {
        if (existsAsPath(operand)) return "The read-only investigation cannot run this command.";
        gitRefs.push(operand);
      } else {
        positionalPaths.push(operand);
      }
    }
    const summaryOnly = blobRefs.length === 0 && gitOptions.some((arg) => /^--(?:stat|name-only|name-status|numstat|shortstat|summary)(?:=|$)/u.test(arg));
    const showsContent = subcommand !== undefined && (["show", "diff", "whatchanged", "stash"].includes(subcommand)
      || (subcommand === "status" && args.some((arg) => arg === "-v" || arg === "-vv" || arg === "--verbose"))) && !summaryOnly;
    // A committed symlink (mode 120000) may point at a secret even when the working-tree file is regular,
    // so every <rev>:<path> argument is checked against its mode in the commit, whatever else is present.
    const committedRegular = (arg: string): boolean => {
      try { return /^100(?:644|755) blob /u.test(execFileSync("git", ["ls-tree", arg.slice(0, arg.indexOf(":")), "--", arg.slice(arg.indexOf(":") + 1)], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { return false; }
    };
    const blobsOk = blobRefs.every((arg) => !arg.endsWith(":") && !arg.endsWith("/") && committedRegular(arg) && safeGitPath(arg.slice(arg.indexOf(":") + 1)));
    const pathsOk = [...gitPaths, ...positionalPaths].every((path) => safeGitPath(path, subcommand === "ls-files" || subcommand === "status"));
    if (!blobsOk || !pathsOk) return "The read-only investigation cannot read secret files.";
    const showRefsAreSafe = subcommand !== "show" || summaryOnly || (gitRefs.length === 0 && blobRefs.length > 0);
    const contentTargetsOk = showRefsAreSafe && (gitPaths.length > 0 || positionalPaths.length > 0 || blobRefs.length > 0);
    const notReadOnly = subcommand === undefined || tokens.some((arg) => /^GIT_\w*=/u.test(arg)) || !gitOptionsAllowed(subcommand, args) || !isReadOnlyGitInvocation(args) || subcommand === "help" || subcommand === "config" || subcommand === "blame" || subcommand === "cat-file" || subcommand === "ls-remote" || subcommand === "remote"
      || (showsContent && args.includes("--full-diff"))
      || (showsContent && !(gitOptions.includes("--no-ext-diff") && gitOptions.includes("--no-textconv") && contentTargetsOk))
      || operands.includes("grep")
      || tokens.some((arg) => /^(?:-c|--config-env|--exec-path|--output|--ext-diff|--textconv|--open-files-in-pager|-O)/u.test(arg));
    if (notReadOnly || commandWritePaths(executable, args, tokens).length > 0) return denied;
    const candidates = args.flatMap((arg) => {
      const value = arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1) : arg;
      return [value, value.slice(value.indexOf(":") + 1)];
    });
    if (candidates.some(secret) || commandReadPaths(executable, args).some(secret)) return "The read-only investigation cannot read secret files.";
  }
  return null;
}

function extractWritePaths(tool: string, input: Record<string, unknown>): string[] | null {
  if (tool === "apply_patch") {
    const patch = firstString(input, ["patch", "input", "diff", "command"]);
    if (patch === null) return null;
    const paths: string[] = [];
    const lines = patch.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/u);
      if (match?.[1]) paths.push(match[1].trim());
      const addedOrUpdated = line.match(/^\+\+\+ b\/(.+)$/u);
      if (addedOrUpdated?.[1] && addedOrUpdated[1] !== "/dev/null") paths.push(addedOrUpdated[1]);
      if (/^--- a\//u.test(line) && lines[index + 1]?.trim() === "+++ /dev/null") {
        paths.push(line.replace(/^--- a\//u, ""));
      }
    }
    return paths.length > 0 ? [...new Set(paths)] : null;
  }
  const path = firstString(input, ["file_path", "path", "filename", "notebook_path"]);
  return path === null ? null : [path];
}

const GIT_COMMON_OPTIONS = new Set(["--oneline", "--stat", "--name-only", "--name-status", "--numstat", "--shortstat", "--no-merges", "--decorate", "--graph", "--all", "--reverse", "--follow", "--no-ext-diff", "--no-textconv"]);
const GIT_OPTION_PREFIXES = ["--format=", "--pretty=", "--max-count=", "--since=", "--until=", "--author="];
const GIT_LS_FILES_OPTIONS = new Set(["-c", "--cached", "-o", "--others", "-d", "--deleted", "-m", "--modified", "-s", "--stage", "--exclude-standard", "--full-name", "-z"]);
const GIT_STATUS_OPTIONS = new Set(["-s", "--short", "--porcelain", "--porcelain=v1", "--porcelain=v2", "-b", "--branch"]);

/** Allowlist: every option of these git subcommands must be listed, otherwise the command is refused. */
function gitOptionsAllowed(subcommand: string, args: readonly string[]): boolean {
  if (!["log", "show", "diff", "whatchanged", "stash", "ls-files", "status"].includes(subcommand)) return false;
  const end = args.indexOf("--");
  const options = args.slice(1, end < 0 ? undefined : end);
  for (let index = 0; index < options.length; index += 1) {
    const arg = options[index]!;
    if (subcommand === "status") {
      if (!arg.startsWith("-") || !GIT_STATUS_OPTIONS.has(arg)) return false;
      continue;
    }
    if (!arg.startsWith("-")) continue;
    if (subcommand === "ls-files") {
      if (GIT_LS_FILES_OPTIONS.has(arg)) continue;
      return false;
    }
    if ((GIT_COMMON_OPTIONS.has(arg) && !(subcommand === "log" && /^--no-(?:ext-diff|textconv)$/u.test(arg))) || GIT_OPTION_PREFIXES.some((prefix) => arg.startsWith(prefix)) || /^-n?\d+$/u.test(arg)) continue;
    if (arg === "-n" && /^\d+$/u.test(options[index + 1] ?? "")) { index += 1; continue; }
    return false;
  }
  return true;
}

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env", "--list-cmds", "--attr-source"]);
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "blame", "cat-file", "describe", "diff", "grep", "help", "log", "ls-files", "ls-remote", "ls-tree",
  "merge-base", "rev-list", "rev-parse", "shortlog", "show", "show-ref", "status", "version", "whatchanged",
]);
const GIT_BRANCH_LIST_FLAGS = new Set(["-a", "--all", "-r", "--remotes", "-l", "--list", "-v", "-vv", "--verbose", "--show-current", "--no-color", "--color", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--column", "--no-column", "-i", "--ignore-case"]);

/** True unless every git invocation in the command is a known read-only form. */
function hasDesignerGitMutation(command: string): boolean {
  const analysis = analyzeShellCommand(command);
  if (analysis === null) return false;
  return analysis.segments.some((segment) => {
    const effective = effectiveCommand(segment);
    if (!effective || effective.executable !== "git") return false;
    return !isReadOnlyGitInvocation(effective.args);
  });
}

function isReadOnlyGitInvocation(args: readonly string[]): boolean {
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) break;
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(name) && !arg.includes("=")) index += 2;
    else index += 1;
  }
  const subcommand = args[index];
  if (subcommand === undefined) return true;
  const rest = args.slice(index + 1);
  if (rest.some((arg) => arg === "--output" || arg.startsWith("--output="))) return false;
  if (GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) return true;
  switch (subcommand) {
    case "branch":
      return rest.every((arg) => GIT_BRANCH_LIST_FLAGS.has(arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg))
        || (rest.some((arg) => arg === "-l" || arg === "--list") && rest.every((arg) => !arg.startsWith("-") || GIT_BRANCH_LIST_FLAGS.has(arg)));
    case "stash":
      return rest[0] === "list" || rest[0] === "show";
    case "worktree":
      return rest[0] === "list";
    case "tag":
      return rest.length === 0 || rest[0] === "-l" || rest[0] === "--list";
    case "remote":
      return rest.every((arg) => arg === "-v" || arg === "--verbose");
    case "config":
      return rest.some((arg) => arg === "--get" || arg === "--get-all" || arg === "--get-regexp" || arg === "--list" || arg === "-l");
    default:
      return false;
  }
}

function positionalArguments(args: readonly string[]): string[] {
  const result: string[] = [];
  let afterTerminator = false;
  for (const arg of args) {
    if (arg === "--") {
      afterTerminator = true;
      continue;
    }
    if (!afterTerminator && arg.startsWith("-")) continue;
    result.push(arg);
  }
  return result;
}

function commandWritePaths(executable: string, args: readonly string[], rawTokens: readonly string[]): string[] {
  const result: string[] = [];
  const positional = positionalArguments(args);
  if (["rm", "rmdir", "unlink", "mkdir", "touch", "truncate", "chmod", "chown", "install", "mv", "cp", "ln"].includes(executable)) {
    result.push(...positional);
  } else if (executable === "tee") {
    result.push(...positional);
  } else if (executable === "dd") {
    for (const arg of args) if (arg.startsWith("of=")) result.push(arg.slice(3));
  } else if (executable === "sqlite3") {
    if (!args.includes("-readonly") && !args.includes("--readonly")) {
      const database = args.find((arg) => !arg.startsWith("-") && arg.length > 0);
      if (database) result.push(database);
    }
  } else if (executable === "git") {
    const positional = positionalArguments(args);
    const subcommand = positional[0];
    if (["rm", "mv", "restore", "checkout", "clean"].includes(subcommand ?? "")) {
      result.push(...positional.slice(1));
    }
  } else if (executable === "sed" && args.some((arg) => arg === "-i" || arg.startsWith("-i" ) || arg === "--in-place")) {
    const nonOptions = positionalArguments(args);
    result.push(...nonOptions.slice(1));
  } else if (["curl"].includes(executable)) {
    const outputIndex = args.findIndex((arg) => arg === "-o" || arg === "--output");
    if (outputIndex >= 0 && args[outputIndex + 1]) result.push(args[outputIndex + 1] as string);
  } else if (executable === "wget") {
    const outputIndex = args.findIndex((arg) => arg === "-O" || arg === "--output-document");
    if (outputIndex >= 0 && args[outputIndex + 1]) result.push(args[outputIndex + 1] as string);
  }
  if (["python", "python2", "python3", "node", "ruby", "perl"].includes(executable)) {
    const code = scriptArgument(args);
    if (code !== null) result.push(...extractScriptPaths(code, "write"));
  }
  for (let index = 0; index < rawTokens.length - 1; index += 1) {
    const operator = rawTokens[index];
    if (operator === ">" || operator === ">>") {
      const destination = rawTokens[index + 1];
      if (destination) result.push(destination);
    }
  }
  return result.filter((path) => path.length > 0 && path !== "-" && path !== "/dev/null");
}

function commandReadPaths(executable: string, args: readonly string[]): string[] {
  if (["cat", "less", "more", "head", "tail", "source", ".", "grep", "rg", "awk", "sed", "cp", "mv"].includes(executable)) {
    const positional = positionalArguments(args);
    if (["grep", "rg"].includes(executable)) return positional.slice(1);
    if (["sed", "awk"].includes(executable)) return positional.slice(1);
    if (["cp", "mv"].includes(executable)) return positional.slice(0, -1);
    return positional;
  }
  if (executable === "sqlite3" && (args.includes("-readonly") || args.includes("--readonly"))) {
    const database = args.find((arg) => !arg.startsWith("-") && arg.length > 0);
    return database ? [database] : [];
  }
  if (["python", "python2", "python3", "node", "ruby", "perl"].includes(executable)) {
    const code = scriptArgument(args);
    if (code !== null) return extractScriptPaths(code, "read");
  }
  return [];
}

function scriptArgument(args: readonly string[]): string | null {
  const flag = args.findIndex((arg) => arg === "-c" || arg === "-e" || arg === "--eval");
  return flag >= 0 ? args[flag + 1] ?? null : null;
}

function extractScriptPaths(code: string, mode: "read" | "write"): string[] {
  const result: string[] = [];
  const escaped = "(['\"])([^'\"]+)\\1";
  const expressions = mode === "read"
    ? [new RegExp(`(?:open|readFileSync?|read_text|read_bytes)\\s*\\(\\s*${escaped}`, "giu")]
    : [
        new RegExp(`(?:writeFileSync?|appendFileSync?|write_text|write_bytes|createWriteStream|connect)\\s*\\(\\s*${escaped}`, "giu"),
        new RegExp(`open\\s*\\(\\s*${escaped}\\s*,\\s*(['\"])[^'\"]*[wa+][^'\"]*\\3`, "giu"),
      ];
  for (const expression of expressions) {
    for (const match of code.matchAll(expression)) {
      if (match[2]) result.push(match[2]);
    }
  }
  return result;
}

function commandPatternMatches(pattern: string, tokens: readonly string[], cwd: string, home: string | undefined): boolean {
  const expectedAnalysis = analyzeShellCommand(pattern);
  if (expectedAnalysis === null || expectedAnalysis.segments.length !== 1) return false;
  const expectedTokens = expectedAnalysis.segments[0];
  if (!expectedTokens || expectedTokens.length === 0) return false;
  const expectedRawExecutable = normalizeExecutable(expectedTokens[0] ?? "");
  const actual = effectiveCommand(tokens);
  if (!actual) return false;

  let expectedArgs: readonly string[];
  if (expectedRawExecutable === "sudo") {
    if (!actual.wrappers.includes("sudo")) return false;
    const sudoTarget = normalizeExecutable(expectedTokens[1] ?? "");
    if (actual.executable !== sudoTarget) return false;
    expectedArgs = expectedTokens.slice(2);
  } else {
    if (actual.executable !== expectedRawExecutable) return false;
    expectedArgs = expectedTokens.slice(1);
  }

  const expectedFlags = new Set(expectedArgs.flatMap((arg) => [...optionFlags(arg)]));
  const actualFlags = new Set(actual.args.flatMap((arg) => [...optionFlags(arg)]));
  const missingFlags = [...expectedFlags].filter((flag) => !actualFlags.has(flag));
  if (missingFlags.length > 0 && !actual.args.some(isDynamicPath)) return false;
  const expectedValues = positionalArguments(expectedArgs);
  const actualValues = positionalArguments(actual.args);
  let cursor = 0;
  for (const expected of expectedValues) {
    let found = false;
    while (cursor < actualValues.length) {
      const candidate = actualValues[cursor++] ?? "";
      if (ruleArgumentMatches(expected, candidate, cwd, home)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function ruleArgumentMatches(expected: string, candidate: string, cwd: string, home: string | undefined): boolean {
  if (isPathLike(expected)) {
    if ((expected === "/" || expected === "__OWL_HOME__" || expected.startsWith("__OWL_HOME__/")) && pathIsRootOrContainsHome(candidate, cwd, home)) return true;
    const expectedPath = normalizePathCandidate(expected, cwd, home);
    const candidatePath = normalizePathCandidate(candidate, cwd, home);
    return expectedPath !== null && candidatePath !== null && expectedPath === candidatePath;
  }
  return expected === candidate;
}

function compilePathPattern(pattern: string): RegExp {
  let normalized = pattern.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (normalized === "~") normalized = process.env.HOME ? resolve(process.env.HOME).replaceAll("\\", "/") : "~";
  else if (normalized.startsWith("~/") && process.env.HOME) normalized = resolve(process.env.HOME, normalized.slice(2)).replaceAll("\\", "/");
  if (normalized.startsWith("/")) normalized = canonicalizePath(normalized);
  let expression = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index] ?? "";
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else expression += ".*";
      } else expression += "[^/]*";
    } else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  if (!normalized.startsWith("/") && normalized !== "**") expression = `(?:^|/)${expression}`;
  return new RegExp(`^${expression}(?:/.*)?$`, "u");
}

function unresolvedPathRule(message: string): CompiledBlockPathRule {
  return {
    id: UNRESOLVED_PATH_RULE_ID,
    level: "system",
    pattern: "<unresolved>",
    mode: "both",
    matcher: /$a/u,
    message,
  };
}

const FILE_KEYS = new Set(["level", "role", "rules"]);
const RULE_KEYS: Record<RuleKind, ReadonlySet<string>> = {
  block_command: new Set(["id", "kind", "pattern", "message"]),
  block_path: new Set(["id", "kind", "pattern", "mode", "except", "message"]),
  instruction: new Set(["id", "kind", "text"]),
};

/** Parses one rule file strictly; throws RuleFileError for anything outside the documented format. */
export function parseRuleYaml(content: string, filePath: string): RuleFile {
  let parsed: ParsedYaml;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    if (error instanceof YamlSyntaxError) throw new RuleFileError(filePath, error.line, error.message);
    throw error;
  }
  const { data, keyLines, itemLines } = parsed;
  const fail = (reason: string, line: number | null = null): never => {
    throw new RuleFileError(filePath, line, reason);
  };
  for (const key of Object.keys(data)) {
    if (!FILE_KEYS.has(key)) fail(`unknown key '${key}'`, keyLines.get(key) ?? null);
  }
  const level = data.level;
  if (level === "work") {
    fail("level 'work' is not supported; Work rules live in the Work's rules (works.rules_json)", keyLines.get("level") ?? null);
  }
  if (level !== "absolute" && level !== "system" && level !== "role") {
    fail("level must be one of absolute, system, role", keyLines.get("level") ?? null);
  }
  const ruleLevel = level as RuleLevel;
  let role: RuleRole | undefined;
  if (ruleLevel === "role") {
    if (data.role === undefined) fail("level 'role' requires role");
    if (!isRuleRole(data.role)) fail(`unknown role '${String(data.role)}'`, keyLines.get("role") ?? null);
    role = data.role as RuleRole;
  } else if (data.role !== undefined) {
    fail(`role is only allowed with level 'role'`, keyLines.get("role") ?? null);
  }
  if (!Array.isArray(data.rules)) fail("rules must be a list (use [] for none)", keyLines.get("rules") ?? null);
  const rules: RuleDefinition[] = [];
  for (const [index, raw] of (data.rules as unknown[]).entries()) {
    const item = raw as Record<string, unknown>;
    const line = itemLines.get(item) ?? null;
    const label = typeof item.id === "string" && item.id.length > 0 ? `rule '${item.id}'` : `rule ${index + 1}`;
    if (typeof item.id !== "string" || item.id.trim().length === 0) fail(`${label}: id must be a non-empty string`, line);
    const kind = item.kind;
    if (kind !== "block_command" && kind !== "block_path" && kind !== "instruction") {
      fail(`${label}: kind must be one of block_command, block_path, instruction`, line);
    }
    const ruleKind = kind as RuleKind;
    for (const key of Object.keys(item)) {
      if (!RULE_KEYS[ruleKind].has(key)) fail(`${label}: key '${key}' is not allowed for kind ${ruleKind}`, line);
    }
    const nonEmpty = (key: string): string | undefined => {
      const value = item[key];
      if (value === undefined) return undefined;
      if (typeof value !== "string" || value.trim().length === 0) fail(`${label}: ${key} must be a non-empty string`, line);
      return value as string;
    };
    const pattern = nonEmpty("pattern");
    const message = nonEmpty("message");
    const text = nonEmpty("text");
    const except = nonEmpty("except");
    const mode = item.mode;
    if (ruleKind !== "instruction" && pattern === undefined) fail(`${label}: ${ruleKind} requires pattern`, line);
    if (ruleKind === "instruction" && text === undefined) fail(`${label}: instruction requires text`, line);
    if (mode !== undefined && mode !== "read" && mode !== "write" && mode !== "both") {
      fail(`${label}: mode must be one of read, write, both`, line);
    }
    if (ruleKind === "block_command") {
      const analysis = analyzeShellCommand(pattern as string);
      if (analysis === null || analysis.segments.length !== 1 || (analysis.segments[0]?.length ?? 0) === 0) {
        fail(`${label}: pattern must be exactly one simple command`, line);
      }
    }
    rules.push({
      id: item.id as string,
      kind: ruleKind,
      ...(pattern !== undefined ? { pattern } : {}),
      ...(mode !== undefined ? { mode: mode as BlockPathMode } : {}),
      ...(except !== undefined ? { except } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(message !== undefined ? { message } : {}),
    });
    const ids = rules.filter((rule) => rule.id === item.id);
    if (ids.length > 1) fail(`${label}: duplicate rule id`, line);
  }
  return { path: filePath, level: ruleLevel, ...(role !== undefined ? { role } : {}), rules };
}

export class RuleRenderError extends Error {
  public readonly code = "text_not_serializable";

  public constructor(public readonly rule_id: string, public readonly field: string) {
    super(`text_not_serializable:${rule_id}:${field}`);
    this.name = "RuleRenderError";
  }
}

/** Render a rule file using only values that the current simple YAML parser can recover exactly. */
export function renderRuleFile(file: RuleFile): string {
  const token = (value: string, id: string, field: string): string => {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new RuleRenderError(id, field);
    return value;
  };
  const quoted = (value: string, id: string, field: string): string => {
    if (/[\p{Cc}]/u.test(value)) throw new RuleRenderError(id, field);
    for (const quote of ['"', "'"] as const) {
      const candidate = `${quote}${value}${quote}`;
      try {
        if (parseYamlValue(stripYamlComment(candidate), 1) === value) return candidate;
      } catch {
        // A quote candidate that makes the current parser's quote state invalid is not serializable.
      }
    }
    throw new RuleRenderError(id, field);
  };

  const lines = [`level: ${token(file.level, "file", "level")}`];
  if (file.role !== undefined) lines.push(`role: ${token(file.role, "file", "role")}`);
  if (file.rules.length === 0) return `${lines.join("\n")}\nrules: []\n`;
  lines.push("rules:");
  for (const rule of file.rules) {
    lines.push(`  - id: ${token(rule.id, rule.id, "id")}`);
    lines.push(`    kind: ${token(rule.kind, rule.id, "kind")}`);
    if (rule.pattern !== undefined) lines.push(`    pattern: ${quoted(rule.pattern, rule.id, "pattern")}`);
    if (rule.mode !== undefined) lines.push(`    mode: ${token(rule.mode, rule.id, "mode")}`);
    if (rule.except !== undefined) lines.push(`    except: ${quoted(rule.except, rule.id, "except")}`);
    if (rule.text !== undefined) lines.push(`    text: ${quoted(rule.text, rule.id, "text")}`);
    if (rule.message !== undefined) lines.push(`    message: ${quoted(rule.message, rule.id, "message")}`);
  }
  return `${lines.join("\n")}\n`;
}

interface CompiledRuleFile {
  readonly blockRules: readonly CompiledBlockRule[];
  readonly blockPaths: readonly CompiledBlockPathRule[];
  readonly promptRules: readonly PromptRule[];
}

/** Each rule is compiled once: block rules feed the guard and one prompt line, instructions only the prompt. */
function compileRuleFile(file: RuleFile): CompiledRuleFile {
  const blockRules: CompiledBlockRule[] = [];
  const blockPaths: CompiledBlockPathRule[] = [];
  const promptRules: PromptRule[] = [];
  const scope = { level: file.level, ...(file.role !== undefined ? { role: file.role } : {}) };
  for (const rule of file.rules) {
    if (rule.kind === "block_command") {
      const pattern = rule.pattern as string;
      const message = rule.message ?? `Blocked command: ${pattern}`;
      blockRules.push({ id: rule.id, ...scope, pattern, message });
      promptRules.push({ id: rule.id, ...scope, kind: rule.kind, text: message });
    } else if (rule.kind === "block_path") {
      const pattern = rule.pattern as string;
      const mode = rule.mode ?? "both";
      const message = rule.message ?? `Blocked path (${mode}): ${pattern}`;
      let matcher: RegExp;
      let exceptMatcher: RegExp | undefined;
      try {
        matcher = compilePathPattern(pattern);
        if (rule.except !== undefined) exceptMatcher = compilePathPattern(rule.except);
      } catch (error) {
        throw new RuleFileError(file.path, null, `rule '${rule.id}': invalid path pattern (${error instanceof Error ? error.message : String(error)})`);
      }
      blockPaths.push({ id: rule.id, ...scope, pattern, mode, matcher, ...(exceptMatcher ? { exceptMatcher } : {}), message });
      promptRules.push({ id: rule.id, ...scope, kind: rule.kind, text: message });
    } else {
      promptRules.push({ id: rule.id, ...scope, kind: rule.kind, text: rule.text as string });
    }
  }
  return { blockRules, blockPaths, promptRules };
}

/**
 * The Work's own rules from works.rules_json. The only accepted form is
 * {"schema_version":"1.0.0","rules":[string, ...]}, which is what every
 * writer stores; anything else is an error, never silently "no rules".
 */
export function parseWorkRules(rulesJson: string | null | undefined, workId?: string): readonly string[] {
  let cause: string | null = null;
  let rules: readonly string[] = [];
  if (typeof rulesJson !== "string") {
    cause = "rules_json is missing";
  } else {
    try {
      const parsed: unknown = JSON.parse(rulesJson);
      if (!isRecord(parsed) || parsed.schema_version !== "1.0.0" || Object.keys(parsed).length !== 2 || !Array.isArray(parsed.rules)) {
        cause = "rules_json must be {\"schema_version\":\"1.0.0\",\"rules\":[...]}";
      } else if (parsed.rules.some((rule) => typeof rule !== "string")) {
        cause = "rules_json.rules must contain only strings";
      } else {
        rules = parsed.rules as string[];
      }
    } catch (error) {
      cause = error instanceof Error ? error.message : String(error);
    }
  }
  if (cause !== null) {
    throw new HumanReadableError({
      code: "invalid_work_rules",
      message: `Work ${workId ?? "(unknown)"} contains invalid rules_json.`,
      remediation: "Repair the Work's stored rules before starting an Agent.",
      details: { ...(workId !== undefined ? { work_id: workId } : {}), cause },
    });
  }
  return rules;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === code;
}
