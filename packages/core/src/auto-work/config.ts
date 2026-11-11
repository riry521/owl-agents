import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  AUTO_WORK_GITHUB_WATCHES, AUTO_WORK_RULE_ACTIONS, AUTO_WORK_RULE_SIZES, AUTO_WORK_SOURCES, isRuleRole,
  type AutoWorkConfigFile, type AutoWorkDbToggle, type AutoWorkRule, type AutoWorkRuleOrigin,
  type AutoWorkSource, type EffectiveAutoWorkConfig, type EffectiveAutoWorkRule,
} from "@owl/shared";
import { parseLibrarianTime } from "../librarian-scheduler.js";
import { isRecord } from "@owl/shared/small-helpers";

export type AutoWorkConfigLayer = "defaults" | "local" | "project";
export type AutoWorkConfigAlertKind = "auto_work_config_invalid" | "auto_work_config_restored";

export class AutoWorkConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AutoWorkConfigError";
  }
}

type Validator = (value: unknown, path: string) => void;

const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
/** Keys that would hold a credential or pick a model; the model comes from the Owl model settings. */
const REFUSED_KEY_PATTERN = /token|secret|password|api_key|^model$|^provider$/iu;
/** Values only defaults.json and local.json decide, so every Project shares one daily cap and day boundary. */
const GLOBAL_ONLY_PATHS: readonly string[] = [
  "judge_role", "judge_timeout_seconds", "candidate_limit", "max_detail_chars",
  "limits.max_works_per_day_all", "limits.day_start_time", "limits.alert_cooldown_minutes",
];
const ORIGIN_PRIORITY: Readonly<Record<AutoWorkRuleOrigin, number>> = { project: 0, local: 1, defaults: 2 };

function fail(path: string, message: string): never {
  throw new AutoWorkConfigError(`${path}: ${message}`);
}

