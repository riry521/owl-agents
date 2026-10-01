import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, mkdirSync, writeFileSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  AdvisorWorkspaceInspection,
  AdvisorWorkspaceInspectionRequest,
  AdvisorWorkspaceRequest,
  AdvisorWorkspaceSweepResult,
  CoreDatabase,
  GitBranchCleanupResult,
  GitGateway,
  GitIntegrationResult,
  GitOperationRequest,
  GitOperationResult,
  GitPushRequest,
  GitPushResult,
  TaskWorktreeDiscardResult,
  GitWorkMergeResult,
  VerificationCommand,
  WorktreeCleanupResult,
  WorkspaceEntry,
} from "./types";
import { GitLanes } from "./git-lane.js";
import { basePushArgs, classifyPushFailure, parsePushPorcelain, PUSH_HOOK_WARNING_MARKER, redactCredentials, safeRemoteName } from "./git-push.js";
import { OWL_GIT_EXCLUDES_CONTENT } from "./owl-git-excludes.js";
import { OWL_INSTANCE_ID_ENV, reapProcessGroup, resolveInstanceId } from "@owl/shared";
import { workVerificationMarker } from "./workspace-process-sweeper.js";
import { safeSegment, WorkspaceLayout } from "./workspace-layout.js";
import { commitExcludePathspecs } from "./workspace-tooling.js";

export { safeSegment } from "./workspace-layout.js";

const execFileAsync = promisify(execFile);

/** Lanes shared by every gateway in this process, keyed by repository path. */
const processGitLanes = new GitLanes();

interface ProjectRow {
  readonly canonical_path: string;
  readonly base_branch: string;
  readonly allowed_roots_json: string;
  readonly auto_push?: number;
  readonly verification_plan_json?: string;
  readonly worktree_tool_state_json?: string;
}

interface WorkMergeContext {
  readonly worktree_path: string;
  readonly base_branch: string;
  readonly work_branch: string;
}

type PreparedWorkMerge =
  | { readonly kind: "result"; readonly result: GitWorkMergeResult }
  | {
      readonly kind: "prepared";
      readonly context: WorkMergeContext;
      readonly plan: readonly VerificationCommand[];
      readonly old_base_commit: string;
      readonly work_commit: string;
      readonly merge_commit: string;
    };

/** Entries of `git worktree list --porcelain`: path and checked-out branch (null when detached or bare). */
function parseWorktrees(porcelain: string): Array<{ path: string; branch: string | null }> {
  const entries: Array<{ path: string; branch: string | null }> = [];
  for (const block of porcelain.split(/\n\s*\n/u)) {
    const path = block.match(/^worktree (.+)$/mu)?.[1];
    if (!path) continue;
    entries.push({ path: resolve(path), branch: block.match(/^branch refs\/heads\/(.+)$/mu)?.[1] ?? null });
  }
  return entries;
}

interface VerificationCommandResult {
  readonly passed: boolean;
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timed_out: boolean;
  readonly error?: string;
}

