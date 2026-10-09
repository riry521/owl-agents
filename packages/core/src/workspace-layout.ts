import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Directory name used for Task/Work/Advisor worktrees nested inside an Owl clone. */
export const LEGACY_WORKSPACES_DIRNAME = ".owl-workspaces";

export const ADVISOR_SHARED_DIRNAME = "shared";
export const ADVISOR_HOME_DIRNAME = "home";

/** Sanitizes an id (workId, taskId, conversationId, ...) into a filesystem-safe path segment; never empty, `.` or `..`. */
export function safeSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return /^\.*$/u.test(segment) ? segment.replace(/\./gu, "_") || "_" : segment;
}

/** True when `candidate` is `base` or a descendant of it, resolved via `relative()`. */
function inside(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** True when running under the Node test runner, which sets NODE_TEST_CONTEXT for every process it spawns. */
export function isNodeTestRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.NODE_TEST_CONTEXT === "string" && env.NODE_TEST_CONTEXT !== "";
}

const testScratchDirs = new Map<string, string>();

/** A per-process temporary directory, created on first use, so test runs never touch real Owl data. */
function testScratchDir(name: string): string {
  let dir = testScratchDirs.get(name);
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), `owl-test-${name}-`));
    testScratchDirs.set(name, dir);
  }
  return dir;
}

/**
 * The Owl repository root used when none is given: `process.cwd()`, or a
 * per-process temporary directory under the Node test runner so Git
 * worktrees and branches are never created in the real repository.
 */
export function defaultOwlRoot(env: NodeJS.ProcessEnv = process.env): string {
  return isNodeTestRun(env) ? testScratchDir("root") : process.cwd();
}

/**
 * Resolves the root directory Owl stores Task/Work/Advisor worktrees under.
 * `OWL_WORKSPACES_DIR`, when set to a non-empty string, takes precedence;
 * otherwise workspaces live under `~/.owl/workspaces`, outside of any
 * repository. Under the Node test runner the fallback is a per-process
 * temporary directory instead, so tests never touch the real root.
 */
export function resolveWorkspacesRoot(env: NodeJS.ProcessEnv, home: string): string {
  const override = env.OWL_WORKSPACES_DIR;
  if (typeof override === "string" && override.trim() !== "") {
    return resolve(override);
  }
  if (isNodeTestRun(env)) return testScratchDir("workspaces");
  return join(home, ".owl", "workspaces");
}

/**
 * Resolves Task/Work/Advisor workspace paths across two possible roots: the
 * current root (outside of any repository) and a legacy root nested inside
 * an Owl clone (`<owlRoot>/.owl-workspaces`), kept for worktrees that were
 * already created there before the current root existed.
 */
export class WorkspaceLayout {
  readonly root: string;
  readonly legacyRoot: string;

  constructor(root: string, legacyRoot: string) {
    this.root = resolve(root);
    this.legacyRoot = resolve(legacyRoot);
  }

  /** A layout with no separate current root; everything resolves under `<owlRoot>/.owl-workspaces`. */
  static legacyOnly(owlRoot: string): WorkspaceLayout {
    const legacyRoot = resolve(owlRoot, LEGACY_WORKSPACES_DIRNAME);
    return new WorkspaceLayout(legacyRoot, legacyRoot);
  }

  /** The distinct roots this layout may resolve paths under. */
  roots(): readonly string[] {
    return this.root === this.legacyRoot ? [this.root] : [this.root, this.legacyRoot];
  }

  /** The Work directory for `workId`, preferring an already-existing legacy directory. */
  workDir(workId: string): string {
    const legacy = join(this.legacyRoot, safeSegment(workId));
    if (existsSync(legacy)) {
      return legacy;
    }
    return join(this.root, safeSegment(workId));
  }

  taskPath(workId: string, taskId: string): string {
    return join(this.workDir(workId), safeSegment(taskId));
  }

  integrationPath(workId: string): string {
    return join(this.workDir(workId), "__work__");
  }

  /** The single shared Advisor worktree for the repository identified by `key`; always under the current root. */
  advisorSharedDir(key: string): string {
    return join(this.root, "advisor", ADVISOR_SHARED_DIRNAME, safeSegment(key));
  }

  /** The empty scratch directory read-only Advisor sessions run in, outside any repository. */
  advisorHomeDir(): string {
    return join(this.root, "advisor", ADVISOR_HOME_DIRNAME);
  }

  /** True when `path` is inside (or equal to) any root this layout resolves under. */
  contains(path: string): boolean {
    return this.roots().some((root) => inside(root, path));
  }

  /** The root that contains `path`, or null when it is under neither root. */
  rootOf(path: string): string | null {
    return this.roots().find((root) => inside(root, path)) ?? null;
  }
}
