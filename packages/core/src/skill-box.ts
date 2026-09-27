import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createUlid, utcNow } from "../../db/dist/index.js";
import { fingerprint } from "./learning-fingerprint";
import { ensureOwner } from "./state-reducer.js";
import { GUARD_CONTENT_KEYS, GUARD_PATH_KEYS } from "@owl/shared";
import type { SkillFeedback } from "@owl/shared";
import type { CoreDatabase, CoreWriteLaneTransaction } from "./types.js";
import { WRITE_TOOL_NAME } from "./rule-store.js";
import { hashSkillFiles, isValidSkillScope, parseSkillMd, renderSkillMd, validateSkillFilePath, validateSkillName, type SkillMetadata } from "./skill-files.js";

export type SkillState = "active" | "stale" | "archived";
export type SkillActor = "curator" | "user";
export type SkillAction = "create" | "update" | "merge" | "state_change" | "scope_change" | "restore" | "rollback" | "external_edit";

export interface ApplyRevisionInput {
  readonly name: string;
  readonly files: Record<string, string>;
  readonly meta: { readonly description: string; readonly tags: readonly string[]; readonly scope: string };
  readonly actor: SkillActor;
  readonly action: SkillAction;
  readonly reason: string;
  readonly trial: boolean;
  readonly source_proposal_id?: string;
  readonly source_work_id?: string;
  readonly source_agent_run_id?: string;
}

export interface SkillBoxOptions {
  readonly db: CoreDatabase;
  readonly owlRoot: string;
  readonly now?: () => string;
  readonly logger?: Pick<Console, "warn" | "error">;
  readonly onProposalsInserted?: () => void | Promise<void>;
  readonly onFeedbackRecorded?: () => void | Promise<void>;
}

export interface SkillIndexLimits {
  readonly max_items?: number;
  readonly max_characters?: number;
}

export interface SkillSettings {
  readonly mode: "autonomous" | "conservative";
  readonly confidence_threshold: number;
  readonly stale_days: number;
  readonly archived_days: number;
  readonly max_items: number;
  readonly max_characters: number;
}

export interface SkillListRecord extends SkillRecord {
  readonly has_scripts: boolean;
  readonly trial_progress: { readonly evaluations: number; readonly misleading: number } | null;
  readonly helpful_count: number;
  readonly misleading_count: number;
  readonly irrelevant_count: number;
  readonly originating_work: { readonly id: string; readonly title: string | null } | null;
}

export interface SkillProposalJudgement {
  readonly reusability: number | null;
  readonly confidence: number | null;
  readonly reason: string | null;
  readonly relation: string | null;
}

