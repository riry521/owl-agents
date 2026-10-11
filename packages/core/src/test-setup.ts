import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { REGEX_FLAGS, type TestSetupSettings } from "../../shared/dist/test-setup-settings.js";
import { matchesGlobWithDots } from "./glob.js";
import { DEFAULT_TEST_DETECTION_RULES } from "./test-detection-rules.js";
import type { JsonObject, TestSetupView } from "./types.js";

const execFileAsync = promisify(execFile);
const GIT_BUFFER_BYTES = 64 * 1024 * 1024;

export const TEST_SETUP_STATUSES = ["ready", "tests_failing", "no_tests", "no_language", "needs_approval", "unresolved"] as const;
export type TestSetupStatus = (typeof TEST_SETUP_STATUSES)[number];

export interface TestSetupDigests {
  readonly layout: string;
  readonly tests: string;
  readonly sources: string;
  readonly settings: string;
}

export interface KnownFailure {
  readonly file: string;
  readonly name: string;
}

/** The JSON kept in projects / works / tasks .test_setup_json. */
export interface StoredTestSetup {
  readonly status: TestSetupStatus;
  /** Test run settings the setup adds to the defaults (setup_argvs, cwd, mode, argv ...); null = none. */
  readonly test_run: JsonObject | null;
  readonly executables: Readonly<Record<string, { readonly path: string; readonly version: string | null }>>;
  /** Checkout-relative files the agent read to decide. */
  readonly sources: readonly string[];
  readonly digests: TestSetupDigests;
  /** Set for a repair of an Owner's explicit test_run; the record then applies only to that test_run. */
  readonly explicit_digest: string | null;
  readonly confirmed_at: string | null;
  readonly attempts: TestSetupView["attempts"];
  readonly outside_installs: TestSetupView["outside_installs"];
  /** Tests that already failed when the setup was confirmed (per_file runs only); later test runs treat them as pre-existing. */
  readonly known_failures: readonly KnownFailure[];
  /** New untracked files the investigation's test runs left in the Project and that were removed at the end (checkout-relative). */
  readonly removed_files: readonly string[];
  readonly missing: readonly string[];
  readonly trigger: string;
  readonly investigated_at: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** null (with a warning) when the JSON is absent-shaped or broken; a record is never partly trusted. */
export function readStoredTestSetup(json: string | null, warn?: (message: string) => void): StoredTestSetup | null {
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (!isRecord(value)) throw new Error("not an object");
    if (!(TEST_SETUP_STATUSES as readonly unknown[]).includes(value.status)) throw new Error("status");
    const digests = value.digests;
    if (!isRecord(digests) || !(["layout", "tests", "sources", "settings"] as const).every((key) => typeof digests[key] === "string")) throw new Error("digests");
    if (!isStrings(value.sources)) throw new Error("sources");
    if (value.test_run !== null && value.test_run !== undefined && !isRecord(value.test_run)) throw new Error("test_run");
    const executables = isRecord(value.executables) ? value.executables : {};
    return {
      status: value.status as TestSetupStatus,
      test_run: (value.test_run as JsonObject | null | undefined) ?? null,
      executables: Object.fromEntries(
        Object.entries(executables).flatMap(([name, entry]) =>
          isRecord(entry) && typeof entry.path === "string" && entry.path.length > 0
            ? [[name, { path: entry.path, version: typeof entry.version === "string" ? entry.version : null }]]
            : []),
      ),
      sources: value.sources,
      digests: digests as unknown as TestSetupDigests,
      explicit_digest: typeof value.explicit_digest === "string" ? value.explicit_digest : null,
      confirmed_at: typeof value.confirmed_at === "string" ? value.confirmed_at : null,
      attempts: Array.isArray(value.attempts) ? (value.attempts as StoredTestSetup["attempts"]) : [],
      outside_installs: Array.isArray(value.outside_installs) ? (value.outside_installs as StoredTestSetup["outside_installs"]) : [],
      known_failures: Array.isArray(value.known_failures)
        ? value.known_failures.filter((entry): entry is KnownFailure => isRecord(entry) && typeof entry.file === "string" && typeof entry.name === "string" && entry.name !== "")
        : [],
      removed_files: isStrings(value.removed_files) ? value.removed_files : [],
      missing: isStrings(value.missing) ? value.missing : [],
      trigger: typeof value.trigger === "string" ? value.trigger : "",
      investigated_at: typeof value.investigated_at === "string" ? value.investigated_at : "",
    };
  } catch (error) {
    warn?.(`Invalid test_setup_json (${error instanceof Error ? error.message : String(error)}); ignoring the record.`);
    return null;
  }
}

const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

/** The digest a repair record stores for the Owner's test_run_json; resolution and display both compare against it. */
export const explicitTestRunDigest = (testRunJson: string): string => sha256(testRunJson);

