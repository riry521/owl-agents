import { createUlid, utcNow } from "../../db/dist/index.js";
import type { KnowledgeNotes, NoteClaim } from "./knowledge-notes.js";
import { fingerprint, lessonFingerprint } from "./learning-fingerprint.js";
import { MIN_KEYWORDS, sanitizeKeywords } from "./knowledge-tags.js";
import type { NormalizedLesson } from "./final-verdict.js";
import type { RuleRole } from "./rule-store.js";
import type { CoreDatabase, CoreWriteLaneTransaction } from "./types.js";
import { ownerLanguage } from "./owner-language.js";

export type LearningJobStatus = "pending" | "running" | "done" | "failed";

export interface LearningJobRecord {
  readonly id: string;
  readonly work_id: string;
  readonly agent_run_id: string | null;
  readonly project_id: string | null;
  readonly payload_json: string;
  readonly payload_version: number;
  readonly status: LearningJobStatus;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly result_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly processed_at: string | null;
}

export interface LearningJobPayload {
  readonly work_title: string;
  readonly lessons: readonly NormalizedLesson[];
}

export interface LearningJobResult {
  readonly skill_proposal_ids: readonly string[];
  readonly note_ids: readonly string[];
  readonly rule_proposal_ids: readonly string[];
  readonly discarded: number;
}

export interface LearningPipelineOptions {
  readonly db: CoreDatabase;
  readonly writeLane: ReturnType<CoreDatabase["createWriteLane"]>;
  readonly skillBox: LearningSkillBox;
  readonly notes: Pick<KnowledgeNotes, "list" | "mergeClaim">;
  readonly ruleProposals: LearningRuleProposals;
  readonly onNotesChanged?: () => Promise<void> | void;
  /** While the knowledge storage is unavailable jobs stay pending; processing holds a write lease otherwise. */
  readonly gate?: { isAvailable(): boolean; withWrite<T>(fn: () => Promise<T>): Promise<T> };
  readonly now?: () => string;
  readonly logger?: { warn(message: string): void; error(message: string): void };
  readonly debounce_ms?: number;
  readonly batch_size?: number;
  readonly max_attempts?: number;
  readonly stale_running_ms?: number;
  /** Failure-injection point after an output write but before its processed fingerprint is recorded. */
  readonly afterOutput?: (kind: NormalizedLesson["kind"]) => void | Promise<void>;
}

export interface LearningSkillProposal {
  readonly kind: "new";
  readonly target: null;
  readonly summary: string;
  readonly steps_or_diff: string;
  readonly evidence: string;
  readonly source_fingerprint: string;
}

export interface LearningSkillBox {
  insertProposals(
    agentRunId: string | null,
    workId: string,
    projectId: string | null,
    proposals: readonly LearningSkillProposal[],
  ): Promise<readonly string[] | void>;
}

export interface LearningRuleProposals {
  create(input: {
    origin: "lesson";
    source: { readonly kind: "work"; readonly ref: string };
    input_fingerprint: string;
    level: "system" | "role";
    role?: RuleRole;
    text: string;
    rationale: string;
    applies_to: string;
    project_id: string | null;
  }): Promise<{ readonly proposal_id: string; readonly status: string }>;
}

interface LearningJobRow extends LearningJobRecord {}

interface StoredLearningResult {
  processed: string[];
  skill_proposal_ids: string[];
  note_ids: string[];
  rule_proposal_ids: string[];
  discarded: number;
  failed: Record<string, string>;
}

interface EnqueueLearningInput {
  readonly work_id: string;
  readonly agent_run_id: string | null;
  readonly project_id: string | null;
  readonly work_title?: string;
  readonly lessons: readonly NormalizedLesson[];
}

