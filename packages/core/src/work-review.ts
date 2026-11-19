import { createUlid, utcNow } from "@owl/db";
import { DEFAULT_HARNESS_MODELS, usageJson, workReviewFilePath } from "@owl/shared";
import { setAgentRunStatus } from "./agent-run-state";
import { workReview } from "./assurance-settings";
import { taskDependencyIds } from "./context-builder";
import { ownerLanguage } from "./owner-language";
import { rethrowUnlessRateLimited, type ProviderPauseController } from "./provider-pause-controller";
import type { AgentRunResult, CoreDatabase, JsonObject, TaskRow, WorkCheckout } from "./types";
import { fitWorkReviewMaterial, workReviewContext, writeWorkReviewFile, type WorkReviewFinding, type WorkReviewTaskEntry } from "./work-review-material";
import {
  isReviewHanded,
  previousReview,
  recordReviewCompleted,
  recordReviewStarted,
  reviewForCommit,
  reviewsSinceDecision,
  type StoredWorkReview,
  type WorkReviewWriteLane,
} from "./work-review-store";
import { resolveRoleModel } from "./workflow-engine";
import type { ManagerTrigger } from "@owl/shared";

export type WorkReviewOutcome =
  | { readonly kind: "proceed"; readonly final_context: JsonObject | null }
  | { readonly kind: "wait" };

type StoredReport = { task: TaskRow; report: JsonObject; path: string | null };

export interface WorkReviewHost {
  readonly db: CoreDatabase;
  readonly writeLane: WorkReviewWriteLane & { transact<T>(fn: (transaction: never) => T): Promise<T> };
  readonly git: { withWorkCheckout?<T>(request: { readonly work_id: string }, fn: (checkout: WorkCheckout) => Promise<T>): Promise<T | null> };
  readonly dataDir: string;
  readonly started: () => boolean;
  readonly runner: () => { runWorkReview?: (request: JsonObject) => Promise<AgentRunResult> };
  readonly providerPauseController: ProviderPauseController;
  readonly taskReports: (workId: string, tasks: readonly TaskRow[]) => StoredReport[];
  readonly maxChars: () => number;
  readonly triggerManagerReplan: (workId: string, failed: readonly string[], trigger: ManagerTrigger) => Promise<void>;
  readonly composeReviewerInputs: (workId: string) => Promise<{ rules: string | null; skills: string | null; knowledge: string | null }>;
}

/** What one pass inside the checkout decided; the Manager is called after the checkout is released. */
type Decision =
  | { readonly kind: "existing"; readonly review: StoredWorkReview }
  | { readonly kind: "limit" }
  | { readonly kind: "wait" }
  | { readonly kind: "ran"; readonly review: StoredWorkReview };

export class WorkReviewRunner {
  constructor(private readonly host: WorkReviewHost) {}

  /** Runs the whole-Work review once per Work commit, before the final check; an error never stops the Work. */
  async run(workId: string): Promise<WorkReviewOutcome> {
    const proceed: WorkReviewOutcome = { kind: "proceed", final_context: null };
    const { db } = this.host;
    const settings = workReview(db);
    if (!settings.enabled) return proceed;
    const work = db.get<{ size: string; project_id: string | null }>("SELECT size, project_id FROM works WHERE id = ?", workId);
    if (!work || work.project_id === null || !(settings.sizes as readonly string[]).includes(work.size)) return proceed;
    const tasks = db.all<TaskRow>(
      `SELECT * FROM tasks
        WHERE work_id = ? AND superseded_at IS NULL AND status = 'completed' AND type <> 'design'
        ORDER BY created_at ASC, id ASC`,
      workId,
    );
    if (tasks.length < settings.min_tasks) return proceed;
    const runner = this.host.runner();
    const withCheckout = this.host.git.withWorkCheckout?.bind(this.host.git);
    if (typeof runner.runWorkReview !== "function" || withCheckout === undefined) return proceed;

    let decision: Decision | null;
    try {
      decision = await withCheckout({ work_id: workId }, (checkout) => this.decide(workId, tasks, checkout, settings.max_rounds));
    } catch (error) {
      console.error(`[owl-core] The whole-Work review of Work ${workId} could not run`, error);
      if (!this.host.started()) return { kind: "wait" };
      await this.recordError(workId, createUlid(), "", error);
      return proceed;
    }
    if (!this.host.started() || decision === null) return decision === null ? proceed : { kind: "wait" };
    switch (decision.kind) {
      case "wait": return { kind: "wait" };
      case "limit": return proceed;
      case "existing": return this.afterExisting(workId, decision.review);
      case "ran": return this.afterRun(workId, decision.review, settings.max_rounds);
    }
  }

