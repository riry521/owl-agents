import { resolve } from "node:path";
import { builtinProviderHarness } from "@owl/shared";
import type { OwnerLanguage } from "./owner-language";
import type { AgentRunner, AgentRunRequest, CoreDatabase, CoreWriteLaneTransaction, JsonObject } from "./types";
import { resolveRoleModel } from "./workflow-engine.js";
import { describeServers, type Harness, type ToolingProblem, type WorkspaceSetupCommands, type WorkspaceTooling } from "./workspace-tooling.js";

/** Roles whose agents run inside a Task worktree. */
const WORKTREE_ROLES = ["worker", "designer", "lead_designer", "reviewer"] as const;

interface ProjectTooling {
  readonly id: string;
  readonly canonical_path: string;
  readonly commands: WorkspaceSetupCommands;
}

export interface AgentWorkspacePreparerDeps {
  readonly db: CoreDatabase;
  readonly writeLane: ReturnType<CoreDatabase["createWriteLane"]>;
  readonly tooling: WorkspaceTooling;
  readonly emitAlert: (payload: JsonObject) => Promise<void>;
  readonly language: () => OwnerLanguage;
}

/** The harnesses the worktree roles are configured to use; custom providers have no known harness and are left out. */
export function worktreeHarnesses(db: Pick<CoreDatabase, "get">): Harness[] {
  const harnesses = new Set<Harness>();
  for (const role of WORKTREE_ROLES) {
    try {
      const provider = resolveRoleModel(db, role)?.provider;
      const harness = provider ? builtinProviderHarness(provider) : null;
      if (harness) harnesses.add(harness);
    } catch {
      // Invalid model settings are reported where the role is launched.
    }
  }
  return [...harnesses].sort();
}

function commandArgv(raw: string | null | undefined): readonly string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((entry) => typeof entry === "string")) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

function problemLine(problem: ToolingProblem): string {
  const source = [problem.harness, problem.server].filter((part) => part !== null).join("/") || "setup";
  return `${source}: ${problem.kind} (${problem.detail})`;
}

function remediationFor(problems: readonly ToolingProblem[], language: OwnerLanguage): string {
  const kinds = new Set(problems.map((problem) => problem.kind));
  const lines: string[] = [];
  if (kinds.has("setup_failed") || kinds.has("refresh_failed")) {
    lines.push(language === "en"
      ? "Fix the worktree setup or refresh command in the Project settings, or clear it."
      : "Project 設定のワークツリー準備コマンド・更新コマンドを修正するか、空にしてください。");
  }
  if (kinds.has("failed") || kinds.has("timeout") || kinds.has("rehearsal_failed")) {
    lines.push(language === "en"
      ? "Run `claude mcp list` or `codex mcp list` in the Project directory and fix the servers that do not start."
      : "Project のディレクトリで `claude mcp list` または `codex mcp list` を実行し、起動しないサーバーを直してください。");
  }
  if (kinds.has("missing_in_worktree") || kinds.has("codex_project_untrusted")) {
    lines.push(language === "en"
      ? "Codex only loads a project's .codex/config.toml when the project is trusted. Trust it in Codex, or define the servers in ~/.codex/config.toml."
      : "Codex は信頼済みのプロジェクトでしか .codex/config.toml を読み込みません。Codex でプロジェクトを信頼するか、~/.codex/config.toml にサーバーを定義してください。");
  }
  return lines.join(" ");
}

/**
 * Gets a Task worktree ready for the agent about to run in it: a new worktree
 * gets the Project's setup command and an MCP rehearsal, and every later run
 * gets the refresh command, so indexes the agents rely on match the files.
 * What those commands create is recorded as the Project's tool state, which
 * Git operations keep out of commits. Problems become Owner alerts; they
 * never stop the agent from running.
 */
export class AgentWorkspacePreparer {
  private readonly created = new Set<string>();

  public constructor(private readonly deps: AgentWorkspacePreparerDeps) {}

  public markCreated(worktreePath: string): void {
    this.created.add(resolve(worktreePath));
  }

  public async beforeAgentRun(workId: string, worktree: unknown): Promise<void> {
    if (typeof worktree !== "string" || worktree.trim().length === 0) return;
    const path = resolve(worktree);
    const project = this.projectForWork(workId);
    if (!project) {
      this.created.delete(path);
      return;
    }
    try {
      if (this.created.delete(path)) await this.setUp(project, path);
      const refreshed = await this.deps.tooling.refreshBeforeRun({ worktree: path, sourceRoot: project.canonical_path, commands: project.commands });
      if (refreshed === null) return;
      await this.recordToolState(project.id, refreshed.tool_state_paths);
      const { result } = refreshed;
      const failed = result.exit_code !== 0 || result.timed_out;
      const detail = result.timed_out
        ? "the refresh command timed out"
        : `the refresh command exited with code ${result.exit_code ?? "null"}${result.error ? `: ${result.error}` : ""}`;
      if (failed) console.warn(`[owl-core] Worktree refresh failed in ${path}: ${detail}`);
      await this.report(project, "refresh", failed ? [{ harness: null, server: null, kind: "refresh_failed", detail }] : []);
    } catch (error) {
      console.error(`[owl-core] Could not prepare agent tools in ${path}`, error);
    }
  }

