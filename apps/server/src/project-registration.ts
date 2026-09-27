import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const execFileAsync = promisify(execFile);
const MAX_PREVIEW_FILES = 2_000;
const DEFAULT_EXCLUDES = [
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
  "credentials.json",
  "service-account*.json",
  "secrets.json",
  "node_modules/",
  ".next/",
  "dist/",
  "build/",
  "coverage/",
  "vendor/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".DS_Store",
] as const;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
]);

export type ProjectFolderInspection =
  | { readonly kind: "missing"; readonly path: string }
  | { readonly kind: "not_directory"; readonly path: string }
  | { readonly kind: "not_git"; readonly canonical_path: string; readonly initial_files: readonly string[]; readonly excluded_files: readonly string[]; readonly total_files: number; readonly truncated: boolean }
  | { readonly kind: "git_ready"; readonly canonical_path: string; readonly base_branch: string; readonly has_uncommitted_changes: boolean; readonly uncommitted_file_count: number }
  | { readonly kind: "git_needs_initial_commit"; readonly canonical_path: string; readonly current_branch: string; readonly initial_files: readonly string[]; readonly excluded_files: readonly string[]; readonly total_files: number; readonly truncated: boolean };

export interface ProjectRepositorySetup {
  readonly canonical_path: string;
  readonly base_branch: string;
  readonly created_directory?: boolean;
}

export interface ProjectFolderBrowserResult {
  readonly current_path: string;
  readonly parent_path: string | null;
  readonly folders: readonly { name: string; path: string }[];
}

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

async function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

export async function browseProjectFolders(requestedPath?: string): Promise<ProjectFolderBrowserResult> {
  const home = await realpath(homedir());
  const candidate = requestedPath?.trim() || home;
  if (!isAbsolute(candidate)) throw new Error("Choose a folder under your home folder.");
  const current = await realpath(candidate);
  const fromHome = relative(home, current);
  if (fromHome === ".." || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) {
    throw new Error("The folder picker can only browse folders under your home folder.");
  }
  const info = await lstat(current);
  if (!info.isDirectory()) throw new Error("The selected location is not a folder.");
  const entries = await readdir(current, { withFileTypes: true });
  const folders: Array<{ name: string; path: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = resolve(current, entry.name);
    folders.push({ name: entry.name, path });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  const parent = current === home ? null : dirname(current);
  return { current_path: current, parent_path: parent, folders };
}

function normalizedGitPath(value: string): string {
  return resolve(value.trim());
}

function isSensitivePath(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (name === ".env.example" || name === ".env.sample" || name === ".env.template") return false;
  return name === ".env" || name.startsWith(".env.") ||
    /\.(?:pem|key|p12|pfx)$/u.test(name) ||
    /^id_(?:rsa|ed25519)/u.test(name) ||
    name === "credentials.json" || /^service-account.*\.json$/u.test(name) || name === "secrets.json";
}

async function initialFilePreview(root: string): Promise<{ initial_files: string[]; excluded_files: string[]; total_files: number; truncated: boolean }> {
  const initialFiles: string[] = [];
  const excludedFiles: string[] = [];
  let totalFiles = 0;
  let truncated = false;

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        totalFiles += 1;
        if (initialFiles.length < MAX_PREVIEW_FILES) initialFiles.push(relativePath);
        else truncated = true;
        continue;
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          totalFiles += 1;
          if (excludedFiles.length < MAX_PREVIEW_FILES) excludedFiles.push(`${relativePath}/ (generated or dependency folder)`);
          continue;
        }
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      totalFiles += 1;
      if (isSensitivePath(relativePath)) {
        if (excludedFiles.length < MAX_PREVIEW_FILES) excludedFiles.push(`${relativePath} (sensitive-file rule)`);
        continue;
      }
      if (initialFiles.length < MAX_PREVIEW_FILES) initialFiles.push(relativePath);
      else truncated = true;
    }
  }

  await visit(root);
  if (totalFiles > MAX_PREVIEW_FILES * 2) truncated = true;
  return { initial_files: initialFiles, excluded_files: excludedFiles, total_files: totalFiles, truncated };
}

async function currentBranch(root: string): Promise<string> {
  const result = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.ok ? result.stdout.trim() : "";
}

async function chooseBaseBranch(root: string): Promise<string | null> {
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
  const active = await currentBranch(root);
  if (active) return active;
  const branches = await git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return branches.ok ? branches.stdout.trim().split("\n").find(Boolean) ?? null : null;
}

