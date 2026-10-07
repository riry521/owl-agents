import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_DEPENDENCY_SUMMARY_SETTINGS } from "../../shared/dist/dependency-summary-settings.js";
import { designDocumentPath, readTestPolicy, taskReportPath } from "@owl/shared";
import { readStoredAcceptanceCriteria } from "../../shared/dist/acceptance-criteria.js";
import { readStoredTaskPlanContext } from "../../shared/dist/task-necessity.js";
import { uniqueSorted } from "./context-canonical";
import type { CoreDatabase, JsonObject, TaskRow } from "./types";
import type { IndexInjector } from "./memory/index-injector.js";
import { searchQuery } from "./memory/memory-injector.js";
import { parseWorkRules, type RuleRole, type RuleStore } from "./rule-store";
import type { SkillBox } from "./skill-box";
import { dependencySummarySettings } from "./dependency-summary-settings.js";
import { ownerGuidance } from "./owner-guidance.js";

export type ContextReader = Pick<CoreDatabase, "get" | "all">;

export function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseObject(json: string): JsonObject | null {
  try {
    const value = JSON.parse(json) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}


export function taskDependencyIds(db: ContextReader, taskId: string): string[] {
  return db.all<{ depends_on_task_id: string }>(
    "SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id ASC",
    taskId,
  ).map((row) => row.depends_on_task_id);
}

/** The Manager's context, notes and necessity as separate fields; plan_context_legacy marks a Task whose context text is kept whole. */
export function planContextFields(row: TaskRow): JsonObject {
  const { legacy, ...fields } = readStoredTaskPlanContext(row.plan_context_json, row.context);
  return { ...fields, ...(legacy ? { plan_context_legacy: true } : {}) } as unknown as JsonObject;
}

/**
 * The TaskDetail a Worker or Reviewer reads: plan fields, status and the
 * Task's real dependencies. Internals (error hashes, worktree paths, leases,
 * cascade markers) are not part of it.
 */
export function roleTaskView(row: TaskRow, dependsOn: readonly string[]): JsonObject {
  return {
    id: row.id,
    work_id: row.work_id,
    title: row.title,
    type: row.type,
    status: row.status,
    state_version: row.state_version,
    updated_at: row.updated_at,
    parent_task_id: row.parent_task_id,
    acceptance_criteria: readStoredAcceptanceCriteria(row.acceptance_criteria_json, row.acceptance) as unknown as JsonObject[],
    ...planContextFields(row),
    review_round: row.review_round,
    failure_count: row.failure_count,
    worker_generation: row.worker_generation,
    ...(row.review_override === null ? {} : { review: row.review_override === "true" }),
    depends_on: [...dependsOn],
  };
}

/**
 * The Task fields a Reviewer needs to judge the Worker's report: the plan
 * (title/acceptance/context), the review state, and real dependencies.
 * Internal bookkeeping (status, state_version, timestamps, failure/generation
 * counters) is Core's own and is left out.
 */
export function reviewerTaskView(row: TaskRow, dependsOn: readonly string[]): JsonObject {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    acceptance_criteria: readStoredAcceptanceCriteria(row.acceptance_criteria_json, row.acceptance) as unknown as JsonObject[],
    ...planContextFields(row),
    review_round: row.review_round,
    depends_on: [...dependsOn],
    ...(row.review_override === null ? {} : { review: row.review_override === "true" }),
  };
}

/** The latest Worker report stored for a Task, or null. */
export function latestTaskReport(db: ContextReader, taskId: string): JsonObject | null {
  const row = db.get<{ payload_json: string }>(
    `SELECT reports.payload_json
       FROM reports JOIN agent_runs ON agent_runs.id = reports.agent_run_id
      WHERE agent_runs.task_id = ?
      ORDER BY reports.created_at DESC LIMIT 1`,
    taskId,
  );
  return row ? parseObject(row.payload_json) : null;
}

function agentRunReport(db: ContextReader, agentRunId: string): JsonObject | null {
  const row = db.get<{ payload_json: string }>(
    "SELECT payload_json FROM reports WHERE agent_run_id = ? LIMIT 1",
    agentRunId,
  );
  return row ? parseObject(row.payload_json) : null;
}