/** Synchronous core of enqueue, also usable from a Work completion transaction. */
export function enqueueLearningJobInTransaction(
  transaction: CoreWriteLaneTransaction,
  input: EnqueueLearningInput,
  now: string = utcNow(),
): { readonly id: string; readonly inserted: boolean; readonly added: number } | null {
  if (input.lessons.length === 0) return null;
  const existing = transaction.get<LearningJobRow>("SELECT * FROM learning_jobs WHERE work_id = ?", input.work_id);
  const storedWork = transaction.get<{ title: string }>("SELECT title FROM works WHERE id = ?", input.work_id);
  const workTitle = input.work_title ?? storedWork?.title ?? "";
  const uniqueIncoming = new Map<string, NormalizedLesson>();
  for (const lesson of input.lessons) uniqueIncoming.set(lessonFingerprint(lesson), lesson);

  if (!existing) {
    const id = createUlid();
    transaction.run(
      `INSERT INTO learning_jobs
         (id, work_id, agent_run_id, project_id, payload_json, payload_version, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 'pending', 0, ?, ?)`,
      id,
      input.work_id,
      input.agent_run_id,
      input.project_id,
      JSON.stringify({ work_title: workTitle, lessons: [...uniqueIncoming.values()] } satisfies LearningJobPayload),
      now,
      now,
    );
    return { id, inserted: true, added: uniqueIncoming.size };
  }

  const payload = parsePayload(existing.payload_json);
  const merged = new Map(payload.lessons.map((lesson) => [lessonFingerprint(lesson), lesson]));
  for (const [fingerprint, lesson] of uniqueIncoming) {
    if (!merged.has(fingerprint)) merged.set(fingerprint, lesson);
  }
  const added = merged.size - payload.lessons.length;
  if (added === 0 && existing.status !== "failed") return { id: existing.id, inserted: false, added: 0 };

  const reopenFailed = existing.status === "failed";
  transaction.run(
    `UPDATE learning_jobs
        SET agent_run_id = ?, project_id = ?, payload_json = ?,
            payload_version = payload_version + ?,
            status = CASE WHEN status IN ('done', 'failed') THEN 'pending' ELSE status END,
            attempts = CASE WHEN status = 'failed' THEN 0 ELSE attempts END,
            last_error = CASE WHEN status = 'failed' THEN NULL ELSE last_error END,
            processed_at = CASE WHEN status IN ('done', 'failed') THEN NULL ELSE processed_at END,
            updated_at = ?
      WHERE id = ?`,
    input.agent_run_id,
    input.project_id,
    JSON.stringify({ work_title: workTitle || payload.work_title, lessons: [...merged.values()] } satisfies LearningJobPayload),
    added > 0 ? 1 : 0,
    now,
    existing.id,
  );
  if (reopenFailed && added === 0) {
    transaction.run("UPDATE learning_jobs SET status='pending', attempts=0, last_error=NULL, processed_at=NULL WHERE id=?", existing.id);
  }
  return { id: existing.id, inserted: false, added };
}

export class LearningJobs {
  private readonly now: () => string;

  public constructor(private readonly options: {
    readonly db: CoreDatabase;
    readonly writeLane: ReturnType<CoreDatabase["createWriteLane"]>;
    readonly now?: () => string;
  }) {
    this.now = options.now ?? utcNow;
  }

  /** Insert or merge the Work's normalized lessons using the lesson state table. */
  public async enqueue(
    workId: string,
    agentRunId: string | null,
    projectId: string | null,
    lessons: readonly NormalizedLesson[],
  ): Promise<string | null> {
    if (lessons.length === 0) return null;
    const result = await this.options.writeLane.transact((transaction: CoreWriteLaneTransaction) =>
      enqueueLearningJobInTransaction(transaction, {
        work_id: workId,
        agent_run_id: agentRunId,
        project_id: projectId,
        lessons,
      }, this.now()));
    return result?.id ?? null;
  }

  public list(status?: LearningJobStatus): LearningJobRecord[] {
    if (status && !isLearningJobStatus(status)) throw new Error("invalid_learning_job_status");
    return this.options.db.all<LearningJobRecord>(
      `SELECT * FROM learning_jobs${status ? " WHERE status = ?" : ""} ORDER BY created_at, id`,
      ...(status ? [status] : []),
    );
  }
}