export interface SkillProposalRecord {
  readonly id: string;
  readonly kind: "new" | "update";
  readonly target_skill: string | null;
  readonly payload: unknown;
  readonly source_work_id: string | null;
  readonly source_agent_run_id: string | null;
  readonly project_id: string | null;
  readonly status: "pending" | "awaiting_approval" | "applied" | "rejected";
  readonly decision: unknown;
  readonly judgement: SkillProposalJudgement;
  readonly written_content: Record<string, string> | null;
  readonly current_content: Record<string, string> | null;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly applied_revision_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export type SkillProposalInsert = SkillFeedback["skill_proposals"][number] & {
  readonly source_fingerprint?: string;
};

export interface SkillRecord {
  readonly name: string;
  readonly description: string;
  readonly tags_json: string;
  readonly tags: string[];
  readonly scope: string;
  readonly project_id: string | null;
  readonly state: SkillState;
  readonly trial: number;
  readonly content_hash: string;
  readonly current_revision: number;
  readonly use_count: number;
  readonly last_used_at: string | null;
  readonly state_changed_at: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly broken_reason: string | null;
}

interface SkillDbRow extends Omit<SkillRecord, "tags"> {}

interface SkillRevisionRow {
  readonly id: string;
  readonly skill_name: string;
  readonly revision: number;
  readonly actor: SkillActor;
  readonly action: SkillAction;
  readonly snapshot_json: string | null;
  readonly content_hash: string;
  readonly source_proposal_id: string | null;
  readonly source_work_id: string | null;
  readonly source_agent_run_id: string | null;
  readonly reason: string;
  readonly created_at: string;
}

export interface SkillRevisionRecord {
  readonly id: string;
  readonly skill_name: string;
  readonly revision: number;
  readonly actor: SkillActor;
  readonly action: SkillAction;
  readonly snapshot_json: string | null;
  readonly content_hash: string;
  readonly source_proposal_id: string | null;
  readonly source_work_id: string | null;
  readonly source_agent_run_id: string | null;
  readonly reason: string;
  readonly created_at: string;
}

interface ExistingFile {
  readonly path: string;
  readonly content: string;
}

const SKILL_SIZE_LIMIT = 256 * 1024;
const READ_TOOL_NAMES = new Set(["read", "read_file", "open"]);
const SHELL_TOOL_NAMES = new Set(["bash", "shell", "terminal", "exec", "command"]);
const WRITE_TOOL_NAMES = new Set(["edit", "write", "multiedit", "notebookedit", "write_file", "apply_patch"]);

export interface DetectSkillReadsInput {
  readonly owlRoot: string;
  readonly tool_name: string;
  readonly tool_input: Readonly<Record<string, unknown>>;
  readonly cwd: string;
  readonly normalized_segments?: readonly (readonly string[])[];
}

export function detectSkillReads(input: DetectSkillReadsInput): string[] {
  const tool = input.tool_name.toLowerCase();
  let candidates: string[] = [];
  if (READ_TOOL_NAMES.has(tool)) {
    candidates = stringValues(input.tool_input, ["file_path", "path", "filename"]);
  } else if (SHELL_TOOL_NAMES.has(tool)) {
    candidates = (input.normalized_segments ?? []).flatMap((segments) => segments);
  } else if (!WRITE_TOOL_NAMES.has(tool)) {
    const baseTool = tool.startsWith("mcp__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool;
    const writes = WRITE_TOOL_NAME.test(baseTool) || GUARD_CONTENT_KEYS.some((key) => key in input.tool_input);
    if (!writes) candidates = stringValues(input.tool_input, GUARD_PATH_KEYS);
  }

  const skillsRoot = resolve(input.owlRoot, "skills");
  const names = new Set<string>();
  for (const candidate of candidates) {
    const absolutePath = resolve(input.cwd, candidate);
    const withinSkills = relative(skillsRoot, absolutePath);
    if (withinSkills === "" || withinSkills.startsWith("..") || withinSkills.startsWith("/")) continue;
    const name = withinSkills.split(/[\\/]/u)[0];
    if (name && validateSkillName(name)) names.add(name);
  }
  return [...names];
}

export class SkillBox {
  private readonly db: CoreDatabase;
  private readonly writeLane;
  private readonly skillsRoot: string;
  private readonly logger: Pick<Console, "warn" | "error">;
  private readonly now: () => string;
  private readonly onProposalsInserted?: () => void | Promise<void>;
  private readonly onFeedbackRecorded?: () => void | Promise<void>;
  private readonly queueContext = new AsyncLocalStorage<boolean>();
  private queue: Promise<void> = Promise.resolve();

  public constructor(options: SkillBoxOptions) {
    this.db = options.db;
    this.writeLane = options.db.createWriteLane();
    this.skillsRoot = resolve(options.owlRoot, "skills");
    this.logger = options.logger ?? console;
    this.now = options.now ?? utcNow;
    this.onProposalsInserted = options.onProposalsInserted;
    this.onFeedbackRecorded = options.onFeedbackRecorded;
  }

  private insertProposalRows(
    transaction: CoreWriteLaneTransaction,
    agentRunId: string | null,
    workId: string,
    projectId: string | null,
    proposals: readonly SkillProposalInsert[],
  ): { proposalIds: string[]; inserted: number } {
    const rows = transaction.all<{ id: string; kind: string; target_skill: string | null; payload_json: string }>(
      "SELECT id, kind, target_skill, payload_json FROM skill_proposals WHERE source_work_id = ?",
      workId,
    );
    const existingBySource = new Map<string, string>();
    const existingByProcedure = new Map<string, string>();
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(row.payload_json);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        payload = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof payload.source_fingerprint === "string") existingBySource.set(payload.source_fingerprint, row.id);
      if (row.kind === "new" && row.target_skill === null && typeof payload.steps_or_diff === "string") {
        existingByProcedure.set(fingerprint(payload.steps_or_diff), row.id);
      }
    }

    const proposalIds: string[] = [];
    let inserted = 0;
    const now = this.now();
    for (const proposal of proposals) {
      if (!proposal || (proposal.kind !== "new" && proposal.kind !== "update") || typeof proposal.summary !== "string" || typeof proposal.steps_or_diff !== "string" || typeof proposal.evidence !== "string") continue;
      const target = proposal.kind === "update" && typeof proposal.target === "string" ? proposal.target : null;
      const procedureProposal = proposal.kind === "new" && target === null;
      const sourceFingerprint = typeof proposal.source_fingerprint === "string"
        ? proposal.source_fingerprint
        : procedureProposal
          ? fingerprint(proposal.steps_or_diff)
          : fingerprint(JSON.stringify([proposal.kind, target, proposal.summary, proposal.steps_or_diff, proposal.evidence]));
      const procedureFingerprint = fingerprint(proposal.steps_or_diff);
      const existingId = existingBySource.get(sourceFingerprint) ?? (procedureProposal ? existingByProcedure.get(procedureFingerprint) : undefined);
      if (existingId) {
        proposalIds.push(existingId);
        continue;
      }

      const id = createUlid();
      const payload = { ...proposal, source_fingerprint: sourceFingerprint };
      transaction.run(
        `INSERT INTO skill_proposals
           (id, kind, target_skill, payload_json, source_work_id, source_agent_run_id, project_id, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        id,
        proposal.kind,
        target,
        JSON.stringify(payload),
        workId,
        agentRunId,
        projectId,
        now,
        now,
      );
      proposalIds.push(id);
      existingBySource.set(sourceFingerprint, id);
      if (procedureProposal) existingByProcedure.set(procedureFingerprint, id);
      inserted += 1;
    }
    return { proposalIds, inserted };
  }

  private async notifyProposalsInserted(inserted: number): Promise<void> {
    if (inserted === 0 || !this.onProposalsInserted) return;
    try {
      await this.onProposalsInserted();
    } catch (error) {
      this.logger.warn?.(`[skill-box] Could not schedule the Curator: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async insertProposals(
    agentRunId: string | null,
    workId: string,
    projectId: string | null,
    proposals: readonly SkillProposalInsert[],
  ): Promise<string[]> {
    const result = await this.enqueue(() => this.writeLane.transact((transaction: CoreWriteLaneTransaction) =>
      this.insertProposalRows(transaction, agentRunId, workId, projectId, proposals),
    ));
    await this.notifyProposalsInserted(result.inserted);
    return result.proposalIds;
  }

  public enqueue<T>(fn: () => T | PromiseLike<T>): Promise<T> {
    if (this.queueContext.getStore()) return Promise.resolve().then(fn);
    const operation = this.queue.then(() => this.queueContext.run(true, fn));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  public applyRevision(input: ApplyRevisionInput): Promise<{ revision_id: string; revision: number }> {
    return this.enqueue(() => this.applyRevisionNow(input));
  }

  public listSkillsForApi(filter: {
    readonly state?: SkillState;
    readonly scope?: string;
    readonly trial?: boolean;
    readonly query?: string;
  } = {}): SkillListRecord[] {
    return this.listSkills({ ...filter, include_broken: true }).map((skill) => {
      const stats = this.db.get<{
        helpful_count: number;
        misleading_count: number;
        irrelevant_count: number;
        trial_evaluations: number;
        trial_misleading: number;
      }>(
        `SELECT
           SUM(CASE WHEN verdict = 'helpful' THEN 1 ELSE 0 END) AS helpful_count,
           SUM(CASE WHEN verdict = 'misleading' THEN 1 ELSE 0 END) AS misleading_count,
           SUM(CASE WHEN verdict = 'irrelevant' THEN 1 ELSE 0 END) AS irrelevant_count,
           SUM(CASE WHEN revision = ? AND verdict IS NOT NULL THEN 1 ELSE 0 END) AS trial_evaluations,
           SUM(CASE WHEN revision = ? AND verdict = 'misleading' THEN 1 ELSE 0 END) AS trial_misleading
         FROM skill_usages WHERE skill_name = ?`,
        skill.current_revision,
        skill.current_revision,
        skill.name,
      );
      const work = this.db.get<{ id: string | null; title: string | null }>(
        `SELECT r.source_work_id AS id, w.title
           FROM skill_revisions r LEFT JOIN works w ON w.id = r.source_work_id
          WHERE r.skill_name = ? AND r.revision = ?`,
        skill.name,
        skill.current_revision,
      );
      const originatingWork = work?.id ? { id: work.id, title: work.title ?? null } : null;
      const scripts = this.db.get<{ has_scripts: number }>(
        `SELECT EXISTS (
           SELECT 1 FROM json_each((
             SELECT snapshot_json FROM skill_revisions
              WHERE skill_name = ? AND revision <= ? AND snapshot_json IS NOT NULL
              ORDER BY revision DESC LIMIT 1
           ))
            WHERE key >= 'scripts/' AND key < 'scripts0'
         ) AS has_scripts`,
        skill.name,
        skill.current_revision,
      );
      return {
        ...skill,
        has_scripts: Number(scripts?.has_scripts ?? 0) === 1,
        trial_progress: skill.trial === 1
          ? { evaluations: Number(stats?.trial_evaluations ?? 0), misleading: Number(stats?.trial_misleading ?? 0) }
          : null,
        helpful_count: Number(stats?.helpful_count ?? 0),
        misleading_count: Number(stats?.misleading_count ?? 0),
        irrelevant_count: Number(stats?.irrelevant_count ?? 0),
        originating_work: originatingWork,
      };
    });
  }

  public async readSkillFiles(name: string): Promise<{ files: Record<string, string>; body: string }> {
    this.assertName(name);
    if (!this.getSkill(name)) throw new Error("skill_not_found");
    const directory = join(this.skillsRoot, name);
    await this.assertNoSymlink(directory);
    const files = await this.loadFiles(directory);
    const document = files["SKILL.md"] ?? "";
    const parsed = parseSkillMd(document);
    return { files, body: "error" in parsed ? document : parsed.body };
  }

  public listRecentUsages(name: string): {
    agent_run_id: string;
    role: string | null;
    verdict: string | null;
    note: string | null;
    work_id: string | null;
    work_title: string | null;
    revision: number;
    used_at: string;
  }[] {
    return this.db.all(
      `SELECT u.agent_run_id, u.role, u.verdict, u.note, u.work_id, w.title AS work_title,
              u.revision, u.created_at AS used_at
         FROM skill_usages u LEFT JOIN works w ON w.id = u.work_id
        WHERE u.skill_name = ?
        ORDER BY u.created_at DESC, u.agent_run_id DESC
        LIMIT 50`,
      name,
    );
  }

  public listProposals(status?: SkillProposalRecord["status"]): SkillProposalRecord[] {
    const rows = this.db.all<{
      id: string;
      kind: "new" | "update";
      target_skill: string | null;
      payload_json: string;
      source_work_id: string | null;
      source_agent_run_id: string | null;
      project_id: string | null;
      status: SkillProposalRecord["status"];
      decision_json: string | null;
      attempts: number;
      last_error: string | null;
      applied_revision_id: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, kind, target_skill, payload_json, source_work_id, source_agent_run_id, project_id,
              status, decision_json, attempts, last_error, applied_revision_id, created_at, updated_at
         FROM skill_proposals ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC, id DESC`,
      ...(status ? [status] : []),
    );
    return rows.map((row) => {
      const decision = parseJsonOrNull(row.decision_json);
      const decisionRecord = decision !== null && typeof decision === "object" && !Array.isArray(decision)
        ? decision as Record<string, unknown>
        : null;
      const nestedJudgement = decisionRecord?.judgement !== null
        && typeof decisionRecord?.judgement === "object"
        && !Array.isArray(decisionRecord.judgement)
        ? decisionRecord.judgement as Record<string, unknown>
        : null;
      const judgement: SkillProposalJudgement = {
        reusability: nullableFiniteNumber(nestedJudgement?.reusable ?? nestedJudgement?.reusability),
        confidence: nullableFiniteNumber(nestedJudgement?.confidence),
        reason: nullableString(decisionRecord?.reason ?? nestedJudgement?.reason) ?? (row.status === "rejected" ? row.last_error : null),
        relation: nullableString(nestedJudgement?.relation ?? decisionRecord?.relation),
      };
      const writtenContent = decisionRecord ? contentFiles(decisionRecord.files, decisionRecord.skill) : null;
      const targetName = typeof decisionRecord?.target_name === "string"
        ? decisionRecord.target_name
        : row.target_skill ?? (typeof decisionRecord?.name === "string" ? decisionRecord.name : null);
      const currentSkill = targetName ? this.getSkill(targetName) : undefined;
      const currentRevision = currentSkill
        ? this.db.get<{ snapshot_json: string | null }>(
          "SELECT snapshot_json FROM skill_revisions WHERE skill_name = ? AND revision = ?",
          targetName,
          currentSkill.current_revision,
        )
        : undefined;
      return {
        id: row.id,
        kind: row.kind,
        target_skill: row.target_skill,
        payload: parseJsonOrNull(row.payload_json),
        source_work_id: row.source_work_id,
        source_agent_run_id: row.source_agent_run_id,
        project_id: row.project_id,
        status: row.status,
        decision,
        judgement,
        written_content: writtenContent,
        current_content: currentSkill && currentRevision?.snapshot_json ? parseSnapshot(currentRevision.snapshot_json) : null,
        attempts: row.attempts,
        last_error: row.last_error,
        applied_revision_id: row.applied_revision_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    });
  }

  public getSettings(): SkillSettings {
    const stored = this.readIndexSettings();
    const threshold = stored.confidence_threshold ?? stored.threshold;
    const staleDays = stored.stale_days ?? stored.stale_after_days;
    const archivedDays = stored.archived_days ?? stored.archive_after_days;
    return {
      mode: stored.mode === "conservative" ? "conservative" : "autonomous",
      confidence_threshold: typeof threshold === "number" && Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : 0.5,
      stale_days: positiveInteger(staleDays, 60),
      archived_days: positiveInteger(archivedDays, 30),
      max_items: positiveInteger(stored.max_items, 30),
      max_characters: positiveInteger(stored.max_characters, 6000),
    };
  }

  public setSettings(settings: SkillSettings): Promise<SkillSettings> {
    return this.enqueue(async () => {
      await this.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) => {
          const now = this.now();
          ensureOwner(transaction, "owner:default", now);
          transaction.run(
            `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
             VALUES ('skills', 'owner:default', '1.0.0', ?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
            JSON.stringify(settings),
            now,
          );
          return settings;
        },
        event: {
          idempotencyKey: `settings-skills:${createUlid()}`,
          type: "settings.skills_updated",
          payload: { ...settings },
        },
        outbox: [{ provider: "websocket" }],
      });
      return settings;
    });
  }