/** The three report fields another agent builds on; a missing field is ""/[]. */
export function reportSummary(report: JsonObject): JsonObject {
  return {
    work_done: typeof report.work_done === "string" ? report.work_done : "",
    changes: Array.isArray(report.changes) ? report.changes.filter(isRecord) : [],
    remaining_issues: Array.isArray(report.remaining_issues) ? report.remaining_issues : [],
  };
}

/** Legacy Core routing fields are not part of a report another agent reads. */
function workerReportOnly(report: JsonObject): JsonObject {
  const { verdict: _verdict, retry_subtasks: _retrySubtasks, ...rest } = report;
  return rest;
}

/** Reads the full report behind a dependency entry's report_path; null if it is missing or invalid. */
export function readDependencyReport(reportPath: string): JsonObject | null {
  try {
    return parseObject(readFileSync(reportPath, "utf8"));
  } catch {
    return null;
  }
}

/** Writes the full report for report_path; a failed write is logged and gives null, never an exception. */
function writeDependencyReport(dataDir: string, workId: string, taskId: string, report: JsonObject): string | null {
  const path = taskReportPath(dataDir, workId, taskId);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify(workerReportOnly(report), null, 2), { mode: 0o600 });
    renameSync(temp, path);
    return path;
  } catch (error) {
    console.warn(`[owl-core] Could not write the full report of Task ${taskId} to ${path}`, error);
    return null;
  }
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

export interface DependencyContext {
  readonly depends_on: string[];
  /** Per completed dependency: what it did, what it changed, what it left open. */
  readonly dependency_reports: JsonObject[];
  /** Recorded code/generated artifact paths of the completed dependencies. */
  readonly artifact_paths: string[];
}

/** The results of the Tasks a Task depends on. */
export function dependencyContext(
  db: ContextReader,
  taskId: string,
  dataDir: string,
  summaryMaxChars: number = DEFAULT_DEPENDENCY_SUMMARY_SETTINGS.max_chars,
): DependencyContext {
  const dependsOn = taskDependencyIds(db, taskId);
  if (dependsOn.length === 0) return { depends_on: [], dependency_reports: [], artifact_paths: [] };
  const placeholders = dependsOn.map(() => "?").join(",");
  const completed = db.all<{ id: string; work_id: string; manager_task_id: string | null; title: string; type: string }>(
    `SELECT id, work_id, manager_task_id, title, type FROM tasks
      WHERE id IN (${placeholders}) AND status = 'completed'
      ORDER BY id ASC`,
    ...dependsOn,
  );
  const dependencyReports: JsonObject[] = [];
  for (const dependency of completed) {
    const report = latestTaskReport(db, dependency.id);
    const summary = reportSummary(report ?? {});
    const changes = summary.changes as JsonObject[];
    const remainingIssues = summary.remaining_issues as unknown[];
    dependencyReports.push({
      task_id: dependency.id,
      manager_task_id: dependency.manager_task_id,
      title: dependency.title,
      work_done: clip(summary.work_done as string, summaryMaxChars),
      changed_files: uniqueSorted(changes.map((change) => (typeof change.file === "string" ? change.file : ""))),
      open_issues: remainingIssues.map((item) => (isRecord(item) ? item.issue : item)).filter((issue): issue is string => typeof issue === "string"),
      design_document_path: dependency.type === "design" ? designDocumentPath(dataDir, dependency.work_id, dependency.id) : null,
      report_path: report === null ? null : writeDependencyReport(dataDir, dependency.work_id, dependency.id, report),
    });
  }
  const artifactPaths: string[] = [];
  if (completed.length > 0) {
    const rows = db.all<{ path: string }>(
      `SELECT path FROM artifacts
        WHERE task_id IN (${completed.map(() => "?").join(",")}) AND kind IN ('code', 'generated')`,
      ...completed.map((dependency) => dependency.id),
    );
    artifactPaths.push(...uniqueSorted(rows.map((row) => row.path)));
  }
  return { depends_on: dependsOn, dependency_reports: dependencyReports, artifact_paths: artifactPaths };
}

/**
 * What the latest attempt of a Task was told to fix. The latest of
 * Core verification and Reviewer verdict decides: a failed verification
 * gives verification_failure, a fix/replan review gives reviewer_findings,
 * never both, and a pass after either clears it. Each comes with the report
 * of the attempt it judged. Older rounds are not repeated. A Reviewer that
 * itself failed (review.failed without a review) produced no findings and
 * does not count.
 */