export class LearningPipeline {
  private readonly db: CoreDatabase;
  private readonly writeLane: ReturnType<CoreDatabase["createWriteLane"]>;
  private readonly skillBox: LearningSkillBox;
  private readonly notes: Pick<KnowledgeNotes, "list" | "mergeClaim">;
  private readonly ruleProposals: LearningRuleProposals;
  private readonly onNotesChanged?: () => Promise<void> | void;
  private readonly now: () => string;
  private readonly logger: NonNullable<LearningPipelineOptions["logger"]>;
  private readonly debounceMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly staleRunningMs: number;
  private readonly gate?: LearningPipelineOptions["gate"];
  private readonly afterOutput?: LearningPipelineOptions["afterOutput"];
  private pendingRun: Promise<void> = Promise.resolve();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceWaiters: Array<{ resolve(): void; reject(error: unknown): void }> = [];

  public constructor(options: LearningPipelineOptions) {
    this.db = options.db;
    this.writeLane = options.writeLane;
    this.skillBox = options.skillBox;
    this.notes = options.notes;
    this.ruleProposals = options.ruleProposals;
    this.onNotesChanged = options.onNotesChanged;
    this.gate = options.gate;
    this.now = options.now ?? utcNow;
    this.logger = options.logger ?? console;
    this.debounceMs = nonNegativeInteger(options.debounce_ms, 5_000);
    this.batchSize = positiveInteger(options.batch_size, 5);
    this.maxAttempts = positiveInteger(options.max_attempts, 3);
    this.staleRunningMs = positiveInteger(options.stale_running_ms, 600_000);
    this.afterOutput = options.afterOutput;
  }