const int = (min: number, max?: number): Validator => (value, path) => {
  if (!Number.isInteger(value) || (value as number) < min || (max !== undefined && (value as number) > max)) {
    fail(path, `must be an integer ${max === undefined ? `>= ${min}` : `from ${min} to ${max}`}`);
  }
};
const text: Validator = (value, path) => { if (typeof value !== "string") fail(path, "must be a string"); };
const nonEmptyText: Validator = (value, path) => { if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string"); };
const bool: Validator = (value, path) => { if (typeof value !== "boolean") fail(path, "must be a boolean"); };
const oneOf = (allowed: readonly string[]): Validator => (value, path) => {
  if (typeof value !== "string" || !allowed.includes(value)) fail(path, `must be one of ${allowed.join(", ")}`);
};
const nullable = (inner: Validator): Validator => (value, path) => { if (value !== null) inner(value, path); };
const array = (item: Validator, minLength = 0): Validator => (value, path) => {
  if (!Array.isArray(value) || value.length < minLength) fail(path, "must be an array");
  value.forEach((entry, index) => item(entry, `${path}[${index}]`));
};
const matching = (pattern: RegExp, what: string): Validator => (value, path) => {
  if (typeof value !== "string" || !pattern.test(value)) fail(path, `must be ${what}`);
};
const clockTime: Validator = (value, path) => {
  if (typeof value !== "string" || parseLibrarianTime(value) === null) fail(path, "must be HH:MM");
};
const regexSource: Validator = (value, path) => {
  nonEmptyText(value, path);
  try { new RegExp(value as string, "u"); } catch { fail(path, "must be a valid regular expression"); }
};
const absolutePath: Validator = (value, path) => {
  if (typeof value !== "string" || !isAbsolute(value)) fail(path, "must be an absolute path");
};
/** A free-form object; its keys are still checked for refused names by the caller. */
const record: Validator = (value, path) => { if (!isRecord(value)) fail(path, "must be an object"); };

/** An object that rejects unknown keys. `complete` makes every key except the `optional` ones required. */
function shape(fields: Record<string, Validator>, complete: boolean, optional: readonly string[] = []): Validator {
  return (value, path) => {
    if (!isRecord(value)) fail(path, "must be an object");
    for (const key of Object.keys(value)) if (!Object.hasOwn(fields, key)) fail(`${path}.${key}`, "is not a known key");
    if (complete) for (const key of Object.keys(fields)) if (!optional.includes(key) && !Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
    for (const [key, validate] of Object.entries(fields)) if (Object.hasOwn(value, key)) validate(value[key], `${path}.${key}`);
  };
}

function ruleList(complete: boolean): Validator {
  const rule = shape({
    id: matching(RULE_ID_PATTERN, "a lowercase id of letters, digits and hyphens"),
    source: oneOf(AUTO_WORK_SOURCES),
    kinds: array(nonEmptyText),
    min_occurrences: int(1),
    window_minutes: int(0),
    action: oneOf(AUTO_WORK_RULE_ACTIONS),
    size: oneOf(AUTO_WORK_RULE_SIZES),
    intent: text,
    params: record,
    disabled: bool,
  }, complete, ["params", "disabled"]);
  return (value, path) => {
    array(rule)(value, path);
    const ids = new Set<string>();
    for (const entry of value as { id?: unknown }[]) {
      // id is required in every layer: it is the key a higher layer overrides by.
      if (typeof entry.id !== "string") fail(`${path}`, "every rule needs an id");
      if (ids.has(entry.id)) fail(path, `rule id "${entry.id}" is used twice`);
      ids.add(entry.id);
    }
  };
}

function fileSchema(complete: boolean): Validator {
  return shape({
    schema_version: (value, path) => { if (value !== 1) fail(path, "must be 1"); },
    enabled: bool,
    judge_role: (value, path) => { if (!isRuleRole(value)) fail(path, "must be an actor role"); },
    judge_timeout_seconds: int(1),
    candidate_limit: int(1),
    max_detail_chars: int(1),
    limits: shape({
      max_works_per_day: int(0),
      max_works_per_day_all: int(0),
      day_start_time: clockTime,
      cooldown_hours: int(0),
      alert_cooldown_minutes: int(0),
    }, complete),
    scheduled_check: shape({ times: array(clockTime), items: array(nonEmptyText) }, complete),
    watch: shape({
      poll_seconds: int(1),
      context_lines: int(0),
      command_timeout_seconds: int(1),
      logs: array(shape({ path: absolutePath, pattern: regexSource, kind: nonEmptyText }, true)),
      commands: array(shape({ argv: array(nonEmptyText, 1), interval_minutes: int(1), kind: nonEmptyText, cwd: absolutePath }, true, ["cwd"])),
    }, complete),
    github: shape({
      repo: nullable(matching(REPO_PATTERN, "owner/name")),
      poll_minutes: int(1),
      per_page: int(1, 100),
      max_items_per_poll: int(1),
      since_margin_seconds: int(0),
      max_item_attempts: int(1),
      output_limit_bytes: int(1),
      initial_lookback_hours: int(1),
      timeout_seconds: int(1),
      allowed_users: array(nonEmptyText),
      require_labels: array(nonEmptyText),
      watch: array(oneOf(AUTO_WORK_GITHUB_WATCHES)),
      mention: nonEmptyText,
      owl_url: nullable(nonEmptyText),
      comments: shape({ created: text, completed: text, completed_no_pr: text, cancelled: text }, complete),
    }, complete),
    rules: ruleList(complete),
  }, complete);
}

function scanRefusedKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) value.forEach((entry, index) => scanRefusedKeys(entry, `${path}[${index}]`));
  else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (REFUSED_KEY_PATTERN.test(key)) fail(`${path}.${key}`, "this key cannot be set here");
      scanRefusedKeys(entry, `${path}.${key}`);
    }
  }
}