  private async afterExisting(workId: string, review: StoredWorkReview): Promise<WorkReviewOutcome> {
    if (review.routed_to === "manager" && !isReviewHanded(this.host.db, workId, review.agent_run_id)) {
      // A restart lost the hand-over: send the recorded findings again instead of reviewing the same commit twice.
      await this.host.triggerManagerReplan(workId, [], { kind: "work_review_gaps", review_agent_run_id: review.agent_run_id, round: review.round });
      return { kind: "wait" };
    }
    return { kind: "proceed", final_context: this.finalContext(workId, review) };
  }

  private async afterRun(workId: string, review: StoredWorkReview, maxRounds: number): Promise<WorkReviewOutcome> {
    if (review.routed_to === "manager") {
      await this.host.triggerManagerReplan(workId, [], { kind: "work_review_gaps", review_agent_run_id: review.agent_run_id, round: review.round });
      void maxRounds;
      return { kind: "wait" };
    }
    return { kind: "proceed", final_context: this.finalContext(workId, review) };
  }

  /** Findings the Final Manager must weigh: gaps that were not (or could not be) fixed in this Work. */
  private finalContext(workId: string, review: StoredWorkReview): JsonObject | null {
    if (review.status === "error" || review.findings.length === 0) return null;
    return workReviewContext(this.host.dataDir, workId, review, this.host.maxChars());
  }