function readFileOrNull(root: string, path: string): Buffer | null {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  try {
    return readFileSync(target);
  } catch {
    return null;
  }
}

function fileSizeOrNull(root: string, path: string): number | null {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  try {
    const stat = statSync(target);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

const insideIgnored = (path: string, ignored: readonly string[]): boolean => path.split("/").some((segment) => ignored.includes(segment));

async function listFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, maxBuffer: GIT_BUFFER_BYTES });
    return stdout.split("\0").filter((path) => path.length > 0);
  } catch {
    return null;
  }
}

/** Digest of the files the agent read: path and content hash; an absent file counts as absent. Callers skip test files: the `tests` digest covers them by their import lines. */
export function sourcesDigest(root: string, sources: readonly string[], skip: (path: string) => boolean = () => false): string {
  const hash = createHash("sha256");
  for (const path of [...sources].filter((entry) => !skip(entry)).sort()) {
    const content = readFileOrNull(root, path);
    hash.update(`${path}\0${content === null ? "\u0000absent" : sha256(content)}\n`);
  }
  return hash.digest("hex");
}

function settingsDigest(rulesVersion: string, settings: TestSetupSettings): string {
  const { input_files, test_file_globs, import_patterns, ignored_dirs, bootstrap } = settings;
  return sha256(JSON.stringify({ rulesVersion, input_files, test_file_globs, import_patterns, ignored_dirs, bootstrap }));
}

/**
 * The four digests of a checkout. layout: input files' content (a new test file changes `tests` only, so it never triggers an investigation). tests: test file paths
 * and their import lines. null when `root` is not a git checkout.
 */
export async function testSetupDigests(input: {
  readonly root: string;
  readonly rules_version: string;
  readonly settings: TestSetupSettings;
  readonly sources?: readonly string[];
  /** Extra text for the layout digest (the detection's marker digest). */
  readonly marker_digest?: string;
  /** A test file larger than this contributes its size only (default: the detection rules' limit). */
  readonly max_file_bytes?: number;
}): Promise<TestSetupDigests | null> {
  const files = await listFiles(input.root);
  if (files === null) return null;
  const { settings, root } = input;
  const maxBytes = input.max_file_bytes ?? DEFAULT_TEST_DETECTION_RULES.max_file_bytes;
  const present = files.filter((path) => !insideIgnored(path, settings.ignored_dirs) && fileSizeOrNull(root, path) !== null).sort();
  const isTest = (path: string): boolean => settings.test_file_globs.some((glob) => matchesGlobWithDots(path, glob));
  const isInput = (path: string): boolean => settings.input_files.some((glob) => matchesGlobWithDots(path, glob));
  const patterns = settings.import_patterns.map((source) => new RegExp(source, REGEX_FLAGS));

  const layout = createHash("sha256");
  layout.update(`${input.marker_digest ?? ""}\n`);
  const testFiles = present.filter(isTest);
  for (const path of present.filter(isInput)) layout.update(`${path}\0${sha256(readFileOrNull(root, path) ?? "")}\n`);

  const tests = createHash("sha256");
  for (const path of testFiles) {
    const size = fileSizeOrNull(root, path) ?? 0;
    const lines = size > maxBytes ? [`size:${size}`] : [...new Set((readFileOrNull(root, path)?.toString("utf8") ?? "").split(/\r?\n/u).filter((line) => patterns.some((pattern) => pattern.test(line))))].sort();
    tests.update(`${path}\0${lines.join("\n")}\n`);
  }

  return {
    layout: layout.digest("hex"),
    tests: tests.digest("hex"),
    sources: sourcesDigest(root, input.sources ?? [], isTest),
    settings: settingsDigest(input.rules_version, settings),
  };
}

/** Test files of the checkout that match the record's own test_patterns (the setup settings' globs when it has none). */
export async function currentTestFileCount(root: string, record: StoredTestSetup, settings: TestSetupSettings): Promise<number> {
  const own = record.test_run?.test_patterns;
  const patterns = isStrings(own) && own.length > 0 ? own : settings.test_file_globs;
  const files = (await listFiles(root)) ?? [];
  return files.filter((path) => !insideIgnored(path, settings.ignored_dirs) && patterns.some((glob) => matchesGlobWithDots(path, glob))).length;
}

export type TestSetupMatch = "explicit" | "exact" | "tests_changed" | "stale";

export interface TestSetupSelection {
  readonly setup: StoredTestSetup;
  readonly match: TestSetupMatch;
}

/**
 * Picks the record a checkout uses from `records` (already in place order: Task, Work, other Tasks of the Work, Project).
 * A record whose digests differ is never "exact". Pure: the caller computes the current digests.
 */