export async function inspectProjectFolder(inputPath: string): Promise<ProjectFolderInspection> {
  if (!isAbsolute(inputPath.trim())) throw new Error("Project folder path must be absolute.");
  const path = normalizedGitPath(inputPath);

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing", path };
    throw error;
  }
  const info = await lstat(canonicalPath);
  if (!info.isDirectory()) return { kind: "not_directory", path: canonicalPath };

  const rootResult = await git(canonicalPath, ["rev-parse", "--show-toplevel"]);
  if (!rootResult.ok) {
    const preview = await initialFilePreview(canonicalPath);
    return { kind: "not_git", canonical_path: canonicalPath, ...preview };
  }

  const root = await realpath(rootResult.stdout.trim());
  const isBare = await git(root, ["rev-parse", "--is-bare-repository"]);
  if (isBare.ok && isBare.stdout.trim() === "true") {
    throw new Error("A bare Git repository cannot be used as a project folder. Choose a working folder instead.");
  }
  const head = await git(root, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) {
    const preview = await initialFilePreview(root);
    return { kind: "git_needs_initial_commit", canonical_path: root, current_branch: await currentBranch(root) || "main", ...preview };
  }

  const baseBranch = await chooseBaseBranch(root);
  if (!baseBranch) {
    throw new Error("Git repository has a commit but no branch can be selected as its starting point.");
  }
  const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const changed = status.ok ? status.stdout.split(/\r?\n/u).filter(Boolean) : [];
  return {
    kind: "git_ready",
    canonical_path: root,
    base_branch: baseBranch,
    has_uncommitted_changes: changed.length > 0,
    uncommitted_file_count: changed.length,
  };
}

async function installLocalExcludes(root: string): Promise<void> {
  const excludePath = resolve(root, ".git", "info", "exclude");
  const existingStat = await lstat(excludePath).catch(() => null);
  if (existingStat?.isSymbolicLink() || (existingStat && !existingStat.isFile())) {
    throw new Error("The project's local Git exclude file is not a regular file. Review it before continuing.");
  }
  const existing = existingStat ? await readFile(excludePath, "utf8") : "";
  const additions = DEFAULT_EXCLUDES.filter((pattern) => !existing.split(/\r?\n/u).includes(pattern));
  if (additions.length > 0) {
    await writeFile(excludePath, `${existing.trimEnd()}${existing.trim().length > 0 ? "\n" : ""}# Owl-Agent local safety exclusions\n${additions.join("\n")}\n`, "utf8");
  }
}

async function commitInitialSnapshot(root: string, branch: string): Promise<void> {
  await installLocalExcludes(root);
  const added = await git(root, ["add", "--all"]);
  if (!added.ok) throw new Error(added.stderr.trim() || "Could not prepare the initial project snapshot.");
  const committed = await git(root, ["-c", "user.name=Owl Agent", "-c", "user.email=owl-agent@localhost", "commit", "--allow-empty", "-m", "Initialize Owl project"]);
  if (!committed.ok) throw new Error(committed.stderr.trim() || "Could not create the initial project snapshot.");
  const branchNow = await currentBranch(root);
  if (branchNow !== branch) throw new Error("The project branch changed during Git setup. Inspect the repository and retry.");
}

export async function initializeNewProjectFolder(inputPath: string): Promise<ProjectRepositorySetup> {
  const target = normalizedGitPath(inputPath);
  if (!isAbsolute(target) || target === "/" || basename(target).length === 0) {
    throw new Error("Choose a valid, absolute destination folder for the new project.");
  }
  const parentPath = await realpath(dirname(target));
  const parentInfo = await lstat(parentPath);
  if (!parentInfo.isDirectory()) throw new Error("The parent location for the new project is not a folder.");

  try {
    await lstat(target);
    throw new Error("The selected destination already exists. Choose an empty new location or register it as an existing project.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(target);
  const canonicalPath = await realpath(target);
  try {
    const initialized = await git(canonicalPath, ["init", "--initial-branch=main"]);
    if (!initialized.ok) throw new Error(initialized.stderr.trim() || "Git could not be initialized.");
    await commitInitialSnapshot(canonicalPath, "main");
    return { canonical_path: canonicalPath, base_branch: "main", created_directory: true };
  } catch (error) {
    // Remove only the .git directory created in the new empty destination. If
    // another process added files meanwhile, leave the folder intact.
    await rm(resolve(canonicalPath, ".git"), { recursive: true, force: true }).catch(() => undefined);
    const remaining = await readdir(canonicalPath).catch(() => ["unknown"]);
    if (remaining.length === 0) await rmdir(canonicalPath).catch(() => undefined);
    throw error;
  }
}

export async function initializeExistingProjectFolder(inputPath: string): Promise<ProjectRepositorySetup> {
  const before = await inspectProjectFolder(inputPath);
  if (before.kind === "missing" || before.kind === "not_directory") {
    throw new Error("The selected existing project folder is not available.");
  }
  if (before.kind === "git_ready") {
    return { canonical_path: before.canonical_path, base_branch: before.base_branch };
  }

  const root = before.canonical_path;
  let branch = before.kind === "git_needs_initial_commit" ? before.current_branch : "main";
  if (before.kind === "not_git") {
    const initialized = await git(root, ["init", "--initial-branch=main"]);
    if (!initialized.ok) throw new Error(initialized.stderr.trim() || "Git could not be initialized for this folder.");
  } else {
    branch = await currentBranch(root) || "main";
  }
  await commitInitialSnapshot(root, branch);
  const result = await inspectProjectFolder(root);
  if (result.kind !== "git_ready") throw new Error("Git was prepared, but the project is not ready yet.");
  return { canonical_path: result.canonical_path, base_branch: result.base_branch };
}