function lookup(value: unknown, dotted: string): unknown {
  let current = value;
  for (const key of dotted.split(".")) current = isRecord(current) ? current[key] : undefined;
  return current;
}

/** Parse and validate one configuration file. `path` only names the file in error messages. */
export function readAutoWorkConfigFile(path: string, content: string, layer: AutoWorkConfigLayer = "defaults"): AutoWorkConfigFile {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { fail(path, "is not valid JSON"); }
  scanRefusedKeys(parsed, path);
  fileSchema(layer === "defaults")(parsed, path);
  if (layer === "project") {
    for (const key of GLOBAL_ONLY_PATHS) if (lookup(parsed, key) !== undefined) fail(`${path}.${key}`, "only defaults.json and local.json can set this");
  }
  if (layer === "local" && lookup(parsed, "github.repo") !== undefined) {
    fail(`${path}.github.repo`, "is set per Project in projects/<id>.json");
  }
  return parsed as AutoWorkConfigFile;
}

type Layers = readonly (AutoWorkConfigFile | null)[];

/** The value of the highest layer that sets it. */
function firstSet<T>(layers: Layers, read: (file: AutoWorkConfigFile) => T | undefined): T {
  for (const file of layers) {
    const value = file ? read(file) : undefined;
    if (value !== undefined) return value;
  }
  throw new AutoWorkConfigError("defaults.json is missing a value");
}

function mergeRules(layers: readonly [AutoWorkRuleOrigin, AutoWorkConfigFile | null][]): EffectiveAutoWorkRule[] {
  const merged = new Map<string, { rule: Record<string, unknown>; origin: AutoWorkRuleOrigin; overridden: Set<string> }>();
  for (const [origin, file] of layers) {
    for (const entry of file?.rules ?? []) {
      const fields = entry as unknown as Record<string, unknown>;
      const known = merged.get(entry.id);
      if (!known) {
        for (const key of ["source", "kinds", "min_occurrences", "window_minutes", "action", "size", "intent"]) {
          if (fields[key] === undefined) fail(`rules[${entry.id}]`, `a new rule needs ${key}`);
        }
        merged.set(entry.id, { rule: { params: {}, disabled: false, ...fields }, origin, overridden: new Set() });
        continue;
      }
      for (const [key, value] of Object.entries(fields)) {
        if (key === "id") continue;
        const next = key === "params" ? { ...(known.rule.params as object), ...(value as object) } : value;
        if (JSON.stringify(known.rule[key]) !== JSON.stringify(next)) known.overridden.add(key);
        known.rule[key] = next;
      }
    }
  }
  return [...merged.values()].map(({ rule, origin, overridden }) => ({ ...(rule as unknown as AutoWorkRule), origin, overridden_fields: [...overridden] }));
}

/**
 * Layer the files for one Project. Priority: DB switch > projects/<id>.json > local.json > defaults.json.
 * Scalars come from the highest layer that sets them, arrays are replaced whole, rules are matched by id.
 */