  private async setUp(project: ProjectTooling, worktree: string): Promise<void> {
    const outcome = await this.deps.tooling.prepareNewWorktree({
      projectKey: project.id,
      sourceRoot: project.canonical_path,
      worktree,
      commands: project.commands,
    });
    await this.recordToolState(project.id, outcome.tool_state_paths);
    const setupProblem = outcome.setup_problem ?? outcome.rehearsal?.problems.find((problem) => problem.kind === "setup_failed");
    if (outcome.setup !== null) await this.report(project, "setup", setupProblem ? [setupProblem] : []);
    if (outcome.rehearsal) {
      console.info(`[owl-core] ${describeServers(outcome.rehearsal)} (${project.canonical_path})`);
      await this.report(project, "rehearsal", outcome.rehearsal.problems.filter((problem) => problem.kind !== "setup_failed"));
    }
  }

  private async report(project: ProjectTooling, scope: "setup" | "refresh" | "rehearsal", problems: readonly ToolingProblem[]): Promise<void> {
    const alert = this.deps.tooling.alertFor(`${project.id}:${scope}`, problems);
    if (!alert) return;
    const language = this.deps.language();
    if (alert.kind === "agent_tooling_recovered") {
      await this.deps.emitAlert({
        kind: "agent_tooling_recovered",
        schema_version: "1.0.0",
        project_id: project.id,
        path: project.canonical_path,
        scope,
        message: language === "en"
          ? `Agent tools for ${project.canonical_path} are working again (${scope}).`
          : `${project.canonical_path} のエージェント用ツールが復旧しました（${scope}）。`,
      });
      return;
    }
    const lines = alert.problems.map(problemLine);
    const remediation = remediationFor(alert.problems, language);
    await this.deps.emitAlert({
      kind: "agent_tooling_mismatch",
      schema_version: "1.0.0",
      project_id: project.id,
      path: project.canonical_path,
      scope,
      problems: alert.problems.map((problem) => ({ ...problem })),
      message: language === "en"
        ? `Agents working on ${project.canonical_path} may not get their tools (${scope}): ${lines.join("; ")}. ${remediation}`
        : `${project.canonical_path} で作業するエージェントがツールを使えない可能性があります（${scope}）: ${lines.join("; ")}。${remediation}`,
      remediation,
    });
  }

  /** Adds newly created paths to the Project's tool state. The list only grows, so a later commit never picks up an older tool's output. */
  private async recordToolState(projectId: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.deps.writeLane.transact((transaction: CoreWriteLaneTransaction) => {
      const row = transaction.get<{ worktree_tool_state_json: string }>("SELECT worktree_tool_state_json FROM projects WHERE id = ?", projectId);
      if (!row) return;
      let current: string[] = [];
      try {
        const parsed: unknown = JSON.parse(row.worktree_tool_state_json);
        if (Array.isArray(parsed)) current = parsed.filter((entry): entry is string => typeof entry === "string");
      } catch (error) {
        console.warn(`[owl-core] Unreadable worktree_tool_state_json for Project ${projectId}; recording only the new paths:`, error);
        current = [];
      }
      const merged = [...new Set([...current, ...paths])].sort();
      if (merged.length === current.length) return;
      transaction.run("UPDATE projects SET worktree_tool_state_json = ? WHERE id = ?", JSON.stringify(merged), projectId);
    });
  }

  private projectForWork(workId: string): ProjectTooling | null {
    const row = this.deps.db.get<{ id: string; canonical_path: string; worktree_prepare_argv_json: string; worktree_refresh_argv_json: string }>(
      `SELECT projects.id, projects.canonical_path, projects.worktree_prepare_argv_json, projects.worktree_refresh_argv_json
         FROM works JOIN projects ON projects.id = works.project_id
        WHERE works.id = ?`,
      workId,
    );
    if (!row) return null;
    return {
      id: row.id,
      canonical_path: row.canonical_path,
      commands: { setup: commandArgv(row.worktree_prepare_argv_json), refresh: commandArgv(row.worktree_refresh_argv_json) },
    };
  }
}

/** An AgentRunner that gets the Task worktree ready before each Worker, Designer and Reviewer run. */
export function withWorkspacePreparation(runner: AgentRunner, preparer: AgentWorkspacePreparer): AgentRunner {
  const prepare = (request: AgentRunRequest): Promise<void> => preparer.beforeAgentRun(request.work_id, request.context?.worktree);
  return {
    runManagerPlan: (request) => runner.runManagerPlan(request),
    runDesigner: async (request) => { await prepare(request); return runner.runDesigner(request); },
    runWorker: async (request) => { await prepare(request); return runner.runWorker(request); },
    runReviewer: async (request) => { await prepare(request); return runner.runReviewer(request); },
    runAdvisor: (request) => runner.runAdvisor(request),
    ...(runner.runCurator ? { runCurator: (request: Parameters<NonNullable<AgentRunner["runCurator"]>>[0]) => runner.runCurator!(request) } : {}),
    ...(runner.cancelAgent ? { cancelAgent: (invocationId: string, force?: boolean) => runner.cancelAgent!(invocationId, force) } : {}),
    ...(runner.setProcessObserver ? { setProcessObserver: (observer: Parameters<NonNullable<AgentRunner["setProcessObserver"]>>[0]) => runner.setProcessObserver!(observer) } : {}),
    ...(runner.setPromptObserver ? { setPromptObserver: (observer: Parameters<NonNullable<AgentRunner["setPromptObserver"]>>[0]) => runner.setPromptObserver!(observer) } : {}),
    ...(runner.setOutputObserver ? { setOutputObserver: (observer: (invocationId: string) => void) => runner.setOutputObserver!(observer) } : {}),
  };
}