export function selectTestSetup(input: {
  readonly records: readonly StoredTestSetup[];
  readonly current: Pick<TestSetupDigests, "layout" | "tests" | "settings">;
  /** The sources digest of a record's own source list in this checkout. */
  readonly sourcesDigestOf: (record: StoredTestSetup) => string;
  readonly explicitDigest: string | null;
  /** How many files of this checkout match the record's own test_patterns (used for no_tests records). */
  readonly currentTestFiles: (record: StoredTestSetup) => number;
}): TestSetupSelection | null {
  const { records, current } = input;
  if (input.explicitDigest !== null) {
    const hit = records.find((record) => record.explicit_digest === input.explicitDigest && (record.status === "ready" || record.status === "tests_failing"));
    return hit === undefined ? null : { setup: hit, match: "explicit" };
  }
  const usable = records.filter((record) => record.explicit_digest === null);
  const keyMatches = (record: StoredTestSetup): boolean =>
    record.digests.layout === current.layout && record.digests.settings === current.settings && record.digests.sources === input.sourcesDigestOf(record);
  for (const record of usable) {
    if (!keyMatches(record) || record.digests.tests !== current.tests) continue;
    if (record.status === "no_tests" && input.currentTestFiles(record) > 0) return { setup: record, match: "tests_changed" };
    return { setup: record, match: "exact" };
  }
  const changed = usable.find((record) => keyMatches(record));
  if (changed !== undefined) return { setup: changed, match: "tests_changed" };
  const ready = usable.find((record) => record.status === "ready");
  return ready === undefined ? null : { setup: ready, match: "stale" };
}

/** Digests of a checkout, then the record it uses; null when there is no record or the checkout is not a git checkout. */
export async function selectTestSetupInCheckout(input: {
  readonly root: string;
  readonly records: readonly StoredTestSetup[];
  readonly rules_version: string;
  readonly settings: TestSetupSettings;
  readonly marker_digest?: string;
  readonly explicitDigest?: string | null;
  /** Passed on to testSetupDigests so records are made and selected under the same limit. */
  readonly max_file_bytes?: number;
}): Promise<TestSetupSelection | null> {
  if (input.records.length === 0) return null;
  const digests = await testSetupDigests({ root: input.root, rules_version: input.rules_version, settings: input.settings, marker_digest: input.marker_digest, max_file_bytes: input.max_file_bytes });
  if (digests === null) return null;
  const counts = new Map<StoredTestSetup, number>();
  for (const record of input.records) {
    if (record.status === "no_tests") counts.set(record, await currentTestFileCount(input.root, record, input.settings));
  }
  return selectTestSetup({
    records: input.records,
    current: digests,
    sourcesDigestOf: (record) => sourcesDigest(input.root, record.sources, (path) => input.settings.test_file_globs.some((glob) => matchesGlobWithDots(path, glob))),
    explicitDigest: input.explicitDigest ?? null,
    currentTestFiles: (record) => counts.get(record) ?? 0,
  });
}

export type CheckoutSnapshot = ReadonlyMap<string, string>;
export interface SnapshotDifference {
  readonly kind: "tracked" | "left" | "removed";
  readonly path: string;
}

const inEnvironmentDir = (path: string, environmentDirs: readonly string[]): boolean =>
  environmentDirs.some((dir) => {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    return path.startsWith(prefix) || path.includes(`/${prefix}`);
  });

function contentKey(root: string, path: string): string {
  const content = readFileOrNull(root, path);
  return content === null ? "absent" : sha256(content);
}

/**
 * Content hashes of the tracked changes and of every untracked, not-ignored file, except environment_dirs.
 * Why not include ignored files: they are generated output (e.g. apps/web/.next/ from a build the agent ran),
 * which does not mean the agent dirtied the Project, and listing them made a passing setup look unverified.
 */
export async function snapshotCheckout(root: string, environmentDirs: readonly string[]): Promise<CheckoutSnapshot> {
  const snapshot = new Map<string, string>();
  const status = await execFileAsync("git", ["status", "--porcelain", "-z", "--untracked-files=no"], { cwd: root, maxBuffer: GIT_BUFFER_BYTES });
  const entries = status.stdout.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.includes("R") || code.includes("C")) index += 1;
    if (inEnvironmentDir(path, environmentDirs)) continue;
    snapshot.set(`tracked\0${path}`, `${code}\0${contentKey(root, path)}`);
  }
  const others = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, maxBuffer: GIT_BUFFER_BYTES });
  for (const path of others.stdout.split("\0")) {
    if (path.length === 0 || inEnvironmentDir(path, environmentDirs)) continue;
    snapshot.set(`left\0${path}`, contentKey(root, path));
  }
  return snapshot;
}