export function mergeAutoWorkConfig(
  defaults: AutoWorkConfigFile,
  local: AutoWorkConfigFile | null,
  project: AutoWorkConfigFile | null,
  dbToggle: AutoWorkDbToggle,
): EffectiveAutoWorkConfig {
  const all: Layers = [project, local, defaults];
  const global: Layers = [local, defaults];
  const fileEnabled = (file: AutoWorkConfigFile) => file.enabled;
  const globalFrom = dbToggle.global !== null ? "db" : local?.enabled !== undefined ? "local_file" : "defaults";
  const projectFrom = dbToggle.project !== null ? "db" : project?.enabled !== undefined ? "project_file" : local?.enabled !== undefined ? "local_file" : "defaults";
  const github = defaults.github!;
  const pickGithub = Object.fromEntries(
    Object.keys(github).filter((key) => key !== "comments").map((key) => [key, firstSet(all, (f) => (f.github as Record<string, unknown> | undefined)?.[key])]),
  );
  return {
    enabled: { effective: dbToggle.project ?? firstSet(all, fileEnabled), from: projectFrom },
    global_enabled: { effective: dbToggle.global ?? firstSet(global, fileEnabled), from: globalFrom },
    judge_role: firstSet(global, (f) => f.judge_role),
    judge_timeout_seconds: firstSet(global, (f) => f.judge_timeout_seconds),
    candidate_limit: firstSet(global, (f) => f.candidate_limit),
    max_detail_chars: firstSet(global, (f) => f.max_detail_chars),
    limits: {
      max_works_per_day: firstSet(all, (f) => f.limits?.max_works_per_day),
      cooldown_hours: firstSet(all, (f) => f.limits?.cooldown_hours),
      max_works_per_day_all: firstSet(global, (f) => f.limits?.max_works_per_day_all),
      day_start_time: firstSet(global, (f) => f.limits?.day_start_time),
      alert_cooldown_minutes: firstSet(global, (f) => f.limits?.alert_cooldown_minutes),
    },
    scheduled_check: {
      times: firstSet(all, (f) => f.scheduled_check?.times),
      items: firstSet(all, (f) => f.scheduled_check?.items),
    },
    watch: {
      poll_seconds: firstSet(all, (f) => f.watch?.poll_seconds),
      context_lines: firstSet(all, (f) => f.watch?.context_lines),
      command_timeout_seconds: firstSet(all, (f) => f.watch?.command_timeout_seconds),
      logs: firstSet(all, (f) => f.watch?.logs),
      commands: firstSet(all, (f) => f.watch?.commands),
    },
    github: {
      ...(pickGithub as unknown as EffectiveAutoWorkConfig["github"]),
      comments: Object.fromEntries(
        Object.keys(github.comments!).map((key) => [key, firstSet(all, (f) => (f.github?.comments as Record<string, string> | undefined)?.[key])]),
      ) as unknown as EffectiveAutoWorkConfig["github"]["comments"],
    },
    rules: mergeRules([["defaults", defaults], ["local", local], ["project", project]]),
    config_error: null,
  };
}

/** The rule a signal is checked against: Project layer first, then local, then defaults; the file order breaks ties. Disabled rules never match. */
export function findAutoWorkRule(rules: readonly EffectiveAutoWorkRule[], source: AutoWorkSource, kind: string): EffectiveAutoWorkRule | null {
  const matches = rules.filter((rule) => !rule.disabled && rule.source === source && (rule.kinds.length === 0 || rule.kinds.includes(kind)));
  return matches.sort((a, b) => ORIGIN_PRIORITY[a.origin] - ORIGIN_PRIORITY[b.origin])[0] ?? null;
}

export interface AutoWorkConfigLoaderOptions {
  /** `<owlRoot>/rules/auto-work`. */
  readonly directory: string;
  readonly onAlert?: (kind: AutoWorkConfigAlertKind, detail: string) => void;
  readonly debounceMs?: number;
}

const NO_TOGGLE: AutoWorkDbToggle = { global: null, project: null };

/** Reads the three kinds of files. A file that fails keeps the last good content and sets `configError`. */
export class AutoWorkConfigLoader {
  private defaults: AutoWorkConfigFile | null = null;
  private local: AutoWorkConfigFile | null = null;
  private projects = new Map<string, AutoWorkConfigFile>();
  private error: string | null = null;
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reloading: Promise<void> = Promise.resolve();
  private onReloaded: (() => void) | undefined;

  public constructor(private readonly options: AutoWorkConfigLoaderOptions) {}

  public get configError(): string | null { return this.error; }

  /** The Project's settings, or null while defaults.json has never been read (the feature stays off). */
  public effective(projectId: string, dbToggle: AutoWorkDbToggle): EffectiveAutoWorkConfig | null {
    if (!this.defaults) return null;
    return { ...mergeAutoWorkConfig(this.defaults, this.local, this.projects.get(projectId) ?? null, dbToggle), config_error: this.error };
  }