export interface FixContext {
  /** The report of the attempt this judged (null if it has none). */
  readonly previous_report: JsonObject | null;
  readonly reviewer_findings?: unknown[];
  readonly verification_failure?: JsonObject;
  /** The process the previous Worker run left running (it ended or its done file appeared). */
  readonly process_wait?: JsonObject;
}

/**
 * L2: the sequence of the latest event that started a new line of attempts
 * for the Task: a Manager replan that retried it (Work-level task.replanned
 * listing it, or a per-Task one), a restore after a cascade failure
 * (task.dependency_restored), or the Owner's answer to a Decision that
 * blocked it (decision.resolved). These are mostly Work-scoped events
 * (task_id NULL), so a per-Task event query alone cannot see them. Verdicts
 * at or before it judged a plan the Task no longer follows. Shared by
 * loadFixContext. 0 when there is none.
 */
function attemptLineBoundary(db: ContextReader, taskId: string): number {
  const row = db.get<{ boundary: number | null }>(
    `SELECT MAX(events.sequence) AS boundary
       FROM events
      WHERE events.work_id = (SELECT work_id FROM tasks WHERE id = ?)
        AND (
          (events.type = 'task.replanned'
           AND (events.task_id = ?
                OR EXISTS (SELECT 1 FROM json_each(events.payload_json, '$.task_ids') WHERE json_each.value = ?)))
          OR (events.type = 'task.dependency_restored' AND events.task_id = ?)
          OR (events.type = 'decision.resolved'
              AND EXISTS (
                SELECT 1 FROM decisions, json_each(decisions.blocked_task_ids_json)
                 WHERE decisions.id = json_extract(events.payload_json, '$.decision_id')
                   AND json_each.value = ?))
        )`,
    taskId,
    taskId,
    taskId,
    taskId,
    taskId,
  );
  return row?.boundary ?? 0;
}

/**
 * What a Worker is told about Core's test run: the failed tests (already summarised, in_scope only)
 * and no raw output. The test checks lose their stdout, stderr and detail; the output stays in test_run_files.
 */
function coreTestRunFailure(verification: JsonObject): JsonObject {
  const run = isRecord(verification.test_run) ? verification.test_run : null;
  if (run === null) return {};
  const failures = isRecord(run.failures) ? run.failures : { failures: [], omitted_count: 0 };
  const commands = (Array.isArray(verification.commands) ? verification.commands : []).map((command) => {
    if (!isRecord(command) || command.command_id !== "policy:test") return command;
    const { stdout: _stdout, stderr: _stderr, detail: _detail, ...rest } = command;
    return rest;
  });
  return {
    commands,
    test_failures: failures,
    test_run: { run_id: run.run_id ?? null, mode: run.mode ?? null, files_run: run.files_run ?? 0, failed_files: Array.isArray(run.failed_files) ? run.failed_files : [] },
  };
}

