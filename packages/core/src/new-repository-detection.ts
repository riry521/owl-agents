import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { RepositoryRootInspection } from "./repository-inspection.js";

export type NewRepositorySkipReason =
  | "owl_managed_path"
  | "inside_registered_project"
  | "not_repository"
  | "bare"
  | "linked_worktree"
  | "submodule"
  | "no_commit"
  | "no_branch"
  | "already_registered"
  | "not_created_by_work"
  | "existed_before_work"
  | "birthtime_unavailable";

export interface NewRepositoryCandidate {
  readonly canonical_path: string;
  readonly base_branch: string;
  readonly name: string;
}

export interface SkippedRepositoryPath {
  readonly path: string;
  readonly reason: NewRepositorySkipReason;
}

export interface NewRepositoryDetectionDependencies {
  /** Inspect the repository that contains `path` (the nearest existing folder). */
  inspect(path: string): Promise<RepositoryRootInspection>;
  /** Creation time of a folder in ms; 0 or NaN when the file system does not report one. */
  birthtimeMs(path: string): Promise<number>;
}

export interface NewRepositoryDetectionInput {
  readonly workId: string;
  /** Worker report payloads; only `changes[].file` is read. */
  readonly reports: readonly unknown[];
  /** Read lazily: it costs an events scan and is only needed when a candidate remains. */
  readonly workStartedAtMs: () => number | null;
  readonly excludedRoots: readonly string[];
  readonly registeredProjectPaths: readonly string[];
}

export interface NewRepositoryDetection {
  readonly repositories: readonly NewRepositoryCandidate[];
  readonly skipped: readonly SkippedRepositoryPath[];
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Folders of the absolute paths a Worker reported, minus Owl-managed and registered Project paths. */
export function collectCandidatePaths(
  reports: readonly unknown[],
  excludedRoots: readonly string[],
  registeredProjectPaths: readonly string[],
): { readonly directories: readonly string[]; readonly skipped: readonly SkippedRepositoryPath[] } {
  const directories = new Set<string>();
  const skipped = new Map<string, SkippedRepositoryPath>();
  for (const report of reports) {
    const changes = (report as { changes?: unknown } | null)?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const file = (change as { file?: unknown } | null)?.file;
      if (typeof file !== "string" || !isAbsolute(file)) continue;
      const path = resolve(file);
      if (excludedRoots.some((root) => isInside(root, path))) {
        skipped.set(path, { path, reason: "owl_managed_path" });
      } else if (registeredProjectPaths.some((root) => isInside(root, path))) {
        skipped.set(path, { path, reason: "inside_registered_project" });
      } else {
        directories.add(dirname(path));
      }
    }
  }
  return { directories: [...directories], skipped: [...skipped.values()] };
}

export async function detectNewRepositories(
  deps: NewRepositoryDetectionDependencies,
  input: NewRepositoryDetectionInput,
): Promise<NewRepositoryDetection> {
  const collected = collectCandidatePaths(input.reports, input.excludedRoots, input.registeredProjectPaths);
  const skipped: SkippedRepositoryPath[] = [...collected.skipped];
  const repositories: NewRepositoryCandidate[] = [];
  const seenRoots: string[] = [];
  let startedAt: number | null | undefined;
  for (const directory of collected.directories) {
    if (seenRoots.some((root) => isInside(root, directory))) continue;
    let inspection: RepositoryRootInspection;
    try {
      inspection = await deps.inspect(directory);
    } catch {
      skipped.push({ path: directory, reason: "not_repository" });
      continue;
    }
    if (inspection.kind !== "repository") {
      skipped.push({ path: directory, reason: inspection.kind });
      continue;
    }
    const root = inspection.root;
    if (seenRoots.includes(root)) continue;
    seenRoots.push(root);
    if (input.excludedRoots.some((excluded) => isInside(excluded, root))) {
      skipped.push({ path: root, reason: "owl_managed_path" });
    } else if (input.registeredProjectPaths.some((registered) => isInside(registered, root))) {
      skipped.push({ path: root, reason: "already_registered" });
    } else if (inspection.created_by_work !== input.workId) {
      skipped.push({ path: root, reason: "not_created_by_work" });
    } else {
      startedAt ??= input.workStartedAtMs();
      let birthtime = Number.NaN;
      try {
        birthtime = await deps.birthtimeMs(root);
      } catch {
        // Treated as unavailable below.
      }
      if (startedAt === null || !(birthtime > 0)) skipped.push({ path: root, reason: "birthtime_unavailable" });
      else if (birthtime <= startedAt) skipped.push({ path: root, reason: "existed_before_work" });
      else repositories.push({ canonical_path: root, base_branch: inspection.base_branch, name: basename(root) });
    }
  }
  return { repositories, skipped };
}