  public recordRead(agentRunId: string, names: readonly string[]): Promise<void> {
    const uniqueNames = [...new Set(names)].filter(validateSkillName);
    if (uniqueNames.length === 0) return Promise.resolve();
    return this.enqueue(() => this.writeLane.transact((transaction: CoreWriteLaneTransaction) => {
      const run = transaction.get<{ work_id: string; role: string; project_id: string | null }>(
        `SELECT agent_runs.work_id, agent_runs.role, works.project_id
           FROM agent_runs JOIN works ON works.id = agent_runs.work_id
          WHERE agent_runs.id = ?`,
        agentRunId,
      );
      if (!run) return;
      const now = this.now();
      for (const name of uniqueNames) {
        const skill = transaction.get<{ current_revision: number }>(
          "SELECT current_revision FROM skills WHERE name = ?",
          name,
        );
        if (!skill) continue;
        const existing = transaction.get<{ read_detected: number; verdict: string | null }>(
          "SELECT read_detected, verdict FROM skill_usages WHERE agent_run_id = ? AND skill_name = ?",
          agentRunId,
          name,
        );
        transaction.run(
          `INSERT INTO skill_usages
             (agent_run_id, skill_name, work_id, project_id, role, revision, read_detected, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(agent_run_id, skill_name) DO UPDATE SET
             read_detected = 1,
             updated_at = excluded.updated_at`,
          agentRunId,
          name,
          run.work_id,
          run.project_id,
          run.role,
          skill.current_revision,
          now,
          now,
        );
        const newUsage = existing === undefined || (existing.read_detected !== 1 && existing.verdict === null);
        transaction.run(
          "UPDATE skills SET use_count = use_count + ?, last_used_at = ?, updated_at = ? WHERE name = ?",
          newUsage ? 1 : 0,
          now,
          now,
          name,
        );
      }
    }));
  }