export function readFixContext(db: ContextReader, taskId: string, workerFindingsOnly: boolean): FixContext | null {
  const boundary = attemptLineBoundary(db, taskId);
  const event = db.get<{ type: string; agent_run_id: string | null; payload_json: string; created_at: string }>(
    `SELECT type, agent_run_id, payload_json, created_at FROM events
      WHERE task_id = ? AND sequence > ?
        AND (type IN ('verification.completed', 'review.passed', 'task.process_wait_started')
             OR (type = 'review.failed' AND json_type(payload_json, '$.review') = 'object'))
      ORDER BY sequence DESC LIMIT 1`,
    taskId,
    boundary,
  );
  if (!event) return null;
  const payload = parseObject(event.payload_json);
  if (payload === null) return null;
  if (event.type === "task.process_wait_started") {
    const pending = isRecord(payload.pending_process) ? payload.pending_process : null;
    if (pending === null || event.agent_run_id === null) return null;
    const report = agentRunReport(db, event.agent_run_id);
    return {
      previous_report: report === null ? null : workerReportOnly(report),
      process_wait: {
        description: pending.description as string,
        command: pending.command as string,
        log_path: pending.log_path as string,
        done_path: (pending.done_path ?? null) as string | null,
        started_at: event.created_at,
      },
    };
  }
  if (event.type === "verification.completed") {
    if (payload.outcome !== "fail") return null;
    const verification = isRecord(payload.verification) ? payload.verification : {};
    const agentRunId = typeof payload.agent_run_id === "string" ? payload.agent_run_id : event.agent_run_id;
    const report = agentRunId === null ? null : agentRunReport(db, agentRunId);
    return {
      previous_report: report === null ? null : workerReportOnly(report),
      verification_failure: {
        source: typeof verification.source === "string" ? verification.source : "unknown",
        commands: Array.isArray(verification.commands) ? verification.commands : [],
        error: typeof verification.error === "string" ? verification.error : null,
        error_key: typeof verification.error_key === "string" ? verification.error_key : null,
        ...coreTestRunFailure(verification),
      },
    };
  }
  if (event.type !== "review.failed") return null;
  const reviewerRunId = typeof payload.agent_run_id === "string" ? payload.agent_run_id : event.agent_run_id;
  const row = reviewerRunId === null
    ? undefined
    : db.get<{ verdict: string; findings_json: string; verification_report_json: string }>(
        "SELECT verdict, findings_json, verification_report_json FROM reviews WHERE id = ? AND task_id = ?",
        reviewerRunId,
        taskId,
      );
  // A missing or invalid stored review is skipped (logged), never
  // reinterpreted: the Worker runs without fix context instead of failing
  // every attempt on the same row.
  const skip = (problem: string, details: JsonObject = {}): null => {
    console.warn(`[owl-core] Task ${taskId}: ${problem}; the Worker runs without fix context.`, { agent_run_id: reviewerRunId, ...details });
    return null;
  };
  if (!row) return skip("the stored Reviewer feedback is missing");
  let findings: unknown;
  let verificationReport: unknown;
  try {
    findings = JSON.parse(row.findings_json) as unknown;
    verificationReport = JSON.parse(row.verification_report_json) as unknown;
  } catch (error) {
    return skip("the stored Reviewer feedback is not valid JSON", { cause: error instanceof Error ? error.message : String(error) });
  }
  if (!Array.isArray(findings) || !isRecord(verificationReport)) {
    return skip("the stored Reviewer feedback has an invalid shape");
  }
  const previousReport = verificationReport.report;
  if (!isRecord(previousReport)) {
    return skip("the stored Reviewer feedback is missing the previous Worker report");
  }
  const reviewerFindings = workerFindingsOnly && row.verdict === "fix_required"
    ? findings.filter((finding) => !isRecord(finding) || finding.severity !== "minor")
    : findings;
  return { previous_report: previousReport, reviewer_findings: reviewerFindings };
}

export function loadFixContext(db: ContextReader, taskId: string): FixContext | null {
  return readFixContext(db, taskId, true);
}

/** Roles whose Input Core builds from Task facts. */
export type ContextRole = "worker" | "designer" | "reviewer";

/** How much of other agents' output one role is handed. */
export interface RoleContextBudget {
  /** Longest work_done summary (characters) per dependency Task. */
  readonly dependency_summary_max_chars: number;
}

export type ContextBudgets = Readonly<Record<ContextRole, RoleContextBudget>>;

/** The budgets in force: the stored settings, or their defaults. Read per call so a changed setting applies to the next run. */
export function settingsContextBudgets(db: Pick<CoreDatabase, "get">): ContextBudgets {
  const worker = { dependency_summary_max_chars: dependencySummarySettings(db).max_chars };
  return { worker, designer: worker, reviewer: worker };
}

/** The context fields Core derives for a Worker or Designer; the engine adds the runtime ones (worktree, hybrid_mode, ...). */
export interface WorkerRoleContext extends JsonObject {
  task: JsonObject | undefined;
  rules: string | null;
  skills: string | null;
  knowledge: string | null;
  dependency_reports: JsonObject[];
  artifact_paths: string[];
  owner_guidance: JsonObject[];
  check_commands: string[][];
}