  private async decide(workId: string, tasks: readonly TaskRow[], checkout: WorkCheckout, maxRounds: number): Promise<Decision> {
    const { db } = this.host;
    const existing = reviewForCommit(db, workId, checkout.commit);
    if (existing !== null) return { kind: "existing", review: existing };
    const before = reviewsSinceDecision(db, workId);
    if (before >= maxRounds) return { kind: "limit" };
    const roleModel = resolveRoleModel(db, "reviewer", { anyRoleDefault: true });
    const provider = roleModel?.provider ?? "anthropic";
    if (this.host.providerPauseController.isPaused(provider)) return { kind: "wait" };

    const round = before + 1;
    const agentRunId = createUlid();
    const previous = previousReview(db, workId);
    const previousAt = previous === null
      ? null
      : db.get<{ created_at: string }>("SELECT created_at FROM events WHERE idempotency_key = ?", `work-review-completed:${previous.agent_run_id}`)?.created_at ?? null;
    const reports = new Map(this.host.taskReports(workId, tasks).map((entry) => [entry.task.id, entry]));
    const taskIds = new Set(tasks.map((task) => task.id));
    const entries: WorkReviewTaskEntry[] = tasks.map((task) => {
      const stored = reports.get(task.id);
      const report = stored?.report ?? {};
      const changes = Array.isArray(report.changes) ? report.changes : [];
      const issues = Array.isArray(report.remaining_issues) ? report.remaining_issues : [];
      return {
        task_id: task.id,
        title: task.title,
        type: task.type,
        focus: previousAt !== null && task.created_at > previousAt,
        depends_on: taskDependencyIds(db, task.id).filter((id) => taskIds.has(id)),
        work_done: typeof report.work_done === "string" ? report.work_done : "",
        changed_files: changes.flatMap((change) => (typeof change === "object" && change !== null && typeof (change as { file?: unknown }).file === "string" ? [(change as { file: string }).file] : [])),
        remaining_issues: issues.map((issue) => String(typeof issue === "object" && issue !== null ? (issue as { issue?: unknown }).issue ?? "" : issue)),
        report_path: stored?.path ?? null,
      };
    });
    const previousFindings: readonly WorkReviewFinding[] = previous?.findings ?? [];
    const materialPath = writeWorkReviewFile(workReviewFilePath(this.host.dataDir, workId, agentRunId, "material"), {
      work_id: workId,
      round,
      base_commit: checkout.base_commit,
      work_commit: checkout.commit,
      tasks: entries.map(({ task_id, title, type, focus, depends_on, changed_files, report_path }) => ({ task_id, title, type, focus, depends_on, changed_files, report_path })),
      previous_findings: previousFindings,
    });
    const workRow = db.get<{ title: string; summary: string }>("SELECT title, summary FROM works WHERE id = ?", workId);
    const inputs = await this.host.composeReviewerInputs(workId);
    const model = roleModel?.model ?? DEFAULT_HARNESS_MODELS.claude;
    await recordReviewStarted(this.host.writeLane, workId, { agent_run_id: agentRunId, round, work_commit: checkout.commit }, (transaction) => {
      const now = utcNow();
      transaction.run(
        `INSERT INTO agent_runs
           (id, work_id, task_id, role, provider, model, effort, status, started_at, created_at, updated_at)
         VALUES (?, ?, NULL, 'reviewer', ?, ?, ?, 'running', ?, ?, ?)`,
        agentRunId, workId, provider, model, roleModel?.effort ?? null, now, now, now,
      );
    });
    const projectId = db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId)?.project_id;
    const runner = this.host.runner();
    let result: AgentRunResult;
    try {
      result = await runner.runWorkReview!({
        invocation_id: agentRunId,
        language: ownerLanguage(db),
        work_id: workId,
        ...(projectId ? { project_id: projectId } : {}),
        provider,
        model,
        effort: roleModel?.effort,
        context: {
          worktree: checkout.path,
          base_commit: checkout.base_commit,
          work_commit: checkout.commit,
          round,
          task_ids: tasks.map((task) => task.id),
          work: { title: workRow?.title ?? "", summary: workRow?.summary ?? "" },
          material: fitWorkReviewMaterial({ tasks: entries, previous_findings: previousFindings }, this.host.maxChars(), materialPath),
          rules: inputs.rules,
          skills: inputs.skills,
          knowledge: inputs.knowledge,
        },
      } as unknown as JsonObject).catch(rethrowUnlessRateLimited);
    } catch (error) {
      await this.finishRun(agentRunId, "failed", null);
      if (!this.host.started()) return { kind: "wait" };
      console.error(`[owl-core] The whole-Work review of Work ${workId} failed`, error);
      return { kind: "ran", review: await this.recordError(workId, agentRunId, checkout.commit, error, round, checkout.base_commit) };
    }
    if (!this.host.started()) return { kind: "wait" };
    const rateLimited = result.failure_class === "rate_limited" || (result.rate_limit !== undefined && result.rate_limit !== null);
    if (rateLimited || this.host.providerPauseController.isPaused(provider)) {
      if (rateLimited) {
        await this.host.providerPauseController.recordRateLimit({
          provider,
          resets_at: result.rate_limit?.resets_at ?? null,
          role: "reviewer",
          work_id: workId,
          task_id: null,
          last_error_key: result.error_key ?? "rate_limited",
          last_error: result.message ?? null,
        });
      }
      await this.finishRun(agentRunId, "failed", result);
      return { kind: "wait" };
    }
    const report = result.report as { summary?: unknown; findings?: unknown } | undefined;
    if (result.outcome !== "success" || result.report_valid !== true || !report || !Array.isArray(report.findings)) {
      await this.finishRun(agentRunId, "failed", result);
      const message = result.message ?? `The whole-Work review did not finish (outcome=${String(result.outcome)}).`;
      return { kind: "ran", review: await this.recordError(workId, agentRunId, checkout.commit, new Error(message), round, checkout.base_commit) };
    }
    const findings = report.findings as readonly WorkReviewFinding[];
    // Why a round below max_rounds goes to the Manager and the last one does not: a final fix could not be reviewed again, so the gap goes to the final check instead.
    const toManager = findings.length > 0 && round < maxRounds;
    const review: StoredWorkReview = {
      agent_run_id: agentRunId,
      round,
      work_commit: checkout.commit,
      base_commit: checkout.base_commit,
      status: findings.length > 0 ? "gaps" : "passed",
      routed_to: toManager ? "manager" : "final_manager",
      summary: typeof report.summary === "string" ? report.summary : "",
      findings,
      message: null,
    };
    await recordReviewCompleted(this.host.writeLane, workId, review, (transaction) => {
      setAgentRunStatus(transaction as never, agentRunId, "completed", { now: utcNow(), from: ["running"], usageJson: usageJson(result.usage) });
    });
    return { kind: "ran", review };
  }

  private async finishRun(agentRunId: string, status: "failed" | "completed", result: AgentRunResult | null): Promise<void> {
    await this.host.writeLane.transact((transaction) => {
      setAgentRunStatus(transaction as never, agentRunId, status, { now: utcNow(), from: ["running"], usageJson: result === null ? undefined : usageJson(result.usage) });
    });
  }

  /** An error review lets the Work go on to the final check; it is recorded so the same commit is not reviewed again. */
  private async recordError(workId: string, agentRunId: string, commit: string, error: unknown, round = 1, baseCommit: string | null = null): Promise<StoredWorkReview> {
    const review: StoredWorkReview = {
      agent_run_id: agentRunId,
      round,
      work_commit: commit,
      base_commit: baseCommit,
      status: "error",
      routed_to: "final_manager",
      summary: "",
      findings: [],
      message: error instanceof Error ? error.message : String(error),
    };
    await recordReviewCompleted(this.host.writeLane, workId, review);
    return review;
  }
}