function inside(base: string, candidate: string): boolean {
  const rel = relative(resolve(base), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function branchName(prefix: string, workId: string, taskId: string | null): string {
  return `owl/${prefix}/${safeSegment(workId)}/${safeSegment(taskId ?? "work")}`;
}

interface WorkDeletionCandidate {
  readonly path: string;
  readonly name: string;
  readonly integration: boolean;
  readonly task_id: string | null;
}

interface WorkspaceFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface WorkspaceScan {
  readonly paths: readonly string[];
  readonly files: readonly WorkspaceFile[];
  readonly ignored_paths: readonly string[];
}

async function scanWorkspace(root: string): Promise<WorkspaceScan> {
  const paths: string[] = [];
  const files: WorkspaceFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const absolute = resolve(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Symbolic link cannot be verified for deletion: ${absolute}`);
      const path = relative(root, absolute).split("\\").join("/");
      paths.push(path);
      if (info.isDirectory()) {
        await visit(absolute);
      } else if (info.isFile()) {
        const contents = await readFile(absolute);
        files.push({ path, sha256: createHash("sha256").update(contents).digest("hex"), bytes: contents.byteLength });
      } else {
        throw new Error(`Unsupported workspace entry cannot be verified: ${absolute}`);
      }
    }
  };
  await visit(root);
  paths.sort();
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { paths, files, ignored_paths: [] };
}

/** True when a directory holds anything other than (nested) empty directories. */
async function holdsContent(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => null);
  if (!entries) return true;
  for (const entry of entries) {
    if (!entry.isDirectory() || await holdsContent(join(directory, entry.name))) return true;
  }
  return false;
}

/** Ignored paths that hold something to lose; an empty ignored directory is not one of them. */
async function ignoredContent(root: string, paths: readonly string[]): Promise<string[]> {
  const kept: string[] = [];
  for (const path of paths) {
    const info = await lstat(join(root, path)).catch(() => null);
    if (info?.isDirectory() && !await holdsContent(join(root, path))) continue;
    kept.push(path);
  }
  return kept;
}

function ignoredWorktree(path: string, ignoredPaths: readonly string[]): { path: string; ignored_count: number; ignored_paths: string[] } {
  const paths = [...new Set(ignoredPaths)].sort();
  return { path, ignored_count: paths.length, ignored_paths: paths.slice(0, 10) };
}

function cleanupFailure(path: string, stage: string, error: unknown): WorktreeCleanupResult {
  return {
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    details: { path, stage },
  };
}

function advisorBranchFor(conversationId: string): string {
  return `owl/advisor/${safeSegment(conversationId)}`;
}

/**
 * Git operations that touch a repository's index, refs or worktree registry
 * run on that repository's lane (keyed by the Project's canonical path, or the
 * Owl root when no Project is attached), so they never interleave.
 */
export class GitWorktreeGateway implements GitGateway {
  public constructor(
    private readonly db: CoreDatabase,
    private readonly owlRoot: string,
    private readonly lanes: GitLanes = processGitLanes,
    private readonly dataDir: string = join(owlRoot, "data"),
    private readonly layout: WorkspaceLayout = WorkspaceLayout.legacyOnly(owlRoot),
  ) {
    this.excludesFile = writeOwlExcludesFile(dataDir);
  }

  /** Owl's own exclude list, passed to every isolated git command. */
  private readonly excludesFile: string;

  private removalHook: ((path: string) => Promise<void>) | null = null;

  private readonly verifyingWorks = new Set<string>();

  /** Works whose merge verification commands are running right now. */
  public verifyingWorkIds(): readonly string[] {
    return [...this.verifyingWorks];
  }

  /** Registers work to run before a Task or Work worktree directory is removed. */
  public onBeforeWorktreeRemoval(hook: ((path: string) => Promise<void>) | null): void {
    this.removalHook = hook;
  }

  private async beforeRemoval(path: string): Promise<void> {
    if (this.removalHook === null) return;
    try {
      await this.removalHook(path);
    } catch (error) {
      console.warn(`[owl-core] Pre-removal workspace process sweep failed for ${path}`, error);
    }
  }

  public async prepareWorktree(request: GitOperationRequest): Promise<GitOperationResult> {
    const project = this.projectFor(request.work_id);
    const worktreePath = this.layout.taskPath(request.work_id, request.task_id ?? "manager");
    if (!project) {
      await mkdir(worktreePath, { recursive: true });
      return { ok: true, exit_code: 0, recorded: false, worktree_path: worktreePath, message: "No Project is attached; using an isolated workspace." };
    }
    const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
    return this.inLane(canonical, () => this.prepareProjectWorktreeNow(request, project, canonical, worktreePath));
  }

  private async prepareProjectWorktreeNow(
    request: GitOperationRequest,
    project: ProjectRow,
    canonical: string,
    worktreePath: string,
  ): Promise<GitOperationResult> {
    const taskBranch = request.task_branch ?? branchName("task", request.work_id, request.task_id);
    const workBranch = request.work_branch ?? branchName("work", request.work_id, null);
    const taskId = request.task_id ?? "worktree";
    const existingPath = await lstat(worktreePath).catch(() => null);
    if (existingPath) {
      const listed = await this.git(canonical, ["worktree", "list", "--porcelain"]);
      const registered = listed.ok && listed.message.split("\n").some((line) => line.trim() === `worktree ${worktreePath}`);
      if (!registered) {
        return { ok: false, exit_code: 1, recorded: false, worktree_path: worktreePath, message: "The Task worktree path exists but is not registered with Git." };
      }
      // The worktree survived a restart (or a Task returned to `ready`), so it
      // may have fallen behind other Tasks integrated into the Work branch in
      // the meantime; catch it up before it is handed back to a Worker.
      const synced = await this.syncTaskWorktreeWithWork(worktreePath, workBranch, taskId, request.work_id);
      if (!synced.ok) return synced;
      return { ok: true, exit_code: 0, recorded: false, worktree_path: worktreePath, message: "Reusing the existing Task worktree." };
    }
    await mkdir(resolve(worktreePath, ".."), { recursive: true });
    const branchExists = await this.git(canonical, ["show-ref", "--verify", "--quiet", `refs/heads/${taskBranch}`]);
    // A new Task starts from the Work branch, which already holds every Task
    // merged so far (e.g. the dependencies this Task was waiting for). Starting
    // from base_branch would hide that work and make the later merge conflict.
    const workBranchExists = branchExists.exit_code === 0
      ? null
      : await this.git(canonical, ["show-ref", "--verify", "--quiet", `refs/heads/${workBranch}`]);
    const startPoint = workBranchExists?.exit_code === 0 ? workBranch : project.base_branch;
    const result = branchExists.exit_code === 0
      ? await this.git(canonical, ["worktree", "add", worktreePath, taskBranch])
      : await this.git(canonical, ["worktree", "add", "-b", taskBranch, worktreePath, startPoint]);
    if (result.exit_code !== 0) {
      return { ok: false, exit_code: result.exit_code, recorded: false, worktree_path: worktreePath, message: result.message };
    }
    if (branchExists.exit_code === 0) {
      // The Task branch already existed (a leftover from an earlier attempt);
      // it may predate Tasks that have since been integrated into the Work
      // branch, so it needs the same catch-up as a reused worktree.
      const synced = await this.syncTaskWorktreeWithWork(worktreePath, workBranch, taskId, request.work_id);
      if (!synced.ok) return synced;
    }
    return { ok: true, exit_code: 0, recorded: false, created: true, worktree_path: worktreePath, message: `Prepared ${taskBranch}.` };
  }

  /**
   * Bring a Task worktree up to date with the Work branch's current tip,
   * checkpointing any uncommitted edits first so nothing is lost. A conflict
   * is aborted immediately, leaving no MERGE_HEAD behind, and reported as
   * `work_sync_conflict` so only that Task fails for Manager replanning
   * instead of repeating the same conflict.
   */
  private async syncTaskWorktreeWithWork(worktreePath: string, workBranch: string, taskId: string, workId: string): Promise<GitOperationResult> {
    const workBranchExists = await this.git(worktreePath, ["show-ref", "--verify", "--quiet", `refs/heads/${workBranch}`]);
    if (workBranchExists.exit_code !== 0) {
      return { ok: true, exit_code: 0, recorded: false, worktree_path: worktreePath, message: "No Work branch to sync with yet." };
    }
    const upToDate = await this.git(worktreePath, ["merge-base", "--is-ancestor", workBranch, "HEAD"]);
    if (upToDate.ok) {
      return { ok: true, exit_code: 0, recorded: false, worktree_path: worktreePath, message: "Task worktree already includes the Work branch." };
    }
    const committed = await this.commitTaskChanges(worktreePath, workId, taskId, "checkpoint");
    if (!committed.ok) return committed;
    const merge = await this.git(worktreePath, [...(await this.ownerIdentityArgs(worktreePath)), "merge", "--no-edit", workBranch]);
    if (merge.ok) {
      return { ok: true, exit_code: 0, recorded: false, worktree_path: worktreePath, message: merge.message };
    }
    const aborted = await this.git(worktreePath, ["merge", "--abort"]);
    if (!aborted.ok) {
      return { ok: false, exit_code: 1, recorded: false, worktree_path: worktreePath, message: `Task worktree conflicts with the Work branch and the merge could not be aborted: ${merge.message}` };
    }
    return { ok: false, exit_code: 1, recorded: false, worktree_path: worktreePath, failure_kind: "work_sync_conflict", message: `Task worktree conflicts with the Work branch: ${merge.message}` };
  }

  /**
   * Prepare or reuse a conversation-scoped Advisor worktree. Projects
   * without Git keep using their registered directory directly. When there
   * is no linked Project, Owl itself is the source repository if it is Git
   * managed; otherwise the existing Owl root fallback is used directly. A
   * workspace this call created is not removed once the conversation stops
   * being the active session's - sweepAdvisorWorkspaces() reclaims it later
   * - so a conversation whose workspace was swept gets a fresh one here,
   * branched again from base.
   */
  public async prepareAdvisorWorkspace(request: AdvisorWorkspaceRequest): Promise<GitOperationResult> {
    const conversation = this.db.get<{ work_id: string | null }>(
      "SELECT work_id FROM conversations WHERE id = ?",
      request.conversation_id,
    );
    if (!conversation) {
      return { ok: false, exit_code: 1, recorded: false, message: `Conversation ${request.conversation_id} was not found.` };
    }

    const project = conversation.work_id ? this.projectFor(conversation.work_id) : undefined;
    const sourceDirectory = project
      ? await this.validProjectPath(project.canonical_path, project.allowed_roots_json)
      : await realpath(this.owlRoot);
    return this.inLane(sourceDirectory, () => this.prepareAdvisorWorkspaceNow(request, project, sourceDirectory));
  }

  private async prepareAdvisorWorkspaceNow(
    request: AdvisorWorkspaceRequest,
    project: ProjectRow | undefined,
    sourceDirectory: string,
  ): Promise<GitOperationResult> {
    const repositoryResult = await this.git(sourceDirectory, ["rev-parse", "--show-toplevel"]);
    if (!repositoryResult.ok) {
      return {
        ok: true,
        exit_code: 0,
        recorded: false,
        worktree_path: sourceDirectory,
        message: "Advisor is using the Project directory directly because it is not a Git repository.",
      };
    }

    const repositoryRoot = resolve(repositoryResult.message.trim().split(/\r?\n/u)[0] ?? sourceDirectory);
    const containerRoot = this.layout.rootOf(this.layout.advisorDir(request.conversation_id)) ?? this.layout.root;
    await mkdir(containerRoot, { recursive: true });
    const worktreeRoot = await realpath(containerRoot);
    const worktreePath = resolve(worktreeRoot, "advisor", safeSegment(request.conversation_id));
    const branch = advisorBranchFor(request.conversation_id);
    const existingPath = await lstat(worktreePath).catch(() => null);
    if (existingPath) {
      const listed = await this.git(repositoryRoot, ["worktree", "list", "--porcelain"]);
      const registered = listed.ok && listed.message.split(/\r?\n/u).some((line) =>
        line.startsWith("worktree ") && resolve(line.slice("worktree ".length)) === worktreePath,
      );
      if (registered) {
        return { ok: true, exit_code: 0, recorded: false, worktree_path: worktreePath, message: `Reusing Advisor branch ${branch}.` };
      }
      const emptyDirectory = existingPath.isDirectory() && !existingPath.isSymbolicLink()
        && await rmdir(worktreePath).then(() => true, () => false);
      if (!emptyDirectory) {
        return {
          ok: false,
          exit_code: 1,
          recorded: false,
          worktree_path: worktreePath,
          message: "The Advisor workspace path exists but is not registered with Git; it was left untouched.",
        };
      }
    }

    await mkdir(resolve(worktreePath, ".."), { recursive: true });
    const baseBranch = project?.base_branch ?? await this.currentBranchOrHead(repositoryRoot);
    const branchExists = await this.git(repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    const result = branchExists.exit_code === 0
      ? await this.git(repositoryRoot, ["worktree", "add", worktreePath, branch])
      : await this.git(repositoryRoot, ["worktree", "add", "-b", branch, worktreePath, baseBranch]);
    return {
      ok: result.ok,
      exit_code: result.exit_code,
      recorded: false,
      worktree_path: worktreePath,
      message: result.ok ? `Prepared Advisor branch ${branch}.` : result.message,
    };
  }

  public async inspectAdvisorWorkspace(
    request: AdvisorWorkspaceInspectionRequest,
  ): Promise<AdvisorWorkspaceInspection> {
    const containerRoot = this.layout.rootOf(this.layout.advisorDir(request.conversation_id)) ?? this.layout.root;
    let worktreeRoot: string;
    try {
      worktreeRoot = await realpath(containerRoot);
    } catch (error) {
      return { ok: false, dirty: false, message: error instanceof Error ? error.message : "Owl root could not be resolved." };
    }
    const expectedPath = resolve(worktreeRoot, "advisor", safeSegment(request.conversation_id));
    if (resolve(request.workspace_path) !== expectedPath || !inside(worktreeRoot, expectedPath)) {
      return { ok: false, dirty: false, message: "The requested path is not this conversation's Advisor workspace." };
    }

    const conversation = this.db.get<{ work_id: string | null }>(
      "SELECT work_id FROM conversations WHERE id = ?",
      request.conversation_id,
    );
    if (!conversation) return { ok: false, dirty: false, message: "Conversation was not found." };
    const project = conversation.work_id ? this.projectFor(conversation.work_id) : undefined;
    let sourceDirectory: string;
    try {
      sourceDirectory = project
        ? await this.validProjectPath(project.canonical_path, project.allowed_roots_json)
        : await realpath(this.owlRoot);
    } catch (error) {
      return { ok: false, dirty: false, message: error instanceof Error ? error.message : "Project path could not be resolved." };
    }
    return this.inLane(sourceDirectory, () => this.inspectAdvisorWorkspaceNow(project, sourceDirectory, expectedPath));
  }

  private async inspectAdvisorWorkspaceNow(
    project: ProjectRow | undefined,
    sourceDirectory: string,
    expectedPath: string,
  ): Promise<AdvisorWorkspaceInspection> {
    const repositoryResult = await this.git(sourceDirectory, ["rev-parse", "--show-toplevel"]);
    if (!repositoryResult.ok) return { ok: true, dirty: false, message: "The Project is not a Git worktree." };
    const repositoryRoot = resolve(repositoryResult.message.trim().split(/\r?\n/u)[0] ?? sourceDirectory);
    const listed = await this.git(repositoryRoot, ["worktree", "list", "--porcelain"]);
    const registered = listed.ok && listed.message.split(/\r?\n/u).some((line) =>
      line.startsWith("worktree ") && resolve(line.slice("worktree ".length)) === expectedPath,
    );
    if (!registered) return { ok: false, dirty: false, message: "Advisor worktree is no longer registered with Git." };

    const status = await this.git(expectedPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (!status.ok) return { ok: false, dirty: false, message: status.message };
    const baseBranch = project?.base_branch ?? await this.currentBranchOrHead(repositoryRoot);
    const commitsAhead = await this.git(expectedPath, ["rev-list", "--count", `${baseBranch}..HEAD`]);
    if (!commitsAhead.ok) return { ok: false, dirty: false, message: commitsAhead.message };
    return {
      ok: true,
      dirty: (status.message !== "git operation completed" && status.message.trim().length > 0) || Number(commitsAhead.message.trim()) > 0,
      message: status.message === "git operation completed" ? `${commitsAhead.message.trim()} commits ahead of ${baseBranch}` : status.message,
    };
  }

  /**
   * Reclaim Advisor worktrees/branches left behind by a replaced or
   * conversation-switched session (see prepareAdvisorWorkspace). Every entry
   * under `.owl-workspaces/advisor` whose realpath is not some non-ended
   * session's workspace_path is a candidate: a registered worktree is
   * removed (with its branch) once it is clean and fully merged into its
   * base, and a plain leftover directory is removed once it is empty.
   * Anything else is kept and warned about. Orphaned, already-merged
   * `owl/advisor/*` branches with no worktree left are then deleted from Owl's
   * own repository and every registered Git Project's repository. Git
   * operations run on each repository's lane so they never interleave with a
   * worktree being created, and liveness is re-checked under that lane right
   * before a removal, so a session concurrently starting for the same
   * conversation is never undercut. Workspaces and branches of conversations
   * this database does not know belong to another Owl instance sharing the
   * root and are never touched.
   */
  public async sweepAdvisorWorkspaces(): Promise<AdvisorWorkspaceSweepResult> {
    const removedWorkspaces: string[] = [];
    const removedBranches: string[] = [];

    for (const root of this.layout.roots()) {
      const advisorRoot = resolve(root, "advisor");
      const entries = await readdir(advisorRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        await this.sweepAdvisorEntry(resolve(advisorRoot, entry.name), entry.name, removedWorkspaces);
      }
    }

    for (const repositoryRoot of await this.advisorBranchRepositories()) {
      await this.sweepOrphanAdvisorBranches(repositoryRoot, removedBranches);
    }

    return { removed_workspaces: removedWorkspaces, removed_branches: removedBranches };
  }

  private async sweepAdvisorEntry(entryPath: string, conversationId: string, removed: string[]): Promise<void> {
    const real = await realpath(entryPath).catch(() => null);
    if (real === null) return; // already gone
    if (!this.isKnownAdvisorConversation(conversationId)) return;
    if (await this.isLiveAdvisorWorkspace(real)) return;

    const registration = await this.registeredAdvisorWorktree(entryPath);
    if (registration === null) {
      if (await this.sweepStrayAdvisorDirectory(entryPath)) removed.push(entryPath);
      return;
    }
    const wasRemoved = await this.inLane(registration.repositoryRoot, () =>
      this.sweepAdvisorWorktreeNow(entryPath, conversationId, registration.repositoryRoot),
    );
    if (wasRemoved) removed.push(entryPath);
  }

  /** Whether `entryPath` is registered as a Git worktree, and the repository it belongs to. */
  private async registeredAdvisorWorktree(entryPath: string): Promise<{ readonly repositoryRoot: string } | null> {
    const commonDir = await this.git(entryPath, ["rev-parse", "--git-common-dir"]);
    if (!commonDir.ok) return null;
    const repositoryRoot = resolve(resolve(entryPath, commonDir.message.trim()), "..");
    const listed = await this.git(repositoryRoot, ["worktree", "list", "--porcelain"]);
    const registered = listed.ok && listed.message.split(/\r?\n/u).some((line) =>
      line.startsWith("worktree ") && resolve(line.slice("worktree ".length)) === resolve(entryPath),
    );
    return registered ? { repositoryRoot } : null;
  }

  /**
   * Remove one registered Advisor worktree and its branch, once it is clean
   * and its branch has nothing base does not already have. Liveness is
   * re-checked here, under the repository's lane, so a session that started
   * concurrently for this same conversation is never removed out from under it.
   */
  private async sweepAdvisorWorktreeNow(entryPath: string, conversationId: string, repositoryRoot: string): Promise<boolean> {
    const real = await realpath(entryPath).catch(() => null);
    if (real === null) return false;
    if (!this.isKnownAdvisorConversation(conversationId)) return false;
    if (await this.isLiveAdvisorWorkspace(real)) return false;

    const status = await this.git(entryPath, ["status", "--porcelain"]);
    if (!status.ok) {
      console.warn(`[owl-core] Advisor workspace sweep could not check ${entryPath} for uncommitted changes: ${status.message}`);
      return false;
    }
    if (status.message !== "git operation completed" && status.message.trim().length > 0) {
      console.warn(`[owl-core] Advisor workspace sweep is keeping ${entryPath}: it has uncommitted changes.`);
      return false;
    }

    const branch = advisorBranchFor(conversationId);
    const base = await this.resolveAdvisorBaseBranch(conversationId, repositoryRoot);
    const merged = await this.git(repositoryRoot, ["merge-base", "--is-ancestor", branch, base]);
    if (!merged.ok) {
      console.warn(`[owl-core] Advisor workspace sweep is keeping ${entryPath}: branch ${branch} has commits not in ${base}.`);
      return false;
    }

    const removal = await this.git(repositoryRoot, ["worktree", "remove", "--force", entryPath]);
    if (!removal.ok) {
      console.warn(`[owl-core] Advisor workspace sweep could not remove ${entryPath}: ${removal.message}`);
      return false;
    }
    await this.git(repositoryRoot, ["branch", "-D", branch]);
    return true;
  }

  /** A non-worktree leftover under `.owl-workspaces/advisor` is only ever removed when it is empty. */
  private async sweepStrayAdvisorDirectory(entryPath: string): Promise<boolean> {
    try {
      await rmdir(entryPath);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      if (code === "ENOTEMPTY") {
        console.warn(`[owl-core] Advisor workspace sweep is keeping ${entryPath}: it is not empty and is not a registered Git worktree.`);
        return false;
      }
      console.warn(`[owl-core] Advisor workspace sweep could not remove ${entryPath}`, error);
      return false;
    }
  }

  /** Every repository whose `owl/advisor/*` branches this sweep also cleans up: Owl's own (if Git managed) plus every registered Git Project. */
  private async advisorBranchRepositories(): Promise<readonly string[]> {
    const roots = new Set<string>();
    const owlRootReal = await realpath(this.owlRoot).catch(() => null);
    if (owlRootReal !== null) {
      const owlRepo = await this.git(owlRootReal, ["rev-parse", "--show-toplevel"]);
      if (owlRepo.ok) roots.add(resolve(owlRepo.message.trim().split(/\r?\n/u)[0] ?? owlRootReal));
    }
    for (const project of this.db.all<ProjectRow>("SELECT canonical_path, base_branch, allowed_roots_json FROM projects")) {
      let canonical: string;
      try {
        canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
      } catch {
        continue; // an unreachable/misconfigured Project is left for its own health checks
      }
      const repo = await this.git(canonical, ["rev-parse", "--show-toplevel"]);
      if (repo.ok) roots.add(resolve(repo.message.trim().split(/\r?\n/u)[0] ?? canonical));
    }
    return [...roots];
  }

  /** Delete this repository's merged, worktree-less `owl/advisor/*` branches that no live session owns. */
  private async sweepOrphanAdvisorBranches(repositoryRoot: string, removed: string[]): Promise<void> {
    await this.inLane(repositoryRoot, async () => {
      const refs = await this.git(repositoryRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/owl/advisor/"]);
      if (!refs.ok || refs.message === "git operation completed") return;
      const worktrees = await this.git(repositoryRoot, ["worktree", "list", "--porcelain"]);
      const worktreeBranches = new Set(
        (worktrees.ok ? worktrees.message.split(/\r?\n/u) : [])
          .filter((line) => line.startsWith("branch "))
          .map((line) => line.slice("branch ".length).replace(/^refs\/heads\//u, "")),
      );
      for (const branch of refs.message.split(/\r?\n/u).filter((line) => line.length > 0)) {
        if (worktreeBranches.has(branch)) continue; // still in use; the entry sweep owns it
        const conversationId = branch.slice("owl/advisor/".length);
        if (!this.isKnownAdvisorConversation(conversationId)) continue;
        if (this.isLiveAdvisorConversation(conversationId)) continue;
        const base = await this.resolveAdvisorBaseBranch(conversationId, repositoryRoot);
        const merged = await this.git(repositoryRoot, ["merge-base", "--is-ancestor", branch, base]);
        if (!merged.ok) continue; // unmerged; left for the owner to look at
        const deleted = await this.git(repositoryRoot, ["branch", "-D", branch]);
        if (deleted.ok) removed.push(branch);
      }
    });
  }

  /** Whether `realPath` is the workspace of some Advisor session that is not (yet) ended. */
  private async isLiveAdvisorWorkspace(realPath: string): Promise<boolean> {
    const rows = this.db.all<{ workspace_path: string | null }>(
      "SELECT workspace_path FROM advisor_sessions WHERE status != 'ended' AND workspace_path IS NOT NULL",
    );
    for (const row of rows) {
      if (!row.workspace_path) continue;
      const real = await realpath(row.workspace_path).catch(() => null);
      if (real === realPath) return true;
    }
    return false;
  }

  /** Whether this database has a conversation whose workspace segment is `conversationId`. */
  private isKnownAdvisorConversation(conversationId: string): boolean {
    const rows = this.db.all<{ id: string }>("SELECT id FROM conversations");
    return rows.some((row) => safeSegment(row.id) === conversationId);
  }

  /** Whether some not-(yet)-ended Advisor session belongs to this conversation. */
  private isLiveAdvisorConversation(conversationId: string): boolean {
    const rows = this.db.all<{ conversation_id: string }>("SELECT conversation_id FROM advisor_sessions WHERE status != 'ended'");
    return rows.some((row) => safeSegment(row.conversation_id) === conversationId);
  }

  /** Same base-branch resolution prepareAdvisorWorkspace uses: the Project's, or the source repository's current branch. */
  private async resolveAdvisorBaseBranch(conversationId: string, repositoryRoot: string): Promise<string> {
    const conversation = this.db.get<{ work_id: string | null }>(
      "SELECT work_id FROM conversations WHERE id = ?",
      conversationId,
    );
    const project = conversation?.work_id ? this.projectFor(conversation.work_id) : undefined;
    return project?.base_branch ?? await this.currentBranchOrHead(repositoryRoot);
  }

  /**
   * Commit the Task worktree and merge its branch into the Work branch in one
   * critical section of the repository lane. A clean merge removes the Task
   * worktree; a failed merge is aborted before the lane is released, so no
   * other operation ever sees the integration worktree mid-merge.
   */
  public async integrateTask(request: GitOperationRequest): Promise<GitIntegrationResult> {
    const project = this.projectFor(request.work_id);
    if (!project || !request.task_id) {
      return integrationFailure(1, "A Project and Task are required to merge a worktree.", true, null);
    }
    const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
    return this.inLane(canonical, () => this.integrateTaskNow(request, project, canonical));
  }

  private async integrateTaskNow(request: GitOperationRequest, project: ProjectRow, canonical: string): Promise<GitIntegrationResult> {
    const taskId = request.task_id as string;
    const taskBranch = request.task_branch ?? branchName("task", request.work_id, taskId);
    const workBranch = request.work_branch ?? branchName("work", request.work_id, null);
    const taskPath = this.layout.taskPath(request.work_id, taskId);
    if (request.worktree_path && resolve(request.worktree_path) !== taskPath) {
      return integrationFailure(1, "The requested Task worktree does not match the Work/Task workspace.", true, null);
    }

    // A Worker normally edits files without committing them. Commit only the
    // isolated Task worktree, never the user's canonical checkout, before the
    // branch is integrated. If the Worker already committed, status is clean
    // and the existing Task branch is used unchanged.
    const committed = await this.commitTaskChanges(taskPath, request.work_id, taskId);
    if (!committed.ok) {
      const stderrTail = committed.stderr_tail?.trim() || committed.message;
      return {
        ...integrationFailure(
          committed.exit_code,
          `could not commit the Task's changes: ${stderrTail}`,
          true,
          null,
        ),
        failure_kind: "commit_failure",
        stderr_tail: committed.stderr_tail,
      };
    }

    // Integrate through a dedicated Work worktree. Checking out the Work
    // branch in canonical_path would mutate the owner's checkout and would
    // fail or overwrite unrelated local changes.
    const integration = await this.ensureIntegrationWorktree(canonical, project.base_branch, this.layout.integrationPath(request.work_id), workBranch);
    if (!integration.ok || !integration.worktree_path) {
      return integrationFailure(integration.exit_code, integration.message, true, null);
    }
    const integrationPath = integration.worktree_path;

    // A merge left in progress by an interrupted process would make this
    // merge fail; abort it first. Ordinary uncommitted edits are left alone.
    if (await this.mergeInProgress(integrationPath)) {
      const leftover = await this.git(integrationPath, ["merge", "--abort"]);
      if (!leftover.ok) return integrationFailure(leftover.exit_code, leftover.message, false, leftover.message);
    }

    const merge = await this.git(integrationPath, [...(await this.ownerIdentityArgs(integrationPath)), "merge", "--no-edit", "--no-ff", taskBranch]);
    if (merge.ok) {
      const removal = await this.removeWorktreeNow(request);
      return {
        ok: removal.ok,
        exit_code: 0,
        recorded: false,
        merged: true,
        message: merge.message,
        aborted: false,
        abort_message: null,
        worktree_removed: removal.ok,
        removal_message: removal.message,
      };
    }
    if (!(await this.mergeInProgress(integrationPath))) {
      return integrationFailure(merge.exit_code, merge.message, true, "No merge was left in progress.");
    }
    const aborted = await this.git(integrationPath, ["merge", "--abort"]);
    return integrationFailure(merge.exit_code, merge.message, aborted.ok, aborted.message);
  }

  /**
   * Merge a Work into its Project base branch. The Work is squashed into one
   * commit built in the integration worktree on top of the latest base,
   * verified outside the repository lane, and the base is advanced
   * only if it has not moved and the Work is still running at the expected
   * state version.
   */
  public async mergeWorkIntoBase(request: { readonly work_id: string; readonly expected_state_version?: number }): Promise<GitWorkMergeResult> {
    try {
      const project = this.projectFor(request.work_id, true);
      if (!project) return workMergeError("A Project is required to merge a Work into its base branch.");
      const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
      const prepared = await this.inLane(canonical, () => this.prepareWorkMergeNow(request.work_id, project, canonical));
      if (prepared.kind === "result") return prepared.result;
      this.verifyingWorks.add(request.work_id);
      let verification: GitWorkMergeResult | null;
      try {
        verification = await this.runWorkVerification(request.work_id, prepared.plan, prepared.context);
      } finally {
        this.verifyingWorks.delete(request.work_id);
      }
      if (verification !== null) {
        await this.inLane(canonical, () => this.restoreIntegrationWorktreeNow(prepared.context.worktree_path, prepared.context.work_branch));
        return verification;
      }
      return await this.inLane(canonical, () => this.advanceBaseNow(request, prepared, canonical));
    } catch (error) {
      return workMergeError(error instanceof Error ? error.message : String(error));
    }
  }

  public async pushBaseBranch(request: GitPushRequest): Promise<GitPushResult> {
    let project: (ProjectRow & { readonly auto_push: number }) | undefined;
    try {
      const work = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", request.work_id);
      if (!work?.project_id) return { ok: true, exit_code: 0, recorded: false, kind: "skipped_disabled", message: "No Project is attached; automatic push is disabled." };
      project = this.db.get<ProjectRow & { readonly auto_push: number }>(
        "SELECT canonical_path, base_branch, allowed_roots_json, auto_push FROM projects WHERE id = ?",
        work.project_id,
      );
      if (!project || project.auto_push !== 1) return { ok: true, exit_code: 0, recorded: false, kind: "skipped_disabled", message: "Automatic push is disabled for this Project." };
      const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
      return await this.inLane(canonical, () => this.pushBaseBranchNow(project as ProjectRow & { readonly auto_push: number }, canonical));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false, exit_code: 1, recorded: false, kind: "failed", failure: "unknown", hook_side: null,
        remote: null, base_branch: project?.base_branch ?? null, remote_ref: null, base_commit: null,
        stderr_tail: "", message: `Could not push the Project base branch: ${message}`,
      };
    }
  }

  private async pushBaseBranchNow(project: ProjectRow & { readonly auto_push: number }, canonical: string): Promise<GitPushResult> {
    const base = project.base_branch;
    const failed = (
      message: string,
      details: { readonly remote?: string | null; readonly remote_ref?: string | null; readonly base_commit?: string | null } = {},
    ): GitPushResult => ({
      ok: false, exit_code: 1, recorded: false, kind: "failed", failure: "unknown", hook_side: null,
      remote: details.remote ?? null, base_branch: base, remote_ref: details.remote_ref ?? null,
      base_commit: details.base_commit ?? null, stderr_tail: "", message,
    });
    const baseRef = `refs/heads/${base}`;
    const validBase = await this.git(canonical, ["check-ref-format", baseRef]);
    if (!validBase.ok) return failed(`Could not resolve Project base branch ${base}: ${validBase.message}`);
    const baseTip = await this.git(canonical, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
    if (!baseTip.ok) return failed(`Could not resolve Project base branch ${base}: ${baseTip.message}`);
    const baseCommit = baseTip.message.trim();

    const upstream = await this.git(canonical, [
      "for-each-ref", "--format=%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)", baseRef,
    ]);
    if (!upstream.ok) return failed(`Could not resolve the upstream for ${base}: ${upstream.message}`, { base_commit: baseCommit });
    const [trackingRef = "", remoteValue = "", remoteRefValue = ""] = upstream.message.split("\0");
    const tracking = trackingRef.trim();
    const remote = remoteValue.trim();
    const remoteRef = remoteRefValue.trim();
    if (!tracking || !remote || remote === "." || !remoteRef.startsWith("refs/heads/")) {
      return { ok: true, exit_code: 0, recorded: false, kind: "skipped_no_upstream", base_branch: base, base_commit: baseCommit, message: `Base branch ${base} has no configured remote upstream.` };
    }
    if (!safeRemoteName(remote)) return failed("The configured upstream remote name is invalid.", { base_commit: baseCommit });
    const validRemoteRef = await this.git(canonical, ["check-ref-format", remoteRef]);
    if (!validRemoteRef.ok) return failed(`The configured remote branch for ${base} is invalid: ${validRemoteRef.message}`, { remote, remote_ref: remoteRef, base_commit: baseCommit });
    const previous = await this.git(canonical, ["rev-parse", "--verify", "--quiet", `${tracking}^{commit}`]);
    const previousTrackingCommit = previous.ok ? previous.message.trim() : null;

    try {
      const result = await execFileAsync("git", ["-C", canonical, ...basePushArgs(remote, base, remoteRef)], {
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      const stdout = String(result.stdout ?? "");
      const stderr = redactCredentials(String(result.stderr ?? ""));
      const porcelain = parsePushPorcelain(stdout);
      const warnings = stderr.split(/\r?\n/u)
        .filter((line) => line.startsWith(PUSH_HOOK_WARNING_MARKER))
        .map((line) => line.slice(0, 300));
      return {
        ok: true, exit_code: 0, recorded: false, kind: "pushed", remote, base_branch: base, remote_ref: remoteRef,
        previous_tracking_commit: previousTrackingCommit, new_remote_commit: baseCommit,
        up_to_date: porcelain.some((line) => line.flag === "="), hook_warnings: warnings,
        message: `Pushed ${base} to ${remote}/${remoteRef.slice("refs/heads/".length)}.${stderr ? ` ${stderr.slice(-500)}` : ""}`,
      };
    } catch (error) {
      const failure = error as {
        readonly code?: number | string;
        readonly killed?: boolean;
        readonly signal?: string | null;
        readonly stdout?: string | Buffer;
        readonly stderr?: string | Buffer;
      };
      const stdout = String(failure.stdout ?? "");
      const stderr = String(failure.stderr ?? "");
      const stderrTail = redactCredentials(stderr).slice(-2_000);
      const timedOut = failure.killed === true && failure.signal === "SIGTERM";
      const classification = classifyPushFailure({ stdout, stderr, timedOut, exitCode: typeof failure.code === "number" ? failure.code : 1 });
      return {
        ok: false, exit_code: typeof failure.code === "number" ? failure.code : 1, recorded: false, kind: "failed",
        failure: classification.failure, hook_side: classification.hook_side, remote, base_branch: base,
        remote_ref: remoteRef, base_commit: baseCommit, stderr_tail: stderrTail,
        message: `git push failed (${classification.failure})${stderrTail ? `: ${stderrTail.slice(-500)}` : ""}`,
      };
    }
  }

  public async abortIntegrationMerge(request: { readonly work_id: string }): Promise<GitOperationResult> {
    try {
      const project = this.projectFor(request.work_id);
      if (!project) return { ok: true, exit_code: 0, recorded: false, message: "No Project is attached; there is no integration merge to abort." };
      const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
      return await this.inLane(canonical, () => this.abortIntegrationMergeNow(request.work_id));
    } catch (error) {
      return { ok: false, exit_code: 1, recorded: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Abort a merge left in the integration worktree and, if an interrupted
   * base merge left it detached, return it to the Work branch.
   */
  private async abortIntegrationMergeNow(workId: string): Promise<GitOperationResult> {
    const path = this.layout.integrationPath(workId);
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!existing) return { ok: true, exit_code: 0, recorded: false, worktree_path: path, message: "Integration worktree was already absent." };
    if (await this.mergeInProgress(path)) {
      const aborted = await this.git(path, ["merge", "--abort"]);
      if (!aborted.ok) return aborted;
    }
    const branch = await this.git(path, ["symbolic-ref", "--quiet", "HEAD"]);
    if (branch.ok) return { ok: true, exit_code: 0, recorded: false, worktree_path: path, message: "No integration merge was in progress." };
    return this.restoreIntegrationWorktreeNow(path, branchName("work", workId, null));
  }

  /** Discard merge leftovers in the integration worktree and check out the Work branch again. */
  private async restoreIntegrationWorktreeNow(path: string, workBranch: string): Promise<GitOperationResult> {
    if (await this.mergeInProgress(path)) {
      const aborted = await this.git(path, ["merge", "--abort"]);
      if (!aborted.ok) return aborted;
    }
    const cleaned = await this.cleanIntegrationWorktree(path);
    if (!cleaned.ok) return cleaned;
    return this.git(path, ["checkout", "--force", workBranch]);
  }

  /** Reset tracked files and remove untracked and ignored files in the integration worktree. */
  private async cleanIntegrationWorktree(path: string): Promise<GitOperationResult> {
    const reset = await this.git(path, ["reset", "--hard", "HEAD"]);
    if (!reset.ok) return reset;
    return this.git(path, ["clean", "-fdx"]);
  }

  public async deleteMergedWorkBranches(request: { readonly work_id: string }): Promise<GitBranchCleanupResult> {
    try {
      const project = this.projectFor(request.work_id);
      if (!project) return { ok: true, exit_code: 0, recorded: false, message: "No Project is attached; there are no Project branches to clean up.", deleted_branches: {} };
      const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
      return await this.inLane(canonical, () => this.deleteMergedWorkBranchesNow(request.work_id, project, canonical));
    } catch (error) {
      return { ok: false, exit_code: 1, recorded: false, message: error instanceof Error ? error.message : String(error), deleted_branches: {} };
    }
  }

  /**
   * Once the Work branch is part of the base branch, delete the Work branch
   * and every Task branch of the Work, including Task branches that were
   * never integrated (failed or superseded attempts).
   */
  private async deleteMergedWorkBranchesNow(workId: string, project: ProjectRow, canonical: string): Promise<GitBranchCleanupResult> {
    const workBranch = branchName("work", workId, null);
    const baseRef = `refs/heads/${project.base_branch}`;
    const failure = (result: GitOperationResult, message: string): GitBranchCleanupResult =>
      ({ ok: false, exit_code: result.exit_code || 1, recorded: false, message, deleted_branches: {} });

    const tasksPrefix = `owl/task/${safeSegment(workId)}/`;
    const taskRefs = await this.git(canonical, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${tasksPrefix}`]);
    if (!taskRefs.ok) return failure(taskRefs, `Could not list Task branches for Work ${workId}: ${taskRefs.message}`);
    const taskBranches = taskRefs.message === "git operation completed"
      ? []
      : taskRefs.message.split("\n").filter((branch) => branch.startsWith(tasksPrefix));
    const workExists = await this.git(canonical, ["show-ref", "--verify", "--quiet", `refs/heads/${workBranch}`]);
    if (!workExists.ok && workExists.exit_code !== 1) return failure(workExists, `Could not inspect branch ${workBranch}: ${workExists.message}`);
    const branches = [...taskBranches, ...(workExists.ok ? [workBranch] : [])];
    if (branches.length === 0) {
      return { ok: true, exit_code: 0, recorded: false, message: "The Work branches were already absent.", deleted_branches: {} };
    }

    const worktrees = await this.git(canonical, ["worktree", "list", "--porcelain"]);
    if (!worktrees.ok) return failure(worktrees, worktrees.message);
    const checkedOut = parseWorktrees(worktrees.message).find((entry) => entry.branch !== null && branches.includes(entry.branch));
    if (checkedOut) {
      return { ok: false, exit_code: 1, recorded: false, worktree_path: checkedOut.path, message: `Branch ${checkedOut.branch} is still checked out in a worktree.`, deleted_branches: {} };
    }

    if (workExists.ok) {
      const validBase = await this.git(canonical, ["check-ref-format", baseRef]);
      if (!validBase.ok) return failure(validBase, `Could not resolve Project base branch ${project.base_branch}: ${validBase.message}`);
      const workMerged = await this.branchContentMergedNow(canonical, workBranch, `${baseRef}^{commit}`);
      if (!workMerged.ok) {
        return failure(workMerged.result, `Could not verify whether branch ${workBranch} is merged into ${project.base_branch}: ${workMerged.result.message}`);
      }
      if (!workMerged.merged) {
        return failure({ ok: false, exit_code: 1, recorded: false, message: "" }, `Branch ${workBranch} is not merged into ${project.base_branch}.`);
      }
    }

    const deletedBranches: Record<string, string> = {};
    for (const branch of branches) {
      const sha = await this.git(canonical, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
      if (!sha.ok) return { ...failure(sha, `Could not resolve branch ${branch}: ${sha.message}`), deleted_branches: deletedBranches };
      const deleted = await this.git(canonical, ["branch", "-D", branch]);
      if (!deleted.ok) return { ...failure(deleted, `Could not delete branch ${branch}: ${deleted.message}`), deleted_branches: deletedBranches };
      deletedBranches[branch] = sha.message.trim();
    }
    return { ok: true, exit_code: 0, recorded: false, message: `Deleted the branches of Work ${workId}.`, deleted_branches: deletedBranches };
  }

  /**
   * Whether this Work or one of its Task branches has content outside the
   * Project base branch. Reads refs and lock-free status only, so it never
   * waits for the repository lane.
   */
  public async workHasUnmergedChanges(request: { readonly work_id: string }): Promise<boolean> {
    const work = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", request.work_id);
    if (!work?.project_id) return false;
    const project = this.projectFor(request.work_id);
    if (!project) throw new Error("The Work Project could not be resolved.");
    const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
    return this.workHasUnmergedChangesNow(request.work_id, project, canonical);
  }

  private async workHasUnmergedChangesNow(workId: string, project: ProjectRow, canonical: string): Promise<boolean> {
    const baseRef = `refs/heads/${project.base_branch}`;
    const validBase = await this.git(canonical, ["check-ref-format", baseRef]);
    if (!validBase.ok) throw new Error(`Could not resolve Project base branch ${project.base_branch}: ${validBase.message}`);
    const base = await this.git(canonical, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
    if (!base.ok) throw new Error(`Could not resolve Project base branch ${project.base_branch}: ${base.message}`);

    const workBranch = branchName("work", workId, null);
    const taskPrefix = `owl/task/${safeSegment(workId)}/`;
    const taskRefs = await this.git(canonical, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${taskPrefix}`]);
    if (!taskRefs.ok) throw new Error(`Could not list Task branches for Work ${workId}: ${taskRefs.message}`);
    const taskBranches = taskRefs.message === "git operation completed"
      ? []
      : taskRefs.message.split("\n").filter((branch) => branch.startsWith(taskPrefix));
    const branches = [workBranch, ...taskBranches];
    const existingBranches: string[] = [];
    for (const branch of branches) {
      const exists = await this.git(canonical, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      if (!exists.ok && exists.exit_code === 1) continue;
      if (!exists.ok) throw new Error(`Could not inspect branch ${branch}: ${exists.message}`);
      existingBranches.push(branch);
      const merged = await this.branchContentMergedNow(canonical, branch, base.message.trim());
      if (!merged.ok) throw new Error(`Could not compare branch ${branch} with ${project.base_branch}: ${merged.result.message}`);
      if (!merged.merged) return true;
    }

    const worktrees = await this.git(canonical, ["worktree", "list", "--porcelain"]);
    if (!worktrees.ok) throw new Error(`Could not list Project worktrees: ${worktrees.message}`);
    const ownedBranches = new Set(existingBranches);
    for (const entry of parseWorktrees(worktrees.message)) {
      if (entry.branch === null || !ownedBranches.has(entry.branch)) continue;
      const status = await this.statusWithoutToolState(entry.path, workId, ["--no-optional-locks"]);
      if (!status.ok) throw new Error(`Could not inspect Work branch changes in ${entry.path}: ${status.message}`);
      if (status.message !== "git operation completed" && status.message.trim().length > 0) return true;
    }
    return false;
  }

  /**
   * Whether everything `branch` changed is already in `baseCommit`: the
   * branch is an ancestor of it, or merging the branch would leave its tree
   * unchanged, as after a squash merge. A conflicting merge counts as not
   * merged.
   */
  private async branchContentMergedNow(
    canonical: string,
    branch: string,
    baseCommit: string,
  ): Promise<{ readonly ok: true; readonly merged: boolean } | { readonly ok: false; readonly result: GitOperationResult }> {
    const ancestor = await this.git(canonical, ["merge-base", "--is-ancestor", branch, baseCommit]);
    if (ancestor.ok) return { ok: true, merged: true };
    if (ancestor.exit_code !== 1) return { ok: false, result: ancestor };
    const mergedTree = await this.git(canonical, ["merge-tree", "--write-tree", "--no-messages", baseCommit, branch]);
    if (!mergedTree.ok) return mergedTree.exit_code === 1 ? { ok: true, merged: false } : { ok: false, result: mergedTree };
    const baseTree = await this.git(canonical, ["rev-parse", "--verify", `${baseCommit}^{tree}`]);
    if (!baseTree.ok) return { ok: false, result: baseTree };
    return { ok: true, merged: mergedTree.message.split("\n")[0]?.trim() === baseTree.message.trim() };
  }

  /**
   * The identity and message of the commit a Work lands as. The commit
   * carries the Work title only, and the repository's configured author
   * when there is one, so the base history holds no Owl bookkeeping.
   */
  /**
   * `-c` arguments naming the Owner (the author configured for the
   * repository in the user's own git config), or Owl Agent when none is set.
   * Read with the user's normal config, never the isolated one.
   */
  private async ownerIdentityArgs(cwd: string): Promise<string[]> {
    const read = async (key: string): Promise<string> => {
      try {
        const result = await execFileAsync("git", ["-C", cwd, "config", "--get", key], { timeout: 10_000, maxBuffer: 64 * 1024 });
        return String(result.stdout ?? "").trim();
      } catch {
        return "";
      }
    };
    const name = await read("user.name");
    const email = await read("user.email");
    return name.length > 0 && email.length > 0
      ? ["-c", `user.name=${name}`, "-c", `user.email=${email}`]
      : ["-c", "user.name=Owl Agent", "-c", "user.email=owl-agent@localhost"];
  }

  private async workCommitArgs(integrationPath: string, workId: string): Promise<string[]> {
    const title = this.db.get<{ title: string | null }>("SELECT title FROM works WHERE id = ?", workId)?.title ?? "";
    const subject = title.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0) ?? "Apply Work changes";
    return [
      ...(await this.ownerIdentityArgs(integrationPath)),
      // The Work's content already passed the hooks when its Tasks were
      // committed; like the merge commit it replaces, landing it skips them.
      "commit", "--no-verify", "-m", subject,
    ];
  }

  /**
   * Build the Work's single commit on top of the latest base in the
   * integration worktree: detach at the base, then squash the Work branch.
   */
  private async prepareWorkMergeNow(workId: string, project: ProjectRow, canonical: string): Promise<PreparedWorkMerge> {
    const workBranch = branchName("work", workId, null);
    const integrationPath = this.layout.integrationPath(workId);
    const baseBranch = project.base_branch;
    const baseRef = `refs/heads/${baseBranch}`;
    const context = { worktree_path: integrationPath, base_branch: baseBranch, work_branch: workBranch };
    const stop = (result: GitWorkMergeResult): PreparedWorkMerge => ({ kind: "result", result });
    const validRef = await this.git(canonical, ["check-ref-format", baseRef]);
    if (!validRef.ok) return stop(workMergeError(`Invalid Project base branch ${baseBranch}: ${validRef.message}`, validRef.exit_code, context));

    let plan: VerificationCommand[];
    try {
      const parsed: unknown = JSON.parse(project.verification_plan_json ?? "null");
      if (!Array.isArray(parsed)) throw new Error("Project verification_plan must be an array.");
      plan = parsed as VerificationCommand[];
    } catch (error) {
      return stop(workMergeError(`Project verification_plan is invalid: ${error instanceof Error ? error.message : String(error)}`, 1, context));
    }
    if (plan.some((command) => !validVerificationCommand(command))) {
      return stop(workMergeError("Project verification_plan contains an invalid command.", 1, context));
    }

    const integration = await this.ensureIntegrationWorktree(canonical, baseBranch, integrationPath, workBranch);
    if (!integration.ok || !integration.worktree_path) return stop(workMergeError(integration.message, integration.exit_code, context));
    const abortedMerge = await this.abortIntegrationMergeNow(workId);
    if (!abortedMerge.ok) return stop(workMergeError(`Could not abort the previous Work merge: ${abortedMerge.message}`, abortedMerge.exit_code, context));

    const checkout = await this.git(integrationPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (!checkout.ok || checkout.message.trim() !== workBranch) {
      return stop(workMergeError(`The integration worktree is not on ${workBranch}.`, checkout.exit_code || 1, context));
    }
    const cleanBefore = await this.git(integrationPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (!cleanBefore.ok || (cleanBefore.message !== "git operation completed" && cleanBefore.message.trim().length > 0)) {
      const dirtyFiles = cleanBefore.ok ? parsePorcelainZ(await this.gitStdout(integrationPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]) ?? "") : [];
      return stop({
        ...workMergeError(`The integration worktree has uncommitted changes: ${cleanBefore.message}`, cleanBefore.exit_code || 1, { ...context, worktree_path: integrationPath }),
        ...(dirtyFiles.length > 0 ? { dirty_files: dirtyFiles } : {}),
      });
    }

    const baseResult = await this.git(canonical, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
    if (!baseResult.ok) return stop(workMergeError(`Could not resolve Project base branch ${baseBranch}: ${baseResult.message}`, baseResult.exit_code, context));
    const oldBaseCommit = baseResult.message.trim();
    const workResult = await this.git(canonical, ["rev-parse", "--verify", `refs/heads/${workBranch}^{commit}`]);
    if (!workResult.ok) return stop(workMergeError(`Could not resolve ${workBranch}: ${workResult.message}`, workResult.exit_code, context));
    const workCommit = workResult.message.trim();

    const alreadyMerged = await this.branchContentMergedNow(canonical, workCommit, oldBaseCommit);
    if (!alreadyMerged.ok) return stop(workMergeError(alreadyMerged.result.message, alreadyMerged.result.exit_code, context));
    if (alreadyMerged.merged) {
      return stop({
        kind: "merged",
        ok: true,
        exit_code: 0,
        recorded: false,
        message: `${workBranch} was already part of ${baseBranch}.`,
        ...context,
        old_base_commit: oldBaseCommit,
        new_base_commit: oldBaseCommit,
        merge_commit: null,
        verification_commands_run: [],
      });
    }

    const detached = await this.git(integrationPath, ["checkout", "--detach", oldBaseCommit]);
    if (!detached.ok) {
      await this.restoreIntegrationWorktreeNow(integrationPath, workBranch);
      return stop(workMergeError(`Could not check out ${baseBranch} in the integration worktree: ${detached.message}`, detached.exit_code, context));
    }
    const squashed = await this.git(integrationPath, ["merge", "--squash", workCommit]);
    const merged = squashed.ok ? await this.git(integrationPath, await this.workCommitArgs(integrationPath, workId)) : squashed;
    if (!merged.ok) {
      const unresolved = await this.git(integrationPath, ["diff", "--name-only", "--diff-filter=U", "-z"]);
      const conflictingFiles = unresolved.ok && unresolved.message !== "git operation completed"
        ? unresolved.message.split("\0").filter((path) => path.length > 0)
        : [];
      const inProgress = await this.mergeInProgress(integrationPath);
      const aborted = inProgress ? await this.git(integrationPath, ["merge", "--abort"]) : null;
      const restored = await this.restoreIntegrationWorktreeNow(integrationPath, workBranch);
      if (conflictingFiles.length > 0 || inProgress) {
        return stop({
          kind: "conflict",
          ok: false,
          exit_code: merged.exit_code || 1,
          recorded: false,
          message: merged.message,
          ...context,
          conflicting_files: conflictingFiles,
          aborted: (aborted?.ok ?? true) && restored.ok,
          abort_message: aborted && !aborted.ok ? aborted.message : restored.ok ? null : restored.message,
        });
      }
      return stop(workMergeError(merged.message, merged.exit_code, context));
    }

    const parents = await this.git(integrationPath, ["rev-list", "--parents", "-n", "1", "HEAD"]);
    const [mergeCommit, ...commitParents] = parents.ok ? parents.message.trim().split(" ") : [];
    if (!mergeCommit || commitParents.length !== 1 || commitParents[0] !== oldBaseCommit) {
      await this.restoreIntegrationWorktreeNow(integrationPath, workBranch);
      return stop(workMergeError("The Work commit does not have the base branch as its only parent.", 1, context));
    }
    const cleaned = await this.cleanIntegrationWorktree(integrationPath);
    if (!cleaned.ok) {
      await this.restoreIntegrationWorktreeNow(integrationPath, workBranch);
      return stop(workMergeError(`Could not clean the integration worktree: ${cleaned.message}`, cleaned.exit_code, context));
    }
    return { kind: "prepared", context, plan, old_base_commit: oldBaseCommit, work_commit: workCommit, merge_commit: mergeCommit };
  }

  /** Run the verification plan in the integration worktree; null when every command passed. */
  private async runWorkVerification(workId: string, plan: readonly VerificationCommand[], context: WorkMergeContext): Promise<GitWorkMergeResult | null> {
    const integrationPath = context.worktree_path;
    for (const command of plan) {
      const cwd = resolve(integrationPath, command.cwd);
      if (!inside(integrationPath, cwd)) {
        return {
          kind: "verification_failed",
          ok: false,
          exit_code: -1,
          recorded: false,
          message: `Verification command ${command.command_id} has a cwd outside the integration worktree.`,
          ...context,
          command_id: command.command_id,
          command: [...command.argv],
          stdout_tail: "",
          stderr_tail: "",
          output_tail: "",
          timed_out: false,
        };
      }
      const result = await this.runProjectVerificationCommand(workId, command, cwd);
      if (!result.passed) {
        const stdoutTail = result.stdout.slice(-4_000);
        const stderrTail = result.stderr.slice(-4_000);
        const outputTail = [stdoutTail, stderrTail, result.error ?? ""].filter((part) => part.length > 0).join("\n").slice(-8_000);
        return {
          kind: "verification_failed",
          ok: false,
          exit_code: result.exit_code,
          recorded: false,
          message: `Verification command ${command.command_id} failed (exit ${result.exit_code}): ${command.argv.map((part) => JSON.stringify(part)).join(" ")}${result.timed_out ? " (timed out)" : ""}`,
          ...context,
          command_id: command.command_id,
          command: [...command.argv],
          stdout_tail: stdoutTail,
          stderr_tail: stderrTail,
          output_tail: outputTail,
          timed_out: result.timed_out,
        };
      }
    }
    return null;
  }

  /**
   * Advance the base to the verified Work commit: fast-forward the worktree
   * that has the base checked out, or move the ref when none has. The
   * integration worktree is returned to the Work branch either way.
   */
  private async advanceBaseNow(
    request: { readonly work_id: string; readonly expected_state_version?: number },
    prepared: Extract<PreparedWorkMerge, { kind: "prepared" }>,
    canonical: string,
  ): Promise<GitWorkMergeResult> {
    const { context, old_base_commit: oldBaseCommit, merge_commit: mergeCommit } = prepared;
    const result = await this.advanceBaseStepsNow(request, prepared, canonical);
    const restored = await this.restoreIntegrationWorktreeNow(context.worktree_path, context.work_branch);
    if (result.kind === "merged" && !restored.ok) {
      console.warn(`[owl-git] Merged ${context.work_branch} into ${context.base_branch} (${oldBaseCommit} -> ${mergeCommit}), but the integration worktree could not be restored: ${restored.message}`);
    }
    return result;
  }

  private async advanceBaseStepsNow(
    request: { readonly work_id: string; readonly expected_state_version?: number },
    prepared: Extract<PreparedWorkMerge, { kind: "prepared" }>,
    canonical: string,
  ): Promise<GitWorkMergeResult> {
    const { context, old_base_commit: oldBaseCommit, work_commit: workCommit, merge_commit: mergeCommit } = prepared;
    const integrationPath = context.worktree_path;
    const baseBranch = context.base_branch;
    const baseRef = `refs/heads/${baseBranch}`;

    const cleaned = await this.cleanIntegrationWorktree(integrationPath);
    if (!cleaned.ok) return workMergeError(`Could not clean the integration worktree after verification: ${cleaned.message}`, cleaned.exit_code, context);
    const head = await this.git(integrationPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const workRef = await this.git(canonical, ["rev-parse", "--verify", `refs/heads/${context.work_branch}^{commit}`]);
    if (!head.ok || head.message.trim() !== mergeCommit || !workRef.ok || workRef.message.trim() !== workCommit) {
      return workMergeError("The Work branch or its commit on the base changed while it was being verified.", 1, context);
    }

    const work = this.db.get<{ state: string; state_version: number }>("SELECT state, state_version FROM works WHERE id = ?", request.work_id);
    if (!work || work.state !== "running" || (request.expected_state_version !== undefined && work.state_version !== request.expected_state_version)) {
      return {
        kind: "interrupted",
        ok: false,
        exit_code: 1,
        recorded: false,
        message: `Work ${request.work_id} is no longer running as expected; ${baseBranch} was left unchanged.`,
        ...context,
      };
    }

    const actualBase = await this.git(canonical, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
    const actualBaseCommit = actualBase.ok ? actualBase.message.trim() : null;
    if (actualBaseCommit !== oldBaseCommit) return baseMovedResult(context, oldBaseCommit, actualBaseCommit);

    const listed = await this.git(canonical, ["worktree", "list", "--porcelain"]);
    if (!listed.ok) return workMergeError(`Could not list Project worktrees: ${listed.message}`, listed.exit_code, context);
    const baseWorktree = parseWorktrees(listed.message).find((entry) => entry.branch === baseBranch)?.path ?? null;
    if (baseWorktree !== null) {
      if (await this.mergeInProgress(baseWorktree)) {
        return workMergeError(`The checkout of ${baseBranch} at ${baseWorktree} already has a merge in progress; it was left unchanged.`, 1, context);
      }
      const status = await this.git(baseWorktree, ["status", "--porcelain=v1", "--untracked-files=no"]);
      if (!status.ok || (status.message !== "git operation completed" && status.message.trim().length > 0)) {
        return workMergeError(`The checkout of ${baseBranch} at ${baseWorktree} has uncommitted changes: ${status.message}`, status.exit_code || 1, context);
      }
      const advanced = await this.git(baseWorktree, ["merge", "--ff-only", mergeCommit]);
      if (!advanced.ok) {
        const mergeHead = await this.mergeInProgress(baseWorktree);
        const aborted = mergeHead ? await this.git(baseWorktree, ["merge", "--abort"]) : null;
        const actual = await this.git(canonical, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
        const actualAfter = actual.ok ? actual.message.trim() : null;
        if (actualAfter !== oldBaseCommit) {
          const abortFailure = aborted && !aborted.ok ? ` ${aborted.message}` : "";
          return {
            kind: "base_moved",
            ok: false,
            exit_code: advanced.exit_code || 1,
            recorded: false,
            message: `Base branch ${baseBranch} moved before it could be merged: ${advanced.message}${abortFailure}`,
            ...context,
            expected_base_commit: oldBaseCommit,
            actual_base_commit: actualAfter,
          };
        }
        const abortFailure = aborted && !aborted.ok ? ` Merge abort failed: ${aborted.message}` : "";
        return workMergeError(`${advanced.message}${abortFailure}`, advanced.exit_code, context);
      }
    } else {
      const advanced = await this.git(canonical, ["update-ref", baseRef, mergeCommit, oldBaseCommit]);
      if (!advanced.ok) {
        const actual = await this.git(canonical, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
        const actualAfter = actual.ok ? actual.message.trim() : null;
        if (actualAfter !== oldBaseCommit) return baseMovedResult(context, oldBaseCommit, actualAfter);
        return workMergeError(advanced.message, advanced.exit_code, context);
      }
    }
    return {
      kind: "merged",
      ok: true,
      exit_code: 0,
      recorded: false,
      message: `Verified and merged ${context.work_branch} into ${baseBranch}.`,
      ...context,
      old_base_commit: oldBaseCommit,
      new_base_commit: mergeCommit,
      merge_commit: mergeCommit,
      verification_commands_run: prepared.plan.map((command) => command.command_id),
    };
  }

  private async runProjectVerificationCommand(workId: string, command: VerificationCommand, cwd: string): Promise<VerificationCommandResult> {
    if (command.argv.length === 0) return { passed: false, exit_code: -1, stdout: "", stderr: "", timed_out: false, error: "argv_empty" };
    const env: Record<string, string> = {};
    for (const key of new Set(["PATH", ...command.env_allowlist])) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    env[OWL_INSTANCE_ID_ENV] = resolveInstanceId(this.dataDir);
    env.OWL_AGENT_RUN_ID = workVerificationMarker(workId);
    return new Promise((resolveResult) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let child;
      try {
        child = spawn(command.argv[0]!, command.argv.slice(1), { cwd, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        resolveResult({ passed: false, exit_code: -1, stdout, stderr, timed_out: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const append = (current: string, chunk: Buffer, cap: number): string => {
        if (cap <= 0) return "";
        const combined = Buffer.concat([Buffer.from(current), chunk]);
        if (combined.byteLength <= cap) return combined.toString("utf8");
        let start = combined.byteLength - cap;
        while (start < combined.byteLength && (combined[start]! & 0xc0) === 0x80) start += 1;
        return combined.subarray(start).toString("utf8");
      };
      child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk, command.stdout_limit); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk, command.stderr_limit); });
      const killGroup = (signal: "SIGTERM" | "SIGKILL"): void => {
        if (child.pid === undefined) return;
        try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* process already exited */ } }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), 5_000).unref();
      }, Math.max(1, command.timeout_seconds * 1_000));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult({ passed: false, exit_code: -1, stdout, stderr, timed_out: timedOut, error: error.message });
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void reapProcessGroup(child.pid);
        const exitCode = code ?? -1;
        resolveResult({ passed: !timedOut && signal === null && command.expected_exit_codes.includes(exitCode), exit_code: exitCode, stdout, stderr, timed_out: timedOut });
      });
    });
  }

  /**
   * Whether the Task branch's commits are already all reachable from the
   * Work branch, and there is no uncommitted worktree content that would
   * still need to be captured. Branch history alone cannot see a Worker's
   * uncommitted edits, so a Task branch that has not diverged yet (nothing
   * committed since it started) only counts as merged once its worktree is
   * gone or clean; otherwise real, unintegrated work would be discarded.
   * null when there is no Project, no Task, either branch does not exist, or
   * the worktree's status could not be determined.
   */
  public async taskBranchMerged(request: GitOperationRequest): Promise<boolean | null> {
    const project = this.projectFor(request.work_id);
    if (!project || !request.task_id) return null;
    const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
    return this.inLane(canonical, () => this.taskBranchMergedNow(request, canonical));
  }

  private async taskBranchMergedNow(request: GitOperationRequest, canonical: string): Promise<boolean | null> {
    const taskId = request.task_id as string;
    const taskBranch = request.task_branch ?? branchName("task", request.work_id, taskId);
    const workBranch = request.work_branch ?? branchName("work", request.work_id, null);
    const taskBranchExists = await this.git(canonical, ["show-ref", "--verify", "--quiet", `refs/heads/${taskBranch}`]);
    const workBranchExists = await this.git(canonical, ["show-ref", "--verify", "--quiet", `refs/heads/${workBranch}`]);
    if (!taskBranchExists.ok || !workBranchExists.ok) return null;
    const result = await this.git(canonical, ["merge-base", "--is-ancestor", taskBranch, workBranch]);
    if (!result.ok) return result.exit_code === 1 ? false : null;
    const taskPath = this.layout.taskPath(request.work_id, taskId);
    const existing = await lstat(taskPath).catch(() => null);
    if (!existing) return true;
    const status = await this.statusWithoutToolState(taskPath, request.work_id);
    if (!status.ok) return null;
    return status.message === "git operation completed" || status.message.trim().length === 0;
  }

  private async mergeInProgress(worktreePath: string): Promise<boolean> {
    const head = await this.git(worktreePath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    return head.ok;
  }

  public async removeWorktree(request: GitOperationRequest): Promise<GitOperationResult> {
    const project = this.projectFor(request.work_id);
    if (!project) return this.removeWorktreeNow(request);
    const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
    return this.inLane(canonical, () => this.removeWorktreeNow(request));
  }

  public async removeTaskWorktreeAndBranch(request: GitOperationRequest): Promise<GitOperationResult> {
    const project = this.projectFor(request.work_id);
    if (!project) return this.removeWorktreeNow(request);
    if (!request.task_id) return { ok: false, exit_code: 1, recorded: false, message: "A Task id is required to remove its branch." };
    const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
    return this.inLane(canonical, async () => {
      const taskBranch = request.task_branch ?? branchName("task", request.work_id, request.task_id as string);
      const exists = await this.git(canonical, ["show-ref", "--verify", "--quiet", `refs/heads/${taskBranch}`]);
      if (!exists.ok && exists.exit_code !== 1) return { ...exists, message: `Could not inspect Task branch ${taskBranch}: ${exists.message}` };
      const removal = await this.removeWorktreeNow(request);
      if (!removal.ok || !exists.ok) return removal;
      const deleted = await this.git(canonical, ["branch", "-D", taskBranch]);
      if (!deleted.ok) return { ...deleted, message: `Worktree was removed but Task branch ${taskBranch} could not be deleted: ${deleted.message}` };
      return { ...removal, message: `Worktree was removed and Task branch ${taskBranch} was deleted.` };
    });
  }

  private async removeWorktreeNow(request: GitOperationRequest): Promise<GitOperationResult> {
    const project = this.projectFor(request.work_id);
    const path = request.task_id
      ? this.layout.taskPath(request.work_id, request.task_id)
      : request.worktree_path
        ? resolve(request.worktree_path)
        : this.layout.workDir(request.work_id);
    if (!this.layout.contains(path)) {
      return { ok: false, exit_code: 1, recorded: false, message: "The worktree path is outside the Owl workspaces directory." };
    }
    if (request.task_id && request.worktree_path && resolve(request.worktree_path) !== path) {
      return { ok: false, exit_code: 1, recorded: false, message: "The requested Task worktree does not match the Work/Task workspace." };
    }
    if (!project) return { ok: true, exit_code: 0, recorded: false, worktree_path: path, message: "Isolated workspace retained until the Work reaches a terminal state." };
    const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
    const existing = await lstat(path).catch(() => null);
    if (!existing) return { ok: true, exit_code: 0, recorded: false, worktree_path: path, message: "Worktree was already absent." };
    await this.beforeRemoval(path);
    return this.git(canonical, ["worktree", "remove", "--force", path]);
  }

  /**
   * Commit uncommitted changes to the Task branch (the branch is never
   * deleted) and remove the Task worktree. A Project-less Task keeps its
   * isolated workspace until its Work is saved to the outputs folder and
   * removed as a whole, so a failed or superseded Task's captured artifacts
   * stay recoverable alongside the rest of the Work until then.
   */
  public async discardTaskWorktree(request: GitOperationRequest): Promise<GitOperationResult> {
    const project = this.projectFor(request.work_id);
    if (!project) {
      return {
        ok: true,
        exit_code: 0,
        recorded: false,
        worktree_path: request.worktree_path ?? undefined,
        message: "Isolated workspace retained until the Work reaches a terminal state.",
      };
    }
    const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
    return this.inLane(canonical, () => this.discardTaskWorktreeNow(request, canonical));
  }

  private async discardTaskWorktreeNow(request: GitOperationRequest, canonical: string): Promise<GitOperationResult> {
    const path = request.task_id
      ? this.layout.taskPath(request.work_id, request.task_id)
      : request.worktree_path
        ? resolve(request.worktree_path)
        : this.layout.workDir(request.work_id);
    if (!this.layout.contains(path)) {
      return { ok: false, exit_code: 1, recorded: false, message: "The worktree path is outside the Owl workspaces directory." };
    }
    if (request.task_id && request.worktree_path && resolve(request.worktree_path) !== path) {
      return { ok: false, exit_code: 1, recorded: false, message: "The requested Task worktree does not match the Work/Task workspace." };
    }
    const existing = await lstat(path).catch(() => null);
    if (!existing) return { ok: true, exit_code: 0, recorded: false, worktree_path: path, message: "Worktree was already absent." };

    const listed = await this.git(canonical, ["worktree", "list", "--porcelain"]);
    if (!listed.ok) return listed;
    const realPath = await realpath(path).catch(() => path);
    let registered = false;
    for (const line of listed.message.split(/\r?\n/u).filter((value) => value.startsWith("worktree "))) {
      const candidatePath = resolve(line.slice("worktree ".length));
      if (await realpath(candidatePath).catch(() => candidatePath) === realPath) {
        registered = true;
        break;
      }
    }
    if (registered) {
      if (request.discard_changes) {
        const reset = await this.resetTaskWorktreeToForkPoint(canonical, path, request);
        if (!reset.ok) return { ok: false, exit_code: 1, recorded: false, worktree_path: path, message: reset.message };
      } else {
        const committed = await this.commitTaskChanges(path, request.work_id, request.task_id ?? "worktree");
        if (!committed.ok) return committed;
      }
      const status = await this.git(path, ["status", "--porcelain=v1", "--ignored=matching", "--untracked-files=all", "-z"]);
      if (!status.ok) return status;
      const ignored = status.message === "git operation completed"
        ? []
        : await ignoredContent(path, this.withoutToolState(request.work_id, status.message.split("\0").filter((line) => line.startsWith("!! ")).map((line) => line.slice(3))));
      if (ignored.length > 0) {
        return { ok: false, exit_code: 1, recorded: false, worktree_path: path, message: `Ignored contents remain: ${ignored.slice(0, 10).join(", ")}.` };
      }
      await this.beforeRemoval(path);
      return this.git(canonical, ["worktree", "remove", "--force", path]);
    }
    // A leftover no longer has a Git index. Scan it and verify a backup before
    // pruning or removing anything; ignored files always stop the cleanup.
    let scan: WorkspaceScan;
    try { scan = await scanWorkspace(path); }
    catch (error) { return { ok: false, exit_code: 1, recorded: false, worktree_path: path, message: error instanceof Error ? error.message : String(error) }; }
    const ignored = await this.checkIgnoredPaths(canonical, scan.paths);
    if (!ignored.ok) return { ok: false, exit_code: 1, recorded: false, worktree_path: path, message: ignored.message };
    const ignoredPaths = await ignoredContent(path, this.withoutToolState(request.work_id, ignored.paths));
    if (ignoredPaths.length > 0) {
      return { ok: false, exit_code: 1, recorded: false, worktree_path: path, message: `Ignored contents remain: ${ignoredPaths.slice(0, 10).join(", ")}.` };
    }
    try {
      await this.backupUnregisteredWorkspace(request.work_id, {
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        integration: path.endsWith("/__work__"),
        task_id: request.task_id,
      }, { ...scan, ignored_paths: ignored.paths });
    } catch (error) {
      return { ok: false, exit_code: 1, recorded: false, worktree_path: path, message: error instanceof Error ? error.message : String(error) };
    }
    const pruned = await this.git(canonical, ["worktree", "prune"]);
    if (!pruned.ok) return pruned;
    await this.beforeRemoval(path);
    await rm(path, { recursive: true, force: true });
    return { ok: true, exit_code: 0, recorded: false, worktree_path: path, message: "Removed an unregistered worktree directory." };
  }

  /** Remove a merged Work's workspace without committing or backing up its contents. */
  public async discardMergedWorktree(request: GitOperationRequest): Promise<GitOperationResult> {
    const project = this.projectFor(request.work_id);
    if (!project) {
      return { ok: false, exit_code: 1, recorded: false, worktree_path: request.worktree_path ?? undefined, message: "A Project is required to discard a merged Work worktree." };
    }
    const path = request.worktree_path
      ? resolve(request.worktree_path)
      : request.task_id
        ? this.layout.taskPath(request.work_id, request.task_id)
        : this.layout.workDir(request.work_id);
    if (!this.layout.contains(path)) {
      return { ok: false, exit_code: 1, recorded: false, worktree_path: path, message: `Worktree ${path} is outside the Owl workspaces directory.` };
    }
    if (request.task_id && request.worktree_path && resolve(request.worktree_path) !== this.layout.taskPath(request.work_id, request.task_id)) {
      return { ok: false, exit_code: 1, recorded: false, worktree_path: path, message: `Worktree ${path} does not match the Work/Task workspace.` };
    }
    const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
    return this.inLane(canonical, () => this.removeMergedWorktreeNow(canonical, path));
  }

  /** Remove a merged Work's integration worktree without preserving its contents. */
  public async removeMergedIntegrationWorktree(request: { readonly work_id: string }): Promise<GitOperationResult> {
    const project = this.projectFor(request.work_id);
    if (!project) {
      return { ok: false, exit_code: 1, recorded: false, message: "A Project is required to discard a merged Work integration worktree." };
    }
    const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
    const path = this.layout.integrationPath(request.work_id);
    return this.inLane(canonical, () => this.removeMergedWorktreeNow(canonical, path));
  }

  private async removeMergedWorktreeNow(canonical: string, path: string): Promise<GitOperationResult> {
    await this.beforeRemoval(path);
    const removal = await this.git(canonical, ["worktree", "remove", "--force", path]);
    try {
      const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing) await rm(path, { recursive: true, force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        exit_code: removal.exit_code || 1,
        recorded: false,
        worktree_path: path,
        message: `Could not remove worktree ${path}: ${message}. Git reported: ${removal.message}`,
      };
    }

    const pruned = await this.git(canonical, ["worktree", "prune"]);
    if (!pruned.ok) {
      return { ...pruned, worktree_path: path, message: `Could not prune worktree ${path}: ${pruned.message}` };
    }
    try {
      const remaining = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (remaining) {
        return {
          ok: false,
          exit_code: removal.exit_code || 1,
          recorded: false,
          worktree_path: path,
          message: `Worktree ${path} remains after git worktree remove --force: ${removal.message}`,
        };
      }
    } catch (error) {
      return {
        ok: false,
        exit_code: 1,
        recorded: false,
        worktree_path: path,
        message: `Could not verify removal of worktree ${path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { ok: true, exit_code: 0, recorded: false, worktree_path: path, message: `Discarded merged worktree ${path}.` };
  }

  /** Remove a Work's `__work__` integration worktree; the Work branch is kept. */
  public async removeIntegrationWorktree(request: { readonly work_id: string }): Promise<GitOperationResult> {
    const project = this.projectFor(request.work_id);
    if (!project) {
      return { ok: true, exit_code: 0, recorded: false, message: "No Project is attached; there is no integration worktree." };
    }
    const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
    return this.inLane(canonical, () => this.removeIntegrationWorktreeNow(request.work_id, canonical));
  }

  private async removeIntegrationWorktreeNow(workId: string, canonical: string): Promise<GitOperationResult> {
    const path = this.layout.integrationPath(workId);
    const existing = await lstat(path).catch(() => null);
    if (!existing) return { ok: true, exit_code: 0, recorded: false, worktree_path: path, message: "Integration worktree was already absent." };
    const mergeHead = await this.git(path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    if (mergeHead.exit_code === 0) return { ok: false, exit_code: 1, recorded: false, worktree_path: path, message: "Integration worktree has a merge in progress." };
    if (mergeHead.exit_code !== 1) return mergeHead;
    const committed = await this.commitIntegrationChanges(path, workId);
    if (!committed.ok) return committed;
    const status = await this.git(path, ["status", "--porcelain=v1", "--ignored=matching", "--untracked-files=all", "-z"]);
    if (!status.ok) return status;
    const ignored = status.message === "git operation completed"
      ? []
      : await ignoredContent(path, status.message.split("\0").filter((line) => line.startsWith("!! ")).map((line) => line.slice(3)));
    if (ignored.length > 0) {
      return { ok: false, exit_code: 1, recorded: false, worktree_path: path, message: `Ignored contents remain: ${ignored.slice(0, 10).join(", ")}.` };
    }
    await this.beforeRemoval(path);
    return this.git(canonical, ["worktree", "remove", "--force", path]);
  }

  /**
   * Every Task/integration directory under each workspaces root, read
   * directly from the filesystem without touching Git. Used to reconcile
   * leftovers that have no (or a stale) database row.
   */
  public async listWorkspaces(): Promise<readonly WorkspaceEntry[]> {
    const entries: WorkspaceEntry[] = [];
    for (const root of this.layout.roots()) {
      const workDirs = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const workDir of workDirs) {
        if (!workDir.isDirectory() || workDir.name === "advisor") continue;
        const workPath = resolve(root, workDir.name);
        const children = await readdir(workPath, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        for (const child of children) {
          if (!child.isDirectory()) continue;
          entries.push({
            work_id: workDir.name,
            task_id: child.name === "__work__" || child.name === "manager" ? null : child.name,
            path: resolve(workPath, child.name),
          });
        }
      }
    }
    return entries;
  }

  /**
   * Save non-ignored changes, verify every candidate before removing any
   * worktree, then remove this Work's worktrees. Branches are deleted
   * separately (deleteWorkBranches) once the Work row is gone. Startup
   * reconciliation remains best-effort and must not use this path.
   */
  public async deleteWorkWorkspaces(request: { readonly work_id: string }): Promise<WorktreeCleanupResult> {
    const project = this.projectFor(request.work_id);
    if (!project) return { ok: false, message: "The Work Project could not be resolved." };
    try {
      const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
      return await this.inLane(canonical, () => this.deleteWorkWorkspacesNow(request.work_id, canonical));
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "The Work workspace cleanup failed.",
        details: { path: this.layout.workDir(request.work_id), stage: "project_or_workspace_check" },
      };
    }
  }

  private async deleteWorkWorkspacesNow(workId: string, canonical: string): Promise<WorktreeCleanupResult> {
    const workRoot = this.layout.workDir(workId);
    const legacy = this.layout.rootOf(workRoot) === this.layout.legacyRoot;
    let realWorkspacesRoot: string;
    if (legacy) {
      // The legacy root is nested inside owlRoot, so a symlinked owlRoot must
      // still resolve the workspaces directory to somewhere inside it.
      const owlRoot = await realpath(this.owlRoot);
      const resolvedLegacyRoot = await realpath(this.layout.legacyRoot).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (resolvedLegacyRoot === null) return { ok: true, message: "The Work workspace was already absent." };
      if (!inside(owlRoot, resolvedLegacyRoot)) {
        return { ok: false, message: "The .owl-workspaces directory resolves outside owl_root.", details: { path: this.layout.legacyRoot, stage: "workspace_check" } };
      }
      realWorkspacesRoot = resolvedLegacyRoot;
    } else {
      // The current root lives outside any repository; only its own realpath needs to resolve.
      const resolvedRoot = await realpath(this.layout.root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (resolvedRoot === null) return { ok: true, message: "The Work workspace was already absent." };
      realWorkspacesRoot = resolvedRoot;
    }
    const rootInfo = await lstat(workRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (rootInfo === null) return { ok: true, message: "The Work workspace was already absent." };
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      return { ok: false, message: "The Work workspace is not a plain directory.", details: { path: workRoot, stage: "workspace_scan" } };
    }
    const realWorkRoot = await realpath(workRoot);
    if (!inside(realWorkspacesRoot, realWorkRoot) || realWorkRoot === realWorkspacesRoot) {
      return { ok: false, message: "The Work workspace resolves outside its expected directory.", details: { path: workRoot, stage: "workspace_scan" } };
    }

    let children: Dirent[];
    try {
      children = await readdir(workRoot, { withFileTypes: true });
    } catch (error) {
      return cleanupFailure(workRoot, "workspace_scan", error);
    }
    const candidates: WorkDeletionCandidate[] = [];
    for (const child of children) {
      const path = resolve(workRoot, child.name);
      const realPath = await realpath(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (realPath === null || !inside(realWorkRoot, realPath) || realPath === realWorkRoot || child.isSymbolicLink() || !child.isDirectory()) {
        return {
          ok: false,
          message: "The Work workspace contains an entry that cannot be safely handled.",
          details: { path, stage: "workspace_scan" },
        };
      }
      candidates.push({
        path,
        name: child.name,
        integration: child.name === "__work__",
        task_id: child.name === "__work__" || child.name === "manager" ? null : child.name,
      });
    }

    const listed = await this.git(canonical, ["worktree", "list", "--porcelain"]);
    if (!listed.ok) return cleanupFailure(canonical, "worktree_list", listed.message);
    const registered = new Set<string>();
    for (const line of listed.message.split(/\r?\n/u).filter((value) => value.startsWith("worktree "))) {
      const path = resolve(line.slice("worktree ".length));
      registered.add(await realpath(path).catch(() => path));
    }
    const unregistered: Array<{ candidate: WorkDeletionCandidate; scan: WorkspaceScan }> = [];
    const ignoredWorktrees: Array<{ path: string; ignored_count: number; ignored_paths: string[] }> = [];

    // First save edits in every registered worktree. No candidate is removed
    // until all candidates have passed the ignored-content gate below.
    for (const candidate of candidates) {
      if (!registered.has(await realpath(candidate.path))) {
        let scan: WorkspaceScan;
        try {
          scan = await scanWorkspace(candidate.path);
        } catch (error) {
          return cleanupFailure(candidate.path, "workspace_scan", error);
        }
        const ignored = await this.checkIgnoredPaths(canonical, scan.paths);
        if (!ignored.ok) return cleanupFailure(candidate.path, "ignored_check", ignored.message);
        const ignoredPaths = await ignoredContent(candidate.path, this.withoutToolState(workId, ignored.paths));
        if (ignoredPaths.length > 0) {
          ignoredWorktrees.push(ignoredWorktree(candidate.path, ignoredPaths));
        }
        unregistered.push({ candidate, scan: { ...scan, ignored_paths: ignored.paths } });
        continue;
      }

      if (candidate.integration) {
        const mergeHead = await this.git(candidate.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
        if (mergeHead.exit_code === 0) {
          return cleanupFailure(candidate.path, "integration_merge_in_progress", "The integration worktree has a merge in progress.");
        }
        if (mergeHead.exit_code !== 1) return cleanupFailure(candidate.path, "integration_merge_check", mergeHead.message);
      }
      const committed = await this.preserveForDeletion(workId, candidate);
      if (!committed.ok) return cleanupFailure(candidate.path, candidate.integration ? "integration_commit" : "task_commit", committed.message);
      const status = await this.git(candidate.path, ["status", "--porcelain=v1", "--ignored=matching", "--untracked-files=all", "-z"]);
      if (!status.ok) return cleanupFailure(candidate.path, "ignored_check", status.message);
      const ignoredPaths = status.message === "git operation completed"
        ? []
        : await ignoredContent(candidate.path, this.withoutToolState(workId, status.message.split("\0").filter((line) => line.startsWith("!! ")).map((line) => line.slice(3))));
      if (ignoredPaths.length > 0) ignoredWorktrees.push(ignoredWorktree(candidate.path, ignoredPaths));
    }

    if (ignoredWorktrees.length > 0) {
      return {
        ok: false,
        message: "Ignored files or directories remain in Work worktrees.",
        details: { worktrees: ignoredWorktrees, stage: "ignored_check" },
      };
    }

    // Unregistered directories have no reliable Git index. Preserve every
    // non-ignored regular file in a verified output backup before pruning.
    for (const { candidate, scan } of unregistered) {
      try {
        await this.backupUnregisteredWorkspace(workId, candidate, scan);
      } catch (error) {
        return cleanupFailure(candidate.path, "workspace_backup", error);
      }
    }

    for (const candidate of candidates) {
      const removed = await this.discardTaskWorktreeNow({ work_id: workId, task_id: null, worktree_path: candidate.path }, canonical);
      if (!removed.ok) return cleanupFailure(candidate.path, "worktree_remove", removed.message);
    }
    try {
      await rmdir(workRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return cleanupFailure(workRoot, "work_directory_remove", error);
    }
    return { ok: true, message: "Work worktrees were saved and removed." };
  }

  /** Delete a deleted Work's Task and Work branches. The Project is passed because the Work row is already gone. */
  public async deleteWorkBranches(request: { readonly work_id: string; readonly project_id: string }): Promise<WorktreeCleanupResult> {
    const project = this.db.get<ProjectRow>("SELECT canonical_path, base_branch, allowed_roots_json FROM projects WHERE id = ?", request.project_id);
    if (!project) return { ok: false, message: "The Work Project could not be resolved." };
    try {
      const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
      return await this.inLane(canonical, () => this.deleteWorkBranchesNow(request.work_id, canonical));
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async deleteWorkBranchesNow(workId: string, canonical: string): Promise<WorktreeCleanupResult> {
    const workBranch = branchName("work", workId, null);
    const taskPrefix = `owl/task/${safeSegment(workId)}/`;
    const taskRefs = await this.git(canonical, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${taskPrefix}`]);
    if (!taskRefs.ok) return { ok: false, message: taskRefs.message, details: { stage: "branch_list" } };
    const taskBranches = taskRefs.message === "git operation completed"
      ? []
      : taskRefs.message.split("\n").filter((branch) => branch.startsWith(taskPrefix));
    const workExists = await this.git(canonical, ["show-ref", "--verify", "--quiet", `refs/heads/${workBranch}`]);
    if (!workExists.ok && workExists.exit_code !== 1) {
      return { ok: false, message: workExists.message, details: { stage: "branch_check", branch: workBranch } };
    }
    const branches = [...taskBranches, ...(workExists.ok ? [workBranch] : [])];
    if (branches.length === 0) return { ok: true, message: "Work branches were already absent." };

    const worktrees = await this.git(canonical, ["worktree", "list", "--porcelain"]);
    if (!worktrees.ok) return { ok: false, message: worktrees.message, details: { stage: "worktree_list" } };
    const checkedOut = new Map<string, string>();
    for (const entry of worktrees.message.split("\n\n")) {
      const path = entry.match(/^worktree (.+)$/m)?.[1];
      const branch = entry.match(/^branch refs\/heads\/(.+)$/m)?.[1];
      if (path && branch && branches.includes(branch)) checkedOut.set(branch, resolve(path));
    }
    if (checkedOut.size > 0) {
      const [branch, path] = checkedOut.entries().next().value as [string, string];
      return { ok: false, message: `Branch ${branch} is still checked out in a worktree.`, details: { stage: "branch_check", branch, path } };
    }

    for (const branch of branches) {
      const deleted = await this.git(canonical, ["branch", "-D", branch]);
      if (!deleted.ok) return { ok: false, message: `Could not delete branch ${branch}: ${deleted.message}`, details: { stage: "branch_delete", branch } };
    }
    return { ok: true, message: "Work branches were deleted." };
  }

  private async checkIgnoredPaths(canonical: string, paths: readonly string[]): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
    const ignored: string[] = [];
    for (let offset = 0; offset < paths.length; offset += 400) {
      const batch = paths.slice(offset, offset + 400);
      const result = await this.git(canonical, ["check-ignore", "-z", "--stdin", "--no-index"], `${batch.join("\0")}\0`);
      if (result.exit_code === 0) ignored.push(...result.message.split("\0").filter(Boolean));
      else if (result.exit_code !== 1) return { ok: false, message: result.message };
    }
    return { ok: true, paths: [...new Set(ignored)] };
  }

  private async backupUnregisteredWorkspace(
    workId: string,
    candidate: WorkDeletionCandidate,
    scan: WorkspaceScan,
    folder = "_unregistered-worktrees",
  ): Promise<void> {
    const isIgnored = (path: string): boolean => {
      let current = path;
      while (current.length > 0) {
        if (scan.ignored_paths.includes(current)) return true;
        const slash = current.lastIndexOf("/");
        if (slash < 0) break;
        current = current.slice(0, slash);
      }
      return false;
    };
    const files = scan.files.filter((file) => !isIgnored(file.path));
    if (files.length === 0) return;
    const fingerprint = createHash("sha256").update(JSON.stringify(files.map(({ path, sha256, bytes }) => [path, sha256, bytes]))).digest("hex").slice(0, 16);
    const backupRoot = resolve(this.dataDir, "outputs", safeSegment(workId), folder, `${safeSegment(candidate.name)}-${fingerprint}`);
    const outputsRoot = resolve(this.dataDir, "outputs", safeSegment(workId));
    if (!inside(outputsRoot, backupRoot) || backupRoot === outputsRoot) throw new Error("The verified workspace backup path is outside the Work outputs directory.");
    for (const file of files) {
      const source = resolve(candidate.path, file.path);
      const destination = resolve(backupRoot, file.path);
      if (!inside(candidate.path, source) || !inside(backupRoot, destination)) throw new Error(`A workspace file path escaped its root: ${file.path}`);
      await mkdir(resolve(destination, ".."), { recursive: true });
      try {
        await copyFile(source, destination, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const copied = await readFile(destination);
      const digest = createHash("sha256").update(copied).digest("hex");
      if (digest !== file.sha256 || copied.byteLength !== file.bytes) throw new Error(`Workspace backup did not verify for ${file.path}.`);
    }
  }

  public async changedPaths(request: GitOperationRequest): Promise<readonly string[] | null> {
    return this.taskPaths(request, false, []);
  }

  public async addedPaths(request: GitOperationRequest): Promise<readonly string[] | null> {
    return this.taskPaths(request, true, null);
  }

  /** Paths a Task changed since it forked from the Work; only newly added files when `addedOnly`. */
  private async taskPaths(request: GitOperationRequest, addedOnly: boolean, unknown: readonly string[] | null): Promise<readonly string[] | null> {
    const project = this.projectFor(request.work_id);
    if (!project || !request.task_id) return null;
    const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
    const taskPath = this.layout.taskPath(request.work_id, request.task_id);
    const workBranch = request.work_branch ?? branchName("work", request.work_id, null);
    const workBranchExists = await this.git(canonical, ["show-ref", "--verify", "--quiet", `refs/heads/${workBranch}`]);
    const base = workBranchExists.exit_code === 0 ? workBranch : project.base_branch;
    // A Project Task never falls back to its whole checkout: when Git cannot
    // tell what changed, nothing is captured (the report still lists changes).
    const forkPoint = await this.git(taskPath, ["merge-base", "HEAD", base]);
    if (!forkPoint.ok) return unknown;
    // Working tree against the fork point covers committed and uncommitted
    // edits; untracked files are listed separately. Deleted files are left out.
    const tracked = await this.git(taskPath, ["diff", "-z", "--name-only", "--no-renames", `--diff-filter=${addedOnly ? "A" : "d"}`, forkPoint.message.trim()]);
    const untracked = await this.git(taskPath, ["ls-files", "-z", "--others", "--exclude-standard"]);
    if (!tracked.ok || !untracked.ok) return unknown;
    const lines = (result: GitOperationResult): string[] =>
      result.message === "git operation completed" ? [] : result.message.split("\0").filter((path) => path.length > 0);
    return [...new Set([...lines(tracked), ...lines(untracked)])].sort();
  }

  public async discardTaskWorktreeChanges(request: GitOperationRequest): Promise<TaskWorktreeDiscardResult> {
    const project = this.projectFor(request.work_id);
    if (!request.task_id) return { ok: false, message: "A Task id is required to discard Designer changes.", changed_paths: [] };
    if (!project) return { ok: false, message: "A Project-less Task workspace has no Git changes to discard.", changed_paths: [] };
    const canonical = await this.validProjectPath(project.canonical_path, project.allowed_roots_json);
    const taskPath = this.layout.taskPath(request.work_id, request.task_id);
    if (request.worktree_path && resolve(request.worktree_path) !== taskPath) {
      return { ok: false, message: "The requested Task worktree does not match the Work/Task workspace.", changed_paths: [] };
    }
    return this.inLane(canonical, () => this.resetTaskWorktreeToForkPoint(canonical, taskPath, request));
  }

  /**
   * Reset a Task worktree, and the Task branch checked out in it, to the
   * commit it forked from the Work (or base) branch and remove untracked
   * files, so neither commits nor edits made in it survive.
   */
  private async resetTaskWorktreeToForkPoint(canonical: string, taskPath: string, request: GitOperationRequest): Promise<TaskWorktreeDiscardResult> {
    const project = this.projectFor(request.work_id);
    const workBranch = request.work_branch ?? branchName("work", request.work_id, null);
    const workBranchExists = await this.git(canonical, ["show-ref", "--verify", "--quiet", `refs/heads/${workBranch}`]);
    const base = workBranchExists.exit_code === 0 ? workBranch : project?.base_branch ?? "HEAD";
    const forkPoint = await this.git(taskPath, ["merge-base", "HEAD", base]);
    if (!forkPoint.ok) return { ok: false, message: `Could not find where the Task forked from ${base}: ${forkPoint.message}`, changed_paths: [] };
    const target = forkPoint.message.trim();
    const tracked = await this.git(taskPath, ["diff", "-z", "--name-only", "--no-renames", target]);
    const untracked = await this.git(taskPath, ["ls-files", "-z", "--others", "--exclude-standard"]);
    if (!tracked.ok) return { ok: false, message: tracked.message, changed_paths: [] };
    if (!untracked.ok) return { ok: false, message: untracked.message, changed_paths: [] };
    const lines = (result: GitOperationResult): string[] =>
      result.message === "git operation completed" ? [] : result.message.split("\0").filter((path) => path.length > 0);
    const changedPaths = [...new Set([...lines(tracked), ...lines(untracked)])].sort();
    const head = await this.git(taskPath, ["rev-parse", "HEAD"]);
    if (changedPaths.length === 0 && head.ok && head.message.trim() === target) {
      return { ok: true, message: "Task worktree is clean.", changed_paths: [] };
    }
    const reset = await this.git(taskPath, ["reset", "--hard", target]);
    if (!reset.ok) return { ok: false, message: reset.message, changed_paths: changedPaths };
    const clean = await this.git(taskPath, ["clean", "-fd"]);
    if (!clean.ok) return { ok: false, message: clean.message, changed_paths: changedPaths };
    return { ok: true, message: "Task worktree changes were discarded.", changed_paths: changedPaths };
  }

  /**
   * Save a worktree's uncommitted changes before its Work is deleted. They
   * normally go into a commit on its Owl branch; when that commit is refused
   * (a Project hook, for instance), a verified copy under the Work outputs
   * keeps them so the delete can go ahead without bypassing the Project's rules.
   */
  private async preserveForDeletion(workId: string, candidate: WorkDeletionCandidate): Promise<GitOperationResult> {
    const committed = candidate.integration
      ? await this.commitIntegrationChanges(candidate.path, workId)
      : await this.commitTaskChanges(candidate.path, workId, candidate.task_id ?? "worktree");
    if (committed.ok || committed.failure_kind !== "commit_failure") return committed;
    const staged = await this.git(candidate.path, ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=d", "-z"]);
    if (!staged.ok) return staged;
    const paths = staged.message === "git operation completed" ? [] : staged.message.split("\0").filter((path) => path.length > 0);
    try {
      const files: WorkspaceFile[] = [];
      for (const path of paths) {
        const absolute = resolve(candidate.path, path);
        if (!inside(candidate.path, absolute)) throw new Error(`A workspace file path escaped its root: ${path}`);
        if (!(await lstat(absolute)).isFile()) throw new Error(`Only regular files can be backed up: ${path}`);
        const contents = await readFile(absolute);
        files.push({ path, sha256: createHash("sha256").update(contents).digest("hex"), bytes: contents.byteLength });
      }
      await this.backupUnregisteredWorkspace(workId, candidate, { paths, files, ignored_paths: [] }, "_uncommitted-changes");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ...committed, message: `${committed.message} The changes could not be backed up instead: ${reason}` };
    }
    // The copy is verified, so the worktree can drop the changes the commit refused.
    const reset = await this.git(candidate.path, ["reset", "--quiet", "--hard", "HEAD"]);
    if (!reset.ok) return reset;
    return {
      ok: true,
      exit_code: 0,
      recorded: false,
      worktree_path: candidate.path,
      message: "The changes could not be committed, so a verified copy was saved to the Work outputs.",
    };
  }

  private async commitTaskChanges(taskPath: string, workId: string, taskId: string, verb: "complete" | "checkpoint" = "complete"): Promise<GitOperationResult> {
    return this.commitWorktreeChanges(taskPath, workId, `owl: ${verb} task ${taskId}`);
  }

  /**
   * Commits everything in the worktree except what the Project's setup and
   * refresh commands created (indexes, caches, installed dependencies), so
   * tool output never reaches the Task or Work branch.
   */
  private async commitWorktreeChanges(path: string, workId: string, message: string): Promise<GitOperationResult> {
    const scope = await this.toolStateScope(path, workId);
    const status = await this.git(path, ["status", "--porcelain=v1", "--untracked-files=all", ...scope]);
    if (!status.ok) return status;
    if (status.message === "git operation completed" || status.message.trim().length === 0) {
      return { ok: true, exit_code: 0, recorded: false, worktree_path: path, message: "Worktree is already clean." };
    }
    const added = await this.git(path, ["add", "--all", ...scope]);
    if (!added.ok) return added;
    const staged = await this.git(path, ["diff", "--cached", "--name-only"]);
    if (!staged.ok) return staged;
    if (staged.message.trim().length === 0 || staged.message === "git operation completed") {
      return { ok: false, exit_code: 1, recorded: false, worktree_path: path, message: "Worktree changes could not be staged for preservation." };
    }
    const committed = await this.git(path, ["-c", "user.name=Owl Agent", "-c", "user.email=owl-agent@localhost", "commit", "-m", message]);
    return committed.ok ? committed : { ...committed, failure_kind: "commit_failure" };
  }

  private async commitIntegrationChanges(path: string, workId: string): Promise<GitOperationResult> {
    return this.commitWorktreeChanges(path, workId, `owl: preserve Work ${workId} before deletion`);
  }

  /** The Project's recorded tool-state paths for this Work, relative to a worktree root. */
  private toolStatePaths(workId: string): string[] {
    const raw = this.projectFor(workId)?.worktree_tool_state_json;
    if (!raw) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return []; }
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.replace(/\/+$/u, ""))
      .filter((entry) => entry.length > 0 && !isAbsolute(entry) && !entry.split("/").includes(".."));
  }

  /** Pathspecs limiting a status or add to everything but the Project's tool state; empty when there is none. */
  private async toolStateScope(path: string, workId: string): Promise<string[]> {
    const excludes = await this.toolStateExcludes(path, workId);
    return excludes.length > 0 ? ["--", ".", ...excludes] : [];
  }

  /** Porcelain status of a worktree that ignores the Project's tool state, which never counts as a change. */
  private async statusWithoutToolState(path: string, workId: string, gitOptions: readonly string[] = []): Promise<GitOperationResult> {
    const scope = await this.toolStateScope(path, workId);
    return this.git(path, [...gitOptions, "status", "--porcelain=v1", "--untracked-files=all", ...scope]);
  }

  private async toolStateExcludes(path: string, workId: string): Promise<string[]> {
    const toolState = this.toolStatePaths(workId);
    if (toolState.length === 0) return [];
    const tracked = await this.git(path, ["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", ...toolState.map((entry) => `:(literal)${entry}`)]);
    // Without a reliable answer, commit everything rather than risk dropping tracked changes.
    if (!tracked.ok) return [];
    const trackedFiles = tracked.message === "git operation completed" ? [] : tracked.message.split("\0").filter((entry) => entry.length > 0);
    // git add refuses an exclude pathspec that names an ignored path, and it
    // already skips ignored paths, so only unignored tool state is excluded.
    const ignored = await this.checkIgnoredPaths(path, toolState);
    const ignoredPaths = new Set(ignored.ok ? ignored.paths : []);
    return commitExcludePathspecs(toolState.filter((entry) => !ignoredPaths.has(entry)), (entry) => trackedFiles.some((file) => file === entry || file.startsWith(`${entry}/`)));
  }

  /** Drops ignored paths inside the Project's tool state: setup and refresh regenerate that content, so removing it loses nothing. */
  private withoutToolState(workId: string, paths: readonly string[]): string[] {
    const toolState = this.toolStatePaths(workId);
    if (toolState.length === 0) return [...paths];
    return paths.filter((path) => {
      const bare = path.replace(/\/+$/u, "");
      return !toolState.some((entry) => bare === entry || bare.startsWith(`${entry}/`));
    });
  }

  private async ensureIntegrationWorktree(
    canonical: string,
    baseBranch: string,
    integrationPath: string,
    workBranch: string,
  ): Promise<GitOperationResult> {
    const existingPath = await lstat(integrationPath).catch(() => null);
    if (existingPath) {
      const listed = await this.git(canonical, ["worktree", "list", "--porcelain"]);
      const registered = listed.ok && listed.message.split("\n").some((line) => line.trim() === `worktree ${integrationPath}`);
      if (registered) return { ok: true, exit_code: 0, recorded: false, worktree_path: integrationPath, message: "Reusing the existing Work integration worktree." };
      return { ok: false, exit_code: 1, recorded: false, worktree_path: integrationPath, message: "The Work integration path exists but is not registered with Git." };
    }
    await mkdir(resolve(integrationPath, ".."), { recursive: true });
    const branchExists = await this.git(canonical, ["show-ref", "--verify", "--quiet", `refs/heads/${workBranch}`]);
    const result = branchExists.exit_code === 0
      ? await this.git(canonical, ["worktree", "add", integrationPath, workBranch])
      : await this.git(canonical, ["worktree", "add", "-b", workBranch, integrationPath, baseBranch]);
    return {
      ok: result.ok,
      exit_code: result.exit_code,
      recorded: false,
      worktree_path: integrationPath,
      message: result.message,
    };
  }

  private projectFor(workId: string, includeVerificationPlan = false): ProjectRow | undefined {
    const row = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId);
    if (!row?.project_id) return undefined;
    return this.db.get<ProjectRow>(
      includeVerificationPlan
        ? "SELECT canonical_path, base_branch, allowed_roots_json, verification_plan_json, worktree_tool_state_json FROM projects WHERE id = ?"
        : "SELECT canonical_path, base_branch, allowed_roots_json, worktree_tool_state_json FROM projects WHERE id = ?",
      row.project_id,
    );
  }

  private async currentBranchOrHead(repositoryRoot: string): Promise<string> {
    const branch = await this.git(repositoryRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return branch.ok && branch.message.trim().length > 0 ? branch.message.trim() : "HEAD";
  }

  private async validProjectPath(canonicalPath: string, allowedRootsJson: string): Promise<string> {
    const canonical = await realpath(canonicalPath);
    let roots: unknown;
    try { roots = JSON.parse(allowedRootsJson) as unknown; } catch { throw new Error("Project allowed_roots is invalid JSON."); }
    if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string")) throw new Error("Project allowed_roots is invalid.");
    const resolvedRoots = await Promise.all((roots as string[]).map((root) => realpath(root)));
    if (!resolvedRoots.some((root) => inside(root, canonical))) throw new Error("Project canonical_path is outside allowed_roots.");
    return canonical;
  }

  /**
   * Owl's git behaviour does not depend on the machine: no repository hooks,
   * no system or global config, and Owl's own exclude list. The repository's
   * local config still applies. Only the user's content filters (for example
   * Git LFS) and trusted directories are carried over from their config.
   */
  private async isolatedInvocation(cwd: string, args: readonly string[]): Promise<{ args: string[]; options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv } }> {
    const carried = await this.carriedUserConfig();
    const excludes = await this.excludesFileFor(cwd);
    return {
      args: [...isolatedGitConfigArgs(excludes), ...carried, "-c", "core.quotePath=false", "-C", cwd, ...args],
      options: {
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    };
  }

  private carriedConfig: Promise<string[]> | null = null;

  /** `-c` arguments for the user's `filter.*` and `safe.directory` entries from their system and global config. */
  private carriedUserConfig(): Promise<string[]> {
    this.carriedConfig ??= readCarriedUserConfig();
    return this.carriedConfig;
  }

  private readonly excludesByCwd = new Map<string, Promise<string>>();

  /** Owl's exclude list, combined with the repository's own `core.excludesFile` when it sets one. */
  private excludesFileFor(cwd: string): Promise<string> {
    let pending = this.excludesByCwd.get(cwd);
    if (!pending) {
      pending = combinedExcludesFile(cwd, this.excludesFile);
      this.excludesByCwd.set(cwd, pending);
    }
    return pending;
  }

  /** Raw stdout of an isolated git command, or null when it fails. */
  private async gitStdout(cwd: string, args: readonly string[]): Promise<string | null> {
    try {
      const invocation = await this.isolatedInvocation(cwd, args);
      const result = await execFileAsync("git", invocation.args, invocation.options);
      return String(result.stdout ?? "");
    } catch {
      return null;
    }
  }

  private async git(cwd: string, args: readonly string[], input?: string): Promise<GitOperationResult> {
    try {
      const invocation = await this.isolatedInvocation(cwd, args);
      const pending = execFileAsync("git", invocation.args, invocation.options);
      if (input !== undefined) {
        // git may exit before reading all of stdin; the rejected promise reports that failure.
        pending.child.stdin?.on("error", () => {});
        pending.child.stdin?.end(input);
      }
      const result = await pending;
      return { ok: true, exit_code: 0, recorded: false, message: `${result.stdout}${result.stderr}`.trim() || "git operation completed" };
    } catch (error) {
      const failure = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      const exitCode = typeof failure.code === "number" ? failure.code : 1;
      const stderrTail = (failure.stderr ?? "").slice(-4_000);
      return {
        ok: false,
        exit_code: exitCode,
        recorded: false,
        message: `${failure.stderr ?? ""}${failure.stdout ?? ""}${failure.message ?? ""}`.trim() || "git operation failed",
        stderr_tail: stderrTail,
      };
    }
  }

  private inLane<T>(repositoryPath: string, operation: () => Promise<T>): Promise<T> {
    return this.lanes.run(repositoryPath, operation);
  }
}

function isolatedGitConfigArgs(excludesFile: string): string[] {
  return ["-c", "core.hooksPath=/dev/null", "-c", `core.excludesFile=${excludesFile}`];
}

/** The user's `filter.*` and `safe.directory` config entries as `-c` arguments. */
async function readCarriedUserConfig(): Promise<string[]> {
  const args: string[] = [];
  for (const scope of ["--system", "--global"]) {
    let stdout = "";
    try {
      const result = await execFileAsync("git", ["config", scope, "-z", "--get-regexp", "^(filter\\..+|safe\\.directory)$"], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      stdout = String(result.stdout ?? "");
    } catch {
      continue;
    }
    for (const record of stdout.split("\0")) {
      if (record.length === 0) continue;
      const newline = record.indexOf("\n");
      args.push("-c", newline < 0 ? record : `${record.slice(0, newline)}=${record.slice(newline + 1)}`);
    }
  }
  return args;
}

/** Owl's exclude file, or a content-hashed combination of it and the repository's own `core.excludesFile`. */
async function combinedExcludesFile(cwd: string, owlFile: string): Promise<string> {
  try {
    const configured = await execFileAsync("git", ["-C", cwd, "config", "--local", "--path", "--get", "core.excludesFile"], { timeout: 10_000, maxBuffer: 64 * 1024 });
    const value = String(configured.stdout ?? "").trim();
    if (value.length === 0) return owlFile;
    const repositoryFile = resolve(cwd, value);
    const repositoryContent = await readFile(repositoryFile, "utf8");
    const content = `${OWL_GIT_EXCLUDES_CONTENT}${repositoryContent.endsWith("\n") ? repositoryContent : `${repositoryContent}\n`}`;
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
    const combined = join(dirname(owlFile), `owl-git-excludes-${hash}`);
    await writeFile(combined, content);
    return combined;
  } catch {
    return owlFile;
  }
}

/** Destination paths from `git status --porcelain=v1 -z` output. */
function parsePorcelainZ(output: string): string[] {
  const records = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length < 4) continue;
    paths.push(record.slice(3));
    if (/[RC]/u.test(record.slice(0, 2))) index += 1;
  }
  return paths;
}

/** Write Owl's exclude list under the data dir, or a content-hashed temp path when that is not writable. */
function writeOwlExcludesFile(dataDir: string): string {
  const primary = join(dataDir, "owl-git-excludes");
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(primary, OWL_GIT_EXCLUDES_CONTENT);
    return primary;
  } catch {
    const hash = createHash("sha256").update(OWL_GIT_EXCLUDES_CONTENT).digest("hex").slice(0, 16);
    const fallback = join(tmpdir(), `owl-git-excludes-${hash}`);
    writeFileSync(fallback, OWL_GIT_EXCLUDES_CONTENT);
    return fallback;
  }
}

function integrationFailure(
  exitCode: number,
  message: string,
  aborted: boolean,
  abortMessage: string | null,
): GitIntegrationResult {
  return {
    ok: aborted,
    exit_code: exitCode === 0 ? 1 : exitCode,
    recorded: false,
    merged: false,
    message,
    aborted,
    abort_message: abortMessage,
    worktree_removed: false,
    removal_message: null,
  };
}

function validVerificationCommand(value: VerificationCommand): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return typeof value.command_id === "string" && value.command_id.length > 0 &&
    Array.isArray(value.argv) && value.argv.every((part) => typeof part === "string") &&
    typeof value.cwd === "string" && value.cwd.length > 0 &&
    Array.isArray(value.env_allowlist) && value.env_allowlist.every((key) => typeof key === "string") &&
    Number.isSafeInteger(value.timeout_seconds) && value.timeout_seconds >= 0 &&
    Number.isSafeInteger(value.stdout_limit) && value.stdout_limit >= 0 &&
    Number.isSafeInteger(value.stderr_limit) && value.stderr_limit >= 0 &&
    Array.isArray(value.expected_exit_codes) && value.expected_exit_codes.every((code) => Number.isSafeInteger(code)) &&
    (value.executor === "core" || value.executor === "reviewer");
}

function baseMovedResult(
  context: { readonly worktree_path: string; readonly base_branch: string; readonly work_branch: string },
  expectedBaseCommit: string,
  actualBaseCommit: string | null,
): GitWorkMergeResult {
  return {
    kind: "base_moved",
    ok: false,
    exit_code: 1,
    recorded: false,
    message: `Base branch ${context.base_branch} moved during verification; it was left unchanged by this merge.`,
    ...context,
    expected_base_commit: expectedBaseCommit,
    actual_base_commit: actualBaseCommit,
  };
}

function workMergeError(
  message: string,
  exitCode = 1,
  context: { readonly worktree_path?: string | null; readonly base_branch?: string | null; readonly work_branch?: string | null } = {},
): GitWorkMergeResult {
  return {
    kind: "error",
    ok: false,
    exit_code: exitCode === 0 ? 1 : exitCode,
    recorded: false,
    message,
    worktree_path: context.worktree_path ?? null,
    base_branch: context.base_branch ?? null,
    work_branch: context.work_branch ?? null,
  };
}