  public async recordFeedback(agentRunId: string, feedback: SkillFeedback | null): Promise<void> {
    if (!feedback) return;
    const result = await this.enqueue(() => this.writeLane.transact((transaction: CoreWriteLaneTransaction) => {
      const run = transaction.get<{ work_id: string; role: string; project_id: string | null }>(
        `SELECT agent_runs.work_id, agent_runs.role, works.project_id
           FROM agent_runs JOIN works ON works.id = agent_runs.work_id
          WHERE agent_runs.id = ?`,
        agentRunId,
      );
      if (!run) return { insertedProposals: 0, recordedFeedback: 0 };

      const now = this.now();
      let recordedFeedback = 0;
      let ignoredNames = feedback.skills_used.filter((entry) => entry && typeof entry.name === "string" && !validateSkillName(entry.name)).length;
      const usageByName = new Map<string, SkillFeedback["skills_used"][number]>();
      for (const entry of feedback.skills_used) {
        if (!entry || !validateSkillName(entry.name) || !["helpful", "misleading", "irrelevant"].includes(entry.verdict) || typeof entry.note !== "string") continue;
        if (!usageByName.has(entry.name)) usageByName.set(entry.name, entry);
      }
      for (const [name, entry] of usageByName) {
        const skill = transaction.get<{ current_revision: number }>("SELECT current_revision FROM skills WHERE name = ?", name);
        if (!skill) {
          ignoredNames += 1;
          continue;
        }
        const existing = transaction.get<{ read_detected: number; verdict: string | null }>(
          "SELECT read_detected, verdict FROM skill_usages WHERE agent_run_id = ? AND skill_name = ?",
          agentRunId,
          name,
        );
        transaction.run(
          `INSERT INTO skill_usages
             (agent_run_id, skill_name, work_id, project_id, role, revision, read_detected, verdict, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
           ON CONFLICT(agent_run_id, skill_name) DO UPDATE SET
             verdict = excluded.verdict,
             note = excluded.note,
             updated_at = excluded.updated_at`,
          agentRunId,
          name,
          run.work_id,
          run.project_id,
          run.role,
          skill.current_revision,
          entry.verdict,
          entry.note,
          now,
          now,
        );
        recordedFeedback += 1;
        const newUsage = existing === undefined || (existing.read_detected !== 1 && existing.verdict === null);
        transaction.run(
          "UPDATE skills SET use_count = use_count + ?, last_used_at = ?, updated_at = ? WHERE name = ?",
          newUsage ? 1 : 0,
          now,
          now,
          name,
        );
      }
      if (ignoredNames > 0) this.logger.warn(`[skill-box] Ignored ${ignoredNames} feedback entries for unknown skills from Agent run ${agentRunId}.`);

      const { inserted } = this.insertProposalRows(transaction, agentRunId, run.work_id, run.project_id, feedback.skill_proposals);
      return { insertedProposals: inserted, recordedFeedback };
    }));
    await this.notifyProposalsInserted(result.insertedProposals);
    if (result.recordedFeedback > 0 && this.onFeedbackRecorded) {
      try {
        await this.onFeedbackRecorded();
      } catch (error) {
        this.logger.warn?.(`[skill-box] Could not evaluate skill feedback: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Records a state change. The Curator passes `rollback` when it archives a
   * skill because its trial failed, so that revision can be told apart from
   * ordinary lifecycle changes.
   */
  public async setState(
    name: string,
    state: SkillState,
    actor: SkillActor,
    reason: string,
    action: "state_change" | "rollback" = "state_change",
  ): Promise<void> {
    await this.enqueue(async () => {
      this.assertName(name);
      if (!["active", "stale", "archived"].includes(state)) throw new Error("invalid_skill_state");
      const current = this.getSkill(name);
      if (!current) throw new Error("skill_not_found");
      const revisionId = createUlid();
      const now = this.now();
      const revision = this.nextRevisionNumber(name);
      await this.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) => {
          transaction.run(
            "UPDATE skills SET state = ?, state_changed_at = ?, updated_at = ? WHERE name = ?",
            state,
            now,
            now,
            name,
          );
          transaction.run(
            `INSERT INTO skill_revisions
               (id, skill_name, revision, actor, action, snapshot_json, content_hash, reason, created_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
            revisionId,
            name,
            revision,
            actor,
            action,
            current.content_hash,
            reason,
            now,
          );
          return { name, revision, state };
        },
        event: {
          idempotencyKey: `skill-state:${name}:${revisionId}`,
          type: "skill.revised",
          payload: { name, revision, current_revision: current.current_revision, action, state, trial: current.trial === 1 },
        },
        outbox: [{ provider: "websocket" }],
      });
    });
  }

  public async setScope(name: string, scope: string, actor: SkillActor, reason: string): Promise<void> {
    await this.enqueue(async () => {
      this.assertName(name);
      if (!isValidSkillScope(scope)) throw new Error("invalid_skill_scope");
      const current = this.getSkill(name);
      if (!current) throw new Error("skill_not_found");
      const directory = join(this.skillsRoot, name);
      await this.assertNoSymlink(directory);
      const files = await this.loadFiles(directory);
      const parsed = parseSkillMd(files["SKILL.md"] ?? "");
      if ("error" in parsed || parsed.name !== name) throw new Error("skill_metadata_invalid");
      const provenance = this.db.get<Pick<SkillRevisionRow, "source_proposal_id" | "source_work_id" | "source_agent_run_id">>(
        "SELECT source_proposal_id, source_work_id, source_agent_run_id FROM skill_revisions WHERE skill_name = ? AND revision = ?",
        name,
        current.current_revision,
      );
      files["SKILL.md"] = renderSkillMd({ name, description: parsed.description, tags: parsed.tags, scope }, parsed.body);
      await this.applyRevisionNow({
        name,
        files,
        meta: { description: parsed.description, tags: parsed.tags, scope },
        actor,
        action: "scope_change",
        reason,
        trial: current.trial === 1,
        ...(provenance?.source_proposal_id ? { source_proposal_id: provenance.source_proposal_id } : {}),
        ...(provenance?.source_work_id ? { source_work_id: provenance.source_work_id } : {}),
        ...(provenance?.source_agent_run_id ? { source_agent_run_id: provenance.source_agent_run_id } : {}),
      });
    });
  }

  public setTrial(name: string, trial: boolean): Promise<void> {
    return this.enqueue(async () => {
      this.assertName(name);
      if (typeof trial !== "boolean") throw new Error("invalid_skill_trial");
      if (!this.getSkill(name)) throw new Error("skill_not_found");
      await this.writeLane.transact((transaction: CoreWriteLaneTransaction) => {
        transaction.run("UPDATE skills SET trial = ?, updated_at = ? WHERE name = ?", trial ? 1 : 0, this.now(), name);
      });
    });
  }

  public restore(name: string, revisionId: string, actor: SkillActor): Promise<{ revision_id: string; revision: number }> {
    return this.enqueue(async () => {
      this.assertName(name);
      const revision = this.getRevision(revisionId);
      if (!revision || revision.skill_name !== name || revision.snapshot_json === null) throw new Error("skill_revision_not_found");
      const files = parseSnapshot(revision.snapshot_json);
      const parsed = parseSkillMd(files["SKILL.md"] ?? "");
      if ("error" in parsed || parsed.name !== name) throw new Error("skill_revision_invalid");
      return this.applyRevisionNow({
        name,
        files,
        meta: { description: parsed.description, tags: parsed.tags, scope: parsed.scope },
        actor,
        action: "restore",
        reason: `Restored revision ${revision.revision}.`,
        trial: false,
        ...(revision.source_proposal_id ? { source_proposal_id: revision.source_proposal_id } : {}),
        ...(revision.source_work_id ? { source_work_id: revision.source_work_id } : {}),
        ...(revision.source_agent_run_id ? { source_agent_run_id: revision.source_agent_run_id } : {}),
      }, "active");
    });
  }

  public async readFile(name: string, path: string): Promise<string> {
    this.assertName(name);
    this.assertFilePath(path);
    const absolutePath = join(this.skillsRoot, name, ...path.split("/"));
    await this.assertNoSymlink(absolutePath);
    const contents = await readFile(absolutePath);
    return decodeText(contents);
  }

  public getSkill(name: string): SkillRecord | undefined {
    const row = this.db.get<SkillDbRow>("SELECT * FROM skills WHERE name = ?", name);
    if (!row) return undefined;
    let tags: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.tags_json);
      if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === "string");
    } catch {}
    return { ...row, tags };
  }

  public listSkills(filter: {
    readonly project_id?: string | null;
    readonly scope?: string;
    readonly state?: SkillState;
    readonly trial?: boolean;
    readonly query?: string;
    readonly include_broken?: boolean;
  } = {}): SkillRecord[] {
    const clauses: string[] = [];
    const values: Array<string | number | null> = [];
    if (filter.project_id !== undefined) {
      clauses.push("(scope = 'global' OR project_id = ?)");
      values.push(filter.project_id);
    }
    if (filter.scope !== undefined) {
      clauses.push("scope = ?");
      values.push(filter.scope);
    }
    if (filter.state !== undefined) {
      clauses.push("state = ?");
      values.push(filter.state);
    }
    if (filter.trial !== undefined) {
      clauses.push("trial = ?");
      values.push(filter.trial ? 1 : 0);
    }
    if (!filter.include_broken) clauses.push("broken_reason IS NULL");
    if (filter.query) {
      clauses.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\')");
      const query = `%${filter.query.replace(/[\\%_]/gu, "\\$&")}%`;
      values.push(query, query, query);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.all<SkillDbRow>(`SELECT * FROM skills ${where} ORDER BY updated_at DESC, name ASC`, ...values).map((row) => ({
      ...row,
      tags: safeParseTags(row.tags_json),
    }));
  }

  public listRevisions(name: string): Array<SkillRevisionRow & { source_work_title: string | null }> {
    this.assertName(name);
    return this.db.all<SkillRevisionRow & { source_work_title: string | null }>(
      `SELECT r.*, w.title AS source_work_title
         FROM skill_revisions r LEFT JOIN works w ON w.id = r.source_work_id
        WHERE r.skill_name = ? ORDER BY r.revision DESC, r.created_at DESC`,
      name,
    );
  }

  public getRevision(id: string): SkillRevisionRow | undefined {
    return this.db.get<SkillRevisionRow>("SELECT * FROM skill_revisions WHERE id = ?", id);
  }

  public renderIndex(projectId: string | null, limits: SkillIndexLimits = {}): string | null {
    const settings = this.readIndexSettings();
    const maxItems = positiveLimit(limits.max_items ?? settings.index_max_items ?? settings.max_items, 30);
    const maxCharacters = positiveLimit(limits.max_characters ?? settings.index_max_chars ?? settings.max_characters, 6000);
    if (maxItems === 0 || maxCharacters === 0) return null;
    const projectScope = projectId === null ? "" : `project:${projectId}`;
    const since = new Date(Date.parse(this.now()) - 90 * 24 * 60 * 60 * 1000).toISOString();
    const skills = this.db.all<SkillDbRow & { recent_use_count: number }>(
      `SELECT s.*,
              (SELECT COUNT(*) FROM skill_usages u
                WHERE u.skill_name = s.name AND u.created_at >= ?) AS recent_use_count
         FROM skills s
        WHERE s.state IN ('active', 'stale')
          AND s.broken_reason IS NULL
          AND (s.scope = 'global' OR s.scope = ?)
        ORDER BY CASE WHEN s.scope = ? AND ? <> '' THEN 0 ELSE 1 END ASC,
                 CASE WHEN s.state = 'active' THEN 0 ELSE 1 END ASC,
                 recent_use_count DESC,
                 s.updated_at DESC,
                 s.name ASC
        LIMIT ?`,
      since,
      projectScope,
      projectScope,
      projectScope,
      maxItems,
    );
    const lines: string[] = [];
    let characters = 0;
    for (const skill of skills) {
      const trial = skill.trial === 1 ? " [trial]" : "";
      const line = `- ${skill.name}: ${skill.description}${trial} → ${join(this.skillsRoot, skill.name, "SKILL.md")}`;
      const cost = line.length + (lines.length > 0 ? 1 : 0);
      if (characters + cost > maxCharacters) break;
      lines.push(line);
      characters += cost;
    }
    return lines.length === 0 ? null : lines.join("\n");
  }

  public reconcileFiles(): Promise<void> {
    return this.enqueue(() => this.reconcileFilesNow());
  }

  private async reconcileFilesNow(): Promise<void> {
    await this.ensureSkillsRoot();
    const known = this.db.all<SkillDbRow>("SELECT * FROM skills ORDER BY name ASC");
    const knownNames = new Set(known.map((skill) => skill.name));
    for (const skill of known) {
      try {
        const skillDirectory = join(this.skillsRoot, skill.name);
        await this.assertNoSymlink(skillDirectory);
        const files = await this.loadFiles(skillDirectory);
        const actualHash = hashSkillFiles(files);
        const parsed = parseSkillMd(files["SKILL.md"] ?? "");
        if ("error" in parsed || parsed.name !== skill.name) {
          const reason = "SKILL.md frontmatter is invalid or its name does not match the directory.";
          if (actualHash !== skill.content_hash) await this.recordBrokenContent(skill, files, actualHash, reason);
          else await this.setBrokenReason(skill.name, reason);
          continue;
        }
        if (actualHash === skill.content_hash) {
          if (skill.broken_reason !== null) await this.setBrokenReason(skill.name, null);
          continue;
        }
        await this.applyRevisionNow({
          name: skill.name,
          files,
          meta: { description: parsed.description, tags: parsed.tags, scope: parsed.scope },
          actor: "user",
          action: "external_edit",
          reason: "Files were edited outside Owl.",
          trial: skill.trial === 1,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn?.(`[owl-core] Could not reconcile skill ${skill.name}: ${reason}`);
        await this.setBrokenReason(skill.name, reason);
      }
    }

    const entries = await readdir(this.skillsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".tmp" || knownNames.has(entry.name) || !validateSkillName(entry.name) || !entry.isDirectory()) continue;
      try {
        const directory = join(this.skillsRoot, entry.name);
        await this.assertNoSymlink(directory);
        const files = await this.loadFiles(directory);
        const parsed = parseSkillMd(files["SKILL.md"] ?? "");
        if ("error" in parsed || parsed.name !== entry.name) continue;
        await this.applyRevisionNow({
          name: entry.name,
          files,
          meta: { description: parsed.description, tags: parsed.tags, scope: parsed.scope },
          actor: "user",
          action: "create",
          reason: "Skill files were added outside Owl.",
          trial: false,
        });
      } catch (error) {
        this.logger.warn?.(`[owl-core] Could not import skill ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async applyRevisionNow(input: ApplyRevisionInput, stateOverride?: SkillState): Promise<{ revision_id: string; revision: number }> {
    this.assertName(input.name);
    if (input.actor !== "curator" && input.actor !== "user") throw new Error("invalid_skill_actor");
    if (!isSkillAction(input.action)) throw new Error("invalid_skill_action");
    if (typeof input.trial !== "boolean") throw new Error("invalid_skill_trial");
    if (!input.meta || typeof input.meta.description !== "string" || !Array.isArray(input.meta.tags) || typeof input.meta.scope !== "string") {
      throw new Error("invalid_skill_metadata");
    }
    const files = validateFiles(input.name, input.files, input.meta);
    const contentHash = hashSkillFiles(files);
    const existing = this.getSkill(input.name);
    const revision = this.nextRevisionNumber(input.name);
    const revisionId = createUlid();
    const now = this.now();
    await this.writeFiles(input.name, files);

    const state = stateOverride ?? existing?.state ?? "active";
    const stateChangedAt = !existing || (stateOverride !== undefined && stateOverride !== existing.state)
      ? now
      : existing.state_changed_at;
    const projectId = input.meta.scope.startsWith("project:") ? input.meta.scope.slice("project:".length) : null;
    await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        transaction.run(
          `INSERT INTO skills
             (name, description, tags_json, scope, project_id, state, trial, content_hash, current_revision,
              use_count, last_used_at, state_changed_at, created_at, updated_at, broken_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, NULL)
           ON CONFLICT(name) DO UPDATE SET
             description = excluded.description,
             tags_json = excluded.tags_json,
             scope = excluded.scope,
             project_id = excluded.project_id,
             state = excluded.state,
             trial = excluded.trial,
             content_hash = excluded.content_hash,
             current_revision = excluded.current_revision,
             state_changed_at = excluded.state_changed_at,
             updated_at = excluded.updated_at,
             broken_reason = NULL`,
          input.name,
          input.meta.description,
          JSON.stringify(input.meta.tags),
          input.meta.scope,
          projectId,
          state,
          input.trial ? 1 : 0,
          contentHash,
          revision,
          stateChangedAt,
          existing?.created_at ?? now,
          now,
        );
        transaction.run(
          `INSERT INTO skill_revisions
             (id, skill_name, revision, actor, action, snapshot_json, content_hash,
              source_proposal_id, source_work_id, source_agent_run_id, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          revisionId,
          input.name,
          revision,
          input.actor,
          input.action,
          JSON.stringify(files),
          contentHash,
          input.source_proposal_id ?? null,
          input.source_work_id ?? null,
          input.source_agent_run_id ?? null,
          input.reason,
          now,
        );
        return { name: input.name, revision, action: input.action, state, trial: input.trial };
      },
      event: {
        idempotencyKey: `skill-revision:${input.name}:${revisionId}`,
        type: "skill.revised",
        payload: { name: input.name, revision, current_revision: revision, action: input.action, state, trial: input.trial },
      },
      outbox: [{ provider: "websocket" }],
    });
    return { revision_id: revisionId, revision };
  }

  private async writeFiles(name: string, files: Record<string, string>): Promise<void> {
    await this.ensureSkillsRoot();
    const tempRoot = join(this.skillsRoot, ".tmp");
    await this.ensureDirectoryWithoutSymlink(tempRoot);
    const staging = join(tempRoot, createUlid());
    await mkdir(staging, { recursive: true });
    const skillDirectory = join(this.skillsRoot, name);
    try {
      for (const [path, content] of Object.entries(files)) {
        const stagedPath = join(staging, ...path.split("/"));
        await mkdir(dirname(stagedPath), { recursive: true });
        await writeFile(stagedPath, content, { encoding: "utf8", flag: "wx" });
      }

      await this.ensureDirectoryWithoutSymlink(skillDirectory);
      for (const path of Object.keys(files).sort()) {
        const destination = join(skillDirectory, ...path.split("/"));
        await this.ensureDirectoryWithoutSymlink(dirname(destination));
        await this.assertNoSymlink(destination);
        const current = await lstatOrNull(destination);
        if (current?.isDirectory()) throw new Error("skill_file_target_is_directory");
        await rename(join(staging, ...path.split("/")), destination);
      }

      const retained = new Set(Object.keys(files));
      for (const { path } of await collectFiles(skillDirectory)) {
        if (retained.has(path)) continue;
        const target = join(skillDirectory, ...path.split("/"));
        await this.assertNoSymlink(target);
        await unlink(target);
      }
      await removeEmptyDirectories(skillDirectory);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async loadFiles(skillDirectory: string): Promise<Record<string, string>> {
    const entries = await collectFiles(skillDirectory);
    const files: Record<string, string> = {};
    let totalBytes = 0;
    for (const entry of entries) {
      if (entry.path.split("/").pop() === ".DS_Store") continue;
      this.assertFilePath(entry.path);
      const content = decodeText(await readFile(join(skillDirectory, ...entry.path.split("/"))));
      totalBytes += Buffer.byteLength(content, "utf8");
      if (totalBytes > SKILL_SIZE_LIMIT) throw new Error("skill_size_exceeds_256KB");
      files[entry.path] = content;
    }
    return files;
  }

  private async recordBrokenContent(skill: SkillDbRow, files: Record<string, string>, contentHash: string, reason: string): Promise<void> {
    const revisionId = createUlid();
    const revision = this.nextRevisionNumber(skill.name);
    const now = this.now();
    await this.writeLane.write({
      mutateState: (transaction: CoreWriteLaneTransaction) => {
        transaction.run(
          "UPDATE skills SET content_hash = ?, current_revision = ?, broken_reason = ?, updated_at = ? WHERE name = ?",
          contentHash,
          revision,
          reason,
          now,
          skill.name,
        );
        transaction.run(
          `INSERT INTO skill_revisions (id, skill_name, revision, actor, action, snapshot_json, content_hash, reason, created_at)
           VALUES (?, ?, ?, 'user', 'external_edit', ?, ?, ?, ?)`,
          revisionId,
          skill.name,
          revision,
          JSON.stringify(files),
          contentHash,
          reason,
          now,
        );
        return { name: skill.name, revision, action: "external_edit", state: skill.state, trial: skill.trial === 1 };
      },
      event: {
        idempotencyKey: `skill-external-edit:${skill.name}:${revisionId}`,
        type: "skill.revised",
        payload: { name: skill.name, revision, current_revision: revision, action: "external_edit", state: skill.state, trial: skill.trial === 1 },
      },
      outbox: [{ provider: "websocket" }],
    });
  }

  private async setBrokenReason(name: string, reason: string | null): Promise<void> {
    await this.writeLane.transact((transaction: CoreWriteLaneTransaction) => {
      transaction.run("UPDATE skills SET broken_reason = ?, updated_at = ? WHERE name = ?", reason, this.now(), name);
    });
  }

  private async ensureSkillsRoot(): Promise<void> {
    await this.ensureDirectoryWithoutSymlink(this.skillsRoot);
  }

  private async ensureDirectoryWithoutSymlink(path: string): Promise<void> {
    const current = await lstatOrNull(path);
    if (current?.isSymbolicLink()) throw new Error("skill_path_contains_symbolic_link");
    if (current && !current.isDirectory()) throw new Error("skill_path_is_not_directory");
    if (!current) await mkdir(path, { recursive: true });
    await this.assertNoSymlink(path);
  }

  private async assertNoSymlink(path: string): Promise<void> {
    const relativePath = relative(this.skillsRoot, path);
    if (relativePath.startsWith("..") || relativePath === "..") throw new Error("skill_path_outside_root");
    const segments = relativePath === "" ? [] : relativePath.split(/[\\/]/u);
    let current = this.skillsRoot;
    const rootStat = await lstatOrNull(current);
    if (rootStat?.isSymbolicLink()) throw new Error("skill_path_contains_symbolic_link");
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      const stat = await lstatOrNull(current);
      if (!stat) return;
      if (stat.isSymbolicLink()) throw new Error("skill_path_contains_symbolic_link");
      if (index < segments.length - 1 && !stat.isDirectory()) throw new Error("skill_path_parent_is_not_directory");
    }
  }

  private nextRevisionNumber(name: string): number {
    const row = this.db.get<{ maximum: number | null }>("SELECT MAX(revision) AS maximum FROM skill_revisions WHERE skill_name = ?", name);
    const current = this.db.get<{ current_revision: number }>("SELECT current_revision FROM skills WHERE name = ?", name)?.current_revision ?? 0;
    return Math.max(row?.maximum ?? 0, current) + 1;
  }

  private readIndexSettings(): Record<string, unknown> {
    const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'skills'");
    if (!row) return {};
    try {
      const parsed: unknown = JSON.parse(row.value_json);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  private assertName(name: string): void {
    if (!validateSkillName(name)) throw new Error("invalid_skill_name");
  }

  private assertFilePath(path: string): void {
    const result = validateSkillFilePath(path);
    if (!result.ok) throw new Error(result.reason);
  }
}

function validateFiles(name: string, inputFiles: Record<string, string>, meta: Omit<SkillMetadata, "name">): Record<string, string> {
  if (!inputFiles || typeof inputFiles !== "object" || Array.isArray(inputFiles)) throw new Error("invalid_skill_files");
  if (!isValidSkillScope(meta.scope) || meta.description.length === 0 || meta.description.length > 300 || /[\r\n\u0000-\u001f\u007f]/u.test(meta.description)) {
    throw new Error("invalid_skill_metadata");
  }
  if (meta.tags.some((tag) => typeof tag !== "string" || tag.length === 0 || /[\r\n\u0000-\u001f\u007f]/u.test(tag))) {
    throw new Error("invalid_skill_metadata");
  }
  const files: Record<string, string> = {};
  let totalBytes = 0;
  for (const [path, content] of Object.entries(inputFiles)) {
    const validPath = validateSkillFilePath(path);
    if (!validPath.ok) throw new Error(validPath.reason);
    if (typeof content !== "string" || content.includes("\0")) throw new Error("Skill files must be valid text without NUL characters.");
    if (Buffer.from(content, "utf8").toString("utf8") !== content) throw new Error("Skill files must be valid UTF-8 text.");
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > SKILL_SIZE_LIMIT) throw new Error("Skill exceeds the 256KB limit.");
    files[path] = content;
  }
  const parsed = parseSkillMd(files["SKILL.md"] ?? "");
  if ("error" in parsed) throw new Error(`invalid_skill_md: ${parsed.error}`);
  if (parsed.name !== name || parsed.description !== meta.description || parsed.scope !== meta.scope || JSON.stringify(parsed.tags) !== JSON.stringify(meta.tags)) {
    throw new Error("SKILL.md metadata does not match the supplied skill metadata.");
  }
  return files;
}

function isSkillAction(value: string): value is SkillAction {
  return ["create", "update", "merge", "state_change", "scope_change", "restore", "rollback", "external_edit"].includes(value);
}

function positiveLimit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function safeParseTags(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parseJsonOrNull(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function contentFiles(filesValue: unknown, skillValue: unknown): Record<string, string> | null {
  if (filesValue && typeof filesValue === "object" && !Array.isArray(filesValue)) {
    const entries = Object.entries(filesValue as Record<string, unknown>);
    if (entries.every(([, content]) => typeof content === "string")) {
      return Object.fromEntries(entries) as Record<string, string>;
    }
  }
  if (skillValue && typeof skillValue === "object" && !Array.isArray(skillValue)) {
    const files = (skillValue as Record<string, unknown>).files;
    if (Array.isArray(files)) {
      const result: Record<string, string> = {};
      for (const file of files) {
        if (!file || typeof file !== "object" || Array.isArray(file)) return null;
        const entry = file as Record<string, unknown>;
        if (typeof entry.path !== "string" || typeof entry.content !== "string") return null;
        result[entry.path] = entry.content;
      }
      return result;
    }
  }
  return null;
}

function stringValues(record: Readonly<Record<string, unknown>>, keys: readonly string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") values.push(item);
    }
  }
  return values;
}

function parseSnapshot(value: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("skill_revision_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("skill_revision_invalid");
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(parsed)) {
    if (typeof content !== "string") throw new Error("skill_revision_invalid");
    files[path] = content;
  }
  return files;
}

async function collectFiles(root: string, parent = ""): Promise<ExistingFile[]> {
  const entries = await readdir(join(root, parent), { withFileTypes: true });
  const files: ExistingFile[] = [];
  for (const entry of entries) {
    const path = parent ? `${parent}/${entry.name}` : entry.name;
    const absolutePath = join(root, ...path.split("/"));
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) throw new Error("skill_path_contains_symbolic_link");
    if (stat.isDirectory()) files.push(...await collectFiles(root, path));
    else if (stat.isFile()) files.push({ path, content: "" });
    else throw new Error("skill_path_is_not_regular_file");
  }
  return files;
}

async function removeEmptyDirectories(root: string, parent = ""): Promise<void> {
  const absolute = join(root, parent);
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = parent ? `${parent}/${entry.name}` : entry.name;
    await removeEmptyDirectories(root, child);
    const childAbsolute = join(root, ...child.split("/"));
    if ((await readdir(childAbsolute)).length === 0) await rmdir(childAbsolute);
  }
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function decodeText(buffer: Buffer): string {
  const text = buffer.toString("utf8");
  if (text.includes("\0") || Buffer.from(text, "utf8").compare(buffer) !== 0) throw new Error("Skill files must be valid UTF-8 text without NUL characters.");
  return text;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