  public requestRun(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.debounceWaiters.push({ resolve, reject });
      if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        const waiters = this.debounceWaiters.splice(0);
        void this.processPending().then(
          () => waiters.forEach((waiter) => waiter.resolve()),
          (error: unknown) => waiters.forEach((waiter) => waiter.reject(error)),
        );
      }, this.debounceMs);
    });
  }

  public processPending(): Promise<void> {
    const operation = this.pendingRun.then(() => this.processPendingNow());
    this.pendingRun = operation.then(() => undefined, () => undefined);
    return operation;
  }

  public async processPendingNow(): Promise<void> {
    if (this.gate && !this.gate.isAvailable()) return;
    await this.recoverStaleRunning();
    const jobs = this.db.all<Pick<LearningJobRecord, "id">>(
      `SELECT id FROM learning_jobs
        WHERE status='pending' AND attempts < ?
        ORDER BY created_at, id LIMIT ?`,
      this.maxAttempts,
      this.batchSize,
    );
    for (const job of jobs) await this.processJob(job.id);
  }

  public processJob(jobId: string): Promise<LearningJobResult> {
    if (!this.gate) return this.processJobUnlocked(jobId);
    return this.gate.withWrite(() => this.processJobUnlocked(jobId));
  }

  private async processJobUnlocked(jobId: string): Promise<LearningJobResult> {
    const claimed = await this.writeLane.transact((transaction: CoreWriteLaneTransaction) => {
      transaction.run(
        `UPDATE learning_jobs SET status='running', updated_at=?
          WHERE id=? AND status='pending' AND attempts < ?`,
        this.now(),
        jobId,
        this.maxAttempts,
      );
      if (transaction.get<{ changes: number }>("SELECT changes() AS changes")?.changes !== 1) return null;
      const row = transaction.get<LearningJobRow>("SELECT * FROM learning_jobs WHERE id=?", jobId);
      if (!row) return null;
      return {
        row,
        payload: parsePayload(row.payload_json),
        result: parseResult(row.result_json),
      };
    });
    if (!claimed) return emptyPublicResult();

    const { row, payload, result } = claimed;
    const v0 = row.payload_version;
    const processed = new Set(result.processed);
    const failures: Array<{ fingerprint: string; error: string }> = [];
    let notesChanged = false;

    for (const lesson of payload.lessons) {
      const sourceFingerprint = lessonFingerprint(lesson);
      if (processed.has(sourceFingerprint)) continue;
      result.failed = result.failed ?? {};
      try {
        if (lesson.kind === "procedure") {
          const proposal: LearningSkillProposal = {
            kind: "new",
            target: null,
            summary: lesson.lesson,
            steps_or_diff: lesson.procedure,
            evidence: `${lesson.basis}\napplies_to: ${lesson.applies_to}`,
            source_fingerprint: sourceFingerprint,
          };
          const returned = await this.skillBox.insertProposals(row.agent_run_id, row.work_id, row.project_id, [proposal]);
          const ids = returned?.length ? [...returned] : this.findSkillProposalIds(row.work_id, proposal);
          addUnique(result.skill_proposal_ids, ids);
        } else if (lesson.kind === "fact" || lesson.kind === "decision" || lesson.kind === "pitfall") {
          const text = lesson.kind === "decision" && lesson.basis.trim()
            ? ownerLanguage(this.db) === "ja"
              ? `${lesson.lesson.trim()}。理由: ${lesson.basis.trim()}`
              : `${lesson.lesson.trim()} Reason: ${lesson.basis.trim()}`
            : lesson.lesson;
          const tags = sanitizeKeywords(lesson.keywords ?? []);
          // Lessons recorded before keyword tagging have no keywords field and are saved untagged.
          if (lesson.keywords !== undefined && tags.length < MIN_KEYWORDS) throw new Error("keywords_insufficient");
          const textFingerprint = fingerprint(text);
          const existing = (await this.notes.list()).find((entry) => entry.claims.some((claim) => claim.fingerprint === textFingerprint));
          if (existing?.claims.some((claim) => claim.fingerprint === textFingerprint && claim.sources.includes(row.work_id))) {
            addUnique(result.note_ids, [existing.id]);
          } else {
            const note = await this.notes.mergeClaim({
              topic: existing?.title ?? (lesson.topic.trim() || lesson.lesson.trim().slice(0, 80)),
              kind: lesson.kind as NoteClaim["kind"],
              text,
              work_id: row.work_id,
              project_id: row.project_id,
              tags,
              ...(tags.length >= MIN_KEYWORDS ? { tags_source: "keywords" as const } : {}),
            });
            addUnique(result.note_ids, [note.note_id]);
            notesChanged = true;
          }
        } else if (lesson.kind === "rule_candidate") {
          const roleScope = lesson.rule_scope !== "all";
          const proposal = await this.ruleProposals.create({
            origin: "lesson",
            source: { kind: "work", ref: row.work_id },
            input_fingerprint: sourceFingerprint,
            level: roleScope ? "role" : "system",
            ...(roleScope ? { role: lesson.rule_scope } : {}),
            text: lesson.rule_text,
            rationale: lesson.basis,
            applies_to: lesson.applies_to,
            project_id: row.project_id,
          });
          addUnique(result.rule_proposal_ids, [proposal.proposal_id]);
        } else {
          result.discarded += 1;
        }
      } catch (error) {
        const message = errorMessage(error);
        result.failed[sourceFingerprint] = message;
        failures.push({ fingerprint: sourceFingerprint, error: message });
        continue;
      }

      await this.afterOutput?.(lesson.kind);
      processed.add(sourceFingerprint);
      result.processed = [...processed];
      delete result.failed[sourceFingerprint];
    }

    const now = this.now();
    const outcome = await this.writeLane.transact((transaction: CoreWriteLaneTransaction) => {
      const current = transaction.get<{ payload_version: number }>("SELECT payload_version FROM learning_jobs WHERE id=?", jobId);
      if (!current) throw new Error("learning_job_not_found");
      if (failures.length > 0) {
        const attempts = row.attempts + 1;
        const status: LearningJobStatus = attempts >= this.maxAttempts ? "failed" : "pending";
        const lastError = failures.map((entry) => `${entry.fingerprint}: ${entry.error}`).join("; ").slice(0, 2_000);
        transaction.run(
          `UPDATE learning_jobs SET status=?, attempts=?, last_error=?, result_json=?, updated_at=?, processed_at=NULL WHERE id=?`,
          status,
          attempts,
          lastError,
          JSON.stringify(result),
          now,
          jobId,
        );
        return result;
      }
      const status: LearningJobStatus = current.payload_version === v0 ? "done" : "pending";
      transaction.run(
        `UPDATE learning_jobs SET status=?, result_json=?, last_error=NULL, updated_at=?, processed_at=? WHERE id=?`,
        status,
        JSON.stringify(result),
        now,
        status === "done" ? now : null,
        jobId,
      );
      return result;
    });
    if (notesChanged) {
      try {
        await this.onNotesChanged?.();
      } catch (error) {
        this.logger.warn(`[learning-pipeline] Could not schedule Librarian: ${errorMessage(error)}`);
      }
    }
    return publicResult(outcome);
  }

  public async recoverStaleRunning(): Promise<number> {
    const cutoff = new Date(Date.parse(this.now()) - this.staleRunningMs).toISOString();
    return this.writeLane.transact((transaction: CoreWriteLaneTransaction) => transaction.run(
      `UPDATE learning_jobs SET status='pending', updated_at=?
        WHERE status='running' AND updated_at < ?`,
      this.now(),
      cutoff,
    ).changes);
  }

  public async retryJob(jobId: string): Promise<void> {
    const result = await this.writeLane.transact((transaction: CoreWriteLaneTransaction) => transaction.run(
      `UPDATE learning_jobs SET status='pending', attempts=0, last_error=NULL, updated_at=?
        WHERE id=? AND status='failed'`,
      this.now(),
      jobId,
    ).changes);
    if (result === 0 && !this.db.get("SELECT id FROM learning_jobs WHERE id=?", jobId)) throw new Error("learning_job_not_found");
  }

  public list(status?: LearningJobStatus): LearningJobRecord[] {
    if (status && !isLearningJobStatus(status)) throw new Error("invalid_learning_job_status");
    return this.db.all<LearningJobRecord>(
      `SELECT * FROM learning_jobs${status ? " WHERE status = ?" : ""} ORDER BY created_at, id`,
      ...(status ? [status] : []),
    );
  }

  private findSkillProposalIds(workId: string, proposal: LearningSkillProposal): string[] {
    return this.db.all<{ id: string; payload_json: string }>(
      "SELECT id, payload_json FROM skill_proposals WHERE source_work_id=?",
      workId,
    ).filter((row) => {
      try {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        return payload.source_fingerprint === proposal.source_fingerprint
          || (typeof payload.steps_or_diff === "string" && payload.steps_or_diff === proposal.steps_or_diff);
      } catch {
        return false;
      }
    }).map(({ id }) => id);
  }
}

