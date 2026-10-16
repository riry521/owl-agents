import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<{ ok: boolean; stdout: string }>;

export const CREATED_BY_WORK_CONFIG_KEY = "owl.createdByWork";

export type RepositoryRootInspection =
  | { readonly kind: "not_repository" }
  | { readonly kind: "bare" }
  | { readonly kind: "linked_worktree"; readonly root: string }
  | { readonly kind: "submodule"; readonly root: string }
  | { readonly kind: "no_commit"; readonly root: string }
  | { readonly kind: "no_branch"; readonly root: string }
  | { readonly kind: "repository"; readonly root: string; readonly base_branch: string; readonly created_by_work: string | null };

export async function currentBranch(git: GitRunner, root: string): Promise<string> {
  const result = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.ok ? result.stdout.trim() : "";
}

export async function chooseBaseBranch(git: GitRunner, root: string): Promise<string | null> {
  const remoteHead = await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead.ok) {
    const remoteRef = remoteHead.stdout.trim();
    const slash = remoteRef.indexOf("/");
    if (slash > 0) {
      const localName = remoteRef.slice(slash + 1);
      const localExists = await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${localName}`]);
      if (localExists.ok) return localName;
      const remoteExists = await git(root, ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteRef}`]);
      if (remoteExists.ok) return remoteRef;
    }
  }

  for (const branch of ["main", "master"]) {
    const local = await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (local.ok) return branch;
  }
  const active = await currentBranch(git, root);
  if (active) return active;
  const branches = await git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return branches.ok ? branches.stdout.trim().split("\n").find(Boolean) ?? null : null;
}

export async function inspectRepositoryRoot(git: GitRunner, path: string): Promise<RepositoryRootInspection> {
  const bare = await git(path, ["rev-parse", "--is-bare-repository"]);
  if (bare.ok && bare.stdout.trim() === "true") return { kind: "bare" };

  const top = await git(path, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.stdout.trim()) return { kind: "not_repository" };
  const root = await realpath(top.stdout.trim());

  const superproject = await git(root, ["rev-parse", "--show-superproject-working-tree"]);
  if (superproject.ok && superproject.stdout.trim()) return { kind: "submodule", root };

  const [gitDir, commonDir] = await Promise.all([
    git(root, ["rev-parse", "--absolute-git-dir"]),
    git(root, ["rev-parse", "--git-common-dir"]),
  ]);
  if (gitDir.ok && commonDir.ok && await realpath(gitDir.stdout.trim()) !== await realpath(resolve(root, commonDir.stdout.trim()))) {
    return { kind: "linked_worktree", root };
  }

  const head = await git(root, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) return { kind: "no_commit", root };

  const base_branch = await chooseBaseBranch(git, root);
  if (!base_branch) return { kind: "no_branch", root };

  const created = await git(root, ["config", "--local", "--get", CREATED_BY_WORK_CONFIG_KEY]);
  return { kind: "repository", root, base_branch, created_by_work: created.ok ? created.stdout.trim() || null : null };
}