/** The context fields Core derives for a Reviewer; git-derived lists are passed in. */
export interface ReviewerRoleContext extends JsonObject {
  task: JsonObject;
  rules: string | null;
  skills: string | null;
  knowledge: string | null;
  changed_files: readonly string[] | null;
  added_files: readonly string[] | null;
  previous_minor_findings: JsonObject[] | null;
  owner_guidance: JsonObject[];
  /** Core's test run from the Task's latest verification; null when there is none. */
  core_tests: JsonObject | null;
  /** Summary of the deterministic checks Core ran in the latest verification (no stdout/stderr); null when there is none. */
  core_checks: JsonObject | null;
}

/**
 * Builds the Task-derived part of a role's Input (Task view, dependency
 * results, fix context, Owner guidance) in one place, within the role's budget.
 */
export class ContextBuilder {
  public constructor(
    private readonly db: Pick<CoreDatabase, "get" | "all">,
    private readonly dataDir: string,
    private readonly sources: { readonly ruleStore?: RuleStore; readonly skillBox?: SkillBox; readonly memoryInjector?: Pick<IndexInjector, "compose"> } = {},
    private readonly budgets: () => ContextBudgets = () => settingsContextBudgets(this.db),
  ) {}

  public async buildWorkerContext(role: "worker" | "designer", workId: string, taskId: string, taskRow: TaskRow | undefined): Promise<WorkerRoleContext> {
    const dependencies = dependencyContext(this.db, taskId, this.dataDir, this.budgets()[role].dependency_summary_max_chars);
    return {
      task: taskRow ? roleTaskView(taskRow, dependencies.depends_on) : undefined,
      ...await this.roleSources(role, workId, taskId),
      dependency_reports: dependencies.dependency_reports,
      artifact_paths: dependencies.artifact_paths,
      // The fix context of the latest attempt only (a failed verification
      // or a fix/replan review, never both), plus the Owner's answers.
      ...((loadFixContext(this.db, taskId) ?? {}) as JsonObject),
      owner_guidance: ownerGuidance(this.db, workId, taskId),
      check_commands: this.checkCommands(workId),
    } as WorkerRoleContext;
  }

  /** The Project's test_policy.check_commands; [] without a Project. */
  public checkCommands(workId: string): string[][] {
    const row = this.db.get<{ test_policy_json: string | null }>("SELECT p.test_policy_json FROM projects p JOIN works w ON w.project_id = p.id WHERE w.id = ?", workId);
    return row ? readTestPolicy(row.test_policy_json).check_commands.map((argv) => [...argv]) : [];
  }

  public async buildReviewerContext(
    workId: string,
    task: TaskRow,
    changedFiles: readonly string[] | null,
    addedFiles: readonly string[] | null,
  ): Promise<ReviewerRoleContext> {
    return {
      task: reviewerTaskView(task, taskDependencyIds(this.db, task.id)),
      ...await this.roleSources("reviewer", workId, task.id, changedFiles),
      changed_files: changedFiles,
      added_files: addedFiles,
      previous_minor_findings: this.previousMinorFindings(task.id),
      owner_guidance: ownerGuidance(this.db, workId, task.id),
      core_tests: this.coreTests(task.id),
      core_checks: this.coreChecks(task.id),
    };
  }

  /** The role's Rule Store lines plus the Work's rules, one per line; null when there are none. */
  public rules(role: RuleRole, workId: string): string | null {
    if (!this.sources.ruleStore) return null;
    const workRulesJson = this.db.get<{ rules_json: string | null }>("SELECT rules_json FROM works WHERE id = ?", workId)?.rules_json;
    const lines = this.sources.ruleStore.getInstructionsForRole(role, parseWorkRules(workRulesJson, workId));
    return lines.length === 0 ? null : lines.join("\n");
  }

  public skills(workId: string): string | null {
    if (!this.sources.skillBox) return null;
    try {
      const projectId = this.db.get<{ project_id: string | null }>("SELECT project_id FROM works WHERE id = ?", workId)?.project_id ?? null;
      return this.sources.skillBox.renderIndex(projectId);
    } catch (error) {
      console.warn(`[owl-core] Could not render skill index for Work ${workId}`, error);
      return null;
    }
  }

