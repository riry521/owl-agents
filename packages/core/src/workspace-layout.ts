import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Directory name used for Task/Work/Advisor worktrees nested inside an Owl clone. */
export const LEGACY_WORKSPACES_DIRNAME = ".owl-workspaces";

/** Sanitizes an id (workId, taskId, conversationId, ...) into a filesystem-safe path segment. */
export function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** True when `candidate` is `base` or a descendant of it, resolved via `relative()`. */
function inside(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolves the root directory Owl stores Task/Work/Advisor worktrees under.
 * `OWL_WORKSPACES_DIR`, when set to a non-empty string, takes precedence;
 * otherwise workspaces live under `~/.owl/workspaces`, outside of any repository.
 */
export function resolveWorkspacesRoot(env: NodeJS.ProcessEnv, home: string): string {
  const override = env.OWL_WORKSPACES_DIR;
  if (typeof override === "string" && override.trim() !== "") {
    return resolve(override);
  }
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

  /** The Advisor workspace directory for `conversationId`, preferring an already-existing legacy directory. */
  advisorDir(conversationId: string): string {
    const legacy = join(this.legacyRoot, "advisor", safeSegment(conversationId));
    if (existsSync(legacy)) {
      return legacy;
    }
    return join(this.root, "advisor", safeSegment(conversationId));
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
