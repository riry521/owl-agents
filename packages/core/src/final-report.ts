import {
  readFinalReportCheckOutput,
  type FinalReportCheckInput,
  type FinalReportRequest,
  type FinalReportRunResult,
  type FinalReportSections,
} from "../../shared/dist/final-report.js";
import { readStoredAcceptanceCriteria } from "../../shared/dist/acceptance-criteria.js";
import { goalShortfallsOfWork } from "./goal-shortfalls";
import type { CoreDatabase, CoreWriteLaneTransaction } from "./types";

type WriteLaneLike = { transact<T>(callback: (transaction: CoreWriteLaneTransaction) => T): Promise<T> };

/** A checker of the final report sections; the server builds it from final_report_text_checks. */
export interface FinalReportCheck {
  readonly name: string;
  run(input: FinalReportCheckInput, signal: AbortSignal): Promise<unknown>;
}

export interface FinalReporterDeps {
  readonly db: CoreDatabase;
  readonly writeLane: WriteLaneLike;
  readonly runner: () => { runFinalReport?: (request: FinalReportRequest) => Promise<FinalReportRunResult> };
  readonly roleModel: (role: string) => { model: string; provider: string; effort?: string } | undefined;
  readonly rules: (workId: string) => string | null;
  readonly language: () => "ja" | "en";
  readonly timeoutSeconds: () => number;
  /** Called in order on the sections; none means the report is stored as the model wrote it. */
  readonly textChecks: () => readonly FinalReportCheck[];
}

/** The model is asked to rewrite once after a failed check, never more. */
const REWRITES_MAX = 1;

export interface StoredFinalReport extends FinalReportSections { readonly created_at: string }

/** works' final_report as the API returns it; null when none was stored. */
export function readFinalReport(db: Pick<CoreDatabase, "get">, workId: string): StoredFinalReport | null {
  return db.get<StoredFinalReport>("SELECT summary, test_results, issues, created_at FROM work_final_reports WHERE work_id = ?", workId) ?? null;
}

/** Writes the final report of a completed Work. A failure leaves no report; it is logged and never reaches the caller. */
export class FinalReporter {
  public constructor(private readonly deps: FinalReporterDeps) {}

  public async generate(workId: string, finalVerdictSummary: string): Promise<void> {
    try {
      const { db } = this.deps;
      if (readFinalReport(db, workId)) return;
      const work = db.get<{ title: string; summary: string }>("SELECT title, summary FROM works WHERE id = ?", workId);
      const runner = this.deps.runner();
      if (!work || typeof runner.runFinalReport !== "function") throw new Error("runner_unavailable");
      const model = this.deps.roleModel("manager");
      const timeoutMs = this.deps.timeoutSeconds() * 1000;
      const first: FinalReportRequest = {
        language: this.deps.language(),
        work,
        final_verdict_summary: finalVerdictSummary,
        tasks: this.tasksOf(workId),
        goal_shortfalls: goalShortfallsOfWork(db, workId) as never,
        rules: this.deps.rules(workId),
        revision: null,
        ...(model ? { provider: model.provider, model: model.model, ...(model.effort ? { effort: model.effort } : {}) } : {}),
        timeout_ms: timeoutMs,
      };
      // One deadline covers the model, every check and the rewrite; aborting it stops a running checker.
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs); });
      const report = await Promise.race([this.produce(runner.runFinalReport.bind(runner), first, controller.signal, Date.now() + timeoutMs), timeout]).finally(() => clearTimeout(timer));
      await this.deps.writeLane.transact((transaction) => {
        transaction.run(
          "INSERT OR IGNORE INTO work_final_reports (work_id, summary, test_results, issues, created_at) VALUES (?, ?, ?, ?, ?)",
          workId, report.summary, report.test_results, report.issues, new Date().toISOString(),
        );
      });
    } catch (error) {
      console.error(`[owl-core] Final report failed for ${workId}`, error);
    }
  }

  private async produce(
    run: (request: FinalReportRequest) => Promise<FinalReportRunResult>,
    first: FinalReportRequest,
    signal: AbortSignal,
    deadline: number,
  ): Promise<FinalReportSections> {
    const checks = this.deps.textChecks();
    let request = first;
    for (let rewrites = 0; ; rewrites += 1) {
      const result = await run(request);
      if (!result.ok) throw new Error(result.error);
      const problems = await this.problemsOf(result.report, first.language, checks, signal);
      // After the one rewrite the report is stored as it is, even when the check still finds problems.
      if (problems.length === 0 || rewrites >= REWRITES_MAX) return result.report;
      request = { ...first, timeout_ms: Math.max(1, deadline - Date.now()), revision: { report: result.report, problems } };
    }
  }

  private async problemsOf(report: FinalReportSections, language: "ja" | "en", checks: readonly FinalReportCheck[], signal: AbortSignal): Promise<readonly string[]> {
    for (const check of checks) {
      if (signal.aborted) throw new Error("timeout");
      const problems = readFinalReportCheckOutput(await check.run({ language, summary: report.summary, test_results: report.test_results, issues: report.issues }, signal));
      if (problems) return problems;
    }
    return [];
  }

  /** Each live Task with its criteria and its latest report; no ids, as the reader is the Owner. */
  private tasksOf(workId: string): FinalReportRequest["tasks"] {
    const { db } = this.deps;
    return db.all<{ id: string; title: string; status: string; acceptance: string; acceptance_criteria_json: string | null }>(
      "SELECT id, title, status, acceptance, acceptance_criteria_json FROM tasks WHERE work_id = ? AND superseded_at IS NULL ORDER BY created_at ASC, id ASC",
      workId,
    ).map((task) => {
      const row = db.get<{ payload_json: string }>(
        `SELECT reports.payload_json FROM reports JOIN agent_runs ON agent_runs.id = reports.agent_run_id
          WHERE agent_runs.task_id = ? ORDER BY reports.created_at DESC LIMIT 1`,
        task.id,
      );
      const report = row ? JSON.parse(row.payload_json) as Record<string, unknown> : null;
      return {
        title: task.title,
        status: task.status,
        acceptance_criteria: readStoredAcceptanceCriteria(task.acceptance_criteria_json, task.acceptance).map((c) => ({ id: c.id, text: c.text })),
        report: report ? { work_done: report.work_done ?? null, verification: report.verification ?? null, remaining_issues: report.remaining_issues ?? [] } : null,
      } as never;
    });
  }
}