  public hasProjectFile(projectId: string): boolean { return this.projects.has(projectId); }

  public reload(): Promise<void> {
    this.reloading = this.reloading.then(() => this.load());
    return this.reloading;
  }

  /** Reload when the files change. */
  public watch(onReloaded?: () => void): void {
    this.stopWatching();
    this.onReloaded = onReloaded;
    const debounceMs = this.options.debounceMs ?? 200;
    const trigger = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = null; void this.reload().then(() => this.onReloaded?.()); }, debounceMs);
    };
    for (const directory of [this.options.directory, join(this.options.directory, "projects")]) {
      try { this.watchers.push(watch(directory, { persistent: false }, trigger)); } catch { /* A directory that does not exist yet is picked up through its parent. */ }
    }
  }

  public async stop(): Promise<void> {
    this.stopWatching();
    await this.reloading;
  }

  private stopWatching(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  private async load(): Promise<void> {
    const errors: string[] = [];
    const read = async (file: string, layer: AutoWorkConfigLayer, label: string): Promise<AutoWorkConfigFile | null | undefined> => {
      let content: string;
      try { content = await readFile(file, "utf8"); } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
        errors.push(`${label}: cannot be read`);
        return undefined;
      }
      try { return readAutoWorkConfigFile(label, content, layer); } catch (cause) {
        errors.push((cause as Error).message);
        return undefined;
      }
    };
    const defaults = await read(join(this.options.directory, "defaults.json"), "defaults", "defaults.json");
    if (defaults === null) errors.push("defaults.json: is missing");
    if (defaults) this.defaults = defaults;
    const local = await read(join(this.options.directory, "local.json"), "local", "local.json");
    // undefined = unreadable or invalid: keep the last good file. null = no file.
    const nextLocal = local === undefined ? this.local : local;
    // A missing directory means no Project files; any other failure keeps the last good Project settings.
    let projectIds: string[];
    try {
      projectIds = (await readdir(join(this.options.directory, "projects"))).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
    } catch (cause) {
      const missing = (cause as NodeJS.ErrnoException).code === "ENOENT";
      if (!missing) errors.push("projects: cannot be read");
      projectIds = missing ? [] : [...this.projects.keys()];
    }
    const nextProjects = new Map<string, AutoWorkConfigFile>();
    for (const id of projectIds) {
      const loaded = await read(join(this.options.directory, "projects", `${id}.json`), "project", `projects/${id}.json`);
      const file = loaded === undefined ? this.projects.get(id) : loaded;
      if (file) nextProjects.set(id, file);
    }
    // A file that parses can still leave a custom rule without the fields a rule needs; that is checked on the merged result.
    const base = this.defaults;
    let acceptedLocal = nextLocal;
    if (base) {
      try { mergeAutoWorkConfig(base, nextLocal, null, NO_TOGGLE); } catch (cause) {
        errors.push(`local.json: ${(cause as Error).message}`);
        acceptedLocal = this.local;
      }
      for (const [id, file] of [...nextProjects]) {
        try { mergeAutoWorkConfig(base, acceptedLocal, file, NO_TOGGLE); } catch (cause) {
          errors.push(`projects/${id}.json: ${(cause as Error).message}`);
          const previous = this.projects.get(id);
          if (previous) nextProjects.set(id, previous); else nextProjects.delete(id);
        }
      }
    }
    this.local = acceptedLocal;
    this.projects = nextProjects;
    this.setError(errors.length > 0 ? errors.join("; ") : null);
    if (this.watchers.length > 0) this.watch(this.onReloaded);
  }

  private setError(next: string | null): void {
    const previous = this.error;
    this.error = next;
    if (next !== null && next !== previous) this.options.onAlert?.("auto_work_config_invalid", next);
    else if (next === null && previous !== null) this.options.onAlert?.("auto_work_config_restored", previous);
  }
}