/** What changed between two snapshots: tracked changes, untracked files added or rewritten, untracked files removed. */
export function diffSnapshots(before: CheckoutSnapshot, after: CheckoutSnapshot): SnapshotDifference[] {
  const differences: SnapshotDifference[] = [];
  for (const [key, value] of after) {
    if (before.get(key) === value) continue;
    const [kind, path] = key.split("\0") as ["tracked" | "left", string];
    differences.push({ kind, path });
  }
  for (const key of before.keys()) {
    if (after.has(key)) continue;
    const [kind, path] = key.split("\0") as ["tracked" | "left", string];
    differences.push({ kind: kind === "tracked" ? "tracked" : "removed", path });
  }
  return differences.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
}

/** Every path git sees in the checkout: tracked, untracked and ignored. Why not the snapshot: it leaves out unchanged tracked and ignored files, which are not "new". */
export async function listCheckoutFiles(root: string): Promise<Set<string>> {
  const listed = await execFileAsync("git", ["ls-files", "--cached", "--others", "-z"], { cwd: root, maxBuffer: GIT_BUFFER_BYTES });
  return new Set(listed.stdout.split("\0").filter((path) => path.length > 0));
}

/** Untracked files in `after` whose path did not exist before at all (an old file that was rewritten or only changed class is not new). */
export function newUntrackedPaths(existedBefore: ReadonlySet<string>, after: CheckoutSnapshot): string[] {
  return [...after.keys()].filter((key) => key.startsWith("left\0")).map((key) => key.slice("left\0".length)).filter((path) => !existedBefore.has(path)).sort();
}

/** True when the relative path is the base itself or leaves it (a ".." path element; a name like "..cache" stays inside). */
function leavesBase(inside: string): boolean {
  return inside === "" || isAbsolute(inside) || inside.split(sep)[0] === "..";
}

/**
 * Removes the given untracked files and the folders they leave empty.
 * Why lstat and unlink: a symlink is removed itself and its target is never followed or touched.
 * Why the parent realpath check: lstat looks at the last element only, so a symlinked folder would send unlink outside the checkout.
 * `failed` holds the files that could not be removed; a file that is already gone is neither removed nor failed.
 */
export function removeUntrackedFiles(root: string, paths: readonly string[]): { removed: string[]; failed: string[] } {
  const base = resolve(root);
  const realBase = realpathSync(base);
  const removed: string[] = [];
  const failed: string[] = [];
  for (const path of paths) {
    const target = resolve(base, path);
    const inside = relative(base, target);
    if (leavesBase(inside)) { failed.push(path); continue; }
    try {
      if (realpathSync(dirname(target)) !== resolve(realBase, dirname(inside)) || lstatSync(target).isDirectory()) { failed.push(path); continue; }
      unlinkSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed.push(path);
      continue;
    }
    removed.push(path);
    for (let dir = dirname(target); !leavesBase(relative(base, dir)); dir = dirname(dir)) {
      try { if (readdirSync(dir).length > 0) break; rmdirSync(dir); } catch { break; }
    }
  }
  return { removed, failed };
}

/** Executable name -> command: the defaults, then the record's own (a checkout-relative path is made absolute). */
export function testExecutables(setup: StoredTestSetup | null, root: string, defaultExecutables: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = { ...defaultExecutables };
  for (const [name, entry] of Object.entries(setup?.executables ?? {})) {
    result[name] = isAbsolute(entry.path) || !entry.path.includes("/") ? entry.path : resolve(root, entry.path);
  }
  return result;
}

/** Replaces "{name}" in each argument with its executable. */
export function withExecutables(argv: readonly string[], executables: Readonly<Record<string, string>>): string[] {
  return argv.map((item) => Object.entries(executables).reduce((text, [name, command]) => text.replaceAll(`{${name}}`, command), item));
}

/** `command` and `prepare_command` are shown with "{name}" replaced by the record's executables (relative ones resolved from `root`). */
export function testSetupView(setup: StoredTestSetup | null, root: string, defaultExecutables: Readonly<Record<string, string>>): TestSetupView | null {
  if (setup === null) return null;
  const run = setup.test_run ?? {};
  const executables = testExecutables(setup, root, defaultExecutables);
  const argvOf = (key: string): readonly string[] | null => (isStrings(run[key]) && run[key].length > 0 ? withExecutables(run[key], executables) : null);
  const command = run.mode === "whole" ? argvOf("whole_argv") : argvOf("file_argv");
  return {
    status: setup.status,
    command,
    setup_commands: Array.isArray(run.setup_argvs) ? (run.setup_argvs as readonly (readonly string[])[]).map((argv) => withExecutables(argv, executables)) : [],
    prepare_command: argvOf("prepare_argv"),
    cwd: typeof run.cwd === "string" ? run.cwd : ".",
    executables: setup.executables,
    sources: setup.sources,
    confirmed_at: setup.confirmed_at,
    attempts: setup.attempts,
    outside_installs: setup.outside_installs,
    missing: setup.missing,
    trigger: setup.trigger,
    investigated_at: setup.investigated_at,
  };
}