function parsePayload(json: string): LearningJobPayload {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error("invalid_learning_job_payload"); }
  if (!isRecord(value) || !Array.isArray(value.lessons)) throw new Error("invalid_learning_job_payload");
  return {
    work_title: typeof value.work_title === "string" ? value.work_title : "",
    lessons: value.lessons as NormalizedLesson[],
  };
}

function parseResult(json: string | null): StoredLearningResult {
  const empty = (): StoredLearningResult => ({ processed: [], skill_proposal_ids: [], note_ids: [], rule_proposal_ids: [], discarded: 0, failed: {} });
  if (!json) return empty();
  let value: unknown;
  try { value = JSON.parse(json); } catch { return empty(); }
  if (!isRecord(value)) return empty();
  return {
    processed: stringArray(value.processed),
    skill_proposal_ids: stringArray(value.skill_proposal_ids ?? value.skills),
    note_ids: stringArray(value.note_ids ?? value.notes),
    rule_proposal_ids: stringArray(value.rule_proposal_ids ?? value.rule_proposals),
    discarded: Number.isSafeInteger(value.discarded) && Number(value.discarded) > 0 ? Number(value.discarded) : 0,
    failed: isRecord(value.failed) ? Object.fromEntries(Object.entries(value.failed).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {},
  };
}

function publicResult(result: StoredLearningResult): LearningJobResult {
  return {
    skill_proposal_ids: [...result.skill_proposal_ids],
    note_ids: [...result.note_ids],
    rule_proposal_ids: [...result.rule_proposal_ids],
    discarded: result.discarded,
  };
}

function emptyPublicResult(): LearningJobResult {
  return { skill_proposal_ids: [], note_ids: [], rule_proposal_ids: [], discarded: 0 };
}

function addUnique(target: string[], values: readonly string[]): void {
  for (const value of values) if (!target.includes(value)) target.push(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLearningJobStatus(value: string): value is LearningJobStatus {
  return value === "pending" || value === "running" || value === "done" || value === "failed";
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value as number : fallback;
}