  public async knowledge(workId: string, taskId: string | null, role: "designer" | "worker" | "reviewer" = "worker", changedFiles: readonly string[] | null = null): Promise<string | null> {
    if (!this.sources.memoryInjector) return null;
    try {
      const work = this.db.get<{ title: string; summary: string; project_id: string | null }>(
        "SELECT title, summary, project_id FROM works WHERE id = ?",
        workId,
      );
      if (!work) return null;
      const task = taskId
        ? this.db.get<{ title: string; acceptance: string | null; context: string | null }>(
            "SELECT title, acceptance, context FROM tasks WHERE id = ? AND work_id = ?",
            taskId,
            workId,
          )
        : undefined;
      return await this.sources.memoryInjector.compose({
        role,
        query: searchQuery(role, {
          work_title: work.title,
          work_summary: work.summary,
          task_title: task?.title,
          task_acceptance: task?.acceptance,
          task_context: task?.context,
          changed_files: changedFiles,
        }),
        ...(role === "designer" ? { recall_query: `${work.title}\n${work.summary}` } : {}),
        project_id: work.project_id,
      });
    } catch (error) {
      console.warn(`[owl-core] Could not compose knowledge for Work ${workId}`, error);
      return null;
    }
  }

  /** The Rule Store lines, Skill Box index and recalled knowledge a role is handed. */
  public async roleSources(role: ContextRole, workId: string, taskId: string, changedFiles: readonly string[] | null = null): Promise<{ rules: string | null; skills: string | null; knowledge: string | null }> {
    return {
      rules: this.rules(role, workId),
      skills: this.skills(workId),
      knowledge: await this.knowledge(workId, taskId, role, changedFiles),
    };
  }

  /** The test run in the Task's latest verification.completed event (the Core test result the Reviewer judges by). */
  public coreTests(taskId: string): JsonObject | null {
    const verification = this.latestVerification(taskId);
    return verification !== null && isRecord(verification.test_run) ? verification.test_run as JsonObject : null;
  }

  /** What Core's latest verification ran, without output: check_commands and policy_checks stay separate arrays. */
  public coreChecks(taskId: string): JsonObject | null {
    const verification = this.latestVerification(taskId);
    if (verification === null) return null;
    const items = (value: unknown): JsonObject[] => Array.isArray(value) ? value.filter(isRecord) as JsonObject[] : [];
    const pick = (item: JsonObject, keys: readonly string[]): JsonObject => Object.fromEntries(keys.filter((key) => item[key] !== undefined).map((key) => [key, item[key]])) as JsonObject;
    const policy = isRecord(verification.type_policy) ? verification.type_policy as JsonObject : null;
    return {
      source: typeof verification.source === "string" ? verification.source : null,
      passed: verification.passed === true,
      error_key: typeof verification.error_key === "string" ? verification.error_key : null,
      check_commands: items(verification.check_commands).map((item) => pick(item, ["command_id", "passed", "exit_code", "timed_out", "error"])),
      policy_checks: items(verification.commands).map((item) => pick(item, ["command_id", "passed", "file", "detail"])),
      type_policy: policy === null ? null : pick(policy, ["policy", "passed", "core_checks", "error_key"]),
    };
  }

  private latestVerification(taskId: string): JsonObject | null {
    const row = this.db.get<{ payload_json: string }>(
      "SELECT payload_json FROM events WHERE task_id = ? AND type = 'verification.completed' ORDER BY sequence DESC LIMIT 1",
      taskId,
    );
    const payload = row === undefined ? null : parseObject(row.payload_json);
    return payload !== null && isRecord(payload.verification) ? payload.verification as JsonObject : null;
  }

  /** The minor findings of the Task's latest review round; null when there are none to read. */
  public previousMinorFindings(taskId: string): JsonObject[] | null {
    const row = this.db.get<{ findings_json: string }>(
      "SELECT findings_json FROM reviews WHERE task_id = ? ORDER BY round DESC LIMIT 1",
      taskId,
    );
    if (!row) return null;
    try {
      const findings = JSON.parse(row.findings_json) as unknown;
      if (!Array.isArray(findings)) return null;
      return findings.filter((finding): finding is JsonObject => typeof finding === "object" && finding !== null && (finding as JsonObject).severity === "minor");
    } catch (error) {
      console.warn(`[owl-core] Ignoring unreadable findings_json of the latest review for Task ${taskId}:`, error);
      return null;
    }
  }
}
